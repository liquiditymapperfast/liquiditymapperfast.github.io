import type { FlowSeries } from '../../shared/flow.ts';

export interface BurstOptions {
  /** The window that is judged, in seconds, and the stretch before it that says what is normal. */
  windowSec: number; baselineSec: number;
  /** How many standard deviations above the normal windows, and the least delta (USD) worth a mention whatever the statistics say. */
  k: number; minUsd: number;
}
export interface Burst { delta: number; z: number; windowSec: number }
/** A burst the column marks on its row: when, which instrument and exchange, which kind of market, and what it was. */
export interface BurstEvent extends Burst { t: number; id: string; family: string; kind: 'spot' | 'perp' }
export const BURST_DEFAULTS: Readonly<BurstOptions> = { windowSec: 10, baselineSec: 1_800, k: 4, minUsd: 1_000_000 };

/**
 * Whether the newest `windowSec` seconds of a series moved the cumulative delta further than usual: its delta against the deltas of the
 * non-overlapping windows of the `baselineSec` before it (mean and standard deviation of those, so a venue that always trades big needs
 * more than a quiet one). Two reads per window, so it can run on every second for every lane.
 */
export function burst(series: FlowSeries, nowSec: number, options: BurstOptions = BURST_DEFAULTS): Burst | null {
  const { windowSec, baselineSec, k, minUsd } = options;
  const span = series.span; if (!span || span.last < nowSec - windowSec) return null;
  const delta = series.delta(nowSec - windowSec + 1, nowSec);
  if (Math.abs(delta) < minUsd) return null;
  const count = Math.floor(baselineSec / windowSec); if (count < 12) return null;
  let sum = 0, sumSq = 0, n = 0;
  for (let i = 1; i <= count; i++) {
    const end = nowSec - i * windowSec, start = end - windowSec + 1;
    if (start < span.first) break;
    const d = series.delta(start, end); sum += d; sumSq += d * d; n++;
  }
  if (n < 12) return null;
  const mean = sum / n, sd = Math.sqrt(Math.max(0, sumSq / n - mean * mean)), residual = delta - mean;
  // A baseline that never varied (windows of exactly the same delta, most often none at all) has no deviation to measure against, so the
  // distance from its mean decides, with an infinite z that the caller shows as such: far enough from it to be worth a mention is a burst,
  // and the very amount it always has is not (that used to be one too).
  const flat = sd <= Math.abs(mean) * 1e-9;
  const z = flat ? (Math.abs(residual) >= minUsd ? Math.sign(residual) * Infinity : 0) : residual / sd;
  return Math.abs(z) >= k ? { delta, z, windowSec } : null;
}
