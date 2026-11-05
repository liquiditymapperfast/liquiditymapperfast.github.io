import type { InfoLine } from '../infobox.ts';
import { anomalies, type HighlightOptions } from '../anomaly.ts';
import { clock, price as fmtPrice, usd } from '../format.ts';
import { signedUsd } from '../cvd/text.ts';
import { t } from '../i18n.ts';
import { bandText } from '../depth-settings.ts';

/**
 * What the popup says for a point of the Depth, Liquidity Tracker and Open Interest panes: the lines of the box (infobox.ts / hovercard.ts)
 * and which column of each series the pointer is over. Plain functions with no canvas and no DOM, so they are tested alone.
 */

/** How many columns the Depth pane asks the worker for over a plot `plotW` px wide. */
export const depthColumns = (plotW: number): number => Math.min(1200, Math.max(60, Math.floor(plotW / 2)));

/**
 * What a Depth request was made for. The recorded columns that arrive later are part of it: an answer made from the columns that were here
 * before them is not the answer for the ones that came, and a view that stays where it is would otherwise keep it. The view counts in whole
 * columns of the answer: the map following the live edge moves a little on every frame, and asking again for each of those kept the worker
 * busy for nothing (what is live is refreshed on a clock instead).
 */
export function depthKey(ids: readonly string[], t0: number, t1: number, plotW: number, range: number | string, columnsVersion: number): string {
  const span = t1 - t0, column = span / depthColumns(plotW);
  return `${ids.join(',')}|${Math.round(span)}|${column > 0 ? Math.floor(t0 / column) : 0}|${plotW}|${range}|${columnsVersion}`;
}

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

/**
 * What a pointer at `time` reads: the point `found` under it, else, when `time` is at or past the newest point (index `newest`, at
 * `newestT`), the newest. Right of the plotted data, or over the pane's price axis, the popup keeps the last value instead of going away:
 * on a plot of this resolution, landing exactly on the last point is a hunt. A time in a gap between points still reads nothing.
 */
export function readAt(found: number, time: number, newest: number, newestT: number | undefined): number {
  if (found >= 0) return found;
  return newest >= 0 && newestT !== undefined && time >= newestT ? newest : -1;
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
/** Coins to three significant figures, so a fraction of a coin is never written 0. */
const coinFigures = new Intl.NumberFormat('en-US', { notation: 'compact', maximumSignificantDigits: 3 });

/**
 * One moment of the Depth pane where its table is not drawn (no room beside the plot, or the table switched off): each band's bids and asks, the
 * watched band (the one brought forward, else the widest) in bold with its difference and balance, and where that band's total stands in the view.
 */
export function depthCardLines(h: { time: number; bands: readonly { r: number; bid: number; ask: number }[]; watched: number; units: 'usd' | 'coin'; coin: string; rank: number | null; of: number }): InfoLine[] {
  const fmt = (value: number): string => h.units === 'coin' ? `${coinFigures.format(value)} ${h.coin}` : money(value);
  const lines: InfoLine[] = [{ text: t('Depth'), bold: true }, { label: t('Time'), text: clock(h.time, true) }];
  h.bands.forEach((band, j) => lines.push({ label: `±${bandText(band.r)}%`, text: `${fmt(band.bid)} · ${fmt(band.ask)}`, bold: j === h.watched }));
  const w = h.bands[h.watched];
  if (w) {
    const diff = w.bid - w.ask;
    lines.push({ label: 'Δ', text: h.units === 'coin' ? `${diff >= 0 ? '+' : '−'}${fmt(Math.abs(diff))}` : signedUsd(diff), color: sideColor(diff), bold: true });
    const imbalance = imbalanceLine(w.bid, w.ask); if (imbalance) lines.push(imbalance);
  }
  if (h.rank !== null && h.of > 1) lines.push({ label: t('Rank in view'), text: t('{rank} of {total}', { rank: h.rank, total: h.of }) });
  lines.push({ text: t('Bids · asks resting within each distance of the price, added up over the enabled venues; each band holds the ones inside it.'), color: 'muted', wrap: true, rule: true });
  return lines;
}

/**
 * One moment of the Depth pane's Liquidation levels where its table is not drawn: the snapshot in force (when its positions stood), each band's
 * longs and shorts, the watched band in bold with their difference. Where the money sits, not what was or will be liquidated.
 */
export function liqCardLines(h: { asOf: number; bands: readonly { r: number; bid: number; ask: number }[]; watched: number; units: 'usd' | 'coin'; coin: string }): InfoLine[] {
  const fmt = (value: number): string => h.units === 'coin' ? `${coinFigures.format(value)} ${h.coin}` : money(value);
  const lines: InfoLine[] = [{ text: t('Liquidation levels'), bold: true }, { label: t('Positions'), text: clock(h.asOf, true) }];
  h.bands.forEach((band, j) => lines.push({ label: `±${bandText(band.r)}%`, text: `${fmt(band.bid)} · ${fmt(band.ask)}`, bold: j === h.watched }));
  const w = h.bands[h.watched];
  if (w) {
    const diff = w.bid - w.ask;
    lines.push({ label: 'Δ', text: h.units === 'coin' ? `${diff >= 0 ? '+' : '−'}${fmt(Math.abs(diff))}` : signedUsd(diff), color: sideColor(diff), bold: true });
  }
  lines.push({ text: t('Longs · shorts that would be liquidated within each distance of the price, from HyperTracker\'s snapshot of Hyperliquid\'s BTC positions: where the money sits, not what will be liquidated.'), color: 'muted', wrap: true, rule: true });
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
/** `estimate`: a reading of the long view (oi-long.ts), Bybit's scaled to meet the line: its time is the reading's, its figures marked ≈. */
export function oiCardLines(h: { time: number; level: number; change: number | null; before: number | null; rank: number | null; of: number; sigma: number | null; source: string | null; staleMin: number | null; estimate?: boolean }): InfoLine[] {
  const about = h.estimate ? '≈ ' : '';
  const signed = (value: number): string => `${about}${value > 0 ? '+' : value < 0 ? '−' : ''}${fmtPrice(Math.abs(value), 1)}`;
  const lines: InfoLine[] = [
    { text: t('Open Interest'), bold: true },
    { label: h.estimate ? t('Time') : t('Candle'), text: clock(h.time, true) },
    { label: t('Open interest'), text: `${about}${fmtPrice(h.level, 1)}`, bold: true },
  ];
  if (h.change !== null) lines.push({ label: 'Δ', text: signed(h.change), color: sideColor(h.change), bold: true });
  if (h.before !== null) lines.push({ label: t('Candle before'), text: signed(h.before) });
  if (h.rank !== null && h.of > 1) lines.push({ label: t('Rank in view'), text: t('{rank} of {total}', { rank: h.rank, total: h.of }) });
  if (h.sigma !== null && Number.isFinite(h.sigma)) lines.push({ label: t('Unusual'), text: t('{z}σ above its baseline', { z: h.sigma.toFixed(1) }), bold: true });
  if (h.source) lines.push({ text: h.source, color: 'muted' });
  if (h.staleMin !== null) lines.push({ text: t('last sample {n} min ago', { n: h.staleMin }), color: 'above' });
  lines.push({ text: h.estimate ? t('Further back than the readings held: Bybit\'s own open interest, scaled to meet the line where it starts. An estimate of the total, and how far it moved since the reading before.') : t('Open interest at the end of the candle, and how far it moved since the end of the one before.'), color: 'muted', wrap: true, rule: true });
  return lines;
}
