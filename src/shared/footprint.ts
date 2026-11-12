import { gridStepFor } from './grid.ts';
import { levelsOf } from './profile.ts';
import { KeptCache } from './kept-cache.ts';

const MINUTE = 60_000, HOUR = 3_600_000;
const RETENTION_MS = 7 * 24 * 3_600_000;
/**
 * How many minutes of rows read back from the store a server keeps for the next question: about a day of its BTC markets. The page asks
 * again for what it shows (the Range panel every few seconds, the profile every minute), and parsing a stored minute costs some 45 µs.
 */
export const COLD_CACHE_MINUTES = 20_000;
/** Market orders kept for another try while the store cannot read back a minute they change; past this, no more are kept. */
const UNCOUNTED_MAX = 50_000;
/**
 * The same for fills, fewer: taking them marks them seen, and the fills seen per instrument are trimmed to the last 10,000 past 30,000. A
 * fill is handed over again only while it is among the feed's last 5,000 trades (`state.trades` in server/http.mts), so at most 4,999
 * newer fills and this backlog are marked seen after it while a copy can still come: 9,999, inside the 10,000 kept. Keep the two
 * numbers adding up to no more than that.
 */
const UNTAKEN_MAX = 5_000;
/** A market order as `countOrders` counts it (its fills went to `ingest`): `lo`/`hi`, or `price`, is where it started. */
type OrderLike = { instrumentId: string; side: 'buy' | 'sell'; t: number; usd: number; lo?: number; hi?: number; price?: number };
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
 *
 * `big` is every order of the minute from the second bucket's edge up (the print floor, $25,000 for BTC), as signed USD: a buy positive, a
 * sell negative. The boxes alone answer a question about sizes only at their edges; with the orders themselves a line can be drawn at any
 * size from the floor (`over`). Absent: not known (a minute recorded before the lists were kept, until it is filled from the prints, see
 * `fillLists`); empty: none.
 */
export interface TradeStats { buyN: number; sellN: number; buy: number[]; sell: number[]; v?: number; big?: number[] }
/** The version of the statistics this recorder writes: 2 counts market orders (the list of large ones is an optional addition, read by older code as nothing). */
export const STATS_VERSION = 2;
/**
 * Whether `list` (signed USD, a buy positive) can be a minute's list of large orders: its buys and its sells each add up to the minute's USD
 * from the second size bucket up, to $1 or a millionth. A list rebuilt from the prints is kept only then (`fillLists`, and the recorded
 * history's import, app/browser/history-import.ts).
 */
export function listFits(list: readonly number[], stats: Pick<TradeStats, 'buy' | 'sell'>): boolean {
  const sum = (values: readonly number[]): number => { let s = 0; for (let i = 1; i < values.length; i++) s += values[i]!; return s; };
  const agrees = (listed: number, boxes: number): boolean => Math.abs(listed - boxes) <= Math.max(1, 1e-6 * boxes);
  let buys = 0, sells = 0;
  for (const v of list) if (v > 0) buys += v; else sells -= v;
  return agrees(buys, sum(stats.buy)) && agrees(sells, sum(stats.sell));
}
/** The list of a minute with no large order yet: one shared empty list, replaced at the first order (a week holds about 300,000 instrument-minutes). */
const NO_BIG = Object.freeze([]) as unknown as number[];
const emptyStats = (): TradeStats => ({ buyN: 0, sellN: 0, buy: new Array<number>(SIZE_EDGES.length).fill(0), sell: new Array<number>(SIZE_EDGES.length).fill(0), v: STATS_VERSION });
/** Statistics of the version this recorder writes, or null (older ones, or none); a list that is not one is dropped (the minute's list is then not known). */
const current = (stats: TradeStats | null | undefined): TradeStats | null => {
  if (!stats || stats.v !== STATS_VERSION) return null;
  if (stats.big !== undefined && !(Array.isArray(stats.big) && stats.big.every(v => typeof v === 'number' && Number.isFinite(v) && v !== 0))) { const { big: _, ...rest } = stats; return rest; }
  return stats.big?.length === 0 ? { ...stats, big: NO_BIG } : stats;
};

/** The most size lines one question may draw, and the largest. */
export const MAX_CUTS = 4, MAX_CUT_USD = 1e12;
/**
 * The size lines of a question (`cuts=75000,2000000`): each a USD size from `floorUsd` (the second bucket's edge for the coin: what the lists
 * hold) up to MAX_CUT_USD, at most MAX_CUTS of them. An empty or missing parameter is none; anything else is null (refused).
 */
export function parseCuts(raw: string | null, floorUsd: number): number[] | null {
  if (raw === null || raw === '') return [];
  const cuts = raw.split(',').map(Number);
  return cuts.length <= MAX_CUTS && cuts.every(c => Number.isFinite(c) && c >= floorUsd * (1 - 1e-9) && c <= MAX_CUT_USD) ? cuts : null;
}
/** Add a minute's large orders to `over` ([buy from cut 0, sell from cut 0, buy from cut 1, ...]). */
function addOver(over: number[], big: readonly number[], cuts: readonly number[]): void {
  for (const v of big) {
    const usd = Math.abs(v), side = v > 0 ? 0 : 1;
    for (let k = 0; k < cuts.length; k++) if (usd >= cuts[k]!) over[2 * k + side]! += usd;
  }
}

/**
 * The trades of some instruments added together over the last `minutes` whole minutes (the open minute is the first of them), as the page's
 * strip asks for them. `seen` is how many of those minutes have footprint rows for at least one instrument, `stats` how many carry trade
 * statistics: a minute nobody recorded is told apart from a minute with nothing in it only by the others having rows, and a minute recorded
 * before statistics were kept has rows and no statistics.
 */
export interface SizesWindow {
  minutes: number; seen: number; stats: number; buyN: number; sellN: number; buy: number[]; sell: number[];
  /** USD of the orders from each size line asked for, bought then sold (see `addOver`); absent when a minute counted has no list (or none was asked). */
  over?: number[];
}
export interface SizesAnswer { windows: SizesWindow[] }
/** The most windows, and the longest, one question may ask for. */
export const MAX_SIZES_WINDOWS = 6, MAX_SIZES_MINUTES = 1_440;

/**
 * A sizes answer checked field by field against the windows that were asked for (same lengths, same order): the answer, or null when it is
 * anything else (an old server's error page, a cut-off body). Counts are whole numbers, USD are finite and not negative. A window's `over`
 * is kept when it holds two sums for each of the `cuts` size lines asked for; one of another length (or a server that does not draw lines)
 * leaves the window without it, and the reader falls back to the boxes.
 */
export function parseSizes(value: unknown, windows: readonly number[], cuts = 0): SizesAnswer | null {
  const list = (value as { windows?: unknown } | null)?.windows;
  if (!Array.isArray(list) || list.length !== windows.length) return null;
  const whole = (v: unknown, max: number): v is number => typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= max;
  const sums = (v: unknown, n: number): v is number[] => Array.isArray(v) && v.length === n && v.every(x => typeof x === 'number' && Number.isFinite(x) && x >= 0);
  const usd = (v: unknown): v is number[] => sums(v, SIZE_EDGES.length);
  const out: SizesWindow[] = [];
  for (let i = 0; i < windows.length; i++) {
    const w = list[i] as Partial<SizesWindow> | null;
    if (!w || w.minutes !== windows[i] || !whole(w.seen, w.minutes) || !whole(w.stats, w.minutes) || w.stats > w.seen || !whole(w.buyN, Number.MAX_SAFE_INTEGER) || !whole(w.sellN, Number.MAX_SAFE_INTEGER) || !usd(w.buy) || !usd(w.sell)) return null;
    out.push({ minutes: w.minutes, seen: w.seen, stats: w.stats, buyN: w.buyN, sellN: w.sellN, buy: [...w.buy], sell: [...w.sell], ...(cuts > 0 && sums(w.over, 2 * cuts) ? { over: [...w.over] } : {}) });
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
/** The longest window a profile question may cover (a server keeps a week of trades, so nothing older is there to add up). */
export const MAX_PROFILE_SPAN_MS = 8 * 86_400_000;

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
 * rows of `step` over every price: see `shared/profile.ts`. `minutes` is the most minutes any instrument recorded in the window. `covered`
 * (0..1) is how much of the window, up to the source's clock, the recording holds: each instrument's volume over its own recorded minutes
 * stands for its rate, so the volume of the minutes it did not record is estimated and the share is the recorded part of the whole: an
 * estimate, which assumes a venue trades at the same rate when it was not recorded. An instrument recorded in none of the window's
 * minutes says nothing of its part, so the share is then 0 (not known). Absent from an older source, which a reader judges by
 * `minutes`. A window in which nothing traded has null levels. `asOf` is the source's clock when it answered: a window that had ended a
 * while before then will not change.
 */
export interface ValueAreaWindow { from: number; to: number; minutes: number; total: number; poc: number | null; vah: number | null; val: number | null; covered?: number }
export interface ValueAreaAnswer { step: number; share: number; windows: ValueAreaWindow[]; asOf?: number }
/** The most windows one question may name, and the most time they may add up to (each minute of each is walked: a day takes about 90 ms). */
export const MAX_VALUE_AREA_WINDOWS = 24, MAX_VALUE_AREA_SPAN_MS = 8 * 86_400_000;

/** A value-area answer checked field by field against the windows asked for (same number, same order). */
export function parseValueAreas(value: unknown, windows: readonly { from: number; to: number }[]): ValueAreaAnswer | null {
  const body = value as { step?: unknown; share?: unknown; windows?: unknown; asOf?: unknown } | null;
  const num = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
  const price = (v: unknown): v is number | null => v === null || num(v);
  if (!body || !num(body.step) || !(body.step > 0) || !num(body.share) || !Array.isArray(body.windows) || body.windows.length !== windows.length) return null;
  if (body.asOf !== undefined && !num(body.asOf)) return null;
  const out: ValueAreaWindow[] = [];
  for (let k = 0; k < windows.length; k++) {
    const w = body.windows[k] as Partial<Record<keyof ValueAreaWindow, unknown>> | null;
    if (!w || w.from !== windows[k]!.from || w.to !== windows[k]!.to || !num(w.minutes) || !Number.isInteger(w.minutes) || w.minutes < 0 || !num(w.total) || w.total < 0
      || !price(w.poc) || !price(w.vah) || !price(w.val) || (w.poc === null) !== (w.vah === null) || (w.poc === null) !== (w.val === null)) return null;
    if (w.covered !== undefined && !(num(w.covered) && w.covered >= 0 && w.covered <= 1)) return null;
    out.push({ from: w.from as number, to: w.to as number, minutes: w.minutes, total: w.total, poc: w.poc, vah: w.vah, val: w.val, ...(w.covered !== undefined ? { covered: w.covered as number } : {}) });
  }
  return { step: body.step, share: body.share, windows: out, ...(body.asOf !== undefined ? { asOf: body.asOf as number } : {}) };
}

export interface FootprintBar {
  t: number; rows: FootprintRow[]; buyUsd: number; sellUsd: number;
  /** How many of the bar's minutes were recorded, so a reader can tell a whole candle from one seen only in part. */
  minutes: number;
  /** Present only when every recorded minute of the bar carried trade stats. */
  stats?: TradeStats;
  /** USD of the orders from each size line asked for, bought then sold (see `addOver`); present only when every minute's list is known. */
  over?: number[];
  /** Asked for by venue (several markets): each row's markets with volume there, as [place in the answer's `venues`, buy, sell, ...]. */
  venueRows?: number[][];
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
const copyStats = (stats: TradeStats | undefined): TradeStats | null => stats ? { buyN: stats.buyN, sellN: stats.sellN, buy: [...stats.buy], sell: [...stats.sell], v: STATS_VERSION, ...(stats.big ? { big: [...stats.big] } : {}) } : null;

/**
 * The row a price falls in. A price that is a whole number of steps is a boundary and belongs to the row above it, but the division can come
 * out a hair under the whole number (100.3 / 0.1), which would put it in the row below: a part in 10^12 is forgiven. `slack` is how far
 * under its true price a price may read (the trade dust keeps prices as float32 offsets, tape/ring.ts), forgiven as well. Every count of
 * trades by price uses this one rule (the footprint here, the Tape's rows and rail), so they agree on the row of a price at a boundary.
 */
export const binOf = (price: number, step: number, slack = 0): number => Math.floor((price + slack) / step * (1 + 1e-12));

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
  /**
   * A store that reads back on demand (the server's; the browser's holds its day in memory): one instrument's minutes in [from, to), oldest
   * first. Their statistics may be left out (null): the recorder holds every minute's statistics in memory.
   */
  range?(inst: string, from: number, to: number): FootprintMinuteRow[];
}

/** A stored minute's rows as held: five numbers a row in a minute that counts orders by price, else three (the counts then zero). */
function binsOfRow(row: FootprintMinuteRow): { bins: Bins; counted: boolean } {
  const counted = row.bins.length > 0 && row.bins.every(b => b.length === 5);
  return { bins: new Map(row.bins.map(b => [b[0], [b[1], b[2], counted ? b[3]! : 0, counted ? b[4]! : 0] as Cell])), counted };
}

/**
 * Per-instrument, per-minute taker buy/sell USD by price row.
 *
 * Each minute's sums and statistics are held for the whole retention; its rows for `memoryMs` (all of it by default). With a store that reads
 * back, older rows are read from it when a question reaches them, and a minute that a late trade or order changes is read back into memory
 * first, so it is never written over with a part of itself. A minute leaves memory only once the store has it.
 */
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
  readonly #memoryMs: number;
  /** Older rows are read back from the store (it can, and memory holds less than the retention). */
  readonly #cold: boolean;
  /** Every minute from here on has its rows in memory (before it, only the ones read back to be changed). */
  #hotFrom = -Infinity;
  /** Where the retention began at the last flush (or at start): nothing older is read back. */
  #cutoff: number;
  /** Hours of rows read back, by instrument and hour (only hours before `#hotFrom`), weighed in minutes. */
  readonly #coldHours: KeptCache<Map<number, Bins>>;
  /**
   * Ended hours of each instrument's rows added together ([bin, buy, sell] in a row, on the step they were added on), so a bar of whole hours
   * reads one entry an hour rather than sixty minutes (`#hourRows`; zooming out over a week of fourteen markets read 112,000 minutes back,
   * 2026-10-14). Dropped when a minute of the hour changes (`#rowsToChange`, the one way in for a trade or an order) and at the retention
   * cutoff, so held no longer than the minutes' sums.
   */
  readonly #hours = new Map<string, Map<number, HourRows>>();
  /** Market orders not counted yet because a minute they change could not be read back (`countOrders`); fills not taken yet (`ingest`). */
  #uncounted: OrderLike[] = [];
  #untaken: TradeLike[] = [];
  /** The size buckets' edges are SIZE_EDGES times this (1 for BTC; smaller for a coin that trades less). */
  readonly sizeScale: number;

  constructor(store: FootprintStore | null = null, protected now: () => number = Date.now, retentionMs: number = RETENTION_MS, sizeScale = 1, memoryMs: number = retentionMs, coldCacheMinutes = COLD_CACHE_MINUTES) {
    this.#store = store; this.#retentionMs = retentionMs; this.sizeScale = sizeScale; this.#coldHours = new KeptCache(coldCacheMinutes, now);
    this.#cold = store !== null && typeof store.range === 'function' && memoryMs < retentionMs;
    this.#memoryMs = this.#cold ? memoryMs : retentionMs;
    const start = now();
    this.#cutoff = start - retentionMs;
    if (this.#cold) this.#hotFrom = Math.floor((start - memoryMs) / MINUTE) * MINUTE;
    if (store) {
      for (const row of store.load(this.#cutoff)) {
        this.#steps.set(row.inst, row.step);
        // Statistics of an older version counted fills, not orders: such a minute is kept as one recorded without statistics.
        const stats = current(row.stats);
        if (stats) this.#minuteStats(row.inst).set(row.t, stats);
        const { bins, counted } = binsOfRow(row);
        if (row.t >= this.#hotFrom) this.#minute(row.inst).set(row.t, bins);
        this.#minuteSums(row.inst).set(row.t, sumOf(bins, counted));
      }
    }
  }

  /**
   * A minute's rows to change: in memory, or (an older minute, recorded) read back into memory from the store, so what is written for it
   * next holds all of it. Undefined when the minute has none.
   */
  #rowsToChange(id: string, minute: number): Bins | undefined {
    // The hour's rows added together no longer hold: they are added again when next asked.
    this.#hours.get(id)?.delete(Math.floor(minute / HOUR) * HOUR);
    const held = this.#minutes.get(id)?.get(minute);
    if (held || !this.#cold || minute >= this.#hotFrom || !this.#sums.get(id)?.has(minute)) return held;
    const row = this.#store!.range!(id, minute, minute + MINUTE).find(r => r.t === minute);
    if (!row) return undefined;
    const { bins } = binsOfRow(row);
    // While it is in memory it is answered from memory; when it leaves, its kept hour goes too (`flush`).
    this.#minute(id).set(minute, bins);
    return bins;
  }

  /**
   * One instrument's minutes in [from, to) with their rows, oldest first: read back before the minutes held in memory, then from memory (a
   * minute read back to be changed is newer in memory than anywhere else).
   */
  #rowsIn(id: string, from: number, to: number): Map<number, Bins> {
    const out = new Map<number, Bins>(), minutes = this.#minutes.get(id);
    if (this.#cold) this.#readBack(id, Math.max(from, this.#cutoff), Math.min(to, this.#hotFrom), out);
    if (minutes) { const inside: [number, Bins][] = []; for (const [t, bins] of minutes) if (t >= from && t < to) inside.push([t, bins]); for (const [t, bins] of inside.sort((a, b) => a[0] - b[0])) out.set(t, bins); }
    return out;
  }

  /**
   * The minutes of [lo, hi) from the store, into `out` oldest first, by the hour: a kept hour as it is, a run of the others read in one pass
   * and kept hour by hour (only hours wholly before what memory holds, and inside the retention).
   */
  #readBack(id: string, lo: number, hi: number, out: Map<number, Bins>): void {
    if (!(hi > lo)) return;
    for (let h = Math.floor(lo / HOUR) * HOUR; h < hi;) {
      const kept = this.#coldHours.get(`${id}|${h}`);
      if (kept) {
        for (const [t, bins] of kept) if (t >= lo && t < hi) out.set(t, bins);
        h += HOUR; continue;
      }
      let end = h + HOUR;
      while (end < hi && !this.#coldHours.has(`${id}|${end}`)) end += HOUR;
      const read = this.#store!.range!(id, Math.max(h, this.#cutoff), Math.min(end, this.#hotFrom));
      for (let hour = h, at = 0; hour < end; hour += HOUR) {
        const minutes = new Map<number, Bins>();
        for (; at < read.length && read[at]!.t < hour + HOUR; at++) minutes.set(read[at]!.t, binsOfRow(read[at]!).bins);
        if (hour >= this.#cutoff && hour + HOUR <= this.#hotFrom) this.#coldHours.set(`${id}|${hour}`, minutes, Math.max(1, minutes.size));
        for (const [t, bins] of minutes) if (t >= lo && t < hi) out.set(t, bins);
      }
      h = end;
    }
  }

  /**
   * An ended hour of `id`'s rows added together, inside the retention: the one held, or (with `build`) added up now from its minutes (read
   * back from the store where memory no longer has them). Null for the hour under way, one outside the retention, or one not held without
   * `build`.
   */
  #hourRows(id: string, hour: number, build: boolean): HourRows | null {
    const step = this.#steps.get(id);
    if (!step || hour + HOUR > this.now() || hour < this.now() - this.#retentionMs || hour < this.#cutoff) return null;
    const held = this.#hours.get(id)?.get(hour);
    if (held && held.step === step) return held;
    if (!build) return null;
    const sum = new Map<number, [number, number, number, number]>();
    const into = (bin: number, buy: number, sell: number, buyN: number, sellN: number): void => { const s = sum.get(bin); if (s) { s[0] += buy; s[1] += sell; s[2] += buyN; s[3] += sellN; } else sum.set(bin, [buy, sell, buyN, sellN]); };
    // An hour only the store holds (no minute of it in memory, none kept read back) is added up from the stored rows as they come: making
    // each minute's map and keeping the hour read back cost more than adding it (measured 2026-10-14).
    const minutes = this.#minutes.get(id), onlyStored = this.#cold && hour + HOUR <= this.#hotFrom && !this.#coldHours.has(`${id}|${hour}`)
      && !(minutes && Array.from({ length: HOUR / MINUTE }, (_, i) => hour + i * MINUTE).some(t => minutes.has(t)));
    // A stored minute that counts orders by price has five numbers a row (`StoredBin`), any other three.
    if (onlyStored) for (const row of this.#store!.range!(id, hour, hour + HOUR)) for (const b of row.bins) into(b[0], b[1], b[2], b[3] ?? 0, b[4] ?? 0);
    else for (const bins of this.#rowsIn(id, hour, hour + HOUR).values()) for (const [bin, cell] of bins) into(bin, cell[0], cell[1], cell[2], cell[3]);
    const cells = new Float64Array(HOUR_CELL * sum.size); let i = 0;
    for (const [bin, [buy, sell, buyN, sellN]] of sum) { cells[i++] = bin; cells[i++] = buy; cells[i++] = sell; cells[i++] = buyN; cells[i++] = sellN; }
    let byHour = this.#hours.get(id); if (!byHour) { byHour = new Map(); this.#hours.set(id, byHour); }
    const rows: HourRows = { step, cells }; byHour.set(hour, rows);
    return rows;
  }

  /** Let go of the kept hour that holds `minute` of `id` (it is about to change, or has). */
  #forgetHour(id: string, minute: number): void { this.#coldHours.delete(`${id}|${Math.floor(minute / HOUR) * HOUR}`); }

  #minuteStats(id: string): Map<number, TradeStats> { let m = this.#stats.get(id); if (!m) { m = new Map(); this.#stats.set(id, m); } return m; }
  #minute(id: string): Map<number, Bins> { let m = this.#minutes.get(id); if (!m) { m = new Map(); this.#minutes.set(id, m); } return m; }
  #minuteSums(id: string): Map<number, MinuteSum> { let m = this.#sums.get(id); if (!m) { m = new Map(); this.#sums.set(id, m); } return m; }
  step(id: string): number | undefined { return this.#steps.get(id); }
  /** Instruments with a recorded minute. */
  get instruments(): string[] { return [...this.#sums.keys()]; }
  /** Whether the minute starting at `t` has rows for `id` (in memory or in the store). */
  holds(id: string, t: number): boolean { return this.#sums.get(id)?.has(t) === true; }
  /** The first and the last minute recorded for `id` (Infinity and -Infinity when none is). */
  #recordedSpan(id: string): { first: number; last: number } {
    let first = Infinity, last = -Infinity;
    for (const t of this.#sums.get(id)?.keys() ?? []) { if (t < first) first = t; if (t > last) last = t; }
    return { first, last };
  }
  /** The start (ms) of the newest minute recorded for `id`, or 0. */
  lastMinute(id: string): number { let newest = 0; for (const t of this.#sums.get(id)?.keys() ?? []) if (t > newest) newest = t; return newest; }

  /**
   * Add every fill not seen before to its price row. Returns the number accepted. Orders are counted separately (`countOrders`).
   *
   * A fill for an older minute that only the store holds reads that minute back first; when the store fails to, the fill is not taken (nor
   * marked seen) but kept, and taken first with the next fills (at most UNTAKEN_MAX; one whose minute the retention has passed meanwhile is
   * let go, as that minute was): a connector's trade comes once, and one handed over again (the feed's recent trades come on every pass)
   * is then seen and taken once. Only a fill more than `memoryMs` late reads the store at all. `taken` is told each fill accepted (the
   * coverage record's seam: a list handed over whole every pass says which of its fills are new only here).
   */
  ingest(trades: Iterable<TradeLike>, taken?: (trade: TradeLike) => void): number {
    let accepted = 0;
    const cutoff = this.now() - this.#retentionMs, kept = new Set<string>();
    // A waiting fill whose minute the retention has passed goes, counted as seen, as it would have been had it been taken (a copy handed
    // over again does not bring the minute back).
    const was = this.#untaken.filter(trade => {
      if (Math.floor(Number(trade.sourceTimestamp ?? trade.receivedAt) / MINUTE) * MINUTE >= cutoff) return true;
      const id = String(trade.instrumentId);
      let seen = this.#seen.get(id); if (!seen) { seen = new Set(); this.#seen.set(id, seen); }
      seen.add(String(trade.tradeId));
      return false;
    });
    this.#untaken = [];
    for (const trade of was.length ? [...was, ...trades] : trades) {
      const id = String(trade.instrumentId ?? ''), key = String(trade.tradeId ?? '');
      const price = Number(trade.price), usd = Number(trade.notionalUsd ?? Number(trade.amount) * price);
      const t = Number(trade.sourceTimestamp ?? trade.receivedAt);
      const side = String(trade.side).toLowerCase();
      if (!id || !key || !(price > 0) || !(usd > 0) || !Number.isFinite(t) || (side !== 'buy' && side !== 'sell')) continue;
      let seen = this.#seen.get(id); if (!seen) { seen = new Set(); this.#seen.set(id, seen); }
      if (seen.has(key)) continue;
      const minute = Math.floor(t / MINUTE) * MINUTE;
      // Read back first: a store that fails here leaves the fill unseen and nothing changed.
      let bins: Bins | undefined;
      try { bins = this.#rowsToChange(id, minute); }
      catch (error) {
        if (!was.length && !this.#untaken.length) console.warn('trades could not be taken yet (a recorded minute could not be read back); kept for the next try:', error);
        // Once each: the feed hands its recent trades over again on every pass, and copies would fill the room a connector's trade needs.
        if (!kept.has(`${id}|${key}`) && this.#untaken.length < UNTAKEN_MAX) { kept.add(`${id}|${key}`); this.#untaken.push(trade); }
        continue;
      }
      const restored = bins !== undefined;
      seen.add(key);
      if (seen.size > 30_000) { const keep = [...seen].slice(-10_000); seen.clear(); for (const k of keep) seen.add(k); }
      let step = this.#steps.get(id);
      if (!step) { step = gridStepFor(price) / FINE_DIV; this.#steps.set(id, step); }
      const minutes = this.#minute(id);
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
      if (!restored) { const stats = this.#minuteStats(id); if (!stats.has(minute)) stats.set(minute, { ...emptyStats(), big: NO_BIG }); }
      this.#dirty.add(`${id}|${minute}`);
      accepted++;
      taken?.(trade);
    }
    return accepted;
  }

  /**
   * Count market orders (their fills went to `ingest` first) in the statistics of the minute of each one's first fill, and in the row of the
   * price it started at: the best price it took, where it met the resting orders (a buy's lowest fill, a sell's highest). A minute without
   * statistics (restored from before they counted orders) stays without, and one that does not count by price gets no counts in its rows.
   *
   * The orders are the recorder's once given: the server takes them from the order builder, which will not give them again. Every older
   * minute they change that only the store holds is read back first (it is written whole again with its statistics); when the store fails
   * to read one, none of them is counted yet, and they are counted first with the next orders (at most UNCOUNTED_MAX are kept), so none is
   * lost or counted twice for it.
   */
  countOrders(orders: Iterable<OrderLike>): void {
    const was = this.#uncounted.length, list = was ? [...this.#uncounted, ...orders] : [...orders];
    const counts = (order: OrderLike): boolean => order.usd > 0 && this.#stats.get(order.instrumentId)?.has(Math.floor(order.t / MINUTE) * MINUTE) === true;
    const wait = (error: unknown): void => {
      this.#uncounted = list.length > UNCOUNTED_MAX ? list.slice(0, UNCOUNTED_MAX) : list;
      if (!was && error) console.warn('market orders could not be counted yet (a recorded minute could not be read back); kept for the next try:', error);
    };
    // While fills wait (`ingest` could not read their minute), the orders wait too: an order is counted in the row of its first fill's
    // price, which may be a fill still waiting.
    if (this.#untaken.length) { wait(null); return; }
    try { for (const order of list) if (counts(order)) this.#rowsToChange(order.instrumentId, Math.floor(order.t / MINUTE) * MINUTE); }
    catch (error) { wait(error); return; }
    this.#uncounted = [];
    for (const order of list) {
      if (!counts(order)) continue;
      const id = order.instrumentId, minute = Math.floor(order.t / MINUTE) * MINUTE, stats = this.#stats.get(id)!.get(minute)!;
      const bins = this.#rowsToChange(id, minute);
      const bucket = sizeBucket(order.usd / this.sizeScale);
      if (order.side === 'buy') { stats.buyN++; stats.buy[bucket]! += order.usd; } else { stats.sellN++; stats.sell[bucket]! += order.usd; }
      // From the second bucket up the order itself is kept too (a minute without a list, restored from before they were kept, stays without).
      if (bucket >= 1 && stats.big) { if (stats.big === NO_BIG) stats.big = []; stats.big.push(order.side === 'buy' ? order.usd : -order.usd); }
      const step = this.#steps.get(id), start = order.side === 'buy' ? order.lo ?? order.price : order.hi ?? order.price;
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
    for (const byHour of this.#hours.values()) for (const hour of byHour.keys()) if (hour < cutoff) byHour.delete(hour);
    // Nothing older is read back from here on, whether or not the store takes what follows (one that fails keeps its expired rows).
    if (this.#cold) {
      this.#cutoff = cutoff;
      this.#coldHours.deleteWhere(key => Number(key.slice(key.lastIndexOf('|') + 1)) < cutoff);
    }
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
    // Reading back, the rows of minutes past `memoryMs` that the store now has leave memory (their sums and statistics stay); one still to
    // be written stays until it is. A kept hour that held one read back to be changed is read again (it has the minute as it was).
    if (this.#cold) {
      const from = Math.floor((this.now() - this.#memoryMs) / MINUTE) * MINUTE;
      for (const [id, minutes] of this.#minutes) for (const t of minutes.keys()) if (t < from && !this.#dirty.has(`${id}|${t}`)) { minutes.delete(t); if (t < this.#hotFrom) this.#forgetHour(id, t); }
      if (from > this.#hotFrom) this.#hotFrom = from;
    }
  }
  close(): void {
    // Fills and orders waiting for a read that failed are tried once more, so a store that has recovered still gets them.
    try { if (this.#untaken.length) this.ingest([]); if (this.#uncounted.length) this.countOrders([]); }
    catch (error) { console.error('footprint: what was waiting could not be taken at close:', error); }
    this.flush(true); this.#store?.close();
  }

  /**
   * The trades of these instruments added together over each of the last `windows` minutes (see `SizesAnswer`), by this recorder's own clock,
   * with the orders from each of the `cuts` size lines (USD, from the second bucket's edge; see `parseCuts`).
   */
  sizes(ids: readonly string[], windows: readonly number[], cuts: readonly number[] = []): SizesAnswer {
    // A minute recorded is one with sums: held for the whole retention, rows in memory or not.
    return sizesOf({ minutes: id => this.#sums.get(id), stats: id => this.#stats.get(id) }, ids, windows, this.now(), cuts);
  }

  /** The smallest size a line can be drawn at: the second bucket's edge for this coin (what the lists hold). */
  get floorUsd(): number { return SIZE_EDGES[1]! * this.sizeScale; }

  /**
   * Give the minutes of [from, to) whose list of large orders is not known (recorded before the lists were kept) the one `prints` make:
   * the large orders of every instrument in that stretch, each once (the print stream keeps every order from the same floor, rebuilt from
   * the same fills; checked equal to the boxes to the dollar on the live recording, 2026-10-10). A minute gets the list only where it adds
   * up to the minute's own boxes from the floor, side by side: a store that kept two identical orders as one row, or lost some, would
   * otherwise make a line look exact while missing orders, so such a minute stays not known (its lines fall back to the boxes). Kept in
   * memory only: writing the minutes back would rewrite a week of rows. Returns how many minutes were given a list, and how many were not
   * because their orders did not add up.
   */
  fillLists(from: number, to: number, prints: Iterable<{ id: string; t: number; side: 'buy' | 'sell'; usd: number }>): { filled: number; mismatched: number } {
    const found = new Map<string, Map<number, number[]>>();
    for (const p of prints) {
      if (!(p.t >= from && p.t < to) || !(p.usd >= this.floorUsd * (1 - 1e-9))) continue;
      let minutes = found.get(p.id); if (!minutes) { minutes = new Map(); found.set(p.id, minutes); }
      const minute = Math.floor(p.t / MINUTE) * MINUTE, list = minutes.get(minute);
      if (list) list.push(p.side === 'buy' ? p.usd : -p.usd); else minutes.set(minute, [p.side === 'buy' ? p.usd : -p.usd]);
    }
    let filled = 0, mismatched = 0;
    for (const [id, minutes] of this.#stats) for (const [t, stats] of minutes) {
      if (stats.big !== undefined || t < from || t >= to) continue;
      const list = found.get(id)?.get(t) ?? NO_BIG;
      if (!listFits(list, stats)) { mismatched++; continue; }
      stats.big = list; filled++;
    }
    return { filled, mismatched };
  }

  /** The stretch from the oldest to the newest minute whose list is not known (null when every list is), for `fillLists`. */
  unknownLists(): { from: number; to: number } | null {
    let from = Infinity, to = -Infinity;
    for (const minutes of this.#stats.values()) for (const [t, stats] of minutes) if (stats.big === undefined) { if (t < from) from = t; if (t + MINUTE > to) to = t + MINUTE; }
    return from < to ? { from, to } : null;
  }

  /** Traded volume by price for each of `ids` over the minutes that start in [from, to), rows merged to `rowStep` (see `ProfileAnswer`). */
  profile(ids: readonly string[], from: number, to: number, rowStep: number): ProfileAnswer { return drain(this.#profileRun(ids, from, to, rowStep)); }

  /**
   * The same answer, read a few hours of a market at a time with the event loop let go between (as `prepare`): a week of twenty-seven markets
   * read in one go held a server's only thread for 7 to 9 seconds (measured 2026-10-18), and nothing else it does, the feeds included, ran meanwhile.
   */
  profileYielding(ids: readonly string[], from: number, to: number, rowStep: number): Promise<ProfileAnswer> { return spread(this.#profileRun(ids, from, to, rowStep)); }

  /** The answer of `profile`, paused (yielded) after every slice of rows read: each minute is read once, from wherever it is held at that moment. */
  *#profileRun(ids: readonly string[], from: number, to: number, rowStep: number): Generator<void, ProfileAnswer> {
    const instruments: ProfileInstrument[] = [];
    for (const id of ids) {
      const fine = this.#steps.get(id), sums = this.#sums.get(id);
      if (!fine || !sums || !sums.size) { instruments.push({ id, step: 0, rows: [], minutes: 0, first: null, earliest: null }); continue; }
      const factor = Math.max(1, Math.round(rowStep / fine)), step = fine * factor, rows = new Map<number, [number, number, number, number]>();
      let count = 0, counted = 0, first: number | null = null, earliest: number | null = null, newest = -Infinity;
      // Every recorded minute has its sums held; the rows of those in the window are read where they are held.
      for (const [t, sum] of sums) {
        if (earliest === null || t < earliest) earliest = t;
        if (t > newest) newest = t;
        if (t < from || t >= to) continue;
        count++; if (first === null || t < first) first = t;
        if (sum.counted) counted++;
      }
      // No minute outside the recorded stretch has rows, so a window reaching before it or ahead of it (a week not over yet) reads only inside it.
      const end = Math.min(to, newest + MINUTE);
      const add = (bin: number, buy: number, sell: number, buyN: number, sellN: number): void => {
        const row = Math.floor(bin / factor), cell = rows.get(row) ?? [0, 0, 0, 0]; cell[0] += buy; cell[1] += sell; cell[2] += buyN; cell[3] += sellN; rows.set(row, cell);
      };
      // Each ended hour inside the window is read added together (`#hourRows`, kept once built, dropped when a minute of it changes), the
      // minutes around them one by one: a week of 27 markets read minute by minute took 15 s of a server's time (measured 2026-10-19).
      if (count) for (let a = Math.max(from, earliest!), read = 0; a < end;) {
        const hour = a % HOUR === 0 && a + HOUR <= end ? this.#hourRows(id, a, true) : null;
        if (hour && hour.step === fine) {
          for (let i = 0; i < hour.cells.length; i += HOUR_CELL) add(hour.cells[i]!, hour.cells[i + 1]!, hour.cells[i + 2]!, hour.cells[i + 3]!, hour.cells[i + 4]!);
          a += HOUR; read += HOUR;
        } else {
          const b = Math.min(end, (Math.floor(a / HOUR) + 1) * HOUR);
          for (const bins of this.#rowsIn(id, a, b).values()) for (const [bin, [buy, sell, buyN, sellN]] of bins) add(bin, buy, sell, buyN, sellN);
          read += b - a; a = b;
        }
        if (read >= READ_SLICE_MS) { read = 0; yield; }
      }
      const sorted = [...rows].sort((a, b) => a[0] - b[0]);
      instruments.push({ id, step, rows: sorted.map(([row, [buy, sell]]): FootprintRow => [row * step, buy, sell]), minutes: count, first, earliest, counts: sorted.map(([, c]): [number, number] => [c[2], c[3]]), counted });
    }
    return { from, to, instruments };
  }

  /**
   * Amounts spread over the prices that traded while they came about (the open-interest change by price, shared/oi-profile.ts): each
   * interval's signed `amount` over the rows of `id`'s minutes that start in [from, to), by each row's share of their USD. In coins
   * (`coins`) a row's part is valued at its own price, else it is taken as USD. Positive parts add up in a row's first side, negative ones
   * (as magnitudes) in its second, on rows merged to `rowStep`. An interval whose minutes traded nothing here is not placed: its amount, in
   * USD (coins at `price`), is `unplaced`, signed. The parts of an interval add up to its amount: nothing is made or lost by the spreading.
   */
  spread(id: string, rowStep: number, intervals: readonly { from: number; to: number; amount: number }[], coins: boolean, price: number): { step: number; rows: FootprintRow[]; unplaced: number } {
    const fine = this.#steps.get(id), usdOf = (amount: number): number => amount * (coins ? price : 1);
    let unplaced = 0, lo = Infinity, hi = -Infinity;
    for (const i of intervals) { if (i.from < lo) lo = i.from; if (i.to > hi) hi = i.to; }
    if (!fine || !(hi > lo)) { for (const i of intervals) unplaced += usdOf(i.amount); return { step: 0, rows: [], unplaced }; }
    // Minutes older than what memory holds (a server's day) are weighed by the prices of their hours added together (`#hourRows`, the ones
    // the volume profile reads): reading a week of them back minute by minute took 3 s of a server's time (measured 2026-10-19). Within
    // memory every change is spread over its own minutes.
    const hot = this.#cold ? this.#hotFrom : -Infinity;
    const factor = Math.max(1, Math.round(rowStep / fine)), step = fine * factor, out = new Map<number, [number, number]>(), minutes = this.#rowsIn(id, Math.max(lo, hot), hi);
    /** Spread `up` (added) and `down` (removed, a magnitude) over these [bin, USD] weights; false when nothing traded under them. */
    const spreadOver = (cells: readonly [number, number][], total: number, up: number, down: number): boolean => {
      if (!(total > 0)) return false;
      for (const [bin, usd] of cells) {
        const w = usd / total * (coins ? (bin + 0.5) * fine : 1), row = Math.floor(bin / factor), sides = out.get(row) ?? [0, 0];
        sides[0] += up * w; sides[1] += down * w; out.set(row, sides);
      }
      return true;
    };
    const hourCells = (from: number, to: number): { cells: [number, number][]; total: number } => {
      const cells: [number, number][] = []; let total = 0;
      for (let h = Math.floor(from / HOUR) * HOUR; h < to; h += HOUR) {
        const hour = this.#hourRows(id, h, true); if (!hour || hour.step !== fine) continue;
        for (let i = 0; i < hour.cells.length; i += HOUR_CELL) { const usd = hour.cells[i + 1]! + hour.cells[i + 2]!; cells.push([hour.cells[i]!, usd]); total += usd; }
      }
      return { cells, total };
    };
    // Changes weighed by one and the same hour share its weights: added up per hour (increases and decreases apart) and spread once.
    const byHour = new Map<number, [number, number]>();
    for (const { from, to, amount } of intervals) {
      if (!amount) continue;
      const up = Math.max(amount, 0), down = Math.max(-amount, 0);
      if (from < hot) {
        const h = Math.floor(from / HOUR) * HOUR;
        if (to <= h + HOUR) { const sum = byHour.get(h) ?? [0, 0]; sum[0] += up; sum[1] += down; byHour.set(h, sum); continue; }
        const { cells, total } = hourCells(from, to);
        if (!spreadOver(cells, total, up, down)) unplaced += usdOf(amount);
        continue;
      }
      const cells: [number, number][] = []; let total = 0;
      for (let t = Math.ceil(from / MINUTE) * MINUTE; t < to; t += MINUTE) { const bins = minutes.get(t); if (bins) for (const [bin, cell] of bins) { cells.push([bin, cell[0] + cell[1]]); total += cell[0] + cell[1]; } }
      if (!spreadOver(cells, total, up, down)) unplaced += usdOf(amount);
    }
    for (const [h, [up, down]] of byHour) {
      const { cells, total } = hourCells(h, h + HOUR);
      if (!spreadOver(cells, total, up, down)) unplaced += usdOf(up - down);
    }
    return { step, rows: [...out].sort((a, b) => a[0] - b[0]).map(([row, [up, down]]): FootprintRow => [row * step, up, down]), unplaced };
  }

  /**
   * What happened in a selection (see `RangeAnswer`): one pass over its minutes, each looked up by its key. A minute's sums answer the
   * questions about every price, and a box skips the rows of a minute that traded wholly outside its band.
   */
  range(ids: readonly string[], from: number, to: number, band: { p0: number; p1: number } | null, rowStep: number): RangeAnswer {
    const first = Math.ceil(from / MINUTE) * MINUTE, span = Math.max(0, to - first);
    const merged = new Map<number, RangeRow>(), instruments: RangeInstrument[] = [];
    for (const id of ids) {
      const fine = this.#steps.get(id), sums = this.#sums.get(id);
      const out: RangeInstrument = { id, band: { buy: 0, sell: 0, buyN: 0, sellN: 0 }, minutes: 0, counted: 0, countedFrom: null, countedUsd: { buy: 0, sell: 0 }, all: { buy: 0, sell: 0 }, before: { buy: 0, sell: 0, minutes: 0 } };
      instruments.push(out);
      if (!fine || !sums) continue;
      for (let t = first - span; t < first; t += MINUTE) { const s = sums.get(t); if (s) { out.before.buy += s.buy; out.before.sell += s.sell; out.before.minutes++; } }
      // The band's first and last rows (a row is inside when its low price is).
      const lo = band ? Math.ceil(band.p0 / fine * (1 - 1e-12)) : -Infinity, hi = band ? Math.ceil(band.p1 / fine * (1 - 1e-12)) : Infinity;
      // The rows are read only when a minute traded inside the band (its sums say where it traded): a box over prices no minute reached
      // reads nothing back. Every minute with sums has its rows, in memory or in the store, so the sums alone count the minutes then.
      let crosses = false;
      for (let t = first; t < to && !crosses; t += MINUTE) { const s = sums.get(t); if (s && !(s.hi < lo || s.lo >= hi)) crosses = true; }
      const held = crosses ? this.#rowsIn(id, first, to) : null;
      for (let t = first; t < to; t += MINUTE) {
        const s = sums.get(t), bins = held?.get(t);
        if (!s || (held && !bins)) continue;
        out.minutes++; out.all.buy += s.buy; out.all.sell += s.sell;
        if (s.counted) { out.counted++; if (out.countedFrom === null) out.countedFrom = t; }
        if (!bins || s.hi < lo || s.lo >= hi) continue;
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
   * `rowStep`; an instrument named twice counts once. Ended hours inside a window are read added together (`#hourRows`, built here when
   * not held; `prepare` can build them first, a few at a time), the minutes around them one by one. `recorded` says how many minutes of
   * [from, to) an instrument was recorded in (the coverage record, which tells a quiet minute from one nobody recorded); without it, the
   * minutes with trades.
   */
  valueAreas(ids: readonly string[], windows: readonly { from: number; to: number }[], rowStep: number, share: number, recorded?: (id: string, from: number, to: number) => number): ValueAreaAnswer {
    const out: ValueAreaWindow[] = [], known = [...new Set(ids)], now = this.now();
    for (const w of windows) {
      const rows = new Map<number, number>(), first = Math.ceil(w.from / MINUTE) * MINUTE, end = Math.min(w.to, now);
      // The window's time up to now, in minutes (the open minute in part), the basis of every instrument's recorded share.
      const span = Math.max(0, (end - first) / MINUTE);
      // An instrument recorded in none of it (or never) says nothing of its part: the share is not known, so it is none.
      let minutes = 0, total = 0, estimate = 0, unknown = false;
      for (const id of known) {
        const fine = this.#steps.get(id);
        if (!fine) { unknown = true; continue; }
        let usd = 0;
        const add = (bin: number, v: number): void => { const key = Math.floor(bin * fine / rowStep * (1 + 1e-12)); rows.set(key, (rows.get(key) ?? 0) + v); usd += v; };
        const minuteRows = (a: number, b: number): void => { if (b > a) for (const bins of this.#rowsIn(id, a, b).values()) for (const [bin, cell] of bins) add(bin, cell[0] + cell[1]); };
        let at = first;
        for (let h = Math.ceil(first / HOUR) * HOUR; h + HOUR <= w.to; h += HOUR) {
          const hour = this.#hourRows(id, h, true);
          if (!hour || hour.step !== fine) continue;
          minuteRows(at, h);
          for (let i = 0; i < hour.cells.length; i += HOUR_CELL) add(hour.cells[i]!, hour.cells[i + 1]! + hour.cells[i + 2]!);
          at = h + HOUR;
        }
        minuteRows(at, w.to);
        const sums = this.#sums.get(id);
        let seen = 0;
        if (sums) for (let t = first; t < w.to; t += MINUTE) if (sums.has(t)) seen++;
        minutes = Math.max(minutes, seen);
        total += usd;
        // Its volume over the minutes it was recorded in stands for its rate over the minutes it was not.
        const own = Math.min(span, recorded ? recorded(id, first, end) : seen);
        if (own > 0) estimate += usd * span / own; else unknown = true;
      }
      const levels = levelsOf(rows, rowStep, share);
      // Nothing traded on instruments all recorded: the share is how much of the window they were listened to.
      const covered = unknown || !(span > 0) ? 0 : estimate > 0 ? Math.min(1, total / estimate) : 1;
      out.push({ from: w.from, to: w.to, minutes, total, poc: levels?.poc ?? null, vah: levels?.vah ?? null, val: levels?.val ?? null, covered });
    }
    return { step: rowStep, share, windows: out, asOf: now };
  }

  /**
   * Bars of `tfMs` over [from, to), rows merged to `rowStep` (rounded to a multiple of the recorded step), with the orders from each of the
   * `cuts` size lines where every minute of the bar has its list.
   */
  query(id: string, from: number, to: number, tfMs: number, rowStep: number, cuts: readonly number[] = []): { step: number; fine: number; bars: FootprintBar[] } {
    const { step, fine, bars } = this.queryMany([id], from, to, tfMs, rowStep, cuts);
    return { step, fine, bars };
  }

  /**
   * How far back from `to` an answer goes for at most `budget` instrument-minutes recorded (whole bars, newest first, at least one): the
   * start of the oldest bar it takes, or `from` when the whole window fits. Merging the rows costs per instrument-minute (about 15 to 55 µs,
   * the more the older: those are read back from the store), and a request merges on the server's only thread, so a long window of many
   * markets is answered in slices (measured 2026-10-13: a week of 1 h bars of 14 markets took 8 s in one go).
   */
  #reach(ids: readonly string[], from: number, to: number, tfMs: number, budget: number): number {
    if (!Number.isFinite(budget)) return from;
    const series = ids.map(id => [id, this.#sums.get(id)] as const).filter((s): s is readonly [string, Map<number, MinuteSum>] => s[1] !== undefined);
    // A minute read back from the store costs about four held in memory (the SQL and the parsing of its rows, measured 2026-10-13).
    // Only minutes the recorder can hold are scanned: a window reaching years back or ahead costs what its retained part does.
    const lo = Math.max(from, this.#cutoff), hi = Math.min(to, this.now() + 2 * MINUTE);
    if (!(hi > lo)) return from;
    let spent = 0;
    for (let bar = Math.floor((hi - 1) / tfMs) * tfMs; bar + tfMs > lo; bar -= tfMs) {
      const start = Math.max(bar, lo), end = Math.min(bar + tfMs, hi);
      let cost = 0;
      // A whole hour held added together (bars of whole hours) costs HELD_HOUR_COST; the other minutes one each, four read back.
      const minutes = (s: Map<number, MinuteSum>, a: number, b: number): void => { for (let t = Math.ceil(a / MINUTE) * MINUTE; t < b; t += MINUTE) if (s.has(t)) cost += this.#cold && t < this.#hotFrom ? 4 : 1; };
      for (const [id, s] of series) {
        if (tfMs % HOUR !== 0) { minutes(s, start, end); continue; }
        for (let h = Math.floor(start / HOUR) * HOUR; h < end; h += HOUR) {
          if (h >= start && h + HOUR <= end && this.#hourRows(id, h, false)) cost += HELD_HOUR_COST;
          else minutes(s, Math.max(h, start), Math.min(h + HOUR, end));
        }
      }
      if (spent > 0 && spent + cost > budget) return bar + tfMs;
      spent += cost;
    }
    return from;
  }

  /**
   * Before a question for bars of whole hours (`queryMany`): the ended hours it will read, added together now (`#hourRows`), newest bar
   * first, a few at a time with the event loop let go between, so reading the store for them never holds the server for long. It stops after
   * the bar where the minutes read reach `budget` (one read back from the store counting four, as in `#reach`), the newest bar always whole:
   * the answer then reads one entry an hour (a day of fourteen markets is 336, not 20,160 minutes). Bars of fewer than an hour are not.
   */
  async prepare(ids: readonly string[], from: number, to: number, tfMs: number, budget = Infinity): Promise<void> {
    if (!(tfMs >= HOUR) || tfMs % HOUR !== 0) return;
    const known = [...new Set(ids)].filter(id => this.#steps.has(id));
    let spent = 0, turn = performance.now();
    for (let bar = Math.floor((Math.min(to, this.now()) - 1) / tfMs) * tfMs; bar + tfMs > Math.max(from, this.#cutoff); bar -= tfMs) {
      for (let h = Math.max(bar, Math.ceil(from / HOUR) * HOUR); h + HOUR <= Math.min(bar + tfMs, to); h += HOUR) for (const id of known) {
        if (this.#hourRows(id, h, false)) continue;
        const sums = this.#sums.get(id);
        if (sums) for (let t = h; t < h + HOUR; t += MINUTE) if (sums.has(t)) spent += this.#cold && t < this.#hotFrom ? 4 : 1;
        this.#hourRows(id, h, true);
        if (performance.now() - turn > PREPARE_TURN_MS) { await new Promise<void>(resolve => setTimeout(resolve, 0)); turn = performance.now(); }
      }
      if (spent >= budget) return;
    }
  }

  /**
   * The bars of several instruments added together (the aggregated footprint), on one grid: rows of `rowStep` rounded to a multiple of the
   * coarsest of their recorded steps (`fine`), each instrument's rows put in the row of their low price. A bar's `minutes` are the minutes
   * any of them recorded; its `stats` and `over` are given only when every instrument-minute in it had them (as `sizesOf` counts).
   */
  queryMany(ids: readonly string[], from: number, to: number, tfMs: number, rowStep: number, cuts: readonly number[] = [], budget = Infinity, byVenue = false): { step: number; fine: number; bars: FootprintBar[]; from: number; venues?: string[] } {
    // A market named twice counts once.
    const known = [...new Set(ids)].filter(id => this.#steps.has(id));
    const fine = known.reduce((most, id) => Math.max(most, this.#steps.get(id)!), 0);
    if (!fine) return { step: 0, fine: 0, bars: [], from };
    from = this.#reach(known, from, to, tfMs, budget);
    const step = fine * Math.max(1, Math.round(rowStep / fine));
    // With `byVenue` (several markets), each row also keeps every market's part: [buy, sell] per market of `known`, in one array.
    const split = byVenue && known.length > 1, width = 2 * known.length;
    const bars = new Map<number, Map<number, [number, number, Float64Array | null]>>();
    const barStats = new Map<number, { stats: TradeStats; withStats: number; counted: number; minutes: Set<number>; over: number[]; known: boolean }>();
    for (const [k, id] of known.entries()) {
      const own = this.#steps.get(id)!, stats = this.#stats.get(id);
      // A row's key on the common grid: whole when the instrument's step divides it (the usual case, one recorded step per coin).
      const factor = step / own, whole = Math.abs(factor - Math.round(factor)) < 1e-9;
      // A recorded minute counts in its bar (its statistics and size-line sums from memory, held for the whole retention); its rows are added
      // to the bar's on the common grid.
      const take = (t: number): Map<number, [number, number, Float64Array | null]> => {
        const key = Math.floor(t / tfMs) * tfMs;
        let rows = bars.get(key); if (!rows) { rows = new Map(); bars.set(key, rows); }
        let acc = barStats.get(key); if (!acc) { acc = { stats: emptyStats(), withStats: 0, counted: 0, minutes: new Set(), over: new Array<number>(2 * cuts.length).fill(0), known: true }; barStats.set(key, acc); }
        acc.counted++; acc.minutes.add(t);
        const minuteStats = stats?.get(t);
        if (minuteStats) {
          acc.withStats++; acc.stats.buyN += minuteStats.buyN; acc.stats.sellN += minuteStats.sellN;
          for (let i = 0; i < SIZE_EDGES.length; i++) { acc.stats.buy[i]! += minuteStats.buy[i]!; acc.stats.sell[i]! += minuteStats.sell[i]!; }
          if (cuts.length) { if (minuteStats.big) addOver(acc.over, minuteStats.big, cuts); else acc.known = false; }
        }
        return rows;
      };
      const add = (rows: Map<number, [number, number, Float64Array | null]>, bin: number, buy: number, sell: number): void => {
        const row = whole ? Math.floor(bin / Math.round(factor)) : Math.floor(bin * own / step * (1 + 1e-12));
        let cell = rows.get(row); if (!cell) { cell = [0, 0, split ? new Float64Array(width) : null]; rows.set(row, cell); }
        cell[0] += buy; cell[1] += sell;
        if (cell[2]) { cell[2][2 * k] += buy; cell[2][2 * k + 1] += sell; }
      };
      // Bars of whole hours read each ended hour inside the window added together (`#hourRows`), and the minutes of the rest.
      const rest: [number, number][] = [];
      if (tfMs % HOUR === 0) {
        // Only the hours the retention can hold are walked: a window reaching years back or ahead (a question may) is read as minutes there,
        // of which none are held, rather than visited an hour at a time on the request path.
        const sums = this.#sums.get(id), lo = Math.max(from, Math.floor((this.now() - this.#retentionMs) / HOUR) * HOUR), hi = Math.min(to, Math.ceil(this.now() / HOUR) * HOUR + HOUR);
        if (lo > from) rest.push([from, Math.min(lo, to)]);
        for (let h = Math.floor(lo / HOUR) * HOUR; h < hi; h += HOUR) {
          const held = h >= from && h + HOUR <= to ? this.#hourRows(id, h, true) : null;
          if (!held) { const a = Math.max(h, from), b = Math.min(h + HOUR, to), last = rest[rest.length - 1]; if (last && last[1] === a) last[1] = b; else rest.push([a, b]); continue; }
          let rows: Map<number, [number, number, Float64Array | null]> | null = null;
          if (sums) for (let t = h; t < h + HOUR; t += MINUTE) if (sums.has(t)) rows = take(t);
          if (rows) for (let i = 0; i < held.cells.length; i += HOUR_CELL) add(rows, held.cells[i]!, held.cells[i + 1]!, held.cells[i + 2]!);
        }
        if (hi < to) { const a = Math.max(hi, from), last = rest[rest.length - 1]; if (last && last[1] === a) last[1] = to; else rest.push([a, to]); }
      } else rest.push([from, to]);
      for (const [a, b] of rest) for (const [t, bins] of this.#rowsIn(id, a, b)) { const rows = take(t); for (const [bin, [buy, sell]] of bins) add(rows, bin, buy, sell); }
    }
    // The markets in the answer's order: the most volume in it first (`venueRows` name them by their place in it).
    let order: number[] = [], place: number[] = [];
    if (split) {
      const totals = new Float64Array(known.length);
      for (const rows of bars.values()) for (const cell of rows.values()) for (let k = 0; k < known.length; k++) totals[k]! += cell[2]![2 * k]! + cell[2]![2 * k + 1]!;
      order = known.map((_, k) => k).filter(k => totals[k]! > 0).sort((a, b) => totals[b]! - totals[a]! || a - b);
      place = new Array<number>(known.length).fill(-1); order.forEach((k, i) => { place[k] = i; });
    }
    return { step, fine, from, ...(split ? { venues: order.map(k => known[k]!) } : {}), bars: [...bars].sort((a, b) => a[0] - b[0]).map(([t, rows]) => {
      const sorted = [...rows].sort((a, b) => a[0] - b[0]);
      const list = sorted.map(([row, [buy, sell]]): FootprintRow => [row * step, buy, sell]);
      const acc = barStats.get(t), complete = acc !== undefined && acc.withStats === acc.counted;
      // Each row's markets with volume there: [place, buy, sell, place, buy, sell, ...], in the answer's order.
      const venueRows = split ? sorted.map(([, [, , parts]]) => { const flat: number[] = []; for (const k of order) { const b = parts![2 * k]!, s = parts![2 * k + 1]!; if (b > 0 || s > 0) flat.push(place[k]!, b, s); } return flat; }) : null;
      return { t, rows: list, buyUsd: list.reduce((s, r) => s + r[1], 0), sellUsd: list.reduce((s, r) => s + r[2], 0), minutes: acc?.minutes.size ?? 0, ...(acc && complete ? { stats: acc.stats } : {}), ...(acc && complete && cuts.length && acc.known ? { over: acc.over } : {}), ...(venueRows ? { venueRows } : {}) };
    }) };
  }
}

/**
 * An ended hour of one instrument's rows added together: [bin, buy, sell, buy orders, sell orders] in a row (`HOUR_CELL` numbers), on the
 * step it was recorded at; the orders are those of its minutes that count them by price (zero in the others, as in a minute's own rows).
 */
interface HourRows { step: number; cells: Float64Array }
const HOUR_CELL = 5;
/** What a whole hour held added together costs a question's budget (in instrument-minutes): about what two minutes in memory do. */
const HELD_HOUR_COST = 2;
/** A preparation lets go of the event loop after this long (ms). */
const PREPARE_TURN_MS = 8;
/** The stretch of a market's minutes the profile and value-area questions read between two pauses (whole hours, so a stored hour is read once). */
const READ_SLICE_MS = 6 * HOUR;

/** Run a generator written to be paused (it yields where it may be) to its end without pausing. */
function drain<T>(run: Generator<void, T>): T {
  for (;;) { const step = run.next(); if (step.done) return step.value; }
}

/** Run such a generator to its end, letting the event loop go whenever a turn has lasted PREPARE_TURN_MS, so other work runs between the slices. */
async function spread<T>(run: Generator<void, T>): Promise<T> {
  let turn = performance.now();
  for (;;) {
    const step = run.next();
    if (step.done) return step.value;
    if (performance.now() - turn > PREPARE_TURN_MS) { await new Promise<void>(resolve => setTimeout(resolve, 0)); turn = performance.now(); }
  }
}

/**
 * The recorder's answer to a sizes question (see `SizesAnswer`): each window is the last N whole minutes up to and including the open one,
 * by this recorder's own clock, for all the instruments added together. The windows all end at the same minute, so one pass back over the
 * longest serves every one of them, and each minute is looked up by its key rather than found among a week of them.
 */
export function sizesOf(recorder: { minutes(id: string): ReadonlyMap<number, unknown> | undefined; stats(id: string): ReadonlyMap<number, TradeStats> | undefined }, ids: readonly string[], windows: readonly number[], now: number, cuts: readonly number[] = []): SizesAnswer {
  const open = Math.floor(now / MINUTE) * MINUTE, longest = windows.reduce((a, b) => Math.max(a, b), 0);
  const out = windows.map(minutes => ({ minutes, seen: 0, stats: 0, buyN: 0, sellN: 0, buy: new Array<number>(SIZE_EDGES.length).fill(0), sell: new Array<number>(SIZE_EDGES.length).fill(0), over: new Array<number>(2 * cuts.length).fill(0), known: true }));
  const books = ids.map(id => [recorder.minutes(id), recorder.stats(id)] as const);
  const minute = emptyStats(), over = new Array<number>(2 * cuts.length).fill(0);
  for (let back = 0; back < longest; back++) {
    const t = open - back * MINUTE;
    let seen = false, withStats = false, known = true;
    minute.buyN = 0; minute.sellN = 0; minute.buy.fill(0); minute.sell.fill(0); over.fill(0);
    for (const [rows, stats] of books) {
      if (rows?.has(t)) seen = true;
      const s = stats?.get(t);
      if (!s) continue;
      withStats = true; minute.buyN += s.buyN; minute.sellN += s.sellN;
      for (let i = 0; i < SIZE_EDGES.length; i++) { minute.buy[i]! += s.buy[i]!; minute.sell[i]! += s.sell[i]!; }
      // Every instrument-minute counted must have its list, or the window's lines would leave its orders out.
      if (cuts.length) { if (s.big) addOver(over, s.big, cuts); else known = false; }
    }
    if (!seen && !withStats) continue;
    for (const w of out) {
      if (back >= w.minutes) continue;
      if (seen) w.seen++;
      if (!withStats) continue;
      w.stats++; w.buyN += minute.buyN; w.sellN += minute.sellN;
      for (let i = 0; i < SIZE_EDGES.length; i++) { w.buy[i]! += minute.buy[i]!; w.sell[i]! += minute.sell[i]!; }
      for (let i = 0; i < over.length; i++) w.over[i]! += over[i]!;
      if (!known) w.known = false;
    }
  }
  return { windows: out.map(({ over: lines, known, ...w }): SizesWindow => cuts.length && known ? { ...w, over: lines } : w) };
}

/** Stats as stored (`[buyN, sellN, buy, sell, version]` as JSON text) in the current version: the object when every field is valid, else null. */
export function parseStats(text: string | null): TradeStats | null {
  if (!text) return null;
  try {
    const [buyN, sellN, buy, sell, version, big] = JSON.parse(text) as [number, number, number[], number[], number?, unknown?];
    const count = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v >= 0;
    const bucket = (v: unknown): v is number[] => Array.isArray(v) && v.length === SIZE_EDGES.length && v.every(x => typeof x === 'number' && Number.isFinite(x) && x >= 0);
    // Four fields are statistics from before orders were rebuilt (every fill a trade): not the same quantity, so they are not read. A sixth is
    // the list of large orders (older code reads the first five and passes it over); one that is not a list leaves the minute's list unknown.
    if (version !== STATS_VERSION || !count(buyN) || !count(sellN) || !bucket(buy) || !bucket(sell)) return null;
    return current({ buyN, sellN, buy, sell, v: STATS_VERSION, ...(big !== undefined ? { big: big as number[] } : {}) });
  } catch { return null; }
}

/** Stats as the database stores them (see `parseStats`): the list of large orders, when known, as a sixth element. */
export const statsText = (stats: TradeStats): string => JSON.stringify(stats.big ? [stats.buyN, stats.sellN, stats.buy, stats.sell, STATS_VERSION, stats.big] : [stats.buyN, stats.sellN, stats.buy, stats.sell, STATS_VERSION]);
