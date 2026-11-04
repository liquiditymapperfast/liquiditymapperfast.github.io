import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { HOUR_MS, decodeHour, heldOf, hoursToRead, importHistory, planImport, within, type HistoryColumn, type HistoryLatest, type HistoryRows } from '../src/app/browser/history-import.ts';
import { OTHER_COINS_SERVED, historyUrl } from '../src/app/history-url.ts';
import { Engine } from '../src/shared/engine.ts';

/** The first three minutes of an hour file written by hlm-history on 2026-11-01 (23:14-23:16Z, the eleven default books). */
const fixture = (): ArrayBuffer => { const b = fs.readFileSync(path.join(process.cwd(), 'tests', 'fixtures', 'history-hour.bin')); return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer; };
const HOUR = 1_793_574_000_000;
const col = (inst: string, t: number, n: number, step = 20): HistoryColumn => ({ inst, step, column: { t, n, bins: Int32Array.of(3_900), bid: Float32Array.of(1), ask: Float32Array.of(0) } });

test('an hour file written by the service reads back whole: its hour, every book of the page, sane columns', () => {
  const file = decodeHour(fixture());
  assert.ok(file);
  assert.equal(file.hour, HOUR);
  assert.equal(file.columns.length, 33);
  const books = new Set(file.columns.map(c => c.inst));
  for (const id of ['binance:BTCUSDT', 'binancespot:BTCUSDT', 'bybit:BTCUSDT', 'bybitspot:BTCUSDT', 'okx:BTC-USDT-SWAP', 'okxspot:BTC-USDT', 'bitget:BTCUSDT', 'bitgetspot:BTCUSDT', 'hyperliquid:BTC-PERP', 'deribit:BTC-PERPETUAL', 'coinbase:BTC-USD']) assert.ok(books.has(id), id);
  for (const { step, column } of file.columns) {
    assert.equal(step, 20);
    assert.equal(column.t % 60_000, 0);
    assert.ok(column.n >= 1 && column.n <= 12);
    assert.equal(column.bins.length, column.bid.length);
    assert.equal(column.bins.length, column.ask.length);
    for (let i = 1; i < column.bins.length; i++) assert.ok(column.bins[i]! > column.bins[i - 1]!, 'bins ascending');
    assert.ok(column.lt && column.lt.length === 32 && column.ltN === column.n, 'the tracker comes with every minute');
  }
  // Prices near BTC's on 2026-11-01 (bins of $20).
  const binance = file.columns.find(c => c.inst === 'binance:BTCUSDT' && c.column.n === 12)!;
  assert.ok(binance.column.bins.some(b => b * 20 > 60_000 && b * 20 < 100_000));
});

test('a file that is not one, or a record cut short, is refused or ends the list', () => {
  assert.equal(decodeHour(new ArrayBuffer(8)), null);
  const bytes = new Uint8Array(fixture());
  bytes[0] = 0x58;
  assert.equal(decodeHour(bytes.buffer), null);
  const cut = fixture().slice(0, 16 + 100);
  assert.deepEqual(decodeHour(cut)?.columns, []);
});

test('import rules: inside the window, on the page\'s own step for a book it holds (else the service\'s), fuller than the page\'s copy', () => {
  const t0 = HOUR, held = heldOf([{ instrumentId: 'a', step: 20, column: { t: t0, n: 12 } }, { instrumentId: 'a', step: 20, column: { t: t0 + 60_000, n: 5 } }]);
  const incoming = [col('a', t0, 12), col('a', t0 + 60_000, 11), col('a', t0 + 120_000, 12, 10), col('b', t0, 12, 10), col('b', t0 + 60_000, 9, 20), col('a', t0 - 60_000, 12), col('a', t0 + 180_000, 12), col('a', t0 + 180_000, 7)];
  const take = planImport(held, incoming, t0 - 30_000, t0 + 240_000, { a: 20, b: 20 });
  const keys = take.map(c => `${c.inst}|${(c.column.t - t0) / 60_000}|${c.column.n}`).sort();
  // a@0 is held as full; a@1 is fuller than the page's 5; a@2 lies on another step; a@-1 is before the window; b takes the service's
  // step (20), so its step-10 minute is left out; a@3 came twice, the fuller copy wins.
  assert.deepEqual(keys, ['a|1|11', 'a|3|12', 'b|1|9']);
  assert.deepEqual(planImport(heldOf([]), [col('a', t0, 12)], t0, t0 + 60_000, {}), [], 'a book the service names no step for is not taken');
  assert.deepEqual(planImport(heldOf([]), [col('a', t0, 12)], t0, t0, { a: 20 }), [], 'the minute under way is the page\'s own');
});

test('hours to read: inside the retention, held by the service, and not already held by the page for every book', () => {
  const latest: HistoryLatest = { v: 1, coin: 'BTC', first: HOUR - 5 * HOUR_MS, last: HOUR - HOUR_MS, open: HOUR, steps: { a: 20, b: 20 } };
  const now = HOUR + 10 * 60_000 + 5_000, since = HOUR - 2.5 * HOUR_MS;
  const rows: { instrumentId: string; step: number; column: { t: number; n: number } }[] = [];
  for (let t = HOUR - HOUR_MS; t < HOUR; t += 60_000) for (const id of ['a', 'b']) rows.push({ instrumentId: id, step: 20, column: { t, n: 12 } });
  assert.deepEqual(hoursToRead(latest, heldOf(rows), since, now).map(h => (h - HOUR) / HOUR_MS), [-3, -2, 0], 'the held hour is skipped; -3 holds the window\'s first half hour');
  for (let t = HOUR; t < HOUR + 10 * 60_000; t += 60_000) for (const id of ['a', 'b']) rows.push({ instrumentId: id, step: 20, column: { t, n: 12 } });
  assert.deepEqual(hoursToRead(latest, heldOf(rows), since, now).map(h => (h - HOUR) / HOUR_MS), [-3, -2], 'the open hour held up to now is skipped too');
  assert.deepEqual(hoursToRead({ ...latest, steps: {} }, heldOf([]), since, now), [], 'a service with no books has nothing');
});

test('the whole import against a stand-in service: the hours it lacks, then a file that fails and one past the budget', async () => {
  const file = fixture(), asked: string[] = [];
  const latest: HistoryLatest = { v: 1, coin: 'BTC', first: HOUR - 2 * HOUR_MS, last: HOUR - HOUR_MS, open: HOUR, steps: Object.fromEntries(decodeHour(file)!.columns.map(c => [c.inst, 20])) };
  const fetcher = async (url: string): Promise<{ ok: boolean; status: number; json(): Promise<unknown>; arrayBuffer(): Promise<ArrayBuffer> }> => {
    asked.push(url.slice(url.lastIndexOf('/') + 1));
    if (url.endsWith('/latest.json')) return { ok: true, status: 200, json: async () => latest, arrayBuffer: async () => new ArrayBuffer(0) };
    if (url.endsWith(`/m1/${HOUR}.bin`)) return { ok: true, status: 200, json: async () => null, arrayBuffer: async () => file.slice(0) };
    return { ok: false, status: 404, json: async () => null, arrayBuffer: async () => new ArrayBuffer(0) };
  };
  const added: HistoryColumn[] = [];
  const done = await importHistory({ url: 'https://h.test/v1/btc', held: heldOf([]), add: c => { added.push(...c); return c.length; }, since: HOUR - 3 * HOUR_MS, now: HOUR + 30 * 60_000, fetcher });
  assert.equal(done.columns, 33);
  assert.equal(added.length, 33);
  assert.equal(done.hours, 1);
  assert.equal(done.failed, 2, 'the two finished hours this stand-in does not have');
  assert.ok(asked.includes('latest.json') && asked.includes(`${HOUR}.bin`));
  // A service that never answers: the import gives up at its budget and says so.
  const slow = (_url: string, init: { signal: AbortSignal }) => new Promise<never>((_, reject) => init.signal.addEventListener('abort', () => reject(new Error('aborted'))));
  const late = await importHistory({ url: 'https://h.test/v1/btc', held: heldOf([]), add: () => 0, since: HOUR - HOUR_MS, now: HOUR, budgetMs: 50, fetcher: slow });
  assert.equal(late.columns, 0);
  assert.ok(late.error);
});

test('the address: the service on hiverust, a local stand-in or off from the page address, and only for coins the service records', () => {
  assert.equal(historyUrl('BTC', ''), 'https://history.hiverust.dev/v1/btc', 'the service on hiverust');
  assert.equal(historyUrl('BTC', '?history=http://127.0.0.1:8791/v1/btc/'), 'http://127.0.0.1:8791/v1/btc');
  assert.equal(historyUrl('BTC', '?history=https://evil.example/v1/btc'), 'https://history.hiverust.dev/v1/btc', 'only a local stand-in may replace it');
  assert.equal(historyUrl('BTC', '?history=off'), '');
  assert.equal(historyUrl('ADA', '?history=http://127.0.0.1:8791/v1/btc'), '', 'a coin the service does not record');
  // The other coins the service records (their trade side): each its own folder, on the service or a local stand-in.
  assert.equal(historyUrl('ETH', ''), OTHER_COINS_SERVED ? 'https://history.hiverust.dev/v1/eth' : '', 'the public address serves the other coins once its route does');
  assert.equal(historyUrl('PEPE', '?history=http://127.0.0.1:8791/v1/btc'), 'http://127.0.0.1:8791/v1/pepe', 'the folder of one coin names the service');
  assert.equal(historyUrl('SOL', '?history=http://127.0.0.1:8791/v1/'), 'http://127.0.0.1:8791/v1/sol');
});

test('the trade side is judged on its own: a page that held the books while its trade sockets were down still reads the hour (Sol)', () => {
  const since = HOUR - HOUR_MS, now = HOUR + HOUR_MS + 5 * 60_000;
  const books = Array.from({ length: 60 }, (_, i) => ({ instrumentId: 'a', step: 20, column: { t: HOUR + i * 60_000, n: 12 } }));
  const latest: HistoryLatest = { v: 1, coin: 'BTC', first: HOUR, last: HOUR, open: HOUR + HOUR_MS, steps: { a: 20 } };
  assert.deepEqual(hoursToRead(latest, heldOf(books), since, now), [HOUR + HOUR_MS], 'a service that names no trades: the books decide (the old manifest)');
  assert.deepEqual(hoursToRead({ ...latest, trades: ['t'] }, heldOf(books), since, now), [HOUR, HOUR + HOUR_MS], 'the books are held, the trades are not');
  const own = [{ inst: 't', metric: 'trades' as const, from: HOUR - 1_000, to: HOUR + HOUR_MS + 10 * 60_000 }];
  assert.deepEqual(hoursToRead({ ...latest, trades: ['t'] }, heldOf(books, own), since, now), [HOUR + HOUR_MS], 'held both ways: only the hour whose books it lacks');
  // A coin the service records no books of: its trades alone decide.
  assert.deepEqual(hoursToRead({ v: 1, coin: 'ETH', first: HOUR, last: HOUR, open: HOUR + HOUR_MS, steps: {}, trades: ['t'] }, heldOf([], own), since, now), []);
  assert.deepEqual(hoursToRead({ v: 1, coin: 'ETH', first: HOUR, last: HOUR, open: HOUR + HOUR_MS, steps: {}, trades: ['t'] }, heldOf([]), since, now), [HOUR, HOUR + HOUR_MS]);
  // A depth stretch is not a trade one; a manifest naming something that is not an id reads nothing for it.
  assert.deepEqual(hoursToRead({ v: 1, coin: 'ETH', first: HOUR, last: HOUR, open: null, steps: {}, trades: [7 as unknown as string] }, heldOf([]), since, now), []);
});

test('a manifest with times that are not hours, or far out, reads nothing it should not, and stops at the retention (Sol)', () => {
  const steps = { a: 20 }, since = HOUR - 3 * HOUR_MS, now = HOUR + 5 * 60_000;
  assert.deepEqual(hoursToRead({ v: 1, coin: 'BTC', first: HOUR - 10 * HOUR_MS, last: 1e30, open: null, steps }, heldOf([]), since, now).map(h => (h - HOUR) / HOUR_MS), [], 'a last that is not an hour start counts as none');
  assert.deepEqual(hoursToRead({ v: 1, coin: 'BTC', first: 0, last: HOUR + 1000 * HOUR_MS, open: HOUR + 1000 * HOUR_MS, steps }, heldOf([]), since, now).map(h => (h - HOUR) / HOUR_MS), [-3, -2, -1, 0], 'nothing past now');
  assert.deepEqual(hoursToRead({ v: 1, coin: 'BTC', first: HOUR - 2 * HOUR_MS, last: HOUR - 2 * HOUR_MS, open: HOUR, steps }, heldOf([]), since, now).map(h => (h - HOUR) / HOUR_MS), [-2, -1, 0], 'a closed hour not sealed yet lies between the last sealed and the open one');
});

test('coverage is judged book by book: ten full books and one half-held still read the hour (Sol)', () => {
  const books = Object.fromEntries(Array.from({ length: 11 }, (_, i) => [`b${i}`, 20]));
  const rows: { instrumentId: string; step: number; column: { t: number; n: number } }[] = [];
  for (let i = 0; i < 11; i++) for (let m = 0; m < (i === 10 ? 30 : 60); m++) rows.push({ instrumentId: `b${i}`, step: 20, column: { t: HOUR - HOUR_MS + m * 60_000, n: 12 } });
  assert.deepEqual(hoursToRead({ v: 1, coin: 'BTC', first: HOUR - HOUR_MS, last: HOUR - HOUR_MS, open: null, steps: books }, heldOf(rows), HOUR - HOUR_MS, HOUR + 60_000), [HOUR - HOUR_MS]);
});

test('newest hours first, a stalled latest.json gives up at its own deadline, the service\'s steps come back (Sonnet)', async () => {
  const file = fixture(), asked: string[] = [];
  const steps = Object.fromEntries(decodeHour(file)!.columns.map(c => [c.inst, 20]));
  const latest: HistoryLatest = { v: 1, coin: 'BTC', first: HOUR - 3 * HOUR_MS, last: HOUR - HOUR_MS, open: HOUR, steps: { ...steps, bad: -1 } as Record<string, number> };
  const fetcher = async (url: string) => {
    asked.push(url.slice(url.lastIndexOf('/') + 1));
    return url.endsWith('/latest.json') ? { ok: true, status: 200, json: async () => latest, arrayBuffer: async () => new ArrayBuffer(0) } : { ok: false, status: 404, json: async () => null, arrayBuffer: async () => new ArrayBuffer(0) };
  };
  const done = await importHistory({ url: 'https://h.test/v1/btc', held: heldOf([]), add: () => 0, since: HOUR - 3 * HOUR_MS, now: HOUR + 60_000, fetcher });
  assert.deepEqual(asked.slice(1, 3), [`${HOUR}.bin`, `${HOUR - HOUR_MS}.bin`], 'the open hour, then the one before');
  assert.deepEqual(done.steps, steps, 'a step that is not a positive number is dropped');
  const stalled = (url: string, init: { signal: AbortSignal }) => url.endsWith('/latest.json') ? new Promise<never>((_, reject) => init.signal.addEventListener('abort', () => reject(new Error('aborted')))) : fetcher(url);
  const started = Date.now();
  const late = await importHistory({ url: 'https://h.test/v1/btc', held: heldOf([]), add: () => 0, since: HOUR - HOUR_MS, now: HOUR, latestMs: 40, budgetMs: 5_000, fetcher: stalled });
  assert.ok(late.error && Date.now() - started < 1_000, 'gave up at the latest.json deadline, not the whole budget');
});

test('a whole record that is not a sane minute is left out; the rest of the hour stays (Sonnet)', () => {
  const bytes = new Uint8Array(fixture()), view = new DataView(bytes.buffer);
  // The first record: its samples field (after length, kind, id length, id and time) set to 0.
  const idLength = bytes[16 + 5]!, nAt = 16 + 4 + 2 + idLength + 8;
  view.setUint32(nAt, 0, true);
  const file = decodeHour(bytes.buffer);
  assert.equal(file?.columns.length, 32);
  // A zero-filled tail (a crash) ends the list without reading into it.
  const tail = new Uint8Array(fixture().byteLength + 64); tail.set(new Uint8Array(fixture()));
  assert.equal(decodeHour(tail.buffer)?.columns.length, 33);
});

/** Whole records of every kind cut from an hour file hlm-history wrote on 2026-11-02 (02:21-02:31Z): four minute columns, four flow minutes, two liquidations, six open-interest readings, six large trades, four stretches of trade coverage. */
const tradesFixture = (): ArrayBuffer => { const b = fs.readFileSync(path.join(process.cwd(), 'tests', 'fixtures', 'history-hour-trades.bin')); return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer; };
const TRADES_HOUR = 1_793_584_800_000, MINUTE = 60_000;

test('the trade side of an hour file reads back whole: flow minutes, liquidations, open interest, large trades and coverage', () => {
  const file = decodeHour(tradesFixture());
  assert.ok(file);
  assert.equal(file.hour, TRADES_HOUR);
  assert.equal(file.columns.length, 4, 'the minute columns beside them still read');
  const { flow, liquidations, oi, prints, coverage } = file.rows;
  assert.equal(flow.length, 4);
  for (const row of flow) {
    assert.equal(row.t % MINUTE, 0);
    assert.ok(row.t >= TRADES_HOUR && row.t < TRADES_HOUR + HOUR_MS);
    assert.ok(row.buy.length === 60 && row.sell.length === 60 && row.px!.length === 60);
    // A second with trades has a price near BTC's then; one without has none.
    for (let i = 0; i < 60; i++) {
      if (row.buy[i]! + row.sell[i]! > 0) assert.ok(row.px![i]! > 70_000 && row.px![i]! < 90_000, `${row.inst} second ${i}`);
      else assert.equal(row.px![i], 0);
    }
  }
  assert.deepEqual(liquidations.map(l => [l.id, l.side, l.kind]), [['binance:BTCUSDT', 'short', 'fill'], ['binance:BTCUSDT', 'short', 'fill']]);
  for (const l of liquidations) assert.ok(l.usd >= 100 && l.price === l.reported, 'a fill price is where it is drawn');
  assert.deepEqual(oi.map(r => r.venue), ['binance', 'bitget', 'bybit', 'deribit', 'hyperliquid', 'okx']);
  for (const r of oi) assert.ok(r.t % MINUTE === 0 && r.at! >= r.t && r.at! < r.t + MINUTE && r.base > 1_000 && r.sides === 1);
  // These records are kind 4: Hyperliquid's figure in them counts both sides (40,156.01944 BTC) and is read as one, beside the others'.
  assert.equal(oi.find(r => r.venue === 'hyperliquid')!.base, 40_156.01944 / 2);
  assert.equal(oi.find(r => r.venue === 'binance')!.base, 95_193.471);
  assert.ok(oi.find(r => r.venue === 'deribit')!.quote! > 1e8, 'an inverse market says its USD too');
  assert.ok(oi.filter(r => r.venue !== 'deribit').every(r => r.quote === undefined));
  assert.equal(prints.length, 6);
  for (const p of prints) {
    assert.ok(p.usd >= 25_000, 'the print floor');
    if (p.n !== undefined) assert.ok(p.n >= 2 && p.lo! <= p.price + 1e-6 && p.price <= p.hi! + 1e-6, 'an order of several fills keeps its span');
  }
  assert.equal(prints.filter(p => p.n !== undefined).length, 3);
  assert.equal(coverage.length, 4);
  for (const c of coverage) {
    assert.equal(c.metric, 'trades');
    assert.equal(c.kind, 'live');
    assert.ok(c.to > c.from && c.first && c.last && c.first.t >= c.from && c.last.t < c.to, `${c.inst}: seams inside the stretch`);
  }
  // Hyperliquid's trade id is the page's own (time, coin and the venue's trade id).
  assert.match(coverage.find(c => c.inst === 'hyperliquid:BTC-PERP')!.first!.id, /^\d{13}:BTC:\d+$/);
});

/** An hour file of open-interest records as hlm-history's rows.rs writes them: [kind, venue, minute, at, coins, USD or none]. */
function oiFile(hour: number, records: [number, string, number, number, number, number | null][]): ArrayBuffer {
  const out: number[] = [0x48, 0x4c, 0x4d, 0x43, 1, 0, 0, 0];
  const put = (to: number[], size: number, set: (view: DataView) => void): void => { const b = new Uint8Array(size); set(new DataView(b.buffer)); to.push(...b); };
  put(out, 8, d => d.setBigInt64(0, BigInt(hour), true));
  for (const [kind, venue, t, at, coins, usd] of records) {
    const rec: number[] = [kind, venue.length, ...[...venue].map(c => c.charCodeAt(0))];
    put(rec, 8, d => d.setBigInt64(0, BigInt(t), true)); put(rec, 8, d => d.setBigInt64(0, BigInt(at), true)); put(rec, 8, d => d.setFloat64(0, coins, true));
    rec.push(usd === null ? 0 : 1); put(rec, 8, d => d.setFloat64(0, usd ?? 0, true));
    put(out, 4, d => d.setUint32(0, rec.length, true)); out.push(...rec);
  }
  return Uint8Array.from(out).buffer;
}

test('open interest from an hour file is kept on one side and marked: kind 4 halves Hyperliquid\'s two-sided figure once, kind 10 is as written', async () => {
  const hour = TRADES_HOUR, m1 = hour + MINUTE, m2 = hour + 2 * MINUTE;
  const rows = decodeHour(oiFile(hour, [[4, 'hyperliquid', m1, m1 + 5_000, 100, 8_000_000], [4, 'binance', m1, m1 + 5_000, 100, null], [10, 'hyperliquid', m2, m2 + 5_000, 40, null], [10, 'bybit', m2, m2 + 5_000, 30, null]]))!.rows.oi;
  assert.deepEqual(rows.map(r => [r.venue, r.t - hour, r.base, r.quote, r.sides]), [
    ['hyperliquid', MINUTE, 50, 4_000_000, 1], ['binance', MINUTE, 100, undefined, 1], ['hyperliquid', 2 * MINUTE, 40, undefined, 1], ['bybit', 2 * MINUTE, 30, undefined, 1],
  ]);
  // Saved as they were imported and read back by the engine at the next start: halved once, never twice.
  const engine = new Engine({ venues: [], now: () => hour + 5 * MINUTE, ping: async () => true, get: async () => { throw new Error('offline'); }, oi: { load: () => rows, save() {}, close() {} } });
  const bars = await engine.oi('hyperliquid:BTC-PERP', MINUTE, hour, hour + 3 * MINUTE);
  engine.stop();
  assert.deepEqual([m1, m2].map(t => bars.find(b => b[0] === t)?.[4]), [50, 40]);
});

test('rows of the trade side are kept inside the window: the minute under way is the page\'s own, a stretch is cut at it', () => {
  const rows = decodeHour(tradesFixture())!.rows;
  const all = within(rows, 0, Infinity);
  assert.deepEqual([all.flow.length, all.liquidations.length, all.oi.length, all.prints.length, all.coverage.length], [4, 2, 6, 6, 4]);
  // Before the second liquidation (02:30:30Z): the first stays, the second and every later row goes.
  const before = rows.liquidations[1]!.t;
  const cut = within(rows, 0, before);
  assert.equal(cut.liquidations.length, 1);
  assert.ok(cut.prints.every(p => p.t < before) && cut.flow.every(r => r.t < before));
  // A stretch that reaches past the window ends at it, and loses a last trade it no longer holds.
  const minute = rows.coverage[0]!.from - (rows.coverage[0]!.from % MINUTE) + MINUTE / 2;
  const short = within(rows, 0, minute);
  for (const c of short.coverage) { assert.ok(c.to <= minute); if (c.last) assert.ok(c.last.t < minute); }
  assert.ok(short.coverage.some(c => !c.last));
  // A window that starts after the hour holds nothing of it.
  const later = within(rows, TRADES_HOUR + HOUR_MS, Infinity);
  assert.deepEqual([later.flow.length, later.liquidations.length, later.oi.length, later.prints.length, later.coverage.length], [0, 0, 0, 0, 0]);
});

test('the import hands the trade side to the recordings, cut at the minute under way', async () => {
  const file = tradesFixture();
  const latest: HistoryLatest = { v: 1, coin: 'BTC', first: TRADES_HOUR, last: null, open: TRADES_HOUR, steps: Object.fromEntries(decodeHour(file)!.columns.map(c => [c.inst, c.step])) };
  const fetcher = async (url: string) => url.endsWith('/latest.json')
    ? { ok: true, status: 200, json: async () => latest as unknown, arrayBuffer: async () => new ArrayBuffer(0) }
    : url.endsWith(`/m1/${TRADES_HOUR}.bin`) ? { ok: true, status: 200, json: async () => null as unknown, arrayBuffer: async () => file.slice(0) } : { ok: false, status: 404, json: async () => null as unknown, arrayBuffer: async () => new ArrayBuffer(0) };
  const got: HistoryRows[] = [];
  // The page opens at 02:30:20Z: the first liquidation (02:30:14Z) is inside the minute under way, so it is the page's own.
  const now = Date.UTC(2026, 10, 2, 2, 30, 20);
  const done = await importHistory({ url: 'https://h.test/v1/btc', held: heldOf([]), add: c => c.length, addRows: rows => { got.push(rows); return rows.flow.length + rows.liquidations.length + rows.oi.length + rows.prints.length + rows.coverage.length; }, since: now - 24 * HOUR_MS, now, fetcher });
  assert.equal(done.hours, 1);
  assert.equal(got.length, 1);
  assert.deepEqual([got[0]!.flow.length, got[0]!.liquidations.length, got[0]!.oi.length, got[0]!.prints.length, got[0]!.coverage.length], [4, 0, 6, 6, 4]);
  assert.equal(done.rows, 20);
});

test('an hour read whole is not read again; the open hour and one still under way are (Sol round 2)', async () => {
  const since = HOUR - HOUR_MS, now = HOUR + HOUR_MS + 5 * 60_000;
  const latest: HistoryLatest = { v: 1, coin: 'ETH', first: HOUR - HOUR_MS, last: HOUR, open: HOUR + HOUR_MS, steps: {}, trades: ['t'] };
  assert.deepEqual(hoursToRead(latest, heldOf([], [], [HOUR]), since, now), [HOUR - HOUR_MS, HOUR + HOUR_MS], 'the hour already read is left out');
  const file = tradesFixture();
  const fetcher = async (url: string) => url.endsWith('/latest.json')
    ? { ok: true, status: 200, json: async () => ({ v: 1, coin: 'BTC', first: TRADES_HOUR, last: TRADES_HOUR, open: TRADES_HOUR + HOUR_MS, steps: {}, trades: ['binance:BTCUSDT'] }) as unknown, arrayBuffer: async () => new ArrayBuffer(0) }
    : url.endsWith(`/m1/${TRADES_HOUR}.bin`) ? { ok: true, status: 200, headers: { get: (n: string) => n === 'cache-control' ? cache : null }, json: async () => null as unknown, arrayBuffer: async () => file.slice(0) } : { ok: false, status: 404, json: async () => null as unknown, arrayBuffer: async () => new ArrayBuffer(0) };
  let cache = 'public, max-age=31536000, immutable';
  const after = await importHistory({ url: 'https://h.test/v1/btc', held: heldOf([]), add: c => c.length, addRows: () => 0, since: TRADES_HOUR - HOUR_MS, now: TRADES_HOUR + HOUR_MS + 60_000, fetcher });
  assert.deepEqual(after.read, [TRADES_HOUR], 'a sealed hour is marked read');
  // Just after the hour turned, a cache may still hand out the copy it kept while the hour was open: read, not marked (Sol round 3).
  cache = 'public, max-age=30, stale-while-revalidate=30';
  const early = await importHistory({ url: 'https://h.test/v1/btc', held: heldOf([]), add: c => c.length, addRows: () => 0, since: TRADES_HOUR - HOUR_MS, now: TRADES_HOUR + HOUR_MS + 60_000, fetcher });
  assert.equal(early.hours, 1);
  assert.deepEqual(early.read, []);
  const during = await importHistory({ url: 'https://h.test/v1/btc', held: heldOf([]), add: c => c.length, addRows: () => 0, since: TRADES_HOUR - HOUR_MS, now: TRADES_HOUR + 40 * 60_000, fetcher: async (url: string) => url.endsWith('/latest.json') ? { ok: true, status: 200, json: async () => ({ v: 1, coin: 'BTC', first: null, last: null, open: TRADES_HOUR, steps: {}, trades: ['binance:BTCUSDT'] }) as unknown, arrayBuffer: async () => new ArrayBuffer(0) } : fetcher(url) });
  assert.equal(during.hours, 1);
  assert.deepEqual(during.read, [], 'the open hour is read again next time');
});
