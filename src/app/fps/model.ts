/**
 * The status bar's frame-rate meter, its arithmetic (2026-11-14, Karl: an LED panel that shows the page's frame rate, and says how to make it
 * faster when it is low). Pure: the meter (`fps/meter.ts`) feeds it the intervals between the browser's animation frames.
 *
 * It measures the page, not the Tape: the Tape's list moves on about 80 % of frames while orders flow (it rests between batches), so a count
 * of its paints would read 48 on a perfect 60 Hz screen.
 */

/** The rates screens run at (Hz), slowest first. Their bands cover the common ones in between (170 Hz counts for 165, 280 for 300). */
export const REFRESH_RATES: readonly number[] = [48, 50, 60, 75, 90, 100, 120, 144, 165, 180, 200, 240, 300, 360, 480, 540];
/** A rate's band: the intervals within 8 % of its frame time count for it, each for the nearest rate only (48 and 50 Hz, 165 and 180 are closer than that). */
export const RATE_BAND = 0.08;
/** The share of the last minute's intervals that the band of a new screen rate holds at least. */
export const RATE_SHARE = 0.1;
/** The share that keeps the rate already read (review r18: one threshold made a page near it flip between two readings, 38 times in 5 minutes). */
export const RATE_KEEP = 0.06;
/** Intervals this short (ms) are no screen's frames (two callbacks of one frame): the fastest screen listed beats every 2.08 ms. */
export const MIN_INTERVAL = 1.5;
/** Fewer counted intervals than this say nothing of the screen yet: the reading before is kept (60 before any). */
export const MIN_COUNTED = 30;

/** The rate an interval of `ms` counts for: the index in `REFRESH_RATES` of the nearest (by ratio) within its band, or -1 (none, or too short to be a frame). */
export function bandOf(ms: number): number {
  if (!(ms > MIN_INTERVAL) || !Number.isFinite(ms)) return -1;
  let best = -1, off = Math.log(1 + RATE_BAND);
  for (let i = 0; i < REFRESH_RATES.length; i++) { const d = Math.abs(Math.log((ms * REFRESH_RATES[i]!) / 1000)); if (d <= off) { best = i; off = d; } }
  return best;
}

/**
 * The screen's rate from the last minute's intervals: `counts[i]` of them fell in the band of `REFRESH_RATES[i]`, `total` were counted. It is
 * the fastest rate whose band holds at least a tenth of them (the rate already read, `fallback`: 6 %) and at least as many as each of its
 * two neighbours in the table. A frame comes on a beat of the screen, or a whole number of beats later when the page was busy, so the
 * screen's own band is the fastest that a good share of intervals fall in. A few early frames (timer jitter) are far fewer than a tenth,
 * so a long session does not drift to a faster rate, and a rate that is gone (another screen of the same size, a laptop on battery) leaves
 * the window within a minute (review r17: the fastest frames since the page opened did neither). Timestamp noise spills a share of a fast
 * screen's intervals into the next faster band, never more than stay in its own (review r18: 0.25 ms of noise read a 144 Hz screen as 165).
 *
 * No band qualifying, as for a page held at 30 frames a second on a 60 Hz screen (no screen here runs at 30): the reading before
 * (`fallback`, 60 at first), so that page reads red, not smooth. Too few intervals yet: the reading before too. Not knowable from frame
 * times alone: a page held for a whole minute at a whole fraction of a fast screen's rate that is itself a listed rate reads as that
 * slower screen (on 144 Hz, 72 frames a second read 75 Hz and 48 read 48; on 240 Hz, 120, 80 and 60 read 120, 75 and 60).
 */
export function refreshOf(counts: ArrayLike<number>, total: number, fallback = 60): number {
  if (total < MIN_COUNTED) return fallback;
  const n = REFRESH_RATES.length;
  for (let i = n - 1; i >= 0; i--) {
    const c = counts[i]!, need = REFRESH_RATES[i] === fallback ? RATE_KEEP : RATE_SHARE;
    if (c >= need * total && c >= (i > 0 ? counts[i - 1]! : 0) && c >= (i < n - 1 ? counts[i + 1]! : 0)) return REFRESH_RATES[i]!;
  }
  return fallback;
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
  /** Frames a second over the part of the last minute seen. */
  fpsMinute: number | null;
  /**
   * The frames a second that three seconds in four of the last minute's whole seconds reached: what the panel's advice goes by. A stall of a
   * few seconds or the page's loading is not a slow page, a page slow a quarter of the time is (review r18: the average stayed "struggling" for
   * a minute after one 6 s stall).
   */
  fpsMost: number | null;
  hz: number;
  /** The longest interval of the last quarter second and of the last minute (ms). */
  worstQuarter: number; worstMinute: number;
  /** Late frames (`LATE_FACTOR`) in the last minute, and how much of a minute has been seen (s). */
  lateMinute: number; seenSeconds: number;
}

/** How long the page is watched before the panel says whether it runs smoothly (s): its first seconds load and build its pictures. */
export const JUDGE_AFTER_S = 20;
/** What the panel says of the page: nothing yet, smooth, or struggling. By `fpsMost` once `JUDGE_AFTER_S` are seen, never by one second's dip. */
export type Verdict = 'measuring' | 'smooth' | 'struggling';
export function verdictOf(s: FrameStats | null): Verdict {
  if (!s || s.fps === null || s.fpsMost === null || s.seenSeconds < JUDGE_AFTER_S) return 'measuring';
  return toneOf(s.fpsMost, s.hz) === 'green' ? 'smooth' : 'struggling';
}

/**
 * The frames the meter has seen: the intervals of the last minute (time, length) with how many fell in each rate's band, the screen's rate
 * read from them, and whether a second has been seen since the clock (re)started. Bounded: a minute at 480 Hz is 28,800 intervals.
 */
export class FrameWindow {
  #times: number[] = []; #lengths: number[] = []; #head = 0;
  #counts = new Uint32Array(REFRESH_RATES.length); #counted = 0;
  #hz = 60;
  #since = Number.NaN;
  /** The frames of each whole second of the last minute, newest first (for `fpsMost`). */
  #seconds = new Uint16Array(60);

  /** The clock (re)starts at `now`: what came before is a gap, not a frame (a hidden tab, a stop). The screen's rate is kept unless `screen` changed. */
  restart(now: number, screen = false): void {
    this.#hz = screen ? 60 : refreshOf(this.#counts, this.#counted, this.#hz);
    this.#times = []; this.#lengths = []; this.#head = 0; this.#since = now;
    this.#counts.fill(0); this.#counted = 0;
  }

  /** Count an interval into its band (`by` 1) or take it out again when it leaves the minute (-1). */
  #count(ms: number, by: 1 | -1): void {
    if (!(ms > MIN_INTERVAL)) return;
    this.#counted += by;
    const band = bandOf(ms);
    if (band >= 0) this.#counts[band] = this.#counts[band]! + by;
  }

  /** A frame at `now`, `ms` after the one before. */
  push(now: number, ms: number): void {
    if (!(ms > 0) || !Number.isFinite(ms)) return;
    if (Number.isNaN(this.#since)) this.#since = now - ms;
    this.#times.push(now); this.#lengths.push(ms); this.#count(ms, 1);
    // Forget what is over a minute old (the arrays are compacted now and then rather than shifted every frame).
    while (this.#head < this.#times.length && this.#times[this.#head]! < now - 60_000) { this.#count(this.#lengths[this.#head]!, -1); this.#head++; }
    if (this.#head > 4096) { this.#times = this.#times.slice(this.#head); this.#lengths = this.#lengths.slice(this.#head); this.#head = 0; }
  }

  stats(now: number): FrameStats {
    const hz = this.#hz = refreshOf(this.#counts, this.#counted, this.#hz), late = (1000 / hz) * LATE_FACTOR;
    const seen = Number.isNaN(this.#since) ? 0 : (now - this.#since) / 1000;
    const span = Math.min(60, Math.max(0, seen)), whole = Math.floor(span), seconds = this.#seconds;
    seconds.fill(0);
    let frames = 0, framesMs = 0, framesMinute = 0, worstQuarter = 0, worstMinute = 0, lateMinute = 0;
    for (let i = this.#head; i < this.#times.length; i++) {
      const at = this.#times[i]!, ms = this.#lengths[i]!;
      if (at < now - 60_000) continue;
      framesMinute++;
      const second = Math.floor((now - at) / 1000);
      if (second < whole) seconds[second] = seconds[second]! + 1;
      if (ms > worstMinute) worstMinute = ms;
      if (ms > late) lateMinute++;
      if (at > now - 1000) { frames++; framesMs += ms; }
      if (at >= now - 250 && ms > worstQuarter) worstQuarter = ms;
    }
    // The last second's rate is its frames over the time they took, not a count of the frames inside it: on a 60 Hz screen a frame falls on
    // the second's far edge about half the time (jitter), and a count read 61 then (review r17); 60 frames of 16.7 ms read 60 either way.
    const fps = seen >= 1 ? (frames && framesMs > 0 ? Math.round((frames * 1000) / framesMs) : 0) : null;
    const sorted = whole >= 1 ? Array.from(seconds.subarray(0, whole)).sort((a, b) => a - b) : [];
    const fpsMost = sorted.length ? sorted[Math.floor((sorted.length - 1) / 4)]! : null;
    return { fps, fpsMinute: seen >= 1 ? Math.round(framesMinute / span) : null, fpsMost, hz, worstQuarter, worstMinute, lateMinute, seenSeconds: span };
  }
}

/** The bar's level: it jumps up to a new hitch and falls back by `fall` of itself each quarter second (a VU meter's peak, held a moment). */
export function nextLevel(level: number, hitch: number, fall = 0.3): number {
  return Math.max(hitch, level * (1 - fall));
}
