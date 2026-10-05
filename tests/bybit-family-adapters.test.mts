import test from 'node:test';
import assert from 'node:assert/strict';
import {
  BybitConnector, bybitInstrumentId, buildBybitRequest, buildBybitSubscription, normalizeBybitInstrumentInfo,
  normalizeBybitDepth, normalizeBybitDepthDelta, applyBybitDepthUpdate, applyBybitDepthDelta, invalidateBybitDepthState,
  normalizeBybitOpenInterest, normalizeBybitKline, MAX_BYBIT_INSTRUMENT_ROWS, MAX_BYBIT_DEPTH_ROWS,
  type BybitCategory,
} from '../src/adapters/bybit.mts';
import { usdBookLevels } from '../src/core/book-valuation.mts';

const NOW = Date.parse('2026-10-01T12:00:00.000Z');
const CATEGORIES = ['linear', 'spot', 'inverse'] as const;
function symbolFor(category: BybitCategory) { return category === 'inverse' ? 'BTCUSD' : 'BTCUSDT'; }
function instrumentRow(category: BybitCategory, fields: Record<string, unknown> = {}) {
  return { symbol: symbolFor(category), baseCoin: 'BTC', quoteCoin: category === 'inverse' ? 'USD' : 'USDT',
    ...(category === 'spot' ? {} : { settleCoin: category === 'inverse' ? 'BTC' : 'USDT', contractType: category === 'inverse' ? 'InversePerpetual' : 'LinearPerpetual' }),
    status: 'Trading', priceFilter: { tickSize: '0.1' },
    lotSizeFilter: category === 'spot' ? { basePrecision: '0.000001', quotePrecision: '0.01' } : { qtyStep: category === 'inverse' ? '1' : '0.001' }, ...fields };
}
function metadataFor(category: BybitCategory, fields: Record<string, unknown> = {}) {
  return normalizeBybitInstrumentInfo({ retCode: 0, time: NOW, result: { category, list: [instrumentRow(category, fields)] } }, { category, symbol: symbolFor(category), receivedAt: NOW + 1 }).assets[0];
}
function frame(category: BybitCategory, type = 'snapshot', fields: Record<string, unknown> = {}) {
  const symbol = symbolFor(category);
  return { topic: 'orderbook.1000.' + symbol, type, ts: NOW + 2, data: { s: symbol, category, u: 10, seq: 100, b: [['100', '2000']], a: [['101', '3000']], ...fields } };
}

test('Bybit family descriptors select exact public endpoints while preserving default linear identity', () => {
  assert.equal(bybitInstrumentId('btc-usdt'), 'bybit:BTCUSDT');
  assert.equal(bybitInstrumentId('BTCUSDT', 'spot'), 'bybit:BTCUSDT:spot');
  assert.equal(bybitInstrumentId('BTCUSD', 'inverse'), 'bybit:BTCUSD');
  assert.notEqual(bybitInstrumentId('BTCUSDT', 'spot'), bybitInstrumentId('BTCUSDT'));
  for (const category of CATEGORIES) {
    const symbol = symbolFor(category), metadata = metadataFor(category);
    const instruments = new URL(buildBybitRequest('instruments', { category, symbol }).url);
    assert.equal(instruments.origin, 'https://api.bybit.com'); assert.equal(instruments.pathname, '/v5/market/instruments-info');
    assert.equal(instruments.searchParams.get('category'), category); assert.equal(instruments.searchParams.get('symbol'), symbol);
    const depth = new URL(buildBybitRequest('depth', { category, symbol, metadata, limit: 50 }).url);
    assert.equal(depth.pathname, '/v5/market/orderbook'); assert.equal(depth.searchParams.get('category'), category);
    assert.deepEqual(buildBybitSubscription('depth', { category, symbol, metadata }), { url: 'wss://stream.bybit.com/v5/public/' + category, method: 'subscribe', args: ['orderbook.1000.' + symbol], topic: 'orderbook.1000.' + symbol });
  }
  assert.throws(() => bybitInstrumentId('BTCUSDT', 'option'), /Unsupported Bybit category/);
  for (const symbol of [true, {}, [], '', 'BTC.USDT', 'x'.repeat(65)]) assert.throws(() => bybitInstrumentId(symbol), /Invalid Bybit symbol/);
  assert.throws(() => buildBybitRequest('openInterest', { category: 'spot', symbol: 'BTCUSDT' }), /spot does not provide/);
  assert.throws(() => buildBybitRequest('instruments', { category: 'spot', symbol: 'BTCUSDT', limit: 1 }), /do not support/);
  for (const limit of [0, -1, 0.5, NaN, Infinity, 1001]) assert.throws(() => buildBybitRequest('depth', { symbol: 'BTCUSDT', limit }), /supported bound/);
  assert.throws(() => buildBybitRequest('openInterest', { symbol: 'BTCUSDT', limit: 201 }), /supported bound/);
  assert.throws(() => buildBybitRequest('depth', { symbol: 'BTCUSDT', startTime: 20, endTime: 10 }), /inverted/);
});

test('selected Bybit metadata establishes tick, native lot, family, base/quote/settlement and activity without ticker guesses', () => {
  const spot = metadataFor('spot'), linear = metadataFor('linear'), inverse = metadataFor('inverse');
  assert.deepEqual([spot.instrumentId, spot.marketType, spot.category, spot.quantityUnit, spot.qtyStep, spot.lotSize, spot.settleCoin, spot.inverse], ['bybit:BTCUSDT:spot', 'spot', 'spot', 'base', 0.000001, 0.000001, null, false]);
  assert.deepEqual([linear.instrumentId, linear.marketType, linear.quantityUnit, linear.settleCoin, linear.inverse], ['bybit:BTCUSDT', 'perpetual', 'base', 'USDT', false]);
  assert.deepEqual([inverse.instrumentId, inverse.marketType, inverse.category, inverse.quantityUnit, inverse.base, inverse.quote, inverse.settleCoin, inverse.inverse], ['bybit:BTCUSD', 'perpetual', 'inverse', 'quote', 'BTC', 'USD', 'BTC', true]);
  for (const asset of [spot, linear, inverse]) { assert.equal(asset.tickSize, 0.1); assert.equal(asset.status, 'Trading'); assert.equal(asset.isDelisted, false); }
});

test('selected inactive products remain explicit metadata and cannot be used for new depth or subscriptions', () => {
  for (const category of CATEGORIES) for (const status of ['PreLaunch', 'PendingOpen', 'Delivering', 'Closed']) {
    const inactive = metadataFor(category, { status });
    assert.equal(inactive.status, status); assert.equal(inactive.isDelisted, true); assert.equal(inactive.instrumentId, bybitInstrumentId(symbolFor(category), category));
    assert.throws(() => normalizeBybitDepth(frame(category), { category, metadata: inactive }), /active verified family metadata/);
    assert.throws(() => buildBybitSubscription('depth', { category, symbol: symbolFor(category), metadata: inactive }), /active verified family metadata/);
  }
});

test('selected metadata is bounded and rejects duplicate identity, foreign family, unsafe filters and missing unit contracts', () => {
  for (const category of CATEGORIES) {
    const payload = (rows: unknown[], responseCategory: string = category) => ({ retCode: 0, result: { category: responseCategory, list: rows } });
    const options = { category, symbol: symbolFor(category), receivedAt: NOW };
    assert.throws(() => normalizeBybitInstrumentInfo(payload([instrumentRow(category)], category === 'spot' ? 'linear' : 'spot'), options), /category mismatch/);
    assert.throws(() => normalizeBybitInstrumentInfo(payload([instrumentRow(category), instrumentRow(category)]), options), /duplicated/);
    for (const tickSize of [undefined, true, false, '', '0x10', 0, -1, Infinity]) assert.throws(() => normalizeBybitInstrumentInfo(payload([instrumentRow(category, { priceFilter: { tickSize } })]), options), /tickSize/);
    const key = category === 'spot' ? 'basePrecision' : 'qtyStep';
    for (const step of [undefined, [], {}, true, 0]) assert.throws(() => normalizeBybitInstrumentInfo(payload([instrumentRow(category, { lotSizeFilter: { [key]: step } })]), options), /basePrecision|qtyStep/);
    assert.throws(() => normalizeBybitInstrumentInfo(payload([instrumentRow(category, { baseCoin: 'ETH' })]), options), /family\/settlement/);
    assert.throws(() => normalizeBybitInstrumentInfo(payload([instrumentRow(category, { category: 'option' })]), options), /category mismatch/);
    assert.throws(() => normalizeBybitInstrumentInfo(payload([instrumentRow(category, { status: '' })]), options), /status/);
    assert.equal(normalizeBybitInstrumentInfo(payload([]), options).assets.length, 0);
  }
  assert.throws(() => metadataFor('inverse', { settleCoin: 'USD' }), /family\/settlement/);
  assert.throws(() => metadataFor('inverse', { contractType: 'LinearPerpetual' }), /contract\/category/);
  assert.throws(() => metadataFor('inverse', { contractType: 'InverseFutures' }), /contract\/category/);
  assert.throws(() => normalizeBybitInstrumentInfo({ result: { list: [instrumentRow('spot')] } }, { category: 'spot', symbol: 'BTCUSDT' }), /category mismatch/);
  assert.throws(() => normalizeBybitInstrumentInfo({ result: { category: 'spot', list: Array.from({ length: MAX_BYBIT_INSTRUMENT_ROWS + 1 }, () => ({})) } }, { category: 'spot', symbol: 'BTCUSDT' }), /bounded row limit/);
  const unrelated = { symbol: 'BROKEN!<>', priceFilter: { tickSize: false } };
  assert.equal(normalizeBybitInstrumentInfo({ result: { category: 'spot', list: [unrelated, instrumentRow('spot')] } }, { category: 'spot', symbol: 'BTCUSDT' }).assets.length, 1, 'unrequested products do not poison a valid selected product');
});

test('spot and inverse books preserve native quantities through the actual USD valuation boundary', () => {
  for (const category of CATEGORIES) {
    const metadata = metadataFor(category);
    const snapshot = normalizeBybitDepth(frame(category), { category, symbol: symbolFor(category), metadata, receivedAt: NOW + 3 });
    assert.equal(snapshot.instrumentId, metadata.instrumentId); assert.equal(snapshot.market.tickSize, metadata.tickSize);
    assert.equal(snapshot.units, metadata.quantityUnit); assert.equal(snapshot.inverse, metadata.inverse); assert.equal(snapshot.coverage, 'partial');
    assert.deepEqual(snapshot.bids, [{ price: 100, amount: 2000 }]);
    const valued = usdBookLevels(snapshot);
    assert.equal(valued[0].notionalUsd, category === 'inverse' ? 2000 : 200000);
    assert.equal(valued[0].baseAmount, category === 'inverse' ? 20 : 2000);
    assert.equal(snapshot.sourceTimestamp, NOW + 2); assert.equal(snapshot.receivedAt, NOW + 3);
  }
  assert.throws(() => normalizeBybitDepth(frame('inverse'), { category: 'inverse' }), /metadata/);
  assert.throws(() => normalizeBybitDepth(frame('spot'), { category: 'spot' }), /metadata/);
  assert.throws(() => normalizeBybitDepth({ result: { s: 'BTCUSD', u: 1, b: [], a: [] } }), /unknown quantity basis/);
});

test('family depth rejects foreign category, symbol, topic and mutated metadata even under an explicitly requested identity', () => {
  for (const category of CATEGORIES) {
    const metadata = metadataFor(category), options = { category, symbol: symbolFor(category), metadata };
    assert.throws(() => normalizeBybitDepth(frame(category, 'snapshot', { s: 'ETHUSDT' }), options), /instrument\/symbol mismatch/);
    assert.throws(() => normalizeBybitDepth(frame(category, 'snapshot', { category: 'option' }), options), /category mismatch/);
    assert.throws(() => normalizeBybitDepth({ ...frame(category), category: 'option' }, options), /category mismatch/);
    assert.throws(() => normalizeBybitDepth({ ...frame(category), topic: 'orderbook.1000.ETHUSDT' }, options), /topic\/instrument mismatch/);
    for (const changed of [{ category: 'option' }, { inverse: !metadata.inverse }, { quantityUnit: 'contract' }, { instrumentId: 'bybit:FOREIGN' }, { tickSize: false }, { qtyStep: 0 }, { nativeSymbol: 'ETHUSDT' }]) assert.throws(() => normalizeBybitDepth(frame(category), { ...options, metadata: { ...metadata, ...changed } }), /metadata/);
    const before = structuredClone(metadata);
    normalizeBybitDepth(frame(category), options); assert.deepEqual(metadata, before);
  }
});

test('all family depths reject coercible wire values and over-cap books before retaining rows', () => {
  for (const category of CATEGORIES) {
    const options = { category, metadata: metadataFor(category) };
    for (const value of [true, false, '', '0x10', [], {}]) {
      assert.throws(() => normalizeBybitDepth(frame(category, 'snapshot', { b: [[value, '1']] }), options), /price/);
      assert.throws(() => normalizeBybitDepthDelta(frame(category, 'delta', { b: [['100', value]] }), options), /amount/);
    }
    for (const u of [true, false, {}, [], '', 0, -1, Number.MAX_SAFE_INTEGER + 1, '1'.repeat(65)]) assert.throws(() => normalizeBybitDepth(frame(category, 'snapshot', { u }), options), /update id|unsafe numeric/);
    assert.throws(() => normalizeBybitDepth(frame(category, 'snapshot', { b: [['100', '1'], ['100', '2']] }), options), /duplicate price/);
    assert.throws(() => normalizeBybitDepth(frame(category, 'snapshot', { b: Array.from({ length: MAX_BYBIT_DEPTH_ROWS + 1 }, (_, i) => [String(i + 1), '1']) }), options), /bounded row limit/);
    assert.throws(() => normalizeBybitDepth({ ...frame(category), ts: false }, options), /timestamp/);
    assert.throws(() => normalizeBybitDepth({ ...frame(category), retCode: false }, options), /return code/);
  }
});

test('spot and inverse delta state keeps native units, exact wide IDs, deletion semantics and fresh reset recovery', () => {
  for (const category of ['spot', 'inverse'] as const) {
    const options = { category, metadata: metadataFor(category) };
    const snapshot = normalizeBybitDepth(frame(category, 'snapshot', { u: '9007199254740993', seq: '9007199254741993' }), options);
    const delta = normalizeBybitDepthDelta(frame(category, 'delta', { u: '9007199254740995', seq: '9007199254741995', b: [['100', '0'], ['99', '4000']], a: [['101', '5000']] }), options);
    const applied = applyBybitDepthDelta(snapshot, delta);
    assert.equal(applied.sequence, '9007199254740995'); assert.equal(applied.crossSequence, '9007199254741995'); assert.equal(applied.units, category === 'inverse' ? 'quote' : 'base');
    assert.deepEqual(applied.bids, [{ price: 99, amount: 4000 }]); assert.deepEqual(applied.asks, [{ price: 101, amount: 5000 }]); assert.equal(applied.continuity, 'unproven'); assert.equal(applied.sequenceJump, true);
    assert.equal(applyBybitDepthDelta(applied, delta).ignored, true);
    const invalid = invalidateBybitDepthState(applied), newer = normalizeBybitDepthDelta(frame(category, 'delta', { u: '9007199254740996' }), options);
    assert.equal(applyBybitDepthDelta(invalid, newer).resyncRequired, true);
    const reset = normalizeBybitDepth(frame(category, 'snapshot', { u: 1, seq: 1, b: [['90', '6']], a: [['91', '7']] }), options), restored = applyBybitDepthUpdate(invalid, reset);
    assert.equal(restored.sequence, 1); assert.equal(restored.complete, true); assert.equal(restored.resyncRequired, false); assert.equal(restored.units, snapshot.units);
    assert.deepEqual(restored.bids, [{ price: 90, amount: 6 }]);
    assert.throws(() => applyBybitDepthDelta({ ...snapshot, units: 'contract' }, delta), /unit mismatch/);
  }
  const spot = normalizeBybitDepth(frame('spot'), { category: 'spot', metadata: metadataFor('spot') });
  const linear = normalizeBybitDepthDelta(frame('linear', 'delta'));
  assert.throws(() => applyBybitDepthDelta(spot, linear), /instrument mismatch/);
});

test('inverse OI and candles carry native quote units and never relabel USD quantity as base', () => {
  const metadata = metadataFor('inverse'), payload = { result: { category: 'inverse', symbol: 'BTCUSD', list: [{ openInterest: '2000', timestamp: NOW, markPrice: '100' }] } };
  const oi = normalizeBybitOpenInterest(payload, { category: 'inverse', symbol: 'BTCUSD', metadata });
  assert.equal(oi.base, 20); assert.equal(oi.quote, 2000); assert.equal(oi.units, 'quote'); assert.equal(oi.inverse, true);
  assert.throws(() => normalizeBybitOpenInterest({ result: { category: 'inverse', symbol: 'BTCUSD', list: [{ openInterest: '2000', timestamp: NOW }] } }, { category: 'inverse', metadata }), /observed mark price/);
  assert.throws(() => normalizeBybitOpenInterest({ result: { category: 'inverse', symbol: 'BTCUSD', list: [{ openInterest: '1e308', timestamp: NOW, markPrice: '1e-308' }] } }, { category: 'inverse', metadata }), /conversion overflow/);
  const candle = normalizeBybitKline([String(NOW), '100', '110', '90', '105', '2000', '20'], { category: 'inverse', symbol: 'BTCUSD', metadata, interval: '1h' });
  assert.equal(candle.volume, 2000); assert.equal(candle.volumeUnits, 'quote'); assert.equal(candle.instrumentId, 'bybit:BTCUSD');
  assert.throws(() => normalizeBybitKline({ open: 1, high: 2, low: 1, close: 2 }, { symbol: 'BTCUSDT' }), /kline start/);
});

test('OI and candle family identity cannot override foreign declared symbols or acquire an unverified inverse basis', () => {
  for (const category of CATEGORIES) {
    const metadata = metadataFor(category), symbol = symbolFor(category), options = { category, symbol, metadata, receivedAt: NOW };
    const candle = { symbol: 'ETHUSDT', start: NOW, open: 100, high: 110, low: 90, close: 105, volume: 2 };
    assert.throws(() => normalizeBybitKline(candle, options), /kline instrument mismatch/);
    assert.throws(() => normalizeBybitKline({ symbol, kline: candle }, options), /kline instrument mismatch/);
    if (category === 'spot') continue;
    const oiRow = { symbol: 'ETHUSDT', category, openInterest: '2', timestamp: NOW, markPrice: '100' };
    assert.throws(() => normalizeBybitOpenInterest({ result: { category, symbol, list: [oiRow] } }, options), /OI instrument mismatch/);
    assert.throws(() => normalizeBybitOpenInterest({ result: { category, symbol, list: [{ ...oiRow, symbol, category: 'spot' }] } }, options), /category mismatch/);
  }
  assert.throws(() => normalizeBybitOpenInterest({ result: { symbol: 'BTCUSD', list: [{ openInterest: '2', timestamp: NOW }] } }), /unknown quantity basis/);
  assert.throws(() => normalizeBybitKline([NOW, 100, 110, 90, 105, 2], { symbol: 'BTCUSD' }), /unknown quantity basis/);
});
test('connector family support remains inert without explicit network opt-in and injected transport', async () => {
  let calls = 0;
  const transport = { request: async () => { calls++; }, subscribe: async () => { calls++; } };
  const connector = new BybitConnector({ transport });
  for (const category of CATEGORIES) {
    await assert.rejects(connector.request('depth', { category, symbol: symbolFor(category) }), /network disabled/);
    await assert.rejects(connector.subscribe('depth', { category, symbol: symbolFor(category) }), /network disabled/);
  }
  assert.equal(calls, 0);
});
test('USDC linear perpetuals preserve their exact PERP native symbol with verified settlement through metadata and depth', () => {
  const row=instrumentRow('linear',{symbol:'BTCPERP',quoteCoin:'USDC',settleCoin:'USDC'});
  const meta=normalizeBybitInstrumentInfo({retCode:0,result:{category:'linear',list:[row]}},{category:'linear',symbol:'BTCPERP',receivedAt:NOW}).assets[0];
  assert.equal(meta.instrumentId,'bybit:BTCPERP');assert.equal(meta.quote,'USDC');assert.equal(meta.settleCoin,'USDC');
  const book=normalizeBybitDepth({topic:'orderbook.1000.BTCPERP',type:'snapshot',ts:NOW,data:{s:'BTCPERP',u:1,seq:1,b:[['100','2']],a:[['101','3']]}},{category:'linear',symbol:'BTCPERP',metadata:meta});
  assert.equal(book.instrumentId,'bybit:BTCPERP');assert.equal(usdBookLevels({...book,market:{...meta}}).reduce((total,level)=>total+level.notionalUsd,0),503);
  assert.equal(new URL(buildBybitRequest('depth',{category:'linear',symbol:'BTCPERP',metadata:meta}).url).searchParams.get('symbol'),'BTCPERP');
  assert.throws(()=>normalizeBybitDepth({data:{s:'BTCPERP',u:1,b:[],a:[]}},{category:'linear',symbol:'BTCPERP',metadata:{...meta,settleCoin:'USDT'}}),/verified family metadata/);
  assert.throws(()=>normalizeBybitInstrumentInfo({result:{category:'linear',list:[{...row,settleCoin:'USDT'}]}},{category:'linear',symbol:'BTCPERP'}),/settlement metadata mismatch/);
});
