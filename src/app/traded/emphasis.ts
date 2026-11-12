import type { ProfileAnswer } from '../../shared/footprint.ts';
import type { Palette } from '../theme.ts';
import { scaledUsd } from '../coin.ts';

/**
 * Which side of a split bar was the stronger, drawn so it shows (Karl, 2026-10-20): the stronger side brighter, the weaker dimmer, on a
 * smooth curve, in the profile columns, the profiles on the chart and the profile along the top alike. One pure function decides how
 * one-sided a row is and one builder makes the colours, so the three painters cannot disagree.
 *
 * One fixed scale, the same in every window and for every measure: q = (b − s) / (T + τ), T = b + s, τ = max($25k scaled to the coin, 2 % of
 * the median row of the whole answer). The τ pulls thin rows toward balance, so $10 against nothing is not drawn as one-sided; taken from the
 * median, one huge row does not mute all the others (it did when τ was 5 % of the busiest row: on real profiles almost nothing showed). The
 * curve u = min(1, |q| / 0.30), E = u²(3 − 2u) starts flat (no step at balance), gives a well-filled 52 / 48 row about 0.05 and a 60 / 40 one
 * about 0.74, and is full from about 65 / 35. Liquidations, often all one side, honestly saturate; their size is the bar's length. Order
 * counts are not used: they count orders begun over a window that may be partial.
 */

/** The smallest row at which one-sidedness counts in full, for BTC (scaled to the coin on screen, `scaledUsd`). */
export const EMPHASIS_FLOOR_USD = 25_000;
/** The share of the median row τ grows to, and the |q| at which a row is fully one-sided. */
export const MEDIAN_SHARE = 0.02, FULL_AT = 0.30;
/** The alpha the split bars are drawn at, and the weaker side's at full one-sidedness: dimmer, never gone. The stronger side rises to 1. */
export const BAR_ALPHA = 0.85, WEAK_ALPHA = 0.35;
/** How far the stronger side's lightness moves at full one-sidedness (OKLCH), toward the text colour and never past it. */
export const LIGHTNESS_LIFT = 0.12;
/** Steps of each colour ramp. */
const STEPS = 256;

/** The floor τ starts from for the coin on screen. */
export const emphasisFloor = (): number => scaledUsd(EMPHASIS_FLOOR_USD);

/**
 * How one-sided a row is, signed: positive when the first side (bid colour) was the stronger, negative for the second, 0 when balanced or
 * empty; its size is E, 0 to 1. `median` is the median row of the whole answer (`answerMedian`, `bucketsMedian`), `floorUsd` the floor of τ
 * (`emphasisFloor`).
 */
export function dominance(b: number, s: number, median: number, floorUsd: number, rest = 0): number {
  const total = b + s;
  if (!(total > 0)) return 0;
  // `rest`: a part of the bar that went to neither side (the OI pane's unsided change) counts in its size, so a bar mostly unsided leans little.
  const tau = Math.max(floorUsd, MEDIAN_SHARE * Math.max(0, median)), q = (b - s) / (total + Math.max(0, rest) + tau);
  const u = Math.min(1, Math.abs(q) / FULL_AT), e = u * u * (3 - 2 * u);
  return q > 0 ? e : q < 0 ? -e : 0;
}

/** The weaker side's alpha at one-sidedness `e` (0 to 1), from `base` (the painter's bar alpha) down to its `WEAK_ALPHA` share of it. */
export const weakAlpha = (e: number, base = BAR_ALPHA): number => base * (1 - Math.min(1, Math.max(0, e)) * (1 - WEAK_ALPHA / BAR_ALPHA));
/** The stronger side's alpha at one-sidedness `e`, from `base` up to fully opaque. */
export const strongAlpha = (e: number, base = BAR_ALPHA): number => base + (1 - base) * Math.min(1, Math.max(0, e));

/** The median of the rows that hold anything (0 when none does). */
export function medianRow(totals: Iterable<number>): number {
  const held: number[] = [];
  for (const v of totals) if (v > 0) held.push(v);
  if (!held.length) return 0;
  held.sort((a, b) => a - b);
  const mid = held.length >> 1;
  return held.length % 2 ? held[mid]! : (held[mid - 1]! + held[mid]!) / 2;
}

const medians = new WeakMap<ProfileAnswer, { step: number; median: number }>();
/**
 * The median row of a whole answer on rows of `step`, every price it holds and not only those on screen (each instrument's row goes where
 * its middle falls, as `tradedRows` puts it): what τ is taken from, so scrolling the price does not change how one-sided a row looks. Kept
 * per answer, so painting does not sort.
 */
export function answerMedian(answer: ProfileAnswer, step: number): number {
  const held = medians.get(answer);
  if (held && held.step === step) return held.median;
  const rows = new Map<number, number>();
  for (const inst of answer.instruments) for (const [low, b, s] of inst.rows) { const k = Math.floor((low + inst.step / 2) / step); rows.set(k, (rows.get(k) ?? 0) + b + s); }
  const median = medianRow(rows.values());
  medians.set(answer, { step, median });
  return median;
}

const bucketMedians = new WeakMap<object, number>();
/** The median bucket of a run of buckets (the profile along the top), kept per run. */
export function bucketsMedian(rows: { buy: ArrayLike<number>; sell: ArrayLike<number> }): number {
  let held = bucketMedians.get(rows);
  if (held === undefined) {
    const totals: number[] = [];
    for (let i = 0; i < rows.buy.length; i++) totals.push(rows.buy[i]! + rows.sell[i]!);
    held = medianRow(totals); bucketMedians.set(rows, held);
  }
  return held;
}

// ---- colour ----------------------------------------------------------------------------------------------------------------------------

const toLinear = (c: number): number => c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
const toGamma = (c: number): number => c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055;

/** #rrggbb to OKLCH (L 0 to 1, C, h in radians). */
export function oklch(hex: string): [number, number, number] {
  const n = parseInt(hex.slice(1), 16), r = toLinear((n >> 16 & 255) / 255), g = toLinear((n >> 8 & 255) / 255), b = toLinear((n & 255) / 255);
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b), m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b), s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  const L = 0.2104542553 * l + 0.7936177850 * m - 0.0040720468 * s, A = 1.9779984951 * l - 2.4285922050 * m + 0.4505937099 * s, B = 0.0259040371 * l + 0.7827717662 * m - 0.8086757660 * s;
  return [L, Math.hypot(A, B), Math.atan2(B, A)];
}

/** OKLCH to linear sRGB, which may fall outside 0 to 1. */
function linearOf(L: number, C: number, h: number): [number, number, number] {
  const A = C * Math.cos(h), B = C * Math.sin(h);
  const l = (L + 0.3963377774 * A + 0.2158037573 * B) ** 3, m = (L - 0.1055613458 * A - 0.0638541728 * B) ** 3, s = (L - 0.0894841775 * A - 1.2914855480 * B) ** 3;
  return [4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s, -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s, -0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * s];
}

/** An OKLCH colour as #rrggbb, its chroma reduced until it is inside sRGB (lightness and hue kept). */
export function hexOfOklch(L: number, C: number, h: number): string {
  const inside = (c: number): boolean => linearOf(L, c, h).every(v => v >= -1e-6 && v <= 1 + 1e-6);
  let c = C;
  if (!inside(c)) { let lo = 0, hi = C; for (let i = 0; i < 24; i++) { const mid = (lo + hi) / 2; if (inside(mid)) lo = mid; else hi = mid; } c = lo; }
  return `#${linearOf(L, c, h).map(v => Math.round(Math.min(1, Math.max(0, toGamma(Math.min(1, Math.max(0, v))))) * 255).toString(16).padStart(2, '0')).join('')}`;
}

/** The stronger side's colours, by one-sidedness from 0 to 1 in `STEPS` steps: the side's colour, its lightness moved toward the text's. */
export interface EmphasisRamps { bid: readonly string[]; ask: readonly string[] }

/**
 * One colour's ramp on a theme: away from the background (lighter on a dark theme, darker on a light one), toward the text colour and never
 * past its lightness: a side already past it (Amber's buy colour) keeps its lightness and is stronger by its alpha alone.
 */
function rampOf(p: Palette, hex: string): string[] {
  const sign = p.dark ? 1 : -1, text = oklch(p.text)[0], [L, C, h] = oklch(hex), room = Math.max(0, sign * (text - L));
  return Array.from({ length: STEPS }, (_, i) => i === 0 ? hex : hexOfOklch(Math.min(1, Math.max(0, L + sign * Math.min(room, LIGHTNESS_LIFT * i / (STEPS - 1)))), C, h));
}

const ramps = new WeakMap<Palette, EmphasisRamps>();
/** The ramps of a theme, built once and kept: painting only looks a colour up. */
export function emphasisRamps(p: Palette): EmphasisRamps {
  let held = ramps.get(p);
  if (held) return held;
  held = { bid: rampOf(p, p.bid), ask: rampOf(p, p.ask) };
  ramps.set(p, held);
  return held;
}

const candleRampsHeld = new WeakMap<Palette, EmphasisRamps>();
/** The same ramps of the theme's candle colours (the NL/NS bars are drawn in them), built once per theme and kept. */
export function candleRamps(p: Palette): EmphasisRamps {
  let held = candleRampsHeld.get(p);
  if (held) return held;
  held = { bid: rampOf(p, p.candleUp), ask: rampOf(p, p.candleDown) };
  candleRampsHeld.set(p, held);
  return held;
}

/** How each side of a split bar is drawn: its colour and its alpha. */
export interface SideStyle { color: string; alpha: number }

/**
 * Both sides' styles for a row of `b` and `s` (the bid-colour side first), with `on` the setting: the stronger side in its ramp's colour and
 * more opaque, the weaker side in its own colour, dimmer. Off, balanced or empty: both as they always were. `median` as for `dominance`.
 */
export function splitStyles(b: number, s: number, median: number, floorUsd: number, p: Palette, on: boolean, base = BAR_ALPHA): [SideStyle, SideStyle] {
  const d = on ? dominance(b, s, median, floorUsd) : 0;
  if (d === 0) return [{ color: p.bid, alpha: base }, { color: p.ask, alpha: base }];
  const e = Math.abs(d), r = emphasisRamps(p), i = Math.round(e * (STEPS - 1)), strong = strongAlpha(e, base), weak = weakAlpha(e, base);
  return d > 0 ? [{ color: r.bid[i]!, alpha: strong }, { color: p.ask, alpha: weak }] : [{ color: p.bid, alpha: weak }, { color: r.ask[i]!, alpha: strong }];
}

/**
 * Both sides' styles for a bar drawn in the candle colours, buyers (`b`) then sellers (`s`): the OI pane's NL/NS bars, whose two sides are
 * stacked in one bar, so which one made the change does not show by length alone. As `splitStyles`, with `rest` the part of the bar that went
 * to neither side: it counts in the bar's size (`dominance`), and the lean is never more than the share of the bar that has a side, so a bar
 * mostly unsided is drawn nearly even (80 % unsided leans a fifth at most, however one-sided the rest). `top`: the most the stronger side
 * rises to (a fall's bar stays lighter than a rise's, its stronger side too).
 */
export function candleSplitStyles(b: number, s: number, rest: number, median: number, floor: number, p: Palette, base: number, top = 1): [SideStyle, SideStyle] {
  const d = dominance(b, s, median, floor, rest), sided = b + s > 0 ? (b + s) / (b + s + Math.max(0, rest)) : 0;
  if (d === 0) return [{ color: p.candleUp, alpha: base }, { color: p.candleDown, alpha: base }];
  const e = Math.min(Math.abs(d), sided), r = candleRamps(p), i = Math.round(e * (STEPS - 1)), strong = base + Math.max(0, top - base) * e, weak = weakAlpha(e, base);
  return d > 0 ? [{ color: r.bid[i]!, alpha: strong }, { color: p.candleDown, alpha: weak }] : [{ color: p.candleUp, alpha: weak }, { color: r.ask[i]!, alpha: strong }];
}

/** Whether the setting applies with these bars, and why not: Delta bars draw only the difference, which already says which side won. */
export const emphasisApplies = (bars: 'split' | 'delta'): boolean => bars === 'split';
