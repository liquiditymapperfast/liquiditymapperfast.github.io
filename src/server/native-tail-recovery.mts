import type { RuntimeCandle, RuntimeOiSample, RuntimeState } from '../domain/runtime-state.mts';

/** Missing revisions describe legacy/bootstrap state before any recovery event. */
export function nativeTailRecoveryRevision(value: unknown): number | null {
  if (value === undefined) return 0;
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
}
/** Exhaustion fails closed instead of wrapping or acknowledging another change. */
export function advanceNativeTailRecovery(state: Pick<RuntimeState, 'tailRecoveryRevision'>): void {
  const previous = nativeTailRecoveryRevision(state.tailRecoveryRevision);
  state.tailRecoveryRevision = previous === null || previous === Number.MAX_SAFE_INTEGER ? -1 : previous + 1;
}
export function nativeTailBaselineMatches(capturedRevision: unknown, baselineRevision: unknown): boolean {
  const captured = nativeTailRecoveryRevision(capturedRevision);
  const baseline = nativeTailRecoveryRevision(baselineRevision);
  return captured !== null && baseline !== null && captured === baseline;
}
/** Reducer-owned rows only. Scalar scan; no history/index copies or retained memo. */
export function candleOutsideNativeTail(rows: readonly RuntimeCandle[], incoming: RuntimeCandle): boolean {
  let later = 0;
  for (let index = 0; index < rows.length; index++) {
    const row = rows[index]!;
    if (row.interval === incoming.interval && row.start > incoming.start && ++later >= 3) return true;
  }
  return false;
}
function pointClock(row: RuntimeOiSample): number | null {
  for (const value of [row.observationTimestamp, row.sourceTimestamp, row.receivedAt]) {
    if (value == null) continue;
    if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0 || value > 8.64e15) return null;
    return value;
  }
  return null;
}
/** An accepted older point/insertion cannot appear in the one-point tail. */
export function oiOutsideNativeTail(rows: readonly RuntimeOiSample[], incoming: RuntimeOiSample): boolean {
  const clock = pointClock(incoming);
  if (clock === null) return true;
  for (let index = 0; index < rows.length; index++) {
    const row = rows[index]!;
    if (row.instrumentId === incoming.instrumentId) {
      const existingClock = pointClock(row);
      if (existingClock === null || existingClock > clock) return true;
    }
  }
  return false;
}
