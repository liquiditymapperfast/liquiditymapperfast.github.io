import test from 'node:test';
import assert from 'node:assert/strict';
import { ARCHIVE_MIN_STEP_MS, columnStepFor } from '../src/app/column-holds.ts';

const MIN = 60_000, HOUR = 3_600_000, DAY = 86_400_000;
const NOW = Date.UTC(2026, 10, 6, 1), SINCE = NOW - DAY, ARCHIVE = NOW - 30 * DAY;
/** A two-hour view on a 1,500 px plot: about two pixels a minute. */
const view = (t1: number, span = 2 * HOUR): { t0: number; t1: number } => ({ t0: t1 - span, t1 });

test('an old range at a minute\'s zoom asks for the long history\'s two minutes', () => {
  assert.equal(columnStepFor(view(NOW - 3 * DAY), 1_500, ARCHIVE, SINCE, NOW), ARCHIVE_MIN_STEP_MS);
  assert.equal(ARCHIVE_MIN_STEP_MS, 2 * MIN);
  // One that only starts before the day, and does not reach now, too.
  assert.equal(columnStepFor({ t0: SINCE - HOUR, t1: SINCE + HOUR }, 1_500, ARCHIVE, SINCE, NOW), 2 * MIN);
  // A page with no recordings of its own: all of the past is the archive's.
  assert.equal(columnStepFor(view(NOW - 5 * HOUR), 1_500, ARCHIVE, 0, NOW), 2 * MIN);
});

test('a view inside the page\'s day keeps its minutes', () => {
  assert.equal(columnStepFor(view(NOW - 3 * HOUR), 1_500, ARCHIVE, SINCE, NOW), MIN);
});

test('a view that includes now keeps its minutes for the live overlay, whatever it reaches back to', () => {
  // A first visit: the day began ten minutes ago and the view reaches before it.
  assert.equal(columnStepFor(view(NOW + 5 * MIN), 1_500, ARCHIVE, NOW - 10 * MIN, NOW), MIN);
  assert.equal(columnStepFor(view(NOW), 1_500, ARCHIVE, NOW - 10 * MIN, NOW), MIN);
});

test('without a long history, and at wider zooms, the step is as it always was', () => {
  assert.equal(columnStepFor(view(NOW - 3 * DAY), 1_500, null, SINCE, NOW), MIN, 'no archive: nothing to draw at two minutes either');
  // A day on 1,500 px: two minutes; a week: sixteen.
  assert.equal(columnStepFor(view(NOW - 3 * DAY, DAY), 1_500, ARCHIVE, SINCE, NOW), 2 * MIN);
  assert.equal(columnStepFor(view(NOW - 3 * DAY, 7 * DAY), 1_500, ARCHIVE, SINCE, NOW), 16 * MIN);
  assert.equal(columnStepFor(view(NOW, 7 * DAY), 1_500, ARCHIVE, SINCE, NOW), 16 * MIN);
});
