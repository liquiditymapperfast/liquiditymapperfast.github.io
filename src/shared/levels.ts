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
  /**
   * A grouped book's top bid and ask groups as the venue reports them, before `splitTouch` divided them between the sides at an estimate
   * of the touch: where the touch may be. A reader that compares the book over time spreads both over this span, since a split that moves
   * with the trades is not liquidity coming or going.
   */
  touch?: { lo: number; hi: number };
  /**
   * The grid step `mergeByDistance` merged this point book on (`shared/merge.ts`; the same number it was called with, the instrument's
   * recorder step or `gridStepFor` of the mid), on the server and in the browser engine alike. A grouped book (`coarse`: provider bands,
   * never merged) carries none, nor does a book nothing merged. A bucket is `DISTANCE_SHARE` (0.4 %) of its distance from the mid wide,
   * so out to about 250 steps from the mid it is a whole divisor of this step wide and sits inside one bin of it: within that distance the
   * book keeps its USD per bin of this grid (or of a multiple of it) exactly, whatever the mid does and whichever level comes or goes. A
   * reader that compares the book over time on a grid the buckets straddle (a ladder row of $25 on a $20 step) sees a bucket whose
   * representative price crossed a row's edge as liquidity leaving one row and arriving in the next, with nothing changed at the venue.
   */
  step?: number;
  /**
   * What the book covers, as a number that changes when that changes (`BookConnector.bookEpoch`): a book that synchronises from a separate
   * snapshot (Bybit's full depth) was seeded again, or its coverage grew past where it stopped. Absent for a book that is whole as it comes.
   * A reader that compares the book over time (a wall, a cue) starts again when it changes: more of the book became visible, nothing was
   * placed or pulled.
   */
  epoch?: number;
}
/**
 * Whether a merge step (`ValuedBook.step`) is one a reader may divide by: a finite number above zero. Anything else is left off the wire and
 * off the frame, so the one rule is the same where a step is sent, posted and read.
 */
export const usableStep = (step: unknown): step is number => typeof step === 'number' && Number.isFinite(step) && step > 0;
/** Whether a coverage epoch (`ValuedBook.epoch`) is one to carry: a whole number above zero. Anything else is left off the wire and off the frame. */
export const usableEpoch = (epoch: unknown): epoch is number => typeof epoch === 'number' && Number.isSafeInteger(epoch) && epoch > 0;
/** A single venue's book crossed by more than this many basis points is a feed fault, not a market state. */
export const MAX_CROSSED_BP = 5;

/**
 * A trade at most this old says where a grouped book's touch is (`splitTouch`). Hyperliquid's book arrives every few seconds and a thin
 * coin's last trade is often older than ten (measured 2026-10-11): such a trade says where the price was, not where the touch is.
 */
export const TOUCH_HINT_MS = 10_000;

/**
 * A grouped book names a bid group by its lower edge and an ask group by its upper edge, so while the spread sits inside one group the top
 * bid group and the top ask group are the same price interval ([P, P + step) on Hyperliquid). Bids rest below the venue's price and asks
 * above it: the shared interval is split there, at `price` (the venue's last trade, when fresh and inside the interval) or else at the
 * interval's middle, so no reader sees bids above asks. The cut stays an eighth of the interval from either edge: a trade on the edge
 * would squeeze one side's whole group into a single price, a wall that is not there. Returns the sides unchanged when they do not overlap;
 * when they do, also the span of the two top groups (`ValuedBook.touch`).
 */
export function splitTouch(bids: SideLevels, asks: SideLevels, price?: number): { bids: SideLevels; asks: SideLevels; touch?: { lo: number; hi: number } } {
  let bidTop = -Infinity, bidTopLo = Infinity, askBottom = Infinity, askBottomHi = -Infinity;
  // The top groups that hold something: an empty level shares nothing.
  for (let i = 0; i < bids.hi.length; i++) if (bids.usd[i]! > 0 && bids.hi[i]! > bidTop) { bidTop = bids.hi[i]!; bidTopLo = bids.lo[i]!; }
  for (let i = 0; i < asks.lo.length; i++) if (asks.usd[i]! > 0 && asks.lo[i]! < askBottom) { askBottom = asks.lo[i]!; askBottomHi = asks.hi[i]!; }
  // Only top groups that share an interval are split: a bid group wholly above the ask group is a crossed book, not a shared group, and
  // moving its liquidity would draw walls that are not there.
  const lo = Math.max(askBottom, bidTopLo), hi = Math.min(bidTop, askBottomHi);
  if (!(hi > lo)) return { bids, asks };
  const margin = (hi - lo) / 8;
  const cut = price !== undefined && price > lo && price < hi ? Math.min(hi - margin, Math.max(lo + margin, price)) : (lo + hi) / 2;
  const clip = (side: SideLevels, below: boolean): SideLevels => {
    const lo = Float64Array.from(side.lo), hi = Float64Array.from(side.hi);
    for (let i = 0; i < lo.length; i++) {
      if (below) { lo[i] = Math.min(lo[i]!, cut); hi[i] = Math.min(hi[i]!, cut); } else { lo[i] = Math.max(lo[i]!, cut); hi[i] = Math.max(hi[i]!, cut); }
    }
    return { lo, hi, usd: side.usd };
  };
  return { bids: clip(bids, true), asks: clip(asks, false), touch: { lo: Math.min(bidTopLo, askBottom), hi: Math.max(bidTop, askBottomHi) } };
}

/**
 * Whether a level lies inside a grouped book's top-group span (`ValuedBook.touch`), so a reader comparing the book over time spreads it over
 * the whole span: it is part of a group whose division between bids and asks is only an estimate.
 */
export const inTouch = (touch: ValuedBook['touch'], lo: number, hi: number): touch is { lo: number; hi: number } => touch !== undefined && lo >= touch.lo && hi <= touch.hi && hi > lo;

/**
 * How far the best bid sits above the best ask, in basis points (0 when the book is not crossed or a side is empty), over the levels that
 * hold something. It reads the extremes, so the order a venue sends its levels in does not matter. A grouped book is judged after
 * `splitTouch`: its shared top group then meets at one price, so only a book whose bid group lies above its ask group is crossed.
 */
export function crossedByBp(book: Pick<ValuedBook, 'bids' | 'asks' | 'coarse'>): number {
  let bid = -Infinity, ask = Infinity;
  for (let i = 0; i < book.bids.hi.length; i++) if (book.bids.usd[i]! > 0 && book.bids.hi[i]! > bid) bid = book.bids.hi[i]!;
  for (let i = 0; i < book.asks.lo.length; i++) if (book.asks.usd[i]! > 0 && book.asks.lo[i]! < ask) ask = book.asks.lo[i]!;
  return bid > ask ? (bid - ask) / ((bid + ask) / 2) * 1e4 : 0;
}
