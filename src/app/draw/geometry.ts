import { FIB_RATIOS, type Anchor, type Drawing } from './model.ts';

/**
 * Where a drawing lies on the screen and what a pointer is on: the parts of the map pane's drawing tools that are only numbers, tested
 * without a page (tests/draw-geometry.test.mts). Everything is in the plot's own pixels: x from 0 at its left edge to `w`, y from 0 at its
 * top to `h`.
 */

/** Time and price to the plot's pixels and back, as the map's view gives them. */
export interface Projection { x(t: number): number; y(p: number): number; t(x: number): number; p(y: number): number; w: number; h: number }

export interface Pt { x: number; y: number }
export interface Segment { a: Pt; b: Pt }

/** The part of the line through `a` and `b` inside the box, from `a` back (when `left`) and past `b` (when `right`), else between them. */
export function extendSegment(a: Pt, b: Pt, left: boolean, right: boolean, box: { x0: number; y0: number; x1: number; y1: number }): Segment | null {
  const dx = b.x - a.x, dy = b.y - a.y;
  if (dx === 0 && dy === 0) return { a, b };
  // The line as a + s (b - a): clipped to the box (Liang-Barsky), with s in [0, 1] unless it runs on.
  let s0 = left ? -Infinity : 0, s1 = right ? Infinity : 1;
  const clip = (p: number, q: number): boolean => {
    if (p === 0) return q >= 0;
    const r = q / p;
    if (p < 0) { if (r > s1) return false; if (r > s0) s0 = r; } else { if (r < s0) return false; if (r < s1) s1 = r; }
    return true;
  };
  if (!clip(-dx, a.x - box.x0) || !clip(dx, box.x1 - a.x) || !clip(-dy, a.y - box.y0) || !clip(dy, box.y1 - a.y)) return null;
  if (!(s1 >= s0)) return null;
  return { a: { x: a.x + s0 * dx, y: a.y + s0 * dy }, b: { x: a.x + s1 * dx, y: a.y + s1 * dy } };
}

/** How far `q` is from the segment (px). */
export function distToSegment(q: Pt, s: Segment): number {
  const dx = s.b.x - s.a.x, dy = s.b.y - s.a.y, len = dx * dx + dy * dy;
  const k = len > 0 ? Math.max(0, Math.min(1, ((q.x - s.a.x) * dx + (q.y - s.a.y) * dy) / len)) : 0;
  return Math.hypot(q.x - (s.a.x + k * dx), q.y - (s.a.y + k * dy));
}

/** Far enough off the plot that a line drawn to it reaches the edge whatever the pane's size. */
const FAR = 1e6;
const BOX = { x0: -FAR, y0: -FAR, x1: FAR, y1: FAR };

/** A Fibonacci level: its share, its price and where it runs. */
export interface FibLevel { ratio: number; price: number; y: number; x0: number; x1: number }
/** The retracement's levels: 1 at its first point, 0 at its second, across the two points (to the right edge when it runs on). */
export function fibLevels(d: Drawing, pr: Projection): FibLevel[] {
  const [a, b] = d.points as [Anchor, Anchor];
  const xa = pr.x(a.t), xb = pr.x(b.t), x0 = Math.min(xa, xb), x1 = d.extendRight ? Math.max(pr.w, Math.max(xa, xb)) : Math.max(xa, xb);
  return FIB_RATIOS.map(ratio => { const price = b.p + (a.p - b.p) * ratio; return { ratio, price, y: pr.y(price), x0, x1 }; });
}

/** The channel's two lines: the one through its first two points, and its parallel through the third (the same price offset all along). */
export function channelLines(d: Drawing, pr: Projection): { base: Segment | null; parallel: Segment | null; offset: number } {
  const [first, second, c] = d.points as [Anchor, Anchor, Anchor];
  // Left and right are by time: a line placed from right to left runs on to the right past the point that is on the right.
  const [a, b] = first.t <= second.t ? [first, second] : [second, first];
  const slope = b.t !== a.t ? (b.p - a.p) / (b.t - a.t) : 0, offset = c.p - (a.p + slope * (c.t - a.t));
  const line = (dp: number): Segment | null => extendSegment({ x: pr.x(a.t), y: pr.y(a.p + dp) }, { x: pr.x(b.t), y: pr.y(b.p + dp) }, d.extendLeft, d.extendRight, BOX);
  return { base: line(0), parallel: line(offset), offset };
}

/** A position on the screen: its start and end, and the heights of its entry, stop and target. */
export interface PositionBox { x0: number; x1: number; entry: number; stop: number; target: number }
export function positionBox(d: Drawing, pr: Projection): PositionBox {
  const [e, s, g] = d.points as [Anchor, Anchor, Anchor];
  return { x0: pr.x(e.t), x1: pr.x(s.t), entry: pr.y(e.p), stop: pr.y(s.p), target: pr.y(g.p) };
}

/** Where a note's text box stands from its point: up and to the right, so the point stays in view. */
export const NOTE_OFFSET = { x: 14, y: -30 };

/**
 * The strokes a drawing is made of on the screen (lines a pointer can be on), for every kind but the zone's inside and the note's box, which
 * `hitDrawing` tests apart.
 */
export function strokesOf(d: Drawing, pr: Projection): Segment[] {
  const pts = d.points.map(q => ({ x: pr.x(q.t), y: pr.y(q.p) }));
  switch (d.kind) {
    case 'level': { const y = pts[0]!.y; return [{ a: { x: d.extendLeft ? -FAR : pts[0]!.x, y }, b: { x: FAR, y } }]; }
    case 'vline': { const x = pts[0]!.x; return [{ a: { x, y: -FAR }, b: { x, y: FAR } }]; }
    case 'trend': { const [a, b] = pts[0]!.x <= pts[1]!.x ? [pts[0]!, pts[1]!] : [pts[1]!, pts[0]!]; const s = extendSegment(a, b, d.extendLeft, d.extendRight, BOX); return s ? [s] : []; }
    case 'zone': {
      const x0 = Math.min(pts[0]!.x, pts[1]!.x), x1 = d.extendRight ? FAR : Math.max(pts[0]!.x, pts[1]!.x), y0 = Math.min(pts[0]!.y, pts[1]!.y), y1 = Math.max(pts[0]!.y, pts[1]!.y);
      return [{ a: { x: x0, y: y0 }, b: { x: x1, y: y0 } }, { a: { x: x0, y: y1 }, b: { x: x1, y: y1 } }, { a: { x: x0, y: y0 }, b: { x: x0, y: y1 } }, ...(d.extendRight ? [] : [{ a: { x: x1, y: y0 }, b: { x: x1, y: y1 } }])];
    }
    case 'fib': return fibLevels(d, pr).map(l => ({ a: { x: l.x0, y: l.y }, b: { x: l.x1, y: l.y } }));
    case 'channel': { const c = channelLines(d, pr); return [c.base, c.parallel].filter((s): s is Segment => s !== null); }
    case 'note': return d.leader ? [{ a: pts[0]!, b: { x: pts[0]!.x + NOTE_OFFSET.x, y: pts[0]!.y + NOTE_OFFSET.y } }] : [];
    case 'position': {
      // The entry across the box, the stop's and the target's edges, and its two sides.
      const b = positionBox(d, pr), top = Math.min(b.stop, b.target), bottom = Math.max(b.stop, b.target);
      return [{ a: { x: b.x0, y: b.entry }, b: { x: b.x1, y: b.entry } }, { a: { x: b.x0, y: b.stop }, b: { x: b.x1, y: b.stop } }, { a: { x: b.x0, y: b.target }, b: { x: b.x1, y: b.target } },
        { a: { x: b.x0, y: top }, b: { x: b.x0, y: bottom } }, { a: { x: b.x1, y: top }, b: { x: b.x1, y: bottom } }];
    }
  }
}

/** A note's text box, measured by the painter (its width depends on the font): where it is, for the pointer. */
export function noteBox(d: Drawing, pr: Projection, size: { w: number; h: number }): { x: number; y: number; w: number; h: number } {
  const x = pr.x(d.points[0]!.t), y = pr.y(d.points[0]!.p);
  return d.leader ? { x: x + NOTE_OFFSET.x, y: y + NOTE_OFFSET.y - size.h / 2, w: size.w, h: size.h } : { x: x + 6, y: y - size.h / 2, w: size.w, h: size.h };
}

/**
 * A handle of the selected drawing: where it stands, and what moving it moves: the points (by their place in the drawing) whose time follows
 * the pointer and those whose price does. A point's handle moves both (an event line's only its time); the middle of a zone's top or bottom
 * edge moves a price alone and the middle of its sides a time alone (Karl, 2026-11-01: a box drawn from a wick must be resizable to a body
 * with the magnet, as on TradingView).
 */
export interface Handle extends Pt {
  t: readonly number[]; p: readonly number[];
  /** Points whose time is kept at or after the time this handle sets (a zone that runs on to the right has no right side to cross: its left edge takes the other point with it). */
  after?: readonly number[];
}
/** The axes a handle moves: both, the price alone (a top or a bottom) or the time alone (a side, an event line). */
export type HandleAxis = 'both' | 'p' | 't';
export const axisOf = (h: Pick<Handle, 't' | 'p'>): HandleAxis => h.t.length && h.p.length ? 'both' : h.p.length ? 'p' : 't';

/** How long (px) a stretch of an edge in view must be to have a handle of its own in its middle: a shorter one would sit on the corners' handles (a box one candle wide has one on its top and bottom). */
export const EDGE_MIN = 28;
/** The shortest edge that has a middle handle for a pointer that is on a stroke within `tol` px: 28 px for a mouse (tol 6), 48 for a finger (tol 12). */
export const edgeMinFor = (tol: number): number => Math.max(EDGE_MIN, tol * 4);

/**
 * Where a drawing's handles are: one for each point (a vertical line's halfway down the plot, a level's at its anchor), and a zone has the
 * corners it has no point at and the middle of each edge besides: eight in all; one that runs on to the right edge has no right side or right
 * corners: six. A middle stands on the part of its edge that is in view, and only where that part is `minEdge` long (`EDGE_MIN`, longer for a finger).
 */
export function handlesOf(d: Drawing, pr: Projection, minEdge: number = EDGE_MIN): Handle[] {
  if (d.kind === 'position') {
    // The entry's at the box's left end moves its price and where the position starts; the stop's and the target's on the left side move
    // their price alone; the right end's on the entry line moves where it ends (the stop's and the target's time, kept equal). A box that
    // starts left of the plot keeps its stop's and target's handles in the middle of its part in view, as a zone's middles are (they move a
    // price only; at the plot's edge they would sit under the drawing tools' rail, or in a phone's edge swipe).
    const b = positionBox(d, pr), side = b.x0 < 0 && b.x1 > 0 ? Math.min(b.x1, pr.w) / 2 : b.x0;
    return [{ x: b.x0, y: b.entry, t: [0], p: [0] }, { x: side, y: b.stop, t: [], p: [1] }, { x: side, y: b.target, t: [], p: [2] }, { x: b.x1, y: b.entry, t: [1, 2], p: [] }];
  }
  const own: Handle[] = d.points.map((q, i) => ({ x: pr.x(q.t), y: d.kind === 'vline' ? pr.h / 2 : pr.y(q.p), t: [i], p: d.kind === 'vline' ? [] : [i] }));
  if (d.kind !== 'zone') return own;
  const [a, b] = own as [Handle, Handle];
  const left = a.x <= b.x ? 0 : 1, top = a.y <= b.y ? 0 : 1;
  const x0 = Math.min(a.x, b.x), x1 = Math.max(a.x, b.x), y0 = Math.min(a.y, b.y), y1 = Math.max(a.y, b.y);
  const out: Handle[] = [...own];
  // A zone that runs on has no right side: what moves its left, to the right of the other point, takes that point along. So does the other point's
  // own handle where it stands at the left boundary too (equal times, after the left edge has carried it): it overlaps the corner no point is at.
  if (d.extendRight) {
    out[left] = { ...own[left]!, after: [1 - left] };
    if (Math.abs(own[1 - left]!.x - own[left]!.x) < 1) out[1 - left] = { ...own[1 - left]!, after: [left] };
  }
  // The corners no point is at: the first point's time with the second's price, and the other way round; a zone that runs on has only the one at its left.
  if (d.extendRight) out.push({ x: own[left]!.x, y: own[1 - left]!.y, t: [left], p: [1 - left], after: [1 - left] });
  else out.push({ x: a.x, y: b.y, t: [0], p: [1] }, { x: b.x, y: a.y, t: [1], p: [0] });
  const vx0 = Math.max(x0, 0), vx1 = d.extendRight ? pr.w : Math.min(x1, pr.w), vy0 = Math.max(y0, 0), vy1 = Math.min(y1, pr.h);
  const inX = (x: number): boolean => x >= 0 && x <= pr.w, inY = (y: number): boolean => y >= 0 && y <= pr.h;
  if (vx1 - vx0 >= minEdge) { const x = (vx0 + vx1) / 2; if (inY(y0)) out.push({ x, y: y0, t: [], p: [top] }); if (inY(y1)) out.push({ x, y: y1, t: [], p: [1 - top] }); }
  if (vy1 - vy0 >= minEdge) { const y = (vy0 + vy1) / 2; if (inX(x0)) out.push({ x: x0, y, t: [left], p: [], ...(d.extendRight ? { after: [1 - left] } : {}) }); if (!d.extendRight && inX(x1)) out.push({ x: x1, y, t: [1 - left], p: [] }); }
  return out;
}

/** The drawing with the points a handle moves put at `at`: their times when it moves time, their prices when it moves price. */
export function withHandleAt(d: Drawing, h: Pick<Handle, 't' | 'p' | 'after'>, at: Anchor): Drawing {
  return { ...d, points: d.points.map((q, i) => ({ t: h.t.includes(i) ? at.t : h.after?.includes(i) ? Math.max(q.t, at.t) : q.t, p: h.p.includes(i) ? at.p : q.p })) };
}

/** What a pointer is on: a handle of the drawing selected (and which axes it moves), a drawing's stroke, a note's box, or a zone's inside (only a click selects it). */
export type Hit = { id: string; part: 'handle'; index: number; axis: HandleAxis } | { id: string; part: 'stroke' | 'inside' };
/** Whether two hits are the same thing under the pointer: the same drawing and part, and for a handle the same one (its place in the list can mean another after a zoom, so its axis counts). */
export const sameHit = (a: Hit | null, b: Hit | null): boolean => a === b || (a !== null && b !== null && a.id === b.id && a.part === b.part && (a.part !== 'handle' || (b.part === 'handle' && a.index === b.index && a.axis === b.axis)));

/**
 * What of the drawings is under `q`, within `tol` px: the selected drawing's handles first, then strokes and note boxes, the drawing drawn
 * last (on top) first, then a zone's inside. Hidden drawings are never hit.
 */
export function hitDrawing(q: Pt, drawings: readonly Drawing[], pr: Projection, tol: number, selected: string | null, noteSize: (d: Drawing) => { w: number; h: number }): Hit | null {
  const sel = selected ? drawings.find(d => d.id === selected && !d.hidden) : undefined;
  if (sel) {
    const hs = handlesOf(sel, pr, edgeMinFor(tol));
    let best = -1, bestD = Infinity;
    hs.forEach((h, i) => { const dist = Math.hypot(h.x - q.x, h.y - q.y); if (dist <= tol + 2 && dist < bestD) { best = i; bestD = dist; } });
    if (best >= 0) return { id: sel.id, part: 'handle', index: best, axis: axisOf(hs[best]!) };
  }
  for (let i = drawings.length - 1; i >= 0; i--) {
    const d = drawings[i]!;
    if (d.hidden) continue;
    if (strokesOf(d, pr).some(s => distToSegment(q, s) <= tol)) return { id: d.id, part: 'stroke' };
    if (d.kind === 'note') {
      const b = noteBox(d, pr, noteSize(d)), x = pr.x(d.points[0]!.t), y = pr.y(d.points[0]!.p);
      if ((q.x >= b.x - 2 && q.x <= b.x + b.w + 2 && q.y >= b.y - 2 && q.y <= b.y + b.h + 2) || Math.hypot(q.x - x, q.y - y) <= tol) return { id: d.id, part: 'stroke' };
    }
  }
  for (let i = drawings.length - 1; i >= 0; i--) {
    const d = drawings[i]!;
    if (d.hidden || (d.kind !== 'zone' && d.kind !== 'channel' && d.kind !== 'position')) continue;
    if (d.kind === 'position') {
      const b = positionBox(d, pr);
      if (q.x >= Math.min(b.x0, b.x1) && q.x <= Math.max(b.x0, b.x1) && q.y >= Math.min(b.stop, b.target) && q.y <= Math.max(b.stop, b.target)) return { id: d.id, part: 'inside' };
    } else if (d.kind === 'zone') {
      const x0 = Math.min(pr.x(d.points[0]!.t), pr.x(d.points[1]!.t)), x1 = d.extendRight ? Infinity : Math.max(pr.x(d.points[0]!.t), pr.x(d.points[1]!.t));
      const y0 = Math.min(pr.y(d.points[0]!.p), pr.y(d.points[1]!.p)), y1 = Math.max(pr.y(d.points[0]!.p), pr.y(d.points[1]!.p));
      if (q.x >= x0 && q.x <= x1 && q.y >= y0 && q.y <= y1) return { id: d.id, part: 'inside' };
    } else if (insideChannel(q, d, pr)) return { id: d.id, part: 'inside' };
  }
  return null;
}

/** Whether `q` lies between a channel's two lines, within the stretch of time they are drawn over. */
function insideChannel(q: Pt, d: Drawing, pr: Projection): boolean {
  const [first, second] = d.points as [Anchor, Anchor], [a, b] = first.t <= second.t ? [first, second] : [second, first];
  const xa = pr.x(a.t), xb = pr.x(b.t);
  if (!d.extendLeft && q.x < Math.min(xa, xb)) return false;
  if (!d.extendRight && q.x > Math.max(xa, xb)) return false;
  if (xa === xb) return false;
  const t = pr.t(q.x), slope = (b.p - a.p) / (b.t - a.t), base = a.p + slope * (t - a.t), offset = channelLines(d, pr).offset;
  const p = pr.p(q.y), lo = Math.min(base, base + offset), hi = Math.max(base, base + offset);
  return p >= lo && p <= hi;
}

/** The time and price a pointer moved by, from `from` to `to` (px), on this projection. */
export function deltaOf(pr: Projection, from: Pt, to: Pt): { dt: number; dp: number } {
  return { dt: pr.t(to.x) - pr.t(from.x), dp: pr.p(to.y) - pr.p(from.y) };
}
