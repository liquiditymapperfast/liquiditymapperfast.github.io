/**
 * The confirmation the Plus page shows right after Plus came on in this browser by the visitor's own doing (a key entered, a checkout claimed,
 * the receipt's email and invoice number): that it is on and until when, and the way back to the map, taken by itself after a few seconds
 * unless the visitor stays (Karl, 2026-11-18: the page swapped a section near its foot, out of sight, and said nothing). Never when the page
 * simply opens with Plus on, or when another tab turned it on: only the page's own success paths start it. The clock and the timer are
 * handed in, so the countdown is tested with a fake clock (`page.ts` draws it).
 */

/** How long before the page goes back to the map by itself. */
export const ARRIVAL_SECONDS = 5;

export interface ArrivalClock {
  now(): number;
  /** Run `run` every `ms` until the returned function is called. */
  every(ms: number, run: () => void): () => void;
}

/** What the confirmation says: until when Plus runs (null: not known), the whole seconds left, and whether it is counting down to the map. */
export interface ArrivalState { until: number | null; left: number; counting: boolean }

export class Arrival {
  state: ArrivalState | null = null;
  /** Counts the confirmations started: a new one is drawn afresh (and takes the focus), a change to the same one is drawn in place. */
  started = 0;
  #stop: (() => void) | null = null;
  #deadline = 0;

  /** `go` takes the page to the map; `changed` draws the state again. */
  constructor(private readonly clock: ArrivalClock, private readonly go: () => void, private readonly changed: () => void) {}

  /**
   * Plus came on: say so, and count down to the map unless `count` is false (a membership this browser would not keep lasts only as long as
   * this page, so the page must not leave it by itself).
   */
  start(until: number | null, count = true): void {
    this.#halt();
    this.started++;
    this.#deadline = this.clock.now() + ARRIVAL_SECONDS * 1_000;
    this.state = { until, left: ARRIVAL_SECONDS, counting: count };
    if (count) this.#stop = this.clock.every(200, () => this.#tick());
    this.changed();
  }

  #tick(): void {
    const s = this.state;
    if (!s?.counting) { this.#halt(); return; }
    const left = Math.max(0, Math.ceil((this.#deadline - this.clock.now()) / 1_000));
    if (left > 0) { if (left !== s.left) { s.left = left; this.changed(); } return; }
    // Gone before leaving, so a page the browser keeps and shows again (Back) is not left showing a countdown at nought.
    this.#halt(); this.state = null; this.changed();
    this.go();
  }

  /** Stay on this page: the confirmation stays, without the countdown. */
  stay(): void {
    if (!this.state?.counting) return;
    this.#halt(); this.state = { ...this.state, counting: false }; this.changed();
  }

  /** The visitor follows the link to the map themself: nothing more to count (the page is left as it is, for the browser to keep). */
  leaving(): void { this.#halt(); }

  /** Close the confirmation. */
  dismiss(): void {
    if (!this.state) return;
    this.#halt(); this.state = null; this.changed();
  }

  #halt(): void { this.#stop?.(); this.#stop = null; }
}
