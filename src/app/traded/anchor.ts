/**
 * Anchored profiles (Karl, 2026-11-10: "a configuration ... that tells how often to update the anchor profile, ... maybe every 15 minutes, 1
 * hour"): the columns by price add up everything from a moment chosen up to now instead of what is on the chart. The window is held as a
 * snapshot and worked out again when it is due, not with every trade: from the anchor to the last whole five minutes when it was taken, five
 * minutes being the candle estimate's bars (the traded volume's months come from them), so every measure adds up the same stretch and the
 * column says where it begins and when it was taken. Designed with Sol 6.1 and the advisor (2026-11-10).
 */

const MINUTE = 60_000, DAY = 86_400_000;
/** Where the profile's anchor starts now (`HeatPane.profileAnchorStart`): as `Resolved`, and 'far' for a start further back than the columns reach. */
export type ProfileAnchorStart = { state: 'ready'; at: number; approx?: boolean } | { state: 'far'; at: number } | { state: 'coming' } | { state: 'failed' } | { state: 'short'; from: number } | { state: 'none' };
/**
 * How far back the profile's anchor can be: two years, and the days a zone and a leap year add (a previous year's high is up to two years back),
 * the window being worked out from the zone's hourly bars where the five-minute ones do not reach (`PROFILE_FINE_REACH_MS`).
 */
export const PROFILE_ANCHOR_REACH_MS = 733 * DAY;
/** How far back the five-minute candles of the estimate reach (the hub's `PROFILE_CANDLES_BACK_MS`): an older anchored window takes coarser bars. */
export const PROFILE_FINE_REACH_MS = 21 * 7 * DAY;
/** The bars the window is on: the candle estimate's (`candleBarMs`), so its start and its end are where an estimate's bars begin and end. */
export const ANCHOR_BAR_MS = 5 * MINUTE;
/** How often an anchored window is taken again, in minutes; 15 by default. */
export const ANCHOR_EVERY: readonly number[] = [5, 15, 60];
export const ANCHOR_EVERY_DEFAULT = 15;

/**
 * Where an anchor placed by a click at `t` starts: the start of the chart's candle clicked, on the estimate's five minutes (a click on an
 * hour's candle starts at that hour; on a minute's, at the five minutes it is in).
 */
export function anchorAt(t: number, chartMs: number): number {
  const bar = Math.max(ANCHOR_BAR_MS, Math.floor(chartMs / ANCHOR_BAR_MS) * ANCHOR_BAR_MS);
  return Math.floor(t / bar) * bar;
}

/**
 * The stretch an anchored column adds up (from the anchor to `to`), what it was taken for (`key`) and when (`at`); in a replay `rev` counts the
 * Update now presses, the window being worked out again from the moment shown at every five minutes of it.
 */
export interface AnchorSnapshot {
  key: string; from: number; to: number; at: number; rev?: number;
  /**
   * Why the window holds nothing (from and to the same), when it cannot yet: a live anchor's candle is being found ('coming'), its period has
   * none yet ('none'), or it is further back than the columns reach ('far'). The columns are then empty and say so, never the chart's totals.
   */
  state?: 'coming' | 'failed' | 'short' | 'none' | 'far';
}

/**
 * The anchored window to add up now: the one held while it is not due, else a new one from the anchor to the last whole five minutes. Due when
 * there is none, when it was taken for another anchor, coin or interval (`key`), when `everyMin` has passed since it was taken, when asked to
 * (`force`: Update now), or while it holds nothing yet (an anchor in the five minutes under way) and five more minutes have ended since.
 */
export function anchorSnapshot(held: AnchorSnapshot | null, key: string, anchor: number, everyMin: number, now: number, force = false, barMs = ANCHOR_BAR_MS): AnchorSnapshot {
  // To the last whole bar of the window's candles: five minutes, or the hour of a window older than they reach.
  const to = Math.floor(now / barMs) * barMs;
  const due = !held || held.key !== key || force || now - held.at >= everyMin * MINUTE || (held.to <= held.from && to > held.to);
  return due ? { key, from: anchor, to, at: now } : held;
}

/** When a snapshot is next due (its interval after it was taken, or the next five minutes while it holds nothing), for a timer. */
export function snapshotDue(s: AnchorSnapshot, everyMin: number): number {
  return s.to <= s.from ? Math.min(s.at + everyMin * MINUTE, s.to + ANCHOR_BAR_MS) : s.at + everyMin * MINUTE;
}

/** The question an anchored window asks the source: its bounds and when it was taken, so Update now asks again even for the same five minutes. */
export const anchorTag = (s: AnchorSnapshot): string => `anchor|${s.from}|${s.to}|${s.key === 'replay' ? `replay${s.rev ?? 0}` : s.at}`;

/**
 * Whether a held answer, asked with `tag`, may be drawn in the columns now: anchored (`s`), only one of the very window the header, the box and
 * Range say (the same anchor and end; an older end's answer drawn while the newer one loads was a total over another stretch than the one
 * named, and a failed newer one kept it there), and none while the window holds nothing yet; following the chart (`s` null), never an
 * anchored one (Sol, code review 2026-11-10, rounds 1 and 2).
 */
export function answerFits(tag: string, s: AnchorSnapshot | null): boolean {
  const [kind, from, to] = tag.split('|');
  if (!s) return kind !== 'anchor';
  return kind === 'anchor' && s.to > s.from && Number(from) === s.from && Number(to) === s.to;
}
