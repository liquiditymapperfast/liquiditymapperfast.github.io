import test from 'node:test';
import assert from 'node:assert/strict';
import { publicMarketFeedOptions, assertPublicMarketFeedSelection } from '../src/server/public-market-selection.mts';
import { liveFeedConfiguration, rebaseLiveFeedConfiguration } from '../src/server/live-feed-config.mts';
import { LiveFeedManager } from '../src/server/live-feeds.mts';
import { buildHyperliquidSubscription } from '../src/adapters/hyperliquid.mts';
import type { RuntimeMarket } from '../src/domain/runtime-state.mts';

function product(venue = 'hyperliquid', family = 'base-perpetual', native = 'ETH', instrumentId = 'hyperliquid:ETH-PERP', marketType = 'perpetual', quote = 'USDT'): RuntimeMarket {
  return { venue, discoveryFamily: family, nativeSymbol: native, instrumentId, base: 'ETH', quote, marketType, isDelisted: false };
}
test('choosing a new verified asset keeps default major4 requested on that same asset', () => {
  for (const selected of [product(), product('binance', 'usdm', 'ETHUSDT', 'binance:ETHUSDT'),
    product('bybit', 'linear', 'ETHUSDT', 'bybit:ETHUSDT'), product('okx', 'swap', 'ETH-USDT-SWAP', 'okx:ETH-USDT-SWAP')]) {
    const options = publicMarketFeedOptions(selected);
    assert.equal(options.coin, 'ETH'); assert.equal(options.binanceSymbol, 'ETHUSDT');
    assert.equal(options.bybitEnabled, true); assert.equal(options.bybitSymbol, 'ETHUSDT');
    assert.equal(options.okxEnabled, true); assert.equal(options.okxSymbol, 'ETH-USDT-SWAP');
  }
});
test('market switching retains and rebases every configured optional peer with no source option mutation', () => {
  const baseline = Object.freeze({ ...liveFeedConfiguration({}), coin: 'BTC', hlNativeCoin: 'BTC', gateioEnabled: true, deribitEnabled: true,
    coinbaseEnabled: true, krakenEnabled: true, kucoinEnabled: true, mexcEnabled: true, htxEnabled: true, bitfinexEnabled: true, bitmexEnabled: true,
    cryptocomEnabled: true, bitstampEnabled: true, whitebitEnabled: true, phemexEnabled: true, dydxEnabled: true, asterEnabled: true, bitgetEnabled: true });
  const before = JSON.stringify(baseline), options = publicMarketFeedOptions(product(), baseline);
  for (const venue of ['bybit', 'okx', 'bitget', 'gateio', 'deribit', 'coinbase', 'kraken', 'kucoin', 'mexc', 'htx', 'bitfinex', 'bitmex', 'cryptocom', 'bitstamp', 'whitebit', 'phemex', 'dydx', 'aster'] as const)
    assert.equal(options[`${venue}Enabled`], true, venue);
  assert.equal(options.gateioSymbol, 'ETH_USDT'); assert.equal(options.deribitSymbol, 'ETH-PERPETUAL');
  assert.equal(options.bitmexSymbol, 'ETHUSD'); assert.equal(options.phemexSymbol, 'sETHUSDT');
  assert.equal(options.hlNativeCoin, 'ETH'); assert.equal(JSON.stringify(baseline), before);
});
test('explicit disabled peers stay disabled except an explicitly selected verified venue', () => {
  const baseline = liveFeedConfiguration({ BYBIT_ENABLED: 'false', OKX_ENABLED: 'false', BITGET_ENABLED: 'false' });
  const native = publicMarketFeedOptions(product(), baseline);
  assert.equal(native.bybitEnabled, false); assert.equal(native.okxEnabled, false); assert.equal(native.bitgetEnabled, false);
  const selected = publicMarketFeedOptions(product('bybit', 'spot', 'ETHUSDC', 'bybit:ETHUSDC:spot', 'spot', 'USDC'), baseline);
  assert.equal(selected.bybitEnabled, true); assert.equal(selected.bybitSymbol, 'ETHUSDC'); assert.equal(selected.bybitCategory, 'spot');
  assert.equal(selected.okxEnabled, false); assert.equal(selected.bitgetEnabled, false);
});
test('public family and stable native quote preferences survive compatible peer rebasing', () => {
  const options = publicMarketFeedOptions(product(), { binanceFamily: 'coinm', binanceSymbol: 'BTCUSD_PERP', bybitCategory: 'inverse', bybitSymbol: 'BTCUSD',
    okxMarketType: 'spot', okxSymbol: 'BTC-USDC', bitgetEnabled: true, bitgetMarketType: 'spot', bitgetSymbol: 'BTCUSDC', coinbaseEnabled: true, coinbaseSymbol: 'BTC-USDC' });
  assert.equal(options.binanceFamily, 'coinm'); assert.equal(options.binanceSymbol, 'ETHUSD_PERP');
  assert.equal(options.bybitCategory, 'inverse'); assert.equal(options.bybitSymbol, 'ETHUSD');
  assert.equal(options.okxMarketType, 'spot'); assert.equal(options.okxSymbol, 'ETH-USDC');
  assert.equal(options.bitgetMarketType, 'spot'); assert.equal(options.bitgetSymbol, 'ETHUSDC'); assert.equal(options.coinbaseSymbol, 'ETH-USDC');
});
test('verified selected product wins over peer family defaults without disabling other peers', () => {
  const options = publicMarketFeedOptions(product('binance', 'spot', 'ETHFDUSD', 'binance:ETHFDUSD:spot', 'spot', 'FDUSD'),
    { binanceFamily: 'coinm', binanceSymbol: 'BTCUSD_PERP', bybitCategory: 'inverse', bybitSymbol: 'BTCUSD', okxEnabled: true });
  assert.equal(options.binanceSymbol, 'ETHFDUSD'); assert.equal(options.binanceFamily, 'usdm'); assert.equal(options.binanceMarketType, 'spot');
  assert.equal(options.bybitSymbol, 'ETHUSD'); assert.equal(options.bybitCategory, 'inverse'); assert.equal(options.okxEnabled, true);
});
test('selection retains existing bounded grouping and candle controls by identity', () => {
  const resolutions = [{ nSigFigs: 5, mantissa: 1 }];
  const options = publicMarketFeedOptions(product(), { hlBookResolutions: resolutions, hlBookNsigFigs: 5, hlBookMantissa: 1, candleInterval: '5m' });
  assert.equal(options.hlBookResolutions, resolutions); assert.equal(options.hlBookNsigFigs, 5); assert.equal(options.hlBookMantissa, 1); assert.equal(options.candleInterval, '5m');
});
test('rebasing resolves native BTC aliases and never keeps an obsolete/nonstable peer asset', () => {
  const btc = rebaseLiveFeedConfiguration('BTC', { coin: 'ETH', bitmexEnabled: true, bitmexSymbol: 'ETHUSD', phemexEnabled: true, phemexSymbol: 'sETHUSDC',
    krakenEnabled: true, krakenSymbol: 'ETH/USD', bitfinexEnabled: true, bitfinexSymbol: 'tETHUSD', coinbaseEnabled: true, coinbaseSymbol: 'ETH-EUR' });
  assert.equal(btc.bitmexSymbol, 'XBTUSD'); assert.equal(btc.phemexSymbol, 'sBTCUSDC'); assert.equal(btc.krakenSymbol, 'BTC/USD');
  assert.equal(btc.bitfinexSymbol, 'BTCUSD'); assert.equal(btc.coinbaseSymbol, 'BTC-USD');
});
test('verified native Hyperliquid case survives; an obsolete native API coin is removed from rebased peers', () => {
  const selected = { ...product(), nativeSymbol: 'kBONK', base: 'kBONK', instrumentId: 'hyperliquid:KBONK-PERP' };
  assert.equal(publicMarketFeedOptions(selected).hlNativeCoin, 'kBONK');
  const options = publicMarketFeedOptions(product('okx', 'swap', 'ETH-USDT-SWAP', 'okx:ETH-USDT-SWAP'), { coin: 'BTC', hlNativeCoin: 'BTC' });
  assert.equal(options.hlNativeCoin, undefined); assert.equal(options.coin, 'ETH');
});
test('persistent venue configuration does not weaken native quote, active identity or family gates', () => {
  const valid = product('bybit', 'spot', 'ETHUSDT', 'bybit:ETHUSDT:spot', 'spot');
  for (const patch of [{ instrumentId: 'bybit:ETHUSDT' }, { marketType: 'perpetual' }, { isDelisted: true }, { discoveryFamily: 'options' }, { base: '../ETH' }, { venue: 'coinbase' }])
    assert.throws(() => publicMarketFeedOptions({ ...valid, ...patch }), /public product|public product discovery|identity|family/i);
  for (const quote of ['BTC', 'EUR', '', undefined, 1]) assert.throws(() => publicMarketFeedOptions({ ...valid, quote } as RuntimeMarket), /quote.*activation.*unsupported/i);
});

const optionalProduct = () => product('bybit', 'linear', 'ETHUSDT', 'bybit:ETHUSDT');
const nativeDepth = { venue: 'bybit', channel: 'depth', instrumentId: 'bybit:ETHUSDT' };
const hlReference = { venue: 'hyperliquid', channel: 'candle', instrumentId: 'hyperliquid:ETH-PERP' };

test('zero and excluding masks accept optional asset selection through actual same-base HL reference without expanding the mask', () => {
  for (const mask of [[], ['binance', 'okx']]) {
    const frozen = Object.freeze([...mask]);
    const options = { ...publicMarketFeedOptions(optionalProduct()), selectedOrderbookVenues: frozen };
    assert.equal(assertPublicMarketFeedSelection(optionalProduct(), options, [hlReference]), 'hyperliquid-reference');
    assert.equal(options.selectedOrderbookVenues, frozen); assert.deepEqual(options.selectedOrderbookVenues, mask);
  }
});
test('including and legacy masks require the exact selected native venue/instrument spec', () => {
  for (const options of [publicMarketFeedOptions(optionalProduct()), { ...publicMarketFeedOptions(optionalProduct()), selectedOrderbookVenues: ['bybit'] }]) {
    assert.equal(assertPublicMarketFeedSelection(optionalProduct(), options, [nativeDepth, hlReference]), 'selected-native');
    assert.throws(() => assertPublicMarketFeedSelection(optionalProduct(), options, [hlReference]), /configured native feed/);
    assert.throws(() => assertPublicMarketFeedSelection(optionalProduct(), options,
      [{ ...nativeDepth, instrumentId: 'bybit:BTCUSDT' }, hlReference]), /configured native feed/);
  }
});
test('excluded optional selection refuses absent, wrong-base, and depth-only HL references', () => {
  const options = { ...publicMarketFeedOptions(optionalProduct()), selectedOrderbookVenues: [] };
  for (const specs of [[], [{ ...hlReference, instrumentId: 'hyperliquid:BTC-PERP' }],
    [{ ...hlReference, channel: 'l2Book' }], [{ ...hlReference, venue: 'binance' }]])
    assert.throws(() => assertPublicMarketFeedSelection(optionalProduct(), options, specs), /same-base Hyperliquid reference/);
});
test('actual activeAssetCtx request can prove the same-base reference without an instrumentId', () => {
  const options = { ...publicMarketFeedOptions(optionalProduct()), selectedOrderbookVenues: [] };
  const reference = { venue: 'hyperliquid', channel: 'activeAssetCtx', request: buildHyperliquidSubscription('activeAssetCtx', { coin: 'ETH' }) };
  assert.equal(assertPublicMarketFeedSelection(optionalProduct(), options, [reference]), 'hyperliquid-reference');
  assert.throws(() => assertPublicMarketFeedSelection(optionalProduct(), options,
    [{ ...reference, request: buildHyperliquidSubscription('activeAssetCtx', { coin: 'BTC' }) }]), /same-base Hyperliquid reference/);
  assert.throws(() => assertPublicMarketFeedSelection(optionalProduct(), options,
    [{ ...reference, request: buildHyperliquidSubscription('trades', { coin: 'ETH' }) }]), /same-base Hyperliquid reference/);
});
test('Hyperliquid and Binance native reference channels satisfy their own zero-ladder selections', () => {
  assert.equal(assertPublicMarketFeedSelection(product(), { ...publicMarketFeedOptions(product()), selectedOrderbookVenues: [] }, [hlReference]), 'selected-native');
  const binance = product('binance', 'spot', 'ETHUSDT', 'binance:ETHUSDT:spot', 'spot');
  const options = { ...publicMarketFeedOptions(binance), selectedOrderbookVenues: [] };
  assert.equal(assertPublicMarketFeedSelection(binance, options, [{ venue: 'binance', channel: 'kline', instrumentId: 'binance:ETHUSDT:spot' }]), 'selected-native');
  assert.throws(() => assertPublicMarketFeedSelection(binance, options, [hlReference]), /neither.*native reference/);
});
test('acceptance rejects wrong configured reference asset, inactive metadata and missing legacy feed', () => {
  assert.throws(() => assertPublicMarketFeedSelection(optionalProduct(), { ...publicMarketFeedOptions(optionalProduct()), coin: 'BTC' }, [nativeDepth]), /matching configured reference asset/);
  assert.throws(() => assertPublicMarketFeedSelection({ ...optionalProduct(), isDelisted: true }, publicMarketFeedOptions(optionalProduct()), [nativeDepth]), /active native metadata/);
  assert.throws(() => assertPublicMarketFeedSelection(optionalProduct(), publicMarketFeedOptions(optionalProduct()), []), /configured native feed/);
});
test('reference request proof never invokes unsafe getters or accepts contradictory explicit IDs', () => {
  let reads = 0;
  const unsafe = Object.defineProperty({}, 'subscription', { get() { reads++; throw new Error('getter'); } });
  const options = { ...publicMarketFeedOptions(optionalProduct()), selectedOrderbookVenues: [] };
  assert.throws(() => assertPublicMarketFeedSelection(optionalProduct(), options,
    [{ venue: 'hyperliquid', channel: 'activeAssetCtx', request: unsafe }]), /same-base Hyperliquid reference/);
  assert.equal(reads, 0);
  assert.throws(() => assertPublicMarketFeedSelection(optionalProduct(), options,
    [{ ...hlReference, request: buildHyperliquidSubscription('candle', { coin: 'BTC' }) }]), /same-base Hyperliquid reference/);
  assert.throws(() => assertPublicMarketFeedSelection(optionalProduct(), options,
    [{ venue: 'hyperliquid', channel: 'activeAssetCtx', instrumentId: 'hyperliquid:BTC-PERP', request: buildHyperliquidSubscription('activeAssetCtx', { coin: 'ETH' }) }]), /same-base Hyperliquid reference/);
});
test('acceptance validates the bounded exact mask and preserves a genuine eight-venue mask', () => {
  const selected = optionalProduct(), options = publicMarketFeedOptions(selected);
  const eight = Object.freeze(['hyperliquid', 'binance', 'bybit', 'okx', 'bitget', 'gateio', 'coinbase', 'kraken']);
  assert.equal(assertPublicMarketFeedSelection(selected, { ...options, selectedOrderbookVenues: eight }, [nativeDepth]), 'selected-native');
  assert.equal(eight.length, 8);
  for (const mask of [['bybit', 'bybit'], Array.from({ length: 33 }, (_, i) => 'venue' + i)]) assert.throws(() => assertPublicMarketFeedSelection(selected,
    { ...options, selectedOrderbookVenues: mask }, [nativeDepth]), /invalid exact depth mask/);
});

test('actual network-disabled manager accepts asset switching under empty/excluding/including depth masks', async () => {
  const manager = new LiveFeedManager({ networkEnabled: false });
  try {
    for (const mask of [[], ['okx'], ['bybit']]) {
      const selected = optionalProduct(), options = { ...publicMarketFeedOptions(selected), selectedOrderbookVenues: Object.freeze(mask) };
      await manager.start(options);
      assert.equal(manager.specs.has('bybit-depth'), mask.includes('bybit'));
      assert.equal(assertPublicMarketFeedSelection(selected, options, manager.specs.values()),
        mask.includes('bybit') ? 'selected-native' : 'hyperliquid-reference');
      assert.deepEqual(options.selectedOrderbookVenues, mask);
    }
  } finally { manager.stop(); }
});
