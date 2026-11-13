import { SIZE_MAX_USD } from '../sizes.ts';

/** All trades' settings: the smallest order listed (0: any size, the default: Karl asked for "every single trade"), the side, and whether a burst is one row. */
export interface TradesSettings { minUsd: number; side: 'both' | 'buy' | 'sell'; group: boolean }
export const TRADES_DEFAULTS: Readonly<TradesSettings> = { minUsd: 0, side: 'both', group: false };
/** The sizes offered after "Any size" (BTC's dollars; scaled for a coin that trades less; any size can be typed). */
export const TRADES_MINIMUMS: readonly number[] = [1_000, 5_000, 10_000, 25_000, 100_000];
/** Orders of one market and side in the same slice of this long are one row when grouping is on (fixed slices, so a row never changes as the list scrolls; the tape carries no fill count: ×N counts orders). */
export const GROUP_MS = 100;

export function readTrades(saved: unknown): TradesSettings {
  const s = (saved && typeof saved === 'object' ? saved : {}) as Record<string, unknown>, d = TRADES_DEFAULTS;
  const min = typeof s.minUsd === 'number' && Number.isFinite(s.minUsd) && s.minUsd >= 0 && s.minUsd <= SIZE_MAX_USD ? s.minUsd : d.minUsd;
  return { minUsd: min, side: s.side === 'buy' || s.side === 'sell' ? s.side : 'both', group: typeof s.group === 'boolean' ? s.group : d.group };
}
