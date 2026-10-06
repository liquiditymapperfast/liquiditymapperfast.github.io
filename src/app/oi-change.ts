import type { OiBar } from './store.ts';

/**
 * The change in open interest that each bar stands for: its close minus the close of the bar before it (the first bar has none, so 0).
 * Open interest is a level that is read now and then, and a bar that holds a single reading has the same open and close: only the step
 * from one bar's close to the next shows that it moved. The pane, the statistics under the footprint and the sounds all use this one
 * definition, so what one shows the others mean.
 */
export function oiDeltas(bars: readonly OiBar[]): Float64Array {
  const out = new Float64Array(bars.length);
  for (let i = 1; i < bars.length; i++) out[i] = bars[i]![4] - bars[i - 1]![4];
  return out;
}

/** The same by bar time, for a lookup (the first bar, which has no bar before it, is left out). */
export function oiDeltaByTime(bars: Iterable<OiBar>): Map<number, number> {
  const sorted = [...bars].sort((a, b) => a[0] - b[0]), delta = oiDeltas(sorted), out = new Map<number, number>();
  for (let i = 1; i < sorted.length; i++) out.set(sorted[i]![0], delta[i]!);
  return out;
}
