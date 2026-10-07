import type { ProfileAnswer } from '../shared/footprint.ts';
import { clock, price as fmtPrice, startOfDay, usd } from './format.ts';
import { t } from './i18n.ts';
import type { InfoLine } from './infobox.ts';

/**
 * The traded-volume column (Bookmap's chart-range volume profile): how much was bought and sold at market at each price over the time on
 * the map, added up over the instruments the flow column counts. It sits beside the book profile on the same rows, so resting liquidity and
 * executed volume can be read side by side: a long book bar with no traded bar is a wall nobody has touched, a short book bar with a long
 * traded bar is a level that has already absorbed a lot.
 */

/** The column's rows on the display grid: buys and sells per row of `step`, the first row being `bin0` (price = (bin0 + i) * step). */
export interface TradedRows {
  step: number; bin0: number; buy: Float64Array; sell: Float64Array;
  /** All volume in the rows, the largest row, and the row holding it (-1 when nothing traded). */
  total: number; max: number; poc: number;
  /**
   * From when every instrument that has anything recorded is recorded (the latest of their first minutes; null when none has anything), and
   * whether the window reaches back before that: earlier rows then hold only the instruments that were recording already.
   */
  recordedSince: number | null; partial: boolean;
}

/** Each instrument's rows put on the display grid of `step` over [p0, p1]: a recorded row goes where its middle falls. */
export function tradedRows(answer: ProfileAnswer, step: number, p0: number, p1: number): TradedRows {
  const bin0 = Math.floor(p0 / step), n = Math.max(0, Math.floor(p1 / step) - bin0 + 1);
  const buy = new Float64Array(n), sell = new Float64Array(n);
  let since: number | null = null;
  for (const inst of answer.instruments) {
    if (inst.earliest !== null && (since === null || inst.earliest > since)) since = inst.earliest;
    for (const [low, b, s] of inst.rows) {
      const i = Math.floor((low + inst.step / 2) / step) - bin0;
      if (i < 0 || i >= n) continue;
      buy[i]! += b; sell[i]! += s;
    }
  }
  let total = 0, max = 0, poc = -1;
  for (let i = 0; i < n; i++) { const v = buy[i]! + sell[i]!; total += v; if (v > max) { max = v; poc = i; } }
  return { step, bin0, buy, sell, total, max, poc, recordedSince: since, partial: since === null || since > answer.from };
}

/** A time as the page says it, with the date when it is not today. */
const when = (time: number): string => clock(time, time < startOfDay(Date.now()));

/** The two header lines: the total over the window, and either the largest row or when the recording began (it began inside the window). */
export function tradedHeader(rows: TradedRows | null): [string, string] {
  if (!rows) return [t('TRADED'), ''];
  const head = t('TRADED {value}', { value: usd(rows.total) });
  if (rows.partial && rows.recordedSince !== null) return [head, t('since {time}', { time: when(rows.recordedSince) })];
  return [head, t('ROW MAX {value}', { value: usd(rows.max) })];
}

/** What the pointer is told on one row: its prices, buys, sells and the difference, its share of the window, and how far back the recording goes. */
export function tradedLines(rows: TradedRows, index: number): InfoLine[] {
  const low = (rows.bin0 + index) * rows.step, b = rows.buy[index] ?? 0, s = rows.sell[index] ?? 0, v = b + s;
  const lines: InfoLine[] = [{ text: `${fmtPrice(low, rows.step)} – ${fmtPrice(low + rows.step, rows.step)}`, bold: true }];
  if (!(v > 0)) lines.push({ text: t('Nothing traded at these prices in this window.'), color: 'muted', wrap: true });
  else {
    lines.push({ label: t('Bought at market'), text: `$${usd(b)}`, color: 'buy' }, { label: t('Sold at market'), text: `$${usd(s)}`, color: 'sell' });
    const net = b - s;
    lines.push({ label: t('Delta'), text: `${net > 0 ? '+' : net < 0 ? '−' : ''}$${usd(Math.abs(net))}`, ...(net > 0 ? { color: 'buy' as const } : net < 0 ? { color: 'sell' as const } : {}) });
    if (rows.total > 0) lines.push({ label: t('Share of volume'), text: `${(v / rows.total * 100).toFixed(1)} %` });
  }
  if (rows.partial && rows.recordedSince !== null) lines.push({ text: t('Recorded since {time}: the window reaches back further than the recording.', { time: when(rows.recordedSince) }), color: 'muted', wrap: true });
  return lines;
}

/** The row under a price, or -1 outside the rows. */
export const tradedRowAt = (rows: TradedRows, price: number): number => { const i = Math.floor(price / rows.step) - rows.bin0; return i >= 0 && i < rows.buy.length ? i : -1; };
