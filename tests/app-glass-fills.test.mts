import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const read = (name: string): string => fs.readFileSync(path.join(process.cwd(), 'src', 'app', name), 'utf8');

/** The rule of the Glass material that gives a control a see-through face (chrome.css): the one line that can take a control's own fill away. */
const glassRule = read('chrome.css').split('\n').find(line => line.startsWith('html[data-material="glass"] :is(.toolbar') && line.includes('background-color: color-mix')) ?? '';

/** The controls that are filled with the accent in the bars and panels but are not buttons the glass reaches: each lives in a dialog of its own, outside every bar, panel and menu. */
const OUTSIDE_THE_BARS = new Set(['.guide-tour', '.tour-next']);

/** A selector's last compound (what the rule is about), the commas and combinators inside brackets left alone. */
function lastCompound(selector: string): string {
  let depth = 0, cut = -1;
  for (let i = 0; i < selector.length; i++) {
    const c = selector[i]!;
    if (c === '(' || c === '[') depth++; else if (c === ')' || c === ']') depth--;
    else if (depth === 0 && (c === ' ' || c === '>' || c === '+' || c === '~')) cut = i;
  }
  return selector.slice(cut + 1).trim();
}
function heads(list: string): string[] {
  const out: string[] = []; let depth = 0, from = 0;
  for (let i = 0; i < list.length; i++) {
    const c = list[i]!;
    if (c === '(' || c === '[') depth++; else if (c === ')' || c === ']') depth--;
    else if (c === ',' && depth === 0) { out.push(list.slice(from, i).trim()); from = i + 1; }
  }
  out.push(list.slice(from).trim());
  return out;
}

/**
 * Every button the style sheets fill with the accent (`background: var(--ui)`) outside its lit state `.on`, named by its classes and the pseudo-class when the
 * fill is only that state's (".tour-btn", ".install:hover").
 */
function accentFilled(): string[] {
  const out: string[] = [];
  for (const file of ['styles.css', 'mobile.css']) for (const raw of read(file).split('\n')) {
    const m = raw.trim().match(/^([^@{}][^{}]*)\{([^{}]*)\}$/);
    if (!m || !/background:\s*var\(--ui\)/.test(m[2]!)) continue;
    for (const selector of heads(m[1]!)) {
      const last = lastCompound(selector);
      if (!/^button\b/.test(last)) continue;
      const classes = [...last.matchAll(/\.([\w-]+)/g)].map(c => c[1]!);
      if (classes.includes('on')) continue;
      out.push(classes.map(c => `.${c}`).join('') + (last.match(/:(?:hover|active|focus-visible)\b/)?.[0] ?? ''));
    }
  }
  return out;
}

test('the Glass material keeps the fill of every control that is lit, held, or painted the accent', () => {
  assert.ok(glassRule, 'the rule that gives controls their see-through face is where this test looks for it');
  for (const kept of ['.on', '.help', '.menu-item', '.chip', '.dock-tab']) assert.ok(glassRule.includes(`:not(${kept})`), `${kept} keeps its own look on glass`);
  // Karl, 2026-11-01: the toolbar's Tour and the invitation's Take the tour were white on a pale glass face (and near-black on a dark one) in most themes.
  const filled = accentFilled();
  for (const key of filled) assert.ok(OUTSIDE_THE_BARS.has(key) || glassRule.includes(`:not(${key})`), `${key} is filled with the accent: the glass rule must leave it alone (or it belongs to OUTSIDE_THE_BARS)`);
  for (const key of ['.tour-btn', '.tour-invite-go', '.install:hover']) assert.ok(filled.includes(key), `${key} was found among the accent-filled buttons (the scan still reads the rules it is meant to)`);
});

test('the Glass material leaves a pressed button alone: the text-mode frame inverts it, its label the page colour on the face it no longer has', () => {
  assert.ok(glassRule.includes(':not(:active)'));
  assert.ok(read('chrome.css').includes(':where([data-frame="textmode"]) button:active:not(:disabled) { background: var(--text); color: var(--bg); }'), 'the rule this protects is still there');
});

test('a button filled with the accent keeps a fill its label reads on while it is held: the held rule of the frames does not reach it', () => {
  // The Editor and Paper frames hold a button in a grey, Text mode inverts it: white (or near-black) on either is 1.3:1. Every filled button is named in the rule that keeps its fill.
  const held = read('chrome.css').split('\n').find(line => line.includes(':active:not(:disabled) { background: color-mix(in srgb, var(--ui) 86%, var(--text))')) ?? '';
  assert.ok(held, 'the held rule of the filled buttons is in chrome.css');
  const plain = accentFilled().filter(key => !key.includes(':'));
  assert.ok(plain.length >= 4, 'the four filled buttons of the tour were found');
  for (const key of plain) assert.ok(held.includes(`${key}`), `${key} is filled with the accent: chrome.css's held rule for filled buttons must name it`);
  assert.ok(held.includes('color: var(--on-ui, #fff)'), 'and keeps the label the accent is written on');
});

test('the arrows that fold and unfold the bar keep a label that reads while they are held (Text mode inverts a held button, and the arrow lies on the panel colour)', () => {
  const css = read('styles.css');
  assert.ok(css.includes('.toolbar .bar-collapse:active, .toolbar .bar-expand:active { color: var(--text); }'), 'a held arrow is in the text colour');
});

test('Both / Spot / Perp and the Tour are filled with the accent only in a phone\'s Settings: in the top bar they light as its other chosen buttons do', () => {
  // Karl, 2026-11-13: Both and Tour stayed the same blue in every theme beside the timeframes and the panels' buttons. Only the phone's Settings keeps filled ones.
  const filling = (read('styles.css') + '\n' + read('mobile.css')).split('\n').filter(line => /background:\s*var\(--ui\)/.test(line) && /\.(scope|tour-btn)\b/.test(line));
  assert.ok(filling.length >= 2, 'the phone Settings rules that fill them are still found');
  for (const line of filling) {
    const selectors = line.slice(0, line.indexOf('{')).split(',').map(s => s.trim()).filter(s => /\.(scope|tour-btn)\b/.test(s));
    for (const s of selectors) assert.ok(/^(:where\(\.sheet\)|\.sheet|\.sheet-tiles)[\s>]/.test(s), `${s} fills with the accent outside a phone's Settings`);
  }
  const toolbar = fs.readFileSync(path.join(process.cwd(), 'src', 'app', 'toolbar.ts'), 'utf8');
  assert.ok(toolbar.includes("this.#tour.classList.toggle('on', !compactBar());"), 'the Tour is lit while it is in the bar, and a filled tile in the Settings sheet');
});
