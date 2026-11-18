import { el } from '../dom.ts';
import { togglePanel, type Panel } from '../ui.ts';
import { anchorDate } from '../format.ts';
import { showGuide } from '../help.ts';
import { t } from '../i18n.ts';
import { FREE_DAYS, PLUS_PAGE, plusOnSale } from './config.ts';
import { PLUS_NAME } from './name.ts';
import { plus } from './pass.ts';

export { PLUS_NAME };

/** The Plus page beside the app, wherever the app is served from. */
export const plusPageUrl = (): string => new URL(PLUS_PAGE, location.href.replace(/[?#].*$/, '')).href;

function tile(label: string, detail: string, go: { href: string } | { run: () => void }): HTMLElement {
  if ('href' in go) return el('a', { class: 'author-link', href: go.href, target: '_blank', rel: 'noopener' }, el('b', { textContent: label }), el('span', { textContent: detail }));
  return el('button', { type: 'button', class: 'author-link plus-tile', onclick: go.run }, el('b', { textContent: label }), el('span', { textContent: detail }));
}

/**
 * The Plus panel, opened by the Plus button and by a lock on the page: what Plus is in three sentences, whether this browser has it, and
 * the two ways on: the Guide's section (what it adds, with pictures) and the Plus page (the checkout, the key, another device). The app has
 * no checkout of its own: no form and no other site's script is ever loaded here.
 */
export function togglePlus(anchor: HTMLElement): Panel | null {
  return togglePanel(anchor, { title: PLUS_NAME, width: 340, align: 'right' }, (_tools, body) => {
    const member = plus(), stands = member.state, on = stands === 'on', until = member.until;
    body.classList.add('author-body', 'plus-body');
    const guide = tile(t('What Plus adds'), t('in the Guide, with pictures'), { run: () => { showGuide('plus'); } });
    if (on) {
      body.append(
        el('p', { class: 'lead', textContent: t('Plus is on in this browser.') }),
        el('p', { class: 'fine', textContent: until && member.renews === true ? t('Paid until {date}. It renews by itself; you can end it on the Plus page at any time.', { date: anchorDate(until) })
          : until ? t('Plus runs until {date}.', { date: anchorDate(until) }) : t('You can end it on the Plus page at any time.') }),
        el('div', { class: 'author-links' }, guide, tile(t('Manage Plus'), t('your key, another device, ending it'), { href: plusPageUrl() })),
      );
      return;
    }
    // A pass that ran out, or a server not reached, is being checked: the key may be good, so nothing is sold here meanwhile.
    if (stands === 'checking') {
      body.append(
        el('p', { class: 'lead', textContent: t('Checking Plus with the server…') }),
        el('p', { class: 'fine', textContent: t('This browser holds a key that the server has not confirmed yet. If this stays, check your connection.') }),
        el('div', { class: 'author-links' }, guide, tile(t('Manage Plus'), t('your key, another device, ending it'), { href: plusPageUrl() })),
      );
      return;
    }
    body.append(
      el('p', { class: 'lead', textContent: stands === 'ended' ? t('Plus has ended in this browser.') : t('Plus opens what this site\'s servers store: the liquidation levels\' whole history (without Plus, the last {n} days), the levels of HyperTracker\'s profitable traders, and the stop and take-profit levels.', { n: FREE_DAYS }) }),
      el('p', { class: 'fine', textContent: t('Everything the page does today stays free. Plus pays for the servers behind it.') }),
      el('p', { class: 'fine', textContent: t('There is no account: after the checkout this browser holds a key, which you can take to another device.') }),
      el('div', { class: 'author-links' }, guide,
        plusOnSale() ? tile(stands === 'ended' ? t('Renew Plus') : t('Get Plus'), t('opens the Plus page'), { href: plusPageUrl() })
          : tile(t('Not on sale yet'), t('the Plus page says when'), { href: plusPageUrl() })),
    );
  });
}
