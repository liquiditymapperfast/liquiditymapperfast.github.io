import test from 'node:test';
import assert from 'node:assert/strict';
import { publicMarketFeedOptions } from '../src/server/public-market-selection.mts';
import { createLocalServer } from '../src/server/http.mts';
import { discoverPublicProducts } from '../src/server/product-discovery.mts';
import { HistoryStore } from '../src/server/history.mts';
import { QuotaLedger } from '../src/core/quota.mts';
import type { RuntimeMarket } from '../src/domain/runtime-state.mts';
import type { LiveFeedStartOptions } from '../src/server/live-feeds.mts';
import { defined, fields } from './server-test-helpers.mts';

const MiB = 1024 * 1024;
const spotResponse = { retCode: 0, result: { category: 'spot', list: [{ symbol: 'BTCUSDT', baseCoin: 'BTC', quoteCoin: 'USDT', status: 'Trading',
  priceFilter: { tickSize: '0.01' }, lotSizeFilter: { basePrecision: '0.000001', quotePrecision: '0.01', minOrderQty: '0.000001', minOrderAmt: '1' } }] } };
function memory() { return { rssBytes: 64 * MiB, heapUsedBytes: 8 * MiB, heapTotalBytes: 16 * MiB, externalBytes: 0, arrayBuffersBytes: 0 }; }
function product(venue: string, family: string, native: string, id: string, marketType = 'perpetual'): RuntimeMarket {
  return { venue, discoveryFamily: family, nativeSymbol: native, instrumentId: id, base: 'BTC', quote: 'USDT', marketType, isDelisted: false };
}

test('verified public families keep native IDs distinct and preserve configured same-asset optional streams', () => {
  const cases: readonly [RuntimeMarket, keyof LiveFeedStartOptions, unknown][] = [
    [product('hyperliquid', 'base-perpetual', 'BTC', 'hyperliquid:BTC-PERP'), 'coin', 'BTC'],
    [{ ...product('hyperliquid', 'base-perpetual', 'kBONK', 'hyperliquid:KBONK-PERP'), base: 'kBONK' }, 'hlNativeCoin', 'kBONK'],
    [product('binance', 'coinm', 'BTCUSD_PERP', 'binance:BTCUSD_PERP'), 'binanceFamily', 'coinm'],
    [product('binance', 'spot', 'BTCUSDT', 'binance:BTCUSDT:spot', 'spot'), 'binanceMarketType', 'spot'],
    [product('bybit', 'spot', 'BTCUSDT', 'bybit:BTCUSDT:spot', 'spot'), 'bybitCategory', 'spot'],
    [product('bybit', 'inverse', 'BTCUSD', 'bybit:BTCUSD'), 'bybitCategory', 'inverse'],
    [product('okx', 'spot', 'BTC-USDT', 'okx:BTC-USDT', 'spot'), 'okxMarketType', 'spot'],
    [product('bitget', 'spot', 'BTCUSDT', 'bitget:BTCUSDT:spot', 'spot'), 'bitgetMarketType', 'spot'],
  ];
  for (const [input, key, expected] of cases) {
    const options = publicMarketFeedOptions(input, { asterEnabled: true, phemexEnabled: true, gateioEnabled: true, candleInterval: '1m' });
    assert.equal(options[key], expected); assert.equal(options.asterEnabled, true); assert.equal(options.phemexEnabled, true); assert.equal(options.gateioEnabled, true);
    assert.equal(options.candleInterval, '1m'); assert.equal(options.coin, String(input.base).toUpperCase());
  }
});

test('selection refuses family collisions, inactive or unsupported products before runtime activation', () => {
  const valid = product('bybit', 'spot', 'BTCUSDT', 'bybit:BTCUSDT:spot', 'spot');
  for (const patch of [{ instrumentId: 'bybit:BTCUSDT' }, { marketType: 'perpetual' }, { isDelisted: true }, { venue: 'coinbase' }, { discoveryFamily: 'options' }, { base: '../BTC' }])
    assert.throws(() => publicMarketFeedOptions({ ...valid, ...patch }), /public product|public product discovery|identity|family/i);
});
