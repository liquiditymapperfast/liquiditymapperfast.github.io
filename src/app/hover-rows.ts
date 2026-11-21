/**
 * What the map's column boxes say when you point at them (Karl's pick of 2026-11-20 from the hover-box proposal): the profile column's box
 * leads with the row under the pointer (its prices, its size and the two books holding most of it), then compares the band from the price to
 * the pointer with its mirror and says how many books send data that far; the liquidation column's card says what stands in the row; the seam
 * weighs the book against the levels per side. Pure: the map finds the figures (`HeatPane`), these say them.
 */
import type { InfoLine, InfoRun } from './infobox.ts';
import { t } from './i18n.ts';
import { price as fmtPrice, usd } from './format.ts';
import { coverage, pastReach, type Grouped } from './panes/levels-data.ts';
import type { LevelsFrame } from './wire.ts';
import { venueLabel } from './venues.ts';
import type { LevelsKind } from './liq-levels.ts';
import { countLabel, sideTitle, splitText, topLabel } from './liq-words.ts';

const dollars = (value: number): string => `$${usd(value)}`;

/** How long the profile column's box keeps a row's reading while the pointer stays on it: a row near the price changes its total two or three times a second (measured 2026-11-20), too fast to read. */
export const ROW_HOLD_MS = 1000;

/** A reading kept for `ms` while its key stays the same; another key, or the time up, reads it again at once. */
export class Held<T> {
  #key = ''; #at = -Infinity; #value: T | null = null;
  constructor(readonly ms: number) {}
  get(key: string, now: number, make: () => T): T {
    if (this.#value !== null && key === this.#key && now - this.#at < this.ms) return this.#value;
    this.#value = make(); this.#key = key; this.#at = now;
    return this.#value;
  }
}

/** A ratio as the boxes print it, two decimals below ten and one above ("1.04×"); a dash where the side divided by holds nothing. */
export function ratioWords(top: number, bottom: number): string {
  if (!(bottom > 0)) return '–';
  const r = top / bottom;
  return `${r >= 10 ? r.toFixed(1) : r.toFixed(2)}×`;
}

/** Whole percentages of `values` out of `total` that add up to 100 (the largest remainders take the points rounding leaves over). */
export function wholeShares(values: readonly number[], total: number): number[] {
  if (!(total > 0)) return values.map(() => 0);
  const raw = values.map(v => v / total * 100), out = raw.map(Math.floor);
  let left = 100 - out.reduce((s, x) => s + x, 0);
  for (const [, i] of raw.map((r, i) => [r - out[i]!, i] as const).sort((a, b) => b[0] - a[0])) { if (left <= 0) break; out[i]!++; left--; }
  return out;
}

/** The profile column's row under the pointer: its side, its prices [lo, hi), its total and the two books holding most of it. */
export interface DepthRow { side: 'bid' | 'ask'; lo: number; hi: number; total: number; top: { id: string; usd: number }[]; rest: number }

/** The row at bin `i` of `g` (inside the grouping) on `side`, read from the grouping the column is drawn from. */
export function depthRow(g: Grouped, i: number, side: 'bid' | 'ask'): DepthRow {
  const rows = side === 'bid' ? g.bid : g.ask, lo = (g.bin0 + i) * g.step;
  const per = g.ids.map((id, k) => ({ id, usd: rows[k]![i] ?? 0 })).filter(x => x.usd > 0).sort((a, b) => b.usd - a.usd);
  const total = per.reduce((s, x) => s + x.usd, 0), top = per.slice(0, 2);
  return { side, lo, hi: lo + g.step, total, top, rest: Math.max(0, total - top.reduce((s, x) => s + x.usd, 0)) };
}

/** The frame's books by instrument, made once a frame. */
const bookMaps = new WeakMap<LevelsFrame, Map<string, LevelsFrame['books'][number]>>();
function bookOf(frame: LevelsFrame, id: string): LevelsFrame['books'][number] | undefined {
  let map = bookMaps.get(frame);
  if (!map) { map = new Map(frame.books.map(b => [b.id, b])); bookMaps.set(frame, map); }
  return map.get(id);
}

/**
 * How many of the books `ids` send data as far as the row [rowLo, rowLo + step) on `side`: a book whose data stops nearer the price
 * (`pastReach`) does not count, nor one with no levels. It counts what the feeds reach, not which books hold orders in the row.
 */
export function booksReaching(frame: LevelsFrame, ids: readonly string[], mark: number, rowLo: number, step: number, side: 'bid' | 'ask'): number {
  let n = 0;
  for (const id of ids) { const cover = coverage(bookOf(frame, id), mark); if (cover && !pastReach(cover, rowLo, step, side === 'ask')) n++; }
  return n;
}

/**
 * The row's two lines: its side, prices and size; then the two books holding most of it, each with its mark and share, and everyone else's
 * share (the shares add up to 100). An empty row says its size alone.
 */
export function depthRowLines(row: DepthRow, step: number, name: (id: string) => string = venueLabel): InfoLine[] {
  const sideWord = row.side === 'ask' ? t('Asks') : t('Bids'), span = ` ${fmtPrice(row.lo, step)}–${fmtPrice(row.hi, step)} · `;
  const head: InfoRun[] = [{ text: sideWord, color: row.side === 'ask' ? 'above' : 'below', bold: true }, { text: span, bold: true }, { text: dollars(row.total), bold: true, value: true }];
  const lines: InfoLine[] = [{ text: head.map(r => r.text).join(''), runs: head }];
  if (!(row.total > 0) || !row.top.length) return lines;
  const shares = wholeShares([...row.top.map(x => x.usd), row.rest], row.total);
  const runs: InfoRun[] = [];
  row.top.forEach((x, k) => {
    if (k) runs.push({ text: '   ', gap: true });
    runs.push({ text: `${name(x.id)} `, mark: x.id }, { text: `${shares[k]}%`, value: true });
  });
  if (row.rest > 0 && shares[row.top.length]! > 0) runs.push({ text: '   ', gap: true }, { text: `${t('others')} `, color: 'muted' }, { text: `${shares[row.top.length]}%`, value: true, color: 'muted' });
  lines.push({ text: runs.map(r => r.text).join(''), runs, wrap: true });
  return lines;
}

/** How many books send data as far as the row under the pointer (Mirror off, or the price's own row, which has no band). */
export function depthHereLine(count: number, of: number): InfoLine {
  return { text: t('Depth coverage here: {count}/{n} books', { count: String(count), n: String(of) }), color: 'muted' };
}

/** The band from the price to the pointer and its mirror: bids over asks in one fixed order, their totals where no pill shows them, and how far the feeds reach. */
export interface DepthBand { bid: number; ask: number; pct: string; reach: { bid: number; ask: number; of: number }; totals: boolean; clipped: boolean }

export function depthBandLines(b: DepthBand): InfoLine[] {
  const lines: InfoLine[] = [{ text: t('Within ≈±{pct}: bids / asks {ratio}', { pct: b.pct, ratio: ratioWords(b.bid, b.ask) }) }];
  if (b.totals) {
    const runs: InfoRun[] = [{ text: `${t('Bids')} `, color: 'below' }, { text: dollars(b.bid), color: 'below', value: true }, { text: '  ·  ', color: 'muted' },
      { text: `${t('Asks')} `, color: 'above' }, { text: dollars(b.ask), color: 'above', value: true }];
    lines.push({ text: runs.map(r => r.text).join(''), runs });
  }
  lines.push({ text: t('Depth coverage: bids {bids}/{n} · asks {asks}/{n}', { bids: String(b.reach.bid), asks: String(b.reach.ask), n: String(b.reach.of) }), color: 'muted' });
  if (b.clipped) lines.push({ text: t('part of the range is outside the data'), color: 'muted' });
  return lines;
}

/**
 * What the liquidation column's card says for the row [lo, hi) under the pointer: the side's levels and the row's prices, what still stands
 * there (and for Liq + stops its two parts), how many positions or orders the snapshot puts there and the largest, then the band from the
 * price to the pointer and its mirror as longs over shorts, with their totals where no pill shows them (a phone's strip).
 */
export interface LiqCard { kind: LevelsKind; side: 'long' | 'short'; lo: number; hi: number; step: number; level: number; split: { liq: number; stops: number } | null; positions: number; top: number; below: number; above: number; pct: string; totals: boolean }

export function liqCardLines(f: LiqCard): InfoLine[] {
  // In the side's colour as the column draws it: `below` for the levels under the price, `above` for those over it (the box's colours follow
  // the column's, take profits on their own included).
  const color = f.side === 'long' ? 'below' : 'above', title = sideTitle(f.kind, f.side), span = ` ${fmtPrice(f.lo, f.step)}–${fmtPrice(f.hi, f.step)}`;
  const lines: InfoLine[] = [{ text: title + span, runs: [{ text: title, color, bold: true }, { text: span, bold: true }] }, { label: t('At this level'), text: dollars(f.level), bold: true }];
  if (f.split && f.level > 0) lines.push({ text: splitText(f.split, f.level), color: 'muted', wrap: true });
  if (f.positions > 0) lines.push({ label: countLabel(f.kind), text: String(f.positions) });
  if (f.top > 0 && f.level > 0) lines.push({ label: topLabel(f.kind), text: dollars(f.top) });
  lines.push({ text: t('Within ≈±{pct}: longs / shorts {ratio}', { pct: f.pct, ratio: ratioWords(f.below, f.above) }), rule: true });
  if (f.totals) {
    const runs: InfoRun[] = [{ text: `${t('Longs')} `, color: 'below' }, { text: dollars(f.below), color: 'below', value: true }, { text: '  ·  ', color: 'muted' },
      { text: `${t('Shorts')} `, color: 'above' }, { text: dollars(f.above), color: 'above', value: true }];
    lines.push({ text: runs.map(r => r.text).join(''), runs });
  }
  return lines;
}

/**
 * The seam's box: the book against the levels from the price out to the pointer and as far the other way, per side (the asks against what
 * would close shorts above, the bids against what would close longs below), how far the book's feeds reach, and how old the levels are next to
 * a book that is now. No verdict: a book now and an older snapshot of positions are two different things, and their ratio is not protection.
 */
export interface SeamCard { kind: LevelsKind; pct: string; above: { book: number; liq: number }; below: { book: number; liq: number }; reach: { bid: number; ask: number; of: number }; minutes: number | null }

export function seamCardLines(f: SeamCard): InfoLine[] {
  const title = f.kind === 'stops' ? t('Book against stops') : f.kind === 'both' ? t('Book against liquidations and stops') : t('Book against liquidations');
  const lines: InfoLine[] = [
    { text: `${title}, ±${f.pct}`, bold: true },
    { text: t('Above the price'), bold: true, rule: true },
    { label: t('Asks'), text: dollars(f.above.book), color: 'above' },
    { label: sideTitle(f.kind, 'short'), text: dollars(f.above.liq), color: 'buy' },
    { text: t('Below the price'), bold: true, rule: true },
    { label: t('Bids'), text: dollars(f.below.book), color: 'below' },
    { label: sideTitle(f.kind, 'long'), text: dollars(f.below.liq), color: 'sell' },
    { text: t('Depth coverage: bids {bids}/{n} · asks {asks}/{n}', { bids: String(f.reach.bid), asks: String(f.reach.ask), n: String(f.reach.of) }), color: 'muted', rule: true },
  ];
  if (f.minutes !== null && Number.isFinite(f.minutes)) {
    const minutes = String(Math.max(0, Math.round(f.minutes)));
    lines.push({ text: f.kind === 'liq' ? t('Positions: {minutes} min ago · book: now', { minutes }) : f.kind === 'both' ? t('Positions and orders: {minutes} min ago · book: now', { minutes })
      : t('Orders: {minutes} min ago · book: now', { minutes }), color: 'muted' });
  }
  return lines;
}
