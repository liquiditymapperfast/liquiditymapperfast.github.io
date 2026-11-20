/**
 * The liquidation column split in two (Plus, 2026-11-19; `LiqSplit` in liq-url.ts, the pair of views in liq-view.ts `splitPair`): where the
 * two sub-columns go, when there is room for them, their scales, and the stripe's lanes and captions (`stripePlan`). Pure, so the painters
 * (panes/heat-pane.ts, panes/liq-pane.ts) only call what the tests hold.
 */
import { LANE_MIN_W, type Lane } from './liq-levels.ts';
import { curveOf, groupName, kindName, type LiqPair, type LiqView } from './liq-view.ts';
import { takesOf } from './liq-words.ts';
import { wrapText } from './text-fit.ts';

/**
 * A sub-column's width on the map, and the split column's (two of them, the divider inside). The column is 128 px unsplit; two readable
 * sub-columns need about 90 px each, and at 100 a sub-column holds "LEVEL MAX $123.4M" on one line in English.
 */
export const SPLIT_SUB_W = 100;
export const SPLIT_COLUMN_W = 2 * SPLIT_SUB_W;

/**
 * Whether a map pane has room for the split column: the plot it leaves with the unsplit column (`plot`, `columnW` that column's width) keeps
 * at least `floor` once the column widens to `SPLIT_COLUMN_W`. The floor is the plot a desktop keeps before its side columns fold
 * (`MAP_PLOT_FLOOR`): a split that fits never folds one, and one that does not fit draws the column unsplit, with a note.
 */
export function splitFits(plot: number, columnW: number, floor: number): boolean {
  return Number.isFinite(plot) && plot - (SPLIT_COLUMN_W - columnW) >= floor;
}

/** A sub-column: its left edge and width. */
export interface Sub { x0: number; w: number }
/** Which sub-column of a split column [x0, x0 + W) the pointer's `x` is on: 0 the left, 1 the right (from the divider on). */
export const subAt = (x: number, x0: number, W: number): 0 | 1 => x >= subColumns(x0, W)[1].x0 ? 1 : 0;
/** The two sub-columns of a column [x0, x0 + W): the left half and the right half (the right one's first pixel is the divider). */
export function subColumns(x0: number, W: number): [Sub, Sub] {
  const half = Math.floor(W / 2);
  return [{ x0, w: half }, { x0: x0 + half, w: W - half }];
}

/** What a sub-column's bars and curve are measured against: its largest row, and the most its curve reaches. */
export interface SubScale { maxLevel: number; maxCum: number }
/**
 * The scales the two sub-columns draw on: one shared scale (liquidations beside stops: both are dollars of the same traders, so a bar
 * compares across the divider), or each its own (everyone beside the profitable traders: everyone's are many times larger, and on one scale
 * the profitable traders' would be a few pixels). Never below 1, so nothing divides by zero.
 */
export function splitScales(left: SubScale, right: SubScale, shared: boolean): [SubScale, SubScale] {
  const floor = (s: SubScale): SubScale => ({ maxLevel: Math.max(1, s.maxLevel), maxCum: Math.max(1, s.maxCum) });
  if (!shared) return [floor(left), floor(right)];
  const one = floor({ maxLevel: Math.max(left.maxLevel, right.maxLevel), maxCum: Math.max(left.maxCum, right.maxCum) });
  return [one, one];
}

/**
 * The stripe's lanes under a split drawn as two lanes (`stripePlan`), between the live edge `x0` and the plot's right edge: the take profits'
 * lane by the live edge where they show (three tenths of the stripe), then the left column's set, then the right column's beside the column,
 * 2 px apart, in the column's order (liquidations then stops, or everyone's then the profitable traders'). Every lane given is at least
 * `LANE_MIN_W` wide: on a thin stripe the take profits' lane narrows so the two lanes of levels keep that, and goes where it cannot keep it
 * itself (Sol, review 2026-11-19: at 9 and 10 px a lane of 1 px was captioned and answered the pointer, unpainted). Two lanes of levels need
 * `2 * LANE_MIN_W + 2` px, which every stripe the map draws has (it draws from 9 px); with less, the left lane takes the stripe alone.
 */
export function splitLanes(x0: number, right: number, takes: boolean): { takes: Lane | null; left: Lane; right: Lane | null } {
  const w = Math.max(0, right - x0), two = 2 * LANE_MIN_W + 2;
  if (w < two) return { takes: null, left: { x0, x1: Math.max(x0, right) }, right: null };
  const tw = takes ? Math.min(w >= 30 ? Math.round(w * 0.3) : Math.floor(w / 3), w - 2 - two) : 0, keep = takes && tw >= LANE_MIN_W;
  const t = keep ? { x0, x1: x0 + tw } : null, from = keep ? x0 + tw + 2 : x0, half = Math.floor((right - from - 2) / 2);
  return { takes: t, left: { x0: from, x1: from + half }, right: { x0: from + half + 2, x1: right } };
}

/**
 * What the stripe draws for a split (`pair`, null for none), where `drawn` says the stripe has room for two lanes of Everyone | Profitable
 * this frame (`stripeSplitRoom` in panes/heat-pane.ts: the column drawn split, or a desktop map with the column off): one lane of levels or
 * two, each lane's caption, the group its reading names, and the take profits' caption.
 * - Liquidations beside stops: two lanes wherever the split is chosen (liquidations, then stops, of the chosen traders), captioned by kind
 *   and, where they are not everyone's, whose; the stops' lane is captioned once it draws, and only beside a drawn left lane.
 * - Everyone beside the profitable traders, with that room (owner, 2026-11-19: one lane there read as a bug): everyone's chosen kinds, then
 *   the profitable traders' from their own files alone, each lane on its own scale (its own rows' colour strength), captioned by what it adds
 *   up and whose ("Liq + stops · Profitable"), each reading naming its group. As the sub-columns do, each stands on its own: the right lane
 *   draws when its set is ready though the left's is not (`standalone`). A lane is captioned only where it is painted (liq-stripe.ts).
 * - Everyone beside the profitable traders without it (a column too narrow to split, a compact map): everyone's in one lane, as the column
 *   falls back to.
 * The take profits stay with the left set: their lane by the live edge, captioned with whose under a split. No split: one lane, and no
 * captions but the take profits' own (`HeatPane.#paintTakesCaption`).
 */
export interface StripePlan {
  /** Two lanes of levels (the left set's, then the right set's), or the left set's alone. */
  two: boolean;
  /** Each lane's caption, left first (none without a split). */
  captions: string[];
  /** The take profits' caption under a split, or null (no split). */
  takes: string | null;
  /** The group each lane's reading names (`stripeBoxLines`' `whose`), left then right, and the take profits'; null names none. */
  whose: [string | null, string | null];
  takesWhose: string | null;
  /** The right lane draws on its own set's readiness, though the left set has nothing to draw. */
  standalone: boolean;
}
export function stripePlan(pair: LiqPair | null, drawn: boolean): StripePlan {
  if (!pair) return { two: false, captions: [], takes: null, whose: [null, null], takesWhose: null, standalone: false };
  const takes = takesOf(pair.left.group);
  if (pair.split === 'kinds') {
    const whose = (words: string): string => pair.left.group !== 'all' ? `${words} · ${groupName(pair.left.group)}` : words;
    return { two: true, captions: [whose(kindName('liq')), whose(kindName('stops'))], takes, whose: [null, null], takesWhose: null, standalone: false };
  }
  const caption = (v: LiqView): string => `${kindName(curveOf(v))} · ${groupName(v.group)}`;
  if (!drawn) return { two: false, captions: [caption(pair.left)], takes, whose: [null, null], takesWhose: null, standalone: false };
  return { two: true, captions: [caption(pair.left), caption(pair.right)], takes, whose: [groupName(pair.left.group), groupName(pair.right.group)],
    takesWhose: groupName(pair.left.group), standalone: true };
}

/** A rectangle on the plot (px): from `x0` to `x1` across and from `y0` to `y1` down, the far edges outside it. */
export interface Rect { x0: number; y0: number; x1: number; y1: number }

/** One of the map's corner buttons as the pane lays it out (`offsetLeft` and the rest, in the pane), and whether it is hidden. */
export interface CornerEl { offsetLeft: number; offsetTop: number; offsetWidth: number; offsetHeight: number; hidden: boolean }
/**
 * The map's corner buttons as one rectangle on the plot (`left` px of columns stand left of it): the union of those shown (no width is not
 * shown), null where none is. The map passes the desktop's row (`.map-tools`) and a phone's Draw key (`.map-draw-phone`), whichever it
 * shows: the compact bar takes the row off the map and leaves the key, so measuring the row alone left a phone's captions under the key
 * (2026-11-19: at 844 x 207 the key covered the Stops caption and the end of the Liquidations one).
 */
export function cornerSpan(els: readonly (CornerEl | null)[], left: number): Rect | null {
  let span: Rect | null = null;
  for (const el of els) {
    if (!el || el.hidden || !(el.offsetWidth > 0)) continue;
    const r = { x0: el.offsetLeft - left, y0: el.offsetTop, x1: el.offsetLeft - left + el.offsetWidth, y1: el.offsetTop + el.offsetHeight };
    span = span ? { x0: Math.min(span.x0, r.x0), y0: Math.min(span.y0, r.y0), x1: Math.max(span.x1, r.x1), y1: Math.max(span.y1, r.y1) } : r;
  }
  return span;
}

/**
 * What the stripe's caption plates keep clear of, each widened by the room it keeps: the corner buttons (`corner`, 4 px round them), the
 * legend and the room under it for the note (`legend`, its right edge and foot: 8 px beside it, 36 px under it), the "depth recorded from"
 * note (`history`, one 15 px row from its top), the volume strip's names (`names`, 2 px round them: the plates are painted after the strip,
 * so one over a name hid it, Sol, review 2026-11-20) and the note under the legend (`note`, 3 px under its last line), in that order (the
 * old rows check the last one again, `captionRows`).
 */
export function captionKeepOut(o: { corner: Rect | null; legend: { right: number; bottom: number }; history: { x0: number; x1: number; top: number } | null; note: { x0: number; x1: number; top: number; bottom: number } | null; names?: readonly Rect[] }): Rect[] {
  const out: Rect[] = [];
  if (o.corner) out.push({ x0: o.corner.x0 - 4, y0: -Infinity, x1: o.corner.x1 + 4, y1: o.corner.y1 + 4 });
  out.push({ x0: -Infinity, y0: -Infinity, x1: o.legend.right + 8, y1: o.legend.bottom + 36 });
  if (o.history) out.push({ x0: o.history.x0 - 4, y0: o.history.top, x1: o.history.x1 + 4, y1: o.history.top + 15 });
  for (const n of o.names ?? []) out.push({ x0: n.x0 - 2, y0: n.y0 - 2, x1: n.x1 + 2, y1: n.y1 + 2 });
  if (o.note) out.push({ x0: o.note.x0 - 4, y0: o.note.top, x1: o.note.x1 + 4, y1: o.note.bottom + 3 });
  return out;
}

/**
 * The rows the stripe's caption plates stood in until 2026-11-19 (each `w` wide at `x`, `h` tall): each plate's highest start, each keep-out
 * checked once in order; rows from the highest of them, a row lower for a plate that overlaps one before it; the last keep-out (the note
 * under the legend) checked again. A plate the legend sent down still held its row at the top, so the plates after it could start lower than
 * they had to, and a plate pushed under one keep-out was never checked against the ones before.
 */
export function captionRows(items: readonly { x: number; w: number }[], keepOut: readonly Rect[], top: number, h: number, gap = 2): number[] {
  if (!items.length) return [];
  const over = (r: Rect, x: number, w: number, y: number): boolean => x < r.x1 && x + w > r.x0 && y < r.y1 && y + h > r.y0;
  const last = keepOut[keepOut.length - 1], clear = (x: number, w: number, y: number): number => last && over(last, x, w, y) ? last.y1 : y;
  const floor = items.map(({ x, w }) => keepOut.reduce((y, r) => over(r, x, w, y) ? Math.max(y, r.y1) : y, top));
  const first = Math.min(...floor), rows: { x0: number; x1: number; y: number }[] = [];
  // A row each from the highest start, a row lower while a plate overlaps one placed in that row.
  const stacked = items.map(({ x, w }) => {
    let y = first;
    while (rows.some(r => r.y === y && x < r.x1 + gap && x + w > r.x0 - gap)) y += h + gap;
    rows.push({ x0: x, x1: x + w, y });
    return y;
  });
  const ys: number[] = [];
  items.forEach(({ x, w }, i) => {
    let y = clear(x, w, Math.max(floor[i]!, stacked[i]!));
    while (items.slice(0, i).some((o, j) => Math.abs(ys[j]! - y) < h && x < o.x + o.w + gap && x + w > o.x - gap)) y = clear(x, w, y + h + gap);
    ys.push(y);
  });
  return ys;
}

/**
 * Where the stripe's caption plates stand (each `w` wide at `x`, `h` tall, the plot `bottom` px tall), in the order given. Where the rows
 * they always stood in (`captionRows`) are clean, those: no plate over a keep-out (`captionKeepOut`) or over another, none past the plot's
 * foot, so a desktop map's captions stay where they were. Else each at the highest place where it lies over no keep-out and no plate placed
 * before it (`gap` px apart), moved down past whatever it lies over and checked against all of them again after every move, so one pushed
 * under the corner buttons never lands in a note. On a phone held sideways (a 138 px plot) the rows put the Liquidations plate over the
 * "depth recorded from" note, below a plate the legend had sent down; placed this way it stands under the Draw key, where it is free.
 * A plate whose highest free place ends past the plot's foot has no room (the time axis paints over the foot; Sol, review 2026-11-20): then
 * they are placed again in the order of `rank` (lowest first, the split's lanes before the take profits'), and a plate that still has no room
 * is left out (null): its lane still says what it holds under the pointer.
 */
export function placeCaptions(items: readonly { x: number; w: number; rank?: number }[], keepOut: readonly Rect[], top: number, h: number, bottom = Infinity, gap = 2): (number | null)[] {
  const over = (r: Rect, x: number, w: number, y: number): boolean => x < r.x1 && x + w > r.x0 && y < r.y1 && y + h > r.y0;
  const rows = captionRows(items, keepOut, top, h, gap);
  const clean = rows.every((y, i) => {
    const { x, w } = items[i]!;
    return y + h <= bottom && !keepOut.some(r => over(r, x, w, y)) && rows.slice(0, i).every((v, j) => !over({ x0: items[j]!.x - gap, x1: items[j]!.x + items[j]!.w + gap, y0: v - gap, y1: v + h + gap }, x, w, y));
  });
  if (clean) return rows;
  const place = (order: readonly number[]): (number | null)[] => {
    const ys: (number | null)[] = items.map(() => null), placed: Rect[] = [];
    for (const i of order) {
      const { x, w } = items[i]!;
      let y = top;
      // Each move takes the plate past the foot of something it lay over, and nothing is passed twice: at most one move per obstacle.
      for (let moves = 0; moves <= keepOut.length + placed.length; moves++) {
        let next = y;
        for (const r of keepOut) if (over(r, x, w, y)) next = Math.max(next, r.y1);
        for (const r of placed) if (over(r, x, w, y)) next = Math.max(next, r.y1);
        if (next === y) break;
        y = next;
      }
      if (y + h > bottom) continue;
      placed.push({ x0: x - gap, x1: x + w + gap, y0: y - gap, y1: y + h + gap });
      ys[i] = y;
    }
    return ys;
  };
  const given = items.map((_, i) => i), first = place(given);
  if (first.every(y => y !== null)) return first;
  return place([...given].sort((a, b) => (items[a]!.rank ?? 0) - (items[b]!.rank ?? 0) || a - b));
}

/**
 * Whether the phone's Liq tab has room to split its ladder: two halves of at least `LADDER_SUB_MIN` px beside the price axis (a half holds a
 * milestone's "−2.5 % $123.4M" and the largest level's label).
 */
export const LADDER_SUB_MIN = 120;
export const ladderSplitFits = (plotW: number): boolean => plotW >= 2 * LADDER_SUB_MIN + 8;

/**
 * The liquidation column's width (px): none where it is not shown, the strip on a compact map, the split column where a split is drawn and
 * the plot the unsplit column leaves (`plotUnsplit`, with `column` px for it) keeps `floor` once the column widens (`splitFits`: a split
 * never folds a side column), else the column. One rule for the frame's own width (heat-pane's `liqColumnW`) and for the layout's question
 * about a width it could give the map (`gutterAt`), so the two never disagree.
 */
export function liqColumnWidth(o: { shown: boolean; compact: boolean; strip: number; column: number; split: boolean; plotUnsplit: number; floor: number }): number {
  if (!o.shown) return 0;
  if (o.compact) return o.strip;
  return o.split && splitFits(o.plotUnsplit, o.column, o.floor) ? SPLIT_COLUMN_W : o.column;
}

/**
 * The heading of a split column, as lines fitted to the room by `measure`: each sub-column's caption (what it shows) and, where each has a
 * scale of its own (everyone beside the profitable traders), its LEVEL MAX and CUM MAX under it, in its own `subRoom`; where the two share one
 * scale (liquidations beside stops), the two maxima once, across the column (`wholeRoom`). A line that does not fit wraps under itself (at
 * most two lines), never cut short: every column is captioned with exactly what it shows. `rows` is how many lines the heading takes.
 */
export function splitHeads(measure: (text: string) => number, o: { captions: [string, string]; maxima: [[string, string], [string, string]] | [string, string]; shared: boolean; subRoom: number; wholeRoom: number }):
  { subs: [{ caption: string[]; scale: string[] }, { caption: string[]; scale: string[] }]; across: string[]; rows: number } {
  const wrap = (text: string, room: number): string[] => wrapText(measure, text, room, 2);
  const per = (i: 0 | 1): { caption: string[]; scale: string[] } => ({ caption: wrap(o.captions[i], o.subRoom), scale: o.shared ? [] : (o.maxima as [[string, string], [string, string]])[i].flatMap(line => wrap(line, o.subRoom)) });
  const subs: [{ caption: string[]; scale: string[] }, { caption: string[]; scale: string[] }] = [per(0), per(1)];
  const across = o.shared ? (o.maxima as [string, string]).flatMap(line => wrap(line, o.wholeRoom)) : [];
  const tall = (sub: { caption: string[]; scale: string[] }): number => sub.caption.length + sub.scale.length;
  return { subs, across, rows: Math.max(tall(subs[0]), tall(subs[1])) + across.length };
}

/** A box's size, and where its top left corner goes. */
export interface BoxSize { w: number; h: number }
export interface BoxAt { x: number; y: number }
/**
 * Where a finger's boxes go on the phone's split ladder (`W` wide, `H` high), measured and placed together: the left half's box from the
 * ladder's left, the right half's to its right. Side by side where the ladder has room for both, else one above the other (the left half's
 * first), on the far side of the finger's line `y` (below it in the ladder's upper half, above it in the lower), else on the near side, else
 * shifted until both fit, over the line. Either way both stay on the ladder (2 px in) and never lie over each other while their heights
 * fit the ladder together (Sol, review 2026-11-19: placed one at a time, the second could be pushed back over the first near an edge).
 */
export function placeProbeBoxes(sizes: readonly [BoxSize | null, BoxSize | null], y: number, W: number, H: number): [BoxAt | null, BoxAt | null] {
  const [a, b] = sizes, down = y < H / 2, edge = 2, line = 14, gap = 4;
  const xOf = (s: BoxSize, right: boolean): number => Math.max(edge, Math.min(right ? W - 8 - s.w : 8, W - s.w - edge));
  const topFor = (h: number): number => Math.max(edge, Math.min(down ? y + line : y - line - h, H - h - edge));
  if (!a || !b) {
    const one = a ?? b;
    if (!one) return [null, null];
    const at = { x: xOf(one, !a), y: topFor(one.h) };
    return a ? [at, null] : [null, at];
  }
  if (a.w + b.w + gap + 16 <= W) {
    const top = topFor(Math.max(a.h, b.h));
    return [{ x: xOf(a, false), y: top }, { x: xOf(b, true), y: top }];
  }
  const tall = a.h + gap + b.h, below = y + line, above = y - line - tall;
  const fitsBelow = below + tall <= H - edge, fitsAbove = above >= edge;
  const top = (down ? (fitsBelow ? below : fitsAbove ? above : null) : (fitsAbove ? above : fitsBelow ? below : null))
    ?? Math.max(edge, Math.min(down ? below : above, H - edge - tall));
  return [{ x: xOf(a, false), y: top }, { x: xOf(b, true), y: Math.min(top + a.h + gap, H - edge - b.h) }];
}

/**
 * Whether a finger's two boxes fit the ladder (`W` by `H`) together as `placeProbeBoxes` places them: every box shown inside the ladder (2 px
 * in at each side, across and down), then side by side or one above the other within its height. A box alone fits where it fits the ladder.
 * Sol, review 2026-11-20: room across alone kept two 152 px boxes whole on a 120 px ladder, and a box alone was never measured.
 */
export function probeBoxesFit(sizes: readonly [BoxSize | null, BoxSize | null], W: number, H: number): boolean {
  const [a, b] = sizes, edge = 2, gap = 4, inside = (s: BoxSize): boolean => s.w <= W - 2 * edge && s.h <= H - 2 * edge;
  if (!a || !b) { const one = a ?? b; return !one || inside(one); }
  return inside(a) && inside(b) && (a.w + b.w + gap + 16 <= W || a.h + gap + b.h <= H - 2 * edge);
}

/**
 * How much a finger's two boxes on the split ladder say: the most (0, everything) at which they fit it together (`probeBoxesFit`), each
 * measured at that detail by `sizes`; `least` where even that does not fit, and there `placeProbeBoxes` lays the second over the foot of the
 * first (a ladder that short is under 190 px tall: a phone held sideways, whose Liq tab puts the ladder below the fold). On a 320 x 568
 * phone (a 260 x 253 ladder) two whole boxes of liquidations and stops are 150 to 170 px tall each and lay one over the other.
 */
export function probeDetail(sizes: (detail: number) => readonly [BoxSize | null, BoxSize | null], W: number, H: number, least: number): number {
  for (let detail = 0; detail < least; detail++) if (probeBoxesFit(sizes(detail), W, H)) return detail;
  return least;
}
