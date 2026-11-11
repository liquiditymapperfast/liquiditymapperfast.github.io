/**
 * The size a pane's bars are drawn against (pure, tested in tests/bar-scale.test.mts). Scaled to the largest alone, one flush of open interest
 * drew every other bar of the day as a sliver: on 2026-11-10 one change of 4,417 BTC left 86 % of the day's 96 fifteen-minute bars under
 * 2 px in the OI pane's band. So where there are at least `BAR_SCALE_MIN` sizes in view, the few that stand well clear of all the others are
 * cut: the largest `j` (at most `BAR_CUT_FEW`, or `BAR_CUT_SHARE` of the sizes where that is more) when the `j`-th largest is more than
 * `BAR_CUT_RATIO` times the next, the deepest such step, and the scale is that next size; with no such step, or fewer sizes, the largest. A
 * cut bar is drawn to the edge and marked (`cutGap`), and its popup says its size, so a cut mark always means much larger. A fixed rank cut
 * one bar too few whenever a flush had a second large bar (a cascade over two candles, or both sides of one in the Delta pane, which pools
 * the buyers' and the sellers' stacks), and the 98th percentile by nearest rank was the largest itself below 50 sizes (review, 2026-11-10); a share of 5 % left a five-candle cascade uncut in a
 * day of 96 bars (Hyperliquid's own fifteen-minute changes, review round 3). Only sizes above zero count, toward the 20 and the share too.
 */
export const BAR_SCALE_MIN = 20;
export const BAR_CUT_FEW = 3;
export const BAR_CUT_SHARE = 0.1;
export const BAR_CUT_RATIO = 1.5;
/** Where a cut bar's mark sits: a gap this far in from the bar's outer end. */
export const BAR_CUT_PX = 3;
/** The gap's height in px. */
export const BAR_CUT_H = 1.5;

/**
 * The mark of a cut bar: a gap across it at `y`, `w` wide, erased rather than painted, so it shows what is behind the canvas on every theme and
 * on the glass material (a stripe in the panel's colour would sit on the glass as a band of its own).
 */
export function cutGap(ctx: CanvasRenderingContext2D, x: number, y: number, w: number): void {
  ctx.save();
  ctx.globalCompositeOperation = 'destination-out';
  ctx.globalAlpha = 1;
  ctx.fillRect(x, y, w, BAR_CUT_H);
  ctx.restore();
}

/**
 * One stack's parts as drawn against `cap`: as they are where the stack fits, else each its share of the stack, scaled to end at `cap`, so a
 * part stacked behind a large one is never left out (a negative or non-finite part counts as nothing).
 */
export function partsWithin(parts: readonly number[], cap: number): number[] {
  const sizes = parts.map(x => Number.isFinite(x) && x > 0 ? x : 0), total = sizes.reduce((a, b) => a + b, 0);
  const k = total > cap && total > 0 ? cap / total : 1;
  return sizes.map(x => x * k);
}

export function barScale(sizes: Iterable<number>): number {
  const s: number[] = [];
  for (const x of sizes) if (Number.isFinite(x) && x > 0) s.push(x);
  if (!s.length) return 0;
  s.sort((a, b) => a - b);
  const n = s.length, largest = s[n - 1]!;
  if (n < BAR_SCALE_MIN) return largest;
  for (let j = Math.max(BAR_CUT_FEW, Math.floor(BAR_CUT_SHARE * n)); j >= 1; j--) {
    const below = s[n - j - 1]!;
    if (s[n - j]! > BAR_CUT_RATIO * below) return below;
  }
  return largest;
}
