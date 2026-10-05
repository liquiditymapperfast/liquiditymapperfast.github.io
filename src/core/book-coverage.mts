import { bestFirstDirection } from './sorted-levels.mts';
interface BookCoverageInput {
  bids?: readonly unknown[] | null;
  asks?: readonly unknown[] | null;
  sourceLevelCount?: { bids?: unknown; asks?: unknown } | null;
  coverageBounds?: unknown;
  coverage?: unknown;
}
interface BookCoverageUpdate { bids?: readonly unknown[] | null; asks?: readonly unknown[] | null }
interface BookBounds { min: number; max: number }
interface BookCoverageSummary {
  sourceLevelCount: { bids: number; asks: number };
  retainedLevelCount: { bids: number; asks: number };
  observedBounds: { bids: BookBounds | null; asks: BookBounds | null };
  coverageBounds: unknown;
  retentionTruncated: boolean;
}
type BookSide = 'bids' | 'asks';

/**
 * Preserve the difference between what a venue supplied and what a transport
 * or browser retained. A capped view must never make the retained range look
 * like complete market depth.
 */
const priceOf = (row: unknown): unknown => Array.isArray(row) ? row[0] : (row as { price?: unknown } | null | undefined)?.price;

function finitePrice(value: unknown): number | null {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : null;
}

function bounds(rows: readonly unknown[] | null = []): BookBounds | null {
  if (rows && rows.length > 2 && bestFirstDirection(rows) !== undefined) {
    // Known strictly best-first: the extremes are the two ends (when both are valid prices every level between them is too).
    const first = finitePrice(priceOf(rows[0])), last = finitePrice(priceOf(rows[rows.length - 1]));
    if (first !== null && last !== null) return { min: Math.min(first, last), max: Math.max(first, last) };
  }
  let min = Infinity, max = -Infinity;
  for (const row of rows ?? []) {
    const price = finitePrice(Array.isArray(row) ? row[0] : (row as { price?: unknown } | null | undefined)?.price);
    if (price === null) continue;
    if (price < min) min = price;
    if (price > max) max = price;
  }
  return max >= min ? { min, max } : null;
}

function countFor(book: BookCoverageInput | null | undefined, side: BookSide, fallback: number): number {
  const count = Number(book?.sourceLevelCount?.[side]);
  return Number.isInteger(count) && count >= 0 ? count : fallback;
}

/**
 * Return explicit source and retained coverage for a book representation.
 * `coverageBounds` describes the source snapshot; `observedBounds` describes
 * the rows actually retained in this representation.
 */
export function summarizeBookCoverage(book: BookCoverageInput | null | undefined, { bids = book?.bids ?? [], asks = book?.asks ?? [] }: { bids?: readonly unknown[]; asks?: readonly unknown[] } = {}): BookCoverageSummary {
  const retainedLevelCount = { bids: bids.length, asks: asks.length };
  const sourceLevelCount = {
    bids: countFor(book, 'bids', bids.length),
    asks: countFor(book, 'asks', asks.length),
  };
  const observedBounds = { bids: bounds(bids), asks: bounds(asks) };
  const sourceBounds = book?.coverageBounds ?? observedBounds;
  return {
    sourceLevelCount,
    retainedLevelCount,
    observedBounds,
    coverageBounds: sourceBounds,
    retentionTruncated: retainedLevelCount.bids < sourceLevelCount.bids || retainedLevelCount.asks < sourceLevelCount.asks,
  };
}

/** Annotate a state/stream book without changing its levels or coverage claim. */
export function annotateBookCoverage<T extends BookCoverageInput>(book: T, options: BookCoverageUpdate = {}): T & BookCoverageSummary {
  const next = { ...book };
  if (Object.prototype.hasOwnProperty.call(options, 'bids')) next.bids = options.bids ?? [];
  if (Object.prototype.hasOwnProperty.call(options, 'asks')) next.asks = options.asks ?? [];
  return { ...next, ...summarizeBookCoverage(next) };
}