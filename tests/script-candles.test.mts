import test from 'node:test';
import assert from 'node:assert/strict';
import { SCRIPT_WARM_BARS, coverageKey } from '../src/app/panes/heat-pane.ts';
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
