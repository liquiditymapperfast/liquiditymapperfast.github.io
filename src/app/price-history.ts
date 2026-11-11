import { TIMEFRAMES } from '../shared/series.ts';
import { PRICE_QUERY_BARS, PRICE_TIMEFRAMES, parsePriceHistory, type PriceHistoryAnswer, type PriceTarget } from '../shared/price-history.ts';
import type { CandleRow } from './store.ts';

export interface PriceWindow { tf: string; tfMs: number; from: number; to: number }
type Window = { t0: number; t1: number };
export type PriceReader = (id: string, tf: string, from: number, to: number, signal: AbortSignal) => Promise<PriceHistoryAnswer>;
const MINUTE = 60_000, DAY = 86_400_000;
const priceKey = (target: PriceTarget, tfMs: number): string => `${target.id}|${target.listing.symbol}|${target.listing.unit}|${tfMs}`;

/**
 * The overview is needed where the chart's own candles leave a part of the visible price history missing: it is drawn only there (the
 * line is cut at the candles, `uncoveredRuns`), so a view the candles cover whole, compressed to a smear or not, needs none and asks for none.
 */
export function priceOverviewNeeded(candles: readonly CandleRow[], tfMs: number, view: Window, width: number, now: number): boolean {
  const to = Math.min(view.t1, now), from = Math.max(0, view.t0);
  if (!(width > 0 && to > from && tfMs > 0)) return false;
  let end = Math.floor(from / tfMs) * tfMs;
  for (const c of candles) {
    if (c[0] + tfMs <= end) continue;
    if (c[0] > end) return true;
    end = c[0] + tfMs;
    if (end >= to) return false;
  }
  return true;
}

/** The lowest low and the highest high of the candles that touch [t0, t1), or null where there are none or they are flat: what a fit to the chart's own candles takes. */
export function candlePriceRange(candles: readonly CandleRow[], tfMs: number, t0: number, t1: number): { lo: number; hi: number } | null {
  let lo = Infinity, hi = -Infinity;
  for (const c of candles) if (c[0] + tfMs > t0 && c[0] < t1) { lo = Math.min(lo, c[3]); hi = Math.max(hi, c[2]); }
  return hi > lo ? { lo, hi } : null;
}

/**
 * The chart's own candles wherever one read holds the window (Karl, 2026-10-28: history is drawn as candles, as the recorded ones are);
 * past that a line: the finest native bars that keep it to a few hundred points across the map (never finer than the selected candles,
 * retaining a resolution near its changeover), days where even days are more (up to the 2,000 one read holds: a view a year wide draws a few
 * hundred, one just short of the weeks about 1,700), and weeks past what one read of days holds.
 */
export function priceWindow(view: Window, width: number, now: number, previousMs = 0, chartMs = 0, warmBars = 0, candleMs = 0): PriceWindow | null {
  const span = view.t1 - view.t0;
  if (!(span > 0 && width > 0 && Number.isFinite(span) && view.t0 < now)) return null;
  const own = Object.entries(TIMEFRAMES).find(([, ms]) => ms === chartMs);
  if (own) {
    const from = Math.max(0, Math.floor((view.t0 - span * 0.15) / chartMs) * chartMs - chartMs), to = Math.ceil(Math.min(view.t1 + span * 0.15, now + 1) / chartMs) * chartMs;
    // `warmBars` more before it (what the scripts read before the left edge, `SCRIPT_WARM_BARS`), as many as the read's ceiling leaves: the
    // warm-up gives way first, so a view that is drawn as its own candles stays so (one bar over the ceiling and it would be a coarser line).
    if (to > from && to - from <= PRICE_QUERY_BARS * chartMs) return { tf: own[0], tfMs: chartMs, from: Math.max(0, to - PRICE_QUERY_BARS * chartMs, from - Math.max(0, Math.floor(warmBars)) * chartMs), to };
  }
  // Candles drawn longer than the chart's while zoomed out (`candleMs`, heat-pane `drawnTf`: the chart's own would be narrower than
  // CANDLE_LINE_PX): the exchange's candles of that length wherever one read holds the window, so the candles before the chart's own are as long
  // as the chart's added up (a user, 2026-11-11: candles on higher zoom outs). Past that, the line's own choice below, drawn as candles too.
  const longer = Object.entries(TIMEFRAMES).find(([, ms]) => ms === candleMs && ms > chartMs);
  if (longer) {
    const from = Math.max(0, Math.floor((view.t0 - span * 0.15) / candleMs) * candleMs - candleMs), to = Math.ceil(Math.min(view.t1 + span * 0.15, now + 1) / candleMs) * candleMs;
    if (to > from && to - from <= PRICE_QUERY_BARS * candleMs) return { tf: longer[0], tfMs: candleMs, from, to };
  }
  const budget = Math.max(100, Math.min(400, Math.floor(width / 4)));
  const minimum = Math.max(chartMs, span >= 30 * DAY ? DAY : 0);
  const intervals = Object.entries(TIMEFRAMES), previous = intervals.find(([, ms]) => ms === previousMs && ms >= minimum);
  let choice = intervals.find(([, ms]) => ms >= minimum && span / ms <= budget) ?? intervals[intervals.length - 1]!;
  if (previous && span / previousMs >= budget / 5 && span / previousMs <= budget * 1.15) choice = previous;
  let [tf, tfMs] = choice;
  const edges = (ms: number): [number, number] => [Math.max(0, Math.floor((view.t0 - span * 0.15) / ms) * ms - ms), Math.ceil(Math.min(view.t1 + span * 0.15, now + 1) / ms) * ms];
  let [from, to] = edges(tfMs);
  // Where one read of days cannot hold the window (2,000 of them, its padding of 15 % of the view's width either side included: about four and a
  // half to five years of view, less where it all lies in the past), weeks: the window was refused and the view drew no line and named none (Karl,
  // 2026-11-07). A right-button drag or a touch drag on the time strip has no widest span (the wheel, the keys and a pinch stop at 400 days), so the
  // coarsest is bounded by its newest bars and a view zoomed out over decades still gets the line (BTC's history is a few hundred weeks).
  for (const [name, ms] of Object.entries(PRICE_TIMEFRAMES)) if (ms > tfMs && to - from > PRICE_QUERY_BARS * tfMs) { tf = name; tfMs = ms; [from, to] = edges(ms); }
  from = Math.max(from, to - PRICE_QUERY_BARS * tfMs);
  return to > from ? { tf, tfMs, from, to } : null;
}

/**
 * The chart's one active overview. A short gesture delay coalesces requests; the newest view is remembered while a read is out. Old
 * points stay drawn through range/resolution changes, carrying their own interval. Another instrument cancels and clears them, and so does
 * a view that now needs another resolution: the read in flight is for a window the zoom has left, and the view waited behind it (a zoom out
 * passes through several resolutions, each read taking its turn: 2026-10-24).
 */
export class ChartPriceHistory {
  answer: PriceHistoryAnswer | null = null;
  status: 'idle' | 'loading' | PriceHistoryAnswer['status'] = 'idle';
  version = 0;
  readonly #cached = new Map<string, { answer: PriceHistoryAnswer; landedAt: number }>();
  #id = ''; #generation = 0; #pending = false; #retryAt = 0; #landedAt = 0;
  /** The resolution of the read in flight, and whether it was dropped for another (its answer, if it comes, is not taken). */
  #readTfMs = 0; #dropped = false;
  #timer: ReturnType<typeof setTimeout> | null = null;
  #controller: AbortController | null = null;
  #wanted: { target: PriceTarget; window: PriceWindow; changed: () => void } | null = null;
  constructor(private read: PriceReader, private now: () => number = Date.now, private delayMs = 120) {}

  ensure(target: PriceTarget, window: PriceWindow, changed: () => void): void {
    if (priceKey(target, 0) !== this.#id) {
      this.stop(); this.#controller?.abort(); this.#controller = null; this.#generation++;
      this.#pending = false; this.#id = priceKey(target, 0); this.answer = null; this.status = 'idle'; this.#retryAt = 0; this.version++;
    }
    this.#wanted = { target, window, changed };
    if (this.#pending && this.#readTfMs !== window.tfMs && !this.#dropped && this.#controller) { this.#dropped = true; this.#controller.abort(); }
    // Eight recent instrument/resolution windows survive zooms and coin switches. Recheck live tails before reusing them.
    const key = priceKey(target, window.tfMs), cached = this.#cached.get(key);
    if (!this.#pending && !this.#covers(window) && cached && this.#covers(window, cached.answer, cached.landedAt)) {
      this.answer = cached.answer; this.status = cached.answer.status; this.#landedAt = cached.landedAt; this.#retryAt = 0; this.version++;
      this.#cached.delete(key); this.#cached.set(key, cached); changed();
    }
    if (this.#pending || this.#timer !== null || this.now() < this.#retryAt || this.#covers(window)) return;
    this.#timer = setTimeout(() => { this.#timer = null; void this.#load(); }, this.delayMs);
  }

  /** A hidden chart or a disabled candle layer starts no further reads; a bounded read already out may finish. */
  stop(): void { if (this.#timer !== null) clearTimeout(this.#timer); this.#timer = null; this.#wanted = null; }

  #covers(w: PriceWindow, a = this.answer, landedAt = this.#landedAt): boolean {
    if (!a || a.tfMs !== w.tfMs || a.from > w.from || a.to < w.to || a.status === 'stale' || a.status === 'failed') return false;
    const last = a.candles[a.candles.length - 1], partialClosed = last && last[0] + a.tfMs > a.asOf && last[0] + a.tfMs <= this.now();
    return !partialClosed && (w.to <= this.now() || this.now() - landedAt < MINUTE);
  }

  async #load(): Promise<void> {
    const wanted = this.#wanted; if (!wanted || this.#pending || this.now() < this.#retryAt || this.#covers(wanted.window)) return;
    const { target, window: w, changed } = wanted, generation = this.#generation, controller = new AbortController();
    this.#controller = controller; this.#pending = true; this.#readTfMs = w.tfMs; this.#dropped = false;
    if (!this.answer?.candles.length) this.status = 'loading';
    changed();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const deadline = new Promise<never>((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(new Error('Price history timed out')); }, 25_000); });
      // A read dropped for another resolution ends the wait at once (a source that cannot be cancelled goes on and keeps its answer for later).
      const dropped = new Promise<never>((_, reject) => controller.signal.addEventListener('abort', () => reject(new Error('Price history dropped')), { once: true }));
      dropped.catch(() => undefined);
      const a = parsePriceHistory(await Promise.race([this.read(target.id, w.tf, w.from, w.to, controller.signal), deadline, dropped]), target.id, w.tfMs);
      if (generation !== this.#generation) return;
      if (a.from > w.from || a.to < w.to) throw new Error('Incomplete price history window');
      if ((a.status === 'failed' || a.status === 'stale') && this.answer?.candles.length && !a.candles.length) {
        this.status = 'stale'; this.#retryAt = this.now() + MINUTE;
      } else {
        this.answer = a; this.status = a.status; this.#landedAt = this.now();
        if (a.status === 'ok' || a.status === 'empty') {
          const key = priceKey(target, w.tfMs);
          this.#cached.delete(key); this.#cached.set(key, { answer: a, landedAt: this.#landedAt });
          while (this.#cached.size > 8) this.#cached.delete(this.#cached.keys().next().value!);
        }
        this.#retryAt = a.status === 'failed' || a.status === 'stale' ? this.now() + MINUTE : 0;
      }
      this.version++;
    } catch {
      if (generation !== this.#generation) return;
      // Dropped for another resolution: not a failure, and the next read (the finally below) is the view's own, with no cool-down.
      if (this.#dropped) { if (!this.answer?.candles.length) this.status = 'idle'; return; }
      this.status = this.answer?.candles.length ? 'stale' : 'failed'; this.#retryAt = this.now() + MINUTE; this.version++;
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      if (generation === this.#generation) {
        this.#pending = false; this.#controller = null; changed();
        const next = this.#wanted; if (next) this.ensure(next.target, next.window, next.changed);
      }
    }
  }
}

export interface PricePoint { t: number; price: number; start: number }

/** A Go to fit waits for its whole visible range; retained overlap is useful for drawing but cannot set the new scale. */
export function priceBounds(answer: PriceHistoryAnswer | null, id: string, view: Window, at: number, replay: boolean): { lo: number; hi: number } | null {
  const from = Math.max(0, view.t0), to = Math.min(view.t1, at);
  if (!answer || answer.instrumentId !== id || answer.status !== 'ok' || !(to > from) || answer.from > from || answer.to < to) return null;
  let lo = Infinity, hi = -Infinity;
  for (const c of answer.candles) if (c[0] + answer.tfMs > from && c[0] < to && (!replay || c[0] + answer.tfMs <= at)) {
    lo = Math.min(lo, c[3]); hi = Math.max(hi, c[2]);
  }
  return hi > lo ? { lo, hi } : null;
}

/** Closes belong to the end of their interval. A partial close stays at its observation time; replay never sees its later final value. */
export function pricePoints(answer: PriceHistoryAnswer, at: number, replay: boolean): PricePoint[][] {
  const runs: PricePoint[][] = [];
  let run: PricePoint[] | null = null, previous = -Infinity;
  for (const c of answer.candles) {
    const end = c[0] + answer.tfMs;
    if (replay && end > at) break;
    const t = Math.min(end, answer.asOf);
    if (t > at) break;
    if (c[0] !== previous + answer.tfMs) { run = []; runs.push(run); }
    run!.push({ t, price: c[4], start: c[0] }); previous = c[0];
  }
  return runs;
}

/** A time range [from, to) the chart's candles cover. */
export type Covered = readonly [number, number];

/** The time the chart's candles cover, merged where they follow one another: each holds its interval [start, start + tfMs). Candles are oldest first. */
export function candleCoverage(candles: readonly { readonly 0: number }[], tfMs: number): Covered[] {
  const out: [number, number][] = [];
  for (const c of candles) {
    const start = c[0], last = out[out.length - 1];
    if (last && start <= last[1]) { if (start + tfMs > last[1]) last[1] = start + tfMs; } else out.push([start, start + tfMs]);
  }
  return out;
}

/** Whether `t` is inside a range the candles cover (`candleCoverage`: sorted, not overlapping, each [from, to)). */
export function isCovered(covered: readonly Covered[], t: number): boolean {
  let lo = 0, hi = covered.length;
  while (lo < hi) { const mid = (lo + hi) >>> 1; if (covered[mid]![1] <= t) lo = mid + 1; else hi = mid; }
  return lo < covered.length && covered[lo]![0] <= t;
}

/**
 * The price line without the parts where the chart draws its own candles (Karl, 2026-10-24: the line over the candles was noise; it is for
 * where there are none). A line is cut where it meets a covered range, at that range's edge, at the price on the straight line between the two
 * points around it, so it ends against the first candle and takes up again after a gap. `covered` is sorted and does not overlap
 * (`candleCoverage`); a point inside a range is dropped.
 */
export function uncoveredRuns(runs: readonly (readonly { t: number; price: number }[])[], covered: readonly Covered[]): { t: number; price: number }[][] {
  if (!covered.length) return runs.map(run => run.map(({ t, price }) => ({ t, price })));
  const result: { t: number; price: number }[][] = [];
  /** The part of [x0, x1] outside the covered ranges, as closed intervals in order. */
  const free = (x0: number, x1: number): [number, number][] => {
    const out: [number, number][] = []; let cursor = x0;
    // The first range that can touch: ranges end before `cursor` are skipped by a binary search on their ends.
    let lo = 0, hi = covered.length;
    while (lo < hi) { const mid = (lo + hi) >>> 1; if (covered[mid]![1] <= cursor) lo = mid + 1; else hi = mid; }
    for (let i = lo; i < covered.length && cursor < x1; i++) {
      const [a, b] = covered[i]!;
      if (a >= x1) break;
      if (a > cursor) out.push([cursor, a]);
      cursor = Math.max(cursor, b);
    }
    if (cursor < x1) out.push([cursor, x1]);
    return out;
  };
  const inside = (t: number): boolean => isCovered(covered, t);
  for (const run of runs) {
    let out: { t: number; price: number }[] | null = null;
    for (let i = 0; i < run.length; i++) {
      const p = run[i]!;
      if (i === 0) { if (!inside(p.t)) { out = [{ t: p.t, price: p.price }]; result.push(out); } continue; }
      const q = run[i - 1]!, span = p.t - q.t;
      const at = (t: number): { t: number; price: number } => ({ t, price: span > 0 ? q.price + (p.price - q.price) * (t - q.t) / span : p.price });
      for (const [a, b] of free(q.t, p.t)) {
        if (b === a) continue;
        if (out && a === q.t) out.push(at(b));
        else { out = [at(a), at(b)]; result.push(out); }
        if (b < p.t) out = null;
      }
      if (out && out[out.length - 1]!.t !== p.t) out = null;
    }
  }
  return result;
}

/** The latest observed close at this time, with no carry over a missing interval. */
export function pricePointAt(runs: readonly (readonly PricePoint[])[], time: number, tfMs: number): PricePoint | null {
  for (let i = runs.length - 1; i >= 0; i--) {
    const run = runs[i]!; let lo = 0, hi = run.length;
    while (lo < hi) { const mid = (lo + hi) >>> 1; if (run[mid]!.t <= time) lo = mid + 1; else hi = mid; }
    const point = run[lo - 1]; if (point) return time - point.t <= tfMs ? point : null;
  }
  return null;
}
