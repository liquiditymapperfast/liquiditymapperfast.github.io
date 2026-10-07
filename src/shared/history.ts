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
export type Fetcher = (url: string, init?: { method?: string; headers?: Record<string, string>; body?: string }) => Promise<unknown>;

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
  page(interval: string, intervalMs: number, endMs: number, get: Fetcher, symbol: string): Promise<CandleRow[]>;
}

const row = (start: unknown, open: unknown, high: unknown, low: unknown, close: unknown, volume: unknown): CandleRow => ({ start: num(start), open: num(open), high: num(high), low: num(low), close: num(close), volume: num(volume) });

const binanceRows = (json: unknown): CandleRow[] => list(json).map(r => row(at(r, 0), at(r, 1), at(r, 2), at(r, 3), at(r, 4), at(r, 5)));
const BINANCE = { 60_000: '1m', 300_000: '5m', 900_000: '15m', 1_800_000: '30m', 3_600_000: '1h', 14_400_000: '4h', 86_400_000: '1d' } as const;

const SPECS: Readonly<Record<string, CandleSpec>> = {
  binance: { intervals: BINANCE, limit: 1500, page: async (i, _ms, end, get, symbol) => binanceRows(await get(`https://fapi.binance.com/fapi/v1/klines?symbol=${symbol}&interval=${i}&endTime=${end}&limit=1500`)) },
  binancespot: { intervals: BINANCE, limit: 1000, page: async (i, _ms, end, get, symbol) => binanceRows(await get(`https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=${i}&endTime=${end}&limit=1000`)) },
  bybit: {
    intervals: { 60_000: '1', 300_000: '5', 900_000: '15', 1_800_000: '30', 3_600_000: '60', 14_400_000: '240', 86_400_000: 'D' }, limit: 1000,
    page: async (i, _ms, end, get, symbol) => list(at(await get(`https://api.bybit.com/v5/market/kline?category=linear&symbol=${symbol}&interval=${i}&end=${end}&limit=1000`), 'result', 'list')).map(r => row(at(r, 0), at(r, 1), at(r, 2), at(r, 3), at(r, 4), at(r, 5))),
  },
  bybitspot: {
    intervals: { 60_000: '1', 300_000: '5', 900_000: '15', 1_800_000: '30', 3_600_000: '60', 14_400_000: '240', 86_400_000: 'D' }, limit: 1000,
    page: async (i, _ms, end, get, symbol) => list(at(await get(`https://api.bybit.com/v5/market/kline?category=spot&symbol=${symbol}&interval=${i}&end=${end}&limit=1000`), 'result', 'list')).map(r => row(at(r, 0), at(r, 1), at(r, 2), at(r, 3), at(r, 4), at(r, 5))),
  },
  okx: {
    intervals: { 60_000: '1m', 300_000: '5m', 900_000: '15m', 1_800_000: '30m', 3_600_000: '1H', 14_400_000: '4H', 86_400_000: '1Dutc' }, limit: 300,
    // volCcy (column 6) is in coin; the plain volume is in contracts.
    page: async (i, _ms, end, get, symbol) => list(at(await get(`https://www.okx.com/api/v5/market/history-candles?instId=${symbol}&bar=${i}&after=${end + 1}&limit=100`), 'data')).map(r => row(at(r, 0), at(r, 1), at(r, 2), at(r, 3), at(r, 4), at(r, 6))),
  },
  okxspot: {
    intervals: { 60_000: '1m', 300_000: '5m', 900_000: '15m', 1_800_000: '30m', 3_600_000: '1H', 14_400_000: '4H', 86_400_000: '1Dutc' }, limit: 300,
    // On spot the plain volume (column 5) is in coin; volCcy is in USDT.
    page: async (i, _ms, end, get, symbol) => list(at(await get(`https://www.okx.com/api/v5/market/history-candles?instId=${symbol}&bar=${i}&after=${end + 1}&limit=100`), 'data')).map(r => row(at(r, 0), at(r, 1), at(r, 2), at(r, 3), at(r, 4), at(r, 5))),
  },
  bitget: {
    intervals: { 60_000: '1m', 300_000: '5m', 900_000: '15m', 1_800_000: '30m', 3_600_000: '1H', 14_400_000: '4H', 86_400_000: '1Dutc' }, limit: 1000,
    page: async (i, _ms, end, get, symbol) => list(at(await get(`https://api.bitget.com/api/v2/mix/market/candles?symbol=${symbol}&productType=usdt-futures&granularity=${i}&endTime=${end}&limit=1000`), 'data')).map(r => row(at(r, 0), at(r, 1), at(r, 2), at(r, 3), at(r, 4), at(r, 5))),
  },
  bitgetspot: {
    // Spot names its intervals unlike futures (1min, not 1m).
    intervals: { 60_000: '1min', 300_000: '5min', 900_000: '15min', 1_800_000: '30min', 3_600_000: '1h', 14_400_000: '4h', 86_400_000: '1Dutc' }, limit: 1000,
    page: async (i, _ms, end, get, symbol) => list(at(await get(`https://api.bitget.com/api/v2/spot/market/candles?symbol=${symbol}&granularity=${i}&endTime=${end}&limit=1000`), 'data')).map(r => row(at(r, 0), at(r, 1), at(r, 2), at(r, 3), at(r, 4), at(r, 5))),
  },
  coinbase: {
    intervals: { 60_000: '60', 300_000: '300', 900_000: '900', 3_600_000: '3600', 21_600_000: '21600', 86_400_000: '86400' }, limit: 300,
    // [time in seconds, low, high, open, close, volume]
    page: async (i, ms, end, get, symbol) => list(await get(`https://api.exchange.coinbase.com/products/${symbol}/candles?granularity=${i}&start=${new Date(end - 299 * ms).toISOString()}&end=${new Date(end).toISOString()}`)).map(r => row(num(at(r, 0)) * 1000, at(r, 3), at(r, 2), at(r, 1), at(r, 4), at(r, 5))),
  },
  deribit: {
    intervals: { 60_000: '1', 300_000: '5', 900_000: '15', 1_800_000: '30', 3_600_000: '60', 86_400_000: '1D' }, limit: 1000,
    page: async (i, ms, end, get, symbol) => {
      const request = { jsonrpc: '2.0', id: 1, method: 'public/get_tradingview_chart_data', params: { instrument_name: symbol, resolution: i, start_timestamp: end - 999 * ms, end_timestamp: end } };
      const d = at(await get('wss://www.deribit.com/ws/api/v2', { method: 'RPC', headers: {}, body: JSON.stringify(request) }), 'result');
      return list(at(d, 'ticks')).map((t, k) => row(t, at(d, 'open', k), at(d, 'high', k), at(d, 'low', k), at(d, 'close', k), at(d, 'volume', k)));
    },
  },
  hyperliquid: {
    intervals: { 60_000: '1m', 300_000: '5m', 900_000: '15m', 1_800_000: '30m', 3_600_000: '1h', 14_400_000: '4h', 86_400_000: '1d' }, limit: 1000,
    page: async (i, ms, end, get, symbol) => list(await get('https://api.hyperliquid.xyz/info', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ type: 'candleSnapshot', req: { coin: symbol, interval: i, startTime: end - 999 * ms, endTime: end } }) }))
      .map(r => row(at(r, 't'), at(r, 'o'), at(r, 'h'), at(r, 'l'), at(r, 'c'), at(r, 'v'))),
  },
};

/** The venue id of an instrument id ("binance:BTCUSDT" is "binance"). */
export const venueOf = (instrumentId: string): string => instrumentId.split(':')[0]!;
/** How a market lists the coin: what was given, else BTC's listing there. */
export type HistoryListing = Pick<Listing, 'symbol' | 'unit'>;
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
 * aggregated from a finer one) by walking back page by page from `to`. Returns [] for a venue it does not know.
 */
export async function fetchCandles(instrumentId: string, tfMs: number, from: number, to: number, get: Fetcher, listing?: HistoryListing): Promise<Candle[]> {
  const spec = SPECS[venueOf(instrumentId)], market = listingOf(venueOf(instrumentId), listing);
  const native = spec ? nativeInterval(spec, tfMs) : null;
  if (!spec || !market || native === null) return [];
  const interval = spec.intervals[native]!;
  const rows = new Map<number, CandleRow>();
  let end = to;
  // Enough pages for the window, with a ceiling so a misbehaving endpoint cannot loop.
  for (let pages = 0; pages < 12 && end > from; pages++) {
    const got = (await spec.page(interval, native, end, get, market.symbol)).filter(r => Number.isFinite(r.start) && Number.isFinite(r.open) && Number.isFinite(r.close));
    if (!got.length) break;
    let oldest = Infinity;
    for (const r of got) { rows.set(r.start, r); oldest = Math.min(oldest, r.start); }
    if (oldest >= end) break;
    end = oldest - 1;
  }
  const u = market.unit, kept = [...rows.values()].filter(r => r.start >= from - tfMs && r.start <= to);
  return aggregateCandles(u === 1 ? kept : kept.map(r => ({ ...r, open: r.open / u, high: r.high / u, low: r.low / u, close: r.close / u, ...(r.volume === undefined ? {} : { volume: r.volume * u }) })), tfMs);
}

/** Venues with an open-interest history this module can read. */
export const OI_VENUES: readonly string[] = ['binance'];
/** Venues whose live open interest can be sampled (Hyperliquid has no history, so its bars build up while the page is open). */
export const OI_SAMPLE_VENUES: readonly string[] = ['binance', 'hyperliquid'];

/** Open-interest periods Binance serves, in ms. */
const BINANCE_OI_PERIODS: Readonly<Record<number, string>> = { 300_000: '5m', 900_000: '15m', 1_800_000: '30m', 3_600_000: '1h', 14_400_000: '4h', 86_400_000: '1d' };

/** Binance perpetual open interest in coins per bucket (its public history is five minutes at the finest and thirty days deep). */
export async function fetchOiHistory(instrumentId: string, tfMs: number, from: number, to: number, get: Fetcher, listing?: HistoryListing): Promise<OiRow[]> {
  const market = listingOf('binance', listing);
  if (venueOf(instrumentId) !== 'binance' || !market) return [];
  const period = nativeInterval({ intervals: BINANCE_OI_PERIODS }, Math.max(tfMs, 300_000)) ?? 300_000;
  const url = `https://fapi.binance.com/futures/data/openInterestHist?symbol=${market.symbol}&period=${BINANCE_OI_PERIODS[period]}&limit=500&endTime=${to}`;
  const rows: OiRow[] = [];
  for (const r of list(await get(url))) {
    const t = num(at(r, 'timestamp')), c = num(at(r, 'sumOpenInterest')) * market.unit;
    if (Number.isFinite(t) && Number.isFinite(c) && t >= from - tfMs) rows.push({ start: t, open: c, high: c, low: c, close: c });
  }
  return rows;
}

/** Live open-interest readings, in coins, from the venues that publish one: Binance by REST, Hyperliquid with its asset contexts. */
export async function fetchOiSample(venue: string, get: Fetcher, listing?: HistoryListing): Promise<number | null> {
  const market = listingOf(venue, listing); if (!market) return null;
  if (venue === 'binance') { const v = num(at(await get(`https://fapi.binance.com/fapi/v1/openInterest?symbol=${market.symbol}`), 'openInterest')); return v > 0 ? v * market.unit : null; }
  if (venue === 'hyperliquid') {
    const result = await get('https://api.hyperliquid.xyz/info', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ type: 'metaAndAssetCtxs' }) });
    const universe = list(at(result, 0, 'universe')), index = universe.findIndex(u => at(u, 'name') === market.symbol);
    const v = num(at(result, 1, index, 'openInterest'));
    return index >= 0 && v > 0 ? v * market.unit : null;
  }
  return null;
}

/** Stored bars plus live samples as display-timeframe bars, as the server's `/api/v2/oi` answers. */
export function oiBars(stored: readonly OiRow[], live: readonly OiRow[], tfMs: number): OiBar[] {
  return aggregateOi(withLiveOi(stored, live), tfMs);
}

export { HOUR, DAY, MINUTE };
