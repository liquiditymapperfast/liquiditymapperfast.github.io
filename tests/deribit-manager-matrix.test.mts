import { defined, fields, list, numeric, textValue } from './server-test-helpers.mts';
import type { LiveFeedTransportOptions, LiveFeedSocket, LiveFeedEvent, LiveFeedStatusEvent } from '../src/server/live-feeds.mts';
import type { ExchangeRestRequest } from '../src/server/rest-transport.mts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { LiveFeedManager } from '../src/server/live-feeds.mts';
import { getVenue } from '../src/domain/venue-registry.mts';

const TOPIC = 'book.BTC-PERPETUAL.10.20.100ms';

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

function metadataTransport() {
  return { request: async (request:ExchangeRestRequest) => request.url.includes('get_instrument')
    ? { result: { instrument_name: 'BTC-PERPETUAL', base_currency: 'BTC', counter_currency: 'USD', future_type: 'reversed', tick_size: 0.5, min_trade_amount: 10, settlement_currency: 'BTC', is_active: true } }
    : { universe: [{ name: 'BTC', szDecimals: 3 }], assetCtxs: [{ markPx: '100' }] } };
}

function ack({ id = 1, result = [TOPIC], jsonrpc = '2.0' } = {}) {
  return { jsonrpc, id, result };
}

function snapshot(changeId = 42, { channel = TOPIC, instrument = 'BTC-PERPETUAL' } = {}) {
  return {
    jsonrpc: '2.0',
    method: 'subscription',
    params: {
      channel,
      data: {
        instrument_name: instrument,
        timestamp: 1_700_000_000_000 + changeId,
        change_id: changeId,
        bids: [[77_000, 125_000]],
        asks: [[77_001, 80_000]],
      },
    },
  };
}

const deribitPolicies = { deribit: { subscribeIntervalMs: 0, heartbeatIntervalMs: 60_000, heartbeatTimeoutMs: 60_000 } };

test('Deribit manager requires an exact JSON-RPC subscription result and answers server test_request heartbeats', async () => {
  const fake = transport();
  const manager = new LiveFeedManager({ networkEnabled: true, transportFactory: fake.factory, oiPollMs: 0, transportPolicies: deribitPolicies });
  await manager.start({ deribitEnabled: true, deribitSymbol: 'BTC-PERPETUAL' });
  const socket = fake.sockets.find(item => item.spec.venue === 'deribit');
  assert.ok(socket);
  assert.deepEqual(JSON.parse(socket.sent[0]), { jsonrpc: '2.0', id: 1, method: 'public/subscribe', params: { channels: [TOPIC] } });
  assert.equal(manager.status()['deribit-depth'].subscriptionAcked, false);
  socket.emit(JSON.stringify(ack({ id: 99 })));
  socket.emit(JSON.stringify(ack({ result: ['book.ETH-PERPETUAL.10.20.100ms'] })));
  socket.emit(JSON.stringify(ack({ result: [TOPIC, 'book.ETH-PERPETUAL.10.20.100ms'] })));
  socket.emit(JSON.stringify({ jsonrpc: '2.0', id: 0, result: {} }));
  assert.equal(manager.status()['deribit-depth'].subscriptionAcked, false);
  socket.emit(Buffer.from(JSON.stringify(ack())));
  assert.equal(manager.status()['deribit-depth'].subscriptionAcked, true);
  socket.emit(Buffer.from(JSON.stringify({ jsonrpc: '2.0', id: 0, result: { version: '1.2.26' } })));
  socket.emit(JSON.stringify({ jsonrpc: '2.0', method: 'heartbeat' }));
  socket.emit(JSON.stringify({ jsonrpc: '2.0', method: 'test_request' }));
  await new Promise(resolve => setImmediate(resolve));
  const heartbeatFrames = socket.sent.map(value => JSON.parse(value)).filter(frame => frame.method === 'public/test');
  assert.ok(heartbeatFrames.length >= 1);
  assert.equal(manager.status()['deribit-depth'].subscriptionAckSource, 'heartbeat');
  assert.equal(manager.status()['deribit-depth'].lastError, null);
  manager.stop();
});

test('Deribit manager preserves grouped quote units, ignores foreign frames, and fences retired snapshots', async () => {
  const fake = transport(); const timers:{fn:()=>unknown;delay:number}[] = []; const messages:LiveFeedEvent[] = [];
  const manager = new LiveFeedManager({
    networkEnabled: true,
    transportFactory: fake.factory,
    restTransport: metadataTransport(),
    transportPolicies: deribitPolicies,
    oiPollMs: 0,
    reconnectBaseMs: 10,
    schedule: (fn, delay) => { timers.push({ fn, delay }); return timers.length; },
    cancel: () => {},
    onMessage: message => messages.push(message),
  });
  await manager.start({ selectedOrderbookVenues: ['deribit'], deribitEnabled: true, deribitSymbol: 'BTC-PERPETUAL' });
  const first = defined(fake.sockets.find(item => item.spec.venue === 'deribit'));
  first.emit(Buffer.from(JSON.stringify(ack())));
  first.emit(snapshot(1, { channel: 'book.BTC-PERPETUAL.10.20.100ms' }));
  first.emit(snapshot(2, { channel: 'book.BTC-PERPETUAL.10.20.100ms', instrument: 'ETH-PERPETUAL' }));
  first.emit(snapshot(3, { channel: 'book.ETH-PERPETUAL.10.20.100ms' }));
  const missingInstrument = snapshot(4);
  Reflect.deleteProperty(missingInstrument.params.data, 'instrument_name');
  first.emit(missingInstrument);
  first.emit(snapshot(2));
  const books = () => messages.filter(item => item.venue === 'deribit' && item.message?.kind === 'depthSnapshot');
  assert.equal(books().length, 2);
  assert.equal(books()[0].message.units, 'quote');
  assert.equal(books()[0].message.resolution, 'coarse');
  assert.equal(books()[0].message.resolutionKey, 'group:10');
  assert.equal(books()[0].message.sourceGrouping, 10);
  assert.equal(books()[0].message.sourceDepth, 20);
  assert.equal(defined(books()[0].message.bids)[0].amount, 125_000);
  assert.equal(defined(messages.find(item => item.venue === 'deribit' && item.message?.kind === 'metadata')?.message.assets)[0].quantityUnit, 'quote');
  assert.equal(defined(getVenue('deribit')).capabilities.l2.state, 'supported');
  first.closeWith('lost');
  assert.equal(first.closed, true);
  assert.equal(manager.status()['deribit-depth'].state, 'backoff');
  assert.equal(defined(books().at(-1)).message.complete, false);
  assert.equal(timers.length, 1);
  await timers[0].fn();
  const second = defined(fake.sockets.filter(item => item.spec.venue === 'deribit').at(-1));
  assert.notStrictEqual(second, first);
  assert.equal(manager.status()['deribit-depth'].state, 'snapshot');
  second.emit(ack());
  second.emit(snapshot(20));
  first.emit(snapshot(999));
  assert.equal(manager.status()['deribit-depth'].state, 'live');
  assert.equal(books().length, 4);
  assert.equal(books().filter(item => item.message.complete === true).length, 3);
  manager.stop();
});

test('Deribit non-success JSON-RPC subscription acknowledgement fails closed and schedules one recovery', async () => {
  const fake = transport(); const timers:{fn:()=>unknown;delay:number}[] = [];
  const manager = new LiveFeedManager({
    networkEnabled: true,
    transportFactory: fake.factory,
    transportPolicies: deribitPolicies,
    oiPollMs: 0,
    schedule: (fn, delay) => { timers.push({ fn, delay }); return timers.length; },
    cancel: () => {},
  });
  await manager.start({ deribitEnabled: true, deribitSymbol: 'BTC-PERPETUAL' });
  const socket = defined(fake.sockets.find(item => item.spec.venue === 'deribit'));
  socket.emit(Buffer.from(JSON.stringify({ jsonrpc: '2.0', id: 1, error: { code: 100, message: 'denied' } })));
  assert.equal(manager.status()['deribit-depth'].state, 'backoff');
  assert.equal(socket.closed, true);
  assert.equal(timers.length, 1);
  manager.stop();
});
