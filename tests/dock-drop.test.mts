import test from 'node:test';
import assert from 'node:assert/strict';
import { dropTarget, type DropScene } from '../src/app/layouts/dock-drop.ts';

/** 1500 x 800 working area: the flow column 0-287, the map's column 293-1100, the book 1106-1500; under the map Depth (500-620) and OI (626-776). */
const scene = (over: Partial<DropScene> = {}): DropScene => ({
  main: { x: 0, y: 100, w: 1500, h: 800 }, edge: 300,
  columns: {
    left: { box: { x: 0, y: 100, w: 287, h: 800 }, open: true, panes: [{ id: 'cvd', box: { x: 0, y: 100, w: 287, h: 800 } }] },
    right: { box: { x: 1106, y: 100, w: 394, h: 800 }, open: true, panes: [{ id: 'book', box: { x: 1106, y: 100, w: 394, h: 800 } }] },
  },
  strip: { box: { x: 293, y: 100, w: 807, h: 800 }, panes: [
    { id: 'heat', box: { x: 293, y: 100, w: 807, h: 400 }, fixed: false },
    { id: 'depth', box: { x: 293, y: 500, w: 807, h: 120 }, fixed: true },
    { id: 'oi', box: { x: 293, y: 626, w: 807, h: 150 }, fixed: true },
  ] },
  ...over,
});

test('a pointer outside the working area drops nothing', () => {
  assert.equal(dropTarget(scene(), { kind: 'side', id: 'book' }, 600, 40), null, 'over the top bar');
  assert.equal(dropTarget(scene(), { kind: 'strip', id: 'oi' }, 600, 950), null, 'under the page');
  assert.equal(dropTarget(scene(), { kind: 'side', id: 'book' }, 1600, 300), null, 'past the right edge');
});

test('the book dragged over the flow column goes before it from the upper half, after it from the lower; a pane alone in its own column marks the column', () => {
  const upper = dropTarget(scene(), { kind: 'side', id: 'book' }, 100, 300)!, lower = dropTarget(scene(), { kind: 'side', id: 'book' }, 100, 700)!;
  assert.deepEqual(upper.kind === 'side' && [upper.side, upper.beforeId, upper.area], ['left', 'cvd', false]);
  assert.deepEqual(lower.kind === 'side' && [lower.side, lower.beforeId, lower.area], ['left', null, false]);
  assert.deepEqual(lower.box, { x: 0, y: 898, w: 287, h: 4 }, 'a bar on the foot of the column');
  const own = dropTarget(scene(), { kind: 'side', id: 'cvd' }, 100, 300)!;
  assert.deepEqual(own.kind === 'side' && [own.side, own.beforeId, own.area], ['left', null, true], 'nothing else in the column: the column itself is marked');
  assert.deepEqual(own.box, { x: 0, y: 100, w: 287, h: 800 });
});

test('a pane dropped on a column with several panes goes before the first whose middle is under the pointer, else last', () => {
  const stacked = scene({ columns: {
    left: { box: { x: 0, y: 100, w: 287, h: 800 }, open: true, panes: [{ id: 'cvd', box: { x: 0, y: 100, w: 287, h: 400 } }, { id: 'book', box: { x: 0, y: 500, w: 287, h: 400 } }] },
    right: { box: { x: 1106, y: 100, w: 394, h: 800 }, open: false, panes: [] },
  } });
  const above = dropTarget(stacked, { kind: 'side', id: 'book' }, 100, 150)!;
  assert.deepEqual(above.kind === 'side' && [above.side, above.beforeId, above.area], ['left', 'cvd', false], 'the upper part of the first pane: before it');
  assert.deepEqual(above.box, { x: 0, y: 98, w: 287, h: 4 }, 'a bar on the top edge of that pane');
  const below = dropTarget(stacked, { kind: 'side', id: 'book' }, 100, 450)!;
  assert.deepEqual(below.kind === 'side' && [below.beforeId, below.area], [null, false], 'under the middle of the only other pane: the end');
  assert.deepEqual(below.box, { x: 0, y: 498, w: 287, h: 4 });
  const same = dropTarget(stacked, { kind: 'side', id: 'cvd' }, 100, 150)!;
  assert.equal(same.kind === 'side' && same.beforeId, 'book', 'a pane over its own column counts the others only');
});

test('a column that is not laid out is marked as a strip along the window\'s edge, on the side of the map the pointer is on', () => {
  const noBook = scene({ columns: { left: scene().columns.left, right: { box: { x: 1478, y: 100, w: 22, h: 800 }, open: false, panes: [] } } });
  const t = dropTarget(noBook, { kind: 'side', id: 'cvd' }, 1200, 400)!;
  assert.deepEqual(t.kind === 'side' && [t.side, t.beforeId, t.area], ['right', null, true], 'the right half of the map: the right edge');
  assert.deepEqual(t.box, { x: 1200, y: 100, w: 300, h: 800 }, 'the strip of the mark\'s width at that edge');
  const l = dropTarget(scene({ columns: { left: { box: { x: 0, y: 100, w: 22, h: 800 }, open: false, panes: [] }, right: scene().columns.right } }), { kind: 'side', id: 'book' }, 300, 400)!;
  assert.deepEqual(l.kind === 'side' && [l.side, l.area], ['left', true]);
  assert.deepEqual(l.box, { x: 0, y: 100, w: 300, h: 800 });
  const narrow = dropTarget(scene({ main: { x: 0, y: 100, w: 600, h: 800 }, columns: { left: { box: { x: 0, y: 100, w: 22, h: 800 }, open: false, panes: [] }, right: { box: { x: 578, y: 100, w: 22, h: 800 }, open: false, panes: [] } } }), { kind: 'side', id: 'book' }, 100, 400)!;
  assert.equal(narrow.box.w, 200, 'never more than a third of a narrow window');
});

test('a side pane dropped over the map goes to the nearer side: the middle of the window is the line', () => {
  const t = (x: number) => { const r = dropTarget(scene(), { kind: 'side', id: 'cvd' }, x, 300)!; return r.kind === 'side' ? r.side : null; };
  assert.deepEqual([t(400), t(749), t(751), t(1000)], ['left', 'left', 'right', 'right']);
});

test('a pane under the map goes between the panes under the map: above the first, between, or last; never beside the map', () => {
  const at = (id: string, y: number, x = 600) => dropTarget(scene(), { kind: 'strip', id }, x, y);
  const top = at('oi', 300)!;
  assert.deepEqual(top.kind === 'strip' && top.beforeId, 'depth', 'over the map: first under it');
  assert.deepEqual(top.box, { x: 293, y: 498, w: 807, h: 4 });
  assert.equal((at('depth', 750) as { beforeId: string | null }).beforeId, null, 'under the middle of the last other pane: the end');
  assert.equal((at('depth', 690) as { beforeId: string | null }).beforeId, 'oi', 'over its upper half: before it');
  assert.equal((at('oi', 560) as { beforeId: string | null }).beforeId, null, 'on Depth\'s lower half, which is after Depth: the end, since OI itself does not count');
  assert.equal((at('oi', 520) as { beforeId: string | null }).beforeId, 'depth', 'on Depth\'s upper half: before it');
  assert.equal(at('oi', 400, 100), null, 'over the flow column: not a place for a pane with the map\'s time axis');
  assert.equal(at('oi', 400, 1300), null, 'over the book');
});

test('with no other pane under the map, the mark is at the foot of the column', () => {
  const alone = scene({ strip: { box: { x: 293, y: 100, w: 807, h: 800 }, panes: [{ id: 'heat', box: { x: 293, y: 100, w: 807, h: 600 }, fixed: false }, { id: 'oi', box: { x: 293, y: 706, w: 807, h: 150 }, fixed: true }] } });
  const t = dropTarget(alone, { kind: 'strip', id: 'oi' }, 600, 300)!;
  assert.deepEqual(t.kind === 'strip' && t.beforeId, null);
  assert.deepEqual(t.box, { x: 293, y: 854, w: 807, h: 4 });
});
