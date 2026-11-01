import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_SHARE, DOCK_TABS, axisOf, clampSize, defaultTab, fillsArea, resolveTab, tabsFor } from '../src/app/dock.ts';
import { DEFAULT_SHOW } from '../src/app/store.ts';

test('a window opens on the map on a desktop and on the Tape on a phone, in either direction of holding it', () => {
  assert.equal(defaultTab('desktop'), 'map');
  assert.equal(defaultTab('phone'), 'candle');
  assert.equal(defaultTab('phone-landscape'), 'candle');
});

test('the Tape is always among the tabs, so the phone default is never turned back to the map', () => {
  assert.ok(tabsFor({ ...DEFAULT_SHOW, cvd: false, book: false, depth: false, oi: false }).includes('candle'));
  assert.equal(resolveTab(defaultTab('phone'), { ...DEFAULT_SHOW, cvd: false }), 'candle');
  // A chosen tab whose pane was switched off still falls back to the map.
  assert.equal(resolveTab('flow', { ...DEFAULT_SHOW, cvd: false }), 'map');
});

test('the tab a phone opens on is the leftmost of the bar (Karl, 2026-10-26), and the bar reads traded, resting, then worked out', () => {
  const all = { ...DEFAULT_SHOW, cvd: true, book: true, depth: true, oi: true, delta: true, ls: true, lt: true, stats: true, script: false, liq: true };
  assert.deepEqual(tabsFor(all), ['candle', 'flow', 'map', 'book', 'liq', 'depth', 'oi', 'delta', 'ls', 'stats']);
  assert.equal(tabsFor(all)[0], defaultTab('phone'), 'the first tab is the one a phone opens on');
  assert.equal(tabsFor({ ...all, script: true }).at(-1), 'script', 'the Scripts tab comes last, once its pane is switched on');
  // The panes a phone starts with (Flow and the Book are on, Liquidation levels with an address, and Scripts with the heat map since
  // 2026-10-27; the rest are one switch away) give six tabs, the Tape first and Scripts last. The Liquidity Tracker has no tab on a phone:
  // Liq took its place next to the Book (Karl, 2026-11-01); without an address for the levels there is no Liq tab either.
  assert.deepEqual(tabsFor({ ...DEFAULT_SHOW, cvd: true, book: true, lt: true, liq: true }), ['candle', 'flow', 'map', 'book', 'liq', 'script']);
  assert.ok(!tabsFor({ ...DEFAULT_SHOW, lt: true, liq: false }).some(tab => tab === 'liq' || (tab as string) === 'lt'));
  // Every tab is in the bar once.
  assert.equal(new Set(DOCK_TABS.map(tab => tab.id)).size, DOCK_TABS.length);
});

test('the Tape and the Flow fill the area both ways, the Book only held upright; every other tab has a map beside it and a size of its own', () => {
  for (const axis of ['portrait', 'landscape'] as const) {
    assert.ok(fillsArea('candle', axis) && fillsArea('flow', axis), `the Tape and the Flow, ${axis}`);
    assert.ok(!fillsArea('map', axis), 'the map alone is the map, not a view over it');
  }
  assert.ok(fillsArea('book', 'portrait'), 'twice the price rows upright (Karl, 2026-10-26)');
  assert.ok(!fillsArea('book', 'landscape'), 'the book stays beside the map held sideways: the screen is short, not narrow');
  assert.ok(fillsArea('liq', 'portrait') && !fillsArea('liq', 'landscape'), 'the liquidation ladder is placed as the Book is');
  // A tab with a map beside it has a default share, and none under the room a handle leaves (the map keeps 150 px of a portrait phone).
  for (const tab of DOCK_TABS) {
    for (const axis of ['portrait', 'landscape'] as const) {
      if (fillsArea(tab.id, axis) || tab.id === 'map') { assert.equal(DEFAULT_SHARE[axis][tab.id], undefined, `${axis} ${tab.id} has no share`); continue; }
      const share = DEFAULT_SHARE[axis][tab.id]!;
      assert.ok(share > 0.2 && share < 0.7, `${axis} ${tab.id}: ${share}`);
    }
  }
  assert.equal(clampSize(2000, 700, 'portrait'), 550, 'the map keeps its 150 px');
  assert.equal(axisOf('phone'), 'portrait'); assert.equal(axisOf('phone-landscape'), 'landscape');
});

test('the Stats tab follows the table\'s own switch, not the footprint\'s', () => {
  assert.ok(tabsFor({ ...DEFAULT_SHOW, stats: true }).includes('stats'));
  assert.ok(!tabsFor({ ...DEFAULT_SHOW, footprint: true, stats: false }).includes('stats'));
});
