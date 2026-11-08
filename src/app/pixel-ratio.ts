/**
 * Device pixels per CSS pixel for the page's canvases: the screen's, or, for one frame, a higher one, so a screenshot is sharper than the
 * screen (screenshot/capture.ts). Every pane reads it when it sizes its canvases, and those that can be drawn at once name themselves here
 * with how to size and draw them now.
 *
 * A sharp picture is one task: `paintAt(scale)` sizes and draws every named pane at `scale`, the picture is taken, and `paintAt(null)` sizes
 * and draws them at the screen's again before the browser shows a frame. Nothing of it is ever seen on the page.
 */
let held: number | null = null;

/** The ratio the canvases are sized at now. */
export const pixelRatio = (): number => held ?? ((typeof window === 'undefined' ? 1 : window.devicePixelRatio) || 1);

/** A pane that can be sized and drawn at once: `resize` sizes its canvases from `pixelRatio()`, `paint` draws it in full, in this task. */
export interface Sharpened { resize(): void; paint(): void }
const panes = new Set<Sharpened>();

/** Name a pane that is sized and drawn again for a sharp picture. */
export function sharpens(pane: Sharpened): void { panes.add(pane); }

/**
 * Size every named pane's canvases at `ratio` (null: the screen's again) and draw them all now. One that cannot is left as it is and the
 * others still are: a picture must never leave the page at another size.
 */
export function paintAt(ratio: number | null): void {
  held = ratio;
  for (const pane of panes) { try { pane.resize(); } catch { /* left as it was */ } }
  for (const pane of panes) { try { pane.paint(); } catch { /* left as it was */ } }
}

/**
 * The scale of a sharp picture of a page `width` × `height` CSS px on a screen of `screen` device pixels to a CSS pixel: at least two, the
 * screen's where it has more, and no more than keeps the picture within `limit` pixels a side (a canvas that large costs a lot of memory).
 * Null when that is no more than the screen's: the picture is taken as the screen shows it.
 */
export function sharpScale(screen: number, width: number, height: number, limit = 8192): number | null {
  const scale = Math.min(Math.max(2, screen), limit / Math.max(1, width, height));
  return scale > screen + 0.01 ? scale : null;
}
