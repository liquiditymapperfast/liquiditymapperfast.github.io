import { diagonalImbalances, stackedZones, type StackedZone } from '../panes/bar-stats.ts';
import type { Bar, FootprintData } from '../panes/footprint.ts';
import type { StatOptions } from '../stat-options.ts';

/**
 * What the footprint marks in each candle, worked out once from the rows loaded (never per frame): the diagonal imbalances by row (the ratio
 * of each flagged side; Infinity against an empty row), the stacked runs of them, and the candle's point of control.
 */
export interface BarMarks {
  /** By the row's low price: how many times the opposite volume its sells and its buys are, where flagged. */
  flags: Map<number, { sell?: number; buy?: number }>;
  zones: StackedZone[];
  /** The low price of the busiest row (sold plus bought), or null for a candle with none. */
  poc: number | null;
}

export function marksOf(bar: Bar, step: number, options: StatOptions): BarMarks {
  const found = diagonalImbalances(bar.rows, step, options), flags = new Map<number, { sell?: number; buy?: number }>();
  for (const f of found) { const entry = flags.get(f.low) ?? {}; entry[f.side] = f.ratio; flags.set(f.low, entry); }
  let poc: number | null = null, busiest = 0;
  for (const [low, buy, sell] of bar.rows) if (buy + sell > busiest) { busiest = buy + sell; poc = low; }
  return { flags, zones: stackedZones(found, step, options.stackedN), poc };
}

/** The marks of every candle loaded, worked out again only when the rows (a new load) or the options change. */
export class FootprintMarks {
  #key = '';
  #marks = new Map<number, BarMarks>();
  get(data: FootprintData, options: StatOptions): ReadonlyMap<number, BarMarks> {
    const key = `${data.version}|${data.step}|${options.imbRatio}|${options.imbMinUsd}|${options.stackedN}|${options.imbZeros}`;
    if (key !== this.#key) {
      this.#key = key;
      this.#marks = new Map([...data.bars.values()].map(bar => [bar.t, marksOf(bar, data.step, options)] as const));
    }
    return this.#marks;
  }
}
