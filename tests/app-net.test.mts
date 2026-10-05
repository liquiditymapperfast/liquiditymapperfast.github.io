import test from 'node:test';
import assert from 'node:assert/strict';
import { connectLive, connectionStatus, getColumns } from '../src/app/net.ts';
import { encodeColumns } from '../src/server/v2/wire.mts';
import { COLUMNS_PER_REQUEST } from '../src/shared/columns.ts';

const exact = (b: Buffer): ArrayBuffer => b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;

test('recorded columns for more instruments than one request serves are fetched in chunks and merged', async () => {
  const requests: string[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = new URL(String(input), 'http://localhost');
    requests.push(url.search);
    const ids = (url.searchParams.get('inst') ?? '').split(',');
    assert.ok(ids.length <= COLUMNS_PER_REQUEST, 'a request never asks for more than the server serves');
    const results = ids.map(instrumentId => ({ instrumentId, step: 20, columns: [{ t: 0, n: 1, bins: Int32Array.of(4_000), bid: Float32Array.of(5), ask: Float32Array.of(0) }] }));
    const body = exact(encodeColumns(results, 0, 60_000, 60_000));
    return { ok: true, status: 200, arrayBuffer: async () => body } as unknown as Response;
  }) as typeof fetch;
  try {
    const ids = Array.from({ length: 2 * COLUMNS_PER_REQUEST + 1 }, (_, i) => `venue${i}:BTC`);
    const frame = await getColumns(ids, 0, 60_000, 60_000);
    assert.equal(requests.length, 3, 'twelve, twelve and one');
    assert.deepEqual(frame.instruments.map(set => set.id), ids, 'every instrument comes back, in order');
    assert.equal(frame.stepMs, 60_000);
    assert.deepEqual((await getColumns([], 0, 60_000, 60_000)).instruments, [], 'nothing to fetch');
    assert.equal(requests.length, 3, 'an empty list makes no request');
  } finally { globalThis.fetch = original; }
});

class FakeSocket {
  static instances: FakeSocket[] = [];
  static readonly OPEN = 1;
  readyState = 0; binaryType = ''; closed = false;
  onopen: (() => void) | null = null; onmessage: ((event: { data: unknown }) => void) | null = null; onclose: (() => void) | null = null; onerror: (() => void) | null = null;
  constructor(readonly url: string) { FakeSocket.instances.push(this); }
  open() { this.readyState = 1; this.onopen?.(); }
  receive(data: unknown) { this.onmessage?.({ data }); }
  drop() { this.readyState = 3; this.onclose?.(); }
  close() { this.closed = true; this.readyState = 3; }
}

test('the toolbar says what is happening while there is no live connection', () => {
  assert.equal(connectionStatus(1, '127.0.0.1:8787'), 'reconnecting');
  assert.equal(connectionStatus(2, '127.0.0.1:8787'), 'reconnecting');
  assert.equal(connectionStatus(3, '127.0.0.1:8788'), 'no answer from 127.0.0.1:8788 (retry 3)', 'after a few tries it names the address that is not answering');
});

test('a connection that goes silent is dropped and retried like one that closed, and heartbeats keep a quiet one alive', t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  const saved = { WebSocket: globalThis.WebSocket, location: globalThis.location, window: (globalThis as { window?: unknown }).window };
  Object.assign(globalThis, { WebSocket: FakeSocket, location: { protocol: 'http:', host: '127.0.0.1:8787' }, window: globalThis });
  FakeSocket.instances = [];
  let clock = 0; const events: string[] = [];
  const handlers = { onOpen: () => events.push('open'), onClose: (failures: number, host: string) => events.push(`close ${failures} ${host}`), onLevels() {}, onTick: () => events.push('tick'), onLayers() {}, onPrints() {} };
  try {
    const live = connectLive(handlers, { silenceMs: 20_000, pollMs: 5_000, now: () => clock });
    const first = FakeSocket.instances[0]!;
    assert.equal(first.url, 'ws://127.0.0.1:8787/api/v2/ws');
    first.open();
    first.receive(JSON.stringify({ t: 'hb', now: 0 }));
    for (let i = 0; i < 6; i++) { clock += 10_000; first.receive(JSON.stringify({ t: 'hb', now: clock })); t.mock.timers.tick(10_000); }
    assert.deepEqual(events, ['open'], 'a minute of heartbeats and nothing else keeps it open');
    first.receive(JSON.stringify({ t: 'tick', price: 1, instrumentId: 'x', asOf: 1, candles: {} }));
    assert.deepEqual(events, ['open', 'tick']);
    clock += 25_000; t.mock.timers.tick(5_000);
    assert.deepEqual(events.slice(2), ['close 1 127.0.0.1:8787'], 'twenty-five silent seconds is a lost connection');
    assert.equal(first.closed, true);
    assert.equal(FakeSocket.instances.length, 1, 'the retry waits for its backoff');
    t.mock.timers.tick(500);
    assert.equal(FakeSocket.instances.length, 2);
    FakeSocket.instances[1]!.drop();
    assert.deepEqual(events.slice(3), ['close 2 127.0.0.1:8787'], 'a second failure in a row');
    t.mock.timers.tick(1_000);
    assert.equal(FakeSocket.instances.length, 3, 'the backoff doubled');
    FakeSocket.instances[2]!.open(); FakeSocket.instances[2]!.drop();
    assert.equal(events.at(-1), 'close 1 127.0.0.1:8787', 'a connection that worked resets the count');
    live.close();
    t.mock.timers.tick(60_000);
    assert.equal(FakeSocket.instances.length, 3, 'closing stops the retries');
    // An older server sends no heartbeat: silence from it is a quiet market, not a lost connection.
    const older = connectLive(handlers, { silenceMs: 20_000, pollMs: 5_000, now: () => clock });
    const old = FakeSocket.instances[3]!; old.open();
    const before = events.length;
    clock += 120_000; t.mock.timers.tick(120_000);
    assert.equal(events.length, before, 'no close, no retry');
    assert.equal(old.closed, false);
    older.close();
  } finally { Object.assign(globalThis, saved); }
});
