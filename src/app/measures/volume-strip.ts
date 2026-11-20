import type { Palette } from '../theme.ts';
import type { InfoLine } from '../infobox.ts';
import type { CandleRow } from '../store.ts';
import { t } from '../i18n.ts';
import { usd } from '../format.ts';
import { VOLUME_WORDS } from '../traded.ts';
import { anomalies } from '../anomaly.ts';
import { emphasisFloor, medianRow, splitStyles } from '../traded/emphasis.ts';
import { bucketAt, bucketSpan, gapText, timeText, type TimeGap, type TimeRows } from './model.ts';
import { timeWords } from './registry.ts';
import { orderLines, type StripOrders } from './strip-orders.ts';
import { TIMEFRAMES } from '../../shared/series.ts';

/**
 * The volume strip along the bottom of the map as a profile by time (Karl, 2026-10-20: "I want the bottom to be a profile as well for
 * volume ... and only show the normal volume candles for data that is loaded from the exchange"). One bar a candle, on the candles' own
 * boundaries: where the recording reaches, what all the venues on the map traded, split by side with the profiles' emphasis; before it,
 * the chart market's own candle, its volume in dollars at its typical price, split by its taker buys where the exchange says them, an
 * estimate drawn as the candle-based profiles are (outlined in the profile colour, named ≈ with its market) and grey where it does not say
 * who bought. One scale for both, so a market's bar beside the venues' is honestly smaller; one source a bar, never added across the seam.
 * That "profile" was a misreading (Karl, 2026-10-21: the same design with more data, "not necessarily doing the profile box"): no value
 * area or point of control is drawn or named; the box says each candle's volume, sides and delta with their shares, its market orders
 * (counts and average sizes, whale share, largest venues: `strip-orders.ts`), and a Binance candle's quote volume and trades.
 */

/** One bar: its candle's start, where it is drawn, and what it holds (dollars; from a candle without taker buys, all of it in `buy`). */
export interface StripBar {
  t: number; x: number; w: number;
  /** `recorded`: the venues' trades; `partial`: the recording began inside it; `candle`: the market's own candle; `gap`: the recording missed it. */
  source: 'recorded' | 'partial' | 'candle' | 'gap';
  buy: number; sell: number;
  /** Whether its two sides are known. */
  split: boolean;
  /** A candle's dollars as the exchange reports them (its quote volume and taker buy quote volume), not its volume at its typical price. */
  exact?: boolean;
  /** A candle's trades (fills), where the exchange reports them. */
  trades?: number;
  /** Its bucket in the recorded rows (-1 for a candle). */
  i: number;
  gap: TimeGap | null;
}

/** A candle's dollars: its volume at its typical price, as the candle-based profiles value it (traded/levels.ts). */
export const candleUsd = (c: CandleRow): number => c[5] > 0 && c[3] > 0 ? c[5] * (c[2] + c[3] + c[4]) / 3 : 0;

/**
 * Who bought and sold at market in an exchange's own candle, in dollars: its quote volume and the part of it bought at market where it
 * reports them (`exact`), else `dollars` split by its taker buys' share of its volume; null where it does not say who bought. The volume
 * strip's candle bars and the scripts' flow where the page recorded none both read it, so the two never disagree.
 */
export function candleSides(own: CandleRow | undefined, dollars: number): { buy: number; sell: number; exact: boolean } | null {
  if (!own) return null;
  const quote = own[9], quoteBought = own[10];
  if (quote !== undefined && quoteBought !== undefined && quote >= 0) { const buy = Math.min(quote, Math.max(0, quoteBought)); return { buy, sell: quote - buy, exact: true }; }
  const share = own[7] !== undefined && own[5] > 0 ? own[7] / own[5] : undefined;
  if (share === undefined || !Number.isFinite(share)) return null;
  const buy = dollars * Math.min(1, Math.max(0, share));
  return { buy, sell: dollars - buy, exact: false };
}

/** The most candles of the timeframe the strip reads from the exchange before the chart's own (about six of Binance's pages). */
export const STRIP_HISTORY_BARS = 8_000;

/**
 * Where the strip reads the exchange's own candles from when the view (with the Highlights' run before it, `start`) begins before the
 * first candle the chart draws (`first`): a long view, where the price history is a coarser line and the chart draws no candle (Karl,
 * 2026-10-30: zoomed out a little more, the volume before the chart's candles was gone). At most `cap` candles before `first`; Infinity
 * where the view begins at or after it.
 */
export function stripHistoryFrom(first: number, start: number, tf: number, cap = STRIP_HISTORY_BARS): number {
  const from = Math.floor(start / tf) * tf;
  return from < first ? Math.max(from, first - cap * tf) : Infinity;
}

/**
 * The narrowest a bar is drawn: zoomed out further, the strip's bars are of a longer timeframe (`stripTimeframe`). A year of hourly bars
 * was 8,500 of them in 1,500 pixels, each a few drawing calls, all drawn again on every pointer move: 3.6 frames a second at a 400-day
 * view, 30 with the strip off (measured 2026-10-30, Karl: "if I zoom out a lot ... it almost seems like the UI freezes").
 */
export const STRIP_MIN_PX = 2;

/**
 * The timeframe of the strip's bars over `span` ms drawn `pw` pixels wide: the chart's own (`tfMs`) while its bars are at least `min`
 * pixels wide, else the shortest longer one that is (a whole number of the chart's, so a bar holds whole candles), and a day at the most.
 */
export function stripTimeframe(tfMs: number, span: number, pw: number, min = STRIP_MIN_PX): { ms: number; name: string } {
  const own = Object.entries(TIMEFRAMES).find(([, ms]) => ms === tfMs);
  const wide = (ms: number): boolean => !(span > 0 && pw > 0) || pw * ms / span >= min;
  if (!own || wide(tfMs)) return { ms: tfMs, name: own?.[0] ?? '' };
  const longer = Object.entries(TIMEFRAMES).filter(([, ms]) => ms > tfMs && ms % tfMs === 0).sort((a, b) => a[1] - b[1]);
  const [name, ms] = longer.find(([, ms]) => wide(ms)) ?? longer[longer.length - 1] ?? own;
  return { ms, name };
}

/** Whether a candle says who bought (its taker buys at index 7). */
const saysWho = (c: CandleRow): boolean => c[7] !== undefined && c[5] >= 0;

/**
 * The strip's candles of a longer timeframe (`stripMs`) than the chart's (`tfMs`): the exchange's own of that timeframe (`exchange`, by
 * start: Binance's, read for the strip) where it has one, else the chart's candles (`drawn`) added up into it. A bucket the chart's candles
 * begin inside is left out (it would hold part of its time only, and read as a quiet one), unless the exchange has it. An added-up bucket
 * says who bought only where every candle in it does; its trades and quote volumes likewise. `own`: the rows that say who bought, by start,
 * for the bars' sides.
 */
export function coarseCandles(drawn: readonly CandleRow[], tfMs: number, stripMs: number, exchange: ReadonlyMap<number, CandleRow> | null): { rows: CandleRow[]; own: Map<number, CandleRow> } {
  const added = new Map<number, { row: CandleRow; first: number; last: number; says: boolean; detail: boolean }>();
  for (const c of drawn) {
    const start = Math.floor(c[0] / stripMs) * stripMs, held = added.get(start), says = saysWho(c), detail = c[8] !== undefined && c[9] !== undefined && c[10] !== undefined;
    if (!held) { added.set(start, { row: [start, c[1], c[2], c[3], c[4], c[5], undefined, c[7], c[8], c[9], c[10]], first: c[0], last: c[0], says, detail }); continue; }
    const r = held.row;
    if (c[0] < held.first) { r[1] = c[1]; held.first = c[0]; }
    if (c[0] >= held.last) { r[4] = c[4]; held.last = c[0]; }
    r[2] = Math.max(r[2], c[2]); r[3] = Math.min(r[3], c[3]); r[5] += c[5];
    held.says &&= says; held.detail &&= detail;
    if (held.says) r[7] = r[7]! + c[7]!;
    if (held.detail) { r[8] = r[8]! + c[8]!; r[9] = r[9]! + c[9]!; r[10] = r[10]! + c[10]!; }
  }
  const firstDrawn = drawn[0]?.[0] ?? Infinity, rows: CandleRow[] = [], own = new Map<number, CandleRow>();
  const starts = new Set<number>([...added.keys(), ...(exchange?.keys() ?? [])]);
  for (const start of [...starts].sort((a, b) => a - b)) {
    let row = exchange?.get(start);
    if (!row) {
      const held = added.get(start)!;
      if (start < firstDrawn) continue; // the chart's first candle starts inside it: part of its time only
      row = held.row;
      if (!held.says) row = row.slice(0, 6) as CandleRow;
      else if (!held.detail) row = row.slice(0, 8) as CandleRow;
    }
    rows.push(row);
    if (saysWho(row)) own.set(start, row);
  }
  return { rows, own };
}

/** The exchange's candles before `first` held in `own` (by start), in time order, then the chart's own (`drawn`, oldest first). */
export function withEarlier(drawn: readonly CandleRow[], own: ReadonlyMap<number, CandleRow>, first: number): readonly CandleRow[] {
  const before: CandleRow[] = [];
  for (const [start, row] of own) if (start < first) before.push(row);
  return before.length ? [...before.sort((a, b) => a[0] - b[0]), ...drawn] : drawn;
}

/**
 * The bars of the candles in [t0, t1]: from the recorded rows (buckets of the timeframe) from where the recording reaches (`since`), a
 * candle it starts inside partial; before it, or with nothing recorded, the candle itself, read with `exchange` (the exchange's own candle
 * of that start, Binance's: undefined where the exchange does not say who bought). Its quote volume and the part of it bought at market,
 * where it reports them, are its dollars and sides as reported; else its volume at its typical price split by its taker buys' share. In a
 * replay a candle not closed by `now` is left out: its final volume says what came later.
 */
export function stripBars(candles: readonly CandleRow[], tf: number, rows: TimeRows | null, since: number | null, now: number, t0: number, t1: number,
  place: (start: number) => { x: number; w: number }, exchange: (start: number) => CandleRow | undefined, replay: boolean): StripBar[] {
  const out: StripBar[] = [];
  for (const c of candles) {
    const s = c[0], e = s + tf;
    if (e < t0 || s > t1 || s > now) continue;
    const { x, w } = place(s), i = rows && e > rows.from ? bucketAt(rows, Math.max(s, rows.from)) : -1;
    // From the recording where it reaches and its rows hold the bar; a bar wholly before the rows asked for is the candle's, never another's
    // bucket; the bar the recording begins inside is the recording's where its rows hold it, else the candle's.
    const gap = i >= 0 ? rows!.gaps[i] ?? null : null, inside = since !== null && s < since;
    if (rows && since !== null && e > since && i >= 0 && !(inside && gap)) {
      out.push({ t: s, x, w, source: gap ? 'gap' : inside ? 'partial' : 'recorded', buy: gap ? 0 : rows.buy[i]!, sell: gap ? 0 : rows.sell[i]!, split: !gap, i, gap });
      continue;
    }
    if (replay && e > now) continue;
    const own = exchange(s), dollars = candleUsd(c), sides = candleSides(own, dollars), trades = own?.[8];
    if (sides?.exact) {
      out.push({ t: s, x, w, source: 'candle', buy: sides.buy, sell: sides.sell, split: true, exact: true, ...(trades !== undefined ? { trades } : {}), i: -1, gap: null });
      continue;
    }
    out.push({ t: s, x, w, source: 'candle', buy: sides ? sides.buy : dollars, sell: sides ? sides.sell : 0, split: sides !== null, i: -1, gap: null });
  }
  return out;
}

/** Each bar's Highlights flag and threshold (dollars), worked out within each run of one source: never across the seam or a gap. */
export function stripHighlights(bars: readonly StripBar[], options: { length: number; mult: number }): { flag: Uint8Array; threshold: Float64Array } {
  const flag = new Uint8Array(bars.length), threshold = new Float64Array(bars.length).fill(NaN);
  const kind = (b: StripBar): string => b.source === 'candle' ? 'candle' : b.source === 'recorded' ? 'recorded' : '';
  for (let a = 0; a < bars.length;) {
    const k = kind(bars[a]!);
    let z = a; while (z < bars.length && kind(bars[z]!) === k) z++;
    if (k) {
      const values = Float64Array.from(bars.slice(a, z), b => b.buy + b.sell), found = anomalies(values, options);
      for (let i = a; i < z; i++) { flag[i] = found.flag[i - a]!; threshold[i] = found.threshold[i - a]!; }
    }
    a = z;
  }
  return { flag, threshold };
}

/**
 * `stripHighlights` kept while the bars' candles, figures and sources and the options are the same (Sol review, 2026-10-30: a long view's
 * thousands of bars had their baselines worked out again on every pointer move): comparing them is one pass, the baselines many.
 */
export class StripHighlightMemo {
  #held: { t: Float64Array; v: Float64Array; k: Uint8Array; length: number; mult: number; result: ReturnType<typeof stripHighlights> } | null = null;
  of(bars: readonly StripBar[], options: { length: number; mult: number }): ReturnType<typeof stripHighlights> {
    const n = bars.length, h = this.#held, code = (b: StripBar): number => b.source === 'candle' ? 1 : b.source === 'recorded' ? 2 : 0;
    let same = !!h && h.t.length === n && h.length === options.length && h.mult === options.mult;
    for (let i = 0; same && i < n; i++) { const b = bars[i]!; same = h!.t[i] === b.t && Object.is(h!.v[i], b.buy + b.sell) && h!.k[i] === code(b); }
    if (same) return h!.result;
    const result = stripHighlights(bars, options);
    this.#held = { t: Float64Array.from(bars, b => b.t), v: Float64Array.from(bars, b => b.buy + b.sell), k: Uint8Array.from(bars, code), length: options.length, mult: options.mult, result };
    return result;
  }
}

/** What the strip draws besides its bars. */
export interface StripDraw {
  pw: number; ph: number; height: number; palette: Palette;
  bars: 'split' | 'delta'; emphasis: boolean;
  /** The Highlights (null while they are off), as indices into the bars. */
  highlights: { flag: Uint8Array; threshold: Float64Array } | null;
  /** What the recorded part is called, and the candles' part ("≈ Binance 1h candles"). */
  recorded: string; candles: string;
  /** The bar under the pointer, or -1. */
  hovered: number;
  /** What the strip's names keep clear of (the note under the map's legend where it reaches the strip), or none. */
  clear?: { x0: number; x1: number; y0: number; y1: number } | null;
}

/** Where the strip's names stand: the top of their plates (14 px tall), on a plot `ph` tall with the strip `height` tall. */
export const stripNamesTop = (ph: number, height: number): number => ph - height - 6 + 4;

/**
 * The strip: a soft backdrop, each bar growing up from the bottom (the first side, bid colour, at its foot) on one scale, a candle's
 * outlined in the profile colour and grey where it does not say who bought, a gap a dotted run along the bottom, the Highlights' bars full
 * strength with their threshold dashed within each run, the seam marked, and the two parts named at their left. Returns where it printed
 * those names (their plates), which the map's captions keep clear of.
 */
export function paintVolumeStrip(ctx: CanvasRenderingContext2D, bars: readonly StripBar[], d: StripDraw): { x0: number; x1: number; y0: number; y1: number }[] {
  const { ph, height: H, palette: p } = d, floor = ph - 1, top = ph - H - 6;
  let max = 0; for (const b of bars) max = Math.max(max, b.buy + b.sell);
  ctx.save();
  // A soft backdrop keeps the bars readable over bright heat.
  const hex = p.bg.replace('#', ''), [br, bg, bb] = [0, 2, 4].map(i => parseInt(hex.slice(i, i + 2), 16));
  const backdrop = ctx.createLinearGradient(0, top, 0, ph);
  backdrop.addColorStop(0, `rgba(${br},${bg},${bb},0)`); backdrop.addColorStop(1, `rgba(${br},${bg},${bb},${p.dark ? 0.55 : 0.5})`);
  ctx.fillStyle = backdrop; ctx.fillRect(0, top, d.pw, H + 6);
  if (!(max > 0) && !bars.some(b => b.source === 'gap')) { ctx.restore(); return []; }
  const median = medianRow(bars.filter(b => b.source !== 'candle').map(b => b.buy + b.sell)), floorUsd = emphasisFloor(), hl = d.highlights;
  bars.forEach((b, i) => {
    const total = b.buy + b.sell, h = max > 0 ? Math.max(total > 0 ? 1 : 0, total / max * H) : 0, x0 = b.x - b.w / 2, hot = !!hl && hl.flag[i] === 1;
    if (b.source === 'gap') {
      ctx.globalAlpha = 0.7; ctx.strokeStyle = p.muted; ctx.lineWidth = 1; ctx.setLineDash([1, 3]); ctx.beginPath(); ctx.moveTo(x0, floor - 0.5); ctx.lineTo(x0 + b.w, floor - 0.5); ctx.stroke(); ctx.setLineDash([]);
      return;
    }
    if (hot) { ctx.globalAlpha = 0.07; ctx.fillStyle = b.buy >= b.sell ? p.candleUp : p.candleDown; ctx.fillRect(x0, 0, b.w, top); }
    const base = hl ? (hot ? 1 : 0.45) : 0.75, fade = b.source === 'partial' ? 0.55 : 1;
    if (!b.split) { ctx.globalAlpha = base * fade; ctx.fillStyle = p.muted; ctx.fillRect(x0, floor - h, b.w, h); }
    else if (d.bars === 'delta') {
      const net = b.buy - b.sell, nh = max > 0 ? Math.abs(net) / max * H : 0;
      ctx.globalAlpha = 0.25 * fade; ctx.fillStyle = p.muted; ctx.fillRect(x0, floor - h, b.w, h);
      if (nh > 0) { ctx.globalAlpha = base * fade; ctx.fillStyle = net > 0 ? p.bid : p.ask; ctx.fillRect(x0, floor - nh, b.w, nh); }
    } else {
      const [first, second] = splitStyles(b.buy, b.sell, median, floorUsd, p, d.emphasis), buyH = total > 0 ? h * b.buy / total : 0;
      if (b.buy > 0) { ctx.globalAlpha = Math.min(1, first.alpha * base / 0.75) * fade; ctx.fillStyle = first.color; ctx.fillRect(x0, floor - buyH, b.w, buyH); }
      if (b.sell > 0) { ctx.globalAlpha = Math.min(1, second.alpha * base / 0.75) * fade; ctx.fillStyle = second.color; ctx.fillRect(x0, floor - h, b.w, h - buyH); }
    }
    // A candle is one market's, not the venues' (and, without its quote volume, an estimate): outlined in the profile colour, as the candle-based profiles are.
    if (b.source === 'candle') { ctx.globalAlpha = 0.85; if (h >= 2) { ctx.strokeStyle = p.poc; ctx.lineWidth = 1; ctx.strokeRect(x0 + 0.5, floor - h + 0.5, Math.max(0, b.w - 1), Math.max(0, h - 1)); } else { ctx.fillStyle = p.poc; ctx.fillRect(x0, floor - 1, b.w, 1); } }
    if (hot) { ctx.globalAlpha = 0.9; ctx.fillStyle = p.dark ? '#ffffff' : '#14171c'; ctx.fillRect(x0, floor - h - 1.5, b.w, 1.5); }
    if (i === d.hovered) { ctx.globalAlpha = 1; ctx.strokeStyle = p.text; ctx.lineWidth = 1; ctx.strokeRect(x0 - 1.5, floor - h - 1.5, b.w + 3, h + 3); }
  });
  // The Highlights' threshold, dashed within each run of one source (a break where the source changes or the data stops).
  if (hl && max > 0) {
    ctx.globalAlpha = 0.7; ctx.strokeStyle = p.muted; ctx.lineWidth = 1; ctx.setLineDash([3, 3]); ctx.beginPath();
    let open = false, last = '';
    bars.forEach((b, i) => {
      const th = hl.threshold[i]!, kind = b.source;
      if (!Number.isFinite(th) || kind === 'gap' || kind === 'partial' || kind !== last) open = false;
      last = kind;
      if (!Number.isFinite(th) || kind === 'gap' || kind === 'partial') return;
      const y = floor - Math.min(1, th / max) * H, x0 = b.x - b.w / 2, x1 = b.x + b.w / 2;
      if (!open) { ctx.moveTo(x0, y); open = true; } else ctx.lineTo(x0, y);
      ctx.lineTo(x1, y);
    });
    ctx.stroke(); ctx.setLineDash([]);
  }
  // The seam, and each part named at its left.
  ctx.font = '600 10px ui-sans-serif, system-ui, sans-serif'; ctx.textBaseline = 'middle'; ctx.textAlign = 'left';
  // Each named at its left, the second after the first ends; one with no room left out rather than over the other or off the map, or under
  // the note over the map's foot (`clear`: on a short map even its one line can reach the names).
  let taken = 2;
  const names = stripNamesTop(ph, H), clear = d.clear, printed: { x0: number; x1: number; y0: number; y1: number }[] = [];
  const name = (text: string, x: number, color: string): void => {
    const w = ctx.measureText(text).width + 8, at = Math.max(taken, x);
    if (at + w > d.pw - 2) return;
    if (clear && at < clear.x1 && at + w > clear.x0 && names < clear.y1 && names + 14 > clear.y0) return;
    ctx.globalAlpha = 0.85; ctx.fillStyle = p.panel; ctx.fillRect(at, names, w, 14);
    ctx.globalAlpha = 1; ctx.fillStyle = color; ctx.fillText(text, at + 4, names + 7);
    printed.push({ x0: at, x1: at + w, y0: names, y1: names + 14 });
    taken = at + w + 6;
  };
  const firstCandle = bars.findIndex(b => b.source === 'candle'), firstRecorded = bars.findIndex(b => b.source !== 'candle');
  if (firstCandle >= 0 && firstRecorded > firstCandle) {
    const seam = bars[firstRecorded]!.x - bars[firstRecorded]!.w / 2;
    ctx.globalAlpha = 0.9; ctx.strokeStyle = p.poc; ctx.lineWidth = 1; ctx.setLineDash([4, 3]); ctx.beginPath(); ctx.moveTo(Math.round(seam) + 0.5, top + 2); ctx.lineTo(Math.round(seam) + 0.5, floor); ctx.stroke(); ctx.setLineDash([]);
  }
  if (firstCandle >= 0) name(d.candles, bars[firstCandle]!.x - bars[firstCandle]!.w / 2, p.poc);
  if (firstRecorded >= 0) name(d.recorded, bars[firstRecorded]!.x - bars[firstRecorded]!.w / 2 + 2, p.text);
  ctx.restore();
  return printed;
}

const pct = (x: number): string => `${(x * 100).toFixed(1)} %`;
const signedPct = (x: number): string => `${x > 0 ? '+' : x < 0 ? '−' : ''}${(Math.abs(x) * 100).toFixed(1)} %`;
const signedUsd = (x: number): string => `${x > 0 ? '+' : x < 0 ? '−' : ''}$${usd(Math.abs(x))}`;
/** A bar's total, its two sides with their shares and its delta with its share of the total. */
function sideLines(buy: number, sell: number): InfoLine[] {
  const total = buy + sell, net = buy - sell, share = (x: number): string => total > 0 ? pct(x / total) : '—';
  return [
    { label: t('Volume'), text: `$${usd(total)}` },
    { label: VOLUME_WORDS.buy, text: `$${usd(buy)} · ${share(buy)}`, color: 'buy' },
    { label: VOLUME_WORDS.sell, text: `$${usd(sell)} · ${share(sell)}`, color: 'sell' },
    { label: VOLUME_WORDS.net, text: `${signedUsd(net)} · ${total > 0 ? signedPct(net / total) : '—'}`, ...(net > 0 ? { color: 'buy' as const } : net < 0 ? { color: 'sell' as const } : {}) },
  ];
}

/** What the box of a strip bar is told besides the bar. */
export interface StripBoxContext {
  rows: TimeRows | null; tf: number; now: number; market: string; tfName: string;
  /** Whether the exchange reports taker buys (Binance): a candle without them then has them still to come, not none. */
  reports: boolean;
  /** The strip's own total on screen, the recorded bars', for the share of each. */
  total: number;
  /** A recorded bar's market orders as read so far (`StripOrderCache.want`); undefined where they are not asked for. */
  orders?: StripOrders | 'loading' | 'failed' | null;
  /** The whale size the orders' whale share is from (USD, scaled for the coin). */
  whaleUsd?: number;
}

/**
 * The box of the bar under the pointer. A recorded bar: its time, its volume, its sides and delta with their shares, its share of the strip
 * on screen, then its market orders. A candle: the same of the exchange's candle (its quote volume where it reports it, else its volume at
 * its typical price, marked ≈), its trades and average fill where reported, and where it comes from.
 */
export function stripLines(bar: StripBar, c: StripBoxContext): InfoLine[] {
  if (bar.source !== 'candle' && c.rows && bar.i >= 0) {
    const rows = c.rows, i = bar.i, [a, b] = bucketSpan(rows, i), gap = rows.gaps[i], open = (rows.bin0 + i + 1) * rows.step > c.now;
    const lines: InfoLine[] = [{ text: `${timeText(a, rows.step, c.now)} – ${timeText(b, rows.step, c.now)}${open ? ` · ${t('under way')}` : ''}`, bold: true }];
    if (gap) { lines.push({ text: gapText(gap), color: 'muted', wrap: true }); return lines; }
    const buy = rows.buy[i] ?? 0, sell = rows.sell[i] ?? 0;
    if (!(buy + sell > 0)) lines.push({ text: timeWords('volume').none, color: 'muted', wrap: true });
    else {
      lines.push(...sideLines(buy, sell));
      if (c.total > 0) lines.push({ label: VOLUME_WORDS.share, text: pct((buy + sell) / c.total) });
      lines.push(...orderLines(c.orders, c.whaleUsd ?? 0));
    }
    if (bar.source === 'partial') lines.push({ text: t('The recording began inside this bar: part of it only.'), color: 'muted', wrap: true });
    return lines;
  }
  const total = bar.buy + bar.sell, lines: InfoLine[] = [{ text: `${timeText(bar.t, c.tf, c.now)} – ${timeText(bar.t + c.tf, c.tf, c.now)}`, bold: true }];
  if (bar.split) lines.push(...sideLines(bar.buy, bar.sell));
  else lines.push({ label: t('Volume'), text: `$${usd(total)}` }, { text: c.reports ? t('Who bought in this candle is not loaded yet: the total only.') : t('{market} candles do not say who bought: the total only.', { market: c.market }), color: 'muted', wrap: true });
  if (bar.trades !== undefined) {
    lines.push({ label: t('Trades (fills)'), text: bar.trades.toLocaleString('en-US'), rule: true }, { label: t('Average fill'), text: bar.trades > 0 ? `$${usd(total / bar.trades)}` : '—' });
    lines.push({ text: t('A trade is one fill: a market order filled against several resting orders counts several times.'), color: 'muted', wrap: true });
  }
  lines.push({ text: bar.exact ? t('{market} {tf} candle: one market, before the recording reaches; its quote volume as the exchange reports it.', { market: c.market, tf: c.tfName })
    : t('≈ {market} {tf} candle: one market, before the recording reaches; its volume at its typical price.', { market: c.market, tf: c.tfName }), color: 'muted', wrap: true });
  return lines;
}

/** Two runs of rows of one step, the second starting where the first ends, as one (the closed buckets and the one under way). */
export function joinRows(a: TimeRows, b: TimeRows): TimeRows {
  const n = a.buy.length + b.buy.length, buy = new Float64Array(n), sell = new Float64Array(n);
  buy.set(a.buy); buy.set(b.buy, a.buy.length); sell.set(a.sell); sell.set(b.sell, a.buy.length);
  let total = 0, max = 0, poc = -1;
  for (let i = 0; i < n; i++) { const v = buy[i]! + sell[i]!; total += v; if (v > max) { max = v; poc = i; } }
  return { ...a, to: b.to, buy, sell, gaps: [...a.gaps, ...b.gaps], buyN: null, sellN: null, total, max, poc };
}
