import { el } from './dom.ts';
import { closePanel } from './ui.ts';

export interface MenuItem { id: string; label: string; /** Colours drawn as a small swatch beside the label. */ swatch?: readonly string[] }
export interface MenuHandlers {
  /** The pointer or keyboard is on an item (`id`), or has left the menu without choosing (`null`). */
  onPreview(id: string | null): void;
  onSelect(id: string): void;
}

/**
 * A list of choices that previews each one while the pointer or the arrow keys are on it and keeps the choice on click or Enter.
 * Leaving the menu, Escape, or a click elsewhere puts things back as they were.
 */
export function openMenu(anchor: HTMLElement, items: readonly MenuItem[], current: string, handlers: MenuHandlers, align: 'left' | 'right' = 'right'): { close(): void } {
  closePanel();
  let done = false, closed = false;
  const root = el('div', { class: 'menu', role: 'listbox' });
  const rows = items.map(item => {
    const swatch = el('span', { class: 'swatch' }, ...(item.swatch ?? []).map(color => { const dot = el('i'); dot.style.background = color; return dot; }));
    const isCurrent = item.id === current;
    const row = el('button', { type: 'button', class: isCurrent ? 'menu-item current' : 'menu-item', role: 'option' }, swatch, el('span', { class: 'label', textContent: item.label }), el('span', { class: 'tick', textContent: isCurrent ? '✓' : '' }));
    row.setAttribute('aria-selected', String(isCurrent)); row.dataset.id = item.id;
    row.onpointerenter = () => handlers.onPreview(item.id);
    row.onfocus = () => handlers.onPreview(item.id);
    row.onclick = () => { done = true; handlers.onSelect(item.id); close(); };
    root.append(row);
    return row;
  });
  document.body.append(root);
  const place = (): void => {
    const a = anchor.getBoundingClientRect(), w = root.offsetWidth, height = root.offsetHeight;
    const below = window.innerHeight - a.bottom - 8, up = below < height && a.top > below;
    root.style.top = `${Math.max(8, up ? a.top - 4 - height : a.bottom + 4)}px`;
    root.style.left = `${Math.min(Math.max(8, align === 'right' ? a.right - w : a.left), window.innerWidth - w - 8)}px`;
    root.style.maxHeight = `${Math.max(160, up ? a.top - 12 : below)}px`;
  };
  const onPointer = (event: PointerEvent): void => { const t = event.target as Node; if (!root.contains(t) && !anchor.contains(t)) close(); };
  const onKey = (event: KeyboardEvent): void => {
    if (event.key === 'Escape') { event.preventDefault(); close(); anchor.focus(); return; }
    const at = rows.indexOf(document.activeElement as HTMLButtonElement);
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); rows[(Math.max(0, at) + (event.key === 'ArrowDown' ? 1 : -1) + rows.length) % rows.length]?.focus(); }
    else if (event.key === 'Home' || event.key === 'End') { event.preventDefault(); rows[event.key === 'Home' ? 0 : rows.length - 1]?.focus(); }
  };
  function close(): void {
    if (closed) return;
    closed = true;
    root.remove(); anchor.classList.remove('open');
    document.removeEventListener('pointerdown', onPointer, true); document.removeEventListener('keydown', onKey, true); window.removeEventListener('resize', place);
    if (!done) handlers.onPreview(null);
  }
  root.onpointerleave = () => handlers.onPreview(null);
  anchor.classList.add('open'); place();
  document.addEventListener('pointerdown', onPointer, true); document.addEventListener('keydown', onKey, true); window.addEventListener('resize', place);
  rows[Math.max(0, items.findIndex(item => item.id === current))]?.focus({ preventScroll: true });
  return { close };
}
