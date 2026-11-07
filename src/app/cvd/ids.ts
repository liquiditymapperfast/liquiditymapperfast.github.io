import type { AppState } from '../store.ts';
import type { LevelsFrame } from '../wire.ts';
import { inScope } from '../scope.ts';
import { familyKey, venueOfInstrument } from './families.ts';
import { venueLabel } from '../venues.ts';

/**
 * How long a venue whose book left the map still counts in the flow views. A feed that reconnects drops its book for a minute or more
 * (Binance spot: 105 s at 21:07 UTC on 2026-10-15; every venue at once for 6 min that evening), and taking its flow out each time made its
 * line vanish from the flow column and moved the ALL VENUES lines, the Delta pane and the footprint's markets with it (Karl, 2026-10-15).
 */
export const BOOK_HOLD_MS = 10 * 60_000;

/** `gone` after `next` replaces `prev`: a venue that left the map is kept with the time of the last frame it was on, until `BOOK_HOLD_MS` later; one back on the map leaves it. The same object when nothing changed. */
export function nextBookGone(prev: LevelsFrame | null, next: LevelsFrame, gone: Readonly<Record<string, number>>): Readonly<Record<string, number>> {
  const now = new Set(next.books.map(b => b.venue));
  let out: Record<string, number> | null = null;
  const edit = (): Record<string, number> => (out ??= { ...gone });
  for (const venue of Object.keys(gone)) if (now.has(venue) || next.asOf - gone[venue]! > BOOK_HOLD_MS) delete edit()[venue];
  if (prev) for (const b of prev.books) if (!now.has(b.venue)) edit()[b.venue] = prev.asOf;
  return out ?? gone;
}

/**
 * The venues the flow views count as on the map: those with a book in the last frame and those whose book left it less than `BOOK_HOLD_MS`
 * ago. Null before the first frame (nothing is known, so nothing is left out).
 */
export function mapVenues(state: MapState): Set<string> | null {
  if (!state.levels) return null;
  const out = new Set(state.levels.books.map(b => b.venue)), asOf = state.levels.asOf;
  for (const [venue, at] of Object.entries(state.bookGone ?? {})) if (asOf - at <= BOOK_HOLD_MS) out.add(venue);
  return out;
}
/** What `mapVenues` reads; `bookGone` absent is none held. */
export type MapState = Pick<AppState, 'levels'> & Partial<Pick<AppState, 'bookGone'>>;

/**
 * Whether the orders of an instrument (`okx:BTC-USDT-SWAP`) are drawn on the map (trade bubbles, live dust, venue lines, liquidations,
 * absorption) and sound: its venue's chip on, and its book on the map or there moments ago (`mapVenues`), the venue rule of `flowIds`
 * (executions ignore its Spot / Perp filter). The chips are the map's books, so a venue with no book has none and could not be switched off:
 * with Deribit's chip alone on, OKX's trades went on drawing while its book was down (Karl, 2026-11-07). Make one per frame or batch: it
 * builds the map's venue set once, and answers each instrument from a memo keyed by the id itself (the bubbles ask for every print in view).
 */
export function instrumentShown(state: Pick<AppState, 'disabledVenues'> & MapState): (id: string) => boolean {
  const drawn = mapVenues(state), off = state.disabledVenues, seen = new Map<string, boolean>();
  return id => {
    let shown = seen.get(id);
    if (shown === undefined) { const venue = venueOfInstrument(id); seen.set(id, shown = !off.includes(venue) && (drawn === null || drawn.has(venue))); }
    return shown;
  };
}

/**
 * The instruments the flow views count: every market the page knows and everything that has flow, on a venue that has a book on the map
 * (or had one moments ago: `mapVenues`), with its chip left on, and inside the Spot / Perp / Both filter.
 */
export function flowIds(state: Pick<AppState, 'markets' | 'disabledVenues' | 'scope'> & MapState, withFlow: readonly string[]): string[] {
  const known = new Set<string>(withFlow);
  for (const m of state.markets) { const id = m.instrumentId ?? m.id; if (id) known.add(id); }
  // A venue with no book on the map (not chosen, or left off as faulty) is not counted, however much of its flow was recorded earlier.
  // No frame yet means nothing is known (every market stands); a frame that lists no books means nothing is on the map (the last book expired).
  const drawn = mapVenues(state);
  return [...known].filter(id => !state.disabledVenues.includes(venueOfInstrument(id)) && (drawn === null || drawn.has(venueOfInstrument(id))) && inScope(state.scope, state.markets, id));
}

/**
 * The same for open interest, whatever the Spot / Perp filter says: only perpetuals have it, so under Spot these are the markets Both
 * counts (the chips and the books on the map still count). Switching open interest on asks for it, and a Spot filter left on for the heat
 * map emptied the OI pane and its profiles (Karl, 2026-11-05).
 */
export const oiFlowIds = (state: Pick<AppState, 'markets' | 'disabledVenues' | 'scope'> & MapState, withFlow: readonly string[]): string[] =>
  flowIds({ ...state, scope: 'all' }, withFlow);

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

/** A spot market under the flow feeds' name (`binance:BTCUSDT:spot` is `binancespot:BTCUSDT` there); null for any other id. */
export function flowFeedSpotId(id: string): string | null {
  const m = /^([^:]+):(.+):spot$/.exec(id);
  return m ? `${m[1]}spot:${m[2]}` : null;
}

/**
 * The instrument whose recorded seconds give the price strip its price: the market on screen when it has flow, else its spot twin under
 * the flow feeds' name (`flowFeedSpotId`), else none, and the strip falls back to candle closes.
 */
export function priceFlowId(candidates: readonly string[], has: (id: string) => boolean): string | null {
  for (const id of candidates) {
    if (!id) continue;
    if (has(id)) return id;
    const spot = flowFeedSpotId(id);
    if (spot && has(spot)) return spot;
  }
  return null;
}
