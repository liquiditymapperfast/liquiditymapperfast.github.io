import test from 'node:test';
import assert from 'node:assert/strict';
import { publicMarketFeedOptions } from '../src/server/public-market-selection.mts';
import { discoverPublicProducts } from '../src/server/product-discovery.mts';
import { createLocalServer } from '../src/server/http.mts';
import { HistoryStore } from '../src/server/history.mts';
import { QuotaLedger } from '../src/core/quota.mts';
import { MockHyperTrackerClient } from '../src/adapters/hypertracker-mock.mts';
import type { RuntimeMarket } from '../src/domain/runtime-state.mts';

const MiB = 1024 * 1024;
function selected(quote: string = 'USDT'): RuntimeMarket {
  return { venue: 'binance', discoveryFamily: 'spot', nativeSymbol: 'ETH' + String(quote), instrumentId: 'binance:ETH' + String(quote) + ':spot',
    base: 'ETH', quote, marketType: 'spot', isDelisted: false };
}
async function catalog(app: ReturnType<typeof createLocalServer>, select: (product: RuntimeMarket) => Promise<void> = async () => {}) {
  app.setPublicMarketControls({ discover: (selection, onRetention) => discoverPublicProducts({ ...selection, onRetention,
    limits: { maxBytesPerPage: 16 * 1024, maxTotalBytes: 32 * 1024 }, request: async descriptor => {
      assert.match(descriptor.url, /exchangeInfo/);
      return new Response(JSON.stringify({ symbols: ['BTC', 'EUR', 'USDT'].map(quote => ({ symbol: 'ETH' + quote,
        baseAsset: 'ETH', quoteAsset: quote, status: 'TRADING', isSpotTradingAllowed: true,
        filters: [{ filterType: 'PRICE_FILTER', tickSize: '0.00000001' }, { filterType: 'LOT_SIZE', stepSize: '0.0001' }] })) }));
    } }), select });
  const result = await app.discoverPublicProducts('binance', 'spot');
  assert.equal(result.ok, true, result.error);
  assert.equal(result.products, 3, 'valid non-stable native identities stay discoverable');
  for (const quote of ['BTC', 'EUR', 'USDT']) assert.ok(app.state.markets.some(product => product.instrumentId === 'binance:ETH' + quote + ':spot'));
}
function selectedState(app: ReturnType<typeof createLocalServer>) {
  return JSON.stringify({ markInstrumentId: app.state.markInstrumentId, markPrice: app.state.markPrice, markObserved: app.state.markObserved,
    markSessionId: app.state.markSessionId, markContinuity: app.state.markContinuity, markSequence: app.state.markSequence,
    layers: app.state.layers, layerMeta: app.state.layerMeta, markets: app.state.markets });
}
async function activate(origin: string, instrumentId: string) {
  return fetch(origin + '/api/market-selection', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ instrumentId }) });
}

test('native non-stable quote activation fails closed even when USD conversion labels are supplied', () => {
  for (const quote of ['BTC', 'ETH', 'EUR', 'JPY', '', null, undefined, true, 1, ['USD']]) {
    assert.throws(() => publicMarketFeedOptions({ ...selected(), quote, quoteNormalized: 'USD', quoteToUsd: 1, quoteUsdRate: 1 } as unknown as RuntimeMarket),
      /quote.*activation.*unsupported.*USD.*basis/i, 'native quote must define the coordinate basis');
  }
});

test('existing USD and stable-quote coordinate families preserve exact native selection and default peers', () => {
  for (const quote of ['USD', 'USDT', 'USDC', 'BUSD', 'FDUSD', 'DAI']) {
    const options = publicMarketFeedOptions(selected(quote), { asterEnabled: true, candleInterval: '1m' });
    assert.equal(options.coin, 'ETH'); assert.equal(options.binanceSymbol, 'ETH' + quote); assert.equal(options.binanceMarketType, 'spot');
    assert.equal(options.binanceFamily, 'usdm'); assert.equal(options.asterEnabled, true); assert.equal(options.candleInterval, '1m');
  }
});
test('discovery validation preserves native non-stable quotes without weakening active identity or family checks', () => {
  const product = selected('BTC');
  assert.equal(publicMarketFeedOptions(product, {}, { context: 'discovery' }).binanceSymbol, 'ETHBTC');
  for (const patch of [{ instrumentId: 'binance:ETHUSDT:spot' }, { isDelisted: true }, { marketType: 'perpetual' }, { discoveryFamily: 'options' }])
    assert.throws(() => publicMarketFeedOptions({ ...product, ...patch }, {}, { context: 'discovery' }), /identity|native metadata|family|unsupported/i);
  assert.throws(() => publicMarketFeedOptions(product), /quote.*activation.*unsupported.*USD.*basis/i);
});