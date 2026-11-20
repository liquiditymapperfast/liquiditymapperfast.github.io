/// <reference types="vite/client" />
/**
 * The Plus page (`plus/`): what Plus is (the presentation's hero, the demo and the three feature sections, shared with the app's sheet:
 * present.ts), its price, the checkout, and the key that carries a membership to another device. It is the one page of the site with the
 * checkout and with another site's script: Paddle's checkout (Paddle is the seller of record), fetched only when a visitor presses a price. After the checkout the page hands the transaction to the site's own server (`config.ts` `plusApi`), which
 * answers with the key and a pass; both go into the storage the app shares (`pass.ts`), so an open tab of the app is unlocked at once.
 * The key box is the app's own key form (`key.ts`), and a checkout's or a receipt's membership is taken the same way (`page-flow.ts`): never
 * over a membership that changed while it was asked for. A payment whose Plus is not set up waits in this browser (`paid.ts`) until it is,
 * or until a key or a receipt's membership taken here settles it.
 */
import './page.css';
import './present.css';
import './key.css';
import '../levels-control.css';
import { el } from '../dom.ts';
import { language, t } from '../i18n.ts';
import { historyUrls, readIndex } from '../liq-history.ts';
import { LIQ_LEVELS_URL } from '../liq-url.ts';
import { applyTheme } from '../theme.ts';
import { LEGAL, PADDLE, PLUS_CONTACT, plusApi, plusOnSale, type PlusPrice } from './config.ts';
import { PLUS_NAME } from './name.ts';
import { plus, webPost } from './pass.ts';
import { ARRIVAL_SECONDS, Arrival, countsDown, placeOf, stopOnActivity, type ArrivalVia } from './arrival.ts';
import { mountDemo, mountVisuals } from './demo/index.ts';
import { demoControl } from './demo-levels.ts';
import { keyEntry, type KeyEntry } from './key.ts';
import { PaidStore, type Paid } from './paid.ts';
import { besideMembership, keySettling, keyShownFor, planPayment, restoreSettling, setUpPayment, type Answer, type Fresh, type PaidVia } from './page-flow.ts';
import { features, hero, trust } from './present.ts';

/** The part of Paddle's script this page uses (Paddle.js v2). */
interface PaddleEvent { name?: string; data?: { transaction_id?: string } }
interface PaddleApi {
  Environment: { set(environment: 'sandbox' | 'production'): void };
  Initialize(options: { token: string; eventCallback?: (event: PaddleEvent) => void }): void;
  Checkout: { open(options: { items: { priceId: string; quantity: number }[]; settings?: { displayMode?: 'overlay'; theme?: 'light' | 'dark'; locale?: string } }): void; close(): void };
}
declare global { interface Window { Paddle?: PaddleApi } }

const PADDLE_SCRIPT = 'https://cdn.paddle.com/paddle/v2/paddle.js';
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

/**
 * The top of the page, drawn once: the brand, the hero (its pill, and a button to the checkout or the key box), the demo with the page's own
 * levels control on the demo's store, and the three feature sections with their pictures. The rest of the page (`rest`) is drawn afresh
 * on every change; the demo runs on through it.
 */
const onPill = el('span', { class: 'px-pill on', hidden: true }, el('span', { class: 'px-check', ariaHidden: 'true' }), el('span', { textContent: t('Plus is on in this browser') }));
const cta = el('button', { type: 'button', class: 'px-cta' });
const feats = features(day);
const stage = el('section', { class: 'px-stage', ariaLabel: t('Interactive demo') });
const rest = el('div', { class: 'plus-rest' }), foot = el('div', { class: 'plus-foot' });
root.replaceChildren(el('main', { class: 'plus-page' },
  el('header', { class: 'plus-head' }, el('b', { textContent: PLUS_NAME }), el('a', { class: 'home', href: '../', textContent: 'LiquidityMapperFast' })),
  hero('plus-title', onPill, cta), stage, ...feats.root, rest, foot));
mountDemo(stage, { control: demoControl });
mountVisuals(feats.hosts);
// To the checkout while Plus is on sale, else to the key box; the keyboard follows once the page has scrolled there.
cta.addEventListener('click', () => {
  const target = plusOnSale() && document.getElementById('plus-monthly') ? document.getElementById('plus-monthly') : keyBox.input.isConnected ? keyBox.input : null;
  if (!target) return;
  target.scrollIntoView({ behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'center' });
  window.setTimeout(() => target.focus({ preventScroll: true }), 400);
});

/** What the page shows beside what the membership says: a message under the price or a form, and whether something is under way. */
const state: { busy: '' | 'checkout' | 'pass' | 'restore'; said: { where: 'buy' | 'restore'; text: string; good?: boolean } | null;
  /** The key Reveal was pressed for, or the one a checkout or a restore just issued: shown in clear while it is this browser's key (`keyShownFor`). */ shown: string | null;
  first: number | null;
  /** The checkout just set up here and the key it issued: thanked for while that key is this browser's (`besideMembership`). */ fresh: Fresh | null;
  /** What is typed in the receipt form, kept across the page being drawn again (an answer, another tab). */ typed: { email: string; invoice: string };
  /** When "Remove Plus from this browser" was first pressed (it takes two presses). */ armed: number;
  /** The browser would not keep the membership: it lasts as long as this tab. */ unkept: boolean } =
  { busy: '', said: null, shown: null, first: null, fresh: null, typed: { email: '', invoice: '' }, armed: 0, unkept: false };

/** A request to the Plus server, or null when it could not be reached. */
async function post(path: string, body: unknown): Promise<Answer | null> {
  try { return await webPost(`${plusApi()}${path}`, body); } catch { return null; }
}

/**
 * The payments made in this browser whose Plus is not set up yet (`paid.ts`): each kept from its checkout until it is, so that a reload asks
 * again and the prices stay away meanwhile (nobody pays twice because the first setting-up failed), and given up a day after its checkout
 * (the receipt's email and invoice number still bring Plus back).
 */
const paid = new PaidStore();
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
const arrived = (via: ArrivalVia): void => { arrival.start(member.until, countsDown(via, keyShownFor(state.shown, member.key), !state.unkept, document.hidden)); };

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
        api.Initialize({ token: PADDLE.token, eventCallback: event => { if (event.name === 'checkout.completed' && event.data?.transaction_id) void completed(event.data.transaction_id, 'checkout'); } });
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

/**
 * A payment's setting-up (`planPayment`, `setUpPayment`): its checkout completed, the page came back to it, or its Try again was pressed. The
 * server is asked for the key and the pass until the subscription exists on Paddle's side. Plus comes on here only if the membership did not
 * change meanwhile; if another tab stored a key or removed the one here, the payment stays waiting in this browser, and only its Try again
 * asks for its key afresh, for the membership as it is then. A payment given up (a day after its checkout) is not asked for again.
 */
async function completed(transactionId: string, via: PaidVia): Promise<void> {
  // A checkout's record is written whatever else is under way; it is asked for in its turn (a reload, or its Try again).
  if (state.busy === 'pass') { if (via === 'checkout') { paid.begin(transactionId, member.generation()); render(); } return; }
  const plan = planPayment(transactionId, via, { member, paid });
  if (plan.kind !== 'ask') { render(); return; }
  state.busy = 'pass'; state.said = { where: 'buy', text: t('Paid. Setting up Plus in this browser…'), good: true }; render();
  const out = await setUpPayment(transactionId, plan.generation, { ask: post, member, paid });
  state.busy = '';
  if (out.kind === 'ok') {
    state.unkept = !out.kept; state.fresh = { id: transactionId, key: out.grant.key }; state.shown = out.grant.key;
    state.said = { where: 'buy', text: t('Thank you. Plus is on in this browser.'), good: true };
    try { window.Paddle?.Checkout.close(); } catch { /* the overlay closes itself */ }
    render(); arrived('checkout'); return;
  }
  state.said = out.kind === 'stale' ? null : { where: 'buy', text: out.kind === 'no' ? out.text : t('The payment went through, but Plus could not be set up here yet. Use the email and the invoice number from your receipt below in a few minutes; nothing is lost.') };
  render();
}

/**
 * The membership paid with this email, by the receipt's invoice number (`restoreSettling`): taken only if the membership did not change
 * meanwhile, and then it settles the payments that were waiting here when it was asked for (a payment made meanwhile keeps waiting).
 */
async function restore(email: string, invoice: string): Promise<void> {
  if (state.busy) return;
  state.busy = 'restore'; state.said = null; render();
  const out = await restoreSettling(email, invoice, { ask: post, member, paid });
  state.busy = '';
  if (out.kind === 'ok') {
    state.unkept = !out.kept; state.shown = out.grant.key;
    state.said = { where: 'restore', text: t('Found. Plus is on in this browser.'), good: true };
  } else state.said = out.kind === 'no' ? { where: 'restore', text: out.text } : null;
  render();
  if (out.kind === 'ok') arrived('restore');
}

const said = (where: 'buy' | 'restore'): HTMLElement[] => state.said?.where === where ? [el('p', { class: state.said.good ? 'said-good' : 'said-bad', role: 'status', textContent: state.said.text })] : [];
const link = (href: string, text: string): HTMLAnchorElement => el('a', { href, textContent: text });

/**
 * A payment made in this browser whose Plus is not set up here (the setting-up failed, or the membership changed while it ran: another tab's
 * key, the key here removed), with Try again, which asks for its key afresh and takes it for the membership as it is then (`withSaid`: what
 * the page said about the checkout goes with it, unless the thanks beside it say it).
 */
const pendingNote = (pending: Paid, withSaid = true): HTMLElement[] => [...(withSaid ? said('buy') : []),
  el('p', { textContent: t('A payment made in this browser is still being set up. The prices come back once it is, so it is not paid twice.') }),
  el('p', { class: 'actions' }, el('button', { type: 'button', id: 'plus-paid-again', disabled: state.busy !== '', textContent: t('Try again'), onclick: () => { void completed(pending.id, 'retry'); } }))];

/** The price buttons, or why there are none yet. */
function buySection(): HTMLElement {
  const box = el('section', { class: 'buy' });
  if (!plusOnSale()) {
    // The monthly price is written before the sale opens (Karl, 2026-11-20: $10 a month), so the page says what Plus will cost, as Paddle's
    // review of the site asks; no button until the checkout exists.
    box.append(el('h2', { textContent: t('Not on sale yet') }));
    if (PADDLE.monthly.usd > 0) box.append(el('p', { class: 'price-soon' }, el('b', { textContent: t('{price} a month', { price: money(PADDLE.monthly.usd) }) })), el('p', { textContent: t('Plus is being set up, and the checkout opens on this page soon. Prices are before tax.') }));
    else box.append(el('p', { textContent: t('Plus is being set up. This page will carry its price and the checkout when it opens.') }));
    return box;
  }
  const pending = paid.list()[0];
  if (pending) {
    box.append(el('h2', { textContent: t('Get Plus') }), ...pendingNote(pending));
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

/** What this browser holds: whether Plus is on, until when, and the key; and a payment still waiting here when no prices are drawn (`buying`). */
function memberSection(buying: boolean): HTMLElement {
  const box = el('section', { class: 'member' }), until = member.until, key = member.key ?? '', stands = member.state, renews = member.renews;
  // Shown in clear only for the key Reveal was pressed for (or a checkout or restore issued): another key in its place is masked again.
  const shown = keyShownFor(state.shown, member.key);
  const keyText = el('code', { class: 'key', textContent: shown ? key : '•'.repeat(24) });
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
      el('button', { type: 'button', id: 'plus-reveal', textContent: shown ? t('Hide') : t('Reveal'), onclick: () => { state.shown = shown ? null : key || null; render(); } }),
      el('button', { type: 'button', id: 'plus-copy', textContent: t('Copy'), onclick: () => { if (!navigator.clipboard) { copied.textContent = t('Could not copy: show the key and copy it by hand.'); return; } void navigator.clipboard.writeText(key).then(() => { copied.textContent = t('Copied'); }, () => { copied.textContent = t('Could not copy: show the key and copy it by hand.'); }); } }), copied),
    // A key the server has ended opens nothing anywhere; a membership that does not renew (a gift, one already ended at Paddle) has no
    // subscription to end.
    ...(stands !== 'ended' ? [el('p', { class: 'fine', textContent: t('The key is your Plus on your other devices too: open this page there and enter it. Keep it to yourself.') })] : []),
    el('p', { class: 'actions' }, ...(stands === 'ended' || renews === false ? [] : PADDLE.portal ? [link(PADDLE.portal, t('End the subscription or change the card'))] : [el('span', { class: 'fine', textContent: t('To end the subscription or change the card, use the link in your receipt from Paddle.') })]), remove),
  );
  // The thanks after a checkout, for its own key; a payment made here whose Plus is not set up (the membership changed while it was) is said
  // beside the membership with its Try again, thanks or not (when no prices are drawn: they say it where they would be).
  const beside = besideMembership(state.fresh, member.key, buying ? [] : paid.list());
  if (beside.thanks) box.append(...said('buy'), el('p', { class: 'actions' }, el('a', { class: 'go', href: '../', textContent: t('Open the map') })));
  if (beside.waiting) box.append(...pendingNote(beside.waiting, !beside.thanks));
  return box;
}

/**
 * The key box: the app's own key form (`key.ts`: masked as it is typed or pasted, Reveal to check it, an answer taken only for the membership
 * it was sent under). One form, kept through every drawing of the page so that what is typed, a key being checked and what the server said
 * survive an answer or another tab; a fresh one each time the box comes back (Plus ended, or was removed), so nothing it said before stays.
 */
let keyBox: KeyEntry = newKeyBox(), keyBoxOut = false;
function newKeyBox(): KeyEntry {
  // A key that opened Plus here settles the payments that were waiting when it was sent, as the receipt's form does (`keySettling`): the
  // visitor chose the membership to keep. A payment made meanwhile keeps waiting.
  return keyEntry({ activate: (text, deps) => keySettling(text, { ...deps, paid }), onSuccess: outcome => { state.unkept = !outcome.kept; render(); arrived('key'); } });
}

/** Bringing Plus to this device: the key, or the receipt's email and invoice number. */
function deviceSection(): HTMLElement {
  if (keyBoxOut) { keyBox.destroy(); keyBox = newKeyBox(); keyBoxOut = false; }
  const email = el('input', { type: 'email', id: 'plus-email', autocomplete: 'email', placeholder: t('Email you paid with'), value: state.typed.email, oninput: () => { state.typed.email = email.value; } });
  const invoice = el('input', { type: 'text', id: 'plus-invoice', autocomplete: 'off', spellcheck: false, placeholder: t('Invoice number'), value: state.typed.invoice, oninput: () => { state.typed.invoice = invoice.value; } });
  email.setAttribute('aria-label', t('Email you paid with')); invoice.setAttribute('aria-label', t('Invoice number'));
  const busy = state.busy !== '';
  const restoreForm = el('form', { class: 'row' }, email, invoice, el('button', { type: 'submit', id: 'plus-find-go', disabled: busy, textContent: state.busy === 'restore' ? t('Looking…') : t('Find my Plus') }));
  restoreForm.onsubmit = event => { event.preventDefault(); void restore(email.value, invoice.value); };
  // A key opens Plus whether or not it is on sale (a key given as a gift); finding one by the receipt needs a sale to have happened.
  return el('section', { class: 'device' },
    el('h2', { textContent: t('Already have Plus?') }),
    el('p', { textContent: t('Enter your key to use Plus in this browser.') }), keyBox.root,
    ...(plusOnSale() ? [el('p', { textContent: t('No key at hand? The email you paid with and the invoice number on your receipt bring it back.') }), restoreForm, ...said('restore'),
      el('p', { class: 'fine', textContent: t('What you type here is sent to this site\'s server to find your subscription; it asks Paddle, which sold it, about the invoice number.') })] : []));
}

/** The page drawn afresh, through the countdown (`redraw`), which tells a scroll the drawing makes from the visitor's. */
function render(): void { activity.redraw(drawPage); }

function drawPage(): void {
  const stands = member.state;
  onPill.hidden = stands !== 'on'; cta.hidden = stands === 'on';
  cta.textContent = plusOnSale() ? t('Get Plus') : t('Activate a key');
  // Reveal and the showing after a checkout or a restore hold for their own key only: another key in its place starts masked. The thanks
  // after a checkout go the same way.
  if (state.shown !== null && state.shown !== member.key) state.shown = null;
  if (state.fresh !== null && state.fresh.key !== member.key) state.fresh = null;
  // Nothing is sold to a browser whose membership is in force or still being checked: only where there is none, or the server ended it
  // (a key replaced by newer ones belongs to a subscription that may well be paid: the receipt brings Plus back, not a second purchase).
  const buying = stands === 'none' || (stands === 'ended' && member.why !== 'replaced');
  // The page is drawn afresh: what had the focus (a field being typed in, a button just pressed) gets it back, the caret where it was.
  const active = document.activeElement instanceof HTMLElement && rest.contains(document.activeElement) ? document.activeElement : null;
  const at = active instanceof HTMLInputElement ? [active.selectionStart, active.selectionEnd] as const : null;
  const focus = active?.id ? { id: active.id, at } : null;
  rest.replaceChildren(
    ...(stands !== 'none' ? [memberSection(buying)] : []),
    ...(buying ? [buySection()] : []),
    ...(stands !== 'on' ? [deviceSection()] : []),
  );
  // The key box left the page (Plus is on): the next time it comes back, it comes back as a fresh form.
  if (!keyBox.root.isConnected) keyBoxOut = true;
  // What stays free and the page's foot never change: drawn once, under the rest.
  if (!foot.childElementCount) foot.append(trust(), el('footer', {},
      el('p', {}, link('../', t('Open the map')), ' · ', link(`../${LEGAL.terms}`, t('Terms')), ' · ', link(`../${LEGAL.privacy}`, t('Privacy')), ' · ', link(`../${LEGAL.refunds}`, t('Refunds'))),
      el('p', { class: 'fine' }, t('Questions about the page: {email}. Questions about a payment go to Paddle, which sold it: paddle.net.', { email: PLUS_CONTACT }))));
  // A control kept through the drawing (the key box's) is the same element, with or without an id; one drawn anew is found by its id.
  const again = active && rest.contains(active) ? active : focus ? document.getElementById(focus.id) : null;
  if (again && rest.contains(again) && document.activeElement !== again) {
    again.focus({ preventScroll: true });
    if (at && again instanceof HTMLInputElement) { try { again.setSelectionRange(at[0], at[1]); } catch { /* an email field has no caret to set */ } }
  }
}

member.subscribe(render);
render();
// A payment made here and not set up yet is asked for again while nothing changed since its checkout (the same membership, no answer for it
// dropped); else it waits for its Try again (`pendingNote`). Each is given up a day after its checkout.
{ const ready = paid.list().find(p => planPayment(p.id, 'resume', { member, paid }).kind === 'ask'); if (ready) void completed(ready.id, 'resume'); }
// How far back the history goes, for the first line of what Plus adds (the public index says).
const urls = historyUrls(LIQ_LEVELS_URL);
if (urls) void fetch(urls.index).then(answer => answer.ok ? answer.json() : null).then((raw: unknown) => {
  const first = readIndex(raw)?.first ?? null;
  if (first !== null && first !== state.first) { state.first = first; feats.setFirst(first); }
}).catch(() => { /* the line without a date stands */ });
