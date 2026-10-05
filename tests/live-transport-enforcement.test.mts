import type { LiveFeedSocket, LiveFeedTransportOptions, LiveFeedStatusEvent, FeedTimer } from '../src/server/live-feeds.mts';
import { defined, fields, list, numeric, textValue, fieldMap, injectMapFixture, injectArrayFixture } from './server-test-helpers.mts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { LiveFeedManager } from '../src/server/live-feeds.mts';
import { VenueTransportBudget } from '../src/adapters/index.mts';

class TransportSocket implements LiveFeedSocket {
  spec: LiveFeedTransportOptions; sent: string[]; sentAt: number[]; closed: boolean; opened = false;
  onMessage: ((raw: unknown) => void) | undefined;
  onClose: ((reason: unknown) => void) | undefined;
  onError: ((error: unknown) => void) | undefined;
  constructor(spec: LiveFeedTransportOptions) { this.spec = spec; this.sent = []; this.sentAt = []; this.closed = false; this.onMessage = undefined; this.onClose = undefined; this.onError = undefined; }
  async open() { this.opened = true; }
  send(value: string) { this.sent.push(value); this.sentAt.push(Date.now()); }
  close() { this.closed = true; }
  emit(value: unknown) { this.onMessage?.(value); }
  closeWith(reason = 'test close') { this.onClose?.(reason); }
}

function makeTransport() {
  const sockets: TransportSocket[] = [];
  return { sockets, factory: async (spec: LiveFeedTransportOptions) => { const socket = new TransportSocket(spec); sockets.push(socket); return socket; } };
}

function heldSchedule() {
  const timers: { fn: () => unknown; delay: number; cancelled: boolean }[] = [];
  return { timers, schedule: (fn: () => unknown, delay: number) => { const item = { fn, delay, cancelled: false }; timers.push(item); return item; }, cancel: (item: FeedTimer) => { if (item) fields(item).cancelled = true; } };
}

test('manager enforces venue connection budgets and releases ownership on stop', async () => {
  const transport = makeTransport(); const retries = heldSchedule();
  const budget = new VenueTransportBudget({ policies: { hyperliquid: { maxConnections: 1, subscribeIntervalMs: 0, heartbeatIntervalMs: 60_000, heartbeatTimeoutMs: 60_000 } } });
  const manager = new LiveFeedManager({ networkEnabled: true, transportFactory: transport.factory, transportBudget: budget, transportIdleMs: 0, oiPollMs: 0, schedule: retries.schedule, cancel: retries.cancel });
  await manager.start({ hlBookResolutions: [{}] });
  assert.equal(budget.snapshot().hyperliquid.connections, 1);
  assert.ok(Object.values(manager.status()).some(status => /connection budget exhausted/.test(textValue(status.lastError ?? ''))));
  manager.stop();
  assert.equal(budget.snapshot().hyperliquid.connections, 0);
});

test('manager paces venue subscriptions and records explicit acknowledgements', async () => {
  const transport = makeTransport();
  const budget = new VenueTransportBudget({ policies: { hyperliquid: { maxConnections: 10, subscribeIntervalMs: 20, heartbeatIntervalMs: 60_000, heartbeatTimeoutMs: 60_000 } } });
  const manager = new LiveFeedManager({ networkEnabled: true, transportFactory: transport.factory, transportBudget: budget, transportIdleMs: 0, oiPollMs: 0 });
  await manager.start({ hlBookResolutions: [{}] });
  const sockets = transport.sockets.filter(socket => socket.spec.venue === 'hyperliquid');
  const sentAt = sockets.flatMap(socket => socket.sentAt).sort((a, b) => a - b);
  assert.equal(sentAt.length, 4);
  assert.ok(defined(sentAt.at(-1)) - sentAt[0] >= 45, JSON.stringify(sentAt));
  const feed = manager.feeds.get('hl-l2Book-native');
  assert.equal(manager.status()['hl-l2Book-native'].subscriptionAcked, false);
  fixtureSocket(defined(feed).socket).emit({ channel: 'subscriptionResponse', data: { method: 'subscribe', subscription: defined(feed).spec.request.subscription } });
  assert.equal(manager.status()['hl-l2Book-native'].subscriptionAcked, true);
  assert.ok(budget.snapshot().hyperliquid.subscriptions.includes('hl-l2Book-native'));
  manager.stop();
});

test('heartbeat silence closes the owned socket and schedules a bounded reconnect', async () => {
  const transport = makeTransport(); const retries = heldSchedule();
  const budget = new VenueTransportBudget({ policies: { hyperliquid: { maxConnections: 10, subscribeIntervalMs: 0, heartbeatIntervalMs: 20, heartbeatTimeoutMs: 20 } } });
  const manager = new LiveFeedManager({ networkEnabled: true, transportFactory: transport.factory, transportBudget: budget, transportIdleMs: 0, oiPollMs: 0, schedule: retries.schedule, cancel: retries.cancel, reconnectBaseMs: 50, reconnectMaxMs: 100 });
  await manager.start({ hlBookResolutions: [{}] });
  const socket = transport.sockets.find(item => item.spec.id === 'hl-l2Book-native');
  await new Promise(resolve => setTimeout(resolve, 70));
  assert.equal(defined(socket).closed, true);
  assert.equal(manager.status()['hl-l2Book-native'].state, 'backoff');
  assert.match(textValue(manager.status()['hl-l2Book-native'].lastError), /heartbeat-timeout/);
  assert.equal(budget.snapshot().hyperliquid.connections, 0);
  manager.stop();
});

test('acknowledged idle subscriptions are retired and release their socket budget', async () => {
  const transport = makeTransport();
  const budget = new VenueTransportBudget({ policies: { hyperliquid: { maxConnections: 10, subscribeIntervalMs: 0, heartbeatIntervalMs: 40, heartbeatTimeoutMs: 100 } } });
  let resolveIdleRetirement: ((status: LiveFeedStatusEvent) => void) | undefined;
  const idleRetirement = new Promise<LiveFeedStatusEvent>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('idle transport retirement status was not observed')), 2_000);
    resolveIdleRetirement = status => { clearTimeout(timeout); resolve(status); };
  });
  const manager = new LiveFeedManager({
    networkEnabled: true,
    transportFactory: transport.factory,
    transportBudget: budget,
    transportIdleMs: 10,
    oiPollMs: 0,
    onStatus: status => {
      if (status.id === 'hl-l2Book-native' && status.state === 'stopped' && status.lastError === 'idle transport retired') defined(resolveIdleRetirement)(status);
    },
  });
  await manager.start({ hlBookResolutions: [{}] });
  const feed = manager.feeds.get('hl-l2Book-native');
  fixtureSocket(defined(feed).socket).emit({ channel: 'subscriptionResponse', data: { method: 'subscribe', subscription: defined(feed).spec.request.subscription } });
  const retiredStatus = await idleRetirement;
  assert.equal(fields(retiredStatus).state, 'stopped');
  assert.equal(fields(retiredStatus).lastError, 'idle transport retired');
  assert.equal(manager.feeds.has('hl-l2Book-native'), false);
  assert.equal(manager.status()['hl-l2Book-native'].state, 'stopped');
  assert.match(textValue(manager.status()['hl-l2Book-native'].lastError), /idle transport retired/);
  assert.equal(budget.snapshot().hyperliquid.connections, 3);
  manager.stop();
});

test('Hyperliquid subscription rejection fails closed for text and Buffer frames', async () => {
  for (const payload of [
    JSON.stringify({ channel: 'subscriptionResponse', data: { method: 'subscribe', error: 'denied' } }),
    Buffer.from(JSON.stringify({ channel: 'subscriptionResponse', data: { method: 'subscribe', error: 'denied' } })),
  ]) {
    const transport = makeTransport(); const retries = heldSchedule();
    const budget = new VenueTransportBudget({ policies: { hyperliquid: { maxConnections: 10, subscribeIntervalMs: 0, heartbeatIntervalMs: 60_000, heartbeatTimeoutMs: 60_000 } } });
    const manager = new LiveFeedManager({ networkEnabled: true, transportFactory: transport.factory, transportBudget: budget, transportIdleMs: 0, oiPollMs: 0, schedule: retries.schedule, cancel: retries.cancel });
    await manager.start({ hlBookResolutions: [{}] });
    const feed = manager.feeds.get('hl-l2Book-native');
    fixtureSocket(defined(feed).socket).emit(payload);
    assert.equal(fixtureSocket(defined(feed).socket).closed, true);
    assert.equal(manager.status()['hl-l2Book-native'].state, 'backoff');
    assert.match(textValue(manager.status()['hl-l2Book-native'].lastError), /subscription rejected/);
    assert.equal(budget.snapshot().hyperliquid.connections, 3);
    manager.stop();
  }
});

test('Hyperliquid pong frames update heartbeat state for text and Buffer frames', async () => {
  for (const payload of [
    JSON.stringify({ channel: 'pong' }),
    Buffer.from(JSON.stringify({ channel: 'pong' })),
  ]) {
    const transport = makeTransport();
    const budget = new VenueTransportBudget({ policies: { hyperliquid: { maxConnections: 10, subscribeIntervalMs: 0, heartbeatIntervalMs: 60_000, heartbeatTimeoutMs: 60_000 } } });
    const manager = new LiveFeedManager({ networkEnabled: true, transportFactory: transport.factory, transportBudget: budget, transportIdleMs: 0, oiPollMs: 0 });
    await manager.start({ hlBookResolutions: [{}] });
    const feed = manager.feeds.get('hl-l2Book-native');
    fixtureSocket(defined(feed).socket).emit(payload);
    const status = manager.status()['hl-l2Book-native'];
    assert.equal(fixtureSocket(defined(feed).socket).closed, false);
    assert.equal(status.state, 'live');
    assert.equal(status.subscriptionAcked, false);
    assert.equal(status.heartbeatAcked, true);
    assert.equal(status.heartbeatAckSource, 'heartbeat');
    assert.equal(status.lastError, null);
    manager.stop();
  }
});

test('Bybit negative acknowledgement releases the retired session before retry', async () => {
  const transport = makeTransport(); const retries = heldSchedule();
  const budget = new VenueTransportBudget({ policies: { bybit: { maxConnections: 10, subscribeIntervalMs: 0, heartbeatIntervalMs: 60_000, heartbeatTimeoutMs: 60_000 } } });
  const manager = new LiveFeedManager({ networkEnabled: true, transportFactory: transport.factory, transportBudget: budget, transportIdleMs: 0, oiPollMs: 0, schedule: retries.schedule, cancel: retries.cancel });
  await manager.start({ bybitEnabled: true, bybitSymbol: 'BTCUSDT' });
  const feed = manager.feeds.get('bybit-depth');
  fixtureSocket(defined(feed).socket).emit({ op: 'subscribe', success: false, retCode: 10001, retMsg: 'denied' });
  assert.equal(fixtureSocket(defined(feed).socket).closed, true);
  assert.equal(manager.status()['bybit-depth'].state, 'backoff');
  assert.equal(budget.snapshot().bybit.connections, 0);
  manager.stop();
});

test('retirement never bursts an unsubscribe outside the venue message budget', async () => {
  const transport = makeTransport();
  const budget = new VenueTransportBudget({ now: () => 1_000, policies: { hyperliquid: { maxConnections: 10, subscribeIntervalMs: 50, heartbeatIntervalMs: 60_000, heartbeatTimeoutMs: 60_000 } } });
  const manager = new LiveFeedManager({ networkEnabled: true, transportFactory: transport.factory, transportBudget: budget, transportIdleMs: 0, oiPollMs: 0 });
  await manager.start({ hlBookResolutions: [{}] });
  const old = transport.sockets.filter(socket => socket.spec.venue === 'hyperliquid');
  await manager.start({ hlBookResolutions: [{}] });
  assert.equal(old.every(socket => socket.sent.every(frame => !String(frame).includes('unsubscribe'))), true);
  assert.equal(manager.status()['hl-l2Book-native'].unsubscribeDeferred, true);
  manager.stop();
});

function fixtureSocket(value: unknown): TransportSocket {
  assert.ok(value instanceof TransportSocket);
  return value;
}
