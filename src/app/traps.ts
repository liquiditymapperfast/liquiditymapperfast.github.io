import type { Bar } from './panes/footprint.ts';
import type { CandleRow } from './store.ts';
import { price as fmtPrice, usd } from './format.ts';
import { t } from './i18n.ts';

/**
 * Rejected aggressive buying or selling on a closed candle, from the candle and its footprint alone.
 *
 * The pattern: a candle with a long wick whose rows hold more net aggressive buying (selling for the lower wick) than any equally tall
 * stretch of the rest of the candle, and a close far from where those aggressors bought. It describes flow that price then rejected; it
 * does not say who is holding what, and no test of the pattern has shown that it predicts anything (see docs/trapped-traders.md).
 * Everything below is a pure function of its inputs, so it can be unit-tested and gives the same answer at any zoom, and each
 * candle's answer is made once and kept (`TrapData`).
 */

/** Bumped whenever the rule, or what it reads, changes: a decision kept from another version is made again. */
export const TRAP_VERSION = 2;

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
  /**
   * A footprint counts as the whole candle when the volume it holds (USD over each row's price, so in the asset's own units) is within
   * this band of the volume the exchange reports for the candle. A candle that was seen only in part falls short; a quiet minute does not,
   * because the exchange's own figure is quiet there too; a footprint in other units, or of another market, falls outside.
   */
  coverageMin: 0.9, coverageMax: 1.1,
  /** A candle is judged this long after it closes, so late prints have arrived; its answer is kept once it is a minute older. */
  settleMs: 15_000, freezeMs: 60_000,
  /** A flag pulses for this many candles after the one that made it, unless price has closed back through the entry. */
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
  /** Net aggressive USD in the zone on the flagged side (positive), and how many typical candles' net delta that is. */
  zoneDelta: number; multiple: number;
  /** What was bought and sold at market in the zone (USD), and what was traded in the whole candle: dominance, not only size. */
  zoneBuy: number; zoneSell: number; barGross: number;
  /** Volume-weighted price those aggressors paid or received (an estimate: a row is its middle), and how far the close is beyond it in ATRs. */
  entry: number; excursion: number; close: number;
  /** Pulsing (recent and not reclaimed), static (older), or reclaimed (a later candle closed back through the entry). */
  state: 'active' | 'static' | 'reclaimed';
}

/** What the zone says beyond its net size: net over gross volume (0..1) and the wick's share of the candle's volume. */
export const imbalanceOf = (trap: Trap): number => trap.zoneBuy + trap.zoneSell > 0 ? trap.zoneDelta / (trap.zoneBuy + trap.zoneSell) : 0;
export const wickShareOf = (trap: Trap): number => trap.barGross > 0 ? (trap.zoneBuy + trap.zoneSell) / trap.barGross : 0;

/** The row step used for detection: the finest recorded step times a power of two, so a typical candle spans at most `maxRows` rows. */
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

/** What a candle's footprint adds up to, kept apart from its rows so the baseline can read it whatever grid the rows were loaded at. */
export interface BarFacts { buyUsd: number; sellUsd: number; share: number | null }

/**
 * The share of the exchange's own candle volume that the footprint holds: its USD over each row's middle price, in the asset's units,
 * against the candle's volume. Null when the candle has no volume to compare with (so nothing can be said). This is what tells a
 * recorded candle from a partly seen one: it moves when trades were missed, not when trading was quiet.
 */
export function recordedShare(bar: Bar, candle: CandleRow | undefined, step: number): number | null {
  const volume = candle?.[5];
  if (!(volume! > 0) || !(step > 0)) return null;
  let base = 0;
  for (const [low, buy, sell] of bar.rows) base += (buy + sell) / (low + step / 2);
  return base / volume!;
}

export const factsOf = (bar: Bar, candle: CandleRow | undefined, step: number): BarFacts => ({ buyUsd: bar.buyUsd, sellUsd: bar.sellUsd, share: recordedShare(bar, candle, step) });

/** Whether a candle's footprint holds (about) all of its volume. */
export function complete(facts: BarFacts | undefined): facts is BarFacts {
  return !!facts && facts.share !== null && facts.share >= TRAP_PARAMS.coverageMin && facts.share <= TRAP_PARAMS.coverageMax;
}

/** Median absolute net delta of the candles before `t` that have complete footprints, or null with too few. */
export function typicalDelta(facts: ReadonlyMap<number, BarFacts>, t: number, tfMs: number): number | null {
  const values: number[] = [];
  for (let k = 1; k <= TRAP_PARAMS.baselineLength; k++) {
    const f = facts.get(t - k * tfMs);
    if (complete(f)) values.push(Math.abs(f.buyUsd - f.sellUsd));
  }
  if (values.length < TRAP_PARAMS.minBaseline) return null;
  values.sort((a, b) => a - b);
  return values[values.length >> 1]!;
}

/**
 * Judge one closed candle for one side. `rows` are [price low, buy USD, sell USD] at `step`. Prices are mirrored for the lower wick so a
 * single implementation covers both: the "upper wick" below is the wick on the side the aggressors traded in.
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
  let zoneDelta = 0, aggressors = 0, aggressorPrice = 0, zoneBuy = 0, zoneSell = 0, barGross = 0;
  const below = new Map<number, number>();
  let lowest = Infinity;
  for (const [rowLow, buy, sell] of rows) {
    const idx = index(rowLow), delta = dir > 0 ? buy - sell : sell - buy, aggressor = dir > 0 ? buy : sell;
    barGross += buy + sell;
    if (mid(idx) >= top) { zoneDelta += delta; aggressors += aggressor; aggressorPrice += aggressor * mid(idx); zoneBuy += buy; zoneSell += sell; }
    else { below.set(idx, (below.get(idx) ?? 0) + delta); lowest = Math.min(lowest, idx); }
  }
  if (!(zoneDelta > 0) || !(aggressors > 0)) return null;
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
  const entry = dir * (aggressorPrice / aggressors), excursion = dir * (entry - close) / atr;
  if (excursion < params.excursion) return null;
  const zoneEdge = dir * top;
  return { t, side, zoneLow: dir > 0 ? zoneEdge : low, zoneHigh: dir > 0 ? high : zoneEdge, zoneDelta, multiple: zoneDelta / baseline, zoneBuy, zoneSell, barGross, entry, excursion, close, state: 'static' };
}

/**
 * What was decided about one candle. `insufficient` and `warmup` are not the same as `none`: the first says the recording does not cover the
 * candle (or has no volume to check it against), the second that there is not yet enough earlier history to compare it with; `none` says the
 * candle was complete, was compared, and nothing met the rule.
 */
export type Verdict = 'trap' | 'none' | 'insufficient' | 'warmup';
export interface Decision {
  /** Start of the candle. */
  t: number; verdict: Verdict; traps: Trap[];
  /** The grid the footprint was read on (0 when no grid was needed), the share of the candle's volume it held, and the rule's version. */
  step: number; share: number | null; version: number;
}

/** A candle is judged once it has settled: its late prints have arrived. */
export const settled = (candle: CandleRow, tfMs: number, now: number): boolean => candle[0] + tfMs + TRAP_PARAMS.settleMs <= now;

/** The grid for a candle: from the volatility before it, so the answer does not depend on what the market did afterwards. 0 until there is enough history. */
export function stepFor(candles: readonly CandleRow[], index: number, fine: number): number {
  const range = typicalRange(candles, index);
  return range === null ? 0 : canonicalStep(fine, range);
}

/** Decide one candle from what was known at its close: the candles before it, its footprint on its own grid, and the footprints before it. */
export function judgeCandle(o: { candles: readonly CandleRow[]; index: number; bar: Bar | undefined; step: number; facts: ReadonlyMap<number, BarFacts>; tfMs: number; params?: TrapParams }): Decision {
  const { candles, index, bar, step, facts, tfMs, params = TRAP_PARAMS } = o, c = candles[index]!;
  const made = (verdict: Verdict, traps: Trap[] = [], share: number | null = null): Decision => ({ t: c[0], verdict, traps, step, share, version: TRAP_VERSION });
  const atr = atrBefore(candles, index);
  if (atr === null) return made('warmup');
  const own = bar ? factsOf(bar, c, step) : undefined;
  if (!bar || !complete(own)) return made('insufficient', [], own?.share ?? null);
  const baseline = typicalDelta(facts, c[0], tfMs);
  if (baseline === null) return made('warmup', [], own.share);
  const traps: Trap[] = [];
  for (const side of ['buyers', 'sellers'] as const) { const trap = detectSide(side, c, bar.rows, step, atr, baseline, params); if (trap) traps.push(trap); }
  return made(traps.length ? 'trap' : 'none', traps, own.share);
}

/** The state of each trap at `now`: reclaimed when a later settled candle closed back through the entry; pulsing while recent. */
export function withStates(traps: Trap[], candles: readonly CandleRow[], tfMs: number, now: number): Trap[] {
  const closed = candles.filter(c => settled(c, tfMs, now));
  const lastClosed = closed.length ? closed[closed.length - 1]![0] : -Infinity;
  for (const trap of traps) {
    const reclaimed = closed.some(c => c[0] > trap.t && (trap.side === 'buyers' ? c[4] >= trap.entry : c[4] <= trap.entry));
    const age = Math.round((lastClosed - trap.t) / tfMs);
    trap.state = reclaimed ? 'reclaimed' : age <= TRAP_PARAMS.pulseBars ? 'active' : 'static';
  }
  return traps;
}

export interface ScanInput {
  /** Closed and forming candles of the market, oldest first. */
  candles: readonly CandleRow[];
  /** Footprint bars at one grid, keyed by candle start. */
  bars: ReadonlyMap<number, Bar>;
  step: number; tfMs: number; now: number;
  /** Candle starts to judge: [from, to). */
  from: number; to: number;
  params?: TrapParams;
}

/** Every flag in [from, to) with the whole footprint on one grid, oldest first, with the state of each at `now`. Forming and unsettled candles are never judged. */
export function scanTraps({ candles, bars, step, tfMs, now, from, to, params = TRAP_PARAMS }: ScanInput): Trap[] {
  const found: Trap[] = [], at = new Map(candles.map(c => [c[0], c] as const)), facts = new Map<number, BarFacts>();
  for (const [t0, bar] of bars) facts.set(t0, factsOf(bar, at.get(t0), step));
  for (let i = 1; i < candles.length; i++) {
    const c = candles[i]!;
    if (c[0] < from || c[0] >= to || !settled(c, tfMs, now)) continue;
    found.push(...judgeCandle({ candles, index: i, bar: bars.get(c[0]), step, facts, tfMs, params }).traps);
  }
  return withStates(found, candles, tfMs, now);
}

/**
 * What the offline study found (docs/trapped-traders.md): the cue was tested on Binance BTCUSDT perpetual history only, and only at 15m
 * did anything survive (its levels were revisited somewhat less often than look-alike candles' were), with no direction to rely on.
 * Anywhere else it has not been looked at, and the pop-up says so rather than implying the result carries over.
 */
export function trapVerdict(scope?: { market: string; timeframe: string }): string {
  return scope?.market === 'binance:BTCUSDT' && scope.timeframe === '15m'
    ? t('Tested on Binance BTCUSDT perpetual history: no reliable direction; at 15m these levels were revisited somewhat less often than look-alike candles. Not a forecast.')
    : t('Not validated for this market and timeframe. Not a forecast.');
}

/** What the pop-up says (lines, shortest first): facts about the candle, and nothing about who holds what. */
export function trapText(trap: Trap, scope?: { market: string; timeframe: string }): string[] {
  const buyers = trap.side === 'buyers', multiple = trap.multiple >= 10 ? trap.multiple.toFixed(0) : trap.multiple.toFixed(1);
  const lines = [
    buyers ? t('Rejected aggressive buying') : t('Rejected aggressive selling'),
    buyers ? t("${amount} net aggressive buying in the upper wick, {multiple}x a typical candle's net delta", { amount: usd(trap.zoneDelta), multiple }) : t("${amount} net aggressive selling in the lower wick, {multiple}x a typical candle's net delta", { amount: usd(trap.zoneDelta), multiple }),
    t("Wick volume: ${buy} bought and ${sell} sold at market ({net}% net); {share}% of the candle's volume", { buy: usd(trap.zoneBuy), sell: usd(trap.zoneSell), net: Math.round(imbalanceOf(trap) * 100), share: Math.round(wickShareOf(trap) * 100) }),
    buyers ? t('estimated average aggressor price {price}; the candle closed {atr} ATR below', { price: fmtPrice(trap.entry), atr: trap.excursion.toFixed(1) }) : t('estimated average aggressor price {price}; the candle closed {atr} ATR above', { price: fmtPrice(trap.entry), atr: trap.excursion.toFixed(1) }),
  ];
  if (trap.state === 'reclaimed') lines.push(t('A later candle closed back through that price. That is a price event only.'));
  lines.push(trapVerdict(scope));
  return lines;
}

/** What to say about a candle that was checked: the flags it has, or why it has none (no event and no data are different things). */
export function trapStatusText(decision: Decision | undefined): string | null {
  if (!decision) return null;
  switch (decision.verdict) {
    case 'trap': return decision.traps.map(trap => trap.side === 'buyers' ? t('Rejected aggressive buying') : t('Rejected aggressive selling')).join(' · ');
    case 'none': return t('No rejected aggressive flow');
    case 'insufficient': return t('Not enough recorded data to check');
    case 'warmup': return t('Still collecting the history to compare with');
  }
}

/** Candles of footprint kept in view of detection at most (the window grows with how far back the chart is panned). */
const MAX_WINDOW_BARS = 300;
/** Footprint facts kept before the oldest are dropped (three numbers each). */
const MAX_FACTS = 20_000;

type Load = (inst: string, tf: string, from: number, to: number, rowStep: number) => Promise<{ step: number; bars: Bar[] }>;

/**
 * The footprint on each candle's own grid and what was decided about each candle. A candle is decided from what was known at its close (the grid
 * comes from the volatility before it; the baseline from the footprints before it) and the decision is kept: once a candle is a minute past its
 * settling, both a flag and a "nothing" are final for this session, so a flag no longer flips when the chart is zoomed or the market moves. Candles
 * that cannot be judged yet (`insufficient`, `warmup`) are tried again, since more may have been recorded since. A response that arrives after the
 * market, timeframe or window has been given up is dropped.
 */
export class TrapData {
  /** The flags in the window with their state at the last build, oldest first. */
  traps: Trap[] = [];
  #frozen = new Map<string, Decision>();
  #live = new Map<number, Decision>();
  #facts = new Map<string, Map<number, BarFacts>>();
  #scope = ''; #generation = 0; #busy = false; #key = ''; #loadedAt = 0; #built = '';

  /** `refreshMs` is how long a load is trusted before the candles still waiting for an answer are looked at again. */
  constructor(private readonly refreshMs = 5_000) {}

  /** Forget the window (the chart left this market, or the footprint is off); what was decided stays, keyed by market and timeframe. */
  clear(): void { this.#generation++; this.#live.clear(); this.traps = []; this.#key = ''; this.#built = ''; this.#busy = false; this.#scope = ''; }

  /**
   * Bring the flags up to date: judge the candles in view that have no final answer yet, loading each one's footprint on its own grid.
   * `candles` are the market's own candles (the caller checks that they belong to `inst`) and `fine` is the finest recorded row step.
   */
  ensure(args: { inst: string; tf: string; tfMs: number; candles: readonly CandleRow[]; fine: number; view: { t0: number; t1: number }; load: Load; onLoad: () => void }): void {
    const { inst, tf, tfMs, candles, fine, view, load, onLoad } = args;
    if (candles.length < 2 || !(fine > 0)) { this.clear(); return; }
    const scope = `${inst}|${tf}`;
    if (scope !== this.#scope) { this.#generation++; this.#live.clear(); this.traps = []; this.#key = ''; this.#built = ''; this.#busy = false; this.#scope = scope; }
    if (this.#busy) return;
    const now = Date.now(), lo = view.t0 - tfMs, hi = view.t1 + tfMs;
    const todo: { i: number; step: number }[] = [];
    for (let i = 1; i < candles.length; i++) {
      const c = candles[i]!;
      if (c[0] < lo || c[0] >= hi || !settled(c, tfMs, now) || this.#frozen.get(`${scope}|${c[0]}`)?.version === TRAP_VERSION) continue;
      const step = stepFor(candles, i, fine);
      if (step > 0) todo.push({ i, step });
      else this.#live.set(c[0], { t: c[0], verdict: 'warmup', traps: [], step: 0, share: null, version: TRAP_VERSION });
    }
    const steps = new Map<number, { from: number; to: number }>();
    for (const { i, step } of todo) {
      const t0 = candles[i]![0], range = steps.get(step) ?? { from: Infinity, to: -Infinity };
      range.from = Math.min(range.from, t0); range.to = Math.max(range.to, t0 + tfMs); steps.set(step, range);
    }
    const key = [scope, ...[...steps].map(([step, r]) => `${step}:${r.from}:${r.to}`)].join('|');
    const fresh = key === this.#key && performance.now() - this.#loadedAt < this.refreshMs;
    if (!todo.length || fresh) { this.#rebuild(candles, tfMs, now, scope, lo, hi); return; }
    this.#busy = true; this.#key = key;
    const generation = this.#generation;
    const requests = [...steps].map(([step, r]) => {
      const to = Math.ceil(r.to / tfMs) * tfMs, from = Math.max(to - MAX_WINDOW_BARS * tfMs, Math.floor((r.from - (TRAP_PARAMS.baselineLength + 1) * tfMs) / tfMs) * tfMs);
      return load(inst, tf, from, to, step).then(body => ({ step, body }));
    });
    Promise.all(requests).then(results => {
      if (generation !== this.#generation) return;
      const at = new Map(candles.map(c => [c[0], c] as const)), bars = new Map<number, Map<number, Bar>>(), steps2 = new Map<number, number>();
      let facts = this.#facts.get(scope); if (!facts) { facts = new Map(); this.#facts.set(scope, facts); }
      for (const { step, body } of results) {
        const used = body.step > 0 ? body.step : step;
        bars.set(step, new Map(body.bars.map(b => [b.t, b] as const))); steps2.set(step, used);
        for (const b of body.bars) facts.set(b.t, factsOf(b, at.get(b.t), used));
      }
      if (facts.size > MAX_FACTS) { for (const k of [...facts.keys()].slice(0, facts.size - MAX_FACTS)) facts.delete(k); }
      const done = Date.now();
      for (const { i, step } of todo) {
        const c = candles[i]!, used = steps2.get(step) ?? step;
        const decision = judgeCandle({ candles, index: i, bar: bars.get(step)?.get(c[0]), step: used, facts, tfMs });
        this.#live.set(c[0], decision);
        if ((decision.verdict === 'trap' || decision.verdict === 'none') && done >= c[0] + tfMs + TRAP_PARAMS.settleMs + TRAP_PARAMS.freezeMs) this.#frozen.set(`${scope}|${c[0]}`, decision);
      }
      this.#loadedAt = performance.now();
      this.#rebuild(candles, tfMs, done, scope, lo, hi, true);
      onLoad();
    }).catch(error => console.error('trap scan failed', error)).finally(() => { if (generation === this.#generation) this.#busy = false; });
  }

  /** The flags of the candles in view: the final answers where there are any, the provisional ones otherwise. */
  #rebuild(candles: readonly CandleRow[], tfMs: number, now: number, scope: string, lo: number, hi: number, force = false): void {
    const last = candles[candles.length - 1]!;
    const signature = `${scope}|${candles.length}|${last[0]}|${last[4]}|${this.#frozen.size}|${lo}|${hi}|${Math.floor(now / 5_000)}`;
    if (!force && signature === this.#built) return;
    this.#built = signature;
    const found: Trap[] = [];
    for (const c of candles) {
      if (c[0] < lo || c[0] >= hi) continue;
      const decision = this.#frozen.get(`${scope}|${c[0]}`) ?? this.#live.get(c[0]);
      if (decision) for (const trap of decision.traps) found.push({ ...trap });
    }
    this.traps = withStates(found, candles, tfMs, now);
  }

  /** What was decided about the candle starting at `t` (final or provisional), or undefined when nothing has been (it is forming, or out of view). */
  decisionOf(t: number): Decision | undefined { return this.#frozen.get(`${this.#scope}|${t}`) ?? this.#live.get(t); }

  /** The flags on the candle starting at `t` (a candle can have one on each wick). */
  on(t: number): Trap[] { return this.traps.filter(trap => trap.t === t); }
}
