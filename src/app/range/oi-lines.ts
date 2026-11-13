import type { CandleRow, OiBar } from '../store.ts';
import type { NlnsCandle } from '../delta/nlns.ts';
import type { OiPart } from '../oi-change.ts';
import type { Liquidation } from '../../shared/liquidations.ts';
import { oiChangeByTime, oiUsdChangeByTime } from '../oi-change.ts';
import { venueLabel } from '../venues.ts';
import { clock, price as fmtPrice, usd } from '../format.ts';
import { t, tn } from '../i18n.ts';
import { oiStretch, type OiStretch, type OiWho } from './oi-summary.ts';
import type { RangeSelection } from './selection.ts';
import type { RangeLine, StackPart } from './stats.ts';

/**
 * What the OI pane drew last, handed to its Range summary (provider.ts): the same series, venues, change support, NL/NS model and replay
 * cut, so the summary adds up to the bars on screen and never asks for anything.
 */
export interface OiPaneHeld {
  /** What it was drawn for (coin, timeframe, whose open interest): a summary of another is not this one's. */
  key: string;
  oi: readonly OiBar[];
  tfMs: number;
  /** The timeframe's name ("1h"). */
  tf: string;
  /** Venues added together: how many hold a level at each bar, and how many its change is made of (`OiSum`); null for one market. */
  venues: readonly number[] | null;
  counted: readonly number[] | null;
  /** Which markets each bar's change is made of (oiCohorts), venues added together; else null. */
  cohorts: readonly string[] | null;
  parts: readonly OiPart[];
  /** The NL/NS candles by start (those of the view when the pane drew); null with Bars: Net, or with no bar in view. `whoOn`: Bars is NL/NS. */
  who: ReadonlyMap<number, NlnsCandle> | null;
  whoOn: boolean;
  /** Highlights' flags per bar, with Highlights on. */
  flag: ArrayLike<number> | null;
  candles: readonly CandleRow[];
  /** The chart's candles are the coin's own market's, and its name ("Binance BTCUSDT"). */
  ownPrice: boolean; priceMarket: string;
  coin: string;
  /** One market alone: its name; null for venues added together. */
  market: string | null;
  /** The markets counted (their instrument ids). */
  ids: readonly string[];
  /** One inverse market's coins are its USD over this price (`AppState.oiPrice`); else 0. */
  usdAt: number;
  /** Where Bybit's scaled history takes over the line (oi-long.ts): the bars before it are not drawn, and not counted; null without it. */
  seam: number | null;
  /** In a replay, the start of the bar under way at its moment (the bars held closed by then), or null live. */
  replayAt: number | null;
}

/**
 * Liquidations the map holds, from the smallest the Liquidations panel shows, and the window they were read for (`held`: from, to, the size
 * they were read from, whether the answer was cut at its limit, whether it stays open on the live stream); null when they are off.
 */
export interface OiLiquidations { items: readonly Liquidation[]; version: number; min: number; held: { t0: number; t1: number; min: number; cut: boolean; live: boolean } | null }

/** The bars of `held` the selection holds: those that start inside it (and after Bybit's scaled history, which is not counted). */
export function stretchBars(held: Pick<OiPaneHeld, 'oi' | 'seam'>, sel: Pick<RangeSelection, 't0' | 't1'>): { i0: number; i1: number } {
  const from = Math.max(sel.t0, held.seam ?? -Infinity);
  let i0 = 0; while (i0 < held.oi.length && held.oi[i0]![0] < from) i0++;
  let i1 = i0 - 1; while (i1 + 1 < held.oi.length && held.oi[i1 + 1]![0] < sel.t1) i1++;
  return { i0, i1 };
}

/** Coins as the pane's scale writes them (245,097), with a decimal below 10 and two figures below 1, so a small change never reads as 0. */
export const amount = (v: number): string => { const a = Math.abs(v); return a >= 1e6 ? usd(v) : a >= 10 ? fmtPrice(v, 1) : a >= 1 ? v.toFixed(1) : a === 0 ? '0' : v.toPrecision(2); };
export const signedCoins = (v: number, coin: string): string => `${v > 0 ? '+' : v < 0 ? '−' : ''}${amount(Math.abs(v))}${coin ? ` ${coin}` : ''}`;
export const signedUsd = (v: number): string => `${v > 0 ? '+' : v < 0 ? '−' : ''}$${usd(Math.abs(v))}`;
const share = (x: number, of: number): string => of > 0 ? ` (${Math.round(x / of * 100)}%)` : '';
/** The day of a moment as the clock writes it ("Nov 12"), to say a time with its date only where the day changes. */
export const dayOf = (at: number): string => clock(at, true).slice(0, -6);
/** A span's two ends: the first with its date, the second with its date too when it falls on another day (a minute before the end decides). */
export const spanText = (t0: number, t1: number): string => `${clock(t0, true)} – ${clock(t1, dayOf(t1 - 1) !== dayOf(t0))}`;
const tone = (v: number): 'buy' | 'sell' | undefined => v > 0 ? 'buy' : v < 0 ? 'sell' : undefined;
export const durationText = (ms: number): string => {
  const minutes = Math.round(ms / 60_000);
  if (minutes < 120) return tn(minutes, '{n} min', '{n} min');
  const hours = minutes / 60;
  return hours < 48 ? t('{n} h', { n: Number.isInteger(hours) ? hours : hours.toFixed(1) }) : t('{n} days', { n: (hours / 24).toFixed(1) });
};
const rangeText = (lo: number | null, hi: number | null): string => lo === hi ? String(lo ?? 0) : `${lo ?? 0}–${hi ?? 0}`;

/**
 * The OI pane's Range summary (provider.ts): `lines` sums up a selection from what the pane drew last. It keeps, for the selection on show,
 * the last NL/NS result that covered all of its candles: the pane works NL/NS out for the candles in view, so scrolling away (or minute
 * readings ageing out) must not take the estimate away from a closed selection.
 */
export class OiRangeSummary {
  #kept: { key: string; who: OiWho } | null = null;
  /**
   * The last lines and what they were made of: the snapshot, the selection, whether the pane shows, the liquidations (their book's version: it
   * grows in place), the coin and markets now, the candle under way (the only time the lines read) and the time zone the clock writes in.
   */
  #last: { held: OiPaneHeld | null; sel: RangeSelection; shown: boolean; liq: string; current: string; slot: number; zone: string; lines: RangeLine[] } | null = null;

  /** `current`: the coin, timeframe and markets now (the held snapshot must be of them); `now`: the page's clock; `zone`: the clock's time zone. */
  lines(sel: RangeSelection, held: OiPaneHeld | null, shown: boolean, liquidations: OiLiquidations | null, current: string, now: number, zone = ''): RangeLine[] {
    const last = this.#last, slot = held ? Math.floor(now / held.tfMs) : 0, w = liquidations?.held;
    const liq = liquidations ? `${liquidations.version}|${liquidations.min}|${w ? `${w.t0}|${w.t1}|${w.min}|${w.cut}|${w.live}` : '-'}` : '';
    if (last && last.held === held && last.sel === sel && last.shown === shown && last.liq === liq && last.current === current && last.slot === slot && last.zone === zone) return last.lines;
    const lines = this.#lines(sel, held, shown, liquidations, current, now);
    this.#last = { held, sel, shown, liq, current, slot, zone, lines };
    return lines;
  }

  #lines(sel: RangeSelection, held: OiPaneHeld | null, shown: boolean, liquidations: OiLiquidations | null, current: string, now: number): RangeLine[] {
    const title = (text: string): RangeLine => ({ key: 'oi-title', kind: 'title', cells: [text] });
    if (!held || !held.oi.length) return [title(spanText(sel.t0, sel.t1)), { key: 'oi-none', kind: 'note', tone: 'muted', cells: [shown ? t('No open-interest history for this market yet.') : t('The OI pane has not drawn open interest for this market yet: show it to sum up this selection.')] }];
    if (held.key !== current) return [title(spanText(sel.t0, sel.t1)), { key: 'oi-stale', kind: 'note', tone: 'muted', cells: [t('The OI pane last drew another market or timeframe: show it to sum up this selection.')] }];
    const { i0, i1 } = stretchBars(held, sel), usdAt = held.market && held.usdAt > 0 ? held.usdAt : 0;
    const closes = new Map(held.candles.map(c => [c[0], c[4]] as const));
    const usdMap = held.ownPrice || usdAt > 0 ? oiUsdChangeByTime(held.oi, held.parts, held.tfMs, at => held.ownPrice ? closes.get(at) : undefined, usdAt) : null;
    const formingFrom = held.replayAt === null ? Math.floor(now / held.tfMs) * held.tfMs : Infinity;
    const s = oiStretch({ oi: held.oi, change: oiChangeByTime(held.oi, held.parts, held.tfMs), i0, i1, tfMs: held.tfMs, venues: held.venues, counted: held.counted, cohorts: held.cohorts, formingFrom, parts: held.parts, who: held.who, candles: held.candles, ownPrice: held.ownPrice, usd: usdMap, flag: held.flag });
    if (!s) return [title(spanText(sel.t0, sel.t1)), { key: 'oi-none', kind: 'note', tone: 'muted', cells: [t('No {tf} candle of the OI pane starts in this range.', { tf: held.tf })] }];
    const n = s.bars, forming = s.t1 > formingFrom;
    // The NL/NS result kept for this selection: the newest that covered every candle, unless the pane holds one as complete now.
    const keyOf = `${held.key}|${held.replayAt}|${s.t0}|${s.t1}`;
    if (s.who && s.who.candles >= n && !forming) this.#kept = { key: keyOf, who: s.who };
    const kept = this.#kept?.key === keyOf && (!s.who || s.who.candles < n) ? this.#kept.who : null;
    const who = kept ?? s.who;

    const lines: RangeLine[] = [title(`${spanText(s.t0, s.t1)} · ${durationText(s.t1 - s.t0)} · ${tn(n, '{n} candle of {tf}', '{n} candles of {tf}', { tf: held.tf })}${forming ? ` · ${t('forming')}` : ''}`)];
    lines.push({ key: 'oi-status', kind: 'note', tone: 'muted', cells: [statusText(s, held, sel)] });
    if (!shown) lines.push({ key: 'oi-hidden', kind: 'note', tone: 'muted', cells: [t('The OI pane is hidden: these are the bars it last held.')] });
    if (sel.p0 !== null && sel.p1 !== null) lines.push({ key: 'oi-prices', kind: 'note', tone: 'muted', cells: [t('Open interest uses all prices.')] });

    lines.push({ key: 'h-oi-change', kind: 'heading', cells: [t('Change')] });
    if (s.known === 0) lines.push({ key: 'oi-known', kind: 'stat', tone: 'muted', cells: [t('Known change'), t('unavailable: no candle with a reading before it')] });
    else {
      // A percentage only of a level that is what it says: every venue whose level is in the line making every change of the stretch, and
      // as many as the line's newest bar holds (it is built back from today's total, so a venue that joined later, or one read once and never
      // again, is in the start and not in the change).
      const cohort = s.known === n && (!held.cohorts || sameMarkets(held, i0, i1));
      const rel = cohort && s.start > 0 ? ` · ${s.change >= 0 ? '+' : '−'}${(Math.abs(s.change) / s.start * 100).toFixed(2)}%` : '';
      lines.push({ key: 'oi-known', kind: 'stat', ...(tone(s.change) ? { tone: tone(s.change)! } : {}), cells: [t('Known change'), `${signedCoins(s.change, held.coin)}${rel}`] });
      lines.push({ key: 'oi-level', kind: 'stat', cells: [held.market ? t('Level') : t('Line level (chained)'), `${amount(s.start)} → ${amount(s.end)}${held.coin ? ` ${held.coin}` : ''}`] });
      if (s.usd !== null && (s.usd !== 0 || s.change !== 0)) lines.push({ key: 'oi-usd', kind: 'stat', cells: [t('In USD, at bar prices'), `≈ ${signedUsd(s.usd)}`] });
    }
    if (s.price) {
      const move = (s.price.close - s.price.open) / s.price.open, sign = move > 0 ? '+' : move < 0 ? '−' : '';
      lines.push({ key: 'oi-price', kind: 'stat', ...(tone(move) ? { tone: tone(move)! } : {}), cells: [t('Price, {market}', { market: held.priceMarket }), `${fmtPrice(s.price.open)} → ${fmtPrice(s.price.close)} · ${sign}${(Math.abs(move) * 100).toFixed(2)}%`] });
    }

    lines.push(...whoLines(s, who, kept !== null, held, n));
    lines.push(...venueLines(s, held.coin));

    // Against what is held (closed stretches only): the candles just before, the comparable windows, and how few candles made half the movement.
    const context: RangeLine[] = [];
    if (s.before !== null) context.push({ key: 'oi-before', kind: 'stat', cells: [tn(n, 'Previous {n} candle ({span})', 'Previous {n} candles ({span})', { span: durationText(s.t1 - s.t0) }), signedCoins(s.before, held.coin)] });
    if (s.rank) context.push({ key: 'oi-rank', kind: 'stat', stack: true, cells: [tn(n, 'Comparable {n}-candle windows held', 'Comparable {n}-candle windows held'), t('{k} of {m} had a larger net change (closed, overlapping, this one included)', { k: s.rank.larger.toLocaleString('en-US'), m: s.rank.of.toLocaleString('en-US') })] });
    if (s.half && n >= 3 && s.known === n) context.push({ key: 'oi-half', kind: 'stat', cells: [t('Half the movement came in'), `${t('{k} of {n} candles', { k: s.half.bars, n })}${forming ? ` ${t('so far')}` : ''}`] });
    if (context.length) lines.push({ key: 'h-oi-context', kind: 'heading', cells: [t('Against what is held')] }, ...context);

    const details: RangeLine[] = [];
    if (s.largest && n > 1) details.push({ key: 'oi-largest', kind: 'stat', cells: [t('Largest bar change'), `${clock(s.largest.t, true)} · ${signedCoins(s.largest.change, held.coin)}`] });
    if (s.fall && s.fall.amount > 0 && n > 1) details.push({ key: 'oi-fall', kind: 'stat', cells: [t('Largest sampled fall'), `${signedCoins(-s.fall.amount, held.coin)} · ${dayOf(s.t1 - 1) !== dayOf(s.t0) ? `${clock(s.fall.from, true)} → ${clock(s.fall.to, dayOf(s.fall.to - 1) !== dayOf(s.fall.from))}` : `${clock(s.fall.from)} → ${clock(s.fall.to)}`}`], ...(dayOf(s.t1 - 1) !== dayOf(s.t0) ? { stack: true } : {}) });
    if (held.flag) details.push({ key: 'oi-flagged', kind: 'stat', cells: [t('Marked by Highlights'), tn(s.flagged, '{n} bar', '{n} bars')] });
    const liq = liquidationLine(s, held, liquidations);
    if (liq) details.push(liq);
    if (details.length) lines.push({ key: 'h-oi-details', kind: 'heading', cells: [t('Details')] }, ...details);
    return lines;
  }
}

/**
 * Whether the stretch's percentage is of a level that is what it says: every bar of it, and the line's newest bar, made of the same markets
 * (not merely as many), and every market whose level is in the line making the change (a market read once and never again is in the level
 * and not in the change). The chained line is built back from the newest total, so a market that joined later would be in the start.
 */
function sameMarkets(held: OiPaneHeld, i0: number, _i1: number): boolean {
  // Every bar from the stretch's first to the line's newest: a market read only in the bars between is in the chain's steps and not in
  // its total, so its start would be off too.
  const last = held.oi.length - 1, markets = held.cohorts![last] ?? '';
  if (!markets) return false;
  for (let i = i0; i <= last; i++) if (held.cohorts![i] !== markets || (held.venues && held.counted && held.venues[i] !== held.counted[i])) return false;
  return true;
}

/** The status under the title: whose open interest and how much of it each bar holds, unknown and longer changes, the edges and the history's start. */
function statusText(s: OiStretch, held: OiPaneHeld, sel: RangeSelection): string {
  const out: string[] = [];
  const total = held.parts.length;
  if (held.market) out.push(held.market);
  else if (s.venuesLow === total && s.venuesHigh === total && s.countedLow === total && s.countedHigh === total) out.push(t('{n} venues added together', { n: total }));
  else out.push(t('Levels: {levels} of {n} venues · changes: {changes} of {n}', { levels: rangeText(s.venuesLow, s.venuesHigh), changes: rangeText(s.countedLow, s.countedHigh), n: total }));
  if (s.known < s.bars) out.push(tn(s.bars - s.known, "{n} candle's change unknown", "{n} candles' changes unknown"));
  if (s.spans > 0) out.push(t('some changes span more than one candle'));
  if (sel.t0 % held.tfMs !== 0 || sel.t1 % held.tfMs !== 0) out.push(t('the {tf} candles that start in the selection', { tf: held.tf }));
  if (held.seam !== null && held.seam > sel.t0) out.push(t("before {time} the line is Bybit's scaled estimate, not counted", { time: clock(held.seam, true) }));
  else if (held.oi[0]![0] > sel.t0) out.push(t('held from {time}', { time: clock(held.oi[0]![0], true) }));
  if (held.replayAt !== null) out.push(t('replay: candles closed by {time}', { time: clock(held.replayAt, true) }));
  return out.join(' · ');
}

/** What NL/NS estimates was added and reduced over the stretch: two bars on one scale, the four parts and their shares, and how it was read. */
function whoLines(s: OiStretch, w: OiWho | null, kept: boolean, held: OiPaneHeld, n: number): RangeLine[] {
  const head: RangeLine = { key: 'h-oi-who', kind: 'heading', cells: [held.coin ? `${t('Estimated added and reduced')} · ${held.coin}` : t('Estimated added and reduced')] };
  if (!held.who && !kept && !held.whoOn) return [head, { key: 'oi-who-off', kind: 'note', tone: 'muted', cells: [t("Set the OI pane's Bars to NL/NS for what was added and reduced.")] }];
  if (!w) return [head, { key: 'oi-who-none', kind: 'note', tone: 'muted', cells: [t('NL/NS is worked out for the candles in view: none of this stretch is in view.')] }];
  const coin = held.coin, out: RangeLine[] = [head, ...estimateStacks(w, coin, 'oi')];
  // The estimate's own net against the bars' known change over the same candles: where they part, both are said and the difference (never
  // "covers"). Over fewer candles than the stretch the comparison is of those candles, and says so.
  const model = w.added - w.reduced, partial = w.candles < n, against = partial ? w.known : s.change, quantum = Math.abs(against) >= 1_000 ? 1 : 0.01;
  if (partial) out.push({ key: 'oi-who-candles', kind: 'note', tone: 'muted', cells: [t('NL/NS for {k} of the {n} candles (worked out for those in view).', { k: w.candles, n })] });
  if (Math.abs(w.dOi - against) > Math.max(quantum, 0.01 * Math.abs(against))) {
    const words = { model: signedCoins(model, coin), change: signedCoins(against, coin), diff: signedCoins(model - against, coin) };
    out.push({ key: 'oi-who-diff', kind: 'note', tone: 'muted', cells: [partial ? t('Over those candles: estimate net {model}; known change {change}; difference {diff}.', words) : t('Estimate net {model}; known change {change}; difference {diff}.', words)] });
  }
  out.push(...estimateNotes(w, kept, held.tfMs, 'oi'));
  return out;
}

/**
 * NL/NS's estimated added and reduced as two bars on one scale (the parts end to end: buyers' in the candle-up colour, sellers' in the
 * candle-down one, closed lighter), and the four parts with their shares and what went to no side. The OI and the Delta panes' summaries
 * both say it with this (`prefix` keeps their lines' keys apart).
 */
export function estimateStacks(w: OiWho, coin: string, prefix: string): RangeLine[] {
  const scale = Math.max(w.added, w.reduced) || 1;
  const part = (x: number, tone: StackPart['tone'], tip: string, closed = false): StackPart => ({ size: x / scale, tone, tip: `${tip} ${signedCoins(closed ? -x : x, coin)}`, ...(closed ? { closed } : {}) });
  // The shorter bar runs on to the longer one's end, hatched: the difference is the estimate's net change. Without it the shorter bar read as
  // cut short (Karl, 2026-11-13: "that row scale is shorter than the row below it").
  const net = w.added - w.reduced, gap: StackPart[] = net !== 0 ? [{ size: Math.abs(net) / scale, tone: 'gap', tip: t('Estimated net change {value}: added minus reduced', { value: signedCoins(net, coin) }), text: t('net {value}', { value: signedCoins(net, '') }) }] : [];
  const out: RangeLine[] = [
    // The totals without the coin (it is in the heading), so a long ticker never overflows the total's column.
    { key: `${prefix}-added`, kind: 'stack', cells: [t('Added'), signedCoins(w.added, '')], parts: [part(w.longOpened, 'up', t('New longs')), part(w.shortOpened, 'down', t('New shorts')), part(w.unsidedUp, 'none', t('No side')), ...(net < 0 ? gap : [])] },
    { key: `${prefix}-reduced`, kind: 'stack', cells: [t('Reduced'), signedCoins(-w.reduced, '')], parts: [part(w.shortClosed, 'up', t('Shorts closed'), true), part(w.longClosed, 'down', t('Longs closed'), true), part(w.unsidedDown, 'none', t('No side'), true), ...(net > 0 ? gap : [])] },
    { key: `${prefix}-opened`, kind: 'stat', cells: [t('New longs · new shorts'), `${signedCoins(w.longOpened, coin)}${share(w.longOpened, w.added)} · ${signedCoins(w.shortOpened, coin)}${share(w.shortOpened, w.added)}`] },
    { key: `${prefix}-closed`, kind: 'stat', cells: [t('Shorts closed · longs closed'), `${signedCoins(-w.shortClosed, coin)}${share(w.shortClosed, w.reduced)} · ${signedCoins(-w.longClosed, coin)}${share(w.longClosed, w.reduced)}`] },
  ];
  out.push({ key: `${prefix}-key`, kind: 'note', tone: 'muted', cells: [t("Rising-candle colour: buyers' side (new longs, shorts closed). Falling-candle colour: sellers' side (new shorts, longs closed). Lighter: closed. Hatched: the net, added minus reduced.")] });
  if (w.unsidedUp + w.unsidedDown > 0) out.push({ key: `${prefix}-unsided`, kind: 'stat', tone: 'muted', cells: [t('No side (added · reduced)'), `${signedCoins(w.unsidedUp, coin)} · ${signedCoins(-w.unsidedDown, coin)}`] });
  return out;
}

/** How NL/NS was read for a stretch: kept from when it was in view, price direction where no flow was recorded, minute pieces, the estimate's limits. */
export function estimateNotes(w: OiWho, kept: boolean, tfMs: number, prefix: string): RangeLine[] {
  const out: RangeLine[] = [];
  if (kept) out.push({ key: `${prefix}-who-kept`, kind: 'note', tone: 'muted', cells: [t('As worked out while these candles were in view.')] });
  if (w.byPrice > 0) out.push({ key: `${prefix}-who-price`, kind: 'note', tone: 'muted', cells: [t('Price direction used in {k} of {n} candles (no flow recorded there).', { k: w.byPrice, n: w.candles })] });
  if (tfMs > 60_000 && w.fineAll < w.candles) out.push({ key: `${prefix}-who-fine`, kind: 'note', tone: 'muted', cells: [t('Minute by minute in {k} of {n} candles, the rest a candle at a time.', { k: w.fineAll, n: w.candles })] });
  out.push({ key: `${prefix}-who-note`, kind: 'note', tone: 'muted', cells: [t('Estimated from sampled OI changes and taker direction; price direction is used where stated. Opening and closing within a sampling interval can cancel.')] });
  return out;
}

/** Each venue's part of the change, out of one zero line, largest first; one with no supported candle is unavailable, not 0. */
function venueLines(s: OiStretch, coin: string): RangeLine[] {
  if (s.venues.length < 2) return [];
  const rows = [...s.venues].sort((a, b) => (b.bars > 0 ? 1 : 0) - (a.bars > 0 ? 1 : 0) || Math.abs(b.change) - Math.abs(a.change));
  const largest = Math.max(...rows.map(v => Math.abs(v.change)), 0);
  const moved = largest > 0 && Math.abs(s.change) >= 0.05 * largest;
  const out: RangeLine[] = [{ key: 'h-oi-venues', kind: 'heading', cells: [coin ? `${t('By venue')} · ${coin}` : t('By venue')] }];
  for (const v of rows) {
    if (v.bars === 0) { out.push({ key: `oi-v-${v.id}`, kind: 'signed', signed: 0, mark: v.id, tone: 'muted', cells: [venueLabel(v.id), t('unavailable')] }); continue; }
    const against = moved && v.change !== 0 && Math.sign(v.change) !== Math.sign(s.change) && Math.abs(v.change) >= 0.05 * largest;
    const partial = v.bars < s.known;
    // The notes go under the value (`cells[2]`), so every row keeps the same columns and its bar the zero line the others share.
    const notes = [against ? t('against the sum') : '', partial ? t('{k} of {n} candles', { k: v.bars, n: s.known }) : ''].filter(Boolean).join(' · ');
    out.push({ key: `oi-v-${v.id}`, kind: 'signed', signed: largest > 0 ? v.change / largest : 0, mark: v.id, ...(partial ? { tone: 'muted' as const } : {}), cells: [venueLabel(v.id), signedCoins(v.change, ''), ...(notes ? [notes] : [])] });
  }
  return out;
}

/** The liquidations reported inside the stretch on the markets counted, longs and shorts, from the smallest shown; null when they are off. */
function liquidationLine(s: OiStretch, held: OiPaneHeld, liquidations: OiLiquidations | null): RangeLine | null {
  if (!liquidations) return null;
  // Only what was read for the stretch: outside the window held, "none reported" would be about minutes nobody looked at.
  const w = liquidations.held, covered = w !== null && w.t0 <= s.t0 && (w.live || w.t1 >= s.t1);
  if (!covered) return { key: 'oi-liq', kind: 'stat', tone: 'muted', cells: [t('Liquidations reported'), t('not held for this stretch')] };
  const ids = new Set(held.ids), min = Math.max(liquidations.min, w.min);
  let longs = 0, shorts = 0;
  for (const l of liquidations.items) {
    if (l.t < s.t0 || l.t >= s.t1 || l.usd < min || !ids.has(l.id)) continue;
    if (l.side === 'long') longs += l.usd; else shorts += l.usd;
  }
  const from = `$${usd(min)}`;
  const text = longs + shorts > 0 ? t('{longs} longs · {shorts} shorts (from {min})', { longs: `$${usd(longs)}`, shorts: `$${usd(shorts)}`, min: from }) : t('none reported from {min}', { min: from });
  return { key: 'oi-liq', kind: 'stat', cells: [t('Liquidations reported'), w.cut ? `${text} · ${t('the largest only: the answer was cut')}` : text] };
}
