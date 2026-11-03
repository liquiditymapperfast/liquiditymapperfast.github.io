import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { DEFAULTS_REV, DEFAULT_SHOW, LAYOUT_KEYS, defaultShow, initialState, type AppState } from '../src/app/store.ts';
import { COLUMN_SHARE, FLOW_FLOOR_W, FULL_WIDTH, MIN_FLOW_W, MIN_SIDE_W, SIDE_FLOOR_W, defaultColumns } from '../src/app/layouts/layouts.ts';

const saved = (blob: Record<string, unknown> | null, run: () => void): void => {
  const real = (globalThis as { window?: unknown }).window;
  (globalThis as { window?: unknown }).window = { innerWidth: 1600, localStorage: { getItem: () => blob ? JSON.stringify(blob) : null, setItem: () => {} } };
  try { run(); } finally { if (real === undefined) delete (globalThis as { window?: unknown }).window; else (globalThis as { window?: unknown }).window = real; }
};

/** The profile along the top as the saves before the places held it (traded/profiles.ts): its measure, and whether it is on. */
const topOf = (traded: AppState['traded']): { on: boolean; metric: string } => {
  const p = traded.placements.instances.find(x => x.placement === 'top');
  return { on: p?.enabled === true, metric: p?.metric ?? '' };
};

test('a first visit starts with no pane under the map, and the flow column and the book beside it', () => {
  for (const key of ['depth', 'oi', 'delta', 'ls', 'lt', 'footprint'] as const) assert.equal(DEFAULT_SHOW[key], false, key);
  assert.equal(defaultShow(1920).cvd, true);
  assert.equal(defaultShow(1920).book, true);
});

test('a save written under the old defaults (Depth and Open interest both on, no revision) has them off once; a choice is kept', () => {
  saved(null, () => assert.deepEqual([initialState().show.depth, initialState().show.oi], [false, false]));
  saved({ show: { ...DEFAULT_SHOW, depth: true, oi: true } }, () => {
    const s = initialState();
    assert.deepEqual([s.show.depth, s.show.oi, s.defaultsRev], [false, false, DEFAULTS_REV]);
  });
  // Only one of them on was a choice, and so is anything saved under the new revision.
  saved({ show: { ...DEFAULT_SHOW, depth: true, oi: false } }, () => assert.deepEqual([initialState().show.depth, initialState().show.oi], [true, false]));
  saved({ defaultsRev: DEFAULTS_REV, show: { ...DEFAULT_SHOW, depth: true, oi: true } }, () => assert.deepEqual([initialState().show.depth, initialState().show.oi], [true, true]));
});

test('the volume profile is on at a first visit with a mouse only: never on a phone or any touch screen (Karl, 2026-11-03)', () => {
  saved(null, () => {
    assert.equal(initialState(false, false).show.traded, true, 'a desktop with a mouse');
    assert.equal(initialState(false, true).show.traded, false, 'a tablet on its side, in the desktop arrangement');
    assert.equal(initialState(true, true).show.traded, false, 'a phone');
    assert.equal(initialState(true, false).show.traded, false, 'a narrow window');
  });
  // A save keeps what it holds.
  saved({ defaultsRev: DEFAULTS_REV, show: { ...DEFAULT_SHOW, traded: true }, traded: { lines: ['day'] } }, () => assert.equal(initialState(false, true).show.traded, true));
});

test('a save from before revision 2 shows what was new: days on the chart (their profiles off since 10-28), and the strip, now the profile along the top', () => {
  // A save of the day before: the volume profile off, no period on the chart and no profile (the choice came that day), the strip off.
  const before = { defaultsRev: 1, show: { ...DEFAULT_SHOW, traded: false }, traded: { lines: [], profiles: null, metrics: ['volume', 'oi'] }, measureStrip: { on: false, kind: 'oi' } };
  saved(before, () => {
    const s = initialState();
    assert.deepEqual([s.traded.lines, s.traded.profiles, topOf(s.traded), s.show.traded, s.defaultsRev], [['day'], null, { on: true, metric: 'oi' }, true, DEFAULTS_REV]);
    assert.deepEqual(s.traded.placements.instances.filter(p => p.placement === 'right' && p.enabled).map(p => p.metric), ['volume', 'oi'], 'the columns chosen stay, right of the map');
  });
  // Periods chosen before are kept as they were.
  saved({ ...before, traded: { lines: ['week'], profiles: null } }, () => assert.deepEqual([initialState().traded.lines, initialState().traded.profiles], [['week'], null]));
  // A first visit (a desktop): the Volume profile with its column and its days' lines, without their profiles and without the profile along
  // the top (off by default since 10-28), which a save of the days before keeps as it saved it.
  saved(null, () => { const s = initialState(); assert.deepEqual([topOf(s.traded), s.show.traded, s.traded.lines, s.traded.profiles], [{ on: false, metric: 'volume' }, true, ['day'], null]); });
  saved({ defaultsRev: DEFAULTS_REV, traded: { placements: { version: 1, instances: [{ id: 'volume:top', enabled: true, metric: 'volume', placement: 'top' }] } } }, () => assert.deepEqual(topOf(initialState().traded), { on: true, metric: 'volume' }));
  // A save holding the days' profiles keeps them: every save from 10-20 to 10-28 wrote them down, and a choice reads the same.
  saved({ defaultsRev: DEFAULTS_REV, traded: { lines: ['day'], profiles: 'day' } }, () => assert.equal(initialState().traded.profiles, 'day'));
});

test('revision 3: a save of revision 2 carries its measure strip into the profile along the top, and the Volume profile where it showed', () => {
  const rev2 = { defaultsRev: 2, show: { ...DEFAULT_SHOW, traded: false }, traded: { lines: [], profiles: null, bars: 'delta' }, measureStrip: { on: true, kind: 'delta' } };
  saved(rev2, () => {
    const s = initialState();
    assert.deepEqual([topOf(s.traded), s.show.traded, s.traded.bars, s.traded.lines, s.defaultsRev], [{ on: true, metric: 'volume' }, true, 'delta', [], DEFAULTS_REV]);
    assert.ok(!('measureStrip' in s), 'the strip is not kept');
  });
  // A strip switched off stays off, and the Volume profile as it was; a save of revision 3 is read as it is.
  saved({ ...rev2, measureStrip: { on: false, kind: 'oi' } }, () => { const s = initialState(); assert.deepEqual([topOf(s.traded), s.show.traded], [{ on: false, metric: 'oi' }, false]); });
  saved({ ...rev2, defaultsRev: DEFAULTS_REV, measureStrip: undefined, traded: { top: { on: false, metric: 'absorption' } } }, () => { const s = initialState(); assert.deepEqual([topOf(s.traded), s.show.traded], [{ on: false, metric: 'absorption' }, false]); });
  // A save holding a strip that showed and no Volume profile settings at all keeps the profile along the top: the old "no settings, so
  // off" rule does not switch off what the strip carried in.
  saved({ defaultsRev: 2, show: { ...DEFAULT_SHOW, traded: false }, measureStrip: { on: true, kind: 'oi' } }, () => { const s = initialState(); assert.deepEqual([topOf(s.traded), s.show.traded], [{ on: true, metric: 'oi' }, true]); });
  saved({ defaultsRev: 2, show: { ...DEFAULT_SHOW, traded: true }, measureStrip: { on: false, kind: 'oi' } }, () => assert.equal(initialState().show.traded, false, 'with the strip off, the old rule stands'));
});

test('revision 4: a touch screen has the Flow pane on once; LT is left as saved', () => {
  // Karl, 2026-10-26: the phone's Flow and LT were tabs of the bar. A save of revision 3 with the Flow off has it on once.
  const rev3 = { defaultsRev: 3, show: { ...DEFAULT_SHOW, cvd: false, lt: false }, lt: { halfLifeBp: 10, minUsd: 0, maxUsd: 0, average: false, view: 'lines' } };
  saved(rev3, () => {
    const s = initialState(true, true);
    // LT is left as saved since 2026-11-03: it has no tab now, and switched on it sits under the map (an old tablet save that has the
    // phone's arrangement since then would otherwise find it forced on, Sol).
    assert.deepEqual([s.show.cvd, s.show.lt, s.defaultsRev], [true, false, DEFAULTS_REV]);
  });
  saved({ ...rev3, show: { ...rev3.show, lt: true } }, () => assert.equal(initialState(true, true).show.lt, true, 'one saved on stays on'));
  // A first visit on a phone: the Flow, and LT off (Karl, 2026-11-03: Liq took its tab, and switched on it sits under the map).
  saved(null, () => { const s = initialState(true, true); assert.deepEqual([s.show.cvd, s.show.lt], [true, false]); });
  // A desktop keeps its panes, and so does a desktop window that is only narrow (a phone's layout without a finger).
  saved(rev3, () => { for (const s of [initialState(false, false), initialState(true, false), initialState(false, true)]) assert.deepEqual([s.show.cvd, s.show.lt], [false, false]); });
  saved({ ...rev3, defaultsRev: DEFAULTS_REV }, () => assert.equal(initialState(true, true).show.cvd, false, 'anything saved under the new revision is read as it is'));
});

test('revision 5: the Liquidity Tracker is at 10 bp on every screen (Karl, 2026-11-03), a revision-4 save holding its default 100 reads 10 once', () => {
  assert.equal(DEFAULTS_REV, 5);
  const lt = (halfLifeBp: number) => ({ halfLifeBp, minUsd: 0, maxUsd: 0, average: false, view: 'lines' });
  const screens = (): AppState[] => [initialState(true, true), initialState(false, false), initialState(true, false), initialState(false, true)];
  // A first visit: 10 on a phone, a desktop, a narrow window and a tablet.
  saved(null, () => { for (const s of screens()) assert.equal(s.lt.halfLifeBp, 10); });
  // Revision 4's default, written down by every save of it, reads 10 once; another half-life of that time was a choice and is kept.
  saved({ defaultsRev: 4, lt: lt(100) }, () => { for (const s of screens()) assert.equal(s.lt.halfLifeBp, 10); });
  saved({ defaultsRev: 4, lt: lt(25) }, () => { for (const s of screens()) assert.equal(s.lt.halfLifeBp, 25); });
  saved({ defaultsRev: 4, lt: lt(10) }, () => assert.equal(initialState(false, false).lt.halfLifeBp, 10));
  // Older saves held 10 by default, so a 100 there was a choice: kept, as is the 10 they hold (no longer read as 100).
  saved({ defaultsRev: 3, lt: lt(10) }, () => { for (const s of screens()) assert.equal(s.lt.halfLifeBp, 10); });
  saved({ defaultsRev: 3, lt: lt(100) }, () => assert.equal(initialState(false, false).lt.halfLifeBp, 100));
  // 100 chosen under revision 5 stays 100.
  saved({ defaultsRev: DEFAULTS_REV, lt: lt(100) }, () => { for (const s of screens()) assert.equal(s.lt.halfLifeBp, 100); });
});

test('the columns begin at the golden section of the window, as wide as before from 1,600 px up, and narrower in proportion under it, to a floor', () => {
  assert.ok(Math.abs(1 - 2 * COLUMN_SHARE - 0.618) < 0.001, 'the map keeps 61.8 %');
  // From 1,600 px up nothing changed (Karl's large screen was right as it was).
  assert.deepEqual(defaultColumns(1600), { flowW: 306, sideW: MIN_SIDE_W });
  assert.deepEqual(defaultColumns(1920), { flowW: 367, sideW: MIN_SIDE_W });
  assert.deepEqual(defaultColumns(2560), { flowW: 489, sideW: 489 });
  assert.deepEqual(defaultColumns(3840), { flowW: 733, sideW: 733 });
  // Under it they follow the window (the book 26.25 %, the flow column 18.75 %, as at 1,600), to their floors: the book was 420 px of a 1,280 px window.
  assert.deepEqual(defaultColumns(1500), { flowW: 287, sideW: 394 });
  assert.deepEqual(defaultColumns(1366), { flowW: 261, sideW: 359 });
  assert.deepEqual(defaultColumns(1280), { flowW: 260, sideW: 350 });
  assert.deepEqual(defaultColumns(1024), { flowW: 260, sideW: 350 });
  assert.deepEqual(defaultColumns(0), { flowW: FLOW_FLOOR_W, sideW: SIDE_FLOOR_W });
  assert.deepEqual([MIN_FLOW_W, MIN_SIDE_W, FULL_WIDTH], [300, 420, 1600]);
  let last = { flowW: 0, sideW: 0 };
  for (let width = 800; width <= 4000; width += 40) {
    const now = defaultColumns(width);
    assert.ok(now.flowW >= last.flowW && now.sideW >= last.sideW, `${width}: never narrower in a wider window`);
    assert.ok(now.sideW >= SIDE_FLOOR_W && now.flowW >= FLOW_FLOOR_W);
    last = now;
  }
});

test('the stylesheet sets the columns the same way before the page has run', () => {
  const css = fs.readFileSync(path.join(process.cwd(), 'src', 'app', 'styles.css'), 'utf8');
  const vw = `${(COLUMN_SHARE * 100).toFixed(1)}vw`;
  const book = `${(MIN_SIDE_W / FULL_WIDTH * 100).toFixed(2)}vw`, flow = `${(MIN_FLOW_W / FULL_WIDTH * 100).toFixed(2)}vw`;
  assert.ok(css.includes(`--side-w: max(clamp(${SIDE_FLOOR_W}px, ${book}, ${MIN_SIDE_W}px), ${vw})`), 'the book');
  assert.ok(css.includes(`--flow-w: max(clamp(${FLOW_FLOOR_W}px, ${flow}, ${MIN_FLOW_W}px), ${vw})`), 'the flow column');
});

test('the top bar starts unfolded; a fold is kept in this browser, never in a layout, and anything but true reads as unfolded', () => {
  // Karl, 2026-10-24: collapse the header bar to give an iPad's short screen to the chart, as a browser's full screen does.
  saved(null, () => assert.equal(initialState().barCollapsed, false));
  saved({ barCollapsed: true }, () => assert.equal(initialState().barCollapsed, true));
  saved({ barCollapsed: 'yes' }, () => assert.equal(initialState().barCollapsed, false));
  assert.equal((LAYOUT_KEYS as readonly string[]).includes('barCollapsed'), false);
});

test('Scripts is on for a first visit and for a save from before it existed; a save that holds it off keeps it off (it may have been chosen)', () => {
  assert.equal(DEFAULT_SHOW.script, true);
  saved(null, () => assert.equal(initialState().show.script, true));
  const { script: _, ...older } = DEFAULT_SHOW;
  saved({ defaultsRev: 4, show: older }, () => assert.equal(initialState().show.script, true));
  saved({ defaultsRev: 4, show: { ...DEFAULT_SHOW, script: false } }, () => assert.equal(initialState().show.script, false));
});
