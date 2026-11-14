import type { ProfileAnswer } from '../shared/footprint.ts';
import type { ValueLevels } from '../shared/profile.ts';
import { clock, price as fmtPrice, startOfDay, usd } from './format.ts';
import { t } from './i18n.ts';
import type { InfoLine } from './infobox.ts';

/**
 * The traded-volume column (a volume profile over the chart's time range): how much was bought and sold at market at each price over the time on
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
/**
 * `tradedRows`, kept for the answer it was made from while the step and the window are the same: the map asks on every frame (it was half of
 * each traded column's drawing on Karl's 2560 px map, 2026-11-14), and an answer is never changed in place (new data is a new answer: the
 * pane's level and median memos rely on it too), so the same answer at the same step and window has the same rows. The rows are only read.
 */
export function tradedRowsHeld(answer: ProfileAnswer, step: number, p0: number, p1: number): TradedRows {
  const held = heldRows.get(answer);
  if (held && held.step === step && held.p0 === p0 && held.p1 === p1) return held.rows;
  const rows = tradedRows(answer, step, p0, p1);
  heldRows.set(answer, { step, p0, p1, rows });
  return rows;
}
const heldRows = new WeakMap<ProfileAnswer, { step: number; p0: number; p1: number; rows: TradedRows }>();

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
 * What a row's two sides, their difference and its share are called: traded volume's by default, another measure's for the column's other
 * measures (measures/registry.ts), whose two sides take the same places (bid colour, then ask colour).
 */
export interface ColumnWords { buy: string; sell: string; net: string; share: string; none: string }
export const VOLUME_WORDS: ColumnWords = { buy: t('Bought at market'), sell: t('Sold at market'), net: t('Delta'), share: t('Share of volume'), none: t('Nothing traded at these prices in this window.') };

/**
 * What the pointer is told on one row: its prices, buys, sells and the difference, its share of the window, the market orders that began at
 * these prices, where the row stands against the point of control and the value area (`levels`), and how far back the recording goes.
 */
export function tradedLines(rows: TradedRows, index: number, levels: ValueLevels | null = null, words: ColumnWords = VOLUME_WORDS, note: string | null = null, split = true): InfoLine[] {
  const low = (rows.bin0 + index) * rows.step, high = low + rows.step;
  return [{ text: `${fmtPrice(low, rows.step)} – ${fmtPrice(high, rows.step)}`, bold: true }, ...rowBody(rows, index, words, whereIn(levels, low, high), split), ...(note ? [{ text: note, color: 'muted' as const, wrap: true, rule: true }] : [])];
}

/** Where the prices [low, high) stand against a profile's point of control and value area, in words (null without levels). */
const whereIn = (levels: ValueLevels | null, low: number, high: number): string | null => !levels ? null
  : levels.poc >= low && levels.poc < high ? t('Point of control') : high > levels.val && low < levels.vah ? t('In the value area') : low >= levels.vah ? t('Above the value area') : t('Below the value area');

/** A row of a day's, week's, month's or session's profile on the chart, as its box shows it (`periodRowLines`). */
export interface PeriodRow {
  /** Whose profile ("Oct 20", "≈ Oct" from candles), and the row's prices on rows of `step`. */
  name: string; low: number; high: number; step: number;
  /** What was bought and sold at market on the row (all of it in `buy` where the candles do not say), and in the whole profile. */
  buy: number; sell: number; total: number;
  /** Whether the row's two sides are known (the recording's trades, candles with taker buys). */
  split: boolean;
  levels: ValueLevels | null;
  /** Where an estimate comes from, said under the figures (null for the recording's own trades). */
  source: string | null;
}

/**
 * The box of a period profile's row: whose it is and its prices, its two sides and their difference where they are known (else its whole
 * volume), its share of the period, where it stands against the period's point of control and value area, and where an estimate comes from.
 */
export function periodRowLines(r: PeriodRow, words: ColumnWords = VOLUME_WORDS): InfoLine[] {
  const v = r.buy + r.sell, lines: InfoLine[] = [{ text: r.name, bold: true }, { text: `${fmtPrice(r.low, r.step)} – ${fmtPrice(r.high, r.step)}` }];
  if (r.split) {
    const net = r.buy - r.sell;
    lines.push({ label: words.buy, text: `$${usd(r.buy)}`, color: 'buy' }, { label: words.sell, text: `$${usd(r.sell)}`, color: 'sell' },
      { label: words.net, text: `${net > 0 ? '+' : net < 0 ? '−' : ''}$${usd(Math.abs(net))}`, ...(net > 0 ? { color: 'buy' as const } : net < 0 ? { color: 'sell' as const } : {}) });
  } else lines.push({ label: t('Volume'), text: `$${usd(v)}` });
  if (r.total > 0) lines.push({ label: words.share, text: `${(v / r.total * 100).toFixed(1)} %` });
  const where = whereIn(r.levels, r.low, r.high);
  if (where) lines.push({ label: t('Profile'), text: where, rule: true });
  if (r.source) lines.push({ text: r.source, color: 'muted', wrap: true });
  return lines;
}

/**
 * The body of a row's box under its first line, which says where the row is (its prices on the column, its time span on the profile along
 * the top): its two sides and their difference, its share of the window, the market orders that began in it where they are counted, where
 * it stands against the point of control and the value area (`where`, in the words of its axis), and how far back the recording goes.
 * `split` false: the column's two sides are not known (an estimate from candles that do not say who bought), so its box gives the volume
 * alone, never a bought and a sold side or their difference.
 */
export function rowBody(rows: TradedRows, index: number, words: ColumnWords, where: string | null, split = true): InfoLine[] {
  const b = rows.buy[index] ?? 0, s = rows.sell[index] ?? 0, v = b + s, lines: InfoLine[] = [];
  if (!(v > 0)) lines.push({ text: words.none, color: 'muted', wrap: true });
  else {
    if (split) {
      lines.push({ label: words.buy, text: `$${usd(b)}`, color: 'buy' }, { label: words.sell, text: `$${usd(s)}`, color: 'sell' });
      const net = b - s;
      lines.push({ label: words.net, text: `${net > 0 ? '+' : net < 0 ? '−' : ''}$${usd(Math.abs(net))}`, ...(net > 0 ? { color: 'buy' as const } : net < 0 ? { color: 'sell' as const } : {}) });
    } else lines.push({ label: t('Volume'), text: `$${usd(v)}` });
    if (rows.total > 0) lines.push({ label: words.share, text: `${(v / rows.total * 100).toFixed(1)} %` });
    if (split && rows.buyN && rows.sellN && rows.counted > 0) {
      lines.push({ label: t('Orders begun here'), text: t('{buys} buys · {sells} sells', { buys: (rows.buyN[index] ?? 0).toLocaleString('en-US'), sells: (rows.sellN[index] ?? 0).toLocaleString('en-US') }) });
      if (rows.counted < rows.minutes) lines.push({ text: t('Orders are counted for {n} of the {total} minutes.', { n: rows.counted, total: rows.minutes }), color: 'muted', wrap: true });
    }
  }
  if (where) lines.push({ label: t('Profile'), text: where, rule: true });
  if (rows.partial && rows.recordedSince !== null) lines.push({ text: t('Recorded since {time}: the window reaches back further than the recording.', { time: when(rows.recordedSince) }), color: 'muted', wrap: true });
  return lines;
}

/** The row under a price, or -1 outside the rows. */
export const tradedRowAt = (rows: TradedRows, price: number): number => { const i = Math.floor(price / rows.step) - rows.bin0; return i >= 0 && i < rows.buy.length ? i : -1; };

/** The first side less the second over the whole window (bought less sold, for traded volume). */
export function tradedNet(rows: TradedRows): number { let net = 0; for (let i = 0; i < rows.buy.length; i++) net += rows.buy[i]! - rows.sell[i]!; return net; }

const share = (x: number): string => `${(x * 100).toFixed(1)} %`;
const signedUsd = (x: number): string => `${x > 0 ? '+' : x < 0 ? '−' : ''}$${usd(Math.abs(x))}`;
/** The column header's line under its total: the difference of the two sides, and that as a share of the total. */
export const tradedNetLine = (rows: TradedRows): string => { const net = tradedNet(rows); return `Δ ${signedUsd(net)} · ${share(rows.total > 0 ? net / rows.total : 0)}`; };

/**
 * What the box over the column's header says of its whole window: the two sides and their difference, the point of control and the value
 * area with its width, the window's weighted mean and median prices, how much of it lies above and below the point of control, and where
 * the price `mark` is now. Numbers only: the shape of the distribution is read from them (most of it above the point of control: it built
 * upward), not named. `title` names the window.
 */
export function tradedFigures(rows: TradedRows, levels: ValueLevels | null, mark: number, title: string, words: ColumnWords = VOLUME_WORDS, note: string | null = null, split = true): InfoLine[] {
  const lines: InfoLine[] = [{ text: title, bold: true }];
  if (!(rows.total > 0)) { lines.push({ text: words.none, color: 'muted', wrap: true }); return lines; }
  const mid = (i: number): number => (rows.bin0 + i + 0.5) * rows.step, at = (price: number): string => fmtPrice(price, rows.step);
  let buy = 0, sell = 0, weighted = 0;
  for (let i = 0; i < rows.buy.length; i++) { const b = rows.buy[i]!, s = rows.sell[i]!; buy += b; sell += s; weighted += mid(i) * (b + s); }
  const net = buy - sell;
  if (split) {
    lines.push({ label: words.buy, text: `$${usd(buy)}`, color: 'buy' }, { label: words.sell, text: `$${usd(sell)}`, color: 'sell' },
      { label: words.net, text: `${signedUsd(net)} · ${share(net / rows.total)}`, ...(net > 0 ? { color: 'buy' as const } : net < 0 ? { color: 'sell' as const } : {}) });
  } else lines.push({ label: t('Volume'), text: `$${usd(rows.total)}` });
  // The median: the row where the running total, from the lowest price up, first reaches half of it.
  let run = 0, median = mid(0);
  for (let i = 0; i < rows.buy.length; i++) { run += rows.buy[i]! + rows.sell[i]!; if (run >= rows.total / 2) { median = mid(i); break; } }
  if (levels) {
    const width = levels.vah - levels.val;
    lines.push({ label: t('Point of control'), text: at(levels.poc), rule: true }, { label: t('Value area'), text: `${at(levels.val)} – ${at(levels.vah)}` },
      { label: t('Value area width'), text: `$${usd(width)} · ${(width / ((levels.vah + levels.val) / 2) * 100).toFixed(2)} %` });
  }
  lines.push({ label: t('Weighted mean price'), text: at(weighted / rows.total), ...(levels ? {} : { rule: true }) }, { label: t('Median price'), text: at(median) });
  // Either side of the point of control's row: the levels' where they are worked out, else the column's own largest row.
  const pocRow = levels ? tradedRowAt(rows, levels.poc) : rows.poc;
  if (pocRow >= 0) {
    let above = 0, below = 0;
    for (let i = 0; i < rows.buy.length; i++) { const v = rows.buy[i]! + rows.sell[i]!; if (i > pocRow) above += v; else if (i < pocRow) below += v; }
    lines.push({ label: t('Above the point of control'), text: share(above / rows.total) }, { label: t('Below the point of control'), text: share(below / rows.total) });
  }
  if (mark > 0) {
    const where = !levels ? '' : Math.abs(mark - levels.poc) < rows.step / 2 ? t('Point of control') : mark > levels.vah ? t('Above the value area') : mark < levels.val ? t('Below the value area') : t('In the value area');
    lines.push({ label: t('Price now'), text: where ? `${fmtPrice(mark)} · ${where}` : fmtPrice(mark), rule: true });
  }
  if (note) lines.push({ text: note, color: 'muted', wrap: true, rule: true });
  return lines;
}
