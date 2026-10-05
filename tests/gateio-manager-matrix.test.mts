import { defined, fields, list, numeric, textValue } from './server-test-helpers.mts';
import type { LiveFeedTransportOptions, LiveFeedSocket, LiveFeedEvent, LiveFeedStatusEvent } from '../src/server/live-feeds.mts';
import type { ExchangeRestRequest } from '../src/server/rest-transport.mts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { LiveFeedManager } from '../src/server/live-feeds.mts';
import { getVenue } from '../src/domain/venue-registry.mts';

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

function transport() {
  const sockets:FakeSocket[] = [];
  return { sockets, factory: async (spec:LiveFeedTransportOptions) => { const socket = new FakeSocket(spec); sockets.push(socket); return socket; } };
}

function ack({ channel = 'futures.order_book', contract = null, status = 'success' }: {channel?: string; contract?: string | null; status?: string} = {}) {
  return {
    event: 'subscribe',
    channel,
    ...(contract == null ? {} : { payload: [contract, '100', '0'] }),
    result: { status },
  };
}

function snapshot(id = '10', { channel = 'futures.order_book', contract = 'BTC_USDT' } = {}) {
  return {
    channel,
    event: 'all',
    time_ms: 1_700_000_000_000,
    result: {
      t: 1_700_000_000_000,
      contract,
      id,
      asks: [{ p: '101', s: '3' }],
      bids: [{ p: '100', s: '2' }],
    },
  };
}

function metadataTransport() {
  return { request: async (request:ExchangeRestRequest) => request.url.includes('/futures/usdt/contracts')
    ? [{ name: 'BTC_USDT', status: 'trading', order_price_round: '0.1', quanto_multiplier: '0.0001', settle: 'usdt' }]
    : { universe: [{ name: 'BTC', szDecimals: 3 }], assetCtxs: [{ markPx: '100' }] } };
}

test('Gate.io manager requires a matching success acknowledgement and handles JSON/Buffer pong frames', async () => {
  const fake = transport();
  const manager = new LiveFeedManager({ networkEnabled: true, transportFactory: fake.factory, oiPollMs: 0 });
  await manager.start({ gateioEnabled: true, gateioSymbol: 'BTC_USDT' });
  const socket = fake.sockets.find(item => item.spec.venue === 'gateio');
  assert.ok(socket);
  assert.equal(manager.status()['gateio-depth'].subscriptionAcked, false);
  socket.emit(JSON.stringify(ack({ channel: 'spot.order_book', contract: 'BTC_USDT' })));
  socket.emit(JSON.stringify(ack({ contract: 'ETH_USDT' })));
  socket.emit(JSON.stringify({ ...ack({ contract: 'BTC_USDT' }), payload: ['BTC_USDT', '20', '0'] }));
  assert.equal(manager.status()['gateio-depth'].subscriptionAcked, false);
  socket.emit(Buffer.from(JSON.stringify(ack({ contract: 'BTC_USDT' }))));
  assert.equal(manager.status()['gateio-depth'].subscriptionAcked, true);
  socket.emit(JSON.stringify({ channel: 'futures.pong', event: '', result: null }));
  socket.emit(Buffer.from(JSON.stringify({ channel: 'futures.pong', event: '', result: null })));
  assert.equal(manager.status()['gateio-depth'].subscriptionAckSource, 'heartbeat');
  assert.equal(manager.status()['gateio-depth'].lastError, null);
  manager.stop();
});

test('Gate.io manager preserves contract units, fences wrong frames, and recovers with a fresh full snapshot', async () => {
  const fake = transport(); const timers:{fn:()=>unknown;delay:number}[] = []; const messages:LiveFeedEvent[] = [];
  const manager = new LiveFeedManager({
    networkEnabled: true,
    transportFactory: fake.factory,
    restTransport: metadataTransport(),
    oiPollMs: 0,
    reconnectBaseMs: 10,
    schedule: (fn, delay) => { timers.push({ fn, delay }); return timers.length; },
    cancel: () => {},
    onMessage: message => messages.push(message),
  });
  await manager.start({ selectedOrderbookVenues: ['gateio'], gateioEnabled: true, gateioSymbol: 'BTC_USDT' });
  const first = defined(fake.sockets.find(item => item.spec.venue === 'gateio'));
  first.emit(ack({ contract: 'BTC_USDT' }));
  first.emit(snapshot('9', { channel: 'spot.order_book' }));
  first.emit(snapshot('9', { contract: 'ETH_USDT' }));
  assert.equal(messages.filter(item => item.message?.kind === 'depthSnapshot').length, 0);
  first.emit(snapshot('10'));
  first.emit(snapshot('11'));
  assert.equal(messages.filter(item => item.message?.kind === 'depthSnapshot' && item.message.complete === true).length, 2);
  const metadata = defined(messages.find(item => item.venue === 'gateio' && item.message?.kind === 'metadata')?.message);
  assert.equal(defined(metadata.assets).find(asset => asset.instrumentId === 'gateio:BTC_USDT')?.quantityUnit, 'contract');
  assert.equal(defined(metadata.assets).find(asset => asset.instrumentId === 'gateio:BTC_USDT')?.contractValue, 0.0001);
  assert.equal(defined(getVenue('gateio')).capabilities.l2.state, 'supported');
  first.closeWith('lost');
  assert.equal(manager.status()['gateio-depth'].state, 'backoff');
  assert.equal(first.closed, true);
  assert.equal(messages.filter(item => item.message?.kind === 'depthSnapshot' && item.message.complete === false).length, 1);
  assert.equal(timers.length, 1);
  await timers[0].fn();
  const second = defined(fake.sockets.filter(item => item.spec.venue === 'gateio').at(-1));
  assert.notStrictEqual(second, first);
  assert.equal(manager.status()['gateio-depth'].state, 'snapshot');
  second.emit(ack({ contract: 'BTC_USDT' }));
  second.emit(snapshot('20'));
  first.emit(snapshot('999'));
  assert.equal(manager.status()['gateio-depth'].state, 'live');
  assert.equal(messages.filter(item => item.message?.kind === 'depthSnapshot' && item.message.complete === true).length, 3);
  manager.stop();
});

test('Gate.io non-success acknowledgement fails closed and schedules one recovery', async () => {
  const fake = transport(); const timers:{fn:()=>unknown;delay:number}[] = [];
  const manager = new LiveFeedManager({
    networkEnabled: true,
    transportFactory: fake.factory,
    oiPollMs: 0,
    schedule: (fn, delay) => { timers.push({ fn, delay }); return timers.length; },
    cancel: () => {},
  });
  await manager.start({ gateioEnabled: true, gateioSymbol: 'BTC_USDT' });
  const first = defined(fake.sockets.find(item => item.spec.venue === 'gateio'));
  first.emit(ack({ status: 'error' }));
  assert.equal(manager.status()['gateio-depth'].state, 'backoff');
  assert.equal(first.closed, true);
  assert.equal(timers.length, 1);
  manager.stop();
});
