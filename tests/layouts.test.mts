import test from 'node:test';
import assert from 'node:assert/strict';
import { TIMEFRAMES } from '../src/app/hub.ts';
import { LAYOUT_KEYS, TIMEFRAME_IDS, readSettings, type AppState } from '../src/app/store.ts';
import { MAX_FILE_CHARS, MAX_LAYOUTS, MAX_NAME, PANE_SWITCHES, arrangeOrder, carriedSettings, changedSettings, cleanName, completeSettings, copyName, fitHeights, exportFile, importFile, mergeLayouts, mergeOrder, paneSettings, readArrangement, readLayouts, samePanes, settingsOf, settingsToApply, undoPatch, upsert, type SavedLayout } from '../src/app/layouts/layouts.ts';

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
  const junk = readSettings({ timeframe: '2h', layer: 'gamma', show: { depth: 'yes', oi: false, evil: true }, ladderMode: 'tiles', ladderCurves: 4, ladderShow: 7, grouping: -5,
    heat: { style: 'neon', contrast: 999, smooth: 'sometimes', auto: 'no' }, lt: { halfLifeBp: 'x', view: 'radar' }, barStats: ['vol', 3, null], barStatOptions: { imbRatio: Infinity, extra: 1 }, scope: 'futures', pullStack: 30 } as never);
  assert.equal(junk.timeframe, '1h');
  assert.equal(junk.layer, 'liquidity');
  assert.equal(junk.show.depth, defaults.show.depth);
  assert.equal(junk.show.oi, false, 'a valid field of a partly broken object is kept');
  assert.ok(!('evil' in junk.show));
  assert.deepEqual([junk.ladderMode, junk.ladderCurves, junk.ladderShow, junk.grouping, junk.scope, junk.pullStack], ['compact', 5, 'both', 'auto', 'all', 0]);
  assert.deepEqual(junk.heat, { style: 'size', auto: true, contrast: 100, smooth: 'auto' });
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
  assert.deepEqual(importFile(' '.repeat(MAX_FILE_CHARS + 1)), { error: 'not-layouts' }, 'far larger than any layouts file');
  const odd = importFile(JSON.stringify({ format: 'liquiditymapperfast-layouts', version: 1, layouts: [{ name: 'x', panes: PANES, settings: { timeframe: '2h', junk: 'x'.repeat(1000) } }] }));
  assert.ok('layouts' in odd);
  assert.equal(odd.layouts[0]!.settings.timeframe, '1h', 'kept as it will be applied');
  assert.ok(!('junk' in odd.layouts[0]!.settings), 'nothing else kept or written back');
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
  assert.deepEqual(fitHeights([400, 400], [300, 60], 500), [300, 60], 'never below its own minimum: a pane held at it, the other takes what is left (here less than its own, as nothing fits)');
  // Six panes in a column of 644 px under a map that keeps 240: they add up to the room, not to a few pixels more.
  const six = fitHeights([108, 132, 150, 150, 120, 128], [56, 70, 60, 60, 60, 70], 644, 240);
  assert.ok(six.reduce((a, b) => a + b, 0) <= 404, String(six));
  assert.ok(six.every((h, i) => h >= [56, 70, 60, 60, 60, 70][i]!));
  // Whatever the room, the panes never add up to more than it unless their minimums alone do.
  for (const avail of [500, 640, 700, 900, 1200]) for (const want of [[300, 300, 300], [84, 132, 150, 150, 120, 128, 220]]) {
    const mins = want.map(() => 60), got = fitHeights(want, mins, avail, 240), room = avail - Math.max(240, avail * 0.3);
    assert.ok(got.reduce((a, b) => a + b, 0) <= Math.max(room, 60 * want.length) + 1, `${avail} ${want}: ${got}`);
  }
});

test('applying a layout sets only what differs, so the same timeframe does not reload the chart', () => {
  const now = state({ timeframe: '15m' });
  assert.deepEqual(changedSettings(settingsToApply(settingsOf(now), now), now), {});
  const next = settingsToApply(settingsOf(state({ timeframe: '15m', ladderMode: 'single' })), now);
  assert.deepEqual(Object.keys(changedSettings(next, now)), ['ladderMode']);
});

test('the Bar stats table keeps showing for a save from before its own switch where the footprint was on, and an explicit choice stands', () => {
  assert.equal(readSettings({ show: { footprint: true } }).show.stats, true, 'it showed with the footprint');
  assert.equal(readSettings({ show: { footprint: false } }).show.stats, false);
  assert.equal(readSettings({ show: { footprint: true, stats: false } }).show.stats, false, 'switched off on its own since');
  assert.equal(readSettings({ show: { footprint: false, stats: true } }).show.stats, true, 'on without the footprint');
  assert.equal(readSettings({}).show.stats, false, 'a first visit starts without it');
});

test('a copy of a layout gets a name that is free however long the name is, and the search always ends (review 2026-10-31: 34 to 40 characters hung the page)', () => {
  const wording = (shown: string): string => `${shown} copy`;
  for (const length of [1, 10, 30, 33, 34, 35, 36, 38, 39, 40]) {
    const name = 'N'.repeat(length), taken = new Set<string>([name.toLowerCase()]);
    // Copy again and again, the copies copied too: every name is new, at most 40 characters, and the ending is kept.
    for (let i = 0; i < MAX_LAYOUTS - 1; i++) {
      const copy = copyName(i % 3 === 2 ? [...taken].at(-1)!.toUpperCase() : name, wording, c => taken.has(c.toLowerCase()));
      assert.ok(copy !== null, `${length} characters, copy ${i + 1}`);
      assert.ok(copy.length <= MAX_NAME && !taken.has(copy.toLowerCase()), `${length}: "${copy}"`);
      assert.ok(/ copy( \d+)?$/.test(copy), `the ending is kept: "${copy}"`);
      taken.add(copy.toLowerCase());
    }
  }
  assert.equal(copyName('Mine', wording, () => false), 'Mine copy');
  assert.equal(copyName('Mine', wording, c => c === 'Mine copy'), 'Mine copy 2');
  assert.equal(copyName('Mine', wording, () => true), null, 'nothing free: null, not a loop');
});

test('a layout that keeps the panes alone carries which panes are open and nothing else; applying it leaves the footprint, the volume profile and the rest as they are', () => {
  const now = state({ show: { ...defaults.show, footprint: true, traded: true, bubbles: false, cvd: true, book: true, oi: false, script: true } });
  const saved = paneSettings(now);
  assert.deepEqual(Object.keys(saved.show!).sort(), [...PANE_SWITCHES].sort());
  assert.ok(!('script' in saved.show!) && !('footprint' in saved.show!));
  // Read back from storage or a file, it still names only those switches.
  const [read] = readLayouts([{ ...layout('Panes', saved), panes: PANES }]);
  assert.deepEqual(Object.keys(read!.settings.show!).sort(), [...PANE_SWITCHES].sort());
  // Applied on a chart that has changed since: the panes open or close, every other switch stays as it is.
  const later = state({ show: { ...defaults.show, footprint: false, traded: false, bubbles: true, cvd: false, book: false, oi: true, script: false } });
  const applied = settingsToApply(read!.settings, later).show;
  assert.equal(applied.cvd, true); assert.equal(applied.book, true); assert.equal(applied.oi, false);
  assert.equal(applied.footprint, false, 'the footprint is the chart\'s, not the panes\''); assert.equal(applied.traded, false); assert.equal(applied.bubbles, true); assert.equal(applied.script, false);
  // A layout saved with the chart's settings still carries every switch.
  assert.deepEqual(Object.keys(carriedSettings(settingsOf(now)).show!).sort(), Object.keys(defaults.show).sort());
});

test('a layout from before the Bar stats switch, or the measure strip, still turns them on where the footprint or the strip was', () => {
  assert.equal(carriedSettings({ show: { footprint: true } as never }).show!.stats, true);
  assert.equal(carriedSettings({ show: { footprint: true, stats: false } as never }).show!.stats, false);
  const strip = carriedSettings({ show: { depth: true } as never, measureStrip: { on: true } } as never);
  assert.equal(strip.show!.traded, true, 'the strip is the Volume profile along the top now');
  assert.ok(!('oi' in strip.show!), 'a switch the layout never named is left alone');
});

test('a date a file holds that no clock can show becomes none; a date that can be shown is kept', () => {
  const entry = (savedAt: unknown) => ({ ...layout('A'), savedAt });
  const [kept] = readLayouts([entry(1_761_900_000_000)]), [far] = readLayouts([entry(8.64e15)]), [negative] = readLayouts([entry(-5)]), [text] = readLayouts([entry('yesterday')]);
  assert.equal(kept!.savedAt, 1_761_900_000_000);
  assert.deepEqual([far!.savedAt, negative!.savedAt, text!.savedAt], [0, 0, 0]);
  assert.doesNotThrow(() => new Intl.DateTimeFormat('de', { timeZone: 'UTC' }).format(new Date(readLayouts([entry(32_503_679_999_999)])[0]!.savedAt)));
});

test('Undo puts back what an action changed and what still stands as it left it, and nothing the person did since', () => {
  const before = settingsOf(state({ timeframe: '15m', ladderMode: 'compact', heat: { style: 'size', auto: true, contrast: 90, smooth: 'auto' }, show: { ...defaults.show, oi: false, footprint: false, cvd: true } }));
  const after = settingsOf(state({ timeframe: '4h', ladderMode: 'single', heat: { style: 'size', auto: true, contrast: 50, smooth: 'auto' }, show: { ...defaults.show, oi: true, footprint: false, cvd: false } }));
  // Straight away: everything the action changed goes back, including the settings a saved layout carries.
  const all = undoPatch(before, after, after);
  assert.equal(all.timeframe, '15m'); assert.equal(all.ladderMode, 'compact'); assert.equal(all.heat!.contrast, 90);
  assert.equal(all.show!.oi, false); assert.equal(all.show!.cvd, true);
  assert.ok(!('layer' in all) && !('scope' in all), 'what the action did not change is not set');
  // The person went on working: the footprint switched on, the timeframe changed again, the Flow column opened by hand.
  const since = { ...after, timeframe: '1d', show: { ...after.show!, footprint: true, cvd: true } };
  const part = undoPatch(before, after, since);
  assert.ok(!('timeframe' in part), 'the timeframe is the person\'s now');
  assert.equal(part.show!.footprint, true, 'the footprint they switched on stays on');
  assert.equal(part.show!.cvd, true); assert.equal(part.show!.oi, false, 'the switch the action changed and nobody touched goes back');
  assert.equal(part.ladderMode, 'compact');
  // Hiding a pane: the pane comes back and a switch flipped in the next seconds stays.
  const hid = { ...before, show: { ...before.show!, book: false } };
  const next = { ...hid, show: { ...hid.show!, footprint: true } };
  assert.deepEqual(undoPatch(before, hid, next).show, { ...next.show, book: before.show!.book });
  assert.deepEqual(undoPatch(before, before, before), {}, 'an action that changed nothing puts nothing back');
});

test('Undo keeps this chart\'s VWAP anchors and the profile\'s zone: a snapshot has neither, so a patch never writes them back as missing', () => {
  const mine = state({ vwap: { ...defaults.vwap, on: true, bands: 2, anchors: { BTC: [1, 2], ETH: [7] } }, traded: { ...defaults.traded, count: 3, zone: 'Asia/Tokyo' } });
  const before = settingsOf(mine);
  // A saved layout applied: bands and the profile's count changed, the anchors and the zone are the chart's own.
  const applied = state({ ...mine, vwap: { ...mine.vwap, bands: 0 }, traded: { ...mine.traded, count: 9 } });
  const patch = undoPatch(before, settingsOf(applied), settingsOf(applied));
  assert.ok(!('anchors' in patch.vwap!) && !('zone' in patch.traded!), 'the bare patch is incomplete, which is why the store must not be given it');
  const whole = completeSettings(patch, applied);
  assert.equal(whole.vwap!.bands, 2);
  assert.deepEqual(whole.vwap!.anchors, { BTC: [1, 2], ETH: [7] }, 'the anchors stand');
  assert.equal(whole.traded!.count, 3);
  assert.equal(whole.traded!.zone, 'Asia/Tokyo', 'the zone stands');
  // Anchors drawn and a zone chosen since the action are kept, not the ones the snapshot never had.
  const drawn = state({ ...applied, vwap: { ...applied.vwap, anchors: { BTC: [1, 2, 3] } }, traded: { ...applied.traded, zone: 'UTC' } });
  const later = completeSettings(undoPatch(before, settingsOf(applied), settingsOf(drawn)), drawn);
  assert.deepEqual(later.vwap!.anchors, { BTC: [1, 2, 3] });
  assert.equal(later.traded!.zone, 'UTC');
  assert.deepEqual(completeSettings({ timeframe: '4h' }, applied), { timeframe: '4h' }, 'a patch that names neither is left as it is');
});

test('two arrangements are the same when the order, the heights and the places match within a few pixels', () => {
  const dock = (patch: object = {}) => ({ left: ['cvd'], right: ['book'], leftW: 280, rightW: 400, weights: {}, ...patch });
  const a = { order: ['heat', 'oi'], heights: { oi: 150 }, sideW: 400, flowW: 280, dock: dock() } as never;
  const nudged = { order: ['heat', 'oi'], heights: { oi: 154 }, sideW: 401, flowW: 281, dock: dock({ leftW: 284 }) } as never;
  assert.ok(samePanes(a, nudged));
  assert.ok(!samePanes(a, { ...(nudged as object), heights: { oi: 190 } } as never), 'a pane resized');
  assert.ok(!samePanes(a, { ...(nudged as object), order: ['oi', 'heat'] } as never), 'a pane moved');
  assert.ok(!samePanes(a, { ...(nudged as object), dock: dock({ left: ['book'], right: ['cvd'] }) } as never), 'the sides swapped');
});
