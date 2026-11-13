import { lsWindowPeriod, type LsPopulation, type LsSeries } from '../../shared/long-short.ts';
import { t } from '../i18n.ts';

/** A reading stands until the next one, or for this many of its periods after it when none follows (a gap past that breaks the line). */
export const HOLD_PERIODS = 3;

/** Where the step of a series' reading `i` ends: at the next reading where it comes within the hold, else a period after it. */
export function stepEnd(s: Pick<LsSeries, 'points' | 'periodMs'>, i: number): number {
  const q = s.points[i]!, next = s.points[i + 1];
  return next && next.t - q.t <= HOLD_PERIODS * s.periodMs ? next.t : q.t + s.periodMs;
}

/** The words for who a series counts. */
export function populationText(population: LsPopulation): string {
  return population === 'accounts' ? t('all accounts') : population === 'topAccounts' ? t('top traders, by accounts') : population === 'topPositions' ? t('top traders, by positions') : t('active accounts');
}

/**
 * When the Long/Short pane asks for readings, over which window, and what a round leaves drawn (pure, tested in tests/app-ls-window.test.mts).
 *
 * The view needs itself and half a view before it (the first step drawn begins before the view). Nothing is asked while what is held (the
 * same markets, series and timeframe) covers that, is in readings as fine as a window around this view would be, and was answered less than a
 * minute ago, nor while a round is under way (a round ends when every venue has answered or after `LS_ROUND_MS`, whichever comes first).
 * Otherwise the window asked is a view wider on each side than the view needs, so zooming and panning a little ask nothing. A live view's end
 * moving on is the minute refresh's to follow, not a new question. Asking anew on every view change had a zoom send three requests a step, each
 * up to a second and a half on the server, with the pane blank until the last (2026-10-15). Asking only for what is not covered had a zoom back
 * in from a month-long view keep its daily readings, every line in steps a day wide, until the minute refresh (2026-10-23).
 */
export interface LsHeld { ident: string; from: number; to: number; at: number; soon?: number }

const MINUTE = 60_000, HOUR = 3_600_000, DAY = 86_400_000;
/**
 * The longest window the venues are read in readings as fine as the candles: from 30 days on the long/short cache takes daily readings, for
 * month-scale context (shared/long-short.ts). A view shorter than that asks less around it so the window stays under it: asking a view and a
 * half before a 12-day view had every venue's lines turn to steps a day wide once the chart showed a little more history (2026-10-21). Up to
 * 29 days in view the window, its tail of a candle (four hours at most where the readings are finer than daily) and its rounding to the hour
 * fit; a view longer than that is month-scale and may be read daily.
 */
const FINE_SPAN_MS = 30 * DAY - 2 * HOUR;
/**
 * How long a round waits for the venues. Each venue's answer is drawn as it comes; one still missing then is given up and reads as failed, or
 * stale over the readings held before. A server's request is cancelled then, so it does not hold one of the browser's six connections to the
 * server; the browser engine's read is its cache's, shared with every question for the series, and goes on (bounded by the cache) for the
 * next one. A round once waited for every venue together with no end: two venues' requests that never came back left the pane on "Reading
 * the long/short ratios…" for good, and each re-ask added two more that never came back (2026-10-15).
 */
export const LS_ROUND_MS = 45_000;
/**
 * How long a question waits for the venue before the source answers with what it holds, `pending` (shared/long-short.ts `series`): the lines
 * held are drawn at once instead of after the slowest page. A question waited for its whole read: a venue that took longer than the round
 * (45 s, a busy server on a saturated PC, 2026-10-23) was given up as failed, and drawn only after the next minute's refresh, 106 s after the
 * pane was switched on, from what the server had read meanwhile.
 */
export const LS_BUDGET_MS = 1_500;
/** How long after a `pending` answer its venue is asked again within the round (the read goes on in the source; each question is answered from it). */
export const LS_FOLLOW_MS = 2_000;
/**
 * The wait before a venue's `attempt`-th question again (0 the first): doubling from `LS_FOLLOW_MS` to 8 s, so a slow read is asked about a
 * handful of times a round, each answer the whole window's readings, rather than every few seconds on a server already busy.
 */
export const lsFollowDelay = (attempt: number): number => Math.min(8_000, LS_FOLLOW_MS * 2 ** Math.max(0, attempt));
/** A round that ended with a venue still pending is asked again this long after, not a minute after. */
export const LS_SOON_MS = 5_000;

/**
 * What the pane says when it draws no step in view, for the series of the markets shown: `reading` while a round waits for a venue or a venue
 * is still being read (`pending`: what it holds is for another time, or nothing), `failed` once it is over and a venue's last update could not
 * be read (failed, or stale: readings held for another time; asked again with the minute refresh), else `none` (the venues answered: nothing
 * for this time).
 */
export function lsMessage(series: readonly LsSeries[], loading: boolean): 'reading' | 'failed' | 'none' {
  return loading || series.some(s => s.pending) ? 'reading' : series.some(s => s.status === 'failed' || s.status === 'stale') ? 'failed' : 'none';
}

/**
 * The window to ask for now, or null when nothing need be asked. `venues` are those of the markets shown: the period each one's readings of a
 * window are taken in (`lsWindowPeriod`) follows the window's length, so a window held from a wider view can cover this one in coarser readings.
 */
export function lsWindow(held: LsHeld | null, loading: boolean, ident: string, view: { t0: number; t1: number }, tfMs: number, now: number, venues: readonly string[] = []): { from: number; to: number } | null {
  // Around the view: a view and a half before it and half a view after, as far as a window under FINE_SPAN_MS allows (a month-long view
  // and more is read as it is, in daily readings); what must be held before it is never more than what is asked.
  const span = view.t1 - view.t0, after = Math.min(span / 2 + tfMs, Math.max(tfMs, (FINE_SPAN_MS - span) / 3)), before = Math.min(1.5 * span, Math.max(0, FINE_SPAN_MS - span - after));
  const needFrom = view.t0 - Math.min(span / 2, before), needTo = Math.min(view.t1 + tfMs, now + tfMs);
  const ask = { from: Math.floor((view.t0 - before) / HOUR) * HOUR, to: Math.ceil(Math.min(view.t1 + after, now + tfMs) / MINUTE) * MINUTE };
  if (held && held.ident === ident) {
    if (loading) return null;
    // Only finer: a coarser period than what is held is never a reason to ask (a live window lengthens as its end moves on, a minute at a time).
    const finer = venues.some(venue => lsWindowPeriod(venue, tfMs, ask.from, ask.to) < lsWindowPeriod(venue, tfMs, held.from, held.to));
    // `soon`: the round ended with a venue still being read; its readings are asked for again then, not at the minute.
    const due = now - held.at >= MINUTE || (held.soon !== undefined && now >= held.soon);
    if (!finer && held.from <= needFrom && held.to >= needTo - MINUTE && !due) return null;
  }
  return ask;
}

/**
 * Where a series' line ends: its newest reading's step, a period after it (a daily reading stands for its whole day, an hourly one for its
 * hour), so lines of different periods compare by how far they are drawn. -Infinity with no readings.
 */
export const lsReach = (s: Pick<LsSeries, 'points' | 'periodMs'>): number => s.points.reduce((latest, p) => Math.max(latest, p.t), -Infinity) + s.periodMs;
/** `s` with `status`, no longer pending. */
function settledAs(s: LsSeries, status: LsSeries['status']): LsSeries { const out: LsSeries = { ...s, status }; delete out.pending; return out; }

/**
 * The series drawn while a round lands, in the order of `ids`: a venue's answer as soon as it comes; until then what it had before (`before`).
 * Once the round is over (`final`) a venue with no answer, or with a failure where readings were held before, keeps those readings marked
 * stale, or is failed when it had none: never left out, so the popup says it could not be read. A `pending` answer that reaches less far
 * than the line drawn (the source holds none for this window yet, or an older stretch of a finer period while it reads the rest) keeps the
 * line, still pending, so it never blanks or loses its newest hours while its venue is read.
 */
export function lsLanded(ids: readonly string[], before: readonly LsSeries[], answers: ReadonlyMap<string, LsSeries>, final: boolean): LsSeries[] {
  const out: LsSeries[] = [];
  for (const id of ids) {
    const answer = answers.get(id), prev = before.find(s => s.id === id), held = prev?.points.length ? prev : null;
    // Reaching less far than the line, or (the same period) as far with fewer readings: an older stretch while the rest is read.
    const shorter = answer?.pending && held && (lsReach(answer) < lsReach(held) || (answer.periodMs === held.periodMs && lsReach(answer) === lsReach(held) && answer.points.length < held.points.length));
    if (shorter && held) out.push({ ...held, pending: true });
    else if (answer && !(answer.status === 'failed' && held)) out.push(answer);
    // Stale: nothing is being read for it any more (a line kept while its venue was read says so no longer).
    else if (answer || final) out.push(held ? settledAs(held, 'stale') : answer ?? { id, population: prev?.population ?? null, periodMs: prev?.periodMs ?? 0, points: [], status: 'failed' });
    else if (prev) out.push(prev);
  }
  return out;
}
