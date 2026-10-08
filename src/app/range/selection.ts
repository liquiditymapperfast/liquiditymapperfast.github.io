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
}

export const MINUTE = 60_000;

/** A drag in progress: where it began and where the pointer is, in time and (on the map) price. */
export function draftOf(from: { t: number; p: number | null }, to: { t: number; p: number | null }): RangeSelection {
  const box = from.p !== null && to.p !== null;
  return { t0: Math.min(from.t, to.t), t1: Math.max(from.t, to.t), p0: box ? Math.min(from.p!, to.p!) : null, p1: box ? Math.max(from.p!, to.p!) : null, live: false, draft: true };
}

/**
 * The whole minutes a drag touches (one at least), and whether it is live: a selection that reaches into the open minute ends with it.
 * A band with no height (a click, or a drag along one price) is no band: it becomes every price.
 */
export function snap(draft: RangeSelection, now: number): RangeSelection {
  const open = Math.floor(now / MINUTE) * MINUTE;
  let t0 = Math.floor(draft.t0 / MINUTE) * MINUTE, t1 = Math.max(t0 + MINUTE, Math.ceil(draft.t1 / MINUTE) * MINUTE);
  const live = t1 > open;
  if (live) { t1 = open + MINUTE; t0 = Math.min(t0, open); }
  const band = draft.p0 !== null && draft.p1 !== null && draft.p1 > draft.p0;
  return { t0, t1, p0: band ? draft.p0 : null, p1: band ? draft.p1 : null, live, draft: false };
}

/** A live selection moved on to the minute that is open at `now` (the same object when nothing moved). */
export function follow(sel: RangeSelection, now: number): RangeSelection {
  if (!sel.live) return sel;
  const t1 = Math.floor(now / MINUTE) * MINUTE + MINUTE;
  return t1 === sel.t1 ? sel : { ...sel, t1 };
}

/** Pixels a drag must cover before it is a selection rather than a click. */
export const DRAG_MIN_PX = 4;

/** Whether a press with the mouse starts a selection: the Range tool is armed, or Ctrl (Cmd on a Mac) is held. */
export const selects = (armed: boolean, e: { ctrlKey: boolean; metaKey: boolean; button: number }): boolean => e.button === 0 && (armed || e.ctrlKey || e.metaKey);

/** How often a live selection is asked about again: twenty times as long as the last answer took, between two and thirty seconds. */
export const refreshMs = (lastMs: number): number => Math.max(2_000, Math.min(30_000, Math.round(lastMs * 20)));

/** A price step for the rows of a selection: about 120 rows across a box, and the grid step of the map for a stretch of time (the recorder merges further when there are too many). */
export function rowStep(sel: Pick<RangeSelection, 'p0' | 'p1'>, gridStep: number): number {
  if (sel.p0 === null || sel.p1 === null) return gridStep;
  const raw = (sel.p1 - sel.p0) / 120, magnitude = 10 ** Math.floor(Math.log10(raw));
  const nice = [1, 2, 2.5, 5, 10].map(m => m * magnitude).find(s => s >= raw) ?? 10 * magnitude;
  return Math.max(nice, gridStep / 40);
}
