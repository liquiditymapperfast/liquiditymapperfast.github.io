import test from 'node:test';
import assert from 'node:assert/strict';
import { pickOi, weakOi } from '../src/app/oi-source.ts';
import type { OiBar } from '../src/app/store.ts';

const MIN = 60_000, NOW = 100 * 3_600_000;
const bars = (n: number, endAgo = 0, step = MIN): OiBar[] => Array.from({ length: n }, (_, i) => { const t = NOW - endAgo - (n - 1 - i) * step; return [t, 1, 1, 1, 1] as OiBar; });

test('a series is weak with fewer than 30 bars or none in the last few intervals', () => {
  assert.equal(weakOi(bars(3), NOW, MIN), true);
  assert.equal(weakOi(bars(100), NOW, MIN), false);
  assert.equal(weakOi(bars(100, 20 * MIN), NOW, MIN), true, 'newest bar 20 min old at a 1m timeframe');
  assert.equal(weakOi(bars(100, 20 * MIN, 5 * MIN), NOW, 5 * MIN), false, 'five-minute bars tolerate a longer wait (5 x 5 min)');
  assert.equal(weakOi([], NOW, MIN), true);
});

test('the market keeps its own OI while healthy, else the longest series is used', () => {
  const own = { inst: 'okx:BTC', bars: bars(100) }, ref = { inst: 'binance:BTCUSDT', bars: bars(300) };
  assert.equal(pickOi([own, ref], NOW, MIN)!.inst, 'okx:BTC');
  const thin = { inst: 'hyperliquid:BTC-PERP', bars: bars(3) };
  assert.equal(pickOi([thin, ref], NOW, MIN)!.inst, 'binance:BTCUSDT', 'three bars lose to a healthy reference');
  const stale = { inst: 'x', bars: bars(40, 60 * MIN) };
  assert.equal(pickOi([stale, thin], NOW, MIN)!.inst, 'x', 'with no healthy series the longest one wins');
  assert.equal(pickOi([{ inst: 'a', bars: [] }, { inst: 'b', bars: [] }], NOW, MIN)!.inst, 'a', 'all empty keeps the first');
  assert.equal(pickOi([], NOW, MIN), null);
});
