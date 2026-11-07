import { webGet, type Fetcher } from '../shared/history.ts';
import type { Listing } from '../shared/coins.ts';

/**
 * Funding and premium of a coin's perpetual on one venue, read by the page itself (every venue here answers a browser: checked 2026-11-07),
 * for the Funding pane. Funding is what longs pay shorts (or the other way) each interval; it is made of the premium, how far the perpetual's
 * price sits from its index, plus a clamp that holds it at a base rate while the premium stays near it: on Hyperliquid, Binance, Bybit, OKX
 * and Bitget the rate per eight hours is the premium plus clamp(0.01 % − premium, −0.05 %, +0.05 %), so it stays at 0.01 % while the premium
 * moves between −0.04 % and +0.06 %; Deribit's has no base rate (0, with a ±0.05 % band). Every rate is put per eight hours, so one band is
 * the same on every venue: Hyperliquid settles each hour (×8), the others mostly every eight hours, some every four, two or one.
 *
 * Research OIF-1 (2026-11-06, every Hyperliquid trade, BTC and ETH): hour by hour within a day, Hyperliquid's funding moved with the share of new
 * positions that buyers opened at market (Spearman +0.21 / +0.23 over 30 days each, +0.59 / +0.69 over days), and its premium with it
 * (+0.24 / +0.34); it sat at its base rate in two hours of three. Context, not a signal: whether either says where price goes was not tested.
 */

export type FundingVenue = 'hyperliquid' | 'binance' | 'bybit' | 'okx' | 'bitget' | 'deribit';
/** The venues the pane offers, in its menu's order (Hyperliquid first: the one whose link to who opened was measured). */
export const FUNDING_VENUES: readonly FundingVenue[] = ['hyperliquid', 'binance', 'bybit', 'okx', 'bitget', 'deribit'];
export const isFundingVenue = (v: unknown): v is FundingVenue => typeof v === 'string' && (FUNDING_VENUES as readonly string[]).includes(v);

/** One settled funding, at `t`, over the `hours` before it: `rate` per its own interval, `per8h` the same per eight hours. */
export interface FundingRow { t: number; rate: number; per8h: number; hours: number }
/** The premium (a fraction of the index price) over the stretch from `t`, as the venue publishes it per candle (or per hour). */
export interface PremiumRow { t: number; p: number }
/** The funding accruing now: its rate (as a row's), when it settles (null: continuously), and the premium now where the venue says it. */
export interface FundingNow { rate: number; per8h: number; hours: number; next: number | null; premium: number | null }

/** A venue's base rate and how far the premium can move from it while funding stays there (both per eight hours, fractions). */
export function fundingBase(venue: FundingVenue): { base: number; clamp: number } {
  return venue === 'deribit' ? { base: 0, clamp: 0.0005 } : { base: 0.0001, clamp: 0.0005 };
}
/** Whether the venue publishes its premium as a history the pane can draw as a line (the others: funding steps only). */
export const hasPremium = (venue: FundingVenue): boolean => venue === 'hyperliquid' || venue === 'binance' || venue === 'bybit';

const HOUR = 3_600_000;
/** At most this many pages one read asks for (a venue that keeps answering cannot loop). */
const PAGES = 8;
const num = (value: unknown): number => Number(value);
const at = (value: unknown, ...path: (string | number)[]): unknown => path.reduce<unknown>((v, key) => (v !== null && typeof v === 'object' ? (v as Record<string | number, unknown>)[key] : undefined), value);
const list = (value: unknown): unknown[] => Array.isArray(value) ? value : [];
const POST = (body: unknown) => ({ method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
/** A settlement stamped a few milliseconds past its time (Hyperliquid's, Binance's) is put on the minute. */
const onMinute = (t: number): number => Math.round(t / 60_000) * 60_000;
const row = (t: number, rate: number, hours: number): FundingRow | null => Number.isFinite(t) && t > 0 && Number.isFinite(rate) && hours > 0 ? { t: onMinute(t), rate, per8h: rate * 8 / hours, hours } : null;

/** Each venue's own interval for a symbol, in hours, read once (Binance lists only the symbols it changed; Bybit and Bitget say per symbol). */
const intervals = new Map<string, Promise<number>>();
function intervalOf(venue: FundingVenue, symbol: string, get: Fetcher): Promise<number> {
  const key = `${venue}|${symbol}`, held = intervals.get(key);
  if (held) return held;
  const read = (async (): Promise<number> => {
    if (venue === 'binance') { const found = list(await get('https://fapi.binance.com/fapi/v1/fundingInfo')).find(r => at(r, 'symbol') === symbol); return num(at(found, 'fundingIntervalHours')) || 8; }
    if (venue === 'bybit') return num(at(list(at(await get(`https://api.bybit.com/v5/market/instruments-info?category=linear&symbol=${symbol}`), 'result', 'list'))[0], 'fundingInterval')) / 60 || 8;
    if (venue === 'bitget') return num(at(list(at(await get(`https://api.bitget.com/api/v2/mix/market/current-fund-rate?symbol=${symbol}&productType=usdt-futures`), 'data'))[0], 'fundingRateInterval')) || 8;
    return venue === 'hyperliquid' || venue === 'deribit' ? 1 : 8;
  })().catch(() => { intervals.delete(key); return venue === 'hyperliquid' || venue === 'deribit' ? 1 : 8; });
  intervals.set(key, read);
  return read;
}

/**
 * A venue's settled funding over [from, to], oldest first, and for Hyperliquid its premium each hour too (its funding record carries the
 * hour's premium). Read newest first a page at a time back to `from`, at most `PAGES` pages.
 */
export async function readFunding(venue: FundingVenue, listing: Listing, from: number, to: number, get: Fetcher = webGet): Promise<{ rows: FundingRow[]; premium: PremiumRow[] }> {
  const s = listing.symbol, rows = new Map<number, FundingRow>(), premium: PremiumRow[] = [];
  const take = (r: FundingRow | null): void => { if (r && r.t >= from - 8 * HOUR && r.t <= to + HOUR) rows.set(r.t, r); };
  if (venue === 'hyperliquid') {
    // Oldest first, 500 a page: each next page starts after the newest of the last. The record at the top of an hour settles the hour before it.
    for (let start = from, page = 0; page < PAGES && start < to; page++) {
      const got = list(await get('https://api.hyperliquid.xyz/info', POST({ type: 'fundingHistory', coin: s, startTime: Math.floor(start), endTime: Math.ceil(to) })));
      let newest = -Infinity;
      for (const r of got) {
        const t = num(at(r, 'time')), one = row(t, num(at(r, 'fundingRate')), 1), p = num(at(r, 'premium'));
        take(one); if (one && Number.isFinite(p)) premium.push({ t: one.t - HOUR, p }); if (t > newest) newest = t;
      }
      if (got.length < 500 || !Number.isFinite(newest)) break;
      start = newest + 1;
    }
  } else if (venue === 'binance') {
    // Oldest first from `startTime`, 1,000 a page: each next page starts after the newest of the last.
    const hours = await intervalOf(venue, s, get);
    for (let start = from, page = 0; page < PAGES && start < to; page++) {
      const got = list(await get(`https://fapi.binance.com/fapi/v1/fundingRate?symbol=${s}&startTime=${Math.floor(start)}&endTime=${Math.floor(to)}&limit=1000`));
      let newest = -Infinity;
      for (const r of got) { const t = num(at(r, 'fundingTime')); take(row(t, num(at(r, 'fundingRate')), hours)); if (t > newest) newest = t; }
      if (got.length < 1000 || !Number.isFinite(newest)) break;
      start = newest + 1;
    }
  } else if (venue === 'bybit') {
    const hours = await intervalOf(venue, s, get);
    for (let end = to, page = 0; page < PAGES && end > from; page++) {
      const got = list(at(await get(`https://api.bybit.com/v5/market/funding/history?category=linear&symbol=${s}&endTime=${Math.floor(end)}&limit=200`), 'result', 'list'));
      let oldest = Infinity;
      for (const r of got) { const t = num(at(r, 'fundingRateTimestamp')); take(row(t, num(at(r, 'fundingRate')), hours)); if (t < oldest) oldest = t; }
      if (got.length < 200 || !Number.isFinite(oldest) || oldest <= from) break;
      end = oldest - 1;
    }
  } else if (venue === 'okx') {
    // Newest first, 100 a page; `after` asks for older than a time. Its interval is read from the gaps between settlements.
    const raw: { t: number; rate: number }[] = [];
    for (let after = to + 1, page = 0; page < PAGES && after > from; page++) {
      const got = list(at(await get(`https://www.okx.com/api/v5/public/funding-rate-history?instId=${s}&limit=100&after=${Math.floor(after)}`), 'data'));
      let oldest = Infinity;
      for (const r of got) { const t = num(at(r, 'fundingTime')), rate = num(at(r, 'realizedRate') ?? at(r, 'fundingRate')); if (Number.isFinite(t)) { raw.push({ t, rate }); if (t < oldest) oldest = t; } }
      if (got.length < 100 || !Number.isFinite(oldest)) break;
      after = oldest;
    }
    raw.sort((a, b) => a.t - b.t);
    raw.forEach((r, i) => { const gap = i > 0 ? (r.t - raw[i - 1]!.t) / HOUR : raw.length > 1 ? (raw[1]!.t - r.t) / HOUR : 8; take(row(r.t, r.rate, gap > 0 && gap <= 8 ? Math.round(gap) : 8)); });
  } else if (venue === 'bitget') {
    const hours = await intervalOf(venue, s, get);
    for (let page = 1; page <= PAGES; page++) {
      const got = list(at(await get(`https://api.bitget.com/api/v2/mix/market/history-fund-rate?symbol=${s}&productType=usdt-futures&pageSize=100&pageNo=${page}`), 'data'));
      let oldest = Infinity;
      for (const r of got) { const t = num(at(r, 'fundingTime')); take(row(t, num(at(r, 'fundingRate')), hours)); if (t < oldest) oldest = t; }
      if (got.length < 100 || !(oldest > from)) break;
    }
  } else if (venue === 'deribit') {
    // Continuous funding: each hour's record holds the eight-hour rate at that hour (`interest_8h`) and what the hour paid (`interest_1h`).
    for (let end = to, page = 0; page < PAGES && end > from; page++) {
      const start = Math.max(from, end - 30 * 24 * HOUR);
      const got = list(at(await get(`https://www.deribit.com/api/v2/public/get_funding_rate_history?instrument_name=${s}&start_timestamp=${Math.floor(start)}&end_timestamp=${Math.floor(end)}`), 'result'));
      for (const r of got) { const t = num(at(r, 'timestamp')), per8h = num(at(r, 'interest_8h')), rate = num(at(r, 'interest_1h')); if (Number.isFinite(t) && Number.isFinite(per8h)) take({ t: onMinute(t), rate: Number.isFinite(rate) ? rate : per8h / 8, per8h, hours: 1 }); }
      end = start - 1;
    }
  }
  return { rows: [...rows.values()].sort((a, b) => a.t - b.t), premium: premium.sort((a, b) => a.t - b.t) };
}

/** The candle lengths each venue's premium history comes in, by the chart's timeframe. */
const BINANCE_PREMIUM: Readonly<Record<number, string>> = { 60_000: '1m', 300_000: '5m', 900_000: '15m', 1_800_000: '30m', 3_600_000: '1h', 14_400_000: '4h', 86_400_000: '1d' };
const BYBIT_PREMIUM: Readonly<Record<number, string>> = { 60_000: '1', 300_000: '5', 900_000: '15', 1_800_000: '30', 3_600_000: '60', 14_400_000: '240', 86_400_000: 'D' };

/** Binance's or Bybit's premium index per candle of `tfMs` over [from, to], oldest first (the candle's close), at most `PAGES` pages. */
export async function readPremium(venue: FundingVenue, listing: Listing, tfMs: number, from: number, to: number, get: Fetcher = webGet): Promise<PremiumRow[]> {
  const s = listing.symbol, out = new Map<number, number>();
  if (venue === 'binance' && BINANCE_PREMIUM[tfMs]) {
    // Oldest first from `startTime`, 1,500 a page, as its candles are.
    for (let start = from, page = 0; page < PAGES && start < to; page++) {
      const got = list(await get(`https://fapi.binance.com/fapi/v1/premiumIndexKlines?symbol=${s}&interval=${BINANCE_PREMIUM[tfMs]}&startTime=${Math.floor(start)}&endTime=${Math.floor(to)}&limit=1500`));
      let newest = -Infinity;
      for (const r of got) { const t = num(at(r, 0)), p = num(at(r, 4)); if (Number.isFinite(t) && Number.isFinite(p)) { out.set(t, p); if (t > newest) newest = t; } }
      if (got.length < 1500 || !Number.isFinite(newest)) break;
      start = newest + 1;
    }
  } else if (venue === 'bybit' && BYBIT_PREMIUM[tfMs]) {
    for (let end = to, page = 0; page < PAGES && end > from; page++) {
      const got = list(at(await get(`https://api.bybit.com/v5/market/premium-index-price-kline?category=linear&symbol=${s}&interval=${BYBIT_PREMIUM[tfMs]}&start=${Math.floor(from)}&end=${Math.floor(end)}&limit=1000`), 'result', 'list'));
      let oldest = Infinity;
      for (const r of got) { const t = num(at(r, 0)), p = num(at(r, 4)); if (Number.isFinite(t) && Number.isFinite(p)) { out.set(t, p); if (t < oldest) oldest = t; } }
      if (got.length < 1000 || !Number.isFinite(oldest)) break;
      end = oldest - 1;
    }
  }
  return [...out].map(([t, p]) => ({ t, p })).sort((a, b) => a.t - b.t);
}

/** The funding accruing now on a venue, when it settles and the premium now (null where the venue would not say). */
export async function readFundingNow(venue: FundingVenue, listing: Listing, get: Fetcher = webGet, now = Date.now()): Promise<FundingNow | null> {
  const s = listing.symbol, make = (rate: number, hours: number, next: number | null, premium: number | null): FundingNow | null =>
    Number.isFinite(rate) && hours > 0 ? { rate, per8h: rate * 8 / hours, hours, next: next !== null && Number.isFinite(next) && next > 0 ? next : null, premium: premium !== null && Number.isFinite(premium) ? premium : null } : null;
  if (venue === 'hyperliquid') {
    const answer = await get('https://api.hyperliquid.xyz/info', POST({ type: 'metaAndAssetCtxs' }));
    const i = list(at(answer, 0, 'universe')).findIndex(u => at(u, 'name') === s);
    return i < 0 ? null : make(num(at(answer, 1, i, 'funding')), 1, (Math.floor(now / HOUR) + 1) * HOUR, num(at(answer, 1, i, 'premium')));
  }
  if (venue === 'binance') { const a = await get(`https://fapi.binance.com/fapi/v1/premiumIndex?symbol=${s}`); return make(num(at(a, 'lastFundingRate')), await intervalOf(venue, s, get), num(at(a, 'nextFundingTime')), null); }
  if (venue === 'bybit') { const r = list(at(await get(`https://api.bybit.com/v5/market/tickers?category=linear&symbol=${s}`), 'result', 'list'))[0]; return make(num(at(r, 'fundingRate')), await intervalOf(venue, s, get), num(at(r, 'nextFundingTime')), null); }
  if (venue === 'okx') {
    const r = list(at(await get(`https://www.okx.com/api/v5/public/funding-rate?instId=${s}`), 'data'))[0], next = num(at(r, 'fundingTime')), before = num(at(r, 'prevFundingTime'));
    return make(num(at(r, 'fundingRate')), next > before && before > 0 ? Math.round((next - before) / HOUR) || 8 : 8, next, num(at(r, 'premium')));
  }
  if (venue === 'bitget') { const r = list(at(await get(`https://api.bitget.com/api/v2/mix/market/current-fund-rate?symbol=${s}&productType=usdt-futures`), 'data'))[0]; return make(num(at(r, 'fundingRate')), num(at(r, 'fundingRateInterval')) || 8, num(at(r, 'nextUpdate')), null); }
  return null;
}

/** What the pane draws of one venue: its settled funding and premium (oldest first), the premium's candle length, and the funding now. */
export interface FundingView { venue: FundingVenue; rows: readonly FundingRow[]; premium: readonly PremiumRow[]; premiumMs: number; now: FundingNow | null; loading: boolean }

/** How often the newest funding, the premium and the funding now are read again. */
const ROWS_FRESH_MS = 10 * 60_000, PREMIUM_FRESH_MS = 60_000, NOW_FRESH_MS = 30_000, RETRY_MS = 60_000;
const DAY = 24 * HOUR;
/** How far back a venue's funding is read at most: what `PAGES` of its pages hold (Hyperliquid's 500 hours a page, Bybit's 200 settlements...). */
const MAX_BACK_MS: Readonly<Record<FundingVenue, number>> = { hyperliquid: 150 * DAY, binance: 1000 * DAY, bybit: 500 * DAY, okx: 250 * DAY, bitget: 250 * DAY, deribit: 230 * DAY };
/** How many candles of premium one read covers at most (`PAGES` pages of 1,000 or more). */
const PREMIUM_CANDLES = PAGES * 1000;

/**
 * The funding and premium the Funding pane shows, held per venue and symbol (premium per timeframe too), read as the view needs them: further
 * back when it moves back, the newest again every few minutes, one read at a time per kind. `onChange` is called when something lands.
 */
export class FundingSource {
  readonly #rows = new Map<string, { rows: FundingRow[]; premium: PremiumRow[]; from: number; at: number }>();
  readonly #premium = new Map<string, { rows: PremiumRow[]; from: number; to: number; at: number }>();
  readonly #now = new Map<string, { now: FundingNow | null; at: number }>();
  readonly #busy = new Set<string>();
  readonly #failed = new Map<string, number>();
  constructor(private readonly onChange: () => void, private readonly get: Fetcher = webGet) {}

  /** What is held of `venue` for the view [t0, t1] on candles of `tfMs`, asking for what is missing or old. */
  view(venue: FundingVenue, listing: Listing, tfMs: number, t0: number, t1: number, now: number): FundingView {
    const key = `${venue}|${listing.symbol}`, held = this.#rows.get(key);
    // Funding: back to the view's start (a day before it at least, so a step under way at its left edge is held), and always to now; never
    // further back than the venue's pages reach, so what is held is held whole.
    const want = Math.max(Math.min(t0, now - DAY) - 8 * HOUR, now - MAX_BACK_MS[venue]);
    if (!held) this.#read(`rows|${key}`, () => readFunding(venue, listing, want, now, this.get).then(r => { this.#rows.set(key, { ...r, from: want, at: now }); }));
    else if (want < held.from - HOUR) this.#read(`rows|${key}`, () => readFunding(venue, listing, want, held.from, this.get).then(r => { this.#rows.set(key, merged(this.#rows.get(key) ?? held, r, want)); }));
    else if (now - held.at > ROWS_FRESH_MS) { const last = held.rows[held.rows.length - 1]?.t ?? held.from; this.#read(`rows|${key}`, () => readFunding(venue, listing, last - 2 * HOUR, now, this.get).then(r => { this.#rows.set(key, { ...merged(this.#rows.get(key) ?? held, r, held.from), at: now }); })); }
    // Premium per candle where the venue publishes it (Hyperliquid's comes hourly with its funding).
    let premium: readonly PremiumRow[] = venue === 'hyperliquid' ? held?.premium ?? [] : [], premiumMs = HOUR;
    if (venue === 'binance' || venue === 'bybit') {
      premiumMs = tfMs;
      // The view's candles, at most as many as one read holds back from its right edge; held ones are read again only at the newest end.
      const pk = `${key}|${tfMs}`, p = this.#premium.get(pk), to = Math.min(t1, now) + tfMs, from = Math.max(t0 - tfMs, to - PREMIUM_CANDLES * tfMs);
      if (!p || from < p.from - tfMs || (to > p.to && now - p.at > PREMIUM_FRESH_MS)) {
        const older = !p || from < p.from - tfMs, lo = older ? from : Math.max(from, p.to - 2 * tfMs), hi = older && p ? p.from + tfMs : Math.max(to, now);
        this.#read(`premium|${pk}`, () => readPremium(venue, listing, tfMs, lo, hi, this.get).then(rows => {
          const before = this.#premium.get(pk);
          this.#premium.set(pk, { rows: mergeRows(before?.rows ?? [], rows), from: Math.min(lo, before?.from ?? lo), to: Math.max(hi, before?.to ?? hi), at: older && before ? before.at : Date.now() });
        }));
      }
      premium = p?.rows ?? [];
    }
    const n = this.#now.get(key);
    if (!n || now - n.at > NOW_FRESH_MS) this.#read(`now|${key}`, () => readFundingNow(venue, listing, this.get, now).then(value => { this.#now.set(key, { now: value, at: Date.now() }); }));
    return { venue, rows: held?.rows ?? [], premium, premiumMs, now: n?.now ?? null, loading: !held };
  }

  /** One read of a kind at a time; a failed one is asked again a minute later. */
  #read(kind: string, run: () => Promise<void>): void {
    if (this.#busy.has(kind) || Date.now() - (this.#failed.get(kind) ?? 0) < RETRY_MS) return;
    this.#busy.add(kind);
    run().then(() => { this.#failed.delete(kind); this.onChange(); }, () => { this.#failed.set(kind, Date.now()); }).finally(() => { this.#busy.delete(kind); });
  }
}

/** Rows by time, the newer read winning. */
function mergeRows<T extends { t: number }>(held: readonly T[], read: readonly T[]): T[] {
  const byT = new Map(held.map(r => [r.t, r] as const));
  for (const r of read) byT.set(r.t, r);
  return [...byT.values()].sort((a, b) => a.t - b.t);
}
/** What was held of a venue's funding with a read put on it (from `from` on). */
function merged(held: { rows: FundingRow[]; premium: PremiumRow[]; from: number; at: number }, read: { rows: FundingRow[]; premium: PremiumRow[] }, from: number) {
  return { rows: mergeRows(held.rows, read.rows), premium: mergeRows(held.premium, read.premium), from: Math.min(from, held.from), at: held.at };
}

/** The settled row whose interval holds `t` (it settles at its `t`, over the `hours` before), or null. */
export function rowAt(rows: readonly FundingRow[], t: number): FundingRow | null {
  let lo = 0, hi = rows.length;
  while (lo < hi) { const mid = (lo + hi) >>> 1; if (rows[mid]!.t <= t) lo = mid + 1; else hi = mid; }
  const next = rows[lo];
  return next && next.t - next.hours * HOUR <= t ? next : null;
}
