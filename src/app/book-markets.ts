import type { AppState } from './store.ts';
import { activeIds, emptyScopeMessage, kindOf, marketIds } from './scope.ts';
import { familyKey, venueOfInstrument } from './cvd/families.ts';
import { BOOK_HOLD_MS } from './cvd/ids.ts';
import { parsePick, pickOf, type MarketKind, type PickOption } from './market-choice.ts';
import { t } from './i18n.ts';

/**
 * Whose order books the Depth pane and the Liquidity Tracker add up, and so their sounds (the depth sound, the balance tipping): one choice
 * for the two panes (Karl, 2026-11-13: "select exactly what venues they want to use for that, for the data in that panel"), as the OI pane's
 * Venues is one choice for open interest.
 *
 * - `all` (the default): the books of the venues switched on inside the Spot / Perp filter, as before.
 * - `chart`: the chart market's own book: the books of its exchange and kind (a Binance spot chart's book is `binancespot:…`, listed apart
 *   from the market its trades come from).
 * - `custom`: the books of the picks (`state.bookPicks`, exchanges and kinds as market-choice.ts keeps them, so a layout made on BTC never puts
 *   BTC's books under an ETH chart), whatever the venue chips and the Spot / Perp filter say.
 *
 * A pick stands for every book of its exchange and kind, matched on the books themselves, never through the flow's one market per exchange and
 * kind (`resolvePicks`), which for Binance spot is the market of its trades, not of its book. The books stream whatever the chips say (the
 * chips only filter what is drawn), so a picked book whose chip is off is still counted.
 */
export type BookMarkets = 'all' | 'chart' | 'custom';
export const readBookMarkets = (value: unknown): BookMarkets => value === 'chart' || value === 'custom' ? value : 'all';

type BookState = Pick<AppState, 'levels' | 'markets' | 'disabledVenues' | 'scope' | 'marketId' | 'bookMarkets' | 'bookPicks'> & Partial<Pick<AppState, 'bookGone'>>;

/** The pick a book or market stands for: its exchange and kind (a market the list does not type counts as a perpetual, as `buildFamilies` says). */
export const bookPickOf = (markets: AppState['markets'], id: string): string => pickOf(familyKey(venueOfInstrument(id)), kindOf(markets, id) === 'spot' ? 'spot' : 'perp');

/** The picks a choice other than `all` counts: the chart market's own, or those ticked. */
function countedPicks(state: BookState): Set<string> {
  if (state.bookMarkets === 'chart') return new Set(state.marketId ? [bookPickOf(state.markets, state.marketId)] : []);
  return new Set(state.bookPicks);
}

/**
 * The books in the feed the two panes add up and the balance sound counts, in the feed's order: `activeIds` itself for `all` (the same array,
 * so every key built from it and the order the tracker's parts come in are what they were), else the books of the picks counted.
 */
export function bookIds(state: BookState): string[] {
  if (state.bookMarkets === 'all') return activeIds(state);
  const picks = countedPicks(state);
  return (state.levels?.books ?? []).map(book => book.id).filter(id => picks.has(bookPickOf(state.markets, id)));
}

/**
 * The same choice over the market list, sorted, for what reads the recording over hours (the depth sound, the Depth pane's highlight):
 * `marketIds` for `all`, else every listed market of the picks counted. A book that drops out of the feed for a while is then a gap in the
 * recording, not another set of markets that starts the loading again; a listed market with no book (Binance spot's trades) reads nothing.
 */
export function bookMarketIds(state: BookState): string[] {
  if (state.bookMarkets === 'all') return marketIds(state);
  const picks = countedPicks(state), ids = new Set<string>();
  for (const m of state.markets) { const id = m.instrumentId ?? m.id; if (id && picks.has(bookPickOf(state.markets, id))) ids.add(id); }
  return [...ids].sort();
}

/**
 * Why the two panes have no book to add up, or '': for `all` the Spot / Perp filter leaving none, or every chip off; for the others no pick,
 * or no book of them on this coin. Nothing is said before the first books and the market list come (the panes say they are collecting), nor
 * while a counted book is only away for a moment: a feed that reconnects drops its book for a minute or more (`BOOK_HOLD_MS`, held as the
 * flow views hold it), and the panes then keep the series they drew rather than say the chart market or the picks have no book.
 */
export function bookEmptyMessage(state: BookState): string {
  if (state.bookMarkets === 'all') return emptyScopeMessage(state) ?? (state.levels?.books.length && !activeIds(state).length ? t('No venue is on: switch one on to sum up the order books.') : '');
  if (!state.levels?.books.length || !state.markets.length || bookIds(state).length || heldAway(state)) return '';
  if (state.bookMarkets === 'chart') return t('The chart market has no order book here.');
  return state.bookPicks.length ? t('None of the chosen markets has an order book on this coin.') : t('No market is chosen: tick some under Choose….');
}

/** Whether a market counted (by its exchange and kind) is of a venue whose book left the feed less than `BOOK_HOLD_MS` ago. */
function heldAway(state: BookState): boolean {
  const gone = state.bookGone ?? {}, asOf = state.levels?.asOf ?? 0, picks = countedPicks(state);
  for (const m of state.markets) {
    const id = m.instrumentId ?? m.id, at = id ? gone[venueOfInstrument(id)] : undefined;
    if (id && at !== undefined && asOf - at <= BOOK_HOLD_MS && picks.has(bookPickOf(state.markets, id))) return true;
  }
  return false;
}

/**
 * The picker's rows for books: one for each exchange and kind with a book in the feed (whatever the chips say), standing for its first book,
 * spot after perpetual within an exchange; then the picks kept that this coin has no book for (greyed, so they can be taken off).
 */
export function bookPickOptions(state: Pick<AppState, 'levels' | 'markets'>, picked: readonly string[]): PickOption[] {
  const byPick = new Map<string, string>();
  for (const book of state.levels?.books ?? []) { const pick = bookPickOf(state.markets, book.id); if (!byPick.has(pick)) byPick.set(pick, book.id); }
  const out: PickOption[] = [];
  for (const [pick, id] of byPick) { const p = parsePick(pick); if (p) out.push({ pick, family: p.family, kind: p.kind as MarketKind, id }); }
  out.sort((a, b) => a.family.localeCompare(b.family) || (a.kind === b.kind ? 0 : a.kind === 'perp' ? -1 : 1));
  for (const pick of picked) if (!byPick.has(pick)) { const p = parsePick(pick); if (p) out.push({ pick, family: p.family, kind: p.kind, id: null }); }
  return out;
}
