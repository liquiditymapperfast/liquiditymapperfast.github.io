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

test('a coin whose tiles start at eight minutes (ETH, SOL) draws its old ranges at eight, never at two or four', () => {
  const EIGHT = 8 * MIN;
  assert.equal(columnStepFor(view(NOW - 3 * DAY), 1_500, ARCHIVE, SINCE, NOW, EIGHT), EIGHT, 'a minute\'s zoom');
  // A view whose own step would be two or four minutes is lifted too: the archive has no window at either.
  assert.equal(columnStepFor(view(NOW - 3 * DAY, DAY), 1_500, ARCHIVE, SINCE, NOW, EIGHT), EIGHT);
  assert.equal(columnStepFor(view(NOW - 3 * DAY, 2 * DAY), 1_500, ARCHIVE, SINCE, NOW, EIGHT), EIGHT);
  assert.equal(columnStepFor(view(NOW - 3 * DAY, 7 * DAY), 1_500, ARCHIVE, SINCE, NOW, EIGHT), 16 * MIN, 'wider zooms as they always were');
  // Inside the page's day, and with now in view, the page's own minutes.
  assert.equal(columnStepFor(view(NOW - 3 * HOUR), 1_500, ARCHIVE, SINCE, NOW, EIGHT), MIN);
  assert.equal(columnStepFor(view(NOW), 1_500, ARCHIVE, NOW - 10 * MIN, NOW, EIGHT), MIN);
  assert.equal(columnStepFor(view(NOW - 3 * DAY), 1_500, null, SINCE, NOW, EIGHT), MIN, 'no archive: as before');
});

test('a coin whose hours carry no book minutes (ETH, SOL) draws a live view reaching before the page\'s recording from its tiles', () => {
  const EIGHT = 8 * MIN, OPENED = NOW - 10 * MIN;
  // A tab opened ten minutes ago, at the default zoom: a minute's step would leave all but its last ten minutes blank.
  assert.equal(columnStepFor(view(NOW), 1_500, ARCHIVE, OPENED, NOW, EIGHT, true), EIGHT);
  assert.equal(columnStepFor(view(NOW + 5 * MIN), 1_500, ARCHIVE, OPENED, NOW, EIGHT, true), EIGHT);
  // Two or four minutes are lifted too (the tiles have neither); wider zooms as they always were.
  assert.equal(columnStepFor(view(NOW, DAY), 1_500, ARCHIVE, OPENED, NOW, EIGHT, true), EIGHT);
  assert.equal(columnStepFor(view(NOW, 7 * DAY), 1_500, ARCHIVE, OPENED, NOW, EIGHT, true), 16 * MIN);
  // Once the tab has recorded the whole view, its own minutes; and with no tiles, as before.
  assert.equal(columnStepFor(view(NOW), 1_500, ARCHIVE, NOW - 3 * HOUR, NOW, EIGHT, true), MIN);
  assert.equal(columnStepFor(view(NOW), 1_500, null, OPENED, NOW, EIGHT, true), MIN);
  // BTC (its hours carry its minutes, imported for the day): a live view keeps its minutes.
  assert.equal(columnStepFor(view(NOW), 1_500, ARCHIVE, OPENED, NOW), MIN);
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
