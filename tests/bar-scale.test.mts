import test from 'node:test';
import assert from 'node:assert/strict';
import { BAR_CUT_RATIO, BAR_SCALE_MIN, barScale, partsWithin } from '../src/app/bar-scale.ts';

/** `n - 1` sizes 100, 101, ... (the bulk of a day's bars) with `big` added. */
const bulk = (n: number, ...big: number[]): number[] => Array.from({ length: n - big.length }, (_, i) => 100 + i).concat(big);

test('one flush is cut and the rest keep their proportions', () => {
  // A day of 96 fifteen-minute changes around 160 coins, and one flush of 4,417 (2026-11-10).
  const day = Array.from({ length: 95 }, (_, i) => 100 + i * 1.5).concat([4_417]);
  const scale = barScale(day);
  assert.equal(scale, 100 + 94 * 1.5, 'the largest of the rest: the flush is cut');
  assert.equal(day.filter(x => x > scale).length, 1);
});

test('with few sizes in view the largest sets the scale, and sizes of zero, negative or not finite count for nothing', () => {
  const few = Array.from({ length: BAR_SCALE_MIN - 1 }, (_, i) => i + 1);
  assert.equal(barScale(few), BAR_SCALE_MIN - 1);
  assert.equal(barScale(bulk(BAR_SCALE_MIN - 1, 5_000)), 5_000, 'fewer than 20: the largest, however far it stands out');
  assert.equal(barScale([0, -5, Number.NaN, Number.POSITIVE_INFINITY]), 0, 'nothing to draw against');
  assert.equal(barScale([3, 0, 7, Number.NaN]), 7);
  assert.equal(barScale([...bulk(BAR_SCALE_MIN - 1, 5_000), 0, 0, -1]), 5_000, 'zeros and negatives do not count toward the 20');
  assert.equal(barScale([...bulk(30, 2_000, 2_500, 3_000, 3_600), ...Array.from({ length: 20 }, () => 0)]), 3_600, 'nor toward the share: four among 30 changes is more than three');
  assert.equal(barScale(new Set([2, 9])), 9, 'any iterable');
  assert.equal(barScale(Array.from({ length: 40 }, () => 50)), 50, 'all equal: nothing cut');
});

test('from 20 sizes, however many: a flush is cut (a fixed 98th percentile was the largest itself below 50)', () => {
  for (const n of [20, 24, 49, 50, 99, 100, 400]) assert.equal(barScale(bulk(n, 5_000)), 100 + n - 2, `${n} sizes`);
});

test('the few that stand well clear of the rest are all cut: a cascade over two or more candles, or both sides of one', () => {
  // A fixed rank left one out and let the second set the scale: the bulk was 3 to 7 % of the band (review, 2026-11-10).
  assert.equal(barScale(bulk(96, 2_000, 4_417)), 193, 'a flush and a follow-on bar half its size');
  assert.equal(barScale(bulk(96, 3_500, 4_417)), 193, 'two flushes close in size');
  assert.equal(barScale(bulk(20, 5_000, 5_000)), 117, 'two equal ones among 20 (the Delta pane pools both sides of a candle)');
  assert.equal(barScale(bulk(30, 4_000, 5_000)), 127);
  assert.equal(barScale(bulk(100, 2_000, 2_500, 3_000, 4_417)), 195, 'four among 100');
  assert.equal(barScale(bulk(40, 2_000, 2_500, 3_000)), 136, 'exactly three among 40');
  assert.equal(barScale(bulk(24, 2_000, 2_500, 3_000)), 120, 'three among 24, where a tenth is two: at least three');
  assert.equal(barScale(bulk(96, ...Array.from({ length: 10 }, (_, i) => 1_000 + 100 * i))), 1_900, 'ten among 96: a tenth rounds down to nine');
  assert.equal(barScale(bulk(40, 2_000, 2_500, 3_000, 4_417)), 135, 'four among 40 (a tenth of 40)');
  assert.equal(barScale(bulk(96, 1_500, 2_000, 2_500, 3_000, 4_417)), 190, 'a five-candle cascade in a day of 96 (a share of 5 % left it uncut)');
  assert.equal(barScale(bulk(100, 1_200, 1_500, 2_000, 2_500, 3_000, 4_417)), 193, 'six among 100');
  assert.equal(barScale(bulk(100, ...Array.from({ length: 10 }, (_, i) => 1_000 + 100 * i))), 189, 'ten among 100, the step at the deepest allowed');
  // More than that many standing out is no longer a few: drawn whole.
  assert.equal(barScale(bulk(40, 2_000, 2_500, 3_000, 3_600, 4_300, 5_000)), 5_000, 'six among 40: at most four');
  assert.equal(barScale(bulk(100, ...Array.from({ length: 11 }, (_, i) => 1_000 + 100 * i))), 2_000, 'eleven among 100: at most ten');
});

test('a largest barely past the rest is drawn whole, so a cut mark always means much larger', () => {
  assert.equal(barScale(bulk(30, 128 * BAR_CUT_RATIO)), 128 * BAR_CUT_RATIO, 'exactly 1.5 times the next: not cut');
  assert.equal(barScale(bulk(30, 128 * BAR_CUT_RATIO + 1)), 128, 'just past it: cut');
  // The deepest step decides: 600 stands 3.3 times above the rest and is cut with the flush, not left to set the scale.
  assert.equal(barScale(bulk(96, 600, 4_417)), 193);
});

test('a cut stack keeps each part its share, so a part behind a large one is never left out', () => {
  // ETH 2026-08-01: new shorts 2,290 and longs closed 3,516 against a scale of 2,044. Cut in stacking order, the longs closed (61 % of the
  // stack) were not drawn at all (review round 3).
  const [opened, closed] = partsWithin([2_290, 3_516], 2_044);
  assert.ok(Math.abs(opened! + closed! - 2_044) < 1e-9, 'the stack ends at the scale');
  assert.ok(Math.abs(closed! / (opened! + closed!) - 3_516 / 5_806) < 1e-12, 'each part its share');
  assert.deepEqual(partsWithin([300, 200], 2_044), [300, 200], 'a stack that fits is drawn as it is');
  assert.deepEqual(partsWithin([-5, Number.NaN, 10], 5), [0, 0, 5], 'a negative or non-finite part counts as nothing');
  assert.deepEqual(partsWithin([Number.POSITIVE_INFINITY, 10], 5), [0, 5]);
  assert.deepEqual(partsWithin([0, 0], 0), [0, 0]);
});
