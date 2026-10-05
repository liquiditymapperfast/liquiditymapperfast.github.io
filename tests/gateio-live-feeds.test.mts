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

function snapshot(id = '10') {
  return { channel: 'futures.order_book', event: 'all', time_ms: 1_700_000_000_000, result: { t: 1_700_000_000_000, contract: 'BTC_USDT', id, asks: [{ p: '101', s: '3' }], bids: [{ p: '100', s: '2' }] } };
}

test('Gate.io live depth subscribes, registers a contract market, and feeds the grouped-book state', async () => {
  const fake = transport();
  const app = createLocalServer({ liveMode: true, persistFixture: false, quota: new QuotaLedger(), history: new HistoryStore({ filePath: ':memory:' }) });
  const restCalls: string[] = [];
  const manager = new LiveFeedManager({
    networkEnabled: true, transportFactory: fake.factory, oiPollMs: 0,
    restTransport: { request: async (request:ExchangeRestRequest) => { restCalls.push(request.url); if (request.url.includes('/futures/usdt/contracts')) return [{ name: 'BTC_USDT', status: 'trading', order_price_round: '0.1', quanto_multiplier: '0.0001', settle: 'usdt' }]; return { universe: [{ name: 'BTC', szDecimals: 3 }], assetCtxs: [{ markPx: '100' }] }; } },
    onMessage: ({ venue, message }) => app.applyMessage(message, venue),
  });
  await manager.start({ gateioEnabled: true, gateioSymbol: 'BTC_USDT' });
  const socket = fake.sockets.find(item => item.spec.venue === 'gateio');
  assert.ok(socket);
  assert.deepEqual(JSON.parse(socket.sent[0]), { time: JSON.parse(socket.sent[0]).time, channel: 'futures.order_book', event: 'subscribe', payload: ['BTC_USDT', '100', '0'] });
  socket.emit({ event: 'subscribe', channel: 'futures.order_book', result: { status: 'success' } });
  socket.emit(snapshot()); socket.emit(snapshot('11'));
  assert.equal(restCalls.some(url => url.includes('/futures/usdt/contracts/BTC_USDT')), true);
  assert.equal(manager.status()['gateio-depth'].state, 'live');
  assert.equal(app.state.markets.some(item => item.instrumentId === 'gateio:BTC_USDT' && item.contractValue === 0.0001), true);
  assert.equal(app.state.books['gateio:BTC_USDT']?.complete, true);
  assert.equal(app.state.books['gateio:BTC_USDT']?.bids?.length, 1);
  manager.stop(); app.close();
});

test('Gate.io subscription errors invalidate the public session and schedule recovery', async () => {
  const fake = transport(); const timers:{fn:()=>unknown;delay:number}[] = [];
  const manager = new LiveFeedManager({ networkEnabled: true, transportFactory: fake.factory, oiPollMs: 0, reconnectBaseMs: 10, schedule: (fn, delay) => { timers.push({ fn, delay }); return timers.length; }, cancel: () => {} });
  await manager.start({ gateioEnabled: true, gateioSymbol: 'BTC_USDT' });
  const first = defined(fake.sockets.find(item => item.spec.venue === 'gateio'));
  first.emit({ event: 'subscribe', channel: 'futures.order_book', error: { message: 'denied' } });
  assert.equal(manager.status()['gateio-depth'].state, 'backoff');
  assert.equal(first.closed, true);
  assert.equal(timers.length, 1);
  manager.stop();
});
