import type { RequestDescriptor, SubscriptionDescriptor } from '../src/adapters/common.mts';
import { defined, fields, list, numeric, textValue } from './server-test-helpers.mts';
import type { LiveFeedTransportOptions, LiveFeedSocket, LiveFeedEvent, LiveFeedStatusEvent } from '../src/server/live-feeds.mts';
import type { ExchangeRestRequest } from '../src/server/rest-transport.mts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { LiveFeedManager } from '../src/server/live-feeds.mts';
import {
  AdapterTransportError,
  PHEMEX_PUBLIC_WS_URL,
  PhemexConnector,
  VENUE_TRANSPORT_POLICIES,
  applyPhemexDepthSessionMessage,
  buildPhemexRequest,
  buildPhemexSubscription,
  createPhemexDepthSession,
  normalizePhemexDepth,
  normalizePhemexProducts,
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

function products() {
  return {
    code: 0, msg: '', data: { products: [{
      symbol: 'sBTCUSDT', type: 'Spot', status: 'Listed', baseCurrency: 'BTC', quoteCurrency: 'USDT',
      priceScale: 8, ratioScale: 8, pricePrecision: 2, baseQtyPrecision: 6,
      baseTickSize: '0.000001 BTC', quoteTickSize: '0.01 USDT',
    }] },
  };
}

function frame({ type = 'snapshot', sequence = 100, depth = 30, timestamp = '1789901600877285600', bids = [[8035000000000, 100000000]], asks = [[8036000000000, 200000000]] } = {}) {
  return { book: { bids, asks }, depth, sequence, symbol: 'sBTCUSDT', timestamp, type };
}

test('Phemex descriptors and normalizers preserve scaled spot contracts', () => {
  assert.equal(buildPhemexRequest('products').url, 'https://api.phemex.com/public/products');
  assert.equal(buildPhemexRequest('depth', { symbol: 'sBTCUSDT' }).url, 'https://api.phemex.com/md/orderbook?symbol=sBTCUSDT');
  assert.deepEqual(buildPhemexSubscription('depth', { symbol: 'sBTCUSDT', id: 7 }), {
    url: PHEMEX_PUBLIC_WS_URL, id: 7, method: 'orderbook.subscribe', params: ['sBTCUSDT', true],
    channel: 'orderbook', topic: 'orderbook:sBTCUSDT', symbol: 'sBTCUSDT', args: ['sBTCUSDT', true], fullDepth: true, snapshot: true,
  });
  assert.throws(() => buildPhemexSubscription('depth', { symbol: 'BTCUSDT' }), /Invalid Phemex spot symbol/);
  assert.throws(() => buildPhemexSubscription('depth', { fullDepth: false }), /full-depth/);
  const metadata = normalizePhemexProducts(products(), { symbol: 'sBTCUSDT', receivedAt: 1_700_000_000_000 });
  assert.equal(metadata.sourceTimestamp, null);
  assert.equal(metadata.receivedAt, 1_700_000_000_000);
  assert.deepEqual(metadata.assets[0], {
    instrumentId: 'phemex:sBTCUSDT', venue: 'phemex', nativeSymbol: 'sBTCUSDT', symbol: 'sBTCUSDT',
    base: 'BTC', quote: 'USDT', marketType: 'spot', tickSize: 0.01, lotSize: 0.000001,
    quantityUnit: 'base', priceScale: 8, ratioScale: 8, isDelisted: false, status: 'online',
    metadataSource: 'phemex-public-products', receivedAt: 1_700_000_000_000,
  });
  const book = normalizePhemexDepth(frame(), { symbol: 'sBTCUSDT', metadata: metadata.assets[0], receivedAt: 1_700_000_000_100 });
  assert.equal(book.instrumentId, 'phemex:sBTCUSDT');
  assert.equal(book.sequence, 100);
  assert.equal(book.sourceTimestamp, 1_789_901_600_877);
  assert.equal(normalizePhemexDepth(frame({ timestamp: '1789901600878999999' }), { symbol: 'sBTCUSDT', metadata: metadata.assets[0] }).sourceTimestamp, 1_789_901_600_878);
  assert.deepEqual(book.bids, [{ price: 80350, amount: 1 }]);
  assert.deepEqual(book.asks, [{ price: 80360, amount: 2 }]);
  const providerFullDepth = normalizePhemexDepth(frame({ type: 'snapshot', depth: 0, sequence: 101, bids: [], asks: [] }), { symbol: 'sBTCUSDT', metadata: metadata.assets[0] });
  assert.equal(providerFullDepth.depth, 0);
  assert.equal(providerFullDepth.kind, 'depthSnapshot');
  assert.throws(() => normalizePhemexDepth({ ...frame(), symbol: 'sETHUSDT' }, { metadata: metadata.assets[0] }), /symbol mismatch/);
  assert.throws(() => normalizePhemexDepth({ ...frame(), type: 'delta' }, { metadata: metadata.assets[0] }), /unsupported depth type/);
});

test('Phemex session replaces snapshots, applies zero deletes, and rejects sequence rewinds', () => {
  const session = createPhemexDepthSession({ topic: 'orderbook:sBTCUSDT', instrumentId: 'phemex:sBTCUSDT', sessionToken: 'phemex-depth:1' });
  const snapshot = normalizePhemexDepth(frame(), { metadata: { priceScale: 8, ratioScale: 8 } });
  const accepted = applyPhemexDepthSessionMessage(session, { topic: session.topic, sessionToken: session.sessionToken, update: snapshot });
  assert.equal(accepted.accepted, true);
  assert.equal(defined(accepted.session.book).bids.length, 1);
  const delta = normalizePhemexDepth(frame({ type: 'incremental', sequence: 101, bids: [[8035000000000, 0], [8034000000000, 50000000]], asks: [] }), { metadata: { priceScale: 8, ratioScale: 8 } });
  const updated = applyPhemexDepthSessionMessage(accepted.session, { topic: session.topic, sessionToken: session.sessionToken, update: delta });
  assert.equal(updated.accepted, true);
  assert.deepEqual(defined(updated.session.book).bids, [{ price: 80340, amount: 0.5 }]);
  const duplicate = applyPhemexDepthSessionMessage(updated.session, { topic: session.topic, sessionToken: session.sessionToken, update: delta });
  assert.equal(duplicate.accepted, false);
  assert.equal(duplicate.reason, 'old-or-duplicate');
  const rewind = normalizePhemexDepth(frame({ type: 'incremental', sequence: 99, bids: [], asks: [] }), { metadata: { priceScale: 8, ratioScale: 8 } });
  const broken = applyPhemexDepthSessionMessage(updated.session, { topic: session.topic, sessionToken: session.sessionToken, update: rewind });
  assert.equal(broken.reason, 'resync-required');
  assert.equal(broken.session.invalidated, true);
});

test('Phemex connector stays fail-closed without an injected transport', async () => {
  const connector = new PhemexConnector();
  await assert.rejects(() => connector.request('products'), error => error instanceof AdapterTransportError);
  const calls: [string, RequestDescriptor | SubscriptionDescriptor][] = [];
  const enabled = new PhemexConnector({ networkEnabled: true, transport: {
    request: async (request: RequestDescriptor) => { calls.push(['request', request]); return products(); },
    subscribe: async (request: SubscriptionDescriptor) => { calls.push(['subscribe', request]); return request; },
  } });
  await enabled.request('products');
  await enabled.subscribe('depth', { symbol: 'sBTCUSDT' });
  assert.deepEqual(calls.map(([kind]) => kind), ['request', 'subscribe']);
});

test('Phemex manager requires matching success ACK, routes snapshots/increments, answers pong, and fences stale sockets', async () => {
  const fake = transport(); const messages:LiveFeedEvent[] = []; const timers:{fn:()=>unknown;delay:number}[] = [];
  const manager = new LiveFeedManager({
    networkEnabled: true, transportFactory: fake.factory,
    restTransport: { request: async (request:ExchangeRestRequest) => request.url.includes('/public/products') ? products() : {} },
    transportPolicies: policies(), oiPollMs: 0, reconnectBaseMs: 10,
    schedule: (fn, delay) => { const timer = { fn, delay }; timers.push(timer); return timer; }, cancel: () => {},
    onMessage: message => messages.push(message),
  });
  await manager.start({ selectedOrderbookVenues: ['phemex'], phemexEnabled: true, phemexSymbol: 'sBTCUSDT' });
  const socket = fake.sockets.find(item => item.spec.id === 'phemex-depth');
  assert.ok(socket);
  assert.deepEqual(JSON.parse(defined(socket.sent.at(-1))), { id: 1, method: 'orderbook.subscribe', params: ['sBTCUSDT', true] });
  assert.equal(socket.spec.request.url, PHEMEX_PUBLIC_WS_URL);
  assert.equal(manager.status()['phemex-metadata'].state, 'snapshot');
  socket.emit(frame({ depth: 0 }));
  assert.equal(messages.some(item => item.id === 'phemex-depth'), false);
  socket.emit({ id: 99, result: { status: 'success' } });
  assert.equal(manager.status()['phemex-depth'].subscriptionAcked, false);
  socket.emit({ id: 1, result: { status: 'success' } });
  assert.equal(manager.status()['phemex-depth'].subscriptionAcked, true);
  socket.emit({ error: null, id: 0, result: 'pong' });
  assert.equal(manager.status()['phemex-depth'].heartbeatAckSource, 'pong');
  socket.emit(frame({ depth: 0 }));
  socket.emit(frame({ type: 'incremental', sequence: 101, bids: [[8035000000000, 0], [8034000000000, 50000000]], asks: [] }));
  let depthMessages = messages.filter(item => item.id === 'phemex-depth');
  assert.equal(depthMessages.length, 2);
  assert.equal(defined(depthMessages.at(-1)).message.sequence, 101);
  assert.equal(defined(defined(depthMessages.at(-1)).message.bids)[0].price, 80340);
  socket.closeWith('lost');
  assert.equal(manager.status()['phemex-depth'].state, 'backoff');
  const invalidationCount = messages.filter(item => item.id === 'phemex-depth').length;
  assert.equal(invalidationCount, depthMessages.length + 1);
  assert.equal(defined(messages.at(-1)).message.resyncRequired, true);
  socket.emit(frame({ sequence: 999 }));
  assert.equal(messages.filter(item => item.id === 'phemex-depth').length, invalidationCount);
  await defined(timers.find(timer => timer.delay === 10)).fn();
  const replacement = defined(fake.sockets.filter(item => item.spec.id === 'phemex-depth').at(-1));
  assert.notStrictEqual(replacement, socket);
  replacement.emit({ id: 1, result: { status: 'success' } });
  replacement.emit(frame({ depth: 0, sequence: 200 }));
  depthMessages = messages.filter(item => item.id === 'phemex-depth');
  assert.equal(defined(depthMessages.at(-1)).message.sequence, 200);
  manager.stop();
});

test('Phemex manager rejects verified non-spot selections before opening a socket', async () => {
  const fake = transport();
  const manager = new LiveFeedManager({ networkEnabled: true, transportFactory: fake.factory, restTransport: { request: async (request:ExchangeRestRequest) => request.url.includes('/public/products') ? { code: 0, data: { products: [{ symbol: 'BTCUSDT', type: 'Perpetual', status: 'Listed' }] } } : {} }, transportPolicies: policies(), oiPollMs: 0 });
  await manager.start({ phemexEnabled: true, phemexSymbol: 'sBTCUSDT' });
  assert.equal(fake.sockets.some(item => item.spec.id === 'phemex-depth'), false);
  assert.equal(manager.status()['phemex-depth'].state, 'unavailable');
  assert.match(textValue(manager.status()['phemex-depth'].lastError), /spot metadata/);
  manager.stop();
});
