import test from 'node:test';
import assert from 'node:assert/strict';
import { LiveFeedManager, type LiveFeedEvent, type LiveFeedSocket, type LiveFeedTransportOptions } from '../src/server/live-feeds.mts';

class Socket implements LiveFeedSocket {
  onMessage?: (raw: unknown) => void;
  onClose?: (reason: unknown) => void;
  onError?: (error: unknown) => void;
  closed = false;
  constructor(readonly options: LiveFeedTransportOptions) {}
  async open() {}
  send(_value: string) {}
  close() { this.closed = true; }
  emit(raw: unknown) { this.onMessage?.(raw); }
}
function deferred() {
  let resolve!: (value: unknown) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<unknown>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const snapshot = (sequence: number) => ({ lastUpdateId: sequence, bids: [['100', '2']], asks: [['101', '1']] });
const delta = (sequence: number, previous = sequence - 1) => ({ stream: 'btcusdt@depth', data: { e: 'depthUpdate', E: 1_700_000_000_100, s: 'BTCUSDT', U: sequence, pu: previous, u: sequence, b: [['100', '3']], a: [] } });
const flush = () => new Promise<void>(resolve => setImmediate(resolve));
function harness(depth: (call: number) => unknown, accept: (event: LiveFeedEvent) => boolean = () => true) {
  const sockets: Socket[] = [];
  const accepted: LiveFeedEvent[] = [];
  const attempted: LiveFeedEvent[] = [];
  const timers = new Map<number, () => unknown>();
  let timerId = 0;
  let depthCalls = 0;
  const manager = new LiveFeedManager({
    networkEnabled: true, oiPollMs: 0,
    now: () => 1_700_000_000_100, transportNow: () => 1_700_000_000_100,
    reconnectBaseMs: 100, reconnectMaxMs: 250,
    transportPolicies: { hyperliquid: { subscribeIntervalMs: 0 }, binance: { subscribeIntervalMs: 0 } },
    heartbeatSchedule: () => null, heartbeatCancel: () => {},
    schedule: fn => { timers.set(++timerId, fn); return timerId; },
    cancel: timer => { if (typeof timer === 'number') timers.delete(timer); },
    transportFactory: async options => { const socket = new Socket(options); sockets.push(socket); return socket; },
    retainedAdmission: (_candidate, _context, commit) => { commit(); return { admitted: true }; },
    onMessage: event => {
      attempted.push(event);
      if (!accept(event)) return false;
      event.retainedMutation?.commit();
      accepted.push(event);
      return true;
    },
    restTransport: { request: request => {
      if (request.url.includes('/depth')) return depth(++depthCalls);
      if (request.url.includes('/exchangeInfo')) return { serverTime: 1_700_000_000_000, symbols: [{
        symbol: 'BTCUSDT', pair: 'BTCUSDT', contractType: 'PERPETUAL', status: 'TRADING',
        baseAsset: 'BTC', quoteAsset: 'USDT', marginAsset: 'USDT',
        filters: [{ filterType: 'PRICE_FILTER', tickSize: '0.1' }, { filterType: 'LOT_SIZE', stepSize: '0.001' }],
      }] };
      if (request.url.includes('/klines')) return [];
      if (typeof request.body === 'string' && request.body.includes('metaAndAssetCtxs')) return [{ universe: [] }, []];
      return { openInterest: '1', time: 1_700_000_000_000 };
    } },
  });
  const depthSockets = () => sockets.filter(socket => socket.options.id === 'binance-depth');
  const currentSocket = () => { const socket = depthSockets().at(-1); assert.ok(socket); return socket; };
  const runRetry = async () => {
    assert.equal(timers.size, 1, 'only one recovery timer owns this feed');
    const entry = timers.entries().next().value;
    assert.ok(entry);
    timers.delete(entry[0]);
    await entry[1]();
    await flush();
  };
  return { manager, sockets, accepted, attempted, timers, depthSockets, currentSocket, runRetry, depthCalls: () => depthCalls };
}

test('buffered contiguous delta admission refusal is not reported as an exchange bridge gap', async () => {
  const initial = deferred();
  const h = harness(call => call === 1 ? initial.promise : snapshot(200), event => event.message.kind !== 'depthDelta');
  try {
    const started = h.manager.start({ selectedOrderbookVenues: ['binance'] });
    await flush();
    h.currentSocket().emit(delta(101));
    initial.resolve(snapshot(100));
    await started;
    const invalidations = h.accepted.filter(event => event.message.invalidated === true);
    assert.ok(invalidations.length > 0);
    assert.ok(invalidations.every(event => !String(event.message.invalidReason).includes('bridge gap')));
    assert.match(String(h.manager.status()['binance-depth'].lastError), /rejected Binance depth bridge admission/);
    assert.equal(h.manager.bookSequences.has('binance:BTCUSDT'), false);
    assert.equal(h.currentSocket().closed, true);
    assert.equal(h.timers.size, 1);
    assert.equal(h.manager.status()['binance-depth'].state, 'unavailable');
    assert.equal(h.manager.status()['binance-depth'].nextRetryAt, 1_700_000_000_200);
    assert.equal(h.attempted.filter(event => event.message.kind === 'depthDelta').length, 1);
  } finally { h.manager.stop(); }
});

test('a genuine initial buffered sequence gap still invalidates and retries without partial restoration', async () => {
  const initial = deferred();
  const h = harness(call => call === 1 ? initial.promise : snapshot(200));
  try {
    const started = h.manager.start({ selectedOrderbookVenues: ['binance'] });
    await flush();
    h.currentSocket().emit(delta(105, 90));
    initial.resolve(snapshot(100));
    await started;
    assert.match(String(h.manager.status()['binance-depth'].lastError), /depth bridge gap/);
    const invalidation = h.accepted.filter(event => event.message.invalidated === true).at(-1)?.message;
    assert.ok(invalidation);
    assert.equal(invalidation.complete, false);
    assert.equal(invalidation.resyncRequired, true);
    assert.equal(h.accepted.filter(event => event.message.kind === 'depthDelta').length, 0);
    assert.equal(h.timers.size, 1);
    await h.runRetry();
    h.currentSocket().emit(delta(201));
    assert.equal(h.manager.bookSequences.get('binance:BTCUSDT'), 201);
    assert.equal(h.timers.size, 0);
  } finally { h.manager.stop(); }
});

test('failed live resync retires buffered socket and retries one fresh snapshot before accepting deltas', async () => {
  const failed = deferred();
  const h = harness(call => call === 1 ? snapshot(100) : call === 2 ? failed.promise : snapshot(200));
  try {
    await h.manager.start({ selectedOrderbookVenues: ['binance'] });
    const old = h.currentSocket();
    const beforeConnections = h.manager.transportBudget.snapshot().binance.connections;
    old.emit(delta(105, 90));
    old.emit(delta(106, 100));
    assert.equal(h.manager.resyncing.size, 1);
    assert.equal(h.accepted.filter(event => event.message.kind === 'depthDelta').length, 0);
    failed.reject(Object.assign(new Error('snapshot capacity denied'), { retryable: false }));
    await flush(); await flush();
    assert.equal(old.closed, true);
    assert.equal(h.manager.resyncing.size, 0);
    assert.equal(h.manager.depthBuffers.size, 0);
    assert.equal(h.manager.transportBudget.snapshot().binance.connections, beforeConnections - 1);
    assert.equal(h.timers.size, 1);
    assert.match(String(h.manager.status()['binance-depth'].lastError), /snapshot capacity denied/);
    old.emit(delta(107, 100));
    assert.equal(h.manager.depthBuffers.size, 0);
    await h.runRetry();
    assert.equal(h.manager.transportBudget.snapshot().binance.connections, beforeConnections);
    assert.equal(h.depthSockets().filter(socket => !socket.closed).length, 1);
    h.currentSocket().emit(delta(201));
    assert.deepEqual(h.accepted.filter(event => event.message.kind === 'depthDelta').map(event => event.message.sequence), [201]);
    const complete = h.accepted.filter(event => event.message.kind === 'depthSnapshot' && event.message.invalidated !== true).at(-1)?.message;
    assert.equal(complete?.sequence, 200);
    assert.equal(complete?.complete, true);
    assert.equal(h.manager.status()['binance-depth'].subscriptionAcked, true);
    assert.equal(h.timers.size, 0);
  } finally { h.manager.stop(); }
});

test('repeated initial snapshot admission denial retains one timer and no extra transport owner, then recovers', async () => {
  let deny = true;
  const h = harness(call => snapshot(100 + call), event => !(deny && event.message.kind === 'depthSnapshot' && event.message.invalidated !== true));
  try {
    await h.manager.start({ selectedOrderbookVenues: ['binance'] });
    const baselineConnections = h.manager.transportBudget.snapshot().binance.connections;
    for (let attempt = 0; attempt < 3; attempt++) {
      assert.equal(h.depthSockets().filter(socket => !socket.closed).length, 0);
      assert.equal(h.timers.size, 1);
      assert.equal(h.manager.transportBudget.snapshot().binance.connections, baselineConnections);
      assert.equal(h.manager.bookSequences.size, 0);
      await h.runRetry();
    }
    assert.equal(h.manager.resyncing.size, 0);
    deny = false;
    await h.runRetry();
    assert.equal(h.depthSockets().filter(socket => !socket.closed).length, 1);
    assert.equal(h.manager.transportBudget.snapshot().binance.connections, baselineConnections + 1);
    assert.equal(h.timers.size, 0);
    assert.equal(h.manager.bookSequences.get('binance:BTCUSDT'), 105);
    h.currentSocket().emit(delta(106));
    assert.equal(h.manager.bookSequences.get('binance:BTCUSDT'), 106);
  } finally { h.manager.stop(); }
});

test('late failed resync cannot schedule recovery after stop or poison replacement generation', async () => {
  for (const replace of [false, true]) {
    const oldRequest = deferred();
    const h = harness(call => call === 1 ? snapshot(100) : call === 2 ? oldRequest.promise : snapshot(200));
    try {
      await h.manager.start({ selectedOrderbookVenues: ['binance'] });
      const old = h.currentSocket();
      old.emit(delta(105, 90));
      assert.equal(h.manager.resyncing.size, 1);
      if (replace) await h.manager.start({ selectedOrderbookVenues: ['binance'] });
      else h.manager.stop();
      const eventCount = h.accepted.length;
      oldRequest.reject(Object.assign(new Error('obsolete snapshot failure'), { retryable: false }));
      await flush(); await flush();
      assert.equal(h.timers.size, 0);
      assert.equal(h.manager.resyncing.size, 0);
      assert.equal(h.accepted.length, eventCount);
      if (replace) {
        assert.equal(h.manager.bookSequences.get('binance:BTCUSDT'), 200);
        assert.equal(h.currentSocket().closed, false);
        assert.equal(h.manager.status()['binance-depth'].state, 'snapshot');
      } else assert.equal(h.manager.feeds.size, 0);
    } finally { h.manager.stop(); }
  }
});
