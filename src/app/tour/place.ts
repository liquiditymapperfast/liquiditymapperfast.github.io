/**
 * Where the tour's card stands: beside what it points at, on the side that has room, never off the window. Pure arithmetic (no page), so it is
 * tested on its own; `tour.ts` measures and applies it.
 */
export interface Rect { x: number; y: number; w: number; h: number }
export interface Size { w: number; h: number }
export type Where = 'above' | 'below' | 'left' | 'right' | 'inside' | 'center';
/** The side a step would like its card on; `auto` takes the first with room (below or above a wide thing, beside a tall one). */
export type Prefer = 'auto' | 'above' | 'below' | 'left' | 'right' | 'inside';
export interface Placement { x: number; y: number; where: Where }

const clamp = (v: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, v));

/** The smallest rectangle holding all of `rects`, or null when there are none. */
export function union(rects: readonly Rect[]): Rect | null {
  if (!rects.length) return null;
  const x0 = Math.min(...rects.map(r => r.x)), y0 = Math.min(...rects.map(r => r.y));
  const x1 = Math.max(...rects.map(r => r.x + r.w)), y1 = Math.max(...rects.map(r => r.y + r.h));
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

/** `r` grown by `by` on every side. */
export const grow = (r: Rect, by: number): Rect => ({ x: r.x - by, y: r.y - by, w: r.w + 2 * by, h: r.h + 2 * by });

/** The part of `r` that is on the screen (null when none of it is). */
export function visiblePart(r: Rect, view: Size): Rect | null {
  const x0 = Math.max(0, r.x), y0 = Math.max(0, r.y), x1 = Math.min(view.w, r.x + r.w), y1 = Math.min(view.h, r.y + r.h);
  return x1 > x0 && y1 > y0 ? { x: x0, y: y0, w: x1 - x0, h: y1 - y0 } : null;
}

/**
 * The place for a card of size `card` in a window of size `view`, for a target `target` (null: the middle of the window). `gap` is the space left
 * between them, `margin` what is left to the window's edge. A side is used only if the whole card fits on it; when none does (a target as big as the
 * window), the card stands inside the target at its lower left corner.
 */
export function placeCard(target: Rect | null, card: Size, view: Size, prefer: Prefer = 'auto', gap = 14, margin = 12): Placement {
  const xMax = Math.max(margin, view.w - margin - card.w), yMax = Math.max(margin, view.h - margin - card.h);
  if (!target) return { x: Math.round(clamp((view.w - card.w) / 2, margin, xMax)), y: Math.round(clamp((view.h - card.h) * 0.38, margin, yMax)), where: 'center' };
  const room = {
    below: view.h - margin - (target.y + target.h + gap), above: target.y - gap - margin,
    right: view.w - margin - (target.x + target.w + gap), left: target.x - gap - margin,
  };
  const fits = (side: 'above' | 'below' | 'left' | 'right'): boolean => (side === 'below' || side === 'above' ? room[side] >= card.h : room[side] >= card.w);
  const tall = target.h > target.w * 1.5;
  const automatic: ('above' | 'below' | 'left' | 'right')[] = tall ? ['right', 'left', 'below', 'above'] : ['below', 'above', 'right', 'left'];
  const order = prefer === 'auto' || prefer === 'inside' ? automatic : [prefer, ...automatic.filter(side => side !== prefer)];
  const side = prefer === 'inside' ? undefined : order.find(fits);
  const centreX = clamp(target.x + target.w / 2 - card.w / 2, margin, xMax), centreY = clamp(target.y + target.h / 2 - card.h / 2, margin, yMax);
  switch (side) {
    case 'below': return { x: Math.round(centreX), y: Math.round(target.y + target.h + gap), where: 'below' };
    case 'above': return { x: Math.round(centreX), y: Math.round(target.y - gap - card.h), where: 'above' };
    case 'right': return { x: Math.round(target.x + target.w + gap), y: Math.round(centreY), where: 'right' };
    case 'left': return { x: Math.round(target.x - gap - card.w), y: Math.round(centreY), where: 'left' };
    default: {
      // Inside the target, at its lower left corner, kept on the window (a target that runs past it leaves the card on what is shown).
      const shown = visiblePart(target, view) ?? target, inset = 16;
      return { x: Math.round(clamp(shown.x + inset, margin, xMax)), y: Math.round(clamp(shown.y + shown.h - card.h - inset, margin, yMax)), where: 'inside' };
    }
  }
}
