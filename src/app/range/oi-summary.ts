import type { CandleRow, OiBar } from '../store.ts';
import type { NlnsCandle } from '../delta/nlns.ts';
import { heldOiAt, type OiPart } from '../oi-change.ts';

/**
 * The OI pane's own figures for a stretch of its bars (the Range tool's selection made in the pane): worked out from the series the pane
 * draws (its level, each bar's change as the bars count it, the venues' own bars and the NL/NS candles), so the summary adds up to the bars
 * on screen. Pure: the pane hands over what it holds, nothing is asked for.
 */
export interface OiStretchInput {
  /** The pane's level, oldest first (the venues' sum chained from their changes, or the one market's bars). */
  oi: readonly OiBar[];
  /** Each bar's change by its start, as the bars count it (`oiChangeByTime`): a bar with no entry has no known change (no reading before it). */
  change: ReadonlyMap<number, number>;
  /** The first and last bar of the stretch (indices into `oi`, inclusive). */
  i0: number; i1: number;
  tfMs: number;
  /**
   * How many venues each bar holds a level of (`OiSum.venues`), and how many of them its change is made of (`OiSum.counted`: those read at
   * both ends of the bar), for venues added together; null for one market.
   */
  venues: readonly number[] | null;
  counted: readonly number[] | null;
  /** Which markets each bar's change is made of (their ids, sorted, joined), venues added together; else null (one market). */
  cohorts?: readonly (string | undefined)[] | null;
  /** Bars from this start on are still forming (the candle under way): a stretch holding one is not compared, and no window holds one. */
  formingFrom?: number;
  /** The venues added together (each its own bars); one market: empty. */
  parts: readonly OiPart[];
  /** The NL/NS candles by start, where the bars are split by who. */
  who: ReadonlyMap<number, NlnsCandle> | null;
  /** The chart's candles (oldest first), for the price across the same candles. */
  candles: readonly CandleRow[];
  /** The candles are the coin's own market's (a borrowed reference series says nothing of this coin's price). */
  ownPrice: boolean;
  /** Each bar's change in dollars by bar start (`oiUsdChangeByTime`), where known. */
  usd: ReadonlyMap<number, number> | null;
  /** Highlights' flags per bar (1: stands out), when Highlights are on. */
  flag: ArrayLike<number> | null;
}

/** NL/NS over a stretch, in coins: the four parts added up, what went to no side while open interest rose and while it fell, and how it was read. */
export interface OiWho {
  longOpened: number; shortOpened: number; longClosed: number; shortClosed: number;
  /** Given to no side (takers even, or nothing said which way), while open interest rose and while it fell. */
  unsidedUp: number; unsidedDown: number;
  /** Estimated added (the parts opened and the unsided rise) and reduced (closed and the unsided fall); `added − reduced` is the model's change. */
  added: number; reduced: number;
  /** The model's own change over the stretch (its candles' `dOi`), and the bars' known change over the same candles, which it is checked against. */
  dOi: number; known: number;
  /** Candles of the stretch the model has, and those where some market's side was taken from the price. */
  candles: number; byPrice: number;
  /** Candles worked out minute by minute for every market counted (the rest a candle at a time). */
  fineAll: number;
}

/**
 * One venue's part of the stretch: its change as the sum counts it (its own change in each bar where it was read at both ends of the bar,
 * `sumOi`), so the venues' parts add up to the stretch's change; `bars`: the bars its change was counted in.
 */
export interface OiVenueChange { id: string; change: number; bars: number }

export interface OiStretch {
  t0: number; t1: number;
  /** Bars in the stretch, and those whose change is known (the rest had no reading before them). */
  bars: number; known: number;
  /** The level before the first bar's change and after the last, and the known changes added up (`end − start`). */
  start: number; end: number; change: number;
  /** In dollars, each bar's change at its own close; null where a bar's is not known. */
  usd: number | null;
  /** The largest fall of the level inside the stretch, from a level before it to one after (a run of known bars; none across an unknown one). */
  fall: { amount: number; from: number; to: number } | null;
  /** The bar with the largest change (by size), its start and change. */
  largest: { t: number; change: number } | null;
  /** The fewest bars whose changes make half of all the movement (the changes' sizes added up), and that movement. */
  half: { bars: number; movement: number } | null;
  /** Bars the Highlights mark as standing out. */
  flagged: number;
  /** The fewest and most venues holding a level across the stretch, and making its changes (venues added together), else null. */
  venuesLow: number | null; venuesHigh: number | null;
  countedLow: number | null; countedHigh: number | null;
  /** Bars whose change reaches back further than one candle (the bar before them is missing): their change covers more time. */
  spans: number;
  who: OiWho | null;
  venues: OiVenueChange[];
  /** The chart market's price over the same candles: the first's open, the last's close; null where the candles are not this coin's or not held. */
  price: { open: number; close: number; high: number; low: number } | null;
  /** The change over the candles just before, as many (each a candle long, all known, made of the same markets); null otherwise or while forming. */
  before: number | null;
  /**
   * Of the closed windows of as many candles held that compare with it (each candle a candle long and known, made of the same markets as the
   * stretch, this one included, overlapping), how many had a larger net change by size (ties are not larger), and how many there are; null
   * while forming, or when the stretch itself does not compare.
   */
  rank: { larger: number; of: number } | null;
}

/**
 * NL/NS candles added up: the four parts, what went to no side, estimated added and reduced, the model's own change and (`known`, each
 * candle's) the bars' known change over the same candles, and how they were read; null for none. The OI and the Delta panes' summaries both
 * add up with it, so the two never give different parts for one stretch.
 */
export function sumWho(candles: readonly { c: NlnsCandle; known?: number }[]): OiWho | null {
  const w: OiWho = { longOpened: 0, shortOpened: 0, longClosed: 0, shortClosed: 0, unsidedUp: 0, unsidedDown: 0, added: 0, reduced: 0, dOi: 0, known: 0, candles: 0, byPrice: 0, fineAll: 0 };
  for (const { c, known } of candles) {
    w.candles++; w.longOpened += c.longOpened; w.shortOpened += c.shortOpened; w.longClosed += c.longClosed; w.shortClosed += c.shortClosed;
    w.unsidedUp += c.unsidedUp; w.unsidedDown += c.unsidedDown; w.dOi += c.dOi; w.known += known ?? 0;
    if (c.byPrice) w.byPrice++;
    if (c.fine > 0 && c.fine >= c.counted) w.fineAll++;
  }
  w.added = w.longOpened + w.shortOpened + w.unsidedUp; w.reduced = w.longClosed + w.shortClosed + w.unsidedDown;
  return w.candles ? w : null;
}

/** The candle of `candles` (oldest first) that starts at `t`, by bisection; undefined when none does. */
function candleAt(candles: readonly CandleRow[], t: number): CandleRow | undefined {
  let lo = 0, hi = candles.length;
  while (lo < hi) { const mid = (lo + hi) >>> 1; if (candles[mid]![0] < t) lo = mid + 1; else hi = mid; }
  const c = candles[lo];
  return c && c[0] === t ? c : undefined;
}

/** The stretch's figures; null when it holds no bar. */
export function oiStretch(input: OiStretchInput): OiStretch | null {
  const { oi, change, tfMs } = input, i0 = Math.max(0, input.i0), i1 = Math.min(oi.length - 1, input.i1);
  if (!(i1 >= i0)) return null;
  const n = i1 - i0 + 1, d = (i: number): number | undefined => change.get(oi[i]![0]);
  // The chained level moves by exactly the known changes (a bar with none keeps the level), so the level before the first bar is its level less its change.
  const start = oi[i0]![4] - (d(i0) ?? 0), end = oi[i1]![4];
  let known = 0, sum = 0, flagged = 0, spans = 0, usd: number | null = input.usd ? 0 : null, venuesLow: number | null = null, venuesHigh: number | null = null, countedLow: number | null = null, countedHigh: number | null = null;
  let largest: OiStretch['largest'] = null, fall: OiStretch['fall'] = null, peak = { level: start, t: oi[i0]![0] };
  const sizes: number[] = [];
  for (let i = i0; i <= i1; i++) {
    const t = oi[i]![0], x = d(i), level = oi[i]![4];
    if (input.flag && input.flag[i] === 1) flagged++;
    if (input.venues) { const v = input.venues[i] ?? 0; venuesLow = venuesLow === null ? v : Math.min(venuesLow, v); venuesHigh = venuesHigh === null ? v : Math.max(venuesHigh, v); }
    if (input.counted) { const c = input.counted[i] ?? 0; countedLow = countedLow === null ? c : Math.min(countedLow, c); countedHigh = countedHigh === null ? c : Math.max(countedHigh, c); }
    // An unknown change: the run the largest fall is measured in starts again at this bar's level, which stands at the bar's end.
    if (x === undefined) { peak = { level, t: t + tfMs }; continue; }
    known++; sum += x;
    if (i > 0 && t - oi[i - 1]![0] > tfMs) spans++;
    if (x !== 0) sizes.push(Math.abs(x));
    if (x !== 0 && (!largest || Math.abs(x) > Math.abs(largest.change))) largest = { t, change: x };
    // Every known bar's dollars, a bar of no net change in coins too: venues valued at different prices (an inverse market at its own) can
    // add up to dollars where their coins cancel.
    // A bar without its dollars: unknown, unless one market's change of nothing (venues that cancel in coins need not cancel in dollars).
    if (usd !== null) { const u = input.usd!.get(t); if (u !== undefined) usd += u; else if (x !== 0 || input.counted) usd = null; }
    if (level > peak.level) peak = { level, t: t + tfMs };
    else if (peak.level - level > (fall?.amount ?? 0)) fall = { amount: peak.level - level, from: peak.t, to: t + tfMs };
  }
  const t0 = oi[i0]![0], t1 = oi[i1]![0] + tfMs;
  // How concentrated: the fewest bars, largest first, whose sizes reach half of all the movement.
  let half: OiStretch['half'] = null;
  if (sizes.length) {
    const movement = sizes.reduce((a, b) => a + b, 0), sorted = [...sizes].sort((a, b) => b - a);
    let got = 0, k = 0; while (k < sorted.length && got < movement / 2) got += sorted[k++]!;
    half = { bars: k, movement };
  }
  // Who: the NL/NS candles of the stretch's bars added up (the same sum the Delta pane's summary makes: `sumWho`).
  let who: OiWho | null = null;
  if (input.who) {
    const held: { c: NlnsCandle; known: number }[] = [];
    for (let i = i0; i <= i1; i++) { const c = input.who.get(oi[i]![0]); if (c) held.push({ c, known: d(i) ?? 0 }); }
    who = sumWho(held);
  }
  // Each venue's own part, bar by bar as the sum counts it (a venue whose readings start inside the stretch counts from its first).
  const carry = Math.max(2 * tfMs, 10 * 60_000);
  const venues: OiVenueChange[] = input.parts.map(part => {
    const bars = [...part.bars].sort((a, b) => a[0] - b[0]);
    let x = 0, counted = 0;
    for (let i = i0; i <= i1; i++) {
      const t = oi[i]![0], now = heldOiAt(bars, t, carry), before = heldOiAt(bars, t - tfMs, carry);
      if (now && before) { x += now[4] - before[4]; counted++; }
    }
    return { id: part.id, change: x, bars: counted };
  });
  // The price across the same candles, where the chart's candles are this coin's.
  let price: OiStretch['price'] = null;
  if (input.ownPrice) {
    const first = candleAt(input.candles, t0), last = candleAt(input.candles, oi[i1]![0]);
    let hi = -Infinity, lo = Infinity;
    for (const c of input.candles) if (c[0] >= t0 && c[0] < t1) { hi = Math.max(hi, c[2]); lo = Math.min(lo, c[3]); }
    if (first && last && first[1] > 0 && last[4] > 0) price = { open: first[1], close: last[4], high: hi, low: lo };
  }
  // Against the stretches held: the candles just before, and every window of as many candles that compares: each candle a candle long (a
  // bar a timeframe after the one before it: a change across a gap covers more, and would make "six candles" a longer stretch), its change
  // known and made of the same markets as the stretch's (a window where other markets were read would not compare). Only a
  // closed stretch is compared: a forming candle has not had its whole time.
  const support = (i: number): string => input.cohorts ? input.cohorts[i] ?? '' : input.counted ? String(input.counted[i] ?? 0) : '1';
  let same = known === n;
  for (let i = i0 + 1; same && i <= i1; i++) same = support(i) === support(i0);
  const cohort = same ? support(i0) : null;
  // Each bar's eligibility and change as prefix sums, so every window is added up at once (a year of bars and a long stretch made this
  // the summary's whole cost, once a second).
  const sums = new Float64Array(oi.length + 1), bad = new Int32Array(oi.length + 1);
  for (let i = 0; i < oi.length; i++) {
    const x = d(i), good = x !== undefined && Number.isFinite(x) && i > 0 && oi[i]![0] - oi[i - 1]![0] === tfMs && support(i) === cohort;
    sums[i + 1] = sums[i]! + (good ? x! : 0); bad[i + 1] = bad[i]! + (good ? 0 : 1);
  }
  const windowSum = (from: number): number | null => from < 0 || from + n > oi.length || bad[from + n]! - bad[from]! > 0 ? null : sums[from + n]! - sums[from]!;
  const forming = input.formingFrom ?? Infinity, closed = oi[i1]![0] < forming, held = closed && cohort !== null && cohort !== '' && windowSum(i0) !== null;
  const before = held && i0 - n >= 0 && oi[i0]![0] - oi[i0 - 1]![0] === tfMs ? windowSum(i0 - n) : null;
  let rank: OiStretch['rank'] = null;
  if (held) {
    // Windows of closed candles only: the one under way has not had its whole time.
    let last = oi.length; while (last > 0 && oi[last - 1]![0] >= forming) last--;
    let of = 0, larger = 0;
    // The stretch's own window counts among them but never as larger than itself (its prefix difference need not equal `sum` to the last bit).
    for (let from = 0; from + n <= last; from++) { const s = windowSum(from); if (s === null) continue; of++; if (from !== i0 && Math.abs(s) > Math.abs(sum) * (1 + 1e-12) + 1e-9) larger++; }
    if (of > 1) rank = { larger, of };
  }
  return { t0, t1, bars: n, known, start, end, change: sum, usd, fall, largest, half, flagged, venuesLow, venuesHigh, countedLow, countedHigh, spans, who, venues, price, before, rank };
}
