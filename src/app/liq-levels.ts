/**
 * Liquidation levels, the map's Liquidation levels layer: the prices that would liquidate Hyperliquid's open BTC positions, read from the
 * levels service (HyperLiquidMap_Levels: HyperTracker's position snapshots, binned every 30 minutes). From the snapshot's time on, a level
 * is taken away as Hyperliquid's price trades through it, read from Hyperliquid's 1-minute candles (a trade low can reach a few basis points
 * past the mark price liquidations use, so a level can go a little early in a fast fall).
 */
import { BTC, instrumentIdFor, type Coin } from '../shared/coins.ts';
import { webGet, type Fetcher } from '../shared/history.ts';
import { KeyLevelHistory, type HistoryTarget } from './keylevels/history.ts';
import { liqLevelsUrl } from './liq-url.ts';
import type { CandleRow } from './store.ts';
import type { View } from './view.ts';

const MINUTE = 60_000, HOUR = 3_600_000;
/** How often the file is asked again (the service publishes every 30 minutes; the edge keeps it for a minute). */
const REFRESH_MS = 60_000;
const RETRY_MS = 30_000;
const MAX_BINS = 40_000;

/** One snapshot's levels, bins sorted by price: bin `k[i]` covers prices [k*step, (k+1)*step). */
export interface LiqLevels {
  coin: string;
  /** When HyperTracker took the snapshot. */
  asOf: number;
  fetchedAt: number;
  /** The snapshot's own mark (value over size of every position). */
  mark: number;
  step: number;
  positions: number;
  attribution: string;
  k: Int32Array;
  longIso: Float64Array; longCross: Float64Array; shortIso: Float64Array; shortCross: Float64Array;
  longWallets: Uint32Array; shortWallets: Uint32Array;
  /** Bit 0: one wallet holds at least half of the bin's long dollars; bit 1: the same for shorts. */
  flags: Uint8Array;
}

const finite = (v: unknown, min = 0, max = Number.MAX_VALUE): v is number => typeof v === 'number' && Number.isFinite(v) && v >= min && v <= max;

/** The service's file, checked field by field; anything malformed is refused whole (null). */
export function parseLiqLevels(raw: unknown, coin: string, now: number): LiqLevels | null {
  if (!raw || typeof raw !== 'object') return null;
  const d = raw as Record<string, unknown>, snap = d.snapshot as Record<string, unknown> | undefined;
  if (d.v !== 1 || d.coin !== coin || !snap || typeof snap !== 'object') return null;
  const asOf = snap.asOf, fetchedAt = snap.fetchedAt, mark = d.mark, step = d.step, positions = d.positions, bins = d.bins;
  if (!finite(asOf, Date.UTC(2024, 0, 1), now + HOUR) || !finite(fetchedAt, asOf - HOUR, now + HOUR) || !finite(mark, 1e-9) || !finite(step, 1e-9, 1e6)) return null;
  if (!finite(positions, 0, 1e8) || !Array.isArray(bins) || bins.length > MAX_BINS) return null;
  const n = bins.length, out: LiqLevels = {
    coin, asOf, fetchedAt, mark, step, positions, attribution: typeof d.attribution === 'string' ? d.attribution.slice(0, 80) : '',
    k: new Int32Array(n), longIso: new Float64Array(n), longCross: new Float64Array(n), shortIso: new Float64Array(n), shortCross: new Float64Array(n),
    longWallets: new Uint32Array(n), shortWallets: new Uint32Array(n), flags: new Uint8Array(n),
  };
  let last = -Infinity;
  for (let i = 0; i < n; i++) {
    const b = bins[i];
    if (!Array.isArray(b) || b.length !== 8) return null;
    const [k, li, lc, si, sc, lw, sw, fl] = b as unknown[];
    if (!Number.isInteger(k) || (k as number) <= last || (k as number) * step > 1e9 || (k as number) < 0) return null;
    if (![li, lc, si, sc].every(v => finite(v, 0, 1e13)) || ![lw, sw].every(v => Number.isInteger(v) && finite(v, 0, 1e7)) || !Number.isInteger(fl) || !finite(fl, 0, 3)) return null;
    last = k as number;
    out.k[i] = k as number; out.longIso[i] = li as number; out.longCross[i] = lc as number; out.shortIso[i] = si as number; out.shortCross[i] = sc as number;
    out.longWallets[i] = lw as number; out.shortWallets[i] = sw as number; out.flags[i] = fl as number;
  }
  return out;
}

/** How far price has traded through each bin since the snapshot, for one side. NaN where it has not (yet). */
export interface Taken {
  /** When price first traded into the bin. */
  first: Float64Array;
  /** When price had traded through all of it. */
  gone: Float64Array;
  /** The share of the bin's width traded through by the newest candle (0 to 1). */
  frac: Float64Array;
}

/**
 * The longs' dollars sit below the snapshot's mark and go as the lows reach them; the shorts' above, as the highs do. Candles count from the
 * minute holding the snapshot's time; each is taken to act at its middle.
 */
export function takenByCandles(levels: LiqLevels, candles: readonly CandleRow[]): { long: Taken; short: Taken } {
  const n = levels.k.length, make = (): Taken => ({ first: new Float64Array(n).fill(NaN), gone: new Float64Array(n).fill(NaN), frac: new Float64Array(n) });
  const long = make(), short = make();
  const from = Math.floor(levels.asOf / MINUTE) * MINUTE;
  const times: number[] = [], lows: number[] = [], highs: number[] = [];
  let low = Infinity, high = -Infinity;
  for (const c of candles) {
    if (c[0] < from || !Number.isFinite(c[2]) || !Number.isFinite(c[3])) continue;
    low = Math.min(low, c[3]); high = Math.max(high, c[2]);
    times.push(c[0] + MINUTE / 2); lows.push(low); highs.push(high);
  }
  const m = times.length;
  if (!m) return { long, short };
  // The running low only falls and the running high only rises, so the first candle past a price is a binary search.
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
  long: number; longIso: number; longWallets: number; longOne: boolean;
  short: number; shortIso: number; shortWallets: number; shortOne: boolean;
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
  // The largest flagged bin of each row and side: the row is one wallet's when that bin holds at least half of the row.
  const flagged = new Map<number, [number, number]>();
  const k0 = Math.floor(lo / step) - per, k1 = Math.ceil(hi / step) + per;
  let i = lowerBound(levels.k, k0);
  for (; i < levels.k.length && levels.k[i]! <= k1; i++) {
    const k = levels.k[i]!, g = Math.floor(k / per);
    let r = rows.get(g);
    if (!r) {
      r = { p0: g * per * step, p1: (g + 1) * per * step, long: 0, longIso: 0, longWallets: 0, longOne: false, short: 0, shortIso: 0, shortWallets: 0, shortOne: false,
        longFirst: NaN, longGone: -Infinity, longLeft: 0, shortFirst: NaN, shortGone: -Infinity, shortLeft: 0 };
      rows.set(g, r);
    }
    const l = levels.longIso[i]! + levels.longCross[i]!, s = levels.shortIso[i]! + levels.shortCross[i]!;
    const f = flagged.get(g) ?? [0, 0];
    if (levels.flags[i]! & 1) f[0] = Math.max(f[0], l);
    if (levels.flags[i]! & 2) f[1] = Math.max(f[1], s);
    flagged.set(g, f);
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
    const f = flagged.get(g) ?? [0, 0];
    r.longOne = r.long > 0 && f[0] >= 0.5 * r.long;
    r.shortOne = r.short > 0 && f[1] >= 0.5 * r.short;
  }
  return [...rows.values()].sort((a, b) => a.p0 - b.p0);
}

function lowerBound(a: Int32Array, v: number): number {
  let lo = 0, hi = a.length;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (a[mid]! < v) lo = mid + 1; else hi = mid; }
  return lo;
}

/** The colour strength of a row's dollars against the largest rows in view (the 97th percentile, so one wallet does not wash out the rest). */
export function heatScale(values: readonly number[]): (usd: number) => number {
  const sorted = values.filter(v => v > 0).sort((a, b) => a - b);
  const top = Math.max(1e5, sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.97))]! : 0);
  return usd => usd < 0.06 * top ? 0 : Math.min(0.9, 0.05 + 0.85 * Math.min(1, usd / top));
}

export interface LiqColors { long: string; short: string; text: string; muted: string; bg: string }

/**
 * Draws the rows from the snapshot's time to the right edge. A row stays at full strength until price first trades into it, then shows
 * what is left of it, and ends where price had traded through all of it. Where one wallet holds most of a large row, a small diamond sits at
 * the row's start.
 */
export function paintLiqRows(ctx: CanvasRenderingContext2D, view: View, pw: number, ph: number, levels: LiqLevels, rows: readonly LiqRow[], colors: LiqColors, now: number): void {
  const xs = Math.max(0, view.xOf(levels.asOf, pw));
  if (xs >= pw) return;
  const heat = heatScale(rows.flatMap(r => [r.long, r.short]));
  const xAt = (t: number): number => Math.min(pw, Math.max(xs, view.xOf(t, pw)));
  ctx.save();
  for (const r of rows) {
    const y0 = view.yOf(r.p1, ph), y1 = view.yOf(r.p0, ph);
    if (y1 < 0 || y0 > ph) continue;
    const h = Math.max(1, y1 - y0 - (y1 - y0 > 3 ? 0.5 : 0));
    for (const side of ['long', 'short'] as const) {
      const usd = r[side]; if (usd <= 0) continue;
      const a = heat(usd); if (a <= 0) continue;
      const first = r[`${side}First`], gone = r[`${side}Gone`], left = r[`${side}Left`];
      const end = Number.isFinite(gone) && gone <= now ? xAt(gone) : pw, touch = Number.isFinite(first) && first <= now ? xAt(first) : end;
      ctx.fillStyle = side === 'long' ? colors.long : colors.short;
      ctx.globalAlpha = a; ctx.fillRect(xs, y0, touch - xs, h);
      if (end > touch) { ctx.globalAlpha = a * Math.max(0.15, left / usd); ctx.fillRect(touch, y0, end - touch, h); }
      // A strong level gets a crisp edge on the side facing the price, so the clusters read as lines.
      if (a >= 0.45) {
        const edge = side === 'long' ? Math.round(y0) : Math.round(y0 + h) - 1;
        ctx.globalAlpha = Math.min(1, a + 0.15); ctx.fillRect(xs, edge, touch - xs, 1);
      }
      if (r[`${side}One`] && usd >= 3e6 && end - xs > 14) {
        const cx = xs + 9, cy = (y0 + y1) / 2, s = Math.min(4, Math.max(2.5, h / 2 + 1));
        ctx.globalAlpha = 0.95; ctx.fillStyle = colors.text;
        ctx.beginPath(); ctx.moveTo(cx, cy - s); ctx.lineTo(cx + s, cy); ctx.lineTo(cx, cy + s); ctx.lineTo(cx - s, cy); ctx.closePath(); ctx.fill();
      }
    }
  }
  // The snapshot's time, as a faint dashed line the bands start from.
  if (xs > 0) {
    ctx.globalAlpha = 0.5; ctx.strokeStyle = colors.muted; ctx.setLineDash([3, 4]);
    ctx.beginPath(); ctx.moveTo(Math.round(xs) + 0.5, 0); ctx.lineTo(Math.round(xs) + 0.5, ph); ctx.stroke(); ctx.setLineDash([]);
  }
  ctx.restore();
}

/** Loads the file and the candles that take levels away, and keeps both fresh while the layer is on screen. */
export class LiqLevelsSource {
  levels: LiqLevels | null = null;
  state: 'idle' | 'loading' | 'ready' | 'unavailable' | 'other-coin' | 'off' = 'idle';
  /** Bumped whenever the levels or the candles change. */
  version = 0;
  readonly candles: KeyLevelHistory;
  #url = '';
  #pending = false;
  #askedAt = 0;
  #retryAt = 0;
  #taken: { key: string; value: { long: Taken; short: Taken } } | null = null;
  #target: HistoryTarget | null = null;

  constructor(private get: Fetcher = webGet, private now: () => number = Date.now, private url: () => string = () => liqLevelsUrl()) {
    this.candles = new KeyLevelHistory(get, now, 20_000, 12 * HOUR);
  }

  /** Keep the levels of `coin` fresh; `onChange` runs when anything drawn changes. */
  ensure(coin: Coin, onChange: () => void): void {
    const url = this.url();
    if (!url) { this.state = 'off'; return; }
    if (coin.coin !== BTC.coin) { this.state = 'other-coin'; return; }
    if (url !== this.#url) { this.#url = url; this.levels = null; this.#askedAt = 0; this.#retryAt = 0; this.version++; }
    if (this.state === 'other-coin' || this.state === 'off' || this.state === 'idle') this.state = this.levels ? 'ready' : 'loading';
    const now = this.now();
    if (!this.#pending && now >= this.#retryAt && now - this.#askedAt >= REFRESH_MS) {
      this.#pending = true; this.#askedAt = now;
      const asked = url;
      void this.get(url).then(raw => {
        if (asked !== this.#url) return;
        const levels = parseLiqLevels(raw, BTC.coin, this.now());
        if (!levels) { this.#fail(); return; }
        if (!this.levels || levels.asOf !== this.levels.asOf || levels.fetchedAt !== this.levels.fetchedAt) { this.levels = levels; this.version++; onChange(); }
        this.state = 'ready';
      }, () => { if (asked === this.#url) this.#fail(); }).finally(() => { this.#pending = false; });
    }
    if (this.levels) {
      const id = instrumentIdFor('hyperliquid', BTC), listing = BTC.markets.hyperliquid;
      if (id && listing) {
        this.#target ??= { id, listing, own: false };
        const before = this.candles.version;
        this.candles.ensure(this.#target, this.levels.asOf - MINUTE, MINUTE, () => { if (this.candles.version !== before) this.version++; onChange(); });
      }
    }
  }

  #fail(): void {
    this.#retryAt = this.now() + RETRY_MS;
    if (!this.levels) this.state = 'unavailable';
  }

  /** How far price has traded through each bin, worked out again only when the levels or the candles changed. */
  taken(): { long: Taken; short: Taken } | null {
    if (!this.levels) return null;
    const key = `${this.levels.asOf}|${this.levels.fetchedAt}|${this.candles.version}|${this.candles.bars.length}`;
    if (this.#taken?.key !== key) this.#taken = { key, value: takenByCandles(this.levels, this.candles.bars) };
    return this.#taken.value;
  }
}
