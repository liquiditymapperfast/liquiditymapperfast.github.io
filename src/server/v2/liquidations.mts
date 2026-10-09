import { DatabaseSync } from 'node:sqlite';
import { LiquidationStream as LiquidationCore, type Liquidation, type LiquidationStore } from '../../shared/liquidations.ts';

export { LIQUIDATION_FLOOR_USD, LIQUIDATIONS_PER_ANSWER, toWire } from '../../shared/liquidations.ts';

type Row = { t: number; inst: string; side: string; price: number; usd: number; reported: number; kind: string };
const asLiquidation = (row: Row): Liquidation | null =>
  (row.side === 'long' || row.side === 'short') && (row.kind === 'fill' || row.kind === 'bankruptcy')
    ? { t: row.t, id: row.inst, side: row.side, price: row.price, usd: row.usd, reported: row.reported, kind: row.kind } : null;
const COLUMNS = 't, inst, side, price, usd, reported, kind';

/** Liquidations in the history database. */
export class SqliteLiquidationStore implements LiquidationStore {
  readonly #db: DatabaseSync;
  constructor(dbPath: string) {
    this.#db = new DatabaseSync(dbPath);
    this.#db.exec('PRAGMA journal_mode=WAL; CREATE TABLE IF NOT EXISTS liquidations (t INTEGER NOT NULL, inst TEXT NOT NULL, side TEXT NOT NULL, price REAL NOT NULL, usd REAL NOT NULL, reported REAL NOT NULL, kind TEXT NOT NULL); CREATE INDEX IF NOT EXISTS liquidations_t ON liquidations(t);');
  }
  load(since: number, limit: number): Liquidation[] {
    const rows = this.#db.prepare(`SELECT ${COLUMNS} FROM liquidations WHERE t >= ? ORDER BY t DESC LIMIT ?`).all(since, limit) as Row[];
    return rows.reverse().flatMap(row => asLiquidation(row) ?? []);
  }
  query(from: number, to: number, minUsd: number, limit: number): Liquidation[] {
    const rows = this.#db.prepare(`SELECT ${COLUMNS}, rowid AS r FROM liquidations WHERE t >= ? AND t < ? AND usd >= ? ORDER BY usd DESC, t DESC, rowid DESC LIMIT ?`).all(from, to, minUsd, limit) as (Row & { r: number })[];
    return rows.sort((a, b) => a.t - b.t || a.r - b.r).flatMap(row => asLiquidation(row) ?? []);
  }
  save(rows: Liquidation[], expireBefore: number): void {
    const db = this.#db, insert = db.prepare('INSERT INTO liquidations (t, inst, side, price, usd, reported, kind) VALUES (?, ?, ?, ?, ?, ?, ?)');
    db.exec('BEGIN');
    try {
      for (const l of rows) insert.run(l.t, l.id, l.side, l.price, l.usd, l.reported, l.kind);
      db.prepare('DELETE FROM liquidations WHERE t < ?').run(expireBefore);
      db.exec('COMMIT');
    } catch (error) { db.exec('ROLLBACK'); throw error; }
  }
  close(): void { this.#db.close(); }
}

/** Liquidations across the venues that publish them, persisted in SQLite (`dbPath`) or kept in memory when there is none. */
export class LiquidationStream extends LiquidationCore {
  constructor(dbPath: string | null = null, now: () => number = Date.now) { super(dbPath ? new SqliteLiquidationStore(dbPath) : null, now); }
}
