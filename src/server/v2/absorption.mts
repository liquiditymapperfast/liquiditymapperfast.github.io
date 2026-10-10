import { DatabaseSync } from 'node:sqlite';
import { AbsorptionRecorder as AbsorptionCore, peakOf, type AbsorptionGroup, type AbsorptionMinute, type AbsorptionStep, type AbsorptionStore } from '../../shared/absorption.ts';

export { ABSORPTION_WINDOW_MS, GROUP_FLOOR_USD, GROUPS_PER_MINUTE, MAX_ABSORPTION_INSTRUMENTS, type AbsorptionAnswer, type AbsorptionGroup, type AbsorptionMinute } from '../../shared/absorption.ts';

type GroupRow = { inst: string; t0: number; side: string; price: number; steps: string };
type MinuteRow = { inst: string; t: number; n: number; mean: number; m2: number; floor: number };

/** Steps as stored: rows of five finite numbers, credits falling; anything else is not a group. */
function stepsOf(text: string): AbsorptionStep[] | null {
  try {
    const steps = JSON.parse(text) as unknown;
    if (!Array.isArray(steps) || !steps.length) return null;
    for (const s of steps) if (!Array.isArray(s) || s.length !== 5 || !s.every(x => typeof x === 'number' && Number.isFinite(x))) return null;
    return steps as AbsorptionStep[];
  } catch { return null; }
}
const asGroup = (row: GroupRow): AbsorptionGroup | null => {
  const steps = stepsOf(row.steps);
  return steps && (row.side === 'buy' || row.side === 'sell') ? { id: row.inst, side: row.side, price: row.price, t0: row.t0, steps } : null;
};
const asMinute = (row: MinuteRow): AbsorptionMinute => ({ id: row.inst, t: row.t, n: row.n, mean: row.mean, m2: row.m2, floor: row.floor });
const placeholders = (n: number): string => Array.from({ length: n }, () => '?').join(',');

/** Absorption candidates and window statistics in the history database, next to the depth columns. */
class SqliteAbsorptionStore implements AbsorptionStore {
  readonly #db: DatabaseSync;
  constructor(dbPath: string) {
    this.#db = new DatabaseSync(dbPath);
    this.#db.exec(`PRAGMA journal_mode=WAL;
      CREATE TABLE IF NOT EXISTS absorption_groups (inst TEXT NOT NULL, t0 INTEGER NOT NULL, side TEXT NOT NULL, price REAL NOT NULL, peak REAL NOT NULL, steps TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS absorption_groups_t0 ON absorption_groups(t0);
      CREATE INDEX IF NOT EXISTS absorption_groups_inst_t0 ON absorption_groups(inst, t0);
      CREATE TABLE IF NOT EXISTS absorption_minutes (inst TEXT NOT NULL, t INTEGER NOT NULL, n INTEGER NOT NULL, mean REAL NOT NULL, m2 REAL NOT NULL, floor REAL NOT NULL, PRIMARY KEY (inst, t));`);
    // One row per group: a group found again (trades a venue sent again after a restart) is not drawn twice. A table from before this
    // index loses its copies first.
    this.#db.exec(`DELETE FROM absorption_groups WHERE rowid NOT IN (SELECT MIN(rowid) FROM absorption_groups GROUP BY inst, t0, side, price);
      CREATE UNIQUE INDEX IF NOT EXISTS absorption_groups_key ON absorption_groups(inst, t0, side, price);`);
  }
  load(since: number): { groups: AbsorptionGroup[]; minutes: AbsorptionMinute[] } {
    const groups = (this.#db.prepare('SELECT inst, t0, side, price, steps FROM absorption_groups WHERE t0 >= ? ORDER BY t0').all(since) as GroupRow[]).flatMap(row => asGroup(row) ?? []);
    const minutes = (this.#db.prepare('SELECT inst, t, n, mean, m2, floor FROM absorption_minutes WHERE t >= ?').all(since) as MinuteRow[]).map(asMinute);
    return { groups, minutes };
  }
  query(ids: readonly string[], mins: readonly number[], from: number, to: number, limit: number): AbsorptionGroup[] {
    const statement = this.#db.prepare('SELECT inst, t0, side, price, steps FROM absorption_groups WHERE inst = ? AND t0 >= ? AND t0 < ? AND peak >= ? ORDER BY peak DESC LIMIT ?');
    return ids.flatMap((id, i) => (statement.all(id, from, to, mins[i] ?? Number.MAX_VALUE, limit) as GroupRow[]).flatMap(row => asGroup(row) ?? []));
  }
  minutes(ids: readonly string[], from: number, to: number): AbsorptionMinute[] {
    if (!ids.length) return [];
    return (this.#db.prepare(`SELECT inst, t, n, mean, m2, floor FROM absorption_minutes WHERE t >= ? AND t < ? AND inst IN (${placeholders(ids.length)})`).all(from, Number.isFinite(to) ? to : Number.MAX_SAFE_INTEGER, ...ids) as MinuteRow[]).map(asMinute);
  }
  save(groups: AbsorptionGroup[], minutes: AbsorptionMinute[], expireBefore: number): void {
    const db = this.#db;
    // The first row stands, for groups and minutes alike (see the recorder).
    const group = db.prepare('INSERT OR IGNORE INTO absorption_groups (inst, t0, side, price, peak, steps) VALUES (?, ?, ?, ?, ?, ?)');
    const minute = db.prepare('INSERT OR IGNORE INTO absorption_minutes (inst, t, n, mean, m2, floor) VALUES (?, ?, ?, ?, ?, ?)');
    db.exec('BEGIN');
    try {
      for (const g of groups) group.run(g.id, g.t0, g.side, g.price, peakOf(g), JSON.stringify(g.steps));
      for (const m of minutes) minute.run(m.id, m.t, m.n, m.mean, m.m2, m.floor);
      db.prepare('DELETE FROM absorption_groups WHERE t0 < ?').run(expireBefore);
      db.prepare('DELETE FROM absorption_minutes WHERE t < ?').run(expireBefore);
      db.exec('COMMIT');
    } catch (error) { db.exec('ROLLBACK'); throw error; }
  }
  close(): void { this.#db.close(); }
}

/** The absorption recorder persisted in SQLite (`dbPath`), or kept in memory when there is none. */
export class AbsorptionRecorder extends AbsorptionCore {
  constructor(dbPath: string | null = null, now: () => number = Date.now, options?: { floorUsd?: number }) { super(dbPath ? new SqliteAbsorptionStore(dbPath) : null, now, options); }
}
