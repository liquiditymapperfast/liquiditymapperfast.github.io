import test from 'node:test';
import assert from 'node:assert/strict';
import { MAX_BOTH_SHARE, MAX_COLUMN_SHARE, MIN_COLUMN_W, columnState, defaultPlan, fitColumns, legacyPlan, maxColumnWidth, minWidthOf, moveSide, nudge, openIn, readPlan, samePlan, swapSides, type DockPlan } from '../src/app/layouts/dock-model.ts';
import { readArrangement } from '../src/app/layouts/layouts.ts';

const plan = (patch: Partial<DockPlan> = {}): DockPlan => ({ ...defaultPlan(), ...patch });
const both = { cvd: true, book: true } as const;

test('a plan is read from anything: ids are side panes standing once, a pane left out goes home, sizes are within reason', () => {
  assert.equal(readPlan(null), null);
  assert.equal(readPlan('left'), null);
  assert.equal(readPlan({}), null, 'neither column named: nothing to read');
  assert.deepEqual(readPlan({ left: ['book'], right: [] }), { left: ['book', 'cvd'], right: [], leftW: null, rightW: null, weights: {} }, 'the flow column the file leaves out goes where it goes by default: left, after what is there');
  assert.deepEqual(readPlan({ left: [], right: ['cvd'] })?.right, ['cvd', 'book'], 'the book the file leaves out goes home, to the right, after what is there');
  assert.deepEqual(readPlan({ left: [], right: ['cvd'] })?.left, []);
  assert.deepEqual(readPlan({ left: ['cvd', 'cvd', 'depth', 7, 'book'], right: ['book'] })?.left, ['cvd', 'book'], 'unknown ids dropped, each pane once, the first place named wins');
  assert.deepEqual(readPlan({ left: ['cvd', 'book'], right: ['book'] })?.right, []);
  const r = readPlan({ left: ['cvd'], right: ['book'], leftW: 5, rightW: 1e9, weights: { cvd: 0, book: 99, evil: 3 } })!;
  assert.deepEqual([r.leftW, r.rightW], [150, 4_000]);
  assert.deepEqual(r.weights, { cvd: 0.1, book: 10 });
  assert.equal(readPlan({ left: ['cvd'], right: ['book'], leftW: 'wide', rightW: NaN })!.leftW, null, 'not a number: it follows the window');
});

test('a save from before the panes could move reads as the flow column left of the map and the book right of it, widths only where a drag set them', () => {
  assert.deepEqual(legacyPlan(undefined, undefined), defaultPlan());
  assert.deepEqual(legacyPlan(300, 420), defaultPlan(), 'the widths the columns had before they followed the window were not a choice');
  assert.deepEqual(legacyPlan(321, 480), { left: ['cvd'], right: ['book'], leftW: 321, rightW: 480, weights: {} });
  assert.deepEqual(legacyPlan(287, 394, 287, 394), defaultPlan(), 'a layout\'s widths that are this window\'s own are not a hand\'s either');
});

test('moving a side pane: to the other side, before another, reordered within its column; a closed pane keeps its place', () => {
  const p = plan();
  assert.deepEqual(moveSide(p, 'book', 'left').left, ['cvd', 'book'], 'to the end of the other column');
  assert.deepEqual(moveSide(p, 'book', 'left', 'cvd').left, ['book', 'cvd'], 'before the pane named');
  assert.deepEqual(moveSide(p, 'book', 'left').right, []);
  assert.deepEqual(moveSide(plan({ left: ['cvd', 'book'], right: [] }), 'book', 'left', 'cvd').left, ['book', 'cvd'], 'within its column');
  assert.deepEqual(moveSide(p, 'cvd', 'left', 'book').left, ['cvd'], 'a pane named that is not in the column: the end');
  assert.deepEqual(p, defaultPlan(), 'the plan given is not changed');
});

test('a pane that is alone in its column carries the width it was given to a column with nothing open; a column that takes it in keeps its own', () => {
  const p = plan({ leftW: 310, rightW: 500 });
  const joined = moveSide(p, 'book', 'left');
  assert.deepEqual([joined.left, joined.right, joined.leftW, joined.rightW], [['cvd', 'book'], [], 310, 500], 'both open: it joins the flow column and the left keeps its own width');
  // The flow column is closed: the book is the only open pane of its column, and the column it moves to has nothing open.
  const closedFlow = { cvd: false, book: true } as const;
  const carried = moveSide(p, 'book', 'left', null, closedFlow);
  assert.deepEqual([carried.left, carried.right, carried.leftW, carried.rightW], [['cvd', 'book'], [], 500, null], 'the width goes with it, and the column it left follows the window again');
  const stays = moveSide(plan({ left: [], right: ['cvd', 'book'], rightW: 500 }), 'cvd', 'left', null, both);
  assert.deepEqual([stays.leftW, stays.rightW], [null, 500], 'the column it left still has the book open: its width stays');
  const open = moveSide(plan({ left: ['cvd'], right: ['book'], leftW: 310, rightW: 500 }), 'cvd', 'right', null, both);
  assert.deepEqual([open.leftW, open.rightW], [310, 500], 'the column it lands in has an open pane: nothing carried');
});

test('swapping the sides exchanges the columns, their widths and their order', () => {
  const p = plan({ left: ['cvd', 'book'], right: [], leftW: 300, rightW: null });
  const s = swapSides(p);
  assert.deepEqual([s.left, s.right, s.leftW, s.rightW], [[], ['cvd', 'book'], null, 300]);
  assert.deepEqual(swapSides(swapSides(p)), p, 'twice is the same');
  assert.deepEqual(p.left, ['cvd', 'book'], 'the plan given is not changed');
});

test('a pane steps up or down among the open ones of its column, over a closed one, and stays where there is nowhere to go', () => {
  const stacked = plan({ left: ['cvd', 'book'], right: [] });
  assert.deepEqual(nudge(stacked, 'book', -1, both).left, ['book', 'cvd']);
  assert.equal(nudge(stacked, 'cvd', -1, both), stacked, 'already first');
  assert.equal(nudge(stacked, 'book', 1, both), stacked, 'already last');
  assert.equal(nudge(stacked, 'book', -1, { cvd: false, book: true }), stacked, 'the pane over it is closed: nothing to step over to');
  const three = { ...plan({ left: ['cvd', 'book'], right: [] }) };
  assert.deepEqual(nudge(three, 'cvd', 1, both).left, ['book', 'cvd']);
});

test('a column is laid out when a pane in it is open, a strip of tabs when its panes are all closed, and not there when it holds none', () => {
  const p = plan();
  assert.deepEqual([columnState(p, 'left', both), columnState(p, 'right', both)], ['open', 'open']);
  assert.deepEqual([columnState(p, 'left', { cvd: false, book: true }), columnState(p, 'right', { cvd: false, book: false })], ['rail', 'rail']);
  const stacked = plan({ left: ['cvd', 'book'], right: [] });
  assert.deepEqual([columnState(stacked, 'left', both), columnState(stacked, 'right', both)], ['open', 'none']);
  assert.deepEqual(openIn(stacked, 'left', { cvd: false, book: true }), ['book']);
});

test('the columns never take more of the window than the map can spare, and never go under what their panes need', () => {
  assert.equal(MAX_COLUMN_SHARE < MAX_BOTH_SHARE, true);
  assert.deepEqual(fitColumns(300, 400, 1500, 200, 260), [300, 400], 'room enough: as asked');
  const [l, r] = fitColumns(600, 700, 1200, 200, 260);
  assert.ok(l + r <= 1200 * MAX_BOTH_SHARE + 1, `${l} + ${r}`);
  assert.ok(l >= 200 && r >= 260);
  assert.deepEqual(fitColumns(600, 700, 500, 200, 260), [200, 260], 'a window too narrow for either: the minimums');
  assert.equal(maxColumnWidth(1500, 0, 260), Math.floor(1500 * MAX_COLUMN_SHARE));
  assert.equal(maxColumnWidth(1500, 600, 260), Math.floor(1500 * MAX_BOTH_SHARE - 600), 'with the other column beside it');
  assert.equal(maxColumnWidth(500, 400, 260), 260, 'never under its own minimum');
  assert.equal(minWidthOf(['book']), MIN_COLUMN_W.book);
  assert.equal(minWidthOf(['cvd', 'book']), MIN_COLUMN_W.book, 'the widest need of the panes in it');
  assert.equal(minWidthOf([]), MIN_COLUMN_W.cvd);
});

test('two plans are the same when the panes are in the same places and the sizes are near', () => {
  assert.equal(samePlan(plan(), plan()), true);
  assert.equal(samePlan(plan({ leftW: 300 }), plan({ leftW: 304 })), true, 'within a few pixels');
  assert.equal(samePlan(plan({ leftW: 300 }), plan({ leftW: 340 })), false);
  assert.equal(samePlan(plan({ leftW: 300 }), plan({ leftW: null })), false, 'a hand\'s width is not the window\'s');
  assert.equal(samePlan(plan(), swapSides(plan())), false);
  assert.equal(samePlan(plan({ weights: { cvd: 1 } }), plan()), true, 'a weight of 1 is none');
  assert.equal(samePlan(plan({ weights: { cvd: 2 } }), plan()), false);
});

test('an arrangement keeps where the side panes stand, and one from before has none to read', () => {
  const base = { order: ['heat', 'oi'], heights: { oi: 150 }, sideW: 400, flowW: 280 };
  assert.deepEqual(readArrangement(base), base, 'as it was: nothing added');
  const moved = readArrangement({ ...base, dock: { left: ['book'], right: ['cvd'], leftW: 410, rightW: null, weights: { book: 2 } } })!;
  assert.deepEqual(moved.dock, { left: ['book'], right: ['cvd'], leftW: 410, rightW: null, weights: { book: 2 } });
  assert.deepEqual(moved.order, base.order, 'what an older page reads is still there');
  assert.equal(readArrangement({ ...base, dock: 'left' })!.dock, undefined, 'a dock that is not one is left out, the layout still reads');
});
