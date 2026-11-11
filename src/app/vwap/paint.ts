import { t } from '../i18n.ts';
import { price as fmtPrice } from '../format.ts';
import type { Palette } from '../theme.ts';
import type { View } from '../view.ts';
import { LabelBoard } from '../labels.ts';
import type { KeyTag } from '../keylevels/paint.ts';
import type { VwapPoint } from './vwap.ts';
import type { VwapSettings } from './settings.ts';
import { lineColor } from './colours.ts';
import type { Anchor } from '../anchors/anchors.ts';

/** One VWAP to draw: the session's (one line per session), a rolling one's, an anchor's, or a session's whale buys or sells; its points, and its name. */
export interface VwapLine {
  kind: 'session' | 'rolling' | 'anchor' | 'whaleBuy' | 'whaleSell';
  /** The anchor's number (its place in the coin's list, from 1), the rolling window's days, or 0 for a session. */
  n: number;
  /**
   * An anchor's id and colour slot (its default colour, `colours.ts`). Its own colour is not kept on the line: the lines are kept by keys
   * that leave colours out, so it is read from the settings by the id when the line is drawn (`paintVwap`'s `anchors`).
   */
  id?: string;
  slot?: number;
  color?: string;
  /** Its code on the chart instead of `vwapCode`'s, in its label and on its axis tag: a live anchor's, by its rule ("AVWAP PWH"). */
  name?: string;
  /** Its tag on the price axis instead of its code, where that is long: a fixed anchor's day ("AVWAP Nov 4"; its label keeps the time). */
  tag?: string;
  /** An anchored line's head: the finer bars its points stand on before `to` (`cutForReplay` cuts those on their own bars). */
  head?: { bar: number; to: number };
  points: readonly VwapPoint[];
  /** Whether it runs to now (the session under way, an anchor): its last value gets a tag on the price axis. */
  live: boolean;
  key: string;
  /** The history's bar (ms), for a session or an anchor (points at bar starts): in replay a point counts once its bar is over. A rolling line's points are at bar ends already. */
  bar?: number;
  /** Where the chart's own candles take over from the history (already cut to a replay's moment); Infinity when they do not. */
  liveFrom?: number;
}

/**
 * Tag and label order against the key levels' (0 to 11, earlier periods' from 20): the session VWAP with the previous day's levels, anchors
 * after the opens, rolling VWAPs after the day's levels (there can be six of them; the shorter window first), before earlier periods' levels.
 */
const RANK = { session: 1.5, anchor: 6.5, rolling: 11.5, whaleBuy: 9, whaleSell: 9 } as const;
const rankOf = (line: Pick<VwapLine, 'kind' | 'n'>): number => line.kind === 'rolling' ? RANK.rolling + line.n / 1_000 : RANK[line.kind];

export const vwapCode = (line: Pick<VwapLine, 'kind' | 'n'>): string => line.kind === 'session' ? t('VWAP') : line.kind === 'anchor' ? `${t('AVWAP')} ${line.n}`
  : line.kind === 'rolling' ? `${t('RVWAP')} ${line.n}D` : line.kind === 'whaleBuy' ? t('Whale buys') : t('Whale sells');
const whale = (line: Pick<VwapLine, 'kind'>): boolean => line.kind === 'whaleBuy' || line.kind === 'whaleSell';
/**
 * A line's dash: the session solid; each rolling window and each anchor's colour slot a pattern of its own, so six lines of one family tell
 * apart without their colours (Sol, review 2026-11-11: six violets with one dash); the rolling ones dashes, the anchors dash-dots.
 */
const ROLLING_DASH: Readonly<Record<number, number[]>> = { 1: [5, 4], 7: [10, 5], 30: [16, 5], 90: [16, 4, 4, 4], 180: [24, 6], 365: [24, 4, 4, 4, 4, 4] };
const ANCHOR_DASH: readonly number[][] = [[9, 3, 2, 3], [14, 4, 2, 4], [6, 3, 2, 3], [9, 3, 2, 3, 2, 3], [18, 4, 4, 4], [4, 3, 2, 3]];
export function dashOf(line: Pick<VwapLine, 'kind' | 'n' | 'slot'>): number[] {
  if (line.kind === 'session') return [];
  if (line.kind === 'rolling') return ROLLING_DASH[line.n] ?? [10, 5];
  const slot = line.slot ?? Math.max(0, line.n - 1);
  return ANCHOR_DASH[((slot % ANCHOR_DASH.length) + ANCHOR_DASH.length) % ANCHOR_DASH.length]!;
}
/** The colour a line is drawn, labelled and tagged in: its own, else its default on this theme; the whale lines the buy and sell colours. */
export const vwapColor = (line: VwapLine, s: Pick<VwapSettings, 'colors'>, p: Palette, anchors: readonly Pick<Anchor, 'id' | 'color'>[] = []): string => {
  if (line.kind === 'whaleBuy') return p.bid;
  if (line.kind === 'whaleSell') return p.ask;
  if (line.kind !== 'anchor') return lineColor(line, s.colors, p);
  const own = anchors.find(a => a.id === line.id)?.color ?? line.color;
  return lineColor(own ? { ...line, color: own } : line, s.colors, p);
};

/**
 * Draw each VWAP as a line in the palette's VWAP colour over a halo: the session's solid, with its bands (±1 and ±2 standard deviations,
 * short dashes, fainter), a rolling one's in long dashes, an anchor's dash-dotted with a small triangle where it starts, the whale buys and
 * sells thin and solid in the buy and sell colours (no axis tags: the axis is full enough); the name and price at the right end of the ones
 * running to now. Returns the tags wanted on the price axis (placed with the key levels' tags).
 */
export function paintVwap(ctx: CanvasRenderingContext2D, lines: readonly VwapLine[], v: View, pw: number, ph: number, p: Palette, s: VwapSettings, board: LabelBoard = new LabelBoard(), anchors: readonly Pick<Anchor, 'id' | 'color'>[] = []): KeyTag[] {
  const tags: KeyTag[] = [];
  if (!lines.length) return tags;
  const halo = p.dark ? 'rgba(0,0,0,0.55)' : 'rgba(255,255,255,0.75)';
  // At most four points a pixel column (where it enters, its lowest and highest, where it leaves): zoomed out, a rolling line can have
  // thousands of points to a column (six windows over months), which cost the stroke and draw nothing more.
  const path = (pts: readonly VwapPoint[], value: (q: VwapPoint) => number): void => {
    ctx.beginPath();
    let started = false, col = NaN, x0 = 0, yIn = 0, yLo = 0, yHi = 0, yOut = 0;
    const put = (x: number, y: number): void => { if (started) ctx.lineTo(x, y); else { ctx.moveTo(x, y); started = true; } };
    const flush = (): void => {
      if (Number.isNaN(col)) return;
      // The column ends where its last point is, whatever it passed on the way (an excursion that came back to where it entered included).
      let last = yIn;
      put(x0, yIn);
      if (yLo < Math.min(yIn, yOut)) { put(x0, yLo); last = yLo; }
      if (yHi > Math.max(yIn, yOut)) { put(x0, yHi); last = yHi; }
      if (yOut !== last) put(x0, yOut);
    };
    for (const q of pts) {
      const x = v.xOf(q.t, pw), y = v.yOf(value(q), ph), c = Math.floor(x);
      if (c !== col) { flush(); col = c; x0 = x; yIn = yLo = yHi = yOut = y; continue; }
      if (y < yLo) yLo = y;
      if (y > yHi) yHi = y;
      yOut = y;
    }
    flush();
  };
  const stroke = (pts: readonly VwapPoint[], value: (q: VwapPoint) => number, width: number, dash: number[], alpha: number, color: string): void => {
    ctx.globalAlpha = alpha; ctx.setLineDash(dash);
    path(pts, value); ctx.strokeStyle = halo; ctx.lineWidth = width + 2; ctx.stroke();
    ctx.strokeStyle = color; ctx.lineWidth = width; ctx.stroke();
  };
  const labels: { text: string; y: number; rank: number; color: string }[] = [];
  ctx.save(); ctx.beginPath(); ctx.rect(0, 0, pw, ph); ctx.clip(); ctx.lineJoin = 'round';
  for (const line of lines) {
    // Only the points on the chart and one either side, so a long session costs what is drawn.
    const pts = visible(line.points, v.t0, v.t1);
    if (pts.length < 1) continue;
    const color = vwapColor(line, s, p, anchors);
    // The bands in the session's own colour, fainter.
    if (line.kind === 'session') for (let k = s.bands; k >= 1; k--) {
      stroke(pts, q => q.vwap + k * q.sd, 1.1, [3, 4], k === 1 ? 0.8 : 0.55, color);
      stroke(pts, q => q.vwap - k * q.sd, 1.1, [3, 4], k === 1 ? 0.8 : 0.55, color);
    }
    if (whale(line)) stroke(pts, q => q.vwap, 1.3, [], 0.95, color);
    else stroke(pts, q => q.vwap, line.kind === 'session' ? 1.8 : 1.5, dashOf(line), 1, color);
    const first = line.points[0]!;
    if (line.kind === 'anchor' && first.t >= v.t0 && first.t <= v.t1) { // where it starts: a small triangle under the line
      const x = v.xOf(first.t, pw), y = v.yOf(first.vwap, ph) + 7;
      ctx.globalAlpha = 1; ctx.setLineDash([]); ctx.beginPath(); ctx.moveTo(x, y - 5); ctx.lineTo(x + 5, y + 4); ctx.lineTo(x - 5, y + 4); ctx.closePath();
      ctx.fillStyle = color; ctx.fill(); ctx.strokeStyle = halo; ctx.lineWidth = 1; ctx.stroke();
    }
    if (!line.live) continue;
    const last = line.points[line.points.length - 1]!, y = v.yOf(last.vwap, ph), code = line.name ?? vwapCode(line), rank = rankOf(line);
    if (s.labels && v.xOf(last.t, pw) <= pw + 4 && v.xOf(last.t, pw) > 40) labels.push({ text: `${code} ${fmtPrice(last.vwap)}`, y, rank, color });
    if (s.tags && !whale(line)) tags.push({ key: `vwap|${line.key}`, y, rank, text: line.tag ?? code, older: false, color });
  }
  ctx.setLineDash([]); ctx.globalAlpha = 1;
  // The names at the right edge, the session's first; one that would cover another is left out.
  ctx.font = '600 10px ui-sans-serif, system-ui, sans-serif'; ctx.textAlign = 'right'; ctx.textBaseline = 'middle';
  for (const l of labels.sort((a, b) => a.rank - b.rank)) {
    const w = ctx.measureText(l.text).width + 8;
    if (l.y < 7 || l.y > ph - 7 || !board.claim({ x0: pw - 2 - w, x1: pw - 2, y0: l.y - 7, y1: l.y + 7 })) continue;
    ctx.globalAlpha = 0.85; ctx.fillStyle = p.panel; ctx.fillRect(pw - 2 - w, l.y - 7, w, 14);
    ctx.globalAlpha = 1; ctx.fillStyle = l.color; ctx.fillText(l.text, pw - 6, l.y);
  }
  ctx.restore();
  return tags;
}

/**
 * In a replay (`replay`), each line up to what was known at `at` (so its tag is the VWAP then); live, the lines as they are. A session's or an
 * anchor's history point stands at its bar's start and counts once the bar is over, the chart's own candles (from `liveFrom`) and the whale
 * lines are cut to the moment already, and a rolling line's points stand at their bars' ends.
 */
export function cutForReplay(lines: VwapLine[], at: number, replay: boolean): VwapLine[] {
  if (!replay) return lines;
  return lines.map(l => l.kind === 'rolling' ? { ...l, points: l.points.filter(q => q.t <= at) }
    : l.bar === undefined ? l : { ...l, points: l.points.filter(q => q.t >= (l.liveFrom ?? Infinity) || q.t + (l.head && q.t < l.head.to ? l.head.bar : l.bar!) <= at) });
}

/** The points inside [t0, t1] and the one just outside each end, so the line runs to the chart's edges. `points` sorted by time. */
export function visible(points: readonly VwapPoint[], t0: number, t1: number): readonly VwapPoint[] {
  let a = 0, b = points.length;
  while (a < b) { const m = (a + b) >> 1; if (points[m]!.t < t0) a = m + 1; else b = m; }
  let c = a, d = points.length;
  while (c < d) { const m = (c + d) >> 1; if (points[m]!.t <= t1) c = m + 1; else d = m; }
  return points.slice(Math.max(0, a - 1), Math.min(points.length, c + 1));
}
