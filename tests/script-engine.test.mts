import test from 'node:test';
import assert from 'node:assert/strict';
import { analyze, createRunner, exchangeOf, runScript, sourceFilter, sourcesWith } from '../src/app/script/lang/engine.ts';
import { filterKey, type BarInputs, type SourceInputs } from '../src/app/script/inputs.ts';
import { parse } from '../src/app/script/lang/parser.ts';
import type { ScriptResult } from '../src/app/script/protocol.ts';

const MIN = 60_000;
/** Candles 0..n-1 with close = 100 + i, buys = 10·(i+1), sells = 5·(i+1); `perp` holds two thirds of each, `spot` a third. */
function inputs(n = 6, patch: (i: number) => Partial<Record<'vbuy' | 'vsell' | 'lbuy' | 'lsell', number>> = () => ({})): BarInputs {
  const time = Float64Array.from({ length: n }, (_, i) => i * MIN);
  const mk = (share: number): SourceInputs => {
    const s: SourceInputs = { vbuy: new Float64Array(n), vsell: new Float64Array(n), lbuy: new Float64Array(n), lsell: new Float64Array(n), markets: 1 };
    for (let i = 0; i < n; i++) { const p = patch(i); s.vbuy[i] = (p.vbuy ?? 10 * (i + 1)) * share; s.vsell[i] = (p.vsell ?? 5 * (i + 1)) * share; s.lbuy[i] = (p.lbuy ?? 0) * share; s.lsell[i] = (p.lsell ?? 0) * share; }
    return s;
  };
  return {
    tf: MIN, time,
    open: Float64Array.from(time, (_, i) => 100 + i - 0.5), high: Float64Array.from(time, (_, i) => 101 + i), low: Float64Array.from(time, (_, i) => 99 + i),
    close: Float64Array.from(time, (_, i) => 100 + i), volume: Float64Array.from(time, () => 1),
    sources: { '': mk(1), [filterKey({ kinds: ['perp'] })]: mk(2 / 3), [filterKey({ kinds: ['spot'] })]: mk(1 / 3) },
    forming: false,
  };
}
const ok = (r: ScriptResult): Extract<ScriptResult, { ok: true }> => { assert.ok(r.ok, r.ok ? '' : JSON.stringify(r.error)); return r; };
const values = (r: ScriptResult, k = 0, field = 'value'): number[] => [...ok(r).plots[k]!.fields[field]!].map(v => Math.round(v * 1e6) / 1e6);
const run = (src: string, opts = {}, inp = inputs()): ScriptResult => runScript('t', src, opts, inp);

test('a cumulative delta, as the shortest script writes it', () => {
  assert.deepEqual(values(run('line(cum(vbuy - vsell))')), [5, 15, 30, 50, 75, 105]);
});

test('a name assigned without var starts at 0, keeps its value from candle to candle, and name[1] is its value one candle back', () => {
  const r = run('total = total + 1\nprev = total[1]\nline(total)\nhistogram(prev)');
  assert.deepEqual(values(r, 0), [1, 2, 3, 4, 5, 6]);
  assert.deepEqual(values(r, 1), [1, 1, 2, 3, 4, 5], 'on the first candle there is nothing older: x[1] is x');
  assert.deepEqual(values(run('var x = 0\nx = x + 1\nline(x)')), [1, 1, 1, 1, 1, 1], 'a var starts again each candle');
  assert.deepEqual(values(run('Total = total + 2\nline(TOTAL)')), [2, 4, 6, 8, 10, 12], 'one name whatever its case');
  const cvd = run('delta = vbuy - vsell\ncvd = (renderer.length > 1 ? (cvd[1] || 0) : 0) + delta\nline(cvd)');
  assert.deepEqual(values(cvd), [5, 15, 30, 50, 75, 105]);
});

test('an on-balance volume over the chart\'s candles', () => {
  const r = run('sign = $price.close > $price.open ? 1 : -1\nvolume = vbuy + vsell\nobv = cum(sign * volume)\nplotline(obv, title="obv")');
  assert.deepEqual(values(r), [15, 45, 90, 150, 225, 315]);
  assert.equal(ok(r).plots[0]!.title, 'obv');
});

test('source() reads its expression over its own markets, and the plain words of its filter are read as words', () => {
  const r = run('buyVol = source(vbuy, type=perp)\nsellVol = source(vsell, type=perp)\nline(cum(buyVol - sellVol), title=PERP)');
  assert.deepEqual(values(r), [5, 15, 30, 50, 75, 105].map(v => Math.round(v * 2 / 3 * 1e6) / 1e6));
  assert.equal(ok(r).plots[0]!.title, 'PERP');
  const a = analyze('x = source(vbuy, type=spot)\ny = source(vsell, exchange=BINANCE_FUTURES)\nz = source(vbuy, exchange=COINBASE, quote=usd)');
  assert.deepEqual([...a.sources.keys()].sort(), ['', 'kind=spot', 'venue=coinbase/spot;quote=usd', 'venue=binance/perp'].sort());
  assert.deepEqual(exchangeOf('OKEX'), { venue: 'okx' });
  assert.deepEqual(sourceFilter(parseNamed('type=perp, exchange=BYBIT')), { kinds: ['perp'], venues: ['bybit'] });
});
function parseNamed(text: string) { const s = parse(`f(${text})`)[0]!; if (s.k !== 'expr' || s.e.k !== 'call') throw new Error('call'); return s.e.named; }

test('options: declared with option(), read with options.x, and the values set win over the defaults', () => {
  const src = 'len = option(default=3, type=number, label="Length", min=1)\nup = option(type=color, default=rgb(82,209,88))\nline(sma($price.close, len), color=up)\nline($price.close * options.mult)';
  const a = analyze(src);
  assert.deepEqual(a.declared.map(d => [d.name, d.type, d.value]), [['len', 'number', 3], ['up', 'color', 'rgb(82, 209, 88)']]);
  assert.deepEqual(a.read, ['mult']);
  const r = run(src, { mult: 2 });
  assert.deepEqual(values(r, 0), [100, 100.5, 101, 102, 103, 104]);
  assert.equal(ok(r).plots[0]!.style.color, 'rgb(82, 209, 88)');
  assert.deepEqual(values(r, 1), [200, 202, 204, 206, 208, 210]);
  assert.deepEqual(values(run(src, { len: 1, mult: 1 }), 0), [100, 101, 102, 103, 104, 105]);
});

test('the averages, sums and extremes over a window', () => {
  const r = run('line(sum($price.close, 2))\nline(ema($price.close, 3))\nline(highest($price.high, 2))\nline(lowest($price.low, 3))');
  assert.deepEqual(values(r, 0), [100, 201, 203, 205, 207, 209]);
  assert.deepEqual(values(r, 1), [100, 100.5, 101.25, 102.125, 103.0625, 104.03125]);
  assert.deepEqual(values(r, 2), [101, 102, 103, 104, 105, 106]);
  assert.deepEqual(values(r, 3), [99, 99, 99, 100, 101, 102]);
  const st = values(run('line(stoch($price.close, $price.high, $price.low, 2))'));
  assert.deepEqual(st, [50, 66.666667, 66.666667, 66.666667, 66.666667, 66.666667]);
});

test('a candle not recorded reads NaN: no point, and the running functions carry on from before it', () => {
  const r = run('line(cum(vbuy - vsell))', {}, inputs(5, i => i === 2 ? { vbuy: NaN, vsell: NaN } : {}));
  assert.deepEqual(values(r).map(v => Number.isNaN(v) ? 'na' : v), [5, 15, 'na', 35, 60]);
});

test('object points, per-candle colours, and a point with only a time is a gap', () => {
  const r = run('histogram({ time: time, value: vbuy + vsell, color: vbuy > 30 ? "red" : "green" })\nbrokenarea({ time: time, lowerValue: 0, higherValue: 1, color: interpolate(0.5, rgb(0,0,0), rgb(255,255,255)) })\nvar na = { time: time }\nline(na)');
  const out = ok(r);
  assert.deepEqual(values(r, 0), [15, 30, 45, 60, 75, 90]);
  assert.deepEqual(out.plots[0]!.colors, ['green', 'green', 'green', 'red', 'red', 'red'].map(c => c === 'green' ? 'rgb(0, 128, 0)' : 'rgb(255, 0, 0)'), 'colours read as colours');
  assert.equal(out.plots[1]!.kind, 'brokenarea');
  assert.deepEqual(values(r, 1, 'higherValue'), [1, 1, 1, 1, 1, 1]);
  assert.equal(out.plots[1]!.colors![0], 'rgb(128, 128, 128)');
  assert.ok(values(r, 2).every(Number.isNaN));
});

test('if blocks, plots inside them, Math and Number, and resetting a function\'s state with fns[k].state', () => {
  const src = 'var vol = vbuy + vsell\nif (options.show) {\n  line(Math.max(vol, 50) + Number.EPSILON * 0)\n}\nc = cum(1)\nif (time / 60 % 3 === 2) {\n  fns[0].state = {}\n}\nline(c)';
  const r = run(src, { show: true });
  assert.deepEqual(values(r, 0), [50, 50, 50, 60, 75, 90]);
  assert.deepEqual(values(r, 1), [1, 2, 3, 1, 2, 3], 'the cum starts again after the candle that reset it');
  const off = ok(run(src, { show: false }));
  assert.equal(off.plots.length, 2, 'every plot in the text is a plot, in its order, run or not');
  assert.ok([...off.plots[0]!.fields.value!].every(Number.isNaN));
});

test('plots keep the order they are written in, their style is read before the script runs, and a histogram bar of 0 is not drawn', () => {
  const r = ok(run('up = option(type=color, default=red)\nif (time > 120) line(1, title=late)\nhistogram(vbuy > 30 ? 0 : 1, color=up, priceScaleId=flow, scaleMargins={top: 0.1, bottom: 0})\nplothistogram(priceScaleId="rows")'));
  assert.deepEqual(r.plots.map(p => `${p.kind}:${p.title}`), ['line:late', 'histogram:', 'histogram:']);
  assert.deepEqual(r.plots[1]!.style, { color: 'red', priceScaleId: 'flow', scaleMargins: { top: 0.1, bottom: 0 } });
  assert.deepEqual(values({ ...r }, 1).map(v => Number.isNaN(v) ? 'na' : v), [1, 1, 1, 'na', 'na', 'na']);
  assert.ok([...r.plots[2]!.fields.value!].every(Number.isNaN), 'a plot called with no value draws nothing');
});

test('the functions of the language answer as the dialect does', () => {
  const seq = (src: string): number[] => values(runScript('t', src, {}, inputs(8)));
  // `$price.close` is 100..107 here; the window functions over 1..8 are those over the closes less 99.
  assert.deepEqual(seq('line(sma($price.close - 99, 3))'), [1, 1.5, 2, 3, 4, 5, 6, 7]);
  assert.deepEqual(seq('line(sum($price.close - 99, 3))'), [1, 3, 6, 9, 12, 15, 18, 21]);
  assert.deepEqual(seq('line(ema($price.close - 99, 3))'), [1, 1.5, 2.25, 3.125, 4.0625, 5.03125, 6.015625, 7.007813]);
  assert.deepEqual(seq('line(rma($price.close - 99, 3))'), [1, 1.333333, 1.888889, 2.592593, 3.395062, 4.263374, 5.175583, 6.117055]);
  assert.deepEqual(seq('line(last($price.close - 99, 3))'), [1, 1, 1, 2, 3, 4, 5, 6]);
  assert.deepEqual(seq('var v = $price.close - 99\nline(stoch(v, v + 1, v - 1, 3))'), [50, 66.666667, 75, 75, 75, 75, 75, 75]);
});

test('$price.color colours the chart\'s candles, and the plots are optional then', () => {
  const r = ok(run('$price.color = $price.close > 102 ? "red" : "blue"'));
  assert.deepEqual(r.candleColors, ['rgb(0, 0, 255)', 'rgb(0, 0, 255)', 'rgb(0, 0, 255)', 'rgb(255, 0, 0)', 'rgb(255, 0, 0)', 'rgb(255, 0, 0)']);
  assert.ok(!r.warnings.some(w => w.code === 'no-plots'));
});

test('functions, loops, arrays and dates work as in JavaScript', () => {
  const src = 'function sq(x) { return x * x }\nvar arr = [1, 2, 3].map(v => sq(v))\nvar s = 0\nfor (let i = 0; i < arr.length; i++) s += arr[i]\nvar d = new Date(time * 1000)\nline(s + d.getUTCMinutes() + (String(1.234.toFixed(1)) === "1.2" ? 100 : 0))';
  assert.deepEqual(values(run(src)), [114, 115, 116, 117, 118, 119]);
});

test('a loop that never ends is stopped by the step budget, with where it ran', () => {
  const r = run('var x = 0\nwhile (true) {\n  x++\n}');
  assert.ok(!r.ok);
  assert.equal(r.error.code, 'budget');
  assert.equal(r.error.line, 2);
});

test('a script cannot reach the page: no constructor, prototype or global object leads anywhere', () => {
  assert.ok(values(run('line(Math.constructor)')).every(Number.isNaN), 'a member that leads out reads undefined');
  for (const src of ['line("".constructor.constructor("return 1")())', 'var f = [].map.constructor\nline(f("return 1")())', 'line(window.location)', 'line(globalThis)', 'var o = {}\nline(o.__proto__.toString())', 'line(Math.constructor.call(1))']) {
    const r = run(src);
    assert.ok(!r.ok, src);
    assert.ok(['not-callable', 'unknown-name', 'no-member'].includes(r.error.code), `${src}: ${r.error.code}`);
  }
  const big = run('var a = []\nwhile (true) a.push(1, 2, 3, 4, 5, 6, 7, 8)');
  assert.ok(!big.ok && (big.error.code === 'too-large' || big.error.code === 'budget'));
});

test('a name a table only inherits names nothing, and a member of anything but the script\'s own objects reads as nothing', () => {
  for (const src of ['line(constructor)', 'line(toString)', 'line(hasOwnProperty)', 'line(valueOf)', 'line(__proto__)']) {
    const r = run(src);
    assert.ok(!r.ok && r.error.code === 'unknown-name', `${src}: ${r.ok ? 'ran' : r.error.code}`);
  }
  for (const src of ['line(Math.toString())', 'line([].valueOf())', 'line([].hasOwnProperty("x"))', 'line(new Date(0).valueOf.call(1))', 'line(Number.toString())']) {
    const r = run(src);
    assert.ok(!r.ok && (r.error.code === 'not-callable' || r.error.code === 'no-member'), `${src}: ${r.ok ? 'ran' : r.error.code}`);
  }
  assert.ok(values(run('var d = new Date(0)\nline(d.constructor === undefined && [].constructor === undefined ? 1 : 0)')).every(v => v === 1));
  assert.ok(values(run('line(fns[0] === undefined ? 1 : 0)')).every(v => v === 1));
  const set = run('var a = []\na.__proto__ = 1');
  assert.ok(!set.ok && set.error.code === 'no-member');
});

test('what a script makes is paid for: texts and arrays that grow fast run out of steps or size, never memory', () => {
  for (const src of ['var s = "xx"\nwhile (true) s = s.concat(s, s)', 'var s = "ab"\nwhile (true) s = s.replaceAll("a", s)', 'var a = new Array(1000000)\nline(a.join("xx").length)', 'var keep = []\nfor (let i = 0; i < 1000000000; i++) keep.push(new Array(100000))', 'var s = "x"\nwhile (true) s = s + s', 'var keep = []\nwhile (true) keep.push(Array.from({ length: 1000000 }))']) {
    const r = runScript('t', src, {}, inputs(2));
    assert.ok(!r.ok && (r.error.code === 'too-large' || r.error.code === 'budget'), `${src}: ${r.ok ? 'ran' : r.error.code}`);
  }
});

test('a run over the same closed candles runs the candle under way alone, and gives what a run over every candle gives', () => {
  const src = 'x = x + vbuy\nprev = x[1]\nvar c = cum(vbuy - vsell)\nline(sma(c, 3), title=avg)\nline(x - prev, title=step)\nhistogram({ time: time, value: ema(vsell, 4), color: vbuy > 30 ? "red" : "blue" })\nif (vbuy > 40) $price.color = "red"';
  const base = inputs(8);
  const runner = createRunner('t', src, {});
  const first = ok(runner.run(base));
  assert.equal(runner.startedAt, 0);
  // The candle under way changed: only it runs again.
  const live = inputs(8, i => i === 7 ? { vbuy: 999 } : {});
  const again = ok(runner.run(live));
  assert.equal(runner.startedAt, 7);
  const full = ok(runScript('t', src, {}, inputs(8, i => i === 7 ? { vbuy: 999 } : {})));
  assert.deepEqual(again.plots.map(p => [...p.fields.value!]), full.plots.map(p => [...p.fields.value!]));
  assert.deepEqual(again.plots[2]!.colors, full.plots[2]!.colors);
  assert.deepEqual(again.candleColors, full.candleColors);
  assert.notDeepEqual(first.plots[0]!.fields.value, again.plots[0]!.fields.value);
  // A new candle after it: the one that closed runs with its final numbers, and the new one after it.
  const grown = ok(runner.run(inputs(9, i => i === 7 ? { vbuy: 999 } : {})));
  assert.equal(runner.startedAt, 7);
  assert.deepEqual(grown.plots.map(p => [...p.fields.value!]), ok(runScript('t', src, {}, inputs(9, i => i === 7 ? { vbuy: 999 } : {}))).plots.map(p => [...p.fields.value!]));
  // An older candle changed (history filled in): every candle runs again.
  const older = ok(runner.run(inputs(9, i => i === 2 ? { vbuy: 1 } : i === 7 ? { vbuy: 999 } : {})));
  assert.equal(runner.startedAt, 0);
  assert.deepEqual(older.plots.map(p => [...p.fields.value!]), ok(runScript('t', src, {}, inputs(9, i => i === 2 ? { vbuy: 1 } : i === 7 ? { vbuy: 999 } : {}))).plots.map(p => [...p.fields.value!]));
  void first;
});

test('limits that a script could get round: text of a nested array, sparse arrays, nesting too deep to read', () => {
  const nested = run('var a = ["x"]\nfor (var j = 0; j < 17; j++) a = [a, a]\nline(String(a).length)');
  assert.ok(!nested.ok && nested.error.code === 'too-large', nested.ok ? 'ran' : nested.error.code);
  const sparse = run('var a = []\na.length = 100000\nvar keep = []\nfor (var j = 0; j < 20; j++) keep.push(a.map(x => x))\nline(keep.length)');
  assert.ok(!sparse.ok && sparse.error.code === 'budget', sparse.ok ? 'ran' : sparse.error.code);
  const deep = run('line(' + '1+'.repeat(7000) + '1)');
  assert.ok(!deep.ok && deep.error.code === 'too-deep', deep.ok ? 'ran' : deep.error.code);
  assert.throws(() => analyze('line(' + '('.repeat(150) + '1' + ')'.repeat(150) + ' + ' + '[1].map(x => '.repeat(100) + 'x' + ')'.repeat(100) + ')'), (e: unknown) => (e as { info?: { code: string } }).info?.code === 'too-deep');
});

test('a source names its markets with options and with words joined by +, and one it cannot read reads nothing', () => {
  const a = analyze('venue = option(default=COINBASE, type=text)\nline(source(vbuy, exchange=options.venue))\nline(source(vsell, exchange=venue))\nline(source(vbuy, exchange=BYBIT+OKEX))\nvar x = "KRAKEN"\nline(source(vbuy, exchange=x + "S"))');
  assert.deepEqual([...a.sources.keys()].sort(), ['', 'venue=?', 'venue=bybit+okx', 'venue=coinbase/spot'].sort());
  assert.deepEqual([...sourcesWith(a, { venue: 'BINANCE_FUTURES' }).keys()].sort(), ['', 'venue=?', 'venue=binance/perp', 'venue=bybit+okx'].sort(), 'the option set wins over the default');
});

test('the functions that keep state skip a candle that was not recorded, and read a window made shorter from its own newest values', () => {
  const gap = inputs(4, i => i === 1 ? { vbuy: NaN } : {});
  assert.deepEqual(values(runScript('t', 'line(last(vbuy, 2))', {}, gap)).map(v => Number.isNaN(v) ? 'na' : v), [10, 'na', 10, 30]);
  assert.deepEqual(values(runScript('t', 'line(sma(vbuy, renderer.length < 4 ? 3 : 1))', {}, inputs(5))), [10, 15, 20, 40, 50]);
  assert.deepEqual(values(runScript('t', 'line(highest(vbuy, renderer.length < 4 ? 3 : 1))', {}, inputs(5))), [10, 20, 30, 40, 50]);
  assert.deepEqual(values(runScript('t', 'line(cma($price.close - 99, 3))', {}, inputs(4))), [1, 1.5, 1.833333, 2.444444]);
  const ha = ok(runScript('t', 'candlestick(heikinashi({ open: $price.open, high: $price.high, low: $price.low, close: renderer.length === 2 ? NaN : $price.close }))', {}, inputs(4)));
  assert.ok(Number.isNaN(ha.plots[0]!.fields.close![1]!) && Number.isFinite(ha.plots[0]!.fields.close![2]!));
});

test('JavaScript as it is: do-while, a binding per turn of a for with let, one evaluation of what is assigned to, var without a value, Number(), comparisons with arrays', () => {
  const dw = ok(run('do { line(1); line(2) } while (false)'));
  assert.deepEqual(dw.plots.map(p => p.fields.value![0]), [1, 2]);
  assert.deepEqual(values(run('var x = 0\ndo { x++; break } while (true)\nline(x)')), [1, 1, 1, 1, 1, 1]);
  assert.deepEqual(values(run('function f(x) { return x }\nx = x + 1\nline(f(x))')), [1, 2, 3, 4, 5, 6], 'a parameter of a function does not hide a kept name outside it');
  const ref = ok(run('var i = 0\nvar a = [1, 2]\na[i++]++\nline(i)\nline(a[0])'));
  assert.deepEqual([ref.plots[0]!.fields.value![0], ref.plots[1]!.fields.value![0]], [1, 2]);
  const turns = ok(run('var f = []\nfor (let i = 0; i < 3; i++) f.push(() => i)\nline(f[0]())\nline(f[1]())\nline(f[2]())'));
  assert.deepEqual(turns.plots.map(p => p.fields.value![0]), [0, 1, 2]);
  assert.deepEqual(values(run('var x = 5\nvar x\nline(x)')), [5, 5, 5, 5, 5, 5]);
  assert.deepEqual(values(run('function f(x) { var x; return x }\nline(f(7))')), [7, 7, 7, 7, 7, 7]);
  assert.deepEqual(values(run('line(Number("123") + Number.EPSILON * 0)')), [123, 123, 123, 123, 123, 123]);
  assert.deepEqual(values(run('line(([1] == 1 ? 1 : 0) + ([2] < "10" ? 10 : 0))')), [1, 1, 1, 1, 1, 1]);
});

test('a script that keeps arrays, functions or writes its options runs every candle, so an update gives what a full run gives', () => {
  const cases = [
    'if (renderer.length === 1) { a = []; b = a }\na.push(vbuy)\nline(b.length)',
    'if (renderer.length === 1) counter = (function () { var n = 0; return function () { return ++n } })()\nline(counter())',
    'options.n = nz(options.n) + 1\nline(options.n)',
  ];
  for (const src of cases) {
    const runner = createRunner('t', src, {});
    ok(runner.run(inputs(3)));
    const live = ok(runner.run(inputs(3, i => i === 2 ? { vbuy: 999 } : {})));
    assert.equal(runner.startedAt, 0, src);
    assert.deepEqual([...live.plots[0]!.fields.value!], [...ok(runScript('t', src, {}, inputs(3, i => i === 2 ? { vbuy: 999 } : {}))).plots[0]!.fields.value!], src);
  }
  const simple = createRunner('t', 'x = x + vbuy\nline(x)', {});
  simple.run(inputs(3)); simple.run(inputs(3, i => i === 2 ? { vbuy: 1 } : {}));
  assert.equal(simple.startedAt, 2, 'a script that keeps numbers alone still runs only the candle under way');
});

test('an option written, or a plot styled, on the candle under way does not outlive that candle\'s run', () => {
  const same = (src: string): void => {
    const runner = createRunner('t', src, {});
    ok(runner.run(inputs(3)));
    const live = ok(runner.run(inputs(3, i => i === 2 ? { vbuy: 99 } : {})));
    const full = ok(runScript('t', src, {}, inputs(3, i => i === 2 ? { vbuy: 99 } : {})));
    assert.deepEqual(live.plots.map(p => [p.title, p.style, [...p.fields.value!]]), full.plots.map(p => [p.title, p.style, [...p.fields.value!]]), src);
  };
  same('if (renderer.length === 3) options.n = nz(options.n) + 1\nline(nz(options.n))');
  same('if (renderer.length === 3) line(1, color=vbuy < 50 ? "red" : "blue", title=String(vbuy))');
  const long = ok(run('var c = "red".padEnd(10000, " ")\n$price.color = c\nline({ time: time, value: 1, color: c })'));
  assert.equal(long.candleColors, undefined, 'a colour longer than any colour is not read');
});

test('colours and styles a script gives are read and held short before they leave the worker', () => {
  const r = ok(run('if (renderer.length === 1) c = "x".padEnd(10000, "x")\nline({ time: time, value: 1, color: c })\nhistogram(1, title=' + '"' + 'y'.repeat(500) + '"' + ', color="not a colour")'));
  assert.equal(r.plots[0]!.colors, null, 'a text that is not a colour colours nothing');
  assert.ok(r.plots[1]!.title.length <= 120);
  const named = ok(run('histogram({ time: time, value: 1, color: "RED" })\n$price.color = "rgba(1,2,3,0.5)"'));
  assert.deepEqual([named.plots[0]!.colors![0], named.candleColors![0]], ['rgb(255, 0, 0)', 'rgba(1, 2, 3, 0.5)']);
});

test('errors name the code and the place', () => {
  const r = run('line(\n  nope + 1)');
  assert.ok(!r.ok);
  assert.deepEqual([r.error.code, r.error.line, r.error.col, r.error.detail], ['unknown-name', 2, 3, 'nope']);
  const syntax = run('line(1 +)');
  assert.ok(!syntax.ok && syntax.error.code === 'unexpected');
  const counts = ok(run('line(cbuy + csell)'));
  assert.ok(counts.warnings.some(w => w.code === 'no-counts'));
});

test('a window longer than the candles read is warned of, with its line, the length asked, the length it has and the candles there are', () => {
  const long = (r: ScriptResult): unknown[] => ok(r).warnings.filter(w => w.code === 'long-window');
  assert.deepEqual(long(run('var a = sum($price.close, 3)\nline(sma($price.close, 50) + a)', {}, inputs(20))), [{ code: 'long-window', detail: '2|50|50|20' }], 'the longest one');
  assert.deepEqual(long(run('line(sma($price.close, 20))', {}, inputs(20))), [], 'a window the candles fill is not');
  assert.deepEqual(long(run('line(ema($price.close, 500))', {}, inputs(20))), [], 'an average that weighs every candle, not a window, is not');
  assert.deepEqual(long(run('line(stoch($price.close, $price.high, $price.low, 30))', {}, inputs(20))), [{ code: 'long-window', detail: '1|30|30|20' }]);
  // A live update runs the newest candles alone and says the same.
  const runner = createRunner('t', 'line(sum($price.close, 50))', {});
  assert.deepEqual(long(runner.run(inputs(20))), [{ code: 'long-window', detail: '1|50|50|20' }]);
  assert.deepEqual(long(runner.run(inputs(21))), [{ code: 'long-window', detail: '1|50|50|21' }]);
  assert.ok(runner.startedAt > 0);
  // A window asked on some candles only (here the early ones): a live update that runs the newest alone still says it (review round 1).
  const some = createRunner('t', 'y = $price.close < 105 ? sma($price.close, 300) : 1\nline(y)', {});
  assert.deepEqual(long(some.run(inputs(20))), [{ code: 'long-window', detail: '1|300|300|20' }]);
  assert.deepEqual(long(some.run(inputs(21))), [{ code: 'long-window', detail: '1|300|300|21' }]);
  assert.ok(some.startedAt > 0);
  assert.deepEqual(long(some.run(inputs(22))), [{ code: 'long-window', detail: '1|300|300|22' }]);
  // A window is taken at most 100,000 candles long (MAX_WINDOW), and said so with what was asked; one that is not a number (Infinity too) is
  // one candle, and nothing is said.
  assert.deepEqual(long(run('line(sma($price.close, 500000))', {}, inputs(20))), [{ code: 'long-window', detail: '1|500000|100000|20' }]);
  assert.deepEqual(long(run('line(sma($price.close, Infinity))', {}, inputs(20))), []);
});
