import { el } from '../dom.ts';
import { t, tn } from '../i18n.ts';
import { clock } from '../format.ts';
import { openMenu, type MenuItem } from '../menu.ts';
import { button, heading, note } from '../ui.ts';
import { MAX_LAYOUTS, exportFile, importFile, loadLayouts, mergeLayouts, storeLayouts, type SavedLayout } from './layouts.ts';
import { PRESETS, buildPreset, type PresetDef } from './presets.ts';
import { PANE_SHOW_KEY } from './dock-model.ts';
import { thumbBoxes, type ThumbBox } from './thumb.ts';
import type { LayoutActions } from './actions.ts';

/** What the panel says after an action, which of the person's own layouts is being renamed, and whether a save keeps the chart's settings; kept across redraws while the panel is open. */
export interface GalleryState { message: { text: string; error: boolean } | null; renaming: string | null; withSettings: boolean }
export const newGalleryState = (): GalleryState => ({ message: null, renaming: null, withSettings: false });

const NS = 'http://www.w3.org/2000/svg';
const mark = (tag: string, attrs: Record<string, string | number>): SVGElement => { const node = document.createElementNS(NS, tag); for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, String(v)); return node; };

/** A layout as a small picture of its panes (`thumb.ts` has the arithmetic; this draws it in the page's own colours). */
export function thumbSvg(boxes: readonly ThumbBox[]): SVGSVGElement {
  const W = 120, H = 72, P = 2, root = mark('svg', { viewBox: `0 0 ${W} ${H}`, class: 'layout-thumb', 'aria-hidden': 'true' }) as SVGSVGElement;
  for (const b of boxes) {
    const x = P + b.x * (W - 2 * P), y = P + b.y * (H - 2 * P), w = b.w * (W - 2 * P), h = b.h * (H - 2 * P), g = mark('g', { class: `t-${b.kind}` });
    g.append(mark('rect', { x: x.toFixed(2), y: y.toFixed(2), width: w.toFixed(2), height: h.toFixed(2), rx: 1.4 }));
    const line = (points: [number, number][]): SVGElement => mark('polyline', { points: points.map(([px, py]) => `${(x + px * w).toFixed(2)},${(y + py * h).toFixed(2)}`).join(' ') });
    if (b.kind === 'map') g.append(line([[0.06, 0.72], [0.3, 0.6], [0.45, 0.66], [0.62, 0.4], [0.94, 0.3]]));
    else if (b.kind === 'strip') g.append(line([[0.06, 0.6], [0.3, 0.45], [0.5, 0.55], [0.72, 0.3], [0.94, 0.4]]));
    else if (b.kind === 'cvd') for (const at of [0.26, 0.5, 0.74]) g.append(line([[0.12, at + 0.08], [0.4, at - 0.04], [0.65, at + 0.02], [0.88, at - 0.08]]));
    else for (let i = 0; i < 6 && h > 14; i++) g.append(line([[0.12, 0.14 + i * 0.14], [0.35 + ((i * 37) % 5) * 0.1, 0.14 + i * 0.14]]));
    root.append(g);
  }
  return root;
}

/**
 * The Layouts panel: the layout the screen is showing, the ready-made layouts and the person's own as cards (a card is a picture of its panes),
 * saving what is on the screen, and the panes one by one. Applying one arranges the panes first and then sets the switches, so the panes it
 * shows get their splitters from the new arrangement; every change on the screen offers Undo.
 */
export function buildGallery(actions: LayoutActions, body: HTMLElement, redraw: () => void, ui: GalleryState): void {
  const say = (text: string, error = false): void => { ui.message = { text, error }; redraw(); };
  const env = actions.host.env(), now = actions.store.state, saved = loadLayouts(), active = actions.active(), activeName = actions.activeName(), changed = actions.modified();
  /** After a layout is applied the page lays itself out in the next frame; the panel follows its button then. */
  const later = (): void => { requestAnimationFrame(() => requestAnimationFrame(redraw)); };

  body.append(note(t('Drag a panel by its grip to move it, or use its ⋯ menu. × hides a panel; the buttons under Panels bring it back.')));

  // What the screen shows now.
  const screen = thumbSvg(thumbBoxes(actions.host.arrangement(), now.show, env));
  body.append(el('div', { class: 'layout-now' }, screen, el('span', { class: 'layout-now-text', textContent: activeName === null ? t('Showing an arrangement of your own.') : changed ? t('Showing “{name}”, changed since.', { name: activeName }) : t('Showing “{name}”.', { name: activeName }) })));
  if (ui.message) body.append(el('p', { class: ui.message.error ? 'panel-note layout-message error' : 'panel-note layout-message', textContent: ui.message.text }));

  // Ready-made.
  body.append(heading(t('Ready-made')));
  const preset = (def: PresetDef): HTMLElement => {
    const built = buildPreset(def, env), on = active?.kind === 'preset' && active.id === def.id && activeName !== null;
    const card = el('div', { class: on ? 'layout-card on' : 'layout-card' },
      el('button', { type: 'button', class: 'layout-apply', tip: def.blurb(), onclick: () => { actions.applyPreset(def); later(); } },
        thumbSvg(thumbBoxes(built.arrangement, { ...now.show, ...built.show }, env)),
        el('span', { class: 'layout-title', textContent: def.name() }), el('span', { class: 'layout-blurb', textContent: def.blurb() })));
    card.dataset.layout = def.id;
    return card;
  };
  body.append(el('div', { class: 'layout-grid' }, ...PRESETS.map(preset)));

  // Their own.
  body.append(heading(t('Yours')));
  const own = (layout: SavedLayout): HTMLElement => {
    const on = active?.kind === 'saved' && active.id.toLocaleLowerCase() === layout.name.toLocaleLowerCase();
    const open = { ...now.show, ...(layout.settings.show ?? {}) };
    const picture = thumbSvg(thumbBoxes(layout.panes, open, env));
    const more = el('button', { type: 'button', class: 'layout-more pane-more', tip: t('Update, rename, copy or delete this layout'), ariaLabel: t('Update, rename, copy or delete this layout') });
    more.onclick = () => {
      const items: MenuItem[] = [{ id: 'update', label: t('Update') }, { id: 'rename', label: t('Rename') }, { id: 'copy', label: t('Duplicate') }, { id: 'delete', label: t('Delete') }];
      openMenu(more, items, '', {
        onPreview: () => {},
        onSelect: id => {
          if (id === 'update') { const kept = actions.update(layout.name); say(kept ? t('Updated “{name}”.', { name: layout.name }) : t('This browser did not let the page keep it.'), !kept); }
          else if (id === 'rename') { ui.renaming = layout.name; redraw(); }
          else if (id === 'copy') {
            const copy = actions.duplicate(layout.name);
            say(copy.ok ? t('Copied as “{name}”.', { name: copy.name }) : copy.why === 'full' ? t('At most {n} layouts: delete one first.', { n: MAX_LAYOUTS }) : t('This browser did not let the page keep it.'), !copy.ok);
          } else if (actions.remove(layout.name)) { ui.message = null; redraw(); }
          else say(t('This browser did not let the page keep it.'), true);
        },
      }, 'right', { keepPanel: true });
    };
    const name = ui.renaming === layout.name ? renameField(layout) : el('span', { class: 'layout-title', textContent: layout.name });
    const card = el('div', { class: on ? 'layout-card own on' : 'layout-card own' },
      el('button', { type: 'button', class: 'layout-apply', tip: t('Apply this layout'), onclick: () => { actions.applySaved(layout); later(); } }, picture, name, el('span', { class: 'layout-blurb', textContent: layout.savedAt ? clock(layout.savedAt, true) : '' })), more);
    card.dataset.layout = layout.name;
    return card;
  };
  const renameField = (layout: SavedLayout): HTMLElement => {
    const input = el('input', { type: 'text', class: 'layout-rename', maxLength: 40, value: layout.name, ariaLabel: t('Name') });
    const done = (commit: boolean, afterClick = false): void => {
      ui.renaming = null;
      if (commit && input.value !== layout.name) {
        const r = actions.rename(layout.name, input.value);
        ui.message = { text: r === 'ok' ? t('Renamed to “{name}”.', { name: input.value.trim() }) : r === 'taken' ? t('A layout with that name is already there.') : r === 'name' ? t('Give the layout a name.') : t('This browser did not let the page keep it.'), error: r !== 'ok' };
      }
      if (!afterClick) { redraw(); return; }
      // The focus leaves the field with the press that takes it. Redrawing the panel now would remove the very button being pressed, so that the click, finding its
      // target gone, would not reach it and would read as a click outside the panel, which closes it: the panel is redrawn once the click has been handled.
      const redrawn = (): void => { window.clearTimeout(timer); document.removeEventListener('click', onClick, true); redraw(); };
      const onClick = (): void => { window.setTimeout(redrawn, 0); };
      const timer = window.setTimeout(redrawn, 600);
      document.addEventListener('click', onClick, true);
    };
    input.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); done(true); } else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); done(false); } });
    input.addEventListener('blur', () => { if (ui.renaming === layout.name) done(true, true); });
    input.addEventListener('click', e => e.stopPropagation());
    requestAnimationFrame(() => { input.focus(); input.select(); });
    return input;
  };
  body.append(saved.length ? el('div', { class: 'layout-grid' }, ...saved.map(own)) : note(t('None of your own yet. Arrange the panels, give the layout a name and press Save.')));

  const field = el('input', { type: 'text', class: 'layout-name-field', maxLength: 40, placeholder: t('Name'), ariaLabel: t('Name') });
  const keepSettings = el('input', { type: 'checkbox', checked: ui.withSettings }); keepSettings.onchange = () => { ui.withSettings = keepSettings.checked; };
  const save = (): void => {
    const r = actions.save(field.value, ui.withSettings);
    if (r.ok) { ui.message = { text: r.replaced ? t('Replaced “{name}”.', { name: r.name }) : t('Saved “{name}”.', { name: r.name }), error: false }; later(); redraw(); return; }
    say(r.why === 'name' ? t('Give the layout a name.') : r.why === 'full' ? t('At most {n} layouts: delete one first.', { n: MAX_LAYOUTS }) : t('This browser did not let the page keep it.'), true);
  };
  field.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); save(); } });
  body.append(el('div', { class: 'layout-save' }, field, button(t('Save'), save, t('Save the panels as they stand under this name (the same name replaces it).'))),
    el('label', { class: 'layout-keep', tip: t('Also keeps the timeframe, the heatmap colours and what every switch is set to; applying the layout sets them again.') }, keepSettings, el('span', { textContent: t('With the chart’s settings') })));

  // The panels, one by one.
  body.append(heading(t('Panels')));
  const chips = el('div', { class: 'layout-chips' });
  const PANELS: readonly (readonly [string, string])[] = [['cvd', t('Flow')], ['book', t('Book')], ['stats', t('Stats')], ['depth', t('Depth')], ['oi', 'OI'], ['delta', t('Delta')], ['ls', t('L/S')], ['lt', 'LT']];
  for (const [key, label] of PANELS) {
    const id = Object.keys(PANE_SHOW_KEY).find(k => PANE_SHOW_KEY[k] === key)!, on = now.show[key as keyof typeof now.show];
    const chip = el('button', { type: 'button', class: on ? 'chip on' : 'chip', textContent: label, onclick: () => { actions.setPane(id, !on); redraw(); } });
    chip.setAttribute('aria-pressed', String(on));
    chips.append(chip);
  }
  body.append(chips);

  // The rest.
  const file = el('input', { type: 'file', accept: 'application/json,.json', hidden: true });
  file.onchange = () => {
    const chosen = file.files?.[0]; if (!chosen) return;
    void chosen.text().then(text => {
      const read = importFile(text);
      if ('error' in read) { say(read.error === 'empty' ? t('The file holds no layout this page can read.') : t('This is not a layouts file.'), true); return; }
      const merged = mergeLayouts(loadLayouts(), read.layouts), n = merged.added + merged.replaced;
      const done = tn(n, 'Read {n} layout.', 'Read {n} layouts.') + (merged.skipped ? ` ${t('{n} did not fit: at most {max}.', { n: merged.skipped, max: MAX_LAYOUTS })}` : '');
      if (n && storeLayouts(merged.list)) say(done); else say(n ? t('This browser did not let the page keep it.') : done, true);
    }, () => say(t('This is not a layouts file.'), true));
  };
  const exportAll = (): void => {
    const url = URL.createObjectURL(new Blob([exportFile(loadLayouts())], { type: 'application/json' }));
    el('a', { href: url, download: 'liquiditymapperfast-layouts.json' }).click();
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
  };
  const exportButton = button(t('Export'), exportAll, t('Write the saved layouts to a file, to keep them or use them in another browser'));
  exportButton.disabled = !saved.length;
  body.append(heading(t('More')), el('div', { class: 'layout-tools' },
    button(t('Swap the two sides'), () => { actions.host.swapSides(); later(); }, t('The flow column and the book exchange sides')),
    exportButton, button(t('Import'), () => file.click(), t('Read layouts from a file written by Export (a name already here is replaced)')), file));
}
