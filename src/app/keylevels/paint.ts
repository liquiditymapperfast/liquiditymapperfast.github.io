import { language, t } from '../i18n.ts';
import { price as fmtPrice } from '../format.ts';
import type { Palette } from '../theme.ts';
import type { View } from '../view.ts';
import { lineEnd, type KeyLine, type LevelWhat, type PeriodKind } from './levels.ts';
import { placeTags, type Band, type TagWish } from './tags.ts';
import type { KeyLevelSettings } from './settings.ts';

/** Each line's short name as traders write it: PDH is the previous day's high, DO the day's open, DH its high so far; W for a week, M for a month. */
const CODES: Readonly<Record<PeriodKind, { prev: Readonly<Record<'high' | 'low' | 'mid', string>>; open: string; sofar: Readonly<Record<'high' | 'low', string>> }>> = {
  day: { prev: { high: t('PDH'), low: t('PDL'), mid: t('PDM') }, open: t('DO'), sofar: { high: t('DH'), low: t('DL') } },
  week: { prev: { high: t('PWH'), low: t('PWL'), mid: t('PWM') }, open: t('WO'), sofar: { high: t('WH'), low: t('WL') } },
  month: { prev: { high: t('PMH'), low: t('PML'), mid: t('PMM') }, open: t('MO'), sofar: { high: t('MH'), low: t('ML') } },
};

export function codeOf(line: Pick<KeyLine, 'period' | 'what' | 'prev'>): string {
  const c = CODES[line.period];
  if (line.what === 'open') return c.open;
  if (line.prev) return c.prev[line.what];
  return line.what === 'mid' ? c.prev.mid : c.sofar[line.what];
}

/** The period's dash: a day solid, a week dashed, a month dash-dot. An untouched level running on past its period is dotted. */
const DASH: Readonly<Record<PeriodKind, number[]>> = { day: [], week: [8, 4], month: [14, 4, 3, 4] };
const RUN_ON = [2, 3];
/** Which tag and label wins a tie for room: the month's over the week's over the day's, and a previous high or low over an open, a middle or a range so far. */
const PERIOD_RANK: Readonly<Record<PeriodKind, number>> = { month: 0, week: 1, day: 2 };
const WHAT_RANK = (what: LevelWhat, prev: boolean): number => prev ? (what === 'mid' ? 2 : 0) : what === 'open' ? 1 : 3;
export const rankOf = (line: Pick<KeyLine, 'period' | 'what' | 'prev'>): number => PERIOD_RANK[line.period] * 4 + WHAT_RANK(line.what, line.prev);

/** A tag on the price axis; `older` for a level of an earlier period still running on (outlined, after the current ones). */
export interface KeyTag extends TagWish { text: string; older: boolean }
export const TAG_H = 14;
/** How far down the order a level of an earlier period still running on goes: after every line of the periods under way and just ended. */
const OLDER_RANK = 20;

const dateFormats = new Map<string, Intl.DateTimeFormat>();
/** The day a period began, in its zone ("Oct 7"; a month as "Sep 2026"), to name a level that runs on past the period after it. */
export function periodDate(t: number, period: PeriodKind, zone: string): string {
  const key = `${language()}|${zone}|${period}`;
  let f = dateFormats.get(key);
  if (!f) { try { f = new Intl.DateTimeFormat(language(), period === 'month' ? { month: 'short', year: 'numeric', timeZone: zone } : { month: 'short', day: 'numeric', timeZone: zone }); } catch { f = new Intl.DateTimeFormat(language(), { month: 'short', day: 'numeric', timeZone: 'UTC' }); } dateFormats.set(key, f); }
  return f.format(new Date(t));
}

/**
 * Draw the lines in the palette's level colour over a halo, each across the period it belongs to, an untouched one running on dotted, with its
 * name and price at its right end where there is room (the more important first; one that would cover another is left out). A level of an
 * earlier period still running on (its period ended before `now`) says which period it is, and gives way to the current ones. Returns the
 * tags wanted on the price axis: one for each line that reaches the right edge.
 */
export function paintKeyLevels(ctx: CanvasRenderingContext2D, lines: readonly KeyLine[], v: View, pw: number, ph: number, p: Palette, s: KeyLevelSettings, now: number, zone: string): KeyTag[] {
  const tags: KeyTag[] = [], labels: { text: string; x: number; y: number; rank: number; alpha: number }[] = [];
  if (!lines.length) return tags;
  const halo = p.dark ? 'rgba(0,0,0,0.55)' : 'rgba(255,255,255,0.75)';
  const stroke = (x0: number, x1: number, y: number, dash: number[], width: number): void => {
    if (x1 <= x0) return;
    ctx.setLineDash(dash);
    ctx.strokeStyle = halo; ctx.lineWidth = width + 2; ctx.beginPath(); ctx.moveTo(x0, y); ctx.lineTo(x1, y); ctx.stroke();
    ctx.strokeStyle = p.level; ctx.lineWidth = width; ctx.beginPath(); ctx.moveTo(x0, y); ctx.lineTo(x1, y); ctx.stroke();
  };
  ctx.save(); ctx.beginPath(); ctx.rect(0, 0, pw, ph); ctx.clip();
  for (const l of lines) {
    const y = Math.round(v.yOf(l.price, ph)) + 0.5; if (y < -2 || y > ph + 2) continue;
    const x0 = Math.max(-4, v.xOf(l.from, pw)), x1 = Math.min(pw + 4, v.xOf(l.to, pw));
    const end = lineEnd(l), right = l.reached === undefined ? x1 : end === Infinity ? pw + 4 : Math.min(pw + 4, v.xOf(end, pw));
    if (Math.max(x1, right) < 0 || x0 > pw) continue;
    const width = (l.what === 'high' || l.what === 'low') && l.prev ? 1.5 : 1;
    ctx.globalAlpha = l.prev ? (l.what === 'mid' ? 0.75 : 1) : l.what === 'open' ? 0.9 : 0.65;
    stroke(x0, x1, y, DASH[l.period], width);
    if (right > x1) stroke(Math.max(-4, x1), right, y, RUN_ON, width);
    const older = l.reached !== undefined && l.to <= now, code = codeOf(l), rank = rankOf(l) + (older ? OLDER_RANK : 0);
    const text = older ? `${code} ${fmtPrice(l.price)} · ${periodDate(l.of, l.period, zone)}` : `${code} ${fmtPrice(l.price)}`;
    if (s.labels && right - Math.max(0, x0) > 60) labels.push({ text, x: Math.min(pw - 2, right - 2), y, rank, alpha: ctx.globalAlpha });
    if (s.tags && right >= pw - 1) tags.push({ key: `${code}|${l.window}`, y, rank, text: code, older });
  }
  ctx.setLineDash([]);
  ctx.font = '600 10px ui-sans-serif, system-ui, sans-serif'; ctx.textAlign = 'right'; ctx.textBaseline = 'middle';
  const boxes: { x0: number; x1: number; y0: number; y1: number }[] = [];
  for (const l of labels.sort((a, b) => a.rank - b.rank)) {
    const w = ctx.measureText(l.text).width + 8, box = { x0: l.x - w, x1: l.x, y0: l.y - 7, y1: l.y + 7 };
    if (l.y < 7 || l.y > ph - 7 || boxes.some(b => b.x0 < box.x1 && box.x0 < b.x1 && b.y0 < box.y1 && box.y0 < b.y1)) continue;
    boxes.push(box);
    ctx.globalAlpha = l.alpha * 0.85; ctx.fillStyle = p.panel; ctx.fillRect(box.x0, box.y0, w, 14);
    ctx.globalAlpha = l.alpha; ctx.fillStyle = p.level; ctx.fillText(l.text, l.x - 4, l.y);
  }
  ctx.restore(); ctx.globalAlpha = 1;
  return tags;
}

/** The tags kept on the price axis: clear of each other and of `blocked` (the live price's tag), each at its own price. */
export const placeKeyTags = (tags: readonly KeyTag[], blocked: readonly Band[], ph: number): KeyTag[] => tags.length ? placeTags(tags, blocked, TAG_H, ph) : [];

/** Whether a price label on the axis at `y` would sit under one of the tags (it is then left out, so no half-covered number shows). */
export const underTag = (tags: readonly KeyTag[], y: number): boolean => tags.some(k => Math.abs(k.y - y) < TAG_H / 2 + 6);

/** Draw the tags `placeKeyTags` kept, in the level colour (outlined for a level of an earlier period). */
export function paintKeyTags(ctx: CanvasRenderingContext2D, tags: readonly KeyTag[], axisX: number, axisW: number, p: Palette): void {
  if (!tags.length) return;
  ctx.save();
  ctx.font = '600 10px ui-sans-serif, system-ui, sans-serif'; ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
  for (const tag of tags) {
    const y = Math.round(tag.y);
    if (tag.older) { // outlined: a level of an earlier period still running on
      ctx.fillStyle = p.panel; ctx.fillRect(axisX + 1, y - TAG_H / 2, axisW - 1, TAG_H);
      ctx.strokeStyle = p.level; ctx.lineWidth = 1; ctx.strokeRect(axisX + 1.5, y - TAG_H / 2 + 0.5, axisW - 2, TAG_H - 1);
      ctx.fillStyle = p.level;
    } else { ctx.fillStyle = p.level; ctx.fillRect(axisX + 1, y - TAG_H / 2, axisW - 1, TAG_H); ctx.fillStyle = p.bg; }
    ctx.fillText(tag.text, axisX + 6, y + 0.5);
  }
  ctx.restore();
}
