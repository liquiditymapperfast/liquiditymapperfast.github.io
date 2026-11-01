/**
 * Liquidation levels (the Chart deck's Liq levels): the prices that would liquidate Hyperliquid's open BTC positions, read from the levels
 * service (HyperLiquidMap_Levels, format 2: HyperTracker's position snapshots, about one every 29 minutes, binned per $10). They are drawn as
 * a stripe right of the live edge, beside the profile column, which adds them up. From the time the positions describe (about 35 minutes
 * before HyperTracker stamps its snapshot) a level is taken away as Hyperliquid's price trades through it: Hyperliquid's 1-minute candles say how far and
 * when, and the chart's own price says it at once (a trade low can reach a few basis points past the mark price liquidations use, so a
 * level can go a little early in a fast fall).
 */
import { BTC, instrumentIdFor, type Coin } from '../shared/coins.ts';
import { webGet, type Fetcher } from '../shared/history.ts';
import { KeyLevelHistory, type HistoryTarget } from './keylevels/history.ts';
import { liqLevelsUrl } from './liq-url.ts';
import type { AppState, CandleRow } from './store.ts';
import type { View } from './view.ts';

const MINUTE = 60_000, HOUR = 3_600_000, DAY = 24 * HOUR;
/** How often the file is asked again (a new snapshot comes about every 29 minutes; the edge keeps the file for a minute). */
const REFRESH_MS = 60_000;
const RETRY_MS = 30_000;
/** Older than this, the levels are not drawn: too many positions have opened and closed since. */
export const STALE_MS = 3 * HOUR;
/** Hyperliquid's candles are asked again this often; the chart's own price covers the time between. */
const CANDLES_MS = 60_000;
/** Candles last read longer ago than this no longer vouch for what price has traded through. */
const CANDLES_LATE_MS = 5 * MINUTE;
/** The chart's price may be another venue's: it takes a level only this far past it (5 bp, at least one bin). */
const SEEN_MARGIN = 0.0005;
const MAX_BINS = 40_000;

/** One snapshot's levels, bins sorted by price: bin `k[i]` covers prices [k*step, (k+1)*step). */
export interface LiqLevels {
  coin: string;
  /** The time the positions describe: HyperTracker's snapshot time less its measured delay. */
  asOf: number;
  /** When HyperTracker stamped the snapshot, and when the service read it. */
  createdAt: number;
  fetchedAt: number;
  /** The snapshot's own mark (value over size of every position). */
  mark: number;
  step: number;
  positions: number;
  attribution: string;
  k: Int32Array;
  longIso: Float64Array; longCross: Float64Array; shortIso: Float64Array; shortCross: Float64Array;
  longWallets: Uint32Array; shortWallets: Uint32Array;
  /** The largest single position of each side in the bin: a wallet holds one position of a coin, so it is one wallet's. */
  longTop: Float64Array; shortTop: Float64Array;
}

const finite = (v: unknown, min = 0, max = Number.MAX_VALUE): v is number => typeof v === 'number' && Number.isFinite(v) && v >= min && v <= max;

/**
 * The service's file, checked field by field; anything malformed is refused whole (null). Its times come from the service's clock and are
 * checked against each other, not against the visitor's, which can be off.
 */
export function parseLiqLevels(raw: unknown, coin: string): LiqLevels | null {
  if (!raw || typeof raw !== 'object') return null;
  const d = raw as Record<string, unknown>, snap = d.snapshot as Record<string, unknown> | undefined;
  if (d.v !== 2 || d.coin !== coin || !snap || typeof snap !== 'object') return null;
  const asOf = snap.asOf, createdAt = snap.createdAt, fetchedAt = snap.fetchedAt, mark = d.mark, step = d.step, positions = d.positions, bins = d.bins;
  if (!finite(asOf, Date.UTC(2024, 0, 1), Date.UTC(2100, 0, 1)) || !finite(createdAt, asOf, asOf + DAY) || !finite(fetchedAt, asOf, asOf + 7 * DAY)) return null;
  if (!finite(mark, 1e-9) || !finite(step, 1e-9, 1e6) || !finite(positions, 0, 1e8) || !Array.isArray(bins) || bins.length > MAX_BINS) return null;
  const n = bins.length, out: LiqLevels = {
    coin, asOf, createdAt, fetchedAt, mark, step, positions, attribution: typeof d.attribution === 'string' ? d.attribution.slice(0, 80) : '',
    k: new Int32Array(n), longIso: new Float64Array(n), longCross: new Float64Array(n), shortIso: new Float64Array(n), shortCross: new Float64Array(n),
    longWallets: new Uint32Array(n), shortWallets: new Uint32Array(n), longTop: new Float64Array(n), shortTop: new Float64Array(n),
  };
  let last = -Infinity;
  for (let i = 0; i < n; i++) {
    const b = bins[i];
    if (!Array.isArray(b) || b.length !== 9) return null;
    const [k, li, lc, si, sc, lw, sw, lt, st] = b as unknown[];
    if (!Number.isInteger(k) || (k as number) <= last || (k as number) * step > 1e9 || (k as number) < 0) return null;
    if (![li, lc, si, sc].every(v => finite(v, 0, 1e13)) || ![lw, sw].every(v => Number.isInteger(v) && finite(v, 0, 1e7))) return null;
    // A side's largest position is part of that side (rounding aside).
    if (!finite(lt, 0, ((li as number) + (lc as number)) * 1.01 + 1) || !finite(st, 0, ((si as number) + (sc as number)) * 1.01 + 1)) return null;
    last = k as number;
    out.k[i] = k as number; out.longIso[i] = li as number; out.longCross[i] = lc as number; out.shortIso[i] = si as number; out.shortCross[i] = sc as number;
    out.longWallets[i] = lw as number; out.shortWallets[i] = sw as number; out.longTop[i] = lt as number; out.shortTop[i] = st as number;
  }
  return out;
}

/** How far price has traded through each bin since the snapshot, for one side. NaN where it has not (yet). */
export interface Taken {
  /** When price first traded into the bin. */
  first: Float64Array;
  /** When price had traded through all of it. */
  gone: Float64Array;
  /** The share of the bin's width traded through so far (0 to 1). */
  frac: Float64Array;
}

/**
 * Prices the page saw itself (the chart's own, in dollars): the lowest and highest since the levels came, and when each was reached. The
 * first one seen stands for the whole way from the snapshot's mark, at a time not known, so it carries the snapshot's time: a level it
 * passed is not drawn at all until the candles say when it went.
 */
export interface Seen { low: number; high: number; lowAt: number; highAt: number }

/**
 * The longs' dollars sit below the snapshot's mark and go as the lows reach them; the shorts' above, as the highs do. Candles count from the
 * minute holding the snapshot's time, each taken to act at its middle; what the page saw itself counts after them, so a candle's time wins
 * wherever a candle reached as far.
 */
export function takenByCandles(levels: LiqLevels, candles: readonly CandleRow[], seen: Seen | null = null): { long: Taken; short: Taken } {
  const n = levels.k.length, make = (): Taken => ({ first: new Float64Array(n).fill(NaN), gone: new Float64Array(n).fill(NaN), frac: new Float64Array(n) });
  const long = make(), short = make();
  const from = Math.floor(levels.asOf / MINUTE) * MINUTE;
  const times: number[] = [], lows: number[] = [], highs: number[] = [];
  let low = Infinity, high = -Infinity;
  const add = (t: number, lo: number, hi: number): void => { low = Math.min(low, lo); high = Math.max(high, hi); times.push(t); lows.push(low); highs.push(high); };
  for (const c of candles) if (c[0] >= from && Number.isFinite(c[2]) && Number.isFinite(c[3])) add(c[0] + MINUTE / 2, c[3], c[2]);
  if (seen) {
    if (seen.lowAt <= seen.highAt) { add(seen.lowAt, seen.low, -Infinity); add(seen.highAt, Infinity, seen.high); }
    else { add(seen.highAt, Infinity, seen.high); add(seen.lowAt, seen.low, -Infinity); }
  }
  const m = times.length;
  if (!m) return { long, short };
  // The running low only falls and the running high only rises, so the first point past a price is a binary search.
  const firstAtOrBelow = (p: number, strict: boolean): number => { let a = 0, b = m; while (a < b) { const mid = (a + b) >> 1; if (strict ? lows[mid]! < p : lows[mid]! <= p) b = mid; else a = mid + 1; } return a; };
  const firstAtOrAbove = (p: number, strict: boolean): number => { let a = 0, b = m; while (a < b) { const mid = (a + b) >> 1; if (strict ? highs[mid]! > p : highs[mid]! >= p) b = mid; else a = mid + 1; } return a; };
  const step = levels.step;
  for (let i = 0; i < n; i++) {
    const p0 = levels.k[i]! * step, p1 = p0 + step;
    if (levels.longIso[i]! + levels.longCross[i]! > 0) {
      const a = firstAtOrBelow(p1, true), b = firstAtOrBelow(p0, false);
      if (a < m) long.first[i] = times[a]!;
      if (b < m) long.gone[i] = times[b]!;
      long.frac[i] = Math.min(1, Math.max(0, (p1 - lows[m - 1]!) / step));
    }
    if (levels.shortIso[i]! + levels.shortCross[i]! > 0) {
      const a = firstAtOrAbove(p0, true), b = firstAtOrAbove(p1, false);
      if (a < m) short.first[i] = times[a]!;
      if (b < m) short.gone[i] = times[b]!;
      short.frac[i] = Math.min(1, Math.max(0, (highs[m - 1]! - p0) / step));
    }
  }
  return { long, short };
}

/** A row of the drawing: whole bins grouped so a row is at least two pixels tall. */
export interface LiqRow {
  p0: number; p1: number;
  long: number; longIso: number; longWallets: number;
  short: number; shortIso: number; shortWallets: number;
  /** The largest single position of each side in the row, and whether it holds at least half of the side's dollars there. */
  longTop: number; shortTop: number;
  longOne: boolean; shortOne: boolean;
  /** Per side: first touch, all gone (NaN while any part stands), dollars still standing. */
  longFirst: number; longGone: number; longLeft: number;
  shortFirst: number; shortGone: number; shortLeft: number;
}

/** Bins per drawn row at this zoom, so a row is at least `minPx` tall. */
export function binsPerRow(step: number, view: Pick<View, 'p0' | 'p1'>, ph: number, minPx = 2): number {
  const px = step / Math.max(1e-9, view.p1 - view.p0) * ph;
  return px >= minPx ? 1 : Math.ceil(minPx / Math.max(px, 1e-6));
}

/** The rows within [lo, hi), grouping `per` consecutive bins on the fixed grid. */
export function liqRows(levels: LiqLevels, taken: { long: Taken; short: Taken } | null, per: number, lo: number, hi: number): LiqRow[] {
  const rows = new Map<number, LiqRow>(), step = levels.step;
  // Each row's largest single position per side: a position sits in one bin, so the largest of the bins' is the row's.
  const tops = new Map<number, [number, number]>();
  const k0 = Math.floor(lo / step) - per, k1 = Math.ceil(hi / step) + per;
  let i = lowerBound(levels.k, k0);
  for (; i < levels.k.length && levels.k[i]! <= k1; i++) {
    const k = levels.k[i]!, g = Math.floor(k / per);
    let r = rows.get(g);
    if (!r) {
      r = { p0: g * per * step, p1: (g + 1) * per * step, long: 0, longIso: 0, longWallets: 0, short: 0, shortIso: 0, shortWallets: 0, longTop: 0, shortTop: 0, longOne: false, shortOne: false,
        longFirst: NaN, longGone: -Infinity, longLeft: 0, shortFirst: NaN, shortGone: -Infinity, shortLeft: 0 };
      rows.set(g, r);
    }
    const l = levels.longIso[i]! + levels.longCross[i]!, s = levels.shortIso[i]! + levels.shortCross[i]!;
    const top = tops.get(g) ?? [0, 0];
    top[0] = Math.max(top[0], levels.longTop[i]!); top[1] = Math.max(top[1], levels.shortTop[i]!);
    tops.set(g, top);
    if (l > 0) {
      r.long += l; r.longIso += levels.longIso[i]!; r.longWallets += levels.longWallets[i]!;
      const first = taken?.long.first[i] ?? NaN, gone = taken?.long.gone[i] ?? NaN, frac = taken?.long.frac[i] ?? 0;
      if (Number.isFinite(first)) r.longFirst = Number.isFinite(r.longFirst) ? Math.min(r.longFirst, first) : first;
      r.longGone = Number.isFinite(gone) && r.longGone !== Infinity ? Math.max(r.longGone, gone) : Infinity;
      r.longLeft += l * (1 - frac);
    }
    if (s > 0) {
      r.short += s; r.shortIso += levels.shortIso[i]!; r.shortWallets += levels.shortWallets[i]!;
      const first = taken?.short.first[i] ?? NaN, gone = taken?.short.gone[i] ?? NaN, frac = taken?.short.frac[i] ?? 0;
      if (Number.isFinite(first)) r.shortFirst = Number.isFinite(r.shortFirst) ? Math.min(r.shortFirst, first) : first;
      r.shortGone = Number.isFinite(gone) && r.shortGone !== Infinity ? Math.max(r.shortGone, gone) : Infinity;
      r.shortLeft += s * (1 - frac);
    }
  }
  // A side whose every bin went has a time it was gone; otherwise none (Infinity marks "some still stand" while adding up).
  for (const [g, r] of rows) {
    if (!Number.isFinite(r.longGone)) r.longGone = NaN;
    if (!Number.isFinite(r.shortGone)) r.shortGone = NaN;
    const top = tops.get(g) ?? [0, 0];
    r.longTop = top[0]; r.shortTop = top[1];
    r.longOne = r.long > 0 && top[0] >= 0.5 * r.long;
    r.shortOne = r.short > 0 && top[1] >= 0.5 * r.short;
  }
  return [...rows.values()].sort((a, b) => a.p0 - b.p0);
}

function lowerBound(a: Int32Array, v: number): number {
  let lo = 0, hi = a.length;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (a[mid]! < v) lo = mid + 1; else hi = mid; }
  return lo;
}

/** The quotes a chart's price is in dollars in: the dollar and the dollar stablecoins. */
const DOLLARS = /^(USD|USDT|USDC|UST|USDE|FDUSD|DAI|PYUSD|USD1|USDS|TUSD|RLUSD)$/i;

/** The chart's price when it is in dollars, else NaN: Liquidation levels compare it with Hyperliquid's. */
export function dollarPriceOf(state: Pick<AppState, 'markets' | 'marketId' | 'mark'>): number {
  const market = state.markets.find(m => (m.instrumentId ?? m.id) === state.marketId);
  return market && DOLLARS.test(market.quote ?? '') ? state.mark.price : NaN;
}

/** How many positions of a side the bins in [lo, hi) hold, and the largest of them (a position sits in one bin). */
export function binsIn(levels: LiqLevels, side: 'long' | 'short', lo: number, hi: number): { positions: number; top: number } {
  let positions = 0, top = 0;
  for (let i = lowerBound(levels.k, Math.floor(lo / levels.step)); i < levels.k.length && levels.k[i]! * levels.step < hi; i++) {
    positions += side === 'long' ? levels.longWallets[i]! : levels.shortWallets[i]!;
    top = Math.max(top, side === 'long' ? levels.longTop[i]! : levels.shortTop[i]!);
  }
  return { positions, top };
}

/** What still stands of each side, added up bin by bin from the lowest (sums with a leading 0), for the profile column. */
export interface LiqStanding { k: Int32Array; step: number; long: Float64Array; short: Float64Array }

export function liqStanding(levels: LiqLevels, taken: { long: Taken; short: Taken } | null): LiqStanding {
  const n = levels.k.length, long = new Float64Array(n + 1), short = new Float64Array(n + 1);
  for (let i = 0; i < n; i++) {
    long[i + 1] = long[i]! + (levels.longIso[i]! + levels.longCross[i]!) * (1 - (taken?.long.frac[i] ?? 0));
    short[i + 1] = short[i]! + (levels.shortIso[i]! + levels.shortCross[i]!) * (1 - (taken?.short.frac[i] ?? 0));
  }
  return { k: levels.k, step: levels.step, long, short };
}

/** The dollars of one side standing below `price`; a bin the price cuts counts in proportion, its dollars spread evenly over it. */
export function standingBelow(s: LiqStanding, side: 'long' | 'short', price: number): number {
  const sums = s[side], pos = price / s.step, kk = Math.floor(pos), i = lowerBound(s.k, kk);
  return sums[i]! + (i < s.k.length && s.k[i] === kk ? (sums[i + 1]! - sums[i]!) * (pos - kk) : 0);
}

/**
 * The profile column's rows from `p0` to `p1`, `step` dollars each: what stands of each side in the row and, faint behind it, everything
 * from the price out to the row (the longs that go if price falls that far, the shorts if it rises).
 */
export interface LiqProfile { row0: number; step: number; long: Float64Array; short: Float64Array; cumLong: Float64Array; cumShort: Float64Array; maxLevel: number; maxCum: number }

export function liqProfile(s: LiqStanding, step: number, p0: number, p1: number, price: number): LiqProfile {
  const row0 = Math.floor(p0 / step), n = Math.max(0, Math.min(5_000, Math.floor(p1 / step) - row0 + 1));
  const out: LiqProfile = { row0, step, long: new Float64Array(n), short: new Float64Array(n), cumLong: new Float64Array(n), cumShort: new Float64Array(n), maxLevel: 0, maxCum: 0 };
  const longAtPrice = standingBelow(s, 'long', price), shortAtPrice = standingBelow(s, 'short', price);
  let longBelow = standingBelow(s, 'long', row0 * step), shortBelow = standingBelow(s, 'short', row0 * step);
  for (let r = 0; r < n; r++) {
    const a = (row0 + r) * step, b = a + step, longTo = standingBelow(s, 'long', b), shortTo = standingBelow(s, 'short', b);
    out.long[r] = Math.max(0, longTo - longBelow); out.short[r] = Math.max(0, shortTo - shortBelow);
    out.cumLong[r] = a < price ? Math.max(0, longAtPrice - longBelow) : 0;
    out.cumShort[r] = b > price ? Math.max(0, shortTo - shortAtPrice) : 0;
    out.maxLevel = Math.max(out.maxLevel, out.long[r]! + out.short[r]!);
    out.maxCum = Math.max(out.maxCum, out.cumLong[r]!, out.cumShort[r]!);
    longBelow = longTo; shortBelow = shortTo;
  }
  return out;
}

/** The colour strength of a row's dollars against the largest rows in view (the 97th percentile, so one wallet does not wash out the rest). */
export function heatScale(values: readonly number[]): (usd: number) => number {
  const sorted = values.filter(v => v > 0).sort((a, b) => a - b);
  const top = Math.max(1e5, sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.97))]! : 0);
  return usd => usd < 0.06 * top ? 0 : Math.min(0.9, 0.05 + 0.85 * Math.min(1, usd / top));
}

export interface LiqColors { long: string; short: string; text: string; muted: string; bg: string }

/** The colour strength of what still stands of the rows in view (heatScale over each side's standing dollars). */
export const standingHeat = (rows: readonly LiqRow[]): ((usd: number) => number) => heatScale(rows.flatMap(r => [r.longLeft, r.shortLeft]));

/**
 * Draws the rows as a stripe from `x0` (the live edge) to the plot's right edge, beside the profile column: what still stands of each row,
 * the more the darker, with a crisp edge on the strongest on the side facing the price, and a small diamond in the side's colour at the start
 * of a large row one position holds at least half of. A level price has traded through is gone; nothing is drawn over the heatmap's past.
 */
export function paintLiqStripe(ctx: CanvasRenderingContext2D, view: View, x0: number, pw: number, ph: number, rows: readonly LiqRow[], heat: (usd: number) => number, colors: LiqColors): void {
  const w = pw - x0;
  if (w < 2) return;
  ctx.save();
  for (const r of rows) {
    const y0 = view.yOf(r.p1, ph), y1 = view.yOf(r.p0, ph);
    if (y1 < 0 || y0 > ph) continue;
    const h = Math.max(1, y1 - y0 - (y1 - y0 > 3 ? 0.5 : 0));
    for (const side of ['long', 'short'] as const) {
      const usd = r[`${side}Left`]; if (usd <= 0) continue;
      const a = heat(usd); if (a <= 0) continue;
      ctx.fillStyle = side === 'long' ? colors.long : colors.short;
      ctx.globalAlpha = a; ctx.fillRect(x0, y0, w, h);
      // A strong level gets a crisp edge on the side facing the price, so the clusters read as lines.
      if (a >= 0.45) {
        const edge = side === 'long' ? Math.round(y0) : Math.round(y0 + h) - 1;
        ctx.globalAlpha = Math.min(1, a + 0.15); ctx.fillRect(x0, edge, w, 1);
      }
      if (r[`${side}One`] && usd >= 3e6 && w > 14) {
        // In its side's colour, as on the phone's ladder, ringed in the page's ground so it stands off its own row (Karl, 2026-11-01: in the
        // text colour it was green on Terminal's red rows, a short's colour on longs).
        const cx = x0 + 9, cy = (y0 + y1) / 2, s = Math.min(4, Math.max(2.5, h / 2 + 1));
        ctx.beginPath(); ctx.moveTo(cx, cy - s); ctx.lineTo(cx + s, cy); ctx.lineTo(cx, cy + s); ctx.lineTo(cx - s, cy); ctx.closePath();
        ctx.globalAlpha = 1; ctx.lineWidth = 2; ctx.strokeStyle = colors.bg; ctx.stroke();
        ctx.fillStyle = side === 'long' ? colors.long : colors.short; ctx.fill();
      }
    }
  }
  ctx.restore();
}

/** Loads the file and the candles that take levels away, and keeps both fresh while the levels are on. */
export class LiqLevelsSource {
  levels: LiqLevels | null = null;
  state: 'idle' | 'loading' | 'ready' | 'stale' | 'unavailable' | 'other-coin' | 'off' = 'idle';
  /** Bumped whenever new levels come. */
  version = 0;
  readonly candles: KeyLevelHistory;
  #url = '';
  #pending = false;
  #nextAt = 0;
  #failed = false;
  #seen: Seen | null = null;
  #derived: { key: string; taken: { long: Taken; short: Taken }; standing: LiqStanding } | null = null;
  #target: HistoryTarget | null = null;

  constructor(private get: Fetcher = webGet, private now: () => number = Date.now, private url: () => string = () => liqLevelsUrl()) {
    this.candles = new KeyLevelHistory(get, now, CANDLES_MS, 12 * HOUR);
  }

  /** Keep the levels of `coin` fresh; `onChange` runs when anything drawn changes. */
  ensure(coin: Coin, onChange: () => void): void {
    const url = this.url();
    if (!url) { this.state = 'off'; return; }
    if (coin.coin !== BTC.coin) { this.state = 'other-coin'; return; }
    if (url !== this.#url) { this.#url = url; this.levels = null; this.#seen = null; this.#nextAt = 0; this.#failed = false; this.version++; }
    const now = this.now();
    if (!this.#pending && now >= this.#nextAt) {
      this.#pending = true;
      const asked = url;
      // Asked of the edge every time (a 304 when nothing changed): a CDN can stretch the minute the file asks to be kept, as Cloudflare's
      // zone default did to four hours (2026-11-01).
      void this.get(url, { cache: 'no-cache' }).then(raw => {
        if (asked !== this.#url) return;
        const levels = parseLiqLevels(raw, BTC.coin);
        if (!levels) { this.#fail(onChange); return; }
        this.#failed = false; this.#nextAt = this.now() + REFRESH_MS;
        // Never back to an older snapshot: an edge can hold an older copy for a moment.
        const held = this.levels;
        if (!held || levels.asOf > held.asOf || (levels.asOf === held.asOf && levels.fetchedAt > held.fetchedAt)) { this.levels = levels; this.#seen = null; this.version++; }
        this.#settle();
        onChange();
      }, () => { if (asked === this.#url) this.#fail(onChange); }).finally(() => { this.#pending = false; });
    }
    this.#settle();
    const levels = this.levels;
    if (levels) {
      const id = instrumentIdFor('hyperliquid', BTC), listing = BTC.markets.hyperliquid;
      if (id && listing) {
        this.#target ??= { id, listing, own: false };
        this.candles.ensure(this.#target, levels.asOf - MINUTE, MINUTE, onChange);
      }
    }
  }

  #fail(onChange: () => void): void {
    this.#failed = true; this.#nextAt = this.now() + RETRY_MS;
    this.#settle();
    onChange();
  }

  /** The state from what is held: levels too old to draw are stale; none yet is loading, or unavailable once a read failed. */
  #settle(): void {
    const levels = this.levels;
    this.state = !levels ? (this.#failed ? 'unavailable' : 'loading') : this.now() - levels.asOf > STALE_MS ? 'stale' : 'ready';
  }

  /**
   * The chart's price now, in dollars. Price cannot have come from the snapshot's mark to here without trading through every level between,
   * so those go at once, whatever the candles say yet (and if they cannot be read); later highs and lows take levels as they come.
   */
  observe(price: number): void {
    const levels = this.levels;
    if (!levels || !(price > 0) || !Number.isFinite(price)) return;
    const margin = Math.max(levels.step, price * SEEN_MARGIN);
    const low = Math.min(levels.mark, price + margin), high = Math.max(levels.mark, price - margin), seen = this.#seen;
    if (!seen) { this.#seen = { low, high, lowAt: levels.asOf, highAt: levels.asOf }; return; }
    const now = this.now();
    if (low < seen.low) { seen.low = low; seen.lowAt = now; }
    if (high > seen.high) { seen.high = high; seen.highAt = now; }
  }

  /** Hyperliquid's price as last read (the newest candle's close), or the snapshot's mark before any candle came. */
  lastPrice(): number {
    const levels = this.levels, bars = this.candles.bars, last = bars[bars.length - 1];
    if (!levels) return NaN;
    return last && last[0] >= levels.asOf - MINUTE && Number.isFinite(last[4]) ? last[4] : levels.mark;
  }

  /** Whether Hyperliquid's candles could not be read lately, so levels price traded through may still show until the chart's price says so. */
  candlesLate(): boolean {
    const c = this.candles;
    return c.state === 'unavailable' || (c.state === 'ready' && this.now() - c.heldTo > CANDLES_LATE_MS);
  }

  /** Changes whenever what is drawn from the levels can change, for the pane's caches. */
  key(): string {
    const l = this.levels, s = this.#seen;
    return l ? `${l.asOf}|${l.fetchedAt}|${this.candles.version}|${this.candles.bars.length}|${s?.low}|${s?.high}` : '';
  }

  /** How far price has traded through each bin, worked out again only when the levels, the candles or the prices seen changed. */
  taken(): { long: Taken; short: Taken } | null { return this.#derive()?.taken ?? null; }
  /** What stands of each side, added up, for the profile column. */
  standing(): LiqStanding | null { return this.#derive()?.standing ?? null; }

  #derive(): { taken: { long: Taken; short: Taken }; standing: LiqStanding } | null {
    const levels = this.levels;
    if (!levels) return null;
    const key = this.key();
    if (this.#derived?.key !== key) {
      const taken = takenByCandles(levels, this.candles.bars, this.#seen);
      this.#derived = { key, taken, standing: liqStanding(levels, taken) };
    }
    return this.#derived;
  }
}

/** One side of what the seam between the liquidation column and the profile column weighs: the book against the liquidations. */
export interface SeamSide {
  /** The book and the standing liquidations within the pointer's band, and over every row given (the columns on screen). */
  book: number; liq: number; bookAll: number; liqAll: number;
  /** The rank correlation of level size with book size over the rows that hold liquidations (null under SEAM_MIN_ROWS), and how many. */
  rho: number | null; n: number; rhoAll: number | null; nAll: number;
}
/** A large liquidation level and the book at its row against the rows around it (3 each way). */
export interface SeamWall { price: number; side: 'long' | 'short'; usd: number; ratio: number }
export interface SeamStats { below: SeamSide; above: SeamSide; walls: SeamWall[] }

/** Fewer rows with liquidations than this give no correlation: a coefficient of a handful of points says nothing. */
export const SEAM_MIN_ROWS = 8;

/** Ranks from 1, ties sharing their mean rank. */
function ranks(values: readonly number[]): number[] {
  const order = values.map((v, i) => [v, i] as const).sort((a, b) => a[0] - b[0]), out = new Array<number>(values.length);
  for (let i = 0; i < order.length;) {
    let j = i; while (j + 1 < order.length && order[j + 1]![0] === order[i]![0]) j++;
    for (let k = i; k <= j; k++) out[order[k]![1]] = (i + j) / 2 + 1;
    i = j + 1;
  }
  return out;
}

/** Spearman's rank correlation of two equally long lists: null where either does not vary. */
export function spearman(a: readonly number[], b: readonly number[]): number | null {
  const n = Math.min(a.length, b.length);
  if (n < 2) return null;
  const ra = ranks(a.slice(0, n)), rb = ranks(b.slice(0, n)), mean = (n + 1) / 2;
  let sab = 0, saa = 0, sbb = 0;
  for (let i = 0; i < n; i++) { const x = ra[i]! - mean, y = rb[i]! - mean; sab += x * y; saa += x * x; sbb += y * y; }
  return saa > 0 && sbb > 0 ? sab / Math.sqrt(saa * sbb) : null;
}

/**
 * What the seam between the two columns says, from rows of both at the same prices (row i covers [(row0 + i) * step, +step)): `bid` and
 * `ask` the book's, `long` and `short` the standing liquidations. A row is below the price when its middle is, above otherwise; the band is
 * the rows whose middle lies within `d` of the price. Each side: the book against the liquidations in the band and over every row, and the
 * rank correlation of level size with book size over the rows that hold liquidations (book depth thins away from the price while
 * liquidations gather away from it, so over every row a coefficient would mostly measure that distance). And for the three largest
 * liquidation levels, the book at their row against the mean of the three rows either side: a wall above 1, a void below.
 */
export function seamStats(rows: { row0: number; step: number; bid: ArrayLike<number>; ask: ArrayLike<number>; long: ArrayLike<number>; short: ArrayLike<number> }, price: number, d: number): SeamStats {
  const n = Math.min(rows.bid.length, rows.ask.length, rows.long.length, rows.short.length);
  const side = (below: boolean): SeamSide => {
    const book = below ? rows.bid : rows.ask, liq = below ? rows.long : rows.short;
    const out: SeamSide = { book: 0, liq: 0, bookAll: 0, liqAll: 0, rho: null, n: 0, rhoAll: null, nAll: 0 };
    const band: [number[], number[]] = [[], []], all: [number[], number[]] = [[], []];
    for (let i = 0; i < n; i++) {
      const middle = (rows.row0 + i + 0.5) * rows.step;
      if ((middle < price) !== below) continue;
      const b = book[i]!, l = liq[i]!, inBand = Math.abs(middle - price) <= d;
      out.bookAll += b; out.liqAll += l;
      if (inBand) { out.book += b; out.liq += l; }
      if (l > 0) { all[0].push(l); all[1].push(b); if (inBand) { band[0].push(l); band[1].push(b); } }
    }
    out.n = band[0].length; out.nAll = all[0].length;
    out.rho = out.n >= SEAM_MIN_ROWS ? spearman(band[0], band[1]) : null;
    out.rhoAll = out.nAll >= SEAM_MIN_ROWS ? spearman(all[0], all[1]) : null;
    return out;
  };
  const levels: { i: number; side: 'long' | 'short'; usd: number }[] = [];
  for (let i = 0; i < n; i++) {
    if (rows.long[i]! > 0) levels.push({ i, side: 'long', usd: rows.long[i]! });
    if (rows.short[i]! > 0) levels.push({ i, side: 'short', usd: rows.short[i]! });
  }
  const walls = levels.sort((a, b) => b.usd - a.usd).slice(0, 3).map(({ i, side, usd }): SeamWall => {
    const book = side === 'long' ? rows.bid : rows.ask;
    let sum = 0, count = 0;
    for (let k = i - 3; k <= i + 3; k++) if (k !== i && k >= 0 && k < n) { sum += book[k]!; count++; }
    const around = count ? sum / count : 0;
    return { price: (rows.row0 + i + 0.5) * rows.step, side, usd, ratio: book[i]! / Math.max(around, 1) };
  });
  return { below: side(true), above: side(false), walls };
}
