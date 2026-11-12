/**
 * A selection of the map or of a pane under it, the part of the Range tool that is plain arithmetic: where a drag begins and ends, how it
 * becomes whole minutes, and when it is live.
 *
 * A drag on the map selects a box: a stretch of time and a band of prices. A drag on a pane under the map, or across the flow column, selects
 * a stretch of time at every price (`p0` and `p1` are null). The recordings are kept by the minute, so a selection is snapped once, when the
 * drag ends, to the whole minutes it touches, and everything the panel says about it is said about those minutes. A selection that reaches
 * the open minute is live: its end moves with the clock and its figures are taken again while the panel is open.
 */
export interface RangeSelection {
  t0: number; t1: number;
  p0: number | null; p1: number | null;
  live: boolean;
  /** Still being dragged (not snapped, nothing asked for yet). */
  draft: boolean;
  /** The pane under the map the drag was made in (where that pane sums up its own bars, the panel opens with its summary); absent for the map and the flow column. */
  pane?: RangePane;
  /** What it was snapped to: a minute (absent), or the bars of the pane it was made in (their length, ms), so it holds whole bars. */
  step?: number;
}

/** The panes under the map, by the name each `TimePane` is made with. */
export type RangePane = 'depth' | 'oi' | 'lt' | 'bars' | 'delta' | 'ls' | 'funding' | 'script';

export const MINUTE = 60_000;

/**
 * A drag in progress: where it began and where the pointer is, in time and (on the map) price. `step`: a pane's bars, which a drag in it
 * holds whole as it goes (the band shows the bars that will be counted).
 */
export function draftOf(from: { t: number; p: number | null }, to: { t: number; p: number | null }, pane?: RangePane, step?: number): RangeSelection {
  const box = from.p !== null && to.p !== null;
  let t0 = Math.min(from.t, to.t), t1 = Math.max(from.t, to.t);
  if (step && step > 0) { t0 = Math.floor(t0 / step) * step; t1 = Math.max(t0 + step, Math.ceil(t1 / step) * step); }
  return { t0, t1, p0: box ? Math.min(from.p!, to.p!) : null, p1: box ? Math.max(from.p!, to.p!) : null, live: false, draft: true, ...(pane ? { pane } : {}), ...(step && step > 0 ? { step } : {}) };
}

/**
 * The whole minutes a drag touches (one at least), and whether it is live: a selection that reaches into the open minute ends with it.
 * A band with no height (a click, or a drag along one price) is no band: it becomes every price. `step`: a pane's bars instead of minutes
 * (a drag in the OI pane holds whole candles of the chart's timeframe, so what it says adds up to the bars drawn), the forming one included
 * when the drag reaches it.
 */
export function snap(draft: RangeSelection, now: number, step = MINUTE): RangeSelection {
  const open = Math.floor(now / step) * step;
  let t0 = Math.floor(draft.t0 / step) * step, t1 = Math.max(t0 + step, Math.ceil(draft.t1 / step) * step);
  const live = t1 > open;
  if (live) { t1 = open + step; t0 = Math.min(t0, open); }
  const band = draft.p0 !== null && draft.p1 !== null && draft.p1 > draft.p0;
  return { t0, t1, p0: band ? draft.p0 : null, p1: band ? draft.p1 : null, live, draft: false, ...(draft.pane ? { pane: draft.pane } : {}), ...(step !== MINUTE ? { step } : {}) };
}

/** A live selection moved on to the minute (or the bar of its step) that is open at `now` (the same object when nothing moved). */
export function follow(sel: RangeSelection, now: number): RangeSelection {
  if (!sel.live) return sel;
  const step = sel.step ?? MINUTE, t1 = Math.floor(now / step) * step + step;
  return t1 === sel.t1 ? sel : { ...sel, t1 };
}

/**
 * A selection in a replay: up to its moment and never live (the live refresh would move it with the real now). The map's ends with the minute
 * the moment is in; a pane's (`closedOnly`, a pane that sums up its own bars: those closed by the moment, at any timeframe, a one-minute one
 * too) with the last bar closed by then, a bar under way carrying what came after. A selection of the bar under way alone holds nothing then
 * (its summary says no bar starts in it), rather than an earlier bar nobody chose.
 */
export function inReplay(sel: RangeSelection, moment: number, closedOnly = false): RangeSelection {
  const step = sel.step ?? MINUTE;
  if (!closedOnly) return { ...sel, t1: Math.min(sel.t1, Math.ceil(moment / MINUTE) * MINUTE), live: false };
  return { ...sel, t1: Math.max(sel.t0, Math.min(sel.t1, Math.floor(moment / step) * step)), live: false };
}

/** Pixels a drag must cover before it is a selection rather than a click. */
export const DRAG_MIN_PX = 4;

/** Whether a press with the mouse starts a selection: the Range tool is armed, or Ctrl (Cmd on a Mac) is held. */
export const selects = (armed: boolean, e: { ctrlKey: boolean; metaKey: boolean; button: number }): boolean => e.button === 0 && (armed || e.ctrlKey || e.metaKey);

/**
 * How often a live selection is asked about again: twenty times as long as the last answer took, between two and thirty seconds, and no
 * more often than every ten seconds for one of four hours or more (a long one walks every row of its minutes on the server's one thread).
 */
export const refreshMs = (lastMs: number, spanMs = 0): number => Math.max(spanMs >= 4 * 3_600_000 ? 10_000 : 2_000, Math.min(30_000, Math.round(lastMs * 20)));

/** A price step for the rows of a selection: about 120 rows across a box, and the grid step of the map for a stretch of time (the recorder merges further when there are too many). */
export function rowStep(sel: Pick<RangeSelection, 'p0' | 'p1'>, gridStep: number): number {
  if (sel.p0 === null || sel.p1 === null) return gridStep;
  const raw = (sel.p1 - sel.p0) / 120, magnitude = 10 ** Math.floor(Math.log10(raw));
  const nice = [1, 2, 2.5, 5, 10].map(m => m * magnitude).find(s => s >= raw) ?? 10 * magnitude;
  return Math.max(nice, gridStep / 40);
}
