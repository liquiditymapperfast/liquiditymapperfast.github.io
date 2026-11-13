import type { RangeAnswer } from '../../shared/footprint.ts';
import type { AbsorptionMark } from '../absorption.ts';
import type { CellShare } from '../cell-sources.ts';
import type { Print } from '../prints.ts';
import type { Liquidation } from '../../shared/liquidations.ts';
import { familyKey, venueOfInstrument } from '../cvd/families.ts';
import { venueLabel } from '../venues.ts';
import { clock, price as fmtPrice, spanClock, usd } from '../format.ts';
import { t, tn } from '../i18n.ts';
import { MINUTE, type RangeSelection } from './selection.ts';
import type { CandleRow, OiBar } from '../store.ts';
import { TIMEFRAMES } from '../../shared/series.ts';

/**
 * What the Range panel says about a selection, worked out from what was gathered for it: every number and word here, the panel only lays the
 * lines out. All of it is about one set of instruments (the exchanges switched on, inside the Spot / Perp filter) and the selection's whole
 * minutes.
 *
 * - The price: how the chart market's price moved across the selection (open to close, high and low), from its finest candles that fit.
 * - Market orders: which markets they count and which on the map they leave out, bought and sold inside the selection, the delta and its
 *   share of the volume, the orders behind them where the recording counts them by price, the average price each side traded at, the
 *   share of all the market volume of those minutes that traded inside a box's band, the volume against the same length of time just
 *   before, and who traded it (exchange, spot or perpetual).
 * - Volume by price: every price that traded, as a profile (every market order fills resting orders on its own exchange, at the prices
 *   it trades at), and the busiest bar.
 * - Absorption marks: the marks of the map inside the selection (above the threshold the map draws them at, as the map judges them
 *   when the figures are taken): what they took, split into the two sides so it adds up, each side against the market orders it could
 *   take, by exchange with the threshold its marks were judged at, and the prices each side held at most.
 * - Resting orders (a box only): the bids and asks that rested inside the box, averaged over its time, on every order book switched on.
 */
export interface RangeInput {
  sel: RangeSelection;
  /** The recording's answer; null while it is asked for, or when it could not be had (`error`). */
  answer: RangeAnswer | null;
  error: 'older' | 'failed' | null;
  /** Absorption marks inside the selection; null when Absorption is off (none are loaded). */
  marks: readonly AbsorptionMark[] | null;
  /** Instruments whose marks may be missing from `marks` at their thresholds: an answer cut at its limit, or more than the page holds. */
  marksCut?: readonly string[];
  /** What each instrument held inside the box, averaged over its time; null for a stretch of time, or before it is known. */
  resting: readonly CellShare[] | null;
  /** The largest market orders the map holds inside the selection (the trade bubbles); null when they are off. */
  prints: readonly Print[] | null;
  /** The liquidations the map holds inside the selection, from `liquidationMin` USD; null when they are off. */
  liquidations?: readonly Liquidation[] | null;
  liquidationMin?: number;
  kind: (id: string) => 'spot' | 'perp' | null;
  /** The selection reaches outside the map's time window, for which the marks and the large orders are loaded. */
  partial?: boolean;
  /**
   * The open interest of one market (the one the OI pane shows) around the selection, a sample a minute; 'asking' while it is asked for,
   * null when that market has none, undefined when it was not asked. `coin` is the unit it is counted in, `price` what a coin is worth now (for the dollar figure).
   */
  oi?: { inst: string; bars: readonly OiBar[]; coin: string; price: number; /** The markets the OI pane adds together, when more than this one. */ of?: number } | null | 'asking';
  /**
   * The order books on the map and whether each is counted (its exchange switched on, inside the Spot / Perp filter): with the recording's
   * answer they say which markets each section counts. Undefined when not known.
   */
  books?: readonly { id: string; on: boolean }[];
  /** The OI pane is shown, with its own summary of a stretch (Show → Open interest): the open-interest section says where to find it. */
  oiPane?: boolean;
  /** The chart market's price across the selection, from its finest candles that fit (`tf`); 'asking' while asked for, null when it has none. */
  price?: { market: string; tf: string; open: number; close: number; high: number; low: number } | null | 'asking';
}

/** One bar of a volume profile: the price it starts at, buys and sells as 0..1 of the busiest bar, its total, and whether it is the busiest. */
export interface ProfileBar { label: string; buy: number; sell: number; total: string; top: boolean }

/**
 * One part of a stacked bar: its length as a share of the bar's scale (0..1), whose side it is (`up` the buyers', the candle-up colour;
 * `down` the sellers'; `none` neither; `gap` what the shorter stack of its section lacks of the longer one, their difference, drawn
 * hatched with its figure inside where it fits: `text`), whether it is closing (drawn lighter, as the OI pane draws what closed), and its
 * words for a tip.
 */
export interface StackPart { size: number; tone: 'up' | 'down' | 'none' | 'gap'; closed?: boolean; tip: string; text?: string }
/** A tile of a grid: a label, its figure, its tip, a note under it, and lines of counts (a category's kinds) in place of one figure. */
export interface GridItem { key: string; label: string; value: string; tone?: 'buy' | 'sell' | 'text' | 'muted'; tip?: string; note?: string; rows?: { label: string; value: string; tone?: 'buy' | 'sell' | 'text' }[] }

/** One line of the panel. `cells` are its texts; a split's `share` is the buy side's part, 0..1, a row's the length of its bar. */
export interface RangeLine {
  key: string;
  /**
   * `stack`: a label, a bar of parts laid end to end on a scale shared with the other stacks of its section, and its total (`cells` label,
   * total). `signed`: a label, a bar out of a zero line shared with the others of its section, right for more and left for less (`signed`,
   * -1..1 of the longest), and its value, with an optional note under it (`cells` label, value, note). `grid`: tiles two to a row (one
   * where the panel is narrow), each a label and its figure (`grid`).
   */
  kind: 'title' | 'heading' | 'stat' | 'split' | 'row' | 'note' | 'profile' | 'stack' | 'signed' | 'grid';
  cells: string[];
  /** A stack's parts. */
  parts?: StackPart[];
  /** A signed bar's length and side, -1..1; `null`: no bar (no change to draw), the zero line left out too. */
  signed?: number | null;
  /** A signed line with no bar whose value is words: they take the bar's room as well as the value's. */
  wide?: boolean;
  /** A grid's tiles. */
  grid?: GridItem[];
  share?: number;
  /** A row's bars, buys then sells, each 0..1 of the longest. */
  bars?: [number, number];
  /** A profile's bars, the highest price first. */
  profile?: ProfileBar[];
  /** The exchange whose mark goes before a row's first cell. */
  mark?: string;
  /** A stat whose value is too long to share a line with its label: the value goes under it. */
  stack?: boolean;
  tone?: 'buy' | 'sell' | 'muted';
}

const pct = (x: number): string => `${Math.round(x * 100)}%`;
const money = (x: number): string => `$${usd(x)}`;
const signed = (x: number): string => `${x > 0 ? '+' : x < 0 ? '−' : ''}$${usd(Math.abs(x))}`;
/** A multiple to one decimal ("×1.8"), or a fraction as a multiple too ("×0.4"). */
const times = (x: number): string => `×${x >= 10 ? Math.round(x) : x.toFixed(1)}`;
const durationText = (ms: number): string => {
  const minutes = Math.round(ms / MINUTE);
  if (minutes < 120) return tn(minutes, '{n} min', '{n} min');
  const hours = minutes / 60;
  return hours < 48 ? t('{n} h', { n: Number.isInteger(hours) ? hours : hours.toFixed(1) }) : t('{n} days', { n: (hours / 24).toFixed(1) });
};

/** The selection in words: its minutes (and live), and its prices or "every price". */
export function selectionLines(sel: RangeSelection): RangeLine[] {
  const span = `${spanClock(sel.t0, sel.t1)} · ${durationText(sel.t1 - sel.t0)}${sel.live ? ` · ${t('live')}` : ''}`;
  const prices = sel.p0 !== null && sel.p1 !== null
    ? `${fmtPrice(sel.p0)} – ${fmtPrice(sel.p1)} (${((sel.p1 - sel.p0) / sel.p0 * 100).toFixed(2)}%)`
    : t('Every price');
  return [{ key: 'when', kind: 'title', cells: [span] }, { key: 'prices', kind: 'note', cells: [prices], tone: 'muted' }];
}

/** How the chart market's price moved across the selection: open to close, and its high and low. */
function priceLines(price: RangeInput['price']): RangeLine[] {
  if (!price) return [];
  if (price === 'asking') return [{ key: 'price-move', kind: 'stat', tone: 'muted', cells: [t('Open → close'), t('Adding up…')] }];
  const change = price.open > 0 ? (price.close - price.open) / price.open : 0, sign = change > 0 ? '+' : change < 0 ? '−' : '';
  const tone = change > 0 ? 'buy' : change < 0 ? 'sell' : null;
  return [
    { key: 'price-move', kind: 'stat', ...(tone ? { tone } : {}), cells: [t('Open → close'), `${fmtPrice(price.open)} → ${fmtPrice(price.close)} · ${sign}${(Math.abs(change) * 100).toFixed(2)}%`] },
    { key: 'price-range', kind: 'stat', cells: [t('High · low'), `${fmtPrice(price.high)} · ${fmtPrice(price.low)} · ${(price.low > 0 ? (price.high - price.low) / price.low * 100 : 0).toFixed(2)}%`] },
    { key: 'price-of', kind: 'note', tone: 'muted', cells: [t('The price of {market}, from its {tf} candles.', { market: price.market, tf: price.tf })] },
  ];
}

/** The candles the price line can be read from, finest first, and the most one question asks for. */
const PRICE_TIMEFRAMES: readonly (readonly [string, number])[] = [['1m', 60_000], ['5m', 300_000], ['15m', 900_000], ['30m', 1_800_000], ['1h', 3_600_000]];
const MAX_PRICE_BARS = 400;

/** One candle question of the price line: candles of `tf` (`ms` long) that start in [from, to). */
export interface PricePiece { tf: string; ms: number; from: number; to: number }

/**
 * The candle questions that cover the minutes [t0, t1) exactly: one of minutes when they fit, else the finest timeframe that fits for the
 * candles wholly inside, and minutes for the part before the first of them and after the last (a coarser candle there would hold prices
 * from outside the selection). Null when even hours do not fit (longer than a recording is kept).
 */
export function pricePieces(t0: number, t1: number): PricePiece[] | null {
  const found = PRICE_TIMEFRAMES.find(([, ms]) => (t1 - t0) / ms <= MAX_PRICE_BARS);
  if (!found) return null;
  const [tf, ms] = found;
  if (ms === MINUTE) return [{ tf, ms, from: t0, to: t1 }];
  const from = Math.ceil(t0 / ms) * ms, to = Math.floor(t1 / ms) * ms, out: PricePiece[] = [];
  if (t0 < from) out.push({ tf: '1m', ms: MINUTE, from: t0, to: from });
  if (from < to) out.push({ tf, ms, from, to });
  if (Math.max(from, to) < t1) out.push({ tf: '1m', ms: MINUTE, from: Math.max(from, to), to: t1 });
  return out;
}

/**
 * Open, close, high and low over the candles of each piece that start inside it, in time order, or null when there are none. Rows are
 * [start, open, high, low, close, …]; `tf` is the coarsest piece's. `until` (a replay's moment): a candle that ends after it is left out,
 * since it holds prices the replay has not reached.
 */
export function priceOf(pieces: readonly PricePiece[], answers: readonly (readonly CandleRow[])[], market: string, until = Infinity): RangeInput['price'] {
  const inside = pieces.flatMap((piece, i) => (answers[i] ?? []).filter(r => r[0] >= piece.from && r[0] < piece.to && r[0] + piece.ms <= until && r[1] > 0 && r[4] > 0)).sort((a, b) => a[0] - b[0]);
  if (!inside.length) return null;
  const tf = pieces.find(piece => piece.tf !== '1m')?.tf ?? '1m';
  return { market, tf, open: inside[0]![1], close: inside[inside.length - 1]![4], high: Math.max(...inside.map(r => r[2])), low: Math.min(...inside.map(r => r[3])) };
}

/** A market as the coverage line names it: its exchange, and "spot" when the exchange has a perpetual on the map too. */
type MarketKey = { family: string; kind: 'spot' | 'perp' };
const marketOf = (id: string, kind: RangeInput['kind']): MarketKey => ({ family: familyKey(venueOfInstrument(id)), kind: kind(id) === 'spot' ? 'spot' : 'perp' });

/**
 * Which markets the market orders count, and which on the map they leave out: those whose order books are on the map but whose trades are
 * not recorded (so they are in the resting orders and nowhere else), and those switched off or outside the Spot / Perp filter.
 */
function coverageLine(input: RangeInput, answer: RangeAnswer): RangeLine | null {
  const counted = new Set<string>(), key = (m: MarketKey): string => `${m.family}|${m.kind}`;
  let n = 0;
  for (const i of answer.instruments) if (i.minutes > 0) { const k = key(marketOf(i.id, input.kind)); if (!counted.has(k)) { counted.add(k); n++; } }
  const books = input.books ?? [], perps = new Set(books.map(b => marketOf(b.id, input.kind)).filter(m => m.kind === 'perp').map(m => m.family));
  const name = (m: MarketKey): string => m.kind === 'spot' && perps.has(m.family) ? t('{venue} spot', { venue: venueLabel(m.family) }) : venueLabel(m.family);
  const named = (on: boolean, test: (m: MarketKey) => boolean): string[] => {
    const seen = new Map<string, string>();
    for (const b of books) { const m = marketOf(b.id, input.kind); if (b.on === on && test(m)) seen.set(key(m), name(m)); }
    return [...seen.values()].sort((a, b) => a.localeCompare(b));
  };
  const bookOnly = named(true, m => !counted.has(key(m))), off = named(false, m => !counted.has(key(m)));
  if (!n && !bookOnly.length && !off.length) return null;
  const parts = [tn(n, 'Counts {n} market.', 'Counts {n} markets.')];
  if (bookOnly.length) parts.push(t('No trades are recorded for {list}: their books are on the map, not in these figures.', { list: bookOnly.join(', ') }));
  if (off.length) parts.push(t('Switched off or outside the Spot / Perp filter: {list}.', { list: off.join(', ') }));
  return { key: 'market-coverage', kind: 'note', tone: 'muted', cells: [parts.join(' ')] };
}

/** Sums of the answer over its instruments. */
function totals(answer: RangeAnswer) {
  const s = { buy: 0, sell: 0, buyN: 0, sellN: 0, countedBuy: 0, countedSell: 0, allBuy: 0, allSell: 0, beforeBuy: 0, beforeSell: 0, minutes: 0, counted: 0, beforeMinutes: 0, countedFrom: null as number | null };
  for (const i of answer.instruments) {
    s.buy += i.band.buy; s.sell += i.band.sell; s.buyN += i.band.buyN; s.sellN += i.band.sellN;
    s.countedBuy += i.countedUsd.buy; s.countedSell += i.countedUsd.sell;
    s.allBuy += i.all.buy; s.allSell += i.all.sell; s.beforeBuy += i.before.buy; s.beforeSell += i.before.sell;
    s.beforeMinutes = Math.max(s.beforeMinutes, i.before.minutes);
    if (i.countedFrom !== null && (s.countedFrom === null || i.countedFrom < s.countedFrom)) s.countedFrom = i.countedFrom;
  }
  // The selection's coverage is that of the instrument that recorded the most of it (a quiet one has minutes without trades, not gaps),
  // and its counted minutes are that instrument's (the most of them, when several recorded as many).
  for (const i of answer.instruments) s.minutes = Math.max(s.minutes, i.minutes);
  for (const i of answer.instruments) if (i.minutes === s.minutes) s.counted = Math.max(s.counted, i.counted);
  return s;
}

/** Every line the panel shows for `input`, in order. */
/** How old the last sample before a selection may be to stand for its start (the open interest is sampled once a minute). */
const OI_STALE_MS = 10 * MINUTE;

/**
 * The open interest at the start of [t0, t1) (the last sample before it, at most `OI_STALE_MS` old, else the first inside), at its end (the
 * last sample inside) and the most and least inside. Bars are [start, open, high, low, close]; null when the start or the end is not held.
 */
export function oiChange(bars: readonly OiBar[], t0: number, t1: number): { start: number; end: number; low: number; high: number } | null {
  let start: number | null = null, end: number | null = null, low = Infinity, high = -Infinity;
  for (const [t, open, hi, lo, close] of bars) {
    if (t < t0) { if (t >= t0 - OI_STALE_MS) start = close; continue; }
    if (t >= t1) break;
    if (start === null) start = open;
    end = close; low = Math.min(low, lo); high = Math.max(high, hi);
  }
  return start !== null && end !== null ? { start, end, low: Math.min(low, start), high: Math.max(high, start) } : null;
}

/**
 * The open interest across the selection: one market's (the OI pane's), so other exchanges are not in it; for the whole market, never a
 * box's prices (it has none). Its change says whether positions were opened or closed in these minutes, not by whom.
 */
function oiLines(input: RangeInput, box: boolean): RangeLine[] {
  if (input.oi === 'asking') return [{ key: 'h-oi', kind: 'heading', cells: [t('Open interest')] }, { key: 'oi-wait', kind: 'note', tone: 'muted', cells: [t('Adding up…')] }];
  if (!input.oi) return [];
  const { inst, bars, coin, price } = input.oi, sel = input.sel, change = oiChange(bars, sel.t0, sel.t1), name = `${venueLabel(inst)} ${inst.split(':').slice(1).join(':')}`;
  const out: RangeLine[] = [{ key: 'h-oi', kind: 'heading', cells: [t('Open interest')] }];
  if (!change) return [...out, { key: 'oi-none', kind: 'note', tone: 'muted', cells: [t('No open interest of {market} is held for these minutes.', { market: name })] }];
  const amount = (x: number): string => `${x.toLocaleString('en-US', { maximumFractionDigits: x >= 1_000 ? 0 : 2 })} ${coin}`;
  const d = change.end - change.start, rel = change.start > 0 ? d / change.start : 0;
  const sign = d > 0 ? '+' : d < 0 ? '−' : '';
  out.push({ key: 'oi-market', kind: 'stat', cells: [t('Market'), name], mark: inst });
  out.push({ key: 'oi-ends', kind: 'stat', cells: [t('At the start and the end'), `${amount(change.start)} → ${amount(change.end)}`] });
  out.push({ key: 'oi-change', kind: 'stat', cells: [t('Change'), `${sign}${amount(Math.abs(d))} · ${sign}${(Math.abs(rel) * 100).toFixed(2)}%${price > 0 ? ` · ${signed(d * price)}` : ''}`] });
  if (change.high > Math.max(change.start, change.end) || change.low < Math.min(change.start, change.end)) out.push({ key: 'oi-range', kind: 'stat', tone: 'muted', cells: [t('Lowest and highest'), `${amount(change.low)} / ${amount(change.high)}`] });
  const of = input.oi.of ?? 1;
  if (input.oiPane) out.push({ key: 'oi-pointer', kind: 'note', tone: 'muted', cells: [t("All the OI pane's venues, and who added and who reduced: Show → Open interest.")] });
  out.push({ key: 'oi-note', kind: 'note', tone: 'muted', cells: [of > 1
    ? (box ? t('One market, the largest of the {n} the OI pane adds together, and all of it, not only the box\'s prices. Rising: positions opened; falling: closed. Not who opened or closed them.', { n: of }) : t('One market, the largest of the {n} the OI pane adds together. Rising: positions opened; falling: closed. Not who opened or closed them.', { n: of }))
    : (box ? t('One market, the one the OI pane shows, and all of it, not only the box\'s prices. Rising: positions opened; falling: closed. Not who opened or closed them.') : t('One market, the one the OI pane shows. Rising: positions opened; falling: closed. Not who opened or closed them.'))] });
  return out;
}

export function rangeLines(input: RangeInput): RangeLine[] {
  const { sel, answer } = input, box = sel.p0 !== null && sel.p1 !== null, lines: RangeLine[] = [...selectionLines(sel), ...priceLines(input.price)];
  const windowMinutes = Math.round((sel.t1 - sel.t0) / MINUTE);

  lines.push({ key: 'h-market', kind: 'heading', cells: [t('Market orders')] });
  const coverage = answer ? coverageLine(input, answer) : null;
  if (coverage) lines.push(coverage);
  if (!answer) {
    lines.push({ key: 'market-wait', kind: 'note', tone: 'muted', cells: [input.error === 'older' ? t('The server is older than this page: restart it (npm run dev) for the market orders of a selection.')
      : input.error === 'failed' ? t('The recording could not be read for this selection.') : t('Adding up…')] });
  } else {
    const s = totals(answer), total = s.buy + s.sell;
    if (s.minutes < windowMinutes * 0.9) lines.push({ key: 'coverage', kind: 'note', tone: 'muted', cells: [t('Recorded for {n} of its {total} minutes.', { n: s.minutes, total: windowMinutes })] });
    if (!(total > 0)) lines.push({ key: 'market-none', kind: 'note', tone: 'muted', cells: [box ? t('No market orders traded inside this box.') : t('No market orders in these minutes.')] });
    else {
      lines.push({ key: 'split', kind: 'split', share: s.buy / total, cells: [t('Bought {value}', { value: money(s.buy) }), t('Sold {value}', { value: money(s.sell) })] });
      const d = s.buy - s.sell, dShare = `${d > 0 ? '+' : d < 0 ? '−' : ''}${pct(Math.abs(d) / total)}`;
      lines.push({ key: 'delta', kind: 'stat', cells: [t('Delta'), t('{value} · {share} of the volume', { value: signed(d), share: dShare })], tone: s.buy >= s.sell ? 'buy' : 'sell' });
      const orders = orderLine(s, windowMinutes);
      if (orders) lines.push(...orders);
      const paid = averagePrices(answer);
      if (paid) lines.push({ key: 'avg-price', kind: 'stat', cells: [t('Average price'), t('bought at {buy} · sold at {sell}', { buy: paid.buy, sell: paid.sell })] });
      if (box && s.allBuy + s.allSell > 0) lines.push({ key: 'band', kind: 'stat', cells: [t('Inside the band'), t('{share} of all market volume in these minutes', { share: pct(total / (s.allBuy + s.allSell)) })] });
      const all = s.allBuy + s.allSell, before = s.beforeBuy + s.beforeSell;
      if (before > 0 && s.beforeMinutes >= windowMinutes * 0.9 && s.minutes >= windowMinutes * 0.9) {
        lines.push({ key: 'before', kind: 'stat', cells: [t('Against the {span} before', { span: durationText(sel.t1 - sel.t0) }), t('{ratio} the volume', { ratio: times(all / before) })] });
      }
      const largest = largestPrint(input.prints, sel);
      if (largest) lines.push({ key: 'largest', kind: 'stat', tone: largest.side, cells: [t('Largest order'), `${money(largest.usd)} ${largest.side === 'buy' ? t('buy') : t('sell')} · ${fmtPrice(largest.price)} · ${venueLabel(largest.id)} · ${clock(largest.t)}`] });
      const forced = liquidationLine(input, s.allBuy + s.allSell > 0 ? s.allBuy + s.allSell : total);
      if (forced) lines.push(forced);
      lines.push(...whoLines(answer, input.kind, total));
      lines.push(...profileLines(answer, total));
    }
  }
  lines.push(...oiLines(input, box));
  lines.push(...absorptionLines(input, answer ? totals(answer) : null));
  if (box) lines.push(...restingLines(input.resting, input.books));
  return lines;
}

/** Orders behind the volume, where the recording counts them: the counts, the average order, and since when they are counted. */
function orderLine(s: ReturnType<typeof totals>, windowMinutes: number): RangeLine[] {
  if (s.counted === 0) return [{ key: 'orders-none', kind: 'note', tone: 'muted', cells: [t('Orders are counted by price in minutes recorded from now on; these minutes have no counts.')] }];
  const out: RangeLine[] = [];
  const avg = (usdSum: number, n: number): string => n > 0 ? money(usdSum / n) : '–';
  out.push({ key: 'orders', kind: 'stat', cells: [t('Orders'), t('{buys} buys · {sells} sells', { buys: s.buyN.toLocaleString('en-US'), sells: s.sellN.toLocaleString('en-US') })] });
  out.push({ key: 'average', kind: 'stat', cells: [t('Average order'), t('{buy} buy · {sell} sell', { buy: avg(s.countedBuy, s.buyN), sell: avg(s.countedSell, s.sellN) })] });
  if (s.counted < windowMinutes && s.countedFrom !== null) out.push({ key: 'orders-from', kind: 'note', tone: 'muted', cells: [t('Orders are counted from {time} on ({n} of {total} minutes).', { time: clock(s.countedFrom), n: s.counted, total: windowMinutes })] });
  return out;
}

/**
 * The liquidations inside the selection, of the market orders above (a forced close is a market order, so it is part of that volume, not
 * added to it): longs closed and shorts closed, from the smallest the Liquidations panel shows, and their share of all the market volume in
 * those minutes. Not of a box's band: a liquidation is drawn at one price and its whole size traded wherever the book took it, so against the
 * band alone it could pass 100 %. A share that would still pass it (the recording holds fewer of the minutes than the liquidations) is not said.
 */
function liquidationLine(input: RangeInput, all: number): RangeLine | null {
  const rows = input.liquidations; if (!rows) return null;
  const sel = input.sel, min = input.liquidationMin ?? 0, from = money(min);
  let longs = 0, shorts = 0, forced = 0;
  // One forced fill can close a long and a short at once (Deribit's MT): it is in both totals, but traded once.
  const fills = new Set<string>();
  for (const l of rows) {
    if (l.t < sel.t0 || l.t >= sel.t1 || l.usd < min) continue;
    if (sel.p0 !== null && sel.p1 !== null && (l.price < sel.p0 || l.price >= sel.p1)) continue;
    if (l.side === 'long') longs += l.usd; else shorts += l.usd;
    const fill = `${l.id}|${l.t}|${l.reported}|${Math.round(l.usd * 100)}`;
    if (!fills.has(fill)) { fills.add(fill); forced += l.usd; }
  }
  if (!(longs + shorts > 0)) return { key: 'liquidations', kind: 'stat', tone: 'muted', cells: [t('Liquidations'), t('none reported from {min}', { min: from })] };
  const share = forced / all, tone = longs >= shorts ? 'sell' : 'buy';
  const text = share > 0 && share <= 1 ? t('{longs} longs · {shorts} shorts · {share} of all market volume in these minutes (from {min})', { longs: money(longs), shorts: money(shorts), share: pct(share), min: from })
    : t('{longs} longs · {shorts} shorts (from {min})', { longs: money(longs), shorts: money(shorts), min: from });
  return { key: 'liquidations', kind: 'stat', tone, cells: [t('Liquidations'), text] };
}

/** The largest market order the map holds inside the selection. */
function largestPrint(prints: readonly Print[] | null, sel: RangeSelection): Print | null {
  if (!prints) return null;
  let best: Print | null = null;
  for (const p of prints) {
    if (p.t < sel.t0 || p.t >= sel.t1) continue;
    if (sel.p0 !== null && sel.p1 !== null && (p.price < sel.p0 || p.price >= sel.p1)) continue;
    if (!best || p.usd > best.usd) best = p;
  }
  return best;
}

/** Who traded it: each exchange's buys, sells and share (the six largest, the rest together), and spot against perpetual. */
function whoLines(answer: RangeAnswer, kind: RangeInput['kind'], total: number): RangeLine[] {
  const families = new Map<string, { buy: number; sell: number }>(), lanes = { spot: 0, perp: 0 };
  for (const i of answer.instruments) {
    const v = i.band.buy + i.band.sell; if (!(v > 0)) continue;
    const key = familyKey(venueOfInstrument(i.id)), f = families.get(key) ?? { buy: 0, sell: 0 };
    f.buy += i.band.buy; f.sell += i.band.sell; families.set(key, f);
    const k = kind(i.id); if (k) lanes[k] += v;
  }
  const sorted = [...families].sort((a, b) => (b[1].buy + b[1].sell) - (a[1].buy + a[1].sell));
  const out: RangeLine[] = [{ key: 'h-who', kind: 'heading', cells: [t('By exchange')] }];
  const largest = sorted.length ? sorted[0]![1].buy + sorted[0]![1].sell : 1;
  const row = (key: string, name: string, f: { buy: number; sell: number }, mark?: string): RangeLine => ({ key: `who-${key}`, kind: 'row', cells: [name, money(f.buy), money(f.sell), pct((f.buy + f.sell) / total)], bars: [f.buy / largest, f.sell / largest], ...(mark ? { mark } : {}) });
  out.push({ key: 'who-head', kind: 'row', tone: 'muted', cells: [t('Exchange'), t('Bought'), t('Sold'), t('Share')] });
  for (const [key, f] of sorted.slice(0, 6)) out.push(row(key, venueLabel(key), f, key));
  const rest = sorted.slice(6);
  if (rest.length) out.push(row('rest', tn(rest.length, '{n} other', '{n} others'), rest.reduce((a, [, f]) => ({ buy: a.buy + f.buy, sell: a.sell + f.sell }), { buy: 0, sell: 0 })));
  if (lanes.spot + lanes.perp > 0) out.push({ key: 'lanes', kind: 'stat', cells: [t('Spot · perpetual'), `${pct(lanes.spot / (lanes.spot + lanes.perp))} · ${pct(lanes.perp / (lanes.spot + lanes.perp))}`] });
  return out;
}

/**
 * The average price the market buys paid and the market sells got: the dollars over the coins, each row's coins being its dollars at the
 * row's middle price, so to within half a row of the answer's step. Null when neither side traded.
 */
function averagePrices(answer: RangeAnswer): { buy: string; sell: string } | null {
  let bought = 0, buyCoins = 0, sold = 0, sellCoins = 0;
  const half = answer.step / 2;
  for (const [low, buy, sell] of answer.rows) {
    const mid = low + half; if (!(mid > 0)) continue;
    bought += buy; buyCoins += buy / mid; sold += sell; sellCoins += sell / mid;
  }
  if (!(bought + sold > 0)) return null;
  return { buy: buyCoins > 0 ? fmtPrice(bought / buyCoins) : '–', sell: sellCoins > 0 ? fmtPrice(sold / sellCoins) : '–' };
}

/** The most bars a profile is drawn with: a box's rows are joined into bars of whole rows until they fit. */
export const PROFILE_BARS = 24;

/**
 * The volume profile of the selection: every price that traded, from the lowest to the highest, in at most PROFILE_BARS bars of whole rows
 * (a price nothing traded at is an empty bar, so a gap shows), buys and sells in each, and the busiest bar named with its share and the
 * orders that began there.
 */
function profileLines(answer: RangeAnswer, total: number): RangeLine[] {
  const rows = answer.rows.filter(r => r[1] + r[2] > 0);
  if (!rows.length) return [];
  const step = answer.step, low = Math.min(...rows.map(r => r[0])), high = Math.max(...rows.map(r => r[0]));
  const span = Math.round((high - low) / step) + 1, per = Math.max(1, Math.ceil(span / PROFILE_BARS)), n = Math.ceil(span / per);
  const bars = Array.from({ length: n }, (_, k) => ({ from: low + k * per * step, buy: 0, sell: 0, orders: 0 }));
  for (const [price, buy, sell, buyN, sellN] of rows) {
    const bar = bars[Math.min(n - 1, Math.floor(Math.round((price - low) / step) / per))]!;
    bar.buy += buy; bar.sell += sell; bar.orders += buyN + sellN;
  }
  const most = Math.max(...bars.map(b => b.buy + b.sell)), top = bars.find(b => b.buy + b.sell === most)!, width = per * step;
  const label = (from: number): string => fmtPrice(from, step);
  const counted = answer.instruments.some(i => i.counted > 0);
  const out: RangeLine[] = [{ key: 'h-profile', kind: 'heading', cells: [t('Volume by price')] }];
  out.push({ key: 'profile', kind: 'profile', cells: [], profile: [...bars].reverse().map(b => ({ label: label(b.from), buy: b.buy / most, sell: b.sell / most, total: b.buy + b.sell > 0 ? money(b.buy + b.sell) : '', top: b === top })) });
  const where = per > 1 ? `${label(top.from)} – ${label(top.from + width)}` : label(top.from);
  out.push({ key: 'profile-top', kind: 'stat', cells: [t('Most traded'), `${where} · ${money(most)} · ${pct(most / total)}${counted && top.orders > 0 ? ` · ${tn(top.orders, '{n} order', '{n} orders', { n: top.orders.toLocaleString('en-US') })}` : ''}`] });
  out.push({ key: 'profile-note', kind: 'note', tone: 'muted', cells: [t('What the market orders traded at each price, buys in the bid colour and sells in the ask colour, in bars of {step}.', { step: fmtPrice(width, step) })] });
  return out;
}

/** The absorption marks inside the selection: what the passive side took, against what traded there, by exchange and by price. */
function absorptionLines(input: RangeInput, s: ReturnType<typeof totals> | null): RangeLine[] {
  const out: RangeLine[] = [{ key: 'h-absorption', kind: 'heading', cells: [t('Absorption marks')] }];
  if (input.marks === null) { out.push({ key: 'abs-off', kind: 'note', tone: 'muted', cells: [t('Absorption is off: switch it on to count its marks here.')] }); return out; }
  const marks = input.marks;
  if (input.partial) out.push({ key: 'abs-partial', kind: 'note', tone: 'muted', cells: [t('The map shows only part of this selection: its absorption marks and its largest order are counted for that part alone.')] });
  if (input.marksCut?.length) out.push({ key: 'abs-cut', kind: 'note', tone: 'muted', cells: [t('Only the largest marks of {venues} are held for these minutes, so their smaller ones are not counted.', { venues: [...new Set(input.marksCut.map(id => venueLabel(id)))].join(', ') })] });
  if (!marks.length) { out.push({ key: 'abs-none', kind: 'note', tone: 'muted', cells: [t('No absorption marks in this selection.')] }); return out; }
  // A mark's side is the side of the market orders: passive buyers took market sells, passive sellers took market buys. A price is added up
  // per side: passive buyers and passive sellers can both have taken orders at one price, and one figure would give the other side's to one.
  const took = { sell: 0, buy: 0 }, byPrice = new Map<string, { price: number; usd: number; side: 'buy' | 'sell' }>();
  const byVenue = new Map<string, { sell: number; buy: number; thresholds: number[] }>();
  for (const m of marks) {
    took[m.side] += m.usd;
    const key = familyKey(venueOfInstrument(m.id)), v = byVenue.get(key) ?? { sell: 0, buy: 0, thresholds: [] };
    v[m.side] += m.usd; v.thresholds.push(m.threshold); byVenue.set(key, v);
    const where = `${m.price}|${m.side}`, at = byPrice.get(where);
    if (at) at.usd += m.usd; else byPrice.set(where, { price: m.price, usd: m.usd, side: m.side });
  }
  // What was absorbed, split into the two sides so they add up to all of it.
  const absorbed = took.sell + took.buy;
  out.push({ key: 'abs-total', kind: 'stat', cells: [t('Absorbed'), `${money(absorbed)} · ${tn(marks.length, '{n} mark', '{n} marks', { n: marks.length.toLocaleString('en-US') })}`] });
  if (absorbed > 0) {
    // One share rounded and the other its complement, so the two always say 100 %.
    const buyers = Math.round(took.sell / absorbed * 100);
    out.push({ key: 'abs-split', kind: 'split', share: took.sell / absorbed, cells: [t('Passive buyers {value} · {share}', { value: money(took.sell), share: `${buyers}%` }), t('Passive sellers {value} · {share}', { value: money(took.buy), share: `${100 - buyers}%` })] });
  }
  // Each side against all the market orders it could have taken: passive buyers take sells, passive sellers take buys.
  if (s && (s.sell > 0 || s.buy > 0)) {
    const of = (part: number, all: number): string => all > 0 ? pct(Math.min(1, part / all)) : '–';
    out.push({ key: 'abs-of', kind: 'stat', stack: true, cells: [t('Of all market orders'), t('{sells} of the {sold} sold · {buys} of the {bought} bought', { sells: of(took.sell, s.sell), sold: money(s.sell), buys: of(took.buy, s.buy), bought: money(s.buy) })] });
  }
  // By exchange, with the threshold its marks were judged at: a lower threshold marks more of an exchange's volume. Auto moves a threshold
  // with the market, and an exchange's spot and perpetual have their own, so it is the middle one of its marks, "≈" when they differ.
  const venues = [...byVenue].sort((a, b) => (b[1].sell + b[1].buy) - (a[1].sell + a[1].buy)), most = Math.max(...venues.map(([, v]) => Math.max(v.sell, v.buy)));
  const threshold = ({ thresholds }: { thresholds: number[] }): string => {
    const sorted = thresholds.filter(Number.isFinite).sort((a, b) => a - b);
    if (!sorted.length) return '';
    const middle = sorted[Math.floor(sorted.length / 2)]!;
    return sorted[sorted.length - 1]! > sorted[0]! * 1.1 ? `≈${money(middle)}` : money(middle);
  };
  out.push({ key: 'abs-head', kind: 'row', tone: 'muted', cells: [t('Exchange'), t('Buyers took'), t('Sellers took'), t('Threshold')] });
  for (const [key, v] of venues.slice(0, 6)) out.push({ key: `abs-v-${key}`, kind: 'row', mark: key, cells: [venueLabel(key), money(v.sell), money(v.buy), threshold(v)], bars: [v.sell / most, v.buy / most] });
  const rest = venues.slice(6);
  if (rest.length) {
    const sum = rest.reduce((a, [, v]) => ({ sell: a.sell + v.sell, buy: a.buy + v.buy }), { sell: 0, buy: 0 });
    out.push({ key: 'abs-v-rest', kind: 'row', cells: [tn(rest.length, '{n} other', '{n} others'), money(sum.sell), money(sum.buy), ''], bars: [sum.sell / most, sum.buy / most] });
  }
  // The prices each side held at most.
  // A whole price without its ".0", so three of them fit on the line.
  const at = (price: number): string => Number.isInteger(price) ? fmtPrice(price, 1) : fmtPrice(price);
  const prices = (side: 'buy' | 'sell'): string => [...byPrice.values()].filter(p => p.side === side).sort((a, b) => b.usd - a.usd).slice(0, 3).map(p => `${at(p.price)} ${money(p.usd)}`).join(' · ');
  if (took.sell > 0) out.push({ key: 'abs-at-buyers', kind: 'stat', stack: true, tone: 'buy', cells: [t('Passive buyers held at'), prices('sell')] });
  if (took.buy > 0) out.push({ key: 'abs-at-sellers', kind: 'stat', stack: true, tone: 'sell', cells: [t('Passive sellers held at'), prices('buy')] });
  out.push({ key: 'abs-note', kind: 'note', tone: 'muted', cells: [t('A mark is market orders of one side meeting resting orders at one price within 10 ms, more than the exchange\'s threshold: only the marks the map draws count. Passive buyers take market sells, passive sellers take market buys.')] });
  return out;
}

/** The resting orders inside a box: bids and asks averaged over its time, and the exchanges that held the most. */
function restingLines(resting: readonly CellShare[] | null, books: RangeInput['books']): RangeLine[] {
  const out: RangeLine[] = [{ key: 'h-resting', kind: 'heading', cells: [t('Resting orders in the box')] }];
  if (!resting) { out.push({ key: 'rest-wait', kind: 'note', tone: 'muted', cells: [t('Adding up…')] }); return out; }
  let bid = 0, ask = 0; const byVenue = new Map<string, number>();
  for (const c of resting) { bid += c.bid; ask += c.ask; const key = familyKey(venueOfInstrument(c.id)); byVenue.set(key, (byVenue.get(key) ?? 0) + c.bid + c.ask); }
  if (!(bid + ask > 0)) { out.push({ key: 'rest-none', kind: 'note', tone: 'muted', cells: [t('No resting orders were recorded inside this box.')] }); return out; }
  out.push({ key: 'rest-split', kind: 'split', share: bid / (bid + ask), cells: [t('Bids {value}', { value: money(bid) }), t('Asks {value}', { value: money(ask) })] });
  const total = bid + ask, venues = [...byVenue].sort((a, b) => b[1] - a[1]).slice(0, 4).map(([key, v]) => `${venueLabel(key)} ${pct(v / total)}`).join(' · ');
  out.push({ key: 'rest-venues', kind: 'stat', cells: [t('Held by'), venues] });
  const on = books?.filter(b => b.on).length ?? 0;
  out.push({ key: 'rest-note', kind: 'note', tone: 'muted', cells: [on > 0 ? tn(on, 'What rested inside the box on average over its time, on the {n} order book switched on (those without recorded trades too).', 'What rested inside the box on average over its time, on the {n} order books switched on (those without recorded trades too).')
    : t('What rested inside the box on average over its time, on the exchanges switched on.')] });
  return out;
}

/** The size of a selection while it is dragged, for the tag beside it: its minutes, and a box's height as a share of its price. */
export function draftLabel(sel: RangeSelection): string {
  // A drag in a pane that holds whole bars: how many, and of what.
  if (sel.step && sel.step > MINUTE) {
    const n = Math.max(1, Math.round((sel.t1 - sel.t0) / sel.step)), tf = Object.entries(TIMEFRAMES).find(([, ms]) => ms === sel.step)?.[0] ?? '';
    return tn(n, '{n} candle of {tf}', '{n} candles of {tf}', { tf });
  }
  const span = durationText(Math.max(MINUTE, sel.t1 - sel.t0));
  return sel.p0 !== null && sel.p1 !== null && sel.p0 > 0 ? `${span} · ${((sel.p1 - sel.p0) / sel.p0 * 100).toFixed(2)}%` : span;
}
