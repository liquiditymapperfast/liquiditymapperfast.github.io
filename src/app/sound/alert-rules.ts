import type { LevelsFrame } from '../wire.ts';

/**
 * The decisions behind the panel sounds, with no audio and no DOM: each is a small state machine fed a reading at a time, so a test
 * drives it with a fake clock. What reaches the ear is chosen by `alerts.ts`.
 */

/** Per-key cool-downs: a key that fired is quiet for `ms`. */
export class Cooldowns {
  readonly #at = new Map<string, number>();
  /** True (and starts the cool-down) when `key` has not fired within `ms`. */
  take(key: string, now: number, ms: number): boolean {
    const last = this.#at.get(key);
    if (last !== undefined && now - last < ms) return false;
    this.#at.set(key, now);
    if (this.#at.size > 500) for (const [k, t] of this.#at) if (now - t > 3_600_000) this.#at.delete(k);
    return true;
  }
}

/** At most `max` sounds in any `windowMs`, whatever their kind: a market that does everything at once is one busy moment, not twelve alarms. */
export class RateCap {
  readonly #times: number[] = [];
  constructor(private max: number, private windowMs: number) {}
  allow(now: number): boolean {
    while (this.#times.length && now - this.#times[0]! >= this.windowMs) this.#times.shift();
    if (this.#times.length >= this.max) return false;
    this.#times.push(now); return true;
  }
}

// ---- The order book ---------------------------------------------------------------------------------------------------------------

/** Resting liquidity of the books in `ids`, per price bin, on each side of `mark`, out to `pct` (a fraction) from it. */
export interface BookBins { bin: number; bid: Map<number, number>; ask: Map<number, number>; bidTotal: number; askTotal: number }

export function bookBins(frame: LevelsFrame | null, ids: ReadonlySet<string>, mark: number, pct: number, binBp = 2): BookBins {
  const bin = Math.max(1e-9, mark * binBp / 10_000), out: BookBins = { bin, bid: new Map(), ask: new Map(), bidTotal: 0, askTotal: 0 };
  if (!frame || !(mark > 0)) return out;
  const lo = mark * (1 - pct), hi = mark * (1 + pct);
  for (const book of frame.books) {
    if (!ids.has(book.id)) continue;
    for (const [side, map, key] of [[book.bids, out.bid, 'bidTotal'], [book.asks, out.ask, 'askTotal']] as const) {
      const n = Math.min(side.lo.length, side.hi.length, side.usd.length);
      for (let i = 0; i < n; i++) {
        const usd = side.usd[i]!, price = (side.lo[i]! + side.hi[i]!) / 2;
        if (!(usd > 0) || price < lo || price > hi) continue;
        // Bids count below the mark and asks above it: a crossed or stale level on the wrong side is not liquidity.
        if (map === out.bid ? price > mark : price < mark) continue;
        const b = Math.floor(price / bin);
        map.set(b, (map.get(b) ?? 0) + usd); out[key] += usd;
      }
    }
  }
  return out;
}

export interface Wall { price: number; usd: number }
/** The biggest bin on each side. */
export function biggest(bins: BookBins): { bid: Wall | null; ask: Wall | null } {
  const pick = (map: Map<number, number>): Wall | null => { let best: Wall | null = null; for (const [b, usd] of map) if (!best || usd > best.usd) best = { price: (b + 0.5) * bins.bin, usd }; return best; };
  return { bid: pick(bins.bid), ask: pick(bins.ask) };
}

export interface WallSignal { kind: 'appeared' | 'pulled'; side: 'buy' | 'sell'; price: number; usd: number }

/**
 * Walls on one book. A wall *appears* when the biggest bin on a side reaches `minUsd` after having been below 60 % of it, and it is
 * *pulled* when one that has stood for five seconds drops below 30 % of its size while the price has not come to it (a wall that
 * was eaten is the market doing its job, not news). Nothing sounds in the first ten seconds, while the book is still arriving.
 */
export class WallWatch {
  #start = -1;
  #armed = { buy: false, sell: false };
  #stood: { buy: (Wall & { since: number }) | null; sell: (Wall & { since: number }) | null } = { buy: null, sell: null };
  /** What the bins were made of last time (the books they came from): a change in it is not a change in the book. */
  #context = '';
  #last = -1;

  reset(): void { this.#start = -1; this.#armed = { buy: false, sell: false }; this.#stood = { buy: null, sell: null }; this.#context = ''; this.#last = -1; }

  /**
   * `context` names what the bins are made of (which books, and which instrument's price): when it changes, a venue was switched on or
   * off or one dropped out of the feed, and what looks like a wall coming or going is the set of books changing. Everything is forgotten
   * and the warm-up starts again, so nothing is called appeared or pulled on that account. The same goes for a look that comes long after the
   * one before (nothing was observed in between: a wall that went in that time was not seen going).
   */
  update(now: number, bins: BookBins, mark: number, minUsd: number, context = ''): WallSignal[] {
    if (context !== this.#context || (this.#last >= 0 && now - this.#last > 10_000)) { const known = this.#start >= 0; this.reset(); this.#context = context; if (known) this.#start = now; }
    this.#last = now;
    if (this.#start < 0) this.#start = now;
    const warm = now - this.#start >= 10_000, top = biggest(bins), out: WallSignal[] = [];
    for (const [side, wall, map] of [['buy', top.bid, bins.bid], ['sell', top.ask, bins.ask]] as const) {
      const stood = this.#stood[side];
      // The wall that has been standing is judged where it stood, whatever else the book holds: a bigger one elsewhere does not hide its going.
      if (stood && now - stood.since >= 5_000) {
        const here = map.get(Math.floor(stood.price / bins.bin)) ?? 0;
        if (here < stood.usd * 0.3) {
          // Gone from where it stood. It was pulled only if the price did not come to it: a market that reached it (within 4 bp) or passed through it traded it away.
          const crossed = side === 'buy' ? mark <= stood.price : mark >= stood.price, reached = Math.abs(mark - stood.price) / stood.price <= 0.0004;
          if (warm && !crossed && !reached) out.push({ kind: 'pulled', side, price: stood.price, usd: stood.usd });
          this.#stood[side] = null;
        }
      }
      const standing = this.#stood[side];
      if (wall && wall.usd >= minUsd) {
        if (this.#armed[side] && warm) { out.push({ kind: 'appeared', side, price: wall.price, usd: wall.usd }); this.#armed[side] = false; this.#stood[side] = { ...wall, since: now }; }
        else if (!standing && !this.#armed[side]) this.#stood[side] = { ...wall, since: now };
        else if (standing && Math.abs(wall.price - standing.price) <= bins.bin * 3) this.#stood[side] = { price: wall.price, usd: wall.usd, since: standing.since };
        continue;
      }
      if (!wall || wall.usd < minUsd * 0.6) this.#armed[side] = true;
      if (standing && !wall) this.#stood[side] = null;
    }
    return out;
  }
}

/** (bids - asks) / (bids + asks), -1 to 1; 0 for an empty book. */
export const imbalanceOf = (bins: Pick<BookBins, 'bidTotal' | 'askTotal'>): number => { const t = bins.bidTotal + bins.askTotal; return t > 0 ? (bins.bidTotal - bins.askTotal) / t : 0; };

/**
 * One tip of the balance: fires when the imbalance passes `pct` percent one way, then not again until it has come back inside 60 % of that
 * (a book that hovers at the line sounds once, not on every wobble).
 */
export class ImbalanceWatch {
  #armed = true;
  update(imbalance: number, pct: number): 'buy' | 'sell' | null {
    const limit = pct / 100;
    if (Math.abs(imbalance) < limit * 0.6) this.#armed = true;
    if (!this.#armed || Math.abs(imbalance) < limit) return null;
    this.#armed = false;
    return imbalance > 0 ? 'buy' : 'sell';
  }
}
