import { buildLut } from '../heatmap/lut.ts';
import { el } from '../dom.ts';
import { isCoarse } from '../device.ts';
import type { FigureId } from './content.ts';

/**
 * The guide's animated figures. Each is a small scene drawn on a canvas from the page's own colours and colour ramp, looping while it is
 * on screen, with a play/pause button and a slider to scrub through it. They are drawings of how the page behaves, not recordings of it,
 * so they stay sharp at any size, follow the theme, and cost nothing to download.
 */

export interface Theme { bg: string; panel: string; text: string; muted: string; line: string; bid: string; ask: string; ui: string; dark: boolean; lut: Uint8Array }

interface Scene {
  /** Length of one loop in ms. */
  duration: number;
  /** Where the loop rests when motion is reduced, or when a scene is paused on first show. */
  rest: number;
  height: number;
  draw(g: Ctx, w: number, h: number, u: number, th: Theme, pointer: { x: number; y: number } | null): void;
  /** What the part under the pointer is, for scenes that explain themselves on hover. */
  describe?(w: number, h: number, x: number, y: number): string | null;
}
type Ctx = CanvasRenderingContext2D;

// ---- shared helpers ----------------------------------------------------------------------------------------------------------------

const clamp = (v: number, lo = 0, hi = 1): number => Math.max(lo, Math.min(hi, v));
const smooth = (x: number): number => { const t = clamp(x); return t * t * (3 - 2 * t); };
/** 0 → 1 → 0 over the unit interval, eased, with a pause at each end. */
const breathe = (u: number, hold = 0.12): number => { const t = u < 0.5 ? u * 2 : (1 - u) * 2; return smooth((t - hold) / (1 - 2 * hold)); };
const mix = (a: number, b: number, t: number): number => a + (b - a) * t;
const money = (v: number): string => v >= 1e6 ? `$${(v / 1e6).toFixed(v >= 1e7 ? 0 : 1)}M` : `$${Math.round(v / 1e3)}k`;
const priceText = (v: number): string => Math.round(v).toLocaleString('en-US');
const font = (g: Ctx, size: number, weight = 400): void => { g.font = `${weight} ${size}px ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif`; };

let lutLight: Uint8Array | null = null, lutDark: Uint8Array | null = null;
export function readTheme(): Theme {
  const root = document.documentElement, cs = getComputedStyle(root), get = (name: string, fallback: string): string => cs.getPropertyValue(name).trim() || fallback;
  const dark = root.dataset.theme === 'dark';
  return { bg: get('--bg', '#fff'), panel: get('--panel', '#fff'), text: get('--text', '#1b1d21'), muted: get('--muted', '#7b8088'), line: get('--line', '#e7e9ec'), bid: get('--bid', '#0fa44a'), ask: get('--ask', '#e0066f'), ui: get('--ui', '#2f6bff'), dark,
    lut: dark ? (lutDark ??= buildLut(true)) : (lutLight ??= buildLut(false)) };
}
const ramp = (th: Theme, s: number, alpha = 1): string => { const i = Math.round(clamp(s) * 255) * 4; return `rgba(${th.lut[i]}, ${th.lut[i + 1]}, ${th.lut[i + 2]}, ${alpha})`; };
const grey = (th: Theme, s: number): string => { const m = /^#?([0-9a-f]{6})$/i.exec(th.muted.replace('#', '')); const c = m ? parseInt(m[1]!, 16) : 0x808080; return `rgba(${c >> 16 & 255}, ${c >> 8 & 255}, ${c & 255}, ${(0.16 + 0.74 * clamp(s)).toFixed(3)})`; };

// ---- a small made-up market ---------------------------------------------------------------------------------------------------------

const MARK = 85_000;
/** Resting walls: price, strength 0..1 (log-size), and the part of the time span (0..1) they were there. */
const WALLS: { p: number; s: number; a: number; b: number }[] = [
  { p: MARK + 430, s: 0.92, a: 0.04, b: 1 }, { p: MARK + 170, s: 0.55, a: 0.28, b: 0.88 }, { p: MARK + 720, s: 0.72, a: 0.0, b: 0.62 }, { p: MARK + 980, s: 0.5, a: 0.42, b: 1 },
  { p: MARK + 300, s: 0.38, a: 0.0, b: 0.3 }, { p: MARK - 190, s: 0.62, a: 0.08, b: 1 }, { p: MARK - 460, s: 0.95, a: 0.0, b: 0.84 }, { p: MARK - 820, s: 0.52, a: 0.2, b: 1 },
  { p: MARK - 320, s: 0.42, a: 0.55, b: 1 }, { p: MARK - 1000, s: 0.7, a: 0.35, b: 0.95 }, { p: MARK + 560, s: 0.33, a: 0.7, b: 1 }, { p: MARK - 90, s: 0.3, a: 0.15, b: 0.5 },
];
const sizeOf = (s: number): number => 2e6 * Math.exp(3.0 * s);
const NOISE = Array.from({ length: 70 }, (_, i) => ({ p: MARK - 1150 + ((i * 937) % 2300), s: 0.08 + ((i * 53) % 21) / 100, a: ((i * 31) % 70) / 100, b: Math.min(1, ((i * 31) % 70) / 100 + 0.2 + ((i * 17) % 40) / 100) }));
const CANDLES = Array.from({ length: 40 }, (_, i) => {
  const at = (k: number): number => MARK + 240 * Math.sin(k * 0.33) + 130 * Math.sin(k * 0.91 + 1) - 40;
  const open = at(i), close = at(i + 1), wick = 40 + ((i * 29) % 90);
  return { open, close, high: Math.max(open, close) + wick, low: Math.min(open, close) - wick * 0.8 };
});

interface Dom { t0: number; t1: number; p0: number; p1: number }
interface Box { x: number; y: number; w: number; h: number }
const xOf = (b: Box, d: Dom, t: number): number => b.x + (t - d.t0) / (d.t1 - d.t0) * b.w;
const yOf = (b: Box, d: Dom, p: number): number => b.y + b.h - (p - d.p0) / (d.p1 - d.p0) * b.h;

function niceStep(span: number, target: number): number {
  const raw = span / target, mag = 10 ** Math.floor(Math.log10(raw)), f = raw / mag;
  return (f < 1.5 ? 1 : f < 3.5 ? 2 : f < 7.5 ? 5 : 10) * mag;
}

interface ChartOptions { heat?: 'colour' | 'grey' | 'none'; candles?: boolean; mark?: boolean; axis?: boolean; timeGrid?: boolean; tFrom?: number; window?: [number, number]; candleSlots?: number }

/** The chart: grid, the map as streaks, candles and the mark line, clipped to `b`. `window` shifts which sizes get a colour (the contrast slider). */
function chart(g: Ctx, b: Box, d: Dom, th: Theme, o: ChartOptions = {}): void {
  g.save();
  g.fillStyle = th.panel; g.fillRect(b.x, b.y, b.w, b.h);
  g.beginPath(); g.rect(b.x, b.y, b.w, b.h); g.clip();
  const step = niceStep(d.p1 - d.p0, 6);
  g.strokeStyle = th.line; g.lineWidth = 1; g.globalAlpha = 0.7; g.beginPath();
  for (let p = Math.ceil(d.p0 / step) * step; p <= d.p1; p += step) { const y = Math.round(yOf(b, d, p)) + 0.5; g.moveTo(b.x, y); g.lineTo(b.x + b.w, y); }
  if (o.timeGrid !== false) for (let t = 0.2; t < 1; t += 0.2) { const x = Math.round(xOf(b, d, t)) + 0.5; g.moveTo(x, b.y); g.lineTo(x, b.y + b.h); }
  g.stroke(); g.globalAlpha = 1;
  if (o.heat !== 'none') {
    const [lo, hi] = o.window ?? [0, 1], span = Math.max(hi - lo, 0.05);
    const band = Math.max(3, (34 / (d.p1 - d.p0)) * b.h);
    for (const w of [...NOISE, ...WALLS]) {
      const s = (w.s - lo) / span; if (s <= 0.02) continue;
      const a = Math.max(w.a, o.tFrom ?? 0), x0 = xOf(b, d, a), x1 = xOf(b, d, w.b); if (x1 <= x0) continue;
      g.fillStyle = o.heat === 'grey' ? grey(th, s) : ramp(th, clamp(s), clamp(s * 3));
      g.fillRect(x0, yOf(b, d, w.p) - band / 2, x1 - x0, band);
    }
  }
  if (o.candles !== false) {
    const slot = b.w / (d.t1 - d.t0) / CANDLES.length, cw = Math.max(1.5, slot * 0.62);
    CANDLES.forEach((c, i) => {
      const x = xOf(b, d, (i + 0.5) / CANDLES.length); if (x < b.x - cw || x > b.x + b.w + cw) return;
      const up = c.close >= c.open, col = up ? th.bid : th.ask;
      g.strokeStyle = th.text; g.lineWidth = 1; g.beginPath(); g.moveTo(x, yOf(b, d, c.high)); g.lineTo(x, yOf(b, d, c.low)); g.stroke();
      g.fillStyle = col; const y0 = yOf(b, d, Math.max(c.open, c.close)), y1 = yOf(b, d, Math.min(c.open, c.close)); g.fillRect(x - cw / 2, y0, cw, Math.max(1.5, y1 - y0));
    });
  }
  if (o.mark !== false) { const y = yOf(b, d, MARK); g.strokeStyle = th.ask; g.setLineDash([4, 3]); g.beginPath(); g.moveTo(b.x, y + 0.5); g.lineTo(b.x + b.w, y + 0.5); g.stroke(); g.setLineDash([]); }
  g.restore();
  g.strokeStyle = th.line; g.lineWidth = 1; g.strokeRect(b.x + 0.5, b.y + 0.5, b.w - 1, b.h - 1);
  if (o.axis !== false) {
    g.fillStyle = th.muted; font(g, 10); g.textAlign = 'left'; g.textBaseline = 'middle';
    for (let p = Math.ceil(d.p0 / step) * step; p <= d.p1; p += step) { const y = yOf(b, d, p); if (y > b.y + 6 && y < b.y + b.h - 6) g.fillText(priceText(p), b.x + b.w + 6, y); }
  }
}

/** The profile: the book right now as bars to the left of the box's right edge, asks above the mark and bids below. */
function profile(g: Ctx, b: Box, d: Dom, th: Theme, at = 1): void {
  g.save(); g.beginPath(); g.rect(b.x, b.y, b.w, b.h); g.clip();
  g.fillStyle = th.panel; g.fillRect(b.x, b.y, b.w, b.h);
  for (const w of WALLS) {
    if (w.b < 0.8) continue;
    const y = yOf(b, d, w.p), len = (b.w - 6) * clamp(w.s * 1.05) * at, h = Math.max(3, (30 / (d.p1 - d.p0)) * b.h);
    g.fillStyle = w.p > MARK ? th.ask : th.bid; g.globalAlpha = 0.85; g.fillRect(b.x + b.w - len, y - h / 2, len, h);
  }
  g.restore(); g.strokeStyle = th.line; g.strokeRect(b.x + 0.5, b.y + 0.5, b.w - 1, b.h - 1);
}

/** A keyboard key or pointer action as a small pill. */
function badge(g: Ctx, text: string, x: number, y: number, th: Theme, active = 1): number {
  font(g, 11, 600); const w = g.measureText(text).width + 16;
  g.save(); g.globalAlpha = 0.55 + 0.45 * active;
  g.fillStyle = th.text; g.beginPath(); g.roundRect(x, y, w, 22, 6); g.fill();
  g.fillStyle = th.bg; g.textAlign = 'left'; g.textBaseline = 'middle'; g.fillText(text, x + 8, y + 11.5); g.restore();
  return w;
}
/** A mouse pointer with its tip at (x, y). */
function pointer(g: Ctx, x: number, y: number, th: Theme, hand = false): void {
  g.save(); g.translate(x, y); g.fillStyle = th.text; g.strokeStyle = th.bg; g.lineWidth = 1.5; g.lineJoin = 'round';
  g.beginPath();
  if (hand) { g.arc(4, 7, 7, 0, Math.PI * 2); } else { g.moveTo(0, 0); g.lineTo(0, 15); g.lineTo(4, 11.5); g.lineTo(7, 18); g.lineTo(9.5, 17); g.lineTo(6.5, 10.5); g.lineTo(11.5, 10.5); g.closePath(); }
  g.fill(); g.stroke(); g.restore();
}
/** A mouse with a wheel, the wheel lit when `on`. */
function mouseIcon(g: Ctx, x: number, y: number, th: Theme, spin: number): void {
  g.save(); g.translate(x, y); g.strokeStyle = th.text; g.fillStyle = th.panel; g.lineWidth = 1.5;
  g.beginPath(); g.roundRect(0, 0, 22, 34, 11); g.fill(); g.stroke(); g.beginPath(); g.moveTo(0, 14); g.lineTo(22, 14); g.stroke();
  g.fillStyle = th.ui; g.beginPath(); g.roundRect(9, 3 + spin * 6, 4, 8, 2); g.fill(); g.restore();
}
function note(g: Ctx, text: string, x: number, y: number, th: Theme, align: CanvasTextAlign = 'left', color = th.muted, size = 11, weight = 400, pill = false): void {
  font(g, size, weight); g.textAlign = align; g.textBaseline = 'middle';
  if (pill) { const w = g.measureText(text).width + 14, left = align === 'left' ? x - 7 : align === 'right' ? x - w + 7 : x - w / 2; g.save(); g.globalAlpha = 0.88; g.fillStyle = th.panel; g.beginPath(); g.roundRect(left, y - 10, w, 20, 6); g.fill(); g.restore(); }
  g.fillStyle = color; g.fillText(text, x, y);
}

// ---- the scenes ----------------------------------------------------------------------------------------------------------------------

const REGIONS = (w: number, h: number): { id: string; box: Box; title: string; text: string }[] => {
  const top = 28, chartH = Math.round((h - top - 12) * 0.62), lowerH = Math.round((h - top - 12 - chartH - 8) / 2);
  const chartW = Math.round(w * 0.64);
  return [
    { id: 'toolbar', box: { x: 6, y: 4, w: w - 12, h: 20 }, title: 'Toolbar', text: 'The toolbar: market, timeframe, which panes to show, colours, exchanges, Screenshot and Guide.' },
    { id: 'chart', box: { x: 6, y: top, w: chartW, h: chartH }, title: 'The chart', text: 'The chart: candles show what price did, and the coloured map behind them is the order book through time. Warmer means more size waiting at that price.' },
    { id: 'profile', box: { x: 6 + chartW, y: top, w: Math.round(w * 0.08), h: chartH }, title: 'Profile', text: 'The profile: the order book right now, one bar per price. Pink above the price are asks (sellers), green below are bids (buyers).' },
    { id: 'depth', box: { x: 6, y: top + chartH + 8, w: chartW + Math.round(w * 0.08), h: lowerH }, title: 'Depth', text: 'The Depth pane: total bid and ask liquidity near the price, over time.' },
    { id: 'oi', box: { x: 6, y: top + chartH + 16 + lowerH, w: chartW + Math.round(w * 0.08), h: lowerH }, title: 'Open interest', text: 'The Open Interest pane: how many contracts are open, and how that changes with each candle.' },
    { id: 'book', box: { x: 6 + chartW + Math.round(w * 0.08) + 44, y: top, w: w - (6 + chartW + Math.round(w * 0.08) + 44) - 6, h: h - top - 6 }, title: 'Order book', text: 'The order book ladder: every price with the size resting there, one column per exchange and a bar for the combined size.' },
  ];
};

const anatomy: Scene = {
  duration: 9000, rest: 0.25, height: 330,
  draw(g, w, h, u, th, ptr) {
    const regions = REGIONS(w, h), by = Object.fromEntries(regions.map(r => [r.id, r.box])) as Record<string, Box>;
    g.fillStyle = th.bg; g.fillRect(0, 0, w, h);
    // toolbar strip
    g.fillStyle = th.panel; g.fillRect(by.toolbar!.x, by.toolbar!.y, by.toolbar!.w, by.toolbar!.h); g.strokeStyle = th.line; g.strokeRect(by.toolbar!.x + 0.5, by.toolbar!.y + 0.5, by.toolbar!.w - 1, by.toolbar!.h - 1);
    let x = by.toolbar!.x + 8; for (const label of ['BTC', '1h', 'Profile', 'Depth', 'OI', 'Footprint', 'Mirror', 'Trades']) { font(g, 10, 600); const tw = g.measureText(label).width + 10; g.fillStyle = label === 'Profile' || label === 'Depth' || label === 'OI' ? th.text : th.line; g.beginPath(); g.roundRect(x, by.toolbar!.y + 4, tw, 12, 3); g.fill(); g.fillStyle = label === 'Profile' || label === 'Depth' || label === 'OI' ? th.bg : th.muted; g.textAlign = 'left'; g.textBaseline = 'middle'; g.fillText(label, x + 5, by.toolbar!.y + 10.5); x += tw + 5; }
    const live = 0.84 + 0.05 * Math.sin(u * Math.PI * 2);
    const d: Dom = { t0: 0, t1: 1, p0: MARK - 1250, p1: MARK + 1250 };
    chart(g, by.chart!, d, th, { axis: false });
    profile(g, by.profile!, d, th, live);
    // depth + OI
    for (const id of ['depth', 'oi'] as const) { const b = by[id]!; g.fillStyle = th.panel; g.fillRect(b.x, b.y, b.w, b.h); g.strokeStyle = th.line; g.strokeRect(b.x + 0.5, b.y + 0.5, b.w - 1, b.h - 1); note(g, id === 'depth' ? 'Depth' : 'Open interest', b.x + 6, b.y + 9, th, 'left', th.text, 10, 650); }
    { const b = by.depth!; for (let i = 0; i < 46; i++) { const bx = b.x + 8 + i * ((b.w - 16) / 46), hh = (b.h - 20) / 2 * (0.5 + 0.4 * Math.sin(i * 0.6) * Math.cos(i * 0.21)); g.fillStyle = th.ask; g.globalAlpha = 0.7; g.fillRect(bx, b.y + b.h / 2 + 4 - hh, 4, hh); g.fillStyle = th.bid; g.fillRect(bx, b.y + b.h / 2 + 4, 4, hh * 0.9); g.globalAlpha = 1; } }
    { const b = by.oi!; g.strokeStyle = th.text; g.lineWidth = 1.5; g.beginPath(); for (let i = 0; i <= 60; i++) { const px = b.x + 8 + i * ((b.w - 16) / 60), py = b.y + b.h - 8 - (b.h - 22) * (0.45 + 0.3 * Math.sin(i * 0.12) + 0.12 * Math.sin(i * 0.5)); i ? g.lineTo(px, py) : g.moveTo(px, py); } g.stroke(); g.lineWidth = 1; }
    // order book ladder
    { const b = by.book!; g.fillStyle = th.panel; g.fillRect(b.x, b.y, b.w, b.h); g.strokeStyle = th.line; g.strokeRect(b.x + 0.5, b.y + 0.5, b.w - 1, b.h - 1);
      const rows = Math.floor((b.h - 8) / 9), mid = Math.floor(rows / 2);
      for (let i = 0; i < rows; i++) { const ask = i < mid, k = ask ? mid - i : i - mid + 1, len = (b.w - 10) * clamp(0.15 + 0.7 * Math.abs(Math.sin(k * 1.7)) * Math.exp(-k / 14)) * live; g.fillStyle = ask ? th.ask : th.bid; g.globalAlpha = 0.45; g.fillRect(b.x + 4, b.y + 4 + i * 9, len, 7); g.globalAlpha = 1; } }
    if (ptr) { const hit = regions.find(r => ptr.x >= r.box.x && ptr.x <= r.box.x + r.box.w && ptr.y >= r.box.y && ptr.y <= r.box.y + r.box.h && r.id !== 'toolbar') ?? regions.find(r => r.id === 'toolbar' && ptr.y <= 26);
      if (hit) { g.strokeStyle = th.ui; g.lineWidth = 2.5; g.strokeRect(hit.box.x + 1, hit.box.y + 1, hit.box.w - 2, hit.box.h - 2); g.lineWidth = 1; badge(g, hit.title, Math.min(hit.box.x + 8, w - 110), hit.box.y + 8, th); } }
    else { // with no pointer, the parts introduce themselves one after another
      const hit = regions[Math.min(regions.length - 1, Math.floor(u * regions.length))]!;
      g.strokeStyle = th.ui; g.lineWidth = 2.5; g.globalAlpha = 0.9; g.strokeRect(hit.box.x + 1, hit.box.y + 1, hit.box.w - 2, hit.box.h - 2); g.lineWidth = 1; g.globalAlpha = 1; badge(g, hit.title, Math.min(hit.box.x + 8, w - 110), hit.box.y + 8, th);
    }
  },
  describe(w, h, x, y) { const hit = REGIONS(w, h).find(r => x >= r.box.x && x <= r.box.x + r.box.w && y >= r.box.y && y <= r.box.y + r.box.h); return hit ? hit.text : null; },
};

const colours: Scene = {
  duration: 8000, rest: 0.5, height: 250,
  draw(g, w, h, u, th) {
    g.fillStyle = th.bg; g.fillRect(0, 0, w, h);
    const slide = Math.sin(u * Math.PI * 2) * 0.5 + 0.5;            // 0: window low (thin liquidity coloured) .. 1: window high (only the biggest)
    const lo = mix(-0.2, 0.55, slide), hi = lo + 0.55;
    const b: Box = { x: 8, y: 8, w: w - 16, h: h - 88 };
    chart(g, b, { t0: 0, t1: 1, p0: MARK - 1200, p1: MARK + 1200 }, th, { candles: false, mark: false, axis: false, window: [lo, hi] });
    // the colour bar with the window outlined on it
    const bar: Box = { x: 8, y: h - 62, w: w - 16, h: 16 };
    for (let i = 0; i < bar.w; i++) { g.fillStyle = ramp(th, i / bar.w); g.fillRect(bar.x + i, bar.y, 1, bar.h); }
    g.strokeStyle = th.text; g.lineWidth = 2; g.strokeRect(bar.x + clamp(lo) * bar.w, bar.y - 3, clamp(hi - clamp(lo)) * bar.w, bar.h + 6); g.lineWidth = 1;
    note(g, 'small', bar.x, bar.y + 28, th); note(g, 'large', bar.x + bar.w, bar.y + 28, th, 'right');
    note(g, slide < 0.3 ? 'Window low: thin liquidity gets a colour' : slide > 0.7 ? 'Window high: only the biggest walls stay coloured' : 'The window slides along the size axis', w / 2, bar.y + 28, th, 'center', th.text, 11.5, 600);
    // the slider
    const sx = 16, sw = 120; g.strokeStyle = th.line; g.lineWidth = 3; g.lineCap = 'round'; g.beginPath(); g.moveTo(sx, h - 10); g.lineTo(sx + sw, h - 10); g.stroke(); g.fillStyle = th.ui; g.beginPath(); g.arc(sx + sw * (1 - slide), h - 10, 6, 0, Math.PI * 2); g.fill(); g.lineCap = 'butt'; g.lineWidth = 1;
    note(g, 'Contrast', sx + sw + 14, h - 10, th);
  },
};

const recording: Scene = {
  duration: 11000, rest: 0.55, height: 290,
  draw(g, w, h, u, th) {
    g.fillStyle = th.bg; g.fillRect(0, 0, w, h);
    const e = smooth((u - 0.06) / 0.78) * 75;                       // minutes since the page was opened, in a 75 minute view
    const b: Box = { x: 8, y: 26, w: w - 70, h: h - 62 }, d: Dom = { t0: 0, t1: 1, p0: MARK - 1250, p1: MARK + 1250 };
    const since = (75 - e) / 75;                                     // where recording began, as a share of the view
    g.fillStyle = th.panel; g.fillRect(b.x, b.y, b.w, b.h);
    g.save(); g.beginPath(); g.rect(b.x, b.y, b.w, b.h); g.clip();
    const band = Math.max(3, 34 / (d.p1 - d.p0) * b.h), sx = b.x + since * b.w;
    // grey: the current book copied back to the left edge, on the same scale
    for (const wall of WALLS) g.fillStyle = grey(th, wall.s), g.fillRect(b.x, yOf(b, d, wall.p) - band / 2, since * b.w, band);
    // colour: what was recorded, from the moment the page was opened (walls that came later start later)
    for (const wall of [...NOISE, ...WALLS]) {
      const x0 = sx + (b.x + b.w - sx) * Math.min(0.6, wall.a * 0.4); if (x0 >= b.x + b.w) continue;
      g.fillStyle = ramp(th, wall.s, clamp(wall.s * 3)); g.fillRect(x0, yOf(b, d, wall.p) - band / 2, b.x + b.w - x0, band);
    }
    g.restore();
    g.strokeStyle = th.line; g.strokeRect(b.x + 0.5, b.y + 0.5, b.w - 1, b.h - 1);
    const my = yOf(b, d, MARK); g.strokeStyle = th.ask; g.setLineDash([4, 3]); g.beginPath(); g.moveTo(b.x, my + 0.5); g.lineTo(b.x + b.w, my + 0.5); g.stroke();
    g.strokeStyle = th.text; g.setLineDash([2, 4]); g.beginPath(); g.moveTo(sx + 0.5, b.y); g.lineTo(sx + 0.5, b.y + b.h); g.stroke(); g.setLineDash([]);
    note(g, 'Page open for', 10, 12, th, 'left', th.muted, 11); note(g, `${Math.round(e)} min`, 88, 12, th, 'left', th.text, 12, 700);
    if (since > 0.3) note(g, 'Grey: the current book, copied back', b.x + since * b.w * 0.5, b.y + 14, th, 'center', th.text, 11, 600);
    if (since < 0.7) note(g, 'Colour: recorded while the page was open', Math.max(b.x + 150, sx + (b.x + b.w - sx) / 2), b.y + b.h - 12, th, 'center', th.text, 11, 600);
    if (e < 6) note(g, 'depth recorded from here', Math.min(sx + 8, b.x + b.w - 130), b.y - 8, th, 'left', th.text, 10);
    note(g, 'now', b.x + b.w, b.y + b.h + 12, th, 'right'); note(g, '75 min ago', b.x, b.y + b.h + 12, th, 'left');
  },
};

function zoomScene(axis: 'price' | 'time'): Scene {
  return {
    duration: 7000, rest: 0.4, height: 290,
    draw(g, w, h, u, th) {
      g.fillStyle = th.bg; g.fillRect(0, 0, w, h);
      const b: Box = { x: 8, y: 8, w: w - 78, h: h - 36 };
      const k = breathe(u), z = 1 - 0.6 * k;                         // 1 = whole range, smaller = zoomed in
      const px = axis === 'time' ? 0.88 : 0.62, py = axis === 'price' ? 0.5 : 0.4; // what holds still, as shares of the box: the live edge for time, the current price for price
      const base: Dom = { t0: 0.35, t1: 1, p0: MARK - 1250, p1: MARK + 1250 };
      const d: Dom = { ...base };
      if (axis === 'price') { const anchor = mix(base.p1, base.p0, py); d.p0 = anchor + (base.p0 - anchor) * z; d.p1 = anchor + (base.p1 - anchor) * z; }
      else { const anchor = mix(base.t0, base.t1, px); d.t0 = anchor + (base.t0 - anchor) * z; d.t1 = anchor + (base.t1 - anchor) * z; }
      chart(g, b, d, th, { axis: true });
      const cx = b.x + px * b.w, cy = b.y + py * b.h;
      g.strokeStyle = th.muted; g.setLineDash([3, 3]); g.beginPath(); if (axis === 'price') { g.moveTo(b.x, cy + 0.5); g.lineTo(b.x + b.w, cy + 0.5); } else { g.moveTo(cx + 0.5, b.y); g.lineTo(cx + 0.5, b.y + b.h); } g.stroke(); g.setLineDash([]);
      // The wheel on the chart zooms time; on the price scale, at the right, it zooms price.
      if (axis === 'price') pointer(g, b.x + b.w + 34, b.y + 0.3 * b.h, th); else pointer(g, b.x + 0.5 * b.w, b.y + 0.3 * b.h, th);
      const lit = k > 0.04 && k < 0.96 ? 1 : 0;
      badge(g, axis === 'price' ? 'Wheel on the price scale' : 'Wheel on the chart', b.x + 10, b.y + 10, th, lit);
      mouseIcon(g, b.x + b.w - 40, b.y + 10, th, Math.sin(u * Math.PI * 4) * 0.5 + 0.5);
      note(g, axis === 'price' ? (k > 0.5 ? 'Scrolling forward: zoom in' : 'Scrolling back: zoom out') : (k > 0.5 ? 'Scrolling forward: wider candles' : 'Scrolling back: more time'), b.x + 14, b.y + b.h - 16, th, 'left', th.text, 11, 600, true);
    },
  };
}

const pan: Scene = {
  duration: 8000, rest: 0.3, height: 290,
  draw(g, w, h, u, th) {
    g.fillStyle = th.bg; g.fillRect(0, 0, w, h);
    const b: Box = { x: 8, y: 8, w: w - 78, h: h - 36 };
    const k = breathe(u, 0.1);
    const base: Dom = { t0: 0.3, t1: 0.95, p0: MARK - 1000, p1: MARK + 1000 };
    const dt = -0.22 * k, dp = 520 * k;                              // dragging the chart toward the lower left reveals the past and higher prices
    const d: Dom = { t0: base.t0 + dt, t1: base.t1 + dt, p0: base.p0 + dp, p1: base.p1 + dp };
    chart(g, b, d, th, { axis: true });
    const sx = b.x + b.w * 0.7, sy = b.y + b.h * 0.7, ex = b.x + b.w * 0.36, ey = b.y + b.h * 0.42;
    const cx = mix(sx, ex, k), cy = mix(sy, ey, k);
    if (k > 0.02) { g.strokeStyle = th.ui; g.lineWidth = 2; g.setLineDash([5, 4]); g.beginPath(); g.moveTo(sx, sy); g.lineTo(cx, cy); g.stroke(); g.setLineDash([]); g.lineWidth = 1; }
    pointer(g, cx, cy, th, k > 0.02 && k < 0.98);
    badge(g, 'Drag', b.x + 10, b.y + 10, th, k > 0.02 && k < 0.98 ? 1 : 0);
    note(g, 'Following the live edge stops; Recenter brings it back', b.x + 14, b.y + b.h - 16, th, 'left', th.text, 11, 600, true);
  },
};

const mirror: Scene = {
  duration: 9000, rest: 0.55, height: 300,
  draw(g, w, h, u, th) {
    g.fillStyle = th.bg; g.fillRect(0, 0, w, h);
    const prof: Box = { x: 8, y: 8, w: Math.round(w * 0.46), h: h - 16 }, d: Dom = { t0: 0, t1: 1, p0: MARK - 1250, p1: MARK + 1250 };
    // a taller profile, drawn bar by bar so the bands can be summed
    g.fillStyle = th.panel; g.fillRect(prof.x, prof.y, prof.w, prof.h); g.strokeStyle = th.line; g.strokeRect(prof.x + 0.5, prof.y + 0.5, prof.w - 1, prof.h - 1);
    const k = breathe(u, 0.08), dist = 80 + k * 1050;                // price distance of the pointer from the mark
    const yMark = yOf(prof, d, MARK), yHov = yOf(prof, d, MARK + dist), yMir = yOf(prof, d, MARK - dist);
    g.fillStyle = th.ui; g.globalAlpha = 0.1; g.fillRect(prof.x, yHov, prof.w, yMark - yHov); g.fillRect(prof.x, yMark, prof.w, yMir - yMark); g.globalAlpha = 1;
    let asks = 0, bids = 0;
    for (const wall of WALLS) {
      const y = yOf(prof, d, wall.p), len = (prof.w - 14) * clamp(wall.s * 1.05), hh = 10, within = wall.p > MARK ? wall.p <= MARK + dist : wall.p >= MARK - dist;
      g.fillStyle = wall.p > MARK ? th.ask : th.bid; g.globalAlpha = within ? 0.95 : 0.25; g.fillRect(prof.x + prof.w - 6 - len, y - hh / 2, len, hh); g.globalAlpha = 1;
      if (within) { if (wall.p > MARK) asks += sizeOf(wall.s); else bids += sizeOf(wall.s); }
    }
    g.strokeStyle = th.ask; g.setLineDash([4, 3]); g.beginPath(); g.moveTo(prof.x, yMark + 0.5); g.lineTo(prof.x + prof.w, yMark + 0.5); g.stroke(); g.setLineDash([]);
    for (const y of [yHov, yMir]) { g.strokeStyle = th.ui; g.lineWidth = 1.5; g.beginPath(); g.moveTo(prof.x, y + 0.5); g.lineTo(prof.x + prof.w, y + 0.5); g.stroke(); g.lineWidth = 1; }
    pointer(g, prof.x + prof.w * 0.5, yHov, th);
    // the box
    const bx = prof.x + prof.w + 22, bw = w - bx - 10, ratio = Math.max(asks, bids) / Math.max(1, Math.min(asks, bids));
    g.fillStyle = th.panel; g.strokeStyle = th.line; g.beginPath(); g.roundRect(bx, 40, bw, 150, 8); g.fill(); g.stroke();
    note(g, `±$${priceText(dist)}  from the price`, bx + 12, 58, th, 'left', th.muted, 11);
    note(g, `Asks (this side)  ${money(asks)}`, bx + 12, 84, th, 'left', th.ask, 12.5, 650);
    note(g, `Bids (opposite)  ${money(bids)}`, bx + 12, 108, th, 'left', th.bid, 12.5, 650);
    const verdict = asks <= 0 && bids <= 0 ? 'No liquidity in this range' : ratio < 1.05 ? 'Balanced' : `${asks > bids ? 'Asks' : 'Bids'} have ${ratio.toFixed(2)}x more`;
    note(g, verdict, bx + 12, 140, th, 'left', asks > bids * 1.05 ? th.ask : bids > asks * 1.05 ? th.bid : th.text, 13, 700);
    note(g, 'Move outward: the balance changes', bx + 12, 168, th, 'left', th.muted, 10.5);
    badge(g, 'Hover', bx, 206, th, 1);
    note(g, 'in the profile or the order book', bx + 62, 217, th, 'left', th.muted, 11);
  },
};

const FOOT_ROWS: { buy: number; sell: number }[] = [ // bottom to top, price rows of one candle that opened at row 6 and closed at row 1 (closed low)
  { buy: 0.25, sell: 0.6 }, { buy: 0.3, sell: 0.8 }, { buy: 0.5, sell: 0.45 }, { buy: 0.55, sell: 0.5 }, { buy: 0.45, sell: 0.5 }, { buy: 0.5, sell: 0.55 }, { buy: 0.6, sell: 0.5 },
  { buy: 0.5, sell: 0.4 }, { buy: 0.4, sell: 0.2 }, { buy: 2.4, sell: 0.4 }, { buy: 3.2, sell: 0.5 }, { buy: 3.0, sell: 0.3 }, { buy: 1.4, sell: 0.2 },
];
const footprint: Scene = {
  duration: 14000, rest: 0.9, height: 330,
  draw(g, w, h, u, th) {
    g.fillStyle = th.bg; g.fillRect(0, 0, w, h);
    const zoom = smooth((u - 0.06) / 0.2), numbers = smooth((u - 0.2) / 0.12), bars = smooth((u - 0.36) / 0.14), trap = smooth((u - 0.58) / 0.14);
    const cx = w * 0.5, rowsN = FOOT_ROWS.length, top = 28, rowH = (h - top - 30) / rowsN;
    const slotW = mix(60, Math.min(w - 40, 520), zoom), left = cx - slotW / 2;
    g.fillStyle = th.panel; g.fillRect(left, top - 6, slotW, h - top - 18); g.strokeStyle = th.line; g.strokeRect(left + 0.5, top - 5.5, slotW - 1, h - top - 19);
    // the candle (opened high, wicked up, closed low), left of its slot once zoomed
    const candleX = mix(cx, left + 24, smooth(zoom * 1.4)), yRow = (r: number): number => top + (rowsN - 1 - r) * rowH;
    g.strokeStyle = th.text; g.lineWidth = 1.5; g.beginPath(); g.moveTo(candleX, yRow(12) + rowH / 2); g.lineTo(candleX, yRow(0) + rowH / 2); g.stroke(); g.lineWidth = 1;
    g.fillStyle = th.ask; g.fillRect(candleX - 9, yRow(6), 18, yRow(1) - yRow(6) + rowH);
    // rows
    const colL = left + 56, colW = slotW - 64, maxSide = 3.4;
    font(g, 10.5, 500);
    for (let r = 0; r < rowsN; r++) {
      const { buy, sell } = FOOT_ROWS[r]!, y = yRow(r), dominant = buy >= 1.15 * sell && buy > 0.45 ? 'buy' : sell >= 1.15 * buy ? 'sell' : null;
      if (zoom > 0.5 && bars > 0) { const side = dominant; if (side) { g.globalAlpha = 0.65 * bars; g.fillStyle = side === 'buy' ? th.bid : th.ask; g.fillRect(colL, y + 1, Math.max(3, colW * Math.max(buy, sell) / maxSide * 0.78), rowH - 2); g.globalAlpha = 1; } }
      if (numbers > 0.02 && slotW > 200) { g.globalAlpha = numbers; g.fillStyle = th.text; g.textBaseline = 'middle'; g.textAlign = 'right'; g.fillText(`${(sell * 2.1).toFixed(1)}M`, colL + 42, y + rowH / 2); g.textAlign = 'left'; g.fillText(`${(buy * 2.1).toFixed(1)}M`, colL + 50, y + rowH / 2); g.globalAlpha = 1; }
    }
    // the trap: the busiest wick cells glow and pulse
    if (trap > 0.01) {
      const pulse = 0.5 + 0.5 * Math.sin(u * Math.PI * 2 * 7);
      for (let r = 9; r <= 11; r++) { const { buy } = FOOT_ROWS[r]!, y = yRow(r), len = Math.max(3, colW * buy / maxSide * 0.78); g.fillStyle = `rgba(245, 165, 36, ${(0.15 + 0.3 * pulse) * trap})`; g.fillRect(colL - 1, y, len + 2, rowH); g.strokeStyle = `rgba(245, 165, 36, ${(0.4 + 0.5 * pulse) * trap})`; g.strokeRect(colL - 0.5, y + 0.5, len + 1, rowH - 1); }
      g.globalAlpha = trap; note(g, 'Rejected aggressive buying', left + slotW - 10, yRow(7) + rowH / 2, th, 'right', '#f5a524', 12.5, 700); note(g, 'net buying in the wick, then a close far below', left + slotW - 10, yRow(7) + rowH / 2 + 18, th, 'right', th.muted, 11); g.globalAlpha = 1;
    }
    badge(g, zoom < 0.5 ? 'Zoomed out' : numbers < 0.8 ? 'Zooming in…' : bars < 0.8 ? 'Sell | Buy volume per price' : trap < 0.8 ? 'Bars: one side at least 15% bigger' : 'Rejected buying', 10, 4, th, 1);
    note(g, 'sell', colL + 42, h - 8, th, 'right', th.muted, 10); note(g, 'buy', colL + 50, h - 8, th, 'left', th.muted, 10);
  },
};

export const SCENES: Readonly<Record<FigureId, Scene>> = { anatomy, colours, recording, 'zoom-price': zoomScene('price'), 'zoom-time': zoomScene('time'), pan, mirror, footprint };

// ---- the widget ----------------------------------------------------------------------------------------------------------------------

const reduced = (): boolean => typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;

/** A figure: its canvas, a play/pause button and a scrub slider, animating only while it is on screen and playing. */
export function createFigure(id: FigureId, caption: string): { root: HTMLElement; dispose(): void } {
  const scene = SCENES[id];
  const canvas = el('canvas', { class: 'fig-canvas', role: 'img', ariaLabel: caption });
  const play = el('button', { type: 'button', class: 'fig-play', tip: 'Pause or play', ariaLabel: 'Pause or play' });
  const scrub = el('input', { type: 'range', class: 'fig-scrub', min: '0', max: '1000', value: String(Math.round(scene.rest * 1000)), tip: 'Drag to scrub through the animation', ariaLabel: 'Scrub the animation' });
  const hint = isCoarse() ? 'Tap the picture to see what each part is.' : 'Move the pointer over the picture.';
  const hover = el('div', { class: 'fig-hover', textContent: scene.describe ? hint : '' });
  const root = el('figure', { class: 'fig' }, canvas, el('div', { class: 'fig-bar' }, play, scrub), el('figcaption', { textContent: caption }), ...(scene.describe ? [hover] : []));
  let playing = !reduced(), visible = false, u = scene.rest, last = 0, frame = 0, ptr: { x: number; y: number } | null = null, size = { w: 0, h: 0 };
  let disposed = false;

  const fit = (): void => {
    const w = Math.max(280, Math.floor(canvas.getBoundingClientRect().width || 600)), h = scene.height, dpr = Math.min(2, window.devicePixelRatio || 1);
    if (w === size.w) return;
    size = { w, h }; canvas.width = Math.round(w * dpr); canvas.height = Math.round(h * dpr); canvas.style.height = `${h}px`;
  };
  const paint = (): void => {
    fit(); const g = canvas.getContext('2d')!, dpr = canvas.width / size.w;
    g.setTransform(dpr, 0, 0, dpr, 0, 0); g.clearRect(0, 0, size.w, size.h);
    scene.draw(g, size.w, size.h, u, readTheme(), ptr);
    scrub.value = String(Math.round(u * 1000));
    play.textContent = playing ? '❚❚' : '▶';
    if (scene.describe) hover.textContent = ptr ? scene.describe(size.w, size.h, ptr.x, ptr.y) ?? hint : hint;
  };
  const tick = (now: number): void => {
    frame = 0; if (disposed || !visible) return;
    if (playing && !ptr) { if (last) u = (u + (now - last) / scene.duration) % 1; }
    last = now;
    if (now - lastPaint >= 30 || !playing) { lastPaint = now; paint(); }
    if (playing) frame = requestAnimationFrame(tick);
  };
  let lastPaint = 0;
  const start = (): void => { if (!frame && visible && !disposed) { last = 0; frame = requestAnimationFrame(tick); } };

  play.onclick = () => { playing = !playing; if (playing) start(); else paint(); };
  scrub.oninput = () => { playing = false; u = Number(scrub.value) / 1000; paint(); };
  canvas.addEventListener('pointermove', e => { const r = canvas.getBoundingClientRect(); ptr = scene.describe ? { x: e.clientX - r.left, y: e.clientY - r.top } : null; if (!playing) paint(); });
  // A finger has no hover: a tap describes that spot and keeps it (the picture holds still), and a tap on the same spot lets go.
  canvas.addEventListener('pointerdown', e => {
    if (e.pointerType !== 'touch' || !scene.describe) return;
    const r = canvas.getBoundingClientRect(), at = { x: e.clientX - r.left, y: e.clientY - r.top };
    ptr = ptr && Math.hypot(ptr.x - at.x, ptr.y - at.y) < 14 ? null : at;
    if (!ptr) { last = 0; start(); }
    paint();
  });
  canvas.addEventListener('pointerleave', e => { if (e.pointerType === 'touch') return; ptr = null; if (!playing) paint(); });
  const watcher = new IntersectionObserver(entries => { visible = entries.some(e => e.isIntersecting); if (visible) { paint(); if (playing) start(); } }, { rootMargin: '80px' });
  watcher.observe(root);
  const resize = new ResizeObserver(() => { if (visible) paint(); });
  resize.observe(canvas);
  queueMicrotask(() => { if (!disposed) paint(); });
  return { root, dispose() { disposed = true; watcher.disconnect(); resize.disconnect(); if (frame) cancelAnimationFrame(frame); } };
}
