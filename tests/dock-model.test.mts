import test from 'node:test';
import assert from 'node:assert/strict';
import { MAX_BOTH_SHARE, MAX_COLUMN_SHARE, MIN_COLUMN_W, MIN_COLUMN_W_TOUCH, WEIGHT_LIMITS, columnState, defaultPlan, fitColumns, laidOutWidths, leadOf, legacyPlan, maxColumnWidth, minWidthOf, moveSide, nudge, openIn, readPlan, samePlan, splitWeights, swapSides, type DockPlan } from '../src/app/layouts/dock-model.ts';
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
  // One column cut to its minimum must not leave the pair over the room (a width of 4,000 px kept beside one of 150 gave a map of a quarter of the window).
  assert.deepEqual(fitColumns(4000, 150, 1500, 200, 260), [670, 260]);
  assert.deepEqual(fitColumns(100, 5000, 1280, 200, 260), [200, 593]);
  // A pair that fits only until each is raised to what its panes need (review 2026-10-31, round 2: 150 + 480 passed unchanged, then 200 + 480 = 680 in 634.88).
  assert.deepEqual(fitColumns(150, 480, 1024, 200, 260), [200, 434]);
  assert.deepEqual(laidOutWidths([150, 480], [200, 260], [true, true], 1024), [200, 434]);
  assert.deepEqual(fitColumns(480, 150, 1024, 200, 260), [374, 260], 'and the other way');
  assert.deepEqual(fitColumns(100, 100, 1500, 200, 260), [200, 260], 'room enough: raised to the minimums');
  let seed = 7;
  const next = (): number => { seed = (seed * 1664525 + 1013904223) % 4294967296; return seed / 4294967296; };
  for (let i = 0; i < 2000; i++) {
    const w = 500 + Math.floor(next() * 3500), a = 100 + Math.floor(next() * 4000), b2 = 100 + Math.floor(next() * 4000), minA = 200, minB = 260;
    const [x, y] = fitColumns(a, b2, w, minA, minB), room = w * MAX_BOTH_SHARE, wa = Math.max(a, minA), wb = Math.max(b2, minB);
    if (wa + wb <= room) assert.deepEqual([x, y], [wa, wb], 'as asked, and no less than each one needs, when there is room');
    else {
      assert.ok(x >= minA && y >= minB, `minimums: ${w} ${a} ${b2} -> ${x} ${y}`);
      assert.ok(x + y <= Math.max(room, minA + minB) + 1, `over the room: ${w} ${a} ${b2} -> ${x} ${y}`);
    }
  }
  assert.equal(maxColumnWidth(1500, 0, 260), Math.floor(1500 * MAX_COLUMN_SHARE));
  assert.equal(maxColumnWidth(1500, 600, 260), Math.floor(1500 * MAX_BOTH_SHARE - 600), 'with the other column beside it');
  assert.equal(maxColumnWidth(500, 400, 260), 260, 'never under its own minimum');
  assert.equal(minWidthOf(['book']), MIN_COLUMN_W.book);
  assert.equal(minWidthOf(['cvd', 'book']), MIN_COLUMN_W.book, 'the widest need of the panes in it');
  assert.equal(minWidthOf([]), MIN_COLUMN_W.cvd);
  assert.equal(minWidthOf(['cvd'], true), MIN_COLUMN_W_TOUCH.cvd, 'the buttons of a touch screen need the flow column wider');
  assert.ok(MIN_COLUMN_W_TOUCH.cvd > MIN_COLUMN_W.cvd && MIN_COLUMN_W_TOUCH.book === MIN_COLUMN_W.book);
  assert.equal(minWidthOf(['book'], true), MIN_COLUMN_W_TOUCH.book);
});

test('a split of two stacked panes is weights that add up to 2 and are read back as they were written (review 2026-10-31, round 2)', () => {
  assert.deepEqual(splitWeights(0.5), [1, 1]);
  assert.deepEqual(splitWeights(0.75), [1.5, 0.5]);
  assert.deepEqual(splitWeights(0), [WEIGHT_LIMITS.min, 1.9], 'a share of nothing keeps the least weight, and the pair still adds up to 2');
  assert.deepEqual(splitWeights(1), [1.9, WEIGHT_LIMITS.min]);
  assert.deepEqual(splitWeights(0.04), [WEIGHT_LIMITS.min, 1.9], 'a 2,250 px stack dragged to the 90 px minimum (review round 3: it came to 0.1 + 1.92)');
  assert.deepEqual(splitWeights(Number.NaN), [1, 1], 'a share that is not one is an even split');
  for (let i = 0; i <= 1000; i++) {
    const share = i / 1000, [a, b] = splitWeights(share);
    assert.ok(a >= WEIGHT_LIMITS.min && a <= WEIGHT_LIMITS.max && b >= WEIGHT_LIMITS.min && b <= WEIGHT_LIMITS.max, `${share}: ${a} ${b}`);
    assert.ok(Math.abs(a + b - 2) < 1e-9, `${share}: ${a} + ${b} adds up to 2`);
    // What a layout file would read back: the same weights (an imported pair of 10 and 10 dragged to 15 and 5 came back as 10 and 5).
    const read = readPlan({ left: ['cvd', 'book'], right: [], leftW: null, rightW: null, weights: { cvd: a, book: b } })!;
    assert.deepEqual([read.weights.cvd, read.weights.book], [a, b], `${share}`);
    if (share >= 0.06 && share <= 0.94) assert.ok(Math.abs(a / (a + b) - share) < 0.001, `${share}: the share is kept`);
  }
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

test('a column that stands alone is laid out within what its panes need and what the window allows (review 2026-10-31: only two open columns were fitted)', () => {
  // A width kept in a wider window (or read from a file) in a window of 1,280 px, the other column closed: the map keeps its share.
  assert.deepEqual(laidOutWidths([300, 1500], [200, 260], [false, true], 1280), [300, Math.floor(1280 * MAX_COLUMN_SHARE)]);
  assert.deepEqual(laidOutWidths([4000, 420], [200, 260], [true, false], 1280), [Math.floor(1280 * MAX_COLUMN_SHARE), 420]);
  // The flow column narrowed to its own minimum, then the book dropped on it: no narrower than the book needs.
  assert.deepEqual(laidOutWidths([200, 420], [260, 260], [true, false], 1600), [260, 420]);
  // A width carried across by a move: the flow column's 200 px on the right where the book stands too.
  assert.deepEqual(laidOutWidths([300, 200], [200, 260], [false, true], 1600), [300, 260]);
  // Two open columns are fitted together as before, and still never under their minimums.
  assert.deepEqual(laidOutWidths([300, 420], [200, 260], [true, true], 1600), fitColumns(300, 420, 1600, 200, 260));
  const [l, r] = laidOutWidths([900, 900], [200, 260], [true, true], 1280);
  assert.ok(l + r <= 1280 * MAX_BOTH_SHARE + 2 && l >= 200 && r >= 260);
  // A layout saved on a wide screen, an asymmetric pair at the narrowest the panes allow (review 2026-10-31: 200 + 560 in a window of 1,024 px left the map 252 px).
  const [a, b] = laidOutWidths([200, 1500], [200, 260], [true, true], 1024);
  assert.deepEqual([a, b], [200, 434]);
  assert.ok(a + b <= 1024 * MAX_BOTH_SHARE && a >= 200 && b >= 260);
  const [c, d] = laidOutWidths([1500, 200], [200, 260], [true, true], 1024);
  assert.ok(c + d <= 1024 * MAX_BOTH_SHARE && c >= 200 && d >= 260, `${c} + ${d}`);
  // A column that is not open keeps what it is asked for (nothing is laid out there).
  assert.deepEqual(laidOutWidths([123, 456], [200, 260], [false, false], 1280), [123, 456]);
  // Sound at any window: an open column is within [its minimum, the window's share] unless the minimum is more than the share.
  for (const w of [320, 640, 900, 1280, 1920, 3840]) for (const want of [150, 300, 900, 4000]) {
    const [x] = laidOutWidths([want, 300], [260, 200], [true, false], w);
    assert.ok(x >= 260 && x <= Math.max(260, w * MAX_COLUMN_SHARE), `${w}/${want}: ${x}`);
  }
});

test('the default width of a column is the book\'s (the wider) whenever the book is open in it, whichever pane is first', () => {
  const stacked = (order: DockPlan['left']): DockPlan => plan({ left: order, right: [] });
  assert.equal(leadOf(stacked(['cvd', 'book']), 'left', both), 'book');
  assert.equal(leadOf(stacked(['book', 'cvd']), 'left', both), 'book');
  assert.equal(leadOf(stacked(['cvd', 'book']), 'left', { cvd: true, book: false }), 'cvd', 'the book is closed there');
  assert.equal(leadOf(stacked(['cvd', 'book']), 'left', { cvd: false, book: false }), 'book', 'nothing open: the column is the one it will be when the book opens');
  assert.equal(leadOf(plan(), 'right', both), 'book');
  assert.equal(leadOf(plan({ left: [], right: [] }), 'left', both), undefined);
});
