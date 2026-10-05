import { defined, fields, list, numeric, textValue } from './server-test-helpers.mts';
import type { LiveFeedTransportOptions, LiveFeedSocket, LiveFeedEvent, LiveFeedStatusEvent } from '../src/server/live-feeds.mts';
import type { ExchangeRestRequest } from '../src/server/rest-transport.mts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { LiveFeedManager } from '../src/server/live-feeds.mts';

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

function metadataTransport() {
  const requests:ExchangeRestRequest[] = [];
  return {
    requests,
    request: async (request:ExchangeRestRequest) => {
      requests.push(request);
      if (request.url.includes('/exchangeInfo')) return {
        serverTime: 1_700_000_000_000,
        symbols: [{
          symbol: 'BTCUSDT', status: 'TRADING', baseAsset: 'BTC', quoteAsset: 'USDT',
          filters: [{ filterType: 'PRICE_FILTER', tickSize: '0.01' }, { filterType: 'LOT_SIZE', stepSize: '0.00001' }],
        }],
      };
      if (request.url.includes('/depth')) return { lastUpdateId: 20, bids: [['100', '2']], asks: [['101', '3']] };
      if (request.url.includes('/klines')) return [];
      if ((typeof request.body === 'string' && request.body.includes('metaAndAssetCtxs'))) return [{ universe: [] }, []];
      return {};
    },
  };
}

function depth(sequence = 21, { symbol = 'BTCUSDT', stream = null, previous = sequence - 1 }: {symbol?: string; stream?: string | null; previous?: number} = {}) {
  const payload = { e: 'depthUpdate', E: 1_700_000_000_100, s: symbol, U: previous + 1, u: sequence, b: [['100', '1']], a: [] };
  return stream == null ? payload : { stream, data: payload };
}

const policies = { binance: { subscribeIntervalMs: 0, heartbeatIntervalMs: 60_000, heartbeatTimeoutMs: 60_000 } };

test('Binance spot manager filters streams/symbols, hydrates exchangeInfo, and keeps OI unavailable', async () => {
  const fake = transport(); const rest = metadataTransport(); const messages:LiveFeedEvent[] = [];
  const manager = new LiveFeedManager({ networkEnabled: true, transportFactory: fake.factory, restTransport: rest, transportPolicies: policies, oiPollMs: 0, onMessage: message => messages.push(message) });
  await manager.start({ binanceSymbol: 'BTCUSDT', binanceMarketType: 'spot', candleInterval: '1m' });

  const depthSocket = defined(fake.sockets.find(item => item.spec.id === 'binance-depth'));
  const tradeSocket = defined(fake.sockets.find(item => item.spec.id === 'binance-markPrice'));
  const aggregateTradeSocket = defined(fake.sockets.find(item => item.spec.id === 'binance-trades'));
  const klineSocket = defined(fake.sockets.find(item => item.spec.id === 'binance-kline'));
  assert.match(defined(depthSocket.spec.request.url), /stream\.binance\.com:9443\/ws\/btcusdt@depth@100ms$/);
  assert.equal(depthSocket.spec.request.stream, 'btcusdt@depth@100ms');
  assert.equal(tradeSocket.spec.request.stream, 'btcusdt@trade');
  assert.equal(aggregateTradeSocket.spec.request.stream, 'btcusdt@aggTrade');
  assert.match(defined(aggregateTradeSocket.spec.request.url), /stream\.binance\.com:9443\/ws\/btcusdt@aggTrade$/);
  assert.equal(klineSocket.spec.request.stream, 'btcusdt@kline_1m');

  const metadata = defined(messages.find(item => item.id === 'binance-metadata')?.message);
  assert.equal(defined(metadata.assets)[0].instrumentId, 'binance:BTCUSDT:spot');
  assert.equal(defined(metadata.assets)[0].marketType, 'spot');
  assert.equal(defined(metadata.assets)[0].base, 'BTC');
  assert.equal(defined(metadata.assets)[0].quote, 'USDT');
  assert.equal(defined(metadata.assets)[0].tickSize, 0.01);
  assert.equal(defined(metadata.assets)[0].qtyStep, 0.00001);
  assert.equal(defined(metadata.assets)[0].lotSize, 0.00001);
  assert.equal(defined(metadata.assets)[0].settleCoin, undefined);
  assert.equal(manager.status()['binance-openInterest'].state, 'unavailable');
  assert.match(textValue(manager.status()['binance-openInterest'].lastError), /spot market/);
  assert.equal(rest.requests.some(request => request.url.includes('/openInterest')), false);

  depthSocket.emit(depth(21, { symbol: 'ETHUSDT', stream: 'btcusdt@depth@100ms' }));
  depthSocket.emit({ stream: 'btcusdt@aggTrade', data: fields(depth(21)).data });
  depthSocket.emit(depth(21));
  assert.equal(messages.filter(item => item.id === 'binance-depth' && item.message.kind === 'depthDelta').length, 1);

  tradeSocket.emit({ stream: 'ethusdt@trade', data: { e: 'trade', s: 'ETHUSDT', p: '101', E: 1_700_000_000_100 } });
  tradeSocket.emit({ stream: 'btcusdt@trade', data: { e: 'markPriceUpdate', s: 'BTCUSDT', p: '101', E: 1_700_000_000_100 } });
  tradeSocket.emit({ stream: 'btcusdt@trade', data: { e: 'trade', s: 'BTCUSDT', p: '101', E: 1_700_000_000_100 } });
  assert.equal(messages.filter(item => item.id === 'binance-markPrice' && item.message.kind === 'price').length, 1);
  assert.equal(messages.find(item => item.id === 'binance-markPrice')?.message.instrumentId, 'binance:BTCUSDT:spot');
  tradeSocket.emit({ stream: 'btcusdt@trade', data: { e: 'trade', s: 'BTCUSDT', p: '102', T: 1_700_000_000_200 } });
  tradeSocket.emit({ stream: 'btcusdt@trade', data: { e: 'trade', s: 'BTCUSDT', p: '103' } });
  tradeSocket.emit({ stream: 'btcusdt@trade', data: { e: 'trade', s: 'BTCUSDT', p: '104', E: true, T: 1_700_000_000_300 } });
  assert.deepEqual(messages.filter(item => item.id === 'binance-markPrice' && item.message.kind === 'price').map(item => item.message.sourceTimestamp), [1_700_000_000_100, 1_700_000_000_200, null, null]);
  aggregateTradeSocket.emit({ stream: 'btcusdt@aggTrade', data: { e: 'aggTrade', s: 'BTCUSDT', a: 9, p: '102', q: '0.25', T: 1_700_000_000_200, m: false } });
  assert.equal(messages.find(item => item.id === 'binance-trades')?.message.instrumentId, 'binance:BTCUSDT:spot');

  klineSocket.emit({ stream: 'btcusdt@kline_5m', data: { e: 'kline', s: 'BTCUSDT', k: { i: '5m', t: 1_700_000_000_000, T: 1_700_000_300_000, o: '100', h: '102', l: '99', c: '101', v: '4', x: true } } });
  klineSocket.emit({ stream: 'btcusdt@kline_1m', data: { e: 'kline', s: 'BTCUSDT', k: { i: '5m', t: 1_700_000_000_000, T: 1_700_000_060_000, o: '100', h: '102', l: '99', c: '101', v: '4', x: true } } });
  klineSocket.emit({ stream: 'btcusdt@kline_1m', data: { e: 'kline', s: 'BTCUSDT', k: { i: '1m', t: 1_700_000_000_000, T: 1_700_000_060_000, o: '100', h: '102', l: '99', c: '101', v: '4', x: true } } });
  assert.equal(messages.filter(item => item.id === 'binance-kline' && item.message.kind === 'candle').length, 1);
  assert.equal(messages.find(item => item.id === 'binance-kline')?.message.instrumentId, 'binance:BTCUSDT:spot');
  manager.stop();
});

test('Binance spot depth close/reconnect fences retired sockets and requires a fresh snapshot', async () => {
  const fake = transport(); const rest = metadataTransport(); const timers:{fn:()=>unknown;delay:number}[] = []; const messages:LiveFeedEvent[] = [];
  const manager = new LiveFeedManager({ networkEnabled: true, transportFactory: fake.factory, restTransport: rest, transportPolicies: policies, oiPollMs: 0, reconnectBaseMs: 10, schedule: (fn, delay) => { timers.push({ fn, delay }); return timers.length; }, cancel: () => {}, onMessage: message => messages.push(message) });
  await manager.start({ binanceSymbol: 'BTCUSDT', binanceMarketType: 'spot', candleInterval: '1m' });
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
  second.emit(depth(21));
  assert.equal(messages.filter(item => item.id === 'binance-depth' && item.message.kind === 'depthDelta').length, before + 1);
  assert.equal(messages.filter(item => item.id === 'binance-depth' && item.message.kind === 'depthSnapshot' && item.message.complete === false).length, 1);
  manager.stop();
});

test('Binance spot depth sequence gaps invalidate and re-anchor against the REST snapshot', async () => {
  const fake = transport(); const messages:LiveFeedEvent[] = []; const requests:ExchangeRestRequest[] = []; let depthCalls = 0; let resolveResync: ((value: unknown) => void) | undefined;
  const manager = new LiveFeedManager({
    networkEnabled: true,
    transportFactory: fake.factory,
    restTransport: { request: async (request:ExchangeRestRequest) => {
      requests.push(request);
      if (request.url.includes('/exchangeInfo')) return {
        serverTime: 1_700_000_000_000,
        symbols: [{ symbol: 'BTCUSDT', status: 'TRADING', baseAsset: 'BTC', quoteAsset: 'USDT', filters: [{ filterType: 'PRICE_FILTER', tickSize: '0.01' }, { filterType: 'LOT_SIZE', stepSize: '0.00001' }] }],
      };
      if (request.url.includes('/depth')) {
        depthCalls += 1;
        if (depthCalls === 1) return { lastUpdateId: 20, bids: [['100', '2']], asks: [['101', '3']] };
        return new Promise<unknown>(resolve => { resolveResync = resolve; });
      }
      if (request.url.includes('/klines')) return [];
      return {};
    } },
    transportPolicies: policies,
    oiPollMs: 0,
    onMessage: message => messages.push(message),
  });
  await manager.start({ binanceSymbol: 'BTCUSDT', binanceMarketType: 'spot', candleInterval: '1m' });
  const depthSocket = defined(fake.sockets.find(item => item.spec.id === 'binance-depth'));
  depthSocket.emit(depth(21, { previous: 20 }));
  assert.equal(manager.status()['binance-depth'].state, 'live');

  // Binance Spot U/u ranges may overlap the last accepted update. The next
  // range still covers update 22, so normalize its previousSequence to 21.
  depthSocket.emit({ e: 'depthUpdate', E: 1_700_000_000_101, s: 'BTCUSDT', U: 21, u: 22, b: [['100', '1']], a: [] });
  assert.equal(manager.status()['binance-depth'].state, 'live');
  assert.equal(messages.some(item => item.message.kind === 'depthDelta' && item.message.sequence === 22 && item.message.previousSequence === 21), true);

  // This range starts at 25, leaving update 23 absent. Binance Spot carries
  // first/final update ranges U/u rather than the futures pu.
  depthSocket.emit(depth(25, { previous: 24 }));
  assert.equal(manager.status()['binance-depth'].state, 'unavailable');
  assert.match(textValue(manager.status()['binance-depth'].lastError), /depth sequence gap/);
  assert.equal(typeof resolveResync, 'function');
  depthSocket.emit(depth(31, { previous: 30 }));
  depthSocket.emit({ e: 'depthUpdate', E: 1_700_000_000_102, s: 'BTCUSDT', U: 31, u: 32, b: [['100', '3']], a: [] });
  defined(resolveResync)({ lastUpdateId: 30, bids: [['100', '4']], asks: [['101', '5']] });
  await new Promise(resolve => setImmediate(() => setImmediate(resolve)));

  const depthRequests = requests.filter(request => request.url.includes('/depth'));
  assert.equal(depthCalls, 2);
  assert.equal(depthRequests.every(request => new URL(request.url).pathname === '/api/v3/depth'), true);
  assert.equal(depthRequests.every(request => new URL(request.url).searchParams.get('symbol') === 'BTCUSDT'), true);
  assert.equal(messages.some(item => item.message.kind === 'depthSnapshot' && item.message.invalidated === true), true);
  assert.equal(messages.some(item => item.message.kind === 'depthSnapshot' && item.message.complete === true && item.message.sequence === 30), true);
  assert.equal(messages.some(item => item.message.kind === 'depthDelta' && item.message.sequence === 31 && item.message.previousSequence === 30), true);
  assert.equal(messages.some(item => item.message.kind === 'depthDelta' && item.message.sequence === 32 && item.message.previousSequence === 31), true);
  assert.equal(manager.status()['binance-depth'].state, 'live');
  manager.stop();
});
