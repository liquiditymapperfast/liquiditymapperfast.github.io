/**
 * How the Each order list moves (Karl, 2026-11-14: "it feels a bit jagged... It feels low FPS"). Orders reach the page in batches, every
 * 250 ms from the server and from the browser's own engine alike, and a list that jumped by each batch moved on 5 % of the frames of a page
 * running at 58 a second: 168 px at a time (970 at most) on BTC with grouping on. The conveyor holds what the batches added above the newest
 * row drawn (its debt, CSS px) and plays it out on every frame: at the rate rows have been coming (a moving average of the px added a
 * second), pulled toward keeping `BUF_S` seconds of them in hand, the speed eased so it never jumps, and slowing as the debt runs out so the
 * list comes to rest instead of stopping dead. Replayed over 30 s of live batches at 60 frames a second (Research_Files/
 * trades_smooth_20261114/motion-sim.mjs), it moved on 75 % of the frames, 11 px a frame, its speed changing by 8 % of itself from one frame
 * to the next, and showed a batch whole 281 ms after it came (p90 360 ms); a damped spring as steady took 385 ms, and an eased slide of each
 * batch pulsed with the batches. Pure arithmetic: `panes/trades-orders.ts` draws the list `debt` px higher than its resting place.
 */
export const BUF_S = 0.12, TAU_S = 0.3, RATE_S = 1.5, STOP_S = 0.1, EASE_S = 0.1;
/** A debt this small is no motion (CSS px; under a device pixel at every ratio a screen has). */
export const REST_PX = 0.5;
/** The longest frame the motion is stepped by: a late frame moves the list as far as the time it covered, up to this (s). */
const MAX_STEP_S = 0.1, FIRST_STEP_S = 1 / 60;

export class Conveyor {
  /** How far the newest rows still have to come down (CSS px; 0 at rest). */
  debt = 0;
  /** Everything it moved the list, jumps included (a trace for the checks that watch it). */
  travelled = 0;
  /** The speed it plays the debt out at (px/s), the moving average of what arrived (px/s), and px arrived since the last step. */
  #v = 0; #rate = 0; #arrived = 0;
  /** The last step's time (ms) and whether the list was at rest then (the first step after a rest is one frame long). */
  #last = NaN; #resting = true;

  get moving(): boolean { return this.debt > 0; }
  get speed(): number { return this.#v; }

  /** A batch added `px` above the newest row; past `cap` px of debt the rest is jumped (a burst taller than the list). */
  add(px: number, cap: number): void {
    if (!(px > 0) || !Number.isFinite(px) || !(cap >= 0)) return;
    this.#arrived += px;
    this.#take(this.debt + px, cap);
  }
  /** The list is to come down from `px` above its resting place (a hold let go): the debt is set, past `cap` jumped. */
  from(px: number, cap: number): void { if (px > 0 && cap >= 0) this.#take(Math.max(this.debt, px), cap); }
  #take(debt: number, cap: number): void {
    const keep = Math.max(0, Math.min(debt, cap));
    this.travelled += debt - keep;
    this.debt = keep;
  }

  /** Move to frame time `now` (ms): the debt to draw. A time that is not a number moves nothing. */
  step(now: number): number {
    if (!Number.isFinite(now)) return this.debt;
    const gap = Number.isFinite(this.#last) ? Math.max(0, (now - this.#last) / 1000) : 0;
    this.#last = now;
    // Every px counts once in the rate, decaying with real time: a lull lowers it, a long one forgets it.
    this.#rate = this.#rate * Math.exp(-gap / RATE_S) + this.#arrived / RATE_S;
    this.#arrived = 0;
    if (this.debt <= 0) { this.#rest(); return 0; }
    const dt = this.#resting ? Math.min(gap, FIRST_STEP_S) || FIRST_STEP_S : Math.min(gap, MAX_STEP_S);
    this.#resting = false;
    const x = this.debt, target = Math.max(0, Math.min(this.#rate + (x - this.#rate * BUF_S) / TAU_S, x / STOP_S));
    this.#v += (target - this.#v) * Math.min(1, dt / EASE_S);
    const move = Math.min(x, this.#v * dt);
    this.debt = x - move; this.travelled += move;
    if (this.debt < REST_PX) { this.travelled += this.debt; this.#rest(); }
    return this.debt;
  }
  #rest(): void { this.debt = 0; this.#v = 0; this.#resting = true; }

  /**
   * Stand still where it is drawn now (a hold, a page hidden, a list found again): nothing left to play out. The rate is kept, decaying with
   * time as ever (a hold let go catches up at the pace rows were coming: learnt again from nothing, a short hold let go jumped a little more).
   */
  reset(): void { this.#rest(); this.#arrived = 0; if (!Number.isFinite(this.#rate)) this.#rate = 0; }
}
