import test from 'node:test';
import assert from 'node:assert/strict';
import { LiveFeedManager, MAX_LIVE_FEED_MESSAGE_BYTES, type LiveFeedOptions, type LiveFeedTransportOptions, type LiveFeedEvent } from '../src/server/live-feeds.mts';
import { VENUE_TRANSPORT_POLICIES } from '../src/adapters/index.mts';
import { ProcessMemoryMonitor } from '../src/server/process-memory.mts';
import { defined, fields } from './server-test-helpers.mts';

class Socket {
  readonly sent: string[] = [];
  closed = false;
  onMessage?: (raw: unknown) => void;
  onClose?: (reason: unknown) => void;
  onError?: (error: unknown) => void;
  constructor(readonly spec: LiveFeedTransportOptions) {}
  open() {}
  send(value: string) { this.sent.push(value); }
  close() { this.closed = true; }
  emit(value: unknown) { this.onMessage?.(JSON.stringify(value)); }
}
function dydxMarkets(status = 'ACTIVE') {
  return { markets: { 'BTC-USD': { ticker: 'BTC-USD', status, tickSize: '1', stepSize: '0.001', atomicResolution: -10 } } };
}
function asterMarkets(status = 'TRADING', overrides: Record<string, unknown> = {}) {
  return { symbols: [{ symbol: 'BTCUSDT', status, contractType: 'PERPETUAL', baseAsset: 'BTC', quoteAsset: 'USDT', marginAsset: 'USDT',
    filters: [{ filterType: 'PRICE_FILTER', tickSize: '0.1' }, { filterType: 'LOT_SIZE', stepSize: '0.001' }], ...overrides }] };
}
function dydx(sequence: number, snapshot = false, overrides: Record<string, unknown> = {}) {
  return { type: snapshot ? 'subscribed' : 'channel_data', channel: 'v4_orderbook', id: 'BTC-USD', connection_id: 'connection-1', message_id: sequence,
    contents: snapshot ? { bids: [{ price: '100', size: '2' }], asks: [{ price: '101', size: '3' }] } : { bids: [{ price: '100', size: '0' }, { price: '99', size: '4' }] }, ...overrides };
}
function aster(sequence = 12, overrides: Record<string, unknown> = {}) {
  return { e: 'depthUpdate', E: 1_789_902_444_600, T: 1_789_902_444_599, s: 'BTCUSDT', U: sequence - 1, u: sequence, pu: sequence - 2,
    b: [['100', '2']], a: [['101', '3']], ...overrides };
}
function harness(options: Partial<LiveFeedOptions> = {}, nativeStatus = true) {
  const sockets: Socket[] = [], messages: LiveFeedEvent[] = [], timers: { callback: () => unknown; delay: number }[] = [];
  const manager = new LiveFeedManager({ networkEnabled: true, oiPollMs: 0, reconnectBaseMs: 10,
    transportFactory: async spec => { const socket = new Socket(spec); sockets.push(socket); return socket; },
    transportPolicies: Object.fromEntries(Object.entries(VENUE_TRANSPORT_POLICIES).map(([venue, policy]) => [venue, { ...policy, subscribeIntervalMs: 0 }])),
    restTransport: { request: async request => request.url.includes('/v4/perpetualMarkets') ? dydxMarkets(nativeStatus ? 'ACTIVE' : 'PAUSED')
      : request.url.includes('asterdex.com/fapi/v1/exchangeInfo') ? asterMarkets(nativeStatus ? 'TRADING' : 'BREAK') : {} },
    schedule: (callback, delay) => { const timer = { callback, delay }; timers.push(timer); return timer; }, cancel: () => {},
    heartbeatSchedule: () => 1, heartbeatCancel: () => {}, retainedAdmission: (_candidate, _context, commit) => { commit(); return { admitted: true }; }, onMessage: event => { messages.push(event); }, ...options });
  const socket = (id: string) => defined(sockets.find(item => item.spec.id === id));
  const books = (id: string) => messages.filter(event => event.id === id && event.message.kind.startsWith('depth') && event.message.invalidated !== true);
  return { manager, sockets, messages, timers, socket, books };
}
const both = { dydxEnabled: true, dydxSymbol: 'BTC-USD', asterEnabled: true, asterSymbol: 'BTCUSDT', selectedOrderbookVenues: ['dydx', 'aster'] };

test('manager creates metadata-backed depth specs, exact subscriptions, ACK gates and full native roots', async () => {
  const h = harness();
  await h.manager.start(both);
  const d = h.socket('dydx-depth'), a = h.socket('aster-depth');
  assert.equal(h.manager.specs.get('dydx-depth')?.publicDepth, true);
  assert.equal(h.manager.specs.get('aster-depth')?.publicDepth, true);
  assert.deepEqual(JSON.parse(defined(d.sent.at(-1))), { type: 'subscribe', channel: 'v4_orderbook', id: 'BTC-USD', batched: false });
  assert.deepEqual(JSON.parse(defined(a.sent.at(-1))), { method: 'SUBSCRIBE', params: ['btcusdt@depth20@100ms'], id: 2 });
  d.emit(dydx(2)); a.emit(aster());
  assert.equal(h.books('dydx-depth').length, 0); assert.equal(h.books('aster-depth').length, 0);
  d.emit(dydx(2, true, { channel: 'v4_trades' })); a.emit({ result: null, id: 1 });
  assert.equal(h.manager.status()['dydx-depth'].subscriptionAcked, false);
  assert.equal(h.manager.status()['aster-depth'].subscriptionAcked, false);
  d.emit(dydx(2, true)); a.emit({ result: null, id: 2 }); a.emit(aster());
  const db = h.books('dydx-depth')[0].message, ab = h.books('aster-depth')[0].message;
  assert.equal(db.sourceTimestamp, null);
  assert.equal(db.units, 'base'); assert.equal(db.market?.quote, 'USD');
  assert.equal(ab.coverage, 'partial'); assert.equal(ab.sourceDepth, 20); assert.equal(ab.market?.quote, 'USDT');
  assert.equal(fields(db.payload).connection_id, 'connection-1');
  assert.equal(h.manager.status()['dydx-depth'].state, 'live');
  assert.equal(h.manager.status()['aster-depth'].state, 'live');
  const sets = fields(h.manager.status()['active-book-set'].activeBookSets);
  assert.deepEqual(Object.keys(sets).sort(), ['aster:BTCUSDT', 'dydx:BTC-USD']);
  assert.ok(h.sockets.some(socket => socket.spec.id === 'binance-markPrice'));
  assert.ok(h.sockets.some(socket => socket.spec.id === 'binance-kline'));
  assert.ok(h.sockets.some(socket => socket.spec.id === 'hl-candle'));
  assert.equal(h.sockets.some(socket => socket.spec.channel === 'l2Book' || socket.spec.id === 'binance-depth'), false);
  h.manager.stop();
});

test('dYdX counter updates apply zero deletions once and a gap requires reconnect/snapshot', async () => {
  const h = harness(); await h.manager.start({ ...both, selectedOrderbookVenues: ['dydx'] });
  const old = h.socket('dydx-depth'); old.emit(dydx(2, true)); old.emit(dydx(3)); old.emit(dydx(3));
  assert.equal(h.books('dydx-depth').length, 2);
  assert.deepEqual(defined(h.manager.feeds.get('dydx-depth')?.session?.book).bids, [{ price: 99, amount: 4 }]);
  old.emit(dydx(5));
  assert.equal(old.closed, true); assert.equal(h.manager.status()['dydx-depth'].state, 'backoff');
  assert.equal(h.messages.some(event => event.id === 'dydx-depth' && event.message.resyncRequired === true), true);
  assert.equal(h.timers.length, 1);
  old.emit(dydx(6)); assert.equal(h.books('dydx-depth').length, 2);
  await h.timers[0].callback();
  const next = defined(h.sockets.filter(socket => socket.spec.id === 'dydx-depth').at(-1));
  assert.notStrictEqual(next, old);
  next.emit(dydx(8)); assert.equal(h.books('dydx-depth').length, 2);
  next.emit(dydx(2, true, { connection_id: 'connection-2' }));
  next.emit(dydx(3, false, { connection_id: 'connection-2' }));
  assert.equal(h.books('dydx-depth').length, 4);
  old.emit(dydx(7, true)); assert.equal(h.books('dydx-depth').length, 4);
  h.manager.stop();
});

test('dYdX provider connection substitution or sequence rewind cannot replace an accepted book', async () => {
  for (const invalid of [dydx(3, false, { connection_id: 'different' }), dydx(1)]) {
    const h = harness(); await h.manager.start({ ...both, selectedOrderbookVenues: ['dydx'] });
    const socket = h.socket('dydx-depth'); socket.emit(dydx(2, true)); socket.emit(invalid);
    assert.equal(h.books('dydx-depth').length, 1); assert.equal(socket.closed, true);
    assert.equal(h.manager.status()['dydx-depth'].state, 'backoff'); h.manager.stop();
  }
});

test('Aster snapshots replace the entire partial domain; skipped IDs are safe, duplicates/rewinds are fenced', async () => {
  const h = harness(); await h.manager.start({ ...both, selectedOrderbookVenues: ['aster'] });
  const socket = h.socket('aster-depth'); socket.emit({ result: null, id: 2 }); socket.emit(aster(12));
  socket.emit({ stream: 'ethusdt@depth20@100ms', data: aster(20) });
  socket.emit(aster(20, { s: 'ETHUSDT' }));
  socket.emit({ stream: 'btcusdt@depth20@100ms', data: aster(30, { b: [['98', '4']], a: [['102', '5']] }) });
  socket.emit(aster(30, { b: [['90', '9']] }));
  assert.equal(h.books('aster-depth').length, 2);
  const book = defined(h.manager.feeds.get('aster-depth')?.session?.book);
  assert.deepEqual(book.bids, [{ price: 98, amount: 4 }]); assert.deepEqual(book.asks, [{ price: 102, amount: 5 }]);
  assert.equal(fields(book).coverage, 'partial'); assert.equal(fields(book).sourceDepth, 20);
  socket.emit(aster(29));
  assert.equal(socket.closed, true); assert.equal(h.manager.status()['aster-depth'].state, 'backoff');
  h.manager.stop();
});

test('depth publication rejection never commits the candidate manager book', async () => {
  const rejected: LiveFeedEvent[] = [];
  const h = harness({ onMessage: event => {
    if (event.id === 'dydx-depth' && event.message.invalidated !== true) { rejected.push(event); return false; }
  } });
  await h.manager.start({ ...both, selectedOrderbookVenues: ['dydx'] });
  const feed = defined(h.manager.feeds.get('dydx-depth'));
  h.socket('dydx-depth').emit(dydx(2, true));
  assert.equal(rejected.length, 1);
  assert.equal(rejected[0].retainedMutation?.committed, false);
  assert.ok(feed.session?.book == null, 'rejected candidate never becomes an accepted retained book');
  assert.equal(h.socket('dydx-depth').closed, true);
  h.manager.stop();
});

test('unsupported native metadata prevents both new depth feeds from opening', async () => {
  const h = harness({}, false); await h.manager.start(both);
  for (const id of ['dydx-depth', 'aster-depth']) {
    assert.equal(h.sockets.some(socket => socket.spec.id === id), false);
    assert.equal(h.manager.status()[id].state, 'unavailable');
  }
  h.manager.stop();
});

test('selection validation rejects unknown/duplicate/oversized input before current configuration mutation', async () => {
  const h = harness(); await h.manager.start(both);
  const previousSpecs = h.manager.specs, previousGeneration = h.manager.configurationGeneration, previousSockets = h.sockets.slice();
  for (const selection of [['unknown'], ['dydx', 'dydx'], Array.from({ length: 33 }, (_, i) => 'venue' + i), ['DYDX']]) {
    await assert.rejects(() => h.manager.start({ ...both, selectedOrderbookVenues: selection }), /selectedOrderbookVenues/);
    assert.strictEqual(h.manager.specs, previousSpecs);
    assert.equal(h.manager.configurationGeneration, previousGeneration);
    assert.equal(h.sockets.length, previousSockets.length);
    assert.equal(previousSockets.some(socket => socket.closed), false);
  }
  h.manager.stop();
});

test('absent selection keeps legacy depth and empty opt-in selection retains only references', async () => {
  const h = harness({ networkEnabled: false, restTransport: null });
  await h.manager.start();
  assert.ok(h.manager.specs.has('binance-depth')); assert.ok(h.manager.specs.has('hl-l2Book'));
  await h.manager.start({ selectedOrderbookVenues: [] });
  assert.equal([...h.manager.specs.values()].some(spec => spec.publicDepth || spec.channel === 'l2Book' || spec.channel === 'depth'), false);
  assert.ok(h.manager.specs.has('hl-candle')); assert.ok(h.manager.specs.has('binance-kline')); assert.ok(h.manager.specs.has('binance-markPrice'));
  h.manager.stop();
});

test('selection is captured before asynchronous metadata and all old sockets are fenced on restart', async () => {
  let release: ((value: unknown) => void) | undefined;
  const h = harness({ restTransport: { request: request => request.url.includes('/v4/perpetualMarkets')
    ? new Promise<unknown>(resolve => { release = resolve; }) : Promise.resolve(request.url.includes('asterdex.com/fapi/v1/exchangeInfo') ? asterMarkets() : {}) } });
  const selected = ['dydx'];
  const opening = h.manager.start({ ...both, selectedOrderbookVenues: selected });
  await new Promise<void>(resolve => setImmediate(resolve));
  selected[0] = 'aster'; defined(release)(dydxMarkets()); await opening;
  assert.equal(h.manager.specs.has('dydx-depth'), true); assert.equal(h.manager.specs.has('aster-depth'), false);
  const previous = h.socket('dydx-depth'); previous.emit(dydx(2, true));
  const received = h.books('dydx-depth').length;
  await h.manager.start({ selectedOrderbookVenues: [] });
  previous.emit(dydx(3));
  assert.equal(previous.closed, true); assert.equal(h.books('dydx-depth').length, received);
  h.manager.stop();
});

test('an exact eight-venue opt-in set filters every other enabled L2 descriptor before registration', async () => {
  const h = harness({ networkEnabled: false, restTransport: null });
  const selected = ['hyperliquid', 'binance', 'bybit', 'okx', 'gateio', 'deribit', 'coinbase', 'kraken'];
  await h.manager.start({ selectedOrderbookVenues: selected,
    bybitEnabled: true, bybitSymbol: 'BTCUSDT', okxEnabled: true, okxSymbol: 'BTC-USDT-SWAP',
    gateioEnabled: true, gateioSymbol: 'BTC_USDT', deribitEnabled: true, deribitSymbol: 'BTC-PERPETUAL',
    coinbaseEnabled: true, coinbaseSymbol: 'BTC-USD', krakenEnabled: true, krakenSymbol: 'BTC/USD',
    htxEnabled: true, htxSymbol: 'BTC-USDT' });
  const depth = [...h.manager.specs.values()].filter(spec => spec.publicDepth || spec.channel === 'l2Book' || spec.channel === 'depth');
  assert.deepEqual([...new Set(depth.map(spec => spec.venue))].sort(), selected.slice().sort());
  assert.equal(h.manager.specs.has('htx-depth'), false);
  assert.equal(h.manager.specs.has('binance-markPrice'), true);
  assert.equal(h.manager.specs.has('hl-candle'), true);
  h.manager.stop();
});

test('Aster reconnect requires a new matching ACK and snapshot and ignores all old socket frames', async () => {
  const h = harness(); await h.manager.start({ ...both, selectedOrderbookVenues: ['aster'] });
  const old = h.socket('aster-depth'); old.emit({ result: null, id: 2 }); old.emit(aster(30));
  old.onClose?.('connection lost');
  assert.equal(h.manager.status()['aster-depth'].state, 'backoff'); assert.equal(h.timers.length, 1);
  await h.timers[0].callback();
  const replacement = defined(h.sockets.filter(socket => socket.spec.id === 'aster-depth').at(-1));
  assert.notStrictEqual(replacement, old);
  old.emit(aster(40)); replacement.emit(aster(12));
  assert.equal(h.books('aster-depth').length, 1);
  replacement.emit({ result: null, id: 2 }); replacement.emit(aster(12));
  assert.equal(h.books('aster-depth').length, 2);
  assert.equal(defined(h.manager.feeds.get('aster-depth')?.session?.book).sequence, 12);
  h.manager.stop();
});

test('Aster REST base and settlement contradictions block depth before spec/socket activation while preserving trade behavior', async () => {
  for (const correction of [{ baseAsset: 'ETH' }, { marginAsset: 'BTC' }, { quoteAsset: 'USD' }, { baseAsset: 'ETH', marginAsset: 'BTC' }]) {
    const h = harness({ restTransport: { request: async request => request.url.includes('asterdex.com/fapi/v1/exchangeInfo') ? asterMarkets('TRADING', correction) : {} } });
    await h.manager.start({ asterEnabled: true, asterSymbol: 'BTCUSDT', selectedOrderbookVenues: ['aster'] });
    assert.equal(h.manager.specs.has('aster-depth'), false, JSON.stringify(correction));
    assert.equal(h.sockets.some(socket => socket.spec.id === 'aster-depth'), false);
    assert.equal(h.manager.status()['aster-depth'].state, 'unavailable');
    assert.match(String(h.manager.status()['aster-depth'].lastError), /USDT linear base\/quote\/settlement metadata/);
    assert.equal(Object.hasOwn(fields(h.manager.status()['active-book-set'].activeBookSets), 'aster:BTCUSDT'), false);
    const trades = h.socket('aster-trades');
    trades.emit({ result: null, id: 1 });
    trades.emit({ e: 'aggTrade', E: 1_789_902_444_600, s: 'BTCUSDT', a: 42, p: '100', q: '2', T: 1_789_902_444_599, m: false });
    assert.equal(h.messages.some(event => event.id === 'aster-trades' && event.message.kind === 'trade'), true);
    h.manager.stop();
  }
});
