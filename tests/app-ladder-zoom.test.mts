import test from 'node:test';
import assert from 'node:assert/strict';
import { GROUPS, WheelNotches, offsetKeepingPrice, priceAtRow, stepBy } from '../src/app/panes/ladder-zoom.ts';

test('the zoom steps are strictly increasing so that finer and coarser are unambiguous', () => {
  for (let i = 1; i < GROUPS.length; i++) assert.ok(GROUPS[i]! > GROUPS[i - 1]!);
});

test('stepBy moves along the list, from a step that is off it too, and stops at the ends', () => {
  assert.equal(stepBy(10, 1), 25); assert.equal(stepBy(10, -1), 5);
  assert.equal(stepBy(5, 3), 50, 'several notches at once');
  assert.equal(stepBy(5, -2), 1);
  assert.equal(stepBy(20, 1), 25, 'the automatic step 20 is not on the list: coarser is the next one above');
  assert.equal(stepBy(20, -1), 10, 'and finer the next one below');
  assert.equal(stepBy(1000, 1), 1000); assert.equal(stepBy(0.1, -1), 0.1);
  assert.equal(stepBy(5, -99), 0.1); assert.equal(stepBy(5, 99), 1000, 'a long drag clamps to the ends');
  assert.equal(stepBy(2000, 1), 2000, 'beyond the coarsest end it does not jump back');
  assert.equal(stepBy(2000, -1), 1000, 'but finer comes back onto the list');
  assert.equal(stepBy(10, 0), 10); assert.equal(stepBy(0, 1), 0);
  // Every step reachable from every step is on the list, so the Group select always has an option to show.
  for (const s of GROUPS) for (const n of [-3, -1, 1, 3]) assert.ok(GROUPS.includes(stepBy(s, n)));
});

test('the price under the pointer stays on its row when the step changes, and a same-step round trip changes nothing', () => {
  const rows = 40, half = Math.floor(rows / 2);
  for (const mark of [100_003.4, 99_999.9, 61_250.05, 100_000]) for (const offsetRows of [-17, 0, 4]) for (const row of [0, 7, 20, 39]) for (const from of [5, 20, 100]) for (const to of [1, 2, 10, 25, 250]) {
    const price = priceAtRow({ mark, step: from, offsetRows, rows, row });
    assert.equal(offsetKeepingPrice({ mark, step: from, rows, row, price }), offsetRows, 'the same step gives the same offset back');
    const next = offsetKeepingPrice({ mark, step: to, rows, row, price });
    const bin = Math.floor(mark / to) + next + half - row;
    assert.ok(bin * to <= price && price < (bin + 1) * to, `row ${row} still shows ${price} when grouped by ${to} (bin ${bin})`);
  }
});

test('wheel deltas become whole notches: a click is one, a trackpad adds up, a pause or a reversal starts over', () => {
  const w = new WheelNotches();
  assert.equal(w.add(100, 0), 1, 'a click scrolling down');
  assert.equal(w.add(100, 40), 1, 'the next click right after');
  assert.equal(w.add(-100, 80), -1, 'turning back is immediate');
  assert.equal(w.add(120, 1000), 1, 'a click after a pause');
  const pad = new WheelNotches(); let total = 0, t = 0;
  for (let i = 0; i < 9; i++) total += pad.add(10, t += 16);
  assert.equal(total, 0, 'small deltas add up and nothing happens before a notch is reached');
  total += pad.add(10, t += 16);
  assert.equal(total, 1, 'the hundredth pixel is the notch');
  for (let i = 0; i < 20; i++) total += pad.add(10, t += 16);
  assert.equal(total, 3, 'then one more per hundred pixels');
  const small = new WheelNotches();
  assert.equal(small.add(40, 0), 1, 'a deliberate click of a small wheel counts straight away');
  assert.equal(small.add(0, 10), 0); assert.equal(new WheelNotches().add(3, 0), 0, 'a tiny first delta does not');
  const flip = new WheelNotches(); flip.add(8, 0); flip.add(8, 10);
  assert.equal(flip.add(-60, 20), 0, 'reversing drops what had built up the other way');
  assert.equal(flip.add(-60, 30), -1);
});
