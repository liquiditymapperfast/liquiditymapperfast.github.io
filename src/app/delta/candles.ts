import { windowsOf } from '../keylevels/levels.ts';

/**
 * The Delta pane's numbers: for each candle of the chart's timeframe, what the taker buys outweighed the sells by over the instruments of the
 * flow column's ALL VENUES lines (`aggregateIds`), from their running deltas (`FlowTrack.cumDelta`: the seconds the page holds and the minutes
 * before them), and the cumulative delta (CVD) those make, restarting at the chart's left edge or at each day or week. A candle's open and
 * close are exact; its high and low are the extremes of the running delta sampled `SAMPLES` times through the candle, since the extremes of
 * a sum over several markets are not kept.
 */

/** A running delta and gross volume read at a second (seconds, not milliseconds) and the first second it holds: what `FlowTrack` is. */
export interface DeltaTrack { first: number | null; cumDelta(sec: number): number; cumGross(sec: number): number; settled?(sec: number): number }

/** One candle's flow, relative to its start: what it ended at (the delta), the lowest and highest the running sum reached (sampled), and its gross volume. */
export interface CandleFlow { delta: number; low: number; high: number; gross: number }

/** One candle as the pane draws it: its delta, the CVD's open, high, low and close, and which run of the CVD it is in (it restarts between runs). */
export interface DeltaCandle { t: number; delta: number; open: number; high: number; low: number; close: number; run: number }

export const SAMPLES = 16;

/**
 * The flow of the candle [t, t + tfMs) up to `now` from `tracks` (ms in, seconds inside). A track counts when it holds the second before the
 * candle, so it starts the candle with a base and never steps in halfway. Null when no track does (nothing recorded then).
 */
export function candleFlow(tracks: readonly DeltaTrack[], t: number, tfMs: number, now: number, samples = SAMPLES): CandleFlow | null {
  const s = Math.floor(t / 1000), e = Math.floor(Math.min(t + tfMs, now) / 1000) - 1;
  if (e < s) return null;
  const live = tracks.filter(k => k.first !== null && k.first <= s - 1);
  if (!live.length) return null;
  const base = live.map(k => k.cumDelta(s - 1));
  // A candle under way reads each track only as far as it is exact (replay inside a minute of minute history: the minute before).
  const exact = (k: DeltaTrack, sec: number): number => k.settled ? Math.max(s - 1, k.settled(sec)) : sec;
  let gross = 0;
  for (const k of live) gross += k.cumGross(exact(k, e)) - k.cumGross(s - 1);
  let low = 0, high = 0, delta = 0;
  const span = e - s + 1;
  for (let j = 1; j <= samples; j++) {
    const at = j === samples ? e : s + Math.floor(span * j / samples) - 1;
    if (at < s) continue;
    let sum = 0;
    for (let i = 0; i < live.length; i++) sum += live[i]!.cumDelta(exact(live[i]!, at)) - base[i]!;
    if (sum < low) low = sum;
    if (sum > high) high = sum;
    if (j === samples) delta = sum;
  }
  return { delta, low, high, gross };
}

/** How long a stretch with no volume on any market must last to be taken as not recorded rather than quiet. */
export const UNRECORDED_MS = 10 * 60_000;

/**
 * The flows with the candles nothing was recorded in left out (null). A running delta does not say whether a stretch was recorded, so a
 * stretch of candles with no volume on any of the markets lasting `minMs` or more is taken as not recorded (a server or page that was not
 * running); a shorter one is quiet, a delta of 0, as a thin coin can go a minute without a trade.
 */
export function unrecorded(starts: readonly number[], flows: readonly (CandleFlow | null)[], tfMs: number, now: number, minMs = UNRECORDED_MS): (CandleFlow | null)[] {
  const out = flows.slice();
  for (let i = 0; i < out.length;) {
    if (!out[i] || out[i]!.gross > 0) { i++; continue; }
    let j = i, ms = 0;
    while (j < out.length && out[j] && out[j]!.gross <= 0) { ms += Math.min(starts[j]! + tfMs, now) - starts[j]!; j++; }
    if (ms >= minMs) for (let k = i; k < j; k++) out[k] = null;
    i = j;
  }
  return out;
}

export type ResetMode = 'none' | 'day' | 'week';

/** At most this many candles: a week of one-minute ones and a little over, so a capped weekly CVD still holds its restart. */
export const MAX_CANDLES = 10_200;

/**
 * The candle starts the CVD is taken over, oldest first, at most `max` (the newest): from the chart's left edge (`none`), or from the start
 * of the day or week (in `zone`) the left edge falls in, so the CVD on screen is the one that restarted there.
 */
export function candleStarts(t0: number, t1: number, now: number, tfMs: number, reset: ResetMode, zone: string, max = MAX_CANDLES, whole = false): number[] {
  let from = t0;
  if (reset !== 'none') { const w = windowsOf(reset, zone, t0, t0 + 1)[0]; if (w) from = Math.min(from, w.from); }
  const first = Math.floor(from / tfMs) * tfMs, last = Math.floor(Math.min(t1, now) / tfMs) * tfMs;
  const out: number[] = [];
  const from0 = Math.max(first, last - (max - 1) * tfMs);
  for (let t = from0; t <= last; t += tfMs) out.push(t);
  // `whole` (a running sum is shown): cut short by the cap, it starts at the next restart, so its first day or week is never a part one.
  if (whole && from0 > first && reset !== 'none') { const w = windowsOf(reset, zone, from0, last + 1).find(x => x.from >= from0); if (w) return out.filter(t => t >= w.from); }
  return out;
}

/** The restart of each candle: the start of the day or week it falls in (`none`: the first candle's, so it never restarts). */
export function resetKeys(starts: readonly number[], reset: ResetMode, zone: string): number[] {
  if (reset === 'none' || !starts.length) return starts.map(() => starts[0] ?? 0);
  const windows = windowsOf(reset, zone, starts[0]!, starts[starts.length - 1]! + 1);
  let w = 0;
  return starts.map(t => {
    while (w < windows.length - 1 && windows[w]!.to <= t) w++;
    return windows[w] && windows[w]!.from <= t ? windows[w]!.from : t;
  });
}

/**
 * The candles from their flows (null: nothing recorded, left out and restarting the sum after it), the CVD adding up each one's delta and
 * restarting at 0 where `keys` change (a new day or week).
 */
export function deltaCandles(starts: readonly number[], flows: readonly (CandleFlow | null)[], keys: readonly number[]): DeltaCandle[] {
  const out: DeltaCandle[] = [];
  let cvd = 0, key = NaN, gap = true, run = -1;
  for (let i = 0; i < starts.length; i++) {
    const f = flows[i];
    if (!f) { gap = true; continue; }
    // A new day or week, or the first candle after one with nothing recorded (what happened in between is not known): the CVD starts again.
    if (keys[i] !== key || gap) { cvd = 0; key = keys[i]!; gap = false; run++; }
    out.push({ t: starts[i]!, delta: f.delta, open: cvd, high: cvd + f.high, low: cvd + f.low, close: cvd + f.delta, run });
    cvd += f.delta;
  }
  return out;
}

/**
 * The flows of every candle, kept: a closed candle's is worked out once (until older flow is loaded, `loads`, or the instruments change),
 * the candles still open (ending within `liveMs` of now) every time.
 */
export class FlowCache {
  #key = '';
  #closed = new Map<number, CandleFlow | null>();
  get(key: string, tracks: readonly DeltaTrack[], starts: readonly number[], tfMs: number, now: number, liveMs = 5_000): (CandleFlow | null)[] {
    if (key !== this.#key) { this.#key = key; this.#closed = new Map(); }
    return starts.map(t => {
      const closed = t + tfMs <= now - liveMs;
      if (closed && this.#closed.has(t)) return this.#closed.get(t)!;
      const f = candleFlow(tracks, t, tfMs, now);
      if (closed) this.#closed.set(t, f);
      return f;
    });
  }
}
