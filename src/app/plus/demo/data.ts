/**
 * The Plus demo's numbers, made up from one seeded generator: the same on every load and in every test, and nothing of them is market data
 * or fetched. A price trace over 21 days of half hours; in a snapshot every two hours, the liquidation, stop and take-profit levels of each
 * price row, and the profitable traders' share of each; and the Depth pane's totals within each distance of the price (everyone and the
 * profitable traders, per kind and side). Built once, on first use (`demoData`), never at import.
 */

export const SEED = 20_261_118;
export const NOW_PRICE = 62_840;
/** Half hours drawn: 21 days, the last one at the right edge (now). */
export const HH = 21 * 48;
/** Half hours from one snapshot of the levels to the next (two hours). */
export const SNAP_HH = 4;
export const SNAPS = HH / SNAP_HH;
/** The last 7 days are free; the rest of the history is Plus. */
export const FREE_HH = 7 * 48;
/** The price rows the levels are kept on. */
export const ROW_STEP = 250, ROW0 = 45_000, ROWS = 160;
/** The Depth pane's distances from the price, in per cent. */
export const BANDS: readonly number[] = [1.25, 2.5, 5, 10, 20];
/** The prices the charts show. */
export const PMIN = NOW_PRICE * 0.89, PMAX = NOW_PRICE * 1.11;
/** The first half hour drawn: October 28, 2026, 18:00 UTC, the day the real archive starts. */
export const START_MS = Date.UTC(2026, 9, 28, 18, 0);
export const HALF_HOUR_MS = 1_800_000;

/** Kinds of level in the Depth totals. */
export const LIQ = 0, STOP = 1, TP = 2;
/** Where one Depth total sits: snapshot `c`, group `g` (0 everyone, 1 profitable), kind, side (0 above the price, 1 below), distance `k`. */
export const bandIndex = (c: number, g: number, kind: number, side: number, k: number): number => ((((c * 2 + g) * 3 + kind) * 2 + side) * 5 + k);

const clamp = (v: number, a: number, b: number): number => Math.max(a, Math.min(b, v));

/** A small seeded generator of numbers in [0, 1): the same sequence for the same seed everywhere. */
export function mulberry32(seed: number): () => number {
  let a = seed | 0;
  return () => {
    a = a + 0x6D2B79F5 | 0;
    let t = Math.imul(a ^ a >>> 15, 1 | a);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}

export interface DemoData {
  /** The price at each half hour; the last is `NOW_PRICE`. */
  readonly price: Float64Array;
  /** Per snapshot and price row (`c * ROWS + r`), in dollars: liquidations of longs (below the price) and shorts (above), stops likewise,
   * take profits of longs (above) and shorts (below). */
  readonly liqL: Float32Array; readonly liqS: Float32Array;
  readonly stopL: Float32Array; readonly stopS: Float32Array;
  readonly tpL: Float32Array; readonly tpS: Float32Array;
  /** The profitable traders' share of each row (0 to 1), per kind: small on most rows and large on a few, so their levels have a shape of their own. */
  readonly pfLiq: Float32Array; readonly pfStop: Float32Array; readonly pfTp: Float32Array;
  /** The Depth totals, by `bandIndex`. */
  readonly band: Float32Array;
}

/** The demo's numbers for `seed` (the demo uses `SEED`). */
export function createData(seed: number = SEED): DemoData {
  const rnd = mulberry32(seed);
  const gauss = (): number => { let u = 0; while (u === 0) u = rnd(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rnd()); };
  // The trace's shape: a few turns, eased into one another, with a random walk over them that ends where it started.
  const anchors: readonly (readonly [number, number])[] = [[0, 65_200], [140, 66_700], [250, 67_300], [380, 64_700], [470, 63_100], [590, 65_500], [700, 64_500], [800, 63_300], [905, 63_900], [HH - 1, NOW_PRICE]];
  const noise = new Float64Array(HH);
  let walk = 0;
  for (let i = 0; i < HH; i++) { walk = walk * 0.982 + gauss() * 0.0026; noise[i] = walk; }
  const end = noise[HH - 1]!;
  const price = new Float64Array(HH);
  let k = 0;
  for (let i = 0; i < HH; i++) {
    while (k < anchors.length - 2 && i > anchors[k + 1]![0]) k++;
    const [i0, p0] = anchors[k]!, [i1, p1] = anchors[k + 1]!;
    const f = clamp((i - i0) / (i1 - i0), 0, 1), e = (1 - Math.cos(Math.PI * f)) / 2;
    price[i] = clamp((p0 + (p1 - p0) * e) * Math.exp(noise[i]! - end * i / (HH - 1)), PMIN * 1.02, PMAX * 0.98);
  }
  price[HH - 1] = NOW_PRICE;
  const hash = (a: number, b: number): number => { let x = (Math.imul(a, 374761393) + Math.imul(b, 668265263) + 1013904223) | 0; x = Math.imul(x ^ (x >>> 13), 1274126177); x ^= x >>> 16; return (x >>> 0) / 4294967296; };
  // Noise that drifts slowly from one snapshot to the next, so a level lives for a while.
  const smooth = (r: number, c: number, salt: number): number => { const d = c / 30 + hash(r, salt) * 0.999, d0 = Math.floor(d), f = d - d0, e = f * f * (3 - 2 * f), a = r * 7 + salt * 7919; return hash(a, d0) * (1 - e) + hash(a, d0 + 1) * e; };
  const bump = (x: number, c: number, s: number): number => { const z = (x - c) / s; return Math.exp(-0.5 * z * z); };
  const n = SNAPS * ROWS;
  const liqL = new Float32Array(n), liqS = new Float32Array(n), stopL = new Float32Array(n), stopS = new Float32Array(n), tpL = new Float32Array(n), tpS = new Float32Array(n);
  const pfLiq = new Float32Array(n), pfStop = new Float32Array(n), pfTp = new Float32Array(n);
  // Round prices where orders gather and stay, snapshot after snapshot.
  const sticky: Readonly<Record<'liqL' | 'liqS' | 'stopL' | 'stopS' | 'tpL' | 'tpS', readonly (readonly [number, number])[]>> = {
    liqL: [[60_000, 1], [58_500, 0.7], [57_000, 0.6], [61_500, 0.35]], liqS: [[65_000, 1], [66_500, 0.55], [68_000, 0.8], [70_000, 0.5]],
    stopL: [[61_000, 0.8], [60_000, 1], [59_000, 0.45]], stopS: [[64_000, 0.75], [65_000, 1], [66_000, 0.45]],
    tpL: [[65_000, 1], [66_000, 0.55], [68_000, 0.7], [70_000, 0.9]], tpS: [[60_000, 1], [59_000, 0.5], [58_000, 0.8], [56_000, 0.6]],
  };
  const stick = (list: readonly (readonly [number, number])[], y: number, c: number): number => { let v = 0; for (const [p, a] of list) if (Math.abs(y - p) < ROW_STEP / 2) v += a * (0.75 + 0.25 * Math.sin(c / 31 + p / 997)); return v; };
  for (let c = 0; c < SNAPS; c++) {
    const P = price[c * SNAP_HH + 3]!;
    for (let r = 0; r < ROWS; r++) {
      const y = ROW0 + (r + 0.5) * ROW_STEP, d = (y - P) / P * 100, ad = Math.abs(d), i = c * ROWS + r;
      const taper = Math.min(1, ad / 0.35), n1 = smooth(r, c, 1), n2 = smooth(r, c, 2), n3 = smooth(r, c, 3);
      if (d < 0) {
        liqL[i] = taper * 6.0e6 * ((1.0 * bump(ad, 2.4, 0.9) + 1.35 * bump(ad, 5.3, 1.4) + 1.1 * bump(ad, 9.2, 2.4) + 0.55 * bump(ad, 15, 4)) * (0.1 + 2.1 * n1 * n1 * n1) + 5 * stick(sticky.liqL, y, c));
        stopL[i] = taper * 2.6e6 * ((1.2 * bump(ad, 0.9, 0.55) + 1.0 * bump(ad, 2.7, 0.9) + 0.35 * bump(ad, 6, 2.2)) * (0.08 + 2.3 * n2 * n2 * n2) + 4 * stick(sticky.stopL, y, c));
        tpS[i] = taper * 2.1e6 * ((0.8 * bump(ad, 2.9, 1.0) + 1.0 * bump(ad, 6.2, 1.8) + 0.4 * bump(ad, 11, 3)) * (0.08 + 2.2 * n3 * n3 * n3) + 5 * stick(sticky.tpS, y, c));
      } else {
        liqS[i] = taper * 6.0e6 * ((0.9 * bump(ad, 2.0, 0.8) + 1.3 * bump(ad, 4.7, 1.3) + 1.15 * bump(ad, 8.4, 2.3) + 0.5 * bump(ad, 14, 4)) * (0.1 + 2.1 * n1 * n1 * n1) + 5 * stick(sticky.liqS, y, c));
        stopS[i] = taper * 2.6e6 * ((1.1 * bump(ad, 1.0, 0.6) + 0.9 * bump(ad, 3.1, 1.0) + 0.35 * bump(ad, 6.5, 2.2)) * (0.08 + 2.3 * n2 * n2 * n2) + 4 * stick(sticky.stopS, y, c));
        tpL[i] = taper * 2.1e6 * ((0.8 * bump(ad, 2.6, 1.0) + 1.0 * bump(ad, 5.6, 1.7) + 0.4 * bump(ad, 10.5, 3)) * (0.08 + 2.2 * n3 * n3 * n3) + 5 * stick(sticky.tpL, y, c));
      }
      const q1 = smooth(r, c, 11), q2 = smooth(r, c, 12), q3 = smooth(r, c, 13);
      pfLiq[i] = 0.05 + 0.6 * q1 * q1;
      pfStop[i] = 0.05 + 0.55 * q2 * q2;
      pfTp[i] = 0.06 + 0.6 * q3 * q3;
    }
  }
  // The Depth pane's totals per snapshot: everyone (g 0) and the profitable traders (g 1), per kind, per side, within each distance.
  const band = new Float32Array(SNAPS * 60);
  const kinds: readonly (readonly [Float32Array, Float32Array, Float32Array])[] = [[liqS, liqL, pfLiq], [stopS, stopL, pfStop], [tpL, tpS, pfTp]];
  for (let c = 0; c < SNAPS; c++) {
    const P = price[c * SNAP_HH + 3]!;
    for (let kind = 0; kind < 3; kind++) {
      const [up, dn, pf] = kinds[kind]!;
      for (let r = 0; r < ROWS; r++) {
        const y = ROW0 + (r + 0.5) * ROW_STEP, d = (y - P) / P * 100, ad = Math.abs(d), i = c * ROWS + r;
        const side = d >= 0 ? 0 : 1, v = side === 0 ? up[i]! : dn[i]!;
        if (!v) continue;
        for (let b = 0; b < BANDS.length; b++) if (ad <= BANDS[b]!) { band[bandIndex(c, 0, kind, side, b)] += v; band[bandIndex(c, 1, kind, side, b)] += v * pf[i]!; }
      }
    }
  }
  return { price, liqL, liqS, stopL, stopS, tpL, tpS, pfLiq, pfStop, pfTp, band };
}

let shared: DemoData | null = null;
/** The demo's numbers, built on first use and shared by the demo and the feature pictures. */
export const demoData = (): DemoData => shared ??= createData();

/** The price at half hour `hh` (between two half hours, on the line between them). */
export function priceAt(d: DemoData, hh: number): number {
  if (hh <= 0) return d.price[0]!;
  if (hh >= HH - 1) return d.price[HH - 1]!;
  const i = Math.floor(hh), f = hh - i;
  return d.price[i]! * (1 - f) + d.price[i + 1]! * f;
}
