import { defined, fields, list, numeric, textValue } from './server-test-helpers.mts';
import type { LiveFeedTransportOptions, LiveFeedSocket, LiveFeedEvent, LiveFeedStatusEvent } from '../src/server/live-feeds.mts';
import type { ExchangeRestRequest } from '../src/server/rest-transport.mts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { LiveFeedManager } from '../src/server/live-feeds.mts';
import { applyPublicDepthSessionMessage, createPublicDepthSession, normalizeBitgetDepth } from '../src/adapters/index.mts';
import { getVenue } from '../src/domain/venue-registry.mts';

class FakeSocket {
  declare spec:LiveFeedTransportOptions; declare sent:string[]; declare closed:boolean; declare opened?:boolean;
  declare onMessage:((raw:unknown)=>void)|undefined; declare onClose:((reason:unknown)=>void)|undefined; declare onError:((error:unknown)=>void)|undefined;
  constructor(spec:LiveFeedTransportOptions) { this.spec = spec; this.sent = []; this.closed = false; this.onMessage = undefined; this.onClose = undefined; this.onError = undefined; }
  async open() { this.opened = true; }
  send(value:string) { this.sent.push(value); }
  close() { this.closed = true; }
  emit(value:unknown) { this.onMessage?.(value); }
}

function transport() {
  const sockets:FakeSocket[] = [];
  return { sockets, factory: async (spec:LiveFeedTransportOptions) => { const socket = new FakeSocket(spec); sockets.push(socket); return socket; } };
}

function ack(symbol = 'BTCUSDT', topic = 'books', instType = 'usdt-futures') {
  return { event: 'subscribe', arg: { instType, topic, symbol } };
}

function snapshot(sequence: string | number = '100') {
  return { arg: { instType: 'usdt-futures', topic: 'books', symbol: 'BTCUSDT' }, action: 'snapshot', data: [{ a: [['101', '3']], b: [['100', '2']], ts: '1700000000000', seq: String(sequence) }] };
}

function update(sequence: string | number = '110', previous: string | number = '90') {
  return { arg: { instType: 'usdt-futures', topic: 'books', symbol: 'BTCUSDT' }, action: 'update', data: [{ a: [['101', '0']], b: [['99', '4']], ts: '1700000000100', seq: String(sequence), pseq: String(previous) }] };
}

test('Bitget books allow one documented first-update range bridge, then require exact pseq continuity', () => {
  let session = createPublicDepthSession({ venue: 'bitget', topic: 'books:BTCUSDT', instrumentId: 'bitget:BTCUSDT', sessionToken: 's1' });
  let routed = applyPublicDepthSessionMessage(session, { topic: session.topic, sessionToken: 's1', update: normalizeBitgetDepth(snapshot(100)) });
  assert.equal(routed.accepted, true); session = routed.session;
  routed = applyPublicDepthSessionMessage(session, { topic: session.topic, sessionToken: 's1', update: normalizeBitgetDepth(update(110, 90)) });
  assert.equal(routed.accepted, true);
  assert.equal(defined(routed.session.book).continuity, 'provider-range');
  assert.equal(defined(routed.session.book).sequenceBridge, true);
  session = routed.session;
  routed = applyPublicDepthSessionMessage(session, { topic: session.topic, sessionToken: 's1', update: normalizeBitgetDepth(update(120, 115)) });
  assert.equal(routed.reason, 'resync-required');
  routed = applyPublicDepthSessionMessage(routed.session, { topic: session.topic, sessionToken: 's1', update: normalizeBitgetDepth(snapshot(200)) });
  assert.equal(routed.accepted, true); session = routed.session;
  routed = applyPublicDepthSessionMessage(session, { topic: session.topic, sessionToken: 's1', update: normalizeBitgetDepth(update(220, 0)) });
  assert.equal(routed.reason, 'resync-required');
  assert.equal(routed.session.invalidated, true);
  routed = applyPublicDepthSessionMessage(routed.session, { topic: session.topic, sessionToken: 's1', update: normalizeBitgetDepth(snapshot(0)) });
  assert.equal(routed.accepted, true); session = routed.session;
  routed = applyPublicDepthSessionMessage(session, { topic: session.topic, sessionToken: 's1', update: normalizeBitgetDepth(update(0, 0)) });
  assert.equal(routed.reason, 'resync-required');
  assert.equal(routed.session.invalidated, true);
});

test('Bitget manager requires a matching subscription acknowledgement and handles raw and Buffer pong', async () => {
  const fake = transport();
  const manager = new LiveFeedManager({ networkEnabled: true, transportFactory: fake.factory, oiPollMs: 0 });
  await manager.start({ bitgetEnabled: true, bitgetSymbol: 'BTCUSDT' });
  const socket = defined(fake.sockets.find(item => item.spec.venue === 'bitget'));
  assert.equal(manager.status()['bitget-depth'].subscriptionAcked, false);
  socket.emit({ event: 'subscribe' });
  socket.emit(JSON.stringify(ack('ETHUSDT')));
  socket.emit(JSON.stringify(ack('BTCUSDT', 'books', 'spot')));
  socket.emit(JSON.stringify(ack('BTCUSDT', 'ticker')));
  assert.equal(manager.status()['bitget-depth'].subscriptionAcked, false);
  socket.emit(Buffer.from(JSON.stringify(ack())));
  assert.equal(manager.status()['bitget-depth'].subscriptionAcked, true);
  socket.emit('pong');
  socket.emit(Buffer.from('pong'));
  assert.equal(manager.status()['bitget-depth'].subscriptionAckSource, 'heartbeat');
  assert.equal(manager.status()['bitget-depth'].lastError, null);
  manager.stop();
});

test('Bitget manager matrix preserves documented base units, accepts the documented first-update range, resets on pseq zero, and fences retired frames', async () => {
  const fake = transport(); const timers:{fn:()=>unknown;delay:number}[] = []; const messages:LiveFeedEvent[] = [];
  const manager = new LiveFeedManager({
    networkEnabled: true,
    transportFactory: fake.factory,
    oiPollMs: 0,
    reconnectBaseMs: 10,
    schedule: (fn, delay) => { timers.push({ fn, delay }); return timers.length; },
    cancel: () => {},
    onMessage: message => messages.push(message),
    restTransport: { request: async (request:ExchangeRestRequest) => request.url.includes('bitget.com')
      ? { code: '00000', requestTime: 1_700_000_000_000, data: [{ category: 'USDT-FUTURES', symbol: 'BTCUSDT', baseCoin: 'BTC', quoteCoin: 'USDT', status: 'online', priceMultiplier: '0.1', quantityMultiplier: '0.0001' }] }
      : { universe: [{ name: 'BTC', szDecimals: 3 }], assetCtxs: [{ markPx: '100' }] } },
  });
  await manager.start({ selectedOrderbookVenues: ['bitget'], bitgetEnabled: true, bitgetSymbol: 'BTCUSDT' });
  const first = defined(fake.sockets.find(item => item.spec.venue === 'bitget'));
  first.emit(ack());
  const wrongProduct = snapshot(99); wrongProduct.arg = { ...wrongProduct.arg, instType: 'spot' };
  first.emit(wrongProduct);
  assert.equal(messages.filter(item => item.message?.kind === 'depthSnapshot').length, 0);
  first.emit(snapshot(100));
  const firstBook = defined(messages.find(item => item.message?.kind === 'depthSnapshot')?.message);
  assert.equal(defined(firstBook.market).quantityUnit, 'base');
  const metadata = defined(messages.find(item => item.venue === 'bitget' && item.message?.kind === 'metadata')?.message);
  assert.equal(defined(metadata.assets).find(asset => asset.instrumentId === 'bitget:BTCUSDT')?.contractValue, null);
  assert.equal(manager.status()['bitget-metadata'].state, 'snapshot');
  assert.equal(defined(getVenue('bitget')).capabilities.l2.state, 'supported');
  first.emit(update(110, 90));
  assert.equal(manager.status()['bitget-depth'].state, 'live');
  first.emit(update(112, 111));
  assert.equal(manager.status()['bitget-depth'].state, 'backoff');
  assert.equal(first.closed, true);
  assert.equal(defined(messages.at(-1)).message.invalidated, true);
  assert.equal(timers.length, 1);
  await timers[0].fn();
  const second = defined(fake.sockets.filter(item => item.spec.venue === 'bitget').at(-1));
  second.emit(ack());
  second.emit(snapshot(200));
  second.emit(update(220, 0));
  assert.equal(manager.status()['bitget-depth'].state, 'backoff');
  assert.equal(second.closed, true);
  assert.equal(timers.length, 2);
  await timers[1].fn();
  const third = defined(fake.sockets.filter(item => item.spec.venue === 'bitget').at(-1));
  third.emit(ack());
  third.emit(snapshot(300));
  second.emit(snapshot(999));
  third.emit(update(301, 300));
  assert.equal(messages.filter(item => item.message?.kind === 'depthDelta').length, 2);
  assert.equal(messages.filter(item => item.message?.kind === 'depthSnapshot' && item.message.complete === true).length, 3);
  manager.stop();
});
