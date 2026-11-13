import { STRIDE, type TapeBoundary } from '../tape/ring.ts';

/**
 * All trades, the flow column's third view: every market order the page receives, newest on top (`panes/trades-view.ts` draws it). This
 * file is its arithmetic, with no page: which of the tape ring's orders the list shows (a filter over the ring's write numbers, never a copy
 * of the orders), kept current batch by batch, found backwards in bounded steps when the list opens or scrolls back, held still while the
 * pointer reads it, and the boundaries in write order between two rows. The orders are the ring's (`tape/ring.ts`): forward only, from when
 * the ring started; nothing of them is recorded, so there is no history to fill from.
 */

/** What the index reads of the ring (the ring itself in the page; a plain object in the tests). */
export interface RingLike {
  readonly data: Float32Array; readonly capacity: number; readonly written: number; readonly first: number; readonly generation: number;
  readonly ids: readonly string[]; readonly t0: number; readonly p0: number; readonly boundaries: readonly TapeBoundary[];
}

/** What the list shows: orders of at least `minUsd` (0: any size) on the side asked for, on the markets `shown` allows. */
export interface TradeFilter { minUsd: number; side: 'both' | 'buy' | 'sell'; shown: (id: string) => boolean }

/** Records examined per step of a backward search (a high floor can mean reading the whole ring: it is done in steps, between frames). */
export const SCAN_STEP = 65_536;

/** One order of the ring, read whole. */
export interface TradeRecord { k: number; t: number; price: number; usd: number; id: string; lo: number; hi: number }

export function readRecord(ring: RingLike, k: number): TradeRecord {
  const at = (k % ring.capacity) * STRIDE, d = ring.data;
  return { k, t: ring.t0 + d[at]!, price: ring.p0 + d[at + 1]!, usd: d[at + 2]!, id: ring.ids[d[at + 3]!] ?? '', lo: ring.p0 + d[at + 4]!, hi: ring.p0 + d[at + 5]! };
}

/**
 * The write numbers of the ring's orders that pass the filter, in ascending order, as a circular deque of float64 (write numbers outgrow
 * 32 bits only after years, but a slot index would be reused after a wrap). It grows by doubling up to the ring's capacity. `seen` is the
 * first write not yet examined going forwards, `older` the first examined going backwards (everything in [older, seen) was looked at).
 */
export class TradeIndex {
  #ring: RingLike | null = null;
  #generation = -1;
  #buf = new Float64Array(4096); #head = 0; #len = 0;
  #seen = 0; #older = 0;
  #filter: TradeFilter = { minUsd: 0, side: 'both', shown: () => true };
  /** Whether each market index of the ring passes `shown` (built once per filter, extended as the ring meets new markets). */
  #allowed: boolean[] = [];
  /** The hold: the first write after it began, and the matching orders that arrived since (counted as they come: eviction must not change it). */
  #fence: number | null = null; #newSince = 0;

  get ring(): RingLike | null { return this.#ring; }
  get length(): number { return this.#len; }
  /** Whether older orders may still match (the backward search has not reached the ring's oldest). */
  get moreBehind(): boolean { return !!this.#ring && this.#older > this.#ring.first; }
  get held(): boolean { return this.#fence !== null; }
  /** Writes the ring took that this index has not examined yet (a list out of sight falls behind). */
  get behind(): number { return this.#ring ? Math.max(0, this.#ring.written - this.#seen) : 0; }
  /** Matching orders that arrived since the hold began. */
  get newSinceHold(): number { return this.#newSince; }

  /** The write number at position `i` (0: the oldest found). */
  at(i: number): number { return this.#buf[(this.#head + i) % this.#buf.length]!; }
  /** The newest write found, or -1. */
  get newest(): number { return this.#len ? this.at(this.#len - 1) : -1; }

  /** Whether write `k` names the same order it did when it was found: the same ring and generation, and still held. */
  valid(k: number): boolean { const r = this.#ring; return !!r && r.generation === this.#generation && k >= r.first && k < r.written; }

  /** The position of write `k`, or the position it would take (binary search: the deque is ascending). */
  position(k: number): number {
    let lo = 0, hi = this.#len;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (this.at(mid) < k) lo = mid + 1; else hi = mid; }
    return lo;
  }

  /** Start over on `ring` with `filter` (or the same filter): nothing found yet, the search starting at the newest order. */
  reset(ring: RingLike | null, filter: TradeFilter = this.#filter): void {
    this.#ring = ring; this.#filter = filter; this.#allowed = [];
    this.#generation = ring?.generation ?? -1;
    this.#head = 0; this.#len = 0;
    this.#seen = this.#older = ring?.written ?? 0;
    this.#fence = null; this.#newSince = 0;
  }

  /** Whether the record at write `k` passes the filter, read straight from the ring's floats. */
  #matches(k: number): boolean {
    const r = this.#ring!, at = (k % r.capacity) * STRIDE, usd = r.data[at + 2]!, f = this.#filter;
    if (Math.abs(usd) < f.minUsd || (f.side === 'buy' && usd < 0) || (f.side === 'sell' && usd > 0)) return false;
    const m = r.data[at + 3]!;
    let ok = this.#allowed[m];
    if (ok === undefined) ok = this.#allowed[m] = f.shown(r.ids[m] ?? '');
    return ok;
  }

  #grow(): void {
    const cap = this.#ring ? Math.max(4096, this.#ring.capacity) : 1 << 21;
    if (this.#len < this.#buf.length || this.#buf.length >= cap) return;
    const next = new Float64Array(Math.min(cap, this.#buf.length * 2));
    for (let i = 0; i < this.#len; i++) next[i] = this.at(i);
    this.#buf = next; this.#head = 0;
  }
  #pushBack(k: number): void {
    this.#grow();
    if (this.#len === this.#buf.length) { this.#head = (this.#head + 1) % this.#buf.length; this.#len--; }
    this.#buf[(this.#head + this.#len) % this.#buf.length] = k; this.#len++;
  }
  #pushFront(k: number): boolean {
    this.#grow();
    if (this.#len === this.#buf.length) return false;
    this.#head = (this.#head - 1 + this.#buf.length) % this.#buf.length; this.#buf[this.#head] = k; this.#len++;
    return true;
  }
  #evictBefore(first: number): void { while (this.#len && this.at(0) < first) { this.#head = (this.#head + 1) % this.#buf.length; this.#len--; } }

  /**
   * Take what the ring gained since the last call (a batch, or several while the list was out of sight): the new matching writes at the end,
   * the ones the ring wrapped past dropped from the start, the hold's count advanced. A cleared ring (another generation) starts over.
   * Returns how many writes were added.
   */
  update(): number {
    const r = this.#ring;
    if (!r) return 0;
    if (r.generation !== this.#generation) { this.reset(r); return 0; }
    const first = r.first, end = r.written;
    this.#evictBefore(first);
    let added = 0;
    for (let k = Math.max(this.#seen, first); k < end; k++) {
      if (!this.#matches(k)) continue;
      this.#pushBack(k); added++;
      if (this.#fence !== null && k >= this.#fence) this.#newSince++;
    }
    this.#seen = end;
    this.#older = Math.max(this.#older, first);
    return added;
  }

  /**
   * Search backwards for older matches until `want` are found or `budget` records were examined (whichever first): the cursor moves for
   * every record examined, matching or not, so the next call goes on from there. Returns how many were found.
   */
  scanBack(want: number, budget = SCAN_STEP): number {
    const r = this.#ring;
    if (!r || r.generation !== this.#generation) return 0;
    const first = r.first;
    let found = 0, k = Math.max(this.#older, first);
    for (let examined = 0; k > first && found < want && examined < budget; examined++) {
      k--;
      if (this.#matches(k)) { if (!this.#pushFront(k)) { k++; break; } found++; }
    }
    this.#older = k;
    return found;
  }

  /** Hold the list: count the matching orders that arrive from now. */
  hold(): void { if (this.#fence !== null) return; this.#fence = this.#ring?.written ?? 0; this.#newSince = 0; }
  release(): void { this.#fence = null; this.#newSince = 0; }

  /** The reasons of the boundaries between an older write `a` and a newer write `b` (a < before <= b): orders may be missing between the two rows. */
  boundariesBetween(a: number, b: number): number {
    const list = this.#ring?.boundaries ?? [];
    let reasons = 0;
    // Few boundaries are held (one a reconnect or a trim): a scan from the end, stopping once they fall before `a`.
    for (let i = list.length - 1; i >= 0; i--) { const x = list[i]!; if (x.before <= a) break; if (x.before <= b) reasons |= x.reasons; }
    return reasons;
  }
}
