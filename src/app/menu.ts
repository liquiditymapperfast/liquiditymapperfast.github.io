import { el } from './dom.ts';
import { closePanel } from './ui.ts';
import { compactBar, onLayoutMode } from './device.ts';
import { scrimFor } from './sheet.ts';

export interface MenuItem {
  id: string; label: string; /** Colours drawn as a small swatch beside the label. */ swatch?: readonly string[]; /** Shown but not choosable. */ disabled?: boolean; /** Something to do rather than a choice (it opens a panel): after a line, never ticked. */ action?: boolean;
  /** Ticked or not whatever `current` is: a menu of several choices at once (each group ticks its own, a switch ticks while on). */
  checked?: boolean;
  /** Not a choice: the name of the group of rows after it (or a word about them), which the keys pass over. */
  heading?: boolean;
  /** A small tag after the label (the paid part's name on a choice that is part of it), drawn with a lock while it is not open here. */
  tag?: string; locked?: boolean;
  /** What the row does, for its tooltip. */
  tip?: string;
}
export interface MenuOptions {
  /** A heading for the menu where it is a sheet (a phone). */
  title?: string;
  /** Leave an open panel alone: the menu belongs to a control inside it. */
  keepPanel?: boolean;
  /** A dropdown's list rather than a menu: at least as wide as what opened it, in the frame's list look (`.menu.list`). */
  list?: boolean;
}
export interface MenuHandlers {
  /** The pointer or keyboard is on an item (`id`), or has left the menu without choosing (`null`). */
  onPreview(id: string | null): void;
  onSelect(id: string): void;
}

/** The menus that are open, so that they can be closed from outside (the tour clears the page before it points at it; a key pressed for it would reach the chart too). */
const opened = new Set<() => void>();
export const closeMenus = (): void => { for (const close of [...opened]) close(); };

/**
 * A list of choices that previews each one while the pointer or the arrow keys are on it and keeps the choice on click or Enter.
 * Leaving the menu, Escape, or a click elsewhere puts things back as they were.
 */
export function openMenu(anchor: HTMLElement, items: readonly MenuItem[], current: string, handlers: MenuHandlers, align: 'left' | 'right' = 'right', options: MenuOptions = {}): { close(): void } {
  if (!options.keepPanel) closePanel();
  let done = false, closed = false;
  const root = el('div', { class: 'menu', role: 'listbox' });
  // Named for a screen reader by what it chooses (the select's or the button's caption), shown or not.
  if (options.title) root.setAttribute('aria-label', options.title);
  if (options.list) { root.classList.add('list'); if (!compactBar()) root.style.minWidth = `${Math.round(anchor.getBoundingClientRect().width)}px`; }
  if (options.title) root.append(el('div', { class: 'menu-title', textContent: options.title }));
  const rows: HTMLButtonElement[] = [];
  for (const item of items) {
    if (item.heading) { root.append(el('div', { class: 'menu-heading', textContent: item.label, ...(item.tip ? { tip: item.tip } : {}) })); continue; }
    const isCurrent = item.checked ?? item.id === current;
    const swatch = item.swatch ? [el('span', { class: 'swatch' }, ...item.swatch.map(color => { const dot = el('i'); dot.style.background = color; return dot; }))] : [];
    const tag = item.tag ? [el('span', { class: 'tag', textContent: item.tag })] : [];
    if (item.locked) tag[0]?.classList.add('locked');
    const row = el('button', { type: 'button', class: (isCurrent ? 'menu-item current' : 'menu-item') + (swatch.length ? '' : ' plain') + (item.action ? ' action' : ''), role: 'option', disabled: item.disabled === true, ...(item.tip ? { tip: item.tip } : {}) }, ...swatch, el('span', { class: 'label' }, item.label, ...tag), el('span', { class: 'tick' }));
    row.setAttribute('aria-selected', String(isCurrent)); row.dataset.id = item.id;
    // With a mouse the row under the pointer takes the focus too: the pointer and the keyboard move one place, so the keys go on from where
    // the pointer is, and a row the keys have left is not lit for the pointer still resting on it (the frames light the focused row).
    row.onpointerenter = () => { handlers.onPreview(item.id); if (!compactBar() && !row.disabled) row.focus({ preventScroll: true }); };
    row.onfocus = () => handlers.onPreview(item.id);
    row.onclick = () => { done = true; handlers.onSelect(item.id); close(); };
    root.append(row);
    rows.push(row);
  }
  document.body.append(root);
  const place = (): void => {
    // On a phone the stylesheet makes the menu a bottom sheet.
    if (compactBar()) { root.style.top = ''; root.style.left = ''; root.style.maxHeight = ''; return; }
    const a = anchor.getBoundingClientRect(), w = root.offsetWidth, height = root.offsetHeight;
    // The room between the menu and what opened it is the frame's (`--menu-gap`): the Classic frame opens it flush, as the desktop did.
    const gapCss = parseFloat(getComputedStyle(root).getPropertyValue('--menu-gap')), gap = Number.isFinite(gapCss) ? gapCss : 4;
    const below = window.innerHeight - a.bottom - 8, up = below < height && a.top > below;
    root.style.top = `${Math.max(8, up ? a.top - gap - height : a.bottom + gap)}px`;
    root.style.left = `${Math.min(Math.max(8, align === 'right' ? a.right - w : a.left), window.innerWidth - w - 8)}px`;
    root.style.maxHeight = `${Math.max(160, up ? a.top - 12 : below)}px`;
  };
  const onPointer = (event: PointerEvent): void => { if (compactBar()) return; const t = event.target as Node; if (!root.contains(t) && !anchor.contains(t)) close(); };
  const scrim = scrimFor(root, 69, () => close());
  const onKey = (event: KeyboardEvent): void => {
    if (event.key === 'Escape') { event.preventDefault(); close(); anchor.focus(); return; }
    // Tab leaves the menu as it leaves the desktop's: closed, the keyboard going on from what opened it (not stranded on a row taken away).
    if (event.key === 'Tab') { close(); if (anchor.isConnected) anchor.focus({ preventScroll: true }); return; }
    // Keys belong to the menu only while the keyboard is in it or on what opened it: one typed in a field elsewhere is that field's (Sol).
    const active = document.activeElement;
    if (!root.contains(active) && !anchor.contains(active)) return;
    const at = rows.indexOf(active as HTMLButtonElement);
    // A row that cannot be chosen (the traders while stops are shown) is stepped over: focus cannot rest on a disabled button.
    const usable = (i: number): boolean => !rows[i]!.disabled;
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      const step = event.key === 'ArrowDown' ? 1 : -1;
      for (let k = 1, i = Math.max(0, at); k <= rows.length; k++) { const next = (i + k * step + rows.length * k) % rows.length; if (usable(next)) { rows[next]!.focus(); break; } }
    } else if (event.key === 'Home' || event.key === 'End') {
      event.preventDefault();
      const order = rows.map((_, i) => i); if (event.key === 'End') order.reverse();
      const first = order.find(usable); if (first !== undefined) rows[first]!.focus();
    }
    else if (event.key.length === 1 && event.key !== ' ' && !event.ctrlKey && !event.metaKey && !event.altKey) {
      // A letter goes to the next row whose name begins with it, round to the first again, as the desktop's lists and the browser's own did.
      // The menu has the keyboard while it is open: a letter it has no row for is used up too, so it starts no shortcut of the page (Sol: G
      // in the market's list opened Go to).
      event.preventDefault();
      const letter = event.key.toLocaleLowerCase(), order = [...rows.slice(at + 1), ...rows.slice(0, at + 1)];
      const hit = order.find(row => !row.disabled && (row.querySelector('.label')?.textContent ?? '').trim().toLocaleLowerCase().startsWith(letter));
      // The row already focused takes no focus event, so its preview is asked for again (it may have ended when the pointer left, Sol).
      if (hit === active && hit?.dataset.id) handlers.onPreview(hit.dataset.id); else hit?.focus();
    }
  };
  const stopMode = onLayoutMode(() => { scrim.sync(); place(); });
  function close(): void {
    if (closed) return;
    closed = true; stopMode(); opened.delete(close);
    // After a choice the keyboard goes back to what opened the menu when it was in the menu (Enter left it nowhere, Sol); not after a press
    // elsewhere, which puts it where that press was (on a select left focused, the arrow keys would change it unseen), nor on a phone, where
    // a select taking the focus zooms an iPhone's page in. Escape gives it back itself.
    const hadFocus = root.contains(document.activeElement);
    root.remove(); scrim.remove(); anchor.classList.remove('open');
    // A choice that rebuilt the panel the anchor was in left a new control in its place: found by the key a panel's controls keep the focus by.
    const key = anchor.dataset.focus;
    const back = anchor.isConnected ? anchor : key ? [...document.querySelectorAll<HTMLElement>('[data-focus]')].find(x => x.dataset.focus === key) : undefined;
    if (done && hadFocus && back && !compactBar()) back.focus({ preventScroll: true });
    document.removeEventListener('pointerdown', onPointer, true); document.removeEventListener('keydown', onKey, true); window.removeEventListener('resize', place);
    if (!done) handlers.onPreview(null);
  }
  root.onpointerleave = () => handlers.onPreview(null);
  anchor.classList.add('open'); scrim.sync(); place(); opened.add(close);
  // A preview restyles the whole page, and another frame's rows are taller or shorter: the list grew past the window's edge (the last themes
  // vanished while the pointer was on it, Karl 2026-10-17) and its rows slid under a still pointer, previewing a neighbour. The menu keeps
  // the sizes it opened with, so a preview changes colours and type, never where a row is.
  for (const row of rows) { const h = `${row.offsetHeight}px`; Object.assign(row.style, { height: h, minHeight: h, maxHeight: h, paddingTop: '0', paddingBottom: '0' }); }
  if (!compactBar()) Object.assign(root.style, { boxSizing: 'border-box', width: `${root.offsetWidth}px`, height: `${root.offsetHeight}px` });
  document.addEventListener('pointerdown', onPointer, true); document.addEventListener('keydown', onKey, true); window.addEventListener('resize', place);
  const chosen = rows.find(row => row.dataset.id === current) ?? rows.find(row => !row.disabled) ?? rows[0];
  chosen?.focus({ preventScroll: true });
  // A list cut to the window (the theme list is taller than a short one) scrolls to the chosen row, so a person can see where they are.
  chosen?.scrollIntoView({ block: 'nearest' });
  return { close };
}
