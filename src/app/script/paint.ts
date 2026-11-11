import type { PlotOut } from './protocol.ts';
import type { OptionValue } from './records.ts';
import { parseColor, safeColor, withAlpha } from './lang/colors.ts';

/**
 * Drawing a script's plots in its row of the Scripts pane. The plots of a script that name the same `priceScaleId` share a vertical scale, as
 * they would share a price axis, each fitted to what is in view and kept inside its `scaleMargins` (fractions of the row left free above and
 * below). The scale and the visible range are plain functions; the painters take a canvas.
 */

export interface Margins { top: number; bottom: number }
export interface Scale { min: number; max: number; margins: Margins }

/** The default room above and below a scale (fractions of the row). */
export const DEFAULT_MARGINS: Margins = { top: 0.12, bottom: 0.08 };

/** A style value as a number, or `fallback`. */
export const styleNum = (v: OptionValue | undefined, fallback: number): number => typeof v === 'number' && Number.isFinite(v) ? v : fallback;

/** The scale id of a plot: its own `priceScaleId`, else its script's, else the one shared by the script's plots. */
export function scaleIdOf(plot: Pick<PlotOut, 'style'>, scriptOptions: Readonly<Record<string, OptionValue>>): string {
  const own = plot.style.priceScaleId ?? scriptOptions.priceScaleId;
  return typeof own === 'string' && own ? own : 'right';
}

/** The margins a plot asks for (`scaleMargins: { top, bottom }`), held so the two leave room for the line. */
export function marginsOf(plot: Pick<PlotOut, 'style'>, scriptOptions: Readonly<Record<string, OptionValue>>): Margins {
  const m = plot.style.scaleMargins ?? scriptOptions.scaleMargins;
  if (!m || typeof m !== 'object' || Array.isArray(m)) return DEFAULT_MARGINS;
  const r = m as Record<string, OptionValue>;
  let top = Math.max(0, Math.min(0.95, styleNum(r.top, DEFAULT_MARGINS.top))), bottom = Math.max(0, Math.min(0.95, styleNum(r.bottom, DEFAULT_MARGINS.bottom)));
  if (top + bottom > 0.95) { const k = 0.95 / (top + bottom); top *= k; bottom *= k; }
  return { top, bottom };
}

/** The first and last index of `time` (candle starts, ms) that fall in [t0, t1] with one candle either side (lines run off the edge). */
export function visibleRange(time: Float64Array, t0: number, t1: number, tf: number): [number, number] {
  const n = time.length;
  let lo = 0, hi = n;
  while (lo < hi) { const m = (lo + hi) >> 1; if (time[m]! + tf < t0) lo = m + 1; else hi = m; }
  let end = lo;
  while (end < n && time[end]! <= t1) end++;
  return [Math.max(0, lo - 1), Math.min(n - 1, end)];
}

/** The values of a plot that set its scale: a histogram and a baseline include their base, so the bars stand on it. */
export function plotExtent(plot: PlotOut, from: number, to: number): [number, number] | null {
  let lo = Infinity, hi = -Infinity;
  for (const f of Object.values(plot.fields)) for (let i = from; i <= to && i < f.length; i++) { const v = f[i]!; if (Number.isFinite(v)) { if (v < lo) lo = v; if (v > hi) hi = v; } }
  if (lo === Infinity) return null;
  if (plot.kind === 'histogram' || plot.kind === 'baseline') { const base = styleNum(plot.style.base ?? plot.style.baseValue, 0); if (base < lo) lo = base; if (base > hi) hi = base; }
  return [lo, hi];
}

/** One scale per scale id over the plots in view (a plot set invisible counts for nothing). */
export function scalesOf(plots: readonly PlotOut[], scriptOptions: Readonly<Record<string, OptionValue>>, from: number, to: number): Map<string, Scale> {
  const out = new Map<string, Scale>();
  for (const p of plots) {
    if (p.style.visible === false) continue;
    const ext = plotExtent(p, from, to); if (!ext) continue;
    const id = scaleIdOf(p, scriptOptions), have = out.get(id);
    if (have) { have.min = Math.min(have.min, ext[0]); have.max = Math.max(have.max, ext[1]); }
    else out.set(id, { min: ext[0], max: ext[1], margins: marginsOf(p, scriptOptions) });
  }
  for (const s of out.values()) if (s.max === s.min) { const pad = Math.abs(s.max) * 0.01 || 1; s.min -= pad; s.max += pad; }
  return out;
}

/** The y of `v` in a row from `top`, `height` px tall. */
export function yOf(v: number, s: Scale, top: number, height: number): number {
  const inner = height * (1 - s.margins.top - s.margins.bottom), y0 = top + height * s.margins.top;
  return y0 + (s.max - v) / (s.max - s.min) * inner;
}

/** A number for an axis tag or a readout: short (12.3K, 4.56M), with as many decimals as small values need. */
export function shortNumber(v: number): string {
  if (!Number.isFinite(v)) return '–';
  const a = Math.abs(v), sign = v < 0 ? '−' : '';
  if (a >= 1e9) return `${sign}${(a / 1e9).toFixed(a >= 1e10 ? 1 : 2)}B`;
  if (a >= 1e6) return `${sign}${(a / 1e6).toFixed(a >= 1e7 ? 1 : 2)}M`;
  if (a >= 1e4) return `${sign}${(a / 1e3).toFixed(a >= 1e5 ? 0 : 1)}K`;
  if (a >= 100) return `${sign}${a.toFixed(0)}`;
  if (a >= 1) return `${sign}${a.toFixed(2)}`;
  if (a === 0) return '0';
  return `${sign}${a.toPrecision(3)}`;
}

/** What the painters need of the pane. */
export interface Frame {
  ctx: CanvasRenderingContext2D;
  /** The x of a candle's start (ms). */
  x(t: number): number;
  /** A candle's width in px. */
  barW: number;
  tf: number;
  time: Float64Array;
  from: number; to: number;
  top: number; height: number;
  /** The plot's width: nothing is drawn right of it (the axis). */
  w: number;
  /** The colours the plot falls back on: its place's colour, and the page's up and down colours. */
  color: string; up: string; down: string;
  /** Told where each mark was drawn, so the pane can say what it is when the pointer is on it. */
  marks?: (box: MarkBox) => void;
}

/** The shapes a mark can take: a plate with its text (the default), the text alone, or a shape with the text beyond it. */
export const MARK_SHAPES = ['label', 'text', 'dot', 'circle', 'square', 'diamond', 'triangleUp', 'triangleDown', 'arrowUp', 'arrowDown', 'cross'] as const;
export type MarkShape = typeof MARK_SHAPES[number];
export const markShape = (v: OptionValue | undefined): MarkShape => typeof v === 'string' && (MARK_SHAPES as readonly string[]).includes(v) ? v as MarkShape : 'label';
/** Where a mark stands against its value: above it, below it (a gap away, so a mark at a candle's high or low stands clear of it), or on it. */
export const markPosition = (v: OptionValue | undefined): 'above' | 'below' | 'at' => v === 'above' || v === 'below' ? v : 'at';
/** A mark's box as drawn (the pane's pixels) and its candle. */
export interface MarkBox { x: number; y: number; w: number; h: number; i: number }

/** Black or white, whichever reads on `color` (by its luminance; a colour this page does not read takes white). */
export function textOn(color: string): string {
  const c = parseColor(color);
  if (!c) return '#fff';
  const lin = (v: number): number => { const x = v / 255; return x <= 0.04045 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4; };
  return 0.2126 * lin(c[0]) + 0.7152 * lin(c[1]) + 0.0722 * lin(c[2]) > 0.4 ? '#111' : '#fff';
}

/**
 * Where a mark goes: its box (`w` by `h`, centred on `cx`) above, below or on the value's `y`, `gap` px clear of it. Pure, for the tests and
 * the hover.
 */
export function markBox(cx: number, y: number, w: number, h: number, at: 'above' | 'below' | 'at', gap: number): { x: number; y: number; w: number; h: number } {
  const top = at === 'above' ? y - gap - h : at === 'below' ? y + gap : y - h / 2;
  return { x: cx - w / 2, y: top, w, h };
}

/**
 * Where a plate or a text goes in its row (left 0, right `width`, from `top`, `height` tall): as `markBox` puts it, or, where the row's edge
 * would cut it, on the other side of its value if it fits there, else moved inside the row (a label at the newest candle ran off the right
 * edge of a phone's row; one below a line at the foot of a short row was cut in half; 2026-11-11). One wholly outside the row stays where it
 * is, outside, as a value off the row's scale is not drawn.
 */
export function markPlace(cx: number, y: number, w: number, h: number, at: 'above' | 'below' | 'at', gap: number, row: { width: number; top: number; height: number }): { x: number; y: number; w: number; h: number } {
  const box = markBox(cx, y, w, h, at, gap), bottom = row.top + row.height;
  const touches = (b: { x: number; y: number; w: number; h: number }): boolean => b.x < row.width && b.x + b.w > 0 && b.y < bottom && b.y + b.h > row.top;
  const fits = (b: { y: number; h: number }): boolean => b.y >= row.top && b.y + b.h <= bottom;
  if (!touches(box)) return box;
  let out = box;
  if (!fits(box) && at !== 'at') { const other = markBox(cx, y, w, h, at === 'above' ? 'below' : 'above', gap); if (fits(other)) out = other; }
  const x = w <= row.width ? Math.min(Math.max(out.x, 0), row.width - w) : out.x, top = h <= row.height ? Math.min(Math.max(out.y, row.top), bottom - h) : out.y;
  return { x, y: top, w, h };
}

const color = (raw: OptionValue | undefined, fallback: string): string => safeColor(raw, fallback);
/** The colour of point `i`: its own, else the plot's. */
const pointColor = (plot: PlotOut, i: number, fallback: string): string => { const c = plot.colors?.[i]; return c ? safeColor(c, fallback) : fallback; };

/**
 * The colour a plot is drawn in at point `i`, as `paintPlot` chooses it (for a legend's swatch): a point's own colour first, then the plot's
 * for its kind (a line's color or lineColor, a baseline's line above or below its base, a candle's up or down colour, a cloud's upper line),
 * else `fallback` (the page's colour for the plot's place) or the page's up and down colours.
 */
export function plotColorAt(plot: PlotOut, i: number, fallback: string, up: string, down: string): string {
  const v = plot.fields.value?.[i] ?? NaN;
  switch (plot.kind) {
    case 'line': case 'area': return pointColor(plot, i, color(plot.style.color ?? plot.style.lineColor, fallback));
    case 'mark': return pointColor(plot, i, color(plot.style.color, fallback));
    case 'baseline': return pointColor(plot, i, v >= styleNum(plot.style.baseValue ?? plot.style.base, 0) ? color(plot.style.topLineColor, up) : color(plot.style.bottomLineColor, down));
    case 'histogram': return pointColor(plot, i, color(plot.style.color, fallback));
    case 'candlestick': case 'bar': { const o = plot.fields.open?.[i] ?? NaN, c = plot.fields.close?.[i] ?? NaN; return pointColor(plot, i, c >= o ? color(plot.style.upColor, up) : color(plot.style.downColor, down)); }
    case 'cloudarea': return color(plot.style.higherLineColor ?? plot.style.positiveLineColor, up);
    case 'brokenarea': return pointColor(plot, i, color(plot.style.color, withAlpha(up, 0.2)));
  }
  return fallback;
}

/** Draw one plot in its row on its scale. */
export function paintPlot(f: Frame, plot: PlotOut, s: Scale): void {
  if (plot.style.visible === false) return;
  const { ctx } = f;
  const y = (v: number): number => yOf(v, s, f.top, f.height);
  const cx = (i: number): number => f.x(f.time[i]!) + f.barW / 2;
  const width = Math.max(1, Math.min(6, styleNum(plot.style.lineWidth, plot.kind === 'area' ? 2 : 1.5)));
  ctx.save();
  ctx.beginPath(); ctx.rect(0, f.top, f.w, f.height); ctx.clip();
  switch (plot.kind) {
    case 'line': case 'area': case 'baseline': {
      const v = plot.fields.value!, base = color(plot.style.color ?? plot.style.lineColor, f.color);
      if (plot.kind === 'area') fillUnder(f, v, y, color(plot.style.topColor, withAlpha(base, 0.3)), color(plot.style.bottomColor, withAlpha(base, 0)));
      if (plot.kind === 'baseline') fillBaseline(f, v, y, styleNum(plot.style.baseValue ?? plot.style.base, 0), color(plot.style.topFillColor1, withAlpha(f.up, 0.25)), color(plot.style.bottomFillColor1, withAlpha(f.down, 0.25)));
      strokeLine(f, v, y, i => pointColor(plot, i, plot.kind === 'baseline' ? (v[i]! >= styleNum(plot.style.baseValue ?? plot.style.base, 0) ? color(plot.style.topLineColor, f.up) : color(plot.style.bottomLineColor, f.down)) : base), width, styleNum(plot.style.lineStyle, 0), plot.kind === 'line' && styleNum(plot.style.lineType, 0) === 1);
      break;
    }
    case 'mark': paintMarks(f, plot, y); break;
    case 'histogram': {
      const v = plot.fields.value!, base = styleNum(plot.style.base, 0), y0 = y(base), fallback = color(plot.style.color, f.color);
      const w = Math.max(1, f.barW * 0.72);
      for (let i = f.from; i <= f.to; i++) {
        const val = v[i]!; if (!Number.isFinite(val)) continue;
        const y1 = y(val);
        ctx.fillStyle = pointColor(plot, i, fallback);
        ctx.fillRect(cx(i) - w / 2, Math.min(y0, y1), w, Math.max(1, Math.abs(y1 - y0)));
      }
      break;
    }
    case 'candlestick': case 'bar': {
      const { open, high, low, close } = plot.fields as Record<'open' | 'high' | 'low' | 'close', Float64Array>;
      const up = color(plot.style.upColor, f.up), down = color(plot.style.downColor, f.down), w = Math.max(1, f.barW * 0.7);
      for (let i = f.from; i <= f.to; i++) {
        const o = open[i]!, h = high[i]!, l = low[i]!, c = close[i]!;
        if (![o, h, l, c].every(Number.isFinite)) continue;
        const col = pointColor(plot, i, c >= o ? up : down), x = cx(i);
        ctx.strokeStyle = col; ctx.fillStyle = col; ctx.lineWidth = 1;
        ctx.beginPath(); ctx.moveTo(Math.round(x) + 0.5, y(h)); ctx.lineTo(Math.round(x) + 0.5, y(l)); ctx.stroke();
        if (plot.kind === 'candlestick') { const y1 = y(Math.max(o, c)), y2 = y(Math.min(o, c)); ctx.fillRect(x - w / 2, y1, w, Math.max(1, y2 - y1)); }
        else { ctx.beginPath(); ctx.moveTo(x - w / 2, y(o)); ctx.lineTo(x, y(o)); ctx.moveTo(x, y(c)); ctx.lineTo(x + w / 2, y(c)); ctx.stroke(); }
      }
      break;
    }
    case 'cloudarea': {
      const lo = plot.fields.lowerValue!, hi = plot.fields.higherValue!;
      const pos = color(plot.style.positiveColor, withAlpha(f.up, 0.12)), neg = color(plot.style.negativeColor, withAlpha(f.down, 0.12));
      for (let i = f.from; i < f.to; i++) {
        const a = lo[i]!, b = hi[i]!, a2 = lo[i + 1]!, b2 = hi[i + 1]!;
        if (![a, b, a2, b2].every(Number.isFinite)) continue;
        ctx.fillStyle = b >= a ? pos : neg;
        ctx.beginPath(); ctx.moveTo(cx(i), y(a)); ctx.lineTo(cx(i + 1), y(a2)); ctx.lineTo(cx(i + 1), y(b2)); ctx.lineTo(cx(i), y(b)); ctx.closePath(); ctx.fill();
      }
      strokeLine(f, hi, y, () => color(plot.style.higherLineColor ?? plot.style.positiveLineColor, f.up), Math.max(1, styleNum(plot.style.higherLineWidth, 1)), styleNum(plot.style.higherLineStyle, 0));
      strokeLine(f, lo, y, () => color(plot.style.lowerLineColor ?? plot.style.negativeLineColor, f.down), Math.max(1, styleNum(plot.style.lowerLineWidth, 1)), styleNum(plot.style.lowerLineStyle, 0));
      break;
    }
    case 'brokenarea': {
      const lo = plot.fields.lowerValue!, hi = plot.fields.higherValue!, fallback = color(plot.style.color, withAlpha(f.up, 0.2));
      for (let i = f.from; i <= f.to; i++) {
        const a = lo[i]!, b = hi[i]!; if (!Number.isFinite(a) || !Number.isFinite(b)) continue;
        const x = f.x(f.time[i]!), y1 = y(Math.max(a, b)), y2 = y(Math.min(a, b));
        ctx.fillStyle = pointColor(plot, i, fallback);
        ctx.fillRect(x, y1, Math.max(1, f.barW + 0.5), Math.max(1, y2 - y1));
      }
      break;
    }
  }
  ctx.restore();
}

/**
 * A line through the points that are numbers, broken where one is not; each segment in the colour of the point it ends at. With `steps`
 * (lineType 1) each point is a level across its own candle, joined straight up or down to the next candle's: a point alone draws its level.
 */
function strokeLine(f: Frame, v: Float64Array, y: (v: number) => number, colorAt: (i: number) => string, width: number, lineStyle: number, steps = false): void {
  const { ctx } = f;
  ctx.lineWidth = width; ctx.lineJoin = 'round';
  ctx.setLineDash(lineStyle === 1 ? [1, 2] : lineStyle === 2 ? [4, 3] : lineStyle === 3 ? [8, 4] : lineStyle === 4 ? [1, 5] : []);
  let prev = -1, current = '';
  if (steps) {
    let prevY = 0;
    for (let i = f.from; i <= f.to; i++) {
      const val = v[i]!;
      if (!Number.isFinite(val)) { if (prev >= 0) ctx.stroke(); prev = -1; current = ''; continue; }
      const x0 = f.x(f.time[i]!), x1 = x0 + f.barW, yy = y(val), c = colorAt(i);
      // Joined to the level of the candle just before (no gap between them), its step in this candle's colour.
      const joined = prev === i - 1 && f.time[i]! - f.time[prev]! <= f.tf;
      if (joined && c === current) { ctx.lineTo(x0, yy); ctx.lineTo(x1, yy); }
      else {
        if (prev >= 0) ctx.stroke();
        ctx.beginPath(); ctx.strokeStyle = c; current = c;
        ctx.moveTo(x0, joined ? prevY : yy); if (joined) ctx.lineTo(x0, yy); ctx.lineTo(x1, yy);
      }
      prev = i; prevY = yy;
    }
    if (prev >= 0) ctx.stroke();
    ctx.setLineDash([]);
    return;
  }
  const cx = (i: number): number => f.x(f.time[i]!) + f.barW / 2;
  for (let i = f.from; i <= f.to; i++) {
    const val = v[i]!;
    if (!Number.isFinite(val)) { if (prev >= 0) ctx.stroke(); prev = -1; current = ''; continue; }
    const c = colorAt(i);
    if (prev < 0) { ctx.beginPath(); ctx.strokeStyle = c; current = c; ctx.moveTo(cx(i), y(val)); prev = i; continue; }
    if (c !== current) { ctx.stroke(); ctx.beginPath(); ctx.strokeStyle = c; current = c; ctx.moveTo(cx(prev), y(v[prev]!)); ctx.lineTo(cx(i), y(val)); }
    else ctx.lineTo(cx(i), y(val));
    prev = i;
  }
  if (prev >= 0) ctx.stroke();
  ctx.setLineDash([]);
}

/** The face of a mark's text, at a size (1 is 10 px). */
const markFont = (size: number): string => `600 ${Math.round(10 * size)}px ui-sans-serif, system-ui, sans-serif`;
/** The width of a mark's text in its face, kept across frames (marks repeat a few texts; the map draws again on every pointer move). */
const MARK_WIDTHS = new Map<string, number>();

/**
 * A mark at each point that is a number: a plate with its text, the text alone, or a shape (with the text beyond it, away from the value).
 * Marks of one plot never cover one another: one that would reach over the mark before it is drawn as a dot (a text alone is left out), so
 * a chart zoomed out shows dots and one zoomed in shows the texts. Each drawn mark's box is told to `f.marks`.
 */
function paintMarks(f: Frame, plot: PlotOut, y: (v: number) => number): void {
  const { ctx } = f, v = plot.fields.value!, texts = plot.texts ?? null, base = color(plot.style.color, f.color);
  const shape = markShape(plot.style.shape), at = markPosition(plot.style.position);
  // `offset` stands a mark further off its value (px), so marks of two plots at one candle can stack.
  const size = Math.max(0.6, Math.min(2.5, styleNum(plot.style.size, 1))), gap = 3 + Math.max(0, Math.min(200, styleNum(plot.style.offset, 0))), lineH = Math.round(14 * size);
  const ownText = typeof plot.style.textColor === 'string' ? safeColor(plot.style.textColor, '') : '';
  const font = markFont(size);
  ctx.font = font; ctx.textBaseline = 'middle'; ctx.textAlign = 'center';
  const wide = (s: string): number => {
    const key = `${font}|${s}`;
    let w = MARK_WIDTHS.get(key);
    if (w === undefined) { if (MARK_WIDTHS.size >= 2_048) MARK_WIDTHS.clear(); w = ctx.measureText(s).width; MARK_WIDTHS.set(key, w); }
    return w;
  };
  let lastRight = -Infinity;
  // What is drawn of a mark inside the plot's clip is where the pointer finds it; one drawn wholly outside is not found.
  const tell = (b: { x: number; y: number; w: number; h: number }, i: number): void => {
    const x0 = Math.max(0, b.x), x1 = Math.min(f.w, b.x + b.w), y0 = Math.max(f.top, b.y), y1 = Math.min(f.top + f.height, b.y + b.h);
    if (x1 > x0 && y1 > y0) f.marks?.({ x: x0, y: y0, w: x1 - x0, h: y1 - y0, i });
  };
  for (let i = f.from; i <= f.to; i++) {
    const val = v[i]!;
    if (!Number.isFinite(val)) continue;
    const cx = f.x(f.time[i]!) + f.barW / 2, yy = y(val), c = pointColor(plot, i, base), label = texts?.[i] ?? '';
    const r = Math.max(2, 4 * size);
    const asShape = shape !== 'label' && shape !== 'text';
    // The box the whole mark takes: the shape, and its text beyond it.
    const textW = label ? wide(label) : 0;
    const w = asShape ? Math.max(2 * r, textW) : shape === 'label' ? textW + 8 : textW;
    // A plate or a text is judged where it will stand (`markPlace` keeps it inside the row): one moved left at the row's right edge is not
    // drawn over the one before it (Sol, round 7).
    const placed = !asShape && label ? markPlace(cx, yy, w, lineH, at, gap, { width: f.w, top: f.top, height: f.height }) : null;
    const crowded = !label && !asShape ? false : (placed ? placed.x : cx - w / 2) < lastRight + 2;
    // A text alone gives way where there is no room (a row of them under the candles would be a row of dots zoomed out).
    if (crowded && shape === 'text') continue;
    if ((!label && !asShape) || crowded) {
      // Nothing to show but a place (a label with no text), or no room: a dot.
      const box = markBox(cx, yy, 2 * r * 0.7, 2 * r * 0.7, at, gap);
      if (crowded && box.x < lastRight - 0.5 * box.w) continue;
      ctx.fillStyle = c; ctx.beginPath(); ctx.arc(cx, box.y + box.h / 2, box.w / 2, 0, Math.PI * 2); ctx.fill();
      tell(box, i); lastRight = box.x + box.w;
      continue;
    }
    if (!asShape) {
      const box = placed ?? markPlace(cx, yy, w, lineH, at, gap, { width: f.w, top: f.top, height: f.height });
      if (shape === 'label') {
        ctx.fillStyle = c; ctx.beginPath(); ctx.roundRect(box.x, box.y, box.w, box.h, 3); ctx.fill();
        ctx.fillStyle = ownText || textOn(c);
      } else ctx.fillStyle = ownText || c;
      ctx.fillText(label, box.x + box.w / 2, box.y + box.h / 2 + 0.5);
      tell(box, i); lastRight = box.x + box.w;
      continue;
    }
    // A shape, and its text beyond it (above a shape above the value, below one below it, under one on it).
    const sb = markBox(cx, yy, 2 * r, 2 * r, at, gap), sy = sb.y + r;
    ctx.fillStyle = c; ctx.strokeStyle = c; ctx.lineWidth = Math.max(1, 1.4 * size);
    ctx.beginPath();
    switch (shape) {
      case 'dot': ctx.arc(cx, sy, r * 0.6, 0, Math.PI * 2); ctx.fill(); break;
      case 'circle': ctx.arc(cx, sy, r - 0.5, 0, Math.PI * 2); ctx.stroke(); break;
      case 'square': ctx.rect(cx - r * 0.8, sy - r * 0.8, r * 1.6, r * 1.6); ctx.fill(); break;
      case 'diamond': ctx.moveTo(cx, sy - r); ctx.lineTo(cx + r, sy); ctx.lineTo(cx, sy + r); ctx.lineTo(cx - r, sy); ctx.closePath(); ctx.fill(); break;
      case 'triangleUp': ctx.moveTo(cx, sy - r); ctx.lineTo(cx + r, sy + r * 0.8); ctx.lineTo(cx - r, sy + r * 0.8); ctx.closePath(); ctx.fill(); break;
      case 'triangleDown': ctx.moveTo(cx, sy + r); ctx.lineTo(cx + r, sy - r * 0.8); ctx.lineTo(cx - r, sy - r * 0.8); ctx.closePath(); ctx.fill(); break;
      case 'arrowUp': ctx.moveTo(cx, sy - r); ctx.lineTo(cx + r * 0.8, sy); ctx.lineTo(cx + r * 0.3, sy); ctx.lineTo(cx + r * 0.3, sy + r); ctx.lineTo(cx - r * 0.3, sy + r); ctx.lineTo(cx - r * 0.3, sy); ctx.lineTo(cx - r * 0.8, sy); ctx.closePath(); ctx.fill(); break;
      case 'arrowDown': ctx.moveTo(cx, sy + r); ctx.lineTo(cx + r * 0.8, sy); ctx.lineTo(cx + r * 0.3, sy); ctx.lineTo(cx + r * 0.3, sy - r); ctx.lineTo(cx - r * 0.3, sy - r); ctx.lineTo(cx - r * 0.3, sy); ctx.lineTo(cx - r * 0.8, sy); ctx.closePath(); ctx.fill(); break;
      case 'cross': ctx.moveTo(cx - r * 0.8, sy - r * 0.8); ctx.lineTo(cx + r * 0.8, sy + r * 0.8); ctx.moveTo(cx + r * 0.8, sy - r * 0.8); ctx.lineTo(cx - r * 0.8, sy + r * 0.8); ctx.stroke(); break;
    }
    let box = sb;
    if (label) {
      const ty = at === 'above' ? sb.y - lineH / 2 : sb.y + sb.h + lineH / 2;
      ctx.fillStyle = ownText || c; ctx.fillText(label, cx, ty + 0.5);
      const top = Math.min(sb.y, ty - lineH / 2), bottom = Math.max(sb.y + sb.h, ty + lineH / 2);
      box = { x: cx - w / 2, y: top, w, h: bottom - top };
    }
    tell(box, i); lastRight = box.x + box.w;
  }
}

function fillUnder(f: Frame, v: Float64Array, y: (v: number) => number, top: string, bottom: string): void {
  const { ctx } = f, bottomY = f.top + f.height;
  const g = ctx.createLinearGradient(0, f.top, 0, bottomY); g.addColorStop(0, top); g.addColorStop(1, bottom);
  ctx.fillStyle = g;
  const cx = (i: number): number => f.x(f.time[i]!) + f.barW / 2;
  let start = -1;
  const close = (end: number): void => { ctx.lineTo(cx(end), bottomY); ctx.lineTo(cx(start), bottomY); ctx.closePath(); ctx.fill(); };
  for (let i = f.from; i <= f.to; i++) {
    const val = v[i]!;
    if (!Number.isFinite(val)) { if (start >= 0) close(i - 1); start = -1; continue; }
    if (start < 0) { start = i; ctx.beginPath(); ctx.moveTo(cx(i), y(val)); } else ctx.lineTo(cx(i), y(val));
  }
  if (start >= 0) close(f.to);
}

function fillBaseline(f: Frame, v: Float64Array, y: (v: number) => number, base: number, above: string, below: string): void {
  const { ctx } = f, baseY = y(base);
  const cx = (i: number): number => f.x(f.time[i]!) + f.barW / 2;
  for (let i = f.from; i < f.to; i++) {
    const a = v[i]!, b = v[i + 1]!; if (!Number.isFinite(a) || !Number.isFinite(b)) continue;
    ctx.fillStyle = (a + b) / 2 >= base ? above : below;
    ctx.beginPath(); ctx.moveTo(cx(i), baseY); ctx.lineTo(cx(i), y(a)); ctx.lineTo(cx(i + 1), y(b)); ctx.lineTo(cx(i + 1), baseY); ctx.closePath(); ctx.fill();
  }
}

/**
 * Whether the point (`px`, `py`) of a chart is on what `plot` draws at candle `i` (the one under the point), within `slop` pixels: on its
 * line (stroked between the candles' middles, or across the candle as a step) or a cloud's edge, inside a histogram's bar, a candle's range
 * or a broken area's cell. An area's or a baseline's fill does not count, only its line: a fill covers too much of the chart to say the
 * pointer means it. A mark is found by `markAt`, not here.
 */
export function onPlot(plot: PlotOut, s: Scale, f: Pick<Frame, 'x' | 'barW' | 'time' | 'top' | 'height'>, i: number, px: number, py: number, slop: number): boolean {
  if (plot.style.visible === false || i < 0 || i >= f.time.length) return false;
  const y = (v: number): number => yOf(v, s, f.top, f.height);
  const cx = (k: number): number => f.x(f.time[k]!) + f.barW / 2;
  const near = (yy: number): boolean => Number.isFinite(yy) && Math.abs(py - yy) <= slop;
  const inside = (a: number, b: number): boolean => py >= Math.min(a, b) - slop && py <= Math.max(a, b) + slop;
  // A line at the point's x: between the middles of the candles either side, or level across the candle for a step (or a lone point).
  const lineAt = (v: Float64Array, steps: boolean): number => {
    const a = v[i]!;
    if (steps) return Number.isFinite(a) ? y(a) : NaN;
    const k = px >= cx(i) ? i + 1 : i - 1, b = k >= 0 && k < v.length ? v[k]! : NaN;
    if (!Number.isFinite(a)) return NaN;
    if (!Number.isFinite(b) || cx(k) === cx(i)) return Math.abs(px - cx(i)) <= f.barW / 2 + slop ? y(a) : NaN;
    return y(a + (b - a) * (px - cx(i)) / (cx(k) - cx(i)));
  };
  switch (plot.kind) {
    case 'line': case 'area': case 'baseline':
      return near(lineAt(plot.fields.value!, plot.kind === 'line' && styleNum(plot.style.lineType, 0) === 1));
    case 'cloudarea':
      return near(lineAt(plot.fields.lowerValue!, false)) || near(lineAt(plot.fields.higherValue!, false));
    case 'histogram': {
      const v = plot.fields.value![i]!, w = Math.max(1, f.barW * 0.72);
      return Number.isFinite(v) && Math.abs(px - cx(i)) <= w / 2 + slop && inside(y(styleNum(plot.style.base, 0)), y(v));
    }
    case 'candlestick': case 'bar': {
      const h = plot.fields.high![i]!, l = plot.fields.low![i]!;
      return Number.isFinite(h) && Number.isFinite(l) && inside(y(h), y(l));
    }
    case 'brokenarea': {
      const a = plot.fields.lowerValue![i]!, b = plot.fields.higherValue![i]!;
      return Number.isFinite(a) && Number.isFinite(b) && inside(y(a), y(b));
    }
    case 'mark': return false;
  }
}
