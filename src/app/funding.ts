import { webGet, type Fetcher } from '../shared/history.ts';
import type { Listing } from '../shared/coins.ts';

/**
 * Funding and premium of a coin's perpetual on one venue, read by the page itself (every venue here answers a browser: checked 2026-11-07),
 * for the Funding pane. Funding is what longs pay shorts (or the other way) each interval; it is made of the premium, how far the perpetual's
 * price sits from its index, plus a clamp that holds it at a base rate while the premium stays near it: on Hyperliquid, Binance, Bybit, OKX
 * and Bitget the rate per eight hours is the premium plus clamp(0.01 % − premium, −0.05 %, +0.05 %), so it stays at 0.01 % while the premium
 * moves between −0.04 % and +0.06 %. Deribit's funding is continuous and has no base rate; its band is not drawn (its dampener was not
 * checked). Every rate is put per eight hours, so the base and its band are the same on every venue that has them: Hyperliquid settles each
 * hour (×8), the others mostly every eight hours, some every four, two or one.
 *
 * Research OIF-1 (2026-11-06, every Hyperliquid trade, BTC and ETH): hour by hour within a day, Hyperliquid's funding moved with the share of new
 * positions that buyers opened at market (Spearman +0.21 / +0.23 on ETH / BTC over 30 days each, +0.59 / +0.69 over days), and its premium
 * with it (+0.24 / +0.34: more than funding on BTC, alike on ETH); funding sat at its base rate in 66 % (ETH) and 75 % (BTC) of the hours.
 * Context, not a signal: whether either says where price goes was not tested.
 */

export type FundingVenue = 'hyperliquid' | 'binance' | 'bybit' | 'okx' | 'bitget' | 'deribit';
/** The venues the pane offers, in its menu's order (Hyperliquid first: the one whose link to who opened was measured). */
export const FUNDING_VENUES: readonly FundingVenue[] = ['hyperliquid', 'binance', 'bybit', 'okx', 'bitget', 'deribit'];
export const isFundingVenue = (v: unknown): v is FundingVenue => typeof v === 'string' && (FUNDING_VENUES as readonly string[]).includes(v);
/** The venue the pane shows: the one picked where it lists the coin, else Hyperliquid, else the first that does; null where none does. */
export function fundingVenueOf(picked: FundingVenue | '', listed: (v: FundingVenue) => boolean): FundingVenue | null {
  if (picked && listed(picked)) return picked;
  return FUNDING_VENUES.find(listed) ?? null;
}

/** One settled funding, at `t`, over the `hours` before it: `rate` per its own interval, `per8h` the same per eight hours. */
export interface FundingRow { t: number; rate: number; per8h: number; hours: number }
/** The premium (a fraction of the index price) over the stretch from `t`, as the venue publishes it per candle (or per hour). */
export interface PremiumRow { t: number; p: number }
/** The funding accruing now: its rate (as a row's), when it settles (null: continuously), and the premium now where the venue says it. */
export interface FundingNow { rate: number; per8h: number; hours: number; next: number | null; premium: number | null }
/** The share of an hour's new positions that buyers opened at market (null when nothing opened). */
export const buyerShare = (h: { longOpened: number; shortOpened: number }): number | null => h.longOpened + h.shortOpened > 0 ? h.longOpened / (h.longOpened + h.shortOpened) : null;

/** A venue's base rate and how far the premium can move from it while funding stays there (both per eight hours, fractions; 0: no band). */
export function fundingBase(venue: FundingVenue): { base: number; clamp: number } {
  return venue === 'deribit' ? { base: 0, clamp: 0 } : { base: 0.0001, clamp: 0.0005 };
}
/** Whether the venue publishes its premium as a history the pane can draw as a line (the others: funding steps only). */
export const hasPremium = (venue: FundingVenue): boolean => venue === 'hyperliquid' || venue === 'binance' || venue === 'bybit';

const HOUR = 3_600_000;
/** At most this many pages one read asks for (a venue that keeps answering cannot loop). */
const PAGES = 8;
/** Binance's funding page read back from an `endTime`: it answers at most this many, whatever `limit` asks. */
const BINANCE_FUNDING_PAGE = 500;
const num = (value: unknown): number => Number(value);
const at = (value: unknown, ...path: (string | number)[]): unknown => path.reduce<unknown>((v, key) => (v !== null && typeof v === 'object' ? (v as Record<string | number, unknown>)[key] : undefined), value);
const POST = (body: unknown) => ({ method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
/**
 * The list an answer holds at `path`, or a failed read where it holds none or says it failed (`ok`): a venue's error sent with HTTP 200 (Bybit's
 * `retCode`, OKX's `code`, Bitget's `code`) must not read as a stretch with no funding, held as read.
 */
function listOf(answer: unknown, ok: boolean, venue: string, ...path: (string | number)[]): unknown[] {
  const got = path.length ? at(answer, ...path) : answer;
  if (!ok || !Array.isArray(got)) throw new Error(`${venue}-no-funding`);
  return got;
}
const bybitOk = (a: unknown): boolean => at(a, 'retCode') === undefined || num(at(a, 'retCode')) === 0;
const okxOk = (a: unknown): boolean => at(a, 'code') === undefined || String(at(a, 'code')) === '0';
const bitgetOk = (a: unknown): boolean => at(a, 'code') === undefined || String(at(a, 'code')) === '00000';
/** A settlement stamped a few milliseconds past its time (Hyperliquid's, Binance's) is put on the minute. */
const onMinute = (t: number): number => Math.round(t / 60_000) * 60_000;
const row = (t: number, rate: number, hours: number): FundingRow | null => Number.isFinite(t) && t > 0 && Number.isFinite(rate) && hours > 0 ? { t: onMinute(t), rate, per8h: rate * 8 / hours, hours } : null;
/** The intervals a settlement can have, in hours. */
const INTERVALS: readonly number[] = [1, 2, 4, 8];
/**
 * Settlements with each its own interval: the gap to the one before (or, for the first, to the one after) where that is 1, 2, 4 or 8 hours,
 * else `fallback`, the venue's interval now. A symbol's interval changes over time (Bybit's LPTUSDT settled every hour before March 2026 and
 * every four after), and its old settlements put per eight hours at today's interval read four times too low.
 */
function withIntervals(raw: readonly { t: number; rate: number }[], fallback: number): FundingRow[] {
  const sorted = [...raw].filter(r => Number.isFinite(r.t)).sort((a, b) => a.t - b.t);
  const gap = (j: number): number => { const g = j > 0 && j < sorted.length ? Math.round((sorted[j]!.t - sorted[j - 1]!.t) / HOUR) : 0; return INTERVALS.includes(g) ? g : 0; };
  return sorted.flatMap((r, i) => { const one = row(r.t, r.rate, gap(i) || gap(i + 1) || fallback); return one ? [one] : []; });
}

/**
 * Each venue's own interval for a symbol, in hours, read once: Binance lists only the symbols it changed (its whole list read once for every
 * symbol), Bybit and Bitget say per symbol. A read that fails is not held, and fails the funding read with it: taken for eight hours, a
 * symbol settling every four would be put per eight hours at half its rate.
 */
const intervals = new Map<string, Promise<number>>();
let binanceIntervals: Promise<Map<string, number>> | null = null;
function intervalOf(venue: FundingVenue, symbol: string, get: Fetcher): Promise<number> {
  if (venue === 'hyperliquid' || venue === 'deribit') return Promise.resolve(1);
  if (venue === 'okx') return Promise.resolve(8);
  const key = `${venue}|${symbol}`, held = intervals.get(key);
  if (held) return held;
  const read = (async (): Promise<number> => {
    if (venue === 'binance') {
      const list = binanceIntervals ??= get('https://fapi.binance.com/fapi/v1/fundingInfo').then(a => new Map(listOf(a, true, venue).map(r => [String(at(r, 'symbol')), num(at(r, 'fundingIntervalHours'))] as const)));
      list.catch(() => { binanceIntervals = null; });
      return (await list).get(symbol) || 8;
    }
    if (venue === 'bybit') { const a = await get(`https://api.bybit.com/v5/market/instruments-info?category=linear&symbol=${symbol}`); return num(at(listOf(a, bybitOk(a), venue, 'result', 'list')[0], 'fundingInterval')) / 60 || 8; }
    const a = await get(`https://api.bitget.com/api/v2/mix/market/current-fund-rate?symbol=${symbol}&productType=usdt-futures`);
    return num(at(listOf(a, bitgetOk(a), venue, 'data')[0], 'fundingRateInterval')) || 8;
  })();
  intervals.set(key, read);
  read.catch(() => { if (intervals.get(key) === read) intervals.delete(key); });
  return read;
}

/**
 * A venue's settled funding over [from, to], oldest first, for Hyperliquid its premium each hour too (its funding record carries the hour's
 * premium), and `from`: how far back the read really reached. At most `PAGES` pages: Hyperliquid, paged forward, is read from as far back as
 * those pages reach from `to` (an hour a record), so the newest are never left out; the others, paged back from `to`, stop where their pages
 * end. What is held is then held whole, never claimed further back than it was read.
 */
export async function readFunding(venue: FundingVenue, listing: Listing, from: number, to: number, get: Fetcher = webGet): Promise<{ rows: FundingRow[]; premium: PremiumRow[]; from: number }> {
  const s = listing.symbol, rows = new Map<number, FundingRow>(), premium: PremiumRow[] = [];
  const take = (r: FundingRow | null): void => { if (r && r.t >= from - 8 * HOUR && r.t <= to + HOUR) rows.set(r.t, r); };
  // The venues whose interval can change: their settlements are gathered first, each then given its own interval (`withIntervals`).
  const raw: { t: number; rate: number }[] = [];
  let reached = from, fallback = 8;
  if (venue === 'hyperliquid') {
    // Oldest first, 500 hours a page: each next page starts after the newest of the last. The record at the top of an hour settles the hour before it.
    reached = Math.max(from, to - PAGES * 500 * HOUR);
    for (let start = reached, page = 0; page < PAGES && start < to; page++) {
      const got = listOf(await get('https://api.hyperliquid.xyz/info', POST({ type: 'fundingHistory', coin: s, startTime: Math.floor(start), endTime: Math.ceil(to) })), true, venue);
      let newest = -Infinity;
      for (const r of got) {
        const t = num(at(r, 'time')), one = row(t, num(at(r, 'fundingRate')), 1), p = num(at(r, 'premium'));
        take(one); if (one && Number.isFinite(p)) premium.push({ t: one.t - HOUR, p }); if (t > newest) newest = t;
      }
      if (got.length < 500 || !Number.isFinite(newest)) break;
      start = newest + 1;
    }
  } else if (venue === 'binance') {
    // `endTime` alone answers the settlements before it, at most 500 whatever `limit` says (checked 2026-11-07: a limit of 1,000 answers 500):
    // paged back from `to`, so the newest are always read whatever the symbol's interval was over its history; a page short of 500 is the start
    // of its history.
    fallback = await intervalOf(venue, s, get);
    let end = to;
    for (let page = 0; page < PAGES && end > from; page++) {
      const got = listOf(await get(`https://fapi.binance.com/fapi/v1/fundingRate?symbol=${s}&endTime=${Math.floor(end)}&limit=${BINANCE_FUNDING_PAGE}`), true, venue);
      let oldest = Infinity;
      for (const r of got) { const t = num(at(r, 'fundingTime')); raw.push({ t, rate: num(at(r, 'fundingRate')) }); if (t < oldest) oldest = t; }
      if (got.length < BINANCE_FUNDING_PAGE || !Number.isFinite(oldest) || oldest <= from) { end = from; break; }
      end = oldest - 1;
    }
    reached = Math.max(from, end);
  } else if (venue === 'bybit') {
    fallback = await intervalOf(venue, s, get);
    let end = to, page = 0;
    for (; page < PAGES && end > from; page++) {
      const a = await get(`https://api.bybit.com/v5/market/funding/history?category=linear&symbol=${s}&endTime=${Math.floor(end)}&limit=200`);
      const got = listOf(a, bybitOk(a), venue, 'result', 'list');
      let oldest = Infinity;
      for (const r of got) { const t = num(at(r, 'fundingRateTimestamp')); raw.push({ t, rate: num(at(r, 'fundingRate')) }); if (t < oldest) oldest = t; }
      if (got.length < 200 || !Number.isFinite(oldest) || oldest <= from) { end = from; break; }
      end = oldest - 1;
    }
    reached = Math.max(from, end);
  } else if (venue === 'okx') {
    // Newest first, 100 a page; `after` asks for older than a time. Its interval is read from the gaps between settlements alone.
    let after = to + 1;
    for (let page = 0; page < PAGES && after > from; page++) {
      const a = await get(`https://www.okx.com/api/v5/public/funding-rate-history?instId=${s}&limit=100&after=${Math.floor(after)}`);
      const got = listOf(a, okxOk(a), venue, 'data');
      let oldest = Infinity;
      for (const r of got) { const t = num(at(r, 'fundingTime')), rate = num(at(r, 'realizedRate') ?? at(r, 'fundingRate')); if (Number.isFinite(t)) { raw.push({ t, rate }); if (t < oldest) oldest = t; } }
      if (got.length < 100 || !Number.isFinite(oldest) || oldest <= from) { after = from; break; }
      after = oldest;
    }
    reached = Math.max(from, after);
  } else if (venue === 'bitget') {
    // Newest first, a page at a time by number.
    fallback = await intervalOf(venue, s, get);
    let oldestRead = to;
    for (let page = 1; page <= PAGES; page++) {
      const a = await get(`https://api.bitget.com/api/v2/mix/market/history-fund-rate?symbol=${s}&productType=usdt-futures&pageSize=100&pageNo=${page}`);
      const got = listOf(a, bitgetOk(a), venue, 'data');
      let oldest = Infinity;
      for (const r of got) { const t = num(at(r, 'fundingTime')); raw.push({ t, rate: num(at(r, 'fundingRate')) }); if (t < oldest) oldest = t; }
      if (got.length < 100 || !(oldest > from)) { oldestRead = from; break; }
      oldestRead = oldest;
    }
    reached = Math.max(from, oldestRead);
  } else if (venue === 'deribit') {
    // Continuous funding: each hour's record holds the eight-hour rate at that hour (`interest_8h`) and what the hour paid (`interest_1h`).
    let end = to;
    for (let page = 0; page < PAGES && end > from; page++) {
      const start = Math.max(from, end - 30 * 24 * HOUR);
      const got = listOf(await get(`https://www.deribit.com/api/v2/public/get_funding_rate_history?instrument_name=${s}&start_timestamp=${Math.floor(start)}&end_timestamp=${Math.floor(end)}`), true, venue, 'result');
      for (const r of got) { const t = num(at(r, 'timestamp')), per8h = num(at(r, 'interest_8h')), rate = num(at(r, 'interest_1h')); if (Number.isFinite(t) && Number.isFinite(per8h)) take({ t: onMinute(t), rate: Number.isFinite(rate) ? rate : per8h / 8, per8h, hours: 1 }); }
      end = start - 1;
    }
    reached = Math.max(from, end);
  }
  for (const r of withIntervals(raw, fallback)) take(r);
  return { rows: [...rows.values()].sort((a, b) => a.t - b.t), premium: premium.sort((a, b) => a.t - b.t), from: reached };
}

/** The candle lengths each venue's premium history comes in, by the chart's timeframe. */
const BINANCE_PREMIUM: Readonly<Record<number, string>> = { 60_000: '1m', 300_000: '5m', 900_000: '15m', 1_800_000: '30m', 3_600_000: '1h', 14_400_000: '4h', 86_400_000: '1d' };
const BYBIT_PREMIUM: Readonly<Record<number, string>> = { 60_000: '1', 300_000: '5', 900_000: '15', 1_800_000: '30', 3_600_000: '60', 14_400_000: '240', 86_400_000: 'D' };

/**
 * Candles a premium page asks for at most. Binance weighs a page by the `limit` it asks (1 up to 100 candles, 2 up to 500, 5 up to 1,000, 10
 * above, measured 2026-11-07: a page of 1,000 costs less a candle than one of 1,500), and Bybit answers 1,000 at most.
 */
const PREMIUM_PAGE = 1000;
/**
 * Pages a premium read takes at most: a page more than a read asks for (`PREMIUM_CANDLES`), so a window a few candles past it (the margins and
 * the candle or two it shares with what is held) is read whole. Binance pages from the far end: cut short, a read stopped short of the end it
 * shares with what is held and replaced it instead of joining it (review round 6).
 */
const PREMIUM_PAGES = PAGES + 1;

/**
 * Binance's or Bybit's premium index per candle of `tfMs` over [from, to] (a candle starting at either end counted), oldest first (the candle's
 * close), at most `PREMIUM_PAGES` pages, and the stretch the read really covered (`from`, `to`): where its pages ran out first it ends there,
 * never claiming the rest. Each page asks for the candles the stretch left holds and no more (a page short of them, or one holding the last
 * candle there can be, ends the read), and a page after the first that fails ends the read where the pages before it did, what they read kept
 * and `cut` set, so the caller still waits before asking again (review round 5: a narrow view dragged fast asked Binance for 1,500 at a time,
 * and one failed page threw away the pages before it; round 6: a read cut that way was taken for a success and asked again at once).
 */
export async function readPremium(venue: FundingVenue, listing: Listing, tfMs: number, from: number, to: number, get: Fetcher = webGet): Promise<{ rows: PremiumRow[]; from: number; to: number; cut: boolean }> {
  const s = listing.symbol, out = new Map<number, number>();
  const candles = (a: number, b: number): number => Math.max(1, Math.min(PREMIUM_PAGE, Math.floor(b / tfMs) - Math.ceil(a / tfMs) + 1));
  let cut = false;
  const page = async (n: number, url: string, list: (answer: unknown) => unknown[]): Promise<unknown[] | null> => {
    try { return list(await get(url)); } catch (error) { if (n === 0) throw error; cut = true; return null; }
  };
  let lo = from, hi = to;
  if (venue === 'binance' && BINANCE_PREMIUM[tfMs]) {
    // Oldest first from `startTime`, as its candles are: pages that run out end the stretch at their newest candle.
    let start = from;
    for (let n = 0; n < PREMIUM_PAGES && start < to; n++) {
      const limit = candles(start, to);
      const got = await page(n, `https://fapi.binance.com/fapi/v1/premiumIndexKlines?symbol=${s}&interval=${BINANCE_PREMIUM[tfMs]}&startTime=${Math.floor(start)}&endTime=${Math.floor(to)}&limit=${limit}`, a => listOf(a, true, venue));
      if (!got) break;
      let newest = -Infinity;
      for (const r of got) { const t = num(at(r, 0)), p = num(at(r, 4)); if (Number.isFinite(t) && Number.isFinite(p)) { out.set(t, p); if (t > newest) newest = t; } }
      if (got.length < limit || !Number.isFinite(newest) || newest + tfMs > to) { start = to; break; }
      start = newest + 1;
    }
    if (start < to) hi = start;
  } else if (venue === 'bybit' && BYBIT_PREMIUM[tfMs]) {
    // Newest first: pages that run out end the stretch at their oldest candle.
    let end = to;
    for (let n = 0; n < PREMIUM_PAGES && end > from; n++) {
      const limit = candles(from, end);
      const got = await page(n, `https://api.bybit.com/v5/market/premium-index-price-kline?category=linear&symbol=${s}&interval=${BYBIT_PREMIUM[tfMs]}&start=${Math.floor(from)}&end=${Math.floor(end)}&limit=${limit}`, a => listOf(a, bybitOk(a), venue, 'result', 'list'));
      if (!got) break;
      let oldest = Infinity;
      for (const r of got) { const t = num(at(r, 0)), p = num(at(r, 4)); if (Number.isFinite(t) && Number.isFinite(p)) { out.set(t, p); if (t < oldest) oldest = t; } }
      if (got.length < limit || !Number.isFinite(oldest) || oldest - tfMs < from) { end = from; break; }
      end = oldest - 1;
    }
    if (end > from) lo = end;
  }
  return { rows: [...out].map(([t, p]) => ({ t, p })).sort((a, b) => a.t - b.t), from: lo, to: hi, cut };
}

/** The funding accruing now on a venue, when it settles and the premium now (null where the venue would not say). */
export async function readFundingNow(venue: FundingVenue, listing: Listing, get: Fetcher = webGet, now = Date.now()): Promise<FundingNow | null> {
  const s = listing.symbol, make = (rate: number, hours: number, next: number | null, premium: number | null): FundingNow | null =>
    Number.isFinite(rate) && hours > 0 ? { rate, per8h: rate * 8 / hours, hours, next: next !== null && Number.isFinite(next) && next > 0 ? next : null, premium: premium !== null && Number.isFinite(premium) ? premium : null } : null;
  if (venue === 'hyperliquid') {
    const answer = await get('https://api.hyperliquid.xyz/info', POST({ type: 'metaAndAssetCtxs' }));
    const universe = at(answer, 0, 'universe'), i = Array.isArray(universe) ? universe.findIndex(u => at(u, 'name') === s) : -1;
    return i < 0 ? null : make(num(at(answer, 1, i, 'funding')), 1, (Math.floor(now / HOUR) + 1) * HOUR, num(at(answer, 1, i, 'premium')));
  }
  if (venue === 'binance') { const a = await get(`https://fapi.binance.com/fapi/v1/premiumIndex?symbol=${s}`); return make(num(at(a, 'lastFundingRate')), await intervalOf(venue, s, get), num(at(a, 'nextFundingTime')), null); }
  if (venue === 'bybit') { const a = await get(`https://api.bybit.com/v5/market/tickers?category=linear&symbol=${s}`); const r = listOf(a, bybitOk(a), venue, 'result', 'list')[0]; return make(num(at(r, 'fundingRate')), await intervalOf(venue, s, get), num(at(r, 'nextFundingTime')), null); }
  if (venue === 'okx') {
    const a = await get(`https://www.okx.com/api/v5/public/funding-rate?instId=${s}`), r = listOf(a, okxOk(a), venue, 'data')[0], next = num(at(r, 'fundingTime')), before = num(at(r, 'prevFundingTime'));
    return make(num(at(r, 'fundingRate')), next > before && before > 0 ? Math.round((next - before) / HOUR) || 8 : 8, next, num(at(r, 'premium')));
  }
  if (venue === 'bitget') { const a = await get(`https://api.bitget.com/api/v2/mix/market/current-fund-rate?symbol=${s}&productType=usdt-futures`); const r = listOf(a, bitgetOk(a), venue, 'data')[0]; return make(num(at(r, 'fundingRate')), num(at(r, 'fundingRateInterval')) || 8, num(at(r, 'nextUpdate')), null); }
  return null;
}

/**
 * What the pane draws of one venue: its settled funding and premium (oldest first), the premium's candle length, the funding now, and whether
 * it is still being read for the first time or its read failed with nothing held (asked again a minute later).
 */
export interface FundingView { venue: FundingVenue; rows: readonly FundingRow[]; premium: readonly PremiumRow[]; premiumMs: number; now: FundingNow | null; loading: boolean; failed: boolean }

/** How often the newest funding, the premium and the funding now are read again. */
const ROWS_FRESH_MS = 10 * 60_000, PREMIUM_FRESH_MS = 60_000, NOW_FRESH_MS = 30_000, RETRY_MS = 60_000;
/** After a settlement is due, its record is looked for this long after it, then again this often until it comes (for at most ROWS_FRESH_MS). */
const SETTLED_AFTER_MS = 15_000;
const DAY = 24 * HOUR;
/** How far back a venue's funding is read at most (a read itself never claims further back than its pages reached: `readFunding`'s `from`). */
const MAX_BACK_MS: Readonly<Record<FundingVenue, number>> = { hyperliquid: 150 * DAY, binance: 1000 * DAY, bybit: 500 * DAY, okx: 250 * DAY, bitget: 250 * DAY, deribit: 230 * DAY };
/** How many candles of premium one read asks for at most (`PAGES` pages; its pages hold one more, `PREMIUM_PAGES`). */
const PREMIUM_CANDLES = PAGES * PREMIUM_PAGE;
/** How many are held per timeframe at most: the view's own and one read's worth each side of them. */
const PREMIUM_HELD = 3 * PREMIUM_CANDLES;
/**
 * How much more than the view a read asks for on each side, as a share of the view: a view dragged along asks again only past it. A premium
 * read next to what is held asks a page's worth at least (review round 5: a narrow view dragged fast asked again every few candles, about 78 of
 * Binance's weight a second); a view's first read keeps to half a view (round 6: a jump to a narrow view read twenty or thirty times its candles).
 */
const LOOK_AHEAD = 0.5;

/**
 * The funding and premium the Funding pane shows, held per venue and symbol (premium per timeframe too), read as the view needs them: further
 * back when it moves back (half a view beyond it), the newest again every few minutes and soon after a settlement is due, one read at a time
 * per kind. `onChange` is called when something lands.
 */
export class FundingSource {
  readonly #rows = new Map<string, { rows: FundingRow[]; premium: PremiumRow[]; from: number; at: number }>();
  readonly #premium = new Map<string, HeldPremium>();
  readonly #now = new Map<string, { now: FundingNow | null; at: number }>();
  readonly #busy = new Set<string>();
  readonly #failed = new Map<string, number>();
  constructor(private readonly onChange: () => void, private readonly get: Fetcher = webGet) {}

  /** What is held of `venue` for the view [t0, t1] on candles of `tfMs`, asking for what is missing or old. */
  view(venue: FundingVenue, listing: Listing, tfMs: number, t0: number, t1: number, now: number): FundingView {
    const key = `${venue}|${listing.symbol}`, held = this.#rows.get(key), span = Math.max(tfMs, t1 - t0);
    // Funding back to the view's start (a day back at least, so a step under way at its left edge is held) and always to now: read when the
    // view needs it, half a view further back than it, so a view dragged along asks again only every half a view.
    const back = (pad: number): number => Math.max(Math.min(t0 - pad, now - DAY) - 8 * HOUR, now - MAX_BACK_MS[venue]);
    const want = back(LOOK_AHEAD * span), rowsKind = `rows|${key}`;
    if (!held) this.#read(rowsKind, () => readFunding(venue, listing, want, now, this.get).then(r => { this.#rows.set(key, { rows: r.rows, premium: r.premium, from: r.from, at: now }); }));
    else if (back(0) < held.from - HOUR) {
      // Further back: a read reaching what is held, its newest left as they are.
      const reach = held.from;
      this.#read(rowsKind, () => readFunding(venue, listing, want, reach, this.get).then(r => { const h = this.#rows.get(key) ?? held; this.#rows.set(key, { rows: mergeRows(h.rows, r.rows), premium: mergeRows(h.premium, r.premium), from: Math.min(h.from, r.from), at: h.at }); }));
    } else {
      // The newest: every ROWS_FRESH_MS, and from SETTLED_AFTER_MS after the next settlement is due, every SETTLED_AFTER_MS until it is in.
      const last = held.rows[held.rows.length - 1], due = last ? last.t + last.hours * HOUR + SETTLED_AFTER_MS : Infinity;
      const settling = now >= due && now - due < ROWS_FRESH_MS && now - held.at >= SETTLED_AFTER_MS;
      if (now - held.at > ROWS_FRESH_MS || settling) {
        const from = (last?.t ?? held.from) - 2 * HOUR;
        this.#read(rowsKind, () => readFunding(venue, listing, from, now, this.get).then(r => { const h = this.#rows.get(key) ?? held; this.#rows.set(key, { rows: mergeRows(h.rows, r.rows), premium: mergeRows(h.premium, r.premium), from: h.from, at: now }); }), settling ? SETTLED_AFTER_MS : RETRY_MS);
      }
    }
    // Premium per candle where the venue publishes it (Hyperliquid's comes hourly with its funding).
    let premium: readonly PremiumRow[] = venue === 'hyperliquid' ? held?.premium ?? [] : [], premiumMs = HOUR;
    if (venue === 'binance' || venue === 'bybit') {
      premiumMs = tfMs;
      // One unbroken stretch held per timeframe, from `from` through `to` (`heldPremium`). The view's own candles count first (at most PREMIUM_CANDLES back
      // from its right edge, and the newest at least: a view wholly after now asked for a stretch ending before it began, held nothing and
      // asked again at every landing), then half a view each side out of what one read has left: padding that ate the budget left the view's
      // start unread, and every landing asked again for ever (review round 3).
      const pk = `${key}|${tfMs}`, p = this.#premium.get(pk), edge = Math.min(t1, now) + tfMs, live = t1 >= now - tfMs, ahead = Math.max(LOOK_AHEAD * span, PREMIUM_PAGE * tfMs);
      const viewLo = Math.min(edge - tfMs, Math.max(t0 - tfMs, edge - PREMIUM_CANDLES * tfMs)), spare = Math.max(0, PREMIUM_CANDLES * tfMs - (edge - viewLo));
      const padLeft = Math.min(LOOK_AHEAD * span, spare / 2), padRight = Math.min(Math.max(0, Math.min(t1 + LOOK_AHEAD * span, now) + tfMs - edge), spare - padLeft);
      // A read cut short by a failed page keeps what it read and still counts as failed, so the rest is asked a minute later, not at once. One
      // next to what is held (`next`) whose candles do not reach it leaves what is held as it is: Binance on a read to the left and Bybit on one
      // to the right page from the far end, whose first page lies in the look-ahead, and that fragment replaced the stretch drawn, which stayed
      // off the pane for the minute (review round 7). A jump's read takes the place of what is held, cut or not: that lies away from the view. So
      // does a live view's read of its newest end after a pause: on Bybit, newest first, its fragment is the live edge, worth more than the old
      // stretch (round 8); on Binance it starts where what is held ends and joins it.
      const read = (lo: number, hi: number, next: boolean): void => this.#read(`premium|${pk}`, () => readPremium(venue, listing, tfMs, lo, hi, this.get).then(r => {
        const before = this.#premium.get(pk);
        if (!(r.cut && next && before && !meets(r, before))) this.#premium.set(pk, heldPremium(before, r, tfMs, now));
        if (r.cut) throw new Error(`${venue}-premium-cut`);
      }));
      // Nothing held next to the view: its window, in place of what is held.
      if (!p || edge < p.from - tfMs || viewLo > p.to + tfMs) read(viewLo - padLeft, edge + padRight, false);
      else {
        // Next to it, only what it lacks, and half a view (a page at least) beyond the view, one read's worth at most: a view dragged along asks
        // again every half a view, one that alone fills a read too (review round 4: that one read its whole window again at every landing). A
        // view reaching now reads its newest end again once a minute.
        const budget = PREMIUM_CANDLES * tfMs, left = viewLo < p.from - tfMs, right = !live && edge > p.to + tfMs;
        if (left && right) read(viewLo - padLeft, edge + padRight, true);
        else if (left) read(Math.min(viewLo, Math.max(viewLo - ahead, p.from + tfMs - budget)), p.from + tfMs, true);
        else if (right) read(p.to - 2 * tfMs, Math.max(edge, Math.min(edge + ahead, now + tfMs, p.to - 2 * tfMs + budget)), true);
        else if (live && (now - p.at > PREMIUM_FRESH_MS || edge > p.to + tfMs)) read(Math.max(viewLo - padLeft, p.to - 2 * tfMs), now + tfMs, false);
      }
      premium = p?.rows ?? [];
    }
    // The rate under way, every NOW_FRESH_MS, and again a few seconds after it settles (the one after it is under way then), for at most
    // ROWS_FRESH_MS: a venue whose next settlement stays in the past (a paused symbol) is not asked every few seconds for ever.
    const n = this.#now.get(key), settled = !!n?.now && n.now.next !== null && n.now.next <= now && now - n.now.next < ROWS_FRESH_MS;
    if (!n || now - n.at > NOW_FRESH_MS || (settled && now - n.at > 3_000)) this.#read(`now|${key}`, () => readFundingNow(venue, listing, this.get, now).then(value => { this.#now.set(key, { now: value, at: Date.now() }); }), settled ? 5_000 : RETRY_MS);
    return { venue, rows: held?.rows ?? [], premium, premiumMs, now: n?.now ?? null, loading: !held && !this.#failed.has(rowsKind), failed: !held && this.#failed.has(rowsKind) };
  }

  /** One read of a kind at a time; a failed one is asked again `retryMs` later. */
  #read(kind: string, run: () => Promise<void>, retryMs = RETRY_MS): void {
    if (this.#busy.has(kind) || Date.now() - (this.#failed.get(kind) ?? -Infinity) < retryMs) return;
    this.#busy.add(kind);
    run().then(() => { this.#failed.delete(kind); this.onChange(); }, () => { this.#failed.set(kind, Date.now()); this.onChange(); }).finally(() => { this.#busy.delete(kind); });
  }
}

/**
 * The premium held of one venue, symbol and timeframe: one unbroken stretch from `from` through `to` (a candle starting at either end counted,
 * as a read claims it), and when its newest was read (`at`).
 */
export interface HeldPremium { rows: PremiumRow[]; from: number; to: number; at: number }
/**
 * A premium read put with what was held: joined to it where they touch, else in its place (what is held never claims the gap between them);
 * at most PREMIUM_HELD candles, the end away from what was just read let go (a view dragged a long way held all it passed). They touch only
 * where the stretches meet: a candle's slack each way joined a read that ended a candle short of what was held, the candle between claimed and
 * never read (review round 5). The reads next to what is held overlap it by a candle or two, and an end a read left where its pages ran out is a
 * millisecond off a candle's start, so no candle falls between stretches that meet.
 */
export function heldPremium(before: HeldPremium | undefined, r: { rows: PremiumRow[]; from: number; to: number }, tfMs: number, now: number): HeldPremium {
  const joins = !!before && meets(r, before);
  const held = before && joins
    ? { rows: mergeRows(before.rows, r.rows), from: Math.min(r.from, before.from), to: Math.max(r.to, before.to), at: r.to >= now ? Date.now() : before.at }
    : { rows: r.rows, from: r.from, to: r.to, at: Date.now() };
  const most = PREMIUM_HELD * tfMs;
  if (held.to - held.from <= most) return held;
  if (r.to >= held.to) { const from = held.to - most; return { ...held, rows: held.rows.filter(q => q.t >= from), from }; }
  // Through `to`, as it is claimed (round 6: a candle starting at it was let go and still claimed).
  const to = held.from + most;
  return { ...held, rows: held.rows.filter(q => q.t <= to), to };
}

/** Whether two stretches meet or overlap (both ends counted), so that held together they leave no candle between them. */
const meets = (a: { from: number; to: number }, b: { from: number; to: number }): boolean => a.from <= b.to && a.to >= b.from;

/** Rows by time, the newer read winning. */
function mergeRows<T extends { t: number }>(held: readonly T[], read: readonly T[]): T[] {
  const byT = new Map(held.map(r => [r.t, r] as const));
  for (const r of read) byT.set(r.t, r);
  return [...byT.values()].sort((a, b) => a.t - b.t);
}

/** Where `t` cuts rows held oldest first: how many come before it, or at it too with `through` (a binary search, not a pass over them all). */
export function cutAt(rows: readonly { readonly t: number }[], t: number, through = true): number {
  let lo = 0, hi = rows.length;
  while (lo < hi) { const mid = (lo + hi) >>> 1; if (through ? rows[mid]!.t <= t : rows[mid]!.t < t) lo = mid + 1; else hi = mid; }
  return lo;
}

/** The settled row whose interval holds `t` (it settles at its `t`, over the `hours` before), or null. */
export function rowAt(rows: readonly FundingRow[], t: number): FundingRow | null {
  const next = rows[cutAt(rows, t)];
  return next && next.t - next.hours * HOUR <= t ? next : null;
}
