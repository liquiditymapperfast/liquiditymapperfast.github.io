import test from 'node:test';
import assert from 'node:assert/strict';
import { GROUPS, WheelNotches, holdsMark, ladderWheel, offsetKeepingPrice, priceAtRow, stepBy } from '../src/app/panes/ladder-zoom.ts';
import { View } from '../src/app/view.ts';

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
  let back = 0;
  for (let i = 0; i < 5; i++) back += flip.add(-20, 20 + i * 10);
  assert.equal(back, -1, 'reversing drops what had built up the other way: five small steps back make exactly one notch');
});

/** Feed `events` (delta, time in ms) to a wheel and return the notches it gave, in order. */
const feed = (wheel: WheelNotches, events: readonly (readonly [number, number])[]): number[] => events.map(([delta, at]) => wheel.add(delta, at)).filter(n => n !== 0);
const clicks = (count: number, every: number, from = 0, delta = 100): [number, number][] => Array.from({ length: count }, (_, i) => [delta, from + i * every]);

test('without limits a wheel gives a notch for every click as fast as they come, and merged clicks count as several (the class on its own)', () => {
  const wheel = new WheelNotches(100, 250, 30, 40, 90); let total = 0, t = 0;
  for (let i = 0; i < 6; i++) total += wheel.add(100, t += 20);
  assert.equal(total, 6);
  const plain = new WheelNotches();
  assert.equal(plain.add(10, 0) + plain.add(10, 10) + plain.add(10, 20), 0, 'with the defaults a device that sends small deltas still needs a hundred pixels');
  const merged = new WheelNotches(100, 250, 30, 40, 90);
  assert.equal(merged.add(200, 0), 2); assert.equal(merged.add(300, 500), 3); assert.equal(merged.add(-200, 1000), -2);
});

test("the book's wheel: a click is a step, but a spin of the wheel is not a dozen of them", () => {
  assert.deepEqual(feed(ladderWheel(), [[100, 0]]), [1], 'one click is one step');
  assert.deepEqual(feed(ladderWheel(), clicks(10, 25)), [1], 'ten clicks in a quarter of a second: one step (this threw the zoom from 20 to 1000)');
  assert.deepEqual(feed(ladderWheel(), clicks(3, 300)), [1, 1, 1], 'three deliberate clicks, 300 ms apart: three steps');
  assert.deepEqual(feed(ladderWheel(), clicks(3, 120)), [1], 'three quick clicks, 120 ms apart: one spin, one step');
  assert.equal(feed(ladderWheel(), clicks(40, 50)).length, 8, 'two seconds of steady spinning: at most four steps a second');
  assert.deepEqual(feed(ladderWheel(), [...clicks(10, 25), [100, 2_000]]), [1, 1], 'a click after a pause is a step again');
  // however many clicks the browser folded into one event, and in whatever unit the display reports them
  assert.deepEqual(feed(ladderWheel(), [[300, 0]]), [1], 'a merged event of three clicks is one step');
  assert.deepEqual(feed(ladderWheel(), [[1000, 0]]), [1], 'a page-sized delta is one step');
  assert.deepEqual(feed(ladderWheel(), [[99, 0]]), [1], 'Firefox: three lines of 33');
  for (const unit of [100, 120, 80, 66.67, 53.33]) {
    const wheel = ladderWheel();
    assert.deepEqual(feed(wheel, [[unit, 0]]), [1], `a lone click of ${unit}`);
    assert.deepEqual(feed(wheel, clicks(6, 40, 1_000, unit)), [1], `six clicks of ${unit} 40 ms apart: a step at once, and the rest are the same spin`);
    assert.deepEqual(feed(wheel, [[-unit, 1_300]]), [-1], 'turning the wheel back is not held up by the gap');
    assert.deepEqual(feed(wheel, [[-unit, 1_340], [-unit, 1_380]]), [], 'and the clicks right after it are inside the gap');
    assert.deepEqual(feed(wheel, [[-unit, 4_000]]), [-1], 'a click after a pause');
  }
});

test("the book's touchpad: a gentle swipe zooms, a long swipe and its momentum are a few steps, and nothing is left to trickle out afterwards", () => {
  const gentle = ladderWheel(); let total = 0, t = 0;
  for (const d of [2, 3, 5, 7, 9, 8, 6, 4, 3, 2]) total += gentle.add(d, t += 16);   // 49 px in all
  assert.equal(total, 1, 'one step for a swipe of about fifty pixels');
  const flick = ladderWheel(); let steps = 0; t = 0;
  for (let i = 0; i < 60; i++) steps += flick.add(20, t += 8);                      // 1200 px in about half a second
  assert.ok(steps >= 1 && steps <= 2, `a flick of half a second: ${steps} (about three steps a second at most)`);
  const swipe = ladderWheel(); const got: number[] = [];
  for (let i = 0; i < 80; i++) { const n = swipe.add(Math.max(1, Math.round(14 * Math.exp(-i / 30))), i * 16); if (n) got.push(n); } // a swipe and its momentum, 1.3 s
  assert.ok(got.length >= 2 && got.length <= 4, `a long swipe with momentum: ${got.length} steps (it made six and went to the end of the list before)`);
  assert.deepEqual(feed(swipe, [[3, 3_000], [3, 3_016], [3, 3_032]]), [], 'nothing was banked: after a pause the next swipe starts from nothing again');
  const back = ladderWheel(); feed(back, [[20, 0], [20, 10], [20, 20]]);
  assert.ok(back.add(-20, 30) <= 0 && back.add(-30, 40) <= 0, 'turning round never gives a notch the old way');
  const turn = ladderWheel(); feed(turn, [[40, 0], [40, 10], [40, 20]]);
  assert.deepEqual(feed(turn, [[-40, 100], [-40, 110], [-40, 120]]), [-1], 'turning back is a step at once (after the fifty pixels it takes), inside the gap');
});

test('zooming about the current price leaves the book centred on it at every step, so the zoom swells the book instead of sliding it', () => {
  const rows = 40, row = Math.floor(rows / 2);
  for (const mark of [85_794, 100_003.4, 61_250.05, 99_999.9]) for (const from of [5, 50, 250]) for (const to of GROUPS) {
    assert.equal(offsetKeepingPrice({ mark, step: to, rows, row, price: mark }), 0, `mark ${mark} stays on the middle row when grouped by ${to} (from ${from})`);
  }
  // About a pointer high in the book the same zoom moves the mark off the middle: that is what the pointer anchor is for.
  const price = priceAtRow({ mark: 85_794, step: 50, offsetRows: 0, rows, row: 5 });
  assert.notEqual(offsetKeepingPrice({ mark: 85_794, step: 5, rows, row: 5, price }), 0);
});

test('a zoom holds the mark while the book is centred on it, the price under the pointer once it is not or with Alt held', () => {
  assert.equal(holdsMark({ offsetRows: 0, alt: false, mark: 84_000 }), true);
  assert.equal(holdsMark({ offsetRows: 3, alt: false, mark: 84_000 }), false, 'scrolled off the mark: about the pointer');
  assert.equal(holdsMark({ offsetRows: -1, alt: false, mark: 84_000 }), false);
  assert.equal(holdsMark({ offsetRows: 0, alt: true, mark: 84_000 }), false, 'Alt asks for the pointer');
  assert.equal(holdsMark({ offsetRows: 0, alt: false, mark: 0 }), false, 'no price yet');
});

test('a drag that holds the mark keeps the book centred as the mark moves between steps; a mark captured at the start does not', () => {
  const rows = 64, row = Math.floor(rows / 2), startMark = 84_203.4;
  // the mark drifts by BTC's usual few dollars while the hand drags the price column through the finest steps
  for (const [mark, step] of [[84_203.4, 20], [84_206.1, 10], [84_209.8, 5], [84_214.2, 2], [84_221.7, 1], [84_233.3, 0.5]] as const) {
    assert.equal(offsetKeepingPrice({ mark, step, rows, row, price: mark }), 0, `the live mark at step ${step}: centred`);
  }
  const stale = offsetKeepingPrice({ mark: 84_221.7, step: 1, rows, row, price: startMark });
  assert.ok(Math.abs(stale) >= 10, `the price captured at the start leaves the book ${stale} rows off the middle`);
  // and about a pointer 8 rows below the middle, the mark leaves the screen at the finest step: why the mark is what a centred zoom holds
  const price = priceAtRow({ mark: startMark, step: 20, offsetRows: 0, rows, row: row + 8 });
  const offset = offsetKeepingPrice({ mark: startMark, step: 1, rows, row: row + 8, price });
  assert.ok(Math.abs(offset) > rows / 2, `offset ${offset} rows: the mark is gone from a book of ${rows} rows`);
});

test('the map zooms its price axis about the current price when asked to: the price stays on the same row however far it is zoomed', () => {
  const v = new View({ t0: 0, t1: 1000, p0: 83_000, p1: 88_000 }), mark = 85_794, height = 600;
  const row = v.yOf(mark, height);
  for (const factor of [0.5, 0.5, 0.8, 1.7, 3, 0.2]) {
    v.zoomPrice(factor, v.yOf(mark, height), height);
    assert.ok(Math.abs(v.yOf(mark, height) - row) < 1e-6, `after x${factor} the mark is still ${row.toFixed(1)} px down, not ${v.yOf(mark, height).toFixed(1)}`);
  }
  // About a point away from the mark the mark moves, which is what zooming about the pointer does.
  const w = new View({ t0: 0, t1: 1000, p0: 83_000, p1: 88_000 });
  w.zoomPrice(0.5, 100, height);
  assert.ok(Math.abs(w.yOf(mark, height) - row) > 5);
});
