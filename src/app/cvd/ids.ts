import type { AppState } from '../store.ts';
import { inScope } from '../scope.ts';
import { venueOfInstrument } from './families.ts';

/**
 * The instruments the flow views count: every market the page knows and everything that has flow, on an enabled venue (a chip left on)
 * and inside the Spot / Perp / Both filter.
 */
export function flowIds(state: Pick<AppState, 'markets' | 'disabledVenues' | 'scope'>, withFlow: readonly string[]): string[] {
  const known = new Set<string>(withFlow);
  for (const m of state.markets) { const id = m.instrumentId ?? m.id; if (id) known.add(id); }
  return [...known].filter(id => !state.disabledVenues.includes(venueOfInstrument(id)) && inScope(state.scope, state.markets, id));
}
