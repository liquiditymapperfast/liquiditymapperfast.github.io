/**
 * The presentation of Plus in the app (the prototype Karl approved, 2026-11-19): a sheet over the page, 880 px wide at most and 90 % of the
 * window's height, the whole screen on a phone. It holds the hero, the demo (the levels control on the demo's own store, never the page's
 * settings), the three feature sections, the access card (a key, or once Plus is on sale the subscription on the site's Plus page) and what
 * stays free. Fetched only when it first opens, with its styles and the demo (plus/sheet-entry.ts). A modal dialog: the page behind it can
 * be neither reached nor read, the keyboard stays inside, Escape and Close give the focus back to what opened it (or, where that is gone,
 * to the toolbar's Plus button). It is a native `<dialog>` shown open, the page's own sign of a dialog on top (`dialog[open]`): the sheets,
 * panels and shortcuts under it leave Escape and their keys to it (Sol, review 2026-11-19: Escape closed the phone's Settings under it too).
 */
import { el } from '../dom.ts';
import { t } from '../i18n.ts';
import { historyUrls, readIndex } from '../liq-history.ts';
import { liqLevelsUrl } from '../liq-url.ts';
import { sheetKey } from './modal.ts';
import { plusOnSale } from './config.ts';
import { PLUS_NAME } from './name.ts';
import { plus, type Plus } from './pass.ts';
import { keyEntry, onText, plusDate, type KeyEntry } from './key.ts';
import { SITE_PLUS, availability, features, hero, legal, trust } from './present.ts';

/** The sheet open now, and how to close it. */
let open: { close(restore: boolean): void } | null = null;
/** Whether the presentation sheet is open. */
export const sheetOpen = (): boolean => open !== null;
/** Close it (Escape and Close give the focus back; anything else that closes it need not). */
export const closeSheet = (restore = false): void => { open?.close(restore); };

/** The first recorded snapshot, once read (the public history index), for the history section's date. */
let first: number | null | undefined;

/**
 * Where a demo goes: the sheet calls `mount` once its opening has started (the demo builds its numbers when it mounts), with the card that
 * hosts it and the three feature pictures' hosts; it returns what stops it. Set by plus/sheet-entry.ts (tests give their own).
 */
export interface DemoMount { (stage: HTMLElement, visuals: { history: HTMLElement; layers: HTMLElement; groups: HTMLElement }): { destroy(): void } }
let mountDemo: DemoMount | null = null;
/** The demo's module gives the sheet its mount (tests give their own). */
export function demoWith(mount: DemoMount | null): void { mountDemo = mount; }

/**
 * Where the keyboard goes when the sheet closes: what opened it, while it is still on the page and shown; else the toolbar's Plus button,
 * else a phone's Settings key (a lock that went away meanwhile, a Settings sheet closed under it). Null where none is shown.
 */
export function focusBack(opener: HTMLElement): HTMLElement | null {
  const shown = (x: HTMLElement | null): x is HTMLElement => !!x && x.isConnected && !x.hidden && x.getClientRects().length > 0;
  return [opener, document.querySelector<HTMLElement>('.toolbar .plus-btn'), document.querySelector<HTMLElement>('.toolbar .more-btn')].find(shown) ?? null;
}

/** Open the presentation sheet from `opener` (the Plus button, a lock, the pop-up's See what Plus adds): its focus comes back there. */
export function openSheet(opener: HTMLElement, member: Pick<Plus, 'state' | 'until' | 'subscribe'> = plus()): void {
  open?.close(false);
  const titleId = 'px-title';
  const close = el('button', { type: 'button', class: 'px-x', ariaLabel: t('Close') }, el('span', { class: 'px-x-mark', ariaHidden: 'true' }), el('span', { class: 'px-x-text', textContent: t('Close') }));
  const onPill = el('span', { class: 'px-pill on', hidden: true }, el('span', { class: 'px-check', ariaHidden: 'true' }), el('span', { textContent: t('Plus is on in this browser') }));
  const cta = el('button', { type: 'button', class: 'px-cta' });
  const feats = features(plusDate);
  if (first !== undefined) feats.setFirst(first);
  const stage = el('section', { class: 'px-stage', ariaLabel: t('Interactive demo') });
  const accessTitle = el('h2', { id: 'px-access-title' });
  const access = el('section', { class: 'px-access', id: 'px-access' });
  access.setAttribute('aria-labelledby', accessTitle.id);
  const body = el('div', { class: 'px-body' }, hero(titleId, onPill, cta), stage, ...feats.root, access, trust(), legal());
  const sheet = el('dialog', { class: 'px-sheet', tabIndex: -1 },
    el('div', { class: 'px-head' }, el('span', { class: 'px-brand' }, el('b', { textContent: PLUS_NAME }), el('span', { textContent: 'LiquidityMapperFast' })), close), body);
  sheet.setAttribute('aria-modal', 'true'); sheet.setAttribute('aria-labelledby', titleId);
  const scrim = el('div', { class: 'px-scrim' }), layer = el('div', { class: 'px-layer' }, scrim, sheet);

  // The access card: its shape (Plus on; a key form, with the subscription where Plus is on sale) drawn when it changes, and what it says of
  // the membership (until when, ended when, being checked) every time it changes. The key form stays while the shape does: what is typed in
  // it and a key being checked are kept (Sol, review 2026-11-19: a checking line outlived the check). It is given up when it goes or the sheet closes.
  let form: KeyEntry | null = null, shape: 'on' | 'sale' | 'gift' | null = null;
  const dropForm = (): void => { form?.destroy(); form = null; };
  const onLine = el('span', {}), standing = el('div', { class: 'px-standing' });
  const drawAccess = (): void => {
    const stands = member.state, sale = plusOnSale(), want = stands === 'on' ? 'on' : sale ? 'sale' : 'gift';
    onPill.hidden = stands !== 'on'; cta.hidden = stands === 'on';
    cta.textContent = sale ? t('Get Plus') : t('Activate a key');
    accessTitle.textContent = stands === 'on' ? t('Your Plus') : t('Get Plus');
    if (want !== shape) {
      shape = want;
      if (want === 'on') {
        dropForm(); access.classList.remove('stack');
        access.replaceChildren(accessTitle, el('p', { class: 'px-status ok', role: 'status' }, el('span', { class: 'px-check', ariaHidden: 'true' }), onLine));
      } else {
        form ??= keyEntry();
        if (want === 'sale') {
          access.classList.add('stack');
          access.replaceChildren(el('div', { class: 'px-offer' }, accessTitle, standing, el('p', { class: 'px-price', textContent: availability() }),
            el('a', { class: 'px-subscribe', href: SITE_PLUS, target: '_blank', rel: 'noopener', textContent: t('Subscribe') })),
          el('div', { class: 'px-key' }, el('h3', { textContent: t('Have a key?') }), form.root));
        } else {
          access.classList.remove('stack');
          access.replaceChildren(el('div', { class: 'px-offer' }, accessTitle, standing, el('p', { class: 'px-muted', textContent: t('Gift keys can be activated now. Purchases aren\'t open yet.') })),
            el('div', { class: 'px-key' }, form.root));
        }
      }
    }
    onLine.textContent = onText(member.until);
    const said = stands === 'ended' ? (member.until ? t('Plus ended on {date}. Everything free stays.', { date: plusDate(member.until) }) : t('Plus has ended in this browser. Everything free stays.'))
      : stands === 'checking' ? t('Checking Plus with the server…') : '';
    if (standing.textContent !== said) standing.replaceChildren(...(said ? [el('p', { class: 'px-muted', role: 'status', textContent: said })] : []));
  };
  drawAccess();
  const off = member.subscribe(drawAccess);
  cta.addEventListener('click', () => {
    access.scrollIntoView({ behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'start' });
    const target = access.querySelector<HTMLElement>(plusOnSale() ? '.px-subscribe' : '.key-in');
    if (target) window.setTimeout(() => target.focus({ preventScroll: true }), 400);
  });

  // Modal: the page behind can be neither reached nor read until the sheet closes (only what this sheet made inert is given back).
  const made: HTMLElement[] = [];
  for (const child of [...document.body.children]) if (child instanceof HTMLElement && !child.inert) { child.inert = true; made.push(child); }
  document.body.append(layer);
  sheet.show();
  const html = document.documentElement, overflow = html.style.overflow;
  html.style.overflow = 'hidden';
  requestAnimationFrame(() => layer.classList.add('in'));
  sheet.focus({ preventScroll: true });

  const focusables = (): HTMLElement[] => [...sheet.querySelectorAll<HTMLElement>('a[href], button, input, select, textarea, [tabindex]:not([tabindex="-1"])')]
    .filter(x => !x.hidden && !(x as HTMLButtonElement).disabled && x.tabIndex >= 0 && x.getClientRects().length > 0);
  const onKey = (event: KeyboardEvent): void => {
    const list = event.key === 'Tab' ? focusables() : [];
    const act = sheetKey(event.key, event.shiftKey, list.indexOf(document.activeElement as HTMLElement), list.length);
    if (act === 'close') { event.preventDefault(); event.stopPropagation(); finish(true); return; }
    if (act) { event.preventDefault(); list[act.focus]?.focus(); }
  };
  // The demo's numbers build when it mounts: after the opening has started, so the sheet comes at once.
  let demo: { destroy(): void } | null = null;
  const mountTimer = window.setTimeout(() => { if (mountDemo && open?.close === finish) demo = mountDemo(stage, feats.hosts); }, 0);
  const finish = (restore: boolean): void => {
    if (open?.close !== finish) return;
    open = null;
    window.clearTimeout(mountTimer); demo?.destroy(); demo = null; off(); dropForm();
    document.removeEventListener('keydown', onKey, true);
    sheet.close(); layer.remove(); html.style.overflow = overflow;
    for (const child of made) child.inert = false;
    if (restore) focusBack(opener)?.focus({ preventScroll: true });
  };
  close.addEventListener('click', () => finish(true));
  scrim.addEventListener('click', () => finish(true));
  document.addEventListener('keydown', onKey, true);
  open = { close: finish };

  // When the history began (the public index, as the Plus page reads it): the history section's date.
  if (first === undefined) {
    const urls = historyUrls(liqLevelsUrl());
    if (urls) void fetch(urls.index).then(r => r.ok ? r.json() : null).then((raw: unknown) => {
      first = readIndex(raw)?.first ?? null;
      feats.setFirst(first);
    }).catch(() => { /* the line without a date stands */ });
  }
}
