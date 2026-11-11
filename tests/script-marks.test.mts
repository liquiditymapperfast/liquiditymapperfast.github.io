import test from 'node:test';
import assert from 'node:assert/strict';
import { analyze, createRunner, runScript } from '../src/app/script/lang/engine.ts';
import type { BarInputs } from '../src/app/script/inputs.ts';
import { MARK_TEXT, MARK_TIP, MAX_ALERTS, type PlotOut, type ScriptResult } from '../src/app/script/protocol.ts';
import { markBox, markPlace, markPosition, markShape, paintPlot, textOn, type Frame, type MarkBox } from '../src/app/script/paint.ts';
import { markAt, markLines, markText, type DrawnMark } from '../src/app/script/marks.ts';
import { ALERT_FRESH_MS, AlertNews, fingerprint } from '../src/app/script/alert-news.ts';
import { scriptNotes } from '../src/app/sound/rules.ts';
import { SCRIPT_API } from '../src/app/script/records.ts';

const MIN = 60_000;
/** Candles 0..n-1: open 100 + i, high 102 + i, low 98 + i, close 101 + i, volume i + 1; `forming` the newest still under way. */
function inputs(n = 6, forming = false): BarInputs {
  const time = Float64Array.from({ length: n }, (_, i) => i * MIN);
  const flat = (): Float64Array => new Float64Array(n);
  return {
    tf: MIN, time,
    open: Float64Array.from(time, (_, i) => 100 + i), high: Float64Array.from(time, (_, i) => 102 + i), low: Float64Array.from(time, (_, i) => 98 + i),
    close: Float64Array.from(time, (_, i) => 101 + i), volume: Float64Array.from(time, (_, i) => i + 1),
    sources: { '': { vbuy: flat(), vsell: flat(), lbuy: flat(), lsell: flat(), markets: 1 } },
    forming,
  };
}
const ok = (r: ScriptResult): Extract<ScriptResult, { ok: true }> => { assert.ok(r.ok, r.ok ? '' : JSON.stringify(r.error)); return r; };
const run = (src: string, inp = inputs()): Extract<ScriptResult, { ok: true }> => ok(runScript('t', src, {}, inp));

test('a mark holds a value, a text and a tip a candle, given in order or as an object with its colour', () => {
  const r = run('if (renderer.length % 2 == 0) mark($price.high, "up " + renderer.length, "the tip")\nmark({value: $price.low, text: "lo", tip: "below", color: "#ff0000"}, position=below, shape=triangleUp)');
  const [a, b] = r.plots as [PlotOut, PlotOut];
  assert.equal(a.kind, 'mark');
  assert.deepEqual([...a.fields.value!].map(v => Number.isNaN(v) ? null : v), [null, 103, null, 105, null, 107]);
  assert.deepEqual(a.texts, ['', 'up 2', '', 'up 4', '', 'up 6']);
  assert.deepEqual(a.tips, ['', 'the tip', '', 'the tip', '', 'the tip']);
  assert.equal(b.style.position, 'below'); assert.equal(b.style.shape, 'triangleUp');
  assert.deepEqual(b.texts, Array(6).fill('lo'));
  assert.deepEqual(b.colors, Array(6).fill('rgb(255, 0, 0)'));
  const plain = run('mark($price.close)').plots[0]!;
  assert.equal(plain.texts, null, 'a mark with no text holds none');
  assert.equal(run('mark($price.close, "x", "", "blue")').plots[0]!.colors![0], 'rgb(0, 0, 255)', 'a colour as the fourth value');
});

test('a mark\'s texts are held short and paid for', () => {
  const r = run(`mark($price.high, "${'x'.repeat(100)}", "${'y'.repeat(2000)}")`);
  assert.equal(r.plots[0]!.texts![0]!.length, MARK_TEXT);
  assert.equal(r.plots[0]!.tips![0]!.length, MARK_TIP);
  assert.ok(r.steps > run('mark($price.high)').steps, 'a mark with texts costs steps');
  assert.deepEqual(run('mark(NaN, "never")').plots[0]!.texts, null, 'a mark at no value has no text');
});

test('a run of the candle under way alone keeps the marks of the closed candles, as a run of every candle gives them', () => {
  const src = 'hi = $price.high\nif (hi > hi[1]) mark(hi, "up", "took the high before")';
  const runner = createRunner('t', src, {});
  const first = ok(runner.run(inputs(6, true)));
  const longer = inputs(7, true);
  const second = ok(runner.run(longer));
  assert.ok(runner.startedAt > 0, 'the second run started after the closed candles');
  const full = run(src, inputs(7, true));
  assert.deepEqual(second.plots[0]!.texts, full.plots[0]!.texts);
  assert.deepEqual(second.plots[0]!.tips, full.plots[0]!.tips);
  assert.deepEqual(first.plots[0]!.texts!.slice(0, 5), second.plots[0]!.texts!.slice(0, 5));
});

test('the candle\'s volume, and whether it is still under way', () => {
  assert.deepEqual([...run('line($price.volume + bar.volume)').plots[0]!.fields.value!], [2, 4, 6, 8, 10, 12]);
  const forming = run('line(renderer.forming ? 1 : 0)', inputs(4, true)).plots[0]!.fields.value!;
  assert.deepEqual([...forming], [0, 0, 0, 1]);
  assert.deepEqual([...run('line(renderer.forming ? 1 : 0)', inputs(4, false)).plots[0]!.fields.value!], [0, 0, 0, 0], 'no candle is under way once the newest has closed');
  assert.ok(!analyze('x = renderer.forming').warnings.some(w => w.code === 'unsupported-member'));
});

test('the change in open interest reads where it was given, NaN elsewhere, and a run over other open interest runs every candle', () => {
  const inp = inputs(4, true);
  inp.oichg = Float64Array.from([NaN, 5, -3, 2]);
  assert.deepEqual([...run('line(oichg + bar.oichg)', inp).plots[0]!.fields.value!].map(v => Number.isNaN(v) ? null : v), [null, 10, -6, 4]);
  assert.ok(Number.isNaN(run('line(oichg)').plots[0]!.fields.value![0]!), 'without it, NaN');
  assert.ok(analyze('x = oichg').inputs.has('oichg') && analyze('x = bar.oichg').inputs.has('oichg'), 'the page knows a script reads it');
  assert.ok(analyze('x = bar["oichg"]').inputs.has('oichg') && analyze('var b = bar\nx = b.oichg').inputs.has('oichg'), 'or may read it');
  assert.ok(!analyze('x = bar.close + bar.vbuy').inputs.has('oichg'), 'other members of bar do not ask for it');
  const runner = createRunner('t', 'x = x + nz(oichg)\nline(x)', {});
  runner.run(inp);
  const other = inputs(5, true); other.oichg = Float64Array.from([NaN, 6, -3, 2, 1]);
  runner.run(other);
  assert.equal(runner.startedAt, 0, 'an older candle\'s open interest changed: every candle runs again');
});

test('alerts come back only from the newest candles, once a call a candle, with their sound and when they are meant to sound', () => {
  const r = run('alert("candle " + renderer.length, sound=rise)\nalert("again")\nif (renderer.length > 2) alert("closed", when=close, sound=bogus)', inputs(5, true));
  assert.deepEqual(r.alerts!.map(a => [a.t / MIN, a.text, a.sound, a.when, a.forming]), [
    [3, 'candle 4', 'rise', 'bar', false], [3, 'again', 'chime', 'bar', false], [3, 'closed', 'chime', 'close', false],
    [4, 'candle 5', 'rise', 'bar', true], [4, 'again', 'chime', 'bar', true], [4, 'closed', 'chime', 'close', true],
  ]);
  const closed = run('alert("x")', inputs(5, false));
  assert.deepEqual(closed.alerts!.map(a => a.t / MIN), [4], 'with no candle under way the newest closed one is the only one');
  assert.equal(run('for (var k = 0; k < 3; k++) alert("loop " + k)').alerts!.length, 1, 'one call makes one alert a candle');
  assert.equal(run('for (var k = 0; k < 40; k++) { alert("a"); alert("b"); alert("c"); alert("d"); alert("e"); alert("f"); alert("g"); alert("h"); alert("i") }', inputs(3, true)).alerts!.length, 18, 'nine calls, each once a candle, on the two newest candles');
  assert.ok(!run('alert("only")').warnings.some(w => w.code === 'no-plots'), 'a script that only alerts is not told it draws nothing');
});

test('an alert is news once, never on the first answer for a chart, a close alert once its candle closed, and a closed candle\'s only soon after', () => {
  const news = new AlertNews();
  const res = (alerts: Extract<ScriptResult, { ok: true }>['alerts']): Extract<ScriptResult, { ok: true }> => ({ id: 'a', ok: true, plots: [], warnings: [], steps: 0, ms: 0, alerts });
  const at = (t: number, when: 'bar' | 'close', forming: boolean) => ({ site: 1, t, text: 'x', sound: 'chime' as const, when, forming });
  assert.deepEqual(news.take(res([at(0, 'bar', true)]), 'c', MIN, 0, 30_000), [], 'the first answer only takes note');
  assert.deepEqual(news.take(res([at(0, 'bar', true)]), 'c', MIN, 0, 31_000), [], 'seen already');
  assert.equal(news.take(res([at(MIN, 'bar', true)]), 'c', MIN, 0, MIN + 1_000).length, 1, 'a new candle\'s alert is news');
  assert.deepEqual(news.take(res([at(MIN, 'close', true)]), 'c', MIN, 0, MIN + 2_000), [], 'a close alert waits for the close');
  assert.equal(news.take(res([at(MIN, 'close', false)]), 'c', MIN, MIN, 2 * MIN + 1_000).length, 1, 'and sounds once it closed');
  assert.deepEqual(news.take(res([at(2 * MIN, 'close', false)]), 'c', MIN, 2 * MIN, 3 * MIN + ALERT_FRESH_MS + 1), [], 'too long after the close it is history');
  assert.deepEqual(news.take(res([at(5 * MIN, 'bar', true)]), 'other', MIN, 4 * MIN, 5 * MIN), [], 'another chart starts by taking note again');
  assert.notEqual(fingerprint('line(x)'), fingerprint('line(y)'));
});

test('many alerts: a run of the candle under way alone hands back the same ones a full run does, and nothing still handed back is forgotten', () => {
  // Twenty calls: more than a candle may hand back. A full run, then the candle under way alone, then a new candle.
  const src = Array.from({ length: 20 }, (_, k) => `alert("a${k}")`).join('\n');
  const runner = createRunner('t', src, {});
  const first = ok(runner.run(inputs(6, true))), again = ok(runner.run(inputs(6, true)));
  assert.ok(runner.startedAt > 0);
  const of = (r: Extract<ScriptResult, { ok: true }>, t: number): string[] => r.alerts!.filter(a => a.t === t).map(a => a.text);
  assert.equal(of(first, 5 * MIN).length, MAX_ALERTS, 'each candle hands back up to the cap');
  assert.deepEqual(of(again, 5 * MIN), of(first, 5 * MIN), 'the same first calls, however the run started');
  const news = new AlertNews();
  assert.deepEqual(news.take(first, 'c', MIN, 4 * MIN, 5 * MIN + 1_000), []);
  assert.deepEqual(news.take(again, 'c', MIN, 4 * MIN, 5 * MIN + 2_000), [], 'nothing is news the second time');
  // Many charts and many alerts each: what a chart still hands back stays seen.
  const busy = (t: number) => res2(Array.from({ length: 2 * MAX_ALERTS }, (_, k) => ({ site: k, t: t + (k % 2) * MIN, text: 'x', sound: 'chime' as const, when: 'bar' as const, forming: k % 2 === 1 })));
  for (let c = 0; c < 20; c++) news.take(busy(0), `chart${c}`, MIN, 0, MIN + 1_000);
  for (let c = 0; c < 20; c++) assert.deepEqual(news.take(busy(0), `chart${c}`, MIN, 0, MIN + 2_000), [], `chart${c} repeats nothing`);
});
const res2 = (alerts: NonNullable<Extract<ScriptResult, { ok: true }>['alerts']>): Extract<ScriptResult, { ok: true }> => ({ id: 'a', ok: true, plots: [], warnings: [], steps: 0, ms: 0, alerts });

test('a script alert makes the page\'s own sounds, or none', () => {
  assert.ok(scriptNotes('chime', 1).length > 0 && scriptNotes('rise', 1).length > 0 && scriptNotes('fall', 1).length > 0 && scriptNotes('tick', 1).length > 0);
  assert.deepEqual(scriptNotes('none', 1), []);
  assert.ok(scriptNotes('rise', 1)[0]!.freq < scriptNotes('rise', 1)[1]!.freq && scriptNotes('fall', 1)[0]!.freq > scriptNotes('fall', 1)[1]!.freq, 'rise climbs, fall drops');
  assert.equal(SCRIPT_API, 2, 'marks and alerts are language version 2');
});

/** A canvas context that records the paths stroked and the texts and boxes drawn. */
function recorder(): { ctx: CanvasRenderingContext2D; segments: [number, number, number, number][]; texts: string[]; fills: number } {
  const segments: [number, number, number, number][] = [], texts: string[] = [];
  let at: [number, number] = [0, 0], fills = 0;
  const ctx = {
    save() {}, restore() {}, beginPath() {}, rect() {}, clip() {}, closePath() {}, setLineDash() {}, stroke() {}, arc() {}, roundRect() {},
    fill() { fills++; }, fillRect() {}, moveTo(x: number, y: number) { at = [x, y]; }, lineTo(x: number, y: number) { segments.push([at[0], at[1], x, y]); at = [x, y]; },
    fillText(s: string) { texts.push(s); }, measureText(s: string) { return { width: s.length * 6 }; },
  } as unknown as CanvasRenderingContext2D;
  return { ctx, segments, texts, get fills() { return fills; } };
}
const frame = (ctx: CanvasRenderingContext2D, n: number, barW: number, marks?: (b: MarkBox) => void): Frame => ({
  ctx, x: t => t / MIN * barW, barW, tf: MIN, time: Float64Array.from({ length: n }, (_, i) => i * MIN), from: 0, to: n - 1, top: 0, height: 100, w: 1_000,
  color: '#888', up: '#0a0', down: '#a00', ...(marks ? { marks } : {}),
});
const scale = { min: 0, max: 100, margins: { top: 0, bottom: 0 } };

test('a stepped line (lineType 1) is a level across each candle, joined to the next, and a point alone still draws its level', () => {
  const rec = recorder();
  const line: PlotOut = { kind: 'line', title: '', style: { lineType: 1 }, fields: { value: Float64Array.from([50, 50, NaN, 20]) }, colors: null };
  paintPlot(frame(rec.ctx, 4, 10), line, scale);
  assert.deepEqual(rec.segments, [[0, 50, 10, 50], [10, 50, 10, 50], [10, 50, 20, 50], [30, 80, 40, 80]]);
  const plainLine = recorder();
  paintPlot(frame(plainLine.ctx, 4, 10), { ...line, style: {} }, scale);
  assert.deepEqual(plainLine.segments, [[5, 50, 15, 50]], 'without steps a line joins the middles, and a point alone draws nothing');
});

test('marks draw their texts where there is room and tell where they are; crowded labels become dots and crowded texts give way', () => {
  const plot = (shape: string): PlotOut => ({ kind: 'mark', title: '', style: { shape, position: 'above' }, fields: { value: Float64Array.from([50, 50, 50]) }, colors: null, texts: ['up', 'in', 'out'], tips: null });
  const wide = recorder(), boxes: MarkBox[] = [];
  paintPlot(frame(wide.ctx, 3, 40, b => boxes.push(b)), plot('label'), scale);
  assert.deepEqual(wide.texts, ['up', 'in', 'out']);
  assert.deepEqual(boxes.map(b => b.i), [0, 1, 2]);
  assert.ok(boxes.every(b => b.y + b.h <= 50 - 3), 'a mark above its value stands clear of it');
  const narrow = recorder(), small: MarkBox[] = [];
  paintPlot(frame(narrow.ctx, 3, 4, b => small.push(b)), plot('label'), scale);
  assert.ok(narrow.texts.length < 3, 'labels with no room are not written over one another');
  const texts = recorder(), told: MarkBox[] = [];
  paintPlot(frame(texts.ctx, 3, 4, b => told.push(b)), plot('text'), scale);
  assert.equal(told.length, texts.texts.length, 'a text that gives way is not told as drawn');
});

test('a mark under the pointer, its popup, and how it reads in a readout', () => {
  const plot: PlotOut = { kind: 'mark', title: 'Signals', style: {}, fields: { value: Float64Array.from([10, NaN]) }, colors: null, texts: ['Breakout ↑', ''], tips: ['An inside candle after an outside one.\nBroke up.', ''] };
  const m: DrawnMark = { box: { x: 10, y: 10, w: 20, h: 10, i: 0 }, id: 's', name: 'Bars', plot, color: '#0a0' };
  assert.equal(markAt([m], 31, 15, 3), m);
  assert.equal(markAt([m], 40, 15, 3), null);
  assert.deepEqual(markLines(m), [
    { text: 'Breakout ↑', bold: true, color: 'above' }, { text: 'An inside candle after an outside one.', wrap: true }, { text: 'Broke up.', wrap: true }, { text: 'Bars', color: 'muted', rule: true },
  ]);
  assert.equal(markText(plot, 0), 'Breakout ↑');
  assert.equal(markText(plot, 1), '', 'no mark there');
  assert.deepEqual(markBox(50, 40, 20, 10, 'below', 3), { x: 40, y: 43, w: 20, h: 10 });
  assert.equal(markShape('nonsense'), 'label'); assert.equal(markPosition('below'), 'below'); assert.equal(markPosition(5), 'at');
  assert.equal(textOn('#ffffff'), '#111'); assert.equal(textOn('#202020'), '#fff');
});

test('scripts written before version 2 that use oichg, alert or theme as their own names keep them', () => {
  assert.deepEqual([...run('theme = 1\nline(theme)').plots[0]!.fields.value!], [1, 1, 1, 1, 1, 1], 'its own theme, kept from candle to candle');
  assert.deepEqual(analyze('theme = 1\nline(theme.anything ? 1 : 0)').warnings.filter(w => w.code === 'unsupported-member'), [], 'its own theme is not the page\'s');
  assert.deepEqual(analyze('line(theme.anything ? 1 : 0)').warnings.filter(w => w.code === 'unsupported-member').length, 1, 'the page\'s theme still warns of a member it does not have');
  assert.deepEqual([...run('oichg = 1\nline(oichg)').plots[0]!.fields.value!], [1, 1, 1, 1, 1, 1]);
  assert.ok(!analyze('oichg = 1\nline(oichg)').inputs.has('oichg'), 'its own name asks for no open interest');
  assert.deepEqual([...run('alert = option(default=true, type=checkbox)\nline(alert ? 1 : 0)').plots[0]!.fields.value!], [1, 1, 1, 1, 1, 1]);
  assert.equal(run('function alert(x) { return x }\nline(alert(2))').alerts, undefined, 'its own alert function makes no alert');
});

test('an alert that comes past its candle\'s close and the window is history even if its run saw the candle under way', () => {
  const news = new AlertNews(), late = { site: 1, t: 0, text: 'x', sound: 'chime' as const, when: 'bar' as const, forming: true };
  news.take(res2([]), 'c', MIN, 0, 0);
  assert.deepEqual(news.take(res2([late]), 'c', MIN, 0, MIN + ALERT_FRESH_MS + 1), []);
});

test('a mark drawn wholly outside its row is not found, and a stepped line joins candles of two colours with its step', () => {
  const rec = recorder(), boxes: MarkBox[] = [];
  const f = { ...frame(rec.ctx, 1, 40, b => boxes.push(b)), top: 100, height: 100 };
  paintPlot(f, { kind: 'mark', title: '', style: { position: 'above', offset: 30 }, fields: { value: Float64Array.from([100]) }, colors: null, texts: ['top'], tips: null }, scale);
  assert.deepEqual(boxes, [], 'drawn above the row, under the clip: nothing to point at');
  const steps = recorder();
  paintPlot(frame(steps.ctx, 2, 10), { kind: 'line', title: '', style: { lineType: 1 }, fields: { value: Float64Array.from([50, 20]) }, colors: ['red', 'green'] }, scale);
  assert.deepEqual(steps.segments, [[0, 50, 10, 50], [10, 50, 10, 80], [10, 80, 20, 80]]);
});

test('a plate the row\'s edge would cut goes to the other side of its value, or is kept inside the row; one wholly outside stays out', () => {
  const row = { width: 200, top: 0, height: 80 };
  // Below a value near the row's foot (y 70, a plate 14 tall 3 below it would end at 87): turned above it.
  assert.deepEqual(markPlace(100, 70, 60, 14, 'below', 3, row), { x: 70, y: 53, w: 60, h: 14 });
  // Above a value near the top: turned below it.
  assert.deepEqual(markPlace(100, 8, 60, 14, 'above', 3, row), { x: 70, y: 11, w: 60, h: 14 });
  // At the newest candle by the right edge (a phone): moved left into the row, its side kept.
  assert.deepEqual(markPlace(190, 40, 60, 14, 'above', 3, row), { x: 140, y: 23, w: 60, h: 14 });
  assert.deepEqual(markPlace(5, 40, 60, 14, 'below', 3, row), { x: 0, y: 43, w: 60, h: 14 });
  // A row too short for either side: inside it, over the value.
  assert.deepEqual(markPlace(100, 10, 60, 14, 'below', 3, { width: 200, top: 0, height: 20 }), { x: 70, y: 6, w: 60, h: 14 });
  // Where it fits it is where markBox puts it.
  assert.deepEqual(markPlace(100, 40, 60, 14, 'below', 3, row), markBox(100, 40, 60, 14, 'below', 3));
  // Wholly outside the row (a value off its scale, or an offset that lifts it out): left there.
  assert.deepEqual(markPlace(100, 140, 60, 14, 'below', 3, row), markBox(100, 140, 60, 14, 'below', 3));
});

test('a plate moved inside the row at its right edge is judged where it stands: it does not cover the one before it (Sol)', () => {
  // Two plates 68 px wide in a row 200 px wide: the first at [66, 134]; the second, centred at 180, would be [146, 214] and moves to
  // [132, 200], over the first. It is a dot instead.
  const rec = recorder(), boxes: MarkBox[] = [];
  const f = { ...frame(rec.ctx, 5, 40, b => boxes.push(b)), w: 200 };
  paintPlot(f, { kind: 'mark', title: '', style: { shape: 'label', position: 'above' }, fields: { value: Float64Array.from([NaN, NaN, 50, NaN, 50]) }, colors: null, texts: ['', '', 'abcdefghij', '', 'abcdefghij'], tips: null }, scale);
  assert.equal(rec.texts.length, 1, 'one plate written, the other a dot');
  assert.ok(boxes.length === 2 && boxes[1]!.x >= boxes[0]!.x + boxes[0]!.w, `no overlap: ${JSON.stringify(boxes)}`);
});
