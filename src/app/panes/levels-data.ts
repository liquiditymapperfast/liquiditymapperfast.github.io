import type { Kernels } from '../kernels.ts';
import type { LevelsFrame, SideArrays } from '../wire.ts';

export interface Grouped {
  ids: string[];
  step: number;
  /** Index of the first bin; bin i covers [(bin0 + i) * step, (bin0 + i + 1) * step). */
  bin0: number;
  nBins: number;
  bid: Float32Array[];
  ask: Float32Array[];
  totalBid: Float32Array;
  totalAsk: Float32Array;
}

const MAX_BINS = 6000;

function concat(sides: SideArrays[]): { lo: Float64Array; hi: Float64Array; usd: Float64Array; inst: Uint32Array } {
  const total = sides.reduce((s, side) => s + side.usd.length, 0);
  const lo = new Float64Array(total), hi = new Float64Array(total), usd = new Float64Array(total), inst = new Uint32Array(total);
  let at = 0;
  sides.forEach((side, k) => { lo.set(side.lo, at); hi.set(side.hi, at); usd.set(side.usd, at); inst.fill(k, at, at + side.usd.length); at += side.usd.length; });
  return { lo, hi, usd, inst };
}

/** Group the selected instruments' live levels onto a display grid covering [p0, p1]. */
export function groupLevels(kernels: Kernels, frame: LevelsFrame, ids: string[], step: number, p0: number, p1: number): Grouped {
  const books = ids.map(id => frame.books.find(book => book.id === id)).filter((book): book is NonNullable<typeof book> => !!book);
  const bin0 = Math.floor(p0 / step);
  const nBins = Math.max(1, Math.min(MAX_BINS, Math.ceil(p1 / step) - bin0 + 1));
  const totalBid = new Float32Array(nBins), totalAsk = new Float32Array(nBins);
  const run = (pick: (book: (typeof books)[number]) => SideArrays, total: Float32Array): Float32Array[] => {
    const c = concat(books.map(pick));
    const grid = kernels.spreadLevels(c.lo, c.hi, c.usd, c.inst, books.length, step, bin0, nBins);
    const rows = books.map((_, k) => grid.subarray(k * nBins, (k + 1) * nBins));
    for (const row of rows) for (let i = 0; i < nBins; i++) total[i]! += row[i]!;
    return rows;
  };
  const bid = run(book => book.bids, totalBid), ask = run(book => book.asks, totalAsk);
  return { ids: books.map(book => book.id), step, bin0, nBins, bid, ask, totalBid, totalAsk };
}

/** What a venue's book reaches: its lowest and highest price, and whether the highest is a single price (`hiPoint`) or the end of a band. */
export interface Cover { lo: number; hi: number; hiPoint?: boolean }

/** The price range a venue's book actually reaches, so a feed limit reads as "no data" rather than an empty book. */
export function coverage(book: LevelsFrame['books'][number] | undefined, mark: number): (Cover & { bp: number; levels: number }) | null {
  if (!book || !(mark > 0) || book.bids.usd.length + book.asks.usd.length === 0) return null;
  let lo = Infinity, hi = -Infinity;
  for (const v of book.bids.lo) if (v < lo) lo = v;
  for (const v of book.asks.hi) if (v > hi) hi = v;
  if (!Number.isFinite(lo)) lo = mark;
  if (!Number.isFinite(hi)) hi = mark;
  // A level that is one price (lo = hi) sits at its price; a band (several prices merged) stops short of its upper edge.
  let hiPoint = false;
  for (let i = 0; i < book.asks.hi.length; i++) if (book.asks.hi[i] === hi && book.asks.lo[i]! >= hi) { hiPoint = true; break; }
  return { lo, hi, hiPoint, bp: Math.round((hi - lo) / mark * 1e4), levels: book.bids.usd.length + book.asks.usd.length };
}

/**
 * Whether the row [rowLo, rowLo + step) of the ladder lies beyond what a venue's book reaches. A row ends before the lowest price when it
 * stops at or below it; the highest price is inside the row that starts at or below it when it is a single price (a level of the book at
 * exactly that price), and outside the row that starts at it when it is the end of a band.
 */
export function beyondCover(cover: Cover, rowLo: number, step: number): boolean {
  return rowLo + step <= cover.lo || (cover.hiPoint ? rowLo > cover.hi : rowLo >= cover.hi);
}

/** Cumulative USD walking away from the mark: bids downward, asks upward; the mark's own bin counts for both sides. */
export function cumulative(grouped: Grouped, mark: number): { bid: Float32Array; ask: Float32Array; maxBid: number; maxAsk: number } {
  const { nBins, bin0, step } = grouped;
  const bid = new Float32Array(nBins), ask = new Float32Array(nBins);
  const markBin = Math.floor(mark / step) - bin0;
  let run = 0;
  for (let i = Math.min(nBins - 1, markBin); i >= 0; i--) { run += grouped.totalBid[i]!; bid[i] = run; }
  const maxBid = run; run = 0;
  for (let i = Math.max(0, markBin); i < nBins; i++) { run += grouped.totalAsk[i]!; ask[i] = run; }
  return { bid, ask, maxBid, maxAsk: run };
}

export type Cumulative = ReturnType<typeof cumulative>;

/**
 * Which side holds more liquidity at each distance from the mark, as (bid - ask) / (bid + ask) of the cumulative liquidity within that
 * distance on each side (positive: bids dominate). Rows the same distance apart share a value. A row within `minRows` of the mark takes
 * the value at `minRows`, since the ratio of the very top of the book is mostly noise. All zeros when the mark is outside the grid.
 */
export function imbalanceByDistance(grouped: Pick<Grouped, 'nBins'>, cum: Cumulative, markBin: number, minRows = 4): Float32Array {
  const { nBins } = grouped, out = new Float32Array(nBins);
  if (!(markBin >= 0 && markBin < nBins)) return out;
  for (let i = 0; i < nBins; i++) {
    const d = Math.max(Math.abs(i - markBin), minRows);
    const b = cum.bid[Math.max(0, markBin - d)]!, a = cum.ask[Math.min(nBins - 1, markBin + d)]!, total = b + a;
    out[i] = total > 0 ? (b - a) / total : 0;
  }
  return out;
}

/**
 * Bid and ask liquidity in the bins from `loBin` to `hiBin` (both included, kept to the grid): the bids at and below the mark's bin, the asks
 * at and above it, the mark's own bin counting for both. This is what is on screen when the ladder is scrolled away from the mark.
 */
export function liquidityInView(grouped: Pick<Grouped, 'nBins' | 'totalBid' | 'totalAsk'>, markBin: number, loBin: number, hiBin: number): { bid: number; ask: number } {
  let bid = 0, ask = 0;
  for (let bin = Math.max(0, loBin); bin <= Math.min(grouped.nBins - 1, hiBin); bin++) {
    if (bin <= markBin) bid += grouped.totalBid[bin]!;
    if (bin >= markBin) ask += grouped.totalAsk[bin]!;
  }
  return { bid, ask };
}

/** Cumulative bid and ask liquidity within `rows` rows of the mark (what the balance bar shows). */
export function liquidityWithin(grouped: Pick<Grouped, 'nBins'>, cum: Cumulative, markBin: number, rows: number): { bid: number; ask: number } {
  const { nBins } = grouped;
  if (!(markBin >= 0 && markBin < nBins) || !(rows >= 0)) return { bid: 0, ask: 0 };
  return { bid: cum.bid[Math.max(0, markBin - rows)]!, ask: cum.ask[Math.min(nBins - 1, markBin + rows)]! };
}

/**
 * How bright a row's bars should be: the side that dominates at that distance is saturated, the weaker one fades, in proportion to the
 * imbalance (full effect at an imbalance of `full`). 1 means unchanged, so a balanced book looks exactly as it did.
 */
export function dominanceWeight(imbalance: number, isBidSide: boolean, full = 0.3): number {
  const strength = Math.min(1, Math.abs(imbalance) / full);
  return (imbalance > 0) === isBidSide ? 1 + 0.25 * strength : 1 - 0.5 * strength;
}
