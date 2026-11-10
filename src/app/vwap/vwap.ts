import { windowsOf, type PeriodKind } from '../keylevels/levels.ts';
import { dayWindowsAt, type ProfileWindow } from '../traded/sessions.ts';
import type { CandleRow } from '../store.ts';
import type { SumRow } from '../../shared/print-sums.ts';

/**
 * The volume-weighted average price from candles: each bar's typical price (high + low + close) / 3 weighted by its volume in coins, summed
 * from a start (a session's, or an anchor's), with the volume-weighted standard deviation of those prices for the bands. A session restarts it
 * at each day, week or month of a time zone; an anchor runs it from a chosen moment to now; a rolling VWAP is taken over the last days up to
 * each moment, its start moving with it. The candles are one market's, or several markets' added up bar by bar (`mergeVwapBars`).
 */

const MINUTE = 60_000, HOUR = 3_600_000, DAY = 86_400_000;

/** The average after each bar (at the bar's start, as a chart draws a bar) and the spread of the prices around it. */
export interface VwapPoint { t: number; vwap: number; sd: number }

/**
 * One bar as the VWAP reads it: its start, its volume in coins, its typical price, and how far the typical prices it was made of lie apart
 * (the volume-weighted sum of their squared distances from it; 0 for one market's bar). Several markets' bars of one start are one such bar
 * whose price is their volume-weighted typical price, and the spread keeps them apart for the bands: two markets at 100 and 200 with equal
 * volume are a bar at 150 whose prices still lie 50 either side, not one price at 150.
 */
export type VwapBar = readonly [t: number, volume: number, price: number, spread: number];

/** One market's candles as the VWAP reads them, in the same order. */
export function vwapBarsOf(candles: readonly CandleRow[]): VwapBar[] {
  const out: VwapBar[] = new Array(candles.length);
  for (let i = 0; i < candles.length; i++) { const c = candles[i]!; out[i] = [c[0], c[5], (c[2] + c[3] + c[4]) / 3, 0]; }
  return out;
}

/**
 * Several markets' candles of one bar size as one series: at each start the volumes added, their typical prices weighted by them, and the
 * spread of those prices around the weighted one. Only the bars over by `cutoff` count (a bar under way on one market has been read up to
 * another moment than on the next, so the line ends at the last bar every market has closed). A market with no candle at a start traded
 * nothing there. Each series sorted by start.
 */
export function mergeVwapBars(series: readonly (readonly CandleRow[])[], barMs: number, cutoff: number): VwapBar[] {
  const sums = new Map<number, [v: number, pv: number]>();
  for (const s of series) for (const c of s) {
    if (!(c[0] + barMs <= cutoff) || !(c[5] > 0)) continue;
    const at = sums.get(c[0]), tp = (c[2] + c[3] + c[4]) / 3;
    if (at) { at[0] += c[5]; at[1] += tp * c[5]; } else sums.set(c[0], [c[5], tp * c[5]]);
  }
  // The spread in a second pass, around each start's weighted price: summing squares of prices near 100,000 and taking the square of the mean
  // off would lose the precision a spread of a few dollars needs.
  const spread = new Map<number, number>();
  for (const s of series) for (const c of s) {
    if (!(c[0] + barMs <= cutoff) || !(c[5] > 0)) continue;
    const [v, pv] = sums.get(c[0])!, d = (c[2] + c[3] + c[4]) / 3 - pv / v;
    spread.set(c[0], (spread.get(c[0]) ?? 0) + c[5] * d * d);
  }
  return [...sums.entries()].sort((a, b) => a[0] - b[0]).map(([t, [v, pv]]) => [t, v, pv / v, spread.get(t) ?? 0] as VwapBar);
}

/**
 * The running VWAP over the bars starting in [from, to), sorted by start. A bar with no volume carries the line on unchanged; the line begins at
 * the first bar that traded (none before it: no average of nothing). Prices are taken relative to the first typical price so the variance of
 * prices near 100,000 keeps its precision. A merged bar's spread is added as it is: its prices' squared distances from any other point are
 * their spread around the bar's own price plus the bar's volume times its own squared distance from that point.
 */
export function vwapSeries(bars: readonly VwapBar[], from: number, to: number): VwapPoint[] {
  const out: VwapPoint[] = [];
  let v = 0, dv = 0, d2v = 0, ref = NaN;
  for (const b of bars) {
    const t = b[0]; if (t < from) continue; if (t >= to) break;
    const vol = b[1];
    if (vol > 0) {
      const tp = b[2];
      if (!Number.isFinite(ref)) ref = tp;
      const d = tp - ref; v += vol; dv += d * vol; d2v += d * d * vol + b[3];
    }
    if (!(v > 0)) continue;
    const mean = dv / v;
    out.push({ t, vwap: ref + mean, sd: Math.sqrt(Math.max(0, d2v / v - mean * mean)) });
  }
  return out;
}

/**
 * The bar size of the rolling VWAP over `days`, from the window alone, so the line is the same at every timeframe and zoom: five minutes for a
 * day, a quarter hour for a week, an hour for a month and a quarter, four hours for half a year and a year. Against the same window from
 * finer bars (Binance's BTC perpetual, 38 to 470 days a window, 2026-11-10; `Research_Findings.md`): 0.3 to 0.6 bp apart at the median and
 * 7.4 bp at worst (half a year on four hours), where a day's bars were up to 39 bp off on a quarter. At most 2,190 bars a window.
 */
export function rollingBarMs(days: number): number {
  return days <= 1 ? 5 * MINUTE : days <= 7 ? 15 * MINUTE : days <= 90 ? HOUR : 4 * HOUR;
}

/**
 * Whether a rolling window's history holds a whole window up to now ('yes'), may still ('coming'), is shorter than the window on the exchange
 * ('short'), or could not be read and is tried again in a minute ('failed').
 */
export type RollingState = 'yes' | 'coming' | 'short' | 'failed';

/**
 * How many bars of one size a rolling VWAP's history keeps, so how far before the view its line can begin: past the longest window of the
 * size (and a day the map keeps spare), about 19 days of view at five minutes, 54 at a quarter hour, 159 at an hour and 634 at four hours. A
 * wider view draws the line from where the history reaches, still over whole windows.
 */
export const ROLLING_MAX_BARS = 6_000;

/**
 * How far back the history of the rolling VWAP over `days` must reach for a view from `t0` to `t1` (`now` the page's clock, `real` the real
 * one): a whole window before the view, no further back than the history keeps by the real clock, with a day and a bar to spare (the history
 * asks from the start of the day a start falls in, and bars it then dropped at once would read as the start of the exchange's history). A view
 * not framed yet (`t1 <= t0`: `{ t0: 0, t1: 0 }` until the first candles or price) reaches a window back from `now`: taken at its word, its
 * start in 1970 had every history read all it keeps at each page load. The view's start counts from its hour, as the map's plan is kept for
 * the hour: a view moved back inside it still has its whole window.
 */
export function rollingFrom(days: number, t0: number, t1: number, now: number, real: number): number {
  const bar = rollingBarMs(days), start = t1 > t0 ? Math.min(Math.floor(t0 / HOUR) * HOUR, now) : now;
  return Math.floor(Math.max(start - days * DAY, real - bar * ROLLING_MAX_BARS + DAY + bar) / bar) * bar;
}

/**
 * The rolling VWAP over `windowMs`: at the end of each bar, each bar's typical price weighted by its volume over the bars that start in the
 * window before that end. The window is by time, so a missing bar is a stretch nobody traded, never one bar fewer. Points are drawn where a
 * window is whole only: the first is a whole window after the first bar held, so a history that does not reach back far enough yet (or an
 * exchange whose history is shorter) begins the line later, or gives none, rather than the average of fewer days under the window's name.
 * A point is at its bar's end, when what the window holds is known; the bar under way (ending after `asOf`) is drawn at `asOf`.
 */
export function rollingSeries(bars: readonly VwapBar[], barMs: number, windowMs: number, asOf: number, knownFrom = bars[0]?.[0] ?? Infinity): VwapPoint[] {
  const out: VwapPoint[] = [];
  if (!bars.length || !(windowMs > 0) || !(barMs > 0)) return out;
  // Where the bars are known from: the first bar's start, or what the histories were read back to (several markets: the latest of those).
  // A window reaching before it is not whole; one reaching into a quiet stretch the histories cover is.
  const first = knownFrom;
  // Prices relative to the first traded bar's, as in `vwapSeries`; `traded` counts the bars with volume in the window, so a window whose sums
  // have come back to about zero is known to be empty.
  let v = 0, dv = 0, ref = NaN, traded = 0, a = 0;
  let held = 0;
  for (let j = 0; j < bars.length; j++) {
    const b = bars[j]!, end = Math.min(b[0] + barMs, asOf);
    if (end <= b[0]) break;
    held = j + 1;
    if (b[1] > 0) { if (!Number.isFinite(ref)) ref = b[2]; v += b[1]; dv += (b[2] - ref) * b[1]; traded++; }
    while (a <= j && bars[a]![0] < end - windowMs) { const o = bars[a]!; if (o[1] > 0) { v -= o[1]; dv -= (o[2] - ref) * o[1]; traded--; } a++; }
    if (first > end - windowMs || traded === 0 || !(v > 0)) continue;
    out.push({ t: end, vwap: ref + dv / v, sd: 0 });
  }
  // No bar under way (a thin market where nobody has traded since the last one ended): the window at `asOf` is still a point, its start moved
  // on without anything added.
  const lastEnd = held ? bars[held - 1]![0] + barMs : Infinity;
  if (lastEnd < asOf) {
    while (a < held && bars[a]![0] < asOf - windowMs) { const o = bars[a]!; if (o[1] > 0) { v -= o[1]; dv -= (o[2] - ref) * o[1]; traded--; } a++; }
    if (first <= asOf - windowMs && traded > 0 && v > 0) out.push({ t: asOf, vwap: ref + dv / v, sd: 0 });
  }
  return out;
}

/**
 * The whale VWAPs over [from, to): the running Σusd / Σcoins of the large market orders bought and of those sold, from the sums a minute at a
 * time (sorted by start). Each line begins at its side's first order; a minute without one carries it on unchanged.
 */
export function whaleSeries(rows: readonly SumRow[], from: number, to: number, end?: number): { buys: VwapPoint[]; sells: VwapPoint[] } {
  const buys: VwapPoint[] = [], sells: VwapPoint[] = [];
  // A minute without an order carries the line on unchanged: a step at each minute that has one, and on to `end` after the last.
  const step = (out: VwapPoint[], t: number, vwap: number): void => { const last = out[out.length - 1]; if (last && last.vwap !== vwap) out.push({ t, vwap: last.vwap, sd: 0 }); out.push({ t, vwap, sd: 0 }); };
  let bu = 0, bc = 0, su = 0, sc = 0;
  for (const r of rows) {
    if (r[0] < from) continue; if (r[0] >= to) break;
    bu += r[1]; bc += r[2]; su += r[3]; sc += r[4];
    if (bc > 0 && r[2] > 0) step(buys, r[0], bu / bc);
    if (sc > 0 && r[4] > 0) step(sells, r[0], su / sc);
  }
  for (const out of [buys, sells]) { const last = out[out.length - 1]; if (last && end !== undefined && end > last.t) out.push({ t: end, vwap: last.vwap, sd: 0 }); }
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

/**
 * The sessions of `period` in `zone` that have begun and touch [t0, t1] (the one under way among them), oldest first. A day with
 * `startMinute` set (minutes after midnight) starts there instead of at midnight: the stretch an exchange's or a market's day runs.
 */
export function sessionsOf(period: PeriodKind, zone: string, t0: number, t1: number, now: number, startMinute: number | null = null): ProfileWindow[] {
  if (period === 'day' && startMinute !== null) return dayWindowsAt(zone, t0, Math.min(t1, now), startMinute).filter(w => w.from <= now);
  return windowsOf(period, zone, t0, Math.min(t1, now)).filter(w => w.from <= now);
}
