import { LT_LENGTH } from '../../shared/lt-sample.ts';
import type { ColumnSet } from '../wire.ts';

/**
 * One instrument's recorded columns as the raster worker holds them, flat for the raster kernel: column `c` starts at `times[c]` and has
 * `counts[c]` bins, its bins and amounts at the sum of the counts before it. `lt`: the tracker kept with the columns, LT_LENGTH floats a
 * column (NaN for a column that has none).
 */
export interface ColumnStore { step: number; times: Float64Array; counts: Uint32Array; bins: Int32Array; bid: Float32Array; ask: Float32Array; lt?: Float32Array }

export function toStore(set: ColumnSet): ColumnStore {
  return { step: set.step, times: Float64Array.from(set.times), counts: Uint32Array.from(set.counts), bins: set.bins, bid: set.bid, ask: set.ask, ...(set.lt ? { lt: set.lt } : {}) };
}

/**
 * The recorded columns the worker holds: per window step (`stepMs`), per instrument. One step is the one the panes read (`use`); the others
 * wait for a zoom back to them, and an instrument the view no longer lists keeps its columns until the page says to drop them
 * (`Hub.loadColumns`), so a book that comes back costs nothing. The page and this class are kept in step by the messages alone.
 */
export class RecordedColumns {
  #steps = new Map<number, Map<string, ColumnStore>>();
  #current: number;
  constructor(stepMs: number) { this.#current = stepMs; }

  /** The step the panes read. */
  get stepMs(): number { return this.#current; }
  /** The instruments' columns at that step (none while it holds nothing). */
  get current(): ReadonlyMap<string, ColumnStore> { return this.#steps.get(this.#current) ?? EMPTY; }

  /** The steps held, and the instruments held at one (what the page's record is checked against). */
  steps(): number[] { return [...this.#steps.keys()]; }
  ids(stepMs: number): string[] { return [...(this.#steps.get(stepMs)?.keys() ?? [])]; }

  /** These instruments' columns at `stepMs` as they are now, each replacing what was held for it; the other instruments are left as they were. */
  set(stepMs: number, sets: readonly ColumnSet[]): void {
    const held = this.#at(stepMs);
    for (const set of sets) held.set(set.id, toStore(set));
  }

  /** `withTail` into the columns held at `stepMs`: a tail belongs to the step it was asked at, whichever step is read now. */
  tail(stepMs: number, from: number, sets: readonly ColumnSet[]): void {
    const held = this.#at(stepMs);
    for (const set of sets) held.set(set.id, withTail(held.get(set.id), set, from));
  }

  /** `withRange` into the columns held at `stepMs`, for the instruments held there (one the page no longer holds is not taken back in). */
  range(stepMs: number, from: number, to: number, sets: readonly ColumnSet[]): void {
    const held = this.#steps.get(stepMs);
    if (!held) return;
    for (const set of sets) { const had = held.get(set.id); if (had) held.set(set.id, withRange(had, set, from, to)); }
  }

  /** Read `stepMs` from now on. */
  use(stepMs: number): void { this.#current = stepMs; }

  /** Forget these instruments' columns at `stepMs`, or all of that step's (`ids` null). */
  drop(stepMs: number, ids: readonly string[] | null): void {
    const held = this.#steps.get(stepMs);
    if (!held) return;
    if (ids) { for (const id of ids) held.delete(id); if (!held.size) this.#steps.delete(stepMs); } else this.#steps.delete(stepMs);
  }

  #at(stepMs: number): Map<string, ColumnStore> {
    let held = this.#steps.get(stepMs);
    if (!held) { held = new Map(); this.#steps.set(stepMs, held); }
    return held;
  }
}
const EMPTY: ReadonlyMap<string, ColumnStore> = new Map();

/**
 * `held` with its columns in [from, to) replaced by `set`'s (the windows of that range as the source has them now), the others kept: the
 * long history's tiles arriving for part of a view. Columns on another price grid are not joined (the held ones stay; the hub asks for the
 * whole window again when a grid changes).
 */
export function withRange(held: ColumnStore, set: ColumnSet, from: number, to: number): ColumnStore {
  if (set.step > 0 && held.step > 0 && set.step !== held.step) return held;
  const rows: { t: number; count: number; held: boolean; start: number; index: number }[] = [];
  let at = 0;
  held.times.forEach((t, k) => { const count = held.counts[k]!; if (t < from || t >= to) rows.push({ t, count, held: true, start: at, index: k }); at += count; });
  at = 0;
  set.times.forEach((t, k) => { const count = set.counts[k]!; if (t >= from && t < to) rows.push({ t, count, held: false, start: at, index: k }); at += count; });
  rows.sort((a, b) => a.t - b.t);
  const nBins = rows.reduce((sum, r) => sum + r.count, 0), n = rows.length;
  const times = new Float64Array(n), counts = new Uint32Array(n), bins = new Int32Array(nBins), bid = new Float32Array(nBins), ask = new Float32Array(nBins);
  const lt = held.lt || set.lt ? new Float32Array(n * LT_LENGTH).fill(NaN) : undefined;
  let offset = 0;
  rows.forEach((r, i) => {
    const src = r.held ? held : set;
    times[i] = r.t; counts[i] = r.count;
    bins.set(src.bins.subarray(r.start, r.start + r.count), offset); bid.set(src.bid.subarray(r.start, r.start + r.count), offset); ask.set(src.ask.subarray(r.start, r.start + r.count), offset);
    if (lt && src.lt) lt.set(src.lt.subarray(r.index * LT_LENGTH, (r.index + 1) * LT_LENGTH), i * LT_LENGTH);
    offset += r.count;
  });
  return { step: held.step > 0 ? held.step : set.step, times, counts, bins, bid, ask, ...(lt ? { lt } : {}) };
}

/**
 * `held` with every column from `from` on replaced by `set`'s, which are the columns of `from` onwards as the source has them now: the page's
 * refresh asks again only for the windows that could still change (`Hub.loadColumns`). The columns before `from` are kept as they are, so
 * `from` must be the start of a window. Without `held`, the store is `set`'s alone.
 */
export function withTail(held: ColumnStore | undefined, set: ColumnSet, from: number): ColumnStore {
  // Columns on another price grid are not joined to these (their bins mean other prices): the tail alone (the hub asks for the whole
  // window again when it sees one).
  if (!held || (set.step > 0 && held.step > 0 && set.step !== held.step)) return toStore(set);
  let keep = 0, keepBins = 0;
  while (keep < held.times.length && held.times[keep]! < from) keepBins += held.counts[keep++]!;
  const n = keep + set.times.length, nBins = keepBins + set.bins.length;
  const times = new Float64Array(n), counts = new Uint32Array(n);
  times.set(held.times.subarray(0, keep)); times.set(set.times, keep);
  counts.set(held.counts.subarray(0, keep)); counts.set(set.counts, keep);
  const join = <T extends Int32Array | Float32Array>(before: T, after: T, out: T): T => { out.set(before.subarray(0, keepBins) as never); out.set(after as never, keepBins); return out; };
  const store: ColumnStore = { step: set.step > 0 ? set.step : held.step, times, counts,
    bins: join(held.bins, set.bins, new Int32Array(nBins)), bid: join(held.bid, set.bid, new Float32Array(nBins)), ask: join(held.ask, set.ask, new Float32Array(nBins)) };
  // The trackers side by side as the source packs them: NaN where a column has none (one side may have none at all).
  if ((held.lt && keep > 0) || set.lt) {
    const lt = new Float32Array(n * LT_LENGTH).fill(NaN);
    if (held.lt) lt.set(held.lt.subarray(0, keep * LT_LENGTH));
    if (set.lt) lt.set(set.lt, keep * LT_LENGTH);
    store.lt = lt;
  }
  return store;
}
