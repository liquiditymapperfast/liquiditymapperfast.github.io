import { DatabaseSync } from 'node:sqlite';
import type { Column, ColumnStore } from './recorder.mts';
import { LT_LENGTH } from '../../shared/lt-sample.ts';
import type { LtMinute } from '../../shared/lt-windows.ts';

/**
 * The memory of a blob SQLite handed over, for typed arrays to view: its own buffer where it has one to itself (node:sqlite gives each blob
 * its own, at offset 0), else a copy. Copied every time, a week read back (some 230,000 minutes, 1.3 GB) was allocated twice, and the
 * copies took a sixth of a cold read (Research_Findings.md).
 */
function ownBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength && bytes.buffer instanceof ArrayBuffer ? bytes.buffer : bytes.slice().buffer;
}

/**
 * A stored row as a column, as `load` reads it: the blob is bins | bid | ask (one that is not whole is left out), and a tracker of another
 * length (another layout) or with no samples is left out.
 */
function columnOf(t: number, n: number, bytes: Uint8Array, tracker: { n: number; data: Uint8Array } | null): Column | null {
  const count = bytes.byteLength / 12;
  if (!Number.isInteger(count)) return null;
  const copy = ownBuffer(bytes);
  const column: Column = { t, n, bins: new Int32Array(copy, 0, count), bid: new Float32Array(copy, count * 4, count), ask: new Float32Array(copy, count * 8, count) };
  if (tracker && tracker.data.byteLength === LT_LENGTH * 4 && tracker.n > 0) { column.lt = new Float32Array(ownBuffer(tracker.data)); column.ltN = tracker.n; }
  return column;
}

/**
 * SQLite persistence for minute columns: one row per instrument-minute, blob = bins | bid | ask. The Liquidity Tracker kept with a minute
 * (`Column.lt`, its mean over `ltN` samples) is a row of its own table, so the depth rows and their reader stay as they were (their
 * blob's length says how many bins it holds) and a minute recorded before the tracker was kept simply has none.
 */
export class SqliteColumnStore implements ColumnStore {
  readonly #db: DatabaseSync;
  readonly #insert;
  readonly #insertLt;
  readonly #range;
  readonly #rangeLt;
  constructor(path: string) {
    this.#db = new DatabaseSync(path);
    this.#db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL;
      CREATE TABLE IF NOT EXISTS depth_columns (inst TEXT NOT NULL, t INTEGER NOT NULL, n INTEGER NOT NULL, step REAL NOT NULL, data BLOB NOT NULL, PRIMARY KEY (inst, t));
      CREATE TABLE IF NOT EXISTS depth_lt (inst TEXT NOT NULL, t INTEGER NOT NULL, n INTEGER NOT NULL, data BLOB NOT NULL, PRIMARY KEY (inst, t));`);
    this.#insert = this.#db.prepare('INSERT OR REPLACE INTO depth_columns (inst, t, n, step, data) VALUES (?, ?, ?, ?, ?)');
    this.#insertLt = this.#db.prepare('INSERT OR REPLACE INTO depth_lt (inst, t, n, data) VALUES (?, ?, ?, ?)');
    this.#range = this.#db.prepare(`SELECT c.t, c.n, c.data, l.n AS ltN, l.data AS lt FROM depth_columns c LEFT JOIN depth_lt l ON l.inst = c.inst AND l.t = c.t
      WHERE c.inst = ? AND c.t >= ? AND c.t < ? ORDER BY c.t`);
    // The same minutes without their books: a blob that is not whole is left out here as it is in `range` (length() reads no more than its size).
    this.#rangeLt = this.#db.prepare(`SELECT c.t, c.n, l.n AS ltN, l.data AS lt FROM depth_columns c LEFT JOIN depth_lt l ON l.inst = c.inst AND l.t = c.t
      WHERE c.inst = ? AND c.t >= ? AND c.t < ? AND length(c.data) % 12 = 0 ORDER BY c.t`);
  }
  /** One instrument's columns in [fromMs, toMs), oldest first, each with its tracker when one was kept. */
  range(instrumentId: string, fromMs: number, toMs: number): Column[] {
    if (!(toMs > fromMs)) return [];
    const out: Column[] = [];
    for (const row of this.#range.all(instrumentId, Math.floor(fromMs), Math.ceil(toMs)) as Iterable<{ t: number; n: number; data: Uint8Array; ltN: number | null; lt: Uint8Array | null }>) {
      const column = columnOf(row.t, row.n, row.data, row.lt && row.ltN ? { n: row.ltN, data: row.lt } : null);
      if (column) out.push(column);
    }
    return out;
  }
  /** One instrument's minutes in [fromMs, toMs), oldest first, each with its samples and the tracker kept with it (its books are not read: the Liquidity Tracker lane). */
  rangeLt(instrumentId: string, fromMs: number, toMs: number): LtMinute[] {
    if (!(toMs > fromMs)) return [];
    const rows = this.#rangeLt.all(instrumentId, Math.floor(fromMs), Math.ceil(toMs)) as { t: number; n: number; ltN: number | null; lt: Uint8Array | null }[];
    // The trackers of an hour are views of one buffer of its own: kept for a week of markets (the recorder keeps what it reads back, by the hour), a
    // buffer each would be more than twice the memory, and one buffer for the whole read would stay while any hour of it was kept.
    const HOUR = 3_600_000, perHour = new Map<number, number>();
    const kept = (row: (typeof rows)[number]): boolean => !!row.lt && !!row.ltN && row.ltN > 0 && row.lt.byteLength === LT_LENGTH * 4;
    for (const row of rows) if (kept(row)) { const h = Math.floor(row.t / HOUR); perHour.set(h, (perHour.get(h) ?? 0) + 1); }
    const slabs = new Map<number, { slab: Float32Array; used: number }>(), out: LtMinute[] = [];
    for (const row of rows) {
      const minute: LtMinute = { t: row.t, n: row.n };
      if (kept(row)) {
        const h = Math.floor(row.t / HOUR);
        let own = slabs.get(h);
        if (!own) { own = { slab: new Float32Array(perHour.get(h)! * LT_LENGTH), used: 0 }; slabs.set(h, own); }
        new Uint8Array(own.slab.buffer, own.used * LT_LENGTH * 4, LT_LENGTH * 4).set(row.lt!);
        minute.lt = own.slab.subarray(own.used * LT_LENGTH, (own.used + 1) * LT_LENGTH); minute.ltN = row.ltN!; own.used++;
      }
      out.push(minute);
    }
    return out;
  }
  /**
   * Per instrument, its first and last minute from `sinceMs` and the step its first was recorded on (the step the recorder keeps). It reads
   * the (inst, t) index alone, so a row whose blob is not whole (which `load` and `range` leave out, and `save` never writes) still counts
   * here: asking SQLite to look at the blobs takes it to the table and costs 2 to 11 s instead of some 70 ms (a week, 2026-10-12).
   */
  extent(sinceMs: number): Map<string, { first: number; last: number; step: number }> {
    const out = new Map<string, { first: number; last: number; step: number }>();
    const rows = this.#db.prepare(`SELECT inst, MIN(t) AS first, MAX(t) AS last, (SELECT step FROM depth_columns s WHERE s.inst = c.inst AND s.t >= ? ORDER BY s.t LIMIT 1) AS step
      FROM depth_columns c WHERE t >= ? GROUP BY inst`).all(sinceMs, sinceMs) as { inst: string; first: number; last: number; step: number }[];
    for (const row of rows) out.set(row.inst, { first: row.first, last: row.last, step: row.step });
    return out;
  }
  *load(sinceMs: number): Iterable<{ instrumentId: string; column: Column; step: number }> {
    // The tracker rows of the same minutes, by instrument and minute (a row of another length is from another layout: left out).
    const lt = new Map<string, { n: number; values: Float32Array }>();
    // In the key's order, so SQLite walks the (inst, t) index and reads only the rows of the day: without the order it read the whole table
    // (the minutes' rows of a week and more), at every start (2026-10-23).
    for (const row of this.#db.prepare('SELECT inst, t, n, data FROM depth_lt WHERE t >= ? ORDER BY inst, t').all(sinceMs) as Iterable<{ inst: string; t: number; n: number; data: Uint8Array }>) {
      if (row.data.byteLength !== LT_LENGTH * 4 || !(row.n > 0)) continue;
      lt.set(`${row.inst}|${row.t}`, { n: row.n, values: new Float32Array(ownBuffer(row.data)) });
    }
    const rows = this.#db.prepare('SELECT inst, t, n, step, data FROM depth_columns WHERE t >= ? ORDER BY inst, t').all(sinceMs);
    for (const row of rows as Iterable<{ inst: string; t: number; n: number; step: number; data: Uint8Array }>) {
      const bytes = row.data;
      const count = bytes.byteLength / 12;
      if (!Number.isInteger(count)) continue;
      const copy = ownBuffer(bytes), tracker = lt.get(`${row.inst}|${row.t}`);
      yield { instrumentId: row.inst, step: row.step, column: {
        t: row.t, n: row.n, bins: new Int32Array(copy, 0, count), bid: new Float32Array(copy, count * 4, count), ask: new Float32Array(copy, count * 8, count),
        ...(tracker ? { lt: tracker.values, ltN: tracker.n } : {}) } };
    }
  }
  save(instrumentId: string, column: Column, step: number): void {
    const count = column.bins.length;
    const data = new Uint8Array(count * 12);
    data.set(new Uint8Array(column.bins.buffer, column.bins.byteOffset, count * 4), 0);
    data.set(new Uint8Array(column.bid.buffer, column.bid.byteOffset, count * 4), count * 4);
    data.set(new Uint8Array(column.ask.buffer, column.ask.byteOffset, count * 4), count * 8);
    this.#insert.run(instrumentId, column.t, column.n, step, data);
    if (column.lt && column.lt.length === LT_LENGTH && (column.ltN ?? 0) > 0) this.#insertLt.run(instrumentId, column.t, column.ltN!, new Uint8Array(column.lt.buffer, column.lt.byteOffset, LT_LENGTH * 4).slice());
  }
  /**
   * Let go of the minutes before `beforeMs`. The rows are found through the (inst, t) index and deleted by rowid: `DELETE ... WHERE t < ?`
   * scanned the whole table, 1.4 GB of columns on Karl's PC (2026-10-23), with the server's loop held for it; the index's walk takes about
   * 0.2 s there.
   */
  prune(beforeMs: number): void {
    this.#db.prepare('DELETE FROM depth_columns WHERE rowid IN (SELECT rowid FROM depth_columns WHERE t < ?)').run(beforeMs);
    this.#db.prepare('DELETE FROM depth_lt WHERE rowid IN (SELECT rowid FROM depth_lt WHERE t < ?)').run(beforeMs);
  }
  close(): void { this.#db.close(); }
}
