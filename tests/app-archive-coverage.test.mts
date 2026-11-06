import test from 'node:test';
import assert from 'node:assert/strict';
import { DepthRecorder, type Column } from '../src/shared/recorder.ts';
import { CONTIGUOUS_GAP_MS, type ColumnSet } from '../src/shared/columns.ts';
import { LT_LENGTH } from '../src/shared/lt-sample.ts';
import { RecordedColumns, toStore, withRange } from '../src/app/worker/column-store.ts';

const MIN = 60_000, T0 = Date.UTC(2026, 10, 5);
const column = (t: number): Column => ({ t, n: 12, bins: Int32Array.from([3900]), bid: Float32Array.from([1]), ask: Float32Array.from([1]) });

test('a book\'s own depth begins where its newest run of minutes begins: a few minutes away do not end it, an hour does', () => {
  const minutes = [...Array.from({ length: 60 }, (_, i) => T0 + i * MIN), ...Array.from({ length: 30 }, (_, i) => T0 + (120 + i) * MIN)];
  // Three minutes missing inside the newest run.
  const held = minutes.filter(t => t !== T0 + 130 * MIN && t !== T0 + 131 * MIN && t !== T0 + 132 * MIN);
  const recorder = new DepthRecorder({ store: { load: () => held.map(t => ({ instrumentId: 'a', column: column(t), step: 20 })), save() {}, prune() {} }, now: () => T0 + 151 * MIN, retentionMs: 86_400_000 });
  assert.equal(recorder.contiguousSince('a', CONTIGUOUS_GAP_MS), T0 + 120 * MIN, 'the hour gap ends the older run; the 3-minute one does not');
  assert.equal(recorder.contiguousSince('b', CONTIGUOUS_GAP_MS), Infinity, 'none held');
  assert.equal(recorder.contiguousSince('a', 4 * 60 * MIN), T0, 'with a wider tolerance, one run');
});

const set = (id: string, times: number[], value: number, lt = false): ColumnSet => ({
  id, step: 20, times, counts: times.map(() => 1), samples: times.map(() => 12),
  bins: Int32Array.from(times.map(() => 3900)), bid: Float32Array.from(times.map(() => value)), ask: Float32Array.from(times.map(() => value)),
  ...(lt ? { lt: new Float32Array(times.length * LT_LENGTH).fill(value) } : {}),
});

test('an arrival splices its range into what the worker holds, keeping the rest', () => {
  const held = toStore(set('a', [0, 1, 2, 3, 4, 5].map(i => T0 + i * 2 * MIN), 1, true));
  const out = withRange(held, set('a', [2, 3, 7].map(i => T0 + i * 2 * MIN), 9), T0 + 2 * 2 * MIN, T0 + 4 * 2 * MIN);
  assert.deepEqual([...out.times], [0, 1, 2, 3, 4, 5].map(i => T0 + i * 2 * MIN), 'window 7 is outside the range: not taken');
  assert.deepEqual([...out.bid], [1, 1, 9, 9, 1, 1]);
  assert.equal(out.lt![0], 1); assert.ok(Number.isNaN(out.lt![2 * LT_LENGTH]!), 'the new windows carry no tracker');
  // Windows the archive adds before what was held.
  const before = withRange(held, set('a', [-2, -1].map(i => T0 + i * 2 * MIN), 5), T0 - 4 * 2 * MIN, T0);
  assert.equal(before.times.length, 8);
  assert.equal(before.times[0], T0 - 2 * 2 * MIN);
  // Another grid: what is held stays.
  const other = { ...set('a', [T0], 7), step: 50 };
  assert.equal(withRange(held, other, T0, T0 + MIN), held);
  // Only books held at the step take a range.
  const recorded = new RecordedColumns(2 * MIN);
  recorded.set(2 * MIN, [set('a', [T0], 1)]);
  recorded.range(2 * MIN, T0 - 10 * MIN, T0, [set('a', [T0 - 2 * MIN], 3), set('b', [T0 - 2 * MIN], 3)]);
  assert.deepEqual(recorded.ids(2 * MIN), ['a']);
  recorded.use(2 * MIN);
  assert.equal(recorded.current.get('a')!.times.length, 2);
  recorded.range(4 * MIN, T0, T0 + MIN, [set('a', [T0], 3)]);
  assert.deepEqual(recorded.steps(), [2 * MIN], 'a step not held is not started by a range');
});
