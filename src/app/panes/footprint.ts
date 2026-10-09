import { TIMEFRAMES } from '../hub.ts';
import type { Palette } from '../theme.ts';
import type { Bounds } from '../view.ts';
import { View } from '../view.ts';
import type { CandleRow } from '../store.ts';
import type { FootprintResponse } from '../source.ts';
import type { InfoLine } from '../infobox.ts';
import { price as fmtPrice, clock } from '../format.ts';
import { t } from '../i18n.ts';
import type { BarMarks } from '../footprint/marks.ts';
import type { FootprintSettings } from '../footprint/settings.ts';

type Row = [number, number, number];
/** Trade counts and USD by size bucket (see SIZE_BUCKET_LABELS); only present for bars whose executions were recorded with stats. */
export interface TradeStats { buyN: number; sellN: number; buy: number[]; sell: number[] }
export interface Bar {
  t: number; rows: Row[]; buyUsd: number; sellUsd: number;
  /** Recorded minutes inside the bar; a candle seen only in part has fewer than its length. Absent from servers that predate it. */
  minutes?: number;
  stats?: TradeStats;
}

/** Trade stats from the wire: eight finite non-negative size buckets per side and integer counts, else none (the bar then has no trade statistics). */
export function validStats(value: unknown): TradeStats | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const { buyN, sellN, buy, sell } = value as Partial<Record<keyof TradeStats, unknown>>;
  const bucket = (v: unknown): v is number[] => Array.isArray(v) && v.length === 8 && v.every(x => typeof x === 'number' && Number.isFinite(x) && x >= 0);
  const count = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v >= 0;
  return count(buyN) && count(sellN) && bucket(buy) && bucket(sell) ? { buyN, sellN, buy, sell } : undefined;
}

/** A bar from the server with its optional trade stats checked. */
export function readBar(bar: Bar): Bar {
  const { stats, ...rest } = bar, valid = validStats(stats);
  return valid ? { ...rest, stats: valid } : rest;
}

/**
 * Zoom policy (all CSS px of one candle slot): the footprint appears once a slot is wide enough, fades in over 500 ms
 * (ease-out quint), prints the sell / buy numbers from 120 px wide and 14 px rows, regroups rows dyadically to stay
 * 12-16 px tall, slides the candle to the left of the slot and dims the heatmap by up to 80 %.
 */
export const FOOTPRINT_POLICY = Object.freeze({
  baseColumnWidth: 24, overscan: 40, barEnter: 14, barLeave: 10, zeroBar: 12,
  sellBuyEnterWidth: 120, sellBuyLeaveWidth: 108, sellBuyEnterHeight: 14, sellBuyLeaveHeight: 12,
  textEnterFactor: 0.56, textLeaveFactor: 0.44, fadeMs: 500, coarsenHeight: 12, refineHeight: 16, maxLevel: 24,
});

/** A row gets a bar only when one side is at least this many times the other (or the other side is empty). */
export const IMBALANCE_RATIO = 1.15;

const clamp01 = (v: number) => Math.max(0, Math.min(1, v));
export const easeOutQuint = (t: number) => 1 - (1 - clamp01(t)) ** 5;

interface Tween { from: number; target: number; start: number }
const sample = (tw: Tween, now: number) => tw.from === tw.target ? tw.target : tw.from + (tw.target - tw.from) * easeOutQuint((now - tw.start) / FOOTPRINT_POLICY.fadeMs);
const retarget = (tw: Tween, target: number, now: number): Tween => target === tw.target ? tw : { from: sample(tw, now), target, start: now };

/** How much footprint to show given how many candles are on screen and how wide they are. */
export function visibilityFactor(candles: readonly CandleRow[], tfMs: number, view: Bounds, pw: number, ph: number, rowHeight: number, grouping: number): number {
  const width = pw * tfMs / (view.t1 - view.t0);
  const gain = clamp01((width / FOOTPRINT_POLICY.baseColumnWidth - 0.5) / 3);
  if (gain === 0) return 0;
  const strong = gain > 0.6;
  const first = Math.floor(view.t0 / tfMs), last = Math.floor(view.t1 / tfMs);
  const overIdx = FOOTPRINT_POLICY.overscan / width, pxPerPrice = ph / (view.p1 - view.p0), overPrice = FOOTPRINT_POLICY.overscan / pxPerPrice;
  const oFirst = first - overIdx, oLast = last + overIdx, oLow = view.p0 - overPrice, oHigh = view.p1 + overPrice;
  let full = 0, partial = 0, fringe = 0, significant = 0, maxCoverage = 0;
  for (const c of candles) {
    const index = Math.floor(c[0] / tfMs);
    if (index < oFirst || index > oLast) continue;
    const high = c[2], low = c[3], open = c[1], close = c[4];
    const top = high || close || open, bottom = low || open || close;
    if (!(top >= bottom) || top === 0 || bottom > oHigh || top < oLow) continue;
    const insideTime = index >= first && index <= last, insidePrice = !(bottom > view.p1 || top < view.p0);
    let coverage = 1;
    if (top > oHigh && bottom < oLow) coverage = 1; else if (top > oHigh) coverage = (oHigh - bottom) / (top - bottom); else if (bottom < oLow) coverage = (top - oLow) / (top - bottom);
    let attenuation = 1;
    if (!insideTime) { const before = index < first ? first - index : 0, after = index > last ? index - last : 0; attenuation = Math.max(0, 1 - Math.min(before, after) / (FOOTPRINT_POLICY.overscan / width)); }
    if (!insidePrice) { const d = bottom > view.p1 ? (bottom - view.p1) / grouping : (view.p0 - top) / grouping; attenuation = Math.min(attenuation, Math.max(0, 1 - d / (FOOTPRINT_POLICY.overscan / rowHeight))); }
    coverage *= attenuation; maxCoverage = Math.max(maxCoverage, coverage);
    const floor = strong ? 0.0001 : 0.001, volume = Number.isFinite(c[5]) ? c[5] : 0;
    const isSignificant = volume > (strong ? 0.1 : 5) || (high > 0 && low > 0 && (high - low) / low > floor) || (open > 0 && close > 0 && Math.abs(close - open) / open > floor / 2);
    if (coverage > 0.7 && insideTime && insidePrice) { full++; if (isSignificant) significant++; } else if (coverage > 0.2) { partial++; if (isSignificant) significant++; } else if (coverage > 0.01) fringe++;
  }
  if (strong && full + partial <= 3 && full + partial > 0) return Math.max(0.6, gain * maxCoverage);
  let visible = Math.min(1, (full + 0.6 * partial + 0.1 * fringe) / (strong ? 2 : 4)) * gain;
  if (fringe > 0 && visible < 0.1) visible = 0.1 * maxCoverage;
  if (significant > 0) visible = Math.max(strong ? 0.3 : 0.1, visible);
  return clamp01(visible * (0.3 + 0.7 * maxCoverage));
}

/** Share of the heatmap that is still shown when the footprint has reached `barAlpha`: all of it with the footprint absent, none once the footprint is dominant (from about three quarters in), eased so it does not snap. */
export function heatmapShare(barAlpha: number): number {
  const t = clamp01(barAlpha / 0.75);
  return 1 - t * t * (3 - 2 * t);
}

export interface LodFrame { barAlpha: number; sellBuyAlpha: number; needsFrame: boolean; heatmapOpacity: number; narrowing: number }

/** Footprint level-of-detail state: eligibility gates with hysteresis plus the two fade tweens. */
export class FootprintLod {
  #bars = false; #sellBuy = false;
  #barTw: Tween = { from: 0, target: 0, start: 0 }; #sbTw: Tween = { from: 0, target: 0, start: 0 };
  #level = 0;

  /** Dyadic row grouping that keeps rows 12-16 px tall (with hysteresis), as multiples of the recorded fine step. */
  level(fineRowPx: number): number {
    const p = FOOTPRINT_POLICY; let level = this.#level;
    if (fineRowPx * 2 ** level < p.coarsenHeight) while (level < p.maxLevel && fineRowPx * 2 ** level < p.coarsenHeight) level++;
    else while (level > 0 && fineRowPx * 2 ** (level - 1) >= p.refineHeight) level--;
    this.#level = level; return level;
  }

  step(now: number, input: { enabled: boolean; hasData: boolean; widthCss: number; rowHeightCss: number; factor: number }): LodFrame {
    const p = FOOTPRINT_POLICY, { widthCss: w, rowHeightCss: h } = input, factor = clamp01(input.factor);
    const active = input.enabled && input.hasData;
    this.#bars = active && (this.#bars ? w > p.barLeave : w >= p.barEnter);
    const sellBuy = active && this.#bars && (this.#sellBuy ? w >= p.sellBuyLeaveWidth && h >= p.sellBuyLeaveHeight && factor > p.textLeaveFactor : w >= p.sellBuyEnterWidth && h >= p.sellBuyEnterHeight && factor >= p.textEnterFactor);
    this.#sellBuy = sellBuy;
    this.#barTw = retarget(this.#barTw, active && this.#bars && w > p.zeroBar ? factor : 0, now);
    this.#sbTw = retarget(this.#sbTw, this.#sellBuy ? 1 : 0, now);
    const barAlpha = clamp01(sample(this.#barTw, now));
    const moving = [this.#barTw, this.#sbTw].some(t => t.from !== t.target && now < t.start + p.fadeMs);
    return { barAlpha, sellBuyAlpha: clamp01(sample(this.#sbTw, now)), needsFrame: moving, heatmapOpacity: heatmapShare(barAlpha), narrowing: Math.max(barAlpha, sample(this.#sbTw, now)) };
  }
}

/** Executions per candle (taker buy/sell USD by price row), fetched for the visible window and cached briefly. */
export class FootprintData {
  /** Row step of the loaded data and the recorded finest step. */
  step = 0; fine = 0;
  bars = new Map<number, Bar>();
  /** Bumped whenever `bars` is replaced, for what is worked out from them (the imbalance marks). */
  version = 0;
  #key = ''; #loadedAt = 0; #busy = false;
  /** The market and timeframe the bars belong to, and the number of the request whose answer counts. */
  #context = ''; #request = 0;

  /** Start a refresh when the window, row size or timeframe changed or the data is older than 5 s. */
  ensure(inst: string, tf: string, view: Bounds, rowStep: number, load: (inst: string, tf: string, from: number, to: number, rowStep: number) => Promise<FootprintResponse>, onLoad: () => void): void {
    const tfMs = TIMEFRAMES[tf] ?? 3_600_000;
    // Rows of another market or timeframe are not rows of this one, whatever the window: they go now, rather than being drawn until the new
    // ones come (or for good, if they never do). A request still out for the old context is left to finish, and its answer is ignored.
    const context = `${inst}|${tf}`;
    if (context !== this.#context) { this.#context = context; this.bars = new Map(); this.step = 0; this.fine = 0; this.#key = ''; this.#busy = false; this.version++; }
    const key = `${context}|${rowStep}|${Math.floor(view.t0 / tfMs)}|${Math.floor(view.t1 / tfMs)}`;
    if (this.#busy || (key === this.#key && performance.now() - this.#loadedAt < 5_000)) return;
    this.#busy = true; this.#key = key;
    const request = ++this.#request;
    load(inst, tf, view.t0 - tfMs, view.t1 + tfMs, rowStep).then(body => {
      if (request !== this.#request) return;
      this.step = body.step; this.fine = body.fine; this.bars = new Map(body.bars.map(bar => [bar.t, readBar(bar)])); this.version++; this.#loadedAt = performance.now(); onLoad();
    }).catch(error => {
      if (request !== this.#request) return;
      // Asked again in five seconds, not on every frame.
      console.error('footprint load failed', error); this.#loadedAt = performance.now();
    }).finally(() => { if (request === this.#request) this.#busy = false; });
  }
}

/** Which side a row's bar belongs to: the dominant side when it is at least IMBALANCE_RATIO times the other, else none. */
export function imbalance(buy: number, sell: number): 'buy' | 'sell' | null {
  const high = Math.max(buy, sell), low = Math.min(buy, sell);
  if (!(high > 0)) return null;
  return low === 0 || high / low >= IMBALANCE_RATIO ? (buy > sell ? 'buy' : 'sell') : null;
}

/** The width in px of a candle's body in a slot of `slotPx`: most of the slot, never more than 40 px. Every candle has it, the one still forming too. */
export const candleBody = (slotPx: number): number => Math.max(1, Math.min(slotPx * 0.72, 40));

/**
 * Geometry of one candle slot with the footprint on, as offsets from the slot's left edge: the candle body sits at the
 * left (about a fifth of the slot, at most 44 px), the row column follows it.
 */
export function footprintLayout(slot: number): { body: number; candleCenter: number; colLeft: number; colWidth: number } {
  const gap = slot * 0.02, body = Math.min(slot * 0.2, 44);
  const colLeft = gap + body + slot * 0.03;
  return { body, candleCenter: gap + body / 2, colLeft, colWidth: Math.max(1, slot - colLeft - gap) };
}

/** Compact volume text as printed in the rows: 13.4M, 407.0k, 0.00. */
export function volText(value: number): string {
  if (!(value > 0)) return '0.00';
  if (value >= 1e9) return `${(value / 1e9).toFixed(1)}B`;
  if (value >= 1e6) return `${(value / 1e6).toFixed(1)}M`;
  if (value >= 1e3) return `${(value / 1e3).toFixed(1)}k`;
  return value.toFixed(0);
}

/** Asks which drawn rows to mark (the cells of a flagged candle) and receives their rectangles. */
export interface RowMarks { wants(barT: number, mid: number, side: 'buy' | 'sell'): boolean; add(x: number, y: number, w: number, h: number, barT: number): void }

/** What the footprint draws besides its rows' bars: each candle's imbalance marks, and how it is set (what a row prints, whether diagonal imbalances are outlined). */
export interface FootprintLook { marks: ReadonlyMap<number, BarMarks> | null; settings: FootprintSettings }

const FONT = '10.5px ui-monospace, SFMono-Regular, Menlo, monospace', BOLD = `600 ${FONT}`;

/**
 * Draw the per-row footprint to the right of each candle: a bar behind rows where one side dominates the same row, then what the row prints
 * (sold × bought, the delta, the total, or nothing). A diagonal imbalance is outlined in its side's colour around that side's half of the
 * row (sells on the left, buys on the right) and its number is bold in that colour; the outline stays while the numbers are too small to
 * print. `marks` (row marks) collects the rectangles of the rows it asks for.
 */
export function paintFootprint(ctx: CanvasRenderingContext2D, data: FootprintData, lod: LodFrame, tf: string, view: View, pw: number, ph: number, p: Palette, marks?: RowMarks, look?: FootprintLook): void {
  const tfMs = TIMEFRAMES[tf] ?? 3_600_000, step = data.step;
  if (!(step > 0) || lod.barAlpha <= 0.005) return;
  const slot = pw * tfMs / (view.t1 - view.t0), rowPx = Math.abs(view.yOf(0, ph) - view.yOf(step, ph)), layout = footprintLayout(slot);
  let maxSide = 0;
  for (const bar of data.bars.values()) if (bar.t + tfMs >= view.t0 && bar.t <= view.t1) for (const r of bar.rows) maxSide = Math.max(maxSide, r[1], r[2]);
  if (!(maxSide > 0)) return;
  ctx.font = FONT; ctx.textBaseline = 'middle';
  const numberWidth = ctx.measureText('999.9M').width, textColor = p.dark ? '#f1f1f1' : p.text, mode = look?.settings.text ?? 'split';
  const diagonal = look?.settings.diagonal !== false ? look?.marks ?? null : null;
  for (const bar of data.bars.values()) {
    if (bar.t + tfMs < view.t0 || bar.t > view.t1) continue;
    const left = view.xOf(bar.t, pw) + layout.colLeft, split = left + Math.min(numberWidth + 5.5, layout.colWidth / 2), right = Math.min(left + layout.colWidth, split + numberWidth + 5.5);
    const flags = diagonal?.get(bar.t)?.flags;
    for (const [low, buy, sell] of bar.rows) {
      const yTop = view.yOf(low + step, ph), h = Math.max(1, rowPx - 1);
      if (yTop + h < 0 || yTop > ph) continue;
      const side = imbalance(buy, sell);
      if (side) {
        ctx.globalAlpha = (p.dark ? 0.9 : 0.62) * lod.barAlpha; ctx.fillStyle = side === 'buy' ? p.candleUp : p.candleDown;
        const barWidth = Math.max(2, Math.min(layout.colWidth, layout.colWidth * Math.max(buy, sell) / maxSide));
        ctx.fillRect(left, yTop, barWidth, h);
        if (marks?.wants(bar.t, low + step / 2, side)) marks.add(left, yTop, barWidth, h, bar.t);
      }
      const flag = flags?.get(low);
      if (flag && h >= 3) {
        ctx.globalAlpha = lod.barAlpha; ctx.lineWidth = h >= 8 ? 1.5 : 1;
        if (flag.sell !== undefined) { ctx.strokeStyle = p.candleDown; ctx.strokeRect(left + 0.75, yTop + 0.75, split - left - 1.5, h - 1.5); }
        if (flag.buy !== undefined) { ctx.strokeStyle = p.candleUp; ctx.strokeRect(split + 0.75, yTop + 0.75, right - split - 1.5, h - 1.5); }
      }
      if (lod.sellBuyAlpha > 0.01 && mode !== 'none') {
        ctx.globalAlpha = lod.sellBuyAlpha;
        const y = yTop + h / 2;
        if (mode === 'split') {
          ctx.font = flag?.sell !== undefined ? BOLD : FONT; ctx.fillStyle = flag?.sell !== undefined ? p.candleDown : textColor;
          ctx.textAlign = 'right'; ctx.fillText(volText(sell), split - 2.5, y);
          ctx.font = flag?.buy !== undefined ? BOLD : FONT; ctx.fillStyle = flag?.buy !== undefined ? p.candleUp : textColor;
          ctx.textAlign = 'left'; ctx.fillText(volText(buy), split + 2.5, y);
        } else {
          const value = mode === 'delta' ? buy - sell : buy + sell;
          ctx.font = flag ? BOLD : FONT; ctx.fillStyle = mode === 'delta' ? (value > 0 ? p.candleUp : value < 0 ? p.candleDown : textColor) : textColor;
          ctx.textAlign = 'center'; ctx.fillText(mode === 'delta' ? signed(value) : volText(value), (left + right) / 2, y);
        }
      }
    }
  }
  ctx.globalAlpha = 1; ctx.font = '11px ui-sans-serif, system-ui, sans-serif'; ctx.textBaseline = 'middle'; ctx.textAlign = 'left';
}

/** One price row of one candle, with how it stands in that candle. */
export interface RowCell {
  low: number; buy: number; sell: number;
  /** The busiest row of the candle (the point of control). */
  poc: boolean;
  /** This row's share of the candle's executed volume, 0 to 1. */
  share: number;
  barBuy: number; barSell: number;
}

/** The row of `bar` that holds `price`, with its place in the candle, or null where the candle has no executions at that price. */
export function rowCellAt(bar: Bar, step: number, price: number): RowCell | null {
  const row = bar.rows.find(r => price >= r[0] && price < r[0] + step);
  if (!row) return null;
  let busiest = 0, total = 0;
  for (const r of bar.rows) { busiest = Math.max(busiest, r[1] + r[2]); total += r[1] + r[2]; }
  return { low: row[0], buy: row[1], sell: row[2], poc: row[1] + row[2] >= busiest && busiest > 0, share: total > 0 ? (row[1] + row[2]) / total : 0, barBuy: bar.buyUsd, barSell: bar.sellUsd };
}

const signed = (value: number): string => (value < 0 ? '-' : value > 0 ? '+' : '') + volText(Math.abs(value));

/** How a diagonal ratio reads: "3.4×", or no ratio at all against an empty row. */
const ratioText = (ratio: number): string => Number.isFinite(ratio) ? `${ratio.toFixed(1)}×` : '';

/**
 * The popup for a footprint row: its price span, what was sold and bought there, which side had it, the diagonal imbalances outlined there
 * (`diagonal`: the ratio of each flagged side), and the candle it belongs to.
 */
export function rowCellLines(cell: RowCell, bar: Bar, step: number, tf: string, diagonal?: { sell?: number; buy?: number }): InfoLine[] {
  const side = imbalance(cell.buy, cell.sell), delta = cell.buy - cell.sell, big = Math.max(cell.buy, cell.sell), small = Math.min(cell.buy, cell.sell);
  const lines: InfoLine[] = [
    { text: `${fmtPrice(cell.low, step)} – ${fmtPrice(cell.low + step, step)}`, bold: true },
    { label: t('Candle'), text: `${clock(bar.t, true)} · ${tf}` },
    { label: t('Sold'), text: `$${volText(cell.sell)}`, color: 'sell' },
    { label: t('Bought'), text: `$${volText(cell.buy)}`, color: 'buy' },
    { label: t('Delta'), text: signed(delta), color: delta > 0 ? 'buy' : delta < 0 ? 'sell' : 'text', bold: true },
    { label: t('Share of candle'), text: `${(cell.share * 100).toFixed(cell.share < 0.1 ? 1 : 0)}%` },
  ];
  if (side) lines.push({ label: t('Heavier side'), text: small > 0 ? t('{side} {ratio}×', { side: side === 'buy' ? t('buyers') : t('sellers'), ratio: (big / small).toFixed(1) }) : side === 'buy' ? t('buyers only') : t('sellers only'), color: side === 'buy' ? 'buy' : 'sell' });
  else lines.push({ label: t('Heavier side'), text: t('balanced'), color: 'muted' });
  if (diagonal?.sell !== undefined) lines.push({ label: t('Diagonal'), text: Number.isFinite(diagonal.sell) ? t('sells {ratio} the buys one row up', { ratio: ratioText(diagonal.sell) }) : t('sells, none bought one row up'), color: 'sell' });
  if (diagonal?.buy !== undefined) lines.push({ label: t('Diagonal'), text: Number.isFinite(diagonal.buy) ? t('buys {ratio} the sells one row down', { ratio: ratioText(diagonal.buy) }) : t('buys, none sold one row down'), color: 'buy' });
  if (cell.poc) lines.push({ text: t('Point of control: the busiest row of this candle'), color: 'muted', wrap: true });
  lines.push({ label: t('Candle volume'), text: `$${volText(cell.barBuy + cell.barSell)}`, rule: true });
  lines.push({ label: t('Candle delta'), text: signed(cell.barBuy - cell.barSell), color: cell.barBuy > cell.barSell ? 'buy' : cell.barBuy < cell.barSell ? 'sell' : 'text' });
  return lines;
}
