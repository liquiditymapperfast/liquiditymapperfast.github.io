/**
 * The Plus demo's numbers, made up from one seeded generator: the same on every load and in every test, and nothing of them is market data
 * or fetched. A price trace over 21 days of half hours; in a snapshot every two hours, the liquidation, stop and take-profit levels of each
 * price row, and the profitable traders' share of each; and the Depth pane's totals within each distance of the price (everyone and the
 * profitable traders, per kind and side). Built once, never at import: the demo and its pictures ask for it with `whenData`, which builds it a
 * few snapshots at a time when the page is idle (the demo's frame paints first: a slow phone took 140-180 ms in one go), and every later
 * mount has it at once.
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

/** The demo's numbers for `seed`, a snapshot a step (each `next()` builds one; the last returns them all). */
function* building(seed: number): Generator<void, DemoData, void> {
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
  // Noise that drifts slowly from one snapshot to the next, so a level lives for a while: per row and salt, a value every 30 snapshots
  // (from an offset of the row's own), eased from one to the next. The hashes it eases between are worked out once per row and salt, not
  // once per snapshot (the same numbers, a sixth of a phone's time).
  const SALTS = [1, 2, 3, 11, 12, 13], STEPS = Math.ceil((SNAPS - 1) / 30) + 2;
  const offsets = SALTS.map(salt => Float64Array.from({ length: ROWS }, (_, r) => hash(r, salt) * 0.999));
  const knots = SALTS.map(salt => { const t = new Float64Array(ROWS * STEPS); for (let r = 0; r < ROWS; r++) for (let k = 0; k < STEPS; k++) t[r * STEPS + k] = hash(r * 7 + salt * 7919, k); return t; });
  const smooth = (r: number, c: number, salt: number): number => {
    const s = SALTS.indexOf(salt), d = c / 30 + offsets[s]![r]!, d0 = Math.floor(d), f = d - d0, e = f * f * (3 - 2 * f), t = knots[s]!, i = r * STEPS + d0;
    return t[i]! * (1 - e) + t[i + 1]! * e;
  };
  const bump = (x: number, c: number, s: number): number => { const z = (x - c) / s; return Math.exp(-0.5 * z * z); };
  const n = SNAPS * ROWS;
  const liqL = new Float32Array(n), liqS = new Float32Array(n), stopL = new Float32Array(n), stopS = new Float32Array(n), tpL = new Float32Array(n), tpS = new Float32Array(n);
  const pfLiq = new Float32Array(n), pfStop = new Float32Array(n), pfTp = new Float32Array(n);
  // (The prototype also added levels at a few round prices, but none of them fell inside a row: each sits on the edge between two rows, so
  // they added nothing. Left out; the numbers are the same.)
  // The Depth pane's totals per snapshot: everyone (g 0) and the profitable traders (g 1), per kind, per side, within each distance.
  const band = new Float32Array(SNAPS * 60);
  const kinds: readonly (readonly [Float32Array, Float32Array, Float32Array])[] = [[liqS, liqL, pfLiq], [stopS, stopL, pfStop], [tpL, tpS, pfTp]];
  for (let c = 0; c < SNAPS; c++) {
    const P = price[c * SNAP_HH + 3]!;
    for (let r = 0; r < ROWS; r++) {
      const y = ROW0 + (r + 0.5) * ROW_STEP, d = (y - P) / P * 100, ad = Math.abs(d), i = c * ROWS + r;
      const taper = Math.min(1, ad / 0.35), n1 = smooth(r, c, 1), n2 = smooth(r, c, 2), n3 = smooth(r, c, 3);
      if (d < 0) {
        liqL[i] = taper * 6.0e6 * ((1.0 * bump(ad, 2.4, 0.9) + 1.35 * bump(ad, 5.3, 1.4) + 1.1 * bump(ad, 9.2, 2.4) + 0.55 * bump(ad, 15, 4)) * (0.1 + 2.1 * n1 * n1 * n1));
        stopL[i] = taper * 2.6e6 * ((1.2 * bump(ad, 0.9, 0.55) + 1.0 * bump(ad, 2.7, 0.9) + 0.35 * bump(ad, 6, 2.2)) * (0.08 + 2.3 * n2 * n2 * n2));
        tpS[i] = taper * 2.1e6 * ((0.8 * bump(ad, 2.9, 1.0) + 1.0 * bump(ad, 6.2, 1.8) + 0.4 * bump(ad, 11, 3)) * (0.08 + 2.2 * n3 * n3 * n3));
      } else {
        liqS[i] = taper * 6.0e6 * ((0.9 * bump(ad, 2.0, 0.8) + 1.3 * bump(ad, 4.7, 1.3) + 1.15 * bump(ad, 8.4, 2.3) + 0.5 * bump(ad, 14, 4)) * (0.1 + 2.1 * n1 * n1 * n1));
        stopS[i] = taper * 2.6e6 * ((1.1 * bump(ad, 1.0, 0.6) + 0.9 * bump(ad, 3.1, 1.0) + 0.35 * bump(ad, 6.5, 2.2)) * (0.08 + 2.3 * n2 * n2 * n2));
        tpL[i] = taper * 2.1e6 * ((0.8 * bump(ad, 2.6, 1.0) + 1.0 * bump(ad, 5.6, 1.7) + 0.4 * bump(ad, 10.5, 3)) * (0.08 + 2.2 * n3 * n3 * n3));
      }
      const q1 = smooth(r, c, 11), q2 = smooth(r, c, 12), q3 = smooth(r, c, 13);
      pfLiq[i] = 0.05 + 0.6 * q1 * q1;
      pfStop[i] = 0.05 + 0.55 * q2 * q2;
      pfTp[i] = 0.06 + 0.6 * q3 * q3;
    }
    // Its Depth totals (each total adds its rows in the same order as when they were worked out after every snapshot: the same numbers).
    for (let kind = 0; kind < 3; kind++) {
      const [up, dn, pf] = kinds[kind]!;
      for (let r = 0; r < ROWS; r++) {
        const y = ROW0 + (r + 0.5) * ROW_STEP, d = (y - P) / P * 100, ad = Math.abs(d), i = c * ROWS + r;
        const side = d >= 0 ? 0 : 1, v = side === 0 ? up[i]! : dn[i]!;
        if (!v) continue;
        for (let b = 0; b < BANDS.length; b++) if (ad <= BANDS[b]!) { band[bandIndex(c, 0, kind, side, b)] += v; band[bandIndex(c, 1, kind, side, b)] += v * pf[i]!; }
      }
    }
    yield;
  }
  return { price, liqL, liqS, stopL, stopS, tpL, tpS, pfLiq, pfStop, pfTp, band };
}

/** The demo's numbers for `seed` (the demo uses `SEED`), all at once. */
export function createData(seed: number = SEED): DemoData {
  const run = building(seed);
  for (;;) { const step = run.next(); if (step.done) return step.value; }
}

/** The numbers once built, and a build under way: its steps so far, who waits for it, its next turn (an idle callback, else a timeout). */
let shared: DemoData | null = null;
interface Build { run: Generator<void, DemoData, void>; waiters: Set<(d: DemoData) => void>; job: number | null; idle: boolean }
let build: Build | null = null;

function done(b: Build, d: DemoData): void {
  shared = d; build = null;
  // Each waiter is taken off as its turn comes, not all at once: one that an earlier one stopped waiting (a mount it destroyed) is not called.
  // One that throws does not keep the numbers from the rest; its error is thrown again afterwards, on its own, so it is still seen.
  const failed: unknown[] = [];
  for (const ready of [...b.waiters]) {
    if (!b.waiters.delete(ready)) continue;
    try { ready(d); } catch (error) { failed.push(error); }
  }
  for (const error of failed) queueMicrotask(() => { throw error; });
}
function unplan(b: Build): void {
  if (b.job === null) return;
  if (b.idle) window.cancelIdleCallback(b.job); else window.clearTimeout(b.job);
  b.job = null;
}
function plan(b: Build): void {
  if (b.job !== null) return;
  b.idle = typeof window.requestIdleCallback === 'function';
  b.job = b.idle ? window.requestIdleCallback(deadline => work(b, deadline), { timeout: 150 }) : window.setTimeout(() => work(b, null), 0);
}
/** One turn: snapshots while the page is idle (about 6 ms where it cannot say), at least one; then the next turn, while someone waits. */
function work(b: Build, deadline: IdleDeadline | null): void {
  b.job = null;
  const t0 = performance.now();
  const more = (): boolean => deadline && !deadline.didTimeout ? deadline.timeRemaining() > 2 : performance.now() - t0 < 6;
  let step = b.run.next();
  while (!step.done && more()) step = b.run.next();
  if (step.done) done(b, step.value);
  else if (b.waiters.size) plan(b);
}

/**
 * Hand the numbers to `ready`: at once when they are built, else when the build in turns (shared by every caller, started by the first)
 * gets there. Returns what stops waiting; when nobody waits any more the turns stop, and the steps done so far are kept for the next caller.
 */
export function whenData(ready: (d: DemoData) => void): () => void {
  if (shared) { ready(shared); return () => {}; }
  const b = build ??= { run: building(SEED), waiters: new Set(), job: null, idle: false };
  b.waiters.add(ready);
  plan(b);
  return () => { b.waiters.delete(ready); if (!b.waiters.size) unplan(b); };
}

/** The demo's numbers now, built at once if need be (a build under way is finished, and whoever waits for it is given them). */
export function demoData(): DemoData {
  if (shared) return shared;
  const b = build;
  if (!b) return shared = createData();
  unplan(b);
  let step = b.run.next();
  while (!step.done) step = b.run.next();
  done(b, step.value);
  return step.value;
}

/** Forget the numbers and any build under way (for tests: the next caller starts from nothing). */
export function forgetData(): void {
  if (build) unplan(build);
  build = null; shared = null;
}

/** The price at half hour `hh` (between two half hours, on the line between them). */
export function priceAt(d: DemoData, hh: number): number {
  if (hh <= 0) return d.price[0]!;
  if (hh >= HH - 1) return d.price[HH - 1]!;
  const i = Math.floor(hh), f = hh - i;
  return d.price[i]! * (1 - f) + d.price[i + 1]! * f;
}
