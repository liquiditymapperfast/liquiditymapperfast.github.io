import type { AppState } from '../store.ts';
import { inScope } from '../scope.ts';
import { familyKey, venueOfInstrument } from './families.ts';
import { venueLabel } from '../venues.ts';

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

/**
 * Every instrument whose flow the page asks the server for: all the markets it knows, not only the ones the filter and the chips let
 * through. What is on screen is chosen from this later; asking for all of it is what lets the column say which exchanges it is leaving
 * out (their flow is there to be counted) and lets a click on "Show both" draw them with their history at once.
 */
export function flowLoadIds(state: Pick<AppState, 'markets'>, withFlow: readonly string[]): string[] {
  const known = new Set<string>(withFlow);
  for (const m of state.markets) { const id = m.instrumentId ?? m.id; if (id) known.add(id); }
  return [...known];
}

/**
 * The exchanges a person can pin: every one the page knows (a market on it, or flow recorded for it, whether or not its chip is on)
 * and every one already pinned, so a pin on an exchange that is gone can still be taken off. Sorted by name.
 */
export function pinChoices(state: Pick<AppState, 'markets'>, withFlow: readonly string[], pinned: readonly string[]): string[] {
  const keys = new Set<string>(pinned);
  for (const id of withFlow) keys.add(familyKey(venueOfInstrument(id)));
  for (const m of state.markets) { const id = m.instrumentId ?? m.id; if (id) keys.add(familyKey(venueOfInstrument(id))); }
  return [...keys].sort((a, b) => venueLabel(a).localeCompare(venueLabel(b)));
}

/**
 * The instrument whose recorded seconds give the price strip its price: the market on screen when it has flow, else its spot twin under
 * the flow feeds' name (`binance:BTCUSDT:spot` is `binancespot:BTCUSDT` there), else none, and the strip falls back to candle closes.
 */
export function priceFlowId(candidates: readonly string[], has: (id: string) => boolean): string | null {
  for (const id of candidates) {
    if (!id) continue;
    if (has(id)) return id;
    const m = /^([^:]+):(.+):spot$/.exec(id);
    if (m && has(`${m[1]}spot:${m[2]}`)) return `${m[1]}spot:${m[2]}`;
  }
  return null;
}
