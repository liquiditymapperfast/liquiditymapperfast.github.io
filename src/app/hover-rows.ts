/**
 * What the map's column boxes say when you point at them (Karl's pick of 2026-11-20 from the hover-box proposal): the profile column's box
 * leads with the row under the pointer (its prices, its size and the two books holding most of it), then compares the band from the price to
 * the pointer with its mirror and says how many books send data that far; the liquidation column's card says what stands in the row; the seam
 * weighs the book against the levels per side. Pure: the map finds the figures (`HeatPane`), these say them.
 */
import type { InfoColor, InfoLine, InfoRun } from './infobox.ts';
import { t } from './i18n.ts';
import { price as fmtPrice, usd } from './format.ts';
import { coverage, cumulative, pastReach, type Grouped } from './panes/levels-data.ts';
import type { LevelsFrame } from './wire.ts';
import { venueLabel } from './venues.ts';
import type { LevelsKind } from './liq-levels.ts';
import { countLabel, sideTitle, splitText, topLabel } from './liq-words.ts';
import { BALANCED_RATIO } from './mirror.ts';

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

/**
 * A ratio as the boxes print it, two decimals below ten and one up to a thousand ("1.04×", "13.0×"), and no more digits past that ("≥1000×":
 * a side all but empty against a full one printed sixteen of them and widened the box); a dash where the side divided by holds nothing.
 */
export function ratioWords(top: number, bottom: number): string {
  if (!(bottom > 0)) return '–';
  const r = top / bottom;
  return r >= 1000 ? '≥1000×' : `${r >= 10 ? r.toFixed(1) : r.toFixed(2)}×`;
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

/**
 * The profile column's Mirror band: from the price to the pointer's row `hb` (a bin of the view's grouping `g`) and as far the other way, its
 * running totals from the price and its two far rows (`loBin`, `hiBin`, bins of `grid`). Where the price's row or the mirror's lies outside
 * the view's grouping (the price scrolled away), from `spanned()`, a grouping that holds both (`groupSpan`), so the totals count from the
 * price, not from the view's edge; where that is refused (too many rows for one grouping), from the view's, clamped and `clipped`. Null on
 * the price's own row, which has no band.
 */
export interface DepthBandGrid { grid: Grouped; above: number; below: number; markBin: number; hoverBin: number; loBin: number; hiBin: number; clipped: boolean }

export function depthBand(g: Grouped, mark: number, hb: number, spanned: () => Grouped | null): DepthBandGrid | null {
  const step = g.step, markBin = Math.floor(mark / step) - g.bin0;
  if (hb === markBin) return null;
  const outside = (n: number, i: number): boolean => i < 0 || i >= n;
  let G = g, hB = hb, mB = markBin;
  if (outside(g.nBins, markBin) || outside(g.nBins, 2 * markBin - hb)) {
    const s = spanned();
    if (s) { G = s; hB = hb + g.bin0 - s.bin0; mB = Math.floor(mark / step) - s.bin0; }
  }
  const mb = 2 * mB - hB, cum = cumulative(G, mark), clamp = (i: number): number => Math.max(0, Math.min(G.nBins - 1, i));
  return { grid: G, above: cum.ask[clamp(hB > mB ? hB : mb)] ?? 0, below: cum.bid[clamp(hB > mB ? mb : hB)] ?? 0, markBin: mB, hoverBin: hB,
    loBin: Math.min(hB, mb), hiBin: Math.max(hB, mb), clipped: outside(G.nBins, mb) || outside(G.nBins, mB) };
}

/** How many books send data as far as the row under the pointer (Mirror off, or the price's own row, which has no band). */
export function depthHereLine(count: number, of: number): InfoLine {
  return { text: t('Depth coverage here: {count}/{n} books', { count: String(count), n: String(of) }), color: 'muted' };
}

/** The band from the price to the pointer and its mirror: which side is heavier and by how much (`depthBandVerdict`), their totals where no pill shows them, and how far the feeds reach. */
export interface DepthBand { bid: number; ask: number; pct: string; reach: { bid: number; ask: number; of: number }; totals: boolean; clipped: boolean }

/**
 * The band's two sides in one line: the heavier named, in its colour, with how many times the other it is ("bids 1.41× the asks"); about even
 * under the Mirror's balance (`BALANCED_RATIO`, as the order book's box says Balanced); only one side where the other holds nothing. Karl,
 * 2026-11-21: a ratio in one fixed order ("bids / asks 0.71×", "longs / shorts 0.20×") made him work out which side leads, where the box
 * before it said so ("This side has 1.4× more"). Named by price side, never this side or that, so moving the pointer across the price
 * does not turn it over. Every case wraps: in German or Russian the sentence is wider than a phone's map leaves the box (`wrapWithin`).
 * A side not known, below zero or endless counts as nothing.
 */
export function depthBandVerdict(bid: number, ask: number, pct: string): InfoLine {
  const b = known(bid), a = known(ask);
  if (!b && !a) return { text: t('Within ≈±{pct}: no bids or asks', { pct }), color: 'muted', wrap: true };
  if (!a) return { text: t('Within ≈±{pct}: only bids', { pct }), color: 'below', bold: true, wrap: true };
  if (!b) return { text: t('Within ≈±{pct}: only asks', { pct }), color: 'above', bold: true, wrap: true };
  if (Math.max(b, a) / Math.min(b, a) < BALANCED_RATIO) return { text: t('Within ≈±{pct}: bids and asks about even', { pct }), bold: true, wrap: true };
  return b > a ? { text: t('Within ≈±{pct}: bids {ratio} the asks', { pct, ratio: ratioWords(b, a) }), color: 'below', bold: true, wrap: true }
    : { text: t('Within ≈±{pct}: asks {ratio} the bids', { pct, ratio: ratioWords(a, b) }), color: 'above', bold: true, wrap: true };
}
/** A side's amount as the verdicts weigh it: a finite amount above zero, else nothing. */
const known = (x: number): number => Number.isFinite(x) && x > 0 ? x : 0;

/** The liquidation card's band in one line, as `depthBandVerdict` says the book's: longs and shorts by whose positions (or orders) they are, each in the colour the column draws it in. */
export function liqBandVerdict(longs: number, shorts: number, pct: string, longColor: InfoColor, shortColor: InfoColor): InfoLine {
  const l = known(longs), s = known(shorts);
  if (!l && !s) return { text: t('Within ≈±{pct}: no longs or shorts', { pct }), color: 'muted', rule: true, wrap: true };
  if (!s) return { text: t('Within ≈±{pct}: only longs', { pct }), color: longColor, bold: true, rule: true, wrap: true };
  if (!l) return { text: t('Within ≈±{pct}: only shorts', { pct }), color: shortColor, bold: true, rule: true, wrap: true };
  if (Math.max(l, s) / Math.min(l, s) < BALANCED_RATIO) return { text: t('Within ≈±{pct}: longs and shorts about even', { pct }), bold: true, rule: true, wrap: true };
  return l > s ? { text: t('Within ≈±{pct}: longs {ratio} the shorts', { pct, ratio: ratioWords(l, s) }), color: longColor, bold: true, rule: true, wrap: true }
    : { text: t('Within ≈±{pct}: shorts {ratio} the longs', { pct, ratio: ratioWords(s, l) }), color: shortColor, bold: true, rule: true, wrap: true };
}

export function depthBandLines(b: DepthBand): InfoLine[] {
  const lines: InfoLine[] = [depthBandVerdict(b.bid, b.ask, b.pct)];
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
 * price to the pointer and its mirror, which side is heavier and by how much (`liqBandVerdict`), with their totals where no pill shows them (a phone's strip).
 */
/**
 * The prices the liquidation card speaks of for a pointer at `at`: the column's row (`step` wide), on the snapshot's own bins (`unit` wide,
 * `LiqLevels.step`), so what still stands, what the snapshot put there, its count and its largest all describe the same whole bins (`binsIn`
 * counts the bins starting in [lo, hi)). Where the column's row is narrower than a bin (zoomed far in), the bin itself (Sol, review 2026-11-20:
 * a prorated "$0 of $260K" beside the whole bin's "Positions 14").
 */
export function liqCardRow(at: number, step: number, unit: number): { lo: number; hi: number; kLo: number; kHi: number } | { lo: number; hi: number; kLo: null; kHi: null } {
  if (!(unit > 0)) { const lo = Math.floor(at / step) * step; return { lo, hi: lo + step, kLo: null, kHi: null }; }
  // In bin numbers, so the card reads whole bins by number (`standingBins`, `binsBetween`): a quotient a hair off a whole number (50000100.00000001,
  // 42.99999999999999) is that whole number, never the next bin up or the one before (Sol, review 2026-11-20).
  // A millionth of a bin: far above rounding error at any bin count a snapshot has (about 1e-8 at 5e7 bins), far below a real boundary
  // inside a bin (a relative tolerance grew past a whole bin at 1.7e7 bins and dropped one: Sol, review 2026-11-20).
  const whole = (q: number): number => { const r = Math.round(q); return Math.abs(q - r) <= 1e-6 ? r : Math.ceil(q); };
  const bin = (): { lo: number; hi: number; kLo: number; kHi: number } => { const k = Math.floor(at / unit); return { lo: k * unit, hi: (k + 1) * unit, kLo: k, kHi: k + 1 }; };
  if (step <= unit) return bin();
  const row = Math.floor(at / step), kLo = whole(row * step / unit), kHi = whole((row + 1) * step / unit);
  return kHi > kLo ? { lo: kLo * unit, hi: kHi * unit, kLo, kHi } : bin();
}

/**
 * The prices the seam groups where its band runs past the view: the view and the band (the price out to the pointer and as far the other way)
 * with a row to spare each side, or null where that is more rows than the liquidation profile holds (the box then says part is outside).
 * Not `groupSpan`, which mirrors about the price's row rather than the price, and so could stop up to a row short of the band's far edge.
 */
export function seamSpan(p0: number, p1: number, price: number, d: number, step: number, maxRows: number): { lo: number; hi: number } | null {
  const lo = Math.min(p0, price - d) - step, hi = Math.max(p1, price + d) + step;
  return Math.floor(hi / step) - Math.floor(lo / step) + 1 <= maxRows ? { lo, hi } : null;
}

export interface LiqCard {
  kind: LevelsKind; side: 'long' | 'short'; lo: number; hi: number; step: number;
  /** What still stands in the row, and what the snapshot put there (`total`): the count and the largest are the snapshot's. */
  level: number; total: number; split: { liq: number; stops: number } | null; positions: number; top: number;
  below: number; above: number; pct: string; totals: boolean;
  /** Liq + stops: each side's band total in its two parts (`mirrorSplits`), as the box said them before the card. */
  bandSplit: { long: string; short: string } | null;
}

export function liqCardLines(f: LiqCard): InfoLine[] {
  // In the side's colour as the column draws it: `below` for the levels under the price, `above` for those over it (the box's colours follow
  // the column's, take profits on their own included).
  const color = f.side === 'long' ? 'below' : 'above', title = sideTitle(f.kind, f.side), span = ` ${fmtPrice(f.lo, f.step)}–${fmtPrice(f.hi, f.step)}`;
  // Where price has taken part of the row, what stands of what the snapshot put there (the count and the largest below are the snapshot's,
  // so "$0" beside "Positions 14" would contradict them), as the stripe's box says it.
  const taken = usd(f.level) !== usd(f.total);
  const lines: InfoLine[] = [{ text: title + span, runs: [{ text: title, color, bold: true }, { text: span, bold: true }] },
    { label: t('At this level'), text: taken ? t('{left} of {total}', { left: dollars(f.level), total: dollars(f.total) }) : dollars(f.level), bold: true }];
  if (f.split && f.level > 0) lines.push({ text: splitText(f.split, f.level), color: 'muted', wrap: true });
  if (f.positions > 0) lines.push({ label: countLabel(f.kind), text: String(f.positions) });
  if (f.top > 0 && f.total > 0) lines.push({ label: topLabel(f.kind), text: dollars(f.top) });
  // Whose orders the band's two sides are: take profits keep the shorts' below the price (the arrays' long side) and the longs' above (Sol,
  // review 2026-11-20: the ratio of a take-profit band read them the wrong way round).
  const takes = f.kind === 'takes', longs = takes ? f.above : f.below, shorts = takes ? f.below : f.above;
  const longColor = takes ? 'above' : 'below', shortColor = takes ? 'below' : 'above';
  lines.push(liqBandVerdict(longs, shorts, f.pct, longColor, shortColor));
  if (f.bandSplit) {
    // Each side's total in its two parts: the total is in it, so it serves where no pill shows one too.
    lines.push({ label: t('Longs'), text: f.bandSplit.long, color: 'muted', wrap: true }, { label: t('Shorts'), text: f.bandSplit.short, color: 'muted', wrap: true });
  } else if (f.totals) {
    const runs: InfoRun[] = [{ text: `${t('Longs')} `, color: longColor }, { text: dollars(longs), color: longColor, value: true }, { text: '  ·  ', color: 'muted' },
      { text: `${t('Shorts')} `, color: shortColor }, { text: dollars(shorts), color: shortColor, value: true }];
    lines.push({ text: runs.map(r => r.text).join(''), runs });
  }
  return lines;
}

/**
 * The seam's box: the book against the levels from the price out to the pointer and as far the other way, per side (the asks against what
 * would close shorts above, the bids against what would close longs below), how far the book's feeds reach, and how old the levels are next to
 * a book that is now. No verdict: a book now and an older snapshot of positions are two different things, and their ratio is not protection.
 */
/** `minutes`: how old the positions and the orders are (`LiqSet.asOfs`), each null where it is not shown or not known. */
/** `clipped`: part of the band lies outside the rows that could be weighed (the price scrolled far away), so its amounts are partial. */
export interface SeamCard { kind: LevelsKind; pct: string; above: { book: number; liq: number }; below: { book: number; liq: number }; reach: { bid: number; ask: number; of: number }; minutes: { positions: number | null; orders: number | null }; clipped: boolean }

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
  if (f.clipped) lines.push({ text: t('part of the range is outside the data'), color: 'muted' });
  // How old the levels are, next to a book that is now: the positions and the orders each by their own snapshot (Liq + stops has both, and
  // the order files come less often than the positions).
  const ago = (m: number | null): string | null => m !== null && Number.isFinite(m) ? String(Math.max(0, Math.round(m))) : null;
  const positions = f.kind === 'stops' ? null : ago(f.minutes.positions), orders = f.kind === 'liq' ? null : ago(f.minutes.orders);
  const age = positions !== null && orders !== null ? t('Positions: {positions} min ago · orders: {orders} min ago · book: now', { positions, orders })
    : positions !== null ? t('Positions: {minutes} min ago · book: now', { minutes: positions }) : orders !== null ? t('Orders: {minutes} min ago · book: now', { minutes: orders }) : null;
  // Wrapped: both ages in a long language run past a phone's box (Sol, review 2026-11-20: French about 330 px).
  if (age) lines.push({ text: age, color: 'muted', wrap: true });
  return lines;
}
