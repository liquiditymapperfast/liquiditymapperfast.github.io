import type { RequestDescriptor, SubscriptionDescriptor } from '../src/adapters/common.mts';
import { defined, fields, list, numeric, textValue } from './server-test-helpers.mts';
import type { LiveFeedTransportOptions, LiveFeedSocket, LiveFeedEvent, LiveFeedStatusEvent } from '../src/server/live-feeds.mts';
import type { ExchangeRestRequest } from '../src/server/rest-transport.mts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { LiveFeedManager } from '../src/server/live-feeds.mts';
import {
  ASTER_PUBLIC_WS_URL,
  AsterConnector,
  AdapterTransportError,
  VENUE_TRANSPORT_POLICIES,
  buildAsterRequest,
  buildAsterSubscription,
  normalizeAsterMarkets,
  normalizeAsterTrade,
  normalizeAsterTrades,
} from '../src/adapters/index.mts';

class FakeSocket {
  declare listeners: Map<string, ((value: unknown) => void)[]>;
  declare spec:LiveFeedTransportOptions; declare sent:string[]; declare closed:boolean; declare opened?:boolean;
  declare onMessage:((raw:unknown)=>void)|undefined; declare onClose:((reason:unknown)=>void)|undefined; declare onError:((error:unknown)=>void)|undefined;
  constructor(spec:LiveFeedTransportOptions) { this.spec = spec; this.sent = []; this.closed = false; this.onMessage = undefined; this.onClose = undefined; this.listeners = new Map(); }
  async open() { this.opened = true; }
  send(value:string) { this.sent.push(value); }
  close() { this.closed = true; }
  emit(value:unknown) { this.onMessage?.(value); }
  on(event: string, listener: (value: unknown) => void) { const listeners = this.listeners.get(event) ?? []; listeners.push(listener); this.listeners.set(event, listeners); }
  closeWith(reason = 'closed') { this.closed = true; this.emitEvent('close', reason); }
  emitEvent(event: string, value: unknown = undefined) { for (const listener of this.listeners.get(event) ?? []) listener(value); }
}

function transport() {
  const sockets:FakeSocket[] = [];
  return { sockets, factory: async (spec:LiveFeedTransportOptions) => { const socket = new FakeSocket(spec); sockets.push(socket); return socket; } };
}

function policies() {
  return Object.fromEntries(Object.entries(VENUE_TRANSPORT_POLICIES).map(([venue, policy]) => [venue, { ...policy, subscribeIntervalMs: 0, heartbeatIntervalMs: 60_000, heartbeatTimeoutMs: 60_000 }]));
}

function markets(status = 'TRADING', contractType = 'PERPETUAL', overrides: Record<string, unknown> = {}) {
  return { serverTime: 1_789_902_444_592, symbols: [{
    symbol: 'BTCUSDT', pair: 'BTCUSDT', contractType, status, baseAsset: 'BTC', quoteAsset: 'USDT', marginAsset: 'USDT',
    filters: [{ filterType: 'PRICE_FILTER', tickSize: '0.1' }, { filterType: 'LOT_SIZE', stepSize: '0.001' }],
    ...overrides,
  }] };
}

function trade(overrides: Record<string, unknown> = {}) {
  return { e: 'aggTrade', E: 1_789_902_444_600, s: 'BTCUSDT', a: 42, p: '80000.1', q: '0.25', f: 100, l: 100, T: 1_789_902_444_599, m: true, ...overrides };
}

test('Aster descriptors and normalizers preserve active perpetual aggTrade contracts', () => {
  assert.deepEqual(buildAsterRequest('exchangeInfo'), { url: 'https://fapi.asterdex.com/fapi/v1/exchangeInfo', method: 'GET', headers: { accept: 'application/json' }, responseClass: 'catalog' });
  assert.deepEqual(buildAsterSubscription('aggTrade', { symbol: 'btcusdt', id: 7 }), {
    url: ASTER_PUBLIC_WS_URL, method: 'SUBSCRIBE', params: ['btcusdt@aggTrade'], id: 7, stream: 'btcusdt@aggTrade', topic: 'btcusdt@aggTrade', symbol: 'BTCUSDT',
  });
  assert.throws(() => buildAsterSubscription('aggTrade', { symbol: 'BTC-USDT' }), /Invalid Aster futures symbol/);
  const metadata = normalizeAsterMarkets(markets(), { symbol: 'BTCUSDT', receivedAt: 1_700_000_000_000 });
  assert.deepEqual(metadata.assets[0], {
    instrumentId: 'aster:BTCUSDT', venue: 'aster', nativeSymbol: 'BTCUSDT', symbol: 'BTCUSDT', base: 'BTC', quote: 'USDT',
    marketType: 'perpetual', contractType: 'PERPETUAL', settleCoin: 'USDT', tickSize: 0.1, lotSize: 0.001, quantityUnit: 'base',
    status: 'online', isDelisted: false, metadataSource: 'aster-fapi-v1-exchangeInfo', receivedAt: 1_700_000_000_000,
  });
  assert.deepEqual(normalizeAsterTrade(trade(), { symbol: 'BTCUSDT', receivedAt: 1_700_000_000_001 }), {
    kind: 'trade', venue: 'aster', instrumentId: 'aster:BTCUSDT', tradeId: 'BTCUSDT:42', side: 'sell', price: 80000.1, amount: 0.25,
    notionalUsd: 20000.025, sourceTimestamp: 1_789_902_444_599, receivedAt: 1_700_000_000_001,
  });
  assert.deepEqual(normalizeAsterTrades({ stream: 'btcusdt@aggTrade', data: trade({ a: 43, m: false }) }, { symbol: 'BTCUSDT' }).map(item => item.tradeId), ['BTCUSDT:43']);
  assert.throws(() => normalizeAsterTrades({ stream: 'ethusdt@aggTrade', data: trade() }, { symbol: 'BTCUSDT' }), /stream mismatch/);
  assert.throws(() => normalizeAsterMarkets(markets('TRADING', 'PERPETUAL', { marginAsset: '' }), { symbol: 'BTCUSDT' }), /base\/quote\/margin metadata/);
  assert.throws(() => normalizeAsterTrade(trade({ a: 'not-a-number' }), { symbol: 'BTCUSDT' }), /id missing or invalid/);
  assert.throws(() => normalizeAsterTrade(trade({ m: 'true' }), { symbol: 'BTCUSDT' }), /maker flag missing or invalid/);
  assert.throws(() => normalizeAsterTrade(trade({ q: null }), { symbol: 'BTCUSDT' }), /quantity missing/);
  assert.throws(() => normalizeAsterTrade(trade({ q: 0 }), { symbol: 'BTCUSDT' }), /Invalid Aster aggregate trade values/);
  assert.throws(() => normalizeAsterTrade(trade({ T: null }), { symbol: 'BTCUSDT' }), /timestamp missing/);
  assert.throws(() => normalizeAsterTrade(trade({ T: '' }), { symbol: 'BTCUSDT' }), /timestamp missing/);
  assert.throws(() => normalizeAsterTrades({ stream: 'btcusdt@aggTrade' }, { symbol: 'BTCUSDT' }), /raw\/combined frame mismatch|combined frame data missing/);
  assert.throws(() => normalizeAsterTrades({ data: trade() }, { symbol: 'BTCUSDT' }), /raw\/combined frame mismatch/);
});

test('Aster connector stays fail-closed without an injected transport', async () => {
  const connector = new AsterConnector();
  await assert.rejects(() => connector.request(), error => error instanceof AdapterTransportError);
  const calls: [string, RequestDescriptor | SubscriptionDescriptor][] = [];
  const enabled = new AsterConnector({ networkEnabled: true, transport: {
    request: async (request: RequestDescriptor) => { calls.push(['request', request]); return markets(); },
    subscribe: async (request: SubscriptionDescriptor) => { calls.push(['subscribe', request]); return request; },
  } });
  await enabled.request();
  await enabled.subscribe('aggTrade', { symbol: 'BTCUSDT' });
  assert.deepEqual(calls.map(([kind]) => kind), ['request', 'subscribe']);
});

test('Aster manager requires exact ACK, routes raw/combined trades, observes protocol heartbeats, and fences stale sockets', async () => {
  const fake = transport(); const timers:{fn:()=>unknown;delay:number}[] = []; const messages:LiveFeedEvent[] = [];
  const manager = new LiveFeedManager({
    networkEnabled: true, transportFactory: fake.factory,
    restTransport: { request: async (request:ExchangeRestRequest) => request.url.includes('/fapi/v1/exchangeInfo') ? markets() : {} },
    transportPolicies: policies(), reconnectBaseMs: 10, oiPollMs: 0,
    schedule: (fn, delay) => { const timer = { fn, delay }; timers.push(timer); return timer; }, cancel: () => {},
    onMessage: message => messages.push(message),
  });
  await manager.start({ selectedOrderbookVenues: ['aster'], asterEnabled: true, asterSymbol: 'BTCUSDT' });
  const socket = fake.sockets.find(item => item.spec.id === 'aster-trades');
  assert.ok(socket);
  assert.equal(socket.spec.request.url, ASTER_PUBLIC_WS_URL);
  assert.deepEqual(JSON.parse(defined(socket.sent.at(-1))), { method: 'SUBSCRIBE', params: ['btcusdt@aggTrade'], id: 1 });
  assert.equal(manager.status()['aster-metadata'].state, 'snapshot');
  socket.emit(trade({ a: 1 }));
  assert.equal(messages.some(item => item.id === 'aster-trades'), false);
  socket.emit({ result: null, id: 9 });
  assert.equal(manager.status()['aster-trades'].subscriptionAcked, false);
  socket.emit({ result: null, id: 1 });
  assert.equal(manager.status()['aster-trades'].subscriptionAcked, true);
  socket.emit(trade({ a: 2 }));
  socket.emit({ stream: 'btcusdt@aggTrade', data: trade({ a: 3, m: false }) });
  socket.emit({ stream: 'ethusdt@aggTrade', data: trade({ a: 4 }) });
  assert.deepEqual(messages.filter(item => item.id === 'aster-trades').map(item => item.message.tradeId), ['BTCUSDT:2', 'BTCUSDT:3']);
  const observedBeforeMalformed = manager.status()['aster-trades'].lastObservedAt;
  socket.emit({ data: trade({ a: 9 }) });
  socket.emit({ stream: 'btcusdt@aggTrade', e: 'aggTrade', s: 'BTCUSDT', a: 10, p: '80000', q: '0.1', T: 1_789_902_444_601, m: false });
  assert.equal(messages.filter(item => item.id === 'aster-trades').some(item => item.message.tradeId === 'BTCUSDT:9' || item.message.tradeId === 'BTCUSDT:10'), false);
  assert.equal(manager.status()['aster-trades'].lastObservedAt, observedBeforeMalformed);
  socket.emitEvent('ping');
  assert.equal(manager.status()['aster-trades'].heartbeatAckSource, 'protocol-ping');
  socket.emitEvent('pong');
  assert.equal(manager.status()['aster-trades'].heartbeatAckSource, 'protocol-pong');
  assert.deepEqual(socket.sent.map(value => JSON.parse(value)), [{ method: 'SUBSCRIBE', params: ['btcusdt@aggTrade'], id: 1 }]);
  const beforeReconnect = messages.length;
  socket.closeWith('lost');
  assert.equal(manager.status()['aster-trades'].state, 'backoff');
  assert.equal(timers.length, 1);
  socket.emit(trade({ a: 5 }));
  socket.emitEvent('ping');
  assert.equal(messages.length, beforeReconnect);
  await timers[0].fn();
  const replacement = defined(fake.sockets.filter(item => item.spec.id === 'aster-trades').at(-1));
  assert.notStrictEqual(replacement, socket);
  assert.equal(manager.status()['aster-trades'].subscriptionAcked, false);
  socket.emit(trade({ a: 6 }));
  socket.emitEvent('pong');
  replacement.emit(trade({ a: 7 }));
  assert.equal(messages.filter(item => item.id === 'aster-trades').some(item => item.message.tradeId === 'BTCUSDT:6'), false);
  assert.equal(messages.filter(item => item.id === 'aster-trades').some(item => item.message.tradeId === 'BTCUSDT:7'), false);
  replacement.emit({ result: null, id: 1 });
  replacement.emit(trade({ a: 8 }));
  assert.equal(messages.filter(item => item.id === 'aster-trades').at(-1)?.message.tradeId, 'BTCUSDT:8');
  replacement.emit({ code: 2, msg: 'invalid request' });
  assert.equal(manager.status()['aster-trades'].state, 'backoff');
  manager.stop();
});

test('Aster manager rejects non-trading or non-perpetual metadata before opening a socket', async () => {
  for (const payload of [markets('BREAK'), markets('TRADING', 'CURRENT_QUARTER'), markets('TRADING', 'PERPETUAL', { marginAsset: '' })]) {
    const fake = transport();
    const manager = new LiveFeedManager({
      networkEnabled: true, transportFactory: fake.factory,
      restTransport: { request: async (request:ExchangeRestRequest) => request.url.includes('/fapi/v1/exchangeInfo') ? payload : {} },
      transportPolicies: policies(), oiPollMs: 0,
    });
    await manager.start({ asterEnabled: true, asterSymbol: 'BTCUSDT' });
    assert.equal(fake.sockets.some(item => item.spec.id === 'aster-trades'), false);
    assert.equal(manager.status()['aster-trades'].state, 'unavailable');
    assert.match(textValue(manager.status()['aster-trades'].lastError), /active public perpetual metadata/);
    manager.stop();
  }
});
