import { t } from '../i18n.ts';
import { fromWall, wallOf } from '../traded/sessions.ts';
import type { CandleRow } from '../store.ts';

/**
 * Anchors, the VWAP's and the volume profile's (Karl, 2026-11-11: "nobody wants to click the exact candle"; a user: "so i can enter a date
 * instead of clicking"): fixed at a moment, from a date typed or a candle clicked, or live, following a rule over a calendar period in the
 * zone the Volume profile and Key levels use ("Week high so far" moves to a new high when one prints; "Previous month low" changes at the
 * month's turn). Designed with Sol 6.1 and the advisor (2026-11-11).
 */

const MINUTE = 60_000, DAY = 86_400_000;

/** The calendar periods a rule follows. */
export type AnchorPeriod = 'day' | 'week' | 'month' | 'quarter' | 'year';
/** Where in its period: its start, its high or low so far, or the previous period's high or low. */
export type AnchorPoint = 'start' | 'high' | 'low' | 'prevHigh' | 'prevLow';
export interface AnchorRule { period: AnchorPeriod; point: AnchorPoint }

/**
 * An anchor: fixed at a moment (`at`, ms) or live, following `rule`. `id` stays with it whatever is changed; `slot` picks its default colour
 * from the theme's anchor colours (given when it is made, so removing another does not repaint it); `color` is one chosen instead; `hidden`
 * keeps it without drawing it.
 */
export interface Anchor { id: string; at?: number; rule?: AnchorRule; slot: number; color?: string; hidden?: boolean }

const PERIODS: readonly AnchorPeriod[] = ['day', 'week', 'month', 'quarter', 'year'];
const POINTS: readonly AnchorPoint[] = ['start', 'high', 'low', 'prevHigh', 'prevLow'];

/** The rules offered, in groups as the person reads them (Sol, 2026-11-11): the starts, then each period's highs and lows. */
export const ANCHOR_PRESETS: readonly { label: () => string; rules: readonly AnchorRule[] }[] = [
  { label: () => t('Starts'), rules: PERIODS.map(period => ({ period, point: 'start' as const })) },
  ...(['week', 'month', 'quarter', 'year'] as const).map(period => ({
    label: () => periodWord(period), rules: (['high', 'low', 'prevHigh', 'prevLow'] as const).map(point => ({ period, point })),
  })),
];

const periodWord = (p: Exclude<AnchorPeriod, 'day'>): string => p === 'week' ? t('Week') : p === 'month' ? t('Month') : p === 'quarter' ? t('Quarter') : t('Year');

/** A rule's name as the panel and the line's box give it: "Start of week", "Month high so far", "Previous year low". */
export function ruleName(r: AnchorRule): string {
  // A day offers its start only (the session VWAP and the Key levels have its highs and lows).
  if (r.period === 'day') return t('Start of day');
  const names: Record<Exclude<AnchorPeriod, 'day'>, Record<AnchorPoint, () => string>> = {
    week: { start: () => t('Start of week'), high: () => t('Week high so far'), low: () => t('Week low so far'), prevHigh: () => t('Previous week high'), prevLow: () => t('Previous week low') },
    month: { start: () => t('Start of month'), high: () => t('Month high so far'), low: () => t('Month low so far'), prevHigh: () => t('Previous month high'), prevLow: () => t('Previous month low') },
    quarter: { start: () => t('Start of quarter'), high: () => t('Quarter high so far'), low: () => t('Quarter low so far'), prevHigh: () => t('Previous quarter high'), prevLow: () => t('Previous quarter low') },
    year: { start: () => t('Start of year'), high: () => t('Year high so far'), low: () => t('Year low so far'), prevHigh: () => t('Previous year high'), prevLow: () => t('Previous year low') },
  };
  return names[r.period][r.point]();
}

/** A rule's key, to tell rules apart and find one in a list (`week|high`). */
export const ruleKey = (r: AnchorRule): string => `${r.period}|${r.point}`;
/** A rule from its key; null for one that is not offered. */
export function ruleOf(key: string): AnchorRule | null {
  const [period, point] = key.split('|') as [AnchorPeriod, AnchorPoint];
  return ANCHOR_PRESETS.some(g => g.rules.some(r => r.period === period && r.point === point)) ? { period, point } : null;
}

let counter = 0;
/** A new anchor's id: unique within the page, and short. */
export const newAnchorId = (now = Date.now()): string => `a${now.toString(36)}${(counter++ % 1296).toString(36)}`;

const HEX = /^#[0-9a-f]{6}$/i;
/** A colour as kept: `#rrggbb` (what a colour input gives), else none. */
export const readColor = (value: unknown): string | undefined => typeof value === 'string' && HEX.test(value) ? value.toLowerCase() : undefined;

/**
 * An anchor as kept, checked field by field; null when it is neither a time nor an offered rule. An anchor saved before 2026-11-11 is a bare
 * time (a number): it is read as a fixed anchor at that very time, given an id from it and the slot of its place in the list.
 */
export function readAnchor(saved: unknown, index: number): Anchor | null {
  if (typeof saved === 'number') return Number.isFinite(saved) && saved > 0 ? { id: `t${saved}`, at: saved, slot: index } : null;
  if (!saved || typeof saved !== 'object') return null;
  const x = saved as Partial<Record<keyof Anchor, unknown>>;
  const at = typeof x.at === 'number' && Number.isFinite(x.at) && x.at > 0 ? x.at : undefined;
  const r = x.rule && typeof x.rule === 'object' ? x.rule as Partial<AnchorRule> : null;
  const rule = r && PERIODS.includes(r.period as AnchorPeriod) && POINTS.includes(r.point as AnchorPoint) ? ruleOf(`${r.period}|${r.point}`) ?? undefined : undefined;
  if (at === undefined && !rule) return null;
  const id = typeof x.id === 'string' && /^[a-z0-9]{1,24}$/i.test(x.id) ? x.id : `t${at ?? index}${rule ? ruleKey(rule).replace('|', '') : ''}`;
  const slot = typeof x.slot === 'number' && Number.isInteger(x.slot) && x.slot >= 0 && x.slot < 64 ? x.slot : index;
  const color = readColor(x.color);
  return { id, ...(rule ? { rule } : { at }), slot, ...(color ? { color } : {}), ...(x.hidden === true ? { hidden: true } : {}) } as Anchor;
}

/** The lowest colour slot none of `anchors` holds (a new anchor's), so each line keeps its colour when another is removed. */
export function freeSlot(anchors: readonly Pick<Anchor, 'slot'>[]): number {
  const held = new Set(anchors.map(a => a.slot));
  let slot = 0; while (held.has(slot)) slot++;
  return slot;
}

/**
 * The start of `t`'s period in `zone`: midnight for a day, Monday for a week, the first of the month, of January, April, July or October, of
 * January. A custom session hour does not move it (Sol, 2026-11-11: calendar starts, as the Key levels have them).
 */
export function periodStart(period: AnchorPeriod, zone: string, t: number): number {
  const { wall, weekday } = wallOf(zone, t), d = new Date(wall), y = d.getUTCFullYear(), m = d.getUTCMonth(), midnight = Math.floor(wall / DAY) * DAY;
  const start = period === 'day' ? midnight : period === 'week' ? midnight - ((weekday + 6) % 7) * DAY
    : period === 'month' ? Date.UTC(y, m, 1) : period === 'quarter' ? Date.UTC(y, m - (m % 3), 1) : Date.UTC(y, 0, 1);
  return fromWall(zone, start);
}

/** The stretch a rule searches at `now`: its period so far, or the whole previous period. A start searches nothing. */
export function ruleSpan(r: AnchorRule, zone: string, now: number): { from: number; to: number } {
  const start = periodStart(r.period, zone, now);
  if (r.point === 'prevHigh' || r.point === 'prevLow') return { from: periodStart(r.period, zone, start - 1), to: start };
  return { from: start, to: now };
}

/**
 * The bar of an extreme among `bars` (sorted by start) that start in [from, to): the highest high (`high`) or the lowest low, the earliest of
 * equal ones. Null when no bar starts there.
 */
export function extremeBar(bars: readonly CandleRow[], from: number, to: number, high: boolean): CandleRow | null {
  let best: CandleRow | null = null;
  for (const b of bars) {
    if (b[0] < from) continue; if (b[0] >= to) break;
    if (!best || (high ? b[2] > best[2] : b[3] < best[3])) best = b;
  }
  return best;
}

/**
 * The candle sizes a rule's search reads, coarse then fine: a period's bars no coarser than what starts on every boundary of the zone
 * (`zoneBarMs`, an hour or half an hour), a week's at a quarter hour; then minutes inside the coarse bar that won, so the anchor lands on the
 * very minute of the extreme.
 */
export function searchBarMs(period: AnchorPeriod, zoneBarMs: number): number {
  return period === 'week' || period === 'day' ? Math.min(15 * MINUTE, zoneBarMs) : zoneBarMs;
}

/** How a rule stands: where it resolves now, or that its candles are still on their way, or that none can tell (no candle in its stretch). */
export type Resolved = { state: 'ready'; at: number } | { state: 'coming' } | { state: 'none' };

/**
 * Where a rule resolves at `now` (`replay`: a replay's moment, whose bar under way is left out, its high and low being known only later):
 * a start is its period's start; a high or low is the minute of the extreme, found over `coarse` (the chart market's bars of
 * `searchBarMs`, with where they are known from) and then over `fine` (that market's minutes inside the coarse bar that won; null while they
 * come: the coarse bar's start stands meanwhile, never a guess).
 */
export function resolveRule(r: AnchorRule, zone: string, now: number, replay: boolean,
  coarse: { bars: readonly CandleRow[]; barMs: number; knownFrom: number } | null,
  fine: (from: number, to: number) => readonly CandleRow[] | null): Resolved {
  const span = ruleSpan(r, zone, now);
  if (r.point === 'start') return { state: 'ready', at: span.from };
  if (!coarse) return { state: 'coming' };
  if (coarse.knownFrom > span.from) return { state: 'coming' };
  const high = r.point === 'high' || r.point === 'prevHigh';
  const to = replay ? Math.min(span.to, Math.floor(now / coarse.barMs) * coarse.barMs) : span.to + 1;
  const bar = extremeBar(coarse.bars, span.from, to, high);
  if (!bar) return { state: 'none' };
  const end = Math.min(bar[0] + coarse.barMs, span.to, replay ? Math.floor(now / MINUTE) * MINUTE : Infinity);
  const minutes = fine(bar[0], bar[0] + coarse.barMs);
  const exact = minutes ? extremeBar(minutes, bar[0], end, high) : null;
  return { state: 'ready', at: exact ? exact[0] : bar[0] };
}
