/**
 * When Trades asks the page's recording for its large orders again (review round 2, 2026-11-13): an answer must never make the next
 * question due at once. The question goes up to the seam where the tape takes over, and is asked again only when the seam has moved well
 * past where it was asked (a ring that wraps, a tally whose window slides), when a smaller size is wanted, or after a failure's wait.
 */
export interface RecordedAsk { state: 'no' | 'asking' | 'done'; askedAt: number; min: number; retryAt: number }
export const RECORDED_AGAIN_MS = 5 * 60_000;

/**
 * The seam the recording is asked up to for this view (ms), or null while it cannot be told: the order list reads the ring from its
 * oldest order; the blocks read the tally, whose window (hours) can start later than the ring holds, and whose start moves while it
 * reads back. Never before the ring holds an order (the recording's orders would end where the page had not begun listening).
 */
export function recordedSeam(o: { blocks: boolean; ringFrom: number | null; covered: number; filling: boolean }): number | null {
  if (o.ringFrom === null) return null;
  if (!o.blocks) return o.ringFrom;
  if (o.filling || !Number.isFinite(o.covered)) return null;
  return Math.max(o.ringFrom, o.covered);
}

/** Whether to ask now, for `want` (the smallest size wanted) up to `seam`. */
export function recordedDue(a: RecordedAsk, seam: number, want: number, now: number): boolean {
  if (a.state === 'asking' || now < a.retryAt) return false;
  if (a.state === 'no') return true;
  return want < a.min || Math.abs(seam - a.askedAt) > RECORDED_AGAIN_MS;
}
