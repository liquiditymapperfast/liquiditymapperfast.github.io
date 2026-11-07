import test from 'node:test';
import assert from 'node:assert/strict';
import { BTC, type Coin } from '../src/shared/coins.ts';
import { PriceHistoryCache, PRICE_QUERY_BARS, PRICE_TIMEFRAMES, parsePriceHistory, priceListing, priceTarget, type PriceTarget } from '../src/shared/price-history.ts';
import type { Fetcher } from '../src/shared/history.ts';

const HOUR = 3_600_000, MINUTE = 60_000, T0 = Date.UTC(2025, 0, 1);
const target = priceListing(BTC, 'binance:BTCUSDT')!;

/** Public Binance page semantics, including an exchange that omits a bar. Its prices can change as a candle closes. */
function exchange(calls: URL[], price: () => number = () => 100, missing: ReadonlySet<number> = new Set()): Fetcher {
  return async raw => {
    const url = new URL(raw); calls.push(url);
    const tf = ({ '1m': MINUTE, '5m': 5 * MINUTE, '15m': 15 * MINUTE, '30m': 30 * MINUTE, '1h': HOUR, '4h': 4 * HOUR, '1d': 24 * HOUR } as Record<string, number>)[url.searchParams.get('interval')!]!;
    assert.ok(tf > 0);
    const last = Math.floor(Number(url.searchParams.get('endTime')) / tf) * tf, limit = Number(url.searchParams.get('limit'));
    const rows: (number | string)[][] = [];
    for (let t = Math.max(T0, last - (limit - 1) * tf); t <= last; t += tf) if (!missing.has(t)) rows.push([t, String(price()), String(price() + 2), String(price() - 2), String(price() + 1), '5']);
    return rows;
  };
}

test('the overview prefers Binance, distinguishes spot aliases and contracts, and never borrows BTC for another coin', () => {
  assert.equal(priceTarget(BTC, 'bybit:BTCUSDT', 'perp')?.id, 'binance:BTCUSDT');
  assert.equal(priceTarget(BTC, 'okx:BTC-USDT:spot', 'spot')?.id, 'binancespot:BTCUSDT');
  assert.equal(priceListing(BTC, 'binance:BTCUSDT:spot')?.id, 'binancespot:BTCUSDT');
  assert.equal(priceListing(BTC, 'binance:BTCUSD_PERP'), null);
  assert.equal(priceListing(BTC, 'binance:ETHUSDT'), null);
  const other: Coin = { ...BTC, coin: 'OTHER', markets: { bybit: { symbol: 'OTHERUSDT', unit: 1 } } };
  assert.equal(priceTarget(other, 'unknown:OTHER', 'perp')?.id, 'bybit:OTHERUSDT');
  assert.equal(priceTarget({ ...other, markets: {} }, 'unknown:OTHER', 'perp'), null);
});

test('a multi-month overview needs one bounded Binance page; repeated settled views need no request', async () => {
  const calls: URL[] = [], cache = new PriceHistoryCache(exchange(calls), () => T0 + 5_000 * HOUR);
  const a = await cache.series(target, 4 * HOUR, T0, T0 + 74 * 24 * HOUR);
  assert.equal(a.status, 'ok'); assert.equal(a.candles.length, 444); assert.equal(calls.length, 1);
  assert.ok(Number(calls[0]!.searchParams.get('limit')) <= 499);
  assert.equal(a.candles[0]![0], T0); assert.equal(a.candles.at(-1)![0], T0 + 74 * 24 * HOUR - 4 * HOUR);
  assert.deepEqual(parsePriceHistory(a, target.id, 4 * HOUR), a);
  await cache.series(target, 4 * HOUR, T0, T0 + 74 * 24 * HOUR);
  assert.equal(calls.length, 1);
});

test('extending both edges fetches only the missing dates, retaining the overlap once', async () => {
  const calls: URL[] = [], cache = new PriceHistoryCache(exchange(calls), () => T0 + 5_000 * HOUR);
  await cache.series(target, HOUR, T0 + 1_000 * HOUR, T0 + 1_440 * HOUR);
  const a = await cache.series(target, HOUR, T0 + 800 * HOUR, T0 + 1_500 * HOUR);
  assert.equal(a.status, 'ok'); assert.equal(a.candles.length, 700); assert.equal(calls.length, 3);
  assert.ok(Number(calls[1]!.searchParams.get('endTime')) < T0 + 1_000 * HOUR);
  assert.ok(Number(calls[2]!.searchParams.get('limit')) < 70);
  assert.equal(new Set(a.candles.map(c => c[0])).size, a.candles.length);
});

test('the live minute refresh reads only the tail and a bar that has just closed is settled before it is reused', async () => {
  let now = T0 + 1_000 * HOUR + 30 * MINUTE, price = 100;
  const calls: URL[] = [], cache = new PriceHistoryCache(exchange(calls, () => price), () => now);
  const from = T0 + 960 * HOUR, to = T0 + 1_001 * HOUR;
  const first = await cache.series(target, HOUR, from, to);
  assert.equal(first.asOf, now);
  now += 30_000; await cache.series(target, HOUR, from, to); assert.equal(calls.length, 1);
  now += 31_000; price = 110;
  const fresh = await cache.series(target, HOUR, from, to);
  assert.equal(calls.length, 2); assert.ok(Number(calls[1]!.searchParams.get('limit')) <= 4);
  assert.equal(fresh.candles.at(-1)![4], 111);
  now = to + 1; price = 120;
  const closed = await cache.series(target, HOUR, from, to);
  assert.equal(calls.length, 3); assert.equal(closed.candles.at(-1)![4], 121);
  assert.ok(closed.asOf >= to);
  await cache.series(target, HOUR, from, to); assert.equal(calls.length, 3, 'ended bars are now settled');
});

test('reading an older extension does not move the timestamp of the held partial close', async () => {
  let now = T0 + 1_000 * HOUR + 30 * MINUTE;
  const calls: URL[] = [], cache = new PriceHistoryCache(exchange(calls), () => now), to = T0 + 1_001 * HOUR;
  const first = await cache.series(target, HOUR, T0 + 960 * HOUR, to);
  now += 10_000;
  await cache.series(target, HOUR, T0 + 950 * HOUR, T0 + 955 * HOUR);
  const again = await cache.series(target, HOUR, T0 + 960 * HOUR, to);
  assert.equal(again.asOf, first.asOf); assert.equal(calls.length, 2);
});

test('exchange omissions remain holes and listing units are normalized', async () => {
  const calls: URL[] = [], missing = new Set([T0 + 5 * HOUR]);
  const cache = new PriceHistoryCache(exchange(calls, () => 100_000, missing), () => T0 + 100 * HOUR);
  const a = await cache.series({ ...target, listing: { symbol: '1000COINUSDT', unit: 1_000 } }, HOUR, T0, T0 + 10 * HOUR);
  assert.equal(a.candles.length, 9); assert.ok(a.candles.every(c => c[0] !== T0 + 5 * HOUR));
  assert.equal(a.candles[0]![1], 100); assert.equal(a.candles[0]![5], 5_000);
});

test('concurrent windows share the current request and a waiter then reads its own missing edges', async () => {
  const calls: URL[] = []; let release!: () => void, first = true;
  const gate = new Promise<void>(resolve => { release = resolve; }), read = exchange(calls);
  const cache = new PriceHistoryCache(async (url, init) => { if (first) { first = false; await gate; } return read(url, init); }, () => T0 + 5_000 * HOUR);
  const a = cache.series(target, HOUR, T0 + 1_000 * HOUR, T0 + 1_400 * HOUR);
  const b = cache.series(target, HOUR, T0 + 800 * HOUR, T0 + 1_500 * HOUR);
  release();
  const answers = await Promise.all([a, b]);
  assert.ok(answers.every(answer => answer.status === 'ok'));
  assert.equal(answers[1]!.candles.length, 700); assert.equal(calls.length, 3);
});

test('a failed refresh retains data, waits a minute, and retries; an error-shaped or malformed answer is not empty history', async () => {
  let now = T0 + 1_000 * HOUR + MINUTE, fail = false;
  const calls: URL[] = [], read = exchange(calls);
  const cache = new PriceHistoryCache((url, init) => fail ? Promise.resolve({ code: -1121, msg: 'bad symbol' }) : read(url, init), () => now);
  const from = T0 + 900 * HOUR, to = T0 + 1_001 * HOUR;
  const first = await cache.series(target, HOUR, from, to);
  fail = true; now += 61_000;
  const stale = await cache.series(target, HOUR, from, to);
  assert.equal(stale.status, 'stale'); assert.deepEqual(stale.candles, first.candles);
  fail = false;
  assert.equal((await cache.series(target, HOUR, from, to)).status, 'stale');
  now += 61_000; assert.equal((await cache.series(target, HOUR, from, to)).status, 'ok');
  for (const payload of [{ code: -1 }, [['bad', '1', '2', '0.5', '1', '1']], [[T0, '3', '2', '1', '4', '5']]]) {
    const broken = new PriceHistoryCache(async () => payload, () => now);
    assert.equal((await broken.series(target, HOUR, T0, T0 + HOUR)).status, 'failed');
  }
  const empty = new PriceHistoryCache(async () => [], () => now);
  assert.equal((await empty.series(target, HOUR, T0, T0 + HOUR)).status, 'empty');
});

test('a fetcher that never settles releases the series at its deadline and can be retried later', async () => {
  let now = T0 + 1_000 * HOUR, stuck = true, asks = 0;
  const read = exchange([]), cache = new PriceHistoryCache((url, init) => { asks++; return stuck ? new Promise<unknown>(() => {}) : read(url, init); }, () => now, 15);
  assert.equal((await cache.series(target, HOUR, T0, T0 + 10 * HOUR)).status, 'failed');
  await cache.series(target, HOUR, T0, T0 + 10 * HOUR); assert.equal(asks, 1);
  stuck = false; now += 61_000;
  assert.equal((await cache.series(target, HOUR, T0, T0 + 10 * HOUR)).status, 'ok'); assert.equal(asks, 2);
});

test('cache bounds count empty time slots and never evict an active read to start unlimited requests', async () => {
  const calls: URL[] = [], cache = new PriceHistoryCache(exchange(calls), () => T0 + 10_000 * HOUR);
  for (let block = 0; block < 10; block++) await cache.series(target, HOUR, T0 + block * 500 * HOUR, T0 + (block + 1) * 500 * HOUR);
  const before = calls.length;
  await cache.series(target, HOUR, T0, T0 + 10 * HOUR); assert.ok(calls.length > before, 'the oldest dates were let go');
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; }), read = exchange([]);
  const busy = new PriceHistoryCache(async (url, init) => { await gate; return read(url, init); }, () => T0 + 10_000 * HOUR);
  const coin = (n: number): PriceTarget => ({ ...target, id: `binance:COIN${n}USDT`, listing: { symbol: `COIN${n}USDT`, unit: 1 } });
  const active = Array.from({ length: 12 }, (_, n) => busy.series(coin(n), HOUR, T0, T0 + HOUR));
  await assert.rejects(busy.series(coin(12), HOUR, T0, T0 + HOUR), /busy/);
  release(); await Promise.all(active);
  assert.equal((await busy.series(coin(12), HOUR, T0, T0 + HOUR)).status, 'ok');
  await assert.rejects(cache.series(target, HOUR, T0, T0 + (PRICE_QUERY_BARS + 1) * HOUR), /window/);
});

test('every interval of the line and another market can be read at once: a zoom through them all leaves its dropped reads running', async () => {
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; }), read = exchange([]);
  const cache = new PriceHistoryCache(async (url, init) => { await gate; return read(url, init); }, () => T0 + 10_000 * HOUR);
  // Eight intervals of the perpetual still being read (a read dropped by the chart goes on in the cache) and the spot market asked for beside them.
  const spot = priceListing(BTC, 'binancespot:BTCUSDT')!;
  const reads = [...Object.values(PRICE_TIMEFRAMES).map(ms => cache.series(target, ms, T0, T0 + ms)), cache.series(spot, HOUR, T0, T0 + HOUR)];
  assert.equal(reads.length, 9);
  release();
  const answers = await Promise.all(reads);
  assert.ok(answers.every(a => a.status === 'ok'), answers.map(a => a.status).join(' '));
});

test('wire validation refuses another market, out-of-window rows, invalid OHLC, excessive rows and status inconsistencies', () => {
  const answer = { instrumentId: target.id, tfMs: HOUR, from: T0, to: T0 + 2 * HOUR, asOf: T0 + 3 * HOUR, status: 'ok', candles: [[T0, 100, 102, 99, 101, 5, 1]] };
  assert.equal(parsePriceHistory(answer, target.id, HOUR).candles.length, 1);
  for (const bad of [{ ...answer, instrumentId: 'binancespot:BTCUSDT' }, { ...answer, tfMs: 1 }, { ...answer, from: T0 + HOUR }, { ...answer, status: 'empty' }, { ...answer, candles: [[T0, 100, 99, 101, 101, 5, 1]] }, { ...answer, candles: Array.from({ length: PRICE_QUERY_BARS + 3 }, () => answer.candles[0]) }]) assert.throws(() => parsePriceHistory(bad, target.id, HOUR));
});

test('weeks are built from the daily pages, on whole weeks since 1970, in as few requests as the days that exist need', async () => {
  const calls: URL[] = [], day = 24 * HOUR, week = 7 * day, now = T0 + 800 * day, cache = new PriceHistoryCache(exchange(calls), () => now);
  // A window that starts before the listing (the fake's history begins at T0): the reading stops at the first empty page.
  const from = Math.floor((T0 - 60 * day) / week) * week, to = Math.ceil((now + 1) / week) * week;
  const a = await cache.series(target, week, from, to);
  assert.equal(a.status, 'ok'); assert.ok(calls.every(url => url.searchParams.get('interval') === '1d' && Number(url.searchParams.get('limit')) <= 499));
  assert.equal(calls.length, Math.ceil(801 / 499) + 1, 'two pages of days and the empty one before the listing');
  assert.ok(a.candles.every(c => c[0] % week === 0)); assert.deepEqual(parsePriceHistory(a, target.id, week), a);
  assert.equal(a.candles.length, Math.floor(now / week) - Math.floor(T0 / week) + 1);
  // A whole week is its seven days: the first open, the highest high, the lowest low, the last close, the volume added up.
  assert.deepEqual(a.candles[1], [Math.ceil(T0 / week) * week, 100, 102, 98, 101, 35, 7]);
  await cache.series(target, week, from, to); assert.equal(calls.length, 3, 'ended weeks are kept');
  await assert.rejects(cache.series(target, week, 0, (PRICE_QUERY_BARS + 1) * week), /window/);
});

test('a year of daily context needs one small request and switching resolutions keeps its exchange cache', async () => {
  const calls: URL[] = [], day = 24 * HOUR, cache = new PriceHistoryCache(exchange(calls), () => T0 + 500 * day);
  const first = await cache.series(target, day, T0, T0 + 365 * day);
  assert.equal(first.status, 'ok'); assert.equal(first.candles.length, 365); assert.equal(calls.length, 1);
  assert.ok(Number(calls[0]!.searchParams.get('limit')) <= 367);
  await cache.series(target, HOUR, T0 + 300 * day, T0 + 301 * day);
  await cache.series(target, day, T0, T0 + 365 * day);
  assert.equal(calls.length, 2, 'returning to the daily view does not fetch it again');
});
