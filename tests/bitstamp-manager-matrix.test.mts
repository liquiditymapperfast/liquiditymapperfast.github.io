import { defined, fields, list, numeric, textValue } from './server-test-helpers.mts';
import type { LiveFeedTransportOptions, LiveFeedSocket, LiveFeedEvent, LiveFeedStatusEvent } from '../src/server/live-feeds.mts';
import type { ExchangeRestRequest } from '../src/server/rest-transport.mts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { LiveFeedManager } from '../src/server/live-feeds.mts';
import {
  VENUE_TRANSPORT_POLICIES,
  applyPublicDepthSessionMessage,
  buildBitstampRequest,
  buildBitstampSubscription,
  createPublicDepthSession,
  normalizeBitstampDepth,
  normalizeBitstampTradingPairs,
} from '../src/adapters/index.mts';

class FakeSocket {
  declare spec:LiveFeedTransportOptions; declare sent:string[]; declare closed:boolean; declare opened?:boolean;
  declare onMessage:((raw:unknown)=>void)|undefined; declare onClose:((reason:unknown)=>void)|undefined; declare onError:((error:unknown)=>void)|undefined;
  constructor(spec:LiveFeedTransportOptions) { this.spec = spec; this.sent = []; this.closed = false; }
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

function policiesWithHeartbeat(interval = 60_000, timeout = 60_000) {
  const policies = Object.fromEntries(Object.entries(VENUE_TRANSPORT_POLICIES).map(([venue, policy]) => [venue, { ...policy, subscribeIntervalMs: 0, heartbeatIntervalMs: 60_000, heartbeatTimeoutMs: 60_000 }]));
  policies.bitstamp = { ...policies.bitstamp, heartbeatIntervalMs: interval, heartbeatTimeoutMs: timeout };
  return policies;
}

function restTransport() {
  const requests:ExchangeRestRequest[] = [];
  return {
    requests,
    request: async (request:ExchangeRestRequest) => {
      requests.push(request);
      if (request.url.includes('/markets/')) return [
        { market_symbol: 'btcusd', base_currency: 'BTC', counter_currency: 'USD', base_decimals: 8, counter_decimals: 2, market_type: 'SPOT', trading: 'Enabled', tick_size: '0.01' },
        { market_symbol: 'btcusd-perp', base_currency: 'BTC', counter_currency: 'USD', base_decimals: 8, counter_decimals: 2, market_type: 'PERPETUAL', trading: 'Enabled' },
      ];
      if (request.url.includes('/order_book/')) return { timestamp: '1700000000', microtimestamp: '1700000000123456', bids: [['100', '3']], asks: [['101', '2']] };
      if (request.url.includes('/exchangeInfo')) return { symbols: [] };
      if ((typeof request.body === 'string' && request.body.includes('metaAndAssetCtxs'))) return [{ universe: [] }, []];
      return {};
    },
  };
}

function snapshotFrame({ symbol = 'btcusd', bid = '100', ask = '101' } = {}) {
  const channel = `order_book_${symbol}`;
  return { event: 'data', channel, data: { timestamp: '1700000001', microtimestamp: '1700000001123456', bids: [[bid, '3']], asks: [[ask, '2']] } };
}

test('Bitstamp descriptors, metadata, REST snapshot, and provider full snapshots normalize exactly', () => {
  assert.equal(buildBitstampRequest('markets').url, 'https://www.bitstamp.net/api/v2/markets/');
  assert.equal(buildBitstampRequest('tradingPairs').url, 'https://www.bitstamp.net/api/v2/markets/');
  assert.equal(buildBitstampRequest('depth', { symbol: 'BTC/USD' }).url, 'https://www.bitstamp.net/api/v2/order_book/btcusd/');
  assert.throws(() => buildBitstampSubscription('depth', { depth: 25 }), /depth/);
  assert.deepEqual(buildBitstampSubscription('depth', { symbol: 'BTC/USD' }), {
    url: 'wss://ws.bitstamp.net/', method: 'subscribe', op: 'subscribe', event: 'bts:subscribe',
    data: { channel: 'order_book_btcusd' }, channel: 'order_book_btcusd', topic: 'order_book_btcusd',
    symbol: 'BTCUSD', args: ['order_book_btcusd'], depth: 100, snapshot: true,
  });
  const metadata = normalizeBitstampTradingPairs([
    { market_symbol: 'btcusd', base_currency: 'BTC', counter_currency: 'USD', base_decimals: 8, counter_decimals: 2, market_type: 'SPOT', trading: 'Enabled', tick_size: '0.01' },
    { market_symbol: 'btcusd-perp', base_currency: 'BTC', counter_currency: 'USD', base_decimals: 8, counter_decimals: 2, market_type: 'PERPETUAL', trading: 'Enabled' },
    { market_symbol: 'btcrlusd', base_currency: 'BTC', counter_currency: 'RLUSD', base_decimals: 8, counter_decimals: 2, market_type: 'SPOT', trading: 'Enabled', tick_size: '0.01' },
  ], { receivedAt: 1_700_000_000_000 });
  assert.equal(metadata.sourceTimestamp, null);
  assert.equal(metadata.receivedAt, 1_700_000_000_000);
  assert.equal(metadata.assets[0].instrumentId, 'bitstamp:BTCUSD');
  assert.equal(metadata.assets[0].marketType, 'spot');
  assert.equal(metadata.assets[0].tickSize, 0.01);
  assert.equal(metadata.assets[0].lotSize, 1e-8);
  assert.equal(metadata.assets.some(asset => asset.instrumentId === 'bitstamp:BTCRLUSD'), true);
  assert.equal(defined(metadata.assets.find(asset => asset.instrumentId === 'bitstamp:BTCRLUSD')).quote, 'RLUSD');
  assert.equal(metadata.assets.some(asset => asset.instrumentId === 'bitstamp:BTCUSD-PERP'), false);
  const rest = normalizeBitstampDepth({ timestamp: '1700000000', microtimestamp: '1700000000123456', bids: [['100', '3']], asks: [['101', '2']] }, { symbol: 'btcusd', receivedAt: 1_700_000_000_500 });
  assert.equal(rest.kind, 'depthSnapshot');
  assert.equal(rest.sourceTimestamp, 1_700_000_000_123);
  assert.equal(rest.continuity, 'provider-snapshot');
  const websocket = normalizeBitstampDepth(snapshotFrame(), { symbol: 'btcusd', requireChannel: true });
  assert.equal(websocket.bids[0].price, 100);
  assert.equal(websocket.asks[0].amount, 2);
  assert.throws(() => normalizeBitstampDepth({ ...snapshotFrame(), channel: 'order_book_ethusd' }, { symbol: 'btcusd', requireChannel: true }), /channel/);
});

test('Bitstamp full-snapshot session is unsequenced, fresh after reconnect, and session-fenced', () => {
  const session = createPublicDepthSession({ venue: 'bitstamp', topic: 'order_book_btcusd', instrumentId: 'bitstamp:BTCUSD', sessionToken: 'bitstamp-depth:1', allowUnsequenced: true });
  const snapshot = normalizeBitstampDepth(snapshotFrame(), { symbol: 'btcusd', requireChannel: true });
  const accepted = applyPublicDepthSessionMessage(session, { topic: session.topic, sessionToken: session.sessionToken, update: snapshot });
  assert.equal(accepted.accepted, true);
  assert.equal(defined(accepted.session.book).continuity, 'provider-snapshot');
  assert.equal(defined(accepted.session.book).sequence, undefined);
  const replaced = applyPublicDepthSessionMessage(accepted.session, { topic: session.topic, sessionToken: session.sessionToken, update: normalizeBitstampDepth(snapshotFrame({ bid: '99' }), { symbol: 'btcusd', requireChannel: true }) });
  assert.equal(replaced.accepted, true);
  assert.equal(defined(replaced.session.book).bids[0].price, 99);
  const late = applyPublicDepthSessionMessage(replaced.session, { topic: session.topic, sessionToken: 'bitstamp-depth:old', update: snapshot });
  assert.equal(late.reason, 'cross-session');
});

test('Bitstamp manager validates subscription/channel fencing, routes full snapshots, and answers heartbeat', async () => {
  const fake = transport(); const rest = restTransport(); const messages:LiveFeedEvent[] = [];
  const manager = new LiveFeedManager({ networkEnabled: true, transportFactory: fake.factory, restTransport: rest, transportPolicies: policiesWithHeartbeat(), oiPollMs: 0, reconnectBaseMs: 10, schedule: fn => ({ fn }), cancel: () => {}, onMessage: message => messages.push(message) });
  await manager.start({ bitstampEnabled: true, bitstampSymbol: 'btcusd' });
  const socket = defined(fake.sockets.find(item => item.spec.id === 'bitstamp-depth'));
  assert.equal(socket.spec.request.url, 'wss://ws.bitstamp.net/');
  assert.deepEqual(JSON.parse(defined(socket.sent.at(-1))), { event: 'bts:subscribe', data: { channel: 'order_book_btcusd' } });
  socket.emit(snapshotFrame());
  assert.equal(manager.status()['bitstamp-depth'].subscriptionAcked, false);
  assert.equal(messages.some(item => item.id === 'bitstamp-depth'), false);
  socket.emit({ event: 'bts:subscription_succeeded', channel: 'order_book_btcusd', data: {} });
  assert.equal(manager.status()['bitstamp-depth'].subscriptionAcked, true);
  socket.emit(snapshotFrame());
  assert.equal(messages.some(item => item.id === 'bitstamp-depth' && item.message.kind === 'depthSnapshot' && item.message.instrumentId === 'bitstamp:BTCUSD'), true);
  socket.emit({ event: 'bts:heartbeat', data: { timestamp: '1700000002' } });
  await Promise.resolve();
  assert.deepEqual(JSON.parse(defined(socket.sent.at(-1))), { event: 'bts:heartbeat' });
  assert.equal(manager.status()['bitstamp-depth'].heartbeatAckSource, 'server-heartbeat');
  const sentBeforeSuccess = socket.sent.length;
  socket.emit({ event: 'bts:heartbeat', data: { status: 'success' } });
  await Promise.resolve();
  assert.equal(socket.sent.length, sentBeforeSuccess);
  assert.equal(manager.status()['bitstamp-depth'].heartbeatAckSource, 'server-heartbeat');
  manager.stop();
});

test('Bitstamp manager fences wrong subscription acknowledgement and stale socket frames', async () => {
  const fake = transport(); const manager = new LiveFeedManager({ networkEnabled: true, transportFactory: fake.factory, restTransport: restTransport(), transportPolicies: policiesWithHeartbeat(), oiPollMs: 0, reconnectBaseMs: 10, schedule: fn => ({ fn }), cancel: () => {} });
  await manager.start({ bitstampEnabled: true, bitstampSymbol: 'btcusd' });
  const first = defined(fake.sockets.find(item => item.spec.id === 'bitstamp-depth'));
  first.emit({ event: 'bts:subscription_succeeded', channel: 'order_book_ethusd', data: {} });
  assert.equal(manager.status()['bitstamp-depth'].subscriptionAcked, false);
  first.emit({ event: 'bts:subscription_succeeded', channel: 'order_book_btcusd', data: {} });
  first.emit(snapshotFrame());
  first.closeWith('forced');
  assert.equal(manager.status()['bitstamp-depth'].state, 'backoff');
  first.emit(snapshotFrame({ bid: '98' }));
  assert.equal(manager.status()['bitstamp-depth'].state, 'backoff');
  manager.stop();
});

test('Bitstamp server-heartbeat mode does not self-observe a silent socket', async () => {
  let clock = 0; const fake = transport(); const timers:{fn:()=>unknown;delay:number}[] = [];
  const manager = new LiveFeedManager({ networkEnabled: true, transportFactory: fake.factory, restTransport: restTransport(), transportPolicies: policiesWithHeartbeat(100, 50), now: () => clock, transportNow: () => clock, oiPollMs: 0, reconnectBaseMs: 10, schedule: fn => ({ fn }), cancel: () => {}, heartbeatSchedule: (fn, delay) => { const timer = { fn, delay }; timers.push(timer); return timer; }, heartbeatCancel: () => {} });
  await manager.start({ bitstampEnabled: true, bitstampSymbol: 'btcusd' });
  const socket = defined(fake.sockets.find(item => item.spec.id === 'bitstamp-depth'));
  socket.emit({ event: 'bts:subscription_succeeded', channel: 'order_book_btcusd', data: {} });
  clock = 100;
  await defined(timers.find(timer => timer.delay === 100)).fn();
  assert.equal(socket.sent.some(value => String(value).includes('heartbeat')), true);
  assert.equal(manager.status()['bitstamp-depth'].serverHeartbeat, true);
  clock = 151;
  await defined(timers.at(-1)).fn();
  assert.equal(manager.status()['bitstamp-depth'].state, 'backoff');
  manager.stop();
});
