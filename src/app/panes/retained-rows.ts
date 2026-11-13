/**
 * A list's rows kept on its canvas from one frame to the next (Karl, 2026-11-13: the Trades lists as fast and as steady as they can be).
 * A frame lays its rows out first, each with a signature of everything its pixels depend on, then asks `plan` which rows to draw. When the
 * look is the last frame's (same size, pixel ratio, theme, sources: the caller's `look`) and the rows are the last frame's moved by a whole
 * number of device pixels (a scroll, a new second on top), what is on the canvas is copied onto itself shifted, and only the rows that are
 * new, changed, showing a part not drawn before (a row cut by an edge that moves in) or under something drawn over them are drawn again.
 * Anything else draws the whole frame: a row edge off the device-pixel grid too (a row drawn again there would lay a second anti-aliased
 * edge over the first, and the frame would no longer be the one a whole paint makes). A row cut by an edge of the canvas is drawn again
 * whenever it moves: a browser draws the text of a row that crosses an edge otherwise than the same row drawn inside and moved there (at
 * 2.625 a glyph's top scanline on the last device row of a row drawn whole, none on the row drawn cut). A row must paint its whole rectangle
 * (its background first): it is drawn over what was there. A `fixed` row (a banner at the top) does not move with the list: it does not decide the shift,
 * is drawn again after one, and the rows that scrolled under it are drawn again the frame after (their pixels carry it).
 */
export interface RowItem { readonly sig: string; readonly y: number; readonly h: number; readonly fixed?: boolean }

const onGrid = (v: number): boolean => Math.abs(v - Math.round(v)) < 1e-4;
/** Where a row was last drawn (its top) and the part of it on the canvas then (the caller's units). */
interface Placed { y: number; v0: number; v1: number }

export class RetainedRows {
  #at = new Map<string, Placed>();
  #look = '';
  #damage: [number, number][] = [];
  /** Frames drawn whole and in part, rows drawn and kept, and the last frame's shift in device pixels (0: none; NaN: drawn whole). */
  wholeFrames = 0; partFrames = 0; rowsDrawn = 0; rowsKept = 0; lastShift = NaN;

  /** The next frame draws everything (a change the look key does not carry). */
  reset(): void { this.#look = ''; this.#at.clear(); }
  /** A stretch of the canvas (the caller's units) that something other than a row was drawn over: the rows under it are drawn again next frame. */
  damage(y0: number, y1: number): void { if (y1 > y0) this.#damage.push([y0, y1]); }

  /**
   * Which of `items` (top to bottom, contiguous) to draw this frame, after shifting or clearing the canvas as needed. Units are the caller's:
   * CSS px at pixel ratio `dpr`, or device px with `dpr` 1 (both Trades lists lay their rows out in device pixels). `ctx` is left at the
   * transform `dpr`. `bottom` is where the rows end: the canvas below it is cleared to `panel`.
   */
  plan(ctx: CanvasRenderingContext2D, look: string, items: readonly RowItem[], dpr: number, cssH: number, panel: string, bottom: number): boolean[] {
    const canvas = ctx.canvas, draw = new Array<boolean>(items.length).fill(true);
    let dy = NaN, grid = true;
    for (const it of items) if (!onGrid(it.y * dpr) || !onGrid((it.y + it.h) * dpr)) { grid = false; break; }
    if (grid && look === this.#look) for (const it of items) { if (it.fixed) continue; const was = this.#at.get(it.sig); if (was !== undefined) { dy = it.y - was.y; break; } }
    const dev = dy * dpr, whole = Math.round(dev);
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    if (!Number.isFinite(dy) || !onGrid(dev)) {
      ctx.fillStyle = panel; ctx.fillRect(0, 0, canvas.width, canvas.height);
      this.lastShift = NaN; this.wholeFrames++; this.rowsDrawn += items.length;
    } else {
      // The canvas onto itself (the browser copies the source first): every kept row moves to where it is drawn this frame.
      if (whole !== 0) ctx.drawImage(canvas, 0, 0, canvas.width, canvas.height, 0, whole, canvas.width, canvas.height);
      this.lastShift = whole;
      const damaged = (y0: number, y1: number): boolean => { for (const [a, b] of this.#damage) if (a < y1 && b > y0) return true; return false; };
      let drawn = 0;
      for (let i = 0; i < items.length; i++) {
        const it = items[i]!, was = this.#at.get(it.sig);
        // Kept: drawn last frame where this frame's shift took it (a fixed row: unshifted), its part on the canvas now all among what was
        // on the canvas then, nothing drawn over it there, and inside the canvas unless it holds still (a row cut by the bottom edge of a
        // live list stays kept; one a shift moves into or along an edge is drawn there, as a whole frame draws it).
        const moved = it.fixed ? (whole === 0 ? 0 : NaN) : dy;
        const v0 = Math.max(0, it.y), v1 = Math.min(cssH, it.y + it.h), cut = it.y < 0 || it.y + it.h > cssH;
        if (was === undefined || !(Math.abs(was.y + moved - it.y) < 1e-6) || v0 < was.v0 + moved - 1e-6 || v1 > was.v1 + moved + 1e-6 || damaged(was.v0, was.v1) || (cut && moved !== 0)) { drawn++; continue; }
        draw[i] = false; this.rowsKept++;
      }
      // Below the rows (the shift may have moved old rows there, a shorter list leaves them) and the strip a shift uncovered at the top.
      ctx.fillStyle = panel;
      const yb = Math.max(0, Math.round(bottom * dpr));
      if (yb < canvas.height) ctx.fillRect(0, yb, canvas.width, canvas.height - yb);
      if (whole > 0) ctx.fillRect(0, 0, canvas.width, Math.min(canvas.height, whole));
      this.partFrames++; this.rowsDrawn += drawn;
    }
    // A fixed row is drawn over whatever row scrolls under it: next frame those rows are drawn again (their pixels carry it).
    this.#damage = [];
    for (const it of items) if (it.fixed) this.#damage.push([it.y, it.y + it.h]);
    this.#at.clear();
    // A row is remembered when its top is on the canvas (one cut by the bottom edge too: it holds still in a live list); a row cut by the
    // top edge (a held list scrolled) is drawn again each frame.
    for (const it of items) { const v1 = Math.min(cssH, it.y + it.h); if (it.y >= 0 && v1 > it.y) this.#at.set(it.sig, { y: it.y, v0: it.y, v1 }); }
    this.#look = look;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    return draw;
  }
}
