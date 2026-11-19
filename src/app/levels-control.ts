/**
 * The levels control (Karl, 2026-11-19, built as the Plus prototype's): what the levels show, as one component in three places: a popover
 * under the liquidation column's button (and the Depth pane's levels button, and the phone's Liq tab title on a wide screen), a bottom sheet
 * on a phone (under 768 px), and the Liq levels panel. Inside it: three switches (liquidations, stops, take profits; one always stays on),
 * Traders (everyone or the profitable traders, radios), a live line saying what the curve adds up, and "How levels work". A change applies at
 * once. Without Plus the paid choices carry a lock and open the Plus panel, changing nothing; the free choices (liquidations, everyone) work.
 * A labelled dialog, not a menu: switches are switches, Traders are radios with arrow keys, Escape closes and gives the focus back.
 */
import type { Store } from './store.ts';
import { el } from './dom.ts';
import { t } from './i18n.ts';
import { setTip } from './tip.ts';
import { togglePlus } from './plus/panel.ts';
import { plus } from './plus/pass.ts';
import { PLUS_NAME } from './plus/name.ts';
import { LIQ_GROUPS, LIQ_PARTS, type LiqGroup, type LiqLevelSettings, type LiqPart } from './liq-url.ts';
import { FREE_VIEW, groupName, heldBack, kindName, levelsSummary, plusOn, type LiqChoice } from './liq-view.ts';
import { curveSentence } from './liq-words.ts';

/** Under this width the control is a bottom sheet; at it and above, a popover. */
export const SHEET_BELOW = 768;
/** The popover's width (px). */
const POP_W = 312, EDGE = 8;

/** Said by the one kind still on, whose switch is disabled. */
export const lastOnTip = (): string => t('One kind stays on. To hide the levels, use Liq levels in the top bar.');
/** Whether a kind is part of Plus: everything but the liquidations. */
export const paidPart = (part: LiqPart): boolean => part !== 'liq';

/** What the control shows: the saved choice with Plus; without it the free view, which is what the page draws. */
export function shownChoice(s: LiqChoice, member: boolean): LiqChoice {
  return member ? { liq: s.liq, stops: s.stops, takes: s.takes, group: s.group } : FREE_VIEW;
}

/** What pressing a kind does: a change of the setting, the Plus panel (a paid kind without Plus: nothing changes), or nothing (the last kind on). */
export function pressPart(s: LiqChoice, part: LiqPart, member: boolean): { change: Partial<LiqLevelSettings> } | 'plus' | 'last' {
  if (!member && paidPart(part)) return 'plus';
  const shown = shownChoice(s, member), on = !shown[part], next = { liq: shown.liq, stops: shown.stops, takes: shown.takes }, change: Partial<LiqLevelSettings> = {};
  next[part] = on; change[part] = on;
  return next.liq || next.stops || next.takes ? { change } : 'last';
}
/** What pressing a group does: a change (the group is every kind's), or the Plus panel (the profitable traders without Plus). */
export function pressGroup(_s: LiqChoice, group: LiqGroup, member: boolean): { change: Partial<LiqLevelSettings> } | 'plus' {
  return !member && group !== 'all' ? 'plus' : { change: { group } };
}

/**
 * Where Tab goes in the sheet, which keeps the focus inside it: from the last control to the first, with Shift from the first to the last, and
 * from anywhere else in the sheet (its own frame) to the first or the last; null where the browser's own step stays inside.
 */
export function trapStep(count: number, index: number, back: boolean): number | null {
  if (count <= 0) return null;
  if (index < 0) return back ? count - 1 : 0;
  if (!back && index >= count - 1) return 0;
  if (back && index === 0) return count - 1;
  return null;
}

const SVG = 'http://www.w3.org/2000/svg';
const svg = <K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string, string | number>): SVGElementTagNameMap[K] => {
  const node = document.createElementNS(SVG, tag);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, String(v));
  return node;
};
/**
 * A kind's line sample, 24 px: two strokes, above the price and below it, in the colours the map draws them in. Liquidations solid with dot
 * ends, stops solid with square ends, take profits dashed (the sells that close longs above, in the falling colour; the buys below).
 */
function sample(part: LiqPart): SVGSVGElement {
  const s = svg('svg', { viewBox: '0 0 24 14', width: 24, height: 14, class: 'lv-sample', 'aria-hidden': 'true' });
  const takes = part === 'takes', top = takes ? 'down' : 'up', bottom = takes ? 'up' : 'down', x0 = takes ? 1 : 5;
  s.append(svg('path', { d: `M${x0} 3.5H23`, class: `lv-ln ${top}${takes ? ' dash' : ''}` }), svg('path', { d: `M${x0} 10.5H23`, class: `lv-ln ${bottom}${takes ? ' dash' : ''}` }));
  if (part === 'liq') s.append(svg('circle', { cx: 3, cy: 3.5, r: 2.2, class: `lv-mk ${top}` }), svg('circle', { cx: 3, cy: 10.5, r: 2.2, class: `lv-mk ${bottom}` }));
  if (part === 'stops') s.append(svg('rect', { x: 0.8, y: 1.3, width: 4.4, height: 4.4, class: `lv-mk ${top}` }), svg('rect', { x: 0.8, y: 8.3, width: 4.4, height: 4.4, class: `lv-mk ${bottom}` }));
  return s;
}

let uid = 0;
export interface LevelsControl {
  readonly root: HTMLElement;
  /** The heading's id, to name the dialog it stands in. */
  readonly headId: string;
  /** Draw it again from the store and the membership (it does so by itself on their changes while it is on the page). */
  sync(): void;
  /** Stop listening (a popover or sheet that closes). */
  destroy(): void;
}
export interface LevelsOptions {
  /** A paid choice pressed without Plus: where the Plus panel opens from (the popover and the sheet close first). */
  locked(from: HTMLElement): void;
  /** A Close button in its heading (the sheet's). */
  close?: () => void;
}

export function createLevelsControl(store: Store, o: LevelsOptions): LevelsControl {
  const id = `lv${++uid}`, headId = `${id}h`, tradersId = `${id}t`, howId = `${id}w`;
  const set = (change: Partial<LiqLevelSettings>): void => { store.set({ liqLevels: { ...store.state.liqLevels, ...change } }); };
  const rows = new Map<LiqPart, { b: HTMLButtonElement; sw: HTMLElement; lock: HTMLElement | null; label: string }>();
  const rowsEl = el('div', { class: 'lv-rows', role: 'group' });
  rowsEl.setAttribute('aria-labelledby', headId);
  // A short-lived line in the foot: the tip of a press that did nothing (a finger has no hover to read the tip by), read out politely.
  const flash = el('p', { class: 'lv-flash', hidden: true });
  flash.setAttribute('aria-live', 'polite');
  let flashTimer = 0;
  const say = (text: string): void => { flash.textContent = text; flash.hidden = false; window.clearTimeout(flashTimer); flashTimer = window.setTimeout(() => { flash.hidden = true; }, 4_000); };
  for (const part of LIQ_PARTS) {
    const label = kindName(part);
    const sw = el('span', { class: 'lv-sw' }), lock = paidPart(part) ? el('span', { class: 'plus-tag locked lv-lock', textContent: PLUS_NAME, hidden: true }) : null;
    sw.setAttribute('aria-hidden', 'true'); lock?.setAttribute('aria-hidden', 'true');
    const b = el('button', { type: 'button', class: 'lv-row' }, sample(part), el('span', { class: 'lv-label', textContent: label }), el('span', { class: 'lv-ctl' }, sw, ...(lock ? [lock] : [])));
    b.dataset.part = part; b.dataset.focus = `lv-${part}`;
    b.addEventListener('click', () => {
      const r = pressPart(store.state.liqLevels, part, plusOn());
      if (r === 'plus') o.locked(b);
      else if (r === 'last') say(lastOnTip());
      else set(r.change);
    });
    rowsEl.append(b); rows.set(part, { b, sw, lock, label });
  }
  const seg = el('div', { class: 'lv-seg' });
  seg.setAttribute('aria-labelledby', tradersId);
  const radios = new Map<LiqGroup, HTMLButtonElement>();
  for (const group of LIQ_GROUPS) {
    const r = el('button', { type: 'button', class: 'lv-radio' }, ...(group !== 'all' ? [el('span', { class: 'plus-tag locked lv-lock', textContent: PLUS_NAME, hidden: true })] : []), el('span', { textContent: groupName(group) }));
    r.dataset.group = group; r.dataset.focus = `lv-${group}`;
    r.addEventListener('click', () => {
      const p = pressGroup(store.state.liqLevels, group, plusOn());
      if (p === 'plus') o.locked(r);
      else set(p.change);
    });
    // Arrow keys move the choice between the two (a radio group: one tab stop), where both can be chosen.
    r.addEventListener('keydown', event => {
      const key = event.key, moves = key === 'ArrowLeft' || key === 'ArrowRight' || key === 'ArrowUp' || key === 'ArrowDown' || key === 'Home' || key === 'End';
      if (!moves || seg.getAttribute('role') !== 'radiogroup') return;
      event.preventDefault();
      const next: LiqGroup = key === 'Home' ? 'all' : key === 'End' ? 'profitable' : group === 'all' ? 'profitable' : 'all';
      const p = pressGroup(store.state.liqLevels, next, plusOn());
      if (typeof p === 'object') { set(p.change); radios.get(next)?.focus(); }
    });
    seg.append(r); radios.set(group, r);
  }
  const sum = el('p', { class: 'lv-sum' });
  sum.setAttribute('aria-live', 'polite');
  const kept = el('p', { class: 'lv-kept', textContent: t('Without Plus the page shows liquidations of all traders. Your choice is kept and comes back with Plus.'), hidden: true });
  // What the curve adds up, and who the profitable traders are.
  const howText = el('div', { class: 'lv-how-text', id: howId, hidden: true }, el('p', { textContent: curveSentence() }),
    el('p', { textContent: t('Profitable traders: the wallets HyperTracker counts as profitable, its four cohorts with a positive all-time perp profit.') }));
  const how = el('button', { type: 'button', class: 'lv-how', textContent: t('How levels work') });
  how.setAttribute('aria-expanded', 'false'); how.setAttribute('aria-controls', howId);
  how.addEventListener('click', () => { howText.hidden = !howText.hidden; how.setAttribute('aria-expanded', String(!howText.hidden)); });
  const closeButton = o.close ? el('button', { type: 'button', class: 'sheet-x lv-close', ariaLabel: t('Close'), tip: t('Close') }) : null;
  if (closeButton && o.close) closeButton.addEventListener('click', o.close);
  const root = el('div', { class: 'lv' },
    el('div', { class: 'lv-head' }, el('h3', { id: headId, textContent: t('Levels') }), ...(closeButton ? [closeButton] : [])),
    rowsEl,
    el('div', { class: 'lv-sec' }, el('p', { class: 'lv-sub', id: tradersId, textContent: t('Traders') }), seg),
    el('div', { class: 'lv-foot' }, sum, kept, flash, how, howText));

  const sync = (): void => {
    const member = plusOn(), saved = store.state.liqLevels, s = shownChoice(saved, member), on = LIQ_PARTS.filter(part => s[part]).length;
    for (const [part, { b, sw, lock, label }] of rows) {
      const locked = !member && !!lock, last = !locked && s[part] && on === 1;
      sw.hidden = locked; if (lock) lock.hidden = !locked;
      b.classList.toggle('locked', locked);
      if (locked) { b.setAttribute('role', 'button'); b.removeAttribute('aria-checked'); b.setAttribute('aria-label', t('{name}, Plus required', { name: label })); }
      else { b.setAttribute('role', 'switch'); b.setAttribute('aria-checked', String(s[part])); b.removeAttribute('aria-label'); }
      if (last) b.setAttribute('aria-disabled', 'true'); else b.removeAttribute('aria-disabled');
      setTip(b, last ? lastOnTip() : null);
    }
    // Locked, the two segments are plain buttons (the free one pressed, the paid one an upgrade); else a radio group with one tab stop.
    const radio = member;
    seg.setAttribute('role', radio ? 'radiogroup' : 'group');
    for (const [group, r] of radios) {
      const chosen = s.group === group, locked = !member && group !== 'all', lock = r.querySelector<HTMLElement>('.lv-lock');
      if (lock) lock.hidden = !locked;
      r.classList.toggle('locked', locked); r.classList.toggle('sel', chosen);
      if (radio) { r.setAttribute('role', 'radio'); r.setAttribute('aria-checked', String(chosen)); r.removeAttribute('aria-pressed'); r.tabIndex = chosen ? 0 : -1; }
      else { r.removeAttribute('role'); r.removeAttribute('aria-checked'); r.setAttribute('aria-pressed', String(chosen)); r.tabIndex = 0; }
      if (locked) r.setAttribute('aria-label', t('{name}, Plus required', { name: groupName(group) })); else r.removeAttribute('aria-label');
    }
    const text = levelsSummary(member ? s : FREE_VIEW);
    if (sum.textContent !== text) sum.textContent = text;
    kept.hidden = !heldBack(saved, member);
  };
  // Told of every change until it is dropped: whoever drops it calls `destroy` (Sol, review 2026-11-19: a guess from being on the page left
  // a panel's controls listening for good).
  const off = controlListeners(store as unknown as Parameters<typeof controlListeners>[0], plus(), sync, sync);
  const destroy = (): void => { off(); window.clearTimeout(flashTimer); };
  sync();
  return { root, headId, sync, destroy };
}

/**
 * The control's two subscriptions (the store, the membership) as one: `destroy` ends both, once. Whoever drops a control calls it (the popover
 * and the sheet as they close, the Liq levels panel as it draws afresh or closes: `holdPanelControl`).
 */
export function controlListeners(store: { subscribe(fn: (state: unknown, changed: Set<string>) => void): () => void }, membership: { subscribe(fn: () => void): () => void },
  onLevels: () => void, onPlus: () => void): () => void {
  const offStore = store.subscribe((_state, changed) => { if (changed.has('liqLevels')) onLevels(); });
  const offPlus = membership.subscribe(onPlus);
  let done = false;
  return () => { if (done) return; done = true; offStore(); offPlus(); };
}

/** The control open as a popover or a sheet, and what it was opened by. */
let opened: { anchor: HTMLElement; close(restore: boolean): void } | null = null;
/** Whether the levels control is open (as a popover or a sheet) from `anchor`, or from anything when none is given. */
export const levelsOpen = (anchor?: HTMLElement): boolean => !!opened && (!anchor || opened.anchor === anchor);
export const closeLevels = (restore = false): void => opened?.close(restore);

/** Open the levels control by `anchor` (a popover; a bottom sheet on a phone), or close it when it is already open from there. */
export function toggleLevels(anchor: HTMLElement, store: Store): void {
  if (opened?.anchor === anchor) { opened.close(true); return; }
  opened?.close(false);
  if (window.innerWidth < SHEET_BELOW) openSheet(anchor, store); else openPopover(anchor, store);
}

/** Where a popover of `size` goes under `a` (window pixels): below it, its left edge on the anchor's, shifted inside the window; above when there is no room below. */
export function popoverPlace(a: { left: number; top: number; bottom: number }, size: { w: number; h: number }, view: { w: number; h: number }): { left: number; top: number } {
  const left = Math.max(EDGE, Math.min(a.left, view.w - EDGE - size.w));
  const below = a.bottom + 6, above = a.top - 6 - size.h;
  return { left, top: below + size.h <= view.h - EDGE || above < EDGE ? Math.max(EDGE, Math.min(below, view.h - EDGE - size.h)) : above };
}

const lockedFrom = (anchor: HTMLElement) => (): void => { opened?.close(false); togglePlus(anchor); };

function openPopover(anchor: HTMLElement, store: Store): void {
  const control = createLevelsControl(store, { locked: () => lockedFrom(anchor)() });
  const pop = el('div', { class: 'lv-pop', role: 'dialog' }, control.root);
  pop.setAttribute('aria-labelledby', control.headId);
  document.body.append(pop);
  const place = (): void => {
    pop.style.width = `${Math.min(POP_W, window.innerWidth - 2 * EDGE)}px`;
    const a = anchor.getBoundingClientRect(), at = popoverPlace(a, { w: pop.offsetWidth, h: pop.offsetHeight }, { w: window.innerWidth, h: window.innerHeight });
    pop.style.left = `${at.left}px`; pop.style.top = `${at.top}px`;
  };
  place();
  const onPointer = (event: PointerEvent): void => { const target = event.target as Node; if (!pop.contains(target) && !anchor.contains(target)) close(false); };
  const onKey = (event: KeyboardEvent): void => { if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(true); } };
  const onResize = (): void => { if (window.innerWidth < SHEET_BELOW) close(false); else place(); };
  const close = (restore: boolean): void => {
    if (opened?.close !== close) return;
    opened = null; control.destroy(); pop.remove(); anchor.setAttribute('aria-expanded', 'false');
    document.removeEventListener('pointerdown', onPointer, true); document.removeEventListener('keydown', onKey, true); window.removeEventListener('resize', onResize);
    if (restore && anchor.isConnected) anchor.focus({ preventScroll: true });
  };
  document.addEventListener('pointerdown', onPointer, true); document.addEventListener('keydown', onKey, true); window.addEventListener('resize', onResize);
  opened = { anchor, close };
  anchor.setAttribute('aria-expanded', 'true');
  // The keyboard goes on into it: its first control that takes a press.
  pop.querySelector<HTMLElement>('.lv-row:not([aria-disabled="true"]), .lv-radio')?.focus({ preventScroll: true });
}

function openSheet(anchor: HTMLElement, store: Store): void {
  const control = createLevelsControl(store, { locked: () => lockedFrom(anchor)(), close: () => close(true) });
  const sheet = el('div', { class: 'lv-sheet', role: 'dialog', tabIndex: -1 }, control.root);
  sheet.setAttribute('aria-modal', 'true'); sheet.setAttribute('aria-labelledby', control.headId);
  const scrim = el('div', { class: 'lv-scrim' }), layer = el('div', { class: 'lv-sheet-layer' }, scrim, sheet);
  // Modal: what is behind it can be neither reached nor read until it closes (only what this sheet made inert is given back).
  const made: HTMLElement[] = [];
  for (const child of [...document.body.children]) if (child instanceof HTMLElement && !child.inert) { child.inert = true; made.push(child); }
  document.body.append(layer);
  requestAnimationFrame(() => layer.classList.add('in'));
  const focusables = (): HTMLElement[] => [...sheet.querySelectorAll<HTMLElement>('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])')].filter(x => !x.hidden && x.getClientRects().length > 0 && x.tabIndex >= 0);
  const onKey = (event: KeyboardEvent): void => {
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(true); return; }
    if (event.key !== 'Tab') return;
    const list = focusables(), i = list.indexOf(document.activeElement as HTMLElement), to = trapStep(list.length, i, event.shiftKey);
    if (to !== null) { event.preventDefault(); list[to]?.focus(); }
  };
  const onResize = (): void => { if (window.innerWidth >= SHEET_BELOW) close(false); };
  const close = (restore: boolean): void => {
    if (opened?.close !== close) return;
    opened = null; control.destroy(); layer.remove();
    for (const child of made) child.inert = false;
    anchor.setAttribute('aria-expanded', 'false');
    document.removeEventListener('keydown', onKey, true); window.removeEventListener('resize', onResize);
    if (restore && anchor.isConnected) anchor.focus({ preventScroll: true });
  };
  scrim.addEventListener('click', () => close(true));
  document.addEventListener('keydown', onKey, true); window.addEventListener('resize', onResize);
  opened = { anchor, close };
  anchor.setAttribute('aria-expanded', 'true');
  sheet.focus({ preventScroll: true });
}
