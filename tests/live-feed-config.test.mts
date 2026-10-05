import test from 'node:test';
import assert from 'node:assert/strict';
import { liveFeedConfiguration, rebaseLiveFeedConfiguration } from '../src/server/live-feed-config.mts';
import { LiveFeedManager } from '../src/server/live-feeds.mts';

const optional = ['bitget', 'gateio', 'deribit', 'coinbase', 'kraken', 'kucoin', 'mexc', 'htx', 'bitfinex', 'bitmex', 'cryptocom', 'bitstamp', 'whitebit', 'phemex', 'dydx', 'aster'] as const;

test('central public startup activates major4 and leaves all other implemented peers opt-in', () => {
  const configured = liveFeedConfiguration({});
  assert.deepEqual(configured.selectedOrderbookVenues, ['hyperliquid', 'binance', 'bybit', 'okx']);
  assert.ok(Object.isFrozen(configured.selectedOrderbookVenues));
  assert.equal(configured.coin, 'BTC'); assert.equal(configured.binanceSymbol, 'BTCUSDT');
  assert.equal(configured.binanceFamily, 'usdm'); assert.equal(configured.binanceMarketType, 'perpetual');
  assert.equal(configured.bybitEnabled, true); assert.equal(configured.bybitCategory, 'linear'); assert.equal(configured.bybitSymbol, 'BTCUSDT');
  assert.equal(configured.okxEnabled, true); assert.equal(configured.okxMarketType, 'perpetual'); assert.equal(configured.okxSymbol, 'BTC-USDT-SWAP');
  for (const venue of optional) {
    assert.equal(configured[`${venue}Enabled`], false, venue);
    assert.equal(typeof configured[`${venue}Symbol`], 'string', venue);
  }
});
test('explicit required families select their native symbol defaults and preserve caller symbols', () => {
  const configured = liveFeedConfiguration({ BINANCE_FAMILY: 'coinm', BYBIT_CATEGORY: 'inverse', BYBIT_ENABLED: 'true', OKX_MARKET_TYPE: 'spot', OKX_ENABLED: 'true', BITGET_MARKET_TYPE: 'spot', BITGET_ENABLED: 'true' });
  assert.equal(configured.binanceSymbol, 'BTCUSD_PERP'); assert.equal(configured.bybitSymbol, 'BTCUSD');
  assert.equal(configured.okxSymbol, 'BTC-USDT'); assert.equal(configured.bitgetMarketType, 'spot');
  assert.equal(configured.bybitEnabled, true); assert.equal(configured.okxEnabled, true); assert.equal(configured.bitgetEnabled, true);
  assert.equal(liveFeedConfiguration({ BINANCE_FAMILY: 'coinm', BINANCE_DEFAULT_SYMBOL: 'ETHUSD_PERP' }).binanceSymbol, 'ETHUSD_PERP');
  assert.equal(liveFeedConfiguration({ BYBIT_CATEGORY: 'spot' }).bybitSymbol, 'BTCUSDT');
  assert.equal(liveFeedConfiguration({ BINANCE_MARKET_TYPE: 'spot' }).binanceFamily, 'usdm');
});
test('every existing optional manager is centrally enabled with its exact configured native symbol', () => {
  for (const venue of ['bybit', 'okx', ...optional] as const) {
    const name = venue.toUpperCase();
    const native = venue === 'phemex' ? 'sETHUSDT' : 'ETHUSDT';
    const configured = liveFeedConfiguration({ [`${name}_ENABLED`]: 'true', [`${name}_DEFAULT_SYMBOL`]: native });
    assert.equal(configured[`${venue}Enabled`], true, venue); assert.equal(configured[`${venue}Symbol`], native, venue);
  }
});
test('explicit false major flags survive and malformed enable flags fail instead of silently changing subscriptions', () => {
  const configured = liveFeedConfiguration({ BYBIT_ENABLED: ' false ', OKX_ENABLED: 'FALSE', GATEIO_ENABLED: ' TRUE ' });
  assert.equal(configured.bybitEnabled, false); assert.equal(configured.okxEnabled, false); assert.equal(configured.gateioEnabled, true);
  for (const value of ['', '1', 'yes', 'false,true']) assert.throws(() => liveFeedConfiguration({ BYBIT_ENABLED: value }), RangeError);
});
test('unimplemented family selections and incompatible COIN-M spot fail explicitly', () => {
  for (const env of [{ BINANCE_FAMILY: 'linear' }, { BINANCE_FAMILY: 'coinm', BINANCE_MARKET_TYPE: 'spot' },
    { BINANCE_MARKET_TYPE: 'options' }, { BYBIT_CATEGORY: 'option' }, { OKX_MARKET_TYPE: 'delivery' }, { BITGET_MARKET_TYPE: 'margin' }])
    assert.throws(() => liveFeedConfiguration(env), RangeError);
});
test('all default native peer symbols follow startup base instead of leaking BTC into ETH scope', () => {
  const configured = liveFeedConfiguration({ HL_DEFAULT_COIN: 'eth' });
  assert.equal(configured.coin, 'ETH'); assert.equal(configured.binanceSymbol, 'ETHUSDT'); assert.equal(configured.bybitSymbol, 'ETHUSDT');
  assert.equal(configured.okxSymbol, 'ETH-USDT-SWAP'); assert.equal(configured.gateioSymbol, 'ETH_USDT');
  assert.equal(configured.deribitSymbol, 'ETH-PERPETUAL'); assert.equal(configured.coinbaseSymbol, 'ETH-USD');
  assert.equal(configured.krakenSymbol, 'ETH/USD'); assert.equal(configured.kucoinSymbol, 'ETH-USDT');
  assert.equal(configured.mexcSymbol, 'ETH_USDT'); assert.equal(configured.htxSymbol, 'ETH-USDT');
  assert.equal(configured.bitfinexSymbol, 'ETHUSD'); assert.equal(configured.bitmexSymbol, 'ETHUSD');
  assert.equal(configured.cryptocomSymbol, 'ETHUSD-PERP'); assert.equal(configured.bitstampSymbol, 'ethusd');
  assert.equal(configured.whitebitSymbol, 'ETH_USDT'); assert.equal(configured.phemexSymbol, 'sETHUSDT');
  assert.equal(configured.dydxSymbol, 'ETH-USD'); assert.equal(configured.asterSymbol, 'ETHUSDT');
});
test('native Hyperliquid API coin is explicit and must match the canonical selected coin', () => {
  const configured = liveFeedConfiguration({ HL_DEFAULT_COIN: 'KBONK', HL_NATIVE_COIN: 'kBONK' });
  assert.equal(configured.coin, 'KBONK'); assert.equal(configured.hlNativeCoin, 'kBONK');
  assert.throws(() => liveFeedConfiguration({ HL_DEFAULT_COIN: 'BTC', HL_NATIVE_COIN: 'kBONK' }), /native coin does not match/);
  assert.throws(() => liveFeedConfiguration({ HL_DEFAULT_COIN: '../BTC' }), TypeError);
  assert.throws(() => liveFeedConfiguration({ OKX_DEFAULT_SYMBOL: '' }), /Invalid OKX_DEFAULT_SYMBOL/);
});
test('network-disabled managers receive all default depth specs without a provider connection', async () => {
  const manager = new LiveFeedManager({ networkEnabled: false });
  try {
    await manager.start(liveFeedConfiguration({}));
    for (const id of ['hl-l2Book', 'binance-depth', 'bybit-depth', 'okx-depth']) assert.ok(manager.specs.has(id), id);
    assert.equal(manager.specs.has('bitget-depth'), false);
    assert.equal(manager.specs.get('bybit-depth')?.instrumentId, 'bybit:BTCUSDT');
    assert.equal(manager.specs.get('okx-depth')?.instrumentId, 'okx:BTC-USDT-SWAP');
  } finally { manager.stop(); }
});
test('pure rebasing preserves null optional symbol intent and refuses unsupported family configuration', () => {
  assert.equal(rebaseLiveFeedConfiguration('ETH', { krakenEnabled: true, krakenSymbol: null }).krakenSymbol, null);
  assert.equal(rebaseLiveFeedConfiguration('ETH', { bybitEnabled: true, bybitSymbol: null }).bybitSymbol, null);
  assert.throws(() => rebaseLiveFeedConfiguration('ETH', { binanceFamily: 'coinm', binanceMarketType: 'spot' }), RangeError);
});

test('central startup selects every enabled depth venue without truncating', () => {
  const eightFlags = { BITGET_ENABLED: 'true', GATEIO_ENABLED: 'true', DERIBIT_ENABLED: 'true', COINBASE_ENABLED: 'true' };
  const configured = liveFeedConfiguration(eightFlags);
  assert.deepEqual(configured.selectedOrderbookVenues, ['hyperliquid', 'binance', 'bybit', 'okx', 'bitget', 'gateio', 'deribit', 'coinbase']);
  const nine = liveFeedConfiguration({ ...eightFlags, KRAKEN_ENABLED: 'true' });
  assert.equal(nine.selectedOrderbookVenues?.length, 9); assert.equal(nine.selectedOrderbookVenues?.includes('kraken'), true);
  const replacement = liveFeedConfiguration({ ...eightFlags, KRAKEN_ENABLED: 'true', BYBIT_ENABLED: 'false' });
  assert.equal(replacement.selectedOrderbookVenues?.length, 8); assert.equal(replacement.selectedOrderbookVenues?.includes('bybit'), false);
  const rebased = rebaseLiveFeedConfiguration('ETH', configured);
  assert.equal(rebased.selectedOrderbookVenues, configured.selectedOrderbookVenues);
});
