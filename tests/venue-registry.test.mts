import test from 'node:test';
import assert from 'node:assert/strict';
import { VENUE_REGISTRY, getVenue as lookupVenue, getVenueCapability, venueRegistrySnapshot } from '../src/domain/venue-registry.mts';
import { createLocalServer } from '../src/server/http.mts';
import { QuotaLedger } from '../src/core/quota.mts';
import { HistoryStore } from '../src/server/history.mts';

function requireVenue(name: string) { const venue = lookupVenue(name); assert.ok(venue, `Missing registry venue ${name}`); return venue; }

test('venue registry exposes unique venues and explicit capability states', () => {
  const ids = VENUE_REGISTRY.map((entry) => entry.venue);
  assert.equal(new Set(ids).size, ids.length);
  for (const entry of VENUE_REGISTRY) {
    assert.ok(['supported', 'unsupported', 'externallyBlocked'].includes(entry.status));
    for (const capability of Object.values(entry.capabilities)) assert.ok(['supported', 'unsupported', 'externallyBlocked'].includes(capability.state));
    for (const key of ['candles', 'candleHistory', 'openInterest', 'openInterestHistory'] as const) assert.ok(entry.capabilities[key], `${entry.venue} must declare ${key}`);
    assert.ok(['public-backfill', 'local-observed', 'current-only', 'none', 'external'].includes(entry.capabilities.candleHistory.coverage || ''));
    assert.ok(['public-backfill', 'local-observed', 'current-only', 'none', 'external'].includes(entry.capabilities.openInterestHistory.coverage || ''));
  }
});

test('HL, Binance, Bybit, OKX, Bitget, Gate.io, Deribit, Coinbase, Kraken, KuCoin, MEXC, HTX, Bitfinex, BitMEX, Crypto.com, Bitstamp, WhiteBIT, and Phemex expose shipped public L2 entries in this slice', () => {
  assert.equal(requireVenue('hyperliquid').status, 'supported');
  assert.equal(requireVenue('binance').status, 'supported');
  assert.equal(requireVenue('hyperliquid').capabilities.l2.state, 'supported');
  assert.equal(requireVenue('binance').capabilities.openInterest.state, 'supported');
  assert.equal(requireVenue('hyperliquid').capabilities.candleHistory.coverage, 'public-backfill');
  assert.equal(requireVenue('hyperliquid').capabilities.openInterestHistory.coverage, 'local-observed');
  assert.match((requireVenue('hyperliquid').capabilities.openInterestHistory.reason)!, /historical OI backfill/);
  assert.equal(requireVenue('binance').capabilities.candleHistory.coverage, 'public-backfill');
  assert.equal(requireVenue('binance').capabilities.openInterestHistory.coverage, 'public-backfill');
  assert.match((requireVenue('binance').capabilities.openInterestHistory.limits)!, /5m default.*500-sample startup.*500-row pages.*5,000/);
  assert.deepEqual(requireVenue('binance').capabilities.openInterest.marketTypes, ['perpetual']);
  assert.match((requireVenue('binance').capabilities.openInterest.reason)!, /spot markets do not expose/);
  assert.equal(requireVenue('bybit').capabilities.candleHistory.state, 'unsupported');
  assert.equal(requireVenue('bybit').capabilities.openInterestHistory.coverage, 'none');
  assert.equal(requireVenue('bybit').status, 'supported');
  assert.equal(requireVenue('bybit').capabilities.l2.state, 'supported');
  assert.equal(requireVenue('okx').status, 'supported');
  assert.equal(requireVenue('okx').capabilities.l2.state, 'supported');
  assert.equal(requireVenue('bitget').status, 'supported');
  assert.equal(requireVenue('bitget').capabilities.l2.state, 'supported');
  assert.equal(requireVenue('gateio').status, 'supported');
  assert.equal(requireVenue('gateio').capabilities.l2.state, 'supported');
  assert.equal(requireVenue('deribit').status, 'supported');
  assert.equal(requireVenue('deribit').capabilities.l2.state, 'supported');
  assert.equal(requireVenue('coinbase').status, 'supported');
  assert.equal(requireVenue('coinbase').capabilities.l2.state, 'supported');
  assert.deepEqual(requireVenue('coinbase').capabilities.l2.marketTypes, ['spot']);
  assert.match((requireVenue('coinbase').capabilities.l2.reason)!, /ordered delivery/);
  assert.equal(requireVenue('kraken').status, 'supported');
  assert.deepEqual(requireVenue('kraken').marketTypes, ['spot']);
  assert.equal(requireVenue('kraken').capabilities.l2.state, 'supported');
  assert.deepEqual(requireVenue('kraken').capabilities.l2.marketTypes, ['spot']);
  assert.match((requireVenue('kraken').capabilities.l2.reason)!, /CRC32/);
  assert.equal(requireVenue('kucoin').status, 'supported');
  assert.deepEqual(requireVenue('kucoin').marketTypes, ['spot']);
  assert.equal(requireVenue('kucoin').capabilities.l2.state, 'supported');
  assert.deepEqual(requireVenue('kucoin').capabilities.l2.marketTypes, ['spot']);
  assert.match((requireVenue('kucoin').capabilities.l2.reason)!, /Level-50/);
  assert.equal(requireVenue('mexc').status, 'supported');
  assert.deepEqual(requireVenue('mexc').marketTypes, ['perpetual']);
  assert.equal(requireVenue('mexc').capabilities.l2.state, 'supported');
  assert.deepEqual(requireVenue('mexc').capabilities.l2.marketTypes, ['perpetual']);
  assert.match((requireVenue('mexc').capabilities.l2.reason)!, /full-depth/);
  assert.equal(requireVenue('htx').status, 'supported');
  assert.deepEqual(requireVenue('htx').marketTypes, ['perpetual']);
  assert.equal(requireVenue('htx').capabilities.l2.state, 'supported');
  assert.deepEqual(requireVenue('htx').capabilities.l2.marketTypes, ['perpetual']);
  assert.match((requireVenue('htx').capabilities.l2.reason)!, /depth\.step6/);
  assert.equal(requireVenue('bitfinex').status, 'supported');
  assert.deepEqual(requireVenue('bitfinex').marketTypes, ['spot']);
  assert.equal(requireVenue('bitfinex').capabilities.l2.state, 'supported');
  assert.deepEqual(requireVenue('bitfinex').capabilities.l2.marketTypes, ['spot']);
  assert.match((requireVenue('bitfinex').capabilities.l2.reason)!, /CRC32/);
  assert.equal(requireVenue('bitmex').status, 'supported');
  assert.deepEqual(requireVenue('bitmex').marketTypes, ['perpetual']);
  assert.equal(requireVenue('bitmex').capabilities.l2.state, 'supported');
  assert.deepEqual(requireVenue('bitmex').capabilities.l2.marketTypes, ['perpetual']);
  assert.match((requireVenue('bitmex').capabilities.l2.reason)!, /orderBookL2_25/);
  assert.equal(requireVenue('cryptocom').status, 'supported');
  assert.deepEqual(requireVenue('cryptocom').marketTypes, ['perpetual']);
  assert.equal(requireVenue('cryptocom').capabilities.l2.state, 'supported');
  assert.match((requireVenue('cryptocom').capabilities.l2.reason)!, /book\.10/);
  assert.equal(requireVenue('bitstamp').status, 'supported');
  assert.deepEqual(requireVenue('bitstamp').marketTypes, ['spot']);
  assert.equal(requireVenue('bitstamp').capabilities.l2.state, 'supported');
  assert.match((requireVenue('bitstamp').capabilities.l2.reason)!, /order_book/);
  assert.match((requireVenue('bitstamp').capabilities.products.reason)!, /markets metadata/);
  assert.equal(requireVenue('whitebit').status, 'supported');
  assert.deepEqual(requireVenue('whitebit').marketTypes, ['spot']);
  assert.equal(requireVenue('whitebit').capabilities.l2.state, 'supported');
  assert.match((requireVenue('whitebit').capabilities.l2.reason)!, /depth_subscribe/);
  assert.equal(requireVenue('phemex').status, 'supported');
  assert.deepEqual(requireVenue('phemex').marketTypes, ['spot']);
  assert.equal(requireVenue('phemex').capabilities.l2.state, 'supported');
  assert.deepEqual(requireVenue('phemex').capabilities.l2.marketTypes, ['spot']);
  assert.match((requireVenue('phemex').capabilities.l2.reason)!, /full-depth/);
  assert.equal(requireVenue('dydx').status, 'supported');
  assert.deepEqual(requireVenue('dydx').marketTypes, ['perpetual']);
  assert.equal(requireVenue('dydx').capabilities.products.state, 'supported');
  assert.equal(requireVenue('dydx').capabilities.trades.state, 'supported');
  assert.deepEqual(requireVenue('dydx').capabilities.trades.marketTypes, ['perpetual']);
  assert.equal(requireVenue('dydx').capabilities.l2.state, 'supported');
  assert.match(requireVenue('dydx').capabilities.l2.reason!, /connection-scoped/);
  assert.equal(requireVenue('aster').status, 'supported');
  assert.deepEqual(requireVenue('aster').marketTypes, ['perpetual']);
  assert.equal(requireVenue('aster').capabilities.products.state, 'supported');
  assert.equal(requireVenue('aster').capabilities.trades.state, 'supported');
  assert.deepEqual(requireVenue('aster').capabilities.trades.marketTypes, ['perpetual']);
  assert.equal(requireVenue('aster').capabilities.l2.state, 'supported');
  assert.match(requireVenue('aster').capabilities.l2.reason!, /partial top-20/);
});

test('history capability fallback is fail-closed and preserves explicit future-layer separation', () => {
  assert.deepEqual(getVenueCapability('missing', 'candleHistory'), { state: 'unsupported', coverage: 'none', reason: 'public adapter is not wired and has no live evidence' });
  assert.equal(getVenueCapability('coinbase', 'candleHistory').coverage, 'none');
  assert.equal(getVenueCapability('coinbase', 'openInterestHistory').state, 'unsupported');
  assert.equal(getVenueCapability('hyperliquid', 'executedLiquidations').state, 'unsupported');
  assert.equal(getVenueCapability('hyperliquid', 'liquidationLevels').state, 'externallyBlocked');
});

test('future level distributions remain externally blocked even for shipped venues', () => {
  const futureKeys = ['liquidationLevels', 'stopLossLevels', 'takeProfitLevels'] as const;
  for (const venue of ['hyperliquid', 'binance', 'gateio']) {
    for (const key of futureKeys) assert.equal(getVenueCapability(venue, key).state, 'externallyBlocked');
  }
  // Compatibility summary remains available while callers migrate.
  assert.equal(getVenueCapability('hyperliquid', 'futureLevels').state, 'externallyBlocked');
  assert.match((getVenueCapability('hyperliquid', 'futureLevels').reason)!, /external/);
  assert.equal(getVenueCapability('hyperliquid', 'executedLiquidations').state, 'unsupported');
});

test('registry snapshot is detached for API consumers', () => {
  const snapshot = venueRegistrySnapshot();
  snapshot[0].marketTypes.push('spot');
  (snapshot[0].capabilities.l2.resolutions)!.push('native');
  assert.deepEqual(VENUE_REGISTRY[0].marketTypes, ['perpetual']);
  assert.deepEqual(VENUE_REGISTRY[0].capabilities.l2.resolutions, ['native', 'coarse']);
});
