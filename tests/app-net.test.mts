import test from 'node:test';
import assert from 'node:assert/strict';
import { connectLive, connectionStatus, getColumns } from '../src/app/net.ts';
import { ServerSource } from '../src/app/server-source.ts';
import { encodeColumns, encodeLt } from '../src/server/v2/wire.mts';
import type { LtFrame } from '../src/app/wire.ts';
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

class SendingSocket extends FakeSocket { sent: string[] = []; send(data: string) { this.sent.push(data); } }

test('long/short questions go on the live socket once its server says it answers them, each answered by its id, all given up when it closes', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  const saved = { WebSocket: globalThis.WebSocket, location: globalThis.location, window: (globalThis as { window?: unknown }).window };
  Object.assign(globalThis, { WebSocket: SendingSocket, location: { protocol: 'http:', host: '127.0.0.1:8787' }, window: globalThis });
  FakeSocket.instances = [];
  const handlers = { onOpen() {}, onClose() {}, onLevels() {}, onTick() {}, onLayers() {}, onPrints() {} };
  try {
    const live = connectLive(handlers);
    const socket = FakeSocket.instances[0] as SendingSocket;
    socket.open();
    assert.equal(live.longShort('bybit:BTCUSDT', 'accounts', '1h', 0, 3_600_000, 1500), null, 'a server that has not said so: over HTTP');
    socket.receive(JSON.stringify({ t: 'hello', ls: true }));
    const answered = live.longShort('bybit:BTCUSDT', 'accounts', '1h', 0.4, 3_600_000.2, 1500)!;
    const asked = JSON.parse(socket.sent.at(-1)!) as { id: number; from: number; to: number; budget: number };
    assert.deepEqual([asked.from, asked.to, asked.budget], [0, 3_600_001, 1500]);
    socket.receive(JSON.stringify({ t: 'ls', id: asked.id, series: { id: 'bybit:BTCUSDT', population: 'accounts', periodMs: 3_600_000, status: 'ok', pending: true, points: [{ t: 1_000, long: 0.6 }] } }));
    const failed = live.longShort('okx:BTC-USDT-SWAP', 'accounts', '1h', 0, 3_600_000)!;
    socket.receive(JSON.stringify({ t: 'ls', id: (JSON.parse(socket.sent.at(-1)!) as { id: number }).id, error: 'busy' }));
    const cancel = new AbortController(), cancelled = live.longShort('bitget:BTCUSDT', 'accounts', '1h', 0, 3_600_000, 0, cancel.signal)!;
    cancel.abort();
    const late = live.longShort('gateio:BTC_USDT', 'accounts', '1h', 0, 3_600_000)!;
    const dropped = live.longShort('binance:BTCUSDT', 'accounts', '1h', 0, 3_600_000)!;
    t.mock.timers.tick(60_000);
    socket.drop();
    assert.equal(live.longShort('bybit:BTCUSDT', 'accounts', '1h', 0, 3_600_000), null, 'a closed socket says nothing of what its successor answers');
    live.close();
    await Promise.all([
      answered.then(s => assert.deepEqual([s.status, s.pending, s.points.length], ['ok', true, 1])),
      assert.rejects(failed, /busy/), assert.rejects(cancelled, /cancelled/), assert.rejects(late, /live-timeout/), assert.rejects(dropped, /live-timeout|live-closed/),
    ]);
  } finally { Object.assign(globalThis, saved); }
});

test('a long/short question waits a little for a connecting socket to say whether it answers them; an older server is asked over HTTP', async t => {
  // While a page loads its HTTP requests to the server wait longest: a question asked then waits for the socket instead (2026-10-23).
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  const saved = { WebSocket: globalThis.WebSocket, location: globalThis.location, window: (globalThis as { window?: unknown }).window };
  Object.assign(globalThis, { WebSocket: SendingSocket, location: { protocol: 'http:', host: '127.0.0.1:8787' }, window: globalThis });
  FakeSocket.instances = [];
  const handlers = { onOpen() {}, onClose() {}, onLevels() {}, onTick() {}, onLayers() {}, onPrints() {} };
  try {
    const live = connectLive(handlers), socket = FakeSocket.instances[0] as SendingSocket;
    const early = live.lsReadyWithin(4_000);
    socket.open(); socket.receive(JSON.stringify({ t: 'hello', ls: true }));
    assert.equal(await early, true, 'asked while it connected: the socket, once its server said so');
    assert.equal(await live.lsReadyWithin(4_000), true, 'known: at once');
    live.close();
    assert.equal(await live.lsReadyWithin(4_000), false, 'closed: HTTP');
    const older = connectLive(handlers), old = FakeSocket.instances[1] as SendingSocket;
    old.open();
    const waiting = live.lsReadyWithin(1), olderWaiting = older.lsReadyWithin(10_000);
    t.mock.timers.tick(3_000);
    assert.equal(await olderWaiting, false, 'a server that says nothing within 3 s of the socket opening is one from before');
    assert.equal(await waiting, false);
    assert.equal(await older.lsReadyWithin(10_000), false, 'and is not waited for again');
    older.close();
  } finally { Object.assign(globalThis, saved); }
});

test('a long/short question the socket drops or refuses is asked over HTTP; one its asker gave up is not', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  const saved = { WebSocket: globalThis.WebSocket, location: globalThis.location, window: (globalThis as { window?: unknown }).window, fetch: globalThis.fetch };
  const fetched: string[] = [];
  Object.assign(globalThis, {
    WebSocket: SendingSocket, location: { protocol: 'http:', host: '127.0.0.1:8787' }, window: globalThis,
    fetch: async (url: string) => { fetched.push(String(url)); return { ok: true, json: async () => ({ id: 'bybit:BTCUSDT', population: 'accounts', periodMs: 3_600_000, status: 'ok', points: [] }) } as unknown as Response; },
  });
  FakeSocket.instances = [];
  const handlers = { onOpen() {}, onClose() {}, onLevels() {}, onTick() {}, onLayers() {}, onPrints() {} };
  try {
    const source = new ServerSource(), live = source.connect(handlers), socket = FakeSocket.instances[0] as SendingSocket;
    socket.open(); socket.receive(JSON.stringify({ t: 'hello', ls: true }));
    const refused = source.longShort('bybit:BTCUSDT', 'accounts', '1h', 0, 3_600_000, undefined, 1500);
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
    const sent = JSON.parse(socket.sent.at(-1)!) as { id: number };
    socket.receive(JSON.stringify({ t: 'ls', id: sent.id, error: 'too many long/short questions at once' }));
    assert.equal((await refused).status, 'ok');
    assert.equal(fetched.length, 1, 'refused on the socket: asked over HTTP');
    const cancel = new AbortController(), cancelled = source.longShort('bybit:BTCUSDT', 'accounts', '1h', 0, 3_600_000, cancel.signal, 1500);
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
    cancel.abort();
    await assert.rejects(cancelled, /cancelled/);
    assert.equal(fetched.length, 1, 'given up: not asked again over HTTP');
    live.close();
  } finally { Object.assign(globalThis, saved); }
});

test('the white price line is read by the page from the exchange, the server only where that fails', async () => {
  // The line's request through the server ran 25 s behind the page's other history requests; from Binance it takes 0.4 s (2026-10-24).
  const saved = { fetch: globalThis.fetch };
  const urls: string[] = [];
  let binanceDown = false, serverDown = false;
  const HOUR = 3_600_000, from = Date.UTC(2026, 0, 1), kline = (i: number) => [from + i * HOUR, '100', '102', '99', '101', '5', from + (i + 1) * HOUR - 1, '505', 10, '2', '202', '0'];
  Object.assign(globalThis, {
    fetch: async (input: string | URL | Request) => {
      const url = String(input); urls.push(url);
      if (url.includes('/api/v2/price-history')) {
        if (serverDown) return { ok: false, status: 500, json: async () => ({}) } as unknown as Response;
        const u = new URL(url, 'http://localhost');
        return { ok: true, status: 200, json: async () => ({ instrumentId: 'binance:BTCUSDT', tfMs: HOUR, from: Number(u.searchParams.get('from')), to: Number(u.searchParams.get('to')), asOf: Date.now(), status: 'ok', candles: [[Number(u.searchParams.get('from')), 100, 102, 99, 101, 5, 10]] }) } as unknown as Response;
      }
      if (binanceDown) throw new TypeError('network down');
      return { ok: true, status: 200, json: async () => Array.from({ length: 6 }, (_, i) => kline(i)) } as unknown as Response;
    },
  });
  try {
    const source = new ServerSource();
    const answer = await source.priceHistory('binance:BTCUSDT', '1h', from, from + 6 * HOUR);
    assert.equal(answer.status, 'ok'); assert.equal(answer.candles.length, 6);
    assert.ok(urls.some(u => u.includes('fapi.binance.com')), 'read from the exchange');
    assert.ok(!urls.some(u => u.includes('/api/v2/price-history')), 'not through the server');
    urls.length = 0; binanceDown = true;
    const other = await source.priceHistory('binance:BTCUSDT', '1h', from + 10 * 24 * HOUR, from + 10 * 24 * HOUR + 6 * HOUR);
    assert.ok(urls.some(u => u.includes('/api/v2/price-history')), 'the exchange could not be read: the server route is asked');
    assert.equal(other.status, 'ok');
    urls.length = 0;
    await source.priceHistory('notavenue:XYZ', '1h', from, from + 6 * HOUR).catch(() => undefined);
    assert.ok(urls.every(u => !u.includes('klines')), 'an instrument the page cannot read is not read from the exchange');
    assert.ok(urls.some(u => u.includes('/api/v2/price-history')), 'an instrument the page cannot read goes to the server');
    // A window the page holds only some of (the exchange refusing the rest) is asked of the server too, and what the page holds stands where the server fails as well.
    const fresh = new ServerSource();
    urls.length = 0; binanceDown = false; serverDown = false;
    assert.equal((await fresh.priceHistory('binance:BTCUSDT', '1h', from, from + 6 * HOUR)).status, 'ok');
    urls.length = 0; binanceDown = true;
    const some = await fresh.priceHistory('binance:BTCUSDT', '1h', from, from + 12 * HOUR);
    assert.ok(urls.some(u => u.includes('/api/v2/price-history')), 'a stale direct answer is checked against the server');
    assert.equal(some.status, 'ok'); assert.equal(some.candles.length, 1, 'the server answered');
    urls.length = 0; serverDown = true;
    const held = await fresh.priceHistory('binance:BTCUSDT', '1h', from, from + 12 * HOUR);
    assert.equal(held.status, 'stale'); assert.equal(held.candles.length, 6, 'the server failed too: what the page holds stands');
  } finally { Object.assign(globalThis, saved); }
});

test('the line\'s weeks are read by the page from the exchange\'s days too, and a server from before them refusing the week is a plain failure', async () => {
  const saved = { fetch: globalThis.fetch };
  const urls: string[] = [];
  let binanceDown = false;
  const DAY = 86_400_000, WEEK = 7 * DAY, from = Math.ceil(Date.UTC(2025, 0, 1) / WEEK) * WEEK, to = from + 4 * WEEK;
  Object.assign(globalThis, {
    fetch: async (input: string | URL | Request) => {
      const url = String(input); urls.push(url);
      // A server from before the weeks: `1w` is no timeframe it knows (`timeframeMs`), so it answers 400.
      if (url.includes('/api/v2/price-history')) return { ok: false, status: 400, json: async () => ({ error: 'inst and a supported tf are required' }) } as unknown as Response;
      if (binanceDown) throw new TypeError('network down');
      const u = new URL(url), last = Math.floor(Number(u.searchParams.get('endTime')) / DAY) * DAY, limit = Number(u.searchParams.get('limit'));
      assert.equal(u.searchParams.get('interval'), '1d', "weeks are built from the days, never the venue's own weeks");
      const rows: (number | string)[][] = [];
      for (let t = Math.max(from, last - (limit - 1) * DAY); t <= last; t += DAY) rows.push([t, '100', '102', '99', '101', '5', t + DAY - 1, '505', 10, '2', '202', '0']);
      return { ok: true, status: 200, json: async () => rows } as unknown as Response;
    },
  });
  try {
    const answer = await new ServerSource().priceHistory('binance:BTCUSDT', '1w', from, to);
    assert.equal(answer.status, 'ok'); assert.equal(answer.tfMs, WEEK);
    assert.deepEqual(answer.candles.map(c => [c[0], c[6]]), [0, 1, 2, 3].map(k => [from + k * WEEK, 7]), 'four whole weeks of seven days each');
    assert.ok(urls.some(u => u.includes('fapi.binance.com')), 'read from the exchange');
    assert.ok(!urls.some(u => u.includes('/api/v2/price-history')), 'not through the server');
    urls.length = 0; binanceDown = true;
    await assert.rejects(new ServerSource().priceHistory('binance:BTCUSDT', '1w', from, to), /failed: 400/);
    assert.ok(urls.some(u => u.includes('/api/v2/price-history?') && u.includes('tf=1w')), 'the exchange could not be read: the server is asked, and its refusal is the failure');
  } finally { Object.assign(globalThis, saved); }
});

test('tracker questions go on the live socket once its server says it answers them: parts come as binary frames, the last settles, a refusal or a drop fails it, a given-up one is told to stop', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  const saved = { WebSocket: globalThis.WebSocket, location: globalThis.location, window: (globalThis as { window?: unknown }).window };
  Object.assign(globalThis, { WebSocket: SendingSocket, location: { protocol: 'http:', host: '127.0.0.1:8787' }, window: globalThis });
  FakeSocket.instances = [];
  const handlers = { onOpen() {}, onClose() {}, onLevels() {}, onTick() {}, onLayers() {}, onPrints() {} };
  const ask = (live: ReturnType<typeof connectLive>, frames: LtFrame[], signal?: AbortSignal) => live.ltLane(['a:BTC', 'b:BTC'], 1000.4, 9_000_000.2, 120_000, 2, frame => frames.push(frame), signal);
  const part = (id: number, from: number, to: number, done: boolean) => exact(encodeLt(id, from, to, 120_000, 2, done, [{ instrumentId: 'a:BTC', windows: { times: [from], values: Float32Array.of(1, 2, 3, 4) } }, { instrumentId: 'b:BTC', windows: { times: [], values: new Float32Array(0) } }]));
  try {
    const live = connectLive(handlers);
    const socket = FakeSocket.instances[0] as SendingSocket;
    socket.open();
    assert.equal(ask(live, []), null, 'a server that has not said so: nothing asked');
    socket.receive(JSON.stringify({ t: 'hello', ls: true }));
    assert.equal(ask(live, []), null, 'a server that answers long/short and not the tracker');
    socket.receive(JSON.stringify({ t: 'hello', ls: true, lt: true }));
    const frames: LtFrame[] = [], answered = ask(live, frames)!;
    const asked = JSON.parse(socket.sent.at(-1)!) as { t: string; id: number; inst: string[]; from: number; to: number; stepMs: number; half: number };
    assert.deepEqual([asked.t, asked.inst, asked.from, asked.to, asked.stepMs, asked.half], ['lt', ['a:BTC', 'b:BTC'], 1000, 9_000_001, 120_000, 2]);
    socket.receive(part(asked.id, 5_000_000, 9_000_000, false));
    assert.equal(frames.length, 1, 'a part is handed on as it comes');
    socket.receive(part(asked.id + 100, 0, 1, true));
    socket.receive(part(asked.id, 1_000, 5_000_000, true));
    await answered;
    assert.deepEqual(frames.map(f => [f.from, f.to, f.done]), [[5_000_000, 9_000_000, false], [1_000, 5_000_000, true]], 'a part for a question it does not hold is let go');
    assert.deepEqual(Array.from(frames[0]!.instruments[0]!.values), [1, 2, 3, 4]);
    // A refusal fails it.
    const refused = ask(live, [])!;
    socket.receive(JSON.stringify({ t: 'lt', id: (JSON.parse(socket.sent.at(-1)!) as { id: number }).id, error: 'too many tracker questions at once' }));
    await assert.rejects(refused, /too many tracker questions/);
    // Given up by its asker: the server is told to stop, and a late part is let go.
    const cancel = new AbortController(), cancelled = ask(live, [], cancel.signal)!;
    const givenUp = JSON.parse(socket.sent.at(-1)!) as { id: number };
    cancel.abort();
    assert.deepEqual(JSON.parse(socket.sent.at(-1)!), { t: 'lt', id: givenUp.id, cancel: true });
    await assert.rejects(cancelled, /cancelled/);
    socket.receive(part(givenUp.id, 0, 1, true));
    const pre = new AbortController(); pre.abort();
    await assert.rejects(ask(live, [], pre.signal)!, /cancelled/);
    // Too many at once go to the columns; one that is never answered is given up; a closed socket fails what waits and says nothing of its successor's.
    const waiting = [1, 2, 3, 4].map(() => ask(live, [])!);
    assert.equal(ask(live, []), null, 'four waiting: the next is not asked');
    t.mock.timers.tick(90_000);
    await Promise.all(waiting.map(w => assert.rejects(w, /live-timeout/)));
    const dropped = ask(live, [])!;
    socket.drop();
    await assert.rejects(dropped, /live-closed/);
    assert.equal(ask(live, []), null, 'a closed socket asks nothing');
    live.close();
  } finally { Object.assign(globalThis, saved); }
});
