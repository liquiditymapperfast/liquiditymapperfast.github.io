import type { RequestDescriptor, SubscriptionDescriptor } from '../src/adapters/common.mts';
import { defined, fields, list, numeric, textValue } from './server-test-helpers.mts';
import type { LiveFeedTransportOptions, LiveFeedSocket, LiveFeedEvent, LiveFeedStatusEvent } from '../src/server/live-feeds.mts';
import type { ExchangeRestRequest } from '../src/server/rest-transport.mts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { gzipSync } from 'node:zlib';
import { LiveFeedManager } from '../src/server/live-feeds.mts';
import {
  AdapterTransportError,
  HtxConnector,
  VENUE_TRANSPORT_POLICIES,
  buildHtxRequest,
  buildHtxSubscription,
  normalizeHtxContractInfo,
  normalizeHtxDepth,
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
      if (request.url.includes('/linear-swap-api/v1/swap_contract_info')) return {
        status: 'ok', ts: 1_700_000_000_010,
        data: [{ symbol: 'BTC', contract_code: 'BTC-USDT', pair: 'BTC-USDT', contract_size: 0.001, price_tick: 0.1, contract_type: 'swap', business_type: 'swap', contract_status: 1 }],
      };
      return {};
    },
  };
}

function snapshot({ topic = 'market.BTC-USDT.depth.step6', version = 100, bids = [[100, 2]], asks = [[101, 3]] }: {topic?: string; version?: number | null; bids?: number[][]; asks?: number[][]} = {}) {
  return { status: 'ok', ch: topic, ts: 1_700_000_000_123, tick: { ch: topic, ts: 1_700_000_000_120, version, bids, asks } };
}

test('HTX descriptors and normalizers preserve bounded USDT-swap snapshot semantics', () => {
  assert.equal(buildHtxRequest('contracts', { symbol: 'BTC-USDT' }).url, 'https://api.hbdm.com/linear-swap-api/v1/swap_contract_info?contract_code=BTC-USDT');
  assert.equal(buildHtxRequest('depth', { symbol: 'BTC-USDT', type: 'step6' }).url, 'https://api.hbdm.com/linear-swap-ex/market/depth?contract_code=BTC-USDT&type=step6');
  const subscription = buildHtxSubscription('depth', { symbol: 'BTC-USDT', type: 'step6', id: 'depth-1' });
  assert.deepEqual(subscription, {
    url: 'wss://api.hbdm.com/linear-swap-ws', sub: 'market.BTC-USDT.depth.step6', id: 'depth-1',
    channel: 'market.BTC-USDT.depth.step6', topic: 'market.BTC-USDT.depth.step6', symbol: 'BTC-USDT', type: 'step6',
    args: ['market.BTC-USDT.depth.step6'], snapshot: true,
  });
  assert.throws(() => buildHtxSubscription('depth', { symbol: 'BTC-USDT', type: 'invalid' }), /Unsupported HTX depth type/);
  const metadata = normalizeHtxContractInfo({ status: 'ok', ts: 1_700_000_000_100, data: [{ symbol: 'BTC', contract_code: 'BTC-USDT', pair: 'BTC-USDT', contract_size: 0.001, price_tick: 0.1, contract_type: 'swap', business_type: 'swap', contract_status: 1 }] }, { receivedAt: 1_700_000_000_101 });
  assert.deepEqual(metadata.assets[0], {
    instrumentId: 'htx:BTC-USDT', venue: 'htx', nativeSymbol: 'BTC-USDT', symbol: 'BTC-USDT', base: 'BTC', quote: 'USDT',
    marketType: 'perpetual', tickSize: 0.1, quantityUnit: 'contract', contractValue: 0.001, isDelisted: false, status: 'online', lotSize: 1,
    metadataSource: 'htx-swap-contract-info',
  });
  const book = normalizeHtxDepth(snapshot(), { symbol: 'BTC-USDT', type: 'step6', receivedAt: 1_700_000_000_200, contractValue: 0.001 });
  assert.equal(book.instrumentId, 'htx:BTC-USDT');
  assert.equal(book.sequence, 100);
  assert.equal(book.continuity, 'provider-snapshot');
  assert.equal(book.contractValue, 0.001);
  assert.deepEqual(book.bids, [{ price: 100, amount: 2 }]);
  assert.deepEqual(book.asks, [{ price: 101, amount: 3 }]);
  assert.throws(() => normalizeHtxDepth(snapshot({ topic: 'market.ETH-USDT.depth.step6' }), { symbol: 'BTC-USDT' }), /channel mismatch/);
  assert.throws(() => normalizeHtxDepth(snapshot({ version: null }), { symbol: 'BTC-USDT' }), /version missing/);
});

test('HTX connector stays fail-closed unless an injected network transport is explicitly enabled', async () => {
  const connector = new HtxConnector();
  await assert.rejects(() => connector.request('contracts'), error => error instanceof AdapterTransportError);
  const calls: [string, RequestDescriptor | SubscriptionDescriptor][] = [];
  const enabled = new HtxConnector({ networkEnabled: true, transport: {
    request: async (request: RequestDescriptor) => { calls.push(['request', request]); return { status: 'ok', data: [] }; },
    subscribe: async (request: SubscriptionDescriptor) => { calls.push(['subscribe', request]); return request; },
  } });
  await enabled.request('contracts', { symbol: 'BTC-USDT' });
  await enabled.subscribe('depth', { symbol: 'BTC-USDT', type: 'step6' });
  assert.deepEqual(calls.map(([kind]) => kind), ['request', 'subscribe']);
});

test('HTX manager requires matching subbed ACK, replies to gzip ping, routes snapshots, and fences reconnects', async () => {
  const fake = transport(); const rest = restTransport(); const messages:LiveFeedEvent[] = []; const timers:{fn:()=>unknown;delay:number}[] = [];
  const manager = new LiveFeedManager({
    networkEnabled: true, transportFactory: fake.factory, restTransport: rest, transportPolicies: policies(),
    oiPollMs: 0, reconnectBaseMs: 10,
    schedule: (fn, delay) => { const timer = { fn, delay }; timers.push(timer); return timer; }, cancel: () => {},
    onMessage: message => messages.push(message),
  });
  await manager.start({ selectedOrderbookVenues: ['htx'], htxEnabled: true, htxSymbol: 'BTC-USDT' });
  const socket = fake.sockets.find(item => item.spec.id === 'htx-depth');
  assert.ok(socket);
  assert.deepEqual(JSON.parse(defined(socket.sent.at(-1))), { sub: 'market.BTC-USDT.depth.step6', id: '1' });
  assert.equal(manager.status()['htx-metadata'].state, 'snapshot');
  socket.emit(snapshot());
  assert.equal(messages.some(item => item.id === 'htx-depth'), false);
  socket.emit({ id: 'wrong', status: 'ok', subbed: 'market.BTC-USDT.depth.step6' });
  assert.equal(manager.status()['htx-depth'].subscriptionAcked, false);
  socket.emit({ id: '1', status: 'ok', subbed: 'market.ETH-USDT.depth.step6' });
  socket.emit(gzipSync(JSON.stringify({ ping: 1_700_000_000_200 })));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(JSON.parse(defined(socket.sent.at(-1))).pong, 1_700_000_000_200);
  assert.equal(manager.status()['htx-depth'].subscriptionAcked, false);
  socket.emit({ id: '1', status: 'ok', subbed: 'market.BTC-USDT.depth.step6' });
  assert.equal(manager.status()['htx-depth'].subscriptionAcked, true);
  socket.emit(snapshot({ topic: 'market.ETH-USDT.depth.step6' }));
  socket.emit(snapshot({ version: 100 }));
  socket.emit(snapshot({ version: 101, bids: [[99.5, 1]] }));
  let depthMessages = messages.filter(item => item.id === 'htx-depth');
  assert.equal(depthMessages.filter(item => item.message.kind === 'depthSnapshot').length, 2);
  assert.equal(defined(depthMessages.at(-1)).message.sequence, 101);
  assert.equal(manager.status()['htx-depth'].state, 'live');
  const before = depthMessages.length;
  socket.closeWith('lost');
  assert.equal(manager.status()['htx-depth'].state, 'backoff');
  socket.emit(snapshot({ version: 999 }));
  assert.equal(messages.filter(item => item.id === 'htx-depth').length, before + 1);
  await defined(timers.find(timer => timer.delay === 10)).fn();
  const replacement = defined(fake.sockets.filter(item => item.spec.id === 'htx-depth').at(-1));
  assert.notStrictEqual(replacement, socket);
  replacement.emit({ id: '1', status: 'ok', subbed: 'market.BTC-USDT.depth.step6' });
  replacement.emit(snapshot({ version: 200 }));
  depthMessages = messages.filter(item => item.id === 'htx-depth');
  assert.equal(depthMessages.filter(item => item.message.kind === 'depthSnapshot' && item.message.complete === true).length, 3);
  manager.stop();
});
