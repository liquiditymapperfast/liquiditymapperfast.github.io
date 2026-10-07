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

/**
 * Market-order counts and USD by order size for a minute or a bar; only orders seen while recording contribute. An order is all the fills
 * of one market order (see `orders.ts`), counted in the minute of its first fill. `v` is `STATS_VERSION`: statistics written before
 * orders were rebuilt counted every fill as a trade (so a large order on Bybit was many small ones) and are not read any more.
 */
export interface TradeStats { buyN: number; sellN: number; buy: number[]; sell: number[]; v?: number }
/** The version of the statistics this recorder writes: 2 counts market orders. */
export const STATS_VERSION = 2;
const emptyStats = (): TradeStats => ({ buyN: 0, sellN: 0, buy: new Array<number>(SIZE_EDGES.length).fill(0), sell: new Array<number>(SIZE_EDGES.length).fill(0), v: STATS_VERSION });
/** Statistics of the version this recorder writes, or null (older ones, or none). */
const current = (stats: TradeStats | null | undefined): TradeStats | null => stats && stats.v === STATS_VERSION ? stats : null;

/**
 * The trades of some instruments added together over the last `minutes` whole minutes (the open minute is the first of them), as the page's
 * strip asks for them. `seen` is how many of those minutes have footprint rows for at least one instrument, `stats` how many carry trade
 * statistics: a minute nobody recorded is told apart from a minute with nothing in it only by the others having rows, and a minute recorded
 * before statistics were kept has rows and no statistics.
 */
export interface SizesWindow { minutes: number; seen: number; stats: number; buyN: number; sellN: number; buy: number[]; sell: number[] }
export interface SizesAnswer { windows: SizesWindow[] }
/** The most windows, and the longest, one question may ask for. */
export const MAX_SIZES_WINDOWS = 6, MAX_SIZES_MINUTES = 1_440;

/**
 * A sizes answer checked field by field against the windows that were asked for (same lengths, same order): the answer, or null when it is
 * anything else (an old server's error page, a cut-off body). Counts are whole numbers, USD are finite and not negative.
 */
export function parseSizes(value: unknown, windows: readonly number[]): SizesAnswer | null {
  const list = (value as { windows?: unknown } | null)?.windows;
  if (!Array.isArray(list) || list.length !== windows.length) return null;
  const whole = (v: unknown, max: number): v is number => typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= max;
  const usd = (v: unknown): v is number[] => Array.isArray(v) && v.length === SIZE_EDGES.length && v.every(x => typeof x === 'number' && Number.isFinite(x) && x >= 0);
  const out: SizesWindow[] = [];
  for (let i = 0; i < windows.length; i++) {
    const w = list[i] as Partial<SizesWindow> | null;
    if (!w || w.minutes !== windows[i] || !whole(w.seen, w.minutes) || !whole(w.stats, w.minutes) || w.stats > w.seen || !whole(w.buyN, Number.MAX_SAFE_INTEGER) || !whole(w.sellN, Number.MAX_SAFE_INTEGER) || !usd(w.buy) || !usd(w.sell)) return null;
    out.push({ minutes: w.minutes, seen: w.seen, stats: w.stats, buyN: w.buyN, sellN: w.sellN, buy: [...w.buy], sell: [...w.sell] });
  }
  return { windows: out };
}

/**
 * Traded volume by price over [from, to) for one instrument (the traded-volume column): its rows on a step that is a whole multiple of the
 * recorded one, how many of the window's minutes have rows, the first of them, and the earliest minute recorded at all (so a reader can tell
 * a window that reaches back before the recording from one in which nothing traded).
 */
export interface ProfileInstrument { id: string; step: number; rows: FootprintRow[]; minutes: number; first: number | null; earliest: number | null }
export interface ProfileAnswer { from: number; to: number; instruments: ProfileInstrument[] }
/** The most instruments one profile question may name. */
export const MAX_PROFILE_INSTRUMENTS = 48;

/** A profile answer checked field by field against the instruments asked for: the answer, or null when it is anything else. */
export function parseProfile(value: unknown, ids: readonly string[]): ProfileAnswer | null {
  const body = value as { from?: unknown; to?: unknown; instruments?: unknown } | null;
  if (!body || typeof body.from !== 'number' || typeof body.to !== 'number' || !Array.isArray(body.instruments)) return null;
  const asked = new Set(ids), out: ProfileInstrument[] = [];
  const time = (v: unknown): v is number | null => v === null || (typeof v === 'number' && Number.isFinite(v));
  for (const item of body.instruments as unknown[]) {
    const i = item as Partial<ProfileInstrument> | null;
    if (!i || typeof i.id !== 'string' || !asked.has(i.id) || typeof i.step !== 'number' || !(i.step >= 0) || !Number.isFinite(i.step)
      || typeof i.minutes !== 'number' || !Number.isInteger(i.minutes) || i.minutes < 0 || !time(i.first) || !time(i.earliest) || !Array.isArray(i.rows)) return null;
    const rows: FootprintRow[] = [];
    for (const r of i.rows as unknown[]) {
      if (!Array.isArray(r) || r.length !== 3 || !r.every(x => typeof x === 'number' && Number.isFinite(x)) || (r[1] as number) < 0 || (r[2] as number) < 0) return null;
      rows.push([r[0] as number, r[1] as number, r[2] as number]);
    }
    out.push({ id: i.id, step: i.step, rows, minutes: i.minutes, first: i.first ?? null, earliest: i.earliest ?? null });
  }
  return { from: body.from, to: body.to, instruments: out };
}

export interface FootprintBar {
  t: number; rows: FootprintRow[]; buyUsd: number; sellUsd: number;
  /** How many of the bar's minutes were recorded, so a reader can tell a whole candle from one seen only in part. */
  minutes: number;
  /** Present only when every recorded minute of the bar carried trade stats. */
  stats?: TradeStats;
}

type Bins = Map<number, [number, number]>;

/** A copy of a minute's statistics, whole: a row waits in a queue (the browser's) while a late trade may still change the minute, and the row must stay what it was when it was queued. */
const copyStats = (stats: TradeStats | undefined): TradeStats | null => stats ? { buyN: stats.buyN, sellN: stats.sellN, buy: [...stats.buy], sell: [...stats.sell], v: STATS_VERSION } : null;

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
        // Statistics of an older version counted fills, not orders: such a minute is kept as one recorded without statistics.
        const stats = current(row.stats);
        if (stats) this.#minuteStats(row.inst).set(row.t, stats);
        this.#minute(row.inst).set(row.t, new Map(row.bins.map(([bin, buy, sell]) => [bin, [buy, sell] as [number, number]])));
      }
    }
  }

  #minuteStats(id: string): Map<number, TradeStats> { let m = this.#stats.get(id); if (!m) { m = new Map(); this.#stats.set(id, m); } return m; }
  #minute(id: string): Map<number, Bins> { let m = this.#minutes.get(id); if (!m) { m = new Map(); this.#minutes.set(id, m); } return m; }
  step(id: string): number | undefined { return this.#steps.get(id); }

  /** Add every fill not seen before to its price row. Returns the number accepted. Orders are counted separately (`countOrders`). */
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
      // A minute begun here carries statistics, which its orders fill in. A minute that was restored without statistics (recorded before
      // they were kept, or before they counted orders) stays without: counting only the orders that arrive now would give it statistics
      // that cover a fraction of its volume, and a bar would be passed off as complete on them.
      if (!restored) { const stats = this.#minuteStats(id); if (!stats.has(minute)) stats.set(minute, emptyStats()); }
      this.#dirty.add(`${id}|${minute}`);
      accepted++;
    }
    return accepted;
  }

  /**
   * Count market orders (their fills went to `ingest` first) in the statistics of the minute of each one's first fill. A minute without
   * statistics (restored from before they counted orders) stays without.
   */
  countOrders(orders: Iterable<{ instrumentId: string; side: 'buy' | 'sell'; t: number; usd: number }>): void {
    for (const order of orders) {
      const minute = Math.floor(order.t / MINUTE) * MINUTE, stats = this.#stats.get(order.instrumentId)?.get(minute);
      if (!stats || !(order.usd > 0)) continue;
      if (order.side === 'buy') { stats.buyN++; stats.buy[sizeBucket(order.usd)]! += order.usd; } else { stats.sellN++; stats.sell[sizeBucket(order.usd)]! += order.usd; }
      this.#dirty.add(`${order.instrumentId}|${minute}`);
    }
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

  /** The trades of these instruments added together over each of the last `windows` minutes (see `SizesAnswer`), by this recorder's own clock. */
  sizes(ids: readonly string[], windows: readonly number[]): SizesAnswer {
    return sizesOf({ minutes: id => this.#minutes.get(id), stats: id => this.#stats.get(id) }, ids, windows, this.now());
  }

  /** Traded volume by price for each of `ids` over the minutes that start in [from, to), rows merged to `rowStep` (see `ProfileAnswer`). */
  profile(ids: readonly string[], from: number, to: number, rowStep: number): ProfileAnswer {
    const instruments: ProfileInstrument[] = [];
    for (const id of ids) {
      const fine = this.#steps.get(id), minutes = this.#minutes.get(id);
      if (!fine || !minutes || !minutes.size) { instruments.push({ id, step: 0, rows: [], minutes: 0, first: null, earliest: null }); continue; }
      const factor = Math.max(1, Math.round(rowStep / fine)), step = fine * factor, rows = new Map<number, [number, number]>();
      let count = 0, first: number | null = null, earliest: number | null = null;
      for (const [t, bins] of minutes) {
        if (earliest === null || t < earliest) earliest = t;
        if (t < from || t >= to) continue;
        count++; if (first === null || t < first) first = t;
        for (const [bin, [buy, sell]] of bins) { const row = Math.floor(bin / factor), cell = rows.get(row) ?? [0, 0]; cell[0] += buy; cell[1] += sell; rows.set(row, cell); }
      }
      instruments.push({ id, step, rows: [...rows].sort((a, b) => a[0] - b[0]).map(([row, [buy, sell]]): FootprintRow => [row * step, buy, sell]), minutes: count, first, earliest });
    }
    return { from, to, instruments };
  }

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

/**
 * The recorder's answer to a sizes question (see `SizesAnswer`): each window is the last N whole minutes up to and including the open one,
 * by this recorder's own clock, for all the instruments added together. The windows all end at the same minute, so one pass back over the
 * longest serves every one of them, and each minute is looked up by its key rather than found among a week of them.
 */
export function sizesOf(recorder: { minutes(id: string): ReadonlyMap<number, unknown> | undefined; stats(id: string): ReadonlyMap<number, TradeStats> | undefined }, ids: readonly string[], windows: readonly number[], now: number): SizesAnswer {
  const open = Math.floor(now / MINUTE) * MINUTE, longest = windows.reduce((a, b) => Math.max(a, b), 0);
  const out: SizesWindow[] = windows.map(minutes => ({ minutes, seen: 0, stats: 0, buyN: 0, sellN: 0, buy: new Array<number>(SIZE_EDGES.length).fill(0), sell: new Array<number>(SIZE_EDGES.length).fill(0) }));
  const books = ids.map(id => [recorder.minutes(id), recorder.stats(id)] as const);
  const minute = emptyStats();
  for (let back = 0; back < longest; back++) {
    const t = open - back * MINUTE;
    let seen = false, withStats = false;
    minute.buyN = 0; minute.sellN = 0; minute.buy.fill(0); minute.sell.fill(0);
    for (const [rows, stats] of books) {
      if (rows?.has(t)) seen = true;
      const s = stats?.get(t);
      if (!s) continue;
      withStats = true; minute.buyN += s.buyN; minute.sellN += s.sellN;
      for (let i = 0; i < SIZE_EDGES.length; i++) { minute.buy[i]! += s.buy[i]!; minute.sell[i]! += s.sell[i]!; }
    }
    if (!seen && !withStats) continue;
    for (const w of out) {
      if (back >= w.minutes) continue;
      if (seen) w.seen++;
      if (!withStats) continue;
      w.stats++; w.buyN += minute.buyN; w.sellN += minute.sellN;
      for (let i = 0; i < SIZE_EDGES.length; i++) { w.buy[i]! += minute.buy[i]!; w.sell[i]! += minute.sell[i]!; }
    }
  }
  return { windows: out };
}

/** Stats as stored (`[buyN, sellN, buy, sell, version]` as JSON text) in the current version: the object when every field is valid, else null. */
export function parseStats(text: string | null): TradeStats | null {
  if (!text) return null;
  try {
    const [buyN, sellN, buy, sell, version] = JSON.parse(text) as [number, number, number[], number[], number?];
    const count = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v >= 0;
    const bucket = (v: unknown): v is number[] => Array.isArray(v) && v.length === SIZE_EDGES.length && v.every(x => typeof x === 'number' && Number.isFinite(x) && x >= 0);
    // Four fields are statistics from before orders were rebuilt (every fill a trade): not the same quantity, so they are not read.
    return version === STATS_VERSION && count(buyN) && count(sellN) && bucket(buy) && bucket(sell) ? { buyN, sellN, buy, sell, v: STATS_VERSION } : null;
  } catch { return null; }
}

/** Stats as the database stores them (see `parseStats`). */
export const statsText = (stats: TradeStats): string => JSON.stringify([stats.buyN, stats.sellN, stats.buy, stats.sell, STATS_VERSION]);
