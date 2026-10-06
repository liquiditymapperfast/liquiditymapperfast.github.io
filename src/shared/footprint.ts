import { gridStepFor } from './grid.ts';

const MINUTE = 60_000;
const RETENTION_MS = 7 * 24 * 3_600_000;
/** Footprint rows are recorded at 1/40 of the depth grid step (0.5 USD for BTC) and merged dyadically at query time. */
const FINE_DIV = 40;

export interface TradeLike { instrumentId?: unknown; tradeId?: unknown; side?: unknown; price?: unknown; amount?: unknown; notionalUsd?: unknown; sourceTimestamp?: unknown; receivedAt?: unknown }
/** [priceLow, buyUsd, sellUsd] */
export type FootprintRow = [number, number, number];
/** Trade-size buckets by notional USD: [0, 25K), [25K, 50K), [50K, 100K), [100K, 250K), [250K, 500K), [500K, 1M), [1M, 5M), 5M and above. */
export const SIZE_EDGES: readonly number[] = [0, 25_000, 50_000, 100_000, 250_000, 500_000, 1_000_000, 5_000_000];
export const sizeBucket = (usd: number): number => { let bucket = 0; for (let i = 1; i < SIZE_EDGES.length; i++) if (usd >= SIZE_EDGES[i]!) bucket = i; return bucket; };

/** Trade counts and USD by size bucket for a minute or a bar; only trades seen while recording contribute. */
export interface TradeStats { buyN: number; sellN: number; buy: number[]; sell: number[] }
const emptyStats = (): TradeStats => ({ buyN: 0, sellN: 0, buy: new Array<number>(SIZE_EDGES.length).fill(0), sell: new Array<number>(SIZE_EDGES.length).fill(0) });

export interface FootprintBar {
  t: number; rows: FootprintRow[]; buyUsd: number; sellUsd: number;
  /** How many of the bar's minutes were recorded, so a reader can tell a whole candle from one seen only in part. */
  minutes: number;
  /** Present only when every recorded minute of the bar carried trade stats. */
  stats?: TradeStats;
}

type Bins = Map<number, [number, number]>;

/** A copy of a minute's statistics, whole: a row waits in a queue (the browser's) while a late trade may still change the minute, and the row must stay what it was when it was queued. */
const copyStats = (stats: TradeStats | undefined): TradeStats | null => stats ? { buyN: stats.buyN, sellN: stats.sellN, buy: [...stats.buy], sell: [...stats.sell] } : null;

/**
 * The row a price falls in. A price that is a whole number of steps is a boundary and belongs to the row above it, but the division can come
 * out a hair under the whole number (100.3 / 0.1), which would put it in the row below: a part in 10^12 is forgiven.
 */
const binOf = (price: number, step: number): number => Math.floor(price / step * (1 + 1e-12));

/** One recorded minute of one instrument as it is stored: rows are [bin, buyUsd, sellUsd]. */
export interface FootprintMinuteRow { inst: string; t: number; step: number; bins: [number, number, number][]; stats: TradeStats | null }
/** Where recorded minutes outlive the process (SQLite on the server, IndexedDB in the browser); loading is synchronous, saving may be queued. */
export interface FootprintStore {
  load(since: number): Iterable<FootprintMinuteRow>;
  save(rows: FootprintMinuteRow[], expireBefore: number): void;
  close(): void;
}

/** Per-instrument, per-minute taker buy/sell USD by price row. */
export class FootprintRecorder {
  readonly #minutes = new Map<string, Map<number, Bins>>();
  readonly #stats = new Map<string, Map<number, TradeStats>>();
  readonly #steps = new Map<string, number>();
  readonly #seen = new Map<string, Set<string>>();
  readonly #store: FootprintStore | null;
  /** Minutes changed since they were last written, as `instrument|minute`. */
  readonly #dirty = new Set<string>();

  readonly #retentionMs: number;

  constructor(store: FootprintStore | null = null, protected now: () => number = Date.now, retentionMs: number = RETENTION_MS) {
    this.#store = store; this.#retentionMs = retentionMs;
    if (store) {
      for (const row of store.load(now() - retentionMs)) {
        this.#steps.set(row.inst, row.step);
        if (row.stats) this.#minuteStats(row.inst).set(row.t, row.stats);
        this.#minute(row.inst).set(row.t, new Map(row.bins.map(([bin, buy, sell]) => [bin, [buy, sell] as [number, number]])));
      }
    }
  }

  #minuteStats(id: string): Map<number, TradeStats> { let m = this.#stats.get(id); if (!m) { m = new Map(); this.#stats.set(id, m); } return m; }
  #minute(id: string): Map<number, Bins> { let m = this.#minutes.get(id); if (!m) { m = new Map(); this.#minutes.set(id, m); } return m; }
  step(id: string): number | undefined { return this.#steps.get(id); }

  /** Add every trade not seen before. Returns the number accepted. */
  ingest(trades: Iterable<TradeLike>): number {
    let accepted = 0;
    for (const trade of trades) {
      const id = String(trade.instrumentId ?? ''), key = String(trade.tradeId ?? '');
      const price = Number(trade.price), usd = Number(trade.notionalUsd ?? Number(trade.amount) * price);
      const t = Number(trade.sourceTimestamp ?? trade.receivedAt);
      const side = String(trade.side).toLowerCase();
      if (!id || !key || !(price > 0) || !(usd > 0) || !Number.isFinite(t) || (side !== 'buy' && side !== 'sell')) continue;
      let seen = this.#seen.get(id); if (!seen) { seen = new Set(); this.#seen.set(id, seen); }
      if (seen.has(key)) continue;
      seen.add(key);
      if (seen.size > 30_000) { const keep = [...seen].slice(-10_000); seen.clear(); for (const k of keep) seen.add(k); }
      let step = this.#steps.get(id);
      if (!step) { step = gridStepFor(price) / FINE_DIV; this.#steps.set(id, step); }
      const minute = Math.floor(t / MINUTE) * MINUTE;
      const minutes = this.#minute(id);
      let bins = minutes.get(minute); const restored = bins !== undefined;
      if (!bins) { bins = new Map(); minutes.set(minute, bins); }
      const bin = binOf(price, step);
      const cell = bins.get(bin) ?? [0, 0];
      cell[side === 'buy' ? 0 : 1] += usd; bins.set(bin, cell);
      // A minute that was restored without statistics (recorded before they were kept) stays without: counting only the trades that arrive
      // now would give it statistics that cover a fraction of its volume, and a bar would be passed off as complete on them.
      const stats = this.#minuteStats(id);
      if (!restored || stats.has(minute)) {
        const minuteStats = stats.get(minute) ?? emptyStats(); stats.set(minute, minuteStats);
        if (side === 'buy') { minuteStats.buyN++; minuteStats.buy[sizeBucket(usd)]! += usd; } else { minuteStats.sellN++; minuteStats.sell[sizeBucket(usd)]! += usd; }
      }
      this.#dirty.add(`${id}|${minute}`);
      accepted++;
    }
    return accepted;
  }

  /**
   * Persist changed minutes older than the open one and drop expired minutes. With `final` (the process or the page is going away) the open
   * minute is written too, as far as it has got: a restart reads it back and carries on adding to it. It stays marked as changed, so the next
   * flush after the minute has ended writes it again, whole. A minute leaves the changed set only once the store has taken it.
   */
  flush(final = false): void {
    const cutoff = this.now() - this.#retentionMs, open = Math.floor(this.now() / MINUTE) * MINUTE;
    for (const minutes of this.#minutes.values()) for (const t of minutes.keys()) if (t < cutoff) minutes.delete(t);
    for (const minutes of this.#stats.values()) for (const t of minutes.keys()) if (t < cutoff) minutes.delete(t);
    const store = this.#store, rows: FootprintMinuteRow[] = [], settled: string[] = [];
    for (const key of [...this.#dirty]) {
      const at = key.lastIndexOf('|'), id = key.slice(0, at), t = Number(key.slice(at + 1));
      if (t >= open && !(final && store)) continue;
      const bins = this.#minutes.get(id)?.get(t);
      if (bins && store) rows.push({ inst: id, t, step: this.#steps.get(id)!, bins: [...bins].map(([bin, [buy, sell]]) => [bin, buy, sell] as [number, number, number]), stats: copyStats(this.#stats.get(id)?.get(t)) });
      if (t < open) settled.push(key);
    }
    store?.save(rows, cutoff);
    for (const key of settled) this.#dirty.delete(key);
  }
  close(): void { this.flush(true); this.#store?.close(); }

  /** Bars of `tfMs` over [from, to), rows merged to `rowStep` (rounded to a multiple of the recorded step). */
  query(id: string, from: number, to: number, tfMs: number, rowStep: number): { step: number; fine: number; bars: FootprintBar[] } {
    const fine = this.#steps.get(id);
    if (!fine) return { step: 0, fine: 0, bars: [] };
    const factor = Math.max(1, Math.round(rowStep / fine)), step = fine * factor;
    const bars = new Map<number, Map<number, [number, number]>>(), barStats = new Map<number, { stats: TradeStats; withStats: number; minutes: number }>();
    for (const [t, bins] of this.#minutes.get(id) ?? []) {
      if (t < from || t >= to) continue;
      const key = Math.floor(t / tfMs) * tfMs;
      let rows = bars.get(key); if (!rows) { rows = new Map(); bars.set(key, rows); }
      let acc = barStats.get(key); if (!acc) { acc = { stats: emptyStats(), withStats: 0, minutes: 0 }; barStats.set(key, acc); }
      acc.minutes++;
      const minuteStats = this.#stats.get(id)?.get(t);
      if (minuteStats) { acc.withStats++; acc.stats.buyN += minuteStats.buyN; acc.stats.sellN += minuteStats.sellN; for (let i = 0; i < SIZE_EDGES.length; i++) { acc.stats.buy[i]! += minuteStats.buy[i]!; acc.stats.sell[i]! += minuteStats.sell[i]!; } }
      for (const [bin, [buy, sell]] of bins) {
        const row = Math.floor(bin / factor), cell = rows.get(row) ?? [0, 0];
        cell[0] += buy; cell[1] += sell; rows.set(row, cell);
      }
    }
    return { step, fine, bars: [...bars].sort((a, b) => a[0] - b[0]).map(([t, rows]) => {
      const list = [...rows].sort((a, b) => a[0] - b[0]).map(([row, [buy, sell]]): FootprintRow => [row * step, buy, sell]);
      const acc = barStats.get(t);
      return { t, rows: list, buyUsd: list.reduce((s, r) => s + r[1], 0), sellUsd: list.reduce((s, r) => s + r[2], 0), minutes: acc?.minutes ?? 0, ...(acc && acc.withStats === acc.minutes ? { stats: acc.stats } : {}) };
    }) };
  }
}

/** Stats as stored (`[buyN, sellN, buy, sell]` as JSON text): the object when every field is valid, else null. */
export function parseStats(text: string | null): TradeStats | null {
  if (!text) return null;
  try {
    const [buyN, sellN, buy, sell] = JSON.parse(text) as [number, number, number[], number[]];
    const count = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v >= 0;
    const bucket = (v: unknown): v is number[] => Array.isArray(v) && v.length === SIZE_EDGES.length && v.every(x => typeof x === 'number' && Number.isFinite(x) && x >= 0);
    return count(buyN) && count(sellN) && bucket(buy) && bucket(sell) ? { buyN, sellN, buy, sell } : null;
  } catch { return null; }
}
