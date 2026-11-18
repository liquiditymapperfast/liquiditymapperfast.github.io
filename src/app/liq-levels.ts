/**
 * Liquidation levels (the Chart deck's Liq levels): the prices that would liquidate Hyperliquid's open BTC positions, read from the levels
 * service (HyperLiquidMap_Levels, format 2: HyperTracker's position snapshots, about one every 30 minutes, binned per $10; asked for when the
 * next can be there, `liq-schedule.ts`). They are drawn as
 * a stripe right of the live edge, beside the profile column, which adds them up. From the time the positions describe (about 35 minutes
 * before HyperTracker stamps its snapshot) a level is taken away as Hyperliquid's price trades through it: Hyperliquid's 1-minute candles say how far and
 * when, and the chart's own price says it at once (a trade low can reach a few basis points past the mark price liquidations use, so a
 * level can go a little early in a fast fall).
 */
import { BTC, instrumentIdFor, type Coin } from '../shared/coins.ts';
import { webGet, type Fetcher } from '../shared/history.ts';
import { KeyLevelHistory, type HistoryTarget } from './keylevels/history.ts';
import { MAX_LEAD_MS, ON_TIME_MS, clockSetBack, nextAskAt, pageHidden, placeSnapshot } from './liq-schedule.ts';
import { liqLevelsUrl, plusUrls } from './liq-url.ts';
import { isRefusal, webFetch, type LiqFetch } from './liq-history.ts';
import { FREE_VIEW, viewKey, type LiqView } from './liq-view.ts';
import { plus } from './plus/pass.ts';
import type { AppState, CandleRow } from './store.ts';
import type { View } from './view.ts';

const MINUTE = 60_000, HOUR = 3_600_000, DAY = 24 * HOUR;
/** A failed read is tried again this soon (a new snapshot is asked for when it can be there: `liq-schedule.ts`). */
const RETRY_MS = 30_000;
/** Older than this, the levels are not drawn: too many positions have opened and closed since. */
export const STALE_MS = 3 * HOUR;
/** Stop and take-profit orders more than this older than the liquidations beside them are said to be so (`ordersOld`). */
const ORDERS_BEHIND_MS = 2 * HOUR;
/** Hyperliquid's candles are asked again this often; the chart's own price covers the time between. */
const CANDLES_MS = 60_000;
/** Candles last read longer ago than this no longer vouch for what price has traded through. */
const CANDLES_LATE_MS = 5 * MINUTE;
/** The chart's price may be another venue's: it takes a level only this far past it (5 bp, at least one bin). */
const SEEN_MARGIN = 0.0005;
const MAX_BINS = 40_000;

/**
 * What a set of levels holds: liquidation levels; stop orders; take-profit orders; or liquidations and stops added together (`sumLevels`).
 * The long side always sits below the snapshot's mark and goes as the lows reach it, the short side above (`takenByCandles`), so take
 * profits are held with their sides swapped (`takeProfits`): the long side holds the take profits of shorts (buys below the mark), the
 * short side those of longs (sells above it).
 */
export type LevelsKind = 'liq' | 'stops' | 'takes' | 'both';

/** One snapshot's levels, bins sorted by price: bin `k[i]` covers prices [k*step, (k+1)*step). */
export interface LiqLevels {
  coin: string;
  kind: LevelsKind;
  /** The time the positions describe: HyperTracker's snapshot time less its measured delay. */
  asOf: number;
  /** When HyperTracker stamped the snapshot, and when the service read it. */
  createdAt: number;
  fetchedAt: number;
  /** The snapshot's own mark (value over size of every position). */
  mark: number;
  step: number;
  /** Positions (liquidations), orders (stops, take profits), or both added (both). */
  positions: number;
  attribution: string;
  k: Int32Array;
  /**
   * Each side's dollars in two parts that add up to all of it: isolated and cross margin (liquidations); whole-position orders and orders
   * with a size of their own (stops, take profits); liquidations and stops (both).
   */
  longIso: Float64Array; longCross: Float64Array; shortIso: Float64Array; shortCross: Float64Array;
  /** Positions (liquidations), orders (stops, take profits), or both added. */
  longWallets: Uint32Array; shortWallets: Uint32Array;
  /** The largest single position (or order) of each side in the bin: a wallet holds one position of a coin, so it is one wallet's. */
  longTop: Float64Array; shortTop: Float64Array;
}

const finite = (v: unknown, min = 0, max = Number.MAX_VALUE): v is number => typeof v === 'number' && Number.isFinite(v) && v >= min && v <= max;

/** A file's snapshot times, checked against each other (the service's clock, not the visitor's, which can be off). */
interface Snap { asOf: number; createdAt: number; fetchedAt: number }
function readSnap(snap: unknown): Snap | null {
  if (!snap || typeof snap !== 'object') return null;
  const s = snap as Record<string, unknown>, asOf = s.asOf, createdAt = s.createdAt, fetchedAt = s.fetchedAt;
  if (!finite(asOf, Date.UTC(2024, 0, 1), Date.UTC(2100, 0, 1)) || !finite(createdAt, asOf, asOf + DAY) || !finite(fetchedAt, asOf, asOf + 7 * DAY)) return null;
  return { asOf, createdAt, fetchedAt };
}

/**
 * Bins of one file part, checked field by field (`[k, a, b, c, d, longCount, shortCount, longTop, shortTop]`: the long side's two parts, the
 * short side's, the positions or orders counted, the largest one); anything malformed refuses the whole (null).
 */
function readBins(bins: unknown, head: Omit<LiqLevels, 'k' | 'longIso' | 'longCross' | 'shortIso' | 'shortCross' | 'longWallets' | 'shortWallets' | 'longTop' | 'shortTop'>): LiqLevels | null {
  if (!Array.isArray(bins) || bins.length > MAX_BINS) return null;
  const n = bins.length, step = head.step, out: LiqLevels = {
    ...head,
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

const attributionOf = (d: Record<string, unknown>): string => typeof d.attribution === 'string' ? d.attribution.slice(0, 80) : '';

/**
 * The service's file, checked field by field; anything malformed is refused whole (null). Its times come from the service's clock and are
 * checked against each other, not against the visitor's, which can be off.
 */
export function parseLiqLevels(raw: unknown, coin: string): LiqLevels | null {
  if (!raw || typeof raw !== 'object') return null;
  const d = raw as Record<string, unknown>, snap = readSnap(d.snapshot);
  if (d.v !== 2 || d.coin !== coin || !snap) return null;
  const mark = d.mark, step = d.step, positions = d.positions;
  if (!finite(mark, 1e-9) || !finite(step, 1e-9, 1e6) || !finite(positions, 0, 1e8)) return null;
  return readBins(d.bins, { coin, kind: 'liq', ...snap, mark, step, positions, attribution: attributionOf(d) });
}

/**
 * The newest snapshot of HyperTracker's profitable traders (Plus, `liquidations-groups.json` format 1): their liquidation levels, shaped as
 * the levels file's, on its snapshot, mark and grid. That group alone is read: whatever else the file's `groups` holds is left unread and
 * never kept. Checked field by field; anything malformed is refused whole.
 */
export interface LiqGroups extends Snap { mark: number; step: number; profitable: LiqLevels }
export function parseLiqGroups(raw: unknown, coin: string): LiqGroups | null {
  if (!raw || typeof raw !== 'object') return null;
  const d = raw as Record<string, unknown>, snap = readSnap(d.snapshot), groups = d.groups as Record<string, unknown> | null | undefined;
  if (d.v !== 1 || d.coin !== coin || !snap || !groups || typeof groups !== 'object') return null;
  const mark = d.mark, step = d.step;
  if (!finite(mark, 1e-9) || !finite(step, 1e-9, 1e6)) return null;
  const group = (g: unknown): LiqLevels | null => {
    if (!g || typeof g !== 'object') return null;
    const o = g as Record<string, unknown>;
    return finite(o.positions, 0, 1e8) ? readBins(o.bins, { coin, kind: 'liq', ...snap, mark, step, positions: o.positions, attribution: attributionOf(d) }) : null;
  };
  const profitable = group(groups.profitable);
  if (!profitable) return null;
  return { ...snap, mark, step, profitable };
}

/**
 * The take profits with their sides swapped, so they fit the drawing (`takenByCandles`): a take profit that closes a long is a sell above
 * the mark, one that closes a short a buy below it. The long side then holds the take profits of shorts, the short side those of longs.
 */
function takeProfits(t: LiqLevels): LiqLevels {
  return { ...t, kind: 'takes', longIso: t.shortIso, longCross: t.shortCross, shortIso: t.longIso, shortCross: t.longCross,
    longWallets: t.shortWallets, shortWallets: t.longWallets, longTop: t.shortTop, shortTop: t.longTop };
}

/**
 * The newest stop and take-profit levels (Plus, `triggers.json` format 1), on the snapshot the order file was read with (it can be older than
 * the levels file's: not every snapshot gets an order file). A bin holds what closes longs (sell orders) and what closes shorts, each as
 * whole-position orders and orders with their own size, the orders counted and the largest. Stops keep their sides (a stop that closes a
 * long sits below the mark); take profits are swapped (`takeProfits`). Checked field by field; anything malformed is refused whole.
 */
export interface LiqTriggers extends Snap { mark: number; step: number; stops: LiqLevels; takes: LiqLevels }
export function parseTriggers(raw: unknown, coin: string): LiqTriggers | null {
  if (!raw || typeof raw !== 'object') return null;
  const d = raw as Record<string, unknown>, snap = readSnap(d.snapshot);
  if (d.v !== 1 || d.coin !== coin || !snap) return null;
  const mark = d.mark, step = d.step;
  if (!finite(mark, 1e-9) || !finite(step, 1e-9, 1e6)) return null;
  const part = (p: unknown, kind: 'stops' | 'takes'): LiqLevels | null => {
    if (!p || typeof p !== 'object') return null;
    const o = p as Record<string, unknown>;
    return finite(o.orders, 0, 1e8) ? readBins(o.bins, { coin, kind, ...snap, mark, step, positions: o.orders, attribution: attributionOf(d) }) : null;
  };
  const stops = part(d.stops, 'stops'), takes = part(d.takes, 'takes');
  if (!stops || !takes) return null;
  return { ...snap, mark, step, stops, takes: takeProfits(takes) };
}

/**
 * Liquidations and stops added bin by bin into one set of levels ("both"), on the liquidations' snapshot, mark and grid (the stops' grid is
 * the same $10). Each side's first part is the liquidations' and its second the stops'; the positions and orders are counted together, the
 * largest is the larger of the two. `ia` and `ib` give each bin's place in `a` and `b` (-1: none there), so what price has taken of each can
 * be put together (`combineTaken`).
 */
export function sumLevels(a: LiqLevels, b: LiqLevels): { levels: LiqLevels; ia: Int32Array; ib: Int32Array } {
  const ks: number[] = [];
  for (let i = 0, j = 0; i < a.k.length || j < b.k.length;) {
    const ka = i < a.k.length ? a.k[i]! : Infinity, kb = j < b.k.length ? b.k[j]! : Infinity;
    ks.push(Math.min(ka, kb));
    if (ka <= kb) i++;
    if (kb <= ka) j++;
  }
  const n = ks.length, ia = new Int32Array(n).fill(-1), ib = new Int32Array(n).fill(-1);
  const out: LiqLevels = {
    coin: a.coin, kind: 'both', asOf: a.asOf, createdAt: a.createdAt, fetchedAt: a.fetchedAt, mark: a.mark, step: a.step, positions: a.positions + b.positions, attribution: a.attribution,
    k: Int32Array.from(ks), longIso: new Float64Array(n), longCross: new Float64Array(n), shortIso: new Float64Array(n), shortCross: new Float64Array(n),
    longWallets: new Uint32Array(n), shortWallets: new Uint32Array(n), longTop: new Float64Array(n), shortTop: new Float64Array(n),
  };
  for (let x = 0, i = 0, j = 0; x < n; x++) {
    const k = ks[x]!;
    if (i < a.k.length && a.k[i] === k) {
      ia[x] = i;
      out.longIso[x] = a.longIso[i]! + a.longCross[i]!; out.shortIso[x] = a.shortIso[i]! + a.shortCross[i]!;
      out.longWallets[x] = a.longWallets[i]!; out.shortWallets[x] = a.shortWallets[i]!; out.longTop[x] = a.longTop[i]!; out.shortTop[x] = a.shortTop[i]!;
      i++;
    }
    if (j < b.k.length && b.k[j] === k) {
      ib[x] = j;
      out.longCross[x] = b.longIso[j]! + b.longCross[j]!; out.shortCross[x] = b.shortIso[j]! + b.shortCross[j]!;
      out.longWallets[x] = out.longWallets[x]! + b.longWallets[j]!; out.shortWallets[x] = out.shortWallets[x]! + b.shortWallets[j]!;
      out.longTop[x] = Math.max(out.longTop[x]!, b.longTop[j]!); out.shortTop[x] = Math.max(out.shortTop[x]!, b.shortTop[j]!);
      j++;
    }
  }
  return { levels: out, ia, ib };
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

/**
 * What price has taken of liquidations and stops added together (`sumLevels`), from what it took of each on its own: each part counts from
 * its own snapshot (the stops' is often an earlier one), so a stop price reached between the two snapshots is gone while a liquidation
 * level there, measured after it, still stands. A bin is first reached when either part is, gone when every part it holds is, and the
 * share taken is each part's share weighted by its dollars.
 */
export function combineTaken(sum: { levels: LiqLevels; ia: Int32Array; ib: Int32Array }, ta: { long: Taken; short: Taken }, tb: { long: Taken; short: Taken }): { long: Taken; short: Taken } {
  const s = sum.levels, n = s.k.length, make = (): Taken => ({ first: new Float64Array(n).fill(NaN), gone: new Float64Array(n).fill(NaN), frac: new Float64Array(n) });
  const long = make(), short = make();
  for (let x = 0; x < n; x++) {
    const i = sum.ia[x]!, j = sum.ib[x]!;
    for (const side of ['long', 'short'] as const) {
      const out = side === 'long' ? long : short, a = side === 'long' ? s.longIso[x]! : s.shortIso[x]!, b = side === 'long' ? s.longCross[x]! : s.shortCross[x]!;
      const pa = a > 0 && i >= 0 ? ta[side] : null, pb = b > 0 && j >= 0 ? tb[side] : null;
      if (!pa && !pb) continue;
      const firsts = [pa ? pa.first[i]! : NaN, pb ? pb.first[j]! : NaN].filter(Number.isFinite);
      if (firsts.length) out.first[x] = Math.min(...firsts);
      const gone = [pa ? pa.gone[i]! : null, pb ? pb.gone[j]! : null].filter((g): g is number => g !== null);
      if (gone.every(Number.isFinite)) out.gone[x] = Math.max(...gone);
      out.frac[x] = ((pa ? a * pa.frac[i]! : 0) + (pb ? b * pb.frac[j]! : 0)) / ((pa ? a : 0) + (pb ? b : 0));
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
 * What would be liquidated on the way from `price` to `at`: the longs standing between them when `at` is below the price (they go as it
 * falls there), the shorts when it is above (as it rises); a bin `at` cuts counts in proportion. Null at the price itself or without one.
 * The liquidation column's curve, its reading at the pointer and the stripe's "If price gets here" all come from here.
 */
export function onTheWay(s: LiqStanding, price: number, at: number): { side: 'long' | 'short'; usd: number } | null {
  if (!(price > 0) || !Number.isFinite(price) || !Number.isFinite(at) || at === price) return null;
  return at < price ? { side: 'long', usd: Math.max(0, standingBelow(s, 'long', price) - standingBelow(s, 'long', at)) }
    : { side: 'short', usd: Math.max(0, standingBelow(s, 'short', at) - standingBelow(s, 'short', price)) };
}

/**
 * Liquidations and stops apart while the view adds them up ("both": `LiqLevelsSource.partStandings`), each what still stands of it: their
 * sum, bin by bin, is the view's own standing, so the two parts always add up to the total the page shows beside them.
 */
export interface LiqParts { liq: LiqStanding; stops: LiqStanding }
/** What stands of each part on one side within [lo, hi) (a row of the stripe, of the column, of the Liq tab). */
export function partsBetween(parts: LiqParts, side: 'long' | 'short', lo: number, hi: number): { liq: number; stops: number } {
  const of = (s: LiqStanding): number => Math.max(0, standingBelow(s, side, hi) - standingBelow(s, side, lo));
  return { liq: of(parts.liq), stops: of(parts.stops) };
}
/** What of each part goes on the way from `price` to `at` (`onTheWay` of each), or null where `onTheWay` has nothing to say. */
export function partsOnTheWay(parts: LiqParts, price: number, at: number): { liq: number; stops: number } | null {
  const liq = onTheWay(parts.liq, price, at), stops = onTheWay(parts.stops, price, at);
  return liq && stops ? { liq: liq.usd, stops: stops.usd } : null;
}

/**
 * The profile column's rows from `p0` to `p1`, `step` dollars each: what stands of each side in the row and everything from the price out
 * to the row's far edge (the longs that go if price falls that far, the shorts if it rises), which the column draws as a curve.
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

/** A point of a cumulative curve: a price and what would be liquidated on the way there from the price. */
export interface CurvePoint { p: number; usd: number }

/**
 * The column's two cumulative curves (as CoinMarketCap's liquidation map draws them, turned upright): from the price, where nothing has gone
 * yet, out through every row's far edge, the longs downward and the shorts upward. A price beyond the rows starts its curve at the rows'
 * edge nearest it, with what lies between already counted, so the part in view is drawn as it stands.
 */
export function liqCurves(prof: LiqProfile, price: number): { long: CurvePoint[]; short: CurvePoint[] } {
  const long: CurvePoint[] = [], short: CurvePoint[] = [], n = prof.long.length;
  if (!(price > 0) || !Number.isFinite(price)) return { long, short };
  for (let r = n - 1; r >= 0; r--) {
    const a = (prof.row0 + r) * prof.step, b = a + prof.step;
    if (a >= price) continue;
    if (!long.length) long.push(b <= price ? { p: b, usd: Math.max(0, prof.cumLong[r]! - prof.long[r]!) } : { p: price, usd: 0 });
    long.push({ p: a, usd: prof.cumLong[r]! });
  }
  for (let r = 0; r < n; r++) {
    const a = (prof.row0 + r) * prof.step, b = a + prof.step;
    if (b <= price) continue;
    if (!short.length) short.push(a >= price ? { p: a, usd: Math.max(0, prof.cumShort[r]! - prof.short[r]!) } : { p: price, usd: 0 });
    short.push({ p: b, usd: prof.cumShort[r]! });
  }
  return { long, short };
}

/** The colour strength of a row's dollars against the largest rows in view (the 97th percentile, so one wallet does not wash out the rest). */
export function heatScale(values: readonly number[]): (usd: number) => number {
  const sorted = values.filter(v => v > 0).sort((a, b) => a - b);
  const top = Math.max(1e5, sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.97))]! : 0);
  return usd => usd < 0.06 * top ? 0 : Math.min(0.9, 0.05 + 0.85 * Math.min(1, usd / top));
}

export interface LiqColors { long: string; short: string; text: string; muted: string; bg: string }

/**
 * Take profits have one look wherever they are drawn (the stripe's lane, the liquidation column, the phone's Liq tab, the Depth pane): dashed
 * strokes in the colour of what the orders do, never a solid fill, so they never read as the levels beside them. One pattern for all.
 */
export const TAKE_DASH: readonly number[] = [4, 3];
/** The dash offset that puts a stroke starting at `x` on the pattern anchored at `anchor`, so dashes line up from row to row. */
export const dashPhase = (x: number, anchor = 0): number => { const n = TAKE_DASH.reduce((a, b) => a + b, 0); return (((x - anchor) % n) + n) % n; };

/** A lane of the stripe, [x0, x1). */
export interface Lane { x0: number; x1: number }
/**
 * Where the stripe's lanes go between the live edge `x0` and the plot's right edge `right`. With take profits, theirs is the lane by the live
 * edge (four tenths of the stripe, half of one under 30 px) and the levels', after a 2 px gap, the one beside the liquidation column, whose
 * curve sums them (Karl, 2026-11-18: the take profits' lane at the right read as the stops'). Without, the levels take the whole stripe.
 */
export function stripeLanes(x0: number, right: number, takes: boolean): { levels: Lane; takes: Lane | null } {
  if (!takes) return { levels: { x0, x1: right }, takes: null };
  const w = right - x0, lane = w >= 30 ? Math.round(w * 0.4) : Math.floor(w / 2);
  return { takes: { x0, x1: x0 + lane }, levels: { x0: Math.min(right, x0 + lane + 2), x1: right } };
}

/**
 * Where a lane's caption goes, given the width its plate needs (a sample and words): inside the lane from its left edge where it fits; else
 * (a narrow stripe: the map following live leaves a few dozen pixels) ending at the lane's right edge and reaching left over the map, so the
 * sample still stands over the lane. Never off the plot's left edge.
 */
export function captionPlace(lane: Lane, need: number): { x: number; w: number } {
  return lane.x1 - lane.x0 - 4 >= need ? { x: lane.x0 + 2, w: need } : { x: Math.max(2, lane.x1 - 2 - need), w: need };
}

/** The colour strength of what still stands of the rows in view (heatScale over each side's standing dollars). */
export const standingHeat = (rows: readonly LiqRow[]): ((usd: number) => number) => heatScale(rows.flatMap(r => [r.longLeft, r.shortLeft]));

/**
 * Draws the rows as a stripe from `x0` (the live edge) to the plot's right edge, beside the profile column: what still stands of each row,
 * the more the darker, with a crisp edge on the strongest on the side facing the price, and a small diamond in the side's colour at the start
 * of a large row one position holds at least half of. A level price has traded through is gone; nothing is drawn over the heatmap's past.
 * Take profits (`dashed`) are dashed strokes instead (`TAKE_DASH`), with no edge and no diamond.
 */
export function paintLiqStripe(ctx: CanvasRenderingContext2D, view: View, x0: number, pw: number, ph: number, rows: readonly LiqRow[], heat: (usd: number) => number, colors: LiqColors, dashed = false): void {
  const w = pw - x0;
  if (w < 2) return;
  ctx.save();
  // Take profits (`dashed`): each row a dashed stroke as tall as the row, the dashes on one pattern from the plot's left edge, never weaker
  // than a third so a small one still reads as dashes, not as a faint level.
  if (dashed) { ctx.setLineDash(TAKE_DASH as number[]); ctx.lineDashOffset = dashPhase(x0); }
  for (const r of rows) {
    const y0 = view.yOf(r.p1, ph), y1 = view.yOf(r.p0, ph);
    if (y1 < 0 || y0 > ph) continue;
    const h = Math.max(1, y1 - y0 - (y1 - y0 > 3 ? 0.5 : 0));
    for (const side of ['long', 'short'] as const) {
      const usd = r[`${side}Left`]; if (usd <= 0) continue;
      const a = heat(usd); if (a <= 0) continue;
      if (dashed) {
        ctx.strokeStyle = side === 'long' ? colors.long : colors.short; ctx.globalAlpha = Math.min(1, 0.3 + a); ctx.lineWidth = h;
        ctx.beginPath(); ctx.moveTo(x0, y0 + h / 2); ctx.lineTo(pw, y0 + h / 2); ctx.stroke();
        continue;
      }
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

/**
 * One set of levels as the page draws it: the levels, the prices the page saw itself since they came (`Seen`), and what price has taken of
 * them, worked out again only when the candles or the prices seen change.
 */
class Layer {
  #seen: Seen | null = null;
  #derived: { key: string; taken: { long: Taken; short: Taken }; standing: LiqStanding } | null = null;
  constructor(readonly levels: LiqLevels) {}
  /** See `LiqLevelsSource.observe`. */
  observe(price: number, now: number): void {
    const levels = this.levels, margin = Math.max(levels.step, price * SEEN_MARGIN);
    const low = Math.min(levels.mark, price + margin), high = Math.max(levels.mark, price - margin), seen = this.#seen;
    if (!seen) { this.#seen = { low, high, lowAt: levels.asOf, highAt: levels.asOf }; return; }
    if (low < seen.low) { seen.low = low; seen.lowAt = now; }
    if (high > seen.high) { seen.high = high; seen.highAt = now; }
  }
  key(candles: KeyLevelHistory): string {
    const l = this.levels, s = this.#seen;
    return `${l.kind}|${l.asOf}|${l.fetchedAt}|${candles.version}|${candles.bars.length}|${s?.low}|${s?.high}`;
  }
  derive(candles: KeyLevelHistory): { taken: { long: Taken; short: Taken }; standing: LiqStanding } {
    const key = this.key(candles);
    if (this.#derived?.key !== key) {
      const taken = takenByCandles(this.levels, candles.bars, this.#seen);
      this.#derived = { key, taken, standing: liqStanding(this.levels, taken) };
    }
    return this.#derived;
  }
}

/** Liquidations and stops added together ("both"): the sum, and what price has taken of it from what it took of each part. */
class SumLayer {
  readonly sum: { levels: LiqLevels; ia: Int32Array; ib: Int32Array };
  #derived: { key: string; taken: { long: Taken; short: Taken }; standing: LiqStanding } | null = null;
  constructor(readonly a: Layer, readonly b: Layer) { this.sum = sumLevels(a.levels, b.levels); }
  get levels(): LiqLevels { return this.sum.levels; }
  key(candles: KeyLevelHistory): string { return `${this.a.key(candles)}+${this.b.key(candles)}`; }
  derive(candles: KeyLevelHistory): { taken: { long: Taken; short: Taken }; standing: LiqStanding } {
    const key = this.key(candles);
    if (this.#derived?.key !== key) {
      const taken = combineTaken(this.sum, this.a.derive(candles).taken, this.b.derive(candles).taken);
      this.#derived = { key, taken, standing: liqStanding(this.sum.levels, taken) };
    }
    return this.#derived;
  }
}

/**
 * Who may read the Plus files: the pass to send (null: none, and then nothing paid is asked for), and whom to tell when the gate refuses
 * the pass it was sent (`Plus.refused`).
 */
export interface LiqPlusAccess { pass(now: number): string | null; refused(pass: string): void }
const MEMBER: LiqPlusAccess = { pass: now => plus().pass(now), refused: pass => plus().refused(pass) };

/** A Plus file the levels need beyond the free one (the groups', the stop and take-profit orders'), as read so far. */
interface PlusPart<T> {
  held: T | null;
  pending: boolean;
  /** Nothing is asked before this (a failed read's wait, a busy server's `Retry-After`). */
  nextAt: number;
  /** The free file's snapshot (its `createdAt`) this part was settled for: asked again once the free file has a newer one. */
  doneFor: number;
  /** Answers holding an older snapshot than the free file's, for the snapshot asked for. */
  tries: number;
  /** How the last read went: not asked yet, being asked, answered, failed, or not there yet (a 503). */
  status: 'idle' | 'loading' | 'ready' | 'failed' | 'waiting';
}
const plusPart = <T>(): PlusPart<T> => ({ held: null, pending: false, nextAt: 0, doneFor: -1, tries: 0, status: 'idle' });
/** A Plus file holding an older snapshot than the free file's is asked again this soon, at most this many times a snapshot. */
const PLUS_AGAIN_MS = 2 * MINUTE, PLUS_TRIES = 3;
/** A 503's `Retry-After` is kept within these bounds (seconds as the server says them, turned into ms). */
const WAIT_MIN_MS = 30_000, WAIT_MAX_MS = 15 * MINUTE;
/** A 503 that says no `Retry-After` (or one the page may not read) waits this long. */
const WAIT_UNSAID_MS = MINUTE;

/** Where the levels for a view stand: drawn, loading, out of date, not read, or nothing for this view in the snapshot (`missing`). */
export type LiqState = 'idle' | 'loading' | 'ready' | 'stale' | 'unavailable' | 'other-coin' | 'off' | 'missing';

/**
 * Loads the files and the candles that take levels away, and keeps them fresh while the levels are on. The free file (liquidation levels of
 * every position) is asked for when the next snapshot can be there (`liq-schedule.ts`); a Plus file the view needs (the groups', the stops'
 * and take profits') is asked for, with the pass, when the free file brings a snapshot it does not have yet. `levels` is what the view draws:
 * the free file's levels, a group's, the stops, or liquidations and stops added together; `takes` the take profits, a layer of their own.
 */
export class LiqLevelsSource {
  state: LiqState = 'idle';
  /** Bumped whenever new levels come. */
  version = 0;
  readonly candles: KeyLevelHistory;
  #view: LiqView = FREE_VIEW;
  #url = '';
  #pending = false;
  #nextAt = 0;
  /** When the snapshot held was created, on the page's clock, the lead the wait for the next is cut by, and the page's clock minus HyperTracker's once learned (`placeSnapshot`). */
  #created = 0;
  #lead = 0;
  #offset: number | null = null;
  /** When the last answered ask was made: a newer snapshot the next ask finds was published after it. */
  #askedAt = -Infinity;
  #failed = false;
  /** The page's clock when last read, to see it set back. */
  #lastNow = -Infinity;
  /** Counts the clock's steps back: an answer to an ask made before one carries the old clock's times and is dropped (it is asked again). */
  #steps = 0;
  #free: Layer | null = null;
  #groups: PlusPart<{ data: LiqGroups; profitable: Layer }> = plusPart();
  #triggers: PlusPart<{ data: LiqTriggers; stops: Layer; takes: Layer }> = plusPart();
  #both: SumLayer | null = null;
  #target: HistoryTarget | null = null;
  /** Which part of the view the state is about: the liquidations' or the orders' (`#settle`). */
  #blame: 'liq' | 'orders' = 'liq';

  constructor(private get: Fetcher = webGet, private now: () => number = Date.now, private url: () => string = () => liqLevelsUrl(),
    private read: LiqFetch = webFetch, private access: LiqPlusAccess = MEMBER) {
    this.candles = new KeyLevelHistory(get, now, CANDLES_MS, 12 * HOUR);
  }

  /** What is drawn (the effective view: the free view without Plus). */
  get view(): LiqView { return this.#view; }

  /** The liquidation levels of the view's traders (every position's, or a group's), or null while they are not held. */
  #liqLayer(): Layer | null {
    const v = this.#view;
    if (v.group === 'all') return this.#free;
    const g = this.#groups.held;
    return g ? g.profitable : null;
  }
  /** What the view draws as its levels (the take profits apart). */
  #main(): Layer | SumLayer | null {
    const v = this.#view;
    if (v.kind === 'stops') return this.#triggers.held?.stops ?? null;
    const liq = this.#liqLayer();
    if (v.kind === 'liq' || !liq) return v.kind === 'liq' ? liq : null;
    const stops = this.#triggers.held?.stops;
    if (!stops) return null;
    // Added up only on one grid (both files bin on the coin's $10 today): another would put the stops in the wrong rows.
    if (stops.levels.step !== liq.levels.step) return null;
    if (this.#both?.a !== liq || this.#both.b !== stops) this.#both = new SumLayer(liq, stops);
    return this.#both;
  }

  /** The levels the view draws, or null. */
  get levels(): LiqLevels | null { return this.#main()?.levels ?? null; }
  /** The take profits (sides swapped: see `LevelsKind`) while the view shows them and they are held, else null. */
  get takes(): LiqLevels | null { return this.#view.takes ? this.#triggers.held?.takes.levels ?? null : null; }
  /** Where the take profits stand: drawn, loading, not read, not there yet (`missing`), or off (the view has none). */
  get takesState(): LiqState {
    if (!this.#view.takes) return 'off';
    return this.#triggers.held ? 'ready' : this.#partState(this.#triggers);
  }
  /** When the positions of the liquidations drawn stood, and the stop and take-profit orders (null: not part of the view or not held). */
  asOfs(): { liq: number | null; orders: number | null } {
    const v = this.#view, orders = v.kind !== 'liq' || v.takes ? this.#triggers.held?.data.asOf ?? null : null;
    return { liq: v.kind === 'stops' ? null : this.#liqLayer()?.levels.asOf ?? null, orders };
  }
  /**
   * Whether the stop and take-profit orders drawn are old enough to say so: older than the levels go stale, or more than about two hours
   * older than the liquidations beside them (not every snapshot has an order file).
   */
  ordersOld(): boolean {
    const { liq, orders } = this.asOfs();
    return orders !== null && (this.now() - orders > STALE_MS || (liq !== null && liq - orders > ORDERS_BEHIND_MS));
  }
  /** Why nothing of the view is drawn where the state is `missing`: no groups or stops there yet. */
  missing(): 'groups' | 'orders' | null {
    if (this.state !== 'missing') return null;
    const v = this.#view;
    return v.kind !== 'stops' && v.group !== 'all' && !this.#groups.held ? 'groups' : 'orders';
  }

  /** Which part of the view the state is about (a view of both: the first part that is not ready). */
  blame(): 'liq' | 'orders' { return this.#blame; }

  /** Keep the levels of `coin` fresh for `view` (the effective one: the free view without Plus); `onChange` runs when anything drawn changes. */
  ensure(coin: Coin, onChange: () => void, view: LiqView = FREE_VIEW): void {
    if (viewKey(view) !== viewKey(this.#view)) { this.#view = view; this.version++; }
    const url = this.url();
    if (!url) { this.state = 'off'; return; }
    if (coin.coin !== BTC.coin) { this.state = 'other-coin'; return; }
    if (url !== this.#url) {
      this.#url = url; this.#free = null; this.#both = null; this.#nextAt = 0; this.#created = 0; this.#lead = 0; this.#offset = null; this.#askedAt = -Infinity; this.#failed = false; this.version++;
      this.#groups = plusPart(); this.#triggers = plusPart();
    }
    const now = this.now();
    // The page's clock went back since it was last read: what the old clock placed and planned is no good (`clockSetBack`).
    if (clockSetBack(this.#lastNow, now)) {
      this.#created = now; this.#lead = MAX_LEAD_MS; this.#offset = null; this.#nextAt = now; this.#askedAt = -Infinity; this.#steps++;
      for (const part of [this.#groups, this.#triggers]) { part.nextAt = now; part.doneFor = -1; part.tries = 0; }
    }
    this.#lastNow = now;
    // Asked when the next snapshot can be there (`liq-schedule.ts`), and not while the page is out of sight: it asks as it shows again.
    if (!this.#pending && now >= this.#nextAt && !pageHidden()) {
      this.#pending = true;
      const asked = url, steps = this.#steps, askedAt = now, onTime = !this.#failed && this.#nextAt > 0 && now - this.#nextAt <= ON_TIME_MS;
      // Asked of the edge every time (a 304 when nothing changed): a CDN can stretch the minute the file asks to be kept, as Cloudflare's
      // zone default did to four hours (2026-11-01).
      void this.get(url, { cache: 'no-cache' }).then(raw => {
        if (asked !== this.#url || steps !== this.#steps) return;
        const levels = parseLiqLevels(raw, BTC.coin);
        if (!levels) { this.#fail(onChange); return; }
        this.#failed = false;
        // Never back to an older snapshot: an edge can hold an older copy for a moment.
        const held = this.#free?.levels;
        if (!held || levels.asOf > held.asOf || (levels.asOf === held.asOf && levels.fetchedAt > held.fetchedAt)) {
          this.#free = new Layer(levels); this.version++;
          // Seen appear between this ask and the one before: placed by when it was published, not by the page's clock against HyperTracker's.
          ({ created: this.#created, lead: this.#lead, offset: this.#offset } = placeSnapshot(levels.createdAt, levels.fetchedAt, this.#askedAt, askedAt, this.#lead, this.#offset, onTime));
        }
        this.#askedAt = askedAt;
        this.#nextAt = nextAskAt(this.#created, this.now(), this.#lead);
        this.#settle();
        // A Plus file the view needs follows the snapshot the free file brought (it is asked for at once, not on the next frame).
        this.#askPlus(onChange);
        onChange();
      }, () => { if (asked === this.#url) this.#fail(onChange); }).finally(() => { this.#pending = false; });
    }
    this.#askPlus(onChange);
    this.#settle();
    // The candles from the earliest snapshot drawn (the stops' is often older than the liquidations').
    const from = [this.#main(), this.#view.takes ? this.#triggers.held?.takes ?? null : null, this.#view.kind === 'both' ? this.#triggers.held?.stops ?? null : null]
      .reduce((m, layer) => layer ? Math.min(m, layer instanceof SumLayer ? Math.min(layer.a.levels.asOf, layer.b.levels.asOf) : layer.levels.asOf) : m, Infinity);
    if (Number.isFinite(from)) {
      const id = instrumentIdFor('hyperliquid', BTC), listing = BTC.markets.hyperliquid;
      if (id && listing) {
        this.#target ??= { id, listing, own: false };
        this.candles.ensure(this.#target, from - MINUTE, MINUTE, onChange);
      }
    }
  }

  /**
   * The Plus files the view needs, asked for with the pass when the free file holds a snapshot they do not have yet: the groups' for a group's
   * liquidations, the orders' for stops and take profits. Nothing paid is asked for without a pass.
   */
  #askPlus(onChange: () => void): void {
    const v = this.#view;
    this.#askPart(this.#groups, v.kind !== 'stops' && v.group !== 'all', 'groups', onChange);
    this.#askPart(this.#triggers, v.kind !== 'liq' || v.takes, 'triggers', onChange);
  }

  #askPart(part: PlusPart<unknown>, want: boolean, which: 'groups' | 'triggers', onChange: () => void): void {
    const urls = plusUrls(this.#url), free = this.#free?.levels, now = this.now();
    if (!want || !urls || !free || part.pending || now < part.nextAt || part.doneFor === free.createdAt || pageHidden()) return;
    const pass = this.access.pass(now);
    if (pass === null) return;
    part.pending = true;
    if (!part.held) part.status = 'loading';
    const asked = this.#url, steps = this.#steps, target = free.createdAt;
    const done = (): void => { this.#settle(); onChange(); };
    void this.read(which === 'groups' ? urls.groups : urls.triggers, pass).then(answer => {
      if (asked !== this.#url || steps !== this.#steps) return;
      const at = this.now();
      if (answer.status === 200) {
        const took = which === 'groups' ? this.#takeGroups(parseLiqGroups(answer.body, BTC.coin)) : this.#takeTriggers(parseTriggers(answer.body, BTC.coin));
        if (took === null) { part.status = 'failed'; part.nextAt = at + RETRY_MS; done(); return; }
        part.status = 'ready';
        // The snapshot asked for, or a newer one: settled until the free file brings another. An older one (the order file not read yet, an
        // edge's copy): asked again a little later, a few times.
        if (took >= target || ++part.tries >= PLUS_TRIES) { part.doneFor = target; part.tries = 0; } else part.nextAt = at + PLUS_AGAIN_MS;
      } else if (isRefusal(answer)) {
        // The gate would not take this pass: it is dropped and renewed (`Plus.refused`); the file is asked again with the next one.
        this.access.refused(pass);
        if (!part.held) part.status = 'failed';
        part.nextAt = at + RETRY_MS;
      } else if (answer.status === 503) {
        // Not there yet (no groups for this snapshot, no order file read yet): asked again when the server says.
        if (!part.held) part.status = 'waiting';
        // The gate may not let the page read the header (CORS): then a minute.
        part.nextAt = at + (answer.retryAfter !== undefined ? Math.min(WAIT_MAX_MS, Math.max(WAIT_MIN_MS, answer.retryAfter * 1_000)) : WAIT_UNSAID_MS);
      } else {
        if (!part.held) part.status = 'failed';
        part.nextAt = at + RETRY_MS;
      }
      done();
    }, () => {
      if (asked !== this.#url || steps !== this.#steps) return;
      if (!part.held) part.status = 'failed';
      part.nextAt = this.now() + RETRY_MS; done();
    }).finally(() => { part.pending = false; });
  }

  /** Keeps a groups file when it is newer than the one held; returns its snapshot's `createdAt`, or null for a malformed file. */
  #takeGroups(g: LiqGroups | null): number | null {
    if (!g) return null;
    const held = this.#groups.held?.data;
    if (!held || g.asOf > held.asOf || (g.asOf === held.asOf && g.fetchedAt > held.fetchedAt)) {
      this.#groups.held = { data: g, profitable: new Layer(g.profitable) }; this.version++;
    }
    return g.createdAt;
  }
  /** Keeps an orders file when it is newer than the one held; returns its snapshot's `createdAt`, or null for a malformed file. */
  #takeTriggers(o: LiqTriggers | null): number | null {
    if (!o) return null;
    const held = this.#triggers.held?.data;
    if (!held || o.asOf > held.asOf || (o.asOf === held.asOf && o.fetchedAt > held.fetchedAt)) {
      this.#triggers.held = { data: o, stops: new Layer(o.stops), takes: new Layer(o.takes) }; this.version++;
    }
    return o.createdAt;
  }

  #fail(onChange: () => void): void {
    this.#failed = true; this.#nextAt = this.now() + RETRY_MS;
    this.#settle();
    onChange();
  }

  /** Where a Plus part not held stands. */
  #partState(part: PlusPart<unknown>): LiqState {
    return part.status === 'failed' ? 'unavailable' : part.status === 'waiting' ? 'missing' : 'loading';
  }

  /**
   * The state from what is held, for the view: levels too old to draw are stale; none yet is loading, or unavailable once a read failed; a
   * Plus part that holds nothing for the view yet (a 503) is missing. Stops are never stale: an old order file is
   * said (`ordersOld`), not hidden.
   */
  #settle(): void {
    const v = this.#view, free = this.#free;
    const freeState: LiqState = !free ? (this.#failed ? 'unavailable' : 'loading') : 'ready';
    const liqState = (): LiqState => {
      if (v.group === 'all') return freeState;
      const g = this.#groups.held;
      if (!g) return freeState !== 'ready' ? freeState : this.#partState(this.#groups);
      return 'ready';
    };
    const fresh = (s: LiqState): LiqState => {
      const liq = this.#liqLayer();
      return s === 'ready' && liq && this.now() - liq.levels.asOf > STALE_MS ? 'stale' : s;
    };
    const stops = (): LiqState => this.#triggers.held ? 'ready' : freeState !== 'ready' ? freeState : this.#partState(this.#triggers);
    // Both on two grids cannot be added up (`#main`): said as orders that could not be read.
    const grids = (): boolean => { const liq = this.#liqLayer(), o = this.#triggers.held; return !liq || !o || liq.levels.step === o.stops.levels.step; };
    if (v.kind === 'liq') { this.state = fresh(liqState()); this.#blame = 'liq'; return; }
    if (v.kind === 'stops') { this.state = stops(); this.#blame = 'orders'; return; }
    // Both: the first part not ready says why nothing is drawn.
    const a = fresh(liqState()), b = stops();
    this.state = a !== 'ready' ? a : b !== 'ready' ? b : grids() ? 'ready' : 'unavailable'; this.#blame = a !== 'ready' ? 'liq' : 'orders';
  }

  /**
   * The chart's price now, in dollars. Price cannot have come from the snapshot's mark to here without trading through every level between,
   * so those go at once, whatever the candles say yet (and if they cannot be read); later highs and lows take levels as they come.
   */
  observe(price: number): void {
    if (!(price > 0) || !Number.isFinite(price)) return;
    const now = this.now(), g = this.#groups.held, o = this.#triggers.held;
    for (const layer of [this.#free, g?.profitable, o?.stops, o?.takes]) layer?.observe(price, now);
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
  key(): string { const main = this.#main(); return main ? `${viewKey(this.#view)}|${main.key(this.candles)}` : ''; }
  /** The same for the take profits. */
  takesKey(): string { const t = this.#view.takes ? this.#triggers.held?.takes : null; return t ? t.key(this.candles) : ''; }

  /** How far price has traded through each bin, worked out again only when the levels, the candles or the prices seen changed. */
  taken(): { long: Taken; short: Taken } | null { return this.#main()?.derive(this.candles).taken ?? null; }
  /** What stands of each side, added up, for the profile column. */
  standing(): LiqStanding | null { return this.#main()?.derive(this.candles).standing ?? null; }
  /** Liquidations and stops apart while the view adds them up (see `LiqParts`), else null. */
  partStandings(): LiqParts | null {
    const main = this.#main();
    return main instanceof SumLayer ? { liq: main.a.derive(this.candles).standing, stops: main.b.derive(this.candles).standing } : null;
  }
  /** The same two for the take profits. */
  takesTaken(): { long: Taken; short: Taken } | null { const t = this.#view.takes ? this.#triggers.held?.takes : null; return t ? t.derive(this.candles).taken : null; }
  takesStanding(): LiqStanding | null { const t = this.#view.takes ? this.#triggers.held?.takes : null; return t ? t.derive(this.candles).standing : null; }
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
