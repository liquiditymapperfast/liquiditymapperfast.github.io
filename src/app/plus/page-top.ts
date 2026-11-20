/**
 * The Plus page's buy row in the hero (Karl, 2026-11-20: "I want that people only have to click once to purchase the $10 plan ... make the row
 * a bit more thinner") and the order the page is drawn in, apart from the page itself (`page.ts`, which loads styles and draws on load) so the
 * tests can draw them on a fake document: whether this browser is offered a purchase (`buyingFor`), the row for it (`drawTopRow`), and the
 * page drawn row first, then the rest, both for the one decision (`drawPageParts`), every time the page is drawn.
 */
import { el } from '../dom.ts';
import { language, t } from '../i18n.ts';
import { PADDLE, type PlusPrice } from './config.ts';
import { cannotBuy, cannotHere, topRow } from './page-flow.ts';
import type { Paid } from './paid.ts';
import type { PlusMode, PlusState } from './pass.ts';

/**
 * Whether this browser is offered a purchase: no membership here, or one the server ended. A key replaced by newer ones belongs to a
 * subscription that may well be paid: the receipt brings Plus back, not a second purchase.
 */
export const buyingFor = (stands: PlusState, why: string): boolean => stands === 'none' || (stands === 'ended' && why !== 'replaced');

/** A price in dollars, in the visitor's language. */
export const money = (usd: number): string => new Intl.NumberFormat(language(), { style: 'currency', currency: 'USD', maximumFractionDigits: Number.isInteger(usd) ? 0 : 2 }).format(usd);
/** What a payment still waiting here says beside its button. */
export const waitingNote = (): string => t('A payment made in this browser is still being set up. The prices come back once it is, so it is not paid twice.');
/**
 * A waiting payment's button: "Set up Plus", or "Try again" after this tab's own attempt for it ended without Plus (`tried`). `id`: the
 * hero's `plus-paid-again`, the end row's `plus-paid-again-end`.
 */
export function waitingButton(pending: Paid, s: { busy: boolean; opening: boolean; tried: boolean }, press: (id: string) => void, id = 'plus-paid-again'): HTMLButtonElement {
  return el('button', { type: 'button', id, disabled: s.busy || s.opening, textContent: s.tried ? t('Try again') : t('Set up Plus'), onclick: () => { press(pending.id); } });
}

/**
 * Where a buy row is drawn: the row and its small print; for the hero also its availability pill, its "Plus is on" pill and "Activate a
 * key"; for the row at the end of the page its section (`box`), hidden while the row holds nothing.
 */
export interface TopParts { pricePill?: HTMLElement | null; onPill?: HTMLElement; cta?: HTMLElement; top: HTMLElement; topFine: HTMLElement; box?: HTMLElement }
/** How a row is drawn: its ids' ending (unique on the page), whether it says how buying works without an account, and what the page said. */
export interface RowOptions { suffix: string; howTo: boolean; said: boolean }
/** What the row is drawn from: the sale, the membership, the payments, and what the page said about a checkout (`said`). */
export interface TopState {
  onSale: boolean; stands: PlusState; buying: boolean; mode: PlusMode; paidReady: boolean; pending: Paid | undefined;
  busy: boolean; tried: (id: string) => boolean; said: HTMLElement[];
}
/** What its buttons do: open the checkout for a price, or ask for a waiting payment's key. */
export interface TopActions { buy(price: PlusPrice): void; press(id: string): void }

/**
 * The hero's line (`topRow`): on sale, one thin row that buys with one click: the price button (`plus-monthly`, the checkout at once), a
 * waiting payment's note and button, or why nothing is sold here; and the small print under it (what the page said about a checkout, and one
 * line next to the price: it renews monthly until ended, before tax, Paddle.com the Merchant of Record). Only a tab whose database is open,
 * and whose payments were read once, sells (spec 2.1, 4; Sol, code review C2-1). Not on sale: the pill and "Activate a key", as before.
 */
export function drawTopRow(p: TopParts, s: TopState, act: TopActions, o: RowOptions = { suffix: '', howTo: true, said: true }): void {
  const row = topRow({ onSale: s.onSale, stands: s.stands, buying: s.buying, mode: s.mode, paidReady: s.paidReady, waiting: s.pending !== undefined });
  if (p.pricePill) p.pricePill.hidden = !row.pill;
  if (p.onPill) p.onPill.hidden = !row.on;
  if (p.cta) { p.cta.hidden = !row.activate; p.cta.textContent = t('Activate a key'); }
  const parts: HTMLElement[] = [], fine: HTMLElement[] = s.buying && s.onSale && o.said ? [...s.said] : [];
  p.top.classList.toggle('waiting', row.buy === 'waiting');
  p.top.classList.toggle('price', row.buy === 'price');
  if (row.buy === 'price') {
    const price = (plan: PlusPrice, per: string, main: boolean, id: string): HTMLButtonElement => el('button', { type: 'button', id, class: main ? 'px-buy' : 'px-buy plain', disabled: s.busy, onclick: () => { act.buy(plan); } },
      ...(main ? [el('b', { textContent: s.stands === 'ended' ? t('Renew Plus') : t('Get Plus') })] : []), el('span', { textContent: per }));
    parts.push(price(PADDLE.monthly, t('{price} a month', { price: money(PADDLE.monthly.usd) }), true, `plus-monthly${o.suffix}`));
    if (PADDLE.yearly.id) parts.push(price(PADDLE.yearly, t('{price} a year', { price: money(PADDLE.yearly.usd) }), false, `plus-yearly${o.suffix}`));
    // How it works without an account (Karl, 2026-11-20): beside the button where the line has room, under it on a phone.
    if (o.howTo) parts.push(el('span', { class: 'px-top-howto', textContent: t('No account: paying turns Plus on in this browser and gives you a key for your other devices.') }));
    // One line of small print (Karl, 2026-11-20): that it renews monthly until ended (the renewal is said), before tax, and Paddle.com named
    // as the Merchant of Record, which Paddle's review looks for next to the price.
    fine.push(el('p', { class: 'px-top-line', textContent: t('Renews monthly until you end it · before tax · sold by Paddle.com, Merchant of Record') }));
  } else if (row.buy === 'waiting' && s.pending) {
    parts.push(waitingButton(s.pending, { busy: s.busy, opening: s.mode === 'opening', tried: s.tried(s.pending.id) }, act.press, `plus-paid-again${o.suffix}`), el('span', { class: 'px-top-note', textContent: waitingNote() }));
  } else if (row.buy === 'cannot-buy' || row.buy === 'cannot-here') {
    parts.push(el('span', { class: 'px-top-said', role: 'status', textContent: row.buy === 'cannot-buy' ? cannotBuy() : cannotHere() }));
  }
  p.top.replaceChildren(...parts); p.top.hidden = parts.length === 0;
  p.topFine.replaceChildren(...fine); p.topFine.hidden = fine.length === 0;
  if (p.box) p.box.hidden = parts.length === 0;
}

/**
 * Both buy rows, from the one state: the hero's, and the same row once more at the end of the page, just before "Already have Plus?" (Karl,
 * 2026-11-20: a reader who reached the end does not scroll back up). The end row has its own ids, says what the page said only in the hero,
 * and leaves out the sentence on accounts (it stays as thin as the hero's). Nothing moves or appears on scroll.
 */
export function drawBuyRows(hero: TopParts, end: TopParts, s: TopState, act: TopActions): void {
  drawTopRow(hero, s, act, { suffix: '', howTo: true, said: true });
  drawTopRow(end, s, act, { suffix: '-end', howTo: false, said: false });
}

/**
 * The page drawn in its order, every time it is drawn: whether a purchase is offered decided once (`buyingFor`), then the hero's row, then the
 * rest of the page, both for that decision. Whether a purchase was offered.
 */
export function drawPageParts(member: { readonly state: PlusState; readonly why: string }, draw: { top(buying: boolean): void; rest(buying: boolean): void }): boolean {
  const buying = buyingFor(member.state, member.why);
  draw.top(buying);
  draw.rest(buying);
  return buying;
}
