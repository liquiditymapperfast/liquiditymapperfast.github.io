import { DatabaseSync } from 'node:sqlite';
import { FootprintRecorder as FootprintCore, parseStats, type FootprintMinuteRow, type FootprintStore } from '../../shared/footprint.ts';

export { SIZE_EDGES, sizeBucket, parseStats, type TradeLike, type FootprintRow, type FootprintBar, type TradeStats } from '../../shared/footprint.ts';

/** Recorded minutes in the history database, next to the depth columns. */
class SqliteFootprintStore implements FootprintStore {
  readonly #db: DatabaseSync;
  constructor(dbPath: string) {
    this.#db = new DatabaseSync(dbPath);
    this.#db.exec(`PRAGMA journal_mode=WAL; CREATE TABLE IF NOT EXISTS footprint_minutes (inst TEXT NOT NULL, t INTEGER NOT NULL, step REAL NOT NULL, rows TEXT NOT NULL, PRIMARY KEY (inst, t));`);
    // Databases written before trade stats existed gain the column; their old minutes simply have none.
    if (!(this.#db.prepare('PRAGMA table_info(footprint_minutes)').all() as { name: string }[]).some(column => column.name === 'stats')) this.#db.exec('ALTER TABLE footprint_minutes ADD COLUMN stats TEXT');
  }
  *load(since: number): Iterable<FootprintMinuteRow> {
    for (const row of this.#db.prepare('SELECT inst, t, step, rows, stats FROM footprint_minutes WHERE t >= ?').all(since) as { inst: string; t: number; step: number; rows: string; stats: string | null }[])
      yield { inst: row.inst, t: row.t, step: row.step, bins: JSON.parse(row.rows) as [number, number, number][], stats: parseStats(row.stats) };
  }
  save(rows: FootprintMinuteRow[], expireBefore: number): void {
    const db = this.#db, insert = db.prepare('INSERT OR REPLACE INTO footprint_minutes (inst, t, step, rows, stats) VALUES (?, ?, ?, ?, ?)');
    db.exec('BEGIN');
    try {
      for (const row of rows) insert.run(row.inst, row.t, row.step, JSON.stringify(row.bins), row.stats ? JSON.stringify([row.stats.buyN, row.stats.sellN, row.stats.buy, row.stats.sell]) : null);
      db.prepare('DELETE FROM footprint_minutes WHERE t < ?').run(expireBefore);
      db.exec('COMMIT');
    } catch (error) { db.exec('ROLLBACK'); throw error; }
  }
  close(): void { this.#db.close(); }
}

/** The footprint recorder persisted in SQLite (`dbPath`), or kept in memory when there is none. */
export class FootprintRecorder extends FootprintCore {
  constructor(dbPath: string | null = null, now: () => number = Date.now) { super(dbPath ? new SqliteFootprintStore(dbPath) : null, now); }
}
