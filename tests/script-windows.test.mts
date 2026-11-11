import test from 'node:test';
import assert from 'node:assert/strict';
import { BUILTINS, MAX_WINDOW, makeInstance, type Candle } from '../src/app/script/lang/builtins.ts';
import { createRunner, runScript } from '../src/app/script/lang/engine.ts';
import { FULL_RUN_MS, RUN_MS } from '../src/app/script/lang/analysis.ts';
import type { BarInputs } from '../src/app/script/inputs.ts';
import type { ScriptResult } from '../src/app/script/protocol.ts';
import type { Value } from '../src/app/script/lang/values.ts';
import { BEFORE, WINDOW_FUNCTIONS } from './fixtures/builtins-before.mts';

/*
 * The functions that count back over a window answer in constant time (`builtins.ts`): held here to what they answered when each call looped
 * over its window (`BEFORE`), on random series with gaps, windows that change length, several calls a candle and resets.
 */

const CANDLE: Candle = { open: NaN, high: NaN, low: NaN, close: NaN };
/** A seeded random source (Park-Miller), so a failure runs again the same. */
const random = (seed: number): (() => number) => { let s = seed; return () => (s = (s * 16807) % 2147483647) / 2147483647; };
/** The functions whose answers are values of the window as they are (no arithmetic): equal to the last bit, the sign of a zero included. */
const EXACT = new Set(['highest', 'lowest', 'last', 'stoch', 'pivot_high', 'pivot_low']);

/** One place in a script, called with the old functions and the new side by side. */
class Pair {
  readonly old = makeInstance();
  readonly now = makeInstance();
  /** The largest difference met for each function, as a share of the size of the values its window held. */
  static worst = new Map<string, number>();
  call(fn: string, args: Value[], where: string): void {
    const kept = (this.old.state.w as number[] | undefined) ?? [];
    const a = BEFORE[fn]!(this.old, args, null, CANDLE) as number, b = BUILTINS[fn]!(this.now, args, null, CANDLE) as number;
    if (EXACT.has(fn)) { assert.ok(Object.is(a, b), `${fn}(${args.map(String).join(', ')}) ${where}: ${a} before, ${b} now`); return; }
    if (Number.isNaN(a) || Number.isNaN(b)) { assert.ok(Number.isNaN(a) && Number.isNaN(b), `${fn} ${where}: ${a} before, ${b} now`); return; }
    // A sum's rounding depends on the order it adds in: held to the size of what it adds (a sum near 0 of large values is near 0 by luck).
    let size = Math.abs(num(args[0]));
    for (const y of kept) size += Math.abs(y);
    if (fn === 'sma' || fn === 'cma') size /= Math.min(kept.length + 1, Math.max(1, Math.floor(num(args[1]))) || 1);
    const off = Math.abs(a - b) / (size || 1);
    Pair.worst.set(fn, Math.max(Pair.worst.get(fn) ?? 0, off));
    assert.ok(off <= 1e-12, `${fn}(${args.map(String).join(', ')}) ${where}: ${a} before, ${b} now (${off} of the window's size)`);
  }
  commit(): void { this.old.commit(); this.now.commit(); }
  reset(): void { this.old.reset(); this.now.reset(); }
}
const num = (v: Value): number => typeof v === 'number' ? v : Number(v);

/** A value: mostly a wandering one, at times one of a few (ties, a zero of either sign), large, or not a number. */
function valueOf(r: () => number, walk: { x: number }): number {
  const u = r();
  if (u < 0.06) return NaN;
  if (u < 0.2) return [0, -0, 1, -1, 2.5][Math.floor(r() * 5)]!;
  if (u < 0.24) return (r() - 0.5) * 1e12;
  walk.x += (r() - 0.5) * 4;
  return u < 0.5 ? Math.round(walk.x) : walk.x;
}
/** A window: a few kinds of plan, from one length kept to one changed at every call, with lengths a script could give by mistake. */
function windowOf(r: () => number, plan: number, t: number, base: number): Value {
  if (r() < 0.01) return [undefined, NaN, Infinity, 0, -3, MAX_WINDOW + 5, 'x', 7.9][Math.floor(r() * 8)];
  switch (plan) {
    case 0: return base;
    case 1: return 1 + Math.floor(r() * 80);
    case 2: return t % 120 < 60 ? base : Math.max(1, Math.floor(base / 4));
    default: return 1 + ((t * 7) % (base + 1));
  }
}

test('each function over a window answers what the loop over its window answered, to the last bit where it only picks values', t => {
  for (const fn of WINDOW_FUNCTIONS) {
    for (let trial = 0; trial < 12; trial++) {
      const r = random(1000 + trial * 31 + fn.length * 977), walk = { x: 100 }, pair = new Pair();
      const plan = trial % 4, base = 2 + Math.floor(r() * (trial < 8 ? 60 : 300)), T = trial < 8 ? 600 : 2_500;
      for (let t = 0; t < T; t++) {
        if (r() < 0.01) pair.reset();
        if (r() < 0.1) { pair.commit(); continue; }
        const calls = r() < 0.7 ? 1 : r() < 0.66 ? 2 : 3;
        for (let c = 0; c < calls; c++) {
          const where = `trial ${trial} candle ${t} call ${c}`;
          if (fn === 'stoch') pair.call(fn, [valueOf(r, walk), valueOf(r, walk), valueOf(r, walk), windowOf(r, plan, t, base)], where);
          else if (fn === 'pivot_high' || fn === 'pivot_low') pair.call(fn, [valueOf(r, walk), windowOf(r, plan, t, 1 + base % 6), windowOf(r, plan, t + 3, 1 + (base * 7) % 5)], where);
          else pair.call(fn, [valueOf(r, walk), windowOf(r, plan, t, base)], where);
        }
        // A reset after the calls drops what they would add (fns[k].state = {} later in the script).
        if (r() < 0.01) pair.reset();
        pair.commit();
      }
    }
  }
  t.diagnostic(`largest differences, as a share of the window's size: ${[...Pair.worst].map(([f, d]) => `${f} ${d.toExponential(1)}`).join(', ')}`);
});

test('a place that calls one function over a window on one candle and another on the next counts over the same values', () => {
  // Not cma: it keeps its own answers in the window, which may differ in the last bit, and the functions that pick values would pick those.
  const r = random(77), walk = { x: 50 }, pair = new Pair(), fns = WINDOW_FUNCTIONS.filter(f => f !== 'stoch' && f !== 'cma');
  for (let t = 0; t < 4_000; t++) {
    const fn = fns[Math.floor(r() * fns.length)]!, k = t % 500 < 250 ? 40 : 1 + Math.floor(r() * 120);
    if (fn.startsWith('pivot')) pair.call(fn, [valueOf(r, walk), 1 + (t % 4), 1 + (t % 3)], `candle ${t}`);
    else pair.call(fn, [valueOf(r, walk), k], `candle ${t}`);
    pair.commit();
  }
});

test('long windows, whole, made much shorter and longer again: their sums stay as close over thousands of candles', () => {
  // The values arrive and leave over and over: the compactions and the sums worked out again are crossed many times.
  for (const fn of ['sum', 'sma', 'cma', 'linreg', 'highest', 'lowest', 'last', 'stoch']) {
    const r = random(4242 + fn.length), walk = { x: 1_000 }, pair = new Pair();
    for (let t = 0; t < 4_500; t++) {
      const k = t < 2_500 ? 1_500 : t < 3_200 ? 50 + (t % 7) : 1_200;
      if (fn === 'stoch') pair.call(fn, [valueOf(r, walk), valueOf(r, walk), valueOf(r, walk), k], `candle ${t}`);
      else pair.call(fn, [valueOf(r, walk), k], `candle ${t}`);
      pair.commit();
    }
  }
});

test('a window of 100,000 values costs a call no more than a short one, and longer ones are cut to it', () => {
  const t0 = performance.now();
  const sum = makeInstance(), high = makeInstance(), reg = makeInstance(), st = makeInstance();
  let s = 0, h = 0, g = 0, k = 0;
  const N = 150_000;
  for (let i = 0; i < N; i++) {
    const v = (i * 7919) % 1_000;
    s = BUILTINS.sum!(sum, [v, MAX_WINDOW * 3], null, CANDLE) as number; sum.commit();
    h = BUILTINS.highest!(high, [v, MAX_WINDOW], null, CANDLE) as number; high.commit();
    g = BUILTINS.linreg!(reg, [v, MAX_WINDOW], null, CANDLE) as number; reg.commit();
    k = BUILTINS.stoch!(st, [v, v + 1, v - 1, MAX_WINDOW], null, CANDLE) as number; st.commit();
  }
  const ms = performance.now() - t0;
  let want = 0;
  for (let i = N - MAX_WINDOW; i < N; i++) want += (i * 7919) % 1_000;
  assert.equal(s, want, 'the newest 100,000 values, exactly (whole numbers)');
  assert.equal(h, 999);
  assert.ok(Number.isFinite(g) && Number.isFinite(k));
  // Each call looping over its window would take minutes here (150,000 calls over up to 100,000 values, four functions).
  assert.ok(ms < 3_000, `${Math.round(ms)} ms for ${N} candles`);
});

const MIN = 60_000;
/** Candles of a wandering price, some of them not recorded (NaN) and a run of them without a price; the first candles the same at any length. */
function candles(n: number, seed = 9): BarInputs {
  const r = random(seed), close = new Float64Array(n), high = new Float64Array(n), low = new Float64Array(n), volume = new Float64Array(n);
  const vbuy = new Float64Array(n), vsell = new Float64Array(n);
  let p = 100;
  for (let i = 0; i < n; i++) {
    p += (r() - 0.5) * 2;
    const gap = i % 89 === 40 || (i >= 300 && i < 304), up = r(), down = r();
    close[i] = gap ? NaN : Math.round(p * 4) / 4; high[i] = gap ? NaN : Math.round((p + up) * 4) / 4; low[i] = gap ? NaN : Math.round((p - down) * 4) / 4;
    volume[i] = r() * 50; vbuy[i] = r() * 1e6; vsell[i] = r() * 1e6;
  }
  const time = Float64Array.from({ length: n }, (_, i) => i * MIN);
  const flow = { vbuy, vsell, lbuy: new Float64Array(n), lsell: new Float64Array(n), markets: 1 };
  return { tf: MIN, time, open: Float64Array.from(close), high, low, close, volume, sources: { '': flow }, forming: true };
}
const ok = (r: ScriptResult): Extract<ScriptResult, { ok: true }> => { assert.ok(r.ok, r.ok ? '' : JSON.stringify(r.error)); return r; };
const drawn = (r: ScriptResult): number[][] => ok(r).plots.map(p => Array.from(p.fields.value!));

const EVERY = `var x = $price.close - 100
var k = 5 + renderer.length % 13
line(sum(x, k))
line(sma($price.volume, 20))
line(cma(x, 9))
line(highest($price.high, k * 2))
line(lowest($price.low, 30 - k))
line(linreg(x, 25))
line(last(x, k))
line(stoch($price.close, $price.high, $price.low, 14 + k))
line(pivot_high($price.high, 3, 2))
line(pivot_low($price.low, 2, 3))
var both = 0
for (var j = 1; j <= 3; j++) both += sma(x, j * 10) + highest(x, j * 7)
line(both)
line(sum(vbuy - vsell, renderer.length % 200 < 100 ? 60 : 4))
if (renderer.length % 150 === 0) fns[0].state = {}`;

test('a live update, and a candle closed with a new one begun, give what a run over every candle gives, to the last bit', () => {
  for (const n of [120, 700]) {
    const runner = createRunner('t', EVERY, {});
    const first = ok(runner.run(candles(n)));
    assert.ok(first.plots.every(p => p.fields.value!.some(Number.isFinite)), 'every line draws');
    const moved = candles(n); moved.close[n - 1] = moved.close[n - 1]! + 0.75; moved.high[n - 1] = Math.max(moved.high[n - 1]!, moved.close[n - 1]!);
    const live = runner.run(moved);
    assert.equal(runner.startedAt, n - 1, 'only the candle under way ran again');
    assert.deepEqual(drawn(live), drawn(runScript('t', EVERY, {}, moved)));
    const grown = runner.run(candles(n + 1));
    assert.equal(runner.startedAt, n - 1, 'the candle that closed and the new one');
    assert.deepEqual(drawn(grown), drawn(runScript('t', EVERY, {}, candles(n + 1))));
    // And once more from there: the state taken over twice.
    const again = runner.run(candles(n + 2));
    assert.equal(runner.startedAt, n);
    assert.deepEqual(drawn(again), drawn(runScript('t', EVERY, {}, candles(n + 2))));
  }
});

test('a window asked longer than any can be is cut to the longest, and the run says both', () => {
  const n = MAX_WINDOW + 1, inputs = candles(n, 3);
  inputs.close.fill(1);
  const r = ok(runScript('t', 'line(sum($price.close, 150000))', {}, inputs));
  assert.deepEqual(r.warnings, [{ code: 'long-window', detail: `1|150000|${MAX_WINDOW}|${n}` }], 'it fills, but holds 100,000 candles, not the 150,000 asked');
  const v = r.plots[0]!.fields.value!;
  assert.equal(v[n - 1], MAX_WINDOW);
  assert.equal(v[999], 1_000, 'fewer while fewer exist');
});

test('a run from the first candle has the longer time, and a live update the short one', () => {
  // About 36,000 steps a candle (two a turn of the loop): the clock moves 3 s at each look, and it is looked at every 65,536 steps.
  const src = 'var s = 0\nfor (var i = 0; i < 18000; i++) s += i\nline(s)';
  let t = 0;
  const clock = (): number => (t += 3_000);
  const runner = createRunner('t', src, {}, clock);
  const full = runner.run(candles(5));
  assert.ok(full.ok && full.steps >= 2 * 65_536 && full.steps < 3 * 65_536, `two looks at the clock, 6 s: within ${FULL_RUN_MS / 1000} s (${full.ok ? full.steps : 'stopped'} steps)`);
  const live = runner.run(candles(6));
  assert.equal(runner.startedAt, 4);
  assert.ok(!live.ok && live.error.code === 'too-slow', `one look, 3 s: past ${RUN_MS / 1000} s`);
});

test('a run over fewer candles than the run before (a replay stepped back) runs from the first candle with the full run\'s time', () => {
  const src = 'var s = 0\nfor (var i = 0; i < 18000; i++) s += i\nline(s)';
  let t = 0;
  const runner = createRunner('t', src, {}, () => (t += 3_000));
  assert.ok(runner.run(candles(5)).ok);
  const back = runner.run(candles(4));
  assert.equal(runner.startedAt, 0, 'from the first candle');
  assert.ok(back.ok, `two looks at the clock, 6 s: within ${FULL_RUN_MS / 1000} s, not ${RUN_MS / 1000} s (Sol, round 5)`);
});

test('a rerun because an older candle\'s order book changed has the full run\'s time, not a live update\'s', () => {
  const src = 'var d = askdepth(10)\nvar s = 0\nfor (var i = 0; i < 18000; i++) s += i\nline(s)';
  let t = 0;
  const runner = createRunner('t', src, {}, () => (t += 3_000));
  assert.ok(runner.run({ ...candles(5), depthEpochs: Float64Array.from([1, 1, 1, 1, 1]) }).ok);
  const settled = runner.run({ ...candles(5), depthEpochs: Float64Array.from([2, 1, 1, 1, 1]) });
  assert.equal(runner.startedAt, 0, 'from the first candle: the oldest one\'s book was read again');
  assert.ok(settled.ok, `within ${FULL_RUN_MS / 1000} s, not ${RUN_MS / 1000} s (Sol, round 6)`);
});

test('a script that cannot be put back between runs has the short time at a live update too, not ten seconds at every update', () => {
  // It keeps an array from candle to candle (a name assigned without a declaration is kept), so every run starts from the first candle; only
  // the first of these is a run over new candles.
  const src = 'if (once == 0) { once = 1; kept = [] }\nvar s = 0\nfor (var i = 0; i < 18000; i++) s += i\nline(s)';
  let t = 0;
  const runner = createRunner('t', src, {}, () => (t += 3_000));
  const full = runner.run(candles(5));
  assert.ok(full.ok, 'the first run has the long time');
  const live = runner.run(candles(6));
  assert.equal(runner.startedAt, 0, 'run from the first candle: nothing could be put back');
  assert.ok(!live.ok && live.error.code === 'too-slow', `an update all the same: ${RUN_MS / 1000} s`);
  const other = runner.run(candles(6, 7));
  assert.ok(other.ok, 'other candles have the long time again');
});
