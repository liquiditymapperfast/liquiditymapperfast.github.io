import { el } from '../dom.ts';
import { togglePanel, type Panel } from '../ui.ts';
import { lazy } from '../lazy.ts';
import { t } from '../i18n.ts';
import { PLUS_NAME } from './name.ts';
import { plus, type PlusState } from './pass.ts';
import { keyEntry, maskKey, offlineText, onText, plusDate, type KeyEntry } from './key.ts';

export { PLUS_NAME };

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

/**
 * Show what Plus adds: the presentation sheet (plus/sheet.ts), fetched with its styles the first time it opens, never with the page; the
 * focus goes back to `opener` when it closes. A file that cannot be fetched (a deploy since the tab opened) is said by `lazy`.
 */
export function seePlus(opener: HTMLElement): void {
  void lazy(() => import('./sheet.ts')).then(sheet => { sheet?.openSheet(opener); });
}

const LABELS: Record<PopAction, () => string> = {
  replace: () => t('Replace key'), remove: () => t('Remove from this browser'), 'remove-yes': () => t('Remove'), 'remove-no': () => t('Keep'), cancel: () => t('Cancel'), retry: () => t('Try again'),
};

/** The status pop-up by the toolbar's Plus button (a browser with a key), drawn afresh on every change of the membership while it is open. */
function toggleStatus(anchor: HTMLElement): Panel | null {
  const member = plus();
  let ui: PopUi = { mode: 'idle', revealed: false, removed: false }, hint = '', focus: string | null = null, off: (() => void) | null = null;
  /** The key forms drawn last: a redraw, Cancel or the pop-up closing gives their checks up (their answers are never taken). */
  let forms: KeyEntry[] = [];
  const dropForms = (): void => { for (const f of forms) f.destroy(); forms = []; };
  let panel: Panel | null = null, lastKey = member.key;
  const draw = (_tools: HTMLElement, body: HTMLElement): void => {
    dropForms();
    // Another key came in (the one just entered in Replace key, or another tab's): Replace key and Remove's question were about the old one.
    if (member.key !== lastKey) {
      const replaced = ui.mode === 'replace' && member.state === 'on';
      lastKey = member.key; ui = { ...ui, mode: 'idle', revealed: false }; hint = replaced ? t('Key replaced.') : '';
      if (replaced) focus = 'replace';
    }
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
      forms.push(entry);
      parts.push(el('div', { class: 'pp-replace' }, entry.root, el('div', { class: 'pp-actions' }, ...buttons(view.actions))));
      focus ??= 'entry';
      if (focus === 'entry') { focus = null; queueMicrotask(() => entry.input.focus({ preventScroll: true })); }
    } else {
      if (view.entry) { const entry = keyEntry(); forms.push(entry); parts.push(entry.root); }
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
  panel = togglePanel(anchor, { title: PLUS_NAME, width: 340, align: 'right', onClose: () => { off?.(); off = null; dropForms(); } }, draw);
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
  if (plusButtonAction(plus().state) === 'sheet') { seePlus(anchor); return; }
  toggleStatus(anchor);
}

/**
 * A lock on the page (a Plus choice without Plus: the levels control's, the Depth pane's older history): the presentation of what Plus adds,
 * opened from `anchor`, whose access card takes a key. It changes nothing on the page.
 */
export function togglePlus(anchor: HTMLElement): void { seePlus(anchor); }
