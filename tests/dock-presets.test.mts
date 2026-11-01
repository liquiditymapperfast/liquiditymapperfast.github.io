import test from 'node:test';
import assert from 'node:assert/strict';
import { PRESETS, buildPreset, type PresetEnv } from '../src/app/layouts/presets.ts';
import { MAX_BOTH_SHARE, PANE_SHOW_KEY, STRIP_PANES, readPlan, stripSize, type DockPlan } from '../src/app/layouts/dock-model.ts';
import { readArrangement, settingsToApply, changedSettings } from '../src/app/layouts/layouts.ts';
import { readActive, sameShot, shotOf } from '../src/app/layouts/active.ts';
import { GAP, MAP_MIN, thumbBoxes } from '../src/app/layouts/thumb.ts';
import { defaultShow, readSettings, type AppState } from '../src/app/store.ts';

/** Windows from a small laptop to a large screen: the width, and the height of the map's column (the window less the bars). */
const ENVS: readonly PresetEnv[] = [{ width: 1024, height: 560 }, { width: 1366, height: 560 }, { width: 1500, height: 740 }, { width: 1920, height: 880 }, { width: 2560, height: 1200 }];
const defaults = readSettings({});
const state = (patch: Partial<AppState> = {}): AppState => ({ ...defaults, ...patch } as AppState);

test('the ready-made layouts: six, each named and explained, each id once', () => {
  assert.deepEqual(PRESETS.map(p => p.id), ['default', 'map', 'book', 'flow', 'positioning', 'everything']);
  for (const p of PRESETS) { assert.ok(p.name().length > 0 && p.blurb().length > 20, p.id); assert.ok(p.blurb().endsWith('.'), `${p.id}: a sentence`); }
});

test('each one is read back as it was built, for every window: panes, sizes and columns within reason', () => {
  for (const env of ENVS) for (const def of PRESETS) {
    const { arrangement: a, show } = buildPreset(def, env), where = `${def.id} at ${env.width}x${env.height}`;
    assert.deepEqual(readArrangement(JSON.parse(JSON.stringify(a))), a, `${where}: a layout file would read it back`);
    assert.deepEqual(readPlan(a.dock), a.dock, `${where}: a valid plan`);
    // Every pane stands once in the order, the map first, and the heights are the panes' to keep.
    assert.deepEqual([...a.order].sort(), ['heat', ...STRIP_PANES.map(p => p.id)].sort(), where);
    assert.equal(a.order[0], 'heat', where);
    for (const [id, h] of Object.entries(a.heights)) assert.ok(h >= stripSize(id as never).min && h <= 360 || h === stripSize(id as never).height, `${where}: ${id} is ${h}`);
    assert.equal('bars' in a.heights, false, `${where}: the Bar stats table is as tall as its rows need`);
    // The columns leave the map its share.
    const both = show.cvd && show.book;
    if (both && a.dock!.leftW !== null && a.dock!.rightW !== null) assert.ok(a.dock!.leftW + a.dock!.rightW <= env.width * MAX_BOTH_SHARE, where);
    // Only pane switches (and the few chart switches) are set: every key is one the page has.
    for (const key of Object.keys(show)) assert.ok(key in defaultShow(env.width), `${where}: ${key}`);
    assert.equal('script' in show, false, `${where}: the Scripts pane is the person's own`);
  }
});

test('which panes each one opens', () => {
  const at = (id: string, env = ENVS[2]!) => buildPreset(PRESETS.find(p => p.id === id)!, env).show;
  assert.deepEqual([at('map').cvd, at('map').book, at('map').depth, at('map').oi, at('map').stats], [false, false, false, false, false]);
  assert.deepEqual([at('book').book, at('book').cvd, at('book').depth, at('book').lt, at('book').oi], [true, false, true, true, false]);
  assert.deepEqual([at('flow').cvd, at('flow').book, at('flow').delta, at('flow').stats, at('flow').footprint], [true, false, true, true, true]);
  assert.deepEqual([at('positioning').oi, at('positioning').ls, at('positioning').delta, at('positioning').cvd, at('positioning').book], [true, true, true, false, false]);
  const all = at('everything');
  assert.deepEqual(['cvd', 'book', 'stats', 'depth', 'oi', 'delta', 'ls', 'lt'].map(k => all[k as keyof typeof all]), Array(8).fill(true));
  // The first visit's own rule for the flow column: off where the window is medium.
  assert.equal(at('default', ENVS[1]!).cvd, false, 'a 1,366 px window starts with the book only');
  assert.equal(at('default', ENVS[3]!).cvd, true);
  assert.equal(at('default').depth, false, 'no pane under the map');
});

test('a ready-made layout never touches a setting that is not a pane switch', () => {
  const now = state({ timeframe: '15m', ladderMode: 'single', heat: { ...defaults.heat, contrast: 80 }, barStats: ['vol'] });
  for (const def of PRESETS) {
    const { show } = buildPreset(def, ENVS[2]!);
    const next = settingsToApply({ show: { ...now.show, ...show } }, now);
    const changed = Object.keys(changedSettings(next, now));
    assert.ok(changed.every(k => k === 'show'), `${def.id} changed ${changed.join()}`);
    assert.equal(next.timeframe, '15m'); assert.equal(next.ladderMode, 'single'); assert.equal(next.heat.contrast, 80); assert.deepEqual(next.barStats, ['vol']);
  }
});

test('a layout opens as many panes under the map as the window has room for: the map keeps its own minimum, nothing is pushed off', () => {
  for (const env of ENVS) for (const def of PRESETS) {
    const { arrangement: a, show } = buildPreset(def, env);
    const open = STRIP_PANES.filter(p => p.id !== 'script' && show[PANE_SHOW_KEY[p.id]!]), need = open.reduce((sum, p) => sum + p.min + 5, open.length ? 240 : 0);
    assert.ok(need <= env.height, `${def.id} at ${env.width}x${env.height}: needs ${need}`);
    assert.deepEqual(a.order.filter(id => id !== 'heat' && open.some(p => p.id === id)), def.strip.map(([id]) => id as string).filter(id => open.some(p => p.id === id)), `${def.id}: the panes it opens, in the order it lists them`);
    assert.ok(open.length === def.strip.length || def.strip.slice(0, open.length).every(([id]) => open.some(p => p.id === id)), `${def.id}: where some wait, the last of its list are the ones`);
  }
  const small = buildPreset(PRESETS.find(d => d.id === 'everything')!, { width: 1024, height: 584 }).show, large = buildPreset(PRESETS.find(d => d.id === 'everything')!, ENVS[3]!).show;
  assert.deepEqual(['bars', 'depth', 'oi', 'delta', 'ls', 'lt'].map(k => k === 'bars' ? small.stats : small[k as 'lt']), [true, true, true, true, true, false], 'a 584 px column has room for five of the six: the last of the list waits');
  assert.equal(large.lt, true);
  // The Scripts pane stays open under any layout (it is the person's own) and takes its room first (review 2026-10-31: five panes were opened beside it in 584 px, which need 636).
  const withScript = buildPreset(PRESETS.find(d => d.id === 'everything')!, { width: 1024, height: 584, held: ['script'] }).show;
  assert.deepEqual(['bars', 'depth', 'oi', 'delta', 'ls', 'lt'].map(k => k === 'bars' ? withScript.stats : withScript[k as 'lt']), [true, true, true, true, false, false], 'one pane fewer, for the Scripts pane that stays');
  for (const env of ENVS) for (const def of PRESETS) {
    const { show } = buildPreset(def, { ...env, held: ['script'] });
    const open = STRIP_PANES.filter(p => p.id !== 'script' && show[PANE_SHOW_KEY[p.id]!]), need = open.reduce((sum, p) => sum + p.min + 5, 240 + stripSize('script').min + 5);
    assert.ok(need <= env.height, `${def.id} at ${env.width}x${env.height} with a script: needs ${need}`);
  }
});

test('the panes under the map take their share of the column, each at least its own minimum, each at most a wall', () => {
  const env = ENVS[3]!;
  for (const def of PRESETS.filter(p => p.strip.length)) {
    const { arrangement: a } = buildPreset(def, env);
    const ids = def.strip.map(([id]) => id).filter(id => id !== 'bars');
    const sum = ids.reduce((s, id) => s + a.heights[id]!, 0);
    assert.ok(sum <= def.stripShare * env.height + ids.length * 70, `${def.id}: ${sum} of ${def.stripShare * env.height}`);
    for (const id of ids) assert.ok(a.heights[id]! >= stripSize(id).min && a.heights[id]! <= 360, `${def.id}: ${id}`);
  }
  // The weights are the proportions: Open interest 1.3, Long/Short 1.
  const p = buildPreset(PRESETS.find(d => d.id === 'positioning')!, { width: 1920, height: 1000 }).arrangement.heights;
  assert.ok(Math.abs(p.oi! / p.ls! - 1.3) < 0.05);
});

test('the same layout in a larger window has larger columns and taller panes, in proportion', () => {
  const book = PRESETS.find(d => d.id === 'book')!;
  const small = buildPreset(book, ENVS[1]!).arrangement.dock!, large = buildPreset(book, ENVS[4]!).arrangement.dock!;
  assert.ok(small.rightW! < large.rightW!);
  assert.ok(small.rightW! >= 350, 'the book is never narrower than its header needs');
  assert.equal(small.leftW, null, 'the flow column follows the window where the layout says nothing');
});

test('what is judged of a layout: panes open, their places, the sizes within a few pixels', () => {
  const { arrangement, show } = buildPreset(PRESETS.find(d => d.id === 'positioning')!, ENVS[3]!);
  const open = { ...defaults.show, ...show };
  const shot = shotOf(arrangement, open);
  assert.equal(sameShot(shot, shotOf(arrangement, open)), true);
  assert.equal(sameShot(shot, shotOf({ ...arrangement, heights: { ...arrangement.heights, oi: arrangement.heights.oi! + 5 } }, open)), true, 'a few pixels');
  assert.equal(sameShot(shot, shotOf({ ...arrangement, heights: { ...arrangement.heights, oi: arrangement.heights.oi! + 30 } }, open)), false);
  assert.equal(sameShot(shot, shotOf(arrangement, { ...open, depth: true })), false, 'a pane opened');
  assert.equal(sameShot(shot, shotOf({ ...arrangement, order: ['heat', 'ls', 'oi', 'delta', 'bars', 'depth', 'lt', 'script'] }, open)), false, 'the order of the open panes');
  assert.equal(sameShot(shot, shotOf({ ...arrangement, order: ['heat', 'oi', 'ls', 'delta', 'lt', 'depth', 'bars', 'script'] }, open)), true, 'the order of closed panes is not on the screen');
  // A closed pane has no place and no width on the screen.
  const swapped = { ...arrangement, dock: { ...arrangement.dock!, left: ['book' as const, 'cvd' as const], right: [], leftW: 500 } };
  assert.equal(sameShot(shot, shotOf(swapped, open)), true, 'both side panes are closed here: where they would stand, and how wide, is not on the screen');
});

test('a column that follows the window is not one dragged to a width; one pane\'s side matters only if it is open', () => {
  const base = buildPreset(PRESETS.find(d => d.id === 'default')!, ENVS[3]!);
  const open = { ...defaults.show, ...base.show };
  const a = shotOf(base.arrangement, open);
  const dragged = shotOf({ ...base.arrangement, dock: { ...base.arrangement.dock!, rightW: 480 } }, open);
  assert.equal(sameShot(a, dragged), false);
  const moved = shotOf({ ...base.arrangement, dock: { ...base.arrangement.dock!, left: ['book'], right: ['cvd'] } }, open);
  assert.equal(sameShot(a, moved), false, 'the book on the other side');
  const closedMoved = shotOf({ ...base.arrangement, dock: { ...base.arrangement.dock!, left: ['book'], right: ['cvd'] } }, { ...open, cvd: false, book: false });
  const closedHome = shotOf(base.arrangement, { ...open, cvd: false, book: false });
  assert.equal(sameShot(closedMoved, closedHome), true, 'both closed: where they would stand is not on the screen');
});

test('two panes stacked in a column divide its height, and the splitter between them dragged is a change (review 2026-10-31)', () => {
  const base = buildPreset(PRESETS.find(d => d.id === 'everything')!, ENVS[4]!);
  const open = { ...defaults.show, ...base.show, cvd: true, book: true };
  const stacked = (weights: DockPlan['weights'], show = open) => shotOf({ ...base.arrangement, dock: { ...base.arrangement.dock!, left: ['cvd', 'book'], right: [], leftW: 400, weights } }, show);
  const even = stacked({});
  assert.equal(sameShot(even, stacked({ cvd: 1, book: 1 })), true, 'a weight of 1 is none');
  assert.equal(sameShot(even, stacked({ cvd: 2, book: 2 })), true, 'the same division');
  assert.equal(sameShot(even, stacked({ cvd: 1.02, book: 1 })), true, 'a pixel or two of the splitter');
  assert.equal(sameShot(even, stacked({ cvd: 3, book: 1 })), false, 'a 75/25 division');
  assert.equal(sameShot(stacked({ cvd: 3, book: 1 }), stacked({ cvd: 3.05, book: 1 })), true);
  // A pane alone in its column has all of it, whatever its weight says.
  const alone = (weights: DockPlan['weights']) => stacked(weights, { ...open, book: false });
  assert.equal(sameShot(alone({}), alone({ cvd: 3 })), true);
});

test('the active layout is read from storage only if it is one', () => {
  const shot = shotOf(buildPreset(PRESETS[0]!, ENVS[2]!).arrangement, defaults.show);
  assert.deepEqual(readActive(JSON.parse(JSON.stringify({ kind: 'preset', id: 'flow', shot })))?.id, 'flow');
  assert.equal(readActive({ kind: 'other', id: 'x', shot }), null);
  assert.equal(readActive({ kind: 'saved', id: 'x' }), null);
  assert.equal(readActive('flow'), null);
});

test('the sketch of a layout: boxes inside the unit square, none over another, the map keeping its share', () => {
  for (const env of ENVS) for (const def of PRESETS) {
    const { arrangement, show } = buildPreset(def, env), boxes = thumbBoxes(arrangement, { ...defaults.show, ...show }, env), where = `${def.id} at ${env.width}`;
    for (const b of boxes) assert.ok(b.x >= -1e-9 && b.y >= -1e-9 && b.x + b.w <= 1 + 1e-9 && b.y + b.h <= 1 + 1e-9 && b.w > 0 && b.h > 0, `${where}: ${b.id} ${JSON.stringify(b)}`);
    for (let i = 0; i < boxes.length; i++) for (let j = i + 1; j < boxes.length; j++) {
      const p = boxes[i]!, q = boxes[j]!, apart = p.x + p.w <= q.x + 1e-9 || q.x + q.w <= p.x + 1e-9 || p.y + p.h <= q.y + 1e-9 || q.y + q.h <= p.y + 1e-9;
      assert.ok(apart, `${where}: ${p.id} over ${q.id}`);
    }
    const map = boxes.find(b => b.kind === 'map')!;
    assert.ok(map.h >= MAP_MIN - 1e-9, where);
    assert.equal(boxes.filter(b => b.kind === 'cvd').length, show.cvd ? 1 : 0, where);
    assert.equal(boxes.filter(b => b.kind === 'book').length, show.book ? 1 : 0, where);
  }
  assert.ok(GAP > 0);
});

test('the sketch puts the columns where the plan does, and a stacked pair shares the column', () => {
  const env = ENVS[3]!, { arrangement, show } = buildPreset(PRESETS.find(d => d.id === 'everything')!, env);
  const boxes = thumbBoxes(arrangement, { ...defaults.show, ...show }, env), cvd = boxes.find(b => b.id === 'cvd')!, book = boxes.find(b => b.id === 'book')!;
  assert.ok(cvd.x === 0 && book.x + book.w > 0.99, 'flow left, book right');
  const swapped = thumbBoxes({ ...arrangement, dock: { ...arrangement.dock!, left: ['book'], right: ['cvd'] } }, { ...defaults.show, ...show }, env);
  assert.equal(swapped.find(b => b.id === 'book')!.x, 0);
  const stacked = thumbBoxes({ ...arrangement, dock: { ...arrangement.dock!, left: ['cvd', 'book'], right: [] } }, { ...defaults.show, ...show }, env);
  const [c, b] = [stacked.find(x => x.id === 'cvd')!, stacked.find(x => x.id === 'book')!];
  assert.ok(c.x === b.x && c.w === b.w && b.y > c.y, 'one over the other, in one column');
  void PANE_SHOW_KEY;
});
