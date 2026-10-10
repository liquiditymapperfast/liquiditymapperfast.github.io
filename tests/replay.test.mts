import test from 'node:test';
import assert from 'node:assert/strict';
import { candlesAt, caughtUp, formingCandle, pageNow, pauseReplay, playReplay, replaying, setReplaySpeed, startReplay, stopReplay, useClocks } from '../src/app/replay/clock.ts';
import { initialState } from '../src/app/store.ts';
import type { CandleRow } from '../src/app/store.ts';

const MIN = 60_000, T = Date.UTC(2026, 9, 9, 12);

test('the replay clock: runs at its speed, holds while paused, keeps its moment across a speed change, never passes real time', () => {
  let perf = 0, real = T + 3_600_000;
  useClocks(() => perf, () => real);
  assert.equal(pageNow(), real, 'not replaying: the real time');
  startReplay(T, 60);
  assert.equal(replaying(), true);
  perf += 1_000; assert.equal(pageNow(), T + 60_000, 'a second at 60x is a minute');
  pauseReplay(); perf += 5_000; assert.equal(pageNow(), T + 60_000, 'paused');
  playReplay(); perf += 1_000; assert.equal(pageNow(), T + 120_000);
  setReplaySpeed(10); assert.equal(pageNow(), T + 120_000, 'no jump at a new speed');
  perf += 1_000; assert.equal(pageNow(), T + 130_000);
  setReplaySpeed(300); perf += 60_000; assert.equal(pageNow(), real, 'caught up: real time, no further');
  assert.equal(caughtUp(), true);
  stopReplay(); assert.equal(replaying(), false); assert.equal(pageNow(), real);
  useClocks(() => performance.now(), () => Date.now());
});

test('the candle under way, rebuilt from a price a second: open at its start, close now, extremes in between', () => {
  const prices = new Map<number, number>([[T / 1000, 100], [T / 1000 + 10, 104], [T / 1000 + 20, 98], [T / 1000 + 29, 101]]);
  const track = { priceAt: (s: number) => { let p = NaN; for (const [k, v] of prices) if (k <= s) p = v; return p; } };
  assert.deepEqual(formingCandle(track, T, T + 30_000), [T, 100, 104, 98, 101, 0]);
  assert.equal(formingCandle({ priceAt: () => NaN }, T, T + 30_000), null, 'no prices: none');
  assert.equal(formingCandle(track, T, T), null, 'not begun');
});

test('the candles at a moment: the closed ones, the one under way rebuilt, nothing after', () => {
  const c = (t: number): CandleRow => [t, 1, 2, 0.5, 1.5, 9];
  const all = [c(T - 2 * MIN), c(T - MIN), c(T), c(T + MIN)], forming: CandleRow = [T, 1, 1.2, 0.9, 1.1, 0];
  assert.deepEqual(candlesAt(all, MIN, T + 30_000, forming).map(x => x[0]), [T - 2 * MIN, T - MIN, T]);
  assert.equal(candlesAt(all, MIN, T + 30_000, forming)[2], forming);
  assert.deepEqual(candlesAt(all, MIN, T + 30_000, null).map(x => x[0]), [T - 2 * MIN, T - MIN], 'not rebuilt: left out');
  assert.deepEqual(candlesAt(all, MIN, T + MIN, [T + MIN, 1, 1, 1, 1, 0]).map(x => x[0]), [T - 2 * MIN, T - MIN, T], 'one closed exactly at the moment is kept whole; one opening then has not begun');
});

test('a page always opens live: a saved replay is never restored', () => {
  const g = globalThis as unknown as { window?: unknown };
  const had = g.window;
  g.window = { innerWidth: 1920, localStorage: { getItem: () => JSON.stringify({ replay: { from: T, speed: 60, playing: true }, timeframe: '5m' }) } };
  try { const s = initialState(); assert.equal(s.replay, null); assert.equal(s.timeframe, '5m'); }
  finally { g.window = had; }
});
