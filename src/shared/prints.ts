import { DatabaseSync } from 'node:sqlite';
import type { TradeLike } from './footprint.mts';

/** One large executed trade, in the compact form sent to the browser: [time ms, instrument id, 'buy' | 'sell', price, USD notional]. */
export interface Print { t: number; id: string; side: 'buy' | 'sell'; price: number; usd: number }
export type WirePrint = [number, string, 'buy' | 'sell', number, number];

/** Smallest trade kept. The browser raises its own floor when it draws or sounds; the server only has to keep what could matter. */
export const PRINT_FLOOR_USD = 25_000;
const RETENTION_MS = 7 * 24 * 3_600_000;
/** Newest prints held in memory (older ones stay in SQLite). */
const MEMORY_MAX = 20_000;
const SEEN_MAX = 30_000;

export const toWire = (p: Print): WirePrint => [p.t, p.id, p.side, p.price, p.usd];

/**
 * Large trades across all venues, deduplicated by venue trade id, kept for a week so a reload still shows the bubbles and the browser
 * can sound new ones as they arrive. Nothing here decides what is interesting beyond the size floor.
 */
export class PrintStream {
  readonly #recent: Print[] = [];
  readonly #seen = new Map<string, Set<string>>();
  /** Prints loaded from disk by their content, so a trade the feed repeats after a restart is not counted twice. */
  readonly #stored = new Set<string>();
  readonly #fresh: Print[] = [];
  readonly #db: DatabaseSync | null;
  #unsaved: Print[] = [];

  constructor(dbPath: string | null = null, private now: () => number = Date.now) {
    this.#db = dbPath ? new DatabaseSync(dbPath) : null;
    if (this.#db) {
      this.#db.exec('PRAGMA journal_mode=WAL; CREATE TABLE IF NOT EXISTS prints (t INTEGER NOT NULL, inst TEXT NOT NULL, side TEXT NOT NULL, price REAL NOT NULL, usd REAL NOT NULL); CREATE INDEX IF NOT EXISTS prints_t ON prints(t);');
      const rows = this.#db.prepare('SELECT t, inst, side, price, usd FROM prints WHERE t >= ? ORDER BY t DESC LIMIT ?').all(now() - RETENTION_MS, MEMORY_MAX) as { t: number; inst: string; side: string; price: number; usd: number }[];
      for (const row of rows.reverse()) if (row.side === 'buy' || row.side === 'sell') { this.#recent.push({ t: row.t, id: row.inst, side: row.side, price: row.price, usd: row.usd }); this.#stored.add(`${row.inst}|${row.t}|${row.price}|${row.usd}`); }
    }
  }

  /** Take trades from the live feed; returns the prints that are new and large enough, oldest first. */
  ingest(trades: Iterable<TradeLike>): Print[] {
    const added: Print[] = [];
    for (const trade of trades) {
      const id = String(trade.instrumentId ?? ''), key = String(trade.tradeId ?? '');
      const price = Number(trade.price), usd = Number(trade.notionalUsd ?? Number(trade.amount) * price);
      const t = Number(trade.sourceTimestamp ?? trade.receivedAt);
      const side = String(trade.side).toLowerCase();
      if (!id || !key || !(price > 0) || !(usd >= PRINT_FLOOR_USD) || !Number.isFinite(t) || (side !== 'buy' && side !== 'sell')) continue;
      let seen = this.#seen.get(id); if (!seen) { seen = new Set(); this.#seen.set(id, seen); }
      if (seen.has(key)) continue;
      seen.add(key);
      if (seen.size > SEEN_MAX) { const keep = [...seen].slice(-SEEN_MAX / 3); seen.clear(); for (const k of keep) seen.add(k); }
      if (this.#stored.has(`${id}|${t}|${price}|${usd}`)) continue;
      const print: Print = { t, id, side, price, usd };
      added.push(print); this.#unsaved.push(print);
    }
    added.sort((a, b) => a.t - b.t);
    for (const print of added) { this.#recent.push(print); this.#fresh.push(print); }
    // Feeds interleave, so keep memory ordered by time (appends are almost always in order already).
    const before = this.#recent[this.#recent.length - added.length - 1];
    if (added.length && before && before.t > added[0]!.t) this.#recent.sort((a, b) => a.t - b.t);
    if (this.#recent.length > MEMORY_MAX) this.#recent.splice(0, this.#recent.length - MEMORY_MAX);
    return added;
  }

  /** Prints added since the last call, for broadcasting. */
  takeFresh(): Print[] { return this.#fresh.splice(0); }

  /** Prints in [from, to) of at least `minUsd`, oldest first; when more than `limit` match, the oldest are left out. */
  query(from: number, to: number, minUsd = PRINT_FLOOR_USD, limit = 5_000): Print[] {
    const out: Print[] = [];
    const memoryStart = this.#recent[0]?.t ?? Infinity;
    if (this.#db && from < memoryStart) {
      const rows = this.#db.prepare('SELECT t, inst, side, price, usd FROM prints WHERE t >= ? AND t < ? AND usd >= ? ORDER BY t ASC LIMIT ?').all(from, Math.min(to, memoryStart), minUsd, limit) as { t: number; inst: string; side: string; price: number; usd: number }[];
      for (const row of rows) if (row.side === 'buy' || row.side === 'sell') out.push({ t: row.t, id: row.inst, side: row.side, price: row.price, usd: row.usd });
    }
    for (const p of this.#recent) if (p.t >= from && p.t < to && p.usd >= minUsd) out.push(p);
    return out.length > limit ? out.slice(out.length - limit) : out;
  }

  /** Write what has not been saved and drop expired rows. */
  flush(): void {
    const db = this.#db; if (!db) { this.#unsaved = []; return; }
    const insert = db.prepare('INSERT INTO prints (t, inst, side, price, usd) VALUES (?, ?, ?, ?, ?)');
    db.exec('BEGIN');
    try {
      for (const p of this.#unsaved) insert.run(p.t, p.id, p.side, p.price, p.usd);
      db.prepare('DELETE FROM prints WHERE t < ?').run(this.now() - RETENTION_MS);
      db.exec('COMMIT'); this.#unsaved = [];
    } catch (error) { db.exec('ROLLBACK'); throw error; }
  }
  close(): void { this.flush(); this.#db?.close(); }
}
