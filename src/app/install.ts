import { el } from './dom.ts';
import { togglePanel } from './ui.ts';
import { t } from './i18n.ts';

/**
 * "Install": offers to install the page as an app (its own window, an icon on the desktop or dock) when the browser says it can.
 * Chrome and Edge announce that with `beforeinstallprompt`, an event that can fire before the page has finished starting, so the
 * listener is registered when this module loads and the button picks the event up whenever it is built. Browsers that never fire it
 * (Safari, Firefox) get no button; the guide says how to install from their menus. An iPhone or iPad has no prompt at all, so there the
 * button opens a short explanation of Share, then Add to Home Screen. Nothing here needs a service worker: the page is
 * installable as it is, and a worker that cached the build could serve a stale one.
 */
interface InstallEvent extends Event { prompt?: () => Promise<void>; userChoice?: Promise<{ outcome: 'accepted' | 'dismissed' }> }

let pending: InstallEvent | null = null;
const listeners = new Set<() => void>();
const standalone = (): boolean => typeof matchMedia === 'function' && (matchMedia('(display-mode: standalone)').matches || matchMedia('(display-mode: window-controls-overlay)').matches);

/** iOS and iPadOS, in any browser on them: all of them install a page through the Share menu, and none offers a prompt. */
const onIos = (): boolean => typeof navigator !== 'undefined' && (/iP(hone|ad|od)/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1));
const manualInstall = (): boolean => onIos() && !standalone() && !(navigator as Navigator & { standalone?: boolean }).standalone;

if (typeof window !== 'undefined') {
  window.addEventListener('beforeinstallprompt', event => { event.preventDefault(); pending = event as InstallEvent; for (const listener of listeners) listener(); });
  window.addEventListener('appinstalled', () => { pending = null; for (const listener of listeners) listener(); });
}

export class InstallButton {
  readonly root = el('button', {
    type: 'button', class: 'install', textContent: t('Install'), hidden: true,
    tip: t('Install this page as an app: it opens in its own window, starts from your desktop or dock, and keeps the depth it has recorded. Free, nothing to sign up for.'),
    onclick: () => { void this.#install(); },
  });

  constructor() {
    const sync = (): void => { this.root.hidden = (pending === null && !manualInstall()) || standalone(); };
    listeners.add(sync); sync();
  }

  async #install(): Promise<void> {
    const event = pending;
    if (!event?.prompt) {
      if (manualInstall()) togglePanel(this.root, { title: t('Add to Home Screen'), width: 340, align: 'right' }, (_tools, body) => {
        body.append(
          el('p', { class: 'lead', textContent: t('On an iPhone or iPad the page is installed from the Share menu:') }),
          el('ol', { class: 'steps' },
            el('li', { textContent: t('Tap the Share button (the square with an arrow pointing up) in the browser\'s bar.') }),
            el('li', { textContent: t('Scroll the list and choose Add to Home Screen.') }),
            el('li', { textContent: t('Tap Add. It then opens full screen from its own icon, like an app.') })),
          el('p', { class: 'panel-note', textContent: t('Nothing is downloaded or signed up for: it is the same page.') }));
      });
      return;
    }
    pending = null; this.root.hidden = true; // the browser allows one prompt per event
    try { await event.prompt(); await event.userChoice; } catch { /* dismissed or blocked: the browser offers the event again later */ }
  }
}
