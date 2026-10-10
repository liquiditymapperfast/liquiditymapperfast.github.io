/** Options shared by the bar-stats strip, the footprint and the store (kept dependency-free so the store can use the defaults). */
export interface StatOptions {
  /** Diagonal imbalance: a level's volume must be at least this many times the opposite volume one row away (3 is the usual default). */
  imbRatio: number;
  /** ... and at least this much USD (default 0). */
  imbMinUsd: number;
  /** Consecutive imbalanced rows on one side that count as a stacked imbalance (default 3). */
  stackedN: number;
  /** Whether a level against an empty row one away (nothing traded there, inside the candle's range) counts as imbalanced (default no). */
  imbZeros: boolean;
  /** Trades up to this size bucket are "retail", from `whaleMin` upward "whales" (buckets 0-7; defaults 2 and 5). */
  retailMax: number;
  whaleMin: number;
  /** Open interest change in the series' own units (base coin) or as USD (change times the bar's close). */
  oiUnits: 'base' | 'usd';
  /** Filled cells shaded by magnitude, or text only coloured by sign. */
  cells: 'filled' | 'text';
}
export const DEFAULT_STAT_OPTIONS: Readonly<StatOptions> = Object.freeze({ imbRatio: 3, imbMinUsd: 0, stackedN: 3, imbZeros: false, retailMax: 2, whaleMin: 5, oiUnits: 'base', cells: 'filled' });

/**
 * Options from storage or a layouts file, field by field, within what the settings allow: a ratio from 1, no negative size, stacks of two
 * rows or more, the retail and whale buckets 0 to 7 with whales above retail, and the units and cell styles there are.
 */
export function readStatOptions(raw: unknown): StatOptions {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>, d = DEFAULT_STAT_OPTIONS;
  const num = (v: unknown, lo: number, hi: number, fallback: number): number => typeof v === 'number' && Number.isFinite(v) && v >= lo && v <= hi ? v : fallback;
  const bucket = (v: unknown, fallback: number): number => typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= 7 ? v : fallback;
  let retailMax = bucket(r.retailMax, d.retailMax), whaleMin = bucket(r.whaleMin, d.whaleMin);
  if (whaleMin <= retailMax) { retailMax = d.retailMax; whaleMin = d.whaleMin; }
  return {
    imbRatio: num(r.imbRatio, 1, 100, d.imbRatio), imbMinUsd: num(r.imbMinUsd, 0, 1e12, d.imbMinUsd),
    stackedN: typeof r.stackedN === 'number' && Number.isInteger(r.stackedN) && r.stackedN >= 2 && r.stackedN <= 50 ? r.stackedN : d.stackedN,
    imbZeros: typeof r.imbZeros === 'boolean' ? r.imbZeros : d.imbZeros, retailMax, whaleMin,
    oiUnits: r.oiUnits === 'usd' ? 'usd' : 'base', cells: r.cells === 'text' ? 'text' : 'filled',
  };
}
