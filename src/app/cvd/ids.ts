import type { AppState } from '../store.ts';
import { inScope } from '../scope.ts';
import { venueOfInstrument } from './families.ts';

/**
 * The instruments the flow views count: every market the page knows and everything that has flow, on a venue that has a book on the map,
 * with its chip left on, and inside the Spot / Perp / Both filter.
 */
export function flowIds(state: Pick<AppState, 'markets' | 'disabledVenues' | 'scope' | 'levels'>, withFlow: readonly string[]): string[] {
  const known = new Set<string>(withFlow);
  for (const m of state.markets) { const id = m.instrumentId ?? m.id; if (id) known.add(id); }
  // A venue with no book on the map (not chosen, or left off as faulty) is not counted, however much of its flow was recorded earlier.
  const drawn = state.levels?.books.length ? new Set(state.levels.books.map(b => b.venue)) : null;
  return [...known].filter(id => !state.disabledVenues.includes(venueOfInstrument(id)) && (drawn === null || drawn.has(venueOfInstrument(id))) && inScope(state.scope, state.markets, id));
}
