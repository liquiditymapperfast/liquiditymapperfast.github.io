import test from 'node:test';
import assert from 'node:assert/strict';
import { MAX_DISTANCE, bucketWidth, mergeByDistance } from '../src/server/v2/merge.mts';
import type { SideLevels } from '../src/server/v2/levels.mts';
import { gridStepFor } from '../src/shared/grid.ts';

const side = (rows: [number, number][]): SideLevels => ({ lo: Float64Array.from(rows.map(r => r[0])), hi: Float64Array.from(rows.map(r => r[0])), usd: Float64Array.from(rows.map(r => r[1])) });
const total = (s: SideLevels) => s.usd.reduce((a, b) => a + b, 0);

test('bucket widths grow with distance: divisors of the grid step up to it, power-of-two multiples beyond, capped', () => {
  const step = 20;
  const widths = [0, 100, 500, 1_500, 4_000, 20_000, 80_000, 400_000].map(d => bucketWidth(d, step));
  assert.deepEqual(widths, [1, 1, 2, 10, 20, 80, 320, 320]);
  for (const width of widths) assert.ok(step % width === 0 || width % step === 0 && Math.log2(width / step) % 1 === 0, `${width} relates to ${step}`);
  for (const step2 of [0.5, 0.01, 5, 100]) for (const d of [0, 1, 10, 100, 1e4, 1e6]) {
    const width = bucketWidth(d, step2), ratio = step2 / width;
    const divides = Math.abs(ratio - Math.round(ratio)) < 1e-9 && [1, 2, 4, 5, 10, 20].includes(Math.round(ratio));
    const multiple = width >= step2 && Math.abs(Math.log2(width / step2) % 1) < 1e-9 && width <= step2 * 16;
    assert.ok(divides || multiple, `${step2} at ${d}: ${width}`);
  }
});

test('levels merge by distance: the touch stays fine, far levels share a bucket, nothing is lost', () => {
  const mid = 86_500, step = gridStepFor(mid);
  const rows: [number, number][] = [];
  for (let i = 0; i < 6_000; i++) rows.push([86_499.99 - i * 0.01, 10]);          // dense one-cent bids for $60
  rows.push([86_000.2, 1_000], [86_000.7, 500], [80_000.5, 7_000], [70_000.1, 2_000]);
  const merged = mergeByDistance(side(rows), mid, step, true);
  assert.ok(merged.usd.length < 120, `thousands of one-cent levels become ${merged.usd.length} buckets`);
  assert.ok(Math.abs(total(merged) - rows.reduce((a, r) => a + r[1], 0)) < 1e-6, 'every dollar is kept');
  assert.ok(merged.lo.every((p, i) => i === 0 || p < merged.lo[i - 1]!), 'still nearest-first');
  assert.ok(Math.abs(merged.lo[0]! - 86_499) < 0.011, 'the touch bucket is reported at its lowest member');
  const wall = merged.lo.findIndex(p => p <= 86_000.7 && p > 85_990);
  assert.equal(merged.usd[wall], 1_500, 'two levels in one bucket add up');
  assert.ok(merged.lo.some(p => p <= 80_000.5 && p > 79_990) && merged.lo.some(p => p <= 70_000.1 && p > 69_980), 'far walls survive');
});

test('a lone level keeps its exact price, a merged one moves away from the mark, and a one-cent spread never reads as crossed', () => {
  const mid = 86_500, step = 20;
  const bids = mergeByDistance(side([[86_499.99, 5]]), mid, step, true), asks = mergeByDistance(side([[86_500.01, 5]]), mid, step, false);
  assert.equal(bids.lo[0], 86_499.99); assert.equal(asks.lo[0], 86_500.01);
  const merged = mergeByDistance(side([[86_500.01, 1], [86_500.4, 1], [86_500.9, 1]]), mid, step, false);
  assert.equal(merged.usd.length, 1); assert.equal(merged.lo[0], 86_500.9, 'asks report the highest member');
  const lower = mergeByDistance(side([[86_499.9, 1], [86_499.2, 1]]), mid, step, true);
  assert.equal(lower.lo[0], 86_499.2, 'bids report the lowest member');
  for (const [prices, isBid] of [[[86_519.9, 86_519.1, 86_520.4], false], [[86_480.1, 86_480.9, 86_479.6], true]] as const) {
    const m = mergeByDistance(side(prices.map(p => [p, 1] as [number, number])), mid, step, isBid);
    for (let i = 0; i < m.lo.length; i++) assert.ok(prices.some(p => Math.floor(p / step) === Math.floor(m.lo[i]! / step)), 'a merged level stays in a bin one of its members was in');
  }
});

test('levels beyond the maximum distance are dropped and band levels pass through', () => {
  const mid = 100_000;
  const far = mergeByDistance(side([[99_000, 1], [40_000, 9]]), mid, 20, true);
  assert.equal(far.usd.length, 1, `${MAX_DISTANCE * 100}% is the limit`);
  const bands: SideLevels = { lo: Float64Array.of(99_000), hi: Float64Array.of(99_100), usd: Float64Array.of(5) };
  assert.equal(mergeByDistance(bands, mid, 20, true), bands, 'coarse provider bands are not touched');
  const none = side([]);
  assert.equal(mergeByDistance(none, mid, 20, true), none);
});

test('beyond the grid step a bucket spans several bins but is recorded in a member bin, conserving USD', () => {
  const mid = 100_000, step = 20, rows: [number, number][] = [];
  for (let p = 70_000; p < 70_300; p += 7) rows.push([p, 100]);   // sparse far asks-side stand-in (30 % away, 300 wide)
  const sorted = rows.sort((a, b) => b[0] - a[0]);
  const merged = mergeByDistance(side(sorted), mid, step, true);
  assert.ok(merged.usd.length < sorted.length / 2, `${sorted.length} levels became ${merged.usd.length}`);
  assert.ok(Math.abs(total(merged) - total(side(sorted))) < 1e-6);
  for (const price of merged.lo) assert.ok(sorted.some(r => Math.floor(r[0] / step) === Math.floor(price / step)), 'recorded in the bin of one of its members');
});
