/**
 * Where a candle is drawn along the time axis, and how wide its body is. A closed candle sits in the middle of its slot. The one still
 * forming has the same body as every other (a thin one beside its neighbours looks like a different kind of candle) but is not held to the
 * middle of a slot that the trades have not reached: it sits as far left as the previous candle allows and follows the newest trade, its
 * right edge being "now", until it reaches the middle of its slot, where it stays. The newest trade bubbles are then at its right edge or
 * past it instead of behind it, and when the period ends it is where a closed candle is, so nothing jumps.
 */

/** The width in px of a candle's body in a slot of `slotPx`: it never fills its slot, and never gets wider than 40 px. */
export const candleBody = (slotPx: number): number => Math.max(1, Math.min(slotPx * 0.72, 40));

/** The least space in px the candle still forming leaves between its body and the one before it. */
export const FORMING_GAP_PX = 2;

/**
 * The centre (ms) of the candle that starts at `start`, for a body that is `bodyMs` of time wide and a gap of `gapMs` to keep from the
 * previous candle's body. Both are the pixel sizes times the milliseconds one pixel is worth.
 */
export function candleCentre(start: number, tfMs: number, now: number, bodyMs: number, gapMs: number): number {
  const middle = start + tfMs / 2;
  if (now >= start + tfMs) return middle;
  // The previous candle's body ends at its slot's middle plus half a body; the forming one starts a gap after that. It can never need to
  // be further right than the middle of its own slot (the packed place passes it only in a slot too narrow for a body and a gap).
  const packed = start - tfMs / 2 + bodyMs + gapMs;
  // A clock a little behind the exchange's puts "now" before the start: the candle then stays packed.
  return Math.min(middle, Math.max(packed, now - bodyMs / 2));
}
