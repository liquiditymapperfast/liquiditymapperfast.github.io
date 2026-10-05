import test from 'node:test';
import assert from 'node:assert/strict';
import { LiveFeedManager, LIVE_FEED_TRANSPORT_SHELL_LOGICAL_BYTES, LIVE_FEED_TIMER_SHELL_LOGICAL_BYTES, LIVE_FEED_CALLBACK_SHELL_LOGICAL_BYTES,
  type LiveFeed, type LiveFeedSocket, type LiveFeedSpec, type LiveFeedTransportOptions } from '../src/server/live-feeds.mts';
import { logicalRetainedBytes } from '../src/core/retained-bytes.mts';
import { VenueHeartbeatDeadline } from '../src/adapters/venue-transport.mts';
import { createBybitDepthSession, applyBybitDepthSessionMessage } from '../src/adapters/bybit-depth-session.mts';
import { normalizeBybitDepth } from '../src/adapters/bybit.mts';

function throwingNativeOwner(onRead: () => void) {
  const owner = {};
  Object.defineProperty(owner, 'reading', { enumerable: true, get() { onRead(); throw new TypeError('native TCP getter observed after TLS close'); } });
  return owner;
}
function feedSpec(): LiveFeedSpec { return { venue: 'bybit', channel: 'depth', topic: 'orderbook.1000.BTCUSDT', instrumentId: 'bybit:BTCUSDT', request: { url: 'wss://example.invalid' }, decode: () => null }; }
function feedShell(spec: LiveFeedSpec, socket: LiveFeedSocket | null = null): LiveFeed {
  return { id: 'bybit-depth', spec, socket, generation: 1, configurationGeneration: 1, retry: null, retired: false,
    sessionToken: 'owned-session', session: createBybitDepthSession({ topic: spec.topic, instrumentId: spec.instrumentId, sessionToken: 'owned-session' }),
    preAckFrames: [], preAckBytes: 0, heartbeat: new VenueHeartbeatDeadline({ venue: 'bybit', now: () => 1000 }), heartbeatTimer: null };
}

test('feed owner excludes native WebSocket/TLS and timer graphs without touching throwing getters', () => {
  let reads = 0; const native = throwingNativeOwner(() => reads++), socket: LiveFeedSocket = { close() {} };
  Object.defineProperty(socket, 'socket', { enumerable: true, value: native });
  const manager = new LiveFeedManager({ cancel() {}, heartbeatCancel() {} }), spec = feedSpec(), feed = feedShell(spec, socket);
  feed.retry = native; feed.heartbeatTimer = throwingNativeOwner(() => reads++);
  manager.specs.set('bybit-depth', spec); manager.feeds.set('bybit-depth', feed); manager.heartbeatTimers.set('bybit-depth', feed.heartbeatTimer);
  try {
    assert.throws(() => logicalRetainedBytes(manager.feeds), /native TCP getter/); reads = 0;
    for (let iteration = 0; iteration < 10; iteration++) {
      const diagnostics = manager.retainedDiagnostics(); assert.equal(diagnostics.measurementComplete, true); assert.equal(reads, 0);
      assert.equal(diagnostics.nativeOwnership.transports, 1); assert.equal(diagnostics.nativeOwnership.timers, 2);
      assert.equal(diagnostics.logicalComponents.nativeTransportShells, LIVE_FEED_TRANSPORT_SHELL_LOGICAL_BYTES);
      assert.equal(diagnostics.logicalComponents.nativeTimerShells, 2 * LIVE_FEED_TIMER_SHELL_LOGICAL_BYTES);
      assert.equal(diagnostics.logicalComponents.callbackShells, diagnostics.nativeOwnership.callbacks * LIVE_FEED_CALLBACK_SHELL_LOGICAL_BYTES);
      assert.equal(diagnostics.nativeOwnership.nativeGraphTraversed, false); assert.equal(diagnostics.nativeOwnership.physicalMemory, 'process-RSS-authoritative');
    }
  } finally { manager.stop(); }
  const stopped = manager.retainedDiagnostics(); assert.equal(reads, 0); assert.equal(stopped.nativeOwnership.transports, 0); assert.equal(stopped.nativeOwnership.timers, 0);
  assert.equal(stopped.logicalComponents.feeds, 0); assert.equal(stopped.logicalComponents.nativeTransportShells, 0); assert.equal(stopped.logicalComponents.nativeTimerShells, 0);
});

test('projected ownership still grows with actual session, pre-ACK, request and metadata payloads', () => {
  const manager = new LiveFeedManager(), spec = feedSpec(), feed = feedShell(spec);
  manager.specs.set('bybit-depth', spec); manager.feeds.set('bybit-depth', feed);
  try {
    const before = manager.retainedDiagnostics();
    const payload = 'x'.repeat(4096); spec.request.body = payload;
    spec.metadata = { instrumentId: 'bybit:BTCUSDT', nativeSymbol: 'BTCUSDT', base: 'BTC', quote: 'USDT', metadataSource: payload };
    feed.preAckFrames?.push({ payload }); feed.preAckBytes = payload.length;
    const row = normalizeBybitDepth({ type: 'snapshot', ts: 1700000000000, data: { s: 'BTCUSDT', u: 1,
      b: Array.from({ length: 50 }, (_, index) => [String(100 - index), String(index + 1)]), a: Array.from({ length: 50 }, (_, index) => [String(101 + index), String(index + 1)]) } });
    feed.session = applyBybitDepthSessionMessage(createBybitDepthSession({ topic: spec.topic, instrumentId: spec.instrumentId, sessionToken: 'owned-session' }), { topic: spec.topic, sessionToken: 'owned-session', update: row }).session;
    const after = manager.retainedDiagnostics();
    assert.ok(Number(after.logicalBytes) >= Number(before.logicalBytes) + payload.length * 3 + 1600);
    assert.ok(after.logicalComponents.feeds > before.logicalComponents.feeds); assert.equal(after.nativeOwnership.transports, 0);
    assert.equal(after.nativeOwnership.callbacks, before.nativeOwnership.callbacks);
    feed.preAckFrames = []; feed.preAckBytes = 0; feed.session = null; delete spec.request.body; delete spec.metadata;
    assert.ok(Number(manager.retainedDiagnostics().logicalBytes) < Number(after.logicalBytes));
  } finally { manager.stop(); }
});

test('shared application spec references stay shared across projected feeds instead of double-counting payloads', () => {
  const manager = new LiveFeedManager(), spec = feedSpec(); spec.request.body = 'z'.repeat(8192);
  const first = feedShell(spec), second = { ...feedShell(spec), id: 'bybit-second' };
  manager.specs.set(first.id, spec); manager.specs.set(second.id, spec); manager.feeds.set(first.id, first); manager.feeds.set(second.id, second);
  try {
    const shared = manager.retainedDiagnostics();
    const separate = { ...spec, request: { ...spec.request } }; second.spec = separate; manager.specs.set(second.id, separate);
    const duplicated = manager.retainedDiagnostics();
    assert.ok(Number(duplicated.logicalBytes) >= Number(shared.logicalBytes) + 8192);
    assert.equal(duplicated.nativeOwnership.callbacks, shared.nativeOwnership.callbacks);
  } finally { manager.stop(); }
});

class NativeLikeSocket implements LiveFeedSocket {
  onMessage?: (raw: unknown) => void; onClose?: (reason: unknown) => void; onError?: (error: unknown) => void;
  closed = false; readonly socket: object;
  constructor(read: () => void) { this.socket = throwingNativeOwner(read); }
  async open() {} send() {} close() { this.closed = true; }
}
test('real manager startup and stop report opaque shell counts and clear owned handles', async () => {
  let reads = 0; const sockets: NativeLikeSocket[] = [], timers: object[] = [];
  const manager = new LiveFeedManager({ networkEnabled: true, oiPollMs: 0,
    transportFactory: async (_spec: LiveFeedTransportOptions) => { const socket = new NativeLikeSocket(() => reads++); sockets.push(socket); return socket; },
    heartbeatSchedule: () => { const timer = throwingNativeOwner(() => reads++); timers.push(timer); return timer; }, heartbeatCancel() {} });
  try {
    await manager.start(); const active = manager.retainedDiagnostics();
    assert.equal(active.nativeOwnership.transports, sockets.length); assert.equal(active.nativeOwnership.timers, timers.length);
    assert.ok(sockets.length > 0); assert.ok(timers.length > 0); assert.equal(reads, 0);
    assert.equal(active.logicalComponents.nativeTransportShells, sockets.length * LIVE_FEED_TRANSPORT_SHELL_LOGICAL_BYTES);
    manager.stop(); const stopped = manager.retainedDiagnostics();
    assert.ok(sockets.every(socket => socket.closed)); assert.equal(stopped.nativeOwnership.transports, 0); assert.equal(stopped.nativeOwnership.timers, 0); assert.equal(reads, 0);
    assert.ok(Number(stopped.logicalBytes) < Number(active.logicalBytes));
  } finally { manager.stop(); }
});