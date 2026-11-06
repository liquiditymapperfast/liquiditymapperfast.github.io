import type { ValuedBook, SideLevels } from './levels.ts';
import { gridStepFor } from './grid.ts';
import { LT_LENGTH, addLtSample } from './lt-sample.ts';
import { KeptCache } from './kept-cache.ts';
import { ltWindows, type LtMinute, type LtWindows } from './lt-windows.ts';

export const COLUMN_MS = 60_000;
export const SAMPLE_MS = 5_000;
/** Books older than this at sample time are treated as unobserved (a gap), never carried forward. */
export const STALE_MS = 45_000;
export const RETENTION_MS = 7 * 24 * 3_600_000;
/** A browser keeps a day of recordings: the page is not a server, and a week of columns would not fit comfortably in memory. */
export const BROWSER_RETENTION_MS = 24 * 3_600_000;
/**
 * How much of its week a server holds in memory: older minutes are read back from its store when a question reaches them. A week of BTC
 * held whole took about 1.4 GB (columns 930 MB, footprint rows 476 MB; measured 2026-10-12). The browser keeps all of its day.
 */
export const HOT_MS = 24 * 3_600_000;
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
  /**
   * The Liquidity Tracker over the same minute, measured at each sample from the venue's own touch (`shared/lt-sample.ts`): the mean over
   * `ltN` samples (its own count: a minute reopened after a restart that recorded no tracker before has fewer). Absent in minutes recorded
   * before it was kept.
   */
  lt?: Float32Array;
  ltN?: number;
  /**
   * In an answer to a question for each window's close (`query`'s `close`): the minute whose book the window is, the latest recorded inside
   * it (its last minute where that was recorded); the window itself starts at `t`.
   */
  at?: number;
}
export interface ColumnStore {
  load(sinceMs: number): Iterable<{ instrumentId: string; column: Column; step: number }>;
  save(instrumentId: string, column: Column, step: number): void;
  prune(beforeMs: number): void;
  /**
   * A store that reads back on demand (the server's; the browser's holds its day in memory): one instrument's columns in [fromMs, toMs),
   * oldest first, and per instrument its first and last minute from `sinceMs` with the step of the first.
   */
  range?(instrumentId: string, fromMs: number, toMs: number): Column[];
  extent?(sinceMs: number): Map<string, { first: number; last: number; step: number }>;
  /** `range` without the books: each minute's samples and tracker alone (what the tracker lane reads; a store without it is read through `range`). */
  rangeLt?(instrumentId: string, fromMs: number, toMs: number): LtMinute[];
}
/** An open minute: the USD per bin summed over its `n` samples, and the tracker summed over its `ltN` samples (null until the first). */
interface Pending { t: number; n: number; step: number; bid: Map<number, number>; ask: Map<number, number>; lt: Float64Array | null; ltN: number }

/** The tracker's mean from its sums over `n` samples (undefined when there were none). */
const ltMean = (sums: Float64Array | null, n: number): Float32Array | undefined => sums && n > 0 ? Float32Array.from(sums, v => v / n) : undefined;

export { gridStepFor } from './grid.ts';

/**
 * Spread each level's USD across the grid bins its price band overlaps, proportionally to overlap. An overlap under a billionth of the band
 * is rounding, not overlap: a band edge on a bin edge at a small price (0.0000103 / 2e-9 is 5149.999999...) would otherwise leave a speck
 * in the bin outside it, which the Liquidity Tracker would take for the touch. The kernel (`spread_levels`) does the same.
 */
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
      if (overlap > width * 1e-9) into.set(bin, (into.get(bin) ?? 0) + usd * overlap / width);
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

function finalize(pending: Pick<Pending, 't' | 'n' | 'bid' | 'ask'> & Partial<Pick<Pending, 'lt' | 'ltN'>>, minBinUsd: number = MIN_BIN_USD): Column {
  const keys = new Set<number>([...pending.bid.keys(), ...pending.ask.keys()]);
  const bins = Int32Array.from([...keys].sort((a, b) => a - b));
  return withLt(finish(pending.t, pending.n, bins, Float64Array.from(bins, bin => pending.bid.get(bin) ?? 0), Float64Array.from(bins, bin => pending.ask.get(bin) ?? 0), minBinUsd), pending.lt ?? null, pending.ltN ?? 0);
}

/** A column with the tracker's mean over `ltN` samples, from its sums (as it was when there were none). */
function withLt(column: Column, sums: Float64Array | null, ltN: number): Column {
  const lt = ltMean(sums, ltN);
  return lt ? { ...column, lt, ltN } : column;
}

/** The tracker of columns `[start, end)` as one window: their means weighted by the samples behind each (the columns without one left out). */
function mergedLt(columns: readonly Column[], start: number, end: number): { sums: Float64Array | null; n: number } {
  let sums: Float64Array | null = null, n = 0;
  for (let k = start; k < end; k++) {
    const c = columns[k]!, lt = c.lt, w = c.ltN ?? 0;
    if (!lt || !(w > 0)) continue;
    sums ??= new Float64Array(LT_LENGTH);
    for (let i = 0; i < LT_LENGTH; i++) sums[i]! += lt[i]! * w;
    n += w;
  }
  return { sums, n };
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
  const lt = mergedLt(columns, start, end);
  return withLt(mergeDepth(columns, start, end, t, minBinUsd), lt.sums, lt.n);
}

function mergeDepth(columns: readonly Column[], start: number, end: number, t: number, minBinUsd: number): Column {
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

/** How many bins of merged windows a server keeps for the next question: two days of every market at one step fit (at most about 72 MB). */
export const MERGED_CACHE_BINS = 6_000_000;
/**
 * How many bins of columns read back from the store a server keeps for the next question: about three days of every BTC book (a day was 5.3M
 * bins on 2026-10-12; some 190 MB). The page asks for its whole window again every 30 s, so without them a view reaching back past the day
 * held re-read the store each time.
 */
export const COLD_CACHE_BINS = 16_000_000;
/**
 * How many minutes of trackers read back from the store a server keeps for the next question (about 140 bytes a minute): a week of 27 markets
 * is 272,000. The lane asks again for its window every few minutes, and a zoom or another half-life asks the same minutes at another step.
 */
export const COLD_LT_MINUTES = 300_000;
/** Columns are read back and kept by the hour. */
const COLD_CHUNK_MS = 3_600_000;

export interface RecorderOptions {
  store?: ColumnStore | null;
  now?: () => number;
  /** Grid step per instrument; chosen from the first valid price and then kept for the retention window. */
  steps?: Map<string, number>;
  /** How long minutes are kept (a week by default; the browser keeps a day). */
  retentionMs?: number;
  /**
   * How much of that is held in memory (all of it by default): with a store that reads back (`range`, `extent`), older columns are read from
   * it when a question reaches them (HOT_MS on the server).
   */
  memoryMs?: number;
  /** The smallest bin kept once a column is large (MIN_BIN_USD; smaller for a coin that trades less than BTC). */
  minBinUsd?: number;
  /** How many bins of merged windows are kept for the next question (MERGED_CACHE_BINS; less in a browser, which keeps a day and may be a phone). */
  mergedCacheBins?: number;
  /** How many bins of columns read back from the store are kept for the next question (COLD_CACHE_BINS). */
  coldCacheBins?: number;
  /** How many minutes of trackers read back from the store are kept for the next question (COLD_LT_MINUTES). */
  coldLtMinutes?: number;
}

/**
 * Records per-instrument minute columns from periodic book samples.
 *
 * `columns` holds every minute of an instrument from its first one held on (`memoryMs` back, or all the retention). With a store that reads
 * back, older minutes stay on disk and `query` reads them from it: a column leaves memory only once the store has it, so what is in memory
 * and what is on disk always join without a gap.
 */
export class DepthRecorder {
  readonly columns = new Map<string, Column[]>();
  readonly steps: Map<string, number>;
  readonly #pending = new Map<string, Pending>();
  /** Columns the store did not take, oldest first; they are offered again with the next one. */
  #unsaved: { id: string; column: Column; step: number }[] = [];
  /**
   * Reading back: minutes of columns the store never took and the queue let go of (past UNSAVED_MAX), per instrument, oldest first. Only
   * memory has them, so they stay there (and the ones after them) until the retention passes them.
   */
  readonly #lost = new Map<string, number[]>();
  /** How many times the store has refused a column, and why the last time (for a status line; the recorder itself goes on). */
  saveFailures = 0; lastSaveError = '';
  readonly #store: ColumnStore | null;
  readonly #now: () => number;
  readonly #retentionMs: number;
  readonly #memoryMs: number;
  /** Older columns are read back from the store (it can, and memory holds less than the retention). */
  readonly #readsBack: boolean;
  /** Memory holds every minute from here on (`memoryMs` before the last prune, or the start): what is older can no longer change. */
  #heldFrom = -Infinity;
  /** Hours of columns read back, by instrument and hour (only hours before `#heldFrom`), weighed in bins. */
  readonly #coldHours: KeptCache<Column[]>;
  /** The same hours of trackers alone (`queryLt`), weighed in minutes. */
  readonly #coldLt: KeptCache<LtMinute[]>;
  /** What the store holds per instrument from the retention on (first and last minute), for `coverage`; kept current at each prune. */
  #extent = new Map<string, { first: number; last: number; step: number }>();
  /** Where the retention began at the last prune (or at start): nothing older is answered, in memory or from the store. */
  #cutoff: number;
  readonly #minBinUsd: number;
  /** Merged windows that have ended, by instrument, step and start, weighed in bins. */
  readonly #merged: KeptCache<Column>;

  constructor({ store = null, now = Date.now, steps = new Map(), retentionMs = RETENTION_MS, memoryMs = retentionMs, minBinUsd = MIN_BIN_USD, mergedCacheBins = MERGED_CACHE_BINS, coldCacheBins = COLD_CACHE_BINS, coldLtMinutes = COLD_LT_MINUTES }: RecorderOptions = {}) {
    this.#merged = new KeptCache(mergedCacheBins, now); this.#coldHours = new KeptCache(coldCacheBins, now); this.#coldLt = new KeptCache(coldLtMinutes, now);
    this.#store = store; this.#now = now; this.steps = steps; this.#retentionMs = retentionMs; this.#minBinUsd = minBinUsd;
    this.#readsBack = store !== null && typeof store.range === 'function' && typeof store.extent === 'function' && memoryMs < retentionMs;
    this.#memoryMs = this.#readsBack ? memoryMs : retentionMs;
    const start = now();
    this.#cutoff = start - retentionMs;
    if (store) {
      // The step an instrument was recorded on is that of its oldest minute in the retention, held in memory or not.
      if (this.#readsBack) {
        this.#extent = store.extent!(this.#cutoff);
        for (const [id, { step }] of this.#extent) if (!this.steps.has(id)) this.steps.set(id, step);
        this.#heldFrom = this.#heldAt(start);
      }
      for (const { instrumentId, column, step } of store.load(Math.max(this.#cutoff, this.#heldAt(start)))) {
        this.#list(instrumentId).push(column);
        if (!this.steps.has(instrumentId)) this.steps.set(instrumentId, step);
      }
      for (const list of this.columns.values()) list.sort((a, b) => a.t - b.t);
    }
  }

  #list(id: string): Column[] { let list = this.columns.get(id); if (!list) { list = []; this.columns.set(id, list); } return list; }

  /**
   * Where memory begins at `now`: `memoryMs` back, and, reading back, at the start of that minute, so memory holds whole minutes (the one
   * under way among them, which a restart within it reopens) whatever `memoryMs` is.
   */
  #heldAt(now: number): number { const held = now - this.#memoryMs; return this.#readsBack ? Math.floor(held / COLUMN_MS) * COLUMN_MS : held; }

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
      if (!pending) { pending = this.#reopen(book.instrumentId, minute) ?? { t: minute, n: 0, step, bid: new Map(), ask: new Map(), lt: null, ltN: 0 }; this.#pending.set(book.instrumentId, pending); }
      // This sample's bins on their own first: the tracker is measured on them, from this book's own touch, before they join the minute.
      const bid = new Map<number, number>(), ask = new Map<number, number>();
      accumulateSide(book.bids, step, bid);
      accumulateSide(book.asks, step, ask);
      pending.lt ??= new Float64Array(LT_LENGTH);
      addLtSample(bid, ask, step, pending.lt);
      pending.ltN += 1;
      for (const [bin, usd] of bid) pending.bid.set(bin, (pending.bid.get(bin) ?? 0) + usd);
      for (const [bin, usd] of ask) pending.ask.set(bin, (pending.ask.get(bin) ?? 0) + usd);
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
    // A column holds the mean over its samples, an open minute the sum (the tracker over its own count: none when it was not kept).
    const ltN = last.lt && (last.ltN ?? 0) > 0 ? last.ltN! : 0;
    const pending: Pending = { t: minute, n: last.n, step: this.steps.get(id)!, bid: new Map(), ask: new Map(), lt: ltN ? Float64Array.from(last.lt!, v => v * ltN) : null, ltN };
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
    else if (this.#unsaved.length > UNSAVED_MAX) {
      const gone = this.#unsaved.length - UNSAVED_MAX;
      if (this.#readsBack) for (const { id, column } of this.#unsaved.slice(0, gone)) { let lost = this.#lost.get(id); if (!lost) this.#lost.set(id, lost = []); lost.push(column.t); }
      this.#unsaved = this.#unsaved.slice(gone);
    }
  }

  /** First and last recorded minute per instrument, including the open minute and what only the store holds. */
  coverage(): Record<string, { first: number; last: number }> {
    const out: Record<string, { first: number; last: number }> = {};
    for (const [id, { first, last }] of this.#extent) out[id] = { first, last };
    const widen = (id: string, first: number, last: number): void => { const entry = out[id]; if (entry) { entry.first = Math.min(entry.first, first); entry.last = Math.max(entry.last, last); } else out[id] = { first, last }; };
    for (const [id, list] of this.columns) if (list.length) widen(id, list[0]!.t, list[list.length - 1]!.t);
    for (const [id, open] of this.#pending) widen(id, open.t, open.t);
    return out;
  }

  /**
   * Each minute of [from, to) the instrument was sampled in (the open one too): how many of its twelve samples were taken and whether any
   * level was kept. The depth metric of the coverage record (shared/coverage.ts): a minute missing here was not recorded.
   */
  samples(instrumentId: string, from: number, to: number): Map<number, { n: number; levels: boolean }> {
    const out = new Map<number, { n: number; levels: boolean }>();
    for (const c of this.#columnsIn(instrumentId, from, to)) out.set(c.t, { n: c.n, levels: c.bins.length > 0 });
    const open = this.#pending.get(instrumentId);
    if (open && open.n > 0 && open.t >= from && open.t < to) out.set(open.t, { n: open.n, levels: open.bid.size + open.ask.size > 0 });
    return out;
  }

  /** Commit everything still accumulating (shutdown). */
  flush(): void { for (const [id, pending] of [...this.#pending]) this.#commit(id, pending); }

  /**
   * Let go of minutes past the retention, in memory and in the store, and, reading back, of the columns in memory older than `memoryMs`
   * that the store has (one it has not taken, or never will, stays, and so do the ones after it, so memory and store still join without a
   * gap).
   */
  prune(now = this.#now()): void {
    const cutoff = now - this.#retentionMs, held = this.#heldAt(now);
    // What the store holds from the cutoff on is read first: a store that fails here leaves the recorder as it was, and one that then fails
    // to let go of what is older does not leave expired minutes in `coverage`.
    const extent = this.#readsBack ? this.#store!.extent!(cutoff) : null;
    this.#cutoff = cutoff;
    const unsaved = new Set(this.#unsaved.map(item => `${item.id}|${item.column.t}`));
    for (const [id, lost] of this.#lost) {
      let gone = 0; while (gone < lost.length && lost[gone]! < cutoff) gone++;
      if (gone === lost.length) this.#lost.delete(id); else if (gone) lost.splice(0, gone);
    }
    for (const [id, list] of this.columns) {
      const keepFrom = Math.min(held, this.#lost.get(id)?.[0] ?? Infinity);
      let drop = 0;
      while (drop < list.length && (list[drop]!.t < cutoff || (list[drop]!.t < keepFrom && !unsaved.has(`${id}|${list[drop]!.t}`)))) drop++;
      if (drop) list.splice(0, drop);
    }
    // A kept window or hour that began before the cutoff has lost minutes since it was merged or read.
    this.#merged.deleteWhere((_, column) => column.t < cutoff);
    this.#coldHours.deleteWhere(key => hourOf(key) < cutoff);
    this.#coldLt.deleteWhere(key => hourOf(key) < cutoff);
    if (extent) { this.#extent = extent; this.#heldFrom = Math.max(this.#heldFrom, held); }
    this.#store?.prune(cutoff);
  }

  /**
   * One instrument's columns in [from, to): read back from the store before the first minute held in memory, then from memory. The open
   * minute counts as held: one reopened (`#reopen`) has an older copy in the store, which must not be read beside it. Only the stretch
   * between the first and the last minute the store holds is read: nothing for an instrument it never recorded (a question may name any),
   * and nothing for a time far outside the recording (near 4e23 ms an hour added to a time leaves it as it was, and the hours never end).
   * The store's extent is read again at every prune, before memory lets go of anything, so it holds every minute that memory does not.
   */
  #columnsIn(instrumentId: string, from: number, to: number): Column[] {
    const list = this.columns.get(instrumentId) ?? [], held = Math.min(list[0]?.t ?? Infinity, this.#pending.get(instrumentId)?.t ?? Infinity);
    const inMemory = list.slice(firstFrom(list, from), firstFrom(list, to));
    const stored = this.#readsBack ? this.#extent.get(instrumentId) : undefined;
    if (!stored || from >= held) return inMemory;
    const back = this.#readBack(instrumentId, Math.max(from, this.#cutoff, stored.first), Math.min(to, held, stored.last + COLUMN_MS), held);
    return back.length ? [...back, ...inMemory] : inMemory;
  }

  /**
   * Columns of [lo, hi) from the store (all before `held`, the first minute in memory), by the hour: a kept hour as it is, a run of the others
   * read in one pass and kept hour by hour when it can no longer change (wholly before what memory holds, and inside the retention).
   */
  #readBack(id: string, lo: number, hi: number, held: number): Column[] {
    return this.#readHours(this.#coldHours, weightOf, (from, to) => this.#store!.range!(id, from, to), id, lo, hi, held);
  }

  /** `#readBack` for what a question reads of each minute: the columns whole, or the trackers alone (`queryLt`), each in a cache of its own. */
  #readHours<M extends { t: number }>(cache: KeptCache<M[]>, weigh: (hour: M[]) => number, read: (from: number, to: number) => M[], id: string, lo: number, hi: number, held: number): M[] {
    const out: M[] = [], settled = Math.min(held, this.#heldFrom);
    if (!(hi > lo)) return out;
    for (let h = Math.floor(lo / COLD_CHUNK_MS) * COLD_CHUNK_MS; h < hi;) {
      const kept = cache.get(`${id}|${h}`);
      if (kept) {
        for (const column of kept) if (column.t >= lo && column.t < hi) out.push(column);
        h += COLD_CHUNK_MS; continue;
      }
      let end = h + COLD_CHUNK_MS;
      while (end < hi && !cache.has(`${id}|${end}`)) end += COLD_CHUNK_MS;
      const stored = read(Math.max(h, this.#cutoff), Math.min(end, held));
      for (let hour = h, at = 0; hour < end; hour += COLD_CHUNK_MS) {
        let stop = at; while (stop < stored.length && stored[stop]!.t < hour + COLD_CHUNK_MS) stop++;
        const columns = stored.slice(at, stop);
        if (hour >= this.#cutoff && hour + COLD_CHUNK_MS <= settled) cache.set(`${id}|${hour}`, columns, weigh(columns));
        for (const column of columns) if (column.t >= lo && column.t < hi) out.push(column);
        at = stop;
      }
      h = end;
    }
    return out;
  }

  /** `#columnsIn` for the trackers alone: the same minutes, read back through the store's `rangeLt` (its `range` where it has none). */
  #ltIn(instrumentId: string, from: number, to: number): LtMinute[] {
    const list = this.columns.get(instrumentId) ?? [], held = Math.min(list[0]?.t ?? Infinity, this.#pending.get(instrumentId)?.t ?? Infinity);
    const inMemory: LtMinute[] = list.slice(firstFrom(list, from), firstFrom(list, to));
    const stored = this.#readsBack ? this.#extent.get(instrumentId) : undefined;
    if (!stored || from >= held) return inMemory;
    const store = this.#store!;
    const read = (a: number, b: number): LtMinute[] => store.rangeLt ? store.rangeLt(instrumentId, a, b) : store.range!(instrumentId, a, b);
    const back = this.#readHours(this.#coldLt, hour => Math.max(1, hour.length), read, instrumentId, Math.max(from, this.#cutoff, stored.first), Math.min(to, held, stored.last + COLUMN_MS), held);
    return back.length ? [...back, ...inMemory] : inMemory;
  }

  /**
   * The Liquidity Tracker of one instrument over [from, to) in windows of `stepMs` (a multiple of COLUMN_MS, `from` on a window's start): what
   * the columns' windows would hold of it (`query`, `packLt`), without reading or merging their books. `half`: an index into LT_HALF_LIVES.
   * The open minute is included, as in `query`.
   */
  queryLt(instrumentId: string, from: number, to: number, stepMs: number, half: number): LtWindows {
    const minutes = this.#ltIn(instrumentId, from, to), open = this.#pending.get(instrumentId);
    if (open && open.n > 0 && open.t >= from && open.t < to) {
      const lt = ltMean(open.lt, open.ltN);
      minutes.push({ t: open.t, n: open.n, ...(lt ? { lt, ltN: open.ltN } : {}) });
    }
    return ltWindows(minutes, Math.max(COLUMN_MS, stepMs), half);
  }

  /** What is held, in bins: the columns in memory, the hours read back and kept, the merged windows kept (for diagnostics and measuring). */
  cacheStats(): { memoryBins: number; memoryColumns: number; coldBins: number; coldHours: number; mergedBins: number; mergedWindows: number } {
    let memoryBins = 0, memoryColumns = 0;
    for (const list of this.columns.values()) { memoryColumns += list.length; for (const column of list) memoryBins += column.bins.length; }
    return { memoryBins, memoryColumns, coldBins: this.#coldHours.weight, coldHours: this.#coldHours.size, mergedBins: this.#merged.weight, mergedWindows: this.#merged.size };
  }

  /**
   * Columns in [from, to), optionally merged into stepMs windows (a multiple of COLUMN_MS, aligned to it). The open minute is included.
   * A window that lies wholly inside the question and has ended (none of its minutes can change) is kept, so zooming and panning over
   * the same days merges each of them once (and, reading back, reads them from the store once).
   *
   * `close`: each window is the book at its close instead of its average (Karl, 2026-10-30: the scripts' depth bands; a book averaged over a
   * candle with a move in it reads the side the price came from thin): its latest recorded minute, its last where that was recorded and
   * never one of another window, the open minute for the window under way, stamped with the window's start and saying its minute (`at`).
   * Kept as the averages are, under keys of their own.
   */
  /**
   * Where this instrument's newest run of minutes begins: the oldest minute reached going back from the newest without a gap of more than
   * `gapMs` (a book away for a few minutes does not end its run; an hour not imported does). +Infinity when nothing is held. The page's long
   * history draws what lies before it (app/archive/), the same for every question.
   */
  contiguousSince(instrumentId: string, gapMs: number): number {
    const list = this.columns.get(instrumentId) ?? [], open = this.#pending.get(instrumentId);
    if (!list.length) return open && open.n > 0 ? open.t : Infinity;
    let k = list.length - 1;
    if (open && open.n > 0 && open.t - list[k]!.t > gapMs) return open.t;
    while (k > 0 && list[k]!.t - list[k - 1]!.t <= gapMs) k--;
    return list[k]!.t;
  }

  query(instrumentId: string, from: number, to: number, stepMs = COLUMN_MS, close = false): Column[] {
    const open = this.#pending.get(instrumentId), openColumn = open && open.n > 0 && open.t >= from && open.t < to ? finalize(open, this.#minBinUsd) : null;
    if (stepMs <= COLUMN_MS) {
      const inRange = this.#columnsIn(instrumentId, from, to); if (openColumn) inRange.push(openColumn);
      return close ? inRange.map(c => closeOf(c, c.t)) : inRange;
    }
    const settled = Math.min(Math.floor(this.#now() / COLUMN_MS) * COLUMN_MS, open ? open.t : Infinity);
    const whole = (t: number): boolean => t >= from && t + stepMs <= to && t + stepMs <= settled;
    const keyOf = (t: number): string => close ? `${instrumentId}|${stepMs}|${t}|close` : `${instrumentId}|${stepMs}|${t}`;
    const isKept = (t: number): boolean => whole(t) && this.#merged.has(keyOf(t));
    // Only the windows between the first minute held (in memory or the store) and the last have any.
    const list = this.columns.get(instrumentId) ?? [], stored = this.#extent.get(instrumentId);
    const earliest = Math.min(list[0]?.t ?? Infinity, stored?.first ?? Infinity, openColumn?.t ?? Infinity);
    const last = Math.min(to, Math.max(list[list.length - 1]?.t ?? -Infinity, stored?.last ?? -Infinity, openColumn?.t ?? -Infinity) + COLUMN_MS);
    const out: Column[] = [];
    // Window by window: a kept one as it was (a window found to have no minutes is kept too, as an empty column that is not answered, so
    // a sparse instrument does not send every frame back to the store); a run of the others is merged from its minutes, read in one pass.
    for (let t = Math.floor(Math.max(from, earliest) / stepMs) * stepMs; t < last;) {
      const hit = whole(t) ? this.#merged.get(keyOf(t)) : undefined;
      if (hit) { if (hit.n > 0) out.push(hit); t += stepMs; continue; }
      let end = t + stepMs;
      while (end < last && !isKept(end)) end += stepMs;
      const columns = this.#columnsIn(instrumentId, Math.max(from, t), Math.min(to, end));
      if (openColumn && openColumn.t >= t && openColumn.t < end) columns.push(openColumn);
      for (let w = t, at = 0; w < end; w += stepMs) {
        let stop = at; while (stop < columns.length && columns[stop]!.t < w + stepMs) stop++;
        const column = stop > at ? close ? closeOf(columns[stop - 1]!, w) : mergeWindow(columns, at, stop, w, this.#minBinUsd) : null;
        if (column) out.push(column);
        if (whole(w)) { const kept = column ?? { t: w, n: 0, bins: new Int32Array(0), bid: new Float32Array(0), ask: new Float32Array(0) }; this.#merged.set(keyOf(w), kept, weight(kept)); }
        at = stop;
      }
      t = end;
    }
    return out;
  }
}

/** A window `t` as the book of one of its minutes (`query`'s `close`): that minute's arrays, shared and never changed, and its time as `at`. */
const closeOf = (c: Column, t: number): Column => ({ t, n: c.n, bins: c.bins, bid: c.bid, ask: c.ask, at: c.t });
/** What a kept window weighs in the cache: its bins, and at least one (an empty window is kept too). */
const weight = (column: Column): number => Math.max(1, column.bins.length);
/** What a kept hour of columns weighs: their bins, and at least one (an hour with none is kept too). */
const weightOf = (hour: readonly Column[]): number => Math.max(1, hour.reduce((sum, column) => sum + column.bins.length, 0));
/** The hour a cold-cache key (`instrument|hour`) is for. */
const hourOf = (key: string): number => Number(key.slice(key.lastIndexOf('|') + 1));
