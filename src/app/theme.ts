import { t } from './i18n.ts';
export interface Palette {
  label: string; dark: boolean;
  bg: string; panel: string; text: string; muted: string; line: string; accent: string;
  /** Focus rings, switches and selected controls. */
  ui: string;
  bid: string; bidSoft: string; ask: string; askSoft: string; candleUp: string; candleDown: string;
  /** The volume profile's lines (point of control, value area): a hue of its own, away from the buy and sell colours and the amber marks. */
  poc: string;
}

/**
 * Palettes. Text, muted text, accents and the buy / sell colours meet WCAG contrast against the background and the panel
 * (tests/app-theme.test.mts enforces it). Midnight follows Tokyo Night, Mocha and Latte follow Catppuccin, and Colour-blind safe uses the
 * Okabe-Ito blue and orange, which stay apart under the common red-green deficiencies.
 */
export const PALETTES: Record<string, Palette> = {
  light: { label: t('Light'), dark: false, bg: '#ffffff', panel: '#ffffff', text: '#1b1d21', muted: '#667085', line: '#e7e9ec', accent: '#1b1d21', ui: '#2f6bff',
    bid: '#0fa44a', bidSoft: '#cdeed8', ask: '#e0066f', askSoft: '#ffd0e6', candleUp: '#12a150', candleDown: '#e0115f', poc: '#7c3aed' },
  latte: { label: 'Latte', dark: false, bg: '#eff1f5', panel: '#f6f7fa', text: '#434660', muted: '#5c5f77', line: '#ccd0da', accent: '#1e66f5', ui: '#1e66f5',
    bid: '#368a24', bidSoft: '#cfe6c8', ask: '#d20f39', askSoft: '#f6cdd5', candleUp: '#368a24', candleDown: '#d20f39', poc: '#8839ef' },
  dark: { label: t('Dark'), dark: true, bg: '#121215', panel: '#17171b', text: '#fffcf0', muted: '#8b8d93', line: '#2a2c30', accent: '#00ffda', ui: '#5b9bff',
    bid: '#00ffda', bidSoft: '#0d5a4f', ask: '#ff4d57', askSoft: '#6b1c22', candleUp: '#00d9b8', candleDown: '#ff4d4d', poc: '#c4a7ff' },
  darker: { label: t('Darker'), dark: true, bg: '#0c0c0e', panel: '#111315', text: '#d9e2df', muted: '#7d8785', line: '#252b2c', accent: '#36d27c', ui: '#5b9bff',
    bid: '#28cf72', bidSoft: '#0f4a2c', ask: '#f05d67', askSoft: '#5a2329', candleUp: '#28cf72', candleDown: '#f05d67', poc: '#c4a7ff' },
  midnight: { label: 'Midnight', dark: true, bg: '#1a1b26', panel: '#16161e', text: '#c0caf5', muted: '#8089b3', line: '#292e42', accent: '#7aa2f7', ui: '#7aa2f7',
    bid: '#73daca', bidSoft: '#1c4a45', ask: '#f7768e', askSoft: '#5a2a3a', candleUp: '#9ece6a', candleDown: '#f7768e', poc: '#bb9af7' },
  mocha: { label: 'Mocha', dark: true, bg: '#1e1e2e', panel: '#181825', text: '#cdd6f4', muted: '#a6adc8', line: '#313244', accent: '#cba6f7', ui: '#89b4fa',
    bid: '#a6e3a1', bidSoft: '#2f4a35', ask: '#f38ba8', askSoft: '#5a2c3c', candleUp: '#a6e3a1', candleDown: '#f38ba8', poc: '#cba6f7' },
  colorblind: { label: t('Colour-blind safe'), dark: true, bg: '#12151c', panel: '#171b24', text: '#e8ecf4', muted: '#9aa3b5', line: '#2a3140', accent: '#e69f00', ui: '#56b4e9',
    bid: '#56b4e9', bidSoft: '#16405c', ask: '#e69f00', askSoft: '#5c3f00', candleUp: '#56b4e9', candleDown: '#e69f00', poc: '#cc79a7' },
  terminal: { label: 'Terminal', dark: true, bg: '#000000', panel: '#050805', text: '#00ff00', muted: '#51b85c', line: '#134b16', accent: '#00ff00', ui: '#00ff00',
    bid: '#00ff00', bidSoft: '#0a4d00', ask: '#ff0000', askSoft: '#5a0000', candleUp: '#11af00', candleDown: '#ff6363', poc: '#00e5ff' },
};
/** Order of the theme menu: light themes first, then dark ones from neutral to themed. */
export const THEME_ORDER = ['light', 'latte', 'dark', 'darker', 'midnight', 'mocha', 'colorblind', 'terminal'] as const;

/** Ids written by earlier builds, mapped to the current ones so a saved choice survives the rename. */
const THEME_ALIASES: Readonly<Record<string, string>> = { legacyLight: 'light', darkSurf: 'dark', darkTerminal: 'terminal', darkerDark: 'darker' };
export function resolveThemeId(name: unknown): string {
  const id = typeof name === 'string' ? THEME_ALIASES[name] ?? name : '';
  return id in PALETTES ? id : 'light';
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

/** The tones that give controls and windows their edges, derived from a palette so every theme has them. */
export interface Chrome {
  /** The 1px outline of a control, a window, a menu: strong enough to see (3:1 against the panel). */
  edge: string;
  /** The lit edge (top and left) and the shaded edge (bottom and right) of something raised; swapped for something pressed. */
  hi: string; lo: string;
  /** What a button is made of, a title bar is made of, and what a field's inside is made of (the sunken well). */
  face: string; title: string; well: string;
  /** A window's title bar and the lit row of a menu, and the text on them: the page's colours reversed on a light theme, a mid tone of the text colour on a dark one (a bright bar on a dark window glares). */
  bar: string; barText: string;
  /** The hard shadow under a window or a menu. */
  shadow: string;
}

const channelLight = (c: number): number => c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
const lightness = (hex: string): number => { const [r, g, b] = rgb(hex); return 0.2126 * channelLight(r) + 0.7152 * channelLight(g) + 0.0722 * channelLight(b); };
/** WCAG contrast ratio between two #rrggbb colours. */
export function contrastRatio(a: string, b: string): number { const [hi, lo] = [lightness(a), lightness(b)].sort((x, y) => y - x) as [number, number]; return (hi + 0.05) / (lo + 0.05); }

/** `from` moved toward `to` by at least `start`, and further until it stands at least `ratio` apart from `from` (a palette whose text is soft needs more of it). */
function outline(from: string, to: string, start: number, ratio: number): string {
  let amount = start, tone = mixHex(from, to, amount);
  while (amount < 1 && contrastRatio(tone, from) < ratio) { amount = Math.min(1, amount + 0.04); tone = mixHex(from, to, amount); }
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

export function chromeFor(p: Palette, strength: number = BEVEL): Chrome {
  const s = Math.max(0, Math.min(1, strength));
  return p.dark
    ? { edge: outline(p.panel, p.text, 0.3 + 0.1 * s, 3.1), hi: mixHex(p.panel, '#ffffff', 0.16 * s), lo: mixHex(p.panel, '#000000', 0.55 * s), face: surface(p, '#ffffff', 0.04 * s),
      title: surface(p, '#ffffff', 0.08 * s), well: mixHex(p.bg, '#000000', 0.3), bar: darkBar(p), barText: p.text, shadow: `rgba(0, 0, 0, ${(0.55 * s).toFixed(2)})` }
    : { edge: outline(p.panel, p.text, 0.32 + 0.2 * s, 3.1), hi: mixHex(p.panel, '#ffffff', s), lo: mixHex(p.panel, p.text, 0.22 * s), face: surface(p, p.text, 0.04 * s),
      title: surface(p, p.text, 0.08 * s), well: mixHex(p.panel, '#ffffff', 0.7), bar: p.text, barText: p.bg, shadow: `rgba(0, 0, 0, ${(0.22 * s).toFixed(2)})` };
}

export function applyTheme(name: string): Palette {
  const palette = PALETTES[resolveThemeId(name)]!;
  const root = document.documentElement;
  const vars: Record<string, string> = { bg: palette.bg, panel: palette.panel, text: palette.text, muted: palette.muted, line: palette.line, accent: palette.accent,
    bid: palette.bid, 'bid-soft': palette.bidSoft, ask: palette.ask, 'ask-soft': palette.askSoft, ui: palette.ui, 'candle-up': palette.candleUp, 'candle-down': palette.candleDown, ...chromeFor(palette) };
  for (const [key, value] of Object.entries(vars)) root.style.setProperty(`--${key}`, value);
  root.dataset.theme = palette.dark ? 'dark' : 'light';
  // The browser's own bars (the phone's status bar, the address bar) take the page's colour.
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', palette.bg);
  return palette;
}
export function rgb(hex: string): [number, number, number] {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16 & 255) / 255, (n >> 8 & 255) / 255, (n & 255) / 255];
}
