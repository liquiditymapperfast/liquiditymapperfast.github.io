import { t } from '../i18n.ts';
import { price as fmtPrice } from '../format.ts';
import type { Palette } from '../theme.ts';
import type { View } from '../view.ts';
import type { KeyTag } from '../keylevels/paint.ts';
import type { VwapPoint } from './vwap.ts';
import type { VwapSettings } from './settings.ts';

/** One VWAP to draw: the session's (one line per session) or an anchor's, its points, and its name. */
export interface VwapLine {
  kind: 'session' | 'anchor';
  /** The anchor's number (1 to 4), or 0 for a session. */
  n: number;
  points: readonly VwapPoint[];
  /** Whether it runs to now (the session under way, an anchor): its last value gets a tag on the price axis. */
  live: boolean;
  key: string;
}

/** Tag and label order against the key levels' (0 to 11, earlier periods' from 20): the session VWAP with the previous day's levels, anchors after the opens. */
const RANK = { session: 1.5, anchor: 6.5 } as const;

export const vwapCode = (line: Pick<VwapLine, 'kind' | 'n'>): string => line.kind === 'session' ? t('VWAP') : `${t('AVWAP')} ${line.n}`;

/**
 * Draw each VWAP as a line in the palette's VWAP colour over a halo: the session's solid, with its bands (±1 and ±2 standard deviations,
 * short dashes, fainter), an anchor's dash-dotted with a small triangle where it starts; the name and price at the right end of the ones running to now. Returns the
 * tags wanted on the price axis (placed with the key levels' tags).
 */
export function paintVwap(ctx: CanvasRenderingContext2D, lines: readonly VwapLine[], v: View, pw: number, ph: number, p: Palette, s: VwapSettings): KeyTag[] {
  const tags: KeyTag[] = [];
  if (!lines.length) return tags;
  const halo = p.dark ? 'rgba(0,0,0,0.55)' : 'rgba(255,255,255,0.75)';
  const path = (pts: readonly VwapPoint[], value: (q: VwapPoint) => number): void => {
    ctx.beginPath();
    let started = false;
    for (const q of pts) {
      const x = v.xOf(q.t, pw), y = v.yOf(value(q), ph);
      if (!started) { ctx.moveTo(x, y); started = true; } else ctx.lineTo(x, y);
    }
  };
  const stroke = (pts: readonly VwapPoint[], value: (q: VwapPoint) => number, width: number, dash: number[], alpha: number): void => {
    ctx.globalAlpha = alpha; ctx.setLineDash(dash);
    path(pts, value); ctx.strokeStyle = halo; ctx.lineWidth = width + 2; ctx.stroke();
    ctx.strokeStyle = p.vwap; ctx.lineWidth = width; ctx.stroke();
  };
  const labels: { text: string; y: number; rank: number }[] = [];
  ctx.save(); ctx.beginPath(); ctx.rect(0, 0, pw, ph); ctx.clip(); ctx.lineJoin = 'round';
  for (const line of lines) {
    // Only the points on the chart and one either side, so a long session costs what is drawn.
    const pts = visible(line.points, v.t0, v.t1);
    if (pts.length < 1) continue;
    if (line.kind === 'session') for (let k = s.bands; k >= 1; k--) {
      stroke(pts, q => q.vwap + k * q.sd, 1.1, [3, 4], k === 1 ? 0.8 : 0.55);
      stroke(pts, q => q.vwap - k * q.sd, 1.1, [3, 4], k === 1 ? 0.8 : 0.55);
    }
    stroke(pts, q => q.vwap, line.kind === 'session' ? 1.8 : 1.5, line.kind === 'session' ? [] : [9, 3, 2, 3], 1);
    const first = line.points[0]!;
    if (line.kind === 'anchor' && first.t >= v.t0 && first.t <= v.t1) { // where it starts: a small triangle under the line
      const x = v.xOf(first.t, pw), y = v.yOf(first.vwap, ph) + 7;
      ctx.globalAlpha = 1; ctx.setLineDash([]); ctx.beginPath(); ctx.moveTo(x, y - 5); ctx.lineTo(x + 5, y + 4); ctx.lineTo(x - 5, y + 4); ctx.closePath();
      ctx.fillStyle = p.vwap; ctx.fill(); ctx.strokeStyle = halo; ctx.lineWidth = 1; ctx.stroke();
    }
    if (!line.live) continue;
    const last = line.points[line.points.length - 1]!, y = v.yOf(last.vwap, ph), code = vwapCode(line), rank = RANK[line.kind];
    if (s.labels && v.xOf(last.t, pw) <= pw + 4 && v.xOf(last.t, pw) > 40) labels.push({ text: `${code} ${fmtPrice(last.vwap)}`, y, rank });
    if (s.tags) tags.push({ key: `vwap|${line.key}`, y, rank, text: code, older: false, color: p.vwap });
  }
  ctx.setLineDash([]); ctx.globalAlpha = 1;
  // The names at the right edge, the session's first; one that would cover another is left out.
  ctx.font = '600 10px ui-sans-serif, system-ui, sans-serif'; ctx.textAlign = 'right'; ctx.textBaseline = 'middle';
  const boxes: { y0: number; y1: number }[] = [];
  for (const l of labels.sort((a, b) => a.rank - b.rank)) {
    if (l.y < 7 || l.y > ph - 7 || boxes.some(b => b.y0 < l.y + 7 && l.y - 7 < b.y1)) continue;
    boxes.push({ y0: l.y - 7, y1: l.y + 7 });
    const w = ctx.measureText(l.text).width + 8;
    ctx.globalAlpha = 0.85; ctx.fillStyle = p.panel; ctx.fillRect(pw - 2 - w, l.y - 7, w, 14);
    ctx.globalAlpha = 1; ctx.fillStyle = p.vwap; ctx.fillText(l.text, pw - 6, l.y);
  }
  ctx.restore();
  return tags;
}

/** The points inside [t0, t1] and the one just outside each end, so the line runs to the chart's edges. `points` sorted by time. */
export function visible(points: readonly VwapPoint[], t0: number, t1: number): readonly VwapPoint[] {
  let a = 0, b = points.length;
  while (a < b) { const m = (a + b) >> 1; if (points[m]!.t < t0) a = m + 1; else b = m; }
  let c = a, d = points.length;
  while (c < d) { const m = (c + d) >> 1; if (points[m]!.t <= t1) c = m + 1; else d = m; }
  return points.slice(Math.max(0, a - 1), Math.min(points.length, c + 1));
}
