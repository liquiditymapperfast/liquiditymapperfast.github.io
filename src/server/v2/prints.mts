import { DatabaseSync } from 'node:sqlite';
import { PrintStream as PrintCore, spanOf, type Print, type PrintStore } from '../../shared/prints.ts';

export { PRINT_FLOOR_USD, toWire, type Print, type WirePrint } from '../../shared/prints.ts';

type Row = { t: number; inst: string; side: string; price: number; usd: number; lo: number | null; hi: number | null; n: number | null };
const asPrint = (row: Row): Print | null => {
  if (row.side !== 'buy' && row.side !== 'sell') return null;
  const span = spanOf({ price: row.price, lo: row.lo, hi: row.hi, fills: row.n });
  return { t: row.t, id: row.inst, side: row.side, price: row.price, usd: row.usd, ...(span ? { lo: span.lo, hi: span.hi, n: span.n } : {}) };
};
const COLUMNS = 't, inst, side, price, usd, lo, hi, n';

/** Large market orders in the history database (rows written before orders were rebuilt have no span or fill count). */
export class SqlitePrintStore implements PrintStore {
  readonly #db: DatabaseSync;
  constructor(dbPath: string) {
    this.#db = new DatabaseSync(dbPath);
    this.#db.exec('PRAGMA journal_mode=WAL; CREATE TABLE IF NOT EXISTS prints (t INTEGER NOT NULL, inst TEXT NOT NULL, side TEXT NOT NULL, price REAL NOT NULL, usd REAL NOT NULL); CREATE INDEX IF NOT EXISTS prints_t ON prints(t);');
    // Databases written before orders were rebuilt gain the span and the fill count; their old rows simply have none.
    const columns = new Set((this.#db.prepare('PRAGMA table_info(prints)').all() as { name: string }[]).map(column => column.name));
    for (const [name, type] of [['lo', 'REAL'], ['hi', 'REAL'], ['n', 'INTEGER']] as const) if (!columns.has(name)) this.#db.exec(`ALTER TABLE prints ADD COLUMN ${name} ${type}`);
  }
  load(since: number, limit: number): Print[] {
    const rows = this.#db.prepare(`SELECT ${COLUMNS} FROM prints WHERE t >= ? ORDER BY t DESC LIMIT ?`).all(since, limit) as Row[];
    return rows.reverse().flatMap(row => asPrint(row) ?? []);
  }
  query(from: number, to: number, minUsd: number, limit: number): Print[] {
    // The newest matches are the ones kept when there are more than `limit` (the stream's contract): select from the newest end, then put them back in order.
    const rows = this.#db.prepare(`SELECT ${COLUMNS} FROM prints WHERE t >= ? AND t < ? AND usd >= ? ORDER BY t DESC, rowid DESC LIMIT ?`).all(from, to, minUsd, limit) as Row[];
    return rows.reverse().flatMap(row => asPrint(row) ?? []);
  }
  save(rows: Print[], expireBefore: number): void {
    const db = this.#db, insert = db.prepare('INSERT INTO prints (t, inst, side, price, usd, lo, hi, n) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
    db.exec('BEGIN');
    try {
      for (const p of rows) insert.run(p.t, p.id, p.side, p.price, p.usd, p.lo ?? null, p.hi ?? null, p.n ?? null);
      db.prepare('DELETE FROM prints WHERE t < ?').run(expireBefore);
      db.exec('COMMIT');
    } catch (error) { db.exec('ROLLBACK'); throw error; }
  }
  close(): void { this.#db.close(); }
}

/** Large trades across all venues, persisted in SQLite (`dbPath`) or kept in memory when there is none. */
export class PrintStream extends PrintCore {
  constructor(dbPath: string | null = null, now: () => number = Date.now) { super(dbPath ? new SqlitePrintStore(dbPath) : null, now); }
}
