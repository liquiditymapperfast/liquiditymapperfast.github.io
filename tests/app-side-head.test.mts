import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const read = (name: string): string => fs.readFileSync(path.join(process.cwd(), 'src', 'app', name), 'utf8');
const css = read('styles.css'), mobile = read('mobile.css'), chrome = read('chrome.css'), layout = read('layout.ts');

/** A selector list split at its top-level commas (those inside parentheses belong to `:not(...)` and `:is(...)`). */
function selectorsOf(list: string): string[] {
  const out: string[] = []; let depth = 0, from = 0;
  for (let i = 0; i < list.length; i++) {
    const c = list[i]!;
    if (c === '(') depth++; else if (c === ')') depth--; else if (c === ',' && depth === 0) { out.push(list.slice(from, i).trim()); from = i + 1; }
  }
  out.push(list.slice(from).trim());
  return out.filter(Boolean);
}
const bare = css.replace(/\/\*[\s\S]*?\*\//g, '');

test('a side pane carries its handle, its menu and its close button in its own header, not in a bar of its own', () => {
  assert.equal(/pane-bar|has-bar/.test(layout), false, 'layout.ts makes no title bar');
  assert.equal(/pane-bar|has-bar/.test(css), false, 'and the stylesheet has no rule for one');
  assert.ok(layout.includes("handle.classList.add('side-head')"), 'the header is marked as a side pane\'s');
  assert.ok(layout.includes("'side-break'"), 'with the break that ends the first line');
  assert.ok(layout.includes('name.after(...rest)'), 'the menu and the close button come right behind the name, not at the end of the header (a rule of the header looks at its last child)');
});

test('the break is for the desktop arrangement only: a phone keeps the header it has', () => {
  assert.match(css, /\n\.side-break \{ display: none; \}/, 'the break is nothing until the desktop shows it');
  for (const m of bare.matchAll(/([^{};]*\.side-head[^{};]*)\{/g)) {
    for (const selector of selectorsOf(m[1]!)) assert.ok(selector.startsWith('html[data-layout="desktop"]'), `a side-head selector outside the desktop arrangement: ${selector.slice(0, 90)}`);
  }
  assert.match(mobile, /html\[data-layout="desktop"\] \.pane-head\.side-head \{ --head-row-gap: 4px; \}/, 'a touch screen with the desktop arrangement keeps its tighter rows');
  assert.match(chrome, /:root\[data-frame="bevel"\]\[data-layout\^="phone"\] \.pane-head \.grip \{ display: none; \}/, 'the Bevel frame draws no handle on a phone, where the panes are tabs (its own rule for the handle is stronger than the phone\'s)');
});

test('the controls of the book and the flow column are laid out by the fit grid, not by width tiers', () => {
  assert.equal(/@container sidehead/.test(css), false, 'no width tier is left');
  assert.equal(/container: sidehead/.test(css), false, 'and nothing names the container they used');
  for (const file of ['panes/ladder-pane.ts', 'panes/cvd-pane.ts']) {
    assert.ok(read(file).includes('new FitGrid(this.controls, cells, this.root)'), `${file} hands its cells to a fit grid that follows the pane's width`);
  }
  assert.ok(read('panes/cvd-pane.ts').includes("seg.dataset.fit = 'row'"), 'the span buttons are one cell that takes a whole row');
});

test('the fit grid is a box on the desktop only: on a phone its container is no box and the header keeps its own layout', () => {
  assert.match(css, /\n\.fit-cells \{ display: contents; \}/);
  let seen = 0;
  for (const m of bare.matchAll(/([^{};]*\.fit-(?:cells|inline|measuring)[^{};]*)\{/g)) {
    for (const selector of selectorsOf(m[1]!)) {
      if (selector === '.fit-cells') continue;
      seen++;
      assert.ok(selector.startsWith('html[data-layout="desktop"]'), `a fit-grid selector outside the desktop arrangement: ${selector.slice(0, 90)}`);
    }
  }
  assert.ok(seen >= 5, 'the desktop rules are there');
  assert.match(css, /\.fit-cells \{ display: grid;[^}]*row-gap: var\(--head-row-gap/, 'its rows keep the header\'s row gap (tighter on a touch screen)');
});

test('the two columns take their minimum from the screen they are on: both calls pass isCoarse()', () => {
  assert.equal((layout.match(/minWidthOf\([^;\n]*, isCoarse\(\)\)/g) ?? []).length, 2, 'the drag and the fitting of the columns');
  assert.equal((layout.match(/minWidthOf\(/g) ?? []).length, 2, 'and there is no third call');
});

test('the name gives way before the first line breaks, so the menu and the close button stay on it', () => {
  assert.match(css, /\.side-head > strong \{ order: -1; flex: 1 1 0; min-width: 2\.2em; max-width: max-content;/);
});

test('the book\'s recentre, cues and books are keys on the title\'s line, square marks on the desktop only, words on a phone\'s sheet', () => {
  const ladder = read('panes/ladder-pane.ts');
  for (const key of ['recenter.dataset.fit = \'key\'', 'this.#cuesButton.dataset.fit = \'key\'', 'this.#booksButton.dataset.fit = \'key\'']) assert.ok(ladder.includes(key), `${key} marks a key`);
  assert.ok(ladder.includes('const cells = el(\'div\', {}, mode, group, curves, show, pull);'), 'the cells are the choices only');
  assert.ok(ladder.includes('cells, recenter, this.#cuesButton, this.#booksButton);'), 'the keys are the header\'s own children, after the cells');
  let seen = 0;
  for (const m of bare.matchAll(/([^{};]*data-fit="key"[^{};]*)\{/g)) {
    for (const selector of selectorsOf(m[1]!)) { seen++; assert.ok(selector.startsWith('html[data-layout="desktop"]'), `a key selector outside the desktop arrangement: ${selector.slice(0, 90)}`); }
  }
  assert.ok(seen >= 4, 'the key rules are there');
  assert.match(css, /--mark-cues: url\(/);
  assert.match(css, /--mark-books: url\(/);
});
