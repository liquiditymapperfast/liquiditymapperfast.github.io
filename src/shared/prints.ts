import type { TradeLike } from './footprint.ts';

/**
 * One large market order (its fills added together, see `orders.ts`): the time of its first fill, the instrument, the taker's side, the
 * volume-weighted price, the USD notional, and for an order of several fills the lowest and highest price it reached and how many fills it
 * took. Prints recorded before orders were rebuilt carry none of the last three.
 */
export interface Print { t: number; id: string; side: 'buy' | 'sell'; price: number; usd: number; lo?: number; hi?: number; n?: number }
/** [time ms, instrument id, 'buy' | 'sell', price, USD notional] and, for an order of several fills, [..., lowest price, highest price, fills]. */
export type WirePrint = [number, string, 'buy' | 'sell', number, number] | [number, string, 'buy' | 'sell', number, number, number, number, number];
/** A print row as the stream takes it: a trade, or a rebuilt order with its span and fill count. */
export type PrintRow = TradeLike & { lo?: unknown; hi?: unknown; fills?: unknown };

/** Smallest trade kept. The browser raises its own floor when it draws or sounds; the server only has to keep what could matter. */
export const PRINT_FLOOR_USD = 25_000;
/** The most prints one answer carries (the largest of its window when more match). */
export const PRINTS_PER_ANSWER = 5_000;
const RETENTION_MS = 7 * 24 * 3_600_000;
/** Newest prints held in memory (older ones stay in SQLite). */
const MEMORY_MAX = 20_000;
const SEEN_MAX = 30_000;

/** Where large trades outlive the process (SQLite on the server, IndexedDB in the browser); loading is synchronous, saving may be queued. */
export interface PrintStore {
  /** The newest `limit` prints since `since`, oldest first. */
  load(since: number, limit: number): Print[];
  save(rows: Print[], expireBefore: number): void;
  /** Prints older than what memory holds, when the store can answer: the `limit` largest in [from, to) from `minUsd`, oldest first. */
  query?(from: number, to: number, minUsd: number, limit: number): Print[];
  close(): void;
}

/**
 * The `limit` largest of `prints` (in time order), oldest first; the newest win a tie. A window holds far more orders than an answer carries
 * (BTC records 3,000 to 5,000 an hour from $25,000), and the map draws only the largest in view: keeping the newest instead would show the
 * last forty minutes of a day and nothing before them.
 */
export function largestPrints(prints: readonly Print[], limit: number): Print[] {
  if (prints.length <= limit) return [...prints];
  const kept = new Set([...prints].sort((a, b) => b.usd - a.usd || b.t - a.t).slice(0, limit));
  return prints.filter(p => kept.has(p));
}

export const toWire = (p: Print): WirePrint => p.n !== undefined && p.n > 1 && p.lo !== undefined && p.hi !== undefined ? [p.t, p.id, p.side, p.price, p.usd, p.lo, p.hi, p.n] : [p.t, p.id, p.side, p.price, p.usd];

/** The span and fill count of a row, when it is an order of several fills whose span holds its price; otherwise nothing (a single fill). */
export function spanOf(row: { price: number; lo?: unknown; hi?: unknown; fills?: unknown }): { lo: number; hi: number; n: number } | null {
  const lo = Number(row.lo), hi = Number(row.hi), n = Number(row.fills);
  if (!Number.isInteger(n) || n < 2 || !(lo > 0) || !(hi >= lo) || row.price < lo * (1 - 1e-9) || row.price > hi * (1 + 1e-9)) return null;
  return { lo, hi, n };
}

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

  /** The smallest order kept (PRINT_FLOOR_USD; smaller for a coin that trades less than BTC). */
  readonly floorUsd: number;

  constructor(store: PrintStore | null = null, protected now: () => number = Date.now, retentionMs: number = RETENTION_MS, floorUsd: number = PRINT_FLOOR_USD) {
    this.#store = store; this.#retentionMs = retentionMs; this.floorUsd = floorUsd;
    if (store) for (const row of store.load(now() - retentionMs, MEMORY_MAX)) { this.#recent.push(row); this.#stored.add(`${row.id}|${row.t}|${row.price}|${row.usd}`); }
  }

  /** Take market orders (or single trades); returns the prints that are new and large enough, oldest first. */
  ingest(trades: Iterable<PrintRow>): Print[] {
    const added: Print[] = [];
    for (const trade of trades) {
      const id = String(trade.instrumentId ?? ''), key = String(trade.tradeId ?? '');
      const price = Number(trade.price), usd = Number(trade.notionalUsd ?? Number(trade.amount) * price);
      const t = Number(trade.sourceTimestamp ?? trade.receivedAt);
      const side = String(trade.side).toLowerCase();
      if (!id || !key || !(price > 0) || !(usd >= this.floorUsd) || !Number.isFinite(t) || (side !== 'buy' && side !== 'sell')) continue;
      let seen = this.#seen.get(id); if (!seen) { seen = new Set(); this.#seen.set(id, seen); }
      if (seen.has(key)) continue;
      seen.add(key);
      if (seen.size > SEEN_MAX) { const keep = [...seen].slice(-SEEN_MAX / 3); seen.clear(); for (const k of keep) seen.add(k); }
      if (this.#stored.has(`${id}|${t}|${price}|${usd}`)) continue;
      const span = spanOf({ price, lo: trade.lo, hi: trade.hi, fills: trade.fills });
      const print: Print = { t, id, side, price, usd, ...(span ? { lo: span.lo, hi: span.hi, n: span.n } : {}) };
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

  /** Prints in [from, to) of at least `minUsd`, oldest first; when more than `limit` match, the largest `limit` (see `largestPrints`). */
  query(from: number, to: number, minUsd = this.floorUsd, limit = PRINTS_PER_ANSWER): Print[] {
    const out: Print[] = [];
    const memoryStart = this.#recent[0]?.t ?? Infinity;
    if (this.#store?.query && from <= memoryStart) {
      // The store is asked through the millisecond memory begins at: prints share milliseconds, and the ones memory dropped from it
      // are not in memory. The ones it kept are, so they are left out of what the store answers.
      const kept = new Set<string>();
      for (const p of this.#recent) { if (p.t > memoryStart) break; kept.add(`${p.id}|${p.t}|${p.price}|${p.usd}`); }
      for (const p of this.#store.query(from, Math.min(to, memoryStart + 1), minUsd, limit)) if (!kept.has(`${p.id}|${p.t}|${p.price}|${p.usd}`)) out.push(p);
    }
    for (const p of this.#recent) if (p.t >= from && p.t < to && p.usd >= minUsd) out.push(p);
    return largestPrints(out, limit);
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
