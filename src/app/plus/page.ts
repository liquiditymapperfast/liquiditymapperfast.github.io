/// <reference types="vite/client" />
/**
 * The Plus page (`plus/`): what Plus is, its price, the checkout, and the key that carries a membership to another device. It is the one
 * page of the site with a form and with another site's script: Paddle's checkout (Paddle is the seller of record), fetched only when a
 * visitor presses a price. After the checkout the page hands the transaction to the site's own server (`config.ts` `plusApi`), which
 * answers with the key and a pass; both go into the storage the app shares (`pass.ts`), so an open tab of the app is unlocked at once.
 */
import './page.css';
import { el } from '../dom.ts';
import { language, t } from '../i18n.ts';
import { historyUrls, readIndex } from '../liq-history.ts';
import { LIQ_LEVELS_URL } from '../liq-url.ts';
import { applyTheme } from '../theme.ts';
import { FREE_DAYS, LEGAL, PADDLE, PLUS_CONTACT, PLUS_DEVICES, plusApi, plusOnSale, type PlusPrice } from './config.ts';
import { PLUS_NAME } from './name.ts';
import { plus, readGrant } from './pass.ts';

/** The part of Paddle's script this page uses (Paddle.js v2). */
interface PaddleEvent { name?: string; data?: { transaction_id?: string } }
interface PaddleApi {
  Environment: { set(environment: 'sandbox' | 'production'): void };
  Initialize(options: { token: string; eventCallback?: (event: PaddleEvent) => void }): void;
  Checkout: { open(options: { items: { priceId: string; quantity: number }[]; settings?: { displayMode?: 'overlay'; theme?: 'light' | 'dark'; locale?: string } }): void; close(): void };
}
declare global { interface Window { Paddle?: PaddleApi } }

const PADDLE_SCRIPT = 'https://cdn.paddle.com/paddle/v2/paddle.js';
/** After a checkout the subscription can take a few seconds to exist on Paddle's side: the pass is asked for this often, this long. */
const PASS_RETRY_MS = 2_500, PASS_WAIT_MS = 90_000;

const root = document.getElementById('plus')!;
const member = plus();
const day = (time: number): string => new Intl.DateTimeFormat(language(), { dateStyle: 'long', timeZone: 'UTC' }).format(time);
const money = (usd: number): string => new Intl.NumberFormat(language(), { style: 'currency', currency: 'USD', maximumFractionDigits: Number.isInteger(usd) ? 0 : 2 }).format(usd);

/** The app's theme, as this browser chose it there. */
function wearTheme(): boolean {
  let name = 'light';
  try { const saved = JSON.parse(localStorage.getItem('hlm-app-v2') ?? 'null') as { theme?: unknown } | null; if (saved && typeof saved.theme === 'string') name = saved.theme; } catch { /* the light theme */ }
  return applyTheme(name).dark;
}
const dark = wearTheme();

/** What the page shows beside what the membership says: a message under the price or a form, and whether something is under way. */
const state: { busy: '' | 'checkout' | 'pass' | 'key' | 'restore'; said: { where: 'buy' | 'key' | 'restore'; text: string; good?: boolean } | null; shown: boolean; first: number | null; fresh: boolean;
  /** What is typed in the forms, kept across the page being drawn again (an answer, another tab). */ typed: { key: string; email: string; invoice: string } } =
  { busy: '', said: null, shown: false, first: null, fresh: false, typed: { key: '', email: '', invoice: '' } };

async function post(path: string, body: unknown): Promise<{ status: number; body: unknown } | null> {
  try {
    const answer = await fetch(`${plusApi()}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), cache: 'no-store' });
    let parsed: unknown = null;
    try { parsed = await answer.json(); } catch { /* the status says enough */ }
    return { status: answer.status, body: parsed };
  } catch { return null; }
}

let paddle: Promise<PaddleApi | null> | null = null;
/** Paddle's script, fetched once, when a price is first pressed. */
function loadPaddle(): Promise<PaddleApi | null> {
  paddle ??= new Promise(resolve => {
    const script = el('script', { src: PADDLE_SCRIPT, async: true });
    script.onload = () => {
      const api = window.Paddle;
      if (!api) { resolve(null); return; }
      if (PADDLE.environment === 'sandbox') api.Environment.set('sandbox');
      api.Initialize({ token: PADDLE.token, eventCallback: event => { if (event.name === 'checkout.completed' && event.data?.transaction_id) void completed(event.data.transaction_id); } });
      resolve(api);
    };
    script.onerror = () => { paddle = null; resolve(null); };
    document.head.append(script);
  });
  return paddle;
}

async function buy(price: PlusPrice): Promise<void> {
  if (state.busy) return;
  state.busy = 'checkout'; state.said = null; render();
  const api = await loadPaddle();
  state.busy = '';
  if (!api) { state.said = { where: 'buy', text: t('The checkout could not be loaded. Check your connection, or a blocker that stops paddle.com, and try again.') }; render(); return; }
  const code = language();
  api.Checkout.open({ items: [{ priceId: price.id, quantity: 1 }], settings: { displayMode: 'overlay', theme: dark ? 'dark' : 'light', locale: code === 'zh' ? 'zh-Hans' : code } });
  render();
}

/** The checkout is paid: the server is asked for the key and the pass until the subscription exists on Paddle's side. */
async function completed(transactionId: string): Promise<void> {
  if (state.busy === 'pass') return;
  state.busy = 'pass'; state.said = { where: 'buy', text: t('Paid. Setting up Plus in this browser…'), good: true }; render();
  const started = Date.now();
  for (;;) {
    const answer = await post('/pass', { transactionId });
    const grant = answer?.status === 200 ? readGrant(answer.body) : null;
    if (grant?.key) {
      member.accept({ key: grant.key, pass: grant.pass, until: grant.until });
      state.busy = ''; state.fresh = true; state.shown = true;
      state.said = { where: 'buy', text: t('Thank you. Plus is on in this browser.'), good: true };
      try { window.Paddle?.Checkout.close(); } catch { /* the overlay closes itself */ }
      render(); return;
    }
    if (Date.now() - started > PASS_WAIT_MS) break;
    await new Promise(resolve => setTimeout(resolve, PASS_RETRY_MS));
  }
  state.busy = '';
  state.said = { where: 'buy', text: t('The payment went through, but Plus could not be set up here yet. Use the email and the invoice number from your receipt below in a few minutes; nothing is lost.') };
  render();
}

async function useKey(key: string): Promise<void> {
  const text = key.trim();
  if (state.busy || text.length < 16) { state.said = { where: 'key', text: t('That does not look like a key.') }; render(); return; }
  state.busy = 'key'; state.said = null; render();
  const answer = await post('/pass/renew', { key: text });
  state.busy = '';
  const grant = answer?.status === 200 ? readGrant(answer.body) : null;
  if (grant) { member.accept({ key: text, pass: grant.pass, until: grant.until }); state.said = { where: 'key', text: t('Plus is on in this browser.'), good: true }; }
  else state.said = { where: 'key', text: answer ? t('That key is not known, or its subscription has ended.') : t('The server could not be reached. Try again in a moment.') };
  render();
}

async function restore(email: string, invoice: string): Promise<void> {
  if (state.busy) return;
  if (!/^\S+@\S+\.\S+$/.test(email.trim()) || invoice.trim().length < 3) { state.said = { where: 'restore', text: t('Enter the email you paid with and the invoice number from your receipt.') }; render(); return; }
  state.busy = 'restore'; state.said = null; render();
  const answer = await post('/restore', { email: email.trim(), invoice: invoice.trim() });
  state.busy = '';
  const grant = answer?.status === 200 ? readGrant(answer.body) : null;
  if (grant?.key) { member.accept({ key: grant.key, pass: grant.pass, until: grant.until }); state.shown = true; state.said = { where: 'restore', text: t('Found. Plus is on in this browser.'), good: true }; }
  else state.said = { where: 'restore', text: answer ? t('No subscription in good standing was found for that email and invoice number.') : t('The server could not be reached. Try again in a moment.') };
  render();
}

const said = (where: 'buy' | 'key' | 'restore'): HTMLElement[] => state.said?.where === where ? [el('p', { class: state.said.good ? 'said-good' : 'said-bad', role: 'status', textContent: state.said.text })] : [];
const link = (href: string, text: string): HTMLAnchorElement => el('a', { href, textContent: text });

/** The price buttons, or why there are none yet. */
function buySection(): HTMLElement {
  const box = el('section', { class: 'buy' });
  if (!plusOnSale()) {
    box.append(el('h2', { textContent: t('Not on sale yet') }), el('p', { textContent: t('Plus is being set up. This page will carry its price and the checkout when it opens.') }));
    return box;
  }
  const price = (label: string, detail: string, p: PlusPrice, main: boolean): HTMLButtonElement => {
    const button = el('button', { type: 'button', class: main ? 'price-main' : 'price-plain', disabled: state.busy !== '', onclick: () => { void buy(p); } }, el('b', { textContent: label }), el('span', { textContent: detail }));
    return button;
  };
  const prices = el('div', { class: 'prices' }, price(t('{price} a month', { price: money(PADDLE.monthly.usd) }), t('renews each month'), PADDLE.monthly, true));
  if (PADDLE.yearly.id) prices.append(price(t('{price} a year', { price: money(PADDLE.yearly.usd) }), t('renews each year'), PADDLE.yearly, false));
  box.append(el('h2', { textContent: member.known && !member.on ? t('Renew Plus') : t('Get Plus') }), prices, ...said('buy'),
    el('p', { class: 'fine', textContent: t('Prices are before tax; the checkout shows the total in your currency. You can end Plus at any time, and it then runs to the end of the period paid for.') }),
    el('p', { class: 'fine', textContent: t('Our order process is conducted by our online reseller Paddle.com. Paddle.com is the Merchant of Record for all our orders. Paddle provides all customer service inquiries and handles returns.') }));
  return box;
}

/** What this browser holds: whether Plus is on, until when, and the key. */
function memberSection(): HTMLElement {
  const box = el('section', { class: 'member' }), until = member.until, key = member.key ?? '';
  const keyText = el('code', { class: 'key', textContent: state.shown ? key : '•'.repeat(24) });
  const copied = el('span', { class: 'copied', role: 'status' });
  let armed = 0;
  const remove = el('button', { type: 'button', class: 'quiet', textContent: t('Remove Plus from this browser') });
  remove.onclick = () => {
    // Twice, so that a slip does not take it away: the key would have to be typed again.
    if (Date.now() - armed < 6_000) { member.forget(); state.said = null; return; }
    armed = Date.now(); remove.textContent = t('Press again to remove it');
    window.setTimeout(() => { if (remove.isConnected) remove.textContent = t('Remove Plus from this browser'); }, 6_000);
  };
  box.append(
    el('h2', { textContent: member.on ? t('Plus is on in this browser') : t('Plus has ended in this browser') }),
    el('p', { textContent: member.on ? (until ? t('Paid until {date}. It renews by itself until you end it.', { date: day(until) }) : t('It renews by itself until you end it.'))
      : t('The subscription this key belongs to is not paid at the moment. Renewing it below brings Plus back with the same key.') }),
    el('div', { class: 'keyrow' }, el('span', { class: 'label', textContent: t('Your key') }), keyText,
      el('button', { type: 'button', textContent: state.shown ? t('Hide') : t('Reveal'), onclick: () => { state.shown = !state.shown; render(); } }),
      el('button', { type: 'button', textContent: t('Copy'), onclick: () => { void navigator.clipboard?.writeText(key).then(() => { copied.textContent = t('Copied'); }, () => { copied.textContent = t('Could not copy: show the key and copy it by hand.'); }); } }), copied),
    el('p', { class: 'fine', textContent: t('The key is your Plus on any device: open this page there and enter it. Keep it to yourself; one key works on up to {n} devices.', { n: PLUS_DEVICES }) }),
    el('p', { class: 'actions' }, ...(PADDLE.portal ? [link(PADDLE.portal, t('End the subscription or change the card'))] : [el('span', { class: 'fine', textContent: t('To end the subscription or change the card, use the link in your receipt from Paddle.') })]), remove),
  );
  if (state.fresh) box.append(...said('buy'), el('p', { class: 'actions' }, el('a', { class: 'go', href: '../', textContent: t('Open the map') })));
  return box;
}

/** Bringing Plus to this device: the key, or the receipt's email and invoice number. */
function deviceSection(): HTMLElement {
  const key = el('input', { type: 'text', autocomplete: 'off', spellcheck: false, placeholder: t('Your key'), value: state.typed.key, oninput: () => { state.typed.key = key.value; } });
  key.setAttribute('aria-label', t('Your key'));
  const email = el('input', { type: 'email', autocomplete: 'email', placeholder: t('Email you paid with'), value: state.typed.email, oninput: () => { state.typed.email = email.value; } });
  const invoice = el('input', { type: 'text', autocomplete: 'off', spellcheck: false, placeholder: t('Invoice number'), value: state.typed.invoice, oninput: () => { state.typed.invoice = invoice.value; } });
  email.setAttribute('aria-label', t('Email you paid with')); invoice.setAttribute('aria-label', t('Invoice number'));
  const busy = state.busy !== '';
  const keyForm = el('form', { class: 'row' }, key, el('button', { type: 'submit', disabled: busy, textContent: state.busy === 'key' ? t('Checking…') : t('Use this key') }));
  keyForm.onsubmit = event => { event.preventDefault(); void useKey(key.value); };
  const restoreForm = el('form', { class: 'row' }, email, invoice, el('button', { type: 'submit', disabled: busy, textContent: state.busy === 'restore' ? t('Looking…') : t('Find my Plus') }));
  restoreForm.onsubmit = event => { event.preventDefault(); void restore(email.value, invoice.value); };
  return el('section', { class: 'device' },
    el('h2', { textContent: t('Already have Plus?') }),
    el('p', { textContent: t('Enter your key to use Plus in this browser.') }), keyForm, ...said('key'),
    el('p', { textContent: t('No key at hand? The email you paid with and the invoice number on your receipt bring it back.') }), restoreForm, ...said('restore'),
    el('p', { class: 'fine', textContent: t('What you type here is sent to this site\'s server to find your subscription, and nowhere else.') }));
}

function render(): void {
  const first = state.first;
  root.replaceChildren(el('main', { class: 'plus-page' },
    el('header', {},
      el('a', { class: 'home', href: '../', textContent: 'LiquidityMapperFast' }),
      el('h1', { textContent: PLUS_NAME }),
      el('p', { class: 'lead', textContent: t('Plus pays for the servers behind LiquidityMapperFast and opens what they store. The page itself stays free and open source.') })),
    el('figure', {},
      el('img', { src: './history.webp', width: 1760, height: 932, alt: t('The Depth pane showing three weeks of liquidation levels: shorts above, longs below, in bands by distance from the price.'), loading: 'lazy' }),
      el('figcaption', { textContent: t('Hyperliquid\'s BTC liquidation levels through time, in the Depth pane: how much would be liquidated within each distance of the price, snapshot after snapshot.') })),
    el('section', { class: 'cols' },
      el('div', {}, el('h2', { textContent: t('What Plus adds') }),
        el('ul', {},
          el('li', { textContent: first ? t('The whole history of the liquidation levels, back to {date}. Without Plus the pane draws the last {n} days.', { date: day(first), n: FREE_DAYS })
            : t('The whole history of the liquidation levels, as far back as it is recorded. Without Plus the pane draws the last {n} days.', { n: FREE_DAYS }) }),
          el('li', { textContent: t('A new snapshot about every half hour, kept for good: the history grows by a day every day.') }))),
      el('div', {}, el('h2', { textContent: t('What stays free') }),
        el('p', { textContent: t('Everything the page does today: the map, the order book, the flow, every pane and tool, the live liquidation levels and the last {n} days of their history.', { n: FREE_DAYS }) }),
        el('p', { textContent: t('There is no account. After the checkout this browser holds a key, and the key is all it takes on another device.') }))),
    ...(member.known ? [memberSection()] : []),
    ...(member.on ? [] : [buySection()]),
    ...(plusOnSale() && !member.on ? [deviceSection()] : []),
    el('footer', {},
      el('p', {}, link('../', t('Open the map')), ' · ', link(`../${LEGAL.terms}`, t('Terms')), ' · ', link(`../${LEGAL.privacy}`, t('Privacy')), ' · ', link(`../${LEGAL.refunds}`, t('Refunds'))),
      el('p', { class: 'fine' }, t('Questions about the page: {email}. Questions about a payment go to Paddle, which sold it: paddle.net.', { email: PLUS_CONTACT }))),
  ));
}

member.subscribe(render);
render();
// How far back the history goes, for the first line of what Plus adds (the public index says).
const urls = historyUrls(LIQ_LEVELS_URL);
if (urls) void fetch(urls.index).then(answer => answer.ok ? answer.json() : null).then((raw: unknown) => {
  const first = readIndex(raw)?.first ?? null;
  if (first !== null && first !== state.first) { state.first = first; render(); }
}).catch(() => { /* the line without a date stands */ });
