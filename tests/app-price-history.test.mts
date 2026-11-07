import test from 'node:test';
import assert from 'node:assert/strict';
import { ChartPriceHistory, candleCoverage, candlePriceRange, isCovered, priceBounds, priceOverviewNeeded, pricePointAt, pricePoints, priceWindow, uncoveredRuns, type PriceReader, type PriceWindow } from '../src/app/price-history.ts';
import { PRICE_QUERY_BARS, priceListing, type PriceHistoryAnswer, type PriceTarget } from '../src/shared/price-history.ts';
import { BTC } from '../src/shared/coins.ts';
import type { CandleRow } from '../src/app/store.ts';
import type { Candle } from '../src/shared/series.ts';

const HOUR = 3_600_000, DAY = 24 * HOUR, T0 = Date.UTC(2026, 0, 1), NOW = T0 + 100 * DAY;
const target = priceListing(BTC, 'binance:BTCUSDT')!;
const candle = (hour: number): Candle => [T0 + hour * HOUR, 100, 102, 99, 101, 1, 1];
const window = (from: number, to: number): PriceWindow => ({ tf: '1h', tfMs: HOUR, from: T0 + from * HOUR, to: T0 + to * HOUR });
const answer = (w: PriceWindow, id = target.id): PriceHistoryAnswer => ({ instrumentId: id, tfMs: w.tfMs, from: w.from, to: w.to, asOf: NOW, status: 'ok', candles: [[w.from, 100, 102, 99, 101, 1, 1]] });
const pause = (ms = 5): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));
interface Ask { id: string; w: PriceWindow; signal: AbortSignal; resolve(a: PriceHistoryAnswer): void; reject(e: Error): void }
function reader(): { asks: Ask[]; read: PriceReader } {
  const asks: Ask[] = [];
  return { asks, read: (id, tf, from, to, signal) => new Promise((resolve, reject) => { asks.push({ id, w: { tf, tfMs: tf === '4h' ? 4 * HOUR : HOUR, from, to }, signal, resolve, reject }); }) };
}

test('month-scale views choose daily bars, with padded bounded dates', () => {
  const months = priceWindow({ t0: NOW - 74 * DAY, t1: NOW + DAY }, 1_900, NOW)!;
  assert.equal(months.tf, '1d'); assert.ok(months.from < NOW - 74 * DAY); assert.ok(months.to <= NOW + months.tfMs);
  assert.equal(months.from % months.tfMs, 0); assert.equal(months.to % months.tfMs, 0);
  assert.ok((months.to - months.from) / months.tfMs < 2_000);
  assert.equal(priceWindow({ t0: NOW - 365 * DAY, t1: NOW }, 1_900, NOW)!.tf, '1d');
  assert.equal(priceWindow({ t0: NOW + DAY, t1: NOW + 2 * DAY }, 1_900, NOW), null);
  assert.equal(priceWindow({ t0: NOW, t1: NOW }, 1_900, NOW), null);
});

test('a small zoom around a resolution boundary retains its interval', () => {
  const view = { t0: NOW - 420 * HOUR, t1: NOW };
  assert.equal(priceWindow(view, 1_500, NOW)!.tf, '4h');
  assert.equal(priceWindow(view, 1_500, NOW, HOUR)!.tf, '1h');
  assert.equal(priceWindow({ t0: NOW - 500 * HOUR, t1: NOW }, 1_500, NOW, HOUR)!.tf, '4h');
});

test('a view whose days one read cannot hold is asked in weeks, and a view zoomed out over decades still gets a line (Karl, 2026-11-07)', () => {
  const WEEK = 7 * DAY, t1 = NOW + 120 * DAY, to = Math.ceil((NOW + 1) / DAY) * DAY;
  // The left edge whose padded window of days is `bars` long, the right edge in the future as Karl's was (the window ends now).
  const view = (bars: number) => ({ t0: (to - bars * DAY + 1.5 * DAY + 0.15 * t1) / 1.15, t1 });
  const days = priceWindow(view(PRICE_QUERY_BARS), 1_100, NOW, 0, HOUR)!;
  assert.equal(days.tf, '1d'); assert.equal((days.to - days.from) / DAY, PRICE_QUERY_BARS, 'a view the days fit stays in days');
  // One day more (a view of about five years, four months of it to come, drawn on hourly candles): no window at all before, so no line and no legend.
  for (const previous of [0, DAY, WEEK]) {
    const weeks = priceWindow(view(PRICE_QUERY_BARS + 1), 1_100, NOW, previous, HOUR);
    assert.ok(weeks, `a window with ${previous / DAY} days held`);
    assert.equal(weeks.tf, '1w'); assert.equal(weeks.tfMs, WEEK); assert.equal(weeks.from % WEEK, 0); assert.equal(weeks.to % WEEK, 0);
    assert.ok(weeks.from <= view(PRICE_QUERY_BARS + 1).t0 && weeks.to > NOW, 'the whole visible past is asked for');
    assert.ok((weeks.to - weeks.from) / WEEK <= PRICE_QUERY_BARS);
  }
  // Weeks held do not keep a view the days fit in weeks: back under the ceiling it is days again.
  assert.equal(priceWindow(view(PRICE_QUERY_BARS), 1_100, NOW, WEEK, HOUR)!.tf, '1d');
  // A right-button drag zooms out without a limit: past 2,000 weeks the newest of them, never nothing.
  for (const years of [40, 300]) {
    const far = priceWindow({ t0: NOW - years * 365 * DAY, t1: NOW + 30 * DAY }, 1_100, NOW, WEEK, HOUR)!;
    assert.equal(far.tf, '1w'); assert.equal((far.to - far.from) / WEEK, PRICE_QUERY_BARS); assert.ok(far.to > NOW && far.from >= 0);
  }
});

test('an overview is needed only where the candles leave a gap: complete candles need none, however compressed', () => {
  const bars: CandleRow[] = Array.from({ length: 20 }, (_, i) => candle(i));
  const view = { t0: T0 + HOUR / 2, t1: T0 + 20 * HOUR };
  assert.equal(priceOverviewNeeded(bars, HOUR, view, 1_000, NOW), false);
  // The line is cut at the candles, so candles that cover the view leave nothing to draw, readable or squeezed to a smear.
  assert.equal(priceOverviewNeeded(bars, HOUR, view, 10, NOW), false);
  assert.equal(priceOverviewNeeded(bars.slice(1), HOUR, view, 1_000, NOW), true);
  assert.equal(priceOverviewNeeded(bars.filter((_, i) => i !== 5), HOUR, view, 1_000, NOW), true);
  assert.equal(priceOverviewNeeded(bars, HOUR, { t0: NOW + HOUR, t1: NOW + 2 * HOUR }, 1_000, NOW), false);
  assert.equal(priceOverviewNeeded([], HOUR, view, 1_000, NOW), true);
});

test('closes align to their actual end, real gaps split paths, and a tooltip cannot carry a price across a hole', () => {
  const a: PriceHistoryAnswer = { ...answer(window(0, 8)), candles: [candle(0), candle(1), candle(4)] };
  const runs = pricePoints(a, NOW, false);
  assert.deepEqual(runs.map(run => run.map(p => p.t)), [[T0 + HOUR, T0 + 2 * HOUR], [T0 + 5 * HOUR]]);
  assert.equal(pricePointAt(runs, T0 + 2.5 * HOUR, HOUR)?.price, 101);
  assert.equal(pricePointAt(runs, T0 + 3.5 * HOUR, HOUR), null);
  assert.equal(pricePointAt(runs, T0 + HOUR / 2, HOUR), null, 'a close is not visible at its candle open');
});

test('a partial close stays at its observation time, and replay hides a later final close', () => {
  const a: PriceHistoryAnswer = { ...answer(window(0, 2)), candles: [candle(0), candle(1)], asOf: T0 + 1.5 * HOUR };
  assert.equal(pricePoints(a, T0 + 1.75 * HOUR, false)[0]!.at(-1)!.t, a.asOf);
  assert.deepEqual(pricePoints(a, T0 + 1.75 * HOUR, true).flat().map(p => p.t), [T0 + HOUR]);
  assert.deepEqual(pricePoints({ ...a, asOf: NOW }, T0 + HOUR - 1, true), []);
});

test('Go to waits for the full new range instead of consuming a fit on retained overlap', () => {
  const view = { t0: T0, t1: T0 + 10 * HOUR };
  assert.equal(priceOverviewNeeded([candle(8), candle(9)], HOUR, view, 1_000, NOW), true, 'some local candles cannot finish a Go to fit for the whole range');
  const held: PriceHistoryAnswer = { ...answer(window(8, 20)), candles: [candle(8), candle(9)] };
  assert.equal(priceBounds(held, target.id, view, NOW, false), null);
  const loaded: PriceHistoryAnswer = { ...answer(window(0, 10)), candles: [[T0, 100, 110, 50, 101, 1, 1], ...held.candles] };
  assert.deepEqual(priceBounds(loaded, target.id, view, NOW, false), { lo: 50, hi: 110 });
  assert.equal(priceBounds(loaded, 'binance:ETHUSDT', view, NOW, false), null);
  assert.equal(priceBounds({ ...loaded, status: 'stale' }, target.id, view, NOW, false), null);
});

test('price fitting needs no future coverage and replay cannot fit a bar containing later extrema', () => {
  const a: PriceHistoryAnswer = { ...answer(window(0, 2)), candles: [candle(0), [T0 + HOUR, 100, 500, 1, 101, 1, 1]] };
  const view = { t0: T0, t1: T0 + 5 * HOUR }, at = T0 + 1.5 * HOUR;
  assert.deepEqual(priceBounds(a, target.id, view, at, false), { lo: 1, hi: 500 });
  assert.deepEqual(priceBounds(a, target.id, view, at, true), { lo: 99, hi: 102 });
  assert.equal(priceBounds(a, target.id, { t0: at, t1: view.t1 }, at, false), null);
});

test('a gesture burst asks once for its final window and settled repeats ask nothing', async () => {
  const { read, asks } = reader(), h = new ChartPriceHistory(read, () => NOW, 10);
  for (let i = 0; i < 6; i++) h.ensure(target, window(i, i + 10), () => {});
  await pause(20); assert.equal(asks.length, 1); assert.equal(asks[0]!.w.from, window(5, 15).from);
  asks[0]!.resolve(answer(asks[0]!.w)); await pause();
  assert.equal(h.status, 'ok');
  h.ensure(target, window(5, 15), () => {}); await pause(15); assert.equal(asks.length, 1);
  h.stop();
});

test('a range change keeps the previous line while the latest view waits behind the request in flight', async () => {
  const { read, asks } = reader(), h = new ChartPriceHistory(read, () => NOW, 0);
  h.ensure(target, window(0, 10), () => {}); await pause(); asks[0]!.resolve(answer(asks[0]!.w)); await pause();
  const first = h.answer;
  h.ensure(target, window(5, 20), () => {}); await pause();
  h.ensure(target, window(8, 24), () => {}); await pause();
  assert.equal(asks.length, 2, 'the same resolution: its read is not dropped, the view waits'); assert.ok(!asks[1]!.signal.aborted);
  assert.equal(h.answer, first);
  asks[1]!.resolve(answer(asks[1]!.w)); await pause(10);
  assert.equal(asks.length, 3); assert.equal(asks[2]!.w.from, window(8, 24).from);
  h.stop();
});

test('a view that needs another resolution drops the read in flight and asks for its own at once, with no failure and no cool-down', async () => {
  // A zoom out passes through several resolutions; the line's request for the one the zoom left held up the one the view needed (2026-10-24).
  const { read, asks } = reader(), h = new ChartPriceHistory(read, () => NOW, 0);
  h.ensure(target, window(0, 10), () => {}); await pause(); asks[0]!.resolve(answer(asks[0]!.w)); await pause();
  const first = h.answer;
  h.ensure(target, window(5, 20), () => {}); await pause();
  const coarse = { tf: '4h', tfMs: 4 * HOUR, from: T0, to: T0 + 40 * HOUR };
  h.ensure(target, coarse, () => {}); await pause(10);
  assert.ok(asks[1]!.signal.aborted, 'the read for the old resolution is dropped');
  assert.equal(asks.length, 3); assert.equal(asks[2]!.w.tf, '4h', 'the resolution the view needs is asked for at once');
  assert.equal(h.answer, first, 'the previous line stays drawn meanwhile'); assert.notEqual(h.status, 'failed'); assert.notEqual(h.status, 'stale');
  // The dropped read answering late changes nothing.
  asks[1]!.resolve(answer(asks[1]!.w)); await pause();
  assert.equal(h.answer, first);
  asks[2]!.resolve(answer(coarse)); await pause(); assert.equal(h.answer!.tfMs, 4 * HOUR); assert.equal(h.status, 'ok');
  h.stop();
});

test('another instrument aborts the old request and a late old response cannot replace it', async () => {
  const { read, asks } = reader(), h = new ChartPriceHistory(read, () => NOW, 0);
  const other: PriceTarget = { ...target, id: 'binance:ETHUSDT', listing: { symbol: 'ETHUSDT', unit: 1 } };
  h.ensure(target, window(0, 10), () => {}); await pause();
  h.ensure(other, window(0, 10), () => {}); await pause(); assert.ok(asks[0]!.signal.aborted);
  asks[1]!.resolve(answer(asks[1]!.w, other.id)); await pause();
  asks[0]!.resolve(answer(asks[0]!.w)); await pause();
  assert.equal(h.answer!.instrumentId, other.id); h.stop();
});

test('a failed request preserves held data, waits before retrying and recovers', async () => {
  let now = NOW;
  const { read, asks } = reader(), h = new ChartPriceHistory(read, () => now, 0);
  h.ensure(target, window(0, 10), () => {}); await pause(); asks[0]!.resolve(answer(asks[0]!.w)); await pause();
  const first = h.answer;
  h.ensure(target, window(0, 20), () => {}); await pause(); asks[1]!.reject(new Error('offline')); await pause();
  assert.equal(h.status, 'stale'); assert.equal(h.answer, first);
  h.ensure(target, window(0, 20), () => {}); await pause(); assert.equal(asks.length, 2);
  now += 61_000; h.ensure(target, window(0, 20), () => {}); await pause();
  asks[2]!.resolve(answer(asks[2]!.w)); await pause(); assert.equal(h.status, 'ok'); h.stop();
});

test('a short or malformed server answer fails with a cooldown instead of scheduling an endless retry', async () => {
  const { read, asks } = reader(), h = new ChartPriceHistory(read, () => NOW, 0);
  h.ensure(target, window(0, 20), () => {}); await pause();
  asks[0]!.resolve(answer(window(0, 10))); await pause(15);
  assert.equal(h.status, 'failed'); assert.equal(asks.length, 1);
  h.ensure(target, window(0, 20), () => {}); await pause(); assert.equal(asks.length, 1); h.stop();
});

test('hiding a chart cancels a scheduled read and stops queued views from loading after an active read', async () => {
  const { read, asks } = reader(), h = new ChartPriceHistory(read, () => NOW, 5);
  h.ensure(target, window(0, 10), () => {}); h.stop(); await pause(15); assert.equal(asks.length, 0);
  h.ensure(target, window(0, 10), () => {}); await pause(15);
  h.ensure(target, window(0, 20), () => {}); h.stop(); asks[0]!.resolve(answer(asks[0]!.w)); await pause(15);
  assert.equal(asks.length, 1);
});

test('a formerly forming bar is fetched again immediately after it closes, even on a historical view', async () => {
  let now = T0 + 100.5 * HOUR;
  const { read, asks } = reader(), h = new ChartPriceHistory(read, () => now, 0), w = window(90, 101);
  h.ensure(target, w, () => {}); await pause();
  asks[0]!.resolve({ ...answer(w), asOf: now, candles: [candle(100)] }); await pause();
  now = T0 + 101 * HOUR + 1;
  h.ensure(target, w, () => {}); await pause(); assert.equal(asks.length, 2);
  asks[1]!.resolve({ ...answer(w), asOf: now, candles: [candle(100)] }); await pause(); h.stop();
});

test('a one-hour chart never asks for finer overview candles, and daily context ignores an old hourly preference', () => {
  const short = priceWindow({ t0: NOW - 4 * DAY, t1: NOW }, 1_900, NOW, 0, HOUR)!;
  assert.equal(short.tf, '1h');
  assert.ok((short.to - short.from) / short.tfMs < 120);
  const long = priceWindow({ t0: NOW - 74 * DAY, t1: NOW }, 1_900, NOW, HOUR, HOUR)!;
  assert.equal(long.tf, '1d');
  assert.ok((long.to - long.from) / long.tfMs < 90, 'daily context fits one small exchange page');
});

test('returning from a coarse overview reuses the cached hourly window without another request', async () => {
  const { read, asks } = reader(), h = new ChartPriceHistory(read, () => NOW, 0), fine = window(0, 10);
  const coarse: PriceWindow = { tf: '4h', tfMs: 4 * HOUR, from: T0, to: T0 + 40 * HOUR };
  h.ensure(target, fine, () => {}); await pause(); asks[0]!.resolve(answer(fine)); await pause();
  const held = h.answer;
  h.ensure(target, coarse, () => {}); await pause(); asks[1]!.resolve(answer(coarse)); await pause();
  assert.equal(h.answer!.tfMs, 4 * HOUR);
  h.ensure(target, fine, () => {}); await pause();
  assert.equal(asks.length, 2); assert.equal(h.answer, held); assert.equal(h.status, 'ok');
  h.stop();
});

test('the recent-window cache is bounded across instruments and never reuses a candle that closed while away', async () => {
  let reads = 0;
  const h = new ChartPriceHistory(async (id, _tf, from, to) => { reads++; return { ...answer({ tf: '1h', tfMs: HOUR, from, to }, id) }; }, () => NOW, 0);
  for (let i = 0; i < 9; i++) { h.ensure({ ...target, id: `binance:COIN${i}` }, window(0, 10), () => {}); await pause(); }
  assert.equal(reads, 9);
  h.ensure({ ...target, id: 'binance:COIN7' }, window(0, 10), () => {}); await pause(); assert.equal(reads, 9, 'recent instrument is held');
  h.ensure({ ...target, id: 'binance:COIN0' }, window(0, 10), () => {}); await pause(); assert.equal(reads, 10, 'the ninth instrument evicts the oldest');
  h.stop();

  let now = T0 + 100.5 * HOUR;
  const { read, asks } = reader(), live = new ChartPriceHistory(read, () => now, 0), w = window(90, 101);
  live.ensure(target, w, () => {}); await pause(); asks[0]!.resolve({ ...answer(w), asOf: now, candles: [candle(100)] }); await pause();
  const coarse: PriceWindow = { tf: '4h', tfMs: 4 * HOUR, from: T0, to: T0 + 80 * HOUR };
  live.ensure(target, coarse, () => {}); await pause(); asks[1]!.resolve(answer(coarse)); await pause();
  now = T0 + 101 * HOUR + 1;
  live.ensure(target, w, () => {}); await pause();
  assert.equal(asks.length, 3, 'a cached partial hour is fetched again after it closes');
  asks[2]!.resolve({ ...answer(w), asOf: now, candles: [candle(100)] }); await pause(); live.stop();
});

test('candles cover their intervals, merged where they follow one another', () => {
  const bars = [candle(0), candle(1), candle(2), candle(5), candle(6)];
  assert.deepEqual(candleCoverage(bars, HOUR), [[T0, T0 + 3 * HOUR], [T0 + 5 * HOUR, T0 + 7 * HOUR]]);
  assert.deepEqual(candleCoverage([], HOUR), []);
});

test('the price line is cut where the candles are drawn: it ends against the first candle, takes up after a gap, and a line with no candles is whole', () => {
  // Karl, 2026-10-24: the white line over the candles was noise; it is for where there are none.
  const pt = (hour: number, price: number) => ({ t: T0 + hour * HOUR, price });
  const run = [pt(0, 100), pt(10, 200), pt(20, 100), pt(30, 300)];
  const whole = uncoveredRuns([run], []);
  assert.deepEqual(whole, [run], 'nothing covered: the line as it is');
  // Candles from hour 14 to 24 (a range of the chart), the rest uncovered.
  const cut = uncoveredRuns([run], [[T0 + 14 * HOUR, T0 + 24 * HOUR]]);
  assert.equal(cut.length, 2);
  assert.deepEqual(cut[0]!.map(p => [(p.t - T0) / HOUR, p.price]), [[0, 100], [10, 200], [14, 160]], 'ends at the first candle edge, on the straight line between the points around it');
  assert.deepEqual(cut[1]!.map(p => [(p.t - T0) / HOUR, p.price]), [[24, 180], [30, 300]], 'takes up where they stop');
  // The candles cover the start: the line begins at their end.
  const startCovered = uncoveredRuns([run], [[T0 - 5 * HOUR, T0 + 5 * HOUR]]);
  assert.deepEqual(startCovered[0]!.map(p => [(p.t - T0) / HOUR, p.price]), [[5, 150], [10, 200], [20, 100], [30, 300]]);
  // The candles cover all of it: nothing drawn. A point inside a range is dropped.
  assert.deepEqual(uncoveredRuns([run], [[T0 - HOUR, T0 + 31 * HOUR]]), []);
  assert.deepEqual(uncoveredRuns([[pt(3, 100)]], [[T0, T0 + 5 * HOUR]]), [], 'a lone point inside');
  assert.deepEqual(uncoveredRuns([[pt(8, 100)]], [[T0, T0 + 5 * HOUR]]).map(r => r.length), [1], 'a lone point outside');
  // A candle's interval is half-open: a close at its end is not covered by it.
  const edge = uncoveredRuns([[pt(0, 100), pt(5, 110), pt(9, 120)]], [[T0, T0 + 5 * HOUR]]);
  assert.deepEqual(edge[0]!.map(p => (p.t - T0) / HOUR), [5, 9]);
  // Separate runs (a real gap in the exchange's history) stay separate.
  assert.equal(uncoveredRuns([[pt(0, 1), pt(1, 2)], [pt(40, 3), pt(41, 4)]], [[T0 + 20 * HOUR, T0 + 30 * HOUR]]).length, 2);
});

test('a time is covered where a candle holds it: ranges are half-open, and the gaps between them are not covered', () => {
  const covered = candleCoverage([candle(0), candle(1), candle(4)], HOUR);
  assert.deepEqual(covered, [[T0, T0 + 2 * HOUR], [T0 + 4 * HOUR, T0 + 5 * HOUR]]);
  assert.equal(isCovered(covered, T0), true);
  assert.equal(isCovered(covered, T0 + 2 * HOUR - 1), true);
  assert.equal(isCovered(covered, T0 + 2 * HOUR), false);
  assert.equal(isCovered(covered, T0 + 3 * HOUR), false);
  assert.equal(isCovered(covered, T0 + 4 * HOUR), true);
  assert.equal(isCovered(covered, T0 - 1), false);
  assert.equal(isCovered([], T0), false);
});

test('a fit to the candles on screen takes their lowest low and highest high, and nothing where there are none or they are flat', () => {
  const bars = [candle(0), candle(1), candle(2)].map((c, i): CandleRow => [c[0], 100, 110 + i, 90 - i, 101, 1, 1]);
  assert.deepEqual(candlePriceRange(bars, HOUR, T0, T0 + 3 * HOUR), { lo: 88, hi: 112 });
  assert.deepEqual(candlePriceRange(bars, HOUR, T0 + HOUR / 2, T0 + 1.5 * HOUR), { lo: 89, hi: 111 }, 'the two candles that touch the view');
  assert.equal(candlePriceRange(bars, HOUR, T0 + 10 * HOUR, T0 + 11 * HOUR), null, 'none on screen');
  assert.equal(candlePriceRange([[T0, 100, 100, 100, 100, 1, 1]], HOUR, T0, T0 + HOUR), null, 'a flat price has no range to fit');
  assert.equal(candlePriceRange([], HOUR, T0, T0 + HOUR), null);
});

test('scripts reach before the view: the chart\'s own candles the warm-up asks for, never past the read\'s ceiling, never a coarser interval for it', () => {
  // Karl, 2026-11-03: the VWAP script began at the 500th candle back, wherever that fell; while scripts run the chart reads 200 candles more before its edge.
  const month = { t0: NOW - 29 * DAY, t1: NOW + DAY };
  const plain = priceWindow(month, 1_500, NOW, 0, HOUR)!, warm = priceWindow(month, 1_500, NOW, 0, HOUR, 200)!;
  assert.deepEqual([plain.tf, warm.tf, warm.to], ['1h', '1h', plain.to]);
  assert.equal(plain.from - warm.from, 200 * HOUR, 'two hundred candles more, before the edge');
  // Near the ceiling the warm-up gives way: the read stays the chart's own candles, as many as the ceiling allows.
  const near = { t0: NOW - 1_600 * HOUR, t1: NOW };
  const nearPlain = priceWindow(near, 1_500, NOW, 0, HOUR)!, nearWarm = priceWindow(near, 1_500, NOW, 0, HOUR, 200)!;
  assert.equal(nearWarm.tf, '1h'); assert.ok(nearWarm.from <= nearPlain.from);
  assert.equal((nearWarm.to - nearWarm.from) / HOUR, 2_000, 'up to the ceiling, not past it');
  // A view the chart's candles cannot hold is read coarser with or without the warm-up: it changes nothing there.
  const far = { t0: NOW - 120 * DAY, t1: NOW };
  assert.deepEqual(priceWindow(far, 1_500, NOW, 0, HOUR, 200), priceWindow(far, 1_500, NOW, 0, HOUR));
  // The overview is asked for when the candles cover the view but not the warm-up before it.
  const bars: CandleRow[] = Array.from({ length: 100 }, (_, i) => candle(i));
  const view = { t0: T0 + 10 * HOUR, t1: T0 + 100 * HOUR };
  assert.equal(priceOverviewNeeded(bars, HOUR, view, 1_000, NOW), false);
  assert.equal(priceOverviewNeeded(bars, HOUR, { t0: view.t0 - 200 * HOUR, t1: view.t1 }, 1_000, NOW), true);
});
