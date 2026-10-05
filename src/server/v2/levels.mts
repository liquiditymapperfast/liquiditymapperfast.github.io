import { baseSizeUsdRate, usdBookLevels } from '../../core/book-valuation.mts';
import { hyperliquidGroupingBoundsDecimal } from '../../analytics/hyperliquid-bounds.mts';
import { gridStepFor } from '../../shared/grid.ts';
import { mergeByDistance } from './merge.mts';

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
interface BookLike {
  bids?: readonly unknown[] | null;
  asks?: readonly unknown[] | null;
  nSigFigs?: unknown;
  mantissa?: unknown;
  sourceGrouping?: unknown;
  sourceTimestamp?: unknown;
  receivedAt?: unknown;
  complete?: unknown;
  gap?: unknown;
  [key: string]: unknown;
}
interface MarketLike { venue?: unknown; [key: string]: unknown }

const empty = (): SideLevels => ({ lo: new Float64Array(0), hi: new Float64Array(0), usd: new Float64Array(0) });

/** Price band [lo, hi) a level covers. Hyperliquid aggregated levels name the lower edge of a grid band. */
function band(price: number, book: BookLike): { lo: number; hi: number; coarse: boolean } {
  const sigFigs = Number(book.nSigFigs);
  if (Number.isInteger(sigFigs) && sigFigs >= 2 && sigFigs <= 5) {
    try {
      const mantissa = Number(book.mantissa);
      const bounds = hyperliquidGroupingBoundsDecimal(price, sigFigs, Number.isInteger(mantissa) ? mantissa : undefined);
      return { lo: bounds.lower, hi: bounds.upper, coarse: true };
    } catch { /* fall through to a point level */ }
  }
  const grouping = Number(book.sourceGrouping);
  if (Number.isFinite(grouping) && grouping > 0) return { lo: price - grouping / 2, hi: price + grouping / 2, coarse: true };
  return { lo: price, hi: price, coarse: false };
}

/** True when an object has at least one own key (cheaper than building the key list). */
function hasKeys(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false;
  for (const _ in value as Record<string, unknown>) return true;
  return false;
}

/**
 * One side of a plain book (tuples of price and base amount) as USD point levels, in one pass into typed arrays. Null when any row is not
 * a plain tuple (a supplied notional, an object row), so the caller falls back to the general path; rows that are not positive numbers are
 * skipped exactly as the general path skips them.
 */
function plainSide(rows: readonly unknown[] | null | undefined, rate: number): SideLevels | null {
  const list = rows ?? [];
  const lo = new Float64Array(list.length), usd = new Float64Array(list.length);
  let n = 0;
  for (let i = 0; i < list.length; i++) {
    const row = list[i];
    if (!Array.isArray(row) || (row.length > 2 && row[2] !== undefined && row[2] !== null)) return null;
    const price = +row[0]!, amount = +row[1]!;
    if (!(price > 0) || !Number.isFinite(price) || !(amount > 0) || !Number.isFinite(amount)) continue;
    const quote = price * amount, value = quote * rate;
    if (!(Number.isFinite(quote) && Number.isFinite(value) && value >= 0)) continue;
    lo[n] = price; usd[n] = value; n++;
  }
  return n === list.length ? { lo, hi: lo, usd } : { lo: lo.slice(0, n), hi: lo.slice(0, n), usd: usd.slice(0, n) };
}

/** Convert a retained venue book to USD-valued levels. Returns null for gapped, incomplete or unvaluable books. */
/** `step` is the instrument's recorder grid step; merged buckets divide it so they never straddle a recorded bin. */
export function valueBook(instrumentId: string, book: BookLike | null | undefined, market: MarketLike | null, now: number, step?: number): ValuedBook | null {
  if (!book || book.gap === true || book.complete === false) return null;
  // BitMEX's inverse contracts (XBTUSD) are worth exactly 1 USD each but the metadata carries no contract value.
  const sized = market && market.inverse === true && String(market.venue ?? '') === 'bitmex' && !(Number(market.contractValue) > 0) && book.contractValue === undefined
    ? { ...market, contractValue: 1 } : market;
  const plain = !(Number(book.nSigFigs) > 0) && !(Number(book.sourceGrouping) > 0) && !hasKeys((book.levelMetadata as { bids?: unknown } | undefined)?.bids) && !hasKeys((book.levelMetadata as { asks?: unknown } | undefined)?.asks);
  const rate = plain ? baseSizeUsdRate(book, sized) : null;
  if (rate !== null) {
    const fastBids = plainSide(book.bids, rate), fastAsks = plainSide(book.asks, rate);
    if (fastBids && fastAsks && (fastBids.usd.length || fastAsks.usd.length)) return finish(instrumentId, book, market, now, step, false, fastBids, fastAsks);
  }
  const rows = usdBookLevels(book, sized);
  if (rows.length === 0) return null;
  const sides = { bid: { lo: [] as number[], hi: [] as number[], usd: [] as number[] }, ask: { lo: [] as number[], hi: [] as number[], usd: [] as number[] } };
  let coarse = false;
  for (const row of rows) {
    const b = band(row.price, book);
    coarse ||= b.coarse;
    const side = sides[row.side];
    side.lo.push(b.lo); side.hi.push(b.hi); side.usd.push(row.notionalUsd);
  }
  const pack = (side: { lo: number[]; hi: number[]; usd: number[] }): SideLevels =>
    side.usd.length === 0 ? empty() : { lo: Float64Array.from(side.lo), hi: Float64Array.from(side.hi), usd: Float64Array.from(side.usd) };
  return finish(instrumentId, book, market, now, step, coarse, pack(sides.bid), pack(sides.ask));
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

/** Merge far levels (point books only) and stamp the result. */
function finish(instrumentId: string, book: BookLike, market: MarketLike | null, now: number, step: number | undefined, coarse: boolean, bidSide: SideLevels, askSide: SideLevels): ValuedBook {
  const stamp = Number(book.sourceTimestamp);
  const received = Number(book.receivedAt);
  let bids = bidSide, asks = askSide;
  if (!coarse && bids.usd.length && asks.usd.length) {
    const mid = (bids.hi[0]! + asks.lo[0]!) / 2;
    if (mid > 0) { const grid = step && step > 0 ? step : gridStepFor(mid); bids = mergeByDistance(bids, mid, grid, true); asks = mergeByDistance(asks, mid, grid, false); }
  }
  return {
    instrumentId, venue: String(market?.venue ?? instrumentId.split(':')[0]),
    timestamp: Number.isFinite(stamp) && stamp > 0 ? stamp : Number.isFinite(received) && received > 0 ? received : now,
    coarse, bids, asks,
  };
}
