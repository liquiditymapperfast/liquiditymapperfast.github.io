import type { RequestDescriptor, SubscriptionDescriptor } from '../src/adapters/common.mts';
import { defined, fields, list, numeric, textValue } from './server-test-helpers.mts';
import type { LiveFeedTransportOptions, LiveFeedSocket, LiveFeedEvent, LiveFeedStatusEvent } from '../src/server/live-feeds.mts';
import type { ExchangeRestRequest } from '../src/server/rest-transport.mts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { LiveFeedManager } from '../src/server/live-feeds.mts';
import {
  AdapterTransportError,
  MexcConnector,
  VENUE_TRANSPORT_POLICIES,
  buildMexcRequest,
  buildMexcSubscription,
  normalizeMexcContractInfo,
  normalizeMexcDepth,
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
      if (request.url.includes('/api/v1/contract/detail')) return {
        success: true, code: 0, data: [{ symbol: 'BTC_USDT', baseCoin: 'BTC', quoteCoin: 'USDT', settleCoin: 'USDT', contractSize: 0.0001, priceUnit: 0.5, volUnit: 1, state: 0 }],
      };
      return {};
    },
  };
}

function snapshot({ symbol = 'BTC_USDT', version = 100, channel = 'push.depth.full', bids = [[100, 2, 1]], asks = [[101, 3, 1]] } = {}) {
  return { channel, symbol, ts: 1_700_000_000_123, data: { version, bids, asks } };
}

test('MEXC contract descriptors and normalizers preserve bounded perpetual full-depth semantics', () => {
  assert.equal(buildMexcRequest('contracts', { symbol: 'BTC_USDT' }).url, 'https://api.mexc.com/api/v1/contract/detail?symbol=BTC_USDT');
  assert.equal(buildMexcRequest('depth', { symbol: 'BTC_USDT' }).url, 'https://api.mexc.com/api/v1/contract/depth/BTC_USDT');
  assert.equal(buildMexcRequest('depthSnapshot', { symbol: 'BTC_USDT', limit: 20 }).url, 'https://api.mexc.com/api/v1/contract/depth_commits/BTC_USDT/20');
  const subscription = buildMexcSubscription('depth', { symbol: 'BTC_USDT', limit: 20 });
  assert.deepEqual(subscription, {
    url: 'wss://contract.mexc.com/edge', method: 'sub.depth.full', param: { symbol: 'BTC_USDT', limit: 20 },
    channel: 'push.depth.full', ackChannel: 'rs.sub.depth.full', topic: 'push.depth.full:BTC_USDT', symbol: 'BTC_USDT',
    depth: 20, args: ['BTC_USDT'], snapshot: true,
  });
  assert.throws(() => buildMexcSubscription('depth', { symbol: 'BTC_USDT', limit: 100 }), /full depth level/);
  const metadata = normalizeMexcContractInfo({ success: true, code: 0, data: [{ symbol: 'BTC_USDT', baseCoin: 'BTC', quoteCoin: 'USDT', settleCoin: 'USDT', contractSize: 0.0001, priceUnit: 0.5, volUnit: 1, state: 0 }] }, { receivedAt: 1_700_000_000_100 });
  assert.deepEqual(metadata.assets[0], {
    instrumentId: 'mexc:BTC_USDT', venue: 'mexc', nativeSymbol: 'BTC_USDT', symbol: 'BTC_USDT',
    base: 'BTC', quote: 'USDT', marketType: 'perpetual', tickSize: 0.5, quantityUnit: 'contract', contractValue: 0.0001,
    isDelisted: false, status: 'online', lotSize: 1, settleCoin: 'USDT', metadataSource: 'mexc-contract-detail',
  });
  const book = normalizeMexcDepth(snapshot(), { symbol: 'BTC_USDT', receivedAt: 1_700_000_000_200, contractValue: 0.0001 });
  assert.equal(book.instrumentId, 'mexc:BTC_USDT');
  assert.equal(book.sequence, 100);
  assert.equal(book.continuity, 'provider-snapshot');
  assert.equal(book.contractValue, 0.0001);
  assert.deepEqual(book.bids, [{ price: 100, amount: 2 }]);
  assert.deepEqual(book.asks, [{ price: 101, amount: 3 }]);
  assert.throws(() => normalizeMexcDepth(snapshot({ symbol: 'ETH_USDT' }), { symbol: 'BTC_USDT' }), /symbol mismatch/);
  assert.throws(() => normalizeMexcDepth(snapshot({ channel: 'push.deal' }), { symbol: 'BTC_USDT' }), /channel unsupported/);
});

test('MEXC connector stays fail-closed unless an injected network transport is explicitly enabled', async () => {
  const connector = new MexcConnector();
  await assert.rejects(() => connector.request('contracts'), error => error instanceof AdapterTransportError);
  const calls: [string, RequestDescriptor | SubscriptionDescriptor][] = [];
  const enabled = new MexcConnector({ networkEnabled: true, transport: {
    request: async (request: RequestDescriptor) => { calls.push(['request', request]); return { success: true, code: 0, data: [] }; },
    subscribe: async (request: SubscriptionDescriptor) => { calls.push(['subscribe', request]); return request; },
  } });
  await enabled.request('contracts', { symbol: 'BTC_USDT' });
  await enabled.subscribe('depth', { symbol: 'BTC_USDT', limit: 20 });
  assert.deepEqual(calls.map(([kind]) => kind), ['request', 'subscribe']);
});

test('MEXC manager requires matching ACK, filters symbols/channels, routes repeated snapshots, and fences reconnects', async () => {
  const fake = transport(); const rest = restTransport(); const messages:LiveFeedEvent[] = []; const timers:{fn:()=>unknown;delay:number}[] = [];
  const manager = new LiveFeedManager({
    networkEnabled: true, transportFactory: fake.factory, restTransport: rest, transportPolicies: policies(),
    oiPollMs: 0, reconnectBaseMs: 10,
    schedule: (fn, delay) => { const timer = { fn, delay }; timers.push(timer); return timer; }, cancel: () => {},
    onMessage: message => messages.push(message),
  });
  await manager.start({ selectedOrderbookVenues: ['mexc'], mexcEnabled: true, mexcSymbol: 'BTC_USDT' });
  const socket = fake.sockets.find(item => item.spec.id === 'mexc-depth');
  assert.ok(socket);
  assert.deepEqual(JSON.parse(defined(socket.sent.at(-1))), { method: 'sub.depth.full', param: { symbol: 'BTC_USDT', limit: 20 } });
  assert.equal(manager.status()['mexc-metadata'].state, 'snapshot');
  socket.emit(snapshot());
  assert.equal(messages.some(item => item.id === 'mexc-depth'), false);
  socket.emit({ channel: 'rs.sub.depth', symbol: 'BTC_USDT', data: 'success' });
  assert.equal(manager.status()['mexc-depth'].subscriptionAcked, false);
  socket.emit({ channel: 'rs.sub.depth.full', symbol: 'ETH_USDT', data: 'success' });
  socket.emit({ channel: 'pong', data: 1_700_000_000_200 });
  assert.equal(manager.status()['mexc-depth'].subscriptionAcked, false);
  socket.emit({ channel: 'rs.sub.depth.full', symbol: 'BTC_USDT', data: 'success' });
  assert.equal(manager.status()['mexc-depth'].subscriptionAcked, true);
  socket.emit({ channel: 'push.depth.full', symbol: 'ETH_USDT', data: { version: 100, bids: [], asks: [] } });
  socket.emit({ channel: 'push.deal', symbol: 'BTC_USDT', data: {} });
  socket.emit(snapshot({ version: 100 }));
  socket.emit(snapshot({ version: 101, bids: [[99.5, 1, 1]] }));
  let depthMessages = messages.filter(item => item.id === 'mexc-depth');
  assert.equal(depthMessages.filter(item => item.message.kind === 'depthSnapshot').length, 2);
  assert.equal(defined(depthMessages.at(-1)).message.sequence, 101);
  assert.equal(manager.status()['mexc-depth'].state, 'live');
  const before = depthMessages.length;
  socket.closeWith('lost');
  assert.equal(manager.status()['mexc-depth'].state, 'backoff');
  socket.emit(snapshot({ version: 999 }));
  assert.equal(messages.filter(item => item.id === 'mexc-depth').length, before + 1); // invalidation only
  await defined(timers.find(timer => timer.delay === 10)).fn();
  const replacement = defined(fake.sockets.filter(item => item.spec.id === 'mexc-depth').at(-1));
  assert.notStrictEqual(replacement, socket);
  replacement.emit({ channel: 'rs.sub.depth.full', symbol: 'BTC_USDT', data: 'success' });
  replacement.emit(snapshot({ version: 200 }));
  depthMessages = messages.filter(item => item.id === 'mexc-depth');
  assert.equal(depthMessages.filter(item => item.message.kind === 'depthSnapshot' && item.message.complete === true).length, 3);
  manager.stop();
});
