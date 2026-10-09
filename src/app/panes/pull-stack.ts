import type { Kernels } from '../kernels.ts';
import type { LevelsFrame } from '../wire.ts';
import { coverage, groupLevels, type Cover } from './levels-data.ts';

/**
 * Pull/stack on the order book: how much resting liquidity each price gained (stacked, +) or lost (pulled, −) over a window, from snapshots
 * of the book. Every venue in the frame is snapshotted on one fine grid (`pullBase`), so the venues switched on, the Group step and the view
 * are applied when it is read and changing them does not start the count again. A venue counts at a row only where both snapshots cover the
 * whole row (a book's depth limit moving with the price is not a pull), and a row the price reached in between is marked `touched`: there a
 * fill takes liquidity away exactly as a pull does, and the two cannot be told apart.
 */

/** The windows the order book offers, in seconds (0: off). */
export const PULL_WINDOWS = [15, 60, 300] as const;
export type PullWindow = 0 | (typeof PULL_WINDOWS)[number];
export const readPullWindow = (value: unknown): PullWindow => (PULL_WINDOWS as readonly unknown[]).includes(value) ? value as PullWindow : 0;

/** How many snapshots a window holds, and the shortest time between two. */
export const RING = 60, MIN_SPACING_MS = 1_000;
/** How far from the mark a snapshot reaches: this share of the price, and at most this many base bins each side. */
export const REACH = 0.02, MAX_HALF_BINS = 2_999;

/** The grid snapshots are kept on: five of the finest Group step, so every step the book offers from there up is a whole number of its bins. */
export const pullBase = (finest: number): number => Number((finest * 5).toPrecision(6));

/** How many base bins one row of `step` is, or 0 when it is not a whole number of them (a step finer than the base). */
export function binsPerRow(step: number, base: number): number {
  const k = Math.round(step / base);
  return k >= 1 && Math.abs(k * base - step) <= step * 1e-9 ? k : 0;
}

/** One venue's book at one moment on the base grid: the bins its book covers (inside the reach), the price range it reached, its best prices. */
export interface VenueSnap { bin0: number; bid: Float32Array; ask: Float32Array; cover: Cover; bestBid: number; bestAsk: number }
export interface BookSnap {
  seq: number; t: number; base: number;
  venues: Map<string, VenueSnap>;
  /** The lowest and highest the price was since the snapshot before. */
  markLo: number; markHi: number;
}

/** Every book of `frame` at time `t` on the grid `base`, around `mark`. */
export function snapshot(kernels: Kernels, frame: LevelsFrame, base: number, mark: number, t: number, seq: number, markLo = mark, markHi = mark): BookSnap {
  const half = Math.max(1, Math.min(MAX_HALF_BINS, Math.ceil(mark * REACH / base))), centre = Math.floor(mark / base);
  const ids = [...new Set(frame.books.map(book => book.id))];
  const g = groupLevels(kernels, frame, ids, base, (centre - half) * base, (centre + half) * base);
  const venues = new Map<string, VenueSnap>();
  g.ids.forEach((id, k) => {
    const book = frame.books.find(b => b.id === id), cover = coverage(book, mark);
    if (!book || !cover) return;
    const lo = Math.max(0, Math.floor(cover.lo / base) - g.bin0), hi = Math.min(g.nBins - 1, Math.floor(cover.hi / base) - g.bin0);
    if (hi < lo) return;
    let bestBid = -Infinity, bestAsk = Infinity;
    for (let i = 0; i < book.bids.usd.length; i++) if (book.bids.usd[i]! > 0 && book.bids.hi[i]! > bestBid) bestBid = book.bids.hi[i]!;
    for (let i = 0; i < book.asks.usd.length; i++) if (book.asks.usd[i]! > 0 && book.asks.lo[i]! < bestAsk) bestAsk = book.asks.lo[i]!;
    venues.set(id, { bin0: g.bin0 + lo, bid: g.bid[k]!.slice(lo, hi + 1), ask: g.ask[k]!.slice(lo, hi + 1), cover, bestBid, bestAsk });
  });
  return { seq, t, base, venues, markLo: Math.min(markLo, mark), markHi: Math.max(markHi, mark) };
}

/** For each row of the book: what each side gained (+) or lost (−), NaN where no venue covers the row at both ends; `touched` rows the price reached. */
export interface PullRows { bid: Float64Array; ask: Float64Array; touched: Uint8Array }

/** The sum of a venue's base bins [b0, b1] on one side, or NaN when the snapshot does not hold all of them. */
function binSum(v: VenueSnap, side: 'bid' | 'ask', b0: number, b1: number): number {
  const arr = v[side], i0 = b0 - v.bin0, i1 = b1 - v.bin0;
  if (i0 < 0 || i1 >= arr.length) return NaN;
  let sum = 0;
  for (let i = i0; i <= i1; i++) sum += arr[i]!;
  return sum;
}

/** Whether the row [lo, hi) lies wholly inside the price range a book reached (a row holding the book's last price is left out: it may be cut). */
const inside = (cover: Cover, lo: number, hi: number): boolean => lo >= cover.lo && hi <= cover.hi;

/**
 * The change at rows [bin0, bin0 + n) of `step` from `then` to `now` over the venues `ids`; `between` is every snapshot after `then` up to
 * `now`, for the prices reached. Null when a row is not a whole number of base bins.
 */
export function pullRows(then: BookSnap, now: BookSnap, between: readonly BookSnap[], ids: readonly string[], step: number, bin0: number, n: number): PullRows | null {
  const k = binsPerRow(step, now.base);
  if (!k || then.base !== now.base) return null;
  const bid = new Float64Array(n).fill(NaN), ask = new Float64Array(n).fill(NaN), touched = new Uint8Array(n);
  for (const id of ids) {
    const a = then.venues.get(id), b = now.venues.get(id);
    if (!a || !b) continue;
    for (let j = 0; j < n; j++) {
      const lo = (bin0 + j) * step, hi = lo + step;
      if (!inside(a.cover, lo, hi) || !inside(b.cover, lo, hi)) continue;
      const b0 = (bin0 + j) * k, b1 = b0 + k - 1;
      const db = binSum(b, 'bid', b0, b1) - binSum(a, 'bid', b0, b1), da = binSum(b, 'ask', b0, b1) - binSum(a, 'ask', b0, b1);
      if (db === db) bid[j] = (bid[j]! === bid[j]! ? bid[j]! : 0) + db;
      if (da === da) ask[j] = (ask[j]! === ask[j]! ? ask[j]! : 0) + da;
    }
  }
  // The prices reached from `then` to `now`: the trades seen between snapshots and the inside market (best bid and ask over `ids`) at each.
  let lo = Infinity, hi = -Infinity;
  for (const s of [then, ...between]) {
    let bestBid = -Infinity, bestAsk = Infinity;
    for (const id of ids) { const v = s.venues.get(id); if (v) { bestBid = Math.max(bestBid, v.bestBid); bestAsk = Math.min(bestAsk, v.bestAsk); } }
    if (s !== then) { lo = Math.min(lo, s.markLo); hi = Math.max(hi, s.markHi); }
    if (bestBid > -Infinity) lo = Math.min(lo, bestBid);
    if (bestAsk < Infinity) hi = Math.max(hi, bestAsk);
  }
  for (let j = 0; j < n; j++) { const rowLo = (bin0 + j) * step; if (rowLo + step > lo && rowLo <= hi) touched[j] = 1; }
  return { bid, ask, touched };
}

/** What the column shows: nothing (off), how long until the window is filled, that the step is too fine, or the rows. */
export type PullView = { kind: 'off' } | { kind: 'filling'; waitS: number } | { kind: 'fine' } | { kind: 'rows'; rows: PullRows };

/**
 * The snapshots of one book over one window: taken once per `window / RING` (never more often than once a second) while the book is drawn,
 * started again for another coin, grid or window, or after a gap (the book was hidden: what happened then is not known).
 */
export class PullHistory {
  #ring: BookSnap[] = [];
  #seq = 0;
  #key = '';
  #lo = Infinity; #hi = -Infinity;
  #cache: { key: string; view: PullView } | null = null;

  /** The price between snapshots (each frame the book draws). */
  noteMark(price: number): void { if (price > 0) { this.#lo = Math.min(this.#lo, price); this.#hi = Math.max(this.#hi, price); } }

  /** Take a snapshot when one is due; `key` names the coin, grid and window, and a new one starts again. */
  step(kernels: Kernels, frame: LevelsFrame, mark: number, now: number, windowS: number, base: number, key: string): void {
    const spacing = Math.max(MIN_SPACING_MS, windowS * 1000 / RING), last = this.#ring[this.#ring.length - 1];
    if (key !== this.#key || (last && now - last.t > 3 * spacing)) { this.#key = key; this.#ring = []; this.#cache = null; }
    else if (last && now - last.t < spacing) return;
    this.#ring.push(snapshot(kernels, frame, base, mark, now, ++this.#seq, this.#lo, this.#hi));
    this.#lo = Infinity; this.#hi = -Infinity;
    const keepFrom = now - windowS * 1000 - 2 * spacing;
    while (this.#ring.length > 2 && this.#ring[1]!.t <= keepFrom) this.#ring.shift();
  }

  /** The column for rows [bin0, bin0 + n) of `step` over `ids`: worked out once per new snapshot and view, then kept. */
  view(ids: readonly string[], step: number, bin0: number, n: number, windowS: number): PullView {
    if (!windowS) return { kind: 'off' };
    const ring = this.#ring, now = ring[ring.length - 1];
    if (!now) return { kind: 'filling', waitS: windowS };
    const spacing = Math.max(MIN_SPACING_MS, windowS * 1000 / RING), target = now.t - windowS * 1000;
    let at = -1;
    for (let i = ring.length - 2; i >= 0; i--) if (ring[i]!.t <= target + spacing / 2) { at = i; break; }
    if (at < 0) return { kind: 'filling', waitS: Math.max(1, Math.ceil((ring[0]!.t + windowS * 1000 - now.t) / 1000)) };
    const then = ring[at]!, key = `${then.seq}|${now.seq}|${step}|${bin0}|${n}|${ids.join(',')}`;
    if (this.#cache?.key === key) return this.#cache.view;
    const rows = pullRows(then, now, ring.slice(at + 1), ids, step, bin0, n);
    const view: PullView = rows ? { kind: 'rows', rows } : { kind: 'fine' };
    this.#cache = { key, view };
    return view;
  }
}
