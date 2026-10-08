/**
 * Volume-profile readings, shared by the page and the recorders so both data sources agree: the point of control (the price row with the most
 * volume) and the value area (the rows around it that hold a given share of the volume, 70 % by convention; its top and bottom are the value
 * area high and low, VAH and VAL).
 *
 * Both are read from volumes on rows of one fixed step over every price that traded in the window, never from the rows a screen happens to
 * show: zooming or scrolling the price axis must not move them.
 */

/**
 * The row with the most volume. Rows that tie go to the one nearest the middle of the rows that traded (the convention of the profile tools),
 * and of two equally near the lower. -1 when nothing traded.
 */
export function pointOfControl(volumes: ArrayLike<number>): number {
  let max = 0, first = -1, last = -1;
  for (let i = 0; i < volumes.length; i++) { const v = volumes[i]!; if (v > 0) { if (first < 0) first = i; last = i; } if (v > max) max = v; }
  if (!(max > 0)) return -1;
  const middle = (first + last) / 2;
  let best = -1;
  for (let i = first; i <= last; i++) if (volumes[i] === max && (best < 0 || Math.abs(i - middle) < Math.abs(best - middle))) best = i;
  return best;
}

/**
 * The value area: from the point of control, the next row above or below is added, whichever holds more (both when they hold the same), until
 * the rows taken hold `share` of all the volume. Rows are indices into `volumes`; null when nothing traded.
 */
export function valueArea(volumes: ArrayLike<number>, share: number): { poc: number; lo: number; hi: number } | null {
  const poc = pointOfControl(volumes);
  if (poc < 0) return null;
  let total = 0; for (let i = 0; i < volumes.length; i++) total += volumes[i]!;
  const target = total * Math.min(1, Math.max(0, share));
  let lo = poc, hi = poc, sum = volumes[poc]!;
  while (sum < target) {
    // A side with no row left reads as -1, so the other is always the one taken.
    const below = lo > 0 ? volumes[lo - 1]! : -1, above = hi < volumes.length - 1 ? volumes[hi + 1]! : -1;
    if (below < 0 && above < 0) break;
    if (above > below) { hi++; sum += above; }
    else if (below > above) { lo--; sum += below; }
    else { hi++; lo--; sum += above + below; }
  }
  return { poc, lo, hi };
}

/** A profile's readings as prices: the point of control at the middle of its row, the value area from the bottom of its lowest row to the top of its highest. */
export interface ValueLevels { poc: number; vah: number; val: number }

/**
 * The readings of volumes on rows of `step` keyed by row (the row's low price is key x step), whatever prices they span: the rows between
 * the lowest and the highest that traded are laid out in order (empty ones count as nothing) and read with `valueArea`.
 */
export function levelsOf(rows: ReadonlyMap<number, number>, step: number, share: number): ValueLevels | null {
  let lo = Infinity, hi = -Infinity;
  for (const [key, v] of rows) if (v > 0) { if (key < lo) lo = key; if (key > hi) hi = key; }
  if (!Number.isFinite(lo) || hi - lo > 1_000_000) return null;
  const volumes = new Float64Array(hi - lo + 1);
  for (const [key, v] of rows) if (v > 0) volumes[key - lo] += v;
  const area = valueArea(volumes, share);
  if (!area) return null;
  return { poc: (lo + area.poc + 0.5) * step, val: (lo + area.lo) * step, vah: (lo + area.hi + 1) * step };
}

/** The row a price falls in on rows of `step` (a price on a boundary belongs to the row above it, forgiving a part in 10^12). */
export const rowOf = (price: number, step: number): number => Math.floor(price / step * (1 + 1e-12));
