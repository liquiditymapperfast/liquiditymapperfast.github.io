import test from 'node:test';
import assert from 'node:assert/strict';
import { ANCHOR_PERIODS, ANCHOR_POINTS, extremeBar, freeSlot, periodStart, readAnchor, resolveRule, ruleKey, ruleCode, ruleName, ruleOf, ruleSpan, searchBarMs, type AnchorRule } from '../src/app/anchors/anchors.ts';
import type { CandleRow } from '../src/app/store.ts';

const MIN = 60_000, HOUR = 3_600_000, DAY = 86_400_000;
const bar = (t: number, high: number, low: number): CandleRow => [t, (high + low) / 2, high, low, (high + low) / 2, 1];

test('a period starts at midnight, on Monday, on the first of a month, of a quarter, of a year, in the zone', () => {
  const t = Date.UTC(2026, 10, 11, 15, 30); // Wednesday 11 November 2026, 15:30 UTC
  assert.equal(periodStart('day', 'UTC', t), Date.UTC(2026, 10, 11));
  assert.equal(periodStart('week', 'UTC', t), Date.UTC(2026, 10, 9), 'Monday the 9th');
  assert.equal(periodStart('month', 'UTC', t), Date.UTC(2026, 10, 1));
  assert.equal(periodStart('quarter', 'UTC', t), Date.UTC(2026, 9, 1), 'October: the fourth quarter');
  assert.equal(periodStart('year', 'UTC', t), Date.UTC(2026, 0, 1));
  // New York: the day starts at local midnight, 05:00 UTC in November (EST), 04:00 UTC in July (EDT).
  assert.equal(periodStart('day', 'America/New_York', t), Date.UTC(2026, 10, 11, 5));
  assert.equal(periodStart('month', 'America/New_York', Date.UTC(2026, 6, 15, 12)), Date.UTC(2026, 6, 1, 4));
  assert.equal(periodStart('year', 'America/New_York', Date.UTC(2026, 0, 1, 3)), Date.UTC(2025, 0, 1, 5), 'still 31 December there');
});

test('a previous period is the whole one before, also on 2 January and on the first of a month', () => {
  const jan2 = Date.UTC(2027, 0, 2, 10);
  assert.deepEqual(ruleSpan({ period: 'year', point: 'prevHigh' }, 'UTC', jan2), { from: Date.UTC(2026, 0, 1), to: Date.UTC(2027, 0, 1) });
  assert.deepEqual(ruleSpan({ period: 'year', point: 'high' }, 'UTC', jan2), { from: Date.UTC(2027, 0, 1), to: jan2 }, 'so far: a day and ten hours');
  const first = Date.UTC(2026, 11, 1, 0, 5);
  assert.deepEqual(ruleSpan({ period: 'month', point: 'prevLow' }, 'UTC', first), { from: Date.UTC(2026, 10, 1), to: Date.UTC(2026, 11, 1) });
  assert.deepEqual(ruleSpan({ period: 'quarter', point: 'prevHigh' }, 'UTC', Date.UTC(2026, 9, 1, 1)), { from: Date.UTC(2026, 6, 1), to: Date.UTC(2026, 9, 1) });
});

test('the extreme is the highest high or lowest low that starts in the stretch, the earliest of equal ones', () => {
  const bars = [bar(0, 10, 5), bar(HOUR, 12, 6), bar(2 * HOUR, 12, 4), bar(3 * HOUR, 11, 4), bar(4 * HOUR, 20, 1)];
  assert.equal(extremeBar(bars, 0, 4 * HOUR, true)![0], HOUR, 'two highs of 12: the earlier');
  assert.equal(extremeBar(bars, 0, 4 * HOUR, false)![0], 2 * HOUR, 'two lows of 4: the earlier');
  assert.equal(extremeBar(bars, 5 * HOUR, 6 * HOUR, true), null);
});

test('a rule resolves to the very minute of the extreme, and a replay never reads ahead of its moment', () => {
  const zone = 'UTC', monday = Date.UTC(2026, 10, 9), now = monday + 2 * DAY + 13 * HOUR + 20 * MIN; // Wednesday 13:20
  const barMs = searchBarMs('week', HOUR);
  assert.equal(barMs, 15 * MIN);
  const coarse: CandleRow[] = [];
  for (let t = monday; t <= now; t += barMs) coarse.push(bar(t, 100, 90));
  coarse[20] = bar(coarse[20]![0], 130, 95);                 // Monday 05:00, the week's high so far
  coarse[coarse.length - 1] = bar(coarse.at(-1)![0], 140, 92); // the bar under way, 13:15: higher still
  const minutes = (from: number): CandleRow[] => Array.from({ length: 15 }, (_, k) => bar(from + k * MIN, k === 3 ? 1_000 : 99, 91));
  const fine = (from: number, to: number): CandleRow[] => minutes(from).filter(b => b[0] < to);
  const high: AnchorRule = { period: 'week', point: 'high' };
  assert.deepEqual(resolveRule(high, zone, now, false, { bars: coarse, barMs, knownFrom: monday }, fine), { state: 'ready', at: coarse.at(-1)![0] + 3 * MIN }, 'live: the bar under way counts, to its minute');
  // In a replay at 13:20 the bar under way is not known yet: Monday 05:00's high stands, to its minute.
  assert.deepEqual(resolveRule(high, zone, now, true, { bars: coarse, barMs, knownFrom: monday }, fine), { state: 'ready', at: coarse[20]![0] + 3 * MIN });
  assert.deepEqual(resolveRule(high, zone, now, false, { bars: coarse, barMs, knownFrom: monday }, () => null), { state: 'coming' }, 'minutes on their way: not drawn yet, never the coarse start passed off as exact');
  assert.deepEqual(resolveRule(high, zone, now, false, { bars: coarse, barMs, knownFrom: monday }, () => false), { state: 'failed' }, 'minutes that could not be read: said');
  assert.deepEqual(resolveRule(high, zone, now, false, { bars: coarse, barMs, knownFrom: monday }, () => []), { state: 'ready', at: coarse.at(-1)![0], approx: true }, 'no minutes there at all: the candle\'s start, said as approximate');
  assert.deepEqual(resolveRule(high, zone, now, false, { bars: coarse, barMs, knownFrom: monday + HOUR }, fine), { state: 'coming' }, 'candles not back to Monday yet');
  assert.deepEqual(resolveRule(high, zone, now, false, null, fine), { state: 'coming' });
  assert.deepEqual(resolveRule({ period: 'week', point: 'start' }, zone, now, false, null, fine), { state: 'ready', at: monday }, 'a start needs no candles');
  assert.deepEqual(resolveRule(high, zone, now, false, { bars: [], barMs, knownFrom: 0 }, fine), { state: 'none' });
  // A history that failed, or that its exchange cuts short of the period's start (Hyperliquid's newest 5,000 bars), says so.
  assert.deepEqual(resolveRule(high, zone, now, false, { bars: coarse, barMs, knownFrom: monday + HOUR, failed: true }, fine), { state: 'failed' });
  assert.deepEqual(resolveRule(high, zone, now, false, { bars: coarse, barMs, knownFrom: monday + HOUR, limited: true }, fine), { state: 'short', from: monday + HOUR });
  assert.deepEqual(resolveRule(high, zone, now, false, { bars: [], barMs, knownFrom: Infinity, failed: true }, fine), { state: 'failed' });
});

test('a previous period\'s high or low is searched in that period only: the next one\'s first candle is not part of it (live and replay)', () => {
  const zone = 'UTC', today = Date.UTC(2026, 10, 11), now = today + 3 * HOUR + 10 * MIN, barMs = searchBarMs('day', HOUR);
  const coarse: CandleRow[] = [];
  for (let t = today - DAY; t < now; t += barMs) coarse.push(bar(t, 100, 90));
  coarse[56] = bar(coarse[56]![0], 100.5, 89);                    // yesterday 14:00: its high and its low
  const at0 = coarse.findIndex(b => b[0] === today);
  coarse[at0] = bar(today, 105, 80);                              // today's first candle breaks both
  const fine = (from: number, to: number): CandleRow[] => Array.from({ length: 15 }, (_, k) => bar(from + k * MIN, k === 7 ? 1_000 : 99, k === 7 ? 1 : 91)).filter(b => b[0] < to);
  for (const replay of [false, true]) {
    assert.deepEqual(resolveRule({ period: 'day', point: 'prevHigh' }, zone, now, replay, { bars: coarse, barMs, knownFrom: today - DAY }, fine), { state: 'ready', at: coarse[56]![0] + 7 * MIN }, `yesterday's high (replay ${replay})`);
    assert.deepEqual(resolveRule({ period: 'day', point: 'prevLow' }, zone, now, replay, { bars: coarse, barMs, knownFrom: today - DAY }, fine), { state: 'ready', at: coarse[56]![0] + 7 * MIN }, `yesterday's low (replay ${replay})`);
  }
  assert.deepEqual(resolveRule({ period: 'day', point: 'high' }, zone, now, false, { bars: coarse, barMs, knownFrom: today - DAY }, fine), { state: 'ready', at: today + 7 * MIN }, 'today\'s high so far is today\'s');
});

test('every rule of the grid has a name, a chart code and a key it is found by again', () => {
  const rules = ANCHOR_PERIODS.flatMap(period => ANCHOR_POINTS.map(point => ({ period, point })));
  assert.equal(rules.length, 25, 'each of five periods: its start, its high and low so far, the previous one\'s high and low');
  const names = new Set<string>(), codes = new Set<string>();
  for (const r of rules) { assert.ok(ruleName(r).length > 3); assert.deepEqual(ruleOf(ruleKey(r)), r); names.add(ruleName(r)); codes.add(ruleCode(r)); }
  assert.equal(names.size, 25, 'no two rules share a name'); assert.equal(codes.size, 25, 'nor a code');
  assert.equal(ruleOf('day|middle'), null); assert.equal(ruleOf('decade|high'), null);
  assert.equal(ruleName({ period: 'month', point: 'prevLow' }), 'Previous month low');
  assert.equal(ruleCode({ period: 'week', point: 'prevHigh' }), 'PWH'); assert.equal(ruleCode({ period: 'year', point: 'start' }), 'YO');
});

test('an anchor saved as a bare time is read as a fixed one at that very time; others field by field', () => {
  assert.deepEqual(readAnchor(1_788_339_600_000, 2), { id: 't1788339600000', at: 1_788_339_600_000, slot: 2 });
  assert.deepEqual(readAnchor({ id: 'abc', rule: { period: 'year', point: 'high' }, slot: 3, color: '#A78BFA', hidden: true }, 0), { id: 'abc', rule: { period: 'year', point: 'high' }, slot: 3, color: '#a78bfa', hidden: true });
  assert.deepEqual(readAnchor({ id: 'x', at: 5, slot: 1, color: 'red' }, 0), { id: 'x', at: 5, slot: 1 }, 'a colour that is not #rrggbb is left out');
  assert.equal(readAnchor({ rule: { period: 'day', point: 'middle' } }, 0), null, 'a rule not offered');
  assert.equal(readAnchor({ rule: { period: 'decade', point: 'high' } }, 0), null);
  assert.deepEqual(readAnchor({ rule: { period: 'day', point: 'high' } }, 0), { id: 't0dayhigh', rule: { period: 'day', point: 'high' }, slot: 0 }, 'a day offers its highs and lows too');
  assert.equal(readAnchor('soon', 0), null);
  assert.equal(readAnchor(-1, 0), null);
  assert.equal(freeSlot([{ slot: 0 }, { slot: 2 }]), 1, 'the lowest slot free: the others keep theirs');
});

test('minutes that begin inside the winning candle and miss its extreme give its start as approximate, never a lesser extreme as exact', () => {
  const zone = 'UTC', monday = Date.UTC(2026, 10, 9), now = monday + 2 * DAY + 13 * HOUR + 20 * MIN, barMs = 15 * MIN;
  const coarse: CandleRow[] = [];
  for (let t = monday; t <= now; t += barMs) coarse.push(bar(t, 100, 90));
  coarse[20] = bar(coarse[20]![0], 200, 95);  // Monday 05:00: the week's high so far, 200
  const high: AnchorRule = { period: 'week', point: 'high' }, at = coarse[20]![0];
  // An exchange whose minutes begin at 05:08 (its reach ends there): they peak at 105, not at the candle's 200.
  const late = (from: number, to: number): CandleRow[] => Array.from({ length: 15 }, (_, k) => bar(from + k * MIN, k === 9 ? 105 : 99, 91)).filter(b => b[0] >= at + 8 * MIN && b[0] < to);
  assert.deepEqual(resolveRule(high, zone, now, false, { bars: coarse, barMs, knownFrom: monday }, late), { state: 'ready', at, approx: true });
  // The minutes holding the 200: that minute, exact.
  const whole = (from: number, to: number): CandleRow[] => Array.from({ length: 15 }, (_, k) => bar(from + k * MIN, k === 4 ? 200 : 99, 91)).filter(b => b[0] < to);
  assert.deepEqual(resolveRule(high, zone, now, false, { bars: coarse, barMs, knownFrom: monday }, whole), { state: 'ready', at: at + 4 * MIN });
  // A low the same way.
  coarse[30] = bar(coarse[30]![0], 100, 10);
  const low: AnchorRule = { period: 'week', point: 'low' }, lowAt = coarse[30]![0];
  const lateLow = (from: number, to: number): CandleRow[] => Array.from({ length: 15 }, (_, k) => bar(from + k * MIN, 99, k === 12 ? 50 : 91)).filter(b => b[0] >= lowAt + 10 * MIN && b[0] < to);
  assert.deepEqual(resolveRule(low, zone, now, false, { bars: coarse, barMs, knownFrom: monday }, lateLow), { state: 'ready', at: lowAt, approx: true });
  // The candle under way: its minutes can be newer than it, so they are taken as they say.
  coarse[coarse.length - 1] = bar(coarse.at(-1)![0], 300, 92);
  const live = (from: number, to: number): CandleRow[] => Array.from({ length: 15 }, (_, k) => bar(from + k * MIN, k === 2 ? 250 : 99, 91)).filter(b => b[0] < to);
  assert.deepEqual(resolveRule(high, zone, now, false, { bars: coarse, barMs, knownFrom: monday }, live), { state: 'ready', at: coarse.at(-1)![0] + 2 * MIN });
});
