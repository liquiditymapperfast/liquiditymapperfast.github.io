import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { CHART_HIDDEN, CHART_TYPES, chartChoiceName, chartChoiceOf, chartChoicePatch, chartTypeName, readChartChoice } from '../src/app/chart-type.ts';
import { DEFAULT_SHOW, LAYOUT_KEYS } from '../src/app/store.ts';

test('the Chart type menu ticks the type while the price is drawn, and Hidden while it is not', () => {
  for (const type of CHART_TYPES) {
    assert.equal(chartChoiceOf(type, true), type);
    assert.equal(chartChoiceOf(type, false), CHART_HIDDEN);
  }
});

test('Hidden takes the price off the map and keeps the type; a type draws the price that way, whichever was kept', () => {
  const show = { ...DEFAULT_SHOW, candles: true, volume: false };
  const hidden = chartChoicePatch(CHART_HIDDEN, show);
  assert.equal(hidden.show.candles, false);
  assert.equal('chartType' in hidden, false, 'Hidden leaves the type as it was, for when the price comes back');
  assert.equal(hidden.show.volume, false, 'the other switches stay as they were');
  for (const type of CHART_TYPES) {
    const back = chartChoicePatch(type, hidden.show);
    assert.equal(back.chartType, type);
    assert.equal(back.show.candles, true);
    assert.deepEqual({ ...back.show, candles: false }, hidden.show, 'only the price comes back');
  }
});

test('only the four types and Hidden are choices: Candle colours, an unknown row and none are not', () => {
  for (const id of [...CHART_TYPES, CHART_HIDDEN]) assert.equal(readChartChoice(id), id);
  for (const id of ['candle-colours', '', 'heikin-ashi', null]) assert.equal(readChartChoice(id), null);
});

test('Hidden is named in the menu, the types by their own names', () => {
  assert.equal(chartChoiceName(CHART_HIDDEN), 'Hidden');
  for (const type of CHART_TYPES) assert.equal(chartChoiceName(type), chartTypeName(type));
});

test('Hidden is kept where the Candles switch kept it: show.candles, drawn on a first visit, saved with a layout as the type is', () => {
  assert.equal(DEFAULT_SHOW.candles, true);
  assert.ok(LAYOUT_KEYS.includes('show') && LAYOUT_KEYS.includes('chartType'));
});

test('the Panels deck holds twelve switches, none for the candles, in a grid of two rows of six', () => {
  const toolbar = fs.readFileSync('src/app/toolbar.ts', 'utf8'), css = fs.readFileSync('src/app/styles.css', 'utf8');
  const line = toolbar.split('\n').find(l => l.startsWith('const PANE_TOGGLES'));
  assert.ok(line, 'PANE_TOGGLES is one line of toolbar.ts');
  const keys = [...line.matchAll(/\['(\w+)', /g)].map(m => m[1]);
  assert.equal(keys.length, 12);
  assert.ok(!keys.includes('candles'), 'the Chart type menu shows and hides the price');
  // A switch more or fewer changes the grid: its columns and the outlines' overlap are written for six.
  assert.match(css, /\.toolbar \.deck-panels \.seg\.toggles \{ display: grid; grid-template-columns: repeat\(6, auto\); \}/);
  assert.match(css, /\.deck-panels \.seg\.toggles \{ grid-template-columns: repeat\(6, minmax\(max-content, 1fr\)\); \}/);
  assert.match(css, /\.deck-panels \.seg\.toggles button:nth-child\(6n \+ 1\) \{ margin-left: 0; \}/);
  assert.match(css, /\.deck-panels \.seg\.toggles button:nth-child\(-n \+ 6\) \{ margin-top: 0; \}/);
});
