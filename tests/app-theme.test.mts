import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_THEME, PHONE_DARK_THEME, autoTheme, flippedTheme, initialState, themeChange } from '../src/app/store.ts';
import { CAUTION, FRAMES, FRAME_STRENGTH, PALETTES, THEME_ORDER, chromeFor, mixHex, resolveThemeId, rgb, textOn, themeColorOf, themeVars, type Palette } from '../src/app/theme.ts';
import { WEAK_ALPHA, emphasisRamps } from '../src/app/traded/emphasis.ts';

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
    if (key === 'label' || key === 'dark' || key === 'frame' || key === 'chrome') continue;
    assert.match(String(value), /^#[0-9a-f]{6}$/i, `${id}.${key}`);
  }
});

test('text, muted text, accents and the buy / sell colours are legible on the background and panel of every theme', () => {
  for (const [id, p] of Object.entries(PALETTES)) {
    for (const surface of [p.bg, p.panel]) {
      assert.ok(contrast(p.text, surface) >= 7, `${id}: text ${contrast(p.text, surface).toFixed(2)} on ${surface}`);
      assert.ok(contrast(p.muted, surface) >= 4.5, `${id}: muted ${contrast(p.muted, surface).toFixed(2)} on ${surface}`);
      for (const key of ['accent', 'ui', 'bid', 'ask', 'candleUp', 'candleDown', 'poc', 'level', 'vwap'] as const) assert.ok(contrast(p[key], surface) >= 3, `${id}: ${key} ${contrast(p[key], surface).toFixed(2)} on ${surface}`);
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

test('every theme is drawn in one of the frames, only the classic desktop is bevelled, and its own tones arrive at full strength', () => {
  for (const [id, p] of Object.entries(PALETTES)) {
    assert.ok(FRAMES.includes(p.frame), `${id}: frame ${p.frame}`);
    if (p.frame === 'bevel') assert.equal(id, 'classic', `${id}: the raised look is the classic theme's alone`);
    for (const [key, pin] of Object.entries(p.chrome ?? {})) {
      const full = chromeFor(p, 1) as unknown as Record<string, string>;
      assert.equal(full[key], pin, `${id}: ${key} is the palette's own at full strength`);
    }
  }
  assert.equal(FRAME_STRENGTH.bevel, 1);
  for (const frame of ['editor', 'paper', 'textmode'] as const) assert.ok(FRAME_STRENGTH[frame] < 1, `${frame} is flatter than the bevel`);
  const classic = chromeFor(PALETTES.classic!);
  assert.equal(classic.face, '#c0c0c0'); assert.equal(classic.bar, '#000080');
});

test('mixing moves a colour part of the way to another and stops at both ends', () => {
  assert.equal(mixHex('#000000', '#ffffff', 0), '#000000');
  assert.equal(mixHex('#000000', '#ffffff', 1), '#ffffff');
  assert.equal(mixHex('#000000', '#ffffff', 0.5), '#808080');
  assert.equal(mixHex('#102030', '#102030', 0.7), '#102030');
  assert.equal(mixHex('#000000', '#ffffff', 7), '#ffffff', 'an amount past 1 is 1');
});

test('the edges of controls are visible against the panel in every theme, and what text sits on a face or a title bar stays legible', () => {
  for (const [id, p] of Object.entries(PALETTES)) {
    const c = chromeFor(p);
    assert.ok(contrast(c.edge, p.panel) >= 3, `${id}: edge ${contrast(c.edge, p.panel).toFixed(2)} on the panel`);
    assert.ok(luminance(c.hi) > luminance(c.lo), `${id}: the lit edge is lighter than the shaded one`);
    for (const surface of [c.face, c.title, c.well]) {
      assert.ok(contrast(p.text, surface) >= 7, `${id}: text ${contrast(p.text, surface).toFixed(2)} on ${surface}`);
      assert.ok(contrast(p.muted, surface) >= 4.5, `${id}: muted ${contrast(p.muted, surface).toFixed(2)} on ${surface}`);
    }
    assert.ok(contrast(c.barText, c.bar) >= 7, `${id}: title text ${contrast(c.barText, c.bar).toFixed(2)} on its bar`);
    for (const tone of [c.edge, c.hi, c.lo, c.face, c.title, c.well, c.bar, c.barText]) assert.match(tone, /^#[0-9a-f]{6}$/, id);
    assert.match(c.shadow, /^rgba\(0, 0, 0, 0\.\d\d\)$/);
  }
});

test('at strength 0 the page is flat: the lit and shaded edges and the faces are the panel itself', () => {
  for (const [id, p] of Object.entries(PALETTES)) {
    const flat = chromeFor(p, 0);
    for (const tone of [flat.hi, flat.lo, flat.face, flat.title]) assert.equal(tone, p.panel, id);
    assert.equal(flat.shadow, 'rgba(0, 0, 0, 0.00)');
    const full = chromeFor(p, 1), half = chromeFor(p, 0.5);
    assert.ok(Math.abs(luminance(half.lo) - luminance(p.panel)) < Math.abs(luminance(full.lo) - luminance(p.panel)), `${id}: half strength is between flat and full`);
  }
});

test('text on a colour is whichever of near-black and white reads better on it', () => {
  const on = (bg: string): Palette => ({ ...Object.values(PALETTES)[0]!, bg });
  for (const c of ['#ffffff', '#000000', '#ff0000', '#2f6fd6', '#16a34a', '#e11d48', '#f59e0b', '#7c3aed', '#808080', '#5a5a5a']) {
    const text = textOn(c, 1, on('#000000'));
    const other = text === '#ffffff' ? '#121418' : '#ffffff';
    assert.ok(contrast(text, c) >= contrast(other, c), `${c}: ${text}`);
  }
  assert.equal(textOn('#ff0000', 1, on('#000000')), '#121418', 'pure red: dark text reads better (4.7 against 4.0)');
  assert.equal(textOn('#ffffff', 0, on('#000000')), '#ffffff', 'fully transparent: the background decides');
});

test(`what is written on the accent (a lit segment, a pin, a chosen row's number) reads on it in every theme, and the page gets it as --on-ui`, () => {
  for (const [id, p] of Object.entries(PALETTES)) {
    const vars = themeVars(p), on = vars.onUi!;
    assert.equal(on, textOn(p.ui, 1, p), id);
    // Light's own blue gives white 4.4998:1, the best either tone can do on it: 4.50 as it is written everywhere, so the ratio is read to two decimals.
    assert.ok(Math.round(contrast(on, p.ui) * 100) / 100 >= 4.5, `${id}: ${on} on the accent ${p.ui} is ${contrast(on, p.ui).toFixed(4)}`);
  }
});

test('the warning tone reads on the panel, the face and the title strip of every theme, and is the sell colour itself where that already reads', () => {
  for (const [id, p] of Object.entries(PALETTES)) {
    const c = chromeFor(p), surfaces = [p.panel, c.face, c.title];
    assert.match(c.warn, /^#[0-9a-f]{6}$/, id);
    for (const surface of surfaces) assert.ok(contrast(c.warn, surface) >= 4.5, `${id}: warning ${c.warn} on ${surface} is ${contrast(c.warn, surface).toFixed(2)}`);
    if (surfaces.every(surface => contrast(p.ask, surface) >= 4.6)) assert.equal(c.warn, p.ask, `${id}: the sell colour already reads, so it is left as it is`);
    assert.equal(themeVars(p).warn, c.warn, `${id}: the page gets the same tone`);
  }
  const classic = PALETTES.classic!;
  assert.equal(chromeFor(classic).warn, classic.ask, `the classic desktop's maroon already reads on its grey`);
});

test('a caution is amber that reads on the panel, the face and the title strip of every theme, never the sell colour', () => {
  for (const [id, p] of Object.entries(PALETTES)) {
    const c = chromeFor(p), surfaces = [p.panel, c.face, c.title];
    assert.match(c.caution, /^#[0-9a-f]{6}$/, id);
    for (const surface of surfaces) assert.ok(contrast(c.caution, surface) >= 4.5, `${id}: caution ${c.caution} on ${surface} is ${contrast(c.caution, surface).toFixed(2)}`);
    if (surfaces.every(surface => contrast(CAUTION, surface) >= 4.6)) assert.equal(c.caution, CAUTION, `${id}: the amber already reads, so it is left as it is`);
    assert.equal(themeVars(p).caution, c.caution, `${id}: the page gets the same tone`);
  }
});

test(`the browser's own bars take the page's colour, and in the bevel frame the grey of the top bar`, () => {
  for (const [id, p] of Object.entries(PALETTES)) assert.equal(themeColorOf(p), p.frame === 'bevel' ? chromeFor(p).face : p.bg, id);
  assert.equal(themeColorOf(PALETTES.classic!), '#c0c0c0');
  assert.equal(themeColorOf(PALETTES.light!), PALETTES.light!.bg);
  assert.equal(themeColorOf(PALETTES.terminal!), PALETTES.terminal!.bg);
});

test('a page opens in Light, and a saved Terminal that was never picked (written while it was the default) goes back to it', () => {
  const real = (globalThis as { window?: unknown }).window;
  const load = (saved: Record<string, unknown> | null): { theme: string; themePicked: boolean } => {
    (globalThis as { window?: unknown }).window = { innerWidth: 1600, localStorage: { getItem: () => saved ? JSON.stringify(saved) : null, setItem: () => {} } };
    const state = initialState();
    return { theme: state.theme, themePicked: state.themePicked };
  };
  try {
    assert.equal(DEFAULT_THEME, 'light');
    assert.deepEqual(load(null), { theme: 'light', themePicked: false });
    assert.deepEqual(load({ theme: 'terminal' }), { theme: 'light', themePicked: false });
    assert.deepEqual(load({ theme: 'terminal', themePicked: true }), { theme: 'terminal', themePicked: true });
    // Any other theme saved without the flag was picked before the flag existed: it stays, and now counts as picked.
    assert.deepEqual(load({ theme: 'dark' }), { theme: 'dark', themePicked: true });
    assert.deepEqual(load({ theme: 'no-such-theme' }), { theme: 'light', themePicked: false });
  } finally {
    if (real === undefined) delete (globalThis as { window?: unknown }).window; else (globalThis as { window?: unknown }).window = real;
  }
});

test('a phone follows its own light or dark setting until a theme is picked, dark being Terminal; a desktop opens in Light', () => {
  const real = { window: (globalThis as { window?: unknown }).window, matchMedia: (globalThis as { matchMedia?: unknown }).matchMedia };
  const load = (saved: Record<string, unknown> | null, phone: boolean, dark: boolean): { theme: string; themePicked: boolean; slots: { light: string; dark: string } } => {
    (globalThis as { window?: unknown }).window = { innerWidth: phone ? 390 : 1600, localStorage: { getItem: () => saved ? JSON.stringify(saved) : null, setItem: () => {} } };
    (globalThis as { matchMedia?: unknown }).matchMedia = (q: string) => ({ matches: q.includes('prefers-color-scheme: dark') && dark, addEventListener: () => {} });
    const state = initialState(phone, phone);
    return { theme: state.theme, themePicked: state.themePicked, slots: state.themeSlots };
  };
  try {
    assert.equal(autoTheme(true, true), 'terminal'); assert.equal(autoTheme(true, false), 'light'); assert.equal(autoTheme(false, true), 'light');
    assert.equal(PALETTES[PHONE_DARK_THEME]!.dark, true);
    assert.deepEqual(load(null, true, true), { theme: 'terminal', themePicked: false, slots: { light: 'light', dark: 'terminal' } });
    assert.deepEqual(load(null, true, false), { theme: 'light', themePicked: false, slots: { light: 'light', dark: 'terminal' } });
    assert.equal(load(null, false, true).theme, 'light');
    // The default written down with everything else follows the phone again; a pick stays whatever the phone says.
    assert.equal(load({ theme: 'light' }, true, true).theme, 'terminal');
    assert.equal(load({ theme: 'terminal' }, true, false).theme, 'light');
    assert.deepEqual(load({ theme: 'light', themePicked: true }, true, true), { theme: 'light', themePicked: true, slots: { light: 'light', dark: 'terminal' } });
    // The remembered themes keep their kind: a light one is no dark slot.
    assert.deepEqual(load({ theme: 'midnight', themePicked: true, themeSlots: { light: 'terminal', dark: 'amber' } }, true, false).slots, { light: 'light', dark: 'midnight' });
  } finally {
    if (real.window === undefined) delete (globalThis as { window?: unknown }).window; else (globalThis as { window?: unknown }).window = real.window;
    if (real.matchMedia === undefined) delete (globalThis as { matchMedia?: unknown }).matchMedia; else (globalThis as { matchMedia?: unknown }).matchMedia = real.matchMedia;
  }
});

test('the light-or-dark key swaps the light theme and the dark one last shown', () => {
  const slots = { light: 'light', dark: 'terminal' };
  assert.equal(flippedTheme({ theme: 'light', themeSlots: slots }), 'terminal');
  assert.equal(flippedTheme({ theme: 'terminal', themeSlots: slots }), 'light');
  // Picking Midnight remembers it as the dark one: Light, then the key, brings Midnight back, not Terminal.
  const picked = themeChange({ themeSlots: slots }, 'midnight', true);
  assert.deepEqual(picked, { theme: 'midnight', themePicked: true, themeSlots: { light: 'light', dark: 'midnight' } });
  const toLight = themeChange(picked, flippedTheme(picked), true);
  assert.deepEqual(toLight.theme, 'light');
  assert.equal(flippedTheme(toLight), 'midnight');
});

test('the stronger side of a split bar, fully one-sided, keeps its contrast in every theme, and the weaker side stays in sight', () => {
  for (const id of THEME_ORDER) {
    const p = PALETTES[id]!, ramps = emphasisRamps(p);
    for (const side of ['bid', 'ask'] as const) {
      const strong = ramps[side][ramps[side].length - 1]!;
      for (const surface of [p.bg, p.panel]) {
        // Toward the text colour, away from the background: never less contrast than the side's own colour, which the rule above holds at 3.
        assert.ok(contrast(strong, surface) >= Math.max(3, contrast(p[side], surface) - 0.01), `${id}: the stronger ${side} ${strong} at ${contrast(strong, surface).toFixed(2)} on ${surface}`);
      }
      // The weaker side at its dimmest (0.35) over the panel: faint, never gone.
      const weak = mixHex(p.panel, p[side], WEAK_ALPHA);
      assert.ok(contrast(weak, p.panel) >= 1.2, `${id}: the weaker ${side} at ${WEAK_ALPHA} is ${contrast(weak, p.panel).toFixed(2)} on the panel`);
    }
  }
});
