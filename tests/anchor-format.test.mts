import test from 'node:test';
import assert from 'node:assert/strict';
import { anchorDate, anchorDay, clockYear, fromWallFields, setTimeZone, wallFields } from '../src/app/format.ts';

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
