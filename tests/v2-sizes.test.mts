import test from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { createLocalServer } from '../src/server/http.mts';
import { installV2 } from '../src/server/v2/api.mts';
import { HistoryStore } from '../src/server/history.mts';
import { QuotaLedger } from '../src/core/quota.mts';
import { BrowserSource } from '../src/app/browser-source.ts';
import { getSizes } from '../src/app/net.ts';
import { FootprintRecorder, SIZE_EDGES, parseSizes, sizesOf, type FootprintMinuteRow, type FootprintStore, type SizesAnswer } from '../src/shared/footprint.ts';

const MIN = 60_000, T0 = 1_800_000_000_000;
/** A taker trade of `usd` at `t`: the footprint reads the side, the price, the size and the time. */
const trade = (id: string, inst: string, side: 'buy' | 'sell', usd: number, t: number) => ({ instrumentId: inst, tradeId: id, side, price: 85_000, notionalUsd: usd, sourceTimestamp: t });
const sum = (xs: number[]): number => xs.reduce((a, b) => a + b, 0);
/** Record fills and count each as a market order of one fill, as the order builder does for a venue that reports orders whole. */
const recordOrders = (recorder: FootprintRecorder, rows: { instrumentId: string; tradeId: string; side: 'buy' | 'sell'; price?: unknown; notionalUsd: number; sourceTimestamp: number }[]): void => {
  recorder.ingest(rows); recorder.countOrders(rows.map(r => ({ instrumentId: r.instrumentId, side: r.side, t: r.sourceTimestamp, usd: r.notionalUsd })));
};

test('sizes: each window is the last N whole minutes up to the open one, the instruments are added, and the buckets are the footprint\'s', () => {
  let now = T0 + 30_000;                                    // half way through the minute that is open
  const recorder = new FootprintRecorder(null, () => now);
  recordOrders(recorder, [
    trade('1', 'a:BTC', 'buy', 10_000, T0 + 1_000), trade('2', 'a:BTC', 'sell', 60_000, T0 + 2_000), trade('3', 'b:BTC', 'buy', 600_000, T0 + 5_000),   // the open minute
    trade('4', 'a:BTC', 'buy', 30_000, T0 - 3 * MIN + 1_000),                                                                                         // three minutes back
    trade('5', 'b:BTC', 'sell', 2_000_000, T0 - 10 * MIN + 1_000),                                                                                    // ten minutes back
    trade('6', 'c:BTC', 'buy', 99_000, T0 + 4_000),                                                                                                   // an instrument nobody asked about
  ]);
  const answer = recorder.sizes(['a:BTC', 'b:BTC', 'ghost:BTC'], [1, 5, 15]);
  assert.deepEqual(answer.windows.map(w => w.minutes), [1, 5, 15]);
  const [one, five, fifteen] = answer.windows as [SizesAnswerWindow, SizesAnswerWindow, SizesAnswerWindow];
  // the open minute alone: a buys 10K (bucket 0), a sells 60K (bucket 2), b buys 600K (bucket 5)
  assert.deepEqual(one.buy, [10_000, 0, 0, 0, 0, 600_000, 0, 0]); assert.deepEqual(one.sell, [0, 0, 60_000, 0, 0, 0, 0, 0]);
  assert.equal(one.buyN, 2); assert.equal(one.sellN, 1); assert.equal(one.seen, 1); assert.equal(one.stats, 1);
  // five minutes reach the trade three minutes back (a buy of 30K, bucket 1), not the one ten minutes back
  assert.deepEqual(five.buy, [10_000, 30_000, 0, 0, 0, 600_000, 0, 0]); assert.equal(five.seen, 2); assert.equal(five.stats, 2);
  // fifteen reach both: b sells 2M (bucket 6)
  assert.deepEqual(fifteen.sell, [0, 0, 60_000, 0, 0, 0, 2_000_000, 0]); assert.equal(fifteen.seen, 3); assert.equal(fifteen.stats, 3);
  assert.equal(sum(fifteen.buy) + sum(fifteen.sell), 10_000 + 60_000 + 600_000 + 30_000 + 2_000_000, 'the instrument nobody asked about is not in it');
  assert.equal(fifteen.minutes, 15); assert.equal(SIZE_EDGES.length, fifteen.buy.length);
  // the clock decides which minute is open: a minute later the same trades are one minute further back
  now = T0 + MIN + 10_000;
  const later = recorder.sizes(['a:BTC', 'b:BTC'], [1, 5]);
  assert.equal(later.windows[0]!.seen, 0, 'nothing happened in the new minute: not recorded, as far as anyone can tell'); assert.equal(sum(later.windows[0]!.buy), 0);
  assert.equal(later.windows[1]!.seen, 2, 'five minutes now start one minute later: the open minute with the first trades, and the three-minute-old one are still in');
});
type SizesAnswerWindow = SizesAnswer['windows'][number];

test('sizes: a minute is seen when anyone has rows for it, and a minute with rows but no statistics is seen without them', () => {
  const rows: FootprintMinuteRow[] = [
    { inst: 'old:BTC', t: T0 - MIN, step: 0.5, bins: [[170_000, 5_000, 0]], stats: null },           // recorded before statistics were kept
    { inst: 'new:BTC', t: T0 - 2 * MIN, step: 0.5, bins: [[170_000, 0, 7_000]], stats: { buyN: 0, sellN: 1, buy: [0, 0, 0, 0, 0, 0, 0, 0], sell: [7_000, 0, 0, 0, 0, 0, 0, 0], v: 2 } },
    // statistics from before orders were rebuilt (no version): every fill counted as a trade, so they are not read
    { inst: 'fills:BTC', t: T0 - 2 * MIN, step: 0.5, bins: [[170_000, 0, 9_000]], stats: { buyN: 0, sellN: 3, buy: [0, 0, 0, 0, 0, 0, 0, 0], sell: [9_000, 0, 0, 0, 0, 0, 0, 0] } },
  ];
  const store: FootprintStore = { load: () => rows, save: () => {}, close: () => {} };
  const recorder = new FootprintRecorder(store, () => T0 + 5_000);
  const w = recorder.sizes(['old:BTC', 'new:BTC'], [5]).windows[0]!;
  assert.equal(w.seen, 2); assert.equal(w.stats, 1, 'only one of them carries statistics');
  const fills = recorder.sizes(['fills:BTC'], [5]).windows[0]!;
  assert.deepEqual([fills.seen, fills.stats, fills.sellN], [1, 0, 0], 'per-fill statistics are seen as a minute without statistics');
  assert.equal(w.sellN, 1); assert.equal(sum(w.sell), 7_000); assert.equal(sum(w.buy), 0, 'the old minute\'s 5K of buys is not in the sizes: it has none to give');
  const gap = recorder.sizes(['old:BTC', 'new:BTC'], [3]).windows[0]!;
  assert.equal(gap.seen, 2, 'minutes one and two back are recorded; the open one and the three-back one are not, so a window of three sees two');
  assert.equal(sizesOf({ minutes: () => undefined, stats: () => undefined }, ['x'], [1, 60], T0).windows[1]!.seen, 0, 'an instrument with nothing recorded');
  assert.deepEqual(recorder.sizes([], [2]).windows[0]!.buy, [0, 0, 0, 0, 0, 0, 0, 0]);
});

test('a sizes answer is checked against what was asked for, field by field', () => {
  const recorder = new FootprintRecorder(null, () => T0 + 1_000);
  recorder.ingest([trade('1', 'a:BTC', 'buy', 40_000, T0)]);
  const good = JSON.parse(JSON.stringify(recorder.sizes(['a:BTC'], [1, 5]))) as SizesAnswer;
  assert.deepEqual(parseSizes(good, [1, 5]), good, 'the answer as it comes out of JSON');
  const bad = (change: (a: SizesAnswer) => void, windows: number[] = [1, 5]): SizesAnswer | null => { const a = JSON.parse(JSON.stringify(good)) as SizesAnswer; change(a); return parseSizes(a, windows); };
  assert.equal(parseSizes(null, [1]), null); assert.equal(parseSizes('<html>', [1]), null); assert.equal(parseSizes({ windows: 'x' }, [1]), null); assert.equal(parseSizes({ error: 'not found' }, [1]), null);
  assert.equal(bad(() => {}, [1, 15]), null, 'a window that was not asked for');
  assert.equal(bad(() => {}, [1]), null, 'a different number of windows');
  assert.equal(bad(a => { a.windows[0]!.buy = a.windows[0]!.buy.slice(1); }), null, 'seven buckets');
  assert.equal(bad(a => { a.windows[0]!.sell[2] = -1; }), null, 'negative USD');
  assert.equal(bad(a => { a.windows[0]!.buy[2] = Number.POSITIVE_INFINITY; }), null, 'a number JSON could not have carried');
  assert.equal(bad(a => { a.windows[0]!.buyN = 1.5; }), null, 'a fraction of a trade');
  assert.equal(bad(a => { a.windows[1]!.seen = 6; }), null, 'more minutes than the window has');
  assert.equal(bad(a => { a.windows[1]!.stats = 3; a.windows[1]!.seen = 2; }), null, 'more minutes with statistics than minutes seen');
  assert.equal(bad(a => { (a.windows[0] as unknown as { buy: unknown }).buy = 'x'; }), null);
});

async function withServer(run: (ctx: { base: string; v2: ReturnType<typeof installV2> }) => Promise<void>): Promise<void> {
  const app = createLocalServer({ history: new HistoryStore({ filePath: ':memory:' }), quota: new QuotaLedger({ filePath: ':memory:' }), persistFixture: false });
  const v2 = installV2(app, { dataDir: '', persist: false, liveMs: 50, heartbeatMs: 500 });
  await new Promise<void>(resolve => app.server.listen(0, '127.0.0.1', resolve));
  try { await run({ base: `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`, v2 }); } finally {
    v2.close(); app.server.closeAllConnections(); await new Promise<void>(resolve => app.server.close(() => resolve())); await app.close();
  }
}

test('/api/v2/sizes answers in one piece on the server\'s own clock, and refuses what it cannot answer', async () => {
  await withServer(async ({ base, v2 }) => {
    // The trades go in the open minute and are asked about at once: not across the turn of a minute, or the open one would not be theirs.
    const into = Date.now() % MIN;
    if (into > MIN - 5_000) await new Promise<void>(resolve => setTimeout(resolve, MIN - into + 100));
    const now = Date.now();
    recordOrders(v2.footprint, [trade('s1', 'x:BTC', 'buy', 80_000, now), trade('s2', 'y:BTC', 'sell', 300_000, now), trade('s3', 'x:BTC', 'sell', 30_000, now - 2 * MIN)]);
    const get = async (query: string) => { const r = await fetch(`${base}/api/v2/sizes?${query}`); return { status: r.status, body: await r.json() as { error?: string } & Partial<SizesAnswer> }; };
    const ok = await get('inst=x:BTC,y:BTC&minutes=1,5,60');
    assert.equal(ok.status, 200);
    const parsed = parseSizes(ok.body, [1, 5, 60]);
    assert.ok(parsed, 'the answer is exactly the shape the page checks for');
    assert.deepEqual(parsed!.windows.map(w => w.minutes), [1, 5, 60]);
    assert.equal(parsed!.windows[0]!.buy[2], 80_000, '80K is in the 50K-100K bucket'); assert.equal(parsed!.windows[0]!.sell[4], 300_000, '300K is in the 250K-500K bucket');
    assert.equal(parsed!.windows[1]!.sell[1], 30_000, 'five minutes reach the trade two minutes back'); assert.equal(parsed!.windows[0]!.sell[1], 0, 'one minute does not');
    // a `to` of the client's is not an input: the server counts its own minutes
    const skewed = await get(`inst=x:BTC,y:BTC&minutes=1&to=${now - 90 * MIN}`);
    assert.equal(parseSizes(skewed.body, [1])!.windows[0]!.buy[2], 80_000);
    for (const query of ['', 'inst=x:BTC', 'minutes=1', 'inst=x:BTC&minutes=', 'inst=x:BTC&minutes=0', 'inst=x:BTC&minutes=-5', 'inst=x:BTC&minutes=1.5', 'inst=x:BTC&minutes=abc', 'inst=x:BTC&minutes=1441',
      'inst=x:BTC&minutes=1,2,3,4,5,6,7', `inst=${Array.from({ length: 97 }, (_, i) => `i${i}:BTC`).join(',')}&minutes=1`]) {
      const refused = await get(query);
      assert.equal(refused.status, 400, query); assert.ok(typeof refused.body.error === 'string' && refused.body.error.length > 0, `${query} says why`);
    }
    assert.equal((await get(`inst=${Array.from({ length: 96 }, (_, i) => `i${i}:BTC`).join(',')}&minutes=1440`)).status, 200, 'the most instruments and the longest window are still answered');
    assert.equal((await get('inst=x:BTC&minutes=1,1')).status, 200, 'a window asked twice is answered twice');
  });
});

test('the page asks for the sizes in one request however many instruments it counts', async () => {
  const requests: string[] = [];
  const real = globalThis.fetch;
  globalThis.fetch = (async (input: unknown) => { requests.push(String(input)); return new Response(JSON.stringify({ windows: [{ minutes: 1, seen: 0, stats: 0, buyN: 0, sellN: 0, buy: new Array(8).fill(0), sell: new Array(8).fill(0) }] }), { headers: { 'content-type': 'application/json' } }); }) as typeof fetch;
  try {
    const ids = Array.from({ length: 60 }, (_, i) => `venue${i}:BTCUSDT`);
    const answer = await getSizes(ids, [1]);
    assert.equal(requests.length, 1, 'never split: the minutes two answers saw cannot be added');
    for (const id of ids) assert.ok(requests[0]!.includes(encodeURIComponent(id)), id);
    assert.match(requests[0]!, /minutes=1$/); assert.equal(answer.windows.length, 1);
    // an older server's 404, and a page of HTML, are errors and not answers
    globalThis.fetch = (async () => new Response(JSON.stringify({ error: 'not found' }), { status: 404 })) as typeof fetch;
    await assert.rejects(getSizes(ids, [1]), /404/);
    globalThis.fetch = (async () => new Response('<!doctype html><title>x</title>', { status: 200, headers: { 'content-type': 'text/html' } })) as typeof fetch;
    await assert.rejects(getSizes(ids, [1]), /something else/);
    globalThis.fetch = (async () => new Response(JSON.stringify({ windows: [] }), { status: 200 })) as typeof fetch;
    await assert.rejects(getSizes(ids, [1]), /something else/, 'an answer with the wrong windows');
  } finally { globalThis.fetch = real; }
});

test('the browser source asks its worker the same question, and does not take an answer that is something else', async () => {
  (globalThis as { addEventListener?: unknown }).addEventListener ??= () => {};
  class FakeWorker {
    onmessage: ((event: { data: unknown }) => void) | null = null; onerror: ((event: { message: string }) => void) | null = null;
    posted: { type: string; id?: number; method?: string; ids?: string[]; windows?: number[] }[] = [];
    postMessage(message: FakeWorker['posted'][number]): void { this.posted.push(message); }
  }
  const worker = new FakeWorker(), source = new BrowserSource(worker as unknown as Worker, { persist: false });
  worker.onmessage!({ data: { type: 'ready', persisted: false } });
  const asked = source.sizes(['a:BTC', 'b:BTC'], [1, 15]);
  await new Promise<void>(resolve => setImmediate(resolve));
  const rpc = worker.posted.find(m => m.type === 'rpc' && m.method === 'sizes')!;
  assert.deepEqual(rpc.ids, ['a:BTC', 'b:BTC']); assert.deepEqual(rpc.windows, [1, 15]);
  const window = (minutes: number) => ({ minutes, seen: minutes, stats: minutes, buyN: 1, sellN: 2, buy: new Array(8).fill(1), sell: new Array(8).fill(2) });
  worker.onmessage!({ data: { type: 'rpc', id: rpc.id, result: { windows: [window(1), window(15)] } } });
  assert.deepEqual((await asked).windows.map(w => w.minutes), [1, 15]);
  const wrong = source.sizes(['a:BTC'], [1]);
  await new Promise<void>(resolve => setImmediate(resolve));
  const second = worker.posted.filter(m => m.type === 'rpc' && m.method === 'sizes')[1]!;
  worker.onmessage!({ data: { type: 'rpc', id: second.id, result: { windows: [window(5)] } } });
  await assert.rejects(wrong, /something else/);
});
