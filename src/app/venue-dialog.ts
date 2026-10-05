import { el } from './dom.ts';

/** One selectable venue: the feed manager's catalogue (`/api/orderbooks/*`) or a self-contained connector (`/api/v2/venues`). */
interface Row { id: string; name: string; source: 'feed' | 'extra'; supported: boolean; recommended: boolean; status: string; label: HTMLElement; box: HTMLInputElement }
interface FeedCatalog { maxSelected: number; selectedVenues: string[]; venues: { id: string; name: string; supported: boolean; default?: boolean; status: string }[] }
interface ExtraVenueInfo { id: string; name: string; enabled: boolean; default?: boolean; state: string; lastError: string | null; reconnects: number }
interface ExtraCatalog { venues: ExtraVenueInfo[] }

function extraStatus(v: ExtraVenueInfo): string {
  if (!v.enabled) return 'off';
  if (v.state !== 'live') return v.lastError ? `${v.state}: ${v.lastError}` : v.state;
  return v.reconnects > 0 ? `live, ${v.reconnects} reconnects` : 'live';
}

const json = async <T>(url: string, init?: RequestInit): Promise<T> => {
  const response = await fetch(url, { cache: 'no-store', ...init });
  const body = await response.json().catch(() => ({})) as T & { error?: string };
  if (!response.ok) throw new Error(body.error ?? `${url} failed (${response.status})`);
  return body;
};

/**
 * Venue picker. The dialog is built once and only its text is updated afterwards, so it stays open while the status of each
 * venue refreshes; it closes only on Close or Escape. Both backends are applied together.
 */
export async function openVenueDialog(selectionProduct: () => string): Promise<void> {
  const dialog = el('dialog', { class: 'venues' });
  dialog.append(el('h3', { textContent: 'Order book venues' }), el('p', { class: 'muted', textContent: 'Loading…' }));
  document.body.append(dialog); dialog.showModal();
  let timer = 0;
  dialog.addEventListener('close', () => { window.clearInterval(timer); dialog.remove(); });
  const close = el('button', { textContent: 'Close', onclick: () => dialog.close() });
  try {
    const [feed, extra] = await Promise.all([json<FeedCatalog>('/api/orderbooks/venues'), json<ExtraCatalog>('/api/v2/venues')]);
    const selected = new Set(feed.selectedVenues);
    const rows: Row[] = [];
    const list = el('div', { class: 'venue-list' });
    const note = el('p', { class: 'muted' });
    const add = (id: string, name: string, source: Row['source'], supported: boolean, recommended: boolean, checked: boolean, status: string) => {
      const box = el('input', { type: 'checkbox', checked, disabled: !supported });
      const label = el('span', { class: 'muted', textContent: status });
      const row: Row = { id, name, source, supported, recommended, status, label, box };
      box.onchange = () => count();
      rows.push(row);
      list.append(el('label', {}, box, name, label));
    };
    for (const venue of feed.venues) add(venue.id, venue.name, 'feed', venue.supported, venue.default === true, selected.has(venue.id), venue.status);
    for (const venue of extra.venues) add(venue.id, venue.name, 'extra', true, venue.default === true, venue.enabled, venue.state);
    const count = () => { note.textContent = `${rows.filter(r => r.box.checked).length} of ${rows.filter(r => r.supported).length} selected (up to ${feed.maxSelected} feed venues).`; };
    count();
    const setAll = (checked: boolean) => { for (const row of rows) if (row.supported) row.box.checked = checked; count(); };
    const serverKnowsRecommended = extra.venues.some(venue => typeof venue.default === 'boolean');
    /** The largest venues with deep, fresh books (the first-run set); nothing is applied until Apply. */
    const recommend = () => { for (const row of rows) if (row.supported) row.box.checked = row.recommended; count(); };

    const apply = el('button', { textContent: 'Apply' });
    apply.onclick = async () => {
      apply.disabled = true; note.textContent = 'Applying… venues connect in the background; status updates below.';
      try {
        const chosen = (source: Row['source']) => rows.filter(r => r.source === source && r.box.checked).map(r => r.id);
        await json('/api/v2/venues', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ enabled: chosen('extra') }) });
        // Changing the feed selection restarts every feed (about 13 s), so an unchanged set is not re-posted.
        const feedNow = chosen('feed');
        if (feedNow.length !== selected.size || feedNow.some(id => !selected.has(id))) {
          await json('/api/orderbooks/selection', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ instrumentId: selectionProduct(), venues: feedNow }) });
          selected.clear(); for (const id of feedNow) selected.add(id);
        }
        count(); note.textContent += ' Applied.';
      } catch (error) { note.textContent = error instanceof Error ? error.message : String(error); }
      apply.disabled = false;
    };

    const refresh = async () => {
      try {
        const [f, e] = await Promise.all([json<FeedCatalog>('/api/orderbooks/venues'), json<ExtraCatalog>('/api/v2/venues')]);
        const status = new Map<string, string>([...f.venues.map(v => [v.id, v.status] as const), ...e.venues.map(v => [v.id, extraStatus(v)] as const)]);
        for (const row of rows) { const text = status.get(row.id) ?? row.status; if (row.label.textContent !== text) row.label.textContent = text; }
      } catch { /* the next tick retries */ }
    };
    timer = window.setInterval(() => void refresh(), 2000);
    dialog.replaceChildren(el('h3', { textContent: 'Order book venues' }), list, note,
      // An older server marks only the four venues it used to start (and no connector venue) as default, which is not the recommended set:
      // the new server always says it for the connector venues too, so that is what the button waits for.
      el('div', { class: 'row' }, el('button', { textContent: 'Recommended', title: serverKnowsRecommended ? 'The largest venues with deep, fresh order books (the first-run set)' : 'Needs a server restarted on this version', onclick: recommend, disabled: !serverKnowsRecommended }),
        el('button', { textContent: 'Select all', onclick: () => setAll(true) }), el('button', { textContent: 'None', onclick: () => setAll(false) }), apply, close));
  } catch (error) { dialog.replaceChildren(el('p', { textContent: `Venue catalogue unavailable: ${error instanceof Error ? error.message : String(error)}` }), close); }
}
