import test from 'node:test';
import assert from 'node:assert/strict';
import { createRunner, runScript } from '../src/app/script/lang/engine.ts';
import { BUILTINS, type Builtin } from '../src/app/script/lang/builtins.ts';
import { interpolateColors, parseColor, rgb, safeColor } from '../src/app/script/lang/colors.ts';
import type { ScriptResult } from '../src/app/script/protocol.ts';
import { BUILTIN_SCRIPTS, builtinDigests, candles } from './fixtures/script-builtins-2026-10-27.mts';
import { BEFORE } from './fixtures/builtins-before.mts';

/**
 * What the built-in scripts of 2026-10-27 drew, worked out by the interpreter before it was made faster (master d74a834): every value, colour,
 * style, warning and step of each (`builtinDigests`). Making the interpreter faster must not move one.
 */
const PINNED: Readonly<Record<string, string>> = {
  "VWAP with bands": "1ae64629a00d764972dda4cdaaadb7e6",
  "Stochastic heat map": "0c659dc021de2e2fde50a32f4788ee16",
  "Stochastic heat map {\"scale\":2,\"colorCandles\":true}": "6dba8d7f3e0c057d06810de109604b5c",
  "Buyer and seller VWAPs": "bbed96e59a749befaec223e69834de8a",
  "Liquidations": "1e437286f7ee92e05ae2bc388e679112",
  "Liquidations {\"markCandles\":true}": "4b11284a1d2d2a297b41d58a8196c3b4",
  "Volume anomalies": "ea74386be1f22fc6abc1042f6c9a481b",
  "Volume anomalies {\"colorCandles\":true,\"showDelta\":false}": "217422f3041132f99fbd8e3b853a081c",
  "Cumulative delta": "a8810ecc128d665ce290b4e36015187f",
  "Spot and perpetual CVD": "8c8c489ac0ec23ec53ac0c473e113c34",
  "Delta histogram": "ae119d951178d81e93ed77bdc7264169",
  "Buy share": "2c58d5c148defdc8f69ce7b94f8e7324",
};

/**
 * The scripts whose numbers moved in their last bits when the functions over a window were made to answer in constant time (2026-11-10: a
 * sum kept as values come and go adds in another order than a loop over the window). `BEFORE` still gives `PINNED`, and each number moved
 * by less than a millionth of a millionth of itself (the tests below).
 */
const MOVED: Readonly<Record<string, string>> = {
  "VWAP with bands": "63373b8f17196341c3ab1451604cd96f",
  "Buyer and seller VWAPs": "c968e7d0ab69ba93bbb031c58759c841",
  "Buy share": "617c2bce30a8c345743c810cda43f8cd",
};

/** Run `fn` with the functions over a window as they were before 2026-11-10 (`BEFORE`) in place of the new ones. */
function withBefore<T>(fn: () => T): T {
  const table = BUILTINS as Record<string, Builtin>, saved = new Map(Object.keys(BEFORE).map(k => [k, table[k]!]));
  try { for (const [k, f] of Object.entries(BEFORE)) table[k] = f; return fn(); }
  finally { for (const [k, f] of saved) table[k] = f; }
}

test('the built-in scripts of 2026-10-27 draw exactly what they drew before the interpreter was made faster, in as many steps', () => {
  assert.deepEqual(withBefore(() => builtinDigests(createRunner)), PINNED, 'with the functions over a window of then: the interpreter moved nothing');
  assert.deepEqual(builtinDigests(createRunner), { ...PINNED, ...MOVED }, 'with those of now');
});

test('the built-in scripts draw with the constant-time functions over a window what they drew with the loops, to nine digits', t => {
  // Nine, not sixteen: a band's deviation is the square root of a mean of squares less a squared mean, two numbers near 6e9 a few apart, so
  // a difference in the last bit of either moves it by more (about one part in 1e12 of the price here).
  let worst = 0;
  // The runs `builtinDigests` makes: every candle, the candle under way changed, a candle closed with a new one begun.
  const runs = (s: (typeof BUILTIN_SCRIPTS)[number], options: (typeof BUILTIN_SCRIPTS)[number]['variants'][number]): ScriptResult[] => {
    const now = (): number => 1_790_000_000_000, out = [createRunner('x', s.source, options, now).run(candles(500, 60_000))];
    const runner = createRunner('x', s.source, options, now), hour = 3_600_000;
    out.push(runner.run(candles(900, hour)));
    const moved = candles(900, hour);
    moved.close[899] = moved.close[899]! * 1.001; moved.high[899] = Math.max(moved.high[899]!, moved.close[899]!);
    out.push(runner.run(moved), runner.run(candles(901, hour)));
    return out;
  };
  let compared = 0;
  for (const s of BUILTIN_SCRIPTS) for (const options of s.variants) {
    const then = withBefore(() => runs(s, options)), now = runs(s, options);
    for (let r = 0; r < then.length; r++) {
      const a = ok(then[r]!), b = ok(now[r]!);
      assert.deepEqual([b.steps, b.warnings, b.candleColors ?? null], [a.steps, a.warnings, a.candleColors ?? null], s.name);
      assert.equal(b.plots.length, a.plots.length);
      for (let p = 0; p < a.plots.length; p++) {
        const pa = a.plots[p]!, pb = b.plots[p]!;
        assert.deepEqual([pb.kind, pb.title, pb.style, pb.colors], [pa.kind, pa.title, pa.style, pa.colors], `${s.name}: ${pa.title}`);
        for (const [f, va] of Object.entries(pa.fields)) {
          const vb = pb.fields[f]!;
          for (let i = 0; i < va.length; i++) {
            const x = va[i]!, y = vb[i]!, off = Object.is(x, y) ? 0 : Math.abs(x - y) / Math.max(1, Math.abs(x));
            assert.ok(off <= 1e-9, `${s.name}: ${pa.title}.${f}[${i}] ${x} then, ${y} now`);
            worst = Math.max(worst, off);
            compared++;
          }
        }
      }
    }
  }
  assert.ok(compared > 100_000, `${compared} numbers`);
  t.diagnostic(`${compared} numbers, the largest difference ${worst.toExponential(1)} of the value`);
});

const ok = (r: ScriptResult): Extract<ScriptResult, { ok: true }> => { assert.ok(r.ok, r.ok ? '' : JSON.stringify(r.error)); return r; };
const first = (src: string): number[] => Array.from(ok(runScript('x', src, {}, candles(4, 60_000))).plots[0]!.fields.value!);

test('a colour the page makes and reads back is the text it would read it as, an alpha of 1 included', () => {
  // rgb() writes an alpha of 1 as rgba, which safeColor writes as rgb: the colour just made is not taken as it is then.
  assert.equal(rgb([1, 2, 3, 1]), 'rgba(1, 2, 3, 1)');
  assert.equal(safeColor('rgba(1, 2, 3, 1)', ''), 'rgb(1, 2, 3)');
  const made = interpolateColors(0.5, ['rgba(0, 0, 0, 0.2)', 'rgba(255, 255, 255, 0.4)']);
  assert.equal(made, 'rgba(128, 128, 128, 0.3)');
  assert.equal(safeColor(made, ''), made);
  assert.equal(safeColor(interpolateColors(1, ['red', 'rgba(0, 0, 255, 0.9995)']), 'x'), 'rgb(0, 0, 255)', 'an alpha that rounds to 1');
  // What is read once is kept and shared: it cannot be changed by whoever reads it.
  const red = parseColor('red')!;
  assert.equal(parseColor('red'), red);
  assert.throws(() => { (red as unknown as number[])[0] = 0; });
  assert.deepEqual(parseColor('red'), [255, 0, 0, 1]);
  assert.equal(safeColor(7, 'fallback'), 'fallback');
  // A long text or a function among the colours is read as before (it is no colour), only not kept after the call.
  const long = `rgb(1, 2, 3)${' '.repeat(100)}`;
  assert.equal(parseColor(long)?.join(), '1,2,3,1');
  assert.equal(safeColor(long, ''), 'rgb(1, 2, 3)');
  for (let k = 0; k < 2; k++) assert.equal(interpolateColors(0.5, ['x'.repeat(1000), (): number => 1, 'red', 'blue']), 'rgb(128, 0, 128)');
});

test('interpolate given a ratio and one list answers as its colours flattened would, holes and lists inside it included', () => {
  const colors = (src: string): string[] | null => ok(runScript('x', src, {}, candles(3, 60_000))).plots[0]!.colors;
  const flat = colors('line({ value: 1, color: interpolate(0.3, "red", "rgba(0, 0, 255, 0.5)", "#00ff00") })');
  assert.ok(flat !== null && flat.every(c => c === flat[0] && c !== ''), 'one colour on every candle');
  assert.deepEqual(colors('var ramp = ["red", "rgba(0, 0, 255, 0.5)", "#00ff00"]\nline({ value: 1, color: interpolate(0.3, ramp) })'), flat);
  assert.deepEqual(colors('line({ value: 1, color: interpolate(0.3, ["red"], ["rgba(0, 0, 255, 0.5)", "#00ff00"]) })'), flat, 'two lists');
  // A hole is left out by flattening: the first element is then the next one, which is what is answered when none reads as a colour.
  assert.deepEqual(first('var a = []\na.length = 2\na[1] = "nope"\nline(interpolate(0.5, a) === "nope" ? 1 : 0)'), [1, 1, 1, 1]);
  assert.deepEqual(first('var a = []\na.length = 3\na[1] = "red"\na[2] = "blue"\nline(interpolate(0.5, a) === interpolate(0.5, "red", "blue") ? 1 : 0)'), [1, 1, 1, 1]);
  // A list inside the list is not a colour.
  assert.deepEqual(first(`line(interpolate(0.5, [["red"], "blue"]) === "${interpolateColors(0.5, ['blue'])}" ? 1 : 0)`), [1, 1, 1, 1]);
});

test('what a script declares is found before what it keeps, however the faster lookups reach it', () => {
  // A parameter, a var and a function name hide a kept name of the same spelling; a name never declared is the kept one.
  assert.deepEqual(first('function f(total) { return total * 2 }\ntotal = 5\nline(f(3))'), [6, 6, 6, 6]);
  assert.deepEqual(first('total = 5\nfunction f() { var total = 1; return total }\nline(f() + total)'), [6, 6, 6, 6]);
  // Hoisting: a function stands from the first line whichever comes first, its name or a var of the same name; a var that sets it wins after.
  assert.deepEqual(first('var a = typeof g === "function" ? 1 : 0\nfunction g() { return 2 }\nvar g\nline(a + g())'), [3, 3, 3, 3]);
  assert.deepEqual(first('var b = g()\nvar g = function () { return 5 }\nfunction g() { return 4 }\nline(b + g())'), [9, 9, 9, 9]);
  // A return ends a function wherever it stands, and what follows it does not run.
  assert.deepEqual(first('function f(x) { if (x > 1) { return 10 } return x\n n = n + 1 }\nline(f(renderer.length) + n)'), [1, 10, 10, 10]);
  assert.deepEqual(first('var g = x => x + 1\nfunction h() { return\n }\nline(g(1) + (h() === undefined ? 1 : 0))'), [3, 3, 3, 3]);
  // An if whose branch is an expression shares the candle's names with what it makes.
  assert.deepEqual(first('var k = 2\nvar f = null\nif (k) f = () => k * 3\nline(f())'), [6, 6, 6, 6]);
});

test('a source() call still reads its own markets after the calls around it stopped being wrapped', () => {
  const r = ok(createRunner('x', 'line(source(vbuy, type=spot) - vbuy)\nline(vbuy)', {}).run(candles(20, 60_000)));
  const spot = candles(20, 60_000).sources['kind=spot']!.vbuy, all = candles(20, 60_000).sources['']!.vbuy;
  assert.deepEqual(Array.from(r.plots[0]!.fields.value!).slice(0, 5), Array.from(spot.slice(0, 5), (v, i) => v - all[i]!));
  assert.deepEqual(Array.from(r.plots[1]!.fields.value!).slice(0, 5), Array.from(all.slice(0, 5)));
});
