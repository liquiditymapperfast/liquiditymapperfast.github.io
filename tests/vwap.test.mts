import test from 'node:test';
import assert from 'node:assert/strict';
import { sessionsOf, vwapBarMs, vwapSeries } from '../src/app/vwap/vwap.ts';
import { MAX_ANCHORS, VWAP_DEFAULTS, anchorsOf, readVwap, withAnchor, withoutAnchor } from '../src/app/vwap/settings.ts';
import { visible, vwapCode } from '../src/app/vwap/paint.ts';
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
