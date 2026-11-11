import test from 'node:test';
import assert from 'node:assert/strict';
import { fetchCandles, fetchOiHistory, fetchOiSample, nativeInterval, readCandles, venueOf, type Fetcher } from '../src/shared/history.ts';
import { aggregateCandles } from '../src/shared/series.ts';

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

test('an unknown venue and garbage rows give nothing instead of throwing garbage onward; a failing page or an error answer throws', async () => {
  assert.deepEqual(await fetchCandles('nowhere:BTC', HOUR, T0, T0 + HOUR, async () => []), []);
  // An error sent as the answer fails the read (Sol, 2026-11-10): read as no candles, it was taken for the start of the history.
  await assert.rejects(fetchCandles('binance:BTCUSDT', HOUR, T0, T0 + HOUR, async () => ({ code: -1121 })), /binance/);
  assert.deepEqual(await fetchCandles('binance:BTCUSDT', HOUR, T0, T0 + HOUR, async () => [['x', 'y', 'z']]), []);
  await assert.rejects(fetchCandles('binance:BTCUSDT', HOUR, T0, T0 + HOUR, async () => { throw new Error('blocked'); }), /blocked/);
});

test('asked for, a page that fails after others came keeps them: the newest part, for the caller to ask on from', async () => {
  const calls: string[] = [], ok = binance(4500, calls);
  const flaky: Fetcher = async url => { if (calls.length >= 2) { calls.push(url); throw new Error('408'); } return ok(url); };
  const all = 4500 * MINUTE;
  await assert.rejects(fetchCandles('binance:BTCUSDT', MINUTE, T0, T0 + all, flaky), /408/, 'not asked for: it throws, as before');
  calls.length = 0;
  const kept = await fetchCandles('binance:BTCUSDT', MINUTE, T0, T0 + all, flaky, undefined, 12, { partial: true });
  assert.equal(calls.length, 3, 'two pages, then the one that failed');
  assert.equal(kept.length, 3000, 'the two pages that came');
  assert.equal(kept[kept.length - 1]![0], T0 + 4499 * MINUTE, 'the newest bar'); assert.equal(kept[0]![0], T0 + 1500 * MINUTE, 'unbroken back to where the pages reached');
  calls.length = 0;
  await assert.rejects(fetchCandles('binance:BTCUSDT', MINUTE, T0, T0 + all, async () => { throw new Error('down'); }, undefined, 12, { partial: true }), /down/, 'nothing came: it throws');
});

test('asked for, Binance candles carry their taker buys (the tenth field), summed when aggregated, and never on the wire form', async () => {
  // Bar k: volume 1 coin, of which (k % 4) / 4 bought at market.
  const get: Fetcher = async url => {
    const q = new URL(url).searchParams, end = Number(q.get('endTime')), limit = Number(q.get('limit')), rows = [];
    for (let k = 0; k < 120; k++) { const b = bar(k); if (b.start <= end) rows.push([b.start, String(b.open), String(b.high), String(b.low), String(b.close), '1', b.start + MINUTE - 1, '100', 5, String((k % 4) / 4), '25', '0']); }
    return rows.slice(-limit);
  };
  const plain = await fetchCandles('binance:BTCUSDT', 5 * MINUTE, T0, T0 + 119 * MINUTE, get);
  assert.ok(plain.every(c => c.length === 7), 'not asked: the seven fields, as the wire form has them');
  const withBuy = await fetchCandles('binance:BTCUSDT', 5 * MINUTE, T0, T0 + 119 * MINUTE, get, undefined, 12, { buy: true });
  assert.equal(withBuy[0]![5], 5, 'five minutes of one coin');
  assert.equal(withBuy[0]![7], (0 + 0.25 + 0.5 + 0.75 + 0) , 'their taker buys summed');
  assert.equal(aggregateCandles([{ start: T0, open: 1, high: 1, low: 1, close: 1, volume: 1, buy: 0.5 }, { start: T0 + MINUTE, open: 1, high: 1, low: 1, close: 1, volume: 1 }], 5 * MINUTE, true)[0]![7], undefined, 'a row without them: the candle has none');
  // A taker figure that is no number from nothing to the volume is none, never a zero that would draw the bar all sold.
  for (const bad of [null, '', false, 'x', '-1', '2']) {
    const odd: Fetcher = async () => [[T0, '1', '1', '1', '1', '1', T0 + MINUTE - 1, '1', 1, bad, '1', '0']];
    const [c] = await fetchCandles('binance:BTCUSDT', MINUTE, T0, T0 + 1, odd, undefined, 1, { buy: true });
    assert.equal(c![7], undefined, `taker buys ${JSON.stringify(bad)}: none`);
  }
});

test('a misbehaving endpoint that keeps returning the same page cannot loop', async () => {
  let calls = 0;
  const stuck: Fetcher = async () => { calls++; return [[T0, '1', '2', '0.5', '1.5', '1']]; };
  await fetchCandles('binance:BTCUSDT', MINUTE, T0 - 1000 * MINUTE, T0 + MINUTE, stuck);
  assert.ok(calls <= 2, `stopped after ${calls} requests`);
});

test('OKX volume is read in coin, not contracts, and Coinbase rows are reordered to open, high, low, close', async () => {
  const okx = await fetchCandles('okx:BTC-USDT-SWAP', MINUTE, T0, T0 + MINUTE, async () => ({ code: '0', data: [[String(T0), '10', '12', '9', '11', '500', '5', '55000', '1']] }));
  assert.deepEqual(okx[0]!.slice(0, 6), [T0, 10, 12, 9, 11, 5]);
  const coinbase = await fetchCandles('coinbase:BTC-USD', MINUTE, T0, T0 + MINUTE, async () => [[T0 / 1000, 9, 12, 10, 11, 3]]);
  assert.deepEqual(coinbase[0]!.slice(0, 6), [T0, 10, 12, 9, 11, 3]);
});

test('Deribit candles go over its WebSocket, because its HTTP chart endpoint cannot be read from a page', async () => {
  let seen: { url: string; request: { method: string; params: { resolution: string } } } | undefined;
  const rows = await fetchCandles('deribit:BTC-PERPETUAL', HOUR, T0, T0 + HOUR, async (url, init) => {
    seen = { url, request: JSON.parse(init!.body!) };
    return { result: { ticks: [T0], open: [10], high: [12], low: [9], close: [11], volume: [4] } };
  });
  assert.ok(seen!.url.startsWith('wss://www.deribit.com/'));
  assert.equal(seen!.request.method, 'public/get_tradingview_chart_data');
  assert.equal(seen!.request.params.resolution, '60');
  assert.deepEqual(rows[0]!.slice(0, 6), [T0, 10, 12, 9, 11, 4]);
});

test('Hyperliquid candles are asked for with a POST body', async () => {
  let seen: { method?: string; body?: string } | undefined;
  const rows = await fetchCandles('hyperliquid:BTC-PERP', MINUTE, T0, T0 + MINUTE, async (_url, init) => { seen = init; return [{ t: T0, o: '10', h: '12', l: '9', c: '11', v: '4' }]; }, undefined, 12, { now: T0 + MINUTE });
  assert.equal(seen?.method, 'POST');
  assert.equal(JSON.parse(seen!.body!).req.coin, 'BTC');
  assert.deepEqual(rows[0]!.slice(0, 6), [T0, 10, 12, 9, 11, 4]);
});

test('open interest history drops rows with no number, and a venue without a history is not asked', async () => {
  const rows = await fetchOiHistory('binance:BTCUSDT', HOUR, T0, T0 + 3 * HOUR, async () => [
    { timestamp: T0, sumOpenInterest: '100.5' }, { timestamp: T0 + 300_000, sumOpenInterest: 'n/a' }, { timestamp: T0 + 600_000, sumOpenInterest: '101' },
  ]);
  assert.deepEqual(rows.map(r => r.base), [100.5, 101]);
  assert.deepEqual(rows.map(r => [r.sourceTimestamp, r.observationTimestamp]), [[T0, T0 - 1], [T0 + 600_000, T0 + 600_000 - 1]], 'each a reading at its stamp, kept a millisecond before it: the close of the bar ending there');
  assert.deepEqual(await fetchOiHistory('bitget:BTCUSDT', HOUR, T0, T0 + HOUR, async () => { throw new Error('should not be asked'); }), []);
});

test('live open interest samples come from Binance and from the Hyperliquid asset context of BTC', async () => {
  assert.equal(await fetchOiSample('binance', async () => ({ openInterest: '81234.5' })), 81234.5);
  assert.equal(await fetchOiSample('binance', async () => ({ code: -1 })), null);
  const ctx = [{ universe: [{ name: 'ETH' }, { name: 'BTC' }] }, [{ openInterest: '9' }, { openInterest: '27000.25' }]];
  assert.equal(await fetchOiSample('hyperliquid', async () => ctx), 27000.25 / 2, 'one side of its two-sided figure');
  assert.equal(await fetchOiSample('bybit', async () => ctx), null);
});

test('the venue is the part of an instrument id before the colon', () => {
  assert.equal(venueOf('binance:BTCUSDT'), 'binance');
  assert.equal(venueOf('okx:BTC-USDT-SWAP'), 'okx');
});

test('a window with no candles is time nobody traded: the read walks on past quiet windows and says how far back it answered (Sol, 2026-11-10)', async () => {
  // Coinbase answers for a window of 300 minutes: three windows with no trade, then candles again further back.
  const asked: number[] = [];
  const quietFrom = T0 - 900 * MINUTE, quietTo = T0;
  const get: Fetcher = async url => {
    const q = new URL(url).searchParams, start = Date.parse(q.get('start')!), end = Date.parse(q.get('end')!); asked.push(end);
    const rows: unknown[] = [];
    for (let t = Math.floor(end / MINUTE) * MINUTE; t >= start; t -= MINUTE) if (t < quietFrom || t >= quietTo) rows.push([t / 1000, 99, 101, 100, 100.5, 1]);
    return rows;
  };
  const read = await readCandles('coinbase:BTC-USD', MINUTE, T0 - 1100 * MINUTE, T0 + 10 * MINUTE, get, undefined, 12, { pageSize: 1500, now: T0 + 10 * MINUTE });
  assert.equal(read.stop, 'reached');
  assert.ok(read.coveredFrom <= T0 - 1100 * MINUTE, 'answered for the whole window, quiet windows included');
  assert.ok(asked.length >= 4, `${asked.length} windows`);
  assert.ok(read.rows.some(r => r[0] < quietFrom) && !read.rows.some(r => r[0] >= quietFrom && r[0] < quietTo));
});

test('an error sent with HTTP 200 fails the page, never reads as no candles (Bybit retCode, OKX code, Bitget code, Deribit error)', async () => {
  await assert.rejects(readCandles('bybit:BTCUSDT', MINUTE, T0, T0 + MINUTE, async () => ({ retCode: 10006, retMsg: 'Too many visits!', result: {} })), /bybit/);
  await assert.rejects(readCandles('okx:BTC-USDT-SWAP', MINUTE, T0, T0 + MINUTE, async () => ({ code: '50011', data: [], msg: 'Too Many Requests' })), /okx/);
  await assert.rejects(readCandles('bitget:BTCUSDT', MINUTE, T0, T0 + MINUTE, async () => ({ code: '429', msg: 'Too many requests', data: null })), /bitget/);
  await assert.rejects(readCandles('deribit:BTC-PERPETUAL', MINUTE, T0, T0 + MINUTE, async () => ({ jsonrpc: '2.0', error: { code: 10028, message: 'too_many_requests' } })), /deribit/);
  await assert.rejects(readCandles('binance:BTCUSDT', MINUTE, T0, T0 + MINUTE, async () => ({ code: -1003, msg: 'Too many requests' })), /binance/);
  // A failed page after others came, asked for in part: what came, and that it failed (not the start of the history).
  let n = 0;
  const flaky: Fetcher = async url => { if (n++ > 0) return { retCode: 10006, result: {} }; const end = Number(new URL(url).searchParams.get('end')); return { retCode: 0, result: { list: Array.from({ length: 1000 }, (_, i) => [String(Math.floor(end / MINUTE) * MINUTE - i * MINUTE), '100', '101', '99', '100', '1']) } }; };
  const part = await readCandles('bybit:BTCUSDT', MINUTE, T0 - 3000 * MINUTE, T0, flaky, undefined, 12, { pageSize: 1500, partial: true });
  assert.equal(part.stop, 'failed'); assert.ok(part.rows.length > 900);
  // Deribit's window nobody traded in: no data, not an error.
  const quiet = await readCandles('deribit:BTC-PERPETUAL', MINUTE, T0, T0 + MINUTE, async () => ({ result: { status: 'no_data', ticks: [], open: [], high: [], low: [], close: [], volume: [] } }), undefined, 12, { now: T0 });
  assert.deepEqual(quiet.rows, []); assert.ok(quiet.coveredFrom <= T0);
});

test('a page short of its limit is the start of the history, except on a venue that keeps only recent bars; Hyperliquid serves its newest 5,000', async () => {
  const short = (rows: number): Fetcher => async url => { const end = Number(new URL(url).searchParams.get('endTime')); return Array.from({ length: rows }, (_, i) => [Math.floor(end / MINUTE) * MINUTE - (rows - 1 - i) * MINUTE, '100', '101', '99', '100', '1']); };
  assert.equal((await readCandles('binance:BTCUSDT', MINUTE, T0 - 5000 * MINUTE, T0, short(40), undefined, 12, { pageSize: 1500 })).stop, 'start');
  const bitget: Fetcher = async () => ({ code: '00000', data: [] });
  assert.equal((await readCandles('bitget:BTCUSDT', MINUTE, T0 - 5000 * MINUTE, T0, bitget, undefined, 12, { pageSize: 1500 })).stop, 'limited', 'Bitget keeps a month of minutes');
  let asked = 0;
  const hl: Fetcher = async () => { asked++; return []; };
  const read = await readCandles('hyperliquid:BTC-PERP', MINUTE, T0 - 9000 * MINUTE, T0, hl, undefined, 24, { now: T0 });
  assert.equal(read.stop, 'limited');
  assert.equal(read.coveredFrom, T0 - 4999 * MINUTE, 'answered for down to its oldest bar served, not further');
  assert.equal(asked, 5, 'and not asked past it');
});
