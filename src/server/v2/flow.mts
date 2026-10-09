import { DatabaseSync } from 'node:sqlite';
import { FlowRecorder as FlowCore, type FlowMinuteRow, type FlowStore } from '../../shared/flow.ts';

export { FLOW_SEC, encodeFlowFrame, encodeFlowMinutes, type FlowFrame, type FlowUpdate } from '../../shared/flow.ts';

/**
 * Recorded flow minutes in the history database: one row per instrument-minute, the 60 buy seconds then the 60 sell seconds as Float32,
 * then the 60 price seconds (480 bytes, a row from before prices were kept, has no prices; 720 bytes has).
 */
const toRow = (row: { inst: string; t: number; data: Uint8Array }): FlowMinuteRow | null => {
  if (row.data.byteLength !== 480 && row.data.byteLength !== 720) return null;
  const copy = row.data.slice().buffer;
  return { inst: row.inst, t: row.t, buy: new Float32Array(copy, 0, 60), sell: new Float32Array(copy, 240, 60), ...(row.data.byteLength === 720 ? { px: new Float32Array(copy, 480, 60) } : {}) };
};

class SqliteFlowStore implements FlowStore {
  readonly #db: DatabaseSync;
  readonly #range;
  constructor(dbPath: string) {
    this.#db = new DatabaseSync(dbPath);
    this.#db.exec('PRAGMA journal_mode=WAL; CREATE TABLE IF NOT EXISTS flow_minutes (inst TEXT NOT NULL, t INTEGER NOT NULL, data BLOB NOT NULL, PRIMARY KEY (inst, t));');
    this.#range = this.#db.prepare('SELECT inst, t, data FROM flow_minutes WHERE inst = ? AND t >= ? AND t < ? ORDER BY t');
  }
  *load(since: number): Iterable<FlowMinuteRow> {
    for (const row of this.#db.prepare('SELECT inst, t, data FROM flow_minutes WHERE t >= ?').all(since) as { inst: string; t: number; data: Uint8Array }[]) {
      const minute = toRow(row); if (minute) yield minute;
    }
  }
  *range(inst: string, from: number, to: number): Iterable<FlowMinuteRow> {
    for (const row of this.#range.all(inst, from, to) as { inst: string; t: number; data: Uint8Array }[]) { const minute = toRow(row); if (minute) yield minute; }
  }
  save(rows: FlowMinuteRow[], expireBefore: number): void {
    const db = this.#db, insert = db.prepare('INSERT OR REPLACE INTO flow_minutes (inst, t, data) VALUES (?, ?, ?)');
    db.exec('BEGIN');
    try {
      for (const row of rows) {
        const data = new Uint8Array(720);
        data.set(new Uint8Array(row.buy.buffer, row.buy.byteOffset, 240), 0); data.set(new Uint8Array(row.sell.buffer, row.sell.byteOffset, 240), 240);
        if (row.px) data.set(new Uint8Array(row.px.buffer, row.px.byteOffset, 240), 480);
        insert.run(row.inst, row.t, data);
      }
      db.prepare('DELETE FROM flow_minutes WHERE t < ?').run(expireBefore);
      db.exec('COMMIT');
    } catch (error) { db.exec('ROLLBACK'); throw error; }
  }
  close(): void { this.#db.close(); }
}

/** Per-second taker flow persisted in SQLite (`dbPath`), or kept in memory when there is none. */
export class FlowRecorder extends FlowCore {
  constructor(dbPath: string | null = null, now: () => number = Date.now) { super(dbPath ? new SqliteFlowStore(dbPath) : null, now); }
}
