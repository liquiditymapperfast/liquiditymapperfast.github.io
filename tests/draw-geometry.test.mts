import test from 'node:test';
import assert from 'node:assert/strict';
import { EDGE_MIN, axisOf, edgeMinFor, channelLines, deltaOf, distToSegment, extendSegment, fibLevels, handlesOf, hitDrawing, sameHit, strokesOf, withHandleAt, type Projection } from '../src/app/draw/geometry.ts';
import { newDrawing } from '../src/app/draw/model.ts';

const T = Date.UTC(2026, 9, 28, 0), H = 3_600_000;
/** A plot 1000 x 500 px over 10 hours and the prices 100 to 200: 100 px an hour, 5 px a dollar. */
const pr: Projection = { x: t => (t - T) / H * 100, y: p => (200 - p) * 5, t: x => T + x / 100 * H, p: y => 200 - y / 5, w: 1000, h: 500 };
const at = (hours: number, p: number): { t: number; p: number } => ({ t: T + hours * H, p });
const size = () => ({ w: 60, h: 18 });

test('a line is clipped to the box, between its points or run on past either end', () => {
  const box = { x0: 0, y0: 0, x1: 100, y1: 100 };
  assert.deepEqual(extendSegment({ x: 20, y: 20 }, { x: 40, y: 40 }, false, false, box), { a: { x: 20, y: 20 }, b: { x: 40, y: 40 } });
  assert.deepEqual(extendSegment({ x: 20, y: 20 }, { x: 40, y: 40 }, false, true, box), { a: { x: 20, y: 20 }, b: { x: 100, y: 100 } }, 'a ray');
  assert.deepEqual(extendSegment({ x: 20, y: 20 }, { x: 40, y: 40 }, true, true, box), { a: { x: 0, y: 0 }, b: { x: 100, y: 100 } }, 'both ways');
  assert.equal(extendSegment({ x: 200, y: 200 }, { x: 300, y: 300 }, false, false, box), null, 'off the box');
  assert.equal(distToSegment({ x: 30, y: 0 }, { a: { x: 0, y: 10 }, b: { x: 100, y: 10 } }), 10);
  assert.equal(distToSegment({ x: -30, y: 10 }, { a: { x: 0, y: 10 }, b: { x: 100, y: 10 } }), 30, 'past the end: to the end');
});

test('the retracement runs from 1 at its first point to 0 at its second; the channel\'s parallel keeps its price offset', () => {
  const fib = newDrawing('fib', [at(1, 100), at(3, 200)], T);
  const levels = fibLevels(fib, pr);
  assert.deepEqual(levels.map(l => Math.round(l.price * 10) / 10), [200, 176.4, 161.8, 150, 138.2, 121.4, 100]);
  assert.deepEqual([levels[0]!.x0, levels[0]!.x1], [100, 300]);
  assert.equal(fibLevels({ ...fib, extendRight: true }, pr)[0]!.x1, 1000, 'to the right edge');
  const ch = newDrawing('channel', [at(0, 150), at(4, 170), at(2, 140)], T);
  const lines = channelLines(ch, pr);
  assert.equal(lines.offset, -20, 'the third point is 20 under the line at its time');
  assert.deepEqual([lines.parallel!.a.y - lines.base!.a.y, lines.parallel!.b.y - lines.base!.b.y], [100, 100], '20 dollars = 100 px all along');
});

test('a level runs across the map, or from its anchor to the right as a ray; a vertical line\'s handle is halfway down', () => {
  const level = newDrawing('level', [at(5, 150)], T);
  const [s] = strokesOf(level, pr);
  assert.ok(s!.a.x < 0 && s!.b.x > 1000 && s!.a.y === 250);
  const ray = strokesOf({ ...level, extendLeft: false }, pr)[0]!;
  assert.equal(ray.a.x, 500, 'from its anchor');
  assert.deepEqual(handlesOf(newDrawing('vline', [at(2, 1)], T), pr), [{ x: 200, y: 250, t: [0], p: [] }], 'it moves in time alone');
});

test('the pointer finds the selected drawing\'s handles first, then the topmost stroke, then a zone\'s inside; hidden ones never', () => {
  const zone = newDrawing('zone', [at(1, 180), at(4, 160)], T), trend = newDrawing('trend', [at(0, 195), at(9, 125)], T);
  const list = [zone, trend];
  assert.deepEqual(hitDrawing({ x: 101, y: 101 }, list, pr, 6, zone.id, size), { id: zone.id, part: 'handle', index: 0, axis: 'both' }, 'a corner of the selected zone');
  assert.deepEqual(hitDrawing({ x: 101, y: 101 }, list, pr, 6, null, size), { id: zone.id, part: 'stroke' }, 'not selected: its edge');
  assert.deepEqual(hitDrawing({ x: 250, y: 150 }, list, pr, 6, null, size), { id: zone.id, part: 'inside' });
  // The trend line crosses the zone: drawn last, it is on top.
  const y = pr.y(195 + (125 - 195) * (2.5 / 9));
  assert.deepEqual(hitDrawing({ x: 250, y }, list, pr, 6, null, size), { id: trend.id, part: 'stroke' });
  assert.equal(hitDrawing({ x: 250, y: 150 }, [{ ...zone, hidden: true }], pr, 6, null, size), null);
  const note = newDrawing('note', [at(6, 120)], T);
  assert.deepEqual(hitDrawing({ x: 640, y: 370 }, [note], pr, 6, null, size), { id: note.id, part: 'stroke' }, 'on its text box');
});

test('a pointer\'s move is the same time and price wherever it starts', () => {
  assert.deepEqual(deltaOf(pr, { x: 100, y: 100 }, { x: 150, y: 90 }), { dt: H / 2, dp: 2 });
  assert.deepEqual(deltaOf(pr, { x: 700, y: 400 }, { x: 750, y: 390 }), { dt: H / 2, dp: 2 });
});

test('left and right are by time: a line placed from right to left runs on to the right edge past its right-hand point', () => {
  const backwards = { ...newDrawing('trend', [at(6, 150), at(2, 130)], T), extendRight: true };
  const [s] = strokesOf(backwards, pr);
  assert.ok(Math.max(s!.a.x, s!.b.x) > 1000 && Math.min(s!.a.x, s!.b.x) === 200, 'from its left point at 2 h on past the right edge');
  const ch = { ...newDrawing('channel', [at(6, 170), at(2, 150), at(4, 140)], T), extendRight: true };
  const { base } = channelLines(ch, pr);
  assert.ok(Math.max(base!.a.x, base!.b.x) > 1000);
});

test('a zone has eight handles: its corners, and the middle of each edge that has room for one; a point has one', () => {
  // The zone from 1 h at 180 to 4 h at 160: its corners at (100, 100) and (400, 200), 300 px wide and 100 px high.
  const zone = newDrawing('zone', [at(1, 180), at(4, 160)], T);
  const hs = handlesOf(zone, pr);
  assert.deepEqual(hs.map(h => [h.x, h.y]), [[100, 100], [400, 200], [100, 200], [400, 100], [250, 100], [250, 200], [100, 150], [400, 150]],
    'the two points, the two corners with no point, the top and the bottom, the left and the right');
  assert.deepEqual(hs.map(h => axisOf(h)), ['both', 'both', 'both', 'both', 'p', 'p', 't', 't']);
  assert.deepEqual([hs[2]!.t, hs[2]!.p, hs[3]!.t, hs[3]!.p], [[0], [1], [1], [0]], 'a corner takes one point\'s time and the other\'s price');
  assert.deepEqual([hs[4]!.p, hs[5]!.p, hs[6]!.t, hs[7]!.t], [[0], [1], [0], [1]], 'the top is the point with the higher price, the left the one earlier in time');
  // Placed from the lower right to the upper left, the same box: the top and the left are the other points.
  const backwards = handlesOf(newDrawing('zone', [at(4, 160), at(1, 180)], T), pr);
  assert.deepEqual([backwards[4]!.p, backwards[5]!.p, backwards[6]!.t, backwards[7]!.t], [[1], [0], [1], [0]]);
  assert.equal(handlesOf(newDrawing('trend', [at(1, 180), at(4, 160)], T), pr).length, 2, 'a line has its two points');
  assert.equal(handlesOf(newDrawing('channel', [at(1, 180), at(4, 160), at(2, 150)], T), pr).length, 3);
});

test('a short edge has no middle handle; a zone that runs on has its top, bottom and left; one half out of view keeps its middles in view', () => {
  const small = newDrawing('zone', [at(1, 180), at(1.2, 176)], T);   // 20 px wide, 20 px high
  assert.equal(handlesOf(small, pr).length, 4, 'only corners: a middle would sit among them');
  const wide = newDrawing('zone', [at(1, 180), at(1 + EDGE_MIN / 100, 140)], T);   // EDGE_MIN px wide, 200 px high
  assert.deepEqual(handlesOf(wide, pr).slice(4).map(h => axisOf(h)), ['p', 'p', 't', 't']);
  const runs = { ...newDrawing('zone', [at(1, 180), at(4, 160)], T), extendRight: true };
  const hs = handlesOf(runs, pr);
  assert.deepEqual(hs.map(h => [h.x, h.y]), [[100, 100], [400, 200], [100, 200], [550, 100], [550, 200], [100, 150]], 'the corner at its left that no point is at, the top and bottom in the part in view, the left side: nothing at a right edge it does not have');
  // The box from 8 h to 15 h is half past the right edge (1000 px), and the one from -5 h to 3 h half past the left.
  const right = handlesOf(newDrawing('zone', [at(8, 180), at(15, 160)], T), pr).slice(4);
  assert.equal(right[0]!.x, 900, 'the middle of the 800 to 1000 px that is in view');
  const left = handlesOf(newDrawing('zone', [at(-5, 180), at(3, 160)], T), pr).slice(4);
  assert.equal(left[0]!.x, 150, 'the middle of the 0 to 300 px that is in view');
  assert.equal(handlesOf(newDrawing('zone', [at(11, 180), at(14, 160)], T), pr).length, 4, 'wholly out of view: corners only');
});

test('the pointer finds an edge\'s middle before the edge\'s stroke, and a corner before either', () => {
  const zone = newDrawing('zone', [at(1, 180), at(4, 160)], T);
  assert.deepEqual(hitDrawing({ x: 252, y: 103 }, [zone], pr, 6, zone.id, size), { id: zone.id, part: 'handle', index: 4, axis: 'p' }, 'the top edge\'s middle');
  assert.deepEqual(hitDrawing({ x: 103, y: 150 }, [zone], pr, 6, zone.id, size), { id: zone.id, part: 'handle', index: 6, axis: 't' }, 'the left edge\'s middle');
  assert.deepEqual(hitDrawing({ x: 150, y: 100 }, [zone], pr, 6, zone.id, size), { id: zone.id, part: 'stroke' }, 'elsewhere on the edge: the stroke, which moves the box');
  assert.deepEqual(hitDrawing({ x: 98, y: 198 }, [zone], pr, 6, zone.id, size), { id: zone.id, part: 'handle', index: 2, axis: 'both' }, 'the corner with no point');
  assert.deepEqual(hitDrawing({ x: 252, y: 103 }, [zone], pr, 6, null, size), { id: zone.id, part: 'stroke' }, 'not selected: no handles');
});

test('a handle moves the coordinates it moves and no others', () => {
  const zone = newDrawing('zone', [at(1, 180), at(4, 160)], T), hs = handlesOf(zone, pr);
  const to = at(2.5, 150);
  assert.deepEqual(withHandleAt(zone, hs[5]!, to).points, [at(1, 180), at(4, 150)], 'the bottom edge: a price alone');
  assert.deepEqual(withHandleAt(zone, hs[6]!, to).points, [at(2.5, 180), at(4, 160)], 'the left edge: a time alone');
  assert.deepEqual(withHandleAt(zone, hs[2]!, to).points, [at(2.5, 180), at(4, 150)], 'the corner with no point: one point\'s time, the other\'s price');
  assert.deepEqual(withHandleAt(zone, hs[1]!, to).points, [at(1, 180), at(2.5, 150)], 'a point: both');
  // Pulled past the other edge, the same point goes on (the handle is told by its point, not by which edge is higher now).
  assert.deepEqual(withHandleAt(zone, hs[4]!, at(2.5, 140)).points, [at(1, 140), at(4, 160)]);
  const vline = newDrawing('vline', [at(2, 120)], T);
  assert.deepEqual(withHandleAt(vline, handlesOf(vline, pr)[0]!, at(3, 999)).points, [{ t: at(3, 0).t, p: 120 }], 'an event line takes no price');
});

test('a zone that runs on has no right side to cross: its left edge takes the other point along; the hover knows its handle by its axis too', () => {
  const runs = { ...newDrawing('zone', [at(1, 180), at(4, 160)], T), extendRight: true };
  const hs = handlesOf(runs, pr);
  assert.deepEqual(hs.map(h => h.after ?? null), [[1], null, [1], null, null, [1]], 'what moves the left point\'s time carries the right point: its own handle, the corner at the left, the left side');
  // The left edge to 6 h, past the right point at 4 h: the right point goes to 6 h with it, so the left boundary follows the pointer.
  assert.deepEqual(withHandleAt(runs, hs[5]!, at(6, 0)).points.map(q => q.t), [at(6, 0).t, at(6, 0).t]);
  assert.deepEqual(withHandleAt(runs, hs[5]!, at(2, 0)).points.map(q => q.t), [at(2, 0).t, at(4, 0).t], 'short of it, the right point stays');
  assert.deepEqual(withHandleAt(runs, hs[2]!, at(6, 150)).points.map(q => [q.t, q.p]), [[at(6, 0).t, 180], [at(6, 0).t, 150]], 'the corner at the left: the left point\'s time, the right point\'s price, the right point carried');
  // A box with a right side flips instead, as before: nothing is carried.
  assert.equal(handlesOf(newDrawing('zone', [at(1, 180), at(4, 160)], T), pr).every(h => h.after === undefined), true);
  // The same place in the list is another handle after a zoom: the hover is the same only if its axis is.
  const top = { id: 'x', part: 'handle' as const, index: 4, axis: 'p' as const }, left = { id: 'x', part: 'handle' as const, index: 4, axis: 't' as const };
  assert.equal(sameHit(top, { ...top }), true); assert.equal(sameHit(top, left), false); assert.equal(sameHit(top, { id: 'x', part: 'stroke' }), false); assert.equal(sameHit(null, null), true); assert.equal(sameHit(top, null), false);
});

test('a zone that runs on whose two times are equal (the left edge carried the other point): every handle at its left boundary carries, the overlapping ones too', () => {
  const runs = { ...newDrawing('zone', [at(3, 180), at(3, 130)], T), extendRight: true };
  const hs = handlesOf(runs, pr);
  assert.deepEqual(hs.slice(0, 3).map(h => [h.x, h.y, h.after ?? null]), [[300, 100, [1]], [300, 350, [0]], [300, 350, [1]]], 'both stored handles and the corner no point is at: the lower two overlap');
  const hit = hitDrawing({ x: 300, y: 350 }, [runs], pr, 6, runs.id, size);
  assert.equal(hit?.part, 'handle');
  const h = hs[(hit as { index: number }).index]!;
  assert.deepEqual(withHandleAt(runs, h, at(5, 130)).points.map(q => q.t), [at(5, 0).t, at(5, 0).t], 'pressed on the overlap and pulled right: the boundary follows');
  assert.deepEqual(withHandleAt(runs, h, at(2, 130)).points.map(q => q.t), [at(3, 0).t, at(2, 0).t], 'pulled left: the boundary follows and the other point stays');
  // Three px apart they are two handles: the right point's own handle moves its own point, as before.
  const apart = handlesOf({ ...newDrawing('zone', [at(3, 180), at(3.03, 130)], T), extendRight: true }, pr);
  assert.deepEqual(apart.slice(0, 3).map(h2 => h2.after ?? null), [[1], null, [1]]);
  // The line is drawn at 1 px: half a pixel apart the two stored handles are one to the eye and both carry; one and a half pixels apart they are not.
  const carries = (hours: number): (readonly number[] | null)[] => handlesOf({ ...newDrawing('zone', [at(3, 180), at(hours, 130)], T), extendRight: true }, pr).slice(0, 3).map(h2 => h2.after ?? null);
  assert.deepEqual(carries(3.005), [[1], [0], [1]], '0.5 px apart');
  assert.deepEqual(carries(3.015), [[1], null, [1]], '1.5 px apart');
  // Drawn from right to left the left point is the second one: its handle and the corner carry the first.
  const backwards = handlesOf({ ...newDrawing('zone', [at(4, 160), at(1, 180)], T), extendRight: true }, pr).slice(0, 3);
  assert.deepEqual(backwards.map(h2 => h2.after ?? null), [null, [0], [0]]);
  assert.deepEqual(backwards.map(h2 => h2.t), [[0], [1], [1]]);
});

test('a finger needs its handles further apart: an edge has a middle only where it is 48 px long, a mouse\'s where it is 28', () => {
  assert.deepEqual([edgeMinFor(6), edgeMinFor(12)], [28, 48]);
  const zone = newDrawing('zone', [at(1, 180), at(1.4, 140)], T);   // 40 px wide, 200 px high
  assert.equal(handlesOf(zone, pr, edgeMinFor(6)).length, 8, 'a mouse: the top and bottom have a middle');
  assert.equal(handlesOf(zone, pr, edgeMinFor(12)).length, 6, 'a finger: only the sides');
  assert.equal(hitDrawing({ x: 120, y: 100 }, [zone], pr, 6, zone.id, size)?.part, 'handle', 'the mouse finds the middle of the top');
  assert.deepEqual(hitDrawing({ x: 120, y: 100 }, [zone], pr, 12, zone.id, size), { id: zone.id, part: 'stroke' }, 'the finger: no middle there, and a corner 20 px away is out of reach: the edge itself');
  assert.deepEqual(hitDrawing({ x: 132, y: 104 }, [zone], pr, 12, zone.id, size), { id: zone.id, part: 'handle', index: 3, axis: 'both' }, 'and the corner 8 px from the press, which the middle would have been too near to tell from');
});

test('a position has its entry\'s handle and its stop\'s and target\'s on its left side, its end\'s on the entry line; its box is its inside', () => {
  const pos = newDrawing('position', [at(1, 150), at(5, 140), at(5, 170)], T);
  const hs = handlesOf(pos, pr);
  assert.deepEqual(hs.map(h => [h.x, h.y, axisOf(h)]), [[100, 250, 'both'], [100, 300, 'p'], [100, 150, 'p'], [500, 250, 't']]);
  assert.deepEqual(withHandleAt(pos, hs[3]!, at(7, 999)).points, [at(1, 150), at(7, 140), at(7, 170)], 'the end moves the stop\'s and the target\'s time together');
  assert.deepEqual(withHandleAt(pos, hs[1]!, at(9, 135)).points, [at(1, 150), at(5, 135), at(5, 170)], 'the stop\'s handle moves its price alone');
  assert.equal(strokesOf(pos, pr).length, 5, 'the entry, the two edges and the two sides');
  const early = newDrawing('position', [at(-3, 150), at(5, 140), at(5, 170)], T);
  assert.deepEqual(handlesOf(early, pr).map(h => [h.x, h.y]), [[-300, 250], [250, 300], [250, 150], [500, 250]], 'started left of the plot: the stop and target handles in the middle of its part in view');
  assert.deepEqual(hitDrawing({ x: 300, y: 250 }, [pos], pr, 6, null, size), { id: pos.id, part: 'stroke' }, 'on the entry line');
  assert.deepEqual(hitDrawing({ x: 300, y: 200 }, [pos], pr, 6, null, size), { id: pos.id, part: 'inside' }, 'in the target\'s side');
  assert.equal(hitDrawing({ x: 300, y: 320 }, [pos], pr, 6, null, size), null, 'below the stop');
});
