import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { decodeColumns, decodeLevels, frameType } from '../src/app/wire.ts';
import { encodeColumns, encodeLevels } from '../src/server/v2/wire.mts';
import { DepthRecorder, accumulateSide, COLUMN_MS } from '../src/server/v2/recorder.mts';
import { View, niceStep } from '../src/app/view.ts';
import { mergeLive } from '../src/app/hub.ts';
import { cumulative, groupLevels } from '../src/app/panes/levels-data.ts';
import { timeTicks } from '../src/app/panes/heat-pane.ts';
import { aggregateCandles } from '../src/server/v2/series.mts';
import type { Kernels } from '../src/app/kernels.ts';
import type { ValuedBook } from '../src/server/v2/levels.mts';

interface Glue { default(options: { module_or_path: Uint8Array }): Promise<unknown>; spread_levels: (...a: unknown[]) => Float32Array; raster_columns: (...a: unknown[]) => Float32Array; blur_rows: (data: Float32Array, w: number, h: number, sigma: number) => Float32Array }
/** Load the committed wasm build exactly as shipped, from the repository root regardless of where tests are emitted. */
async function loadWasm(): Promise<Kernels> {
  const root = path.resolve(import.meta.dirname, '..', '..', '..');
  const glue = await import(pathToFileURL(path.join(root, 'src', 'app', 'wasm', 'hlm_kernels.js')).href) as Glue;
  await glue.default({ module_or_path: fs.readFileSync(path.join(root, 'src', 'app', 'wasm', 'hlm_kernels_bg.wasm')) });
  return {
    spreadLevels: (lo, hi, usd, inst, nInst, step, bin0, nBins) => glue.spread_levels(lo, hi, usd, inst, nInst, step, bin0, nBins),
    blurRows: (data, w, h, sigma) => glue.blur_rows(data, w, h, sigma),
    rasterColumns: a => glue.raster_columns(a.steps, a.colInst, a.colTime, a.colCount, a.bins, a.bid, a.ask, a.stepMs, a.t0, a.t1, a.p0, a.p1, a.w, a.h, a.sigma),
  };
}
const side = (rows: [number, number, number][]) => ({ lo: Float64Array.from(rows.map(r => r[0])), hi: Float64Array.from(rows.map(r => r[1])), usd: Float64Array.from(rows.map(r => r[2])) });
const exactBuffer = (b: Buffer): ArrayBuffer => b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;
const T0 = Math.floor(Date.UTC(2026, 9, 4, 12) / COLUMN_MS) * COLUMN_MS;

test('server frames decode on the client to identical arrays', () => {
  const recorder = new DepthRecorder({ now: () => T0 });
  recorder.steps.set('x:BTC', 10);
  const book: ValuedBook = { instrumentId: 'x:BTC', venue: 'x', timestamp: T0, coarse: true, bids: side([[100, 130, 30]]), asks: side([[140, 140, 7]]) };
  recorder.sample([book], T0);
  const columns = encodeColumns([{ instrumentId: 'x:BTC', step: 10, columns: recorder.query('x:BTC', 0, T0 + COLUMN_MS) }], 0, T0 + COLUMN_MS, COLUMN_MS);
  assert.equal(frameType(exactBuffer(columns)), 'columns');
  const decoded = decodeColumns(exactBuffer(columns));
  assert.equal(decoded.instruments[0]!.id, 'x:BTC');
  assert.deepEqual([...decoded.instruments[0]!.bins], [10, 11, 12, 14]);
  assert.deepEqual([...decoded.instruments[0]!.bid].map(Math.round), [10, 10, 10, 0]);
  assert.deepEqual([...decoded.instruments[0]!.ask], [0, 0, 0, 7]);
  const levels = decodeLevels(exactBuffer(encodeLevels([book], T0)));
  assert.equal(levels.books[0]!.coarse, true);
  assert.deepEqual([...levels.books[0]!.bids.hi], [130]);
  assert.deepEqual([...levels.books[0]!.asks.usd], [7]);
  assert.throws(() => decodeLevels(exactBuffer(columns)), /Expected a levels frame/);
  assert.throws(() => decodeColumns(new ArrayBuffer(3)), RangeError);
});

test('wasm spread_levels agrees with the server recorder on random banded books', async () => {
  const kernels = await loadWasm();
  let seed = 12345; const rand = () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32;
  const rows: [number, number, number][] = [];
  for (let i = 0; i < 300; i++) { const lo = 85_000 + rand() * 600, width = rand() < 0.3 ? 0 : rand() * 120; rows.push([lo, lo + width, rand() * 1e6]); }
  const step = 20, js = new Map<number, number>();
  accumulateSide(side(rows), step, js);
  const bin0 = Math.floor(85_000 / step) - 1, nBins = 60;
  const wasm = kernels.spreadLevels(side(rows).lo, side(rows).hi, side(rows).usd, new Uint32Array(rows.length), 1, step, bin0, nBins);
  for (let i = 0; i < nBins; i++) {
    const expected = js.get(bin0 + i) ?? 0;
    assert.ok(Math.abs(wasm[i]! - expected) <= Math.max(1, expected * 1e-5), `bin ${bin0 + i}: wasm ${wasm[i]} vs js ${expected}`);
  }
});

test('wasm raster_columns draws the recorded USD where and when it was observed', async () => {
  const kernels = await loadWasm();
  const recorder = new DepthRecorder({ now: () => T0 });
  recorder.steps.set('x:BTC', 10);
  recorder.sample([{ instrumentId: 'x:BTC', venue: 'x', timestamp: T0, coarse: false, bids: side([[100, 100, 200]]), asks: side([[130, 130, 50]]) }], T0);
  recorder.sample([{ instrumentId: 'x:BTC', venue: 'x', timestamp: T0 + COLUMN_MS, coarse: false, bids: side([[100, 100, 400]]), asks: side([]) }], T0 + COLUMN_MS);
  const [first, second] = [recorder.query('x:BTC', T0, T0 + COLUMN_MS)[0]!, recorder.query('x:BTC', T0 + COLUMN_MS, T0 + 2 * COLUMN_MS)[0]!];
  const grid = kernels.rasterColumns({ steps: Float64Array.of(10), colInst: Uint32Array.of(0, 0), colTime: Float64Array.of(first.t, second.t),
    colCount: Uint32Array.of(first.bins.length, second.bins.length), bins: Int32Array.from([...first.bins, ...second.bins]),
    bid: Float32Array.from([...first.bid, ...second.bid]), ask: Float32Array.from([...first.ask, ...second.ask]),
    stepMs: COLUMN_MS, t0: T0, t1: T0 + 2 * COLUMN_MS, p0: 100, p1: 140, w: 2, h: 4, sigma: 0 });
  const cell = (x: number, row: number) => [grid[(row * 2 + x) * 2]!, grid[(row * 2 + x) * 2 + 1]!];
  assert.deepEqual(cell(0, 0), [200, 0]); assert.deepEqual(cell(1, 0), [400, 0]);
  assert.deepEqual(cell(0, 3), [0, 50]); assert.deepEqual(cell(1, 3), [0, 0], 'the ask was not observed in the second minute');
  assert.deepEqual(cell(0, 1), [0, 0]);
});

test('groupLevels and cumulative sum across venues and walk away from the mark', async () => {
  const kernels = await loadWasm();
  const frame = { asOf: T0, books: [
    { id: 'a:BTC', venue: 'a', timestamp: T0, coarse: false, bids: side([[99, 99, 10], [85, 85, 30]]), asks: side([[101, 101, 5]]) },
    { id: 'b:BTC', venue: 'b', timestamp: T0, coarse: false, bids: side([[99, 99, 20]]), asks: side([[111, 111, 8]]) },
  ] };
  const grouped = groupLevels(kernels, frame, ['a:BTC', 'b:BTC'], 10, 80, 120);
  const at = (price: number) => Math.floor(price / 10) - grouped.bin0;
  assert.equal(grouped.totalBid[at(99)], 30); assert.equal(grouped.totalBid[at(85)], 30); assert.equal(grouped.totalAsk[at(101)], 5);
  assert.equal(grouped.bid[0]![at(99)], 10); assert.equal(grouped.bid[1]![at(99)], 20);
  const cum = cumulative(grouped, 100);
  assert.equal(cum.bid[at(99)], 30); assert.equal(cum.bid[at(85)], 60); assert.equal(cum.maxBid, 60);
  assert.equal(cum.ask[at(101)], 5); assert.equal(cum.ask[at(111)], 13); assert.equal(cum.maxAsk, 13);
});

test('view conversions invert and zooms keep their anchor fixed', () => {
  const v = new View({ t0: 1_000, t1: 5_000, p0: 100, p1: 200 });
  assert.equal(v.tOf(v.xOf(2_500, 800), 800), 2_500); assert.equal(v.pOf(v.yOf(150, 400), 400), 150);
  const t = v.tOf(200, 800); v.zoomTime(2, 200, 800);
  assert.ok(Math.abs(v.tOf(200, 800) - t) < 1e-9); assert.equal(v.t1 - v.t0, 8_000);
  const p = v.pOf(100, 400); v.zoomPrice(0.5, 100, 400);
  assert.ok(Math.abs(v.pOf(100, 400) - p) < 1e-9); assert.equal(v.p1 - v.p0, 50);
  const before = v.clone(); v.pan(80, 40, 800, 400);
  assert.ok(v.t0 < before.t0 && v.p1 > before.p1, 'dragging right/down reveals earlier time and higher price');
  assert.equal(niceStep(1210, 26), 50); assert.equal(niceStep(0.3, 6), 0.05);
});

test('time ticks are 1-2-5 minute/hour steps at least minPx apart', () => {
  const ticks = timeTicks(0, 3_600_000 * 2, 960, 96);
  assert.ok(ticks.length >= 3 && ticks.length <= 11);
  const gaps = new Set(ticks.slice(1).map((t, i) => t - ticks[i]!));
  assert.equal(gaps.size, 1);
  assert.ok([...gaps][0]! >= 96 / 960 * 3_600_000 * 2);
});

test('live 1m candles fold into the display timeframe without rewinding history', () => {
  const hour = 3_600_000;
  const base: [number, number, number, number, number, number, number][] = [[0, 10, 12, 9, 11, 5, 60], [hour, 11, 13, 10, 12, 7, 12]];
  const merged = mergeLive(base, [hour + 120_000, 12, 15, 12, 14, 9], hour);
  assert.deepEqual(merged[1], [hour, 11, 15, 10, 14, 9, 12]);
  assert.equal(mergeLive(base, [2 * hour + 60_000, 14, 14, 14, 14, 1], hour).length, 3);
  assert.equal(mergeLive(base, [-hour, 1, 1, 1, 1, 1], hour), base, 'a candle older than the series is ignored');
  assert.deepEqual(aggregateCandles([{ start: 0, open: 1, high: 2, low: 1, close: 2 }], hour)[0]!.slice(0, 5), [0, 1, 2, 1, 2]);
});

test('the shipped wasm smooths a raster vertically, conserving mass and leaving an empty raster empty', async () => {
  const kernels = await loadWasm();
  const w = 3, h = 61, data = new Float32Array(w * h * 2);
  data[(30 * w + 1) * 2] = 900;
  const out = kernels.blurRows(data, w, h, 4);
  let sum = 0, off = 0;
  for (let r = 0; r < h; r++) { sum += out[(r * w + 1) * 2]!; off += out[(r * w + 0) * 2]! + out[(r * w + 2) * 2]!; }
  assert.ok(Math.abs(sum - 900) < 1, `mass ${sum}`);
  assert.equal(off, 0, 'neighbouring pixel columns are untouched');
  assert.ok(out[(30 * w + 1) * 2]! < 900 / 6 && out[(24 * w + 1) * 2]! > 0, 'the spike became a smooth bump');
  assert.deepEqual(kernels.blurRows(data, w, h, 0.2), data, 'a negligible sigma is the identity');
  assert.ok(kernels.blurRows(new Float32Array(w * h * 2), w, h, 5).every(v => v === 0));
});

test('smoothing inside the raster kernel equals smoothing its output afterwards, and a smoothed empty raster stays empty', async () => {
  const kernels = await loadWasm();
  const recorder = new DepthRecorder({ now: () => T0 });
  recorder.steps.set('x:BTC', 10);
  for (let m = 0; m < 6; m++) recorder.sample([{ instrumentId: 'x:BTC', venue: 'x', timestamp: T0 + m * COLUMN_MS, coarse: false, bids: side([[100 + 40 * (m % 3), 100 + 40 * (m % 3), 50_000 + m * 1_000], [300, 300, 90_000]]), asks: side([[900, 900, 70_000]]) }], T0 + m * COLUMN_MS);
  const columns = recorder.query('x:BTC', T0, T0 + 6 * COLUMN_MS);
  const args = { steps: Float64Array.of(10), colInst: Uint32Array.from(columns.map(() => 0)), colTime: Float64Array.from(columns.map(c => c.t)), colCount: Uint32Array.from(columns.map(c => c.bins.length)),
    bins: Int32Array.from(columns.flatMap(c => [...c.bins])), bid: Float32Array.from(columns.flatMap(c => [...c.bid])), ask: Float32Array.from(columns.flatMap(c => [...c.ask])),
    stepMs: COLUMN_MS, t0: T0, t1: T0 + 6 * COLUMN_MS, p0: 60, p1: 1000, w: 90, h: 120 };
  const inside = kernels.rasterColumns({ ...args, sigma: 4 }), afterwards = kernels.blurRows(kernels.rasterColumns({ ...args, sigma: 0 }), 90, 120, 4);
  assert.equal(inside.length, afterwards.length);
  let worst = 0, mass = 0;
  for (let i = 0; i < inside.length; i++) { worst = Math.max(worst, Math.abs(inside[i]! - afterwards[i]!) / Math.max(1, afterwards[i]!)); mass += inside[i]!; }
  assert.ok(worst < 2e-3, `worst relative difference ${worst}`);
  assert.ok(mass > 0);
  assert.ok(kernels.rasterColumns({ ...args, colInst: new Uint32Array(0), colTime: new Float64Array(0), colCount: new Uint32Array(0), bins: new Int32Array(0), bid: new Float32Array(0), ask: new Float32Array(0), sigma: 5 }).every(v => v === 0));
});
