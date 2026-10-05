import type { Bar } from './panes/footprint.ts';
import type { CandleRow } from './store.ts';
import { price as fmtPrice, usd } from './format.ts';

/**
 * Possibly trapped buyers or sellers on a closed candle, from the candle and its footprint alone.
 *
 * The pattern: a candle with a long wick whose rows hold more net aggressive buying (selling for the lower wick) than any equally tall
 * stretch of the rest of the candle, and a close far from where those aggressors bought. If they still hold, they are underwater.
 * That is all this claims, and it is labelled "possible": no test of the pattern has been run (see docs/trapped-traders.md). Everything
 * below is a pure function of its inputs, so it can be unit-tested and gives the same answer at any zoom.
 */

export const TRAP_PARAMS = Object.freeze({
  /** The wick must be at least this share of the candle's range. */
  wick: 1 / 3,
  /** Net delta in the wick must be at least this many times a typical candle's absolute net delta. */
  deltaMultiple: 1,
  /**
   * The close must be at least this many ATRs beyond the aggressors' average entry. Chosen from the pre-registered grid by how often it
   * fires and nothing else: on 21 h of recorded Binance perpetual footprints half an ATR flagged 5.5 % of 5m and 7.8 % of 15m candles
   * (too many for a cue that pulses), one ATR flagged 1.4 % and 1.6 % (docs/trapped-traders.md).
   */
  excursion: 1,
  /** The wick must span at least this many rows at the canonical step. */
  minRows: 3,
  /** Candles in the ATR, and in the typical-delta baseline (at least `minBaseline` of them must have complete footprints). */
  atrLength: 20, minAtr: 10, baselineLength: 72, minBaseline: 12,
  /** Rows per typical candle at the canonical step: the step is the finest recorded step times a power of two that keeps a typical range under this. */
  maxRows: 64,
  /** Share of a candle's minutes that must have been recorded for its footprint to count as complete. */
  coverage: 0.9,
  /** A candle is judged this long after it closes, so late prints have arrived; results are kept once it is a minute old. */
  settleMs: 15_000, freezeMs: 60_000,
  /** A trap pulses for this many candles after the one that made it, unless price has closed back through the entry. */
  pulseBars: 12,
});

/** The tunable thresholds (a study of the pattern varies these; the app uses `TRAP_PARAMS`). */
export type TrapParams = { readonly wick: number; readonly deltaMultiple: number; readonly excursion: number; readonly minRows: number };

export type TrapSide = 'buyers' | 'sellers';
export interface Trap {
  /** Start of the candle. */
  t: number; side: TrapSide;
  /** Price span of the wick the aggressors traded in. */
  zoneLow: number; zoneHigh: number;
  /** Net aggressive USD in the zone on the trapped side (positive), and how many typical candles' net delta that is. */
  zoneDelta: number; multiple: number;
  /** Volume-weighted price those aggressors paid or received, and how far the close is beyond it in ATRs. */
  entry: number; excursion: number; close: number;
  /** Pulsing (recent and not reclaimed), static (older), or reclaimed (a later candle closed back through the entry). */
  state: 'active' | 'static' | 'reclaimed';
}

/** The row step used for detection whatever the zoom: the finest recorded step times a power of two, so a typical candle spans at most `maxRows` rows. */
export function canonicalStep(fine: number, typicalRange: number): number {
  if (!(fine > 0)) return 0;
  let step = fine;
  while (typicalRange / step > TRAP_PARAMS.maxRows) step *= 2;
  return step;
}

/** Median true range of the last `atrLength` candles before index `end` (exclusive), or null with too few. */
export function typicalRange(candles: readonly CandleRow[], end: number): number | null {
  const ranges: number[] = [];
  for (let i = Math.max(1, end - TRAP_PARAMS.atrLength); i < end; i++) {
    const c = candles[i]!, previous = candles[i - 1]![4];
    ranges.push(Math.max(c[2] - c[3], Math.abs(c[2] - previous), Math.abs(c[3] - previous)));
  }
  if (ranges.length < TRAP_PARAMS.minAtr) return null;
  ranges.sort((a, b) => a - b);
  return ranges[ranges.length >> 1]!;
}

/** Mean true range of the `atrLength` candles before index `end`, or null with too few. */
function atrBefore(candles: readonly CandleRow[], end: number): number | null {
  let sum = 0, n = 0;
  for (let i = Math.max(1, end - TRAP_PARAMS.atrLength); i < end; i++) {
    const c = candles[i]!, previous = candles[i - 1]![4];
    sum += Math.max(c[2] - c[3], Math.abs(c[2] - previous), Math.abs(c[3] - previous)); n++;
  }
  return n >= TRAP_PARAMS.minAtr && sum > 0 ? sum / n : null;
}

/** A bar whose recorded minutes cover (nearly) all of its candle, so the footprint is the whole candle and not what happened to be seen. */
export function complete(bar: Bar | undefined, tfMs: number): bar is Bar {
  return !!bar && (bar.minutes ?? 0) >= TRAP_PARAMS.coverage * (tfMs / 60_000);
}

/** Median absolute net delta of the candles before `t` that have complete footprints, or null with too few. */
export function typicalDelta(bars: ReadonlyMap<number, Bar>, t: number, tfMs: number): number | null {
  const values: number[] = [];
  for (let k = 1; k <= TRAP_PARAMS.baselineLength; k++) {
    const bar = bars.get(t - k * tfMs);
    if (complete(bar, tfMs)) values.push(Math.abs(bar.buyUsd - bar.sellUsd));
  }
  if (values.length < TRAP_PARAMS.minBaseline) return null;
  values.sort((a, b) => a - b);
  return values[values.length >> 1]!;
}

/**
 * Judge one closed candle for one side. `rows` are [price low, buy USD, sell USD] at `step`. Prices are mirrored for the lower wick so a
 * single implementation covers both: the "upper wick" below is the wick on the side the aggressors were trapped on.
 */
export function detectSide(side: TrapSide, candle: CandleRow, rows: readonly [number, number, number][], step: number, atr: number, baseline: number, params: TrapParams = TRAP_PARAMS): Trap | null {
  const dir = side === 'buyers' ? 1 : -1;
  const [t, open, high, low, close] = candle;
  const range = high - low;
  if (!(range > 0) || !(step > 0) || !(atr > 0)) return null;
  // Mirrored coordinates: price' rises toward the wick the aggressors traded in.
  const top = dir > 0 ? Math.max(open, close) : -Math.min(open, close), extreme = dir > 0 ? high : -low;
  const wick = extreme - top;
  if (wick / range < params.wick) return null;
  const zoneRows = Math.ceil(wick / step - 1e-9);
  if (zoneRows < params.minRows) return null;
  // Row index in mirrored coordinates (a row [low, low + step) becomes [-low - step, -low), whose low edge index is -idx - 1).
  const index = (rowLow: number): number => dir > 0 ? Math.round(rowLow / step) : -Math.round(rowLow / step) - 1;
  const mid = (idx: number): number => (idx + 0.5) * step;
  let zoneDelta = 0, trapped = 0, trappedPrice = 0;
  const below = new Map<number, number>();
  let lowest = Infinity;
  for (const [rowLow, buy, sell] of rows) {
    const idx = index(rowLow), delta = dir > 0 ? buy - sell : sell - buy, aggressor = dir > 0 ? buy : sell;
    if (mid(idx) >= top) { zoneDelta += delta; trapped += aggressor; trappedPrice += aggressor * mid(idx); }
    else { below.set(idx, (below.get(idx) ?? 0) + delta); lowest = Math.min(lowest, idx); }
  }
  if (!(zoneDelta > 0) || !(trapped > 0)) return null;
  // F1: the wick out-bought every equally tall stretch of the rest of the candle (or all of it, when the rest is shorter than the wick).
  const highest = Math.ceil(top / step - 0.5) - 1;
  let reference = 0;
  if (below.size) {
    const length = highest - lowest + 1;
    if (length < zoneRows) { for (const delta of below.values()) reference += delta; }
    else {
      let window = 0;
      for (let k = 0; k < length; k++) {
        window += below.get(lowest + k) ?? 0;
        if (k >= zoneRows) window -= below.get(lowest + k - zoneRows) ?? 0;
        if (k >= zoneRows - 1) reference = k === zoneRows - 1 ? window : Math.max(reference, window);
      }
    }
  }
  if (zoneDelta < reference) return null;
  if (!(baseline > 0) || zoneDelta < params.deltaMultiple * baseline) return null;
  const entry = dir * (trappedPrice / trapped), excursion = dir * (entry - close) / atr;
  if (excursion < params.excursion) return null;
  const zoneEdge = dir * top;
  return { t, side, zoneLow: dir > 0 ? zoneEdge : low, zoneHigh: dir > 0 ? high : zoneEdge, zoneDelta, multiple: zoneDelta / baseline, entry, excursion, close, state: 'static' };
}

export interface ScanInput {
  /** Closed and forming candles of the market, oldest first. */
  candles: readonly CandleRow[];
  /** Footprint bars at the canonical step, keyed by candle start. */
  bars: ReadonlyMap<number, Bar>;
  step: number; tfMs: number; now: number;
  /** Candle starts to judge: [from, to). */
  from: number; to: number;
  params?: TrapParams;
}

/** Every trap in [from, to), oldest first, with the state of each at `now`. Forming and unsettled candles are never judged. */
export function scanTraps({ candles, bars, step, tfMs, now, from, to, params = TRAP_PARAMS }: ScanInput): Trap[] {
  const found: Trap[] = [];
  const settled = (c: CandleRow): boolean => c[0] + tfMs + TRAP_PARAMS.settleMs <= now;
  for (let i = 1; i < candles.length; i++) {
    const c = candles[i]!;
    if (c[0] < from || c[0] >= to || !settled(c)) continue;
    const bar = bars.get(c[0]);
    if (!complete(bar, tfMs)) continue;
    const atr = atrBefore(candles, i), baseline = typicalDelta(bars, c[0], tfMs);
    if (atr === null || baseline === null) continue;
    for (const side of ['buyers', 'sellers'] as const) { const trap = detectSide(side, c, bar.rows, step, atr, baseline, params); if (trap) found.push(trap); }
  }
  // State: reclaimed when a later settled candle closed back through the entry; pulsing while recent.
  const closed = candles.filter(settled);
  const lastClosed = closed.length ? closed[closed.length - 1]![0] : -Infinity;
  for (const trap of found) {
    const reclaimed = closed.some(c => c[0] > trap.t && (trap.side === 'buyers' ? c[4] >= trap.entry : c[4] <= trap.entry));
    const age = Math.round((lastClosed - trap.t) / tfMs);
    trap.state = reclaimed ? 'reclaimed' : age <= TRAP_PARAMS.pulseBars ? 'active' : 'static';
  }
  return found;
}

/** What the pop-up says (lines, shortest first), written as facts about the candle plus the one thing this cannot know. */
export function trapText(trap: Trap): string[] {
  const buyers = trap.side === 'buyers', multiple = trap.multiple >= 10 ? trap.multiple.toFixed(0) : trap.multiple.toFixed(1);
  const lines = [
    buyers ? 'Possible trapped buyers' : 'Possible trapped sellers',
    `$${usd(trap.zoneDelta)} net aggressive ${buyers ? 'buying in the upper wick' : 'selling in the lower wick'}, ${multiple}x a typical candle's net delta`,
    `average ${buyers ? 'entry' : 'sale'} ${fmtPrice(trap.entry)}; the candle closed ${trap.excursion.toFixed(1)} ATR ${buyers ? 'below' : 'above'}`,
  ];
  lines.push(trap.state === 'reclaimed' ? 'Price has since closed back through that level.' : `If they still hold, they are ${buyers ? 'underwater' : 'losing'}.`);
  lines.push('Untested pattern, not a forecast.');
  return lines;
}

/** Candles of footprint kept in view of detection at most (the window grows with how far back the chart is panned). */
const MAX_WINDOW_BARS = 300;

/**
 * The footprint at the canonical row step and the traps found in it. It loads its own window (the candles on screen plus the history the
 * baseline needs), independently of the footprint the chart is drawing, so a flag does not change when the chart is zoomed.
 */
export class TrapData {
  traps: Trap[] = [];
  step = 0;
  #key = ''; #loadedAt = 0; #busy = false;

  clear(): void { this.traps = []; this.step = 0; this.#key = ''; }

  /**
   * Refresh when the window, market, timeframe or canonical step changed, or the data is five seconds old. `candles` are the market's own
   * candles (the caller checks that they belong to `inst`) and `fine` is the finest recorded row step.
   */
  ensure(args: {
    inst: string; tf: string; tfMs: number; candles: readonly CandleRow[]; fine: number; view: { t0: number; t1: number };
    load: (inst: string, tf: string, from: number, to: number, rowStep: number) => Promise<{ step: number; bars: Bar[] }>; onLoad: () => void;
  }): void {
    const { inst, tf, tfMs, candles, fine, view, load, onLoad } = args;
    const range = candles.length > 1 ? typicalRange(candles, candles.length - 1) : null;
    if (range === null || !(fine > 0)) { this.clear(); return; }
    const step = canonicalStep(fine, range);
    const last = Math.ceil((view.t1 + tfMs) / tfMs) * tfMs;
    const first = Math.max(last - MAX_WINDOW_BARS * tfMs, Math.floor((view.t0 - (TRAP_PARAMS.baselineLength + 1) * tfMs) / tfMs) * tfMs);
    const key = `${inst}|${tf}|${step}|${first}|${last}`;
    if (this.#busy || (key === this.#key && performance.now() - this.#loadedAt < 5_000)) return;
    this.#busy = true; this.#key = key;
    load(inst, tf, first, last, step).then(body => {
      const bars = new Map(body.bars.map(b => [b.t, b] as const));
      this.step = body.step;
      this.traps = body.step > 0 ? scanTraps({ candles, bars, step: body.step, tfMs, now: Date.now(), from: view.t0 - tfMs, to: view.t1 + tfMs }) : [];
      this.#loadedAt = performance.now(); onLoad();
    }).catch(error => console.error('trap scan failed', error)).finally(() => { this.#busy = false; });
  }

  /** The traps on the candle starting at `t` (a candle can have one on each wick). */
  on(t: number): Trap[] { return this.traps.filter(trap => trap.t === t); }
}
