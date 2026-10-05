import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createServer, type Socket } from 'node:net';
import { LiveFeedManager, createWsTransport, type LiveFeedSocket, type LiveFeedStartOptions } from '../src/server/live-feeds.mts';
import type { ExchangeRestRequest } from '../src/server/rest-transport.mts';

function fixture() {
  const requests: ExchangeRestRequest[] = [];
  const sockets: { closed: boolean }[] = [];
  const timers: { id: number; callback: () => unknown; delay: number; cancelled: boolean }[] = [];
  const manager = new LiveFeedManager({
    networkEnabled: true, oiPollMs: 60_000, oiHistoryLimit: 1, now: () => 1_700_000_000_100,
    schedule: (callback, delay) => { const id = timers.length + 1; timers.push({ id, callback, delay, cancelled: false }); return id; },
    cancel: id => { const timer = timers.find(item => item.id === id); if (timer) timer.cancelled = true; },
    transportFactory: async () => {
      const socket: LiveFeedSocket & { closed: boolean } = { closed: false, open: async () => {}, send: () => {}, close() { this.closed = true; } };
      sockets.push(socket); return socket;
    },
    restTransport: { request: async request => {
      requests.push(request);
      if (request.url.includes('/openInterest')) return { symbol: 'BTCUSDT', openInterest: '10', time: 1_700_000_000_000 };
      if (request.url.includes('/openInterestHist')) return [{ symbol: 'BTCUSDT', sumOpenInterest: '10', timestamp: 1_700_000_000_000 }];
      if (request.url.includes('/depth')) return { lastUpdateId: 1, bids: [['100', '1']], asks: [['101', '1']] };
      if (request.url.includes('/klines')) return [];
      if (request.url.includes('/exchangeInfo')) return { symbols: [{ symbol: 'BTCUSDT', baseAsset: 'BTC', quoteAsset: 'USDT', status: 'TRADING', contractType: 'PERPETUAL', filters: [{ filterType: 'LOT_SIZE', stepSize: '0.001' }, { filterType: 'PRICE_FILTER', tickSize: '0.1' }] }] };
      if (request.url.includes('/info')) return typeof request.body === 'string' && request.body.includes('candleSnapshot') ? [] : { universe: [], assetCtxs: [] };
      throw new Error('Unexpected fixture REST request');
    } },
  });
  return { manager, requests, sockets, timers };
}
const warmupRequests = (requests: readonly ExchangeRestRequest[]) => requests.filter(request => request.url.includes('/klines')
  || request.url.includes('/openInterest') || request.url.includes('/openInterestHist')
  || typeof request.body === 'string' && request.body.includes('candleSnapshot'));

test('venue-only start skips reference backfill and awaits no ancillary history while normal OI polling remains scheduled', async t => {
  const { manager, requests, timers } = fixture(); t.after(() => manager.stop());
  await manager.start({ selectedOrderbookVenues: ['hyperliquid', 'binance'], referenceBackfill: false });
  assert.equal(warmupRequests(requests).length, 0);
  assert.ok(requests.some(request => request.url.includes('/exchangeInfo')));
  assert.ok(requests.some(request => request.url.includes('/depth')));
  assert.ok(manager.feeds.size > 0);
  assert.notEqual(manager.status()['binance-openInterest']?.state, 'live');
  const polling = timers.find(timer => timer.delay === 60_000 && !timer.cancelled); assert.ok(polling);
  await polling.callback();
  assert.equal(requests.filter(request => request.url.includes('/fapi/v1/openInterest')).length, 1);
  assert.equal(manager.status()['binance-openInterest']?.state, 'live');
  assert.equal(timers.filter(timer => timer.delay === 60_000 && !timer.cancelled).length, 2);
});

test('default startup still requests both candle histories and initial current and historical open interest', async t => {
  const { manager, requests } = fixture(); t.after(() => manager.stop());
  await manager.start();
  assert.ok(requests.some(request => request.url.includes('/klines')));
  assert.ok(requests.some(request => typeof request.body === 'string' && request.body.includes('candleSnapshot')));
  assert.ok(requests.some(request => request.url.includes('/fapi/v1/openInterest')));
  assert.ok(requests.some(request => request.url.includes('/openInterestHist')));
});

test('invalid backfill choices reject before a running feed generation or transport is mutated', async t => {
  const { manager, requests, sockets } = fixture(); t.after(() => manager.stop());
  await manager.start({ referenceBackfill: false });
  const generation = manager.configurationGeneration, feeds = [...manager.feeds], statuses = manager.status(), count = requests.length;
  for (const value of [null, 'false', 0, {}]) {
    const options: LiveFeedStartOptions = {}; Reflect.set(options, 'referenceBackfill', value);
    await assert.rejects(manager.start(options), /referenceBackfill must be boolean/);
    assert.equal(manager.configurationGeneration, generation); assert.deepEqual([...manager.feeds], feeds);
    assert.deepEqual(manager.status(), statuses); assert.equal(requests.length, count);
    assert.ok(sockets.every(socket => !socket.closed));
  }
});

async function silentPeer() {
  const peers = new Set<Socket>();
  const server = createServer(peer => { peers.add(peer); peer.once('close', () => peers.delete(peer)); });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); assert.ok(address && typeof address === 'object');
  return { url: `ws://127.0.0.1:${address.port}`, close: async () => { for (const peer of peers) peer.destroy(); await new Promise<void>(resolve => server.close(() => resolve())); } };
}

test('production open wait rejects a close without an open/error and releases every one-time listener', async t => {
  const peer = await silentPeer(); t.after(() => peer.close());
  const transport = await createWsTransport({ request: { url: peer.url }, handshakeTimeoutMs: 1_000 });
  transport.on('error', () => {}); t.after(() => transport.socket.terminate());
  assert.ok(transport.socket instanceof EventEmitter);
  const socket = transport.socket;
  const errors = socket.listenerCount('error');
  socket.emit('close', 1006);
  await assert.rejects(transport.open(), /closed before opening/);
  assert.equal(socket.listenerCount('open'), 0); assert.equal(socket.listenerCount('close'), 0);
  assert.equal(socket.listenerCount('error'), errors - 2, 'opening and pre-binding error guards release on close');
});

test('silent production handshakes settle and manager releases failed connection ownership', { timeout: 10_000 }, async t => {
  const peer = await silentPeer(); t.after(() => peer.close());
  const manager = new LiveFeedManager({ networkEnabled: true, oiPollMs: 0,
    transportFactory: spec => createWsTransport({ ...spec, request: { ...spec.request, url: peer.url }, handshakeTimeoutMs: 50 }),
    schedule: () => 1, cancel: () => {},
  });
  t.after(() => manager.stop());
  const statuses = await manager.start({ referenceBackfill: false });
  assert.ok(manager.feeds.size > 0);
  assert.ok([...manager.feeds.values()].every(feed => feed.transportReleased));
  assert.ok(Object.values(manager.transportBudget.snapshot()).every(venue => venue.connections === 0));
  assert.ok([...manager.feeds.keys()].every(id => statuses[id]?.state === 'backoff'));
  assert.ok([...manager.feeds.keys()].every(id => /timed out/.test(String(statuses[id]?.lastError))));
});

test('invalid handshake deadlines reject before creating a socket', async () => {
  for (const handshakeTimeoutMs of [0, -1, Infinity, NaN, 1.5])
    await assert.rejects(createWsTransport({ request: { url: 'ws://127.0.0.1:1' }, handshakeTimeoutMs }), /positive integer/);
});
