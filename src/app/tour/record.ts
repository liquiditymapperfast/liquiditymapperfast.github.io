/**
 * What the page remembers of the tour, in this browser: that it was offered, and whether it was finished or left. Nothing about the person.
 * A version, so that a tour rewritten later can be offered again to those who never finished the one before. Where the browser keeps nothing
 * (a private window, blocked storage) the page still offers the tour only once per load.
 */
export const TOUR_KEY = 'hlm-tour-v1', TOUR_VERSION = 1;
/** `seen`: the invitation was shown; `dismissed`: it was declined, or the tour left before its end; `done`: the tour was taken to its end (each a time, ms). */
export interface TourRecord { v: number; seen?: number; dismissed?: number; done?: number }
export type TourEvent = 'seen' | 'dismissed' | 'done';

const when = (v: unknown): number | undefined => typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : undefined;

/** A record from storage, or null when there is none to read (anything else in its place is not one). */
export function readRecord(raw: unknown): TourRecord | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.v !== 'number' || !Number.isInteger(r.v) || r.v < 1) return null;
  const rec: TourRecord = { v: r.v };
  for (const key of ['seen', 'dismissed', 'done'] as const) { const at = when(r[key]); if (at !== undefined) rec[key] = at; }
  return rec;
}

/** Whether to offer the tour: to a visitor it was never offered to, or one who never finished it when it was rewritten. */
export function shouldInvite(rec: TourRecord | null, version = TOUR_VERSION): boolean {
  return rec === null || (rec.v < version && rec.done === undefined);
}

/** The record with `what` happened at `now` (a record of an older tour starts over: what it held was about another tour). */
export function mark(rec: TourRecord | null, what: TourEvent, now: number, version = TOUR_VERSION): TourRecord {
  return { ...(rec && rec.v === version ? rec : { v: version }), [what]: now };
}

let memory: TourRecord | null = null;
export function loadRecord(): TourRecord | null {
  try { const raw = window.localStorage.getItem(TOUR_KEY); return raw ? readRecord(JSON.parse(raw)) ?? memory : memory; } catch { return memory; }
}
/** Note that `what` happened now, and keep it. */
export function record(what: TourEvent, now: number = Date.now()): TourRecord {
  const next = mark(loadRecord(), what, now);
  memory = next;
  try { window.localStorage.setItem(TOUR_KEY, JSON.stringify(next)); } catch { /* not kept: the page remembers it until it is reloaded */ }
  return next;
}
