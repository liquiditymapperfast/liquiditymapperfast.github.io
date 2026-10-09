import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { groupLevels } from '../src/app/panes/levels-data.ts';
import { PullHistory, binsPerRow, pullBase, pullRows, readPullWindow, snapshot } from '../src/app/panes/pull-stack.ts';
import type { Kernels } from '../src/app/kernels.ts';
import type { LevelsFrame, LiveBook } from '../src/app/wire.ts';

interface Glue { default(options: { module_or_path: Uint8Array }): Promise<unknown>; spread_levels: (...a: unknown[]) => Float32Array; raster_columns: (...a: unknown[]) => Float32Array; blur_rows: (data: Float32Array, w: number, h: number, sigma: number) => Float32Array }
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

type Level = [number, number, number];
const side = (rows: Level[]) => ({ lo: Float64Array.from(rows.map(r => r[0])), hi: Float64Array.from(rows.map(r => r[1])), usd: Float64Array.from(rows.map(r => r[2])) });
const book = (id: string, bids: Level[], asks: Level[]): LiveBook => ({ id, venue: id.split(':')[0]!, timestamp: 0, coarse: false, bids: side(bids), asks: side(asks) });
const frame = (...books: LiveBook[]): LevelsFrame => ({ asOf: 0, books });
const MARK = 82_000, BASE = pullBase(0.1);
/** A book reaching from 81,000 to 83,000 (so the rows tested lie inside it), best bid 81,995 and best ask 82,005, with the given extra levels. */
const wide = (id: string, bids: Level[] = [], asks: Level[] = []): LiveBook =>
  book(id, [[81_995, 81_995, 1_000], ...bids, [81_000, 81_000, 1]], [[82_005, 82_005, 1_000], ...asks, [83_000, 83_000, 1]]);

test('the base grid is five of the finest step, and a row is a whole number of its bins or nothing', () => {
  assert.equal(BASE, 0.5);
  assert.equal(binsPerRow(20, BASE), 40);
  assert.equal(binsPerRow(25, BASE), 50);
  assert.equal(binsPerRow(0.2, BASE), 0, 'finer than the base');
  assert.equal(binsPerRow(0.7, BASE), 0, 'not a multiple');
  assert.deepEqual([readPullWindow(60), readPullWindow(30), readPullWindow('60'), readPullWindow(undefined)], [60, 0, 0, 0]);
});

test('summing the base bins of a snapshot gives what the book groups at the row step, ranged levels included', async () => {
  const kernels = await loadWasm();
  const f = frame(wide('a:BTC', [[81_900.3, 81_900.3, 700], [81_812.4, 81_874.9, 3_000]], [[82_110, 82_110, 900], [82_150.5, 82_219.5, 4_400]]));
  const snap = snapshot(kernels, f, BASE, MARK, 0, 1), v = snap.venues.get('a:BTC')!;
  for (const step of [10, 20, 25, 50]) {
    const k = binsPerRow(step, BASE), bin0 = Math.floor(81_700 / step), n = Math.ceil(600 / step);
    const g = groupLevels(kernels, f, ['a:BTC'], step, bin0 * step, (bin0 + n) * step);
    for (let j = 0; j < n; j++) {
      const b0 = (g.bin0 + j) * k - v.bin0;
      let bid = 0, ask = 0;
      for (let i = b0; i < b0 + k; i++) { bid += v.bid[i]!; ask += v.ask[i]!; }
      assert.ok(Math.abs(bid - g.totalBid[j]!) < 0.05 && Math.abs(ask - g.totalAsk[j]!) < 0.05, `step ${step}, row ${(g.bin0 + j) * step}: ${bid}/${g.totalBid[j]} ${ask}/${g.totalAsk[j]}`);
    }
  }
});

test('a row gains what was stacked and loses what was pulled, a venue counting only where both books reach the whole row', async () => {
  const kernels = await loadWasm();
  const then = snapshot(kernels, frame(wide('a:BTC', [[81_950, 81_950, 100]], [[82_050, 82_050, 500]]), book('b:BTC', [[81_995, 81_995, 50], [81_955, 81_955, 40], [81_945, 81_945, 10]], [[82_005, 82_005, 50]])), BASE, MARK, 0, 1);
  const now = snapshot(kernels, frame(wide('a:BTC', [[81_950, 81_950, 300]], [[82_050, 82_050, 100]]), book('b:BTC', [[81_995, 81_995, 50], [81_955, 81_955, 90], [81_945, 81_945, 10], [81_905, 81_905, 30]], [[82_005, 82_005, 50]])), BASE, MARK, 60_000, 2);
  const step = 10, bin0 = 8_188, n = 30; // rows 81,880 … 82,170
  const rows = pullRows(then, now, [now], ['a:BTC', 'b:BTC'], step, bin0, n)!;
  const at = (price: number) => Math.floor(price / step) - bin0;
  assert.equal(rows.bid[at(81_950)], 250, 'a stacked 200 and b 50 (both books reach the row at both ends)');
  assert.equal(rows.ask[at(82_050)], -400, 'a pulled 400');
  // b's book reached down to 81,945 at first: its new 81,905 bid is beyond where it reached then, so it is not a stack.
  assert.equal(rows.bid[at(81_900)], 0, 'only a counts at 81,900 (no change there)');
  assert.equal(rows.ask[at(82_100)], 0);
  assert.ok(Number.isNaN(pullRows(then, now, [now], ['b:BTC'], step, bin0, n)!.bid[at(81_900)]!), 'b alone: no venue covers the row at both ends');
  assert.equal(pullRows(then, now, [now], ['b:BTC'], step, bin0, n)!.bid[at(81_950)], 50, 'b alone: its 50 stacked at 81,955');
  assert.equal(pullRows(then, now, [now], ['a:BTC'], 0.2, Math.floor(81_990 / 0.2), 10), null, 'a step finer than the base');
});

test('rows the price reached between the snapshots are marked: the inside market and the trades seen', async () => {
  const kernels = await loadWasm();
  const then = snapshot(kernels, frame(wide('a:BTC')), BASE, MARK, 0, 1);
  const mid = snapshot(kernels, frame(wide('a:BTC')), BASE, MARK, 30_000, 2, 81_990, 82_062);
  const now = snapshot(kernels, frame(wide('a:BTC')), BASE, MARK, 60_000, 3);
  const step = 10, bin0 = 8_190, n = 20; // 81,900 … 82,090
  const touched = [...pullRows(then, now, [mid, now], ['a:BTC'], step, bin0, n)!.touched].flatMap((v, j) => v ? [(bin0 + j) * step] : []);
  assert.deepEqual(touched, [81_990, 82_000, 82_010, 82_020, 82_030, 82_040, 82_050, 82_060]);
});

test('the window fills before it shows, snapshots keep their spacing, a gap starts again, and a view is worked out once per snapshot', async () => {
  const kernels = await loadWasm();
  const h = new PullHistory(), f = frame(wide('a:BTC', [[81_950, 81_950, 100]]));
  const take = (t: number) => h.step(kernels, f, MARK, t, 15, BASE, 'BTC|0.5|15');
  take(0);
  assert.deepEqual(h.view(['a:BTC'], 10, 8_190, 20, 15), { kind: 'filling', waitS: 15 });
  take(400); // too soon after the last: not taken
  for (let t = 1_000; t <= 10_000; t += 1_000) take(t);
  assert.deepEqual(h.view(['a:BTC'], 10, 8_190, 20, 15), { kind: 'filling', waitS: 5 });
  for (let t = 11_000; t <= 16_000; t += 1_000) take(t);
  const first = h.view(['a:BTC'], 10, 8_190, 20, 15);
  assert.equal(first.kind, 'rows');
  assert.equal(h.view(['a:BTC'], 10, 8_190, 20, 15), first, 'the same snapshots and rows: the same answer');
  assert.equal(h.view(['a:BTC'], 0.2, Math.floor(81_900 / 0.2), 20, 15).kind, 'fine');
  take(30_000); // 14 s after the last, over three spacings: the book was not drawn meanwhile
  assert.deepEqual(h.view(['a:BTC'], 10, 8_190, 20, 15), { kind: 'filling', waitS: 15 });
  assert.equal(h.view(['a:BTC'], 10, 8_190, 20, 0).kind, 'off');
});
