/**
 * When the page asks the levels service again (`liq-levels.ts` for the levels file, `liq-history.ts` for today's history file). The service
 * publishes one HyperTracker snapshot about every 30 minutes: from 2026-11-04 to 11-06 its fetches were 26.3 to 31.8 minutes apart (median
 * 29.7), with two HyperTracker outages of 50 and 151 minutes. Asking every minute, as the page did, made 29 answers of 30 "unchanged" and
 * most of the service's requests (Karl, 2026-11-06). So after a new snapshot the page waits until the next one can be there, asks each
 * minute until it comes (the edge keeps the file a minute, so one may come a minute or two late), and every five minutes once it is late.
 */

const MINUTE = 60_000;
/**
 * The next snapshot is asked for from this long after the one held was published: just under the shortest gap seen (26.3 min), so about six
 * asks a snapshot instead of thirty; one that comes sooner is drawn at most the difference late (its positions are 35 minutes old already).
 */
export const SNAPSHOT_DUE_MS = 26 * MINUTE;
/** Until this long after it was published, each minute; past it, every `LATE_EVERY_MS`. */
export const SNAPSHOT_LATE_MS = 40 * MINUTE;
export const DUE_EVERY_MS = MINUTE;
export const LATE_EVERY_MS = 5 * MINUTE;

/**
 * When, on the page's clock, a snapshot first seen `now` was published: its `fetchedAt` (the service's clock) taken as an age, held to
 * [0, SNAPSHOT_LATE_MS], so a page clock off by minutes changes the wait by no more than that and never stops the asking.
 */
export function publishedAt(fetchedAt: number, now: number): number {
  const age = now - fetchedAt;
  return now - (Number.isFinite(age) ? Math.min(SNAPSHOT_LATE_MS, Math.max(0, age)) : 0);
}

/** When to ask next, `now`, for a held snapshot published at `published` (page clock, `publishedAt`). */
export function nextAskAt(published: number, now: number): number {
  const due = published + SNAPSHOT_DUE_MS;
  if (now < due) return due;
  return now + (now - published < SNAPSHOT_LATE_MS ? DUE_EVERY_MS : LATE_EVERY_MS);
}

/** Whether the page is out of sight: nothing it would draw needs asking for then (it asks when it shows again). */
export const pageHidden = (): boolean => typeof document !== 'undefined' && document.hidden === true;
