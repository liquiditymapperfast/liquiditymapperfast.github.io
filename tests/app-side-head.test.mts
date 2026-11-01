import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const read = (name: string): string => fs.readFileSync(path.join(process.cwd(), 'src', 'app', name), 'utf8');
const css = read('styles.css'), mobile = read('mobile.css'), layout = read('layout.ts');

/**
 * How wide (px, the header's content box) the first line of a side pane's header needs once the pane's first controls join it, in the widest
 * of the eleven languages: measured in headless Chrome on 2026-11-01 (Flow: its name, the "?", the span buttons at their least, the settings key,
 * the menu and the close button, Italian; Book: its name, the "?", the mode, Recenter, the menu and the close button, Russian). A tier that starts
 * under this lets the menu and the close button drop to the second line in that language.
 */
const WIDEST = { cvd: 405, ladder: 428 };
/** The room a tier keeps beyond that: other system fonts draw the same words a few per cent wider. */
const MARGIN = 1.05;

/** The width a pane's wide tier starts at: the `@container sidehead (min-width: Npx)` block that has the pane's rules in it. */
function tierOf(pane: 'cvd' | 'ladder'): number {
  const blocks = [...css.matchAll(/@container sidehead \(min-width: (\d+)px\) \{\n([\s\S]*?)\n\}/g)];
  const mine = blocks.filter(b => b[2]!.includes(`.pane.${pane} .side-head`));
  assert.equal(mine.length, 1, `exactly one tier for ${pane}`);
  return Number(mine[0]![1]);
}

test('a side pane carries its handle, its menu and its close button in its own header, not in a bar of its own', () => {
  assert.equal(/pane-bar|has-bar/.test(layout), false, 'layout.ts makes no title bar');
  assert.equal(/pane-bar|has-bar/.test(css), false, 'and the stylesheet has no rule for one');
  assert.ok(layout.includes("handle.classList.add('side-head')"), 'the header is marked as a side pane\'s');
  assert.ok(layout.includes("'side-break'"), 'with the break that ends the first line');
  assert.ok(layout.includes('name.after(...rest)'), 'the menu and the close button come right behind the name, not at the end of the header (a rule of the header looks at its last child)');
});

test('the break and the tiers are for the desktop arrangement only: a phone keeps the header it has', () => {
  assert.match(css, /\n\.side-break \{ display: none; \}/, 'the break is nothing until the desktop shows it');
  for (const line of css.split('\n').filter(l => l.includes('.side-head'))) {
    assert.ok(line.startsWith('html[data-layout="desktop"]') || line.startsWith('  html[data-layout="desktop"]') || line.startsWith('/*') || line.startsWith('   '), `a side-head rule outside the desktop arrangement: ${line.slice(0, 90)}`);
  }
  assert.match(mobile, /html\[data-layout="desktop"\] \.pane-head\.side-head \{ --head-row-gap: 4px; \}/, 'a touch screen with the desktop arrangement keeps its tighter rows');
});

test('each pane\'s wide tier starts where its widest first line fits in every language, with a margin', () => {
  for (const pane of ['cvd', 'ladder'] as const) {
    const at = tierOf(pane);
    assert.ok(at >= Math.ceil(WIDEST[pane] * MARGIN), `${pane}: the tier starts at ${at} px, the widest first line needs ${WIDEST[pane]} (x${MARGIN} = ${Math.ceil(WIDEST[pane] * MARGIN)})`);
    assert.ok(at <= 560, `${pane}: ${at} px leaves a column of the usual 460 to 740 px in the narrow arrangement`);
  }
});

test('the name gives way before the first line breaks, so the menu and the close button stay on it', () => {
  assert.match(css, /\.side-head > strong \{ order: -1; flex: 1 1 0; min-width: 2\.2em; max-width: max-content;/);
});
