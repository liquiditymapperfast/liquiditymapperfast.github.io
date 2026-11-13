import { coversAll, type CoverageAnswer } from '../../shared/coverage.ts';
import { binOf } from '../../shared/footprint.ts';
import { gridStepFor } from '../../shared/grid.ts';

/**
 * The phone's Candle view, the parts that are only numbers: where each column of the screen goes, which prices the screen shows and in
 * rows of what size, which arrivals light the rail, the age ruler under the trail, and the view's own settings. No DOM and no canvas, so
 * every rule here is tested (tests/candle-model.test.mts).
 *
 * The screen, left to right: the trail's oldest edge, the bids (bars growing left from the candle), the candle with its footprint, the asks
 * (bars growing right), the arrival rail (orders as they come in, by arrival), and the price axis. The trail runs behind the book and the
 * candle, by exchange time, from the rail's left edge (now) to the left edge (the trail's window ago).
 */
export type TrailStyle = 'phosphor' | 'etched' | 'beads';
export const TRAIL_STYLES: readonly TrailStyle[] = ['phosphor', 'etched', 'beads'];
/** How far back the trail reaches, in ms: the full width of the screen. */
export const TRAIL_WINDOWS: readonly number[] = [30_000, 60_000, 120_000];
/** The candle's own timeframes (it does not follow the map's: an hourly candle seen from a cold start is mostly empty for most of an hour). */
export const CANDLE_TIMEFRAMES: readonly string[] = ['1m', '5m', '15m', '1h'];

/**
 * `glass`: the book and the candle as pieces of glass over the trail, welded where they meet (`panes`); the book's pieces glass only inside
 * its bars (`bricks`); or a solid candle that hides the trail and a plain book (`off`). A saved true or false from before reads as panes or off.
 */
export type GlassKind = 'off' | 'panes' | 'bricks';
export const GLASS_KINDS: readonly GlassKind[] = ['off', 'panes', 'bricks'];
/**
 * How the footprint's rows show the side that won, continuously, not past a threshold (an experiment, Karl 2026-10-16; see `rowEmphasis`):
 * `lean` the winner's bar stronger and the loser's fainter as the row is more one-sided; `glow` a band behind the row as strong as its net
 * against the busiest row's; `delta` one bar from the middle toward the winner, as long as the difference.
 */
export type RowLook = 'lean' | 'glow' | 'delta';
export const ROW_LOOKS: readonly RowLook[] = ['lean', 'glow', 'delta'];
/**
 * How the glass book shows liquidity added and pulled (an experiment, Karl and Astra 2026-10-16; see `PulseTracker`): `pressure` the bar's
 * outer edge compressed into a bright rim when liquidity stacks and recessed when it is pulled; `deposit` a new layer glowing between the old
 * and the new edge as it fuses in, or a hollow outline left where the edge was; `off` none. Trades that reached a row ripple it, in either.
 */
export type PulseLook = 'off' | 'pressure' | 'deposit';
export const PULSE_LOOKS: readonly PulseLook[] = ['off', 'pressure', 'deposit'];
export interface CandleSettings { style: TrailStyle; trailMs: number; tf: string; glass: GlassKind; rows: RowLook; pulse: PulseLook }
export const CANDLE_DEFAULTS: Readonly<CandleSettings> = Object.freeze({ style: 'phosphor', trailMs: 60_000, tf: '5m', glass: 'panes', rows: 'glow', pulse: 'pressure' });
/** The view's settings live apart from the page's saved state and layouts: they are a phone's, and a desktop never reads them. */
export const CANDLE_SETTINGS_KEY = 'hlm-candle-v1';

/** A saved value field by field, each one that does not check out replaced by its default. */
export function readCandleSettings(raw: unknown): CandleSettings {
  const o = raw && typeof raw === 'object' ? raw as Partial<Record<keyof CandleSettings, unknown>> : {};
  return {
    style: TRAIL_STYLES.includes(o.style as TrailStyle) ? o.style as TrailStyle : CANDLE_DEFAULTS.style,
    trailMs: typeof o.trailMs === 'number' && TRAIL_WINDOWS.includes(o.trailMs) ? o.trailMs : CANDLE_DEFAULTS.trailMs,
    tf: typeof o.tf === 'string' && CANDLE_TIMEFRAMES.includes(o.tf) ? o.tf : CANDLE_DEFAULTS.tf,
    glass: o.glass === true ? 'panes' : o.glass === false ? 'off' : GLASS_KINDS.includes(o.glass as GlassKind) ? o.glass as GlassKind : CANDLE_DEFAULTS.glass,
    rows: ROW_LOOKS.includes(o.rows as RowLook) ? o.rows as RowLook : CANDLE_DEFAULTS.rows,
    pulse: PULSE_LOOKS.includes(o.pulse as PulseLook) ? o.pulse as PulseLook : CANDLE_DEFAULTS.pulse,
  };
}

/** Columns of the screen in CSS px, left edge inclusive. Bids grow left from `bidX1`, asks right from `askX0`. */
export interface CandleLayout {
  w: number; h: number;
  /** The plot's top and bottom (the age ruler is below `plotY1`). */
  plotY0: number; plotY1: number;
  bidX0: number; bidX1: number; candleX0: number; candleX1: number; askX0: number; askX1: number;
  railX0: number; railX1: number; axisX0: number; axisX1: number;
  /** The trail: `trailX1` is now, `trailX0` the window ago. */
  trailX0: number; trailX1: number;
}

/** `RULER_H`: the age ruler's strip, its line and 4 px marks, then a line of 10 px text with room under it (18 px ran the words into the
 * canvas's bottom edge, against the phone's tab bar; Karl, 2026-11-13). */
export const AXIS_W = 46, RAIL_W = 30, MARGIN = 6, GAP = 4, RULER_H = 24, RULER_TEXT_Y = 15;

/**
 * Split a `w` x `h` view. The candle takes about three tenths of the width (96 to 140 px: two footprint numbers a row and their bars), the
 * book's two sides share what is left between the margin and the rail, and the trail spans everything left of the rail.
 */
export function candleLayout(w: number, h: number): CandleLayout {
  const axisX1 = w, axisX0 = w - AXIS_W, railX1 = axisX0, railX0 = railX1 - RAIL_W;
  const room = Math.max(0, railX0 - MARGIN);
  const candleW = Math.round(Math.max(96, Math.min(140, w * 0.3, room - 2 * GAP - 40)));
  const side = Math.max(20, Math.floor((room - candleW - 2 * GAP) / 2));
  const bidX0 = MARGIN, bidX1 = bidX0 + side, candleX0 = bidX1 + GAP, candleX1 = candleX0 + candleW, askX0 = candleX1 + GAP, askX1 = Math.min(railX0 - 2, askX0 + side);
  return { w, h, plotY0: 8, plotY1: Math.max(9, h - RULER_H), bidX0, bidX1, candleX0, candleX1, askX0, askX1, railX0, railX1, axisX0, axisX1, trailX0: 0, trailX1: railX0 };
}

/** The prices on screen: `p1` at `y0` (the top), `p0` at `y1`. */
export interface PriceScale { p0: number; p1: number; y0: number; y1: number }
export const yOf = (s: PriceScale, price: number): number => s.y0 + (s.p1 - price) / (s.p1 - s.p0) * (s.y1 - s.y0);
export const priceAt = (s: PriceScale, y: number): number => s.p1 - (y - s.y0) / (s.y1 - s.y0) * (s.p1 - s.p0);

/** The smallest span of prices shown, as a share of the price: a quiet bar is not blown up until its four ticks fill the screen. */
export const MIN_SPAN = 0.0012;

/**
 * Which prices to show for a candle from `lo` to `hi` with the price at `mark`: the candle and a third again, at least `MIN_SPAN` of the
 * price, times `zoom` (a pinch: above 1 shows more), moved by `pan` (price units) and then back far enough that the price stays inside the
 * middle four fifths, so the live edge is never off screen.
 */
export function priceSpan(lo: number, hi: number, mark: number, y0: number, y1: number, zoom = 1, pan = 0): PriceScale {
  const ref = mark > 0 ? mark : (lo + hi) / 2;
  const low = Math.min(lo > 0 ? lo : ref, ref), high = Math.max(hi > 0 ? hi : ref, ref);
  const span = Math.max((high - low) * 1.35, ref * MIN_SPAN) * Math.max(0.05, zoom);
  let mid = (low + high) / 2 + pan;
  const inner = span * 0.4;
  if (ref > mid + inner) mid = ref - inner; else if (ref < mid - inner) mid = ref + inner;
  return { p0: mid - span / 2, p1: mid + span / 2, y0, y1 };
}

/** The footprint row step for the screen: the finest recorded step doubled until a row is at least `minPx` tall. 0 before the step is known. */
export function rowStepFor(fine: number, scale: PriceScale, minPx = 16): number {
  if (!(fine > 0)) return 0;
  const pxPerPrice = (scale.y1 - scale.y0) / (scale.p1 - scale.p0);
  let step = fine;
  for (let i = 0; i < 40 && step * pxPerPrice < minPx; i++) step *= 2;
  return step;
}

/**
 * One order as the rail reads it: its price, signed USD (a buy positive), when it arrived (the page's clock, ms) and its market (the ring's
 * index); and how far under its true price the price may read (`ringSlack`, none when it is exact).
 */
export interface Arrival { price: number; usd: number; at: number; inst: number; slack?: number }

/**
 * How far under its true price a price the tape ring holds may read: the ring keeps it as a float32 offset from its base, rounded by at most
 * half a unit in its last place, so twice that is forgiven when it is put in a row (shared/footprint.ts `binOf`).
 */
export const ringSlack = (offset: number): number => Math.abs(offset) * 2 ** -23;

/** What arrived at one row of the rail over a stretch: bought and sold USD, how many orders, the largest and its market, and the newest arrival. */
export interface RailCell { bin: number; buy: number; sell: number; count: number; largest: number; largestInst: number; at: number }

/** Add up the arrivals in [from, to] by row (`step` wide, the tape's own rule for a price on a row's edge), busiest row first. */
export function railCells(orders: readonly Arrival[], step: number, from: number, to: number): RailCell[] {
  if (!(step > 0)) return [];
  const cells = new Map<number, RailCell>();
  for (const o of orders) {
    if (!(o.at >= from && o.at <= to) || !(o.price > 0) || !Number.isFinite(o.usd) || o.usd === 0) continue;
    const bin = binOf(o.price, step, o.slack ?? 0);
    let c = cells.get(bin); if (!c) { c = { bin, buy: 0, sell: 0, count: 0, largest: 0, largestInst: o.inst, at: o.at }; cells.set(bin, c); }
    const usd = Math.abs(o.usd);
    if (o.usd > 0) c.buy += usd; else c.sell += usd;
    c.count++; if (usd > c.largest) { c.largest = usd; c.largestInst = o.inst; } c.at = Math.max(c.at, o.at);
  }
  return [...cells.values()].sort((a, b) => (b.buy + b.sell) - (a.buy + a.sell));
}

/**
 * How long a flash takes to fade (ms), how long the mark of its exchange stays beside it, and the most lit at once (more than a handful at
 * once reads as noise, not as the large ones). A flashbulb's envelope: at full strength on arrival, falling off fast, then a short tail.
 */
export const FLASH_MS = 420, FLASH_MARK_MS = 1_200, MAX_FLASHES = 8;
export const flashStrength = (age: number): number => age < 0 || age >= FLASH_MS ? 0 : (1 - age / FLASH_MS) ** 1.6;

/**
 * The rows that flash now, from the arrivals of at least `minUsd` alone: a small order arriving later in a row must not light a large one's
 * flash again (nor date its exchange mark). Largest first, at most `max`, each with how lit it is (1 to 0) by its own arrival.
 */
export function flashes(orders: readonly Arrival[], step: number, minUsd: number, now: number, max = MAX_FLASHES): (RailCell & { k: number })[] {
  const cells = railCells(orders.filter(o => Math.abs(o.usd) >= minUsd), step, now - FLASH_MS, now);
  return cells.filter(c => now - c.at >= 0 && now - c.at < FLASH_MS)
    .sort((a, b) => b.largest - a.largest).slice(0, max)
    .map(c => ({ ...c, k: flashStrength(now - c.at) }));
}

/** A flash's radius (CSS px) for its largest order: `r0` at `lo` USD and below, `r1` at `hi` and above, logarithmic between. */
export function flashRadius(usd: number, lo: number, hi: number, r0 = 3, r1 = 9): number {
  if (!(usd > lo)) return r0;
  if (usd >= hi) return r1;
  return r0 + (r1 - r0) * Math.log(usd / lo) / Math.log(hi / lo);
}

/** The age ruler's marks: now at the right, then every quarter of the window, with how long ago each is in seconds. */
export function ageTicks(trailMs: number): { ms: number; seconds: number }[] {
  const out: { ms: number; seconds: number }[] = [];
  for (let i = 0; i <= 4; i++) out.push({ ms: trailMs * i / 4, seconds: Math.round(trailMs * i / 4000) });
  return out;
}

/** The x of an order `age` ms old on the trail (clamped to its ends). */
export const trailX = (l: Pick<CandleLayout, 'trailX0' | 'trailX1'>, age: number, trailMs: number): number => l.trailX1 - Math.max(0, Math.min(1, age / trailMs)) * (l.trailX1 - l.trailX0);

/** The time left in a bar as "m:ss" (or "h:mm:ss"). */
export function countdownText(ms: number): string {
  const s = Math.max(0, Math.ceil(ms / 1000)), h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  const two = (n: number): string => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${two(m)}:${two(sec)}` : `${m}:${two(sec)}`;
}

/**
 * How far behind the coverage answer's own time a market may stop and still count as covered up to it: the loop's beat and the answer's
 * trip from the recorder (the open stretch is extended on each pass, four a second).
 */
export const COVER_SLACK_MS = 1_500;

/**
 * The markets of `markets` whose trades were recorded without a break, live or recovered from the venue's history, from the bar's open
 * (`barT`) to the coverage answer's time: only these are judged (shared/coverage.ts). A market the answer does not name, an answer from
 * before the bar opened or one that does not reach back to it counts none, and so does no answer (a source that cannot say).
 */
export function coveredMarkets(answer: CoverageAnswer | null, markets: readonly string[], barT: number): Set<string> {
  const out = new Set<string>();
  if (!answer || answer.metric !== 'trades' || !(answer.asOf > barT) || answer.from > barT) return out;
  const end = Math.max(barT + 1, answer.asOf - COVER_SLACK_MS);
  for (const i of answer.instruments) if (markets.includes(i.id) && coversAll(i.spans, barT, end)) out.add(i.id);
  return out;
}

/** A footprint row split by coverage: what the fully covered markets bought and sold (judged), and what the others did (observed only). */
export interface RowSplit { buy: number; sell: number; partBuy: number; partSell: number }
/**
 * Split a row of `buy` and `sell` by its markets' parts (`parts`, with several markets added together): the covered markets' USD, and the
 * rest. A row of one market is all its own; a row of several without parts (an older answer) cannot be put to a market, so none of it is judged.
 */
export function splitRow(buy: number, sell: number, parts: readonly (readonly [string, number, number])[] | undefined, covered: ReadonlySet<string>, markets: readonly string[]): RowSplit {
  if (parts) {
    let b = 0, s = 0;
    for (const [id, pb, ps] of parts) if (covered.has(id)) { b += pb; s += ps; }
    const rest = (all: number, part: number): number => all - part > all * 1e-9 ? all - part : 0;
    return { buy: b, sell: s, partBuy: rest(buy, b), partSell: rest(sell, s) };
  }
  return markets.length === 1 && covered.has(markets[0]!) ? { buy, sell, partBuy: 0, partSell: 0 } : { buy: 0, sell: 0, partBuy: buy, partSell: sell };
}

/** How one-sided a row is: -1 all of it sold at market, +1 all of it bought, 0 even (or nothing). */
export const rowLean = (buy: number, sell: number): number => buy + sell > 0 ? (buy - sell) / (buy + sell) : 0;

/**
 * How strongly a row's winning side is shown, each from 0 to 1 and continuous: `lean` from how one-sided the row is (eased, |lean|^0.6, so a
 * clear lean shows before it is total), `net` from how much more the winner traded than the loser against the most any row of the bar did
 * (`maxNet`), eased the same way so the strongest levels stand out at a glance while a small one still reads.
 */
export function rowEmphasis(buy: number, sell: number, maxNet: number): { side: 'buy' | 'sell' | null; lean: number; net: number } {
  const l = rowLean(buy, sell), net = Math.abs(buy - sell);
  return { side: l > 0 ? 'buy' : l < 0 ? 'sell' : null, lean: Math.abs(l) ** 0.6, net: maxNet > 0 ? Math.min(1, net / maxNet) ** 0.6 : 0 };
}

/** The row with the most volume (bought and sold together), or -1: the footprint's point of control. */
export function pocIndex(rows: readonly (readonly [number, number, number])[]): number {
  let best = -1, most = 0;
  rows.forEach((r, i) => { const v = r[1] + r[2]; if (v > most) { most = v; best = i; } });
  return best;
}

/** One row of one side's change worth a cue: its sign (+1 added, -1 removed), strength (0 to 1), when it began and whether trades reached it. */
export interface Pulse { sign: 1 | -1; strength: number; at: number; traded: boolean; /** The row's USD before the change. */ before: number }

/** The change is measured over this window; the noise it is held against forgets with this half-life; a pulse is gone after `PULSE_LIFE_MS`. */
export const PULSE_WINDOW_MS = 1_000, PULSE_NOISE_HALF_LIFE_MS = 20_000, PULSE_LIFE_MS = 1_500, PULSE_ATTACK_MS = 80, PULSE_RELEASE_MS = 450;

/**
 * The resting liquidity added and pulled per row, for the glass book's cues (Astra's rules, 2026-10-16). Each levels frame gives every row's
 * resting USD (keyed by side and absolute price bin at one row step: a new step starts the tracker again, `reset`). A row's change is its USD
 * now less its USD a window ago, so a venue re-quoting within the window cancels out instead of flashing twice. It earns a cue only past
 * `T = max(floor, 6 % of the side's mean row, 3 x the side's recent noise)` (the noise a running mean of the changes, outliers clipped), with
 * `strength = 1 - exp(-(|change| / T - 1))`, and below three times T only when the next frame agrees on its sign. A removal at a row the
 * inside market passed in the window, with no trade there to say so, is not called a pull (it may have traded on a venue the tape does not
 * hold): nothing is shown. A row a matching trade reached is marked `traded` when its change earns a cue. A pulse of the same sign within
 * its release is extended, not started again. A change is read once: the row's history starts again from the frame that showed it, so one
 * step in the book is one flash, not a flash renewed on every frame of the window. Frames more than two windows apart (the view hidden, the
 * page in the background, a feed that stalled) share no history: what changed meanwhile is not shown as if it had just happened.
 */
export class PulseTracker {
  #hist = new Map<string, { t: number; usd: number }[]>();
  #noise: Record<'bid' | 'ask', number> = { bid: 0, ask: 0 };
  #noiseAt = 0;
  #pending = new Map<string, 1 | -1>();
  #lastT = -Infinity;
  readonly pulses = new Map<string, Pulse>();

  reset(): void { this.#hist.clear(); this.#pending.clear(); this.pulses.clear(); this.#noise = { bid: 0, ask: 0 }; this.#noiseAt = 0; this.#lastT = -Infinity; }

  /** The side's noise now (for a test or a look from the console). */
  noise(side: 'bid' | 'ask'): number { return this.#noise[side]; }

  frame(t: number, rows: ReadonlyMap<string, { side: 'bid' | 'ask'; usd: number }>, traded: ReadonlySet<string>, touched: ReadonlySet<string>, floor: number): void {
    if (t - this.#lastT > 2 * PULSE_WINDOW_MS) { this.#hist.clear(); this.#pending.clear(); }
    this.#lastT = t;
    const mean: Record<'bid' | 'ask', number> = { bid: 0, ask: 0 }, count = { bid: 0, ask: 0 };
    for (const r of rows.values()) if (r.usd > 0) { mean[r.side] += r.usd; count[r.side]++; }
    for (const side of ['bid', 'ask'] as const) mean[side] = count[side] ? mean[side] / count[side] : 0;
    const decay = this.#noiseAt ? 1 - 2 ** (-(t - this.#noiseAt) / PULSE_NOISE_HALF_LIFE_MS) : 1;
    this.#noiseAt = t;
    const samples: Record<'bid' | 'ask', number[]> = { bid: [], ask: [] };
    for (const [key, r] of rows) {
      let hist = this.#hist.get(key);
      if (!hist) { hist = []; this.#hist.set(key, hist); }
      hist.push({ t, usd: r.usd });
      while (hist.length > 1 && hist[1]!.t <= t - PULSE_WINDOW_MS) hist.shift();
      if (hist.length < 2) continue;
      const change = r.usd - hist[0]!.usd, size = Math.abs(change);
      samples[r.side].push(size);
      const T = Math.max(floor, 0.06 * mean[r.side], 3 * this.#noise[r.side]);
      if (!(T > 0)) continue;
      const ratio = size / T, strength = 1 - Math.exp(-Math.max(0, ratio - 1)), sign: 1 | -1 = change > 0 ? 1 : -1;
      if (strength <= 0) { this.#pending.delete(key); continue; }
      if (ratio < 3 && this.#pending.get(key) !== sign) { this.#pending.set(key, sign); continue; }
      this.#pending.delete(key);
      const isTraded = traded.has(key);
      if (sign < 0 && !isTraded && touched.has(key)) continue;
      const old = this.pulses.get(key);
      if (old && old.sign === sign && t - old.at < PULSE_ATTACK_MS + PULSE_RELEASE_MS) {
        old.strength = Math.max(old.strength, strength); old.at = Math.max(old.at, t - PULSE_ATTACK_MS); old.traded ||= isTraded;
      } else this.pulses.set(key, { sign, strength, at: t, traded: isTraded, before: hist[0]!.usd });
      // Shown: the row is compared from here on, so the same step is not shown again on the next frames of the window.
      hist.splice(0, hist.length - 1);
    }
    // Rows gone from view (a pan, a zoom) are forgotten, not read as pulled: only rows in both frames are compared.
    for (const key of this.#hist.keys()) if (!rows.has(key)) { this.#hist.delete(key); this.#pending.delete(key); }
    for (const side of ['bid', 'ask'] as const) {
      const xs = samples[side]; if (!xs.length) continue;
      const cap = this.#noise[side] > 0 ? 5 * this.#noise[side] : Infinity;
      const m = xs.reduce((a, x) => a + Math.min(x, cap), 0) / xs.length;
      this.#noise[side] += (m - this.#noise[side]) * decay;
    }
    for (const [key, p] of this.pulses) if (t - p.at > PULSE_LIFE_MS) this.pulses.delete(key);
  }
}

/** A pulse's envelope at `age` ms: rising over the attack, then fading over the release (0 to 1). */
export function pulseEnvelope(age: number): number {
  if (age < 0 || age > PULSE_LIFE_MS) return 0;
  return age < PULSE_ATTACK_MS ? age / PULSE_ATTACK_MS : Math.exp(-2.2 * (age - PULSE_ATTACK_MS) / PULSE_RELEASE_MS);
}

/**
 * The most bins the tape holds for one market. Past it, every bin is made twice as wide (neighbours merged), so a tape open for days on a
 * moving market keeps a bounded size. The Tape's rows never come finer than that: the view always shows the prices the tape traded at,
 * a pinch stops at five times in, and a row is at least 16 px, so a row is at least a 460th of those prices on a plot 2,000 px tall, while
 * the bins are at most a 2,048th of them.
 */
export const TAPE_BINS = 4096;

/** The rows of one step and set of markets, kept up to date as orders come (`add`), and the list made from them (null once an order changed them). */
interface TapeRows { key: string; ratio: number; markets: ReadonlySet<string> | null; base: number; sums: Float64Array; list: [number, number, number][] | null }

/**
 * The Tape (Karl, 2026-10-17): every market order the page has seen since it opened, never fetched and never reset, so the view opens at
 * once and runs on without a bar's reset. Kept per market and price at a fine step (a tenth of the price grid's, shared/grid.ts), so the
 * view's markets are chosen when it is drawn and its rows grouped at any step that is the fine one doubled; a price on a bin's edge goes
 * where the map's footprint puts it (shared/footprint.ts `binOf`). The bins of all markets are one stretch of at most TAPE_BINS, doubled
 * in width when the prices outgrow it. The rows last asked for are kept and each new order is added to them, so a paint while orders
 * flow does not add every bin up again. A page that was hidden or in the background got no orders meanwhile: what it covers is from
 * `since`, less the gaps the caller reports (`TapeGaps`).
 */
export class TapeTally {
  /** When the tape began (the page's clock, ms), and the price step it counts at (set by its first order). */
  readonly since: number;
  fine = 0;
  /** How many fine steps a bin is wide now: 1, doubled each time the prices outgrow TAPE_BINS bins. */
  #factor = 1;
  /** Per market, bought and sold USD per bin, interleaved: bin `#base + i` at 2i and 2i + 1, `#cap` bins, the same bins for every market. */
  #markets = new Map<string, Float64Array>();
  #base = 0; #cap = 0;
  /** The lowest and highest bin an order is in. */
  #binLo = Infinity; #binHi = -Infinity;
  #lo = Infinity; #hi = -Infinity; #count = 0; #first = 0;
  #cache: TapeRows | null = null;

  constructor(since: number) { this.since = since; }

  /**
   * One order: its market, price and signed USD (a buy positive), and how far under its true price the price may read (`ringSlack`, for a
   * price from the tape ring).
   */
  add(market: string, price: number, usd: number, slack = 0): void {
    if (!(price > 0) || !Number.isFinite(usd) || usd === 0) return;
    if (!(this.fine > 0)) this.fine = gridStepFor(price) / 10;
    const fineBin = binOf(price, this.fine, slack);
    let bin = Math.floor(fineBin / this.#factor);
    while (Math.max(this.#binHi, bin) - Math.min(this.#binLo, bin) + 1 > TAPE_BINS) { this.#widen(); bin = Math.floor(fineBin / this.#factor); }
    if (bin < this.#base || bin >= this.#base + this.#cap) this.#place(Math.min(this.#binLo, bin), Math.max(this.#binHi, bin));
    if (bin < this.#binLo) this.#binLo = bin;
    if (bin > this.#binHi) this.#binHi = bin;
    let m = this.#markets.get(market); if (!m) { m = new Float64Array(2 * this.#cap); this.#markets.set(market, m); }
    const at = 2 * (bin - this.#base);
    if (usd > 0) m[at]! += usd; else m[at + 1]! -= usd;
    if (!this.#count) this.#first = price;
    if (price < this.#lo) this.#lo = price;
    if (price > this.#hi) this.#hi = price;
    this.#count++;
    const c = this.#cache;
    if (c && (!c.markets || c.markets.has(market))) {
      const row = 2 * (Math.floor(bin * this.#factor / c.ratio) - c.base);
      if (row >= 0 && row < c.sums.length) { if (usd > 0) c.sums[row]! += usd; else c.sums[row + 1]! -= usd; c.list = null; }
      else this.#cache = null;
    }
  }

  /** How many orders it holds, and the lowest and highest price they traded at (null before the first). */
  get count(): number { return this.#count; }
  get range(): { lo: number; hi: number } | null { return this.#count ? { lo: this.#lo, hi: this.#hi } : null; }
  /** The price of the first order (0 before it): where the tape opened. */
  get first(): number { return this.#first; }
  /** How wide a bin is now (the fine step, doubled as the prices traded spread), and how many bins each market holds (at most TAPE_BINS). */
  get binWidth(): number { return this.fine * this.#factor; }
  get held(): number { return this.#cap; }

  /**
   * The rows at `step` (the fine step doubled some times; a step that is not is used as it is) for `markets` (null: every one), lowest
   * first: [the row's low price, bought USD, sold USD]. A step finer than the bins puts each bin's orders in the row of its low price.
   */
  rows(step: number, markets: readonly string[] | null): readonly [number, number, number][] {
    if (!(this.fine > 0) || !(step > 0) || !this.#count) return [];
    const ratio = Math.max(1, Math.round(step / this.fine)), key = `${ratio}|${markets ? markets.join(',') : '*'}`;
    let c = this.#cache;
    if (c?.key !== key) c = this.#cache = this.#group(key, ratio, markets);
    if (!c.list) {
      const list: [number, number, number][] = [];
      for (let i = 0; i < c.sums.length; i += 2) { const buy = c.sums[i]!, sell = c.sums[i + 1]!; if (buy + sell > 0) list.push([(c.base + i / 2) * ratio * this.fine, buy, sell]); }
      c.list = list;
    }
    return c.list;
  }

  /** Add the bins up into rows of `ratio` fine steps, over every bin the arrays hold (so an order there is added to them as it comes). */
  #group(key: string, ratio: number, markets: readonly string[] | null): TapeRows {
    const f = this.#factor, base = Math.floor(this.#base * f / ratio), top = Math.floor((this.#base + this.#cap - 1) * f / ratio);
    const set = markets ? new Set(markets) : null, sums = new Float64Array(2 * Math.max(1, top - base + 1));
    for (const [market, m] of this.#markets) {
      if (set && !set.has(market)) continue;
      for (let bin = this.#binLo; bin <= this.#binHi; bin++) {
        const at = 2 * (bin - this.#base), buy = m[at]!, sell = m[at + 1]!;
        if (buy === 0 && sell === 0) continue;
        const row = 2 * (Math.floor(bin * f / ratio) - base);
        sums[row]! += buy; sums[row + 1]! += sell;
      }
    }
    return { key, ratio, markets: set, base, sums, list: null };
  }

  /** Make the arrays hold the bins from `lo` to `hi` (at most TAPE_BINS), with room to spare on both sides, every market's moved with them. */
  #place(lo: number, hi: number): void {
    const need = hi - lo + 1, cap = Math.min(TAPE_BINS, Math.max(64, 2 * need)), base = lo - Math.floor((cap - need) / 2);
    for (const [market, m] of this.#markets) {
      const next = new Float64Array(2 * cap);
      if (this.#binLo <= this.#binHi) next.set(m.subarray(2 * (this.#binLo - this.#base), 2 * (this.#binHi - this.#base + 1)), 2 * (this.#binLo - base));
      this.#markets.set(market, next);
    }
    this.#base = base; this.#cap = cap;
  }

  /** Every bin twice as wide: neighbours merged on the same grid, so rows of any step from the new width up are what they were. */
  #widen(): void {
    const lo = Math.floor(this.#binLo / 2), hi = Math.floor(this.#binHi / 2), cap = this.#cap, base = lo - Math.floor((cap - (hi - lo + 1)) / 2);
    for (const [market, m] of this.#markets) {
      const next = new Float64Array(2 * cap);
      for (let bin = this.#binLo; bin <= this.#binHi; bin++) {
        const from = 2 * (bin - this.#base), to = 2 * (Math.floor(bin / 2) - base);
        next[to]! += m[from]!; next[to + 1]! += m[from + 1]!;
      }
      this.#markets.set(market, next);
    }
    this.#factor *= 2; this.#base = base; this.#binLo = lo; this.#binHi = hi; this.#cache = null;
  }
}

/** A stretch with no orders arriving while the page was hidden is a gap in the tape past this (a shorter one is a phone's screen blinking). */
export const TAPE_GAP_MS = 5_000;

/**
 * How long the tape missed while the page was hidden. A phone suspends a page in the background and no orders come, but a desktop window
 * (a narrow one gets the phone's arrangement) goes on receiving them hidden, so being hidden does not say it: what counts is the time the
 * page was hidden inside a stretch of more than TAPE_GAP_MS with no orders arriving, counted when orders come again. A page that opens
 * hidden is hidden from its start.
 */
export class TapeGaps {
  /** What was missed so far (ms). */
  missedMs = 0;
  #arrived: number; #hiddenAt: number | null; #hiddenMs = 0;

  constructor(now: number, hidden: boolean) { this.#arrived = now; this.#hiddenAt = hidden ? now : null; }

  hide(now: number): void { if (this.#hiddenAt === null) this.#hiddenAt = now; }
  show(now: number): void {
    if (this.#hiddenAt === null) return;
    this.#hiddenMs += Math.max(0, now - Math.max(this.#hiddenAt, this.#arrived)); this.#hiddenAt = null;
  }
  /** Orders came in at `now`. */
  arrived(now: number): void {
    const hidden = this.#hiddenMs + (this.#hiddenAt === null ? 0 : Math.max(0, now - Math.max(this.#hiddenAt, this.#arrived)));
    if (now - this.#arrived > TAPE_GAP_MS && hidden > TAPE_GAP_MS) this.missedMs += hidden;
    this.#arrived = now; this.#hiddenMs = 0;
  }
}
