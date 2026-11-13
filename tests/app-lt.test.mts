import test from 'node:test';
import assert from 'node:assert/strict';
import { LT_DEFAULTS, imbalanceAxis, ltPartAt, ltSeries, ltWeight, shownBy, type LtParams, type LtStore } from '../src/app/lt.ts';
import { LT_LENGTH, ltIndex } from '../src/shared/lt-sample.ts';

const MIN = 60_000;
const near = (actual: ArrayLike<number>, expected: number[], eps = 1e-3) => { assert.equal(actual.length, expected.length); expected.forEach((v, i) => assert.ok(Math.abs(actual[i]! - v) < eps, `index ${i}: ${actual[i]} vs ${v}`)); };
const flat = (over: Partial<LtParams> = {}): LtParams => ({ ...LT_DEFAULTS, halfLifeBp: 1e9, ...over });

/** One instrument, step 1: entries are [bin, bidUsd, askUsd] per column; bin b has its price at b + 0.5. */
function store(columns: { t: number; rows: [number, number, number][] }[], extra: Partial<LtStore> = {}): LtStore {
  const rows = columns.flatMap(c => c.rows);
  return { step: 1, times: columns.map(c => c.t), counts: columns.map(c => c.rows.length), bins: rows.map(r => r[0]), bid: rows.map(r => r[1]), ask: rows.map(r => r[2]), ...extra };
}

test('weight is 1 at the touch and halves every half-life', () => {
  assert.equal(ltWeight(0, 10), 1);
  assert.equal(ltWeight(10, 10), 0.5);
  assert.equal(ltWeight(20, 10), 0.25);
  assert.equal(ltWeight(-5, 10), 1, 'a level through the touch does not weigh more than the touch');
});

test('a huge half-life sums the whole book; averaging divides by the non-empty levels', () => {
  const s = store([{ t: 0, rows: [[1000, 100, 0], [999, 300, 0], [998, 0, 0], [1001, 0, 50], [1002, 0, 150]] }]);
  const sum = ltSeries([s], 0, MIN, MIN, flat());
  near(sum.bid, [400]);
  near(sum.ask, [200]);
  const avg = ltSeries([s], 0, MIN, MIN, flat({ average: true }));
  near(avg.bid, [200]);
  near(avg.ask, [100]);
});

test('the size filter drops bins outside [min, max] but never moves the touch', () => {
  // Best bid is the tiny 1 USD level at 1000.5; the big level sits 100.5 bp... below it.
  const s = store([{ t: 0, rows: [[1000, 1, 0], [990, 5000, 0], [1001, 0, 1], [1011, 0, 5000]] }]);
  const params: LtParams = { halfLifeBp: 100, minUsd: 100, maxUsd: 0, average: false };
  const out = ltSeries([s], 0, MIN, MIN, params);
  const d = (1000.5 - 990.5) / 1000.5 * 1e4;
  assert.ok(Math.abs(out.bid[0]! - 5000 * ltWeight(d, 100)) < 1e-3, 'distance is measured from the unfiltered best bid');
  const capped = ltSeries([s], 0, MIN, MIN, { ...params, minUsd: 0, maxUsd: 100 });
  assert.ok(Math.abs(capped.bid[0]! - 1) < 1e-6, 'only the 1 USD level survives a 100 USD cap');
  assert.ok(Math.abs(capped.ask[0]! - 1) < 1e-6);
});

test('each venue is measured from its own touch and the venues add up; cutoffs replace stale columns', () => {
  const a = store([{ t: 0, rows: [[1000, 100, 0], [1005, 0, 100]] }, { t: MIN, rows: [[1000, 999, 0]] }], { cutoff: MIN });
  const b = store([{ t: 0, rows: [[1001, 200, 0], [1004, 0, 300]] }]);
  const out = ltSeries([a, b], 0, 2 * MIN, MIN, flat());
  assert.deepEqual([...out.times], [0], 'the column at the cutoff is ignored');
  near(out.bid, [300]);
  near(out.ask, [400]);
  // a's best bid is a bin below b's: measured from its own touch it counts in full (from one touch shared by both, it weighed less).
  const tight = ltSeries([a, b], 0, 2 * MIN, MIN, { ...flat(), halfLifeBp: 10 });
  near(tight.bid, [300]);
  near(tight.ask, [400]);
});

test('two venues priced apart: the one priced off the other is not read as thinner on one side', () => {
  // The same book shape on two venues, one 20 bp above the other (USDT spot over the perpetuals): each side weighs the same on both.
  const book = (offset: number) => store([{ t: 0, rows: [[1000 + offset, 100, 0], [999 + offset, 100, 0], [1001 + offset, 0, 100], [1002 + offset, 0, 100]] }]);
  const out = ltSeries([book(0), book(2)], 0, MIN, MIN, { ...LT_DEFAULTS, halfLifeBp: 10 });
  assert.ok(Math.abs(out.bid[0]! - out.ask[0]!) / (out.bid[0]! + out.ask[0]!) < 1e-3, `bids ${out.bid[0]} and asks ${out.ask[0]} balance`);
});

test('a kept tracker is read as it is; a size filter, a column without one, or a half-life not kept work it out from the book', () => {
  // One venue, two minutes: the first with a kept tracker (its fields for the 10 bp half-life set to recognisable sums), the second without.
  const lt = new Float32Array(2 * LT_LENGTH).fill(NaN);
  lt.fill(0, 0, LT_LENGTH);
  const at = ltIndex(10); lt[at] = 111; lt[at + 1] = 222; lt[at + 2] = 2; lt[at + 3] = 4;
  const s = store([{ t: 0, rows: [[1000, 100, 0], [1001, 0, 50]] }, { t: MIN, rows: [[1000, 100, 0], [1001, 0, 50]] }], { lt });
  const out = ltSeries([s], 0, 2 * MIN, MIN, { ...LT_DEFAULTS, halfLifeBp: 10 });
  near(out.bid, [111, 100]); near(out.ask, [222, 50]);
  assert.equal(out.estimated, true, 'the second minute was worked out from its average book');
  near(ltSeries([s], 0, MIN, MIN, { ...LT_DEFAULTS, halfLifeBp: 10, average: true }).bid, [111 / 2], 1e-3);
  assert.equal(ltSeries([s], 0, MIN, MIN, { ...LT_DEFAULTS, halfLifeBp: 10 }).estimated, false, 'the kept minute alone is not an estimate');
  const filtered = ltSeries([s], 0, MIN, MIN, { ...LT_DEFAULTS, halfLifeBp: 10, minUsd: 60 });
  near(filtered.bid, [100]); near(filtered.ask, [0]);
  assert.equal(filtered.estimated, true, 'the kept tracker is unfiltered, so a filter works from the book');
  assert.equal(ltSeries([{ ...s, instant: true, lt: undefined }], 0, MIN, MIN, { ...LT_DEFAULTS, halfLifeBp: 10 }).estimated, false, 'one instant (the live book) is exact');
});

test('output is time-ordered, limited to the requested range, and empty sides read zero', () => {
  const s = store([{ t: 3 * MIN, rows: [[1000, 10, 0]] }, { t: MIN, rows: [[1000, 0, 20]] }, { t: 9 * MIN, rows: [[1000, 5, 5]] }]);
  const out = ltSeries([s], 0, 5 * MIN, MIN, flat());
  assert.deepEqual([...out.times], [MIN, 3 * MIN]);
  near(out.bid, [0, 10]);
  near(out.ask, [20, 0]);
});

test('the imbalance axis is the largest imbalance in view, up to the next of 2, 5, 10, 20, 50 and 100 %', () => {
  assert.equal(imbalanceAxis(0), 0.02, 'nothing in view: the smallest');
  assert.deepEqual([0.004, 0.02, 0.021, 0.05, 0.07, 0.1, 0.15, 0.2, 0.3, 0.5, 0.51, 1].map(imbalanceAxis), [0.02, 0.02, 0.05, 0.05, 0.1, 0.1, 0.2, 0.2, 0.5, 0.5, 1, 1]);
  assert.equal(imbalanceAxis(NaN), 0.02);
  assert.equal(imbalanceAxis(1.4), 1, 'never past the whole book');
  for (const largest of [0.004, 0.03, 0.2, 0.9]) assert.ok(imbalanceAxis(largest) >= largest, 'the largest bar fits');
});

test('each market\'s part: the very numbers the lines add up, its live column with its recorded ones, NaN where it has none', () => {
  // Market 0: recorded at 0 and 1 min, its live column replacing the minute at 1 min. Market 1: recorded at 0 only. A store with no owner counts in the sums alone.
  const a = store([{ t: 0, rows: [[1000, 100, 0], [1005, 0, 100]] }, { t: MIN, rows: [[1000, 999, 0]] }], { cutoff: MIN, owner: 0 });
  const live = store([{ t: MIN, rows: [[1000, 40, 0], [1001, 0, 60]] }], { instant: true, owner: 0 });
  const b = store([{ t: 0, rows: [[1001, 200, 0], [1004, 0, 300]] }], { owner: 1 });
  const loose = store([{ t: 0, rows: [[1001, 7, 0]] }]);
  const out = ltSeries([a, live, b, loose], 0, 2 * MIN, MIN, flat(), 2);
  assert.deepEqual([...out.times], [0, MIN]);
  near(out.bid, [307, 40]); near(out.ask, [400, 60]);
  const parts = out.parts!;
  assert.equal(parts.bid.length, 4, 'two markets of two windows each');
  assert.deepEqual([ltPartAt(parts, 2, 0, 0), ltPartAt(parts, 2, 0, 1), ltPartAt(parts, 2, 1, 0), ltPartAt(parts, 2, 1, 1)],
    [{ bid: 100, ask: 100 }, { bid: 40, ask: 60 }, { bid: 200, ask: 300 }, null], 'market 1 has nothing at 1 min: no figure, not a zero');
  assert.equal(ltSeries([a, b], 0, 2 * MIN, MIN, flat()).parts, undefined, 'none asked: none made');
  // A gap in the lane (NaN numbers) is nothing for that market; an empty column of a book is a zero, there.
  const lane: LtStore = { step: 1, times: [0, MIN], counts: [0, 0], bins: [], bid: [], ask: [], lt: [5, 6, 1, 1, NaN, NaN, NaN, NaN], ltStride: 4, owner: 0 };
  const empty = store([{ t: MIN, rows: [] }], { owner: 1 });
  const mixed = ltSeries([lane, empty], 0, 2 * MIN, MIN, flat(), 2);
  assert.deepEqual([ltPartAt(mixed.parts!, 2, 0, 0), ltPartAt(mixed.parts!, 2, 0, 1), ltPartAt(mixed.parts!, 2, 1, 1)], [{ bid: 5, ask: 6 }, null, { bid: 0, ask: 0 }]);
});

test('in the Per level mode a market\'s part is its own average, and the lines are pooled over every market\'s weights', () => {
  const a = store([{ t: 0, rows: [[1000, 100, 0], [999, 300, 0], [1001, 0, 50]] }], { owner: 0 });
  const b = store([{ t: 0, rows: [[1000, 600, 0], [1001, 0, 10]] }], { owner: 1 });
  const out = ltSeries([a, b], 0, MIN, MIN, flat({ average: true }), 2);
  near(out.bid, [1000 / 3]); near(out.ask, [30]);
  const parts = out.parts!;
  assert.ok(parts.wBid && parts.wAsk, 'the weights come with them');
  const [x, y] = [ltPartAt(parts, 1, 0, 0)!, ltPartAt(parts, 1, 1, 0)!];
  near([x.bid, x.ask, y.bid, y.ask], [200, 50, 600, 10]);
});

test('a replay shows only the windows that had ended by its moment, never one it falls inside', () => {
  const M = 60_000, times = [0, 15 * M, 30 * M, 45 * M];
  // At 40 min the window from 30 holds samples to 45: it is not shown, though it began before the moment.
  assert.equal(shownBy(times, 15 * M, 40 * M), 2);
  assert.equal(shownBy(times, 15 * M, 45 * M), 3, 'a window ending at the moment is shown');
  assert.equal(shownBy(times, 15 * M, 5 * M), 0);
  assert.equal(shownBy(times, 15 * M, Infinity), 4);
});

test('each window says whether a column of it was worked out from an average book', () => {
  const k = ltIndex(10), kept = new Array(LT_LENGTH * 2).fill(NaN);
  kept[LT_LENGTH + k] = 5; kept[LT_LENGTH + k + 1] = 6; kept[LT_LENGTH + k + 2] = 1; kept[LT_LENGTH + k + 3] = 1;
  // Minute 0 has no kept tracker (worked out from its book), minute 1 has one; a live instant is exact.
  const s = store([{ t: 0, rows: [[1000, 10, 0], [1001, 0, 10]] }, { t: MIN, rows: [] }], { lt: kept });
  const live = store([{ t: 2 * MIN, rows: [[1000, 10, 0]] }], { instant: true });
  const out = ltSeries([s, live], 0, 3 * MIN, MIN, { ...LT_DEFAULTS, halfLifeBp: 10 });
  assert.deepEqual([...out.times], [0, MIN, 2 * MIN]);
  assert.deepEqual([...out.approx!], [1, 0, 0]);
});
