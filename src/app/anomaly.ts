/**
 * "Stands out" is decided in one place so every pane means the same thing by it: a value is anomalous when it exceeds the mean
 * plus `mult` standard deviations of the `length` values that came before it. The value under test never raises its own bar.
 */
export interface HighlightOptions {
  /** Master switch: with it off everything draws at its ordinary weight. */
  on: boolean;
  /** Standard deviations above the rolling mean (the sensitivity). */
  mult: number;
  /** Bars in the rolling baseline. */
  length: number;
}
export const DEFAULT_HIGHLIGHT: Readonly<HighlightOptions> = Object.freeze({ on: true, mult: 2, length: 72 });
export const HIGHLIGHT_LIMITS = { mult: { min: 1, max: 4, step: 0.25 }, length: { min: 12, max: 300, step: 6 } } as const;

/** Values needed before a baseline means anything; earlier bars are never flagged. */
export const WARMUP = 12;

/** Merge a saved object over the defaults, dropping anything out of range. */
export function readHighlight(saved: unknown): HighlightOptions {
  const o = saved && typeof saved === 'object' ? saved as Partial<Record<keyof HighlightOptions, unknown>> : {};
  const clamp = (v: unknown, fallback: number, min: number, max: number) => typeof v === 'number' && Number.isFinite(v) ? Math.min(max, Math.max(min, v)) : fallback;
  return {
    on: typeof o.on === 'boolean' ? o.on : DEFAULT_HIGHLIGHT.on,
    mult: clamp(o.mult, DEFAULT_HIGHLIGHT.mult, HIGHLIGHT_LIMITS.mult.min, HIGHLIGHT_LIMITS.mult.max),
    length: Math.round(clamp(o.length, DEFAULT_HIGHLIGHT.length, HIGHLIGHT_LIMITS.length.min, HIGHLIGHT_LIMITS.length.max)),
  };
}

export interface Anomalies {
  /** Per index: the value a bar must exceed to count as anomalous, NaN while the baseline is still warming up. */
  threshold: Float64Array;
  /** Per index: 1 when anomalous. */
  flag: Uint8Array;
  /** Per index: how many standard deviations above the baseline mean (NaN during warm-up, 0 when the baseline is flat). */
  sigma: Float64Array;
}

export function anomalies(values: ArrayLike<number>, { length, mult }: Pick<HighlightOptions, 'length' | 'mult'>): Anomalies {
  const n = values.length;
  const threshold = new Float64Array(n).fill(NaN), sigma = new Float64Array(n).fill(NaN), flag = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    const from = Math.max(0, i - length);
    let count = 0, sum = 0;
    for (let j = from; j < i; j++) { const x = values[j]!; if (Number.isFinite(x)) { sum += x; count++; } }
    if (count < WARMUP) continue;
    const mean = sum / count;
    let square = 0;
    for (let j = from; j < i; j++) { const x = values[j]!; if (Number.isFinite(x)) square += (x - mean) * (x - mean); }
    const sd = Math.sqrt(square / count);
    threshold[i] = mean + mult * sd;
    const x = values[i]!;
    if (!Number.isFinite(x)) continue;
    sigma[i] = sd > 0 ? (x - mean) / sd : 0;
    if (x > threshold[i]!) flag[i] = 1;
  }
  return { threshold, flag, sigma };
}
