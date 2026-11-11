import type { SideLevels } from './levels.ts';

/**
 * Far levels are merged into buckets that widen with distance from the mark, so a deep book costs hundreds of levels rather than
 * thousands while the touch keeps its resolution. A bucket is about DISTANCE_SHARE as wide as its distance from the mark. Up to the
 * recorder's grid step the width is the step divided by a whole number, so a merged bucket sits inside one recorded bin; beyond it the
 * width is a power-of-two multiple of the step (at most MAX_MULTIPLE), and the bucket is recorded in the bin of its farthest member.
 * Far from the mark, where a screen row spans many bins anyway, that costs nothing visible and cuts what is stored and sent.
 */
export const MAX_DISTANCE = 0.5;
const DISTANCE_SHARE = 0.004;
/** Whole-number divisors of the grid step, finest first; the finest width is step / FINEST. */
const DIVISORS = [20, 10, 5, 4, 2, 1] as const;
const FINEST = 20;
/** Widest bucket, in grid steps. */
const MAX_MULTIPLE = 16;

/**
 * The same merge compiled to WebAssembly (`crates/hlm-kernels` `merge_by_distance`, the same arithmetic in the same order, so the same
 * result to the last bit; tests/app-client.test.mts holds them together): the browser's feeds worker installs it once its kernels have
 * loaded, for sides long enough that the copy in and out costs less than the merge. Node keeps this file's own.
 */
export type MergeKernel = (lo: Float64Array, usd: Float64Array, mid: number, step: number, isBid: boolean) => Float64Array;
let kernel: MergeKernel | null = null;
/** Sides of at least this many levels go to the kernel. */
export const KERNEL_FROM = 512;
/** Install the kernel (null: this file's own merge for every side). */
export function useMergeKernel(next: MergeKernel | null): void { kernel = next; }

/** Width of the bucket for levels `distance` away from the mark: the finest allowed width that is not narrower than the target. */
export function bucketWidth(distance: number, step: number): number {
  const target = distance * DISTANCE_SHARE;
  for (const divisor of DIVISORS) if (step / divisor >= target) return step / divisor;
  let width = step * 2;
  while (width < target && width < step * MAX_MULTIPLE) width *= 2;
  return width;
}

/**
 * Merge a side of point levels into distance-adaptive buckets. Input and output are nearest-first. A bucket is reported at its farthest
 * member from the mark (the lowest bid, the highest ask), so a lone level keeps its exact price, a merged level only moves away from
 * the mark, never across it, and never leaves its recorder bin. Levels farther than MAX_DISTANCE from the mark are dropped. Band
 * levels (hi above lo) are left alone.
 */
export function mergeByDistance(side: SideLevels, mid: number, step: number, isBid: boolean): SideLevels {
  const count = side.usd.length;
  if (count === 0 || !(step > 0) || !(mid > 0)) return side;
  for (let i = 0; i < count; i++) if (side.hi[i]! > side.lo[i]!) return side;
  if (kernel && count >= KERNEL_FROM) {
    // Packed: the buckets' prices, then their USD.
    const packed = kernel(side.lo, side.usd, mid, step, isBid), m = packed.length >> 1, lo = packed.subarray(0, m);
    return { lo, hi: lo, usd: packed.subarray(m) };
  }
  const limit = mid * MAX_DISTANCE;
  const buckets = new Map<number, { price: number; usd: number }>();
  for (let i = 0; i < count; i++) {
    const price = side.lo[i]!, distance = Math.abs(price - mid);
    if (distance > limit) break;
    const width = bucketWidth(distance, step), divisor = step / width;
    const key = Math.floor(price / width) * (FINEST / divisor);
    const bucket = buckets.get(key);
    if (!bucket) buckets.set(key, { price, usd: side.usd[i]! });
    else { bucket.usd += side.usd[i]!; if (isBid ? price < bucket.price : price > bucket.price) bucket.price = price; }
  }
  const lo = new Float64Array(buckets.size), usd = new Float64Array(buckets.size);
  let n = 0;
  for (const bucket of buckets.values()) { lo[n] = bucket.price; usd[n] = bucket.usd; n++; }
  return { lo, hi: lo, usd };
}
