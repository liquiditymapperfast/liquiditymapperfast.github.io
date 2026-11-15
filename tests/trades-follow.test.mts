import test from 'node:test';
import assert from 'node:assert/strict';
import { newestStep, scrolledBack } from '../src/app/trades/follow.ts';

// When the Tape's lists follow their newest row (2026-11-15, Karl in Safari: with 1 second "you always have to scroll manually to the latest
// row"; review r19). Positions are larger for newer rows (a block's second, an order's write number).

test('a held list is scrolled back only when it stands older than the row its hold began at', () => {
  // Held at second 100; rows 101, 102, ... arrive above it while the mouse rests there.
  assert.equal(scrolledBack(100, 100, 0), false, 'where the hold began');
  assert.equal(scrolledBack(100, 100, 12), true, 'that row part scrolled out at the top: a step down');
  assert.equal(scrolledBack(100, 100, 0.4), false, 'a residue under half a pixel is no scroll');
  assert.equal(scrolledBack(97, 100, 0), true, 'older rows: scrolled back, it stays held when the mouse leaves');
  // Review r19: a trackpad's step up after the mouse rested 3 s climbed into a row that had arrived meanwhile (not yet the newest) and the
  // list stayed held after the mouse left. Up toward newer rows is never scrolled back.
  assert.equal(scrolledBack(101, 100, 31), false, 'up into a row that arrived meanwhile, part hidden');
  assert.equal(scrolledBack(103, 100, 0), false);
  // A start not known (no hold): nothing is scrolled back, and leaving lets go.
  assert.equal(scrolledBack(100, Number.NaN, 20), false);
});

test('a step that ends on the newest row lets the list follow when it is up or the mouse is off; the mouse keeps it at the top for a nudge', () => {
  // Up into the newest row, or back to its top, follows, the mouse on the list or not (the wheel's mouse always is).
  assert.equal(newestStep(-120, -80, true, false), 'follow', 'a wheel step back to the newest');
  assert.equal(newestStep(-4, 32, true, false), 'follow', 'a trackpad step up into the newest row, part hidden: its top');
  assert.equal(newestStep(-4, 32, false, false), 'follow', 'a finger');
  // Not up: with the mouse on the list it stays held at the top (review r19: zero and sub-pixel steps released it); a finger lets go.
  assert.equal(newestStep(0.3, 0.3, true, false), 'top');
  assert.equal(newestStep(0.45, 0.45, true, false), 'top');
  assert.equal(newestStep(0.3, 0.3, false, false), 'follow');
  // Scrolled into the newest row (down past half a pixel): not the top.
  assert.equal(newestStep(20, 20, true, false), null);
  assert.equal(newestStep(0.6, 0.6, false, false), null);
  // A chosen block or pinned row keeps the list held at the top, whatever the step.
  assert.equal(newestStep(-120, -80, true, true), 'top');
  assert.equal(newestStep(-4, 32, false, true), 'top');
  assert.equal(newestStep(20, 20, true, true), null);
});
