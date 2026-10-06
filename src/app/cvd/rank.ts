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

/** Every family that has volume, biggest first, each with its share of all of it. */
export function rankAll(inputs: readonly RankInput[]): Ranked[] {
  const withVolume = inputs.filter(i => i.spot + i.perp > 0);
  const total = withVolume.reduce((sum, i) => sum + i.spot + i.perp, 0);
  return withVolume.map(i => ({ family: i.family, spot: i.spot, perp: i.perp, gross: i.spot + i.perp, share: total > 0 ? (i.spot + i.perp) / total : 0, quiet: i.quiet }))
    .sort((a, b) => b.gross - a.gross || (a.family.key < b.family.key ? -1 : 1));
}

/**
 * The families to show out of `all`. Strict about the count: a family with no volume does not fill an empty place, and the pinned
 * families that are not in the top N take the last places, so the list never grows past N (with more pins than places, the biggest pinned
 * ones stay). The order is still by volume: a pinned family outside the top N is smaller than every one inside it.
 */
export function pickTop(all: readonly Ranked[], { top, pin = [] }: RankOptions): Ranked[] {
  if (top === null || all.length <= top) return [...all];
  const pins = new Set(pin), keep = new Set<Ranked>(all.filter(r => pins.has(r.family.key)).slice(0, top));
  for (const r of all) { if (keep.size >= top) break; keep.add(r); }
  return all.filter(r => keep.has(r));
}

export const rankFamilies = (inputs: readonly RankInput[], options: RankOptions): Ranked[] => pickTop(rankAll(inputs), options);

/**
 * Keeps the order of the rows steady between refreshes: the column re-ranks every `refreshMs` (a row that jumped each time two venues
 * traded places would be unreadable), and with `auto` off the first layout stays for good. The numbers on the rows are always current;
 * only the order and the membership are held.
 */
export class Ranker {
  #keys: string[] = [];
  #at = -Infinity;
  constructor(public refreshMs: number = 60_000, public auto = true) {}

  /**
   * `fresh` is the ranking as it is now, cut to the places there are; `all` is every family that has volume (by default, those in `fresh`).
   * What comes back is the held order with the current numbers. A held family is looked up in `all`, not in `fresh`: one that has slipped
   * out of the top places is still held, with its numbers, until the next re-rank. One that has no volume at all any more is gone, and a
   * held list that has lost every one of its families (venues switched off, another market chosen) is not held any longer: it is made again.
   */
  apply(now: number, fresh: readonly Ranked[], all: readonly Ranked[] = fresh): Ranked[] {
    const byKey = new Map(all.map(r => [r.family.key, r] as const));
    const alive = this.#keys.some(key => byKey.has(key));
    const due = this.#keys.length === 0 || !alive || (this.auto && now - this.#at >= this.refreshMs);
    if (due && fresh.length) { this.#keys = fresh.map(r => r.family.key); this.#at = now; }
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
