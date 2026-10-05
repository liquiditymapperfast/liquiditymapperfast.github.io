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

function snapshot(sequence = 10) {
  return { arg: { channel: 'books', instId: 'BTC-USDT-SWAP' }, action: 'snapshot', data: [{ asks: [['101', '3', '0', '1']], bids: [['100', '2', '0', '1']], ts: '1700000000000', seqId: String(sequence), prevSeqId: '-1' }] };
}

function update(sequence = 11, previousSequence = 10) {
  return { arg: { channel: 'books', instId: 'BTC-USDT-SWAP' }, action: 'update', data: [{ asks: [['101', '0', '0', '0']], bids: [['99', '4', '0', '1']], ts: '1700000000100', seqId: String(sequence), prevSeqId: String(previousSequence) }] };
}

test('OKX manager requires a matching subscription acknowledgement and handles pong before book decode', async () => {
  const fake = transport();
  const manager = new LiveFeedManager({ networkEnabled: true, transportFactory: fake.factory, oiPollMs: 0 });
  await manager.start({ okxEnabled: true, okxSymbol: 'BTC-USDT-SWAP' });
  const socket = defined(fake.sockets.find(item => item.spec.venue === 'okx'));
  assert.equal(manager.status()['okx-depth'].subscriptionAcked, false);
  socket.emit({ event: 'subscribe' });
  assert.equal(manager.status()['okx-depth'].subscriptionAcked, false);
  socket.emit(JSON.stringify({ event: 'subscribe', arg: { channel: 'books', instId: 'ETH-USDT-SWAP' } }));
  assert.equal(manager.status()['okx-depth'].subscriptionAcked, false);
  socket.emit(Buffer.from(JSON.stringify({ event: 'subscribe', arg: { channel: 'books', instId: 'BTC-USDT-SWAP' } })));
  assert.equal(manager.status()['okx-depth'].subscriptionAcked, true);
  socket.emit('pong');
  socket.emit(Buffer.from('pong'));
  assert.equal(manager.status()['okx-depth'].subscriptionAckSource, 'heartbeat');
  assert.equal(manager.status()['okx-depth'].lastError, null);
  manager.stop();
});

test('OKX manager matrix preserves contract units, rejects gaps, and ignores retired frames', async () => {
  const fake = transport(); const timers:{fn:()=>unknown;delay:number}[] = []; const messages:LiveFeedEvent[] = [];
  const manager = new LiveFeedManager({
    networkEnabled: true,
    transportFactory: fake.factory,
    oiPollMs: 0,
    reconnectBaseMs: 10,
    schedule: (fn, delay) => { timers.push({ fn, delay }); return timers.length; },
    cancel: () => {},
    onMessage: message => messages.push(message),
    restTransport: { request: async (request:ExchangeRestRequest) => request.url.includes('okx.com')
      ? { code: '0', data: [{ instType: 'SWAP', instId: 'BTC-USDT-SWAP', state: 'live', baseCcy: 'BTC', quoteCcy: 'USDT', tickSz: '0.1', lotSz: '0.01', ctVal: '0.01', ctValCcy: 'BTC', ctType: 'linear', settleCcy: 'USDT' }] }
      : { universe: [{ name: 'BTC', szDecimals: 3 }], assetCtxs: [{ markPx: '100' }] } },
  });
  await manager.start({ selectedOrderbookVenues: ['okx'], okxEnabled: true, okxSymbol: 'BTC-USDT-SWAP' });
  const first = defined(fake.sockets.find(item => item.spec.venue === 'okx'));
  first.emit({ event: 'subscribe', arg: { channel: 'books', instId: 'BTC-USDT-SWAP' } });
  first.emit(snapshot(10));
  const firstBook = defined(messages.find(item => item.message?.kind === 'depthSnapshot')?.message);
  assert.equal(defined(firstBook.market).quantityUnit, 'contract');
  const metadata = defined(messages.find(item => item.venue === 'okx' && item.message?.kind === 'metadata')?.message);
  assert.equal(defined(metadata.assets).find(asset => asset.instrumentId === 'okx:BTC-USDT-SWAP')?.contractValue, 0.01);
  assert.equal(manager.status()['okx-metadata'].state, 'snapshot');
  assert.equal(defined(getVenue('okx')).capabilities.l2.state, 'supported');
  first.emit(update(12, 11));
  assert.equal(manager.status()['okx-depth'].state, 'backoff');
  assert.equal(first.closed, true);
  assert.equal(defined(messages.at(-1)).message.invalidated, true);
  assert.equal(defined(messages.at(-1)).message.sourceTimestamp, null);
  assert.equal(timers.length, 1);
  await timers[0].fn();
  const second = defined(fake.sockets.filter(item => item.spec.venue === 'okx').at(-1));
  second.emit({ event: 'subscribe', arg: { channel: 'books', instId: 'BTC-USDT-SWAP' } });
  second.emit(snapshot(20));
  first.emit(snapshot(99));
  second.emit(update(21, 20));
  assert.equal(messages.filter(item => item.message?.kind === 'depthDelta').length, 1);
  assert.equal(messages.filter(item => item.message?.kind === 'depthSnapshot' && item.message.complete === true).length, 2);
  manager.stop();
});
