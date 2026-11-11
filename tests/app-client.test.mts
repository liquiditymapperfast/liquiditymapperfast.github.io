import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { decodeColumns, decodeLevels, frameType } from '../src/app/wire.ts';
import { encodeColumns, encodeLevels } from '../src/server/v2/wire.mts';
import { frameOf } from '../src/app/browser/levels-frame.ts';
import { DepthRecorder, accumulateSide, COLUMN_MS } from '../src/server/v2/recorder.mts';
import { View, niceStep } from '../src/app/view.ts';
import { mergeLive } from '../src/app/hub.ts';
import { KERNEL_FROM, mergeByDistance, useMergeKernel } from '../src/shared/merge.ts';
import { cumulative, groupLevels } from '../src/app/panes/levels-data.ts';
import { timeTicks } from '../src/app/panes/heat-pane.ts';
import { aggregateCandles } from '../src/server/v2/series.mts';
import type { Kernels } from '../src/app/kernels.ts';
import type { ValuedBook } from '../src/server/v2/levels.mts';

interface Glue { default(options: { module_or_path: Uint8Array }): Promise<unknown>; spread_levels: (...a: unknown[]) => Float32Array; raster_columns: (...a: unknown[]) => Float32Array; blur_rows: (data: Float32Array, w: number, h: number, sigma: number) => Float32Array; merge_by_distance: (lo: Float64Array, usd: Float64Array, mid: number, step: number, isBid: boolean) => Float64Array }
/** Load the committed wasm build exactly as shipped, from the repository root regardless of where tests are emitted. */
async function loadWasm(): Promise<Kernels> {
  const root = path.resolve(import.meta.dirname, '..', '..', '..');
  const glue = await import(pathToFileURL(path.join(root, 'src', 'app', 'wasm', 'hlm_kernels.js')).href) as Glue;
  await glue.default({ module_or_path: fs.readFileSync(path.join(root, 'src', 'app', 'wasm', 'hlm_kernels_bg.wasm')) });
  return {
    spreadLevels: (lo, hi, usd, inst, nInst, step, bin0, nBins) => glue.spread_levels(lo, hi, usd, inst, nInst, step, bin0, nBins),
    blurRows: (data, w, h, sigma) => glue.blur_rows(data, w, h, sigma),
    rasterColumns: a => glue.raster_columns(a.steps, a.colInst, a.colTime, a.colCount, a.bins, a.bid, a.ask, a.stepMs, a.t0, a.t1, a.p0, a.p1, a.w, a.h, a.sigma),
    mergeByDistance: (lo, usd, mid, step, isBid) => glue.merge_by_distance(lo, usd, mid, step, isBid),
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

/** A levels frame's JSON header, parsed. */
const headerOf = (frame: Buffer): { instruments: Record<string, unknown>[] } => JSON.parse(frame.subarray(4, 4 + frame.readUInt32LE(0)).toString());
/** The frame with its JSON header text rewritten (a malformed field no server of ours sends), the parts after it as they were. */
function withHeader(frame: Buffer, edit: (text: string) => string): Buffer {
  const length = frame.readUInt32LE(0), oldEnd = (4 + length + 7) & ~7;
  const json = Buffer.from(edit(frame.subarray(4, 4 + length).toString()));
  const end = (4 + json.length + 7) & ~7, out = Buffer.alloc(end + frame.length - oldEnd);
  out.writeUInt32LE(json.length, 0); json.copy(out, 4); frame.copy(out, end, oldEnd);
  return out;
}

test('levels frames carry the step a book was merged on, and a page takes only a usable one', () => {
  const merged: ValuedBook = { instrumentId: 'x:BTC', venue: 'x', timestamp: T0, coarse: false, bids: side([[100, 100, 5]]), asks: side([[101, 101, 7]]), step: 20 };
  const grouped: ValuedBook = { instrumentId: 'y:BTC', venue: 'y', timestamp: T0, coarse: true, bids: side([[90, 100, 6]]), asks: side([[100, 110, 8]]) };
  const wire = encodeLevels([merged, grouped], T0);
  const header = headerOf(wire);
  assert.equal(header.instruments[0]!.step, 20, 'the header names the step, beside the book\'s other fields');
  assert.ok(!('step' in header.instruments[1]!), 'a book with none says none');
  const levels = decodeLevels(exactBuffer(wire));
  assert.deepEqual(levels.books.map(b => b.step), [20, undefined]);
  assert.ok(!('step' in levels.books[1]!), 'and the page\'s book has no such key');
  assert.deepEqual([...levels.books[0]!.bids.usd, ...levels.books[0]!.asks.usd, ...levels.books[1]!.bids.usd], [5, 7, 6], 'the arrays are read as before');
  // The server leaves a step that is not a usable number off the frame (JSON would write NaN and Infinity as null) ...
  for (const unusable of [NaN, Infinity, -Infinity, 0, -20]) {
    const sent = headerOf(encodeLevels([{ ...merged, step: unusable }], T0));
    assert.ok(!('step' in sent.instruments[0]!), `step ${unusable} is not sent`);
  }
  // ... and the page leaves one out that it is given: a frame from an older server has none, a malformed one is dropped, not thrown on.
  for (const literal of ['null', '0', '-20', '"20"', '1e999', '-1e999', 'true', '[20]', '{}']) {
    const bad = decodeLevels(exactBuffer(withHeader(wire, text => text.replace('"step":20', `"step":${literal}`))));
    assert.equal(bad.books[0]!.step, undefined, `step ${literal}`);
    assert.ok(!('step' in bad.books[0]!));
    assert.equal(bad.books[0]!.bids.usd[0], 5, 'and the book is read as before');
  }
  const older = decodeLevels(exactBuffer(withHeader(wire, text => text.replace(',"step":20', ''))));
  assert.equal(older.books[0]!.step, undefined, 'an older server\'s frame has no step at all');
});

test('levels frames carry the coverage epoch of a book that has one, from the server and from the feeds worker alike', () => {
  const full: ValuedBook = { instrumentId: 'bybit:BTCUSDT', venue: 'bybit', timestamp: T0, coarse: false, bids: side([[100, 100, 5]]), asks: side([[101, 101, 7]]), step: 20, epoch: 7 };
  const plain: ValuedBook = { ...full, instrumentId: 'okx:BTC-USDT-SWAP', venue: 'okx', epoch: undefined };
  const wire = encodeLevels([full, plain], T0), header = headerOf(wire);
  assert.equal(header.instruments[0]!.epoch, 7); assert.ok(!('epoch' in header.instruments[1]!));
  const levels = decodeLevels(exactBuffer(wire));
  assert.deepEqual(levels.books.map(b => b.epoch), [7, undefined]); assert.ok(!('epoch' in levels.books[1]!));
  assert.deepEqual(frameOf([full, plain], T0).books.map(b => b.epoch), [7, undefined], 'the frame of the feeds worker says the same');
  for (const unusable of [0, -1, 1.5, NaN]) assert.ok(!('epoch' in headerOf(encodeLevels([{ ...full, epoch: unusable }], T0)).instruments[0]!), `epoch ${unusable} is not sent`);
  for (const literal of ['null', '0', '-3', '"7"', '1.5', '1e999']) {
    const bad = decodeLevels(exactBuffer(withHeader(wire, text => text.replace('"epoch":7', `"epoch":${literal}`))));
    assert.ok(!('epoch' in bad.books[0]!), `epoch ${literal} is left out`); assert.equal(bad.books[0]!.step, 20, 'the rest is read as before');
  }
});

test('wasm merge_by_distance equals mergeByDistance to the last bit, on random and real sides, both ways, and is what the merge uses once installed', async () => {
  const kernels = await loadWasm();
  let seed = 4242; const rand = () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32;
  const same = (a: { lo: Float64Array; usd: Float64Array }, b: { lo: Float64Array; usd: Float64Array }, what: string): void => {
    assert.equal(a.lo.length, b.lo.length, `${what}: bucket count`);
    for (let i = 0; i < a.lo.length; i++) { assert.ok(Object.is(a.lo[i], b.lo[i]), `${what}: price ${i}`); assert.ok(Object.is(a.usd[i], b.usd[i]), `${what}: usd ${i}`); }
  };
  const viaKernel = (lo: Float64Array, usd: Float64Array, mid: number, step: number, isBid: boolean) => { const p = kernels.mergeByDistance(lo, usd, mid, step, isBid), m = p.length >> 1; return { lo: p.subarray(0, m), usd: p.subarray(m) }; };
  // Random point sides, nearest first, out past half the mid (dropped), dense near the touch and sparse far, on several grids.
  for (let round = 0; round < 60; round++) {
    const mid = 10 ** (rand() * 6 - 1), step = mid * 0.0002 * (0.5 + rand() * 2), isBid = round % 2 === 0, n = 50 + Math.floor(rand() * 20_000);
    const prices = new Set<number>();
    while (prices.size < n) { const d = mid * 0.7 * rand() ** 3, p = Number((isBid ? mid - d : mid + d).toPrecision(8)); if (p > 0 && (isBid ? p < mid : p > mid)) prices.add(p); }
    const lo = Float64Array.from([...prices].sort((a, b) => isBid ? b - a : a - b)), usd = Float64Array.from(lo, p => p * rand() * 3);
    same(viaKernel(lo, usd, mid, step, isBid), mergeByDistance({ lo, hi: lo, usd }, mid, step, isBid), `round ${round}`);
  }
  // A real book: the recorded Bybit session's snapshot, both sides.
  const session = JSON.parse(fs.readFileSync(path.resolve(import.meta.dirname, '..', '..', '..', 'tests', 'fixtures', 'bybit-full-session.json'), 'utf8')) as { snapshots: { body: string }[] };
  const r = (JSON.parse(session.snapshots[0]!.body) as { result: { b: string[][]; a: string[][] } }).result;
  const mid = (Number(r.b[0]![0]) + Number(r.a[0]![0])) / 2;
  for (const [rows, isBid] of [[r.b, true], [r.a, false]] as const) {
    const lo = Float64Array.from(rows, x => Number(x[0])), usd = Float64Array.from(rows, x => Number(x[0]) * Number(x[1]));
    for (const step of [0.0001, 0.0002, 0.001]) same(viaKernel(lo, usd, mid, step, isBid), mergeByDistance({ lo, hi: lo, usd }, mid, step, isBid), `real ${isBid ? 'bids' : 'asks'} step ${step}`);
  }
  // Installed, the merge hands long point sides to the kernel and gets the same answer; bands and short sides stay in JavaScript.
  const lo = Float64Array.from({ length: KERNEL_FROM + 100 }, (_, i) => 100 + i * 0.01), usd = Float64Array.from(lo, () => 1);
  const plain = mergeByDistance({ lo, hi: lo, usd }, 99.99, 0.02, false);
  let calls = 0;
  useMergeKernel((a, b, c, d, e) => { calls++; return kernels.mergeByDistance(a, b, c, d, e); });
  try {
    same(mergeByDistance({ lo, hi: lo, usd }, 99.99, 0.02, false), plain, 'installed');
    assert.equal(calls, 1);
    mergeByDistance({ lo: lo.subarray(0, 10), hi: lo.subarray(0, 10), usd: usd.subarray(0, 10) }, 99.99, 0.02, false);
    assert.equal(calls, 1, 'a short side stays in JavaScript');
  } finally { useMergeKernel(null); }
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
