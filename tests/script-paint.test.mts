import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_MARGINS, marginsOf, onPlot, plotColorAt, plotExtent, scaleIdOf, scalesOf, shortNumber, visibleRange, yOf } from '../src/app/script/paint.ts';
import type { PlotOut } from '../src/app/script/protocol.ts';
import { interpolateColors, parseColor, safeColor } from '../src/app/script/lang/colors.ts';

const plot = (kind: PlotOut['kind'], values: number[], style: PlotOut['style'] = {}): PlotOut => ({ kind, title: '', style, fields: kind === 'cloudarea' ? { lowerValue: Float64Array.from(values), higherValue: Float64Array.from(values.map(v => v + 1)) } : { value: Float64Array.from(values) }, colors: null });

test('the candles in view, with one either side so a line runs off the edges', () => {
  const time = Float64Array.from([0, 60, 120, 180, 240].map(s => s * 1000));
  assert.deepEqual(visibleRange(time, 70_000, 150_000, 60_000), [0, 3]);
  assert.deepEqual(visibleRange(time, -1e9, 1e9, 60_000), [0, 4]);
  assert.deepEqual(visibleRange(time, 300_000, 400_000, 60_000), [3, 4]);
});

test('plots on one scale id share a scale fitted to what is in view; a histogram stands on its base', () => {
  const a = plot('line', [1, 5, 3]), b = plot('line', [10, 20, 30], { priceScaleId: 'other', scaleMargins: { top: 0.2, bottom: 0.3 } }), h = plot('histogram', [4, 6, 8]);
  const scales = scalesOf([a, b, h], {}, 0, 1);
  assert.deepEqual(scales.get('right'), { min: 0, max: 6, margins: DEFAULT_MARGINS }, 'the histogram brings its base of 0 in');
  assert.deepEqual(scales.get('other'), { min: 10, max: 20, margins: { top: 0.2, bottom: 0.3 } });
  assert.equal(scaleIdOf(a, { priceScaleId: 'mine' }), 'mine', 'the script\'s own scale id when the plot names none');
  assert.deepEqual(plotExtent(plot('line', [NaN, NaN]), 0, 1), null);
  assert.ok(!scalesOf([plot('line', [1, 2], { visible: false })], {}, 0, 1).size, 'an invisible plot sets no scale');
  const flat = scalesOf([plot('line', [7, 7])], {}, 0, 1).get('right')!;
  assert.ok(flat.min < 7 && flat.max > 7, 'a flat line is drawn in the middle, not on an edge');
});

test('margins are held inside the row, and a value is placed between them', () => {
  const held = marginsOf({ style: { scaleMargins: { top: 0.9, bottom: 0.9 } } }, {});
  assert.ok(Math.abs(held.top - 0.475) < 1e-12 && Math.abs(held.bottom - 0.475) < 1e-12, 'two margins that would leave no room are shrunk together');
  assert.deepEqual(marginsOf({ style: {} }, { scaleMargins: { top: 0.5, bottom: 0 } }), { top: 0.5, bottom: 0 });
  const s = { min: 0, max: 10, margins: { top: 0.1, bottom: 0.1 } };
  assert.equal(yOf(10, s, 100, 100), 110);
  assert.equal(yOf(0, s, 100, 100), 190);
});

test('the pointer is on a plot only on what it draws: a line or the edge of a cloud, a bar, a candle, a cell; not a fill', () => {
  // Three candles a minute apart, 10 px each, on a scale where y = 100 - value (no margins).
  const time = Float64Array.from([0, 60_000, 120_000]), f = { x: (t: number) => t / 6000, barW: 10, time, top: 0, height: 100 };
  const s = { min: 0, max: 100, margins: { top: 0, bottom: 0 } };
  const line = plot('line', [50, 60, 70]);
  assert.ok(onPlot(line, s, f, 0, 5, 50, 3), 'on the point at the middle of the candle');
  assert.ok(onPlot(line, s, f, 0, 10, 45, 3), 'halfway to the point of the next candle, the line is halfway up');
  assert.ok(!onPlot(line, s, f, 0, 5, 30, 3), 'twenty pixels off the line');
  assert.ok(onPlot(plot('line', [50, 60, 70], { lineType: 1 }), s, f, 0, 9, 50, 3), 'a step is level across its candle');
  const area = plot('area', [50, 60, 70]);
  assert.ok(onPlot(area, s, f, 1, 15, 40, 3) && !onPlot(area, s, f, 1, 15, 80, 3), 'an area counts on its line, not in its fill');
  const cloud = plot('cloudarea', [50, 60, 70]);
  assert.ok(onPlot(cloud, s, f, 0, 5, 49, 2) && onPlot(cloud, s, f, 0, 5, 50, 2) && !onPlot(cloud, s, f, 0, 5, 70, 2), 'a cloud counts on its edges');
  const bars = plot('histogram', [40, 0, 0]);
  assert.ok(onPlot(bars, s, f, 0, 5, 80, 2) && !onPlot(bars, s, f, 0, 5, 40, 2), 'a histogram bar counts inside, from its base to its value');
  assert.ok(!onPlot(plot('line', [50, 60, 70], { visible: false }), s, f, 0, 5, 50, 3), 'a hidden plot is not there');
  assert.ok(!onPlot(line, s, f, -1, 5, 50, 3), 'no candle under the pointer, nothing');
});

test('numbers for tags and readouts are short', () => {
  assert.deepEqual([1_234_567, -45_600, 250, 3.14159, 0.000123, 0, 2.5e9, NaN].map(shortNumber), ['1.23M', '−45.6K', '250', '3.14', '0.000123', '0', '2.50B', '–']);
});

test('colours a script gives are read before they are painted, and blends run along the stops', () => {
  assert.deepEqual(parseColor('#f00'), [255, 0, 0, 1]);
  assert.deepEqual(parseColor('rgba(1, 2, 3, 0.5)'), [1, 2, 3, 0.5]);
  assert.deepEqual(parseColor('Transparent'), [0, 0, 0, 0]);
  assert.equal(parseColor('url(javascript:1)'), null);
  assert.equal(parseColor('constructor'), null, 'a name the table only inherits is no colour');
  assert.equal(safeColor('nonsense', 'fallback'), 'fallback');
  assert.equal(interpolateColors(0.5, ['rgb(0,0,0)', 'rgb(255,255,255)']), 'rgb(128, 128, 128)');
  assert.equal(interpolateColors(-1, ['red', 'blue']), 'rgb(255, 0, 0)');
  assert.equal(interpolateColors(2, ['red', 'blue']), 'rgb(0, 0, 255)');
  assert.equal(interpolateColors(0.5, ['rgba(0,0,0,0)', 'rgba(0,0,0,1)']), 'rgba(0, 0, 0, 0.5)');
});

test('a legend swatch takes the colour the plot is drawn in at that candle', () => {
  const pal = safeColor('#123456', ''), up = safeColor('#00ff00', ''), down = safeColor('#ff0000', '');
  const line = { ...plot('line', [1, 2]), style: { color: 'blue' }, colors: ['red', ''] };
  assert.equal(plotColorAt(line, 0, pal, up, down), safeColor('red', ''), "a point's own colour first");
  assert.equal(plotColorAt(line, 1, pal, up, down), safeColor('blue', ''), "then the plot's");
  assert.equal(plotColorAt(plot('line', [1], { lineColor: 'orange' }), 0, pal, up, down), safeColor('orange', ''));
  assert.equal(plotColorAt(plot('line', [1]), 0, pal, up, down), pal, "else the page's colour for its place");
  const candles: PlotOut = { kind: 'candlestick', title: '', style: {}, fields: { open: Float64Array.from([1, 2]), high: Float64Array.from([3, 3]), low: Float64Array.from([0, 0]), close: Float64Array.from([2, 1]) }, colors: null };
  assert.deepEqual([plotColorAt(candles, 0, pal, up, down), plotColorAt(candles, 1, pal, up, down)], [up, down], 'a candle by its direction');
  assert.equal(plotColorAt(plot('baseline', [-1], { baseValue: 0, bottomLineColor: 'purple' }), 0, pal, up, down), safeColor('purple', ''), 'a baseline below its base');
});
