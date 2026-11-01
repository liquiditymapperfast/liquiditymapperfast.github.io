import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const read = (name: string): string => fs.readFileSync(path.join(process.cwd(), 'src', 'app', name), 'utf8');
const css = read('styles.css'), mobile = read('mobile.css'), chrome = read('chrome.css'), layout = read('layout.ts');

/**
 * How wide (px, the header's content box) the first line of a side pane's header needs once the pane's first controls join it, in the widest
 * of the eleven languages, measured in headless Chrome on 2026-11-01 with the flow column's span buttons at their least (their own minimum
 * width, which the tier's `min-width` on them then gives): Flow = its name, the "?", the span buttons, the settings key, the menu and the close
 * button (Italian); Book = its name, the "?", the mode, Recenter, the menu and the close button (Russian). A touch screen's buttons are bigger.
 * A tier that starts under this lets the menu and the close button drop to the second line in that language.
 */
const WIDEST = { mouse: { cvd: 387, ladder: 442 }, touch: { cvd: 496, ladder: 520 } };
/** The room a tier keeps beyond that: other system fonts draw the same words a few per cent wider. */
const MARGIN = 1.05;

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
/** The text of the `{ ... }` block that opens at `open` (the index of its `{`), the braces inside counted. */
function blockAt(text: string, open: number): string {
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    if (text[i] === '{') depth++;
    else if (text[i] === '}' && --depth === 0) return text.slice(open + 1, i);
  }
  throw new Error('a block that does not end');
}
/** Where each wide tier of the side headers starts, by the pointer it is for and the pane: the `@container sidehead (min-width: Npx)` blocks inside the two `@media` rules. */
function tiers(): { touch: boolean; pane: 'cvd' | 'ladder'; at: number; min: number | null; body: string }[] {
  const out: { touch: boolean; pane: 'cvd' | 'ladder'; at: number; min: number | null; body: string }[] = [];
  for (const m of css.matchAll(/@media (not all and )?\(pointer: coarse\) \{/g)) {
    const body = blockAt(css, m.index! + m[0].length - 1);
    for (const c of body.matchAll(/@container sidehead \(min-width: (\d+)px\) \{/g)) {
      const inner = blockAt(body, c.index! + c[0].length - 1);
      const pane = inner.includes('.pane.cvd .side-head') ? 'cvd' : inner.includes('.pane.ladder .side-head') ? 'ladder' : null;
      if (!pane) continue;
      const seg = /\.cvd-seg \{[^}]*min-width: (\d+)px/.exec(inner);
      out.push({ touch: !m[1], pane, at: Number(c[1]), min: seg ? Number(seg[1]) : null, body: inner });
    }
  }
  return out;
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
  const bare = css.replace(/\/\*[\s\S]*?\*\//g, '');
  for (const m of bare.matchAll(/([^{};]*\.side-head[^{};]*)\{/g)) {
    for (const selector of selectorsOf(m[1]!)) assert.ok(selector.startsWith('html[data-layout="desktop"]'), `a side-head selector outside the desktop arrangement: ${selector.slice(0, 90)}`);
  }
  assert.match(mobile, /html\[data-layout="desktop"\] \.pane-head\.side-head \{ --head-row-gap: 4px; \}/, 'a touch screen with the desktop arrangement keeps its tighter rows');
  assert.match(chrome, /:root\[data-frame="bevel"\]\[data-layout\^="phone"\] \.pane-head \.grip \{ display: none; \}/, 'the Bevel frame draws no handle on a phone, where the panes are tabs (its own rule for the handle is stronger than the phone\'s)');
});

test('each pane\'s wide tier starts where its widest first line fits in every language, with a margin; a touch screen\'s later, with its span buttons wider', () => {
  const found = tiers();
  assert.equal(found.length, 4, 'a tier for each pane and each kind of pointer');
  for (const pane of ['cvd', 'ladder'] as const) for (const touch of [false, true]) {
    assert.equal(found.filter(t => t.pane === pane && t.touch === touch).length, 1, `exactly one ${touch ? 'touch' : 'mouse'} tier for ${pane}`);
  }
  for (const t of found) {
    const need = WIDEST[t.touch ? 'touch' : 'mouse'][t.pane];
    assert.ok(t.at >= Math.ceil(need * MARGIN), `${t.pane}${t.touch ? ' (touch)' : ''}: the tier starts at ${t.at} px, the widest first line needs ${need} (x${MARGIN} = ${Math.ceil(need * MARGIN)})`);
    assert.ok(t.at <= 600, `${t.pane}${t.touch ? ' (touch)' : ''}: ${t.at} px leaves the usual columns of 460 to 740 px in the narrow arrangement`);
  }
  const seg = (touch: boolean): number | null => found.find(t => t.pane === 'cvd' && t.touch === touch)!.min;
  assert.ok(seg(false)! >= 200 && seg(true)! >= 265, 'the span buttons keep what their own text needs (Italian: 192 px with a mouse, 261 with a finger)');
});

test('each tier block carries every rule of its pane, for a mouse and for a finger alike', () => {
  const need = {
    cvd: ['.cvd-seg { order: 1;', '.cvd-gear { order: 2; }', '.pane-tools { order: 3; }', '.side-break { display: none; }'],
    ladder: ['label.ctl:first-of-type { order: 1; }', '.recenter-btn { order: 1; margin-left: 0; }'],
  };
  for (const t of tiers()) for (const rule of need[t.pane]) assert.ok(t.body.includes(rule), `${t.pane}${t.touch ? ' (touch)' : ''}: the tier lacks "${rule}"`);
});

test('the two columns take their minimum from the screen they are on: both calls pass isCoarse()', () => {
  assert.equal((layout.match(/minWidthOf\([^;\n]*, isCoarse\(\)\)/g) ?? []).length, 2, 'the drag and the fitting of the columns');
  assert.equal((layout.match(/minWidthOf\(/g) ?? []).length, 2, 'and there is no third call');
});

test('the name gives way before the first line breaks, so the menu and the close button stay on it', () => {
  assert.match(css, /\.side-head > strong \{ order: -1; flex: 1 1 0; min-width: 2\.2em; max-width: max-content;/);
});
