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
 * The tint's stops: (dollars, share of the side's colour mixed into the panel). Quiet at the low end so a screen of small orders stays calm
 * and every theme's text reads on it (Sol computed the theme text's contrast over the 23 palettes at 4.84:1 or more up to 22%); the top end
 * (the Leviathan size of Sounds, $1.5M for BTC) chosen by eye on real orders, so the rare order stands out as a near-solid fill.
 */
export function tintStops(scale: (usd: number) => number, whale: number, leviathan: number, top: number): [number, number][] {
  // In order of size whatever the tiers of Sounds are (its Whale size may be set under $100K), and never weaker for a larger order.
  const stops: [number, number][] = [[scale(1_000), 0.02], [scale(10_000), 0.06], [scale(100_000), 0.12], [whale, 0.18], [Math.max(leviathan, whale * 1.5), top]];
  stops.sort((a, b) => a[0] - b[0]);
  for (let i = 1; i < stops.length; i++) stops[i]![1] = Math.max(stops[i]![1], stops[i - 1]![1]);
  return stops;
}
/** The share of the side's colour for an order of `usd`, interpolated in log dollars between the stops (flat beyond the ends). */
export function tintOf(usd: number, stops: readonly [number, number][]): number {
  const a = Math.abs(usd);
  if (!(a > stops[0]![0])) return stops[0]![1];
  for (let i = 1; i < stops.length; i++) {
    const [x1, y1] = stops[i]!, [x0, y0] = stops[i - 1]!;
    if (x1 <= x0) continue; // two stops at one size (a Whale size of exactly $100K): no span to interpolate over
    if (a <= x1) return y0 + (y1 - y0) * (Math.log(a / x0) / Math.log(x1 / x0));
  }
  return stops[stops.length - 1]![1];
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
