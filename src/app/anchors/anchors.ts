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
/** How near the minutes' extreme must come to the candle's own (a share of the price) for the minute to count as found. */
const AGREE = 1e-4;

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

/** The periods a rule can follow, and the points of each: every period offers every point, a grid of them (the panels' grid of boxes). */
export const ANCHOR_PERIODS: readonly AnchorPeriod[] = ['day', 'week', 'month', 'quarter', 'year'];
export const ANCHOR_POINTS: readonly AnchorPoint[] = ['start', 'high', 'low', 'prevHigh', 'prevLow'];
const PERIODS = ANCHOR_PERIODS, POINTS = ANCHOR_POINTS;

/** A period's name as the grid's column gives it. */
export const periodWord = (p: AnchorPeriod): string => p === 'day' ? t('Day') : p === 'week' ? t('Week') : p === 'month' ? t('Month') : p === 'quarter' ? t('Quarter') : t('Year');

/** A rule's name as the panels give it: "Start of week", "Month high so far", "Previous year low". */
export function ruleName(r: AnchorRule): string {
  const names: Record<AnchorPeriod, Record<AnchorPoint, () => string>> = {
    day: { start: () => t('Start of day'), high: () => t('Day high so far'), low: () => t('Day low so far'), prevHigh: () => t('Previous day high'), prevLow: () => t('Previous day low') },
    week: { start: () => t('Start of week'), high: () => t('Week high so far'), low: () => t('Week low so far'), prevHigh: () => t('Previous week high'), prevLow: () => t('Previous week low') },
    month: { start: () => t('Start of month'), high: () => t('Month high so far'), low: () => t('Month low so far'), prevHigh: () => t('Previous month high'), prevLow: () => t('Previous month low') },
    quarter: { start: () => t('Start of quarter'), high: () => t('Quarter high so far'), low: () => t('Quarter low so far'), prevHigh: () => t('Previous quarter high'), prevLow: () => t('Previous quarter low') },
    year: { start: () => t('Start of year'), high: () => t('Year high so far'), low: () => t('Year low so far'), prevHigh: () => t('Previous year high'), prevLow: () => t('Previous year low') },
  };
  return names[r.period][r.point]();
}

/**
 * A rule's short name on the chart, after "AVWAP" in the line's label and on its axis tag, as traders write the levels and as the Key levels
 * name theirs: DO a day's open (its start), WH the week's high so far, PML the previous month's low; Q a quarter, Y a year.
 */
export function ruleCode(r: AnchorRule): string {
  const codes: Record<AnchorPeriod, Record<AnchorPoint, () => string>> = {
    day: { start: () => t('DO'), high: () => t('DH'), low: () => t('DL'), prevHigh: () => t('PDH'), prevLow: () => t('PDL') },
    week: { start: () => t('WO'), high: () => t('WH'), low: () => t('WL'), prevHigh: () => t('PWH'), prevLow: () => t('PWL') },
    month: { start: () => t('MO'), high: () => t('MH'), low: () => t('ML'), prevHigh: () => t('PMH'), prevLow: () => t('PML') },
    quarter: { start: () => t('QO'), high: () => t('QH'), low: () => t('QL'), prevHigh: () => t('PQH'), prevLow: () => t('PQL') },
    year: { start: () => t('YO'), high: () => t('YH'), low: () => t('YL'), prevHigh: () => t('PYH'), prevLow: () => t('PYL') },
  };
  return codes[r.period][r.point]();
}

/** A rule's key, to tell rules apart and find one in a list (`week|high`). */
export const ruleKey = (r: AnchorRule): string => `${r.period}|${r.point}`;
/** A rule from its key; null for one that is not offered. */
export function ruleOf(key: string): AnchorRule | null {
  const [period, point] = key.split('|') as [AnchorPeriod, AnchorPoint];
  return PERIODS.includes(period) && POINTS.includes(point) ? { period, point } : null;
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

/**
 * How a rule stands: where it lands now ('ready'; `approx` when the minutes inside its candle could not be had, so it is that candle's start);
 * its candles are on their way ('coming'); they could not be read just now and are asked again ('failed'); the market's history, as its
 * exchange serves it, begins after the stretch (`short`, from where it begins); or the stretch has no candle (yet: 'none').
 */
export type Resolved = { state: 'ready'; at: number; approx?: boolean } | { state: 'coming' } | { state: 'failed' } | { state: 'short'; from: number } | { state: 'none' };
/** What a rule's search is given of the coarse bars: the bars and their size, where they are known from, and whether they failed or are cut short. */
export interface CoarseBars { bars: readonly CandleRow[]; barMs: number; knownFrom: number; failed?: boolean; limited?: boolean }

/**
 * Where a rule resolves at `now` (`replay`: a replay's moment, whose bar under way is left out, its high and low being known only later):
 * a start is its period's start; a high or low is the minute of the extreme, found over `coarse` (the chart market's bars of
 * `searchBarMs`, with where they are known from) and then over `fine` (that market's minutes inside the coarse bar that won: null while they
 * come, false when they could not be read). Until the minute is known it is not drawn (Sol, review 2026-11-11: the coarse start passed off as
 * the exact candle moved later, and Freeze kept the wrong minute); where the exchange has no minutes there, it is the candle's start, said
 * as approximate. A previous period's search ends at its end: the next one's first candle is not part of it (Sol, the same review).
 */
export function resolveRule(r: AnchorRule, zone: string, now: number, replay: boolean, coarse: CoarseBars | null,
  fine: (from: number, to: number) => readonly CandleRow[] | null | false): Resolved {
  const span = ruleSpan(r, zone, now);
  if (r.point === 'start') return { state: 'ready', at: span.from };
  if (!coarse) return { state: 'coming' };
  if (coarse.knownFrom > span.from) return coarse.failed ? { state: 'failed' } : coarse.limited && coarse.bars.length ? { state: 'short', from: coarse.knownFrom } : { state: 'coming' };
  const high = r.point === 'high' || r.point === 'prevHigh', previous = r.point === 'prevHigh' || r.point === 'prevLow';
  // The period under way takes its candle forming (live), or stops before it (a replay, whose forming candle carries its future).
  const to = previous ? span.to : replay ? Math.min(span.to, Math.floor(now / coarse.barMs) * coarse.barMs) : span.to + 1;
  const bar = extremeBar(coarse.bars, span.from, to, high);
  if (!bar) return coarse.failed ? { state: 'failed' } : { state: 'none' };
  const end = Math.min(bar[0] + coarse.barMs, previous ? span.to : Infinity, replay ? Math.floor(now / MINUTE) * MINUTE : Infinity);
  const minutes = fine(bar[0], bar[0] + coarse.barMs);
  if (minutes === null) return { state: 'coming' };
  if (minutes === false) return { state: 'failed' };
  const exact = extremeBar(minutes, bar[0], end, high);
  // The minute only where it holds the candle's own extreme (Sol, review 2026-11-11: an exchange whose minutes begin inside the candle, as
  // Hyperliquid's do past their reach, gave a lesser extreme as exact). A candle under way (its minutes can be newer than it) or cut short by
  // its period's end is taken as its minutes say.
  const closed = end >= bar[0] + coarse.barMs && bar[0] + coarse.barMs <= now;
  const agrees = (e: CandleRow): boolean => !closed || (high ? e[2] >= bar[2] * (1 - AGREE) : e[3] <= bar[3] * (1 + AGREE));
  return exact && agrees(exact) ? { state: 'ready', at: exact[0] } : { state: 'ready', at: bar[0], approx: true };
}
