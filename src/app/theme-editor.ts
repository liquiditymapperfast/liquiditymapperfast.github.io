import { el } from './dom.ts';
import { t, tn } from './i18n.ts';
import { button, heading, note, selectRow } from './ui.ts';
import { toast } from './toast.ts';
import { DEFAULT_THEME, PHONE_DARK_THEME, slotsFor, themeChange, type Store } from './store.ts';
import { paletteOf, type Frame } from './theme.ts';
import { MAX_FILE_CHARS, MAX_THEMES, cleanThemeName, customPalette, exportThemes, importThemes, loadCustomThemes, mergeThemes, newTheme, putTheme, registerCustomThemes, storeCustomThemes, themeWarnings, type ColorKey, type CustomTheme } from './custom-themes.ts';

/**
 * The Theme panel (the theme menu's last row): on a built-in theme, a way to start a theme of one's own from it, and to read a themes file; on
 * one's own theme, its name, its shape and its sixteen colours. A colour shows on the whole page while it is being picked and is kept when the
 * picker closes, so the page itself is the preview and nothing is ever unsaved. The text colours are kept readable whatever is chosen
 * (custom-themes.ts `customPalette`); colours that will be hard to see are said, not refused.
 */

/** What the panel says after an action; kept across redraws while it is open. */
export interface ThemeEditorState { message: { text: string; error: boolean } | null }
export const newThemeEditorState = (): ThemeEditorState => ({ message: null });

const COLOR_NAME: Readonly<Record<ColorKey, () => string>> = {
  bg: () => t('Background'), panel: () => t('Panels'), text: () => t('Text'), muted: () => t('Quiet text'), line: () => t('Lines'),
  accent: () => t('Accent'), ui: () => t('Controls'), bid: () => t('Buy'), bidSoft: () => t('Buy, soft'), ask: () => t('Sell'), askSoft: () => t('Sell, soft'),
  candleUp: () => t('Rising candle'), candleDown: () => t('Falling candle'), poc: () => t('Volume profile'), level: () => t('Key levels'), vwap: () => t('VWAP'),
};
const COLOR_TIP: Readonly<Record<ColorKey, () => string>> = {
  bg: () => t('Behind the chart and the panes.'), panel: () => t('The bars, panels and menus.'), text: () => t('Words and figures. Moved toward black or white where it would not read.'),
  muted: () => t('Labels and second lines. Moved toward black or white where it would not read.'), line: () => t('Grid lines and separators.'),
  accent: () => t('Highlights and marks of the page.'), ui: () => t('Switches, focus rings and chosen buttons.'),
  bid: () => t('Buyers: bids in the book, buy flow, rising lines.'), bidSoft: () => t('Fills and shades on the buy side.'),
  ask: () => t('Sellers: asks in the book, sell flow, falling lines.'), askSoft: () => t('Fills and shades on the sell side.'),
  candleUp: () => t('Rising candles (Candle colours can set them apart from the theme).'), candleDown: () => t('Falling candles (Candle colours can set them apart from the theme).'),
  poc: () => t('The point of control and value area lines.'), level: () => t('The previous day\'s, week\'s and month\'s levels.'), vwap: () => t('The VWAP lines.'),
};
const GROUPS: readonly (readonly [() => string, readonly ColorKey[]])[] = [
  [() => t('Page'), ['bg', 'panel', 'text', 'muted', 'line', 'accent', 'ui']],
  [() => t('Buy and sell'), ['bid', 'bidSoft', 'ask', 'askSoft', 'candleUp', 'candleDown']],
  [() => t('Lines on the chart'), ['poc', 'level', 'vwap']],
];
const FRAME_CHOICES = (): [Frame, string][] => [['editor', t('Flat')], ['paper', t('Paper')], ['bevel', t('Raised, like a 1990s desktop')], ['textmode', t('Text mode')]];

/** Write a file the browser saves. */
function saveFile(name: string, text: string): void {
  const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
  el('a', { href: url, download: name }).click();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}
/** A file name from a theme's name: letters, digits and dashes. */
const fileName = (name: string): string => `liquiditymapperfast-theme-${name.toLocaleLowerCase().replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'theme'}.json`;

/**
 * The page drawn again in the theme it shows, after that theme's colours changed (the store tells every themed part, as for a new theme). A
 * background moved from light to dark (or back) moves the theme to the other kind's slot of the light-or-dark key, and the slot it left goes
 * back to its default, or the key would bring the theme itself.
 */
const repaint = (store: Store): void => { store.set({ theme: store.state.theme, themeSlots: slotsFor(store.state.themeSlots, store.state.theme) }); };

export function buildThemeEditor(store: Store, body: HTMLElement, redraw: () => void, ui: ThemeEditorState): void {
  const say = (text: string, error = false): void => { ui.message = { text, error }; redraw(); };
  // As this browser holds them now: another tab may have made, changed or deleted one.
  const list = loadCustomThemes(), current = list.find(x => x.id === store.state.theme) ?? null;
  registerCustomThemes(list);
  const fileInput = el('input', { type: 'file', accept: 'application/json,.json', hidden: true });
  fileInput.onchange = () => {
    const chosen = fileInput.files?.[0]; if (!chosen) return;
    // A file far larger than a themes file is something else: not read at all (a character is at most four bytes).
    if (chosen.size > MAX_FILE_CHARS * 4) { say(t('This is not a themes file.'), true); return; }
    void chosen.text().then(text => {
      const read = importThemes(text);
      if ('error' in read) { say(read.error === 'newer' ? t('This themes file is from a newer version of the page: reload the page and try again.') : read.error === 'empty' ? t('The file holds no theme this page can read.') : t('This is not a themes file.'), true); return; }
      const merged = mergeThemes(loadCustomThemes(), read.themes), n = merged.added + merged.replaced;
      if (!n) { say(t('{n} did not fit: at most {max}.', { n: merged.skipped, max: MAX_THEMES }), true); return; }
      if (!storeCustomThemes(merged.list)) { say(t('This browser did not let the page keep it.'), true); return; }
      // The first theme read is shown: a person reading one file wants to see it.
      const first = merged.list.find(x => x.name.toLocaleLowerCase() === read.themes[0]!.name.toLocaleLowerCase());
      if (first) store.set(themeChange(store.state, first.id, true)); else repaint(store);
      say(tn(n, 'Read {n} theme.', 'Read {n} themes.') + (merged.skipped ? ` ${t('{n} did not fit: at most {max}.', { n: merged.skipped, max: MAX_THEMES })}` : ''));
    }, () => say(t('This is not a themes file.'), true));
  };
  const importButton = button(t('Import'), () => fileInput.click(), t('Read themes from a file written by Export (a name already here is replaced)'));
  const exportAll = button(t('Export all'), () => saveFile('liquiditymapperfast-themes.json', exportThemes(loadCustomThemes())), t('Write all your themes to one file'));
  exportAll.disabled = !list.length;
  const message = (): HTMLElement[] => ui.message ? [el('p', { class: ui.message.error ? 'panel-note layout-message error' : 'panel-note layout-message', textContent: ui.message.text })] : [];

  if (!current) {
    // A built-in theme: start one's own from it.
    const shown = paletteOf(store.state.theme);
    body.append(note(t('Make a theme of your own: start from the one on the screen, then change any of its colours. Every change shows at once and is kept in this browser.')), ...message());
    const start = button(t('Copy “{name}” and edit it', { name: shown.label }), () => {
      const made = newTheme(store.state.theme, loadCustomThemes(), shown => t('{name} copy', { name: shown }), Date.now());
      if (!made) { say(t('At most {n} themes: delete one first.', { n: MAX_THEMES }), true); return; }
      const next = putTheme(loadCustomThemes(), made);
      if (!next || !storeCustomThemes(next)) { say(t('This browser did not let the page keep it.'), true); return; }
      ui.message = null;
      store.set(themeChange(store.state, made.id, true));
      redraw();
    }, t('A copy of this theme under a name of your own, ready to change'));
    body.append(el('div', { class: 'session-add' }, start));
    if (list.length) body.append(note(tn(list.length, 'You have {n} theme of your own: choose it in the theme menu to edit it.', 'You have {n} themes of your own: choose one in the theme menu to edit it.')));
    body.append(heading(t('Files')), note(t('A theme file holds colours only, so a theme from anyone is safe to read.')), el('div', { class: 'layout-tools' }, importButton, exportAll, fileInput));
    return;
  }

  // One's own theme: everything about it, kept as it changes.
  const keep = (next: CustomTheme): boolean => {
    const updated = putTheme(loadCustomThemes(), next);
    if (!updated || !storeCustomThemes(updated)) return false;
    repaint(store);
    return true;
  };
  let theme = current;
  const top = el('div');
  body.append(note(t('Your own theme: every change shows at once and is kept in this browser.')), top);

  const name = el('input', { type: 'text', class: 'layout-name-field', maxLength: 40, value: theme.name, ariaLabel: t('Name') });
  name.addEventListener('change', () => {
    const clean = cleanThemeName(name.value);
    if (!clean) { name.value = theme.name; say(t('Give the theme a name.'), true); return; }
    if (clean === theme.name) return;
    const next = { ...theme, name: clean, savedAt: Date.now() };
    if (!keep(next)) { name.value = theme.name; say(loadCustomThemes().some(x => x.id !== theme.id && x.name.toLocaleLowerCase() === clean.toLocaleLowerCase()) ? t('A theme with that name is already there.') : t('This browser did not let the page keep it.'), true); return; }
    theme = next; ui.message = null;
  });
  name.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); name.blur(); } });
  body.append(el('label', { class: 'theme-name' }, el('span', { textContent: t('Name') }), name));
  body.append(selectRow(t('Shape'), t('How the bars, buttons and panels are drawn: flat, softer paper, raised edges and title bars, or a terminal\'s double lines.'), FRAME_CHOICES(), theme.frame, v => {
    // A palette's own frame tones (Classic 95's grey) belong to the raised frame: another shape draws from the colours alone.
    const { chrome: _pins, ...rest } = theme, next = { ...(v === 'bevel' ? theme : rest), frame: v as Frame, savedAt: Date.now() };
    if (keep(next)) { theme = next; redraw(); } else say(t('This browser did not let the page keep it.'), true);
  }));

  for (const [title, keys] of GROUPS) {
    body.append(heading(title()));
    const grid = el('div', { class: 'theme-colors' });
    for (const key of keys) {
      const input = el('input', { type: 'color', value: theme.colors[key], class: 'line-swatch', ariaLabel: COLOR_NAME[key](), tip: COLOR_TIP[key]() });
      input.dataset.focus = `theme-${key}`;
      // While the picker is open the page follows it, and keeps it, a few times a second. The panel is not rebuilt (the picker belongs to
      // this input): only what it says about the colours is.
      let timer = 0;
      const show = (): void => {
        const value = input.value.toLowerCase();
        if (value === theme.colors[key]) return;
        const next = { ...theme, colors: { ...theme.colors, [key]: value }, savedAt: Date.now() };
        if (keep(next)) { theme = next; ui.message = null; } else ui.message = { text: t('This browser did not let the page keep it.'), error: true };
        sayAbout();
      };
      input.oninput = () => { if (!timer) timer = window.setTimeout(() => { timer = 0; show(); }, 80); };
      input.onchange = () => { window.clearTimeout(timer); timer = 0; show(); };
      grid.append(el('label', { class: 'theme-color', tip: COLOR_TIP[key]() }, input, el('span', { textContent: COLOR_NAME[key]() })));
    }
    body.append(grid);
  }

  const notes = el('div');
  /** What the panel says about the colours as they are now (and a message), redrawn in place as a colour changes. */
  const sayAbout = (): void => {
    top.replaceChildren(...message());
    const { palette, adjusted } = customPalette(theme), warn = themeWarnings(palette), out: HTMLElement[] = [];
    // A copy of Classic 95 keeps its grey buttons in the raised shape: they, not the panels, are what the text cannot read on.
    if (warn.clash && theme.chrome && theme.frame === 'bevel') out.push(note(t('The raised shape keeps the grey buttons of the theme this one was copied from, and no text reads on them and on your colours both: choose another Shape.')));
    else if (warn.clash) out.push(note(t('The background and the panels are too far apart for any text to read well on both: bring one closer to the other.')));
    else if (adjusted.length) out.push(note(t('So that every word reads, the page draws {names} a little lighter or darker than chosen.', { names: adjusted.map(k => COLOR_NAME[k]()).join(', ') })));
    if (warn.faint.length) out.push(note(t('Hard to see on this background: {names}.', { names: warn.faint.map(k => COLOR_NAME[k]()).join(', ') })));
    if (warn.alike) out.push(note(t('Buy and sell look alike: the book and the flow will be hard to read.')));
    notes.replaceChildren(...out);
  };
  sayAbout();
  body.append(notes);

  const duplicate = button(t('Duplicate'), () => {
    const made = newTheme(theme.id, loadCustomThemes(), shown => t('{name} copy', { name: shown }), Date.now());
    const next = made ? putTheme(loadCustomThemes(), made) : null;
    if (!made || !next) { say(t('At most {n} themes: delete one first.', { n: MAX_THEMES }), true); return; }
    if (!storeCustomThemes(next)) { say(t('This browser did not let the page keep it.'), true); return; }
    store.set(themeChange(store.state, made.id, true));
    say(t('Copied as “{name}”.', { name: made.name }));
  }, t('A copy of this theme under another name'));
  const remove = button(t('Delete'), () => {
    const before = loadCustomThemes(), at = before.findIndex(x => x.id === theme.id), gone = before[at];
    if (!gone || !storeCustomThemes(before.filter(x => x.id !== gone.id))) { say(t('This browser did not let the page keep it.'), true); return; }
    // The page goes to the built-in theme of its kind; the light-or-dark key forgets the deleted one.
    const dark = customPalette(gone).palette.dark, s = store.state;
    const slots = { light: s.themeSlots.light === gone.id ? DEFAULT_THEME : s.themeSlots.light, dark: s.themeSlots.dark === gone.id ? PHONE_DARK_THEME : s.themeSlots.dark };
    store.set({ ...themeChange({ themeSlots: slots }, dark ? 'dark' : 'light', true) });
    ui.message = null; redraw();
    toast(t('Deleted “{name}”.', { name: gone.name }), { action: { label: t('Undo'), run: () => {
      const now = loadCustomThemes(), back = now.length < MAX_THEMES && !now.some(x => x.name.toLocaleLowerCase() === gone.name.toLocaleLowerCase()) ? [...now.slice(0, at), gone, ...now.slice(at)] : null;
      if (!back || !storeCustomThemes(back)) { toast(t('“{name}” could not be brought back: its name is taken, or there are {n} themes already.', { name: gone.name, n: MAX_THEMES })); return; }
      store.set(themeChange(store.state, gone.id, true));
      redraw();
    } } });
  }, t('Delete this theme (the message that follows can bring it back)'));
  const exportOne = button(t('Export'), () => saveFile(fileName(theme.name), exportThemes([theme])), t('Write this theme to a file, to keep it, share it or use it in another browser'));
  body.append(heading(t('More')), el('div', { class: 'layout-tools' }, duplicate, remove, exportOne, exportAll, importButton, fileInput));
}
