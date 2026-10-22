import { aggregateCandles, aggregateOi, withLiveOi, type Candle, type CandleRow, type OiBar, type OiRow } from './series.ts';
import { BTC, type CoinVenue, type Listing } from './coins.ts';

/**
 * History straight from each exchange's public REST API, as a browser can read it (every endpoint here answers with CORS headers):
 * candles for the chart and open interest for the pane, for one coin's listing on each market (BTC unless one is given). A listing in units
 * of 1000 (1000PEPEUSDT) is converted to one coin: prices divided, volumes and open interest multiplied.
 */

/**
 * Fetch one URL and parse its JSON; the browser passes `fetch`, tests pass a fake. A `wss://` URL is a request over a short-lived
 * WebSocket: `init.body` is sent as the first message and the first reply is the answer (Deribit's candle endpoint sends no CORS
 * headers, so a page cannot read it over HTTP, but its JSON-RPC socket serves the same method).
 */
export type Fetcher = (url: string, init?: { method?: string; headers?: Record<string, string>; body?: string; signal?: AbortSignal }) => Promise<unknown>;

/** One request and its first reply over a WebSocket (see `Fetcher`). */
function socketRequest(url: string, body: string, timeoutMs: number): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url);
    let settled = false;
    const timer = setTimeout(() => settle(() => reject(new Error('the socket request timed out'))), timeoutMs);
    const settle = (finish: () => void): void => { if (settled) return; settled = true; clearTimeout(timer); try { socket.close(); } catch { /* already closed */ } finish(); };
    socket.onopen = () => socket.send(body);
    socket.onmessage = event => settle(() => { try { resolve(JSON.parse(String(event.data))); } catch (error) { reject(error); } });
    socket.onerror = () => settle(() => reject(new Error('the socket request failed')));
    socket.onclose = () => settle(() => reject(new Error('the socket closed before it answered')));
  });
}
/** The fetcher a page or a worker uses: HTTP with a 15 s limit, and a `wss://` URL as one request over a socket. */
export const webGet: Fetcher = async (url, init) => {
  if (url.startsWith('wss://')) return socketRequest(url, init?.body ?? '', 15_000);
  const timeout = AbortSignal.timeout(15_000);
  const response = await fetch(url, { ...init, signal: init?.signal ? AbortSignal.any([init.signal, timeout]) : timeout });
  // The status and the start of the answer go with the error: a venue may say why in it (Gate answers a contract it does not list with a
  // 400 that says `CONTRACT_NOT_FOUND`).
  if (!response.ok) throw Object.assign(new Error(`HTTP ${response.status}`), { status: response.status, body: (await response.text().catch(() => '')).slice(0, 500) });
  return response.json();
};

const num = (value: unknown): number => Number(value);
const at = (value: unknown, ...path: (string | number)[]): unknown => path.reduce<unknown>((v, key) => (v !== null && typeof v === 'object' ? (v as Record<string | number, unknown>)[key] : undefined), value);
const list = (value: unknown): unknown[] => Array.isArray(value) ? value : [];
const MINUTE = 60_000, HOUR = 3_600_000, DAY = 86_400_000;

/** One venue's candle endpoint: the intervals it serves natively, how many bars a page holds and how to read one page ending at `endMs`. */
interface CandleSpec {
  /** Interval length in ms to the venue's name for it. */
  intervals: Readonly<Record<number, string>>;
  limit: number;
  /** `symbol` is the market's own name for the coin. */
  page(interval: string, intervalMs: number, endMs: number, get: Fetcher, symbol: string, limit?: number): Promise<CandleRow[]>;
}

/** A taker-buy figure that is a number from nothing to the volume, or none: null, '', false or a figure past the volume is not a zero. */
const takerBuy = (buy: unknown, volume: number): number | null => {
  const n = typeof buy === 'number' ? buy : typeof buy === 'string' && buy.trim() !== '' ? Number(buy) : NaN;
  return Number.isFinite(n) && n >= 0 && Number.isFinite(volume) && n <= volume * (1 + 1e-9) ? n : null;
};
/** A number, or a numeric string that is not empty; anything else NaN (`Number` would read null, '' and false as 0). */
const figure = (value: unknown): number => typeof value === 'number' ? value : typeof value === 'string' && value.trim() !== '' ? Number(value) : NaN;
const row = (start: unknown, open: unknown, high: unknown, low: unknown, close: unknown, volume: unknown, buy?: unknown, quote?: unknown, trades?: unknown, buyQuote?: unknown): CandleRow => {
  const v = num(volume), b = buy === undefined ? null : takerBuy(buy, v);
  // The trades and the quote volume with its part bought at market, together or not at all: a figure that is not one (null, '', false, a
  // word) leaves all three out, never reads as 0.
  const q = figure(quote), n = figure(trades), bq = buyQuote === undefined || !(q >= 0) ? null : takerBuy(buyQuote, q);
  const detail = q >= 0 && Number.isSafeInteger(n) && n >= 0 && bq !== null ? { trades: n, quote: q, buyQuote: bq } : {};
  return { start: num(start), open: num(open), high: num(high), low: num(low), close: num(close), volume: v, ...(b === null ? {} : { buy: b }), ...detail };
};

/**
 * Binance's klines, the perpetual's and the spot market's alike: the tenth field is the taker buy volume, the part bought at market; the
 * eighth the quote volume, the ninth the number of trades and the eleventh the taker buy quote volume.
 */
const binanceRows = (json: unknown): CandleRow[] => list(json).map(r => row(at(r, 0), at(r, 1), at(r, 2), at(r, 3), at(r, 4), at(r, 5), at(r, 9), at(r, 7), at(r, 8), at(r, 10)));
const BINANCE = { 60_000: '1m', 300_000: '5m', 900_000: '15m', 1_800_000: '30m', 3_600_000: '1h', 14_400_000: '4h', 86_400_000: '1d' } as const;

const SPECS: Readonly<Record<string, CandleSpec>> = {
  binance: { intervals: BINANCE, limit: 1500, page: async (i, _ms, end, get, symbol, limit = 1500) => binanceRows(await get(`https://fapi.binance.com/fapi/v1/klines?symbol=${symbol}&interval=${i}&endTime=${end}&limit=${limit}`)) },
  binancespot: { intervals: BINANCE, limit: 1000, page: async (i, _ms, end, get, symbol, limit = 1000) => binanceRows(await get(`https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=${i}&endTime=${end}&limit=${limit}`)) },
  bybit: {
    intervals: { 60_000: '1', 300_000: '5', 900_000: '15', 1_800_000: '30', 3_600_000: '60', 14_400_000: '240', 86_400_000: 'D' }, limit: 1000,
    page: async (i, _ms, end, get, symbol, limit = 1000) => list(at(await get(`https://api.bybit.com/v5/market/kline?category=linear&symbol=${symbol}&interval=${i}&end=${end}&limit=${limit}`), 'result', 'list')).map(r => row(at(r, 0), at(r, 1), at(r, 2), at(r, 3), at(r, 4), at(r, 5))),
  },
  bybitspot: {
    intervals: { 60_000: '1', 300_000: '5', 900_000: '15', 1_800_000: '30', 3_600_000: '60', 14_400_000: '240', 86_400_000: 'D' }, limit: 1000,
    page: async (i, _ms, end, get, symbol, limit = 1000) => list(at(await get(`https://api.bybit.com/v5/market/kline?category=spot&symbol=${symbol}&interval=${i}&end=${end}&limit=${limit}`), 'result', 'list')).map(r => row(at(r, 0), at(r, 1), at(r, 2), at(r, 3), at(r, 4), at(r, 5))),
  },
  okx: {
    intervals: { 60_000: '1m', 300_000: '5m', 900_000: '15m', 1_800_000: '30m', 3_600_000: '1H', 14_400_000: '4H', 86_400_000: '1Dutc' }, limit: 100,
    // volCcy (column 6) is in coin; the plain volume is in contracts.
    page: async (i, _ms, end, get, symbol, limit = 100) => list(at(await get(`https://www.okx.com/api/v5/market/history-candles?instId=${symbol}&bar=${i}&after=${end + 1}&limit=${limit}`), 'data')).map(r => row(at(r, 0), at(r, 1), at(r, 2), at(r, 3), at(r, 4), at(r, 6))),
  },
  okxspot: {
    intervals: { 60_000: '1m', 300_000: '5m', 900_000: '15m', 1_800_000: '30m', 3_600_000: '1H', 14_400_000: '4H', 86_400_000: '1Dutc' }, limit: 100,
    // On spot the plain volume (column 5) is in coin; volCcy is in USDT.
    page: async (i, _ms, end, get, symbol, limit = 100) => list(at(await get(`https://www.okx.com/api/v5/market/history-candles?instId=${symbol}&bar=${i}&after=${end + 1}&limit=${limit}`), 'data')).map(r => row(at(r, 0), at(r, 1), at(r, 2), at(r, 3), at(r, 4), at(r, 5))),
  },
  bitget: {
    intervals: { 60_000: '1m', 300_000: '5m', 900_000: '15m', 1_800_000: '30m', 3_600_000: '1H', 14_400_000: '4H', 86_400_000: '1Dutc' }, limit: 1000,
    page: async (i, _ms, end, get, symbol, limit = 1000) => list(at(await get(`https://api.bitget.com/api/v2/mix/market/candles?symbol=${symbol}&productType=usdt-futures&granularity=${i}&endTime=${end}&limit=${limit}`), 'data')).map(r => row(at(r, 0), at(r, 1), at(r, 2), at(r, 3), at(r, 4), at(r, 5))),
  },
  bitgetspot: {
    // Spot names its intervals unlike futures (1min, not 1m).
    intervals: { 60_000: '1min', 300_000: '5min', 900_000: '15min', 1_800_000: '30min', 3_600_000: '1h', 14_400_000: '4h', 86_400_000: '1Dutc' }, limit: 1000,
    page: async (i, _ms, end, get, symbol, limit = 1000) => list(at(await get(`https://api.bitget.com/api/v2/spot/market/candles?symbol=${symbol}&granularity=${i}&endTime=${end}&limit=${limit}`), 'data')).map(r => row(at(r, 0), at(r, 1), at(r, 2), at(r, 3), at(r, 4), at(r, 5))),
  },
  coinbase: {
    intervals: { 60_000: '60', 300_000: '300', 900_000: '900', 3_600_000: '3600', 21_600_000: '21600', 86_400_000: '86400' }, limit: 300,
    // [time in seconds, low, high, open, close, volume]
    page: async (i, ms, end, get, symbol, limit = 300) => list(await get(`https://api.exchange.coinbase.com/products/${symbol}/candles?granularity=${i}&start=${new Date(end - Math.max(1, limit - 1) * ms).toISOString()}&end=${new Date(end).toISOString()}`)).map(r => row(num(at(r, 0)) * 1000, at(r, 3), at(r, 2), at(r, 1), at(r, 4), at(r, 5))),
  },
  deribit: {
    intervals: { 60_000: '1', 300_000: '5', 900_000: '15', 1_800_000: '30', 3_600_000: '60', 86_400_000: '1D' }, limit: 1000,
    page: async (i, ms, end, get, symbol, limit = 1000) => {
      const request = { jsonrpc: '2.0', id: 1, method: 'public/get_tradingview_chart_data', params: { instrument_name: symbol, resolution: i, start_timestamp: end - (limit - 1) * ms, end_timestamp: end } };
      const d = at(await get('wss://www.deribit.com/ws/api/v2', { method: 'RPC', headers: {}, body: JSON.stringify(request) }), 'result');
      return list(at(d, 'ticks')).map((t, k) => row(t, at(d, 'open', k), at(d, 'high', k), at(d, 'low', k), at(d, 'close', k), at(d, 'volume', k)));
    },
  },
  hyperliquid: {
    intervals: { 60_000: '1m', 300_000: '5m', 900_000: '15m', 1_800_000: '30m', 3_600_000: '1h', 14_400_000: '4h', 86_400_000: '1d' }, limit: 1000,
    page: async (i, ms, end, get, symbol, limit = 1000) => list(await get('https://api.hyperliquid.xyz/info', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ type: 'candleSnapshot', req: { coin: symbol, interval: i, startTime: end - (limit - 1) * ms, endTime: end } }) }))
      .map(r => row(at(r, 't'), at(r, 'o'), at(r, 'h'), at(r, 'l'), at(r, 'c'), at(r, 'v'))),
  },
};

/** The venue id of an instrument id ("binance:BTCUSDT" is "binance"). */
export const venueOf = (instrumentId: string): string => instrumentId.split(':')[0]!;
/** How a market lists the coin: what was given, else BTC's listing there. */
export type HistoryListing = Pick<Listing, 'symbol' | 'unit' | 'inverse'>;
const listingOf = (venue: string, listing?: HistoryListing): HistoryListing | null => listing ?? BTC.markets[venue as CoinVenue] ?? null;
/** Venues whose candles this module can fetch. */
export const CANDLE_VENUES: readonly string[] = Object.keys(SPECS);

/** The largest native interval that is no longer than `tfMs` and divides it, so a coarser timeframe can be built from it. */
export function nativeInterval(spec: Pick<CandleSpec, 'intervals'>, tfMs: number): number | null {
  let best: number | null = null;
  for (const key of Object.keys(spec.intervals)) { const ms = Number(key); if (ms <= tfMs && tfMs % ms === 0 && (best === null || ms > best)) best = ms; }
  return best;
}

/**
 * Candles for `instrumentId` at `tfMs` over [from, to], oldest first, built from the venue's native bars (a coarser timeframe is
 * aggregated from a finer one) by walking back page by page from `to`. Returns [] for a venue it does not know. A page that fails throws,
 * unless `partial` is asked for and pages came before it: then what came is returned, the newest part of [from, to] unbroken, for the
 * caller to ask on from where it got to (a timeout on the fifteenth page of four months of five-minute bars threw the fourteen away). `buy`:
 * each candle carries its taker buys where the venue reports them (Binance), for the volume profile's split.
 */
export async function fetchCandles(instrumentId: string, tfMs: number, from: number, to: number, get: Fetcher, listing?: HistoryListing, maxPages = 12, options?: { pageSize?: number; strict?: boolean; partial?: boolean; buy?: boolean }): Promise<Candle[]> {
  const spec = SPECS[venueOf(instrumentId)], market = listingOf(venueOf(instrumentId), listing);
  const native = spec ? nativeInterval(spec, tfMs) : null;
  if (!spec || !market || native === null) return [];
  const interval = spec.intervals[native]!;
  const rows = new Map<number, CandleRow>();
  let end = to;
  // Enough pages for the window, with a ceiling so a misbehaving endpoint cannot loop.
  for (let pages = 0; pages < maxPages && end > from; pages++) {
    // Price context and VWAP/levels ask only for the bars they need, including small tail refreshes.
    const limit = options?.pageSize === undefined ? undefined : Math.max(1, Math.min(spec.limit, options.pageSize, Math.ceil((end - from) / native) + 2));
    let received: CandleRow[];
    try { received = await spec.page(interval, native, end, get, market.symbol, limit); } catch (error) { if (options?.partial && rows.size) break; throw error; }
    if (options?.strict && received.some(r => ![r.start, r.open, r.high, r.low, r.close, r.volume].every(Number.isFinite) || !Number.isSafeInteger(r.start) || r.start < 0 || r.start % native !== 0 || !(r.low > 0) || r.high < Math.max(r.open, r.close) || r.low > Math.min(r.open, r.close) || !(r.volume! >= 0))) throw new Error('Invalid candle page');
    const got = received.filter(r => Number.isFinite(r.start) && Number.isFinite(r.open) && Number.isFinite(r.close));
    if (!got.length) break;
    let oldest = Infinity;
    for (const r of got) { rows.set(r.start, r); oldest = Math.min(oldest, r.start); }
    if (oldest >= end) break;
    end = oldest - 1;
  }
  const u = market.unit, kept = [...rows.values()].filter(r => r.start >= from - tfMs && r.start <= to);
  return aggregateCandles(u === 1 ? kept : kept.map(r => ({ ...r, open: r.open / u, high: r.high / u, low: r.low / u, close: r.close / u, ...(r.volume === undefined ? {} : { volume: r.volume * u }), ...(r.buy === undefined ? {} : { buy: r.buy * u }) })), tfMs, options?.buy === true);
}

/**
 * Venues with an open-interest history this module can read: Binance (thirty days), Bybit (pages back further than a week) and OKX (a day or
 * two at five minutes; its statistics endpoint sends no CORS header, so only the server reads it). Every figure is in coins.
 */
export const OI_VENUES: readonly string[] = ['binance', 'bybit', 'okx'];
/**
 * Venues whose live open interest can be sampled, in coins: the perpetuals of the largest venues (measured 2026-10-13 on BTC: Binance 94K,
 * Bybit 57K, Hyperliquid 38K, Bitget 32K, OKX 29K, Deribit 10K). Those without a history build theirs up while they are sampled.
 */
export const OI_SAMPLE_VENUES: readonly string[] = ['binance', 'bybit', 'hyperliquid', 'bitget', 'okx', 'deribit'];

/** Open-interest periods each venue's history serves, in ms. */
const BINANCE_OI_PERIODS: Readonly<Record<number, string>> = { 300_000: '5m', 900_000: '15m', 1_800_000: '30m', 3_600_000: '1h', 14_400_000: '4h', 86_400_000: '1d' };
const BYBIT_OI_PERIODS: Readonly<Record<number, string>> = { 300_000: '5min', 900_000: '15min', 1_800_000: '30min', 3_600_000: '1h', 14_400_000: '4h', 86_400_000: '1d' };
const OKX_OI_PERIODS: Readonly<Record<number, string>> = { 300_000: '5m', 3_600_000: '1H', 86_400_000: '1D' };
/** At most this many pages a history question reads, oldest last. */
const OI_PAGES = 12;

const oiRow = (t: number, coins: number): OiRow => ({ start: t, open: coins, high: coins, low: coins, close: coins });

/** A venue's perpetual open interest in coins per bucket over [from, to), from its public history (empty for a venue that has none). */
export async function fetchOiHistory(instrumentId: string, tfMs: number, from: number, to: number, get: Fetcher, listing?: HistoryListing): Promise<OiRow[]> {
  const venue = venueOf(instrumentId), market = listingOf(venue, listing);
  if (!market || !OI_VENUES.includes(venue)) return [];
  const rows = new Map<number, OiRow>(), take = (t: number, coins: number): void => { if (Number.isFinite(t) && coins > 0 && t >= from - tfMs && t <= to) rows.set(t, oiRow(t, coins * market.unit)); };
  // An answer that is not the venue's list (an error sent with HTTP 200) fails the read: the sampler tries again later, where an empty
  // history would have been taken as done.
  const rowsOf = (answer: unknown, ok: boolean, path: (string | number)[]): unknown[] => {
    const got = at(answer, ...path);
    if (!ok || !Array.isArray(got)) throw new Error(`${venue}: no open-interest history in the answer`);
    return got;
  };
  if (venue === 'binance') {
    const period = nativeInterval({ intervals: BINANCE_OI_PERIODS }, Math.max(tfMs, 300_000)) ?? 300_000;
    for (const r of rowsOf(await get(`https://fapi.binance.com/futures/data/openInterestHist?symbol=${market.symbol}&period=${BINANCE_OI_PERIODS[period]}&limit=500&endTime=${to}`), true, []))
      take(num(at(r, 'timestamp')), num(at(r, 'sumOpenInterest')));
  } else if (venue === 'bybit' && !market.inverse) {
    // (An inverse perpetual's history is in USD with no price to put it in coins at: its part starts when sampling does, as Deribit's.)
    const period = nativeInterval({ intervals: BYBIT_OI_PERIODS }, Math.max(tfMs, 300_000)) ?? 300_000;
    // Newest first, 200 a page; each next page ends before the oldest of the last.
    for (let end = to, page = 0; page < OI_PAGES && end >= from; page++) {
      const answer = await get(`https://api.bybit.com/v5/market/open-interest?category=linear&symbol=${market.symbol}&intervalTime=${BYBIT_OI_PERIODS[period]}&limit=200&endTime=${Math.floor(end)}`);
      const got = rowsOf(answer, at(answer, 'retCode') === undefined || num(at(answer, 'retCode')) === 0, ['result', 'list']);
      let oldest = Infinity;
      // `openInterest` counts both sides of every contract (Bybit, 2026); `singleOpenInterest` is one side, as every other venue reports.
      for (const r of got) { const t = num(at(r, 'timestamp')); take(t, bybitSingle(r, 'openInterest')); if (t < oldest) oldest = t; }
      if (got.length < 200 || !Number.isFinite(oldest)) break;
      end = oldest - 1;
    }
  } else if (venue === 'okx') {
    const period = nativeInterval({ intervals: OKX_OI_PERIODS }, Math.max(tfMs, 300_000)) ?? 300_000;
    for (let end = to, page = 0; page < OI_PAGES && end >= from; page++) {
      // Rows of [ts, contracts, coins, USD], newest first, 100 a page. A row is stamped with the start of its period but holds the reading at
      // its end (it matches a live sample a period after its stamp, measured 2026-10-14 on 5m and 1H; Binance's and Bybit's match at their
      // stamp), so it is put at the end, the period still under way at `to`.
      const answer = await get(`https://www.okx.com/api/v5/rubik/stat/contracts/open-interest-history?instId=${market.symbol}&period=${OKX_OI_PERIODS[period]}&limit=100&end=${Math.floor(end)}`);
      const got = rowsOf(answer, at(answer, 'code') === undefined || String(at(answer, 'code')) === '0', ['data']);
      let oldest = Infinity;
      for (const r of got) { const t = num(at(r, 0)); take(Math.min(t + period, to), num(at(r, 2))); if (t < oldest) oldest = t; }
      if (got.length < 100 || !Number.isFinite(oldest)) break;
      end = oldest - 1;
    }
  }
  return [...rows.values()].sort((a, b) => Number(a.start) - Number(b.start));
}

/**
 * One side of Bybit's open interest: its `openInterest` and `openInterestValue` count both sides of every contract (twice what the other
 * venues report; measured 2026-10-14, 59,682 against `singleOpenInterest` 29,841 BTC), so the `single…` field is read, and half of the
 * two-sided one where an answer has no `single…` field.
 */
function bybitSingle(row: unknown, field: 'openInterest' | 'openInterestValue'): number {
  const single = at(row, `single${field[0]!.toUpperCase()}${field.slice(1)}`);
  return single !== undefined && single !== null && single !== '' ? num(single) : num(at(row, field)) / 2;
}

/** A live open-interest reading, in coins, of a venue's perpetual (null where it has none, or no listing for the coin). */
export async function fetchOiSample(venue: string, get: Fetcher, listing?: HistoryListing): Promise<number | null> {
  return (await fetchOiReading(venue, get, listing))?.base ?? null;
}

/**
 * The same reading with, for an inverse market (Deribit's BTC and ETH perpetuals, counted in USD), its own USD as `quote`: its coins are
 * the USD at the mark of the moment, and only the USD tells contracts opened or closed apart from the price moving. Where the venue's
 * answer carries its own clock (Bybit's `time`, OKX's row `ts`), it is kept as `sourceTimestamp`, so the reading is placed by the
 * exchange's time, not by when it arrived here.
 */
export async function fetchOiReading(venue: string, get: Fetcher, listing?: HistoryListing): Promise<{ base: number; quote?: number; sourceTimestamp?: number } | null> {
  const value = await readOiSample(venue, get, listing);
  return value === null ? null : typeof value === 'number' ? { base: value } : value;
}

async function readOiSample(venue: string, get: Fetcher, listing?: HistoryListing): Promise<number | { base: number; quote?: number; sourceTimestamp?: number } | null> {
  const market = listingOf(venue, listing); if (!market) return null;
  const coins = (v: number): number | null => v > 0 && Number.isFinite(v) ? v * market.unit : null;
  const exchangeTime = (value: unknown): number | null => { const t = num(value); return Number.isFinite(t) && t > 0 ? t : null; };
  if (venue === 'binance') return coins(num(at(await get(`https://fapi.binance.com/fapi/v1/openInterest?symbol=${market.symbol}`), 'openInterest')));
  if (venue === 'hyperliquid') {
    const result = await get('https://api.hyperliquid.xyz/info', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ type: 'metaAndAssetCtxs' }) });
    const universe = list(at(result, 0, 'universe')), index = universe.findIndex(u => at(u, 'name') === market.symbol);
    return index >= 0 ? coins(num(at(result, 1, index, 'openInterest'))) : null;
  }
  if (venue === 'bybit') {
    const answer = await get(`https://api.bybit.com/v5/market/tickers?category=${market.inverse ? 'inverse' : 'linear'}&symbol=${market.symbol}`);
    const ticker = at(answer, 'result', 'list', 0);
    const sourceTimestamp = exchangeTime(at(answer, 'time'));
    const stamped = sourceTimestamp === null ? {} : { sourceTimestamp };
    // One side, as every other venue reports (Bybit's `openInterest` counts both: `singleOpenInterest` is half of it).
    if (!market.inverse) { const base = coins(bybitSingle(ticker, 'openInterest')); return base === null ? null : { base, ...stamped }; }
    // An inverse perpetual: open interest in USD, and its value in coins at the mark of the moment.
    const usd = bybitSingle(ticker, 'openInterest'), base = coins(bybitSingle(ticker, 'openInterestValue'));
    return base !== null && usd > 0 ? { base, quote: usd * market.unit, ...stamped } : null;
  }
  if (venue === 'okx') {
    const answer = await get(`https://www.okx.com/api/v5/public/open-interest?instType=SWAP&instId=${market.symbol}`);
    const sourceTimestamp = exchangeTime(at(answer, 'data', 0, 'ts'));
    const base = coins(num(at(answer, 'data', 0, 'oiCcy')));
    return base === null ? null : { base, ...(sourceTimestamp === null ? {} : { sourceTimestamp }) };
  }
  if (venue === 'bitget') return coins(num(at(await get(`https://api.bitget.com/api/v2/mix/market/open-interest?symbol=${market.symbol}&productType=usdt-futures`), 'data', 'openInterestList', 0, 'size')));
  if (venue === 'deribit') {
    const summary = at(await get(`https://www.deribit.com/api/v2/public/get_book_summary_by_instrument?instrument_name=${market.symbol}`), 'result', 0);
    // A coin-margined perpetual counts open interest in USD: coins at the mark of the moment, not at a price read later.
    const oi = num(at(summary, 'open_interest')), mark = num(at(summary, 'mark_price'));
    if (!market.inverse) return coins(oi);
    const base = mark > 0 ? coins(oi / mark) : null;
    return base !== null && oi > 0 ? { base, quote: oi * market.unit } : null;
  }
  return null;
}

/** Stored bars plus live samples as display-timeframe bars, as the server's `/api/v2/oi` answers. */
export function oiBars(stored: readonly OiRow[], live: readonly OiRow[], tfMs: number): OiBar[] {
  return aggregateOi(withLiveOi(stored, live), tfMs);
}

export { HOUR, DAY, MINUTE };
