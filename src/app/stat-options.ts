/** Options shared by the bar-stats strip and the store (kept dependency-free so the store can use the defaults). */
export interface StatOptions {
  /** Diagonal imbalance: a level's volume must be at least this many times the opposite volume one row away (cryexc default 3). */
  imbRatio: number;
  /** ... and at least this much USD (default 0). */
  imbMinUsd: number;
  /** Consecutive imbalanced rows on one side that count as a stacked imbalance (default 3). */
  stackedN: number;
  /** Trades up to this size bucket are "retail", from `whaleMin` upward "whales" (buckets 0-7; defaults 2 and 5). */
  retailMax: number;
  whaleMin: number;
  /** Open interest change in the series' own units (base coin) or as USD (change times the bar's close). */
  oiUnits: 'base' | 'usd';
  /** Filled cells shaded by magnitude, or text only coloured by sign. */
  cells: 'filled' | 'text';
}
export const DEFAULT_STAT_OPTIONS: Readonly<StatOptions> = Object.freeze({ imbRatio: 3, imbMinUsd: 0, stackedN: 3, retailMax: 2, whaleMin: 5, oiUnits: 'base', cells: 'filled' });
