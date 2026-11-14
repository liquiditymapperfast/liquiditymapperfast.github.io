import { contrastRatio, mixHex, textOn, type Palette } from '../theme.ts';
import { usd as fmtUsd } from '../format.ts';

/**
 * How All trades draws an order, as numbers (no page): size carried by four fixed tiers of row height and type (coin-scaled, never relative
 * to the floor, so the same order looks the same whatever is filtered) and by a continuous tint of the side's colour on a log scale of
 * dollars; text in the theme's own colour where it reads on the finished row, else black or white. Designed with Sol 6.1 and the advisor
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
export interface RowInk { bg: string; text: string; muted: string }
/** Steps of tint the inks are worked out for (cached per palette): finer than any eye tells apart. */
export const TINT_STEPS = 64;
export function rowInk(p: Palette, buy: boolean, tint: number): RowInk {
  const side = buy ? p.candleUp : p.candleDown, bg = mixHex(p.panel, side, tint);
  const text = contrastRatio(p.text, bg) >= 4.5 ? p.text : textOn(bg, 1, p);
  const muted = contrastRatio(p.muted, bg) >= 3 ? p.muted : mixHex(text, bg, 0.35);
  return { bg, text, muted };
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

/** The clock written on a row for the width: hours, minutes and seconds; minutes and seconds under 300 px; none under 250 px (it is in the hover). */
export type ClockForm = 'hms' | 'ms' | 'none';
export const clockForm = (width: number): ClockForm => width < 250 ? 'none' : width < 300 ? 'ms' : 'hms';

/** A size as the list writes it: compact from $1,000 ($1.2K, $3.4M), whole dollars under it, cents under a dollar (dust is real orders too). */
export const amountText = (usd: number): string => usd >= 999.5 ? `$${fmtUsd(Math.max(usd, 1000))}` : usd >= 1 ? `$${Math.round(usd)}` : usd >= 0.005 ? `$${usd.toFixed(2)}` : '<$0.01';
