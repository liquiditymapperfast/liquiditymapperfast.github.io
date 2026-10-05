import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeHyperliquidTrades } from '../src/adapters/hyperliquid.mts';
import {
  LiveFeedManager, LIVE_FEED_CALLBACK_SHELL_LOGICAL_BYTES,
  type LiveFeedEvent, type LiveFeedOptions, type LiveFeedSocket,
  type LiveFeedStatusEvent, type LiveFeedTradeBatchEvent,
  type LiveFeedTransportOptions, type LiveNormalizedMessage,
} from '../src/server/live-feeds.mts';
import { ProcessMemoryMonitor } from '../src/server/process-memory.mts';

const BASE = 1_700_000_000_000;
const ID = 'hl-trades';
interface Timer { fn: () => unknown; delay: number; cancelled: boolean }
class Socket implements LiveFeedSocket {
  onMessage?: (value: unknown) => void;
  onClose?: (value: unknown) => void;
  onError?: (value: unknown) => void;
  sent: string[] = []; closed = false;
  constructor(readonly spec: LiveFeedTransportOptions) {}
  open() {}
  send(value: string) { this.sent.push(value); }
  close() { this.closed = true; }
  emit(value: unknown) { this.onMessage?.(value); }
  disconnect() { this.onClose?.('fixture disconnect'); }
}
function tradeFrame(count = 3, coin = 'BTC', hash?: string) {
  return { channel: 'trades', data: Array.from({ length: count }, (_, index) => ({
    coin, side: index % 2 ? 'A' : 'B', px: String(100 + index),
    sz: String((index + 1) / 10), time: BASE + index, tid: index + 10,
    ...(hash === undefined ? {} : { hash: `${hash}:${index}` }),
  })) };
}
function harness(options: Pick<LiveFeedOptions, 'onTradeBatch' | 'onMessage' | 'reserveTransientMemory'> = {}) {
  let now = BASE;
  const sockets: Socket[] = [], messages: LiveFeedEvent[] = [], statuses: LiveFeedStatusEvent[] = [], retries: Timer[] = [];
  const timer = (fn: () => unknown, delay: number): Timer => ({ fn, delay, cancelled: false });
  const cancel = (value: unknown) => { if (value && typeof value === 'object' && 'cancelled' in value) value.cancelled = true; };
  const manager = new LiveFeedManager({
    networkEnabled: true, restTransport: null, oiPollMs: 0,
    now: () => now, transportNow: () => now,
    transportFactory: spec => { const socket = new Socket(spec); sockets.push(socket); return socket; },
    transportPolicies: { hyperliquid: { subscribeIntervalMs: 0 }, binance: { subscribeIntervalMs: 0 } },
    schedule: (fn, delay) => { const value = timer(fn, delay); retries.push(value); return value; }, cancel,
    heartbeatSchedule: timer, heartbeatCancel: cancel,
    onMessage: event => { messages.push(event); return options.onMessage?.(event); },
    onTradeBatch: options.onTradeBatch,
    reserveTransientMemory: options.reserveTransientMemory,
    onStatus: event => { statuses.push(event); },
    retainedAdmission: (_candidate, _context, commit) => { commit(); return { admitted: true }; },
  });
  const feed = () => { const value = manager.feeds.get(ID); assert.ok(value); return value; };
  const socket = () => { const value = sockets.filter(item => item.spec.id === ID).at(-1); assert.ok(value); return value; };
  const ack = () => socket().emit({ channel: 'subscriptionResponse', data: { method: 'subscribe', subscription: feed().spec.request.subscription } });
  return { manager, sockets, messages, statuses, retries, feed, socket, ack,
    status: () => manager.status()[ID], advance: (milliseconds: number) => { now += milliseconds; }, time: () => now };
}

test('one validated native Hyperliquid frame calls one synchronous batch with the exact ordered decoded rows', async () => {
  const batches: LiveFeedTradeBatchEvent[] = [];
  let batchAdmissions = 0, fallbackAdmissions = 0, inEmit = false;
  const h = harness({ onTradeBatch: event => { assert.equal(inEmit, true); batchAdmissions++; batches.push(event); return true; } });
  const fallback = harness({ onMessage: () => { fallbackAdmissions++; } });
  try {
    await h.manager.start(); await fallback.manager.start(); h.ack(); fallback.ack();
    const decodedRows: { value: LiveNormalizedMessage[] | null } = { value: null };
    const decode = h.feed().spec.decode;
    h.feed().spec.decode = raw => { const decoded = decode(raw); if (Array.isArray(decoded)) decodedRows.value = decoded; return decoded; };
    const frame = tradeFrame(32);
    const sentBefore = h.feed().transportMessages;
    inEmit = true; h.socket().emit(Buffer.from(JSON.stringify(frame))); inEmit = false;
    fallback.socket().emit(Buffer.from(JSON.stringify(frame)));
    assert.equal(batchAdmissions, 1); assert.equal(fallbackAdmissions, 32);
    assert.equal(batches.length, 1); assert.equal(h.messages.length, 0);
    const batch = batches[0]!;
    assert.equal(batch.feedId, ID); assert.equal(batch.venue, 'hyperliquid');
    assert.equal(batch.messages, decodedRows.value);
    assert.deepEqual(batch.messages, normalizeHyperliquidTrades(frame, { coin: 'BTC', receivedAt: BASE }));
    assert.deepEqual(batch.messages, fallback.messages.map(event => event.message));
    assert.equal(batch.messages.length, 32); assert.equal(fallback.messages.length, 32);
    assert.ok(fallback.messages.every(event => event.id === ID && event.venue === 'hyperliquid' && event.receivedAt === BASE && !event.retainedMutation));
    assert.equal(h.feed().transportMessages, sentBefore);
    assert.equal(h.feed().transportMessages, fallback.feed().transportMessages);
    assert.equal(h.feed().subscriptionAcked, true);
    assert.equal(h.feed().heartbeat?.lastObservedAt, BASE);
  } finally { h.manager.stop(); fallback.manager.stop(); }
});

test('single native trades keep per-row delivery and void batch acceptance publishes success once', async () => {
  let batches = 0;
  const h = harness({ onTradeBatch: () => { batches++; } });
  try {
    await h.manager.start(); h.ack();
    h.socket().emit(tradeFrame(1)); assert.equal(batches, 0); assert.equal(h.messages.length, 1);
    assert.deepEqual(h.messages[0]?.message, normalizeHyperliquidTrades(tradeFrame(1), { receivedAt: BASE })[0]);
    h.advance(6_000);
    const start = h.statuses.length;
    h.socket().emit(tradeFrame(3));
    assert.equal(batches, 1); assert.equal(h.messages.length, 1);
    assert.equal(h.status().state, 'live'); assert.equal(h.status().lastSuccess, h.time());
    assert.equal(h.statuses.slice(start).filter(event => event.id === ID && event.lastSuccess === h.time()).length, 1);
  } finally { h.manager.stop(); }
});

test('nontrade and mixed decoded arrays preserve per-row price, OI, candle and depth processing', async () => {
  let batches = 0;
  const h = harness({ onTradeBatch: () => { batches++; return true; } });
  try {
    await h.manager.start(); h.ack();
    const trade = normalizeHyperliquidTrades(tradeFrame(1), { receivedAt: BASE })[0]!;
    const instrumentId = 'hyperliquid:BTC-PERP';
    const price: LiveNormalizedMessage = { kind: 'price', instrumentId, price: 100, receivedAt: BASE };
    const oi: LiveNormalizedMessage = { kind: 'openInterest', instrumentId, base: 2, receivedAt: BASE };
    const candle: LiveNormalizedMessage = { kind: 'candle', instrumentId, interval: '1m', start: BASE, end: BASE + 60_000, open: 100, high: 101, low: 99, close: 100, volume: 2 };
    const snapshot: LiveNormalizedMessage = { kind: 'depthSnapshot', instrumentId, sequence: 1, complete: true, bids: [], asks: [] };
    const delta: LiveNormalizedMessage = { kind: 'depthDelta', instrumentId, previousSequence: 1, sequence: 2, bids: [], asks: [] };
    // This injected decoder tests the manager's array discriminator after the
    // real selected native envelope has passed validation. Native adapters and
    // sequence/session reducers are otherwise unchanged.
    for (const rows of [[price, price], [oi, oi], [candle, candle], [snapshot, snapshot], [delta, delta], [trade, price], [trade]]) {
      h.feed().spec.decode = () => rows;
      const before = h.messages.length;
      h.socket().emit(tradeFrame(2));
      assert.equal(batches, 0);
      assert.deepEqual(h.messages.slice(before).map(event => event.message), rows);
    }
  } finally { h.manager.stop(); }
});

test('foreign, empty, wrong-channel and malformed native trade frames never reach the batch consumer', async () => {
  let batches = 0, decodes = 0;
  const h = harness({ onTradeBatch: () => { batches++; return true; } });
  try {
    await h.manager.start();
    h.socket().emit({ channel: 'subscriptionResponse', data: { method: 'subscribe', subscription: { type: 'trades', coin: 'ETH' } } });
    assert.equal(h.feed().subscriptionAcked, false);
    h.ack(); assert.equal(h.feed().subscriptionAcked, true);
    const decode = h.feed().spec.decode;
    h.feed().spec.decode = raw => { decodes++; return decode(raw); };
    h.socket().emit(tradeFrame(2, 'ETH'));
    h.socket().emit({ ...tradeFrame(2), channel: 'activeAssetCtx' });
    h.socket().emit(tradeFrame(0));
    const mixedCoin = tradeFrame(2); mixedCoin.data[1]!.coin = 'ETH'; h.socket().emit(mixedCoin);
    assert.equal(decodes, 0); assert.equal(batches, 0); assert.equal(h.messages.length, 0);
    const malformed = tradeFrame(2); malformed.data[1]!.px = '0';
    h.advance(6_000); h.socket().emit(malformed);
    assert.equal(decodes, 1); assert.equal(batches, 0); assert.equal(h.messages.length, 0);
    assert.equal(h.feed().retired, true); assert.equal(h.status().state, 'backoff');
    assert.equal(h.status().lastSuccess, BASE);
    assert.match(String(h.status().lastError), /Invalid Hyperliquid trade values/);
  } finally { h.manager.stop(); }
});

test('retired and replaced native trade transports cannot batch queued old frames', async () => {
  let batches = 0;
  const h = harness({ onTradeBatch: () => { batches++; return true; } });
  try {
    await h.manager.start(); h.ack(); h.socket().emit(tradeFrame(2)); assert.equal(batches, 1);
    const retiredSocket = h.socket(), retiredFeed = h.feed();
    retiredSocket.disconnect(); assert.equal(retiredFeed.retired, true);
    retiredSocket.emit(tradeFrame(2)); assert.equal(batches, 1);
    const retry = retiredFeed.retry;
    assert.ok(retry && typeof retry === 'object' && 'fn' in retry && typeof retry.fn === 'function');
    await retry.fn();
    assert.notEqual(h.socket(), retiredSocket); assert.notEqual(h.feed().generation, retiredFeed.generation);
    retiredSocket.emit(tradeFrame(2)); assert.equal(batches, 1);
    h.ack(); h.socket().emit(tradeFrame(2)); assert.equal(batches, 2);
  } finally { h.manager.stop(); }
});

test('selected ETH identity and current configuration/feed generations fence native batches', async () => {
  const received: LiveFeedTradeBatchEvent[] = [];
  const h = harness({ onTradeBatch: event => { received.push(event); return true; } });
  try {
    await h.manager.start(); const old = h.socket(); h.ack();
    await h.manager.start({ coin: 'ETH', binanceSymbol: 'ETHUSDT' }); h.ack();
    old.emit(tradeFrame(2)); h.socket().emit(tradeFrame(2)); assert.equal(received.length, 0);
    const configurationGeneration = h.feed().configurationGeneration;
    h.feed().configurationGeneration = (configurationGeneration ?? 0) - 1;
    h.socket().emit(tradeFrame(2, 'ETH')); assert.equal(received.length, 0);
    h.feed().configurationGeneration = configurationGeneration;
    const generation = h.manager.feedGenerations.get(ID); assert.ok(generation !== undefined);
    h.manager.feedGenerations.set(ID, generation + 1);
    h.socket().emit(tradeFrame(2, 'ETH')); assert.equal(received.length, 0);
    h.manager.feedGenerations.set(ID, generation);
    h.socket().emit(tradeFrame(2, 'ETH')); assert.equal(received.length, 1);
    assert.ok(received[0]?.messages.every(message => message.instrumentId === 'hyperliquid:ETH-PERP'));
  } finally { h.manager.stop(); }
});

test('batch callback uses the existing measured shell and retains no decoded trade array or work queue', async () => {
  let delivered = 0;
  const h = harness({ onTradeBatch: event => { delivered += event.messages.length; return true; } });
  const fallback = harness();
  try {
    await h.manager.start(); await fallback.manager.start(); h.ack(); fallback.ack();
    const before = h.manager.retainedDiagnostics();
    const baseline = fallback.manager.retainedDiagnostics();
    assert.equal(before.nativeOwnership.callbacks, baseline.nativeOwnership.callbacks + 1);
    assert.equal(before.nativeOwnership.callbackLogicalBytes, baseline.nativeOwnership.callbackLogicalBytes + LIVE_FEED_CALLBACK_SHELL_LOGICAL_BYTES);
    const ownKeysBefore = Reflect.ownKeys(h.manager), retriesBefore = h.retries.length;
    for (let index = 0; index < 8; index++) h.socket().emit(Buffer.from(JSON.stringify(tradeFrame(64, 'BTC', 'x'.repeat(4_096)))));
    const after = h.manager.retainedDiagnostics();
    assert.equal(delivered, 512); assert.equal(h.messages.length, 0);
    assert.deepEqual(Reflect.ownKeys(h.manager), ownKeysBefore);
    assert.deepEqual(after.logicalComponents, before.logicalComponents);
    assert.equal(after.logicalBytes, before.logicalBytes); assert.equal(after.nativeOwnership.callbacks, before.nativeOwnership.callbacks);
    assert.equal(h.manager.depthBuffers.size, 0); assert.equal(h.retries.length, retriesBefore);
    assert.equal(h.feed().preAckFrames, null); assert.equal(h.manager.activeMessageMemoryReservation, null);
  } finally { h.manager.stop(); fallback.manager.stop(); }
});

test('a synchronous batch consumer that stops its session cannot republish a fresh live status', async () => {
  let callbacks = 0;
  const h = harness({ onTradeBatch: () => { callbacks++; h.manager.stop(); return true; } });
  try {
    await h.manager.start(); h.ack(); h.advance(6_000); const before = h.statuses.length;
    h.socket().emit(tradeFrame(2));
    assert.equal(callbacks, 1); assert.equal(h.manager.running, false);
    assert.equal(h.status().state, 'stopped'); assert.equal(h.status().active, false);
    assert.equal(h.statuses.slice(before).filter(event => event.id === ID && event.lastSuccess === h.time()).length, 0);
  } finally { h.manager.stop(); }
});
