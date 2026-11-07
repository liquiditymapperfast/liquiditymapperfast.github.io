import test from 'node:test';
import assert from 'node:assert/strict';
import { iconCandle, tabQuote, tabTitle } from '../src/app/tab-title.ts';
import type { CandleRow } from '../src/app/store.ts';

const T = Date.UTC(2026, 10, 7, 1);
const markets = [{ instrumentId: 'binance:BTCUSDT', base: 'BTC', tickSize: 0.1 }];
const candle = (open: number, high: number, low: number, close: number): CandleRow => [T, open, high, low, close, 0];

test('the tab\'s title: the price first, the way the candle under way goes, the coin, then the site\'s short name', () => {
  const up = tabQuote({ mark: { price: 75_903.4, asOf: T }, candles: [candle(75_800, 75_950, 75_700, 75_900)], markets, marketId: 'binance:BTCUSDT', seriesInstrument: 'binance:BTCUSDT' }, 'BTC');
  assert.equal(tabTitle(up, 'LiquidityMapperFast'), '75,903.4 ▲ BTC · LMF');
  assert.deepEqual(up?.candle, { open: 75_800, high: 75_950, low: 75_700, close: 75_903.4 }, 'its close is the price now');
  const down = tabQuote({ mark: { price: 75_650, asOf: T }, candles: [candle(75_800, 75_950, 75_700, 75_700)], markets, marketId: 'binance:BTCUSDT', seriesInstrument: 'binance:BTCUSDT' }, 'BTC');
  assert.equal(tabTitle(down, 'LiquidityMapperFast'), '75,650.0 ▼ BTC · LMF');
  assert.equal(down?.candle?.low, 75_650, 'a price below the candle\'s low is its low now');
  // Another market's candles (a borrowed series) say nothing of this one's candle: the price alone.
  const borrowed = tabQuote({ mark: { price: 75_650, asOf: T }, candles: [candle(1, 2, 0.5, 1.5)], markets, marketId: 'binance:BTCUSDT', seriesInstrument: 'bybit:BTCUSDT' }, 'BTC');
  assert.equal(tabTitle(borrowed, 'LiquidityMapperFast'), '75,650.0 BTC · LMF');
  assert.equal(tabQuote({ mark: { price: 0, asOf: 0 }, candles: [], markets, marketId: 'binance:BTCUSDT', seriesInstrument: '' }, 'BTC'), null, 'no price yet');
  assert.equal(tabTitle(null, 'LiquidityMapperFast'), 'LiquidityMapperFast', 'no price: the page\'s own title, the whole name');
});

test('the icon\'s candle: its colour, a wick from high to low, a body from open to close never thinner than two pixels', () => {
  const up = iconCandle({ open: 100, high: 110, low: 90, close: 108 });
  assert.equal(up.up, true);
  assert.ok(up.wick[0] < up.body[0] && up.body[1] < up.wick[1], 'the wick reaches past the body both ways');
  assert.deepEqual(up.wick, [4, 28], 'a 32-pixel icon keeps a margin of 4');
  const flat = iconCandle({ open: 100, high: 100, low: 100, close: 100 });
  assert.equal(flat.body[1] - flat.body[0], 2);
  const down = iconCandle({ open: 108, high: 110, low: 90, close: 92 });
  assert.equal(down.up, false);
  assert.ok(down.body[1] - down.body[0] > 15);
});
