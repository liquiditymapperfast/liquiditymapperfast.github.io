// Split (Plus, 2026-11-19): the liquidation column as two sub-columns, liquidations beside stops on one scale or everyone beside the
// profitable traders each on its own; the room it needs and what it falls back to; the stripe's lanes and captions; the levels control's
// Split choice; and the words.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { LADDER_SUB_MIN, SPLIT_COLUMN_W, SPLIT_SUB_W, ladderSplitFits, liqColumnWidth, placeProbeBoxes, splitFits, splitHeads, splitLanes, splitScales, placeCaptions, subAt, subColumns, type BoxAt, type BoxSize } from '../src/app/liq-split.ts';
import { MAP_PLOT_FLOOR } from '../src/app/layouts/dock-model.ts';
import { LIQ_SPLITS, readLiqLevels } from '../src/app/liq-url.ts';
import { FREE_VIEW, curveOf, depthView, effectiveSplit, effectiveView, narrowView, splitPair } from '../src/app/liq-view.ts';
import { narrowNote, pairDescription, pairSummary, splitChoiceName, splitName, subNames, takesOf } from '../src/app/liq-words.ts';
import { createLevelsControl, keptSplitNote, pressSplit, shownSplit, type LevelsModel } from '../src/app/levels-control.ts';
import { Store, initialState, type AppState } from '../src/app/store.ts';
import { gutter, gutterAt, leftGutter, liqSplitDrawn, setCompactGutters } from '../src/app/panes/heat-pane.ts';
import { plus } from '../src/app/plus/pass.ts';
import type { LiqLevelSettings } from '../src/app/liq-url.ts';
import { FakeElement, FakePage } from './fake-dom.mts';

const DAY = 86_400_000;
const standInPass = (exp: number): string => `v1.${Buffer.from(JSON.stringify({ sub: 'standin', exp })).toString('base64url')}.sig`;
/** Plus on for the length of `run` (the page's shared membership, held in memory in Node). */
function withPlus<T>(run: () => T): T {
  const now = Date.now();
  plus().accept({ key: 'standin-key-0123456789', pass: standInPass(now + 23 * 3_600_000), until: now + 20 * DAY });
  try { return run(); } finally { plus().forget(); }
}
const measure = (text: string): number => text.length * 6;

test('a split column is two 100 px sub-columns; it is drawn only where the plot keeps the desktop\'s floor, never on a compact map', () => {
  assert.equal(SPLIT_COLUMN_W, 2 * SPLIT_SUB_W);
  assert.ok(SPLIT_SUB_W >= 90, 'two readable sub-columns: about 90 px each at least');
  const base = { shown: true, compact: false, strip: 16, column: 128, split: true, floor: MAP_PLOT_FLOOR };
  // The plot the unsplit column leaves must keep the floor once the column grows by 72 px.
  assert.equal(liqColumnWidth({ ...base, plotUnsplit: MAP_PLOT_FLOOR + 72 }), SPLIT_COLUMN_W, 'just room: split');
  assert.equal(liqColumnWidth({ ...base, plotUnsplit: MAP_PLOT_FLOOR + 71 }), 128, 'a pixel short: the column stays one');
  assert.equal(liqColumnWidth({ ...base, plotUnsplit: Infinity }), 128, 'a pane not laid out yet: one column');
  assert.equal(liqColumnWidth({ ...base, split: false, plotUnsplit: 5_000 }), 128, 'no split: one column');
  assert.equal(liqColumnWidth({ ...base, compact: true, plotUnsplit: 5_000 }), 16, 'a compact map keeps its strip');
  assert.equal(liqColumnWidth({ ...base, shown: false, plotUnsplit: 5_000 }), 0);
  assert.equal(splitFits(MAP_PLOT_FLOOR + 72, 128, MAP_PLOT_FLOOR), true); assert.equal(splitFits(NaN, 128, MAP_PLOT_FLOOR), false);
  assert.deepEqual(subColumns(400, SPLIT_COLUMN_W), [{ x0: 400, w: 100 }, { x0: 500, w: 100 }]);
  // The phone's Liq tab splits its ladder in halves of at least LADDER_SUB_MIN.
  assert.equal(ladderSplitFits(2 * LADDER_SUB_MIN + 8), true); assert.equal(ladderSplitFits(2 * LADDER_SUB_MIN + 7), false);
});

test('liquidations beside stops share one scale (a bar compares across the divider); everyone beside the profitable traders each its own', () => {
  const everyone = { maxLevel: 40e6, maxCum: 400e6 }, profitable = { maxLevel: 2e6, maxCum: 9e6 };
  assert.deepEqual(splitScales(everyone, profitable, false), [everyone, profitable], 'own scales: the profitable traders\' bars are not a few pixels');
  assert.deepEqual(splitScales(everyone, profitable, true), [everyone, everyone], 'shared: the larger of each');
  assert.deepEqual(splitScales({ maxLevel: 0, maxCum: 0 }, { maxLevel: 0, maxCum: 0 }, false), [{ maxLevel: 1, maxCum: 1 }, { maxLevel: 1, maxCum: 1 }], 'never divided by zero');
});

test('the split column\'s heading: each caption over its column, the maxima under each where they have their own scale, once across where shared; nothing cut', () => {
  const kinds = splitHeads(measure, { captions: ['Liquidations', 'Stops'], shared: true, subRoom: 89, wholeRoom: 189, maxima: ['LEVEL MAX $12.3M', 'CUM MAX $120.0M'] });
  assert.deepEqual(kinds.subs.map(s => s.scale), [[], []], 'shared: no scale per column');
  assert.deepEqual(kinds.across, ['LEVEL MAX $12.3M', 'CUM MAX $120.0M']);
  assert.equal(kinds.rows, 1 + 2);
  const groups = splitHeads(measure, { captions: ['Everyone', 'Profitable'], shared: false, subRoom: 89, wholeRoom: 189,
    maxima: [['LEVEL MAX $12.3M', 'CUM MAX $120.0M'], ['LEVEL MAX $1.2M', 'CUM MAX $9.0M']] });
  assert.deepEqual(groups.across, []);
  // At 6 px a letter "LEVEL MAX $12.3M" (96 px) does not fit 89 px: it wraps under itself, the value whole on the next line.
  assert.deepEqual(groups.subs[0].scale, ['LEVEL MAX', '$12.3M', 'CUM MAX', '$120.0M']);
  assert.deepEqual(groups.subs[1].scale, ['LEVEL MAX', '$1.2M', 'CUM MAX $9.0M']);
  assert.equal(groups.rows, 1 + 4);
  for (const line of [...groups.subs.flatMap(s => [...s.caption, ...s.scale]), ...kinds.across]) assert.ok(!line.includes('…'), `never cut: ${line}`);
});

test('the stripe\'s lanes for liquidations beside stops: the take profits by the live edge, then liquidations, then stops beside the column; captions never overlap', () => {
  const lanes = splitLanes(100, 400, true);
  assert.ok(lanes.takes && lanes.takes.x0 === 100 && lanes.takes.x1 === 190, 'three tenths for the take profits');
  assert.ok(lanes.left.x0 === 192 && lanes.left.x1 <= lanes.right!.x0 - 2 && lanes.right!.x1 === 400, 'liquidations, 2 px, stops to the column');
  const none = splitLanes(100, 400, false);
  assert.equal(none.takes, null); assert.equal(none.left.x0, 100); assert.equal(none.right!.x1, 400);
  const narrow = splitLanes(380, 400, true);
  for (const l of [narrow.takes!, narrow.left, narrow.right!]) assert.ok(l.x1 >= l.x0 && l.x0 >= 380 && l.x1 <= 400, 'never outside the stripe');
  // Three plates where two would overlap: the second goes a row down, the third stays up where it is clear.
  assert.deepEqual(placeCaptions([{ x: 10, w: 80 }, { x: 60, w: 80 }, { x: 200, w: 50 }], [], 6, 15), [6, 23, 6]);
});

test('too narrow to split: liquidations beside stops fall back to the two added up, everyone beside the profitable traders to everyone\'s; Traders never written', () => {
  const kinds = splitPair(readLiqLevels({ liq: true, stops: true, takes: true, group: 'profitable', split: 'kinds' }), true)!;
  assert.deepEqual(narrowView(kinds), { liq: true, stops: true, takes: true, group: 'profitable' }, 'nothing switched on disappears');
  const groups = splitPair(readLiqLevels({ liq: true, stops: false, takes: false, group: 'profitable', split: 'groups' }), true)!;
  assert.deepEqual(narrowView(groups), { liq: true, stops: false, takes: false, group: 'all' }, 'everyone\'s, derived: the saved group stays profitable');
  assert.equal(narrowNote('Liq + stops'), 'Too narrow to split: Liq + stops');
});

test('the Split choice: liquidations beside stops turns both kinds on, everyone beside the profitable traders turns liquidations on only where neither is, and none is none', () => {
  const s = { liq: true, stops: false, takes: true, group: 'profitable' as const };
  assert.deepEqual(pressSplit(s, 'kinds', true), { change: { split: 'kinds', liq: true, stops: true } });
  assert.deepEqual(pressSplit(s, 'groups', true), { change: { split: 'groups' } }, 'no Traders written, no kind changed');
  assert.deepEqual(pressSplit({ liq: false, stops: false, takes: true, group: 'all' }, 'groups', true), { change: { split: 'groups', liq: true } }, 'take profits alone: liquidations come on');
  assert.deepEqual(pressSplit(s, 'none', true), { change: { split: 'none' } });
  assert.equal(pressSplit(s, 'kinds', false), 'plus'); assert.equal(pressSplit(s, 'groups', false), 'plus');
  assert.deepEqual(pressSplit(s, 'none', false), { change: { split: 'none' } }, 'none is free');
  assert.equal(shownSplit({ ...s, split: 'groups' }, true), 'groups'); assert.equal(shownSplit({ ...s, split: 'groups' }, false), 'none', 'nothing split for a visitor');
  assert.equal(shownSplit({ ...s, split: 'kinds' }, true), 'kinds', 'liquidations beside stops with stops off: still chosen, kept (owner, 2026-11-20)');
  assert.equal(keptSplitNote({ ...s, split: 'kinds' }, true), 'Liquidations | Stops comes back when liquidations and stops are both on.', 'and the control says what brings it back');
  assert.equal(keptSplitNote({ ...s, stops: true, split: 'kinds' }, true), '', 'drawn: nothing to say');
  assert.equal(keptSplitNote({ liq: false, stops: false, takes: true, group: 'all', split: 'groups' }, true), 'Everyone | Profitable comes back when liquidations or stops are on.');
  assert.equal(keptSplitNote({ ...s, split: 'kinds' }, false), '', 'nothing split for a visitor, nothing said');
  // Through the page's store every write is read: a kind switched off keeps the split, drawn as none until the kind is on again; the group is
  // untouched by a split.
  const store = new Store(initialState());
  store.set({ liqLevels: { ...store.state.liqLevels, group: 'profitable' } });
  store.set({ liqLevels: { ...store.state.liqLevels, ...(pressSplit(store.state.liqLevels, 'groups', true) as { change: Partial<LiqLevelSettings> }).change } });
  assert.equal(store.state.liqLevels.split, 'groups'); assert.equal(store.state.liqLevels.group, 'profitable', 'Traders kept for when the split goes');
  store.set({ liqLevels: { ...store.state.liqLevels, ...(pressSplit(store.state.liqLevels, 'kinds', true) as { change: Partial<LiqLevelSettings> }).change } });
  assert.deepEqual([store.state.liqLevels.split, store.state.liqLevels.liq, store.state.liqLevels.stops], ['kinds', true, true]);
  store.set({ liqLevels: { ...store.state.liqLevels, liq: false } });
  assert.equal(store.state.liqLevels.split, 'kinds', 'either kind off: the split is kept (it was lost until 2026-11-20)');
  assert.equal(effectiveSplit(store.state.liqLevels, true), 'none', '... and drawn as none');
  store.set({ liqLevels: { ...store.state.liqLevels, liq: true } });
  assert.equal(effectiveSplit(store.state.liqLevels, true), 'kinds', 'on again: split again');
});

/** A levels model over a plain choice (no store's reader), recording what the control writes. */
function model(choice: LiqLevelSettings, member: boolean): LevelsModel & { writes: Partial<LiqLevelSettings>[] } {
  let c = choice; const listeners = new Set<() => void>(), writes: Partial<LiqLevelSettings>[] = [];
  return { writes, get: () => c, set: change => { writes.push(change); c = readLiqLevels({ ...c, ...change }); for (const l of listeners) l(); }, subscribe: l => { listeners.add(l); return () => { listeners.delete(l); }; }, member: () => member };
}

test('the levels control shows Split as one of three, locked without Plus, left out where asked (the demo), and hides Traders beside the profitable traders\' column', () => {
  const done = new FakePage().install();
  try {
    const m = model(readLiqLevels({ liq: true, stops: false, group: 'profitable' }), true);
    const c = createLevelsControl(m, { locked: () => { throw new Error('no lock for a member'); } });
    const root = c.root as unknown as FakeElement, opts = root.querySelectorAll('.lv-opt');
    assert.deepEqual(opts.map(o => o.dataset.split), ['none', 'kinds', 'groups']);
    assert.deepEqual(opts.map(o => o.getAttribute('aria-checked')), ['true', 'false', 'false']);
    const traders = root.querySelectorAll('.lv-sec').find(sec => sec.querySelector('.lv-seg'))!;
    assert.equal(traders.hidden, false);
    opts[2]!.click();
    assert.deepEqual(m.writes.at(-1), { split: 'groups' });
    assert.equal(traders.hidden, true, 'Traders has no say beside the profitable traders\' column');
    assert.deepEqual(opts.map(o => o.getAttribute('aria-checked')), ['false', 'false', 'true']);
    assert.match(root.querySelector('.lv-sum')!.textContent, /Left: Everyone · Right: Profitable · Curve: Liquidations/);
    opts[1]!.click();
    assert.deepEqual(m.writes.at(-1), { split: 'kinds', liq: true, stops: true });
    assert.equal(traders.hidden, false);
    assert.match(root.querySelector('.lv-sum')!.textContent, /Left: Liquidations · Right: Stops · Profitable/);
    c.destroy();
    // Without Plus: both splits locked, pressing one opens the presentation and writes nothing.
    const v = model(readLiqLevels({ liq: true }), false), locked: unknown[] = [];
    const lc = createLevelsControl(v, { locked: from => { locked.push(from); } });
    const vopts = (lc.root as unknown as FakeElement).querySelectorAll('.lv-opt');
    vopts[1]!.click(); vopts[2]!.click();
    assert.equal(locked.length, 2); assert.equal(v.writes.length, 0);
    assert.ok(vopts[1]!.classList.contains('locked') && !vopts[0]!.classList.contains('locked'));
    lc.destroy();
    // The demo's control has no Split.
    const demo = createLevelsControl(model(readLiqLevels({}), true), { locked: () => {}, hideSplit: true });
    assert.equal((demo.root as unknown as FakeElement).querySelectorAll('.lv-opt').length, 0);
    demo.destroy();
  } finally { done(); }
});

test('the words of a split: its name on the button, its name in the control, each column\'s caption, the take profits\' whose, the summary and the description', () => {
  const kinds = splitPair(readLiqLevels({ liq: true, stops: true, takes: true, group: 'profitable', split: 'kinds' }), true)!;
  const groups = splitPair(readLiqLevels({ liq: true, stops: true, split: 'groups' }), true)!;
  assert.equal(splitName('kinds'), 'Liq | Stops'); assert.equal(splitName('groups'), 'Everyone | Profitable');
  assert.deepEqual(['none', 'kinds', 'groups'].map(s => splitChoiceName(s as 'none')), ['None', 'Liquidations | Stops', 'Everyone | Profitable']);
  assert.deepEqual(subNames(kinds), ['Liquidations', 'Stops']); assert.deepEqual(subNames(groups), ['Everyone', 'Profitable']);
  assert.equal(takesOf('profitable'), 'Take profits · Profitable');
  assert.equal(pairSummary(kinds), 'Left: Liquidations · Right: Stops · TP bars on the left · Profitable');
  assert.equal(pairSummary(groups), 'Left: Everyone · Right: Profitable · Curve: Liq + stops');
  assert.equal(pairDescription(groups), 'Left column: All traders. Right column: Profitable traders. Curve: Liquidation and stop levels.');
  assert.match(pairDescription(kinds), /^Left column: Liquidation levels\. Right column: Stop levels\. Take-profit bars shown on the left\. Traders: Profitable\.$/);
  assert.equal(splitPair({ ...FREE_VIEW, split: 'groups' }, false), null, 'nothing split without Plus');
});

test('the layout asks the same width of the map as the map takes, with a split chosen: split where it fits, one column where it does not', () => {
  const state = { ...initialState(), show: { ...initialState().show, traded: false, profile: true }, liqLevels: readLiqLevels({ liq: true, stops: true, split: 'kinds' }) } as AppState;
  withPlus(() => {
    try {
      const widths = [300, 519, 520, 560, 640, 700, 760, 800, 1000, 1400];
      for (const paneW of widths) {
        setCompactGutters(false, 2000);
        const asked = gutterAt(paneW, state);
        setCompactGutters(paneW < 520, paneW);
        assert.equal(asked, gutter(state) + leftGutter(state), `${paneW}`);
        // Split exactly where the plot keeps the floor with the wider column.
        const plot = paneW - asked;
        if (liqSplitDrawn(state)) assert.ok(plot >= MAP_PLOT_FLOOR, `${paneW}: split keeps the floor (${plot})`);
      }
      setCompactGutters(false, 1400); assert.equal(liqSplitDrawn(state), true, 'a wide desktop: split');
      setCompactGutters(false, 600); assert.equal(liqSplitDrawn(state), false, 'too narrow: one column');
      setCompactGutters(true, 400); assert.equal(liqSplitDrawn(state), false, 'a phone\'s map: never');
    } finally { setCompactGutters(false, 2000); }
  });
  // Without Plus nothing is split, however wide.
  setCompactGutters(false, 1400);
  try { assert.equal(liqSplitDrawn(state), false); } finally { setCompactGutters(false, 2000); }
});

test('the split\'s pieces are where the page draws them: the map\'s split painter, the stripe\'s lanes, the Liq tab\'s halves, the Depth pane\'s note', () => {
  const heat = fs.readFileSync('src/app/panes/heat-pane.ts', 'utf8'), tab = fs.readFileSync('src/app/panes/liq-pane.ts', 'utf8'), depth = fs.readFileSync('src/app/panes/lower-panes.ts', 'utf8');
  assert.match(heat, /if \(pair && !strip && W === SPLIT_COLUMN_W\) \{ this\.#paintLiqSplit\(ctx, state, pw, ph, pair\); return; \}/);
  assert.match(heat, /const set: LiqSet = pair\?\.split === 'kinds' \? src\.setOf\(narrowView\(pair\)\) : src;/, 'too narrow: the sum, or everyone\'s');
  assert.match(fs.readFileSync('src/app/liq-stripe.ts', 'utf8'), /splitLanes\(x0, pw, !!takes\)/); assert.match(heat, /this\.#placeLiqCaptions\(ctx, painted\.captions, pw\)/);
  assert.match(heat, /splitScales\(\{ maxLevel: Math\.max\(profs\[0\]\?\.maxLevel \?\? 0, tprof\?\.maxLevel \?\? 0\), maxCum: profs\[0\]\?\.maxCum \?\? 0 \},\n\s+\{ maxLevel: profs\[1\]\?\.maxLevel \?\? 0, maxCum: profs\[1\]\?\.maxCum \?\? 0 \}, pair\.split === 'kinds'\)/);
  assert.match(tab, /halves = !!pair && ladderSplitFits\(W - AXIS\)/); assert.match(tab, /#paintHalves\(/);
  // The Depth pane is not split (owner, 2026-11-20): every place that asks what it draws (its series, its button, its Range summary's key) reads
  // `liveDepthView`, never the left column's set; only Everyone | Profitable is told in its tip.
  assert.equal((depth.match(/liveDepthView\(/g) ?? []).length, 3); assert.doesNotMatch(depth, /liveView\(/);
  assert.match(depth, /liveSplit\(this\.store\.state\.liqLevels\)\?\.split === 'groups' \? `\$\{t\("Under Everyone \| Profitable the Depth pane draws everyone's levels\."\)\} `/);
});

test('the Depth pane draws every choice as with Split None; under Everyone | Profitable as Everyone, the saved Traders never drawn (owner, 2026-11-20)', () => {
  const KINDS = [[1, 0, 0], [0, 1, 0], [0, 0, 1], [1, 1, 0], [1, 0, 1], [0, 1, 1], [1, 1, 1]] as const;
  for (const [l, st, tk] of KINDS) for (const group of ['all', 'profitable'] as const) for (const split of LIQ_SPLITS) {
    const s = readLiqLevels({ liq: !!l, stops: !!st, takes: !!tk, group, split }), name = `${l}${st}${tk} ${group} ${split}`;
    const inForce = effectiveSplit(s, true), none = { ...s, split: 'none' as const };
    // The one-line rule: Depth(state) = Depth(the same state with Split None), Everyone | Profitable (in force) with Traders as Everyone.
    assert.deepEqual(depthView(s, true), depthView(inForce === 'groups' ? { ...none, group: 'all' } : none, true), name);
    assert.deepEqual(depthView(s, true), { liq: !!l, stops: !!st, takes: !!tk, group: inForce === 'groups' ? 'all' : group }, name);
    assert.deepEqual(depthView(s, false), FREE_VIEW, `${name}: without Plus the free view`);
  }
  // Liquidations | Stops: Liq + stops of the chosen traders (until 2026-11-20 it drew the left column, liquidations alone).
  assert.equal(curveOf(depthView(readLiqLevels({ liq: true, stops: true, takes: true, group: 'profitable', split: 'kinds' }), true)), 'both');
  // A split kept but not in force (take profits alone under Everyone | Profitable) draws as none: the saved Traders count there.
  assert.deepEqual(depthView(readLiqLevels({ liq: false, stops: false, takes: true, group: 'profitable', split: 'groups' }), true), { liq: false, stops: false, takes: true, group: 'profitable' });
  // The column and the stripe still split: their one series is the left set.
  assert.deepEqual(effectiveView(readLiqLevels({ liq: true, stops: true, split: 'kinds' }), true), { liq: true, stops: false, takes: false, group: 'all' });
});

test('the levels control keeps a split chosen while a kind it needs is off, says what brings it back, and gives Traders back their say (owner, 2026-11-20)', () => {
  const done = new FakePage().install();
  try {
    const m = model(readLiqLevels({ liq: true, stops: true, takes: false, group: 'profitable', split: 'kinds' }), true);
    const c = createLevelsControl(m, { locked: () => { throw new Error('no lock for a member'); } });
    const root = c.root as unknown as FakeElement, opts = root.querySelectorAll('.lv-opt'), note = root.querySelector('.lv-split-kept')!;
    const row = (part: string): FakeElement => root.querySelectorAll('.lv-row').find(b => b.dataset.part === part)!;
    const traders = root.querySelectorAll('.lv-sec').find(sec => sec.querySelector('.lv-seg'))!;
    assert.equal(note.hidden, true);
    row('stops').click();
    assert.deepEqual(m.writes.at(-1), { stops: false }); assert.equal(m.get().split, 'kinds', 'kept');
    assert.deepEqual(opts.map(o => o.getAttribute('aria-checked')), ['false', 'true', 'false'], 'shown chosen, as where the map is too narrow');
    assert.equal(note.hidden, false); assert.equal(note.textContent, 'Liquidations | Stops comes back when liquidations and stops are both on.');
    assert.match(root.querySelector('.lv-sum')!.textContent, /^Curve: Liquidations · Profitable$/, 'the live line says what is drawn: one column');
    row('stops').click();
    assert.equal(note.hidden, true); assert.match(root.querySelector('.lv-sum')!.textContent, /Left: Liquidations · Right: Stops · Profitable/, 'on again: split again');
    // Everyone | Profitable, then take profits alone: kept, Traders back (the drawn choice uses them), the note says what brings it back.
    opts[2]!.click(); row('takes').click(); row('liq').click(); row('stops').click();
    assert.deepEqual([m.get().liq, m.get().stops, m.get().takes, m.get().split], [false, false, true, 'groups']);
    assert.equal(traders.hidden, false, 'nothing is split: Traders has its say');
    assert.equal(note.textContent, 'Everyone | Profitable comes back when liquidations or stops are on.');
    row('liq').click();
    assert.equal(traders.hidden, true); assert.equal(note.hidden, true, 'liquidations on: split again');
    c.destroy();
  } finally { done(); }
});

// Sol's review of Split (2026-11-19): five P2s; the code before the fixes failed each.
test('Sol 1 (P2): a move across the split column\'s divider at one height redraws the overlay: Mirror follows the sub-column, and so does the hover key', () => {
  assert.equal(subAt(400, 400, SPLIT_COLUMN_W), 0); assert.equal(subAt(499, 400, SPLIT_COLUMN_W), 0); assert.equal(subAt(500, 400, SPLIT_COLUMN_W), 1, 'from the divider on: the right');
  const heat = fs.readFileSync('src/app/panes/heat-pane.ts', 'utf8');
  assert.match(heat, /const side = profile\?\.column === 'liq' && profile\.x !== undefined && liqSplitDrawn\(state\) \? `,\$\{subAt\(profile\.x, pw, SPLIT_COLUMN_W\)\}` : '';/);
  assert.match(heat, /\$\{profile \? `\$\{profile\.column\},\$\{profile\.y\}\$\{side\}` : ''\}/, 'the side is part of the key');
  assert.match(heat, /at: 0 \| 1 = hv\?\.x !== undefined \? subAt\(hv\.x, x0, W\) : 0/, 'and Mirror reads the same side');
});

test('Sol 4 (P2): a compact map\'s strip draws what a split falls back to (Liq | Stops: the two added up), never liquidations alone', () => {
  const heat = fs.readFileSync('src/app/panes/heat-pane.ts', 'utf8');
  assert.match(heat, /    const pair = liveSplit\(state\.liqLevels\);\n    if \(pair && !strip && W === SPLIT_COLUMN_W\)/);
  assert.ok(!/const pair = strip \? null : liveSplit/.test(heat));
});

test('Sol 5 (P2): an empty stops lane gives no reading: the liquidations\' lane answers only inside itself', () => {
  const heat = fs.readFileSync('src/app/panes/heat-pane.ts', 'utf8');
  assert.match(heat, /levels = inTakes \? src\.takes : x >= lanes\.levels\.x0 && x < lanes\.levels\.x1 \? src\.levels : null;/);
});

test('the seam beside a column too narrow to split weighs what the column draws (Liq | Stops: the two added up); beside a drawn split, the left set', () => {
  const heat = fs.readFileSync('src/app/panes/heat-pane.ts', 'utf8');
  assert.match(heat, /  #paintSeam\(ctx: CanvasRenderingContext2D, state: AppState, pw: number, ph: number\): void \{\n    const hv = this\.#profileHover, src: LiqSet = this\.#liqDrawnSet \?\? this\.hub\.liqLevels,/);
  assert.match(heat, /const set: LiqSet = pair\?\.split === 'kinds' \? src\.setOf\(narrowView\(pair\)\) : src;\n    this\.#liqDrawnSet = set;/, 'the unsplit column keeps what it drew');
  assert.match(heat, /  #paintLiqSplit\(ctx: CanvasRenderingContext2D[^\n]*\n[^\n]*\n[^\n]*\n    this\.#liqDrawnSet = null;/, 'a drawn split keeps none: the seam weighs the left set');
});

test('the finger\'s two boxes on the phone\'s split ladder are placed together: Sol\'s case, a sweep of heights, sizes and fingers, side by side where there is room', () => {
  const on = (at: BoxAt, s: BoxSize, W: number, H: number): boolean => at.x >= 2 && at.y >= 2 && at.x + s.w <= W - 2 && at.y + s.h <= H - 2;
  const apart = (p: BoxAt, ps: BoxSize, q: BoxAt, qs: BoxSize): boolean => p.y + ps.h <= q.y || q.y + qs.h <= p.y || p.x + ps.w <= q.x || q.x + qs.w <= p.x;
  // Sol: a 480 px ladder, a finger at 241, two 120 px boxes. Placed one at a time they took 107-227 and 2-122.
  const two: [BoxSize, BoxSize] = [{ w: 230, h: 120 }, { w: 230, h: 120 }];
  const [a, b] = placeProbeBoxes(two, 241, 330, 480);
  assert.ok(a && b && on(a, two[0], 330, 480) && on(b, two[1], 330, 480) && apart(a, two[0], b, two[1]), JSON.stringify([a, b]));
  // Every finger, on ladders 480 to 844 px high, boxes 64 to 176 px high (both fitting the ladder together), on a phone's 330 px ladder.
  for (const H of [480, 560, 640, 760, 844]) for (const [ha, hb] of [[64, 64], [120, 120], [152, 152], [176, 120], [88, 176]] as const) for (let y = 0; y <= H; y += 3) {
    const s: [BoxSize, BoxSize] = [{ w: 222, h: ha }, { w: 234, h: hb }];
    const [p, q] = placeProbeBoxes(s, y, 330, H);
    assert.ok(p && q && on(p, s[0], 330, H) && on(q, s[1], 330, H), `${H} px, ${ha}/${hb}, finger ${y}: on the ladder ${JSON.stringify([p, q])}`);
    assert.ok(apart(p, s[0], q, s[1]), `${H} px, ${ha}/${hb}, finger ${y}: apart ${JSON.stringify([p, q])}`);
    assert.ok(p.x < q.x, 'the left half\'s from the left, the right half\'s to the right');
  }
  // Where the ladder has room for both side by side: beside each other, on the far side of the line, clear of it.
  const [l, r] = placeProbeBoxes(two, 100, 700, 480);
  assert.ok(l && r && l.y === r.y && l.y === 114 && l.x + 230 <= r.x, JSON.stringify([l, r]));
  // One box alone: from its own half's edge, on the far side of the line.
  assert.deepEqual(placeProbeBoxes([null, two[1]], 300, 330, 480), [null, { x: 330 - 8 - 230, y: 300 - 14 - 120 }]);
  assert.deepEqual(placeProbeBoxes([two[0], null], 100, 330, 480), [{ x: 8, y: 114 }, null]);
});
