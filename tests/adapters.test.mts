import test from 'node:test';
import assert from 'node:assert/strict';
import {
  AdapterTransportError, BinanceConnector, HyperliquidConnector,
  buildBinanceRequest, buildBinanceSubscription, binanceInstrumentId, normalizeBinanceDepth,
  normalizeBinanceDepthDelta, normalizeBinanceKline, normalizeBinanceOpenInterest, normalizeBinanceOpenInterestHistory,
  buildHyperliquidInfoRequest, buildHyperliquidSubscription, normalizeHyperliquidAssetContext,
  hyperliquidBucketBounds, normalizeHyperliquidBook, normalizeHyperliquidCandle, normalizeHyperliquidMetadata,
  hyperliquidCoin, normalizeHyperliquidTrade, normalizeHyperliquidTrades,
  buildDeribitRequest, buildDeribitSubscription, normalizeDeribitDepth, normalizeDeribitInstrumentInfo,
} from '../src/adapters/index.mts';

test('Hyperliquid request descriptors are deterministic and side-effect free', () => {
  const req = buildHyperliquidInfoRequest('l2Book', {coin:'BTC-PERP', nSigFigs:5});
  assert.equal(req.url, 'https://api.hyperliquid.xyz/info'); assert.equal(req.method, 'POST');
  assert.deepEqual(JSON.parse(req.body), {type:'l2Book',coin:'BTC',nSigFigs:5});
  assert.deepEqual(buildHyperliquidSubscription('candle',{coin:'BTC',interval:'1h'}), {method:'subscribe',subscription:{type:'candle',coin:'BTC',interval:'1h'}});
});

test('Hyperliquid coarse l2Book carries resolution and conservative coverage', () => {
  const request = buildHyperliquidSubscription('l2Book', { coin: 'BTC', nSigFigs: 2 });
  assert.deepEqual(request.subscription, { type: 'l2Book', coin: 'BTC', nSigFigs: 2 });
  assert.throws(() => buildHyperliquidSubscription('l2Book', { coin: 'BTC', mantissa: 3 }), /mantissa/);
  assert.throws(() => buildHyperliquidSubscription('l2Book', { coin: 'BTC', nSigFigs: 4, mantissa: 1 }), /only valid/);
  assert.throws(() => buildHyperliquidInfoRequest('l2Book', { coin: 'BTC', nSigFigs: 4, mantissa: 1 }), /only valid/);
  const book = normalizeHyperliquidBook({ data: { coin: 'BTC', time: 1700000000000, nSigFigs: 2, levels: [[{ px: '1000', sz: '2' }], [{ px: '1100', sz: '1' }]] } }, { receivedAt: 1700000000100 });
  assert.equal(book.resolution, 'coarse'); assert.equal(book.coverage, 'partial'); assert.equal(book.nSigFigs, 2);
  assert.equal(book.resolutionKey, 'sig:2'); assert.equal(book.bookKey, 'hyperliquid:BTC-PERP|sig:2');
  const transition = normalizeHyperliquidBook({ data: { coin: 'BTC', time: 1700000000000, nSigFigs: 2, levels: [[{ px: '99999', sz: '2' }], [{ px: '100000', sz: '1' }]] } }, { receivedAt: 1700000000100 });
  assert.equal(transition.bids[0].sourceGrouping, 1000);
  assert.deepEqual({ low: transition.bids[0].priceLow, high: transition.bids[0].priceHigh }, { low: 99000, high: 100000 });
  assert.equal(transition.asks[0].sourceGrouping, 10000);
  assert.deepEqual(hyperliquidBucketBounds(100000, 2), {
    step: 10000, lower: 100000, upper: 110000, nSigFigs: 2,
    boundaryPrecision: 'estimated', boundarySemantics: 'lower-edge-grid', source: 'official-contract',
  });
  assert.throws(() => normalizeHyperliquidBook({ data: { coin: 'BTC', time: 1, nSigFigs: 3, levels: [[{ px: '1000', sz: '2' }], [{ px: '1100', sz: '1' }]] } }, { nSigFigs: 2 }), /contradicts/);
  assert.throws(() => normalizeHyperliquidBook({ data: { coin: 'BTC', time: 1, nSigFigs: 2, levels: [[{ px: '1000', sz: '2' }], [{ px: '1100', sz: '1' }]] } }, { resolutionKey: 'native' }), /contradicts/);
});

test('Hyperliquid l2Book and asset context normalize native units', () => {
  const book = normalizeHyperliquidBook({channel:'l2Book',data:{coin:'BTC',time:1700000000000,levels:[[{px:'100',sz:'2'},{px:'99',sz:'3'}],[{px:'101',sz:'4'}]]}}, {receivedAt:1700000000100});
  assert.equal(book.instrumentId,'hyperliquid:BTC-PERP'); assert.equal(book.sourceTimestamp,1700000000000); assert.equal(book.coverage,'partial'); assert.deepEqual(book.bids,[{price:100,amount:2},{price:99,amount:3}]);
  const oi = normalizeHyperliquidAssetContext({data:{time:1700000000000,context:{openInterest:'12.5',markPx:'100'}}},{coin:'BTC',receivedAt:1700000000100});
  assert.equal(oi.base,12.5); assert.equal(oi.quote,1250); assert.equal(oi.markPrice,100); assert.equal(oi.quality,'native');
  const liveOi = normalizeHyperliquidAssetContext({channel:'activeAssetCtx',data:{coin:'BTC',ctx:{openInterest:'5',markPx:'101'}}},{coin:'BTC',receivedAt:1700000000100});
  assert.equal(liveOi.sourceTimestamp, null);
  const explicitNullOi = normalizeHyperliquidAssetContext({data:{time:null,ctx:{openInterest:'5',markPx:'101'}}},{coin:'BTC',receivedAt:1700000000100});
  assert.equal(explicitNullOi.sourceTimestamp, null);
});

test('Hyperliquid l2Book keeps missing or malformed wire time separate from receipt time', () => {
  const levels = [[{ px: '100', sz: '2' }], [{ px: '101', sz: '3' }]];
  const receivedAt = 1_700_000_000_100;
  for (const time of [undefined, null, true, false, [], {}, '', 'not-a-time']) {
    const book = normalizeHyperliquidBook({ data: { coin: 'BTC', time, levels } }, { receivedAt });
    assert.equal(book.sourceTimestamp, null);
    assert.equal(book.sequence, undefined);
    assert.equal(book.receivedAt, receivedAt);
  }
  const known = normalizeHyperliquidBook({ data: { coin: 'BTC', time: '1700000000000', levels } }, { receivedAt });
  assert.equal(known.sourceTimestamp, 1_700_000_000_000);
  assert.equal(known.sequence, 1_700_000_000_000);
  const oi = normalizeHyperliquidAssetContext({ data: { time: true, context: { openInterest: '5', markPx: '101' } } }, { receivedAt });
  assert.equal(oi.sourceTimestamp, null);
});

test('Hyperliquid metadata and public trades normalize without inventing timestamps', () => {
  const metadata = normalizeHyperliquidMetadata([
    { universe: [{ name: 'BTC', szDecimals: 5, maxLeverage: 20 }, { name: 'ETH', szDecimals: 4, isDelisted: true }] },
    [{ openInterest: '12', markPx: '100', funding: '0.001' }, { openInterest: '9', markPx: '10' }],
  ], { receivedAt: 1700000000100 });
  assert.equal(metadata.kind, 'metadata'); assert.equal(metadata.sourceTimestamp, null);
  assert.deepEqual(metadata.assets[0], {
    coin: 'BTC', instrumentId: 'hyperliquid:BTC-PERP', szDecimals: 5, maxLeverage: 20,
    onlyIsolated: false, isDelisted: false,
    context: { markPrice: 100, oraclePrice: undefined, midPrice: undefined, funding: 0.001, openInterest: 12 },
  });
  const ethOi = normalizeHyperliquidAssetContext([
    { universe: [{ name: 'BTC' }, { name: 'ETH' }] },
    [{ openInterest: '12', markPx: '100' }, { openInterest: '9', markPx: '10' }],
  ], { coin: 'ETH', receivedAt: 1700000000100 });
  assert.equal(ethOi.instrumentId, 'hyperliquid:ETH-PERP'); assert.equal(ethOi.base, 9);
  assert.throws(() => normalizeHyperliquidAssetContext([
    { universe: [{ name: 'BTC' }] }, [{ openInterest: '12', markPx: '100' }],
  ], { coin: 'SOL', receivedAt: 1700000000100 }), /openInterest/);
  const trade = normalizeHyperliquidTrade({ coin:'BTC', side:'B', px:'100.5', sz:'2', time:1700000000000, tid:42, hash:'0xabc' }, { receivedAt:1700000000100 });
  assert.deepEqual(trade, { kind:'trade', venue:'hyperliquid', instrumentId:'hyperliquid:BTC-PERP', tradeId:'1700000000000:BTC:42', side:'buy', price:100.5, amount:2, notionalUsd:201, sourceTimestamp:1700000000000, receivedAt:1700000000100, hash:'0xabc', tid:'42' });
  const batch = normalizeHyperliquidTrades({ channel:'trades', data:[{ coin:'BTC', side:'A', px:'99', sz:'1', time:1700000000001, tid:43 }] }, { receivedAt:1700000000100 });
  assert.equal(batch.length, 1); assert.equal(batch[0].side, 'sell'); assert.equal(batch[0].tradeId, '1700000000001:BTC:43');
  assert.deepEqual(normalizeHyperliquidTrades({ channel:'subscriptionResponse', data:{ method:'subscribe' } }, { receivedAt:1700000000100 }), []);
});

test('Hyperliquid candles accept array wire shape', () => {
  const candle = normalizeHyperliquidCandle([1700000000000,1700003600000,'100','110','90','105','42'],{coin:'BTC'});
  assert.deepEqual(candle,{instrumentId:'hyperliquid:BTC-PERP',interval:'1h',start:1700000000000,end:1700003600000,open:100,high:110,low:90,close:105,volume:42,sourceTimestamp:1700003600000});
});

test('Hyperliquid preserves HIP-3 DEX coin identity across product and feed parsers', () => {
  const coin = 'xyz:XYZ100';
  const instrumentId = 'hyperliquid:' + coin + '-PERP';
  assert.equal(hyperliquidCoin(coin), coin);
  assert.equal(hyperliquidCoin(instrumentId), coin);
  assert.equal(hyperliquidCoin('btc-perp'), 'BTC');
  assert.deepEqual(JSON.parse(buildHyperliquidInfoRequest('l2Book', { coin: instrumentId }).body), { type: 'l2Book', coin });
  assert.deepEqual(JSON.parse(buildHyperliquidInfoRequest('candleSnapshot', { coin: instrumentId, interval: '1m', startTime: 1700000000000, endTime: 1700000060000 }).body), { type: 'candleSnapshot', req: { coin, interval: '1m', startTime: 1700000000000, endTime: 1700000060000 } });
  assert.deepEqual(buildHyperliquidSubscription('l2Book', { coin }), { method: 'subscribe', subscription: { type: 'l2Book', coin } });

  const metadata = normalizeHyperliquidMetadata([
    { universe: [{ name: 'BTC' }, { name: coin }] },
    [{ openInterest: '12' }, { openInterest: '7' }],
  ]);
  assert.deepEqual(metadata.assets.map((asset) => asset.instrumentId), ['hyperliquid:BTC-PERP', instrumentId]);
  assert.notEqual(metadata.assets[0].instrumentId, metadata.assets[1].instrumentId);

  const contexts = normalizeHyperliquidAssetContext([
    { universe: [{ name: 'BTC' }, { name: coin }] },
    [{ openInterest: '12' }, { openInterest: '7' }],
  ], { coin, receivedAt: 100 });
  assert.equal(contexts.instrumentId, instrumentId);
  assert.equal(contexts.base, 7);

  const book = normalizeHyperliquidBook({ data: { coin, time: 1700000000000, levels: [[{ px: '100', sz: '2' }], [{ px: '101', sz: '3' }]] } });
  assert.equal(book.instrumentId, instrumentId);
  const trade = normalizeHyperliquidTrade({ coin, side: 'B', px: '100', sz: '0.5', time: 1700000000000, tid: 7 });
  assert.equal(trade.instrumentId, instrumentId);
  assert.equal(trade.tradeId, '1700000000000:xyz:XYZ100:7');
  const candle = normalizeHyperliquidCandle({ t: 1700000000000, T: 1700000060000, o: '100', h: '101', l: '99', c: '100.5', v: '12' }, { coin, interval: '1m' });
  assert.equal(candle.instrumentId, instrumentId);
});

test('Binance request descriptors use correct public host and paths', () => {
  assert.match(buildBinanceRequest('depth',{symbol:'BTCUSDT',marketType:'perpetual',limit:100}).url,/fapi\.binance\.com\/fapi\/v1\/depth\?symbol=BTCUSDT&limit=100$/);
  assert.match(buildBinanceRequest('openInterest',{symbol:'BTCUSDT'}).url,/fapi\.binance\.com\/fapi\/v1\/openInterest\?symbol=BTCUSDT$/);
  assert.equal(buildBinanceSubscription('depth',{symbol:'BTCUSDT',marketType:'perpetual'}).stream,'btcusdt@depth@100ms');
  assert.equal(buildBinanceSubscription('depth',{symbol:'BTCUSDT',marketType:'perpetual'}).url,'wss://fstream.binance.com/public/ws/btcusdt@depth@100ms');
  assert.equal(buildBinanceSubscription('aggTrade',{symbol:'BTCUSDT'}).url,'wss://fstream.binance.com/market/ws/btcusdt@aggTrade');
  assert.equal(buildBinanceSubscription('kline',{symbol:'BTCUSDT',interval:'1m'}).url,'wss://fstream.binance.com/market/ws/btcusdt@kline_1m');
  assert.equal(buildBinanceSubscription('markPrice',{symbol:'BTCUSDT'}).url,'wss://fstream.binance.com/market/ws/btcusdt@markPrice@1s');
  assert.equal(buildBinanceSubscription('depth',{symbol:'BTCUSDT',marketType:'spot'}).url,'wss://stream.binance.com:9443/ws/btcusdt@depth@100ms');
  assert.equal(buildBinanceSubscription('markPrice',{symbol:'BTCUSDT',marketType:'spot'}).stream,'btcusdt@trade');
});

test('Binance depth snapshot and delta normalize sequence and timestamp', () => {
  const snap = normalizeBinanceDepth({lastUpdateId:20,E:1700000000000,bids:[['100','2']],asks:[['101','1']]},{symbol:'BTCUSDT',receivedAt:1700000000100});
  assert.equal(snap.sequence,20); assert.equal(snap.sourceTimestamp,1700000000000); assert.deepEqual(snap.asks,[{price:101,amount:1}]);
  assert.throws(() => normalizeBinanceDepth({ bids: [], asks: [] }), /snapshot update ID missing or invalid/);
  assert.throws(() => normalizeBinanceDepth({ lastUpdateId: Number.MAX_SAFE_INTEGER + 1, bids: [], asks: [] }), /snapshot update ID missing or invalid/);
  const delta = normalizeBinanceDepthDelta({e:'depthUpdate',E:1700000000200,s:'BTCUSDT',U:21,u:25,b:[['100','0']],a:[['102','3']]},{marketType:'spot',receivedAt:1700000000300});
  assert.equal(delta.sequence,25); assert.equal(delta.previousSequence,20); assert.deepEqual(delta.bids,[{price:100,amount:0}]);
  const futuresDelta = normalizeBinanceDepthDelta({e:'depthUpdate',E:1700000000200,s:'BTCUSDT',U:21,pu:17,u:25,b:[],a:[]},{receivedAt:1700000000300});
  assert.equal(futuresDelta.previousSequence,17);
  assert.throws(() => normalizeBinanceDepthDelta({e:'depthUpdate',E:1700000000200,s:'BTCUSDT',U:21,u:25,b:[],a:[]},{receivedAt:1700000000300}), /previous update ID missing or invalid/);
  for (const malformed of [
    { U: undefined, u: 25, pu: 17 },
    { U: 21, u: undefined, pu: 17 },
    { U: Number.MAX_SAFE_INTEGER + 1, u: Number.MAX_SAFE_INTEGER + 2, pu: 17 },
    { U: 21, u: Number.MAX_SAFE_INTEGER + 1, pu: 17 },
  ]) {
    assert.throws(() => normalizeBinanceDepthDelta({ e: 'depthUpdate', s: 'BTCUSDT', b: [], a: [], ...malformed }), /update ID missing or invalid/);
  }
});

test('Binance OI and kline normalization preserves sampled source times', () => {
  const oi = normalizeBinanceOpenInterest({symbol:'BTCUSDT',openInterest:'10',time:1700000000000},{markPrice:100,receivedAt:1700000000100});
  assert.equal(oi.base,10); assert.equal(oi.quote,1000); assert.equal(oi.instrumentId,'binance:BTCUSDT');
  const c = normalizeBinanceKline([1700000000000, '100','110','90','105','4',1700003600000],{symbol:'BTCUSDT'});
  assert.equal(c.close,105); assert.equal(c.start,1700000000000); assert.equal(c.end,1700003600000);
});

test('Binance public OI history uses interval samples without invented extrema', () => {
  const request = buildBinanceRequest('openInterestHistory', { symbol: 'BTCUSDT', period: '5m', limit: 2 });
  assert.match(request.url, /futures\/data\/openInterestHist\?symbol=BTCUSDT&limit=2&period=5m$/);
  const rows = normalizeBinanceOpenInterestHistory([
    { symbol: 'BTCUSDT', sumOpenInterest: '10', sumOpenInterestValue: '1000', timestamp: 1700000300000 },
    { symbol: 'BTCUSDT', sumOpenInterest: '12', sumOpenInterestValue: '1200', timestamp: 1700000000000 },
  ], { receivedAt: 1700000400000 });
  assert.deepEqual(rows.map((row) => row.sourceTimestamp), [1700000000000, 1700000300000]);
  assert.equal(rows[0].quality, 'sampled'); assert.equal(rows[0].historySource, 'binance-public-statistics');
  assert.equal(rows[0].observationTimestamp, rows[0].sourceTimestamp); assert.equal(rows[0].base, 12); assert.equal(rows[0].quote, 1200);
});

test('Binance spot IDs are distinct and spot OI fails closed', () => {
  assert.equal(binanceInstrumentId('BTCUSDT', 'perpetual'), 'binance:BTCUSDT'); assert.equal(binanceInstrumentId('BTCUSDT', 'spot'), 'binance:BTCUSDT:spot');
  const spot = normalizeBinanceDepth({ lastUpdateId: 1, bids: [['100', '1']], asks: [['101', '1']] }, { symbol: 'BTCUSDT', marketType: 'spot' });
  assert.equal(spot.instrumentId, 'binance:BTCUSDT:spot'); assert.throws(() => buildBinanceRequest('openInterest', { symbol: 'BTCUSDT', marketType: 'spot' }), /do not expose open interest/); assert.throws(() => normalizeBinanceOpenInterest({ symbol: 'BTCUSDT', openInterest: '1' }, { marketType: 'spot' }), /do not expose open interest/);
});

test('connectors are disabled by default and only call injected transports when enabled', async () => {
  const h = new HyperliquidConnector({transport:{request:async r=>r}});
  await assert.rejects(() => h.info('allMids'), AdapterTransportError);
  const b = new BinanceConnector({transport:{request:async r=>r},networkEnabled:true});
  const result = await b.request('openInterest',{symbol:'BTCUSDT'}); assert.ok(result && typeof result === 'object' && !Array.isArray(result)); assert.equal((result as Record<string, unknown>).method,'GET');
});

test('Deribit grouped BTC perpetual descriptors normalize USD-denominated snapshots', () => {
  const request = buildDeribitRequest('depth', { instrumentName: 'BTC-PERPETUAL', depth: 100 });
  assert.equal(request.method, 'POST');
  assert.deepEqual(JSON.parse(request.body), { jsonrpc: '2.0', id: 1, method: 'public/get_order_book', params: { instrument_name: 'BTC-PERPETUAL', depth: 100 } });
  const subscription = buildDeribitSubscription('depth', { instrumentName: 'BTC-PERPETUAL', group: 10, depth: 20, interval: '100ms' });
  assert.equal(subscription.topic, 'book.BTC-PERPETUAL.10.20.100ms');
  assert.throws(() => buildDeribitSubscription('depth', { instrumentName: 'BTC-PERPETUAL', group: 3 }), /group/);
  const metadata = normalizeDeribitInstrumentInfo({ result: { instrument_name: 'BTC-PERPETUAL', base_currency: 'BTC', counter_currency: 'USD', future_type: 'reversed', tick_size: 0.5, min_trade_amount: 10, settlement_currency: 'BTC', is_active: true } }, { receivedAt: 1_700_000_000_100 });
  assert.equal(metadata.assets[0].quantityUnit, 'quote');
  const book = normalizeDeribitDepth({ params: { channel: 'book.BTC-PERPETUAL.10.20.100ms', data: { instrument_name: 'BTC-PERPETUAL', timestamp: 1_700_000_000_000, change_id: 42, bids: [[77_000, 125_000]], asks: [[77_001, 80_000]] } } }, { receivedAt: 1_700_000_000_100 });
  assert.equal(book.instrumentId, 'deribit:BTC-PERPETUAL'); assert.equal(book.units, 'quote'); assert.equal(book.sequence, 42); assert.equal(book.coverage, 'partial'); assert.equal(book.resolution, 'coarse'); assert.equal(book.resolutionKey, 'group:10'); assert.ok('sourceGrouping' in book); assert.equal(book.sourceGrouping, 10); assert.equal(book.sourceDepth, 20); assert.equal(book.sourceInterval, '100ms');
  assert.deepEqual(book.bids, [{ price: 77_000, amount: 125_000 }]);
});
