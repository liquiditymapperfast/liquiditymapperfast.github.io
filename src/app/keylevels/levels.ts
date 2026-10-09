import { dayWindows, monthWindows, offsetMs, weekWindows, type ProfileWindow } from '../traded/sessions.ts';
import type { CandleRow } from '../store.ts';

/**
 * Key levels: where the previous day, week and month traded (their high, low and the middle of the two), where the one under way opened, and
 * how far it has gone so far, worked out from one market's candles (hourly; half-hourly or quarter-hourly in a zone whose clock is not a whole
 * number of hours from UTC, so every period starts on a bar). Days and weeks start at midnight and on Monday in a time zone, months on the 1st
 * there. A previous period's high, low or middle that the next one never traded through stays on the chart, dotted, until price reaches it (an
 * untouched level).
 */

export type PeriodKind = 'day' | 'week' | 'month';
export const PERIOD_KINDS: readonly PeriodKind[] = ['day', 'week', 'month'];
/** Which lines of one kind of period are drawn: the previous one's high and low, its middle, the open of the one under way, and its high and low so far. */
export interface PeriodLines { prev: boolean; mid: boolean; open: boolean; sofar: boolean }
export type LevelWhat = 'high' | 'low' | 'mid' | 'open';

const MINUTE = 60_000, HOUR = 3_600_000, DAY = 86_400_000;
/** How long one period is at most, and how many before the chart's left edge are looked at for a level still untouched in view. */
const SPAN: Readonly<Record<PeriodKind, number>> = { day: 25 * HOUR, week: 7 * DAY + HOUR, month: 31 * DAY + HOUR };
const LOOKBACK: Readonly<Record<PeriodKind, number>> = { day: 10, week: 6, month: 2 };
/** The furthest back the levels reach: the start of the previous month is at most 62 days ago. */
export const MAX_BACK_MS = 62 * DAY;
/** The most lines kept (the newest): far more than 62 days of every line, a guard only. */
const MAX_LINES = 600;

/**
 * The candle size whose bars start on every period boundary of `zone` over [from, to]: an hour, or half an hour (India, Newfoundland, Lord
 * Howe's summer) or a quarter (Nepal, Chatham) where the zone's clock is that far off the hour. The offset is read every week and at both ends,
 * so a zone that moves by half an hour for daylight saving is caught.
 */
export function barMsFor(zone: string, from: number, to: number): number {
  let bar = HOUR;
  for (let t = from; ; t = Math.min(to, t + 7 * DAY)) {
    const minutes = Math.round(offsetMs(zone, t) / MINUTE);
    if (minutes % 30 !== 0) return 15 * MINUTE;
    if (minutes % 60 !== 0) bar = 30 * MINUTE;
    if (t >= to) return bar;
  }
}

/** One period's open, high and low from the candles that start inside it; `complete` when the candles held reach back to its start. */
export interface PeriodStats { open: number; high: number; low: number; complete: boolean }

/** One line on the chart: which period and level it is, its price, and the stretch it is drawn over. */
export interface KeyLine {
  period: PeriodKind; what: LevelWhat;
  /** A previous period's level (drawn over the next one) rather than the open or the range so far of the one it is drawn over. */
  prev: boolean;
  /** Drawn from `from` to `to`, the period's end (for the one under way, an end still to come: it runs to the chart's right edge). */
  price: number; from: number; to: number;
  /**
   * For a previous period's level not traded through by `to`: the start of the first bar that reached it after that, or null if none has yet
   * (it runs on to the right edge). Absent: not extended. A bar is the history's size, so on a finer chart the line can end up to that early.
   */
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
 * The open, high and low of [from, to) from `bars` (sorted by start; any mix of the history's bars and finer ones): the open is the first bar's
 * that starts inside, high and low over every bar that starts inside. With `barMsFor`'s size every period starts on a bar, so no bar is split.
 * A period is complete when the history held starts at or before it (`heldFrom`): a bar missing inside it is an interval nobody traded in (some
 * exchanges send none), not one unknown. Null when no bar starts inside.
 */
export function statsOf(bars: readonly CandleRow[], from: number, to: number, heldFrom: number): PeriodStats | null {
  let open = NaN, high = -Infinity, low = Infinity, first = Infinity;
  for (const b of bars) {
    const t = b[0]; if (t < from) continue; if (t >= to) break;
    if (t < first) { first = t; open = b[1]; }
    if (b[2] > high) high = b[2];
    if (b[3] < low) low = b[3];
  }
  if (!(high >= low) || !Number.isFinite(open)) return null;
  return { open, high, low, complete: heldFrom <= from };
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
    const back = Math.max(Math.min(t0, now) - (LOOKBACK[period] + 1) * SPAN[period], now - MAX_BACK_MS - SPAN[period]);
    const first = windowsOf(period, zone, back, back + 1)[0];
    from = Math.min(from, first ? first.from : back);
  }
  return Math.max(from, now - MAX_BACK_MS);
}

export interface KeyLineOptions {
  zone: string; t0: number; t1: number; now: number; untouched: boolean;
  /** Where the history held begins (default: the first bar); a period starting before it is incomplete. */
  heldFrom?: number;
}

/**
 * The lines for the periods that have begun and touch the chart (and the few before its left edge, for a level still untouched in view), oldest
 * first: over each period, the previous one's high, low and middle (when that one is complete), its own open (when it is complete), and for the
 * one under way its high and low so far. `bars` are sorted by start. Periods before the history held are not looked at, so a chart zoomed out
 * over a year asks for about two months of windows, not hundreds.
 */
export function keyLines(bars: readonly CandleRow[], lines: Readonly<Record<PeriodKind, PeriodLines>>, o: KeyLineOptions): KeyLine[] {
  const out: KeyLine[] = [], end = Math.min(o.t1, o.now);
  if (!bars.length || !(end > o.t0)) return out;
  const heldFrom = o.heldFrom ?? bars[0]![0];
  for (const period of PERIOD_KINDS) {
    const want = lines[period]; if (!want.prev && !want.mid && !want.open && !want.sofar) continue;
    const start = Math.max(o.t0 - (LOOKBACK[period] + 1) * SPAN[period], heldFrom - SPAN[period]);
    if (!(end > start)) continue;
    const windows = windowsOf(period, o.zone, start, end).filter(w => w.from <= o.now);
    const stats = windows.map(w => statsOf(bars, w.from, w.to, heldFrom));
    for (let i = 0; i < windows.length; i++) {
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
      if (own?.complete && want.open) out.push({ period, what: 'open', prev: false, price: own.open, from: w.from, to, of: w.from, window: w.key });
      if (own && want.sofar && under) {
        out.push({ period, what: 'high', prev: false, price: own.high, from: w.from, to, of: w.from, window: w.key });
        out.push({ period, what: 'low', prev: false, price: own.low, from: w.from, to, of: w.from, window: w.key });
      }
    }
  }
  return out.length > MAX_LINES ? out.sort((a, b) => a.from - b.from).slice(-MAX_LINES) : out;
}

/** Where a line ends on the chart: its period's end, or for an untouched one where price reached it (the right edge, Infinity, if it has not). */
export const lineEnd = (line: KeyLine): number => line.reached === undefined ? line.to : line.reached === null ? Infinity : line.reached;
