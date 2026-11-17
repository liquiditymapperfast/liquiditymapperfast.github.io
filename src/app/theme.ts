import { t } from './i18n.ts';
/**
 * A theme's shape language, apart from its colours (chrome.css, `html[data-frame]`): Bevel is the 1990s desktop (raised and sunken edges,
 * title bars, square corners), Text mode the terminal and DOS screen (double rules, inverse video, a monospaced face), Editor the flat
 * modern default (one hairline, quiet surfaces), Paper the softer light one. Each is chosen per palette, never mixed (Karl, 2026-10-16:
 * the raised look is a theme of its own, not every theme's).
 */
export type Frame = 'bevel' | 'textmode' | 'editor' | 'paper';
export const FRAMES: readonly Frame[] = ['bevel', 'textmode', 'editor', 'paper'];
export interface Palette {
  label: string; dark: boolean;
  /** The shape language it is drawn in. */
  frame: Frame;
  /** Tones of its frame that are its own rather than derived (the classic desktop's grey and navy), each eased in with the strength. */
  chrome?: Partial<Chrome>;
  bg: string; panel: string; text: string; muted: string; line: string; accent: string;
  /** Focus rings, switches and selected controls. */
  ui: string;
  bid: string; bidSoft: string; ask: string; askSoft: string; candleUp: string; candleDown: string;
  /** The volume profile's lines (point of control, value area): a hue of its own, away from the buy and sell colours and the amber marks. */
  poc: string;
  /** The key levels (previous day, week and month): a neutral of its own, apart from the profile's hue and the buy and sell colours. */
  level: string;
  /** The VWAP lines: a hue of their own, away from the buy and sell colours, the profile's and the amber marks (cyan on a light page, yellow on a dark one). */
  vwap: string;
  /** Its buy and sell are the colour-blind safe pair (blue and orange): the TPO's ramps, which end in amber, change for it (tpo/paint.ts). */
  colourSafe?: true;
}

/**
 * Palettes. Text, muted text, accents and the buy / sell colours meet WCAG contrast against the background and the panel
 * (tests/app-theme.test.mts enforces it). Midnight follows Tokyo Night, Mocha and Latte follow Catppuccin, and Colour-blind safe uses the
 * Okabe-Ito blue and orange, which stay apart under the common red-green deficiencies. Classic 95 is the 1990s desktop: grey chrome, navy
 * title bars and selection, white wells for the data, the sixteen-colour green and maroon (maroon rather than red: apart from the green in
 * lightness too, so red-blind eyes still tell them apart).
 *
 * The rest follow well-loved editor and terminal schemes under names of their own (the research note of 2026-10-16 says which, with
 * their licences): their colours as published, with only what fails the contrast rules moved within the scheme's own colours, and buy in
 * the scheme's cyan or teal where its green and red would merge for a red-green deficiency. Amber and Blue Mode are the amber phosphor
 * screen and the blue sixteen-colour editor of the DOS years.
 */
export const PALETTES: Record<string, Palette> = {
  classic: { label: 'Classic 95', dark: false, frame: 'bevel', bg: '#ffffff', panel: '#ffffff', text: '#000000', muted: '#444444', line: '#dfdfdf', accent: '#000080', ui: '#000080',
    bid: '#008000', bidSoft: '#c8e6c8', ask: '#800000', askSoft: '#ecc8c8', candleUp: '#008000', candleDown: '#800000', poc: '#800080', level: '#808080', vwap: '#008080',
    chrome: { edge: '#0a0a0a', edgeLit: '#ffffff', hi: '#dfdfdf', lo: '#808080', face: '#c0c0c0', title: '#c0c0c0', well: '#ffffff', bar: '#000080', barText: '#ffffff' } },
  light: { label: t('Light'), dark: false, frame: 'editor', bg: '#ffffff', panel: '#ffffff', text: '#1b1d21', muted: '#667085', line: '#e7e9ec', accent: '#1b1d21', ui: '#2f6bff',
    bid: '#0fa44a', bidSoft: '#cdeed8', ask: '#e0066f', askSoft: '#ffd0e6', candleUp: '#12a150', candleDown: '#e0115f', poc: '#7c3aed', level: '#3f4654', vwap: '#0891b2' },
  latte: { label: 'Latte', dark: false, frame: 'paper', bg: '#eff1f5', panel: '#f6f7fa', text: '#434660', muted: '#5c5f77', line: '#ccd0da', accent: '#1e66f5', ui: '#1e66f5',
    bid: '#368a24', bidSoft: '#cfe6c8', ask: '#d20f39', askSoft: '#f6cdd5', candleUp: '#368a24', candleDown: '#d20f39', poc: '#8839ef', level: '#4c4f69', vwap: '#0b7fa5' },
  dark: { label: t('Dark'), dark: true, frame: 'editor', bg: '#121215', panel: '#17171b', text: '#fffcf0', muted: '#8b8d93', line: '#2a2c30', accent: '#00ffda', ui: '#5b9bff',
    bid: '#00ffda', bidSoft: '#0d5a4f', ask: '#ff4d57', askSoft: '#6b1c22', candleUp: '#00d9b8', candleDown: '#ff4d4d', poc: '#c4a7ff', level: '#e6e1cf', vwap: '#f4e04d' },
  darker: { label: t('Darker'), dark: true, frame: 'editor', bg: '#0c0c0e', panel: '#111315', text: '#d9e2df', muted: '#7d8785', line: '#252b2c', accent: '#36d27c', ui: '#5b9bff',
    bid: '#28cf72', bidSoft: '#0f4a2c', ask: '#f05d67', askSoft: '#5a2329', candleUp: '#28cf72', candleDown: '#f05d67', poc: '#c4a7ff', level: '#d9e2df', vwap: '#f4e04d' },
  midnight: { label: 'Midnight', dark: true, frame: 'editor', bg: '#1a1b26', panel: '#16161e', text: '#c0caf5', muted: '#8089b3', line: '#292e42', accent: '#7aa2f7', ui: '#7aa2f7',
    bid: '#73daca', bidSoft: '#1c4a45', ask: '#f7768e', askSoft: '#5a2a3a', candleUp: '#9ece6a', candleDown: '#f7768e', poc: '#bb9af7', level: '#a9b1d6', vwap: '#e6d36a' },
  mocha: { label: 'Mocha', dark: true, frame: 'editor', bg: '#1e1e2e', panel: '#181825', text: '#cdd6f4', muted: '#a6adc8', line: '#313244', accent: '#cba6f7', ui: '#89b4fa',
    bid: '#a6e3a1', bidSoft: '#2f4a35', ask: '#f38ba8', askSoft: '#5a2c3c', candleUp: '#a6e3a1', candleDown: '#f38ba8', poc: '#cba6f7', level: '#bac2de', vwap: '#f9e2af' },
  colorblind: { label: t('Colour-blind safe'), dark: true, frame: 'editor', colourSafe: true, bg: '#12151c', panel: '#171b24', text: '#e8ecf4', muted: '#9aa3b5', line: '#2a3140', accent: '#e69f00', ui: '#56b4e9',
    bid: '#56b4e9', bidSoft: '#16405c', ask: '#e69f00', askSoft: '#5c3f00', candleUp: '#56b4e9', candleDown: '#e69f00', poc: '#cc79a7', level: '#d6dbe6', vwap: '#f0e442' },
  terminal: { label: 'Terminal', dark: true, frame: 'textmode', bg: '#000000', panel: '#050805', text: '#00ff00', muted: '#51b85c', line: '#134b16', accent: '#00ff00', ui: '#00ff00',
    bid: '#00ff00', bidSoft: '#0a4d00', ask: '#ff0000', askSoft: '#5a0000', candleUp: '#11af00', candleDown: '#ff6363', poc: '#00e5ff', level: '#e6e6e6', vwap: '#ffff66' },
  parchment: { label: 'Parchment', dark: false, frame: 'paper', bg: '#fdf6e3', panel: '#fdf6e3', text: '#073642', muted: '#586e75', line: '#eee8d5', accent: '#268bd2', ui: '#268bd2',
    bid: '#289c94', bidSoft: '#d2e4d3', ask: '#dc322f', askSoft: '#f6cfbf', candleUp: '#809503', candleDown: '#dc322f', poc: '#d33682', level: '#657b83', vwap: '#6c71c4' },
  newsprint: { label: 'Newsprint', dark: false, frame: 'paper', bg: '#fffcf0', panel: '#f2f0e5', text: '#100f0f', muted: '#575653', line: '#dad8ce', accent: '#205ea6', ui: '#205ea6',
    bid: '#24837b', bidSoft: '#d3e4d9', ask: '#af3029', askSoft: '#efd3c8', candleUp: '#66800b', candleDown: '#af3029', poc: '#5e409d', level: '#6f6e69', vwap: '#205ea6' },
  blush: { label: 'Blush', dark: false, frame: 'paper', bg: '#faf4ed', panel: '#fffaf3', text: '#464261', muted: '#716d8b', line: '#dfdad9', accent: '#907aa9', ui: '#286983',
    bid: '#286983', bidSoft: '#d0d8d8', ask: '#b4637a', askSoft: '#ecd7d6', candleUp: '#286983', candleDown: '#b4637a', poc: '#907aa9', level: '#797593', vwap: '#56949f' },
  daylight: { label: t('Colour-blind safe, light'), dark: false, frame: 'editor', colourSafe: true, bg: '#ffffff', panel: '#f6f8fa', text: '#1f2328', muted: '#59636e', line: '#d1d9e0', accent: '#0969da', ui: '#9a6700',
    bid: '#0969da', bidSoft: '#cee1f8', ask: '#bc4c00', askSoft: '#f2dbcc', candleUp: '#0969da', candleDown: '#bc4c00', poc: '#8250df', level: '#59636e', vwap: '#1b7c83' },
  maxlight: { label: t('High contrast, light'), dark: false, frame: 'editor', bg: '#ffffff', panel: '#f2f2f2', text: '#000000', muted: '#595959', line: '#9f9f9f', accent: '#0031a9', ui: '#0031a9',
    bid: '#00663f', bidSoft: '#cce0d9', ask: '#d00000', askSoft: '#f6cccc', candleUp: '#006800', candleDown: '#a60000', poc: '#531ab6', level: '#595959', vwap: '#005e8b' },
  slate: { label: 'Slate', dark: true, frame: 'editor', bg: '#282c34', panel: '#21252b', text: '#b2b8c4', muted: '#8c93a1', line: '#3e4451', accent: '#61afef', ui: '#61afef',
    bid: '#56b6c2', bidSoft: '#36555f', ask: '#e06c75', askSoft: '#5f3f48', candleUp: '#98c379', candleDown: '#e06c75', poc: '#c678dd', level: '#abb2bf', vwap: '#e5c07b' },
  velvet: { label: 'Velvet', dark: true, frame: 'editor', bg: '#282a36', panel: '#21222c', text: '#f8f8f2', muted: '#8491b6', line: '#44475a', accent: '#bd93f9', ui: '#bd93f9',
    bid: '#50fa7b', bidSoft: '#34684b', ask: '#ff5555', askSoft: '#69373f', candleUp: '#50fa7b', candleDown: '#ff5555', poc: '#ff79c6', level: '#8be9fd', vwap: '#f1fa8c' },
  ember: { label: 'Ember', dark: true, frame: 'editor', bg: '#282828', panel: '#1d2021', text: '#ebdbb2', muted: '#a89984', line: '#504945', accent: '#fabd2f', ui: '#83a598',
    bid: '#8ec07c', bidSoft: '#475641', ask: '#fb4934', askSoft: '#67322c', candleUp: '#b8bb26', candleDown: '#fb4934', poc: '#d3869b', level: '#bdae93', vwap: '#fabd2f' },
  heather: { label: 'Heather', dark: true, frame: 'editor', bg: '#191724', panel: '#1f1d2e', text: '#e0def4', muted: '#908caa', line: '#403d52', accent: '#ebbcba', ui: '#c4a7e7',
    bid: '#9ccfd8', bidSoft: '#404e5a', ask: '#eb6f92', askSoft: '#583145', candleUp: '#9ccfd8', candleDown: '#eb6f92', poc: '#c4a7e7', level: '#908caa', vwap: '#f6c177' },
  deepteal: { label: 'Deep Teal', dark: true, frame: 'editor', bg: '#002b36', panel: '#002b36', text: '#eee8d5', muted: '#93a1a1', line: '#073642', accent: '#268bd2', ui: '#268bd2',
    bid: '#2aa198', bidSoft: '#0d4e53', ask: '#dc322f', askSoft: '#422d34', candleUp: '#859900', candleDown: '#dc322f', poc: '#6c71c4', level: '#839496', vwap: '#b58900' },
  charcoal: { label: 'Charcoal', dark: true, frame: 'editor', bg: '#1d1f21', panel: '#282a2e', text: '#c5c8c6', muted: '#969896', line: '#373b41', accent: '#81a2be', ui: '#81a2be',
    bid: '#8abeb7', bidSoft: '#3e4f4e', ask: '#cc6666', askSoft: '#523436', candleUp: '#b5bd68', candleDown: '#cc6666', poc: '#b294bb', level: '#969896', vwap: '#f0c674' },
  maxcontrast: { label: t('High contrast'), dark: true, frame: 'editor', bg: '#000000', panel: '#1e1e1e', text: '#ffffff', muted: '#989898', line: '#646464', accent: '#2fafff', ui: '#2fafff',
    bid: '#00d3d0', bidSoft: '#003f3e', ask: '#ff5f59', askSoft: '#4d1d1b', candleUp: '#44bc44', candleDown: '#ff5f59', poc: '#b6a0ff', level: '#989898', vwap: '#d0bc00' },
  amber: { label: 'Amber', dark: true, frame: 'textmode', bg: '#000000', panel: '#0a0700', text: '#ffa800', muted: '#b27600', line: '#5c3c00', accent: '#ffa800', ui: '#ffd080',
    bid: '#ffd080', bidSoft: '#4d3e26', ask: '#c25e00', askSoft: '#3a1c00', candleUp: '#ffd080', candleDown: '#c25e00', poc: '#ffffff', level: '#8c5c00', vwap: '#ffe9b8' },
  bluemode: { label: 'Blue Mode', dark: true, frame: 'textmode', bg: '#0000aa', panel: '#0000aa', text: '#ffff55', muted: '#aaaaaa', line: '#aaaaaa', accent: '#ffffff', ui: '#55ffff',
    bid: '#55ff55', bidSoft: '#1a4d90', ask: '#ff5555', askSoft: '#4d1a90', candleUp: '#55ff55', candleDown: '#ff5555', poc: '#ff55ff', level: '#aaaaaa', vwap: '#55ffff' },
};
/** Order of the theme menu: light themes first, then dark ones from neutral to themed. */
export const THEME_ORDER = ['light', 'classic', 'latte', 'parchment', 'newsprint', 'blush', 'daylight', 'maxlight', 'dark', 'darker', 'midnight', 'mocha', 'slate', 'velvet',
  'ember', 'heather', 'deepteal', 'charcoal', 'colorblind', 'maxcontrast', 'terminal', 'amber', 'bluemode'] as const;

/** Ids written by earlier builds, mapped to the current ones so a saved choice survives the rename. */
const THEME_ALIASES: Readonly<Record<string, string>> = { legacyLight: 'light', darkSurf: 'dark', darkTerminal: 'terminal', darkerDark: 'darker' };
/**
 * The themes a person made (custom-themes.ts), by id, as palettes: set before the page reads its saved theme and again whenever one is made,
 * changed or deleted. Their ids begin with `custom-`, so they never meet a built-in id or an alias.
 */
let CUSTOM: Readonly<Record<string, Palette>> = {}, customRevision = 0;
export function setCustomPalettes(palettes: Readonly<Record<string, Palette>>): void { CUSTOM = palettes; customRevision++; }
/** A key that changes whenever what theme `id` looks like may have changed: what is drawn from a palette is remembered by it, not by the id alone. */
export const themeKey = (id: string): string => Object.hasOwn(CUSTOM, id) ? `${id}#${customRevision}` : id;
/** Whether `id` names a theme there is, built-in or the person's own (own keys only: `toString` is no theme). */
export const isThemeId = (id: unknown): id is string => typeof id === 'string' && (Object.hasOwn(PALETTES, id) || Object.hasOwn(CUSTOM, id));
export function resolveThemeId(name: unknown): string {
  const id = typeof name === 'string' ? (Object.hasOwn(THEME_ALIASES, name) ? THEME_ALIASES[name]! : name) : '';
  return isThemeId(id) ? id : 'light';
}
/** The palette of a theme id, built-in or the person's own; Light for one that is not (or no longer) there. Every reader of a theme goes through it. */
export function paletteOf(name: unknown): Palette {
  const id = resolveThemeId(name);
  return (Object.hasOwn(CUSTOM, id) ? CUSTOM[id] : PALETTES[id]) ?? PALETTES.light!;
}
/** `a` moved `amount` (0 to 1) of the way to `b`, both as #rrggbb. */
export function mixHex(a: string, b: string, amount: number): string {
  const [ar, ag, ab] = rgb(a), [br, bg, bb] = rgb(b), k = Math.max(0, Math.min(1, amount));
  const channel = (x: number, y: number): string => Math.round((x * (1 - k) + y * k) * 255).toString(16).padStart(2, '0');
  return `#${channel(ar, br)}${channel(ag, bg)}${channel(ab, bb)}`;
}

/**
 * How strong the raised and sunken edges of the page are: 1 is the full look, 0 is flat. Every edge, face and shadow below is
 * computed from it, so this is the one number that dials the whole style back.
 */
export const BEVEL = 1;
/** How far each frame's tones stand from the panel: the bevel's full, the flat frames' a quiet step (faces and title strips barely apart). */
export const FRAME_STRENGTH: Readonly<Record<Frame, number>> = { bevel: BEVEL, editor: 0.5, paper: 0.45, textmode: 0.35 };

/** The tones that give controls and windows their edges, derived from a palette so every theme has them. */
export interface Chrome {
  /** The 1px outline of a control, a window, a menu: strong enough to see (3:1 against the panel). */
  edge: string;
  /** The outline's lit sides (top and left) on a bevel: the classic desktop's light grey; elsewhere the outline itself. */
  edgeLit: string;
  /** The lit edge (top and left) and the shaded edge (bottom and right) of something raised; swapped for something pressed. */
  hi: string; lo: string;
  /** What a button is made of, a title bar is made of, and what a field's inside is made of (the sunken well). */
  face: string; title: string; well: string;
  /** A window's title bar and the lit row of a menu, and the text on them: the page's colours reversed on a light theme, a mid tone of the text colour on a dark one (a bright bar on a dark window glares). */
  bar: string; barText: string;
  /** The hard shadow under a window or a menu. */
  shadow: string;
  /** Words that warn (a status line such as "Not saved"): the sell colour, moved toward the text only as far as it takes to read on the panel, a face and a title strip. */
  warn: string;
  /**
   * Words that only ask for care (sound the browser holds until a press, a guide's "Keep in mind" note): amber, never the sell colour (a
   * caution is not a failure), moved toward the text as `warn` is until it reads.
   */
  caution: string;
}

const channelLight = (c: number): number => c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
export const lightness = (hex: string): number => { const [r, g, b] = rgb(hex); return 0.2126 * channelLight(r) + 0.7152 * channelLight(g) + 0.0722 * channelLight(b); };
/** WCAG contrast ratio between two #rrggbb colours. */
export function contrastRatio(a: string, b: string): number { const [hi, lo] = [lightness(a), lightness(b)].sort((x, y) => y - x) as [number, number]; return (hi + 0.05) / (lo + 0.05); }

/** `from` moved toward `to` by at least `start`, and further until it stands at least `ratio` apart from `from` (a palette whose text is soft needs more of it). */
function outline(from: string, to: string, start: number, ratio: number): string {
  let amount = start, tone = mixHex(from, to, amount);
  while (amount < 1 && contrastRatio(tone, from) < ratio) { amount = Math.min(1, amount + 0.04); tone = mixHex(from, to, amount); }
  return tone;
}

/** The amber a caution starts from (the Sound button's lamp while the browser holds sound). */
export const CAUTION = '#e6a700';

/** `base` as words: left as it is when it already reads (4.6:1) on the panel, the face and the title strip, else moved toward the text colour until it does. */
function wordsOf(base: string, p: Palette, face: string, title: string): string {
  const worst = (tone: string): number => Math.min(contrastRatio(tone, p.panel), contrastRatio(tone, face), contrastRatio(tone, title));
  let amount = 0, tone = base;
  while (amount < 1 && worst(tone) < 4.6) { amount = Math.min(1, amount + 0.04); tone = mixHex(base, p.text, amount); }
  return tone;
}

/** A surface `amount` of the way from the panel to `to`, eased back as far as it takes for the palette's muted text to stay readable on it. */
function surface(p: Palette, to: string, amount: number): string {
  let a = amount, tone = mixHex(p.panel, to, a);
  while (a > 0 && contrastRatio(p.muted, tone) < 4.55) { a = Math.max(0, a - 0.005); tone = mixHex(p.panel, to, a); }
  return tone;
}

/** A dark theme's title bar: part of the way from the panel to the text colour, eased back until the text stays well readable on it. */
function darkBar(p: Palette): string {
  let a = 0.26, tone = mixHex(p.panel, p.text, a);
  while (a > 0.04 && contrastRatio(p.text, tone) < 7.3) { a -= 0.02; tone = mixHex(p.panel, p.text, a); }
  return tone;
}

export function chromeFor(p: Palette, strength: number = FRAME_STRENGTH[p.frame]): Chrome {
  const s = Math.max(0, Math.min(1, strength));
  const out = derivedChrome(p, s), pins = p.chrome;
  if (pins) {
    // A palette's own tones come in with the strength like the derived ones (flat at 0); the title bar and its text are its own as they are.
    for (const key of ['edge', 'edgeLit', 'hi', 'lo', 'face', 'title', 'well'] as const) { const pin = pins[key]; if (pin) out[key] = mixHex(p.panel, pin, s); }
    if (pins.bar) out.bar = pins.bar;
    if (pins.barText) out.barText = pins.barText;
    if (pins.shadow) out.shadow = pins.shadow;
  }
  return { ...out, warn: wordsOf(p.ask, p, out.face, out.title), caution: wordsOf(CAUTION, p, out.face, out.title) };
}

function derivedChrome(p: Palette, s: number): Omit<Chrome, 'warn' | 'caution'> {
  const edgeOf = (c: Omit<Chrome, 'edgeLit' | 'warn' | 'caution'>): Omit<Chrome, 'warn' | 'caution'> => ({ ...c, edgeLit: c.edge });
  return p.dark
    ? edgeOf({ edge: outline(p.panel, p.text, 0.3 + 0.1 * s, 3.1), hi: mixHex(p.panel, '#ffffff', 0.16 * s), lo: mixHex(p.panel, '#000000', 0.55 * s), face: surface(p, '#ffffff', 0.04 * s),
      title: surface(p, '#ffffff', 0.08 * s), well: mixHex(p.bg, '#000000', 0.3), bar: darkBar(p), barText: p.text, shadow: `rgba(0, 0, 0, ${(0.55 * s).toFixed(2)})` })
    : edgeOf({ edge: outline(p.panel, p.text, 0.32 + 0.2 * s, 3.1), hi: mixHex(p.panel, '#ffffff', s), lo: mixHex(p.panel, p.text, 0.22 * s), face: surface(p, p.text, 0.04 * s),
      title: surface(p, p.text, 0.08 * s), well: mixHex(p.panel, '#ffffff', 0.7), bar: p.text, barText: p.bg, shadow: `rgba(0, 0, 0, ${(0.22 * s).toFixed(2)})` });
}

/**
 * The custom properties a palette sets on the page. The chrome's tones and `onUi` are named in camel case here and in kebab case in the
 * style sheets (barText is --bar-text); `onUi` is what is written on the accent (a lit segment, a pin, a chosen row's number): whichever of
 * near-black and white reads better on it.
 */
export function themeVars(palette: Palette): Record<string, string> {
  return { bg: palette.bg, panel: palette.panel, text: palette.text, muted: palette.muted, line: palette.line, accent: palette.accent,
    bid: palette.bid, 'bid-soft': palette.bidSoft, ask: palette.ask, 'ask-soft': palette.askSoft, ui: palette.ui, onUi: textOn(palette.ui, 1, palette),
    'candle-up': palette.candleUp, 'candle-down': palette.candleDown, ...chromeFor(palette) };
}

/** The colour of the browser's own bars (a phone's status bar and address bar): the page's, and in the bevel frame the grey of the top bar, so the two meet. */
export function themeColorOf(palette: Palette): string { return palette.frame === 'bevel' ? chromeFor(palette).face : palette.bg; }

export function applyTheme(name: string): Palette {
  const palette = paletteOf(name);
  const root = document.documentElement;
  for (const [key, value] of Object.entries(themeVars(palette))) root.style.setProperty(`--${key.replace(/[A-Z]/g, c => `-${c.toLowerCase()}`)}`, value);
  root.dataset.theme = palette.dark ? 'dark' : 'light';
  root.dataset.frame = palette.frame;
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', themeColorOf(palette));
  return palette;
}
export function rgb(hex: string): [number, number, number] {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16 & 255) / 255, (n >> 8 & 255) / 255, (n & 255) / 255];
}

/** Text that reads on something drawn in `color` at `alpha` over the background: near-black on a light result, white on a dark one. */
export function textOn(color: string, alpha: number, p: Palette): string {
  const [r, g, b] = rgb(color), [br, bg, bb] = rgb(p.bg), mix = (c: number, base: number) => c * alpha + base * (1 - alpha);
  const lin = (c: number) => c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  const luminance = 0.2126 * lin(mix(r, br)) + 0.7152 * lin(mix(g, bg)) + 0.0722 * lin(mix(b, bb));
  // Contrast ratios (WCAG) against white and against #121418 (luminance 0.0061): the stronger wins, about 0.19 where they meet.
  return (luminance + 0.05) / 0.0561 >= 1.05 / (luminance + 0.05) ? '#121418' : '#ffffff';
}
