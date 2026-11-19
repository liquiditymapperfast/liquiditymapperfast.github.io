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
import { FREE_DAYS, LEGAL, PADDLE, PLUS_CONTACT, PLUS_KEYS, plusApi, plusOnSale, type PlusPrice } from './config.ts';
import { PLUS_NAME } from './name.ts';
import { plus, readGrant, webPost, type Grant } from './pass.ts';
import { ARRIVAL_SECONDS, Arrival, countsDown, placeOf, stopOnActivity, type ArrivalVia } from './arrival.ts';

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
/** Paddle's script is given this long to arrive and start. */
const PADDLE_WAIT_MS = 20_000;

const root = document.getElementById('plus')!;
const member = plus();
const day = (time: number): string => new Intl.DateTimeFormat(language(), { dateStyle: 'long', timeZone: 'UTC' }).format(time);
const money = (usd: number): string => new Intl.NumberFormat(language(), { style: 'currency', currency: 'USD', maximumFractionDigits: Number.isInteger(usd) ? 0 : 2 }).format(usd);

/**
 * The app's theme, as this browser wears it there (the app saves the one in use, picked or its own choice for the device). A visitor who
 * never opened the app gets the app's choice for a first visit: the dark theme on a phone set to dark, else the light one.
 */
function wearTheme(): boolean {
  let name: string | null = null;
  // A theme counts only where it was picked; the app works out its own choice afresh on every visit (store.ts), and so does this page.
  try { const saved = JSON.parse(localStorage.getItem('hlm-app-v2') ?? 'null') as { theme?: unknown; themePicked?: unknown } | null; if (saved && saved.themePicked === true && typeof saved.theme === 'string') name = saved.theme; } catch { /* no saved theme */ }
  if (name === null) {
    let phoneDark = false;
    try { phoneDark = matchMedia('(prefers-color-scheme: dark)').matches && matchMedia('(pointer: coarse)').matches; } catch { /* the light theme */ }
    name = phoneDark ? 'terminal' : 'light';
  }
  return applyTheme(name).dark;
}
const dark = wearTheme();

/** What the page shows beside what the membership says: a message under the price or a form, and whether something is under way. */
const state: { busy: '' | 'checkout' | 'pass' | 'key' | 'restore'; said: { where: 'buy' | 'key' | 'restore'; text: string; good?: boolean } | null; shown: boolean; first: number | null; fresh: boolean;
  /** What is typed in the forms, kept across the page being drawn again (an answer, another tab). */ typed: { key: string; email: string; invoice: string };
  /** When "Remove Plus from this browser" was first pressed (it takes two presses). */ armed: number;
  /** The browser would not keep the membership: it lasts as long as this tab. */ unkept: boolean } =
  { busy: '', said: null, shown: false, first: null, fresh: false, typed: { key: '', email: '', invoice: '' }, armed: 0, unkept: false };

type Answer = { status: number; body: unknown; retryAfter?: number };
/** A request to the Plus server, or null when it could not be reached. */
async function post(path: string, body: unknown): Promise<Answer | null> {
  try { return await webPost(`${plusApi()}${path}`, body); } catch { return null; }
}
const errorOf = (answer: Answer): string => { const e = answer.body && typeof answer.body === 'object' ? (answer.body as { error?: unknown }).error : null; return typeof e === 'string' ? e : ''; };
/** The server's own refusals (it looked, and found nothing it could open); any other refusal is not the server's word on the membership. */
const LOOKED = new Set(['not_active', 'not_found', 'wrong_price']);

/**
 * A payment made in this browser whose Plus is not set up yet (`{ id, at }`: Paddle's transaction and when it was paid), kept until it is,
 * so that a reload asks again and the prices stay away meanwhile: nobody pays twice because the first setting-up failed. Given up after a
 * day (the receipt's email and invoice number still bring Plus back).
 */
const PAID_STORE = 'lmf.plus.paid', PAID_KEEP_MS = 86_400_000;
function paidPending(): { id: string; at: number } | null {
  try {
    const o = JSON.parse(localStorage.getItem(PAID_STORE) ?? 'null') as { id?: unknown; at?: unknown } | null;
    if (!o || typeof o.id !== 'string' || !/^txn_[a-z0-9]{8,64}$/.test(o.id) || typeof o.at !== 'number') return null;
    if (Date.now() - o.at > PAID_KEEP_MS || o.at > Date.now() + 3_600_000) { localStorage.removeItem(PAID_STORE); return null; }
    return { id: o.id, at: o.at };
  } catch { return null; }
}
function setPaid(id: string | null): void {
  try { if (id) localStorage.setItem(PAID_STORE, JSON.stringify({ id, at: Date.now() })); else localStorage.removeItem(PAID_STORE); } catch { /* kept for this tab only */ }
}
/**
 * What an answer that gave no membership means, in the visitor's words: the server not reached or in trouble, too many tries (with the
 * wait it asked for), too many keys in a day; `refusal` is said for the rest (the server looked and found nothing it could open).
 */
function problem(answer: Answer | null, refusal: string): string {
  if (!answer || answer.status >= 500) return t('The server could not be reached. Try again in a moment.');
  if (answer.status === 429 && errorOf(answer) === 'too_many_keys') return t('This subscription was given {n} keys within a day. Use one of them, or try again tomorrow.', { n: PLUS_KEYS });
  if (answer.status === 429) return answer.retryAfter ? t('Too many tries. Try again in {n} min.', { n: Math.max(1, Math.ceil(answer.retryAfter / 60)) }) : t('Too many tries. Try again later.');
  // A refusal that is not the server's own (a firewall's or a challenge page, a 400 or 404): it says nothing about the key or the payment.
  return LOOKED.has(errorOf(answer)) ? refusal : t('The server turned the request down. Try again later, or without a VPN or blocker.');
}
/** A membership arrived: kept, and said when the browser would not keep it. */
function take(key: string, grant: Grant): void {
  setPaid(null);
  state.unkept = !member.accept({ key, pass: grant.pass, until: grant.until, ...(grant.renews !== undefined ? { renews: grant.renews } : {}), ...(grant.now !== undefined ? { now: grant.now } : {}) });
}

/**
 * The confirmation at the top of the window right after Plus came on here (`arrival.ts`): drawn apart from the page (which is drawn afresh
 * on every change, and would announce it again each time), built once per confirmation and given the focus, its countdown changed in place.
 */
const arrivalHost = el('div', { class: 'arrival-host' });
document.body.prepend(arrivalHost);
let arrivalDrawn: { started: number; count: HTMLElement; bar: HTMLElement; stay: HTMLButtonElement } | null = null;
const arrival = new Arrival({ now: () => Date.now(), every: (ms, run) => { const id = window.setInterval(run, ms); return () => window.clearInterval(id); } },
  () => { window.location.assign('../'); }, drawArrival);
function drawArrival(): void {
  const s = arrival.state;
  if (!s) { arrivalHost.replaceChildren(); arrivalDrawn = null; return; }
  if (arrivalDrawn?.started !== arrival.started) {
    const words = s.until ? t('Plus is on in this browser, until {date}.', { date: day(s.until) }) : t('Plus is on in this browser.');
    const title = el('p', { class: 'arrival-text', id: 'plus-arrival-text', textContent: words });
    const count = el('p', { class: 'arrival-count' });
    const go = el('a', { class: 'go', href: '../', textContent: t('Open the map'), onclick: () => { arrival.leaving(); } });
    const stay = el('button', { type: 'button', id: 'plus-arrival-stay' });
    const bar = el('i', { class: 'arrival-bar', ariaHidden: 'true' });
    bar.style.animationDuration = `${ARRIVAL_SECONDS}s`;
    // A region named by its sentence, given the focus: a screen reader says the sentence, the keys go on to its two buttons.
    const box = el('section', { class: 'arrival', id: 'plus-arrival', tabIndex: -1 }, title, count, el('p', { class: 'actions' }, go, stay), bar);
    box.setAttribute('aria-labelledby', title.id);
    arrivalHost.replaceChildren(box);
    arrivalDrawn = { started: arrival.started, count, bar, stay };
    box.focus({ preventScroll: true });
  }
  const { count, bar, stay } = arrivalDrawn;
  // The countdown is not a live region: it would be read out every second.
  count.hidden = !s.counting; bar.hidden = !s.counting;
  if (s.counting) count.textContent = t('Back to the map in {n} s', { n: s.left });
  // The same button, so the focus stays on it: Stay here while counting, then Close.
  stay.textContent = s.counting ? t('Stay here') : t('Close');
  stay.onclick = () => { if (arrival.state?.counting) arrival.stay(); else arrival.dismiss(); };
}
// A page the browser kept and shows again (Back from the map) does not count down a second time.
window.addEventListener('pageshow', event => { if (event.persisted) arrival.stay(); });
// Anything the visitor does on the page (Reveal, Copy, a field, the wheel, a scroll) stops the countdown, and so does a hidden tab; the
// confirmation's own button and link do what they say (Space presses the button, but from the link it scrolls the page, and counts).
const activity = stopOnActivity(document, arrival, target => placeOf(target, t => t instanceof Node && arrivalHost.contains(t)), () => window.scrollY);
/**
 * Plus came on here by the visitor's own doing: the confirmation, counting down to the map only after a key typed into the key box (after a
 * checkout or a restore the page shows the new key, to be copied first; never where the browser would not keep Plus, nor in a hidden tab).
 */
const arrived = (via: ArrivalVia): void => { arrival.start(member.until, countsDown(via, state.shown, !state.unkept, document.hidden)); };

let paddle: Promise<PaddleApi | null> | null = null;
/** Paddle's script, fetched once, when a price is first pressed. */
function loadPaddle(): Promise<PaddleApi | null> {
  paddle ??= new Promise(resolve => {
    const script = el('script', { src: PADDLE_SCRIPT, async: true });
    // Whatever goes wrong (blocked, slow, the script throwing), the buttons come back and the next press tries afresh; a script that arrives
    // after this load was given up is left alone.
    let over = false;
    const fail = (): void => { over = true; paddle = null; script.remove(); resolve(null); };
    const wait = window.setTimeout(fail, PADDLE_WAIT_MS);
    script.onload = () => {
      window.clearTimeout(wait);
      if (over) return;
      try {
        const api = window.Paddle;
        if (!api) { fail(); return; }
        if (PADDLE.environment === 'sandbox') api.Environment.set('sandbox');
        api.Initialize({ token: PADDLE.token, eventCallback: event => { if (event.name === 'checkout.completed' && event.data?.transaction_id) void completed(event.data.transaction_id); } });
        resolve(api);
      } catch { fail(); }
    };
    script.onerror = () => { window.clearTimeout(wait); if (!over) fail(); };
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
  try { api.Checkout.open({ items: [{ priceId: price.id, quantity: 1 }], settings: { displayMode: 'overlay', theme: dark ? 'dark' : 'light', locale: code === 'zh' ? 'zh-Hans' : code } }); }
  catch { state.said = { where: 'buy', text: t('The checkout could not be loaded. Check your connection, or a blocker that stops paddle.com, and try again.') }; }
  render();
}

/** The checkout is paid: the server is asked for the key and the pass until the subscription exists on Paddle's side. */
async function completed(transactionId: string): Promise<void> {
  if (state.busy === 'pass') return;
  if (paidPending()?.id !== transactionId) setPaid(transactionId);
  state.busy = 'pass'; state.said = { where: 'buy', text: t('Paid. Setting up Plus in this browser…'), good: true }; render();
  const started = Date.now();
  for (;;) {
    const answer = await post('/pass', { transactionId });
    const grant = answer?.status === 200 ? readGrant(answer.body) : null;
    if (grant?.key) {
      take(grant.key, grant);
      state.busy = ''; state.fresh = true; state.shown = true;
      state.said = { where: 'buy', text: t('Thank you. Plus is on in this browser.'), good: true };
      try { window.Paddle?.Checkout.close(); } catch { /* the overlay closes itself */ }
      render(); arrived('checkout'); return;
    }
    // Asked again while the subscription may still be on its way (not there yet, the server busy or not reached); an answer that will
    // not change (the server looked and refused) ends the wait at once.
    const waiting = !answer || answer.status === 409 || answer.status >= 500 || (answer.status === 429 && errorOf(answer) !== 'too_many_keys');
    if (!waiting) {
      state.busy = '';
      state.said = { where: 'buy', text: answer.status === 429 ? problem(answer, '') : LOOKED.has(errorOf(answer)) ? t('The payment went through, but the server would not set up Plus for it. Write to {email} with your receipt; nothing is lost.', { email: PLUS_CONTACT }) : problem(answer, '') };
      render(); return;
    }
    if (Date.now() - started > PASS_WAIT_MS) break;
    await new Promise(resolve => setTimeout(resolve, Math.min(30_000, Math.max(PASS_RETRY_MS, (answer?.retryAfter ?? 0) * 1_000))));
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
  if (grant) { take(text, grant); state.typed.key = ''; state.said = { where: 'key', text: t('Plus is on in this browser.'), good: true }; }
  else state.said = { where: 'key', text: problem(answer, t('That key is not known, or its subscription has ended.')) };
  render();
  if (grant) arrived('key');
}

async function restore(email: string, invoice: string): Promise<void> {
  if (state.busy) return;
  if (!/^\S+@\S+\.\S+$/.test(email.trim()) || invoice.trim().length < 3) { state.said = { where: 'restore', text: t('Enter the email you paid with and the invoice number from your receipt.') }; render(); return; }
  state.busy = 'restore'; state.said = null; render();
  const answer = await post('/restore', { email: email.trim(), invoice: invoice.trim() });
  state.busy = '';
  const grant = answer?.status === 200 ? readGrant(answer.body) : null;
  if (grant?.key) { take(grant.key, grant); state.shown = true; state.said = { where: 'restore', text: t('Found. Plus is on in this browser.'), good: true }; }
  else state.said = { where: 'restore', text: problem(answer, t('No subscription in good standing was found for that email and invoice number.')) };
  render();
  if (grant?.key) arrived('restore');
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
  const pending = paidPending();
  if (pending) {
    box.append(el('h2', { textContent: t('Get Plus') }), ...said('buy'),
      el('p', { textContent: t('A payment made in this browser is still being set up. The prices come back once it is, so it is not paid twice.') }),
      el('p', { class: 'actions' }, el('button', { type: 'button', id: 'plus-paid-again', disabled: state.busy !== '', textContent: t('Try again'), onclick: () => { void completed(pending.id); } })));
    return box;
  }
  const price = (label: string, detail: string, p: PlusPrice, main: boolean, id: string): HTMLButtonElement => {
    const button = el('button', { type: 'button', id, class: main ? 'price-main' : 'price-plain', disabled: state.busy !== '', onclick: () => { void buy(p); } }, el('b', { textContent: label }), el('span', { textContent: detail }));
    return button;
  };
  const prices = el('div', { class: 'prices' }, price(t('{price} a month', { price: money(PADDLE.monthly.usd) }), t('renews each month'), PADDLE.monthly, true, 'plus-monthly'));
  if (PADDLE.yearly.id) prices.append(price(t('{price} a year', { price: money(PADDLE.yearly.usd) }), t('renews each year'), PADDLE.yearly, false, 'plus-yearly'));
  box.append(el('h2', { textContent: member.state === 'ended' ? t('Renew Plus') : t('Get Plus') }), prices, ...said('buy'),
    el('p', { class: 'fine', textContent: t('Prices are before tax; the checkout shows the total in your currency. You can end Plus at any time, and it then runs to the end of the period paid for.') }),
    el('p', { class: 'fine', textContent: t('Our order process is conducted by our online reseller Paddle.com. Paddle.com is the Merchant of Record for all our orders. Paddle provides all customer service inquiries and handles returns.') }));
  return box;
}

/** What this browser holds: whether Plus is on, until when, and the key. */
function memberSection(): HTMLElement {
  const box = el('section', { class: 'member' }), until = member.until, key = member.key ?? '', stands = member.state, renews = member.renews;
  const keyText = el('code', { class: 'key', textContent: state.shown ? key : '•'.repeat(24) });
  const copied = el('span', { class: 'copied', role: 'status' });
  const isArmed = (): boolean => { const since = Date.now() - state.armed; return since >= 400 && since < 6_000; };
  const remove = el('button', { type: 'button', class: 'quiet', id: 'plus-remove', textContent: Date.now() - state.armed < 6_000 ? t('Press again to remove it') : t('Remove Plus from this browser') });
  remove.onclick = () => {
    // Twice, so that a slip does not take it away: the key would have to be typed again.
    // Twice, a moment apart: the two clicks of a double click are one press.
    if (isArmed()) { state.armed = 0; state.said = null; state.unkept = false; member.forget(); return; }
    if (Date.now() - state.armed < 400) return;
    state.armed = Date.now(); remove.textContent = t('Press again to remove it');
    window.setTimeout(() => { const now = document.getElementById('plus-remove'); if (!isArmed() && now) now.textContent = t('Remove Plus from this browser'); }, 6_100);
  };
  // Only the server's refusal is an end: a pass that ran out, or a server not reached, is being checked (the key may be perfectly good).
  const heading = stands === 'on' ? t('Plus is on in this browser') : stands === 'ended' ? t('Plus has ended in this browser') : t('Checking Plus with the server…');
  const standing = stands === 'on' ? (until ? (renews === true ? t('Paid until {date}. It renews by itself until you end it.', { date: day(until) }) : t('Plus runs until {date}.', { date: day(until) })) : renews === true ? t('It renews by itself until you end it.') : '')
    : stands === 'ended' ? (member.why === 'replaced' ? t('This key was replaced by newer ones (a subscription holds five). The email and the invoice number from your receipt bring Plus back here.') : t('This key no longer opens Plus: its subscription has ended, or the key was replaced by newer ones.'))
      : t('This browser holds a key that the server has not confirmed yet. If this stays, check your connection.');
  box.append(
    el('h2', { textContent: heading }),
    ...(standing ? [el('p', { textContent: standing })] : []),
    ...(stands === 'ended' && member.why !== 'replaced' && plusOnSale() ? [el('p', { textContent: t('Subscribing again below brings Plus back, with a new key.') })] : []),
    ...(state.unkept && stands === 'on' ? [el('p', { class: 'said-bad', role: 'status', textContent: t('This browser would not keep Plus: it lasts until this tab closes. Copy the key now and enter it again next time.') })] : []),
    el('div', { class: 'keyrow' }, el('span', { class: 'label', textContent: t('Your key') }), keyText,
      el('button', { type: 'button', id: 'plus-reveal', textContent: state.shown ? t('Hide') : t('Reveal'), onclick: () => { state.shown = !state.shown; render(); } }),
      el('button', { type: 'button', id: 'plus-copy', textContent: t('Copy'), onclick: () => { if (!navigator.clipboard) { copied.textContent = t('Could not copy: show the key and copy it by hand.'); return; } void navigator.clipboard.writeText(key).then(() => { copied.textContent = t('Copied'); }, () => { copied.textContent = t('Could not copy: show the key and copy it by hand.'); }); } }), copied),
    // A key the server has ended opens nothing anywhere; a membership that does not renew (a gift, one already ended at Paddle) has no
    // subscription to end.
    ...(stands !== 'ended' ? [el('p', { class: 'fine', textContent: t('The key is your Plus on your other devices too: open this page there and enter it. Keep it to yourself.') })] : []),
    el('p', { class: 'actions' }, ...(stands === 'ended' || renews === false ? [] : PADDLE.portal ? [link(PADDLE.portal, t('End the subscription or change the card'))] : [el('span', { class: 'fine', textContent: t('To end the subscription or change the card, use the link in your receipt from Paddle.') })]), remove),
  );
  if (state.fresh) box.append(...said('buy'), el('p', { class: 'actions' }, el('a', { class: 'go', href: '../', textContent: t('Open the map') })));
  return box;
}

/** Bringing Plus to this device: the key, or the receipt's email and invoice number. */
function deviceSection(): HTMLElement {
  const key = el('input', { type: 'text', id: 'plus-key', autocomplete: 'off', spellcheck: false, placeholder: t('Your key'), value: state.typed.key, oninput: () => { state.typed.key = key.value; } });
  key.setAttribute('aria-label', t('Your key'));
  const email = el('input', { type: 'email', id: 'plus-email', autocomplete: 'email', placeholder: t('Email you paid with'), value: state.typed.email, oninput: () => { state.typed.email = email.value; } });
  const invoice = el('input', { type: 'text', id: 'plus-invoice', autocomplete: 'off', spellcheck: false, placeholder: t('Invoice number'), value: state.typed.invoice, oninput: () => { state.typed.invoice = invoice.value; } });
  email.setAttribute('aria-label', t('Email you paid with')); invoice.setAttribute('aria-label', t('Invoice number'));
  const busy = state.busy !== '';
  const keyForm = el('form', { class: 'row' }, key, el('button', { type: 'submit', id: 'plus-key-go', disabled: busy, textContent: state.busy === 'key' ? t('Checking…') : t('Use this key') }));
  keyForm.onsubmit = event => { event.preventDefault(); void useKey(key.value); };
  const restoreForm = el('form', { class: 'row' }, email, invoice, el('button', { type: 'submit', id: 'plus-find-go', disabled: busy, textContent: state.busy === 'restore' ? t('Looking…') : t('Find my Plus') }));
  restoreForm.onsubmit = event => { event.preventDefault(); void restore(email.value, invoice.value); };
  // A key opens Plus whether or not it is on sale (a key given as a gift); finding one by the receipt needs a sale to have happened.
  return el('section', { class: 'device' },
    el('h2', { textContent: t('Already have Plus?') }),
    el('p', { textContent: t('Enter your key to use Plus in this browser.') }), keyForm, ...said('key'),
    ...(plusOnSale() ? [el('p', { textContent: t('No key at hand? The email you paid with and the invoice number on your receipt bring it back.') }), restoreForm, ...said('restore'),
      el('p', { class: 'fine', textContent: t('What you type here is sent to this site\'s server to find your subscription; it asks Paddle, which sold it, about the invoice number.') })] : []));
}

/** The page drawn afresh, through the countdown (`redraw`), which tells a scroll the drawing makes from the visitor's. */
function render(): void { activity.redraw(drawPage); }

function drawPage(): void {
  const first = state.first, stands = member.state;
  // The page is drawn afresh: what had the focus (a field being typed in, a button just pressed) gets it back, the caret where it was.
  const active = document.activeElement instanceof HTMLElement && root.contains(document.activeElement) ? document.activeElement : null;
  const focus = active?.id ? { id: active.id, at: active instanceof HTMLInputElement ? [active.selectionStart, active.selectionEnd] as const : null } : null;
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
          el('li', { textContent: t('A new snapshot about every half hour, kept for good: the history grows by a day every day.') }),
          el('li', { textContent: t('The liquidation levels of the profitable traders, live and through time: the wallets HyperTracker counts as profitable, its four cohorts with a positive all-time perp profit.') }),
          el('li', { textContent: t('The stop and take-profit levels: where open orders would close positions, live and through time, on their own or together with the liquidations.') }))),
      el('div', {}, el('h2', { textContent: t('What stays free') }),
        el('p', { textContent: t('Everything the page does today: the map, the order book, the flow, every pane and tool, the live liquidation levels of all traders and the last {n} days of their history.', { n: FREE_DAYS }) }),
        el('p', { textContent: t('There is no account. After the checkout this browser holds a key, and the key is all it takes on another device.') }))),
    ...(stands !== 'none' ? [memberSection()] : []),
    // Nothing is sold to a browser whose membership is in force or still being checked: only where there is none, or the server ended it
    // (a key replaced by newer ones belongs to a subscription that may well be paid: the receipt brings Plus back, not a second purchase).
    ...(stands === 'none' || (stands === 'ended' && member.why !== 'replaced') ? [buySection()] : []),
    ...(stands !== 'on' ? [deviceSection()] : []),
    el('footer', {},
      el('p', {}, link('../', t('Open the map')), ' · ', link(`../${LEGAL.terms}`, t('Terms')), ' · ', link(`../${LEGAL.privacy}`, t('Privacy')), ' · ', link(`../${LEGAL.refunds}`, t('Refunds'))),
      el('p', { class: 'fine' }, t('Questions about the page: {email}. Questions about a payment go to Paddle, which sold it: paddle.net.', { email: PLUS_CONTACT }))),
  ));
  if (focus) {
    const again = document.getElementById(focus.id);
    if (again && root.contains(again)) {
      again.focus({ preventScroll: true });
      if (focus.at && again instanceof HTMLInputElement) { try { again.setSelectionRange(focus.at[0], focus.at[1]); } catch { /* an email field has no caret to set */ } }
    }
  }
}

member.subscribe(render);
render();
{ const pending = paidPending(); if (pending && member.state !== 'on') void completed(pending.id); else if (pending) setPaid(null); }
// How far back the history goes, for the first line of what Plus adds (the public index says).
const urls = historyUrls(LIQ_LEVELS_URL);
if (urls) void fetch(urls.index).then(answer => answer.ok ? answer.json() : null).then((raw: unknown) => {
  const first = readIndex(raw)?.first ?? null;
  if (first !== null && first !== state.first) { state.first = first; render(); }
}).catch(() => { /* the line without a date stands */ });
