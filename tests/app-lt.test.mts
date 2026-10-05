import test from 'node:test';
import assert from 'node:assert/strict';
import { LT_DEFAULTS, ltSeries, ltWeight, type LtParams, type LtStore } from '../src/app/lt.ts';

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

test('venues merge into one book: the touch is the best price across stores and cutoffs replace stale columns', () => {
  const a = store([{ t: 0, rows: [[1000, 100, 0], [1005, 0, 100]] }, { t: MIN, rows: [[1000, 999, 0]] }], { cutoff: MIN });
  const b = store([{ t: 0, rows: [[1001, 200, 0], [1004, 0, 300]] }]);
  const out = ltSeries([a, b], 0, 2 * MIN, MIN, flat());
  assert.deepEqual([...out.times], [0], 'the column at the cutoff is ignored');
  near(out.bid, [300]);
  near(out.ask, [400]);
  const p0 = 1001.5;
  const tight = ltSeries([a, b], 0, 2 * MIN, MIN, { ...flat(), halfLifeBp: 10 });
  const expectBid = 200 * 1 + 100 * ltWeight((p0 - 1000.5) / p0 * 1e4, 10);
  assert.ok(Math.abs(tight.bid[0]! - expectBid) < 1e-3, 'the other venue is measured from the merged touch');
});

test('output is time-ordered, limited to the requested range, and empty sides read zero', () => {
  const s = store([{ t: 3 * MIN, rows: [[1000, 10, 0]] }, { t: MIN, rows: [[1000, 0, 20]] }, { t: 9 * MIN, rows: [[1000, 5, 5]] }]);
  const out = ltSeries([s], 0, 5 * MIN, MIN, flat());
  assert.deepEqual([...out.times], [MIN, 3 * MIN]);
  near(out.bid, [0, 10]);
  near(out.ask, [20, 0]);
});
