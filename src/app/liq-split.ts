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

/**
 * Where captions go when several share the stripe's top: each at its own place (`x`, `w`), at `top`, moved down a row (`h`) while it would
 * overlap one already placed (with `gap` px between plates). Returns each caption's top, in the order given.
 */
export function stackCaptions(items: readonly { x: number; w: number }[], top: number, h: number, gap = 2): number[] {
  const placed: { x0: number; x1: number; y: number }[] = [];
  return items.map(({ x, w }) => {
    let y = top;
    while (placed.some(p => p.y === y && x < p.x1 + gap && x + w > p.x0 - gap)) y += h + gap;
    placed.push({ x0: x, x1: x + w, y });
    return y;
  });
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
