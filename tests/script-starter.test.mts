import test from 'node:test';
import assert from 'node:assert/strict';
import { analyze, runScript } from '../src/app/script/lang/engine.ts';
import { SCRIPTS_KEY, SCRIPT_API, loadScripts, storeScripts } from '../src/app/script/records.ts';
import { HEATMAP_ID, HEATMAP_SOURCE, STARTER_ID, VWAP_SOURCE, starterScripts, updateStarters } from '../src/app/script/starter.ts';
import { PREVIOUS_HEATMAP_SOURCES, PREVIOUS_VWAP_SOURCES } from '../src/app/script/starter-previous.ts';
import { createRunner, sameCandles } from '../src/app/script/lang/engine.ts';
import type { BarInputs, ScriptTheme } from '../src/app/script/inputs.ts';

const MIN = 60_000;
/** Candles 0..n-1 whose typical price is 100 + i, with 15·(i+1) traded in each (the candle's volume, and the dollars at market). */
function inputs(n = 8): BarInputs {
  const time = Float64Array.from({ length: n }, (_, i) => i * MIN);
  return {
    tf: MIN, time,
    open: Float64Array.from(time, (_, i) => 100 + i), high: Float64Array.from(time, (_, i) => 101 + i), low: Float64Array.from(time, (_, i) => 99 + i),
    close: Float64Array.from(time, (_, i) => 100 + i), volume: Float64Array.from(time, (_, i) => 15 * (i + 1)),
    sources: { '': { vbuy: Float64Array.from(time, (_, i) => 10 * (i + 1)), vsell: Float64Array.from(time, (_, i) => 5 * (i + 1)), lbuy: new Float64Array(n), lsell: new Float64Array(n), markets: 1 } },
    forming: false,
  };
}

test('a browser that never kept scripts starts with the VWAP on and the heat map off; one that kept a list, an empty one too, keeps it', () => {
  const kept = new Map<string, string>();
  const storage = { getItem: (k: string) => kept.get(k) ?? null, setItem: (k: string, v: string) => { kept.set(k, v); } };
  const first = loadScripts(storage, starterScripts);
  assert.deepEqual(first.map(r => [r.id, r.on, r.place]), [[STARTER_ID, true, 'map'], [HEATMAP_ID, false, 'pane']], 'the VWAP on the map, on; the heat map in a row, off');
  assert.equal(first[1]!.height, 160, "the heat map's row has room for its sixteen bands");
  assert.equal(first[0]!.source, VWAP_SOURCE);
  assert.equal(kept.size, 0, 'nothing is written until the person changes the list');
  assert.ok(storeScripts([], storage));
  assert.deepEqual(loadScripts(storage, starterScripts), [], 'a deleted starter stays deleted');
  kept.set(SCRIPTS_KEY, '{broken');
  assert.deepEqual(loadScripts(storage, starterScripts), [], 'something unreadable is not replaced by the starter');
  assert.equal(loadScripts({ getItem: () => { throw new Error('blocked'); } }, starterScripts).length, 2, 'storage the page cannot reach: the starters, for this visit');
  assert.deepEqual(loadScripts(storage), [], 'without a starter, none');
});

test('the VWAP reads, runs without a warning and draws its line inside its bands on the price scale', () => {
  const a = analyze(VWAP_SOURCE);
  assert.deepEqual(a.declared.map(d => d.name), ['len', 'mult', 'midColor', 'bandColor']);
  const r = runScript('vwap', VWAP_SOURCE, {}, inputs());
  assert.ok(r.ok, r.ok ? '' : JSON.stringify(r.error));
  // Its 48 candles are more than these 8: that alone is said (the page reads 500 and more), and nothing once they are there.
  assert.deepEqual(r.warnings, [{ code: 'long-window', detail: '14|48|48|8' }]);
  const filled = runScript('vwap', VWAP_SOURCE, {}, inputs(48));
  assert.ok(filled.ok && filled.warnings.length === 0);
  assert.deepEqual(r.plots.map(p => [p.kind, p.title]), [['line', 'VWAP'], ['line', '+SD'], ['line', '-SD']]);
  for (const p of r.plots) assert.equal(p.style.priceScaleId ?? 'right', 'right', 'drawn at its prices on the map');
  const [mid, upper, lower] = r.plots.map(p => [...p.fields.value!]);
  assert.equal(mid![0], 100, 'one candle: its own typical price');
  // Two candles: (100·15 + 101·30) / 45.
  assert.ok(Math.abs(mid![1]! - (100 * 15 + 101 * 30) / 45) < 1e-9);
  for (let i = 0; i < mid!.length; i++) assert.ok(lower![i]! <= mid![i]! && mid![i]! <= upper![i]!, `candle ${i}`);
  const short = runScript('vwap', VWAP_SOURCE, { len: 4 }, inputs());
  assert.ok(short.ok);
  // Four candles back from the last (typical 104..107, volumes 75..120): its options change what it draws.
  const want = [104, 105, 106, 107].reduce((s, p, k) => s + p * 15 * (5 + k), 0) / [5, 6, 7, 8].reduce((s, k) => s + 15 * k, 0);
  assert.ok(Math.abs(short.plots[0]!.fields.value![7]! - want) < 1e-9);
  // The flow this page recorded plays no part: with none at all (a page that reads the exchanges from the browser has none from before it
  // opened), every candle weighs by its volume as before.
  const unrecorded = inputs(), src = unrecorded.sources['']!;
  src.vbuy.fill(NaN); src.vsell.fill(NaN);
  const u = runScript('vwap', VWAP_SOURCE, {}, unrecorded);
  assert.ok(u.ok);
  assert.deepEqual(u.plots.map(p => [...p.fields.value!]), r.plots.map(p => [...p.fields.value!]), 'the same lines with no flow recorded');
  // A candle with no volume reported: nothing drawn there, and the next candles go on from the ones before.
  const gap = inputs();
  gap.volume[3] = NaN;
  const g = runScript('vwap', VWAP_SOURCE, {}, gap);
  assert.ok(g.ok);
  assert.ok(g.plots.every(p => Number.isNaN(p.fields.value![3]!)), 'a gap, not the close');
  assert.ok(Number.isFinite(g.plots[0]!.fields.value![4]!) && Math.abs(g.plots[0]!.fields.value![4]! - 100) < 10);
});

test('an untouched VWAP with bands of an earlier version, the starter or a copy from the examples, is brought to the current one', () => {
  const old = { id: STARTER_ID, name: 'VWAP with bands', source: PREVIOUS_VWAP_SOURCES[0]!, options: { len: 24 }, on: true, api: 1, height: 60, place: 'map' as const };
  const [now] = updateStarters([old]);
  assert.equal(now!.source, VWAP_SOURCE);
  assert.deepEqual(now!.options, { len: 24 }, 'its settings stay');
  assert.equal(now!.api, SCRIPT_API, 'its new text reads $price.volume: a version-2 script');
  assert.equal(updateStarters([{ ...old, id: 'vwap-with-bands-2' }])[0]!.source, VWAP_SOURCE, 'a copy added from the examples');
  assert.equal(updateStarters([{ ...old, source: old.source.replace(/\n/g, '\r\n') }])[0]!.source, VWAP_SOURCE, 'line ends as a file wrote them');
  const edited = { ...old, source: `${old.source}// mine\n` };
  assert.equal(updateStarters([edited])[0]!.source, edited.source, 'edited by the person: kept');
  assert.ok(PREVIOUS_VWAP_SOURCES[0]!.includes('var vol = vbuy + vsell'), 'the earlier text, as it was written');
  assert.ok(!VWAP_SOURCE.includes('vbuy'), 'the current one reads no recorded flow');
});

const DARK: ScriptTheme = { dark: true, background: '#000000', text: '#00ff00', up: '#11af00', down: '#ff6363' };
const LIGHT: ScriptTheme = { dark: false, background: '#ffffff', text: '#1b1d21', up: '#12a150', down: '#e0115f' };
/** Candles that climb for 30 and fall for 30: every window's stochastic goes high, then low. */
function swing(theme?: ScriptTheme): BarInputs {
  const base = inputs(60), close = Float64Array.from(base.time, (_, i) => i < 30 ? 100 + i : 160 - i);
  return { ...base, open: close, close, high: close.map(c => c + 1), low: close.map(c => c - 1), ...(theme ? { theme } : {}) };
}
const rgbOf = (c: string): number[] => (/rgba?\(([^)]+)\)/.exec(c)?.[1] ?? '').split(',').map(Number).slice(0, 3);

test('the heat map reads the theme: red-orange low and blue high, light ends on a dark chart and dark ends on a light one, a neutral middle', () => {
  const a = analyze(HEATMAP_SOURCE);
  assert.ok(!('code' in a) || !a.code, 'it reads');
  for (const theme of [DARK, LIGHT]) {
    const r = runScript('heat', HEATMAP_SOURCE, {}, swing(theme));
    assert.ok(r.ok, JSON.stringify(!r.ok && r.error));
    // Its longest window (210 candles) is more than these 60, which is said; nothing else is: theme is an input it knows.
    assert.deepEqual(r.warnings.filter(w => w.code !== 'long-window'), [], 'no other warning: theme is an input it knows');
    const top = r.plots.filter(p => p.kind === 'brokenarea')[15]!, colours = top.colors!;
    const [hr, , hb] = rgbOf(colours[29]!), [lr, , lb] = rgbOf(colours[59]!);
    assert.ok(hb > hr, `high is blue: ${colours[29]}`);
    assert.ok(lr > lb, `low is red-orange: ${colours[59]}`);
    const light = (c: string): number => rgbOf(c).reduce((x, y) => x + y, 0);
    if (theme.dark) assert.ok(light(colours[29]!) > 400 && light(colours[59]!) > 400, 'light ends on a dark chart');
    else assert.ok(light(colours[29]!) < 450 && light(colours[59]!) < 450, 'dark ends on a light chart');
    const avg = r.plots.find(p => p.title === 'Average')!;
    assert.equal(String(avg.style.color), theme.dark ? '#f2f2f2' : '#1c1c1c', 'the average off-white on a dark chart, near-black on a light one');
  }
  // A reading of 50 is the neutral middle, a little off the background (a neutral reading is not the same as none), on both kinds of chart.
  for (const [theme, grey] of [[DARK, [46, 46, 46]], [LIGHT, [232, 232, 232]]] as const) {
    const flat = inputs(40), close = flat.close.map(() => 100);
    const mid = runScript('heat', HEATMAP_SOURCE, {}, { ...flat, theme, open: close, close, high: close.map(c => c + 1), low: close.map(c => c - 1) });
    assert.ok(mid.ok);
    assert.deepEqual(rgbOf(mid.plots.find(p => p.kind === 'brokenarea')!.colors![39]!), [...grey], theme.dark ? 'dark' : 'light');
  }
  // A candle that was not recorded draws nothing in any row, rather than the colour of 0.
  const gap = swing(DARK), holed = runScript('heat', HEATMAP_SOURCE, {}, { ...gap, close: gap.close.map((c, i) => i === 45 ? NaN : c) });
  assert.ok(holed.ok);
  assert.ok(holed.plots.filter(p => p.kind === 'brokenarea').every(p => /transparent|rgba\(0, ?0, ?0, ?0\)/.test(p.colors![45]!)), holed.plots[0]!.colors![45]);
  // With twelve steps, readings inside one step share a colour.
  const stepped = runScript('heat', HEATMAP_SOURCE, { steps: true }, swing(DARK)), smooth = runScript('heat', HEATMAP_SOURCE, {}, swing(DARK));
  assert.ok(stepped.ok && smooth.ok);
  const distinct = (r: typeof stepped): number => r.ok ? new Set(r.plots.filter(p => p.kind === 'brokenarea').flatMap(p => p.colors ?? [])).size : 0;
  assert.ok(distinct(stepped) <= 12 && distinct(smooth) > 12, `${distinct(stepped)} colours stepped, ${distinct(smooth)} smooth`);
});

test('a script reads the theme, a member it does not have is warned of, and a run under another theme starts again', () => {
  const r = runScript('t', 'line(theme.dark ? 1 : 0)\nline(theme.background == "#ffffff" ? 1 : 0)', {}, { ...inputs(), theme: LIGHT });
  assert.ok(r.ok);
  assert.deepEqual(r.plots.map(p => p.fields.value![0]), [0, 1]);
  const a = analyze('line(theme.colour == "x" ? 1 : 0)');
  assert.ok('warnings' in a && a.warnings.some(w => w.code === 'unsupported-member' && w.detail === 'theme.colour'));
  const given = runScript('t', 'line(theme.dark ? 1 : 0)', {}, inputs());
  assert.ok(given.ok && given.plots[0]!.fields.value![0] === 1, 'no theme given: the default dark one');
  assert.ok(sameCandles({ ...inputs(), theme: DARK }, { ...inputs(), theme: DARK }, 8));
  assert.ok(!sameCandles({ ...inputs(), theme: DARK }, { ...inputs(), theme: LIGHT }, 8), 'other colours are other inputs');
  // A runner kept between runs: the candle under way alone runs again under the same theme, everything under another.
  const runner = createRunner('t', HEATMAP_SOURCE, {}), forming = { ...swing(), forming: true };
  const starts = [DARK, DARK, LIGHT, LIGHT].map(theme => { runner.run({ ...forming, theme }); return runner.startedAt; });
  assert.deepEqual(starts.map(s => s > 0), [false, true, false, true], String(starts));
});

test('a kept heat map of an earlier version is brought to the current one, unless the person edited or coloured it', () => {
  const old = { id: HEATMAP_ID, name: 'Stochastic heat map', source: PREVIOUS_HEATMAP_SOURCES[0]!, options: {}, on: true, api: 1, height: 160, place: 'pane' as const };
  assert.equal(updateStarters([old])[0]!.source, HEATMAP_SOURCE);
  assert.equal(updateStarters([old])[0]!.api, SCRIPT_API, 'its new text reads theme: a version-2 script');
  assert.deepEqual(updateStarters([{ ...old, options: { scale: 2 } }])[0]!.options, { scale: 2 }, 'its other options stay');
  assert.equal(updateStarters([{ ...old, options: { scale: 2 } }])[0]!.source, HEATMAP_SOURCE);
  assert.equal(updateStarters([{ ...old, options: { highColor: '#ff0000' } }])[0]!.source, old.source, 'coloured by the person: kept');
  // A save in the old editor wrote every default down: those are untouched colours, and go with the old text.
  const saved = { scale: 2, lowColor: 'rgb(41,121,255)', midColor: 'rgba(128,128,128,0.12)', highColor: 'rgb(255,152,0)', lineColor: 'rgb(213,0,249)' };
  const moved = updateStarters([{ ...old, options: saved }])[0]!;
  assert.deepEqual([moved.source === HEATMAP_SOURCE, moved.options], [true, { scale: 2 }]);
  assert.equal(updateStarters([{ ...old, options: { ...saved, lineColor: 'rgb(0,0,0)' } }])[0]!.source, old.source, 'one colour of their own: kept');
  assert.equal(updateStarters([{ ...old, source: old.source.replace(/\n/g, '\r\n') }])[0]!.source, HEATMAP_SOURCE, 'written with Windows line ends');
  assert.equal(updateStarters([{ ...old, source: old.source + '\n// mine' }])[0]!.source, old.source + '\n// mine', 'edited: kept');
  assert.equal(updateStarters([{ ...old, id: 'copy' }])[0]!.source, old.source, 'only the starter itself');
  const current = { ...old, source: HEATMAP_SOURCE };
  assert.equal(updateStarters([current])[0], current, 'the current one is left as it is');
});
