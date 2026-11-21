import { SIZE_EDGES } from '../../shared/footprint.ts';
import { WARMUP, anomalies, type HighlightOptions } from '../anomaly.ts';
import { barScale } from '../bar-scale.ts';
import { scaledUsd } from '../coin.ts';
import { plainUsd, signedUsd } from '../cvd/text.ts';
import { coinText } from '../delta/nlns.ts';
import { t, tn } from '../i18n.ts';
import type { InfoLine } from '../infobox.ts';
import { coverageOf } from '../panes/bar-stats.ts';
import type { Bar } from '../panes/footprint.ts';
import { sizeText } from '../sizes.ts';

/**
 * The Flow history pane's model (pure; tests/app-size-history.test.mts): per candle, the liquidations, the change of open interest and the
 * market orders in six size bands, each row's bars, and how unusual each bar is. Designed with the advisor and Astra (2026-11-20, three
 * rounds, measured on seven days of the local recording; the figures are in the local Research_Findings.md and README "Flow history"):
 *
 * - The size bands are runs of the footprint's eight size boxes (`SIZE_EDGES`), so every edge is exact and no size line is asked for.
 * - A bar's height is the square root of its amount on its row's own scale (`barScale` of the square roots, so a lone giant is cut and
 *   marked rather than flattening the rest); its emphasis says how unusual the amount is for its row.
 * - Unusual is the app's one rule (`anomalies`, the Highlights' multiple and length) run over the row's NON-ZERO candles as a sequence of
 *   their own: compared with the last `length` candles that had any such amount, from the twelfth on. Counted over slots with the zeros in,
 *   a sparse row (orders from $5M on a one-minute chart: 88 % zeros) flagged 41 % of its bars; with the zeros out of a slot window, half of
 *   its bars had no baseline at all.
 * - A candle recorded in part is drawn hollow, never judged, and left out of the baselines; liquidation days the source cut at 5,000 are
 *   judged among the liquidations it held (the largest), and said so.
 */

/** The six size bands, each a run of the footprint's boxes (indices into `SIZE_EDGES`): < 25K | 25K-100K | 100K-500K | 500K-1M | 1M-5M | >= 5M for BTC. */
export const BANDS: readonly (readonly [number, number])[] = [[0, 0], [1, 2], [3, 4], [5, 5], [6, 6], [7, 7]];

/** A band's name with its dollars, the coin's own sizes (the boxes the recorder keeps are already the coin's). */
export function bandLabel(band: number): string {
  const [lo, hi] = BANDS[band]!, edge = (k: number): string => sizeText(scaledUsd(SIZE_EDGES[k]!)), last = SIZE_EDGES.length - 1;
  return lo === 0 ? `< $${edge(hi + 1)}` : hi === last ? `≥ $${edge(lo)}` : `$${edge(lo)}–${edge(hi + 1)}`;
}

/** The opacity of a bar that is not unusual at all (the owner's "quiet opacity" in his aggr.trade liquidation script). */
export const QUIET_ALPHA = 0.26;
/** The opacity of every bar with Highlights off (nothing judged). */
export const PLAIN_ALPHA = 0.85;
/** A candle with less of it recorded than this is drawn hollow and not judged (Bar stats fades its cells under the same share). */
export const PARTIAL_SHARE = 0.95;
/** The least history before the view the baselines are given, whatever the timeframe (a one-minute chart's sparse rows need hours). */
export const PRE_ROLL_MIN_MS = 6 * 3_600_000;
/** How much history before the view the baselines need: the Highlights' length of candles (at least the share's `SHARE_MIN_SLOTS`), and at least six hours. */
export const preRollMs = (length: number, tfMs: number): number => Math.max(Math.max(length, SHARE_MIN_SLOTS) * tfMs, PRE_ROLL_MIN_MS);

export type RowKind = 'liq' | 'oi' | 'size';
/** One series of a row: drawn up (+1), down (-1), or by its sign (0). Per slot: its amount (USD, signed where `side` is 0; NaN not known). */
export interface Part {
  side: 1 | -1 | 0;
  values: Float64Array;
  /** Per slot: how far above its baseline (NaN: not judged), whether the app's rule flags it, how many earlier non-zero candles it was judged against. */
  sigma: Float64Array; flag: Uint8Array; seen: Uint16Array;
  /** Per slot: 1 where it was not judged for want of earlier non-zero candles (as against partly recorded, zero, or not known). */
  short: Uint8Array;
}
export interface HistoryRow { key: string; kind: RowKind; label: string; parts: Part[]; band?: number }

export interface HistoryInput {
  /** The candle starts, oldest first: the candles before the view that the baselines need, then those of the view. */
  times: readonly number[];
  /** Each slot's footprint bar, null where none was recorded. */
  bars: readonly (Bar | null)[];
  tfMs: number;
  /** The page's clock: the candle under way is measured against what of it has passed (coverageOf). */
  now: number;
  /** Size bars: buy minus sell by its sign, or buys up and sells down. */
  mode: 'delta' | 'split';
  /** Liquidations by candle start (bar-stats.ts `liquidationBuckets`): shorts liquidated (`buy`) and longs liquidated (`sell`). */
  liquidations?: { buy: ReadonlyMap<number, number>; sell: ReadonlyMap<number, number>; cut: boolean; cutStarts?: ReadonlySet<number> };
  /** Open interest's change in USD by candle start; absent where there is none to show (spot markets only, or none held). */
  oi?: ReadonlyMap<number, number>;
  /** Whether open interest's changes are judged (not on a one-minute chart: venues read every few minutes put five minutes into one). */
  oiJudged: boolean;
  highlight: Pick<HighlightOptions, 'on' | 'mult' | 'length'>;
}

export interface HistoryModel {
  rows: HistoryRow[];
  /** Per band: what it bought and sold in each slot (NaN where not known), whichever way its bars are drawn. */
  sides: { buy: Float64Array; sell: Float64Array }[];
  /** Per slot: the share of the candle recorded (NaN where not known), and 1 where that is too little to judge it. */
  cover: Float64Array; partial: Uint8Array;
  /** Per slot: what the six bands bought and sold together (the candle's recorded market orders), NaN where not known. */
  total: Float64Array;
  /** Per slot: 1 where its liquidations come from a day the source cut at its 5,000 largest. */
  liqCut: Uint8Array;
  /**
   * Per band: its share of the candle and whether that is unusual (`shareMarks`): of the six bands' |net| added up with Delta bars (`net`),
   * of their buys and sells with Buys and sells bars (`volume`). Null with Highlights off.
   */
  share: ShareMark[] | null;
  shareKind: 'net' | 'volume';
}

/**
 * The app's rule over the non-zero values of `values` that `judged` admits, as a sequence of their own (`anomalies` with the Highlights'
 * multiple and length): each such value is compared with the `length` such values before it, from the twelfth on. Zeros, values not known
 * and values not admitted are never flagged and never in a baseline.
 */
export function judge(values: ArrayLike<number>, judged: (i: number) => boolean, h: Pick<HighlightOptions, 'mult' | 'length'>): Pick<Part, 'sigma' | 'flag' | 'seen' | 'short'> {
  const n = values.length, sigma = new Float64Array(n).fill(NaN), flag = new Uint8Array(n), seen = new Uint16Array(n), short = new Uint8Array(n);
  const at: number[] = [], obs: number[] = [];
  for (let i = 0; i < n; i++) { const v = Math.abs(values[i]!); if (Number.isFinite(v) && v > 0 && judged(i)) { at.push(i); obs.push(v); } }
  const found = anomalies(obs, h);
  at.forEach((i, k) => {
    seen[i] = Math.min(k, h.length);
    if (Number.isNaN(found.threshold[k]!)) { short[i] = 1; return; }
    sigma[i] = found.sigma[k]!; flag[i] = found.flag[k]!;
  });
  return { sigma, flag, seen, short };
}

/** Per slot, for one size band: its share of the candle (NaN where not worked out), the mean of the shares it was judged against, and 1 where unusual. */
export interface ShareMark { value: Float64Array; usual: Float64Array; flag: Uint8Array }

/**
 * The fewest slots a share's floor and baseline are taken over. About half of them reach the floor and the baseline needs `WARMUP` of
 * those, so over a Highlights baseline of 12 or 18 candles no share could ever be judged (review 2026-11-21).
 */
export const SHARE_MIN_SLOTS = 36;

/**
 * Which size bands took an unusually large part of their candle (Karl, 2026-11-21: a cue between the rows; SHARE-1 in the design record).
 * `parts` holds each band's part of the candle: with Delta bars its |buys - sells| (so the six are added up without their signs), with Buys
 * and sells bars its buys plus sells. A candle is judged only when it is admitted (`whole`: fully recorded) and its six parts add up to at
 * least the median of the admitted candles among the slots before it (the Highlights' length of them, at least `SHARE_MIN_SLOTS`): judged on
 * every candle, a band's share stood out mostly because the others had gone quiet (seven of ten such marks; 93 to 100 % of them for the orders
 * under $100K, which look large only when the large ones step away). Its share is unusual where it is above the mean plus `mult` standard
 * deviations of the band's non-zero shares on the candles among those same slots that reach the same floor, from the twelfth (`anomalies`'
 * rule). Floor and baseline read those slots alone, so a share has one verdict wherever the view starts, given the history before it the pane
 * loads (`preRollMs`). Measured on seven days of the recording (SHARE-1h), the dot (`shareDot`) falls on about 6 to 7 % of candles with
 * Delta bars and 5 to 6 % with Buys and sells at 1 to 15 minutes, nine or ten in a view of 150.
 */
export function shareMarks(parts: readonly ArrayLike<number>[], whole: (i: number) => boolean, h: Pick<HighlightOptions, 'mult' | 'length'>): ShareMark[] {
  const n = parts[0]?.length ?? 0, span = Math.max(h.length, SHARE_MIN_SLOTS), sum = new Float64Array(n).fill(NaN), floor = new Float64Array(n).fill(NaN);
  for (let i = 0; i < n; i++) {
    if (!whole(i)) continue;
    let s = 0;
    for (const v of parts) s += v[i]!;
    if (Number.isFinite(s) && s > 0) sum[i] = s;
  }
  // Each candle's floor: the median sum of the admitted candles among the `span` slots before it, from a sorted window kept as the candles go
  // by (one slot comes in, one leaves). The candle and its baseline are held to that one floor, so its verdict reads those slots alone (a floor
  // of each baseline candle's own would reach twice as far back).
  const sorted: number[] = [];
  const at = (x: number): number => { let lo = 0, hi = sorted.length; while (lo < hi) { const mid = (lo + hi) >> 1; if (sorted[mid]! < x) lo = mid + 1; else hi = mid; } return lo; };
  for (let i = 0; i < n; i++) {
    const enter = i > 0 ? sum[i - 1]! : NaN, leave = i - 1 - span >= 0 ? sum[i - 1 - span]! : NaN;
    if (enter > 0) sorted.splice(at(enter), 0, enter);
    if (leave > 0) sorted.splice(at(leave), 1);
    const m = sorted.length;
    if (!(sum[i]! > 0) || m < WARMUP) continue;
    floor[i] = m % 2 ? sorted[m >> 1]! : (sorted[m / 2 - 1]! + sorted[m / 2]!) / 2;
  }
  return parts.map(v => {
    const value = new Float64Array(n).fill(NaN), usual = new Float64Array(n).fill(NaN), flag = new Uint8Array(n);
    for (let i = 0; i < n; i++) if (sum[i]! > 0) value[i] = v[i]! / sum[i]!;
    for (let i = 0; i < n; i++) {
      const f = floor[i]!, x0 = value[i]!;
      if (!(sum[i]! >= f) || !(x0 > 0)) continue;
      // Mean and standard deviation from the shares less this candle's own (one pass that stays exact on a flat baseline: a share equal to
      // every share before it is never above them).
      let count = 0, shift = 0, square = 0;
      for (let j = Math.max(0, i - span); j < i; j++) { const x = value[j]!; if (sum[j]! >= f && x > 0) { const d = x - x0; count++; shift += d; square += d * d; } }
      if (count < WARMUP) continue;
      const mean = x0 + shift / count, sd = Math.sqrt(Math.max(0, square / count - (shift / count) ** 2));
      usual[i] = mean;
      if (x0 > mean + h.mult * sd) flag[i] = 1;
    }
    return { value, usual, flag };
  });
}

/**
 * Whether a size row's bar at slot `i` gets the share dot: its share was unusual (`shareMarks`), the candle is whole, and no side of the bar is
 * lit half or more (from three quarters of the multiple, where the card says Close to unusual: its brightness speaks for it). The pane draws it
 * where the row and the candle are wide enough; the card explains it where it is drawn.
 */
export function shareDot(model: Pick<HistoryModel, 'share' | 'partial'>, row: HistoryRow, i: number, mult: number): boolean {
  const mark = row.band === undefined ? null : model.share?.[row.band] ?? null;
  return !!mark && mark.flag[i] === 1 && model.partial[i] !== 1 && row.parts.every(p => emphasis(p.sigma[i]!, p.flag[i] === 1, mult) < 0.5);
}

/**
 * How strongly a bar is lit, 0 to 1: nothing below half the Highlights' multiple of standard deviations, full at the multiple itself (where
 * the rule starts to flag), smoothly between; a value flagged against a flat baseline (no spread, so no sigma) is full. Measured on the
 * recording: this lights about one drawn bar in ten past half opacity, where a ramp from 0 sigma lit one in six.
 */
export function emphasis(sigma: number, flagged: boolean, mult: number): number {
  if (flagged && !(sigma > 0)) return 1;
  if (!Number.isFinite(sigma)) return 0;
  const half = mult / 2, u = Math.min(1, Math.max(0, (sigma - half) / half));
  return u * u * (3 - 2 * u);
}

/** A bar's opacity at emphasis `e`, or the plain one with Highlights off. */
export const alphaOf = (e: number, on: boolean): number => on ? QUIET_ALPHA + (1 - QUIET_ALPHA) * e : PLAIN_ALPHA;

/** A row's scale over the slots `at`: `barScale` of the square roots of its parts' amounts (0 when nothing is drawn). */
export function rowCap(row: Pick<HistoryRow, 'parts'>, at: readonly number[]): number {
  const sizes: number[] = [];
  for (const part of row.parts) for (const i of at) { const v = part.values[i]!; if (Number.isFinite(v) && v !== 0) sizes.push(Math.sqrt(Math.abs(v))); }
  return barScale(sizes);
}

/** A bar's height as a share of its half of the row, and whether it reaches past the row's scale (drawn to the edge and marked). */
export function heightOf(value: number, cap: number): { share: number; cut: boolean } {
  const root = Math.sqrt(Math.abs(value));
  return cap > 0 && Number.isFinite(root) ? { share: Math.min(1, root / cap), cut: root > cap } : { share: 0, cut: false };
}

const sum = (values: readonly number[], lo: number, hi: number): number => { let s = 0; for (let k = lo; k <= hi; k++) s += values[k]!; return s; };
/**
 * Whether a candle is recorded too little to judge: under `PARTIAL_SHARE` of its minutes, as Bar stats fades it; the candle under way only
 * when more than one of the minutes that have passed is missing too, so the minute under way, not counted yet, never makes it hollow.
 */
export function isPartial(bar: Pick<Bar, 'minutes'>, start: number, tfMs: number, now: number, share: number): boolean {
  if (!(share < PARTIAL_SHARE)) return false;
  if (now >= start + tfMs) return true;
  const minutes = Math.max(1, Math.ceil((now - start) / 60_000));
  return minutes - (bar.minutes ?? minutes) > 1;
}
const unjudged = (side: Part['side'], values: Float64Array): Part => ({ side, values, sigma: new Float64Array(values.length).fill(NaN), flag: new Uint8Array(values.length), seen: new Uint16Array(values.length), short: new Uint8Array(values.length) });
const part = (side: Part['side'], values: Float64Array, judged: (i: number) => boolean, h: HistoryInput['highlight'], on: boolean): Part =>
  on ? { side, values, ...judge(values, judged, h) } : unjudged(side, values);

export function buildHistory(input: HistoryInput): HistoryModel {
  const n = input.times.length, h = input.highlight, on = h.on;
  const cover = new Float64Array(n).fill(NaN), partial = new Uint8Array(n), total = new Float64Array(n).fill(NaN), liqCut = new Uint8Array(n);
  const buys = BANDS.map(() => new Float64Array(n).fill(NaN)), sells = BANDS.map(() => new Float64Array(n).fill(NaN));
  for (let i = 0; i < n; i++) {
    const bar = input.bars[i], stats = bar?.stats;
    if (bar) { const share = coverageOf(bar, input.times[i]!, input.tfMs, input.now); if (share !== null) { cover[i] = share; partial[i] = isPartial(bar, input.times[i]!, input.tfMs, input.now, share) ? 1 : 0; } }
    if (!stats) continue;
    let all = 0;
    BANDS.forEach(([lo, hi], b) => { const buy = sum(stats.buy, lo, hi), sell = sum(stats.sell, lo, hi); buys[b]![i] = buy; sells[b]![i] = sell; all += buy + sell; });
    total[i] = all;
  }
  const whole = (i: number): boolean => partial[i] === 0;
  const rows: HistoryRow[] = [];
  // Liquidations: shorts liquidated (forced buys) up, longs liquidated (forced sells) down; a candle the loaded days do not cover is not known.
  const liq = input.liquidations, up = new Float64Array(n).fill(NaN), down = new Float64Array(n).fill(NaN);
  if (liq) for (let i = 0; i < n; i++) {
    const start = input.times[i]!, b = liq.buy.get(start), s = liq.sell.get(start);
    if (b !== undefined && s !== undefined) { up[i] = b; down[i] = s; if (liq.cutStarts?.has(start)) liqCut[i] = 1; }
  }
  rows.push({ key: 'liq', kind: 'liq', label: t('Liquidations'), parts: [part(1, up, () => true, h, on), part(-1, down, () => true, h, on)] });
  // Open interest: one neutral colour, up where it rose; not judged on a one-minute chart.
  const oi = new Float64Array(n).fill(NaN);
  if (input.oi) for (let i = 0; i < n; i++) { const v = input.oi.get(input.times[i]!); if (v !== undefined) oi[i] = v; }
  rows.push({ key: 'oi', kind: 'oi', label: t('OI change'), parts: [part(0, oi, () => true, h, on && input.oiJudged)] });
  BANDS.forEach((_, b) => {
    const buy = buys[b]!, sell = sells[b]!;
    const parts = input.mode === 'split' ? [part(1, buy, whole, h, on), part(-1, sell, whole, h, on)] : [part(0, buy.map((v, i) => v - sell[i]!), whole, h, on)];
    rows.push({ key: `size${b}`, kind: 'size', label: bandLabel(b), parts, band: b });
  });
  const shareKind = input.mode === 'split' ? 'volume' : 'net';
  const share = on ? shareMarks(BANDS.map((_, b) => buys[b]!.map((v, i) => shareKind === 'net' ? Math.abs(v - sells[b]![i]!) : v + sells[b]![i]!)), whole, h) : null;
  return { rows, sides: BANDS.map((_, b) => ({ buy: buys[b]!, sell: sells[b]! })), cover, partial, total, liqCut, share, shareKind };
}

/** Of the size rows at slot `i`: how many were judged (on any side), and how many the rule flags (a row once, whichever side). */
export function unusualRows(model: Pick<HistoryModel, 'rows'>, i: number): { flagged: number; judged: number } {
  let flagged = 0, judged = 0;
  for (const row of model.rows) {
    if (row.kind !== 'size') continue;
    if (row.parts.some(p => Number.isFinite(p.sigma[i]!) || p.flag[i] === 1)) judged++;
    if (row.parts.some(p => p.flag[i] === 1)) flagged++;
  }
  return { flagged, judged };
}

/**
 * What a part's judgement says at slot `i`, as one card line (null: nothing to say: a zero, a value not known, or nothing judged). `label`
 * names the line, or, for a row of one series, is null: the line is then called Unusual where the rule flags it, Close to unusual where its
 * bar is at least half lit (from three quarters of the multiple) without being flagged, and Not unusual below that, so the words match how
 * bright the bar is.
 */
function judgement(p: Part, i: number, label: string | null, partial: boolean, mult: number): InfoLine | null {
  const v = p.values[i]!;
  if (!Number.isFinite(v) || v === 0) return null;
  if (partial) return { label: label ?? t('Unusual'), text: t('Not judged: part of the candle was not recorded'), color: 'muted' };
  if (p.short[i]) return { label: label ?? t('Unusual'), text: t('Not judged yet: too few earlier candles to compare with'), color: 'muted' };
  const z = p.sigma[i]!;
  if (p.flag[i]) return { label: label ?? t('Unusual'), text: z > 0 ? t('{z}σ above its baseline', { z: z.toFixed(1) }) : t('Above a flat baseline'), bold: true };
  if (!Number.isFinite(z)) return null;
  return { label: label ?? (z >= 0.75 * mult ? t('Close to unusual') : t('Not unusual')), text: t('{z}σ from its baseline', { z: `${z < 0 ? '−' : ''}${Math.abs(z).toFixed(1)}` }), color: 'muted' };
}

/** What a row's bars are judged against, said once under its judgements. */
function baselineLine(kind: RowKind, seen: number): InfoLine {
  const text = kind === 'size' ? tn(seen, 'Its baseline: the {n} earlier candle with orders of this size', 'Its baseline: the {n} earlier candles with orders of this size')
    : kind === 'liq' ? tn(seen, 'Its baseline: the {n} earlier candle with liquidations on that side', 'Its baseline: the {n} earlier candles with liquidations on that side')
      : tn(seen, 'Its baseline: the {n} earlier candle', 'Its baseline: the {n} earlier candles');
  return { text, color: 'muted', wrap: true };
}

export interface CardContext {
  /** The candle's time as the page writes it. */
  time: string;
  /** The candle under way: its amounts so far. */
  live: boolean;
  /** Highlights on (else nothing is judged). */
  judging: boolean;
  /** Whose open interest the row shows (oiSourceText), and why there is none or it is not judged. */
  oiSource: string | null;
  oiNote: 'spot' | 'minute' | null;
  /** The Highlights' multiple (where the rule flags; a bar is lit from half of it). */
  mult: number;
  /** Whether the pane draws share dots on this row (it is tall enough, its candles wide enough): the card explains a dot only where one is. Absent: it does. */
  dots?: boolean;
  /** Open interest's change at this candle in the coin itself, and the coin's name, beside the dollars; absent where not known. */
  oiCoins?: { value: number; coin: string } | null;
}

/** The card of row `r` at slot `i`: its amounts, how unusual each side is, and how the candle's size rows stand together. Pure, so a test reads the words. */
export function cardLines(model: HistoryModel, r: number, i: number, ctx: CardContext): InfoLine[] {
  const row = model.rows[r]!, partial = model.partial[i] === 1, out: InfoLine[] = [];
  // What the share dot says, under the judgement and what it is judged against (so the two stay together).
  let dotNote: InfoLine | null = null;
  out.push({ text: row.kind === 'size' ? t('Market orders {band}', { band: row.label }) : row.kind === 'liq' ? t('Liquidations') : t('Open interest change'), bold: true });
  out.push({ label: t('Candle'), text: ctx.live ? `${ctx.time} · ${t('in progress: amounts so far')}` : ctx.time });
  const judgedParts: Part[] = [];
  const judged = (p: Part, label: string | null, isPartial: boolean): void => {
    if (!ctx.judging) return;
    const line = judgement(p, i, label, isPartial, ctx.mult);
    if (!line) return;
    out.push(line);
    if (!isPartial && !p.short[i]) judgedParts.push(p);
  };
  if (row.kind === 'size') {
    const sides = model.sides[row.band!]!, b = sides.buy[i]!, s = sides.sell[i]!;
    if (!Number.isFinite(b) || !Number.isFinite(s)) { out.push({ text: t('Nothing recorded for this candle.'), color: 'muted', rule: true }); return out; }
    const net = b - s;
    out.push({ label: t('Buys / sells'), text: `${plainUsd(b)} / ${plainUsd(s)}`, rule: true });
    out.push({ label: t('Net'), text: signedUsd(net), color: net > 0 ? 'buy' : net < 0 ? 'sell' : 'text' });
    if (b + s > 0) out.push({ label: t('Buy share'), text: `${Math.round(b / (b + s) * 100)}%` });
    // Its share of the candle, and where it was unusual, what it usually is (the dot, where the bar is not already lit): of the volume with Buys
    // and sells bars, of the six sizes' nets counted without their signs with Delta bars, said on a line of its own.
    const all = model.total[i]!, mark = ctx.judging && !partial ? model.share?.[row.band!] ?? null : null, marked = mark?.flag[i] === 1;
    // The share and what it usually is, to as many decimals as tell them apart (a tight baseline: 17.2 % against 16.7 %, not 17 % against 17 %).
    const shareLine = (label: string, value: number): InfoLine => {
      const usual = marked ? mark!.usual[i]! : NaN, digits = Number.isFinite(usual) ? [0, 1, 2].find(d => (value * 100).toFixed(d) !== (usual * 100).toFixed(d)) ?? 2 : 0;
      const text = `${(value * 100).toFixed(digits)}%`;
      return marked ? { label, text: `${text} · ${t('unusual: usually {share}%', { share: (usual * 100).toFixed(digits) })}`, bold: true, wrap: true } : { label, text };
    };
    if (all > 0) out.push(model.shareKind === 'volume' ? shareLine(t('Share of volume'), (b + s) / all) : { label: t('Share of volume'), text: `${Math.round((b + s) / all * 100)}%` });
    if (model.shareKind === 'net' && mark && Number.isFinite(mark.value[i]!)) out.push(shareLine(t('Share of the net'), mark.value[i]!));
    if (row.parts.length === 1) judged(row.parts[0]!, null, partial);
    else { judged(row.parts[0]!, t('Buys'), partial); judged(row.parts[1]!, t('Sells'), partial); }
    if (ctx.judging && ctx.dots !== false && shareDot(model, row, i, ctx.mult)) dotNote = ({ text: model.shareKind === 'net' ? t('The dot: this size\'s net was an unusually large part of the six sizes\' nets counted without their signs, on a candle with at least the usual net trading.') : t('The dot: this size\'s buys and sells were an unusually large part of the candle\'s market orders, on a candle at least as busy as usual.'), color: 'muted', wrap: true });
  } else if (row.kind === 'liq') {
    const [shorts, longs] = row.parts as [Part, Part], s = shorts.values[i]!, l = longs.values[i]!, cut = model.liqCut[i] === 1;
    if (!Number.isFinite(s) || !Number.isFinite(l)) { out.push({ text: t('Not known for this candle: the record does not reach it.'), color: 'muted', rule: true }); return out; }
    const at = (v: number): string => cut ? `≥ ${plainUsd(v)}` : plainUsd(v);
    out.push({ label: t('Shorts liquidated'), text: at(s), color: 'buy', rule: true });
    out.push({ label: t('Longs liquidated'), text: at(l), color: 'sell' });
    judged(shorts, t('Shorts'), false); judged(longs, t('Longs'), false);
    if (cut) out.push({ text: t('≈ A day of these candles held more than 5,000 liquidations: only its largest 5,000 are counted.'), color: 'muted', wrap: true });
  } else {
    const [oi] = row.parts as [Part], v = oi.values[i]!;
    if (ctx.oiNote === 'spot') { out.push({ text: t('Only spot markets are counted: they have no open interest.'), color: 'muted', wrap: true, rule: true }); return out; }
    if (!Number.isFinite(v)) { out.push({ text: t('Not known for this candle.'), color: 'muted', rule: true }); return out; }
    out.push({ label: t('Change'), text: ctx.oiCoins ? `${signedUsd(v)} · ${coinText(ctx.oiCoins.value, ctx.oiCoins.coin)}` : signedUsd(v), color: v > 0 ? 'buy' : v < 0 ? 'sell' : 'text', rule: true });
    if (ctx.oiSource) out.push({ label: t('Markets'), text: ctx.oiSource });
    if (ctx.oiNote === 'minute') out.push({ text: t('Not judged on a one-minute chart: some venues report open interest every few minutes, which puts several minutes of change into one.'), color: 'muted', wrap: true });
    else judged(oi, null, false);
  }
  if (judgedParts.length) out.push(baselineLine(row.kind, Math.max(...judgedParts.map(p => p.seen[i]!))));
  if (dotNote) out.push(dotNote);
  if (row.kind === 'size' && ctx.judging) {
    const k = unusualRows(model, i);
    if (k.judged > 0) out.push({ label: t('Unusual size rows'), text: t('{rank} of {total}', { rank: k.flagged, total: k.judged }), rule: true });
  }
  if (partial && row.kind === 'size' && model.cover[i]! > 0) out.push({ label: t('Recorded'), text: t('{share} % of the candle: the figure counts only that part', { share: Math.round(model.cover[i]! * 100) }), color: 'sell', wrap: true });
  return out;
}
