import type { Palette } from './theme.ts';
import { price as fmtPrice, usd } from './format.ts';
import { t } from './i18n.ts';

/**
 * Mirror hover: pointing at a price highlights the band from the mid to that price and the equally wide band on the other
 * side, dims everything outside, and compares the liquidity inside the two bands, so moving the pointer outward shows how
 * the balance changes with distance (the same comparison as the cumulative curves of a liquidation chart).
 */
export interface MirrorStats {
  mid: number;
  /** The hovered price and its mirror image about the mid. */
  price: number;
  mirror: number;
  /** Distance of the hovered price from the mid. */
  distance: number;
  distanceBp: number;
  hoveredSide: 'above' | 'below';
  /** USD inside the band on the hovered side and on the opposite side. */
  hovered: number;
  opposite: number;
  aboveUsd: number;
  belowUsd: number;
  /** Larger over smaller (Infinity when one side is empty). */
  ratio: number;
  dominant: 'this' | 'opposite' | 'balanced' | 'none';
  /** True when part of a band lay outside the data that was available. */
  clipped: boolean;
}

const BALANCED = 1.02;

export function mirrorStats(mid: number, price: number, aboveUsd: number, belowUsd: number, clipped = false): MirrorStats | null {
  const distance = Math.abs(price - mid);
  if (!(mid > 0) || !(distance > 0) || !Number.isFinite(price)) return null;
  const hoveredSide = price >= mid ? 'above' : 'below';
  const hovered = hoveredSide === 'above' ? aboveUsd : belowUsd, opposite = hoveredSide === 'above' ? belowUsd : aboveUsd;
  const big = Math.max(hovered, opposite), small = Math.min(hovered, opposite);
  const ratio = big === 0 ? 1 : small === 0 ? Infinity : big / small;
  const dominant = big === 0 ? 'none' : ratio < BALANCED ? 'balanced' : hovered > opposite ? 'this' : 'opposite';
  return { mid, price, mirror: 2 * mid - price, distance, distanceBp: distance / mid * 1e4, hoveredSide, hovered, opposite, aboveUsd, belowUsd, ratio, dominant, clipped };
}

export function ratioText(ratio: number): string {
  if (!Number.isFinite(ratio)) return t('all of it');
  return `${ratio >= 10 ? ratio.toFixed(1) : ratio.toFixed(2)}x`;
}

export interface SideNames { above: string; below: string }
export interface MirrorLine { text: string; color?: 'above' | 'below' | 'muted' | 'text'; bold?: boolean }

/** The text printed beside the pointer. */
export function mirrorLines(stats: MirrorStats, names: SideNames, title?: string): MirrorLine[] {
  const thisName = stats.hoveredSide === 'above' ? names.above : names.below, oppName = stats.hoveredSide === 'above' ? names.below : names.above;
  const thisColor = stats.hoveredSide, oppColor = stats.hoveredSide === 'above' ? 'below' : 'above';
  const lines: MirrorLine[] = [];
  if (title) lines.push({ text: title, bold: true });
  lines.push({ text: t('±{distance} ({bp} bp) from {mid}', { distance: fmtPrice(stats.distance), bp: stats.distanceBp < 10 ? stats.distanceBp.toFixed(1) : Math.round(stats.distanceBp), mid: fmtPrice(stats.mid) }), color: 'muted' });
  lines.push({ text: t('{side} (this side)  ${value}', { side: thisName, value: usd(stats.hovered) }), color: thisColor });
  lines.push({ text: t('{side} (opposite)  ${value}', { side: oppName, value: usd(stats.opposite) }), color: oppColor });
  if (stats.dominant === 'none') lines.push({ text: t('No liquidity in this range'), color: 'muted' });
  else if (stats.dominant === 'balanced') lines.push({ text: t('Balanced'), color: 'text', bold: true });
  else if (stats.dominant === 'this') lines.push({ text: Number.isFinite(stats.ratio) ? t('This side has {ratio} more', { ratio: ratioText(stats.ratio) }) : t('Only this side has liquidity'), color: thisColor, bold: true });
  else lines.push({ text: Number.isFinite(stats.ratio) ? t('Opposite side has {ratio} more', { ratio: ratioText(stats.ratio) }) : t('Only the opposite side has liquidity'), color: oppColor, bold: true });
  if (stats.clipped) lines.push({ text: t('part of the range is outside the data'), color: 'muted' });
  return lines;
}

/** Draw `lines` in a panel beside (x, y), kept inside `bounds`. `placement` extends the panel down or up from y (toward the inside of a band, clear of its edge labels) instead of centring it. */
export function paintMirrorBox(ctx: CanvasRenderingContext2D, lines: MirrorLine[], x: number, y: number, bounds: { x0: number; y0: number; x1: number; y1: number }, p: Palette,
  pick: (color: NonNullable<MirrorLine['color']>) => string, placement: 'center' | 'down' | 'up' = 'center'): void {
  ctx.save(); ctx.textBaseline = 'middle'; ctx.textAlign = 'left';
  const lineH = 16, pad = 8;
  let width = 0;
  for (const line of lines) { ctx.font = `${line.bold ? '600 ' : ''}11px ui-sans-serif, system-ui, sans-serif`; width = Math.max(width, ctx.measureText(line.text).width); }
  const w = width + pad * 2, h = lines.length * lineH + pad;
  let bx = x + 14; if (bx + w > bounds.x1) bx = x - 14 - w;
  bx = Math.max(bounds.x0 + 2, Math.min(bx, bounds.x1 - w - 2));
  const wanted = placement === 'down' ? y + 14 : placement === 'up' ? y - 14 - h : y - h / 2;
  const by = Math.max(bounds.y0 + 2, Math.min(wanted, bounds.y1 - h - 2));
  ctx.globalAlpha = 0.96; ctx.fillStyle = p.panel; ctx.fillRect(bx, by, w, h);
  ctx.globalAlpha = 1; ctx.strokeStyle = p.muted; ctx.lineWidth = 1; ctx.strokeRect(bx + 0.5, by + 0.5, w - 1, h - 1);
  lines.forEach((line, i) => {
    ctx.font = `${line.bold ? '600 ' : ''}11px ui-sans-serif, system-ui, sans-serif`;
    ctx.fillStyle = pick(line.color ?? 'text'); ctx.fillText(line.text, bx + pad, by + pad / 2 + lineH * (i + 0.5));
  });
  ctx.restore();
}

/** Shade everything in [y0, y1) outside the highlighted band [bandTop, bandBottom] so the inner layers stand out. */
export function dimOutside(ctx: CanvasRenderingContext2D, x: number, w: number, y0: number, y1: number, bandTop: number, bandBottom: number, bg: string, alpha = 0.6): void {
  ctx.save(); ctx.fillStyle = bg; ctx.globalAlpha = alpha;
  const top = Math.max(y0, Math.min(y1, bandTop)), bottom = Math.max(y0, Math.min(y1, bandBottom));
  if (top > y0) ctx.fillRect(x, y0, w, top - y0);
  if (bottom < y1) ctx.fillRect(x, bottom, w, y1 - bottom);
  ctx.restore();
}

/** Distance of the hovered price from the mid as printed on the band labels: 5.8%, 0.35%. */
export function percentText(stats: MirrorStats): string {
  const pct = stats.distance / stats.mid * 100;
  return `${pct < 1 ? pct.toFixed(2) : pct.toFixed(1)}%`;
}

export interface BandEdge { y: number; color: string; label: string }

/**
 * Frame the selected band: a tint over the band, side borders, a solid border line at each
 * edge in that side's colour, and a pill at the right end of each line giving the cumulative size and the distance.
 * `top` must have the smaller y. Labels sit just outside the band and move inside when there is no room.
 */
export function paintBand(ctx: CanvasRenderingContext2D, p: Palette, x: number, w: number, top: BandEdge, bottom: BandEdge, clip: { y0: number; y1: number }): void {
  ctx.save();
  const yTop = Math.round(top.y) + 0.5, yBottom = Math.round(bottom.y) + 0.5;
  ctx.globalAlpha = p.dark ? 0.07 : 0.05; ctx.fillStyle = p.text; ctx.fillRect(x, yTop, w, yBottom - yTop);
  ctx.globalAlpha = 0.4; ctx.strokeStyle = p.text; ctx.lineWidth = 1; ctx.beginPath();
  ctx.moveTo(x + 0.5, yTop); ctx.lineTo(x + 0.5, yBottom); ctx.moveTo(x + w - 0.5, yTop); ctx.lineTo(x + w - 0.5, yBottom); ctx.stroke();
  ctx.globalAlpha = 1; ctx.lineWidth = 1.5;
  for (const edge of [top, bottom]) { ctx.strokeStyle = edge.color; ctx.beginPath(); const y = Math.round(edge.y) + 0.5; ctx.moveTo(x, y); ctx.lineTo(x + w, y); ctx.stroke(); }
  ctx.font = '10px ui-monospace, SFMono-Regular, Menlo, monospace'; ctx.textBaseline = 'middle'; ctx.textAlign = 'right';
  const pill = (edge: BandEdge, above: boolean) => {
    const text = edge.label, tw = ctx.measureText(text).width + 10, h = 15, y = Math.round(edge.y) + 0.5;
    let by = above ? y - h - 1 : y + 2;
    if (above ? by < clip.y0 : by + h > clip.y1) by = above ? y + 2 : y - h - 1;
    const bx = Math.max(x + 2, x + w - tw - 3);
    ctx.globalAlpha = 0.97; ctx.fillStyle = p.panel; ctx.fillRect(bx, by, tw, h);
    ctx.globalAlpha = 1; ctx.strokeStyle = edge.color; ctx.lineWidth = 1; ctx.strokeRect(bx + 0.5, by + 0.5, tw - 1, h - 1);
    ctx.fillStyle = p.text; ctx.fillText(text, bx + tw - 5, by + h / 2 + 0.5);
  };
  pill(top, true); pill(bottom, false);
  ctx.restore();
}
