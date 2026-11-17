import test from 'node:test';
import assert from 'node:assert/strict';
import { createRunner, runScript } from '../src/app/script/lang/engine.ts';
import type { BarInputs } from '../src/app/script/inputs.ts';
import { levelsAt, newestOf, type PlotOut, type ScriptResult } from '../src/app/script/protocol.ts';
import { onPlot, paintPlot, plotExtent } from '../src/app/script/paint.ts';
import { SWING_SOURCE } from '../src/app/script/starter.ts';
import { SCRIPT_API } from '../src/app/script/records.ts';
import { API_VERSION } from '../src/app/script/lang/analysis.ts';

const MIN = 60_000;
/** Candles of the given highs and lows (close halfway), one a minute from `t0`; `gapAfter` leaves a gap of five minutes after that index. */
function candles(highs: readonly number[], lows: readonly number[], opts: { closes?: readonly number[]; gapAfter?: number; forming?: boolean; vbuy?: readonly number[] } = {}): BarInputs {
  const n = highs.length;
  const time = Float64Array.from({ length: n }, (_, i) => (i + (opts.gapAfter !== undefined && i > opts.gapAfter ? 5 : 0)) * MIN);
  const close = Float64Array.from({ length: n }, (_, i) => opts.closes?.[i] ?? (highs[i]! + lows[i]!) / 2);
  const vbuy = Float64Array.from({ length: n }, (_, i) => opts.vbuy?.[i] ?? 10);
  return {
    tf: MIN, time, open: Float64Array.from(close), high: Float64Array.from(highs), low: Float64Array.from(lows), close, volume: Float64Array.from(close, () => 1),
    sources: { '': { vbuy, vsell: new Float64Array(n).fill(5), lbuy: new Float64Array(n), lsell: new Float64Array(n), markets: 1 } },
    forming: opts.forming ?? false,
  };
}
const flat = (n: number): BarInputs => candles(Array.from({ length: n }, (_, i) => 101 + i), Array.from({ length: n }, (_, i) => 99 + i));
const ok = (r: ScriptResult): Extract<ScriptResult, { ok: true }> => { assert.ok(r.ok, r.ok ? '' : JSON.stringify(r.error)); return r; };
/** Each level of a plot: [start, price, end (null: runs on), text, colour]. */
const levels = (p: PlotOut): [number, number, number | null, string, string][] => {
  const out: [number, number, number | null, string, string][] = [];
  p.fields.value!.forEach((v, s) => { if (Number.isFinite(v)) { const e = p.ends?.[s] ?? NaN; out.push([s, v, Number.isFinite(e) ? e : null, p.texts?.[s] ?? '', p.colors?.[s] ?? '']); } });
  return out;
};

test('levels came with language version 3', () => {
  assert.deepEqual([SCRIPT_API, API_VERSION], [3, 3]);
});

test('a level is kept at the candle its from names and drawn to the one its to names, or on to the right edge', () => {
  // One call: on candle 3 a level from candle 1 to candle 2; on candle 4 one from candle 4 itself (no from), running on.
  const src = 't = time\nvar n = renderer.length, first = n == 4\nif (n == 4 || n == 5) level(first ? 50 : 60, first ? t[2] : NaN, first ? t[1] : NaN, first ? "a" : "", first ? "red" : "")';
  const p = ok(runScript('t', src, {}, flat(6))).plots[0]!;
  assert.equal(p.kind, 'level');
  assert.deepEqual(levels(p), [[1, 50, 2, 'a', 'rgb(255, 0, 0)'], [4, 60, null, '', '']]);
  assert.deepEqual(levelsAt(p, 1), [50]); assert.deepEqual(levelsAt(p, 3), []); assert.deepEqual(levelsAt(p, 5), [60]);
  assert.deepEqual(newestOf(p), [60], 'the levels standing at the newest candle');
});

test('a later call naming the same from replaces the level: ends it, renames and recolours it, or takes it away', () => {
  // All through one call, each candle naming candle 1 as it stands back from it.
  const src = (last: string): string => `t = time\nvar n = renderer.length\nvar pt = n == 3 ? { value: 50, from: t[1], text: "open", color: "red" } : n == 5 ? { value: 50, from: t[3], to: t[0], text: "", color: "" } : n == 6 ? ${last} : null\nif (pt) level(pt)`;
  const ended = ok(runScript('t', src('null'), {}, flat(5))).plots[0]!;
  assert.deepEqual(levels(ended), [[1, 50, 4, '', '']], 'ended at candle 4, its text and colour gone');
  assert.deepEqual(levels(ok(runScript('t', src('{ value: 70, from: t[4], text: "moved" }'), {}, flat(6))).plots[0]!), [[1, 70, null, 'moved', '']], 'moved, renamed and running on again');
  assert.deepEqual(levels(ok(runScript('t', src('{ value: NaN, from: t[4] }'), {}, flat(6))).plots[0]!), [], 'a value that is not a number takes it away');
});

test('from and to name candles by their start: inside a candle, across a gap, never before the first nor after this one', () => {
  // Candles at minutes 0, 1, 2, 8, 9, 10 (a gap after index 2).
  const inp = candles([1, 2, 3, 4, 5, 6], [0, 1, 2, 3, 4, 5], { gapAfter: 2 });
  const src = 'var n = renderer.length\nif (n == 6) {\n level(1, 90)\n level(2, 330)\n level(3, -100)\n level(4, 150, 99999)\n level(5, 600, 0)\n}';
  const r = ok(runScript('t', src, {}, inp));
  const all = r.plots.map(levels);
  assert.deepEqual(all[0], [[1, 1, null, '', '']], 'minute 1.5 is inside candle 1');
  assert.deepEqual(all[1], [[2, 2, null, '', '']], 'minute 5.5 falls in the gap: the candle before it');
  assert.deepEqual(all[2], [], 'before the first candle: nothing');
  assert.deepEqual(all[3], [[2, 4, 5, '', '']], 'a to past this candle is this candle');
  assert.deepEqual(all[4], [[5, 5, 5, '', '']], 'a to before its from ends where it starts');
});

test('a level written into a closed candle by the candle under way is undone when that candle changes: an update gives what a full run gives', () => {
  // Kept numbers only, so a live update runs the newest candle alone. One call: candle 2 draws a level of its own; the candle under way (4)
  // replaces it (price, name, colour and end) when it buys much, and makes no call when it buys little, so nothing of its earlier runs may be
  // left there. The first run, which keeps the closed candles for the updates, is one that replaces it.
  const src = 't = time\nvar n = renderer.length, own = n == 3\nif (own || (n == 5 && vbuy > 50)) level(own ? 7 : vbuy, own ? t[0] : t[2], own ? NaN : t[1], own ? "early" : "big", own ? "blue" : vbuy > 80 ? "red" : "")';
  const at = (v: number): BarInputs => candles([1, 2, 3, 4, 5], [0, 1, 2, 3, 4], { forming: true, vbuy: [10, 10, 10, 10, v] });
  const runner = createRunner('t', src, {});
  for (const v of [90, 60, 10, 90, 10]) {
    const live = ok(runner.run(at(v)));
    const full = ok(runScript('t', src, {}, at(v)));
    assert.deepEqual(live.plots.map(levels), full.plots.map(levels), `buying ${v}`);
  }
  assert.equal(runner.startedAt, 4, 'the updates ran the candle under way alone');
  assert.deepEqual(levels(ok(runner.run(at(10))).plots[0]!), [[2, 7, null, 'early', 'rgb(0, 0, 255)']], 'candle 2\'s own level as it drew it');
  assert.deepEqual(levels(ok(runner.run(at(90))).plots[0]!), [[2, 90, 3, 'big', 'rgb(255, 0, 0)']]);
});

test('levels set the scale where they cross the candles in view, wherever they start, and the pointer finds a level standing at its candle', () => {
  const p = ok(runScript('t', 't = time\nvar n = renderer.length\nif (n == 3 || n == 9) level(n == 3 ? 50 : 80, n == 3 ? t[2] : t[1], n == 3 ? NaN : t[0])', {}, flat(10))).plots[0]!;
  assert.deepEqual(plotExtent(p, 6, 9), [50, 80], 'the level from candle 0 counts in view at 6..9');
  assert.deepEqual(plotExtent(p, 9, 9), [50, 50], 'the one ended at candle 8 does not count at 9');
  const s = { min: 0, max: 100, margins: { top: 0, bottom: 0 } }, f = { x: (t: number) => t / MIN * 10, barW: 10, time: flat(10).time, top: 0, height: 100 };
  assert.ok(onPlot(p, s, f, 5, 55, 50, 3), 'on the level at price 50');
  assert.ok(!onPlot(p, s, f, 5, 55, 30, 3), 'away from it');
});

/** The swing script over hand-built candles, with its options. */
const swing = (inp: BarInputs, opts: Record<string, string | number | boolean> = {}): Map<string, PlotOut> => new Map(ok(runScript('s', SWING_SOURCE, { swing: 2, ...opts }, inp)).plots.map(p => [p.title, p]));

test('strong and weak highs and lows: a swing low turns strong when the rise from it breaks the high it fell from, and ends when price trades at it', () => {
  // Swing 2: a high at candle 2 (110), a low at candle 5 (90), then a rise that closes above 110 at candle 9, then a fall back to 90 at 12.
  const highs = [100, 105, 110, 104, 100, 95, 99, 104, 108, 114, 112, 100, 94, 96, 97];
  const lows = [96, 100, 104, 98, 94, 90, 94, 99, 104, 109, 106, 95, 89, 92, 93];
  const closes = [98, 103, 106, 100, 96, 92, 97, 102, 106, 112, 108, 97, 91, 94, 95];
  const before = swing(candles(highs.slice(0, 9), lows.slice(0, 9), { closes: closes.slice(0, 9) }));
  assert.deepEqual(levels(before.get('Weak lows')!), [[5, 90, null, 'Weak low 90.00', 'rgba(0, 179, 134, 0.65)']], 'known at candle 7, drawn from candle 5, weak: 110 not yet broken');
  assert.deepEqual(levels(before.get('Strong lows')!), []);
  const broken = swing(candles(highs.slice(0, 11), lows.slice(0, 11), { closes: closes.slice(0, 11) }));
  assert.deepEqual(levels(broken.get('Weak lows')!), [], 'moved out of the weak lows');
  assert.deepEqual(levels(broken.get('Strong lows')!), [[5, 90, null, 'Strong low 90.00', 'rgb(0, 179, 134)']], 'the close of 112 broke the high of 110');
  const all = swing(candles(highs, lows, { closes }));
  assert.deepEqual(levels(all.get('Strong lows')!).filter(l => l[0] === 5), [], 'tested at candle 12 (low 89): hidden by default');
  const shown = swing(candles(highs, lows, { closes }), { tested: 'Full' });
  assert.deepEqual(levels(shown.get('Strong lows')!).filter(l => l[0] === 5), [[5, 90, 12, '', 'rgb(0, 179, 134)']], 'shown, it ends at the candle that tested it, without a name');
  // A plot's style is read at its first call: the kinds that drew.
  const drew = (r: Map<string, PlotOut>): PlotOut[] => [...r.values()].filter(p => p.kind === 'level' && p.ends !== null && p.ends !== undefined);
  assert.ok(drew(shown).length >= 2 && drew(shown).every(p => p.style.endShape === 'cross'), 'a cross at each tested level\'s end');
  assert.ok(drew(all).length >= 2 && drew(all).every(p => p.style.endShape === 'none'), 'none where tested levels are hidden');
  assert.equal([...all.values()].filter(p => p.kind !== 'level').length, 0, 'levels alone: no other plot');
  const faint = swing(candles(highs, lows, { closes }), { tested: 'Faint' });
  assert.notEqual(levels(faint.get('Strong lows')!).find(l => l[0] === 5)![4], 'rgb(0, 179, 134)', 'faint: faded towards the background');
});

test('a break counts by the close or by the wick, as set; a high and a low of one candle come from the swings before it', () => {
  // Candle 5 is both a swing high (120) and a swing low (80): its low came from the high of 110 at candle 2, which the closes of 112 broke.
  const outside = candles([100, 101, 110, 104, 102, 120, 115, 114, 113], [95, 96, 100, 98, 97, 80, 99, 98, 97], { closes: [98, 99, 105, 101, 99, 100, 112, 111, 105] });
  assert.deepEqual(levels(swing(outside).get('Strong lows')!), [[5, 80, null, 'Strong low 80.00', 'rgb(0, 179, 134)']], 'from 110, not from its own candle\'s 120');
  // The rise from the low at 5 wicks to 111 (above the 110 high) but closes at 108: a wick break only.
  const highs = [100, 105, 110, 104, 100, 95, 99, 104, 111, 107, 106];
  const lows = [96, 100, 104, 98, 94, 90, 94, 99, 104, 103, 102];
  const closes = [98, 103, 106, 100, 96, 92, 97, 102, 108, 105, 104];
  const inp = candles(highs, lows, { closes });
  assert.equal(levels(swing(inp).get('Weak lows')!).length, 1, 'by the close: still weak');
  assert.equal(levels(swing(inp, { breakBy: 'Wick' }).get('Strong lows')!).length, 1, 'by the wick: strong');
});

test('names and plates follow the settings, and only the most untested levels are kept', () => {
  const highs = [100, 105, 110, 104, 100, 95, 99, 104, 108, 105, 103];
  const lows = [96, 100, 104, 98, 94, 90, 94, 99, 104, 101, 100];
  const inp = candles(highs, lows);
  const short = swing(inp, { names: 'Short', prices: false, nameColors: 'One colour', nameColor: '#123456' });
  const weakHigh = levels(short.get('Weak highs')!)[0]!;
  assert.equal(weakHigh[3], 'WH');
  assert.equal(short.get('Weak highs')!.style.textColor, '#123456');
  assert.equal(levels(swing(inp, { names: 'None' }).get('Weak highs')!)[0]![3], '');
  const all = [...swing(inp).values()].filter(p => p.kind === 'level').flatMap(levels);
  assert.equal(all.length, 3, 'highs at 2 and 8, the low at 5');
  const one = [...swing(inp, { most: 1 }).values()].filter(p => p.kind === 'level').flatMap(levels);
  assert.deepEqual(one.map(l => l[0]), [8], 'the newest kept, the older ones taken away');
});

test('the swing script, kept arrays and all, is put back between updates and draws what a full run draws', () => {
  let seed = 3;
  const rnd = (): number => (seed = (seed * 16807) % 2147483647) / 2147483647;
  const n = 400, c: number[] = []; let p = 100;
  for (let i = 0; i < n; i++) { p *= 1 + (rnd() - 0.5) * 0.02; c.push(p); }
  const base = (last: number): BarInputs => {
    const closes = c.slice(); closes[n - 1] = last;
    return { ...candles(closes.map(x => x * 1.004), closes.map(x => x * 0.996), { closes, forming: true }), tf: MIN };
  };
  const settings: Record<string, string | number>[] = [{}, { tested: 'Full', breakBy: 'Wick' }, { tested: 'Faint', most: 3 }];
  for (const opts of settings) {
    const runner = createRunner('s', SWING_SOURCE, opts);
    // The candle under way swings far up and far down: it tests levels, breaks swings and turns weak ones strong, then takes it back. The
    // first run, which keeps the closed candles for the updates, is one that swung: none of what it did to them may outlive it.
    ok(runner.run(base(c[n - 1]! * 1.2)));
    for (const last of [c[n - 1]!, c[n - 1]! * 0.8, c[n - 1]! * 1.2, c[n - 1]!]) {
      const live = ok(runner.run(base(last)));
      assert.equal(runner.startedAt, n - 1, 'only the candle under way ran');
      const full = ok(runScript('s', SWING_SOURCE, opts, base(last)));
      assert.deepEqual(live.plots.map(q => [q.title, levels(q)]), full.plots.map(q => [q.title, levels(q)]), `${JSON.stringify(opts)} at ${last}`);
    }
  }
});

test('a new swing waits for the candle that shows it to close; a break by the close waits too, one by the wick does not', () => {
  // Swing 2: the low at candle 5 (90) is shown by candle 7. Under way, candle 7 shows nothing yet; closed, it does.
  const highs = [100, 105, 110, 104, 100, 95, 99, 104], lows = [96, 100, 104, 98, 94, 90, 94, 99];
  const lowsOf = (r: Map<string, PlotOut>): number => levels(r.get('Weak lows')!).length + levels(r.get('Strong lows')!).length;
  assert.equal(lowsOf(swing(candles(highs, lows, { forming: true }))), 0, 'under way: not yet');
  assert.equal(lowsOf(swing(candles(highs, lows))), 1, 'closed: drawn from candle 5');
  // Then a candle under way trades above 110 and stands there: a break by the wick at once, by the close only once it closes.
  const more = { highs: [...highs, 112], lows: [...lows, 104], closes: [...highs.map((x, i) => (x + lows[i]!) / 2), 111] };
  const live = (o: Record<string, string>, forming: boolean): string[] => [...swing(candles(more.highs, more.lows, { closes: more.closes, forming }), o).values()].flatMap(p => levels(p).filter(l => l[0] === 5).map(() => p.title));
  assert.deepEqual(live({}, true), ['Weak lows']);
  assert.deepEqual(live({}, false), ['Strong lows']);
  assert.deepEqual(live({ breakBy: 'Wick' }, true), ['Strong lows']);
});

test('a swing setting that is not a whole number of candles is read as one, between 2 and 50', () => {
  const highs = [100, 105, 110, 104, 100, 95, 99, 104, 108, 105, 103], lows = [96, 100, 104, 98, 94, 90, 94, 99, 104, 101, 100];
  const at = (swingSetting: number): number[] => [...swing(candles(highs, lows), { swing: swingSetting }).values()].flatMap(p => levels(p).map(l => l[0]));
  assert.deepEqual(at(2.2), at(2));
  assert.deepEqual(at(0), at(2), 'below 2: 2');
});

test('a function of the script\'s own named level is the script\'s: no plot is made for it, and its calls run it', () => {
  const r = ok(runScript('t', 'function level(x) { return x * 2 }\nline(level(vbuy))', {}, flat(3)));
  assert.deepEqual(r.plots.map(p => p.kind), ['line']);
  assert.deepEqual([...r.plots[0]!.fields.value!], [20, 20, 20]);
  const none = ok(runScript('t', 'function level(x) { return x }\nvar y = level(1)', {}, flat(3)));
  assert.deepEqual(none.warnings.map(w => w.code), ['no-plots']);
});

test('a kept array with holes is put back with its holes, and a chain nested deeper than the limit runs every candle without an error', () => {
  const sparse = 'if (renderer.length == 1) hist = []\nhist[renderer.length * 2] = vbuy\nvar n = 0\nhist.forEach(x => n++)\nline(hist.reduce((s, x) => s + x, 0))\nhistogram(n)';
  const runner = createRunner('t', sparse, {});
  ok(runner.run(flat(5)));
  const inp = { ...flat(5), forming: true };
  const live = ok(runner.run(inp));
  assert.equal(runner.startedAt, 4);
  assert.deepEqual(live.plots.map(p => [...p.fields.value!]), ok(runScript('t', sparse, {}, inp)).plots.map(p => [...p.fields.value!]));
  const deep = 'last = { price: $price.close, prev: last }\nline(last.price)';
  const chain = createRunner('t', deep, {});
  ok(chain.run(flat(300)));
  const again = ok(chain.run({ ...flat(300), forming: true }));
  assert.equal(chain.startedAt, 0, 'deeper than the limit: not put back, run again from the first candle');
  assert.equal(again.plots[0]!.fields.value![299], flat(300).close[299]);
});

test('a level that ended draws its end shape at its end, one per level, and none by default', () => {
  const p = (endShape?: string): PlotOut => ({ kind: 'level', title: '', style: endShape ? { endShape } : {}, fields: { value: Float64Array.from([50, 60, NaN, NaN]) }, colors: null, texts: null, ends: Float64Array.from([2, 2, NaN, NaN]) });
  const draw = (plot: PlotOut): { lines: number; arcs: number } => {
    let lines = 0, arcs = 0;
    const ctx = { save() {}, restore() {}, beginPath() {}, rect() {}, clip() {}, setLineDash() {}, stroke() {}, fill() {}, moveTo() {}, lineTo() { lines++; }, arc() { arcs++; }, fillRect() {}, fillText() {}, measureText: (s: string) => ({ width: s.length * 6 }) } as unknown as CanvasRenderingContext2D;
    paintPlot({ ctx, x: t => t / MIN * 10, barW: 10, tf: MIN, time: flat(4).time, from: 0, to: 3, top: 0, height: 100, w: 1_000, color: '#888', up: '#0a0', down: '#a00' }, plot, { min: 0, max: 100, margins: { top: 0, bottom: 0 } });
    return { lines, arcs };
  };
  assert.deepEqual(draw(p()), { lines: 2, arcs: 0 }, 'two levels, no shapes');
  assert.deepEqual(draw(p('cross')), { lines: 6, arcs: 0 }, 'two strokes of a cross at each of the two ends');
  assert.deepEqual(draw(p('dot')), { lines: 2, arcs: 2 });
});
