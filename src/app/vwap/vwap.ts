import { windowsOf, type PeriodKind } from '../keylevels/levels.ts';
import type { ProfileWindow } from '../traded/sessions.ts';
import type { CandleRow } from '../store.ts';

/**
 * The volume-weighted average price from one market's candles: each bar's typical price (high + low + close) / 3 weighted by its volume in
 * coins, summed from a start (a session's, or an anchor's), with the volume-weighted standard deviation of those prices for the bands. A
 * session restarts it at each day, week or month of a time zone; an anchor runs it from a chosen moment to now.
 */

const MINUTE = 60_000, DAY = 86_400_000;

/** The average after each bar (at the bar's start, as a chart draws a bar) and the spread of the prices around it. */
export interface VwapPoint { t: number; vwap: number; sd: number }

/**
 * The running VWAP over the bars starting in [from, to), sorted by start. A bar with no volume carries the line on unchanged; the line begins at
 * the first bar that traded (none before it: no average of nothing). Prices are taken relative to the first typical price so the variance of
 * prices near 100,000 keeps its precision.
 */
export function vwapSeries(bars: readonly CandleRow[], from: number, to: number): VwapPoint[] {
  const out: VwapPoint[] = [];
  let v = 0, dv = 0, d2v = 0, ref = NaN;
  for (const b of bars) {
    const t = b[0]; if (t < from) continue; if (t >= to) break;
    const vol = b[5];
    if (vol > 0) {
      const tp = (b[2] + b[3] + b[4]) / 3;
      if (!Number.isFinite(ref)) ref = tp;
      const d = tp - ref; v += vol; dv += d * vol; d2v += d * d * vol;
    }
    if (!(v > 0)) continue;
    const mean = dv / v;
    out.push({ t, vwap: ref + mean, sd: Math.sqrt(Math.max(0, d2v / v - mean * mean)) });
  }
  return out;
}

/**
 * The bar size for a VWAP reaching back `spanMs`: minutes for a day, five minutes for a week, half hours beyond, and never coarser than what
 * starts a bar on every period boundary of the zone (`zoneBarMs` from `barMsFor`: a quarter hour in Nepal).
 */
export function vwapBarMs(spanMs: number, zoneBarMs: number): number {
  const rule = spanMs <= 1.5 * DAY ? MINUTE : spanMs <= 8 * DAY ? 5 * MINUTE : 30 * MINUTE;
  return Math.min(rule, zoneBarMs);
}

/** The sessions of `period` in `zone` that have begun and touch [t0, t1] (the one under way among them), oldest first. */
export function sessionsOf(period: PeriodKind, zone: string, t0: number, t1: number, now: number): ProfileWindow[] {
  return windowsOf(period, zone, t0, Math.min(t1, now)).filter(w => w.from <= now);
}
