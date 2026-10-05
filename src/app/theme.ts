export interface Palette {
  label: string; dark: boolean;
  bg: string; panel: string; text: string; muted: string; line: string; accent: string;
  /** Focus rings, switches and selected controls. */
  ui: string;
  bid: string; bidSoft: string; ask: string; askSoft: string; candleUp: string; candleDown: string;
}

/**
 * Palettes. Text, muted text, accents and the buy / sell colours meet WCAG contrast against the background and the panel
 * (tests/app-theme.test.mts enforces it). Midnight follows Tokyo Night, Mocha and Latte follow Catppuccin, and Colour-blind safe uses the
 * Okabe-Ito blue and orange, which stay apart under the common red-green deficiencies.
 */
export const PALETTES: Record<string, Palette> = {
  light: { label: 'Light', dark: false, bg: '#ffffff', panel: '#ffffff', text: '#1b1d21', muted: '#667085', line: '#e7e9ec', accent: '#1b1d21', ui: '#2f6bff',
    bid: '#0fa44a', bidSoft: '#cdeed8', ask: '#e0066f', askSoft: '#ffd0e6', candleUp: '#12a150', candleDown: '#e0115f' },
  latte: { label: 'Latte', dark: false, bg: '#eff1f5', panel: '#f6f7fa', text: '#434660', muted: '#5c5f77', line: '#ccd0da', accent: '#1e66f5', ui: '#1e66f5',
    bid: '#368a24', bidSoft: '#cfe6c8', ask: '#d20f39', askSoft: '#f6cdd5', candleUp: '#368a24', candleDown: '#d20f39' },
  dark: { label: 'Dark', dark: true, bg: '#121215', panel: '#17171b', text: '#fffcf0', muted: '#8b8d93', line: '#2a2c30', accent: '#00ffda', ui: '#5b9bff',
    bid: '#00ffda', bidSoft: '#0d5a4f', ask: '#ff4d57', askSoft: '#6b1c22', candleUp: '#00d9b8', candleDown: '#ff4d4d' },
  darker: { label: 'Darker', dark: true, bg: '#0c0c0e', panel: '#111315', text: '#d9e2df', muted: '#7d8785', line: '#252b2c', accent: '#36d27c', ui: '#5b9bff',
    bid: '#28cf72', bidSoft: '#0f4a2c', ask: '#f05d67', askSoft: '#5a2329', candleUp: '#28cf72', candleDown: '#f05d67' },
  midnight: { label: 'Midnight', dark: true, bg: '#1a1b26', panel: '#16161e', text: '#c0caf5', muted: '#8089b3', line: '#292e42', accent: '#7aa2f7', ui: '#7aa2f7',
    bid: '#73daca', bidSoft: '#1c4a45', ask: '#f7768e', askSoft: '#5a2a3a', candleUp: '#9ece6a', candleDown: '#f7768e' },
  mocha: { label: 'Mocha', dark: true, bg: '#1e1e2e', panel: '#181825', text: '#cdd6f4', muted: '#a6adc8', line: '#313244', accent: '#cba6f7', ui: '#89b4fa',
    bid: '#a6e3a1', bidSoft: '#2f4a35', ask: '#f38ba8', askSoft: '#5a2c3c', candleUp: '#a6e3a1', candleDown: '#f38ba8' },
  colorblind: { label: 'Colour-blind safe', dark: true, bg: '#12151c', panel: '#171b24', text: '#e8ecf4', muted: '#9aa3b5', line: '#2a3140', accent: '#e69f00', ui: '#56b4e9',
    bid: '#56b4e9', bidSoft: '#16405c', ask: '#e69f00', askSoft: '#5c3f00', candleUp: '#56b4e9', candleDown: '#e69f00' },
  terminal: { label: 'Terminal', dark: true, bg: '#000000', panel: '#050805', text: '#00ff00', muted: '#51b85c', line: '#134b16', accent: '#00ff00', ui: '#00ff00',
    bid: '#00ff00', bidSoft: '#0a4d00', ask: '#ff0000', askSoft: '#5a0000', candleUp: '#11af00', candleDown: '#ff6363' },
};
/** Order of the theme menu: light themes first, then dark ones from neutral to themed. */
export const THEME_ORDER = ['light', 'latte', 'dark', 'darker', 'midnight', 'mocha', 'colorblind', 'terminal'] as const;

/** Ids written by earlier builds, mapped to the current ones so a saved choice survives the rename. */
const THEME_ALIASES: Readonly<Record<string, string>> = { legacyLight: 'light', darkSurf: 'dark', darkTerminal: 'terminal', darkerDark: 'darker' };
export function resolveThemeId(name: unknown): string {
  const id = typeof name === 'string' ? THEME_ALIASES[name] ?? name : '';
  return id in PALETTES ? id : 'light';
}
export function applyTheme(name: string): Palette {
  const palette = PALETTES[resolveThemeId(name)]!;
  const root = document.documentElement;
  const vars: Record<string, string> = { bg: palette.bg, panel: palette.panel, text: palette.text, muted: palette.muted, line: palette.line, accent: palette.accent,
    bid: palette.bid, 'bid-soft': palette.bidSoft, ask: palette.ask, 'ask-soft': palette.askSoft, ui: palette.ui };
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
