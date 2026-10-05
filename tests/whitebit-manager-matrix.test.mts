import { defined, fields, list, numeric, textValue } from './server-test-helpers.mts';
import type { LiveFeedTransportOptions, LiveFeedSocket, LiveFeedEvent, LiveFeedStatusEvent } from '../src/server/live-feeds.mts';
import type { ExchangeRestRequest } from '../src/server/rest-transport.mts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { LiveFeedManager } from '../src/server/live-feeds.mts';
import {
  VENUE_TRANSPORT_POLICIES,
  applyPublicDepthSessionMessage,
  buildWhitebitRequest,
  buildWhitebitSubscription,
  createPublicDepthSession,
  normalizeWhitebitDepth,
  normalizeWhitebitMarkets,
} from '../src/adapters/index.mts';

class FakeSocket {
  declare spec:LiveFeedTransportOptions; declare sent:string[]; declare closed:boolean; declare opened?:boolean;
  declare onMessage:((raw:unknown)=>void)|undefined; declare onClose:((reason:unknown)=>void)|undefined; declare onError:((error:unknown)=>void)|undefined;
  constructor(spec:LiveFeedTransportOptions) { this.spec = spec; this.sent = []; this.closed = false; }
  async open() { this.opened = true; }
  send(value:string) { this.sent.push(value); }
  close() { this.closed = true; }
  emit(value:unknown) { this.onMessage?.(value); }
  closeWith(reason = 'closed') { this.closed = true; this.onClose?.(reason); }
}

function transport() {
  const sockets:FakeSocket[] = [];
  return { sockets, factory: async (spec:LiveFeedTransportOptions) => { const socket = new FakeSocket(spec); sockets.push(socket); return socket; } };
}

function policies() {
  return Object.fromEntries(Object.entries(VENUE_TRANSPORT_POLICIES).map(([venue, policy]) => [venue, { ...policy, subscribeIntervalMs: 0, heartbeatIntervalMs: 60_000, heartbeatTimeoutMs: 60_000 }]));
}

function marketsPayload() {
  return [
    { name: 'BTC_USDT', stock: 'BTC', money: 'USDT', stockPrec: 6, moneyPrec: 2, tickSize: '0.1', stepSize: '0.00001', type: 'spot', tradesEnabled: true },
    { name: 'BTC_PERP', stock: 'BTC', money: 'USDT', stockPrec: -1, moneyPrec: 1, type: 'futures', tradesEnabled: true },
    { name: 'ETH_USDT', stock: 'ETH', money: 'USDT', stockPrec: 5, moneyPrec: 2, type: 'spot', tradesEnabled: false },
  ];
}

function snapshotFrame(sequence = 10, market = 'BTC_USDT') {
  return { id: null, method: 'depth_update', params: [true, { timestamp: 1_700_000_000.123, update_id: sequence, asks: [['101', '2']], bids: [['100', '3']] }, market] as const };
}

function updateFrame(sequence = 11, previous = 10, market = 'BTC_USDT') {
  return { id: null, method: 'depth_update', params: [false, { timestamp: 1_700_000_001.123, update_id: sequence, past_update_id: previous, asks: [['101', '0'], ['102', '1']], bids: [['99', '1']] }, market] as const };
}

function restTransport() {
  const requests:ExchangeRestRequest[] = [];
  return {
    requests,
    request: async (request:ExchangeRestRequest) => {
      requests.push(request);
      if (request.url.endsWith('/markets')) return marketsPayload();
      if (request.url.includes('/exchangeInfo')) return { symbols: [] };
      if (request.url.includes('/fapi/v1/exchangeInfo')) return { symbols: [] };
      if ((typeof request.body === 'string' && request.body.includes('metaAndAssetCtxs'))) return [{ universe: [] }, []];
      return {};
    },
  };
}

test('WhiteBIT descriptors and metadata preserve the official spot/futures units', () => {
  assert.equal(buildWhitebitRequest('markets').url, 'https://whitebit.com/api/v4/public/markets');
  assert.equal(buildWhitebitRequest('depth', { symbol: 'BTC_USDT' }).url, 'https://whitebit.com/api/v4/public/orderbook/BTC_USDT?limit=100&level=2');
  assert.equal(buildWhitebitRequest('depth', { symbol: 'BTC_USDT', depth: 0 }).url, 'https://whitebit.com/api/v4/public/orderbook/BTC_USDT?limit=0&level=2');
  assert.deepEqual(buildWhitebitSubscription('depth', { symbol: 'BTC_USDT', depth: 100, interval: '0' }), {
    url: 'wss://wss.whitebit.com/ws', id: 1, method: 'depth_subscribe', params: ['BTC_USDT', 100, '0', true],
    channel: 'depth_update', topic: 'depth:BTC_USDT', symbol: 'BTC_USDT', depth: 100, interval: '0', snapshot: true,
  });
  assert.throws(() => buildWhitebitSubscription('depth', { symbol: 'BTC_USDT', depth: 2 }), /subscription depth/);
  const metadata = normalizeWhitebitMarkets(marketsPayload(), { symbol: 'BTC_USDT', receivedAt: 1_700_000_000_000 });
  assert.equal(metadata.sourceTimestamp, null);
  assert.equal(metadata.receivedAt, 1_700_000_000_000);
  assert.deepEqual(metadata.assets[0], {
    instrumentId: 'whitebit:BTC_USDT', venue: 'whitebit', nativeSymbol: 'BTC_USDT', symbol: 'BTC_USDT', base: 'BTC', quote: 'USDT', marketType: 'spot', tickSize: 0.1, quantityUnit: 'base', lotSize: 0.00001, isDelisted: false, status: 'online', metadataSource: 'whitebit-v4-markets',
  });
  const futures = normalizeWhitebitMarkets(marketsPayload(), { symbol: 'BTC_PERP' });
  assert.equal(futures.assets[0].marketType, 'perpetual');
  assert.equal(futures.assets[0].lotSize, 10);
  assert.equal(normalizeWhitebitMarkets(marketsPayload()).assets.length, 3);
});

test('WhiteBIT snapshot/update normalization keeps timestamps, IDs, zero deletes, and market fencing', () => {
  const snapshot = normalizeWhitebitDepth(snapshotFrame(), { symbol: 'BTC_USDT', receivedAt: 1_700_000_000_500 });
  assert.equal(snapshot.kind, 'depthSnapshot');
  assert.equal(snapshot.sequence, 10);
  assert.equal(snapshot.sourceTimestamp, 1_700_000_000_123);
  assert.equal(snapshot.market.marketType, 'spot');
  const updateBase = updateFrame();
  const update = normalizeWhitebitDepth({ ...updateBase, params: [false, { ...updateBase.params[1], asks: [['101', '0'], ['102', '1'], ['103', '1']] }, 'BTC_USDT'] }, { symbol: 'BTC_USDT' });
  assert.equal(update.kind, 'depthDelta');
  assert.equal(update.previousSequence, 10);
  assert.equal(update.asks[0].amount, 0);
  assert.throws(() => normalizeWhitebitDepth(snapshotFrame(10, 'ETH_USDT'), { symbol: 'BTC_USDT' }), /market mismatch/);
  assert.throws(() => normalizeWhitebitDepth({ ...updateFrame(11, 10), params: [false, { ...updateFrame(11, 10).params[1], past_update_id: undefined }, 'BTC_USDT'] }, { symbol: 'BTC_USDT' }), /delta missing past_update_id/);
  assert.throws(() => normalizeWhitebitDepth({ ...updateFrame(11, 10), params: [false, { ...updateFrame(11, 10).params[1], past_update_id: '' }, 'BTC_USDT'] }, { symbol: 'BTC_USDT' }), /past_update_id missing or invalid/);
  assert.throws(() => normalizeWhitebitDepth({ ...snapshotFrame(), params: [null, snapshotFrame().params[1], 'BTC_USDT'] }, { symbol: 'BTC_USDT' }), /snapshot flag must be boolean/);
  assert.throws(() => normalizeWhitebitDepth({ ...snapshotFrame(), id: 9 }, { symbol: 'BTC_USDT' }), /id must be null/);
  assert.throws(() => normalizeWhitebitDepth({ ...snapshotFrame(), params: [true, { ...snapshotFrame().params[1], past_update_id: 1 }, 'BTC_USDT'] }, { symbol: 'BTC_USDT' }), /must not include past_update_id/);
});

test('WhiteBIT generic public session requires a snapshot, strict past_update_id continuity, and fresh recovery', () => {
  const session = createPublicDepthSession({ venue: 'whitebit', topic: 'depth:BTC_USDT', instrumentId: 'whitebit:BTC_USDT', sessionToken: 'whitebit-depth:1', depth: 2 });
  const snapshot = normalizeWhitebitDepth({ ...snapshotFrame(), params: [true, { ...snapshotFrame().params[1], asks: [['101', '2'], ['102', '1'], ['103', '1']], bids: [['100', '3'], ['99', '2'], ['98', '1']] }, 'BTC_USDT'] }, { symbol: 'BTC_USDT' });
  const accepted = applyPublicDepthSessionMessage(session, { topic: session.topic, sessionToken: session.sessionToken, update: snapshot });
  assert.equal(accepted.accepted, true);
  assert.equal(defined(accepted.session.book).bids.length, 2);
  assert.equal(defined(accepted.session.book).asks.length, 2);
  const updateBase = updateFrame();
  const update = normalizeWhitebitDepth({ ...updateBase, params: [false, { ...updateBase.params[1], asks: [['101', '0'], ['102', '1'], ['103', '1']] }, 'BTC_USDT'] }, { symbol: 'BTC_USDT' });
  const changed = applyPublicDepthSessionMessage(accepted.session, { topic: session.topic, sessionToken: session.sessionToken, update });
  assert.equal(changed.accepted, true);
  assert.equal(defined(changed.session.book).bids.length, 2);
  assert.equal(defined(changed.session.book).asks.length, 2);
  assert.equal(defined(changed.session.book).asks.some(row => row.price === 101), false);
  assert.equal(defined(changed.session.book).bids.some(row => row.price === 99), true);
  const gap = normalizeWhitebitDepth(updateFrame(13, 12), { symbol: 'BTC_USDT' });
  const broken = applyPublicDepthSessionMessage(changed.session, { topic: session.topic, sessionToken: session.sessionToken, update: gap });
  assert.equal(broken.reason, 'resync-required');
  assert.equal(broken.session.invalidated, true);
  const late = applyPublicDepthSessionMessage(changed.session, { topic: session.topic, sessionToken: 'whitebit-depth:old', update });
  assert.equal(late.reason, 'cross-session');
});

test('WhiteBIT manager requires matching ACK/market, routes snapshots and deltas, answers ping, and fences stale sockets', async () => {
  const fake = transport(); const rest = restTransport(); const messages:LiveFeedEvent[] = [];
  const manager = new LiveFeedManager({ networkEnabled: true, transportFactory: fake.factory, restTransport: rest, transportPolicies: policies(), oiPollMs: 0, reconnectBaseMs: 10, schedule: fn => ({ fn }), cancel: () => {}, onMessage: message => messages.push(message) });
  await manager.start({ whitebitEnabled: true, whitebitSymbol: 'BTC_USDT' });
  const socket = defined(fake.sockets.find(item => item.spec.id === 'whitebit-depth'));
  assert.equal(socket.spec.request.url, 'wss://wss.whitebit.com/ws');
  assert.deepEqual(JSON.parse(defined(socket.sent.at(-1))), { id: 1, method: 'depth_subscribe', params: ['BTC_USDT', 100, '0', true] });
  socket.emit({ id: 1, result: { status: 'success' }, error: null });
  assert.equal(manager.status()['whitebit-depth'].subscriptionAcked, true);
  socket.emit(snapshotFrame());
  socket.emit(updateFrame());
  assert.equal(messages.some(item => item.id === 'whitebit-depth' && item.message.kind === 'depthSnapshot' && item.message.sequence === 10), true);
  assert.equal(messages.some(item => item.id === 'whitebit-depth' && item.message.kind === 'depthDelta' && item.message.sequence === 11), true);
  socket.emit({ id: 0, result: 'pong', error: null });
  assert.equal(manager.status()['whitebit-depth'].heartbeatAckSource, 'pong');
  socket.closeWith('forced');
  assert.equal(manager.status()['whitebit-depth'].state, 'backoff');
  socket.emit(snapshotFrame(12));
  assert.equal(manager.status()['whitebit-depth'].state, 'backoff');
  manager.stop();
});

test('WhiteBIT manager refuses a verified perpetual selection before opening a spot socket', async () => {
  const fake = transport();
  const manager = new LiveFeedManager({ networkEnabled: true, transportFactory: fake.factory, restTransport: restTransport(), transportPolicies: policies(), oiPollMs: 0, reconnectBaseMs: 10, schedule: fn => ({ fn }), cancel: () => {} });
  await manager.start({ whitebitEnabled: true, whitebitSymbol: 'BTC_PERP' });
  assert.equal(fake.sockets.some(item => item.spec.id === 'whitebit-depth'), false);
  assert.equal(manager.status()['whitebit-depth'].state, 'unavailable');
  assert.match(textValue(manager.status()['whitebit-depth'].lastError), /spot markets only/);
  manager.stop();
});

test('WhiteBIT manager rejects wrong ACKs, pre-ACK data, wrong markets, and malformed continuity', async () => {
  const fake = transport();
  const manager = new LiveFeedManager({ networkEnabled: true, transportFactory: fake.factory, restTransport: restTransport(), transportPolicies: policies(), oiPollMs: 0, reconnectBaseMs: 10, schedule: fn => ({ fn }), cancel: () => {} });
  await manager.start({ whitebitEnabled: true, whitebitSymbol: 'BTC_USDT' });
  const socket = defined(fake.sockets.find(item => item.spec.id === 'whitebit-depth'));
  socket.emit({ id: 2, result: { status: 'success' }, error: null });
  assert.equal(manager.status()['whitebit-depth'].subscriptionAcked, false);
  socket.emit(snapshotFrame());
  assert.equal(manager.status()['whitebit-depth'].subscriptionAcked, false);
  socket.emit({ id: 1, result: { status: 'success' }, error: null });
  socket.emit(snapshotFrame());
  socket.emit(updateFrame(12, 10, 'ETH_USDT'));
  assert.equal(manager.status()['whitebit-depth'].state, 'live');
  socket.emit(updateFrame(13, 12));
  assert.equal(manager.status()['whitebit-depth'].state, 'backoff');
  manager.stop();
});
