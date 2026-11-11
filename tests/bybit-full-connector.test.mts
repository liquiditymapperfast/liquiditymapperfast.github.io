import test from 'node:test';
import assert from 'node:assert/strict';
import { BybitConnector, BybitSpotConnector } from '../src/shared/venues.ts';

/** The connector's socket, faked: what it sent, and frames the test delivers. */
class FakeSocket {
  static all: FakeSocket[] = [];
  binaryType = ''; sent: unknown[] = []; closed = false;
  onopen: (() => void) | null = null; onmessage: ((event: { data: unknown }) => void) | null = null; onerror: (() => void) | null = null; onclose: (() => void) | null = null;
  constructor(public url: string) { FakeSocket.all.push(this); }
  send(payload: unknown): void { this.sent.push(typeof payload === 'string' ? JSON.parse(payload) as unknown : payload); }
  close(): void { this.closed = true; }
}
interface Asked { url: string; init: RequestInit | undefined; answer(body: unknown, ok?: boolean): void; fail(): void }

/** Fake socket and fetch for the duration of `run`: each snapshot request waits until the test answers it. */
async function withFakes(run: (net: { asked: Asked[]; sockets: FakeSocket[] }) => Promise<void>): Promise<void> {
  const realSocket = globalThis.WebSocket, realFetch = globalThis.fetch;
  FakeSocket.all = [];
  const asked: Asked[] = [];
  globalThis.WebSocket = FakeSocket as unknown as typeof WebSocket;
  globalThis.fetch = ((url: string, init?: RequestInit) => new Promise((resolve, reject) => {
    asked.push({ url, init, answer: (body, ok = true) => resolve({ ok, status: ok ? 200 : 503, json: async () => body } as Response), fail: () => reject(new Error('network')) });
  })) as typeof fetch;
  try { await run({ asked, sockets: FakeSocket.all }); } finally { globalThis.WebSocket = realSocket; globalThis.fetch = realFetch; FakeSocket.all = []; }
}
const settle = async (): Promise<void> => { for (let i = 0; i < 5; i++) await new Promise<void>(resolve => setImmediate(resolve)); };
/** Until the connector asks for its snapshot (half a second after subscribing, or after a pause). */
async function untilAsked(asked: Asked[], n: number, ms = 3_000): Promise<void> {
  const end = Date.now() + ms;
  while (asked.length < n && Date.now() < end) await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(asked.length, n, `snapshot request ${n}`);
}
const delta = (u: number, b: [string, string][] = [], a: [string, string][] = [], symbol = 'BTCUSDT') => ({ data: JSON.stringify({ topic: `orderbook.full.${symbol}`, type: 'delta', ts: Date.now(), data: { s: symbol, u, seq: u * 10, b, a } }) });
const trade = (price = '100', symbol = 'BTCUSDT') => ({ data: JSON.stringify({ topic: `publicTrade.${symbol}`, data: [{ i: String(Math.random()), p: price, v: '1', S: 'Buy', T: Date.now(), seq: 1 }] }) });
const body = (u: number, b: [string, string][] = [['99', '1'], ['98', '2']], a: [string, string][] = [['101', '1'], ['102', '2']], symbol = 'BTCUSDT') => ({ retCode: 0, retMsg: 'OK', result: { s: symbol, u, seq: u * 10, ts: Date.now(), b, a } });

test('Bybit connector: the socket goes live on trades while the book loads; the book is drawn once seeded on its anchor', async () => {
  await withFakes(async ({ asked, sockets }) => {
    const c = new BybitConnector();
    c.start(); sockets[0]!.onopen?.();
    assert.deepEqual(sockets[0]!.sent[0], { op: 'subscribe', args: ['orderbook.full.BTCUSDT', 'publicTrade.BTCUSDT', 'allLiquidation.BTCUSDT', 'tickers.BTCUSDT'] });
    sockets[0]!.onmessage?.(trade());
    assert.equal(c.state, 'live', 'a trade makes the socket live');
    assert.equal(c.valued(Date.now()), null, 'but no book is drawn yet');
    assert.equal(c.bookDetail(), 'loading the full book');
    sockets[0]!.onmessage?.(delta(10, [['99', '5']])); sockets[0]!.onmessage?.(delta(11, [], [['103', '1']]));
    await untilAsked(asked, 1);
    assert.equal(asked[0]!.url, 'https://api.bybit.com/v5/market/full_orderbook?category=linear&symbol=BTCUSDT');
    assert.equal(asked[0]!.init?.credentials, 'omit', 'no credentials are sent');
    asked[0]!.answer(body(10));
    await settle();
    const book = c.valued(Date.now());
    assert.ok(book, 'seeded: drawn');
    assert.equal(c.bookDetail(), null);
    assert.ok(book.epoch && book.epoch > 0, 'the valued book carries its coverage epoch');
    // Delta 11 was applied after the anchor: the ask at 103 is past the snapshot's frontier (102), so it is left out.
    assert.deepEqual([...book.bids.usd].slice(0, 2), [99, 196], 'delta 10 is the anchor: its 99 x5 is not applied twice; the snapshot\'s 99 x1 stands');
    c.stop();
  });
});

test('Bybit connector: a gap withdraws the book and asks for a snapshot on the same socket; three in a minute drop the socket', async () => {
  await withFakes(async ({ asked, sockets }) => {
    const c = new BybitConnector();
    c.start(); sockets[0]!.onopen?.();
    sockets[0]!.onmessage?.(delta(10));
    await untilAsked(asked, 1);
    asked[0]!.answer(body(10)); await settle();
    assert.ok(c.valued(Date.now()));
    sockets[0]!.onmessage?.(delta(12));
    assert.equal(c.valued(Date.now()), null, 'withdrawn at once');
    assert.equal(c.failures, 0); assert.equal(sockets[0]!.closed, false, 'the socket (and its trades) stays');
    assert.match(String(c.bookDetail()), /re-synchronising \(sequence gap 10 -> 12\)/);
    await untilAsked(asked, 2);
    asked[1]!.answer(body(12)); await settle();
    assert.ok(c.valued(Date.now()), 'seeded again on the gap delta');
    sockets[0]!.onmessage?.(delta(14)); await untilAsked(asked, 3); asked[2]!.answer(body(14)); await settle();
    sockets[0]!.onmessage?.(delta(16));
    assert.equal(c.failures, 1, 'the third resynchronisation within a minute drops the socket'); assert.equal(sockets[0]!.closed, true);
    assert.match(c.lastFailure ?? '', /three times in a minute/);
    c.stop();
  });
});

test('Bybit connector: a snapshot that fails or does not anchor is asked for again after a pause; an old connection\'s answer is not taken', async () => {
  await withFakes(async ({ asked, sockets }) => {
    const c = new BybitConnector();
    c.start(); sockets[0]!.onopen?.();
    sockets[0]!.onmessage?.(delta(10));
    await untilAsked(asked, 1);
    asked[0]!.fail(); await settle();
    assert.equal(c.failures, 0, 'a failed snapshot does not drop the socket');
    assert.match(String(c.bookDetail()), /snapshot failed: network/);
    await untilAsked(asked, 2);
    asked[1]!.answer(body(9)); await settle();          // older than the first delta held: not anchored, asked again
    assert.equal(c.valued(Date.now()), null);
    await untilAsked(asked, 3);
    // A new connection meanwhile: the old request's answer is not this connection's book.
    c.stop(); c.start(); sockets[1]!.onopen?.();
    asked[2]!.answer(body(10)); await settle();
    assert.equal(c.valued(Date.now()), null, 'the retired connection\'s answer seeds nothing');
    sockets[1]!.onmessage?.(delta(20));
    await untilAsked(asked, 4);
    asked[3]!.answer(body(20)); await settle();
    assert.ok(c.valued(Date.now()));
    c.stop();
  });
});

test('Bybit connector: run for its trades alone, it subscribes no book and reads no snapshot; spot keeps alive on its ticker', async () => {
  await withFakes(async ({ asked, sockets }) => {
    const linear = new BybitConnector(); linear.bookRead = false;
    linear.start(); sockets[0]!.onopen?.();
    assert.deepEqual(sockets[0]!.sent[0], { op: 'subscribe', args: ['publicTrade.BTCUSDT', 'allLiquidation.BTCUSDT', 'tickers.BTCUSDT'] });
    const spot = new BybitSpotConnector(); spot.bookRead = false;
    spot.start(); sockets[1]!.onopen?.();
    assert.deepEqual(sockets[1]!.sent[0], { op: 'subscribe', args: ['publicTrade.BTCUSDT', 'tickers.BTCUSDT'] });
    sockets[1]!.onmessage?.({ data: JSON.stringify({ topic: 'tickers.BTCUSDT', type: 'snapshot', ts: Date.now(), data: { symbol: 'BTCUSDT', lastPrice: '100' } }) });
    assert.equal(spot.state, 'live', 'its ticker keeps a quiet spot socket live');
    await new Promise(resolve => setTimeout(resolve, 700));
    assert.equal(asked.length, 0, 'no snapshot is read for a book nobody reads');
    linear.stop(); spot.stop();
  });
});

test('Bybit connector: a withdrawn book whose channel went silent is dropped even while trades keep the socket alive', async () => {
  await withFakes(async ({ asked, sockets }) => {
    const c = new BybitConnector();
    c.start(); sockets[0]!.onopen?.();
    sockets[0]!.onmessage?.(delta(10));
    await untilAsked(asked, 1);
    asked[0]!.answer(body(10)); await settle();
    sockets[0]!.onmessage?.(delta(12));                          // a gap: withdrawn, a snapshot wanted
    assert.equal(c.valued(Date.now()), null);
    const t0 = Date.now();
    c.lastUpdate = t0 + 30_500;                                     // trades and the ticker keep coming
    c.check(t0 + 31_000);
    assert.equal(c.failures, 1); assert.match(c.lastFailure ?? '', /book silent 30 s/);
    c.stop();
  });
});

test('Bybit connector: a stream that only repeats old frames is no book channel: dropped after 30 s', async () => {
  await withFakes(async ({ asked, sockets }) => {
    const c = new BybitConnector();
    c.start(); sockets[0]!.onopen?.();
    sockets[0]!.onmessage?.(delta(10));
    await untilAsked(asked, 1);
    asked[0]!.answer(body(10)); await settle();
    const t0 = Date.now();
    for (let i = 0; i < 20; i++) sockets[0]!.onmessage?.(delta(10));   // the same u again and again
    c.lastUpdate = t0 + 30_500;
    c.check(t0 + 31_000);
    assert.equal(c.failures, 1); assert.match(c.lastFailure ?? '', /book silent 30 s/);
    c.stop();
  });
});

test('Bybit connector: a quiet book (heartbeats, no trades) still reads its audit', async () => {
  await withFakes(async ({ asked, sockets }) => {
    const realNow = Date.now; let clock = realNow();
    Date.now = () => clock;
    try {
      const c = new BybitConnector();
      c.start(); sockets[0]!.onopen?.();
      sockets[0]!.onmessage?.(delta(10));
      await untilAsked(asked, 1);
      asked[0]!.answer(body(10)); await settle();
      assert.ok(c.valued(clock));
      clock += 11_000;                                              // past the audit delay; no trade at all
      sockets[0]!.onmessage?.(delta(11));                           // a quiet book's empty delta
      await untilAsked(asked, 2);
      assert.equal(asked[1]!.url, asked[0]!.url, 'the audit asks for the same snapshot');
      asked[1]!.answer(body(11)); await settle();
      assert.ok(c.valued(clock), 'passed: the book stays');
      c.stop();
    } finally { Date.now = realNow; }
  });
});

test('Bybit connector: a refused subscription drops the socket; a book channel that stalls is no longer drawn and is dropped too', async () => {
  await withFakes(async ({ asked, sockets }) => {
    const c = new BybitConnector();
    c.start(); sockets[0]!.onopen?.();
    sockets[0]!.onmessage?.({ data: JSON.stringify({ success: false, ret_msg: 'error:handler not found,topic:orderbook.full.BTCUSDT', op: 'subscribe' }) });
    assert.equal(c.failures, 1); assert.match(c.lastFailure ?? '', /subscription refused/);
    c.stop();

    const s = new BybitConnector();
    s.start(); sockets[1]!.onopen?.();
    sockets[1]!.onmessage?.(delta(10));
    await untilAsked(asked, 1);
    assert.equal(asked[0]!.url.includes('BTCUSDT'), true, 'the refused connection never asked for its snapshot (its retry was cancelled with it)');
    asked[0]!.answer(body(10)); await settle();
    assert.ok(s.valued(Date.now()));
    const t0 = Date.now();
    s.lastUpdate = t0 + 10_000;
    s.check(t0 + 10_000); assert.equal(s.state, 'live', 'no book delta for ten seconds (a quiet book gets an empty one every 5 s at most): not yet');
    // Other topics keep the socket fresh, the book takes no delta: past 30 s the book is no longer drawn and the socket is dropped.
    s.lastUpdate = t0 + 30_500;
    assert.equal(s.valued(t0 + 31_000), null, 'a stalled book is not drawn');
    s.check(t0 + 31_000);
    assert.equal(s.failures, 1); assert.match(s.lastFailure ?? '', /book silent 30 s/);
    s.stop();
  });
});
