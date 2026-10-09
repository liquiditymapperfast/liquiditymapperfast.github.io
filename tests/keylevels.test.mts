import test from 'node:test';
import assert from 'node:assert/strict';
import { monthWindows } from '../src/app/traded/sessions.ts';
import { keyLines, lineEnd, neededFrom, statsOf, MAX_BACK_MS, type KeyLine, type PeriodLines } from '../src/app/keylevels/levels.ts';
import { KEY_LEVEL_DEFAULTS, anyLine, readKeyLevels } from '../src/app/keylevels/settings.ts';
import { placeTags } from '../src/app/keylevels/tags.ts';
import { KeyLevelHistory, historyTarget } from '../src/app/keylevels/history.ts';
import { codeOf, periodDate, rankOf } from '../src/app/keylevels/paint.ts';
import { BTC } from '../src/shared/coins.ts';
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

test('a period\'s open, high and low come from the bars that start inside it; it is complete when they hold its first and last hours', () => {
  const bars = hourly(D0, 48, i => 100 + i, 10, { 5: [50, 120], 30: [90, 400] });
  const day1 = statsOf(bars, D0, D0 + DAY, D0 + 3 * DAY)!;
  assert.deepEqual([day1.open, day1.high, day1.low, day1.opened, day1.complete], [100, 133, 50, true, true]);
  assert.equal(statsOf(bars, D0 + DAY, D0 + 2 * DAY, D0 + 3 * DAY)!.high, 400);
  const late = statsOf(bars.slice(3), D0, D0 + DAY, D0 + 3 * DAY)!;
  assert.equal(late.opened, false, 'its first hours are missing: the open is not its own'); assert.equal(late.complete, false);
  const underWay = statsOf(bars.slice(0, 30), D0 + DAY, D0 + 2 * DAY, D0 + 29.5 * HOUR)!;
  assert.equal(underWay.complete, true, 'the period under way is complete up to now');
  assert.equal(statsOf(bars, D0 + 5 * DAY, D0 + 6 * DAY, D0 + 7 * DAY), null);
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
  assert.deepEqual(historyTarget('binance:BTCUSDT:spot', BTC.markets), { id: 'binancespot:BTCUSDT', listing: BTC.markets.binancespot, own: true }, 'a server names Binance spot binance:BTCUSDT:spot');
  assert.equal(historyTarget('hyperliquid:BTC-PERP', BTC.markets)!.own, true);
  const kraken = historyTarget('kraken:BTC/USD', BTC.markets)!;
  assert.deepEqual([kraken.id, kraken.own], ['binance:BTCUSDT', false]);
  assert.equal(historyTarget('binance:BTCUSDT', {}), null);
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
    for (let t = Math.floor(end / HOUR) * HOUR; t >= first && rows.length < 1500; t -= HOUR) rows.unshift([t, '100', '110', '90', '100', '1']);
    asked.push([rows.length ? (rows[0] as number[])[0]! : end, end]);
    return rows;
  };
  const h = new KeyLevelHistory(get, () => now), target = historyTarget('binance:BTCUSDT', BTC.markets)!;
  let loads = 0; const onLoad = (): void => { loads++; };
  const settle = (): Promise<void> => new Promise(r => setTimeout(r, 0));
  h.ensure(target, now - 3 * DAY, onLoad); h.ensure(target, now - 3 * DAY, onLoad);
  await settle(); await settle();
  assert.equal(asked.length, 1, 'one request while one is out'); assert.equal(loads, 1); assert.equal(h.state, 'ready');
  assert.ok(h.bars[0]![0] <= now - 3 * DAY && h.bars.length > 70);
  h.ensure(target, now - 3 * DAY, onLoad); await settle();
  assert.equal(asked.length, 1, 'nothing new is needed');
  h.ensure(target, now - 20 * DAY, onLoad); await settle(); await settle();
  assert.equal(asked.length, 2, 'further back'); assert.ok(h.bars[0]![0] <= now - 20 * DAY);
  now += 5 * 60_000; h.ensure(target, now - 20 * DAY, onLoad); await settle(); await settle();
  assert.equal(asked.length, 3, 'the newest hours again'); assert.equal(h.bars[h.bars.length - 1]![0], Math.floor(now / HOUR) * HOUR);
  const version = h.version;
  fail = true; now += 5 * 60_000; h.ensure(target, now - 20 * DAY, onLoad); await settle(); await settle();
  assert.equal(h.state, 'ready', 'a failed refresh keeps what is held');
  now += 30_000; h.ensure(target, now - 20 * DAY, onLoad); await settle();
  assert.equal(h.version, version, 'not asked again within the minute');
  h.ensure(historyTarget('bybit:BTCUSDT', BTC.markets), now - DAY, () => {});
  assert.equal(h.bars.length, 0, 'another market starts again'); assert.equal(h.id, 'bybit:BTCUSDT');
});
