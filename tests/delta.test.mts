import test from 'node:test';
import assert from 'node:assert/strict';
import { FlowCache, candleFlow, candleStarts, deltaCandles, resetKeys, unrecorded, type DeltaTrack } from '../src/app/delta/candles.ts';
import { DELTA_DEFAULTS, readDelta } from '../src/app/delta/settings.ts';
import { deltaCardLines } from '../src/app/panes/delta-pane.ts';

const MIN = 60_000, HOUR = 3_600_000, DAY = 86_400_000;
const T = Date.UTC(2026, 9, 9, 12);

/** A track whose running delta at second `s` is `f(s)`, holding seconds from `first`. */
const track = (first: number, f: (sec: number) => number, gross: (sec: number) => number = sec => sec): DeltaTrack => ({ first, cumDelta: f, cumGross: gross });

test('a candle\'s delta is exact at its close; its high and low are sampled through it; a track counts once it holds the second before the candle', () => {
  const s0 = T / 1000;
  // One market climbs 10 a second to the candle's middle and falls back 5 a second; another adds 1 a second all along.
  const a = track(s0 - 100, sec => sec < s0 ? 0 : sec < s0 + 30 ? (sec - s0 + 1) * 10 : 300 - (sec - s0 - 29) * 5);
  const b = track(s0 - 100, sec => sec - (s0 - 100));
  const f = candleFlow([a, b], T, MIN, T + 2 * MIN)!;
  assert.equal(f.delta, a.cumDelta(s0 + 59) - a.cumDelta(s0 - 1) + 60, 'the close: both markets\' changes over the minute');
  assert.ok(f.high >= 300 && f.high <= 330, `sampled high ${f.high}`);
  assert.equal(f.low, 0);
  const late = track(s0 + 10, () => 1_000);
  assert.deepEqual(candleFlow([late], T, MIN, T + 2 * MIN), null, 'a market that begins inside the candle joins from the next');
  assert.equal(candleFlow([a], T, MIN, T + 20_000)!.delta, a.cumDelta(s0 + 19), 'the candle under way: up to now');
});

test('the CVD adds up each candle\'s delta and starts again each day, or after a candle with nothing recorded', () => {
  const starts = [T - 2 * HOUR, T - HOUR, T, T + HOUR];
  const flow = (delta: number) => ({ delta, low: Math.min(0, delta), high: Math.max(0, delta), gross: Math.abs(delta) + 1 });
  const none = deltaCandles(starts, [flow(5), flow(-2), flow(4), flow(1)], resetKeys(starts, 'none', 'UTC'));
  assert.deepEqual(none.map(c => [c.open, c.close]), [[0, 5], [5, 3], [3, 7], [7, 8]]);
  const gap = deltaCandles(starts, [flow(5), null, flow(4), flow(1)], resetKeys(starts, 'none', 'UTC'));
  assert.deepEqual(gap.map(c => [c.t, c.open, c.close, c.run]), [[T - 2 * HOUR, 0, 5, 0], [T, 0, 4, 1], [T + HOUR, 4, 5, 1]], 'what happened in the gap is not known: it starts again');
  const midnight = Date.UTC(2026, 9, 10), days = [midnight - 2 * HOUR, midnight - HOUR, midnight, midnight + HOUR];
  const daily = deltaCandles(days, [flow(5), flow(5), flow(5), flow(5)], resetKeys(days, 'day', 'UTC'));
  assert.deepEqual(daily.map(c => c.open), [0, 5, 0, 5], 'a new day starts at 0');
  // New York's 1 November 2026 is 25 hours: its day starts at 04:00 UTC and the next at 05:00 UTC.
  const ny = [Date.UTC(2026, 10, 2, 4), Date.UTC(2026, 10, 2, 4, 30), Date.UTC(2026, 10, 2, 5)];
  assert.deepEqual(resetKeys(ny, 'day', 'America/New_York'), [Date.UTC(2026, 10, 1, 4), Date.UTC(2026, 10, 1, 4), Date.UTC(2026, 10, 2, 5)]);
});

test('a stretch of ten minutes or more with no volume on any market was not recorded; a shorter one is quiet', () => {
  const s0 = T / 1000;
  // Volume grows except over [T + 2 min, T + 14 min): nothing then.
  const flat = (sec: number) => sec < s0 + 120 ? sec : sec < s0 + 840 ? s0 + 119 : sec - 720;
  const k = track(s0 - 100, sec => sec - s0, flat);
  const starts = Array.from({ length: 16 }, (_, i) => T + i * MIN), now = T + 16 * MIN;
  const flows = starts.map(t => candleFlow([k], t, MIN, now));
  assert.deepEqual(flows.map(f => f!.gross > 0), [true, true, ...Array(12).fill(false), true, true]);
  assert.deepEqual(unrecorded(starts, flows, MIN, now).map(f => f !== null), [true, true, ...Array(12).fill(false), true, true], 'twelve minutes: not recorded');
  const short = flows.map((f, i) => i >= 2 && i < 7 ? f : f && { ...f, gross: 1 });
  assert.deepEqual(unrecorded(starts, short, MIN, now).every(f => f !== null), true, 'five quiet minutes stay');
  const hour = [T], quiet = [{ delta: 0, low: 0, high: 0, gross: 0 }];
  assert.deepEqual(unrecorded(hour, quiet, 3_600_000, T + 3 * MIN), quiet, 'an hour candle three minutes old: quiet so far');
  assert.deepEqual(unrecorded(hour, quiet, 3_600_000, T + 3_600_000), [null], 'a whole hour with nothing: not recorded');
});

test('the candles start at the chart\'s left edge, or at the start of the day or week it falls in, and run to now', () => {
  const t0 = Date.UTC(2026, 9, 9, 10, 30), now = Date.UTC(2026, 9, 9, 12, 10);
  assert.deepEqual(candleStarts(t0, now + HOUR, now, HOUR, 'none', 'UTC'), [Date.UTC(2026, 9, 9, 10), Date.UTC(2026, 9, 9, 11), Date.UTC(2026, 9, 9, 12)]);
  assert.equal(candleStarts(t0, now, now, HOUR, 'day', 'UTC')[0], Date.UTC(2026, 9, 9));
  assert.equal(candleStarts(t0, now, now, HOUR, 'week', 'UTC')[0], Date.UTC(2026, 9, 5), 'Monday');
  assert.equal(candleStarts(t0, now, now, MIN, 'week', 'UTC', 100).length, 100, 'capped, the newest kept');
});

test('closed candles are worked out once; the one under way every time; new older flow starts again', () => {
  let calls = 0;
  const counting = track(0, sec => { calls++; return sec; });
  const cache = new FlowCache(), starts = [T - 2 * MIN, T - MIN, T];
  cache.get('k', [counting], starts, MIN, T + 30_000);
  const first = calls;
  cache.get('k', [counting], starts, MIN, T + 31_000);
  assert.ok(calls - first > 0 && calls - first < first / 2, 'only the open candle again');
  const before = calls; cache.get('k2', [counting], starts, MIN, T + 32_000);
  assert.equal(calls - before, first, 'a new key: all of them');
});

test('settings, and the popup of a candle', () => {
  assert.deepEqual(readDelta(undefined), DELTA_DEFAULTS);
  assert.deepEqual([DELTA_DEFAULTS.style, DELTA_DEFAULTS.reset, DELTA_DEFAULTS.divergence, DELTA_DEFAULTS.pivot], ['candles', 'none', true, 3]);
  assert.deepEqual(readDelta({ style: 'bars', reset: 'week', divergence: false, pivot: 5 }), { style: 'bars', reset: 'week', divergence: false, pivot: 5 });
  assert.deepEqual(readDelta({ reset: 'year', pivot: 4 }), DELTA_DEFAULTS);
  const lines = deltaCardLines({ t: T, delta: -1_500_000, open: 2e6, high: 2.2e6, low: 4e5, close: 5e5, run: 0 }, '1h');
  assert.deepEqual(lines.slice(1).map(l => [l.label, l.text]), [['Delta', '−$1.5M'], ['CVD at the close', '+$500K'], ['CVD high and low', '+$2.2M / +$400K']]);
  void DAY;
});
