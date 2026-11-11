import test from 'node:test';
import assert from 'node:assert/strict';
import { candleHolding, newestCandle, sameButLast, zoomedCandles } from '../src/app/zoomed-candles.ts';
import { priceWindow } from '../src/app/price-history.ts';
import { stripTimeframe } from '../src/app/measures/volume-strip.ts';
import type { CandleRow } from '../src/app/store.ts';

const H = 3_600_000, D = 24 * H;
/** Hourly candles from `from` (ms), `n` of them, each opening where the last closed and moving `step` a candle. */
function hours(from: number, n: number, step = 1, price = 100): CandleRow[] {
  const out: CandleRow[] = [];
  for (let i = 0; i < n; i++) { const o = price + i * step, c = o + step; out.push([from + i * H, o, Math.max(o, c) + 0.5, Math.min(o, c) - 0.5, c, 10]); }
  return out;
}

test('the chart\'s candles added up into longer ones: the first open, the highest high, the lowest low, the last close, the volumes', () => {
  const rows = zoomedCandles(hours(0, 8), H, 4 * H, null, 7.5 * H);
  assert.deepEqual(rows, [[0, 100, 104.5, 99.5, 104, 40], [4 * H, 104, 108.5, 103.5, 108, 40]]);
});

test('a longer candle the chart\'s candles begin inside is the price history\'s, or left out without one', () => {
  // The chart's candles from 02:00: the 00:00-04:00 candle would hold half its time, opening at 02:00's price.
  const drawn = hours(2 * H, 6);
  assert.deepEqual(zoomedCandles(drawn, H, 4 * H, null, 7.5 * H).map(c => c[0]), [4 * H], 'left out where nothing else has it');
  const history = { rows: [[-4 * H, 90, 95, 89, 94, 7], [0, 94, 99, 93, 98, 8]], ms: 4 * H };
  const rows = zoomedCandles(drawn, H, 4 * H, history, 7.5 * H);
  assert.deepEqual(rows.map(c => c[0]), [-4 * H, 0, 4 * H], 'the history\'s whole candle in its place, and the one before it');
  assert.deepEqual(rows[1], [0, 94, 99, 93, 98, 8]);
  assert.equal(rows[2]![1], drawn[2]![1], 'where the chart\'s candles are whole, theirs (live to the minute)');
});

test('a price history finer than the candles drawn is added up too; a coarser one is kept as it is', () => {
  const finer = { rows: hours(-8 * H, 8), ms: H };
  const rows = zoomedCandles(hours(0, 4), H, 4 * H, finer, 3.5 * H);
  assert.deepEqual(rows.map(c => c[0]), [-8 * H, -4 * H, 0]);
  assert.equal(rows[0]![5], 40, 'four of its hours in one');
});

test('in a replay a price-history bar that closes after the moment shown is left out', () => {
  const history = { rows: [[0, 1, 2, 0.5, 1.5, 1], [D, 1.5, 3, 1, 2, 1], [2 * D, 2, 4, 1.5, 3.5, 1]], ms: D };
  assert.deepEqual(zoomedCandles([], H, D, history, 2 * D + 5 * H, 2 * D + 5 * H).map(c => c[0]), [0, D], 'the day under way at the moment is not shown whole');
  assert.deepEqual(zoomedCandles([], H, D, history, 3 * D).map(c => c[0]), [0, D, 2 * D]);
});

test('the newest longer candle again from the chart\'s candles, as a live update makes it', () => {
  const drawn = hours(0, 7);
  assert.deepEqual(newestCandle(drawn, 4 * H), zoomedCandles(drawn, H, 4 * H, null, 6.5 * H).at(-1));
  const moved = drawn.map(c => [...c] as CandleRow); moved[6]![4] = 200; moved[6]![2] = 201;
  assert.equal(newestCandle(moved, 4 * H)[4], 200);
  assert.equal(newestCandle(moved, 4 * H)[2], 201);
});

test('the candle holding a moment, found among longer candles', () => {
  const rows = zoomedCandles(hours(0, 12), H, 4 * H, null, 11.5 * H);
  assert.equal(candleHolding(rows, 4 * H, 5 * H)?.[0], 4 * H);
  assert.equal(candleHolding(rows, 4 * H, 12 * H), undefined);
  assert.equal(candleHolding(rows, 4 * H, -1), undefined);
});

test('the candles drawn are the Volume bars\' length: the shortest at least two pixels wide', () => {
  assert.equal(stripTimeframe(H, 20 * D, 1_500).ms, H, '3.1 px: the chart\'s own');
  assert.equal(stripTimeframe(H, 45 * D, 1_500).ms, 4 * H, '1.4 px an hour: four hours');
  assert.equal(stripTimeframe(H, 400 * D, 1_500).ms, D);
});

test('zoomed out past one read of the chart\'s candles, the price history is read at the length of the candles drawn', () => {
  const NOW = Date.UTC(2026, 10, 11, 12), view = { t0: NOW - 120 * D, t1: NOW };
  // Before: days for the line (a few hundred points across the map).
  assert.equal(priceWindow(view, 1_500, NOW, 0, H)!.tf, '1d');
  // Candles of 4h drawn: the exchange's 4h candles, as many as one read holds.
  const w = priceWindow(view, 1_500, NOW, 0, H, 0, 4 * H)!;
  assert.equal(w.tf, '4h');
  assert.ok(w.to - w.from <= 2_000 * 4 * H);
  // One read of the chart's own still wins where it holds the window (the history is then drawn as the chart's candles).
  assert.equal(priceWindow({ t0: NOW - 45 * D, t1: NOW }, 1_500, NOW, 0, H, 0, 4 * H)!.tf, '1h');
  // A length one read cannot hold falls back to the line's choice.
  assert.equal(priceWindow({ t0: NOW - 3_000 * D, t1: NOW }, 1_500, NOW, 0, H, 0, D)!.tf, '1w');
});

test('a longer candle with a hole in the chart\'s candles gives way to the history\'s complete one; with none, it stands as it is', () => {
  // Hourly 00-03 and 05-07 (04:00 missing): the 04-08 candle would open at 05:00 and miss what 04:00 held.
  const drawn = [...hours(0, 4), ...hours(5 * H, 3, 1, 105)];
  const history = { rows: [[0, 100, 104.5, 99.5, 104, 40], [4 * H, 104, 999, 90, 108, 40]], ms: 4 * H };
  const rows = zoomedCandles([...drawn, ...hours(8 * H, 2, 1, 108)], H, 4 * H, history, 9.5 * H);
  assert.deepEqual(rows.find(c => c[0] === 4 * H), [4 * H, 104, 999, 90, 108, 40], 'the history\'s whole candle, not one made of three hours');
  assert.equal(rows.find(c => c[0] === 0)![1], 100, 'where both are whole, the chart\'s');
  const alone = zoomedCandles([...drawn, ...hours(8 * H, 2, 1, 108)], H, 4 * H, null, 9.5 * H);
  assert.deepEqual(alone.find(c => c[0] === 4 * H), [4 * H, 105, 108.5, 104.5, 108, 30], 'no history: the hours there are, added up');
});

test('the candle under way is the chart\'s own, live, even where the history has a bar for it', () => {
  const drawn = hours(0, 6);   // 00-05: the 04-08 candle under way holds two hours
  const history = { rows: [[0, 1, 2, 0.5, 1.5, 1], [4 * H, 7, 8, 6, 7.5, 1]], ms: 4 * H };
  const rows = zoomedCandles(drawn, H, 4 * H, history, 5.5 * H);
  assert.deepEqual(rows.at(-1), [4 * H, 104, 106.5, 103.5, 106, 20]);
});

test('the candle under way is told by the clock: the chart\'s newest, closed hours ago, gives way to the history\'s complete one (Sol)', () => {
  // The chart's hourly candles end at 05:00 (a quiet market, a feed that stopped, a replay past them); it is 12:00.
  const drawn = hours(0, 6), history = { rows: [[0, 100, 104.5, 99.5, 104, 40], [4 * H, 104, 999, 90, 108, 40], [8 * H, 108, 110, 107, 109, 40]], ms: 4 * H };
  assert.deepEqual(zoomedCandles(drawn, H, 4 * H, history, 12 * H).find(c => c[0] === 4 * H), [4 * H, 104, 999, 90, 108, 40], 'live, the feed quiet since 05:00');
  assert.deepEqual(zoomedCandles(drawn, H, 4 * H, history, 12 * H, 12 * H).find(c => c[0] === 4 * H), [4 * H, 104, 999, 90, 108, 40], 'in a replay at 12:00');
  assert.deepEqual(zoomedCandles(drawn, H, 4 * H, history, 5.5 * H).find(c => c[0] === 4 * H), [4 * H, 104, 106.5, 103.5, 106, 20], 'at 05:30 it is under way: the chart\'s, live');
});

test('a live update is the same rows but the last; a refresh that put new rows at the same times is not', () => {
  const a = hours(0, 8), live = [...a.slice(0, -1), [7 * H, 107, 120, 106, 119, 10] as CandleRow];
  assert.equal(sameButLast(a, live), true);
  const refreshed = a.map(c => [...c] as CandleRow); refreshed[2]![2] = 999;
  assert.equal(sameButLast(a, refreshed), false, 'same length and the same first and last times, new rows: made again');
  assert.equal(sameButLast(a, [...a, ...hours(8 * H, 1)]), false, 'a new candle');
});
