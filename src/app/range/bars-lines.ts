import { lineOf, orderPool, pooledSkew, sizeDelta, slotTime, type StatDef, type StatInput, type StatTone } from '../panes/bar-stats.ts';
import { volText, type Bar } from '../panes/footprint.ts';
import { clock, price as fmtPrice } from '../format.ts';
import { t, tn } from '../i18n.ts';
import { durationText, signedCoins, spanText } from './oi-lines.ts';
import type { RangeSelection } from './selection.ts';
import type { GridItem, RangeLine } from './stats.ts';

/**
 * What the Bar stats pane worked out last, handed to its Range summary (provider.ts): its table's input, the statistics chosen (in their order)
 * and each one's value per slot, and what it was worked out for. The table holds the candles of the view (and one each side), so a closed
 * selection's result is kept once the table held all of it (`BarsRangeSummary`).
 */
export interface BarsPaneHeld {
  /** What it was worked out for (markets, timeframe, the statistics and the options their arithmetic uses): another is not summed up as this one. */
  key: string;
  tfMs: number; tf: string;
  /** The table's input, with its slots' starts, the candle length and the clock it was worked out at. */
  input: StatInput;
  times: readonly number[];
  defs: readonly StatDef[];
  values: readonly (readonly (number | null)[])[];
  /** How many markets the footprint counts, how many the OI pane counts, the coin, the chart market's name (the candle statistics are its own) and its quote currency. */
  markets: number; oiMarkets: number; coin: string; candleMarket: string; quote: string;
  /** In a replay, the start of the bar under way at its moment, or null live. */
  replayAt: number | null;
  /**
   * The span the footprint's bars were answered for, [from, to): a candle there that the table spans without a bar had no trades recorded;
   * elsewhere it is unknown (the footprint can hold an answer wider than the view, the table only the view's candles).
   */
  answered: { from: number; to: number } | null;
}

/** The statistics led with where chosen (in the person's order, five at most); the others go in the grid. */
const LEADING = ['vol', 'delta', 'deltaPct', 'trades', 'oiChange'];
/** The statistics whose sizes are set by the retail and whale lines (≈ where a bar's line was taken at a box edge). */
const LINE_STATS: Readonly<Record<string, 'retail' | 'whale'>> = { whaleShare: 'whale', deltaWhales: 'whale', cvdWhales: 'whale', deltaRetail: 'retail', cvdRetail: 'retail' };
/** The statistics in dollars: their figures say so. */
const USD = new Set(['vol', 'delta', 'cvd', 'buyVol', 'sellVol', 'takerDelta', 'maxBuy', 'maxSell', 'avgTrade', 'avgBuy', 'avgSell', 'deltaRetail', 'deltaWhales', 'cvdRetail', 'cvdWhales', 'effort', 'liq', 'liqNet']);
/** The exchange's own candles (Binance's taker figures), the chart's candles. */
const TAKER = new Set(['takerDelta', 'fills', 'avgFill']);
const CANDLE = new Set(['range', 'closePos', 'effort']);
/** The statistics read from the chart market's candles (its own exchange candles included): the status line names that market. */
const CANDLE_MARKET = new Set([...TAKER, ...CANDLE, 'divergence', 'pocPos']);
/** The counts: their figures get digit groups. */
const COUNTS = new Set(['trades', 'buys', 'sells', 'fills', 'imbalances', 'stacked']);
const usdText = (v: number, signed: boolean): string => v === 0 ? '$0' : `${signed && v > 0 ? '+' : v < 0 ? '−' : ''}$${volText(Math.abs(v))}`;
const signTone = (v: number): StatTone => v > 0 ? 'buy' : v < 0 ? 'sell' : 'text';
/** The statistics with a sign (their table cells write a minus only). */
const SIGNED = new Set(['delta', 'takerDelta', 'deltaRetail', 'deltaWhales', 'liqNet']);
/** A written figure that is zero (its sign, dollar and percent aside): it takes no side's colour. */
const isZero = (value: string): boolean => /^[+\-−]?\$?0(\.0+)?%?$/.test(value);
/** A View figure as this panel writes it: a plus or minus sign on the signed ones, a dollar sign on the dollars, digit groups on the counts. */
const written = (id: string, value: string): string => /^[+\-−]?0(\.0+)?$/.test(value) ? `${USD.has(id) ? '$' : ''}0` : COUNTS.has(id) && /^\d{4,}$/.test(value) ? Number(value).toLocaleString('en-US') : value.replace(/^([+\-−]?)/, (_m, sign: string) =>
  (sign === '-' ? '−' : sign || (SIGNED.has(id) ? '+' : '')) + (USD.has(id) ? '$' : ''));
/** The summary's own tip where the table's describes something else (a running level, how cells are drawn). */
function tipOf(def: StatDef): string {
  switch (def.id) {
    case 'cvd': case 'cvdRetail': case 'cvdWhales': return t('The running sum\'s change over the selection: each candle\'s own increment added up, whatever ran before it.');
    case 'cover': return t('The minutes with trades recorded on any market counted, over all the minutes of the selection\'s candles; unknown where the footprint was not asked about them.');
    default: return def.title;
  }
}

/** Labels of the summary where the table's short one would mislead over a stretch (what is pooled, what is per candle). */
function labelOf(def: StatDef): string {
  switch (def.id) {
    case 'vol': return t('Volume');
    case 'delta': return t('Delta');
    case 'deltaPct': return t('Delta % of volume');
    case 'trades': return t('Market orders');
    case 'oiChange': return t('Open interest change');
    case 'cvd': return t('CVD change');
    case 'cvdRetail': return t('Retail CVD change');
    case 'cvdWhales': return t('Whale CVD change');
    case 'maxBuy': return t('Largest single-candle buy row');
    case 'maxSell': return t('Largest single-candle sell row');
    case 'poc': return t('Pooled point of control');
    case 'pocPos': return t('Pooled POC in range');
    case 'closePos': return t('Last close in whole range');
    case 'effort': return t('Candle volume / bp of whole range');
    default: return def.label;
  }
}

/** One chosen statistic over the selection: its words, its figure (null: unavailable), on how many candles, whether it is ≈, and category counts. */
export interface BarsFigure {
  id: string; label: string; title: string; value: string | null; tone: StatTone; known: number; approx: boolean; note?: string;
  rows?: { label: string; value: string; tone?: StatTone }[];
}

/** The selection's slots of the table, the candles it spans on the grid, the recording over them and each chosen statistic. */
export interface BarsStretch {
  /** The grid span: the first candle start in the selection to the end of its last. */
  t0: number; t1: number;
  /** The table's slots that start in the selection. */
  at: number[];
  /** Candles of the grid in the selection, and those inside the table's span (the rest are outside the view). */
  expected: number; spanned: number;
  /** Candles with executions held; minutes recorded on any market counted, of the selection's minutes, and minutes unknown. */
  withBars: number; recorded: number; minutes: number; unknown: number;
  figures: BarsFigure[];
  step: number;
}

/** The figures of the chosen statistics over the selection: each by its own rule (sums, pooled ratios, the pooled point of control, counts). */
export function barsStretch(held: BarsPaneHeld, sel: Pick<RangeSelection, 't0' | 't1'>): BarsStretch | null {
  const tf = held.tfMs, input = held.input, times = held.times, end = held.replayAt !== null ? Math.min(sel.t1, held.replayAt) : sel.t1;
  const first = Math.ceil(sel.t0 / tf) * tf, expected = Math.max(0, Math.ceil((end - first) / tf));
  if (!expected || !times.length) return null;
  const index = new Map(times.map((s, i) => [s, i] as const)), lo = times[0]!, hi = times[times.length - 1]!;
  // Each candle's minutes (what of it has passed while it is under way): recorded where a bar holds them, none where the table spans the
  // candle and the footprint was answered for it without a bar, unknown where a bar does not say (an older source), nothing was asked, or
  // the candle is outside the table (the footprint may have been answered wider than the view, but the table holds only the view's bars).
  const now = input.now ?? Date.now(), answered = held.answered, at: number[] = [];
  const from = answered ? Math.max(answered.from, lo) : Infinity, to = answered ? Math.min(answered.to, hi + tf) : -Infinity;
  let minutes = 0, recorded = 0, unknown = 0, withBars = 0, spanned = 0;
  for (let k = 0; k < expected; k++) {
    const s = first + k * tf, m = Math.max(1, Math.ceil((Math.min(now, s + tf) - s) / 60_000)), i = index.get(s), bar = i === undefined ? null : input.bars[i] ?? null;
    minutes += m;
    if (s >= lo && s <= hi) spanned++;
    if (i !== undefined) at.push(i);
    if (bar) { withBars++; if (bar.minutes === undefined) unknown += m; else recorded += Math.min(bar.minutes, m); }
    else if (s < from || s >= to) unknown += m;
  }
  // No candle of the selection inside the table's span: nothing held of it. Inside the span, a candle without a slot or a bar is a gap.
  if (!spanned) return null;
  const figures = held.defs.map((def, k) => figure(def, held.values[k] ?? [], at, expected, held, { recorded, minutes, unknown }));
  return { t0: first, t1: first + expected * tf, at, expected, spanned, withBars, recorded, minutes, unknown, figures, step: input.step };
}

/** On how many of the selected slots a statistic's sources are there: bars (with trade statistics for the order ones), candles, the exchange's candles, or a value. */
function supportOf(def: StatDef, input: StatInput, at: readonly number[], values: readonly (number | null)[]): number {
  const has = (test: (i: number) => boolean): number => at.filter(test).length;
  if (TAKER.has(def.id)) return has(i => input.taker?.has(slotTime(input, i)) ?? false);
  if (CANDLE.has(def.id)) return has(i => input.candles.has(slotTime(input, i)));
  if (def.id === 'pocPos') return has(i => !!input.bars[i] && input.candles.has(slotTime(input, i)));
  if (def.source === 'executions' && def.group === 'trades') return has(i => !!input.bars[i]?.stats);
  if (def.source === 'executions' && def.scale !== 'category' && def.id !== 'cover') return has(i => !!input.bars[i]);
  return has(i => values[i] !== null && values[i] !== undefined);
}

/**
 * One statistic over the selected slots `at`. The pane's own View reducer where it holds for any set of candles (sums, maxima, ratios of
 * sums, the pooled point of control, the whole range); its own rule where it does not: a running sum's change (its increments added up, not
 * its newest level), the recording over every candle of the grid, a point of control's move (per candle only), the marks counted by kind
 * (not the commonest alone), the size skew in words.
 */
function figure(def: StatDef, values: readonly (number | null)[], at: readonly number[], n: number, held: BarsPaneHeld, cover: { recorded: number; minutes: number; unknown: number }): BarsFigure {
  const input = held.input, known = supportOf(def, input, at, values);
  const base = { id: def.id, label: labelOf(def), title: tipOf(def), known, approx: approxIn(def.id, at, held) };
  const bars = at.flatMap(i => { const bar = input.bars[i]; return bar ? [bar] : []; });
  switch (def.id) {
    case 'cvd': case 'cvdRetail': case 'cvdWhales': {
      // The change over the selection: each candle's increment added up (the running level holds candles before it, or starts each day).
      let sum = 0, k = 0;
      for (const bar of bars) {
        const d = def.id === 'cvd' ? bar.buyUsd - bar.sellUsd : sizeDelta(bar, input, def.id === 'cvdRetail' ? 'retail' : 'whale');
        if (d !== null) { sum += d; k++; }
      }
      return { ...base, known: k, value: k ? usdText(sum, true) : null, tone: signTone(sum), ...(def.id === 'cvd' ? { note: t('The running sum\'s change over the selection: the same as its delta.') } : {}) };
    }
    case 'cover':
      // The recording over every candle of the selection, a candle without executions counted as none (unknown minutes: no percentage).
      return { ...base, known: n, value: cover.unknown > 0 || !(cover.minutes > 0) ? null : `${Math.round(cover.recorded / cover.minutes * 100)}%`, tone: 'text',
        ...(cover.unknown > 0 ? { note: tn(cover.unknown, '{n} minute unknown', '{n} minutes unknown') } : {}) };
    case 'pocMove':
      return { ...base, known: n, value: t('per candle only'), tone: 'text', note: t('Each candle\'s point of control against the one before it: no total over a stretch.') };
    case 'divergence': case 'oiQuad': {
      const counts = new Map<number, number>();
      for (const i of at) { const v = values[i]; if (v !== null && v !== undefined) counts.set(v, (counts.get(v) ?? 0) + 1); }
      const kinds: [number, string, StatTone][] = def.id === 'divergence'
        ? [[1, t('Net buying / price down'), 'buy'], [-1, t('Net selling / price up'), 'sell'], [0, t('No opposite-direction mark'), 'text']]
        : [[1, t('OI up / net buying'), 'buy'], [2, t('OI up / net selling'), 'sell'], [3, t('OI down / net buying'), 'buy'], [4, t('OI down / net selling'), 'sell'], [0, t('OI or delta unchanged'), 'text']];
      const rows = kinds.map(([v, label, tone]) => ({ label, value: String(counts.get(v) ?? 0), tone: (counts.get(v) ?? 0) > 0 ? tone : 'text' as StatTone }));
      rows.push({ label: t('Unavailable'), value: String(n - known), tone: 'text' });
      const spot = def.id === 'oiQuad' && input.perps === false;
      return { ...base, value: known ? '' : null, tone: 'text', rows, ...(spot ? { note: t('Spot markets alone: they have no open interest.') } : {}) };
    }
    case 'oiChange': {
      let sum = 0;
      for (const i of at) { const v = values[i]; if (v !== null && v !== undefined) sum += v; }
      return { ...base, value: known ? (input.options.oiUnits === 'usd' ? usdText(sum, true) : signedCoins(sum, held.coin)) : null, tone: signTone(sum) };
    }
    case 'sizeSkew': {
      // Which side's orders were larger, in words: colour alone does not say it.
      const log = pooledSkew(orderPool(bars));
      if (log === null) return { ...base, value: null, tone: 'text' };
      const ratio = (2 ** Math.abs(log)).toFixed(1);
      return { ...base, value: log >= 0 ? t('Buy orders averaged ×{n} sell orders', { n: ratio }) : t('Sell orders averaged ×{n} buy orders', { n: ratio }), tone: log > 0 ? 'buy' : log < 0 ? 'sell' : 'text' };
    }
    case 'avgFill': {
      const cell = def.view?.(input, at, values) ?? null;
      return { ...base, value: cell ? `${written(def.id, cell.value)}${held.quote ? ` ${held.quote}` : ''}` : null, tone: cell?.tone ?? 'text' };
    }
    default: {
      // A point of control needs volume traded: rows that hold none have no busiest one.
      // (Its place in the range: on the slots with both rows and a candle, as the View reducer takes them.)
      const traded = (i: number): boolean => { const bar = input.bars[i]; return !!bar && bar.buyUsd + bar.sellUsd > 0 && (def.id === 'poc' || input.candles.has(slotTime(input, i))); };
      if ((def.id === 'poc' || def.id === 'pocPos') && !at.some(traded)) return { ...base, value: null, tone: 'text' };
      const cell = def.view?.(input, at, values) ?? null, value = cell ? written(def.id, cell.value) : null;
      // A signed figure at zero takes no side (a share of a range at 0 % keeps its colour: it is the low end, not "neither").
      return { ...base, value, tone: value === null || ((SIGNED.has(def.id) || def.id === 'deltaPct') && isZero(value)) ? 'text' : cell?.tone ?? 'text' };
    }
  }
}

/** Whether a statistic is ≈ over the selection itself: a size line taken at a box edge in one of its bars, or a cut day of liquidations among its candles. */
function approxIn(id: string, at: readonly number[], held: BarsPaneHeld): boolean {
  const input = held.input, line = LINE_STATS[id];
  if (line) return at.some(i => { const bar: Bar | null | undefined = input.bars[i]; return !!bar && lineOf(bar, input, line)?.exact === false; });
  if (id === 'liq' || id === 'liqNet') { const cut = input.liquidations?.cutStarts; return !!cut && at.some(i => cut.has(slotTime(input, i))); }
  return false;
}

/**
 * The Bar stats pane's Range summary (provider.ts): the chosen statistics over the selection, each by its own rule; the leading ones (volume,
 * delta, delta %, orders, OI change, where chosen) as lines, the rest in a grid; the recording over the selection. The table holds the
 * candles of the view, so the last complete result of a closed selection is kept when the view moves away.
 */
export class BarsRangeSummary {
  #kept: BarsKept | null = null;
  #last: { held: BarsPaneHeld | null; sel: RangeSelection; shown: boolean; current: string; slot: number; zone: string; noStats: boolean; lines: RangeLine[] } | null = null;

  /** `noStats`: no statistic is chosen (the pane then holds no table). */
  lines(sel: RangeSelection, held: BarsPaneHeld | null, shown: boolean, current: string, now: number, zone = '', noStats = false): RangeLine[] {
    const last = this.#last, slot = held ? Math.floor(now / held.tfMs) : 0;
    if (last && last.held === held && last.sel === sel && last.shown === shown && last.current === current && last.slot === slot && last.zone === zone && last.noStats === noStats) return last.lines;
    const lines = this.#lines(sel, held, shown, current, now, noStats);
    this.#last = { held, sel, shown, current, slot, zone, noStats, lines };
    return lines;
  }

  #lines(sel: RangeSelection, held: BarsPaneHeld | null, shown: boolean, current: string, now: number, noStats: boolean): RangeLine[] {
    const title = (text: string): RangeLine => ({ key: 'bs-title', kind: 'title', cells: [text] });
    const note = (key: string, text: string): RangeLine => ({ key, kind: 'note', tone: 'muted', cells: [text] });
    if (noStats) return [title(spanText(sel.t0, sel.t1)), note('bs-none', t('No statistics selected: use Stats to add some.'))];
    if (held && held.key !== current) return [title(spanText(sel.t0, sel.t1)), note('bs-stale', t('The Bar stats pane last drew another market, timeframe or choice of stats: show it to sum up this selection.'))];
    // A complete result of a closed selection is kept, and shown again for the same selection and what it was worked out for while the pane
    // holds fewer of its candles (the view moved away, or holds none at all), or, spanning them, fewer of their executions (the footprint
    // asked again on new rows and has not reached back to them yet).
    const end = held ? (held.replayAt !== null ? Math.min(sel.t1, held.replayAt) : sel.t1) : null;
    const now0 = held ? barsStretch(held, sel) : null, complete = now0 !== null && now0.spanned >= now0.expected;
    const forming = held !== null && now0 !== null && held.replayAt === null && now0.t1 > Math.floor(now / held.tfMs) * held.tfMs;
    const same = (r: BarsKept | null): r is BarsKept => r !== null &&r.current === current && r.t0 === sel.t0 && r.t1 === sel.t1 && (end === null || r.end === end);
    const poorer = complete && !forming && same(this.#kept) && now0!.withBars < this.#kept.s.withBars;
    if (held && complete && !forming && !poorer) this.#kept = { current, t0: sel.t0, t1: sel.t1, end: end!, s: now0!, scope: scopeOf(held) };
    const k = this.#kept, kept = (!complete || poorer) && same(k) ? k : null;
    if (!held && !kept) return [title(spanText(sel.t0, sel.t1)), note('bs-none', shown ? t('Bar stats appear once executions are recorded for the visible candles.') : t('The Bar stats pane has not drawn this market yet: show it to sum up this selection.'))];
    if (!now0 && !kept) {
      const h = held!, first = Math.ceil(sel.t0 / h.tfMs) * h.tfMs, expected = Math.max(0, Math.ceil((end! - first) / h.tfMs));
      return [title(spanText(sel.t0, sel.t1)), note('bs-none', expected > 0 ? t('The pane holds {k} of the {n} candles: the rest are outside the view.', { k: 0, n: expected }) : t('No {tf} candle of the Bar stats pane starts in this range.', { tf: h.tf }))];
    }
    const s = kept?.s ?? now0!, scope = kept?.scope ?? scopeOf(held!), n = s.expected;
    const lines: RangeLine[] = [title(`${spanText(s.t0, s.t1)} · ${durationText(s.t1 - s.t0)} · ${tn(n, '{n} candle of {tf}', '{n} candles of {tf}', { tf: scope.tf })}${forming ? ` · ${t('forming')}` : ''}`)];
    // What it counts: the footprint's markets, the chart market's candles and the OI pane's markets, where a chosen statistic reads them.
    const status: string[] = [tn(scope.markets, '{n} market of the footprint', '{n} markets of the footprint')];
    if (s.step > 0) status.push(t('rows of {step}', { step: `$${fmtPrice(s.step, s.step)}` }));
    if (scope.candleMarket && scope.defs.some(d => CANDLE_MARKET.has(d.id))) status.push(t('candles of {market}', { market: scope.candleMarket }));
    if (scope.defs.some(d => d.id === 'oiChange' || d.id === 'oiQuad')) status.push(tn(scope.oiMarkets, 'open interest of {n} market', 'open interest of {n} markets'));
    if (sel.t0 % scope.tfMs !== 0 || sel.t1 % scope.tfMs !== 0) status.push(t('the {tf} candles that start in the selection', { tf: scope.tf }));
    if (scope.replayAt !== null) status.push(t('replay: candles closed by {time}', { time: clock(scope.replayAt, true) }));
    lines.push(note('bs-status', status.join(' · ')));
    if (!shown) lines.push(note('bs-hidden', t('The Bar stats pane is hidden: these are the candles it last held.')));
    if (sel.p0 !== null && sel.p1 !== null) lines.push(note('bs-prices', t('Bar stats use all prices.')));
    if (kept) lines.push(note('bs-kept', poorer ? t('As worked out earlier, when the pane held more of these candles\' executions.') : t('As worked out while these candles were in view.')));
    else if (s.spanned < s.expected) lines.push(note('bs-partial', t('The pane holds {k} of the {n} candles: the rest are outside the view.', { k: s.spanned, n: s.expected })));
    // The recording: candles with executions held, and minutes with trades recorded on any market counted (not every market throughout).
    lines.push({ key: 'h-bs-rec', kind: 'heading', cells: [t('Recording')] });
    lines.push({ key: 'bs-candles', kind: 'stat', cells: [t('Candles with executions held'), t('{k} of {n}', { k: s.withBars, n })] });
    if (s.unknown > 0) lines.push(
      { key: 'bs-minutes', kind: 'stat', cells: [t('Recorded minutes held'), t('{k} of {n}', { k: s.recorded, n: s.minutes })] },
      { key: 'bs-unknown', kind: 'stat', tone: 'muted', cells: [t('Coverage unknown'), tn(s.unknown, '{n} minute', '{n} minutes')] });
    else lines.push({ key: 'bs-minutes', kind: 'stat', cells: [t('Recorded minutes, any market'), `${t('{k} of {n}', { k: s.recorded, n: s.minutes })} · ${s.minutes > 0 ? Math.round(s.recorded / s.minutes * 100) : 0}%`] });
    lines.push(note('bs-rec-note', t('A minute counts once any market counted has a trade recorded in it, not every market.')));
    // The leading figures as lines, the rest in a grid; each says on how many candles it stands where that is fewer than all.
    const lead = s.figures.filter(f => LEADING.includes(f.id)).slice(0, 5), rest = s.figures.filter(f => !lead.includes(f));
    const support = (f: BarsFigure): string => f.known < n && f.value !== null && !f.rows && f.id !== 'pocMove' && f.id !== 'cover' ? t('{k} of {n} candles', { k: f.known, n }) : '';
    if (lead.length) lines.push({ key: 'h-bs-lead', kind: 'heading', cells: [t('Over the selection')] });
    for (const f of lead) {
      const more = support(f);
      lines.push({ key: `bs-${f.id}`, kind: 'stat', ...(f.value === null ? { tone: 'muted' as const } : f.tone !== 'text' ? { tone: f.tone } : {}), cells: [`${f.approx ? '≈' : ''}${f.label}`, f.value === null ? t('unavailable') : `${f.value}${more ? ` · ${more}` : ''}`] });
    }
    if (rest.length) {
      const items: GridItem[] = rest.map(f => {
        const extra = [f.note ?? '', support(f)].filter(Boolean).join(' · ');
        return { key: f.id, label: `${f.approx ? '≈' : ''}${f.label}`, value: f.value === null ? t('unavailable') : f.value, ...(f.value === null ? { tone: 'muted' as const } : f.tone !== 'text' ? { tone: f.tone } : {}), tip: f.title, ...(extra ? { note: extra } : {}), ...(f.rows ? { rows: f.rows.map(r => ({ label: r.label, value: r.value, ...(r.tone && r.tone !== 'text' ? { tone: r.tone } : {}) })) } : {}) };
      });
      lines.push({ key: 'h-bs-grid', kind: 'heading', cells: [lead.length ? t('More chosen stats') : t('Chosen stats')] }, { key: 'bs-grid', kind: 'grid', cells: [], grid: items });
    }
    // ≈ says which statistics and why: a size line between two recorded boxes, or a day of liquidations answered with its largest only.
    const sized = s.figures.filter(f => f.approx && LINE_STATS[f.id]).map(f => f.label), liq = s.figures.filter(f => f.approx && (f.id === 'liq' || f.id === 'liqNet')).map(f => f.label);
    if (sized.length) lines.push(note('bs-approx-size', t('≈ {stats}: in some of these candles only the size boxes are known, so the size line is taken at the nearest box edge.', { stats: sized.join(', ') })));
    if (liq.length) lines.push(note('bs-approx-liq', t('≈ {stats}: a day of these candles held more than 5,000 liquidations, and only its largest 5,000 are counted.', { stats: liq.join(', ') })));
    return lines;
  }
}

/** What a result was worked out for, kept with it: the markets counted, the candle market, the statistics, the timeframe and the replay's cut. */
type BarsScope = Pick<BarsPaneHeld, 'markets' | 'oiMarkets' | 'candleMarket' | 'quote' | 'defs' | 'tf' | 'tfMs' | 'replayAt'>;
/** A complete result of a closed selection, with what it was worked out for (the key current then, the selection, the replay's cut). */
interface BarsKept { current: string; t0: number; t1: number; end: number; s: BarsStretch; scope: BarsScope }
const scopeOf = (h: BarsPaneHeld): BarsScope => ({ markets: h.markets, oiMarkets: h.oiMarkets, candleMarket: h.candleMarket, quote: h.quote, defs: h.defs, tf: h.tf, tfMs: h.tfMs, replayAt: h.replayAt });
