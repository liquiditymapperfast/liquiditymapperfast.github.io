/**
 * Where a floating window goes, as numbers: no DOM and no clock, so the rules are tested alone. A panel opens on the side of its button where
 * it fits, and a window that has been dragged is kept where a person can still take hold of it.
 */
export interface Box { left: number; top: number; right: number; bottom: number }
export interface View { width: number; height: number }
export type Side = 'below' | 'above';
export interface Placement { side: Side; top: number; left: number; maxHeight: number }
export interface Dragged { top: number; left: number; maxHeight: number }

/** The space left between a panel and its button, and between a panel and the edge of the window. */
export const GAP = 6, EDGE = 8;
/** A panel is never made shorter than this, however little room there is: a few rows is a window, a sliver is not. */
export const FLOOR = 180;

const clamp = (value: number, low: number, high: number): number => Math.min(Math.max(value, low), Math.max(low, high));

/**
 * The side of its button a panel `need` tall (as tall as its contents make it) goes on: below when it fits there, above when it fits
 * there, and else the side with more room (its body then scrolls). The first of these that holds, so a panel that fits keeps to the side it
 * is usually on, and one that does not fit anywhere takes the bigger half instead of whichever happens to be under the button.
 */
export function chooseSide(anchor: Box, need: number, view: View): Side {
  const below = view.height - anchor.bottom - GAP - EDGE, above = anchor.top - GAP - EDGE;
  if (need <= below) return 'below';
  if (need <= above) return 'above';
  return above > below ? 'above' : 'below';
}

/** Where the panel goes on `side` of its button, and the tallest it may be there. It always lies whole inside the window. */
export function placeOn(side: Side, anchor: Box, need: number, width: number, align: 'left' | 'right', view: View): Placement {
  const room = side === 'below' ? view.height - anchor.bottom - GAP - EDGE : anchor.top - GAP - EDGE;
  const maxHeight = Math.max(FLOOR, Math.min(view.height - 2 * EDGE, room));
  const height = Math.min(need, maxHeight);
  const top = clamp(side === 'below' ? anchor.bottom + GAP : anchor.top - GAP - height, EDGE, view.height - EDGE - height);
  const left = clamp(align === 'right' ? anchor.right - width : anchor.left, EDGE, view.width - width - EDGE);
  return { side, top, left, maxHeight };
}

/**
 * Where a window that is dragged to `want` ends up. It stays whole inside the window sideways; vertically it may go as low as leaves the
 * floor of it showing (so its title bar can always be taken hold of again); and it may be as tall as the space from its top to the
 * bottom of the window, which is why dragging a panel that was clipped upward shows more of it.
 */
export function dragTo(want: { left: number; top: number }, size: { width: number; need: number }, view: View): Dragged {
  const left = clamp(want.left, EDGE, view.width - size.width - EDGE);
  const top = clamp(want.top, EDGE, view.height - EDGE - Math.min(size.need, FLOOR));
  return { left, top, maxHeight: Math.max(FLOOR, view.height - top - EDGE) };
}
