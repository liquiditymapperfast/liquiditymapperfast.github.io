import { el } from './dom.ts';
import { t } from './i18n.ts';
import { mayOffer, type BuildAnswer } from './update-check.ts';

/**
 * Says that the site serves a newer build than this tab runs (update-check.ts), with a Reload button: on a computer in the status bar, where
 * it covers nothing (the notices under the top bar lie over the map's own buttons), and on a phone under the top bar with the page's other
 * notices, over the map's Draw button and the legend's first row until it is answered, as they are (a phone's bar keeps its height when a
 * notice comes or goes, mobile.css; toolbar.ts places it). Only its button reloads; the page never does by itself. Its ✕ puts it away for a
 * day (`mayOffer`). It is left out of screenshots (`data-no-capture`): a picture someone shares should not carry it.
 */
export class UpdateNotice {
  readonly root = el('div', { class: 'notice info update-notice', role: 'status', hidden: true,
    tip: t('The site was updated after this tab was opened. A tab keeps the version it started with until it is reloaded, and it never reloads by itself.') });
  #dismissedAt = 0;

  constructor(private now: () => number = Date.now, reload: () => void = () => { location.reload(); }) {
    this.root.setAttribute('data-no-capture', '');
    this.root.append(
      el('span', { class: 'notice-mark mark-info', ariaHidden: 'true' }),
      el('span', { class: 'update-text', textContent: t('A newer version of this page is out.') }),
      el('button', { type: 'button', class: 'update-reload', textContent: t('Reload'), tip: t('Load the newer version now. Your settings are kept; the live trades start empty again.'), onclick: () => reload() }),
      el('button', { type: 'button', class: 'notice-close', tip: t('Not now'), ariaLabel: t('Not now'), onclick: () => { this.#dismissedAt = this.now(); this.root.hidden = true; } }));
  }

  /** What the site's last answer means: show the notice (unless it was put away less than a day ago), take it back, or leave it as it is. */
  answer(meaning: BuildAnswer): void {
    if (meaning === 'offer' && mayOffer(this.#dismissedAt, this.now())) this.root.hidden = false;
    else if (meaning === 'withdraw') this.root.hidden = true;
  }
}
