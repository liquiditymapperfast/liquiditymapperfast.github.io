import { DatabaseSync } from 'node:sqlite';
import type { Column, ColumnStore } from './recorder.mts';

/** SQLite persistence for minute columns: one row per instrument-minute, blob = bins | bid | ask. */
export class SqliteColumnStore implements ColumnStore {
  readonly #db: DatabaseSync;
  readonly #insert;
  constructor(path: string) {
    this.#db = new DatabaseSync(path);
    this.#db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL;
      CREATE TABLE IF NOT EXISTS depth_columns (inst TEXT NOT NULL, t INTEGER NOT NULL, n INTEGER NOT NULL, step REAL NOT NULL, data BLOB NOT NULL, PRIMARY KEY (inst, t));`);
    this.#insert = this.#db.prepare('INSERT OR REPLACE INTO depth_columns (inst, t, n, step, data) VALUES (?, ?, ?, ?, ?)');
  }
  *load(sinceMs: number): Iterable<{ instrumentId: string; column: Column; step: number }> {
    const rows = this.#db.prepare('SELECT inst, t, n, step, data FROM depth_columns WHERE t >= ? ORDER BY inst, t').all(sinceMs);
    for (const row of rows as Iterable<{ inst: string; t: number; n: number; step: number; data: Uint8Array }>) {
      const bytes = row.data;
      const count = bytes.byteLength / 12;
      if (!Number.isInteger(count)) continue;
      const copy = bytes.slice().buffer;
      yield { instrumentId: row.inst, step: row.step, column: {
        t: row.t, n: row.n, bins: new Int32Array(copy, 0, count), bid: new Float32Array(copy, count * 4, count), ask: new Float32Array(copy, count * 8, count) } };
    }
  }
  save(instrumentId: string, column: Column, step: number): void {
    const count = column.bins.length;
    const data = new Uint8Array(count * 12);
    data.set(new Uint8Array(column.bins.buffer, column.bins.byteOffset, count * 4), 0);
    data.set(new Uint8Array(column.bid.buffer, column.bid.byteOffset, count * 4), count * 4);
    data.set(new Uint8Array(column.ask.buffer, column.ask.byteOffset, count * 4), count * 8);
    this.#insert.run(instrumentId, column.t, column.n, step, data);
  }
  prune(beforeMs: number): void { this.#db.prepare('DELETE FROM depth_columns WHERE t < ?').run(beforeMs); }
  close(): void { this.#db.close(); }
}
