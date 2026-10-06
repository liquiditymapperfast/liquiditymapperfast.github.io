import type { TradeLike } from './footprint.ts';

/** One large executed trade, in the compact form sent to the browser: [time ms, instrument id, 'buy' | 'sell', price, USD notional]. */
export interface Print { t: number; id: string; side: 'buy' | 'sell'; price: number; usd: number }
export type WirePrint = [number, string, 'buy' | 'sell', number, number];

/** Smallest trade kept. The browser raises its own floor when it draws or sounds; the server only has to keep what could matter. */
export const PRINT_FLOOR_USD = 25_000;
const RETENTION_MS = 7 * 24 * 3_600_000;
/** Newest prints held in memory (older ones stay in SQLite). */
const MEMORY_MAX = 20_000;
const SEEN_MAX = 30_000;

/** Where large trades outlive the process (SQLite on the server, IndexedDB in the browser); loading is synchronous, saving may be queued. */
export interface PrintStore {
  /** The newest `limit` prints since `since`, oldest first. */
  load(since: number, limit: number): Print[];
  save(rows: Print[], expireBefore: number): void;
  /** Prints older than what memory holds, when the store can answer. */
  query?(from: number, to: number, minUsd: number, limit: number): Print[];
  close(): void;
}

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
  readonly #store: PrintStore | null;
  readonly #retentionMs: number;
  #unsaved: Print[] = [];

  constructor(store: PrintStore | null = null, protected now: () => number = Date.now, retentionMs: number = RETENTION_MS) {
    this.#store = store; this.#retentionMs = retentionMs;
    if (store) for (const row of store.load(now() - retentionMs, MEMORY_MAX)) { this.#recent.push(row); this.#stored.add(`${row.id}|${row.t}|${row.price}|${row.usd}`); }
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
    if (this.#store?.query && from < memoryStart) out.push(...this.#store.query(from, Math.min(to, memoryStart), minUsd, limit));
    for (const p of this.#recent) if (p.t >= from && p.t < to && p.usd >= minUsd) out.push(p);
    return out.length > limit ? out.slice(out.length - limit) : out;
  }

  /** Write what has not been saved and drop expired rows, from memory as well as from the store. */
  flush(): void {
    const cutoff = this.now() - this.#retentionMs;
    let expired = 0; while (expired < this.#recent.length && this.#recent[expired]!.t < cutoff) expired++;
    if (expired) this.#recent.splice(0, expired);
    const store = this.#store; if (!store) { this.#unsaved = []; return; }
    store.save(this.#unsaved, cutoff); this.#unsaved = [];
  }
  close(): void { this.flush(); this.#store?.close(); }
}
