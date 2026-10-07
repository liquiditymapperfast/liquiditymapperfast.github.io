/**
 * Zooming the order book: its zoom is the price step per row. These are the pure parts: the steps it moves along, wheel deltas turned
 * into whole notches, and the scroll offset that keeps the price under the pointer where it was when the step changes.
 */

/** Price step per row in USD, finest to coarsest. The Group select, the wheel and the price-column drag all move along this one list. */
export const GROUPS: readonly number[] = [0.1, 0.2, 0.5, 1, 2, 5, 10, 25, 50, 100, 250, 500, 1000];

/**
 * `notches` steps along `steps` from `step` (negative: finer, positive: coarser), stopping at the ends. `step` need not be on the list
 * (the automatic step is not always): it counts as lying between its neighbours, and a step beyond an end stays where it is.
 */
export function stepBy(step: number, notches: number, steps: readonly number[] = GROUPS): number {
  if (!notches || !(step > 0)) return step;
  const eps = 1e-9;
  if (notches > 0) {
    const at = steps.findIndex(s => s > step * (1 + eps));
    return at < 0 ? step : steps[Math.min(steps.length - 1, at + notches - 1)]!;
  }
  let at = -1;
  steps.forEach((s, i) => { if (s < step * (1 - eps)) at = i; });
  return at < 0 ? step : steps[Math.max(0, at + notches + 1)]!;
}

/**
 * The wheel as the order book uses it. A mouse click is a notch, but a zoom step regroups the book by 2 to 2.5 times, so a hard spin must not
 * make a dozen of them: clicks give at most four steps a second and never more than one per event. A touchpad's small deltas make a notch per
 * 40 px (a gentle swipe zooms), at most three a second, so one swipe and its momentum are a few steps and not the whole list.
 */
export const ladderWheel = (): WheelNotches => new WheelNotches(100, 250, 30, 40, 350, 250);

/** The price at the middle of the bin shown on `row` (row 0 is the top; the book is centred `offsetRows` rows from the mark's bin). */
export function priceAtRow(o: { mark: number; step: number; offsetRows: number; rows: number; row: number }): number {
  return (Math.floor(o.mark / o.step) + o.offsetRows + Math.floor(o.rows / 2) - o.row + 0.5) * o.step;
}

/** The scroll offset (in rows from the mark's bin) that puts `price` on `row` when the book is grouped by `step`. */
export function offsetKeepingPrice(o: { mark: number; step: number; rows: number; row: number; price: number }): number {
  return Math.floor(o.price / o.step) - Math.floor(o.rows / 2) + o.row - Math.floor(o.mark / o.step);
}

/**
 * What a zoom holds still. The mark stays on the middle row while the book is centred on it (so the book swells and shrinks around the price
 * and nothing slides past), and the price under the pointer stays where it is once the book has been scrolled off the mark or with Alt held.
 * The wheel and a drag on the price column follow this one rule, and both pass the mark as it is at each step (it moves while the hand does).
 */
export const holdsMark = (o: { offsetRows: number; alt: boolean; mark: number }): boolean => o.offsetRows === 0 && !o.alt && o.mark > 0;

/**
 * Turns wheel deltas (pixels) into whole zoom notches: one click of a mouse wheel is one notch (whatever size the browser reports it in), and a trackpad's stream of small deltas
 * adds up to one per `fine` pixels (`size` for a device that never sends small ones). The first event after a pause counts at once when
 * it is a deliberate click, and turning the wheel the other way starts over, so the book never lags behind the hand.
 *
 * A precision touchpad sends a few pixels at a time, so a gentle swipe may total well under a hundred: `fine` is what makes that one
 * notch rather than none. A flick can total thousands, and a free-spinning wheel sends clicks as fast as a finger can turn it, so a zoom
 * must be limited in time and not only in size: with `gapMs` set the small deltas make at most one notch per `gapMs`, with `clickGapMs`
 * set the clicks make at most one per `clickGapMs` (and never more than one for an event, however many clicks the browser folded into it),
 * and what the hand sends meanwhile is dropped (a touchpad keeps one notch's worth waiting) instead of throwing the zoom from one end of
 * the list to the other. Turning the wheel back is never held up: that is the hand correcting itself.
 */
export class WheelNotches {
  #sum = 0;
  #at = -Infinity;
  /** When the last notch was given, and which way it went (0: none yet). */
  #last = -Infinity;
  #dir = 0;
  /** How big one click of this wheel is: browsers send 100, but 80 or 66.7 at 125 % or 150 % scaling, so it is learned from the events. */
  #unit: number;
  constructor(private readonly size = 100, private readonly idleMs = 250, private readonly click = 30, private readonly fine = size, private readonly gapMs = 0, private readonly clickGapMs = 0) { this.#unit = size; }

  /** Feed one event's vertical delta at `now` (ms); returns the notches to apply, positive for scrolling down. */
  add(delta: number, now: number): number {
    if (!delta) return 0;
    const dir = Math.sign(delta), fresh = now - this.#at > this.idleMs;
    this.#at = now;
    if (fresh || dir !== Math.sign(this.#sum)) this.#sum = 0;
    // A notch the other way from the last one is the hand turning back, and is never held up by the gap.
    const turned = dir !== this.#dir, abs = Math.abs(delta);
    if (abs >= this.click) {
      // A click of a mouse wheel: its size is whatever single clicks have been (a lone event near the usual size is a click; a bigger one is
      // several merged into one), and every click is a notch however the display is scaled.
      if (abs >= 0.45 * this.size && abs <= 1.3 * this.size) this.#unit = abs;
      this.#sum = 0;
      if (this.clickGapMs > 0 && !turned && now - this.#last < this.clickGapMs) return 0;
      this.#last = now; this.#dir = dir;
      return dir * (this.clickGapMs > 0 ? 1 : Math.max(1, Math.round(abs / this.#unit)));
    }
    // Small deltas are weighed up so that `fine` of them make a notch; the sum is kept in the units of `size` either way.
    this.#sum += delta * (this.size / this.fine);
    if (this.gapMs > 0) {
      // One notch's worth at most waits for the gap to pass: what a flick sends beyond that is not banked to trickle out after the hand has stopped.
      this.#sum = Math.max(-this.size, Math.min(this.size, this.#sum));
      if (!turned && now - this.#last < this.gapMs) return 0;
      if (Math.abs(this.#sum) < this.size) return 0;
      this.#sum -= dir * this.size; this.#last = now; this.#dir = dir;
      return dir;
    }
    const notches = Math.trunc(this.#sum / this.size) || 0; // `|| 0` keeps a fraction of a notch from reading as -0
    this.#sum -= notches * this.size;
    if (notches) { this.#last = now; this.#dir = dir; }
    return notches;
  }
}
