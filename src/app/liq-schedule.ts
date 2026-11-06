/**
 * When the page asks the levels service again (`liq-levels.ts` for the levels file, `liq-history.ts` for today's history file). Asking every
 * minute, as the page did, made 29 answers of 30 "unchanged" and most of the service's requests (Karl, 2026-11-06).
 *
 * The service (HyperLiquidMap_Levels `schedule.rs`) asks HyperTracker for the next snapshot at the held one's `createdAt` +
 * `ht_period_seconds` (1775) + `ht_ready_seconds` (525) = 2300 s, then every 3 minutes while HyperTracker still names the held one (five
 * times), then every 10 minutes. Its publications came 38.4 minutes after the previous `createdAt` every time (2026-11-04..06, 98
 * snapshots). So the page asks from 37 minutes after the held snapshot's `createdAt`, each minute until the service's quick retries are over,
 * then every five minutes. A snapshot published again with a later `fetchedAt` keeps its `createdAt`: nothing moves. If the service's period
 * or ready time is ever shortened, the page shows snapshots late by the difference until this file is changed too.
 */

const MINUTE = 60_000;
/** The next snapshot is asked for from this long after the held one's `createdAt` (80 s under the service's 2300 s). */
export const SNAPSHOT_DUE_MS = 37 * MINUTE;
/** Each minute until this long after it (the service's five 3-minute retries end at 53.3 minutes); past it, every `LATE_EVERY_MS`. */
export const SNAPSHOT_LATE_MS = 55 * MINUTE;
export const DUE_EVERY_MS = MINUTE;
export const LATE_EVERY_MS = 5 * MINUTE;

/**
 * When, on the page's clock, a snapshot first seen `now` was created: its `createdAt` (HyperTracker's clock) taken as an age, held to
 * [0, SNAPSHOT_LATE_MS], so a page clock off by minutes changes the wait by no more than that and never stops the asking.
 */
export function createdOnPageClock(createdAt: number, now: number): number {
  const age = now - createdAt;
  return now - (Number.isFinite(age) ? Math.min(SNAPSHOT_LATE_MS, Math.max(0, age)) : 0);
}

/** Asks at most this far apart that saw a new snapshot appear place it between them (the late asks are five minutes apart). */
export const SEEN_APPEAR_MS = 6 * MINUTE;

/**
 * When, on the page's clock, a snapshot was created that an ask `now` found and an ask `before` had not (at most `SEEN_APPEAR_MS` earlier):
 * it was published between them, and the service's own `fetchedAt` - `createdAt` says how long before that it was created. No clock but
 * the page's own is read, so a page clock that is off places it right all the same (only the first snapshot after the page opens is placed
 * by its age, `createdOnPageClock`). Off by at most half the gap between the asks plus the edge's minute or two.
 */
export function createdBetweenAsks(createdAt: number, fetchedAt: number, before: number, now: number): number {
  const made = fetchedAt - createdAt;
  return (before + now) / 2 - (Number.isFinite(made) ? Math.min(SNAPSHOT_LATE_MS, Math.max(0, made)) : 0);
}

/** The first lead (see `placeSnapshot`), doubled each time a new snapshot is found already there, up to `MAX_LEAD_MS`. */
export const FIRST_LEAD_MS = 4 * MINUTE;
export const MAX_LEAD_MS = 32 * MINUTE;

/**
 * Where a newer snapshot first seen by an ask `now` was created on the page's clock, and the lead the next wait is cut by. Seen appear (the
 * page held one before and its last answered ask, `before`, was near): placed between the asks, and no lead. Otherwise (the first after the
 * page opened or showed again, or a page clock behind, which makes every wait end after the publication) it is placed by its age and the
 * next wait is cut by a lead that doubles each time, so an ask comes before the next publication and sees it appear: a page clock that is
 * off corrects itself in a few snapshots, and a right one pays a few asks once.
 */
export function placeSnapshot(createdAt: number, fetchedAt: number, hadOne: boolean, before: number, now: number, lead: number): { created: number; lead: number } {
  if (hadOne && now - before <= SEEN_APPEAR_MS) return { created: createdBetweenAsks(createdAt, fetchedAt, before, now), lead: 0 };
  return { created: createdOnPageClock(createdAt, now), lead: lead > 0 ? Math.min(MAX_LEAD_MS, lead * 2) : FIRST_LEAD_MS };
}

/** When to ask next, `now`, for a held snapshot created at `created` (page clock, `placeSnapshot`), the wait cut by `lead`. */
export function nextAskAt(created: number, now: number, lead = 0): number {
  const due = created + SNAPSHOT_DUE_MS - lead;
  if (now < due) return due;
  return now + (now - created < SNAPSHOT_LATE_MS ? DUE_EVERY_MS : LATE_EVERY_MS);
}

/** Whether the page is out of sight: nothing it would draw needs asking for then (it asks when it shows again). */
export const pageHidden = (): boolean => typeof document !== 'undefined' && document.hidden === true;
