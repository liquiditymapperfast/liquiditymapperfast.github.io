import { FRAMES, PALETTES, chromeFor, contrastRatio, lightness, mixHex, paletteOf, rgb, setCustomPalettes, type Chrome, type Frame, type Palette } from './theme.ts';
import { copyName } from './layouts/layouts.ts';

/**
 * Themes a person makes: a name, a frame (the shape language, theme.ts `Frame`) and the sixteen colours a palette has, nothing else. A theme is
 * data, never code: no style sheet, font or picture comes from it, so a theme file from anywhere can only change colours. Everything a built-in
 * theme derives (whether it is dark, the edges, faces and title bars, the warning words) is derived from those colours the same way, and the
 * text and muted text are moved, where needed, until they read on the background and the panels, so no theme can make the page unreadable,
 * the theme menu included. A theme starts as a copy of the one on the screen (`newTheme`). Kept in this browser (`hlm-themes-v1`, at most
 * `MAX_THEMES`) and written to a file and read back like layouts and scripts.
 */

export const CUSTOM_THEMES_KEY = 'hlm-themes-v1', MAX_THEMES = 20, MAX_NAME = 40, FILE_FORMAT = 'liquiditymapperfast-themes', FILE_VERSION = 1;
/** Twenty themes are a few kilobytes; a file far larger is something else. */
export const MAX_FILE_CHARS = 200_000;

/** The colours a theme sets, in the order the editor shows them. */
export const COLOR_KEYS = ['bg', 'panel', 'text', 'muted', 'line', 'accent', 'ui', 'bid', 'bidSoft', 'ask', 'askSoft', 'candleUp', 'candleDown', 'poc', 'level', 'vwap'] as const;
export type ColorKey = (typeof COLOR_KEYS)[number];
/** A palette's own frame tones (Classic 95's grey and navy), carried by a copy so it keeps its look; not edited, but read from a file as strictly. */
const PIN_KEYS = ['edge', 'edgeLit', 'hi', 'lo', 'face', 'title', 'well', 'bar', 'barText'] as const;
type PinKey = (typeof PIN_KEYS)[number];

export interface CustomTheme {
  /** `custom-` and letters or digits: never a built-in id, never an alias. */
  id: string;
  name: string;
  frame: Frame;
  colors: Record<ColorKey, string>;
  chrome?: Partial<Record<PinKey, string>>;
  savedAt: number;
}

const HEX = /^#[0-9a-f]{6}$/i, ID = /^custom-[a-z0-9]{4,16}$/;
/** Midnight of 1 January 3000 (ms). */
const MAX_SAVED_AT = 32_503_680_000_000;
export const isHex = (v: unknown): v is string => typeof v === 'string' && HEX.test(v);

/** A name as it is kept: spaces collapsed and trimmed, at most `MAX_NAME` characters; null when nothing is left. */
export function cleanThemeName(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const name = raw.replace(/\s+/g, ' ').trim().slice(0, MAX_NAME).trim();
  return name ? name : null;
}
const sameName = (a: string, b: string): boolean => a.toLocaleLowerCase() === b.toLocaleLowerCase();

export function newThemeId(random: () => number = Math.random): string {
  let s = '';
  for (let i = 0; i < 10; i++) s += Math.floor(random() * 36).toString(36);
  return `custom-${s}`;
}

/** Whether a background is a dark one: the rule every built-in theme follows (tests/app-theme.test.mts). */
export const isDarkBackground = (bg: string): boolean => lightness(bg) < 0.18;

/**
 * A theme from storage or a file, or null. Every colour must be `#rrggbb` (a missing or broken one is taken from the built-in theme the
 * file names as its `base`, else Light or Dark by its background); the frame must be one there is. `id` is checked when `needId`: a file's
 * ids are not trusted (`mergeThemes` gives them their own).
 */
export function readCustomTheme(raw: unknown, needId = true): CustomTheme | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>, name = cleanThemeName(r.name);
  const id = typeof r.id === 'string' && ID.test(r.id) ? r.id : null;
  if (!name || (needId && !id)) return null;
  const given = r.colors && typeof r.colors === 'object' ? r.colors as Record<string, unknown> : {};
  const baseId = typeof r.base === 'string' && Object.hasOwn(PALETTES, r.base) ? r.base : isHex(given.bg) && isDarkBackground(given.bg) ? 'dark' : 'light';
  const base = PALETTES[baseId]!;
  const colors = Object.fromEntries(COLOR_KEYS.map(key => [key, isHex(given[key]) ? given[key].toLowerCase() : base[key]])) as Record<ColorKey, string>;
  const frame = FRAMES.includes(r.frame as Frame) ? r.frame as Frame : 'editor';
  let chrome: CustomTheme['chrome'];
  if (r.chrome && typeof r.chrome === 'object') {
    const pins = r.chrome as Record<string, unknown>, kept = PIN_KEYS.filter(key => isHex(pins[key]));
    if (kept.length) chrome = Object.fromEntries(kept.map(key => [key, (pins[key] as string).toLowerCase()]));
  }
  const savedAt = typeof r.savedAt === 'number' && r.savedAt > 0 && r.savedAt < MAX_SAVED_AT ? Math.round(r.savedAt) : 0;
  return { id: id ?? '', name, frame, colors, ...(chrome ? { chrome } : {}), savedAt };
}

/** Themes from storage: the valid ones, one per id and per name (the later one wins), at most `MAX_THEMES`. */
export function readCustomThemes(raw: unknown): CustomTheme[] {
  let out: CustomTheme[] = [];
  if (!Array.isArray(raw)) return out;
  for (const item of raw) {
    const theme = readCustomTheme(item);
    if (!theme) continue;
    out = out.filter(x => x.id !== theme.id && !sameName(x.name, theme.name));
    out.push(theme);
  }
  return out.slice(-MAX_THEMES);
}

/** The greys from black to white, the last resort of `readable`. */
const GREYS = Array.from({ length: 65 }, (_, i) => mixHex('#000000', '#ffffff', i / 64));

/**
 * `color` changed as little as it takes to stand at least `ratio` apart from every one of `surfaces`: moved toward black or toward white
 * (keeping its hue), else a grey; where nothing reaches the ratio (a dark background beside white panels), the tone that reads best on all of
 * them. A colour that already reads comes back as it is.
 */
export function readable(color: string, surfaces: readonly string[], ratio: number): string {
  const worst = (tone: string): number => Math.min(...surfaces.map(s => contrastRatio(tone, s)));
  if (worst(color) >= ratio) return color;
  let best = color, bestScore = worst(color);
  const consider = (tone: string): boolean => { const score = worst(tone); if (score > bestScore) { best = tone; bestScore = score; } return score >= ratio; };
  for (let step = 1; step <= 25; step++) for (const target of ['#000000', '#ffffff']) { const tone = mixHex(color, target, step / 25); if (consider(tone)) return tone; }
  for (const grey of GREYS) consider(grey);
  return best;
}

/** Whether no colour at all reads at `ratio` on every one of `surfaces`: they are too far apart (a dark background beside white panels). */
export const surfacesClash = (surfaces: readonly string[], ratio = 4.5): boolean =>
  ![...GREYS, '#000000', '#ffffff'].some(tone => Math.min(...surfaces.map(s => contrastRatio(tone, s))) >= ratio);

/** The text and quiet text are held to what every built-in theme meets on its background and panels (tests/app-theme.test.mts): 7:1 and 4.5:1. */
export const TEXT_RATIO = 7, MUTED_RATIO = 4.5;

/**
 * What words are written on: the background, the panels, and the frame's own surfaces drawn from them (the buttons' face, the title strips, the
 * fields' well), which a palette's pinned tones (Classic 95's grey) can set far from the panels.
 */
export function textSurfaces(p: Palette): string[] {
  const chrome = chromeFor(p);
  return [p.bg, p.panel, chrome.face, chrome.title, chrome.well];
}

/** The built-in palettes whose buy and sell are the colour-blind safe pair: a theme with the same pair is drawn as they are (tpo/paint.ts). */
const SAFE_PAIRS = Object.values(PALETTES).filter(p => p.colourSafe).map(p => `${p.bid}|${p.ask}`);

/** A theme as the page draws it: its colours, the text and muted text made readable where they were not (`adjusted` says which). */
export function customPalette(theme: CustomTheme): { palette: Palette; adjusted: ColorKey[] } {
  const c = theme.colors, safe = SAFE_PAIRS.includes(`${c.bid}|${c.ask}`);
  const chosen: Palette = { label: theme.name, dark: isDarkBackground(c.bg), frame: theme.frame, ...c, ...(theme.chrome ? { chrome: theme.chrome as Partial<Chrome> } : {}), ...(safe ? { colourSafe: true as const } : {}) };
  const surfaces = textSurfaces(chosen);
  const text = readable(c.text, surfaces, TEXT_RATIO), muted = readable(c.muted, surfaces, MUTED_RATIO);
  const adjusted = [...(text !== c.text ? ['text' as const] : []), ...(muted !== c.muted ? ['muted' as const] : [])];
  return { palette: { ...chosen, text, muted }, adjusted };
}

/**
 * The colours that will be hard to see on the background (under 3:1, as the built-in themes are held to), whether buy and sell look alike, and
 * whether the background and the panels are too far apart for any text to read on both.
 */
export function themeWarnings(p: Palette): { faint: ColorKey[]; alike: boolean; clash: boolean } {
  const faint = (['accent', 'ui', 'bid', 'ask', 'candleUp', 'candleDown', 'poc', 'level', 'vwap'] as const).filter(key => contrastRatio(p[key], p.bg) < 3);
  const [ar, ag, ab] = rgb(p.bid), [br, bg, bb] = rgb(p.ask);
  return { faint, alike: Math.hypot(ar - br, ag - bg, ab - bb) < 0.2, clash: surfacesClash(textSurfaces(p)) };
}

/** A new theme copied from the theme `fromId` (built-in or the person's own), under a name that is free. */
export function newTheme(fromId: string, list: readonly CustomTheme[], wording: (shown: string) => string, now: number, random: () => number = Math.random): CustomTheme | null {
  if (list.length >= MAX_THEMES) return null;
  const p = paletteOf(fromId), name = copyName(p.label, wording, candidate => list.some(x => sameName(x.name, candidate)));
  if (!name) return null;
  let id = newThemeId(random);
  while (list.some(x => x.id === id)) id = newThemeId(random);
  const colors = Object.fromEntries(COLOR_KEYS.map(key => [key, p[key]])) as Record<ColorKey, string>;
  const chrome = p.chrome ? Object.fromEntries(PIN_KEYS.filter(key => isHex(p.chrome?.[key])).map(key => [key, p.chrome![key]!])) : undefined;
  return { id, name, frame: p.frame, colors, ...(chrome && Object.keys(chrome).length ? { chrome } : {}), savedAt: now };
}

/** The list with `theme` in place of the one of its id (or added at the end); null when the name is another theme's. */
export function putTheme(list: readonly CustomTheme[], theme: CustomTheme): CustomTheme[] | null {
  if (list.some(x => x.id !== theme.id && sameName(x.name, theme.name))) return null;
  const at = list.findIndex(x => x.id === theme.id);
  if (at < 0) return list.length >= MAX_THEMES ? null : [...list, theme];
  return list.map((x, i) => i === at ? theme : x);
}

/** The themes file: a marker, a version and the themes. */
export function exportThemes(list: readonly CustomTheme[]): string {
  return JSON.stringify({ format: FILE_FORMAT, version: FILE_VERSION, themes: list.map(({ id: _id, ...rest }) => rest) }, null, 2);
}

/** The themes in a file, or why there are none. */
export function importThemes(text: string): { themes: CustomTheme[] } | { error: 'not-themes' | 'empty' | 'newer' } {
  if (text.length > MAX_FILE_CHARS) return { error: 'not-themes' };
  let raw: unknown;
  try { raw = JSON.parse(text); } catch { return { error: 'not-themes' }; }
  if (!raw || typeof raw !== 'object' || (raw as { format?: unknown }).format !== FILE_FORMAT) return { error: 'not-themes' };
  const version = (raw as { version?: unknown }).version;
  if (typeof version !== 'number' || version > FILE_VERSION) return { error: 'newer' };
  const items = (raw as { themes?: unknown }).themes;
  const themes = Array.isArray(items) ? items.map(item => readCustomTheme(item, false)).filter((x): x is CustomTheme => x !== null) : [];
  return themes.length ? { themes } : { error: 'empty' };
}

/**
 * `incoming` added to `list` one by one: a name already there is replaced and keeps its id (so a theme in use stays in use), a new name gets an
 * id of its own (a file's ids are never used); those that do not fit are counted, not added.
 */
export function mergeThemes(list: readonly CustomTheme[], incoming: readonly CustomTheme[], random: () => number = Math.random): { list: CustomTheme[]; added: number; replaced: number; skipped: number } {
  let out = [...list], added = 0, replaced = 0, skipped = 0;
  for (const theme of incoming) {
    const had = out.find(x => sameName(x.name, theme.name));
    if (had) { out = out.map(x => x === had ? { ...theme, id: had.id } : x); replaced++; continue; }
    if (out.length >= MAX_THEMES) { skipped++; continue; }
    let id = newThemeId(random);
    while (out.some(x => x.id === id)) id = newThemeId(random);
    out.push({ ...theme, id }); added++;
  }
  return { list: out, added, replaced, skipped };
}

/** The themes kept in this browser (none when storage is not there or holds something else). */
export function loadCustomThemes(storage: Pick<Storage, 'getItem'> | null = typeof window === 'undefined' ? null : window.localStorage): CustomTheme[] {
  try { const raw = storage?.getItem(CUSTOM_THEMES_KEY); return raw ? readCustomThemes(JSON.parse(raw)) : []; } catch { return []; }
}
/** Keep the themes in this browser and make them the page's; false when storage refused (the page's then stay as they were). */
export function storeCustomThemes(list: readonly CustomTheme[], storage: Pick<Storage, 'setItem'> | null = typeof window === 'undefined' ? null : window.localStorage): boolean {
  try { storage?.setItem(CUSTOM_THEMES_KEY, JSON.stringify(list)); } catch { return false; }
  registerCustomThemes(list);
  return true;
}
/** Make `list` the themes the page knows (theme.ts `paletteOf`). */
export function registerCustomThemes(list: readonly CustomTheme[]): void {
  setCustomPalettes(Object.fromEntries(list.map(theme => [theme.id, customPalette(theme).palette])));
}
