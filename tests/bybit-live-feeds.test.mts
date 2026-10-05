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
function snapshot(u = 1, price = '100') { return { topic: 'orderbook.1000.BTCUSDT', type: 'snapshot', ts: 1_700_000_000_000, data: { category: 'linear', s: 'BTCUSDT', u, b: [[price, '2']], a: [['101', '3']] } }; }
function delta(u = 2) { return { topic: 'orderbook.1000.BTCUSDT', type: 'delta', ts: 1_700_000_000_100, data: { category: 'linear', s: 'BTCUSDT', u, b: [['100', '0'], ['99', '1']], a: [] } }; }

test('Bybit feed is opt-in and subscribes only when explicitly enabled', async () => {
  const fake = transport(); const manager = new LiveFeedManager({ networkEnabled: true, transportFactory: fake.factory, oiPollMs: 0 });
  await manager.start(); assert.equal(fake.sockets.some(socket => socket.spec.venue === 'bybit'), false);
  manager.stop();
  const enabled = new LiveFeedManager({ networkEnabled: true, transportFactory: fake.factory, oiPollMs: 0 }); await enabled.start({ bybitEnabled: true, bybitSymbol: 'BTCUSDT' });
  const socket = fake.sockets.find(item => item.spec.venue === 'bybit'); assert.ok(socket); assert.deepEqual(JSON.parse(socket.sent[0]), { op: 'subscribe', args: ['orderbook.1000.BTCUSDT'] }); assert.equal(enabled.status()['bybit-depth'].state, 'snapshot'); enabled.stop();
});

test('Bybit runtime decoder routes snapshot/delta and ignores wrong topic/session', async () => {
  const fake = transport(); const messages:LiveFeedEvent[] = []; const manager = new LiveFeedManager({ networkEnabled: true, transportFactory: fake.factory, oiPollMs: 0, onMessage: message => messages.push(message) });
  await manager.start({ bybitEnabled: true, bybitSymbol: 'BTCUSDT' }); const socket = defined(fake.sockets.find(item => item.spec.venue === 'bybit'));
  socket.emit({ op: 'pong', args: ['ok'] }); socket.emit({ op: 'subscribe', success: true, retCode: 0 }); assert.equal(manager.status()['bybit-depth'].state, 'snapshot');
  socket.emit({ ...snapshot(), topic: 'orderbook.1000.ETHUSDT' }); assert.equal(messages.filter(item => item.venue === 'bybit').length, 0);
  socket.emit(snapshot()); assert.equal(messages.filter(item => item.message.kind === 'depthSnapshot').length, 1); assert.equal(manager.status()['bybit-depth'].state, 'live');
  socket.emit(delta()); assert.equal(messages.filter(item => item.message.kind === 'depthDelta').length, 1);
  socket.emit({ ...snapshot(), data: { ...snapshot().data, s: 'ETHUSDT' } }); assert.equal(manager.status()['bybit-depth'].state, 'live'); assert.equal(messages.filter(item => item.message.kind === 'depthSnapshot').length, 1);
  manager.stop();
});

test('Bybit disconnect cleanup does not clear simultaneous Binance depth state', async () => {
  const fake = transport(); const messages:LiveFeedEvent[] = []; const manager = new LiveFeedManager({ networkEnabled: true, transportFactory: fake.factory, restTransport: { request: async (request:ExchangeRestRequest) => request.url.includes('/depth') ? { lastUpdateId: 20, bids: [['100', '1']], asks: [['101', '1']] } : { openInterest: '1', time: 1_700_000_000_000 } }, oiPollMs: 0, onMessage: message => messages.push(message) });
  await manager.start({ bybitEnabled: true, bybitSymbol: 'BTCUSDT' }); const bybit = defined(fake.sockets.find(item => item.spec.venue === 'bybit')); const binance = defined(fake.sockets.find(item => item.spec.venue === 'binance' && item.spec.channel === 'depth'));
  bybit.emit({ op: 'subscribe', success: true, retCode: 0 }); bybit.emit(snapshot()); bybit.closeWith('lost'); binance.emit({ stream: 'btcusdt@depth', data: { e: 'depthUpdate', E: 1_700_000_000_000, s: 'BTCUSDT', U: 21, pu: 20, u: 21, b: [['100', '2']], a: [] } }); assert.equal(messages.some(item => item.id === 'binance-depth' && item.message.kind === 'depthDelta'), true); manager.stop();
});

test('malformed Bybit payload and negative subscribe ack back off and reconnect', async () => {
  const fake = transport(); const timers:{fn:()=>unknown;delay:number}[] = []; const manager = new LiveFeedManager({ networkEnabled: true, transportFactory: fake.factory, oiPollMs: 0, schedule: (fn, delay) => { timers.push({ fn, delay }); return timers.length; }, cancel: () => {} });
  await manager.start({ bybitEnabled: true, bybitSymbol: 'BTCUSDT' }); const first = defined(fake.sockets.find(item => item.spec.venue === 'bybit')); first.emit({ op: 'subscribe', success: true, retCode: 0 }); first.emit({ topic: 'orderbook.1000.BTCUSDT', type: 'delta', data: { category: 'linear', s: 'BTCUSDT', u: 2 } }); assert.equal(manager.status()['bybit-depth'].state, 'backoff'); assert.equal(first.closed, true); assert.equal(timers.length, 1); first.emit(snapshot()); assert.equal(manager.status()['bybit-depth'].state, 'backoff'); await timers[0].fn(); const second = defined(fake.sockets.filter(item => item.spec.venue === 'bybit').at(-1)); second.emit({ op: 'subscribe', success: false, ret_msg: 'permission denied' }); assert.equal(manager.status()['bybit-depth'].state, 'backoff'); assert.equal(second.closed, true); assert.equal(timers.length, 2); manager.stop();
});

test('missing Bybit snapshot update ID invalidates the accepted book and schedules recovery', async () => {
  const fake = transport(); const timers:{fn:()=>unknown;delay:number}[] = []; const messages:LiveFeedEvent[] = [];
  const manager = new LiveFeedManager({ networkEnabled: true, transportFactory: fake.factory, oiPollMs: 0, schedule: (fn, delay) => { timers.push({ fn, delay }); return timers.length; }, cancel: () => {}, onMessage: message => messages.push(message) });
  await manager.start({ bybitEnabled: true, bybitSymbol: 'BTCUSDT' }); const socket = defined(fake.sockets.find(item => item.spec.venue === 'bybit'));
  socket.emit({ op: 'subscribe', success: true, retCode: 0 }); socket.emit(snapshot(10)); assert.equal(manager.status()['bybit-depth'].state, 'live');
  socket.emit({ ...snapshot(11), data: { ...snapshot(11).data, u: undefined } });
  assert.equal(manager.status()['bybit-depth'].state, 'backoff'); assert.equal(socket.closed, true); assert.equal(timers.length, 1);
  const invalidation = defined(messages.at(-1)?.message); assert.equal(invalidation.kind, 'depthSnapshot'); assert.equal(invalidation.complete, false); assert.equal(invalidation.resyncRequired, true); assert.equal(invalidation.sourceTimestamp, null);
  manager.stop();
});

test('Bybit feed reducer integration accepts nonconsecutive IDs and invalidates downstream on reconnect', async () => {
  const fake = transport(); let reconnectTimer: {fn: () => unknown; delay: number} | undefined; const app = createLocalServer({ liveMode: true, persistFixture: false, quota: new QuotaLedger(), history: new HistoryStore({ filePath: ':memory:' }) }); const manager = new LiveFeedManager({ networkEnabled: true, transportFactory: fake.factory, oiPollMs: 0, schedule: (fn, delay) => { reconnectTimer = { fn, delay }; return reconnectTimer; }, cancel: () => {}, onMessage: ({ venue, message }) => app.applyMessage(message, venue) });
  await manager.start({ bybitEnabled: true, bybitSymbol: 'BTCUSDT' }); const first = defined(fake.sockets.find(item => item.spec.venue === 'bybit')); first.emit({ op: 'subscribe', success: true, retCode: 0 }); first.emit(snapshot(10)); assert.equal(app.state.markets.some(item => item.instrumentId === 'bybit:BTCUSDT'), true); first.emit(delta(13)); assert.equal(app.state.books['bybit:BTCUSDT'].sequence, 13); assert.equal(app.state.books['bybit:BTCUSDT'].complete, true); first.closeWith('lost'); assert.equal(app.state.books['bybit:BTCUSDT'].complete, false); first.emit(snapshot(99)); assert.equal(app.state.books['bybit:BTCUSDT'].complete, false); await defined(reconnectTimer).fn(); const second = defined(fake.sockets.filter(item => item.spec.venue === 'bybit').at(-1)); second.emit({ op: 'subscribe', success: true, retCode: 0 }); second.emit(delta(2)); assert.equal(app.state.books['bybit:BTCUSDT'].complete, false); second.emit(snapshot(1, '90')); assert.equal(app.state.books['bybit:BTCUSDT'].complete, true); assert.equal(app.state.books['bybit:BTCUSDT'].sequence, 1); manager.stop(); app.close();
});

test('Bybit close reconnects with a fresh session and blocks deltas until snapshot', async () => {
  const fake = transport(); const timers:{fn:()=>unknown;delay:number}[] = []; const messages:LiveFeedEvent[] = []; const manager = new LiveFeedManager({ networkEnabled: true, transportFactory: fake.factory, oiPollMs: 0, reconnectBaseMs: 10, schedule: (fn, delay) => { timers.push({ fn, delay }); return timers.length; }, cancel: () => {}, onMessage: message => messages.push(message) });
  await manager.start({ bybitEnabled: true, bybitSymbol: 'BTCUSDT' }); const first = defined(fake.sockets.find(item => item.spec.venue === 'bybit')); first.emit({ op: 'subscribe', success: true, retCode: 0 }); first.emit(snapshot()); first.closeWith('lost'); assert.equal(manager.status()['bybit-depth'].state, 'backoff'); assert.equal(timers.length, 1); await timers[0].fn();
  const second = defined(fake.sockets.filter(item => item.spec.venue === 'bybit').at(-1)); assert.notStrictEqual(second, first); assert.equal(manager.status()['bybit-depth'].state, 'snapshot'); second.emit({ op: 'subscribe', success: true, retCode: 0 });
  first.emit(delta(99)); assert.equal(messages.filter(item => item.message.kind === 'depthDelta').length, 0);
  second.emit(delta(2)); assert.equal(messages.filter(item => item.message.kind === 'depthDelta').length, 0);
  second.emit(snapshot(1, '90')); assert.equal(messages.filter(item => item.message.kind === 'depthSnapshot' && item.message.complete === true).length, 2); assert.equal(messages.filter(item => item.message.kind === 'depthSnapshot' && item.message.complete === false).length, 1); second.emit(delta(2)); assert.equal(messages.filter(item => item.message.kind === 'depthDelta').length, 1); manager.stop();
});
