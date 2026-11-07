import type { AppState } from '../store.ts';

/**
 * Where the panes stand. The map and the panes that share its time axis (Bar stats, Depth, Open interest, Delta, Long/Short, the Liquidity
 * Tracker and the Scripts) make the middle column: their x axis is the map's, so they stay under it. The two panes that have an axis of their
 * own, the flow column and the order book, stand beside it, each on either side, alone or one over the other.
 *
 * This file is the arithmetic of that and nothing else (no page, no storage): where a side pane is, what each side shows, how wide the columns
 * may be, and how a file or a saved page is read back. `layout.ts` puts the result on the screen.
 */
export type Side = 'left' | 'right';
export const SIDES: readonly Side[] = ['left', 'right'];
export const SIDE_PANES = ['cvd', 'book'] as const;
export type SidePaneId = (typeof SIDE_PANES)[number];
export const isSidePane = (id: string): id is SidePaneId => (SIDE_PANES as readonly string[]).includes(id);
/** Where each side pane stands when nothing was chosen: the flow column left of the map, the book right of it. */
export const HOME_SIDE: Readonly<Record<SidePaneId, Side>> = { cvd: 'left', book: 'right' };
export const otherSide = (side: Side): Side => side === 'left' ? 'right' : 'left';

/** The panes under the map, in the order they stand by default: how tall each starts (px) and the least it is made. The page's panes and the ready-made layouts both read this. */
export const STRIP_PANES = [
  { id: 'bars', height: 84, min: 56 }, { id: 'depth', height: 132, min: 70 }, { id: 'oi', height: 150, min: 60 }, { id: 'delta', height: 150, min: 60 },
  { id: 'ls', height: 120, min: 60 }, { id: 'funding', height: 140, min: 70 }, { id: 'lt', height: 128, min: 70 }, { id: 'script', height: 220, min: 60 },
] as const;
export type StripId = (typeof STRIP_PANES)[number]['id'];
export const stripSize = (id: StripId): { height: number; min: number } => STRIP_PANES.find(p => p.id === id)!;

/** The pane switch (`state.show`) that opens each pane (the map has none: it is always there). */
export const PANE_SHOW_KEY: Readonly<Record<string, keyof AppState['show']>> = { cvd: 'cvd', book: 'book', bars: 'stats', depth: 'depth', oi: 'oi', delta: 'delta', ls: 'ls', funding: 'funding', lt: 'lt', script: 'script' };

/**
 * Which side pane is in which column, top to bottom (a closed pane keeps its place, so that opening it puts it back), how wide each column is
 * (null: it follows the window, as the stylesheet sizes it), and how the height of a column is shared between its panes (a weight each).
 */
export interface DockPlan { left: SidePaneId[]; right: SidePaneId[]; leftW: number | null; rightW: number | null; weights: Partial<Record<SidePaneId, number>> }

export function defaultPlan(): DockPlan { return { left: ['cvd'], right: ['book'], leftW: null, rightW: null, weights: {} }; }
export const clonePlan = (p: DockPlan): DockPlan => ({ left: [...p.left], right: [...p.right], leftW: p.leftW, rightW: p.rightW, weights: { ...p.weights } });

export const WIDTH_LIMITS = { min: 150, max: 4_000 } as const;
export const WEIGHT_LIMITS = { min: 0.1, max: 10 } as const;
/**
 * The weights of two panes stacked in a column for a split that gives the first the share `share` (0 to 1) of its height: the pair always adds up to 2, what
 * 1 and 1 do, so that the page lays out what a file or storage reads back (`readPlan` holds a weight within `WEIGHT_LIMITS`; a pair that kept the sum of what
 * an imported plan had, 10 and 10, was dragged to 15 and 5 and read back as 10 and 5).
 */
export function splitWeights(share: number): [number, number] {
  // The share is held where both weights stay at the least one (a pane of a tenth of the other's height at most), then the pair is derived: it adds up to 2 always.
  const lo = WEIGHT_LIMITS.min / 2, s = Number.isFinite(share) ? Math.max(lo, Math.min(1 - lo, share)) : 0.5, a = Math.round(2 * s * 1000) / 1000;
  return [a, Math.round((2 - a) * 1000) / 1000];
}

/** A column's width from storage or a file, or null (follows the window). */
function readWidth(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? Math.max(WIDTH_LIMITS.min, Math.min(WIDTH_LIMITS.max, Math.round(v))) : null;
}

/**
 * A plan from storage or a file, or null when there is none to read. Every id is one of the side panes and stands once (the first place
 * named wins); a pane the plan leaves out (one added since, or a file written by hand) goes where it goes by default.
 */
export function readPlan(raw: unknown): DockPlan | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  if (!Array.isArray(r.left) && !Array.isArray(r.right)) return null;
  const seen = new Set<string>(), take = (list: unknown): SidePaneId[] => (Array.isArray(list) ? list : []).filter((id): id is SidePaneId => typeof id === 'string' && isSidePane(id) && !seen.has(id) && !!seen.add(id));
  const plan: DockPlan = { left: take(r.left), right: take(r.right), leftW: readWidth(r.leftW), rightW: readWidth(r.rightW), weights: {} };
  for (const id of SIDE_PANES) if (!seen.has(id)) plan[HOME_SIDE[id]].push(id);
  if (r.weights && typeof r.weights === 'object') {
    for (const id of SIDE_PANES) {
      const w = (r.weights as Record<string, unknown>)[id];
      if (typeof w === 'number' && Number.isFinite(w)) plan.weights[id] = Math.max(WEIGHT_LIMITS.min, Math.min(WEIGHT_LIMITS.max, w));
    }
  }
  return plan;
}

/**
 * The plan a save from before the side panes could move stands for: the flow column left of the map, the book right of it, a width kept only
 * where a drag set one (a width equal to the one a column had before it followed the window was written by a save of something else).
 */
export function legacyPlan(flowW: unknown, sideW: unknown, oldFlowW = 300, oldSideW = 420): DockPlan {
  const hand = (w: unknown, was: number): number | null => typeof w === 'number' && w !== was ? readWidth(w) : null;
  return { left: ['cvd'], right: ['book'], leftW: hand(flowW, oldFlowW), rightW: hand(sideW, oldSideW), weights: {} };
}

export const sideOf = (plan: DockPlan, id: SidePaneId): Side => plan.left.includes(id) ? 'left' : 'right';

/**
 * `id` moved to `side`, before `beforeId` (the end of the column when that is null or not there). A pane that was the only one open in its
 * column and lands in a column with none open carries the width it was given across (the column it leaves goes back to following the window);
 * otherwise the column it lands in keeps its own width. `shown` says which panes are open (all, when it is left out).
 */
export function moveSide(plan: DockPlan, id: SidePaneId, side: Side, beforeId: SidePaneId | null = null, shown?: Readonly<Record<SidePaneId, boolean>>): DockPlan {
  const next = clonePlan(plan), from = sideOf(plan, id), open = (list: readonly SidePaneId[]): SidePaneId[] => list.filter(x => x !== id && (shown?.[x] ?? true));
  const alone = from !== side && open(plan[from]).length === 0 && open(plan[side]).length === 0;
  next[from] = next[from].filter(x => x !== id);
  const target = next[side].filter(x => x !== id), at = beforeId === null ? -1 : target.indexOf(beforeId);
  if (at < 0) target.push(id); else target.splice(at, 0, id);
  next[side] = target;
  if (alone) {
    const key = (s: Side): 'leftW' | 'rightW' => s === 'left' ? 'leftW' : 'rightW';
    next[key(side)] = plan[key(from)]; next[key(from)] = null;
  }
  return next;
}

/** The two columns exchanged, widths and all. */
export function swapSides(plan: DockPlan): DockPlan {
  return { left: [...plan.right], right: [...plan.left], leftW: plan.rightW, rightW: plan.leftW, weights: { ...plan.weights } };
}

/** `id` one place up or down in its column, among the panes that are open (a closed one is stepped over): the plan when there is nowhere to go. */
export function nudge(plan: DockPlan, id: SidePaneId, dir: -1 | 1, shown: Readonly<Record<SidePaneId, boolean>>): DockPlan {
  const side = sideOf(plan, id), list = plan[side], i = list.indexOf(id);
  for (let j = i + dir; j >= 0 && j < list.length; j += dir) {
    if (!shown[list[j]!]) continue;
    const next = clonePlan(plan), moved = [...list];
    moved[i] = list[j]!; moved[j] = id; next[side] = moved;
    return next;
  }
  return plan;
}

/** The panes of each column that are open now, and whether a column is laid out (open), shows only an edge tab to bring its panes back (rail), or is not there (none). */
export type ColumnState = 'open' | 'rail' | 'none';
export function openIn(plan: DockPlan, side: Side, shown: Readonly<Record<SidePaneId, boolean>>): SidePaneId[] { return plan[side].filter(id => shown[id]); }
export function columnState(plan: DockPlan, side: Side, shown: Readonly<Record<SidePaneId, boolean>>): ColumnState {
  return openIn(plan, side, shown).length ? 'open' : plan[side].length ? 'rail' : 'none';
}

/** The share of a window the columns may take: the map keeps the rest. Each column alone up to `MAX_COLUMN_SHARE`, both together up to `MAX_BOTH_SHARE`. */
export const MAX_COLUMN_SHARE = 0.6, MAX_BOTH_SHARE = 0.62;
/** The narrowest a column is made by a drag: what its panes need to show their controls. */
export const MIN_COLUMN_W: Readonly<Record<SidePaneId, number>> = { cvd: 200, book: 260 };
/** The same on a touch screen, whose buttons are 30 px: the flow column's first header line (its name, the "?", the settings key, the menu and the close button) takes 236 px of them. */
export const MIN_COLUMN_W_TOUCH: Readonly<Record<SidePaneId, number>> = { cvd: 240, book: 260 };
export const minWidthOf = (ids: readonly SidePaneId[], touch = false): number => { const table = touch ? MIN_COLUMN_W_TOUCH : MIN_COLUMN_W; return ids.reduce((m, id) => Math.max(m, table[id]), 0) || table.cvd; };

/** The widest a column may be made in a window `windowW` wide when the one on the other side is `otherW` wide (0 when it is not laid out), never under its own minimum. */
export function maxColumnWidth(windowW: number, otherW: number, min: number): number {
  return Math.max(min, Math.floor(Math.min(windowW * MAX_COLUMN_SHARE, windowW * MAX_BOTH_SHARE - otherW)));
}

/**
 * Two column widths that fit a window: as wanted (and no less than each one's panes need) while together they leave the map its share, else both
 * taken down in proportion, neither under its own minimum. A layout from a wider screen would otherwise squeeze the map to nothing. The minimums come
 * first: a pair that fits only until each is raised to what its panes need (150 and 480 px in a window of 1,024 px) is over the room.
 */
export function fitColumns(wantLeft: number, wantRight: number, windowW: number, minLeft: number, minRight: number): [number, number] {
  const room = windowW * MAX_BOTH_SHARE, left = Math.max(wantLeft, minLeft), right = Math.max(wantRight, minRight), total = left + right;
  if (total <= room || total <= 0) return [left, right];
  const f = room / total;
  let l = Math.max(minLeft, Math.floor(left * f)), r = Math.max(minRight, Math.floor(right * f));
  // A column cut down to its minimum leaves the other cut by proportion alone, and the two can still be over the room (a column of 4,000 px beside one of 150):
  // the one that is not at its minimum gives the rest, so that the map keeps its share whenever the minimums leave it one.
  if (l + r > room) {
    if (r <= minRight) l = Math.max(minLeft, Math.floor(room - r));
    else if (l <= minLeft) r = Math.max(minRight, Math.floor(room - l));
  }
  return [l, r];
}

/**
 * The widths the two columns are laid out at, given what each is asked for (`want`) and the least its open panes need (`min`): while both are
 * open they are taken down together when they would leave the map too little (`fitColumns`); an open column is never narrower than its panes need
 * nor wider than the window allows, whatever width was kept for it (a layout from a wider window, or a width carried across by a move). A column
 * that is not open keeps what it is asked for.
 */
export function laidOutWidths(want: readonly [number, number], min: readonly [number, number], open: readonly [boolean, boolean], windowW: number): [number, number] {
  const fitted = open[0] && open[1] ? fitColumns(want[0], want[1], windowW, min[0], min[1]) : [want[0], want[1]];
  const size = (i: 0 | 1): number => open[i] ? Math.max(min[i], Math.min(fitted[i]!, maxColumnWidth(windowW, 0, min[i]))) : fitted[i]!;
  return [size(0), size(1)];
}

/**
 * The narrowest plot a desktop's map is left with before its side columns fold to their edge tabs (Karl, 2026-11-03: "let desktop minimize
 * side panes if needed"). An iPad Air on its side (1,180 px) with the Flow and the Book open left the map 144 px (378 with the Flow folded);
 * a 1,440 px window 359 (618). The page's own first visits at 1,500 px (where the Flow first opens: 391) and 1,600 px (the width the columns
 * were designed at: 446) keep theirs. Only the Flow's column folds: the Book is the product, so the person closes it, never the rule.
 */
export const MAP_PLOT_FLOOR = 360;
/** One column as `chooseFold` weighs it. */
export interface FoldSide {
  /** What the column is by the page's switches: a pane open in it, only closed ones (edge tabs), or none. */
  state: ColumnState;
  /** The width it is asked for, and the least its open panes need. */
  want: number; min: number;
  /** The width the stylesheet gives it, unrounded, when it was not dragged: laid out at its asked width, it is that wide. */
  exact?: number;
  /** It holds the book open: it never folds. */
  book: boolean;
}
export interface FoldInput {
  windowW: number;
  sides: Readonly<Record<Side, FoldSide>>;
  /** The width of a column's splitter, and of a column folded to its edge tabs. */
  splitW: number; railW: number;
  /** The plot a map pane this wide is left with, its own columns taken off (they narrow under a width, so a narrower pane can have the wider plot). */
  plotAt: (paneW: number) => number;
  floor: number;
}
/**
 * Whether to fold the open column without the book so the map keeps `floor` of plot: not if the map already has it, or if folding would
 * leave it less. Each is weighed with the plot its own pane width gives (the map's columns narrow under a width, so folding can leave the
 * plot smaller: a 478 px pane with compact columns has 388 px of plot, a 722 px one with full columns 306). A column holding the book never
 * folds (`MAP_PLOT_FLOOR`).
 */
export function chooseFold(input: FoldInput): { fold: Side[]; plot: number } {
  const { windowW, sides, splitW, railW, plotAt, floor } = input;
  const candidates: Side[][] = [[], ...SIDES.filter(s => sides[s].state === 'open' && !sides[s].book).map(s => [s])];
  const plotOf = (fold: readonly Side[]): number => {
    const open = SIDES.map(s => sides[s].state === 'open' && !fold.includes(s)) as [boolean, boolean];
    const widths = laidOutWidths([sides.left.want, sides.right.want], [sides.left.min, sides.right.min], open, windowW);
    let pane = windowW;
    SIDES.forEach((s, i) => {
      const own = sides[s], w = widths[i]! === own.want && own.exact !== undefined ? own.exact : widths[i]!;
      if (open[i]) pane -= w + splitW; else if (own.state !== 'none') pane -= railW;
    });
    // The map measures its pane in whole pixels, rounded down (panes/heat-pane.ts): at 519.6 px its columns are already the compact ones.
    return plotAt(Math.max(1, Math.floor(pane)));
  };
  let best = { fold: [] as Side[], plot: -Infinity };
  for (const fold of candidates) {
    const plot = plotOf(fold);
    if (plot >= floor) return { fold, plot };
    if (plot > best.plot) best = { fold, plot };
  }
  return best;
}

/** The pane whose default width a column has: the book (the wider) when it is open there, else the first pane that is open, else the first it holds. */
export function leadOf(plan: DockPlan, side: Side, shown: Readonly<Record<SidePaneId, boolean>>): SidePaneId | undefined {
  const open = openIn(plan, side, shown);
  return open.includes('book') ? 'book' : open[0] ?? (plan[side].includes('book') ? 'book' : plan[side][0]);
}

/** Equal plans: the same panes in the same places, and the same sizes within `tolerance` px (a column that follows the window is only equal to one that does). */
export function samePlan(a: DockPlan, b: DockPlan, tolerance = 8): boolean {
  const near = (x: number | null, y: number | null): boolean => x === null || y === null ? x === y : Math.abs(x - y) <= tolerance;
  const sameList = (x: readonly string[], y: readonly string[]): boolean => x.length === y.length && x.every((id, i) => id === y[i]);
  const weight = (p: DockPlan, id: SidePaneId): number => p.weights[id] ?? 1;
  return sameList(a.left, b.left) && sameList(a.right, b.right) && near(a.leftW, b.leftW) && near(a.rightW, b.rightW) && SIDE_PANES.every(id => Math.abs(weight(a, id) - weight(b, id)) < 0.05);
}
