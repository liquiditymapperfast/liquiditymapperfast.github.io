import type { ResetMode } from './candles.ts';

/** The Delta pane's settings: each candle's delta as bars or the CVD as candles, where the CVD restarts, and the price/CVD divergences. */
export interface DeltaSettings {
  style: 'bars' | 'candles' | 'nlns';
  reset: ResetMode;
  divergence: boolean;
  /** Candles each side a swing high or low needs to be confirmed (higher than its neighbours, or lower). */
  pivot: number;
  /** NL/NS as each candle's four parts (`'net'`, the name kept for saved pages: "Four parts") or split: the longs' and the shorts' running sums as two lines. */
  nlns: 'net' | 'split';
}

export const PIVOTS = [2, 3, 5, 8] as const;
export const DELTA_DEFAULTS: Readonly<DeltaSettings> = { style: 'candles', reset: 'none', divergence: true, pivot: 3, nlns: 'net' };

export function readDelta(saved: unknown): DeltaSettings {
  const s = (saved && typeof saved === 'object' ? saved : {}) as Partial<Record<keyof DeltaSettings, unknown>>, d = DELTA_DEFAULTS;
  return {
    style: s.style === 'bars' || s.style === 'nlns' ? s.style : 'candles',
    reset: s.reset === 'day' || s.reset === 'week' ? s.reset : 'none',
    divergence: typeof s.divergence === 'boolean' ? s.divergence : d.divergence,
    nlns: s.nlns === 'split' ? 'split' : 'net',
    pivot: typeof s.pivot === 'number' && (PIVOTS as readonly number[]).includes(s.pivot) ? s.pivot : d.pivot,
  };
}
