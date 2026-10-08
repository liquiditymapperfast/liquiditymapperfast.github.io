import type { ProfileAnswer } from '../shared/footprint.ts';
import type { ValueLevels } from '../shared/profile.ts';
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
  /**
   * The market orders that began on each row, where the recording counts them (null from a source that does not), and whether it counts them
   * in every minute of the window (`counted` of `minutes`, the instrument that recorded the most).
   */
  buyN: Float64Array | null; sellN: Float64Array | null; counted: number; minutes: number;
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
  const buy = new Float64Array(n), sell = new Float64Array(n), counts = answer.instruments.some(i => i.counts !== undefined);
  const buyN = counts ? new Float64Array(n) : null, sellN = counts ? new Float64Array(n) : null;
  let since: number | null = null, minutes = 0, counted = 0;
  for (const inst of answer.instruments) {
    if (inst.earliest !== null && (since === null || inst.earliest > since)) since = inst.earliest;
    if (inst.minutes > minutes || (inst.minutes === minutes && (inst.counted ?? 0) > counted)) { minutes = inst.minutes; counted = inst.counted ?? 0; }
    inst.rows.forEach(([low, b, s], r) => {
      const i = Math.floor((low + inst.step / 2) / step) - bin0;
      if (i < 0 || i >= n) return;
      buy[i]! += b; sell[i]! += s;
      const c = inst.counts?.[r];
      if (c && buyN && sellN) { buyN[i]! += c[0]; sellN[i]! += c[1]; }
    });
  }
  let total = 0, max = 0, poc = -1;
  for (let i = 0; i < n; i++) { const v = buy[i]! + sell[i]!; total += v; if (v > max) { max = v; poc = i; } }
  return { step, bin0, buy, sell, buyN, sellN, counted, minutes, total, max, poc, recordedSince: since, partial: since === null || since > answer.from };
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

/**
 * What the pointer is told on one row: its prices, buys, sells and the difference, its share of the window, the market orders that began at
 * these prices, where the row stands against the point of control and the value area (`levels`), and how far back the recording goes.
 */
export function tradedLines(rows: TradedRows, index: number, levels: ValueLevels | null = null): InfoLine[] {
  const low = (rows.bin0 + index) * rows.step, b = rows.buy[index] ?? 0, s = rows.sell[index] ?? 0, v = b + s;
  const lines: InfoLine[] = [{ text: `${fmtPrice(low, rows.step)} – ${fmtPrice(low + rows.step, rows.step)}`, bold: true }];
  if (!(v > 0)) lines.push({ text: t('Nothing traded at these prices in this window.'), color: 'muted', wrap: true });
  else {
    lines.push({ label: t('Bought at market'), text: `$${usd(b)}`, color: 'buy' }, { label: t('Sold at market'), text: `$${usd(s)}`, color: 'sell' });
    const net = b - s;
    lines.push({ label: t('Delta'), text: `${net > 0 ? '+' : net < 0 ? '−' : ''}$${usd(Math.abs(net))}`, ...(net > 0 ? { color: 'buy' as const } : net < 0 ? { color: 'sell' as const } : {}) });
    if (rows.total > 0) lines.push({ label: t('Share of volume'), text: `${(v / rows.total * 100).toFixed(1)} %` });
    if (rows.buyN && rows.sellN && rows.counted > 0) {
      lines.push({ label: t('Orders begun here'), text: t('{buys} buys · {sells} sells', { buys: (rows.buyN[index] ?? 0).toLocaleString('en-US'), sells: (rows.sellN[index] ?? 0).toLocaleString('en-US') }) });
      if (rows.counted < rows.minutes) lines.push({ text: t('Orders are counted for {n} of the {total} minutes.', { n: rows.counted, total: rows.minutes }), color: 'muted', wrap: true });
    }
  }
  if (levels) {
    const high = low + rows.step;
    const where = levels.poc >= low && levels.poc < high ? t('Point of control') : high > levels.val && low < levels.vah ? t('In the value area') : low >= levels.vah ? t('Above the value area') : t('Below the value area');
    lines.push({ label: t('Profile'), text: where, rule: true });
  }
  if (rows.partial && rows.recordedSince !== null) lines.push({ text: t('Recorded since {time}: the window reaches back further than the recording.', { time: when(rows.recordedSince) }), color: 'muted', wrap: true });
  return lines;
}

/** The row under a price, or -1 outside the rows. */
export const tradedRowAt = (rows: TradedRows, price: number): number => { const i = Math.floor(price / rows.step) - rows.bin0; return i >= 0 && i < rows.buy.length ? i : -1; };
