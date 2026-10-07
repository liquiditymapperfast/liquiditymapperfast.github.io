import test from 'node:test';
import assert from 'node:assert/strict';
import { EDGE, FLOOR, GAP, chooseSide, dragTo, placeOn } from '../src/app/placement.ts';

// Where a panel opens and where it may be dragged, as numbers. The first case is measured: Karl's screen (3840 x 1970 at 150%, so 2560 x 1313
// CSS pixels), the Stats button of the bar stats at 915-934, and the panel's contents about 1,990 px tall (the body alone was 1,922).

const VIEW = { width: 2560, height: 1313 };
const STATS = { left: 2087, top: 915, right: 2124, bottom: 934 };
const WIDTH = 440, NEED = 1_993;

test('a panel too tall for the room below its button opens above it when there is more room there (it used to open below, on 379 px, whenever that was 300 or more)', () => {
  assert.equal(chooseSide(STATS, NEED, VIEW), 'above');
  const at = placeOn('above', STATS, NEED, WIDTH, 'right', VIEW);
  assert.equal(at.maxHeight, STATS.top - GAP - EDGE, 'it may be as tall as the room above, less the gaps');
  assert.equal(at.top, EDGE, 'so it begins at the top of the window');
  assert.equal(at.top + Math.min(NEED, at.maxHeight), STATS.top - GAP, 'and ends just above the button, which stays in sight');
  assert.equal(at.left, STATS.right - WIDTH, 'aligned with the button\'s right edge, as the stats panel asks');
  const below = placeOn('below', STATS, NEED, WIDTH, 'right', VIEW);
  assert.ok(at.maxHeight / NEED > 2 * (below.maxHeight / NEED), 'more than twice as much of it can be seen as below the button');
});

test('a panel opens below its button when it fits there, above when it fits only there, and on the bigger side when it fits nowhere', () => {
  const top = { left: 100, top: 20, right: 160, bottom: 44 };
  assert.equal(chooseSide(top, 300, VIEW), 'below', 'fits below');
  assert.equal(chooseSide(STATS, 300, VIEW), 'below', 'both would do: below is where a menu is looked for');
  assert.equal(chooseSide(STATS, 600, VIEW), 'above', 'does not fit in the 385 px below, fits in the 901 above');
  assert.equal(chooseSide(top, 5_000, VIEW), 'below', 'fits nowhere: the 1,247 px below beat the 6 above');
  assert.equal(chooseSide(STATS, 5_000, VIEW), 'above', 'fits nowhere: the 901 px above beat the 385 below');
  const middle = { left: 0, top: 650, right: 40, bottom: 663 };                                          // 636 px above, 636 below
  assert.equal(chooseSide(middle, 5_000, VIEW), 'below', 'a tie goes below');
  const above600 = placeOn('above', STATS, 600, WIDTH, 'left', VIEW);
  assert.equal(above600.top, STATS.top - GAP - 600, 'a panel that fits hangs from the button by its own height, not by the room');
  assert.equal(above600.maxHeight, STATS.top - GAP - EDGE);
});

test('a panel always lies whole inside the window, is never made shorter than the floor, and keeps off the edges sideways', () => {
  const short = { width: 800, height: 220 };
  const button = { left: 700, top: 100, right: 760, bottom: 124 };
  const at = placeOn(chooseSide(button, 900, short), button, 900, 400, 'left', short);
  assert.ok(at.maxHeight >= FLOOR, `${at.maxHeight}`);
  assert.ok(at.top >= EDGE && at.top + Math.min(900, at.maxHeight) <= short.height - EDGE, `from ${at.top} to ${at.top + Math.min(900, at.maxHeight)} in a window ${short.height} tall`);
  const wide = placeOn('below', { left: 2500, top: 10, right: 2540, bottom: 34 }, 300, 380, 'left', VIEW);
  assert.equal(wide.left, VIEW.width - 380 - EDGE, 'a button at the right edge: the panel is pulled in');
  const near = placeOn('below', { left: 2, top: 10, right: 30, bottom: 34 }, 300, 380, 'right', VIEW);
  assert.equal(near.left, EDGE, 'a button at the left edge with the panel aligned to its right: pulled in the other way');
});

test('dragging keeps the window inside the page, lets the panel grow toward the bottom as it is moved up, and always leaves its title bar to take hold of', () => {
  const size = { width: WIDTH, need: NEED };
  const first = dragTo({ left: 1684, top: 700 }, size, VIEW);
  assert.deepEqual(first, { left: 1684, top: 700, maxHeight: VIEW.height - 700 - EDGE }, 'where it is put it stays, and may be as tall as the room under its top');
  const higher = dragTo({ left: 1684, top: 300 }, size, VIEW);
  assert.ok(higher.maxHeight > first.maxHeight, 'moving it up shows more of what was cut off');
  assert.equal(dragTo({ left: -500, top: -500 }, size, VIEW).left, EDGE);
  assert.equal(dragTo({ left: -500, top: -500 }, size, VIEW).top, EDGE);
  assert.equal(dragTo({ left: -500, top: -500 }, size, VIEW).maxHeight, VIEW.height - 2 * EDGE, 'at the top it may use the whole height of the window');
  const far = dragTo({ left: 9_999, top: 9_999 }, size, VIEW);
  assert.equal(far.left, VIEW.width - WIDTH - EDGE);
  assert.equal(far.top, VIEW.height - EDGE - FLOOR, 'dragged as low as it goes, the floor of it is still showing');
  assert.equal(far.maxHeight, FLOOR);
  const small = dragTo({ left: 0, top: 9_999 }, { width: 300, need: 90 }, VIEW);
  assert.equal(small.top, VIEW.height - EDGE - 90, 'a window shorter than the floor may go as low as its own height allows');
  assert.equal(dragTo({ left: 0, top: 0 }, { width: 5_000, need: 100 }, { width: 800, height: 600 }).left, EDGE, 'a window wider than the page is held at the left edge');
});
