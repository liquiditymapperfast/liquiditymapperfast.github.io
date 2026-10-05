import test from 'node:test';
import assert from 'node:assert/strict';
import { LiveFeedManager, type LiveFeedSocket, type LiveFeedTransportOptions, type LiveFeedStatusEvent, type LiveFeedEvent } from '../src/server/live-feeds.mts';

const BASE = 1_700_000_000_000;
const ID = 'hl-activeAssetCtx';
interface Timer { fn: () => unknown; delay: number; cancelled: boolean }
class Socket implements LiveFeedSocket {
  onMessage?: (value: unknown) => void;
  onClose?: (value: unknown) => void;
  onError?: (value: unknown) => void;
  sent: string[] = []; closed = false;
  readonly listeners = new Map<string, (value: unknown) => void>();
  constructor(readonly spec: LiveFeedTransportOptions) {}
  open() {}
  send(value: string) { this.sent.push(value); }
  close() { this.closed = true; }
  on(event: string, listener: (value: unknown) => void) { this.listeners.set(event, listener); }
  emit(value: unknown) { this.onMessage?.(value); }
  signal(event: string) { this.listeners.get(event)?.(undefined); }
}
function harness() {
  let now = BASE; let rejectStatus = false;
  const sockets: Socket[] = [], admissions: string[] = [], statuses: LiveFeedStatusEvent[] = [], messages: LiveFeedEvent[] = [], retries: Timer[] = [];
  const timer = (fn: () => unknown, delay: number): Timer => ({ fn, delay, cancelled: false });
  const cancel = (value: unknown) => { if (value && typeof value === 'object' && 'cancelled' in value) value.cancelled = true; };
  const manager = new LiveFeedManager({
    networkEnabled: true, restTransport: null, now: () => now, transportNow: () => now, oiPollMs: 0,
    candleHistoryLimit: 0, oiHistoryLimit: 0,
    transportFactory: async spec => { const socket = new Socket(spec); sockets.push(socket); return socket; },
    transportPolicies: {
      hyperliquid: { subscribeIntervalMs: 0, heartbeatIntervalMs: 1, heartbeatTimeoutMs: 60_000 },
      binance: { subscribeIntervalMs: 0 },
    },
    schedule: (fn, delay) => { const value = timer(fn, delay); retries.push(value); return value; }, cancel,
    heartbeatSchedule: timer, heartbeatCancel: cancel,
    onMessage: event => { messages.push(event); },
    onStatus: event => { statuses.push(event); },
    retainedAdmission: (_candidate, context, commit, onReject) => {
      if (context.kind === 'live-feed-status-map') {
        admissions.push(String(context.feedId));
        if (rejectStatus && context.feedId === ID) {
          const reservation = { reason: 'fixture-pressure', bytes: 0, context: {} };
          onReject?.(reservation); return { admitted: false, reservation };
        }
      }
      commit(); return { admitted: true };
    },
  });
  const feed = (id = ID) => { const value = manager.feeds.get(id); assert.ok(value); return value; };
  const socket = (id = ID) => { const value = sockets.filter(item => item.spec.id === id).at(-1); assert.ok(value); return value; };
  const status = (id = ID) => { const value = manager.status()[id]; assert.ok(value); return value; };
  const admissionsFor = (id = ID) => admissions.filter(value => value === id).length;
  const tick = async (id = ID) => {
    const value = feed(id).heartbeatTimer;
    assert.ok(value && typeof value === 'object' && 'fn' in value && typeof value.fn === 'function');
    await value.fn();
  };
  const observe = () => socket().emit({ channel: 'activeAssetCtx', data: { coin: String(feed().spec.coin ?? 'BTC'), time: now, ctx: { openInterest: '4', markPx: '100' } } });
  const warm = async () => { await manager.start(); await tick(); socket().emit({ channel: 'pong' }); observe(); };
  return { manager, sockets, statuses, messages, retries, feed, socket, status, tick, observe, warm, admissionsFor,
    advance: (milliseconds: number) => { now += milliseconds; }, time: () => now,
    reject: (value: boolean) => { rejectStatus = value; } };
}

test('telemetry bursts keep exact internal counters and ingest every frame without status admission each frame', async () => {
  const h = harness();
  try {
    await h.warm();
    const initialCount = h.feed().transportMessages!; const initialPublishedCount = h.status().transportMessages;
    const before = h.admissionsFor(); const messagesBefore = h.messages.length;
    for (let index = 0; index < 200; index++) { h.advance(1); await h.tick(); h.observe(); }
    assert.equal(h.feed().transportMessages, initialCount + 200);
    assert.equal(h.status().transportMessages, initialPublishedCount);
    assert.equal(h.admissionsFor(), before, 'the entire telemetry burst must avoid status-map/history admission');
    assert.ok(h.messages.length >= messagesBefore + 200, 'coalescing cannot drop protocol data ingestion');
    assert.equal(h.feed().heartbeat!.lastObservedAt, h.time());
  } finally { h.manager.stop(); }
});

test('a large message counter is never compared with milliseconds and exact five-second due publication uses latest count', async () => {
  const h = harness();
  try {
    await h.warm(); const before = h.admissionsFor(); const published = h.status().transportMessages;
    h.feed().transportMessages = 1_000_000;
    h.advance(1); await h.tick();
    assert.equal(h.feed().transportMessages, 1_000_001); assert.equal(h.status().transportMessages, published);
    assert.equal(h.admissionsFor(), before);
    h.advance(4_998); await h.tick();
    assert.equal(h.admissionsFor(), before, '4999ms remains inside the coalescing interval');
    h.advance(1); await h.tick();
    assert.ok(h.admissionsFor() > before);
    assert.equal(h.status().transportMessages, h.feed().transportMessages);
    assert.equal(h.status().lastTransportSendAt, BASE + 5_000);
    assert.equal(h.status().lastHeartbeatAt, BASE + 5_000);
  } finally { h.manager.stop(); }
});

test('timestamp-only due updates publish latest counter from the already-owned feed without pending status cache', async () => {
  const h = harness();
  try {
    await h.warm(); const before = h.admissionsFor();
    h.advance(1); await h.tick(); const latestCount = h.feed().transportMessages;
    assert.notEqual(h.status().transportMessages, latestCount);
    h.advance(4_999); h.observe();
    assert.ok(h.admissionsFor() > before); assert.equal(h.status().transportMessages, latestCount);
    assert.equal(h.status().lastObservedAt, h.time());
    assert.ok(h.manager.retainedDiagnostics().logicalComponents.managerStatuses > 0);
  } finally { h.manager.stop(); }
});

test('counter resets and regressing freshness timestamps publish immediately', async () => {
  const h = harness();
  try {
    await h.warm(); const before = h.admissionsFor(); assert.ok(Number(h.status().transportMessages) > 1);
    h.feed().transportMessages = 0; h.advance(1); await h.tick();
    assert.equal(h.status().transportMessages, 1); assert.ok(h.admissionsFor() > before);
    const afterReset = h.admissionsFor(); h.advance(-2); h.observe();
    assert.ok(h.admissionsFor() > afterReset); assert.equal(h.status().lastObservedAt, BASE - 1);
  } finally { h.manager.stop(); }
});

test('ACK source, error, reconnect attempt and recovery transitions bypass telemetry coalescing', async () => {
  const h = harness();
  try {
    await h.warm();
    const binance = 'binance-markPrice'; const beforeAck = h.admissionsFor(binance);
    h.advance(1); h.socket(binance).signal('ping');
    assert.ok(h.admissionsFor(binance) > beforeAck); assert.equal(h.status(binance).heartbeatAcked, true);
    assert.equal(h.status(binance).heartbeatAckSource, 'protocol-ping');
    const afterPing = h.admissionsFor(binance); h.advance(1); h.socket(binance).signal('pong');
    assert.ok(h.admissionsFor(binance) > afterPing); assert.equal(h.status(binance).heartbeatAckSource, 'protocol-pong');
    const beforeError = h.admissionsFor(); const generation = h.feed().generation!;
    h.socket().onError?.(new Error('checksum/gap fixture failure'));
    assert.ok(h.admissionsFor() > beforeError); assert.equal(h.status().state, 'backoff');
    assert.equal(h.status().attempt, 1); assert.match(String(h.status().lastError), /checksum\/gap fixture failure/);
    const retry = h.feed().retry;
    assert.ok(retry && typeof retry === 'object' && 'fn' in retry && typeof retry.fn === 'function');
    await retry.fn();
    assert.equal(h.status().state, 'live'); assert.equal(h.status().attempt, 0);
    assert.equal(h.status().lastError, null); assert.ok(h.feed().generation! > generation);
    assert.equal(h.status().transportMessages, h.feed().transportMessages);
  } finally { h.manager.stop(); }
});

test('heartbeat timeout and selected feed generation/active transitions remain immediate', async () => {
  const h = harness();
  try {
    await h.warm(); const before = h.admissionsFor();
    h.advance(60_001); await h.tick();
    assert.ok(h.admissionsFor() > before); assert.equal(h.status().state, 'backoff');
    assert.match(String(h.status().lastError), /heartbeat-timeout/);
    await h.manager.start({ coin: 'ETH', binanceSymbol: 'ETHUSDT' });
    assert.ok(h.socket().sent.some(frame => frame.includes('"coin":"ETH"'))); assert.equal(h.status().active, true); assert.equal(h.status().state, 'live');
    assert.ok(h.status().generation !== undefined); assert.equal(h.status().lastError, null);
    assert.ok(h.statuses.some(status => status.id === ID && status.state === 'stopped' && status.active === false),
      'retiring the previous selected feed publishes its active:false transition immediately');
    const beforeStop = h.admissionsFor(); h.manager.stop();
    assert.equal(h.status().state, 'stopped'); assert.equal(h.status().active, false); assert.ok(h.admissionsFor() > beforeStop);
  } finally { h.manager.stop(); }
});

test('due telemetry still uses existing admission rejection and immediate fail-closed recovery', async () => {
  const h = harness();
  try {
    await h.warm(); const before = h.admissionsFor();
    h.reject(true); h.advance(1); await h.tick();
    assert.equal(h.admissionsFor(), before, 'suppressed telemetry allocates no status-map candidate');
    h.advance(4_999); h.observe();
    assert.ok(h.admissionsFor() > before); assert.equal(h.status().state, 'unavailable');
    assert.ok(h.status().stale === true);
    assert.ok(h.statuses.some(status => status.id === ID && status.lastError === 'retained-data admission rejected'));
    h.reject(false); h.advance(1); h.observe();
    assert.equal(h.status().state, 'live'); assert.equal(h.status().lastError, null);
  } finally { h.manager.stop(); }
});
