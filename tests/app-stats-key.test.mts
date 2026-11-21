import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { settingsIcon } from '../src/app/pane-tune.ts';

// Bar stats' settings open from the sliders key every settings key wears (Karl, 2026-11-20: a button reading "Stats" beside the pane's name
// "Bar stats" read as part of the name, and the settings were not found). Pinned by the source, as the side headers are (app-side-head).
const read = (name: string): string => fs.readFileSync(path.join(process.cwd(), 'src', 'app', name), 'utf8');
const panes = read('panes/lower-panes.ts'), cvd = read('panes/cvd-pane.ts'), css = read('styles.css'), mobile = read('mobile.css'), chrome = read('chrome.css');

test('the Bar stats header opens its settings from a sliders key that says what it opens', () => {
  assert.ok(panes.includes("this.#button.className = 'icon-btn stats-gear'"), 'the key is an icon button of its own class');
  assert.ok(panes.includes("this.#button.setAttribute('aria-label', `${t('Settings')}: ${t('Bar stats')}`)"), 'a screen reader hears whose settings it opens');
  assert.ok(panes.includes('this.#button.innerHTML = settingsIcon(15)'), 'it wears the shared sliders');
  assert.equal(/#button\.textContent\s*=\s*t\('Stats'\)/.test(panes), false, 'and no longer the word Stats');
  assert.ok(cvd.includes('this.#gear.innerHTML = settingsIcon(15)'), "the flow column's key wears the same sliders");
});

test('the key is sized as a header key on a desktop, drawn in pixels on Classic 95, and comes before the "?" on a phone', () => {
  assert.match(css, /\.pane\.bars \.pane-head > \.stats-gear \{[^}]*width: var\(--head-key\); height: var\(--head-key\)/);
  assert.match(chrome, /\.pane\.bars \.pane-head > \.stats-gear > svg \{ display: none; \}/);
  assert.match(chrome, /\.pane\.bars \.pane-head > \.stats-gear::before/);
  assert.match(mobile, /\.pane\.bars \.pane-head \.stats-gear \{ order: 1;[^}]*margin-left: auto;/);
  assert.match(mobile, /\.pane\.bars \.pane-head:not\(\.tuned\) > strong \+ button\.help \{ order: 2; margin-left: 0; \}/);
});

test('the shared sliders are one drawing at any size', () => {
  const icon = settingsIcon(15);
  assert.ok(icon.startsWith('<svg') && icon.includes('width="15" height="15"') && icon.includes('aria-hidden="true"'));
  assert.equal(settingsIcon(18).replace(/18/g, '15'), icon, 'only the size differs');
});
