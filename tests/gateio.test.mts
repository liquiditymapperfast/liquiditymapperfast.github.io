import test from 'node:test';
import assert from 'node:assert/strict';
import {
  AdapterTransportError,
  GateIoConnector,
  buildGateRequest,
  buildGateSubscription,
  normalizeGateContractInfo,
  normalizeGateDepth,
  createPublicDepthSession,
  applyPublicDepthSessionMessage,
} from '../src/adapters/index.mts';

const NOW = 1_700_000_000_100;

test('Gate.io USDT futures descriptors use bounded public order-book endpoints', () => {
  assert.match(buildGateRequest('contracts', { contract: 'BTC_USDT' }).url, /api\/v4\/futures\/usdt\/contracts\/BTC_USDT$/);
  assert.match(buildGateRequest('depth', { contract: 'BTC_USDT', limit: 100 }).url, /api\/v4\/futures\/usdt\/order_book\?contract=BTC_USDT&limit=100&with_id=true$/);
  assert.deepEqual(buildGateSubscription('depth', { contract: 'BTC_USDT', limit: 100 }), {
    url: 'wss://fx-ws.gateio.ws/v4/ws/usdt', method: 'subscribe', args: ['BTC_USDT', '100', '0'],
    topic: 'futures.order_book:BTC_USDT', channel: 'futures.order_book', contract: 'BTC_USDT',
  });
  assert.throws(() => buildGateSubscription('depth', { contract: 'BTC_USDT', limit: 99 }), /depth level/);
  assert.throws(() => buildGateSubscription('depth', { contract: 'BTC_USDT', interval: '100ms' }), /interval/);
});

test('Gate.io contract metadata preserves contract multiplier and tick size', () => {
  const metadata = normalizeGateContractInfo([
    { name: 'BTC_USDT', status: 'trading', order_price_round: '0.1', order_size_min: '1', quanto_multiplier: '0.0001', settle: 'usdt' },
    { name: '币安人生_USDT', status: 'trading', order_price_round: '0.01', quanto_multiplier: '10', settle: 'usdt' },
    { name: 'ETH_USDT', status: 'delisted', order_price_round: '0.01', quanto_multiplier: '0.01' },
  ], { receivedAt: NOW });
  assert.equal(metadata.assets.length, 1);
  assert.equal(metadata.assets[0].instrumentId, 'gateio:BTC_USDT');
  assert.equal(metadata.assets[0].quantityUnit, 'contract');
  assert.equal(metadata.assets[0].contractValue, 0.0001);
  assert.equal(metadata.assets[0].tickSize, 0.1);
});

test('Gate.io full snapshots normalize object levels and retain safe sequence ids', () => {
  const snapshot = normalizeGateDepth({
    channel: 'futures.order_book', event: 'all', time_ms: NOW,
    result: { t: NOW, contract: 'BTC_USDT', id: '9007199254740993', asks: [{ p: '101', s: '3' }], bids: [{ p: '100', s: '2' }] },
  }, { receivedAt: NOW + 1 });
  assert.equal(snapshot.instrumentId, 'gateio:BTC_USDT');
  assert.equal(snapshot.market.quantityUnit, 'contract');
  assert.equal(snapshot.sequence, '9007199254740993');
  assert.deepEqual(snapshot.asks, [{ price: 101, amount: 3 }]);
  assert.deepEqual(snapshot.bids, [{ price: 100, amount: 2 }]);
  const next = normalizeGateDepth({
    channel: 'futures.order_book', event: 'all',
    result: { t: NOW + 100, contract: 'BTC_USDT', id: '9007199254740994', asks: [], bids: [{ p: '99', s: '4' }] },
  });
  assert.equal(next.sequence, '9007199254740994');
  assert.deepEqual(next.bids, [{ price: 99, amount: 4 }]);
});

test('Gate.io update frames can be checked with the shared strict public-depth session', () => {
  let session = createPublicDepthSession({ venue: 'gateio', topic: 'futures.order_book:BTC_USDT', instrumentId: 'gateio:BTC_USDT', sessionToken: 's1' });
  const snapshot = normalizeGateDepth({ event: 'all', result: { contract: 'BTC_USDT', id: '10', asks: [['101', '3']], bids: [['100', '2']] } });
  let routed = applyPublicDepthSessionMessage(session, { topic: session.topic, sessionToken: 's1', update: snapshot });
  assert.equal(routed.accepted, true); session = routed.session;
  const update = normalizeGateDepth({ event: 'update', result: { contract: 'BTC_USDT', U: '11', u: '11', asks: [{ p: '101', s: '0' }], bids: [{ p: '99', s: '4' }] } });
  routed = applyPublicDepthSessionMessage(session, { topic: session.topic, sessionToken: 's1', update });
  assert.equal(routed.accepted, true);
  assert.ok(routed.session.book); assert.deepEqual(routed.session.book.bids, [{ price: 100, amount: 2 }, { price: 99, amount: 4 }]);
  assert.ok(routed.session.book); assert.deepEqual(routed.session.book.asks, []);
  assert.throws(() => normalizeGateDepth({ event: 'update', result: { contract: 'BTC_USDT', U: Number.MAX_SAFE_INTEGER + 2, u: '12', asks: [], bids: [] } }), /unsafe numeric/);
});

test('Gate.io connector remains disabled without explicit network opt-in', async () => {
  await assert.rejects(() => new GateIoConnector({ transport: { request: async request => request } }).request('depth', { contract: 'BTC_USDT' }), AdapterTransportError);
  await assert.rejects(() => new GateIoConnector({ transport: { subscribe: async request => request } }).subscribe('depth', { contract: 'BTC_USDT' }), AdapterTransportError);
});
