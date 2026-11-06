/**
 * When the page asks the levels service again (`liq-levels.ts` for the levels file, `liq-history.ts` for today's history file). Asking every
 * minute, as the page did, made 29 answers of 30 "unchanged" and most of the service's requests (Karl, 2026-11-06).
 *
 * The service (HyperLiquidMap_Levels `schedule.rs`) asks HyperTracker for the next snapshot at the held one's `createdAt` +
 * `ht_period_seconds` (1775) + `ht_ready_seconds` (525) = 2300 s, then 3 minutes after each answer that still names the held one (calls at
 * 38.3, 41.3, 44.3, 47.3 and 50.3 minutes), then every 10 minutes. Its publications came 38.4 minutes after the previous `createdAt` every
 * time (2026-11-04..06, 98 snapshots). So the page asks from 37 minutes after the held snapshot's `createdAt`, each minute until the
 * service's quick calls are over, then every five minutes. A snapshot published again with a later `fetchedAt` keeps its `createdAt`: nothing
 * moves. If the service's period or ready time is ever shortened, the planned asks find the snapshots already there and the lead below grows
 * until they come before them again (4 or 8 minutes earlier: a minute or two late at worst); change this file too all the same.
 *
 * `createdAt` is HyperTracker's clock; the page counts on its own. The difference is learned from every snapshot the page sees appear between
 * two asks (`placeSnapshot`). Before it is learned the page's clock is trusted, with a lead that grows whenever a planned ask finds the next
 * snapshot already there, and a snapshot that looks younger than the service can publish one (`YOUNGEST_SEEN_MS`) says the clock is behind:
 * a clock that is off makes the first snapshot or two late (20 minutes behind: about 15 minutes, once), never one missed for good; a clock
 * set back mid-session starts the learning again. `YOUNGEST_SEEN_MS` leans on the service too (its quickest fetch, 6.5 minutes after
 * creation in 2026-11).
 */

const MINUTE = 60_000;
/** The next snapshot is asked for from this long after the held one's `createdAt` (80 s under the service's 2300 s). */
export const SNAPSHOT_DUE_MS = 37 * MINUTE;
/** Each minute until this long after it (the service's last quick call is at 50.3 minutes); past it, every `LATE_EVERY_MS`. */
export const SNAPSHOT_LATE_MS = 52 * MINUTE;
export const DUE_EVERY_MS = MINUTE;
export const LATE_EVERY_MS = 5 * MINUTE;
/** A publication reaches the asks a minute after the service makes it, on average (the edge keeps the file 60 s, and up to 60 s more stale). */
export const EDGE_DELAY_MS = MINUTE;

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
 * it reached the asks between them, about `EDGE_DELAY_MS` after the service published it, and the service's own `fetchedAt` - `createdAt`
 * says how long before that it was created. No clock but the page's own is read. Off by at most half the gap between the asks plus a minute.
 */
export function createdBetweenAsks(createdAt: number, fetchedAt: number, before: number, now: number): number {
  const made = fetchedAt - createdAt;
  return (before + now) / 2 - EDGE_DELAY_MS - (Number.isFinite(made) ? Math.min(SNAPSHOT_LATE_MS, Math.max(0, made)) : 0);
}

/** The first lead (see `placeSnapshot`), doubled each time a new snapshot is found already there, up to `MAX_LEAD_MS`. */
export const FIRST_LEAD_MS = 4 * MINUTE;
export const MAX_LEAD_MS = 32 * MINUTE;

/** Where a snapshot was created on the page's clock, the lead the next wait is cut by, and the page's clock minus HyperTracker's when known. */
export interface Placement { created: number; lead: number; offset: number | null }

/** An ask made within this of when it was planned that finds the next snapshot already there says the plan was late. */
export const ON_TIME_MS = 90_000;

/**
 * Where a newer snapshot first seen by an ask `now` was created on the page's clock (`before`: when the last answered ask was made,
 * -Infinity before any; `offset`: the page's clock minus HyperTracker's as last learned, null before any; `onTime`: the ask was made when
 * it was planned, within `ON_TIME_MS`, not late because the page was hidden or just opened).
 * - Seen appear (the last ask, at most `SEEN_APPEAR_MS` before, had not had it): placed between the asks, which also learns the offset.
 * - Found already there by an ask made on time: the plan was late (an offset learned too high, an edge that served an old copy for a while,
 *   a clock behind), so the next wait is cut by a lead (4 minutes, doubling), until an ask comes before a publication and sees it appear;
 *   once the lead is the whole wait the offset is forgotten.
 * - Found already there by a late ask (the page was hidden, or just opened): placed by the offset when known, else by its age on the page's
 *   clock with the first lead. A snapshot made "in the future" says the page's clock is behind by more than its age (a wrong time zone):
 *   then the whole lead, so no publication can come and go unseen.
 */
export function placeSnapshot(createdAt: number, fetchedAt: number, before: number, now: number, lead: number, offset: number | null, onTime: boolean): Placement {
  const gap = now - before;
  if (gap >= 0 && gap <= SEEN_APPEAR_MS) {
    const created = createdBetweenAsks(createdAt, fetchedAt, before, now);
    return { created, lead: 0, offset: created - createdAt };
  }
  if (onTime) {
    const grown = lead > 0 ? Math.min(MAX_LEAD_MS, lead * 2) : FIRST_LEAD_MS;
    if (offset !== null && grown < MAX_LEAD_MS) return { created: Math.min(now, createdAt + offset), lead: grown, offset };
    return byPageClock(createdAt, now, grown);
  }
  if (offset !== null) return { created: Math.min(now, createdAt + offset), lead: 0, offset };
  return byPageClock(createdAt, now, Math.max(lead, FIRST_LEAD_MS));
}

/** Placed by its age on the page's clock (no offset known), with `lead`; one made "in the future" with the whole lead. */
function byPageClock(createdAt: number, now: number, lead: number): Placement {
  if (!(now - createdAt >= YOUNGEST_SEEN_MS)) return { created: now, lead: MAX_LEAD_MS, offset: null };
  return { created: createdOnPageClock(createdAt, now), lead, offset: null };
}

/**
 * The service publishes a snapshot 7 minutes after HyperTracker made it at the soonest, and the edge adds its minute: one that looks younger
 * than this on the page's clock says the clock is behind (a clock 33 to 39 minutes behind would otherwise wait past the next publication).
 */
export const YOUNGEST_SEEN_MS = 8 * MINUTE;

/** When to ask next, `now`, for a held snapshot created at `created` (page clock, `placeSnapshot`), the wait cut by `lead`. */
export function nextAskAt(created: number, now: number, lead = 0): number {
  const due = created + SNAPSHOT_DUE_MS - lead;
  if (now < due) return due;
  return now + (now - created < SNAPSHOT_LATE_MS ? DUE_EVERY_MS : LATE_EVERY_MS);
}

/**
 * The page's clock went back by more than a minute since it was last read (`lastNow`): what was placed and planned by the old clock is no
 * good. The snapshot held is then taken as created now, with the whole lead and no offset, so the page asks soon and learns its clock again.
 */
export const clockSetBack = (lastNow: number, now: number): boolean => now < lastNow - MINUTE;

/** Whether the page is out of sight: nothing it would draw needs asking for then (it asks when it shows again). */
export const pageHidden = (): boolean => typeof document !== 'undefined' && document.hidden === true;
