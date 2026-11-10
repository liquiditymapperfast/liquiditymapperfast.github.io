/**
 * Anchored profiles (Karl, 2026-11-10: "a configuration ... that tells how often to update the anchor profile, ... maybe every 15 minutes, 1
 * hour"): the columns by price add up everything from a moment chosen up to now instead of what is on the chart. The window is held as a
 * snapshot and worked out again when it is due, not with every trade: from the anchor to the last whole five minutes when it was taken, five
 * minutes being the candle estimate's bars (the traded volume's months come from them), so every measure adds up the same stretch and the
 * column says where it begins and when it was taken. Designed with Sol 6.1 and the advisor (2026-11-10).
 */

const MINUTE = 60_000;
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

/** The stretch an anchored column adds up (from the anchor to `to`), what it was taken for (`key`) and when (`at`). */
export interface AnchorSnapshot { key: string; from: number; to: number; at: number }

/**
 * The anchored window to add up now: the one held while it is not due, else a new one from the anchor to the last whole five minutes. Due when
 * there is none, when it was taken for another anchor, coin or interval (`key`), when `everyMin` has passed since it was taken, when asked to
 * (`force`: Update now), or while it holds nothing yet (an anchor in the five minutes under way) and five more minutes have ended since.
 */
export function anchorSnapshot(held: AnchorSnapshot | null, key: string, anchor: number, everyMin: number, now: number, force = false): AnchorSnapshot {
  const to = Math.floor(now / ANCHOR_BAR_MS) * ANCHOR_BAR_MS;
  const due = !held || held.key !== key || force || now - held.at >= everyMin * MINUTE || (held.to <= held.from && to > held.to);
  return due ? { key, from: anchor, to, at: now } : held;
}

/** When a snapshot is next due (its interval after it was taken, or the next five minutes while it holds nothing), for a timer. */
export function snapshotDue(s: AnchorSnapshot, everyMin: number): number {
  return s.to <= s.from ? Math.min(s.at + everyMin * MINUTE, s.to + ANCHOR_BAR_MS) : s.at + everyMin * MINUTE;
}
