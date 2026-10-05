import test from 'node:test';
import assert from 'node:assert/strict';
import { describeSources, shareInCell, type ColumnStore } from '../src/app/cell-sources.ts';

/** Two one-minute columns on a grid of 10: bins are price / 10. */
const store = (): ColumnStore => ({
  step: 10, times: Float64Array.of(0, 60_000), counts: Uint32Array.of(2, 1),
  bins: Int32Array.of(100, 101, 100), bid: Float32Array.of(5, 0, 8), ask: Float32Array.of(0, 7, 0),
});

test('a cell takes the share of each bin inside its price band and of each column inside its time span', () => {
  const s = store();
  assert.deepEqual(shareInCell(s, 60_000, 0, 60_000, 1000, 1010), { bid: 5, ask: 0 }, 'one whole bin, one whole column');
  assert.deepEqual(shareInCell(s, 60_000, 0, 60_000, 1000, 1005), { bid: 2.5, ask: 0 }, 'half the bin');
  assert.deepEqual(shareInCell(s, 60_000, 0, 120_000, 1000, 1020), { bid: (5 + 8) / 2, ask: 7 / 2 }, 'two minutes average the columns');
  assert.deepEqual(shareInCell(s, 60_000, 30_000, 90_000, 1000, 1010), { bid: 5 / 2 + 8 / 2, ask: 0 }, 'a span across the boundary takes half of each');
  assert.deepEqual(shareInCell(s, 60_000, 0, 60_000, 2000, 2010), { bid: 0, ask: 0 }, 'a band with nothing in it');
  assert.deepEqual(shareInCell(s, 60_000, 0, 120_000, 1000, 1020, 60_000), { bid: 5 / 2, ask: 7 / 2 }, 'columns from the cutoff on are left to the live column');
});

test('the source is a short handle: the venue alone when it dominates, else its share and how many others', () => {
  const shares = [{ id: 'binancespot:BTCUSDT', bid: 95, ask: 10 }, { id: 'bybit:BTCUSDT', bid: 5, ask: 70 }, { id: 'okx:BTC-USDT-SWAP', bid: 0, ask: 20 }];
  assert.equal(describeSources(shares, 'bid'), '@binance-spot', '95 % of the bids');
  assert.equal(describeSources(shares, 'ask'), '@bybit 70% +2', 'a mix: the biggest, its share, the two others');
  assert.equal(describeSources([{ id: 'hyperliquid:BTC-PERP', bid: 3, ask: 0 }], 'bid'), '@hyperliquid');
  assert.equal(describeSources([], 'bid'), '');
  assert.equal(describeSources([{ id: 'okx:BTC-USDT-SWAP', bid: 0, ask: 4 }], 'bid'), '', 'nothing on that side');
});
