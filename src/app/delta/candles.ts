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
 * The candles from their flows (null: nothing recorded, left out), the CVD adding up each one's delta and restarting at 0 where `keys` change
 * (a new day or week). After a stretch with nothing recorded it carries on from where it stopped, in a run of its own: what traded in the
 * stretch is not counted, so the line breaks there and divergences do not reach across it, but the two sides stay on one level (started
 * again at 0, the part after a gap sat at a level of its own that moved against the rest whenever the left edge did).
 */
export function deltaCandles(starts: readonly number[], flows: readonly (CandleFlow | null)[], keys: readonly number[]): DeltaCandle[] {
  const out: DeltaCandle[] = [];
  let cvd = 0, key = NaN, gap = true, run = -1;
  for (let i = 0; i < starts.length; i++) {
    const f = flows[i];
    if (!f) { gap = true; continue; }
    if (keys[i] !== key) { cvd = 0; key = keys[i]!; gap = false; run++; }
    else if (gap) { gap = false; run++; }
    out.push({ t: starts[i]!, delta: f.delta, open: cvd, high: cvd + f.high, low: cvd + f.low, close: cvd + f.delta, run });
    cvd += f.delta;
  }
  return out;
}

/**
 * The flows of every candle, kept: a closed candle's is worked out once (until older flow is loaded, `loads`, or the instruments change),
 * the candles still open (ending within `liveMs` of now) every time. An open candle keeps the lowest and highest it has been seen at: its
 * samples move on with every second, and read afresh its wick shrank and grew as a sample fell on a spike or missed it. A replay moved
 * back before what was seen forgets it (it would show what came later). `samples`: how often each candle's running sum is read for its low and
 * high (1 when only the delta is wanted: NL/NS's minute pieces).
 */
export class FlowCache {
  #key = '';
  #closed = new Map<number, CandleFlow | null>();
  #open = new Map<number, { flow: CandleFlow; at: number }>();
  /**
   * The last answer and the starts it was for (copies: a caller's arrays are its own), and how many of its first candles were closed then:
   * the same starts asked again take those as they were, without a lookup each (a script's 100,000 candles looked each up at every run).
   */
  #prev: { starts: number[]; out: (CandleFlow | null)[]; closed: number } | null = null;
  get(key: string, tracks: readonly DeltaTrack[], starts: readonly number[], tfMs: number, now: number, liveMs = 5_000, samples = SAMPLES): (CandleFlow | null)[] {
    if (key !== this.#key) { this.#key = key; this.#closed = new Map(); this.#open = new Map(); this.#prev = null; }
    // A replay moved back: what was seen after its moment is not known yet, wherever it was.
    for (const [t, seen] of this.#open) if (seen.at > now) this.#open.delete(t);
    const merge = (f: CandleFlow | null, t: number): CandleFlow | null => { const seen = this.#open.get(t); return f && seen ? { ...f, low: Math.min(f.low, seen.flow.low), high: Math.max(f.high, seen.flow.high) } : f; };
    // A candle closes with what was seen of it while it was open, whether it is read then or not (panned out of view).
    const close = (t: number, f: CandleFlow | null): CandleFlow | null => { const final = merge(f, t); this.#closed.set(t, final); this.#open.delete(t); return final; };
    // The first candles closed now; of those, the ones that were closed at the last answer too, for the same starts, are as it gave them (a
    // closed candle is worked out once, and none of them is open: each that closes leaves `#open` at the answer it closes in).
    let closed = 0;
    while (closed < starts.length && starts[closed]! + tfMs <= now - liveMs) closed++;
    const prev = this.#prev, limit = prev ? Math.min(prev.closed, closed) : 0;
    let reuse = 0;
    while (reuse < limit && prev!.starts[reuse] === starts[reuse]) reuse++;
    const out = reuse ? prev!.out.slice(0, reuse) : [];
    for (let i = reuse; i < starts.length; i++) {
      const t = starts[i]!;
      if (t + tfMs <= now - liveMs) {
        // Worked out already and not seen open since: as it was (`close` would put the same back), without writing it again; at 100,000
        // candles the writes were a third of a script run's work on the page (2026-11-10).
        const held = this.#closed.get(t);
        if (held !== undefined && !this.#open.has(t)) { out.push(held); continue; }
        out.push(close(t, held !== undefined ? held : candleFlow(tracks, t, tfMs, now, samples)));
        continue;
      }
      const f = merge(candleFlow(tracks, t, tfMs, now, samples), t);
      if (f) this.#open.set(t, { flow: f, at: now });
      out.push(f);
    }
    for (const t of [...this.#open.keys()]) if (t + tfMs <= now - liveMs) close(t, this.#closed.get(t) ?? candleFlow(tracks, t, tfMs, now, samples));
    this.#prev = { starts: starts.slice(), out: out.slice(), closed };
    return out;
  }
}
