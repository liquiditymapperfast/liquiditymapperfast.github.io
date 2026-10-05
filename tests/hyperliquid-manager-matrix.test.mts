import test from 'node:test';
import assert from 'node:assert/strict';
import { LiveFeedManager } from '../src/server/live-feeds.mts';
import type { LiveFeedEvent, LiveFeedSocket, LiveFeedTransportOptions, FeedTimer } from '../src/server/live-feeds.mts';
import { buildHyperliquidSubscription, matchesHyperliquidSubscriptionResponse, matchesHyperliquidSubscriptionData } from '../src/adapters/hyperliquid.mts';
import { recordValue } from '../src/adapters/common.mts';
import { getVenue } from '../src/domain/venue-registry.mts';

class Socket implements LiveFeedSocket {
  readonly listeners = new Map<string, ((payload: unknown) => void)[]>();
  readonly sent: string[] = [];
  closed = false;
  constructor(readonly spec: LiveFeedTransportOptions) {}
  async open() {}
  send(raw: string) { this.sent.push(raw); }
  close() { this.closed = true; }
  on(event: string, listener: (payload: unknown) => void) { this.listeners.set(event, [...(this.listeners.get(event) ?? []), listener]); }
  dispatch(event: string, payload: unknown) { for (const listener of this.listeners.get(event) ?? []) listener(payload); }
  emit(payload: unknown) { this.dispatch('message', payload); }
  closeWith() { this.closed = true; this.dispatch('close', 'client-induced close'); }
}
function harness() {
  let clock = 1_700_000_000_100;
  const sockets: Socket[] = []; const messages: LiveFeedEvent[] = [];
  const retries: { fn: () => unknown; cancelled: boolean }[] = [];
  const heartbeats: { fn: () => unknown; cancelled: boolean }[] = [];
  const hold = (target: typeof retries) => (fn: () => unknown) => { const timer = { fn, cancelled: false }; target.push(timer); return timer; };
  const cancel = (timer: FeedTimer) => { if (timer && typeof timer === 'object' && 'cancelled' in timer) timer.cancelled = true; };
  const manager = new LiveFeedManager({ networkEnabled: true, oiPollMs: 0, now: () => clock, transportNow: () => clock,
    transportPolicies: { hyperliquid: { subscribeIntervalMs: 0, heartbeatIntervalMs: 200, heartbeatTimeoutMs: 100 }, binance: { subscribeIntervalMs: 0, heartbeatIntervalMs: 200, heartbeatTimeoutMs: 100 } },
    transportFactory: async spec => { const socket = new Socket(spec); sockets.push(socket); return socket; },
    schedule: hold(retries), cancel, heartbeatSchedule: hold(heartbeats), heartbeatCancel: cancel,
    onMessage: event => { messages.push(event); } });
  const socket = (id: string) => { const value = sockets.filter(item => item.spec.id === id).at(-1); assert.ok(value); return value; };
  return { manager, sockets, messages, retries, heartbeats, socket, advance(ms: number) { clock += ms; } };
}
const ids = ['hl-l2Book-native', 'hl-l2Book', 'hl-activeAssetCtx', 'hl-candle', 'hl-trades'];
function validFrame(id: string, coin = 'BTC', sequence = 1_700_000_000_000) {
  if (id.startsWith('hl-l2Book')) return { channel: 'l2Book', data: { coin, time: sequence, levels: [[{ px: '100', sz: '2' }], [{ px: '101', sz: '3' }]] } };
  if (id === 'hl-activeAssetCtx') return { channel: 'activeAssetCtx', data: { coin, ctx: { openInterest: '4', markPx: '100' } } };
  if (id === 'hl-candle') return { channel: 'candle', data: { s: coin, i: '1m', t: sequence, T: sequence + 60_000, o: '100', h: '110', l: '90', c: '101', v: '4' } };
  return { channel: 'trades', data: [{ coin, side: 'B', px: '100', sz: '2', time: sequence, tid: 7 }] };
}
function ack(socket: Socket) { return { channel: 'subscriptionResponse', data: { method: 'subscribe', subscription: socket.spec.request.subscription } }; }

test('Hyperliquid echoes match exact channel, namespaced coin, candle interval and book grouping', () => {
  const request = buildHyperliquidSubscription('l2Book', { coin: 'xyz:NVDA', nSigFigs: 5, mantissa: 2 });
  const response = { channel: 'subscriptionResponse', data: request };
  assert.equal(matchesHyperliquidSubscriptionResponse(response, request), true);
  assert.equal(matchesHyperliquidSubscriptionResponse({ ...response, data: { ...request, subscription: { ...request.subscription, fast: false } } }, request), true);
  for (const patch of [{ coin: 'XYZ:NVDA' }, { coin: 'BTC' }, { type: 'trades' }, { nSigFigs: 4 }, { mantissa: 5 }, { fast: true }]) {
    assert.equal(matchesHyperliquidSubscriptionResponse({ ...response, data: { ...request, subscription: { ...request.subscription, ...patch } } }, request), false);
  }
  assert.equal(matchesHyperliquidSubscriptionResponse({ channel: 'subscriptionResponse', data: { method: 'subscribe' } }, request), false);
  assert.equal(matchesHyperliquidSubscriptionData(validFrame('hl-l2Book', 'xyz:NVDA'), request), true);
  const candle = buildHyperliquidSubscription('candle', { coin: 'BTC', interval: '1m' });
  assert.equal(matchesHyperliquidSubscriptionData(validFrame('hl-candle'), candle), true);
  assert.equal(matchesHyperliquidSubscriptionData({ channel: 'candle', data: { s: 'BTC', i: '1h' } }, candle), false);
  assert.equal(matchesHyperliquidSubscriptionData({ channel: 'candle', data: { i: '1m' } }, candle), false);
});

test('all default Hyperliquid subscriptions require exact ACK and pong never acknowledges subscription', async () => {
  const h = harness(); await h.manager.start();
  try {
    for (const id of ids) {
      const socket = h.socket(id);
      socket.emit({ channel: 'pong' });
      socket.emit({ channel: 'subscriptionResponse', data: { method: 'subscribe', subscription: { ...recordValue(socket.spec.request.subscription), coin: 'ETH' } } });
      assert.equal(h.manager.status()[id].subscriptionAcked, false, id);
      assert.equal(h.manager.status()[id].heartbeatAcked, true, id);
      socket.emit(Buffer.from(JSON.stringify(ack(socket))));
      assert.equal(h.manager.status()[id].subscriptionAcked, true, id);
      assert.equal(h.manager.status()[id].subscriptionAckSource, 'subscription-response', id);
    }
    assert.equal(h.messages.length, 0);
  } finally { h.manager.stop(); }
});

test('foreign/missing Hyperliquid channel, coin and interval cannot hydrate or refresh feed health', async () => {
  const h = harness(); await h.manager.start();
  try {
    for (const id of ids) {
      const socket = h.socket(id); const observedAt = h.manager.status()[id].lastObservedAt;
      h.advance(1);
      socket.emit(validFrame(id, 'ETH'));
      socket.emit({ ...validFrame(id), channel: 'foreign' });
      socket.emit({ channel: socket.spec.channel, data: {} });
      if (id === 'hl-candle') socket.emit({ channel: 'candle', data: { s: 'BTC', i: '1h' } });
      assert.equal(h.manager.status()[id].lastObservedAt, observedAt, id);
      assert.equal(h.manager.status()[id].subscriptionAcked, false, id);
      assert.equal(h.messages.length, 0, id);
    }
    for (const id of ids) {
      h.socket(id).emit(Buffer.from(JSON.stringify(validFrame(id))));
      assert.equal(h.manager.status()[id].subscriptionAcked, false, id);
      assert.equal(h.manager.status()[id].subscriptionAckSource ?? null, null, id);
    }
    assert.equal(h.messages.filter(event => event.message.kind === 'depthSnapshot').length, 2);
    assert.equal(h.messages.filter(event => event.message.kind === 'openInterest').length, 1);
    assert.equal(h.messages.filter(event => event.message.kind === 'candle').length, 1);
    assert.equal(h.messages.filter(event => event.message.kind === 'trade').length, 1);
    assert.equal(h.messages.find(event => event.message.kind === 'openInterest')?.message.sourceTimestamp, null);
  } finally { h.manager.stop(); }
});

test('each default Hyperliquid feed reconnects once and rejects retired data/ACK/pong', async () => {
  for (const id of ids) {
    const h = harness(); await h.manager.start();
    try {
      const first = h.socket(id); first.emit(ack(first)); first.emit(validFrame(id));
      first.closeWith();
      assert.equal(h.manager.status()[id].state, 'backoff', id);
      const count = h.messages.length;
      first.emit(validFrame(id, 'BTC', 1_700_000_000_500)); first.emit(ack(first)); first.emit({ channel: 'pong' });
      assert.equal(h.messages.length, count, id);
      assert.equal(h.retries.length, 1, id);
      await h.retries[0].fn();
      const replacement = h.socket(id); assert.notStrictEqual(replacement, first);
      assert.equal(h.manager.status()[id].subscriptionAcked, false, id);
      first.emit(ack(first)); assert.equal(h.manager.status()[id].subscriptionAcked, false, id);
      replacement.emit(ack(replacement)); replacement.emit(validFrame(id, 'BTC', 1_700_000_000_600));
      assert.equal(h.manager.status()[id].state, 'live', id);
      assert.ok(h.messages.length > count, id);
      if (id.startsWith('hl-l2Book')) assert.equal(h.messages.find(event => event.id === id && event.message.invalidated)?.message.gap, true);
    } finally { h.manager.stop(); }
  }
});

test('malformed matching Hyperliquid data retires its socket and preserves explicit recovery error', async () => {
  const h = harness(); await h.manager.start();
  try {
    const socket = h.socket('hl-l2Book'); socket.emit(validFrame('hl-l2Book'));
    socket.emit({ channel: 'l2Book', data: { coin: 'BTC', levels: 'invalid' } });
    assert.equal(socket.closed, true);
    assert.equal(h.manager.status()['hl-l2Book'].state, 'backoff');
    assert.match(String(h.manager.status()['hl-l2Book'].lastError), /levels missing/);
    assert.equal(h.messages.at(-1)?.message.invalidated, true);
    assert.equal(h.retries.length, 1);
  } finally { h.manager.stop(); }
});

test('Binance silence can time out while protocol ping/pong and valid data keep only current sockets alive', async () => {
  const h = harness(); await h.manager.start();
  try {
    const socket = h.socket('binance-trades');
    const feed = h.manager.feeds.get('binance-trades'); assert.ok(feed);
    const initial = h.manager.status()['binance-trades'].lastObservedAt;
    h.advance(200);
    // A skipped JSON heartbeat must not self-observe a silent Binance socket.
    const timer = h.heartbeats.find(item => item === feed.heartbeatTimer); assert.ok(timer); await timer.fn();
    assert.equal(h.manager.status()['binance-trades'].lastObservedAt, initial);
    h.advance(99); socket.dispatch('ping', Buffer.from('public heartbeat'));
    const pingAt = h.manager.status()['binance-trades'].lastObservedAt;
    assert.notEqual(pingAt, initial);
    h.advance(1); socket.emit({ e: 'aggTrade', s: 'ETHUSDT', a: 1, p: '100', q: '2', T: 1_700_000_000_100, m: true });
    assert.equal(h.manager.status()['binance-trades'].lastObservedAt, pingAt);
    h.advance(300);
    const deadline = h.heartbeats.find(item => item === feed.heartbeatTimer); assert.ok(deadline); await deadline.fn();
    assert.equal(socket.closed, true);
    assert.equal(h.manager.status()['binance-trades'].state, 'backoff');
    assert.match(String(h.manager.status()['binance-trades'].lastError), /heartbeat-timeout/);
    const retiredAt = h.manager.status()['binance-trades'].lastObservedAt;
    socket.dispatch('pong', 'retired'); assert.equal(h.manager.status()['binance-trades'].lastObservedAt, retiredAt);
    await h.retries[0].fn(); const replacement = h.socket('binance-trades');
    replacement.emit({ e: 'aggTrade', s: 'BTCUSDT', a: 2, p: '100', q: '2', T: 1_700_000_000_100, m: false });
    assert.equal(h.manager.status()['binance-trades'].state, 'live');
    assert.equal(h.messages.filter(event => event.id === 'binance-trades').length, 1);
  } finally { h.manager.stop(); }
});

test('runtime registry exposes shipped families and source grouping without claiming broader implementation', () => {
  assert.deepEqual(getVenue('bybit')?.marketTypes, ['spot', 'perpetual']);
  assert.match(getVenue('bybit')?.capabilities.l2.reason ?? '', /delivery\/options are not wired/);
  assert.deepEqual(getVenue('deribit')?.capabilities.l2.resolutions, ['coarse']);
  assert.match(getVenue('deribit')?.capabilities.l2.limits ?? '', /no native\/delta stream/);
  assert.match(getVenue('hyperliquid')?.capabilities.products.reason ?? '', /spot and namespaced HIP-3 discovery are not wired/);
});
