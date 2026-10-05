/**
 * Liquidity Tracker: the book's USD size on each side, weighted by distance from that side's touch with exponentially
 * decaying weights, as described in Bookmap's LT add-on. A level `d` basis points from the touch weighs 2^(-d / H); the
 * touch weighs 1. Distance is in basis points rather than price ticks so venues with different tick sizes agree.
 * Differences from Bookmap: our books are USD-valued bins on a shared grid (not native ticks) and carry no per-order
 * data, so the size filter applies to the aggregated size of a bin on one venue, not to individual orders.
 */
export interface LtParams {
  /** Half-life in basis points of price. */
  halfLifeBp: number;
  /** Only bins at least this large count (USD). */
  minUsd: number;
  /** Only bins at most this large count (USD); 0 = no cap. */
  maxUsd: number;
  /** Divide by the sum of weights over the non-empty bins, as if each had size 1. */
  average: boolean;
}
export const LT_DEFAULTS: LtParams = { halfLifeBp: 10, minUsd: 0, maxUsd: 0, average: false };

/** Sparse columns of one instrument on its own grid: entry e of column c covers price bin `bins[e]` of width `step`. */
export interface LtStore {
  step: number;
  times: ArrayLike<number>;
  counts: ArrayLike<number>;
  bins: ArrayLike<number>;
  bid: ArrayLike<number>;
  ask: ArrayLike<number>;
  /** Ignore columns at or after this time (a newer live column replaces them). */
  cutoff?: number;
}
export interface LtSeries { times: Float64Array; bid: Float32Array; ask: Float32Array }

/** Weight of a level `bp` basis points from its side's touch: 1 at the touch, 1/2 every half-life. */
export function ltWeight(bp: number, halfLifeBp: number): number { return Math.pow(2, -Math.max(0, bp) / Math.max(halfLifeBp, 1e-9)); }

function counts(usd: number, p: LtParams): boolean { return usd > 0 && usd >= p.minUsd && (p.maxUsd <= 0 || usd <= p.maxUsd); }

/**
 * LT-Bid and LT-Ask per time column over the aggregated book of `stores`. The touch of each side is the best bid and best
 * ask over all stores at that time, measured before the size filter so filtering never moves the reference.
 */
export function ltSeries(stores: LtStore[], t0: number, t1: number, stepMs: number, params: LtParams): LtSeries {
  const slot = new Map<number, number>();
  const bestBid: number[] = [], bestAsk: number[] = [];
  const visit = (each: (store: LtStore, i: number, from: number, n: number) => void) => {
    for (const store of stores) {
      let at = 0;
      for (let c = 0; c < store.times.length; c++) {
        const n = store.counts[c]!, t = store.times[c]!;
        if (t + stepMs > t0 && t < t1 && !(store.cutoff !== undefined && t >= store.cutoff)) {
          let i = slot.get(t);
          if (i === undefined) { i = slot.size; slot.set(t, i); bestBid.push(-Infinity); bestAsk.push(Infinity); }
          each(store, i, at, n);
        }
        at += n;
      }
    }
  };
  visit((store, i, from, n) => {
    for (let e = from; e < from + n; e++) {
      const price = (store.bins[e]! + 0.5) * store.step;
      if (store.bid[e]! > 0 && price > bestBid[i]!) bestBid[i] = price;
      if (store.ask[e]! > 0 && price < bestAsk[i]!) bestAsk[i] = price;
    }
  });
  const n = slot.size;
  const sumB = new Float64Array(n), sumA = new Float64Array(n), wB = new Float64Array(n), wA = new Float64Array(n);
  visit((store, i, from, count) => {
    const p0b = bestBid[i]!, p0a = bestAsk[i]!;
    for (let e = from; e < from + count; e++) {
      const price = (store.bins[e]! + 0.5) * store.step;
      const b = store.bid[e]!, a = store.ask[e]!;
      if (Number.isFinite(p0b) && counts(b, params)) { const w = ltWeight((p0b - price) / p0b * 1e4, params.halfLifeBp); sumB[i]! += b * w; wB[i]! += w; }
      if (Number.isFinite(p0a) && counts(a, params)) { const w = ltWeight((price - p0a) / p0a * 1e4, params.halfLifeBp); sumA[i]! += a * w; wA[i]! += w; }
    }
  });
  const order = [...slot.entries()].sort((x, y) => x[0] - y[0]);
  const times = new Float64Array(n), bid = new Float32Array(n), ask = new Float32Array(n);
  order.forEach(([t, i], k) => {
    times[k] = t;
    bid[k] = params.average ? (wB[i]! > 0 ? sumB[i]! / wB[i]! : 0) : sumB[i]!;
    ask[k] = params.average ? (wA[i]! > 0 ? sumA[i]! / wA[i]! : 0) : sumA[i]!;
  });
  return { times, bid, ask };
}
