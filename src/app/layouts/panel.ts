import { el } from '../dom.ts';
import { t, tn } from '../i18n.ts';
import { clock } from '../format.ts';
import { button, heading, note } from '../ui.ts';
import type { Store } from '../store.ts';
import { MAX_LAYOUTS, cleanName, exportFile, importFile, loadLayouts, mergeLayouts, settingsOf, settingsToApply, storeLayouts, upsert, type PaneArrangement, type SavedLayout } from './layouts.ts';

/** What arranges the panes (the page's Layout). */
export interface PaneHost { arrangement(): PaneArrangement; apply(a: PaneArrangement): void; defaults(): PaneArrangement }

/** What the panel says after an action, and which layout's Delete waits for its second press; kept across redraws while the panel is open. */
export interface LayoutsPanelState { message: { text: string; error: boolean } | null; armed: string | null }

/**
 * The Layouts panel: save what is on the screen under a name, apply, update or delete a saved one, go back to the default, and write the
 * layouts to a file or read them from one. Applying arranges the panes first and then sets the settings, so the panes it shows get their
 * splitters from the new arrangement.
 */
export function buildLayoutsPanel(store: Store, panes: PaneHost, body: HTMLElement, redraw: () => void, ui: LayoutsPanelState): void {
  const list = loadLayouts();
  const say = (text: string, error = false): void => { ui.message = { text, error }; ui.armed = null; redraw(); };
  const keep = (next: SavedLayout[], done: string): void => { if (storeLayouts(next)) say(done); else say(t('This browser did not let the page keep it.'), true); };
  const capture = (name: string): SavedLayout => ({ name, savedAt: Date.now(), settings: settingsOf(store.state), panes: panes.arrangement() });
  const apply = (layout: { panes: PaneArrangement; settings: SavedLayout['settings'] }): void => { panes.apply(layout.panes); store.set(settingsToApply(layout.settings, store.state)); };

  body.append(note(t('A layout keeps the panes, their sizes and what the chart shows: not the coin, the venues, the theme, the time zone, the sounds or your VWAP anchors.')));

  const input = el('input', { type: 'text', class: 'layout-name', maxLength: 40, placeholder: t('Name'), ariaLabel: t('Name') });
  const save = (): void => {
    const name = cleanName(input.value);
    if (!name) { say(t('Give the layout a name.'), true); return; }
    const had = list.some(l => l.name.toLocaleLowerCase() === name.toLocaleLowerCase()), next = upsert(list, capture(name));
    if (!next) { say(t('At most {n} layouts: delete one first.', { n: MAX_LAYOUTS }), true); return; }
    keep(next, had ? t('Replaced “{name}”.', { name }) : t('Saved “{name}”.', { name }));
  };
  input.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); save(); } });
  body.append(el('div', { class: 'layout-save' }, input, button(t('Save'), save, t('Save the panes and what the chart shows under this name (the same name replaces it).'))));
  if (ui.message) body.append(el('p', { class: ui.message.error ? 'panel-note layout-message error' : 'panel-note layout-message', textContent: ui.message.text }));

  body.append(heading(t('Saved')));
  if (!list.length) body.append(note(t('No layouts saved yet.')));
  for (const layout of list) {
    const armed = ui.armed === layout.name;
    const remove = button(armed ? t('Sure?') : t('Delete'), () => {
      if (!armed) { ui.armed = layout.name; redraw(); return; }
      keep(list.filter(l => l !== layout), t('Deleted “{name}”.', { name: layout.name }));
    }, t('Delete this layout (press twice)'));
    if (armed) remove.classList.add('armed');
    body.append(el('div', { class: 'layout-row' },
      button(layout.name, () => { apply(layout); say(t('Applied “{name}”.', { name: layout.name })); }, t('Apply this layout')),
      el('span', { class: 'layout-date', textContent: layout.savedAt ? clock(layout.savedAt, true) : '' }),
      button(t('Update'), () => { const next = upsert(list, capture(layout.name)); if (next) keep(next, t('Updated “{name}”.', { name: layout.name })); }, t('Keep what is on the screen now under this name')),
      remove));
  }

  const file = el('input', { type: 'file', accept: 'application/json,.json', hidden: true });
  file.onchange = () => {
    const chosen = file.files?.[0]; if (!chosen) return;
    void chosen.text().then(text => {
      const read = importFile(text);
      if ('error' in read) { say(read.error === 'empty' ? t('The file holds no layout this page can read.') : t('This is not a layouts file.'), true); return; }
      const merged = mergeLayouts(loadLayouts(), read.layouts), n = merged.added + merged.replaced;
      const done = tn(n, 'Read {n} layout.', 'Read {n} layouts.') + (merged.skipped ? ` ${t('{n} did not fit: at most {max}.', { n: merged.skipped, max: MAX_LAYOUTS })}` : '');
      if (n) keep(merged.list, done); else say(done, true);
    }, () => say(t('This is not a layouts file.'), true));
  };
  const exportAll = (): void => {
    const url = URL.createObjectURL(new Blob([exportFile(list)], { type: 'application/json' }));
    el('a', { href: url, download: 'liquiditymapperfast-layouts.json' }).click();
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
  };
  const exportButton = button(t('Export'), exportAll, t('Write the saved layouts to a file, to keep them or use them in another browser'));
  exportButton.disabled = !list.length;
  body.append(heading(t('More')), el('div', { class: 'layout-tools' },
    button(t('Default layout'), () => { apply({ panes: panes.defaults(), settings: {} }); say(t('Back to the default layout.')); }, t('The panes and settings the page starts with')),
    exportButton, button(t('Import'), () => file.click(), t('Read layouts from a file written by Export (a name already here is replaced)')), file));
}
