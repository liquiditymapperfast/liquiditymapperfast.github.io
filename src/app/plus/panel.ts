import { el } from '../dom.ts';
import { togglePanel, type Panel } from '../ui.ts';
import { showGuide } from '../help.ts';
import { t } from '../i18n.ts';
import { FREE_DAYS, PLUS_PAGE, plusOnSale } from './config.ts';
import { PLUS_NAME } from './name.ts';
import { plus, type PlusState } from './pass.ts';
import { keyEntry, maskKey, offlineText, onText, plusDate } from './key.ts';

export { PLUS_NAME };

/** The Plus page beside the app, wherever the app is served from. */
export const plusPageUrl = (): string => new URL(PLUS_PAGE, location.href.replace(/[?#].*$/, '')).href;

/** What the toolbar's Plus button opens: a browser without a key gets the presentation, one with a key (on, ended or being checked) its status. */
export const plusButtonAction = (state: PlusState): 'sheet' | 'status' => state === 'none' ? 'sheet' : 'status';

/** The status pop-up's own state: what is open in it (a key field to replace the key, the confirmation of Remove), the key shown or masked. */
export interface PopUi { mode: 'idle' | 'replace' | 'confirm'; revealed: boolean; removed: boolean }
export type PopAction = 'replace' | 'remove' | 'remove-yes' | 'remove-no' | 'cancel' | 'retry';
/** What the pop-up shows for a membership and its own state. */
export interface PopView {
  /** The first line: its tone (a check, a spinner, a warning, plain) and words; null for none. */
  status: { tone: 'ok' | 'checking' | 'error' | 'plain'; text: string } | null;
  /** The key as shown (masked until Reveal) with Reveal and Copy beside it, while Plus is on; else null. */
  key: string | null;
  /** The buttons under it, in order. */
  actions: PopAction[];
  /** The confirmation's words while Remove waits for its answer. */
  confirm: string | null;
  /** A key field: an ended membership's, or Replace key's. */
  entry: boolean;
}

/**
 * The pop-up for where the membership stands. On: until when, the key (masked; Reveal, Copy), Replace key, Remove from this browser (which
 * asks first: it does not cancel a subscription). Ended: when, that everything free stays, and a key field. Being checked: the check, or
 * once a renewal could not reach the server, that Plus could not be verified, with Try again (never "ended": only the server's refusal
 * ends a membership). None: the key was just removed here.
 */
export function popView(m: { state: PlusState; until: number | null; key: string | null; unverified: boolean }, ui: PopUi): PopView {
  if (m.state === 'on') {
    const actions: PopAction[] = ui.mode === 'confirm' ? ['remove-yes', 'remove-no'] : ui.mode === 'replace' ? ['cancel'] : ['replace', 'remove'];
    return { status: { tone: 'ok', text: onText(m.until) }, key: m.key ? (ui.revealed ? m.key : maskKey(m.key)) : null, actions,
      confirm: ui.mode === 'confirm' ? t('Remove your key from this browser? This doesn\'t cancel a subscription.') : null, entry: ui.mode === 'replace' };
  }
  if (m.state === 'ended') {
    return { status: { tone: 'plain', text: m.until ? t('Plus ended on {date}. Everything free stays.', { date: plusDate(m.until) }) : t('Plus has ended in this browser. Everything free stays.') }, key: null, actions: [], confirm: null, entry: true };
  }
  if (m.state === 'checking') {
    return m.unverified ? { status: { tone: 'error', text: offlineText() }, key: null, actions: ['retry'], confirm: null, entry: false }
      : { status: { tone: 'checking', text: t('Checking Plus with the server…') }, key: null, actions: [], confirm: null, entry: false };
  }
  return { status: ui.removed ? { tone: 'ok', text: t('Key removed from this browser.') } : null, key: null, actions: [], confirm: null, entry: !ui.removed };
}

/** What a press does to the pop-up's state, and to the membership (`forget`: the key leaves this browser; `retry`: ask the server again now). */
export function popPress(ui: PopUi, action: PopAction | 'reveal'): { ui: PopUi; effect: 'forget' | 'retry' | null } {
  switch (action) {
    case 'reveal': return { ui: { ...ui, revealed: !ui.revealed }, effect: null };
    case 'replace': return { ui: { ...ui, mode: 'replace' }, effect: null };
    case 'remove': return { ui: { ...ui, mode: 'confirm' }, effect: null };
    case 'remove-no': case 'cancel': return { ui: { ...ui, mode: 'idle' }, effect: null };
    case 'remove-yes': return { ui: { mode: 'idle', revealed: false, removed: true }, effect: 'forget' };
    case 'retry': return { ui, effect: 'retry' };
  }
}

/**
 * Copy the key: to the clipboard where the browser allows it (`copied`), else the pop-up shows the key selected in its field for the person
 * to copy (`select`), as a browser without clipboard access, or one that refuses it, leaves no other way.
 */
export async function copyKey(key: string, clipboard: Pick<Clipboard, 'writeText'> | undefined = typeof navigator === 'undefined' ? undefined : navigator.clipboard): Promise<'copied' | 'select'> {
  if (!clipboard || typeof clipboard.writeText !== 'function') return 'select';
  try { await clipboard.writeText(key); return 'copied'; } catch { return 'select'; }
}

/** The presentation sheet, opened from `opener` (the focus goes back there when it closes). Set by the sheet's module once it can open. */
let present: ((opener: HTMLElement) => void) | null = null;
/** Show what Plus adds: the presentation sheet, or until it exists the Guide's section. */
function seePlus(opener: HTMLElement): void { if (present) present(opener); else showGuide('plus'); }
/** The sheet's module tells the pop-up how to open it. */
export function presentWith(open: (opener: HTMLElement) => void): void { present = open; }

const LABELS: Record<PopAction, () => string> = {
  replace: () => t('Replace key'), remove: () => t('Remove from this browser'), 'remove-yes': () => t('Remove'), 'remove-no': () => t('Keep'), cancel: () => t('Cancel'), retry: () => t('Try again'),
};

/** The status pop-up by the toolbar's Plus button (a browser with a key), drawn afresh on every change of the membership while it is open. */
function toggleStatus(anchor: HTMLElement): Panel | null {
  const member = plus();
  let ui: PopUi = { mode: 'idle', revealed: false, removed: false }, hint = '', focus: string | null = null, off: (() => void) | null = null;
  let panel: Panel | null = null;
  const draw = (_tools: HTMLElement, body: HTMLElement): void => {
    body.classList.add('pp-body');
    // Drawn afresh (a press, a change of the membership): the control that had the focus gets it back where nothing else is asked for.
    const had = document.activeElement instanceof HTMLElement && body.contains(document.activeElement) ? document.activeElement.dataset.f ?? null : null;
    const view = popView({ state: member.state, until: member.until, key: member.key, unverified: member.unverified }, ui);
    const press = (action: PopAction | 'reveal'): void => {
      const next = popPress(ui, action);
      ui = next.ui; hint = '';
      focus = action === 'remove' ? 'remove-no' : action === 'remove-no' ? 'remove' : action === 'cancel' ? 'replace' : action === 'remove-yes' ? 'see' : action === 'reveal' ? 'reveal' : action === 'retry' ? null : null;
      if (next.effect === 'forget') member.forget();
      else if (next.effect === 'retry') member.retry();
      redraw();
    };
    const parts: HTMLElement[] = [];
    if (view.status) {
      const mark = view.status.tone === 'checking' ? el('span', { class: 'spin', ariaHidden: 'true' }) : view.status.tone === 'plain' ? null : el('span', { class: 'pp-mark', ariaHidden: 'true' });
      parts.push(el('p', { class: `pp-status ${view.status.tone}`, role: 'status' }, ...(mark ? [mark] : []), el('span', { textContent: view.status.text })));
    }
    if (view.key !== null) {
      const box = el('input', { type: 'text', class: 'pp-key', readOnly: true, value: view.key, ariaLabel: ui.revealed ? t('Your key') : t('Your key, hidden') });
      box.dataset.f = 'key';
      const reveal = el('button', { type: 'button', class: 'pp-small', textContent: ui.revealed ? t('Hide') : t('Reveal'), onclick: () => press('reveal') });
      reveal.dataset.f = 'reveal'; reveal.setAttribute('aria-pressed', String(ui.revealed));
      const copy = el('button', { type: 'button', class: 'pp-small', textContent: t('Copy') });
      copy.dataset.f = 'copy';
      copy.onclick = () => {
        const key = member.key ?? '';
        void copyKey(key).then(result => {
          if (result === 'copied') { copy.textContent = t('Copied'); window.setTimeout(() => { if (copy.isConnected) copy.textContent = t('Copy'); }, 1600); return; }
          // No clipboard here: the key shown and selected in its field, for the person to copy.
          ui = { ...ui, revealed: true }; hint = t('Key selected. Copy it now.'); focus = 'key'; redraw();
        });
      };
      parts.push(el('div', { class: 'pp-keybox' }, el('p', { class: 'pp-label', textContent: t('Your key') }), el('div', { class: 'pp-keyrow' }, box, reveal, copy),
        el('p', { class: 'pp-hint', role: 'status', textContent: hint })));
    }
    const buttons = (list: PopAction[]): HTMLElement[] => list.map(action => {
      const b = el('button', { type: 'button', class: `pp-small${action === 'remove-yes' ? ' danger' : ''}`, textContent: LABELS[action](), onclick: () => press(action) });
      b.dataset.f = action;
      return b;
    });
    if (view.confirm) {
      const id = 'pp-confirm-text';
      const box = el('div', { class: 'pp-confirm', role: 'group' }, el('p', { id, textContent: view.confirm }), el('div', { class: 'pp-actions' }, ...buttons(view.actions)));
      box.setAttribute('aria-labelledby', id);
      parts.push(box);
    } else if (view.entry && member.state === 'on') {
      // Replace key: a field for the new one, and Cancel.
      const entry = keyEntry({ onSuccess: () => { ui = { ...ui, mode: 'idle', revealed: false }; hint = t('Key replaced.'); focus = 'replace'; redraw(); } });
      parts.push(el('div', { class: 'pp-replace' }, entry.root, el('div', { class: 'pp-actions' }, ...buttons(view.actions))));
      focus ??= 'entry';
      if (focus === 'entry') { focus = null; queueMicrotask(() => entry.input.focus({ preventScroll: true })); }
    } else {
      if (view.entry) parts.push(keyEntry().root);
      if (view.actions.length) parts.push(el('div', { class: 'pp-actions' }, ...buttons(view.actions)));
    }
    const see = el('button', { type: 'button', class: 'pp-see', onclick: () => { panel?.close(); seePlus(anchor); } }, el('span', { textContent: t('See what Plus adds') }), el('span', { class: 'pp-arrow', ariaHidden: 'true', textContent: '→' }));
    see.dataset.f = 'see';
    body.replaceChildren(...parts, el('div', { class: 'pp-foot' }, see));
    const want = focus ?? had;
    focus = null;
    if (want) {
      const target = body.querySelector<HTMLElement>(`[data-f="${want}"]`);
      if (target) { target.focus({ preventScroll: true }); if (target instanceof HTMLInputElement && target.readOnly && hint) target.select(); }
    }
  };
  const redraw = (): void => { panel?.render(draw); };
  panel = togglePanel(anchor, { title: PLUS_NAME, width: 340, align: 'right', onClose: () => { off?.(); off = null; } }, draw);
  if (panel) {
    off = member.subscribe(redraw);
    // A membership being checked: the pop-up asks the server once more as it opens (at most once a minute, `renew`).
    if (member.state === 'checking') member.renew();
  }
  return panel;
}

/**
 * The toolbar's Plus button: a browser without a key gets the presentation of what Plus adds; one with a key, the status pop-up (`popView`).
 */
export function pressPlus(anchor: HTMLElement): void {
  if (plusButtonAction(plus().state) === 'sheet') { openVisitor(anchor); return; }
  toggleStatus(anchor);
}

function tile(label: string, detail: string, go: { href: string } | { run: () => void }): HTMLElement {
  if ('href' in go) return el('a', { class: 'author-link', href: go.href, target: '_blank', rel: 'noopener' }, el('b', { textContent: label }), el('span', { textContent: detail }));
  return el('button', { type: 'button', class: 'author-link plus-tile', onclick: go.run }, el('b', { textContent: label }), el('span', { textContent: detail }));
}

/** Plus for a browser without a key: the presentation sheet where it can open, else what Plus is in three sentences. */
function openVisitor(anchor: HTMLElement): Panel | null {
  if (present) { present(anchor); return null; }
  return togglePanel(anchor, { title: PLUS_NAME, width: 340, align: 'right' }, (_tools, body) => {
    body.classList.add('author-body', 'plus-body');
    body.append(
      el('p', { class: 'lead', textContent: t('Plus opens what this site\'s servers store: the liquidation levels\' whole history (without Plus, the last {n} days), the levels of HyperTracker\'s profitable traders, and the stop and take-profit levels.', { n: FREE_DAYS }) }),
      el('p', { class: 'fine', textContent: t('Everything the page does today stays free. Plus pays for the servers behind it.') }),
      el('div', { class: 'author-links' }, tile(t('What Plus adds'), t('in the Guide, with pictures'), { run: () => { showGuide('plus'); } }),
        plusOnSale() ? tile(t('Get Plus'), t('opens the Plus page'), { href: plusPageUrl() }) : tile(t('Not on sale yet'), t('the Plus page says when'), { href: plusPageUrl() })),
      keyEntry().root,
    );
  });
}

/**
 * A lock on the page (a Plus choice without Plus): what Plus adds, opened from `anchor`. For a browser that holds a key (ended, or being
 * checked) the status pop-up says where it stands and takes a key.
 */
export function togglePlus(anchor: HTMLElement): void {
  if (plus().state === 'none') openVisitor(anchor); else toggleStatus(anchor);
}
