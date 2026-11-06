/**
 * The long history under the page's own day: the columns the engine answers, with the windows before its data filled from the service's
 * tiles (`tiles.ts`). One owner per window (docs/proposals/long-history-tiles-2026-11-05.md, "Ownership on the page"), the same for every
 * question, whole or refresh:
 *
 * - C, per book: where the engine's newest run of minutes begins (`ColumnsFrame.since`, from what it holds: its import and its own
 *   recording, a gap of more than a few minutes ending a run), +Infinity when it holds none.
 * - E = the earlier of C snapped up to the step (the window C falls in holds only part of its minutes in the engine) and the end of the
 *   window the archive's watermark falls in (past it the archive has nothing).
 * - A window ending at or before E is the archive's (a complete pack's, or a head's, the window under way included); the rest are the
 *   engine's. Where the archive has no such window (not fetched yet, or none), the engine's is drawn, so nothing goes blank meanwhile.
 *
 * Answers never wait for the network: what the cache holds is used at once, the files missing are fetched meanwhile, and `onChange` names
 * the range a file has brought (the hub asks for that range again, inside what it holds, and splices it in). The files the view needs are
 * those meeting the windows the map holds at the step it reads (`view`, from the hub's own record, whatever asked and whenever its answer
 * came): they are fetched again when they go stale (a head, a pack the service did not have), tried again after a failure, and kept
 * whatever the byte budget. A head that has moved on to a later pack says the one before is complete: its range is said with the new one's.
 * A request is given up after a deadline; a body is read up to a cap and refused past it. Bytes are kept as fetched; arrays are decoded
 * afresh for each answer (the raster worker takes the ones it is handed).
 */
import { packLt, type ColumnSet, type ColumnsFrame } from '../../shared/columns.ts';
import { LT_LENGTH } from '../../shared/lt-sample.ts';
import { decodeTile, headUrl, packMs, packStarts, packUrl, type TileColumn, type TileFile, type TilesInfo } from './tiles.ts';

const MINUTE = 60_000;
/** A head is the open pack: the service makes a new one each hour; one in use is asked again (a revalidation) this often. */
export const HEAD_FRESH_MS = 10 * MINUTE;
/** A pack the service has none of (404) is asked again after this, if the view still needs it. */
export const MISSING_FRESH_MS = 10 * MINUTE;
/** Waits before a failed file is tried again, one after another (the last repeats). */
export const RETRY_MS: readonly number[] = [15_000, 60_000, 5 * MINUTE];
/** A request (and the reading of its answer) is given up after this: it fails, and is tried again like any failure. */
export const FETCH_DEADLINE_MS = 30_000;
/** Bytes of tiles kept (as fetched, decoded on use): a week of 16-minute windows for eleven books is about 3 MB; the files a view needs stay. */
export const ARCHIVE_BYTES = 48 << 20;
/**
 * A body is read up to this many bytes (as received: decoded, never fewer than went over the wire) and refused past it, as is one whose
 * Content-Length announces more: the largest real file, 2026-11-06, was 4.2 MB (0.4 MB on the wire).
 */
export const MAX_FILE_BYTES = 16 << 20;
/** Files held at most, whatever their bytes (a 404 is held as none, of no size). */
export const MAX_HELD_FILES = 512;
/** Files fetched at once. */
export const ARCHIVE_PARALLEL = 4;
/** `onChange` waits this long for more files of one level, so a view's packs arriving together cost one question per level. */
const CHANGE_DEBOUNCE_MS = 250;

export type TileResponse = { ok: boolean; status: number; headers?: { get(name: string): string | null }; body?: ReadableStream<Uint8Array> | null; arrayBuffer(): Promise<ArrayBuffer> };
export type TileFetch = (url: string, init: { signal: AbortSignal; cache: RequestCache }) => Promise<TileResponse>;
/** What new files have brought: the windows of [from, to) at `level` minutes, or (null) anything at all. */
export type ArchiveChange = { level: number; from: number; to: number } | null;
/** A window of time the page holds columns for (`ColumnHold`'s from and to). */
export interface HeldWindow { from: number; to: number }
interface Held { bytes: ArrayBuffer | null; at: number; size: number; fresh: number }
interface Failed { tries: number; retryAt: number }
interface Range { level: number; from: number; to: number }

/** Runs `run` after `ms`; returns a way to cancel it. The page's is setTimeout (unref'd where a runtime has it, so a test need not wait). */
export type Schedule = (run: () => void, ms: number) => () => void;
export const realSchedule: Schedule = (run, ms) => {
  const timer = setTimeout(run, ms);
  (timer as unknown as { unref?: () => void }).unref?.();
  return () => clearTimeout(timer);
};

/** Per book, where the engine's own depth begins for `ids`: the latest of their runs' starts (+Infinity for one it holds none of), or null when nothing was said. */
export function depthSinceOf(held: ReadonlyMap<string, number>, ids: readonly string[]): number | null {
  if (!held.size || !ids.length) return null;
  let since = -Infinity;
  for (const id of ids) since = Math.max(since, held.get(id) ?? Infinity);
  return since;
}

export class ArchiveColumns {
  #info: TilesInfo | null = null;
  #held = new Map<string, Held>();
  #bytes = 0;
  #flying = new Set<string>();
  #queue: string[] = [];
  #failed = new Map<string, Failed>();
  /**
   * What the map holds at the step it reads (`view`): its level (0 for a step the archive does not keep) and the windows its books' columns
   * were asked for. A file whose range meets one of them is needed: kept whatever the budget, fetched again when stale or after a failure.
   */
  #view: { level: number; windows: HeldWindow[] } = { level: 0, windows: [] };
  /** What each file is: the pack range it holds (a head: the pack under way), for what the view needs and the range an arrival brings. */
  #ranges = new Map<string, Range>();
  #pending = new Map<number, { from: number; to: number }>();
  #changeTimer: ReturnType<typeof setTimeout> | null = null;
  #wholeChange = false;
  /** Said when files have come that answers could now use. */
  onChange: ((change: ArchiveChange) => void) | null = null;

  constructor(private readonly base: string, private readonly fetchTile: TileFetch = (url, init) => fetch(url, init), private readonly now: () => number = Date.now, private readonly budget = ARCHIVE_BYTES, private readonly schedule: Schedule = realSchedule) {}

  /** The service's `tiles` section (from the `latest.json` the history import read), or null when it has none. */
  setInfo(info: TilesInfo | null): void { this.#info = info; if (info) { this.#wholeChange = true; this.#schedule(); } }
  get info(): TilesInfo | null { return this.#info; }
  /** Where the archive's depth begins (its oldest window), or null when there is none. */
  first(): number | null { return this.#info ? this.#info.first : null; }
  /** The archive's finest window (ms): its first level, two minutes for BTC and eight for a coin kept as tiles alone (ETH, SOL); null when there is none. */
  minStepMs(): number | null { return this.#info ? this.#info.levels[0]! * MINUTE : null; }

  /**
   * The step the map reads now and the windows it holds there (`Hub.loadColumns`, as it starts and once its answers are in): the files the
   * view needs are those meeting these windows, whoever asked for them and in whatever order the answers came. A view that comes to a level
   * fetches what it needs there that went stale or failed meanwhile. What is known of files no longer held, coming or waiting is let go.
   */
  view(stepMs: number, windows: readonly HeldWindow[]): void {
    const level = this.#level(stepMs), came = level !== this.#view.level;
    // The same view again (each frame may say it) costs nothing.
    if (!came && windows.length === this.#view.windows.length && windows.every((w, i) => w.from === this.#view.windows[i]!.from && w.to === this.#view.windows[i]!.to)) return;
    this.#view = { level, windows: windows.map(w => ({ from: w.from, to: w.to })) };
    const now = this.now();
    for (const [url, failed] of [...this.#failed]) if (failed.retryAt <= now && !this.#needed(url)) this.#failed.delete(url);
    for (const url of [...this.#ranges.keys()]) if (!this.#held.has(url) && !this.#flying.has(url) && !this.#failed.has(url) && !this.#queue.includes(url)) this.#ranges.delete(url);
    if (!came || !level) return;
    for (const [url, held] of this.#held) if (this.#needed(url) && now - held.at >= held.fresh) this.#want(url);
    for (const url of this.#failed.keys()) if (this.#needed(url)) this.#want(url);
  }

  /** The archive's level for a step, or 0 for one it does not keep. */
  #level(stepMs: number): number {
    const level = Math.round(stepMs / MINUTE);
    return this.#info && level * MINUTE === stepMs && this.#info.levels.includes(level) ? level : 0;
  }

  /**
   * The engine's answer with the windows before its data filled from the archive (see the module's note). Steps the archive does not keep
   * are the engine's alone. `grids`: per book, the price grid the page holds its columns on (an arrival's question): a book the engine has no
   * grid for is drawn on it, so what is spliced in matches what is held.
   */
  extend(frame: ColumnsFrame, from: number, to: number, stepMs: number, grids?: Readonly<Record<string, number>>): ColumnsFrame {
    const info = this.#info, level = this.#level(stepMs);
    if (!info || !this.base || !level) return frame;
    // E per book (see the module's note).
    const watermarkEnd = (Math.floor(info.through / stepMs) + 1) * stepMs, ends = new Map<string, number>();
    for (const set of frame.instruments) {
      const since = frame.since?.[set.id] ?? Infinity;
      ends.set(set.id, Math.min(Number.isFinite(since) ? Math.ceil(since / stepMs) * stepMs : Infinity, watermarkEnd));
    }
    let reach = from;
    for (const e of ends.values()) reach = Math.max(reach, Math.min(e, to));
    const lo = Math.max(from, info.first), hi = reach;
    if (!(hi > lo)) return frame;
    const files = this.#files(lo, hi, level, info);
    if (!files.length) return frame;
    const instruments = frame.instruments.map(set => {
      const end = ends.get(set.id) ?? to;
      const archived = this.#columnsOf(files, set.id, from, to, stepMs, end);
      return archived.length ? merged(set, archived, end, grids?.[set.id] ?? 0) : set;
    });
    return { ...frame, instruments };
  }

  /** The files that hold [lo, hi) at this level, decoded afresh: complete packs, or the head for the pack under way (the rest are fetched). */
  #files(lo: number, hi: number, level: number, info: TilesInfo): TileFile[] {
    const out: TileFile[] = [], len = packMs(level, info.packSpan);
    for (const start of packStarts(lo, hi, level, info.packSpan)) {
      const range = { level, from: start, to: start + len };
      let url = start + len <= info.through ? packUrl(this.base, level, start) : null;
      if (!url) {
        const head = headUrl(this.base, level);
        this.#ranges.set(head, range);
        const bytes = this.#take(head);
        if (bytes === undefined) continue;
        const file = bytes ? decodeTile(bytes, info.packSpan) : null;
        if (file && file.level === level && file.through > info.through) info.through = file.through;
        if (!file || file.level !== level || file.packStart < start) continue;
        // The service has moved on to a later pack: this one is complete now.
        if (file.packStart > start) url = packUrl(this.base, level, start);
        else { out.push(file); continue; }
      }
      this.#ranges.set(url, range);
      const bytes = this.#take(url);
      const file = bytes ? decodeTile(bytes, info.packSpan) : null;
      if (file && file.packStart === start && file.level === level) out.push(file);
    }
    return out;
  }

  /** One book's archive windows that are the archive's to draw: inside the question, ending at or before its E. */
  #columnsOf(files: readonly TileFile[], id: string, from: number, to: number, stepMs: number, end: number): TileColumn[] {
    const out: TileColumn[] = [];
    for (const file of files) for (const c of file.books.get(id) ?? []) if (c.t >= from && c.t < to && c.t + stepMs <= end) out.push(c);
    out.sort((a, b) => a.t - b.t);
    return out.filter((c, i) => i === 0 || out[i - 1]!.t !== c.t);
  }

  /**
   * The bytes held for `url`: ArrayBuffer, null for a file the service has none of, undefined while it is not held (it is then fetched, unless
   * it failed and waits for its next try). A stale copy is used while its fresh one comes.
   */
  #take(url: string): ArrayBuffer | null | undefined {
    const held = this.#held.get(url);
    if (held) {
      // Used: last to go.
      this.#held.delete(url); this.#held.set(url, held);
      if (this.now() - held.at >= held.fresh) this.#want(url);
      return held.bytes;
    }
    this.#want(url);
    return undefined;
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
    const abort = new AbortController(), cancel = this.schedule(() => abort.abort(), FETCH_DEADLINE_MS);
    // The deadline ends the wait whether or not the fetch heeds its signal.
    const gaveUp = new Promise<never>((_, reject) => { abort.signal.addEventListener('abort', () => reject(new Error('deadline')), { once: true }); });
    gaveUp.catch(() => undefined);
    const head = url.endsWith('/head.bin');
    try {
      // A head is revalidated (it changes each hour, and an unchanged one costs a 304); a pack never changes.
      const r = await Promise.race([this.fetchTile(url, { signal: abort.signal, cache: head ? 'no-cache' : 'default' }), gaveUp]);
      if (r.status === 404) { this.#keep(url, null, MISSING_FRESH_MS); this.#failed.delete(url); return; }
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const announced = Number(r.headers?.get('content-length') ?? NaN);
      if (announced > MAX_FILE_BYTES) { abort.abort(); throw new Error('too large'); }
      const bytes = await Promise.race([bodyOf(r, MAX_FILE_BYTES, abort), gaveUp]);
      const range = this.#ranges.get(url), file = decodeTile(bytes, this.#info?.packSpan);
      if (!file || (range && file.level !== range.level)) throw new Error('not a tile file');
      this.#keep(url, bytes, head ? HEAD_FRESH_MS : Infinity);
      this.#failed.delete(url);
      if (!range) return;
      if (!head) { this.#arrived(range); return; }
      // A head moves the watermark on; one that has moved on to a later pack says the pack it was asked for is complete now: that range is
      // said with the new one's, so the hub's question for it fetches the finished pack.
      if (this.#info && file.through > this.#info.through) this.#info.through = file.through;
      const end = file.packStart + file.windows * file.level * MINUTE;
      this.#arrived({ level: range.level, from: Math.min(range.from, file.packStart), to: Math.max(range.to, end) });
      this.#ranges.set(url, { level: range.level, from: file.packStart, to: end });
    } catch {
      // Never held as empty: tried again after a while, a little longer each time, while the view needs it.
      const tries = (this.#failed.get(url)?.tries ?? 0) + 1, wait = RETRY_MS[Math.min(tries, RETRY_MS.length) - 1]!;
      this.#failed.set(url, { tries, retryAt: this.now() + wait });
      this.schedule(() => { if (this.#needed(url)) this.#want(url); }, wait + 50);
    } finally { cancel(); }
  }

  /** Keeps a file's bytes (null: the service has none), with a timer to ask again when it goes stale while the view needs it. */
  #keep(url: string, bytes: ArrayBuffer | null, fresh: number): void {
    const old = this.#held.get(url);
    if (old) { this.#bytes -= old.size; this.#held.delete(url); }
    const size = bytes?.byteLength ?? 0;
    this.#held.set(url, { bytes, at: this.now(), size, fresh });
    this.#bytes += size;
    if (Number.isFinite(fresh)) this.schedule(() => { if (this.#needed(url)) this.#want(url); }, fresh + 50);
    // The oldest used go first; never one the view needs, nor the one just kept.
    for (const [key, held] of this.#held) {
      if (this.#bytes <= this.budget && this.#held.size <= MAX_HELD_FILES) break;
      if (key === url || this.#needed(key)) continue;
      this.#held.delete(key); this.#bytes -= held.size;
    }
  }

  /** Whether the view needs the file now: one of the level it reads whose range meets a window it holds there. */
  #needed(url: string): boolean {
    const range = this.#ranges.get(url), view = this.#view;
    return !!range && range.level === view.level && view.windows.some(w => range.from < w.to && range.to > w.from);
  }

  /** A file has come: its range is said once the others of its level that come with it are in. */
  #arrived(range: Range): void {
    const pending = this.#pending.get(range.level);
    this.#pending.set(range.level, pending ? { from: Math.min(pending.from, range.from), to: Math.max(pending.to, range.to) } : { from: range.from, to: range.to });
    this.#schedule();
  }

  #schedule(): void {
    if (this.#changeTimer !== null) return;
    this.#changeTimer = setTimeout(() => {
      this.#changeTimer = null;
      if (this.#wholeChange) { this.#wholeChange = false; this.#pending.clear(); this.onChange?.(null); return; }
      const pending = [...this.#pending]; this.#pending.clear();
      for (const [level, r] of pending) this.onChange?.({ level, from: r.from, to: r.to });
    }, CHANGE_DEBOUNCE_MS);
  }

  /** Bytes held now (tests). */
  get heldBytes(): number { return this.#bytes; }
}

/**
 * A response's body, refused (and its request ended) once more than `cap` bytes have come: nothing larger is ever allocated. Read in chunks
 * where the response has a stream; a test's response without one is read whole.
 */
async function bodyOf(r: TileResponse, cap: number, abort: AbortController): Promise<ArrayBuffer> {
  const reader = r.body?.getReader();
  if (!reader) {
    const bytes = await r.arrayBuffer();
    if (bytes.byteLength > cap) throw new Error('too large');
    return bytes;
  }
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > cap) { abort.abort(); void reader.cancel().catch(() => undefined); throw new Error('too large'); }
    chunks.push(value);
  }
  const out = new Uint8Array(size);
  let at = 0;
  for (const chunk of chunks) { out.set(chunk, at); at += chunk.byteLength; }
  return out.buffer;
}

/**
 * One book's columns: the archive's windows before `end`, the engine's from `end` on (and before it where the archive has no window), on one
 * grid: the engine's when it knows one, else `grid` (the one the page holds the book on, for an arrival's question), else the newest archive
 * window's. Fresh arrays.
 */
function merged(set: ColumnSet, archived: readonly TileColumn[], end: number, grid: number): ColumnSet {
  const engine: { t: number; n: number; bins: Int32Array; bid: Float32Array; ask: Float32Array; lt?: Float32Array }[] = [];
  let at = 0;
  set.times.forEach((t, k) => {
    const count = set.counts[k]!;
    const lt = set.lt && !Number.isNaN(set.lt[k * LT_LENGTH]!) ? set.lt.slice(k * LT_LENGTH, (k + 1) * LT_LENGTH) : undefined;
    engine.push({ t, n: set.samples[k]!, bins: set.bins.slice(at, at + count), bid: set.bid.slice(at, at + count), ask: set.ask.slice(at, at + count), ...(lt ? { lt } : {}) });
    at += count;
  });
  const taken = new Set(archived.map(c => c.t));
  // The engine's grid whenever it knows one (a refresh compares grids: `ColumnHolds.gridChanged`), else the newest archive window's.
  const step = set.step > 0 ? set.step : grid > 0 ? grid : archived.length ? archived[archived.length - 1]!.step : set.step;
  const rows: { t: number; n: number; bins: Int32Array; bid: Float32Array; ask: Float32Array; lt?: Float32Array; ltN?: number }[] = [
    ...archived.map(c => {
      const grid = c.step === step ? c : rebin(c, step);
      return { t: c.t, n: c.n, bins: grid.bins, bid: grid.bid, ask: grid.ask, ...(c.lt ? { lt: c.lt } : {}), ltN: c.ltN };
    }),
    ...engine.filter(c => c.t >= end || !taken.has(c.t)).map(c => ({ ...c, ...(c.lt ? { ltN: c.n } : {}) })),
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

/** At most this many bins of the frame's grid one window's bin is shared among: the grids differ by a 1-2-5 step or two, never by thousands. */
export const MAX_REBIN_RATIO = 1_000;
/** At most this many bins a rebinned window has. */
export const MAX_REBIN_BINS = 200_000;

/**
 * A window recorded on another grid, on `step`'s: each bin's USD shared among the bins it overlaps, in proportion (as the recorder shares a
 * level among bins), so the total is kept. Only where a book's grid changed (rare: the service moves a book only when its price has gone two
 * 1-2-5 steps away); the shares are an estimate. Bounded for any input: grids too far apart, or a result too large, give an empty window.
 */
export function rebin(c: { bins: Int32Array; bid: Float32Array; ask: Float32Array; step: number }, step: number): { bins: Int32Array; bid: Float32Array; ask: Float32Array } {
  const empty = { bins: new Int32Array(0), bid: new Float32Array(0), ask: new Float32Array(0) }, s0 = c.step, ratio = s0 / step;
  if (!(Number.isFinite(ratio) && ratio > 0 && ratio <= MAX_REBIN_RATIO && 1 / ratio <= MAX_REBIN_RATIO)) return empty;
  const bid = new Map<number, number>(), ask = new Map<number, number>();
  for (let i = 0; i < c.bins.length; i++) {
    const lo = c.bins[i]! * s0, hi = lo + s0;
    const first = Math.floor(lo / step), last = Math.ceil(hi / step) - 1;
    if (!(Number.isFinite(first) && Number.isFinite(last)) || last - first > MAX_REBIN_RATIO + 1) return empty;
    for (let k = first; k <= last; k++) {
      const share = (Math.min(hi, (k + 1) * step) - Math.max(lo, k * step)) / s0;
      if (!(share > 1e-12)) continue;
      bid.set(k, (bid.get(k) ?? 0) + c.bid[i]! * share);
      ask.set(k, (ask.get(k) ?? 0) + c.ask[i]! * share);
    }
    if (bid.size > MAX_REBIN_BINS) return empty;
  }
  const keys = [...bid.keys()].sort((a, b) => a - b);
  return { bins: Int32Array.from(keys), bid: Float32Array.from(keys, k => bid.get(k)!), ask: Float32Array.from(keys, k => ask.get(k)!) };
}
