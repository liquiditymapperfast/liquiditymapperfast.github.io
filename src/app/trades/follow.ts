/**
 * When the Tape's lists follow their newest row and when they stay held (Karl, 2026-11-15, in Safari: with 1 second chosen "you always have to
 * scroll manually to the latest row"; reviews r19). Pure: both lists (`panes/trades-blocks.ts`, `panes/trades-orders.ts`) ask it.
 *
 * A list holds while a mouse moves on it (Karl's design of 2026-11-14) and while scrolled back. Rows keep arriving above a held list (a block
 * each second, orders as they come), so how far back it is scrolled is measured from the row its hold began at, not from the newest row.
 * Positions are each list's own, larger for newer rows: a block's start second, an order's write number.
 */

/**
 * Whether a held list is scrolled back: its top row (`top`) is older than the row its hold began at (`start`), or is that row with part of it
 * scrolled out at the top. A list scrolled back stays held when the mouse leaves (its key brings it back to now); one moved up to rows newer
 * than it was held at is not, and lets go when the mouse leaves (review r19: a trackpad's step up into a row that had arrived while the mouse
 * rested on the list kept it held after the mouse left).
 */
export const scrolledBack = (top: number, start: number, offset: number): boolean => top < start || (top === start && Math.round(offset) > 0);

/**
 * What a scroll step of `dy` px (down: older) that ends on the newest row, `offset` px into it, does:
 * - 'follow': the list lets go and follows the newest again. A step up into the newest row or back to its top, the mouse on the list or not
 *   (up into it is the top: each row that arrives above a held list would otherwise leave it part-hidden, held as if scrolled back); or any
 *   step to its top with no mouse on the list (a finger).
 * - 'top': it stays held at the top: a block or row is chosen, or the mouse is on the list and the step was not up (a sub-pixel nudge down).
 * - null: it is not at the top (scrolled into the newest row).
 */
export function newestStep(dy: number, offset: number, mouseOn: boolean, chosen: boolean): 'follow' | 'top' | null {
  if (!(dy < 0) && Math.round(offset) > 0) return null;
  if (chosen) return 'top';
  return dy < 0 || !mouseOn ? 'follow' : 'top';
}
