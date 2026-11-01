import { el } from '../dom.ts';
import { t } from '../i18n.ts';
import { toast } from '../toast.ts';
import { loadRecord, record, shouldInvite } from './record.ts';

/**
 * The invitation to the tour: a notice under the top bar, shown once to a visitor it has never been shown to. It asks; it never starts anything
 * by itself, and it is not shown again whether the tour is taken or declined (`record.ts`). Declining says where the tour can be found later.
 * It is the page's own notice (`.notice`, the one the bar uses for a venue that is blocked), so it takes no room of its own.
 */
export class TourInvite {
  readonly root = el('div', { class: 'notice info tour-invite', role: 'status', hidden: true });

  /** `start` takes the tour; `where` says in a sentence where the tour is found afterwards (it depends on the controls the screen has). */
  constructor(start: () => void, where: () => string) {
    this.root.append(
      el('span', { class: 'notice-mark mark-info', ariaHidden: 'true' }),
      el('span', { class: 'tour-invite-text', textContent: t('New here? A one-minute tour shows what everything is for.') }),
      el('button', { type: 'button', class: 'tour-invite-go', textContent: t('Take the tour'), onclick: () => { this.root.hidden = true; start(); } }),
      el('button', { type: 'button', class: 'tour-invite-later', textContent: t('Not now'), onclick: () => { this.root.hidden = true; record('dismissed'); toast(where()); } }));
  }

  /** Offer the tour if it was never offered here, and not over something the person has opened. */
  offer(): void {
    if (!shouldInvite(loadRecord()) || document.querySelector('dialog[open]')) return;
    record('seen');
    this.root.hidden = false;
  }
}
