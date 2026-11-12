import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

// Karl, 2026-11-12 ("each button a precious resource"): the heatmap's colour range (Auto) and smoothing left the full bar for a settings key
// at the end of the colour scale; a phone's Settings keeps them as rows. Read from the source, as the toolbar is built in a page.
const toolbar = fs.readFileSync('src/app/toolbar.ts', 'utf8'), css = fs.readFileSync('src/app/styles.css', 'utf8');

/** The body of a method of the toolbar, from its signature to the next member's start (fails loudly when either is not found). */
function method(signature: string): string {
  const start = toolbar.indexOf(signature);
  assert.ok(start >= 0, `${signature} is in toolbar.ts`);
  const end = toolbar.indexOf('\n  }\n', start);
  assert.ok(end > start, `${signature} ends`);
  return toolbar.slice(start, end);
}

test('the full bar\'s Heatmap deck holds its menus over the colour scale with its settings key, and no Auto or Smoothing control', () => {
  const deck = toolbar.split('\n').find(l => l.includes("deck('heat', t('Heatmap')"));
  assert.ok(deck, 'the Heatmap deck is one line of toolbar.ts');
  assert.ok(deck.includes('[this.#heatSplit]'), 'its second row is the colour scale with the key at its end');
  assert.ok(!deck.includes('#heat.auto') && !deck.includes('#heat.smooth'), 'no Auto lamp or Smoothing menu in the bar');
  // Every arrangement of the full bar gathers the controls first and then pairs the scale with the key: the other way round, the gathering
  // would take the scale back out of the pair and leave the key alone.
  const arrange = method('#arrange(): void {');
  const gather = arrange.indexOf('this.#fillHeatControls();'), pair = arrange.indexOf('this.#heatSplit.replaceChildren(this.#heatScale, this.#heatKey);');
  assert.ok(gather >= 0 && pair > gather, 'the scale is paired with the key after the controls are gathered');
});

test('the key opens a panel that offers the colour range and the smoothing as Auto or Off, written to the store', () => {
  assert.match(toolbar, /this\.#heatKey\.onclick = \(\) => \{\s*const build = \(tools: HTMLElement, body: HTMLElement\): void => this\.#buildHeat\(tools, body\);/);
  const panel = method('#buildHeat(tools: HTMLElement, body: HTMLElement): void {');
  assert.match(panel, /\[\['auto', t\('Auto'\)\], \['off', t\('Off'\)\]\]/);
  assert.match(panel, /selectRow\(t\('Colour range'\), COLOUR_RANGE_TIP, choices, h\.auto \? 'auto' : 'off', v => set\(\{ auto: v === 'auto' \}\)\)/);
  assert.match(panel, /selectRow\(t\('Smoothing'\), SMOOTHING_TIP, choices, h\.smooth, v => set\(\{ smooth: v === 'off' \? 'off' : 'auto' \}\)\)/);
  assert.match(panel, /\{ heat: \{ \.\.\.this\.store\.state\.heat, \.\.\.change \} \}/, 'a choice keeps the heatmap\'s other settings');
});

test('a phone\'s Settings keeps the colour range and the smoothing as rows of their own, with the same tips', () => {
  assert.match(toolbar, /field\(t\('Colour range'\), this\.#heat\.auto\)/);
  assert.match(toolbar, /field\(t\('Smoothing'\), this\.#heat\.smooth\)/);
  assert.match(toolbar, /auto: el\('button', \{ class: 'led-btn', textContent: t\('Auto'\), tip: COLOUR_RANGE_TIP \}\)/);
  assert.match(toolbar, /smooth: el\('select', \{ ariaLabel: t\('Smoothing'\), tip: SMOOTHING_TIP \}\)/);
});

test('Source keeps its held width in the deck\'s grid, so the deck does not widen as venues connect', () => {
  assert.match(css, /\.toolbar \.deck\.deck-grid\.deck-heat > \.deck-row > select\.heat-source \{ width: 96px; \}/);
  assert.match(css, /\.toolbar\.cockpit\.wrapped:not\(\.fitting\) \.deck\.deck-grid\.deck-heat > \.deck-row > select\.heat-source \{ min-width: 100%; \}/);
});
