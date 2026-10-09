import { dayWindows, monthWindows, weekWindows, type ProfileWindow } from '../traded/sessions.ts';
import type { CandleRow } from '../store.ts';

/**
 * Key levels: where the previous day, week and month traded (their high, low and the middle of the two), where the one under way opened, and
 * how far it has gone so far, worked out from one market's hourly candles. Days and weeks start at midnight and on Monday in a time zone,
 * months on the 1st there. A previous period's high, low or middle that the next one never traded through stays on the chart, dotted, until
 * price reaches it (an untouched level).
 */

export type PeriodKind = 'day' | 'week' | 'month';
export const PERIOD_KINDS: readonly PeriodKind[] = ['day', 'week', 'month'];
/** Which lines of one kind of period are drawn: the previous one's high and low, its middle, the open of the one under way, and its high and low so far. */
export interface PeriodLines { prev: boolean; mid: boolean; open: boolean; sofar: boolean }
export type LevelWhat = 'high' | 'low' | 'mid' | 'open';

const HOUR = 3_600_000, DAY = 86_400_000;
/** How long one period is at most, and how many before the chart's left edge are looked at for a level still untouched in view. */
const SPAN: Readonly<Record<PeriodKind, number>> = { day: 25 * HOUR, week: 7 * DAY + HOUR, month: 31 * DAY + HOUR };
const LOOKBACK: Readonly<Record<PeriodKind, number>> = { day: 10, week: 6, month: 2 };
/** The furthest back the levels reach: the start of the previous month is at most 62 days ago. */
export const MAX_BACK_MS = 62 * DAY;
/** The most lines worked out at once (a chart zoomed out over months with every line on). */
const MAX_LINES = 600;

/**
 * One period's open, high and low from the candles that start inside it: `opened` when they hold its first hour (so the open is its own), and
 * `complete` when they also reach its last hour (or now).
 */
export interface PeriodStats { open: number; high: number; low: number; opened: boolean; complete: boolean }

/** One line on the chart: which period and level it is, its price, and the stretch it is drawn over. */
export interface KeyLine {
  period: PeriodKind; what: LevelWhat;
  /** A previous period's level (drawn over the next one) rather than the open or the range so far of the one it is drawn over. */
  prev: boolean;
  /** Drawn from `from` to `to`, the period's end (for the one under way, an end still to come: it runs to the chart's right edge). */
  price: number; from: number; to: number;
  /** For a previous period's level not traded through by `to`: when price first reached it after that, or null if it has not yet (it runs on to the right edge). Absent: not extended. */
  reached?: number | null;
  /** When the period whose level it is began (the previous one for a previous level), to name it once it runs on past the next. */
  of: number;
  /** The key of the period it is drawn over. */
  window: string;
}

export function windowsOf(period: PeriodKind, zone: string, t0: number, t1: number): ProfileWindow[] {
  return period === 'day' ? dayWindows(zone, t0, t1) : period === 'week' ? weekWindows(zone, t0, t1) : monthWindows(zone, t0, t1);
}

/**
 * The open, high and low of [from, to) from `bars` (sorted by start; any mix of hourly and finer ones): the open is the first bar's that starts
 * inside, high and low over every bar that starts inside. A bar is counted in the period its start falls in, so in a zone whose day does not
 * start on the hour the first and last hour of a day are split as the exchange's hourly bars are. Null when no bar starts inside.
 */
export function statsOf(bars: readonly CandleRow[], from: number, to: number, now: number, barMs: number = HOUR): PeriodStats | null {
  let open = NaN, high = -Infinity, low = Infinity, first = Infinity, last = -Infinity;
  for (const b of bars) {
    const t = b[0]; if (t < from) continue; if (t >= to) break;
    if (t < first) { first = t; open = b[1]; }
    if (t > last) last = t;
    if (b[2] > high) high = b[2];
    if (b[3] < low) low = b[3];
  }
  if (!(high >= low) || !Number.isFinite(open)) return null;
  const end = Math.min(to, now);
  const opened = first < from + barMs;
  return { open, high, low, opened, complete: opened && last >= end - 2 * barMs };
}

/** The first bar starting at or after `after` whose range reaches `price` (null: none yet). `bars` sorted by start. */
export function reachedAt(price: number, after: number, bars: readonly CandleRow[]): number | null {
  for (const b of bars) { if (b[0] < after) continue; if (b[3] <= price && price <= b[2]) return b[0]; }
  return null;
}

/** The earliest time the lines for a chart starting at `t0` need candles from (never further back than MAX_BACK_MS). */
export function neededFrom(lines: Readonly<Record<PeriodKind, PeriodLines>>, zone: string, t0: number, now: number): number {
  let from = now;
  for (const period of PERIOD_KINDS) {
    const want = lines[period]; if (!want.prev && !want.mid && !want.open && !want.sofar) continue;
    const back = Math.min(t0, now) - (LOOKBACK[period] + 1) * SPAN[period];
    const first = windowsOf(period, zone, back, back + 1)[0];
    from = Math.min(from, first ? first.from : back);
  }
  return Math.max(from, now - MAX_BACK_MS);
}

export interface KeyLineOptions { zone: string; t0: number; t1: number; now: number; untouched: boolean; barMs?: number }

/**
 * The lines for the periods that have begun and touch the chart (and the few before its left edge, for a level still untouched in view), oldest
 * first: over each period, the previous one's high, low and middle (when that one's candles are complete), its own open (when its first hour is
 * held), and for the one under way its high and low so far. `bars` are sorted by start.
 */
export function keyLines(bars: readonly CandleRow[], lines: Readonly<Record<PeriodKind, PeriodLines>>, o: KeyLineOptions): KeyLine[] {
  const out: KeyLine[] = [], barMs = o.barMs ?? HOUR, end = Math.min(o.t1, o.now);
  if (!bars.length || !(end > o.t0)) return out;
  for (const period of PERIOD_KINDS) {
    const want = lines[period]; if (!want.prev && !want.mid && !want.open && !want.sofar) continue;
    const windows = windowsOf(period, o.zone, o.t0 - (LOOKBACK[period] + 1) * SPAN[period], end).filter(w => w.from <= o.now);
    const stats = windows.map(w => statsOf(bars, w.from, w.to, o.now, barMs));
    for (let i = 0; i < windows.length && out.length < MAX_LINES; i++) {
      const w = windows[i]!, own = stats[i], prev = i > 0 && windows[i - 1]!.to === w.from ? stats[i - 1] : null;
      const to = w.to, under = w.to > o.now;
      if (prev?.complete) {
        const levels: [LevelWhat, number][] = [];
        if (want.prev) levels.push(['high', prev.high], ['low', prev.low]);
        if (want.mid) levels.push(['mid', (prev.high + prev.low) / 2]);
        for (const [what, price] of levels) {
          const line: KeyLine = { period, what, prev: true, price, from: w.from, to, of: windows[i - 1]!.from, window: w.key };
          // Not traded through over the period it is drawn across: it runs on until price reaches it.
          if (o.untouched && !under) { const hit = reachedAt(price, w.from, bars); if (hit === null || hit >= w.to) line.reached = hit; }
          out.push(line);
        }
      }
      if (own?.opened && want.open) out.push({ period, what: 'open', prev: false, price: own.open, from: w.from, to, of: w.from, window: w.key });
      if (own && want.sofar && under) {
        out.push({ period, what: 'high', prev: false, price: own.high, from: w.from, to, of: w.from, window: w.key });
        out.push({ period, what: 'low', prev: false, price: own.low, from: w.from, to, of: w.from, window: w.key });
      }
    }
  }
  return out;
}

/** Where a line ends on the chart: its period's end, or for an untouched one where price reached it (the right edge, Infinity, if it has not). */
export const lineEnd = (line: KeyLine): number => line.reached === undefined ? line.to : line.reached === null ? Infinity : line.reached;
