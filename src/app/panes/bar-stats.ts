import { volText, type Bar } from './footprint.ts';
import type { CandleRow, OiBar } from '../store.ts';
import { price as fmtPrice, usd } from '../format.ts';
import { SIZE_EDGES } from '../../shared/footprint.ts';
import { scaledUsd } from '../coin.ts';
import type { StatOptions } from '../stat-options.ts';
import { t } from '../i18n.ts';
import type { InfoLine } from '../infobox.ts';
import { oiDeltaByTime } from '../oi-change.ts';

/**
 * Per-candle statistics shown under the footprint. Each definition computes one number per bar from the executions recorded for
 * that bar (buy and sell USD by price row, trade counts and size buckets), the candle and the open-interest bar of the same
 * period. The strip shows the stats the user enabled, in the order chosen; adding a statistic means adding one entry here.
 */
export type { StatOptions } from '../stat-options.ts';
export { DEFAULT_STAT_OPTIONS } from '../stat-options.ts';

/** The size buckets' names, from their notional USD edges ("< $25K", "$25K-50K" … "$5M+" for BTC; a coin with smaller floors has smaller edges). */
export function sizeBucketLabels(): string[] {
  const edge = (i: number): string => usd(scaledUsd(SIZE_EDGES[i]!)), last = SIZE_EDGES.length - 1;
  return SIZE_EDGES.map((_, i) => i === 0 ? `< $${edge(1)}` : i === last ? `$${edge(i)}+` : `$${edge(i)}-${edge(i + 1)}`);
}

export interface StatInput {
  /** Bars oldest first; stats that accumulate (cvd) sum over exactly these. */
  bars: readonly Bar[];
  /** Price step of the loaded rows. */
  step: number;
  candles: ReadonlyMap<number, CandleRow>;
  oi: ReadonlyMap<number, OiBar>;
  options: StatOptions;
}
export type StatScale = 'sequential' | 'diverging' | 'plain';
export type StatGroup = 'volume' | 'footprint' | 'trades' | 'market';
export interface StatDef {
  id: string;
  label: string;
  group: StatGroup;
  /** One line shown as a tooltip and in the configuration list. */
  title: string;
  /** sequential: pale to strong by magnitude; diverging: red / green by sign around `center`; plain: no colour scale. */
  scale: StatScale;
  /** Value the diverging scale is centred on (0 unless the stat is a share around 50 %). */
  center?: number;
  format: (value: number) => string;
  /** One value per bar, in the order of `input.bars`; null when it cannot be computed for that bar. */
  compute: (input: StatInput) => (number | null)[];
}

export const GROUP_TITLES: Readonly<Record<StatGroup, string>> = {
  volume: t('Volume'), footprint: t('Footprint rows'), trades: t('Trades (recorded since the server started recording them)'), market: 'Candle and open interest',
};

export const signedVol = (value: number): string => (value < 0 ? '-' : '') + volText(Math.abs(value));
const signedPct = (value: number): string => `${value > 0 ? '+' : ''}${value.toFixed(1)}%`;
const total = (bar: Bar): number => bar.buyUsd + bar.sellUsd;
const count = (value: number): string => String(Math.round(value));

/** A row flagged by `diagonalImbalances`: its low price, the heavier side, and how many times the opposite volume it is (Infinity against an empty row). */
export interface Imbalance { low: number; side: 'buy' | 'sell'; ratio: number }

/**
 * Diagonal imbalances, as footprint charts compute them: sell volume at a level against buy volume one row higher, and buy
 * volume at a level against sell volume one row lower. (Not the same-row 1.15x rule that tints the footprint cells.) A row one away
 * with nothing traded, inside the candle's range, counts as zero and flags only with `imbZeros`; past the candle's top or bottom there
 * is nothing to compare with.
 */
export function diagonalImbalances(rows: Bar['rows'], step: number, options: Pick<StatOptions, 'imbRatio' | 'imbMinUsd'> & { imbZeros?: boolean }): Imbalance[] {
  const at = new Map<number, [number, number]>();
  let lowest = Infinity, highest = -Infinity;
  for (const [low, buy, sell] of rows) { const index = Math.round(low / step); at.set(index, [buy, sell]); lowest = Math.min(lowest, index); highest = Math.max(highest, index); }
  const found: Imbalance[] = [], min = scaledUsd(options.imbMinUsd);
  /** The volume of `side` one row away at `index`: 0 for an empty row inside the candle, null past its range. */
  const opposite = (index: number, side: 0 | 1): number | null => index < lowest || index > highest ? null : at.get(index)?.[side] ?? 0;
  const flag = (own: number, other: number | null): number | null => {
    if (other === null || !(own > 0) || own < min) return null;
    if (other > 0) return own >= options.imbRatio * other ? own / other : null;
    return options.imbZeros ? Infinity : null;
  };
  for (const [low, buy, sell] of rows) {
    const index = Math.round(low / step);
    const sellRatio = flag(sell, opposite(index + 1, 0)), buyRatio = flag(buy, opposite(index - 1, 1));
    if (sellRatio !== null) found.push({ low, side: 'sell', ratio: sellRatio });
    if (buyRatio !== null) found.push({ low, side: 'buy', ratio: buyRatio });
  }
  return found;
}

/** A stacked imbalance: `n` or more adjacent rows flagged on one side, from the bottom of the lowest to the top of the highest. */
export interface StackedZone { side: 'buy' | 'sell'; low: number; high: number }

/** The runs of at least `n` adjacent rows flagged on the same side, as price spans. */
export function stackedZones(found: readonly Imbalance[], step: number, n: number): StackedZone[] {
  const zones: StackedZone[] = [];
  for (const side of ['buy', 'sell'] as const) {
    const indices = [...new Set(found.filter(f => f.side === side).map(f => Math.round(f.low / step)))].sort((a, b) => a - b);
    let start = 0;
    for (let i = 1; i <= indices.length; i++) {
      if (i < indices.length && indices[i] === indices[i - 1]! + 1) continue;
      if (i - start >= n) zones.push({ side, low: indices[start]! * step, high: (indices[i - 1]! + 1) * step });
      start = i;
    }
  }
  return zones;
}

/** Number of runs of at least `n` adjacent rows flagged on the same side. */
export const stackedRuns = (found: readonly Imbalance[], step: number, n: number): number => stackedZones(found, step, n).length;

const tradeStat = (id: string, label: string, title: string, scale: StatScale, format: (v: number) => string, pick: (stats: NonNullable<Bar['stats']>, input: StatInput, bar: Bar) => number | null): StatDef =>
  ({ id, label, group: 'trades', title, scale, format, compute: input => input.bars.map(bar => bar.stats ? pick(bar.stats, input, bar) : null) });
const sumBuckets = (values: readonly number[], from: number, to: number): number => values.slice(from, to + 1).reduce((a, b) => a + b, 0);
const sizeDelta = (stats: NonNullable<Bar['stats']>, from: number, to: number): number => sumBuckets(stats.buy, from, to) - sumBuckets(stats.sell, from, to);
const retail = (o: StatOptions): [number, number] => [0, o.retailMax];
const whales = (o: StatOptions): [number, number] => [o.whaleMin, 7];
const running = (values: (number | null)[]): (number | null)[] => { let run = 0; return values.map(v => v === null ? null : (run += v)); };

export const BAR_STATS: readonly StatDef[] = [
  { id: 'vol', label: 'vol', group: 'volume', title: t('Executed volume of the bar (USD, buy + sell)'), scale: 'sequential', format: volText, compute: ({ bars }) => bars.map(total) },
  { id: 'delta', label: 'delta', group: 'volume', title: t('Buy minus sell volume of the bar (USD)'), scale: 'diverging', format: signedVol, compute: ({ bars }) => bars.map(bar => bar.buyUsd - bar.sellUsd) },
  { id: 'cvd', label: 'cvd', group: 'volume', title: t('Cumulative delta: running sum of delta over the bars loaded for the view'), scale: 'diverging', format: signedVol,
    compute: ({ bars }) => { let run = 0; return bars.map(bar => (run += bar.buyUsd - bar.sellUsd)); } },
  { id: 'deltaPct', label: t('delta %'), group: 'volume', title: t('Delta as a share of the bar\'s volume (+100 % all buying, -100 % all selling)'), scale: 'diverging', format: signedPct,
    compute: ({ bars }) => bars.map(bar => total(bar) > 0 ? (bar.buyUsd - bar.sellUsd) / total(bar) * 100 : null) },
  { id: 'buyVol', label: t('buy vol'), group: 'volume', title: t('Volume bought at the ask (market buys, USD)'), scale: 'sequential', format: volText, compute: ({ bars }) => bars.map(bar => bar.buyUsd) },
  { id: 'sellVol', label: t('sell vol'), group: 'volume', title: t('Volume sold at the bid (market sells, USD)'), scale: 'sequential', format: volText, compute: ({ bars }) => bars.map(bar => bar.sellUsd) },
  { id: 'maxBuy', label: t('max buy'), group: 'footprint', title: t('Largest single price row of market buys in the bar (USD)'), scale: 'sequential', format: volText, compute: ({ bars }) => bars.map(bar => bar.rows.reduce((m, r) => Math.max(m, r[1]), 0)) },
  { id: 'maxSell', label: t('max sell'), group: 'footprint', title: t('Largest single price row of market sells in the bar (USD)'), scale: 'sequential', format: volText, compute: ({ bars }) => bars.map(bar => bar.rows.reduce((m, r) => Math.max(m, r[2]), 0)) },
  { id: 'poc', label: 'poc', group: 'footprint', title: t('Point of control: the price row with the most executed volume in the bar'), scale: 'plain', format: value => fmtPrice(value),
    compute: ({ bars, step }) => bars.map(bar => { let best = -1, price: number | null = null; for (const [low, buy, sell] of bar.rows) if (buy + sell > best) { best = buy + sell; price = low + step / 2; } return price; }) },
  { id: 'imbalances', label: t('imb #'), group: 'footprint', title: t('Diagonal imbalances: levels where sells (or buys) are at least the configured ratio times the opposite volume one row away'), scale: 'sequential', format: count,
    compute: ({ bars, step, options }) => bars.map(bar => diagonalImbalances(bar.rows, step, options).length) },
  { id: 'stacked', label: 'stacked', group: 'footprint', title: t('Stacked imbalances: runs of the configured number of adjacent imbalanced rows on one side'), scale: 'sequential', format: count,
    compute: ({ bars, step, options }) => bars.map(bar => stackedRuns(diagonalImbalances(bar.rows, step, options), step, options.stackedN)) },
  tradeStat('trades', 'orders', t('Number of market orders in the bar (all the fills of one order count once)'), 'sequential', count, stats => stats.buyN + stats.sellN),
  tradeStat('buys', 'buys', t('Number of market buys in the bar'), 'sequential', count, stats => stats.buyN),
  tradeStat('sells', 'sells', t('Number of market sells in the bar'), 'sequential', count, stats => stats.sellN),
  tradeStat('avgTrade', t('avg order'), t('Average market order size: volume divided by the number of market orders (USD)'), 'sequential', volText, stats => stats.buyN + stats.sellN > 0 ? (sumBuckets(stats.buy, 0, 7) + sumBuckets(stats.sell, 0, 7)) / (stats.buyN + stats.sellN) : null),
  tradeStat('deltaRetail', t('delta retail'), t('Delta of market orders up to the retail size bucket (set in the options)'), 'diverging', signedVol, (stats, input) => sizeDelta(stats, ...retail(input.options))),
  tradeStat('deltaWhales', t('delta whales'), t('Delta of market orders from the whale size bucket upward (set in the options)'), 'diverging', signedVol, (stats, input) => sizeDelta(stats, ...whales(input.options))),
  { id: 'cvdRetail', label: t('cvd retail'), group: 'trades', title: t('Cumulative delta of retail-size market orders over the bars loaded'), scale: 'diverging', format: signedVol,
    compute: input => running(input.bars.map(bar => bar.stats ? sizeDelta(bar.stats, ...retail(input.options)) : null)) },
  { id: 'cvdWhales', label: t('cvd whales'), group: 'trades', title: t('Cumulative delta of whale-size market orders over the bars loaded'), scale: 'diverging', format: signedVol,
    compute: input => running(input.bars.map(bar => bar.stats ? sizeDelta(bar.stats, ...whales(input.options)) : null)) },
  { id: 'range', label: 'range', group: 'market', title: t('High minus low of the candle'), scale: 'sequential', format: value => fmtPrice(value),
    compute: ({ bars, candles }) => bars.map(bar => { const c = candles.get(bar.t); return c ? c[2] - c[3] : null; }) },
  { id: 'oiChange', label: t('oi chg'), group: 'market', title: t('Open-interest change over the bar (its close minus the close of the bar before); USD or base coin in the options'), scale: 'diverging', format: signedVol,
    compute: ({ bars, oi, candles, options }) => { const delta = oiDeltaByTime(oi.values()); return bars.map(bar => { const change = delta.get(bar.t); if (change === undefined) return null; if (options.oiUnits === 'base') return change; const c = candles.get(bar.t); return c ? change * c[4] : null; }); } },
];

/** Starting selections offered by the presets. */
export const PRESETS: Readonly<Record<'default' | 'all' | 'none', readonly string[]>> = {
  default: ['vol', 'delta', 'cvd'],
  all: BAR_STATS.map(def => def.id),
  none: [],
};

const byId = new Map(BAR_STATS.map(def => [def.id, def]));
export const statDef = (id: string): StatDef | undefined => byId.get(id);

/** The enabled definitions in the configured order, ignoring unknown ids and duplicates. */
export function enabledStats(ids: readonly string[]): StatDef[] {
  const seen = new Set<string>(), out: StatDef[] = [];
  for (const id of ids) { const def = byId.get(id); if (def && !seen.has(id)) { seen.add(id); out.push(def); } }
  return out;
}

/**
 * Colour scale of one row: deviations from the stat's centre mapped on a log scale between the visible 2nd and 99th percentile,
 * so one outlier bar does not flatten the row. Returns null when there is nothing to scale.
 */
export function rowScale(def: StatDef, values: readonly (number | null | undefined)[]): { lo: number; hi: number } | null {
  if (def.scale === 'plain') return null;
  const deviations: number[] = [];
  for (const value of values) if (value !== null && value !== undefined) { const d = Math.abs(value - (def.center ?? 0)); if (d > 0) deviations.push(d); }
  if (!deviations.length) return null;
  deviations.sort((a, b) => a - b);
  const at = (q: number) => deviations[Math.min(deviations.length - 1, Math.floor(q * deviations.length))]!;
  const hi = at(0.99), lo = Math.max(at(0.02), hi / 4096);
  return { lo, hi };
}

/** Strength 0..1 of a value on its row's scale: 0 at or below the 2nd percentile, 1 at or above the 99th. */
export function strength(def: StatDef, value: number, scale: { lo: number; hi: number } | null): number {
  if (def.scale === 'plain' || !scale) return 0;
  const d = Math.abs(value - (def.center ?? 0));
  if (d <= scale.lo) return 0;
  if (d >= scale.hi || !(scale.hi > scale.lo)) return 1;
  return (Math.log(d) - Math.log(scale.lo)) / (Math.log(scale.hi) - Math.log(scale.lo));
}

/** What the pointer is on in the strip: one statistic of one candle, with what is needed to say how it compares. */
export interface StatCell {
  label: string;
  /** What the statistic means (the definition's own sentence). */
  title: string;
  value: string;
  /** The colour of the value: a signed statistic is green or red by its sign. */
  tone: 'buy' | 'sell' | 'text';
  time: string;
  /** The same statistic on the candle before, when that candle is the one just before. */
  previous: string | null;
  /** Where this value stands among the candles in view (1 is the largest), and how many there are. */
  rank: number | null;
  of: number;
  /** How far above its recent norm the value is, when the highlighter flagged it. */
  sigma: number | null;
}

/** The popup for a cell of the strip. */
export function statCellLines(cell: StatCell): InfoLine[] {
  const lines: InfoLine[] = [
    { text: cell.label, bold: true },
    { label: t('Candle'), text: cell.time },
    { label: t('Value'), text: cell.value, color: cell.tone, bold: true },
  ];
  if (cell.previous !== null) lines.push({ label: t('Candle before'), text: cell.previous });
  if (cell.rank !== null && cell.of > 1) lines.push({ label: t('Rank in view'), text: t('{rank} of {total}', { rank: cell.rank, total: cell.of }) });
  if (cell.sigma !== null && Number.isFinite(cell.sigma)) lines.push({ label: t('Unusual'), text: t('{z}σ above its baseline', { z: cell.sigma.toFixed(1) }), bold: true });
  lines.push({ text: cell.title, color: 'muted', wrap: true, rule: true });
  return lines;
}
