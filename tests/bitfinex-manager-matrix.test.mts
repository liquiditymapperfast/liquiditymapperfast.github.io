import { defined, fields, list, numeric, textValue } from './server-test-helpers.mts';
import type { LiveFeedTransportOptions, LiveFeedSocket, LiveFeedEvent, LiveFeedStatusEvent } from '../src/server/live-feeds.mts';
import type { ExchangeRestRequest } from '../src/server/rest-transport.mts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { LiveFeedManager } from '../src/server/live-feeds.mts';
import {
  VENUE_TRANSPORT_POLICIES,
  applyBitfinexDepthSessionMessage,
  bitfinexBookChecksum,
  buildBitfinexRequest,
  buildBitfinexSubscription,
  createBitfinexDepthSession,
  normalizeBitfinexDepth,
  normalizeBitfinexSymbolsDetails,
} from '../src/adapters/index.mts';

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

function policies() {
  return Object.fromEntries(Object.entries(VENUE_TRANSPORT_POLICIES).map(([venue, policy]) => [venue, { ...policy, subscribeIntervalMs: 0, heartbeatIntervalMs: 60_000, heartbeatTimeoutMs: 60_000 }]));
}

function restTransport() {
  const requests:ExchangeRestRequest[] = [];
  return {
    requests,
    request: async (request:ExchangeRestRequest) => {
      requests.push(request);
      if (request.url.includes('/symbols_details')) return [{ pair: 'btcusd', price_precision: 5, minimum_order_size: '0.0001', margin: true }];
      if (request.url.includes('/exchangeInfo')) return { symbols: [] };
      if ((typeof request.body === 'string' && request.body.includes('metaAndAssetCtxs'))) return [{ universe: [] }, []];
      return {};
    },
  };
}

const initial = [
  [100, 2, 3], [99, 1, 1], [101, 3, -2], [102, 1, -1],
];

function frame(rows = initial, channelId = 42) { return [channelId, rows]; }
function checksumFrame(rows = initial, channelId = 42) {
  const bids = rows.filter(row => row[2] > 0); const asks = rows.filter(row => row[2] < 0);
  return [channelId, 'cs', bitfinexBookChecksum({ bids, asks })];
}
function ack() { return { event: 'subscribed', channel: 'book', chanId: 42, symbol: 'tBTCUSD', prec: 'P0', freq: 'F0', len: '25', subId: 'bitfinex-BTCUSD', pair: 'BTCUSD' }; }

test('Bitfinex descriptors, metadata, and checksum configuration match the public v2 contract', () => {
  assert.equal(buildBitfinexRequest('symbolsDetails').url, 'https://api.bitfinex.com/v1/symbols_details');
  assert.equal(buildBitfinexRequest('book', { symbol: 'BTCUSD', precision: 'P0', len: 25 }).url, 'https://api-pub.bitfinex.com/v2/book/tBTCUSD/P0?len=25');
  const subscription = buildBitfinexSubscription('depth', { symbol: 'BTCUSD', precision: 'P0', frequency: 'F0', len: 25 });
  assert.deepEqual(subscription, { url: 'wss://api-pub.bitfinex.com/ws/2', method: 'subscribe', channel: 'book', symbol: 'tBTCUSD', precision: 'P0', frequency: 'F0', len: '25', subId: 'bitfinex-BTCUSD', topic: 'book:tBTCUSD', args: ['tBTCUSD'], snapshot: true, conf: { event: 'conf', flags: 131072 } });
  const metadata = normalizeBitfinexSymbolsDetails([{ pair: 'btcusd', price_precision: 5, minimum_order_size: '0.0001', margin: true }], { receivedAt: 1_700_000_000_000 });
  assert.equal(metadata.sourceTimestamp, null);
  assert.equal(metadata.receivedAt, 1_700_000_000_000);
  assert.equal(metadata.assets[0].instrumentId, 'bitfinex:BTCUSD');
  assert.equal(metadata.assets[0].nativeSymbol, 'tBTCUSD');
  assert.equal(metadata.assets[0].quantityUnit, 'base');
  assert.equal(Number.isInteger(bitfinexBookChecksum({ bids: initial.slice(0, 2), asks: initial.slice(2) })), true);
});

test('Bitfinex session applies signed updates, verifies checksums, and fences malformed books', () => {
  const snapshot = normalizeBitfinexDepth(frame(), { symbol: 'BTCUSD', receivedAt: 1_700_000_000_000 });
  assert.equal(snapshot.sourceTimestamp, null);
  assert.equal(snapshot.receivedAt, 1_700_000_000_000);
  const session = createBitfinexDepthSession({ topic: 'book:tBTCUSD', instrumentId: 'bitfinex:BTCUSD', sessionToken: 'bitfinex-depth:1' });
  const acceptedSnapshot = applyBitfinexDepthSessionMessage(session, { topic: 'book:tBTCUSD', sessionToken: 'bitfinex-depth:1', channelId: 42, update: snapshot });
  assert.equal(acceptedSnapshot.accepted, true);
  const verified = applyBitfinexDepthSessionMessage(acceptedSnapshot.session, { topic: 'book:tBTCUSD', sessionToken: 'bitfinex-depth:1', channelId: 42, update: normalizeBitfinexDepth(checksumFrame(), { symbol: 'BTCUSD' }) });
  assert.equal(verified.accepted, true);
  assert.equal(defined(verified.session.book).checksumVerified, true);
  const updated = [[100, 2, 4], [102, 0, -1]];
  const delta = normalizeBitfinexDepth([42, updated[0]], { symbol: 'BTCUSD' });
  assert.equal(delta.sourceTimestamp, null);
  const acceptedDelta = applyBitfinexDepthSessionMessage(verified.session, { topic: 'book:tBTCUSD', sessionToken: 'bitfinex-depth:1', channelId: 42, update: delta });
  assert.equal(acceptedDelta.accepted, true);
  assert.equal(defined(acceptedDelta.session.book).bids[0].amount, 4);
  const afterUpdate = [[100, 2, 4], [99, 1, 1], [101, 3, -2], [102, 1, -1]];
  const verifiedUpdate = applyBitfinexDepthSessionMessage(acceptedDelta.session, { topic: 'book:tBTCUSD', sessionToken: 'bitfinex-depth:1', channelId: 42, update: normalizeBitfinexDepth(checksumFrame(afterUpdate), { symbol: 'BTCUSD' }) });
  assert.equal(verifiedUpdate.accepted, true);
  const deletion = normalizeBitfinexDepth([42, [102, 0, -1]], { symbol: 'BTCUSD' });
  const deleted = applyBitfinexDepthSessionMessage(verifiedUpdate.session, { topic: 'book:tBTCUSD', sessionToken: 'bitfinex-depth:1', channelId: 42, update: deletion });
  assert.equal(deleted.accepted, true);
  assert.equal(defined(deleted.session.book).asks.some(row => row.price === 102), false);
  const bad = normalizeBitfinexDepth([42, 'cs', 1], { symbol: 'BTCUSD' });
  const rejected = applyBitfinexDepthSessionMessage(deleted.session, { topic: 'book:tBTCUSD', sessionToken: 'bitfinex-depth:1', channelId: 42, update: bad });
  assert.equal(rejected.accepted, false);
  assert.equal(rejected.reason, 'resync-required');
  assert.equal(rejected.session.invalidated, true);
});

test('Bitfinex manager requires exact ACK, sends checksum config, routes heartbeats, and fences reconnects', async () => {
  const fake = transport(); const rest = restTransport(); const messages:LiveFeedEvent[] = []; const timers:{fn:()=>unknown;delay:number}[] = [];
  const manager = new LiveFeedManager({ networkEnabled: true, transportFactory: fake.factory, restTransport: rest, transportPolicies: policies(), oiPollMs: 0, reconnectBaseMs: 10, schedule: (fn, delay) => { const timer = { fn, delay }; timers.push(timer); return timer; }, cancel: () => {}, onMessage: message => messages.push(message) });
  await manager.start({ selectedOrderbookVenues: ['bitfinex'], bitfinexEnabled: true, bitfinexSymbol: 'BTCUSD' });
  const socket = defined(fake.sockets.find(item => item.spec.id === 'bitfinex-depth'));
  assert.equal(socket.spec.request.url, 'wss://api-pub.bitfinex.com/ws/2');
  assert.deepEqual(socket.sent.slice(-2).map(value => JSON.parse(value)), [{ event: 'conf', flags: 131072 }, { event: 'subscribe', channel: 'book', symbol: 'tBTCUSD', prec: 'P0', freq: 'F0', len: '25', subId: 'bitfinex-BTCUSD' }]);
  socket.emit({ event: 'info', version: 2 });
  socket.emit({ event: 'subscribed', channel: 'book', chanId: 42, symbol: 'tETHUSD', prec: 'P0', freq: 'F0', len: '25', subId: 'bitfinex-BTCUSD' });
  socket.emit(frame());
  assert.equal(manager.status()['bitfinex-depth'].subscriptionAcked, false);
  assert.equal(messages.some(item => item.id === 'bitfinex-depth'), false);
  socket.emit(ack());
  socket.emit(frame());
  socket.emit(checksumFrame());
  const initialMessages = messages.filter(item => item.id === 'bitfinex-depth');
  assert.equal(initialMessages.filter(item => item.message.kind === 'depthSnapshot').length, 1);
  assert.equal(manager.status()['bitfinex-depth'].checksumVerified, true);
  socket.emit([99, [100, 2, 5]]);
  assert.equal(messages.filter(item => item.id === 'bitfinex-depth').length, initialMessages.length);
  socket.emit([42, [100, 2, 4]]);
  socket.emit(checksumFrame([[100, 2, 4], [99, 1, 1], [101, 3, -2], [102, 1, -1]]));
  assert.equal(messages.filter(item => item.message.kind === 'depthDelta').length, 0, 'the whole book is delivered, so it is labelled a snapshot');
  assert.equal(messages.filter(item => item.id === 'bitfinex-depth' && item.message.kind === 'depthSnapshot').length, 2);
  socket.emit([42, 'hb']);
  assert.equal(manager.status()['bitfinex-depth'].heartbeatAckSource, 'server-heartbeat');
  const before = messages.length;
  socket.closeWith('lost');
  assert.equal(manager.status()['bitfinex-depth'].state, 'backoff');
  assert.equal(messages.length, before + 1);
  const afterClose = messages.length;
  socket.emit(frame());
  await defined(timers.find(timer => timer.delay === 10)).fn();
  const replacement = defined(fake.sockets.filter(item => item.spec.id === 'bitfinex-depth').at(-1));
  assert.notStrictEqual(replacement, socket);
  replacement.emit(ack());
  replacement.emit([42, [100, 2, 4]]);
  assert.equal(messages.length, afterClose);
  replacement.emit(frame());
  replacement.emit(checksumFrame());
  assert.equal(messages.length, afterClose + 1);
  manager.stop();
});

test('Bitfinex server-heartbeat mode does not self-observe a silent socket', async () => {
  let clock = 0; const fake = transport(); const rest = restTransport(); const timers:{fn:()=>unknown;delay:number}[] = [];
  const transportPolicies = policies();
  transportPolicies.bitfinex = { ...transportPolicies.bitfinex, heartbeatIntervalMs: 100, heartbeatTimeoutMs: 50 };
  const manager = new LiveFeedManager({ networkEnabled: true, transportFactory: fake.factory, restTransport: rest, transportPolicies, now: () => clock, transportNow: () => clock, oiPollMs: 0, reconnectBaseMs: 1_000, heartbeatSchedule: (fn, delay) => { const timer = { fn, delay }; timers.push(timer); return timer; }, heartbeatCancel: () => {} });
  await manager.start({ bitfinexEnabled: true, bitfinexSymbol: 'BTCUSD' });
  const socket = defined(fake.sockets.find(item => item.spec.id === 'bitfinex-depth'));
  socket.emit(ack());
  clock = 100;
  await defined(timers.find(timer => timer.delay === 100)).fn();
  assert.equal(manager.status()['bitfinex-depth'].serverHeartbeat, true);
  assert.equal(manager.status()['bitfinex-depth'].lastObservedAt, 0);
  socket.emit([99, 'hb']);
  assert.equal(manager.status()['bitfinex-depth'].lastObservedAt, 0);
  clock = 151;
  const silentTimer = defined(timers.at(-1));
  assert.equal(silentTimer.delay, 50);
  await silentTimer.fn();
  assert.equal(manager.status()['bitfinex-depth'].state, 'backoff');
  manager.stop();
});
