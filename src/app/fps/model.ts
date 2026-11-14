/**
 * The status bar's frame-rate meter, its arithmetic (2026-11-14, Karl: an LED panel that shows the page's frame rate, and says how to make it
 * faster when it is low). Pure: the meter (`fps/meter.ts`) feeds it the intervals between the browser's animation frames.
 *
 * It measures the page, not the Tape: the Tape's list moves on about 80 % of frames while orders flow (it rests between batches), so a count
 * of its paints would read 48 on a perfect 60 Hz screen.
 */

/** The rates screens run at (Hz): the screen's rate is the common one nearest what the fastest frames say. */
export const REFRESH_RATES: readonly number[] = [60, 75, 90, 100, 120, 144, 165, 180, 240];
/** How many of the fastest intervals the screen's rate is read from. */
export const FASTEST_KEPT = 10;

/**
 * The screen's rate from the fastest intervals seen (ms): the median of them, snapped to the nearest common rate, never under 60. A page held
 * at 30 frames a second must not be taken for a 30 Hz screen (it would read as smooth); the fastest frames since the page opened (idle
 * moments run at the screen's rate) say what the screen can do. None yet: 60.
 */
export function refreshOf(fastest: readonly number[]): number {
  const ok = fastest.filter(ms => ms > 3 && Number.isFinite(ms)).sort((a, b) => a - b);
  if (!ok.length) return 60;
  const median = ok[Math.floor((ok.length - 1) / 2)]!, seen = 1000 / median;
  const nearest = REFRESH_RATES.reduce((best, rate) => (Math.abs(rate - seen) < Math.abs(best - seen) ? rate : best), 60);
  return Math.max(60, nearest);
}

/** How the frame rate reads against the screen's rate: green from 90 % of it, amber from 60 %, red below. */
export type Tone = 'green' | 'amber' | 'red';
export function toneOf(fps: number, hz: number): Tone {
  const share = hz > 0 ? fps / hz : 0;
  return share >= 0.9 ? 'green' : share >= 0.6 ? 'amber' : 'red';
}

/** A frame is late when it took over one and a half frames' time of the screen. */
export const LATE_FACTOR = 1.5;

/** How far a frame of `ms` ran past its budget at `hz`, 0 (on time) to 1 (four frames' time or more): the meter's bar. */
export function hitchOf(ms: number, hz: number): number {
  const budget = 1000 / Math.max(1, hz);
  return Math.max(0, Math.min(1, (ms / budget - 1) / 3));
}

/** What the meter shows and its panel says: the last second's frames, the screen's rate, the worst frames, the late ones of the last minute. */
export interface FrameStats {
  /** Frames in the last second (null until a second has been seen since the clock started or came back). */
  fps: number | null;
  /** Frames a second over the part of the last minute seen: what the panel's advice goes by (a second's dip is not a slow page). */
  fpsMinute: number | null;
  hz: number;
  /** The longest interval of the last quarter second and of the last minute (ms). */
  worstQuarter: number; worstMinute: number;
  /** Late frames (`LATE_FACTOR`) in the last minute, and how much of a minute has been seen (s). */
  lateMinute: number; seenSeconds: number;
}

/**
 * The frames the meter has seen: the intervals of the last minute (time, length), the fastest since the clock started, and whether a second
 * has been seen since it (re)started. Bounded: a minute at 240 Hz is 14,400 intervals.
 */
export class FrameWindow {
  #times: number[] = []; #lengths: number[] = []; #head = 0;
  #fastest: number[] = [];
  #since = Number.NaN;

  /** The clock (re)starts at `now`: what came before is a gap, not a frame (a hidden tab, a stop). The screen's rate is kept unless `screen` changed. */
  restart(now: number, screen = false): void {
    this.#times = []; this.#lengths = []; this.#head = 0; this.#since = now;
    if (screen) this.#fastest = [];
  }

  /** A frame at `now`, `ms` after the one before. */
  push(now: number, ms: number): void {
    if (!(ms > 0) || !Number.isFinite(ms)) return;
    if (Number.isNaN(this.#since)) this.#since = now - ms;
    this.#times.push(now); this.#lengths.push(ms);
    // The fastest few since the start, smallest first (an insertion into a list of ten).
    if (ms > 3) {
      const f = this.#fastest;
      if (f.length < FASTEST_KEPT || ms < f[f.length - 1]!) {
        let i = f.length; while (i > 0 && f[i - 1]! > ms) i--;
        f.splice(i, 0, ms); if (f.length > FASTEST_KEPT) f.pop();
      }
    }
    // Forget what is over a minute old (the arrays are compacted now and then rather than shifted every frame).
    while (this.#head < this.#times.length && this.#times[this.#head]! < now - 60_000) this.#head++;
    if (this.#head > 4096) { this.#times = this.#times.slice(this.#head); this.#lengths = this.#lengths.slice(this.#head); this.#head = 0; }
  }

  get fastest(): readonly number[] { return this.#fastest; }

  stats(now: number): FrameStats {
    const hz = refreshOf(this.#fastest), late = (1000 / hz) * LATE_FACTOR;
    let frames = 0, framesMinute = 0, worstQuarter = 0, worstMinute = 0, lateMinute = 0;
    for (let i = this.#head; i < this.#times.length; i++) {
      const at = this.#times[i]!, ms = this.#lengths[i]!;
      if (at < now - 60_000) continue;
      framesMinute++;
      if (ms > worstMinute) worstMinute = ms;
      if (ms > late) lateMinute++;
      if (at >= now - 1000) frames++;
      if (at >= now - 250 && ms > worstQuarter) worstQuarter = ms;
    }
    const seen = Number.isNaN(this.#since) ? 0 : (now - this.#since) / 1000;
    const span = Math.min(60, Math.max(0, seen));
    return { fps: seen >= 1 ? frames : null, fpsMinute: seen >= 1 ? Math.round(framesMinute / span) : null, hz, worstQuarter, worstMinute, lateMinute, seenSeconds: span };
  }
}

/** The bar's level: it jumps up to a new hitch and falls back by `fall` of itself each quarter second (a VU meter's peak, held a moment). */
export function nextLevel(level: number, hitch: number, fall = 0.3): number {
  return Math.max(hitch, level * (1 - fall));
}
