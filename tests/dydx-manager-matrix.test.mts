import type { RequestDescriptor, SubscriptionDescriptor } from '../src/adapters/common.mts';
import { defined, fields, list, numeric, textValue } from './server-test-helpers.mts';
import type { LiveFeedTransportOptions, LiveFeedSocket, LiveFeedEvent, LiveFeedStatusEvent } from '../src/server/live-feeds.mts';
import type { ExchangeRestRequest } from '../src/server/rest-transport.mts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { LiveFeedManager } from '../src/server/live-feeds.mts';
import {
  AdapterTransportError,
  DYDX_PUBLIC_WS_URL,
  DydxConnector,
  VENUE_TRANSPORT_POLICIES,
  buildDydxRequest,
  buildDydxSubscription,
  normalizeDydxMarkets,
  normalizeDydxTrade,
  normalizeDydxTrades,
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
  emitEvent(event: string, value: unknown = undefined) { for (const listener of this.listeners.get(event) ?? []) listener(value); }
}

function transport() {
  const sockets:FakeSocket[] = [];
  return { sockets, factory: async (spec:LiveFeedTransportOptions) => { const socket = new FakeSocket(spec); sockets.push(socket); return socket; } };
}

function policies() {
  return Object.fromEntries(Object.entries(VENUE_TRANSPORT_POLICIES).map(([venue, policy]) => [venue, { ...policy, subscribeIntervalMs: 0, heartbeatIntervalMs: 60_000, heartbeatTimeoutMs: 60_000 }]));
}

function markets(status = 'ACTIVE') {
  return { markets: { 'BTC-USD': {
    ticker: 'BTC-USD', status, tickSize: '1', stepSize: '0.0001', atomicResolution: -10,
    quantumConversionExponent: -9, oraclePrice: '80000', openInterest: '10',
  } } };
}

function subscribed(...trades: unknown[]) {
  return { type: 'subscribed', channel: 'v4_trades', id: 'BTC-USD', contents: { trades } };
}

test('dYdX descriptors and normalizers preserve active perpetual trade contracts', () => {
  assert.deepEqual(buildDydxRequest('perpetualMarkets'), { url: 'https://indexer.dydx.trade/v4/perpetualMarkets', method: 'GET', headers: { accept: 'application/json' }, responseClass: 'catalog' });
  assert.deepEqual(buildDydxSubscription('trades', { symbol: 'btc_usd' }), {
    url: DYDX_PUBLIC_WS_URL, type: 'subscribe', channel: 'v4_trades', id: 'BTC-USD', topic: 'v4_trades:BTC-USD', symbol: 'BTC-USD',
  });
  assert.throws(() => buildDydxSubscription('trades', { symbol: 'BTC-USDT' }), /Invalid dYdX perpetual market symbol/);
  const metadata = normalizeDydxMarkets({ markets: { ...markets().markets, 'MAD,RAYDIUM,POOL-USD': { ticker: 'MAD,RAYDIUM,POOL-USD', status: 'ACTIVE', tickSize: '1', stepSize: '1' } } }, { symbol: 'BTC-USD', receivedAt: 1_700_000_000_000 });
  assert.deepEqual(metadata.assets[0], {
    instrumentId: 'dydx:BTC-USD', venue: 'dydx', nativeSymbol: 'BTC-USD', symbol: 'BTC-USD', base: 'BTC', quote: 'USD',
    marketType: 'perpetual', tickSize: 1, lotSize: 0.0001, quantityUnit: 'base', atomicResolution: -10,
    quantumConversionExponent: -9, status: 'online', isDelisted: false, metadataSource: 'dydx-v4-perpetualMarkets', receivedAt: 1_700_000_000_000,
  });
  const row = normalizeDydxTrade({ id: '42', side: 'BUY', price: '80001.5', size: '0.25', createdAt: '2026-09-20T12:00:00.000Z', createdAtHeight: '123' }, { symbol: 'BTC-USD', receivedAt: 1_700_000_000_001 });
  assert.deepEqual(row, {
    kind: 'trade', venue: 'dydx', instrumentId: 'dydx:BTC-USD', tradeId: 'BTC-USD:42', side: 'buy', price: 80001.5, amount: 0.25,
    notionalUsd: 20000.375, sourceTimestamp: Date.parse('2026-09-20T12:00:00.000Z'), receivedAt: 1_700_000_000_001,
  });
  assert.throws(() => normalizeDydxTrade({ id: 'foreign', symbol: 'ETH-USD', price: '1', size: '1', createdAt: 1_800_000_000_000 }, { symbol: 'BTC-USD' }), /symbol mismatch/);
  assert.deepEqual(normalizeDydxTrades({ contents: { trades: [
    { ...row, id: '43', liquidation: true },
    { ...row, id: '44', type: 'LIQUIDATED' },
    { ...row, id: '45', type: 'DELEVERAGED' },
    { id: '46', side: 'SELL', price: '80000', size: '0.1', createdAt: 1_800_000_000_000, type: 'LIMIT' },
  ] } }, { symbol: 'BTC-USD' }).map(item => item.tradeId), ['BTC-USD:46']);
});

test('dYdX connector stays fail-closed without an injected transport', async () => {
  const connector = new DydxConnector();
  await assert.rejects(() => connector.request(), error => error instanceof AdapterTransportError);
  const calls: [string, RequestDescriptor | SubscriptionDescriptor][] = [];
  const enabled = new DydxConnector({ networkEnabled: true, transport: {
    request: async (request: RequestDescriptor) => { calls.push(['request', request]); return markets(); },
    subscribe: async (request: SubscriptionDescriptor) => { calls.push(['subscribe', request]); return request; },
  } });
  await enabled.request();
  await enabled.subscribe('trades', { symbol: 'BTC-USD' });
  assert.deepEqual(calls.map(([kind]) => kind), ['request', 'subscribe']);
});

test('dYdX manager requires matching ACK, routes trades, ignores liquidations, and fences stale sockets', async () => {
  const fake = transport(); const messages:LiveFeedEvent[] = [];
  const manager = new LiveFeedManager({
    networkEnabled: true, transportFactory: fake.factory,
    restTransport: { request: async (request:ExchangeRestRequest) => request.url.includes('/v4/perpetualMarkets') ? markets() : {} },
    transportPolicies: policies(), oiPollMs: 0, reconnectBaseMs: 10,
    schedule: (fn, delay) => ({ fn, delay }), cancel: () => {},
    onMessage: message => messages.push(message),
  });
  await manager.start({ dydxEnabled: true, dydxSymbol: 'BTC-USD' });
  const socket = fake.sockets.find(item => item.spec.id === 'dydx-trades');
  assert.ok(socket);
  assert.deepEqual(JSON.parse(defined(socket.sent.at(-1))), { type: 'subscribe', channel: 'v4_trades', id: 'BTC-USD' });
  assert.equal(socket.spec.request.url, DYDX_PUBLIC_WS_URL);
  assert.equal(manager.status()['dydx-metadata'].state, 'snapshot');
  socket.emit({ type: 'channel_data', channel: 'v4_trades', id: 'BTC-USD', contents: { trades: [{ id: '1', side: 'BUY', price: '80000', size: '1', createdAt: '2026-09-20T12:00:00.000Z' }] } });
  assert.equal(messages.some(item => item.id === 'dydx-trades'), false);
  socket.emit({ type: 'subscribed', channel: 'v4_trades', id: 'OTHER-USD', contents: { trades: [] } });
  assert.equal(manager.status()['dydx-trades'].subscriptionAcked, false);
  socket.emit(subscribed(
    { id: '1', side: 'BUY', price: '80000', size: '1', createdAt: '2026-09-20T12:00:00.000Z' },
    { id: '2', side: 'SELL', price: '80001', size: '0.5', createdAt: '2026-09-20T12:00:01.000Z', liquidation: true },
  ));
  assert.equal(manager.status()['dydx-trades'].subscriptionAcked, true);
  assert.equal(messages.filter(item => item.id === 'dydx-trades').length, 1);
  assert.equal(defined(messages.at(-1)).message.tradeId, 'BTC-USD:1');
  socket.emitEvent('ping');
  assert.equal(manager.status()['dydx-trades'].heartbeatAckSource, 'protocol-ping');
  socket.emitEvent('pong');
  assert.equal(manager.status()['dydx-trades'].heartbeatAckSource, 'protocol-pong');
  assert.deepEqual(socket.sent.map(value => JSON.parse(value)), [{ type: 'subscribe', channel: 'v4_trades', id: 'BTC-USD' }]);
  socket.emit({ type: 'channel_data', channel: 'v4_trades', id: 'BTC-USD', contents: { trades: [{ id: '3', side: 'SELL', price: '79999', size: '0.2', createdAt: '2026-09-20T12:00:02.000Z' }] } });
  assert.equal(messages.filter(item => item.id === 'dydx-trades').length, 2);
  assert.equal(defined(messages.at(-1)).message.side, 'sell');
  socket.emit({ type: 'error', message: 'bad subscription' });
  assert.equal(manager.status()['dydx-trades'].state, 'backoff');
  const afterError = messages.length;
  socket.emit({ type: 'channel_data', channel: 'v4_trades', id: 'BTC-USD', contents: { trades: [{ id: 'stale', side: 'BUY', price: '1', size: '1', createdAt: '2026-09-20T12:00:03.000Z' }] } });
  assert.equal(messages.length, afterError);
  manager.stop();
});

test('dYdX manager rejects inactive metadata before opening a socket', async () => {
  const fake = transport();
  const manager = new LiveFeedManager({
    networkEnabled: true, transportFactory: fake.factory,
    restTransport: { request: async (request:ExchangeRestRequest) => request.url.includes('/v4/perpetualMarkets') ? markets('PAUSED') : {} },
    transportPolicies: policies(), oiPollMs: 0,
  });
  await manager.start({ dydxEnabled: true, dydxSymbol: 'BTC-USD' });
  assert.equal(fake.sockets.some(item => item.spec.id === 'dydx-trades'), false);
  assert.equal(manager.status()['dydx-trades'].state, 'unavailable');
  assert.match(textValue(manager.status()['dydx-trades'].lastError), /active public perpetual metadata/);
  manager.stop();
});
