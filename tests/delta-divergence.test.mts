import test from 'node:test';
import assert from 'node:assert/strict';
import { divergences, inView, pivots, type PriceBar } from '../src/app/delta/divergence.ts';
import type { DeltaCandle } from '../src/app/delta/candles.ts';

const H = 3_600_000, T = Date.UTC(2026, 9, 9);

/** Bars from highs (the lows a fixed 10 under), one an hour from T. */
const bars = (highs: number[], lows = highs.map(h => h - 10)): PriceBar[] => highs.map((high, i) => ({ t: T + i * H, high, low: lows[i]! }));
/** CVD candles at the same hours from their highs and lows, all in `runs[i]` (0 by default). */
const cvd = (highs: number[], lows = highs.map(h => h - 1), runs = highs.map(() => 0)): DeltaCandle[] =>
  highs.map((high, i) => ({ t: T + i * H, delta: 0, open: 0, high, low: lows[i]!, close: 0, run: runs[i]! }));

test('a swing stands beyond the k candles before it and level with or beyond the k after, all closed', () => {
  const v = [1, 2, 5, 3, 2, 4, 6, 4, 3];
  assert.deepEqual(pivots(v, 2, true, v.length - 1), [2, 6]);
  assert.deepEqual(pivots(v, 2, true, 7), [2], 'the newest needs k closed candles after it');
  assert.deepEqual(pivots([1, 5, 5, 1, 0], 1, true, 4), [1], 'of two level highs, the first is the swing');
  assert.deepEqual(pivots(v, 2, false, v.length - 1), [4]);
});

test('a higher high in price with a lower CVD high is the sellers\' divergence; a lower low with a higher CVD low the buyers\'', () => {
  const now = T + 20 * H;
  //               0  1  2   3  4  5  6   7  8
  const price = bars([1, 2, 10, 3, 2, 4, 12, 4, 3]);
  const bear = divergences(price, cvd([0, 1, 50, 2, 1, 2, 40, 2, 1]), H, now, 2);
  assert.deepEqual(bear.map(d => [d.kind, d.from, d.to, d.priceFrom, d.priceTo, d.cvdFrom, d.cvdTo]), [['bear', T + 2 * H, T + 6 * H, 10, 12, 50, 40]]);
  assert.deepEqual(divergences(price, cvd([0, 1, 50, 2, 1, 2, 60, 2, 1]), H, now, 2), [], 'both higher: no divergence');
  const lows = [10, 9, 2, 8, 9, 7, 1, 7, 8];
  const bull = divergences(bars(lows.map(l => l + 20), lows), cvd(lows.map(() => 100), [5, 4, -30, 3, 4, 2, -20, 2, 3]), H, now, 2);
  assert.deepEqual(bull.map(d => [d.kind, d.priceFrom, d.priceTo, d.cvdFrom, d.cvdTo]), [['bull', 2, 1, -30, -20]]);
});

test('no divergence across a restart of the CVD, from an open candle, or past the CVD\'s candles', () => {
  const price = bars([1, 2, 10, 3, 2, 4, 12, 4, 3]), highs = [0, 1, 50, 2, 1, 2, 40, 2, 1];
  assert.deepEqual(divergences(price, cvd(highs, undefined, [0, 0, 0, 0, 1, 1, 1, 1, 1]), H, T + 20 * H, 2), [], 'the CVD restarted between the swings');
  assert.deepEqual(divergences(price, cvd(highs), H, T + 8 * H + 1, 2), [], 'the candle after the newer swing\'s second is still open');
  assert.equal(divergences(price, cvd(highs), H, T + 9 * H, 2).length, 1, 'closed: it counts');
  assert.deepEqual(divergences(price, cvd(highs).filter(c => c.t !== T + 6 * H), H, T + 20 * H, 2), [], 'no CVD at a swing (nothing recorded then)');
});

test('the newest few that reach into the window', () => {
  const list = [1, 2, 3, 4, 5, 6, 7, 8].map(n => ({ kind: 'bear' as const, from: n * 10, to: n * 10 + 5, priceFrom: 0, priceTo: 0, cvdFrom: 0, cvdTo: 0 }));
  assert.deepEqual(inView(list, 0, 1_000).map(d => d.from), [30, 40, 50, 60, 70, 80]);
  assert.deepEqual(inView(list, 42, 61).map(d => d.from), [40, 50, 60]);
});
