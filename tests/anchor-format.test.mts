import test from 'node:test';
import assert from 'node:assert/strict';
import { anchorDate, anchorDay, clockYear, fromWallFields, setTimeZone, typedMoment, wallFields } from '../src/app/format.ts';

test('a date and a time typed on the chart\'s clock name one moment; one that does not exist is refused, not moved', () => {
  setTimeZone('utc');
  assert.equal(fromWallFields('2024-11-05', '14:07'), Date.UTC(2024, 10, 5, 14, 7));
  assert.equal(fromWallFields('2024-11-05', ''), Date.UTC(2024, 10, 5), 'no time: midnight');
  assert.equal(fromWallFields('2026-02-30', ''), 'date', 'Feb 30 is refused, not rolled into March');
  assert.equal(fromWallFields('', '10:00'), 'date');
  assert.equal(fromWallFields('2024-11-05', '24:00'), 'time');
  assert.equal(fromWallFields('2024-11-05', '9:5'), 'time');
  assert.deepEqual(wallFields(Date.UTC(2024, 10, 5, 14, 7)), { date: '2024-11-05', time: '14:07' });
});

test('a fixed anchor is named by its date on the chart: its time unless midnight, its year unless this year\'s', () => {
  setTimeZone('utc');
  const now = Date.UTC(2026, 10, 11, 12);
  assert.equal(anchorDate(Date.UTC(2026, 10, 9, 6), now), 'Nov 9 06:00');
  assert.equal(anchorDate(Date.UTC(2026, 10, 9), now), 'Nov 9');
  assert.equal(anchorDate(Date.UTC(2024, 10, 5), now), 'Nov 5, 2024');
  assert.equal(clockYear(Date.UTC(2024, 10, 5, 14, 7), now), 'Nov 5, 2024 14:07');
  assert.equal(anchorDay(Date.UTC(2026, 10, 4, 12), now), 'Nov 4', 'the axis tag: its day alone');
  assert.equal(anchorDay(Date.UTC(2024, 10, 5, 14, 7), now), 'Nov 5, 2024');
});

test('a date field that still says the anchor\'s own moment keeps that very instant; changed, it is read again', () => {
  setTimeZone('utc');
  const own = Date.UTC(2026, 10, 1, 6, 30, 30);   // half a minute past: a reading of the fields alone would drop it
  const w = wallFields(own);
  assert.equal(typedMoment(own, w.date, w.time), own, 'unchanged: the instant itself (the second 01:30 of a clock change stays the second)');
  assert.equal(typedMoment(own, w.date, '07:00'), Date.UTC(2026, 10, 1, 7), 'a time changed: read from the fields');
  assert.equal(typedMoment(null, '2026-11-01', '06:30'), Date.UTC(2026, 10, 1, 6, 30));
  assert.equal(typedMoment(own, '2026-02-30', ''), 'date');
});
