import test from 'node:test';
import assert from 'node:assert/strict';
import { ANCHOR_REACH_MS, ROLLING_MAX_BARS, anchorBars, candleStartAt, mergeVwapBars, rollingBarMs, rollingFrom, rollingSeries as rollingOf, sessionsOf, vwapBarMs, vwapBarsOf, vwapSeries as vwapOf } from '../src/app/vwap/vwap.ts';
import { MAX_ANCHORS, ROLLING_DAYS, VWAP_DEFAULTS, anchorsOf, changeAnchor, hasOwnColors, putBackAnchor, readVwap, restoreAnchor, withAnchor, withRolling, withThemeColors, withoutAnchor } from '../src/app/vwap/settings.ts';
import { dashOf } from '../src/app/vwap/paint.ts';
import { anchorDefault, lineColor, rollingDefault } from '../src/app/vwap/colours.ts';
import { lowContrast } from '../src/app/anchors/controls.ts';
import { cutForReplay, paintVwap, visible, vwapCode, type VwapLine } from '../src/app/vwap/paint.ts';
import { View } from '../src/app/view.ts';
import { paintKeyTags, placeKeyTags, type KeyTag } from '../src/app/keylevels/paint.ts';
import type { Palette } from '../src/app/theme.ts';
import { MAX_BACK_MS } from '../src/app/keylevels/levels.ts';
import type { CandleRow } from '../src/app/store.ts';
import { MAX_VWAP_MARKETS, VWAP_PICKS, pickTarget, quoteOf, readVwapPicks, seedPicks, vwapTargets } from '../src/app/vwap/markets.ts';
import { BTC } from '../src/shared/coins.ts';

const MIN = 60_000, HOUR = 3_600_000, DAY = 86_400_000;
const D0 = Date.UTC(2026, 9, 5);
const bar = (t: number, h: number, l: number, c: number, v: number): CandleRow => [t, c, h, l, c, v];
const close = (a: number, b: number, eps = 1e-9): boolean => Math.abs(a - b) <= eps * Math.max(1, Math.abs(b));
// One market's candles, as the map hands them over.
const vwapSeries = (bars: readonly CandleRow[], from: number, to: number): ReturnType<typeof vwapOf> => vwapOf(vwapBarsOf(bars), from, to);
const rollingSeries = (bars: readonly CandleRow[], barMs: number, w: number, asOf: number): ReturnType<typeof rollingOf> => rollingOf(vwapBarsOf(bars), barMs, w, asOf);

test('the VWAP is each bar\'s typical price weighted by its volume, and the bands its volume-weighted spread', () => {
  const bars = [bar(D0, 102, 98, 100, 1), bar(D0 + MIN, 106, 100, 103, 2), bar(D0 + 2 * MIN, 110, 90, 95, 0)];
  const pts = vwapSeries(bars, D0, D0 + DAY);
  assert.deepEqual(pts.map(p => p.t), [D0, D0 + MIN, D0 + 2 * MIN], 'a bar that did not trade carries the line on');
  assert.equal(pts[0]!.vwap, 100); assert.equal(pts[0]!.sd, 0);
  assert.ok(close(pts[1]!.vwap, 102)); assert.ok(close(pts[1]!.sd, Math.sqrt(2)), 'sqrt((1*(100-102)^2 + 2*(103-102)^2) / 3)');
  assert.ok(close(pts[2]!.vwap, 102) && close(pts[2]!.sd, Math.sqrt(2)));
});

test('the line begins at the first bar that traded, keeps its precision near 100,000, and covers only its own stretch', () => {
  const quiet = vwapSeries([bar(D0, 101, 99, 100, 0), bar(D0 + MIN, 101, 99, 100, 3)], D0, D0 + DAY);
  assert.deepEqual(quiet.map(p => p.t), [D0 + MIN], 'nothing before the first volume');
  const high = vwapSeries([bar(D0, 100_000, 100_000, 100_000, 1), bar(D0 + MIN, 100_000.2, 100_000.2, 100_000.2, 1)], D0, D0 + DAY);
  assert.ok(close(high[1]!.vwap, 100_000.1, 1e-12) && close(high[1]!.sd, 0.1, 1e-6), `${high[1]!.sd}`);
  const two = [bar(D0, 101, 99, 100, 1), bar(D0 + DAY, 201, 199, 200, 1)];
  assert.deepEqual(vwapSeries(two, D0 + DAY, D0 + 2 * DAY).map(p => p.vwap), [200], 'a new session starts afresh');
});

test('the bar size follows how far back the line reaches, and never crosses a period boundary of the zone', () => {
  assert.deepEqual([vwapBarMs(0, HOUR), vwapBarMs(DAY, HOUR), vwapBarMs(3 * DAY, HOUR), vwapBarMs(20 * DAY, HOUR), vwapBarMs(20 * DAY, 15 * MIN), vwapBarMs(3 * DAY, 15 * MIN)].map(m => m / MIN), [1, 1, 5, 30, 15, 5]);
});

test('sessions are the periods of the zone that have begun and touch the chart', () => {
  const now = D0 + 2 * DAY + 5 * HOUR;
  assert.deepEqual(sessionsOf('day', 'UTC', D0 + 12 * HOUR, now + HOUR, now).map(w => w.from), [D0, D0 + DAY, D0 + 2 * DAY]);
  // New York leaves daylight saving on 1 November 2026: that day's session is 25 hours.
  const ny = sessionsOf('day', 'America/New_York', Date.UTC(2026, 10, 1, 12), Date.UTC(2026, 10, 1, 13), Date.UTC(2026, 10, 3));
  assert.equal(ny[0]!.to - ny[0]!.from, 25 * HOUR);
  assert.deepEqual(sessionsOf('week', 'UTC', now - HOUR, now, now).map(w => w.from), [D0]);
});

test('a day whose session starts at a set hour runs from there to the next day\'s, whatever the zone\'s clocks do', () => {
  const now = D0 + 2 * DAY + 5 * HOUR;
  // 14:00 UTC: each window runs 14:00 to 14:00, and one beginning the day before the chart still counts once it has begun.
  assert.deepEqual(sessionsOf('day', 'UTC', D0 + 12 * HOUR, now + HOUR, now, 14 * 60).map(w => w.from),
    [D0 - 10 * HOUR, D0 + 14 * HOUR, D0 + DAY + 14 * HOUR]);
  assert.ok(sessionsOf('day', 'UTC', D0 + 12 * HOUR, now + HOUR, now, 14 * 60).every((w, i, a) => i === 0 || a[i - 1]!.to === w.from), 'each window runs to the next one\'s start');
  // New York leaves daylight saving on 1 November 2026: the window starting at 09:00 local before the change is 25 hours.
  const ny = sessionsOf('day', 'America/New_York', Date.UTC(2026, 10, 1, 12), Date.UTC(2026, 10, 1, 13), Date.UTC(2026, 10, 3), 9 * 60);
  assert.equal(ny[0]!.to - ny[0]!.from, 25 * HOUR);
  // A start not set keeps the calendar day.
  assert.deepEqual(sessionsOf('day', 'UTC', D0 + 12 * HOUR, now + HOUR, now, null).map(w => w.from), [D0, D0 + DAY, D0 + 2 * DAY]);
});

test('anchors are kept per coin, fixed to the minute or live by a rule, at most six, none in the future or beyond ten years back', () => {
  const now = D0 + 10 * DAY, at = (s: typeof VWAP_DEFAULTS, coin = 'BTC') => (s.anchors[coin] ?? []).map(a => a.at ?? a.rule);
  let s = { ...VWAP_DEFAULTS };
  s = withAnchor(s, 'BTC', { at: now - DAY + 30_500 }, now);
  assert.deepEqual(at(s), [now - DAY]);
  assert.equal(s.anchors.BTC![0]!.slot, 0);
  assert.equal(withAnchor(s, 'BTC', { at: now - DAY + 10_000 }, now), s, 'the same minute again: unchanged');
  assert.equal(withAnchor(s, 'BTC', { at: now + MIN }, now), s, 'not in the future');
  assert.equal(withAnchor(s, 'BTC', { at: now - ANCHOR_REACH_MS - DAY }, now), s, 'nor beyond ten years');
  s = withAnchor(s, 'BTC', { rule: { period: 'week', point: 'high' } }, now);
  assert.equal(withAnchor(s, 'BTC', { rule: { period: 'week', point: 'high' } }, now), s, 'the same rule again: unchanged');
  for (const back of [5, 4, 3, 6]) s = withAnchor(s, 'BTC', { at: now - back * HOUR }, now);
  assert.equal(s.anchors.BTC!.length, MAX_ANCHORS);
  assert.deepEqual(s.anchors.BTC!.map(a => a.slot), [0, 1, 2, 3, 4, 5], 'each a colour slot of its own');
  assert.equal(new Set(s.anchors.BTC!.map(a => a.id)).size, MAX_ANCHORS, 'and an id of its own');
  assert.equal(withAnchor(s, 'BTC', { at: now - 2 * HOUR }, now), s, 'a seventh is refused');
  s = withAnchor(s, 'ETH', { at: now - HOUR }, now);
  assert.deepEqual(Object.keys(s.anchors), ['BTC', 'ETH']);
  assert.deepEqual(withoutAnchor(s, 'ETH', s.anchors.ETH![0]!.id).anchors.ETH, undefined);
  // A removed anchor's slot is free again, and a new one takes it; the others keep theirs (and their colours).
  const second = s.anchors.BTC![1]!, fewer = withoutAnchor(s, 'BTC', second.id);
  assert.deepEqual(fewer.anchors.BTC!.map(a => a.slot), [0, 2, 3, 4, 5]);
  assert.equal(withAnchor(fewer, 'BTC', { at: now - 9 * HOUR }, now).anchors.BTC!.at(-1)!.slot, 1);
  // Undo puts it back where it was, as it was; not when that would make a seventh or a duplicate.
  assert.deepEqual(restoreAnchor(fewer, 'BTC', second, 1).anchors.BTC, s.anchors.BTC);
  assert.equal(restoreAnchor(s, 'BTC', second, 1), s, 'already there');
  // Kept two months until 2026-11-11: one clicked 70 days back was saved and never drawn (a user).
  const old = readVwap({ anchors: { BTC: [now - ANCHOR_REACH_MS - DAY, now - 70 * DAY, now - HOUR] } });
  assert.deepEqual(at(old), [now - ANCHOR_REACH_MS - DAY, now - 70 * DAY, now - HOUR], 'a save of bare times is read as fixed anchors at those very times');
  assert.deepEqual(anchorsOf(old, 'BTC', now).map(a => a.at), [now - 70 * DAY, now - HOUR], 'one 70 days back is drawn, one beyond ten years is not');
  assert.ok(MAX_BACK_MS < 70 * DAY);
});

test('an anchor is changed in place: moved (fixed from then on), frozen from a rule, recoloured, hidden', () => {
  const now = D0 + 10 * DAY;
  let s = withAnchor({ ...VWAP_DEFAULTS }, 'BTC', { rule: { period: 'month', point: 'low' } }, now);
  s = withAnchor(s, 'BTC', { at: now - 3 * HOUR }, now);
  const [live, fixed] = s.anchors.BTC!;
  const frozen = changeAnchor(s, 'BTC', live!.id, { at: now - 5 * DAY + 17 * MIN + 20_000 });
  assert.deepEqual(frozen.anchors.BTC![0], { id: live!.id, at: now - 5 * DAY + 17 * MIN, slot: 0 }, 'frozen: its rule dropped, to the minute, its id and slot kept');
  assert.equal(changeAnchor(s, 'BTC', live!.id, { at: now - 3 * HOUR }), s, 'not onto the minute of another');
  const red = changeAnchor(s, 'BTC', fixed!.id, { color: '#FF0000' });
  assert.equal(red.anchors.BTC![1]!.color, '#ff0000');
  assert.equal(changeAnchor(red, 'BTC', fixed!.id, { color: null }).anchors.BTC![1]!.color, undefined, 'null: back to the theme colour');
  assert.equal(changeAnchor(s, 'BTC', fixed!.id, { color: 'red' }).anchors.BTC![1]!.color, undefined, 'only #rrggbb');
  assert.equal(changeAnchor(s, 'BTC', fixed!.id, { hidden: true }).anchors.BTC![1]!.hidden, true);
  assert.equal(changeAnchor(s, 'BTC', 'nope', { hidden: true }), s);
  // Undo of a move or a freeze puts it back as it was, only while nobody has changed it since.
  const movedOnce = changeAnchor(s, 'BTC', live!.id, { at: now - DAY }), now1 = movedOnce.anchors.BTC![0]!;
  assert.deepEqual(putBackAnchor(movedOnce, 'BTC', now1, live!).anchors.BTC![0], live, 'back to the rule it followed');
  const changedSince = changeAnchor(movedOnce, 'BTC', live!.id, { color: '#ffffff' });
  assert.equal(putBackAnchor(changedSince, 'BTC', now1, live!), changedSince, 'changed since: left alone');
  const ruleTaken = withAnchor(withoutAnchor(movedOnce, 'BTC', fixed!.id), 'BTC', { rule: { period: 'month', point: 'low' } }, now);
  assert.equal(putBackAnchor(ruleTaken, 'BTC', now1, live!), ruleTaken, 'its rule taken by another since: left alone');
});

test('Undo after a remove gives a colour slot taken since a free one; a fixed anchor no longer drawn neither counts nor stays', () => {
  const now = D0 + 10 * DAY;
  let s = { ...VWAP_DEFAULTS };
  for (const back of [1, 2, 3]) s = withAnchor(s, 'BTC', { at: now - back * HOUR }, now);
  const second = s.anchors.BTC![1]!, fewer = withoutAnchor(s, 'BTC', second.id), refilled = withAnchor(fewer, 'BTC', { at: now - 9 * HOUR }, now);
  assert.equal(refilled.anchors.BTC!.at(-1)!.slot, second.slot, 'the new one took the freed slot');
  const back = restoreAnchor(refilled, 'BTC', second, 1);
  assert.equal(new Set(back.anchors.BTC!.map(a => a.slot)).size, back.anchors.BTC!.length, 'no two lines share a default colour');
  const old = { ...s, anchors: { BTC: Array.from({ length: MAX_ANCHORS }, (_, i) => ({ id: `o${i}`, at: now - ANCHOR_REACH_MS - (i + 1) * DAY, slot: i })) } };
  assert.equal(anchorsOf(old, 'BTC', now).length, 0, 'six beyond ten years: none drawn');
  const added = withAnchor(old, 'BTC', { at: now - HOUR }, now);
  assert.deepEqual(added.anchors.BTC!.map(a => a.at), [now - HOUR], 'a new one is not refused by them, and they are dropped');
});

test('each rolling window and each anchor slot has a dash of its own; the session is solid', () => {
  assert.deepEqual(dashOf({ kind: 'session', n: 0 }), []);
  const rolling = ROLLING_DAYS.map(n => JSON.stringify(dashOf({ kind: 'rolling', n })));
  assert.equal(new Set(rolling).size, ROLLING_DAYS.length);
  const anchors = [0, 1, 2, 3, 4, 5].map(slot => JSON.stringify(dashOf({ kind: 'anchor', n: 1, slot })));
  assert.equal(new Set(anchors).size, 6);
});

test('each line has a colour: its own, else its theme default (greens for rolling, violets for anchors); reset clears them all', () => {
  const dark = { dark: true, vwap: '#f4e04d' }, light = { dark: false, vwap: '#0891b2' };
  let s = withAnchor({ ...VWAP_DEFAULTS }, 'BTC', { at: D0 }, D0 + DAY);
  assert.equal(lineColor({ kind: 'session', n: 0 }, s.colors, dark), '#f4e04d', 'the session keeps the theme\'s VWAP colour');
  assert.equal(lineColor({ kind: 'rolling', n: 7 }, s.colors, light), rollingDefault(7, light));
  assert.notEqual(rollingDefault(7, dark), rollingDefault(7, light), 'lighter on dark themes, deeper on light ones');
  assert.equal(lineColor({ kind: 'anchor', n: 1, slot: 3 }, s.colors, dark), anchorDefault(3, dark));
  assert.equal(new Set([0, 1, 2, 3, 4, 5].map(i => anchorDefault(i, dark))).size, 6, 'six anchors, six colours');
  assert.equal(hasOwnColors(s, 'BTC'), false);
  s = { ...s, colors: { session: '#123456', rolling: { 30: '#abcdef' } } };
  s = changeAnchor(s, 'BTC', s.anchors.BTC![0]!.id, { color: '#00ff00' });
  assert.equal(lineColor({ kind: 'rolling', n: 30 }, s.colors, dark), '#abcdef');
  assert.equal(hasOwnColors(s, 'BTC'), true);
  const back = withThemeColors(s, 'BTC');
  assert.equal(hasOwnColors(back, 'BTC'), false);
  assert.equal(back.anchors.BTC![0]!.at, D0, 'the anchors stay');
  const read = readVwap({ colors: { session: '#ABCDEF', rolling: { 7: '#00ff00', 8: '#ffffff', 30: 'blue' } } });
  assert.deepEqual(read.colors, { session: '#abcdef', rolling: { 7: '#00ff00' } }, 'colours as #rrggbb, rolling ones by a window offered');
  // A colour chosen on a dark theme and kept on a light one is said to be hard to see there, never changed.
  assert.equal(lowContrast('#fef08a', { bg: '#ffffff' }), true);
  assert.equal(lowContrast('#fef08a', { bg: '#0b0e14' }), false);
  assert.equal(lowContrast('#6d28d9', { bg: '#ffffff' }), false);
});

test('settings from storage are read field by field', () => {
  assert.deepEqual(readVwap(undefined), VWAP_DEFAULTS);
  assert.equal(VWAP_DEFAULTS.on, false, 'off until switched on');
  const read = readVwap({ on: true, period: 'month', bands: 2, anchors: { BTC: [3, 'x', 1, 2, 5, 4, 8, 6, 7, 7], 'bad coin': [1], ETH: 'no' }, labels: 'yes' });
  assert.deepEqual([read.on, read.period, read.bands, read.labels], [true, 'month', 2, true]);
  assert.deepEqual(Object.keys(read.anchors), ['BTC'], 'a coin by its name');
  assert.deepEqual(read.anchors.BTC!.map(a => a.at), [2, 5, 4, 8, 6, 7], 'times and rules only, each once, the last six in the order kept');
  assert.equal(readVwap({ period: 'year', bands: 3 }).period, 'day');
});

test('the VWAP\'s tags are placed with the key levels\', the more important first', () => {
  const tag = (key: string, y: number, rank: number, color?: string): KeyTag => ({ key, y, rank, text: key, older: false, ...(color ? { color } : {}) });
  const kept = placeKeyTags([tag('PDH', 100, 8), tag('VWAP', 105, 1.5, '#0891b2'), tag('AVWAP 1', 300, 6.5, '#0891b2')], [], 600);
  assert.deepEqual(kept.map(k => k.key), ['VWAP', 'AVWAP 1'], 'the session VWAP before the previous day\'s high');
  assert.equal(kept[0]!.color, '#0891b2');
  assert.deepEqual([vwapCode({ kind: 'session', n: 0 }), vwapCode({ kind: 'anchor', n: 2 })], ['VWAP', 'AVWAP 2']);
});

test('only the points on the chart and one either side are drawn', () => {
  const pts = [0, 10, 20, 30, 40, 50].map(t => ({ t, vwap: 1, sd: 0 }));
  assert.deepEqual(visible(pts, 15, 35).map(p => p.t), [10, 20, 30, 40]);
  assert.deepEqual(visible(pts, -5, 5).map(p => p.t), [0, 10]);
  assert.deepEqual(visible(pts, 60, 70).map(p => p.t), [50]);
});

/** Bars of `bar` ms from D0 with a little random walk, some left out (a stretch nobody traded) and some with no volume. */
function walk(n: number, barMs: number, seed = 7): CandleRow[] {
  let s = seed, p = 100_000;
  const rnd = (): number => { s = (s * 1_103_515_245 + 12_345) % 2_147_483_648; return s / 2_147_483_648; };
  const out: CandleRow[] = [];
  for (let k = 0; k < n; k++) {
    const r = rnd();
    if (r < 0.06) continue;
    p *= 1 + (rnd() - 0.5) * 0.004;
    const h = p * (1 + rnd() * 0.002), l = p * (1 - rnd() * 0.002);
    out.push(bar(D0 + k * barMs, h, l, p, r < 0.1 ? 0 : 1 + rnd() * 50));
  }
  return out;
}
/** The rolling VWAP at `end` the slow way: every bar that starts in [end - w, end) and before `end`, typical price by volume. */
function bruteRolling(bars: readonly CandleRow[], w: number, end: number): number {
  let pv = 0, v = 0;
  for (const b of bars) if (b[0] >= end - w && b[0] < end) { pv += (b[2] + b[3] + b[4]) / 3 * b[5]; v += b[5]; }
  return pv / v;
}

test('a rolling VWAP is each window\'s typical price by volume, the window by time, so a missing bar is time nobody traded', () => {
  const bars = walk(600, HOUR), w = 30 * HOUR, asOf = D0 + 10_000 * HOUR;
  const pts = rollingSeries(bars, HOUR, w, asOf);
  assert.ok(pts.length > 400);
  for (const p of pts) assert.ok(close(p.vwap, bruteRolling(bars, w, p.t), 1e-9), `${p.t}: ${p.vwap} against ${bruteRolling(bars, w, p.t)}`);
  // Every point stands at a bar's end, after the bars it holds.
  assert.ok(pts.every(p => bars.some(b => b[0] + HOUR === p.t)));
});

test('a rolling VWAP is drawn only where its window is whole: never the average of fewer days under the window\'s name', () => {
  const bars = walk(200, HOUR, 3), first = bars[0]![0], w = 48 * HOUR;
  const pts = rollingSeries(bars, HOUR, w, D0 + 1_000 * HOUR);
  assert.ok(pts.length > 0 && pts[0]!.t >= first + w, 'the first point is a whole window after the first bar held');
  assert.equal(pts[0]!.t, Math.min(...bars.map(b => b[0] + HOUR).filter(e => e >= first + w)));
  assert.deepEqual(rollingSeries(bars.slice(0, 40), HOUR, w, D0 + 1_000 * HOUR), [], 'a history shorter than the window gives no line');
  assert.deepEqual(rollingSeries([], HOUR, w, D0), []);
});

test('the bar under way is drawn where the history was last read, its window ending there', () => {
  const bars = Array.from({ length: 10 }, (_, k) => bar(D0 + k * HOUR, 101 + k, 99 + k, 100 + k, 1));
  const asOf = D0 + 9 * HOUR + 20 * MIN, pts = rollingSeries(bars, HOUR, 3 * HOUR, asOf);
  const last = pts[pts.length - 1]!;
  assert.equal(last.t, asOf, 'at the time it was read, not the bar\'s end');
  // Bars starting at or after 06:20 count: 07:00, 08:00 and 09:00 (under way).
  assert.ok(close(last.vwap, (107 + 108 + 109) / 3), `${last.vwap}`);
  assert.equal(pts[pts.length - 2]!.t, D0 + 9 * HOUR, 'the bar before ends on the hour');
});

test('each rolling window has the bar size measured for it, from the window alone, and its history keeps a whole window and more', () => {
  assert.deepEqual(ROLLING_DAYS.map(d => rollingBarMs(d) / MIN), [5, 15, 60, 60, 240, 240]);
  for (const d of ROLLING_DAYS) assert.ok(d * DAY / rollingBarMs(d) <= 2_190 && rollingBarMs(d) * ROLLING_MAX_BARS > 1.5 * d * DAY, `${d}D`);
});

test('the rolling windows are read from storage among those offered, once each, shortest first, and switched one at a time', () => {
  assert.deepEqual(readVwap({ rolling: [365, 7, 'x', 7, 14, 1, -3] }).rolling, [1, 7, 365], 'only the windows offered');
  assert.deepEqual(readVwap({ rolling: 'all' }).rolling, []);
  assert.deepEqual(readVwap({ on: true }).rolling, [], 'a save from before has none');
  const s = withRolling(withRolling(VWAP_DEFAULTS, 90, true), 7, true);
  assert.deepEqual(s.rolling, [7, 90]);
  assert.deepEqual(withRolling(s, 90, false).rolling, [7]);
  assert.equal(withRolling(s, 14, true), s, 'a window not offered changes nothing');
  assert.equal(vwapCode({ kind: 'rolling', n: 30 }), 'RVWAP 30D');
});

test('in a replay a rolling line ends at its last bar over by the moment; a session\'s history point counts once its bar is over', () => {
  const pts = (ts: number[]): { t: number; vwap: number; sd: number }[] => ts.map(t => ({ t, vwap: 1, sd: 0 }));
  const lines: VwapLine[] = [
    { kind: 'rolling', n: 7, points: pts([HOUR, 2 * HOUR, 3 * HOUR]), live: true, key: 'r' },
    { kind: 'session', n: 0, points: pts([0, HOUR, 2 * HOUR]), live: true, key: 's', bar: HOUR, liveFrom: Infinity },
  ];
  const cut = cutForReplay(lines, 2 * HOUR + 30 * MIN, true);
  assert.deepEqual(cut[0]!.points.map(p => p.t), [HOUR, 2 * HOUR], 'points stand at bar ends');
  assert.deepEqual(cut[1]!.points.map(p => p.t), [0, HOUR], 'points stand at bar starts');
  assert.equal(cutForReplay(lines, 0, false), lines, 'live: as they are');
});

test('a name wider than the price axis is drawn narrower there, never cut at its edge', () => {
  const texts: unknown[][] = [];
  const ctx = new Proxy({}, { get: (_t, k) => k === 'fillText' ? (...a: unknown[]) => { texts.push(a); } : () => {}, set: () => true }) as CanvasRenderingContext2D;
  const palette = { level: '#888', panel: '#fff', bg: '#fff' } as Palette;
  paintKeyTags(ctx, [{ key: 'r', y: 50, rank: 7.5, text: 'RVWAP 365D', older: false }, { key: 'v', y: 80, rank: 1.5, text: 'VWAP', older: true }], 600, 64, palette);
  assert.deepEqual(texts.map(a => a[3]), [56, 56], 'the axis less its margins is the most a name may take');
});

test('a rolling window\'s history is asked for a whole window before the view, never further back than it keeps, nor from 1970', () => {
  const now = D0 + 500 * DAY, real = now;
  assert.equal(rollingFrom(30, now - 10 * DAY, now + HOUR, now, real), now - 40 * DAY, 'a window before the view');
  assert.equal(rollingFrom(30, 0, 0, now, real), now - 30 * DAY, 'a view not framed yet: a window back from now');
  assert.equal(rollingFrom(30, now + HOUR, now + HOUR, now, real), now - 30 * DAY, 'a view of no width, following the live edge');
  const far = rollingFrom(1, now - 400 * DAY, now, now, real), keeps = 5 * MIN * ROLLING_MAX_BARS;
  assert.ok(far > real - keeps + DAY && far <= real - keeps + DAY + 5 * MIN, 'bounded a day and a bar inside what the history keeps');
  assert.equal(far % (5 * MIN), 0, 'on a bar');
});

test('a thin market\'s window is still a point at the time it was read when no bar is under way', () => {
  const bars = Array.from({ length: 10 }, (_, k) => bar(D0 + k * HOUR, 101 + k, 99 + k, 100 + k, 1));
  const asOf = D0 + 11 * HOUR + 30 * MIN, pts = rollingSeries(bars, HOUR, 3 * HOUR, asOf), last = pts[pts.length - 1]!;
  assert.equal(last.t, asOf, 'nobody traded since the last bar ended at 10:00');
  assert.ok(close(last.vwap, 109), 'bars starting at or after 08:30: the 09:00 bar alone');
  assert.equal(pts[pts.length - 2]!.t, D0 + 10 * HOUR);
  assert.equal(rollingSeries(bars, HOUR, 3 * HOUR, D0 + 20 * HOUR).at(-1)!.t, D0 + 10 * HOUR, 'a window left empty by then has no point');
});

test('the view\'s start counts from its hour, as the map keeps its plan for the hour', () => {
  const now = D0 + 500 * DAY;
  assert.equal(rollingFrom(7, now - 10 * DAY + 25 * MIN, now, now, now), now - 17 * DAY, 'a view moved back inside the hour keeps its whole window');
});

test('a line with thousands of points to a pixel column is drawn with a few, and rolling tags rank after the day\'s levels', () => {
  let moves = 0, segments = 0;
  const ctx = new Proxy({}, { get: (_t, k) => k === 'lineTo' ? () => { segments++; } : k === 'moveTo' ? () => { moves++; } : k === 'measureText' ? () => ({ width: 40 }) : () => {}, set: () => true }) as CanvasRenderingContext2D;
  const view = new View({ t0: D0, t1: D0 + 100 * DAY, p0: 90, p1: 110 });
  const points = Array.from({ length: 20_000 }, (_, k) => ({ t: D0 + k * 7 * MIN, vwap: 100 + Math.sin(k / 50), sd: 0 }));
  const palette = { dark: false, vwap: '#0891b2', bid: '#12a150', ask: '#e0115f', panel: '#ffffff' } as Palette;
  const tags = paintVwap(ctx, [{ kind: 'rolling', n: 30, points, live: true, key: 'rolling|30' }], view, 200, 300, palette, { ...VWAP_DEFAULTS, on: true });
  assert.equal(moves, 1);
  assert.ok(segments <= 4 * 202, `${segments} segments across 200 px, not 20,000`);
  assert.equal(tags[0]!.rank, 11.5 + 30 / 1000, 'after the day\'s levels (8 to 11), before earlier periods\' (20 on)');
});

test('a pixel column of a thinned line ends where its last point is, an excursion that came back included', () => {
  const calls: string[] = [];
  const ctx = new Proxy({}, { get: (_t, k) => k === 'moveTo' || k === 'lineTo' ? (x: number, y: number) => { calls.push(`${String(k)} ${Math.round(x * 10) / 10} ${Math.round(y * 10) / 10}`); } : () => {}, set: () => true }) as CanvasRenderingContext2D;
  const view = new View({ t0: 0, t1: 1000, p0: 0, p1: 300 });
  // y = 300 - price on a 300 px plot, x = t on a 1000 px one: one column at x 50 (y 200, 210, 170, back to 200), then x 80 (y 180).
  const points = [[50.1, 100], [50.3, 90], [50.5, 130], [50.7, 100], [80, 120]].map(([t, vwap]) => ({ t: t!, vwap: vwap!, sd: 0 }));
  paintVwap(ctx, [{ kind: 'rolling', n: 7, points, live: false, key: 'r' }], view, 1000, 300, { dark: false, vwap: '#08c', panel: '#fff' } as Palette, { ...VWAP_DEFAULTS, on: true });
  assert.deepEqual(calls, ['moveTo 50.1 200', 'lineTo 50.1 170', 'lineTo 50.1 210', 'lineTo 50.1 200', 'lineTo 80 180']);
});

test('several markets added up keep the spread between them for the bands, and count only bars every market has closed', () => {
  // Equal volumes at 100 and 200 in one minute: an average of 150 whose prices lie 50 either side, as the brute count over every market's bars.
  const a = [bar(D0, 100, 100, 100, 2), bar(D0 + MIN, 103, 101, 102, 1), bar(D0 + 2 * MIN, 110, 100, 105, 4)];
  const b = [bar(D0, 200, 200, 200, 2), bar(D0 + MIN, 99, 97, 98, 3), bar(D0 + 2 * MIN, 120, 110, 115, 9)];
  const merged = mergeVwapBars([a, b], MIN, D0 + 2 * MIN);
  assert.deepEqual(merged.map(m => m[0]), [D0, D0 + MIN], 'the bar under way at the cutoff is left out');
  const first = vwapOf(merged, D0, D0 + DAY)[0]!;
  assert.ok(close(first.vwap, 150) && close(first.sd, 50), `${first.vwap} ${first.sd}`);
  const brute = (upTo: number): { vwap: number; sd: number } => {
    const all = [...a, ...b].filter(c => c[0] <= upTo), v = all.reduce((x, c) => x + c[5], 0), tp = (c: CandleRow): number => (c[2] + c[3] + c[4]) / 3;
    const vwap = all.reduce((x, c) => x + tp(c) * c[5], 0) / v;
    return { vwap, sd: Math.sqrt(all.reduce((x, c) => x + c[5] * (tp(c) - vwap) ** 2, 0) / v) };
  };
  const second = vwapOf(merged, D0, D0 + DAY)[1]!, want = brute(D0 + MIN);
  assert.ok(close(second.vwap, want.vwap) && close(second.sd, want.sd), `${second.sd} against ${want.sd}`);
  // One market merged is that market's line (its quiet bars aside, which add nothing).
  const one = mergeVwapBars([a], MIN, D0 + 3 * MIN);
  assert.deepEqual(vwapOf(one, D0, D0 + DAY), vwapSeries(a, D0, D0 + DAY));
  assert.deepEqual(mergeVwapBars([a, []], MIN, D0 + 3 * MIN).map(m => m[1]), [2, 1, 4], 'a market with no candles traded nothing');
});

test('a rolling window over several markets is whole only from where every history begins', () => {
  const bars = Array.from({ length: 10 }, (_, k) => bar(D0 + k * HOUR, 101 + k, 99 + k, 100 + k, 1));
  const pts = rollingOf(vwapBarsOf(bars), HOUR, 3 * HOUR, D0 + 10 * HOUR, D0 + 4 * HOUR);
  assert.equal(pts[0]!.t, D0 + 7 * HOUR, 'a market whose history begins at 04:00 holds the first point back to 07:00');
  assert.equal(rollingOf(vwapBarsOf(bars), HOUR, 3 * HOUR, D0 + 10 * HOUR)[0]!.t, D0 + 3 * HOUR, 'one market: a window after its first bar');
});

test('the VWAP\'s candles come from the chart market by default; chosen markets are exchange and kind, read back checked, and stand for this coin\'s markets', () => {
  assert.equal(VWAP_DEFAULTS.source, 'chart'); assert.deepEqual(VWAP_DEFAULTS.picks, []);
  assert.equal(readVwap({ source: 'chosen', picks: ['binance/spot', 'nowhere/perp', 'binance/spot', 'coinbase/spot', 3] }).source, 'chosen');
  assert.deepEqual(readVwap({ source: 'chosen', picks: ['binance/spot', 'nowhere/perp', 'binance/spot', 'coinbase/spot', 3] }).picks, ['binance/spot', 'coinbase/spot'], 'offered ones only, each once');
  assert.equal(readVwap({ source: 'everything' }).source, 'chart');
  assert.equal(readVwapPicks(VWAP_PICKS).length, MAX_VWAP_MARKETS, 'at most six');
  assert.ok(VWAP_PICKS.includes('coinbase/spot') && !VWAP_PICKS.includes('coinbase/perp'), 'Coinbase has spot alone');
  // The chart's own market, spot named the server's way, is recognised as its own.
  assert.equal(pickTarget('binance/spot', BTC, 'binance:BTCUSDT:spot')?.own, true);
  assert.equal(pickTarget('binance/spot', BTC, 'binance:BTCUSDT')?.id, 'binancespot:BTCUSDT');
  assert.deepEqual(seedPicks('bybit:BTCUSDT', BTC), ['bybit/perp'], 'switching to chosen starts from the market the lines read');
  assert.deepEqual(vwapTargets('chart', ['coinbase/spot'], 'binance:BTCUSDT', BTC).map(t => t.id), ['binance:BTCUSDT'], 'the choices wait while the chart market is the source');
  assert.deepEqual(vwapTargets('chosen', ['binance/perp', 'coinbase/spot'], 'binance:BTCUSDT', BTC).map(t => t.id), ['binance:BTCUSDT', 'coinbase:BTC-USD']);
  assert.deepEqual(vwapTargets('chosen', [], 'binance:BTCUSDT', BTC), [], 'none ticked: none');
  assert.deepEqual(vwapTargets('chosen', ['binance/perp', 'coinbase/spot', 'hyperliquid/perp'], 'binance:BTCUSDT', BTC).map(quoteOf), ['USDT', 'USD', 'USDC']);
});

test('an anchor placed on the chart starts where its candle does, and its line is worked out on the largest bar that starts there', () => {
  const now = D0 + 400 * DAY, at = D0 + 10 * DAY + 14 * HOUR;
  assert.equal(candleStartAt(at + 37 * MIN, HOUR), at, 'a click inside the 14:00 candle of a 1h chart: 14:00, not the minute');
  assert.equal(candleStartAt(at + 37 * MIN, 15 * MIN), at + 30 * MIN);
  // The body by age: a minute for a day and a half, five minutes for eight days, half an hour for two months, an hour for thirteen months,
  // a day beyond; on its bar, no head.
  assert.deepEqual(anchorBars(now - HOUR, now), { bar: MIN, head: 0 });
  assert.deepEqual(anchorBars(now - 3 * DAY, now), { bar: 5 * MIN, head: 0 });
  assert.deepEqual(anchorBars(now - 30 * DAY, now), { bar: 30 * MIN, head: 0 });
  assert.deepEqual(anchorBars(now - 300 * DAY, now), { bar: HOUR, head: 0 });
  assert.deepEqual(anchorBars(now - 500 * DAY, now), { bar: DAY, head: 0 }, 'midnight UTC, five hundred days back: daily bars');
  // Off its body's bar, the stretch up to the first whole one is read on the largest size that starts at the anchor (Sol: a fine head
  // stitched to a coarse body), never a bar that began before it.
  assert.deepEqual(anchorBars(now - 30 * DAY + 15 * MIN, now), { bar: 30 * MIN, head: 15 * MIN }, 'a quarter past: a quarter-hour head');
  assert.deepEqual(anchorBars(now - 500 * DAY + 4 * HOUR, now), { bar: DAY, head: 4 * HOUR });
  assert.deepEqual(anchorBars(now - 500 * DAY + 3 * HOUR, now), { bar: DAY, head: HOUR });
  assert.deepEqual(anchorBars(now - 500 * DAY + 3 * HOUR + 7 * MIN, now), { bar: DAY, head: MIN }, 'a date typed to the minute: a minute head');
});
