import type { MutationContext } from '../src/server/http-contracts.mts';
import { defined, fields, list, numeric, textValue } from './server-test-helpers.mts';
import type { LiveFeedTransportOptions, LiveFeedSocket, LiveFeedEvent, LiveFeedStatusEvent } from '../src/server/live-feeds.mts';
import type { ExchangeRestRequest } from '../src/server/rest-transport.mts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { LiveFeedManager } from '../src/server/live-feeds.mts';
import { getVenue } from '../src/domain/venue-registry.mts';

const TOPIC = 'orderbook.1000.BTCUSDT';

class FakeSocket {
  declare spec:LiveFeedTransportOptions; declare sent:string[]; declare closed:boolean; declare opened?:boolean;
  declare onMessage:((raw:unknown)=>void)|undefined; declare onClose:((reason:unknown)=>void)|undefined; declare onError:((error:unknown)=>void)|undefined;
  constructor(spec:LiveFeedTransportOptions) { this.spec = spec; this.sent = []; this.closed = false; this.onMessage = undefined; this.onClose = undefined; this.onError = undefined; }
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

function metadataTransport() {
  return { request: async (request:ExchangeRestRequest) => {
    if (request.url.includes('/v5/market/instruments-info')) return {
      time: 1_700_000_000_000,
      retCode: 0,
      result: { category: 'linear', list: [{ symbol: 'BTCUSDT', contractType: 'LinearPerpetual', status: 'Trading', baseCoin: 'BTC', quoteCoin: 'USDT', settleCoin: 'USDT', priceFilter: { tickSize: '0.1' }, lotSizeFilter: { qtyStep: '0.001' } }] },
    };
    if ((typeof request.body === 'string' && request.body.includes('metaAndAssetCtxs'))) return [{ universe: [] }, []];
    if (request.url.includes('/depth')) return { lastUpdateId: 1, bids: [['100', '1']], asks: [['101', '1']] };
    if (request.url.includes('/klines')) return [];
    return {};
  } };
}

function subscribeAck({ success = true, retCode = 0, topic = TOPIC, op = 'subscribe', includeArgs = true } = {}) {
  return { success, retCode, ret_msg: success ? '' : 'permission denied', op, ...(includeArgs ? { args: [topic] } : {}) };
}

function snapshot(sequence = 10, { topic = TOPIC, symbol = 'BTCUSDT' } = {}) {
  return { topic, type: 'snapshot', ts: 1_700_000_000_000 + sequence, data: { category: 'linear', s: symbol, u: sequence, seq: sequence + 100, b: [['100', '2']], a: [['101', '3']] } };
}

function delta(sequence = 11) {
  return { topic: TOPIC, type: 'delta', ts: 1_700_000_000_100 + sequence, data: { category: 'linear', s: 'BTCUSDT', u: sequence, seq: sequence + 100, b: [['100', '0'], ['99', '1']], a: [] } };
}

const policies = { bybit: { subscribeIntervalMs: 0, heartbeatIntervalMs: 60_000, heartbeatTimeoutMs: 60_000 } };

test('Bybit manager validates the subscribe acknowledgement, replays bounded pre-ack data, and tracks heartbeat controls', async () => {
  const fake = transport(); const messages:LiveFeedEvent[] = [];
  const manager = new LiveFeedManager({ networkEnabled: true, transportFactory: fake.factory, oiPollMs: 0, transportPolicies: policies, onMessage: message => messages.push(message) });
  await manager.start({ bybitEnabled: true, bybitSymbol: 'BTCUSDT' });
  const socket = fake.sockets.find(item => item.spec.venue === 'bybit');
  assert.ok(socket);
  assert.deepEqual(JSON.parse(socket.sent[0]), { op: 'subscribe', args: [TOPIC] });
  socket.emit(JSON.stringify(subscribeAck({ op: 'ping' })));
  socket.emit(JSON.stringify(subscribeAck({ topic: 'orderbook.1000.ETHUSDT' })));
  socket.emit(JSON.stringify(snapshot(8, { topic: 'orderbook.1000.ETHUSDT' })));
  socket.emit(JSON.stringify(snapshot(8, { symbol: 'ETHUSDT' })));
  socket.emit(snapshot(9));
  assert.equal(manager.status()['bybit-depth'].subscriptionAcked, false);
  assert.equal(messages.filter(item => item.venue === 'bybit').length, 0);
  assert.equal(defined(defined(manager.feeds.get('bybit-depth')).preAckFrames).length, 1);
  socket.emit(Buffer.from(JSON.stringify(subscribeAck({ includeArgs: false }))));
  assert.equal(manager.status()['bybit-depth'].subscriptionAcked, true);
  assert.equal(defined(defined(manager.feeds.get('bybit-depth')).preAckFrames).length, 0);
  assert.equal(messages.filter(item => item.venue === 'bybit' && item.message.kind === 'depthSnapshot').length, 1);
  assert.equal(manager.status()['bybit-depth'].state, 'live');
  socket.emit(Buffer.from(JSON.stringify({ op: 'pong', args: ['1700000000000'] })));
  assert.equal(manager.status()['bybit-depth'].subscriptionAckSource, 'heartbeat');
  socket.emit(JSON.stringify({ op: 'subscribe', success: false, retCode: 10001, ret_msg: 'denied' }));
  assert.equal(manager.status()['bybit-depth'].state, 'backoff');
  assert.equal(socket.closed, true);
  manager.stop();
});

test('Bybit buffers pre-ack snapshots and deltas in wire order, but fails closed on buffer overflow', async () => {
  const fake = transport(); const messages:LiveFeedEvent[] = []; const timers:{fn:()=>unknown;delay:number}[] = [];
  const manager = new LiveFeedManager({
    networkEnabled: true,
    transportFactory: fake.factory,
    oiPollMs: 0,
    reconnectBaseMs: 10,
    schedule: (fn, delay) => { timers.push({ fn, delay }); return timers.length; },
    cancel: () => {},
    transportPolicies: policies,
    onMessage: message => messages.push(message),
  });
  await manager.start({ bybitEnabled: true, bybitSymbol: 'BTCUSDT' });
  const socket = defined(fake.sockets.find(item => item.spec.venue === 'bybit'));
  socket.emit(snapshot(10));
  socket.emit(delta(13));
  assert.equal(messages.filter(item => item.venue === 'bybit').length, 0);
  assert.equal(defined(defined(manager.feeds.get('bybit-depth')).preAckFrames).length, 2);
  socket.emit(subscribeAck());
  const routed = messages.filter(item => item.venue === 'bybit' && item.message.kind.startsWith('depth'));
  assert.deepEqual(routed.map(item => item.message.kind), ['depthSnapshot', 'depthDelta']);
  assert.equal(routed[0].message.sequence, 10);
  assert.equal(routed[1].message.sequence, 13);
  assert.equal(routed[1].message.continuity, 'unproven');
  assert.equal(defined(defined(defined(manager.feeds.get('bybit-depth')).session).book).sequence, 13);
  manager.stop();

  const overflowing = transport(); const overflowTimers: {fn: () => unknown; delay: number}[] = []; const overflowMessages: LiveFeedEvent[] = [];
  const overflowManager = new LiveFeedManager({
    networkEnabled: true,
    transportFactory: overflowing.factory,
    oiPollMs: 0,
    reconnectBaseMs: 10,
    schedule: (fn, delay) => { overflowTimers.push({ fn, delay }); return overflowTimers.length; },
    cancel: () => {},
    transportPolicies: policies,
    onMessage: message => overflowMessages.push(message),
  });
  await overflowManager.start({ bybitEnabled: true, bybitSymbol: 'BTCUSDT' });
  const overflowSocket = defined(overflowing.sockets.find(item => item.spec.venue === 'bybit'));
  for (let updateId = 1; updateId <= 129; updateId += 1) overflowSocket.emit(delta(updateId));
  assert.equal(overflowManager.status()['bybit-depth'].state, 'backoff');
  assert.equal(overflowSocket.closed, true);
  assert.equal(defined(defined(overflowManager.feeds.get('bybit-depth')).preAckFrames).length, 0);
  assert.equal(overflowMessages.some(item => item.venue === 'bybit' && item.message.kind?.startsWith('depth')), false);
  assert.equal(overflowTimers.length, 1);
  overflowManager.stop();

  const oversized = transport(); const oversizedTimers: {fn: () => unknown; delay: number}[] = []; const oversizedMessages: LiveFeedEvent[] = [];
  const oversizedManager = new LiveFeedManager({
    networkEnabled: true,
    transportFactory: oversized.factory,
    oiPollMs: 0,
    reconnectBaseMs: 10,
    schedule: (fn, delay) => { oversizedTimers.push({ fn, delay }); return oversizedTimers.length; },
    cancel: () => {},
    transportPolicies: policies,
    onMessage: message => oversizedMessages.push(message),
  });
  await oversizedManager.start({ bybitEnabled: true, bybitSymbol: 'BTCUSDT' });
  const oversizedSocket = defined(oversized.sockets.find(item => item.spec.venue === 'bybit'));
  oversizedSocket.emit({ ...delta(130), ignored: 'x'.repeat(2 * 1024 * 1024) });
  assert.equal(oversizedManager.status()['bybit-depth'].state, 'backoff');
  assert.equal(oversizedSocket.closed, true);
  assert.equal(defined(defined(oversizedManager.feeds.get('bybit-depth')).preAckFrames).length, 0);
  assert.equal(oversizedMessages.some(item => item.venue === 'bybit' && item.message.kind?.startsWith('depth')), false);
  assert.equal(oversizedTimers.length, 1);
  oversizedManager.stop();
});

test('Bybit pre-ack retention fails closed when shared admission rejects the frame', async () => {
  const fake = transport(); const timers:{fn:()=>unknown;delay:number}[] = []; const messages:LiveFeedEvent[] = [];
  const attempts: {candidate: unknown; context: MutationContext}[] = [];
  const manager = new LiveFeedManager({
    networkEnabled: true,
    transportFactory: fake.factory,
    oiPollMs: 0,
    reconnectBaseMs: 10,
    schedule: (fn, delay) => { timers.push({ fn, delay }); return timers.length; },
    cancel: () => {},
    transportPolicies: policies,
    retainedAdmission: (candidate, context, commit) => {
      attempts.push({ candidate, context });
      if (context.kind === 'feed-buffer') return { admitted: false, reservation: { reason: 'hard-limit', bytes: 0, context } };
      commit();
      return { admitted: true };
    },
    onMessage: message => messages.push(message),
  });
  await manager.start({ bybitEnabled: true, bybitSymbol: 'BTCUSDT' });
  const socket = defined(fake.sockets.find(item => item.spec.venue === 'bybit'));
  socket.emit(snapshot(12));
  const attempted = attempts.find(item => fields(item.candidate).kind === 'bybit-pre-ack');
  assert.equal(attempted?.context.kind, 'feed-buffer');
  assert.equal(attempted?.context.venue, 'bybit');
  assert.equal(defined(defined(manager.feeds.get('bybit-depth')).preAckFrames).length, 0);
  assert.equal(defined(manager.feeds.get('bybit-depth')).preAckBytes, 0);
  assert.equal(socket.closed, true);
  assert.equal(manager.status()['bybit-depth'].state, 'backoff');
  assert.equal(messages.some(item => item.venue === 'bybit' && item.message.kind.startsWith('depth')), false);
  assert.equal(timers.length, 1);
  manager.stop();
});

test('Bybit matrix preserves linear base units, filters foreign frames, and fences retired sessions', async () => {
  const fake = transport(); const timers:{fn:()=>unknown;delay:number}[] = []; const messages:LiveFeedEvent[] = [];
  const manager = new LiveFeedManager({
    networkEnabled: true,
    transportFactory: fake.factory,
    restTransport: metadataTransport(),
    transportPolicies: policies,
    oiPollMs: 0,
    reconnectBaseMs: 10,
    schedule: (fn, delay) => { timers.push({ fn, delay }); return timers.length; },
    cancel: () => {},
    onMessage: message => messages.push(message),
  });
  await manager.start({ bybitEnabled: true, bybitSymbol: 'BTCUSDT' });
  const first = defined(fake.sockets.find(item => item.spec.venue === 'bybit'));
  first.emit(subscribeAck());
  first.emit(Buffer.from(JSON.stringify(snapshot(10))));
  first.emit(snapshot(11, { symbol: 'ETHUSDT' }));
  first.emit({ ...snapshot(12), data: { ...snapshot(12).data, s: undefined } });
  first.emit(delta(13));
  const books = () => messages.filter(item => item.venue === 'bybit' && item.message?.kind?.startsWith('depth'));
  assert.equal(books().filter(item => item.message.complete === true).length, 1);
  assert.equal(books().filter(item => item.message.kind === 'depthDelta').length, 1);
  assert.equal(defined(books().find(item => item.message.kind === 'depthDelta')).message.continuity, 'unproven');
  assert.equal(defined(books().find(item => item.message.kind === 'depthDelta')).message.sequenceJump, true);
  assert.equal(books()[0].message.units, 'base');
  assert.equal(defined(books()[0].message.market).quantityUnit, 'base');
  assert.equal(defined(messages.find(item => item.id === 'bybit-metadata')?.message.assets)[0].qtyStep, 0.001);
  assert.equal(manager.status()['bybit-metadata'].state, 'snapshot');
  assert.equal(defined(getVenue('bybit')).capabilities.l2.state, 'supported');
  first.closeWith('lost');
  assert.equal(first.closed, true);
  assert.equal(manager.status()['bybit-depth'].state, 'backoff');
  assert.equal(defined(books().at(-1)).message.complete, false);
  assert.equal(timers.length, 1);
  await timers[0].fn();
  const second = defined(fake.sockets.filter(item => item.spec.venue === 'bybit').at(-1));
  assert.notStrictEqual(second, first);
  assert.equal(manager.status()['bybit-depth'].state, 'snapshot');
  first.emit(snapshot(999));
  second.emit(subscribeAck({ includeArgs: false }));
  second.emit(snapshot(20));
  assert.equal(books().filter(item => item.message.complete === true).length, 2);
  manager.stop();
});
