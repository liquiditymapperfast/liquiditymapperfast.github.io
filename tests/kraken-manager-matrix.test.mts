import { defined, fields, list, numeric, textValue } from './server-test-helpers.mts';
import type { LiveFeedTransportOptions, LiveFeedSocket, LiveFeedEvent, LiveFeedStatusEvent } from '../src/server/live-feeds.mts';
import type { ExchangeRestRequest } from '../src/server/rest-transport.mts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { LiveFeedManager } from '../src/server/live-feeds.mts';
import {
  buildKrakenRequest,
  buildKrakenSubscription,
  createKrakenDepthSession,
  applyKrakenDepthSessionMessage,
  krakenBookChecksum,
  normalizeKrakenAssetPairs,
  normalizeKrakenDepth,
  VENUE_TRANSPORT_POLICIES,
} from '../src/adapters/index.mts';

class FakeSocket {
  declare spec:LiveFeedTransportOptions; declare sent:string[]; declare closed:boolean; declare opened?:boolean;
  declare onMessage:((raw:unknown)=>void)|undefined; declare onClose:((reason:unknown)=>void)|undefined; declare onError:((error:unknown)=>void)|undefined;
  constructor(spec:LiveFeedTransportOptions) { this.spec = spec; this.sent = []; this.closed = false; this.onMessage = undefined; this.onClose = undefined; }
  async open() { this.opened = true; }
  send(value:string) { this.sent.push(value); }
  close() { this.closed = true; }
  emit(value:unknown) { this.onMessage?.(value); }
  closeWith(reason = 'closed') { this.closed = true; this.onClose?.(reason); }
}

function transport() {
  const sockets:FakeSocket[] = [];
  return { sockets, factory: async (spec:LiveFeedTransportOptions) => { const socket = new FakeSocket(spec); sockets.push(socket); return socket; } };
}

function policies() {
  return Object.fromEntries(Object.entries(VENUE_TRANSPORT_POLICIES).map(([venue, policy]) => [venue, { ...policy, subscribeIntervalMs: 0, heartbeatIntervalMs: 60_000, heartbeatTimeoutMs: 60_000 }]));
}

function restTransport() {
  const requests:ExchangeRestRequest[] = [];
  return {
    requests,
    request: async (request:ExchangeRestRequest) => {
      requests.push(request);
      if (request.url.includes('/AssetPairs')) return { error: [], result: { XBTZUSD: { wsname: 'XBT/USD', base: 'XXBT', quote: 'ZUSD', pair_decimals: 1, lot_decimals: 5, status: 'online' } } };
      if (request.url.includes('/exchangeInfo')) return { symbols: [] };
      if ((typeof request.body === 'string' && request.body.includes('metaAndAssetCtxs'))) return [{ universe: [] }, []];
      return {};
    },
  };
}

function levels() {
  return {
    bids: [{ price: '100.00', qty: '2.00000000' }, { price: '99.50', qty: '1.00000000' }],
    asks: [{ price: '101.00', qty: '3.00000000' }, { price: '101.50', qty: '1.00000000' }],
  };
}

function wideLevels() {
  return {
    bids: Array.from({ length: 11 }, (_, index) => ({ price: (100 - index * 0.5).toFixed(2), qty: '1.00000000' })),
    asks: Array.from({ length: 11 }, (_, index) => ({ price: (101 + index * 0.5).toFixed(2), qty: '1.00000000' })),
  };
}

function frame(type: string, current = levels(), symbol = 'XBT/USD') {
  return { channel: 'book', type, data: [{ symbol, ...current, checksum: krakenBookChecksum(current), timestamp: '2026-09-20T00:00:00.000000Z' }] };
}

function subscriptionAck(symbol = 'XBT/USD') {
  return { method: 'subscribe', result: { channel: 'book', symbol, depth: 100, snapshot: true }, success: true };
}

test('Kraken descriptors, metadata, and the documented CRC32 example are exact', () => {
  assert.equal(buildKrakenRequest('assetPairs').url, 'https://api.kraken.com/0/public/AssetPairs');
  assert.match(buildKrakenRequest('depth', { symbol: 'XBT/USD', count: 100 }).url, /\/Depth\?pair=XBT%2FUSD&count=100$/);
  const subscription = buildKrakenSubscription('depth', { symbol: 'XBT/USD', depth: 100 });
  assert.deepEqual(subscription, { url: 'wss://ws.kraken.com/v2', method: 'subscribe', channel: 'book', symbol: 'BTC/USD', depth: 100, snapshot: true, args: ['BTC/USD'], topic: 'book:BTC/USD' });
  assert.equal(krakenBookChecksum({
    asks: [['45285.2', '0.00100000'], ['45286.4', '1.54571953'], ['45286.6', '1.54571109'], ['45289.6', '1.54560911'], ['45290.2', '0.15890660'], ['45291.8', '1.54553491'], ['45294.7', '0.04454749'], ['45296.1', '0.35380000'], ['45297.5', '0.09945542'], ['45299.5', '0.18772827']],
    bids: [['45283.5', '0.10000000'], ['45283.4', '1.54582015'], ['45282.1', '0.10000000'], ['45281.0', '0.10000000'], ['45280.3', '1.54592586'], ['45279.0', '0.07990000'], ['45277.6', '0.03310103'], ['45277.5', '0.30000000'], ['45277.3', '1.54602737'], ['45276.6', '0.15445238']],
  }), 3310070434);
  const metadata = normalizeKrakenAssetPairs({ error: [], result: { XBTZUSD: { wsname: 'XBT/USD', base: 'XXBT', quote: 'ZUSD', pair_decimals: 1, lot_decimals: 5, status: 'online' } } }, { receivedAt: 1_700_000_000_000 });
  assert.equal(metadata.sourceTimestamp, null);
  assert.equal(metadata.receivedAt, 1_700_000_000_000);
  assert.deepEqual(metadata.assets[0], { instrumentId: 'kraken:XBT/USD', venue: 'kraken', nativeSymbol: 'XBT/USD', symbol: 'XBT/USD', base: 'XXBT', quote: 'ZUSD', marketType: 'spot', tickSize: 0.1, quantityUnit: 'base', isDelisted: false, status: 'online', lotSize: 0.00001, metadataSource: 'kraken-asset-pairs' });
});

test('Kraken session verifies snapshot/update CRC32, filters symbols, and fails closed on a mismatch', () => {
  const initial = frame('snapshot');
  const snapshot = normalizeKrakenDepth(initial, { symbol: 'XBT/USD' });
  const session = createKrakenDepthSession({ topic: 'book:XBT/USD', instrumentId: 'kraken:XBT/USD', sessionToken: 'kraken-depth:1', depth: 100 });
  const acceptedSnapshot = applyKrakenDepthSessionMessage(session, { topic: 'book:XBT/USD', sessionToken: 'kraken-depth:1', update: snapshot });
  assert.equal(acceptedSnapshot.accepted, true);
  const next = levels(); next.bids[0] = { price: '100.00', qty: '4.00000000' }; next.asks[1] = { price: '101.50', qty: '0' };
  const normalizedUpdate = normalizeKrakenDepth(frame('update', next), { symbol: 'XBT/USD' });
  assert.equal(normalizedUpdate.continuity, 'checksum-pending');
  const acceptedUpdate = applyKrakenDepthSessionMessage(acceptedSnapshot.session, { topic: 'book:XBT/USD', sessionToken: 'kraken-depth:1', update: normalizedUpdate });
  assert.equal(acceptedUpdate.accepted, true);
  assert.equal(defined(acceptedUpdate.session.book).continuity, 'checksum-verified');
  assert.equal(defined(acceptedUpdate.session.book).bids[0].amount, 4);
  assert.equal(defined(acceptedUpdate.session.book).asks.some(row => row.price === 101.5), false);
  const malformed = normalizeKrakenDepth(frame('update', next), { symbol: 'XBT/USD' }); malformed.checksum += 1;
  const rejected = applyKrakenDepthSessionMessage(acceptedUpdate.session, { topic: 'book:XBT/USD', sessionToken: 'kraken-depth:1', update: malformed });
  assert.equal(rejected.accepted, false);
  assert.equal(rejected.reason, 'resync-required');
  assert.equal(rejected.session.invalidated, true);
});

test('Kraken session prunes local books to the subscribed depth before checksum verification', () => {
  const initial = wideLevels();
  const snapshot = normalizeKrakenDepth(frame('snapshot', initial), { symbol: 'XBT/USD' });
  const session = createKrakenDepthSession({ topic: 'book:XBT/USD', instrumentId: 'kraken:XBT/USD', sessionToken: 'kraken-depth:depth-10', depth: 10 });
  const acceptedSnapshot = applyKrakenDepthSessionMessage(session, { topic: 'book:XBT/USD', sessionToken: 'kraken-depth:depth-10', update: snapshot });
  assert.equal(acceptedSnapshot.accepted, true);
  assert.equal(acceptedSnapshot.session.bids.size, 10);
  assert.equal(acceptedSnapshot.session.asks.size, 10);
  const next = { bids: [{ price: '100.25', qty: '1.00000000' }], asks: [] };
  const nextBook = { bids: [{ price: '100.25', qty: '1.00000000' }, ...initial.bids], asks: initial.asks };
  const update = normalizeKrakenDepth({ channel: 'book', type: 'update', data: [{ symbol: 'XBT/USD', ...next, checksum: krakenBookChecksum(nextBook), timestamp: '2026-09-20T00:00:00.000000Z' }] }, { symbol: 'XBT/USD' });
  const acceptedUpdate = applyKrakenDepthSessionMessage(acceptedSnapshot.session, { topic: 'book:XBT/USD', sessionToken: 'kraken-depth:depth-10', update });
  assert.equal(acceptedUpdate.accepted, true);
  assert.equal(acceptedUpdate.session.bids.size, 10);
  assert.equal(acceptedUpdate.session.asks.size, 10);
  assert.equal(defined(acceptedUpdate.session.book).bids[0].price, 100.25);
});

test('Kraken manager requires matching ACK, routes checksum-verified data, and fences reconnects', async () => {
  const v2frame = (...args: Parameters<typeof frame>) => frame(args[0], args[1], args[2] ?? 'BTC/USD');
  const fake = transport(); const rest = restTransport(); const messages:LiveFeedEvent[] = [];
  const manager = new LiveFeedManager({ networkEnabled: true, transportFactory: fake.factory, restTransport: rest, transportPolicies: policies(), oiPollMs: 0, reconnectBaseMs: 10, schedule: (fn, delay) => { const timer = { fn, delay }; timers.push(timer); return timer; }, cancel: () => {}, onMessage: message => messages.push(message) });
  const timers:{fn:()=>unknown;delay:number}[] = [];
  await manager.start({ selectedOrderbookVenues: ['kraken'], krakenEnabled: true, krakenSymbol: 'XBT/USD' });
  const socket = defined(fake.sockets.find(item => item.spec.id === 'kraken-depth'));
  assert.equal(socket.spec.request.url, 'wss://ws.kraken.com/v2');
  assert.deepEqual(JSON.parse(defined(socket.sent.at(-1))), { method: 'subscribe', params: { channel: 'book', symbol: ['BTC/USD'], depth: 100, snapshot: true } });
  assert.equal(manager.status()['kraken-metadata'].state, 'snapshot');
  socket.emit({ method: 'subscribe', result: { channel: 'book', symbol: 'ETH/USD', depth: 100, snapshot: true }, success: true });
  socket.emit(v2frame('snapshot', levels(), 'ETH/USD'));
  assert.equal(manager.status()['kraken-depth'].subscriptionAcked, false);
  assert.equal(messages.some(item => item.id === 'kraken-depth'), false);
  socket.emit({ method: 'subscribe', result: { channel: 'book', symbol: 'BTC/USD', depth: 100, snapshot: false }, success: true });
  assert.equal(manager.status()['kraken-depth'].subscriptionAcked, false);
  socket.emit(subscriptionAck('BTC/USD'));
  socket.emit(v2frame('snapshot'));
  const updated = levels(); updated.bids[0] = { price: '100.00', qty: '4.00000000' };
  socket.emit(v2frame('update', updated));
  const depthMessages = messages.filter(item => item.id === 'kraken-depth');
  // The session delivers its whole book each time, so the update arrives as a snapshot: the runtime state merges a delta but replaces a snapshot.
  assert.equal(depthMessages.filter(item => item.message.kind === 'depthSnapshot').length, 2);
  assert.equal(defined(depthMessages.filter(item => item.message.kind === 'depthSnapshot').at(-1)).message.checksumVerified, true);
  assert.equal(depthMessages.filter(item => item.message.kind === 'depthDelta').length, 0);
  assert.equal(manager.status()['kraken-depth'].state, 'live');
  const before = depthMessages.length;
  socket.closeWith('lost');
  assert.equal(manager.status()['kraken-depth'].state, 'backoff');
  socket.emit(v2frame('snapshot'));
  await defined(timers.find(timer => timer.delay === 10)).fn();
  const replacement = defined(fake.sockets.filter(item => item.spec.id === 'kraken-depth').at(-1));
  assert.notStrictEqual(replacement, socket);
  replacement.emit(subscriptionAck('BTC/USD'));
  replacement.emit(v2frame('update', updated));
  assert.equal(messages.filter(item => item.id === 'kraken-depth').length, before + 1); // fresh snapshot is required
  replacement.emit(v2frame('snapshot'));
  replacement.emit(v2frame('update', updated));
  assert.equal(messages.filter(item => item.id === 'kraken-depth').length, before + 3);
  manager.stop();
});
