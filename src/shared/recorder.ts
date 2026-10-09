import type { ValuedBook, SideLevels } from './levels.ts';
import { gridStepFor } from './grid.ts';

export const COLUMN_MS = 60_000;
export const SAMPLE_MS = 5_000;
/** Books older than this at sample time are treated as unobserved (a gap), never carried forward. */
export const STALE_MS = 45_000;
export const RETENTION_MS = 7 * 24 * 3_600_000;
/** A browser keeps a day of recordings: the page is not a server, and a week of columns would not fit comfortably in memory. */
export const BROWSER_RETENTION_MS = 24 * 3_600_000;
/** Columns a failing store has not taken that are kept for another try; past this a dead store costs no more memory. */
const UNSAVED_MAX = 5_000;

/** One minute of one instrument on the shared price grid: mean USD per bin over observed samples. */
export interface Column {
  t: number;
  /** Observed samples contributing, 1..COLUMN_MS/SAMPLE_MS. */
  n: number;
  bins: Int32Array;
  bid: Float32Array;
  ask: Float32Array;
}
export interface ColumnStore {
  load(sinceMs: number): Iterable<{ instrumentId: string; column: Column; step: number }>;
  save(instrumentId: string, column: Column, step: number): void;
  prune(beforeMs: number): void;
}
interface Pending { t: number; n: number; step: number; bid: Map<number, number>; ask: Map<number, number> }

export { gridStepFor } from './grid.ts';

/** Spread each level's USD across the grid bins its price band overlaps, proportionally to overlap. */
export function accumulateSide(side: SideLevels, step: number, into: Map<number, number>): void {
  for (let i = 0; i < side.usd.length; i++) {
    const lo = side.lo[i]!, hi = side.hi[i]!, usd = side.usd[i]!;
    if (!(usd > 0)) continue;
    const first = Math.floor(lo / step);
    if (!(hi > lo)) { into.set(first, (into.get(first) ?? 0) + usd); continue; }
    const last = Math.ceil(hi / step) - 1;
    if (last <= first) { into.set(first, (into.get(first) ?? 0) + usd); continue; }
    const width = hi - lo;
    for (let bin = first; bin <= last; bin++) {
      const overlap = Math.min(hi, (bin + 1) * step) - Math.max(lo, bin * step);
      if (overlap > 0) into.set(bin, (into.get(bin) ?? 0) + usd * overlap / width);
    }
  }
}

/**
 * A bin with less than this many USD (bid + ask, averaged over the minute) is not recorded once a column has more than KEEP_ALWAYS bins.
 * Such bins sit below anything the map can show (its colour window starts at tens of thousands of USD) and, merged out to +-50 % of the
 * mark, they were most of what was stored: two thirds of Bitunix's and Binance spot's levels at $5k, five sixths of Phemex's.
 */
export const MIN_BIN_USD = 10_000;
export const KEEP_ALWAYS = 300;

function finalize(pending: Pick<Pending, 't' | 'n' | 'bid' | 'ask'>, minBinUsd: number = MIN_BIN_USD): Column {
  const keys = new Set<number>([...pending.bid.keys(), ...pending.ask.keys()]);
  const bins = Int32Array.from([...keys].sort((a, b) => a - b));
  return finish(pending.t, pending.n, bins, Float64Array.from(bins, bin => pending.bid.get(bin) ?? 0), Float64Array.from(bins, bin => pending.ask.get(bin) ?? 0), minBinUsd);
}

/** A column from the USD summed over `n` samples in each of `bins` (ascending): the mean per bin, the smallest bins left out of a large column. */
function finish(t: number, n: number, sortedBins: Int32Array, bidSum: Float64Array, askSum: Float64Array, minBinUsd: number): Column {
  const count = sortedBins.length, bid = new Float32Array(count), ask = new Float32Array(count);
  for (let i = 0; i < count; i++) { bid[i] = bidSum[i]! / n; ask[i] = askSum[i]! / n; }
  if (count <= KEEP_ALWAYS) return { t, n, bins: sortedBins, bid, ask };
  // The bins at or above the floor; when fewer than KEEP_ALWAYS are, the KEEP_ALWAYS largest, the lower price first among equals.
  const keep = new Uint8Array(count);
  let kept = 0;
  for (let i = 0; i < count; i++) if (bid[i]! + ask[i]! >= minBinUsd) { keep[i] = 1; kept++; }
  if (kept < KEEP_ALWAYS) {
    const totals = new Float64Array(count);
    for (let i = 0; i < count; i++) totals[i] = bid[i]! + ask[i]!;
    const edge = Float64Array.from(totals).sort()[count - KEEP_ALWAYS]!;
    keep.fill(0); kept = 0;
    for (let i = 0; i < count; i++) if (totals[i]! > edge) { keep[i] = 1; kept++; }
    for (let i = 0; i < count && kept < KEEP_ALWAYS; i++) if (totals[i] === edge) { keep[i] = 1; kept++; }
  }
  const bins = new Int32Array(kept), keptBid = new Float32Array(kept), keptAsk = new Float32Array(kept);
  for (let i = 0, j = 0; i < count; i++) if (keep[i]) { bins[j] = sortedBins[i]!; keptBid[j] = bid[i]!; keptAsk[j] = ask[i]!; j++; }
  return { t, n, bins, bid: keptBid, ask: keptAsk };
}

/** The widest span of bins one window is merged over in flat arrays (the books reach half the price either way, a few thousand bins). */
const DENSE_BINS = 1 << 20;
/** Flat sums by bin offset, and the window that last wrote each offset (so they are never cleared): shared, since a merge runs to its end. */
let denseBid = new Float64Array(0), denseAsk = new Float64Array(0), denseSeen = new Int32Array(0), denseWindow = 0;

/**
 * Columns `[start, end)` of `columns` (one window, oldest first) as one column: each bin's USD weighted by the samples behind it. The sums are
 * made in the same order as the map they replaced (column by column, from zero), so the result is the same to the last bit, without a map
 * operation per bin.
 */
function mergeWindow(columns: readonly Column[], start: number, end: number, t: number, minBinUsd: number): Column {
  let n = 0, lo = Infinity, hi = -Infinity, total = 0;
  for (let k = start; k < end; k++) {
    const c = columns[k]!, m = c.bins.length; n += c.n; total += m;
    if (m) { lo = Math.min(lo, c.bins[0]!); hi = Math.max(hi, c.bins[m - 1]!); }
  }
  if (total === 0) return finish(t, n, new Int32Array(0), new Float64Array(0), new Float64Array(0), minBinUsd);
  const size = hi - lo + 1;
  if (size > DENSE_BINS) {
    const group = { t, n, bid: new Map<number, number>(), ask: new Map<number, number>() };
    for (let k = start; k < end; k++) {
      const c = columns[k]!;
      for (let i = 0; i < c.bins.length; i++) { const bin = c.bins[i]!; group.bid.set(bin, (group.bid.get(bin) ?? 0) + c.bid[i]! * c.n); group.ask.set(bin, (group.ask.get(bin) ?? 0) + c.ask[i]! * c.n); }
    }
    return finalize(group, minBinUsd);
  }
  if (denseSeen.length < size) { const room = Math.min(DENSE_BINS, Math.max(size, denseSeen.length * 2)); denseBid = new Float64Array(room); denseAsk = new Float64Array(room); denseSeen = new Int32Array(room); denseWindow = 0; }
  if (++denseWindow === 0x7fffffff) { denseSeen.fill(0); denseWindow = 1; }
  const window = denseWindow, touched = new Int32Array(total);
  let count = 0;
  for (let k = start; k < end; k++) {
    const c = columns[k]!, w = c.n;
    for (let i = 0; i < c.bins.length; i++) {
      const at = c.bins[i]! - lo;
      if (denseSeen[at] !== window) { denseSeen[at] = window; denseBid[at] = 0; denseAsk[at] = 0; touched[count++] = at; }
      denseBid[at]! += c.bid[i]! * w; denseAsk[at]! += c.ask[i]! * w;
    }
  }
  const offsets = touched.subarray(0, count).sort();
  const bins = new Int32Array(count), bidSum = new Float64Array(count), askSum = new Float64Array(count);
  for (let i = 0; i < count; i++) { const at = offsets[i]!; bins[i] = lo + at; bidSum[i] = denseBid[at]!; askSum[i] = denseAsk[at]!; }
  return finish(t, n, bins, bidSum, askSum, minBinUsd);
}

/** The index of the first column at or after `t` (columns oldest first). */
function firstFrom(list: readonly Column[], t: number): number {
  let lo = 0, hi = list.length;
  while (lo < hi) { const mid = (lo + hi) >>> 1; if (list[mid]!.t < t) lo = mid + 1; else hi = mid; }
  return lo;
}

/** How many bins of merged windows are kept for the next question: two days of every market at one step fit (at most about 72 MB). */
const MERGED_CACHE_BINS = 6_000_000;

export interface RecorderOptions {
  store?: ColumnStore | null;
  now?: () => number;
  /** Grid step per instrument; chosen from the first valid price and then kept for the retention window. */
  steps?: Map<string, number>;
  /** How long minutes are kept (a week by default; the browser keeps a day). */
  retentionMs?: number;
  /** The smallest bin kept once a column is large (MIN_BIN_USD; smaller for a coin that trades less than BTC). */
  minBinUsd?: number;
}

/** Records per-instrument minute columns from periodic book samples. */
export class DepthRecorder {
  readonly columns = new Map<string, Column[]>();
  readonly steps: Map<string, number>;
  readonly #pending = new Map<string, Pending>();
  /** Columns the store did not take, oldest first; they are offered again with the next one. */
  #unsaved: { id: string; column: Column; step: number }[] = [];
  /** How many times the store has refused a column, and why the last time (for a status line; the recorder itself goes on). */
  saveFailures = 0; lastSaveError = '';
  readonly #store: ColumnStore | null;
  readonly #now: () => number;
  readonly #retentionMs: number;
  readonly #minBinUsd: number;
  /** Merged windows that have ended, by instrument, step and start, least recently asked first; and how many bins they hold. */
  readonly #merged = new Map<string, Column>();
  #mergedBins = 0;

  constructor({ store = null, now = Date.now, steps = new Map(), retentionMs = RETENTION_MS, minBinUsd = MIN_BIN_USD }: RecorderOptions = {}) {
    this.#store = store; this.#now = now; this.steps = steps; this.#retentionMs = retentionMs; this.#minBinUsd = minBinUsd;
    if (store) {
      for (const { instrumentId, column, step } of store.load(now() - retentionMs)) {
        this.#list(instrumentId).push(column);
        if (!this.steps.has(instrumentId)) this.steps.set(instrumentId, step);
      }
      for (const list of this.columns.values()) list.sort((a, b) => a.t - b.t);
    }
  }

  #list(id: string): Column[] { let list = this.columns.get(id); if (!list) { list = []; this.columns.set(id, list); } return list; }

  /** Record one sample of every valued book. Stale or missing books leave the minute unobserved. */
  sample(books: Iterable<ValuedBook>, now = this.#now()): void {
    const minute = Math.floor(now / COLUMN_MS) * COLUMN_MS;
    for (const book of books) {
      if (now - book.timestamp > STALE_MS) continue;
      let step = this.steps.get(book.instrumentId);
      if (step === undefined) {
        const reference = book.bids.hi[0] ?? book.asks.lo[0];
        if (!reference) continue;
        step = gridStepFor(reference); this.steps.set(book.instrumentId, step);
      }
      let pending = this.#pending.get(book.instrumentId);
      if (pending && pending.t !== minute) { this.#commit(book.instrumentId, pending); pending = undefined; }
      if (!pending) { pending = this.#reopen(book.instrumentId, minute) ?? { t: minute, n: 0, step, bid: new Map(), ask: new Map() }; this.#pending.set(book.instrumentId, pending); }
      accumulateSide(book.bids, step, pending.bid);
      accumulateSide(book.asks, step, pending.ask);
      pending.n += 1;
    }
    for (const [id, pending] of this.#pending) if (pending.t < minute) this.#commit(id, pending);
  }

  /**
   * The minute that is about to be sampled, when a column for it was already committed (read back from the store after a restart within
   * the minute, or written when a page went away and then came back): taken off the list and made accumulating again, with its samples
   * counted, so the ones that follow average in with them instead of being thrown away at the next commit.
   */
  #reopen(id: string, minute: number): Pending | null {
    const list = this.columns.get(id), last = list?.[list.length - 1];
    if (!list || !last || last.t !== minute || !(last.n > 0)) return null;
    list.pop();
    const pending: Pending = { t: minute, n: last.n, step: this.steps.get(id)!, bid: new Map(), ask: new Map() };
    // A column holds the mean over its samples, an open minute the sum.
    for (let i = 0; i < last.bins.length; i++) { pending.bid.set(last.bins[i]!, last.bid[i]! * last.n); pending.ask.set(last.bins[i]!, last.ask[i]! * last.n); }
    return pending;
  }

  #commit(id: string, pending: Pending): void {
    this.#pending.delete(id);
    if (pending.n === 0) return;
    const column = finalize(pending, this.#minBinUsd);
    const list = this.#list(id);
    const last = list[list.length - 1];
    if (last && last.t >= column.t) return;
    list.push(column);
    this.#persist(id, column, pending.step);
  }

  /** Offer the store this column and any it refused before; a store that fails keeps them for the next try and does not stop the sampling. */
  #persist(id: string, column: Column, step: number): void {
    const store = this.#store; if (!store) return;
    this.#unsaved.push({ id, column, step });
    let done = 0;
    try { for (; done < this.#unsaved.length; done++) { const item = this.#unsaved[done]!; store.save(item.id, item.column, item.step); } }
    catch (error) {
      const first = this.saveFailures === 0 || this.lastSaveError === '';
      this.saveFailures++; this.lastSaveError = error instanceof Error ? error.message : String(error);
      if (first) console.warn('recordings are not being saved:', error);
    }
    this.#unsaved = this.#unsaved.slice(done);
    if (this.#unsaved.length === 0) this.lastSaveError = '';
    else if (this.#unsaved.length > UNSAVED_MAX) this.#unsaved = this.#unsaved.slice(-UNSAVED_MAX);
  }

  /** First and last recorded minute per instrument, including the open minute. */
  coverage(): Record<string, { first: number; last: number }> {
    const out: Record<string, { first: number; last: number }> = {};
    for (const [id, list] of this.columns) if (list.length) out[id] = { first: list[0]!.t, last: list[list.length - 1]!.t };
    for (const [id, open] of this.#pending) { const entry = out[id]; if (entry) entry.last = Math.max(entry.last, open.t); else out[id] = { first: open.t, last: open.t }; }
    return out;
  }

  /** Commit everything still accumulating (shutdown). */
  flush(): void { for (const [id, pending] of [...this.#pending]) this.#commit(id, pending); }

  prune(now = this.#now()): void {
    const cutoff = now - this.#retentionMs;
    for (const list of this.columns.values()) { let drop = 0; while (drop < list.length && list[drop]!.t < cutoff) drop++; if (drop) list.splice(0, drop); }
    // A kept window that began before the cutoff has lost minutes since it was merged.
    for (const [key, column] of this.#merged) if (column.t < cutoff) { this.#merged.delete(key); this.#mergedBins -= column.bins.length; }
    this.#store?.prune(cutoff);
  }

  /**
   * Columns in [from, to), optionally merged into stepMs windows (a multiple of COLUMN_MS, aligned to it). The open minute is included.
   * A window that lies wholly inside the question and has ended (none of its minutes can change) is kept, so zooming and panning over
   * the same days merges each of them once.
   */
  query(instrumentId: string, from: number, to: number, stepMs = COLUMN_MS): Column[] {
    const list = this.columns.get(instrumentId) ?? [];
    const inRange = list.slice(firstFrom(list, from), firstFrom(list, to));
    const open = this.#pending.get(instrumentId);
    if (open && open.n > 0 && open.t >= from && open.t < to) inRange.push(finalize(open, this.#minBinUsd));
    if (stepMs <= COLUMN_MS) return inRange;
    const settled = Math.min(Math.floor(this.#now() / COLUMN_MS) * COLUMN_MS, open ? open.t : Infinity);
    const out: Column[] = [];
    for (let start = 0; start < inRange.length;) {
      const t = Math.floor(inRange[start]!.t / stepMs) * stepMs;
      let end = start + 1;
      while (end < inRange.length && inRange[end]!.t < t + stepMs) end++;
      const whole = t >= from && t + stepMs <= to && t + stepMs <= settled, key = `${instrumentId}|${stepMs}|${t}`;
      let column = whole ? this.#merged.get(key) : undefined;
      if (column) { this.#merged.delete(key); this.#merged.set(key, column); }
      else {
        column = mergeWindow(inRange, start, end, t, this.#minBinUsd);
        if (whole) {
          this.#merged.set(key, column); this.#mergedBins += column.bins.length;
          for (const [oldest, gone] of this.#merged) { if (this.#mergedBins <= MERGED_CACHE_BINS) break; this.#merged.delete(oldest); this.#mergedBins -= gone.bins.length; }
        }
      }
      out.push(column);
      start = end;
    }
    return out;
  }
}
