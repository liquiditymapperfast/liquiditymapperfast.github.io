import { el } from './dom.ts';
import { compactBar } from './device.ts';
import { makeDraggable } from './drag.ts';
import type { VenueControl, VenueEntry } from './source.ts';
import { t } from './i18n.ts';

interface Row { entry: VenueEntry; status: string; label: HTMLElement; box: HTMLInputElement }

/**
 * Venue picker. The dialog is built once and only its text is updated afterwards, so it stays open while the status of each
 * venue refreshes; it closes only on Close or Escape. What running a selection means is the data source's business.
 */
export async function openVenueDialog(venues: VenueControl, selectionProduct: () => string, onApplied: () => void = () => {}): Promise<void> {
  const dialog = el('dialog', { class: 'venues' });
  dialog.append(el('h3', { textContent: t('Order book venues') }), el('p', { class: 'muted', textContent: t('Loading…') }));
  document.body.append(dialog); dialog.showModal();
  // Movable by its title like the panels (the title is replaced when the catalogue arrives, so the press is looked at, not one element), and brought back inside the page when that changes size.
  const drag = makeDraggable(dialog, { grabs: target => target.closest('h3') !== null, enabled: () => !compactBar(), size: () => ({ width: dialog.offsetWidth, need: dialog.offsetHeight }) });
  const keepInside = (): void => drag.clamp();
  window.addEventListener('resize', keepInside);
  let timer = 0;
  dialog.addEventListener('close', () => { window.clearInterval(timer); window.removeEventListener('resize', keepInside); dialog.remove(); });
  const close = el('button', { textContent: t('Close'), onclick: () => dialog.close() });
  try {
    const catalog = await venues.catalog();
    const rows: Row[] = [];
    const list = el('div', { class: 'venue-list' });
    const note = el('p', { class: 'muted' });
    for (const entry of catalog.venues) {
      const box = el('input', { type: 'checkbox', checked: entry.selected, disabled: !entry.supported });
      const label = el('span', { class: entry.state === 'blocked' ? 'muted blocked' : 'muted', textContent: entry.status });
      box.onchange = () => count();
      rows.push({ entry, status: entry.status, label, box });
      list.append(el('label', {}, box, entry.name, label));
    }
    const count = () => { { const n = rows.filter(r => r.box.checked).length, total = rows.filter(r => r.entry.supported).length; note.textContent = catalog.limit === null ? t('{n} of {total} selected.', { n, total }) : t('{n} of {total} selected (up to {limit} feed venues).', { n, total, limit: catalog.limit }); } };
    count();
    const setAll = (checked: boolean) => { for (const row of rows) if (row.entry.supported) row.box.checked = checked; count(); };
    /** The largest venues with deep, fresh books (the first-run set); nothing is applied until Apply. */
    const recommend = () => { for (const row of rows) if (row.entry.supported) row.box.checked = row.entry.recommended; count(); };

    const apply = el('button', { textContent: t('Apply') });
    apply.onclick = async () => {
      apply.disabled = true; note.textContent = t('Applying… venues connect in the background; status updates below.');
      try {
        await venues.apply(rows.filter(r => r.box.checked).map(r => r.entry.id), selectionProduct());
        count(); note.textContent += ' ' + t('Applied.'); onApplied();
      } catch (error) { note.textContent = error instanceof Error ? error.message : String(error); }
      apply.disabled = false;
    };

    const refresh = async () => {
      try {
        const status = new Map((await venues.catalog()).venues.map(v => [v.id, v] as const));
        for (const row of rows) {
          const now = status.get(row.entry.id), text = now?.status ?? row.status;
          if (row.label.textContent !== text) row.label.textContent = text;
          row.label.classList.toggle('blocked', now?.state === 'blocked');
        }
      } catch { /* the next tick retries */ }
    };
    // Closed while the catalogue was on its way: its close handler had no timer to stop yet, so one started now would poll for ever.
    if (!dialog.isConnected) return;
    timer = window.setInterval(() => void refresh(), 2000);
    dialog.replaceChildren(el('h3', { textContent: t('Order book venues') }), list, note,
      el('div', { class: 'row' }, el('button', { textContent: t('Recommended'), tip: catalog.recommendedKnown ? t('The largest venues with deep, fresh order books (the first-run set)') : t('Needs a server restarted on this version'), onclick: recommend, disabled: !catalog.recommendedKnown }),
        el('button', { textContent: t('Select all'), onclick: () => setAll(true) }), el('button', { textContent: t('None'), onclick: () => setAll(false) }), apply, close));
  } catch (error) { dialog.replaceChildren(el('p', { textContent: t('Venue catalogue unavailable: {message}', { message: error instanceof Error ? error.message : String(error) }) }), close); }
}
