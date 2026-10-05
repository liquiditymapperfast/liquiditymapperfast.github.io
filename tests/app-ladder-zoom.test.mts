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

test('a touchpad swipe too gentle for a hundred pixels still zooms, and a flick cannot throw the zoom to the end of the list', () => {
  const gentle = new WheelNotches(100, 250, 30, 40, 90); let total = 0, t = 0;
  for (const d of [2, 3, 5, 7, 9, 8, 6, 4, 3, 2]) total += gentle.add(d, t += 16);   // 49 px in all
  assert.equal(total, 1, 'one notch for a swipe of about fifty pixels');
  const flick = new WheelNotches(100, 250, 30, 40, 90); let notches = 0; t = 0;
  for (let i = 0; i < 60; i++) notches += flick.add(20, t += 8);                      // 1200 px in about half a second
  assert.ok(notches >= 3 && notches <= 6, `about one notch per 90 ms, not thirty: ${notches}`);
  const back = new WheelNotches(100, 250, 30, 40, 90); back.add(20, 0); back.add(20, 10); back.add(20, 20);
  assert.ok(back.add(-20, 30) <= 0 && back.add(-30, 40) <= 0, 'turning round never gives a notch the old way');
});

test('a mouse wheel is unaffected by the touchpad settings: every click is a notch, as fast as they come', () => {
  const wheel = new WheelNotches(100, 250, 30, 40, 90); let total = 0, t = 0;
  for (let i = 0; i < 6; i++) total += wheel.add(100, t += 20);
  assert.equal(total, 6);
  const plain = new WheelNotches();
  assert.equal(plain.add(10, 0) + plain.add(10, 10) + plain.add(10, 20), 0, 'with the defaults a device that sends small deltas still needs a hundred pixels');
});
