import test from 'node:test';
import assert from 'node:assert/strict';
import { fetchCandles, fetchOiHistory, fetchOiSample, nativeInterval, venueOf, type Fetcher } from '../src/shared/history.ts';

const MINUTE = 60_000, HOUR = 3_600_000;
const T0 = Math.floor(Date.UTC(2026, 9, 1) / HOUR) * HOUR;

/** A synthetic minute series: bar k opens at 100 + k, closes at 100.5 + k, with volume 1. */
const bar = (k: number) => ({ start: T0 + k * MINUTE, open: 100 + k, high: 101 + k, low: 99 + k, close: 100.5 + k, volume: 1 });

/** A Binance-shaped endpoint: the newest `limit` bars that start at or before `endTime`, oldest first. */
function binance(total: number, calls: string[]): Fetcher {
  return async url => {
    calls.push(url);
    const q = new URL(url).searchParams, end = Number(q.get('endTime')), limit = Number(q.get('limit'));
    const rows = [];
    for (let k = 0; k < total; k++) { const b = bar(k); if (b.start <= end) rows.push([b.start, String(b.open), String(b.high), String(b.low), String(b.close), String(b.volume)]); }
    return rows.slice(-limit);
  };
}

test('candles walk back page by page and aggregate to the timeframe', async () => {
  const calls: string[] = [];
  const total = 3000; // two pages of 1500
  const candles = await fetchCandles('binance:BTCUSDT', HOUR, T0, T0 + total * MINUTE, binance(total, calls));
  assert.equal(calls.length, 2);
  assert.equal(candles.length, 50);
  const first = candles[0]!;
  assert.equal(first[0], T0);
  assert.equal(first[1], 100, 'open is the first minute\'s open');
  assert.equal(first[4], 100.5 + 59, 'close is the last minute\'s close');
  assert.equal(first[2], 101 + 59);
  assert.equal(first[3], 99);
  assert.equal(first[5], 60, 'volume sums the minutes');
});

test('a window shorter than a page needs one request and keeps only what was asked for', async () => {
  const calls: string[] = [];
  const candles = await fetchCandles('binance:BTCUSDT', MINUTE, T0 + 100 * MINUTE, T0 + 119 * MINUTE, binance(3000, calls));
  assert.equal(calls.length, 1);
  assert.equal(candles[0]![0], T0 + 99 * MINUTE, 'one timeframe of slack before `from`');
  assert.equal(candles[candles.length - 1]![0], T0 + 119 * MINUTE);
});

test('a venue without a native interval for the timeframe builds it from a finer one', async () => {
  assert.equal(nativeInterval({ intervals: { 60_000: '1', 3_600_000: '60', 21_600_000: '360' } }, 14_400_000), 3_600_000);
  assert.equal(nativeInterval({ intervals: { 60_000: '1', 120_000: '2' } }, 300_000), 60_000, 'the largest one that divides the timeframe, not just the largest that fits');
  assert.equal(nativeInterval({ intervals: { 3_600_000: '60' } }, 60_000), null);
});

test('an unknown venue, a failing page and garbage rows give nothing instead of throwing garbage onward', async () => {
  assert.deepEqual(await fetchCandles('nowhere:BTC', HOUR, T0, T0 + HOUR, async () => []), []);
  assert.deepEqual(await fetchCandles('binance:BTCUSDT', HOUR, T0, T0 + HOUR, async () => ({ code: -1121 })), []);
  assert.deepEqual(await fetchCandles('binance:BTCUSDT', HOUR, T0, T0 + HOUR, async () => [['x', 'y', 'z']]), []);
  await assert.rejects(fetchCandles('binance:BTCUSDT', HOUR, T0, T0 + HOUR, async () => { throw new Error('blocked'); }), /blocked/);
});

test('a misbehaving endpoint that keeps returning the same page cannot loop', async () => {
  let calls = 0;
  const stuck: Fetcher = async () => { calls++; return [[T0, '1', '2', '0.5', '1.5', '1']]; };
  await fetchCandles('binance:BTCUSDT', MINUTE, T0 - 1000 * MINUTE, T0 + MINUTE, stuck);
  assert.ok(calls <= 2, `stopped after ${calls} requests`);
});

test('OKX volume is read in coin, not contracts, and Coinbase rows are reordered to open, high, low, close', async () => {
  const okx = await fetchCandles('okx:BTC-USDT-SWAP', MINUTE, T0, T0 + MINUTE, async () => ({ data: [[String(T0), '10', '12', '9', '11', '500', '5', '55000', '1']] }));
  assert.deepEqual(okx[0]!.slice(0, 6), [T0, 10, 12, 9, 11, 5]);
  const coinbase = await fetchCandles('coinbase:BTC-USD', MINUTE, T0, T0 + MINUTE, async () => [[T0 / 1000, 9, 12, 10, 11, 3]]);
  assert.deepEqual(coinbase[0]!.slice(0, 6), [T0, 10, 12, 9, 11, 3]);
});

test('Hyperliquid candles are asked for with a POST body', async () => {
  let seen: { method?: string; body?: string } | undefined;
  const rows = await fetchCandles('hyperliquid:BTC-PERP', MINUTE, T0, T0 + MINUTE, async (_url, init) => { seen = init; return [{ t: T0, o: '10', h: '12', l: '9', c: '11', v: '4' }]; });
  assert.equal(seen?.method, 'POST');
  assert.equal(JSON.parse(seen!.body!).req.coin, 'BTC');
  assert.deepEqual(rows[0]!.slice(0, 6), [T0, 10, 12, 9, 11, 4]);
});

test('open interest history is Binance only and drops rows with no number', async () => {
  const rows = await fetchOiHistory('binance:BTCUSDT', HOUR, T0, T0 + 3 * HOUR, async () => [
    { timestamp: T0, sumOpenInterest: '100.5' }, { timestamp: T0 + 300_000, sumOpenInterest: 'n/a' }, { timestamp: T0 + 600_000, sumOpenInterest: '101' },
  ]);
  assert.deepEqual(rows.map(r => r.close), [100.5, 101]);
  assert.deepEqual(await fetchOiHistory('bybit:BTCUSDT', HOUR, T0, T0 + HOUR, async () => { throw new Error('should not be asked'); }), []);
});

test('live open interest samples come from Binance and from the Hyperliquid asset context of BTC', async () => {
  assert.equal(await fetchOiSample('binance', async () => ({ openInterest: '81234.5' })), 81234.5);
  assert.equal(await fetchOiSample('binance', async () => ({ code: -1 })), null);
  const ctx = [{ universe: [{ name: 'ETH' }, { name: 'BTC' }] }, [{ openInterest: '9' }, { openInterest: '27000.25' }]];
  assert.equal(await fetchOiSample('hyperliquid', async () => ctx), 27000.25);
  assert.equal(await fetchOiSample('bybit', async () => ctx), null);
});

test('the venue is the part of an instrument id before the colon', () => {
  assert.equal(venueOf('binance:BTCUSDT'), 'binance');
  assert.equal(venueOf('okx:BTC-USDT-SWAP'), 'okx');
});
