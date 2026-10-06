import type { ValuedBook, SideLevels } from './levels.ts';
import { gridStepFor } from './grid.ts';

export const COLUMN_MS = 60_000;
export const SAMPLE_MS = 5_000;
/** Books older than this at sample time are treated as unobserved (a gap), never carried forward. */
export const STALE_MS = 45_000;
export const RETENTION_MS = 7 * 24 * 3_600_000;
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

function finalize(pending: Pick<Pending, 't' | 'n' | 'bid' | 'ask'>): Column {
  const keys = new Set<number>([...pending.bid.keys(), ...pending.ask.keys()]);
  let bins = Int32Array.from([...keys].sort((a, b) => a - b));
  let bid = new Float32Array(bins.length), ask = new Float32Array(bins.length);
  bins.forEach((bin, i) => { bid[i] = (pending.bid.get(bin) ?? 0) / pending.n; ask[i] = (pending.ask.get(bin) ?? 0) / pending.n; });
  if (bins.length > KEEP_ALWAYS) {
    let keep: number[] = [];
    for (let i = 0; i < bins.length; i++) if (bid[i]! + ask[i]! >= MIN_BIN_USD) keep.push(i);
    if (keep.length < KEEP_ALWAYS) keep = Array.from(bins.keys()).sort((x, y) => (bid[y]! + ask[y]!) - (bid[x]! + ask[x]!)).slice(0, KEEP_ALWAYS).sort((x, y) => x - y);
    bins = Int32Array.from(keep, i => bins[i]!); const b0 = bid, a0 = ask;
    bid = Float32Array.from(keep, i => b0[i]!); ask = Float32Array.from(keep, i => a0[i]!);
  }
  return { t: pending.t, n: pending.n, bins, bid, ask };
}

export interface RecorderOptions {
  store?: ColumnStore | null;
  now?: () => number;
  /** Grid step per instrument; chosen from the first valid price and then kept for the retention window. */
  steps?: Map<string, number>;
  /** How long minutes are kept (a week by default; the browser keeps a day). */
  retentionMs?: number;
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

  constructor({ store = null, now = Date.now, steps = new Map(), retentionMs = RETENTION_MS }: RecorderOptions = {}) {
    this.#store = store; this.#now = now; this.steps = steps; this.#retentionMs = retentionMs;
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
    const column = finalize(pending);
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
    this.#store?.prune(cutoff);
  }

  /** Columns in [from, to), optionally merged into stepMs windows (a multiple of COLUMN_MS). The open minute is included. */
  query(instrumentId: string, from: number, to: number, stepMs = COLUMN_MS): Column[] {
    const list = [...(this.columns.get(instrumentId) ?? [])];
    const open = this.#pending.get(instrumentId);
    if (open && open.n > 0) list.push(finalize(open));
    const inRange = list.filter(column => column.t >= from && column.t < to);
    if (stepMs <= COLUMN_MS) return inRange;
    const merged = new Map<number, { t: number; n: number; bid: Map<number, number>; ask: Map<number, number> }>();
    for (const column of inRange) {
      const t = Math.floor(column.t / stepMs) * stepMs;
      let group = merged.get(t);
      if (!group) { group = { t, n: 0, bid: new Map(), ask: new Map() }; merged.set(t, group); }
      group.n += column.n;
      for (let i = 0; i < column.bins.length; i++) {
        const bin = column.bins[i]!;
        group.bid.set(bin, (group.bid.get(bin) ?? 0) + column.bid[i]! * column.n);
        group.ask.set(bin, (group.ask.get(bin) ?? 0) + column.ask[i]! * column.n);
      }
    }
    return [...merged.values()].sort((a, b) => a.t - b.t).map(finalize);
  }
}
