/**
 * The long history's tiles (hlm-history, docs/proposals/long-history-tiles-2026-11-05.md, "v3: the contracts as built"): each book's minutes
 * merged into windows of 2 to 4096 minutes as the page merges them (`DepthRecorder.query`), finished once and sent as u16 levels, a pack of
 * windows per file. Complete packs never change; the open one is the level's `head.bin`, which also holds each book's window under way as
 * far as the service has folded hours (`through`). This module reads the files and does the pack arithmetic; `archive-source.ts` fetches them.
 */
import { LT_LENGTH } from '../../shared/lt-sample.ts';

const MINUTE = 60_000;
export const TILE_MAGIC = 'HLMT';
export const TILE_VERSION = 1;
/** Header: magic, version u16, level u16, pack start i64, windows per pack u16, flags u16, through i64, books u16. */
export const TILE_HEADER_BYTES = 30;
/** Levels the service builds (minutes, doubling): the page's zoom steps from 2 minutes up (a minute is the hour files themselves). */
export const TILE_LEVELS: readonly number[] = Array.from({ length: 12 }, (_, i) => 2 ** (i + 1));
/** The service's `latest.json` names the pack span in minutes; packs hold at most this many windows. */
export const MAX_PACK_WINDOWS = 128;
/** A level `q` is 1.01^(q-1) USD (0 is nothing): within half a percent of what the service finished. */
export const LEVEL_RATIO = 1.01;

/** `latest.json`'s `tiles` section: levels and the pack span in minutes, `through` (the hours folded so far) and `first` (the oldest window) in ms. */
export interface TilesInfo { v: 1; levels: number[]; packSpan: number; through: number; first: number }

/** The `tiles` section of a `latest.json` answer, or null when it has none or it is not one this page reads. */
export function parseTilesInfo(raw: unknown): TilesInfo | null {
  if (!raw || typeof raw !== 'object') return null;
  const t = raw as Record<string, unknown>;
  if (t.v !== 1 || !Array.isArray(t.levels)) return null;
  const levels = t.levels.filter((l): l is number => typeof l === 'number' && Number.isInteger(l) && l >= 2 && l <= 4096 && (l & (l - 1)) === 0);
  const span = t.packSpan, through = t.through, first = t.first;
  if (!levels.length || typeof span !== 'number' || !Number.isInteger(span) || span < 2 || (span & (span - 1)) !== 0) return null;
  if (typeof through !== 'number' || !Number.isFinite(through) || typeof first !== 'number' || !Number.isFinite(first) || first > through) return null;
  return { v: 1, levels: [...new Set(levels)].sort((a, b) => a - b), packSpan: span, through, first };
}

/** Windows per pack at level `L` minutes (K), for a pack span of `packSpan` minutes. */
export const packWindows = (level: number, packSpan: number): number => Math.max(1, Math.min(MAX_PACK_WINDOWS, Math.floor(packSpan / level)));
/** A pack's length in ms at level `L`: K windows of L minutes. */
export const packMs = (level: number, packSpan: number): number => packWindows(level, packSpan) * level * MINUTE;
/** The start of the pack holding the window at `t` (ms), aligned to a multiple of the pack's length since the epoch. */
export const packStartOf = (t: number, level: number, packSpan: number): number => { const len = packMs(level, packSpan); return Math.floor(t / len) * len; };
/** The starts of the packs that hold any window of [from, to) at level `L`. */
export function packStarts(from: number, to: number, level: number, packSpan: number): number[] {
  const len = packMs(level, packSpan), out: number[] = [];
  for (let s = Math.floor(from / len) * len; s < to; s += len) out.push(s);
  return out;
}

/** A complete pack's address and the open pack's (`base`: the coin's folder, `historyUrl`). */
export const packUrl = (base: string, level: number, start: number): string => `${base}/t/${level}/${String(start).padStart(13, '0')}.bin`;
export const headUrl = (base: string, level: number): string => `${base}/t/${level}/head.bin`;

/** One window of one book as the file holds it, with its levels turned back into USD. */
export interface TileColumn {
  t: number; n: number; step: number;
  bins: Int32Array; bid: Float32Array; ask: Float32Array;
  lt?: Float32Array; ltN: number;
  /** Its window had not ended when the file was made (the head's window under way, finished as far as `through`). */
  open: boolean;
  /** Its book's grid step changed inside the window: the window was closed early. */
  cut: boolean;
}
export interface TileFile { level: number; packStart: number; windows: number; head: boolean; through: number; books: Map<string, TileColumn[]> }

let levelTable: Float64Array | null = null;
/** USD for a level (`LEVEL_RATIO`), from a table made once. */
export function usdOfLevel(q: number): number {
  if (!levelTable) { levelTable = new Float64Array(65536); for (let i = 1; i < 65536; i++) levelTable[i] = LEVEL_RATIO ** (i - 1); }
  return levelTable[q]!;
}
/** The service's level for `usd` (what a test encoder writes): 0 below a dollar, else 1 + the nearest power of 1.01, at most 65535. */
export function levelOfUsd(usd: number): number {
  if (!(usd >= 1)) return 0;
  return Math.min(65535, 1 + Math.round(Math.log(usd) / Math.log(LEVEL_RATIO)));
}

/** A grid step outside this (USD) is not one a book is recorded on. */
export const MIN_TILE_STEP = 1e-9, MAX_TILE_STEP = 1e9;
/** No bin of a window holds more than this (the largest seen, 2026-11-05, was $46M): a level past it is not one the service wrote. */
export const MAX_BIN_USD = 1e12;
const MAX_LEVEL = levelOfUsd(MAX_BIN_USD);
/** A price past this ($ from zero) is not one a bin can stand for. */
const MAX_PRICE = 1e12;
/** Samples a window can hold: twelve a minute (one every 5 s), and a minute's worth to spare. */
export const maxSamples = (level: number): number => level * 12 + 12;

/**
 * Reads a tile file (a pack or a head), or null when it is not one this page can read: another format, a file cut short or with bytes after
 * its last book, or any number that is not one the service writes (a step, a sample count, a bin, a level, the tracker, a window twice).
 * The whole file is refused for any of these: a file the page draws is one the service wrote. With `packSpan` (`latest.json`'s), its windows
 * per pack must be the level's (`packWindows`).
 */
export function decodeTile(buffer: ArrayBuffer, packSpan?: number): TileFile | null {
  const view = new DataView(buffer), bytes = new Uint8Array(buffer);
  if (bytes.length < TILE_HEADER_BYTES || String.fromCharCode(bytes[0]!, bytes[1]!, bytes[2]!, bytes[3]!) !== TILE_MAGIC) return null;
  if (view.getUint16(4, true) !== TILE_VERSION) return null;
  const level = view.getUint16(6, true), packStart = Number(view.getBigInt64(8, true)), windows = view.getUint16(16, true);
  const flags = view.getUint16(18, true), through = Number(view.getBigInt64(20, true)), bookCount = view.getUint16(28, true);
  if (!TILE_LEVELS.includes(level) || !(windows >= 1 && windows <= MAX_PACK_WINDOWS)) return null;
  if (packSpan !== undefined && windows !== packWindows(level, packSpan)) return null;
  if (!Number.isSafeInteger(packStart) || packStart % (windows * level * MINUTE) !== 0 || !Number.isSafeInteger(through)) return null;
  const books = new Map<string, TileColumn[]>(), decoder = new TextDecoder('utf-8', { fatal: true }), samples = maxSamples(level);
  let at = TILE_HEADER_BYTES;
  const need = (n: number): boolean => at + n <= bytes.length;
  try {
    for (let b = 0; b < bookCount; b++) {
      if (!need(1)) return null;
      const idLen = bytes[at]!; at += 1;
      if (idLen === 0 || !need(idLen + 2)) return null;
      const id = decoder.decode(bytes.subarray(at, at + idLen)); at += idLen;
      if (books.has(id)) return null;
      const count = view.getUint16(at, true); at += 2;
      if (count > windows) return null;
      const columns: TileColumn[] = [], seen = new Set<number>();
      for (let c = 0; c < count; c++) {
        if (!need(2 + 1 + 4 + 8 + 4)) return null;
        const index = view.getUint16(at, true); at += 2;
        const cflags = bytes[at]!; at += 1;
        const n = view.getUint32(at, true); at += 4;
        const step = view.getFloat64(at, true); at += 8;
        const k = view.getUint32(at, true); at += 4;
        if (index >= windows || seen.has(index) || cflags > 3) return null;
        seen.add(index);
        if (!(n >= 1 && n <= samples) || !(step >= MIN_TILE_STEP && step <= MAX_TILE_STEP)) return null;
        // k bins of 4 + 2 + 2 bytes and the tracker's count: a count past what is left of the file is refused before anything is allocated.
        if (k > (bytes.length - at) / 8 || !need(k * 8 + 4)) return null;
        const bins = new Int32Array(k), bid = new Float32Array(k), ask = new Float32Array(k);
        let bin = 0;
        for (let i = 0; i < k; i++) {
          const next = i ? bin + view.getInt32(at, true) : view.getInt32(at, true);
          // Ascending, within an i32 (a delta that would wrap is refused, not wrapped), and a price a bin can stand for.
          if ((i && next <= bin) || next > 2_147_483_647 || next < -2_147_483_648 || !(Math.abs(next * step) <= MAX_PRICE)) return null;
          bins[i] = bin = next; at += 4;
        }
        for (let i = 0; i < k; i++) { const q = view.getUint16(at, true); if (q > MAX_LEVEL) return null; bid[i] = usdOfLevel(q); at += 2; }
        for (let i = 0; i < k; i++) { const q = view.getUint16(at, true); if (q > MAX_LEVEL) return null; ask[i] = usdOfLevel(q); at += 2; }
        const ltN = view.getUint32(at, true); at += 4;
        if (ltN > n) return null;
        let lt: Float32Array | undefined;
        // The tracker as the service finished it (f32: its weight sums can be under a dollar's level).
        if (ltN > 0) {
          if (!need(LT_LENGTH * 4)) return null;
          lt = new Float32Array(LT_LENGTH);
          for (let i = 0; i < LT_LENGTH; i++) {
            const v = view.getFloat32(at, true);
            if (!(v >= 0 && v <= MAX_BIN_USD * 1e3)) return null;
            lt[i] = v; at += 4;
          }
        }
        columns.push({ t: packStart + index * level * MINUTE, n, step, bins, bid, ask, ...(lt ? { lt } : {}), ltN, open: (cflags & 1) !== 0, cut: (cflags & 2) !== 0 });
      }
      columns.sort((a, b) => a.t - b.t);
      books.set(id, columns);
    }
  } catch { return null; }
  if (at !== bytes.length) return null;
  return { level, packStart, windows, head: (flags & 1) !== 0, through, books };
}
