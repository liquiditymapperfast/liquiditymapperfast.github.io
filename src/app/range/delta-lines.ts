import type { CandleRow } from '../store.ts';
import type { CandleFlow, DeltaCandle, ResetMode } from '../delta/candles.ts';
import type { NlnsCandle } from '../delta/nlns.ts';
import { clock, price as fmtPrice, usd } from '../format.ts';
import { t, tn } from '../i18n.ts';
import { sumWho, type OiWho } from './oi-summary.ts';
import { durationText, estimateNotes, estimateStacks, signedCoins, signedUsd, spanText } from './oi-lines.ts';
import type { RangeSelection } from './selection.ts';
import type { RangeLine } from './stats.ts';

/** The share of a stretch's volume its delta must reach before the summary reads it against the price (the Bar stats' "delta vs candle" rule). */
export const DELTA_SHARE_MIN = 0.05;

/**
 * What the Delta pane drew last, handed to its Range summary (provider.ts): its candles' flow over the flow column's markets (or, showing
 * NL/NS, the model it drew), the chart's price, how many markets each candle counts, and what it was drawn for. The pane works its candles
 * out for the view (and the run before it), so a closed selection's result is kept once the pane held all of it (`DeltaRangeSummary`).
 */
export interface DeltaPaneHeld {
  /** What it was drawn for (coin, timeframe, what it shows, where the CVD starts, the markets): another is not summed up as this one. */
  key: string;
  mode: 'cvd' | 'bars' | 'nlns';
  tfMs: number; tf: string; reset: ResetMode;
  /** The candle starts worked out, each one's flow as the pane counts it (null: none recorded, or left out as not recorded) and as read (`raw`). */
  starts: readonly number[];
  flows: readonly (CandleFlow | null)[];
  raw: readonly (CandleFlow | null)[];
  /** The CVD candles by start (their run: the CVD starts again between runs). */
  candles: ReadonlyMap<number, DeltaCandle>;
  /** How many of the markets each candle counts (those whose flow reaches back to its start), and how many there are. */
  support: readonly number[];
  markets: number;
  /**
   * The first moment any of the markets holds flow (ms), or null; and each market's first recorded second (`firsts`, in the markets' order,
   * null for one with none): a candle can gain flow, or more markets, only when one of those moves back, so a kept result is given up only
   * then (empty showing NL/NS).
   */
  earliest: number | null;
  firsts: readonly (number | null)[];
  /** The chart's candles, whether they are the coin's own market's, and its name. */
  candlesPrice: readonly CandleRow[]; ownPrice: boolean; priceMarket: string;
  /** NL/NS (Show: NL/NS): the model's candles by start, whose open interest (in words) and the coin; null otherwise. */
  nlns: ReadonlyMap<number, NlnsCandle> | null; whose: string; coin: string;
  /** In a replay, the start of the bar under way at its moment, or null live. */
  replayAt: number | null;
}

/** A stretch of the Delta pane's candles summed up. */
export interface DeltaStretch {
  t0: number; t1: number;
  /**
   * The candles the selection spans on the candle grid (`expected`), those of them the pane holds (`bars`: fewer once the view moved away),
   * those with recorded flow, and those left out as not recorded (a long stretch with no trade on any market).
   */
  expected: number; bars: number; held: number; unrecorded: number;
  /** The recorded delta and volume (USD) over the candles held, and bought and sold made of them. */
  delta: number; volume: number; bought: number; sold: number;
  /** The candles' deltas' sizes added up, and how few of them (largest first) make half of it. */
  movement: number; half: number;
  buying: number; selling: number; flat: number;
  largest: { t: number; delta: number } | null;
  /** The runs of the CVD among its candles, and where one run's CVD opened and closed (null with more than one). */
  runs: number; cvd: { open: number; close: number } | null;
  /** The fewest and most markets its candles count. */
  supportLow: number; supportHigh: number;
  price: { open: number; close: number } | null;
  /** The delta of as many candles just before (each a candle apart, all with flow, counting the same markets); null otherwise. */
  before: number | null;
  /** NL/NS added up over its candles (the OI pane's sum, `sumWho`). */
  who: OiWho | null;
}

/** The candle of `candles` (oldest first) that starts at `t`; undefined when none does. */
function candleAt(candles: readonly CandleRow[], t: number): CandleRow | undefined {
  let lo = 0, hi = candles.length;
  while (lo < hi) { const mid = (lo + hi) >>> 1; if (candles[mid]![0] < t) lo = mid + 1; else hi = mid; }
  const c = candles[lo];
  return c && c[0] === t ? c : undefined;
}

/** The stretch's figures from what the pane held: the candles that start inside the selection; null when none does. */
export function deltaStretch(held: DeltaPaneHeld, sel: Pick<RangeSelection, 't0' | 't1'>): DeltaStretch | null {
  // In a replay, the candles closed by its moment only: the one under way there holds part of its time, and those after it are its future.
  const end = held.replayAt !== null ? Math.min(sel.t1, held.replayAt) : sel.t1, idx: number[] = [];
  for (let i = 0; i < held.starts.length; i++) { const s = held.starts[i]!; if (s >= sel.t0 && s < end) idx.push(i); }
  if (!idx.length) return null;
  const tf = held.tfMs, first = idx[0]!, last = idx[idx.length - 1]!;
  let k = 0, gaps = 0, delta = 0, volume = 0, movement = 0, buying = 0, selling = 0, flat = 0, supportLow = Infinity, supportHigh = -Infinity;
  let largest: DeltaStretch['largest'] = null;
  const sizes: number[] = [], runs = new Set<number>();
  for (const i of idx) {
    const f = held.flows[i], start = held.starts[i]!, n = held.support[i] ?? 0;
    if (!f) { if (held.raw[i]) gaps++; continue; }
    supportLow = Math.min(supportLow, n); supportHigh = Math.max(supportHigh, n);
    k++; delta += f.delta; volume += f.gross; movement += Math.abs(f.delta); sizes.push(Math.abs(f.delta));
    if (f.delta > 0) buying++; else if (f.delta < 0) selling++; else flat++;
    if (f.delta !== 0 && (!largest || Math.abs(f.delta) > Math.abs(largest.delta))) largest = { t: start, delta: f.delta };
    const c = held.candles.get(start); if (c) runs.add(c.run);
  }
  sizes.sort((a, b) => b - a);
  let half = 0; for (let got = 0; half < sizes.length && got < movement / 2;) got += sizes[half++]!;
  // The CVD's level at the stretch's ends, only inside one run and only where it starts again each day or week: from the left edge it
  // starts at the view's edge, so its level moves with the view (its change does not: the delta).
  let cvd: DeltaStretch['cvd'] = null;
  if (held.mode === 'cvd' && held.reset !== 'none' && runs.size === 1 && k === idx.length) {
    const a = held.candles.get(held.starts[first]!), b = held.candles.get(held.starts[last]!);
    if (a && b) cvd = { open: a.open, close: b.close };
  }
  let price: DeltaStretch['price'] = null;
  if (held.ownPrice) {
    const a = candleAt(held.candlesPrice, held.starts[first]!), b = candleAt(held.candlesPrice, held.starts[last]!);
    if (a && b && a[1] > 0 && b[4] > 0) price = { open: a[1], close: b[4] };
  }
  // The candles just before, as many: one candle apart each, all with flow, counting the same markets as every candle of the stretch.
  let before: number | null = null;
  const n = idx.length;
  if (k === n && supportLow === supportHigh && first - n >= 0) {
    let sum = 0, ok = true;
    for (let i = first - n; i < first && ok; i++) {
      const f = held.flows[i];
      ok = !!f && held.starts[i + 1]! - held.starts[i]! === tf && (held.support[i] ?? -1) === supportLow;
      if (ok) sum += f!.delta;
    }
    if (ok) before = sum;
  }
  let who: OiWho | null = null;
  if (held.nlns) { const cs: { c: NlnsCandle }[] = []; for (const i of idx) { const c = held.nlns.get(held.starts[i]!); if (c) cs.push({ c }); } who = sumWho(cs); }
  const firstStart = Math.ceil(sel.t0 / tf) * tf, expected = Math.max(n, Math.ceil((end - firstStart) / tf));
  return {
    t0: held.starts[first]!, t1: held.starts[last]! + tf, expected, bars: n, held: k, unrecorded: gaps, delta, volume, bought: (volume + delta) / 2, sold: (volume - delta) / 2,
    movement, half, buying, selling, flat, largest, runs: runs.size, cvd, supportLow: Number.isFinite(supportLow) ? supportLow : 0, supportHigh: Number.isFinite(supportHigh) ? supportHigh : 0, price, before, who,
  };
}

const pct = (x: number): string => `${Math.round(x * 100)}%`;
/**
 * Whether any market's flow reaches back further now than it did (`then`, `now` in the same markets' order; the markets are in the key): one
 * that had none and has some, or whose first second is earlier. Only then can a candle that had no flow, or fewer markets, have more now; a
 * first moving later (a full ring, a reload from the view's edge) or a drawing that held nothing says nothing of the kept candles.
 */
function reachesBack(then: readonly (number | null)[], now: readonly (number | null)[]): boolean {
  return now.some((f, i) => f !== null && (then[i] === null || then[i] === undefined || f < then[i]!));
}
/**
 * Two dollar amounts in one unit (the largest that the smaller of them reaches), one decimal each, so their difference can be read off them:
 * "-$763.8M -> -$1,390.0M" where the page's usual compact figures would say "-$1.4B" for the second.
 */
export function usdPair(a: number, b: number): string {
  // The unit from the smaller of the two that is not zero (a run opens at exactly 0); below $1K the two are written each as usual.
  const nonzero = [Math.abs(a), Math.abs(b)].filter(v => v > 0), small = nonzero.length ? Math.min(...nonzero) : 0;
  // Below $1K, or a thousand times apart (one shared unit would write "+$763,800.0K"), each is written as usual.
  if (small < 1e3 || Math.max(Math.abs(a), Math.abs(b)) >= 1000 * small) return `${signedUsd(a)} → ${signedUsd(b)}`;
  const [unit, suffix] = small >= 1e9 ? [1e9, 'B'] : small >= 1e6 ? [1e6, 'M'] : [1e3, 'K'];
  // One decimal, more where the two would read the same while they differ (a short stretch on a large CVD level).
  const one = (v: number, d: number): string => v === 0 ? '$0' : `${v > 0 ? '+' : '−'}$${(Math.abs(v) / unit).toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d })}${suffix}`;
  let d = 1; while (d < 4 && a !== b && one(a, d) === one(b, d)) d++;
  return `${one(a, d)} → ${one(b, d)}`;
}
/** A share as the panel writes it: one decimal below 10 % (so 4.6 % is not written 5 % beside the 5 % rule), whole percents above. */
const sharePct = (x: number): string => { const a = Math.abs(x) * 100 + 1e-9; return `${a < 10 ? (Math.floor(a * 10) / 10).toFixed(1) : Math.floor(a)}%`; };

/**
 * The Delta pane's Range summary (provider.ts): `lines` sums up a selection from what the pane drew last, in its own terms. Showing CVD or
 * Delta bars: the recorded taker flow over the flow column's markets (bought and sold, the delta and its share, the volume), the price over
 * the same candles and the delta read against it, the CVD's level inside one daily or weekly run, how the delta was spread over the candles,
 * the candles just before and the largest candle. Showing NL/NS: the OI pane's estimated added and reduced, and the longs' and the shorts'
 * net. The pane holds its candles for the view, so the last complete result of a closed selection is kept when the view moves away.
 */
export class DeltaRangeSummary {
  /** The last complete result of a closed selection, with what it was worked out with (the markets and where the flow began then). */
  #kept: { key: string; s: DeltaStretch; markets: number; earliest: number | null; firsts: readonly (number | null)[]; priceMarket: string } | null = null;
  #last: { held: DeltaPaneHeld | null; sel: RangeSelection; shown: boolean; current: string; slot: number; zone: string; lines: RangeLine[] } | null = null;

  lines(sel: RangeSelection, held: DeltaPaneHeld | null, shown: boolean, current: string, now: number, zone = ''): RangeLine[] {
    const last = this.#last, slot = held ? Math.floor(now / held.tfMs) : 0;
    if (last && last.held === held && last.sel === sel && last.shown === shown && last.current === current && last.slot === slot && last.zone === zone) return last.lines;
    const lines = this.#lines(sel, held, shown, current, now);
    this.#last = { held, sel, shown, current, slot, zone, lines };
    return lines;
  }

  #lines(sel: RangeSelection, held: DeltaPaneHeld | null, shown: boolean, current: string, now: number): RangeLine[] {
    const title = (text: string): RangeLine => ({ key: 'dl-title', kind: 'title', cells: [text] });
    if (!held) return [title(spanText(sel.t0, sel.t1)), { key: 'dl-none', kind: 'note', tone: 'muted', cells: [shown ? t('No flow recorded for these candles yet.') : t('The Delta pane has not drawn this market yet: show it to sum up this selection.')] }];
    if (held.key !== current) return [title(spanText(sel.t0, sel.t1)), { key: 'dl-stale', kind: 'note', tone: 'muted', cells: [t('The Delta pane last drew another market, timeframe or setting: show it to sum up this selection.')] }];
    const now0 = deltaStretch(held, sel);
    // Kept: the last result that held every candle of this closed selection, while the pane now holds fewer of them, or none (the view
    // moved past it). Keyed by the selection's own ends: what the pane holds of it shrinks as the view moves away.
    const end = held.replayAt !== null ? Math.min(sel.t1, held.replayAt) : sel.t1;
    const key = `${held.key}|${sel.t0}|${end}`, nlns = held.mode === 'nlns', complete = now0 !== null && now0.bars >= now0.expected;
    const formingFrom = held.replayAt === null ? Math.floor(now / held.tfMs) * held.tfMs : Infinity, forming = now0 !== null && now0.t1 > formingFrom;
    if (complete && !forming) this.#kept = { key, s: now0!, markets: held.markets, earliest: held.earliest, firsts: held.firsts, priceMarket: held.priceMarket };
    // A kept result is given up only when what is held now may know more of its candles: flow candles without flow, once a market's first
    // recorded second moved back; NL/NS with none, once the pane holds some of the stretch's NL/NS.
    const old = this.#kept?.key === key ? this.#kept : null;
    if (!complete && old && (nlns ? old.s.who === null && (now0?.who ?? null) !== null : (old.s.held < old.s.bars || old.s.supportLow < old.markets) && reachesBack(old.firsts, held.firsts))) this.#kept = null;
    const keptRecord = !complete && this.#kept?.key === key ? this.#kept : null, kept = keptRecord?.s ?? null;
    if (!now0 && !kept) {
      // Candles of the selection exist but the pane holds none of them (the view is elsewhere), or none starts in it at all.
      const first = Math.ceil(sel.t0 / held.tfMs) * held.tfMs, expected = Math.max(0, Math.ceil((end - first) / held.tfMs));
      return [title(spanText(sel.t0, sel.t1)), { key: 'dl-none', kind: 'note', tone: 'muted', cells: [expected > 0 ? t('The pane holds {k} of the {n} candles: the rest are outside the view.', { k: 0, n: expected }) : t('No {tf} candle of the Delta pane starts in this range.', { tf: held.tf })] }];
    }
    const s = kept ?? now0!, n = s.bars, markets = keptRecord?.markets ?? held.markets, earliest = keptRecord ? keptRecord.earliest : held.earliest;
    const lines: RangeLine[] = [title(`${spanText(s.t0, s.t1)} · ${durationText(s.t1 - s.t0)} · ${tn(n, '{n} candle of {tf}', '{n} candles of {tf}', { tf: held.tf })}${forming ? ` · ${t('forming')}` : ''}`)];
    const status: string[] = [];
    if (nlns) { if (held.whose) status.push(held.whose); }
    else {
      // How many markets the candles count: all of the flow column's, some (a market's flow reaches back only so far), or none (said below).
      if (s.supportLow === markets && s.supportHigh === markets) status.push(tn(markets, 'Recorded taker flow of {n} market of the flow column', 'Recorded taker flow of {n} markets of the flow column'));
      else if (s.supportHigh > 0 && s.supportLow === s.supportHigh) status.push(t('Recorded taker flow of {lo}–{hi} of the flow column\'s {n} markets', { lo: s.supportLow, hi: s.supportHigh, n: markets }).replace(`${s.supportLow}–${s.supportHigh}`, String(s.supportLow)));
      else if (s.supportHigh > 0) status.push(t('Recorded taker flow of {lo}–{hi} of the flow column\'s {n} markets', { lo: s.supportLow, hi: s.supportHigh, n: markets }));
      // Candles without flow: those nothing was recorded in, and (apart) those left out as not recorded.
      if (s.held + s.unrecorded < n) status.push(tn(n - s.held - s.unrecorded, '{n} candle without recorded flow', '{n} candles without recorded flow'));
      if (s.unrecorded > 0) status.push(tn(s.unrecorded, '{n} candle left out: no trade on any market for 10 min or more', '{n} candles left out: no trade on any market for 10 min or more'));
      if (earliest !== null && earliest > s.t0) status.push(t('flow recorded since {time}', { time: clock(earliest, true) }));
      if (held.mode === 'cvd' && s.runs > 1) status.push(t('the CVD starts again inside it'));
    }
    if (sel.t0 % held.tfMs !== 0 || sel.t1 % held.tfMs !== 0) status.push(t('the {tf} candles that start in the selection', { tf: held.tf }));
    if (held.replayAt !== null) status.push(t('replay: candles closed by {time}', { time: clock(held.replayAt, true) }));
    if (status.length) lines.push({ key: 'dl-status', kind: 'note', tone: 'muted', cells: [status.join(' · ')] });
    if (!shown) lines.push({ key: 'dl-hidden', kind: 'note', tone: 'muted', cells: [t('The Delta pane is hidden: these are the candles it last held.')] });
    if (sel.p0 !== null && sel.p1 !== null) lines.push({ key: 'dl-prices', kind: 'note', tone: 'muted', cells: [t('Delta uses all prices.')] });
    if (kept) lines.push({ key: 'dl-kept', kind: 'note', tone: 'muted', cells: [t('As worked out while these candles were in view.')] });
    else if (s.bars < s.expected) lines.push({ key: 'dl-partial', kind: 'note', tone: 'muted', cells: [t('The pane holds {k} of the {n} candles: the rest are outside the view.', { k: s.bars, n: s.expected })] });
    return [...lines, ...(nlns ? this.#nlns(s, held, n) : this.#flow(s, held, n, forming, earliest, keptRecord?.priceMarket ?? held.priceMarket))];
  }

  #flow(s: DeltaStretch, held: DeltaPaneHeld, n: number, forming: boolean, earliest: number | null, priceMarket: string): RangeLine[] {
    const lines: RangeLine[] = [{ key: 'h-dl-flow', kind: 'heading', cells: [t('Taker flow')] }];
    if (s.held === 0) return [...lines, { key: 'dl-flow-none', kind: 'note', tone: 'muted', cells: [earliest !== null && earliest >= s.t1 - held.tfMs ? t('Flow is recorded from {time}: the candles before it have none.', { time: clock(earliest, true) }) : t('No flow recorded for these candles yet.')] }];
    // The whole selection held: only then are the delta read against the price and the stretch before said as the selection's.
    const whole = s.bars >= s.expected && s.held === n;
    const share = s.volume > 0 ? s.delta / s.volume : 0;
    if (s.volume > 0) lines.push({ key: 'dl-split', kind: 'split', share: s.bought / s.volume, cells: [t('Bought {value}', { value: `$${usd(s.bought)}` }), t('Sold {value}', { value: `$${usd(s.sold)}` })] });
    lines.push({ key: 'dl-delta', kind: 'stat', ...(s.delta > 0 ? { tone: 'buy' as const } : s.delta < 0 ? { tone: 'sell' as const } : {}), cells: [t('Delta'), s.volume > 0 ? t('{value} · {share} of the volume', { value: signedUsd(s.delta), share: `${share > 0 ? '+' : share < 0 ? '−' : ''}${sharePct(share)}` }) : signedUsd(s.delta)] });
    lines.push({ key: 'dl-volume', kind: 'stat', cells: [t('Recorded taker volume'), `$${usd(s.volume)}`] });
    if (s.price) {
      const move = (s.price.close - s.price.open) / s.price.open, sign = move > 0 ? '+' : move < 0 ? '−' : '';
      lines.push({ key: 'dl-price', kind: 'stat', ...(move > 0 ? { tone: 'buy' as const } : move < 0 ? { tone: 'sell' as const } : {}), cells: [t('Price, {market}', { market: priceMarket }), `${fmtPrice(s.price.open)} → ${fmtPrice(s.price.close)} · ${sign}${(Math.abs(move) * 100).toFixed(2)}%`] });
      // The delta against the price: said only where they went opposite ways and the delta is a real share of the volume, and as what it is.
      if (Math.abs(share) >= DELTA_SHARE_MIN && move !== 0 && Math.sign(move) !== Math.sign(share) && whole) {
        lines.push({ key: 'dl-against', kind: 'note', cells: [share > 0 ? t('Net buying while the price fell: taker flow against the price, not proof that resting orders absorbed it.') : t('Net selling while the price rose: taker flow against the price, not proof that resting orders absorbed it.')] });
      }
    }
    // The CVD before and after the selection, both in one unit so their difference reads as the delta (-$763.8M -> -$1,390.0M, not -$1.4B).
    if (s.cvd) lines.push({ key: 'dl-cvd', kind: 'stat', cells: [t('Recorded CVD, before → after selection'), usdPair(s.cvd.open, s.cvd.close)] });
    const spread: RangeLine[] = [];
    if (s.held >= 3 && s.movement > 0) spread.push({ key: 'dl-half', kind: 'stat', cells: [t('Half the movement came in'), `${t('{k} of {n} candles', { k: s.half, n: s.held })}${forming ? ` ${t('so far')}` : ''}`] });
    if (s.held >= 2 && s.movement > 0) {
      spread.push({ key: 'dl-offset', kind: 'stat', cells: [t('Cancellation between candle deltas'), pct(1 - Math.abs(s.delta) / s.movement)] });
      spread.push({ key: 'dl-offset-note', kind: 'note', tone: 'muted', cells: [t('Of the candle deltas added up by size, {share} remained in the net.', { share: pct(Math.abs(s.delta) / s.movement) })] });
    }
    if (s.held >= 2) spread.push({ key: 'dl-count', kind: 'stat', cells: [t('Candle delta signs'), t('{b} buying · {s} selling · {f} flat', { b: s.buying, s: s.selling, f: s.flat })] });
    if (s.before !== null && !forming && whole) spread.push({ key: 'dl-before', kind: 'stat', cells: [tn(n, 'Previous {n} candle ({span})', 'Previous {n} candles ({span})', { span: durationText(s.t1 - s.t0) }), signedUsd(s.before)] });
    if (s.largest && s.held > 1) spread.push({ key: 'dl-largest', kind: 'stat', cells: [t('Largest absolute candle delta'), `${clock(s.largest.t, true)} · ${signedUsd(s.largest.delta)}`] });
    if (spread.length) lines.push({ key: 'h-dl-spread', kind: 'heading', cells: [t('How it was spread')] }, ...spread);
    return lines;
  }

  #nlns(s: DeltaStretch, held: DeltaPaneHeld, n: number): RangeLine[] {
    const head: RangeLine = { key: 'h-dl-who', kind: 'heading', cells: [held.coin ? `${t('Estimated added and reduced')} · ${held.coin}` : t('Estimated added and reduced')] };
    const w = s.who;
    if (!w) return [head, { key: 'dl-who-none', kind: 'note', tone: 'muted', cells: [t('No change of open interest is held for these candles yet.')] }];
    const out: RangeLine[] = [head, ...estimateStacks(w, held.coin, 'dl'),
      // Each side's opened less closed: "+" means that side grew; not the change of open interest (what went to no side is left out).
      { key: 'dl-nets', kind: 'stat', cells: [t('Longs net · shorts net'), `${signedCoins(w.longOpened - w.longClosed, held.coin)} · ${signedCoins(w.shortOpened - w.shortClosed, held.coin)}`] }];
    if (w.candles < n) out.push({ key: 'dl-who-candles', kind: 'note', tone: 'muted', cells: [t('NL/NS for {k} of the {n} candles: the others have no change of open interest held.', { k: w.candles, n })] });
    out.push(...estimateNotes(w, false, held.tfMs, 'dl'));
    return out;
  }
}
