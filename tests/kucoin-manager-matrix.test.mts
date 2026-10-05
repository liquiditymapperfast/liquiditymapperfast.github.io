import type { RequestDescriptor, SubscriptionDescriptor } from '../src/adapters/common.mts';
import { defined, fields, list, numeric, textValue } from './server-test-helpers.mts';
import type { LiveFeedTransportOptions, LiveFeedSocket, LiveFeedEvent, LiveFeedStatusEvent } from '../src/server/live-feeds.mts';
import type { ExchangeRestRequest } from '../src/server/rest-transport.mts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { LiveFeedManager } from '../src/server/live-feeds.mts';
import {
  AdapterTransportError,
  KucoinConnector,
  VENUE_TRANSPORT_POLICIES,
  applyPublicDepthSessionMessage,
  buildKucoinRequest,
  buildKucoinSubscription,
  buildKucoinWsUrl,
  createPublicDepthSession,
  normalizeKucoinDepth,
  normalizeKucoinPublicToken,
  normalizeKucoinSymbol,
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
      if (request.url.includes('/api/v1/bullet-public')) return {
        code: '200000', data: { token: 'fixture-token', instanceServers: [{ endpoint: 'wss://ws-api-spot.kucoin.com/', pingInterval: 12_345, pingTimeout: 6_789 }] },
      };
      if (request.url.includes('/api/v2/symbols/BTC-USDT')) return {
        code: '200000',
        data: {
          symbol: 'BTC-USDT', baseCurrency: 'BTC', quoteCurrency: 'USDT',
          priceIncrement: '0.01', baseIncrement: '0.000001', tradingStartTime: 1_700_000_000_000,
          enableTrading: true, status: 'online',
        },
      };
      if (request.url.includes('/exchangeInfo')) return { symbols: [] };
      if ((typeof request.body === 'string' && request.body.includes('metaAndAssetCtxs'))) return [{ universe: [] }, []];
      return {};
    },
  };
}

function snapshot({ symbol = 'BTC-USDT', topic = `/spotMarket/level2Depth50:${symbol}`, bids = [['100.00', '2.5']], asks = [['101.00', '3.0']], type = 'message', subject = 'level2' }: {symbol?: string; topic?: string; bids?: string[][]; asks?: string[][]; type?: string; subject?: string} = {}) {
  return { type, subject, topic, data: { timestamp: 1_700_000_000_123, bids, asks } };
}

test('KuCoin descriptors and normalizers preserve documented spot Level-50 semantics', () => {
  assert.equal(buildKucoinRequest('symbol', { symbol: 'BTC-USDT' }).url, 'https://api.kucoin.com/api/v2/symbols/BTC-USDT');
  assert.equal(buildKucoinRequest('publicToken').url, 'https://api.kucoin.com/api/v1/bullet-public');
  assert.equal(buildKucoinRequest('depth', { symbol: 'BTC-USDT', depth: 100 }).url, 'https://api.kucoin.com/api/v1/market/orderbook/level2_100?symbol=BTC-USDT');
  assert.throws(() => buildKucoinRequest('depth', { symbol: 'BTC-USDT', depth: 50 }), /Unsupported KuCoin REST depth/);
  const subscription = buildKucoinSubscription('depth', { symbol: 'BTC-USDT', depth: 50, id: 7 });
  assert.deepEqual(subscription, {
    url: 'wss://ws-api-spot.kucoin.com', id: '7', type: 'subscribe',
    topic: '/spotMarket/level2Depth50:BTC-USDT', channel: 'level2Depth50', symbol: 'BTC-USDT',
    depth: 50, response: true, args: ['/spotMarket/level2Depth50:BTC-USDT'],
  });
  const metadata = normalizeKucoinSymbol({ code: '200000', data: {
    symbol: 'BTC-USDT', baseCurrency: 'BTC', quoteCurrency: 'USDT', priceIncrement: '0.01',
    baseIncrement: '0.000001', tradingStartTime: 1_700_000_000_000, enableTrading: true,
  } }, { symbol: 'BTC-USDT', receivedAt: 1_700_000_000_100 });
  assert.deepEqual(metadata.assets[0], {
    instrumentId: 'kucoin:BTC-USDT', venue: 'kucoin', nativeSymbol: 'BTC-USDT', symbol: 'BTC-USDT',
    base: 'BTC', quote: 'USDT', marketType: 'spot', tickSize: 0.01, qtyStep: 0.000001,
    lotSize: 0.000001, quantityUnit: 'base', status: 'online', isDelisted: false, metadataSource: 'kucoin-symbol',
  });
  const token = normalizeKucoinPublicToken({ code: '200000', data: { token: 'abc', instanceServers: [{ endpoint: 'wss://ws-api-spot.kucoin.com/', pingInterval: 18_000, pingTimeout: 10_000 }] } }, { receivedAt: 1_700_000_000_000 });
  assert.deepEqual(token, { kind: 'transportMetadata', venue: 'kucoin', sourceTimestamp: null, receivedAt: 1_700_000_000_000, token: 'abc', endpoint: 'wss://ws-api-spot.kucoin.com/', pingIntervalMs: 18_000, heartbeatTimeoutMs: 10_000 });
  assert.equal(buildKucoinWsUrl({ endpoint: token.endpoint, token: token.token, connectId: 'c1' }), 'wss://ws-api-spot.kucoin.com/?token=abc&connectId=c1');
  const book = normalizeKucoinDepth(snapshot(), { symbol: 'BTC-USDT', receivedAt: 1_700_000_000_200 });
  assert.equal(book.instrumentId, 'kucoin:BTC-USDT');
  assert.equal(book.sourceTimestamp, 1_700_000_000_123);
  assert.equal(book.continuity, 'provider-snapshot');
  assert.equal(fields(book).sequence, undefined);
  assert.deepEqual(book.bids, [{ price: 100, amount: 2.5 }]);
  assert.deepEqual(book.asks, [{ price: 101, amount: 3 }]);
  assert.throws(() => normalizeKucoinDepth(snapshot({ subject: 'trade' })), /message type unsupported/);
  assert.throws(() => normalizeKucoinDepth(snapshot({ symbol: 'ETH-USDT' }), { symbol: 'BTC-USDT' }), /topic symbol mismatch/);
});

test('KuCoin provider snapshots are explicitly unsequenced and session-owned', () => {
  const first = normalizeKucoinDepth(snapshot(), { symbol: 'BTC-USDT' });
  const session = createPublicDepthSession({ venue: 'kucoin', topic: '/spotMarket/level2Depth50:BTC-USDT', instrumentId: 'kucoin:BTC-USDT', sessionToken: 'kucoin-depth:1', allowUnsequenced: true });
  assert.equal(session.allowUnsequenced, true);
  const accepted = applyPublicDepthSessionMessage(session, { topic: session.topic, sessionToken: session.sessionToken, update: first });
  assert.equal(accepted.accepted, true);
  assert.equal(defined(accepted.session.book).sequence, undefined);
  assert.equal(defined(accepted.session.book).continuity, 'provider-snapshot');
  const repeated = normalizeKucoinDepth(snapshot({ bids: [['99.5', '1']] }), { symbol: 'BTC-USDT' });
  assert.equal(applyPublicDepthSessionMessage(accepted.session, { topic: session.topic, sessionToken: session.sessionToken, update: repeated }).accepted, true);
  assert.equal(applyPublicDepthSessionMessage(accepted.session, { topic: 'wrong', sessionToken: session.sessionToken, update: first }).reason, 'wrong-topic');
  assert.equal(applyPublicDepthSessionMessage(accepted.session, { topic: session.topic, sessionToken: 'old', update: first }).reason, 'cross-session');
  assert.throws(() => normalizeKucoinDepth(snapshot({ bids: [['100', 'invalid']] })), /amount/);
});

test('KuCoin connector stays fail-closed unless an injected network transport is explicitly enabled', async () => {
  const connector = new KucoinConnector();
  await assert.rejects(() => connector.request('symbol', { symbol: 'BTC-USDT' }), error => error instanceof AdapterTransportError);
  const calls: [string, RequestDescriptor | SubscriptionDescriptor][] = [];
  const enabled = new KucoinConnector({ networkEnabled: true, transport: {
    request: async (request: RequestDescriptor) => { calls.push(['request', request]); return { code: '200000', data: {} }; },
    subscribe: async (request: SubscriptionDescriptor) => { calls.push(['subscribe', request]); return request; },
  } });
  await enabled.request('symbol', { symbol: 'BTC-USDT' });
  await enabled.subscribe('depth', { symbol: 'BTC-USDT' });
  assert.deepEqual(calls.map(([kind]) => kind), ['request', 'subscribe']);
});

test('KuCoin manager requires matching ACK, filters controls/topics, routes snapshots, and fences reconnects', async () => {
  const fake = transport(); const rest = restTransport(); const messages:LiveFeedEvent[] = []; const timers:{fn:()=>unknown;delay:number}[] = [];
  const manager = new LiveFeedManager({
    networkEnabled: true, transportFactory: fake.factory, restTransport: rest, transportPolicies: policies(),
    oiPollMs: 0, reconnectBaseMs: 10,
    schedule: (fn, delay) => { const timer = { fn, delay }; timers.push(timer); return timer; },
    cancel: () => {}, onMessage: message => messages.push(message),
  });
  await manager.start({ selectedOrderbookVenues: ['kucoin'], kucoinEnabled: true, kucoinSymbol: 'BTC-USDT' });
  const socket = defined(fake.sockets.find(item => item.spec.id === 'kucoin-depth'));
  assert.equal(socket.spec.request.url, 'wss://ws-api-spot.kucoin.com/?token=fixture-token&connectId=hlm-1');
  assert.equal(manager.status()['kucoin-depth'].heartbeatIntervalMs, 12_345);
  assert.equal(manager.status()['kucoin-depth'].heartbeatTimeoutMs, 6_789);
  assert.deepEqual(socket.sent, []);
  assert.equal(manager.status()['kucoin-metadata'].state, 'snapshot');
  socket.emit({ id: 'session', type: 'welcome', pingInterval: 18_000 });
  assert.deepEqual(JSON.parse(defined(socket.sent.at(-1))), { id: '1', type: 'subscribe', topic: '/spotMarket/level2Depth50:BTC-USDT', response: true });
  socket.emit({ id: 'heartbeat', type: 'pong' });
  assert.equal(manager.status()['kucoin-depth'].subscriptionAcked, false);
  socket.emit(snapshot());
  socket.emit({ id: 'wrong', type: 'ack' });
  socket.emit(snapshot({ topic: '/spotMarket/level2Depth50:ETH-USDT' }));
  socket.emit(snapshot({ subject: 'trade' }));
  assert.equal(manager.status()['kucoin-depth'].subscriptionAcked, false);
  assert.equal(messages.some(item => item.id === 'kucoin-depth'), false);
  socket.emit({ id: '1', type: 'ack' });
  socket.emit(snapshot());
  socket.emit(snapshot({ bids: [['99.5', '1']] }));
  let depthMessages = messages.filter(item => item.id === 'kucoin-depth');
  assert.equal(depthMessages.filter(item => item.message.kind === 'depthSnapshot').length, 2);
  assert.equal(defined(depthMessages.at(-1)).message.sequence, undefined);
  assert.equal(manager.status()['kucoin-depth'].state, 'live');
  const before = depthMessages.length;
  socket.closeWith('lost');
  assert.equal(manager.status()['kucoin-depth'].state, 'backoff');
  socket.emit(snapshot());
  assert.equal(messages.filter(item => item.id === 'kucoin-depth').length, before + 1); // invalidation only
  await defined(timers.find(timer => timer.delay === 10)).fn();
  const replacement = defined(fake.sockets.filter(item => item.spec.id === 'kucoin-depth').at(-1));
  assert.notStrictEqual(replacement, socket);
  replacement.emit(snapshot());
  assert.equal(manager.status()['kucoin-depth'].subscriptionAcked, false);
  replacement.emit({ id: 'session-2', type: 'welcome' });
  replacement.emit({ id: '1', type: 'ack' });
  replacement.emit(snapshot());
  depthMessages = messages.filter(item => item.id === 'kucoin-depth');
  assert.equal(depthMessages.filter(item => item.message.kind === 'depthSnapshot' && item.message.complete === true).length, 3);
  manager.stop();
});

test('KuCoin manager refuses a bare unauthenticated websocket without token transport', async () => {
  const fake = transport();
  const manager = new LiveFeedManager({
    networkEnabled: true, transportFactory: fake.factory, transportPolicies: policies(), oiPollMs: 0,
    schedule: (fn, delay) => ({ fn, delay }), cancel: () => {},
  });
  await manager.start({ kucoinEnabled: true, kucoinSymbol: 'BTC-USDT' });
  assert.equal(fake.sockets.some(item => item.spec.id === 'kucoin-depth'), false);
  assert.equal(manager.status()['kucoin-depth'].state, 'unavailable');
  assert.match(textValue(manager.status()['kucoin-depth'].lastError), /token/i);
  manager.stop();
});
