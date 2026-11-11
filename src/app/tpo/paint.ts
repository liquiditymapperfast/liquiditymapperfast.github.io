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
 * big enough to hold one, blocks, then the profile's outline alone. A block this market's wick alone reached (tpo/model.ts `hollowRows`) is
 * drawn as an outline. A block's cells share one colour, so they are filled a block at a time (by time) or a row at a time (by row length).
 */

/** Where one profile's cells were drawn, for the pointer (`cellAt`) and the lit block (`paintLit`). */
export interface TpoGeometry {
  profile: TpoProfile;
  x0: number; cw: number; ucw: number; rh: number; fold: number;
  /** Per row, the blocks in it, oldest first (a folded row's cells in that order from `x0`). */
  rows: Map<number, number[]>;
  /** Block index to its unfolded x (the cell's left). */
  unfoldX: Map<number, number>;
  outline: boolean;
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

/** A profile's rows, each block's index in them and its hollow rows, kept per profile (they do not change while it is drawn). */
interface Layout { rows: Map<number, number[]>; maxCount: number; index: Map<number, Map<number, number>>; hollow: Map<number, ReadonlySet<number>> }
const layouts = new WeakMap<TpoProfile, Layout>();
function layoutOf(p: TpoProfile): Layout {
  let out = layouts.get(p);
  if (!out) {
    const rows = new Map<number, number[]>();
    for (const b of p.blocks) for (let r = b.a; r <= b.z; r++) { const list = rows.get(r); if (list) list.push(b.k); else rows.set(r, [b.k]); }
    let maxCount = 0; const index = new Map<number, Map<number, number>>();
    for (const [r, list] of rows) { maxCount = Math.max(maxCount, list.length); list.forEach((k, i) => { let m = index.get(k); if (!m) { m = new Map(); index.set(k, m); } m.set(r, i); }); }
    out = { rows, maxCount, index, hollow: new Map(p.blocks.map(b => [b.k, b.hollow])) };
    layouts.set(p, out);
  }
  return out;
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
    if (yTop(prof.lo - 1) < -40 || yTop(prof.hi) > ph + 40) continue;
    const { rows, maxCount, index, hollow } = layoutOf(prof);
    // Square blocks as tall as a row, no wider than 16 px, the longest row no wider than three fifths of the window on the chart (its
    // candles keep the rest), as the Volume profile's windows.
    const room = Math.max(8, (v.xOf(prof.to, pw) - wx0) * 0.6);
    let cw = Math.min(16, Math.max(s.look === 'letters' ? 9 : 2, rh));
    if (maxCount * cw > room) cw = room / maxCount;
    const outline = rh < 1.6 || cw < 1.6;
    const x0 = Math.max(wx0, Math.min(0, wx1 - maxCount * cw)), blockPx = v.xOf(prof.from + prof.blockMs, pw) - wx0;
    const ucw = Math.max(1, Math.min(cw, blockPx - 1));
    const unfoldX = new Map<number, number>();
    for (const b of prof.blocks) unfoldX.set(b.k, v.xOf(b.t, pw) + (blockPx - ucw) / 2);
    out.push({ profile: prof, x0, cw, ucw, rh, fold, rows, unfoldX, outline });
    const fade = ageAlpha(o.rank(prof.key)), n = Math.max(1, Math.round((prof.to - prof.from) / prof.blockMs));
    const gap = cw >= 5 && rh >= 5 ? 1 : 0, cellW = fold > 0.5 ? ucw : cw, w = Math.max(1, cellW - gap), h = Math.max(1, rh - gap);
    // Letters where the cell as drawn can hold one: a row of about 11 px and a cell of about 7 (Auto), or 6 px when letters are asked for.
    const letters = s.look === 'letters' ? cellW >= 6 && rh >= 7 : s.look === 'auto' && rh >= 11 && cellW >= 7;
    const xAt = (r: number, i: number, k: number): number => x0 + i * cw + ((unfoldX.get(k) ?? 0) - x0 - i * cw) * fold;
    const backing = dark ? 'rgba(0,0,0,0.62)' : 'rgba(255,255,255,0.72)';
    if (outline) {
      // Too fine for blocks: the profile's outline, its value area filled lightly, in the profile colour.
      ctx.globalAlpha = fade; ctx.strokeStyle = p.poc; ctx.lineWidth = 1; ctx.beginPath();
      let first = true;
      for (let r = prof.hi; r >= prof.lo; r--) { const len = (rows.get(r)?.length ?? 0) * cw, y = yTop(r); if (first) { ctx.moveTo(x0, y); first = false; } ctx.lineTo(x0 + len, y); ctx.lineTo(x0 + len, y + rh); }
      ctx.lineTo(x0, yTop(prof.lo) + rh); ctx.stroke();
      ctx.globalAlpha = 0.18 * fade; ctx.fillStyle = p.poc;
      for (let r = prof.val; r <= prof.vah; r++) ctx.fillRect(x0, yTop(r), (rows.get(r)?.length ?? 0) * cw, Math.max(1, rh));
      ctx.globalAlpha = 1;
    } else {
      // The backing first (not faded: it mutes the heat map under every block alike), then the blocks.
      ctx.globalAlpha = 1; ctx.fillStyle = backing;
      if (fold < 0.5) for (const [r, list] of rows) ctx.fillRect(x0 - 1, yTop(r), list.length * cw + 1, rh);
      else for (const b of prof.blocks) { const x = xAt(b.a, index.get(b.k)!.get(b.a)!, b.k); ctx.fillRect(x - 1, yTop(b.z), w + 2, yTop(b.a) + rh - yTop(b.z)); }
      const byTime = s.colour !== 'count', colours = byTime ? ramp(timeStops, n, dark) : ramp(countStops, Math.max(1, maxCount), dark);
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
            for (let r = b.a; r <= b.z; r++) if (wanted(r)) cell(r, xAt(r, rowIndex.get(r)!, b.k), sw, b.hollow.has(r));
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
          for (let r = b.a; r <= b.z; r++) {
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
    if (s.ib && !outline && prof.ibh !== null && prof.ibl !== null && fold < 0.5) {
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
    if (s.calls && !outline && fold < 0.5) {
      // Single prints: an amber bar after the row's cells.
      ctx.globalAlpha = 0.9 * fade; ctx.fillStyle = amber;
      for (const r of prof.singles) ctx.fillRect(x0 + (rows.get(r)?.length ?? 1) * cw + 1, yTop(r) + rh * 0.1, 2, Math.max(1, rh * 0.8));
      // The extremes' calls, with how many of the four row grids agree; an unsure one in amber.
      const call = (what: TpoProfile['top'], votes: number, top: boolean): void => {
        if (what === 'neither') return;
        const text = `${what === 'poor' ? (top ? t('Poor high') : t('Poor low')) : t('Tail')} · ${votes}/4`;
        label(text, x0, top ? yTop(prof.hi) - 9 : yTop(prof.lo) + rh + 9, votes >= 3 ? p.muted : amber, 'left', named);
      };
      call(prof.top, prof.topVotes, true); call(prof.bottom, prof.bottomVotes, false);
    }
    if (s.stats && !outline && fold < 0.5) {
      // A few numbers under the profile: the range, the initial balance, the TPOs above and below the point of control.
      const step = prof.R, y0 = yTop(prof.lo) + rh + (s.calls && prof.bottom !== 'neither' ? 24 : 12);
      const ib = prof.ibh !== null && prof.ibl !== null ? (prof.ibh - prof.ibl + 1) * step : null;
      const first = `${t('Range')} ${fmtPrice(prof.high - prof.low, step)}${ib !== null ? ` · ${t('IB')} ${fmtPrice(ib, step)}` : ''}`;
      const second = `${t('TPO')} ${prof.total} · ▲${prof.above} ▼${prof.below}${prof.usd > 0 ? ` · $${usd(prof.usd)}` : ''}${prof.developing ? ` · ${t('developing')}` : ''}`;
      label(first, x0, y0, p.muted, 'left', named);
      label(second, x0, y0 + 15, p.muted, 'left', named);
    }
    if (!o.linesFor(prof.key) && !outline) {
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
  for (let r = b.a; r <= b.z; r++) {
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
    if (geo.outline) { if (x >= geo.x0 && x <= geo.x0 + list.length * geo.cw) return { geo, k: list[0]!, r }; continue; }
    for (let i = 0; i < list.length; i++) {
      const k = list[i]!, cx = geo.x0 + i * geo.cw + ((geo.unfoldX.get(k) ?? 0) - geo.x0 - i * geo.cw) * geo.fold, w = geo.fold > 0.5 ? geo.ucw : geo.cw;
      if (x >= cx - 1 && x <= cx + w + 1) return { geo, k, r };
    }
  }
  return null;
}
