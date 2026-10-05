import { defined, fields, list, numeric, textValue } from './server-test-helpers.mts';
import type { LiveFeedTransportOptions, LiveFeedSocket, LiveFeedEvent, LiveFeedStatusEvent } from '../src/server/live-feeds.mts';
import type { ExchangeRestRequest } from '../src/server/rest-transport.mts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { LiveFeedManager } from '../src/server/live-feeds.mts';
import {
  VENUE_TRANSPORT_POLICIES,
  applyBitmexDepthSessionMessage,
  buildBitmexRequest,
  buildBitmexSubscription,
  createBitmexDepthSession,
  normalizeBitmexDepth,
  normalizeBitmexInstrument,
} from '../src/adapters/index.mts';

class FakeSocket {
  declare spec:LiveFeedTransportOptions; declare sent:string[]; declare closed:boolean; declare opened?:boolean;
  declare onMessage:((raw:unknown)=>void)|undefined; declare onClose:((reason:unknown)=>void)|undefined; declare onError:((error:unknown)=>void)|undefined;
  constructor(spec:LiveFeedTransportOptions) { this.spec = spec; this.sent = []; this.closed = false; this.onMessage = undefined; this.onClose = undefined; }
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

function restTransport() {
  const requests:ExchangeRestRequest[] = [];
  return {
    requests,
    request: async (request:ExchangeRestRequest) => {
      requests.push(request);
      if (request.url.includes('/instrument?')) return [{ symbol: 'XBTUSD', state: 'Open', underlying: 'XBT', quoteCurrency: 'USD', settlCurrency: 'XBt', tickSize: 0.5, lotSize: 1, isInverse: true }];
      if (request.url.includes('/orderBook/L2')) return [];
      if (request.url.includes('/exchangeInfo')) return { symbols: [] };
      if ((typeof request.body === 'string' && request.body.includes('metaAndAssetCtxs'))) return [{ universe: [] }, []];
      return {};
    },
  };
}

const snapshotRows = [
  { id: 1, symbol: 'XBTUSD', side: 'Buy', size: 100, price: 100 },
  { id: 2, symbol: 'XBTUSD', side: 'Sell', size: 80, price: 101 },
];

function frame(action: string, data: Record<string, unknown>[] = snapshotRows) {
  return { table: 'orderBookL2_25', action, filter: { symbol: 'XBTUSD', pool: 'Aggregated' }, timestamp: '2026-09-20T00:00:00.000Z', data };
}

function ack() {
  return { success: true, subscribe: 'orderBookL2_25:XBTUSD', request: { op: 'subscribe', args: ['orderBookL2_25:XBTUSD'] }, pool: 'Aggregated' };
}

test('BitMEX descriptors and instrument metadata match the public contract', () => {
  assert.equal(buildBitmexRequest('instrument', { symbol: 'XBTUSD' }).url, 'https://www.bitmex.com/api/v1/instrument?symbol=XBTUSD');
  assert.equal(buildBitmexRequest('depth', { symbol: 'XBTUSD', depth: 25 }).url, 'https://www.bitmex.com/api/v1/orderBook/L2?symbol=XBTUSD&depth=25');
  assert.equal(buildBitmexRequest('depth', { symbol: 'XBTUSD', depth: 0, pool: 'Primary' }).url, 'https://www.bitmex.com/api/v1/orderBook/L2?symbol=XBTUSD&depth=0&pool=Primary');
  assert.deepEqual(buildBitmexSubscription('depth', { symbol: 'XBTUSD' }), { url: 'wss://www.bitmex.com/realtime', method: 'subscribe', op: 'subscribe', args: ['orderBookL2_25:XBTUSD'], channel: 'orderBookL2_25', table: 'orderBookL2_25', symbol: 'XBTUSD', topic: 'orderBookL2_25:XBTUSD', snapshot: true, depth: 25 });
  const metadata = normalizeBitmexInstrument([{ symbol: 'XBTUSD', state: 'Open', underlying: 'XBT', quoteCurrency: 'USD', settlCurrency: 'XBt', tickSize: 0.5, lotSize: 1, isInverse: true, pool: 'Primary', timestamp: '2026-09-20T00:00:00.000Z' }], { symbol: 'XBTUSD', receivedAt: 1_700_000_000_000 });
  assert.deepEqual(metadata.assets[0], {
    instrumentId: 'bitmex:XBTUSD', venue: 'bitmex', nativeSymbol: 'XBTUSD', symbol: 'XBTUSD', base: 'XBT', quote: 'USD', marketType: 'perpetual', tickSize: 0.5, quantityUnit: 'contract', isDelisted: false, status: 'online', lotSize: 1, settleCoin: 'XBt', inverse: true, pool: 'Primary', metadataSource: 'bitmex-v1-instrument',
  });
  assert.equal(metadata.sourceTimestamp, Date.parse('2026-09-20T00:00:00.000Z'));
  assert.equal(normalizeBitmexDepth(snapshotRows, { symbol: 'XBTUSD' }).kind, 'depthSnapshot');
  const timestamped = normalizeBitmexDepth({ table: 'orderBookL2_25', action: 'partial', filter: { symbol: 'XBTUSD', pool: 'Aggregated' }, data: [{ ...snapshotRows[0], timestamp: '2026-09-20T00:00:01.000Z' }] }, { symbol: 'XBTUSD', receivedAt: 1_700_000_000_000 });
  assert.equal(timestamped.pool, 'Aggregated');
  assert.equal(timestamped.sourceTimestamp, Date.parse('2026-09-20T00:00:01.000Z'));
  assert.throws(() => normalizeBitmexDepth(frame('partial'), { symbol: 'XBTUSD', pool: 'Primary' }), /pool mismatch/);
});

test('BitMEX session applies partial, insert/update/delete diffs and invalidates unknown updates', () => {
  const snapshot = normalizeBitmexDepth(frame('partial'), { symbol: 'XBTUSD', receivedAt: 1_700_000_000_000 });
  const session = createBitmexDepthSession({ topic: 'orderBookL2_25:XBTUSD', instrumentId: 'bitmex:XBTUSD', sessionToken: 'bitmex-depth:1' });
  const accepted = applyBitmexDepthSessionMessage(session, { topic: session.topic, sessionToken: session.sessionToken, update: snapshot });
  assert.equal(accepted.accepted, true);
  assert.equal(defined(accepted.session.book).bids[0].amount, 100);
  const inserted = applyBitmexDepthSessionMessage(accepted.session, { topic: session.topic, sessionToken: session.sessionToken, update: normalizeBitmexDepth(frame('insert', [{ id: 3, symbol: 'XBTUSD', side: 'Buy', size: 60, price: 99 }]), { symbol: 'XBTUSD' }) });
  assert.equal(inserted.accepted, true);
  const updated = applyBitmexDepthSessionMessage(inserted.session, { topic: session.topic, sessionToken: session.sessionToken, update: normalizeBitmexDepth(frame('update', [{ id: 1, symbol: 'XBTUSD', size: 120 }]), { symbol: 'XBTUSD' }) });
  assert.equal(updated.accepted, true);
  assert.equal(defined(updated.session.book).bids.find(row => row.price === 100)?.amount, 120);
  const deleted = applyBitmexDepthSessionMessage(updated.session, { topic: session.topic, sessionToken: session.sessionToken, update: normalizeBitmexDepth(frame('delete', [{ id: 2, symbol: 'XBTUSD' }]), { symbol: 'XBTUSD' }) });
  assert.equal(deleted.accepted, true);
  assert.equal(defined(deleted.session.book).asks.some(row => row.price === 101), false);
  const unknownDelete = applyBitmexDepthSessionMessage(deleted.session, { topic: session.topic, sessionToken: session.sessionToken, update: normalizeBitmexDepth(frame('delete', [{ id: 999, symbol: 'XBTUSD' }]), { symbol: 'XBTUSD' }) });
  assert.equal(unknownDelete.accepted, false);
  assert.equal(unknownDelete.reason, 'resync-required');
  const bad = applyBitmexDepthSessionMessage(deleted.session, { topic: session.topic, sessionToken: session.sessionToken, update: normalizeBitmexDepth(frame('update', [{ id: 999, symbol: 'XBTUSD', size: 1 }]), { symbol: 'XBTUSD' }) });
  assert.equal(bad.accepted, false);
  assert.equal(bad.reason, 'resync-required');
  assert.equal(bad.session.invalidated, true);
});

test('BitMEX manager requires exact subscription ACK, filters tables, and fences reconnects', async () => {
  const fake = transport(); const rest = restTransport(); const messages:LiveFeedEvent[] = []; const timers:{fn:()=>unknown;delay:number}[] = [];
  const manager = new LiveFeedManager({ networkEnabled: true, transportFactory: fake.factory, restTransport: rest, transportPolicies: policies(), oiPollMs: 0, reconnectBaseMs: 10, schedule: (fn, delay) => { const timer = { fn, delay }; timers.push(timer); return timer; }, cancel: () => {}, onMessage: message => messages.push(message) });
  await manager.start({ selectedOrderbookVenues: ['bitmex'], bitmexEnabled: true, bitmexSymbol: 'XBTUSD' });
  const socket = defined(fake.sockets.find(item => item.spec.id === 'bitmex-depth'));
  assert.equal(socket.spec.request.url, 'wss://www.bitmex.com/realtime');
  assert.deepEqual(JSON.parse(defined(socket.sent.at(-1))), { op: 'subscribe', args: ['orderBookL2_25:XBTUSD'] });
  socket.emit({ info: 'Welcome to the BitMEX Realtime API.' });
  socket.emit({ success: true, subscribe: 'orderBookL2_25:XBTUSDT', request: { op: 'subscribe', args: ['orderBookL2_25:XBTUSDT'] } });
  socket.emit(frame('partial'));
  assert.equal(manager.status()['bitmex-depth'].subscriptionAcked, false);
  assert.equal(messages.some(item => item.id === 'bitmex-depth'), false);
  socket.emit(ack());
  assert.equal(manager.status()['bitmex-depth'].pool, 'Aggregated');
  socket.emit({ ...frame('partial'), filter: { symbol: 'ETHUSDT' } });
  assert.equal(messages.some(item => item.id === 'bitmex-depth'), false);
  socket.emit(frame('partial'));
  assert.equal(messages.filter(item => item.id === 'bitmex-depth' && item.message.kind === 'depthSnapshot').length, 1);
  socket.emit('pong');
  assert.equal(manager.status()['bitmex-depth'].heartbeatAckSource, 'pong');
  const before = messages.length;
  socket.closeWith('lost');
  assert.equal(manager.status()['bitmex-depth'].state, 'backoff');
  socket.emit(frame('partial'));
  assert.equal(messages.length, before + 1);
  await defined(timers.find(timer => timer.delay === 10)).fn();
  const replacement = defined(fake.sockets.filter(item => item.spec.id === 'bitmex-depth').at(-1));
  assert.notStrictEqual(replacement, socket);
  replacement.emit(ack());
  replacement.emit(frame('partial'));
  assert.equal(messages.filter(item => item.id === 'bitmex-depth' && item.message.kind === 'depthSnapshot' && item.message.complete === true).length, 2);
  manager.stop();
});

test('BitMEX rejects malformed acknowledgements and preserves pool provenance', async () => {
  const fake = transport(); const rest = restTransport();
  const manager = new LiveFeedManager({ networkEnabled: true, transportFactory: fake.factory, restTransport: rest, transportPolicies: policies(), oiPollMs: 0, reconnectBaseMs: 10, schedule: () => ({ }), cancel: () => {} });
  await manager.start({ bitmexEnabled: true, bitmexSymbol: 'XBTUSD' });
  const socket = defined(fake.sockets.find(item => item.spec.id === 'bitmex-depth'));
  socket.emit({ success: true, subscribe: 'orderBookL2_25:XBTUSD', pool: 'Aggregated' });
  assert.equal(manager.status()['bitmex-depth'].state, 'backoff');
  manager.stop();

  const second = transport();
  const acceptedMessages: LiveFeedEvent[] = [];
  const healthy = new LiveFeedManager({ networkEnabled: true, transportFactory: second.factory, restTransport: restTransport(), transportPolicies: policies(), oiPollMs: 0, reconnectBaseMs: 10, schedule: () => ({ }), cancel: () => {}, onMessage: message => acceptedMessages.push(message) });
  await healthy.start({ bitmexEnabled: true, bitmexSymbol: 'XBTUSD' });
  const healthySocket = defined(second.sockets.find(item => item.spec.id === 'bitmex-depth'));
  healthySocket.emit(ack());
  healthySocket.emit({ ...frame('partial'), filter: { symbol: 'XBTUSD', pool: 'Primary' } });
  assert.equal(healthy.status()['bitmex-depth'].state, 'backoff');
  assert.equal(acceptedMessages.some(item => item.id === 'bitmex-depth' && item.message.pool === 'Primary'), false);
  healthy.stop();
});

test('BitMEX client-ping mode fails closed when pong is silent', async () => {
  let clock = 0; const fake = transport(); const rest = restTransport(); const timers:{fn:()=>unknown;delay:number}[] = [];
  const transportPolicies = policies();
  transportPolicies.bitmex = { ...transportPolicies.bitmex, heartbeatIntervalMs: 100, heartbeatTimeoutMs: 50 };
  const manager = new LiveFeedManager({ networkEnabled: true, transportFactory: fake.factory, restTransport: rest, transportPolicies, now: () => clock, transportNow: () => clock, oiPollMs: 0, reconnectBaseMs: 1_000, heartbeatSchedule: (fn, delay) => { const timer = { fn, delay }; timers.push(timer); return timer; }, heartbeatCancel: () => {} });
  await manager.start({ bitmexEnabled: true, bitmexSymbol: 'XBTUSD' });
  const socket = defined(fake.sockets.find(item => item.spec.id === 'bitmex-depth'));
  socket.emit(ack());
  socket.emit(frame('partial'));
  clock = 100;
  await defined(timers.find(timer => timer.delay === 100)).fn();
  assert.equal(socket.sent.at(-1), 'ping');
  assert.equal(manager.status()['bitmex-depth'].lastObservedAt, 0);
  socket.emit({ info: 'foreign info' });
  assert.equal(manager.status()['bitmex-depth'].lastObservedAt, 0);
  clock = 151;
  const timeout = defined(timers.at(-1));
  assert.equal(timeout.delay, 50);
  await timeout.fn();
  assert.equal(manager.status()['bitmex-depth'].state, 'backoff');
  manager.stop();
});
