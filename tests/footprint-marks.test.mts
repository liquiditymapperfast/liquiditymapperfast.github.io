import test from 'node:test';
import assert from 'node:assert/strict';
import { FootprintMarks, marksOf } from '../src/app/footprint/marks.ts';
import { FOOTPRINT_DEFAULTS, readFootprint } from '../src/app/footprint/settings.ts';
import { FootprintData, rowCellAt, rowCellLines, type Bar } from '../src/app/panes/footprint.ts';
import { DEFAULT_STAT_OPTIONS } from '../src/app/stat-options.ts';

const T = Date.UTC(2026, 9, 9, 12);
// Five rows of $5: sells 90 at 100 against buys 20 at 105; buys 90, 100 and 120 at 110 to 120 against the sells one row down.
const bar: Bar = { t: T, buyUsd: 335, sellUsd: 113, rows: [[100, 5, 90], [105, 20, 10], [110, 90, 5], [115, 100, 4], [120, 120, 4]] };

test('a candle\'s marks: each diagonal imbalance with its ratio, the stacked runs, and the busiest row', () => {
  const m = marksOf(bar, 5, DEFAULT_STAT_OPTIONS);
  assert.deepEqual([...m.flags], [[100, { sell: 4.5 }], [110, { buy: 9 }], [115, { buy: 20 }], [120, { buy: 30 }]]);
  assert.deepEqual(m.zones, [{ side: 'buy', low: 110, high: 125 }], 'three buy rows in a row: one stack from 110 to the top of 120');
  assert.equal(m.poc, 120, 'the busiest row');
  assert.deepEqual(marksOf(bar, 5, { ...DEFAULT_STAT_OPTIONS, stackedN: 4 }).zones, [], 'four needed: none');
  assert.equal(marksOf({ ...bar, rows: [] }, 5, DEFAULT_STAT_OPTIONS).poc, null);
});

test('the marks are worked out again only when the rows are loaded anew or the options change', () => {
  const data = new FootprintData(); data.step = 5; data.bars = new Map([[T, bar]]); data.version = 1;
  const cache = new FootprintMarks();
  const first = cache.get(data, DEFAULT_STAT_OPTIONS);
  assert.equal(cache.get(data, { ...DEFAULT_STAT_OPTIONS }), first, 'the same options again: the same marks');
  assert.notEqual(cache.get(data, { ...DEFAULT_STAT_OPTIONS, imbRatio: 10 }), first);
  data.version++;
  assert.notEqual(cache.get(data, { ...DEFAULT_STAT_OPTIONS, imbRatio: 10 }), first, 'a new load');
});

test('the row popup says why a row is outlined: the ratio against the row one away, or that nothing traded there', () => {
  const cell = rowCellAt(bar, 5, 101)!;
  const lines = rowCellLines(cell, bar, 5, '1m', { sell: 4.5 }).map(l => `${l.label ?? ''} ${l.text}`);
  assert.ok(lines.includes('Diagonal sells 4.5× the buys one row up'), lines.join(' | '));
  const empty = rowCellLines(cell, bar, 5, '1m', { buy: Infinity }).map(l => l.text);
  assert.ok(empty.includes('buys, none sold one row down'));
  assert.ok(!rowCellLines(cell, bar, 5, '1m').some(l => l.label === 'Diagonal'), 'no flags: no line');
});

test('footprint settings are read field by field', () => {
  assert.deepEqual(readFootprint(undefined), FOOTPRINT_DEFAULTS);
  assert.deepEqual([FOOTPRINT_DEFAULTS.text, FOOTPRINT_DEFAULTS.diagonal, FOOTPRINT_DEFAULTS.zones, FOOTPRINT_DEFAULTS.nakedPoc], ['split', true, false, false]);
  assert.deepEqual(readFootprint({ text: 'delta', diagonal: false, zones: true, nakedPoc: 'yes' }), { text: 'delta', diagonal: false, zones: true, nakedPoc: false });
  assert.equal(readFootprint({ text: 'everything' }).text, 'split');
});
