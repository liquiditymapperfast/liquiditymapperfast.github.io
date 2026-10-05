import { el } from './dom.ts';
import { isPhone, onLayoutMode } from './device.ts';

/**
 * A bottom sheet for a phone: slides up over the page, dims what is behind it, and goes away on the scrim, the close button, Escape,
 * a downward swipe on its header, or a change to the desktop arrangement. It is an ordinary fixed element rather than a modal dialog, so
 * the floating panels and menus the controls inside it open (which live in the same stacking context, one level above) appear on top
 * of it instead of underneath, and the tooltip box still floats over both.
 */
export interface Sheet {
  readonly root: HTMLElement;
  readonly body: HTMLElement;
  close(): void;
}

const DRAG_CLOSE_PX = 72;

/**
 * A dim layer under a floating panel or menu on a phone (and nothing on a desktop, where a press elsewhere closes it). A tap on it
 * calls `close` on the click, not the press, so the tap's own click cannot land on whatever it covered.
 */
export function scrimFor(root: HTMLElement, z: number, close: () => void): { sync(): void; remove(): void } {
  const scrim = el('div', { class: 'sheet-scrim in light' });
  scrim.style.zIndex = String(z);
  scrim.addEventListener('click', close);
  return { sync() { if (isPhone()) { if (!scrim.isConnected) root.before(scrim); } else scrim.remove(); }, remove() { scrim.remove(); } };
}
let current: Sheet | null = null;
export const openedSheet = (): Sheet | null => current;
export const closeSheet = (): void => current?.close();

export function openSheet(title: string, build: (body: HTMLElement) => void, onClose?: () => void): Sheet {
  current?.close();
  const scrim = el('div', { class: 'sheet-scrim' });
  const closeButton = el('button', { type: 'button', class: 'sheet-x', textContent: '×', ariaLabel: 'Close' });
  const head = el('div', { class: 'sheet-head' }, el('span', { class: 'sheet-grab' }), el('h3', { textContent: title }), closeButton);
  const body = el('div', { class: 'sheet-body' });
  const root = el('div', { class: 'sheet', role: 'dialog' }, head, body);
  root.setAttribute('aria-label', title);
  build(body);
  document.body.append(scrim, root);
  // Let the first frame paint at the resting offset so the slide has somewhere to start from.
  requestAnimationFrame(() => { root.classList.add('in'); scrim.classList.add('in'); });

  const onKey = (event: KeyboardEvent): void => {
    if (event.key !== 'Escape') return;
    // A panel or menu opened from inside the sheet handles its own Escape first.
    if (document.querySelector('.panel, .menu, dialog[open]')) return;
    sheet.close();
  };
  const stopMode = onLayoutMode(mode => { if (mode === 'desktop') sheet.close(); });
  const sheet: Sheet = {
    root, body,
    close() {
      if (current !== sheet) return;
      current = null;
      document.removeEventListener('keydown', onKey, true); stopMode();
      root.remove(); scrim.remove();
      onClose?.();
    },
  };
  closeButton.onclick = () => sheet.close();
  // On the click, not the press: removing the scrim on the press would let the tap's own click land on whatever is under it.
  scrim.addEventListener('click', () => sheet.close());
  document.addEventListener('keydown', onKey, true);

  // Swipe down on the header to dismiss; the sheet follows the finger and springs back when released early.
  let startY = 0, dragging = false;
  head.addEventListener('pointerdown', event => {
    if (event.target === closeButton) return;
    dragging = true; startY = event.clientY; head.setPointerCapture(event.pointerId); root.style.transition = 'none';
  });
  head.addEventListener('pointermove', event => {
    if (!dragging) return;
    root.style.transform = `translateY(${Math.max(0, event.clientY - startY)}px)`;
  });
  const release = (event: PointerEvent): void => {
    if (!dragging) return;
    dragging = false; root.style.transition = '';
    const moved = event.clientY - startY;
    root.style.transform = '';
    if (moved > DRAG_CLOSE_PX) sheet.close();
  };
  head.addEventListener('pointerup', release); head.addEventListener('pointercancel', release);
  current = sheet;
  return sheet;
}
