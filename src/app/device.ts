/**
 * Which of three arrangements the window is in. CSS reads it from `<html data-layout>` and the few places in script that must differ
 * (saved pane sizes, floating panels that become bottom sheets) read it from here, so the decision is made once and never from the
 * browser's user-agent string.
 *
 *   phone            a narrow window: map on top, one pane at a time below it, a tab bar at the bottom
 *   phone-landscape  a short touch screen held sideways: map on the left, the chosen pane on the right, a rail of tabs at the edge
 *   desktop          everything else, tablets included (they keep the desktop arrangement and gain touch gestures and larger targets)
 */
export type LayoutMode = 'phone' | 'phone-landscape' | 'desktop';

export const PHONE_MAX_WIDTH = 640;
export const LANDSCAPE_MAX_HEIGHT = 520;

/** The arrangement for a window of `width` x `height` CSS pixels. `coarse` is a touch-first pointer; `landscape` is how the screen is held. */
export function layoutFor(width: number, height: number, coarse: boolean, landscape: boolean = width > height): LayoutMode {
  if (coarse && landscape && height <= LANDSCAPE_MAX_HEIGHT) return 'phone-landscape';
  if (width <= PHONE_MAX_WIDTH) return 'phone';
  return 'desktop';
}

export const isPhoneLayout = (mode: LayoutMode): boolean => mode !== 'desktop';

type Listener = (mode: LayoutMode, previous: LayoutMode) => void;
const listeners = new Set<Listener>();
let current: LayoutMode = 'desktop';

/** The arrangement now (`desktop` until `startDevice()` has run, which is also what a test environment without a window gets). */
export const layoutMode = (): LayoutMode => current;
/** True on a phone, in either orientation. */
export const isPhone = (): boolean => current !== 'desktop';
/** True when the primary pointer is a finger. Tablets answer yes too. */
export const isCoarse = (): boolean => typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches;

/** The screen's own orientation where the browser reports it: a keyboard that shrinks the window must not read as a rotation. */
function heldSideways(): boolean {
  const type = typeof screen !== 'undefined' ? screen.orientation?.type : undefined;
  return type ? type.startsWith('landscape') : innerWidth > innerHeight;
}

function measure(): LayoutMode { return layoutFor(innerWidth, innerHeight, isCoarse(), heldSideways()); }

/** Subscribe to arrangement changes (not called for resizes that keep the same arrangement). Returns how to stop. */
export function onLayoutMode(listener: Listener): () => void { listeners.add(listener); return () => { listeners.delete(listener); }; }

/** Decide the arrangement, put it on `<html>`, and keep it current. Call once, before the interface is built. */
export function startDevice(): void {
  const apply = (): void => {
    const next = measure();
    document.documentElement.dataset.layout = next;
    if (next === current) return;
    const previous = current; current = next;
    for (const listener of [...listeners]) listener(next, previous);
  };
  current = measure(); document.documentElement.dataset.layout = current;
  let frame = 0;
  const later = (): void => { if (!frame) frame = requestAnimationFrame(() => { frame = 0; apply(); }); };
  window.addEventListener('resize', later); window.addEventListener('orientationchange', later);
  screen.orientation?.addEventListener('change', later);
  matchMedia('(pointer: coarse)').addEventListener('change', later);
}
