import type { View } from '../view.ts';
import type { Palette } from '../theme.ts';
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
 * laid out in time (`fold` 1), each block stands in its own column at its half hour, behind its own candles. By zoom: letters while a block
 * is tall enough, blocks, then the profile's outline alone. A block this market's wick alone reached (tpo/model.ts `hollowRows`) is drawn
 * as an outline.
 */

/** Where one profile's cells were drawn, for the pointer (`cellAt`). */
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
const TIME_LIGHT = ['#d62f2f', '#dd5e0b', '#c98a00', '#4e8f0f', '#0b9a6f', '#0f8ea3', '#1f6fd1', '#6a45e0'];
/** How full a row is: thin to full, cool to hot. */
const COUNT_DARK = ['#4f6bff', '#2fb7d6', '#3ddc97', '#ffd166', '#ff9f43', '#ff5c5c'];
const COUNT_LIGHT = ['#3550d8', '#0f8ea3', '#0b9a6f', '#c98a00', '#dd5e0b', '#d62f2f'];
/** The initial balance's and the single prints' marks: amber, as the other marks of what stands out. */
const AMBER_DARK = '#f2b84b', AMBER_LIGHT = '#b26a00';

function hex(c: string): [number, number, number] { const n = parseInt(c.slice(1), 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255]; }
function ramp(stops: readonly string[], f: number): string {
  const x = Math.max(0, Math.min(1, f)) * (stops.length - 1), i = Math.min(stops.length - 2, Math.floor(x)), u = x - i;
  const a = hex(stops[i]!), b = hex(stops[i + 1]!);
  return `rgb(${Math.round(a[0] + (b[0] - a[0]) * u)},${Math.round(a[1] + (b[1] - a[1]) * u)},${Math.round(a[2] + (b[2] - a[2]) * u)})`;
}
/** `c` (rgb() or #hex) moved `f` of the way toward `to` (#hex). */
function mix(c: string, to: string, f: number): string {
  const a = c.startsWith('#') ? hex(c) : (c.match(/\d+/g) ?? ['0', '0', '0']).slice(0, 3).map(Number) as [number, number, number], b = hex(to);
  return `rgb(${Math.round(a[0] + (b[0] - a[0]) * f)},${Math.round(a[1] + (b[1] - a[1]) * f)},${Math.round(a[2] + (b[2] - a[2]) * f)})`;
}
const ease = (u: number): number => u < 0.5 ? 4 * u * u * u : 1 - (-2 * u + 2) ** 3 / 2;

export interface TpoPaint {
  profiles: readonly TpoProfile[];
  settings: TpoSettings;
  view: View; pw: number; ph: number; p: Palette;
  labels: LabelBoard;
  /** 0 folded, 1 laid out in time, between while it moves. */
  fold: number;
  /** The block under the pointer: its window and index (its cells and its half hour are lit). */
  lit: { key: string; k: number } | null;
  /** How old each window is among those drawn (0 the newest). */
  rank: (key: string) => number;
  name: (p: TpoProfile) => string;
  now: number;
  /** Whether the Volume profile's lines are drawn for these windows (then the TPO draws none of its own: they follow it). */
  linesElsewhere: boolean;
}

export function paintTpo(ctx: CanvasRenderingContext2D, o: TpoPaint): TpoGeometry[] {
  const out: TpoGeometry[] = [];
  const { view: v, pw, ph, p, settings: s } = o, dark = p.dark, timeStops = dark ? TIME_DARK : TIME_LIGHT, countStops = dark ? COUNT_DARK : COUNT_LIGHT, amber = dark ? AMBER_DARK : AMBER_LIGHT;
  const fold = ease(Math.max(0, Math.min(1, o.fold)));
  ctx.save(); ctx.beginPath(); ctx.rect(0, 0, pw, ph); ctx.clip();
  for (const prof of o.profiles) {
    const wx0 = v.xOf(prof.from, pw), wx1 = v.xOf(Math.min(prof.to, Math.max(o.now, prof.from + prof.blockMs)), pw);
    if (wx1 < 0 || wx0 > pw) continue;
    const rh = Math.abs(v.yOf(0, ph) - v.yOf(prof.R, ph));
    const yTop = (r: number): number => v.yOf((r + 1) * prof.R, ph);
    if (yTop(prof.lo - 1) < -40 || yTop(prof.hi) > ph + 40) continue;
    const rows = new Map<number, number[]>();
    for (const b of prof.blocks) for (let r = b.a; r <= b.z; r++) { const list = rows.get(r); if (list) list.push(b.k); else rows.set(r, [b.k]); }
    let maxCount = 0; for (const list of rows.values()) maxCount = Math.max(maxCount, list.length);
    // Square blocks as tall as a row, no wider than 16 px, the longest row no wider than three fifths of the window on the chart (its
    // candles keep the rest), as the Volume profile's windows.
    const room = Math.max(8, (v.xOf(prof.to, pw) - wx0) * 0.6), letters = s.look === 'letters' || (s.look === 'auto' && rh >= 11);
    let cw = Math.min(16, Math.max(letters ? 9 : 2, rh));
    if (maxCount * cw > room) cw = room / maxCount;
    const outline = rh < 1.6 || cw < 1.6;
    const x0 = Math.max(wx0, Math.min(0, wx1 - maxCount * cw)), blockPx = v.xOf(prof.from + prof.blockMs, pw) - wx0;
    const ucw = Math.max(1, Math.min(cw, blockPx - 1));
    const unfoldX = new Map<number, number>();
    for (const b of prof.blocks) unfoldX.set(b.k, v.xOf(b.t, pw) + (blockPx - ucw) / 2);
    const geo: TpoGeometry = { profile: prof, x0, cw, ucw, rh, fold, rows, unfoldX, outline };
    out.push(geo);
    const fade = ageAlpha(o.rank(prof.key)), n = Math.max(1, Math.round((prof.to - prof.from) / prof.blockMs) - 1);
    const gap = cw >= 5 && rh >= 5 ? 1 : 0, w = (fold > 0.5 ? ucw : cw) - gap, h = Math.max(1, rh - gap);
    const colourOf = (k: number, r: number): string => s.colour === 'count' ? ramp(countStops, ((rows.get(r)?.length ?? 1) - 1) / Math.max(1, maxCount - 1)) : ramp(timeStops, k / n);
    const hollowAt = new Map<number, ReadonlySet<number>>(prof.blocks.map(b => [b.k, b.hollow]));
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
      ctx.fillStyle = backing;
      if (fold < 0.5) for (const [r, list] of rows) ctx.fillRect(x0 - 1, yTop(r), list.length * cw + 1, rh);
      else for (const [r, list] of rows) for (let i = 0; i < list.length; i++) ctx.fillRect(xAt(r, i, list[i]!) - 1, yTop(r), w + 2, rh);
      const font = letters ? `600 ${Math.max(7, Math.min(12, Math.floor(Math.min(rh * 0.78, cw * 1.05))))}px ui-monospace, SFMono-Regular, Menlo, monospace` : '';
      if (letters) { ctx.font = font; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; }
      for (const [r, list] of rows) {
        const y = yTop(r), inVa = r >= prof.val && r <= prof.vah, poc = r === prof.poc;
        if (y > ph || y + rh < 0) continue;
        for (let i = 0; i < list.length; i++) {
          // The point of control's row as a light stripe across the profile (the reference's white row), its letters still in their colours' order.
          const k = list[i]!, x = xAt(r, i, k), colour = poc ? mix(colourOf(k, r), dark ? '#ffffff' : '#1b1d21', 0.72) : colourOf(k, r), hollow = hollowAt.get(k)?.has(r) ?? false;
          const alpha = fade * (inVa || poc ? 1 : 0.4);
          ctx.globalAlpha = alpha;
          if (hollow) { ctx.strokeStyle = colour; ctx.lineWidth = 1; ctx.strokeRect(x + 0.5, y + 0.5, Math.max(1, w - 1), Math.max(1, h - 1)); }
          else { ctx.fillStyle = colour; ctx.fillRect(x, y, w, h); }
          if (letters) {
            ctx.fillStyle = hollow ? colour : poc ? (dark ? '#101216' : '#ffffff') : dark ? '#101216' : '#ffffff';
            ctx.globalAlpha = alpha * (hollow ? 1 : 0.9);
            ctx.fillText(letterOf(k), x + w / 2, y + h / 2 + 0.5);
          }
        }
      }
      // The block under the pointer: its cells framed, wherever they stand.
      if (o.lit?.key === prof.key) {
        ctx.globalAlpha = 1; ctx.strokeStyle = p.text; ctx.lineWidth = 1;
        for (const [r, list] of rows) { const i = list.indexOf(o.lit.k); if (i >= 0) ctx.strokeRect(xAt(r, i, o.lit.k) - 0.5, yTop(r) - 0.5, w + 1, h + 1); }
      }
    }
    ctx.globalAlpha = 1;
    const label = (text: string, x: number, y: number, colour: string, align: CanvasTextAlign, alpha: number): void => {
      ctx.font = '600 10px ui-sans-serif, system-ui, sans-serif'; const tw = ctx.measureText(text).width + 8;
      const bx = align === 'right' ? x - tw : x;
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
        const text = `${what === 'poor' ? (top ? t('Poor high') : t('Poor low')) : top ? t('Tail') : t('Tail')} · ${votes}/4`;
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
    if (!o.linesElsewhere && !outline) {
      // The point of control across the rest of its window (the Volume profile's lines follow the TPO when they are drawn instead).
      const y = Math.round(yTop(prof.poc) + rh / 2) + 0.5, from = x0 + (rows.get(prof.poc)?.length ?? 0) * cw + 4, to = Math.min(pw, wx1);
      if (to > from + 10) {
        ctx.globalAlpha = 0.85 * fade; ctx.strokeStyle = p.poc; ctx.lineWidth = 1.5; ctx.setLineDash([]);
        ctx.beginPath(); ctx.moveTo(from, y); ctx.lineTo(to, y); ctx.stroke();
        if (to - from > 90) label(`${o.name(prof)} ${t('POC')} ${fmtPrice((prof.poc + 0.5) * prof.R, prof.R)}`, to - 2, y, p.poc, 'right', named);
      }
    }
    ctx.globalAlpha = 1;
  }
  // The half hour under the pointer, across the map: when it happened.
  if (o.lit) {
    const prof = o.profiles.find(x => x.key === o.lit!.key), b = prof?.blocks.find(x => x.k === o.lit!.k);
    if (prof && b) {
      const a = v.xOf(b.t, pw), z = v.xOf(b.t + prof.blockMs, pw);
      ctx.globalAlpha = 0.08; ctx.fillStyle = p.text; ctx.fillRect(a, 0, Math.max(1, z - a), ph); ctx.globalAlpha = 1;
    }
  }
  ctx.restore();
  ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
  return out;
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
