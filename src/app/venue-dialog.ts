import { el } from './dom.ts';
import type { VenueControl, VenueEntry } from './source.ts';

interface Row { entry: VenueEntry; status: string; label: HTMLElement; box: HTMLInputElement }

/**
 * Venue picker. The dialog is built once and only its text is updated afterwards, so it stays open while the status of each
 * venue refreshes; it closes only on Close or Escape. What running a selection means is the data source's business.
 */
export async function openVenueDialog(venues: VenueControl, selectionProduct: () => string): Promise<void> {
  const dialog = el('dialog', { class: 'venues' });
  dialog.append(el('h3', { textContent: 'Order book venues' }), el('p', { class: 'muted', textContent: 'Loading…' }));
  document.body.append(dialog); dialog.showModal();
  let timer = 0;
  dialog.addEventListener('close', () => { window.clearInterval(timer); dialog.remove(); });
  const close = el('button', { textContent: 'Close', onclick: () => dialog.close() });
  try {
    const catalog = await venues.catalog();
    const rows: Row[] = [];
    const list = el('div', { class: 'venue-list' });
    const note = el('p', { class: 'muted' });
    for (const entry of catalog.venues) {
      const box = el('input', { type: 'checkbox', checked: entry.selected, disabled: !entry.supported });
      const label = el('span', { class: 'muted', textContent: entry.status });
      box.onchange = () => count();
      rows.push({ entry, status: entry.status, label, box });
      list.append(el('label', {}, box, entry.name, label));
    }
    const count = () => { note.textContent = `${rows.filter(r => r.box.checked).length} of ${rows.filter(r => r.entry.supported).length} selected${catalog.limit === null ? '' : ` (up to ${catalog.limit} feed venues)`}.`; };
    count();
    const setAll = (checked: boolean) => { for (const row of rows) if (row.entry.supported) row.box.checked = checked; count(); };
    /** The largest venues with deep, fresh books (the first-run set); nothing is applied until Apply. */
    const recommend = () => { for (const row of rows) if (row.entry.supported) row.box.checked = row.entry.recommended; count(); };

    const apply = el('button', { textContent: 'Apply' });
    apply.onclick = async () => {
      apply.disabled = true; note.textContent = 'Applying… venues connect in the background; status updates below.';
      try {
        await venues.apply(rows.filter(r => r.box.checked).map(r => r.entry.id), selectionProduct());
        count(); note.textContent += ' Applied.';
      } catch (error) { note.textContent = error instanceof Error ? error.message : String(error); }
      apply.disabled = false;
    };

    const refresh = async () => {
      try {
        const status = new Map((await venues.catalog()).venues.map(v => [v.id, v.status] as const));
        for (const row of rows) { const text = status.get(row.entry.id) ?? row.status; if (row.label.textContent !== text) row.label.textContent = text; }
      } catch { /* the next tick retries */ }
    };
    timer = window.setInterval(() => void refresh(), 2000);
    dialog.replaceChildren(el('h3', { textContent: 'Order book venues' }), list, note,
      el('div', { class: 'row' }, el('button', { textContent: 'Recommended', title: catalog.recommendedKnown ? 'The largest venues with deep, fresh order books (the first-run set)' : 'Needs a server restarted on this version', onclick: recommend, disabled: !catalog.recommendedKnown }),
        el('button', { textContent: 'Select all', onclick: () => setAll(true) }), el('button', { textContent: 'None', onclick: () => setAll(false) }), apply, close));
  } catch (error) { dialog.replaceChildren(el('p', { textContent: `Venue catalogue unavailable: ${error instanceof Error ? error.message : String(error)}` }), close); }
}
