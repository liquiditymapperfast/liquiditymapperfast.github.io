import test from 'node:test';
import { TRADED_DEFAULTS, type TradedSettings } from '../src/app/traded/settings.ts';
import assert from 'node:assert/strict';
import { readTraded } from '../src/app/traded/settings.ts';
import { Store, initialState, readSettings, type AppState } from '../src/app/store.ts';
import { readLayouts, settingsOf, settingsToApply } from '../src/app/layouts/layouts.ts';
import { PLACEMENTS, defaultSet, instanceId, lineMetric, placedOn, readProfileSet, setFromLegacy, setPlaced, withTopOn, type ProfileInstance, type ProfilePlacement, type ProfileSet } from '../src/app/traded/profiles.ts';
import { MAX_BANDS, arrangeProfiles, arrangeSides, columnHit, type ProfileRoom } from '../src/app/traded/arrange.ts';
import { MEASURES, PROFILE_METRICS, type ProfileMetric } from '../src/app/measures/registry.ts';
import { NO_FLAGS, type BandHub } from '../src/app/measures/measure.ts';
import { BANDS_SHARE, STACK_GAP, stackedBands, stripBand } from '../src/app/measures/model.ts';
import { TopBands, type TopPlace } from '../src/app/measures/strip.ts';
import { FlowBook } from '../src/app/flow-book.ts';
import { Hub } from '../src/app/hub.ts';
import { PALETTES } from '../src/app/theme.ts';
import { View } from '../src/app/view.ts';
import { AXIS_W, PROFILE_STRIP_W, PROFILE_W, TRADED_W, gutter, leftGutter, priceQuestions, profileColumnW, setCompactGutters, sideColumns } from '../src/app/panes/heat-pane.ts';
import type { ProfileAnswer } from '../src/shared/footprint.ts';
import type { AbsorptionProfileAnswer } from '../src/shared/absorption.ts';

const MIN = 60_000, T0 = Date.UTC(2026, 9, 20, 12);

/** A set from (measure, place, on) triples, each made as the panel's grid makes it. */
function setOf(...cells: [ProfileMetric, ProfilePlacement, boolean?][]): ProfileSet {
  let set: ProfileSet = { version: 1, instances: [] };
  for (const [m, p, on] of cells) set = setPlaced(set, m, p, on ?? true);
  return set;
}
const ids = (list: readonly ProfileInstance[]): string[] => list.map(p => p.id);
const room = (o: Partial<ProfileRoom> = {}): ProfileRoom => ({ sides: 8, maxBands: MAX_BANDS, band: { legendBottom: 42, toolsBottom: 37, ph: 800, volume: true }, ...o });

test('an older save becomes places: each of its columns right of the map, its profile along the top as it was, off where it was off', () => {
  const old = readTraded({ metrics: ['absorption', 'volume'], top: { on: false, metric: 'oi' } }).placements;
  assert.deepEqual(old.instances.map(p => [p.id, p.enabled, p.order]), [['volume:right', true, 0], ['absorption:right', true, 2], ['oi:top', false, 1]]);
  assert.deepEqual(old.instances[0], { id: 'volume:right', enabled: true, metric: 'volume', placement: 'right', order: 0, window: { kind: 'chart' }, sizePx: null, overrides: {} });
  assert.deepEqual(ids(placedOn(readTraded({ metric: 'liquidations' }).placements, 'right')), ['liquidations:right'], 'one measure, one column');
  assert.deepEqual(readTraded({}).placements, defaultSet(), 'a first visit: traded volume right of the map, the band along the top kept switched off');
  assert.deepEqual(readTraded(undefined).placements, defaultSet());
  assert.deepEqual(ids(placedOn(defaultSet(), 'right')), ['volume:right']); assert.deepEqual(ids(placedOn(defaultSet(), 'top')), []);
  assert.deepEqual(defaultSet().instances.filter(p => p.placement === 'top').map(p => [p.id, p.enabled]), [['volume:top', false]], 'its Top cell finds it');
  // A save of the measure strip, as a page or a layout carries it.
  const strip = readSettings({ show: { profile: true, traded: false }, measureStrip: { on: true, kind: 'oi' } } as never);
  assert.deepEqual([ids(placedOn(strip.traded.placements, 'top')), strip.show.traded], [['oi:top'], true]);
  // Revision 1 turned the profile along the top on: the instance there is switched on, keeping its measure; none there makes traded volume's.
  assert.deepEqual(ids(placedOn(withTopOn(old), 'top')), ['oi:top']);
  assert.deepEqual(ids(placedOn(withTopOn(setOf(['oi', 'right'])), 'top')), ['volume:top']);
});

test('reading the places is idempotent and keeps every choice, switched off ones with their ids and order; layouts carry them', () => {
  const saves: unknown[] = [{}, { metrics: ['oi', 'liquidations'], top: { on: false, metric: 'absorption' } }, { metric: 'absorption' },
    { placements: setOf(['absorption', 'left'], ['oi', 'top'], ['volume', 'right'], ['volume', 'right', false]) }, { placements: { version: 1, instances: [] } }];
  for (const saved of saves) {
    const once = readTraded(saved), twice = readTraded(JSON.parse(JSON.stringify(once)) as unknown);
    assert.deepEqual(twice, once, `read twice: ${JSON.stringify(saved)}`);
  }
  const chosen = readTraded({ placements: setOf(['absorption', 'left'], ['volume', 'right'], ['volume', 'right', false]) }).placements;
  assert.deepEqual(chosen.instances.map(p => [p.id, p.enabled]), [['absorption:left', true], ['volume:right', false]], 'a switch turned off stays off');
  assert.deepEqual(readTraded({ placements: { version: 1, instances: [] } }).placements.instances, [], 'none placed, once chosen, stays none');
  // A saved layout, read from a file and applied, and one written before the places.
  const placements = setOf(['volume', 'left'], ['liquidations', 'top']);
  const [layout] = readLayouts([{ name: 'Left', panes: { order: [], heights: {}, sideW: 420, flowW: 300 }, settings: { traded: { placements } } }]);
  assert.deepEqual(layout!.settings.traded!.placements, placements);
  const applied = settingsToApply({ traded: { placements } } as never, { vwap: { anchors: {} }, traded: { zone: 'UTC' } } as unknown as AppState);
  assert.deepEqual(applied.traded.placements, placements);
  const [older] = readLayouts([{ name: 'Old', panes: { order: [], heights: {}, sideW: 420, flowW: 300 }, settings: { traded: { metrics: ['oi'], top: { on: true, metric: 'liquidations' } } } }]);
  assert.deepEqual(older!.settings.traded!.placements.instances.map(p => p.id), ['oi:right', 'liquidations:top']);
  // A layout written from a state reads back as that state's places.
  const state = { ...initialState(), traded: { ...initialState().traded, placements } };
  assert.deepEqual(readSettings(settingsOf(state) as never).traded.placements, placements);
});

test('a stored set is read instance by instance: one per measure and place, the chart window, the page\'s size, the shared look', () => {
  const read = readProfileSet({ instances: [
    { id: 'volume:right', metric: 'volume', placement: 'right', order: 0, enabled: true },
    { id: 'again', metric: 'volume', placement: 'right', order: 5 },
    { id: 'w', metric: 'whales', placement: 'right' }, { id: 'b', metric: 'oi', placement: 'bottom' },
    { id: '<script>', metric: 'oi', placement: 'top', order: 1, window: { kind: 'day' }, sizePx: 300, overrides: { bars: 'delta' } },
    { id: 'volume:right', metric: 'absorption', placement: 'left', order: 'x', enabled: 'no' },
  ] })!;
  assert.deepEqual(read.instances.map(p => [p.id, p.metric, p.placement, p.order, p.enabled]), [['volume:right', 'volume', 'right', 0, true], ['oi:top', 'oi', 'top', 1, true], ['absorption:left', 'absorption', 'left', 2, true]],
    'a second volume column, an unknown measure and an unknown place are dropped; a bad or repeated id becomes the instance\'s own, a bad order its place in the registry');
  assert.deepEqual([read.instances[1]!.window, read.instances[1]!.sizePx, read.instances[1]!.overrides], [{ kind: 'chart' }, null, {}], 'version 1 offers no other window, size or look');
  assert.equal(readProfileSet(null), null); assert.equal(readProfileSet({ instances: 'all' }), null);
  // Ids are given once: switched off and on again, an instance keeps its id and order.
  const off = setPlaced(setOf(['oi', 'left']), 'oi', 'left', false), on = setPlaced(off, 'oi', 'left', true);
  assert.deepEqual(off.instances.map(p => [p.id, p.enabled, p.order]), [['oi:left', false, 1]]);
  assert.deepEqual(on.instances, setOf(['oi', 'left']).instances);
  assert.equal(instanceId('liquidations', 'top'), 'liquidations:top');
});

test('the registry: every measure is one registration, and each can be drawn in every place', () => {
  assert.deepEqual(PROFILE_METRICS, ['volume', 'oi', 'absorption', 'liquidations']);
  assert.deepEqual(MEASURES.map(m => m.id), PROFILE_METRICS);
  const thresholds = new Map<string, number | null>([['binance:BTCUSDT', 100_000], ['coinbase:BTC-USD', null]]);
  for (const m of MEASURES) {
    for (const text of [m.name(), m.short(), m.tip(), m.words().buy, m.words().sell, m.words().none, m.stretchNone(), m.timeNote(), m.header(null, NO_FLAGS).head]) assert.ok(text.length > 0, `${m.id}: a word is missing`);
    assert.equal(m.unit, 'usd');
    assert.equal(typeof m.byTime.worker().work, 'function');
    assert.ok(Array.isArray(m.byPrice.instruments(['binance:BTCUSDT', 'coinbase:BTC-USD'], thresholds)));
    for (const p of PLACEMENTS) {
      const set = setOf([m.id, p]), placed = arrangeProfiles(set, room());
      const where = p === 'top' ? placed.top.map(b => b.instance) : placed[p];
      assert.deepEqual(ids(where), [`${m.id}:${p}`], `${m.id} ${p}`);
      assert.deepEqual(placed.hidden, []);
    }
  }
  // What each measure is asked on: open interest on perpetuals with it, absorption on the instruments with a threshold.
  assert.deepEqual(MEASURES[2].byPrice.instruments(['binance:BTCUSDT', 'coinbase:BTC-USD'], thresholds), ['binance:BTCUSDT']);
  assert.equal(MEASURES[2].byPrice.keyOf('binance:BTCUSDT', thresholds), 'binance:BTCUSDT:100000', 'a new threshold is a new question');
  assert.deepEqual(MEASURES.filter(m => m.judgedByMarks).map(m => m.id), ['absorption']);
  assert.deepEqual(MEASURES.filter(m => m.rangeAddsUp).map(m => m.id), ['volume']);
});

test('the lines across the chart: traded volume wherever it is drawn by price, else the first measure by price, never the room on screen', () => {
  assert.equal(lineMetric(setOf(['absorption', 'right'], ['volume', 'left'])), 'volume', 'traded volume on the left counts');
  assert.equal(lineMetric(setOf(['liquidations', 'right'], ['oi', 'left'])), 'oi', 'the first by order, whichever side');
  assert.equal(lineMetric(setOf(['absorption', 'right'], ['absorption', 'left'])), 'absorption');
  assert.equal(lineMetric(setOf(['oi', 'top'], ['volume', 'right'], ['volume', 'right', false])), 'volume', 'nothing by price: traded volume, asked for the lines alone');
  assert.equal(lineMetric(setOf(['oi', 'right'], ['volume', 'top'])), 'oi', 'a band along the top does not set the lines');
});

test('the columns on both sides together leave the map half the pane: the nearest stay, the outermost are listed as hidden', () => {
  const four = setOf(['volume', 'right'], ['oi', 'right'], ['absorption', 'left'], ['liquidations', 'left']);
  const at = (fit: number) => { const s = arrangeSides(four, fit); return [ids(s.right), ids(s.left), ids(s.hidden)]; };
  assert.deepEqual(at(4), [['volume:right', 'oi:right'], ['absorption:left', 'liquidations:left'], []]);
  assert.deepEqual(at(3), [['volume:right', 'oi:right'], ['absorption:left'], ['liquidations:left']], 'taken in turns, nearest the map first');
  assert.deepEqual(at(2), [['volume:right'], ['absorption:left'], ['oi:right', 'liquidations:left']]);
  assert.deepEqual(at(0), [[], [], ['volume:right', 'absorption:left', 'oi:right', 'liquidations:left']], 'a phone: no column, each said');
  // The map's own reading of it: three columns fit beside a 1,120 px map (half of it, less the axis and the book profile).
  const state = { show: { traded: true, profile: true }, traded: { placements: four } } as unknown as AppState;
  try {
    setCompactGutters(false, 1120);
    assert.deepEqual([ids(sideColumns(state).right), ids(sideColumns(state).left), ids(sideColumns(state).hidden)], [['volume:right', 'oi:right'], ['absorption:left'], ['liquidations:left']]);
    assert.deepEqual([leftGutter(state), gutter(state)], [TRADED_W, 64 + 128 + 2 * TRADED_W], 'the left columns move the plot, the right ones the axis');
    assert.deepEqual([leftGutter({ ...state, show: { traded: false, profile: true } } as AppState), sideColumns({ ...state, show: { traded: false, profile: true } } as AppState).hidden], [0, []], 'the Volume profile off: nothing drawn and nothing hidden');
    setCompactGutters(true, 400);
    assert.deepEqual([leftGutter(state), sideColumns(state).right.length, sideColumns(state).hidden.length], [0, 0, 4], 'a phone keeps no columns, as before');
  } finally { setCompactGutters(false, 2000); }
});

test('beside the liquidation column a compact map keeps the book profile as a strip; without that column, or on a desktop, it stays whole', () => {
  const base = { show: { traded: false, profile: true }, traded: { placements: setOf() }, liqLevels: { on: true, column: true } } as unknown as AppState;
  const noLiq = { ...base, liqLevels: { on: false, column: true } } as unknown as AppState;
  try {
    setCompactGutters(true, 390);
    assert.equal(profileColumnW(base), PROFILE_STRIP_W);
    // A phone: the axis and two strips, the liquidation levels' and the book's (Karl, 2026-11-01 the book's, 2026-11-03 the levels').
    assert.equal(gutter(base), AXIS_W + 2 * PROFILE_STRIP_W, 'a phone: the axis and the two strips');
    assert.equal(gutter(base), 58 + 32, 'a 390 px map loses 90 px to them, not 158');
    assert.equal(profileColumnW(noLiq), PROFILE_W, 'no liquidation column: the profile keeps its column');
    assert.equal(profileColumnW({ ...base, show: { traded: false, profile: false } } as unknown as AppState), 0);
    setCompactGutters(false, 2000);
    assert.equal(profileColumnW(base), 128);
    assert.equal(gutter(base), 64 + 128 + 128, 'a desktop: both columns whole');
  } finally { setCompactGutters(false, 2000); }
});

test('a measure drawn on both sides is one question by price, and moving its column to the other side asks nothing new', async () => {
  const four = setOf(['volume', 'right'], ['absorption', 'right'], ['absorption', 'left']);
  const plain: TradedSettings = { ...TRADED_DEFAULTS, lines: [], profiles: null };
  const state = { show: { traded: true, profile: true }, traded: { ...plain, placements: four } } as unknown as AppState;
  try { setCompactGutters(false, 2000); assert.deepEqual(priceQuestions(state), ['volume', 'absorption']); } finally { setCompactGutters(false, 2000); }
  const other = (traded: Partial<TradedSettings>): AppState => ({ ...state, traded: { ...plain, placements: setOf(['oi', 'top'], ['liquidations', 'left']), ...traded } }) as unknown as AppState;
  assert.deepEqual(priceQuestions(other({})), ['liquidations'], 'the lines\' measure is the column\'s');
  assert.deepEqual(priceQuestions({ ...other({}), show: { traded: true, profile: true } } as unknown as AppState), ['liquidations']);
  assert.deepEqual(priceQuestions(other({ windowLines: false })), ['liquidations'], 'its column asks for it anyway');
  setCompactGutters(true, 400);
  try {
    assert.deepEqual(priceQuestions(other({ windowLines: false })), [], 'no column, no chart window lines, no periods: nothing');
    assert.deepEqual(priceQuestions(other({ poc: false, va: false })), [], 'the chart window\'s lines switched off in Line contents: nothing');
    assert.deepEqual(priceQuestions(other({ windowLines: false, lines: ['day'] })), ['volume'], 'periods drawn: traded volume says which venues the recording holds');
  } finally { setCompactGutters(false, 2000); }
  class FakeWorker { onmessage: ((event: { data: unknown }) => void) | null = null; postMessage(): void {} }
  (globalThis as { Worker?: unknown }).Worker = FakeWorker;
  const asked: { kind: string; settle: () => void }[] = [];
  const source = {
    profile: (_ids: string[], from: number, to: number) => new Promise<ProfileAnswer>(resolve => { asked.push({ kind: 'volume', settle: () => resolve({ from, to, instruments: [] }) }); }),
    absorptionProfile: (_ids: string[], _t: number[], from: number, to: number) => new Promise<AbsorptionProfileAnswer>(resolve => { asked.push({ kind: 'absorption', settle: () => resolve({ from, to, instruments: [], incomplete: [], cut: [] }) }); }),
  };
  const hub = new Hub(new Store(initialState()), source as never), thresholds = new Map<string, number | null>([['a:BTC', 50_000]]);
  const realNow = Date.now; Date.now = () => T0 + 31 * MIN;
  const turn = (): Promise<void> => new Promise(resolve => setImmediate(resolve));
  try {
    // One frame draws absorption right and left of the map: the page asks once for each measure it draws, and the hub would not ask twice anyway.
    for (const metric of ['volume', 'absorption', 'absorption'] as const) hub.ensureProfile(metric, ['a:BTC'], T0, T0 + 30 * MIN, 5, false, { tag: '', settled: true }, thresholds);
    assert.deepEqual(asked.map(a => a.kind), ['volume', 'absorption']);
    for (const a of asked) a.settle();
    await turn();
    // The column moved from the left to the right: the same question, so nothing is asked.
    hub.ensureProfile('absorption', ['a:BTC'], T0, T0 + 30 * MIN, 5, false, { tag: '', settled: true }, thresholds);
    assert.equal(asked.length, 2);
    assert.deepEqual([hub.profile('volume')?.flags, hub.profile('absorption')?.flags, hub.profileState('absorption')], [{ cut: false, incomplete: false }, { cut: false, incomplete: false }, 'ready']);
  } finally { Date.now = realNow; }
});

test('stacked bands: about 96 px alone, 70 at two, 56 at three, a quarter of the plot at most, fewer where they would be slivers', () => {
  const place = { legendBottom: 42, toolsBottom: 37, ph: 800, volume: true };
  assert.deepEqual(stackedBands(place, 1), [stripBand(place)], 'one band is placed as before');
  assert.deepEqual(stackedBands(place, 2), [{ top: 48, height: 70 }, { top: 48 + 70 + STACK_GAP, height: 70 }]);
  const three = stackedBands(place, 3);
  assert.deepEqual(three.map(b => b.height), [56, 56, 56]);
  assert.ok(three[2]!.top + three[2]!.height - three[0]!.top <= place.ph * BANDS_SHARE);
  assert.deepEqual(stackedBands({ ...place, ph: 500 }, 3).map(b => b.height), [39, 39, 39], 'a shorter chart: shorter bands');
  assert.deepEqual(stackedBands({ ...place, ph: 400 }, 3).map(b => b.height), [48, 48], 'three would be slivers: two');
  assert.deepEqual(stackedBands({ ...place, ph: 60 }, 3), [], 'no room for one');
  // One band alone keeps to the quarter too: a 36 px band on a 120 px plot would take 30 %, and a 30 px one is a sliver.
  assert.deepEqual(stackedBands({ ...place, ph: 120, volume: false }, 1), [], 'one band on a tiny plot: none');
  for (const ph of [160, 200, 300]) { const one = stackedBands({ ...place, ph, volume: false }, 1)[0]; if (one) assert.ok(one.height <= ph * BANDS_SHARE, `one band, a quarter at most at ${ph}`); }
  for (const ph of [300, 450, 700, 1000, 1400]) for (const n of [2, 3]) {
    const bands = stackedBands({ ...place, ph }, n), last = bands[bands.length - 1];
    if (bands.length > 1) assert.ok(last!.top + last!.height - bands[0]!.top <= ph * BANDS_SHARE + 1, `a quarter at most at ${ph}`);
    if (last) assert.ok(last.top + last.height <= ph - Math.max(34, Math.min(ph * 0.17, 150)) - 6, `clear of the volume strip at ${ph}`);
  }
  // Which instance goes in which band: the first by order lowest, nearest the chart; past three, the outermost are hidden.
  const all = setOf(['volume', 'top'], ['oi', 'top'], ['absorption', 'top'], ['liquidations', 'top']);
  const placed = arrangeProfiles(all, room());
  assert.deepEqual(placed.top.map(b => b.instance.id), ['absorption:top', 'oi:top', 'volume:top'], 'from the top edge down');
  assert.deepEqual(ids(placed.hidden), ['liquidations:top']);
  assert.ok(placed.top[0]!.top < placed.top[1]!.top && placed.top[1]!.top < placed.top[2]!.top);
  assert.deepEqual(arrangeProfiles(all, room({ maxBands: 1 })).top.map(b => b.instance.id), ['volume:top'], 'a phone draws its first band, as before');
  assert.deepEqual(arrangeProfiles(all, room({ band: { legendBottom: 42, toolsBottom: 37, ph: 400, volume: true } })).hidden.map(p => p.id), ['absorption:top', 'liquidations:top'], 'a short chart: two bands, two said hidden');
});

test('the mirrored hit test: a column right of the map counts from its left edge, one left of it from the map\'s edge outward', () => {
  const at = (x: number): string => { const hit = columnHit(x, 500, 2, 2, 96); return hit ? `${hit.side}${hit.i}` : '-'; };
  assert.deepEqual([500, 501, 596, 597, 692, 693].map(at), ['-', 'right0', 'right0', 'right1', 'right1', '-']);
  assert.deepEqual([0, -0.5, -95.5, -96.5, -192, -193].map(at), ['-', 'left0', 'left0', 'left1', 'left1', '-'], 'negative x is left of the plot');
  assert.equal(columnHit(-5, 500, 2, 0, 96), null, 'no column on the left');
  assert.equal(columnHit(520, 500, 2, 2, 0), null, 'a phone: no columns');
});

test('each band answers for itself: its own header opens the settings, its own buckets the box under it', () => {
  const flow = new FlowBook();
  for (let t = T0 - 60 * MIN; t < T0 + 10 * MIN; t += 1000) flow.apply([['binance:BTCUSDT', t, 3, 1, 100]]);
  const hub: BandHub = {
    flow, ensureFlow: async () => {}, ensureFlowMinutes: async () => {}, oiSeries: async () => ({ bars: [] }), source: { liquidations: async () => [] },
    absorption: { marks: () => [], version: 1, cover: { from: -Infinity, to: Infinity }, floorIn: () => undefined }, absorptionCut: new Map(), absorptionState: 'ready',
  };
  const state = { markets: [{ instrumentId: 'binance:BTCUSDT', venue: 'binance', base: 'BTC', quote: 'USDT', marketType: 'perpetual' }], marketId: 'binance:BTCUSDT', disabledVenues: [], scope: 'all', levels: null, bookGone: {},
    hover: null, mark: { price: 100, asOf: 0 }, followLive: false, show: { traded: true, volume: true },
    traded: { ...readTraded({}), placements: setOf(['volume', 'top'], ['liquidations', 'top']) } } as unknown as AppState;
  const ctx = new Proxy({}, { get: (_t, key) => key === 'measureText' ? (text: string) => ({ width: text.length * 6 }) : () => {}, set: () => true }) as unknown as CanvasRenderingContext2D;
  const place: TopPlace = { view: new View({ t0: T0 - 30 * MIN, t1: T0, p0: 90, p1: 110 }), pw: 1000, ph: 800, palette: PALETTES.light!, legendBottom: 42, window: { from: T0 - 30 * MIN, to: T0 }, absorption: () => ({ thresholds: new Map() }), loaded: () => {} };
  const placed = arrangeProfiles(state.traded.placements, room()), bands = new TopBands();
  const realNow = Date.now; Date.now = () => T0 + 5000;
  try { bands.paint(ctx, state, hub, place, placed.top); } finally { Date.now = realNow; }
  const [upper, lower] = placed.top;
  assert.deepEqual([upper!.instance.metric, lower!.instance.metric], ['liquidations', 'volume']);
  assert.equal(bands.onHeader(4, upper!.top + 4), true); assert.equal(bands.onHeader(4, lower!.top + lower!.height - 2), true);
  assert.equal(bands.onHeader(4, lower!.top + lower!.height + 2), false, 'under the stack: the map');
  assert.equal(bands.onHeader(600, upper!.top + 4), false, 'off the header: the band\'s buckets');
  const box = bands.readout(600, lower!.top + 10, T0 - 10 * MIN)!;
  assert.equal(box.y, lower!.top + lower!.height, 'the box opens under the band it is over');
  assert.ok(box.lines.length > 1);
  assert.equal(bands.readout(600, upper!.top + 10, T0 - 10 * MIN)!.y, upper!.top + upper!.height);
  assert.equal(bands.readout(600, lower!.top + lower!.height + 20, T0 - 10 * MIN), null);
});
