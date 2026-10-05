import { defined, fields, list, numeric, textValue } from './server-test-helpers.mts';
import type { LiveFeedTransportOptions, LiveFeedSocket, LiveFeedEvent, LiveFeedStatusEvent } from '../src/server/live-feeds.mts';
import type { ExchangeRestRequest } from '../src/server/rest-transport.mts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { LiveFeedManager } from '../src/server/live-feeds.mts';
import { createLocalServer } from '../src/server/http.mts';
import { HistoryStore } from '../src/server/history.mts';
import { QuotaLedger } from '../src/core/quota.mts';

class FakeSocket {
  declare spec:LiveFeedTransportOptions; declare sent:string[]; declare closed:boolean; declare opened?:boolean;
  declare onMessage:((raw:unknown)=>void)|undefined; declare onClose:((reason:unknown)=>void)|undefined; declare onError:((error:unknown)=>void)|undefined;
  constructor(spec:LiveFeedTransportOptions) { this.spec = spec; this.sent = []; this.closed = false; this.onMessage = undefined; this.onClose = undefined; this.onError = undefined; }
  async open() { this.opened = true; }
  send(value:string) { this.sent.push(value); }
  close() { this.closed = true; }
  emit(value:unknown) { this.onMessage?.(value); }
  closeWith(reason = 'closed') { this.onClose?.(reason); }
}
function transport() { const sockets:FakeSocket[] = []; return { sockets, factory: async (spec:LiveFeedTransportOptions) => { const socket = new FakeSocket(spec); sockets.push(socket); return socket; } }; }

function okxSnapshot(seq = 10) { return { arg: { channel: 'books', instId: 'BTC-USDT-SWAP' }, action: 'snapshot', data: [{ asks: [['101', '3', '0', '1']], bids: [['100', '2', '0', '1']], ts: '1700000000000', seqId: String(seq), prevSeqId: '-1' }] }; }
function okxUpdate(seq = 11, prev = 10) { return { arg: { channel: 'books', instId: 'BTC-USDT-SWAP' }, action: 'update', data: [{ asks: [['101', '0', '0', '0']], bids: [['99', '4', '0', '1']], ts: '1700000000100', seqId: String(seq), prevSeqId: String(prev) }] }; }
function bitgetSnapshot(seq = '9007199254740993') { return { arg: { instType: 'usdt-futures', topic: 'books', symbol: 'BTCUSDT' }, action: 'snapshot', data: [{ a: [['101', '3']], b: [['100', '2']], ts: '1700000000000', seq: String(seq) }] }; }
function bitgetUpdate(seq = '9007199254740994', prev = '9007199254740993') { return { arg: { instType: 'usdt-futures', topic: 'books', symbol: 'BTCUSDT' }, action: 'update', data: [{ a: [['101', '0']], b: [['99', '4']], ts: '1700000000100', seq: String(seq), pseq: String(prev) }] }; }

test('OKX and Bitget public L2 sessions subscribe, normalize, and route snapshots/deltas', async () => {
  const fake = transport(); const messages:LiveFeedEvent[] = [];
  const manager = new LiveFeedManager({ networkEnabled: true, transportFactory: fake.factory, oiPollMs: 0, onMessage: message => messages.push(message) });
  await manager.start({ okxEnabled: true, okxSymbol: 'BTC-USDT-SWAP', bitgetEnabled: true, bitgetSymbol: 'BTCUSDT' });
  const okx = defined(fake.sockets.find(item => item.spec.venue === 'okx')); const bitget = defined(fake.sockets.find(item => item.spec.venue === 'bitget'));
  assert.deepEqual(JSON.parse(okx.sent[0]), { op: 'subscribe', args: [{ channel: 'books', instId: 'BTC-USDT-SWAP' }] });
  assert.deepEqual(JSON.parse(bitget.sent[0]), { op: 'subscribe', args: [{ instType: 'usdt-futures', topic: 'books', symbol: 'BTCUSDT' }] });
  okx.emit({ event: 'subscribe', arg: { channel: 'books', instId: 'BTC-USDT-SWAP' } }); bitget.emit({ event: 'subscribe', arg: { instType: 'usdt-futures', topic: 'books', symbol: 'BTCUSDT' } });
  okx.emit(okxSnapshot()); okx.emit(okxUpdate()); bitget.emit(bitgetSnapshot()); bitget.emit(bitgetUpdate());
  assert.equal(messages.filter(item => item.venue === 'okx' && item.message.kind === 'depthSnapshot').length, 1);
  assert.equal(messages.filter(item => item.venue === 'okx' && item.message.kind === 'depthDelta').length, 1);
  assert.equal(messages.filter(item => item.venue === 'bitget' && item.message.kind === 'depthSnapshot').length, 1);
  assert.equal(messages.filter(item => item.venue === 'bitget' && item.message.kind === 'depthDelta').length, 1);
  assert.equal(manager.status()['okx-depth'].state, 'live'); assert.equal(manager.status()['bitget-depth'].state, 'live');
  manager.stop();
});

test('public depth sequence gaps publish invalidation and schedule a fresh subscription', async () => {
  const fake = transport(); const timers:{fn:()=>unknown;delay:number}[] = []; const messages:LiveFeedEvent[] = [];
  const manager = new LiveFeedManager({ networkEnabled: true, transportFactory: fake.factory, oiPollMs: 0, reconnectBaseMs: 10, schedule: (fn, delay) => { timers.push({ fn, delay }); return timers.length; }, cancel: () => {}, onMessage: message => messages.push(message) });
  await manager.start({ okxEnabled: true, okxSymbol: 'BTC-USDT-SWAP' });
  const first = defined(fake.sockets.find(item => item.spec.venue === 'okx')); first.emit(okxSnapshot(10)); first.emit(okxUpdate(12, 11));
  assert.equal(messages.filter(item => item.message.kind === 'depthSnapshot' && item.message.complete === false).length, 1);
  assert.equal(manager.status()['okx-depth'].state, 'backoff'); assert.equal(first.closed, true); assert.equal(timers.length, 1);
  await timers[0].fn(); const second = defined(fake.sockets.filter(item => item.spec.venue === 'okx').at(-1)); assert.notStrictEqual(second, first); assert.equal(manager.status()['okx-depth'].state, 'snapshot');
  first.emit(okxSnapshot(99)); assert.equal(messages.filter(item => item.message.kind === 'depthSnapshot' && item.message.complete === true).length, 1);
  second.emit(okxSnapshot(20)); second.emit(okxUpdate(21, 20)); assert.equal(messages.filter(item => item.message.kind === 'depthDelta').length, 1); manager.stop();
});

test('provider acknowledgement errors are not ignored and unsafe raw sequence numbers back off', async () => {
  const fake = transport(); const timers:{fn:()=>unknown;delay:number}[] = []; const manager = new LiveFeedManager({ networkEnabled: true, transportFactory: fake.factory, oiPollMs: 0, schedule: (fn, delay) => { timers.push({ fn, delay }); return timers.length; }, cancel: () => {}, onMessage: () => {} });
  await manager.start({ bitgetEnabled: true, bitgetSymbol: 'BTCUSDT' }); const bitget = defined(fake.sockets.find(item => item.spec.venue === 'bitget'));
  bitget.emit({ event: 'subscribe', code: '10001', msg: 'denied' }); assert.equal(manager.status()['bitget-depth'].state, 'backoff'); assert.equal(bitget.closed, true); assert.equal(timers.length, 1); manager.stop();
  const fakeRaw = transport(); const rawManager = new LiveFeedManager({ networkEnabled: true, transportFactory: fakeRaw.factory, oiPollMs: 0, schedule: () => 1, cancel: () => {}, onMessage: () => {} });
  await rawManager.start({ okxEnabled: true, okxSymbol: 'BTC-USDT-SWAP' }); const okx = defined(fakeRaw.sockets.find(item => item.spec.venue === 'okx')); okx.emit(JSON.stringify({ action: 'snapshot', arg: { channel: 'books', instId: 'BTC-USDT-SWAP' }, data: [{ asks: [], bids: [], seqId: 9007199254740994 }] })); assert.equal(rawManager.status()['okx-depth'].state, 'backoff'); rawManager.stop();
});

test('OKX and Bitget L2 snapshots register native OKX contract and Bitget base markets in local state', async () => {
  const fake = transport(); const app = createLocalServer({ liveMode: true, persistFixture: false, quota: new QuotaLedger(), history: new HistoryStore({ filePath: ':memory:' }) });
  const manager = new LiveFeedManager({ networkEnabled: true, transportFactory: fake.factory, oiPollMs: 0, onMessage: ({ venue, message }) => app.applyMessage(message, venue) });
  await manager.start({ okxEnabled: true, okxSymbol: 'BTC-USDT-SWAP', bitgetEnabled: true, bitgetSymbol: 'BTCUSDT' });
  defined(fake.sockets.find(item => item.spec.venue === 'okx')).emit(okxSnapshot()); defined(fake.sockets.find(item => item.spec.venue === 'bitget')).emit(bitgetSnapshot());
  assert.equal(app.state.markets.some(item => item.instrumentId === 'okx:BTC-USDT-SWAP' && item.quantityUnit === 'contract'), true);
  assert.equal(app.state.markets.some(item => item.instrumentId === 'bitget:BTCUSDT' && item.quantityUnit === 'base'), true);
  assert.equal(app.state.books['okx:BTC-USDT-SWAP'].complete, true); assert.equal(app.state.books['bitget:BTCUSDT'].complete, true);
  manager.stop(); app.close();
});

test('provider metadata hydrates verified OKX face value and uses documented Bitget base quantities', async () => {
  const fake = transport();
  const app = createLocalServer({ liveMode: true, persistFixture: false, quota: new QuotaLedger(), history: new HistoryStore({ filePath: ':memory:' }) });
  const restCalls: string[] = [];
  const manager = new LiveFeedManager({
    networkEnabled: true,
    transportFactory: fake.factory,
    restTransport: {
      request: async (request:ExchangeRestRequest) => {
        restCalls.push(request.url);
        if (request.url.includes('okx.com')) return { code: '0', data: [{ instType: 'SWAP', instId: 'BTC-USDT-SWAP', state: 'live', baseCcy: 'BTC', quoteCcy: 'USDT', tickSz: '0.1', lotSz: '0.01', ctVal: '0.01', ctValCcy: 'BTC', ctType: 'linear', settleCcy: 'USDT' }] };
        if (request.url.includes('bitget.com')) return { code: '00000', requestTime: 1_700_000_000_000, data: [{ category: 'USDT-FUTURES', symbol: 'BTCUSDT', baseCoin: 'BTC', quoteCoin: 'USDT', status: 'online', priceMultiplier: '0.1', quantityMultiplier: '0.0001' }] };
        return { universe: [{ name: 'BTC', szDecimals: 3 }], assetCtxs: [{ markPx: '100' }] };
      },
    },
    oiPollMs: 0,
    onMessage: ({ venue, message }) => app.applyMessage(message, venue),
  });
  await manager.start({ okxEnabled: true, okxSymbol: 'BTC-USDT-SWAP', bitgetEnabled: true, bitgetSymbol: 'BTCUSDT' });
  assert.equal(restCalls.some(url => url.includes('/api/v5/public/instruments')), true);
  assert.equal(restCalls.some(url => url.includes('/api/v3/market/instruments')), true);
  defined(fake.sockets.find(item => item.spec.venue === 'okx')).emit(okxSnapshot());
  defined(fake.sockets.find(item => item.spec.venue === 'bitget')).emit(bitgetSnapshot());
  assert.equal(app.state.markets.find(item => item.instrumentId === 'okx:BTC-USDT-SWAP')?.contractValue, 0.01);
  assert.equal(app.state.markets.find(item => item.instrumentId === 'bitget:BTCUSDT')?.contractValue ?? null, null);
  assert.equal(app.state.books['okx:BTC-USDT-SWAP']?.contractValue, 0.01);
  assert.equal(app.state.books['bitget:BTCUSDT']?.contractValue, undefined);
  assert.equal(app.state.books['bitget:BTCUSDT']?.units, 'base');
  const okxMarket = defined(app.state.markets.find(item => item.instrumentId === 'okx:BTC-USDT-SWAP'));
  okxMarket.base = ''; okxMarket.quote = '';
  app.applyMessage({ kind: 'metadata', venue: 'okx', receivedAt: 1_700_000_000_200, assets: [{ instrumentId: 'okx:BTC-USDT-SWAP', base: 'BTC', quote: 'USDT', baseNormalized: 'BTC', quoteNormalized: 'USDT' }] }, 'okx');
  const repairedOkxMarket = defined(app.state.markets.find(item => item.instrumentId === 'okx:BTC-USDT-SWAP'));
  assert.equal(repairedOkxMarket.base, 'BTC'); assert.equal(repairedOkxMarket.quote, 'USDT');
  manager.stop(); app.close();
});
