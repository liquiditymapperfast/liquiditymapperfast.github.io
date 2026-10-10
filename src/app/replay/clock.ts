import type { CandleRow } from '../store.ts';

/**
 * Replay: the page's display clock (`pageNow`) runs from a moment in the past at a chosen speed, and everything drawn takes it as now.
 * What the page holds and asks for keeps the real clock (`Date.now()`): replay moves what is shown, never what is loaded. The moving time
 * lives here, not in the store (it would wake every subscriber several times a second); the store holds only what the controls show.
 * It never passes real time: a replay that catches up is live again.
 */

export const REPLAY_SPEEDS = [1, 10, 60, 300] as const;
export type ReplaySpeed = (typeof REPLAY_SPEEDS)[number];
/** What the controls show (the store's `replay`); never saved, so a page always opens live. */
export interface ReplayView { from: number; speed: ReplaySpeed; playing: boolean }

interface Clock { from: number; at: number; speed: ReplaySpeed; playing: boolean; startedPerf: number }
let clock: Clock | null = null;
let perf = (): number => performance.now();
let real = (): number => Date.now();

/** Tests drive the clocks by hand. */
export function useClocks(perfNow: () => number, realNow: () => number): void { perf = perfNow; real = realNow; }

export const replaying = (): boolean => clock !== null;

/** Now, as the page shows it: the replay's moment while replaying, else the real time. */
export function pageNow(): number {
  if (!clock) return real();
  const t = clock.playing ? clock.at + (perf() - clock.startedPerf) * clock.speed : clock.at;
  return Math.min(t, real());
}

export function startReplay(from: number, speed: ReplaySpeed = 10): void { clock = { from, at: from, speed, playing: true, startedPerf: perf() }; }
export function pauseReplay(): void { if (clock?.playing) { clock.at = pageNow(); clock.playing = false; } }
export function playReplay(): void { if (clock && !clock.playing) { clock.startedPerf = perf(); clock.playing = true; } }
/** A new speed from where the replay is now (the moment shown does not jump). */
export function setReplaySpeed(speed: ReplaySpeed): void { if (!clock) return; clock.at = pageNow(); clock.startedPerf = perf(); clock.speed = speed; }
export function stopReplay(): void { clock = null; }
export function replayView(): ReplayView | null { return clock ? { from: clock.from, speed: clock.speed, playing: clock.playing } : null; }
/** The replay has reached the real time (within a second). */
export function caughtUp(): boolean { return clock !== null && pageNow() >= real() - 1_000; }

/**
 * The candle under way at `at`, rebuilt from a price a second (the flow recording's): its open at the candle's start, its close at `at`,
 * its high and low the extremes of up to `samples` seconds in between, its volume the recorded gross over the close (in coins, as a candle's
 * volume is). The recorded candle would carry its whole future; null without prices.
 */
export function formingCandle(track: { priceAt(sec: number): number; cumGross?(sec: number): number; settled?(sec: number): number }, start: number, at: number, samples = 600): CandleRow | null {
  // Up to the last second known exactly at `at` (in minute history, the last minute over).
  const s0 = Math.floor(start / 1000), s1 = track.settled ? track.settled(Math.floor(at / 1000) - 1) : Math.floor(at / 1000) - 1;
  if (s1 < s0) return null;
  const step = Math.max(1, Math.ceil((s1 - s0 + 1) / samples));
  let open = NaN, high = -Infinity, low = Infinity, close = NaN;
  for (let s = s0; s <= s1; s += step) {
    const p = track.priceAt(s);
    if (!(p > 0)) continue;
    if (open !== open) open = p;
    if (p > high) high = p;
    if (p < low) low = p;
  }
  const last = track.priceAt(s1);
  if (last > 0) { close = last; high = Math.max(high, last); low = Math.min(low, last); }
  if (!(open === open && close === close)) return null;
  const gross = track.cumGross ? track.cumGross(s1) - track.cumGross(s0 - 1) : 0;
  return [start, open, high, low, close, gross > 0 ? gross / close : 0];
}

/**
 * The candles as they were at `at`: those that closed by then, and the one under way rebuilt (`forming`, or left out when it cannot be).
 * Anything that started after `at` is the future.
 */
export function candlesAt(candles: readonly CandleRow[], tfMs: number, at: number, forming: CandleRow | null): CandleRow[] {
  const out: CandleRow[] = [];
  for (const c of candles) {
    if (c[0] + tfMs <= at) out.push(c);
    else if (c[0] < at && forming) out.push(forming);
  }
  return out;
}
