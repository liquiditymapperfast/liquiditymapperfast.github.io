/**
 * The demo's six scenes and the player that runs them (no page and no timer of its own: the demo hands it the frame clock, so it is tested
 * with a made-up one). A scene is a few steps at set times: a choice for the store, where the history window goes, a caption.
 */
import { t } from '../../i18n.ts';
import type { DemoLevels } from './store.ts';

export interface SceneStep {
  /** When, in ms from the scene's start. */
  t: number;
  set?: Partial<DemoLevels>;
  /** The history window, at once (0 the oldest week, 1 now). */
  scrub?: number;
  /** The history window, moved there over `over` ms. */
  scrubTo?: number;
  over?: number;
  caption?: () => string;
}
export interface Scene { label: () => string; dur: number; steps: readonly SceneStep[] }

export const SCENES: readonly Scene[] = [
  { label: () => t('Liquidations'), dur: 4000, steps: [{ t: 0, set: { liq: true, stops: false, takes: false, traders: 'everyone' }, scrub: 1, caption: () => t('Liquidation levels at each price.') }] },
  { label: () => t('Stops'), dur: 4000, steps: [{ t: 0, set: { liq: true, stops: true, takes: false, traders: 'everyone' }, scrub: 1, caption: () => t('Add stop losses to the curve.') }] },
  { label: () => t('Take profits'), dur: 4000, steps: [{ t: 0, set: { liq: true, stops: true, takes: true, traders: 'everyone' }, scrub: 1, caption: () => t('Take profits get their own lane.') }] },
  { label: () => t('Each alone'), dur: 6000, steps: [
    { t: 0, set: { liq: false, stops: true, takes: false, traders: 'everyone' }, scrub: 1, caption: () => t('Choose each kind on its own.') },
    { t: 3000, set: { liq: false, stops: false, takes: true }, caption: () => t('Take profits alone get a dashed curve.') }] },
  { label: () => t('Traders'), dur: 7000, steps: [
    { t: 0, set: { liq: true, stops: true, takes: true, traders: 'everyone' }, scrub: 1 },
    { t: 1400, set: { traders: 'profitable' }, caption: () => t('Profitable traders, at each price.') }] },
  { label: () => t('History'), dur: 7000, steps: [
    { t: 0, set: { liq: true, stops: true, takes: true, traders: 'everyone' }, scrub: 1, caption: () => t('Scroll back through the whole history.') },
    { t: 900, scrubTo: 0.2, over: 4600 }] },
];

/** The caption while the tour is not running. */
export const idleCaption = (): string => t('Try the switches.');

/** A step placed on the tour's own clock. */
export interface TimedStep extends SceneStep { at: number; scene: number }

export interface PlayerHost {
  /** Do a step. `animate` is false for a scene chosen by hand: its history window moves in a short glide instead of the step's own time. */
  apply(step: SceneStep, animate: boolean): void;
  /** The tour stopped by itself at its end, or a control was used: the caption goes back to its invitation. */
  idle(): void;
}

/** Why the tour is not running: the person (or the page that hosts it), the demo out of view or the tab hidden, or its end. */
export type PausedBy = 'user' | 'view' | 'end' | null;

/**
 * Runs the scenes on the time it is given (`tick(now)` once a frame while it runs). A frame late by more than 100 ms counts as 100 ms, so
 * a tab that was asleep does not skip scenes.
 */
export class Player {
  readonly scenes: readonly Scene[];
  readonly steps: readonly TimedStep[];
  readonly total: number;
  readonly #starts: readonly number[];
  #host: PlayerHost;
  #running = false;
  #pos = 0;
  #last = 0;
  #applied = -1;
  #pausedBy: PausedBy = null;

  constructor(host: PlayerHost, scenes: readonly Scene[] = SCENES) {
    this.#host = host;
    this.scenes = scenes;
    const starts: number[] = [], steps: TimedStep[] = [];
    let at = 0;
    scenes.forEach((s, i) => { starts.push(at); for (const st of s.steps) steps.push({ ...st, at: at + st.t, scene: i }); at += s.dur; });
    this.#starts = starts;
    this.steps = steps;
    this.total = at;
  }

  get running(): boolean { return this.#running; }
  get pausedBy(): PausedBy { return this.#pausedBy; }
  get position(): number { return this.#pos; }
  /** How much of scene `i` has played, 0 to 1. */
  progress(i: number): number { return Math.max(0, Math.min(1, (this.#pos - this.#starts[i]!) / this.scenes[i]!.dur)); }
  /** The scene the tour is in (the last one once it has ended), or -1 before it starts. */
  current(): number {
    if (this.#applied < 0) return -1;
    for (let i = this.scenes.length - 1; i >= 0; i--) if (this.#pos >= this.#starts[i]!) return i;
    return -1;
  }

  #catchUp(animate: boolean): void {
    while (this.#applied + 1 < this.steps.length && this.steps[this.#applied + 1]!.at <= this.#pos) this.#host.apply(this.steps[++this.#applied]!, animate);
  }

  /** Move the tour on to `now`; whether it is still running. */
  tick(now: number): boolean {
    if (!this.#running) return false;
    this.#pos += Math.max(0, Math.min(100, now - this.#last));
    this.#last = now;
    this.#catchUp(true);
    if (this.#pos >= this.total) { this.#pos = this.total; this.#running = false; this.#pausedBy = 'end'; this.#host.idle(); }
    return this.#running;
  }

  /** From the first scene. */
  start(now: number): void {
    this.#pos = 0; this.#applied = -1; this.#running = true; this.#pausedBy = null; this.#last = now;
    this.#catchUp(true);
  }

  pause(by: Exclude<PausedBy, null | 'end'>): void {
    if (this.#running) { this.#running = false; this.#pausedBy = by; }
  }

  /** On from where it stopped; from the start when it had ended. */
  resume(now: number): void {
    if (this.#pos >= this.total) { this.start(now); return; }
    this.#running = true; this.#pausedBy = null; this.#last = now;
  }

  /** Show scene `i` as it ends, paused: every step up to then done at once (one choice, the last caption, the last history window). */
  jump(i: number): void {
    this.#running = false; this.#pausedBy = 'user';
    this.#pos = this.#starts[i]! + this.scenes[i]!.dur - 1;
    const step: SceneStep = { t: 0, set: {} };
    let applied = -1;
    for (let j = 0; j < this.steps.length && this.steps[j]!.at <= this.#pos; j++) {
      const st = this.steps[j]!;
      applied = j;
      if (st.set) step.set = { ...step.set, ...st.set };
      if (st.caption) step.caption = st.caption;
      if (st.scrub !== undefined) { step.scrub = st.scrub; delete step.scrubTo; }
      if (st.scrubTo !== undefined) { step.scrubTo = st.scrubTo; delete step.scrub; }
    }
    this.#applied = applied;
    this.#host.apply(step, false);
  }

  /** The person used the demo's controls or its history: the tour stops (and stays stopped) until Play, Play again or a scene. */
  interrupt(): void {
    if (this.#running) this.pause('user');
    else if (this.#pausedBy !== 'end') this.#pausedBy = 'user';
  }
}
