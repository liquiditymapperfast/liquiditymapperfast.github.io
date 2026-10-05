import { defined, fields, list, numeric, textValue } from './server-test-helpers.mts';
import type { LiveFeedTransportOptions, LiveFeedSocket, LiveFeedEvent, LiveFeedStatusEvent } from '../src/server/live-feeds.mts';
import type { ExchangeRestRequest } from '../src/server/rest-transport.mts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { LiveFeedManager } from '../src/server/live-feeds.mts';
import {
  buildCoinbaseRequest,
  buildCoinbaseSubscription,
  normalizeCoinbaseDepth,
  normalizeCoinbaseRestDepth,
  normalizeCoinbaseProduct,
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
      if (request.url.includes('/products/BTC-USD')) return { id: 'BTC-USD', base_currency: 'BTC', quote_currency: 'USD', base_increment: '0.00001', quote_increment: '0.01', status: 'online', updated_at: '2026-09-20T00:00:00.000Z' };
      if (request.url.includes('/depth')) return { lastUpdateId: 10, bids: [['100', '2']], asks: [['101', '3']] };
      if (request.url.includes('/exchangeInfo')) return { symbols: [] };
      if ((typeof request.body === 'string' && request.body.includes('metaAndAssetCtxs'))) return [{ universe: [] }, []];
      return {};
    },
  };
}

function subscriptionsAck() { return { type: 'subscriptions', channels: [{ name: 'level2_batch', product_ids: ['BTC-USD'] }] }; }
function snapshot(bid = '100') { return { type: 'snapshot', product_id: 'BTC-USD', bids: [[bid, '2']], asks: [['101', '3']] }; }
function update(size = '1') { return { type: 'l2update', product_id: 'BTC-USD', time: '2026-09-20T00:00:01.000Z', changes: [['buy', '100', size], ['sell', '101', '0']] }; }

test('Coinbase public descriptors and normalizers preserve spot products and provider-guaranteed continuity', () => {
  assert.match(buildCoinbaseRequest('product', { productId: 'BTC-USD' }).url, /api\.exchange\.coinbase\.com\/products\/BTC-USD$/);
  assert.match(buildCoinbaseRequest('depth', { productId: 'BTC-USD', level: 2 }).url, /\/products\/BTC-USD\/book\?level=2$/);
  const subscription = buildCoinbaseSubscription('depth', { productId: 'BTC-USD', channel: 'level2_batch' });
  assert.equal(subscription.url, 'wss://ws-feed.exchange.coinbase.com');
  assert.deepEqual(subscription.args, ['BTC-USD']);
  assert.equal(subscription.topic, 'level2_batch:BTC-USD');

  const metadata = normalizeCoinbaseProduct({ id: 'BTC-USD', base_currency: 'BTC', quote_currency: 'USD', base_increment: '0.00001', quote_increment: '0.01', status: 'online' }, { receivedAt: 1_700_000_000_000 });
  assert.deepEqual(metadata.assets[0], {
    instrumentId: 'coinbase:BTC-USD', venue: 'coinbase', nativeSymbol: 'BTC-USD', symbol: 'BTC-USD', base: 'BTC', quote: 'USD', marketType: 'spot',
    tickSize: 0.01, qtyStep: 0.00001, lotSize: 0.00001, quantityUnit: 'base', status: 'online', isDelisted: false, metadataSource: 'coinbase-exchange-product',
  });
  const normalizedSnapshot = normalizeCoinbaseDepth(snapshot());
  assert.equal(normalizedSnapshot.instrumentId, 'coinbase:BTC-USD');
  assert.equal(fields(normalizedSnapshot).sequence, undefined);
  assert.equal(normalizedSnapshot.continuity, 'provider-guaranteed');
  const normalizedUpdate = normalizeCoinbaseDepth(update());
  assert.equal(normalizedUpdate.bids[0].amount, 1);
  assert.equal(normalizedUpdate.asks[0].amount, 0);
  assert.equal(fields(normalizedUpdate).sequence, undefined);
  const restBook = normalizeCoinbaseRestDepth({ sequence: '12345678901234567890', time: '2026-09-20T00:00:00.000Z', bids: [['100', '2']], asks: [['101', '3']] }, { productId: 'BTC-USD' });
  assert.equal(restBook.sequence, '12345678901234567890');
  assert.equal(restBook.continuity, 'rest-snapshot');
  assert.equal(restBook.bids[0].amount, 2);
  assert.equal(fields(normalizeCoinbaseDepth({ sequence: 12, bids: [['100', '2']], asks: [['101', '3']] }, { productId: 'BTC-USD' })).sequence, 12);
  assert.throws(() => normalizeCoinbaseDepth({ type: 'l2update', product_id: 'BTC-USD', changes: [['hold', '100', '1']] }), /side invalid/);
});

test('Coinbase manager requires matching subscription acknowledgement, filters products, and applies unsequenced level2 updates', async () => {
  const fake = transport(); const rest = restTransport(); const messages:LiveFeedEvent[] = [];
  const manager = new LiveFeedManager({ networkEnabled: true, transportFactory: fake.factory, restTransport: rest, transportPolicies: policies(), oiPollMs: 0, onMessage: message => messages.push(message) });
  await manager.start({ coinbaseEnabled: true, coinbaseSymbol: 'BTC-USD' });
  const socket = defined(fake.sockets.find(item => item.spec.id === 'coinbase-depth'));
  assert.equal(socket.spec.request.url, 'wss://ws-feed.exchange.coinbase.com');
  assert.deepEqual(JSON.parse(defined(socket.sent.at(-1))), { type: 'subscribe', product_ids: ['BTC-USD'], channels: ['level2_batch'] });
  assert.equal(manager.status()['coinbase-metadata'].state, 'snapshot');
  assert.equal(defined(messages.find(item => item.id === 'coinbase-metadata')?.message.assets)[0].qtyStep, 0.00001);

  socket.emit({ type: 'subscriptions', channels: [{ name: 'level2', product_ids: ['BTC-USD'] }] });
  socket.emit({ type: 'snapshot', product_id: 'ETH-USD', bids: [['90', '1']], asks: [['91', '1']] });
  assert.equal(manager.status()['coinbase-depth'].subscriptionAcked, false);
  assert.equal(messages.some(item => item.id === 'coinbase-depth'), false);
  socket.emit(subscriptionsAck());
  socket.emit({ type: 'snapshot', product_id: 'ETH-USD', bids: [['90', '1']], asks: [['91', '1']] });
  socket.emit(snapshot());
  socket.emit(update('1'));
  const depthMessages = messages.filter(item => item.id === 'coinbase-depth');
  assert.equal(depthMessages.filter(item => item.message.kind === 'depthSnapshot').length, 1);
  assert.equal(depthMessages.filter(item => item.message.kind === 'depthDelta').length, 1);
  assert.equal(defined(depthMessages.at(-1)).message.continuity, 'provider-guaranteed');
  assert.equal(defined(depthMessages.at(-1)).message.sequence, undefined);
  assert.equal(manager.status()['coinbase-depth'].state, 'live');
  manager.stop();
});

test('Coinbase close/reconnect fences retired sockets and requires a fresh snapshot', async () => {
  const fake = transport(); const timers:{fn:()=>unknown;delay:number}[] = []; const messages:LiveFeedEvent[] = [];
  const manager = new LiveFeedManager({ networkEnabled: true, transportFactory: fake.factory, transportPolicies: policies(), oiPollMs: 0, reconnectBaseMs: 10, schedule: (fn, delay) => { timers.push({ fn, delay }); return timers.length; }, cancel: () => {}, onMessage: message => messages.push(message) });
  await manager.start({ coinbaseEnabled: true, coinbaseSymbol: 'BTC-USD' });
  const first = defined(fake.sockets.find(item => item.spec.id === 'coinbase-depth'));
  first.emit(subscriptionsAck()); first.emit(snapshot()); first.emit(update('2'));
  const before = messages.filter(item => item.id === 'coinbase-depth' && item.message.kind === 'depthDelta').length;
  first.closeWith('lost');
  assert.equal(first.closed, true);
  assert.equal(manager.status()['coinbase-depth'].state, 'backoff');
  first.emit(snapshot('99'));
  assert.equal(messages.filter(item => item.id === 'coinbase-depth' && item.message.kind === 'depthSnapshot' && item.message.complete === false).length, 1);
  await defined(timers.find(timer => timer.delay === 10)).fn();
  const second = defined(fake.sockets.filter(item => item.spec.id === 'coinbase-depth').at(-1));
  assert.notStrictEqual(second, first);
  assert.equal(manager.status()['coinbase-depth'].state, 'snapshot');
  first.emit(update('99'));
  assert.equal(messages.filter(item => item.id === 'coinbase-depth' && item.message.kind === 'depthDelta').length, before);
  second.emit(subscriptionsAck());
  second.emit(update('3'));
  assert.equal(messages.filter(item => item.id === 'coinbase-depth' && item.message.kind === 'depthDelta').length, before);
  second.emit(snapshot('98'));
  second.emit(update('4'));
  assert.equal(messages.filter(item => item.id === 'coinbase-depth' && item.message.kind === 'depthDelta').length, before + 1);
  manager.stop();
});
