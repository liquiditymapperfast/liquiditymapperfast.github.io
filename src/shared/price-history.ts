import { CANDLE_VENUES, fetchCandles, type Fetcher, type HistoryListing } from './history.ts';
import { instrumentIdFor, type Coin, type MarketVenue } from './coins.ts';
import { TIMEFRAMES, type Candle } from './series.ts';

/** Public price context, kept apart from the chart's indicator candles and the local trade/depth recordings. */
export interface PriceHistoryAnswer {
  instrumentId: string;
  tfMs: number;
  from: number;
  to: number;
  /** Last time the bar still under way was read, never a carried-forward price stamped with a later request's time. */
  asOf: number;
  status: 'ok' | 'empty' | 'stale' | 'failed';
  candles: Candle[];
}
export interface PriceTarget { id: string; listing: HistoryListing; kind: 'spot' | 'perp' }

export const PRICE_QUERY_BARS = 2_000;
/**
 * The line's intervals: the chart's timeframes and weeks for a view whose days one read cannot hold (`priceWindow`). A week is seven days since
 * 1970, built from the venue's days (`nativeInterval`), never the venue's own week: Binance's begins on a Monday, off the whole weeks every bar
 * of this cache is checked against.
 */
export const PRICE_TIMEFRAMES: Readonly<Record<string, number>> = Object.freeze(Object.assign(Object.create(null) as Record<string, number>, TIMEFRAMES, { '1w': 7 * 86_400_000 }));
/** The length of the line's interval named `name`, or null when there is none (whatever the name is: a request can say anything). */
export const priceTimeframeMs = (name: unknown): number | null => typeof name === 'string' && Object.hasOwn(PRICE_TIMEFRAMES, name) ? PRICE_TIMEFRAMES[name]! : null;
// Twelve series: the line has eight intervals, and a zoom through them leaves each dropped read going on here (`ChartPriceHistory.#dropped`), so
// eight series still being read and a ninth asked for (the spot market, another coin) found none to let go: "busy" (review, 2026-11-07).
const CACHE_SERIES = 12, CACHE_BARS = 4_000, REFRESH_MS = 60_000, RETRY_MS = 60_000, PAGE_LIMIT = 32;

/** The server's Binance spot alias and the browser's id name the same instrument. */
export const priceInstrument = (id: string): string => id.replace(/^([^:]+):([^:]+):spot$/, '$1spot:$2');

/** Resolve an exact listing, never BTC by default and never another contract sharing its venue prefix. */
export function priceListing(coin: Coin, id: string): PriceTarget | null {
  id = priceInstrument(id);
  const venue = id.split(':')[0] as MarketVenue, listing = coin.markets[venue];
  if (!CANDLE_VENUES.includes(venue) || !listing || instrumentIdFor(venue, coin) !== id || !(listing.unit > 0) || !Number.isFinite(listing.unit)) return null;
  return { id, listing, kind: venue.endsWith('spot') || venue === 'coinbase' ? 'spot' : 'perp' };
}

/** Binance first, matching the chart's market kind; fallbacks must list this very coin and are always named in the overview. */
export function priceTarget(coin: Coin, chartId: string, kind: 'spot' | 'perp'): PriceTarget | null {
  const preferred = kind === 'spot' ? ['binancespot', 'binance'] : ['binance', 'binancespot'];
  for (const venue of preferred) { const id = instrumentIdFor(venue, coin); if (id) { const target = priceListing(coin, id); if (target) return target; } }
  const own = priceListing(coin, chartId); if (own) return own;
  const venues = [...CANDLE_VENUES].sort((a, b) => Number((b.endsWith('spot') || b === 'coinbase') === (kind === 'spot')) - Number((a.endsWith('spot') || a === 'coinbase') === (kind === 'spot')));
  for (const venue of venues) { const id = instrumentIdFor(venue, coin); if (id) { const target = priceListing(coin, id); if (target) return target; } }
  return null;
}

/** Check the public response at the HTTP boundary. Inconsistent OHLC and non-finite values never reach a canvas or its price scale. */
export function validPriceCandle(value: unknown, tfMs: number): value is Candle {
  if (!Array.isArray(value) || value.length !== 7 || !value.every(v => typeof v === 'number' && Number.isFinite(v))) return false;
  const [t, o, h, l, c, v, n] = value as number[];
  return Number.isSafeInteger(t) && t! >= 0 && t! % tfMs === 0 && l! > 0 && h! >= Math.max(o!, c!) && l! <= Math.min(o!, c!) && v! >= 0 && Number.isSafeInteger(n) && n! >= 1;
}

/** Reject malformed/oversized answers and a different instrument or resolution, including from an older or faulty server. */
export function parsePriceHistory(value: unknown, id: string, tfMs: number): PriceHistoryAnswer {
  if (!value || typeof value !== 'object') throw new Error('Invalid price history');
  const a = value as Record<string, unknown>;
  if (a.instrumentId !== id || a.tfMs !== tfMs || !['ok', 'empty', 'stale', 'failed'].includes(String(a.status)) ||
      ![a.from, a.to, a.asOf].every(v => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0) || Number(a.to) < Number(a.from) ||
      !Array.isArray(a.candles) || a.candles.length > PRICE_QUERY_BARS + 2) throw new Error('Invalid price history');
  let previous = -1;
  for (const c of a.candles) {
    if (!validPriceCandle(c, tfMs) || c[0] <= previous || c[0] < Number(a.from) || c[0] >= Number(a.to) || c[0] > Number(a.asOf)) throw new Error('Invalid price candle');
    previous = c[0];
  }
  if ((a.status === 'ok' || a.status === 'stale') !== (a.candles.length > 0)) throw new Error('Invalid price history status');
  return a as unknown as PriceHistoryAnswer;
}

interface Entry {
  from: number; to: number; bars: Candle[]; liveAt: number; partial: number | null; retryAt: number; failed: boolean;
  pending: Promise<void> | null;
}

/** A successful HTTP response can still be an exchange error or a changed schema. Neither is an empty history. */
function candlePage(venue: string, answer: unknown): boolean {
  const object = (v: unknown): Record<string, unknown> => v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {};
  if (['binance', 'binancespot', 'coinbase', 'hyperliquid'].includes(venue)) return Array.isArray(answer);
  const a = object(answer), result = object(a.result);
  if (venue === 'bybit' || venue === 'bybitspot') return Number(a.retCode ?? 0) === 0 && Array.isArray(result.list);
  if (venue === 'deribit') return ['ticks', 'open', 'high', 'low', 'close', 'volume'].every(k => Array.isArray(result[k]));
  return (a.code === undefined || Number(a.code) === 0) && Array.isArray(a.data);
}

/**
 * One bounded cache for either data source: twelve series, 4,000 time slots each, one read per series. Ended bars stay; only missing dates
 * and the live tail are fetched. Failed reads keep their old data, and every read, including a fetcher that never settles, has a deadline.
 */
export class PriceHistoryCache {
  readonly #entries = new Map<string, Entry>();
  constructor(private get: Fetcher, private now: () => number = Date.now, private deadlineMs = 20_000) {}

  async series(target: PriceTarget, tfMs: number, from: number, to: number): Promise<PriceHistoryAnswer> {
    if (!Object.values(PRICE_TIMEFRAMES).includes(tfMs) || ![from, to].every(v => Number.isSafeInteger(v) && v >= 0) || to <= from || to - from > PRICE_QUERY_BARS * tfMs) throw new Error('Invalid price window');
    const now = this.now(), a = Math.floor(from / tfMs) * tfMs, b = Math.ceil(Math.min(to, now + 1) / tfMs) * tfMs;
    if (a >= b) return { instrumentId: target.id, tfMs, from: a, to: a, asOf: now, status: 'empty', candles: [] };
    const key = `${target.id}|${target.listing.symbol}|${target.listing.unit}|${tfMs}`;
    let e = this.#entries.get(key);
    if (!e) {
      if (this.#entries.size >= CACHE_SERIES) {
        const old = [...this.#entries].find(([, entry]) => !entry.pending);
        if (!old) throw new Error('Price history is busy');
        this.#entries.delete(old[0]);
      }
      e = { from: Infinity, to: -Infinity, bars: [], liveAt: 0, partial: null, retryAt: 0, failed: false, pending: null };
    }
    this.#entries.delete(key); this.#entries.set(key, e);
    // A waiter looks again after the shared read. Three reads cover an empty/disjoint window, or extensions on both sides and a live tail.
    for (let turns = 0, waits = 0; turns < 3 && waits < 8;) {
      if (e.pending) { await e.pending; waits++; continue; }
      if (this.now() < e.retryAt) break;
      let lo: number, hi: number;
      // A nearby pan reads through the small gap and keeps the existing stretch; a distant view starts a bounded stretch of its own.
      const disjoint = !Number.isFinite(e.from) || (a > e.to && b - e.to > PRICE_QUERY_BARS * tfMs) || (b < e.from && e.from - a > PRICE_QUERY_BARS * tfMs);
      if (disjoint) { lo = a; hi = b; }
      else if (a < e.from) { lo = a; hi = e.from; }
      else if (b > e.to) { lo = e.to - tfMs; hi = b; }
      else if (e.partial !== null && e.partial < b && e.partial + tfMs > a && e.partial + tfMs <= this.now()) { lo = e.partial; hi = Math.min(b, e.partial + tfMs); }
      else if (b > this.now() && (this.now() - e.liveAt >= REFRESH_MS || Math.floor(this.now() / tfMs) > Math.floor(e.liveAt / tfMs))) { lo = Math.max(a, b - 2 * tfMs); hi = b; }
      else break;
      const held = e;
      held.pending = this.#read(target, tfMs, lo, hi, held, disjoint, a, b).finally(() => { held.pending = null; });
      await held.pending; turns++;
      if (held.failed) break;
    }
    const candles = e.bars.filter(c => c[0] >= a && c[0] < b);
    const covered = e.from <= a && e.to >= b;
    const failed = e.failed || !covered;
    const partial = e.partial !== null && candles.some(c => c[0] === e.partial);
    return { instrumentId: target.id, tfMs, from: a, to: b, asOf: partial ? e.liveAt : this.now(), status: failed ? (candles.length ? 'stale' : 'failed') : candles.length ? 'ok' : 'empty', candles };
  }

  async #read(target: PriceTarget, tfMs: number, from: number, to: number, e: Entry, replace: boolean, needFrom: number, needTo: number): Promise<void> {
    const started = this.now(), controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined, requests = 0;
    const get: Fetcher = async (url, init) => {
      controller.signal.throwIfAborted(); requests++;
      const answer = await this.get(url, { ...init, signal: controller.signal });
      if (!candlePage(target.id.split(':')[0]!, answer)) throw new Error('No price candles in the answer');
      return answer;
    };
    try {
      const timeout = new Promise<never>((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(new Error('Price history timed out')); }, this.deadlineMs); });
      const rows = await Promise.race([fetchCandles(target.id, tfMs, from, Math.min(to - 1, started), get, target.listing, PAGE_LIMIT, { pageSize: 499, strict: true }), timeout]);
      if (requests >= PAGE_LIMIT && (!rows.length || rows[0]![0] > from + tfMs)) throw new Error('Price history stopped before its window');
      if (rows.some(c => !validPriceCandle(c, tfMs))) throw new Error('Invalid price candles');
      const first = replace ? from : Math.min(from, e.from), last = replace ? to : Math.max(to, e.to);
      // Keep one contiguous bounded stretch containing the requested view; empty slots count too, so an illiquid listing cannot grow it forever.
      const keepFrom = Math.max(first, Math.min(needFrom, last - CACHE_BARS * tfMs)), keepTo = Math.min(last, keepFrom + CACHE_BARS * tfMs);
      const merged = new Map<number, Candle>((replace ? [] : e.bars).map(c => [c[0], c]));
      for (const c of rows) if (c[0] >= from && c[0] < to) merged.set(c[0], c);
      e.bars = [...merged.values()].filter(c => c[0] >= keepFrom && c[0] < keepTo).sort((x, y) => x[0] - y[0]);
      e.from = keepFrom; e.to = keepTo; e.failed = false; e.retryAt = 0;
      if (e.partial !== null && e.partial >= from && e.partial < to && e.partial + tfMs <= started) e.partial = null;
      if (to > started && from <= started) {
        e.liveAt = started;
        const live = rows.find(c => c[0] <= started && c[0] + tfMs > started);
        e.partial = live?.[0] ?? null;
      }
      // `needTo` is part of the cache's bounded-window invariant (never trim the view's far end).
      if (e.to < needTo && needTo - needFrom <= CACHE_BARS * tfMs && to >= needTo) throw new Error('Price history cache did not retain its window');
    } catch { e.failed = true; e.retryAt = this.now() + RETRY_MS; }
    finally { if (timer !== undefined) clearTimeout(timer); }
  }
}
