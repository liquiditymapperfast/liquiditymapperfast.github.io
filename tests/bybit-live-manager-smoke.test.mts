import { smokeRecord, smokeArray, smokeRequired, smokeFrameText } from '../scripts/smoke-boundaries.mts';
import type { LiveFeedSocket, LiveFeedTransportOptions } from '../src/server/live-feeds.mts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { runBybitLiveManagerSmoke, waitForBybitSmoke } from '../scripts/bybit-live-manager-smoke.mts';

class FakeSocket implements LiveFeedSocket {
  readonly spec: LiveFeedTransportOptions;
  readonly sent: unknown[] = [];
  closed = false;
  readonly listeners = new Map<string, ((payload: unknown) => void)[]>();
  onMessage?: (raw: unknown) => void;
  onClose?: (reason: unknown) => void;
  onError?: (error: unknown) => void;
  constructor(spec: LiveFeedTransportOptions, onCreate?: (socket: FakeSocket) => void) { this.spec = spec; onCreate?.(this); }
  async open() {}
  send(value: unknown) { this.sent.push(value); }
  on(event: string, listener: (payload: unknown) => void) { const listeners = this.listeners.get(event) ?? []; listeners.push(listener); this.listeners.set(event, listeners); }
  emitClose(code: unknown) { if (!this.closed) { this.closed = true; const listeners = this.listeners.get('close') ?? []; if (listeners.length) for (const listener of listeners) listener(code); else this.onClose?.(code); } }
  close() { this.emitClose(1000); }
  terminate() { this.emitClose(1006); }
  emit(value: unknown) { const listeners = this.listeners.get('message') ?? []; if (listeners.length) for (const listener of listeners) listener(value); else this.onMessage?.(value); }
}

function fakeTransport({ replacement = 'healthy', hangReplacement = false, ackTopics = null }: { replacement?: string; hangReplacement?: boolean; ackTopics?: string[] | null } = {}) {
  const sockets: FakeSocket[] = [];
  return {
    sockets,
    factory: async (spec: LiveFeedTransportOptions): Promise<FakeSocket> => {
      if (spec.venue !== 'bybit') return new FakeSocket(spec);
      if (hangReplacement && sockets.length > 0) return new Promise<FakeSocket>(() => {});
      const index = sockets.length;
      const socket = new FakeSocket(spec, (item: FakeSocket) => sockets.push(item));
      setTimeout(() => {
        if (index === 0 || replacement === 'healthy') socket.emit(JSON.stringify({ topic: smokeArray(smokeRecord(spec.request).args)[0], type: 'snapshot', ts: 1_700_000_000_000 + index, data: { category: 'linear', s: 'BTCUSDT', u: 10 + index, seq: 100 + index, b: [['100', '2']], a: [['101', '3']] } }));
        if (index === 0 || replacement === 'healthy' || replacement === 'delta-only') socket.emit(JSON.stringify({ topic: smokeArray(smokeRecord(spec.request).args)[0], type: 'delta', ts: 1_700_000_000_100 + index, data: { category: 'linear', s: 'BTCUSDT', u: 11 + index, seq: 101 + index, b: [['100', '0']], a: [] } }));
        socket.emit(JSON.stringify({ op: 'subscribe', args: ackTopics ?? smokeRecord(spec.request).args, success: true, retCode: 0 }));
      }, 0);
      return socket;
    },
  };
}

test('smoke evidence requires per-session ack, healthy snapshot, routed delta, close, and reconnect', async () => {
  const fake = fakeTransport();
  const artifact = await runBybitLiveManagerSmoke({ transportFactory: fake.factory, timeoutMs: 800, reconnectTimeoutMs: 800, reconnectBaseMs: 10, reconnectMaxMs: 20 });
  assert.equal(artifact.status, 'read-only-live-observation');
  assert.equal(artifact.observed.managerStarted, true);
  assert.deepEqual(artifact.observed.stages, { managerStarted: true, initialAck: true, initialHealthySnapshot: true, initialDelta: true, close: true, reconnect: true, cleanup: true });
  assert.equal(artifact.observed.connections[0].routedDeltas, 1);
  assert.equal(artifact.observed.connections[1].healthySnapshots, 1);
  assert.equal(artifact.observed.connections[1].routedDeltas, 1);
  assert.equal(artifact.observed.connections[0].exactSubscribeRequest, true);
  assert.equal(artifact.observed.connections[0].dataFramesBeforeSubscribeAck, 2);
  assert.equal(artifact.observed.connections[1].dataFramesBeforeSubscribeAck, 2);
  assert.equal(artifact.observed.connections[0].closeCode, 1006);
  assert.equal(artifact.observed.connections[0].backoffObserved, true);
  assert.deepEqual(artifact.observed.connections[0].wireEventOrder.slice(0, 3), ['snapshot', 'delta', 'subscribe-ack']);
  assert.equal(artifact.observed.connections[1].deltaSequenceAdvances, true);
  assert.equal(artifact.observed.connections[1].deltaContinuity, 'unproven');
  assert.equal(artifact.observed.coverage, 'partial');
  assert.equal('payload' in artifact, false);
  assert.equal(JSON.stringify(artifact).includes('"amount"'), false);
});

test('a successful-looking acknowledgement for a different topic is not exact live evidence', async () => {
  const fake = fakeTransport({ ackTopics: ['orderbook.1000.ETHUSDT'] });
  const artifact = await runBybitLiveManagerSmoke({
    transportFactory: fake.factory,
    timeoutMs: 80,
    reconnectTimeoutMs: 50,
    reconnectBaseMs: 10,
    reconnectMaxMs: 20,
  });
  assert.equal(artifact.status, 'failed-bounded-observation');
  assert.equal(artifact.observed.connections[0].subscribeRequests, 1);
  assert.equal(artifact.observed.connections[0].subscribeAcks, 0);
  assert.equal(artifact.observed.connections[0].rejectedSubscribeAcks, 1);
  assert.equal(artifact.observed.stages.initialAck, false);
});

test('hung manager startup is bounded and cleanup runs', async () => {
  let stopped = false;
  const artifact = await runBybitLiveManagerSmoke({
    timeoutMs: 20,
    closeAfterDelta: false,
    requireDelta: false,
    requireReconnect: false,
    managerFactory: () => ({ start: () => new Promise(() => {}), stop: () => { stopped = true; } }),
  });
  assert.equal(stopped, true);
  assert.equal(artifact.observed.managerStarted, false);
  assert.equal(artifact.status, 'failed-bounded-observation');
  assert.match(artifact.limits.join(' '), /timed out while awaiting LiveFeedManager\.start/);
});

test('actual LiveFeedManager late transport is closed after startup timeout and never sends', async () => {
  const late: { socket: FakeSocket | null } = { socket: null };
  const artifact = await runBybitLiveManagerSmoke({
    timeoutMs: 15,
    closeAfterDelta: false,
    requireDelta: false,
    requireReconnect: false,
    transportFactory: async spec => {
      if (spec.venue !== 'bybit') return new FakeSocket(spec);
      await new Promise(resolve => setTimeout(resolve, 60));
      late.socket = new FakeSocket(spec);
      return late.socket;
    },
  });
  assert.equal(artifact.observed.managerStarted, false);
  assert.equal(artifact.status, 'failed-bounded-observation');
  await new Promise(resolve => setTimeout(resolve, 80));
  assert.ok(late.socket);
  assert.equal(late.socket.closed, true);
  assert.equal(late.socket.sent.length, 0);
});

test('invalidation-only replacement does not satisfy healthy snapshot predicate', async () => {
  const fake = fakeTransport({ replacement: 'none' });
  const artifact = await runBybitLiveManagerSmoke({ transportFactory: fake.factory, timeoutMs: 300, reconnectTimeoutMs: 350, reconnectBaseMs: 10, reconnectMaxMs: 20 });
  assert.equal(artifact.status, 'failed-bounded-observation');
  assert.equal(artifact.observed.invalidationSnapshots >= 1, true);
  assert.equal(artifact.observed.connections[0].healthySnapshots, 1);
  assert.equal(artifact.observed.connections[1].subscribeAcks, 1);
  assert.equal(artifact.observed.connections[1].healthySnapshots, 0);
  assert.equal(artifact.observed.stages.reconnect, false);
});

test('missing replacement snapshot does not combine ack or wire delta with another session', async () => {
  const fake = fakeTransport({ replacement: 'delta-only' });
  const artifact = await runBybitLiveManagerSmoke({ transportFactory: fake.factory, timeoutMs: 300, reconnectTimeoutMs: 350, reconnectBaseMs: 10, reconnectMaxMs: 20 });
  assert.equal(artifact.status, 'failed-bounded-observation');
  assert.equal(artifact.observed.connections[1].subscribeAcks, 1);
  assert.equal(artifact.observed.connections[1].wireDeltas, 1);
  assert.equal(artifact.observed.connections[1].healthySnapshots, 0);
  assert.equal(artifact.observed.connections[1].routedDeltas, 0);
  assert.equal(artifact.observed.stages.reconnect, false);
});

test('reconnect timeout is reported when replacement transport never starts', async () => {
  const fake = fakeTransport({ hangReplacement: true });
  const artifact = await runBybitLiveManagerSmoke({ transportFactory: fake.factory, timeoutMs: 300, reconnectTimeoutMs: 40, reconnectBaseMs: 10, reconnectMaxMs: 20 });
  assert.equal(artifact.status, 'failed-bounded-observation');
  assert.equal(artifact.observed.reconnectSockets, 0);
  assert.equal(artifact.observed.stages.close, true);
  assert.equal(artifact.observed.stages.reconnect, false);
  assert.match(artifact.limits.join(' '), /replacement/);
});

test('wait helper reports timeout deterministically', async () => {
  let clock = 0;
  const result = await waitForBybitSmoke(() => false, { timeoutMs: 5, pollMs: 1, now: () => clock, sleep: async delay => { clock += delay; } });
  assert.equal(result.timedOut, true);
  assert.equal(result.elapsedMs, 5);
});
