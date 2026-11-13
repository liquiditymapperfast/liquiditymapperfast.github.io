import type { TapeBatch } from '../../shared/tape.ts';

/**
 * The trade dust's memory: every market order the source sent since the page opened (or since the ring last wrapped), held in one
 * fixed-size typed array laid out as the graphics card reads it, so a batch is copied in once and handed to the card as the same bytes.
 * Nothing is ever written to storage: a reload starts empty, and when the ring is full the oldest orders go.
 *
 * A record is `STRIDE` floats: time (ms after `t0`), price (after `p0`), signed USD (a buy positive), the market's index (`ids`), and the
 * lowest and highest price the order reached (after `p0`). Times and prices are kept relative to a base because a float32 holds about seven
 * digits: an epoch millisecond or a BTC price to the cent would lose what the drawing needs. The time base moves forward (`rebase`) before
 * the offsets grow past what a float32 holds to the millisecond.
 *
 * `segments` are the stretches the dust covers without a known gap, by exchange time: one begins at the first batch, after a reconnect and
 * after a batch the source says it skipped (its `seq` jumped) or trimmed (`dropped`), so a hole in the dust is never read as a quiet market.
 */
export const STRIDE = 6;
/** Records per block of the time index (`runs`). */
export const BLOCK = 4096;
/** How far from the clock an order's time may be (`add`'s `wall`). */
export const CLOCK_REACH_MS = 6 * 3_600_000;
/** Past this offset (2^24 ms, about 4.7 hours) a float32 no longer holds every millisecond. */
const REBASE_MS = 1 << 24;

export interface TapeSegment { from: number; to: number }

/** Why orders may be missing before a write (`TapeBoundary.reasons`, a bit mask). */
export const BOUNDARY = { start: 1, reconnect: 2, skipped: 4, trimmed: 8, cleared: 16 } as const;
/**
 * A point in write order before which orders may be missing: the first write after the source's stream started or came back on another
 * connection, skipped batches (its `seq` jumped) or trimmed one (`dropped`: it kept the largest orders of a batch), or the ring was cleared.
 * Kept by write number, not by time, because exchange times overlap and run backwards across venues: a list placing a divider between two
 * orders must know whether the boundary fell between their writes.
 */
export interface TapeBoundary { before: number; reasons: number }

export class TapeRing {
  readonly data: Float32Array;
  /** Records written so far (ever); the record of write number k is at slot k % capacity. */
  written = 0;
  t0 = 0; p0 = 0;
  /** Market ids by the index stored in each record. */
  readonly ids: string[] = [];
  /** The greatest exchange time (absolute ms) of an order the ring has overwritten: nothing at or before it is whole any more, whatever order the orders came in. */
  lostThrough = -Infinity;
  readonly #index = new Map<string, number>();
  segments: TapeSegment[] = [];
  /** The last batch's `seq`, and the connection it came on (a new one starts a new segment). */
  #seq: number | null = null; #connection = -1;
  /** Bumped when the stored bytes change in a way that is not an append (a rebase, a clear), so the card's copy is redone whole. */
  epoch = 0;
  /** Arrival of each recent batch (performance.now()), with the writes it covers: the arrival accent reads these. */
  arrivals: { at: number; from: number; to: number }[] = [];
  /** The boundaries among the orders held (write numbers in [first, written]), oldest first; pruned as the ring wraps past them. */
  boundaries: TapeBoundary[] = [];
  /** Reasons seen since the last write: an empty batch can carry a skip or a trim, which belongs before the next order written. */
  #pending = 0;
  /** Bumped by `clear` only (a rebase keeps every write where it was): a list holding write numbers rebuilds when it changes. */
  generation = 0;

  /**
   * The earliest and latest exchange time (absolute ms) of each block of BLOCK write numbers, so a view's orders are found without reading
   * every record. Kept for two laps of the ring (indexed by block number modulo twice the blocks): the block being overwritten still holds
   * the oldest orders of the lap before, and their times must not be lost before the orders are.
   */
  readonly #blockLo: Float64Array; readonly #blockHi: Float64Array;

  constructor(readonly capacity: number) {
    if (capacity % BLOCK !== 0) throw new Error('capacity must be a multiple of BLOCK');
    this.data = new Float32Array(capacity * STRIDE);
    this.#blockLo = new Float64Array(2 * capacity / BLOCK).fill(Infinity); this.#blockHi = new Float64Array(2 * capacity / BLOCK).fill(-Infinity);
  }

  /**
   * The runs of write numbers [from, to) whose blocks hold any order timed in [t0, t1] (absolute ms), joined where they touch: what a view
   * needs drawn. Orders arrive roughly in time order, so a view of the last minutes is a run at the end.
   */
  runs(t0: number, t1: number): [number, number][] {
    const out: [number, number][] = [];
    for (let k = this.first - (this.first % BLOCK); k < this.written; k += BLOCK) {
      const b = (k / BLOCK) % this.#blockLo.length;
      if (this.#blockHi[b]! < t0 || this.#blockLo[b]! > t1) continue;
      const from = Math.max(k, this.first), to = Math.min(k + BLOCK, this.written), last = out[out.length - 1];
      if (last && last[1] === from) last[1] = to; else out.push([from, to]);
    }
    return out;
  }

  get size(): number { return Math.min(this.written, this.capacity); }
  /** The write number of the oldest record still held. */
  get first(): number { return Math.max(0, this.written - this.capacity); }
  /** The exchange time from which the ring holds every order it was sent (the oldest held, once it has wrapped). */
  get heldFrom(): number { return this.written > this.capacity ? this.t0 + this.data[(this.written % this.capacity) * STRIDE]! : (this.segments[0]?.from ?? 0); }

  /**
   * Take a batch: `connection` is the live connection's number (a new one is a gap), `arrived` the page's clock for the accent. With `wall`
   * (the clock, ms), an order timed more than `CLOCK_REACH_MS` from it is left out: one bad stamp would otherwise move the time base and
   * rewrite the whole ring on every batch.
   */
  add(batch: TapeBatch, connection: number, arrived: number, wall?: number): void {
    const rows: number[] = [];
    for (let i = 0; i < batch.inst.length; i++) if (wall === undefined || Math.abs(batch.t[i]! - wall) <= CLOCK_REACH_MS) rows.push(i);
    const n = rows.length;
    // Why orders may be missing before this batch, read before an empty batch returns (its skip or trim belongs before the next order). A
    // new connection starts its own `seq`: it is a start or a reconnect, never also a skip.
    if (connection !== this.#connection) this.#pending |= this.#connection === -1 ? BOUNDARY.start : BOUNDARY.reconnect;
    else if (this.#seq !== null && batch.seq !== this.#seq + 1) this.#pending |= BOUNDARY.skipped;
    if (batch.dropped > 0) this.#pending |= BOUNDARY.trimmed;
    this.#seq = batch.seq; this.#connection = connection;
    if (!n) return;
    if (this.written === 0 && n) { this.t0 = batch.t[rows[0]!]!; this.p0 = batch.price[rows[0]!]!; }
    let lo = Infinity, hi = -Infinity;
    for (const i of rows) { const t = batch.t[i]!; if (t < lo) lo = t; if (t > hi) hi = t; }
    if (hi - this.t0 >= REBASE_MS) this.#rebase(lo);
    const local = Int32Array.from(batch.ids, id => { let k = this.#index.get(id); if (k === undefined) { k = this.ids.length; this.ids.push(id); this.#index.set(id, k); } return k; });
    const from = this.written;
    // A gap: a new connection, or a batch the source skipped or trimmed (this one or an empty one before it). The new segment starts at this batch's oldest order.
    const gap = this.#pending !== 0;
    if (this.#pending) { this.boundaries.push({ before: from, reasons: this.#pending }); this.#pending = 0; }
    for (const i of rows) {
      const at = (this.written % this.capacity) * STRIDE, d = this.data, p = batch.price[i]!;
      if (this.written >= this.capacity) { const lost = this.t0 + d[at]!; if (lost > this.lostThrough) this.lostThrough = lost; }
      d[at] = batch.t[i]! - this.t0; d[at + 1] = p - this.p0; d[at + 2] = batch.usd[i]!; d[at + 3] = local[batch.inst[i]!]!;
      d[at + 4] = batch.lo[i]! - this.p0; d[at + 5] = batch.hi[i]! - this.p0;
      // A block's first write starts its time range (its entry last served the block two laps ago, long overwritten).
      const b = Math.floor(this.written / BLOCK) % this.#blockLo.length, t = batch.t[i]!;
      if (this.written % BLOCK === 0) { this.#blockLo[b] = t; this.#blockHi[b] = t; } else { if (t < this.#blockLo[b]!) this.#blockLo[b] = t; if (t > this.#blockHi[b]!) this.#blockHi[b] = t; }
      this.written++;
    }
    const last = this.segments[this.segments.length - 1];
    if (!last || gap) this.segments.push({ from: lo, to: hi });
    else { last.to = Math.max(last.to, hi); last.from = Math.min(last.from, lo); }
    if (this.segments.length > 64) this.segments.splice(0, this.segments.length - 64);
    // The boundaries behind the oldest order held went with the orders before them.
    const first = this.first;
    let stale = 0;
    while (stale < this.boundaries.length && this.boundaries[stale]!.before < first) stale++;
    if (stale) this.boundaries.splice(0, stale);
    this.arrivals.push({ at: arrived, from, to: this.written });
    if (this.arrivals.length > 16) this.arrivals.splice(0, this.arrivals.length - 16);
  }

  /** Move the time base to `t` (every held offset with it), before the offsets outgrow a float32's millisecond. */
  #rebase(t: number): void {
    const shift = t - this.t0, d = this.data;
    for (let k = this.first; k < this.written; k++) d[(k % this.capacity) * STRIDE] = d[(k % this.capacity) * STRIDE]! - shift;
    this.t0 = t; this.epoch++;
  }

  /** Let go of everything (another coin's prices must never be drawn on this one's). */
  clear(): void {
    this.lostThrough = -Infinity; this.#blockLo.fill(Infinity); this.#blockHi.fill(-Infinity); this.written = 0; this.segments = []; this.arrivals = [];
    this.#seq = null; this.#connection = -1; this.ids.length = 0; this.#index.clear(); this.epoch++;
    this.boundaries = []; this.#pending = BOUNDARY.cleared; this.generation++;
  }


  /** The record at write number `k`: absolute time, price, signed USD, market id, lowest and highest price. */
  at(k: number): { t: number; price: number; usd: number; id: string; lo: number; hi: number } {
    const at = (k % this.capacity) * STRIDE, d = this.data;
    return { t: this.t0 + d[at]!, price: this.p0 + d[at + 1]!, usd: d[at + 2]!, id: this.ids[d[at + 3]!] ?? '', lo: this.p0 + d[at + 4]!, hi: this.p0 + d[at + 5]! };
  }
}

/** The ring's size: about 92 minutes of a quiet hour's orders on a desktop, a quarter of that on a phone (6 floats each: 48 or 12 MiB). */
export const tapeCapacity = (phone: boolean): number => phone ? 1 << 19 : 1 << 21;
