import { contrastRatio, mixHex, textOn, type Palette } from '../theme.ts';
import { price, priceDecimals, usd as fmtUsd } from '../format.ts';

/**
 * How All trades draws an order, as numbers (no page): size carried by four fixed tiers of row height and type (coin-scaled, never relative
 * to the floor, so the same order looks the same whatever is filtered) and by a bar after the price, the square root of its dollars over
 * the floor's full size (`orderBarFull`, `rowGeom`); each row a faint tint of its side's colour; text in the theme's own colour where it
 * reads on the finished row, else black or white. Designed with Sol 6.1 and the advisor
 * (2026-11-12): size steps in type and weight and a continuous colour, without gifs, glows or flashes, on a canvas.
 */

/** A size tier: row height, the amount's size and weight (CSS px). */
export interface Tier { row: number; amountPx: number; weight: number }
/** Under $10K, $10K to $100K, $100K to the whale size, the whale size and up (BTC's dollars; scaled for a coin that trades less). */
export const TIERS: readonly Tier[] = [{ row: 24, amountPx: 13, weight: 400 }, { row: 26, amountPx: 14, weight: 600 }, { row: 30, amountPx: 15, weight: 600 }, { row: 34, amountPx: 16, weight: 700 }];
export const TIER_EDGES_USD = [10_000, 100_000] as const;
/** A divider row between two orders (where some may be missing). */
export const DIVIDER_ROW = 22;

/** The tier of an order of `usd` (absolute), the edges scaled by `scale`, `whale` already the coin's dollars. */
export function tierOf(usd: number, scale: (usd: number) => number, whale: number): number {
  const a = Math.abs(usd);
  return a >= whale ? 3 : a >= scale(TIER_EDGES_USD[1]) ? 2 : a >= scale(TIER_EDGES_USD[0]) ? 1 : 0;
}

/**
 * An order row's share of its side's colour, the same for every size: the row says buy or sell at a glance and its bar says how much
 * (Karl, 2026-11-14: the empty room between the price and the size; the size tint it replaces told size a third way, after the row's height
 * and the amount's weight, and a side-coloured bar on a strong tint of its own side faded on exactly the largest orders). Within the shares
 * every theme's text was checked to read on (up to 22 %, Sol, over the 23 palettes).
 */
export const ORDER_TINT = 0.07;
/**
 * The dollars an order's bar is full at, for the list's smallest order (store dollars, before the coin's scale): about the order one in ten
 * is larger than at that floor (fills of one market and side in a 100 ms slice merged), on BTC's busiest twenty minutes of 2026-11-13 across
 * 11 markets, rounded: $19.7K with no floor, $60.9K from $1K, $116K from $5K, $168K from $10K, $297K from $25K, $824K from $100K. The bar is
 * the square root of the dollars over this, so a median order from $1K ($6.4K) draws over a third of it; one row in ten passes it (a mark).
 */
export function orderBarFull(minUsd: number): number {
  return minUsd < 1_000 ? 20_000 : minUsd < 5_000 ? 50_000 : minUsd < 10_000 ? 100_000 : minUsd < 25_000 ? 150_000 : minUsd < 100_000 ? 250_000 : Math.max(1_000_000, minUsd * 10);
}

/** The colours of a row: its background, its text, and its quiet text (time, counts), each reading on that background. */
export interface RowInk { bg: string; text: string; muted: string; glyph: string; bar: string }
/** Steps of tint the inks are worked out for (cached per palette): finer than any eye tells apart. */
export const TINT_STEPS = 64;
export function rowInk(p: Palette, buy: boolean, tint: number): RowInk {
  const side = buy ? p.candleUp : p.candleDown, bg = mixHex(p.panel, side, tint);
  const text = contrastRatio(p.text, bg) >= 4.5 ? p.text : textOn(bg, 1, p);
  const muted = contrastRatio(p.muted, bg) >= 3 ? p.muted : mixHex(text, bg, 0.35);
  // The side's glyph (▲ ▼) in the side's colour where that reads on the row, else in the row's text colour; the size bar, 85 % of the side's
  // colour over the row, as one solid colour (drawing it needs no change of alpha).
  return { bg, text, muted, glyph: contrastRatio(side, bg) >= 3 ? side : text, bar: mixHex(bg, side, 0.85) };
}

/** A palette's inks for every tint step and side, worked out once. */
export class InkCache {
  #p: Palette | null = null; #buy: RowInk[] = []; #sell: RowInk[] = []; #top = 1;
  get(p: Palette, buy: boolean, tint: number, top: number): RowInk {
    if (p !== this.#p || top !== this.#top) { this.#p = p; this.#top = top; this.#buy = []; this.#sell = []; }
    const step = Math.max(0, Math.min(TINT_STEPS, Math.round(tint / Math.max(top, 1e-6) * TINT_STEPS)));
    const list = buy ? this.#buy : this.#sell;
    return list[step] ??= rowInk(p, buy, step / TINT_STEPS * top);
  }
}

/**
 * How many characters `price(value)` is written with, worked out without writing it (its digits are en-US: the integer digits of the value
 * rounded to its decimals, a comma for every three, the point and the decimals), so a frame can size the price column for every row it lays
 * out. Within a hair of a carry the formatter's own rounding decides (it writes 9.995 as "10.00", though the double is 9.99499...): there,
 * as for anything that is not a price (negative, not finite), the price is written and counted.
 */
export function priceWidth(value: number): number {
  // Not a price, or past what the digits are counted for (-0, NaN, infinities, 1e21 and over): written and counted.
  if (!(value > 0) || !(value < 1e21)) return price(value).length;
  const d = priceDecimals(value), x = value * 10 ** d, lo = intDigits(Math.round(x * (1 - 1e-9)), d), hi = intDigits(Math.round(x * (1 + 1e-9)), d);
  return lo !== hi ? price(value).length : lo + Math.floor((lo - 1) / 3) + (d > 0 ? d + 1 : 0);
}

/** An order row's spacing (CSS px): the edges' padding, the gap between parts, the venue mark's size and the side glyph's column. */
export const ROW_PAD = 8, ROW_GAP = 6, ROW_MARK = 14, ROW_SIDE = 10;
/** The widths an order row is laid out by (CSS px): the clock in its two forms, a digit of the clock's, the price's and the largest amount's font, and the mark past full dollars. */
export interface RowFontWidths { hms: number; ms: number; digit11: number; digit13: number; digitBig: number; more: number }
/** Where an order row's parts go at one width (CSS px), and the bar's full dollars. */
export interface RowGeom { form: ClockForm; clockW: number; xMark: number; xSide: number; xPrice: number; xBar: number; barRoom: number; xMore: number; xRight: number; full: number }
/**
 * Where an order row's parts go at width `w`. From the left: the clock, the venue mark, the side, then a price column `priceChars` wide (the
 * widest price among the rows drawn: a price's width rises by one at each power of ten and falls by three at $1, so the newest row alone
 * cannot size it). From the right: the amount, with room for the widest ("$999.9K", seven characters of the largest tier), and, where rows
 * group orders, a count before it ("×999"). Between them the bar, then the mark past its full dollars ('›') in a room of its own; no bar
 * where that leaves it under 24 px.
 */
export function rowGeom(w: number, m: RowFontWidths, group: boolean, priceChars: number, full: number): RowGeom {
  const form = clockForm(w), clockW = form === 'none' ? 0 : form === 'hms' ? m.hms : m.ms;
  const xMark = ROW_PAD + (clockW ? clockW + ROW_GAP : 0) + ROW_MARK / 2, xSide = xMark + ROW_MARK / 2 + ROW_GAP, xPrice = xSide + ROW_SIDE + ROW_GAP, xRight = w - ROW_PAD;
  const xBar = Math.round(xPrice + priceChars * m.digit13 + ROW_GAP);
  // Right to left from the amount's room: the count's room and a gap (grouping), a gap, the mark, 2 px; what is left is the bar's.
  const room = Math.floor(xRight - 7 * m.digitBig - (group ? 4 * m.digit11 + ROW_GAP : 0) - ROW_GAP - m.more - 2 - xBar);
  const barRoom = room >= 24 ? room : 0;
  return { form, clockW, xMark, xSide, xPrice, xBar, barRoom, xMore: xBar + barRoom + 2, xRight, full };
}
/** The integer digits of `units` written with `d` decimals (units of 10^-d). */
function intDigits(units: number, d: number): number {
  let n = 1;
  for (let at = 10 ** (d + 1); units >= at && n < 24; at *= 10) n++;
  return n;
}

/** The clock written on a row for the width: hours, minutes and seconds; minutes and seconds under 300 px; none under 250 px (it is in the hover). */
export type ClockForm = 'hms' | 'ms' | 'none';
export const clockForm = (width: number): ClockForm => width < 250 ? 'none' : width < 300 ? 'ms' : 'hms';

/** A size as the list writes it: compact from $1,000 ($1.2K, $3.4M), whole dollars under it, cents under a dollar (dust is real orders too). */
export const amountText = (usd: number): string => usd >= 999.5 ? `$${fmtUsd(Math.max(usd, 1000))}` : usd >= 1 ? `$${Math.round(usd)}` : usd >= 0.005 ? `$${usd.toFixed(2)}` : '<$0.01';
