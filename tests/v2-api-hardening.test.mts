import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { WebSocket } from 'ws';
import { createLocalServer } from '../src/server/http.mts';
import { installV2, type V2Handle } from '../src/server/v2/api.mts';
import { SqlitePrintStore } from '../src/server/v2/prints.mts';
import { HistoryStore } from '../src/server/history.mts';
import { QuotaLedger } from '../src/core/quota.mts';
import { decodeLevels } from '../src/app/wire.ts';

const MIN = 60_000;
type App = ReturnType<typeof createLocalServer>;

/** A local server with the v2 data plane on an ephemeral port, torn down after `run`. */
async function withServer(run: (ctx: { app: App; v2: V2Handle; base: string; port: number }) => Promise<void>, options: { liveMs?: number } = {}): Promise<void> {
  const app = createLocalServer({ history: new HistoryStore({ filePath: ':memory:' }), quota: new QuotaLedger({ filePath: ':memory:' }), persistFixture: false });
  const v2 = installV2(app, { dataDir: '', persist: false, liveMs: options.liveMs ?? 20, heartbeatMs: 500 });
  await new Promise<void>(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const port = (app.server.address() as AddressInfo).port;
  try { await run({ app, v2, base: `http://127.0.0.1:${port}`, port }); } finally {
    v2.close(); app.server.closeAllConnections(); await new Promise<void>(resolve => app.server.close(() => resolve())); await app.close();
  }
}
const get = async (base: string, route: string): Promise<{ status: number; body: any }> => { const response = await fetch(`${base}${route}`); return { status: response.status, body: await response.json().catch(() => null) }; };

test('an impossible window or an inherited timeframe name is a 400, never an exception out of the request handler', async () => {
  await withServer(async ({ base }) => {
    for (const route of [
      '/api/v2/oi?inst=x:BTC&tf=1h&from=1&to=1',                    // an empty window used to throw out of the history store
      '/api/v2/oi?inst=x:BTC&tf=1h&from=5&to=2',
      '/api/v2/oi?inst=x:BTC&tf=1h&from=-10&to=900000',
      '/api/v2/oi?inst=x:BTC&tf=1h&from=abc&to=900000',
      '/api/v2/oi?inst=x:BTC&tf=constructor',
      '/api/v2/oi?inst=x:BTC&tf=__proto__',
      '/api/v2/candles?inst=x:BTC&tf=toString',
      '/api/v2/candles?inst=x:BTC&tf=1m&from=9&to=3',
      '/api/v2/footprint?inst=x:BTC&tf=hasOwnProperty',
      '/api/v2/footprint?inst=x:BTC&tf=1m&from=x',
    ]) {
      const { status, body } = await get(base, route);
      assert.equal(status, 400, route);
      assert.ok(typeof body?.error === 'string' && body.error.length > 0, `${route} says why`);
    }
    // and the server is still there to answer a good one
    const ok = await get(base, '/api/v2/oi?inst=x:BTC&tf=1h&from=0&to=7200000');
    assert.equal(ok.status, 200); assert.deepEqual(ok.body.bars, []);
    assert.equal((await get(base, '/api/v2/candles?inst=x:BTC&tf=1m')).status, 200);
    assert.equal((await get(base, '/api/v2/oi?inst=x:BTC&tf=1h&from=1.5&to=7200000.2')).status, 200, 'a fraction is widened to whole milliseconds, not refused');
  });
});

test('a failure inside a route answers 500 and leaves the server running', async () => {
  await withServer(async ({ app, base }) => {
    (app.history as unknown as { listCandles: () => never }).listCandles = () => { throw new Error('the store broke'); };
    const bad = await get(base, '/api/v2/candles?inst=x:BTC&tf=1m');
    assert.equal(bad.status, 500); assert.ok(typeof bad.body?.error === 'string');
    assert.equal((await get(base, '/api/v2/state')).status, 200, 'the next request is served');
  });
});

test('print limits are whole numbers from 1 to 5000; a negative limit is not "no limit"', async () => {
  await withServer(async ({ base }) => {
    for (const limit of ['-1', '0', '2.5', 'abc', '5001']) assert.equal((await get(base, `/api/v2/prints?limit=${limit}`)).status, 400, `limit=${limit}`);
    assert.equal((await get(base, '/api/v2/prints?limit=5000')).status, 200);
    assert.equal((await get(base, '/api/v2/prints')).status, 200);
  });
});

const candle = (start: number, volume: number, receivedAt: number) => ({ instrumentId: 'x:BTC', interval: '1m', start, end: start + MIN, open: 100, high: 101, low: 99, close: 100.5, volume, sourceTimestamp: start + MIN, receivedAt, closed: true });

test('a minute that is both stored and held live counts once, as the later copy', async () => {
  await withServer(async ({ app, base }) => {
    const T = Math.floor(Date.now() / MIN) * MIN - 10 * MIN;
    app.history.recordCandle(candle(T, 7, T + MIN + 1_000), { receivedAt: T + MIN + 1_000, source: 'history' });
    (app.state as unknown as { candles: Record<string, unknown[]> }).candles['x:BTC'] = [candle(T, 7, T + MIN + 2_000), candle(T + MIN, 3, T + 2 * MIN)];
    const { body } = await get(base, `/api/v2/candles?inst=x:BTC&tf=5m&from=${T - MIN}&to=${T + 5 * MIN}`);
    const total = (body.candles as number[][]).reduce((sum, row) => sum + row[5]!, 0);
    assert.equal(total, 10, `7 + 3, not 7 + 7 + 3 (got ${total})`);
    const one = await get(base, `/api/v2/candles?inst=x:BTC&tf=1m&from=${T - MIN}&to=${T + 5 * MIN}`);
    assert.deepEqual((one.body.candles as number[][]).map(row => [row[0], row[5], row[6]]), [[T, 7, 1], [T + MIN, 3, 1]], 'each minute is one source row');
  });
});

test('the live open-interest overlay stays inside the interval that was asked for', async () => {
  await withServer(async ({ app, base }) => {
    const T = Math.floor(Date.now() / MIN) * MIN - 30 * MIN;
    (app.state as unknown as { oi: unknown[] }).oi = [
      { instrumentId: 'x:BTC', base: 100, observationTimestamp: T + 10_000 },
      { instrumentId: 'x:BTC', base: 250, observationTimestamp: T + 2 * MIN + 5_000 },     // after the window
      { instrumentId: 'x:BTC', base: 50, observationTimestamp: T - 5_000 },                  // before it
    ];
    const { status, body } = await get(base, `/api/v2/oi?inst=x:BTC&tf=1m&from=${T}&to=${T + MIN}`);
    assert.equal(status, 200);
    assert.deepEqual((body.bars as number[][]).map(bar => bar[0]), [T], 'one bar, the one inside the window');
    assert.equal(body.bars[0][4], 100);
  });
});

// ---- what the live socket publishes ------------------------------------------------------------------------------------------------------------------

const BOOK_ID = 'kraken:BTC/USD';
const market = { instrumentId: BOOK_ID, id: BOOK_ID, venue: 'kraken', quote: 'USD', base: 'BTC', quantityUnit: 'base', marketType: 'spot' };
const makeBook = (bids: [number, number][], asks: [number, number][], sourceTimestamp: number, extra: Record<string, unknown> = {}) => ({ bids, asks, units: 'base', complete: true, gap: false, sourceTimestamp, sequence: 1, ...extra });
/** Collects the levels frames the socket publishes (decoded), oldest first. */
function watchLevels(port: number): { frames: ReturnType<typeof decodeLevels>[]; close(): void } {
  const frames: ReturnType<typeof decodeLevels>[] = [];
  const socket = new WebSocket(`ws://127.0.0.1:${port}/api/v2/ws`);
  socket.on('message', (data: unknown) => {
    if (!Buffer.isBuffer(data)) return;
    try { JSON.parse(data.toString('utf8')); return; } catch { /* a binary levels frame */ }
    frames.push(decodeLevels(data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer));
  });
  return { frames, close: () => socket.terminate() };
}
const until = (check: () => boolean, ms = 3_000): Promise<boolean> => new Promise(resolve => { const t0 = Date.now(), timer = setInterval(() => { if (check() || Date.now() - t0 > ms) { clearInterval(timer); resolve(check()); } }, 15); });
const bidUsd = (frame: ReturnType<typeof decodeLevels>): number => { const book = frame.books.find(b => b.id === BOOK_ID); return book ? [...book.bids.usd].reduce((s, v) => s + v, 0) : NaN; };

test('a book whose interior levels changed is valued again even when its touch, counts and stamps did not', async () => {
  await withServer(async ({ app, port }) => {
    const state = app.state as unknown as { markets: unknown[]; books: Record<string, unknown> };
    const stamp = Date.now();
    state.markets = [market];
    state.books[BOOK_ID] = makeBook([[100, 1], [99, 1], [98, 1]], [[101, 1], [102, 1]], stamp);
    const watch = watchLevels(port);
    try {
      assert.ok(await until(() => watch.frames.length > 0 && Number.isFinite(bidUsd(watch.frames.at(-1)!))), 'the first valuation is published');
      const before = bidUsd(watch.frames.at(-1)!);
      // Only the quantities behind the touch change; the best bid and ask, the level counts, the stamp and the sequence are all as they were.
      state.books[BOOK_ID] = makeBook([[100, 1], [99, 9], [98, 9]], [[101, 1], [102, 1]], stamp);
      assert.ok(await until(() => Math.abs(bidUsd(watch.frames.at(-1)!) - before) > 1), 'the changed book is valued and published again');
      assert.ok(bidUsd(watch.frames.at(-1)!) > before * 3, `${before} -> ${bidUsd(watch.frames.at(-1)!)}`);
    } finally { watch.close(); }
  });
});

test('a book that ages out is taken off the map even when nothing else changes', async () => {
  await withServer(async ({ app, port }) => {
    const state = app.state as unknown as { markets: unknown[]; books: Record<string, unknown> };
    state.markets = [market];
    // Fresh now, over the 180 s cutoff in about a second.
    state.books[BOOK_ID] = makeBook([[100, 1], [99, 1]], [[101, 1], [102, 1]], Date.now() - 179_000);
    const watch = watchLevels(port);
    try {
      assert.ok(await until(() => watch.frames.some(f => f.books.some(b => b.id === BOOK_ID))), 'the book is on the map while it is fresh');
      assert.ok(await until(() => watch.frames.at(-1)!.books.length === 0, 4_000), 'and an empty frame removes it once it is stale, though no other book changed');
    } finally { watch.close(); }
  });
});

// ---- the SQLite print store ------------------------------------------------------------------------------------------------------------------------

test('a limited SQLite print query keeps the newest matches, as the stream promises, not the oldest', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hlm-prints-'));
  try {
    const file = path.join(dir, 'p.sqlite'), store = new SqlitePrintStore(file);
    try {
    const rows = [1, 2, 3, 4, 5].map(k => ({ t: 1_000 * k, id: 'x:BTC', side: 'buy' as const, price: 100, usd: 30_000 + k }));
    store.save(rows, 0);
    assert.deepEqual(store.query(0, 10_000, 25_000, 2).map(p => p.t), [4_000, 5_000], 'the latest two, oldest first');
    assert.deepEqual(store.query(0, 4_500, 25_000, 10).map(p => p.t), [1_000, 2_000, 3_000, 4_000], 'all of them when they fit');
    assert.deepEqual(store.query(2_500, 10_000, 25_000, 2).map(p => p.t), [4_000, 5_000]);
    } finally { store.close(); }
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
