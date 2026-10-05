import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_HIGHLIGHT, WARMUP, anomalies, readHighlight } from '../src/app/anomaly.ts';

const steady = (n: number, value = 10) => Array.from({ length: n }, (_, i) => value + (i % 2 ? 1 : -1));

test('a spike above mean + k sigma of the bars before it is flagged, the bars around it are not', () => {
  const values = [...steady(30), 40, ...steady(10)];
  const a = anomalies(values, { length: 20, mult: 2 });
  assert.equal(a.flag[30], 1, 'the spike');
  assert.equal(a.flag.reduce((s, f) => s + f, 0), 1, 'nothing else');
  assert.ok(a.sigma[30]! > 10, 'it is many sigma out');
  assert.ok(a.threshold[30]! < 40 && a.threshold[30]! > 10);
});

test('the bar under test never raises its own threshold', () => {
  const values = [...steady(20), 1000];
  const a = anomalies(values, { length: 20, mult: 2 });
  const without = anomalies(values.slice(0, 20), { length: 20, mult: 2 });
  assert.ok(a.threshold[20]! < 20, 'a 1000 spike does not move its own bar');
  assert.ok(Number.isNaN(without.threshold[WARMUP - 1]) && Number.isFinite(without.threshold[WARMUP]), 'warm-up ends after WARMUP earlier values');
});

test('a higher multiplier is stricter and a longer baseline remembers an old regime', () => {
  const values = [...steady(10, 100), ...steady(40, 10), 30];
  assert.equal(anomalies(values, { length: 30, mult: 2 }).flag[50], 1);
  assert.equal(anomalies(values, { length: 30, mult: 20 }).flag[50], 0, 'k = 20 asks for far more');
  assert.equal(anomalies(values, { length: 50, mult: 2 }).flag[50], 0, 'the old high regime inflates the baseline');
});

test('flat baselines, gaps and short series are safe', () => {
  const flat = anomalies(new Array(40).fill(5), { length: 20, mult: 2 });
  assert.equal(flat.sigma[30], 0);
  assert.equal(flat.flag[30], 0, 'equal to the mean is not above it');
  const gappy = anomalies([...steady(20), NaN, 50], { length: 20, mult: 2 });
  assert.equal(gappy.flag[21], 1);
  assert.equal(gappy.flag[20], 0);
  const short = anomalies([1, 2, 3], { length: 20, mult: 2 });
  assert.ok(short.threshold.every(Number.isNaN) && short.flag.every(f => f === 0));
});

test('saved highlight options are merged over the defaults and kept in range', () => {
  assert.deepEqual(readHighlight(undefined), { ...DEFAULT_HIGHLIGHT });
  assert.deepEqual(readHighlight({ on: false, mult: 3, length: 100 }), { on: false, mult: 3, length: 100 });
  assert.deepEqual(readHighlight({ on: 'yes', mult: 99, length: 1 }), { on: true, mult: 4, length: 12 });
  assert.deepEqual(readHighlight({ mult: NaN }), { ...DEFAULT_HIGHLIGHT });
});
