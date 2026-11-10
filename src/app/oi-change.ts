import type { CandleRow, OiBar } from './store.ts';

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

/**
 * One venue's open-interest bars (its perpetual, in coins) on the chart's timeframe. `usdAt`: an inverse market's coins are its USD over this
 * one price (`Hub.oiSeries`), so its change in USD is its change in coins times it.
 */
export interface OiPart { id: string; bars: readonly OiBar[]; usdAt?: number }

/**
 * The bars read again from `from` on (`tail`, the 20-second refresh: Karl, 2026-10-30, every venue's 500 bars read again every 20 s were
 * half of a timeframe switch's requests) put on those held: the held ones from `keepFrom` until the tail's first, then the tail's. A tail
 * that brought nothing (a failed read) takes nothing back.
 */
export function oiTail(held: readonly OiBar[], tail: readonly OiBar[], from: number, keepFrom: number): OiBar[] {
  const start = tail.length ? Math.max(from, tail[0]![0]) : Infinity;
  return [...held.filter(b => b[0] >= keepFrom && b[0] < start), ...tail.filter(b => b[0] >= start)];
}

/**
 * Up to this long a venue's reading holds until its next one: open interest is a level, and the history some venues keep is hourly (Bybit's
 * and OKX's before their last two days). A longer silence is a gap, not a flat level (a server that was not running).
 */
export const OI_HOLD_MS = 2 * 3_600_000;
/**
 * A venue's bar at `t` from its bars oldest first: its own, else its last reading held (as a flat bar) while its next reading comes within
 * `OI_HOLD_MS` of it, or for `carryMs` after its newest (the next is still to come); null where it has no reading to stand on.
 */
export function heldOiAt(bars: readonly OiBar[], t: number, carryMs: number, holdMs = OI_HOLD_MS): OiBar | null {
  let lo = 0, hi = bars.length;
  while (lo < hi) { const mid = (lo + hi) >>> 1; if (bars[mid]![0] <= t) lo = mid + 1; else hi = mid; }
  const last = bars[lo - 1], next = bars[lo];
  if (!last) return null;
  if (last[0] === t) return last;
  return (next && next[0] - last[0] <= holdMs) || t - last[0] <= carryMs ? [t, last[4], last[4], last[4], last[4]] : null;
}
/**
 * Several venues' open interest added together (the aggregated pane): `bars` the sum at every bar time any of them has, `venues` how many
 * it counts there, and `change` each bar's change of open interest with `counted`, the venues it is made of.
 *
 * Open interest is a level read now and then, so a venue with no bar at a time is counted at its last reading (`heldOiAt`: until its next one
 * within two hours, or for `carryMs` after its newest). A bar's change is the sum of each venue's own change from the bar before (one timeframe
 * earlier) over the venues present at both, never the difference of two sums: a venue whose readings start (or stop) would otherwise show
 * as its whole open interest opened (or closed) in one bar. A bar with no venue present at both has no change.
 */
export interface OiSum { bars: OiBar[]; venues: number[]; change: Map<number, number>; counted: Map<number, number> }
export function sumOi(parts: readonly OiPart[], tfMs: number, carryMs = Math.max(2 * tfMs, 10 * 60_000)): OiSum {
  const times = [...new Set(parts.flatMap(p => p.bars.map(b => b[0])))].sort((a, b) => a - b);
  const sorted = parts.map(part => [...part.bars].sort((a, b) => a[0] - b[0]));
  const barAt = (bars: readonly OiBar[], t: number): OiBar | null => heldOiAt(bars, t, carryMs);
  const bars: OiBar[] = [], venues: number[] = [], change = new Map<number, number>(), counted = new Map<number, number>();
  times.forEach(t => {
    const bar: OiBar = [t, 0, 0, 0, 0]; let n = 0, d = 0, both = 0;
    for (const series of sorted) {
      const b = barAt(series, t); if (!b) continue;
      n++; bar[1] += b[1]; bar[2] += b[2]; bar[3] += b[3]; bar[4] += b[4];
      // The reading one timeframe before, carried as above: a venue read every five minutes on a one-minute chart changes in the bar of its
      // new reading, by the whole step from the last.
      const before = barAt(series, t - tfMs);
      if (before) { d += b[4] - before[4]; both++; }
    }
    if (!n) return;
    bars.push(bar); venues.push(n);
    if (both) { change.set(t, d); counted.set(t, both); }
  });
  return { bars, venues, change, counted };
}

/** One venue's open interest at a bar: in coins, its own change from the bar before (null with no reading then), and its share of the venues read at that bar. */
export interface OiVenue { id: string; oi: number; change: number | null; share: number }
const ordered = new WeakMap<readonly OiBar[], readonly OiBar[]>();
const orderedBars = (bars: readonly OiBar[]): readonly OiBar[] => { let held = ordered.get(bars); if (!held) { held = [...bars].sort((a, b) => a[0] - b[0]); ordered.set(bars, held); } return held; };
/**
 * The venues added together, as they stood at bar `t`, counted as `sumOi` counts them (a venue with no bar then at its last reading, while that holds; none to stand on: left
 * out). Largest first by each one's newest reading, so that the rows keep their places as the pointer moves.
 */
export function oiVenuesAt(parts: readonly OiPart[], tfMs: number, t: number, carryMs = Math.max(2 * tfMs, 10 * 60_000)): OiVenue[] {
  const read = parts.flatMap(part => {
    const bars = orderedBars(part.bars), now = heldOiAt(bars, t, carryMs), before = heldOiAt(bars, t - tfMs, carryMs);
    return now ? [{ id: part.id, oi: now[4], change: before ? now[4] - before[4] : null, newest: bars[bars.length - 1]![4] }] : [];
  }).sort((a, b) => b.newest - a.newest);
  const total = read.reduce((sum, v) => sum + v.oi, 0);
  return read.map(({ id, oi, change }) => ({ id, oi, change, share: total > 0 ? oi / total : 0 }));
}

const cuts = new WeakMap<readonly OiPart[], { tfMs: number; until: number; parts: OiPart[] }>();
/**
 * The venues' bars that ended by `until` (replay; Infinity: as they are), worked out once per moment: the sum must be made of these, not cut
 * after it is made, or a reading held until its next would stand on a reading after the moment shown. NL/NS cuts its parts the same way.
 */
export function oiPartsUntil(parts: readonly OiPart[], tfMs: number, until: number): readonly OiPart[] {
  if (!Number.isFinite(until)) return parts;
  const held = cuts.get(parts);
  if (held && held.tfMs === tfMs && held.until === until) return held.parts;
  // Each part as it is (an inverse market's `usdAt` too), its bars cut.
  const out = parts.map(part => ({ ...part, bars: part.bars.filter(b => b[0] + tfMs <= until) }));
  cuts.set(parts, { tfMs, until, parts: out });
  return out;
}

/** A market whose open interest is counted in USD (Deribit's BTC and ETH perpetuals, Bybit's coin-margined ones): its readings come as coins at each reading's price. */
export const inverseOi = (id: string): boolean => /^deribit:[A-Z]+-PERPETUAL$/.test(id) || /^bybit:[A-Z0-9]+USD$/.test(id);
/**
 * An inverse market's bars in coins at one price, the newest close of `candles` (oldest first): read as coins at each reading's price, its
 * open interest would move with the price while no contract opened or closed (a 2 % move would read as 2 % of it opened or closed). Each
 * reading is put back into USD at the close of its candle (the nearest before it where the candle is missing) and divided by that one price;
 * bars before the first candle are left out. Without candles the bars are returned as they are.
 */
export function atOnePrice(bars: readonly OiBar[], candles: readonly CandleRow[], at?: number): readonly OiBar[] {
  const now = at ?? candles[candles.length - 1]?.[4];
  if (!(now! > 0) || !candles.length) return bars;
  const out: OiBar[] = [];
  let k = 0;
  for (const bar of [...bars].sort((a, b) => a[0] - b[0])) {
    while (k + 1 < candles.length && candles[k + 1]![0] <= bar[0]) k++;
    const c = candles[k]!;
    if (c[0] > bar[0] || !(c[4] > 0)) continue;
    const f = c[4] / now!;
    out.push([bar[0], bar[1] * f, bar[2] * f, bar[3] * f, bar[4] * f]);
  }
  return out;
}

const chains = new WeakMap<OiSum, OiBar[]>();
/**
 * The level the OI pane draws with venues added together: chained from each bar's change (`OiSum.change`, each venue's own, as the bars
 * below it count it), ending at the venues' total at the newest bar. The sum itself steps whenever a venue's readings start or stop (on the
 * website most venues start when the page opens), which drew a jump the bars, rightly, did not show (Karl, 2026-10-14); the chained level
 * moves exactly as the bars do, and is the total now. Worked out once per sum.
 */
export function chainedOi(sum: OiSum): OiBar[] {
  const held = chains.get(sum); if (held) return held;
  const bars = sum.bars, out: OiBar[] = new Array<OiBar>(bars.length);
  let level = bars[bars.length - 1]?.[4] ?? 0;
  for (let i = bars.length - 1; i >= 0; i--) { const t = bars[i]![0]; out[i] = [t, level, level, level, level]; level -= sum.change.get(t) ?? 0; }
  chains.set(sum, out);
  return out;
}

const sums = new WeakMap<readonly OiPart[], { tfMs: number; sum: OiSum }>();
/** `sumOi` worked out once per set of parts and timeframe (what the store holds is replaced, never changed, so its reference says when). */
export function oiSumOf(parts: readonly OiPart[], tfMs: number): OiSum {
  const held = sums.get(parts);
  if (held && held.tfMs === tfMs) return held.sum;
  const sum = sumOi(parts, tfMs); sums.set(parts, { tfMs, sum });
  return sum;
}

/**
 * Each bar's change of open interest in USD, by bar time: each venue's own change (as `sumOi` counts it) at the bar's close (`closeAt`), an
 * inverse market's at the one price its coins were put at (`usdAt`; `usdAt` for one market's `bars`), so it is its change in its own USD and
 * not that put at another candle's price. A bar a linear market's change is in with no close has none.
 */
export function oiUsdChangeByTime(bars: readonly OiBar[], parts: readonly OiPart[], tfMs: number, closeAt: (t: number) => number | undefined, usdAt = 0): Map<number, number> {
  const out = new Map<number, number>();
  if (parts.length <= 1) {
    for (const [t, change] of oiDeltaByTime(bars)) { const price = usdAt > 0 ? usdAt : closeAt(t); if (price !== undefined) out.set(t, change * price); }
    return out;
  }
  const carryMs = Math.max(2 * tfMs, 10 * 60_000), sorted = parts.map(part => ({ usdAt: part.usdAt, bars: [...part.bars].sort((a, b) => a[0] - b[0]) }));
  for (const t of [...new Set(parts.flatMap(p => p.bars.map(b => b[0])))].sort((a, b) => a - b)) {
    let usd = 0, any = false, known = true;
    for (const series of sorted) {
      const now = heldOiAt(series.bars, t, carryMs), before = heldOiAt(series.bars, t - tfMs, carryMs);
      if (!now || !before) continue;
      const price = series.usdAt !== undefined && series.usdAt > 0 ? series.usdAt : closeAt(t);
      if (price === undefined) { known = false; break; }
      usd += (now[4] - before[4]) * price; any = true;
    }
    if (any && known) out.set(t, usd);
  }
  return out;
}

/**
 * Each bar's change of open interest, by bar time, as every view of it counts it: the venues' own changes added up when the pane adds venues
 * together (`parts`), else the bar's close minus the close of the bar before.
 */
export function oiChangeByTime(bars: readonly OiBar[], parts: readonly OiPart[], tfMs: number): Map<number, number> {
  return parts.length > 1 ? oiSumOf(parts, tfMs).change : oiDeltaByTime(bars);
}
