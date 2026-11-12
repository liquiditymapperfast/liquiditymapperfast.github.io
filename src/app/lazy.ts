import { el } from './dom.ts';
import { t } from './i18n.ts';

/**
 * Parts of the page that are fetched when they are first used (the guide, the screenshot tool, the coin picker). A site that is updated
 * while a page is open no longer has the old files, so the old page asks for a file that is gone.
 *
 * Only the page's own start reloads itself for that (`reload`: nothing is held yet; once, and if that does not help it says so instead of
 * looping). A page that is running never does: a reload throws away what the tab holds only in memory, and a tab open before a deploy lost
 * its whole chart to a Shift+S that asked for the screenshot tool (2026-10-12). It says the page was updated, and the person reloads when
 * they choose. The screenshot tool is fetched soon after the page starts (`preload`), so a deploy cannot take it away.
 */
const KEY = 'hlm-stale-reload', COOLDOWN_MS = 30_000;

/**
 * What a part that could not be fetched sends on the document: the site may have been deployed since the tab opened, so the page asks at
 * once which build it serves (update-check.ts), and the notice with its Reload comes with the words below.
 */
export const STALE_EVENT = 'hlm-stale';

/** Whether a stale page may reload itself now: not if it already did a moment ago. */
export const mayReload = (now: number, last: number): boolean => !(now - last < COOLDOWN_MS);

/** What a part that could not be fetched leads to: the page's start reloads (once in a while), anything later only says so. */
export const onStale = (reload: boolean, now: number, last: number): 'reload' | 'say' => reload && mayReload(now, last) ? 'reload' : 'say';

function notify(text: string): void {
  const box = el('div', { class: 'toast', role: 'status', textContent: text });
  document.body.append(box);
  window.setTimeout(() => box.remove(), 8000);
}

/** Run `load`, and treat a failure as a stale page (see above). Resolves to null when it failed (nothing to open). */
export function lazy<T>(load: () => Promise<T>, { reload = false }: { reload?: boolean } = {}): Promise<T | null> {
  return load().catch((error: unknown) => {
    console.error('A file of this page could not be loaded:', error);
    try {
      const last = Number(window.sessionStorage.getItem(KEY) ?? 0), now = Date.now();
      if (onStale(reload, now, last) === 'reload') { window.sessionStorage.setItem(KEY, String(now)); window.location.reload(); return null; }
    } catch { /* storage unavailable: just say so */ }
    document.dispatchEvent(new Event(STALE_EVENT));
    notify(t('This page was updated while it was open, or a file could not be loaded. Reload the page to continue.'));
    return null;
  });
}

/** Fetch a part now, quietly, so it is held by the page before a later deploy could take it away (a failure is said when it is used). */
export function preload(load: () => Promise<unknown>): void { void load().catch(() => {}); }
