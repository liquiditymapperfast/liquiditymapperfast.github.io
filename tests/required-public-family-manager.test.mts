import test from 'node:test';
import assert from 'node:assert/strict';
import { LiveFeedManager, configuredCandleInstrumentIds } from '../src/server/live-feeds.mts';
import type { LiveFeedEvent, LiveFeedSocket, LiveFeedStartOptions, LiveFeedTransportOptions, LiveFeedRestTransport } from '../src/server/live-feeds.mts';
import type { ExchangeRestRequest } from '../src/server/rest-transport.mts';
import { defined, fields } from './server-test-helpers.mts';
import { getVenue } from '../src/domain/venue-registry.mts';

const NOW = 1_700_000_060_120;
const candleStart = 1_699_999_980_000;
type Family = 'binance-coinm' | 'bybit-spot' | 'bybit-inverse' | 'okx-spot' | 'bitget-spot';
const options: Record<Family, LiveFeedStartOptions> = {
  'binance-coinm': { binanceFamily: 'coinm', binanceSymbol: 'BTCUSD_PERP' },
  'bybit-spot': { bybitEnabled: true, bybitCategory: 'spot', bybitSymbol: 'BTCUSDT' },
  'bybit-inverse': { bybitEnabled: true, bybitCategory: 'inverse', bybitSymbol: 'BTCUSD' },
  'okx-spot': { okxEnabled: true, okxMarketType: 'spot', okxSymbol: 'BTC-USDT' },
  'bitget-spot': { bitgetEnabled: true, bitgetMarketType: 'spot', bitgetSymbol: 'BTCUSDT' },
};
function feedId(family: Family) { return family === 'binance-coinm' ? 'binance-depth' : family.split('-')[0] + '-depth'; }
function instrumentId(family: Family) {
  return family === 'binance-coinm' ? 'binance:BTCUSD_PERP' : family === 'bybit-inverse' ? 'bybit:BTCUSD'
    : family === 'okx-spot' ? 'okx:BTC-USDT' : family.split('-')[0] + ':BTCUSDT:spot';
}
class Socket implements LiveFeedSocket {
  onMessage?: (raw: unknown) => void; onClose?: (reason: unknown) => void; onError?: (reason: unknown) => void;
  closed = false; sent: string[] = [];
  constructor(readonly spec: LiveFeedTransportOptions) {}
  async open() {}
  send(raw: string) { this.sent.push(raw); }
  close() { this.closed = true; }
  emit(raw: unknown) { this.onMessage?.(raw); }
  closeWith(reason = 'induced selected-family close') { this.closed = true; this.onClose?.(reason); }
}
function rawMetadata(request: ExchangeRestRequest, active = true) {
  const url = new URL(request.url), symbol = url.searchParams.get('symbol');
  if (url.pathname.endsWith('exchangeInfo')) {
    const inverse = url.hostname === 'dapi.binance.com';
    return { symbols: [{ symbol: inverse ? 'BTCUSD_PERP' : 'BTCUSDT', pair: inverse ? 'BTCUSD' : 'BTCUSDT', contractType: 'PERPETUAL',
      status: active ? 'TRADING' : 'PENDING_TRADING', baseAsset: 'BTC', quoteAsset: inverse ? 'USD' : 'USDT', marginAsset: inverse ? 'BTC' : 'USDT',
      ...(inverse ? { contractSize: 100 } : {}),
      filters: [{ filterType: 'PRICE_FILTER', tickSize: '0.1' }, { filterType: 'LOT_SIZE', stepSize: inverse ? '1' : '0.001' }] }] };
  }
  if (url.pathname.endsWith('instruments-info')) {
    const category = url.searchParams.get('category'), inverse = category === 'inverse', spot = category === 'spot';
    return { retCode: 0, time: NOW, result: { category, list: [{ symbol, baseCoin: 'BTC', quoteCoin: inverse ? 'USD' : 'USDT',
      ...(spot ? {} : { settleCoin: inverse ? 'BTC' : 'USDT', contractType: inverse ? 'InversePerpetual' : 'LinearPerpetual' }),
      status: active ? 'Trading' : 'PreLaunch', priceFilter: { tickSize: '0.1' }, lotSizeFilter: spot ? { basePrecision: '0.000001', quotePrecision: '0.01' } : { qtyStep: inverse ? '1' : '0.001' } }] } };
  }
  if (url.pathname === '/api/v5/public/instruments') {
    const spot = url.searchParams.get('instType') === 'SPOT';
    return { code: '0', data: [{ instId: url.searchParams.get('instId'), instType: spot ? 'SPOT' : 'SWAP', baseCcy: 'BTC', quoteCcy: 'USDT',
      settleCcy: spot ? '' : 'USDT', ctType: spot ? undefined : 'linear', ctValCcy: spot ? undefined : 'BTC', ctVal: spot ? '' : '0.01', tickSz: '0.1', lotSz: '0.000001', minSz: '0.00001', state: active ? 'live' : 'suspend' }] };
  }
  if (url.pathname === '/api/v3/market/instruments') {
    const category = url.searchParams.get('category');
    return { code: '00000', requestTime: NOW, data: [{ symbol, category, baseCoin: 'BTC', quoteCoin: 'USDT', status: active ? 'online' : 'offline',
      pricePrecision: '2', quantityPrecision: '6', priceMultiplier: '0.01', quantityMultiplier: '0.000001', minOrderQty: '0.001' }] };
  }
  return null;
}
function harness({ active = true, rejectMetadata = false, noRest = false }: { active?: boolean; rejectMetadata?: boolean; noRest?: boolean } = {}) {
  const sockets: Socket[] = [], messages: LiveFeedEvent[] = [], retries: { fn: () => unknown; delay: number }[] = [], requests: ExchangeRestRequest[] = [];
  const restTransport: LiveFeedRestTransport = { request: async request => {
    requests.push(request);
    const metadata = rawMetadata(request, active); if (metadata) return metadata;
    if (request.url.includes('/depth')) return { lastUpdateId: 10, bids: [['25000', '2']], asks: [['25001', '3']] };
    if (request.url.includes('/klines')) return [[candleStart, '25000', '25010', '24990', '25005', '12', candleStart + 59_999, '0.048', 1]];
    if (request.url.includes('/openInterestHist')) return [{ pair: 'BTCUSD', contractType: 'PERPETUAL', sumOpenInterest: '20', sumOpenInterestValue: '0.08', timestamp: NOW - 300_000 }];
    if (request.url.includes('/openInterest')) return { symbol: 'BTCUSD_PERP', openInterest: '20', time: NOW };
    if (typeof request.body === 'string') return request.body.includes('metaAndAssetCtxs') ? [{ universe: [] }, []] : [];
    return {};
  } };
  const manager = new LiveFeedManager({ networkEnabled: true, transportFactory: async spec => { const socket = new Socket(spec); sockets.push(socket); return socket; },
    restTransport: noRest ? null : restTransport, now: () => NOW, oiPollMs: 0, oiHistoryLimit: 0, candleHistoryLimit: 3,
    schedule: (fn, delay) => { const timer = { fn, delay }; retries.push(timer); return timer; }, cancel: () => {},
    heartbeatSchedule: () => ({}), heartbeatCancel: () => {},
    transportPolicies: { binance: { subscribeIntervalMs: 0 }, bybit: { subscribeIntervalMs: 0 }, okx: { subscribeIntervalMs: 0 }, bitget: { subscribeIntervalMs: 0 } },
    onMessage: event => { if (rejectMetadata && event.message.kind === 'metadata') return false; messages.push(event); } });
  const selected = (family: Family) => defined(sockets.filter(socket => socket.spec.id === feedId(family)).at(-1));
  return { manager, messages, sockets, requests, retries, selected };
}
function acknowledgement(family: Family) {
  if (family.startsWith('bybit')) return { op: 'subscribe', success: true, args: ['orderbook.1000.' + (family === 'bybit-inverse' ? 'BTCUSD' : 'BTCUSDT')] };
  if (family === 'okx-spot') return { event: 'subscribe', arg: { channel: 'books', instId: 'BTC-USDT' } };
  return { event: 'subscribe', arg: { instType: 'spot', topic: 'books', symbol: 'BTCUSDT' } };
}
function book(family: Family, { sequence = 11, previous = 10, snapshot = true, foreign = false }: { sequence?: number; previous?: number; snapshot?: boolean; foreign?: boolean } = {}) {
  if (family === 'binance-coinm') return { e: 'depthUpdate', E: NOW, s: foreign ? 'ETHUSD_PERP' : 'BTCUSD_PERP', ps: 'BTCUSD', st: 2, U: sequence, u: sequence, pu: previous, b: [['25000', '2']], a: [['25001', '3']] };
  if (family.startsWith('bybit')) return { topic: 'orderbook.1000.' + (family === 'bybit-inverse' ? 'BTCUSD' : 'BTCUSDT'), type: snapshot ? 'snapshot' : 'delta', ts: NOW,
    data: { s: foreign ? 'ETHUSDT' : family === 'bybit-inverse' ? 'BTCUSD' : 'BTCUSDT', u: sequence, seq: sequence + 100, b: [['25000', family === 'bybit-inverse' ? '200' : '2']], a: [['25001', '3']] } };
  if (family === 'okx-spot') return { arg: { channel: 'books', instId: foreign ? 'ETH-USDT' : 'BTC-USDT' }, action: snapshot ? 'snapshot' : 'update',
    data: [{ ts: NOW, seqId: sequence, prevSeqId: snapshot ? -1 : previous, bids: [['25000', '2']], asks: [['25001', '3']] }] };
  return { arg: { instType: 'spot', topic: 'books', symbol: foreign ? 'ETHUSDT' : 'BTCUSDT' }, action: snapshot ? 'snapshot' : 'update',
    data: [{ ts: NOW, seq: sequence, pseq: previous, bids: [['25000', '2']], asks: [['25001', '3']] }] };
}
function validEvents(h: ReturnType<typeof harness>, family: Family) {
  return h.messages.filter(event => event.id === feedId(family) && !event.message.invalidated && !event.message.gap);
}
for (const family of Object.keys(options) as Family[]) {
  test(family + ' requires accepted active verified metadata before opening its selected public socket', async () => {
    for (const fault of [{ active: false }, { rejectMetadata: true }, { noRest: true }]) {
      const h = harness(fault); try {
        await h.manager.start(options[family]);
        assert.equal(h.sockets.some(socket => socket.spec.id === feedId(family)), false);
        assert.equal(h.manager.status()[feedId(family)].state, 'unavailable');
        assert.match(String(h.manager.status()[feedId(family)].lastError), /accepted active verified public family metadata/);
        assert.equal(Object.hasOwn(fields(h.manager.status()['active-book-set'].activeBookSets), instrumentId(family)), false);
      } finally { h.manager.stop(); }
    }
  });
  test(family + ' preserves native units, reconnect metadata and rejects retired/foreign frames', async () => {
    const h = harness(); try {
      await h.manager.start(options[family]); const first = h.selected(family);
      const spec = defined(h.manager.specs.get(feedId(family)));
      const metadata = defined(spec.metadata);
      assert.equal(metadata.instrumentId, instrumentId(family));
      assert.equal(metadata.quantityUnit, family === 'binance-coinm' ? 'contract' : family === 'bybit-inverse' ? 'quote' : 'base');
      assert.equal(h.messages.findIndex(event => event.message.kind === 'metadata' && event.venue === spec.venue) >= 0, true);
      const before = validEvents(h, family).length;
      first.emit(book(family, { foreign: true })); assert.equal(validEvents(h, family).length, before);
      if (family !== 'binance-coinm') first.emit(acknowledgement(family));
      first.emit(book(family));
      const normalized = defined(validEvents(h, family).at(-1)).message;
      assert.equal(normalized.instrumentId, instrumentId(family));
      if (family === 'binance-coinm') { assert.equal(normalized.units, 'contract'); assert.equal(normalized.contractValue, 100); }
      else { assert.equal(normalized.units, family === 'bybit-inverse' ? 'quote' : 'base'); assert.equal(defined(normalized.market).marketType, family === 'bybit-inverse' ? 'perpetual' : 'spot'); }
      first.closeWith();
      assert.equal(h.manager.status()[feedId(family)].state, 'backoff');
      assert.equal(h.messages.some(event => event.id === feedId(family) && event.message.invalidated && event.message.gap), true);
      const retiredCount = h.messages.length, retiredStatus = JSON.stringify(h.manager.status()[feedId(family)]);
      first.emit(book(family, { sequence: 12, previous: 11, snapshot: false })); first.emit(acknowledgement(family));
      assert.equal(h.messages.length, retiredCount); assert.equal(JSON.stringify(h.manager.status()[feedId(family)]), retiredStatus);
      await defined(h.retries.find(timer => timer.delay > 0)).fn();
      const replacement = h.selected(family); assert.notEqual(replacement, first);
      assert.strictEqual(defined(h.manager.specs.get(feedId(family))).metadata, metadata);
      if (family !== 'binance-coinm') replacement.emit(acknowledgement(family));
      replacement.emit(book(family)); assert.equal(h.manager.status()[feedId(family)].state, 'live');
      const replacementCount = h.messages.length;
      first.emit(book(family, { sequence: 99 })); assert.equal(h.messages.length, replacementCount);
    } finally { h.manager.stop(); }
  });
}
test('COIN-M candles/trades/OI/history use verified metadata and an observed mark price', async () => {
  const h = harness(); try {
    await h.manager.start(options['binance-coinm']);
    const mark = defined(h.sockets.find(socket => socket.spec.id === 'binance-markPrice'));
    const trades = defined(h.sockets.find(socket => socket.spec.id === 'binance-trades'));
    const kline = defined(h.sockets.find(socket => socket.spec.id === 'binance-kline'));
    assert.match(String(mark.spec.request.url), /dstream\.binance\.com\/ws\/btcusd_perp@markPrice@1s$/);
    assert.equal(await h.manager.pollOpenInterest({ symbol: 'BTCUSD_PERP', family: 'coinm' }), null);
    assert.match(String(h.manager.status()['binance-openInterest'].lastError), /price basis/);
    mark.emit({ e: 'markPriceUpdate', s: 'BTCUSD_PERP', p: '25000', E: NOW });
    trades.emit({ e: 'aggTrade', s: 'BTCUSD_PERP', a: 1, p: '25000', q: '2', T: NOW, m: false });
    kline.emit({ e: 'kline', s: 'BTCUSD_PERP', k: { s: 'BTCUSD_PERP', i: '1m', t: candleStart, T: candleStart + 59_999, o: '25000', h: '25010', l: '24990', c: '25005', v: '12', q: '0.048', x: true } });
    const trade = defined(h.messages.find(event => event.id === 'binance-trades')).message;
    assert.equal(trade.amount, 0.008); assert.equal(trade.notionalUsd, 200);
    assert.equal(defined(h.messages.find(event => event.id === 'binance-kline')).message.volume, 0.048);
    const oi = defined(await h.manager.pollOpenInterest({ symbol: 'BTCUSD_PERP', family: 'coinm' }));
    assert.equal(oi.base, 0.08); assert.equal(oi.quote, 2000);
    const history = await h.manager.syncOpenInterestHistory({ symbol: 'BTCUSD_PERP', family: 'coinm', limit: 1 });
    assert.equal(history[0].base, 0.08); assert.equal(history[0].quote, 2000);
    const query = new URL(defined(h.requests.find(request => request.url.includes('/openInterestHist'))).url).searchParams;
    assert.equal(query.get('pair'), 'BTCUSD'); assert.equal(query.get('contractType'), 'PERPETUAL'); assert.equal(query.has('symbol'), false);
    assert.deepEqual(configuredCandleInstrumentIds({ binanceFamily: 'coinm' }), ['hyperliquid:BTC-PERP', 'binance:BTCUSD_PERP']);
  } finally { h.manager.stop(); }
});
for (const family of ['binance-coinm', 'okx-spot', 'bitget-spot'] as const) {
  test(family + ' rejects a predecessor gap and preserves native family on recovery', async () => {
    const h = harness(); try {
      await h.manager.start(options[family]); const first = h.selected(family);
      if (family !== 'binance-coinm') first.emit(acknowledgement(family));
      first.emit(book(family));
      first.emit(book(family, { sequence: 13, previous: 99, snapshot: false }));
      assert.equal(h.messages.some(event => event.id === feedId(family) && event.message.invalidated && event.message.gap), true);
      assert.equal(validEvents(h, family).some(event => event.message.sequence === 13), false);
      if (family === 'binance-coinm') {
        await new Promise(resolve => setImmediate(resolve));
        assert.equal(h.requests.filter(request => request.url.includes('/depth')).every(request => new URL(request.url).hostname === 'dapi.binance.com'), true);
        assert.equal(h.manager.bookSequences.has('binance:BTCUSDT'), false);
      } else assert.equal(first.closed, true);
    } finally { h.manager.stop(); }
  });
}
test('Bybit inverse jumps remain unproven and u=1 resets from the same verified family', async () => {
  const h = harness(); try {
    await h.manager.start(options['bybit-inverse']); const socket = h.selected('bybit-inverse');
    socket.emit(acknowledgement('bybit-inverse')); socket.emit(book('bybit-inverse'));
    socket.emit(book('bybit-inverse', { sequence: 40, snapshot: false }));
    const jump = defined(validEvents(h, 'bybit-inverse').at(-1)).message;
    assert.equal(jump.sequenceJump, true); assert.equal(jump.continuity, 'unproven'); assert.equal(jump.units, 'quote');
    const beforeReset = validEvents(h, 'bybit-inverse').length;
    socket.emit(book('bybit-inverse', { sequence: 1, snapshot: false }));
    assert.equal(validEvents(h, 'bybit-inverse').length, beforeReset, 'an old delta cannot fabricate the documented snapshot reset');
    socket.emit(book('bybit-inverse', { sequence: 1, snapshot: true }));
    assert.equal(defined(validEvents(h, 'bybit-inverse').at(-1)).message.kind, 'depthSnapshot');
    assert.equal(h.manager.status()['bybit-depth'].state, 'live');
  } finally { h.manager.stop(); }
});
test('spot OI stays explicitly unavailable across Bybit/OKX/Bitget family selection', async () => {
  for (const family of ['bybit-spot', 'okx-spot', 'bitget-spot'] as const) {
    const h = harness(); try {
      await h.manager.start(options[family]);
      assert.equal(h.manager.status()[family.split('-')[0] + '-openInterest'].state, 'unavailable');
      assert.match(String(h.manager.status()[family.split('-')[0] + '-openInterest'].lastError), /spot market has no open interest/);
    } finally { h.manager.stop(); }
  }
});
test('late selected-family metadata cannot publish across a configuration generation change', async () => {
  const sockets: Socket[] = [], messages: LiveFeedEvent[] = [];
  let release: ((payload: unknown) => void) | undefined;
  const manager = new LiveFeedManager({ networkEnabled: true, oiPollMs: 0, now: () => NOW,
    transportFactory: async spec => { const socket = new Socket(spec); sockets.push(socket); return socket; },
    restTransport: { request: async request => {
      if (request.url.includes('dapi.binance.com') && request.url.includes('exchangeInfo')) return new Promise<unknown>(resolve => { release = resolve; });
      return rawMetadata(request) ?? (request.url.includes('/depth') ? { lastUpdateId: 10, bids: [], asks: [] } : typeof request.body === 'string' && request.body.includes('metaAndAssetCtxs') ? [{ universe: [] }, []] : []);
    } }, heartbeatSchedule: () => ({}), heartbeatCancel: () => {},
    onMessage: event => { messages.push(event); } });
  try {
    const oldStart = manager.start(options['binance-coinm']);
    await new Promise(resolve => setImmediate(resolve));
    await manager.start({ binanceSymbol: 'BTCUSDT', binanceMarketType: 'spot' });
    const request = { url: 'https://dapi.binance.com/dapi/v1/exchangeInfo?symbol=BTCUSD_PERP' };
    defined(release)(rawMetadata(request)); await oldStart;
    assert.equal(messages.some(event => event.message.assets?.some(asset => asset.family === 'coinm')), false);
    assert.equal(sockets.some(socket => String(socket.spec.request.url).includes('dstream.binance.com')), false);
    assert.equal(manager.specs.get('binance-depth')?.instrumentId, 'binance:BTCUSDT:spot');
  } finally { manager.stop(); }
});
test('runtime capabilities keep spot OI unsupported while the required public L2 families are wired', () => {
  for (const venue of ['bybit', 'okx', 'bitget']) {
    assert.deepEqual(getVenue(venue)?.capabilities.l2.marketTypes, ['spot', 'perpetual']);
    assert.equal(getVenue(venue)?.capabilities.openInterest.state, 'unsupported');
  }
});
test('COIN-M rejects foreign stream type and buffers actual st=2 native contract frames', async () => {
  const h = harness(); try {
    await h.manager.start(options['binance-coinm']); const socket = h.selected('binance-coinm');
    const before = validEvents(h, 'binance-coinm').length;
    socket.emit({ ...book('binance-coinm'), st: 1 }); socket.emit({ ...book('binance-coinm'), st: 3 });
    assert.equal(validEvents(h, 'binance-coinm').length, before);
    socket.emit(book('binance-coinm')); assert.equal(validEvents(h, 'binance-coinm').length, before + 1);
    assert.equal(validEvents(h, 'binance-coinm').at(-1)?.message.units, 'contract');
  } finally { h.manager.stop(); }
});

test('late COIN-M startup REST depth cannot reopen or poll the replacement spot configuration', async () => {
  const h = harness(); const rest = defined(h.manager.restTransport), original = rest.request;
  let release: ((value: unknown) => void) | undefined;
  rest.request = async (request, context) => {
    if (request.url.startsWith('https://dapi.binance.com/dapi/v1/depth') && !release) return new Promise<unknown>(resolve => { release = resolve; });
    return original(request, context);
  };
  try {
    const oldStart = h.manager.start(options['binance-coinm']);
    for (let count = 0; !release && count < 50; count += 1) await new Promise<void>(resolve => setImmediate(resolve));
    assert.ok(release, 'old selected REST depth is actually held');
    await h.manager.start({ binanceFamily: 'usdm', binanceMarketType: 'spot', binanceSymbol: 'BTCUSDT' });
    const before = JSON.stringify({ sources: h.messages, requests: h.requests, specs: [...h.manager.specs].map(([id, spec]) => [id, spec.instrumentId]), sockets: h.sockets.length, status: h.manager.status() });
    release({ lastUpdateId: 500, bids: [['25000', '200']], asks: [['25001', '300']] }); await oldStart;
    assert.equal(JSON.stringify({ sources: h.messages, requests: h.requests, specs: [...h.manager.specs].map(([id, spec]) => [id, spec.instrumentId]), sockets: h.sockets.length, status: h.manager.status() }), before);
  } finally { h.manager.stop(); }
});