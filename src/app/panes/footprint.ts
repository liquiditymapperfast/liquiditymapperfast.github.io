import { TIMEFRAMES } from '../hub.ts';
import type { Palette } from '../theme.ts';
import type { Bounds } from '../view.ts';
import { View } from '../view.ts';
import type { CandleRow } from '../store.ts';
import type { FootprintResponse } from '../source.ts';
import type { InfoLine } from '../infobox.ts';
import { price as fmtPrice, clock } from '../format.ts';
import { t, tn } from '../i18n.ts';
import { venueLabel } from '../venues.ts';
import { venueOfInstrument } from '../cvd/families.ts';
import type { BarMarks } from '../footprint/marks.ts';
import type { FootprintSettings } from '../footprint/settings.ts';
import { barPieces } from './ladder-pieces.ts';
import { drawVenueMark } from '../venue-marks.ts';

type Row = [number, number, number];
/** Trade counts and USD by size bucket (see SIZE_BUCKET_LABELS); only present for bars whose executions were recorded with stats. */
export interface TradeStats { buyN: number; sellN: number; buy: number[]; sell: number[] }
export interface Bar {
  t: number; rows: Row[]; buyUsd: number; sellUsd: number;
  /** Recorded minutes inside the bar; a candle seen only in part has fewer than its length. Absent from servers that predate it. */
  minutes?: number;
  stats?: TradeStats;
  /** USD of the market orders from each size line the bars were loaded with (`FootprintData.cuts`), bought then sold; absent where the source does not know them. */
  over?: number[];
  /** On the wire, venues added together: each row's markets as [place in the answer's `venues`, buy, sell, ...] (`readBar` turns them into `parts`). */
  venueRows?: number[][];
  /** Each row's markets with volume there (aligned to `rows`), the most volume of the answer first. */
  parts?: VenuePart[][];
}

/** One market's part of a footprint row: its instrument, the USD it bought and sold at market there. */
export type VenuePart = [id: string, buy: number, sell: number];

/** Trade stats from the wire: eight finite non-negative size buckets per side and integer counts, else none (the bar then has no trade statistics). */
export function validStats(value: unknown): TradeStats | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const { buyN, sellN, buy, sell } = value as Partial<Record<keyof TradeStats, unknown>>;
  const bucket = (v: unknown): v is number[] => Array.isArray(v) && v.length === 8 && v.every(x => typeof x === 'number' && Number.isFinite(x) && x >= 0);
  const count = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v >= 0;
  return count(buyN) && count(sellN) && bucket(buy) && bucket(sell) ? { buyN, sellN, buy, sell } : undefined;
}

/**
 * A bar from the server with its optional trade stats and size-line sums checked (two finite, non-negative sums for each of `cuts` lines), and
 * its rows' markets (`venueRows`, named by place in the answer's `venues`) turned into ids: slices of one view come in several answers, each
 * with its own order. Rows' markets that do not read as such (a place out of range, a number that is not one) are left out whole.
 */
export function readBar(bar: Bar, cuts = 0, venues?: readonly string[]): Bar {
  const { stats, over, venueRows, parts: _parts, ...rest } = bar, valid = validStats(stats);
  const lines = cuts > 0 && Array.isArray(over) && over.length === 2 * cuts && over.every(x => typeof x === 'number' && Number.isFinite(x) && x >= 0) ? { over } : {};
  const parts = venues && Array.isArray(venueRows) ? readParts(venueRows, bar.rows.length, venues) : null;
  return { ...rest, ...(valid ? { stats: valid } : {}), ...lines, ...(parts ? { parts } : {}) };
}

function readParts(rows: unknown[], count: number, venues: readonly string[]): VenuePart[][] | null {
  if (rows.length !== count) return null;
  const out: VenuePart[][] = [];
  for (const flat of rows) {
    if (!Array.isArray(flat) || flat.length % 3 !== 0) return null;
    const row: VenuePart[] = [];
    for (let i = 0; i < flat.length; i += 3) {
      const place = flat[i], buy = flat[i + 1], sell = flat[i + 2], id = Number.isInteger(place) ? venues[place as number] : undefined;
      if (typeof id !== 'string' || typeof buy !== 'number' || typeof sell !== 'number' || !(buy >= 0) || !(sell >= 0) || !Number.isFinite(buy + sell)) return null;
      row.push([id, buy, sell]);
    }
    out.push(row);
  }
  return out;
}

/** The markets in the order their pieces keep on every row: the most volume over the bars held first (one order, so a venue keeps its place). */
export function venueOrderOf(bars: Iterable<Bar>): string[] {
  const total = new Map<string, number>();
  for (const bar of bars) for (const row of bar.parts ?? []) for (const [id, buy, sell] of row) total.set(id, (total.get(id) ?? 0) + buy + sell);
  return [...total].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)).map(([id]) => id);
}

/**
 * Zoom policy (all CSS px of one candle slot): the footprint appears once a slot is wide enough, fades in over 500 ms
 * (ease-out quint), prints the sell / buy numbers from 120 px wide and 14 px rows, regroups rows dyadically to stay
 * 12-16 px tall, slides the candle to the left of the slot and dims the heatmap by up to 80 %.
 */
export const FOOTPRINT_POLICY = Object.freeze({
  baseColumnWidth: 24, overscan: 40, barEnter: 14, barLeave: 10, zeroBar: 12,
  sellBuyEnterWidth: 120, sellBuyLeaveWidth: 108, sellBuyEnterHeight: 14, sellBuyLeaveHeight: 12,
  textEnterFactor: 0.56, textLeaveFactor: 0.44, fadeMs: 500, coarsenHeight: 12, refineHeight: 16, maxLevel: 24,
});

/** A row's bar takes the colour of a side at least this many times the other (or with the other empty); grey where neither is. */
export const IMBALANCE_RATIO = 1.15;

/** The decades of volume a logarithmic bar spans: a row a ten-thousandth of the busiest is at the start. */
const LOG_DECADES = 4;
/**
 * A row's bar length as a fraction of the column: its volume against the busiest row in view, in proportion, by the square root or by the
 * logarithm (over LOG_DECADES decades below the busiest, so a row ten times smaller is a quarter shorter). Every row with volume has one.
 */
export function barFraction(volume: number, busiest: number, widths: 'linear' | 'sqrt' | 'log'): number {
  if (!(volume > 0) || !(busiest > 0)) return 0;
  const share = Math.min(1, volume / busiest);
  if (widths === 'linear') return share;
  if (widths === 'sqrt') return Math.sqrt(share);
  const unit = busiest / 10 ** LOG_DECADES;
  return Math.log1p(volume / unit) / Math.log1p(busiest / unit);
}

const clamp01 = (v: number) => Math.max(0, Math.min(1, v));
export const easeOutQuint = (t: number) => 1 - (1 - clamp01(t)) ** 5;

interface Tween { from: number; target: number; start: number }
const sample = (tw: Tween, now: number) => tw.from === tw.target ? tw.target : tw.from + (tw.target - tw.from) * easeOutQuint((now - tw.start) / FOOTPRINT_POLICY.fadeMs);
const retarget = (tw: Tween, target: number, now: number): Tween => target === tw.target ? tw : { from: sample(tw, now), target, start: now };

/** How much footprint to show given how many candles are on screen and how wide they are. */
export function visibilityFactor(candles: readonly CandleRow[], tfMs: number, view: Bounds, pw: number, ph: number, rowHeight: number, grouping: number): number {
  const width = pw * tfMs / (view.t1 - view.t0);
  const gain = clamp01((width / FOOTPRINT_POLICY.baseColumnWidth - 0.5) / 3);
  if (gain === 0) return 0;
  const strong = gain > 0.6;
  const first = Math.floor(view.t0 / tfMs), last = Math.floor(view.t1 / tfMs);
  const overIdx = FOOTPRINT_POLICY.overscan / width, pxPerPrice = ph / (view.p1 - view.p0), overPrice = FOOTPRINT_POLICY.overscan / pxPerPrice;
  const oFirst = first - overIdx, oLast = last + overIdx, oLow = view.p0 - overPrice, oHigh = view.p1 + overPrice;
  let full = 0, partial = 0, fringe = 0, significant = 0, maxCoverage = 0;
  for (const c of candles) {
    const index = Math.floor(c[0] / tfMs);
    if (index < oFirst || index > oLast) continue;
    const high = c[2], low = c[3], open = c[1], close = c[4];
    const top = high || close || open, bottom = low || open || close;
    if (!(top >= bottom) || top === 0 || bottom > oHigh || top < oLow) continue;
    const insideTime = index >= first && index <= last, insidePrice = !(bottom > view.p1 || top < view.p0);
    let coverage = 1;
    if (top > oHigh && bottom < oLow) coverage = 1; else if (top > oHigh) coverage = (oHigh - bottom) / (top - bottom); else if (bottom < oLow) coverage = (top - oLow) / (top - bottom);
    let attenuation = 1;
    if (!insideTime) { const before = index < first ? first - index : 0, after = index > last ? index - last : 0; attenuation = Math.max(0, 1 - Math.min(before, after) / (FOOTPRINT_POLICY.overscan / width)); }
    if (!insidePrice) { const d = bottom > view.p1 ? (bottom - view.p1) / grouping : (view.p0 - top) / grouping; attenuation = Math.min(attenuation, Math.max(0, 1 - d / (FOOTPRINT_POLICY.overscan / rowHeight))); }
    coverage *= attenuation; maxCoverage = Math.max(maxCoverage, coverage);
    const floor = strong ? 0.0001 : 0.001, volume = Number.isFinite(c[5]) ? c[5] : 0;
    const isSignificant = volume > (strong ? 0.1 : 5) || (high > 0 && low > 0 && (high - low) / low > floor) || (open > 0 && close > 0 && Math.abs(close - open) / open > floor / 2);
    if (coverage > 0.7 && insideTime && insidePrice) { full++; if (isSignificant) significant++; } else if (coverage > 0.2) { partial++; if (isSignificant) significant++; } else if (coverage > 0.01) fringe++;
  }
  if (strong && full + partial <= 3 && full + partial > 0) return Math.max(0.6, gain * maxCoverage);
  let visible = Math.min(1, (full + 0.6 * partial + 0.1 * fringe) / (strong ? 2 : 4)) * gain;
  if (fringe > 0 && visible < 0.1) visible = 0.1 * maxCoverage;
  if (significant > 0) visible = Math.max(strong ? 0.3 : 0.1, visible);
  return clamp01(visible * (0.3 + 0.7 * maxCoverage));
}

/** Share of the heatmap that is still shown when the footprint has reached `barAlpha`: all of it with the footprint absent, none once the footprint is dominant (from about three quarters in), eased so it does not snap. */
export function heatmapShare(barAlpha: number): number {
  const t = clamp01(barAlpha / 0.75);
  return 1 - t * t * (3 - 2 * t);
}

export interface LodFrame { barAlpha: number; sellBuyAlpha: number; needsFrame: boolean; heatmapOpacity: number; narrowing: number }

/** Footprint level-of-detail state: eligibility gates with hysteresis plus the two fade tweens. */
export class FootprintLod {
  #bars = false; #sellBuy = false;
  #barTw: Tween = { from: 0, target: 0, start: 0 }; #sbTw: Tween = { from: 0, target: 0, start: 0 };
  #level = 0;

  /** Dyadic row grouping that keeps rows 12-16 px tall (with hysteresis), as multiples of the recorded fine step. */
  level(fineRowPx: number): number {
    const p = FOOTPRINT_POLICY; let level = this.#level;
    if (fineRowPx * 2 ** level < p.coarsenHeight) while (level < p.maxLevel && fineRowPx * 2 ** level < p.coarsenHeight) level++;
    else while (level > 0 && fineRowPx * 2 ** (level - 1) >= p.refineHeight) level--;
    this.#level = level; return level;
  }

  step(now: number, input: { enabled: boolean; hasData: boolean; widthCss: number; rowHeightCss: number; factor: number }): LodFrame {
    const p = FOOTPRINT_POLICY, { widthCss: w, rowHeightCss: h } = input, factor = clamp01(input.factor);
    const active = input.enabled && input.hasData;
    this.#bars = active && (this.#bars ? w > p.barLeave : w >= p.barEnter);
    const sellBuy = active && this.#bars && (this.#sellBuy ? w >= p.sellBuyLeaveWidth && h >= p.sellBuyLeaveHeight && factor > p.textLeaveFactor : w >= p.sellBuyEnterWidth && h >= p.sellBuyEnterHeight && factor >= p.textEnterFactor);
    this.#sellBuy = sellBuy;
    this.#barTw = retarget(this.#barTw, active && this.#bars && w > p.zeroBar ? factor : 0, now);
    this.#sbTw = retarget(this.#sbTw, this.#sellBuy ? 1 : 0, now);
    const barAlpha = clamp01(sample(this.#barTw, now));
    const moving = [this.#barTw, this.#sbTw].some(t => t.from !== t.target && now < t.start + p.fadeMs);
    return { barAlpha, sellBuyAlpha: clamp01(sample(this.#sbTw, now)), needsFrame: moving, heatmapOpacity: heatmapShare(barAlpha), narrowing: Math.max(barAlpha, sample(this.#sbTw, now)) };
  }
}

/** Instrument-minutes a footprint answer may merge (newest first; the rest is asked for in further answers): about 70 to 270 ms on a server. */
export const FOOTPRINT_BUDGET = 5_000;
/** A bar is final once it ended this long ago (a late trade or an order still being counted can change its last minutes until then). */
export const FOOTPRINT_SETTLE_MS = 2 * 60_000;
/** How often the bars that can still change are asked for again. */
export const FOOTPRINT_REFRESH_MS = 5_000;
/** Settled bars missing their size-line sums are asked again this often, at most this many times a load. */
const REDO_MS = 60_000, REDO_TRIES = 10;
/** Every this often the refresh also asks the last hour of settled bars again (late trades). */
const RECHECK_MS = 5 * 60_000, RECHECK_SPAN_MS = 3_600_000;
/** More bars than this held (scrolled back over days of small candles) and the next look starts again from the view. */
const FOOTPRINT_MAX_BARS = 3_000;

type FootprintLoad = (inst: string, tf: string, from: number, to: number, rowStep: number, cuts: readonly number[], budget: number, venues: boolean) => Promise<FootprintResponse>;

/**
 * Executions per candle (taker buy/sell USD by price row) for the visible window. A recorded bar does not change once it is settled, so
 * after the first look only the bars that still can are asked for again (every 5 s), and a window too long for one answer (a week of
 * hourly candles, or many markets added together) comes in slices of at most FOOTPRINT_BUDGET instrument-minutes, newest first: asking for
 * the whole window every 5 s cost a server 0.4 s each time for one market's week, 8 s for fourteen (2026-10-13).
 */
export class FootprintData {
  /** Row step of the loaded data and the recorded finest step. */
  step = 0; fine = 0;
  bars = new Map<number, Bar>();
  /** The size lines the bars were asked for (the coin's USD: the Bar stats' retail and whale sizes): each bar's `over` holds their sums. */
  cuts: number[] = [];
  /** Bumped whenever `bars` changes, for what is worked out from them (the imbalance marks). */
  version = 0;
  /** With markets added together: the order of every row's venue pieces (`venueOrderOf`), worked out once a load. */
  venueOrder: string[] = [];
  #busy = false; #retryAt = 0;

  /**
   * Trades of the bars from `from` on changed in the recording (recovered from a venue's history): those bars are asked for again with the
   * next look, settled or not, and the bars held stay drawn until the answer replaces them.
   */
  refresh(from: number): void {
    const h = this.#held, tfMs = TIMEFRAMES[this.#context.slice(this.#context.lastIndexOf('|') + 1)];
    if (!h || !tfMs) return;
    h.settled = Math.min(h.settled, Math.max(h.from, Math.floor(from / tfMs) * tfMs)); h.at = -Infinity;
  }

  /** No markets to count (Aggregated with every venue off, or none inside the filter): no bars, and nothing asked for. */
  clear(): void {
    if (this.#context === '' && !this.bars.size) return;
    this.#context = ''; this.#request++; this.#held = null; this.#busy = false; this.#stepAsked = ''; this.bars = new Map(); this.venueOrder = []; this.step = 0; this.fine = 0; this.version++;
  }
  /** The market and timeframe the bars belong to, and the number of the request whose answer counts. */
  #context = ''; #request = 0;
  /** What the bars cover: their row size and size lines (`grid`), [from, to), the bars before `settled` final, and when the tail was last asked. */
  #held: { grid: string; from: number; to: number; settled: number; at: number; rechecked: number; redo: { from: number; to: number; at: number; tries: number } } | null = null;

  /**
   * Ask for what the view needs next, if anything: everything (another row size or size lines, or a view the bars held do not touch), the
   * bars that can still change (every FOOTPRINT_REFRESH_MS, or the view reaching past the newest), or the next older slice. `now` is the
   * source's clock (a bar is settled by its time).
   */
  ensure(inst: string, tf: string, view: Bounds, rowStep: number, load: FootprintLoad, onLoad: () => void, cuts: readonly number[] = [], now = Date.now()): void {
    const tfMs = TIMEFRAMES[tf] ?? 3_600_000;
    // Rows of another market or timeframe are not rows of this one, whatever the window: they go now, rather than being drawn until the new
    // ones come (or for good, if they never do). A request still out for the old context is left to finish, and its answer is ignored.
    const context = `${inst}|${tf}`;
    if (context !== this.#context) { this.#context = context; this.bars = new Map(); this.venueOrder = []; this.step = 0; this.fine = 0; this.#held = null; this.#busy = false; this.#retryAt = 0; this.#stepAsked = ''; this.version++; }
    const clock = performance.now();
    if (this.#busy || clock < this.#retryAt) return;
    // No row size yet (`rowStep` 0: the markets' recorded step comes with their first answer). Asked as it is, the answer would hold every bar
    // on the finest rows recorded (BTC's $0.50, where the footprint draws some $64 at an hour's zoom: 45 MB for a week of hourly bars of 13
    // markets, 2026-11-07), only for the next look to ask again on the drawn rows. The step is asked first, alone; markets with nothing
    // recorded (no step) are then asked as before.
    if (!(rowStep > 0) && !this.#held && this.#stepAsked !== context) { this.#askStep(context, inst, tf, load, onLoad); return; }
    // Other size lines are another question: the bars' sums are for the lines asked.
    const grid = `${rowStep}|${cuts.join(',')}`, want = { from: Math.floor((view.t0 - tfMs) / tfMs) * tfMs, to: Math.ceil((view.t1 + tfMs) / tfMs) * tfMs };
    const h = this.#held;
    // Scrolled over more bars than are worth holding: those off the view go (the view's own are kept, however many it shows).
    if (h && this.bars.size > FOOTPRINT_MAX_BARS && (h.from < want.from || h.to > want.to)) {
      for (const t of [...this.bars.keys()]) if (t < want.from || t >= want.to) this.bars.delete(t);
      h.from = Math.max(h.from, want.from); h.to = Math.min(h.to, want.to); this.version++;
    }
    let ask: { from: number; to: number; kind: 'whole' | 'tail' | 'older' | 'redo' };
    if (!h || h.grid !== grid || want.to <= h.from || want.from >= h.to) ask = { ...want, kind: 'whole' };
    // From the first bar that can still change, but never past what is held (panning right through the past, the bars after it are not held yet).
    // Every few minutes the tail reaches back an hour into the settled bars: a trade a venue sends late (after a reconnect) lands in a
    // minute already settled here, and is otherwise only seen when the view is loaded again. A view that ends in that hour is rechecked
    // too, with no bar still under way in it (panned a few minutes behind the live edge).
    else if (want.to > h.to || (h.settled < want.to && clock - h.at >= FOOTPRINT_REFRESH_MS) || (clock - h.rechecked >= RECHECK_MS && want.to > h.settled - RECHECK_SPAN_MS)) {
      const recheck = clock - h.rechecked >= RECHECK_MS;
      if (recheck) h.rechecked = clock;
      // From the start of the bar an hour back is in (on 4 h or 1 d bars an hour back is inside the bar before): an answer's bars that start
      // before where it was asked are not taken, so a recheck begun inside a bar would leave that bar as it was.
      ask = { from: Math.min(Math.max(recheck ? Math.floor((h.settled - RECHECK_SPAN_MS) / tfMs) * tfMs : h.settled, h.from), h.to), to: Math.max(want.to, h.to), kind: 'tail' };
    }
    else if (want.from < h.from) ask = { from: want.from, to: h.from, kind: 'older' };
    // Settled bars without the sums of the size lines asked (minutes whose lists the server fills in after it starts) are asked again, once
    // a minute and at most REDO_TRIES times, from the first of them to where the tail starts.
    // A round goes on at once through the older slices a budgeted answer left (`redo.to`, where the last one reached).
    else if (h.redo.from < Math.min(h.settled, h.to, h.redo.to) && (h.redo.to < Infinity || (h.redo.tries < REDO_TRIES && clock - h.redo.at >= REDO_MS))) {
      if (h.redo.to === Infinity) { h.redo.tries++; h.redo.at = clock; }
      ask = { from: Math.max(h.redo.from, h.from), to: Math.min(h.settled, h.to, h.redo.to), kind: 'redo' };
    }
    else return;
    this.#busy = true;
    const request = ++this.#request, asked = [...cuts];
    // Several markets (a comma list): each row's markets too, for the bar's pieces.
    load(inst, tf, ask.from, ask.to, rowStep, asked, FOOTPRINT_BUDGET, inst.includes(',')).then(body => {
      if (request !== this.#request) return;
      // A source that answered only the newest part says where it starts; an older one answers the whole window.
      const reached = Math.max(ask.from, Number.isFinite(body.from) ? body.from! : ask.from), held = this.#held;
      const settled = Math.floor((now - FOOTPRINT_SETTLE_MS) / tfMs) * tfMs;
      // Bars on another grid than those held (the recorded step changed) cannot sit beside them: start again from this answer.
      const fresh = ask.kind === 'whole' || !held || body.step !== this.step;
      const bars = fresh ? new Map<number, Bar>() : this.bars;
      if (!fresh && ask.kind === 'tail') for (const t of [...bars.keys()]) if (t >= reached) bars.delete(t);
      if (!fresh && ask.kind === 'redo') for (const t of [...bars.keys()]) if (t >= reached && t < ask.to) bars.delete(t);
      for (const bar of body.bars) if (bar.t >= reached && bar.t < ask.to) bars.set(bar.t, readBar(bar, asked.length, body.venues));
      if (fresh) this.#held = { grid, from: reached, to: ask.to, settled, at: performance.now(), rechecked: performance.now(), redo: { from: Infinity, to: Infinity, at: performance.now(), tries: 0 } };
      else if (ask.kind === 'older') held.from = reached;
      // The bars it reached are replaced and what is held stays; an answer that stopped short leaves the older part for the next slice.
      else if (ask.kind === 'redo') held.redo.to = reached > ask.from ? reached : Infinity;
      // A tail too long for one answer (the page was away): what it did not reach is asked for again as older slices.
      else { if (reached > ask.from) { for (const t of [...bars.keys()]) if (t < reached) bars.delete(t); held.from = reached; } held.to = ask.to; held.settled = Math.max(held.settled, settled); held.at = performance.now(); }
      // Held oldest first, as one answer gives them (an older slice lands after the newer ones).
      this.bars = fresh ? bars : new Map([...bars].sort((a, b) => a[0] - b[0])); this.venueOrder = venueOrderOf(this.bars.values());
      // The first bar still without the sums of the lines asked (a bar with no statistics at all never gets them).
      if (this.#held) { let first = Infinity; if (asked.length) for (const [t, b] of this.bars) if (b.stats && !b.over) { first = t; break; } this.#held.redo.from = first; if (first >= this.#held.redo.to) this.#held.redo.to = Infinity; } this.step = body.step; this.fine = body.fine; this.cuts = asked; this.version++; onLoad();
    }).catch(error => {
      if (request !== this.#request) return;
      // Asked again in five seconds, not on every frame.
      console.error('footprint load failed', error); this.#retryAt = performance.now() + FOOTPRINT_REFRESH_MS;
    }).finally(() => { if (request === this.#request) this.#busy = false; });
  }

  /** The context whose recorded step `#askStep` was answered for, so markets with nothing recorded are not asked it on every look. */
  #stepAsked = '';
  /**
   * The markets' recorded step alone (`fine`), from a question for [0, 1) ms: an answer carries their step whatever its window, and this window
   * holds no minute of any market, so it costs a source nothing and brings no bars.
   */
  #askStep(context: string, inst: string, tf: string, load: FootprintLoad, onLoad: () => void): void {
    this.#busy = true;
    const request = ++this.#request;
    load(inst, tf, 0, 1, 0, [], 0, false).then(body => {
      if (request !== this.#request) return;
      this.#stepAsked = context; this.fine = body.fine > 0 ? body.fine : 0; onLoad();
    }).catch(error => {
      if (request !== this.#request) return;
      console.error('footprint load failed', error); this.#retryAt = performance.now() + FOOTPRINT_REFRESH_MS;
    }).finally(() => { if (request === this.#request) this.#busy = false; });
  }
}

/** Which side a row's bar belongs to: the dominant side when it is at least IMBALANCE_RATIO times the other, else none. */
export function imbalance(buy: number, sell: number): 'buy' | 'sell' | null {
  const high = Math.max(buy, sell), low = Math.min(buy, sell);
  if (!(high > 0)) return null;
  return low === 0 || high / low >= IMBALANCE_RATIO ? (buy > sell ? 'buy' : 'sell') : null;
}

/** The width in px of a candle's body in a slot of `slotPx`: most of the slot, never more than 40 px. Every candle has it, the one still forming too. */
export const candleBody = (slotPx: number): number => Math.max(1, Math.min(slotPx * 0.72, 40));

/**
 * Geometry of one candle slot with the footprint on, as offsets from the slot's left edge: the candle body sits at the
 * left (about a fifth of the slot, at most 44 px), the row column follows it.
 */
export function footprintLayout(slot: number): { body: number; candleCenter: number; colLeft: number; colWidth: number } {
  const gap = slot * 0.02, body = Math.min(slot * 0.2, 44);
  const colLeft = gap + body + slot * 0.03;
  return { body, candleCenter: gap + body / 2, colLeft, colWidth: Math.max(1, slot - colLeft - gap) };
}

/** Compact volume text as printed in the rows: 13.4M, 407.0k, 0.00. */
export function volText(value: number): string {
  if (!(value > 0)) return '0.00';
  if (value >= 1e9) return `${(value / 1e9).toFixed(1)}B`;
  if (value >= 1e6) return `${(value / 1e6).toFixed(1)}M`;
  if (value >= 1e3) return `${(value / 1e3).toFixed(1)}k`;
  return value.toFixed(0);
}

/** Asks which drawn rows to mark (the cells of a flagged candle) and receives their rectangles. */
export interface RowMarks { wants(barT: number, mid: number, side: 'buy' | 'sell'): boolean; add(x: number, y: number, w: number, h: number, barT: number): void }

/** What the footprint draws besides its rows' bars: each candle's imbalance marks, and how it is set (what a row prints, whether diagonal imbalances are outlined). */
export interface FootprintLook { marks: ReadonlyMap<number, BarMarks> | null; settings: FootprintSettings; /** Replay: only candles that ended by then. */ until?: number }

const FONT = '10.5px ui-monospace, SFMono-Regular, Menlo, monospace', BOLD = `600 ${FONT}`;

/**
 * Draw the per-row footprint to the right of each candle: a bar behind rows where one side dominates the same row, then what the row prints
 * (sold × bought, the delta, the total, or nothing). A diagonal imbalance is outlined in its side's colour around that side's half of the
 * row (sells on the left, buys on the right) and its number is bold in that colour; the outline stays while the numbers are too small to
 * print. `marks` (row marks) collects the rectangles of the rows it asks for.
 */
export function paintFootprint(ctx: CanvasRenderingContext2D, data: FootprintData, lod: LodFrame, tf: string, view: View, pw: number, ph: number, p: Palette, marks?: RowMarks, look?: FootprintLook): void {
  const tfMs = TIMEFRAMES[tf] ?? 3_600_000, step = data.step;
  if (!(step > 0) || lod.barAlpha <= 0.005) return;
  const slot = pw * tfMs / (view.t1 - view.t0), rowPx = Math.abs(view.yOf(0, ph) - view.yOf(step, ph)), layout = footprintLayout(slot);
  // The busiest row in view (sold and bought together) is a full column.
  let busiest = 0;
  const until = look?.until ?? Infinity, widths = look?.settings.widths ?? 'sqrt';
  for (const bar of data.bars.values()) if (bar.t + tfMs >= view.t0 && bar.t <= view.t1 && bar.t + tfMs <= until) for (const r of bar.rows) busiest = Math.max(busiest, r[1] + r[2]);
  if (!(busiest > 0)) return;
  ctx.font = FONT; ctx.textBaseline = 'middle';
  const numberWidth = ctx.measureText('999.9M').width, textColor = p.dark ? '#f1f1f1' : p.text, mode = look?.settings.text ?? 'split';
  const diagonal = look?.settings.diagonal !== false ? look?.marks ?? null : null;
  for (const bar of data.bars.values()) {
    if (bar.t + tfMs > until) continue;
    if (bar.t + tfMs < view.t0 || bar.t > view.t1) continue;
    const left = view.xOf(bar.t, pw) + layout.colLeft, split = left + Math.min(numberWidth + 5.5, layout.colWidth / 2), right = Math.min(left + layout.colWidth, split + numberWidth + 5.5);
    const flags = diagonal?.get(bar.t)?.flags;
    // Whether the numbers print: a venue mark is not drawn over them (their spans across, worked out per row below).
    const numbers = lod.sellBuyAlpha > 0.3 && mode !== 'none';
    for (let r = 0; r < bar.rows.length; r++) {
      const [low, buy, sell] = bar.rows[r]!;
      const yTop = view.yOf(low + step, ph), h = Math.max(1, rowPx - 1);
      if (yTop + h < 0 || yTop > ph) continue;
      // Every row with volume has a bar as long as its volume (sold and bought), in the colour of a side that traded at least
      // IMBALANCE_RATIO times the other, grey where neither did: a bar only on imbalanced rows left gaps that moved as the rows regrouped.
      const side = imbalance(buy, sell), fraction = barFraction(buy + sell, busiest, widths);
      if (fraction > 0) {
        const alpha = (side ? (p.dark ? 0.9 : 0.62) : (p.dark ? 0.42 : 0.3)) * lod.barAlpha; ctx.fillStyle = side === 'buy' ? p.candleUp : side === 'sell' ? p.candleDown : p.muted;
        const barWidth = Math.max(2, Math.min(layout.colWidth, layout.colWidth * fraction));
        const parts = bar.parts?.[r];
        // Every row of markets added together says whose it is, a row only one of them traded included.
        if (parts?.length && data.venueOrder.length) {
          const spans = !numbers ? [] : mode === 'split'
            ? [[split - 3 - ctx.measureText(volText(sell)).width, split - 2], [split + 2, split + 3 + ctx.measureText(volText(buy)).width]]
            : (w => [[(left + right - w) / 2 - 2, (left + right + w) / 2 + 2]])(ctx.measureText(mode === 'delta' ? signed(buy - sell) : volText(buy + sell)).width);
          paintPieces(ctx, data.venueOrder, parts, buy + sell, left, barWidth, yTop, h, ctx.fillStyle as string, alpha, lod.barAlpha, spans);
        }
        else { ctx.globalAlpha = alpha; ctx.fillRect(left, yTop, barWidth, h); }
        if (side && marks?.wants(bar.t, low + step / 2, side)) marks.add(left, yTop, barWidth, h, bar.t);
      }
      const flag = flags?.get(low);
      if (flag && h >= 3) {
        ctx.globalAlpha = lod.barAlpha; ctx.lineWidth = h >= 8 ? 1.5 : 1;
        if (flag.sell !== undefined) { ctx.strokeStyle = p.candleDown; ctx.strokeRect(left + 0.75, yTop + 0.75, split - left - 1.5, h - 1.5); }
        if (flag.buy !== undefined) { ctx.strokeStyle = p.candleUp; ctx.strokeRect(split + 0.75, yTop + 0.75, right - split - 1.5, h - 1.5); }
      }
      if (lod.sellBuyAlpha > 0.01 && mode !== 'none') {
        ctx.globalAlpha = lod.sellBuyAlpha;
        const y = yTop + h / 2;
        if (mode === 'split') {
          ctx.font = flag?.sell !== undefined ? BOLD : FONT; ctx.fillStyle = flag?.sell !== undefined ? p.candleDown : textColor;
          ctx.textAlign = 'right'; ctx.fillText(volText(sell), split - 2.5, y);
          ctx.font = flag?.buy !== undefined ? BOLD : FONT; ctx.fillStyle = flag?.buy !== undefined ? p.candleUp : textColor;
          ctx.textAlign = 'left'; ctx.fillText(volText(buy), split + 2.5, y);
        } else {
          const value = mode === 'delta' ? buy - sell : buy + sell;
          ctx.font = flag ? BOLD : FONT; ctx.fillStyle = mode === 'delta' ? (value > 0 ? p.candleUp : value < 0 ? p.candleDown : textColor) : textColor;
          ctx.textAlign = 'center'; ctx.fillText(mode === 'delta' ? signed(value) : volText(value), (left + right) / 2, y);
        }
      }
    }
  }
  ctx.globalAlpha = 1; ctx.font = '11px ui-sans-serif, system-ui, sans-serif'; ctx.textBaseline = 'middle'; ctx.textAlign = 'left';
}

/** The most venues a footprint row's popup names one by one. */
export const VENUE_LINES = 8;

/** A venue mark in a footprint piece: this size, in a piece at least two px wider and a row at least as tall. */
const PIECE_MARK = 9;

/**
 * A row's bar split by venue (the Compact book's pieces, `barPieces`): each market's share of the row's volume (`total`, sold and bought), in
 * `order` (the same on every row, so a venue keeps its place), in the bar's colour with the shade alternating by that place; parts too narrow
 * to see make one piece at the end. The pieces fill the bar as it is drawn whole (`width`). A piece wide enough and a row tall enough carry
 * the venue's mark, never over the row's printed numbers (`texts`, the span across of each).
 */
function paintPieces(ctx: CanvasRenderingContext2D, order: readonly string[], parts: readonly VenuePart[], total: number, left: number, width: number,
  yTop: number, h: number, color: string, alpha: number, markAlpha: number, texts: readonly (readonly number[])[]): void {
  const values = order.map(id => { for (const part of parts) if (part[0] === id) return part[1] + part[2]; return 0; });
  for (const piece of barPieces(order, values, total, left, width, 3)) {
    const w = Math.max(1, piece.w - (piece.w >= 3 ? 1 : 0));
    ctx.globalAlpha = alpha * (piece.rank < 0 ? 0.45 : piece.rank % 2 === 0 ? 1 : 0.62); ctx.fillStyle = color;
    ctx.fillRect(piece.x, yTop, w, h);
    if (piece.id === null || w < PIECE_MARK + 2 || h < PIECE_MARK) continue;
    const cx = piece.x + w / 2;
    if (texts.some(([a, b]) => cx + PIECE_MARK / 2 > a! && cx - PIECE_MARK / 2 < b!)) continue;
    ctx.globalAlpha = markAlpha;
    drawVenueMark(ctx, piece.id, cx, yTop + h / 2, PIECE_MARK);
  }
}

/** One price row of one candle, with how it stands in that candle. */
export interface RowCell {
  low: number; buy: number; sell: number;
  /** The busiest row of the candle (the point of control). */
  poc: boolean;
  /** This row's share of the candle's executed volume, 0 to 1. */
  share: number;
  barBuy: number; barSell: number;
  /** With markets added together: each market's part of the row (its instrument, bought, sold). */
  parts?: readonly VenuePart[];
}

/** The row of `bar` that holds `price`, with its place in the candle, or null where the candle has no executions at that price. */
export function rowCellAt(bar: Bar, step: number, price: number): RowCell | null {
  const index = bar.rows.findIndex(r => price >= r[0] && price < r[0] + step), row = bar.rows[index];
  if (!row) return null;
  let busiest = 0, total = 0;
  for (const r of bar.rows) { busiest = Math.max(busiest, r[1] + r[2]); total += r[1] + r[2]; }
  return { low: row[0], buy: row[1], sell: row[2], poc: row[1] + row[2] >= busiest && busiest > 0, share: total > 0 ? (row[1] + row[2]) / total : 0, barBuy: bar.buyUsd, barSell: bar.sellUsd, ...(bar.parts?.[index] ? { parts: bar.parts[index] } : {}) };
}

const signed = (value: number): string => (value < 0 ? '-' : value > 0 ? '+' : '') + volText(Math.abs(value));

/** How a diagonal ratio reads: "3.4×", or no ratio at all against an empty row. */
const ratioText = (ratio: number): string => Number.isFinite(ratio) ? `${ratio.toFixed(1)}×` : '';

/**
 * The popup for a footprint row: its price span, what was sold and bought there, which side had it, the diagonal imbalances outlined there
 * (`diagonal`: the ratio of each flagged side), and the candle it belongs to.
 */
/**
 * `markets`: how many markets the footprint adds together (1: the chart market's own); `venueLines`: how many of the row's venues are named one
 * by one (the rest together), fewer where the pane is too short for the box, and none (below zero) where even their summary does not fit.
 */
export function rowCellLines(cell: RowCell, bar: Bar, step: number, tf: string, diagonal?: { sell?: number; buy?: number }, markets = 1, venueLines = VENUE_LINES): InfoLine[] {
  const side = imbalance(cell.buy, cell.sell), delta = cell.buy - cell.sell, big = Math.max(cell.buy, cell.sell), small = Math.min(cell.buy, cell.sell);
  const lines: InfoLine[] = [
    { text: `${fmtPrice(cell.low, step)} – ${fmtPrice(cell.low + step, step)}`, bold: true },
    { label: t('Candle'), text: `${clock(bar.t, true)} · ${tf}` },
    ...(markets > 1 ? [{ label: t('Markets'), text: t('{n} added together', { n: markets }) }] : []),
    { label: t('Sold'), text: `$${volText(cell.sell)}`, color: 'sell' },
    { label: t('Bought'), text: `$${volText(cell.buy)}`, color: 'buy' },
    { label: t('Delta'), text: signed(delta), color: delta > 0 ? 'buy' : delta < 0 ? 'sell' : 'text', bold: true },
    { label: t('Share of candle'), text: `${(cell.share * 100).toFixed(cell.share < 0.1 ? 1 : 0)}%` },
  ];
  if (side) lines.push({ label: t('Heavier side'), text: small > 0 ? t('{side} {ratio}×', { side: side === 'buy' ? t('buyers') : t('sellers'), ratio: (big / small).toFixed(1) }) : side === 'buy' ? t('buyers only') : t('sellers only'), color: side === 'buy' ? 'buy' : 'sell' });
  else lines.push({ label: t('Heavier side'), text: t('balanced'), color: 'muted' });
  if (diagonal?.sell !== undefined) lines.push({ label: t('Diagonal'), text: Number.isFinite(diagonal.sell) ? t('sells {ratio} the buys one row up', { ratio: ratioText(diagonal.sell) }) : t('sells, none bought one row up'), color: 'sell' });
  if (diagonal?.buy !== undefined) lines.push({ label: t('Diagonal'), text: Number.isFinite(diagonal.buy) ? t('buys {ratio} the sells one row down', { ratio: ratioText(diagonal.buy) }) : t('buys, none sold one row down'), color: 'buy' });
  if (cell.poc) lines.push({ text: t('Point of control: the busiest row of this candle'), color: 'muted', wrap: true });
  // The row's markets, the most volume first: each one's mark, sold × bought and its delta; past eight, the rest together.
  // Below zero: no venue lines at all (a pane too short even for the summary line).
  if (cell.parts?.length && venueLines >= 0) {
    const ranked = [...cell.parts].sort((a, b) => b[1] + b[2] - a[1] - a[2]), shown = ranked.slice(0, Math.max(0, venueLines)), rest = ranked.slice(Math.max(0, venueLines));
    shown.forEach(([id, buy, sell], i) => lines.push({ mark: id, label: venueLabel(venueOfInstrument(id)), text: `${volText(sell)} × ${volText(buy)} · ${signed(buy - sell)}`, color: buy > sell ? 'buy' : buy < sell ? 'sell' : 'text', ...(i === 0 ? { rule: true } : {}) }));
    if (rest.length) {
      const buy = rest.reduce((s, r) => s + r[1], 0), sell = rest.reduce((s, r) => s + r[2], 0);
      lines.push({ label: tn(rest.length, '{n} more venue', '{n} more venues'), text: `${volText(sell)} × ${volText(buy)} · ${signed(buy - sell)}`, color: 'muted', ...(shown.length ? {} : { rule: true }) });
    }
  }
  lines.push({ label: t('Candle volume'), text: `$${volText(cell.barBuy + cell.barSell)}`, rule: true });
  lines.push({ label: t('Candle delta'), text: signed(cell.barBuy - cell.barSell), color: cell.barBuy > cell.barSell ? 'buy' : cell.barBuy < cell.barSell ? 'sell' : 'text' });
  return lines;
}
