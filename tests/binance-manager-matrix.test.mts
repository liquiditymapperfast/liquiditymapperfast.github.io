import { defined, fields, list, numeric, textValue } from './server-test-helpers.mts';
import type { LiveFeedTransportOptions, LiveFeedSocket, LiveFeedEvent, LiveFeedStatusEvent } from '../src/server/live-feeds.mts';
import type { ExchangeRestRequest } from '../src/server/rest-transport.mts';
import { createExchangeRestTransport, MAX_EXCHANGE_REST_RESPONSE_BYTES } from '../src/server/rest-transport.mts';
import { ProcessMemoryMonitor } from '../src/server/process-memory.mts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { LiveFeedManager } from '../src/server/live-feeds.mts';
import { buildBinanceRequest, normalizeBinanceAggTrade, normalizeBinanceExchangeInfo } from '../src/adapters/binance.mts';

class FakeSocket {
  declare spec:LiveFeedTransportOptions; declare sent:string[]; declare closed:boolean; declare opened?:boolean;
  declare onMessage:((raw:unknown)=>void)|undefined; declare onClose:((reason:unknown)=>void)|undefined; declare onError:((error:unknown)=>void)|undefined;
  constructor(spec:LiveFeedTransportOptions) { this.spec = spec; this.sent = []; this.closed = false; this.onMessage = undefined; this.onClose = undefined; this.onError = undefined; }
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

function metadataTransport() {
  return { request: async (request:ExchangeRestRequest) => {
    if (request.url.includes('/exchangeInfo')) return {
      serverTime: 1_700_000_000_000,
      symbols: [{
        symbol: 'BTCUSDT', pair: 'BTCUSDT', contractType: 'PERPETUAL', status: 'TRADING',
        baseAsset: 'BTC', quoteAsset: 'USDT', marginAsset: 'USDT',
        filters: [{ filterType: 'PRICE_FILTER', tickSize: '0.1' }, { filterType: 'LOT_SIZE', stepSize: '0.001' }],
      }],
    };
    if (request.url.includes('/depth')) return { lastUpdateId: 10, bids: [['100', '2']], asks: [['101', '3']] };
    if (request.url.includes('/klines')) return [];
    if ((typeof request.body === 'string' && request.body.includes('metaAndAssetCtxs'))) return [{ universe: [] }, []];
    return {};
  } };
}

function depth(sequence = 11, { symbol = 'BTCUSDT', stream = 'btcusdt@depth', previous = sequence - 1 } = {}) {
  return { stream, data: { e: 'depthUpdate', E: 1_700_000_000_100, s: symbol, U: previous + 1, pu: previous, u: sequence, b: [['100', '1']], a: [] } };
}

const policies = { binance: { subscribeIntervalMs: 0, heartbeatIntervalMs: 60_000, heartbeatTimeoutMs: 60_000 } };

function aggregateTrade(overrides: Record<string, unknown> = {}) {
  return { e: 'aggTrade', E: 1_700_000_000_110, s: 'BTCUSDT', a: 42, p: '100', q: '2', T: 1_700_000_000_100, m: true, ...overrides };
}

test('Binance aggregate trades preserve execution time, side, and strict numeric fields', () => {
  assert.deepEqual(normalizeBinanceAggTrade(aggregateTrade(), { symbol: 'BTCUSDT', receivedAt: 1_700_000_000_120 }), {
    kind: 'trade', venue: 'binance', instrumentId: 'binance:BTCUSDT', tradeId: 'BTCUSDT:42',
    side: 'sell', price: 100, amount: 2, notionalUsd: 200,
    sourceTimestamp: 1_700_000_000_100, receivedAt: 1_700_000_000_120, marketType: 'perpetual',
  });
  assert.equal(normalizeBinanceAggTrade(aggregateTrade({ m: false }), { symbol: 'BTCUSDT', marketType: 'spot' }).instrumentId, 'binance:BTCUSDT:spot');
  assert.equal(normalizeBinanceAggTrade(aggregateTrade({ m: false }), { symbol: 'BTCUSDT' }).side, 'buy');
  for (const invalid of [
    { e: 'trade' }, { s: 'ETHUSDT' }, { a: null }, { a: true }, { a: '1e2' }, { a: Number.MAX_SAFE_INTEGER + 1 },
    { p: '0' }, { p: true }, { p: [2] }, { q: '-1' }, { q: true }, { q: [2] }, { T: null }, { T: true }, { T: 'bad' }, { m: null },
  ]) assert.throws(() => normalizeBinanceAggTrade(aggregateTrade(invalid), { symbol: 'BTCUSDT' }));
  assert.throws(() => normalizeBinanceAggTrade({ stream: 'ethusdt@aggTrade', data: aggregateTrade() }, { symbol: 'BTCUSDT' }), /stream mismatch/);
  assert.throws(() => normalizeBinanceAggTrade({ stream: 'btcusdt@aggTrade' }, { symbol: 'BTCUSDT' }), /frame mismatch/);
  assert.throws(() => normalizeBinanceAggTrade(aggregateTrade({ s: 'BNBBTC' }), { symbol: 'BNBBTC' }), /USDT-quoted/);
});

test('Binance trade feed stays unavailable for a non-USD-quoted configured market', async () => {
  const fake = transport();
  const manager = new LiveFeedManager({ networkEnabled: true, transportFactory: fake.factory, oiPollMs: 0, transportPolicies: policies });
  await manager.start({ binanceSymbol: 'BNBBTC', binanceMarketType: 'spot' });
  assert.equal(fake.sockets.some(item => item.spec.id === 'binance-trades'), false);
  assert.equal(manager.status()['binance-trades'].state, 'unavailable');
  assert.match(textValue(manager.status()['binance-trades'].lastError), /USDT-quoted/);
  manager.stop();
});

test('Binance aggTrade feed filters foreign frames and fences a retired trade socket', async () => {
  const fake = transport(); const messages:LiveFeedEvent[] = []; const timers:{fn:()=>unknown;delay:number}[] = [];
  const manager = new LiveFeedManager({ networkEnabled: true, transportFactory: fake.factory, oiPollMs: 0,
    transportPolicies: policies, now: () => 1_700_000_000_120,
    schedule: (fn, delay) => { const timer = { fn, delay }; timers.push(timer); return timer; }, cancel: () => {},
    onMessage: message => messages.push(message) });
  await manager.start({ binanceSymbol: 'BTCUSDT', binanceMarketType: 'perpetual' });
  const first = defined(fake.sockets.find(item => item.spec.id === 'binance-trades'));
  assert.equal(first.spec.request.stream, 'btcusdt@aggTrade');
  assert.match(defined(first.spec.request.url), /fstream\.binance\.com\/market\/ws\/btcusdt@aggTrade$/);
  first.emit({ stream: 'ethusdt@aggTrade', data: aggregateTrade({ a: 1 }) });
  first.emit({ stream: 'btcusdt@aggTrade', data: aggregateTrade({ s: 'ETHUSDT', a: 2 }) });
  first.emit({ stream: 'btcusdt@markPrice@1s', data: aggregateTrade({ a: 3 }) });
  first.emit({ stream: 'btcusdt@aggTrade', data: aggregateTrade({ e: 'trade', a: 4 }) });
  first.emit(aggregateTrade({ a: 5, m: false }));
  first.emit({ stream: 'btcusdt@aggTrade', data: aggregateTrade({ a: 6 }) });
  assert.deepEqual(messages.filter(item => item.id === 'binance-trades').map(item => item.message.tradeId), ['BTCUSDT:5', 'BTCUSDT:6']);
  first.emit(aggregateTrade({ a: 7, T: null }));
  assert.equal(messages.filter(item => item.id === 'binance-trades').length, 2);
  first.closeWith('lost');
  assert.equal(manager.status()['binance-trades'].state, 'backoff');
  first.emit(aggregateTrade({ a: 8 }));
  assert.equal(messages.filter(item => item.id === 'binance-trades').length, 2);
  assert.equal(timers.length, 1);
  await timers[0].fn();
  const replacement = defined(fake.sockets.filter(item => item.spec.id === 'binance-trades').at(-1));
  assert.notStrictEqual(replacement, first);
  replacement.emit(aggregateTrade({ a: 9 }));
  assert.deepEqual(messages.filter(item => item.id === 'binance-trades').map(item => item.message.tradeId), ['BTCUSDT:5', 'BTCUSDT:6', 'BTCUSDT:9']);
  manager.stop();
});

test('Binance linear manager filters streams/symbols, hydrates exchangeInfo, and preserves base units', async () => {
  const fake = transport(); const messages:LiveFeedEvent[] = [];
  const manager = new LiveFeedManager({ networkEnabled: true, transportFactory: fake.factory, restTransport: metadataTransport(), transportPolicies: policies, oiPollMs: 0, onMessage: message => messages.push(message) });
  await manager.start({ binanceSymbol: 'BTCUSDT', binanceMarketType: 'perpetual' });
  const depthSocket = defined(fake.sockets.find(item => item.spec.id === 'binance-depth'));
  const markSocket = defined(fake.sockets.find(item => item.spec.id === 'binance-markPrice'));
  const klineSocket = defined(fake.sockets.find(item => item.spec.id === 'binance-kline'));
  assert.equal(depthSocket.spec.request.stream, 'btcusdt@depth@100ms');
  assert.match(defined(depthSocket.spec.request.url), /fstream\.binance\.com\/public\/ws\/btcusdt@depth@100ms$/);
  assert.equal(manager.status()['binance-metadata'].state, 'snapshot');
  const metadata = defined(messages.find(item => item.id === 'binance-metadata')?.message);
  assert.equal(defined(metadata.assets)[0].tickSize, 0.1);
  assert.equal(defined(metadata.assets)[0].qtyStep, 0.001);
  assert.equal(defined(metadata.assets)[0].lotSize, 0.001);
  assert.equal(defined(metadata.assets)[0].quantityUnit, 'base');
  assert.equal(defined(metadata.assets)[0].settleCoin, 'USDT');

  depthSocket.emit(depth(11, { symbol: 'ETHUSDT' }));
  depthSocket.emit(depth(11, { stream: 'btcusdt@aggTrade' }));
  depthSocket.emit({ ...depth(11), data: { ...depth(11).data, st: 2, ps: 'BTCUSDT' } });
  depthSocket.emit({ ...depth(11), data: { ...depth(11).data, st: 1, ps: 'BTCUSD' } });
  depthSocket.emit(depth(11));
  depthSocket.emit({ ...depth(12, { previous: 11 }), data: { ...depth(12, { previous: 11 }).data, st: 1, ps: 'BTCUSDT' } });
  assert.equal(messages.filter(item => item.id === 'binance-depth' && item.message.kind === 'depthDelta').length, 2);

  markSocket.emit({ stream: 'ethusdt@markPrice@1s', data: { e: 'markPriceUpdate', s: 'ETHUSDT', p: '101', E: 1_700_000_000_100 } });
  markSocket.emit({ stream: 'btcusdt@markPrice@1s', data: { e: 'trade', s: 'BTCUSDT', p: '101', E: 1_700_000_000_100 } });
  markSocket.emit({ stream: 'btcusdt@markPrice@1s', data: { e: 'markPriceUpdate', s: 'BTCUSDT', p: '101', E: 1_700_000_000_100 } });
  assert.equal(messages.filter(item => item.id === 'binance-markPrice' && item.message.kind === 'price').length, 1);
  markSocket.emit({ stream: 'btcusdt@markPrice@1s', data: { e: 'markPriceUpdate', s: 'BTCUSDT', p: '102' } });
  markSocket.emit({ stream: 'btcusdt@markPrice@1s', data: { e: 'markPriceUpdate', s: 'BTCUSDT', p: '103', E: true } });
  const marks = messages.filter(item => item.id === 'binance-markPrice' && item.message.kind === 'price').map(item => item.message);
  assert.deepEqual(marks.map(item => item.sourceTimestamp), [1_700_000_000_100, null, null]);
  assert.equal(marks.every(item => Number.isFinite(item.receivedAt)), true);
  klineSocket.emit({ stream: 'btcusdt@kline_1m', data: { e: 'depthUpdate', s: 'BTCUSDT', b: [], a: [] } });
  klineSocket.emit({ stream: 'btcusdt@kline_1m', data: { e: 'kline', s: 'BTCUSDT', k: { i: '5m', t: 1_700_000_000_000, T: 1_700_000_060_000, o: '100', h: '102', l: '99', c: '101', v: '4', x: true } } });
  klineSocket.emit({ stream: 'btcusdt@kline_1m', data: { e: 'kline', s: 'BTCUSDT', k: { i: '1m', t: 1_700_000_000_000, T: 1_700_000_060_000, o: '100', h: '102', l: '99', c: '101', v: '4', x: true } } });
  assert.equal(messages.filter(item => item.id === 'binance-kline' && item.message.kind === 'candle').length, 1);
  manager.stop();
});

test('Binance depth close/reconnect fences retired sockets and requires a fresh snapshot', async () => {
  const fake = transport(); const timers:{fn:()=>unknown;delay:number}[] = []; const messages:LiveFeedEvent[] = [];
  const manager = new LiveFeedManager({ networkEnabled: true, transportFactory: fake.factory, restTransport: metadataTransport(), transportPolicies: policies, oiPollMs: 0, reconnectBaseMs: 10, schedule: (fn, delay) => { timers.push({ fn, delay }); return timers.length; }, cancel: () => {}, onMessage: message => messages.push(message) });
  await manager.start({ binanceSymbol: 'BTCUSDT', binanceMarketType: 'perpetual' });
  const first = defined(fake.sockets.find(item => item.spec.id === 'binance-depth'));
  first.closeWith('lost');
  assert.equal(first.closed, true);
  assert.equal(manager.status()['binance-depth'].state, 'backoff');
  assert.equal(timers.length, 1);
  const before = messages.filter(item => item.id === 'binance-depth' && item.message.kind === 'depthDelta').length;
  first.emit(depth(99, { previous: 98 }));
  assert.equal(messages.filter(item => item.id === 'binance-depth' && item.message.kind === 'depthDelta').length, before);
  await timers[0].fn();
  const second = defined(fake.sockets.filter(item => item.spec.id === 'binance-depth').at(-1));
  assert.notStrictEqual(second, first);
  assert.equal(manager.status()['binance-depth'].state, 'snapshot');
  second.emit(depth(11));
  assert.equal(messages.filter(item => item.id === 'binance-depth' && item.message.kind === 'depthDelta').length, before + 1);
  assert.equal(messages.filter(item => item.id === 'binance-depth' && item.message.kind === 'depthSnapshot' && item.message.complete === false).length, 1);
  manager.stop();
});

test('Binance exchangeInfo uses the existing bounded catalog response class for both public families', () => {
  for (const marketType of ['spot', 'perpetual']) {
    assert.equal(buildBinanceRequest('exchangeInfo', { symbol: 'BTCUSDT', marketType }).responseClass, 'catalog');
    assert.equal(buildBinanceRequest('depth', { symbol: 'BTCUSDT', marketType }).responseClass, undefined);
  }
});
