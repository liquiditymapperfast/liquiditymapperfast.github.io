import test from 'node:test';
import assert from 'node:assert/strict';
import { TIMEFRAMES } from '../src/app/hub.ts';
import { LAYOUT_KEYS, TIMEFRAME_IDS, readSettings, type AppState } from '../src/app/store.ts';
import { MAX_LAYOUTS, arrangeOrder, cleanName, fitHeights, exportFile, importFile, mergeLayouts, mergeOrder, readArrangement, settingsOf, settingsToApply, upsert, type SavedLayout } from '../src/app/layouts/layouts.ts';

const defaults = readSettings({});
const state = (patch: Partial<AppState> = {}): AppState => ({ ...defaults, ...patch } as AppState);
const PANES = { order: ['oi', 'depth', 'bars'], heights: { oi: 150, depth: 120 }, sideW: 400, flowW: 280 };
const layout = (name: string, settings = settingsOf(state())): SavedLayout => ({ name, savedAt: 1, settings, panes: PANES });

test('the timeframes the settings accept are the chart\'s', () => assert.deepEqual(TIMEFRAME_IDS, Object.keys(TIMEFRAMES)));

test('a layout keeps what the chart shows, without the VWAP anchors or the profile\'s zone, and applying it keeps this chart\'s own', () => {
  const mine = state({ timeframe: '15m', ladderMode: 'compact', vwap: { ...defaults.vwap, on: true, anchors: { BTC: [1, 2] } }, traded: { ...defaults.traded, zone: 'Asia/Tokyo', count: 3 } });
  const kept = settingsOf(mine);
  assert.deepEqual(Object.keys(kept).sort(), [...LAYOUT_KEYS].sort());
  assert.ok(!('anchors' in kept.vwap!) && !('zone' in kept.traded!), 'neither in the layout, nor in a file written from it');
  const other = state({ vwap: { ...defaults.vwap, anchors: { ETH: [5] } }, traded: { ...defaults.traded, zone: 'UTC' } });
  const applied = settingsToApply(kept, other);
  assert.equal(applied.timeframe, '15m');
  assert.equal(applied.ladderMode, 'compact');
  assert.equal(applied.vwap.on, true);
  assert.deepEqual(applied.vwap.anchors, { ETH: [5] }, 'the anchors of the chart it is applied to');
  assert.equal(applied.traded.zone, 'UTC');
  assert.equal(applied.traded.count, 3);
});

test('a file can come from anywhere: every field is checked, anything else gets its default', () => {
  const junk = readSettings({ timeframe: '2h', layer: 'gamma', show: { depth: 'yes', oi: false, evil: true }, ladderMode: 'tiles', ladderShow: 7, grouping: -5,
    heat: { style: 'neon', contrast: 999, smooth: 'sometimes', auto: 'no' }, lt: { halfLifeBp: 'x', view: 'radar' }, barStats: ['vol', 3, null], barStatOptions: { imbRatio: Infinity, extra: 1 }, scope: 'futures', pullStack: 30 } as never);
  assert.equal(junk.timeframe, '1h');
  assert.equal(junk.layer, 'liquidity');
  assert.equal(junk.show.depth, defaults.show.depth);
  assert.equal(junk.show.oi, false, 'a valid field of a partly broken object is kept');
  assert.ok(!('evil' in junk.show));
  assert.deepEqual([junk.ladderMode, junk.ladderShow, junk.grouping, junk.scope, junk.pullStack], ['aggregated', 'both', 'auto', 'all', 0]);
  assert.deepEqual(junk.heat, { style: 'bookmap', auto: true, contrast: 100, smooth: 'auto' });
  assert.equal(junk.lt.view, 'lines');
  assert.equal(junk.lt.halfLifeBp, defaults.lt.halfLifeBp);
  assert.deepEqual(junk.barStats, ['vol']);
  assert.equal(junk.barStatOptions.imbRatio, defaults.barStatOptions.imbRatio);
  assert.ok(!('extra' in junk.barStatOptions));
});

test('names: trimmed, at most 40 characters, the same name (any case) replaces, at most 20 layouts', () => {
  assert.equal(cleanName('  my   scalping  '), 'my scalping');
  assert.equal(cleanName('   '), null);
  assert.equal(cleanName('x'.repeat(60))?.length, 40);
  const list = [layout('A'), layout('B')];
  const replaced = upsert(list, { ...layout('a'), savedAt: 9 })!;
  assert.deepEqual(replaced.map(l => [l.name, l.savedAt]), [['a', 9], ['B', 1]], 'in its place');
  const full = Array.from({ length: MAX_LAYOUTS }, (_, i) => layout(`L${i}`));
  assert.equal(upsert(full, layout('new')), null);
  assert.ok(upsert(full, layout('L3')), 'replacing still works when full');
});

test('export and import: the same layouts back, a stranger\'s file refused, a full list counted', () => {
  const list = [layout('Scalp', settingsOf(state({ timeframe: '1m' }))), layout('Swing', settingsOf(state({ timeframe: '4h' })))];
  const back = importFile(exportFile(list));
  assert.ok('layouts' in back);
  assert.deepEqual(back.layouts, list);
  assert.deepEqual(importFile('{"layouts": []}'), { error: 'not-layouts' });
  assert.deepEqual(importFile('not json'), { error: 'not-layouts' });
  assert.deepEqual(importFile(JSON.stringify({ format: 'liquiditymapperfast-layouts', version: 1, layouts: [{ name: 'x', panes: PANES }] })), { error: 'empty' }, 'no settings: not a layout');
  const full = Array.from({ length: MAX_LAYOUTS - 1 }, (_, i) => layout(`L${i}`));
  const merged = mergeLayouts(full, [layout('L0'), layout('new1'), layout('new2')]);
  assert.deepEqual([merged.added, merged.replaced, merged.skipped, merged.list.length], [1, 1, 1, MAX_LAYOUTS]);
});

test('pane order: the saved one, a pane added since after it; sizes within reason', () => {
  assert.deepEqual(mergeOrder(['bars', 'oi', 'gone', 'oi'], ['oi', 'depth', 'bars', 'delta']), ['bars', 'oi', 'depth', 'delta']);
  assert.deepEqual(readArrangement({ order: ['oi', 7], heights: { oi: 10, depth: 'x', delta: 1e9 }, sideW: 300, flowW: 250 }), { order: ['oi'], heights: { oi: 40, delta: 4_000 }, sideW: 300, flowW: 250 });
  assert.equal(readArrangement({ order: [], heights: {}, sideW: 'wide', flowW: 250 }), null);
  // The map has no fixed height and nothing moves it: it keeps its place whatever the saved order says, or leaves out.
  const known = [{ id: 'heat', fixed: false }, { id: 'oi', fixed: true }, { id: 'depth', fixed: true }, { id: 'delta', fixed: true }];
  assert.deepEqual(arrangeOrder(['delta', 'oi', 'depth'], known), ['heat', 'delta', 'oi', 'depth']);
  assert.deepEqual(arrangeOrder(['depth', 'heat', 'oi'], known), ['heat', 'depth', 'oi', 'delta']);
  // Two 330 px panes from a 1313 px window in a 709 px column: the map keeps 30 % (213 px) and the panes share the rest.
  assert.deepEqual(fitHeights([330, 330], [60, 60], 709), [248, 248]);
  assert.deepEqual(fitHeights([330, 330], [60, 60], 697, 240), [228, 228], "the map's own minimum (240 px in CSS) when it is more than the share");
  assert.deepEqual(fitHeights([150, 120], [60, 60], 1100), [150, 120], 'room enough: as they were');
  assert.deepEqual(fitHeights([400, 400], [300, 60], 500), [300, 170], 'never below its own minimum');
});
