import { chromeFor, type Chrome, type Palette } from './theme.ts';
import { drawVenueMark } from './venue-marks.ts';

/**
 * The small box drawn on a canvas beside the pointer to say what is under it: the Mirror comparison, a footprint row, a bar statistic,
 * an order-book cell. A line is either plain text or a label with its value (the values line up on the right), and a long sentence can
 * be told to wrap. Building the lines and laying them out are plain functions, so they are tested without a canvas.
 */
export type InfoColor = 'above' | 'below' | 'buy' | 'sell' | 'muted' | 'text';
export interface InfoLine {
  text: string;
  /** Said at the left in the muted colour, with `text` as its value at the right. */
  label?: string;
  color?: InfoColor;
  bold?: boolean;
  /** Break `text` into lines no wider than the box's wrap width. */
  wrap?: boolean;
  /** A hairline above this line, to set a group of lines apart. */
  rule?: boolean;
  /** An exchange (an instrument id or a venue) whose mark goes first on the line: before the label, or before the text of a plain line. Not on a wrapped line. */
  mark?: string;
}
export interface InfoRow { label?: string; text: string; color: InfoColor; bold: boolean; rule: boolean; mark?: string }

/** The side of a mark in the box, and the space it takes before its text. */
export const MARK = Object.freeze({ size: 12, room: 16 });

export const INFO = Object.freeze({ lineH: 16, pad: 8, gap: 14, rule: 5, wrapAt: 250 });

/** What a piece of text is, which decides the face it is drawn in: a label and a plain sentence in the sans face, a value in the monospace one. */
export type InfoKind = 'label' | 'value' | 'plain';

/** Wrap, measure and size `lines`; `measure(text, bold, kind)` is the text's width in px. */
export function layoutInfo(measure: (text: string, bold: boolean, kind: InfoKind) => number, lines: readonly InfoLine[], wrapAt: number = INFO.wrapAt): { rows: InfoRow[]; labelW: number; width: number; height: number } {
  const rows: InfoRow[] = [];
  for (const line of lines) {
    const base = { color: line.color ?? 'text', bold: line.bold === true, rule: line.rule === true };
    if (line.label !== undefined || !line.wrap || measure(line.text, base.bold, 'plain') <= wrapAt) { rows.push({ ...base, text: line.text, ...(line.label !== undefined ? { label: line.label } : {}), ...(line.mark ? { mark: line.mark } : {}) }); continue; }
    let current = '', first = true;
    const flush = (): void => { rows.push({ ...base, rule: base.rule && first, text: current }); first = false; };
    for (const word of line.text.split(' ')) {
      const next = current ? `${current} ${word}` : word;
      if (current && measure(next, base.bold, 'plain') > wrapAt) { flush(); current = word; } else current = next;
    }
    if (current) flush();
  }
  let labelW = 0, valueW = 0, plainW = 0;
  for (const row of rows) {
    const mark = row.mark ? MARK.room : 0;
    if (row.label !== undefined) { labelW = Math.max(labelW, measure(row.label, false, 'label') + mark); valueW = Math.max(valueW, measure(row.text, row.bold, 'value')); }
    else plainW = Math.max(plainW, measure(row.text, row.bold, 'plain') + mark);
  }
  const labeled = labelW > 0 || valueW > 0 ? labelW + INFO.gap + valueW : 0;
  const height = rows.reduce<number>((sum, row) => sum + INFO.lineH + (row.rule ? INFO.rule : 0), INFO.pad);
  return { rows, labelW, width: Math.max(labeled, plainW) + INFO.pad * 2, height };
}

const SANS = 'ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif', MONO = 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace';
const fontOf = (bold: boolean, kind: InfoKind): string => `${bold ? '600 ' : ''}11px ${kind === 'value' ? MONO : SANS}`;

/** The theme's edge and shadow tones for a palette, worked out once. */
const chromes = new WeakMap<Palette, Chrome>();
const chromeOf = (p: Palette): Chrome => { let c = chromes.get(p); if (!c) { c = chromeFor(p); chromes.set(p, c); } return c; };

export interface InfoOptions {
  /** How far the box stands off the pointer sideways, where something under it (a bubble) is wider than the usual 14 px. */
  gap?: number;
  /** Where the box goes against the pointer: centred on its height, or extending down or up from it (clear of whatever is beside it). */
  placement?: 'center' | 'down' | 'up';
  /** The colour for each kind of line, where the caller's palette differs from the default (above = ask, below = bid, buy and sell = the candle colours). */
  pick?: (color: InfoColor) => string;
  /** The box's edge, where it should say what kind of box it is. */
  edge?: string;
}

/** Draw `lines` in a box beside (x, y), kept inside `bounds`. */
export function paintInfoBox(ctx: CanvasRenderingContext2D, lines: readonly InfoLine[], x: number, y: number, bounds: { x0: number; y0: number; x1: number; y1: number }, p: Palette, options: InfoOptions = {}): void {
  if (!lines.length) return;
  const pick = options.pick ?? ((c: InfoColor): string => c === 'above' ? p.ask : c === 'below' ? p.bid : c === 'buy' ? p.candleUp : c === 'sell' ? p.candleDown : c === 'muted' ? p.muted : p.text);
  ctx.save(); ctx.textBaseline = 'middle'; ctx.textAlign = 'left';
  const { rows, width: w, height: h } = layoutInfo((text, bold, kind) => { ctx.font = fontOf(bold, kind); return ctx.measureText(text).width; }, lines);
  const { pad, lineH } = INFO;
  const gap = options.gap ?? 14;
  let bx = x + gap; if (bx + w > bounds.x1) bx = x - gap - w;
  bx = Math.max(bounds.x0 + 2, Math.min(bx, bounds.x1 - w - 2));
  const placement = options.placement ?? 'center';
  const wanted = placement === 'down' ? y + 14 : placement === 'up' ? y - 14 - h : y - h / 2;
  const by = Math.max(bounds.y0 + 2, Math.min(wanted, bounds.y1 - h - 2));
  // A hard 2 px shadow, as a tooltip has on an old desktop: cheaper to draw than a blur and it keeps the edge crisp.
  const chrome = chromeOf(p);
  ctx.fillStyle = chrome.shadow; ctx.fillRect(bx + 2, by + 2, w, h);
  ctx.globalAlpha = 0.97; ctx.fillStyle = p.panel; ctx.fillRect(bx, by, w, h);
  ctx.globalAlpha = 1; ctx.strokeStyle = options.edge ?? chrome.edge; ctx.lineWidth = 1; ctx.strokeRect(bx + 0.5, by + 0.5, w - 1, h - 1);
  let top = by + pad / 2;
  for (const row of rows) {
    if (row.rule) { ctx.globalAlpha = 0.5; ctx.strokeStyle = p.line; ctx.beginPath(); ctx.moveTo(bx + pad, Math.round(top + 2) + 0.5); ctx.lineTo(bx + w - pad, Math.round(top + 2) + 0.5); ctx.stroke(); ctx.globalAlpha = 1; top += INFO.rule; }
    const mid = top + lineH / 2;
    // A mark goes first on its line, and the line's first text after it.
    const indent = row.mark ? MARK.room : 0;
    if (row.mark) drawVenueMark(ctx, row.mark, bx + pad + MARK.size / 2, mid, MARK.size);
    if (row.label !== undefined) {
      ctx.font = fontOf(false, 'label'); ctx.fillStyle = p.muted; ctx.textAlign = 'left'; ctx.fillText(row.label, bx + pad + indent, mid);
      ctx.font = fontOf(row.bold, 'value'); ctx.fillStyle = pick(row.color); ctx.textAlign = 'right'; ctx.fillText(row.text, bx + w - pad, mid);
    } else {
      ctx.font = fontOf(row.bold, 'plain'); ctx.fillStyle = pick(row.color); ctx.textAlign = 'left'; ctx.fillText(row.text, bx + pad + indent, mid);
    }
    top += lineH;
  }
  ctx.restore();
}
