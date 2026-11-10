import { MAX_WINDOW, type Builtin, type Instance } from '../../src/app/script/lang/builtins.ts';
import { num, type Value } from '../../src/app/script/lang/values.ts';

/*
 * The functions that count back over a window as they were before 2026-11-10 (`builtins.ts` at 75f3348d): each call loops over its whole
 * window, and a commit drops the values that left with `splice`. Kept here, word for word but for the longest window (the one `builtins.ts`
 * has now), as the oracle the faster ones are held to: `script-windows.test.mts` and `script-outputs.test.mts`.
 */

const len = (v: Value, fallback = 1): number => { const n = Math.floor(num(v)); return Number.isFinite(n) && n >= 1 ? Math.min(n, MAX_WINDOW) : fallback; };
const finite = (v: number): boolean => Number.isFinite(v);

function windowOf(inst: Instance, n = Infinity): number[] {
  const w = (inst.state.w ??= []) as number[];
  return n - 1 < w.length ? w.slice(w.length - Math.max(0, n - 1)) : w;
}
function pushWindow(inst: Instance, x: number, n: number): void {
  inst.pending = () => { const w = windowOf(inst); w.push(x); if (w.length > n - 1) w.splice(0, w.length - (n - 1)); };
}

function pivot(inst: Instance, v: number, left: number, right: number, beats: (a: number, b: number) => boolean): number {
  if (!finite(v)) return NaN;
  const w = windowOf(inst, left + right + 1), all = [...w, v];
  pushWindow(inst, v, left + right + 1);
  if (all.length < left + right + 1) return NaN;
  const c = all.length - 1 - right, mid = all[c]!;
  if (!finite(mid)) return NaN;
  for (let k = c - left; k <= c + right; k++) if (k !== c && !beats(mid, all[k]!)) return NaN;
  return mid;
}

export const BEFORE: Readonly<Record<string, Builtin>> = {
  sum(inst, [x, n]) {
    const v = num(x), k = len(n); if (!finite(v)) return NaN;
    const w = windowOf(inst, k); let s = v; for (const y of w) s += y;
    pushWindow(inst, v, k); return s;
  },
  sma(inst, [x, n]) {
    const v = num(x), k = len(n); if (!finite(v)) return NaN;
    const w = windowOf(inst, k); let s = v; for (const y of w) s += y;
    pushWindow(inst, v, k); return s / (w.length + 1);
  },
  cma(inst, [x, n]) {
    const v = num(x), k = len(n); if (!finite(v)) return NaN;
    const w = windowOf(inst, k); let s = v; for (const y of w) s += y;
    const out = s / (w.length + 1);
    pushWindow(inst, out, k); return out;
  },
  highest(inst, [x, n]) {
    const v = num(x), k = len(n); if (!finite(v)) return NaN;
    const w = windowOf(inst, k); let m = v; for (const y of w) if (y > m) m = y;
    pushWindow(inst, v, k); return m;
  },
  lowest(inst, [x, n]) {
    const v = num(x), k = len(n); if (!finite(v)) return NaN;
    const w = windowOf(inst, k); let m = v; for (const y of w) if (y < m) m = y;
    pushWindow(inst, v, k); return m;
  },
  linreg(inst, [x, n]) {
    const v = num(x), k = len(n); if (!finite(v)) return NaN;
    const ys = [...windowOf(inst, k), v], m = ys.length;
    pushWindow(inst, v, k);
    if (m < 2) return v;
    let sx = 0, sy = 0, sxy = 0, sxx = 0;
    for (let i = 0; i < m; i++) { sx += i; sy += ys[i]!; sxy += i * ys[i]!; sxx += i * i; }
    const slope = (m * sxy - sx * sy) / (m * sxx - sx * sx), icept = (sy - slope * sx) / m;
    return icept + slope * (m - 1);
  },
  last(inst, [x, n]) {
    const v = num(x), k = len(n, 1); if (!finite(v)) return NaN;
    const w = windowOf(inst, k), out = w.length ? w[0]! : v;
    pushWindow(inst, v, k);
    return out;
  },
  stoch(inst, [close, high, low, n]) {
    const c = num(close), h = num(high), l = num(low), k = len(n);
    if (!finite(c) || !finite(h) || !finite(l)) return NaN;
    const hs = (inst.state.h ??= []) as number[], ls = (inst.state.l ??= []) as number[];
    let hh = h, ll = l;
    for (let j = Math.max(0, hs.length - (k - 1)); j < hs.length; j++) { if (hs[j]! > hh) hh = hs[j]!; if (ls[j]! < ll) ll = ls[j]!; }
    inst.pending = () => { hs.push(h); ls.push(l); if (hs.length > k - 1) { hs.splice(0, hs.length - (k - 1)); ls.splice(0, ls.length - (k - 1)); } };
    return 100 * (c - ll) / (hh - ll || 1);
  },
  pivot_high(inst, [x, left, right]) { return pivot(inst, num(x), len(left, 2), len(right, 2), (a, b) => a > b); },
  pivot_low(inst, [x, left, right]) { return pivot(inst, num(x), len(left, 2), len(right, 2), (a, b) => a < b); },
};

/** The functions of `BEFORE`, which `builtins.ts` now answers in constant time. */
export const WINDOW_FUNCTIONS: readonly string[] = Object.keys(BEFORE);
