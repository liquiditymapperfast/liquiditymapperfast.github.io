import { price as fmtPrice } from './format.ts';
import { t } from './i18n.ts';
import { scaledUsd } from './coin.ts';

/**
 * One large market order as the server sends it: [time ms, instrument id, side, price, USD notional], and for an order of several fills
 * also [..., lowest price, highest price, fills]. The price is the volume-weighted price of its fills.
 */
export type WirePrint = [number, string, 'buy' | 'sell', number, number] | [number, string, 'buy' | 'sell', number, number, number, number, number];
/** A large market order: `lo`, `hi` and `n` only for one of several fills (prints recorded before orders were rebuilt have none). */
export interface Print { t: number; id: string; side: 'buy' | 'sell'; price: number; usd: number; lo?: number; hi?: number; n?: number }

/**
 * Check one wire row: five fields of the right kinds, otherwise null (a malformed row is dropped, never drawn). The span and the fill count
 * are kept only when they are whole and hold the price; a row without them (or with broken ones) is a print of one fill.
 */
export function fromWire(row: unknown): Print | null {
  if (!Array.isArray(row) || row.length < 5) return null;
  const [t, id, side, price, usd, lo, hi, n] = row as unknown[];
  if (typeof t !== 'number' || !Number.isFinite(t) || typeof id !== 'string' || (side !== 'buy' && side !== 'sell')
    || typeof price !== 'number' || !(price > 0) || typeof usd !== 'number' || !(usd > 0)) return null;
  const spanned = typeof lo === 'number' && typeof hi === 'number' && typeof n === 'number' && Number.isInteger(n) && n >= 2 && lo > 0 && hi >= lo
    && price >= lo * (1 - 1e-9) && price <= hi * (1 + 1e-9);
  return spanned ? { t, id, side, price, usd, lo, hi, n } : { t, id, side, price, usd };
}

const keyOf = (p: Print): string => `${p.t}|${p.id}|${p.price}|${p.usd}`;

/**
 * Large trades held for drawing, oldest first, without duplicates (a window fetched from history and the live stream overlap).
 * Bounded: past `max` the oldest are dropped, except those in the window of history that was last asked for (`keep`): it is what is being
 * looked at, and a window that was fetched only to be trimmed away at once would be marked as covered and never fetched again. When that
 * window alone holds more, its smallest go (the map draws the largest in view).
 */
export class PrintBook {
  items: Print[] = [];
  #keys = new Set<string>();
  #keep: { from: number; to: number } | null = null;
  /** Bumped whenever the contents change, so a painter can tell its cache is stale. */
  version = 0;
  constructor(private max = 20_000) {}

  /** Add prints; returns the ones that were new. `keep` is the window of history these were fetched for. */
  add(prints: Iterable<Print>, keep?: { from: number; to: number }): Print[] {
    if (keep) this.#keep = keep;
    const fresh: Print[] = [];
    for (const p of prints) { const key = keyOf(p); if (this.#keys.has(key)) continue; this.#keys.add(key); fresh.push(p); }
    if (!fresh.length) return fresh;
    const last = this.items[this.items.length - 1];
    fresh.sort((a, b) => a.t - b.t);
    if (last && fresh[0]!.t < last.t) { this.items = [...this.items, ...fresh].sort((a, b) => a.t - b.t); } else this.items.push(...fresh);
    if (this.items.length > this.max) this.#trim();
    this.version++;
    return fresh;
  }

  /** Drop what is over `max`: the oldest outside the kept window first, then the smallest inside it (only when the window alone is more than the book holds). */
  #trim(): void {
    const over = this.items.length - this.max, keep = this.#keep, gone = new Set<Print>();
    for (const p of this.items) { if (gone.size >= over) break; if (!keep || p.t < keep.from || p.t >= keep.to) gone.add(p); }
    if (gone.size < over) for (const p of [...this.items].filter(p => !gone.has(p)).sort((a, b) => a.usd - b.usd || a.t - b.t)) { if (gone.size >= over) break; gone.add(p); }
    this.items = this.items.filter(p => !gone.has(p));
    for (const p of gone) this.#keys.delete(keyOf(p));
  }
}

/**
 * The prints worth drawing in a window (`items` in time order): inside it, not `hidden` (a venue switched off, under the smallest size, the
 * side not shown), and only the `limit` largest of those, returned oldest first. Zoomed far out there are far more prints than pixels;
 * keeping the biggest is what keeps the picture about size. The filter comes first, so the places go to prints that are drawn.
 */
export function topPrints(items: readonly Print[], t0: number, t1: number, p0: number, p1: number, limit: number, hidden: (p: Print) => boolean = () => false): Print[] {
  // `items` is in time order (PrintBook keeps it so): find the window by bisection instead of scanning every print each frame.
  let lo = 0, hi = items.length;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (items[mid]!.t < t0) lo = mid + 1; else hi = mid; }
  const inside: Print[] = [];
  for (let i = lo; i < items.length; i++) {
    const p = items[i]!;
    if (p.t > t1) break;
    if (p.price >= p0 && p.price <= p1 && !hidden(p)) inside.push(p);
  }
  if (inside.length <= limit) return inside;
  // The size of the limit-th largest print, found with a native typed-array sort rather than a comparator sort of objects.
  const sizes = Float64Array.from(inside, p => p.usd).sort();
  const cut = sizes[sizes.length - limit]!;
  // Every print bigger than that size stays. The places left go to those exactly as big, the newest of them first: they tie for the last
  // places, and a bigger print must never lose its place to a tie because it is older.
  let room = limit; for (const p of inside) if (p.usd > cut) room--;
  const ties = new Set<Print>();
  for (let i = inside.length - 1; i >= 0 && room > 0; i--) if (inside[i]!.usd === cut) { ties.add(inside[i]!); room--; }
  return inside.filter(p => p.usd > cut || ties.has(p));
}

/**
 * The price lines of a bubble's box: a print of one fill has its price; an order of several fills has the average price of its fills, how
 * many there were, and the prices it reached when they differ (an order that walked the book).
 */
export function printPriceLines(print: Print): { label: string; text: string }[] {
  if (print.n === undefined || print.lo === undefined || print.hi === undefined) return [{ label: t('Price'), text: fmtPrice(print.price) }];
  const lines = [{ label: t('Average price'), text: fmtPrice(print.price) }, { label: t('Fills'), text: String(print.n) }];
  if (fmtPrice(print.hi) !== fmtPrice(print.lo)) lines.push({ label: t('Prices reached'), text: `${fmtPrice(print.lo)} – ${fmtPrice(print.hi)}` });
  return lines;
}

/** The radius of the largest bubble in view, and of the smallest any bubble is drawn at (a dot), in px before the size setting. */
export const BUBBLE_MAX_R = 26, BUBBLE_MIN_R = 3;
/**
 * Bubble radius in px: its area in proportion to the order's size, the largest drawn (`largest`, USD) at BUBBLE_MAX_R, never smaller than a
 * dot. Sizes are compared with the bubbles in view, not with a fixed scale: zoomed out, the bubbles drawn are the largest of hours of
 * trading (millions each), and a fixed scale had capped them all at one size, so size said nothing.
 */
export function bubbleRadius(usd: number, largest: number): number {
  if (!(largest > 0) || !(usd > 0)) return BUBBLE_MIN_R;
  return Math.max(BUBBLE_MIN_R, BUBBLE_MAX_R * Math.sqrt(Math.min(1, usd / largest)));
}

/**
 * How the trade bubbles are drawn: the smallest order and the side shown, a size factor (every radius times it, so their proportions stay),
 * how solid they are, and whether bubbles big enough to hold it carry their size written in them. They change only the bubbles: sounds and
 * the flow column's dots keep their own sizes.
 */
export interface BubbleSettings { minUsd: number; side: 'both' | 'buy' | 'sell'; scale: number; opacity: number; labels: boolean }
/** The smallest orders a person can choose to see: the recording keeps every one from $25,000. */
export const BUBBLE_MINIMUMS: readonly number[] = [25_000, 50_000, 100_000, 250_000, 500_000, 1_000_000, 2_500_000];
export const BUBBLE_DEFAULTS: Readonly<BubbleSettings> = { minUsd: 25_000, side: 'both', scale: 1, opacity: 0.5, labels: false };
export const BUBBLE_LIMITS = { scale: { min: 0.5, max: 2, step: 0.1 }, opacity: { min: 0.1, max: 0.9, step: 0.05 } } as const;

/** Saved settings, each field checked (anything else is the default; a minimum that is not one of the choices is the nearest under it). */
export function readBubbles(saved: unknown): BubbleSettings {
  const s = (saved ?? {}) as Partial<BubbleSettings>, d = BUBBLE_DEFAULTS, L = BUBBLE_LIMITS;
  const within = (v: unknown, lo: number, hi: number, step: number, fallback: number): number =>
    typeof v === 'number' && Number.isFinite(v) ? Math.round(Math.min(hi, Math.max(lo, v)) / step) * step : fallback;
  const min = typeof s.minUsd === 'number' && Number.isFinite(s.minUsd) ? [...BUBBLE_MINIMUMS].reverse().find(m => m <= s.minUsd!) ?? d.minUsd : d.minUsd;
  return {
    minUsd: min,
    side: s.side === 'buy' || s.side === 'sell' ? s.side : 'both',
    scale: Number(within(s.scale, L.scale.min, L.scale.max, L.scale.step, d.scale).toFixed(1)),
    opacity: Number(within(s.opacity, L.opacity.min, L.opacity.max, L.opacity.step, d.opacity).toFixed(2)),
    labels: typeof s.labels === 'boolean' ? s.labels : d.labels,
  };
}

/** Whether a print is left out by the settings: under the smallest order shown, or on the side that is not. */
export const bubbleHidden = (p: Print, s: BubbleSettings): boolean => p.usd < scaledUsd(s.minUsd) || (s.side !== 'both' && p.side !== s.side);
