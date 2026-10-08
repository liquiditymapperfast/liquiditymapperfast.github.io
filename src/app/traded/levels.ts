import type { ProfileAnswer } from '../../shared/footprint.ts';
import { levelsOf, rowOf, type ValueLevels } from '../../shared/profile.ts';
import type { CandleRow } from '../store.ts';
import { dayWindows, lastWindows, sessionWindows, weekWindows, type ProfileWindow } from './sessions.ts';
import { resolveZone, type TradedSettings } from './settings.ts';

/**
 * The step the traded column asks its rows on: one that both its display rows and the point of control's rows are whole multiples of (and
 * of the recorder's own step, `fine`), so the bars and the levels are each read exactly from the same answer.
 */
export function requestStep(display: number, poc: number, fine: number): number {
  const a = Math.max(1, Math.round(display / fine)), b = Math.max(1, Math.round(poc / fine));
  let x = a, y = b; while (y) [x, y] = [y, x % y];
  return x * fine;
}

/** The point of control and the value area of a traded-volume answer: every instrument's rows on rows of `step`, every price that traded. */
export function answerLevels(answer: ProfileAnswer, step: number, share: number): ValueLevels | null {
  const rows = new Map<number, number>();
  for (const inst of answer.instruments) for (const [low, buy, sell] of inst.rows) {
    // A recorded row lies inside one level row (its step divides the level's): its middle says which.
    const key = rowOf(low + inst.step / 2, step);
    rows.set(key, (rows.get(key) ?? 0) + buy + sell);
  }
  return levelsOf(rows, step, share);
}

/**
 * When a past point of control was first traded through after its window ended: the first candle from `after` whose range reaches it,
 * `tolerance` either side (half a row: the levels are read from every venue, the candles are one market's, a little apart). Null when no
 * candle held reaches it: the level is still naked as far as the candles go.
 */
export function touchedAt(price: number, after: number, candles: readonly CandleRow[], tolerance: number): number | null {
  for (const c of candles) {
    if (c[0] < after) continue;
    if (c[3] - tolerance <= price && price <= c[2] + tolerance) return c[0];
  }
  return null;
}

/**
 * The windows the lines are drawn for (days, weeks or sessions; none for what is on the chart): the last `count` of each kind that have begun,
 * of those that touch [t0, t1]. Days and weeks start in the settings' zone (`page`: the page's clock).
 */
export function linesWindows(s: TradedSettings, pageZone: 'local' | 'utc', t0: number, t1: number, now: number): ProfileWindow[] {
  if (s.period === 'view') return [];
  const zone = resolveZone(s.zone, pageZone), end = Math.min(t1, now);
  const all = s.period === 'day' ? dayWindows(zone, t0, end) : s.period === 'week' ? weekWindows(zone, t0, end)
    : sessionWindows(s.sessions, t0, end, z => resolveZone(z, pageZone));
  return lastWindows(all, s.count, now);
}
