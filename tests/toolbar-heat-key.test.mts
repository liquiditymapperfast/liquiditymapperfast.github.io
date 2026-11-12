import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

// Karl, 2026-11-12 ("each button a precious resource"): the heatmap's colour range (Auto) and smoothing left the full bar for a settings key
// at the end of the colour scale; a phone's Settings keeps them as rows. Read from the source, as the toolbar is built in a page.
const toolbar = fs.readFileSync('src/app/toolbar.ts', 'utf8');

test('the full bar\'s Heatmap deck holds its menus over the colour scale with its settings key, and no Auto or Smoothing control', () => {
  const deck = toolbar.split('\n').find(l => l.includes("deck('heat', t('Heatmap')"));
  assert.ok(deck, 'the Heatmap deck is one line of toolbar.ts');
  assert.ok(deck.includes('[this.#heatSplit]'), 'its second row is the colour scale with the key at its end');
  assert.ok(!deck.includes('#heat.auto') && !deck.includes('#heat.smooth'), 'no Auto lamp or Smoothing menu in the bar');
  assert.match(toolbar, /this\.#heatSplit\.replaceChildren\(this\.#heatScale, this\.#heatKey\)/, 'the scale comes back to the key on every arrangement of the full bar');
});

test('the key\'s panel offers the colour range and the smoothing as Auto or Off, with the tips Settings shows', () => {
  const panel = toolbar.slice(toolbar.indexOf('#buildHeat(tools: HTMLElement'), toolbar.indexOf('#buildWaves(_tools'));
  assert.match(panel, /selectRow\(t\('Colour range'\), COLOUR_RANGE_TIP, choices, h\.auto \? 'auto' : 'off'/);
  assert.match(panel, /selectRow\(t\('Smoothing'\), SMOOTHING_TIP, choices, h\.smooth/);
  assert.match(panel, /\[\['auto', t\('Auto'\)\], \['off', t\('Off'\)\]\]/);
});

test('a phone\'s Settings keeps the colour range and the smoothing as rows of their own', () => {
  assert.match(toolbar, /field\(t\('Colour range'\), this\.#heat\.auto\)/);
  assert.match(toolbar, /field\(t\('Smoothing'\), this\.#heat\.smooth\)/);
  assert.match(toolbar, /auto: el\('button', \{ class: 'led-btn', textContent: t\('Auto'\), tip: COLOUR_RANGE_TIP \}\)/);
  assert.match(toolbar, /smooth: el\('select', \{ ariaLabel: t\('Smoothing'\), tip: SMOOTHING_TIP \}\)/);
});
