import test from 'node:test';
import { gzipSync } from 'node:zlib';
import assert from 'node:assert/strict';
import { AdapterTransportError } from '../src/adapters/index.mts';
import { LiveFeedManager, configuredCandleInstrumentIds, MAX_LIVE_FEED_MESSAGE_BYTES, MAX_COINBASE_L2_MESSAGE_BYTES } from '../src/server/live-feeds.mts';
import { createLocalServer } from '../src/server/http.mts';
import { QuotaLedger } from '../src/core/quota.mts';
import { HistoryStore } from '../src/server/history.mts';
import { krakenBookChecksum } from '../src/adapters/kraken.mts';
import { logicalRetainedBytes } from '../src/core/retained-bytes.mts';
import { ProcessMemoryMonitor } from '../src/server/process-memory.mts';
import { DEFAULT_BOUNDED_JSON_TOKEN_MEMORY_BYTES, scanBoundedJsonComplexity } from '../src/core/bounded-json-response.mts';
import { createExchangeRestTransport, EXCHANGE_REST_MEMORY_ADMISSION_WAITER_LOGICAL_BYTES, type ExchangeRestRequest } from '../src/server/rest-transport.mts';
import type { LiveFeedEvent, LiveFeedStatusEvent, LiveFeedTransportOptions, LiveFeedSocket, LiveFeedOptions, LiveFeedSpec } from '../src/server/live-feeds.mts';
import type { MutationContext } from '../src/server/http-contracts.mts';
import { defined, fields, list, numeric, textValue, fieldMap, injectMapFixture, injectSetFixture } from './server-test-helpers.mts';

interface RejectedDepthState { sequence: unknown; bridgePending: boolean | undefined; committed: boolean; candidate?: Record<string, unknown>; }
class FakeSocket implements LiveFeedSocket {
  spec: Partial<LiveFeedTransportOptions>;
  sent: string[];
  closed: boolean;
  opened?: boolean;
  onMessage: ((raw: unknown) => void) | undefined;
  onClose: ((reason: unknown) => void) | undefined;
  onError: ((error: unknown) => void) | undefined;
  constructor(spec: Partial<LiveFeedTransportOptions>) { this.spec = spec; this.sent = []; this.closed = false; this.onMessage = undefined; this.onClose = undefined; this.onError = undefined; }
  async open() { this.opened = true; }
  send(value: string) { this.sent.push(value); }
  close() { this.closed = true; }
  emit(value: unknown) { this.onMessage?.(value); }
  closeWith(reason = 'test close') { this.onClose?.(reason); }
}

function makeFakeTransport() {
  const sockets: FakeSocket[] = [];
  return { sockets, factory: async (spec: LiveFeedTransportOptions) => { const socket = new FakeSocket(spec); sockets.push(socket); return socket; } };
}

function makeRestTransport(request: NonNullable<LiveFeedOptions['restTransport']>['request']) {
  return {
    request,
    retainedSnapshot: () => ({
      measurementAvailable: true,
      memoryAdmissionWaiters: 0,
      memoryAdmissionWaiterLimit: 32,
      memoryAdmissionWaiterAllowanceBytes: EXCHANGE_REST_MEMORY_ADMISSION_WAITER_LOGICAL_BYTES,
      memoryAdmissionWaiterLogicalBytes: 0,
    }),
  };
}

test('manager stays disabled and performs no transport work by default', async () => {
  let calls = 0;
  const manager = new LiveFeedManager({ transportFactory: async () => { calls += 1; return new FakeSocket({}); } });
  const status = await manager.start();
  assert.equal(calls, 0); assert.equal(status['hl-l2Book'].state, 'disabled'); assert.equal(status['binance-openInterest'].state, 'disabled');
});

test('manager status-map updates reserve before private mutation and publish only committed snapshots', async () => {
  const admitted: string[] = [];
  let manager: LiveFeedManager;
  manager = new LiveFeedManager({
    retainedAdmission: (candidate, context, commit) => {
      assert.ok(fieldMap(fields(candidate).managerStatuses) instanceof Map);
      assert.ok(fieldMap(fields(candidate).managerStatuses).has(context.feedId));
      assert.notDeepEqual(manager.status()[textValue(context.feedId)], fieldMap(fields(candidate).managerStatuses).get(context.feedId));
      admitted.push(textValue(context.feedId));
      commit();
      return { admitted: true };
    },
    onStatus: status => {
      const { id, ...value } = status;
      assert.deepEqual(manager.status()[id], value);
    },
  });
  try {
    await manager.start();
    assert.ok(admitted.length > 0);
    assert.ok(manager.retainedDiagnostics().logicalComponents.managerStatuses > 0);
  } finally { manager.stop(); }
});

test('rejected manager status admission leaves no unreserved status row and reports unavailable', async () => {
  const published: LiveFeedStatusEvent[] = [];
  let admissionAttempts = 0;
  const manager = new LiveFeedManager({
    retainedAdmission: (candidate, context, _commit, onReject) => {
      assert.ok(fieldMap(fields(candidate).managerStatuses) instanceof Map);
      admissionAttempts += 1;
      const reservation = { reason: 'test-hard-limit', bytes: 0, context: {} };
      onReject?.(reservation);
      return { admitted: false, reservation };
    },
    onStatus: status => published.push(status),
  });
  try {
    await manager.start();
    assert.ok(admissionAttempts > 0);
    assert.deepEqual(manager.status(), {});
    assert.ok(published.length > 0);
    assert.ok(published.every(status => status.state === 'unavailable' && status.active === false));
  } finally { manager.stop(); }
});

test('manager status freshness is coalesced and retained error text is bounded', async () => {
  const fake = makeFakeTransport();
  const statusAdmissions: string[] = [];
  const timers: {fn: () => unknown; delay: number}[] = [];
  let now = 1_700_000_000_000;
  const manager = new LiveFeedManager({
    networkEnabled: true,
    transportFactory: fake.factory,
    oiPollMs: 0,
    now: () => now,
    transportNow: () => now,
    schedule: (fn, delay) => { timers.push({fn, delay}); return timers.length; },
    cancel: () => {},
    retainedAdmission: (candidate, context, commit) => {
      if (context.kind === 'live-feed-status-map') statusAdmissions.push(textValue(context.feedId));
      commit();
      return { admitted: true };
    },
  });
  try {
    await manager.start();
    const socket = fake.sockets.find(item => item.spec.id === 'hl-activeAssetCtx');
    assert.ok(socket);
    const countForActiveContext = () => statusAdmissions.filter(id => id === 'hl-activeAssetCtx').length;
    socket.emit({ channel: 'activeAssetCtx', data: { coin: 'BTC', time: now, ctx: { openInterest: '4', markPx: '100' } } });
    const afterFirstObservation = countForActiveContext();
    now += 1_000;
    socket.emit({ channel: 'activeAssetCtx', data: { coin: 'BTC', time: now, ctx: { openInterest: '4', markPx: '100' } } });
    assert.equal(countForActiveContext(), afterFirstObservation);

    now += 5_000;
    socket.emit({ channel: 'activeAssetCtx', data: { coin: 'BTC', time: now, ctx: { openInterest: '4', markPx: '100' } } });
    assert.ok(countForActiveContext() > afterFirstObservation);

    defined(socket.onError).call(socket, new Error('x'.repeat(5_000)));
    assert.equal(textValue(manager.status()['hl-activeAssetCtx'].lastError).length, 512);
  } finally { manager.stop(); }
});

test('manager last-price cache follows shared admission and exposes only defensive snapshots', async () => {
  const fake = makeFakeTransport();
  const admissions: MutationContext[] = [];
  let manager: LiveFeedManager;
  let behavior = 'reject-shared';
  let priceMessageCallbacks = 0;
  let expectedPreviousLastPrice: number | undefined;
  let callbackInvariantFailed = false;
  manager = new LiveFeedManager({
    networkEnabled: true,
    transportFactory: fake.factory,
    oiPollMs: 0,
    retainedAdmission: (candidate, context, commit) => {
      if (context.kind === 'live-feed-last-price') {
        admissions.push({ candidate, context });
        if (behavior === 'reject-fallback') return { admitted: false, reservation: { reason: 'test-hard-limit', bytes: 0, context: {} } };
      }
      commit();
      return { admitted: true };
    },
    onMessage: ({ message, retainedMutation }) => {
      if (message.kind !== 'price') return;
      priceMessageCallbacks += 1;
      if (manager.lastPrices.get(defined(message.instrumentId)) !== expectedPreviousLastPrice
          || retainedMutation?.candidate.kind !== 'feed-last-price') callbackInvariantFailed = true;
      if (behavior === 'reject-shared') return false;
      if (behavior === 'commit-shared') defined(retainedMutation).commit();
    },
  });
  const instrumentId = 'binance:BTCUSDT';
  try {
    await manager.start({ coin: 'BTC', binanceSymbol: 'BTCUSDT' });
    const markSocket = fake.sockets.find(socket => socket.spec.channel === 'markPrice');
    assert.ok(markSocket);
    const emitMark = (price: number) => markSocket.emit(JSON.stringify({ e: 'markPriceUpdate', E: 1_700_000_000_000, s: 'BTCUSDT', p: String(price) }));

    emitMark(100.5);
    assert.equal(manager.lastPrices.has(instrumentId), false);
    assert.equal(callbackInvariantFailed, false);

    behavior = 'commit-shared';
    emitMark(101.5);
    assert.equal(manager.lastPrices.get(instrumentId), 101.5);
    expectedPreviousLastPrice = 101.5;
    assert.equal(callbackInvariantFailed, false);

    behavior = 'reject-fallback';
    emitMark(102.5);
    assert.equal(manager.lastPrices.get(instrumentId), 101.5);
    assert.equal(fields(defined(admissions.at(-1)).context).kind, 'live-feed-last-price');
    assert.equal(fields(defined(admissions.at(-1)).candidate).price, 102.5);
    assert.equal(callbackInvariantFailed, false);

    behavior = 'accept-fallback';
    emitMark(103.5);
    assert.equal(manager.lastPrices.get(instrumentId), 103.5);
    expectedPreviousLastPrice = 103.5;
    assert.equal(callbackInvariantFailed, false);

    const exposedSnapshot = manager.lastPrices;
    exposedSnapshot.clear();
    for (let index = 0; index < 64; index += 1) exposedSnapshot.set(`other:${index}`, index + 1);
    assert.equal(exposedSnapshot.size, 64);
    assert.equal(manager.lastPrices.size, 1);
    assert.equal(manager.lastPrices.get(instrumentId), 103.5);

    emitMark(104.5);
    assert.equal(manager.lastPrices.size, 1);
    assert.equal(manager.lastPrices.get(instrumentId), 104.5);
  } finally { manager.stop(); }
});

test('manager last-price cache rejects a new key at its 64-entry capacity', async () => {
  const fake = makeFakeTransport();
  let priceCallbacks = 0;
  const manager = new LiveFeedManager({
    networkEnabled: true,
    transportFactory: fake.factory,
    oiPollMs: 0,
    onMessage: ({ message, retainedMutation }) => {
      if (message.kind !== 'price') return;
      priceCallbacks += 1;
      retainedMutation?.commit();
    },
  });
  try {
    await manager.start({ coin: 'BTC', binanceSymbol: 'BTCUSDT' });
    const markSocket = fake.sockets.find(socket => socket.spec.channel === 'markPrice');
    const priceFeed = manager.feeds.get('binance-markPrice');
    assert.ok(markSocket);
    assert.ok(priceFeed);
    for (let index = 0; index < 64; index += 1) {
      const instrumentId = `binance:test-${index}`;
      priceFeed.spec.instrumentId = instrumentId;
      priceFeed.spec.decode = () => ({ kind: 'price', instrumentId, price: index + 1 });
      markSocket.emit(JSON.stringify({ e: 'markPriceUpdate', E: 1_700_000_000_000, s: 'BTCUSDT', p: String(index + 1) }));
    }

    const overflowInstrumentId = 'binance:test-64';
    priceFeed.spec.instrumentId = overflowInstrumentId;
    priceFeed.spec.decode = () => ({ kind: 'price', instrumentId: overflowInstrumentId, price: 65 });
    markSocket.emit(JSON.stringify({ e: 'markPriceUpdate', E: 1_700_000_000_000, s: 'BTCUSDT', p: '65' }));

    const retained = manager.lastPrices;
    assert.equal(priceCallbacks, 64);
    assert.equal(retained.size, 64);
    assert.equal(retained.has(overflowInstrumentId), false);
    assert.equal(manager.status()['binance-markPrice'].state, 'unavailable');
    assert.equal(manager.status()['binance-markPrice'].lastError, 'manager last-price capacity exceeded');
  } finally { manager.stop(); }
});

test('deeply nested status arrays stop at the retained value depth bound', () => {
  const events: LiveFeedStatusEvent[] = [];
  const manager = new LiveFeedManager({ onStatus: status => events.push(status) });
  const instrumentId = 'binance:BTCUSDT';
  let nestedBookKey: unknown = 'native';
  for (let depth = 0; depth < 4_096; depth += 1) nestedBookKey = [nestedBookKey];
  manager.specs.set('binance-depth', { venue: 'binance', channel: 'depth', instrumentId, bookKey: 'native', resolutionKey: 'native', request: {}, decode: () => null });
  fields(defined(manager.specs.get('binance-depth'))).bookKey = nestedBookKey;
  try {
    assert.doesNotThrow(() => manager.refreshActiveBookSets());
    assert.deepEqual(defined(events.at(-1)).activeBookSets, { [instrumentId]: [] });
  } finally { manager.stop(); }
});

test('status callbacks and returned snapshots cannot mutate retained manager status values', () => {
  const instrumentId = 'binance:BTCUSDT';
  const bookKey = `${instrumentId}|native`;
  const manager = new LiveFeedManager({ onStatus: status => {
    if (status.id !== 'active-book-set' || !fields(status.activeBookSets)?.[instrumentId]) return;
    fields(fields(status.activeBookSets)[instrumentId])[0] = 'callback-mutated';
    fields(status.activeBookSets).extra = ['callback-growth'];
  } });
  manager.specs.set('binance-depth', { venue: 'binance', channel: 'depth', instrumentId, bookKey, resolutionKey: 'native', request: {}, decode: () => null });
  try {
    manager.refreshActiveBookSets();
    const before = manager.retainedDiagnostics().logicalComponents.managerStatuses;
    const snapshot = manager.status();
    fields(fields(snapshot['active-book-set'].activeBookSets)[instrumentId])[0] = 'snapshot-mutated';
    fields(snapshot['active-book-set'].activeBookSets).extra = ['snapshot-growth'];

    assert.deepEqual(manager.status()['active-book-set'].activeBookSets, { [instrumentId]: [bookKey] });
    assert.equal(manager.retainedDiagnostics().logicalComponents.managerStatuses, before);
  } finally { manager.stop(); }
});

test('rejected status updates preserve reconnect attempt counts through shrink-only fallback', async () => {
  const fake = makeFakeTransport();
  const timers: {fn: () => unknown; delay: number}[] = [];
  let rejectBackoff = false;
  const manager = new LiveFeedManager({
    networkEnabled: true,
    transportFactory: fake.factory,
    oiPollMs: 0,
    reconnectBaseMs: 100,
    reconnectMaxMs: 250,
    now: () => 1_000,
    schedule: (fn, delay) => { timers.push({ fn, delay }); return timers.length; },
    cancel: () => {},
    retainedAdmission: (candidate, context, commit, onReject) => {
      const status = fieldMap(fields(candidate).managerStatuses).get(context.feedId);
      if (rejectBackoff && context.feedId === 'hl-l2Book' && fields(status)?.state === 'backoff') {
        const reservation = { reason: 'test-hard-limit', bytes: 0, context: {} };
        onReject?.(reservation);
        return { admitted: false, reservation };
      }
      commit();
      return { admitted: true };
    },
  });
  try {
    await manager.start();
    rejectBackoff = true;
    defined(fake.sockets.find(socket => socket.spec.id === 'hl-l2Book')).closeWith('lost');
    assert.equal(timers.length, 1);
    assert.equal(timers[0].delay, 100);
    assert.equal(manager.status()['hl-l2Book'].state, 'unavailable');
    assert.equal(manager.status()['hl-l2Book'].attempt, 1);
  } finally { manager.stop(); }
});

interface OpenAdmissionTimer { id: number; fn: () => unknown; delay: number; }
function makeDeniedOpenFixture(options: Pick<LiveFeedOptions, 'restTransport'> = {}) {
  const fake = makeFakeTransport();
  const timers = new Map<number, OpenAdmissionTimer>();
  const published: LiveFeedStatusEvent[] = [];
  let now = 1_000;
  let timerSequence = 0;
  let acquisitionCalls = 0;
  let admissionMode: 'all' | 'connecting' | 'none' = 'connecting';
  const manager = new LiveFeedManager({
    ...options,
    networkEnabled: true,
    transportFactory: fake.factory,
    oiPollMs: 0,
    reconnectBaseMs: 100,
    reconnectMaxMs: 250,
    now: () => now,
    transportNow: () => now,
    schedule: (fn, delay) => { const id = ++timerSequence; timers.set(id, { id, fn, delay }); return id; },
    cancel: timer => { if (typeof timer === 'number') timers.delete(timer); },
    heartbeatSchedule: () => 0,
    heartbeatCancel: () => {},
    retainedAdmission: (candidate, context, commit, onReject) => {
      if (context.kind === 'live-feed-status-map') {
        const next = fields(fieldMap(fields(candidate).managerStatuses).get(context.feedId));
        if (admissionMode === 'all' || admissionMode === 'connecting' && next.state === 'connecting') {
          const reservation = { reason: 'physical-rss-hard-limit', bytes: 0, context };
          onReject?.(reservation);
          return { admitted: false, reservation };
        }
      }
      commit();
      return { admitted: true };
    },
    onStatus: status => published.push(status),
  });
  const acquireConnection = manager.transportBudget.acquireConnection.bind(manager.transportBudget);
  manager.transportBudget.acquireConnection = venue => { acquisitionCalls += 1; return acquireConnection(venue); };
  const timerFor = (id: string) => defined(timers.get(numeric(defined(manager.feeds.get(id)).retry)));
  return {
    manager, fake, timers, published, timerFor,
    acquisitionCalls: () => acquisitionCalls,
    connections: () => Object.values(manager.transportBudget.snapshot()).reduce((sum, venue) => sum + venue.connections, 0),
    setAdmissionMode: (mode: typeof admissionMode) => { admissionMode = mode; },
    fire: async (id: string) => {
      const timer = timerFor(id);
      timers.delete(timer.id);
      now += timer.delay;
      await timer.fn();
      return timer;
    },
  };
}

test('denied connecting admission performs no socket or quota work and keeps one bounded retry per feed', async () => {
  const fixture = makeDeniedOpenFixture();
  fixture.setAdmissionMode('all');
  try {
    await fixture.manager.start();
    const feedCount = fixture.manager.specs.size;
    assert.ok(feedCount > 0);
    const assertDenied = () => {
      assert.equal(fixture.fake.sockets.length, 0);
      assert.equal(fixture.acquisitionCalls(), 0, 'connection quota is never acquired, even transiently');
      assert.equal(fixture.connections(), 0);
      assert.equal(fixture.timers.size, feedCount);
      const owners = new Set<number>();
      for (const id of fixture.manager.specs.keys()) {
        const timer = fixture.timerFor(id);
        assert.ok(timer.delay >= 100 && timer.delay <= 250);
        owners.add(timer.id);
      }
      assert.equal(owners.size, feedCount, 'each feed owns exactly one pending retry');
      const status = defined(fixture.published.filter(row => row.id === 'hl-l2Book').at(-1));
      assert.equal(status.state, 'unavailable');
      assert.equal(status.active, false);
    };
    assertDenied();
    for (let attempt = 0; attempt < 4; attempt++) { await fixture.fire('hl-l2Book'); assertDenied(); }
  } finally { fixture.manager.stop(); }
  assert.equal(fixture.timers.size, 0);
});

test('denied connecting admission retries the existing placeholder generation and recovers exactly once', async () => {
  const fixture = makeDeniedOpenFixture();
  try {
    await fixture.manager.start();
    assert.equal(fixture.fake.sockets.length, 0);
    const first = fixture.timerFor('hl-l2Book');
    await fixture.fire('hl-l2Book');
    assert.equal(fixture.timerFor('hl-l2Book').delay, 200);
    await fixture.fire('hl-l2Book');
    const recovering = fixture.timerFor('hl-l2Book');
    assert.equal(recovering.delay, 250);
    assert.equal(fixture.manager.status()['hl-l2Book'].state, 'unavailable');
    assert.equal(fixture.acquisitionCalls(), 0);
    fixture.setAdmissionMode('none');
    await first.fn();
    assert.equal(fixture.fake.sockets.length, 0, 'an older generation cannot open after admission recovers');
    await fixture.fire('hl-l2Book');
    assert.equal(fixture.fake.sockets.length, 1);
    assert.equal(fixture.acquisitionCalls(), 1);
    assert.equal(fixture.connections(), 1);
    assert.equal(fixture.manager.status()['hl-l2Book'].state, 'live');
    assert.equal(defined(fixture.manager.feeds.get('hl-l2Book')).retry, null);
    const subscription: unknown = JSON.parse(defined(fixture.fake.sockets[0].sent[0]));
    assert.deepEqual(fields(subscription).subscription, { type: 'l2Book', coin: 'BTC', nSigFigs: 2 });
    await recovering.fn();
    assert.equal(fixture.fake.sockets.length, 1, 'a consumed retry cannot create another transport');
    assert.equal(fixture.acquisitionCalls(), 1);
  } finally { fixture.manager.stop(); }
  assert.equal(fixture.connections(), 0);
  assert.equal(fixture.timers.size, 0);
});

test('denied connecting admission leaves stopped and reconfigured retry callbacks unable to open', async () => {
  const fixture = makeDeniedOpenFixture();
  try {
    await fixture.manager.start();
    assert.equal(fixture.fake.sockets.length, 0);
    const stopped = fixture.timerFor('hl-l2Book');
    fixture.manager.stop();
    fixture.setAdmissionMode('none');
    await stopped.fn();
    assert.equal(fixture.fake.sockets.length, 0);
    assert.equal(fixture.acquisitionCalls(), 0);
    assert.equal(fixture.timers.size, 0);
    fixture.setAdmissionMode('connecting');
    await fixture.manager.start();
    const reconfigured = fixture.timerFor('hl-l2Book');
    await fixture.manager.start({ coin: 'ETH', hlBookNsigFigs: 3 });
    const current = fixture.timerFor('hl-l2Book');
    fixture.setAdmissionMode('none');
    await reconfigured.fn();
    await stopped.fn();
    assert.equal(fixture.fake.sockets.length, 0);
    assert.equal(fixture.acquisitionCalls(), 0);
    assert.equal(fixture.timerFor('hl-l2Book'), current, 'stale callbacks cannot retire the current retry');
    await fixture.fire('hl-l2Book');
    assert.equal(fixture.fake.sockets.length, 1);
    const subscription: unknown = JSON.parse(defined(fixture.fake.sockets[0].sent[0]));
    assert.deepEqual(fields(subscription).subscription, { type: 'l2Book', coin: 'ETH', nSigFigs: 3 });
  } finally { fixture.manager.stop(); }
});

test('denied connecting admission skips dependent Binance snapshots and preserves admitted reconnect ACKs', async () => {
  let depthCalls = 0;
  const fixture = makeDeniedOpenFixture({
    restTransport: makeRestTransport(async request => request.url.includes('/depth')
      ? (++depthCalls, { lastUpdateId: depthCalls * 100, bids: [['100', '2']], asks: [['101', '3']] })
      : []),
  });
  try {
    await fixture.manager.start();
    assert.equal(fixture.fake.sockets.length, 0);
    assert.equal(depthCalls, 0, 'startup snapshot depends on an admitted transport open');
    for (let attempt = 0; attempt < 2; attempt++) {
      await fixture.fire('binance-depth');
      assert.equal(fixture.fake.sockets.length, 0);
      assert.equal(fixture.acquisitionCalls(), 0);
      assert.equal(depthCalls, 0, 'a denied retry cannot start dependent REST work');
      assert.equal(fixture.timers.size, fixture.manager.specs.size);
    }
    fixture.setAdmissionMode('none');
    const recovering = fixture.timerFor('binance-depth');
    await fixture.fire('binance-depth');
    assert.equal(fixture.fake.sockets.length, 1);
    assert.equal(depthCalls, 1);
    assert.equal(fixture.manager.status()['binance-depth'].state, 'snapshot');
    assert.equal(fixture.manager.status()['binance-depth'].subscriptionAcked, true);
    await recovering.fn();
    assert.equal(depthCalls, 1);
    fixture.fake.sockets[0].closeWith('lost');
    await fixture.fire('binance-depth');
    assert.equal(fixture.fake.sockets.length, 2);
    assert.equal(depthCalls, 2);
    assert.equal(fixture.manager.status()['binance-depth'].subscriptionAcked, true);
    assert.equal(fixture.connections(), 1);
  } finally { fixture.manager.stop(); }
});

test('manager can republish its current active book selection for an admission retry', () => {
  const events: LiveFeedStatusEvent[] = [];
  const manager = new LiveFeedManager({ onStatus: status => events.push(status) });
  const instrumentId = 'binance:BTCUSDT';
  const bookKey = `${instrumentId}|native`;
  manager.specs.set('binance-depth', { venue: 'binance', channel: 'depth', instrumentId, bookKey, resolutionKey: 'native', request: {}, decode: () => null });
  try {
    manager.refreshActiveBookSets();
    assert.deepEqual(defined(events.at(-1)).activeBookSets, { [instrumentId]: [bookKey] });
  } finally {
    manager.stop();
  }
});

test('startup candle instrument IDs use the same configured market identity as live feeds', () => {
  assert.deepEqual(configuredCandleInstrumentIds({ coin: 'ETH-PERP', binanceSymbol: 'ETHUSDT', binanceMarketType: 'spot' }), [
    'hyperliquid:ETH-PERP',
    'binance:ETHUSDT:spot',
  ]);
});

test('Hyperliquid manager preserves HIP-3 DEX names in every public feed spec', async () => {
  const coin = 'xyz:XYZ100';
  const instrumentId = 'hyperliquid:' + coin + '-PERP';
  const manager = new LiveFeedManager();
  try {
    await manager.start({ coin });
    assert.equal(configuredCandleInstrumentIds({ coin })[0], instrumentId);
    for (const id of ['hl-l2Book-native', 'hl-l2Book', 'hl-activeAssetCtx', 'hl-candle', 'hl-trades']) {
      const spec = manager.specs.get(id);
      assert.ok(spec, id);
      assert.equal(fields(spec.request.subscription).coin, coin, id);
    }
    assert.equal(defined(manager.specs.get('hl-l2Book-native')).instrumentId, instrumentId);
    assert.equal(defined(manager.specs.get('hl-l2Book')).instrumentId, instrumentId);
    assert.equal(defined(manager.specs.get('hl-candle')).instrumentId, instrumentId);
  } finally {
    manager.stop();
  }
});

test('feed retained diagnostics grow with actual depth payloads and clear book state on stop', () => {
  const manager = new LiveFeedManager();
  const before = manager.retainedDiagnostics();
  manager.depthBuffers.set('binance:BTCUSDT', [{ kind: 'depthDelta', price: 77_000, payload: 'x'.repeat(4_096) }]);
  const after = manager.retainedDiagnostics();
  assert.ok(after.logicalComponents.depthBuffers > before.logicalComponents.depthBuffers);
  assert.ok(defined(after.logicalBytes) > defined(before.logicalBytes));
  manager.stop();
  const stopped = manager.retainedDiagnostics();
  assert.equal(stopped.logicalComponents.feeds, 0);
  assert.equal(stopped.logicalComponents.depthBuffers, 0);
});

test('feed retained diagnostics include manager metadata, status, transport, generation, and REST owners', async () => {
  let release: ((value: unknown) => void) | undefined;
  const manager = new LiveFeedManager({
    networkEnabled: true,
    restTransport: { request: async () => new Promise(resolve => { release = resolve; }) },
  });
  try {
    const before = manager.retainedDiagnostics();
    manager.feedGenerations.set('binance-depth', 7);
    manager.transportBudget.touch('whitebit', 'whitebit-depth');
    const pending = manager.syncWhitebitMetadata();
    await new Promise(resolve => setImmediate(resolve));

    const during = manager.retainedDiagnostics();
    assert.ok(during.logicalComponents.feedGenerations > before.logicalComponents.feedGenerations);
    assert.ok(during.logicalComponents.managerStatuses > before.logicalComponents.managerStatuses);
    assert.ok(during.logicalComponents.transportBudgetState > before.logicalComponents.transportBudgetState);
    assert.ok(during.logicalComponents.restCoordinator > before.logicalComponents.restCoordinator);
    const inFlightBytes = during.logicalComponents.restCoordinator;

    defined(release)([{ name: 'BTC_USDT', stock: 'BTC', money: 'USDT', moneyPrec: 2, stockPrec: 6 }]);
    const metadata = await pending;
    assert.ok(metadata);
    const after = manager.retainedDiagnostics();
    assert.ok(after.logicalComponents.venueMetadata > before.logicalComponents.venueMetadata);
    assert.ok(after.logicalComponents.restCoordinator < inFlightBytes);
  } finally {
    manager.stop();
  }
});

test('feed owner fails closed when an injected REST transport cannot report retained waiters', () => {
  const manager = new LiveFeedManager({ restTransport: { request: async () => null } });
  try {
    const measurement = manager.retainedRamBudget();
    assert.equal(measurement.measurementComplete, false);
    assert.equal(measurement.logicalBytes, null);
    assert.equal(measurement.measurementError, 'exchange-rest-transport-retained-snapshot-unavailable');
  } finally {
    manager.stop();
  }
});

test('feed owner rejects invalid and throwing REST waiter snapshots', () => {
  const valid = {
    measurementAvailable: true,
    memoryAdmissionWaiters: 1,
    memoryAdmissionWaiterLimit: 32,
    memoryAdmissionWaiterAllowanceBytes: EXCHANGE_REST_MEMORY_ADMISSION_WAITER_LOGICAL_BYTES,
    memoryAdmissionWaiterLogicalBytes: EXCHANGE_REST_MEMORY_ADMISSION_WAITER_LOGICAL_BYTES,
  };
  const cases: [string, () => unknown, string][] = [
    ['missing', () => null, 'exchange-rest-transport-retained-snapshot-invalid'],
    ['inconsistent bytes', () => ({ ...valid, memoryAdmissionWaiterLogicalBytes: 0 }), 'exchange-rest-transport-retained-snapshot-invalid'],
    ['zero limit', () => ({ ...valid, memoryAdmissionWaiters: 0, memoryAdmissionWaiterLimit: 0, memoryAdmissionWaiterLogicalBytes: 0 }), 'exchange-rest-transport-retained-snapshot-invalid'],
    ['over limit', () => ({ ...valid, memoryAdmissionWaiters: 33 }), 'exchange-rest-transport-retained-snapshot-invalid'],
    ['fractional count', () => ({ ...valid, memoryAdmissionWaiters: 0.5 }), 'exchange-rest-transport-retained-snapshot-invalid'],
    ['throwing', () => { throw new Error('snapshot unavailable'); }, 'exchange-rest-transport-retained-snapshot-failed'],
  ];
  for (const [label, retainedSnapshot, reason] of cases) {
    const manager = new LiveFeedManager({ restTransport: { request: async () => null, retainedSnapshot } });
    try {
      const measurement = manager.retainedRamBudget();
      assert.equal(measurement.measurementComplete, false, label);
      assert.equal(measurement.logicalBytes, null, label);
      assert.equal(measurement.measurementError, reason, label);
      assert.ok(defined(measurement.partialLogicalBytes) > 0, label);
    } finally {
      manager.stop();
    }
  }
});

test('manager diagnostics retain one bounded cache snapshot across refreshes', () => {
  const manager = new LiveFeedManager();
  try {
    const cacheBytes = Array.from({ length: 8 }, () => manager.retainedDiagnostics().logicalComponents.diagnosticsCache);
    assert.ok(cacheBytes[1] > 0);
    assert.equal(new Set(cacheBytes.slice(-5)).size, 1);
  } finally {
    manager.stop();
  }
});

test('manager diagnostics account for the current retained snapshot as feeds grow', () => {
  const manager = new LiveFeedManager();
  try {
    const before = manager.retainedDiagnostics();
    for (let index = 0; index < 100; index += 1) {
      manager.feeds.set(`feed-${index}`, { id: `feed-${index}`, socket: null, spec: { venue: 'test', channel: 'depth', request: {}, decode: () => null }, generation: index, retry: null, retired: false });
    }
    const current = manager.retainedDiagnostics();
    const currentCacheBytes = logicalRetainedBytes(current);
    assert.strictEqual(manager.retainedDiagnosticsCache, current);
    assert.ok(currentCacheBytes > logicalRetainedBytes(before));
    assert.equal(current.logicalComponents.diagnosticsCache, currentCacheBytes);
    assert.equal(current.logicalBytes, Object.values(current.logicalComponents).reduce((sum, bytes) => sum + bytes, 0));
  } finally {
    manager.stop();
  }
});

test('every wired venue metadata cache stays staged until the server accepts it', async () => {
  const cases: {venue: string; method: 'syncWhitebitMetadata' | 'syncPhemexMetadata' | 'syncDydxMetadata' | 'syncAsterMetadata'; field: 'whitebitMetadata' | 'phemexMetadata' | 'dydxMetadata' | 'asterMetadata'; args: [{symbol: string}]; payload: unknown}[] = [
    {
      venue: 'whitebit', method: 'syncWhitebitMetadata', field: 'whitebitMetadata',
      args: [{ symbol: 'BTC_USDT' }],
      payload: [{ name: 'BTC_USDT', stock: 'BTC', money: 'USDT', moneyPrec: 2, stockPrec: 6 }],
    },
    {
      venue: 'phemex', method: 'syncPhemexMetadata', field: 'phemexMetadata',
      args: [{ symbol: 'sBTCUSDT' }],
      payload: { code: 0, msg: '', data: { products: [{ symbol: 'sBTCUSDT', type: 'Spot', status: 'Listed', baseCurrency: 'BTC', quoteCurrency: 'USDT', priceScale: 8, ratioScale: 8, pricePrecision: 2, baseQtyPrecision: 6, baseTickSize: '0.000001 BTC', quoteTickSize: '0.01 USDT' }] } },
    },
    {
      venue: 'dydx', method: 'syncDydxMetadata', field: 'dydxMetadata',
      args: [{ symbol: 'BTC-USD' }],
      payload: { markets: { 'BTC-USD': { ticker: 'BTC-USD', status: 'ACTIVE', tickSize: '1', stepSize: '0.0001', atomicResolution: -10, quantumConversionExponent: -9, oraclePrice: '80000', openInterest: '10' } } },
    },
    {
      venue: 'aster', method: 'syncAsterMetadata', field: 'asterMetadata',
      args: [{ symbol: 'BTCUSDT' }],
      payload: { serverTime: 1_789_902_444_592, symbols: [{ symbol: 'BTCUSDT', pair: 'BTCUSDT', contractType: 'PERPETUAL', status: 'TRADING', baseAsset: 'BTC', quoteAsset: 'USDT', marginAsset: 'USDT', filters: [{ filterType: 'PRICE_FILTER', tickSize: '0.1' }, { filterType: 'LOT_SIZE', stepSize: '0.001' }] }] },
    },
  ];

  for (const entry of cases) {
    let manager: LiveFeedManager;
    manager = new LiveFeedManager({
      networkEnabled: true,
      restTransport: { request: async () => entry.payload },
      onMessage: ({ message, retainedMutation }) => {
        if (message?.kind !== 'metadata') return true;
        assert.equal(manager[entry.field], null, `${entry.venue} metadata was assigned before admission`);
        assert.equal(retainedMutation?.candidate?.kind, 'feed-metadata');
        return false;
      },
    });
    if (entry.venue === 'phemex') manager.specs.set('phemex-depth', { venue: 'phemex', channel: 'depth', request: { symbol: 'sBTCUSDT' }, decode: () => null });
    try {
      assert.equal(await manager[entry.method](...entry.args), null, `${entry.venue} metadata admission must fail closed`);
      assert.equal(manager[entry.field], null, `${entry.venue} cache must remain empty after rejection`);
      if (entry.venue === 'phemex') assert.equal(defined(manager.specs.get('phemex-depth')).request.metadata, undefined);
    } finally {
      manager.stop();
    }
  }
});

test('Binance snapshot and delta sequence metadata commit with their admitted books', async () => {
  const fake = makeFakeTransport();
  const app = createLocalServer({ liveMode: true, persistFixture: false, quota: new QuotaLedger(), history: new HistoryStore({ filePath: ':memory:' }) });
  const mutations: Record<string, unknown>[] = [];
  let manager: LiveFeedManager;
  manager = new LiveFeedManager({
    networkEnabled: true,
    transportFactory: fake.factory,
    oiPollMs: 0,
    retainedAdmission: app.admitRetainedMutation,
    onMessage: ({ venue, message, retainedMutation }) => {
      const candidate = retainedMutation?.candidate;
      const beforeSequence = candidate?.kind === 'feed-binance-depth-state'
        ? manager.bookSequences.get(textValue(candidate.instrumentId))
        : undefined;
      const accepted = app.applyMessage(message, venue, { retainedMutation });
      if (candidate?.kind === 'feed-binance-depth-state') {
        mutations.push({
          candidate,
          beforeSequence,
          afterSequence: manager.bookSequences.get(textValue(candidate.instrumentId)),
          afterBridgePending: defined(defined(defined(manager.depthBridgePending.get(textValue(candidate.instrumentId))))),
          committed: defined(retainedMutation).committed,
          accepted,
        });
      }
      return accepted;
    },
    restTransport: makeRestTransport(async request => request.url.includes('/depth')
      ? { lastUpdateId: 100, bids: [['100', '2']], asks: [['101', '1']] }
      : { openInterest: '1', time: 1_700_000_000_000 }),
  });
  app.retainedProviders.feeds = manager;
  try {
    await manager.start({ binanceSymbol: 'BTCUSDT' });
    const instrumentId = 'binance:BTCUSDT';
    const socket = fake.sockets.find(item => item.spec.channel === 'depth');
    assert.equal(app.state.books[instrumentId].sequence, 100);
    assert.equal(manager.bookSequences.get(instrumentId), 100);
    assert.equal(manager.depthBridgePending.get(instrumentId), true);

    defined(socket).emit({ stream: 'btcusdt@depth', data: { e: 'depthUpdate', E: 1_700_000_000_100, s: 'BTCUSDT', U: 101, pu: 100, u: 101, b: [['100', '3']], a: [] } });

    assert.equal(app.state.books[instrumentId].sequence, 101);
    assert.equal(manager.bookSequences.get(instrumentId), 101);
    assert.equal(manager.depthBridgePending.get(instrumentId), false);
    assert.deepEqual(mutations.map(({ candidate, beforeSequence, afterSequence, afterBridgePending, committed, accepted }) => ({
      candidate: { kind: fields(candidate).kind, instrumentId: fields(candidate).instrumentId, sequence: fields(candidate).sequence, depthBridgePending: fields(candidate).depthBridgePending },
      beforeSequence,
      afterSequence,
      afterBridgePending,
      committed,
      accepted,
    })), [
      { candidate: { kind: 'feed-binance-depth-state', instrumentId, sequence: 100, depthBridgePending: true }, beforeSequence: undefined, afterSequence: 100, afterBridgePending: true, committed: true, accepted: true },
      { candidate: { kind: 'feed-binance-depth-state', instrumentId, sequence: 101, depthBridgePending: false }, beforeSequence: 100, afterSequence: 101, afterBridgePending: false, committed: true, accepted: true },
    ]);
  } finally {
    manager.stop();
    await app.close();
  }
});

test('public-depth failure before its first book releases the empty manager session', async () => {
  const fake = makeFakeTransport();
  const manager = new LiveFeedManager({
    networkEnabled: true,
    transportFactory: fake.factory,
    oiPollMs: 0,
    schedule: (_fn, _delay) => 1,
    cancel: () => {},
    heartbeatSchedule: (_fn, _delay) => 1,
    heartbeatCancel: () => {},
  });
  try {
    await manager.start({ coinbaseEnabled: true, coinbaseSymbol: 'BTC-USD' });
    const socket = fake.sockets.find(item => item.spec.id === 'coinbase-depth');
    const feed = manager.feeds.get('coinbase-depth');
    assert.ok(socket && feed?.session);
    assert.equal(feed.session.book, null);
    assert.ok(manager.retainedDiagnostics().sessionVenues.some(({ id }) => id === 'coinbase-depth'));

    socket.closeWith('closed before first snapshot');

    assert.equal(feed.session, null);
    assert.equal(manager.retainedDiagnostics().sessionVenues.some(({ id }) => id === 'coinbase-depth'), false);
    assert.equal(manager.status()['coinbase-depth'].state, 'backoff');
  } finally {
    manager.stop();
  }
});

test('oversized raw public-depth messages are rejected before JSON parsing', async () => {
  const fake = makeFakeTransport();
  const manager = new LiveFeedManager({
    networkEnabled: true,
    transportFactory: fake.factory,
    oiPollMs: 0,
    schedule: (_fn, _delay) => 1,
    cancel: () => {},
    heartbeatSchedule: (_fn, _delay) => 1,
    heartbeatCancel: () => {},
  });
  try {
    await manager.start({ coinbaseEnabled: true, coinbaseSymbol: 'BTC-USD' });
    const socket = fake.sockets.find(item => item.spec.id === 'coinbase-depth');
    const feed = manager.feeds.get('coinbase-depth');
    assert.ok(socket && feed?.session);
    const oversized = '\u00e9'.repeat(Math.floor(MAX_COINBASE_L2_MESSAGE_BYTES / 2) + 1);
    assert.ok(Buffer.byteLength(oversized) > MAX_COINBASE_L2_MESSAGE_BYTES);
    assert.ok(oversized.length < MAX_COINBASE_L2_MESSAGE_BYTES);
    socket.emit(oversized);
    assert.equal(feed.session, null);
    assert.equal(manager.status()['coinbase-depth'].state, 'backoff');
    assert.match(textValue(manager.status()['coinbase-depth'].lastError), new RegExp('exceeds ' + MAX_COINBASE_L2_MESSAGE_BYTES + ' bytes'));
  } finally {
    manager.stop();
  }
});

test('gzip-expanded public-depth messages are capped before JSON parsing', async () => {
  const fake = makeFakeTransport();
  const manager = new LiveFeedManager({
    networkEnabled: true,
    transportFactory: fake.factory,
    oiPollMs: 0,
    schedule: (_fn, _delay) => 1,
    cancel: () => {},
    heartbeatSchedule: (_fn, _delay) => 1,
    heartbeatCancel: () => {},
  });
  try {
    await manager.start({ coinbaseEnabled: true, coinbaseSymbol: 'BTC-USD' });
    const socket = fake.sockets.find(item => item.spec.id === 'coinbase-depth');
    const feed = manager.feeds.get('coinbase-depth');
    assert.ok(socket && feed?.session);
    const compressed = gzipSync(Buffer.from(' '.repeat(MAX_LIVE_FEED_MESSAGE_BYTES + 1)));
    assert.ok(compressed.byteLength < MAX_LIVE_FEED_MESSAGE_BYTES);
    socket.emit(compressed);
    assert.equal(feed.session, null);
    assert.equal(manager.status()['coinbase-depth'].state, 'backoff');
    assert.match(textValue(manager.status()['coinbase-depth'].lastError), new RegExp('expanded message exceeds ' + MAX_LIVE_FEED_MESSAGE_BYTES + ' bytes'));
  } finally {
    manager.stop();
  }
});
test('oversized raw Binance depth messages retire the feed and enter backoff', async () => {
  const fake = makeFakeTransport();
  const manager = new LiveFeedManager({
    networkEnabled: true,
    transportFactory: fake.factory,
    oiPollMs: 0,
    schedule: (_fn, _delay) => 1,
    cancel: () => {},
    heartbeatSchedule: (_fn, _delay) => 1,
    heartbeatCancel: () => {},
  });
  try {
    await manager.start({ binanceSymbol: 'BTCUSDT' });
    const socket = fake.sockets.find(item => item.spec.id === 'binance-depth');
    const feed = manager.feeds.get('binance-depth');
    assert.ok(socket && feed);
    socket.emit(' '.repeat(MAX_LIVE_FEED_MESSAGE_BYTES + 1));
    assert.equal(feed.retired, true);
    assert.equal(socket.closed, true);
    assert.equal(manager.status()['binance-depth'].state, 'backoff');
    assert.match(textValue(manager.status()['binance-depth'].lastError), new RegExp('exceeds ' + MAX_LIVE_FEED_MESSAGE_BYTES + ' bytes'));
  } finally {
    manager.stop();
  }
});

test('gzip-expanded Binance depth messages retire the feed and enter backoff', async () => {
  const fake = makeFakeTransport();
  const manager = new LiveFeedManager({
    networkEnabled: true,
    transportFactory: fake.factory,
    oiPollMs: 0,
    schedule: (_fn, _delay) => 1,
    cancel: () => {},
    heartbeatSchedule: (_fn, _delay) => 1,
    heartbeatCancel: () => {},
  });
  try {
    await manager.start({ binanceSymbol: 'BTCUSDT' });
    const socket = fake.sockets.find(item => item.spec.id === 'binance-depth');
    const feed = manager.feeds.get('binance-depth');
    const compressed = gzipSync(Buffer.from(' '.repeat(MAX_LIVE_FEED_MESSAGE_BYTES + 1)));
    assert.ok(socket && feed);
    assert.ok(compressed.byteLength < MAX_LIVE_FEED_MESSAGE_BYTES);
    socket.emit(compressed);
    assert.equal(feed.retired, true);
    assert.equal(socket.closed, true);
    assert.equal(manager.status()['binance-depth'].state, 'backoff');
    assert.match(textValue(manager.status()['binance-depth'].lastError), new RegExp('expanded message exceeds ' + MAX_LIVE_FEED_MESSAGE_BYTES + ' bytes'));
  } finally {
    manager.stop();
  }
});

test('oversized non-public feed messages retire their socket and enter backoff', async () => {
  const fake = makeFakeTransport();
  const manager = new LiveFeedManager({
    networkEnabled: true,
    transportFactory: fake.factory,
    oiPollMs: 0,
    schedule: (_fn, _delay) => 1,
    cancel: () => {},
    heartbeatSchedule: (_fn, _delay) => 1,
    heartbeatCancel: () => {},
  });
  try {
    await manager.start();
    const socket = fake.sockets.find(item => item.spec.id === 'hl-activeAssetCtx');
    const feed = manager.feeds.get('hl-activeAssetCtx');
    assert.ok(socket && feed);
    socket.emit(' '.repeat(MAX_LIVE_FEED_MESSAGE_BYTES + 1));
    assert.equal(feed.retired, true);
    assert.equal(manager.status()['hl-activeAssetCtx'].state, 'backoff');
    assert.match(textValue(manager.status()['hl-activeAssetCtx'].lastError), new RegExp('exceeds ' + MAX_LIVE_FEED_MESSAGE_BYTES + ' bytes'));
  } finally {
    manager.stop();
  }
});

test('Kraken invalidation releases adapter checksum maps before reconnect', async () => {
  const fake = makeFakeTransport();
  const messages: LiveFeedEvent[] = [];
  const manager = new LiveFeedManager({ networkEnabled: true, transportFactory: fake.factory, oiPollMs: 0, onMessage: item => messages.push(item) });
  await manager.start({ krakenEnabled: true, krakenSymbol: 'XBT/USD' });
  const socket = fake.sockets.find(item => item.spec.id === 'kraken-depth');
  const feed = manager.feeds.get('kraken-depth');
  const bids = [{ price: '100', qty: '2' }];
  const asks = [{ price: '101', qty: '3' }];
  defined(socket).emit({ method: 'subscribe', success: true, result: { channel: 'book', symbol: ['BTC/USD'], depth: 100, snapshot: true } });
  defined(socket).emit({ channel: 'book', type: 'snapshot', data: [{ symbol: 'BTC/USD', bids, asks, checksum: krakenBookChecksum({ bids, asks }), timestamp: 1_700_000_000 }] });
  assert.equal(fieldMap(fields(defined(defined(feed).session)).bids).size, 1);
  assert.equal(fieldMap(fields(defined(defined(feed).session)).asks).size, 1);

  defined(socket).closeWith('injected Kraken disconnect');

  assert.equal(defined(defined(defined(feed).session).book).complete, false);
  assert.equal(defined(defined(defined(feed).session).book).bids.length, 0);
  assert.equal(defined(defined(defined(feed).session).book).asks.length, 0);
  assert.equal(fieldMap(fields(defined(defined(feed).session)).bids).size, 0);
  assert.equal(fieldMap(fields(defined(defined(feed).session)).asks).size, 0);
  assert.equal(messages.filter(item => item.message.invalidated === true).length, 1);
  manager.stop();
});

test('feed retained-budget reclaim drops orphan bridge rows and trims active backlog', () => {
  const manager = new LiveFeedManager();
  manager.specs.set('active-depth', { venue: 'binance', instrumentId: 'binance:BTCUSDT', channel: 'depth', bookKey: 'binance:BTCUSDT|native', request: {}, decode: () => null });
  manager.depthBuffers.set('orphan', Array.from({ length: 100 }, (_, index) => ({ kind: 'depthDelta', sequence: index, payload: 'x'.repeat(100) })));
  manager.depthBuffers.set('binance:BTCUSDT|native', Array.from({ length: 100 }, (_, index) => ({ kind: 'depthDelta', sequence: index, payload: 'y'.repeat(100) })));
  const before = manager.retainedDiagnostics().logicalBytes;
  const reclaimed = manager.reclaimRetainedRam({ targetBytes: 1_000_000_000 });
  const after = manager.retainedDiagnostics();
  assert.ok(reclaimed > 0);
  assert.equal(after.depthBuffers.orphan, undefined);
  assert.equal(after.depthBuffers['binance:BTCUSDT|native'], 32);
  assert.ok(defined(after.logicalBytes) < defined(before));
  manager.stop();
});

test('feed retained-budget reclaim protects a real Binance bridge during snapshot and resync', () => {
  const manager = new LiveFeedManager();
  manager.specs.set('binance-depth', { venue: 'binance', instrumentId: 'binance:BTCUSDT', channel: 'depth', bookKey: 'binance:BTCUSDT|native', request: {}, decode: () => null });
  manager.depthBuffers.set('binance:BTCUSDT', Array.from({ length: 100 }, (_, index) => ({ kind: 'depthDelta', sequence: index, payload: 'x'.repeat(100) })));
  manager.depthBridgePending.set('binance:BTCUSDT', true);
  const before = manager.retainedDiagnostics().logicalBytes;
  assert.equal(manager.reclaimRetainedRam({ targetBytes: 1_000_000_000 }), 0);
  assert.equal(defined(manager.depthBuffers.get('binance:BTCUSDT')).length, 100);
  manager.depthBridgePending.set('binance:BTCUSDT', false);
  manager.resyncing.set('binance:BTCUSDT', {generation: undefined});
  assert.equal(manager.reclaimRetainedRam({ targetBytes: 1_000_000_000 }), 0);
  assert.equal(defined(manager.depthBuffers.get('binance:BTCUSDT')).length, 100);
  manager.stop();
});

test('enabled manager opens HL and Binance channels with correct subscriptions', async () => {
  const fake = makeFakeTransport(); const messages: LiveFeedEvent[] = []; const statuses: LiveFeedStatusEvent[] = [];
  const manager = new LiveFeedManager({ networkEnabled:true, transportFactory:fake.factory, restTransport:{request:async()=>({openInterest:'10',time:1700000000000})}, oiPollMs:0, onMessage:m=>messages.push(m), onStatus:s=>statuses.push(s), now:()=>1700000000100 });
  await manager.start({coin:'BTC',binanceSymbol:'BTCUSDT'});
  assert.equal(fake.sockets.length,9); assert.equal(fake.sockets.filter(s=>s.spec.venue === 'hyperliquid').length,5);
  const hlFrames = fake.sockets.filter(s=>s.spec.venue === 'hyperliquid').flatMap(s=>s.sent).map(value => JSON.parse(value));
  assert.deepEqual(hlFrames.map(x=>x.subscription.type).sort(), ['activeAssetCtx','candle','l2Book','l2Book','trades']);
  assert.deepEqual(fake.sockets.filter(s => s.spec.channel === 'l2Book').map(s => s.spec.resolutionKey).sort(), ['native', 'sig:2']);
  assert.equal(defined(manager.specs.get('hl-candle')).instrumentId, defined(manager.specs.get('hl-l2Book-native')).instrumentId);
  assert.equal(defined(manager.specs.get('binance-kline')).instrumentId, defined(manager.specs.get('binance-depth')).instrumentId);
  assert.equal(defined(defined(fake.sockets.find(s => s.spec.id === 'binance-trades'))?.spec.request).stream, 'btcusdt@aggTrade');
  assert.equal(fake.sockets.filter(s=>s.spec.venue === 'binance').every(s=>s.sent.length === 0), true);
  assert.equal(statuses.some(s=>s.id === 'binance-openInterest' && s.state === 'unavailable'), true);
  manager.stop();
});

test('Hyperliquid coarse grouping is forwarded and preserved by the live decoder', async () => {
  const fake = makeFakeTransport(); const messages: LiveFeedEvent[] = [];
  const manager = new LiveFeedManager({ networkEnabled: true, transportFactory: fake.factory, oiPollMs: 0, onMessage: message => messages.push(message) });
  await manager.start({ coin: 'BTC', hlBookNsigFigs: 2 });
  const socket = fake.sockets.find(item => item.spec.channel === 'l2Book' && item.spec.resolutionKey === 'sig:2');
  assert.deepEqual(JSON.parse(defined(socket).sent[0]).subscription, { type: 'l2Book', coin: 'BTC', nSigFigs: 2 });
  defined(socket).emit({ channel: 'l2Book', data: { coin: 'BTC', time: 1700000000000, nSigFigs: 2, levels: [[{ px: '1000', sz: '2' }], [{ px: '1100', sz: '1' }]] } });
  const book = messages.find(item => item.message.kind === 'depthSnapshot')?.message;
  assert.equal(defined(book).resolution, 'coarse'); assert.equal(defined(book).resolutionKey, 'sig:2'); assert.equal(defined(book).bookKey, 'hyperliquid:BTC-PERP|sig:2'); assert.equal(defined(book).nSigFigs, 2); assert.equal(defined(book).coverage, 'partial');
  manager.stop();
});

test('Deribit grouped source resolution survives live normalization', async () => {
  const fake = makeFakeTransport(); const messages: LiveFeedEvent[] = [];
  const manager = new LiveFeedManager({ networkEnabled: true, transportFactory: fake.factory, oiPollMs: 0, onMessage: message => messages.push(message) });
  await manager.start({ deribitEnabled: true, deribitSymbol: 'BTC-PERPETUAL' });
  const socket = fake.sockets.find(item => item.spec.venue === 'deribit');
  defined(socket).emit({ jsonrpc: '2.0', id: 1, result: ['book.BTC-PERPETUAL.10.20.100ms'] });
  defined(socket).emit({ jsonrpc: '2.0', method: 'subscription', params: { channel: 'book.BTC-PERPETUAL.10.20.100ms', data: { instrument_name: 'BTC-PERPETUAL', timestamp: 1_700_000_000_000, change_id: 42, bids: [[77_000, 125_000]], asks: [[77_001, 80_000]] } } });
  const book = messages.find(item => item.message?.venue === 'deribit' && item.message.kind === 'depthSnapshot')?.message;
  assert.equal(defined(book).resolution, 'coarse'); assert.equal(defined(book).sourceGrouping, 10); assert.equal(defined(book).sourceDepth, 20);
  manager.stop();
});

test('Hyperliquid book resolutions keep native and coarse feeds isolated', async () => {
  const fake = makeFakeTransport(); const messages: LiveFeedEvent[] = [];
  const manager = new LiveFeedManager({ networkEnabled: true, transportFactory: fake.factory, oiPollMs: 0, onMessage: message => messages.push(message) });
  await manager.start({ coin: 'BTC', hlBookNsigFigs: 3 });
  const native = fake.sockets.find(item => item.spec.id === 'hl-l2Book-native');
  const coarse = fake.sockets.find(item => item.spec.id === 'hl-l2Book');
  defined(native).emit({ channel: 'l2Book', data: { coin: 'BTC', time: 1_700_000_000_000, levels: [[{ px: '100', sz: '2' }], [{ px: '101', sz: '3' }]] } });
  defined(coarse).emit({ channel: 'l2Book', data: { coin: 'BTC', time: 1_700_000_000_001, levels: [[{ px: '90', sz: '4' }], [{ px: '110', sz: '5' }]] } });
  const books = messages.filter(item => item.message.kind === 'depthSnapshot').map(item => item.message);
  assert.deepEqual(books.map(book => book.bookKey).sort(), ['hyperliquid:BTC-PERP|native', 'hyperliquid:BTC-PERP|sig:3']);
  manager.stop();
});

test('Hyperliquid book close invalidates only its resolution and a fresh socket restores it', async () => {
  const fake = makeFakeTransport(); const timers: {fn: () => unknown; delay: number}[] = [];
  const app = createLocalServer({ liveMode: true, persistFixture: false, quota: new QuotaLedger(), history: new HistoryStore({ filePath: ':memory:' }) });
  const manager = new LiveFeedManager({
    networkEnabled: true, transportFactory: fake.factory, oiPollMs: 0,
    onMessage: ({ venue, message }) => app.applyMessage(message, venue),
    schedule: (fn, delay) => { const timer = { fn, delay }; timers.push(timer); return timers.length; }, cancel: () => {},
    reconnectBaseMs: 100, reconnectMaxMs: 250, now: () => 1_700_000_000_100,
  });
  try {
    await manager.start({ coin: 'BTC', hlBookNsigFigs: 2 });
    app.state.bookSelection['hyperliquid:BTC-PERP'] = 'sig:2';
    const native = fake.sockets.find(socket => socket.spec.id === 'hl-l2Book-native');
    const coarse = fake.sockets.find(socket => socket.spec.id === 'hl-l2Book');
    const bookFrame = (time: number, nSigFigs: number | null, bid: number) => ({ channel: 'l2Book', data: { coin: 'BTC', time, ...(nSigFigs ? { nSigFigs } : {}), levels: [[{ px: String(bid), sz: '2' }], [{ px: String(bid + 1), sz: '3' }]] } });
    defined(native).emit(bookFrame(1_700_000_000_000, null, 100));
    defined(coarse).emit(bookFrame(1_700_000_000_001, 2, 90));
    assert.equal(app.state.books['hyperliquid:BTC-PERP'].resolutionKey, 'sig:2');
    defined(coarse).closeWith('lost public socket');
    const invalid = app.state.booksByKey['hyperliquid:BTC-PERP|sig:2'];
    assert.equal(invalid.complete, false);
    assert.equal(invalid.gap, true);
    assert.equal(invalid.sourceTimestamp, null);
    assert.deepEqual(invalid.bids, []);
    assert.equal(app.state.books['hyperliquid:BTC-PERP'].resolutionKey, 'native');
    assert.equal(app.state.books['hyperliquid:BTC-PERP'].complete, true);
    defined(coarse).emit(bookFrame(1_700_000_000_002, 2, 80));
    assert.equal(app.state.booksByKey['hyperliquid:BTC-PERP|sig:2'].complete, false);
    assert.equal(timers.length, 1);
    await timers[0].fn();
    const replacement = fake.sockets.filter(socket => socket.spec.id === 'hl-l2Book').at(-1);
    defined(replacement).emit(bookFrame(1_700_000_000_003, 2, 91));
    assert.equal(app.state.books['hyperliquid:BTC-PERP'].resolutionKey, 'sig:2');
    assert.equal(app.state.books['hyperliquid:BTC-PERP'].complete, true);
    assert.notEqual(app.state.books['hyperliquid:BTC-PERP'].gap, true);
    defined(replacement).onError?.(new Error('transport fault'));
    assert.equal(app.state.booksByKey['hyperliquid:BTC-PERP|sig:2'].gap, true);
    assert.equal(app.state.books['hyperliquid:BTC-PERP'].resolutionKey, 'native');
    assert.equal(timers.length, 2);
  } finally { manager.stop(); await app.close(); }
});

test('invalid Hyperliquid resolution sets are rejected before feed mutation', async () => {
  const fake = makeFakeTransport(); const manager = new LiveFeedManager({ networkEnabled: true, transportFactory: fake.factory, oiPollMs: 0 });
  await assert.rejects(() => manager.start({ hlBookResolutions: [{}, { nSigFigs: 2 }, { nSigFigs: 3 }] }), /At most/);
  assert.equal(fake.sockets.length, 0); assert.equal(manager.running, false);
});

test('late messages from a replaced coarse socket are ignored', async () => {
  const fake = makeFakeTransport(); const messages: LiveFeedEvent[] = [];
  const manager = new LiveFeedManager({ networkEnabled: true, transportFactory: fake.factory, oiPollMs: 0, onMessage: message => messages.push(message) });
  await manager.start({ hlBookNsigFigs: 2 });
  const oldCoarse = fake.sockets.find(item => item.spec.id === 'hl-l2Book');
  await manager.start({ hlBookNsigFigs: 3 });
  defined(oldCoarse).emit({ channel: 'l2Book', data: { coin: 'BTC', time: 1_700_000_000_000, nSigFigs: 2, levels: [[{ px: '90', sz: '4' }], [{ px: '110', sz: '5' }]] } });
  const currentCoarse = fake.sockets.filter(item => item.spec.id === 'hl-l2Book').at(-1);
  defined(currentCoarse).emit({ channel: 'l2Book', data: { coin: 'BTC', time: 1_700_000_000_001, nSigFigs: 3, levels: [[{ px: '100', sz: '4' }], [{ px: '101', sz: '5' }]] } });
  assert.deepEqual(messages.filter(item => item.message.kind === 'depthSnapshot').map(item => item.message.resolutionKey), ['sig:3']);
  manager.stop();
});

test('reconfiguration cancels stale retries and rejects an out-of-order socket open', async () => {
  const sockets: FakeSocket[] = []; let deferredOld: {resolve: (socket: FakeSocket) => void; spec: LiveFeedTransportOptions} | null = null; const timers: {fn: () => unknown; delay: number}[] = [];
  const factory = async (spec: LiveFeedTransportOptions) => {
    if (spec.id === 'hl-l2Book' && !deferredOld) return new Promise<FakeSocket>(resolve => { deferredOld = { resolve, spec }; });
    const socket = new FakeSocket(spec); sockets.push(socket); return socket;
  };
  const manager = new LiveFeedManager({ networkEnabled: true, transportFactory: factory, oiPollMs: 0, schedule: (fn, delay) => { const item = { fn, delay }; timers.push(item); return timers.length; }, cancel: () => {} });
  const firstStart = manager.start({ hlBookNsigFigs: 2 });
  await new Promise(resolve => setImmediate(resolve));
  const oldNative = sockets.find(socket => socket.spec.id === 'hl-l2Book-native');
  defined(oldNative).closeWith('lost');
  assert.equal(timers.length, 1);
  await manager.start({ hlBookNsigFigs: 3 });
  const beforeLate = sockets.length;
  await timers[0].fn();
  assert.equal(sockets.length, beforeLate);
  const oldSocket = new FakeSocket(defined<{resolve: (socket: FakeSocket) => void; spec: LiveFeedTransportOptions} | null>(deferredOld).spec); defined<{resolve: (socket: FakeSocket) => void; spec: LiveFeedTransportOptions} | null>(deferredOld).resolve(oldSocket); sockets.push(oldSocket);
  await firstStart;
  // Retirement settles startup before this late factory result arrives.
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(oldSocket.closed, true); assert.equal(oldSocket.sent.length, 0);
  manager.stop();
});

test('late factory and socket-open rejections cannot poison the replacement feed', async () => {
  let factoryDeferred: {resolve: (socket: FakeSocket) => void; reject: (error: Error) => void} | undefined; const factorySockets: FakeSocket[] = []; const factoryTimers: {fn: () => unknown; delay: number}[] = [];
  const rejectingFactory = async (spec: LiveFeedTransportOptions) => {
    if (spec.id === 'hl-l2Book' && !factoryDeferred) return new Promise<FakeSocket>((resolve, reject) => { factoryDeferred = { resolve, reject }; });
    const socket = new FakeSocket(spec); factorySockets.push(socket); return socket;
  };
  const factoryManager = new LiveFeedManager({ networkEnabled: true, transportFactory: rejectingFactory, oiPollMs: 0, schedule: (fn, delay) => { const item = { fn, delay }; factoryTimers.push(item); return factoryTimers.length; }, cancel: () => {} });
  const firstFactoryStart = factoryManager.start({ hlBookNsigFigs: 2 });
  await new Promise(resolve => setImmediate(resolve));
  await factoryManager.start({ hlBookNsigFigs: 3 });
  defined(factoryDeferred).reject(new Error('obsolete factory failed'));
  await firstFactoryStart;
  assert.equal(factoryManager.status()['hl-l2Book'].state, 'live'); assert.equal(factoryTimers.length, 0); factoryManager.stop();

  let openDeferred: {resolve: () => void; reject: (error: Error) => void; socket: FakeSocket} | undefined; const openSockets: FakeSocket[] = []; const openTimers: {fn: () => unknown; delay: number}[] = [];
  const openFactory = async (spec: LiveFeedTransportOptions) => {
    const socket = new FakeSocket(spec); openSockets.push(socket);
    if (spec.id === 'hl-l2Book' && !openDeferred) socket.open = () => new Promise<void>((resolve, reject) => { openDeferred = { resolve, reject, socket }; });
    return socket;
  };
  const openManager = new LiveFeedManager({ networkEnabled: true, transportFactory: openFactory, oiPollMs: 0, schedule: (fn, delay) => { const item = { fn, delay }; openTimers.push(item); return openTimers.length; }, cancel: () => {} });
  const firstOpenStart = openManager.start({ hlBookNsigFigs: 2 });
  await new Promise(resolve => setImmediate(resolve));
  await openManager.start({ hlBookNsigFigs: 3 });
  defined(openDeferred).reject(new Error('obsolete socket open failed'));
  await firstOpenStart;
  assert.equal(openManager.status()['hl-l2Book'].state, 'live'); assert.equal(openManager.status()['hl-l2Book'].lastError, null); assert.equal(openTimers.length, 0); assert.equal(defined(openDeferred).socket.closed, true); openManager.stop();
});

test('metadata hydration emits a snapshot and initial asset-context OI', async () => {
  const fake = makeFakeTransport(); const requests: ExchangeRestRequest[] = []; const messages: LiveFeedEvent[] = [];
  const manager = new LiveFeedManager({
    networkEnabled: true, transportFactory: fake.factory,
    restTransport: { request: async request => {
      requests.push(request);
      if (typeof request.body === 'string' && request.body.includes('metaAndAssetCtxs')) return [{ universe: [{ name: 'BTC', szDecimals: 5 }] }, [{ openInterest: '12', markPx: '100' }]];
      return { lastUpdateId: 1, bids: [['100', '1']], asks: [['101', '1']] };
    } },
    oiPollMs: 0, onMessage: message => messages.push(message), now: () => 1700000000100,
  });
  await manager.start({ coin: 'BTC', binanceSymbol: 'BTCUSDT' });
  assert.match(requests[0].url, /api\.hyperliquid\.xyz\/info/);
  assert.deepEqual(JSON.parse(textValue(requests[0].body)), { type: 'metaAndAssetCtxs' });
  assert.equal(defined(defined(messages.find(item => item.message.kind === 'metadata')).message.assets)[0].coin, 'BTC');
  const oi = defined(messages.find(item => item.message.kind === 'openInterest')).message;
  assert.equal(oi.base, 12); assert.equal(oi.quote, 1200); assert.equal(oi.sourceTimestamp, null);
  assert.equal(manager.status()['hl-metadata'].state, 'snapshot');
  manager.stop();
});

test('socket payloads are normalized and delivered through one callback', async () => {
  const fake = makeFakeTransport(); const messages: LiveFeedEvent[] = [];
  const manager = new LiveFeedManager({ networkEnabled:true, transportFactory:fake.factory, oiPollMs:0, onMessage:m=>messages.push(m), now:()=>1700000000100 });
  await manager.start({coin:'BTC',binanceSymbol:'BTCUSDT'});
  defined(fake.sockets.find(s=>s.spec.channel === 'l2Book')).emit({channel:'l2Book',data:{coin:'BTC',time:1700000000000,levels:[[{px:'100',sz:'2'}],[{px:'101',sz:'3'}]]}});
  defined(fake.sockets.find(s=>s.spec.channel === 'activeAssetCtx')).emit({channel:'activeAssetCtx',data:{coin:'BTC',time:1700000000000,ctx:{openInterest:'4',markPx:'100'}}});
  defined(fake.sockets.find(s=>s.spec.channel === 'trades')).emit({channel:'trades',data:[{coin:'BTC',side:'B',px:'100',sz:'2',time:1700000000000,tid:7}]});
  defined(fake.sockets.find(s=>s.spec.channel === 'candle' && s.spec.venue === 'hyperliquid')).emit({channel:'candle',data:{s:'BTC',i:'1m',t:1700000000000,T:1700000060000,o:'100',h:'110',l:'90',c:'105',v:'42'}});
  defined(fake.sockets.find(s=>s.spec.channel === 'depth')).emit({stream:'btcusdt@depth',data:{e:'depthUpdate',E:1700000000000,s:'BTCUSDT',U:8,pu:7,u:10,b:[['100','0']],a:[['101','2']]}});
  defined(fake.sockets.find(s=>s.spec.channel === 'markPrice')).emit(JSON.stringify({e:'markPriceUpdate',E:1700000000000,s:'BTCUSDT',p:'100.5'}));
  defined(fake.sockets.find(s=>s.spec.channel === 'kline')).emit({stream:'btcusdt@kline_1m',data:{e:'kline',E:1700000000000,s:'BTCUSDT',k:{i:'1m',t:1700000000000,T:1700000060000,o:'100',h:'110',l:'90',c:'105',v:'42'}}});
  assert.equal(messages.filter(x=>x.message.kind === 'depthSnapshot').length,1);
  assert.equal(messages.filter(x=>x.message.kind === 'openInterest').length,1);
  assert.equal(messages.filter(x=>x.message.kind === 'candle').length,2);
  assert.equal(messages.filter(x=>x.message.kind === 'trade').length,1);
  assert.equal(defined(messages.find(x=>x.message.kind === 'trade')).message.notionalUsd,200);
  assert.equal(defined(messages.find(x=>x.message.kind === 'depthDelta')).message.previousSequence,7);
  assert.equal(defined(messages.find(x=>x.message.kind === 'price' && x.message.instrumentId === 'binance:BTCUSDT')).message.price,100.5);
  manager.stop();
});

test('OI polling uses the Binance descriptor and emits normalized OI', async () => {
  const requests: ExchangeRestRequest[] = []; const messages: LiveFeedEvent[] = [];
  const manager = new LiveFeedManager({ networkEnabled:true, restTransport:{request:async request=>{requests.push(request); return {symbol:'BTCUSDT',openInterest:'12',time:1700000000000};}}, oiPollMs:0, onMessage:m=>messages.push(m), now:()=>1700000000100 });
  const sample = await manager.pollOpenInterest({symbol:'BTCUSDT'});
  assert.equal(defined(sample).base,12); assert.equal(messages[0].message.instrumentId,'binance:BTCUSDT'); assert.match(requests[0].url,/fapi\.binance\.com\/fapi\/v1\/openInterest/);
});

test('Binance public OI history is bounded, explicit, and statused', async () => {
  const requests: ExchangeRestRequest[] = []; const messages: LiveFeedEvent[] = [];
  const manager = new LiveFeedManager({ networkEnabled: true, restTransport: { request: async request => { requests.push(request); return [
    { symbol: 'BTCUSDT', sumOpenInterest: '12', sumOpenInterestValue: '1200', timestamp: 1700000000000 },
    { symbol: 'BTCUSDT', sumOpenInterest: '13', sumOpenInterestValue: '1300', timestamp: 1700000300000 },
  ]; } }, onMessage: message => messages.push(message), now: () => 1700000400000 });
  const rows = await manager.syncOpenInterestHistory({ symbol: 'BTCUSDT', period: '5m', limit: 2 });
  assert.equal(rows.length, 2); assert.match(requests[0].url, /futures\/data\/openInterestHist/); assert.match(requests[0].url, /period=5m/);
  assert.equal(messages.filter((item) => item.message.kind === 'openInterest').length, 2);
  const status = manager.status()['binance-openInterest-history']; assert.equal(status.sampleCount, 2); assert.equal(status.coverageStart, 1700000000000); assert.equal(status.coverageEnd, 1700000300000);
});

test('Binance OI history walks backward, deduplicates, honors lower bound, and stops on a non-progressing page', async () => {
  const requests: ExchangeRestRequest[] = []; const pageOneTimes = Array.from({ length: 500 }, (_, index) => 1700000000000 + index * 300000); const pages = [
    pageOneTimes.map(timestamp => ({ symbol: 'BTCUSDT', sumOpenInterest: String(timestamp), timestamp })),
    [pageOneTimes[0] - 300000, pageOneTimes[0]].map(timestamp => ({ symbol: 'BTCUSDT', sumOpenInterest: String(timestamp), timestamp })),
  ];
  const manager = new LiveFeedManager({ networkEnabled: true, restTransport: { request: async request => { requests.push(request); return pages[Math.min(requests.length - 1, pages.length - 1)]; } }, now: () => 5000 });
  const rows = await manager.syncOpenInterestHistory({ symbol: 'BTCUSDT', period: '5m', startTime: pageOneTimes[0] - 300000, limit: 501 });
  assert.equal(rows.length, 501); assert.equal(rows[0].sourceTimestamp, pageOneTimes[0] - 300000); assert.equal(defined(rows.at(-1)).sourceTimestamp, pageOneTimes.at(-1));
  assert.equal(requests.length, 2);
  const first = new URL(requests[0].url); const second = new URL(requests[1].url);
  assert.equal(first.searchParams.get('endTime'), null); assert.equal(second.searchParams.get('endTime'), String(pageOneTimes[0] - 1));
  assert.equal(new Set(rows.map(row => row.sourceTimestamp)).size, rows.length);

  const repeatedRequests: ExchangeRestRequest[] = [];
  const repeatedPage = pageOneTimes.map(timestamp => ({ symbol: 'BTCUSDT', sumOpenInterest: '1', timestamp }));
  const repeatedManager = new LiveFeedManager({ networkEnabled: true, restTransport: { request: async request => { repeatedRequests.push(request); return repeatedPage; } }, now: () => 5000 });
  const repeatedRows = await repeatedManager.syncOpenInterestHistory({ symbol: 'BTCUSDT', period: '5m', limit: 501 });
  assert.equal(repeatedRows.length, 500); assert.equal(repeatedRequests.length, 2); assert.equal(new URL(repeatedRequests[1].url).searchParams.get('endTime'), String(pageOneTimes[0] - 1));
});

test('live startup performs one bounded Binance OI history load when current OI polling is enabled', async () => {
  const fake = makeFakeTransport(); const requests: ExchangeRestRequest[] = []; const messages: LiveFeedEvent[] = [];
  const manager = new LiveFeedManager({ networkEnabled: true, transportFactory: fake.factory, oiPollMs: 60_000, oiHistoryLimit: 2, onMessage: message => messages.push(message), restTransport: { request: async request => {
    requests.push(request);
    if (request.url.includes('/futures/data/openInterestHist')) return [{ symbol: 'BTCUSDT', sumOpenInterest: '12', timestamp: 1700000000000 }];
    if (request.url.includes('/fapi/v1/openInterest')) return { symbol: 'BTCUSDT', openInterest: '12', time: 1700000000000 };
    if (request.url.includes('/fapi/v1/depth')) return { lastUpdateId: 1, bids: [['100', '1']], asks: [['101', '1']] };
    if (request.url.includes('/fapi/v1/klines')) return [];
    if (request.url.includes('/info')) return { universe: [], assetCtxs: [] };
    return {};
  } } });
  await manager.start({ coin: 'BTC', binanceSymbol: 'BTCUSDT' });
  assert.ok(requests.some(request => request.url.includes('/futures/data/openInterestHist')));
  assert.equal(messages.filter(item => item.message.kind === 'openInterest' && item.message.historySource === 'binance-public-statistics').length, 1);
  assert.equal(manager.status()['binance-openInterest-history'].state, 'live');
  manager.stop();
});

test('spot Binance feeds use distinct IDs and skip OI polling', async () => {
  const fake = makeFakeTransport(); let calls = 0; const manager = new LiveFeedManager({ networkEnabled: true, transportFactory: fake.factory, restTransport: { request: async () => { calls += 1; return {}; } }, oiPollMs: 0 });
  const sample = await manager.pollOpenInterest({ symbol: 'BTCUSDT', marketType: 'spot' });
  assert.equal(sample, null); assert.equal(calls, 0); assert.match(textValue(manager.status()['binance-openInterest'].lastError), /spot market/);
  await manager.start({ symbol: 'BTCUSDT', binanceMarketType: 'spot' });
  assert.equal(defined(defined(fake.sockets.find((socket) => socket.spec.channel === 'markPrice')).spec.request).stream, 'btcusdt@trade'); manager.stop();
});

test('socket close schedules bounded exponential reconnect', async () => {
  const fake = makeFakeTransport(); const timers: {fn: () => unknown; delay: number}[] = []; const manager = new LiveFeedManager({ networkEnabled:true, transportFactory:fake.factory, oiPollMs:0, schedule:(fn,delay)=>{timers.push({fn,delay}); return timers.length;}, cancel:()=>{}, reconnectBaseMs:100, reconnectMaxMs:250, now:()=>1000 });
  await manager.start(); const first = fake.sockets.find((socket) => socket.spec.id === 'hl-l2Book'); defined(first).closeWith('lost');
  assert.equal(timers.length,1); assert.equal(timers[0].delay,100); assert.equal(manager.status()['hl-l2Book'].state,'backoff'); assert.equal(manager.status()['hl-l2Book'].attempt,1);
  await timers[0].fn(); assert.equal(fake.sockets.length,10); assert.equal(manager.status()['hl-l2Book'].state,'live'); manager.stop();
});

test('a venue socket failure does not change the other venue status', async () => {
  const fake = makeFakeTransport(); const timers: {fn: () => unknown; delay: number}[] = [];
  const manager = new LiveFeedManager({ networkEnabled: true, transportFactory: fake.factory, oiPollMs: 0, schedule: (fn, delay) => { timers.push({ fn, delay }); return timers.length; }, cancel: () => {} });
  await manager.start();
  const binanceBefore = manager.status()['binance-depth'].state;
  defined(fake.sockets.find(socket => socket.spec.id === 'hl-activeAssetCtx')).closeWith('HL unavailable');
  assert.equal(manager.status()['hl-activeAssetCtx'].state, 'backoff');
  assert.equal(manager.status()['binance-depth'].state, binanceBefore);
  manager.stop();
});

test('Binance depth gaps trigger a REST snapshot resync before more deltas', async () => {
  const fake = makeFakeTransport(); const messages: LiveFeedEvent[] = []; let depthCalls = 0;
  const manager = new LiveFeedManager({
    networkEnabled: true, transportFactory: fake.factory, oiPollMs: 0, onMessage: message => messages.push(message),
    restTransport: { request: async request => {
      if (request.url.includes('/depth')) {
        depthCalls += 1;
        return { lastUpdateId: depthCalls === 1 ? 20 : 30, bids: [['100', '2']], asks: [['101', '1']] };
      }
      return { openInterest: '1', time: 1700000000000 };
    } },
  });
  await manager.start({ binanceSymbol: 'BTCUSDT' });
  const depth = fake.sockets.find(socket => socket.spec.channel === 'depth');
  defined(depth).emit({ stream: 'btcusdt@depth', data: { e: 'depthUpdate', E: 1700000000000, s: 'BTCUSDT', U: 21, pu: 20, u: 21, b: [], a: [] } });
  assert.equal(manager.status()['binance-depth'].state, 'live');
  // USD-M requires pu after the REST bridge; a missing continuity token must re-anchor instead of being inferred from U.
  defined(depth).emit({ stream: 'btcusdt@depth', data: { e: 'depthUpdate', E: 1700000000001, s: 'BTCUSDT', U: 22, u: 22, b: [], a: [] } });
  await new Promise(resolve => setImmediate(() => setImmediate(resolve)));
  assert.equal(depthCalls, 2);
  const invalidation = defined(messages.filter(item => item.message.kind === 'depthSnapshot' && item.message.invalidated === true).at(-1)).message;
  assert.match(textValue(invalidation?.invalidReason ?? ''), /malformed Binance depth payload: Binance depth previous update ID missing or invalid/);
  assert.equal(defined(messages.filter(item => item.message.kind === 'depthSnapshot').at(-1)).message.sequence, 30);
  assert.equal(manager.status()['binance-depth'].state, 'snapshot');
  defined(depth).emit({ stream: 'btcusdt@depth', data: { e: 'depthUpdate', E: 1700000000000, s: 'BTCUSDT', U: 31, pu: 30, u: 31, b: [['100', '3']], a: [] } });
  assert.equal(manager.status()['binance-depth'].state, 'live');
  manager.stop();
});

test('Binance malformed or unsafe U/u sequences invalidate and re-anchor through REST', async () => {
  const fake = makeFakeTransport(); const messages: LiveFeedEvent[] = []; let depthCalls = 0;
  const manager = new LiveFeedManager({
    networkEnabled: true, transportFactory: fake.factory, oiPollMs: 0, onMessage: message => messages.push(message),
    restTransport: { request: async request => request.url.includes('/depth')
      ? (++depthCalls, { lastUpdateId: 100 + depthCalls * 10, bids: [['100', '2']], asks: [['101', '1']] })
      : { openInterest: '1', time: 1700000000000 } },
  });
  await manager.start({ binanceSymbol: 'BTCUSDT' });
  const depth = fake.sockets.find(socket => socket.spec.channel === 'depth');
  const malformed = [
    { U: 101, u: undefined },
    { U: 101, u: Number.MAX_SAFE_INTEGER + 1 },
    { U: undefined, u: 101 },
    { U: Number.MAX_SAFE_INTEGER + 1, u: Number.MAX_SAFE_INTEGER + 2 },
  ];
  for (const [index, ids] of malformed.entries()) {
    defined(depth).emit({ stream: 'btcusdt@depth', data: { e: 'depthUpdate', E: 1700000000000 + index, s: 'BTCUSDT', pu: 100 + (depthCalls * 10), b: [], a: [], ...ids } });
    await new Promise(resolve => setImmediate(() => setImmediate(resolve)));
  }
  const invalidations = messages.filter(item => item.message.kind === 'depthSnapshot' && item.message.invalidated === true);
  assert.equal(invalidations.length, malformed.length);
  assert.ok(invalidations.every(item => /malformed Binance depth payload/.test(textValue(item.message.invalidReason))));
  assert.equal(messages.filter(item => item.message.kind === 'depthDelta').length, 0);
  assert.equal(depthCalls, malformed.length + 1);
  assert.equal(manager.status()['binance-depth'].state, 'snapshot');
  manager.stop();
});

test('Binance missing or unsafe REST snapshot IDs fail closed without publishing a complete book', async () => {
  for (const sequence of [undefined, Number.MAX_SAFE_INTEGER + 1]) {
    const fake = makeFakeTransport(); const messages: LiveFeedEvent[] = [];
    const manager = new LiveFeedManager({
      networkEnabled: true, transportFactory: fake.factory, oiPollMs: 0, onMessage: message => messages.push(message),
      restTransport: { request: async request => request.url.includes('/depth')
        ? { ...(sequence === undefined ? {} : { lastUpdateId: sequence }), bids: [['100', '2']], asks: [['101', '1']] }
        : { openInterest: '1', time: 1700000000000 } },
    });
    await manager.start({ binanceSymbol: 'BTCUSDT' });
    assert.equal(manager.status()['binance-depth'].state, 'unavailable');
    assert.equal(messages.filter(item => item.id === 'binance-depth' && item.message.kind === 'depthSnapshot' && item.message.invalidated !== true).length, 0);
    assert.equal(manager.bookSequences.has('binance:BTCUSDT'), false);
    manager.stop();
  }
});

test('Binance sequence gaps publish invalidation and block stale contiguous deltas after failed resync', async () => {
  const fake = makeFakeTransport(); const messages: LiveFeedEvent[] = []; let depthCalls = 0; let rejectResync: ((error: Error) => void) | undefined;
  const manager = new LiveFeedManager({
    networkEnabled: true, transportFactory: fake.factory, oiPollMs: 0, onMessage: message => messages.push(message),
    restTransport: { request: async request => {
      if (request.url.includes('/depth')) {
        depthCalls += 1;
        if (depthCalls === 1) return { lastUpdateId: 100, bids: [['100', '2']], asks: [['101', '1']] };
        return new Promise((resolve, reject) => { rejectResync = reject; });
      }
      return { openInterest: '1', time: 1700000000000 };
    } },
  });
  await manager.start({ binanceSymbol: 'BTCUSDT' });
  const depth = fake.sockets.find(socket => socket.spec.channel === 'depth');
  defined(depth).emit({ stream: 'btcusdt@depth', data: { e: 'depthUpdate', E: 1700000000000, s: 'BTCUSDT', U: 105, pu: 90, u: 105, b: [], a: [] } });
  const invalidation = defined(messages.filter(item => item.message.kind === 'depthSnapshot').at(-1)).message;
  assert.equal(invalidation.complete, false);
  assert.equal(invalidation.gap, true);
  assert.equal(invalidation.invalidated, true);
  assert.equal(invalidation.resyncRequired, true);
  assert.equal(invalidation.sourceTimestamp, null);
  assert.equal(typeof rejectResync, 'function');
  defined(depth).emit({ stream: 'btcusdt@depth', data: { e: 'depthUpdate', E: 1700000000001, s: 'BTCUSDT', U: 106, pu: 100, u: 106, b: [['100', '3']], a: [] } });
  assert.equal(messages.filter(item => item.message.kind === 'depthDelta').length, 0);
  defined(rejectResync)(new Error('resync unavailable'));
  await new Promise(resolve => setImmediate(resolve));
  defined(depth).emit({ stream: 'btcusdt@depth', data: { e: 'depthUpdate', E: 1700000000002, s: 'BTCUSDT', U: 107, pu: 100, u: 107, b: [['100', '4']], a: [] } });
  assert.equal(messages.filter(item => item.message.kind === 'depthDelta').length, 0);
  assert.equal(depthCalls, 2);
  manager.stop();
});

test('Binance REST resync flight is retained-admitted before request and released on completion', async () => {
  const fake = makeFakeTransport();
  const app = createLocalServer({ liveMode: true, persistFixture: false, quota: new QuotaLedger(), history: new HistoryStore({ filePath: ':memory:' }) });
  let manager: LiveFeedManager;
  let depthCalls = 0;
  let resolveResync: ((value: unknown) => void) | undefined;
  const admissions: MutationContext[] = [];
  const resyncOrder: string[] = [];
  manager = new LiveFeedManager({
    networkEnabled: true,
    transportFactory: fake.factory,
    oiPollMs: 0,
    retainedAdmission: (candidate, context, commit, onReject) => {
      const result = app.admitRetainedMutation(candidate, context, commit, onReject);
      if (fields(candidate)?.kind === 'feed-binance-resync-flight') {
        admissions.push({ candidate, context, result, committed: manager.resyncing.has(textValue(fields(candidate).instrumentId)) });
        resyncOrder.push('admitted');
      }
      return result;
    },
    onMessage: ({ venue, message, retainedMutation }) => app.applyMessage(message, venue, { retainedMutation }),
    restTransport: makeRestTransport(async request => {
      if (!request.url.includes('/depth')) return { openInterest: '1', time: 1_700_000_000_000 };
      depthCalls += 1;
      if (depthCalls === 1) return { lastUpdateId: 100, bids: [['100', '2']], asks: [['101', '1']] };
      resyncOrder.push('request');
      return new Promise<unknown>(resolve => { resolveResync = resolve; });
    }),
  });
  app.retainedProviders.feeds = manager;
  try {
    await manager.start({ binanceSymbol: 'BTCUSDT' });
    const depth = fake.sockets.find(socket => socket.spec.channel === 'depth');
    const instrumentId = 'binance:BTCUSDT';
    defined(depth).emit({ stream: 'btcusdt@depth', data: { e: 'depthUpdate', E: 1_700_000_000_001, s: 'BTCUSDT', U: 105, pu: 90, u: 105, b: [], a: [] } });

    assert.equal(depthCalls, 2);
    assert.equal(typeof resolveResync, 'function');
    assert.equal(admissions.length, 1);
    assert.equal(fields(admissions[0].candidate).instrumentId, instrumentId);
    assert.equal(fields(admissions[0].context).kind, 'feed-resync-flight');
    assert.equal(admissions[0].committed, true);
    assert.deepEqual(resyncOrder, ['admitted', 'request']);
    assert.equal(defined(manager.resyncing.get(instrumentId)).generation, defined(manager.feeds.get('binance-depth')).generation);
    assert.ok(manager.retainedDiagnostics().logicalComponents.resyncing > 0);

    defined(resolveResync)({ lastUpdateId: 200, bids: [['100', '3']], asks: [['101', '1']] });
    await new Promise(resolve => setImmediate(() => setImmediate(resolve)));
    assert.equal(manager.resyncing.has(instrumentId), false);
    assert.equal(manager.retainedDiagnostics().logicalComponents.resyncing, 0);
    assert.equal(app.state.books[instrumentId].sequence, 200);
  } finally {
    manager.stop();
    await app.close();
  }
});

test('rejected Binance REST resync-flight admission starts no REST request and retains no marker', async () => {
  const fake = makeFakeTransport();
  const app = createLocalServer({ liveMode: true, persistFixture: false, quota: new QuotaLedger(), history: new HistoryStore({ filePath: ':memory:' }) });
  let manager: LiveFeedManager;
  let depthCalls = 0;
  let rejectedMarker: {candidate: unknown; context: MutationContext; hadMarker: boolean} | null = null;
  manager = new LiveFeedManager({
    networkEnabled: true,
    transportFactory: fake.factory,
    oiPollMs: 0,
    retainedAdmission: (candidate, context, commit, onReject) => {
      if (fields(candidate)?.kind === 'feed-binance-resync-flight') {
        rejectedMarker = { candidate, context, hadMarker: manager.resyncing.has(textValue(fields(candidate).instrumentId)) };
        return { admitted: false, reservation: { reason: 'test-resync-capacity', bytes: 0, context: {} } };
      }
      return app.admitRetainedMutation(candidate, context, commit, onReject);
    },
    onMessage: ({ venue, message, retainedMutation }) => app.applyMessage(message, venue, { retainedMutation }),
    restTransport: makeRestTransport(async request => {
      if (!request.url.includes('/depth')) return { openInterest: '1', time: 1_700_000_000_000 };
      depthCalls += 1;
      return { lastUpdateId: 100, bids: [['100', '2']], asks: [['101', '1']] };
    }),
  });
  app.retainedProviders.feeds = manager;
  try {
    await manager.start({ binanceSymbol: 'BTCUSDT' });
    const depth = fake.sockets.find(socket => socket.spec.channel === 'depth');
    const instrumentId = 'binance:BTCUSDT';
    defined(depth).emit({ stream: 'btcusdt@depth', data: { e: 'depthUpdate', E: 1_700_000_000_001, s: 'BTCUSDT', U: 105, pu: 90, u: 105, b: [], a: [] } });

    assert.equal(fields(fields(defined<unknown>(rejectedMarker)).context).kind, 'feed-resync-flight');
    assert.equal(fields(fields(defined<unknown>(rejectedMarker)).candidate).instrumentId, instrumentId);
    assert.equal(fields(defined<unknown>(rejectedMarker)).hadMarker, false);
    assert.equal(depthCalls, 1);
    assert.equal(manager.resyncing.has(instrumentId), false);
    assert.equal(manager.retainedDiagnostics().logicalComponents.resyncing, 0);
  } finally {
    manager.stop();
    await app.close();
  }
});

test('Binance buffered bridge gaps invalidate the new snapshot instead of restoring a partial book', async () => {
  const fake = makeFakeTransport(); const messages: LiveFeedEvent[] = []; let depthCalls = 0; let resolveResync: ((value: unknown) => void) | undefined;
  const manager = new LiveFeedManager({
    networkEnabled: true, transportFactory: fake.factory, oiPollMs: 0, onMessage: message => messages.push(message),
    restTransport: { request: async request => {
      if (request.url.includes('/depth')) {
        depthCalls += 1;
        if (depthCalls === 1) return { lastUpdateId: 100, bids: [['100', '2']], asks: [['101', '1']] };
        return new Promise(resolve => { resolveResync = resolve; });
      }
      return { openInterest: '1', time: 1700000000000 };
    } },
  });
  await manager.start({ binanceSymbol: 'BTCUSDT' });
  const depth = fake.sockets.find(socket => socket.spec.channel === 'depth');
  defined(depth).emit({ stream: 'btcusdt@depth', data: { e: 'depthUpdate', E: 1700000000000, s: 'BTCUSDT', U: 105, pu: 90, u: 105, b: [], a: [] } });
  await new Promise(resolve => setImmediate(resolve));
  defined(depth).emit({ stream: 'btcusdt@depth', data: { e: 'depthUpdate', E: 1700000000001, s: 'BTCUSDT', U: 205, pu: 190, u: 205, b: [], a: [] } });
  defined(resolveResync)({ lastUpdateId: 200, bids: [['100', '5']], asks: [['101', '2']] });
  await new Promise(resolve => setImmediate(() => setImmediate(resolve)));
  const snapshots = messages.filter(item => item.message.kind === 'depthSnapshot').map(item => item.message);
  assert.equal(defined(snapshots.at(-1)).complete, false);
  assert.equal(defined(snapshots.at(-1)).invalidated, true);
  assert.equal(manager.status()['binance-depth'].state, 'unavailable');
  defined(depth).emit({ stream: 'btcusdt@depth', data: { e: 'depthUpdate', E: 1700000000002, s: 'BTCUSDT', U: 201, pu: 200, u: 201, b: [], a: [] } });
  assert.equal(messages.filter(item => item.message.kind === 'depthDelta').length, 0);
  manager.stop();
});

test('active book set covers public feeds and stop severs feed references', async () => {
  const fake = makeFakeTransport(); const statuses: LiveFeedStatusEvent[] = [];
  const manager = new LiveFeedManager({ networkEnabled: true, transportFactory: fake.factory, oiPollMs: 0, onStatus: status => statuses.push(status) });
  await manager.start({ bybitEnabled: true, bybitSymbol: 'BTCUSDT' });
  const active = statuses.find(status => status.id === 'active-book-set')?.activeBookSets;
  assert.deepEqual(fields(active)['bybit:BTCUSDT'], ['bybit:BTCUSDT|native']);
  const bybitFeed = manager.feeds.get('bybit-depth');
  const bybitSocket = defined(bybitFeed).socket;
  manager.stop();
  assert.equal(defined(bybitFeed).socket, null);
  assert.equal(defined(bybitFeed).session, null);
  assert.equal(fields(defined(bybitSocket)).closed, true);
  assert.equal(manager.feeds.size, 0);
  assert.equal(manager.specs.size, 0);
});

test('Binance depth buffers out-of-order deltas and emits each sequence once', async () => {
  const fake = makeFakeTransport(); const messages: LiveFeedEvent[] = []; let resolveDepth: ((value: unknown) => void) | undefined;
  const manager = new LiveFeedManager({
    networkEnabled: true, transportFactory: fake.factory, oiPollMs: 0, onMessage: message => messages.push(message),
    restTransport: { request: async request => request.url.includes('/depth')
      ? new Promise(resolve => { resolveDepth = resolve; })
      : { openInterest: '1', time: 1700000000000 } },
  });
  const starting = manager.start({ binanceSymbol: 'BTCUSDT' });
  await new Promise(resolve => setImmediate(resolve));
  const depth = fake.sockets.find(socket => socket.spec.channel === 'depth');
  const delta = (first: number, previous: number, sequence: number, bids: unknown[]) => ({ stream: 'btcusdt@depth', data: { e: 'depthUpdate', E: 1700000000000, s: 'BTCUSDT', U: first, pu: previous, u: sequence, b: bids, a: [] } });
  // Frames can arrive before the REST snapshot, out of order, with a duplicate.
  defined(depth).emit(delta(102, 101, 102, [['100', '4']]));
  defined(depth).emit(delta(102, 101, 102, [['100', '4']]));
  defined(depth).emit(delta(101, 100, 101, [['100', '3']]));
  assert.equal(messages.filter(item => item.message.kind === 'depthDelta').length, 0);
  defined(resolveDepth)({ lastUpdateId: 100, bids: [['100', '2']], asks: [['101', '1']] });
  await starting;
  const deltas = messages.filter(item => item.message.kind === 'depthDelta').map(item => item.message);
  assert.deepEqual(deltas.map(message => message.sequence), [101, 102]);
  assert.deepEqual(deltas.map(message => message.previousSequence), [100, 101]);
  assert.equal(manager.status()['binance-depth'].state, 'live');
  manager.stop();
});

test('Binance depth reconnect retires the old socket and takes a fresh snapshot', async () => {
  const fake = makeFakeTransport(); const timers: {fn: () => unknown; delay: number}[] = []; const messages: LiveFeedEvent[] = []; let depthCalls = 0;
  const manager = new LiveFeedManager({
    networkEnabled: true, transportFactory: fake.factory, oiPollMs: 0, onMessage: message => messages.push(message),
    schedule: (fn, delay) => { const item = { fn, delay }; timers.push(item); return timers.length; }, cancel: () => {}, reconnectBaseMs: 100, reconnectMaxMs: 250,
    restTransport: { request: async request => request.url.includes('/depth')
      ? (++depthCalls, { lastUpdateId: depthCalls === 1 ? 100 : 200, bids: [['100', String(depthCalls)]], asks: [['101', '1']] })
      : { openInterest: '1', time: 1700000000000 } },
  });
  await manager.start({ binanceSymbol: 'BTCUSDT' });
  const first = fake.sockets.find(socket => socket.spec.channel === 'depth');
  defined(first).closeWith('lost');
  assert.equal(timers.length, 1); assert.equal(manager.status()['binance-depth'].state, 'backoff');
  // A queued frame from the retired socket must be ignored.
  defined(first).emit({ stream: 'btcusdt@depth', data: { e: 'depthUpdate', E: 1700000000000, s: 'BTCUSDT', U: 101, pu: 100, u: 101, b: [['100', '9']], a: [] } });
  assert.equal(messages.filter(item => item.message.kind === 'depthDelta').length, 0);
  await timers[0].fn();
  const snapshots = messages.filter(item => item.message.kind === 'depthSnapshot' && Number.isFinite(item.message.sequence)).map(item => item.message.sequence);
  assert.deepEqual(snapshots, [100, 200]);
  assert.equal(depthCalls, 2); assert.equal(manager.status()['binance-depth'].state, 'snapshot');
  manager.stop();
});

test('late Binance REST snapshot from a retired feed cannot overwrite reconnect state', async () => {
  const fake = makeFakeTransport(); const timers: {fn: () => unknown; delay: number}[] = []; const messages: LiveFeedEvent[] = []; let depthCalls = 0; let resolveOld: ((value: unknown) => void) | undefined;
  const manager = new LiveFeedManager({
    networkEnabled: true, transportFactory: fake.factory, oiPollMs: 0, onMessage: message => messages.push(message),
    schedule: (fn, delay) => { const item = { fn, delay }; timers.push(item); return timers.length; }, cancel: () => {}, reconnectBaseMs: 100, reconnectMaxMs: 250,
    restTransport: { request: async request => {
      if (request.url.includes('/depth')) {
        depthCalls += 1;
        if (depthCalls === 1) return new Promise<unknown>(resolve => { resolveOld = resolve; });
        return { lastUpdateId: 200, bids: [['100', '2']], asks: [['101', '1']] };
      }
      return { openInterest: '1', time: 1700000000000 };
    } },
  });
  const starting = manager.start({ binanceSymbol: 'BTCUSDT' });
  await new Promise(resolve => setImmediate(resolve));
  const first = fake.sockets.find(socket => socket.spec.channel === 'depth');
  defined(first).closeWith('lost');
  await timers[0].fn();
  assert.deepEqual(messages.filter(item => item.message.kind === 'depthSnapshot' && Number.isFinite(item.message.sequence)).map(item => item.message.sequence), [200]);
  defined(resolveOld)({ lastUpdateId: 100, bids: [['100', '9']], asks: [['101', '9']] });
  await starting;
  assert.deepEqual(messages.filter(item => item.message.kind === 'depthSnapshot' && Number.isFinite(item.message.sequence)).map(item => item.message.sequence), [200]);
  assert.equal(depthCalls, 2); assert.equal(manager.status()['binance-depth'].state, 'snapshot');
  manager.stop();
});

test('late Binance gap resync cannot poison a replacement or block its next resync', async () => {
  const fake = makeFakeTransport(); const timers: {fn: () => unknown; delay: number}[] = []; const messages: LiveFeedEvent[] = []; let depthCalls = 0; let resolveOldResync: ((value: unknown) => void) | undefined;
  const manager = new LiveFeedManager({
    networkEnabled: true, transportFactory: fake.factory, oiPollMs: 0, onMessage: message => messages.push(message),
    schedule: (fn, delay) => { const item = { fn, delay }; timers.push(item); return timers.length; }, cancel: () => {}, reconnectBaseMs: 100, reconnectMaxMs: 250,
    restTransport: { request: async request => {
      if (request.url.includes('/depth')) {
        depthCalls += 1;
        if (depthCalls === 1) return { lastUpdateId: 100, bids: [['100', '1']], asks: [['101', '1']] };
        if (depthCalls === 2) return new Promise(resolve => { resolveOldResync = resolve; });
        if (depthCalls === 3) return { lastUpdateId: 200, bids: [['100', '2']], asks: [['101', '1']] };
        return { lastUpdateId: 210, bids: [['100', '3']], asks: [['101', '1']] };
      }
      return { openInterest: '1', time: 1700000000000 };
    } },
  });
  await manager.start({ binanceSymbol: 'BTCUSDT' });
  const first = fake.sockets.find(socket => socket.spec.channel === 'depth');
  defined(first).emit({ stream: 'btcusdt@depth', data: { e: 'depthUpdate', E: 1700000000000, s: 'BTCUSDT', U: 105, pu: 90, u: 105, b: [], a: [] } });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(typeof resolveOldResync, 'function');
  defined(first).closeWith('lost');
  await timers[0].fn();
  const second = fake.sockets.filter(socket => socket.spec.channel === 'depth').at(-1);
  defined(second).emit({ stream: 'btcusdt@depth', data: { e: 'depthUpdate', E: 1700000000000, s: 'BTCUSDT', U: 205, pu: 190, u: 205, b: [], a: [] } });
  await new Promise(resolve => setImmediate(() => setImmediate(resolve)));
  defined(resolveOldResync)({ lastUpdateId: 150, bids: [['100', '9']], asks: [['101', '9']] });
  await new Promise(resolve => setImmediate(() => setImmediate(resolve)));
  assert.deepEqual(messages.filter(item => item.message.kind === 'depthSnapshot' && Number.isFinite(item.message.sequence)).map(item => item.message.sequence), [100, 200, 210]);
  assert.equal(depthCalls, 4); assert.equal(manager.status()['binance-depth'].state, 'snapshot');
  manager.stop();
});

test('overlapping Binance first delta is bridged before the strict server reducer', async () => {
  const fake = makeFakeTransport(); let resolveDepth: ((value: unknown) => void) | undefined; const app = createLocalServer({ liveMode: true, persistFixture: false, quota: new QuotaLedger(), history: new HistoryStore({ filePath: ':memory:' }) });
  const manager = new LiveFeedManager({
    networkEnabled: true, transportFactory: fake.factory, oiPollMs: 0,
    onMessage: ({ venue, message }) => app.applyMessage(message, venue),
    restTransport: { request: async request => request.url.includes('/depth') ? new Promise(resolve => { resolveDepth = resolve; }) : { openInterest: '1', time: 1700000000000 } },
  });
  const starting = manager.start({ binanceSymbol: 'BTCUSDT' });
  await new Promise(resolve => setImmediate(resolve));
  const depth = fake.sockets.find(socket => socket.spec.channel === 'depth');
  defined(depth).emit({ stream: 'btcusdt@depth', data: { e: 'depthUpdate', E: 1700000000000, s: 'BTCUSDT', U: 99, pu: 98, u: 102, b: [['100', '3']], a: [] } });
  defined(resolveDepth)({ lastUpdateId: 100, bids: [['100', '2']], asks: [['101', '1']] });
  await starting;
  assert.equal(app.state.books['binance:BTCUSDT'].complete, true);
  assert.equal(app.state.books['binance:BTCUSDT'].sequence, 102);
  assert.deepEqual(app.state.books['binance:BTCUSDT'].bids, [[100, 3]]);
  assert.equal(manager.status()['binance-depth'].state, 'live');
  manager.stop(); app.close();
});

test('network-enabled start without an injected factory fails closed', async () => {
  const manager = new LiveFeedManager({networkEnabled:true});
  await assert.rejects(() => manager.start(), AdapterTransportError);
});

test('Binance overlap rewrite is consumed after one initial post-snapshot event', async () => {
  const fake = makeFakeTransport(); const messages: LiveFeedEvent[] = []; let depthCalls = 0;
  const manager = new LiveFeedManager({
    networkEnabled: true, transportFactory: fake.factory, oiPollMs: 0, onMessage: message => messages.push(message),
    restTransport: { request: async request => {
      if (request.url.includes('/depth')) { depthCalls += 1; return { lastUpdateId: depthCalls === 1 ? 100 : 200, bids: [['100', '2']], asks: [['101', '1']] }; }
      return { openInterest: '1', time: 1700000000000 };
    } },
  });
  await manager.start({ binanceSymbol: 'BTCUSDT' });
  const depth = fake.sockets.find(socket => socket.spec.channel === 'depth');
  defined(depth).emit({ stream: 'btcusdt@depth', data: { e: 'depthUpdate', E: 1700000000000, s: 'BTCUSDT', U: 99, pu: 98, u: 102, b: [['100', '3']], a: [] } });
  const bridged = messages.find(item => item.message.kind === 'depthDelta');
  assert.equal(defined(bridged).message.previousSequence, 100);
  assert.equal(manager.status()['binance-depth'].state, 'live');
  // A second mismatched pu cannot be rewritten: it must trigger a fresh snapshot.
  defined(depth).emit({ stream: 'btcusdt@depth', data: { e: 'depthUpdate', E: 1700000000100, s: 'BTCUSDT', U: 103, pu: 98, u: 104, b: [], a: [] } });
  await new Promise(resolve => setImmediate(() => setImmediate(resolve)));
  assert.equal(depthCalls, 2); assert.equal(messages.filter(item => item.message.kind === 'depthDelta').length, 1);
  assert.equal(manager.status()['binance-depth'].state, 'snapshot');
  manager.stop();
});
