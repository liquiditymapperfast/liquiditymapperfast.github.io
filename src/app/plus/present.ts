/**
 * What Plus adds, said once for the app's presentation sheet (sheet.ts) and the Plus page (page.ts): the hero, the three feature sections
 * (each with a host for its picture), and the strip of what stays free. Page elements only; the two surfaces place and style them.
 */
import { el } from '../dom.ts';
import { language, t } from '../i18n.ts';
import { FREE_DAYS, PADDLE, plusOnSale } from './config.ts';

/** The site's own address: buying, the terms and the other pages a seller owes are there, whoever serves the app (a copy served elsewhere too). */
export const SITE = 'https://liquiditymapper.com/';
/** The Plus page on the site (Paddle's checkout lives there alone), and the pages a seller owes its buyers. */
export const SITE_PLUS = `${SITE}plus/`;
export const SITE_LEGAL = { terms: `${SITE}terms/`, privacy: `${SITE}privacy/`, refunds: `${SITE}refunds/` } as const;
/** The source code. */
export const SOURCE = 'https://github.com/liquiditymapperfast/liquiditymapperfast.github.io';

const money = (usd: number): string => new Intl.NumberFormat(language(), { style: 'currency', currency: 'USD', maximumFractionDigits: Number.isInteger(usd) ? 0 : 2 }).format(usd);
/** What the hero's pill says Plus is today: its monthly price while it is on sale, else that gift keys alone open it. */
export const availability = (): string => plusOnSale() && PADDLE.monthly.usd > 0 ? t('{price} a month', { price: money(PADDLE.monthly.usd) }) : t('Gift keys only today');

/** The hero: what Plus is, in a line and a half. `extra` goes in its row of pills and buttons. */
export function hero(titleId: string, ...extra: HTMLElement[]): HTMLElement {
  return el('header', { class: 'px-hero' },
    el('h1', { id: titleId, textContent: t('More context for Hyperliquid BTC') }),
    el('p', { class: 'px-sub', textContent: t('Full liquidation history, stops, take profits and trader groups.') }),
    el('div', { class: 'px-avail' }, el('span', { class: 'px-pill', textContent: availability() }), ...extra));
}

/** The three feature sections: words, and a host for each one's picture (the demo module's visuals). */
export interface Features { root: HTMLElement[]; hosts: { history: HTMLElement; layers: HTMLElement; groups: HTMLElement }; setFirst(first: number | null): void }
export function features(day: (time: number) => string): Features {
  const host = (): HTMLElement => el('div', { class: 'px-vis' });
  const hosts = { history: host(), layers: host(), groups: host() };
  const since = el('p', {});
  const setFirst = (first: number | null): void => {
    since.textContent = first !== null ? t('Every snapshot since {date}, about every half hour. Without Plus, the last {n} days.', { date: day(first), n: FREE_DAYS })
      : t('Every snapshot since recording began, about every half hour. Without Plus, the last {n} days.', { n: FREE_DAYS });
  };
  setFirst(null);
  const section = (id: string, title: string, words: HTMLElement[], vis: HTMLElement): HTMLElement => {
    const s = el('section', { class: 'px-feat' }, el('div', { class: 'px-feat-text' }, el('h2', { id, textContent: title }), ...words), vis);
    s.setAttribute('aria-labelledby', id);
    return s;
  };
  return {
    hosts, setFirst,
    root: [
      section('px-f-history', t('The whole history'), [since], hosts.history),
      section('px-f-layers', t('Stops and take profits'), [el('p', { textContent: t('Two more layers, each with its own switch. Take profits stay out of the curve.') })], hosts.layers),
      section('px-f-groups', t('Trader groups'), [el('p', { textContent: t('Choose whose positions the levels count: all traders, or only the +PnL traders.') }),
        el('p', { textContent: t('+PnL traders: the wallets in HyperTracker\'s four cohorts with a positive all-time perp profit.') })], hosts.groups),
    ],
  };
}

/** What stays free, and why Plus exists: the map and the tools, everyone's live liquidations and the free days; open source; no account; cancel anytime. */
export function trust(): HTMLElement {
  const id = 'px-trust-title';
  const s = el('section', { class: 'px-trust' },
    el('h2', { class: 'vh', id, textContent: t('What stays the same') }),
    el('p', { class: 'px-trust-lead' }, el('span', { class: 'px-check', ariaHidden: 'true' }), el('span', { textContent: t('The map, the tools, everyone\'s live liquidations and the last {n} days stay free.', { n: FREE_DAYS }) })),
    el('ul', { class: 'px-trust-list' },
      el('li', {}, el('a', { href: SOURCE, target: '_blank', rel: 'noopener', textContent: t('Open source') })),
      el('li', { textContent: t('No account') }),
      el('li', { textContent: t('Cancel anytime') })),
    el('p', { class: 'px-trust-fine', textContent: t('Plus pays for the servers that record and serve this history.') }));
  s.setAttribute('aria-labelledby', id);
  return s;
}

/** The site's terms, privacy and refunds pages, in a tab of their own. */
export function legal(): HTMLElement {
  const link = (href: string, text: string): HTMLAnchorElement => el('a', { href, target: '_blank', rel: 'noopener', textContent: text });
  return el('p', { class: 'px-legal' }, link(SITE_LEGAL.terms, t('Terms')), ' · ', link(SITE_LEGAL.privacy, t('Privacy')), ' · ', link(SITE_LEGAL.refunds, t('Refunds')));
}
