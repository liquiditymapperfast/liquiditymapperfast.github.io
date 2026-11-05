/**
 * The long history under the page's own day: the columns the engine answers, with the windows before its data filled from the service's
 * tiles (`tiles.ts`). One owner per window (docs/proposals/long-history-tiles-2026-11-05.md, "Ownership on the page"):
 *
 * - E, per book: the end of the engine's first window at this step (its first window may hold only part of its minutes, so it is the
 *   archive's when the archive has it).
 * - Windows ending at or before E come from the archive; an archive window that had not ended when its head was made (`open`, the 2048 and
 *   4096 levels, wider than the page's day) is drawn as it is when it starts before E. Windows from E on are the engine's.
 *
 * Answers never wait for the network: what the cache holds is used at once, the files missing are fetched meanwhile, and `onChange` says
 * when they have come (the hub then asks for the columns again). A file that fails is tried again later and never held as empty. The bytes
 * are kept as fetched; arrays are decoded afresh for each answer (the raster worker takes the ones it is handed).
 */
import { packLt, type ColumnSet, type ColumnsFrame } from '../../shared/columns.ts';
import { LT_LENGTH } from '../../shared/lt-sample.ts';
import { decodeTile, headUrl, packMs, packStarts, packUrl, type TileColumn, type TileFile, type TilesInfo } from './tiles.ts';

const MINUTE = 60_000;
/** A head is the open pack: kept for the minute the service lets a cache keep it. */
export const HEAD_FRESH_MS = 60_000;
/** A pack the service has none of (404) is asked again after this: a pack is published only once its windows have ended. */
export const MISSING_FRESH_MS = 10 * MINUTE;
/** Waits before a failed file is tried again, one after another (the last repeats). */
export const RETRY_MS: readonly number[] = [15_000, 60_000, 5 * MINUTE];
/** Bytes of tiles kept (as fetched, decoded on use): a week of 16-minute windows for eleven books is about 3 MB. */
export const ARCHIVE_BYTES = 48 << 20;
/** Files fetched at once. */
export const ARCHIVE_PARALLEL = 4;
/** `onChange` waits this long for more files, so a view's packs arriving together cost one new question. */
const CHANGE_DEBOUNCE_MS = 250;

export type TileFetch = (url: string) => Promise<{ ok: boolean; status: number; arrayBuffer(): Promise<ArrayBuffer> }>;
interface Held { bytes: ArrayBuffer | null; at: number; size: number }
interface Failed { tries: number; retryAt: number }

export class ArchiveColumns {
  #info: TilesInfo | null = null;
  #held = new Map<string, Held>();
  #bytes = 0;
  #flying = new Set<string>();
  #queue: string[] = [];
  #failed = new Map<string, Failed>();
  #changeTimer: ReturnType<typeof setTimeout> | null = null;
  /** Said when files have come that an answer could now use. */
  onChange: (() => void) | null = null;

  constructor(private readonly base: string, private readonly fetchTile: TileFetch = url => fetch(url), private readonly now: () => number = Date.now, private readonly budget = ARCHIVE_BYTES) {}

  /** The service's `tiles` section (from the `latest.json` the history import read), or null when it has none. */
  setInfo(info: TilesInfo | null): void { this.#info = info; if (info) this.#change(); }
  get info(): TilesInfo | null { return this.#info; }
  /** Where the archive's depth begins (its oldest window), or null when there is none. */
  first(): number | null { return this.#info ? this.#info.first : null; }

  /**
   * The engine's answer with the windows before its data filled from the archive (see the module's note). `close` answers and steps the
   * archive does not keep are the engine's alone.
   */
  extend(frame: ColumnsFrame, from: number, to: number, stepMs: number): ColumnsFrame {
    const info = this.#info, level = Math.round(stepMs / MINUTE);
    if (!info || !this.base || level * MINUTE !== stepMs || !info.levels.includes(level)) return frame;
    // E per book: where the engine's data begins inside the question, past its first window (which may hold part of its minutes); the start
    // of the question when the engine has it from there (a refresh of what it holds, or a view inside its day: nothing for the archive); the
    // end of the question when the engine has none of it.
    const ends = new Map<string, number>();
    for (const set of frame.instruments) ends.set(set.id, !set.times.length ? to : set.times[0]! <= from ? from : set.times[0]! + stepMs);
    let reach = from;
    for (const e of ends.values()) reach = Math.max(reach, Math.min(e, to));
    const lo = Math.max(from, info.first), hi = reach;
    if (!(hi > lo)) return frame;
    const files = this.#files(lo, hi, level, info);
    if (!files.length) return frame;
    const instruments = frame.instruments.map(set => {
      const archived = this.#columnsOf(files, set.id, from, to, stepMs, ends.get(set.id) ?? to);
      return archived.length ? merged(set, archived, stepMs, ends.get(set.id) ?? to) : set;
    });
    return { ...frame, instruments };
  }

  /** The files that hold [lo, hi) at this level, decoded afresh: complete packs, or the head for the pack under way (the rest are fetched). */
  #files(lo: number, hi: number, level: number, info: TilesInfo): TileFile[] {
    const out: TileFile[] = [], len = packMs(level, info.packSpan);
    for (const start of packStarts(lo, hi, level, info.packSpan)) {
      let url = start + len <= info.through ? packUrl(this.base, level, start) : null;
      if (!url) {
        const head = this.#take(headUrl(this.base, level), HEAD_FRESH_MS);
        if (head === undefined) continue;
        const file = head ? decodeTile(head) : null;
        if (file && file.through > info.through) { info.through = file.through; }
        if (!file || file.packStart < start) continue;
        // The service has moved on to a later pack: this one is complete now.
        if (file.packStart > start) url = packUrl(this.base, level, start);
        else { out.push(file); continue; }
      }
      const bytes = this.#take(url, Infinity);
      const file = bytes ? decodeTile(bytes) : null;
      if (file && file.packStart === start && file.level === level) out.push(file);
    }
    return out;
  }

  /** One book's archive windows that are the archive's to draw (see the module's note), on the grid each was recorded on. */
  #columnsOf(files: readonly TileFile[], id: string, from: number, to: number, stepMs: number, end: number): TileColumn[] {
    const out: TileColumn[] = [];
    for (const file of files) for (const c of file.books.get(id) ?? []) {
      if (c.t < from || c.t >= to) continue;
      if (c.t + stepMs <= end || (c.open && c.t < end)) out.push(c);
    }
    out.sort((a, b) => a.t - b.t);
    return out.filter((c, i) => i === 0 || out[i - 1]!.t !== c.t);
  }

  /**
   * The bytes held for `url` while they are fresh (`fresh` ms; a missing file `MISSING_FRESH_MS`): ArrayBuffer, null for a file the service
   * has none of, undefined while it is not held (it is then fetched, unless it failed and waits for its next try).
   */
  #take(url: string, fresh: number): ArrayBuffer | null | undefined {
    const held = this.#held.get(url), now = this.now();
    if (held && now - held.at < (held.bytes ? fresh : Math.min(fresh, MISSING_FRESH_MS))) {
      // Used: last to go.
      this.#held.delete(url); this.#held.set(url, held);
      return held.bytes;
    }
    this.#want(url);
    // A head out of date is still better than nothing while its fresh copy comes; a missing file is not kept.
    return held?.bytes ?? undefined;
  }

  #want(url: string): void {
    const failed = this.#failed.get(url);
    if (this.#flying.has(url) || this.#queue.includes(url) || (failed && this.now() < failed.retryAt)) return;
    this.#queue.push(url);
    this.#pump();
  }

  #pump(): void {
    while (this.#flying.size < ARCHIVE_PARALLEL && this.#queue.length) {
      const url = this.#queue.shift()!;
      this.#flying.add(url);
      void this.#fetch(url).finally(() => { this.#flying.delete(url); this.#pump(); });
    }
  }

  async #fetch(url: string): Promise<void> {
    try {
      const r = await this.fetchTile(url);
      if (r.status === 404) { this.#keep(url, null); this.#failed.delete(url); this.#change(); return; }
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const bytes = await r.arrayBuffer();
      if (!decodeTile(bytes)) throw new Error('not a tile file');
      this.#keep(url, bytes); this.#failed.delete(url); this.#change();
    } catch {
      // Never held as empty: tried again after a while, a little longer each time.
      const tries = (this.#failed.get(url)?.tries ?? 0) + 1;
      this.#failed.set(url, { tries, retryAt: this.now() + RETRY_MS[Math.min(tries, RETRY_MS.length) - 1]! });
      const wait = RETRY_MS[Math.min(tries, RETRY_MS.length) - 1]!;
      // The next try comes with the next question after this (the hub asks again on the change); a test's process need not wait for it.
      (setTimeout(() => this.#change(), wait + 50) as unknown as { unref?: () => void }).unref?.();
    }
  }

  #keep(url: string, bytes: ArrayBuffer | null): void {
    const old = this.#held.get(url);
    if (old) { this.#bytes -= old.size; this.#held.delete(url); }
    const size = bytes?.byteLength ?? 0;
    this.#held.set(url, { bytes, at: this.now(), size });
    this.#bytes += size;
    // The oldest used go first, never the one just kept.
    for (const [key, held] of this.#held) {
      if (this.#bytes <= this.budget || key === url) break;
      this.#held.delete(key); this.#bytes -= held.size;
    }
  }

  #change(): void {
    if (this.#changeTimer !== null) return;
    this.#changeTimer = setTimeout(() => { this.#changeTimer = null; this.onChange?.(); }, CHANGE_DEBOUNCE_MS);
  }

  /** Bytes held now (tests). */
  get heldBytes(): number { return this.#bytes; }
}

/**
 * One book's columns: the archive's windows, then the engine's from `end` on (and its first window when the archive has none for it), on one
 * grid: the engine's, or the newest archive window's when the engine knows none. Fresh arrays.
 */
function merged(set: ColumnSet, archived: readonly TileColumn[], stepMs: number, end: number): ColumnSet {
  const engine: { t: number; n: number; bins: Int32Array; bid: Float32Array; ask: Float32Array; lt?: Float32Array }[] = [];
  let at = 0;
  set.times.forEach((t, k) => {
    const count = set.counts[k]!;
    const lt = set.lt && !Number.isNaN(set.lt[k * LT_LENGTH]!) ? set.lt.slice(k * LT_LENGTH, (k + 1) * LT_LENGTH) : undefined;
    engine.push({ t, n: set.samples[k]!, bins: set.bins.slice(at, at + count), bid: set.bid.slice(at, at + count), ask: set.ask.slice(at, at + count), ...(lt ? { lt } : {}) });
    at += count;
  });
  const taken = new Set(archived.map(c => c.t));
  const kept = engine.filter(c => c.t >= end || (c.t + stepMs === end && !taken.has(c.t)));
  // The engine's grid whenever it knows one (a refresh compares grids: `ColumnHolds.gridChanged`), else the newest archive window's.
  const step = set.step > 0 ? set.step : archived[archived.length - 1]!.step;
  const rows: { t: number; n: number; bins: Int32Array; bid: Float32Array; ask: Float32Array; lt?: Float32Array; ltN?: number }[] = [
    ...archived.map(c => {
      const grid = c.step === step ? c : rebin(c, step);
      return { t: c.t, n: c.n, bins: grid.bins, bid: grid.bid, ask: grid.ask, ...(c.lt ? { lt: c.lt } : {}), ltN: c.ltN };
    }),
    ...kept.map(c => ({ ...c, ...(c.lt ? { ltN: c.n } : {}) })),
  ].sort((a, b) => a.t - b.t);
  const total = rows.reduce((sum, r) => sum + r.bins.length, 0);
  const bins = new Int32Array(total), bid = new Float32Array(total), ask = new Float32Array(total);
  let offset = 0;
  for (const r of rows) { bins.set(r.bins, offset); bid.set(r.bid, offset); ask.set(r.ask, offset); offset += r.bins.length; }
  const lt = packLt(rows.map(r => ({ t: r.t, n: r.n, bins: r.bins, bid: r.bid, ask: r.ask, ...(r.lt ? { lt: r.lt, ltN: r.ltN ?? 0 } : {}) })));
  const out: ColumnSet = { id: set.id, step, times: rows.map(r => r.t), counts: rows.map(r => r.bins.length), samples: rows.map(r => r.n), bins, bid, ask };
  if (lt) out.lt = lt;
  return out;
}

/**
 * A window recorded on another grid, on `step`'s: each bin's USD shared among the bins it overlaps, in proportion (as the recorder shares a
 * level among bins), so the total is kept. Only where a book's grid changed (rare: the service moves a book only when its price has gone two
 * 1-2-5 steps away); the shares are an estimate.
 */
export function rebin(c: { bins: Int32Array; bid: Float32Array; ask: Float32Array; step: number }, step: number): { bins: Int32Array; bid: Float32Array; ask: Float32Array } {
  const bid = new Map<number, number>(), ask = new Map<number, number>(), s0 = c.step;
  for (let i = 0; i < c.bins.length; i++) {
    const lo = c.bins[i]! * s0, hi = lo + s0;
    const first = Math.floor(lo / step), last = Math.ceil(hi / step) - 1;
    for (let k = first; k <= last; k++) {
      const share = (Math.min(hi, (k + 1) * step) - Math.max(lo, k * step)) / s0;
      if (!(share > 1e-12)) continue;
      bid.set(k, (bid.get(k) ?? 0) + c.bid[i]! * share);
      ask.set(k, (ask.get(k) ?? 0) + c.ask[i]! * share);
    }
  }
  const keys = [...bid.keys()].sort((a, b) => a - b);
  return { bins: Int32Array.from(keys), bid: Float32Array.from(keys, k => bid.get(k)!), ask: Float32Array.from(keys, k => ask.get(k)!) };
}
