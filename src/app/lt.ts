/**
 * Liquidity Tracker: the book's USD size on each side, weighted by distance from the touch with exponentially decaying weights. A level
 * `d` basis points from the touch weighs 2^(-d / H); the touch weighs 1. Distance is in basis points rather
 * than price ticks so venues with different tick sizes agree.
 *
 * Each venue is measured from its own best bid and best ask, and the venues add up: they do not trade
 * at one price, and measured from one touch shared by all of them the weights followed the venues' premiums rather than the liquidity
 * (`shared/lt-sample.ts`). The recorder keeps the tracker of every minute, measured at each sample (`Column.lt`), and a window of minutes is
 * the mean of its samples, so zooming out does not change what is measured. Where a minute has none (recorded before it was kept) or a
 * size filter is set (the kept tracker is unfiltered), it is worked out from the minute's average book instead, still from each venue's own
 * touch: an estimate, smeared by the price moving inside the minute (and more so in a window of several), and the series says so.
 *
 * Limits: our books are USD-valued bins on a shared grid (not native ticks) and carry no per-order data, so the size
 * filter applies to the aggregated size of a bin on one venue, not to individual orders.
 */
import { LT_LENGTH, ltIndex, ltWeight } from '../shared/lt-sample.ts';

export { ltWeight };

export interface LtParams {
  /** Half-life in basis points of price. */
  halfLifeBp: number;
  /** Only bins at least this large count (USD). */
  minUsd: number;
  /** Only bins at most this large count (USD); 0 = no cap. */
  maxUsd: number;
  /** Divide by the sum of weights over the non-empty bins, as if each had size 1 (pooled over the venues). */
  average: boolean;
}
/**
 * 10 bp is the half-life by default, on a phone and on a desktop (Karl, 2026-11-03: "set the liquidity tracker to 10bp as default"). It was
 * 10 until 2026-10-26 and 100 from then ("the best setting"); `LT_REV4_HALF_LIFE_BP` is what a save of that time holds.
 */
export const LT_DEFAULTS: LtParams = { halfLifeBp: 10, minUsd: 0, maxUsd: 0, average: false };
export const LT_REV4_HALF_LIFE_BP = 100;

/** Sparse columns of one instrument on its own grid: entry e of column c covers price bin `bins[e]` of width `step`. */
export interface LtStore {
  step: number;
  times: ArrayLike<number>;
  counts: ArrayLike<number>;
  bins: ArrayLike<number>;
  bid: ArrayLike<number>;
  ask: ArrayLike<number>;
  /** The tracker kept with each column (LT_LENGTH values per column, NaN where none: `ColumnSet.lt`). */
  lt?: ArrayLike<number>;
  /** Ignore columns at or after this time (a newer live column replaces them). */
  cutoff?: number;
  /** One instant's book (the live column): measured from its own touch it is exact, not an estimate. */
  instant?: boolean;
  /**
   * A store of trackers alone (the lane, `lt-lane.ts`): `lt` holds this many numbers a column, those of the half-life asked, with no books
   * behind them (`counts` all 0). A column whose numbers are NaN is a gap: there is nothing to work it out from.
   */
  ltStride?: number;
}
/** `estimated`: some recorded column was worked out from its average book (no kept tracker, or a size filter), not from its samples. */
export interface LtSeries { times: Float64Array; bid: Float32Array; ask: Float32Array; estimated: boolean }

/**
 * The half-height of the imbalance view's axis (a share, 0..1): the largest |imbalance| in view, up to the next of 2, 5, 10, 20, 50 and 100 %.
 * The axis used to be fixed at +-100 %, where the few percent a book is out of balance by is a hair; now the bars fill the pane, and the
 * axis says what it is. A view with no imbalance at all (nothing in view) takes the smallest.
 */
export function imbalanceAxis(largest: number): number {
  for (const step of [0.02, 0.05, 0.1, 0.2, 0.5]) if (!(largest > step)) return step;
  return 1;
}

function counts(usd: number, p: LtParams): boolean { return usd > 0 && usd >= p.minUsd && (p.maxUsd <= 0 || usd <= p.maxUsd); }

/**
 * LT-Bid and LT-Ask per time column over `stores`: each store's own tracker, summed. A column's touch is its own best bid and best ask,
 * found before the size filter so filtering never moves the reference.
 */
export function ltSeries(stores: LtStore[], t0: number, t1: number, stepMs: number, params: LtParams): LtSeries {
  const slot = new Map<number, number>();
  const sumB: number[] = [], sumA: number[] = [], wB: number[] = [], wA: number[] = [];
  const kept = params.minUsd <= 0 && params.maxUsd <= 0 ? ltIndex(params.halfLifeBp) : -1;
  let estimated = false;
  const slotOf = (t: number): number => {
    let i = slot.get(t);
    if (i === undefined) { i = slot.size; slot.set(t, i); sumB.push(0); sumA.push(0); wB.push(0); wA.push(0); }
    return i;
  };
  for (const store of stores) {
    let at = 0;
    for (let c = 0; c < store.times.length; c++) {
      const n = store.counts[c]!, t = store.times[c]!, from = at;
      at += n;
      if (!(t + stepMs > t0 && t < t1) || (store.cutoff !== undefined && t >= store.cutoff)) continue;
      if (store.ltStride !== undefined) {
        // Trackers alone: the numbers of the window, or nothing (a gap draws nothing, not a zero).
        const lt = store.lt, base = c * store.ltStride;
        if (!lt || !Number.isFinite(lt[base]!)) continue;
        const i = slotOf(t);
        sumB[i]! += lt[base]!; sumA[i]! += lt[base + 1]!; wB[i]! += lt[base + 2]!; wA[i]! += lt[base + 3]!;
        continue;
      }
      const i = slotOf(t);
      const lt = store.lt, base = c * LT_LENGTH + kept;
      if (kept >= 0 && lt && Number.isFinite(lt[base]!)) {
        sumB[i]! += lt[base]!; sumA[i]! += lt[base + 1]!; wB[i]! += lt[base + 2]!; wA[i]! += lt[base + 3]!;
        continue;
      }
      if (!store.instant) estimated = true;
      // This column's own touch, before the size filter.
      let bestBid = -Infinity, bestAsk = Infinity;
      for (let e = from; e < from + n; e++) {
        const price = (store.bins[e]! + 0.5) * store.step;
        if (store.bid[e]! > 0 && price > bestBid) bestBid = price;
        if (store.ask[e]! > 0 && price < bestAsk) bestAsk = price;
      }
      for (let e = from; e < from + n; e++) {
        const price = (store.bins[e]! + 0.5) * store.step, b = store.bid[e]!, a = store.ask[e]!;
        if (Number.isFinite(bestBid) && counts(b, params)) { const w = ltWeight((bestBid - price) / bestBid * 1e4, params.halfLifeBp); sumB[i]! += b * w; wB[i]! += w; }
        if (Number.isFinite(bestAsk) && counts(a, params)) { const w = ltWeight((price - bestAsk) / bestAsk * 1e4, params.halfLifeBp); sumA[i]! += a * w; wA[i]! += w; }
      }
    }
  }
  const order = [...slot.entries()].sort((x, y) => x[0] - y[0]);
  const n = slot.size, times = new Float64Array(n), bid = new Float32Array(n), ask = new Float32Array(n);
  order.forEach(([t, i], k) => {
    times[k] = t;
    bid[k] = params.average ? (wB[i]! > 0 ? sumB[i]! / wB[i]! : 0) : sumB[i]!;
    ask[k] = params.average ? (wA[i]! > 0 ? sumA[i]! / wA[i]! : 0) : sumA[i]!;
  });
  return { times, bid, ask, estimated };
}
