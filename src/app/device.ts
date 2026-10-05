/**
 * Which arrangement the window is in. CSS reads it from `<html data-layout>` and `<html data-bar>`, and the few places in script that must
 * differ (saved pane sizes, floating panels that become bottom sheets) read it from here, so the decision is made once and never from the
 * browser's user-agent string.
 *
 * The panes' arrangement (`data-layout`):
 *   phone            a narrow window, or a touch screen held upright that is not wide (a tablet in portrait): the map on top, one pane at a
 *                    time under it, a tab bar at the bottom
 *   phone-landscape  a short touch screen held sideways: the map on the left, the chosen pane on the right, a rail of tabs at the edge
 *   desktop          everything else, tablets in landscape included: the map with its panes in a column and the order book beside them
 *
 * The controls' arrangement (`data-bar`): `compact` wherever a finger is the main pointer (and in every phone arrangement): a slim
 * top bar with the few controls that are used all the time, and the rest in a Settings sheet; panels and menus become bottom sheets.
 * `full` is the desktop's own wrapping toolbar of dropdowns.
 */
export type LayoutMode = 'phone' | 'phone-landscape' | 'desktop';

export const PHONE_MAX_WIDTH = 640;
export const LANDSCAPE_MAX_HEIGHT = 520;
/** A touch screen held upright up to this wide (a tablet in portrait) gets the phone arrangement: its map is wide, but the desktop's two columns would not fit. */
export const PORTRAIT_TABLET_MAX_WIDTH = 900;

/** The panes' arrangement for a window of `width` x `height` CSS pixels. `coarse` is a touch-first pointer; `landscape` is how the screen is held. */
export function layoutFor(width: number, height: number, coarse: boolean, landscape: boolean = width > height): LayoutMode {
  if (coarse && landscape && height <= LANDSCAPE_MAX_HEIGHT) return 'phone-landscape';
  if (width <= PHONE_MAX_WIDTH) return 'phone';
  if (coarse && !landscape && width <= PORTRAIT_TABLET_MAX_WIDTH) return 'phone';
  return 'desktop';
}

/** Whether the controls take the compact form (a slim bar, a Settings sheet, bottom-sheet panels). */
export const compactBarFor = (mode: LayoutMode, coarse: boolean): boolean => mode !== 'desktop' || coarse;

export const isPhoneLayout = (mode: LayoutMode): boolean => mode !== 'desktop';

type Listener = (mode: LayoutMode, previous: LayoutMode) => void;
const listeners = new Set<Listener>();
let current: LayoutMode = 'desktop', compact = false;

/** The panes' arrangement now (`desktop` until `startDevice()` has run, which is also what a test environment without a window gets). */
export const layoutMode = (): LayoutMode => current;
/** True when the panes are arranged for a phone, in either orientation. */
export const isPhone = (): boolean => current !== 'desktop';
/** True when the primary pointer is a finger. Tablets answer yes too. */
export const isCoarse = (): boolean => typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches;
/** True when the controls are in their compact form: panels and menus are bottom sheets and the toolbar is the slim bar. */
export const compactBar = (): boolean => compact;

/** The screen's own orientation where the browser reports it: a keyboard that shrinks the window must not read as a rotation. */
function heldSideways(): boolean {
  const type = typeof screen !== 'undefined' ? screen.orientation?.type : undefined;
  return type ? type.startsWith('landscape') : innerWidth > innerHeight;
}

function measure(): { mode: LayoutMode; compact: boolean } {
  const coarse = isCoarse(), mode = layoutFor(innerWidth, innerHeight, coarse, heldSideways());
  return { mode, compact: compactBarFor(mode, coarse) };
}

/** Subscribe to changes of either arrangement (not called for resizes that keep both). Returns how to stop. */
export function onLayoutMode(listener: Listener): () => void { listeners.add(listener); return () => { listeners.delete(listener); }; }

/** Decide the arrangement, put it on `<html>`, and keep it current. Call once, before the interface is built. */
export function startDevice(): void {
  const root = document.documentElement;
  const publish = (): void => { root.dataset.layout = current; root.dataset.bar = compact ? 'compact' : 'full'; };
  const apply = (): void => {
    const next = measure();
    if (next.mode === current && next.compact === compact) return;
    const previous = current; current = next.mode; compact = next.compact; publish();
    for (const listener of [...listeners]) listener(next.mode, previous);
  };
  ({ mode: current, compact } = measure()); publish();
  let frame = 0;
  const later = (): void => { if (!frame) frame = requestAnimationFrame(() => { frame = 0; apply(); }); };
  window.addEventListener('resize', later); window.addEventListener('orientationchange', later);
  screen.orientation?.addEventListener('change', later);
  matchMedia('(pointer: coarse)').addEventListener('change', later);
}
