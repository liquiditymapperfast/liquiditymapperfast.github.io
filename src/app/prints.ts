/** One large executed trade as the server sends it: [time ms, instrument id, side, price, USD notional]. */
export type WirePrint = [number, string, 'buy' | 'sell', number, number];
export interface Print { t: number; id: string; side: 'buy' | 'sell'; price: number; usd: number }

/** Check one wire row: five fields of the right kinds, otherwise null (a malformed row is dropped, never drawn). */
export function fromWire(row: unknown): Print | null {
  if (!Array.isArray(row) || row.length < 5) return null;
  const [t, id, side, price, usd] = row as unknown[];
  if (typeof t !== 'number' || !Number.isFinite(t) || typeof id !== 'string' || (side !== 'buy' && side !== 'sell')
    || typeof price !== 'number' || !(price > 0) || typeof usd !== 'number' || !(usd > 0)) return null;
  return { t, id, side, price, usd };
}

const keyOf = (p: Print): string => `${p.t}|${p.id}|${p.price}|${p.usd}`;

/**
 * Large trades held for drawing, oldest first, without duplicates (a window fetched from history and the live stream overlap).
 * Bounded: the oldest are dropped past `max`.
 */
export class PrintBook {
  items: Print[] = [];
  #keys = new Set<string>();
  /** Bumped whenever the contents change, so a painter can tell its cache is stale. */
  version = 0;
  constructor(private max = 20_000) {}

  /** Add prints; returns the ones that were new. */
  add(prints: Iterable<Print>): Print[] {
    const fresh: Print[] = [];
    for (const p of prints) { const key = keyOf(p); if (this.#keys.has(key)) continue; this.#keys.add(key); fresh.push(p); }
    if (!fresh.length) return fresh;
    const last = this.items[this.items.length - 1];
    fresh.sort((a, b) => a.t - b.t);
    if (last && fresh[0]!.t < last.t) { this.items = [...this.items, ...fresh].sort((a, b) => a.t - b.t); } else this.items.push(...fresh);
    if (this.items.length > this.max) { for (const gone of this.items.splice(0, this.items.length - this.max)) this.#keys.delete(keyOf(gone)); }
    this.version++;
    return fresh;
  }
}

/**
 * The prints worth drawing in a window (`items` in time order): inside it, from venues that are shown, and only the `limit` largest, returned oldest first.
 * Zoomed far out there are far more prints than pixels; keeping the biggest is what keeps the picture about size.
 */
export function topPrints(items: readonly Print[], t0: number, t1: number, p0: number, p1: number, limit: number, hidden: (id: string) => boolean = () => false): Print[] {
  // `items` is in time order (PrintBook keeps it so): find the window by bisection instead of scanning every print each frame.
  let lo = 0, hi = items.length;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (items[mid]!.t < t0) lo = mid + 1; else hi = mid; }
  const inside: Print[] = [];
  for (let i = lo; i < items.length; i++) {
    const p = items[i]!;
    if (p.t > t1) break;
    if (p.price >= p0 && p.price <= p1 && !hidden(p.id)) inside.push(p);
  }
  if (inside.length <= limit) return inside;
  // The size of the limit-th largest print, found with a native typed-array sort rather than a comparator sort of objects.
  const sizes = Float64Array.from(inside, p => p.usd).sort();
  const cut = sizes[sizes.length - limit]!;
  const kept = inside.filter(p => p.usd >= cut);
  return kept.length > limit ? kept.slice(kept.length - limit) : kept;   // among equal sizes the newest stay
}

/** Bubble radius in px: grows with the square root of the size, never smaller than a dot nor larger than `max`. */
export function bubbleRadius(usd: number, max = 24): number {
  return Math.min(max, Math.max(3, 3.2 * Math.sqrt(usd / 50_000)));
}
