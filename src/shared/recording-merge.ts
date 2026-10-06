import type { FlowMinuteRow } from './flow.ts';
import type { FootprintMinuteRow } from './footprint.ts';

/**
 * What a store keeps when a minute it already holds arrives again, from another writer.
 *
 * Two tabs of the same browser record the same exchanges, and only one of them writes at a time. When the writer closes, the next one
 * takes over, and the minutes it has in memory may be thinner than what the first one stored: it opened part-way through a minute, or its
 * connection dropped for a while. A minute only ever grows within one recorder, so a store keeps the fuller of what it has and what
 * arrives and never lets a thinner copy replace it. (Adding the two would count every trade that both tabs saw twice.)
 *
 * Each function returns the row to store, or null when what is stored is already at least as full and nothing should be written.
 */

/** Second by second, whichever copy saw more of that second (by USD), with its own price: a second is one tab's observation, whole. */
export function fullerFlowMinute(kept: FlowMinuteRow | undefined, next: FlowMinuteRow): FlowMinuteRow | null {
  if (!kept || kept.buy.length !== 60 || kept.sell.length !== 60 || next.buy.length !== 60 || next.sell.length !== 60) return next;
  let better = false, worse = false;
  const buy = new Float32Array(60), sell = new Float32Array(60), px = new Float32Array(60);
  for (let i = 0; i < 60; i++) {
    const have = kept.buy[i]! + kept.sell[i]!, got = next.buy[i]! + next.sell[i]!;
    const from = got >= have ? next : kept;
    if (got > have) better = true; else if (have > got) worse = true;
    buy[i] = from.buy[i]!; sell[i] = from.sell[i]!; px[i] = from.px?.[i] ?? 0;
  }
  if (!worse) return next;
  if (!better) return null;
  return { inst: next.inst, t: next.t, buy, sell, ...(kept.px || next.px ? { px } : {}) };
}

/** A footprint minute is one set of rows and the statistics that go with them, so the copy with more volume replaces the other whole. */
export function fullerFootprintMinute(kept: FootprintMinuteRow | undefined, next: FootprintMinuteRow): FootprintMinuteRow | null {
  if (!kept) return next;
  const volume = (row: FootprintMinuteRow): number => { let sum = 0; for (const bin of row.bins) sum += bin[1] + bin[2]; return sum; };
  return volume(next) >= volume(kept) ? next : null;
}

/** A depth column is the mean of its samples, so the copy built from more samples is the better one. */
export function fullerColumn<T extends { n: number }>(kept: T | undefined, next: T): T | null {
  return !kept || next.n >= kept.n ? next : null;
}
