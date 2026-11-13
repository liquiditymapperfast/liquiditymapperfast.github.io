import { SIZE_MAX_USD } from '../sizes.ts';

/**
 * Trades' settings (the flow column's second view, which replaced Time & sales and All trades on 2026-11-13): what one row is (`unit`: 0 is
 * each order, else a block of that many whole seconds, one by default: Karl's choice after two design rounds), the smallest order counted
 * (0: any size), the side, and whether a burst of orders is one row (each order only).
 */
export interface TradesSettings { unit: number; minUsd: number; side: 'both' | 'buy' | 'sell'; group: boolean }
export const TRADES_DEFAULTS: Readonly<TradesSettings> = { unit: 1, minUsd: 0, side: 'both', group: false };
/** The sizes offered after "Any size" (BTC's dollars; scaled for a coin that trades less; any size can be typed). */
export const TRADES_MINIMUMS: readonly number[] = [1_000, 5_000, 10_000, 25_000, 100_000];
/** The units the Group by menu offers (0: each order); any whole number of seconds up to `UNIT_MAX_S` can be chosen as Custom. */
export const TRADE_UNITS: readonly number[] = [0, 1, 60, 300, 900];
export const UNIT_MAX_S = 900;
/** Orders of one market and side in the same slice of this long are one row when grouping is on (fixed slices, so a row never changes as the list scrolls; the tape carries no fill count: ×N counts orders). */
export const GROUP_MS = 100;

/** A unit as saved: 0 (each order) or a whole number of seconds from 1 to `UNIT_MAX_S`. */
export const readUnit = (v: unknown, fallback: number): number => typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= UNIT_MAX_S ? v : fallback;

export function readTrades(saved: unknown): TradesSettings {
  const s = (saved && typeof saved === 'object' ? saved : {}) as Record<string, unknown>, d = TRADES_DEFAULTS;
  const min = typeof s.minUsd === 'number' && Number.isFinite(s.minUsd) && s.minUsd >= 0 && s.minUsd <= SIZE_MAX_USD ? s.minUsd : d.minUsd;
  // A save from before the unit existed was All trades' (each order) or Time & sales' (the large orders): both open on the default, a second.
  return { unit: readUnit(s.unit, d.unit), minUsd: min, side: s.side === 'buy' || s.side === 'sell' ? s.side : 'both', group: typeof s.group === 'boolean' ? s.group : d.group };
}
