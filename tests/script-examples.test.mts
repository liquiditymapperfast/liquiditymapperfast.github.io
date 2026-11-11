import test from 'node:test';
import assert from 'node:assert/strict';
import { analyze, createRunner, runScript } from '../src/app/script/lang/engine.ts';
import { STEPS_PER_CANDLE } from '../src/app/script/lang/analysis.ts';
import { examples, exampleHeight } from '../src/app/script/examples.ts';
import { CVD_SOURCE, HEATMAP_SOURCE } from '../src/app/script/starter.ts';
import { filterKey, type BarInputs, type ScriptTheme, type SourceInputs } from '../src/app/script/inputs.ts';
import { AlertNews } from '../src/app/script/alert-news.ts';
import { interpolateColors, safeColor } from '../src/app/script/lang/colors.ts';
import { MARK_TIP, type ScriptResult } from '../src/app/script/protocol.ts';
import { DepthCache } from '../src/app/script/depth.ts';

const N = 300, HOUR = 3_600_000;
/** Candles of a wandering price with flow and liquidations on every market set the examples read. */
function inputs(): BarInputs {
  let seed = 7;
  const rnd = (): number => (seed = (seed * 16807) % 2147483647) / 2147483647;
  const close: number[] = []; let p = 80_000;
  for (let i = 0; i < N; i++) { p *= 1 + (rnd() - 0.5) * 0.01; close.push(p); }
  const flow = (): SourceInputs => ({
    vbuy: Float64Array.from({ length: N }, () => rnd() * 2e8), vsell: Float64Array.from({ length: N }, () => rnd() * 2e8),
    lbuy: Float64Array.from({ length: N }, () => rnd() < 0.3 ? rnd() * 5e6 : 0), lsell: Float64Array.from({ length: N }, () => rnd() < 0.3 ? rnd() * 5e6 : 0), markets: 3,
  });
  // An order book a candle: $25M a $20 bin for 2 % either side of the close, bids below it and asks above.
  const depth = new DepthCache(), counts: number[] = [], bins: number[] = [], bid: number[] = [], ask: number[] = [];
  for (const c of close) {
    const lo = Math.floor(c * 0.98 / 20), hi = Math.ceil(c * 1.02 / 20);
    counts.push(hi - lo);
    for (let b = lo; b < hi; b++) { bins.push(b); bid.push((b + 1) * 20 <= c ? 25e6 : 0); ask.push(b * 20 >= c ? 25e6 : 0); }
  }
  const time = Float64Array.from({ length: N }, (_, i) => i * HOUR);
  depth.apply({ t: 'depth', key: '1h', revision: 1, prev: -1, reset: true, drop: [], books: [{ id: 'a:BTC', info: { id: 'a:BTC', venue: 'binance', kind: 'perp', quote: 'USDT' }, step: 20, close: true, from: -Infinity, to: Infinity, times: [...time], counts, bins: Int32Array.from(bins), bid: Float32Array.from(bid), ask: Float32Array.from(ask) }] });
  depth.holds({ key: '1h', revision: 1 });
  return {
    depth: depth.reader, depthEpochs: depth.epochs(time),
    tf: HOUR, time,
    // Wicks of their own length a candle, so candles can sit inside or reach past the one before, as real ones do.
    open: Float64Array.from(close, (c, i) => i ? close[i - 1]! : c), high: Float64Array.from(close, (c, i) => Math.max(c, i ? close[i - 1]! : c) * (1 + rnd() * 0.006)), low: Float64Array.from(close, (c, i) => Math.min(c, i ? close[i - 1]! : c) * (1 - rnd() * 0.006)),
    close: Float64Array.from(close), volume: Float64Array.from(close, () => 1),
    sources: { '': flow(), [filterKey({ kinds: ['perp'] })]: flow(), [filterKey({ kinds: ['spot'] })]: flow() },
    forming: true,
  };
}

test('every example reads, declares the options it reads, runs without a warning and draws, within its steps', () => {
  for (const ex of examples()) {
    const a = analyze(ex.source);
    assert.deepEqual([...a.read], [], `${ex.name}: every option it reads is declared`);
    const r = runScript('x', ex.source, {}, inputs());
    assert.ok(r.ok, `${ex.name}: ${r.ok ? '' : JSON.stringify(r.error)}`);
    assert.deepEqual(r.warnings, [], ex.name);
    assert.ok(r.plots.some(p => Object.values(p.fields).some(f => f.some(Number.isFinite))), `${ex.name} draws`);
    assert.ok(r.steps / N < STEPS_PER_CANDLE / 4, `${ex.name}: ${Math.round(r.steps / N)} steps a candle, well under the ${STEPS_PER_CANDLE} each may take`);
  }
});

test('spot and perpetual CVD: a label at each line\'s newest value only, forming or closed, the perpetual\'s on its own scale', () => {
  const at = N - 1, labels = (r: ScriptResult) => {
    assert.ok(r.ok, JSON.stringify(r.ok ? '' : r.error));
    const spot = r.plots.find(p => p.title === 'Spot label')!, perp = r.plots.find(p => p.title === 'Perp label')!;
    return { spot, perp, shown: (p: typeof spot) => [...p.fields.value!].flatMap((v, i) => Number.isFinite(v) ? [i] : []) };
  };
  const data = inputs(), live = labels(runScript('cvd', CVD_SOURCE, {}, data));
  assert.deepEqual(live.shown(live.spot), [at], 'the spot label on the newest candle alone');
  assert.deepEqual(live.shown(live.perp), [at]);
  assert.match(live.spot.texts![at]!, /^Spot [+-]\$[\d.]+[KMBT]? [▲▼▶] (rising|falling|flat)$/, live.spot.texts![at]);
  assert.match(live.perp.texts![at]!, /^Perp [+-]\$/);
  assert.match(live.spot.tips![at]!, /over the last 20 candles/);
  assert.equal(live.perp.style.priceScaleId, 'perp', 'the perpetual\'s label on the perpetual\'s scale, beside its line');
  // The newest candle closed (a replay at a candle's end, a market quiet since): the labels stay on it.
  const closed = labels(runScript('cvd', CVD_SOURCE, {}, { ...inputs(), forming: false }));
  assert.deepEqual(closed.shown(closed.spot), [at], 'renderer.last, not renderer.forming');
  // The label's figures: the move over the lookback is the sum of the last deltas, and Labels off draws none.
  const spot = data.sources[filterKey({ kinds: ['spot'] })]!;
  let move = 0; for (let i = at - 19; i <= at; i++) move += spot.vbuy[i]! - spot.vsell[i]!;
  const sign = move < 0 ? '-' : '+', a = Math.abs(move), shown = a >= 1e9 ? `${(a / 1e9).toFixed(2)}B` : a >= 1e6 ? `${(a / 1e6).toFixed(1)}M` : `${(a / 1e3).toFixed(0)}K`;
  assert.ok(live.spot.texts![at]!.startsWith(`Spot ${sign}$${shown} `), `${live.spot.texts![at]} for a move of ${move}`);
  const off = labels(runScript('cvd', CVD_SOURCE, { showLabels: false }, data));
  assert.deepEqual(off.shown(off.spot), []);
  // A new candle: the label moves to it, the one before is a plain candle again (the run takes the last closed candle over).
  const runner = createRunner('cvd', CVD_SOURCE, {}), first = runner.run(data);
  const grown = inputs(), more = (a: Float64Array, v: number): Float64Array => Float64Array.from([...a, v]);
  const next: BarInputs = { ...grown, time: more(grown.time, N * HOUR), open: more(grown.open, grown.close[at]!), high: more(grown.high, grown.close[at]! * 1.001), low: more(grown.low, grown.close[at]! * 0.999), close: more(grown.close, grown.close[at]!), volume: more(grown.volume, 1),
    sources: Object.fromEntries(Object.entries(grown.sources).map(([k, v]) => [k, { ...v, vbuy: more(v.vbuy, 1e6), vsell: more(v.vsell, 2e6), lbuy: more(v.lbuy, 0), lsell: more(v.lsell, 0) }])) };
  const moved = labels(runner.run(next));
  assert.ok(first.ok);
  assert.deepEqual(moved.shown(moved.spot), [N], 'on the new newest candle, and no longer on the one before');
  // A replay stepped back a candle: the same candles but the newest, which is the newest no longer; the labels go to the one before (Sol).
  const back = (k: number): BarInputs => { const d = inputs(); const cut = (a: Float64Array): Float64Array => a.slice(0, k); return { ...d, time: cut(d.time), open: cut(d.open), high: cut(d.high), low: cut(d.low), close: cut(d.close), volume: cut(d.volume),
    sources: Object.fromEntries(Object.entries(d.sources).map(([key, v]) => [key, { ...v, vbuy: cut(v.vbuy), vsell: cut(v.vsell), lbuy: cut(v.lbuy), lsell: cut(v.lsell) }])) }; };
  const stepper = createRunner('cvd', CVD_SOURCE, {});
  assert.ok(stepper.run(back(N)).ok);
  const stepped = labels(stepper.run(back(N - 1)));
  assert.deepEqual(stepped.shown(stepped.spot), [N - 2], 'the newest candle after the step back has the label');
  assert.deepEqual(stepped.shown(stepped.perp), [N - 2]);
});

test('the heat map: sixteen rows of colour on 0..100, its average over them, its widest windows within budget, and kept between runs', () => {
  const r = runScript('heat', HEATMAP_SOURCE, {}, inputs());
  assert.ok(r.ok);
  const rows = r.plots.filter(p => p.kind === 'brokenarea');
  assert.equal(rows.length, 16);
  assert.ok(rows.every(p => p.colors !== null && p.colors.some(c => !!c)), 'each row coloured candle by candle');
  const average = r.plots.find(p => p.title === 'Average')!;
  const last = average.fields.value![N - 1]!;
  assert.ok(last >= 0 && last <= 100, `average ${last}`);
  assert.equal(exampleHeight(HEATMAP_SOURCE), 160, 'its row has room for sixteen bands');
  const wide = runScript('heat', HEATMAP_SOURCE, { scale: 4 }, inputs());
  assert.ok(wide.ok && wide.steps / N < STEPS_PER_CANDLE / 4, 'windows four times as long stay within the budget');
  // Between two runs over the same closed candles only the candle under way runs again (its kept names are plain values).
  const runner = createRunner('heat', HEATMAP_SOURCE, {});
  const first = runner.run(inputs());
  const next = inputs(); next.close[N - 1] = next.close[N - 1]! * 1.001;
  const again = runner.run(next);
  assert.ok(first.ok && again.ok);
  assert.ok(again.steps < first.steps / 50, `the next run took ${again.steps} steps after ${first.steps}`);
  const colored = runScript('heat', HEATMAP_SOURCE, { colorCandles: true }, inputs());
  assert.ok(colored.ok && colored.candleColors?.some(c => !!c), 'candle colours when switched on');
  assert.ok(!r.candleColors?.some(c => !!c), 'and none by default');
});

test('depth bands: the price a size of the book reaches either side of the close, from a fixed size or a share of the volume', () => {
  const source = examples().find(e => e.key === 'depth-bands')!.source, data = inputs();
  const band = (options: Record<string, number | boolean>) => {
    const r = runScript('d', source, options, data);
    assert.ok(r.ok);
    const plot = r.plots.find(p => p.kind === 'cloudarea')!;
    return { lower: plot.fields.lowerValue!, higher: plot.fields.higherValue! };
  };
  const at = N - 1, close = data.close[at]!;
  // $250M is ten bins of $25M, from the edge of the first bin wholly past the close: $200 to $220 above it, and as far below.
  const fixed = band({}), up = fixed.higher[at]! - close, down = close - fixed.lower[at]!;
  assert.ok(up > 200 && up <= 220, `${fixed.higher[at]} over ${close}`);
  assert.ok(down > 200 && down <= 220, `${fixed.lower[at]} under ${close}`);
  // More than the book holds (2 % of the price, some $2B a side): no band.
  assert.ok(Number.isNaN(band({ size: 1e10 }).higher[at]!));
  // A share of the average candle's traded dollars (about $200M here): twice it reaches further than $250M.
  const byVolume = band({ byVolume: true, share: 2 });
  assert.ok(byVolume.higher[at]! - close > fixed.higher[at]! - close);
  // The asks above the close and the bids below it while the books are their closes; every dollar at each price where they are averages.
  const read = analyze(source);
  assert.ok(['askdepth', 'biddepth', 'depthabove', 'depthbelow', 'depthatclose'].every(name => source.includes(`${name}(`)), [...read.read].join());
});

test('depthatclose(): true where every book read is its book at the close, false where any is an average, na where none is held', () => {
  const T = 3_600_000, time = Float64Array.from([0, T, 2 * T]), depth = new DepthCache();
  const one = (id: string, close: boolean, times: number[]) => ({ id, info: { id, venue: id.startsWith('a:') ? 'binance' : 'bybit', kind: id.startsWith('a:') ? 'perp' as const : 'spot' as const, quote: 'USDT' }, step: 20, close, from: -Infinity, to: Infinity,
    times, counts: times.map(() => 1), bins: Int32Array.from(times.map(() => 4_000)), bid: Float32Array.from(times.map(() => 1e6)), ask: Float32Array.from(times.map(() => 1e6)) });
  depth.apply({ t: 'depth', key: '1h', revision: 1, prev: -1, reset: true, drop: [], books: [one('a:BTC', true, [0, T]), one('b:BTC', false, [T])] });
  depth.holds({ key: '1h', revision: 1 });
  const data = { ...inputs(), time, open: Float64Array.from([80_000, 80_000, 80_000]), high: Float64Array.from([80_100, 80_100, 80_100]), low: Float64Array.from([79_900, 79_900, 79_900]), close: Float64Array.from([80_000, 80_000, 80_000]), volume: Float64Array.from([1, 1, 1]), depth: depth.reader, depthEpochs: depth.epochs(time) };
  const r = runScript('c', 'line(depthatclose() ? 1 : 0)\nline(na(depthatclose()) ? 1 : 0, title="none")\nline(source(depthatclose() ? 1 : 0, type=perp))', {}, data as never);
  assert.ok(r.ok, JSON.stringify(r.ok ? '' : r.error));
  assert.deepEqual([...r.plots[0]!.fields.value!], [1, 0, 0], 'one book at its close; one of them an average; none');
  assert.deepEqual([...r.plots[1]!.fields.value!], [0, 0, 1], 'na where no book is held');
  assert.deepEqual([...r.plots[2]!.fields.value!], [1, 1, 0], 'over the books of the set read: the average is a spot market\'s');
});

// ---- Bar patterns, on candles worked out by hand: each rule is read off the numbers, not off what the script answers.

const BARS = examples().find(e => e.name === 'Bar patterns')!.source;
const UP_ARROW = '↑', DOWN_ARROW = '↓';
/** 2026-10-26 00:00 UTC, a Monday: the day and the week begin here (the month does not). */
const MONDAY = Date.UTC(2026, 9, 26);
type Row = [open: number, high: number, low: number, close: number];
/**
 * Candles [open, high, low, close] a pattern at a time. 0 the first; 1 inside 0; 2 above 1's high and closed above it; 3 inside 2; 4 below 3's low and
 * closed below it; 5 above 4's high, closed above it, right after a break below an inside candle; 6 past both ends of 5 but closed at 5's high, not beyond
 * it, with a lower wick of most of its length; 7 past both ends of 6 and closed above its high; 8 inside 7; 9 above 8's high but closed back below it with
 * an upper wick of most of its length; 10 inside 9; 11 below 10's low but closed back above it with a lower wick of most of its length; 12 inside 11;
 * 13 above 12's high but closed back below it with a short wick; 14 below 13's low and closed below it, right after a break above an inside candle;
 * 15 below 14's low and closed back above it with a short wick.
 */
const SERIES: Row[] = [
  [100, 110, 90, 105], [105, 108, 95, 100], [100, 112, 98, 111], [111, 111, 99, 100], [100, 100.5, 96, 97], [97, 103, 96.5, 102.5], [102.5, 104, 90, 103], [103, 120, 80, 119],
  [119, 119.5, 100, 118.5], [118.5, 130, 118, 119], [122, 126, 119, 124], [124, 125, 110, 123], [123, 124.5, 112, 120], [120.5, 125, 113, 123], [123, 123.5, 110, 111], [111, 112, 109.5, 110.8],
];
const WORDS = ['', 'in', `Breakout ${UP_ARROW}`, 'in', `Breakout ${DOWN_ARROW}`, `Failed break ${UP_ARROW}`, `Rejection ${UP_ARROW}`, `Outside ${UP_ARROW}`, 'in', `Rejection ${DOWN_ARROW}`, 'in', `Rejection ${UP_ARROW}`, 'in', '', `Failed break ${DOWN_ARROW}`, ''];

interface BarOptions { start?: number; hours?: readonly number[]; tf?: number; forming?: boolean; theme?: ScriptTheme; big?: boolean }
/** The candles an hour apart from `start` (or at `hours` from it, to leave some out), the same flow in each and a change in open interest of $5M (`big`: of billions). */
function barInputs(rows: readonly Row[], o: BarOptions = {}): BarInputs {
  const n = rows.length, tf = o.tf ?? HOUR, col = (k: number): Float64Array => Float64Array.from(rows, r => r[k]!), fill = (v: number): Float64Array => new Float64Array(n).fill(v);
  return {
    tf, time: Float64Array.from(rows, (_, i) => (o.start ?? MONDAY) + (o.hours ? o.hours[i]! : i) * tf),
    open: col(0), high: col(1), low: col(2), close: col(3), volume: fill(1),
    sources: { '': o.big ? { vbuy: fill(987e9), vsell: fill(123e9), lbuy: fill(9.99e9), lsell: fill(9.99e9), markets: 1 } : { vbuy: fill(60), vsell: fill(40), lbuy: fill(0), lsell: fill(0), markets: 1 } },
    oichg: fill(o.big ? -99.9e9 : 5e6), forming: o.forming ?? false, ...(o.theme ? { theme: o.theme } : {}),
  };
}
type Run = Extract<ScriptResult, { ok: true }>;
function barRun(rows: readonly Row[], o: BarOptions = {}, options: Record<string, boolean> = {}): Run {
  const r = runScript('bars', BARS, options, barInputs(rows, o));
  assert.ok(r.ok, r.ok ? '' : JSON.stringify(r.error));
  assert.deepEqual(r.warnings, []);
  return r;
}
/** The mark at candle `i`, whichever plot drew it. */
function barMark(r: Run, i: number): { title: string; text: string; tip: string; color: string; value: number } | null {
  for (const p of r.plots) if (p.kind === 'mark' && Number.isFinite(p.fields.value![i]!)) return { title: p.title, text: p.texts?.[i] ?? '', tip: p.tips?.[i] ?? '', color: p.colors?.[i] ?? '', value: p.fields.value![i]! };
  return null;
}
const barWords = (r: Run, n: number): string[] => Array.from({ length: n }, (_, i) => barMark(r, i)?.text ?? '');
const barLine = (r: Run, title: string): (number | null)[] => Array.from(r.plots.find(p => p.title === title)!.fields.value!, v => Number.isNaN(v) ? null : v);
const nulls = (n: number): null[] => Array.from({ length: n }, () => null);
/** The sentences of a hover about the opens: those after the line on open interest. */
const opensOf = (r: Run, i: number): string[] => { const lines = barMark(r, i)!.tip.split('\n'); return lines.slice(lines.findIndex(l => l.startsWith('Open interest')) + 1); };

test('Bar patterns: each candle\'s word, each pattern and its levels, on candles worked out by hand', () => {
  const a = analyze(BARS);
  assert.deepEqual([...a.read], [], 'every option it reads is declared');
  assert.ok(a.inputs.has('oichg'), 'the page is asked for the change in open interest its hovers give');
  const r = barRun(SERIES);
  assert.deepEqual(barWords(r, SERIES.length), WORDS);
  // A pattern up stands under its candle's low and one down over its high; a candle with none has its word under it.
  assert.deepEqual([2, 5, 6, 7, 11].map(i => barMark(r, i)!.title), Array(5).fill('Pattern up'));
  assert.deepEqual([4, 9, 14].map(i => barMark(r, i)!.title), Array(3).fill('Pattern down'));
  assert.deepEqual([1, 3, 8, 10, 12].map(i => barMark(r, i)!.title), Array(5).fill('Candle'));
  assert.deepEqual([barMark(r, 7)!.value, barMark(r, 9)!.value], [80, 130]);
  assert.deepEqual(['Pattern up', 'Pattern down'].map(t => r.plots.find(p => p.title === t)!.style.offset), [2, 2], 'both stand as close to their candle');
  // A breakout's levels: the inside candle's end it went through and the end two candles back; a failed break's: the end of the candle before it went back through and
  // the end two candles back. Nothing for a rejection or an outside candle.
  assert.deepEqual(barLine(r, 'Break level'), [null, null, 108, null, 99, 100.5, ...nulls(8), 113, null]);
  assert.deepEqual(barLine(r, 'Next level'), [null, null, 110, null, 98, 111, ...nulls(8), 112, null]);
  assert.equal(barMark(r, 2)!.tip, [
    'The candle before stayed inside the one before it. This one broke above the inside candle\'s high and closed above it.',
    'Break level 108.0; next level 110.0 (the high two candles back), reached',
    'Buyers led by $20 (bought at market $60, sold $40)', 'No liquidations recorded', 'Open interest rose by $5.0M (positions opened)',
    'Break level above the day and week opens.', 'The month open is not on the chart.',
  ].join('\n'));
  assert.equal(barMark(r, 5)!.tip.split('\n').slice(0, 2).join('\n'), [
    'The candle before broke below an inside candle (a pause). This one went back above the high of the candle before and closed above it: the break failed.',
    'Break level 100.5; next level 111.0 (the high two candles back), not reached: the furthest 103.0',
  ].join('\n'));
  assert.equal(barMark(r, 9)!.tip, [
    'It went above the high (119.5) of the candle before and closed back inside, with an upper wick 92% of the candle: the prices above were refused.',
    'Buyers led by $20 (bought at market $60, sold $40)', 'No liquidations recorded', 'Open interest rose by $5.0M (positions opened)',
    'Close above the day and week opens.', 'The month open is not on the chart.',
  ].join('\n'));
  assert.equal(barMark(r, 7)!.tip.split('\n')[0], 'It went past both ends of the candle before and closed above its high (104.0).');
  // Where this page did not record the flow, it is Binance's own candles (bar.recorded 0): the hover says so.
  const own = barInputs(SERIES);
  own.sources['']!.recorded = new Float64Array(SERIES.length);
  const fromCandle = runScript('bars', BARS, {}, own);
  assert.ok(fromCandle.ok);
  assert.equal(barMark(fromCandle as Run, 2)!.tip.split('\n')[2], 'On Binance alone, buyers led by $20 (bought at market $60, sold $40)');
});

test('Bar patterns: a break counts where the candle closes, so a poke past the inside candle that closed back is a word and a long wick is a rejection either way round', () => {
  const r = barRun(SERIES, {}, { showAll: true });
  // 13 went above the inside candle's high and closed back below it with a short wick: only its word says so. 15 is the same below the low.
  assert.deepEqual(barWords(r, SERIES.length), WORDS.map((w, i) => i === 13 ? 'up' : i === 15 ? 'down' : w));
  assert.equal(barMark(r, 13)!.tip, 'Up: it went above the high of the candle before (124.5) and held its low, and did not close above it.');
  assert.equal(barMark(r, 15)!.tip, 'Down: it went below the low of the candle before (110.0) and held its high, and did not close below it.');
  // 9 went above an inside candle and 11 below one, and each closed back inside with a long wick: rejections, not breakouts, the one up as the other down.
  assert.deepEqual([9, 11].map(i => barMark(r, i)!.text), [`Rejection ${DOWN_ARROW}`, `Rejection ${UP_ARROW}`]);
  // An outside candle that closed beyond an end is the pattern, so the word is left to those that closed between the ends; with patterns off it says which.
  const words = barRun(SERIES, {}, { showPatterns: false });
  assert.deepEqual([6, 7].map(i => barMark(words, i)!.text), ['out', 'out']);
  assert.equal(barMark(words, 6)!.tip, 'Outside: it went past both the high (103.0) and the low (96.50) of the candle before, and closed between them.');
  assert.equal(barMark(words, 7)!.tip, 'Outside: it went past both the high (104.0) and the low (90.00) of the candle before, and closed above that high.');
  // A wick of exactly twice the rest of the candle counts, a little less does not.
  const wick = (high: number) => barWords(barRun([[100, 110, 90, 105], [91, high, 89, 91]]), 2)[1];
  assert.equal(wick(92), `Rejection ${UP_ARROW}`);
  assert.equal(wick(92.1), '');
});

test('Bar patterns: an end only touched is not gone past, and a candle with no prices or none just before it in time has nothing to be compared with', () => {
  assert.deepEqual(barWords(barRun([[100, 110, 90, 105], [105, 110, 95, 100], [100, 108, 95, 100], [100, 108, 95, 99]]), 4), ['', 'in', 'in', 'in'], 'the same high, the same low, both: inside');
  const rows: Row[] = [[100, 110, 90, 105], [105, 108, 95, 100], [100, 112, 98, 111], [108, 110, 100, 105]];
  assert.deepEqual(barWords(barRun(rows), 4), ['', 'in', `Breakout ${UP_ARROW}`, 'in']);
  assert.deepEqual(barWords(barRun(rows, { hours: [0, 1, 2, 4] }), 4), ['', 'in', `Breakout ${UP_ARROW}`, ''], 'a candle missing before the last');
  assert.deepEqual(barWords(barRun(rows.slice(0, 3), { hours: [0, 2, 3] }), 3), ['', '', ''], 'a candle missing before the inside one: it is not known to be inside, so what follows is no breakout');
  // An inside candle with the high of the one before leaves its breakout above with no next level: it would be the break level itself.
  const same = barRun([[100, 110, 90, 105], [105, 110, 95, 100], [100, 112, 98, 111]]);
  assert.equal(barMark(same, 2)!.tip.split('\n')[1], 'Break level 110.0');
  assert.deepEqual([barLine(same, 'Break level')[2], barLine(same, 'Next level')[2]], [110, null]);
  assert.deepEqual(barWords(barRun([rows[0]!, rows[1]!, [NaN, NaN, NaN, NaN], [105, 108, 96, 100]]), 4), ['', 'in', '', ''], 'no prices: no mark, and nothing for the next candle to be compared with');
});

test('Bar patterns: the failed break after a plain candle shows only when asked for', () => {
  // 1 above 0's high, 2 below 1's low, 3 above 2's high and closed above it: the candle before it broke below a candle that had itself gone up.
  const rows: Row[] = [[100, 110, 90, 105], [105, 112, 98, 110], [110, 111, 94, 96], [96, 113, 95, 112]];
  assert.deepEqual(barWords(barRun(rows), 4), ['', '', '', '']);
  const all = barRun(rows, {}, { showEveryFail: true });
  assert.deepEqual(barWords(all, 4), ['', '', `Failed break ${DOWN_ARROW}`, `Failed break ${UP_ARROW}`]);
  assert.ok(barMark(all, 3)!.tip.startsWith('The candle before broke below the one before it. This one went back above the high of the candle before'));
});

test('Bar patterns: the candle under way is marked as it stands, and waits at the inside candle\'s ends while it has not gone past them', () => {
  const inside: Row[] = [[100, 110, 90, 105], [105, 108, 95, 100]];
  const state = (last: Row, forming = true): Run => barRun([...inside, last], { forming });
  // Still within the inside candle: both of its ends as lines across the candle, and a "waiting" over the upper one that says what would make a breakout.
  const waiting = state([100, 106, 97, 103]), m = barMark(waiting, 2)!;
  assert.deepEqual([barLine(waiting, 'Breakout up at')[2], barLine(waiting, 'Breakout down at')[2]], [108, 95]);
  assert.deepEqual([m.text, m.value], ['waiting', 108]);
  assert.ok(m.tip.startsWith('The candle before stayed inside the one before it, and this one is still within it. A breakout needs a close above 108.0 or below 95.00, without going past the other end.\nBuyers led by'));
  // Closed, it is an inside candle and nothing waits.
  const closed = state([100, 106, 97, 103], false);
  assert.equal(barMark(closed, 2)!.text, 'in');
  assert.deepEqual([barLine(closed, 'Breakout up at')[2], barLine(closed, 'Breakout down at')[2]], [null, null]);
  // Above the inside candle's high and closed above it so far: a breakout, said to be able to change, whose next level was reached so far; nothing waits.
  const broke = state([100, 110, 99, 109.5]);
  assert.equal(barMark(broke, 2)!.text, `Breakout ${UP_ARROW}`);
  assert.equal(barMark(broke, 2)!.tip.split('\n').slice(1, 3).join('\n'), 'Still under way: this can change.\nBreak level 108.0; next level 110.0 (the high two candles back), reached so far');
  assert.equal(barLine(broke, 'Breakout up at')[2], null);
  // Went above it and is back below at the moment: no breakout, and nothing is waiting for one.
  assert.equal(barMark(state([100, 109, 99, 107]), 2), null);
});

test('Bar patterns: an alert waits for the close and says what closed; only a breakout or a failed break has one, and only when asked for', () => {
  const alerts = (n: number, on = true): unknown[][] => (barRun(SERIES.slice(0, n), {}, on ? { sound: true } : {}).alerts ?? []).map(a => [a.text, a.sound, a.when, a.forming]);
  assert.deepEqual(alerts(3), [[`Breakout ${UP_ARROW} closed above 108.0`, 'rise', 'close', false]]);
  assert.deepEqual(alerts(5), [[`Breakout ${DOWN_ARROW} closed below 99.00`, 'fall', 'close', false]]);
  assert.deepEqual(alerts(6), [[`Failed break ${UP_ARROW} closed above 100.5`, 'rise', 'close', false]]);
  assert.deepEqual([alerts(7), alerts(8), alerts(9)], [[], [], []], 'a rejection, an outside candle and a word have no level to alert at');
  assert.deepEqual(alerts(3, false), []);
  // As the page keeps them: nothing sounds while the candle is under way, and it sounds once when it has closed.
  const news = new AlertNews(), runner = createRunner('bars', BARS, { sound: true }), at = (i: number): number => MONDAY + i * HOUR;
  const sounded = (n: number, forming: boolean, now: number): number => {
    const inp = barInputs(SERIES.slice(0, n), { forming }), r = runner.run(inp);
    assert.ok(r.ok);
    return news.take(r, 'chart', HOUR, inp.time[forming ? n - 2 : n - 1]!, now).length;
  };
  assert.equal(sounded(2, true, at(1) + 60_000), 0, 'the first answer for a chart only takes note');
  assert.equal(sounded(3, true, at(2) + 60_000), 0, 'the breakout is there, but its candle is under way');
  assert.equal(sounded(4, true, at(3) + 2_000), 1, 'its candle closed and another began');
  assert.ok(runner.startedAt > 0, 'a run of the candles from the one that closed on, as the page runs it');
  assert.equal(sounded(4, true, at(3) + 3_000), 0, 'and once');
});

test('Bar patterns: where a break stands against the opens of the day, week (from Monday) and month, and of the hour on charts shorter than one, from the chart\'s own candles', () => {
  const three = SERIES.slice(0, 3);
  assert.deepEqual(opensOf(barRun(three), 2), ['Break level above the day and week opens.', 'The month open is not on the chart.'], 'the chart starts on a Monday midnight; at one hour a candle the hour open is its own');
  assert.deepEqual(opensOf(barRun(three, { tf: 900_000 }), 2), ['Break level above the hour, day and week opens.', 'The month open is not on the chart.'], 'the first hour\'s candle at 15 minutes');
  // Starting at 01:00 the candles of the day, the week and the month are missing their first: no open is known.
  assert.deepEqual(opensOf(barRun(three, { start: MONDAY + HOUR }), 2), ['The day, week and month opens are not on the chart.']);
  // From the Sunday before, the week begins at Monday's first candle (which is the day's too), not at the first candle on the chart.
  const sunday: Row[] = [[99, 100, 98, 100], ...three];
  assert.deepEqual(opensOf(barRun(sunday, { start: MONDAY - HOUR }), 3), ['Break level above the day and week opens.', 'The month open is not on the chart.']);
  // From the first of a month (a Sunday) the month's open is known and the week's, which began the Monday before, is not.
  assert.deepEqual(opensOf(barRun(three, { start: Date.UTC(2026, 10, 1) }), 2), ['Break level above the day and month opens.', 'The week open is not on the chart.']);
  // A level exactly at an open is at it, not above or below it.
  const level: Row[] = [[100, 110, 90, 105], [95, 100, 92, 96], [96, 102, 95, 101]];
  assert.deepEqual(opensOf(barRun(level), 2), ['Break level at the day and week opens.', 'The month open is not on the chart.']);
});

test('Bar patterns: its colours follow the page\'s theme, the up and down of its candles and its text colour dimmed for inside', () => {
  const theme: ScriptTheme = { dark: true, background: '#12151c', text: '#e8ecf4', up: '#56b4e9', down: '#e69f00' };
  const r = barRun(SERIES, { theme });
  assert.deepEqual([2, 5, 4, 9].map(i => barMark(r, i)!.color), ['rgb(86, 180, 233)', 'rgb(86, 180, 233)', 'rgb(230, 159, 0)', 'rgb(230, 159, 0)']);
  assert.equal(barMark(r, 1)!.color, safeColor(interpolateColors(0.7, [theme.background, theme.text]), ''), 'inside: between the background and the text');
  for (const title of ['Break level', 'Next level']) assert.ok(r.plots.find(p => p.title === title)!.colors!.filter(Boolean).every(c => c === 'rgb(86, 180, 233)' || c === 'rgb(230, 159, 0)'), title);
  // Another theme is other colours, and with none given the page's default dark theme's.
  assert.equal(barMark(barRun(SERIES, { theme: { ...theme, up: '#00ff00' } }), 2)!.color, 'rgb(0, 255, 0)');
  assert.equal(barMark(barRun(SERIES), 2)!.color, 'rgb(0, 217, 184)');
});

test('Bar patterns: at most one pattern a candle, and every hover has room to spare in what a mark may say, whatever the prices and the flow', () => {
  let seed = 11;
  const rnd = (): number => (seed = (seed * 16807) % 2147483647) / 2147483647;
  const names = new Set<string>();
  let longest = 0;
  for (const scale of [80_000, 150, 0.0123]) {
    // A wandering price whose candles reach past the one before as real ones do: wicks of their own length, openings near the last close.
    const rows: Row[] = []; let p = scale;
    for (let i = 0; i < 600; i++) { const o = p, c = p * (1 + (rnd() - 0.5) * 0.02); rows.push([o, Math.max(o, c) * (1 + rnd() * 0.01), Math.min(o, c) * (1 - rnd() * 0.01), c]); p = c; }
    const r = barRun(rows, { big: true }, { showEveryFail: true });
    const up = r.plots.find(q => q.title === 'Pattern up')!, down = r.plots.find(q => q.title === 'Pattern down')!;
    for (let i = 0; i < rows.length; i++) {
      assert.ok(!(Number.isFinite(up.fields.value![i]!) && Number.isFinite(down.fields.value![i]!)), `candle ${i} at ${scale}: a pattern up and a pattern down`);
      for (const q of [up, down]) if (Number.isFinite(q.fields.value![i]!)) { names.add(q.texts![i]!); longest = Math.max(longest, q.tips![i]!.length); }
    }
  }
  assert.equal(names.size, 8, `every pattern both ways was met: ${[...names].join(', ')}`);
  // The longest hover there is, a failed break under way with an inside candle before it, reaching its next level, billions in every line and three opens, even so.
  const forming = barRun(SERIES.slice(0, 6), { big: true, forming: true });
  assert.ok(longest < 540 && barMark(forming, 5)!.tip.length < 560 && barMark(forming, 5)!.tip.length < MARK_TIP, `${longest} and ${barMark(forming, 5)!.tip.length} characters of ${MARK_TIP}`);
});

test('Bar patterns: every option on at once runs clean, colours the inside and outside candles and stays within its steps', () => {
  const on = { showRange: true, showAll: true, showPatterns: true, showEveryFail: true, showLevels: true, showWaiting: true, paint: true, sound: true };
  const r = runScript('bars', BARS, on, barInputs(SERIES, { forming: true }));
  assert.ok(r.ok && r.warnings.length === 0, r.ok ? '' : JSON.stringify(r.error));
  assert.deepEqual(r.candleColors!.flatMap((c, i) => c ? [i] : []), [1, 3, 6, 7, 8, 10, 12], 'the inside candles and the outside ones');
  assert.ok(r.steps / SERIES.length < STEPS_PER_CANDLE / 4);
  // Every option off: nothing marked, nothing drawn.
  const off = runScript('bars', BARS, { showRange: false, showAll: false, showPatterns: false, showLevels: false, showWaiting: false }, barInputs(SERIES, { forming: true }));
  assert.ok(off.ok && off.plots.every(p => p.fields.value!.every(v => Number.isNaN(v))));
});
