import type { InfoLine } from '../infobox.ts';
import { anomalies, type HighlightOptions } from '../anomaly.ts';
import { clock, price as fmtPrice, usd } from '../format.ts';
import { signedUsd } from '../cvd/text.ts';
import { t } from '../i18n.ts';

/**
 * What the popup says for a point of the Depth, Liquidity Tracker and Open Interest panes: the lines of the box (infobox.ts / hovercard.ts)
 * and which column of each series the pointer is over. Plain functions with no canvas and no DOM, so they are tested alone.
 */

/** The column of `count` equal columns over [t0, t1) that `time` falls in, or -1 outside it. */
export function columnAt(t0: number, t1: number, count: number, time: number): number {
  if (!(t1 > t0) || !(count > 0) || !(time >= t0) || !(time < t1)) return -1;
  return Math.min(count - 1, Math.floor((time - t0) / (t1 - t0) * count));
}

/** The column whose slot `[times[i], times[i] + step)` holds `time` (columns are sorted by time), or -1 when it falls in a gap between them. */
export function slotAt(times: ArrayLike<number>, step: number, time: number): number {
  let found = -1;
  for (let i = 0; i < times.length; i++) { if (times[i]! <= time) found = i; else break; }
  return found >= 0 && time < times[found]! + step ? found : -1;
}

/** The bar of `bars` (each starting with its start time, sorted) the time falls in: the last one that has started. The newest holds on past its own slot (its level is the latest known until the next sample), so it answers for any later time. */
export function barAt(bars: ArrayLike<ArrayLike<number>>, tf: number, time: number): number {
  let found = -1;
  for (let i = 0; i < bars.length; i++) { if (bars[i]![0]! <= time) found = i; else break; }
  if (found < 0) return -1;
  return found === bars.length - 1 || time < bars[found]![0]! + tf ? found : -1;
}

/**
 * The columns of the Depth pane whose imbalance (bids minus asks over their sum, in size) is unusual: the one rule Highlights sets for the
 * whole page, applied to the columns. The baseline is `length` bars before the column, and a bar is `columnsPerBar` columns wide, so the
 * baseline covers the same stretch of time at any zoom; nothing is flagged until a dozen columns exist. Columns without liquidity are skipped.
 */
export function imbalanceFlags(bid: ArrayLike<number>, ask: ArrayLike<number>, highlight: Pick<HighlightOptions, 'length' | 'mult'>, columnsPerBar: number): Uint8Array {
  const n = Math.min(bid.length, ask.length), size = new Float64Array(n);
  for (let i = 0; i < n; i++) { const total = bid[i]! + ask[i]!; size[i] = total > 0 ? Math.abs(bid[i]! - ask[i]!) / total : NaN; }
  const length = Math.max(12, Math.min(n, Math.round(highlight.length * Math.max(columnsPerBar, 1e-9))));
  return anomalies(size, { length, mult: highlight.mult }).flag;
}

/**
 * Where the Open Interest step line ends: at the newest sample's centre when that sample is the last one on screen (`live`, and the dashed
 * continuation to the newest candle may follow), and otherwise at the right edge of the plot, at the level of the last sample on screen.
 */
export function oiTail(count: number, last: number, xSampled: number, plotW: number): { x: number; live: boolean } {
  const live = last === count - 1;
  return { x: live ? xSampled : plotW, live };
}

/** The side that has more of the two, and by how much of the two together. */
function imbalanceLine(bid: number, ask: number): InfoLine | null {
  const total = bid + ask;
  if (!(total > 0)) return null;
  const share = (bid - ask) / total;
  if (Math.abs(share) < 0.005) return { label: t('Imbalance'), text: '0%' };
  return { label: t('Imbalance'), text: `${share > 0 ? t('bids') : t('asks')} +${(Math.abs(share) * 100).toFixed(1)}%`, color: share > 0 ? 'below' : 'above', bold: true };
}
/** An amount of USD as the popups write it, with the sign the signed ones have. */
const money = (value: number): string => `$${usd(value)}`;
const sideColor = (value: number): InfoLine['color'] => value > 0 ? 'below' : value < 0 ? 'above' : 'text';

/** The liquidity of one column of the Depth pane: both sides within the chosen range of the price, how they compare, and where this moment stands in the view. */
export function depthCardLines(h: { time: number; bid: number; ask: number; range: number; rank: number | null; of: number }): InfoLine[] {
  const lines: InfoLine[] = [
    { text: t('Depth'), bold: true },
    { label: t('Time'), text: clock(h.time, true) },
    { label: t('Asks'), text: money(h.ask), color: 'above' },
    { label: t('Bids'), text: money(h.bid), color: 'below' },
    { label: 'Δ', text: signedUsd(h.bid - h.ask), color: sideColor(h.bid - h.ask), bold: true },
  ];
  const imbalance = imbalanceLine(h.bid, h.ask); if (imbalance) lines.push(imbalance);
  lines.push({ label: t('Range'), text: `±${Math.round(h.range * 1000) / 10}%` });
  if (h.rank !== null && h.of > 1) lines.push({ label: t('Rank in view'), text: t('{rank} of {total}', { rank: h.rank, total: h.of }) });
  lines.push({ text: t('Resting liquidity within the chosen range of the price, added up over the enabled venues.'), color: 'muted', wrap: true, rule: true });
  return lines;
}

/** One point of the Liquidity Tracker: the weighted liquidity of each side, how it compares, and the settings it was worked out with. */
export function ltCardLines(h: { time: number; bid: number; ask: number; halfLifeBp: number; venues: number }): InfoLine[] {
  const lines: InfoLine[] = [
    { text: t('Liquidity Tracker'), bold: true },
    { label: t('Time'), text: clock(h.time, true) },
    { label: t('Bid'), text: money(h.bid), color: 'below' },
    { label: t('Ask'), text: money(h.ask), color: 'above' },
    { label: 'Δ', text: signedUsd(h.bid - h.ask), color: sideColor(h.bid - h.ask), bold: true },
  ];
  const imbalance = imbalanceLine(h.bid, h.ask); if (imbalance) lines.push(imbalance);
  lines.push({ label: t('Half-life'), text: `${h.halfLifeBp} bp` }, { label: t('Venues'), text: String(h.venues) });
  lines.push({ text: t('Liquidity near the touch, weighted: a level counts in full at the touch and half as much for every half-life further away.'), color: 'muted', wrap: true, rule: true });
  return lines;
}

/** One bar of the Open Interest pane: the level, the step from the bar before, and how unusual that step is. */
export function oiCardLines(h: { time: number; level: number; change: number | null; before: number | null; rank: number | null; of: number; sigma: number | null; source: string | null; staleMin: number | null }): InfoLine[] {
  const signed = (value: number): string => `${value > 0 ? '+' : value < 0 ? '−' : ''}${fmtPrice(Math.abs(value), 1)}`;
  const lines: InfoLine[] = [
    { text: t('Open Interest'), bold: true },
    { label: t('Candle'), text: clock(h.time, true) },
    { label: t('Open interest'), text: fmtPrice(h.level, 1), bold: true },
  ];
  if (h.change !== null) lines.push({ label: 'Δ', text: signed(h.change), color: sideColor(h.change), bold: true });
  if (h.before !== null) lines.push({ label: t('Candle before'), text: signed(h.before) });
  if (h.rank !== null && h.of > 1) lines.push({ label: t('Rank in view'), text: t('{rank} of {total}', { rank: h.rank, total: h.of }) });
  if (h.sigma !== null && Number.isFinite(h.sigma)) lines.push({ label: t('Unusual'), text: t('{z}σ above its baseline', { z: h.sigma.toFixed(1) }), bold: true });
  if (h.source) lines.push({ text: h.source, color: 'muted' });
  if (h.staleMin !== null) lines.push({ text: t('last sample {n} min ago', { n: h.staleMin }), color: 'above' });
  lines.push({ text: t('Open interest at the end of the candle, and how far it moved since the end of the one before.'), color: 'muted', wrap: true, rule: true });
  return lines;
}
