import type { Fetcher } from './history.ts';

/**
 * Long/short ratios as the exchanges publish them: the share of a population that is net long, per period. They count accounts (or, for
 * Binance's top traders, their positions) as each exchange classifies them, never coins: every contract has a long and a short holder, so in
 * coins the two sides are always equal. Nothing here is derived from trades or open interest, and a missing reading is never filled in with
 * 50 %. Hyperliquid publishes none.
 *
 * Measured 2026-10-13 (BTC):
 * - Binance `futures/data/{globalLongShortAccountRatio | topLongShortAccountRatio | topLongShortPositionRatio}`: `longAccount`,
 *   `shortAccount`, `longShortRatio`; 500 a page back from `endTime`, the last 30 days only (an older `endTime` is an error); CORS.
 *   Before that, its daily data archive (2026-11-06): `data.binance.vision/data/futures/um/daily/metrics/<SYMBOL>/<SYMBOL>-metrics-<date>.zip`,
 *   one zip a UTC day (~11 KB; from 2020-09-01 for BTCUSDT; out the next morning, ~06:40 UTC), its 288 five-minute rows in no order;
 *   `count_long_short_ratio` is every account's ratio, `count_toptrader_long_short_ratio` the top traders' by accounts and
 *   `sum_toptrader_long_short_ratio` by positions. A row stamped `create_time` T is the API's reading at T + 5 minutes (4,880 of 4,880 the
 *   same for each series, to the API's four decimals), so a day's midnight reading is the day before's last row. CORS for a plain GET.
 *   COIN-M's files are per contract and do not match its API's per-pair readings: only USD-M is read from the archive.
 * - Bybit `v5/market/account-ratio`: `buyRatio`, `sellRatio`, newest first, 500 a page back from `endTime`, years of it; CORS.
 * - OKX `rubik/stat/contracts/long-short-account-ratio-contract`: `[ts, ratio]` newest first, 100 a page back from `end` (five-minute
 *   periods for about a day, hourly for weeks); no CORS header, so a page cannot read it. Its top traders (2026-10-21):
 *   `long-short-account-ratio-contract-top-trader` (by accounts) and `long-short-position-ratio-contract-top-trader` (by positions), the
 *   same shape and paging, hourly for about 30 days.
 * - Gate `futures/usdt/contract_stats` (2026-10-21): every series in one answer, oldest first, 500 a page forward from `from` (seconds),
 *   90 days and more; CORS. Users holding long and short positions (`long_users`, `short_users`, `lsr_account`) and its top traders, "large
 *   holders" in Gate's words, by accounts (`top_long_account`, `top_short_account`, `top_lsr_account`) and by position size (`top_long_size`,
 *   `top_short_size`, `top_lsr_size`); a coin it does not list answers `CONTRACT_NOT_FOUND`.
 * - Bitget (2026-10-21) `v2/mix/market/long-short` (all users: `longRatio`, `shortRatio`, `longShortRatio`), `account-long-short` (its big
 *   traders by accounts: `longAccountRatio`, `shortAccountRatio`, `longShortAccountRatio`) and `position-long-short` (by position:
 *   `longPositionRatio`, `shortPositionRatio`, `longShortPositionRatio`); the English documentation calls the last two "active", the Chinese
 *   大户 (big traders). The newest 30 periods only (24 for `12h`), no paging (`startTime` and `endTime` are ignored); a day is `1Dutc` (`1d` is
 *   refused); CORS; one request a second (`VENUE_GAP_MS`).
 */

/** Which population a series counts: every account, top traders' accounts or their positions; `activeAccounts` only from a server built before Bitget published all three (2026-10-21). */
export type LsPopulation = 'accounts' | 'topAccounts' | 'topPositions' | 'activeAccounts';
/** The series a person can choose: Binance, OKX, Bitget and Gate publish each of them; Bybit one. */
export type LsMetric = 'accounts' | 'topAccounts' | 'topPositions';
export const LS_METRICS: readonly LsMetric[] = ['accounts', 'topAccounts', 'topPositions'];
/** One reading: the period's start (ms) and the share net long (0..1). */
export interface LsPoint { t: number; long: number }
/**
 * `ok` with points; `empty` the venue answered with none for the window; `unsupported` the venue publishes no such series (or none for this
 * market); `serverOnly` a page cannot read it (no CORS header) but a server can; `failed` the request or its answer was not good; `stale`
 * the points held from before, the last request for more having failed.
 */
export type LsStatus = 'ok' | 'empty' | 'unsupported' | 'serverOnly' | 'failed' | 'stale';
/**
 * `pending`: a read of the venue for this window was under way when the answer was given (a question with a wait budget, `LongShortCache.series`):
 * the points are what was held then, and asking again shortly gets what it read. It never changes what the status says.
 */
export interface LsSeries { id: string; population: LsPopulation | null; periodMs: number; points: LsPoint[]; status: LsStatus; pending?: boolean }

export const LS_VENUES: readonly string[] = ['binance', 'bybit', 'okx', 'bitget', 'gateio'];
/** The venues whose series follows the one chosen (the others publish one each). */
export const LS_CHOSEN_VENUES: readonly string[] = ['binance', 'okx', 'bitget', 'gateio'];
/** A venue that does not list the market (Gate's `CONTRACT_NOT_FOUND`): it publishes no series for it, which is not a failure to read one. */
export class LsNoMarket extends Error {}
const MINUTE = 60_000, HOUR = 3_600_000, DAY = 86_400_000;
/** Each venue's periods (ms) to its name for them. */
const PERIODS: Readonly<Record<string, Readonly<Record<number, string>>>> = {
  binance: { [5 * MINUTE]: '5m', [15 * MINUTE]: '15m', [30 * MINUTE]: '30m', [HOUR]: '1h', [2 * HOUR]: '2h', [4 * HOUR]: '4h', [6 * HOUR]: '6h', [12 * HOUR]: '12h', [DAY]: '1d' },
  bybit: { [5 * MINUTE]: '5min', [15 * MINUTE]: '15min', [30 * MINUTE]: '30min', [HOUR]: '1h', [4 * HOUR]: '4h', [DAY]: '1d' },
  okx: { [5 * MINUTE]: '5m', [HOUR]: '1H', [DAY]: '1D' },
  bitget: { [5 * MINUTE]: '5m', [15 * MINUTE]: '15m', [30 * MINUTE]: '30m', [HOUR]: '1h', [2 * HOUR]: '2h', [4 * HOUR]: '4h', [6 * HOUR]: '6h', [12 * HOUR]: '12h', [DAY]: '1Dutc' },
  gateio: { [5 * MINUTE]: '5m', [15 * MINUTE]: '15m', [30 * MINUTE]: '30m', [HOUR]: '1h', [4 * HOUR]: '4h', [DAY]: '1d' },
};
const BINANCE_PATHS: Readonly<Record<LsMetric, string>> = { accounts: 'globalLongShortAccountRatio', topAccounts: 'topLongShortAccountRatio', topPositions: 'topLongShortPositionRatio' };
/** OKX's endpoint for each series (its top traders, ranked as OKX ranks them). */
const OKX_PATHS: Readonly<Record<LsMetric, string>> = { accounts: 'long-short-account-ratio-contract', topAccounts: 'long-short-account-ratio-contract-top-trader', topPositions: 'long-short-position-ratio-contract-top-trader' };
/** Gate's fields for each series: the long side, the short side and their ratio. */
const GATE_FIELDS: Readonly<Record<LsMetric, readonly [string, string, string]>> = { accounts: ['long_users', 'short_users', 'lsr_account'], topAccounts: ['top_long_account', 'top_short_account', 'top_lsr_account'], topPositions: ['top_long_size', 'top_short_size', 'top_lsr_size'] };
/** Bitget's endpoint for each series, and its fields: the long share, the short share and their ratio. */
const BITGET_SERIES: Readonly<Record<LsMetric, readonly [string, string, string, string]>> = {
  accounts: ['long-short', 'longRatio', 'shortRatio', 'longShortRatio'],
  topAccounts: ['account-long-short', 'longAccountRatio', 'shortAccountRatio', 'longShortAccountRatio'],
  topPositions: ['position-long-short', 'longPositionRatio', 'shortPositionRatio', 'longShortPositionRatio'],
};
/**
 * The least time between two requests to a venue, the cache's whole (ms): Bitget allows one a second, and a round reads the series shown and
 * then the other two at once (the pane's warming), which it once answered "Too Many Requests" (2026-10-21).
 */
export const VENUE_GAP_MS: Readonly<Record<string, number>> = { bitget: 1_100 };
/**
 * The most requests that wait for a paced venue's turn: one more fails at once (read again with the minute's retry), so no request goes out
 * long after the round that asked for it gave up, and a burst of questions for other windows cannot queue without end.
 */
export const VENUE_WAITING_MAX = 8;
/** Binance's API answers only for the last 30 days; its daily archive holds the days before. */
const BINANCE_SPAN_MS = 30 * DAY;
/** Each series' column in Binance's daily archive. */
const ARCHIVE_COLUMNS: Readonly<Record<LsMetric, string>> = { accounts: 'count_long_short_ratio', topAccounts: 'count_toptrader_long_short_ratio', topPositions: 'sum_toptrader_long_short_ratio' };
/** An archive row's time to the API's time for the same reading. */
const ARCHIVE_SHIFT_MS = 5 * MINUTE;
/** The most archive days one read takes, newest first: a longer window is read on by the cache's next read, its line growing as each lands. */
export const ARCHIVE_DAYS = 96;
/**
 * Archive days fetched at once. Every file is a CloudFront miss served from Tokyo, ~1 s each from Paraguay (2026-11-06), so they go in
 * parallel: over the page's one HTTP/2 connection 100 took 2.5 s. 48 at a time keeps even an HTTP/1.1 fallback's queue (6 connections)
 * inside each request's 15 s.
 */
const ARCHIVE_PARALLEL = 48;
const PAGES = 12;
/** Readings a page, per venue (Bitget has one page of 30). */
const PAGE_ROWS: Readonly<Record<string, number>> = { binance: 500, bybit: 500, okx: 100, bitget: 30, gateio: 500 };
/** The most readings one window takes from a venue: well inside what one question's pages reach, and far below what a series keeps. */
const windowReadings = (venue: string): number => Math.min(2_000, Math.floor(PAGES * (PAGE_ROWS[venue] ?? 30) * 0.8));
/**
 * The longest the cache waits for one page. `webGet` gives up at 15 s, but a request on the live server once never settled at all: the series'
 * one request never ended, and every later question for it (Bybit's and OKX's hourly BTC readings) waited for good (2026-10-15).
 */
export const LS_PAGE_DEADLINE_MS = 20_000;

/** Whether `promise` settles before the wall-clock time `until` (Infinity: it is waited for). A rejection counts as settled. */
async function settledBy(promise: Promise<unknown>, until: number): Promise<boolean> {
  if (until === Infinity) { await promise.catch(() => undefined); return true; }
  const left = until - Date.now();
  if (left <= 0) return false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([promise.then(() => true, () => true), new Promise<boolean>(resolve => { timer = setTimeout(() => resolve(false), left); })]); }
  finally { clearTimeout(timer); }
}

/** `promise`, or an error once `ms` have passed without it settling. */
function withDeadline<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`no answer in ${ms / 1000} s`)), ms); });
  return Promise.race([promise, late]).finally(() => clearTimeout(timer));
}

/** The venue's longest period no longer than the chart's candle (five minutes at the least): readings at least as fine as the candles where it can. */
export function lsPeriodOf(venue: string, tfMs: number): number | null {
  const periods = PERIODS[venue]; if (!periods) return null;
  const all = Object.keys(periods).map(Number).sort((a, b) => a - b), want = Math.max(tfMs, 5 * MINUTE);
  return all.filter(p => p <= want).pop() ?? all[0]!;
}

/** The venue's shortest period at least `ms` long (its longest where none is): a window's readings kept to a number. */
export function lsPeriodAtLeast(venue: string, ms: number): number | null {
  const periods = PERIODS[venue]; if (!periods) return null;
  const all = Object.keys(periods).map(Number).sort((a, b) => a - b);
  return all.find(p => p >= ms) ?? all[all.length - 1]!;
}

/**
 * The period a venue's readings of a window [from, to) are taken in: the chart's own where that fits the window, else the shortest that does
 * (a window keeps to `windowReadings`; from 30 days on, daily readings for month-scale context). 0 for a venue that publishes none. The pane
 * reads it to know which of the cache's series a window lands on.
 */
export function lsWindowPeriod(venue: string, tfMs: number, from: number, to: number): number {
  const span = to - from, need = Math.max(span / windowReadings(venue), span >= 30 * DAY ? DAY : 0), fine = LS_VENUES.includes(venue) ? lsPeriodOf(venue, tfMs) : null;
  return fine === null ? 0 : fine >= need ? fine : lsPeriodAtLeast(venue, need) ?? 0;
}

/** The population a venue's series counts, given the series chosen; null for a venue that publishes none. */
export function lsPopulationOf(venue: string, metric: LsMetric): LsPopulation | null {
  return LS_CHOSEN_VENUES.includes(venue) ? metric : venue === 'bybit' ? 'accounts' : null;
}

const num = (value: unknown): number => typeof value === 'string' || typeof value === 'number' ? Number(value) : NaN;
const at = (value: unknown, ...path: (string | number)[]): unknown => path.reduce<unknown>((v, key) => (v !== null && typeof v === 'object' ? (v as Record<string | number, unknown>)[key] : undefined), value);
/**
 * A venue's list of readings, checked for its shape: not a list, or rows none of which carries every field the venue sends and the reading is
 * checked with (`fields`: its time, its share and the short share or ratio it is checked against), fail the answer as a changed API: a
 * renamed cross-check field would otherwise leave every reading out and read as no readings. A reading that is there but does not add up is
 * left out later, one at a time.
 */
function rows(value: unknown, what: string, ...fields: (string | number)[]): unknown[] {
  if (!Array.isArray(value)) throw new Error(`${what}: not a list`);
  if (value.length && !value.some(r => fields.every(field => at(r, field) !== undefined))) throw new Error(`${what}: readings of an unknown shape`);
  return value;
}

/**
 * One reading from what a venue gave: the long share, checked against the short share (they add up to 1, within the rounding of four
 * decimals) and the ratio (long over short, within half a percent) where the venue gives them. A reading that fails is null, never guessed.
 */
export function lsReading(t: number, long: number, short?: number, ratio?: number): LsPoint | null {
  if (!Number.isFinite(t) || t <= 0 || !Number.isFinite(long) || long <= 0 || long >= 1) return null;
  if (short !== undefined && (!Number.isFinite(short) || Math.abs(long + short - 1) > 0.002)) return null;
  if (ratio !== undefined && (!Number.isFinite(ratio) || ratio <= 0 || Math.abs(ratio - long / (1 - long)) > 0.005 * ratio + 0.002)) return null;
  return { t, long };
}
/**
 * Where the next page back ends: before the oldest reading time of a full page, from its valid times only (a row with no time, or a time of
 * 0, once ended the paging there and the window read as held to its start). A full page with no valid time cannot be paged on: it fails.
 */
function nextEnd(what: string, oldest: number): number {
  if (!Number.isFinite(oldest)) throw new Error(`${what}: a full page with no reading time`);
  return oldest - 1;
}
/** The long share from a ratio of long to short accounts (OKX gives only that): 1.25 is 1.25 long accounts for each short one, 55.6 % long. */
export const shareOfRatio = (ratio: number): number => ratio / (1 + ratio);

/** The text of a zip's one file, stored or deflated, found through its central directory (where the sizes are always given). */
export async function zipText(bytes: Uint8Array): Promise<string> {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  // The end record: the last 22 bytes, or before a comment of at most 65535.
  let end = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 22 - 0xffff); i--) if (view.getUint32(i, true) === 0x06054b50) { end = i; break; }
  const dir = end < 0 ? -1 : view.getUint32(end + 16, true);
  if (dir < 0 || dir + 46 > bytes.length || view.getUint32(dir, true) !== 0x02014b50) throw new Error('not a zip');
  const method = view.getUint16(dir + 10, true), size = view.getUint32(dir + 20, true), local = view.getUint32(dir + 42, true);
  if (local + 30 > bytes.length || view.getUint32(local, true) !== 0x04034b50) throw new Error('not a zip');
  const start = local + 30 + view.getUint16(local + 26, true) + view.getUint16(local + 28, true);
  if (start + size > bytes.length) throw new Error('a zip cut short');
  const data = bytes.subarray(start, start + size);
  if (method === 0) return new TextDecoder().decode(data);
  if (method !== 8) throw new Error(`a zip compressed by method ${method}`);
  return new Response(new Response(data).body!.pipeThrough(new DecompressionStream('deflate-raw'))).text();
}

/** A day of Binance's archive: each series' readings, oldest first. */
export type ArchiveDay = Readonly<Record<LsMetric, LsPoint[]>>;

/**
 * One UTC day's readings of every series from Binance's daily archive, at the API's times (a reading that does not add up is left out); null
 * where Binance published no file for the day. Throws for a file not of its form: a changed archive reads as failed, not as empty.
 */
export async function binanceArchiveDay(symbol: string, day: number, get: Fetcher): Promise<ArchiveDay | null> {
  const date = new Date(day).toISOString().slice(0, 10);
  let bytes: unknown;
  try { bytes = await get(`https://data.binance.vision/data/futures/um/daily/metrics/${encodeURIComponent(symbol)}/${encodeURIComponent(symbol)}-metrics-${date}.zip`); }
  catch (error) { if (at(error, 'status') === 404) return null; throw error; }
  if (!(bytes instanceof Uint8Array)) throw new Error('binance archive: not a file');
  const lines = (await zipText(bytes)).split(/\r?\n/), head = lines[0]!.split(','), timeAt = head.indexOf('create_time'), columns = LS_METRICS.map(m => head.indexOf(ARCHIVE_COLUMNS[m]));
  if (timeAt < 0 || columns.some(c => c < 0)) throw new Error('binance archive: readings of an unknown shape');
  const out = LS_METRICS.map(() => new Map<number, LsPoint>());
  for (let i = 1; i < lines.length; i++) {
    const cells = lines[i]!.split(','), m = /^(\d{4})-(\d\d)-(\d\d) (\d\d):(\d\d):(\d\d)$/.exec(cells[timeAt] ?? '');
    if (!m) continue;
    const t = Date.UTC(+m[1]!, +m[2]! - 1, +m[3]!, +m[4]!, +m[5]!, +m[6]!) + ARCHIVE_SHIFT_MS;
    columns.forEach((c, k) => { const ratio = num(cells[c]), p = ratio > 0 ? lsReading(t, shareOfRatio(ratio)) : null; if (p) out[k]!.set(t, p); });
  }
  const sorted = (k: number): LsPoint[] => [...out[k]!.values()].sort((a, b) => a.t - b.t);
  return { accounts: sorted(0), topAccounts: sorted(1), topPositions: sorted(2) };
}

/** The most readings an `ArchiveMemo` keeps: a few hundred kilobytes to a few megabytes. */
const ARCHIVE_MEMO_POINTS = 60_000;
/**
 * Archive days read lately, on the grid of the period they were read in, every series of each (one file holds all three, and the pane reads
 * the other two after the one shown, to switch at once): a read of another series finds its days here rather than fetching each file again.
 * At most `ARCHIVE_MEMO_POINTS` readings, the least recently asked day going first; a failed read is not kept. It also knows, per market,
 * when the archive was last seen to hold it and when its archive last failed.
 */
export class ArchiveMemo {
  #days = new Map<string, { day: Promise<ArchiveDay | null>; size: number }>();
  #size = 0;
  #failed = new Map<string, number>();
  /** When the archive was last seen to hold each market (`binanceArchiveHolds`, the cache's clock). */
  readonly holds = new Map<string, number>();
  constructor(private maxPoints = ARCHIVE_MEMO_POINTS) {}
  /** The day kept under `key`, or `read` it and keep it, counted as `size` readings. */
  day(key: string, size: number, read: () => Promise<ArchiveDay | null>): Promise<ArchiveDay | null> {
    const held = this.#days.get(key);
    if (held) { this.#days.delete(key); this.#days.set(key, held); return held.day; }
    const entry = { day: read(), size };
    this.#days.set(key, entry); this.#size += size;
    entry.day.catch(() => { if (this.#days.get(key) === entry) { this.#days.delete(key); this.#size -= size; } });
    for (const [old, e] of this.#days) { if (this.#size <= this.maxPoints || old === key) break; this.#days.delete(old); this.#size -= e.size; }
    return entry.day;
  }
  /** Let go of the days kept under `keys` (days that had no file, asked again next time). */
  forget(keys: readonly string[]): void { for (const key of keys) { const e = this.#days.get(key); if (e) { this.#days.delete(key); this.#size -= e.size; } } }
  /** The market's archive failed at `now` (the cache's clock): it is left alone for a minute, while the API's readings go on. */
  fail(symbol: string, now: number): void { this.#failed.set(symbol, now); }
  cooling(symbol: string, now: number): boolean { return now - (this.#failed.get(symbol) ?? -Infinity) < MINUTE; }
}

/**
 * Whether the archive holds `symbol` now: the file of three days ago is there (out by then; a market listed since has none), looked at no more
 * than once a minute (`memo`). A file read for the market earlier is no evidence: the archive may have gone since. Throws when the file
 * cannot be read.
 */
async function binanceArchiveHolds(symbol: string, now: number, get: Fetcher, memo?: ArchiveMemo): Promise<boolean> {
  if (now - (memo?.holds.get(symbol) ?? -Infinity) < MINUTE) return true;
  const holds = await binanceArchiveDay(symbol, Math.floor(now / DAY) * DAY - 3 * DAY, get) !== null;
  if (holds) memo?.holds.set(symbol, now);
  return holds;
}

/**
 * Binance's readings older than its API's 30 days, from its daily archive: those of [lo, hi) on the period's grid, the newest `ARCHIVE_DAYS`
 * days of files at most, `ARCHIVE_PARALLEL` at a time (through `memo`, where the cache keeps one). `from` is where they reach back to: `lo`,
 * or the start of the oldest day read when there were more. A day with no file is skipped (nothing filled in); a read that found no file at all
 * (`none`) may be before the archive begins (`fetchLongShort` decides), and says the memo `keys` of its days and its `newest` day.
 */
async function binanceArchive(symbol: string, metric: LsMetric, periodMs: number, lo: number, hi: number, get: Fetcher, memo?: ArchiveMemo): Promise<{ points: LsPoint[]; from: number; none: boolean; newest: number; keys: string[] }> {
  // A day's file holds the readings after its midnight up to and with the next one (each row is the API's reading five minutes on).
  const dayOf = (t: number): number => Math.floor((t - ARCHIVE_SHIFT_MS) / DAY) * DAY, first = dayOf(lo), days: number[] = [];
  for (let day = dayOf(hi - 1); day >= first && days.length < ARCHIVE_DAYS; day -= DAY) days.push(day);
  const onGrid = async (day: number): Promise<ArchiveDay | null> => {
    const all = await binanceArchiveDay(symbol, day, get), grid = (points: LsPoint[]): LsPoint[] => points.filter(p => p.t % periodMs === 0);
    return all && { accounts: grid(all.accounts), topAccounts: grid(all.topAccounts), topPositions: grid(all.topPositions) };
  };
  const keys = days.map(day => `${symbol}|${periodMs}|${day}`);
  const read = (i: number): Promise<ArchiveDay | null> => memo ? memo.day(keys[i]!, 3 * Math.ceil(DAY / periodMs), () => onGrid(days[i]!)) : onGrid(days[i]!);
  const got: (ArchiveDay | null)[] = new Array(days.length);
  let next = 0, failed = false;
  await Promise.all(Array.from({ length: Math.min(ARCHIVE_PARALLEL, days.length) }, async () => {
    try { while (!failed && next < days.length) { const i = next++; got[i] = await read(i); } }
    catch (error) { failed = true; throw error; }
  }));
  const points = got.flatMap(day => day?.[metric] ?? []).filter(p => p.t >= lo && p.t < hi).sort((a, b) => a.t - b.t);
  const oldest = days[days.length - 1], none = got.every(day => day === null);
  return { points, from: oldest === undefined || oldest <= first || none ? lo : oldest + ARCHIVE_SHIFT_MS, none, newest: days[0] ?? -Infinity, keys };
}

/**
 * A venue's readings of `metric` for the market `symbol` over [from, to), oldest first, and how far back the answer reaches: `from`, or where
 * its pages ran out (at most `PAGES` a question, or `ARCHIVE_DAYS` of Binance's archive) when the venue had more. Throws when an answer is not
 * what the venue sends (a changed API reads as failed, not as empty); a reading that does not add up is left out. `memo` keeps the archive
 * days read for the other series of the market.
 */
export async function fetchLongShort(venue: string, symbol: string, metric: LsMetric, periodMs: number, from: number, to: number, get: Fetcher, now = Date.now(), memo?: ArchiveMemo): Promise<{ points: LsPoint[]; from: number }> {
  const name = PERIODS[venue]?.[periodMs];
  if (!name || lsPopulationOf(venue, metric) === null || (!LS_CHOSEN_VENUES.includes(venue) && metric !== 'accounts')) throw new Error(`${venue} publishes no such series`);
  const out = new Map<number, LsPoint>(), take = (p: LsPoint | null): void => { if (p && p.t >= from - periodMs && p.t < to) out.set(p.t, p); };
  const s = encodeURIComponent(symbol);
  let end = to, page = 0;
  // Include the reading just before the window, without fetching a full page for a tiny refresh.
  const limitFor = (floor: number): number => Math.max(2, Math.min(PAGE_ROWS[venue] ?? 30, Math.ceil((end - floor) / periodMs) + 2));
  if (venue === 'binance') {
    const floor = Math.max(from, now - BINANCE_SPAN_MS + periodMs);
    // A COIN-M perpetual (BTCUSD_PERP) is read from the COIN-M statistics, by its pair.
    const coinM = /^([A-Z0-9]+)_PERP$/.exec(symbol), market = coinM ? `https://dapi.binance.com/futures/data/${BINANCE_PATHS[metric]}?pair=${encodeURIComponent(coinM[1]!)}` : `https://fapi.binance.com/futures/data/${BINANCE_PATHS[metric]}?symbol=${s}`;
    // What is older than the API's 30 days comes from the daily archive (USD-M only), read alongside the API's pages. It reaches a day into the
    // API's days, so a clock a little off leaves no hole between them. Its failure never fails the API's readings: they are answered, the
    // archive's days are not claimed, and the market's archive is left alone for a minute (`ArchiveMemo.fail`).
    const lo = from - periodMs, hi = Math.min(to, now - BINANCE_SPAN_MS + Math.max(periodMs, DAY));
    const wanted = !coinM && lo < hi, cooling = wanted && memo?.cooling(symbol, now) === true;
    const archive = wanted && !cooling ? binanceArchive(symbol, metric, periodMs, lo, hi, get, memo).catch((error: unknown) => (error instanceof Error ? error : new Error(String(error)))) : null;
    const api = (async () => {
      for (end = Math.min(to, now); page < PAGES && end > floor; page++) {
        // COIN-M names its top traders' position shares longPosition and shortPosition (USD-M calls them longAccount and shortAccount).
        const [longKey, shortKey] = coinM && metric === 'topPositions' ? ['longPosition', 'shortPosition'] : ['longAccount', 'shortAccount'];
        const limit = limitFor(floor);
        const got = rows(await get(`${market}&period=${name}&limit=${limit}&endTime=${Math.floor(end)}`), 'binance', 'timestamp', longKey, shortKey, 'longShortRatio');
        let oldest = Infinity;
        for (const r of got) { const t = num(at(r, 'timestamp')); take(lsReading(t, num(at(r, longKey)), num(at(r, shortKey)), num(at(r, 'longShortRatio')))); if (t > 0 && t < oldest) oldest = t; }
        if (got.length < limit) break;
        end = nextEnd('binance', oldest);
      }
    })();
    const [old] = await Promise.all([archive, api]);
    // Not one file in the read: before the archive begins only on evidence, the archive holding this market now (its file of three days ago)
    // or the API showing it began trading after those days. Without it the archive is gone or moved: the days are not claimed, and asked
    // again after the minute (they are let go of in the memo, so a returning archive is read).
    const read = old instanceof Error ? null : old;
    let failed = old instanceof Error;
    if (read?.none) {
      const began = out.size > 0 && Math.min(...out.keys()) > read.newest + DAY;
      failed = !began && !(await binanceArchiveHolds(symbol, now, get, memo).catch(() => false));
      if (failed) memo?.forget(read.keys);
    }
    if (failed) memo?.fail(symbol, now);
    const unread = cooling || failed;
    // The API's own reading where both have one (the same, to its four decimals).
    if (!unread && read) for (const p of read.points) if (!out.has(p.t)) take(p);
    const points = [...out.values()].sort((a, b) => a.t - b.t);
    // Unread, the answer reaches back to where the API's days begin, or to the window's end for a window older than them (claiming nothing of
    // it: read again, it is read alone, not every day from it to the API's).
    return { points, from: page >= PAGES && end > from ? end : unread ? Math.min(floor, to) : read && read.from > lo ? read.from : from };
  } else if (venue === 'bybit') {
    for (; page < PAGES && end >= from; page++) {
      const limit = limitFor(from);
      // A coin-margined perpetual (BTCUSD) is in Bybit's inverse category.
      const answer = await get(`https://api.bybit.com/v5/market/account-ratio?category=${/^[A-Z0-9]+USD$/.test(symbol) ? 'inverse' : 'linear'}&symbol=${s}&period=${name}&limit=${limit}&endTime=${Math.floor(end)}`);
      if (num(at(answer, 'retCode')) !== 0) throw new Error(`bybit: ${String(at(answer, 'retMsg'))}`);
      const got = rows(at(answer, 'result', 'list'), 'bybit', 'timestamp', 'buyRatio', 'sellRatio');
      let oldest = Infinity;
      for (const r of got) { const t = num(at(r, 'timestamp')); take(lsReading(t, num(at(r, 'buyRatio')), num(at(r, 'sellRatio')))); if (t > 0 && t < oldest) oldest = t; }
      if (got.length < limit) break;
      end = nextEnd('bybit', oldest);
    }
  } else if (venue === 'okx') {
    for (; page < PAGES && end >= from; page++) {
      const limit = limitFor(from);
      const answer = await get(`https://www.okx.com/api/v5/rubik/stat/contracts/${OKX_PATHS[metric]}?instId=${s}&period=${name}&limit=${limit}&end=${Math.floor(end)}`);
      if (String(at(answer, 'code')) !== '0') throw new Error(`okx: ${String(at(answer, 'msg'))}`);
      const got = rows(at(answer, 'data'), 'okx', 0, 1);
      let oldest = Infinity;
      for (const r of got) { const t = num(at(r, 0)), ratio = num(at(r, 1)); take(Number.isFinite(ratio) && ratio > 0 ? lsReading(t, shareOfRatio(ratio)) : null); if (t > 0 && t < oldest) oldest = t; }
      if (got.length < limit) break;
      end = nextEnd('okx', oldest);
    }
  } else if (venue === 'gateio') {
    // USDT-settled perpetuals only (BTC_USDT); read forward from where the window starts, or from where `PAGES` pages back from its end reach.
    const settle = /_USDT$/.test(symbol) ? 'usdt' : null; if (!settle) throw new LsNoMarket(`gateio: ${symbol}`);
    const [longKey, shortKey, ratioKey] = GATE_FIELDS[metric], rowsMax = PAGE_ROWS.gateio!;
    let start = Math.max(from - periodMs, to - PAGES * rowsMax * periodMs);
    const reached = start > from - periodMs ? start : from;
    const unlisted = (answer: unknown): boolean => at(answer, 'label') === 'CONTRACT_NOT_FOUND' || String(at(answer, 'body') ?? '').includes('CONTRACT_NOT_FOUND');
    for (; page < PAGES && start < to; page++) {
      // Gate says so with a 400 (`webGet` keeps its body on the error); a fetcher that hands the body back gives it as the answer.
      const answer = await get(`https://api.gateio.ws/api/v4/futures/${settle}/contract_stats?contract=${s}&interval=${name}&from=${Math.floor(start / 1000)}&limit=${rowsMax}`)
        .catch((error: unknown) => { throw unlisted(error) ? new LsNoMarket(`gateio: ${symbol}`) : error; });
      if (!Array.isArray(answer) && unlisted(answer)) throw new LsNoMarket(`gateio: ${symbol}`);
      const got = rows(answer, 'gateio', 'time', longKey, shortKey, ratioKey);
      let newest = -Infinity;
      for (const r of got) {
        const t = num(at(r, 'time')) * 1000, long = num(at(r, longKey)), short = num(at(r, shortKey));
        // Counts (or sizes) of each side, checked against Gate's own ratio.
        take(long > 0 && short > 0 ? lsReading(t, long / (long + short), short / (long + short), num(at(r, ratioKey))) : null);
        // The cursor moves on from valid times only: an overflowing time ("1e400" is Infinity) or one past the live edge would end the paging
        // with the rest of the window unread.
        if (Number.isFinite(t) && t <= Math.max(to, now) + periodMs && t > newest) newest = t;
      }
      if (got.length < rowsMax) break;
      // A full page must move on: one that repeats (or has no valid time) would spend every page and leave the window's end unread, held as
      // read all the same (the cache holds a window up to its end).
      if (!Number.isFinite(newest) || newest < start) throw new Error('gateio: a full page that does not move on');
      start = newest + periodMs;
    }
    if (start < to && page >= PAGES) throw new Error('gateio: the pages ran out before the window\'s end');
    return { points: [...out.values()].sort((a, b) => a.t - b.t), from: reached };
  } else if (venue === 'bitget') {
    const [path, longKey, shortKey, ratioKey] = BITGET_SERIES[metric];
    const answer = await get(`https://api.bitget.com/api/v2/mix/market/${path}?symbol=${s}&period=${name}`);
    if (String(at(answer, 'code')) !== '00000') throw new Error(`bitget: ${String(at(answer, 'msg'))}`);
    for (const r of rows(at(answer, 'data'), 'bitget', 'ts', longKey, shortKey, ratioKey)) take(lsReading(num(at(r, 'ts')), num(at(r, longKey)), num(at(r, shortKey)), num(at(r, ratioKey))));
  }
  // Every page full: the venue may hold more before where the last one ended.
  return { points: [...out.values()].sort((a, b) => a.t - b.t), from: page >= PAGES && end > from ? end : from };
}

/**
 * A series the cache holds: its readings, the stretch [from, to) they cover, when its newest stretch was read and last failed, its read under
 * way and how many questions wait for that read.
 */
interface HeldSeries { points: Map<number, LsPoint>; from: number; to: number; checked: number; failed: number; busy: Promise<void> | null; noMarket?: boolean; restoring: Promise<void> | null; waiting: number }
/** What a backing keeps of a series: its readings (oldest first), the stretch [from, to) they cover and when its newest stretch was read. */
export interface LsHeldRecord { points: LsPoint[]; from: number; to: number; checked: number }
/**
 * What one read changed: `cleared`, the series is only what this read gave (the old readings go); `added`, the readings it gave (new or the same
 * again); `keep`, the readings outside [first, last] went (the series was over its bound); and the stretch and read time after it.
 */
export interface LsChange { cleared: boolean; added: readonly LsPoint[]; keep: { first: number; last: number } | null; from: number; to: number; checked: number }
/**
 * Where a cache keeps its series across restarts. `load` is asked once per series (null: none kept); `save` after every read, never waited for
 * (`full` gives the whole record, for a backing that writes it whole). Either may throw: the cache goes on as if it had none.
 */
export interface LsBacking {
  load(key: string): Promise<LsHeldRecord | null>;
  save(key: string, change: LsChange, full: () => LsHeldRecord): void;
}
/**
 * The format of what a backing keeps: a backing stores it and treats a record of another as none. Raise it whenever a change to the venues'
 * parsing or to what a stretch [from, to) claims would make kept readings or stretches wrong: before backings, a deploy read everything anew,
 * and a wrong stretch kept now would never be read again (only the hours after it are). 2 (2026-11-06): Binance's series reach back through
 * its daily archive, and a stretch kept before held its days older than 30 as read, with no readings.
 */
export const LS_FORMAT = 2;
/** A kept record the cache can trust: finite times, readings in range and in order, at most `maxPoints`, read no later than `now` (with a minute's slack). */
export function validRecord(record: LsHeldRecord, now = Infinity, maxPoints = Infinity): boolean {
  if (!Number.isFinite(record.from) || !Number.isFinite(record.to) || !Number.isFinite(record.checked) || !Array.isArray(record.points)) return false;
  // A record written under a clock that ran ahead would hold the refreshes back and report a failed one as read.
  if (record.checked > now + MINUTE || record.points.length > maxPoints) return false;
  let last = -Infinity;
  for (const p of record.points) { if (!lsReading(p.t, p.long) || p.t <= last) return false; last = p.t; }
  return true;
}

/**
 * The readings asked for, kept: at most `maxSeries` series (the least recently asked for goes first), each one unbroken stretch of at most
 * `maxPoints` readings, and on disk only through a `backing` (below). A series holds [from, to): a window older than that is read back to it, one reaching past it
 * (the newest, at most once a period and never more than once a minute) from where it ends, so a pane hidden for an hour gets the hour; a
 * window further from what is held than one question reaches starts the series again there. Past `maxPoints` the readings furthest from the
 * window asked go. One request at a time per series: a question that waited for another's looks again once it is answered, and a page that
 * has not come in `pageDeadlineMs` fails that request, so no series waits for good. Bitget publishes only its newest 30 periods, so its series
 * grows only while it is asked for (and kept).
 *
 * With a `backing` (a file on the server, IndexedDB in a page) a series is kept across restarts: the first question for it loads what was held
 * (its readings and [from, to) and when its newest stretch was read), so only the hours since are read from the venue, and each read saves
 * what it changed. Bitget's series then grows across restarts too. Without one, nothing is on disk.
 */
export class LongShortCache {
  #series = new Map<string, HeldSeries>();
  /** Each paced venue's lane: when its last request went out (wall-clock ms, once it has), and how many wait behind it. */
  #lanes = new Map<string, { last: Promise<number>; waiting: number }>();
  /** Binance's archive days read lately, for every series of the market (`ArchiveMemo`). */
  #archive = new ArchiveMemo();
  constructor(private get: Fetcher, private browser: boolean, private now: () => number = Date.now, private maxSeries = 48, private maxPoints = 10_000, private pageDeadlineMs = LS_PAGE_DEADLINE_MS,
    private gapMs: Readonly<Record<string, number>> = VENUE_GAP_MS, private backing: LsBacking | null = null) {}

  /** Fill a new series from the backing (once; every question for it waits for this first). A record that cannot be read is no record. */
  async #restore(key: string, h: HeldSeries): Promise<void> {
    try {
      const record = await this.backing!.load(key);
      if (record && validRecord(record, this.now(), this.maxPoints) && h.from === Infinity && !h.points.size) {
        for (const p of record.points) h.points.set(p.t, p);
        h.from = record.from; h.to = record.to; h.checked = record.checked;
      }
    } catch { /* unreadable: the series is read anew */ } finally { h.restoring = null; }
  }

  /**
   * Hand the backing what a read changed. A backing that cannot write costs only the keeping: the series in memory is as read. A series no
   * longer the cache's (evicted while its read was under way, and perhaps restored anew since) saves nothing: its change would land on the
   * newer one's.
   */
  #save(key: string, h: HeldSeries, change: Omit<LsChange, 'from' | 'to' | 'checked'>): void {
    if (!this.backing || this.#series.get(key) !== h) return;
    const full = (): LsHeldRecord => ({ points: [...h.points.values()].sort((a, b) => a.t - b.t), from: h.from, to: h.to, checked: h.checked });
    try { this.backing.save(key, { ...change, from: h.from, to: h.to, checked: h.checked }, full); } catch { /* see above */ }
  }

  /**
   * `ask`, once the venue's least time has passed since its previous request actually went out: one lane a venue, first come first served, the
   * gap checked again after every wait (timers that fire late, after the page was asleep or busy, then still go out a gap apart).
   */
  async #paced<T>(venue: string, ask: () => Promise<T>): Promise<T> {
    const gap = this.gapMs[venue];
    if (!gap) return ask();
    const lane = this.#lanes.get(venue) ?? { last: Promise.resolve(-Infinity), waiting: 0 };
    this.#lanes.set(venue, lane);
    if (lane.waiting >= VENUE_WAITING_MAX) throw new Error(`${venue}: too many requests waiting for their turn`);
    const before = lane.last;
    let sent!: (at: number) => void;
    lane.last = new Promise<number>(resolve => { sent = resolve; });
    lane.waiting++;
    try {
      const last = await before;
      for (let wait = last + gap - Date.now(); wait > 0; wait = last + gap - Date.now()) await new Promise<void>(resolve => setTimeout(resolve, wait));
    } finally { lane.waiting--; }
    sent(Date.now());
    return ask();
  }

  /**
   * The readings of [from, to). With `budgetMs` the answer waits at most that long (wall-clock ms) for a read of the venue: past it, what is held
   * is answered with `pending`, and the read goes on, so the next question gets what it read. Without one it waits for the read, as a question
   * always did (an older page asks so).
   */
  async series(id: string, metric: LsMetric, tfMs: number, from: number, to: number, budgetMs?: number): Promise<LsSeries> {
    const colon = id.indexOf(':'), venue = id.slice(0, colon), symbol = id.slice(colon + 1);
    // A window needs at most `windowReadings` readings: a long one on a fine chart takes a coarser period, so one question always reaches
    // across it and the series never holds more than it keeps. Month-scale context uses daily readings, independent of the candle setting.
    const population = colon > 0 && LS_VENUES.includes(venue) ? lsPopulationOf(venue, metric) : null;
    // The chart's own period where that fits the window, else the shortest that does (OKX steps from five minutes straight to an hour).
    const periodMs = population ? lsWindowPeriod(venue, tfMs, from, to) : 0;
    const answer = (points: LsPoint[], status: LsStatus): LsSeries => ({ id, population, periodMs, points, status });
    if (!population || !periodMs) return answer([], 'unsupported');
    if (this.browser && venue === 'okx') return answer([], 'serverOnly');
    const key = `${id}|${population}|${periodMs}`;
    let held = this.#series.get(key);
    if (held) this.#series.delete(key);
    if (!held) {
      held = { points: new Map(), from: Infinity, to: -Infinity, checked: 0, failed: 0, busy: null, restoring: null, waiting: 0 };
      if (this.backing) held.restoring = this.#restore(key, held);
    }
    this.#series.set(key, held);
    while (this.#series.size > this.maxSeries) this.#series.delete(this.#series.keys().next().value!);
    // The budget counts from the question: a backing slow to load (a page's IndexedDB opening) is waited for within it like a read.
    const until = budgetMs === undefined ? Infinity : Date.now() + Math.max(0, budgetMs);
    const restoring = held.restoring;
    if (restoring && !(await settledBy(restoring, until))) {
      // Its read starts once the series is loaded (a question with no wait: one read for all such questions, the others find it under way),
      // if the cache still holds it: one evicted meanwhile is asked for anew by its next question (kicking it here could evict another
      // series waiting on its own load, and so on without end).
      void restoring.then(() => { if (this.#series.get(key) === held) return this.series(id, metric, tfMs, from, to, 0); }).catch(() => undefined);
      return { ...answer([], 'empty'), pending: true };
    }
    const reach = PAGES * PAGE_ROWS[venue]! * periodMs * 0.9;
    // The page's deadline counts from when the request goes out, not from a wait for the venue's turn.
    const get: Fetcher = (url, init) => this.#paced(venue, () => withDeadline(this.get(url, init), this.pageDeadlineMs));
    // At most four requests of its own; waiting for a request (another question's or its own) is not one of them, or five questions at once for
    // different windows left the last answered from what the others read, empty, without its window ever read. Waiting is bounded too (each
    // request is at most `PAGES` pages, each page at most `pageDeadlineMs`); a question that runs out of either before its window is read says
    // it could not be read (`covered`), never that there are no readings.
    // Past the budget the read goes on: its handlers below update the series whether it succeeds or fails, and `busy` clears itself.
    let covered = false, pending = false;
    for (let reads = 0, waits = 0; ;) {
      if (held.busy) {
        if (waits++ >= 64) break;
        held.waiting++;
        const settled = await settledBy(held.busy, until).finally(() => { held.waiting--; });
        if (!settled) { pending = true; break; }
        continue;
      }
      const h = held, now = this.now(), want = Math.min(to, now + periodMs);
      if (now - h.failed < MINUTE) break;
      let start: number, end: number, kind: 'whole' | 'older' | 'newer';
      // Never read (or started again); a stretch that ends before it starts is held all the same (see below).
      if (h.from === Infinity) { start = from; end = want; kind = 'whole'; }
      else if (from < h.from) { start = from; end = h.from; kind = 'older'; }
      // Past what is held: at once where that ends before the live edge (now's, or the one at the last read: a window that ended a little
      // before it was not held up to it, and its newest readings were not read), at the live edge at most once a period (and once a minute).
      else if (want > h.to && (h.to < now - 2 * periodMs || h.to < h.checked - periodMs || now - h.checked >= Math.max(periodMs, MINUTE))) { start = h.to - 2 * periodMs; end = want; kind = 'newer'; }
      else { covered = true; break; }
      if (reads++ >= 4) break;
      // Too far from what is held for one question to join them without a hole: the series starts again at this window (and so does what the
      // backing keeps, once it is read: a failed read leaves it as it was, a stretch as good as it ever was). The older stretch of a window that
      // reaches what is held joins it however far back it goes: each read reaches back as far as it can and the next reads on from there
      // (started again instead, a window wider than `reach` read its newest stretch over and over, never further back: 2026-11-06 review).
      const restarted = kind !== 'whole' && end - start > reach && !(kind === 'older' && to >= h.from);
      if (restarted) { h.points.clear(); h.from = Infinity; h.to = -Infinity; start = from; end = want; kind = 'whole'; }
      // A read that reached back only part of its window (Binance's archive, `ARCHIVE_DAYS` at a time) and got further than before.
      let short = false;
      // The Binance series chosen is Binance's: every other venue publishes its accounts alone.
      h.busy = fetchLongShort(venue, symbol, LS_CHOSEN_VENUES.includes(venue) ? metric : 'accounts', periodMs, start, end, get, now, this.#archive).then(({ points, from: reached }) => {
        // A market the venue did not list before (asked again once a minute) is published again once it answers.
        h.failed = 0; h.noMarket = false;
        short = (kind === 'whole' || kind === 'older') && reached > start && reached < (kind === 'whole' ? end : h.from);
        for (const p of points) h.points.set(p.t, p);
        // Held from where the answer reached (a long window's pages may stop short of it: the next question reads on from there), up to a
        // period before now: the reading of the period under way comes later. A window that starts inside that period (or after it) is held
        // as a stretch that ends before it starts: nothing is claimed between the edge and the window, so a window there reads it, and the
        // refresh reads on from the edge. (Read as nothing held, it had every question ask the venue again; an empty stretch claimed at the
        // edge skipped the readings between the edge and the window; one claimed at the window's start was past the edge, never refreshed.)
        const until = Math.min(end, now - periodMs);
        if (kind === 'whole') { h.from = reached; h.to = until; h.checked = now; }
        else if (kind === 'older') h.from = Math.min(h.from, reached);
        else {
          // Pages that ran out before reaching what was held leave a hole: only the newer stretch is unbroken (a window in the hole reads it).
          if (reached > h.to) h.from = reached;
          h.to = Math.max(h.to, until); h.checked = now;
        }
        let keep: { first: number; last: number } | null = null;
        if (h.points.size > this.maxPoints) {
          // The readings furthest from the window asked go, so what it asked for is kept and the rest stays one unbroken stretch.
          const times = [...h.points.keys()].sort((a, b) => a - b), first = times.findIndex(t => t >= from - periodMs);
          const at = Math.max(0, Math.min(first < 0 ? times.length : first, times.length - this.maxPoints)), kept = times.slice(at, at + this.maxPoints);
          h.points = new Map(kept.map(t => [t, h.points.get(t)!]));
          h.from = Math.max(h.from, kept[0]!); h.to = Math.min(h.to, kept[kept.length - 1]! + periodMs);
          keep = { first: kept[0]!, last: kept[kept.length - 1]! };
        }
        this.#save(key, h, { cleared: restarted || kind === 'whole', added: points, keep });
      }, error => {
        // When it failed, not when it began: a slow request of many pages would otherwise leave no minute's pause behind it.
        h.failed = this.now();
        if (error instanceof LsNoMarket) h.noMarket = true;
        // A crash in the handlers above counts as a failed read: nobody may be waiting on `busy` (a question past its budget) to catch it.
      }).catch(() => { h.failed = this.now(); }).finally(() => {
        h.busy = null;
        // With no question waiting for it (each gave up at its budget), the rest of the window is read on at once rather than at the next
        // question, seconds later: its line grows a read at a time. A question still waiting reads on itself, in its own turns.
        if (short && !h.waiting && this.#series.get(key) === h) void this.series(id, metric, tfMs, from, to, 0).catch(() => undefined);
      });
    }
    if (held.noMarket) return answer([], 'unsupported');
    const points = [...held.points.values()].filter(p => p.t >= from - periodMs && p.t < to).sort((a, b) => a.t - b.t);
    const failedLast = held.failed > 0 && held.failed >= held.checked;
    // A read still under way when the budget ran out: what is held now, said as it would be without it, and asked again for the rest.
    if (pending) return { ...answer(points, points.length ? (failedLast ? 'stale' : 'ok') : failedLast ? 'failed' : 'empty'), pending: true };
    // The last request failing after the last success says so, with what is held from before; so does a window not read in its turns.
    const failing = !covered || failedLast;
    if (points.length) return answer(points, failing ? 'stale' : 'ok');
    return answer([], failing ? 'failed' : 'empty');
  }
}

const STATUSES: readonly LsStatus[] = ['ok', 'empty', 'unsupported', 'serverOnly', 'failed', 'stale'];
const POPULATIONS: readonly LsPopulation[] = ['accounts', 'topAccounts', 'topPositions', 'activeAccounts'];
/** A series as it came over the wire, checked: anything not of its shape is an error; a reading out of range or out of order is left out. */
export function parseLsSeries(value: unknown): LsSeries {
  const id = at(value, 'id'), population = at(value, 'population'), periodMs = num(at(value, 'periodMs')), status = at(value, 'status'), points = at(value, 'points');
  if (typeof id !== 'string' || !(population === null || POPULATIONS.includes(population as LsPopulation)) || !(periodMs >= 0) || !STATUSES.includes(status as LsStatus) || !Array.isArray(points))
    throw new Error('not a long/short series');
  const kept: LsPoint[] = [];
  for (const p of points) { const r = lsReading(num(at(p, 't')), num(at(p, 'long'))); if (r && (!kept.length || r.t > kept[kept.length - 1]!.t)) kept.push(r); }
  const series: LsSeries = { id, population: population as LsPopulation | null, periodMs, points: kept, status: status as LsStatus };
  return at(value, 'pending') === true ? { ...series, pending: true } : series;
}
