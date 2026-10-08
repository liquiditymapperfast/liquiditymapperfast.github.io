import { gridStepFor } from './grid.ts';
import { levelsOf } from './profile.ts';

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
export interface ProfileInstrument {
  id: string; step: number; rows: FootprintRow[]; minutes: number; first: number | null; earliest: number | null;
  /**
   * The market orders that began on each row ([buys, sells], beside `rows`), in the minutes that count orders by price, and how many of the
   * window's minutes those are. Absent from an older server: a page reads no counts then.
   */
  counts?: [number, number][]; counted?: number;
}
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
    let counts: [number, number][] | undefined, counted: number | undefined;
    if (i.counts !== undefined) {
      const whole = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v >= 0;
      if (!Array.isArray(i.counts) || i.counts.length !== rows.length || !whole(i.counted) || i.counted > i.minutes) return null;
      counts = [];
      for (const c of i.counts as unknown[]) { if (!Array.isArray(c) || c.length !== 2 || !whole(c[0]) || !whole(c[1])) return null; counts.push([c[0], c[1]]); }
      counted = i.counted;
    }
    out.push({ id: i.id, step: i.step, rows, minutes: i.minutes, first: i.first ?? null, earliest: i.earliest ?? null, ...(counts ? { counts, counted } : {}) });
  }
  return { from: body.from, to: body.to, instruments: out };
}

/**
 * A selection of the map (a box: a stretch of time and a band of prices) or of a pane under it (a stretch of time at every price): the minutes
 * that start in [from, to), and the prices in [p0, p1) (every price when they are null).
 *
 * `rows` is the volume by price inside the selection for all the instruments together, [priceLow, buyUsd, sellUsd, buyOrders, sellOrders] on
 * `step` (the step asked for, doubled until there are no more than `MAX_RANGE_ROWS`). Orders are counted only in minutes that count them by
 * price (see `FootprintRecorder.countOrders`). Each instrument adds what it did in the selection, how many minutes it recorded there and how
 * many of them count orders (from `countedFrom`), the USD of those counted minutes (what its orders are measured against), its volume at every
 * price over the same minutes, and over the same length of time just before them with the minutes it recorded there.
 */
export type RangeRow = [price: number, buy: number, sell: number, buyN: number, sellN: number];
export interface RangeInstrument {
  id: string;
  band: { buy: number; sell: number; buyN: number; sellN: number };
  minutes: number; counted: number; countedFrom: number | null;
  countedUsd: { buy: number; sell: number };
  all: { buy: number; sell: number };
  before: { buy: number; sell: number; minutes: number };
}
export interface RangeAnswer { from: number; to: number; p0: number | null; p1: number | null; step: number; rows: RangeRow[]; instruments: RangeInstrument[] }
/** The most rows a range answer carries, and the most instruments one question may name. */
export const MAX_RANGE_ROWS = 400, MAX_RANGE_INSTRUMENTS = 48;

/** A range answer checked field by field against the instruments asked for: the answer, or null when it is anything else. */
export function parseRange(value: unknown, ids: readonly string[]): RangeAnswer | null {
  const body = value as Partial<Record<keyof RangeAnswer, unknown>> | null;
  const num = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
  const usd = (v: unknown): v is number => num(v) && v >= 0;
  const count = (v: unknown): v is number => num(v) && Number.isInteger(v) && v >= 0;
  const priceOrNull = (v: unknown): v is number | null => v === null || num(v);
  if (!body || !num(body.from) || !num(body.to) || !priceOrNull(body.p0) || !priceOrNull(body.p1) || (body.p0 === null) !== (body.p1 === null)
    || !num(body.step) || !(body.step > 0) || !Array.isArray(body.rows) || body.rows.length > MAX_RANGE_ROWS || !Array.isArray(body.instruments)) return null;
  const rows: RangeRow[] = [];
  for (const r of body.rows as unknown[]) {
    if (!Array.isArray(r) || r.length !== 5 || !num(r[0]) || !usd(r[1]) || !usd(r[2]) || !count(r[3]) || !count(r[4])) return null;
    rows.push([r[0], r[1], r[2], r[3], r[4]]);
  }
  const asked = new Set(ids), instruments: RangeInstrument[] = [];
  for (const item of body.instruments as unknown[]) {
    const i = item as { [K in keyof RangeInstrument]?: unknown } | null;
    const b = i?.band as Record<string, unknown> | undefined, c = i?.countedUsd as Record<string, unknown> | undefined;
    const a = i?.all as Record<string, unknown> | undefined, p = i?.before as Record<string, unknown> | undefined;
    if (!i || typeof i.id !== 'string' || !asked.has(i.id) || !b || !c || !a || !p || !count(i.minutes) || !count(i.counted) || i.counted > i.minutes
      || !(i.countedFrom === null || num(i.countedFrom)) || !usd(b.buy) || !usd(b.sell) || !count(b.buyN) || !count(b.sellN) || !usd(c.buy) || !usd(c.sell)
      || !usd(a.buy) || !usd(a.sell) || !usd(p.buy) || !usd(p.sell) || !count(p.minutes)) return null;
    instruments.push({ id: i.id, band: { buy: b.buy, sell: b.sell, buyN: b.buyN, sellN: b.sellN }, minutes: i.minutes, counted: i.counted, countedFrom: i.countedFrom,
      countedUsd: { buy: c.buy, sell: c.sell }, all: { buy: a.buy, sell: a.sell }, before: { buy: p.buy, sell: p.sell, minutes: p.minutes } });
  }
  return { from: body.from, to: body.to, p0: body.p0, p1: body.p1, step: body.step, rows, instruments };
}

/**
 * The point of control and the value area of each of several windows (days, weeks, sessions), every instrument's volume added together on
 * rows of `step` over every price: see `shared/profile.ts`. `minutes` is the most minutes any instrument recorded in the window, so a reader
 * can tell a window recorded in part. A window in which nothing traded has null levels.
 */
export interface ValueAreaWindow { from: number; to: number; minutes: number; total: number; poc: number | null; vah: number | null; val: number | null }
export interface ValueAreaAnswer { step: number; share: number; windows: ValueAreaWindow[] }
/** The most windows one question may name, and the most time they may add up to (each minute of each is walked: a day takes about 90 ms). */
export const MAX_VALUE_AREA_WINDOWS = 24, MAX_VALUE_AREA_SPAN_MS = 8 * 86_400_000;

/** A value-area answer checked field by field against the windows asked for (same number, same order). */
export function parseValueAreas(value: unknown, windows: readonly { from: number; to: number }[]): ValueAreaAnswer | null {
  const body = value as { step?: unknown; share?: unknown; windows?: unknown } | null;
  const num = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
  const price = (v: unknown): v is number | null => v === null || num(v);
  if (!body || !num(body.step) || !(body.step > 0) || !num(body.share) || !Array.isArray(body.windows) || body.windows.length !== windows.length) return null;
  const out: ValueAreaWindow[] = [];
  for (let k = 0; k < windows.length; k++) {
    const w = body.windows[k] as Partial<Record<keyof ValueAreaWindow, unknown>> | null;
    if (!w || w.from !== windows[k]!.from || w.to !== windows[k]!.to || !num(w.minutes) || !Number.isInteger(w.minutes) || w.minutes < 0 || !num(w.total) || w.total < 0
      || !price(w.poc) || !price(w.vah) || !price(w.val) || (w.poc === null) !== (w.vah === null) || (w.poc === null) !== (w.val === null)) return null;
    out.push({ from: w.from as number, to: w.to as number, minutes: w.minutes, total: w.total, poc: w.poc, vah: w.vah, val: w.val });
  }
  return { step: body.step, share: body.share, windows: out };
}

export interface FootprintBar {
  t: number; rows: FootprintRow[]; buyUsd: number; sellUsd: number;
  /** How many of the bar's minutes were recorded, so a reader can tell a whole candle from one seen only in part. */
  minutes: number;
  /** Present only when every recorded minute of the bar carried trade stats. */
  stats?: TradeStats;
}

/**
 * A price row of a minute as it is held: taker buy and sell USD, and the market orders that started at that price (in a minute that counts
 * orders by price; zero in any other).
 */
type Cell = [buy: number, sell: number, buyN: number, sellN: number];
type Bins = Map<number, Cell>;
/**
 * What a minute adds up to, kept beside its rows so a question about a stretch of time does not walk every row of every minute: its USD at
 * every price, the lowest and highest row, and whether its orders are counted by price (a minute begun before they were is not: counting
 * only the orders that arrive later would give it counts that cover part of its volume).
 */
interface MinuteSum { buy: number; sell: number; lo: number; hi: number; counted: boolean }

/** A copy of a minute's statistics, whole: a row waits in a queue (the browser's) while a late trade may still change the minute, and the row must stay what it was when it was queued. */
const copyStats = (stats: TradeStats | undefined): TradeStats | null => stats ? { buyN: stats.buyN, sellN: stats.sellN, buy: [...stats.buy], sell: [...stats.sell], v: STATS_VERSION } : null;

/**
 * The row a price falls in. A price that is a whole number of steps is a boundary and belongs to the row above it, but the division can come
 * out a hair under the whole number (100.3 / 0.1), which would put it in the row below: a part in 10^12 is forgiven.
 */
const binOf = (price: number, step: number): number => Math.floor(price / step * (1 + 1e-12));

/**
 * A row as stored: [bin, buyUsd, sellUsd], and in a minute that counts orders by price [bin, buyUsd, sellUsd, buyOrders, sellOrders]. A minute's
 * rows are all of one form.
 */
export type StoredBin = [number, number, number] | [number, number, number, number, number];
/** A minute's sums from its rows (a minute read back from storage). */
function sumOf(bins: Bins, counted: boolean): MinuteSum {
  const sum: MinuteSum = { buy: 0, sell: 0, lo: Infinity, hi: -Infinity, counted };
  for (const [bin, cell] of bins) { sum.buy += cell[0]; sum.sell += cell[1]; if (bin < sum.lo) sum.lo = bin; if (bin > sum.hi) sum.hi = bin; }
  return sum;
}

/**
 * The row an order is counted in: the one at its price, or the nearest row of the minute when that price has none (an order that ran on into
 * the next minute started at a price this minute never traded). An order never makes a row of its own: a row with no volume would show in the
 * footprint and the traded column.
 */
function nearestCell(bins: Bins, bin: number): Cell | undefined {
  const exact = bins.get(bin); if (exact) return exact;
  let best: Cell | undefined, gap = Infinity;
  for (const [b, cell] of bins) { const d = Math.abs(b - bin); if (d < gap) { gap = d; best = cell; } }
  return best;
}

/** One recorded minute of one instrument as it is stored. */
export interface FootprintMinuteRow { inst: string; t: number; step: number; bins: StoredBin[]; stats: TradeStats | null }
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
  readonly #sums = new Map<string, Map<number, MinuteSum>>();
  readonly #steps = new Map<string, number>();
  readonly #seen = new Map<string, Set<string>>();
  readonly #store: FootprintStore | null;
  /** Minutes changed since they were last written, as `instrument|minute`. */
  readonly #dirty = new Set<string>();

  readonly #retentionMs: number;
  /** The size buckets' edges are SIZE_EDGES times this (1 for BTC; smaller for a coin that trades less). */
  readonly sizeScale: number;

  constructor(store: FootprintStore | null = null, protected now: () => number = Date.now, retentionMs: number = RETENTION_MS, sizeScale = 1) {
    this.#store = store; this.#retentionMs = retentionMs; this.sizeScale = sizeScale;
    if (store) {
      for (const row of store.load(now() - retentionMs)) {
        this.#steps.set(row.inst, row.step);
        // Statistics of an older version counted fills, not orders: such a minute is kept as one recorded without statistics.
        const stats = current(row.stats);
        if (stats) this.#minuteStats(row.inst).set(row.t, stats);
        const counted = row.bins.length > 0 && row.bins.every(b => b.length === 5);
        const bins: Bins = new Map(row.bins.map(b => [b[0], [b[1], b[2], counted ? b[3]! : 0, counted ? b[4]! : 0] as Cell]));
        this.#minute(row.inst).set(row.t, bins);
        this.#minuteSums(row.inst).set(row.t, sumOf(bins, counted));
      }
    }
  }

  #minuteStats(id: string): Map<number, TradeStats> { let m = this.#stats.get(id); if (!m) { m = new Map(); this.#stats.set(id, m); } return m; }
  #minute(id: string): Map<number, Bins> { let m = this.#minutes.get(id); if (!m) { m = new Map(); this.#minutes.set(id, m); } return m; }
  #minuteSums(id: string): Map<number, MinuteSum> { let m = this.#sums.get(id); if (!m) { m = new Map(); this.#sums.set(id, m); } return m; }
  step(id: string): number | undefined { return this.#steps.get(id); }
  /** Instruments with a recorded minute. */
  get instruments(): string[] { return [...this.#minutes.keys()]; }
  /** The start (ms) of the newest minute recorded for `id`, or 0. */
  lastMinute(id: string): number { let newest = 0; for (const t of this.#minutes.get(id)?.keys() ?? []) if (t > newest) newest = t; return newest; }

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
      const bin = binOf(price, step);
      let sum = this.#minuteSums(id).get(minute);
      if (!bins) { bins = new Map(); minutes.set(minute, bins); }
      if (!sum) { sum = { buy: 0, sell: 0, lo: bin, hi: bin, counted: !restored }; this.#minuteSums(id).set(minute, sum); }
      const cell = bins.get(bin) ?? [0, 0, 0, 0];
      if (side === 'buy') { cell[0] += usd; sum.buy += usd; } else { cell[1] += usd; sum.sell += usd; }
      bins.set(bin, cell);
      if (bin < sum.lo) sum.lo = bin;
      if (bin > sum.hi) sum.hi = bin;
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
   * Count market orders (their fills went to `ingest` first) in the statistics of the minute of each one's first fill, and in the row of the
   * price it started at: the best price it took, where it met the resting orders (a buy's lowest fill, a sell's highest). A minute without
   * statistics (restored from before they counted orders) stays without, and one that does not count by price gets no counts in its rows.
   */
  countOrders(orders: Iterable<{ instrumentId: string; side: 'buy' | 'sell'; t: number; usd: number; lo?: number; hi?: number; price?: number }>): void {
    for (const order of orders) {
      const id = order.instrumentId, minute = Math.floor(order.t / MINUTE) * MINUTE, stats = this.#stats.get(id)?.get(minute);
      if (!stats || !(order.usd > 0)) continue;
      const bucket = sizeBucket(order.usd / this.sizeScale);
      if (order.side === 'buy') { stats.buyN++; stats.buy[bucket]! += order.usd; } else { stats.sellN++; stats.sell[bucket]! += order.usd; }
      const step = this.#steps.get(id), start = order.side === 'buy' ? order.lo ?? order.price : order.hi ?? order.price;
      const bins = this.#minutes.get(id)?.get(minute);
      if (step && bins && start !== undefined && start > 0 && this.#sums.get(id)?.get(minute)?.counted) {
        const cell = nearestCell(bins, binOf(start, step));
        if (cell) cell[order.side === 'buy' ? 2 : 3]++;
      }
      this.#dirty.add(`${id}|${minute}`);
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
    for (const minutes of this.#sums.values()) for (const t of minutes.keys()) if (t < cutoff) minutes.delete(t);
    const store = this.#store, rows: FootprintMinuteRow[] = [], settled: string[] = [];
    for (const key of [...this.#dirty]) {
      const at = key.lastIndexOf('|'), id = key.slice(0, at), t = Number(key.slice(at + 1));
      if (t >= open && !(final && store)) continue;
      const bins = this.#minutes.get(id)?.get(t);
      if (bins && store) {
        const counted = this.#sums.get(id)?.get(t)?.counted === true;
        rows.push({ inst: id, t, step: this.#steps.get(id)!, bins: [...bins].map(([bin, [buy, sell, buyN, sellN]]): StoredBin => counted ? [bin, buy, sell, buyN, sellN] : [bin, buy, sell]), stats: copyStats(this.#stats.get(id)?.get(t)) });
      }
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
      const factor = Math.max(1, Math.round(rowStep / fine)), step = fine * factor, rows = new Map<number, [number, number, number, number]>(), sums = this.#sums.get(id);
      let count = 0, counted = 0, first: number | null = null, earliest: number | null = null;
      for (const [t, bins] of minutes) {
        if (earliest === null || t < earliest) earliest = t;
        if (t < from || t >= to) continue;
        count++; if (first === null || t < first) first = t;
        if (sums?.get(t)?.counted) counted++;
        for (const [bin, [buy, sell, buyN, sellN]] of bins) { const row = Math.floor(bin / factor), cell = rows.get(row) ?? [0, 0, 0, 0]; cell[0] += buy; cell[1] += sell; cell[2] += buyN; cell[3] += sellN; rows.set(row, cell); }
      }
      const sorted = [...rows].sort((a, b) => a[0] - b[0]);
      instruments.push({ id, step, rows: sorted.map(([row, [buy, sell]]): FootprintRow => [row * step, buy, sell]), minutes: count, first, earliest, counts: sorted.map(([, c]): [number, number] => [c[2], c[3]]), counted });
    }
    return { from, to, instruments };
  }

  /**
   * What happened in a selection (see `RangeAnswer`): one pass over its minutes, each looked up by its key. A minute's sums answer the
   * questions about every price, and a box skips the rows of a minute that traded wholly outside its band.
   */
  range(ids: readonly string[], from: number, to: number, band: { p0: number; p1: number } | null, rowStep: number): RangeAnswer {
    const first = Math.ceil(from / MINUTE) * MINUTE, span = Math.max(0, to - first);
    const merged = new Map<number, RangeRow>(), instruments: RangeInstrument[] = [];
    for (const id of ids) {
      const fine = this.#steps.get(id), minutes = this.#minutes.get(id), sums = this.#sums.get(id);
      const out: RangeInstrument = { id, band: { buy: 0, sell: 0, buyN: 0, sellN: 0 }, minutes: 0, counted: 0, countedFrom: null, countedUsd: { buy: 0, sell: 0 }, all: { buy: 0, sell: 0 }, before: { buy: 0, sell: 0, minutes: 0 } };
      instruments.push(out);
      if (!fine || !minutes || !sums) continue;
      for (let t = first - span; t < first; t += MINUTE) { const s = sums.get(t); if (s) { out.before.buy += s.buy; out.before.sell += s.sell; out.before.minutes++; } }
      // The band's first and last rows (a row is inside when its low price is).
      const lo = band ? Math.ceil(band.p0 / fine * (1 - 1e-12)) : -Infinity, hi = band ? Math.ceil(band.p1 / fine * (1 - 1e-12)) : Infinity;
      for (let t = first; t < to; t += MINUTE) {
        const s = sums.get(t), bins = minutes.get(t);
        if (!s || !bins) continue;
        out.minutes++; out.all.buy += s.buy; out.all.sell += s.sell;
        if (s.counted) { out.counted++; if (out.countedFrom === null) out.countedFrom = t; }
        if (s.hi < lo || s.lo >= hi) continue;
        const whole = s.lo >= lo && s.hi < hi;
        for (const [bin, cell] of bins) {
          if (!whole && (bin < lo || bin >= hi)) continue;
          out.band.buy += cell[0]; out.band.sell += cell[1];
          if (s.counted) { out.band.buyN += cell[2]; out.band.sellN += cell[3]; out.countedUsd.buy += cell[0]; out.countedUsd.sell += cell[1]; }
          const key = Math.floor(bin * fine / rowStep * (1 + 1e-12));
          let row = merged.get(key); if (!row) { row = [0, 0, 0, 0, 0]; merged.set(key, row); }
          row[1] += cell[0]; row[2] += cell[1];
          if (s.counted) { row[3] += cell[2]; row[4] += cell[3]; }
        }
      }
    }
    // Too many rows for an answer: two rows become one until they fit.
    let step = rowStep, rows = merged;
    while (rows.size > MAX_RANGE_ROWS) {
      const next = new Map<number, RangeRow>();
      for (const [key, row] of rows) {
        const half = Math.floor(key / 2), into = next.get(half);
        if (into) for (let i = 1; i < 5; i++) into[i]! += row[i]!; else next.set(half, [0, row[1], row[2], row[3], row[4]]);
      }
      rows = next; step *= 2;
    }
    return { from, to, p0: band?.p0 ?? null, p1: band?.p1 ?? null, step, rows: [...rows].sort((a, b) => a[0] - b[0]).map(([key, row]): RangeRow => [key * step, row[1], row[2], row[3], row[4]]), instruments };
  }

  /**
   * The point of control and the value area of each window (see `ValueAreaAnswer`), holding `share` (0..1) of the volume, on rows of
   * `rowStep`. Each window's minutes are looked up by their keys.
   */
  valueAreas(ids: readonly string[], windows: readonly { from: number; to: number }[], rowStep: number, share: number): ValueAreaAnswer {
    const out: ValueAreaWindow[] = [];
    for (const w of windows) {
      const rows = new Map<number, number>(), first = Math.ceil(w.from / MINUTE) * MINUTE;
      let minutes = 0, total = 0;
      for (const id of ids) {
        const fine = this.#steps.get(id), held = this.#minutes.get(id);
        if (!fine || !held) continue;
        let seen = 0;
        for (let t = first; t < w.to; t += MINUTE) {
          const bins = held.get(t); if (!bins) continue;
          seen++;
          for (const [bin, cell] of bins) { const v = cell[0] + cell[1], key = Math.floor(bin * fine / rowStep * (1 + 1e-12)); rows.set(key, (rows.get(key) ?? 0) + v); total += v; }
        }
        minutes = Math.max(minutes, seen);
      }
      const levels = levelsOf(rows, rowStep, share);
      out.push({ from: w.from, to: w.to, minutes, total, poc: levels?.poc ?? null, vah: levels?.vah ?? null, val: levels?.val ?? null });
    }
    return { step: rowStep, share, windows: out };
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
