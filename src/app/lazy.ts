import { el } from './dom.ts';
import { t } from './i18n.ts';

/**
 * Parts of the page that are fetched when they are first used (the guide, the screenshot tool). A site that is updated while a page is
 * open no longer has the old files, so the old page asks for a file that is gone and, without this, the button it came from just does
 * nothing. The page is then stale: it reloads itself once to pick up the new version, and if that does not help (the file really is
 * missing) it says so instead of looping.
 */
const KEY = 'hlm-stale-reload', COOLDOWN_MS = 30_000;

/** Whether a stale page may reload itself now: not if it already did a moment ago. */
export const mayReload = (now: number, last: number): boolean => !(now - last < COOLDOWN_MS);

function notify(text: string): void {
  const box = el('div', { class: 'toast', role: 'status', textContent: text });
  document.body.append(box);
  window.setTimeout(() => box.remove(), 8000);
}

/** Run `load`, and treat a failure as a stale page. Resolves to null when it failed (nothing to open). */
export function lazy<T>(load: () => Promise<T>): Promise<T | null> {
  return load().catch((error: unknown) => {
    console.error('A file of this page could not be loaded:', error);
    try {
      const last = Number(window.sessionStorage.getItem(KEY) ?? 0), now = Date.now();
      if (mayReload(now, last)) { window.sessionStorage.setItem(KEY, String(now)); window.location.reload(); return null; }
    } catch { /* storage unavailable: just say so */ }
    notify(t('This page was updated while it was open, or a file could not be loaded. Reload the page to continue.'));
    return null;
  });
}
