/**
 * One tooltip for the whole page. An element carries its explanation in `data-tip` (set with `setTip`, or `tip:` in `el()`); a single
 * delegated listener shows it after a short hover or at once on keyboard focus. The native `title` attribute is not used anywhere,
 * so the browser's own tooltip never competes with this one, and the text can change while it is open.
 */

const SHOW_DELAY_MS = 380, FOLLOW_MS = 600, GAP = 8, MARGIN = 8;

export function setTip(node: HTMLElement, text: string | null | undefined): void {
  if (text) node.dataset.tip = text; else delete node.dataset.tip;
}

/** Where a tooltip of `size` goes for an anchor `rect`: centred below it, or above when there is no room, kept inside the viewport. */
export function placeTip(rect: { left: number; right: number; top: number; bottom: number }, size: { w: number; h: number }, viewport: { w: number; h: number }): { left: number; top: number; above: boolean } {
  const above = rect.bottom + GAP + size.h > viewport.h - MARGIN && rect.top - GAP - size.h >= MARGIN;
  const top = above ? rect.top - GAP - size.h : Math.min(rect.bottom + GAP, viewport.h - MARGIN - size.h);
  const centre = (rect.left + rect.right) / 2 - size.w / 2;
  return { left: Math.max(MARGIN, Math.min(centre, viewport.w - MARGIN - size.w)), top: Math.max(MARGIN, top), above };
}

/** Start listening on `doc`; returns how to stop (for tests and hot reload). */
export function installTips(doc: Document = document): () => void {
  const box = doc.createElement('div');
  box.className = 'tip'; box.setAttribute('role', 'tooltip');
  // The popover API puts the tooltip in the top layer, above modal dialogs (the guide, the venue picker); without it a plain fixed box is used.
  const canPopover = typeof box.showPopover === 'function';
  if (canPopover) box.popover = 'manual';
  doc.body.append(box);
  let current: HTMLElement | null = null, timer = 0, watcher: MutationObserver | null = null, visible = false, lastShown = 0;

  const place = (): void => {
    if (!current) return;
    box.style.left = '0px'; box.style.top = '0px';
    const rect = current.getBoundingClientRect(), size = { w: box.offsetWidth, h: box.offsetHeight };
    const at = placeTip(rect, size, { w: doc.documentElement.clientWidth, h: doc.documentElement.clientHeight });
    box.style.left = `${Math.round(at.left)}px`; box.style.top = `${Math.round(at.top)}px`;
  };
  const hide = (): void => {
    window.clearTimeout(timer); timer = 0; watcher?.disconnect(); watcher = null; current = null;
    if (!visible) return;
    visible = false; lastShown = Date.now(); box.classList.remove('on');
    if (canPopover && box.matches(':popover-open')) box.hidePopover();
  };
  const show = (node: HTMLElement): void => {
    const text = node.dataset.tip; if (!text) return;
    current = node; box.textContent = text;
    if (canPopover && !box.matches(':popover-open')) box.showPopover();
    box.classList.add('on'); visible = true; place();
    watcher?.disconnect();
    // The text may change while it is open (a venue chip's reach, a status): follow it.
    watcher = new MutationObserver(() => { if (current !== node) return; const next = node.dataset.tip; if (next) { box.textContent = next; place(); } else hide(); });
    watcher.observe(node, { attributes: true, attributeFilter: ['data-tip'] });
  };
  const target = (event: Event): HTMLElement | null => (event.target instanceof Element ? event.target.closest<HTMLElement>('[data-tip]') : null);

  const over = (event: PointerEvent): void => {
    if (event.pointerType === 'touch') return;
    const node = target(event);
    if (node === current) return;
    hide();
    if (!node) return;
    // Once a tooltip has been seen, the next one follows at once, as when a toolbar is being scanned.
    if (Date.now() - lastShown < FOLLOW_MS) show(node); else timer = window.setTimeout(() => show(node), SHOW_DELAY_MS);
  };
  const focus = (event: FocusEvent): void => {
    const node = target(event);
    if (node && event.target instanceof Element && event.target.matches(':focus-visible')) { hide(); show(node); }
  };
  const leave = (event: PointerEvent): void => { if (!event.relatedTarget) hide(); };
  const stop = (): void => hide();
  const key = (event: KeyboardEvent): void => { if (event.key === 'Escape') hide(); };

  doc.addEventListener('pointerover', over, true);
  doc.addEventListener('pointerleave', leave, true);
  doc.addEventListener('pointerdown', stop, true);
  doc.addEventListener('wheel', stop, { capture: true, passive: true });
  doc.addEventListener('focusin', focus, true);
  doc.addEventListener('focusout', stop, true);
  doc.addEventListener('keydown', key, true);
  window.addEventListener('blur', stop);
  return () => {
    hide();
    doc.removeEventListener('pointerover', over, true); doc.removeEventListener('pointerleave', leave, true); doc.removeEventListener('pointerdown', stop, true);
    doc.removeEventListener('wheel', stop, true); doc.removeEventListener('focusin', focus, true); doc.removeEventListener('focusout', stop, true); doc.removeEventListener('keydown', key, true);
    window.removeEventListener('blur', stop); box.remove();
  };
}
