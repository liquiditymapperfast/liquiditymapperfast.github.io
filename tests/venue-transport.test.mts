import test from 'node:test';
import assert from 'node:assert/strict';
import { VenueHeartbeatDeadline, VenueTransportBudget, convertVenueQuantity, discoverProductPages, reconnectDelay, venueControlFrame, venueHeartbeatFrame } from '../src/adapters/index.mts';

test('venue control frames are venue-native and unsubscribe is symmetrical', () => {
  const request = { args: [{ channel: 'books', instId: 'BTC-USDT-SWAP' }] };
  assert.deepEqual(venueControlFrame('okx', request), { op: 'subscribe', args: request.args });
  assert.deepEqual(venueControlFrame('okx', request, 'unsubscribe'), { op: 'unsubscribe', args: request.args });
  const gateRequest = { channel: 'futures.order_book', args: ['BTC_USDT', '100', '0'] };
  assert.deepEqual(venueControlFrame('gateio', gateRequest, 'subscribe', { now: 1_000 }), { time: 1, channel: 'futures.order_book', event: 'subscribe', payload: gateRequest.args });
  assert.deepEqual(venueControlFrame('gateio', gateRequest, 'unsubscribe', { now: 1_000 }), { time: 1, channel: 'futures.order_book', event: 'unsubscribe', payload: gateRequest.args });
  assert.deepEqual(venueControlFrame('deribit', { args: ['book.BTC-PERPETUAL.none.20.100ms'] }, 'unsubscribe'), { jsonrpc: '2.0', id: 1, method: 'public/unsubscribe', params: { channels: ['book.BTC-PERPETUAL.none.20.100ms'] } });
  assert.equal(venueControlFrame('binance', { stream: 'btcusdt@depth' }), null);
  const coinbaseRequest = { args: ['BTC-USD'], channel: 'level2_batch' };
  assert.deepEqual(venueControlFrame('coinbase', coinbaseRequest), { type: 'subscribe', product_ids: ['BTC-USD'], channels: ['level2_batch'] });
  assert.deepEqual(venueControlFrame('coinbase', coinbaseRequest, 'unsubscribe'), { type: 'unsubscribe', product_ids: ['BTC-USD'], channels: ['level2_batch'] });
  assert.equal(venueHeartbeatFrame('coinbase'), null);
  const krakenRequest = { args: ['BTC/USD'], symbol: 'BTC/USD', channel: 'book', depth: 100, snapshot: true };
  assert.deepEqual(venueControlFrame('kraken', krakenRequest), { method: 'subscribe', params: { channel: 'book', symbol: ['BTC/USD'], depth: 100, snapshot: true } });
  assert.deepEqual(venueControlFrame('kraken', krakenRequest, 'unsubscribe'), { method: 'unsubscribe', params: { channel: 'book', symbol: ['BTC/USD'], depth: 100 } });
  assert.equal(venueHeartbeatFrame('kraken'), null);
  const kucoinRequest = { id: '1', topic: '/spotMarket/level2Depth50:BTC-USDT', channel: 'level2Depth50' };
  assert.deepEqual(venueControlFrame('kucoin', kucoinRequest), { id: '1', type: 'subscribe', topic: '/spotMarket/level2Depth50:BTC-USDT', response: true });
  assert.deepEqual(venueControlFrame('kucoin', kucoinRequest, 'unsubscribe'), { id: '1', type: 'unsubscribe', topic: '/spotMarket/level2Depth50:BTC-USDT', response: true });
  const mexcRequest = { method: 'sub.depth.full', param: { symbol: 'BTC_USDT', limit: 20 }, symbol: 'BTC_USDT' };
  assert.deepEqual(venueControlFrame('mexc', mexcRequest), { method: 'sub.depth.full', param: { symbol: 'BTC_USDT', limit: 20 } });
  assert.deepEqual(venueControlFrame('mexc', mexcRequest, 'unsubscribe'), { method: 'usub.depth.full', param: { symbol: 'BTC_USDT' } });
  const htxRequest = { sub: 'market.BTC-USDT.depth.step6', topic: 'market.BTC-USDT.depth.step6', id: '1' };
  assert.deepEqual(venueControlFrame('htx', htxRequest), { sub: 'market.BTC-USDT.depth.step6', id: '1' });
  assert.deepEqual(venueControlFrame('htx', htxRequest, 'unsubscribe'), { unsub: 'market.BTC-USDT.depth.step6', id: '1' });
  const bitfinexRequest = { channel: 'book', symbol: 'tBTCUSD', precision: 'P0', frequency: 'F0', len: '25', subId: 'bitfinex-BTCUSD', channelId: 42 };
  assert.deepEqual(venueControlFrame('bitfinex', bitfinexRequest), { event: 'subscribe', channel: 'book', symbol: 'tBTCUSD', prec: 'P0', freq: 'F0', len: '25', subId: 'bitfinex-BTCUSD' });
  assert.deepEqual(venueControlFrame('bitfinex', bitfinexRequest, 'unsubscribe'), { event: 'unsubscribe', chanId: 42 });
  const bitmexRequest = { args: ['orderBookL2_25:XBTUSD'], channel: 'orderBookL2_25' };
  assert.deepEqual(venueControlFrame('bitmex', bitmexRequest), { op: 'subscribe', args: bitmexRequest.args });
  assert.deepEqual(venueControlFrame('bitmex', bitmexRequest, 'unsubscribe'), { op: 'unsubscribe', args: bitmexRequest.args });
  const cryptocomRequest = { id: 1, topic: 'book.BTCUSD-PERP.10', params: { channels: ['book.BTCUSD-PERP.10'], book_subscription_type: 'SNAPSHOT_AND_UPDATE', book_update_frequency: 100 } };
  assert.deepEqual(venueControlFrame('cryptocom', cryptocomRequest), { id: 1, method: 'subscribe', params: cryptocomRequest.params });
  assert.deepEqual(venueControlFrame('cryptocom', cryptocomRequest, 'unsubscribe'), { id: 1, method: 'unsubscribe', params: { channels: cryptocomRequest.params.channels } });
  const bitstampRequest = { channel: 'order_book_btcusd', topic: 'order_book_btcusd' };
  assert.deepEqual(venueControlFrame('bitstamp', bitstampRequest), { event: 'bts:subscribe', data: { channel: 'order_book_btcusd' } });
  assert.deepEqual(venueControlFrame('bitstamp', bitstampRequest, 'unsubscribe'), { event: 'bts:unsubscribe', data: { channel: 'order_book_btcusd' } });
  const phemexRequest = { id: 1, method: 'orderbook.subscribe', params: ['sBTCUSDT', true] };
  assert.deepEqual(venueControlFrame('phemex', phemexRequest), phemexRequest);
  assert.deepEqual(venueControlFrame('phemex', phemexRequest, 'unsubscribe'), { id: 1, method: 'orderbook.unsubscribe', params: [] });
  const dydxRequest = { channel: 'v4_trades', id: 'BTC-USD' };
  assert.deepEqual(venueControlFrame('dydx', dydxRequest), { type: 'subscribe', channel: 'v4_trades', id: 'BTC-USD' });
  assert.deepEqual(venueControlFrame('dydx', dydxRequest, 'unsubscribe'), { type: 'unsubscribe', channel: 'v4_trades', id: 'BTC-USD' });
  const asterRequest = { params: ['btcusdt@aggTrade'], id: 1 };
  assert.deepEqual(venueControlFrame('aster', asterRequest), { method: 'SUBSCRIBE', params: ['btcusdt@aggTrade'], id: 1 });
  assert.deepEqual(venueControlFrame('aster', asterRequest, 'unsubscribe'), { method: 'UNSUBSCRIBE', params: ['btcusdt@aggTrade'], id: 1 });
});

test('heartbeats and reconnect delay retain venue semantics and bounds', () => {
  assert.deepEqual(venueHeartbeatFrame('hyperliquid'), { method: 'ping' });
  assert.deepEqual(venueHeartbeatFrame('bybit'), { op: 'ping' });
  assert.deepEqual(venueHeartbeatFrame('gateio', { now: 1_000 }), { time: 1, channel: 'futures.ping' });
  assert.equal(venueHeartbeatFrame('bitget'), 'ping');
  assert.deepEqual(venueHeartbeatFrame('kucoin', { requestId: '7' }), { id: '7', type: 'ping' });
  assert.deepEqual(venueHeartbeatFrame('mexc'), { method: 'ping' });
  assert.deepEqual(venueHeartbeatFrame('htx', { now: 1_000 }), { ping: 1_000 });
  assert.equal(venueHeartbeatFrame('bitfinex'), null);
  assert.equal(venueHeartbeatFrame('bitmex'), 'ping');
  assert.equal(venueHeartbeatFrame('cryptocom'), null);
  assert.deepEqual(venueHeartbeatFrame('bitstamp'), { event: 'bts:heartbeat' });
  assert.deepEqual(venueHeartbeatFrame('phemex'), { id: 0, method: 'server.ping', params: [] });
  assert.equal(venueHeartbeatFrame('dydx'), null);
  assert.equal(venueHeartbeatFrame('aster'), null);
  assert.equal(reconnectDelay(4, { baseMs: 100, maxMs: 500 }), 500);
  assert.equal(reconnectDelay(2, { baseMs: 100, maxMs: 500, jitter: 0.25, random: () => 0 }), 150);
  assert.equal(reconnectDelay(20, { baseMs: 100, maxMs: 500, jitter: 1, random: () => 1 }), 500);
});

test('heartbeat deadline requests a venue heartbeat then fails closed on silence', () => {
  let now = 1_000; const deadline = new VenueHeartbeatDeadline({ venue: 'bybit', now: () => now, policies: { bybit: { heartbeatIntervalMs: 100, heartbeatTimeoutMs: 50 } } });
  deadline.heartbeatSent(now); now = 1_100;
  assert.deepEqual(deadline.nextAction(), { action: 'heartbeat', frame: { op: 'ping' } });
  deadline.heartbeatSent(now); deadline.observe(now); now = 1_251;
  assert.deepEqual(deadline.nextAction(), { action: 'reconnect', reason: 'heartbeat-timeout' });
});

test('per-venue budgets stagger messages and reject excess connections independently', () => {
  let now = 1_000; const budget = new VenueTransportBudget({ now: () => now, policies: { okx: { maxConnections: 1, subscribeIntervalMs: 200 } } });
  budget.acquireConnection('okx'); assert.throws(() => budget.acquireConnection('okx'), /budget exhausted/);
  budget.acquireConnection('bitget');
  assert.deepEqual(budget.planMessage('okx'), { at: 1_000, delayMs: 0 });
  assert.deepEqual(budget.planMessage('okx'), { at: 1_200, delayMs: 200 });
  budget.touch('okx', 'BTC'); now = 2_000; assert.deepEqual(budget.idleSubscriptions('okx', 500), ['BTC']);
  budget.removeSubscription('okx', 'BTC'); budget.releaseConnection('okx'); assert.equal(budget.snapshot().okx.connections, 0);
});

test('product discovery follows cursors, deduplicates native IDs, and preserves delisted metadata', async () => {
  const pages = new Map([[null, { assets: [{ instrumentId: 'x:A', nativeSymbol: 'A', tickSize: 0.1, lotSize: 1, isDelisted: false }], nextPageCursor: 'two' }], ['two', { assets: [{ instrumentId: 'x:A', nativeSymbol: 'A', tickSize: 0.1, lotSize: 1, isDelisted: true }, { instrumentId: 'x:B', nativeSymbol: 'B', tickSize: 1, lotSize: 10, isDelisted: false }] }]]);
  const result = await discoverProductPages({ fetchPage: cursor => pages.get(cursor as string | null) });
  assert.equal(result.pages, 2); assert.deepEqual(result.assets.map(asset => [asset.instrumentId, asset.isDelisted]), [['x:A', true], ['x:B', false]]);
});

test('product discovery rejects repeated cursors and bounded-page overflow', async () => {
  await assert.rejects(
    discoverProductPages({ fetchPage: async () => ({ assets: [], nextPageCursor: 'same' }), firstCursor: 'same' }),
    /cursor repeated/,
  );
  await assert.rejects(
    discoverProductPages({ fetchPage: async cursor => ({ assets: [], nextPageCursor: cursor == null ? 'two' : 'three' }), maxPages: 2 }),
    /exceeded maxPages/,
  );
});

test('unit conversion distinguishes base, quote, linear contracts, and inverse contracts', () => {
  assert.deepEqual(convertVenueQuantity({ amount: 2, price: 100, quantityUnit: 'base' }), { baseAmount: 2, quoteAmount: 200 });
  assert.deepEqual(convertVenueQuantity({ amount: 200, price: 100, quantityUnit: 'quote' }), { baseAmount: 2, quoteAmount: 200 });
  assert.deepEqual(convertVenueQuantity({ amount: 3, price: 100, quantityUnit: 'contract', contractValue: 0.01 }), { baseAmount: 0.03, quoteAmount: 3 });
  assert.deepEqual(convertVenueQuantity({ amount: 3, price: 100, quantityUnit: 'contract', contractValue: 10, inverse: true }), { baseAmount: 0.3, quoteAmount: 30 });
  assert.throws(() => convertVenueQuantity({ amount: 1, price: 100, quantityUnit: 'contract' }), /contractValue/);
});
