import test from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { createLocalServer } from '../src/server/http.mts';
import { HistoryStore } from '../src/server/history.mts';
import { QuotaLedger } from '../src/core/quota.mts';
import { installV2 } from '../src/server/v2/api.mts';
import { PRICE_QUERY_BARS, parsePriceHistory } from '../src/shared/price-history.ts';
import type { Fetcher } from '../src/shared/history.ts';

const HOUR = 3_600_000, T0 = Date.UTC(2025, 0, 1);
type App = ReturnType<typeof createLocalServer>;
async function withServer(get: Fetcher, run: (base: string, app: App) => Promise<void>): Promise<void> {
  const app = createLocalServer({ history: new HistoryStore({ filePath: ':memory:' }), quota: new QuotaLedger({ filePath: ':memory:' }), persistFixture: false });
  const v2 = installV2(app, { dataDir: '', persist: false, priceHistoryGet: get });
  await new Promise<void>(resolve => app.server.listen(0, '127.0.0.1', resolve));
  try { await run(`http://127.0.0.1:${(app.server.address() as AddressInfo).port}`, app); }
  finally { await app.stopServing(); v2.close(); await app.close(); }
}

test('the server reads exchange prices outside its recording, reuses them and writes no overview candles to SQLite', async () => {
  const calls: URL[] = [];
  await withServer(async raw => {
    const url = new URL(raw); calls.push(url);
    assert.equal(url.hostname, 'fapi.binance.com'); assert.equal(url.searchParams.get('symbol'), 'BTCUSDT');
    return Array.from({ length: 10 }, (_, i) => [T0 + i * HOUR, '100', '102', '99', '101', '5']);
  }, async (base, app) => {
    const route = `${base}/api/v2/price-history?inst=binance:BTCUSDT&tf=1h&from=${T0}&to=${T0 + 10 * HOUR}`;
    const response = await fetch(route); assert.equal(response.status, 200);
    const a = parsePriceHistory(await response.json(), 'binance:BTCUSDT', HOUR);
    assert.equal(a.status, 'ok'); assert.equal(a.candles.length, 10);
    await fetch(route); assert.equal(calls.length, 1);
    assert.equal(app.history.listCandles('binance:BTCUSDT', { interval: '1m', from: T0, to: T0 + 10 * HOUR, limit: 100 }).length, 0);
  });
});

test('only known exact listings and bounded timeframes/windows can reach the public price fetcher', async () => {
  let reads = 0;
  await withServer(async () => { reads++; return []; }, async base => {
    for (const query of [
      'inst=binance:ETHUSDT&tf=1h', 'inst=binance:BTCUSD_PERP&tf=1h', 'inst=unknown:BTC&tf=1h',
      'inst=binance:BTCUSDT&tf=constructor', 'inst=binance:BTCUSDT&tf=1m&from=-1&to=1000',
      'inst=binance:BTCUSDT&tf=1m&from=abc&to=1000', 'inst=binance:BTCUSDT&tf=1m&from=1000&to=1000',
      'inst=binance:BTCUSDT&tf=1m&from=0&to=999999999999',
    ]) assert.equal((await fetch(`${base}/api/v2/price-history?${query}`)).status, 400, query);
    assert.equal(reads, 0);
    const spot = await fetch(`${base}/api/v2/price-history?inst=binancespot:BTCUSDT&tf=1h&from=${T0}&to=${T0 + HOUR}`);
    assert.equal(spot.status, 200); assert.equal(reads, 1);
  });
});

test('the weeks a window of more than 2,000 days is drawn in are answered too, built from daily pages, and bounded like any timeframe', async () => {
  const DAY = 24 * HOUR, WEEK = 7 * DAY, calls: URL[] = [];
  await withServer(async raw => {
    const url = new URL(raw); calls.push(url);
    assert.equal(url.searchParams.get('interval'), '1d');
    const last = Math.floor(Number(url.searchParams.get('endTime')) / DAY) * DAY, limit = Number(url.searchParams.get('limit'));
    const rows: (number | string)[][] = [];
    for (let t = Math.max(T0, last - (limit - 1) * DAY); t <= last; t += DAY) rows.push([t, '100', '102', '99', '101', '5']);
    return rows;
  }, async base => {
    const from = Math.ceil(T0 / WEEK) * WEEK, to = from + 4 * WEEK;
    const response = await fetch(`${base}/api/v2/price-history?inst=binance:BTCUSDT&tf=1w&from=${from}&to=${to}`);
    assert.equal(response.status, 200);
    const a = parsePriceHistory(await response.json(), 'binance:BTCUSDT', WEEK);
    assert.equal(a.status, 'ok'); assert.deepEqual(a.candles.map(c => [c[0], c[6]]), [0, 1, 2, 3].map(k => [from + k * WEEK, 7]));
    assert.equal(calls.length, 1);
    assert.equal((await fetch(`${base}/api/v2/price-history?inst=binance:BTCUSDT&tf=1w&from=0&to=${(PRICE_QUERY_BARS + 1) * WEEK}`)).status, 400);
    assert.equal(calls.length, 1);
  });
});

test('an exchange error is reported as failed, with no repeated request during the cooldown', async () => {
  let reads = 0;
  await withServer(async () => { reads++; return { code: -1121 }; }, async base => {
    const route = `${base}/api/v2/price-history?inst=binance:BTCUSDT&tf=1h&from=${T0}&to=${T0 + HOUR}`;
    const first = await fetch(route);
    assert.equal(first.status, 200); assert.equal(parsePriceHistory(await first.json(), 'binance:BTCUSDT', HOUR).status, 'failed');
    await fetch(route); assert.equal(reads, 1);
  });
});
