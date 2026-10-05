/** One side of a venue book in USD, with the price band each level represents. */
export interface SideLevels {
  /** Band lower edge, upper edge and USD notional per level (parallel arrays). */
  lo: Float64Array;
  hi: Float64Array;
  usd: Float64Array;
}
export interface ValuedBook {
  instrumentId: string;
  venue: string;
  /** Provider timestamp when known, otherwise receipt time. */
  timestamp: number;
  /** True when levels are aggregated provider bands rather than native ticks. */
  coarse: boolean;
  bids: SideLevels;
  asks: SideLevels;
}
/** A single venue's book crossed by more than this many basis points is a feed fault, not a market state. */
export const MAX_CROSSED_BP = 5;

/**
 * How far the best bid sits above the best ask, in basis points (0 when the book is not crossed or a side is empty). It reads the extremes,
 * so the order a venue sends its levels in does not matter. Aggregated provider bands overlap at the touch by construction, so they are
 * not judged.
 */
export function crossedByBp(book: Pick<ValuedBook, 'bids' | 'asks' | 'coarse'>): number {
  if (book.coarse || !book.bids.usd.length || !book.asks.usd.length) return 0;
  let bid = -Infinity, ask = Infinity;
  for (const price of book.bids.hi) if (price > bid) bid = price;
  for (const price of book.asks.lo) if (price < ask) ask = price;
  return bid > ask ? (bid - ask) / ((bid + ask) / 2) * 1e4 : 0;
}
