import { el } from './dom.ts';

/**
 * "Install": offers to install the page as an app (its own window, an icon on the desktop or dock) when the browser says it can.
 * Chrome and Edge announce that with `beforeinstallprompt`, an event that can fire before the page has finished starting, so the
 * listener is registered when this module loads and the button picks the event up whenever it is built. Browsers that never fire it
 * (Safari, Firefox) get no button; the guide says how to install from their menus. Nothing here needs a service worker: the page is
 * installable as it is, and a worker that cached the build could serve a stale one.
 */
interface InstallEvent extends Event { prompt?: () => Promise<void>; userChoice?: Promise<{ outcome: 'accepted' | 'dismissed' }> }

let pending: InstallEvent | null = null;
const listeners = new Set<() => void>();
const standalone = (): boolean => typeof matchMedia === 'function' && (matchMedia('(display-mode: standalone)').matches || matchMedia('(display-mode: window-controls-overlay)').matches);

if (typeof window !== 'undefined') {
  window.addEventListener('beforeinstallprompt', event => { event.preventDefault(); pending = event as InstallEvent; for (const listener of listeners) listener(); });
  window.addEventListener('appinstalled', () => { pending = null; for (const listener of listeners) listener(); });
}

export class InstallButton {
  readonly root = el('button', {
    type: 'button', class: 'install', textContent: 'Install', hidden: true,
    tip: 'Install this page as an app: it opens in its own window, starts from your desktop or dock, and keeps the depth it has recorded. Free, nothing to sign up for.',
    onclick: () => { void this.#install(); },
  });

  constructor() {
    const sync = (): void => { this.root.hidden = pending === null || standalone(); };
    listeners.add(sync); sync();
  }

  async #install(): Promise<void> {
    const event = pending; if (!event?.prompt) return;
    pending = null; this.root.hidden = true; // the browser allows one prompt per event
    try { await event.prompt(); await event.userChoice; } catch { /* dismissed or blocked: the browser offers the event again later */ }
  }
}
