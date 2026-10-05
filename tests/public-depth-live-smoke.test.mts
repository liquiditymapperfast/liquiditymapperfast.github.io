import { smokeRecord, smokeArray, smokeRequired, smokeFrameText } from '../scripts/smoke-boundaries.mts';
import type { LiveFeedSocket } from '../src/server/live-feeds.mts';
import type { PublicSmokeTransportOptions } from '../scripts/public-depth-live-smoke.mts';
interface PublicFakeSocket extends LiveFeedSocket { sent: unknown[]; closed?: boolean; errorListener?: ((error: unknown) => void) | null }
import test from 'node:test';
import assert from 'node:assert/strict';
import { runPublicDepthLiveSmoke } from '../scripts/public-depth-live-smoke.mts';

function fakeTransportFactory() {
  const connections: PublicFakeSocket[] = [];
  return {
    connections,
    factory: async ({ venue, request, index }: PublicSmokeTransportOptions) => {
      const listeners = new Map<string, ((payload: unknown) => void)[]>();
      let closed = false;
      const socket: PublicFakeSocket = {
        sent: [],
        on(event: string, listener: (payload: unknown) => void) {
          const list = listeners.get(event) ?? [];
          list.push(listener);
          listeners.set(event, list);
        },
        async open() {},
        send(value: unknown) {
          socket.sent.push(value);
          if (!String(value).includes('subscribe')) return;
          const emit = (frame: unknown) => {
            for (const listener of listeners.get('message') ?? []) listener(frame);
          };
          if (venue === 'okx') {
            emit(JSON.stringify({ event: 'subscribe', arg: { channel: 'books', instId: 'BTC-USDT-SWAP' } }));
            emit(JSON.stringify({ arg: { channel: 'books', instId: 'BTC-USDT-SWAP' }, action: 'snapshot', data: [{ asks: [['101', '2', '0', '1']], bids: [['100', '3', '0', '1']], ts: '1700000000000', seqId: '100' }] }));
            if (index === 0) emit(JSON.stringify({ arg: { channel: 'books', instId: 'BTC-USDT-SWAP' }, action: 'update', data: [{ asks: [['101', '1', '0', '1']], bids: [], ts: '1700000000100', seqId: '101', prevSeqId: '100' }] }));
          } else {
            if (venue === 'gateio') {
              emit(JSON.stringify({ event: 'subscribe', channel: 'futures.order_book', result: { status: 'success' } }));
              emit(JSON.stringify({ event: 'all', channel: 'futures.order_book', result: { contract: 'BTC_USDT', id: String(100 + index), asks: [{ p: '101', s: '2' }], bids: [{ p: '100', s: '3' }] } }));
              return;
            }
            if (venue === 'deribit') {
              emit(JSON.stringify({ jsonrpc: '2.0', id: 1, result: ['book.BTC-PERPETUAL.10.20.100ms'] }));
              emit(JSON.stringify({ jsonrpc: '2.0', method: 'subscription', params: { channel: 'book.BTC-PERPETUAL.10.20.100ms', data: { timestamp: 1700000000000, change_id: 99, bids: [[100, 3]], asks: [[101, 2]] } } }));
              emit(JSON.stringify({ jsonrpc: '2.0', method: 'subscription', params: { channel: 'book.BTC-PERPETUAL.10.20.100ms', data: { instrument_name: 'BTC-PERPETUAL', timestamp: 1700000000000, change_id: 100 + index, bids: [[100, 3]], asks: [[101, 2]] } } }));
              return;
            }
            emit(JSON.stringify({ event: 'subscribe', arg: { instType: 'usdt-futures', topic: 'books', symbol: 'BTCUSDT' } }));
            emit(JSON.stringify({ arg: { instType: 'usdt-futures', topic: 'books', symbol: 'BTCUSDT' }, action: 'snapshot', data: [{ asks: [['101', '2']], bids: [['100', '3']], ts: '1700000000000', seq: '100' }] }));
            if (index === 0) emit(JSON.stringify({ arg: { instType: 'usdt-futures', topic: 'books', symbol: 'BTCUSDT' }, action: 'update', data: [{ asks: [['101', '1']], bids: [], ts: '1700000000100', seq: '101', pseq: '100' }] }));
          }
        },
        close() {
          if (closed) return;
          closed = true;
          for (const listener of listeners.get('close') ?? []) listener('intentional-test-close');
        },
      };
      connections.push(socket);
      return socket;
    },
  };
}

test('public depth live smoke records both providers without raw payloads', async () => {
  const fake = fakeTransportFactory();
  const artifact = await runPublicDepthLiveSmoke({ transportFactory: fake.factory, timeoutMs: 100, reconnectTimeoutMs: 100, now: () => '2026-09-13T00:00:00.000Z' });
  assert.equal(artifact.status, 'read-only-live-observation');
  assert.deepEqual(artifact.providers.map(provider => provider.status), ['read-only-live-observation', 'read-only-live-observation', 'read-only-live-observation', 'read-only-live-observation']);
  for (const provider of artifact.providers) {
    assert.equal(smokeRecord(provider.observed).subscribeAck, true);
    assert.equal(smokeRecord(smokeRecord(provider.observed).initial).routedSnapshots, 1);
    assert.equal(smokeRecord(smokeRecord(provider.observed).initial).routedDeltas, ['gateio', 'deribit'].includes(provider.venue) ? 0 : 1);
    assert.equal(smokeRecord(smokeRecord(provider.observed).initial).closeObserved, true);
    assert.equal(smokeRecord(provider.observed).reconnectSnapshot, true);
    assert.equal(smokeRecord(smokeRecord(provider.observed).reconnect).closeObserved, true);
    assert.equal(smokeRecord(smokeRecord(provider.observed).initial).coverage, 'partial');
    assert.ok(Number(smokeRecord(smokeRecord(provider.observed).initial).bidLevels) >= 1);
    assert.ok(Number(smokeRecord(smokeRecord(provider.observed).initial).askLevels) >= 1);
  }
  const text = JSON.stringify(artifact);
  assert.doesNotMatch(text, /"payload"\s*:/, 'raw payloads must not be written to smoke evidence');
  assert.doesNotMatch(text, /"amount"\s*:/, 'raw level amounts must not be written to smoke evidence');
  assert.doesNotMatch(text, /"bids"\s*:/, 'raw bid arrays must not be written to smoke evidence');
  assert.doesNotMatch(text, /"asks"\s*:/, 'raw ask arrays must not be written to smoke evidence');
});

test('public depth live smoke records Deribit grouped full snapshots without requiring deltas', async () => {
  const fake = fakeTransportFactory();
  const artifact = await runPublicDepthLiveSmoke({ providers: ['deribit'], transportFactory: fake.factory, timeoutMs: 100, reconnectTimeoutMs: 100, now: () => '2026-09-13T00:00:00.000Z' });
  assert.equal(artifact.status, 'read-only-live-observation');
  const provider = artifact.providers[0];
  assert.equal(provider.venue, 'deribit');
  assert.equal(smokeRecord(provider.observed).subscribeAck, true);
  assert.equal(smokeRecord(smokeRecord(provider.observed).initial).routedSnapshots, 1);
  assert.equal(smokeRecord(smokeRecord(provider.observed).initial).routedDeltas, 0);
  assert.equal(smokeRecord(provider.observed).reconnectSnapshot, true);
  assert.equal(smokeRecord(smokeRecord(provider.observed).initial).bidLevels, 1);
  assert.equal(smokeRecord(smokeRecord(provider.observed).initial).askLevels, 1);
});

test('public depth live smoke records Gate full snapshots without requiring deltas', async () => {
  const fake = fakeTransportFactory();
  const artifact = await runPublicDepthLiveSmoke({ providers: ['gateio'], transportFactory: fake.factory, timeoutMs: 100, reconnectTimeoutMs: 100, now: () => '2026-09-13T00:00:00.000Z' });
  assert.equal(artifact.status, 'read-only-live-observation');
  const provider = artifact.providers[0];
  assert.equal(provider.venue, 'gateio');
  assert.equal(smokeRecord(provider.observed).subscribeAck, true);
  assert.equal(smokeRecord(smokeRecord(provider.observed).initial).routedSnapshots, 1);
  assert.equal(smokeRecord(smokeRecord(provider.observed).initial).routedDeltas, 0);
  assert.equal(smokeRecord(provider.observed).reconnectSnapshot, true);
  assert.equal(smokeRecord(smokeRecord(provider.observed).initial).closeObserved, true);
  assert.equal(smokeRecord(smokeRecord(provider.observed).reconnect).closeObserved, true);
  assert.equal(smokeRecord(smokeRecord(provider.observed).initial).bidLevels, 1);
  assert.equal(smokeRecord(smokeRecord(provider.observed).initial).askLevels, 1);
});

test('public depth live smoke keeps provider failures bounded and continues to the next venue', async () => {
  const artifact = await runPublicDepthLiveSmoke({
    providers: ['unknown', 'okx'],
    timeoutMs: 20,
    reconnectTimeoutMs: 20,
    transportFactory: async () => { throw new Error('synthetic connection refusal'); },
    now: () => '2026-09-13T00:00:00.000Z',
  });
  assert.equal(artifact.status, 'failed-bounded-observation');
  assert.equal(artifact.providers.length, 2);
  assert.equal(artifact.providers[0].status, 'failed-bounded-observation');
  assert.equal(artifact.providers[1].status, 'failed-bounded-observation');
  assert.match(smokeRequired(artifact.providers[1].error), /synthetic connection refusal/);
});

test('public depth live smoke does not treat a missing close event as observed', async () => {
  const fake = fakeTransportFactory();
  const artifact = await runPublicDepthLiveSmoke({
    providers: ['okx'],
    timeoutMs: 20,
    reconnectTimeoutMs: 20,
    transportFactory: async ({ venue, request, index }) => {
      const socket = await fake.factory({ venue, request, index });
      socket.close = () => {};
      return socket;
    },
    now: () => '2026-09-13T00:00:00.000Z',
  });
  assert.equal(artifact.status, 'failed-bounded-observation');
  assert.equal(artifact.providers[0].status, 'failed-bounded-observation');
  assert.equal(smokeRecord(smokeRecord(artifact.providers[0].observed).initial).closeObserved, false);
  assert.equal(smokeRecord(smokeRecord(artifact.providers[0].observed).initial).closeTimedOut, true);
  assert.match(smokeRequired(artifact.providers[0].error), /close was not observed/);
});

test('public depth live smoke bounds a hanging socket open and closes it', async () => {
  const hanging: { socket: PublicFakeSocket | null } = { socket: null };
  const started = Date.now();
  const artifact = await runPublicDepthLiveSmoke({
    providers: ['okx'],
    timeoutMs: 20,
    reconnectTimeoutMs: 20,
    transportFactory: async () => {
      const listeners = new Map<string, ((payload: unknown) => void)[]>();
      hanging.socket = {
        sent: [],
        on(event: string, listener: (payload: unknown) => void) { listeners.set(event, [...(listeners.get(event) ?? []), listener]); },
        open() { return new Promise<void>(() => {}); },
        close() { this.closed = true; },
      };
      return hanging.socket;
    },
    now: () => '2026-09-13T00:00:00.000Z',
  });
  assert.equal(artifact.status, 'failed-bounded-observation');
  assert.equal(artifact.providers[0].status, 'failed-bounded-observation');
  assert.ok(Date.now() - started < 500, `hanging open exceeded bounded test window: ${Date.now() - started}ms`);
  assert.equal(smokeRequired(hanging.socket).closed, true);
  assert.match(smokeRequired(artifact.providers[0].error), /timed out opening transport/);
});

test('public depth live smoke handles an opening socket error and continues', async () => {
  const healthy = fakeTransportFactory();
  const artifact = await runPublicDepthLiveSmoke({
    providers: ['okx', 'bitget'],
    timeoutMs: 50,
    reconnectTimeoutMs: 50,
    transportFactory: async ({ venue, request, index }) => {
      if (venue !== 'okx') return healthy.factory({ venue, request, index });
      const socket: PublicFakeSocket = {
        sent: [],
        errorListener: null,
        on(event: string, listener: (payload: unknown) => void) { if (event === 'error') this.errorListener = listener; },
        async open() {
          this.errorListener?.(new Error('synthetic open error'));
          throw new Error('synthetic open rejection');
        },
        send() {},
        close() { this.closed = true; },
      };
      return socket;
    },
    now: () => '2026-09-13T00:00:00.000Z',
  });
  assert.equal(artifact.status, 'failed-bounded-observation');
  assert.equal(artifact.providers.length, 2);
  assert.equal(artifact.providers[0].status, 'failed-bounded-observation');
  assert.match(smokeRequired(artifact.providers[0].error), /synthetic open/);
  assert.equal(artifact.providers[1].status, 'read-only-live-observation');
});
