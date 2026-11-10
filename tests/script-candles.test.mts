import test from 'node:test';
import assert from 'node:assert/strict';
import { SCRIPT_WARM_BARS, coverageKey } from '../src/app/panes/heat-pane.ts';
import { liveUpdate } from '../src/app/script/bars.ts';
import type { CandleRow } from '../src/app/store.ts';

const H = 3_600_000;
const bar = (hour: number, close = 100): CandleRow => [hour * H, 100, 101, 99, close, 1] as unknown as CandleRow;

test('the history rows\' memo key follows what the candles cover: a gap moved inside the series is a change, the forming candle\'s prices are not', () => {
  const a = [bar(20), bar(22), bar(24)], b = [bar(20), bar(23), bar(24)];
  assert.notEqual(coverageKey(a, 0), coverageKey(b, 0), 'the same count and ends, another candle inside (Sol, 2026-11-03)');
  assert.equal(coverageKey(a, 0), coverageKey([bar(20), bar(22), bar(24, 120)], 0), 'the forming candle moving changes nothing');
  assert.notEqual(coverageKey(a, 0), coverageKey(a, 1), 'a replay\'s next candle is a change');
  assert.notEqual(coverageKey(a, 0), coverageKey([...a, bar(25)], 0));
  assert.equal(coverageKey([], 0), coverageKey([], 0));
  assert.ok(SCRIPT_WARM_BARS >= 48, 'the VWAP script\'s window fits in the warm-up');
});

test('the scripts\' series keeps its rows only for a live update of the last candle: a candle corrected inside a list read again rebuilds it', () => {
  const a = [bar(20), bar(21), bar(22)], rows = [bar(10), bar(11), ...a];
  assert.equal(liveUpdate(a, [a[0]!, a[1]!, bar(22, 130)], rows), true, 'only the candle under way changed: its row replaced');
  // Sol, code review 2026-11-10, round 3: the same count and ends, the hub's reload read again, a closed candle's close 100 then 220.
  assert.equal(liveUpdate(a, [a[0]!, bar(21, 220), a[2]!], rows), false, 'a closed candle corrected inside: built again');
  assert.equal(liveUpdate(a, [bar(20), bar(21), bar(22)], rows), false, 'a list read again (new rows) is built again, whatever its figures');
  assert.equal(liveUpdate(a, [...a, bar(23)], rows), false, 'a new candle: built again');
  assert.equal(liveUpdate(a, [a[0]!, a[1]!, bar(22, 130)], [bar(10), a[0]!, a[1]!]), false, 'a series that does not end with the last candle is built again');
  assert.equal(liveUpdate([], [], []), false);
});
