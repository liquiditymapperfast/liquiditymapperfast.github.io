import { defined, fields, list, numeric, textValue } from './server-test-helpers.mts';
import type { LiveFeedTransportOptions, LiveFeedSocket, LiveFeedEvent, LiveFeedStatusEvent } from '../src/server/live-feeds.mts';
import type { ExchangeRestRequest } from '../src/server/rest-transport.mts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { LiveFeedManager } from '../src/server/live-feeds.mts';
import {
  VENUE_TRANSPORT_POLICIES,
  applyCryptocomDepthSessionMessage,
  buildCryptocomRequest,
  buildCryptocomSubscription,
  createCryptocomDepthSession,
  normalizeCryptocomDepth,
  normalizeCryptocomInstrument,
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

function restTransport({ instrumentRow = { symbol: 'BTCUSD-PERP', inst_type: 'PERPETUAL_SWAP', base_ccy: 'BTC', quote_ccy: 'USD', price_tick_size: '0.5', qty_tick_size: '0.001', tradable: true, product_type: 'PERPETUAL_SWAP' } } = {}) {
  const requests:ExchangeRestRequest[] = [];
  return {
    requests,
    request: async (request:ExchangeRestRequest) => {
      requests.push(request);
      if (request.url.includes('/public/get-instruments')) return { id: 1, method: 'public/get-instruments', code: 0, result: { data: [instrumentRow] } };
      if (request.url.includes('/public/get-book')) return { code: 0, result: { depth: 10, instrument_name: 'BTCUSD-PERP', data: [{ asks: [['101', '2', 1]], bids: [['100', '3', 1]], t: 1_700_000_000_000 }] } };
      if (request.url.includes('/instrument?')) return [];
      if (request.url.includes('/exchangeInfo')) return { symbols: [] };
      if ((typeof request.body === 'string' && request.body.includes('metaAndAssetCtxs'))) return [{ universe: [] }, []];
      return {};
    },
  };
}

function policiesWithHeartbeat(interval = 60_000, timeout = 60_000) {
  const value = policies();
  value.cryptocom = { ...value.cryptocom, heartbeatIntervalMs: interval, heartbeatTimeoutMs: timeout };
  return value;
}

function snapshotFrame(sequence = 10) {
  return { id: -1, method: 'subscribe', code: 0, result: { instrument_name: 'BTCUSD-PERP', subscription: 'book.BTCUSD-PERP.10', channel: 'book', depth: 10, data: [{ asks: [['101', '2', 1]], bids: [['100', '3', 1]], t: 1_700_000_000_000, tt: 1_700_000_000_001, u: sequence }] } };
}

function updateFrame(sequence = 11, previous = 10) {
  return { id: -1, method: 'subscribe', code: 0, result: { instrument_name: 'BTCUSD-PERP', subscription: 'book.BTCUSD-PERP.10', channel: 'book.update', depth: 10, data: [{ update: { asks: [['101', '0', 0]], bids: [['99', '1', 1]] }, t: 1_700_000_001_000, tt: 1_700_000_001_001, u: sequence, pu: previous }] } };
}

function subscribeAckFrame({ id = 1, channel = 'book.BTCUSD-PERP.10' } = {}) {
  return { id, method: 'subscribe', code: 0, channel };
}

test('Crypto.com descriptors, metadata, REST snapshot, and provider envelope normalize exactly', () => {
  assert.equal(buildCryptocomRequest('instrument').url, 'https://api.crypto.com/exchange/v1/public/get-instruments');
  assert.equal(buildCryptocomRequest('depth', { instrumentName: 'BTCUSD-PERP', depth: 10 }).url, 'https://api.crypto.com/exchange/v1/public/get-book?instrument_name=BTCUSD-PERP&depth=10');
  assert.throws(() => buildCryptocomRequest('depth', { depth: 25 }), /depth/);
  assert.deepEqual(buildCryptocomSubscription('depth', { instrumentName: 'BTCUSD-PERP', depth: 10, updateFrequency: 100 }), {
    url: 'wss://stream.crypto.com/exchange/v1/market', method: 'subscribe', op: 'subscribe', id: 1,
    params: { channels: ['book.BTCUSD-PERP.10'], book_subscription_type: 'SNAPSHOT_AND_UPDATE', book_update_frequency: 100 },
    channel: 'book', topic: 'book.BTCUSD-PERP.10', instrumentName: 'BTCUSD-PERP', symbol: 'BTCUSD-PERP', depth: 10,
    subscriptionType: 'SNAPSHOT_AND_UPDATE', updateFrequency: 100, snapshot: true,
  });
  const metadata = normalizeCryptocomInstrument({ result: { data: [{ symbol: 'BTCUSD-PERP', inst_type: 'PERPETUAL_SWAP', base_ccy: 'BTC', quote_ccy: 'USD', price_tick_size: '0.5', qty_tick_size: '0.001', tradable: true, product_type: 'PERPETUAL_SWAP' }] } }, { instrumentName: 'BTCUSD-PERP', receivedAt: 1_700_000_000_000 });
  assert.equal(metadata.sourceTimestamp, null);
  assert.equal(metadata.receivedAt, 1_700_000_000_000);
  assert.deepEqual(metadata.assets[0], {
    instrumentId: 'cryptocom:BTCUSD-PERP', venue: 'cryptocom', nativeSymbol: 'BTCUSD-PERP', symbol: 'BTCUSD-PERP', base: 'BTC', quote: 'USD', marketType: 'perpetual', tickSize: 0.5, quantityUnit: 'base', isDelisted: false, status: 'online', lotSize: 0.001, quantityDecimals: undefined, expiryTimestamp: undefined, underlyingSymbol: undefined, instrumentType: 'PERPETUAL_SWAP', metadataSource: 'cryptocom-v1-get-instruments',
  });
  const rest = normalizeCryptocomDepth({ code: 0, result: { depth: 10, instrument_name: 'BTCUSD-PERP', data: [{ asks: [['101', '2', 1]], bids: [['100', '3', 1]], t: 1_700_000_000_000 }] } }, { instrumentName: 'BTCUSD-PERP', depth: 10, receivedAt: 1_700_000_000_500 });
  assert.equal(rest.kind, 'depthSnapshot');
  assert.equal(rest.sequence, null);
  const snapshot = normalizeCryptocomDepth(snapshotFrame(), { instrumentName: 'BTCUSD-PERP', depth: 10, receivedAt: 1_700_000_000_500 });
  assert.equal(snapshot.sequence, 10);
  assert.equal(snapshot.sourceTimestamp, 1_700_000_000_001);
  assert.equal(snapshot.market.base, 'BTC');
  const spot = normalizeCryptocomInstrument({ result: { data: [{ symbol: 'BTC_USDT', inst_type: 'CCY_PAIR', base_ccy: 'BTC', quote_ccy: 'USDT' }] } }, { instrumentName: 'BTC_USDT' });
  assert.equal(spot.assets[0].marketType, 'spot');
  assert.equal(normalizeCryptocomDepth({ ...snapshotFrame(), result: { ...snapshotFrame().result, instrument_name: 'BTCUSD-260925', subscription: 'book.BTCUSD-260925.10' } }, { instrumentName: 'BTCUSD-260925', depth: 10 }).market.marketType, 'delivery');
  const update = normalizeCryptocomDepth(updateFrame(), { instrumentName: 'BTCUSD-PERP', depth: 10 });
  assert.ok(update.kind === 'depthDelta');
  assert.equal(update.previousSequence, 10);
  assert.equal(update.asks[0].amount, 0);
  assert.equal(update.bids[0].amount, 1);
});

test('Crypto.com reducer replaces periodic snapshots, applies pu/u deltas, deletes zero levels, and fences gaps', () => {
  const session = createCryptocomDepthSession({ topic: 'book.BTCUSD-PERP.10', instrumentId: 'cryptocom:BTCUSD-PERP', sessionToken: 'cryptocom-depth:1' });
  const snapshot = normalizeCryptocomDepth(snapshotFrame(10), { instrumentName: 'BTCUSD-PERP', depth: 10 });
  const accepted = applyCryptocomDepthSessionMessage(session, { topic: session.topic, sessionToken: session.sessionToken, update: snapshot });
  assert.equal(accepted.accepted, true);
  const delta = normalizeCryptocomDepth(updateFrame(11, 10), { instrumentName: 'BTCUSD-PERP', depth: 10 });
  const changed = applyCryptocomDepthSessionMessage(accepted.session, { topic: session.topic, sessionToken: session.sessionToken, update: delta });
  assert.equal(changed.accepted, true);
  assert.equal(defined(changed.session.book).asks.length, 0);
  assert.equal(defined(changed.session.book).bids.some(row => row.price === 99), true);
  const periodic = normalizeCryptocomDepth(snapshotFrame(30), { instrumentName: 'BTCUSD-PERP', depth: 10 });
  const replaced = applyCryptocomDepthSessionMessage(changed.session, { topic: session.topic, sessionToken: session.sessionToken, update: periodic });
  assert.equal(replaced.accepted, true);
  assert.equal(replaced.session.lastSequence, 30);
  const gap = normalizeCryptocomDepth(updateFrame(32, 31), { instrumentName: 'BTCUSD-PERP', depth: 10 });
  const broken = applyCryptocomDepthSessionMessage(replaced.session, { topic: session.topic, sessionToken: session.sessionToken, update: gap });
  assert.equal(broken.reason, 'resync-required');
  assert.equal(broken.session.invalidated, true);
  const late = applyCryptocomDepthSessionMessage(replaced.session, { topic: session.topic, sessionToken: 'cryptocom-depth:old', update: periodic });
  assert.equal(late.reason, 'cross-session');
});

test('Crypto.com manager requires exact topic metadata, routes snapshots and deltas, and responds to server heartbeat', async () => {
  const fake = transport(); const rest = restTransport(); const messages:LiveFeedEvent[] = [];
  const manager = new LiveFeedManager({ networkEnabled: true, transportFactory: fake.factory, restTransport: rest, transportPolicies: policies(), oiPollMs: 0, reconnectBaseMs: 10, schedule: (fn) => ({ fn }), cancel: () => {}, onMessage: message => messages.push(message) });
  await manager.start({ cryptocomEnabled: true, cryptocomSymbol: 'BTCUSD-PERP' });
  const socket = defined(fake.sockets.find(item => item.spec.id === 'cryptocom-depth'));
  assert.equal(socket.spec.request.url, 'wss://stream.crypto.com/exchange/v1/market');
  assert.deepEqual(JSON.parse(defined(socket.sent.at(-1))), { id: 1, method: 'subscribe', params: { channels: ['book.BTCUSD-PERP.10'], book_subscription_type: 'SNAPSHOT_AND_UPDATE', book_update_frequency: 100 } });
  socket.emit({ id: -1, method: 'subscribe', code: 0, result: { ...snapshotFrame().result, instrument_name: 'ETHUSD-PERP' } });
  assert.equal(manager.status()['cryptocom-depth'].subscriptionAcked, false);
  socket.emit(snapshotFrame(10));
  assert.equal(manager.status()['cryptocom-depth'].subscriptionAcked, true);
  assert.equal(messages.some(item => item.id === 'cryptocom-depth' && item.message.kind === 'depthSnapshot'), true);
  socket.emit(updateFrame(11, 10));
  assert.equal(messages.some(item => item.id === 'cryptocom-depth' && item.message.kind === 'depthSnapshot' && item.message.sequence === 11), true);
  socket.emit({ id: 77, method: 'public/heartbeat', code: 0 });
  await Promise.resolve();
  assert.deepEqual(JSON.parse(defined(socket.sent.at(-1))), { id: 77, method: 'public/respond-heartbeat' });
  assert.equal(manager.status()['cryptocom-depth'].heartbeatAckSource, 'server-heartbeat');
  manager.stop();
});

test('Crypto.com manager validates result-less acknowledgements and fences data before acknowledgement', async () => {
  const fake = transport(); const rest = restTransport(); const messages:LiveFeedEvent[] = [];
  const manager = new LiveFeedManager({ networkEnabled: true, transportFactory: fake.factory, restTransport: rest, transportPolicies: policies(), oiPollMs: 0, reconnectBaseMs: 10, schedule: fn => ({ fn }), cancel: () => {}, onMessage: message => messages.push(message) });
  await manager.start({ cryptocomEnabled: true, cryptocomSymbol: 'BTCUSD-PERP' });
  const socket = defined(fake.sockets.find(item => item.spec.id === 'cryptocom-depth'));
  socket.emit(updateFrame(11, 10));
  assert.equal(manager.status()['cryptocom-depth'].subscriptionAcked, false);
  assert.equal(messages.filter(item => item.id === 'cryptocom-depth' && item.message?.kind?.startsWith('depth')).length, 0);
  socket.emit(subscribeAckFrame());
  assert.equal(manager.status()['cryptocom-depth'].subscriptionAcked, true);
  socket.emit(snapshotFrame(10));
  assert.equal(messages.some(item => item.id === 'cryptocom-depth' && item.message.kind === 'depthSnapshot'), true);
  manager.stop();

  const wrongFake = transport(); const wrongManager = new LiveFeedManager({ networkEnabled: true, transportFactory: wrongFake.factory, restTransport: restTransport(), transportPolicies: policies(), oiPollMs: 0, reconnectBaseMs: 10, schedule: fn => ({ fn }), cancel: () => {} });
  await wrongManager.start({ cryptocomEnabled: true, cryptocomSymbol: 'BTCUSD-PERP' });
  const wrongSocket = defined(wrongFake.sockets.find(item => item.spec.id === 'cryptocom-depth'));
  wrongSocket.emit(subscribeAckFrame({ id: 2 }));
  assert.equal(wrongManager.status()['cryptocom-depth'].state, 'backoff');
  wrongManager.stop();

  const dataFake = transport(); const dataManager = new LiveFeedManager({ networkEnabled: true, transportFactory: dataFake.factory, restTransport: restTransport(), transportPolicies: policies(), oiPollMs: 0, reconnectBaseMs: 10, schedule: fn => ({ fn }), cancel: () => {} });
  await dataManager.start({ cryptocomEnabled: true, cryptocomSymbol: 'BTCUSD-PERP' });
  const dataSocket = defined(dataFake.sockets.find(item => item.spec.id === 'cryptocom-depth'));
  dataSocket.emit({ ...snapshotFrame(10), id: 1 });
  assert.equal(dataManager.status()['cryptocom-depth'].state, 'backoff');
  dataManager.stop();
});

test('Crypto.com manager rejects spot metadata before opening a perpetual feed', async () => {
  const fake = transport();
  const manager = new LiveFeedManager({ networkEnabled: true, transportFactory: fake.factory, restTransport: restTransport({ instrumentRow: { symbol: 'BTC_USDT', inst_type: 'CCY_PAIR', base_ccy: 'BTC', quote_ccy: 'USDT', price_tick_size: '0.01', qty_tick_size: '0.00001', tradable: true, product_type: 'SPOT' } }), transportPolicies: policies(), oiPollMs: 0, reconnectBaseMs: 10, schedule: fn => ({ fn }), cancel: () => {} });
  await manager.start({ cryptocomEnabled: true, cryptocomSymbol: 'BTC_USDT' });
  assert.equal(fake.sockets.some(item => item.spec.id === 'cryptocom-depth'), false);
  assert.equal(manager.status()['cryptocom-depth'].state, 'unavailable');
  assert.match(textValue(manager.status()['cryptocom-depth'].lastError), /PERPETUAL_SWAP/);
  assert.equal(manager.status()['cryptocom-metadata'].state, 'snapshot');
  manager.stop();
});

test('Crypto.com server-driven heartbeat does not self-observe a silent socket', async () => {
  let clock = 0; const fake = transport(); const rest = restTransport(); const timers:{fn:()=>unknown;delay:number}[] = [];
  const manager = new LiveFeedManager({ networkEnabled: true, transportFactory: fake.factory, restTransport: rest, transportPolicies: policiesWithHeartbeat(100, 50), now: () => clock, transportNow: () => clock, oiPollMs: 0, reconnectBaseMs: 10, schedule: fn => ({ fn }), cancel: () => {}, heartbeatSchedule: (fn, delay) => { const timer = { fn, delay }; timers.push(timer); return timer; }, heartbeatCancel: () => {} });
  await manager.start({ cryptocomEnabled: true, cryptocomSymbol: 'BTCUSD-PERP' });
  const socket = defined(fake.sockets.find(item => item.spec.id === 'cryptocom-depth'));
  socket.emit(snapshotFrame(10));
  clock = 100;
  await defined(timers.find(timer => timer.delay === 100)).fn();
  assert.equal(socket.sent.some(value => String(value).includes('respond-heartbeat')), false);
  assert.equal(manager.status()['cryptocom-depth'].serverHeartbeat, true);
  clock = 151;
  const timeout = defined(timers.at(-1));
  await timeout.fn();
  assert.equal(manager.status()['cryptocom-depth'].state, 'backoff');
  manager.stop();
});
