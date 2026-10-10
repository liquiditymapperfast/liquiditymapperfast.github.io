import test from 'node:test';
import assert from 'node:assert/strict';
import { oiChange, rangeLines, type RangeInput } from '../src/app/range/stats.ts';
import type { OiBar } from '../src/app/store.ts';

const MIN = 60_000, T = Date.UTC(2026, 9, 9, 12);
/** A sample a minute from `from`, the values given. */
const bars = (from: number, values: number[]): OiBar[] => values.map((v, i) => [from + i * MIN, v, v, v, v]);

test('the open interest at the start (the sample before, if recent), at the end (the last inside), and the extremes inside', () => {
  const b = bars(T - 3 * MIN, [100, 101, 102, 104, 110, 98, 103, 120]);
  assert.deepEqual(oiChange(b, T, T + 4 * MIN), { start: 102, end: 103, low: 98, high: 110 }, 'start = the sample of the minute before');
  assert.deepEqual(oiChange(bars(T, [50, 60]), T, T + 2 * MIN), { start: 50, end: 60, low: 50, high: 60 }, 'nothing before: the first inside');
  assert.equal(oiChange(bars(T - 30 * MIN, [50]), T, T + 2 * MIN), null, 'a sample half an hour old does not stand for the start, and nothing is inside');
  assert.equal(oiChange([], T, T + MIN), null);
});

test('the Range panel says it for one market, in coins, percent and dollars, and not when it was not asked', () => {
  const sel = { t0: T, t1: T + 4 * MIN, p0: null, p1: null, live: false, draft: false } as unknown as RangeInput['sel'];
  const base: RangeInput = { sel, answer: null, error: null, marks: null, resting: null, prints: null, kind: () => 'perp' };
  const text = (input: RangeInput) => rangeLines(input).filter(l => l.key.startsWith('oi') || l.key === 'h-oi').map(l => l.cells.join(' | '));
  assert.deepEqual(text(base), [], 'not asked: no section');
  assert.deepEqual(text({ ...base, oi: 'asking' }), ['Open interest', 'Adding up…']);
  const lines = text({ ...base, oi: { inst: 'binance:BTCUSDT', bars: bars(T - MIN, [92_000, 92_100, 91_950, 92_050, 92_092]), coin: 'BTC', price: 82_000 } });
  assert.equal(lines[1], 'Market | Binance BTCUSDT');
  assert.equal(lines[2], 'At the start and the end | 92,000 BTC → 92,092 BTC');
  assert.equal(lines[3], 'Change | +92 BTC · +0.10% · +$7.5M');
  assert.equal(lines[4], 'Lowest and highest | 91,950 BTC / 92,100 BTC');
});
