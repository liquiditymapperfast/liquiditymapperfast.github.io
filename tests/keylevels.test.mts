import test from 'node:test';
import assert from 'node:assert/strict';
import { monthWindows } from '../src/app/traded/sessions.ts';
import { barMsFor, keyLines, lineEnd, neededFrom, statsOf, MAX_BACK_MS, type KeyLine, type PeriodLines } from '../src/app/keylevels/levels.ts';
import { KEY_LEVEL_DEFAULTS, anyLine, readKeyLevels } from '../src/app/keylevels/settings.ts';
import { placeTags } from '../src/app/keylevels/tags.ts';
import { KeyLevelHistory, historyTarget } from '../src/app/keylevels/history.ts';
import { codeOf, periodDate, rankOf } from '../src/app/keylevels/paint.ts';
import { BTC } from '../src/shared/coins.ts';
import { readCandles } from '../src/shared/history.ts';
import type { CandleRow } from '../src/app/store.ts';

const HOUR = 3_600_000, DAY = 86_400_000;
const D0 = Date.UTC(2026, 9, 5); // a Monday

/** Hourly bars from `from` for `hours`, each at `price(i)` with a range of ±`half` (overridden by `special`). */
function hourly(from: number, hours: number, price: (i: number) => number, half = 10, special: Record<number, [number, number]> = {}): CandleRow[] {
  return Array.from({ length: hours }, (_, i) => {
    const p = price(i), [lo, hi] = special[i] ?? [p - half, p + half];
    return [from + i * HOUR, p, hi, lo, p, 1] as CandleRow;
  });
}
const lines = (day: Partial<PeriodLines> = {}, week: Partial<PeriodLines> = {}, month: Partial<PeriodLines> = {}): Record<'day' | 'week' | 'month', PeriodLines> => {
  const none = { prev: false, mid: false, open: false, sofar: false };
  return { day: { ...none, ...day }, week: { ...none, ...week }, month: { ...none, ...month } };
};
const pick = (ls: readonly KeyLine[], f: (l: KeyLine) => boolean): KeyLine[] => ls.filter(f);

test('months start on the 1st at midnight in their zone, and a month whose clocks change is an hour longer or shorter', () => {
  const utc = monthWindows('UTC', Date.UTC(2026, 8, 15), Date.UTC(2026, 9, 9));
  assert.deepEqual(utc.map(w => [new Date(w.from).toISOString(), new Date(w.to).toISOString()]), [['2026-09-01T00:00:00.000Z', '2026-10-01T00:00:00.000Z'], ['2026-10-01T00:00:00.000Z', '2026-11-01T00:00:00.000Z']]);
  // New York leaves daylight saving on Sunday 1 November 2026 at 02:00: November begins at 04:00 UTC and December at 05:00 UTC.
  const ny = monthWindows('America/New_York', Date.UTC(2026, 10, 10), Date.UTC(2026, 10, 11));
  assert.equal(ny.length, 1);
  assert.equal(new Date(ny[0]!.from).toISOString(), '2026-11-01T04:00:00.000Z');
  assert.equal(new Date(ny[0]!.to).toISOString(), '2026-12-01T05:00:00.000Z');
  assert.equal(ny[0]!.to - ny[0]!.from, 30 * DAY + HOUR);
});

test('a period\'s open, high and low come from the bars that start inside it; it is complete when the history held reaches back to its start', () => {
  const bars = hourly(D0, 48, i => 100 + i, 10, { 5: [50, 120], 30: [90, 400] });
  const day1 = statsOf(bars, D0, D0 + DAY, D0)!;
  assert.deepEqual([day1.open, day1.high, day1.low, day1.complete], [100, 133, 50, true]);
  assert.equal(statsOf(bars, D0 + DAY, D0 + 2 * DAY, D0)!.high, 400);
  assert.equal(statsOf(bars.slice(3), D0, D0 + DAY, D0 + 3 * HOUR)!.complete, false, 'the history begins after its start: its first hours are unknown');
  // A quiet hour some exchanges send no bar for (Coinbase) is not a hole in what is known: the day is complete without it.
  const quiet = [...bars.slice(1, 20), ...bars.slice(30)];
  assert.deepEqual(statsOf(quiet, D0, D0 + DAY, D0), { open: 101, high: 129, low: 50, opened: true, complete: true });
  // The history stops at noon (the refreshes failed since): the day's open is known, its high and low are not.
  assert.deepEqual([statsOf(bars, D0, D0 + DAY, D0, D0 + 12 * HOUR)!.opened, statsOf(bars, D0, D0 + DAY, D0, D0 + 12 * HOUR)!.complete], [true, false]);
  const now = D0 + DAY + 3 * HOUR;
  const ls = keyLines(bars.slice(0, 12), lines({ prev: true }), { zone: 'UTC', t0: D0, t1: now, now, untouched: false, heldTo: D0 + 12 * HOUR });
  assert.equal(ls.length, 0, 'no previous-day lines from half a day');
  assert.equal(statsOf(bars, D0 + 5 * DAY, D0 + 6 * DAY, D0), null);
});

test('the candle size starts a bar on every period boundary: half an hour in India, a quarter in Nepal, half an hour in Lord Howe\'s summer', () => {
  const year = [Date.UTC(2026, 0, 1), Date.UTC(2026, 11, 31)] as const;
  assert.deepEqual(['UTC', 'America/New_York', 'Asia/Kolkata', 'Asia/Kathmandu', 'Australia/Lord_Howe'].map(z => barMsFor(z, ...year) / 60_000), [60, 60, 30, 15, 30]);
  // India: a day starts at 18:30 UTC. On half-hour bars the spike at 18:45 is the new day's, its open the 18:30 bar's.
  const start = Date.UTC(2026, 9, 3, 18, 30), half = 30 * 60_000;
  const bars: CandleRow[] = Array.from({ length: 3 * 48 }, (_, i) => [start + i * half, 100, 101, 99, 100, 1] as CandleRow);
  bars[48] = [start + DAY, 150, 200, 149, 150, 1]; // 18:30-19:00 UTC on the 4th: the first half hour of the 5th in India, with a spike at 18:45
  const now = start + 2 * DAY + HOUR;
  const ls = keyLines(bars, lines({ prev: true, open: true }), { zone: 'Asia/Kolkata', t0: start + DAY, t1: now, now, untouched: false });
  const day3 = pick(ls, l => l.from === start + 2 * DAY);
  assert.deepEqual(day3.map(l => [codeOf(l), l.price]), [['PDH', 200], ['PDL', 99], ['DO', 100]]);
  assert.deepEqual(pick(ls, l => l.from === start + DAY && l.what === 'open').map(l => l.price), [150], 'the day\'s open is its first half hour\'s');
});

test('over each day: the previous day\'s high, low and middle, the day\'s open, and the range so far of the day under way only', () => {
  // Three days; the third is under way (now is 10:30 on it). Day 1 trades 100 to 200; day 2 stays between 120 and 180.
  const bars = [...hourly(D0, 24, () => 150, 0, { 0: [100, 150], 12: [150, 200] }), ...hourly(D0 + DAY, 24, () => 150, 30), ...hourly(D0 + 2 * DAY, 11, () => 160, 5)];
  const now = D0 + 2 * DAY + 10.5 * HOUR;
  const ls = keyLines(bars, lines({ prev: true, mid: true, open: true, sofar: true }), { zone: 'UTC', t0: D0, t1: now + HOUR, now, untouched: false });
  const overDay2 = pick(ls, l => l.from === D0 + DAY);
  assert.deepEqual(overDay2.map(l => [codeOf(l), l.price]), [['PDH', 200], ['PDL', 100], ['PDM', 150], ['DO', 150]], 'day 1\'s levels across day 2, and day 2\'s open; no range so far for a day that has ended');
  assert.ok(overDay2.every(l => l.to === D0 + 2 * DAY));
  const overDay3 = pick(ls, l => l.from === D0 + 2 * DAY);
  assert.deepEqual(overDay3.map(l => [codeOf(l), l.price]), [['PDH', 180], ['PDL', 120], ['PDM', 150], ['DO', 160], ['DH', 165], ['DL', 155]]);
  assert.ok(overDay3.every(l => l.to === D0 + 3 * DAY), 'the day under way runs to its end, past the right edge');
  assert.equal(pick(ls, l => l.from === D0 && l.prev).length, 0, 'day 1 has no previous day in the candles: no levels over it');
});

test('an untouched level runs on until price reaches it, and to the right edge while it has not', () => {
  // Day 1 high 200; day 2 stays under it; day 3 reaches it at 05:00. Day 1 low 100 is never reached again.
  const bars = [...hourly(D0, 24, () => 150, 0, { 0: [100, 150], 12: [150, 200] }), ...hourly(D0 + DAY, 24, () => 150, 30), ...hourly(D0 + 2 * DAY, 11, () => 160, 5, { 5: [150, 205] })];
  const now = D0 + 2 * DAY + 10.5 * HOUR;
  const ls = keyLines(bars, lines({ prev: true }), { zone: 'UTC', t0: D0, t1: now + HOUR, now, untouched: true });
  const [high, low] = pick(ls, l => l.from === D0 + DAY);
  assert.equal(high!.reached, D0 + 2 * DAY + 5 * HOUR); assert.equal(lineEnd(high!), D0 + 2 * DAY + 5 * HOUR);
  assert.equal(low!.reached, null); assert.equal(lineEnd(low!), Infinity);
  assert.equal(high!.of, D0, 'the level is day 1\'s, drawn over day 2');
  assert.deepEqual([periodDate(D0, 'day', 'UTC'), periodDate(D0, 'month', 'UTC'), periodDate(D0, 'day', 'America/Los_Angeles')], ['Oct 5', 'Oct 2026', 'Oct 4'], 'named in its zone');
  const traded = pick(ls, l => l.from === D0 + 2 * DAY);
  assert.ok(traded.every(l => l.reached === undefined), 'over the day under way the lines run to the edge anyway');
});

test('a previous period with missing candles draws nothing, and periods follow their zone', () => {
  const bars = [...hourly(D0 + 6 * HOUR, 18, () => 150, 10), ...hourly(D0 + DAY, 24, () => 150, 10)];
  const now = D0 + 2 * DAY + HOUR;
  assert.equal(keyLines(bars, lines({ prev: true }), { zone: 'UTC', t0: D0, t1: now, now, untouched: false }).filter(l => l.from === D0 + DAY).length, 0, 'day 1 lacks its first six hours');
  // In Tokyo (UTC+9) a day starts at 15:00 UTC the day before.
  const tokyo = keyLines(hourly(D0 - DAY, 72, () => 150, 10), lines({ open: true }), { zone: 'Asia/Tokyo', t0: D0, t1: D0 + DAY, now: D0 + DAY, untouched: false });
  assert.ok(tokyo.length > 0 && tokyo.every(l => (l.from - Date.UTC(2026, 9, 4, 15)) % DAY === 0));
});

test('the week and the month have their own lines, each over its own period', () => {
  const start = Date.UTC(2026, 8, 1), now = Date.UTC(2026, 9, 9, 12);
  const bars = hourly(start, (now - start) / HOUR, i => 100 + (i % 50), 5);
  const ls = keyLines(bars, lines({}, { prev: true, open: true }, { prev: true }), { zone: 'UTC', t0: Date.UTC(2026, 9, 8), t1: now, now, untouched: false });
  const week = pick(ls, l => l.period === 'week' && l.from === Date.UTC(2026, 9, 5));
  assert.deepEqual(week.map(codeOf), ['PWH', 'PWL', 'WO']);
  const month = pick(ls, l => l.period === 'month');
  assert.deepEqual(month.map(l => [codeOf(l), l.from]), [['PMH', Date.UTC(2026, 9, 1)], ['PML', Date.UTC(2026, 9, 1)]], 'September\'s high and low over October');
});

test('the candles are needed from the earliest period a line could come from, never more than about two months back', () => {
  const now = D0 + 2 * DAY;
  const from = neededFrom(lines({ prev: true }), 'UTC', now - DAY, now);
  assert.ok(from <= now - 12 * DAY && from >= now - 14 * DAY, `${(now - from) / DAY} days`);
  assert.equal(from % DAY, 0, 'from a day\'s start');
  assert.equal(neededFrom(lines({}, {}, { prev: true }), 'UTC', now - DAY, now), now - MAX_BACK_MS);
  assert.equal(neededFrom(lines(), 'UTC', now - DAY, now), now, 'no lines: nothing needed');
});

test('axis tags keep their price: one that would cover a more important one, or the live price, is left out', () => {
  const kept = placeTags([{ key: 'PDH', y: 100, rank: 8 }, { key: 'PMH', y: 106, rank: 0 }, { key: 'DO', y: 300, rank: 9 }, { key: 'PDL', y: 500, rank: 8 }, { key: 'edge', y: 3, rank: 0 }], [{ y0: 491, y1: 509 }], 14, 600);
  assert.deepEqual(kept.map(k => [k.key, k.y]), [['PMH', 106], ['DO', 300]]);
});

test('settings are read field by field, and the codes and ranks follow the period and the line', () => {
  assert.deepEqual(readKeyLevels(null), KEY_LEVEL_DEFAULTS);
  assert.deepEqual(readKeyLevels('junk'), KEY_LEVEL_DEFAULTS);
  const read = readKeyLevels({ on: true, week: { prev: true, open: 'yes' }, labels: 0 });
  assert.equal(read.on, true); assert.deepEqual(read.week, { prev: true, mid: false, open: false, sofar: false }); assert.equal(read.labels, true);
  assert.equal(KEY_LEVEL_DEFAULTS.on, false, 'off until switched on');
  assert.ok(anyLine(KEY_LEVEL_DEFAULTS)); assert.ok(!anyLine({ ...KEY_LEVEL_DEFAULTS, day: { prev: false, mid: false, open: false, sofar: false } }));
  assert.deepEqual([codeOf({ period: 'week', what: 'mid', prev: true }), codeOf({ period: 'month', what: 'open', prev: false }), codeOf({ period: 'day', what: 'low', prev: false })], ['PWM', 'MO', 'DL']);
  assert.ok(rankOf({ period: 'month', what: 'open', prev: false }) < rankOf({ period: 'day', what: 'high', prev: true }), 'the month\'s before the day\'s');
  assert.ok(rankOf({ period: 'day', what: 'high', prev: true }) < rankOf({ period: 'day', what: 'mid', prev: true }));
});

test('the candles come from the chart\'s own market where its history can be read, else the first that lists the coin', () => {
  assert.deepEqual(historyTarget('binance:BTCUSDT:spot', BTC), { id: 'binancespot:BTCUSDT', listing: BTC.markets.binancespot!, own: true }, 'a server names Binance spot binance:BTCUSDT:spot');
  assert.equal(historyTarget('hyperliquid:BTC-PERP', BTC)!.own, true);
  const kraken = historyTarget('kraken:BTC/USD', BTC)!;
  assert.deepEqual([kraken.id, kraken.own], ['binance:BTCUSDT', false]);
  assert.equal(historyTarget('binance:BTCUSDT', { ...BTC, markets: {} }), null);
  // Another market of the chart's venue is not its own: OKX spot under `okx`, a coin-margined contract under `binance`.
  assert.deepEqual([historyTarget('okx:BTC-USDT', BTC)!.id, historyTarget('okx:BTC-USDT', BTC)!.own], ['binance:BTCUSDT', false]);
  assert.equal(historyTarget('binance:BTCUSD_PERP', BTC)!.own, false);
});

test('zoomed out over a year the lines are still today\'s: the newest days are kept, and nothing before the history is looked at', () => {
  const now = D0 + 3 * DAY + 5 * HOUR, bars = hourly(now - 70 * DAY, 70 * 24 + 5, () => 150, 10);
  const ls = keyLines(bars, lines({ prev: true }, { prev: true }), { zone: 'UTC', t0: now - 400 * DAY, t1: now + HOUR, now, untouched: false });
  assert.ok(ls.some(l => l.period === 'day' && l.from === D0 + 3 * DAY), 'today\'s');
  assert.ok(ls.some(l => l.period === 'week' && l.from === D0), 'this week\'s');
  assert.ok(ls.length < 200, `${ls.length} lines`);
});

test('a history that ends further back is not asked for more after the exchange said it has nothing older', async () => {
  let now = D0 + 10 * DAY;
  const asked: number[] = [];
  const get = async (url: string): Promise<unknown> => {
    const end = Number(new URL(url).searchParams.get('endTime')), first = now - 5 * DAY; // listed five days ago
    asked.push(end);
    const rows: unknown[] = [];
    for (let t = Math.floor(end / HOUR) * HOUR; t >= first && rows.length < Number(new URL(url).searchParams.get('limit') ?? 1500); t -= HOUR) rows.unshift([t, '100', '110', '90', '100', '1']);
    return rows;
  };
  const h = new KeyLevelHistory(get, () => now), target = historyTarget('binance:BTCUSDT', BTC)!;
  const settle = (): Promise<void> => new Promise(r => setTimeout(r, 0));
  h.ensure(target, now - 3 * DAY, HOUR, () => {}); await settle(); await settle();
  h.ensure(target, now - 9 * DAY, HOUR, () => {}); await settle(); await settle();
  assert.equal(asked.length, 2, 'further back: one page short of its limit, which says the history begins there');
  assert.equal(h.exhausted, true);
  for (const back of [10, 11, 12, 20]) { h.ensure(target, now - back * DAY, HOUR, () => {}); await settle(); }
  assert.equal(asked.length, 2, 'and never again');
  assert.equal(h.heldFrom, now - 5 * DAY);
});

test('a history longer than one request\'s pages is read in turns until it reaches back far enough, and bars past two months are dropped', async () => {
  // OKX: up to 300 bars a page, records before `after`; on five minutes 24 pages reach 25 days.
  let now = D0 + 10 * DAY, requests = 0;
  const Q = 5 * 60_000;
  const get = async (url: string): Promise<unknown> => {
    requests++;
    const q = new URL(url).searchParams, after = Number(q.get('after')), limit = Number(q.get('limit')), rows: unknown[] = [];
    for (let t = Math.floor((after - 1) / Q) * Q; rows.length < Math.min(300, limit) && t >= now - 200 * DAY; t -= Q) if (t < after) rows.push([String(t), '100', '110', '90', '100', '1', '1']);
    return { code: '0', data: rows };
  };
  const h = new KeyLevelHistory(get, () => now), target = historyTarget('okx:BTC-USDT-SWAP', BTC)!;
  const settle = async (): Promise<void> => { for (let i = 0; i < 40; i++) await new Promise(r => setTimeout(r, 0)); };
  h.ensure(target, now - 40 * DAY, Q, () => {}); await settle();
  assert.ok(h.heldFrom > now - 26 * DAY && h.heldFrom < now - 24 * DAY, `first turn: ${(now - h.heldFrom) / DAY} days`);
  h.ensure(target, now - 40 * DAY, Q, () => {}); await settle();
  assert.ok(h.heldFrom <= now - 40 * DAY, `second turn: ${(now - h.heldFrom) / DAY} days`);
  const asked = requests; h.ensure(target, now - 40 * DAY, Q, () => {}); await settle();
  assert.equal(requests, asked, 'there: nothing more is asked');
  // A month later the newest bars are asked again and the oldest, past what the levels can reach, are dropped.
  now += 30 * DAY; h.ensure(target, now - 40 * DAY, Q, () => {}); await settle();
  assert.ok(h.heldFrom >= now - MAX_BACK_MS - DAY, `${(now - h.heldFrom) / DAY} days held`);
  assert.ok(h.heldTo >= now - 1, 'held up to the request just made');
});

test('the history is asked once, then further back when the chart needs it, its newest hours every five minutes, and a minute after a failure', async () => {
  let now = D0 + 10 * DAY;
  const asked: [number, number][] = [];
  let fail = false;
  // Binance's klines: up to 1500 hourly rows ending at endTime, none before the listing's first hour (D0 - 30 days here).
  const get = async (url: string): Promise<unknown> => {
    if (fail) throw new Error('down');
    const end = Number(new URL(url).searchParams.get('endTime')), first = D0 - 30 * DAY;
    const rows: unknown[] = [];
    for (let t = Math.floor(end / HOUR) * HOUR; t >= first && rows.length < Number(new URL(url).searchParams.get('limit') ?? 1500); t -= HOUR) rows.unshift([t, '100', '110', '90', '100', '1']);
    asked.push([rows.length ? (rows[0] as number[])[0]! : end, end]);
    return rows;
  };
  const h = new KeyLevelHistory(get, () => now), target = historyTarget('binance:BTCUSDT', BTC)!;
  let loads = 0; const onLoad = (): void => { loads++; };
  const settle = (): Promise<void> => new Promise(r => setTimeout(r, 0));
  h.ensure(target, now - 3 * DAY, HOUR, onLoad); h.ensure(target, now - 3 * DAY, HOUR, onLoad);
  await settle(); await settle();
  assert.equal(asked.length, 1, 'one request while one is out'); assert.equal(loads, 1); assert.equal(h.state, 'ready');
  assert.ok(h.bars[0]![0] <= now - 3 * DAY && h.bars.length > 70);
  h.ensure(target, now - 3 * DAY, HOUR, onLoad); await settle();
  assert.equal(asked.length, 1, 'nothing new is needed');
  h.ensure(target, now - 20 * DAY, HOUR, onLoad); await settle(); await settle();
  assert.equal(asked.length, 2, 'further back'); assert.ok(h.bars[0]![0] <= now - 20 * DAY);
  now += 5 * 60_000; h.ensure(target, now - 20 * DAY, HOUR, onLoad); await settle(); await settle();
  assert.equal(asked.length, 3, 'the newest hours again'); assert.equal(h.bars[h.bars.length - 1]![0], Math.floor(now / HOUR) * HOUR);
  const version = h.version;
  fail = true; now += 5 * 60_000; h.ensure(target, now - 20 * DAY, HOUR, onLoad); await settle(); await settle();
  assert.equal(h.state, 'ready', 'a failed refresh keeps what is held');
  now += 30_000; h.ensure(target, now - 20 * DAY, HOUR, onLoad); await settle();
  assert.equal(h.version, version, 'not asked again within the minute');
  h.ensure(historyTarget('bybit:BTCUSDT', BTC), now - DAY, HOUR, () => {});
  assert.equal(h.bars.length, 0, 'another market starts again'); assert.equal(h.id, 'bybit:BTCUSDT');
});

test('VWAP history refresh asks for a few original-resolution bars and preserves the settled prefix', async () => {
  let now = D0 + 10 * DAY + HOUR / 2;
  const urls: URL[] = [], target = historyTarget('binance:BTCUSDT', BTC)!;
  const get = async (raw: string): Promise<unknown> => {
    const url = new URL(raw); urls.push(url);
    const limit = Number(url.searchParams.get('limit')), end = Math.floor(Number(url.searchParams.get('endTime')) / HOUR) * HOUR;
    return Array.from({ length: limit }, (_, i) => [end - (limit - i - 1) * HOUR, '100', '110', '90', '101', '2']);
  };
  const h = new KeyLevelHistory(get, () => now, 60_000), done = (): Promise<void> => new Promise(resolve => setTimeout(resolve, 0));
  h.ensure(target, now - 20 * DAY, HOUR, () => {}); await done(); await done();
  const first = h.bars[0]!, count = h.bars.length;
  assert.ok(count > 400);
  now += 61_000; h.ensure(target, now - 20 * DAY, HOUR, () => {}); await done(); await done();
  assert.equal(urls.length, 2);
  assert.ok(Number(urls[1]!.searchParams.get('limit')) <= 5, 'tail refresh requests a handful of bars instead of 1,500');
  assert.equal(urls[1]!.searchParams.get('interval'), '1h', 'VWAP keeps the original calculation interval');
  assert.deepEqual(h.bars[0], first, 'closed history is cached'); assert.equal(h.bars.length, count);
  h.ensure(target, now - 20 * DAY, HOUR, () => {}); await done(); assert.equal(urls.length, 2, 'a repeated window asks nothing');
});

test('whether the history reaches back to a time: yes once it does, coming while it can, never where the exchange has nothing older or cannot be read', async () => {
  let now = D0 + 10 * DAY, down = false;
  const get = async (url: string): Promise<unknown> => {
    if (down) throw new Error('down');
    const end = Number(new URL(url).searchParams.get('endTime')), first = now - 5 * DAY; // listed five days ago
    const rows: unknown[] = [];
    for (let t = Math.floor(end / HOUR) * HOUR; t >= first && rows.length < Number(new URL(url).searchParams.get('limit') ?? 1500); t -= HOUR) rows.unshift([t, '100', '110', '90', '100', '1']);
    return rows;
  };
  const h = new KeyLevelHistory(get, () => now), target = historyTarget('binance:BTCUSDT', BTC)!;
  const settle = (): Promise<void> => new Promise(r => setTimeout(r, 0));
  assert.equal(h.reach(now - DAY), 'coming', 'nothing asked yet');
  h.ensure(target, now - 3 * DAY, HOUR, () => {});
  assert.equal(h.reach(now - 3 * DAY), 'coming', 'a request is out');
  await settle(); await settle();
  assert.equal(h.reach(now - 3 * DAY), 'yes');
  assert.equal(h.reach(now - 9 * DAY), 'coming', 'not there, and it can still be asked for');
  h.ensure(target, now - 9 * DAY, HOUR, () => {}); await settle(); await settle();
  h.ensure(target, now - 9 * DAY, HOUR, () => {}); await settle(); await settle();
  assert.equal(h.reach(now - 9 * DAY), 'never', 'the exchange said it has nothing older');
  assert.equal(h.reach(now - 4 * DAY), 'yes');
  // An exchange that cannot be read: nothing is held, and nothing is coming.
  const dead = new KeyLevelHistory(get, () => now); down = true;
  dead.ensure(target, now - 3 * DAY, HOUR, () => {}); await settle(); await settle();
  assert.equal(dead.state, 'unavailable'); assert.equal(dead.reach(now - 3 * DAY), 'never');
  // Bars held and the walk back failing: not coming until the minute's wait is over.
  down = false;
  const part = new KeyLevelHistory(get, () => now);
  part.ensure(target, now - 3 * DAY, HOUR, () => {}); await settle(); await settle();
  down = true; part.ensure(target, now - 4.5 * DAY, HOUR, () => {}); await settle(); await settle();
  assert.equal(part.reach(now - 4.5 * DAY), 'never', 'a failed try waits a minute');
  now += 61_000; assert.equal(part.reach(now - 4.5 * DAY), 'coming', 'then it is asked again');
});

test('what the history says while its answer is being told is that answer, not "a request is out"', async () => {
  const now = D0 + 10 * DAY;
  let down = false;
  const get = async (url: string): Promise<unknown> => {
    if (down) throw new Error('down');
    const end = Number(new URL(url).searchParams.get('endTime')), first = now - 5 * DAY;
    const rows: unknown[] = [];
    for (let t = Math.floor(end / HOUR) * HOUR; t >= first && rows.length < Number(new URL(url).searchParams.get('limit') ?? 1500); t -= HOUR) rows.unshift([t, '100', '110', '90', '100', '1']);
    return rows;
  };
  const h = new KeyLevelHistory(get, () => now), target = historyTarget('binance:BTCUSDT', BTC)!;
  const settle = (): Promise<void> => new Promise(r => setTimeout(r, 0));
  let said = '';
  h.ensure(target, now - 3 * DAY, HOUR, () => { said = h.reach(now - 3 * DAY); }); await settle(); await settle();
  assert.equal(said, 'yes');
  down = true;
  h.ensure(target, now - 4.5 * DAY, HOUR, () => { said = h.reach(now - 4.5 * DAY); }); await settle(); await settle();
  assert.equal(said, 'never', 'told after a failure: the minute\'s wait, which a panel shows at once');
});

test('a request started from inside an answer\'s callback is the only one out: the first one settling does not clear its flag', async () => {
  const now = D0 + 10 * DAY;
  let inFlight = 0, most = 0, asked = 0;
  const get = async (url: string): Promise<unknown> => {
    asked++; inFlight++; most = Math.max(most, inFlight);
    await new Promise(r => setTimeout(r, 5));
    inFlight--;
    const end = Number(new URL(url).searchParams.get('endTime')), first = now - 30 * DAY;
    const rows: unknown[] = [];
    for (let t = Math.floor(end / HOUR) * HOUR; t >= first && rows.length < Number(new URL(url).searchParams.get('limit') ?? 1500); t -= HOUR) rows.unshift([t, '100', '110', '90', '100', '1']);
    return rows;
  };
  const h = new KeyLevelHistory(get, () => now), target = historyTarget('binance:BTCUSDT', BTC)!;
  const wait = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms));
  let again = true;
  h.ensure(target, now - 3 * DAY, HOUR, () => { if (again) { again = false; h.ensure(target, now - 9 * DAY, HOUR, () => {}); } });
  for (let k = 0; k < 6; k++) { await wait(2); h.ensure(target, now - 12 * DAY, HOUR, () => {}); }
  await wait(40);
  assert.equal(most, 1, 'never two requests out at once');
  assert.ok(asked >= 2);
});

test('a stretch nobody traded in is known once a read has answered for it: lines reach into it, and it is not asked again (Sol, 2026-11-10)', async () => {
  // Coinbase answers for windows of 300 hours; the market did not trade between 30 and 10 days back.
  const now = D0 + 40 * DAY;
  let asked = 0;
  const get = async (url: string): Promise<unknown> => {
    asked++;
    const q = new URL(url).searchParams, start = Date.parse(q.get('start')!), end = Date.parse(q.get('end')!), rows: unknown[] = [];
    for (let t = Math.floor(end / HOUR) * HOUR; t >= start; t -= HOUR) if (t >= now - 10 * DAY || t < now - 30 * DAY) rows.push([t / 1000, 99, 101, 100, 100.5, 1]);
    return rows;
  };
  const h = new KeyLevelHistory(get, () => now), target = historyTarget('coinbase:BTC-USD', BTC)!;
  const settle = async (): Promise<void> => { for (let i = 0; i < 40; i++) await new Promise(r => setTimeout(r, 0)); };
  h.ensure(target, now - 5 * DAY, HOUR, () => {}); await settle();
  h.ensure(target, now - 20 * DAY, HOUR, () => {}); await settle();
  assert.equal(h.heldFrom, now - 10 * DAY, 'no bar before the quiet stretch was asked for');
  assert.ok(h.knownFrom <= now - 20 * DAY, 'but the stretch is known');
  assert.equal(h.reach(now - 20 * DAY), 'yes');
  assert.equal(h.exhausted, false, 'quiet is not the start of the history');
  const before = asked; h.ensure(target, now - 20 * DAY, HOUR, () => {}); await settle();
  assert.equal(asked, before, 'not asked again');
});

test('an error answered with HTTP 200 is a failed read: it never says the history begins there, and it is tried again a minute later', async () => {
  let now = D0 + 10 * DAY, limited = false;
  const get = async (url: string): Promise<unknown> => {
    const q = new URL(url).searchParams, end = Number(q.get('end')), limit = Number(q.get('limit'));
    if (limited) return { retCode: 10006, retMsg: 'Too many visits!', result: {} };
    return { retCode: 0, result: { list: Array.from({ length: limit }, (_, i) => [String(Math.floor(end / HOUR) * HOUR - i * HOUR), '100', '101', '99', '100', '1']) } };
  };
  const h = new KeyLevelHistory(get, () => now), target = historyTarget('bybit:BTCUSDT', BTC)!;
  const settle = async (): Promise<void> => { for (let i = 0; i < 20; i++) await new Promise(r => setTimeout(r, 0)); };
  h.ensure(target, now - 2 * DAY, HOUR, () => {}); await settle();
  limited = true; h.ensure(target, now - 8 * DAY, HOUR, () => {}); await settle();
  assert.equal(h.exhausted, false); assert.equal(h.reach(now - 8 * DAY), 'never', 'not within the minute');
  limited = false; now += 61_000; h.ensure(target, now - 8 * DAY, HOUR, () => {}); await settle();
  assert.equal(h.reach(now - 8 * DAY), 'yes', 'read once the venue answers again');
});

test('time a page answered for but whose bars were let go is not known: a page of only older bars covers no further back than the bars kept (Sol, code review 2026-11-10)', async () => {
  // Binance-shaped: bars until 10 days back, then nothing until 2 days back. Asked from 5 days back, the newest page before the quiet stretch
  // holds only bars older than that, which the read does not keep.
  const now = D0 + 40 * DAY;
  const get = async (url: string): Promise<unknown> => {
    const q = new URL(url).searchParams, end = Number(q.get('endTime')), limit = Number(q.get('limit') ?? 1500), rows: unknown[] = [];
    for (let t = Math.floor(end / HOUR) * HOUR; rows.length < limit && t >= now - 60 * DAY; t -= HOUR) if (t < now - 10 * DAY || t >= now - 2 * DAY) rows.unshift([t, '100', '110', '90', '100', '1']);
    return rows;
  };
  const read = await readCandles('binance:BTCUSDT', HOUR, now - 5 * DAY, now - 2 * DAY - 1, get, undefined, 12, { pageSize: 1500 });
  assert.equal(read.rows.length, 0, 'the older bars are not kept');
  assert.equal(read.coveredFrom, now - 5 * DAY - HOUR, 'so the time is known only from the start asked (and its interval)');
});

test('a history is never asked again and again for what is older than it keeps (Sol, code review 2026-11-10)', async () => {
  let now = D0 + 40 * DAY, asked = 0;
  const get = async (url: string): Promise<unknown> => {
    asked++;
    const q = new URL(url).searchParams, end = Number(q.get('endTime')), limit = Number(q.get('limit') ?? 1500), rows: unknown[] = [];
    for (let t = Math.floor(end / HOUR) * HOUR; rows.length < limit && t >= now - 60 * DAY; t -= HOUR) rows.unshift([t, '100', '110', '90', '100', '1']);
    return rows;
  };
  // Twelve hours kept (as the liquidation levels' candles): asked from three days back, as a stale snapshot would.
  const h = new KeyLevelHistory(get, () => now, 60_000, 12 * HOUR), target = historyTarget('binance:BTCUSDT', BTC)!;
  const settle = async (): Promise<void> => { for (let i = 0; i < 20; i++) await new Promise(r => setTimeout(r, 0)); };
  h.ensure(target, now - 3 * DAY, HOUR, () => {}); await settle();
  const first = asked;
  for (let k = 0; k < 6; k++) { h.ensure(target, now - 3 * DAY, HOUR, () => {}); await settle(); }
  assert.equal(asked, first, 'no walk back past what it keeps');
  assert.equal(h.reach(now - 3 * DAY), 'never', 'and it says it will never hold that');
  now += 61_000; h.ensure(target, now - 3 * DAY, HOUR, () => {}); await settle();
  assert.equal(asked, first + 1, 'only the newest bars, a minute later');
});

test('where a market\'s trading begins stays where the read found it when old bars are let go (Sol, code review 2026-11-10, round 4)', async () => {
  let now = D0 + 10 * DAY;
  const listed = now - 5 * DAY;
  const get = async (url: string): Promise<unknown> => {
    const end = Number(new URL(url).searchParams.get('endTime')), limit = Number(new URL(url).searchParams.get('limit') ?? 1500);
    const rows: unknown[] = [];
    for (let t = Math.floor(end / HOUR) * HOUR; t >= listed && rows.length < limit; t -= HOUR) rows.unshift([t, '100', '110', '90', '100', '1']);
    return rows;
  };
  // Bars kept six days back (and a day): the listing, five days back, is within reach.
  const h = new KeyLevelHistory(get, () => now, 60_000, 6 * DAY), target = historyTarget('binance:BTCUSDT', BTC)!;
  const settle = (): Promise<void> => new Promise(r => setTimeout(r, 0));
  h.ensure(target, now - 6 * DAY, HOUR, () => {}); await settle(); await settle();
  assert.equal(h.exhausted, true);
  assert.equal(h.listedFrom, listed);
  assert.equal(h.heldFrom, listed);
  // Four days on, the bars older than the history keeps are let go at the next read: the first bar held moves on, the listing does not.
  now += 4 * DAY;
  h.ensure(target, now - 2 * DAY, HOUR, () => {}); await settle(); await settle();
  assert.ok(h.heldFrom > listed, 'old bars let go');
  assert.equal(h.listedFrom, listed, 'the market traded between its listing and the first bar held: not before it');
  const fresh = new KeyLevelHistory(get, () => now, 60_000, 6 * DAY);
  assert.equal(fresh.listedFrom, null, 'not known before a read says so');
});
