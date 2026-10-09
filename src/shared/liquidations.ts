/**
 * Forced closes of leveraged positions, as the exchanges that publish them report them: Binance (at most one per market a second, its
 * largest, so a cascade is undercounted), Bybit, OKX and Deribit (flagged fills). Hyperliquid, Coinbase and the other venues publish none.
 *
 * A venue reports one of two prices. Binance, OKX and Deribit give a price at the market, where the forced order went (OKX names its
 * price the bankruptcy price, but it was measured within a few basis points of the mark); Bybit gives the position's bankruptcy price,
 * where its margin ran out, about 0.3 % past the mark, which the market need not have traded at. A liquidation is drawn where the market
 * was: at the fill price, or for a bankruptcy price at the instrument's last trade within a minute of the liquidation (the reported price
 * when none was, as for one the venue sent late); the reported price is kept beside it and said in its box.
 */

/** Which positions were closed: longs (the forced order sold) or shorts (it bought). */
export type LiquidatedSide = 'long' | 'short';
/** What the price a venue reports is: the forced order's fill price, or the position's bankruptcy price. */
export type ReportedKind = 'fill' | 'bankruptcy';

/** One liquidation as a connector reports it: price as the venue gives it (one coin's), size in coins and in USD. */
export interface LiquidationEvent { instrumentId: string; t: number; side: LiquidatedSide; price: number; amount: number; notionalUsd: number; kind: ReportedKind }

/** A liquidation as it is kept and drawn: `price` is where the market was, `reported` the venue's own price and `kind` what that one is. */
export interface Liquidation { t: number; id: string; side: LiquidatedSide; price: number; usd: number; reported: number; kind: ReportedKind }
/** [time ms, instrument id, side, price drawn at, USD, reported price, kind]. */
export type WireLiquidation = [number, string, LiquidatedSide, number, number, number, ReportedKind];

/** The smallest liquidation kept (smaller for a coin that trades less than BTC). They are few (BTC: about 150 an hour on a calm day, half of them under $1,000), so nearly all are. */
export const LIQUIDATION_FLOOR_USD = 100;
/** The most liquidations one answer carries (the largest of its window when more match). */
export const LIQUIDATIONS_PER_ANSWER = 5_000;
const RETENTION_MS = 7 * 24 * 3_600_000;
const MEMORY_MAX = 20_000;
const SEEN_MAX = 20_000;
/** A last traded price further than this from a liquidation's own time is not taken for where the market was then. */
const PRICE_FRESH_MS = 60_000;

/** The venues that publish liquidations, and how completely (the rest publish none). */
export const LIQUIDATION_COVERAGE: Readonly<Record<string, 'all' | 'throttled'>> = { binance: 'throttled', bybit: 'all', okx: 'all', deribit: 'all' };

export const toWire = (l: Liquidation): WireLiquidation => [l.t, l.id, l.side, l.price, l.usd, l.reported, l.kind];

/** Check one wire row: seven fields of the right kinds, otherwise null (a malformed row is dropped, never drawn). */
export function fromWire(row: unknown): Liquidation | null {
  if (!Array.isArray(row) || row.length < 7) return null;
  const [t, id, side, price, usd, reported, kind] = row as unknown[];
  if (typeof t !== 'number' || !Number.isFinite(t) || typeof id !== 'string' || !id || (side !== 'long' && side !== 'short')) return null;
  if (typeof price !== 'number' || !(price > 0) || typeof usd !== 'number' || !(usd > 0) || typeof reported !== 'number' || !(reported > 0)) return null;
  if (kind !== 'fill' && kind !== 'bankruptcy') return null;
  return { t, id, side, price, usd, reported, kind };
}

/** The content a liquidation is known by: the venues give them no id, and a feed can send one again after a reconnect. */
const keyOf = (l: { id: string; t: number; side: string; reported: number; usd: number }): string => `${l.id}|${l.t}|${l.side}|${l.reported}|${Math.round(l.usd * 100)}`;

/** Where liquidations outlive the process (SQLite on the server; the browser keeps them in memory). */
export interface LiquidationStore {
  /** The newest `limit` since `since`, oldest first. */
  load(since: number, limit: number): Liquidation[];
  save(rows: Liquidation[], expireBefore: number): void;
  /** Liquidations older than what memory holds: the `limit` largest in [from, to) from `minUsd`, oldest first. */
  query?(from: number, to: number, minUsd: number, limit: number): Liquidation[];
  close(): void;
}

/** The `limit` largest of `rows` (in time order), oldest first; the newest win a tie. */
export function largestLiquidations(rows: readonly Liquidation[], limit: number): Liquidation[] {
  if (rows.length <= limit) return [...rows];
  const kept = new Set([...rows].sort((a, b) => b.usd - a.usd || b.t - a.t).slice(0, limit));
  return rows.filter(l => kept.has(l));
}

/**
 * Liquidations across the venues that publish them, deduplicated by content, kept for a week. `ingest` places each one: a fill price is
 * where the market was; for a bankruptcy price the instrument's last traded price is (`marketPrice`), when it came within a minute of it.
 */
export class LiquidationStream {
  readonly #recent: Liquidation[] = [];
  readonly #seen = new Set<string>();
  readonly #fresh: Liquidation[] = [];
  readonly #store: LiquidationStore | null;
  readonly #retentionMs: number;
  #unsaved: Liquidation[] = [];
  /** The smallest liquidation kept (LIQUIDATION_FLOOR_USD; smaller for a coin that trades less than BTC). */
  readonly floorUsd: number;

  constructor(store: LiquidationStore | null = null, protected now: () => number = Date.now, retentionMs: number = RETENTION_MS, floorUsd: number = LIQUIDATION_FLOOR_USD) {
    this.#store = store; this.#retentionMs = retentionMs; this.floorUsd = floorUsd;
    if (store) for (const row of store.load(now() - retentionMs, MEMORY_MAX)) { this.#recent.push(row); this.#seen.add(keyOf(row)); }
  }

  /** Take liquidation events; returns the ones that are new and large enough, oldest first. */
  ingest(events: Iterable<LiquidationEvent>, marketPrice: (id: string) => { price: number; at: number } | null = () => null): Liquidation[] {
    const added: Liquidation[] = [];
    for (const e of events) {
      if (!e.instrumentId || !Number.isFinite(e.t) || !(e.price > 0) || !(e.notionalUsd >= this.floorUsd) || (e.side !== 'long' && e.side !== 'short')) continue;
      // The last trade is where the market was only if it came near the liquidation's own time: a venue can send one minutes late (OKX did, by eight).
      const market = e.kind === 'bankruptcy' ? marketPrice(e.instrumentId) : null;
      const price = market && market.price > 0 && Math.abs(e.t - market.at) <= PRICE_FRESH_MS ? market.price : e.price;
      const row: Liquidation = { t: e.t, id: e.instrumentId, side: e.side, price, usd: e.notionalUsd, reported: e.price, kind: e.kind };
      const key = keyOf(row);
      if (this.#seen.has(key)) continue;
      this.#seen.add(key);
      if (this.#seen.size > SEEN_MAX) { const keep = [...this.#seen].slice(-SEEN_MAX / 2); this.#seen.clear(); for (const k of keep) this.#seen.add(k); }
      added.push(row); this.#unsaved.push(row);
    }
    added.sort((a, b) => a.t - b.t);
    for (const row of added) { this.#recent.push(row); this.#fresh.push(row); }
    const before = this.#recent[this.#recent.length - added.length - 1];
    if (added.length && before && before.t > added[0]!.t) this.#recent.sort((a, b) => a.t - b.t);
    if (this.#recent.length > MEMORY_MAX) this.#recent.splice(0, this.#recent.length - MEMORY_MAX);
    return added;
  }

  /** Liquidations added since the last call, for broadcasting. */
  takeFresh(): Liquidation[] { return this.#fresh.splice(0); }

  /** Liquidations in [from, to) of at least `minUsd`, oldest first; when more than `limit` match, the largest `limit`. */
  query(from: number, to: number, minUsd = this.floorUsd, limit = LIQUIDATIONS_PER_ANSWER): Liquidation[] {
    const out: Liquidation[] = [];
    const memoryStart = this.#recent[0]?.t ?? Infinity;
    if (this.#store?.query && from <= memoryStart) {
      // As with the prints: the store is asked through the millisecond memory begins at, and what memory holds of it is left out of its answer.
      const kept = new Set<string>();
      for (const l of this.#recent) { if (l.t > memoryStart) break; kept.add(keyOf(l)); }
      for (const l of this.#store.query(from, Math.min(to, memoryStart + 1), minUsd, limit)) if (!kept.has(keyOf(l))) out.push(l);
    }
    for (const l of this.#recent) if (l.t >= from && l.t < to && l.usd >= minUsd) out.push(l);
    return largestLiquidations(out, limit);
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
