import { STRIDE } from '../tape/ring.ts';

/**
 * Trades' per-second tally (the flow column's second view, grouped by time): for every exchange second the tape ring holds, what the
 * filter lets in, added up per market: dollars bought and sold at market, how many orders, the largest buy and the largest sell (by write
 * number, so the order can be read back whole), and, for every order of a shown market whatever its size, the price times the dollars and
 * the dollars (a second's VWAP: the price change a block shows must not move with the size filter). Pure (no page): `panes/trades-view.ts`
 * adds blocks of seconds up from it (`trades/blocks.ts`).
 *
 * Kept batch by batch: each call reads only the writes the ring took since the last (a late order lands in its own second, however old,
 * while the tally still holds it). A new filter, a cleared ring or another ring starts over: the ring is read back from its newest order in
 * steps (`fill`), so a list that opens on hours of orders never blocks a frame. Memory is fixed: a ring of `cap` seconds, a few typed arrays
 * per market met (about 20 bytes a market a second).
 */

/** What the tally reads of the tape ring (the ring itself in the page; a plain object in the tests). */
export interface TallyRing {
  readonly data: Float32Array; readonly capacity: number; readonly written: number; readonly first: number; readonly generation: number;
  readonly ids: readonly string[]; readonly t0: number; readonly p0: number;
  /** The exchange time from which the ring holds every order it was sent, and the latest time of an order it wrapped past. */
  readonly heldFrom: number; readonly lostThrough: number;
}

/** What is counted: orders of at least `minUsd` (0: any size) on the side asked for, on the markets `shown` allows. */
export interface TallyFilter { minUsd: number; side: 'both' | 'buy' | 'sell'; shown: (id: string) => boolean }

/** Seconds held: six hours on a desktop, two on a phone (the ring holds about as much at a quiet hour's rate). */
export const tallySeconds = (phone: boolean): number => phone ? 2 * 3600 : 6 * 3600;
/** Records read back per step when the tally starts over (a step per frame keeps a full ring's reading to a fraction of a second). */
export const FILL_STEP = 131_072;
/** A venue counts as late when one of its orders arrived this far behind the newest exchange time already received, within `LATE_WINDOW_MS`. */
export const LATE_MS = 3_000;
const LATE_WINDOW_MS = 30_000;

export class SecondTally {
  readonly cap: number;
  /** The second each slot holds (NaN: none), its orders counted, and a change count (a block caches by it). */
  readonly #stamp: Float64Array; readonly #n: Uint32Array; readonly #rev: Uint32Array;
  readonly #topBuy: Float32Array; readonly #topBuyK: Float64Array; readonly #topSell: Float32Array; readonly #topSellK: Float64Array;
  /** Per market index of the ring: dollars bought, sold (filtered), and the price sums of every order (unfiltered). */
  readonly #buy: Float32Array[] = []; readonly #sell: Float32Array[] = []; readonly #pv: Float64Array[] = []; readonly #v: Float32Array[] = [];
  #ring: TallyRing | null = null; #generation = -1;
  #filter: TallyFilter = { minUsd: 0, side: 'both', shown: () => true };
  /** Whether each market index passes `shown` (built once per filter, extended as the ring meets new markets). */
  #allowed: boolean[] = [];
  /** The newest second held (NaN: none yet); the first write not read going forwards; the first read going backwards (`fill`). */
  #newest = NaN; #seen = 0; #older = 0;
  /** The greatest exchange time read, and the latest late arrival of each market (`late`). */
  #newestT = -Infinity;
  #lateAt: number[] = []; #lateMs: number[] = [];
  /** Orders that passed the filter since the hold began (`hold`), counted as they come. */
  #fence: number | null = null; #newSince = 0;
  /** Bumped whenever a slot changes (`rev`), and on every start over. */
  version = 0;
  /** Bumped on every start over only (a block kept for a filter is good until then). */
  resets = 0;

  constructor(cap: number) {
    this.cap = cap;
    this.#stamp = new Float64Array(cap).fill(NaN); this.#n = new Uint32Array(cap); this.#rev = new Uint32Array(cap);
    this.#topBuy = new Float32Array(cap); this.#topBuyK = new Float64Array(cap); this.#topSell = new Float32Array(cap); this.#topSellK = new Float64Array(cap);
  }

  get ring(): TallyRing | null { return this.#ring; }
  get filter(): TallyFilter { return this.#filter; }
  /** The newest second held, or NaN. */
  get newest(): number { return this.#newest; }
  /** The greatest exchange time read (ms). */
  get newestT(): number { return this.#newestT; }
  /** Whether older writes are still to be read back (the tally is starting over). */
  get filling(): boolean { return !!this.#ring && this.#older > this.#ring.first; }
  get held(): boolean { return this.#fence !== null; }
  get newSinceHold(): number { return this.#newSince; }
  /** Writes the ring took that the tally has not read yet. */
  get behind(): number { return this.#ring ? Math.max(0, this.#ring.written - this.#seen) : 0; }

  /**
   * The exchange time (ms) from which every second the tally holds counts every order the filter lets in: the ring's own start or wrap,
   * the oldest second the tally keeps, and while it reads back, how far it has got (an order is written when it arrives, after its exchange
   * time, so every write newer than the reading point was read; `margin` covers orders stamped up to that much before they arrived).
   */
  coveredFrom(margin = 2_000): number {
    const r = this.#ring;
    if (!r || !Number.isFinite(this.#newest)) return Infinity;
    let from = Math.max(r.heldFrom, Number.isFinite(r.lostThrough) ? r.lostThrough + 1 : -Infinity, (this.#newest - this.cap + 1) * 1000);
    if (this.#older > r.first) {
      const at = (this.#older % r.capacity) * STRIDE;
      from = Math.max(from, r.t0 + r.data[at]! + margin);
    }
    return from;
  }

  /** Start over on `ring` with `filter` (or the same filter): nothing held, the next `update` reads from the newest write and `fill` reads back. */
  reset(ring: TallyRing | null, filter: TallyFilter = this.#filter): void {
    this.#ring = ring; this.#filter = filter; this.#allowed = []; this.#generation = ring?.generation ?? -1;
    this.#stamp.fill(NaN); this.#newest = NaN; this.#newestT = -Infinity;
    this.#seen = this.#older = ring?.written ?? 0;
    this.#lateAt = []; this.#lateMs = [];
    this.#fence = null; this.#newSince = 0;
    this.version++; this.resets++;
  }

  #ok(m: number): boolean {
    let ok = this.#allowed[m];
    if (ok === undefined) ok = this.#allowed[m] = this.#filter.shown(this.#ring!.ids[m] ?? '');
    return ok;
  }
  #arrays(m: number): void {
    if (this.#buy[m]) return;
    for (let i = this.#buy.length; i <= m; i++) {
      this.#buy.push(new Float32Array(this.cap)); this.#sell.push(new Float32Array(this.cap)); this.#pv.push(new Float64Array(this.cap)); this.#v.push(new Float32Array(this.cap));
    }
  }
  /** The slot of second `sec`, emptied for it when it held another; -1 when the second is older than the tally keeps. */
  #slot(sec: number): number {
    if (!Number.isFinite(this.#newest) || sec > this.#newest) this.#newest = sec;
    else if (sec <= this.#newest - this.cap) return -1;
    const s = sec % this.cap;
    if (this.#stamp[s] !== sec) {
      this.#stamp[s] = sec; this.#n[s] = 0; this.#topBuy[s] = 0; this.#topSell[s] = 0; this.#topBuyK[s] = -1; this.#topSellK[s] = -1;
      for (let m = 0; m < this.#buy.length; m++) { this.#buy[m]![s] = 0; this.#sell[m]![s] = 0; this.#pv[m]![s] = 0; this.#v[m]![s] = 0; }
    }
    return s;
  }
  /** Add write `k` (counting it for the hold when `live`). */
  #add(k: number, live: boolean): void {
    const r = this.#ring!, at = (k % r.capacity) * STRIDE, d = r.data, m = d[at + 3]!;
    if (!this.#ok(m)) return;
    const t = r.t0 + d[at]!, usd = d[at + 2]!, a = usd < 0 ? -usd : usd, price = r.p0 + d[at + 1]!;
    if (live) {
      if (t > this.#newestT) this.#newestT = t;
      else if (this.#newestT - t > LATE_MS) { this.#lateAt[m] = this.#newestT; this.#lateMs[m] = this.#newestT - t; }
    } else if (t > this.#newestT) this.#newestT = t;
    const s = this.#slot(Math.floor(t / 1000));
    if (s < 0) return;
    this.#arrays(m);
    this.#pv[m]![s] += price * a; this.#v[m]![s] += a;
    const f = this.#filter;
    if (a >= f.minUsd && !(f.side === 'buy' && usd < 0) && !(f.side === 'sell' && usd > 0)) {
      this.#n[s]++;
      if (usd > 0) { this.#buy[m]![s] += usd; if (usd > this.#topBuy[s]!) { this.#topBuy[s] = usd; this.#topBuyK[s] = k; } }
      else { this.#sell[m]![s] += a; if (a > this.#topSell[s]!) { this.#topSell[s] = a; this.#topSellK[s] = k; } }
      if (live && this.#fence !== null && k >= this.#fence) this.#newSince++;
    }
    this.#rev[s]++;
  }

  /** Take what the ring gained since the last call; a cleared ring (another generation) starts over. Returns how many writes were read. */
  update(): number {
    const r = this.#ring;
    if (!r) return 0;
    if (r.generation !== this.#generation) { this.reset(r); return 0; }
    const end = r.written, from = Math.max(this.#seen, r.first);
    for (let k = from; k < end; k++) this.#add(k, true);
    this.#seen = end;
    if (this.#older < r.first) this.#older = r.first;
    if (end > from) this.version++;
    return end - from;
  }
  /** Read back up to `budget` older writes (the tally starting over). Returns how many were read. */
  fill(budget = FILL_STEP): number {
    const r = this.#ring;
    if (!r || r.generation !== this.#generation) return 0;
    const first = r.first, stop = Math.max(first, this.#older - budget);
    for (let k = this.#older - 1; k >= stop; k--) this.#add(k, false);
    const read = this.#older - stop;
    this.#older = stop;
    if (read) this.version++;
    return read;
  }

  hold(): void { if (this.#fence !== null) return; this.#fence = this.#ring?.written ?? 0; this.#newSince = 0; }
  release(): void { this.#fence = null; this.#newSince = 0; }

  /** The markets (ring indexes) that sent an order more than `LATE_MS` behind within the last half minute. */
  late(): number[] {
    const out: number[] = [];
    for (let m = 0; m < this.#lateAt.length; m++) { const at = this.#lateAt[m]; if (at !== undefined && this.#newestT - at <= LATE_WINDOW_MS) out.push(m); }
    return out;
  }
  lateMs(m: number): number { return this.#lateMs[m] ?? 0; }

  // ---- reading a second (the slot of `sec`, or -1 when the tally holds nothing for it) ----------------------------------------------
  slot(sec: number): number { const s = sec % this.cap; return s >= 0 && this.#stamp[s] === sec ? s : -1; }
  /** Markets with arrays (ring indexes 0 .. markets-1). */
  get markets(): number { return this.#buy.length; }
  count(s: number): number { return this.#n[s]!; }
  rev(s: number): number { return this.#rev[s]!; }
  buy(m: number, s: number): number { return this.#buy[m]?.[s] ?? 0; }
  sell(m: number, s: number): number { return this.#sell[m]?.[s] ?? 0; }
  /** The second's VWAP of market `m` over every order (0: it did not trade). */
  vwap(m: number, s: number): number { const v = this.#v[m]?.[s] ?? 0; return v > 0 ? this.#pv[m]![s]! / v : 0; }
  topBuy(s: number): number { return this.#topBuy[s]!; }
  topBuyK(s: number): number { return this.#topBuyK[s]!; }
  topSell(s: number): number { return this.#topSell[s]!; }
  topSellK(s: number): number { return this.#topSellK[s]!; }
}
