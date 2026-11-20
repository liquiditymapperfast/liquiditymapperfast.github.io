/**
 * When a payment's Plus is asked for (the checkout recovery, `design.md` 6.3 as the page build spec section 5 keeps it, 2026-11-20). An attempt
 * (a checkout completing, or a press of "Set up Plus" / "Try again") asks the server at most `MAX_ASKS` times:
 * - the next ask goes no sooner than the previous one plus the backoff step (3, 4, 6, 9, 13, 20, then 30 s), and no sooner than the end of
 *   any wait the server named (`Retry-After`, counted from the answer's arrival), never shortened;
 * - an attempt ends `ATTEMPT_MS` after it began on the monotonic clock (`performance.now()`), and, as a guard for a suspended device whose
 *   monotonic clock may stand still, once the wall clock shows more than `WALL_GUARD_MS` since it began;
 * - an ask that could only go after the deadline is not sent: the attempt ends there. When a wait the server named was what pushed it past,
 *   that wait's end becomes the tab's cooldown: a press before then sends nothing and says how long is left.
 * With instant answers that name no wait, the asks go at 0, 3, 7, 13, 22, 35, 55 and 85 s.
 *
 * Pure: it decides from the clocks it is given and starts no timer, so its caller runs whatever it must before each ask (a transaction) and
 * sleeps as it is told. The server's waits are kept by the tab (`TabWaits`), across attempts and payments: the server's brakes are per address.
 */

/** The wait after each ask before the next (the last repeats). */
export const BACKOFF_MS: readonly number[] = [3_000, 4_000, 6_000, 9_000, 13_000, 20_000, 30_000];
/** An attempt's deadline on the monotonic clock, its guard on the wall clock, and its most asks. */
export const ATTEMPT_MS = 90_000, WALL_GUARD_MS = 600_000, MAX_ASKS = 8;

/** The monotonic clock (`performance.now()`) and the wall clock (`Date.now()`), in milliseconds. */
export interface Clocks { mono(): number; wall(): number }
export const pageClocks: Clocks = { mono: () => performance.now(), wall: () => Date.now() };

/**
 * What the next step is: ask now (`send`), sleep `ms` and ask again what to do (`wait`), or stop (`end`): the tab's cooldown holds
 * (`cooldown`), the next ask could only go after the deadline (`deadline`), the wall clock's guard ran out (`wall`), or the asks are used up
 * (`asks`). `cooldownMs`: how long the tab's cooldown has left (0: none).
 */
export type Step =
  | { kind: 'send' }
  | { kind: 'wait'; ms: number }
  | { kind: 'end'; why: 'cooldown' | 'deadline' | 'wall' | 'asks'; cooldownMs: number };

/**
 * Why the server named a wait: too many tries (`limited`, a 429), too many keys in a day (`keys`), or the server busy or down (`other`): the
 * words said for it differ (Sol, code review C2-9).
 */
export type WaitWhy = 'limited' | 'keys' | 'other';

/** The waits the server named in this tab, kept across attempts: the latest end of any, and the cooldown (both on the monotonic clock). */
export class TabWaits {
  #notBefore = -Infinity;
  #notBeforeWhy: WaitWhy = 'other';
  #cooldown = -Infinity;
  #cooldownWhy: WaitWhy = 'other';
  constructor(readonly clocks: Clocks = pageClocks) {}
  /** An answer arrived now; it named a wait of `retryAfterSeconds` (or none), for `why`. */
  heard(retryAfterSeconds?: number, why: WaitWhy = 'other'): void {
    if (retryAfterSeconds !== undefined && Number.isFinite(retryAfterSeconds) && retryAfterSeconds > 0) {
      const end = this.clocks.mono() + retryAfterSeconds * 1_000;
      if (end > this.#notBefore) { this.#notBefore = end; this.#notBeforeWhy = why; }
    }
  }
  /** No ask goes before this (monotonic ms). */
  get notBefore(): number { return this.#notBefore; }
  /** Why the latest wait was named. */
  get notBeforeWhy(): WaitWhy { return this.#notBeforeWhy; }
  /** An attempt that ends with the server's wait reaching past its deadline: no press asks before the wait's end. */
  coolUntil(at: number, why: WaitWhy = 'other'): void { if (at > this.#cooldown) { this.#cooldown = at; this.#cooldownWhy = why; } }
  /** A wait of `seconds` from now becomes the cooldown (`too_many_keys`: no key can be made before it ends). */
  coolFor(seconds: number, why: WaitWhy = 'keys'): void { if (Number.isFinite(seconds) && seconds > 0) this.coolUntil(this.clocks.mono() + seconds * 1_000, why); }
  /** How long the cooldown has left (ms), 0 when none. */
  cooldownLeft(): number { return Math.max(0, this.#cooldown - this.clocks.mono()); }
  /** Why the cooldown was set. */
  get cooldownWhy(): WaitWhy { return this.#cooldownWhy; }
  /** How long until anything may be asked at all (the cooldown, or the latest wait named), and why; 0 when nothing holds. */
  waitLeft(): { ms: number; why: WaitWhy } {
    const now = this.clocks.mono(), cool = this.#cooldown - now, wait = this.#notBefore - now;
    if (cool <= 0 && wait <= 0) return { ms: 0, why: 'other' };
    return cool >= wait ? { ms: cool, why: this.#cooldownWhy } : { ms: wait, why: this.#notBeforeWhy };
  }
  /** A new attempt, beginning now. */
  attempt(): Attempt { return new Attempt(this); }
}

export class Attempt {
  readonly #waits: TabWaits;
  readonly #mono0: number;
  readonly #wall0: number;
  #asks = 0;
  #lastSend = -Infinity;
  #inFlight = false;
  #ended: Extract<Step, { kind: 'end' }> | null = null;
  constructor(waits: TabWaits) {
    this.#waits = waits;
    this.#mono0 = waits.clocks.mono();
    this.#wall0 = waits.clocks.wall();
  }
  /** How many asks went. */
  get asks(): number { return this.#asks; }
  /** The deadline on the monotonic clock. */
  get deadline(): number { return this.#mono0 + ATTEMPT_MS; }

  #end(why: 'cooldown' | 'deadline' | 'wall' | 'asks'): Step {
    // The server's own wait reaching past the deadline becomes the tab's cooldown (never the backoff's).
    if (why !== 'cooldown' && this.#waits.notBefore > this.deadline) this.#waits.coolUntil(this.#waits.notBefore, this.#waits.notBeforeWhy);
    this.#ended = { kind: 'end', why, cooldownMs: this.#waits.cooldownLeft() };
    return this.#ended;
  }
  /** What to do now, by the clocks now (asked again after every sleep, so a clock that jumped meanwhile counts). */
  next(): Step {
    if (this.#ended) return this.#ended;
    if (this.#inFlight) throw new Error('an ask is still in flight');
    const { mono, wall } = this.#waits.clocks, now = mono();
    if (this.#waits.cooldownLeft() > 0) return this.#end('cooldown');
    if (wall() - this.#wall0 > WALL_GUARD_MS) return this.#end('wall');
    if (this.#asks >= MAX_ASKS) return this.#end('asks');
    const backoff = this.#asks === 0 ? now : this.#lastSend + BACKOFF_MS[Math.min(this.#asks - 1, BACKOFF_MS.length - 1)]!;
    const at = Math.max(now, backoff, this.#waits.notBefore);
    if (at > this.deadline) return this.#end('deadline');
    return at > now ? { kind: 'wait', ms: at - now } : { kind: 'send' };
  }
  /** The ask went now (after `next` said `send`). */
  sent(): void { this.#asks++; this.#lastSend = this.#waits.clocks.mono(); this.#inFlight = true; }
  /** Its answer arrived now, naming a wait of `retryAfterSeconds` (or none), for `why`. */
  answered(retryAfterSeconds?: number, why: WaitWhy = 'other'): void { this.#inFlight = false; this.#waits.heard(retryAfterSeconds, why); }
  /** No answer came (not reached, or given up): the backoff alone decides the next ask. */
  lost(): void { this.#inFlight = false; }
}
