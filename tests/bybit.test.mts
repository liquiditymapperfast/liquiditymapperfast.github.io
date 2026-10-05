import test from 'node:test';
import assert from 'node:assert/strict';
import {
  AdapterTransportError, BybitConnector, buildBybitRequest, buildBybitSubscription,
  applyBybitDepthDelta, applyBybitDepthUpdate, invalidateBybitDepthState, normalizeBybitDepth, normalizeBybitDepthDelta, normalizeBybitInstrumentInfo, normalizeBybitKline, normalizeBybitOpenInterest,
} from '../src/adapters/index.mts';

const NOW = 1_700_000_000_100;

test('Bybit linear descriptors use public V5 endpoints and deterministic topics', () => {
  assert.match(buildBybitRequest('instruments', { category: 'linear' }).url, /api\.bybit\.com\/v5\/market\/instruments-info\?category=linear$/);
  assert.match(buildBybitRequest('depth', { symbol: 'BTCUSDT', limit: 50 }).url, /v5\/market\/orderbook\?category=linear&symbol=BTCUSDT&limit=50$/);
  assert.match(buildBybitRequest('klines', { symbol: 'BTCUSDT', interval: '1h', limit: 3, startTime: 100, endTime: 200 }).url, /v5\/market\/kline\?category=linear&symbol=BTCUSDT&interval=60&limit=3&start=100&end=200$/);
  assert.match(buildBybitRequest('openInterest', { symbol: 'BTCUSDT', intervalTime: '5min', limit: 2 }).url, /v5\/market\/open-interest\?category=linear&symbol=BTCUSDT&intervalTime=5min&limit=2$/);
  assert.deepEqual(buildBybitSubscription('depth', { symbol: 'BTCUSDT' }), { url: 'wss://stream.bybit.com/v5/public/linear', method: 'subscribe', args: ['orderbook.1000.BTCUSDT'], topic: 'orderbook.1000.BTCUSDT' });
  assert.equal(buildBybitSubscription('kline', { symbol: 'BTCUSDT', interval: '1h' }).topic, 'kline.60.BTCUSDT');
  const spot = normalizeBybitInstrumentInfo({ result: { category: 'spot', list: [{ symbol: 'BTCUSDT', baseCoin: 'BTC', quoteCoin: 'USDT', status: 'Trading', priceFilter: { tickSize: '0.1' }, lotSizeFilter: { basePrecision: '0.000001' } }] } }, { category: 'spot', symbol: 'BTCUSDT' }).assets[0];
  assert.match(buildBybitRequest('depth', { category: 'spot', symbol: 'BTCUSDT', metadata: spot }).url, /category=spot&symbol=BTCUSDT/);
  assert.throws(() => buildBybitRequest('depth', { category: 'option', symbol: 'BTCUSDT' }), /Unsupported Bybit category/);
  assert.throws(() => buildBybitRequest('klines', { symbol: 'BTCUSDT' }), /interval is required/);
  assert.throws(() => buildBybitRequest('klines', { symbol: 'BTCUSDT', interval: '45s' }), /Unsupported Bybit interval/);
  assert.throws(() => buildBybitRequest('depth', {}), /requires symbol/);
});

test('Bybit linear product metadata preserves filters and excludes non-perpetual rows', () => {
  const metadata = normalizeBybitInstrumentInfo({ time: NOW, result: { list: [
    { symbol: 'BTCUSDT', baseCoin: 'BTC', quoteCoin: 'USDT', settleCoin: 'USDT', contractType: 'LinearPerpetual', status: 'Trading', priceFilter: { tickSize: '0.1' }, lotSizeFilter: { qtyStep: '0.001' } },
    { symbol: 'BTCUSDT-30DEC30', contractType: 'LinearFutures', status: 'Trading', priceFilter: { tickSize: '0.1' } },
    { symbol: 'ETHUSDT', contractType: 'LinearPerpetual', status: 'PreLaunch', priceFilter: { tickSize: '0.01' } },
  ] } }, { receivedAt: NOW + 1 });
  assert.equal(metadata.venue, 'bybit'); assert.equal(metadata.assets.length, 1);
  assert.deepEqual(metadata.assets[0], { instrumentId: 'bybit:BTCUSDT', venue: 'bybit', category: 'linear', symbol: 'BTCUSDT', nativeSymbol: 'BTCUSDT', base: 'BTC', quote: 'USDT', marketType: 'perpetual', tickSize: 0.1, quantityUnit: 'base', qtyStep: 0.001, lotSize: 0.001, inverse: false, contractType: 'LinearPerpetual', status: 'Trading', isDelisted: false, settleCoin: 'USDT' });
  assert.throws(() => normalizeBybitInstrumentInfo({ result: { category: 'spot', list: [] } }), /category mismatch/);
  assert.throws(() => normalizeBybitInstrumentInfo({ result: { list: [{ symbol: 'ETHUSDT', baseCoin: 'ETH', quoteCoin: 'USDT', settleCoin: 'USDT', contractType: 'LinearPerpetual', status: 'Trading', priceFilter: { tickSize: '0' }, lotSizeFilter: { qtyStep: '0.001' } }] } }), /tickSize/);
});

test('Bybit linear depth, candles, and OI normalize native public shapes', () => {
  const depth = normalizeBybitDepth({ time: NOW, result: { s: 'BTCUSDT', ts: NOW, u: 42, b: [['100', '2']], a: [['101', '3']] } }, { receivedAt: NOW + 1 });
  assert.equal(depth.instrumentId, 'bybit:BTCUSDT'); assert.equal(depth.sequence, 42); assert.equal(depth.market.base, 'BTC'); assert.equal(depth.market.tickSize, null); assert.equal(depth.market.quantityUnit, 'base'); assert.deepEqual(depth.bids, [{ price: 100, amount: 2 }]);
  const candle = normalizeBybitKline(['1700000000000', '100', '110', '90', '105', '42'], { symbol: 'BTCUSDT', interval: '1h' });
  assert.deepEqual({ start: candle.start, end: candle.end, open: candle.open, high: candle.high, low: candle.low, close: candle.close, volume: candle.volume }, { start: 1700000000000, end: 1700003600000, open: 100, high: 110, low: 90, close: 105, volume: 42 });
  assert.equal(normalizeBybitKline(['1700000000000', '100', '110', '90', '105', '42'], { symbol: 'BTCUSDT', interval: '60' }).interval, '1h');
  assert.equal(normalizeBybitKline(['1700000000000', '100', '110', '90', '105', '42'], { symbol: 'BTCUSDT', interval: 'D' }).interval, '1d');
  const oi = normalizeBybitOpenInterest({ result: { category: 'linear', symbol: 'BTCUSDT', list: [{ openInterest: '10', timestamp: '1700000000000', markPrice: '100' }] } }, { receivedAt: NOW });
  assert.equal(oi.instrumentId, 'bybit:BTCUSDT'); assert.equal(oi.base, 10); assert.equal(oi.quote, 1000); assert.equal(oi.sourceTimestamp, 1700000000000);
  assert.throws(() => normalizeBybitDepth({ retCode: 10001, retMsg: 'bad request', result: {} }, { symbol: 'BTCUSDT' }), /provider error 10001/);
  assert.throws(() => normalizeBybitDepth({ type: 'delta', ts: NOW, data: { s: 'BTCUSDT', b: [], a: [] } }), /delta/);
  assert.equal(normalizeBybitDepth({ type: 'snapshot', ts: NOW + 5, data: { s: 'BTCUSDT', u: 9, b: [['100', '1']], a: [['101', '1']] } }).sourceTimestamp, NOW + 5);
  assert.throws(() => normalizeBybitOpenInterest({ retCode: 10001, retMsg: 'bad request', result: {} }, { symbol: 'BTCUSDT' }), /provider error 10001/);
  assert.throws(() => normalizeBybitDepth({ result: { category: 'inverse', s: 'BTCUSDT', b: [], a: [] } }), /category mismatch/);
  assert.throws(() => normalizeBybitOpenInterest({ result: { category: 'inverse', symbol: 'BTCUSDT', list: [{ openInterest: '1' }] } }), /category mismatch/);
  assert.throws(() => normalizeBybitKline({ retCode: 10001, retMsg: 'bad request' }, { symbol: 'BTCUSDT' }), /provider error 10001/);
});

test('Bybit depth preserves wide update/cross sequence tokens without numeric truncation', () => {
  const snapshot = normalizeBybitDepth({ type: 'snapshot', data: { category: 'linear', s: 'BTCUSDT', u: '9007199254740993', seq: '9007199254740995', b: [['100', '2']], a: [['101', '3']] } });
  assert.equal(snapshot.sequence, '9007199254740993');
  assert.equal(snapshot.crossSequence, '9007199254740995');
  const delta = normalizeBybitDepthDelta({ type: 'delta', data: { category: 'linear', s: 'BTCUSDT', u: '9007199254740994', seq: '9007199254740996', b: [['99', '1']], a: [['101', '0']] } });
  const applied = applyBybitDepthDelta(snapshot, delta);
  assert.equal(applied.sequence, '9007199254740994');
  assert.equal(applied.crossSequence, '9007199254740996');
  assert.deepEqual(applied.bids, [{ price: 100, amount: 2 }, { price: 99, amount: 1 }]);
  assert.deepEqual(applied.asks, []);
  assert.equal(applied.continuity, 'unproven');
});

test('Bybit snapshots fail closed when update ID is missing or unsafe', () => {
  for (const u of [undefined, null, '', Number.MAX_SAFE_INTEGER + 2]) {
    assert.throws(() => normalizeBybitDepth({ type: 'snapshot', data: { category: 'linear', s: 'BTCUSDT', u, b: [['100', '2']], a: [['101', '3']] } }), /update id|unsafe numeric/);
  }
});

test('Bybit snapshot replacement handles restart u=1 and exact row totals', () => {
  const first = normalizeBybitDepth({ type: 'snapshot', data: { category: 'linear', s: 'BTCUSDT', u: 42, b: [['100', '2'], ['99', '1']], a: [['101', '3'], ['102', '4']] } });
  const delta = normalizeBybitDepthDelta({ type: 'delta', data: { category: 'linear', s: 'BTCUSDT', u: 43, b: [['100', '0'], ['98', '4']], a: [['101', '0'], ['103', '5']] } });
  const changed = applyBybitDepthDelta(first, delta);
  assert.deepEqual(changed.bids, [{ price: 99, amount: 1 }, { price: 98, amount: 4 }]);
  assert.deepEqual(changed.asks, [{ price: 102, amount: 4 }, { price: 103, amount: 5 }]);
  assert.equal(changed.bids.reduce((sum, row) => sum + row.amount, 0), 5);
  assert.equal(changed.asks.reduce((sum, row) => sum + row.amount, 0), 9);
  const restarted = normalizeBybitDepth({ type: 'snapshot', data: { category: 'linear', s: 'BTCUSDT', u: 1, b: [['90', '6']], a: [['91', '7']] } });
  const replaced = applyBybitDepthUpdate(changed, restarted);
  assert.deepEqual(replaced.bids, [{ price: 90, amount: 6 }]);
  assert.deepEqual(replaced.asks, [{ price: 91, amount: 7 }]);
  assert.equal(replaced.sequence, 1);
  assert.equal(replaced.complete, true);
  assert.equal(replaced.continuity, undefined);
});

test('Bybit depth deltas accept newer IDs without fabricating continuity and require fresh snapshots after invalidation', () => {
  const snapshot = normalizeBybitDepth({ type: 'snapshot', ts: NOW, data: { category: 'linear', s: 'BTCUSDT', u: 10, b: [['100', '2'], ['99', '1']], a: [['101', '3']] } });
  const delta = normalizeBybitDepthDelta({ type: 'delta', ts: NOW + 1, data: { category: 'linear', s: 'BTCUSDT', u: 11, b: [['100', '0'], ['98', '4']], a: [['101', '5']] } });
  const applied = applyBybitDepthDelta(snapshot, delta);
  assert.equal(applied.sequence, 11); assert.deepEqual(applied.bids, [{ price: 99, amount: 1 }, { price: 98, amount: 4 }]); assert.deepEqual(applied.asks, [{ price: 101, amount: 5 }]);
  const duplicate = applyBybitDepthDelta(applied, delta); assert.equal(duplicate.ignored, true); assert.equal(duplicate.sequence, 11);
  const jump = applyBybitDepthDelta(applied, normalizeBybitDepthDelta({ type: 'delta', data: { s: 'BTCUSDT', u: 13, seq: 77, b: [['98', '0']], a: [] } })); assert.equal(jump.sequence, 13); assert.equal(jump.sequenceJump, true); assert.equal(jump.continuity, 'unproven'); assert.equal(jump.resyncRequired, false);
  const invalid = invalidateBybitDepthState(jump, 'socket closed');
  const invalidDuplicate = applyBybitDepthDelta(invalid, delta); assert.equal(invalidDuplicate.resyncRequired, true); assert.equal(invalidDuplicate.invalidated, true); assert.equal(invalidDuplicate.complete, false);
  const blocked = applyBybitDepthDelta(invalid, normalizeBybitDepthDelta({ type: 'delta', data: { s: 'BTCUSDT', u: 14, b: [], a: [] } })); assert.equal(blocked.resyncRequired, true); assert.equal(blocked.gap, true);
  const fresh = applyBybitDepthUpdate(invalid, normalizeBybitDepth({ type: 'snapshot', data: { category: 'linear', s: 'BTCUSDT', u: 1, b: [['90', '2']], a: [['91', '3']] } })); assert.equal(fresh.sequence, 1); assert.equal(fresh.complete, true); assert.equal(fresh.resyncRequired, false); assert.deepEqual(fresh.bids, [{ price: 90, amount: 2 }]);
  assert.throws(() => normalizeBybitDepthDelta({ type: 'snapshot', data: { s: 'BTCUSDT', u: 12, b: [], a: [] } }), /requires type=delta/);
  assert.throws(() => normalizeBybitDepthDelta({ type: 'delta', result: { category: 'inverse', s: 'BTCUSDT', u: 12, b: [], a: [] } }), /category mismatch/);
  assert.throws(() => normalizeBybitDepthDelta({ type: 'delta', data: { s: 'BTCUSDT', u: 'bad', b: [], a: [] } }), /update id/);
  assert.throws(() => normalizeBybitDepthDelta({ retCode: 10001, retMsg: 'bad', type: 'delta', data: {} }), /provider error/);
});

test('Bybit connector is disabled by default', async () => {
  const connector = new BybitConnector({ transport: { request: async request => request } });
  await assert.rejects(() => connector.request('depth', { symbol: 'BTCUSDT' }), AdapterTransportError);
});
