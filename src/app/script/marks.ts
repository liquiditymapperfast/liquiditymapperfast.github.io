import type { InfoLine } from '../infobox.ts';
import type { PlotOut } from './protocol.ts';
import type { MarkBox } from './paint.ts';

/**
 * The marks a script drew (`mark(...)`), as the pointer finds them: where each was drawn, and what its popup says. Pure, so the hit test and
 * the lines are tested without a canvas.
 */

/** A mark where it was drawn: its box, its candle, the script and plot it belongs to, and its colour there. */
export interface DrawnMark { box: MarkBox; id: string; name: string; plot: PlotOut; color: string }

/** How far past its box a mark still answers the pointer (px): a little for a mouse, more for a finger. */
export const MARK_SLOP = 3, MARK_SLOP_TOUCH = 10;

/** The mark under `x`, `y`: the one drawn last (on top) whose box, grown by `slop`, holds the point; null where none does. */
export function markAt(marks: readonly DrawnMark[], x: number, y: number, slop: number): DrawnMark | null {
  for (let k = marks.length - 1; k >= 0; k--) {
    const b = marks[k]!.box;
    if (x >= b.x - slop && x <= b.x + b.w + slop && y >= b.y - slop && y <= b.y + b.h + slop) return marks[k]!;
  }
  return null;
}

/**
 * The mark under `x`, `y`: one whose box holds the point (the one drawn last, as `markAt`), else the nearest whose box grown by `slop` does.
 * Tags stand a few pixels apart, closer than a finger's slop: the first test alone gave a tap on one tag the tip of the tag under it.
 */
export function markNearest(marks: readonly DrawnMark[], x: number, y: number, slop: number): DrawnMark | null {
  const on = markAt(marks, x, y, 0);
  if (on || slop <= 0) return on;
  let best: DrawnMark | null = null, far = Infinity;
  for (const m of marks) {
    const b = m.box, dx = Math.max(b.x - x, 0, x - b.x - b.w), dy = Math.max(b.y - y, 0, y - b.y - b.h);
    if (dx > slop || dy > slop) continue;
    const d = Math.hypot(dx, dy);
    if (d <= far) { best = m; far = d; }
  }
  return best;
}

/**
 * A mark's popup: its text (in `tone`: on the map `above`, which the map paints in the mark's colour), what it says (`tip`, each line of it
 * wrapped), then the script's name. A mark with neither text nor tip says its plot's title, or the script's name alone.
 */
export function markLines(m: DrawnMark, tone: InfoLine['color'] = 'above'): InfoLine[] {
  const i = m.box.i, label = m.plot.texts?.[i] ?? '', tip = m.plot.tips?.[i] ?? '';
  const out: InfoLine[] = [{ text: label || m.plot.title || m.name, bold: true, color: tone }];
  for (const line of tip.split('\n')) if (line.trim()) out.push({ text: line, wrap: true });
  if (label || m.plot.title) out.push({ text: m.name, color: 'muted', rule: true });
  return out;
}

/** What a mark plot reads at candle `i` in a popup or the legend: its text, or nothing where it has no mark there. */
export function markText(plot: PlotOut, i: number): string {
  if (i < 0 || !Number.isFinite(plot.fields.value?.[i] ?? NaN)) return '';
  return plot.texts?.[i] || '•';
}
