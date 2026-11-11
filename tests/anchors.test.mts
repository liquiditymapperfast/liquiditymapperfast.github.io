import test from 'node:test';
import assert from 'node:assert/strict';
import { ANCHOR_PRESETS, extremeBar, freeSlot, periodStart, readAnchor, resolveRule, ruleKey, ruleName, ruleOf, ruleSpan, searchBarMs, type AnchorRule } from '../src/app/anchors/anchors.ts';
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
  assert.deepEqual(resolveRule(high, zone, now, false, { bars: coarse, barMs, knownFrom: monday }, () => null), { state: 'ready', at: coarse.at(-1)![0] }, 'minutes on their way: the coarse bar\'s start');
  assert.deepEqual(resolveRule(high, zone, now, false, { bars: coarse, barMs, knownFrom: monday + HOUR }, fine), { state: 'coming' }, 'candles not back to Monday yet');
  assert.deepEqual(resolveRule(high, zone, now, false, null, fine), { state: 'coming' });
  assert.deepEqual(resolveRule({ period: 'week', point: 'start' }, zone, now, false, null, fine), { state: 'ready', at: monday }, 'a start needs no candles');
  assert.deepEqual(resolveRule(high, zone, now, false, { bars: [], barMs, knownFrom: 0 }, fine), { state: 'none' });
});

test('every rule offered has a name and a key it is found by again', () => {
  const rules = ANCHOR_PRESETS.flatMap(g => g.rules);
  assert.equal(rules.length, 21, 'five starts; the highs and lows so far and previous of week, month, quarter and year');
  for (const r of rules) { assert.ok(ruleName(r).length > 3); assert.deepEqual(ruleOf(ruleKey(r)), r); }
  assert.equal(ruleOf('day|high'), null, 'a day offers its start only');
  assert.equal(ruleName({ period: 'month', point: 'prevLow' }), 'Previous month low');
});

test('an anchor saved as a bare time is read as a fixed one at that very time; others field by field', () => {
  assert.deepEqual(readAnchor(1_788_339_600_000, 2), { id: 't1788339600000', at: 1_788_339_600_000, slot: 2 });
  assert.deepEqual(readAnchor({ id: 'abc', rule: { period: 'year', point: 'high' }, slot: 3, color: '#A78BFA', hidden: true }, 0), { id: 'abc', rule: { period: 'year', point: 'high' }, slot: 3, color: '#a78bfa', hidden: true });
  assert.deepEqual(readAnchor({ id: 'x', at: 5, slot: 1, color: 'red' }, 0), { id: 'x', at: 5, slot: 1 }, 'a colour that is not #rrggbb is left out');
  assert.equal(readAnchor({ rule: { period: 'day', point: 'high' } }, 0), null, 'a rule not offered');
  assert.equal(readAnchor('soon', 0), null);
  assert.equal(readAnchor(-1, 0), null);
  assert.equal(freeSlot([{ slot: 0 }, { slot: 2 }]), 1, 'the lowest slot free: the others keep theirs');
});
