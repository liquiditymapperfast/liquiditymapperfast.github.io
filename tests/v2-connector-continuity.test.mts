import test from 'node:test';
import assert from 'node:assert/strict';
import { BinanceUsConnector, BookConnector } from '../src/server/v2/connectors.mts';
import { BybitConnector } from '../src/shared/venues.ts';

const msg = (o: unknown) => JSON.stringify(o);
const ev = (U: number, u: number, b: [string, string][] = [], a: [string, string][] = []) => msg({ e: 'depthUpdate', U, u, b, a });

/** A connector that has its snapshot already (seeded at `id`), as if its socket and snapshot had arrived. */
function synced(id = 100): BinanceUsConnector {
  const c = new BinanceUsConnector(); c.state = 'connecting';
  c.seed(id, [[100, 1], [99, 1]], [[101, 1], [102, 1]]);
  return c;
}

test('Binance spot: a range that overlaps what was applied is applied again, one wholly behind it is ignored, and only a real gap resynchronises', () => {
  const c = synced(100);
  c.onMessage(ev(101, 110, [['100', '2']]));                       // contiguous: applied
  assert.equal(c.state, 'live');
  c.onMessage(ev(108, 115, [['100', '3']], [['101', '5']]));       // starts inside what was applied but reaches 111: applied
  assert.equal(c.failures, 0, 'an overlapping range is not a gap');
  c.onMessage(ev(105, 109, [['100', '9']]));                       // wholly behind 115: obsolete, ignored, and it must not undo the 3
  assert.equal(c.failures, 0, 'a stale range is not a gap either');
  const book = c.valued(Date.now())!;
  assert.deepEqual([...book.bids.usd], [300, 99], 'the stale range changed nothing');
  assert.deepEqual([...book.asks.usd][0], 505, 'the overlapping range did apply');
  c.onMessage(ev(116, 116, [], [['103', '1']]));                   // the next one in order
  assert.equal(c.failures, 0);
  c.onMessage(ev(118, 118));                                       // 117 never arrived: a gap
  assert.equal(c.failures, 1); assert.match(c.lastError ?? '', /sequence gap 116 -> 118/);
  c.stop();
});

test('Binance spot: before the first event after the snapshot, the old rules stand (stale drops, a snapshot behind the stream resynchronises)', () => {
  const behind = synced(100);
  behind.onMessage(ev(90, 99));                                    // covered by the snapshot
  assert.equal(behind.failures, 0);
  behind.onMessage(ev(103, 104));                                  // 101 and 102 are missing: the snapshot is behind the stream
  assert.equal(behind.failures, 1); assert.match(behind.lastError ?? '', /snapshot behind stream \(100 < 103\)/);
  behind.stop();
});

// ---- retired connections and the first-data deadline ----------------------------------------------------------------------------------------------------

class FakeSocket {
  static all: FakeSocket[] = [];
  binaryType = ''; sent: unknown[] = []; closed = false;
  onopen: (() => void) | null = null; onmessage: ((event: { data: unknown }) => void) | null = null; onerror: (() => void) | null = null; onclose: (() => void) | null = null;
  constructor(public url: string) { FakeSocket.all.push(this); }
  send(payload: unknown): void { this.sent.push(payload); }
  close(): void { this.closed = true; }
}
type Answer = (body: { lastUpdateId: number; bids: string[][]; asks: string[][] }) => void;

/** Fake socket and fetch for the duration of `run`: each snapshot request waits until the test answers it. */
async function withFakes(run: (net: { snapshots: Answer[]; sockets: FakeSocket[] }) => Promise<void> | void): Promise<void> {
  const realSocket = globalThis.WebSocket, realFetch = globalThis.fetch;
  FakeSocket.all = [];
  const snapshots: Answer[] = [];
  globalThis.WebSocket = FakeSocket as unknown as typeof WebSocket;
  globalThis.fetch = (() => new Promise(resolve => { snapshots.push(body => resolve({ ok: true, status: 200, json: async () => body } as Response)); })) as typeof fetch;
  try { await run({ snapshots, sockets: FakeSocket.all }); } finally { globalThis.WebSocket = realSocket; globalThis.fetch = realFetch; FakeSocket.all = []; }
}
const settle = async (): Promise<void> => { for (let i = 0; i < 5; i++) await new Promise<void>(resolve => setImmediate(resolve)); };
const snapshot = (id: number) => ({ lastUpdateId: id, bids: [['100', '1']], asks: [['101', '1']] });

test('a connection that was stopped while it opened does not subscribe afterwards', async () => {
  await withFakes(async ({ sockets }) => {
    const c = new BybitConnector();
    c.start();
    const socket = sockets[0]!;
    c.stop();
    socket.onopen?.();                                              // the open event of the retired socket arrives late
    assert.deepEqual(socket.sent, [], 'nothing is sent on a socket that was stopped');
  });
});

test('a snapshot that was asked for by a retired connection is not taken for the next connection\'s', async () => {
  await withFakes(async ({ snapshots, sockets }) => {
    const c = new BinanceUsConnector();
    c.start(); sockets[0]!.onopen?.();
    assert.equal(snapshots.length, 1, 'the first connection asks for its snapshot');
    c.stop(); c.start(); sockets[1]!.onopen?.();
    assert.equal(snapshots.length, 2, 'the second connection asks for its own, though the first is still in flight');
    snapshots[0]!(snapshot(500));                                    // the old answer comes in first
    await settle();
    assert.equal(c.state, 'connecting', 'it is not the new connection\'s snapshot, so the connection is not live yet');
    snapshots[1]!(snapshot(900));
    await settle();
    assert.equal(c.state, 'live'); assert.equal(c.failures, 0);
    c.stop();
  });
});

test('a failure that arrives for a retired connection does not drop the new one', async () => {
  await withFakes(async ({ snapshots, sockets }) => {
    const c = new BinanceUsConnector();
    c.start(); sockets[0]!.onopen?.();
    const old = snapshots[0]!;
    c.stop(); c.start(); sockets[1]!.onopen?.();
    // The old request fails (here: a body that is not a snapshot); the new connection must not be failed for it.
    (old as unknown as (body: unknown) => void)(null);
    await settle();
    assert.equal(c.failures, 0, 'the retired request\'s error is not this connection\'s');
    snapshots[1]!(snapshot(1));
    await settle();
    assert.equal(c.state, 'live');
    c.stop();
  });
});

test('a socket that opens and is never answered is dropped after the startup deadline, not left connecting for ever', async () => {
  await withFakes(async ({ sockets }) => {
    const c = new BybitConnector();
    c.start(); sockets[0]!.onopen?.();
    const t0 = Date.now();
    c.check(t0 + 10_000);
    assert.equal(c.state, 'connecting', 'still inside the deadline');
    c.check(t0 + 31_000);
    assert.equal(c.state, 'error', 'past it, the connection is dropped and a retry is scheduled');
    assert.equal(c.failures, 1); assert.match(c.lastFailure ?? '', /no data 30 s after connecting/);
    assert.equal(sockets[0]!.closed, true);
    c.stop();
  });
});

test('a feed that has delivered its first data is judged by silence, not by the startup deadline', async () => {
  await withFakes(async ({ sockets }) => {
    const c = new BybitConnector();
    c.start(); sockets[0]!.onopen?.();
    sockets[0]!.onmessage?.({ data: msg({ topic: 'orderbook.1000.BTCUSDT', type: 'snapshot', data: { u: 1, b: [['100', '1']], a: [['101', '1']] } }) });
    assert.equal(c.state, 'live');
    const t0 = Date.now();
    c.check(t0 + 15_000); assert.equal(c.state, 'live', 'quiet for less than the silence limit');
    c.check(t0 + 25_000); assert.equal(c.state, 'error'); assert.match(c.lastFailure ?? '', /no data for 20 s/);
    c.stop();
  });
});

test('Bybit\'s orderbook.1000 deltas are consecutive, as its live stream delivers them (measured: 201 deltas, no gap, in 40 s), so a skipped id is a gap', () => {
  const c = new BybitConnector(); c.state = 'connecting';
  const frame = (type: string, u: number) => msg({ topic: 'orderbook.1000.BTCUSDT', type, data: { u, b: [['100', '1']], a: [['101', '1']] } });
  c.onMessage(frame('snapshot', 100)); c.onMessage(frame('delta', 101));
  assert.equal(c.failures, 0);
  c.onMessage(frame('delta', 103));
  assert.equal(c.failures, 1); assert.match(c.lastError ?? '', /sequence gap 101 -> 103/);
  const again = new BybitConnector(); again.state = 'connecting';
  again.onMessage(frame('snapshot', 100)); again.onMessage(frame('snapshot', 1));   // the service restarted: a new snapshot replaces the book, whatever its id
  again.onMessage(frame('delta', 2));
  assert.equal(again.failures, 0);
  c.stop(); again.stop();
});

void BookConnector;
