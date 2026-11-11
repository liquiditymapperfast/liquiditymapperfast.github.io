import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { coverage, cumulative, groupLevels, imbalanceByDistance, type Grouped } from '../src/app/panes/levels-data.ts';
import { venueCumulative } from '../src/app/panes/ladder-curves.ts';
import type { Kernels } from '../src/app/kernels.ts';
import type { LevelsFrame } from '../src/app/wire.ts';

interface Glue { default(options: { module_or_path: Uint8Array }): Promise<unknown>; spread_levels: (...a: unknown[]) => Float32Array; raster_columns: (...a: unknown[]) => Float32Array; blur_rows: (data: Float32Array, w: number, h: number, sigma: number) => Float32Array; merge_by_distance: (lo: Float64Array, usd: Float64Array, mid: number, step: number, isBid: boolean) => Float64Array }
/** The committed wasm exactly as shipped (as tests/app-client.test.mts loads it). */
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
const book = (id: string, bids: [number, number, number][], asks: [number, number, number][]): LevelsFrame['books'][number] => ({ id, venue: id.split(':')[0]!, timestamp: 1, coarse: false, bids: side(bids), asks: side(asks) });
const frameOf = (): LevelsFrame => ({ asOf: 1, books: [
  book('a:BTC', [[99, 99, 10], [85, 85, 30], [92, 96, 40]], [[101, 101, 5], [104, 104, 7]]),
  book('b:BTC', [[99, 99, 20]], [[111, 111, 8], [103, 109, 12]]),
  book('c:BTC', [[98, 98, 3]], []),
] });
const copyFrame = (f: LevelsFrame): LevelsFrame => ({ asOf: f.asOf, books: f.books.map(b => ({ ...b, bids: { lo: b.bids.lo.slice(), hi: b.bids.hi.slice(), usd: b.bids.usd.slice() }, asks: { lo: b.asks.lo.slice(), hi: b.asks.hi.slice(), usd: b.asks.usd.slice() } })) });
const same = (a: Grouped, b: Grouped): void => {
  assert.deepEqual(a.ids, b.ids); assert.equal(a.step, b.step); assert.equal(a.bin0, b.bin0); assert.equal(a.nBins, b.nBins);
  assert.deepEqual([...a.totalBid], [...b.totalBid]); assert.deepEqual([...a.totalAsk], [...b.totalAsk]);
  a.bid.forEach((row, k) => { assert.deepEqual([...row], [...b.bid[k]!]); assert.deepEqual([...a.ask[k]!], [...b.ask[k]!]); });
};

test('a frame grouped twice the same way is grouped once, and the answer is what grouping it fresh gives', async () => {
  const kernels = await loadWasm(), frame = frameOf(), ids = ['a:BTC', 'b:BTC', 'c:BTC'];
  const first = groupLevels(kernels, frame, ids, 10, 80, 120);
  assert.equal(groupLevels(kernels, frame, ids, 10, 80, 120), first, 'the same request on the same frame is the same grouping');
  same(first, groupLevels(kernels, copyFrame(frame), ids, 10, 80, 120));
  assert.notEqual(groupLevels(kernels, frame, ids, 5, 80, 120), first, 'another step');
  assert.notEqual(groupLevels(kernels, frame, ids, 10, 70, 120), first, 'another first bin');
  assert.notEqual(groupLevels(kernels, frame, ids, 10, 80, 130), first, 'another number of bins');
  assert.notEqual(groupLevels(kernels, frame, ['a:BTC', 'b:BTC'], 10, 80, 120), first, 'other venues');
  assert.notEqual(groupLevels(kernels, frame, ['b:BTC', 'a:BTC', 'c:BTC'], 10, 80, 120), first, 'the venues in another order (the rows follow it)');
  assert.notEqual(groupLevels(kernels, copyFrame(frame), ids, 10, 80, 120), first, 'another frame, even with the same numbers');
});

test('the venues a frame lacks are left out of the grouping, and the answer is still kept', async () => {
  const kernels = await loadWasm(), frame = frameOf(), ids = ['a:BTC', 'gone:BTC', 'b:BTC'];
  const g = groupLevels(kernels, frame, ids, 10, 80, 120);
  assert.deepEqual(g.ids, ['a:BTC', 'b:BTC']);
  assert.equal(groupLevels(kernels, frame, ids, 10, 80, 120), g);
});

test('only a few groupings are kept for one frame: the oldest goes first', async () => {
  const kernels = await loadWasm(), frame = frameOf(), ids = ['a:BTC', 'b:BTC'];
  const first = groupLevels(kernels, frame, ids, 10, 80, 120);
  for (let k = 1; k <= 8; k++) groupLevels(kernels, frame, ids, 10, 80 - 10 * k, 120);
  const again = groupLevels(kernels, frame, ids, 10, 80, 120);
  assert.notEqual(again, first, 'evicted after eight others');
  same(again, first);
});

/** What coverage was before its reach was kept with the book: every level looked at each time. */
function coverageByScan(b: LevelsFrame['books'][number] | undefined, mark: number): unknown {
  if (!b || !(mark > 0) || b.bids.usd.length + b.asks.usd.length === 0) return null;
  let lo = Infinity, hi = -Infinity;
  for (const v of b.bids.lo) if (v < lo) lo = v;
  for (const v of b.asks.hi) if (v > hi) hi = v;
  if (!Number.isFinite(lo)) lo = mark;
  if (!Number.isFinite(hi)) hi = mark;
  let hiPoint = false;
  for (let i = 0; i < b.asks.hi.length; i++) if (b.asks.hi[i] === hi && b.asks.lo[i]! >= hi) { hiPoint = true; break; }
  return { lo, hi, hiPoint, bp: Math.round((hi - lo) / mark * 1e4), levels: b.bids.usd.length + b.asks.usd.length };
}

test('coverage is what scanning the levels gives, for points, bands, one-sided and empty books, at any mark', () => {
  const frame = frameOf();
  const books = [...frame.books, book('d:BTC', [], [[120, 130, 9]]), book('e:BTC', [], []), book('f:BTC', [[90, 90, 4]], [[110, 110, 4], [150, 150, 1]])];
  for (const b of books) for (const mark of [100, 100.5, 0, -1, NaN, 1e6]) {
    assert.deepEqual(coverage(b, mark), coverageByScan(b, mark), `${b.id} at ${mark}`);
    assert.deepEqual(coverage(b, mark), coverageByScan(b, mark), `${b.id} at ${mark} again (kept)`);
  }
  assert.equal(coverage(undefined, 100), null);
});

test('the running totals of a grouping are made once for a mark bin, and are what a fresh walk gives', async () => {
  const kernels = await loadWasm(), frame = frameOf();
  const g = groupLevels(kernels, frame, ['a:BTC', 'b:BTC'], 10, 80, 120);
  const cum = cumulative(g, 100);
  assert.equal(cumulative(g, 100), cum);
  assert.equal(cumulative(g, 104.9), cum, 'the mark moving inside its bin changes nothing');
  assert.notEqual(cumulative(g, 110), cum, 'the mark in another bin');
  const fresh = cumulative({ ...g }, 100);
  assert.deepEqual([...fresh.bid], [...cum.bid]); assert.deepEqual([...fresh.ask], [...cum.ask]);
  assert.equal(fresh.maxBid, cum.maxBid); assert.equal(fresh.maxAsk, cum.maxAsk);
});

test('the balance by distance is made once for its totals, and a different bin or minimum is another answer', async () => {
  const kernels = await loadWasm(), frame = frameOf();
  const g = groupLevels(kernels, frame, ['a:BTC', 'b:BTC'], 10, 80, 120), cum = cumulative(g, 100), markBin = Math.floor(100 / 10) - g.bin0;
  const imbalance = imbalanceByDistance(g, cum, markBin);
  assert.equal(imbalanceByDistance(g, cum, markBin), imbalance);
  assert.notEqual(imbalanceByDistance(g, cum, markBin, 1), imbalance);
  assert.notEqual(imbalanceByDistance(g, cum, markBin + 1), imbalance);
  const by = (minRows: number): number[] => Array.from(g.totalBid, (_, i) => { const d = Math.max(Math.abs(i - markBin), minRows), b = cum.bid[Math.max(0, markBin - d)]!, a = cum.ask[Math.min(g.nBins - 1, markBin + d)]!; return b + a > 0 ? (b - a) / (b + a) : 0; });
  assert.deepEqual([...imbalance], by(4).map(Math.fround));
  assert.ok([...imbalanceByDistance(g, cum, -1)].every(v => v === 0) && [...imbalanceByDistance(g, cum, g.nBins)].every(v => v === 0));
});

test('a venue\'s running totals are made once for a grouping and mark bin, and match the walk', async () => {
  const kernels = await loadWasm(), frame = frameOf();
  const g = groupLevels(kernels, frame, ['a:BTC', 'b:BTC'], 10, 80, 120), markBin = Math.floor(100 / 10) - g.bin0;
  const w = venueCumulative(g, 0, markBin);
  assert.equal(venueCumulative(g, 0, markBin), w);
  assert.notEqual(venueCumulative(g, 1, markBin), w, 'another venue');
  assert.notEqual(venueCumulative(g, 0, markBin + 1), w, 'another mark bin');
  let run = 0; const bid = new Float32Array(g.nBins);
  for (let i = Math.min(g.nBins - 1, markBin); i >= 0; i--) { run += g.bid[0]![i]!; bid[i] = run; }
  assert.deepEqual([...w.bid], [...bid]);
  assert.equal(venueCumulative({ nBins: g.nBins, bid: g.bid, ask: g.ask }, 9, markBin).bid.every(v => v === 0), true, 'a venue that is not there walks nothing');
});
