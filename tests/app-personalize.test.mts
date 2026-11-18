import test from 'node:test';
import assert from 'node:assert/strict';
import { PALETTES, THEME_ORDER, chromeFor, contrastRatio, isThemeId, paletteOf, resolveThemeId, setCustomPalettes, themeKey, themeVars } from '../src/app/theme.ts';
import { COLOR_KEYS, MAX_FILE_CHARS, MAX_THEMES, MUTED_RATIO, TEXT_RATIO, customPalette, exportThemes, importThemes, isDarkBackground, loadCustomThemes, mergeThemes, newTheme, putTheme, readCustomTheme, readCustomThemes, readable, registerCustomThemes, storeCustomThemes, themeWarnings, type CustomTheme } from '../src/app/custom-themes.ts';
import { BACKUP_FORMAT, MAX_BACKUP_CHARS, PENDING_KEY, backupFile, collectItems, queueRestore, readBackup, replaceAll, restoreResult, takeRestore } from '../src/app/backup.ts';
import { flippedTheme, initialState, slotsFor, themeChange } from '../src/app/store.ts';
import { laneColors } from '../src/app/cvd/colors.ts';
import { newGalleryState } from '../src/app/layouts/gallery.ts';
import { keepsSettings } from '../src/app/layouts/layouts.ts';
import { savedFields } from '../src/app/store.ts';
import { textSurfaces, surfacesClash } from '../src/app/custom-themes.ts';
import { RESTORED_KEY, backedKey } from '../src/app/backup.ts';

/** A seeded random source, so a failure can be run again. */
function rng(seed: number): () => number { let s = seed >>> 0; return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 2 ** 32; }; }
const hex = (r: () => number): string => `#${Math.floor(r() * 0x1000000).toString(16).padStart(6, '0')}`;
const copyWord = (shown: string): string => `${shown} copy`;

/** An in-memory Storage that holds at most `capacity` characters of keys and values, refusing a write past it as a full browser does. */
class MemoryStorage {
  map = new Map<string, string>();
  constructor(init: Record<string, string> = {}, public capacity = Infinity) { for (const [k, v] of Object.entries(init)) this.map.set(k, v); }
  size(): number { let n = 0; for (const [k, v] of this.map) n += k.length + v.length; return n; }
  get length(): number { return this.map.size; }
  key(i: number): string | null { return [...this.map.keys()][i] ?? null; }
  getItem(k: string): string | null { return this.map.get(k) ?? null; }
  setItem(k: string, v: string): void { const old = this.map.get(k); if (this.size() - (old === undefined ? 0 : k.length + old.length) + k.length + v.length > this.capacity) throw new Error('quota'); this.map.set(k, v); }
  removeItem(k: string): void { this.map.delete(k); }
  obj(): Record<string, string> { return Object.fromEntries(this.map); }
}

test.afterEach(() => setCustomPalettes({}));

test('a copy of every built-in theme draws exactly as the built-in one', () => {
  for (const id of THEME_ORDER) {
    const made = newTheme(id, [], copyWord, 1)!;
    assert.ok(made.id.startsWith('custom-'));
    assert.equal(made.name, `${PALETTES[id]!.label} copy`);
    const { palette, adjusted } = customPalette(made), p = PALETTES[id]!;
    assert.deepEqual(adjusted, [], `${id}: nothing needed to be made readable`);
    for (const key of COLOR_KEYS) assert.equal(palette[key], p[key], `${id}.${key}`);
    assert.equal(palette.dark, p.dark, `${id}: dark`); assert.equal(palette.frame, p.frame);
    assert.deepEqual(chromeFor(palette), chromeFor(p), `${id}: the same edges, faces and title bars`);
    // Through storage and back, and through a file and back.
    assert.deepEqual(readCustomTheme(JSON.parse(JSON.stringify(made))), made);
    const read = importThemes(exportThemes([made]));
    assert.ok('themes' in read);
    assert.deepEqual({ ...read.themes[0], id: made.id }, made);
  }
});

test('the dark rule is the one every built-in theme follows', () => {
  for (const [id, p] of Object.entries(PALETTES)) assert.equal(isDarkBackground(p.bg), p.dark, id);
});

test('a theme from a file is read colour by colour: broken colours come from its base, the frame must exist, the name is cleaned', () => {
  const t = readCustomTheme({ id: 'custom-abcd1234', name: '  My   theme ', frame: 'castle', base: 'midnight', colors: { bg: '#123456', text: 'red', bid: '#ABCDEF', ask: '#12345', panel: 7 }, savedAt: 1e20 })!;
  assert.equal(t.name, 'My theme');
  assert.equal(t.frame, 'editor');
  assert.equal(t.colors.bg, '#123456');
  assert.equal(t.colors.bid, '#abcdef', 'lower case');
  assert.equal(t.colors.text, PALETTES.midnight!.text, 'a colour that is no #rrggbb is the base\'s');
  assert.equal(t.colors.ask, PALETTES.midnight!.ask);
  assert.equal(t.colors.panel, PALETTES.midnight!.panel);
  assert.equal(t.savedAt, 0);
  // Without a base: Light or Dark by its background.
  assert.equal(readCustomTheme({ id: 'custom-abcd', name: 'x', colors: { bg: '#000000' } })!.colors.text, PALETTES.dark!.text);
  assert.equal(readCustomTheme({ id: 'custom-abcd', name: 'x', colors: { bg: '#ffffff' } })!.colors.text, PALETTES.light!.text);
  // Ids: never a built-in's, never anything else.
  for (const id of ['light', 'custom-', 'custom-AB12', 'custom-ab', 'x-custom-abcd', 'custom-abcd/..', '__proto__']) assert.equal(readCustomTheme({ id, name: 'x' }), null, id);
  assert.equal(readCustomTheme({ name: 'x' }), null);
  assert.notEqual(readCustomTheme({ name: 'x' }, false), null, 'a file\'s theme needs no id');
  assert.equal(readCustomTheme({ id: 'custom-abcd', name: '   ' }), null);
  // Frame tones are read as strictly, and only the known ones.
  assert.deepEqual(readCustomTheme({ id: 'custom-abcd', name: 'x', chrome: { face: '#C0C0C0', bar: 'navy', evil: '#000000' } })!.chrome, { face: '#c0c0c0' });
  assert.equal(readCustomTheme({ id: 'custom-abcd', name: 'x', chrome: { bar: 'url(x)' } })!.chrome, undefined);
});

test('the text and quiet text are moved until they read; the colours a person chose are kept as chosen', () => {
  const base = newTheme('light', [], copyWord, 1)!;
  const faint: CustomTheme = { ...base, colors: { ...base.colors, bg: '#ffffff', panel: '#f4f4f4', text: '#eeeeee', muted: '#dddddd' } };
  const { palette, adjusted } = customPalette(faint);
  assert.deepEqual(adjusted, ['text', 'muted']);
  assert.equal(faint.colors.text, '#eeeeee', 'kept as chosen');
  for (const s of [palette.bg, palette.panel]) { assert.ok(contrastRatio(palette.text, s) >= TEXT_RATIO); assert.ok(contrastRatio(palette.muted, s) >= MUTED_RATIO); }
  assert.equal(readable('#000000', ['#ffffff'], 4.5), '#000000', 'what reads is left alone');
});

test('any colours at all give a palette the page can draw: valid tones, readable text where the surfaces allow, lanes clear of nothing missing', () => {
  const r = rng(20261117);
  const tone = /^(#[0-9a-f]{6}|rgba\(0, 0, 0, [0-9.]+\))$/;
  for (let i = 0; i < 400; i++) {
    const colors = Object.fromEntries(COLOR_KEYS.map(key => [key, hex(r)]));
    const frame = (['editor', 'paper', 'bevel', 'textmode'] as const)[Math.floor(r() * 4)]!;
    // A third with frame tones of their own (a copy of Classic 95 whose colours were changed).
    const chrome = r() < 0.33 ? { face: hex(r), title: hex(r), well: hex(r) } : undefined;
    const theme = readCustomTheme({ id: 'custom-fuzz1', name: `t${i}`, frame, colors, chrome })!;
    const { palette } = customPalette(theme);
    for (const [key, value] of Object.entries(themeVars(palette))) assert.match(value, tone, `case ${i}: ${key} = ${value}`);
    const lanes = laneColors(palette);
    for (const value of Object.values(lanes)) assert.match(String(value), /^#[0-9a-f]{6}$/i, `case ${i}: lane colour`);
    // Readable wherever black or white would be, and never less readable than chosen.
    // On every surface words are written on, as the colours were chosen (the frame's faces follow the chosen colours).
    const worst = (c: string): number => Math.min(...textSurfaces({ ...palette, text: theme.colors.text, muted: theme.colors.muted }).map(s => contrastRatio(c, s)));
    if (Math.max(worst('#000000'), worst('#ffffff')) >= TEXT_RATIO) assert.ok(worst(palette.text) >= TEXT_RATIO, `case ${i}: text`);
    if (Math.max(worst('#000000'), worst('#ffffff')) >= MUTED_RATIO) assert.ok(worst(palette.muted) >= MUTED_RATIO, `case ${i}: muted`);
    assert.ok(worst(palette.text) >= worst(theme.colors.text) - 1e-9);
  }
});

test('warnings say which colours will be hard to see, and when buy and sell look alike', () => {
  const base = newTheme('light', [], copyWord, 1)!;
  const p = customPalette({ ...base, colors: { ...base.colors, bid: '#fefefe', ask: '#fdfdfd' } }).palette;
  const w = themeWarnings(p);
  assert.ok(w.faint.includes('bid') && w.faint.includes('ask'));
  assert.equal(w.alike, true);
  assert.deepEqual(themeWarnings(PALETTES.light!), { faint: [], alike: false, clash: false });
  // A dark background beside white panels: no text reads on both, and the page says so; the text is the tone that reads best on both, not black.
  const split = customPalette({ ...base, colors: { ...base.colors, bg: '#0b1a2e', panel: '#ffffff', text: '#1b1d21' } }).palette;
  assert.equal(themeWarnings(split).clash, true);
  assert.ok(Math.min(contrastRatio(split.text, split.bg), contrastRatio(split.text, split.panel)) > 3.5, split.text);
  for (const id of THEME_ORDER) assert.equal(themeWarnings(PALETTES[id]!).clash, false, id);
});

test('the page knows a person\'s themes once they are registered; a deleted one, or a name that is no theme, is Light', () => {
  const made = newTheme('midnight', [], copyWord, 1)!;
  assert.equal(isThemeId(made.id), false);
  assert.equal(resolveThemeId(made.id), 'light');
  const before = themeKey(made.id);
  registerCustomThemes([made]);
  assert.equal(isThemeId(made.id), true);
  assert.equal(paletteOf(made.id).label, 'Midnight copy');
  assert.notEqual(themeKey(made.id), before);
  const k1 = themeKey(made.id); registerCustomThemes([made]);
  assert.notEqual(themeKey(made.id), k1, 'the key changes whenever the themes are set again');
  assert.equal(themeKey('dark'), 'dark');
  for (const odd of ['toString', 'constructor', '__proto__', 'hasOwnProperty', '', 42, null]) { assert.equal(resolveThemeId(odd), 'light'); assert.equal(paletteOf(odd), PALETTES.light); }
  assert.equal(resolveThemeId('darkSurf'), 'dark', 'old names still read');
  registerCustomThemes([]);
  assert.equal(resolveThemeId(made.id), 'light');
});

test('a saved theme of one\'s own is kept when the page opens, and the light-or-dark key remembers it by its kind', () => {
  const made = newTheme('midnight', [], copyWord, 1)!;
  const real = (globalThis as { window?: unknown }).window;
  const load = (saved: Record<string, unknown>) => {
    (globalThis as { window?: unknown }).window = { innerWidth: 1600, localStorage: { getItem: () => JSON.stringify(saved), setItem: () => {} } };
    return initialState(false, false);
  };
  try {
    assert.equal(load({ theme: made.id, themePicked: true }).theme, 'light', 'not registered: Light');
    registerCustomThemes([made]);
    const s = load({ theme: made.id, themePicked: true, themeSlots: { light: 'latte', dark: made.id } });
    assert.equal(s.theme, made.id);
    assert.deepEqual(s.themeSlots, { light: 'latte', dark: made.id });
    assert.equal(flippedTheme(s), 'latte');
    assert.deepEqual(themeChange(s, 'parchment', true).themeSlots, { light: 'parchment', dark: made.id });
  } finally {
    if (real === undefined) delete (globalThis as { window?: unknown }).window; else (globalThis as { window?: unknown }).window = real;
  }
});

test('themes in storage: one per id and per name, at most twenty; names stay apart when one is put back', () => {
  const r = rng(7);
  const list = Array.from({ length: 25 }, (_, i) => ({ ...newTheme('dark', [], copyWord, 1, r)!, name: `T${i}` }));
  assert.equal(readCustomThemes(list).length, MAX_THEMES);
  assert.deepEqual(readCustomThemes(list).map(x => x.name), list.slice(-MAX_THEMES).map(x => x.name));
  const a = list[0]!, b = list[1]!;
  assert.deepEqual(readCustomThemes([a, { ...b, name: 't0' }]).map(x => x.id), [b.id], 'the same name in another case: the later wins');
  assert.equal(putTheme([a, b], { ...b, name: 'T0' }), null, 'a rename onto another theme\'s name is refused');
  assert.deepEqual(putTheme([a, b], { ...b, name: 'New' })!.map(x => x.name), ['T0', 'New']);
  assert.equal(putTheme(list.slice(0, MAX_THEMES), { ...a, id: 'custom-zzzzzz', name: 'One more' }), null);
  assert.equal(newTheme('dark', list.slice(0, MAX_THEMES), copyWord, 1), null, 'no copy into a full list');
  const names = [newTheme('dark', [], copyWord, 1)!];
  names.push(newTheme('dark', names, copyWord, 1)!);
  assert.deepEqual(names.map(x => x.name), ['Dark copy', 'Dark copy 2']);
  assert.notEqual(names[0]!.id, names[1]!.id);
});

test('a themes file: refused when it is something else or newer; read by name, a theme in use keeping its id', () => {
  const mine = { ...newTheme('dark', [], copyWord, 1, rng(1))!, name: 'Night' };
  assert.deepEqual(importThemes('nope'), { error: 'not-themes' });
  assert.deepEqual(importThemes(JSON.stringify({ format: 'liquiditymapperfast-layouts', layouts: [] })), { error: 'not-themes' });
  assert.deepEqual(importThemes(JSON.stringify({ format: 'liquiditymapperfast-themes', version: 2, themes: [mine] })), { error: 'newer' });
  assert.deepEqual(importThemes(JSON.stringify({ format: 'liquiditymapperfast-themes', version: 1, themes: [{ nope: 1 }] })), { error: 'empty' });
  assert.deepEqual(importThemes(' '.repeat(MAX_FILE_CHARS + 1)), { error: 'not-themes' });
  // The file carries no ids; a name already here is replaced and keeps its id, a new one gets its own.
  const text = exportThemes([{ ...mine, colors: { ...mine.colors, bg: '#010203' } }, { ...mine, name: 'Day' }]);
  assert.equal(text.includes(mine.id), false);
  const read = importThemes(text); assert.ok('themes' in read);
  const merged = mergeThemes([mine], read.themes, rng(2));
  assert.equal(merged.replaced, 1); assert.equal(merged.added, 1);
  assert.equal(merged.list[0]!.id, mine.id); assert.equal(merged.list[0]!.colors.bg, '#010203');
  assert.notEqual(merged.list[1]!.id, mine.id);
  assert.match(merged.list[1]!.id, /^custom-[a-z0-9]{10}$/);
  const full = Array.from({ length: MAX_THEMES }, (_, i) => ({ ...mine, id: `custom-full${i}x`, name: `F${i}` }));
  assert.equal(mergeThemes(full, read.themes).skipped, 2);
});

test('themes are kept in storage and made the page\'s; a refusing browser changes nothing', () => {
  const made = newTheme('ember', [], copyWord, 1)!, ok = new MemoryStorage();
  assert.equal(storeCustomThemes([made], ok), true);
  assert.deepEqual(loadCustomThemes(ok), [made]);
  assert.equal(isThemeId(made.id), true);
  setCustomPalettes({});
  assert.equal(storeCustomThemes([made], new MemoryStorage({}, 10)), false);
  assert.equal(isThemeId(made.id), false);
  assert.deepEqual(loadCustomThemes(new MemoryStorage({ 'hlm-themes-v1': '{bad' })), []);
});

test('a backup holds the page\'s own keys only, and reads back only a backup', () => {
  const store = new MemoryStorage({ 'hlm-app-v2': '{"theme":"dark"}', 'hlm-layouts-v1': '[]', 'lmf.coin': '"ETH"', 'lmf.coins': '[huge]', 'lmf.coins.opened': '{"ETH":1}', 'hlm-stale': '1', 'hlm-handover-v1': '1', [RESTORED_KEY]: '1', 'other-site': 'x' });
  const items = collectItems(store);
  assert.deepEqual(Object.keys(items).sort(), ['hlm-app-v2', 'hlm-layouts-v1', 'lmf.coin']);
  const text = backupFile(items, 1_700_000_000_000);
  assert.deepEqual(readBackup(text), { items, savedAt: 1_700_000_000_000 });
  assert.deepEqual(readBackup('{'), { error: 'not-backup' });
  assert.deepEqual(readBackup(JSON.stringify({ format: BACKUP_FORMAT, version: 9, items })), { error: 'newer' });
  assert.deepEqual(readBackup(JSON.stringify({ format: BACKUP_FORMAT, version: 1, items: {} })), { error: 'empty' });
  assert.deepEqual(readBackup(JSON.stringify({ format: BACKUP_FORMAT, version: 1, items: { ...items, 'evil-key': 'x' } })), { error: 'not-backup' }, 'a key that is not the page\'s: nothing is read');
  assert.deepEqual(readBackup(JSON.stringify({ format: BACKUP_FORMAT, version: 1, items: { 'hlm-app-v2': { theme: 1 } } })), { error: 'not-backup' });
  assert.deepEqual(readBackup(JSON.stringify({ format: BACKUP_FORMAT, version: 1, items: { 'lmf.coins': '[]' } })), { error: 'not-backup' }, 'the coin list cache is never written');
  assert.deepEqual(readBackup(JSON.stringify({ format: 'liquiditymapperfast-layouts', layouts: [] })), { error: 'other', kind: 'layouts' });
  assert.deepEqual(readBackup(JSON.stringify({ format: 'liquiditymapperfast-themes', themes: [] })), { error: 'other', kind: 'themes' });
  assert.deepEqual(readBackup(JSON.stringify({ format: 'liquiditymapperfast-scripts', scripts: [] })), { error: 'other', kind: 'scripts' });
  assert.deepEqual(readBackup(' '.repeat(MAX_BACKUP_CHARS + 1)), { error: 'too-large' });
  // Another browser's recording dates are never read from a file (they would delete this browser's recordings).
  assert.deepEqual(readBackup(JSON.stringify({ format: BACKUP_FORMAT, version: 1, items: { ...items, 'lmf.coins.opened': '{"SOL":1}' } })), { items, savedAt: 0 });
  assert.equal(backedKey('lmf.coins.opened'), false); assert.equal(backedKey(RESTORED_KEY), false); assert.equal(backedKey('hlm-app-v2'), true);
});

test('a restore replaces the page\'s keys exactly, all or none, and leaves other keys alone', () => {
  const here = { 'hlm-app-v2': 'old', 'hlm-scripts-v1': 'mine', 'lmf.coins': 'cache', 'lmf.coins.opened': 'mine', 'other-site': 'x' };
  const ok = new MemoryStorage(here);
  assert.equal(replaceAll(ok, { 'hlm-app-v2': 'new', 'hlm-layouts-v1': '[1]' }), true);
  assert.deepEqual(ok.obj(), { 'lmf.coins': 'cache', 'lmf.coins.opened': 'mine', 'other-site': 'x', 'hlm-app-v2': 'new', 'hlm-layouts-v1': '[1]' });
  // A backup larger than the room there is: refused part way, everything as it was.
  const room = new MemoryStorage(here).size() + 40, full = new MemoryStorage(here, room);
  assert.equal(replaceAll(full, { 'hlm-app-v2': 'x'.repeat(30), 'hlm-layouts-v1': 'y'.repeat(60) }), false);
  assert.deepEqual(full.obj(), here);
});

test('a restore waits for the reload and is written before the page reads anything, once; the page then says how it went', () => {
  const items = { 'hlm-app-v2': '{"theme":"dark"}', 'hlm-themes-v1': '[]' };
  const local = new MemoryStorage({ 'hlm-app-v2': 'old', 'hlm-drawings-v1': 'mine' }), session = new MemoryStorage();
  assert.equal(queueRestore(session, backupFile(items, 1)), true);
  assert.equal(takeRestore(local, session), true);
  const { [RESTORED_KEY]: mark, 'hlm-handover-v1': handed, ...restoredItems } = local.obj();
  assert.deepEqual(restoredItems, items);
  assert.ok(Number(mark) > 0, 'other tabs hear of it'); assert.ok(Number(handed) > 0, 'the old address hands nothing over it later');
  assert.equal(session.getItem(PENDING_KEY), null);
  assert.equal(restoreResult(session), 'ok'); assert.equal(restoreResult(session), null, 'said once');
  assert.equal(takeRestore(local, session), false, 'nothing waits now');
  // A broken waiting restore changes nothing and says so.
  session.setItem(PENDING_KEY, '{"format":"liquiditymapperfast-backup","version":1,"items":{"bad key":"x"}}');
  const before = local.obj();
  assert.equal(takeRestore(local, session), false);
  assert.deepEqual(local.obj(), before);
  assert.equal(restoreResult(session), 'failed');
  assert.equal(queueRestore(new MemoryStorage({}, 5), 'too long'), false);
});

test('a layout keeps the chart\'s settings unless the box is cleared, and its card says which it keeps', () => {
  assert.equal(newGalleryState().withSettings, true);
  assert.equal(keepsSettings({ settings: { show: {} as never } }), false);
  assert.equal(keepsSettings({ settings: { show: {} as never, timeframe: '1h' } }), true);
});

test('a copy of Classic 95 made dark keeps its words readable on the grey buttons, or says it cannot', () => {
  const classic = newTheme('classic', [], copyWord, 1)!;
  const dark = customPalette({ ...classic, colors: { ...classic.colors, bg: '#101010', panel: '#141414', text: '#adadad' } }).palette;
  const surfaces = textSurfaces(dark);
  const worst = Math.min(...surfaces.map(x => contrastRatio(dark.text, x)));
  assert.ok(worst >= 4.5 || themeWarnings(dark).clash, `text ${dark.text} reads ${worst.toFixed(2)} at worst`);
  assert.equal(surfacesClash(textSurfaces(PALETTES.classic!)), false);
});

test('copies of the colour-blind themes are drawn as they are while their buy and sell stay the safe pair', () => {
  for (const id of ['colorblind', 'daylight']) {
    const made = newTheme(id, [], copyWord, 1)!;
    assert.equal(customPalette(made).palette.colourSafe, true, id);
    assert.equal(customPalette({ ...made, colors: { ...made.colors, ask: '#ff0000' } }).palette.colourSafe, undefined, `${id}: another sell colour`);
  }
  assert.equal(customPalette(newTheme('dark', [], copyWord, 1)!).palette.colourSafe, undefined);
});

test('saved settings of any shape open the page: only saved keys, from an object, the unread ones of their type', () => {
  for (const raw of [null, 5, 'x', [], [1, 2], true]) assert.deepEqual(savedFields(raw), {});
  assert.deepEqual(savedFields({ markets: 'x', layers: null, candles: 'zz', theme: 'dark' }), { theme: 'dark' }, 'what is not saved is never read');
  assert.deepEqual(savedFields({ heatmapSource: 5, disabledVenues: 'okx', ladderVenues: [1], keepAwake: 'yes', ladderVenue: null }), {});
  assert.deepEqual(savedFields({ heatmapSource: 'aggregated', disabledVenues: ['okx'], keepAwake: true }), { heatmapSource: 'aggregated', disabledVenues: ['okx'], keepAwake: true });
  const real = (globalThis as { window?: unknown }).window;
  try {
    for (const text of ['null', '5', '"x"', '[]', '{"show":null,"heat":null,"lt":7,"sounds":"x","draw":[],"themeSlots":5,"cvd":null,"traded":"x","tpo":null,"vwap":1}']) {
      (globalThis as { window?: unknown }).window = { innerWidth: 1600, localStorage: { getItem: () => text, setItem: () => {} } };
      const state = initialState(false, false);
      assert.equal(typeof state.heat.contrast, 'number', text);
      assert.equal(state.theme, 'light', text);
    }
  } finally {
    if (real === undefined) delete (globalThis as { window?: unknown }).window; else (globalThis as { window?: unknown }).window = real;
  }
});

test('the light-or-dark key follows a theme of one\'s own across kinds, and forgets one that is gone', () => {
  const made = newTheme('light', [], copyWord, 1)!;
  registerCustomThemes([made]);
  assert.deepEqual(slotsFor({ light: made.id, dark: 'terminal' }, made.id), { light: made.id, dark: 'terminal' });
  // Its background made dark: it moves to the dark slot, and the light slot goes back to Light.
  registerCustomThemes([{ ...made, colors: { ...made.colors, bg: '#101418', panel: '#141a20' } }]);
  assert.deepEqual(slotsFor({ light: made.id, dark: 'terminal' }, made.id), { light: 'light', dark: made.id });
  // Deleted: both slots that held it go back to the defaults.
  registerCustomThemes([]);
  assert.deepEqual(slotsFor({ light: 'latte', dark: made.id }, 'latte'), { light: 'latte', dark: 'terminal' });
});
