import test from 'node:test';
import assert from 'node:assert/strict';
import { draftOf, follow, inReplay, snap } from '../src/app/range/selection.ts';
import { draftLabel } from '../src/app/range/stats.ts';

const MIN = 60_000, H = 3_600_000, T = Date.UTC(2026, 10, 12, 0);

test('a drag in a pane that sums up its bars holds whole bars as it goes, and says how many', () => {
  const d = draftOf({ t: T + 0.3 * H, p: null }, { t: T + 2.2 * H, p: null }, 'oi', H);
  assert.deepEqual([d.t0, d.t1, d.pane, d.step, d.draft], [T, T + 3 * H, 'oi', H, true], 'from the start of the first candle touched to the end of the last');
  assert.equal(draftLabel(d), '3 candles of 1h');
  assert.equal(draftLabel(draftOf({ t: T + 10 * MIN, p: null }, { t: T + 10 * MIN, p: null }, 'oi', H)), '1 candle of 1h', 'a press alone holds its candle');
  // Elsewhere (the map, the flow column) nothing changes: minutes, no pane.
  const map = draftOf({ t: T + 0.3 * H, p: 100 }, { t: T + 2.2 * H, p: 110 });
  assert.deepEqual([map.t0, map.t1, map.pane, map.step], [T + 0.3 * H, T + 2.2 * H, undefined, undefined]);
});

test('snapped to candles: closed, or live through the forming candle, and following the clock by candles', () => {
  const now = T + 5 * H + 20 * MIN;
  const closed = snap(draftOf({ t: T + 0.5 * H, p: null }, { t: T + 2.5 * H, p: null }, 'oi'), now, H);
  assert.deepEqual([closed.t0, closed.t1, closed.live, closed.step, closed.pane], [T, T + 3 * H, false, H, 'oi']);
  const live = snap(draftOf({ t: T + 3.5 * H, p: null }, { t: T + 9 * H, p: null }, 'oi'), now, H);
  assert.deepEqual([live.t0, live.t1, live.live], [T + 3 * H, T + 6 * H, true], 'ends with the forming candle, never in the future');
  assert.equal(follow(live, now + 10 * MIN), live, 'the same candle: nothing moves');
  assert.equal(follow(live, T + 6 * H + MIN).t1, T + 7 * H, 'a new candle opens: the end moves on a candle');
  // Minutes, as before, for the map.
  const minute = snap(draftOf({ t: T + 30_000, p: null }, { t: T + 150_000, p: null }), now);
  assert.deepEqual([minute.t0, minute.t1, minute.step], [T, T + 3 * MIN, undefined]);
});

test('a replay: snapped to candles, up to the last candle closed by its moment, one candle at least, never live', () => {
  const moment = T + 5 * H + 20 * MIN;
  const live = snap(draftOf({ t: T + 3.5 * H, p: null }, { t: T + 9 * H, p: null }, 'oi'), moment, H);
  const r = inReplay(live, moment, true);
  assert.deepEqual([r.t0, r.t1, r.live], [T + 3 * H, T + 5 * H, false], 'the candle under way at the moment is left out');
  const forming = inReplay(snap(draftOf({ t: T + 5.1 * H, p: null }, { t: T + 5.2 * H, p: null }, 'oi'), moment, H), moment, true);
  assert.deepEqual([forming.t0, forming.t1], [T + 5 * H, T + 5 * H], 'only the forming candle chosen: it holds nothing (no earlier candle nobody chose)');
  // A pane on a one-minute chart: closed minutes only, as on any timeframe (review r3).
  const oneMinute = inReplay(snap(draftOf({ t: T + 5 * H, p: null }, { t: T + 6 * H, p: null }, 'oi'), moment, MIN), moment, true);
  assert.equal(oneMinute.t1, T + 5 * H + 20 * MIN, 'up to the minute the moment is in, not through it');
  const minutes = inReplay(snap(draftOf({ t: T + 5 * H, p: null }, { t: T + 6 * H, p: null }), moment), moment);
  assert.deepEqual([minutes.t1, minutes.live], [T + 5 * H + 20 * MIN, false], 'minutes: up to the minute the moment is in, as before');
});
