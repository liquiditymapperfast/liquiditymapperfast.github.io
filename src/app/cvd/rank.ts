import type { Family } from './families.ts';

/** What a family did over the ranking window. */
export interface Ranked {
  family: Family;
  /** Gross volume (buy plus sell, USD) of the spot and the perpetual lane. */
  spot: number; perp: number; gross: number;
  /** Share of all the ranked families' volume, 0..1. */
  share: number;
  /** No volume in the last five completed minutes. */
  quiet: boolean;
}

export interface RankInput { family: Family; spot: number; perp: number; quiet: boolean }
export interface RankOptions {
  /** How many families to show; `null` shows every family that has volume. */
  top: number | null;
  /** Families that stay in the list whatever their rank (the ones a person chose to keep). */
  pin?: readonly string[];
}

/**
 * Order families by gross volume, biggest first. Strict about the count: a family with no volume does not fill an empty place, and the
 * pinned families that are not in the top N take the last places, so the list never grows past N (with more pins than places, the
 * biggest pinned ones stay). The order is still by volume: a pinned family outside the top N is smaller than every one inside it.
 */
export function rankFamilies(inputs: readonly RankInput[], { top, pin = [] }: RankOptions): Ranked[] {
  const withVolume = inputs.filter(i => i.spot + i.perp > 0);
  const total = withVolume.reduce((sum, i) => sum + i.spot + i.perp, 0);
  const all: Ranked[] = withVolume.map(i => ({ family: i.family, spot: i.spot, perp: i.perp, gross: i.spot + i.perp, share: total > 0 ? (i.spot + i.perp) / total : 0, quiet: i.quiet }))
    .sort((a, b) => b.gross - a.gross || (a.family.key < b.family.key ? -1 : 1));
  if (top === null || all.length <= top) return all;
  const pins = new Set(pin), keep = new Set<Ranked>(all.filter(r => pins.has(r.family.key)).slice(0, top));
  for (const r of all) { if (keep.size >= top) break; keep.add(r); }
  return all.filter(r => keep.has(r));
}

/**
 * Keeps the order of the rows steady between refreshes: the column re-ranks every `refreshMs` (a row that jumped each time two venues
 * traded places would be unreadable), and with `auto` off the first layout stays for good. The numbers on the rows are always current;
 * only the order and the membership are held.
 */
export class Ranker {
  #keys: string[] = [];
  #at = -Infinity;
  constructor(public refreshMs: number = 60_000, public auto = true) {}

  /** `fresh` is the ranking as it is now; what comes back is the held order with the current numbers (a held family that vanished is gone). */
  apply(now: number, fresh: readonly Ranked[]): Ranked[] {
    const due = this.#keys.length === 0 || (this.auto && now - this.#at >= this.refreshMs);
    if (due && fresh.length) { this.#keys = fresh.map(r => r.family.key); this.#at = now; }
    const byKey = new Map(fresh.map(r => [r.family.key, r] as const));
    return this.#keys.flatMap(key => { const r = byKey.get(key); return r ? [r] : []; });
  }

  /** Re-rank at the next call (the person changed what is ranked). */
  reset(): void { this.#keys = []; this.#at = -Infinity; }
}

/** True when a lane has traded nothing in the last five completed minutes ending at the last whole minute before `nowMs`. */
export function quiet(gross: (fromSec: number, toSec: number) => number, nowMs: number): boolean {
  const end = Math.floor(nowMs / 60_000) * 60 - 1, start = end - 299;
  return gross(start, end) <= 0;
}
