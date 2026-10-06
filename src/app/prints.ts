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
 * Bounded: past `max` the oldest are dropped, except those in the window of history that was last asked for (`keep`): it is what is being
 * looked at, and a window that was fetched only to be trimmed away at once would be marked as covered and never fetched again.
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

  /** Drop what is over `max`: the oldest first, and what is in the kept window last (only when the window alone is more than the book holds). */
  #trim(): void {
    const over = this.items.length - this.max, keep = this.#keep, gone = new Set<Print>();
    for (const p of this.items) { if (gone.size >= over) break; if (!keep || p.t < keep.from || p.t >= keep.to) gone.add(p); }
    for (const p of this.items) { if (gone.size >= over) break; gone.add(p); }
    this.items = this.items.filter(p => !gone.has(p));
    for (const p of gone) this.#keys.delete(keyOf(p));
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
  // Every print bigger than that size stays. The places left go to those exactly as big, the newest of them first: they tie for the last
  // places, and a bigger print must never lose its place to a tie because it is older.
  let room = limit; for (const p of inside) if (p.usd > cut) room--;
  const ties = new Set<Print>();
  for (let i = inside.length - 1; i >= 0 && room > 0; i--) if (inside[i]!.usd === cut) { ties.add(inside[i]!); room--; }
  return inside.filter(p => p.usd > cut || ties.has(p));
}

/** Bubble radius in px: grows with the square root of the size, never smaller than a dot nor larger than `max`. */
export function bubbleRadius(usd: number, max = 24): number {
  return Math.min(max, Math.max(3, 3.2 * Math.sqrt(usd / 50_000)));
}
