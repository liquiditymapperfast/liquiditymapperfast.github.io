import type { OiBar } from './store.ts';

export interface OiCandidate { inst: string; bars: OiBar[] }

/** Few bars, or none lately: the venue only reports OI since the server started, or not at all. */
export function weakOi(bars: readonly OiBar[], now: number, tfMs: number): boolean {
  if (bars.length < 30) return true;
  return now - bars[bars.length - 1]![0] > Math.max(5 * tfMs, 5 * 60_000);
}

/**
 * Choose which instrument's open interest to show. The selected market's own series wins when it is healthy; otherwise the
 * candidate with the most bars is used, and the caller labels it, so a market without OI history still gets a real context series.
 */
export function pickOi(candidates: readonly OiCandidate[], now: number, tfMs: number): OiCandidate | null {
  if (!candidates.length) return null;
  const healthy = candidates.find(c => !weakOi(c.bars, now, tfMs));
  if (healthy) return healthy;
  let best = candidates[0]!;
  for (const c of candidates) if (c.bars.length > best.bars.length) best = c;
  return best;
}
