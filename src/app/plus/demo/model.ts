/**
 * What the demo's chart draws, as numbers (no page needed, so it is tested): the levels of each price at the window's end, the running
 * totals out from the price, and the Depth pane's totals through the window.
 *
 * The curve adds up the liquidations and/or stops that are on; take profits are never in it. They are bars of their own beside it, or,
 * when they are the one kind on, drawn alone with a dashed curve of their own (`tU`, `tD`).
 */
import { BANDS, HH, LIQ, PMAX, PMIN, ROW0, ROW_STEP, ROWS, SNAP_HH, SNAPS, STOP, TP, bandIndex, priceAt, type DemoData } from './data.ts';
import type { DemoLevels } from './store.ts';

/** How much of each layer is drawn, 0 to 1 (between two choices while the chart moves from one to the other). */
export interface Weights {
  liq: number; stop: number; tp: number;
  /** 1 for the profitable traders, 0 for everyone. */
  grp: number;
  /** 1 when take profits are the one kind on (their own curve, in the main lane). */
  alone: number;
}
export const weightsOf = (s: DemoLevels): Weights => ({ liq: +s.liq, stop: +s.stops, tp: +s.takes, grp: s.traders === 'profitable' ? 1 : 0, alone: s.takes && !s.liq && !s.stops ? 1 : 0 });
export const sameWeights = (a: Weights, b: Weights): boolean => a.liq === b.liq && a.stop === b.stop && a.tp === b.tp && a.grp === b.grp && a.alone === b.alone;

/** One price bucket of the chart: rows `r0` to `r1` of the data, prices `lo` to `hi`. */
export interface Bucket { r0: number; r1: number; lo: number; hi: number }
/** The price rows inside the chart's prices, `agg` rows to a bucket (a phone's chart takes two), lowest first. */
export function bucketsOf(agg: number): Bucket[] {
  const rA = Math.ceil((PMIN - ROW0) / ROW_STEP), rB = Math.floor((PMAX - ROW0) / ROW_STEP) - 1, out: Bucket[] = [];
  for (let r = rA; r <= rB; r += agg) { const r1 = Math.min(r + agg - 1, rB); out.push({ r0: r, r1, lo: ROW0 + r * ROW_STEP, hi: ROW0 + (r1 + 1) * ROW_STEP }); }
  return out;
}

/** The two snapshots a window's end falls between, and how far from the first. */
export function snapshotAt(end: number): { c0: number; c1: number; f: number } {
  const T = Math.max(0, Math.min(SNAPS - 1, (end - 3) / SNAP_HH)), c0 = Math.floor(T);
  return { c0, c1: Math.min(SNAPS - 1, c0 + 1), f: T - c0 };
}

export interface Levels {
  /** Per bucket, in dollars: liquidations of shorts (above the price) and longs (below), stops of shorts and longs, take profits of longs
   * (above) and shorts (below). The profitable traders' are as precise as everyone's, with their own amounts. */
  lS: Float64Array; lL: Float64Array; sS: Float64Array; sL: Float64Array; tL: Float64Array; tS: Float64Array;
  /** Running totals out from the price, above and below: the curve (liquidations and/or stops), and the take profits' own when they are alone. */
  cU: Float64Array; cD: Float64Array; tU: Float64Array; tD: Float64Array;
  /** The bucket the price is in. */
  pb: number;
  price: number;
  /** The longest bar drawn (a bucket's liquidations and stops together, or its take profits), the largest amount of any kind (how strong a
   * level line is), and the largest running total. Each at least 1. */
  levelMax: number; levelRef: number; cumMax: number;
}

const ARRAYS = ['lS', 'lL', 'sS', 'sL', 'tL', 'tS', 'cU', 'cD', 'tU', 'tD'] as const;
export function emptyLevels(n: number): Levels {
  const out = { pb: 0, price: 0, levelMax: 1, levelRef: 1, cumMax: 1 } as Levels;
  for (const k of ARRAYS) out[k] = new Float64Array(n);
  return out;
}

/** The levels at half hour `end` (between two snapshots, on the line between them), for `w`, into `out` (made when not given). */
export function levelsAt(d: DemoData, bk: readonly Bucket[], end: number, w: Weights, out: Levels = emptyLevels(bk.length)): Levels {
  const n = bk.length, g = w.grp, { c0, c1, f } = snapshotAt(end), P = priceAt(d, end);
  const { lS, lL, sS, sL, tL, tS, cU, cD, tU, tD } = out;
  let pb = 0;
  for (let b = 0; b < n; b++) {
    const k = bk[b]!;
    if (k.lo <= P) pb = b;
    let a0 = 0, a1 = 0, a2 = 0, a3 = 0, a4 = 0, a5 = 0;
    for (let r = k.r0; r <= k.r1; r++) {
      const i0 = c0 * ROWS + r, i1 = c1 * ROWS + r, m = (arr: Float32Array): number => arr[i0]! * (1 - f) + arr[i1]! * f;
      const kl = 1 - g + g * m(d.pfLiq), ks = 1 - g + g * m(d.pfStop), kt = 1 - g + g * m(d.pfTp);
      a0 += m(d.liqS) * kl; a1 += m(d.liqL) * kl; a2 += m(d.stopS) * ks; a3 += m(d.stopL) * ks; a4 += m(d.tpL) * kt; a5 += m(d.tpS) * kt;
    }
    lS[b] = a0; lL[b] = a1; sS[b] = a2; sL[b] = a3; tL[b] = a4; tS[b] = a5;
  }
  let levelMax = 1, levelRef = 1;
  for (let b = 0; b < n; b++) {
    levelMax = Math.max(levelMax, w.liq * lS[b]! + w.stop * sS[b]!, w.liq * lL[b]! + w.stop * sL[b]!, w.tp * tL[b]!, w.tp * tS[b]!);
    levelRef = Math.max(levelRef, lS[b]!, lL[b]!, sS[b]!, sL[b]!, tL[b]!, tS[b]!);
  }
  cU.fill(0); cD.fill(0); tU.fill(0); tD.fill(0);
  let run = 0, runT = 0;
  for (let b = pb; b < n; b++) { run += w.liq * lS[b]! + w.stop * sS[b]!; runT += tL[b]!; cU[b] = run; tU[b] = w.alone * runT; }
  run = 0; runT = 0;
  for (let b = pb; b >= 0; b--) { run += w.liq * lL[b]! + w.stop * sL[b]!; runT += tS[b]!; cD[b] = run; tD[b] = w.alone * runT; }
  let cumMax = 1;
  for (let b = pb; b < n; b++) cumMax = Math.max(cumMax, cU[b]!, tU[b]!);
  for (let b = pb; b >= 0; b--) cumMax = Math.max(cumMax, cD[b]!, tD[b]!);
  out.pb = pb; out.price = P; out.levelMax = levelMax; out.levelRef = levelRef; out.cumMax = cumMax;
  return out;
}

/** How strong a level line is drawn (0 strongest, 2 faintest), or -1 for none, from its share of the largest amount. */
export const strengthOf = (share: number): number => share >= 0.45 ? 0 : share >= 0.2 ? 1 : share >= 0.09 ? 2 : -1;

/** One snapshot of the Depth pane: above (`up`) and below (`dn`) the price within each distance, and the take profits within the widest. */
export interface DepthColumn { c: number; up: number[]; dn: number[]; tu: number; td: number }

/** The Depth pane over the window from half hour `start` to `end`: a column for each snapshot in it, and the largest total drawn. */
export function depthColumns(d: DemoData, start: number, end: number, w: Weights): { cols: DepthColumn[]; max: number } {
  const g = w.grp, cA = Math.max(0, Math.floor(start / SNAP_HH)), cB = Math.min(SNAPS - 1, Math.floor((end - 0.001) / SNAP_HH));
  const cols: DepthColumn[] = [];
  let max = 1;
  const at = (c: number, gg: number, kind: number, side: number, k: number): number => d.band[bandIndex(c, gg, kind, side, k)]!;
  for (let c = cA; c <= cB; c++) {
    const up: number[] = [], dn: number[] = [];
    for (let k = 0; k < BANDS.length; k++) {
      const e = (gg: number, side: number): number => w.liq * at(c, gg, LIQ, side, k) + w.stop * at(c, gg, STOP, side, k);
      up.push((1 - g) * e(0, 0) + g * e(1, 0)); dn.push((1 - g) * e(0, 1) + g * e(1, 1));
    }
    const last = BANDS.length - 1;
    const tu = w.tp * ((1 - g) * at(c, 0, TP, 0, last) + g * at(c, 1, TP, 0, last));
    const td = w.tp * ((1 - g) * at(c, 0, TP, 1, last) + g * at(c, 1, TP, 1, last));
    max = Math.max(max, up[last]!, dn[last]!, tu, td);
    cols.push({ c, up, dn, tu, td });
  }
  return { cols, max };
}

/** The Depth pane's table at half hour `end`: per distance, the shorts' total above the price and the longs' below (liquidations and/or stops). */
export function depthTable(d: DemoData, end: number, w: Weights): { up: number[]; dn: number[] } {
  const g = w.grp, { c0, c1, f } = snapshotAt(end), up: number[] = [], dn: number[] = [];
  const B = (gg: number, kind: number, side: number, k: number): number => d.band[bandIndex(c0, gg, kind, side, k)]! * (1 - f) + d.band[bandIndex(c1, gg, kind, side, k)]! * f;
  for (let k = 0; k < BANDS.length; k++) {
    const e = (gg: number, side: number): number => w.liq * B(gg, LIQ, side, k) + w.stop * B(gg, STOP, side, k);
    up.push((1 - g) * e(0, 0) + g * e(1, 0)); dn.push((1 - g) * e(0, 1) + g * e(1, 1));
  }
  return { up, dn };
}

/** The demo's window: 7 days, its end moved by the history scrubber from the oldest week (0) to now (1). */
export const DEMO_WIN = 7 * 48;
export const windowEnd = (scrub: number): number => DEMO_WIN + Math.max(0, Math.min(1, scrub)) * (HH - 1 - DEMO_WIN);
