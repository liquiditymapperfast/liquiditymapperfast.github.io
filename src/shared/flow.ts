import type { TradeLike } from './footprint.ts';

/**
 * Taker flow at one-second resolution: how many USD were bought and sold at market, per instrument, per second.
 * Two halves share this file because they share the layout:
 *
 *  - `FlowRecorder` sits next to the footprint recorder (server or browser worker), turns trades into per-second sums, keeps whole
 *    minutes and writes them to a store, and says which seconds changed since the last look so the page can be told once a second;
 *  - `FlowSeries` is what the page keeps per instrument: running sums (prefix sums) of the delta and of the gross volume in a ring of
 *    36 hours, so any window's delta, volume and share are two reads, whatever the window is.
 */

export const FLOW_SEC = 1_000;
const MINUTE = 60_000;
/** How long the recorder keeps minutes in memory (the page asks for at most a day). */
export const FLOW_MEMORY_MS = 36 * 3_600_000;
/** How long a store keeps them. */
export const FLOW_STORE_MS = 7 * 24 * 3_600_000;
const SEEN_MAX = 30_000;
/** At most this many instruments are recorded (a day and a half of one is about 2 MB, so the recorder stays under ~100 MB however many markets exist). */
const MAX_INSTRUMENTS = 48;
/** The page's ring: 2^17 seconds, a little over 36 hours. */
export const FLOW_RING = 1 << 17;
const MASK = FLOW_RING - 1;

/** One recorded minute of one instrument: USD bought at market and sold at market in each of its 60 seconds. */
export interface FlowMinuteRow { inst: string; t: number; buy: Float32Array; sell: Float32Array }
/** Where recorded minutes outlive the process (SQLite on the server, IndexedDB in the browser); loading is synchronous, saving may be queued. */
export interface FlowStore {
  load(since: number): Iterable<FlowMinuteRow>;
  save(rows: FlowMinuteRow[], expireBefore: number): void;
  close(): void;
}
/** One second's totals as they are pushed to the page: [instrument, second start (ms), buy USD, sell USD]. They replace what the page had for that second. */
export type FlowUpdate = [string, number, number, number];
/** A run of seconds of one instrument, `t0` the start (ms) of the first. */
export interface FlowSeriesFrame { id: string; t0: number; buy: Float32Array; sell: Float32Array }
export interface FlowFrame { from: number; to: number; instruments: FlowSeriesFrame[] }

/** Per-instrument, per-second taker buy and sell USD. */
export class FlowRecorder {
  /** inst -> minute start -> [buy of second 0..59, sell of second 0..59] */
  readonly #minutes = new Map<string, Map<number, Float64Array>>();
  readonly #seen = new Map<string, Set<string>>();
  readonly #dirty = new Set<string>();
  /** inst -> seconds (ms) changed since the last take() */
  readonly #changed = new Map<string, Set<number>>();
  readonly #store: FlowStore | null;
  readonly #memoryMs: number;
  readonly #storeMs: number;
  /** Trades dropped for being older than memory keeps, or for an instrument past the limit. */
  dropped = 0;

  constructor(store: FlowStore | null = null, protected now: () => number = Date.now, memoryMs: number = FLOW_MEMORY_MS, storeMs: number = FLOW_STORE_MS) {
    this.#store = store; this.#memoryMs = memoryMs; this.#storeMs = storeMs;
    if (store) for (const row of store.load(now() - memoryMs)) {
      if (row.buy.length !== 60 || row.sell.length !== 60) continue;
      const bins = new Float64Array(120); bins.set(row.buy, 0); bins.set(row.sell, 60);
      this.#of(row.inst).set(row.t, bins);
    }
  }

  #of(inst: string): Map<number, Float64Array> { let m = this.#minutes.get(inst); if (!m) { m = new Map(); this.#minutes.set(inst, m); } return m; }
  get instruments(): string[] { return [...this.#minutes.keys()]; }

  /** Add every trade not seen before. Returns the number accepted. */
  ingest(trades: Iterable<TradeLike>): number {
    let accepted = 0;
    const oldest = this.now() - this.#memoryMs;
    for (const trade of trades) {
      const id = String(trade.instrumentId ?? ''), key = String(trade.tradeId ?? '');
      const price = Number(trade.price), usd = Number(trade.notionalUsd ?? Number(trade.amount) * price);
      const t = Number(trade.sourceTimestamp ?? trade.receivedAt);
      const side = String(trade.side).toLowerCase();
      if (!id || !key || !(usd > 0) || !Number.isFinite(t) || (side !== 'buy' && side !== 'sell')) continue;
      let seen = this.#seen.get(id); if (!seen) { seen = new Set(); this.#seen.set(id, seen); }
      if (seen.has(key)) continue;
      if (t < oldest) { this.dropped++; continue; }
      if (!this.#minutes.has(id) && this.#minutes.size >= MAX_INSTRUMENTS) { this.dropped++; continue; }
      seen.add(key);
      if (seen.size > SEEN_MAX) { const keep = [...seen].slice(-SEEN_MAX / 3); seen.clear(); for (const k of keep) seen.add(k); }
      const minute = Math.floor(t / MINUTE) * MINUTE, second = Math.floor((t - minute) / FLOW_SEC);
      const minutes = this.#of(id);
      let bins = minutes.get(minute); if (!bins) { bins = new Float64Array(120); minutes.set(minute, bins); }
      bins[(side === 'buy' ? 0 : 60) + second]! += usd;
      this.#dirty.add(`${id}|${minute}`);
      let changed = this.#changed.get(id); if (!changed) { changed = new Set(); this.#changed.set(id, changed); }
      changed.add(minute + second * FLOW_SEC);
      accepted++;
    }
    return accepted;
  }

  /** The seconds that changed since the last call, with their totals so far (oldest first within an instrument). */
  take(): FlowUpdate[] {
    const out: FlowUpdate[] = [];
    for (const [id, seconds] of this.#changed) {
      const minutes = this.#minutes.get(id);
      for (const second of [...seconds].sort((a, b) => a - b)) {
        const minute = Math.floor(second / MINUTE) * MINUTE, bins = minutes?.get(minute); if (!bins) continue;
        const index = (second - minute) / FLOW_SEC;
        out.push([id, second, bins[index]!, bins[60 + index]!]);
      }
    }
    this.#changed.clear();
    return out;
  }

  /** Persist changed minutes older than the open one and drop what memory no longer keeps. */
  flush(): void {
    const now = this.now(), cutoff = now - this.#memoryMs, open = Math.floor(now / MINUTE) * MINUTE;
    for (const minutes of this.#minutes.values()) for (const t of minutes.keys()) if (t < cutoff) minutes.delete(t);
    const store = this.#store;
    if (!store) { for (const key of [...this.#dirty]) if (Number(key.slice(key.lastIndexOf('|') + 1)) < open) this.#dirty.delete(key); return; }
    const rows: FlowMinuteRow[] = [];
    for (const key of [...this.#dirty]) {
      const at = key.lastIndexOf('|'), id = key.slice(0, at), t = Number(key.slice(at + 1));
      if (t >= open) continue;
      const bins = this.#minutes.get(id)?.get(t);
      if (bins) rows.push({ inst: id, t, buy: Float32Array.from(bins.subarray(0, 60)), sell: Float32Array.from(bins.subarray(60, 120)) });
      this.#dirty.delete(key);
    }
    store.save(rows, now - this.#storeMs);
  }
  close(): void { this.flush(); this.#store?.close(); }

  /** The newest second's start with data for `id` (ms), or 0. */
  lastSecond(id: string): number {
    const minutes = this.#minutes.get(id); if (!minutes) return 0;
    let newest = 0; for (const t of minutes.keys()) if (t > newest) newest = t;
    if (!newest) return 0;
    const bins = minutes.get(newest)!;
    for (let i = 59; i >= 0; i--) if (bins[i]! > 0 || bins[60 + i]! > 0) return newest + i * FLOW_SEC;
    return newest;
  }

  /** Each instrument's seconds in [from, to), starting at its first recorded minute in that range (an instrument with none is left out). */
  frame(ids: readonly string[], from: number, to: number): FlowFrame {
    const start = Math.floor(from / MINUTE) * MINUTE, end = Math.ceil(to / MINUTE) * MINUTE;
    const instruments: FlowSeriesFrame[] = [];
    for (const id of ids) {
      const minutes = this.#minutes.get(id); if (!minutes) continue;
      let first = Infinity;
      for (const t of minutes.keys()) if (t >= start && t < end && t < first) first = t;
      if (!Number.isFinite(first)) continue;
      const n = (end - first) / FLOW_SEC, buy = new Float32Array(n), sell = new Float32Array(n);
      for (const [t, bins] of minutes) {
        if (t < first || t >= end) continue;
        const at = (t - first) / FLOW_SEC;
        for (let i = 0; i < 60; i++) { buy[at + i] = bins[i]!; sell[at + i] = bins[60 + i]!; }
      }
      instruments.push({ id, t0: first, buy, sell });
    }
    return { from: start, to: end, instruments };
  }

  /** What is recorded for an instrument: its first and last minute, for the page to know how far back to ask. */
  coverage(): Record<string, { first: number; last: number }> {
    const out: Record<string, { first: number; last: number }> = {};
    for (const [id, minutes] of this.#minutes) {
      let first = Infinity, last = 0;
      for (const t of minutes.keys()) { if (t < first) first = t; if (t > last) last = t; }
      if (last) out[id] = { first, last };
    }
    return out;
  }
}

/**
 * One instrument's flow on the page: running sums of delta (buy minus sell) and of gross volume (buy plus sell) per second, in a ring.
 * `cumDelta` is the CVD itself (from whenever the series starts: only differences mean anything), and a window's delta and volume are
 * a subtraction of two of its values. A second can be set again (the recorder sends the running total of the open second, and a late
 * trade changes a second already passed), which adds the difference to every later running sum: that is a few entries, not the series.
 */
export class FlowSeries {
  readonly #delta = new Float64Array(FLOW_RING);
  readonly #gross = new Float64Array(FLOW_RING);
  #first = 0; #last = -1;
  #baseDelta = 0; #baseGross = 0;
  /** Seconds that were too old to place. */
  tooOld = 0;

  /** First and last second held (whole seconds since the epoch), or null when empty. */
  get span(): { first: number; last: number } | null { return this.#last < this.#first ? null : { first: this.#first, last: this.#last }; }
  get empty(): boolean { return this.#last < this.#first; }

  clear(): void { this.#first = 0; this.#last = -1; this.#baseDelta = 0; this.#baseGross = 0; }

  /** Replace the whole series with `buy` and `sell`, one entry per second from `t0Sec`. */
  load(t0Sec: number, buy: ArrayLike<number>, sell: ArrayLike<number>): void {
    this.clear();
    const n = Math.min(buy.length, sell.length);
    if (n === 0) return;
    // Only the newest ring-full can be held; what is older still counts into the base, so the running sums stay what they would have been.
    const skip = Math.max(0, n - FLOW_RING);
    let d = 0, g = 0;
    for (let i = 0; i < n; i++) {
      const b = buy[i]!, s = sell[i]!;
      d += b - s; g += b + s;
      if (i < skip) { this.#baseDelta = d; this.#baseGross = g; } else { const at = (t0Sec + i) & MASK; this.#delta[at] = d; this.#gross[at] = g; }
    }
    this.#first = t0Sec + skip; this.#last = t0Sec + n - 1;
  }

  /** Set the totals of whole second `sec`. Returns false when the second is older than the ring holds. */
  set(sec: number, buy: number, sell: number): boolean {
    const d = buy - sell, g = buy + sell;
    if (this.empty) { this.#first = sec; this.#last = sec; this.#baseDelta = 0; this.#baseGross = 0; this.#delta[sec & MASK] = d; this.#gross[sec & MASK] = g; return true; }
    if (sec > this.#last) {
      const carryD = this.#delta[this.#last & MASK]!, carryG = this.#gross[this.#last & MASK]!;
      if (sec - this.#last >= FLOW_RING) {
        // A gap longer than the ring restarts it where the series stood, so the running sums stay continuous.
        this.#baseDelta = carryD; this.#baseGross = carryG; this.#first = sec;
      } else {
        // Forget what the new seconds will take the room of before they are written over it.
        const keep = Math.max(this.#first, sec - FLOW_RING + 1);
        if (keep > this.#first) { this.#baseDelta = this.#delta[(keep - 1) & MASK]!; this.#baseGross = this.#gross[(keep - 1) & MASK]!; this.#first = keep; }
        for (let s = this.#last + 1; s < sec; s++) { this.#delta[s & MASK] = carryD; this.#gross[s & MASK] = carryG; }
      }
      this.#delta[sec & MASK] = carryD + d; this.#gross[sec & MASK] = carryG + g;
      this.#last = sec;
      return true;
    }
    if (sec < this.#first) { this.tooOld++; return false; }
    const prevD = sec === this.#first ? this.#baseDelta : this.#delta[(sec - 1) & MASK]!, prevG = sec === this.#first ? this.#baseGross : this.#gross[(sec - 1) & MASK]!;
    const dd = d - (this.#delta[sec & MASK]! - prevD), dg = g - (this.#gross[sec & MASK]! - prevG);
    if (dd === 0 && dg === 0) return true;
    for (let s = sec; s <= this.#last; s++) { this.#delta[s & MASK]! += dd; this.#gross[s & MASK]! += dg; }
    return true;
  }

  /** Running delta at the end of second `sec` (the series' start for an earlier one, its newest for a later one). */
  cumDelta(sec: number): number { return this.#cum(this.#delta, this.#baseDelta, sec); }
  cumGross(sec: number): number { return this.#cum(this.#gross, this.#baseGross, sec); }
  #cum(ring: Float64Array, base: number, sec: number): number {
    if (this.empty) return 0;
    if (sec < this.#first) return base;
    return ring[Math.min(sec, this.#last) & MASK]!;
  }

  /** Buy minus sell over whole seconds [from, to], both included. */
  delta(from: number, to: number): number { return to < from ? 0 : this.cumDelta(to) - this.cumDelta(from - 1); }
  /** Buy plus sell over whole seconds [from, to]. */
  gross(from: number, to: number): number { return to < from ? 0 : this.cumGross(to) - this.cumGross(from - 1); }
  buy(from: number, to: number): number { return (this.gross(from, to) + this.delta(from, to)) / 2; }
  sell(from: number, to: number): number { return (this.gross(from, to) - this.delta(from, to)) / 2; }

  /**
   * The running delta for a plot: for each of `columns` equal slices of seconds [from, to), the lowest, the highest and the last value of
   * the running delta inside it (NaN where the series holds nothing yet), written to `out` as [min, max, last] triples. This is the pure
   * reference of the kernel in `crates/hlm-kernels`; the two must agree to the last bit.
   */
  decimate(from: number, to: number, columns: number, out: Float64Array): void {
    const span = to - from;
    for (let c = 0; c < columns; c++) {
      const a = from + Math.floor(span * c / columns), b = Math.max(a + 1, from + Math.floor(span * (c + 1) / columns));
      const o = c * 3;
      if (this.empty || b - 1 < this.#first) { out[o] = NaN; out[o + 1] = NaN; out[o + 2] = NaN; continue; }
      let lo = Infinity, hi = -Infinity, last = NaN;
      for (let s = a; s < b; s++) {
        if (s < this.#first) continue;
        const v = this.#delta[Math.min(s, this.#last) & MASK]!;
        if (v < lo) lo = v; if (v > hi) hi = v; last = v;
        if (s >= this.#last) break;
      }
      if (last !== last) { out[o] = NaN; out[o + 1] = NaN; out[o + 2] = NaN; } else { out[o] = lo; out[o + 1] = hi; out[o + 2] = last; }
    }
  }
}

// ---- On the wire ------------------------------------------------------------------------------------------------------------------------

/**
 * A frame as bytes, for the server's answer: a u32 header length, the header as JSON padded to a multiple of 4 bytes, then each
 * instrument's buy and sell seconds as Float32 (little endian), in the header's order.
 */
export function encodeFlowFrame(frame: FlowFrame): Uint8Array {
  const head = new TextEncoder().encode(JSON.stringify({ from: frame.from, to: frame.to, instruments: frame.instruments.map(i => ({ id: i.id, t0: i.t0, n: i.buy.length })) }));
  const pad = (4 - (4 + head.length) % 4) % 4, body = frame.instruments.reduce((sum, i) => sum + i.buy.length * 8, 0);
  const out = new Uint8Array(4 + head.length + pad + body), view = new DataView(out.buffer);
  view.setUint32(0, head.length, true); out.set(head, 4);
  let at = 4 + head.length + pad;
  for (const i of frame.instruments) {
    for (const array of [i.buy, i.sell]) { out.set(new Uint8Array(array.buffer, array.byteOffset, array.byteLength), at); at += array.byteLength; }
  }
  return out;
}

/** The inverse of `encodeFlowFrame`; a frame that does not add up (a cut-off answer) is an error. */
export function decodeFlowFrame(input: ArrayBuffer | Uint8Array): FlowFrame {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  // Float32 views need 4-byte alignment: a view that starts elsewhere is copied once.
  const buffer = bytes.byteOffset % 4 === 0 ? bytes.buffer as ArrayBuffer : bytes.slice().buffer as ArrayBuffer, base = bytes.byteOffset % 4 === 0 ? bytes.byteOffset : 0;
  if (bytes.byteLength < 4) throw new Error('flow frame is too short');
  const view = new DataView(buffer, base, bytes.byteLength), headLength = view.getUint32(0, true);
  if (4 + headLength > bytes.byteLength) throw new Error('flow frame header is cut off');
  const header = JSON.parse(new TextDecoder().decode(new Uint8Array(buffer, base + 4, headLength))) as { from: number; to: number; instruments: { id: string; t0: number; n: number }[] };
  let at = base + 4 + headLength + (4 - (4 + headLength) % 4) % 4;
  const instruments: FlowSeriesFrame[] = [];
  for (const { id, t0, n } of header.instruments) {
    if (!Number.isInteger(n) || n < 0 || at + n * 8 > base + bytes.byteLength) throw new Error('flow frame data is cut off');
    instruments.push({ id, t0, buy: new Float32Array(buffer, at, n), sell: new Float32Array(buffer, at + n * 4, n) });
    at += n * 8;
  }
  return { from: header.from, to: header.to, instruments };
}
