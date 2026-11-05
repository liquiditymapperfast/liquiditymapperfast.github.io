import test from 'node:test';
import assert from 'node:assert/strict';
import { DEPTH_DEFAULT, MAX_BANDS, PRESET_BANDS, bandEditText, bandText, bandsOf, cleanBands, parseBands, readDepthSettings, watchedBand } from '../src/app/depth-settings.ts';

test('the default is five doubling bands from ±0.31 % to ±5 %, drawn in full on a linear scale with the table', () => {
  const s = readDepthSettings(undefined);
  assert.deepEqual(s, DEPTH_DEFAULT);
  assert.deepEqual(bandsOf(s).map(bandText), ['0.31', '0.63', '1.25', '2.5', '5']);
  assert.deepEqual(PRESET_BANDS.near.map(bandText), ['0.13', '0.25', '0.5', '1', '2']);
  assert.deepEqual(PRESET_BANDS.wide.map(bandText), ['1.25', '2.5', '5', '10', '20']);
  for (const bands of Object.values(PRESET_BANDS)) for (let i = 1; i < bands.length; i++) assert.ok(Math.abs(bands[i]! / bands[i - 1]! - 2) < 1e-12, 'each band doubles the last');
  assert.equal(watchedBand(s), 4, 'nothing brought forward: the widest is watched');
});

test('a save or a layout from anywhere: every field checked, anything else its default', () => {
  assert.deepEqual(readDepthSettings({ preset: 'wide', scale: 'detail', units: 'coin', table: false, focus: 2, custom: [0.001, 0.01] }),
    { preset: 'wide', scale: 'detail', units: 'coin', table: false, focus: 2, custom: [0.001, 0.01] });
  const bad = readDepthSettings({ preset: 'huge', scale: 'log', units: 'eur', table: 'yes', focus: 1.5, custom: [0.01, 0.005] });
  assert.deepEqual(bad, DEPTH_DEFAULT, 'nothing it does not know survives');
  assert.equal(readDepthSettings({ preset: 'custom', custom: [0.01, 0.02], focus: 2 }).focus, null, 'a band past the list is not brought forward');
  assert.equal(readDepthSettings({ preset: 'custom', custom: [0.01, 0.02], focus: 1 }).focus, 1);
  assert.deepEqual(bandsOf(readDepthSettings({ preset: 'custom', custom: [0.01, 0.02] })), [0.01, 0.02]);
  assert.equal(watchedBand(readDepthSettings({ focus: 1 })), 1);
});

test('bands are 0.05 % to 50 %, ascending without repeats, one to six', () => {
  assert.deepEqual(cleanBands([0.0005, 0.5]), [0.0005, 0.5]);
  for (const bad of [[], [0.0004], [0.51], [0.01, 0.01], [0.02, 0.01], [NaN], ['0.01'], Array.from({ length: MAX_BANDS + 1 }, (_, i) => (i + 1) / 100), 'x'] as unknown[])
    assert.equal(cleanBands(bad), null, JSON.stringify(bad));
});

test('typed bands: percentages in any order and separator, a % allowed; a reason when they cannot be used', () => {
  assert.deepEqual(parseBands('0.25, 0.5 1;2  5%'), { bands: [0.0025, 0.005, 0.01, 0.02, 0.05] });
  assert.deepEqual(parseBands('5, 1, 0.5'), { bands: [0.005, 0.01, 0.05] }, 'sorted');
  assert.deepEqual(parseBands('  '), { error: 'empty' });
  assert.deepEqual(parseBands('1, two'), { error: 'number' });
  assert.deepEqual(parseBands('-1'), { error: 'number' });
  assert.deepEqual(parseBands('0.01'), { error: 'range' }, '0.01 % is under the floor');
  assert.deepEqual(parseBands('60'), { error: 'range' });
  assert.deepEqual(parseBands('1 2 3 4 5 6 7'), { error: 'count' });
  assert.deepEqual(parseBands('1, 1.0'), { error: 'repeat' });
  for (const bands of [...Object.values(PRESET_BANDS), [0.00125, 0.00126], [0.003125, 0.00625], [0.0005, 0.5]]) {
    const typed = parseBands(bands.map(bandEditText).join(', '));
    assert.ok('bands' in typed && typed.bands.length === bands.length && typed.bands.every((r, i) => Math.abs(r - bands[i]!) < 1e-12), `the editor's text reads back exactly: ${bands.map(bandEditText).join(', ')}`);
  }
  assert.deepEqual(PRESET_BANDS.balanced.map(bandEditText), ['0.3125', '0.625', '1.25', '2.5', '5']);
  assert.notDeepEqual(PRESET_BANDS.balanced.map(bandText), PRESET_BANDS.balanced.map(bandEditText), 'the label rounds, the editor does not');
});
