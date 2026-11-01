import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { HOUR_MS, decodeHour, heldOf, hoursToRead, importHistory, planImport, type HistoryColumn, type HistoryLatest } from '../src/app/browser/history-import.ts';
import { historyUrl } from '../src/app/history-url.ts';

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

test('the address: none unless configured, a local stand-in or off from the page address, and only for coins the service records', () => {
  assert.equal(historyUrl('BTC', ''), '');
  assert.equal(historyUrl('BTC', '?history=http://127.0.0.1:8791/v1/btc/'), 'http://127.0.0.1:8791/v1/btc');
  assert.equal(historyUrl('BTC', '?history=https://evil.example/v1/btc'), '', 'only a local stand-in may replace it');
  assert.equal(historyUrl('BTC', '?history=off'), '');
  assert.equal(historyUrl('ETH', '?history=http://127.0.0.1:8791/v1/btc'), '');
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
