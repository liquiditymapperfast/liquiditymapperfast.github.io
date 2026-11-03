import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { MAP_PLOT_FLOOR, chooseFold, type FoldInput, type FoldSide } from '../src/app/layouts/dock-model.ts';
import { defaultColumns, MIN_SIDE_W, stylesheetColumns } from '../src/app/layouts/layouts.ts';
import { setPlaced, type ProfilePlacement, type ProfileSet } from '../src/app/traded/profiles.ts';
import type { ProfileMetric } from '../src/app/measures/registry.ts';
import type { AppState } from '../src/app/store.ts';
import { gutter, gutterAt, leftGutter, setCompactGutters } from '../src/app/panes/heat-pane.ts';

/** The map as the heat pane has it: under 520 px its columns narrow (58 + two 16 px strips), over it they are whole (64 + 128 + 128 + a traded column). */
const cliff = (paneW: number): number => paneW - (paneW < 520 ? 90 : 416);
const side = (o: Partial<FoldSide> = {}): FoldSide => ({ state: 'open', want: 260, min: 200, book: false, ...o });
const input = (windowW: number, left: Partial<FoldSide>, right: Partial<FoldSide>, o: Partial<FoldInput> = {}): FoldInput =>
  ({ windowW, sides: { left: side(left), right: side({ book: true, want: 350, min: 260, ...right }) }, splitW: 6, railW: 22, plotAt: cliff, floor: MAP_PLOT_FLOOR, ...o });

test('a desktop folds the Flow column first when the map would be left too little plot (Karl, 2026-11-03: the iPad Air on its side had 144 px)', () => {
  // 1,180 px with the Flow (260) and the Book (350): the map's pane is 558 px, its whole columns leave 142. Folding the Flow leaves 386.
  const both = chooseFold(input(1180, {}, {}));
  assert.deepEqual(both.fold, ['left']);
  assert.equal(both.plot, 1180 - 22 - 356 - 416);
  // With the Flow on the right and the Book on the left, the column without the book folds all the same.
  assert.deepEqual(chooseFold(input(1180, { book: true, want: 350, min: 260 }, { book: false, want: 260, min: 200 })).fold, ['right']);
  // The Flow alone (the Book closed, its column a strip): 900 px leave 196 with it open, 440 folded.
  assert.deepEqual(chooseFold(input(900, {}, { state: 'rail' })).fold, ['left']);
});

test('the Book is never folded by the rule, however narrow the map: the person closes it', () => {
  // 1,100 px, the Flow closed: the Book's column leaves the map 306 px, under the floor, and stays.
  assert.deepEqual(chooseFold(input(1100, { state: 'rail' }, {})).fold, []);
  // Both panes stacked on the right: that column holds the book, so it never folds.
  assert.deepEqual(chooseFold(input(760, { state: 'none' }, {})).fold, []);
  for (const w of [700, 900, 1100, 1300]) assert.ok(!chooseFold(input(w, {}, {}, { floor: 10_000 })).fold.includes('right'), String(w));
});

test('the widths the page was designed at do not fold: 1,600 px, and 1,500 px where a first visit opens the Flow', () => {
  for (const w of [1500, 1600, 1920]) {
    const cols = defaultColumns(w);
    const r = chooseFold(input(w, { want: cols.flowW, min: 200 }, { want: cols.sideW, min: 260 }));
    assert.deepEqual(r.fold, [], `${w}: plot ${r.plot}`);
  }
  assert.equal(defaultColumns(1600).sideW, MIN_SIDE_W);
});

test('each choice is weighed with the plot its own pane width gives: a narrower pane with compact columns can beat a wider one', () => {
  // 1,000 px: both open leave a 378 px pane (compact columns: 288 of plot); the Flow folded a 622 px one (whole columns: 206). Neither reaches
  // the floor, and folding would leave less: nothing folds.
  const r = chooseFold(input(1000, {}, {}));
  assert.deepEqual([r.fold, r.plot], [[], 288]);
  // 1,470 px with both open: 375, over the floor.
  assert.deepEqual(chooseFold(input(1470, { want: 281 }, { want: 386 })).fold, []);
});

test('a column of closed panes is its edge tabs, one with none is not there', () => {
  // The Flow closed by its switch: the left column is a 22 px strip already, and the rule weighs the map with it.
  assert.equal(chooseFold(input(1180, { state: 'rail' }, {})).plot, 1180 - 22 - 356 - 416);
  assert.equal(chooseFold(input(1180, { state: 'none' }, {})).plot, 1180 - 356 - 416);
  // Nothing open: nothing to fold.
  assert.deepEqual(chooseFold(input(600, { state: 'rail' }, { state: 'rail' })).fold, []);
});

test('gutterAt is the map\'s own columns for any pane width, as the heat pane sets them, and sets nothing', () => {
  let set: ProfileSet = { version: 1, instances: [] };
  for (const [m, p] of [['volume', 'right'], ['oi', 'right'], ['absorption', 'left']] as [ProfileMetric, ProfilePlacement][]) set = setPlaced(set, m, p, true);
  const states = [
    { show: { traded: true, profile: true }, traded: { placements: set }, liqLevels: { on: true, column: true } },
    { show: { traded: false, profile: true }, traded: { placements: set }, liqLevels: { on: true, column: true } },
    { show: { traded: true, profile: false }, traded: { placements: set }, liqLevels: { on: false, column: true } },
  ] as unknown as AppState[];
  try {
    for (const state of states) for (const paneW of [300, 519, 520, 560, 800, 1200, 2000]) {
      setCompactGutters(false, 2000);
      const asked = gutterAt(paneW, state);
      setCompactGutters(paneW < 520, paneW);
      assert.equal(asked, gutter(state) + leftGutter(state), `${paneW} ${state.show.traded} ${state.show.profile}`);
    }
    // It leaves the module as it found it.
    setCompactGutters(false, 2000);
    const before = gutter(states[0]!);
    gutterAt(400, states[0]!);
    assert.equal(gutter(states[0]!), before);
  } finally { setCompactGutters(false, 2000); }
});

test('the layout folds without touching the switches or the plan, and its folded tabs say so', () => {
  const layout = fs.readFileSync('src/app/layout.ts', 'utf8');
  assert.match(layout, /#folded = new Set<Side>\(\)/, 'the fold is its own state');
  assert.doesNotMatch(layout, /#plan[^\n]*#folded|#folded[^\n]*#plan\.(left|right)\s*=/, 'never written into the plan');
  assert.match(layout, /write\(\{ heights: \{ \.\.\.this\.#saved\.heights, \.\.\.heights \}, order: this\.#panes\.map\(p => p\.id\), dock: this\.#plan \}\)/, 'what is saved is the plan alone');
  assert.match(layout, /class: fold \? 'edge-tab folded' : 'edge-tab'/, 'a folded tab is not a closed one');
  assert.match(layout, /if \(!this\.plotAt \|\| isPhone\(\)\) return \[\];/, 'a phone never folds');
  const main = fs.readFileSync('src/app/main.ts', 'utf8');
  assert.match(main, /arrange\.plotAt = paneW => paneW - gutterAt\(paneW, store\.state\)/);
});

test('the pane is weighed at the widths the stylesheet gives, to the fraction, and floored as the map floors it (Sol, 2026-11-03)', () => {
  // 1,400 px, the Flow at the stylesheet's 267.4 px (asked 267) beside a Book dragged to 601: the pane is 519.6, the map's 519, compact (429).
  // Weighed at 267 it read 520 (full columns, 104) and folded the Flow for 355, 74 px less.
  const r = chooseFold(input(1400, { want: 267, exact: 267.4 }, { want: 601 }));
  assert.deepEqual([r.fold, r.plot], [[], 519 - 90]);
  // A column the fitting took down (two columns over the window's share) is laid out in whole pixels, so its asked width's fraction does not apply.
  // 1,000 px, 400 and 400 asked: both are taken down to 310, and the pane is 1000 - 316 - 316 = 368, compact.
  assert.deepEqual(chooseFold(input(1000, { want: 400, exact: 400.6 }, { want: 400 })).plot, 368 - 90);
  for (const w of [1100, 1180, 1280, 1400, 1500, 1600, 1920]) {
    const css = stylesheetColumns(w), round = defaultColumns(w);
    assert.deepEqual([Math.round(css.flowW), Math.round(css.sideW)], [round.flowW, round.sideW], String(w));
  }
});

test('a column given back its own width (a double click on its splitter) weighs the fold again, as a resize does', () => {
  const layout = fs.readFileSync('src/app/layout.ts', 'utf8');
  assert.match(layout, /bar\.addEventListener\('dblclick', \(\) => \{ this\.#plan\[side === 'left' \? 'leftW' : 'rightW'\] = null; this\.#relayout\(\); this\.#persist\(\); \}\);/);
  assert.match(layout, /window\.addEventListener\('resize', \(\) => \{ this\.#fit\(\); if \(isPhone\(\) !== phone\) \{ phone = !phone; this\.#renderSides\(\); \} else this\.#relayout\(\); \}\);/);
});

test('a column let go of after a drag weighs the fold (the other column may fold), and the one dragged stays open (Sol, 2026-11-03)', () => {
  const layout = fs.readFileSync('src/app/layout.ts', 'utf8');
  assert.match(layout, /\(\) => \{ start = this\.#width\(side\); \}, \(\) => \{ this\.#afterDrag\(side\); this\.#persist\(\); \}\);/);
  assert.match(layout, /#afterDrag\(side: Side\): void \{\n\s+if \(this\.#foldRule\(\)\.includes\(side\)\) this\.#foldOff = true;\n\s+this\.#relayout\(\);/);
});
