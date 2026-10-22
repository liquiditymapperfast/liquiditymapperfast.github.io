import test from 'node:test';
import assert from 'node:assert/strict';
import { applyOiReading, takeOiPushes } from '../src/app/oi-push.ts';
import type { OiBar } from '../src/app/store.ts';

const MIN = 60_000, HOUR = 3_600_000;
const at = (t: number): OiBar => [t, 10, 10, 10, 10];

test('a push is taken only when it is a whole positive reading, and malformed wire changes nothing', () => {
  assert.deepEqual(takeOiPushes([{ instrumentId: 'bybit:BTCUSDT', t: 1_700_000_000_000, base: 12_345 }]), [{ instrumentId: 'bybit:BTCUSDT', t: 1_700_000_000_000, base: 12_345 }]);
  assert.deepEqual(takeOiPushes([{ instrumentId: 'bybit:BTCUSDT', t: 1_700_000_000_000, base: '12_345' }]), [], 'a base that is not a number is not a reading');
  assert.deepEqual(takeOiPushes([{ instrumentId: 'bybit:BTCUSDT', t: -5, base: 10 }]), []);
  assert.deepEqual(takeOiPushes([{ instrumentId: '', t: 5, base: 10 }]), []);
  assert.deepEqual(takeOiPushes([null, 7, { t: 1, base: 2 }]), []);
  assert.deepEqual(takeOiPushes([{ instrumentId: 'bybit:BTCUSD', t: 1_700_000_000_000, base: 12_345, quote: 999_000_000 }]), [{ instrumentId: 'bybit:BTCUSD', t: 1_700_000_000_000, base: 12_345, quote: 999_000_000 }], 'an inverse reading keeps its own USD');
});

test('a reading lands in the bucket of its own time and moves that bar; an older one changes nothing', () => {
  const bars = [at(0), at(MIN)];
  assert.deepEqual(applyOiReading(bars, MIN + 20_000, 25, MIN), [at(0), [MIN, 10, 25, 10, 25]], 'the newest reading is the close, its extremes kept');
  assert.deepEqual(applyOiReading(bars, MIN + 30_000, 8, MIN), [at(0), [MIN, 10, 10, 8, 8]], 'a lower reading inside the newest minute lowers the bar');
  assert.deepEqual(applyOiReading(bars, 2 * MIN, 30, MIN), [at(0), at(MIN), [2 * MIN, 30, 30, 30, 30]], 'a newer minute starts a new bar');
  assert.equal(applyOiReading(bars, 45_000, 30, MIN), null, 'a reading older than the newest bar is stale');
  assert.equal(applyOiReading([at(0), [MIN, 10, 25, 10, 25]], MIN + 40_000, 25, MIN), null, 'a reading that repeats the newest close changes nothing, so a redraw is not forced');
});

test('coarser timeframes bucket several minutes into one bar, and the newest reading wins', () => {
  const bars = [at(0), at(HOUR)];
  const withReading = applyOiReading(bars, HOUR + 5 * MIN, 42, HOUR);
  assert.deepEqual(withReading, [at(0), [HOUR, 10, 42, 10, 42]]);
  assert.deepEqual(applyOiReading(withReading!, HOUR + 30 * MIN, 37, HOUR), [at(0), [HOUR, 10, 42, 10, 37]], 'the hour bar keeps its lowest and ends at the newest reading');
});
