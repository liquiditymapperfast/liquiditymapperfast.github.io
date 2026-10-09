import type { TradeLike } from './footprint.ts';

/**
 * Taker flow at one-second resolution: how many USD were bought and sold at market, per instrument, per second, and the volume-weighted
 * price the trades of that second were done at (the same trades, so the price strip and the flow lines share every second).
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
/** How far back (seconds) a price is read from a second in which nothing traded. */
const PRICE_REACH = 7_200;

/**
 * One recorded minute of one instrument: USD bought at market and sold at market in each of its 60 seconds, and the volume-weighted price of
 * each second (0 where nothing traded). `px` is absent in minutes recorded before prices were kept.
 */
export interface FlowMinuteRow { inst: string; t: number; buy: Float32Array; sell: Float32Array; px?: Float32Array }
/** Where recorded minutes outlive the process (SQLite on the server, IndexedDB in the browser); loading is synchronous, saving may be queued. */
export interface FlowStore {
  load(since: number): Iterable<FlowMinuteRow>;
  save(rows: FlowMinuteRow[], expireBefore: number): void;
  close(): void;
  /** One instrument's stored minutes in [from, to), for what memory no longer holds (a store that cannot read a range has only what memory has). */
  range?(inst: string, from: number, to: number): Iterable<FlowMinuteRow>;
}
/**
 * One instrument's flow a minute at a time, for windows older than the seconds the page holds: per minute from `t0` (ms), the USD bought
 * and sold at market, the last traded price (0: none), and the lowest and highest the running delta reached at the end of its seconds,
 * counted from where it stood when the minute began (0 for a minute with nothing recorded).
 */
export interface FlowMinutesSeries { id: string; t0: number; buy: Float32Array; sell: Float32Array; px: Float32Array; lo: Float32Array; hi: Float32Array }
export interface FlowMinutesFrame { from: number; to: number; instruments: FlowMinutesSeries[] }

/** A minute's totals from its 60 seconds of buys and sells and their prices (`priceAt(i)`, 0 where none). */
function summarise(buy: ArrayLike<number>, sell: ArrayLike<number>, priceAt: (i: number) => number): [number, number, number, number, number] {
  let b = 0, s = 0, d = 0, lo = Infinity, hi = -Infinity, px = 0;
  for (let i = 0; i < 60; i++) {
    b += buy[i]!; s += sell[i]!; d += buy[i]! - sell[i]!;
    if (d < lo) lo = d; if (d > hi) hi = d;
    const p = priceAt(i); if (p > 0) px = p;
  }
  return [b, s, px, lo, hi];
}
/** One second's totals as they are pushed to the page: [instrument, second start (ms), buy USD, sell USD, volume-weighted price (0 or absent: no trade)]. They replace what the page had for that second. */
export type FlowUpdate = [string, number, number, number, number?];
/** A run of seconds of one instrument, `t0` the start (ms) of the first; `px` is the price of each second (0: none), absent from a source that keeps none. */
export interface FlowSeriesFrame { id: string; t0: number; buy: Float32Array; sell: Float32Array; px?: Float32Array }
export interface FlowFrame { from: number; to: number; instruments: FlowSeriesFrame[] }

/**
 * A minute's bins: USD bought in each of its 60 seconds, USD sold, and the base quantity traded. A minute that holds USD with no known
 * price (restored from a store that kept none, or a trade that came without one) has 60 more: that USD, which stays out of the price.
 */
const BINS = 180, BINS_WITH_UNPRICED = 240;

/** The volume-weighted price of second `index` of a minute's bins: its priced USD over its base quantity, or 0 when nothing with a price traded in it. */
function priceOf(bins: Float64Array, index: number): number {
  const qty = bins[120 + index]!;
  if (!(qty > 0)) return 0;
  const priced = bins[index]! + bins[60 + index]! - (bins.length > BINS ? bins[BINS + index]! : 0);
  return priced > 0 ? priced / qty : 0;
}

/** Per-instrument, per-second taker buy and sell USD, and the volume-weighted price of each second. */
export class FlowRecorder {
  /** inst -> minute start -> [buy of second 0..59, sell of second 0..59, base quantity of second 0..59] (a second's price is its USD over its quantity) */
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
      const priced = row.px?.length === 60, bins = new Float64Array(priced ? BINS : BINS_WITH_UNPRICED); bins.set(row.buy, 0); bins.set(row.sell, 60);
      // The quantity is what the price is worked back from, so a trade that arrives late for a minute read from the store still averages in.
      if (priced) for (let i = 0; i < 60; i++) { const p = row.px![i]!; if (p > 0) bins[120 + i] = (bins[i]! + bins[60 + i]!) / p; }
      // A minute recorded before prices were kept has none to work back from: all of its USD is unpriced, so a late trade's price is its own, not a blend with that.
      else for (let i = 0; i < 60; i++) bins[BINS + i] = bins[i]! + bins[60 + i]!;
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
      let bins = minutes.get(minute); if (!bins) { bins = new Float64Array(BINS); minutes.set(minute, bins); }
      if (!(price > 0) && bins.length === BINS) { const wider = new Float64Array(BINS_WITH_UNPRICED); wider.set(bins); minutes.set(minute, wider); bins = wider; }
      bins[(side === 'buy' ? 0 : 60) + second]! += usd;
      if (price > 0) bins[120 + second]! += usd / price; else bins[BINS + second]! += usd;
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
        out.push([id, second, bins[index]!, bins[60 + index]!, priceOf(bins, index)]);
      }
    }
    this.#changed.clear();
    return out;
  }

  /**
   * Persist changed minutes older than the open one and drop what memory no longer keeps. With `final` (the process or the page is going
   * away) the open minute is written too, as far as it has got: a restart reads it back and carries on adding to it. It stays marked as
   * changed, so if the recorder goes on, the next flush after the minute has ended writes it again, whole. A minute leaves the changed set
   * only once the store has taken it, so a store that failed is tried again.
   */
  flush(final = false): void {
    const now = this.now(), cutoff = now - this.#memoryMs, open = Math.floor(now / MINUTE) * MINUTE;
    for (const minutes of this.#minutes.values()) for (const t of minutes.keys()) if (t < cutoff) minutes.delete(t);
    const store = this.#store, rows: FlowMinuteRow[] = [], settled: string[] = [];
    for (const key of [...this.#dirty]) {
      const at = key.lastIndexOf('|'), id = key.slice(0, at), t = Number(key.slice(at + 1));
      if (t >= open && !(final && store)) continue;
      const bins = this.#minutes.get(id)?.get(t);
      if (bins && store) rows.push({ inst: id, t, buy: Float32Array.from(bins.subarray(0, 60)), sell: Float32Array.from(bins.subarray(60, 120)), px: Float32Array.from({ length: 60 }, (_, i) => priceOf(bins, i)) });
      if (t < open) settled.push(key);
    }
    store?.save(rows, now - this.#storeMs);
    for (const key of settled) this.#dirty.delete(key);
  }
  close(): void { this.flush(true); this.#store?.close(); }

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
      const n = (end - first) / FLOW_SEC, buy = new Float32Array(n), sell = new Float32Array(n), px = new Float32Array(n);
      for (const [t, bins] of minutes) {
        if (t < first || t >= end) continue;
        const at = (t - first) / FLOW_SEC;
        for (let i = 0; i < 60; i++) { buy[at + i] = bins[i]!; sell[at + i] = bins[60 + i]!; px[at + i] = priceOf(bins, i); }
      }
      instruments.push({ id, t0: first, buy, sell, px });
    }
    return { from: start, to: end, instruments };
  }

  /**
   * Each instrument's minutes in [from, to) as minute totals (see FlowMinutesSeries), starting at its first recorded minute there; an
   * instrument with none is left out. Memory answers what it holds, the store what is older (both are the same seconds, so a minute reads
   * the same from either).
   */
  minutes(ids: readonly string[], from: number, to: number): FlowMinutesFrame {
    const start = Math.floor(from / MINUTE) * MINUTE, end = Math.ceil(to / MINUTE) * MINUTE;
    const instruments: FlowMinutesSeries[] = [];
    for (const id of ids) {
      const found = new Map<number, [number, number, number, number, number]>(), memory = this.#minutes.get(id);
      let held = end;
      if (memory) for (const t of memory.keys()) if (t < held) held = t;
      if (this.#store?.range && start < held) for (const row of this.#store.range(id, start, Math.min(end, held))) {
        if (row.buy.length === 60 && row.sell.length === 60) found.set(row.t, summarise(row.buy, row.sell, i => row.px?.[i] ?? 0));
      }
      if (memory) for (const [t, bins] of memory) if (t >= start && t < end) found.set(t, summarise(bins.subarray(0, 60), bins.subarray(60, 120), i => priceOf(bins, i)));
      if (!found.size) continue;
      let first = Infinity; for (const t of found.keys()) if (t < first) first = t;
      const n = (end - first) / MINUTE, series: FlowMinutesSeries = { id, t0: first, buy: new Float32Array(n), sell: new Float32Array(n), px: new Float32Array(n), lo: new Float32Array(n), hi: new Float32Array(n) };
      for (const [t, [b, s, px, lo, hi]] of found) { const i = (t - first) / MINUTE; series.buy[i] = b; series.sell[i] = s; series.px[i] = px; series.lo[i] = lo; series.hi[i] = hi; }
      instruments.push(series);
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
  /** The volume-weighted price of each second, 0 where nothing traded in it (a price is read forward from the last second that has one). */
  readonly #px = new Float32Array(FLOW_RING);
  #first = 0; #last = -1;
  #baseDelta = 0; #baseGross = 0;
  /** Seconds that were too old to place. */
  tooOld = 0;

  /** First and last second held (whole seconds since the epoch), or null when empty. */
  get span(): { first: number; last: number } | null { return this.#last < this.#first ? null : { first: this.#first, last: this.#last }; }
  get empty(): boolean { return this.#last < this.#first; }

  clear(): void { this.#first = 0; this.#last = -1; this.#baseDelta = 0; this.#baseGross = 0; }

  /** Replace the whole series with `buy` and `sell` (and `px`, when there are prices), one entry per second from `t0Sec`. */
  load(t0Sec: number, buy: ArrayLike<number>, sell: ArrayLike<number>, px?: ArrayLike<number>): void {
    this.clear();
    const n = Math.min(buy.length, sell.length);
    if (n === 0) return;
    // Only the newest ring-full can be held; what is older still counts into the base, so the running sums stay what they would have been.
    const skip = Math.max(0, n - FLOW_RING);
    let d = 0, g = 0;
    for (let i = 0; i < n; i++) {
      const b = buy[i]!, s = sell[i]!;
      d += b - s; g += b + s;
      if (i < skip) { this.#baseDelta = d; this.#baseGross = g; } else { const at = (t0Sec + i) & MASK; this.#delta[at] = d; this.#gross[at] = g; this.#px[at] = px?.[i] ?? 0; }
    }
    this.#first = t0Sec + skip; this.#last = t0Sec + n - 1;
  }

  /** Set the totals (and the price, 0 for none) of whole second `sec`. Returns false when the second is older than the ring holds. */
  set(sec: number, buy: number, sell: number, px = 0): boolean {
    const d = buy - sell, g = buy + sell;
    if (this.empty) { this.#first = sec; this.#last = sec; this.#baseDelta = 0; this.#baseGross = 0; this.#delta[sec & MASK] = d; this.#gross[sec & MASK] = g; this.#px[sec & MASK] = px; return true; }
    if (sec > this.#last) {
      const carryD = this.#delta[this.#last & MASK]!, carryG = this.#gross[this.#last & MASK]!;
      if (sec - this.#last >= FLOW_RING) {
        // A gap longer than the ring restarts it where the series stood, so the running sums stay continuous.
        this.#baseDelta = carryD; this.#baseGross = carryG; this.#first = sec;
      } else {
        // Forget what the new seconds will take the room of before they are written over it.
        const keep = Math.max(this.#first, sec - FLOW_RING + 1);
        if (keep > this.#first) { this.#baseDelta = this.#delta[(keep - 1) & MASK]!; this.#baseGross = this.#gross[(keep - 1) & MASK]!; this.#first = keep; }
        for (let s = this.#last + 1; s < sec; s++) { this.#delta[s & MASK] = carryD; this.#gross[s & MASK] = carryG; this.#px[s & MASK] = 0; }
      }
      this.#delta[sec & MASK] = carryD + d; this.#gross[sec & MASK] = carryG + g; this.#px[sec & MASK] = px;
      this.#last = sec;
      return true;
    }
    if (sec < this.#first) { this.tooOld++; return false; }
    this.#px[sec & MASK] = px;
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
   * The price at the end of second `sec`: that of the last second at or before it in which something traded (read back at most two hours),
   * or NaN when there is none (before the series, or no trade with a price yet).
   */
  priceAt(sec: number): number {
    if (this.empty || sec < this.#first) return NaN;
    const stop = Math.max(this.#first, Math.min(sec, this.#last) - PRICE_REACH);
    for (let s = Math.min(sec, this.#last); s >= stop; s--) { const v = this.#px[s & MASK]!; if (v > 0) return v; }
    return NaN;
  }

  /**
   * The price for a plot: for each of `columns` equal slices of seconds [from, to), the price at the end of the slice (NaN where there is
   * none yet), in the slices `decimate` uses. One pass over the seconds, so a day is cheap.
   */
  priceColumns(from: number, to: number, columns: number, out: Float64Array): void {
    const span = to - from;
    let known = this.priceAt(from - 1), cursor = from;
    for (let c = 0; c < columns; c++) {
      const a = from + Math.floor(span * c / columns), b = Math.max(a + 1, from + Math.floor(span * (c + 1) / columns)), end = b - 1;
      if (this.empty || end < this.#first) { out[c] = NaN; cursor = Math.max(cursor, b); continue; }
      for (let s = Math.max(cursor, this.#first, a); s <= Math.min(end, this.#last); s++) { const v = this.#px[s & MASK]!; if (v > 0) known = v; }
      cursor = Math.max(cursor, b);
      out[c] = known;
    }
  }

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

/**
 * One instrument's older flow on the page, a minute at a time (see FlowMinutesSeries): the running delta and gross volume at the end of each
 * minute, and the lowest and highest the running delta reached inside it, all counted from the start of the first minute. Minutes this old
 * no longer change, so the whole answer is taken as it is.
 */
export class FlowMinutes {
  /** The first minute's start (ms), and per minute: running sums at its end, the lowest and highest the running delta reached in it, its last price. */
  readonly t0: number;
  readonly #delta: Float64Array; readonly #gross: Float64Array; readonly #lo: Float64Array; readonly #hi: Float64Array; readonly #px: Float32Array;

  constructor(s: FlowMinutesSeries) {
    const n = Math.min(s.buy.length, s.sell.length, s.px.length, s.lo.length, s.hi.length);
    this.t0 = s.t0; this.#delta = new Float64Array(n); this.#gross = new Float64Array(n); this.#lo = new Float64Array(n); this.#hi = new Float64Array(n); this.#px = s.px.slice(0, n);
    let d = 0, g = 0;
    for (let i = 0; i < n; i++) { this.#lo[i] = d + s.lo[i]!; this.#hi[i] = d + s.hi[i]!; d += s.buy[i]! - s.sell[i]!; g += s.buy[i]! + s.sell[i]!; this.#delta[i] = d; this.#gross[i] = g; }
  }

  get length(): number { return this.#delta.length; }
  /** Where the minutes end (ms): the start of the minute after the last. */
  get end(): number { return this.t0 + this.length * MINUTE; }
  /** The minute that second `sec` falls in (may be outside the minutes held). */
  indexOf(sec: number): number { return Math.floor((sec * 1000 - this.t0) / MINUTE); }
  /** Running sums at the end of minute `i`, before the first minute 0; past the last, the last. */
  deltaAt(i: number): number { return i < 0 ? 0 : this.#delta[Math.min(i, this.length - 1)]!; }
  grossAt(i: number): number { return i < 0 ? 0 : this.#gross[Math.min(i, this.length - 1)]!; }
  /** The lowest and highest the running delta reached inside minute `i` (held inside the minutes). */
  lowAt(i: number): number { return this.#lo[i]!; }
  highAt(i: number): number { return this.#hi[i]!; }
  /** The last price at or before the end of minute `i`, read back at most two hours, or NaN. */
  priceAt(i: number): number {
    for (let k = Math.min(i, this.length - 1), stop = Math.max(0, k - PRICE_REACH / 60); k >= stop; k--) { const v = this.#px[k]!; if (v > 0) return v; }
    return NaN;
  }
}

// ---- On the wire ------------------------------------------------------------------------------------------------------------------------

/** Minute totals as bytes, laid out as a flow frame is: a u32 header length, the header as JSON padded to 4 bytes, then each instrument's five Float32 arrays. */
export function encodeFlowMinutes(frame: FlowMinutesFrame): Uint8Array {
  const head = new TextEncoder().encode(JSON.stringify({ from: frame.from, to: frame.to, instruments: frame.instruments.map(i => ({ id: i.id, t0: i.t0, n: i.buy.length })) }));
  const pad = (4 - (4 + head.length) % 4) % 4, body = frame.instruments.reduce((sum, i) => sum + i.buy.length * 20, 0);
  const out = new Uint8Array(4 + head.length + pad + body), view = new DataView(out.buffer);
  view.setUint32(0, head.length, true); out.set(head, 4);
  let at = 4 + head.length + pad;
  for (const i of frame.instruments) for (const array of [i.buy, i.sell, i.px, i.lo, i.hi]) { out.set(new Uint8Array(array.buffer, array.byteOffset, array.byteLength), at); at += array.byteLength; }
  return out;
}

/** The inverse of `encodeFlowMinutes`; an answer that does not add up (cut off, or not this kind) is an error. */
export function decodeFlowMinutes(input: ArrayBuffer | Uint8Array): FlowMinutesFrame {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  const buffer = bytes.byteOffset % 4 === 0 ? bytes.buffer as ArrayBuffer : bytes.slice().buffer as ArrayBuffer, base = bytes.byteOffset % 4 === 0 ? bytes.byteOffset : 0;
  if (bytes.byteLength < 4) throw new Error('flow minutes are too short');
  const view = new DataView(buffer, base, bytes.byteLength), headLength = view.getUint32(0, true);
  if (4 + headLength > bytes.byteLength) throw new Error('flow minutes header is cut off');
  const header = JSON.parse(new TextDecoder().decode(new Uint8Array(buffer, base + 4, headLength))) as { from?: unknown; to?: unknown; instruments?: { id: string; t0: number; n: number }[] };
  if (typeof header.from !== 'number' || typeof header.to !== 'number' || !Array.isArray(header.instruments)) throw new Error('flow minutes header is not one');
  let at = base + 4 + headLength + (4 - (4 + headLength) % 4) % 4;
  const instruments: FlowMinutesSeries[] = [];
  for (const { id, t0, n } of header.instruments) {
    if (typeof id !== 'string' || !Number.isFinite(t0) || !Number.isInteger(n) || n < 0 || at + n * 20 > base + bytes.byteLength) throw new Error('flow minutes data is cut off');
    const part = (k: number): Float32Array => new Float32Array(buffer, at + n * 4 * k, n);
    instruments.push({ id, t0, buy: part(0), sell: part(1), px: part(2), lo: part(3), hi: part(4) });
    at += n * 20;
  }
  return { from: header.from, to: header.to, instruments };
}

/**
 * A frame as bytes, for the server's answer: a u32 header length, the header as JSON padded to a multiple of 4 bytes, then each
 * instrument's buy and sell seconds as Float32 (little endian), and its price seconds when the header says `px`, in the header's order.
 */
export function encodeFlowFrame(frame: FlowFrame): Uint8Array {
  const head = new TextEncoder().encode(JSON.stringify({ from: frame.from, to: frame.to, instruments: frame.instruments.map(i => ({ id: i.id, t0: i.t0, n: i.buy.length, ...(i.px ? { px: 1 } : {}) })) }));
  const pad = (4 - (4 + head.length) % 4) % 4, body = frame.instruments.reduce((sum, i) => sum + i.buy.length * (i.px ? 12 : 8), 0);
  const out = new Uint8Array(4 + head.length + pad + body), view = new DataView(out.buffer);
  view.setUint32(0, head.length, true); out.set(head, 4);
  let at = 4 + head.length + pad;
  for (const i of frame.instruments) {
    for (const array of i.px ? [i.buy, i.sell, i.px] : [i.buy, i.sell]) { out.set(new Uint8Array(array.buffer, array.byteOffset, array.byteLength), at); at += array.byteLength; }
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
  const header = JSON.parse(new TextDecoder().decode(new Uint8Array(buffer, base + 4, headLength))) as { from: number; to: number; instruments: { id: string; t0: number; n: number; px?: number }[] };
  let at = base + 4 + headLength + (4 - (4 + headLength) % 4) % 4;
  const instruments: FlowSeriesFrame[] = [];
  for (const { id, t0, n, px } of header.instruments) {
    const arrays = px ? 3 : 2;
    if (!Number.isInteger(n) || n < 0 || at + n * 4 * arrays > base + bytes.byteLength) throw new Error('flow frame data is cut off');
    instruments.push({ id, t0, buy: new Float32Array(buffer, at, n), sell: new Float32Array(buffer, at + n * 4, n), ...(px ? { px: new Float32Array(buffer, at + n * 8, n) } : {}) });
    at += n * 4 * arrays;
  }
  return { from: header.from, to: header.to, instruments };
}
