import test from 'node:test';
import assert from 'node:assert/strict';
import { ROLLING_MAX_BARS, rollingBarMs, rollingSeries, sessionsOf, vwapBarMs, vwapSeries } from '../src/app/vwap/vwap.ts';
import { MAX_ANCHORS, ROLLING_DAYS, VWAP_DEFAULTS, anchorsOf, readVwap, withAnchor, withRolling, withoutAnchor } from '../src/app/vwap/settings.ts';
import { cutForReplay, visible, vwapCode, type VwapLine } from '../src/app/vwap/paint.ts';
import { placeKeyTags, type KeyTag } from '../src/app/keylevels/paint.ts';
import { MAX_BACK_MS } from '../src/app/keylevels/levels.ts';
import type { CandleRow } from '../src/app/store.ts';

const MIN = 60_000, HOUR = 3_600_000, DAY = 86_400_000;
const D0 = Date.UTC(2026, 9, 5);
const bar = (t: number, h: number, l: number, c: number, v: number): CandleRow => [t, c, h, l, c, v];
const close = (a: number, b: number, eps = 1e-9): boolean => Math.abs(a - b) <= eps * Math.max(1, Math.abs(b));

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

test('anchors are kept per coin, to the minute, at most four, none in the future or older than the history reaches', () => {
  const now = D0 + 10 * DAY;
  let s = { ...VWAP_DEFAULTS };
  s = withAnchor(s, 'BTC', now - DAY + 30_500, now);
  assert.deepEqual(s.anchors, { BTC: [now - DAY] });
  assert.equal(withAnchor(s, 'BTC', now - DAY + 10_000, now), s, 'the same minute again: unchanged');
  assert.equal(withAnchor(s, 'BTC', now + MIN, now), s, 'not in the future');
  for (const back of [5, 4, 3]) s = withAnchor(s, 'BTC', now - back * HOUR, now);
  assert.equal(s.anchors.BTC!.length, MAX_ANCHORS);
  assert.equal(withAnchor(s, 'BTC', now - 2 * HOUR, now), s, 'a fifth is refused');
  s = withAnchor(s, 'ETH', now - HOUR, now);
  assert.deepEqual(Object.keys(s.anchors), ['BTC', 'ETH']);
  assert.deepEqual(withoutAnchor(s, 'ETH', now - HOUR).anchors.ETH, undefined);
  const old = { ...s, anchors: { BTC: [now - MAX_BACK_MS - DAY, now - HOUR] } };
  assert.deepEqual(anchorsOf(old, 'BTC', now), [now - HOUR], 'one older than the history reaches is dropped');
});

test('settings from storage are read field by field', () => {
  assert.deepEqual(readVwap(undefined), VWAP_DEFAULTS);
  assert.equal(VWAP_DEFAULTS.on, false, 'off until switched on');
  const read = readVwap({ on: true, period: 'month', bands: 2, anchors: { BTC: [3, 'x', 1, 2, 5, 4], 'bad coin': [1], ETH: 'no' }, labels: 'yes' });
  assert.deepEqual([read.on, read.period, read.bands, read.labels], [true, 'month', 2, true]);
  assert.deepEqual(read.anchors, { BTC: [2, 3, 4, 5] }, 'times only, the newest four, a coin by its name');
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
