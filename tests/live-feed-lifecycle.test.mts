import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { LiveFeedManager, type LiveFeedSocket } from '../src/server/live-feeds.mts';
import { LiveFeedOperationScope, retireLiveFeedSocket, waitForLiveFeedSocketOpen } from '../src/server/live-feed-transport.mts';

async function until(predicate: () => boolean): Promise<void> {
  for (let turn = 0; turn < 100; turn++) {
    if (predicate()) return;
    await new Promise<void>(resolve => setImmediate(resolve));
  }
  assert.ok(predicate(), 'fixture reached the awaited lifecycle stage');
}

test('elapsed opening deadline terminates a still-active handshake and cleans one-time listeners', { timeout: 10_000 }, async () => {
  let terminated = 0;
  const socket = Object.assign(new EventEmitter(), { terminate: () => { terminated++; socket.emit('close'); } });
  const opened = waitForLiveFeedSocketOpen(socket, 25);
  // Continuing transport activity must not reset this elapsed deadline.
  const traffic = setInterval(() => socket.emit('data', 'partial header'), 2);
  try {
    await assert.rejects(opened, { code: 'LIVE_FEED_HANDSHAKE_TIMEOUT' });
    assert.equal(terminated, 1);
    for (const event of ['open', 'error', 'close']) assert.equal(socket.listenerCount(event), 0);
  } finally { clearInterval(traffic); retireLiveFeedSocket(socket); }
});

test('opened sockets cancel their opening deadline and release the error guard on native close', { timeout: 10_000 }, async () => {
  let terminated = 0;
  const socket = Object.assign(new EventEmitter(), { terminate: () => { terminated++; socket.emit('close'); } });
  const opened = waitForLiveFeedSocketOpen(socket, 25);
  socket.emit('open'); await opened;
  await new Promise<void>(resolve => setTimeout(resolve, 40));
  assert.equal(terminated, 0);
  retireLiveFeedSocket(socket);
  assert.equal(terminated, 1);
  for (const event of ['open', 'error', 'close']) assert.equal(socket.listenerCount(event), 0);
});

test('retirement uses native termination with a close fallback for injected transports', () => {
  const calls: string[] = [];
  retireLiveFeedSocket({ close: () => calls.push('close'), terminate: () => calls.push('terminate') });
  retireLiveFeedSocket({ close: () => calls.push('fallback') });
  assert.deepEqual(calls, ['terminate', 'fallback']);
});

test('configuration cancellation settles waits, cancels pacing timers, and disposes late transport values', async () => {
  const scope = new LiveFeedOperationScope(); let finish: (value: LiveFeedSocket) => void = () => assert.fail('missing fixture completion');
  let closed = 0;
  const operation = scope.wait(new Promise<LiveFeedSocket>(resolve => { finish = resolve; }), { onLateValue: retireLiveFeedSocket });
  const delay = scope.delay(60_000);
  assert.equal(scope.pendingCallbacks.length, 2);
  assert.equal(scope.pendingTimers.length, 1);
  const cancelled = Promise.all([assert.rejects(operation, /configuration retired/), assert.rejects(delay, /configuration retired/)]);
  scope.cancel(); scope.cancel(); await cancelled;
  assert.equal(scope.pendingCallbacks.length, 0);
  assert.equal(scope.pendingTimers.length, 0);
  finish({ close: () => { closed++; } }); await Promise.resolve();
  assert.equal(closed, 1);
});

test('stop settles an eight-venue start waiting on socket opens and releases all connection ownership', { timeout: 10_000 }, async () => {
  const sockets: (LiveFeedSocket & { closed: boolean })[] = [];
  const manager = new LiveFeedManager({ networkEnabled: true, oiPollMs: 0,
    transportFactory: () => {
      const socket = { closed: false, open: () => new Promise<void>(() => {}), send: () => {}, close() { this.closed = true; } };
      sockets.push(socket); return socket;
    }, schedule: () => 1, cancel: () => {},
  });
  const start = manager.start({ selectedOrderbookVenues: ['hyperliquid', 'binance', 'bybit', 'okx', 'coinbase', 'bitget', 'gateio', 'kraken'],
    bybitEnabled: true, bybitSymbol: 'BTCUSDT', okxEnabled: true, okxSymbol: 'BTC-USDT-SWAP', coinbaseEnabled: true, coinbaseSymbol: 'BTC-USD',
    bitgetEnabled: true, bitgetSymbol: 'BTCUSDT', gateioEnabled: true, gateioSymbol: 'BTC_USDT', krakenEnabled: true, krakenSymbol: 'BTC/USD', referenceBackfill: false });
  try {
    await until(() => manager.feeds.size === sockets.length && sockets.length >= 13);
    const selected = [...manager.specs.values()].filter(spec => spec.publicDepth || spec.channel === 'depth' || spec.channel === 'l2Book').map(spec => spec.venue);
    assert.deepEqual([...new Set(selected)].sort(), ['binance', 'bitget', 'bybit', 'coinbase', 'gateio', 'hyperliquid', 'kraken', 'okx']);
    manager.stop(); await start;
    assert.equal(manager.feeds.size, 0);
    assert.ok(sockets.every(socket => socket.closed));
    assert.ok(Object.values(manager.transportBudget.snapshot()).every(venue => venue.connections === 0));
  } finally { manager.stop(); }
});

test('stop releases startup metadata waits and late metadata cannot publish into a retired generation', { timeout: 10_000 }, async () => {
  const completes: ((value: unknown) => void)[] = [], events: unknown[] = [];
  const manager = new LiveFeedManager({ networkEnabled: true, oiPollMs: 0, transportFactory: () => assert.fail('metadata was never accepted'),
    restTransport: { request: () => new Promise<unknown>(resolve => completes.push(resolve)) },
    onMessage: event => { events.push(event); }, schedule: () => 1, cancel: () => {},
  });
  const start = manager.start({ referenceBackfill: false });
  await until(() => completes.length === 2);
  manager.stop(); await start;
  for (const complete of completes) complete({ universe: [], symbols: [] });
  await Promise.resolve(); await Promise.resolve();
  assert.equal(events.length, 0);
  assert.equal(manager.feeds.size, 0);
});

test('replacement starts close late factory transports without consuming replacement quota', { timeout: 10_000 }, async () => {
  let deferred = true, lateClosed = 0;
  const completes: ((value: LiveFeedSocket) => void)[] = [];
  const manager = new LiveFeedManager({ networkEnabled: true, oiPollMs: 0,
    transportFactory: () => deferred ? new Promise<LiveFeedSocket>(resolve => completes.push(resolve)) : { open: () => {}, send: () => {}, close: () => {} },
    schedule: () => 1, cancel: () => {},
  });
  const oldStart = manager.start({ referenceBackfill: false });
  try {
    await until(() => completes.length > 0);
    deferred = false;
    await manager.start({ selectedOrderbookVenues: ['hyperliquid'], referenceBackfill: false });
    await oldStart;
    const budget = manager.transportBudget.snapshot(), current = [...manager.feeds.values()];
    for (const complete of completes) complete({ close: () => { lateClosed++; } });
    await Promise.resolve(); await Promise.resolve();
    assert.equal(lateClosed, completes.length);
    assert.deepEqual(manager.transportBudget.snapshot(), budget);
    assert.deepEqual([...manager.feeds.values()], current);
  } finally { manager.stop(); }
});
