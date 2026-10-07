import { dragTo, type View } from './placement.ts';

/**
 * Lets a person move a floating window (a panel, a dialog) by its title bar. The rules for where it may go are `placement.ts`'s;
 * this is the pointer handling around them: a press on the title bar (not on a button in it) followed by a move of a few pixels takes hold
 * of the window, the pointer is captured so the canvases under it hear nothing while it travels, and the writes to the page are one
 * batch per frame, and only for what changed.
 *
 * The drag listens on the window while it lasts and does not depend on the capture: a browser may refuse it or take it back (Chrome did
 * both when it was driven over its debugging protocol, and a drag that ended with the capture ended on its first move), and the window
 * then simply goes on following the pointer, with the canvases hearing it too.
 */
export interface DragOptions {
  /** Which presses take hold of the window: its title bar, not the buttons and fields in it. */
  grabs(target: Element): boolean;
  /** False where the window is a sheet (a phone): nothing is moved there. */
  enabled(): boolean;
  /** The window's width and its height as its contents make it, read when a drag begins (and when the window is asked to keep inside the page). */
  size(): { width: number; need: number };
}
export interface Draggable {
  /** The window has been dragged: it has a place of its own now, and is no longer put under the button it came from. */
  moved(): boolean;
  /** The page changed size: bring the window back inside it. */
  clamp(): void;
  /** Forget the move and the styles it left (the window is a sheet now, or is being placed afresh). */
  reset(): void;
}

/** How far the pointer must travel before a press on the title bar is a drag and not a click. */
const THRESHOLD_PX = 3;

export function makeDraggable(root: HTMLElement, options: DragOptions): Draggable {
  let moved = false, dragging = false, frame = 0;
  let grab: { dx: number; dy: number; x: number; y: number; id: number; size: ReturnType<DragOptions['size']> } | null = null;
  let want = { left: 0, top: 0 };
  const written = { left: NaN, top: NaN, maxHeight: NaN };
  const view = (): View => ({ width: window.innerWidth, height: window.innerHeight });

  /** Put the window where `want` says, within the rules; touch the page only for what is different from what was last written. */
  const place = (size: ReturnType<DragOptions['size']>): void => {
    const placed = dragTo(want, size, view());
    if (placed.left !== written.left) { root.style.left = `${placed.left}px`; written.left = placed.left; }
    if (placed.top !== written.top) { root.style.top = `${placed.top}px`; written.top = placed.top; }
    if (placed.maxHeight !== written.maxHeight) { root.style.maxHeight = `${placed.maxHeight}px`; written.maxHeight = placed.maxHeight; }
  };
  const flush = (): void => { frame = 0; if (grab) place(grab.size); };

  const move = (event: PointerEvent): void => {
    if (!grab || event.pointerId !== grab.id) return;
    if (!dragging) {
      if (Math.hypot(event.clientX - grab.x, event.clientY - grab.y) < THRESHOLD_PX) return;
      dragging = true; moved = true;
      // From here the window has a place of its own: a box the browser centred, or one set under a button, is put exactly where it stands.
      const r = root.getBoundingClientRect();
      root.style.margin = '0'; root.style.inset = 'auto'; root.style.left = `${r.left}px`; root.style.top = `${r.top}px`;
      written.left = r.left; written.top = r.top; written.maxHeight = NaN;
      root.classList.add('being-moved');
    }
    want = { left: event.clientX - grab.dx, top: event.clientY - grab.dy };
    if (!frame) frame = requestAnimationFrame(flush);
  };
  /** Stop following the pointer. */
  const stop = (): void => {
    grab = null; dragging = false;
    root.classList.remove('being-moved');
    window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', end); window.removeEventListener('pointercancel', end);
  };
  function end(event: PointerEvent): void {
    if (!grab || event.pointerId !== grab.id) return;
    if (frame) { cancelAnimationFrame(frame); flush(); }
    const id = grab.id;
    stop();
    try { root.releasePointerCapture(id); } catch { /* it was never held, or is already released */ }
  }
  const begin = (event: PointerEvent): void => {
    if (event.button !== 0 || !options.enabled() || !(event.target instanceof Element) || !options.grabs(event.target)) return;
    const r = root.getBoundingClientRect();
    grab = { dx: event.clientX - r.left, dy: event.clientY - r.top, x: event.clientX, y: event.clientY, id: event.pointerId, size: options.size() };
    dragging = false;
    try { root.setPointerCapture(event.pointerId); } catch { /* the drag does not need it */ }
    window.addEventListener('pointermove', move); window.addEventListener('pointerup', end); window.addEventListener('pointercancel', end);
    // A press on a title bar is not a text selection, and not a focus change.
    event.preventDefault();
  };
  root.addEventListener('pointerdown', begin);

  return {
    moved: () => moved,
    clamp() {
      if (!moved) return;
      const r = root.getBoundingClientRect();
      want = { left: r.left, top: r.top };
      // What was last written may have been changed under it (a panel measures itself with no height limit), so everything is written again.
      written.left = written.top = written.maxHeight = NaN;
      place(options.size());
    },
    reset() {
      moved = false;
      if (frame) { cancelAnimationFrame(frame); frame = 0; }
      stop();
      for (const property of ['margin', 'inset', 'left', 'top', 'maxHeight'] as const) root.style[property] = '';
      written.left = written.top = written.maxHeight = NaN;
    },
  };
}
