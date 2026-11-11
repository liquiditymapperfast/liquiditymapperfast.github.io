import test from 'node:test';
import assert from 'node:assert/strict';
import { CANDLE_COLORS_DEFAULT, candleInk, candleTone, hasCandleColors, readCandleColors, themeEdge, themeEdgeHex, withCandleColor } from '../src/app/candle-colours.ts';
import { LAYOUT_KEYS, readSettings } from '../src/app/store.ts';
import { PALETTES } from '../src/app/theme.ts';

const dark = PALETTES.dark!, light = PALETTES.light!;

test('candle colours read from a save or a layout file keep #rrggbb colours of the three parts only, lower-cased', () => {
  assert.deepEqual(readCandleColors(undefined), CANDLE_COLORS_DEFAULT);
  assert.deepEqual(readCandleColors('junk'), { up: {}, down: {} });
  assert.deepEqual(readCandleColors({ up: { body: '#00FF00', border: 'red', wick: '#12345' }, down: { wick: '#ABCDEF', glow: '#ffffff' } }),
    { up: { body: '#00ff00' }, down: { wick: '#abcdef' } }, 'a name, a short hex and an unknown part are dropped');
  assert.deepEqual(readCandleColors({ up: ['#ffffff'], down: null }), { up: {}, down: {} });
});

test('a colour is set for one part of one direction and given back to the theme with null', () => {
  let c = withCandleColor(CANDLE_COLORS_DEFAULT, 'up', 'body', '#2E9BFF');
  assert.deepEqual(c, { up: { body: '#2e9bff' }, down: {} });
  assert.equal(hasCandleColors(c), true);
  c = withCandleColor(c, 'down', 'wick', '#000000');
  assert.deepEqual(c, { up: { body: '#2e9bff' }, down: { wick: '#000000' } });
  c = withCandleColor(withCandleColor(c, 'up', 'body', null), 'down', 'wick', null);
  assert.deepEqual(c, { up: {}, down: {} });
  assert.equal(hasCandleColors(c), false);
  assert.deepEqual(withCandleColor(CANDLE_COLORS_DEFAULT, 'up', 'border', 'not a colour'), { up: {}, down: {} }, 'a value that is no colour gives the part back to the theme');
  assert.deepEqual(CANDLE_COLORS_DEFAULT, { up: {}, down: {} }, 'the defaults are never changed in place');
});

test('a filled candle keeps the theme\'s edge for its border and wick until they have colours of their own', () => {
  assert.deepEqual(candleInk(CANDLE_COLORS_DEFAULT, 'up', dark, true), { body: dark.candleUp, border: themeEdge(dark), wick: themeEdge(dark) }, 'nothing chosen: as the chart drew before');
  assert.deepEqual(candleInk(CANDLE_COLORS_DEFAULT, 'down', light, true), { body: light.candleDown, border: themeEdge(light), wick: themeEdge(light) });
  const c = { up: { body: '#ffffff', wick: '#888888' }, down: { border: '#ff0000' } };
  assert.deepEqual(candleInk(c, 'up', dark, true), { body: '#ffffff', border: themeEdge(dark), wick: '#888888' });
  assert.deepEqual(candleInk(c, 'down', dark, true), { body: dark.candleDown, border: '#ff0000', wick: themeEdge(dark) });
  assert.equal(candleInk(c, 'up', dark, true, '#123456').body, '#123456', 'a script\'s colour for the candle fills its body');
  assert.equal(candleInk(c, 'up', dark, true, '#123456').wick, '#888888', '... and leaves its own wick');
});

test('an outline candle or a bar is drawn in its border and wick colours, else the body\'s, and a script\'s colour is its whole line', () => {
  assert.deepEqual(candleInk(CANDLE_COLORS_DEFAULT, 'up', dark, false), { body: dark.candleUp, border: dark.candleUp, wick: dark.candleUp }, 'nothing chosen: all in the theme\'s colour, as before');
  const c = { up: { body: '#0000ff' }, down: { body: '#ffff00', border: '#000000' } };
  assert.deepEqual(candleInk(c, 'up', dark, false), { body: '#0000ff', border: '#0000ff', wick: '#0000ff' }, 'the body\'s colour where border and wick have none');
  assert.deepEqual(candleInk(c, 'down', dark, false), { body: '#ffff00', border: '#000000', wick: '#ffff00' });
  assert.deepEqual(candleInk(c, 'down', dark, false, '#abcdef'), { body: '#abcdef', border: '#abcdef', wick: '#abcdef' });
});

test('the price line, its tag and the legend take the body\'s colour of the direction', () => {
  assert.equal(candleTone(CANDLE_COLORS_DEFAULT, 'up', dark), dark.candleUp);
  assert.equal(candleTone(CANDLE_COLORS_DEFAULT, 'down', dark), dark.candleDown);
  assert.equal(candleTone({ up: { border: '#111111' }, down: { body: '#222222' } }, 'down', dark), '#222222');
  assert.equal(candleTone({ up: { border: '#111111' }, down: { body: '#222222' } }, 'up', dark), dark.candleUp, 'a border alone does not change the tone');
});

test('the theme\'s edge is offered to a colour picker as one colour on the page\'s background', () => {
  assert.match(themeEdgeHex(dark), /^#[0-9a-f]{6}$/);
  assert.match(themeEdgeHex(light), /^#[0-9a-f]{6}$/);
  assert.notEqual(themeEdgeHex(dark), themeEdgeHex(light));
});

test('candle colours are kept with a layout and read back through the same checks', () => {
  assert.ok((LAYOUT_KEYS as readonly string[]).includes('candleColors'));
  assert.deepEqual(readSettings({ candleColors: { up: { body: '#00FF00' }, down: { wick: 'nope' } } }).candleColors, { up: { body: '#00ff00' }, down: {} });
  assert.deepEqual(readSettings({}).candleColors, { up: {}, down: {} });
});
