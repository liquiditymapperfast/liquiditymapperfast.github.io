import { windowsOf, type PeriodKind } from '../keylevels/levels.ts';
import type { ProfileWindow } from '../traded/sessions.ts';
import type { CandleRow } from '../store.ts';
import type { SumRow } from '../../shared/print-sums.ts';

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
 * The whale VWAPs over [from, to): the running Σusd / Σcoins of the large market orders bought and of those sold, from the sums a minute at a
 * time (sorted by start). Each line begins at its side's first order; a minute without one carries it on unchanged.
 */
export function whaleSeries(rows: readonly SumRow[], from: number, to: number): { buys: VwapPoint[]; sells: VwapPoint[] } {
  const buys: VwapPoint[] = [], sells: VwapPoint[] = [];
  let bu = 0, bc = 0, su = 0, sc = 0;
  for (const r of rows) {
    if (r[0] < from) continue; if (r[0] >= to) break;
    bu += r[1]; bc += r[2]; su += r[3]; sc += r[4];
    if (bc > 0) buys.push({ t: r[0], vwap: bu / bc, sd: 0 });
    if (sc > 0) sells.push({ t: r[0], vwap: su / sc, sd: 0 });
  }
  return { buys, sells };
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
