import type { View } from '../view.ts';
import { PALETTES, type Palette } from '../theme.ts';
import type { LabelBoard } from '../labels.ts';
import { t } from '../i18n.ts';
import { price as fmtPrice, usd } from '../format.ts';
import { ageAlpha, LABEL_FLOOR } from '../traded/carry.ts';
import { letterOf, type TpoProfile } from './model.ts';
import type { TpoSettings } from './settings.ts';

/**
 * Drawing the TPO on the map (Karl's reference, 2026-11-10: block profiles per session, coloured by the time of each block, the point of
 * control's row standing out, the value area full and the rest dimmer, the initial balance marked at the left, the open and the last price,
 * a few numbers under each profile). Each window's profile stands at its start, under the candles, over a backing that mutes the heat map;
 * laid out in time (`fold` 1), each block stands in its own column at its time, behind its own candles. By zoom: letters while a block is
 * big enough to hold one, blocks, then compact: zoomed out, each row as one bar as long as its blocks (Karl, 2026-11-11: a 1-pixel outline
 * vanished on the heat map, so the TPO seemed to be drawn only where the page had recorded), in the colour of when the market was at that
 * price, or of how full the row is; laid out, each block as one bar at its time. A block this market's wick alone reached (tpo/model.ts
 * `hollowRows`) is drawn as an outline; compact, each block's own rows are counted, as the point of control counts them, and what one chosen
 * market alone reached is left out. A block's cells share one colour, so they are filled a block at a time (by
 * time) or a row at a time (by row length).
 */

/** Where one profile's cells were drawn, for the pointer (`cellAt`) and the lit block (`paintLit`). */
export interface TpoGeometry {
  profile: TpoProfile;
  x0: number; cw: number; ucw: number; rh: number; fold: number;
  /** Per row, the blocks in it, oldest first (a folded row's cells in that order from `x0`). */
  rows: Map<number, number[]>;
  /** Block index to its unfolded x (the cell's left). */
  unfoldX: Map<number, number>;
  /** Drawn compact (rows or blocks too fine for cells): the row under the pointer is known, not the block. */
  compact: boolean;
  /** Per row, the blocks counted there (the compact bar's length). */
  solid: Map<number, { n: number; mean: number }>;
}

/** The time ramp, early to late: warm to cool as on the reference chart, a hue apart from the heat map's ramp (dark and light pages). */
const TIME_DARK = ['#ff6b6b', '#ff9f43', '#ffd166', '#a3e05f', '#3ddc97', '#35c9d6', '#4f9cff', '#9b7bff'];
const TIME_LIGHT = ['#d62f2f', '#dd5e0b', '#b07800', '#4e8f0f', '#0b9a6f', '#0f8ea3', '#1f6fd1', '#6a45e0'];
/** How full a row is: thin to full, cool to hot. */
const COUNT_DARK = ['#4f6bff', '#2fb7d6', '#3ddc97', '#ffd166', '#ff9f43', '#ff5c5c'];
const COUNT_LIGHT = ['#3550d8', '#0f8ea3', '#0b9a6f', '#b07800', '#dd5e0b', '#d62f2f'];
/** The Colour-blind safe themes' ramps: blue to yellow, one lightness step at a time, no red against green (for both orders); darker on a light page. */
const SAFE = ['#3b6fd8', '#2a9fd0', '#3fbfa8', '#9fcf6a', '#e8d64b', '#f5b941'];
const SAFE_LIGHT = ['#1f4fbf', '#1979ad', '#178f86', '#5f9a35', '#8f7f00', '#a8650a'];
/** The initial balance's and the single prints' marks: amber, as the other marks of what stands out. */
const AMBER_DARK = '#f2b84b', AMBER_LIGHT = '#a35f00';

function hex(c: string): [number, number, number] { const n = parseInt(c.slice(1), 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255]; }
const rgb = (c: [number, number, number]): string => `rgb(${Math.round(c[0])},${Math.round(c[1])},${Math.round(c[2])})`;
function at(stops: readonly string[], f: number): [number, number, number] {
  const x = Math.max(0, Math.min(1, f)) * (stops.length - 1), i = Math.min(stops.length - 2, Math.floor(x)), u = x - i;
  const a = hex(stops[i]!), b = hex(stops[i + 1]!);
  return [a[0] + (b[0] - a[0]) * u, a[1] + (b[1] - a[1]) * u, a[2] + (b[2] - a[2]) * u];
}
const mixed = (a: [number, number, number], b: [number, number, number], f: number): [number, number, number] => [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f, a[2] + (b[2] - a[2]) * f];
/** Dark or white letters, whichever stands out more on the colour (WCAG luminance). */
function inkOn(c: [number, number, number]): string {
  const lin = (v: number): number => { const s = v / 255; return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; };
  const l = 0.2126 * lin(c[0]) + 0.7152 * lin(c[1]) + 0.0722 * lin(c[2]);
  return (l + 0.05) / 0.0561 >= 1.05 / (l + 0.05) ? '#121418' : '#ffffff';
}

/** One colour of a ramp: its fill, its light stripe (the point of control's row) and the letters on each. */
interface Swatch { fill: string; stripe: string; ink: string; stripeInk: string }
const swatches = new Map<string, Swatch[]>();
/** `n` colours along a ramp (cached), each with its stripe and inks. */
function ramp(stops: readonly string[], n: number, dark: boolean): Swatch[] {
  const key = `${stops.join()}|${n}|${dark}`;
  let out = swatches.get(key);
  if (!out) {
    out = [];
    const light: [number, number, number] = dark ? [255, 255, 255] : [27, 29, 33];
    for (let i = 0; i < n; i++) { const c = at(stops, n > 1 ? i / (n - 1) : 0), s = mixed(c, light, 0.72); out.push({ fill: rgb(c), stripe: rgb(s), ink: inkOn(c), stripeInk: inkOn(s) }); }
    if (swatches.size > 64) swatches.clear();
    swatches.set(key, out);
  }
  return out;
}
const ease = (u: number): number => u < 0.5 ? 4 * u * u * u : 1 - (-2 * u + 2) ** 3 / 2;

/**
 * A profile's rows (as drawn: with what one market alone reached), each block's index in them (worked out when cells are drawn), its hollow
 * rows, and per row the blocks counted there (each block's own rows, not what one market alone reached) and the mean of their letters (when
 * the market was at that price, for the compact look), kept per profile.
 */
interface Layout { rows: Map<number, number[]>; maxCount: number; index: () => Map<number, Map<number, number>>; hollow: Map<number, ReadonlySet<number>>; solid: Map<number, { n: number; mean: number }> }
const layouts = new WeakMap<TpoProfile, Layout>();
function layoutOf(p: TpoProfile): Layout {
  let out = layouts.get(p);
  if (!out) {
    const rows = new Map<number, number[]>(), solid = new Map<number, { n: number; mean: number }>();
    for (const b of p.blocks) for (let r = b.ra; r <= b.rz; r++) {
      const list = rows.get(r); if (list) list.push(b.k); else rows.set(r, [b.k]);
      if (r >= b.a && r <= b.z) { const s = solid.get(r); if (s) { s.mean += (b.k - s.mean) / ++s.n; } else solid.set(r, { n: 1, mean: b.k }); }
    }
    let maxCount = 0, index: Map<number, Map<number, number>> | null = null;
    for (const list of rows.values()) maxCount = Math.max(maxCount, list.length);
    const indexOf = (): Map<number, Map<number, number>> => {
      if (!index) { index = new Map(); for (const [r, list] of rows) list.forEach((k, i) => { let m = index!.get(k); if (!m) { m = new Map(); index!.set(k, m); } m.set(r, i); }); }
      return index;
    };
    out = { rows, maxCount, index: indexOf, hollow: new Map(p.blocks.map(b => [b.k, b.hollow])), solid };
    layouts.set(p, out);
  }
  return out;
}

/** What `paintCompact` draws one profile with. */
interface Compact {
  prof: TpoProfile; x0: number; cw: number; ucw: number; rh: number; fold: number; yTop: (r: number) => number;
  solid: Map<number, { n: number; mean: number }>; maxCount: number; winPx: number;
  colours: Swatch[]; byTime: boolean; fade: number; backing: string; ph: number; unfoldX: Map<number, number>;
}

/** Narrower than this (its longest row, px), a profile zoomed out is drawn as a strip: too thin for its shape to show. */
const STRIP_PX = 3;

/**
 * Compact, for rows or blocks too fine for cells. Folded: the rows are gathered into the pixel rows they fall in, each drawn once over the
 * backing as a bar as long as its longest row (its blocks not hollow), in the colour of the mean time of its blocks (when the market was at
 * that price) or of its length, the value area in full and the rest dimmer, the point of control's as the light stripe. Laid out: each block
 * as one bar at its time, from its low to its high.
 */
function paintCompact(ctx: CanvasRenderingContext2D, c: Compact): void {
  const { prof, x0, cw, rh, yTop, solid, colours, byTime, fade, backing, ph } = c, batch = new RectBatch();
  if (c.fold < 0.5 && (c.winPx < 2 * STRIP_PX || c.maxCount * cw < STRIP_PX)) {
    // A strip as wide as the profile: its range dim, its value area in full and its point of control's row as the light stripe, in the
    // colour of when the market was at the point of control (a year on the map: each day's value moving, at a few rectangles a day).
    const s = solid.get(prof.poc), sw = byTime ? colours[Math.min(colours.length - 1, Math.max(0, Math.round(s?.mean ?? 0)))]! : colours[colours.length - 1]!;
    const w = Math.max(1, Math.min(c.maxCount * cw, Math.max(1, c.winPx))), top = (r: number): number => yTop(r), bottom = (r: number): number => yTop(r) + rh;
    const span = (a: number, z: number): [number, number] => { const y0 = Math.floor(top(z)), y1 = Math.max(y0 + 1, Math.ceil(bottom(a))); return [y0, y1 - y0]; };
    const [ry, rh2] = span(prof.lo, prof.hi), [vy, vh] = span(prof.val, prof.vah), [py, phh] = span(prof.poc, prof.poc);
    fillRects(ctx, backing, 1, [x0 - 1, ry, w + 1, rh2]);
    fillRects(ctx, sw.fill, fade * 0.4, [x0, ry, w, rh2]);
    fillRects(ctx, sw.fill, fade, [x0, vy, w, vh]);
    fillRects(ctx, sw.stripe, fade, [x0, py, w, phh]);
  } else if (c.fold < 0.5) {
    // Rows a pixel tall or more: one bar each. Finer: the rows whose tops fall in one pixel row make one bar a pixel tall.
    interface Px { y: number; h: number; n: number; kSum: number; kN: number; va: boolean; poc: boolean }
    const bins: Px[] = [], fine = rh < 1;
    let cur: Px | null = null;
    for (let r = prof.drawHi; r >= prof.drawLo; r--) {
      const s = solid.get(r);
      if (!s) continue;
      const top = yTop(r);
      if (top + rh < 0 || top > ph) continue;
      const y = fine ? Math.floor(top) : top;
      if (!cur || !fine || y !== cur.y) { cur = { y, h: fine ? 1 : rh, n: 0, kSum: 0, kN: 0, va: false, poc: false }; bins.push(cur); }
      cur.n = Math.max(cur.n, s.n); cur.kSum += s.mean * s.n; cur.kN += s.n;
      if (r >= prof.val && r <= prof.vah) cur.va = true;
      if (r === prof.poc) cur.poc = true;
    }
    const backs: number[] = [];
    for (const b of bins) {
      const sw = byTime ? colours[Math.min(colours.length - 1, Math.max(0, Math.round(b.kSum / b.kN)))]! : colours[Math.min(colours.length - 1, Math.max(0, b.n - 1))]!;
      backs.push(x0 - 1, b.y, Math.max(1, b.n * cw) + 1, b.h);
      batch.add(b.poc ? sw.stripe : sw.fill, fade * (b.poc || b.va ? 1 : 0.4), x0, b.y, Math.max(1, b.n * cw), b.h);
    }
    fillRects(ctx, backing, 1, backs);
  } else {
    const mid = colours[Math.floor((colours.length - 1) / 2)]!, backs: number[] = [];
    for (const b of prof.blocks) {
      const x = c.unfoldX.get(b.k) ?? 0, y = yTop(b.z), h = Math.max(1, yTop(b.a) + rh - y);
      if (y > ph || y + h < 0) continue;
      backs.push(x - 1, y, c.ucw + 2, h);
      batch.add((byTime ? colours[Math.min(colours.length - 1, Math.max(0, b.k))]! : mid).fill, fade, x, y, c.ucw, h);
    }
    fillRects(ctx, backing, 1, backs);
  }
  batch.flush(ctx);
  ctx.globalAlpha = 1;
}

/** Rectangles `xs` (x, y, width, height, ...) filled in one colour and alpha, as one path: one fill for all of them. */
function fillRects(ctx: CanvasRenderingContext2D, style: string, alpha: number, xs: readonly number[]): void {
  if (!xs.length) return;
  ctx.globalAlpha = alpha; ctx.fillStyle = style; ctx.beginPath();
  for (let i = 0; i < xs.length; i += 4) ctx.rect(xs[i]!, xs[i + 1]!, xs[i + 2]!, xs[i + 3]!);
  ctx.fill();
}

/** Rectangles gathered by colour and alpha, filled one group at a time (a profile zoomed out is hundreds of bars in a few colours). */
class RectBatch {
  /** By alpha, then colour: no key is built for a rectangle. */
  readonly #groups = new Map<number, Map<string, number[]>>();
  add(style: string, alpha: number, x: number, y: number, w: number, h: number): void {
    let byStyle = this.#groups.get(alpha);
    if (!byStyle) { byStyle = new Map(); this.#groups.set(alpha, byStyle); }
    let xs = byStyle.get(style);
    if (!xs) { xs = []; byStyle.set(style, xs); }
    xs.push(x, y, w, h);
  }
  flush(ctx: CanvasRenderingContext2D): void { for (const [alpha, byStyle] of this.#groups) for (const [style, xs] of byStyle) fillRects(ctx, style, alpha, xs); this.#groups.clear(); }
}

export interface TpoPaint {
  profiles: readonly TpoProfile[];
  settings: TpoSettings;
  view: View; pw: number; ph: number; p: Palette;
  labels: LabelBoard;
  /** 0 folded, 1 laid out in time, between while it moves. */
  fold: number;
  /** How old each window is among those drawn (0 the newest). */
  rank: (key: string) => number;
  name: (p: TpoProfile) => string;
  now: number;
  /** Whether the Volume profile's lines stand for a window (then the TPO draws no point-of-control line of its own for it). */
  linesFor: (key: string) => boolean;
}

export function paintTpo(ctx: CanvasRenderingContext2D, o: TpoPaint): TpoGeometry[] {
  const out: TpoGeometry[] = [];
  const { view: v, pw, ph, p, settings: s } = o, dark = p.dark, safe = p === PALETTES.colorblind || p === PALETTES.daylight;
  const safeStops = dark ? SAFE : SAFE_LIGHT;
  // The marks are amber, but on the colour-blind themes, whose ramp ends in amber, they take the text's colour.
  const timeStops = safe ? safeStops : dark ? TIME_DARK : TIME_LIGHT, countStops = safe ? safeStops : dark ? COUNT_DARK : COUNT_LIGHT, amber = safe ? p.text : dark ? AMBER_DARK : AMBER_LIGHT;
  const fold = ease(Math.max(0, Math.min(1, o.fold)));
  ctx.save(); ctx.beginPath(); ctx.rect(0, 0, pw, ph); ctx.clip();
  for (const prof of o.profiles) {
    const wx0 = v.xOf(prof.from, pw), wx1 = v.xOf(Math.min(prof.to, Math.max(o.now, prof.from + prof.blockMs)), pw);
    if (wx1 < 0 || wx0 > pw) continue;
    const rh = Math.abs(v.yOf(0, ph) - v.yOf(prof.R, ph));
    const yTop = (r: number): number => v.yOf((r + 1) * prof.R, ph);
    if (yTop(prof.drawLo - 1) < -40 || yTop(prof.drawHi) > ph + 40) continue;
    const { rows, maxCount, index: indexOf, hollow, solid } = layoutOf(prof);
    // Square blocks as tall as a row, no wider than 16 px, the longest row no wider than three fifths of the window on the chart (its
    // candles keep the rest), as the Volume profile's windows.
    // Never wider than its window either: zoomed out to months, a day of a few pixels would otherwise lie over the days after it.
    const winPx = v.xOf(prof.to, pw) - wx0, room = Math.max(Math.min(8, winPx), winPx * 0.6);
    let cw = Math.min(16, Math.max(s.look === 'letters' ? 9 : 2, rh));
    if (maxCount * cw > room) cw = room / maxCount;
    const compact = rh < 1.6 || cw < 1.6;
    const x0 = Math.max(wx0, Math.min(0, wx1 - maxCount * cw)), blockPx = v.xOf(prof.from + prof.blockMs, pw) - wx0;
    const ucw = Math.max(1, Math.min(cw, blockPx - 1));
    const unfoldX = new Map<number, number>();
    for (const b of prof.blocks) unfoldX.set(b.k, v.xOf(b.t, pw) + (blockPx - ucw) / 2);
    out.push({ profile: prof, x0, cw, ucw, rh, fold, rows, unfoldX, compact, solid });
    const fade = ageAlpha(o.rank(prof.key)), n = Math.max(1, Math.round((prof.to - prof.from) / prof.blockMs));
    const gap = cw >= 5 && rh >= 5 ? 1 : 0, cellW = fold > 0.5 ? ucw : cw, w = Math.max(1, cellW - gap), h = Math.max(1, rh - gap);
    // Letters where the cell as drawn can hold one: a row of about 11 px and a cell of about 7 (Auto), or 6 px when letters are asked for.
    const letters = s.look === 'letters' ? cellW >= 6 && rh >= 7 : s.look === 'auto' && rh >= 11 && cellW >= 7;
    const xAt = (r: number, i: number, k: number): number => x0 + i * cw + ((unfoldX.get(k) ?? 0) - x0 - i * cw) * fold;
    const backing = dark ? 'rgba(0,0,0,0.62)' : 'rgba(255,255,255,0.72)';
    const byTime = s.colour !== 'count', colours = byTime ? ramp(timeStops, n, dark) : ramp(countStops, Math.max(1, maxCount), dark);
    if (compact) paintCompact(ctx, { prof, x0, cw, ucw, rh, fold, yTop, solid, maxCount, winPx, colours, byTime, fade, backing, ph, unfoldX });
    else {
      const index = indexOf();
      // The backing first (not faded: it mutes the heat map under every block alike), then the blocks.
      ctx.globalAlpha = 1; ctx.fillStyle = backing;
      if (fold < 0.5) for (const [r, list] of rows) ctx.fillRect(x0 - 1, yTop(r), list.length * cw + 1, rh);
      else for (const b of prof.blocks) { const x = xAt(b.ra, index.get(b.k)!.get(b.ra)!, b.k); ctx.fillRect(x - 1, yTop(b.rz), w + 2, yTop(b.ra) + rh - yTop(b.rz)); }
      const swatchOf = (k: number, r: number): Swatch => byTime ? colours[Math.min(colours.length - 1, Math.max(0, k))]! : colours[Math.max(0, (rows.get(r)?.length ?? 1) - 1)]!;
      // A cell: filled, or an outline where it is hollow.
      const cell = (r: number, x: number, sw: Swatch, hollowCell: boolean): void => {
        const y = yTop(r);
        if (y > ph || y + rh < 0) return;
        if (hollowCell) { ctx.strokeStyle = sw.fill; ctx.lineWidth = 1; ctx.strokeRect(x + 0.5, y + 0.5, Math.max(1, w - 1), Math.max(1, h - 1)); }
        else ctx.fillRect(x, y, w, h);
      };
      // Three passes, one alpha each: the value area in full, the rows outside it dimmer, the point of control's row as a light stripe.
      for (const pass of [0, 1, 2] as const) {
        ctx.globalAlpha = fade * (pass === 1 ? 0.4 : 1);
        const wanted = (r: number): boolean => pass === 2 ? r === prof.poc : r !== prof.poc && (pass === 0) === (r >= prof.val && r <= prof.vah);
        if (byTime) {
          for (const b of prof.blocks) {
            const sw = swatchOf(b.k, 0), rowIndex = index.get(b.k)!;
            ctx.fillStyle = pass === 2 ? sw.stripe : sw.fill;
            for (let r = b.ra; r <= b.rz; r++) if (wanted(r)) cell(r, xAt(r, rowIndex.get(r)!, b.k), sw, b.hollow.has(r));
          }
        } else {
          for (const [r, list] of rows) {
            if (!wanted(r)) continue;
            const sw = swatchOf(0, r); ctx.fillStyle = pass === 2 ? sw.stripe : sw.fill;
            for (let i = 0; i < list.length; i++) { const k = list[i]!; cell(r, xAt(r, i, k), sw, hollow.get(k)?.has(r) ?? false); }
          }
        }
      }
      if (letters) {
        // Letters: on the colour in the ink that stands out on it; outside the value area in the page's text colour over the dim cell.
        ctx.font = `600 ${Math.max(7, Math.min(12, Math.floor(Math.min(rh * 0.78, cellW * 1.05))))}px ui-monospace, SFMono-Regular, Menlo, monospace`;
        ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        for (const b of prof.blocks) {
          const rowIndex = index.get(b.k)!, letter = letterOf(b.k);
          for (let r = b.ra; r <= b.rz; r++) {
            const y = yTop(r); if (y > ph || y + rh < 0) continue;
            const sw = swatchOf(b.k, r), poc = r === prof.poc, inVa = r >= prof.val && r <= prof.vah, hollowCell = b.hollow.has(r);
            ctx.fillStyle = hollowCell ? sw.fill : poc ? sw.stripeInk : inVa ? sw.ink : p.text;
            ctx.globalAlpha = fade * (hollowCell || poc || inVa ? 1 : 0.8);
            ctx.fillText(letter, xAt(r, rowIndex.get(r)!, b.k) + w / 2, y + h / 2 + 0.5);
          }
        }
      }
    }
    ctx.globalAlpha = 1;
    const label = (text: string, x: number, y: number, colour: string, align: CanvasTextAlign, alpha: number): void => {
      ctx.font = '600 10px ui-sans-serif, system-ui, sans-serif'; const tw = ctx.measureText(text).width + 8;
      // Kept inside the plot at the right (the window under way stands at the live edge, where a name would run off the map); a name meant
      // to stand left of something that is off the map at the left is left out rather than pushed onto the profile.
      if (align === 'right' && x - tw < 0) return;
      const bx = Math.min(pw - tw - 2, align === 'right' ? x - tw : x);
      if (!o.labels.claim({ x0: bx, x1: bx + tw, y0: y - 7, y1: y + 7 })) return;
      ctx.globalAlpha = 0.85 * alpha; ctx.fillStyle = p.panel; ctx.fillRect(bx, y - 7, tw, 14);
      ctx.globalAlpha = alpha; ctx.fillStyle = colour; ctx.textAlign = 'left'; ctx.textBaseline = 'middle'; ctx.fillText(text, bx + 4, y);
    };
    const named = Math.max(LABEL_FLOOR, fade);
    if (s.ib && !compact && prof.ibh !== null && prof.ibl !== null && fold < 0.5) {
      // The initial balance: a bracket at the left edge over the first hour's range, named at its two ends.
      const yA = yTop(prof.ibh), yB = yTop(prof.ibl) + rh, bx = x0 - 5;
      ctx.globalAlpha = fade; ctx.strokeStyle = amber; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.moveTo(bx + 3, yA); ctx.lineTo(bx, yA); ctx.lineTo(bx, yB); ctx.lineTo(bx + 3, yB); ctx.stroke();
      if (rh * (prof.ibh - prof.ibl + 1) > 30) { label(t('IBH'), bx - 3, yA + 4, amber, 'right', named); label(t('IBL'), bx - 3, yB - 4, amber, 'right', named); }
      // The open (the window's first price) and the last price: small arrows at the left edge and after the last row's cells.
      ctx.fillStyle = p.text; ctx.globalAlpha = 0.9 * fade;
      if (prof.open !== null) { const y = yTop(prof.open) + rh / 2; ctx.beginPath(); ctx.moveTo(x0 - 1, y); ctx.lineTo(x0 - 6, y - 3.5); ctx.lineTo(x0 - 6, y + 3.5); ctx.closePath(); ctx.fill(); }
      if (prof.close !== null) {
        const y = yTop(prof.close) + rh / 2, x = x0 + (rows.get(prof.close)?.length ?? 0) * cw + 2;
        ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x + 5, y - 3.5); ctx.lineTo(x + 5, y + 3.5); ctx.closePath(); ctx.fill();
      }
    }
    if (s.calls && !compact && fold < 0.5) {
      // Single prints: an amber bar after the row's cells.
      ctx.globalAlpha = 0.9 * fade; ctx.fillStyle = amber;
      for (const r of prof.singles) ctx.fillRect(x0 + (rows.get(r)?.length ?? 1) * cw + 1, yTop(r) + rh * 0.1, 2, Math.max(1, rh * 0.8));
      // The extremes' calls, with how many of the four row grids agree; an unsure one in amber.
      const call = (what: TpoProfile['top'], votes: number, top: boolean): void => {
        if (what === 'neither') return;
        const text = `${what === 'poor' ? (top ? t('Poor high') : t('Poor low')) : t('Tail')} · ${votes}/4`;
        label(text, x0, top ? yTop(prof.drawHi) - 9 : yTop(prof.drawLo) + rh + 9, votes >= 3 ? p.muted : amber, 'left', named);
      };
      call(prof.top, prof.topVotes, true); call(prof.bottom, prof.bottomVotes, false);
    }
    if (s.stats && !compact && fold < 0.5) {
      // A few numbers under the profile: the range, the initial balance, the TPOs above and below the point of control.
      const step = prof.R, y0 = yTop(prof.drawLo) + rh + (s.calls && prof.bottom !== 'neither' ? 24 : 12);
      const ib = prof.ibh !== null && prof.ibl !== null ? (prof.ibh - prof.ibl + 1) * step : null;
      const first = `${t('Range')} ${fmtPrice(prof.high - prof.low, step)}${ib !== null ? ` · ${t('IB')} ${fmtPrice(ib, step)}` : ''}`;
      const second = `${t('TPO')} ${prof.total} · ▲${prof.above} ▼${prof.below}${prof.usd > 0 ? ` · $${usd(prof.usd)}` : ''}${prof.developing ? ` · ${t('developing')}` : ''}`;
      label(first, x0, y0, p.muted, 'left', named);
      label(second, x0, y0 + 15, p.muted, 'left', named);
    }
    if (!o.linesFor(prof.key)) {
      // The point of control across the rest of its window, where the Volume profile's lines do not stand for it.
      const y = Math.round(yTop(prof.poc) + rh / 2) + 0.5, from = fold < 0.5 ? x0 + (rows.get(prof.poc)?.length ?? 0) * cw + 4 : Math.max(0, wx0), to = Math.min(pw, wx1);
      if (to > from + 10) {
        ctx.globalAlpha = 0.85 * fade; ctx.strokeStyle = p.poc; ctx.lineWidth = 1.5; ctx.setLineDash([]);
        ctx.beginPath(); ctx.moveTo(from, y); ctx.lineTo(to, y); ctx.stroke();
        if (to - from > 90) { const name = o.name(prof); label(`${name ? `${name} ` : ''}${t('TPO')} ${t('POC')} ${fmtPrice((prof.poc + 0.5) * prof.R, prof.R)}`, to - 2, y, p.poc, 'right', named); }
      }
    }
    ctx.globalAlpha = 1;
  }
  ctx.restore();
  ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
  return out;
}

/** The block under the pointer, on the pointer's own layer: its cells framed wherever they stand, and its time lit across the map. */
export function paintLit(ctx: CanvasRenderingContext2D, geo: TpoGeometry, k: number, v: View, pw: number, ph: number, p: Palette): void {
  const prof = geo.profile, b = prof.blocks.find(x => x.k === k);
  if (!b) return;
  ctx.save();
  ctx.beginPath(); ctx.rect(0, 0, pw, ph); ctx.clip();
  const a = v.xOf(b.t, pw), z = v.xOf(b.t + prof.blockMs, pw);
  ctx.globalAlpha = 0.08; ctx.fillStyle = p.text; ctx.fillRect(a, 0, Math.max(1, z - a), ph);
  const gap = geo.cw >= 5 && geo.rh >= 5 ? 1 : 0, w = Math.max(1, (geo.fold > 0.5 ? geo.ucw : geo.cw) - gap), h = Math.max(1, geo.rh - gap);
  ctx.globalAlpha = 1; ctx.strokeStyle = p.text; ctx.lineWidth = 1;
  for (let r = b.ra; r <= b.rz; r++) {
    const list = geo.rows.get(r), i = list?.indexOf(k) ?? -1;
    if (i < 0) continue;
    const x = geo.x0 + i * geo.cw + ((geo.unfoldX.get(k) ?? 0) - geo.x0 - i * geo.cw) * geo.fold, y = v.yOf((r + 1) * prof.R, ph);
    ctx.strokeRect(x - 0.5, y - 0.5, w + 1, h + 1);
  }
  ctx.restore();
}

/** The block and row under (x, y) on the profiles drawn last, the newest drawn first. */
export function cellAt(geos: readonly TpoGeometry[], x: number, y: number, view: View, ph: number): { geo: TpoGeometry; k: number; r: number } | null {
  for (let g = geos.length - 1; g >= 0; g--) {
    const geo = geos[g]!, prof = geo.profile, price = view.pOf(y, ph), r = Math.floor(price / prof.R * (1 + 1e-12)), list = geo.rows.get(r);
    if (!list) continue;
    if (geo.compact && geo.fold < 0.5) { const n = geo.solid.get(r)?.n ?? 0; if (n && x >= geo.x0 && x <= geo.x0 + Math.max(1, n * geo.cw)) return { geo, k: list[0]!, r }; continue; }
    for (let i = 0; i < list.length; i++) {
      const k = list[i]!, cx = geo.x0 + i * geo.cw + ((geo.unfoldX.get(k) ?? 0) - geo.x0 - i * geo.cw) * geo.fold, w = geo.fold > 0.5 ? geo.ucw : geo.cw;
      if (x >= cx - 1 && x <= cx + w + 1) return { geo, k, r };
    }
  }
  return null;
}
