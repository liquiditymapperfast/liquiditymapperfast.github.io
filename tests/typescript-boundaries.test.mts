import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeMarket } from '../src/core/normalize.mts';

test('normalized market identity is canonical text and rejects malformed wire identity', () => {
  const market = normalizeMarket({ venue: 'binance', nativeSymbol: 'BTCUSDT', base: 'btc', quote: 'usdt', marketType: 'spot' });
  assert.equal(market.id, 'binance:BTCUSDT:spot');
  assert.equal(market.instrumentId, market.id);
  assert.equal(market.base, 'BTC');
  assert.equal(market.quantityUnit, 'base');
  for (const invalid of [
    { venue: 'binance', nativeSymbol: 123 },
    { venue: 'binance', nativeSymbol: 'BTCUSDT', id: 123 },
    { venue: 'binance', nativeSymbol: 'BTCUSDT', marketType: {} },
    { venue: 'binance', nativeSymbol: 'BTCUSDT', quantityUnit: {} },
  ]) assert.throws(() => normalizeMarket(invalid));
});
