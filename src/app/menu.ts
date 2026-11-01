import { el } from './dom.ts';
import { closePanel } from './ui.ts';
import { compactBar, onLayoutMode } from './device.ts';
import { scrimFor } from './sheet.ts';

export interface MenuItem { id: string; label: string; /** Colours drawn as a small swatch beside the label. */ swatch?: readonly string[]; /** Shown but not choosable. */ disabled?: boolean }
export interface MenuOptions {
  /** A heading for the menu where it is a sheet (a phone). */
  title?: string;
  /** Leave an open panel alone: the menu belongs to a control inside it. */
  keepPanel?: boolean;
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
  if (options.title) root.append(el('div', { class: 'menu-title', textContent: options.title }));
  const rows = items.map(item => {
    const isCurrent = item.id === current;
    const swatch = item.swatch ? [el('span', { class: 'swatch' }, ...item.swatch.map(color => { const dot = el('i'); dot.style.background = color; return dot; }))] : [];
    const row = el('button', { type: 'button', class: (isCurrent ? 'menu-item current' : 'menu-item') + (swatch.length ? '' : ' plain'), role: 'option', disabled: item.disabled === true }, ...swatch, el('span', { class: 'label', textContent: item.label }), el('span', { class: 'tick' }));
    row.setAttribute('aria-selected', String(isCurrent)); row.dataset.id = item.id;
    row.onpointerenter = () => handlers.onPreview(item.id);
    row.onfocus = () => handlers.onPreview(item.id);
    row.onclick = () => { done = true; handlers.onSelect(item.id); close(); };
    root.append(row);
    return row;
  });
  document.body.append(root);
  const place = (): void => {
    // On a phone the stylesheet makes the menu a bottom sheet.
    if (compactBar()) { root.style.top = ''; root.style.left = ''; root.style.maxHeight = ''; return; }
    const a = anchor.getBoundingClientRect(), w = root.offsetWidth, height = root.offsetHeight;
    const below = window.innerHeight - a.bottom - 8, up = below < height && a.top > below;
    root.style.top = `${Math.max(8, up ? a.top - 4 - height : a.bottom + 4)}px`;
    root.style.left = `${Math.min(Math.max(8, align === 'right' ? a.right - w : a.left), window.innerWidth - w - 8)}px`;
    root.style.maxHeight = `${Math.max(160, up ? a.top - 12 : below)}px`;
  };
  const onPointer = (event: PointerEvent): void => { if (compactBar()) return; const t = event.target as Node; if (!root.contains(t) && !anchor.contains(t)) close(); };
  const scrim = scrimFor(root, 69, () => close());
  const onKey = (event: KeyboardEvent): void => {
    if (event.key === 'Escape') { event.preventDefault(); close(); anchor.focus(); return; }
    const at = rows.indexOf(document.activeElement as HTMLButtonElement);
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); rows[(Math.max(0, at) + (event.key === 'ArrowDown' ? 1 : -1) + rows.length) % rows.length]?.focus(); }
    else if (event.key === 'Home' || event.key === 'End') { event.preventDefault(); rows[event.key === 'Home' ? 0 : rows.length - 1]?.focus(); }
  };
  const stopMode = onLayoutMode(() => { scrim.sync(); place(); });
  function close(): void {
    if (closed) return;
    closed = true; stopMode(); opened.delete(close);
    root.remove(); scrim.remove(); anchor.classList.remove('open');
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
  const chosen = rows[Math.max(0, items.findIndex(item => item.id === current))];
  chosen?.focus({ preventScroll: true });
  // A list cut to the window (the theme list is taller than a short one) scrolls to the chosen row, so a person can see where they are.
  chosen?.scrollIntoView({ block: 'nearest' });
  return { close };
}
