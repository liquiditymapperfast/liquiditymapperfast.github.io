import test from 'node:test';
import assert from 'node:assert/strict';
import { arrowHead, clampRect, fileName, hitHandle, inside, rectFrom, resizeRect, snapAngle, squareTo, toolbarPlacement, worthKeeping, type Shape } from '../src/app/screenshot/shapes.ts';
import { splitTop } from '../src/app/screenshot/capture.ts';

const screen = { w: 1200, h: 800 };

test('a rectangle dragged in any direction has positive size', () => {
  assert.deepEqual(rectFrom({ x: 100, y: 80 }, { x: 40, y: 20 }), { x: 40, y: 20, w: 60, h: 60 });
  assert.deepEqual(rectFrom({ x: 5, y: 5 }, { x: 5, y: 5 }), { x: 5, y: 5, w: 0, h: 0 });
});

test('a rectangle is kept on screen', () => {
  assert.deepEqual(clampRect({ x: -20, y: 790, w: 100, h: 50 }, screen), { x: 0, y: 750, w: 100, h: 50 });
  assert.deepEqual(clampRect({ x: 0, y: 0, w: 5000, h: 5000 }, screen), { x: 0, y: 0, w: 1200, h: 800 });
});

test('handles are found near their corner and edge points, nearest first', () => {
  const r = { x: 100, y: 100, w: 200, h: 100 };
  assert.equal(hitHandle(r, { x: 103, y: 98 }), 'nw');
  assert.equal(hitHandle(r, { x: 200, y: 101 }), 'n');
  assert.equal(hitHandle(r, { x: 300, y: 150 }), 'e');
  assert.equal(hitHandle(r, { x: 200, y: 150 }), null, 'the middle of the area is not a handle');
});

test('resizing moves only the grabbed edges, keeps a minimum size and stays inside the screen', () => {
  const r = { x: 100, y: 100, w: 200, h: 100 };
  assert.deepEqual(resizeRect(r, 'se', { x: 400, y: 260 }, screen), { x: 100, y: 100, w: 300, h: 160 });
  assert.deepEqual(resizeRect(r, 'w', { x: 60, y: 999 }, screen), { x: 60, y: 100, w: 240, h: 100 }, 'a west edge ignores vertical movement');
  assert.deepEqual(resizeRect(r, 'e', { x: 90, y: 150 }, screen, 12), { x: 100, y: 100, w: 12, h: 100 }, 'cannot collapse');
  assert.equal(resizeRect(r, 'se', { x: 5000, y: 5000 }, screen).w, 1100);
  assert.deepEqual(resizeRect(r, 'nw', { x: 500, y: 500 }, screen, 12), { x: 288, y: 188, w: 12, h: 12 }, 'dragging a corner past the opposite one stops at the minimum');
});

test('inside is inclusive of the edges', () => {
  assert.ok(inside({ x: 0, y: 0, w: 10, h: 10 }, { x: 10, y: 10 }));
  assert.ok(!inside({ x: 0, y: 0, w: 10, h: 10 }, { x: 10.1, y: 5 }));
});

test('the toolbar goes under the selection, flips above, or sits inside when the selection fills the screen', () => {
  const bar = { w: 520, h: 52 };
  assert.deepEqual(toolbarPlacement({ x: 100, y: 100, w: 400, h: 200 }, bar, screen), { x: 8, y: 310 }, 'right-aligned to the selection but kept on screen');
  assert.deepEqual(toolbarPlacement({ x: 600, y: 100, w: 500, h: 200 }, bar, screen), { x: 580, y: 310 });
  assert.equal(toolbarPlacement({ x: 100, y: 500, w: 400, h: 280 }, bar, screen).y, 500 - 10 - 52, 'above when there is no room below');
  const full = toolbarPlacement({ x: 0, y: 0, w: 1200, h: 800 }, bar, screen);
  assert.ok(full.y > 600 && full.y <= 800 - 52 - 8, 'inside the bottom edge');
});

test('an arrow head sits at the tip, symmetric about the shaft', () => {
  const [l, r] = arrowHead({ x: 0, y: 0 }, { x: 100, y: 0 }, 4);
  assert.ok(l.x < 100 && r.x < 100);
  assert.ok(Math.abs(l.x - r.x) < 1e-9 && Math.abs(l.y + r.y) < 1e-9);
  const [shortL] = arrowHead({ x: 0, y: 0 }, { x: 6, y: 0 }, 8);
  assert.ok(Math.hypot(6 - shortL.x, shortL.y) < 24, 'a short arrow does not get a huge head');
});

test('a click without a drag leaves nothing behind', () => {
  const dot: Shape = { kind: 'rect', a: { x: 5, y: 5 }, b: { x: 6, y: 6 }, color: '#f00', width: 4 };
  assert.ok(!worthKeeping(dot));
  assert.ok(worthKeeping({ kind: 'rect', a: { x: 5, y: 5 }, b: { x: 50, y: 40 }, color: '#f00', width: 4 }));
  assert.ok(!worthKeeping({ kind: 'text', at: { x: 0, y: 0 }, text: '   ', color: '#f00', size: 22 }));
  assert.ok(!worthKeeping({ kind: 'pen', points: [{ x: 1, y: 1 }], color: '#f00', width: 4 }));
  assert.ok(!worthKeeping({ kind: 'pixelate', rect: { x: 0, y: 0, w: 2, h: 40 }, strength: 10 }));
});

test('files are named by date and time', () => {
  assert.equal(fileName(new Date(2026, 9, 5, 14, 3, 7)), 'liquiditymapperfast-2026-10-05-1403-07.png');
});

test('shift keeps a rectangle square and a line on a multiple of 45 degrees', () => {
  assert.deepEqual(squareTo({ x: 10, y: 10 }, { x: 60, y: 30 }), { x: 60, y: 60 });
  assert.deepEqual(squareTo({ x: 10, y: 10 }, { x: -20, y: 25 }), { x: -20, y: 40 });
  const near = snapAngle({ x: 0, y: 0 }, { x: 100, y: 6 });
  assert.ok(Math.abs(near.y) < 1e-9 && Math.abs(near.x - Math.hypot(100, 6)) < 1e-9, 'almost horizontal snaps to horizontal');
  const diagonal = snapAngle({ x: 0, y: 0 }, { x: 50, y: 44 });
  assert.ok(Math.abs(diagonal.x - diagonal.y) < 1e-9, 'almost diagonal snaps to the diagonal');
});

test('commas inside a function do not split a CSS value', () => {
  assert.deepEqual(splitTop('to right, rgb(1, 2, 3) 0%, rgba(4, 5, 6, 0.5) 100%'), ['to right', 'rgb(1, 2, 3) 0%', 'rgba(4, 5, 6, 0.5) 100%']);
  assert.deepEqual(splitTop(''), []);
});
