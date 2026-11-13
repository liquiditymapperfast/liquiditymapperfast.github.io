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
  /**
   * Which market of the question this store is (its recorded columns and its live column are one market), for the parts of `ltSeries`;
   * a store without one is counted in the sums alone.
   */
  owner?: number;
}
/**
 * Each market's own part of the sums (the Liquidity Tracker's table): `owners` rows of `times.length` windows each, row-major, NaN where
 * the market had nothing in that window (not asked, not recorded, a gap in the lane). In the Per level mode a market's own figure is its
 * sum over its weights (`wBid`, `wAsk`, there only); the series' own figure is pooled over every market's weights, so the parts do not add
 * up to it then.
 */
export interface LtParts { bid: Float32Array; ask: Float32Array; wBid?: Float32Array; wAsk?: Float32Array }
/**
 * `estimated`: some recorded column was worked out from its average book (no kept tracker, or a size filter), not from its samples;
 * `approx`: per window, 1 where one of its columns was (so a stretch of the series can say whether it holds any).
 */
export interface LtSeries { times: Float64Array; bid: Float32Array; ask: Float32Array; estimated: boolean; parts?: LtParts; approx?: Uint8Array }

/**
 * How many of a series' windows (`times`, their starts, oldest first, each `stepMs` long) a replay at `cut` may show: those that had ended by
 * then. A window is the mean of its minutes' samples, so one that the replay's moment falls inside holds the book after that moment.
 */
export function shownBy(times: ArrayLike<number>, stepMs: number, cut: number): number {
  let n = times.length;
  while (n > 0 && times[n - 1]! + stepMs > cut) n--;
  return n;
}

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
 * found before the size filter so filtering never moves the reference. With `owners` (the markets the stores' `owner` numbers name), each
 * market's own part too (`LtParts`): the very numbers the sums are made of, so its rows add up to the series outside the Per level mode.
 */
export function ltSeries(stores: LtStore[], t0: number, t1: number, stepMs: number, params: LtParams, owners = 0): LtSeries {
  const slot = new Map<number, number>();
  const sumB: number[] = [], sumA: number[] = [], wB: number[] = [], wA: number[] = [], apx: number[] = [];
  // Each market's sums and weights by slot, NaN until a column of it is counted there (at most a slot more each a new slot takes).
  const own = owners > 0 ? Array.from({ length: owners }, () => ({ b: [] as number[], a: [] as number[], wb: [] as number[], wa: [] as number[] })) : null;
  const kept = params.minUsd <= 0 && params.maxUsd <= 0 ? ltIndex(params.halfLifeBp) : -1;
  let estimated = false;
  const slotOf = (t: number): number => {
    let i = slot.get(t);
    if (i === undefined) {
      i = slot.size; slot.set(t, i); sumB.push(0); sumA.push(0); wB.push(0); wA.push(0); apx.push(0);
      if (own) for (const o of own) { o.b.push(NaN); o.a.push(NaN); o.wb.push(NaN); o.wa.push(NaN); }
    }
    return i;
  };
  /** The market's row of the slot, made present (0) the first time one of its columns is counted there. */
  const mine = (store: LtStore, i: number): { b: number[]; a: number[]; wb: number[]; wa: number[] } | null => {
    const o = own && store.owner !== undefined && store.owner >= 0 && store.owner < owners ? own[store.owner]! : null;
    if (o && Number.isNaN(o.b[i]!)) { o.b[i] = 0; o.a[i] = 0; o.wb[i] = 0; o.wa[i] = 0; }
    return o;
  };
  const add = (i: number, o: ReturnType<typeof mine>, b: number, a: number, wb: number, wa: number): void => {
    sumB[i]! += b; sumA[i]! += a; wB[i]! += wb; wA[i]! += wa;
    if (o) { o.b[i]! += b; o.a[i]! += a; o.wb[i]! += wb; o.wa[i]! += wa; }
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
        add(i, mine(store, i), lt[base]!, lt[base + 1]!, lt[base + 2]!, lt[base + 3]!);
        continue;
      }
      const i = slotOf(t), o = mine(store, i);
      const lt = store.lt, base = c * LT_LENGTH + kept;
      if (kept >= 0 && lt && Number.isFinite(lt[base]!)) {
        add(i, o, lt[base]!, lt[base + 1]!, lt[base + 2]!, lt[base + 3]!);
        continue;
      }
      if (!store.instant) { estimated = true; apx[i] = 1; }
      // This column's own touch, before the size filter.
      let bestBid = -Infinity, bestAsk = Infinity;
      for (let e = from; e < from + n; e++) {
        const price = (store.bins[e]! + 0.5) * store.step;
        if (store.bid[e]! > 0 && price > bestBid) bestBid = price;
        if (store.ask[e]! > 0 && price < bestAsk) bestAsk = price;
      }
      for (let e = from; e < from + n; e++) {
        const price = (store.bins[e]! + 0.5) * store.step, b = store.bid[e]!, a = store.ask[e]!;
        if (Number.isFinite(bestBid) && counts(b, params)) { const w = ltWeight((bestBid - price) / bestBid * 1e4, params.halfLifeBp); add(i, o, b * w, 0, w, 0); }
        if (Number.isFinite(bestAsk) && counts(a, params)) { const w = ltWeight((price - bestAsk) / bestAsk * 1e4, params.halfLifeBp); add(i, o, 0, a * w, 0, w); }
      }
    }
  }
  const order = [...slot.entries()].sort((x, y) => x[0] - y[0]);
  const n = slot.size, times = new Float64Array(n), bid = new Float32Array(n), ask = new Float32Array(n), approx = new Uint8Array(n);
  order.forEach(([t, i], k) => {
    times[k] = t; approx[k] = apx[i]!;
    bid[k] = params.average ? (wB[i]! > 0 ? sumB[i]! / wB[i]! : 0) : sumB[i]!;
    ask[k] = params.average ? (wA[i]! > 0 ? sumA[i]! / wA[i]! : 0) : sumA[i]!;
  });
  if (!own) return { times, bid, ask, estimated, approx };
  const parts: LtParts = { bid: new Float32Array(owners * n), ask: new Float32Array(owners * n) };
  if (params.average) { parts.wBid = new Float32Array(owners * n); parts.wAsk = new Float32Array(owners * n); }
  own.forEach((o, m) => order.forEach(([, i], k) => {
    const at = m * n + k;
    parts.bid[at] = o.b[i]!; parts.ask[at] = o.a[i]!;
    if (parts.wBid && parts.wAsk) { parts.wBid[at] = o.wb[i]!; parts.wAsk[at] = o.wa[i]!; }
  }));
  return { times, bid, ask, estimated, parts, approx };
}

/** One market's figures in one window of a series' parts: its bid and ask (its own average in the Per level mode), or null where it had nothing. */
export function ltPartAt(parts: LtParts, windows: number, owner: number, k: number): { bid: number; ask: number } | null {
  const at = owner * windows + k, b = parts.bid[at], a = parts.ask[at];
  if (b === undefined || a === undefined || Number.isNaN(b) || Number.isNaN(a)) return null;
  if (!parts.wBid || !parts.wAsk) return { bid: b, ask: a };
  const wb = parts.wBid[at]!, wa = parts.wAsk[at]!;
  return { bid: wb > 0 ? b / wb : 0, ask: wa > 0 ? a / wa : 0 };
}
