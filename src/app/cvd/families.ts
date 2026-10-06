import type { Kind } from '../scope.ts';

/** One instrument's flow line in a family: spot or perpetual. */
export interface Lane { id: string; kind: Kind }
/** An exchange: its spot and its perpetual market together, as one row of the column. */
export interface Family { key: string; lanes: Lane[] }

/** The exchange a venue belongs to: Binance spot is a venue of its own in the feeds but one row here ("binancespot" and "binance"). */
export const familyKey = (venue: string): string => venue.length > 4 && venue.endsWith('spot') ? venue.slice(0, -4) : venue;
export const venueOfInstrument = (id: string): string => id.split(':')[0] ?? id;

/**
 * Group instruments into families. A family holds at most one spot and one perpetual lane (the first of each kind, in the order given),
 * a market whose kind the market list does not say counts as a perpetual (the exchanges that list only one kind are mostly perps), and
 * families come out in the order they were first met so a stable input gives a stable result.
 */
export function buildFamilies(ids: readonly string[], kindOf: (id: string) => Kind | null): Family[] {
  const families = new Map<string, Family>();
  for (const id of ids) {
    const key = familyKey(venueOfInstrument(id)), kind: Kind = kindOf(id) === 'spot' ? 'spot' : 'perp';
    let family = families.get(key); if (!family) { family = { key, lanes: [] }; families.set(key, family); }
    if (!family.lanes.some(lane => lane.kind === kind)) family.lanes.push({ id, kind });
  }
  return [...families.values()];
}
