import test from 'node:test';
import assert from 'node:assert/strict';
import { ScriptRangeSummary, scriptHeldKey, scriptPaneHeld, scriptStretch, valueFormat, type ScriptPaneHeld, type ScriptRowInput } from '../src/app/range/script-lines.ts';
import type { PlotKind, PlotOut } from '../src/app/script/protocol.ts';
import type { RangeSelection } from '../src/app/range/selection.ts';

const H = 3_600_000, T = Date.UTC(2026, 10, 12, 0), NOW = T + 48 * H + 30 * 60_000;
const KEY = scriptHeldKey({ seriesInstrument: 'binance:BTCUSDT', timeframe: '1h' }, 7);
/** Candle starts every hour from `from` for `n` candles. */
const hours = (from: number, n: number): Float64Array => Float64Array.from({ length: n }, (_, i) => T + (from + i) * H);
const plot = (kind: PlotKind, title: string, values: number[], style: PlotOut['style'] = {}): PlotOut => ({
  kind, title, style, colors: null,
  fields: kind === 'candlestick' || kind === 'bar' ? { open: Float64Array.from(values), high: Float64Array.from(values), low: Float64Array.from(values), close: Float64Array.from(values) }
    : kind === 'cloudarea' || kind === 'brokenarea' ? { lowerValue: Float64Array.from(values), higherValue: Float64Array.from(values) }
    : { value: Float64Array.from(values) },
});
function input(o: Partial<ScriptRowInput> & { plots?: PlotOut[]; time?: Float64Array; closed?: number; at?: number } = {}): ScriptRowInput {
  const time = o.time ?? hours(0, 48);
  return {
    id: o.id ?? 'rsi', name: o.name ?? 'RSI', hidden: o.hidden ?? false, warnings: o.warnings ?? 0,
    held: o.held !== undefined ? o.held : { ok: true, time, tf: H, closed: o.closed ?? time.length, at: o.at ?? Infinity, plots: o.plots ?? [plot('line', 'RSI', Array.from(time, (_, i) => 50 + i))] },
  };
}
const snap = (rows: ScriptRowInput[], gen = 1, prev: ScriptPaneHeld | null = null): ScriptPaneHeld => scriptPaneHeld(prev, gen, KEY, '1h', H, rows);
const sel = (h0: number, h1: number): RangeSelection => ({ t0: T + h0 * H, t1: T + h1 * H, p0: null, p1: null, live: false, draft: false, pane: 'script', step: H });
const text = (lines: ReturnType<ScriptRangeSummary['lines']>, key: string): string | undefined => lines.find(l => l.key === key)?.cells.join(' | ');
const tile = (lines: ReturnType<ScriptRangeSummary['lines']>, key: string) => lines.flatMap(l => l.grid ?? []).find(g => g.key === key);
const row = (item: ReturnType<typeof tile>, label: string): string | undefined => item?.rows?.find(r => r.label === label)?.value;
const drawn = (h: ScriptPaneHeld, i = 0) => { const r = h.rows[i]!; assert.equal(r.state, 'drawn'); return r as Extract<typeof r, { state: 'drawn' }>; };

test('uncovered time is stated, never counted: candles before the run, missing candles and NaN values stay out of every figure', () => {
  // The run holds candles from hour 10 on, with hour 14 missing; the plot is NaN at hour 12 and infinite at hour 13.
  const time = Float64Array.from([...hours(10, 4), ...hours(15, 33)]);
  const values = Array.from(time, (t) => (t - T) / H);
  values[2] = NaN; values[3] = Infinity;
  const h = snap([input({ time, plots: [plot('line', 'Hour', values)] })]);
  const s = scriptStretch(drawn(h), sel(6, 18), NOW);
  // Twelve closed hours start in [6, 18); the run holds 7 of them (10-13 and 15-17); 4 before it began, 1 missing.
  assert.deepEqual([s.slots, s.held, s.before, s.gaps, s.after], [12, 7, 4, 1, 0]);
  const p = s.plots[0]!;
  assert.deepEqual([p.values, p.first?.v, p.last?.v, p.low, p.high], [5, 10, 17, 10, 17], 'NaN and infinity are no value; nothing is read as zero');
  const lines = new ScriptRangeSummary().lines(sel(6, 18), h, true, KEY, NOW, false);
  assert.match(text(lines, 'sc-cover-rsi') ?? '', /7 of the 12 closed candles/);
  assert.match(text(lines, 'sc-cover-rsi') ?? '', /begins at/);
  assert.match(text(lines, 'sc-cover-rsi') ?? '', /1 candle missing/);
  assert.equal(row(tile(lines, 'rsi-0'), 'Candles with a value'), '5 of 7', 'the denominator is the closed candles the run holds, not the selection');
  assert.equal(row(tile(lines, 'rsi-0'), 'Change'), '+7');
});

test('endpoints come from inside the selection only, and the candle under way at the run is never a closed figure', () => {
  // 48 candles; the newest was under way when the run was made (closed = 47).
  const h = snap([input({ closed: 47, plots: [plot('line', 'Rise', Array.from({ length: 48 }, (_, i) => i * 10))] })]);
  const s = scriptStretch(drawn(h), sel(20, 30), NOW);
  assert.deepEqual([s.plots[0]!.first?.v, s.plots[0]!.last?.v, s.held], [200, 290, 10], 'values before 20 and from 30 on are left out');
  // A selection over the newest candles: the clock has closed hour 47 now, but the run read it mid-candle, so it waits for the next run.
  const late = scriptStretch(drawn(h), sel(44, 49), NOW + H);
  assert.deepEqual([late.slots, late.held, late.after, late.plots[0]!.last?.v], [5, 3, 2, 460]);
  // The live candle under way now is said, and not counted as a slot.
  const now = scriptStretch(drawn(h), sel(44, 49), NOW);
  assert.deepEqual([now.slots, now.forming], [4, true]);
  const lines = new ScriptRangeSummary().lines(sel(44, 49), h, true, KEY, NOW, false);
  assert.ok(text(lines, 'sc-forming'), 'the candle under way is said to be left out');
});

test('no snapshot of another context: another key, a rewound replay or a live answer in a replay is not summed up', () => {
  const h = snap([input()]);
  const summary = new ScriptRangeSummary();
  const other = scriptHeldKey({ seriesInstrument: 'binance:BTCUSDT', timeframe: '4h' }, 7);
  assert.ok(text(summary.lines(sel(0, 10), h, false, other, NOW, false), 'sc-stale'), 'a hidden pane says it drew another context');
  assert.equal(text(summary.lines(sel(0, 10), h, true, other, NOW, false), 'sc-wait'), 'Waiting for a run for this chart.', 'a pane in view is about to draw again: it waits, never "show it"');
  assert.ok(text(summary.lines(sel(0, 10), h, false, scriptHeldKey({ seriesInstrument: 'binance:BTCUSDT', timeframe: '1h' }, 8), NOW, false), 'sc-stale'), 'the scripts were edited since');
  // A live answer (at = Infinity) read in a replay, and a replay answer worked out after the replay's moment (a rewind): waiting, as paint shows.
  const WAIT = 'Waiting for a run for this chart.';
  assert.equal(text(summary.lines(sel(0, 10), h, true, KEY, T + 20 * H, true), 'sc-wait-rsi'), WAIT);
  const later = snap([input({ at: T + 30 * H, closed: 30 })], 2);
  assert.equal(text(summary.lines(sel(0, 10), later, true, KEY, T + 20 * H, true), 'sc-wait-rsi'), WAIT);
  // A run's error is the run's too: a live one is not shown in a replay; one met on the page (-Infinity) holds everywhere.
  const errors = snap([input({ held: { ok: false, error: 'stopped: too many steps', at: Infinity } }), input({ id: 'p', name: 'Page', held: { ok: false, error: 'not readable', at: -Infinity } })], 3);
  const inReplay = summary.lines(sel(0, 10), errors, true, KEY, T + 20 * H, true);
  assert.deepEqual([text(inReplay, 'sc-wait-rsi'), text(inReplay, 'sc-error-rsi'), text(inReplay, 'sc-error-p')], [WAIT, undefined, 'not readable']);
  assert.equal(text(summary.lines(sel(0, 10), errors, true, KEY, NOW, false), 'sc-error-rsi'), 'stopped: too many steps');
  // Within one minute of a replay, a row becomes shown at its own moment (the minute memo must not hold the waiting text).
  const atHalf = snap([input({ at: T + 20 * H + 30_000, closed: 20 })], 4), fresh = new ScriptRangeSummary();
  assert.equal(text(fresh.lines(sel(0, 10), atHalf, true, KEY, T + 20 * H + 10_000, true), 'sc-wait-rsi'), WAIT);
  assert.ok(tile(fresh.lines(sel(0, 10), atHalf, true, KEY, T + 20 * H + 40_000, true), 'rsi-0'), 'the same minute, after the row\'s moment: figures');
  // The same replay answer at or after its moment is summed up, over the candles closed by then.
  const atMoment = summary.lines(sel(0, 10), later, true, KEY, T + 31 * H, true);
  assert.equal(row(tile(atMoment, 'rsi-0'), 'Candles with a value'), '10 of 10');
  // A replay answer stays current live (as the pane draws it).
  assert.ok(tile(summary.lines(sel(0, 10), later, true, KEY, NOW, false), 'rsi-0'));
});

test('the snapshot is the same object while nothing changes, and a new one when an answer, its closed candles, warnings or context change', () => {
  const rows = [input(), input({ id: 'ema', name: 'EMA', hidden: true })];
  const a = snap(rows, 3);
  assert.equal(snap(rows, 3, a), a, 'the same inputs keep the same object (paint runs on every pointer move)');
  assert.equal(snap([input(), input({ id: 'ema', name: 'EMA', hidden: true })], 3, a), a, 'new but equal row objects keep it too');
  assert.notEqual(snap(rows, 4, a), a, 'a new answer (the held generation)');
  assert.notEqual(snap([input({ closed: 47 }), rows[1]!], 3, a), a, 'fewer closed candles (a replay stepped back a candle)');
  assert.notEqual(snap([input({ warnings: 1 }), rows[1]!], 3, a), a);
  assert.notEqual(scriptPaneHeld(a, 3, scriptHeldKey({ seriesInstrument: 'binance:ETHUSDT', timeframe: '1h' }, 7), '1h', H, rows), a);
  assert.notEqual(snap([input(), input({ id: 'ema', name: 'EMA' })], 3, a), a, 'a script shown again');
  assert.notEqual(snap([input({ held: null }), rows[1]!], 3, a), a, 'an answer no longer fresh');
});

test('only visible scalar plots get figures: compound plots and marks are said, hidden scripts and invisible plots left out', () => {
  const n = 48, up = Array.from({ length: n }, (_, i) => i), marks = Array.from({ length: n }, (_, i) => i % 5 === 0 ? 1 : NaN);
  const h = snap([
    input({ plots: [plot('line', 'Fast', up), plot('histogram', 'Fast', up.map(v => -v)), plot('candlestick', 'Bars', up), plot('cloudarea', '', up), plot('mark', 'Cross', marks), plot('line', 'Gone', up, { visible: false }), plot('mark', 'Tag', up.map((_, i) => i === n - 1 ? 1 : NaN))] }),
    input({ id: 'h', name: 'Hidden one', hidden: true }),
    input({ id: 'e', name: 'Broken', held: { ok: false, error: 'line 3: unknown name', at: Infinity } }),
  ]);
  const lines = new ScriptRangeSummary().lines(sel(0, 20), h, true, KEY, NOW, false);
  // Duplicate titles are told apart by their place.
  assert.deepEqual(lines.flatMap(l => l.grid ?? []).map(g => [g.key, g.label]), [['rsi-0', 'Fast (1)'], ['rsi-1', 'Fast (2)']]);
  assert.equal(row(tile(lines, 'rsi-1'), 'Change'), '−19', 'a histogram is not summed: it has a change like any plot');
  assert.ok(lines.every(l => l.tone !== 'buy' && l.tone !== 'sell') && lines.flatMap(l => l.grid ?? []).every(g => !g.tone && (g.rows ?? []).every(r => !r.tone)), 'neutral tones: an increase is not good or bad');
  assert.match(text(lines, 'sc-compound-rsi') ?? '', /Bars, cloudarea 4/);
  assert.equal(text(lines, 'sc-marks-rsi-4'), 'Cross: marks in the script output | 4', 'marks are counted, never called signals or alerts');
  assert.equal(text(lines, 'sc-marks-rsi-6'), undefined, 'a plot of marks with none in the selection (a label at the newest candle) says nothing');
  assert.match(text(lines, 'sc-invisible-rsi') ?? '', /1 plot/);
  assert.ok(text(lines, 'sc-unit-rsi'));
  assert.ok(text(lines, 'sc-hidden-h'));
  assert.equal(text(lines, 'sc-error-e'), 'line 3: unknown name');
  assert.ok(!lines.some(l => /signal|alert/i.test(l.cells.join(' '))));
});

test('one value and no value; a tile keeps enough digits to tell its first and last apart', () => {
  const vals = Array.from({ length: 48 }, () => NaN); vals[5] = 98_765.4;
  const h = snap([input({ plots: [plot('line', 'One', vals), plot('area', 'None', Array.from({ length: 48 }, () => NaN))] })]);
  const lines = new ScriptRangeSummary().lines(sel(0, 10), h, true, KEY, NOW, false);
  assert.equal(row(tile(lines, 'rsi-0'), 'Value'), '98,765');
  assert.equal(row(tile(lines, 'rsi-0'), 'Change'), undefined, 'one value has no change');
  assert.equal(tile(lines, 'rsi-1')?.value, 'No value in this selection');
  // Price-like values that move little keep their digits (the popup's 98.8K → 98.8K would sit beside a change of +46).
  const f = valueFormat(98_765.4, 98_812.1);
  assert.deepEqual([f(98_765.4), f(98_812.1), f(98_812.1 - 98_765.4, true)], ['98,765.4', '98,812.1', '+46.7']);
  const g = valueFormat(54.27, 55.03);
  assert.deepEqual([g(54.27), g(55.03), g(0.76, true)], ['54.27', '55.03', '+0.76']);
  // A first and last closer than the width: the change sets the digits.
  const close = valueFormat(50, 60, 0.002, [54.27, 54.272]);
  assert.deepEqual([close(54.27), close(54.272), close(0.002, true)], ['54.270', '54.272', '+0.002']);
  const big = valueFormat(1.234e9, 1.734e9);
  assert.deepEqual([big(1.234e9), big(-5e8, true)], ['1.234B', '−0.500B']);
  assert.deepEqual([valueFormat(10, 17)(7, true), valueFormat(10, 17.5)(7.5, true)], ['+7', '+7.5'], 'whole numbers stay whole; decimals zero in every value are dropped');
  assert.equal(valueFormat(0.0123, 0.0123)(0.0123), '0.0123');
  // A cumulative line in billions that moved by millions reads in millions (not -4.86429B -> -4.85495B).
  const cum = valueFormat(-4.86429e9, -4.82915e9, 9.33e6);
  assert.deepEqual([cum(-4.86429e9), cum(9.33e6, true)], ['−4,864.29M', '+9.33M']);
  assert.equal(valueFormat(-4.9e9, 5e8)(5e8), '0.5B', 'a gap of billions stays in billions');
  // A gap of one on a billion, and values too small for eight decimals, are still told apart (and a change is never shown as zero).
  const fine = valueFormat(1e9, 1e9 + 1);
  assert.deepEqual([fine(1e9), fine(1e9 + 1), fine(1, true)], ['1,000,000,000', '1,000,000,001', '+1']);
  const tiny = valueFormat(1e-10, 2e-10);
  assert.deepEqual([tiny(1e-10), tiny(2e-10), tiny(1e-10, true), tiny(-1e-10, true)], ['1.00e-10', '2.00e-10', '+1.00e-10', '−1.00e-10']);
});

test('no script in the pane, a pane never drawn, a hidden pane and a selection not begun say so', () => {
  const summary = new ScriptRangeSummary();
  assert.ok(text(summary.lines(sel(0, 10), null, false, KEY, NOW, false, '', true), 'sc-none'));
  assert.ok(text(summary.lines(sel(0, 10), null, false, KEY, NOW, false), 'sc-none'));
  assert.ok(text(summary.lines(sel(0, 10), snap([input()]), false, KEY, NOW, false), 'sc-hidden'));
  assert.equal(text(summary.lines(sel(60, 70), snap([input()]), true, KEY, NOW, false), 'sc-none'), 'This selection has not begun yet.');
});

test('a run that lacks candles of the selection gives the times of its first and last value', () => {
  // The run holds hours 0 and 1 of [0, 4): every value it holds is finite, but the selection's last two closed candles are not in it.
  const h = snap([input({ time: hours(0, 2), plots: [plot('line', 'L', [5, 6])] })]);
  const lines = new ScriptRangeSummary().lines(sel(0, 4), h, true, KEY, NOW, false);
  assert.equal(row(tile(lines, 'rsi-0'), 'Candles with a value'), '2 of 2');
  assert.match(text(lines, 'sc-cover-rsi') ?? '', /2 of the 4 closed candles in this selection · newer closed candles are not in its last run/);
  assert.match(tile(lines, 'rsi-0')?.note ?? '', /^First value .* · last /, 'the endpoints\' times are given');
});

test('a selection where no closed candle starts says so, with no tiles; huge, infinite and twin-named plots are handled', () => {
  const h = snap([input()]);
  // 12:07 to 12:42 of a 1h chart: no candle starts in it.
  const inside: RangeSelection = { ...sel(12, 13), t0: T + 12 * H + 7 * 60_000, t1: T + 12 * H + 42 * 60_000 };
  const lines = new ScriptRangeSummary().lines(inside, h, true, KEY, NOW, false);
  assert.equal(text(lines, 'sc-none'), 'No 1h candle of the Scripts pane starts in this range.');
  assert.ok(!lines.some(l => l.grid), 'no tile of "No value"');
  // The candle under way alone.
  const under = new ScriptRangeSummary().lines(sel(48, 49), h, true, KEY, NOW, false);
  assert.ok(text(under, 'sc-forming') && !under.some(l => l.grid));
  // Huge and non-finite values never print 300 digits or "+∞B".
  const huge = valueFormat(1e300, 2e300);
  assert.deepEqual([huge(1e300), huge(1e300, true)], ['1.00e+300', '+1.00e+300']);
  assert.equal(valueFormat(-1e308, 1e308)(Infinity, true), '–');
  // An invisible twin does not number the plot shown.
  const twins = snap([input({ plots: [plot('line', 'RSI', Array(48).fill(1), { visible: false }), plot('line', 'RSI', Array.from({ length: 48 }, (_, i) => i))] })]);
  assert.deepEqual(new ScriptRangeSummary().lines(sel(0, 10), twins, true, KEY, NOW, false).flatMap(l => l.grid ?? []).map(g => g.label), ['RSI']);
});
