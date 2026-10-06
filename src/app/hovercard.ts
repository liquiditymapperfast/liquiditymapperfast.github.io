import { el } from './dom.ts';
import type { InfoLine } from './infobox.ts';

const GAP = 14, MARGIN = 6;

/** Where a card of `size` goes for a pointer at (x, y): above-right of it, flipped to the other side or below where there is no room, always inside the viewport. */
export function placeCard(x: number, y: number, size: { w: number; h: number }, viewport: { w: number; h: number }): { left: number; top: number } {
  let left = x + GAP; if (left + size.w > viewport.w - MARGIN) left = x - GAP - size.w;
  let top = y - GAP - size.h; if (top < MARGIN) top = y + GAP;
  return { left: Math.max(MARGIN, Math.min(left, viewport.w - MARGIN - size.w)), top: Math.max(MARGIN, Math.min(top, viewport.h - MARGIN - size.h)) };
}

/**
 * The same box a canvas draws beside the pointer (infobox.ts), made of page elements, for the panes too short to hold one: a canvas
 * cannot draw outside itself, a page element can float over the panes around it. One card serves the page; it follows the pointer
 * and is rebuilt only when what it says changes.
 */
export class HoverCard {
  readonly root: HTMLElement;
  #key = ''; #on = false;
  #popover: boolean;

  constructor(doc: Document = document) {
    this.root = el('div', { class: 'hovercard', role: 'tooltip' });
    // The popover API puts the card in the top layer, above panels and dialogs; without it a plain fixed box is used.
    this.#popover = typeof this.root.showPopover === 'function';
    if (this.#popover) this.root.popover = 'manual';
    doc.body.append(this.root);
  }

  /** Show `lines` for a pointer at viewport position (x, y). */
  show(lines: readonly InfoLine[], x: number, y: number): void {
    const key = lines.map(l => `${l.label ?? ''}\u0001${l.text}\u0001${l.color ?? ''}${l.bold ? 'b' : ''}${l.rule ? 'r' : ''}`).join('\u0002');
    if (key !== this.#key) {
      this.#key = key;
      this.root.replaceChildren(...lines.map(line => {
        const cls = ['hc-line', `c-${line.color ?? 'text'}`, ...(line.bold ? ['bold'] : []), ...(line.rule ? ['rule'] : [])];
        return line.label !== undefined
          ? el('div', { class: `${cls.join(' ')} hc-row` }, el('span', { class: 'hc-label', textContent: line.label }), el('span', { class: 'hc-value', textContent: line.text }))
          : el('div', { class: cls.join(' '), textContent: line.text });
      }));
    }
    if (!this.#on) { this.#on = true; if (this.#popover && !this.root.matches(':popover-open')) this.root.showPopover(); this.root.classList.add('on'); }
    const at = placeCard(x, y, { w: this.root.offsetWidth, h: this.root.offsetHeight }, { w: document.documentElement.clientWidth, h: document.documentElement.clientHeight });
    this.root.style.transform = `translate(${Math.round(at.left)}px, ${Math.round(at.top)}px)`;
  }

  hide(): void {
    if (!this.#on) return;
    this.#on = false; this.root.classList.remove('on');
    if (this.#popover && this.root.matches(':popover-open')) this.root.hidePopover();
  }
}
