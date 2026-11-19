/**
 * The confirmation the Plus page shows right after Plus came on in this browser by the visitor's own doing (a key entered, a checkout claimed,
 * the receipt's email and invoice number; Karl, 2026-11-18: the page swapped a section near its foot, out of sight, and said nothing): that
 * it is on and until when, and the way back to the map, which a typed key takes by itself after a few seconds unless the visitor stays
 * (`countsDown`), does anything else on the page or hides the tab (`stopOnActivity`). Never when the page simply opens with Plus on, or when
 * another tab turned it on: only the page's own success paths start it. The clock, the timer and the document are handed in, so all of it is
 * tested without a browser (`page.ts` draws it).
 */

/** How long before the page goes back to the map by itself. */
export const ARRIVAL_SECONDS = 5;

export interface ArrivalClock {
  now(): number;
  /** Run `run` every `ms` until the returned function is called. */
  every(ms: number, run: () => void): () => void;
}

/** How Plus came on here: a key typed or pasted into the key box, a checkout just paid, or the receipt's email and invoice number. */
export type ArrivalVia = 'key' | 'checkout' | 'restore';

/**
 * Whether the confirmation counts down to the map (Karl, 2026-11-18): only after a key typed or pasted into the key box. After a checkout, and
 * wherever the page shows the key (a restore shows it), the visitor must first see and copy the new key: the confirmation then offers the map
 * and waits. Nor where the browser would not keep Plus (`kept` false): it lasts only as long as this page. Nor where the tab is hidden when the
 * answer comes (`hidden`; Sol's review, round 2: a key sent, the tab left before the server answered, and the page left behind the visitor's
 * back): the confirmation waits for them.
 */
export const countsDown = (via: ArrivalVia, keyShown: boolean, kept: boolean, hidden: boolean): boolean => via === 'key' && !keyShown && kept && !hidden;

/** What the confirmation says: until when Plus runs (null: not known), the whole seconds left, and whether it is counting down to the map. */
export interface ArrivalState { until: number | null; left: number; counting: boolean }

export class Arrival {
  state: ArrivalState | null = null;
  /** Counts the confirmations started: a new one is drawn afresh (and takes the focus), a change to the same one is drawn in place. */
  started = 0;
  /** When the confirmation now shown was started (the clock's time). */
  startedAt = -Infinity;
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
    this.startedAt = this.clock.now();
    this.#deadline = this.startedAt + ARRIVAL_SECONDS * 1_000;
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

/** What the visitor can do that stops the countdown: press, type, turn the wheel, touch, scroll. */
export const STOPPING_EVENTS = ['pointerdown', 'keydown', 'wheel', 'touchstart', 'scroll'] as const;
/** Whether a key scrolls the page: such a key counts as activity wherever the focus is, the confirmation included. */
export const scrollingKey = (key: string): boolean =>
  key === 'PageDown' || key === 'PageUp' || key === 'Home' || key === 'End' || key === 'ArrowDown' || key === 'ArrowUp' || key === ' ' || key === 'Spacebar';

/**
 * Where an event happened: on the page, on the confirmation (its link included), or on one of its controls that Space presses (a button),
 * where Space does what the control says instead of scrolling.
 */
export type ArrivalPlace = 'page' | 'confirmation' | 'control';

/**
 * Where `target` is, `inside` saying whether it is on the confirmation. A link is no control here (Sol's review, round 3): Space on "Open the
 * map" scrolls the page rather than open the map, and at the page's foot does nothing at all, so letting it pass let the countdown run on.
 * Only an element can say which control it is in.
 */
export function placeOf(target: unknown, inside: (target: unknown) => boolean): ArrivalPlace {
  if (!inside(target)) return 'page';
  const element = target as { closest?: (selectors: string) => unknown } | null;
  return typeof element?.closest === 'function'
    && element.closest('button, summary, input[type="button"], input[type="submit"], input[type="reset"], input[type="checkbox"], input[type="radio"]') ? 'control' : 'confirmation';
}

/** The part of the page's `document` the countdown listens to. */
export interface ArrivalDocument {
  readonly hidden: boolean;
  addEventListener(type: string, listener: (event: { type: string; target: unknown; key?: string }) => void, options?: { capture?: boolean; passive?: boolean }): void;
}

/** What the page tells the countdown: every drawing of the page goes through `redraw`, so a scroll the drawing makes is told from the visitor's. */
export interface ArrivalActivity { redraw(draw: () => void): void }

/**
 * The countdown stops as soon as the visitor does anything on the page (Sol's review, 2026-11-18: a Reveal pressed in the five seconds showed
 * the key, and the page left anyway). Outside the confirmation (`place`): a press, a key, a touch. Anywhere, the confirmation included: the
 * wheel, a key that scrolls (Space only on a control it presses), and a scroll, except the page's own: drawn afresh, the page can grow
 * shorter and the browser moves the view. `redraw` reads the view before and after each drawing and lets pass, once, the scroll that lands
 * where the drawing itself moved it. A movement already under way when a drawing starts (the view moved since the last scroll event, whose
 * event is still to come: Sol's review, round 3, a swipe, then a server's answer drawn before the swipe's event) is the visitor's, wherever
 * the view ends. It stops too when the tab is hidden, and does not start again when it shows. Stopping is `stay`: the confirmation stays,
 * with the map a press away. Listened to once, for every confirmation.
 */
export function stopOnActivity(doc: ArrivalDocument, arrival: Arrival, place: (target: unknown) => ArrivalPlace, scrollY: () => number): ArrivalActivity {
  const stop = (): void => { if (arrival.state?.counting) arrival.stay(); };
  // Where the view stood at the document's last scroll event, and where the last drawing moved it while that move's event is still to come
  // (NaN: nowhere). Both are kept whether a countdown runs or not, so one that starts later reads the view right.
  let seen = scrollY(), own = NaN;
  const stops = (event: { type: string; target: unknown; key?: string }): boolean => {
    const where = place(event.target);
    switch (event.type) {
      case 'wheel': return true;
      case 'keydown': return where === 'page' || (scrollingKey(event.key ?? '') && !(where === 'control' && (event.key === ' ' || event.key === 'Spacebar')));
      default: return where === 'page';
    }
  };
  for (const type of STOPPING_EVENTS) {
    if (type !== 'scroll') doc.addEventListener(type, event => { if (arrival.state?.counting && stops(event)) stop(); }, { capture: true, passive: true });
  }
  doc.addEventListener('scroll', event => {
    // A box inside the page scrolled: the visitor's doing.
    if (event.target !== doc) { stop(); return; }
    // The view where the last drawing moved it: the page's own scroll, once. Anywhere else, the visitor moved it.
    const y = scrollY(), ours = y === own;
    seen = y; own = NaN;
    if (!ours) stop();
  }, { capture: true, passive: true });
  doc.addEventListener('visibilitychange', () => { if (doc.hidden) stop(); });
  return {
    redraw(draw) {
      const before = scrollY(), pending = before !== seen && before !== own;
      try { draw(); } finally {
        const after = scrollY();
        // Moved before this drawing and not by an earlier one: the visitor's movement, whose event counts whatever this drawing does.
        if (pending) own = NaN;
        else if (after !== before) own = after;
      }
    },
  };
}
