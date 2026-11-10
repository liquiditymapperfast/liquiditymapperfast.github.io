import { isPlain, num, plain, type Value } from './values.ts';
import { interpolateColors } from './colors.ts';

/**
 * The language's functions that keep state from candle to candle (`sma`, `ema`, `cum`, ...). Each place a script calls one has its own
 * instance. A call works out the value for the candle from what the instance holds and the value given, and leaves what it would add as
 * `pending`; the candle's end commits it. A function called twice in one candle (in a loop) answers from the same state both times and keeps
 * the last call's addition, so a candle counts once. A value that is not a number (NaN: a candle not recorded) gives NaN and adds nothing,
 * so an average starts where the data does instead of being poisoned by it.
 */

export interface Instance {
  state: Record<string, unknown>;
  pending: (() => void) | null;
  touched: boolean;
  commit(): void;
  /** Start again, as at the first candle (`fns[k].state = {}`). */
  reset(): void;
}
export function makeInstance(): Instance {
  const inst: Instance = {
    state: {}, pending: null, touched: false,
    commit() { const p = inst.pending; inst.pending = null; p?.(); },
    reset() { inst.state = {}; inst.pending = null; },
  };
  return inst;
}

/** The chart's candle a function like `avg_ohlc(bar)` reads. */
export interface Candle { open: number; high: number; low: number; close: number }
export type Builtin = (inst: Instance, args: Value[], named: Record<string, Value> | null, candle: Candle) => Value;

/** The longest window a function counts back over, in candles (as many as a chart is to give a script at most): a longer one asked is this one. */
export const MAX_WINDOW = 100_000;
/** A window's length: a missing or unreadable one is 1, the current value alone, as the scripts' language takes it (`sma(x)` is `x`). */
const len = (v: Value, fallback = 1): number => { const n = Math.floor(num(v)); return Number.isFinite(n) && n >= 1 ? Math.min(n, MAX_WINDOW) : fallback; };
const finite = (v: number): boolean => Number.isFinite(v);

/*
 * The window of the functions that count back over candles (`sum`, `sma`, `cma`, `highest`, `lowest`, `linreg`, `last`, the pivots): the last
 * values committed, oldest first. A call of length `k` reads the newest `k - 1` of them (fewer while fewer exist) besides its own value, and
 * the candle's end commits the value of the call it kept, then keeps the newest `k - 1` values of that call's `k`: a window the script makes
 * shorter reads only its newest values, and one made longer again fills from there. The functions share it: a place that calls `sum` on one
 * candle and `highest` on the next counts over the same values.
 *
 * Each call answers in constant time, amortised, so a window can be as long as the candles a chart gives (`MAX_WINDOW`):
 * - the values are an array read from an offset (`v[o..]`); values that leave advance the offset, and the array is compacted once as many have
 *   left as remain, which costs no more than their arrivals did;
 * - a sum is kept as values arrive and leave, compensated (Neumaier's: the rounding of each step is kept beside it, so a value leaving takes
 *   away what it brought, however large), and worked out again from the values at each compaction or when it is no longer a number, so its
 *   error never grows with the candles (a window shorter than the one kept reads the side that is shorter);
 * - `linreg` keeps the sum of the values and of each value times its place in the window the same way;
 * - the highest and the lowest are monotonic deques of the values that can still be an extreme: positions and values, oldest first, each
 *   entry followed by smaller (larger) ones; an equal value does not drop an earlier one, so the first entry of any window is the earliest of
 *   its extremes, which is the one a loop over the values from the oldest finds. A window shorter than the one kept finds its first entry by
 *   halving.
 * These helpers are made on the first call that needs one and kept up from then on. Everything is plain arrays and numbers: the engine copies
 * the state of every function (`cloneState` in `engine.ts`) to take the next run over from the candles it has already run.
 */

/** A sum compensated as it goes: the sum is `s + c`. */
type Sum = { s: number; c: number };
/** A monotonic deque: positions `p[d..]`, oldest first, and their values `q[d..]`. */
type Deque = { p: number[]; q: number[]; d: number };
/**
 * The window: values `v[o..]`, oldest first, the first of them at position `g + o` (a position counts every value committed); `y` their sum,
 * `t` the sum of each times its place (0 for the oldest), `hi` and `lo` the deques of the highest and the lowest; null until a call needs one.
 */
type Win = { v: number[]; o: number; g: number; y: Sum | null; t: Sum | null; hi: Deque | null; lo: Deque | null };

/** Compacted once at least this many values have left (and as many as remain), so a short window does not compact on every candle. */
const COMPACT_AT = 32;

function winOf(inst: Instance): Win {
  return (inst.state.w ??= { v: [], o: 0, g: 0, y: null, t: null, hi: null, lo: null }) as Win;
}
/** How many values the window keeps. */
const kept = (w: Win): number => w.v.length - w.o;

/** Add `x` to a compensated sum. */
function add(a: Sum, x: number): void {
  const s = a.s, t = s + x;
  a.c += Math.abs(s) >= Math.abs(x) ? (s - t) + x : (x - t) + s;
  a.s = t;
}
/**
 * Add `a * b` to a compensated sum, the product's own rounding included (Dekker's split): a placed sum keeps a value's product with its
 * place long after the value has left, and the rounding of a large one would stay in it.
 */
function addProduct(t: Sum, a: number, b: number): void {
  const p = a * b;
  add(t, p);
  let c = 134_217_729 * a;
  const ah = c - (c - a), al = a - ah;
  c = 134_217_729 * b;
  const bh = c - (c - b), bl = b - bh;
  const e = ((ah * bh - p) + ah * bl + al * bh) + al * bl;
  if (e !== 0 && finite(e)) add(t, e);
}
/** Work the window's sums out again from its values. */
function resum(w: Win): void {
  const v = w.v;
  if (w.y) { const y = w.y; y.s = 0; y.c = 0; for (let j = w.o; j < v.length; j++) add(y, v[j]!); }
  if (w.t) { const t = w.t; t.s = 0; t.c = 0; for (let j = w.o; j < v.length; j++) addProduct(t, j - w.o, v[j]!); }
}
const sumOf = (w: Win): Sum => { if (!w.y) { w.y = { s: 0, c: 0 }; resum(w); } return w.y; };
/** The sums `linreg` reads: the values', and that of each value times its place. */
function placedOf(w: Win): Sum {
  if (!w.t) { w.y ??= { s: 0, c: 0 }; w.t = { s: 0, c: 0 }; resum(w); }
  return w.t;
}

/** Add a value at position `pos` to a deque behind the entries it beats strictly (greater for the highest, smaller for the lowest). */
function pushDeque(dq: Deque, pos: number, x: number, high: boolean): void {
  const p = dq.p, q = dq.q;
  while (p.length > dq.d && (high ? q[q.length - 1]! < x : q[q.length - 1]! > x)) { p.pop(); q.pop(); }
  p.push(pos); q.push(x);
}
/** Let go of a deque's entries before position `head`. */
function dropDeque(dq: Deque, head: number): void {
  const p = dq.p;
  let d = dq.d;
  while (d < p.length && p[d]! < head) d++;
  if (d >= COMPACT_AT && d >= p.length - d) { p.copyWithin(0, d); p.length -= d; dq.q.copyWithin(0, d); dq.q.length -= d; d = 0; }
  dq.d = d;
}
/** The deque's first entry at or after position `from` (an index into `p` and `q`), or -1. */
function firstFrom(dq: Deque, from: number): number {
  const p = dq.p;
  let lo = dq.d, hi = p.length;
  if (lo >= hi) return -1;
  if (p[lo]! >= from) return lo;
  while (lo < hi) { const mid = (lo + hi) >>> 1; if (p[mid]! < from) lo = mid + 1; else hi = mid; }
  return lo < p.length ? lo : -1;
}
function dequeOf(w: Win, high: boolean): Deque {
  let dq = high ? w.hi : w.lo;
  if (!dq) {
    dq = { p: [], q: [], d: 0 };
    for (let j = w.o; j < w.v.length; j++) pushDeque(dq, w.g + j, w.v[j]!, high);
    if (high) w.hi = dq; else w.lo = dq;
  }
  return dq;
}

/** Commit `x` at the candle's end, then keep the newest `k - 1` values: what a call of length `k` reads besides its own value. */
function commit(inst: Instance, x: number, k: number): void {
  const w = winOf(inst), v = w.v, pos = w.g + v.length;
  if (w.t) addProduct(w.t, kept(w), x);
  if (w.y) add(w.y, x);
  if (w.hi) pushDeque(w.hi, pos, x, true);
  if (w.lo) pushDeque(w.lo, pos, x, false);
  v.push(x);
  const keep = k - 1, drop = kept(w) - keep;
  if (drop > 0) {
    if (drop < keep && (w.y || w.t)) {
      for (let j = 0; j < drop; j++) {
        const y = v[w.o]!;
        if (w.y) add(w.y, -y);
        // Every value left moves one place down: the placed sum loses the values' sum.
        if (w.t) { add(w.t, -w.y!.s); add(w.t, -w.y!.c); }
        w.o++;
      }
    } else { w.o += drop; resum(w); }
    if (w.hi) dropDeque(w.hi, w.g + w.o);
    if (w.lo) dropDeque(w.lo, w.g + w.o);
  }
  if (w.o >= COMPACT_AT && w.o >= kept(w)) { v.copyWithin(0, w.o); v.length -= w.o; w.g += w.o; w.o = 0; resum(w); }
  else if ((w.y && !finite(w.y.s + w.y.c)) || (w.t && !finite(w.t.s + w.t.c))) resum(w);
}

/**
 * `v` plus the newest `m` values of the window (`m` no more than it keeps): from the running sum when the values left out are the fewer,
 * else added up from the oldest after `v`, as the loop over the window did.
 */
function sumWith(w: Win, m: number, v: number): number {
  if (m === 0) return v;
  const n = kept(w), vs = w.v;
  if (m === n || n - m < m) {
    // The running sum, less the oldest values this window does not reach (none for a whole one), compensated as `add` does.
    const y = sumOf(w);
    let s = y.s, c = y.c;
    for (let j = w.o, end = w.o + (n - m); j < end; j++) { const x = -vs[j]!, t = s + x; c += Math.abs(s) >= Math.abs(x) ? (s - t) + x : (x - t) + s; s = t; }
    const total = s + c;
    if (finite(total)) return v + total;
  }
  let s = v;
  for (let j = vs.length - m; j < vs.length; j++) s += vs[j]!;
  return s;
}

/** The highest (`high`) or lowest of `x` and the newest `k - 1` values. */
function extreme(inst: Instance, x: Value, n: Value, high: boolean): number {
  const v = num(x), k = len(n); if (!finite(v)) return NaN;
  const w = winOf(inst), m = Math.min(kept(w), k - 1);
  inst.pending = () => commit(inst, v, k);
  if (m === 0) return v;
  const dq = dequeOf(w, high), i = firstFrom(dq, w.g + w.v.length - m);
  if (i < 0) return v;
  const e = dq.q[i]!;
  return (high ? e > v : e < v) ? e : v;
}

/** The two windows of `stoch`, of the highs and of the lows: deques alone, positions `h` to `e - 1` kept. */
type StochWin = { h: number; e: number; hi: Deque; lo: Deque };
const stochOf = (inst: Instance): StochWin => (inst.state.k ??= { h: 0, e: 0, hi: { p: [], q: [], d: 0 }, lo: { p: [], q: [], d: 0 } }) as StochWin;

const ohlcOf = (o: number, h: number, l: number, c: number): Value => { const r = plain(); r.open = o; r.high = h; r.low = l; r.close = c; return r; };
/** The candle a function of a bar reads: the object given when it holds prices, else the chart's candle. */
function candleArg(arg: Value, candle: Candle): Candle {
  if (isPlain(arg) && typeof arg.close === 'number') return { open: num(arg.open ?? arg.close), high: num(arg.high ?? arg.close), low: num(arg.low ?? arg.close), close: num(arg.close) };
  return candle;
}

export const BUILTINS: Readonly<Record<string, Builtin>> = {
  /** The running sum of every value so far. */
  cum(inst, [x]) {
    const v = num(x); if (!finite(v)) return NaN;
    const total = ((inst.state.total as number | undefined) ?? 0) + v;
    inst.pending = () => { inst.state.total = total; };
    return total;
  },
  /** The sum of the last `length` values (this candle's included; fewer while fewer exist). */
  sum(inst, [x, n]) {
    const v = num(x), k = len(n); if (!finite(v)) return NaN;
    const w = winOf(inst), m = Math.min(kept(w), k - 1);
    inst.pending = () => commit(inst, v, k);
    return sumWith(w, m, v);
  },
  /** The average of the last `length` values (of those there are, while fewer exist). */
  sma(inst, [x, n]) {
    const v = num(x), k = len(n); if (!finite(v)) return NaN;
    const w = winOf(inst), m = Math.min(kept(w), k - 1);
    inst.pending = () => commit(inst, v, k);
    return sumWith(w, m, v) / (m + 1);
  },
  /** The average of this value and the function's own last `length - 1` answers, as the scripts' language computes it (a running average of itself). */
  cma(inst, [x, n]) {
    const v = num(x), k = len(n); if (!finite(v)) return NaN;
    const w = winOf(inst), m = Math.min(kept(w), k - 1);
    const out = sumWith(w, m, v) / (m + 1);
    inst.pending = () => commit(inst, out, k);
    return out;
  },
  /** The exponential average: each value weighs 2 / (length + 1); the first value starts it. */
  ema(inst, [x, n]) { return smooth(inst, num(x), 2 / (len(n) + 1)); },
  /** The running (Wilder) average: each value weighs 1 / length. */
  rma(inst, [x, n]) { return smooth(inst, num(x), 1 / len(n)); },
  /** The highest of the last `length` values. */
  highest(inst, [x, n]) { return extreme(inst, x, n, true); },
  /** The lowest of the last `length` values. */
  lowest(inst, [x, n]) { return extreme(inst, x, n, false); },
  /** The least-squares line over the last `length` values, at this candle. */
  linreg(inst, [x, n]) {
    const v = num(x), k = len(n); if (!finite(v)) return NaN;
    const w = winOf(inst), kp = kept(w), m = Math.min(kp, k - 1), count = m + 1;
    inst.pending = () => commit(inst, v, k);
    if (count < 2) return v;
    // The sums over the newest m values and v (v at place m): kept as the window goes for a whole window, added up for a shorter one.
    let sy = NaN, sxy = NaN;
    if (m === kp) { const t = placedOf(w), y = w.y!; sy = (y.s + y.c) + v; sxy = (t.s + t.c) + m * v; }
    if (!finite(sy) || !finite(sxy)) {
      sy = 0; sxy = 0;
      const vs = w.v, from = vs.length - m;
      for (let i = 0; i < m; i++) { const y = vs[from + i]!; sy += y; sxy += i * y; }
      sy += v; sxy += m * v;
    }
    // Over places 0..count-1: their sum and the sum of their squares, whole numbers (as a loop adding them up would give).
    const sx = count * (count - 1) / 2, sxx = (count - 1) * count * (2 * count - 1) / 6;
    const slope = (count * sxy - sx * sy) / (count * sxx - sx * sx), icept = (sy - slope * sx) / count;
    return icept + slope * (count - 1);
  },
  /** The oldest of the last `length` values: the value `length - 1` candles ago once there are that many (`last(x, 2)` is the candle before), this one before. */
  last(inst, [x, n]) {
    const v = num(x), k = len(n, 1); if (!finite(v)) return NaN;
    const w = winOf(inst), m = Math.min(kept(w), k - 1);
    inst.pending = () => commit(inst, v, k);
    return m > 0 ? w.v[w.v.length - m]! : v;
  },
  /** The stochastic: where the close stands between the lowest low and the highest high of the last `length` candles, 0 to 100. */
  stoch(inst, [close, high, low, n]) {
    const c = num(close), h = num(high), l = num(low), k = len(n);
    if (!finite(c) || !finite(h) || !finite(l)) return NaN;
    const st = stochOf(inst), m = Math.min(st.e - st.h, k - 1);
    let hh = h, ll = l;
    if (m > 0) {
      const from = st.e - m, i = firstFrom(st.hi, from), j = firstFrom(st.lo, from);
      if (i >= 0 && st.hi.q[i]! > hh) hh = st.hi.q[i]!;
      if (j >= 0 && st.lo.q[j]! < ll) ll = st.lo.q[j]!;
    }
    inst.pending = () => {
      const s = stochOf(inst);
      pushDeque(s.hi, s.e, h, true); pushDeque(s.lo, s.e, l, false); s.e++;
      s.h = Math.max(s.h, s.e - (k - 1));
      dropDeque(s.hi, s.h); dropDeque(s.lo, s.h);
    };
    return 100 * (c - ll) / (hh - ll || 1);
  },
  /** A swing high: the value `right` candles ago when it is the highest of the `left` before it and the `right` after it, else NaN. */
  pivot_high(inst, [x, left, right]) { return pivot(inst, num(x), len(left, 2), len(right, 2), true); },
  /** A swing low, likewise. */
  pivot_low(inst, [x, left, right]) { return pivot(inst, num(x), len(left, 2), len(right, 2), false); },
  /** The average of the numbers given (arrays included), ignoring those that are not numbers. */
  avg(_inst, args) {
    let s = 0, c = 0;
    for (const a of args.flatMap(x => Array.isArray(x) ? x : [x])) { const v = num(a); if (finite(v)) { s += v; c++; } }
    return c ? s / c : NaN;
  },
  /** The chart's candle (`avg_ohlc(bar)`): open, high, low, close. */
  avg_ohlc(_inst, [b], _n, candle) { const c = candleArg(b, candle); return ohlcOf(c.open, c.high, c.low, c.close); },
  avg_ohlc_with_gaps(_inst, [b], _n, candle) { const c = candleArg(b, candle); return ohlcOf(c.open, c.high, c.low, c.close); },
  avg_close(_inst, [b], _n, candle) { return candleArg(b, candle).close; },
  /** Heikin-Ashi candles of the chart's: the close is the average of the four prices, the open the middle of the one before. */
  heikinashi(inst, [b], _n, candle) { return heikin(inst, candleArg(b, candle)); },
  avg_heikinashi(inst, [b], _n, candle) { return heikin(inst, candleArg(b, candle)); },
  /** A candle of a value: it opens where the last candle of it closed, and closes at the value. */
  ohlc(inst, [x]) {
    const v = num(x); if (!finite(v)) return ohlcOf(NaN, NaN, NaN, NaN);
    const open = (inst.state.close as number | undefined) ?? v;
    inst.pending = () => { inst.state.close = v; };
    return ohlcOf(open, Math.max(open, v), Math.min(open, v), v);
  },
  /** A candle of a running sum: it opens where the sum stood and closes with this value added (a CVD candle). */
  cum_ohlc(inst, [x]) {
    const v = num(x); if (!finite(v)) return ohlcOf(NaN, NaN, NaN, NaN);
    const open = (inst.state.total as number | undefined) ?? 0, close = open + v;
    inst.pending = () => { inst.state.total = close; };
    return ohlcOf(open, Math.max(open, close), Math.min(open, close), close);
  },
  /** The colour at `ratio` (0..1) along the colours given (a list among them stands for its colours). */
  interpolate(_inst, args) {
    // A ratio and one list (a heat map's ramp, on every candle of every row): the list itself, which is what flattening it would give
    // unless it has holes (flattening leaves them out).
    const list = args.length === 2 ? args[1] : undefined;
    if (Array.isArray(list) && dense(list)) return interpolateColors(num(args[0]), list);
    const colors = args.slice(1);
    return interpolateColors(num(args[0]), colors.some(c => Array.isArray(c)) ? colors.flatMap(c => Array.isArray(c) ? c : [c]) : colors);
  },
};

/** Whether a script's array has an element at every index (one made longer by setting its length has holes). */
function dense(a: readonly Value[]): boolean {
  for (let k = 0; k < a.length; k++) if (!Object.prototype.hasOwnProperty.call(a, k)) return false;
  return true;
}

function smooth(inst: Instance, v: number, alpha: number): number {
  if (!finite(v)) return NaN;
  const prev = inst.state.prev as number | undefined;
  const next = prev === undefined ? v : prev + alpha * (v - prev);
  inst.pending = () => { inst.state.prev = next; };
  return next;
}

/**
 * The value `right` candles back when it beats strictly every other of the `left + right + 1` newest (`v` the newest): it is then the earliest
 * extreme of the values kept in that window, the next entry of the deque (the next extreme after it, if equal) does not equal it, and `v`
 * does not reach it.
 */
function pivot(inst: Instance, v: number, left: number, right: number, high: boolean): number {
  if (!finite(v)) return NaN;
  const size = left + right + 1, w = winOf(inst);
  inst.pending = () => commit(inst, v, size);
  if (kept(w) < size - 1) return NaN;
  const dq = dequeOf(w, high), end = w.g + w.v.length, i = firstFrom(dq, end - (size - 1));
  if (i < 0 || dq.p[i] !== end - right) return NaN;
  const mid = dq.q[i]!;
  if (i + 1 < dq.p.length && !(high ? dq.q[i + 1]! < mid : dq.q[i + 1]! > mid)) return NaN;
  return (high ? mid > v : mid < v) ? mid : NaN;
}

function heikin(inst: Instance, c: Candle): Value {
  // A candle with no prices (not recorded) has no Heikin-Ashi candle, and the next one opens from the last that had.
  if (![c.open, c.high, c.low, c.close].every(finite)) return ohlcOf(NaN, NaN, NaN, NaN);
  const close = (c.open + c.high + c.low + c.close) / 4;
  const prev = inst.state.prev as { open: number; close: number } | undefined;
  const open = prev ? (prev.open + prev.close) / 2 : (c.open + c.close) / 2;
  inst.pending = () => { inst.state.prev = { open, close }; };
  return ohlcOf(open, Math.max(c.high, open, close), Math.min(c.low, open, close), close);
}
