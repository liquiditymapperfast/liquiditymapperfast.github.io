import test from 'node:test';
import assert from 'node:assert/strict';
import { PALETTES, THEME_ORDER, resolveThemeId, rgb } from '../src/app/theme.ts';

const luminance = (hex: string): number => {
  const [r, g, b] = rgb(hex).map(c => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4)) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const contrast = (a: string, b: string): number => { const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number]; return (hi + 0.05) / (lo + 0.05); };

test('every theme is complete, listed once, and has a distinct name', () => {
  assert.deepEqual([...THEME_ORDER].sort(), Object.keys(PALETTES).sort());
  const labels = Object.values(PALETTES).map(p => p.label);
  assert.equal(new Set(labels).size, labels.length);
  for (const [id, p] of Object.entries(PALETTES)) for (const [key, value] of Object.entries(p)) {
    if (key === 'label' || key === 'dark') continue;
    assert.match(String(value), /^#[0-9a-f]{6}$/i, `${id}.${key}`);
  }
});

test('text, muted text, accents and the buy / sell colours are legible on the background and panel of every theme', () => {
  for (const [id, p] of Object.entries(PALETTES)) {
    for (const surface of [p.bg, p.panel]) {
      assert.ok(contrast(p.text, surface) >= 7, `${id}: text ${contrast(p.text, surface).toFixed(2)} on ${surface}`);
      assert.ok(contrast(p.muted, surface) >= 4.5, `${id}: muted ${contrast(p.muted, surface).toFixed(2)} on ${surface}`);
      for (const key of ['accent', 'ui', 'bid', 'ask', 'candleUp', 'candleDown'] as const) assert.ok(contrast(p[key], surface) >= 3, `${id}: ${key} ${contrast(p[key], surface).toFixed(2)} on ${surface}`);
    }
    assert.equal(p.dark, luminance(p.bg) < 0.18, `${id}: the dark flag matches the background`);
  }
});

test('buy and sell stay distinguishable in the colour-blind safe theme (blue against orange, not red against green)', () => {
  const p = PALETTES.colorblind!;
  const [br, bg, bb] = rgb(p.bid), [ar, ag, ab] = rgb(p.ask);
  assert.ok(bb > br && bb > ar && ar > ab, 'buy is blue-dominant, sell is red-orange-dominant');
  assert.ok(Math.hypot(br - ar, bg - ag, bb - ab) > 0.6, 'far apart in hue, not just lightness');
});

test('ids from earlier builds still resolve, and anything unknown falls back to light', () => {
  assert.equal(resolveThemeId('legacyLight'), 'light');
  assert.equal(resolveThemeId('darkSurf'), 'dark');
  assert.equal(resolveThemeId('darkTerminal'), 'terminal');
  assert.equal(resolveThemeId('darkerDark'), 'darker');
  assert.equal(resolveThemeId('mocha'), 'mocha');
  assert.equal(resolveThemeId('nope'), 'light');
  assert.equal(resolveThemeId(undefined), 'light');
});
