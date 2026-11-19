import { el } from '../dom.ts';
import { togglePanel, type Panel } from '../ui.ts';
import { lazy } from '../lazy.ts';
import { t } from '../i18n.ts';
import { PLUS_NAME } from './name.ts';
import { plus, type Plus, type PlusState } from './pass.ts';
import { keyEntry, maskKey, offlineText, onText, plusDate, type KeyEntry } from './key.ts';

export { PLUS_NAME };

/** What the toolbar's Plus button opens: a browser without a key gets the presentation, one with a key (on, ended or being checked) its status. */
export const plusButtonAction = (state: PlusState): 'sheet' | 'status' => state === 'none' ? 'sheet' : 'status';

/**
 * The status pop-up's own state: what is open in it (a key field to replace the key, the confirmation of Remove), and which key Reveal
 * was pressed for (`revealed`: a key another tab puts in its place is masked again until Reveal is pressed for it).
 */
export interface PopUi { mode: 'idle' | 'replace' | 'confirm'; revealed: string | null; removed: boolean }
export type PopAction = 'replace' | 'remove' | 'remove-yes' | 'remove-no' | 'cancel' | 'retry';
/** What the pop-up shows for a membership and its own state. */
export interface PopView {
  /** The first line: its tone (a check, a spinner, a warning, plain) and words; null for none. */
  status: { tone: 'ok' | 'checking' | 'error' | 'plain'; text: string } | null;
  /** The key as shown (masked until Reveal is pressed for it) with Reveal and Copy beside it, while Plus is on; else null. */
  key: string | null;
  /** The buttons under it, in order. */
  actions: PopAction[];
  /** The confirmation's words while Remove waits for its answer. */
  confirm: string | null;
  /** A key field: an ended membership's, Replace key's, or one for a browser whose key was just removed. */
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
    return { status: { tone: 'ok', text: onText(m.until) }, key: m.key ? (ui.revealed !== null && ui.revealed === m.key ? m.key : maskKey(m.key)) : null, actions,
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

/**
 * What a press does to the pop-up's state, and to the membership (`forget`: the key leaves this browser; `retry`: ask the server again now).
 * Reveal is pressed for `key`, the key shown: pressed again (or for another key) it masks.
 */
export function popPress(ui: PopUi, action: PopAction | 'reveal', key: string | null = null): { ui: PopUi; effect: 'forget' | 'retry' | null } {
  switch (action) {
    case 'reveal': return { ui: { ...ui, revealed: ui.revealed !== null && ui.revealed === key ? null : key }, effect: null };
    case 'replace': return { ui: { ...ui, mode: 'replace' }, effect: null };
    case 'remove': return { ui: { ...ui, mode: 'confirm' }, effect: null };
    case 'remove-no': case 'cancel': return { ui: { ...ui, mode: 'idle' }, effect: null };
    case 'remove-yes': return { ui: { mode: 'idle', revealed: null, removed: true }, effect: 'forget' };
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
 * Show what Plus adds: the presentation sheet (plus/sheet-entry.ts: the sheet, its styles and the demo), fetched the first time it opens, never with the page; the
 * focus goes back to `opener` when it closes. A file that cannot be fetched (a deploy since the tab opened) is said by `lazy`.
 */
export function seePlus(opener: HTMLElement): void {
  void lazy(() => import('./sheet-entry.ts')).then(sheet => { sheet?.openSheet(opener); });
}

const LABELS: Record<PopAction, () => string> = {
  replace: () => t('Replace key'), remove: () => t('Remove from this browser'), 'remove-yes': () => t('Remove'), 'remove-no': () => t('Keep'), cancel: () => t('Cancel'), retry: () => t('Try again'),
};

/** What the status pop-up works with: the membership, how it is drawn again and closed, what See what Plus adds opens, the clipboard, the key form. */
export interface PopDeps {
  member: Pick<Plus, 'state' | 'until' | 'key' | 'unverified' | 'forget' | 'retry' | 'subscribe'>;
  /** Draw the pop-up again (the panel's `render`, which gives the keyboard back to the control with the same `data-focus`). */
  redraw(): void;
  close(): void;
  see(): void;
  copy?: (key: string) => Promise<'copied' | 'select'>;
  entry?: (o: { onSuccess: () => void }) => KeyEntry;
}
export interface StatusPop {
  /** Draw it into `body` (the panel's, emptied by the panel). */
  build(body: HTMLElement): void;
  /** Give the keyboard its first control (the pop-up just opened). */
  focusFirst(body: HTMLElement): void;
  /** It closed: its listener, a pending copy and a key being checked are given up. */
  destroy(): void;
}

/**
 * The status pop-up's contents and behaviour, apart from the panel it is shown in. It keeps one key form while it is shown, through every
 * redraw (what is typed in it and a key being checked stay); Reveal holds for the key it was pressed for; a clipboard answer that comes after
 * Hide, another key or the pop-up's closing is dropped; a press that moves the keyboard says where.
 */
export function createStatusPop(deps: PopDeps): StatusPop {
  const member = deps.member, copy = deps.copy ?? (key => copyKey(key));
  let ui: PopUi = { mode: 'idle', revealed: null, removed: false };
  let hint = '', hintFor: string | null = null, copiedUntil = 0, copies = 0, focusNext: string | null = null, gone = false;
  let lastKey = member.key, entry: { kind: 'replace' | 'ended' | 'none'; form: KeyEntry } | null = null;
  const timers = new Set<number>();
  const later = (ms: number, run: () => void): void => { const id = window.setTimeout(() => { timers.delete(id); if (!gone) run(); }, ms); timers.add(id); };
  const dropEntry = (): void => { entry?.form.destroy(); entry = null; };
  const redraw = (): void => { if (!gone) deps.redraw(); };
  const off = member.subscribe(redraw);
  const press = (action: PopAction | 'reveal'): void => {
    const next = popPress(ui, action, member.key);
    // Hide, or anything that changes what is shown, makes a copy still under way say nothing when it ends.
    if (action === 'reveal' && next.ui.revealed === null) { copies++; hint = ''; }
    ui = next.ui;
    if (action !== 'reveal') hint = '';
    focusNext = action === 'remove' ? 'remove-no' : action === 'remove-no' ? 'remove' : action === 'cancel' ? 'replace' : action === 'remove-yes' ? 'see' : action === 'replace' ? 'key-in' : null;
    if (action === 'cancel') dropEntry();
    if (next.effect === 'forget') member.forget();
    else if (next.effect === 'retry') member.retry();
    redraw();
  };
  const build = (body: HTMLElement): void => {
    // Another key came in (another tab, a key replaced here): what was revealed, said or asked about the old one goes.
    if (member.key !== lastKey) {
      // The key entered in Replace key, or another tab's: said, and the keyboard goes to Replace key (its field is gone).
      const replaced = ui.mode === 'replace' && member.state === 'on';
      lastKey = member.key; copies++; hint = ''; hintFor = null; copiedUntil = 0;
      if (ui.mode !== 'idle') ui = { ...ui, mode: 'idle' };
      if (entry?.kind === 'replace') dropEntry();
      if (replaced) { hint = t('Key replaced.'); hintFor = member.key; focusNext = 'replace'; }
    }
    const view = popView({ state: member.state, until: member.until, key: member.key, unverified: member.unverified }, ui);
    const parts: HTMLElement[] = [];
    if (view.status) {
      const mark = view.status.tone === 'checking' ? el('span', { class: 'spin', ariaHidden: 'true' }) : view.status.tone === 'plain' ? null : el('span', { class: 'pp-mark', ariaHidden: 'true' });
      parts.push(el('p', { class: `pp-status ${view.status.tone}`, role: 'status' }, ...(mark ? [mark] : []), el('span', { textContent: view.status.text })));
    }
    if (view.key !== null) {
      const shown = ui.revealed !== null && ui.revealed === member.key;
      const box = el('input', { type: 'text', class: 'pp-key', readOnly: true, value: view.key, ariaLabel: shown ? t('Your key') : t('Your key, hidden') });
      box.dataset.focus = 'key';
      const reveal = el('button', { type: 'button', class: 'pp-small', textContent: shown ? t('Hide') : t('Reveal'), onclick: () => press('reveal') });
      reveal.dataset.focus = 'reveal'; reveal.setAttribute('aria-pressed', String(shown));
      const copyButton = el('button', { type: 'button', class: 'pp-small', textContent: Date.now() < copiedUntil ? t('Copied') : t('Copy') });
      copyButton.dataset.focus = 'copy';
      copyButton.onclick = () => {
        const key = member.key ?? '', ticket = ++copies;
        void copy(key).then(result => {
          // Given up meanwhile: Hide, another key, the pop-up closed.
          if (gone || ticket !== copies || member.key !== key) return;
          if (result === 'copied') { copiedUntil = Date.now() + 1_600; later(1_650, redraw); redraw(); return; }
          // No clipboard here: the key shown and selected in its field, for the person to copy.
          ui = { ...ui, revealed: key }; hint = t('Key selected. Copy it now.'); hintFor = key; focusNext = 'key'; redraw();
        });
      };
      parts.push(el('div', { class: 'pp-keybox' }, el('p', { class: 'pp-label', textContent: t('Your key') }), el('div', { class: 'pp-keyrow' }, box, reveal, copyButton),
        el('p', { class: 'pp-hint', role: 'status', textContent: hintFor === member.key ? hint : '' })));
    }
    const buttons = (list: PopAction[]): HTMLElement[] => list.map(action => {
      const b = el('button', { type: 'button', class: `pp-small${action === 'remove-yes' ? ' danger' : ''}`, textContent: LABELS[action](), onclick: () => press(action) });
      b.dataset.focus = action;
      return b;
    });
    // One key form while it is wanted, kept through every redraw: its field, its answer and a key being checked stay.
    const want = view.entry ? (member.state === 'on' ? 'replace' : member.state === 'ended' ? 'ended' : 'none') : null;
    if (entry && entry.kind !== want) dropEntry();
    if (want && !entry) {
      const form = (deps.entry ?? (o => keyEntry(o)))({ onSuccess: () => { if (want === 'replace') { ui = { ...ui, mode: 'idle', revealed: null }; hint = t('Key replaced.'); hintFor = member.key; focusNext = 'replace'; dropEntry(); redraw(); } } });
      entry = { kind: want, form };
    }
    if (view.confirm) {
      const id = 'pp-confirm-text';
      const box = el('div', { class: 'pp-confirm', role: 'group' }, el('p', { id, textContent: view.confirm }), el('div', { class: 'pp-actions' }, ...buttons(view.actions)));
      box.setAttribute('aria-labelledby', id);
      parts.push(box);
    } else if (entry?.kind === 'replace') {
      parts.push(el('div', { class: 'pp-replace' }, entry.form.root, el('div', { class: 'pp-actions' }, ...buttons(view.actions))));
    } else {
      if (entry) parts.push(entry.form.root);
      if (view.actions.length) parts.push(el('div', { class: 'pp-actions' }, ...buttons(view.actions)));
    }
    const see = el('button', { type: 'button', class: 'pp-see', onclick: () => { deps.close(); deps.see(); } }, el('span', { textContent: t('See what Plus adds') }), el('span', { class: 'pp-arrow', ariaHidden: 'true', textContent: '→' }));
    see.dataset.focus = 'see';
    body.replaceChildren(...parts, el('div', { class: 'pp-foot' }, see));
    // A press that moves the keyboard (Remove to Keep, Keep back to Remove, a key replaced to Replace key): after the panel's own keeping.
    const to = focusNext;
    focusNext = null;
    if (to) queueMicrotask(() => {
      const target = body.querySelector<HTMLElement>(`[data-focus="${to}"]`);
      if (!target || !target.isConnected) return;
      target.focus({ preventScroll: true });
      if (to === 'key' && target instanceof HTMLInputElement && hint) target.select();
    });
  };
  return {
    build,
    focusFirst: body => { body.querySelector<HTMLElement>('[data-focus]')?.focus({ preventScroll: true }); },
    destroy: () => { gone = true; copies++; off(); dropEntry(); for (const id of timers) window.clearTimeout(id); timers.clear(); },
  };
}

/** The keyboard back on `anchor` when a closed pop-up took it along (the focus was in it, so it is now nowhere): never taken from elsewhere. */
export function restoreFocus(anchor: HTMLElement): void {
  const active = document.activeElement;
  if ((!active || active === document.body) && anchor.isConnected) anchor.focus({ preventScroll: true });
}

/** The status pop-up by the toolbar's Plus button (a browser with a key): its contents (`createStatusPop`) in a panel, the keyboard in and back out. */
function toggleStatus(anchor: HTMLElement): Panel | null {
  const member = plus();
  let panel: Panel | null = null;
  const draw = (_tools: HTMLElement, body: HTMLElement): void => { body.classList.add('pp-body'); pop.build(body); };
  const pop = createStatusPop({ member, redraw: () => { panel?.render(draw); }, close: () => { panel?.close(); }, see: () => { seePlus(anchor); } });
  panel = togglePanel(anchor, { title: PLUS_NAME, width: 340, align: 'right', onClose: () => { pop.destroy(); restoreFocus(anchor); } }, draw);
  if (!panel) { pop.destroy(); return null; }
  pop.focusFirst(panel.body);
  // A membership being checked: the pop-up asks the server once more as it opens (at most once a minute, `renew`).
  if (member.state === 'checking') member.renew();
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
