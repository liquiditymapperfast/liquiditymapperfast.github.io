import { openMenu, type MenuItem } from './menu.ts';

/**
 * Dropdowns on a touch screen. The browser's own list is a system dialog in the system's colours and type size (a light one over a dark
 * theme, a tiny one on a phone), and an iPhone zooms the page in when one takes focus. A tap on a `<select>` is answered here instead
 * with the page's own menu (a sheet on a phone, in the chosen theme), which writes the choice back into the same element and fires
 * the same `input` and `change` events, so nothing that listens to the select knows the difference. Mouse, keyboard and pen keep
 * the native dropdown.
 *
 * The native one is stopped by cancelling the touch before the browser turns it into a click.
 */

/** What to call the choice at the top of the menu: the control's name wherever the page keeps one beside it. */
export function selectTitle(select: HTMLSelectElement): string {
  const named = select.getAttribute('aria-label'); if (named) return named;
  const caption = select.closest('label.ctl')?.firstChild?.textContent?.trim(); if (caption) return caption;
  const sheet = select.closest('.sheet-field')?.querySelector('.sheet-label')?.textContent?.trim(); if (sheet) return sheet;
  const field = select.closest('label.field')?.querySelector('.name')?.textContent?.trim(); if (field) return field;
  return '';
}

/** The menu's items for a select's options (the index is the id: values can repeat or be empty). */
export function itemsOf(select: HTMLSelectElement): MenuItem[] {
  return [...select.options].map((option, index) => ({ id: String(index), label: option.text, disabled: option.disabled }));
}

/** Open the menu for `select` and write the choice back. */
export function openSelectMenu(select: HTMLSelectElement): { close(): void } {
  return openMenu(select, itemsOf(select), String(select.selectedIndex), {
    onPreview: () => {},
    onSelect: id => {
      const index = Number(id);
      if (!Number.isInteger(index) || index === select.selectedIndex || !select.options[index]) return;
      select.selectedIndex = index;
      select.dispatchEvent(new Event('input', { bubbles: true }));
      select.dispatchEvent(new Event('change', { bubbles: true }));
    },
  }, 'left', { title: selectTitle(select), keepPanel: true });
}

const TAP_SLOP = 10, TAP_MAX_MS = 380;

/** Start answering taps on selects; returns how to stop. */
export function installTouchSelects(doc: Document = document): () => void {
  let start: { x: number; y: number; t: number } | null = null;
  const selectAt = (target: EventTarget | null): HTMLSelectElement | null => {
    if (!(target instanceof Element)) return null;
    const direct = target.closest('select'); if (direct) return direct;
    const control = target.closest('label')?.control;
    return control instanceof HTMLSelectElement ? control : null;
  };
  const down = (event: TouchEvent): void => {
    const touch = event.touches[0];
    start = event.touches.length === 1 && touch ? { x: touch.clientX, y: touch.clientY, t: event.timeStamp } : null;
  };
  const up = (event: TouchEvent): void => {
    const was = start; start = null;
    if (!was || event.touches.length > 0 || !event.cancelable) return;
    const select = selectAt(event.target);
    const touch = event.changedTouches[0];
    // A long press is the tooltip's, and a drag is a scroll: only a short, still touch is a tap.
    if (!select || select.disabled || !touch || event.timeStamp - was.t > TAP_MAX_MS || Math.hypot(touch.clientX - was.x, touch.clientY - was.y) > TAP_SLOP) return;
    event.preventDefault();
    openSelectMenu(select);
  };
  doc.addEventListener('touchstart', down, { capture: true, passive: true });
  doc.addEventListener('touchend', up, { capture: true, passive: false });
  return () => { doc.removeEventListener('touchstart', down, true); doc.removeEventListener('touchend', up, true); };
}
