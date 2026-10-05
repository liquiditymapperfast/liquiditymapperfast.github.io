/**
 * Geometry and drawing for the screenshot editor: rectangles and their resize handles, and the annotation shapes with the code that
 * paints them. Coordinates inside shapes are in CSS pixels relative to the top-left of the selected area, so a shape means the same at
 * any device pixel ratio; `scale` turns them into canvas pixels. Nothing here touches the page.
 */

export interface Pt { x: number; y: number }
export interface Rect { x: number; y: number; w: number; h: number }

/** The rectangle spanned by two corners, whichever way the pointer was dragged. */
export function rectFrom(a: Pt, b: Pt): Rect { return { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), w: Math.abs(b.x - a.x), h: Math.abs(b.y - a.y) }; }

export function clampRect(r: Rect, bounds: { w: number; h: number }): Rect {
  const w = Math.min(r.w, bounds.w), h = Math.min(r.h, bounds.h);
  return { x: Math.max(0, Math.min(r.x, bounds.w - w)), y: Math.max(0, Math.min(r.y, bounds.h - h)), w, h };
}

export type Handle = 'nw' | 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w';
export const HANDLES: readonly Handle[] = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'];

export function handlePoint(r: Rect, h: Handle): Pt {
  const cx = r.x + r.w / 2, cy = r.y + r.h / 2;
  switch (h) {
    case 'nw': return { x: r.x, y: r.y }; case 'n': return { x: cx, y: r.y }; case 'ne': return { x: r.x + r.w, y: r.y };
    case 'e': return { x: r.x + r.w, y: cy }; case 'se': return { x: r.x + r.w, y: r.y + r.h }; case 's': return { x: cx, y: r.y + r.h };
    case 'sw': return { x: r.x, y: r.y + r.h }; case 'w': return { x: r.x, y: cy };
  }
}

/** The handle within `radius` of `p`, nearest first, or null. */
export function hitHandle(r: Rect, p: Pt, radius = 9): Handle | null {
  let best: Handle | null = null, bestD = radius;
  for (const h of HANDLES) { const q = handlePoint(r, h), d = Math.hypot(q.x - p.x, q.y - p.y); if (d <= bestD) { best = h; bestD = d; } }
  return best;
}

export const CURSORS: Readonly<Record<Handle, string>> = { nw: 'nwse-resize', se: 'nwse-resize', ne: 'nesw-resize', sw: 'nesw-resize', n: 'ns-resize', s: 'ns-resize', e: 'ew-resize', w: 'ew-resize' };

/** `r` with the edge or corner `h` moved to `p`, never smaller than `min` and kept inside `bounds`. */
export function resizeRect(r: Rect, h: Handle, p: Pt, bounds: { w: number; h: number }, min = 12): Rect {
  let left = r.x, top = r.y, right = r.x + r.w, bottom = r.y + r.h;
  const px = Math.max(0, Math.min(p.x, bounds.w)), py = Math.max(0, Math.min(p.y, bounds.h));
  if (h.includes('w')) left = Math.min(px, right - min);
  if (h.includes('e')) right = Math.max(px, left + min);
  if (h.includes('n')) top = Math.min(py, bottom - min);
  if (h.includes('s')) bottom = Math.max(py, top + min);
  return { x: left, y: top, w: right - left, h: bottom - top };
}

/** The corner of a square from `a` toward `p` (the longer side wins). */
export function squareTo(a: Pt, p: Pt): Pt {
  const d = Math.max(Math.abs(p.x - a.x), Math.abs(p.y - a.y));
  return { x: a.x + (p.x >= a.x ? d : -d), y: a.y + (p.y >= a.y ? d : -d) };
}
/** `p` moved to the nearest multiple of 45 degrees from `a`, keeping its distance. */
export function snapAngle(a: Pt, p: Pt): Pt {
  const dx = p.x - a.x, dy = p.y - a.y, step = Math.PI / 4, angle = Math.round(Math.atan2(dy, dx) / step) * step, length = Math.hypot(dx, dy);
  return { x: a.x + length * Math.cos(angle), y: a.y + length * Math.sin(angle) };
}

export const inside = (r: Rect, p: Pt): boolean => p.x >= r.x && p.x <= r.x + r.w && p.y >= r.y && p.y <= r.y + r.h;

/** Where the floating toolbar goes for a selection: under it, right-aligned; above it when there is no room; inside its bottom edge when the selection fills the screen. */
export function toolbarPlacement(sel: Rect, bar: { w: number; h: number }, screen: { w: number; h: number }): Pt {
  const gap = 10, margin = 8;
  const left = Math.max(margin, Math.min(sel.x + sel.w - bar.w, screen.w - bar.w - margin));
  if (sel.y + sel.h + gap + bar.h <= screen.h - margin) return { x: left, y: sel.y + sel.h + gap };
  if (sel.y - gap - bar.h >= margin) return { x: left, y: sel.y - gap - bar.h };
  return { x: left, y: Math.max(margin, Math.min(sel.y + sel.h - bar.h - gap, screen.h - bar.h - margin)) };
}

/** The two barbs of an arrow head at `b` for a line from `a`: length grows with the stroke width but never exceeds a third of the arrow. */
export function arrowHead(a: Pt, b: Pt, width: number): [Pt, Pt] {
  const angle = Math.atan2(b.y - a.y, b.x - a.x), length = Math.min(Math.max(12, width * 4.5), Math.hypot(b.x - a.x, b.y - a.y) / 3 + 6), spread = Math.PI / 7;
  return [{ x: b.x - length * Math.cos(angle - spread), y: b.y - length * Math.sin(angle - spread) }, { x: b.x - length * Math.cos(angle + spread), y: b.y - length * Math.sin(angle + spread) }];
}

export const COLORS: readonly string[] = ['#ff3b30', '#ff9f0a', '#ffd60a', '#30d158', '#0a84ff', '#ffffff', '#111111'];
export const WIDTHS: readonly number[] = [2, 4, 8];

export type Tool = 'move' | 'pen' | 'line' | 'arrow' | 'rect' | 'marker' | 'text' | 'pixelate' | 'blur';
export type Shape =
  | { kind: 'pen' | 'marker'; points: Pt[]; color: string; width: number }
  | { kind: 'line' | 'arrow' | 'rect'; a: Pt; b: Pt; color: string; width: number }
  | { kind: 'text'; at: Pt; text: string; color: string; size: number }
  | { kind: 'pixelate' | 'blur'; rect: Rect; strength: number };

/** A shape big enough to keep (a click without a drag is not a rectangle). */
export function worthKeeping(shape: Shape): boolean {
  switch (shape.kind) {
    case 'pen': case 'marker': return shape.points.length > 1;
    case 'line': case 'arrow': return Math.hypot(shape.b.x - shape.a.x, shape.b.y - shape.a.y) >= 4;
    case 'rect': return Math.abs(shape.b.x - shape.a.x) >= 3 && Math.abs(shape.b.y - shape.a.y) >= 3;
    case 'text': return shape.text.trim().length > 0;
    case 'pixelate': case 'blur': return shape.rect.w >= 4 && shape.rect.h >= 4;
  }
}

/** The text size for a stroke width (the same three steps the person picks). */
export const textSize = (width: number): number => width <= 2 ? 16 : width <= 4 ? 22 : 32;

/** Pixelate and blur read the picture under them: `base` is the unmarked selection at `scale` canvas pixels per CSS pixel. */
export function drawShape(ctx: CanvasRenderingContext2D, shape: Shape, base: CanvasImageSource, scale: number): void {
  ctx.save();
  ctx.scale(scale, scale);
  ctx.lineCap = 'round'; ctx.lineJoin = 'round';
  switch (shape.kind) {
    case 'pen': case 'marker': {
      const marker = shape.kind === 'marker';
      ctx.strokeStyle = shape.color; ctx.lineWidth = marker ? shape.width * 4 : shape.width;
      if (marker) { ctx.globalAlpha = 0.38; ctx.lineCap = 'butt'; }
      ctx.beginPath();
      shape.points.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
      ctx.stroke();
      break;
    }
    case 'line': case 'arrow': {
      ctx.strokeStyle = shape.color; ctx.fillStyle = shape.color; ctx.lineWidth = shape.width;
      ctx.beginPath(); ctx.moveTo(shape.a.x, shape.a.y); ctx.lineTo(shape.b.x, shape.b.y); ctx.stroke();
      if (shape.kind === 'arrow') {
        const [l, r] = arrowHead(shape.a, shape.b, shape.width);
        ctx.beginPath(); ctx.moveTo(shape.b.x, shape.b.y); ctx.lineTo(l.x, l.y); ctx.lineTo(r.x, r.y); ctx.closePath(); ctx.fill();
        ctx.stroke();
      }
      break;
    }
    case 'rect': {
      const r = rectFrom(shape.a, shape.b);
      ctx.strokeStyle = shape.color; ctx.lineWidth = shape.width; ctx.lineJoin = 'miter';
      ctx.strokeRect(r.x, r.y, r.w, r.h);
      break;
    }
    case 'text': {
      ctx.font = `700 ${shape.size}px ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif`; ctx.textBaseline = 'top'; ctx.fillStyle = shape.color;
      // A thin contrasting edge keeps text readable over a heatmap of any colour.
      ctx.lineWidth = Math.max(2, shape.size / 8); ctx.strokeStyle = shape.color === '#111111' ? 'rgba(255,255,255,.85)' : 'rgba(0,0,0,.55)'; ctx.lineJoin = 'round';
      shape.text.split('\n').forEach((line, i) => { ctx.strokeText(line, shape.at.x, shape.at.y + i * shape.size * 1.2); ctx.fillText(line, shape.at.x, shape.at.y + i * shape.size * 1.2); });
      break;
    }
    case 'pixelate': case 'blur': {
      const r = shape.rect;
      ctx.beginPath(); ctx.rect(r.x, r.y, r.w, r.h); ctx.clip();
      // Both are the same trick: draw the region small, then draw that back large. Without smoothing the blocks stay square (pixelate);
      // with it they melt into each other (blur). It works in every browser, which a canvas filter does not.
      const factor = Math.max(2, shape.strength), sw = Math.max(1, Math.round(r.w * scale / factor)), sh = Math.max(1, Math.round(r.h * scale / factor));
      const small = document.createElement('canvas'); small.width = sw; small.height = sh;
      const sctx = small.getContext('2d')!;
      sctx.imageSmoothingEnabled = true; sctx.drawImage(base, r.x * scale, r.y * scale, r.w * scale, r.h * scale, 0, 0, sw, sh);
      ctx.imageSmoothingEnabled = shape.kind === 'blur'; ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(small, 0, 0, sw, sh, r.x, r.y, r.w, r.h);
      break;
    }
  }
  ctx.restore();
}

/** `liquiditymapperfast-2026-10-05-1432-07.png` */
export function fileName(when: Date): string {
  const p = (n: number): string => String(n).padStart(2, '0');
  return `liquiditymapperfast-${when.getFullYear()}-${p(when.getMonth() + 1)}-${p(when.getDate())}-${p(when.getHours())}${p(when.getMinutes())}-${p(when.getSeconds())}.png`;
}
