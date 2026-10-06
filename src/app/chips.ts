import { familyKey, venueOfInstrument } from './cvd/families.ts';

/** How many venue chips the full top bar shows before the rest go into a menu. */
export const INLINE_CHIPS = 8;

export interface ChipPlan { shown: string[]; more: string[] }

/**
 * Which venue chips sit in the bar and which are in the "+N" menu. Order is kept (a chip that moved when it was switched off would be
 * hard to hit again); a single venue over the limit just gets its chip, since "+1" saves nothing.
 */
export function chipPlan(venues: readonly string[], limit: number): ChipPlan {
  if (venues.length <= limit + 1) return { shown: [...venues], more: [] };
  return { shown: venues.slice(0, limit), more: venues.slice(limit) };
}

/** Venues grouped by exchange, the spot twin beside its perpetual ("binance" and "binancespot"), in the order the exchanges first appear. */
export function exchangeGroups(venues: readonly string[]): { key: string; venues: string[] }[] {
  const groups = new Map<string, string[]>();
  for (const venue of venues) { const key = familyKey(venueOfInstrument(venue)); groups.set(key, [...(groups.get(key) ?? []), venue]); }
  return [...groups].map(([key, list]) => ({ key, venues: list }));
}
