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

/** The price at the middle of the bin shown on `row` (row 0 is the top; the book is centred `offsetRows` rows from the mark's bin). */
export function priceAtRow(o: { mark: number; step: number; offsetRows: number; rows: number; row: number }): number {
  return (Math.floor(o.mark / o.step) + o.offsetRows + Math.floor(o.rows / 2) - o.row + 0.5) * o.step;
}

/** The scroll offset (in rows from the mark's bin) that puts `price` on `row` when the book is grouped by `step`. */
export function offsetKeepingPrice(o: { mark: number; step: number; rows: number; row: number; price: number }): number {
  return Math.floor(o.price / o.step) - Math.floor(o.rows / 2) + o.row - Math.floor(o.mark / o.step);
}

/**
 * Turns wheel deltas (pixels) into whole zoom notches: one click of a mouse wheel is one notch, and a trackpad's stream of small deltas
 * adds up to one per `size` pixels. The first event after a pause counts at once when it is a deliberate click, and turning the wheel
 * the other way starts over, so the book never lags behind the hand.
 */
export class WheelNotches {
  #sum = 0;
  #at = -Infinity;
  constructor(private readonly size = 100, private readonly idleMs = 250, private readonly click = 30) {}

  /** Feed one event's vertical delta at `now` (ms); returns the notches to apply, positive for scrolling down. */
  add(delta: number, now: number): number {
    if (!delta) return 0;
    const fresh = now - this.#at > this.idleMs;
    this.#at = now;
    if (fresh || Math.sign(delta) !== Math.sign(this.#sum)) this.#sum = 0;
    if (fresh && Math.abs(delta) >= this.click) return Math.sign(delta);
    this.#sum += delta;
    const notches = Math.trunc(this.#sum / this.size) || 0; // `|| 0` keeps a fraction of a notch from reading as -0
    this.#sum -= notches * this.size;
    return notches;
  }
}
