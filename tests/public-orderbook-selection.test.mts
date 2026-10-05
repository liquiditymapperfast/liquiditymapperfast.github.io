import test from 'node:test';
import assert from 'node:assert/strict';
import { planPublicOrderbookSelection, publicOrderbookVenueCatalog, PUBLIC_ORDERBOOK_DEFAULT_VENUES, PUBLIC_ORDERBOOK_MAX_SELECTED, PUBLIC_ORDERBOOK_VENUE_IDS } from '../src/server/public-orderbook-selection.mts';
import type { PublicOrderbookSelectionPlan, PublicOrderbookVenueId, PublicOrderbookStreamPlan } from '../src/server/public-orderbook-selection.mts';
import type { RuntimeMarket } from '../src/domain/runtime-state.mts';
import type { LiveFeedStartOptions } from '../src/server/live-feeds.mts';
import { buildHyperliquidSubscription } from '../src/adapters/hyperliquid.mts';
import { buildBinanceSubscription, normalizeBinanceExchangeInfo } from '../src/adapters/binance.mts';
import { buildBybitSubscription, normalizeBybitInstrumentInfo } from '../src/adapters/bybit.mts';
import { buildOkxSubscription, normalizeOkxInstrumentInfo } from '../src/adapters/okx.mts';
import { buildBitgetSubscription } from '../src/adapters/bitget.mts';
import { buildGateSubscription } from '../src/adapters/gateio.mts';
import { buildDeribitSubscription } from '../src/adapters/deribit.mts';
import { buildCoinbaseSubscription } from '../src/adapters/coinbase.mts';
import { buildKrakenSubscription } from '../src/adapters/kraken.mts';
import { buildKucoinSubscription } from '../src/adapters/kucoin.mts';
import { buildMexcSubscription } from '../src/adapters/mexc.mts';
import { buildHtxSubscription } from '../src/adapters/htx.mts';
import { buildBitfinexSubscription } from '../src/adapters/bitfinex.mts';
import { buildBitmexSubscription, normalizeBitmexInstrument } from '../src/adapters/bitmex.mts';
import { buildCryptocomSubscription } from '../src/adapters/cryptocom.mts';
import { buildBitstampSubscription } from '../src/adapters/bitstamp.mts';
import { buildWhitebitSubscription } from '../src/adapters/whitebit.mts';
import { buildPhemexSubscription } from '../src/adapters/phemex.mts';
import { buildDydxSubscription } from '../src/adapters/dydx.mts';
import { buildAsterSubscription } from '../src/adapters/aster.mts';

function primary(base: 'BTC' | 'ETH' = 'BTC'): RuntimeMarket {
  // Manager-owned markets do not necessarily carry catalog-only family/status fields.
  return { id: 'hyperliquid:' + base + '-PERP', instrumentId: 'hyperliquid:' + base + '-PERP', venue: 'hyperliquid', exchange: 'hyperliquid',
    nativeSymbol: base, symbol: base, base, quote: 'USD', marketType: 'perpetual', quantityUnit: 'base' };
}
function admitted(plan: PublicOrderbookSelectionPlan): Extract<PublicOrderbookSelectionPlan, { ok: true }> {
  if (!plan.ok) assert.fail(plan.reason);
  return plan;
}
function denied(plan: PublicOrderbookSelectionPlan, pattern: RegExp): Extract<PublicOrderbookSelectionPlan, { ok: false }> {
  if (plan.ok) assert.fail('Expected bounded selection failure');
  assert.match(plan.reason, pattern); return plan;
}
function request(stream: PublicOrderbookStreamPlan, options: LiveFeedStartOptions): { native: string; request: unknown } {
  const symbol = stream.nativeSymbol;
  switch (stream.venue) {
    case 'hyperliquid': { const result = buildHyperliquidSubscription('l2Book', { coin: stream.base, nativeCoin: symbol }); return { native: result.subscription.coin, request: result }; }
    case 'binance': { const result = buildBinanceSubscription('depth', { symbol, marketType: stream.marketType, family: options.binanceFamily }); return { native: result.stream.split('@')[0]!.toUpperCase(), request: result }; }
    case 'bybit': { const result = buildBybitSubscription('depth', { symbol, category: options.bybitCategory }); return { native: result.topic.split('.').at(-1)!, request: result }; }
    case 'okx': { const result = buildOkxSubscription('depth', { instId: symbol, instType: stream.marketType === 'spot' ? 'SPOT' : 'SWAP' }); return { native: result.args[0]!.instId, request: result }; }
    case 'bitget': { const result = buildBitgetSubscription('depth', { symbol, instType: stream.marketType === 'spot' ? 'spot' : 'usdt-futures' }); return { native: result.args[0]!.symbol, request: result }; }
    case 'gateio': { const result = buildGateSubscription('depth', { contract: symbol, limit: 100, interval: '0' }); return { native: result.contract, request: result }; }
    case 'deribit': { const result = buildDeribitSubscription('depth', { instrumentName: symbol }); return { native: result.instrumentName, request: result }; }
    case 'coinbase': { const result = buildCoinbaseSubscription('depth', { productId: symbol, channel: 'level2_batch' }); return { native: result.productId, request: result }; }
    case 'kraken': { const result = buildKrakenSubscription('depth', { symbol, depth: 100 }); return { native: result.symbol, request: result }; }
    case 'kucoin': { const result = buildKucoinSubscription('depth', { symbol, depth: 50 }); return { native: result.symbol, request: result }; }
    case 'mexc': { const result = buildMexcSubscription('depth', { symbol, limit: 20 }); return { native: result.symbol, request: result }; }
    case 'htx': { const result = buildHtxSubscription('depth', { symbol, type: 'step6' }); return { native: result.symbol, request: result }; }
    case 'bitfinex': { const result = buildBitfinexSubscription('depth', { symbol, len: 25 }); return { native: result.symbol.replace(/^t/, ''), request: result }; }
    case 'bitmex': { const result = buildBitmexSubscription('depth', { symbol, table: 'orderBookL2_25' }); return { native: result.symbol, request: result }; }
    case 'cryptocom': { const result = buildCryptocomSubscription('depth', { instrumentName: symbol, depth: 10 }); return { native: result.symbol, request: result }; }
    case 'bitstamp': { const result = buildBitstampSubscription('depth', { symbol, depth: 100 }); return { native: result.symbol, request: result }; }
    case 'whitebit': { const result = buildWhitebitSubscription('depth', { symbol, depth: 100 }); return { native: result.symbol, request: result }; }
    case 'phemex': { const result = buildPhemexSubscription('depth', { symbol, fullDepth: true }); return { native: result.symbol, request: result }; }
    case 'dydx': { const result = buildDydxSubscription('depth', { symbol }); return { native: result.id, request: result }; }
    case 'aster': { const result = buildAsterSubscription('depth', { symbol }); return { native: result.params[0]!.split('@')[0]!.toUpperCase(), request: result }; }
  }
}

test('bounded catalog lists all twenty supported native depth venues without a live-availability claim', () => {
  const catalog = publicOrderbookVenueCatalog();
  assert.equal(catalog.length, 20); assert.deepEqual(catalog.map(entry => entry.id), PUBLIC_ORDERBOOK_VENUE_IDS);
  assert.deepEqual(catalog.filter(entry => entry.default).map(entry => entry.id), PUBLIC_ORDERBOOK_DEFAULT_VENUES);
  assert.deepEqual(catalog.filter(entry => !entry.supported), []);
  assert.ok(catalog.every(entry => typeof entry.name === 'string' && entry.name.length > 0));
  assert.ok(catalog.filter(entry => !entry.supported).every(entry => entry.reason));
  assert.ok(Object.isFrozen(catalog)); assert.ok(catalog.every(Object.isFrozen));
});
test('the recommended venues are the default on active manager metadata without discovery-only fields', () => {
  const plan = admitted(planPublicOrderbookSelection(primary()));
  assert.deepEqual(plan.venues, ['hyperliquid', 'binance', 'bybit', 'okx', 'bitget', 'deribit', 'coinbase']);
  assert.deepEqual(plan.venues, PUBLIC_ORDERBOOK_DEFAULT_VENUES);
  assert.deepEqual(plan.options.selectedOrderbookVenues, plan.venues);
  assert.equal(plan.options.bybitEnabled, true); assert.equal(plan.options.okxEnabled, true); assert.equal(plan.options.bitgetEnabled, true);
  assert.equal(plan.options.deribitEnabled, true); assert.equal(plan.options.coinbaseEnabled, true); assert.equal(plan.options.gateioEnabled, false, 'big by volume but shallow, so not recommended');
  assert.deepEqual(plan.streams.map(stream => stream.instrumentId), ['hyperliquid:BTC-PERP', 'binance:BTCUSDT', 'bybit:BTCUSDT', 'okx:BTC-USDT-SWAP', 'bitget:BTCUSDT', 'deribit:BTC-PERPETUAL', 'coinbase:BTC-USD']);
  assert.ok(plan.streams.every(stream => stream.metadataRequired));
});
test('exact arbitrary masks can omit primary venues and an empty mask disables only L2 requests', () => {
  const plan = admitted(planPublicOrderbookSelection(primary(), ['coinbase', 'kraken', 'phemex']));
  assert.deepEqual(plan.options.selectedOrderbookVenues, ['coinbase', 'kraken', 'phemex']);
  assert.deepEqual(plan.streams.map(stream => stream.venue), ['coinbase', 'kraken', 'phemex']);
  assert.equal(plan.options.bybitEnabled, false); assert.equal(plan.options.okxEnabled, false);
  assert.equal(plan.options.coinbaseEnabled, true); assert.equal(plan.options.krakenEnabled, true); assert.equal(plan.options.phemexEnabled, true);
  const empty = admitted(planPublicOrderbookSelection(primary(), []));
  assert.deepEqual(empty.streams, []); assert.deepEqual(empty.options.selectedOrderbookVenues, []);
  assert.equal(empty.options.coin, 'BTC'); assert.equal(empty.options.binanceSymbol, 'BTCUSDT', 'reference channels retain their configured product');
});
test('every supported BTC stream is an actual pure adapter depth request with canonical manager identity', () => {
  const ids = publicOrderbookVenueCatalog().filter(entry => entry.supported).map(entry => entry.id);
  for (let offset = 0; offset < ids.length; offset += PUBLIC_ORDERBOOK_MAX_SELECTED) {
    const plan = admitted(planPublicOrderbookSelection(primary(), ids.slice(offset, offset + PUBLIC_ORDERBOOK_MAX_SELECTED)));
    for (const stream of plan.streams) {
      const built = request(stream, plan.options); assert.ok(built.request);
      assert.equal(built.native.toUpperCase(), stream.nativeSymbol.replace(/^t/, '').toUpperCase(), stream.venue);
      assert.equal(stream.feedId, stream.venue === 'hyperliquid' ? 'hl-l2Book' : stream.venue + '-depth');
      assert.ok(stream.instrumentId.startsWith(stream.venue + ':')); assert.equal(stream.base, 'BTC');
    }
  }
});
test('ETH peers rebase without stale BTC native symbols and Phemex retains its lowercase spot prefix', () => {
  const ids: PublicOrderbookVenueId[] = ['gateio', 'mexc', 'htx', 'coinbase', 'kraken', 'bitfinex', 'bitstamp', 'phemex'];
  const plan = admitted(planPublicOrderbookSelection(primary('ETH'), ids, { coin: 'BTC', gateioSymbol: 'BTC_USDT', krakenSymbol: 'BTC/USD',
    phemexSymbol: 'sBTCUSDT', bitstampSymbol: 'btcusd', candleInterval: '5m', hlBookResolutions: [{ nSigFigs: 4 }] }));
  assert.ok(plan.streams.every(stream => !/BTC|XBT/.test(stream.nativeSymbol)));
  assert.deepEqual(plan.streams.map(stream => stream.nativeSymbol), ['ETH_USDT', 'ETH_USDT', 'ETH-USDT', 'ETH-USD', 'ETH/USD', 'ETHUSD', 'ethusd', 'sETHUSDT']);
  assert.equal(plan.streams.at(-1)!.instrumentId, 'phemex:sETHUSDT'); assert.equal(plan.options.candleInterval, '5m');
});
test('exact eight requests succeed; duplicates, unknown IDs, coercions, sparse or nine requests fail', () => {
  assert.equal(admitted(planPublicOrderbookSelection(primary(), PUBLIC_ORDERBOOK_VENUE_IDS.slice(0, 8))).streams.length, 8);
  for (const selected of [null, {}, 'binance', ['Binance'], [' binance'], ['unknown'], ['binance', 'binance'], [false], [1], new Array(1), Array.from({ length: PUBLIC_ORDERBOOK_MAX_SELECTED + 1 }, (_, i) => 'venue' + i)])
    denied(planPublicOrderbookSelection(primary(), selected), /0\.\.32.*exact.*without duplicates/);
  let getterCalls = 0; const selected: unknown[] = ['binance'];
  Object.defineProperty(selected, '0', { get() { getterCalls++; return 'binance'; } });
  denied(planPublicOrderbookSelection(primary(), selected), /exact/); assert.equal(getterCalls, 0);
});
test('newly wired dYdX/Aster keep their native depth channels, coverage and units without invented rows', () => {
  for (const base of ['BTC', 'ETH'] as const) {
    const plan = admitted(planPublicOrderbookSelection(primary(base), ['dydx', 'aster']));
    assert.deepEqual(plan.streams.map(stream => stream.instrumentId), ['dydx:' + base + '-USD', 'aster:' + base + 'USDT']);
    assert.equal(plan.options.dydxEnabled, true); assert.equal(plan.options.asterEnabled, true);
    assert.deepEqual(plan.options.selectedOrderbookVenues, ['dydx', 'aster']);
    const dydx = buildDydxSubscription('depth', { symbol: plan.streams[0]!.nativeSymbol });
    assert.equal(dydx.channel, 'v4_orderbook'); assert.equal(dydx.batched, false);
    const aster = buildAsterSubscription('depth', { symbol: plan.streams[1]!.nativeSymbol });
    assert.equal(aster.stream, base.toLowerCase() + 'usdt@depth20@100ms'); assert.equal(aster.depth, 20); assert.equal(aster.snapshot, true);
    assert.ok(plan.streams.every(stream => stream.metadataRequired));
  }
});
test('unavailable selected symbols fail without partial streams or implicit defaults', () => {
  const result = denied(planPublicOrderbookSelection(primary(), ['binance', 'coinbase'], { coinbaseSymbol: null }), /symbol.*unavailable/);
  assert.equal(result.venue, 'coinbase');
  assert.equal('streams' in result, false);
});
test('native identity, base, quote, active metadata and family mismatches fail before configuration changes', () => {
  for (const patch of [{ base: 'SOL' }, { quote: 'EUR', quoteNormalized: 'USD' }, { quote: 'BTC' }, { quote: '' }, { nativeSymbol: 'ETH' },
    { instrumentId: 'hyperliquid:ETH-PERP' }, { venue: 'Hyperliquid' }, { marketType: 'spot' }, { isDelisted: true }, { status: 'offline' }, { id: 'foreign' },
    { inverse: 'true' }, { base: ['BTC'] }, { nativeSymbol: 'B'.repeat(65) }, { discoveryFamily: 'options' }]) {
    denied(planPublicOrderbookSelection({ ...primary(), ...patch } as RuntimeMarket), /metadata|family/);
  }
});
test('native quote remains authoritative even if converted USD labels are present', () => {
  for (const quote of ['BTC', 'ETH', 'EUR', 'JPY']) denied(planPublicOrderbookSelection({ ...primary(), quote, quoteNormalized: 'USD', quoteUsdRate: 1 }), /USD\/stable/);
});
test('matching native Binance spot product overrides rebased peers without dropping its explicit stable quote', () => {
  const product: RuntimeMarket = { venue: 'binance', nativeSymbol: 'ETHFDUSD', instrumentId: 'binance:ETHFDUSD:spot', base: 'ETH', quote: 'FDUSD', marketType: 'spot', isDelisted: false };
  const plan = admitted(planPublicOrderbookSelection(product, undefined, { binanceFamily: 'coinm', binanceSymbol: 'BTCUSD_PERP', bybitCategory: 'inverse', bybitSymbol: 'BTCUSD' }));
  assert.equal(plan.options.binanceSymbol, 'ETHFDUSD'); assert.equal(plan.options.binanceFamily, 'usdm'); assert.equal(plan.options.binanceMarketType, 'spot');
  assert.equal(plan.options.bybitSymbol, 'ETHUSD'); assert.equal(plan.options.bybitCategory, 'inverse');
  assert.equal(plan.streams[1]!.instrumentId, product.instrumentId);
});
test('actual Binance COIN-M normalized metadata preserves native product and verified contract family', () => {
  const product = normalizeBinanceExchangeInfo({ symbols: [{ symbol: 'BTCUSD_PERP', pair: 'BTCUSD', baseAsset: 'BTC', quoteAsset: 'USD', marginAsset: 'BTC',
    status: 'TRADING', contractType: 'PERPETUAL', contractSize: 100, filters: [{ filterType: 'PRICE_FILTER', tickSize: '0.1' }, { filterType: 'LOT_SIZE', stepSize: '1' }] }] }, { symbol: 'BTCUSD_PERP', family: 'coinm' }).assets[0]!;
  const plan = admitted(planPublicOrderbookSelection(product));
  assert.equal(plan.options.binanceFamily, 'coinm'); assert.equal(plan.options.binanceSymbol, 'BTCUSD_PERP'); assert.equal(plan.streams[1]!.quote, 'USD');
  assert.equal(product.contractValue, 100); assert.equal(plan.streams[1]!.metadataRequired, true, 'planner does not replace manager contract-basis validation');
  denied(planPublicOrderbookSelection({ ...product, family: 'usdm' }), /family/);
});
test('actual Bybit inverse metadata preserves native quantity unit and family without an inverse size guess', () => {
  const product = normalizeBybitInstrumentInfo({ retCode: 0, result: { category: 'inverse', list: [{ symbol: 'ETHUSD', baseCoin: 'ETH', quoteCoin: 'USD', settleCoin: 'ETH',
    contractType: 'InversePerpetual', status: 'Trading', priceFilter: { tickSize: '0.05' }, lotSizeFilter: { qtyStep: '1' } }] } }, { symbol: 'ETHUSD', category: 'inverse' }).assets[0]!;
  const plan = admitted(planPublicOrderbookSelection(product));
  assert.equal(plan.options.bybitCategory, 'inverse'); assert.equal(plan.options.bybitSymbol, 'ETHUSD');
  assert.equal(plan.streams[2]!.instrumentId, 'bybit:ETHUSD'); assert.equal(product.quantityUnit, 'quote');
  denied(planPublicOrderbookSelection({ ...product, category: 'linear' }), /category/);
  denied(planPublicOrderbookSelection({ ...product, inverse: false }), /metadata/);
});
test('actual OKX inverse SWAP metadata keeps exact native product and mandatory metadata gate', () => {
  const product = normalizeOkxInstrumentInfo({ code: '0', data: [{ instId: 'BTC-USD-SWAP', instType: 'SWAP', state: 'live', baseCcy: 'BTC', quoteCcy: 'USD',
    tickSz: '0.1', lotSz: '1', ctType: 'inverse', ctVal: '100', ctValCcy: 'USD', settleCcy: 'BTC' }] }, { instId: 'BTC-USD-SWAP', instType: 'SWAP' }).assets[0]!;
  const plan = admitted(planPublicOrderbookSelection(product));
  assert.equal(plan.options.okxSymbol, 'BTC-USD-SWAP'); assert.equal(plan.options.okxMarketType, 'perpetual'); assert.equal(plan.streams[3]!.instrumentId, product.instrumentId);
  assert.equal(product.contractValue, 100); assert.equal(plan.streams[3]!.metadataRequired, true);
  denied(planPublicOrderbookSelection({ ...product, instType: 'SPOT' }), /family/);
});
test('manager rows outside catalog venues retain the exact selected native spot/perpetual override', () => {
  const product: RuntimeMarket = { venue: 'coinbase', nativeSymbol: 'ETH-USDC', id: 'coinbase:ETH-USDC', base: 'ETH', quote: 'USDC', marketType: 'spot' };
  const plan = admitted(planPublicOrderbookSelection(product, ['coinbase', 'deribit'], { coinbaseSymbol: 'BTC-USD' }));
  assert.equal(plan.options.coinbaseSymbol, 'ETH-USDC'); assert.equal(plan.streams[0]!.instrumentId, product.id);
  assert.equal(plan.streams[1]!.nativeSymbol, 'ETH-PERPETUAL'); assert.equal(plan.options.bybitEnabled, false);
});
test('BitMEX BTC canonical alias is supported while ETHUSD quanto planning fails explicitly', () => {
  const btc = normalizeBitmexInstrument([{ symbol: 'XBTUSD', underlying: 'XBT', quoteCurrency: 'USD', state: 'Open', tickSize: 0.5, lotSize: 1, isInverse: true }]).assets[0]!;
  const plan = admitted(planPublicOrderbookSelection(btc, ['bitmex', 'binance']));
  assert.equal(plan.base, 'BTC'); assert.equal(plan.streams[0]!.nativeSymbol, 'XBTUSD'); assert.equal(plan.streams[0]!.instrumentId, 'bitmex:XBTUSD');
  const rejected = denied(planPublicOrderbookSelection(primary('ETH'), ['binance', 'bitmex']), /BitMEX ETH.*sizing basis/);
  assert.equal(rejected.venue, 'bitmex');
});
test('bounded descriptor validation invokes no input getter and leaves configuration/payload graphs untouched', () => {
  let getters = 0; const product = primary();
  Object.defineProperty(product, 'nativeSymbol', { get() { getters++; return 'BTC'; } });
  denied(planPublicOrderbookSelection(product), /metadata/); assert.equal(getters, 0);
  const baseline: LiveFeedStartOptions = { candleInterval: '5m' }; Object.defineProperty(baseline, 'bybitCategory', { get() { getters++; return 'inverse'; } });
  denied(planPublicOrderbookSelection(primary(), undefined, baseline), /unsafe/); assert.equal(getters, 0);
  const controls = [{ nSigFigs: 4 }], original = { coin: 'BTC', hlBookResolutions: controls, bybitEnabled: false, coinbaseEnabled: true, candleInterval: '5m' };
  const plan = admitted(planPublicOrderbookSelection(primary('ETH'), ['coinbase'], original));
  assert.equal(plan.options.hlBookResolutions, controls); assert.deepEqual(original, { coin: 'BTC', hlBookResolutions: controls, bybitEnabled: false, coinbaseEnabled: true, candleInterval: '5m' });
  assert.equal(plan.options.bybitEnabled, false); assert.equal(plan.options.coinbaseEnabled, true);
  const huge: LiveFeedStartOptions = {}; for (let index = 0; index < 97; index++) Object.defineProperty(huge, 'control' + index, { value: index, enumerable: true });
  denied(planPublicOrderbookSelection(primary(), undefined, huge), /bounded shell/);
});
test('selection is detached and frozen, without sharing mutable caller arrays or toggling unrelated venues', () => {
  const selected = ['whitebit', 'phemex']; const plan = admitted(planPublicOrderbookSelection(primary(), selected, { bitgetEnabled: true, asterEnabled: true }));
  selected[0] = 'binance'; assert.deepEqual(plan.venues, ['whitebit', 'phemex']); assert.deepEqual(plan.options.selectedOrderbookVenues, ['whitebit', 'phemex']);
  assert.ok(Object.isFrozen(plan.venues)); assert.ok(Object.isFrozen(plan.streams)); assert.ok(Object.isFrozen(plan.options.selectedOrderbookVenues));
  assert.equal(plan.options.bitgetEnabled, false); assert.equal(plan.options.asterEnabled, false);
});

test('native Bybit USDC linear and Bitget spot/perpetual overrides retain exact family IDs', () => {
  const usdc: RuntimeMarket = { venue: 'bybit', nativeSymbol: 'ETHPERP', instrumentId: 'bybit:ETHPERP', base: 'ETH', quote: 'USDC', marketType: 'perpetual',
    category: 'linear', contractType: 'LinearPerpetual', inverse: false, isDelisted: false };
  const linear = admitted(planPublicOrderbookSelection(usdc));
  assert.equal(linear.options.bybitSymbol, 'ETHPERP'); assert.equal(linear.options.bybitCategory, 'linear');
  assert.equal(linear.streams[2]!.quote, 'USDC'); assert.equal(request(linear.streams[2]!, linear.options).native, 'ETHPERP');
  for (const marketType of ['spot', 'perpetual'] as const) {
    const product: RuntimeMarket = { venue: 'bitget', nativeSymbol: 'ETHUSDT', instrumentId: 'bitget:ETHUSDT' + (marketType === 'spot' ? ':spot' : ''),
      base: 'ETH', quote: 'USDT', marketType, instType: marketType === 'spot' ? 'spot' : 'usdt-futures', isDelisted: false };
    const plan = admitted(planPublicOrderbookSelection(product, ['bitget'], { bitgetMarketType: marketType === 'spot' ? 'perpetual' : 'spot' }));
    assert.equal(plan.options.bitgetMarketType, marketType); assert.equal(plan.options.bitgetSymbol, 'ETHUSDT');
    assert.equal(plan.streams[0]!.instrumentId, product.instrumentId); assert.equal(request(plan.streams[0]!, plan.options).native, 'ETHUSDT');
  }
});
test('unknown fields remain unread, inherited native identities and hidden config getters cannot supply a plan', () => {
  let getters = 0; const product = primary();
  Object.defineProperty(product, 'unknownMetadata', { get() { getters++; throw new Error('must not be read'); } });
  assert.equal(admitted(planPublicOrderbookSelection(product)).base, 'BTC'); assert.equal(getters, 0);
  const inherited = Object.create(primary()) as RuntimeMarket;
  denied(planPublicOrderbookSelection(inherited), /metadata/);
  const baseline: LiveFeedStartOptions = {};
  Object.defineProperty(baseline, 'binanceSymbol', { enumerable: false, get() { getters++; return 'BTCUSDT'; } });
  denied(planPublicOrderbookSelection(primary(), undefined, baseline), /unsafe/); assert.equal(getters, 0);
});
