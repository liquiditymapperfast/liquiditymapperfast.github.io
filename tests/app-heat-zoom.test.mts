import test from 'node:test';
import assert from 'node:assert/strict';
import { View } from '../src/app/view.ts';
import { fitPrices, liveEdgeShown, followPrice, holdPixel, holdsPrice, limitFactor, priceAtEdge, priceClear, priceHeldAfter, priceRef, regionAt, wheelAxes, wheelFactor, wheelZoom, FIT_PAD, FIT_WIDEN_MAX, PRICE_BAND, PRICE_HOLD_PX, PRICE_SPAN_SHARE, TIME_SPAN_MS, type WheelInput } from '../src/app/panes/heat-zoom.ts';
import type { CandleRow } from '../src/app/store.ts';

test('the part of the map under the pointer: chart, price scale (with the profile column), time strip', () => {
  assert.equal(regionAt(100, 100, 800, 500), 'plot');
  assert.equal(regionAt(800, 100, 800, 500), 'plot', 'the edge belongs to the chart');
  assert.equal(regionAt(801, 100, 800, 500), 'scale');
  assert.equal(regionAt(1000, 499, 800, 500), 'scale');
  assert.equal(regionAt(100, 501, 800, 500), 'time');
  assert.equal(regionAt(1000, 501, 800, 500), 'time', 'the strip under the scale is still the time strip');
});

test('the wheel on the chart zooms time and price together (time alone with Shift), on the price scale price (time with Shift), on the time strip time', () => {
  assert.deepEqual(wheelAxes('plot', false), ['time', 'price']);
  assert.deepEqual(wheelAxes('plot', true), ['time'], 'Shift on the chart is what the wheel did there before it zoomed both');
  assert.deepEqual(wheelAxes('scale', false), ['price']);
  assert.deepEqual(wheelAxes('scale', true), ['time']);
  assert.deepEqual(wheelAxes('time', false), ['time']);
  assert.deepEqual(wheelAxes('time', true), ['time']);
});

test('price zoom holds the current price while it is on the map, time zoom holds the live edge while the map follows, Alt holds the pointer', () => {
  const base = { size: 500, pointer: 40, alt: false, follow: true, mark: 100, markPixel: 210, nowPixel: 460 };
  assert.equal(holdPixel({ ...base, axis: 'price' }), 210);
  assert.equal(holdPixel({ ...base, axis: 'price', follow: false }), 210, 'a map moved by hand still holds the price, so the scale does not slide');
  assert.equal(holdPixel({ ...base, axis: 'price', markPixel: -30 }), 40, 'the price is off the map: the pointer');
  assert.equal(holdPixel({ ...base, axis: 'price', mark: 0 }), 40, 'no price yet');
  assert.equal(holdPixel({ ...base, axis: 'price', alt: true }), 40);
  assert.equal(holdPixel({ ...base, axis: 'time' }), 460);
  assert.equal(holdPixel({ ...base, axis: 'time', follow: false }), 40, 'a map moved by hand zooms about the pointer');
  assert.equal(holdPixel({ ...base, axis: 'time', nowPixel: 900 }), 40, 'the live edge is off the map');
  assert.equal(holdPixel({ ...base, axis: 'time', alt: true }), 40);
  assert.equal(holdPixel({ ...base, axis: 'time', follow: false, pointer: 900 }), 500, 'the pointer is clamped to the plot');
});

test('the chart holds the price under the pointer on a map moved by hand; the price scale holds the current price whatever', () => {
  const base = { axis: 'price' as const, size: 500, pointer: 40, alt: false, follow: false, mark: 100, markPixel: 210, nowPixel: 460 };
  assert.equal(holdPixel({ ...base, holdMark: false }), 40);
  assert.equal(holdPixel({ ...base, holdMark: true }), 210);
  assert.equal(holdPixel({ ...base }), 210, 'as it always was where nothing says otherwise');
  assert.equal(holdPixel({ ...base, holdMark: false, follow: true, alt: true }), 40);
});

test('a zoom stops at the limits and never goes the wrong way', () => {
  assert.equal(limitFactor(0.5, 60_000, TIME_SPAN_MS.min, TIME_SPAN_MS.max), 0.5);
  assert.equal(limitFactor(0.001, 60_000, TIME_SPAN_MS.min, TIME_SPAN_MS.max), 0.5, 'in to 30 s at most');
  assert.equal(limitFactor(1000, 86_400_000, TIME_SPAN_MS.min, TIME_SPAN_MS.max), 400, 'out to 400 days at most');
  assert.equal(limitFactor(1.2, 0, 1, 2), 1, 'no span: nothing to zoom');
  const mark = 60_000;
  assert.ok(limitFactor(0.0001, 1_000, mark * PRICE_SPAN_SHARE.min, mark * PRICE_SPAN_SHARE.max) * 1_000 >= mark * PRICE_SPAN_SHARE.min - 1e-9);
  // A span already past a limit is held by a turn further out and not driven back by it (review 2026-10-31: the wheel on a chart framed wider than the price
  // limit zoomed IN on a turn out, then stood still), and goes on by a turn the other way as asked, not jumped to the limit.
  assert.equal(limitFactor(1.2, 600, 10, 500), 1, 'past the most: a turn out is held');
  assert.equal(limitFactor(0.9, 600, 10, 500), 0.9, 'past the most: a turn in goes on as asked');
  assert.equal(limitFactor(0.001, 600, 10, 500), 10 / 600, 'past the most: and stops at the least');
  assert.equal(limitFactor(0.9, 5, 10, 500), 1, 'under the least: a turn in is held');
  assert.equal(limitFactor(1.2, 5, 10, 500), 1.2, 'under the least: a turn out goes on as asked');
  assert.equal(limitFactor(1e9, 5, 10, 500), 100, 'under the least: and stops at the most');
  for (const span of [1, 5, 10, 100, 500, 600, 5000]) for (const factor of [1e-9, 0.2, 0.9, 1, 1.1, 5, 1e9]) {
    const f = limitFactor(factor, span, 10, 500);
    assert.ok(factor < 1 ? f <= 1 : f >= 1, `${span} x ${factor} -> ${f}: the direction of a turn is kept`);
    assert.ok(factor === 1 ? f === 1 : Math.abs(Math.log(f)) <= Math.abs(Math.log(factor)) + 1e-12, `${span} x ${factor} -> ${f}: never more than asked`);
  }
});

test('zooming holds the pixel it was given: the price and the time under it stay where they were', () => {
  const v = new View({ t0: 1_000_000, t1: 2_000_000, p0: 90, p1: 110 });
  const markY = v.yOf(100, 400), at = v.pOf(markY, 400);
  v.zoomPrice(0.6, markY, 400);
  assert.ok(Math.abs(v.yOf(100, 400) - markY) < 1e-9, 'the current price keeps its height');
  assert.ok(Math.abs(v.pOf(markY, 400) - at) < 1e-9);
  assert.ok(Math.abs((v.p1 - v.p0) - 12) < 1e-9, 'and the span changed by the factor');
  const x = v.xOf(1_800_000, 800), t = v.tOf(x, 800);
  v.zoomTime(1.5, x, 800);
  assert.ok(Math.abs(v.xOf(1_800_000, 800) - x) < 1e-6, 'the live edge keeps its place');
  assert.ok(Math.abs(v.tOf(x, 800) - t) < 1e-6);
  assert.ok(Math.abs((v.t1 - v.t0) - 1_500_000) < 1e-6);
});

/** A wheel turn on a 1,000 x 500 plot showing an hour and a 2,000 range of a 77,000 price, the live edge at 920 and the price at row 300. */
const turn = (patch: Partial<WheelInput> = {}): WheelInput => ({
  region: 'plot', shift: false, alt: false, follow: true, deltaY: -100, deltaMode: 0, x: 300, y: 120, plotW: 1000, plotH: 500,
  view: { t0: 0, t1: 3_600_000, p0: 76_000, p1: 78_000 }, mark: 77_000, markY: 300, nowX: 920, ...patch,
});

test('a turn of the wheel is exp(0.0016 per pixel), a line 33 pixels, a page the plot, at most 240 pixels, and zero does nothing', () => {
  assert.ok(Math.abs(wheelFactor(100, 0, 500) - Math.exp(0.16)) < 1e-12);
  assert.ok(Math.abs(wheelFactor(-100, 0, 500) - Math.exp(-0.16)) < 1e-12);
  assert.ok(Math.abs(wheelFactor(3, 1, 500) - Math.exp(99 * 0.0016)) < 1e-12, 'three lines');
  assert.ok(Math.abs(wheelFactor(0.2, 2, 500) - Math.exp(0.2 * 500 * 0.0016)) < 1e-12, 'a fifth of a page');
  assert.ok(Math.abs(wheelFactor(100_000, 0, 500) - Math.exp(240 * 0.0016)) < 1e-12, 'a single turn is capped');
  assert.equal(wheelFactor(0, 0, 500), 1);
});

test('on the chart both axes take the same factor, so the picture keeps its shape', () => {
  const z = wheelZoom(turn());
  assert.ok(z.time && z.price);
  assert.equal(z.time.factor, z.price.factor);
  assert.ok(z.time.factor < 1, 'scrolling forward zooms in');
  // Applied: the span of each axis changes by that factor, so a pixel stands for the same share of time and of price as before.
  const v = new View(turn().view), tPerPx = (v.t1 - v.t0) / 1000, pPerPx = (v.p1 - v.p0) / 500;
  v.zoomPrice(z.price.factor, z.price.hold, 500); v.zoomTime(z.time.factor, z.time.hold, 1000);
  assert.ok(Math.abs(((v.t1 - v.t0) / 1000) / tPerPx - z.time.factor) < 1e-12);
  assert.ok(Math.abs(((v.p1 - v.p0) / 500) / pPerPx - z.time.factor) < 1e-12);
  assert.ok(Math.abs((v.t1 - v.t0) / (v.p1 - v.p0) - (3_600_000 / 2_000)) < 1e-6 * (3_600_000 / 2_000), 'the ratio of the two spans is as it was');
  const out = wheelZoom(turn({ deltaY: 100 }));
  assert.ok(out.time!.factor > 1 && out.time!.factor === out.price!.factor, 'scrolling back zooms out');
});

test('while the map follows the market both axes hold the live edge and the current price; on a map moved by hand the point under the pointer; Alt always the pointer', () => {
  const live = wheelZoom(turn());
  assert.deepEqual([live.time!.hold, live.price!.hold], [920, 300]);
  const hand = wheelZoom(turn({ follow: false }));
  assert.deepEqual([hand.time!.hold, hand.price!.hold], [300, 120]);
  const alt = wheelZoom(turn({ alt: true }));
  assert.deepEqual([alt.time!.hold, alt.price!.hold], [300, 120], 'Alt: the pointer, following or not');
  // Applied with the pointer held, the time and the price under it do not move.
  const v = new View(turn().view), t = v.tOf(300, 1000), p = v.pOf(120, 500);
  v.zoomPrice(hand.price!.factor, hand.price!.hold, 500); v.zoomTime(hand.time!.factor, hand.time!.hold, 1000);
  assert.ok(Math.abs(v.tOf(300, 1000) - t) < 1e-6 && Math.abs(v.pOf(120, 500) - p) < 1e-9);
  // The live edge off the map (or no price yet): the pointer.
  assert.equal(wheelZoom(turn({ nowX: 1500 })).time!.hold, 300);
  assert.equal(wheelZoom(turn({ mark: 0 })).price!.hold, 120);
});

test('Shift on the chart zooms time alone, held as the wheel held it before; the price scale zooms price alone about the current price; the time strip time alone', () => {
  const shift = wheelZoom(turn({ shift: true }));
  assert.equal(shift.price, null);
  assert.equal(shift.time!.hold, 920);
  assert.equal(shift.time!.factor, wheelFactor(-100, 0, 500));
  const scale = wheelZoom(turn({ region: 'scale', follow: false, x: 1100, y: 80 }));
  assert.equal(scale.time, null);
  assert.equal(scale.price!.hold, 300, 'a price scale holds the current price on a map moved by hand too, so it does not slide');
  assert.equal(scale.price!.factor, wheelFactor(-100, 0, 500));
  const strip = wheelZoom(turn({ region: 'time', y: 520 }));
  assert.equal(strip.price, null);
  assert.equal(strip.time!.hold, 920);
  const scaleShift = wheelZoom(turn({ region: 'scale', shift: true, x: 1100 }));
  assert.equal(scaleShift.price, null);
  assert.ok(scaleShift.time);
});

test('one axis at its limit stops both: the shape never changes, and the other axis is not left to go on', () => {
  const day = 86_400_000;
  // Time at its shortest span, price free: zooming in does nothing at all.
  const atMin = wheelZoom(turn({ view: { t0: 0, t1: TIME_SPAN_MS.min, p0: 76_000, p1: 78_000 } }));
  assert.equal(atMin.time!.factor, 1); assert.equal(atMin.price!.factor, 1);
  // Price at its narrowest, time free.
  const ref = priceRef(77_000, 0, 0), pMin = ref * PRICE_SPAN_SHARE.min;
  const priceMin = wheelZoom(turn({ view: { t0: 0, t1: day, p0: 77_000, p1: 77_000 + pMin } }));
  assert.ok(Math.abs(priceMin.time!.factor - 1) < 1e-9 && priceMin.price!.factor === priceMin.time!.factor, 'a span built by adding is a hair off its limit: nothing to zoom, to a hair');
  // Both free but time nearly at its shortest: the factor is the one time allows, applied to both.
  const near = wheelZoom(turn({ deltaY: -240, view: { t0: 0, t1: TIME_SPAN_MS.min * 1.1, p0: 76_000, p1: 78_000 } }));
  assert.ok(Math.abs(near.time!.factor - 1 / 1.1) < 1e-12 && near.price!.factor === near.time!.factor);
  // Zooming out stops at the widest too.
  const widest = wheelZoom(turn({ deltaY: 100, view: { t0: 0, t1: TIME_SPAN_MS.max, p0: 76_000, p1: 78_000 } }));
  assert.equal(widest.time!.factor, 1); assert.equal(widest.price!.factor, 1);
  const wide = wheelZoom(turn({ deltaY: 100, view: { t0: 0, t1: day, p0: 0.1, p1: 0.1 + 77_000 * PRICE_SPAN_SHARE.max }, mark: 77_000 }));
  assert.ok(Math.abs(wide.time!.factor - 1) < 1e-9 && wide.price!.factor === wide.time!.factor, 'the price span is at its widest');
  // On the price scale alone the time limit is nothing to it.
  assert.ok(wheelZoom(turn({ region: 'scale', view: { t0: 0, t1: TIME_SPAN_MS.min, p0: 76_000, p1: 78_000 } })).price!.factor < 1);
});

test('a chart framed wider than the price limit: a turn out is held, a turn in zooms both axes as asked (review 2026-10-31)', () => {
  const day = 86_400_000, wide = { t0: 0, t1: 110 * day, p0: 0.1, p1: 0.1 + 0.1 * 5.44 }, mark = 0.1;
  const out = wheelZoom(turn({ deltaY: 100, view: wide, mark, markY: 300 }));
  assert.equal(out.time!.factor, 1); assert.equal(out.price!.factor, 1);
  const inn = wheelZoom(turn({ deltaY: -100, view: wide, mark, markY: 300 }));
  assert.ok(inn.time!.factor < 1 && inn.time!.factor === inn.price!.factor, 'in is in');
  assert.ok(Math.abs(inn.time!.factor - Math.exp(-0.16)) < 1e-12, 'as much as the turn asks');
  // A flat pair framed narrower than the price limit: out goes on as asked, in is held.
  const flat = { t0: 0, t1: day, p0: 1, p1: 1 + 0.5e-4 };
  const flatOut = wheelZoom(turn({ deltaY: 100, view: flat, mark: 1, markY: 300 }));
  assert.ok(Math.abs(flatOut.time!.factor - Math.exp(0.16)) < 1e-12 && flatOut.price!.factor === flatOut.time!.factor);
  const flatIn = wheelZoom(turn({ deltaY: -100, view: flat, mark: 1, markY: 300 }));
  assert.equal(flatIn.time!.factor, 1); assert.equal(flatIn.price!.factor, 1);
  // The price scale alone: the same rules for its own axis.
  assert.equal(wheelZoom(turn({ region: 'scale', deltaY: 100, view: wide, mark, markY: 300 })).price!.factor, 1);
});

test('no view yet: nothing to zoom, nothing thrown', () => {
  const z = wheelZoom(turn({ view: { t0: 0, t1: 0, p0: 0, p1: 0 }, mark: 0 }));
  assert.ok(z.time && z.price && z.time.factor === 1 && z.price.factor === 1);
});

test('the map follows the market while the live edge is on it, its edges included, and not once it is off it or before there is a view', () => {
  const view = { t0: 1_000, t1: 61_000 };
  assert.equal(liveEdgeShown(view, 30_000), true, 'in the middle');
  assert.equal(liveEdgeShown(view, 1_000), true, 'at the left edge');
  assert.equal(liveEdgeShown(view, 61_000), true, 'at the right edge');
  assert.equal(liveEdgeShown(view, 61_001), false, 'just past the right edge: a view of the past');
  assert.equal(liveEdgeShown(view, 999), false, 'before the left edge: a view of the future');
  assert.equal(liveEdgeShown({ t0: 0, t1: 0 }, 0), false, 'no view yet');
});

/** Hourly candles whose highs and lows run through `path` (each candle one step of it, its high and low a tenth of a unit apart). */
const run = (...path: number[]): CandleRow[] => path.map((p, i) => [i * 3_600_000, p, p + 0.05, p - 0.05, p, 1]);
const near = (a: number, b: number, what: string, eps = 1e-6): void => assert.ok(Math.abs(a - b) < eps, `${what}: ${a} is not ${b}`);
/** Where the price sits on the axis framed: 0 at the bottom, 1 at the top. */
const at = (f: { p0: number; p1: number }, price: number): number => (price - f.p0) / (f.p1 - f.p0);

test('a fit after a fall puts the price in the middle of the axis, widened to keep the candles in view but no more than 1.5 times their frame', () => {
  // Candles from 120 down to 100 (lows 99.95, highs 120.05), the price at their foot: the old fit put it 13 % up the axis.
  const candles = run(120, 115, 110, 105, 100), lo = 99.95, hi = 120.05, pad = (hi - lo) * FIT_PAD, frame = hi - lo + 2 * pad;
  const f = fitPrices(candles, 100)!;
  near(at(f, 100), 0.5, 'the price is in the middle');
  near(f.p1 - f.p0, FIT_WIDEN_MAX * frame, 'all of the move above the price would need more: the span stops at 1.5 times the old one');
  assert.ok(f.p1 > hi && f.p1 < hi + pad, 'the highest candle still shows, only the room above it is cut');
  // The price a quarter of the way up the candles: widened only as far as the candles and their room need, which is less than the cap.
  const g = fitPrices(candles, 105)!;
  near(at(g, 105), 0.5, 'the price is in the middle');
  near(g.p1, hi + pad, 'the top keeps the room the old fit gave the highest candle');
  assert.ok(g.p1 - g.p0 < FIT_WIDEN_MAX * frame && g.p1 - g.p0 > frame, 'wider than the old frame, under the cap');
});

test('a fit after a rise puts the price in the middle with the lowest candle still in view', () => {
  const candles = run(100, 105, 110, 115, 120), lo = 99.95, hi = 120.05, pad = (hi - lo) * FIT_PAD, frame = hi - lo + 2 * pad;
  const f = fitPrices(candles, 120)!;
  near(at(f, 120), 0.5, 'the price is in the middle');
  near(f.p1 - f.p0, FIT_WIDEN_MAX * frame, 'capped as after a fall');
  assert.ok(f.p0 < lo && f.p0 > lo - pad, 'the lowest candle still shows');
});

test('the price in the middle of its candles, or a flat market, keeps the frame the old fit gave', () => {
  const candles = run(100, 120, 110), lo = 99.95, hi = 120.05, pad = (hi - lo) * FIT_PAD;
  const f = fitPrices(candles, 110)!;
  near(f.p0, lo - pad, 'bottom as before'); near(f.p1, hi + pad, 'top as before');
  // A quiet market: a few cents of range, the price in the middle of it.
  const quiet = run(100, 100.02, 100.01), q = fitPrices(quiet, 100.01)!;
  near(at(q, 100.01), 0.5, 'the price is in the middle', 1e-9);
  near(q.p1 - q.p0, (100.07 - 99.95) * (1 + 2 * FIT_PAD), 'the span is the candles\' own frame');
  // Candles all at one price have no range to frame: 1 % either side of the price, with the same room, as with no candles.
  const flat: CandleRow[] = [[0, 100, 100, 100, 100, 1], [3_600_000, 100, 100, 100, 100, 1]];
  const z = fitPrices(flat, 100)!;
  near(z.p0, 99 - 2 * FIT_PAD, 'one per cent and its room below'); near(z.p1, 101 + 2 * FIT_PAD, 'and above');
});

test('no candles yet: one per cent either side of the price; neither candles nor a price: nothing to frame', () => {
  const f = fitPrices([], 50_000)!;
  near(f.p0, 49_500 - 1_000 * FIT_PAD, 'below'); near(f.p1, 50_500 + 1_000 * FIT_PAD, 'above');
  near(at(f, 50_000), 0.5, 'the price is in the middle');
  assert.equal(fitPrices([], 0), null);
  assert.equal(fitPrices([], Number.NaN), null, 'a price that is not a number is no price');
  const one = fitPrices([[0, 100, 100, 100, 100, 1]], 0)!;
  near(one.p0, 99 - 2 * FIT_PAD, 'one flat candle and no price: framed around its close'); near(one.p1, 101 + 2 * FIT_PAD, 'and above');
});

test('no price yet: the newest candle\'s close stands in for it, so the first frame is centred and nothing frames it again', () => {
  const candles = run(120, 110, 100);
  for (const mark of [0, -1, Number.NaN, Infinity]) {
    const f = fitPrices(candles, mark)!, g = fitPrices(candles, 100)!;
    near(at(f, 100), 0.5, `the close in the middle with mark ${mark}`);
    near(f.p0, g.p0, `as with the price itself (${mark})`); near(f.p1, g.p1, `top as with the price itself (${mark})`);
  }
  // Nothing to centre on (no price, a close that is no price): the candles' own frame, centred on them.
  const lo = 99.95, hi = 120.05, pad = (hi - lo) * FIT_PAD;
  const odd: CandleRow[] = [[0, 120, 120.05, 119.95, 120, 1], [3_600_000, 100, 100.05, 99.95, Number.NaN, 1]];
  const h = fitPrices(odd, 0)!;
  near(h.p0, lo - pad, 'bottom'); near(h.p1, hi + pad, 'top');
});

test('after a fall that halved the price the axis stays above zero, the price still in the middle', () => {
  // Daily candles from 200 down to 85: the candles' frame centred on 85 would reach to -37.
  const candles = run(200, 170, 140, 110, 85);
  const f = fitPrices(candles, 85)!;
  near(at(f, 85), 0.5, 'the price is in the middle');
  assert.ok(f.p0 >= 0, `the axis starts at ${f.p0}`);
  near(f.p1 - f.p0, 2 * 85, 'the span is the zoom\'s own limit, twice the price');
  // The measured openings are far from it: their spans are a few per cent of the price.
  const btc = fitPrices([[0, 81_188, 81_188, 75_158, 75_158, 1], [3_600_000, 75_158, 75_885, 75_158, 75_885, 1]], 75_885.25)!;
  assert.ok(btc.p1 - btc.p0 < 0.2 * 75_885, 'BTC untouched by the limit');
});

test('a price outside its candles\' range is still put in the middle, at 1.5 times their frame, the candles beyond it cut', () => {
  const candles = run(110, 105, 100), lo = 99.95, hi = 110.05, frame = (hi - lo) * (1 + 2 * FIT_PAD);
  const below = fitPrices(candles, 90)!;
  near(at(below, 90), 0.5, 'below them: in the middle'); near(below.p1 - below.p0, FIT_WIDEN_MAX * frame, 'below them: capped');
  assert.ok(below.p1 < hi, 'their top is beyond the axis (a zoom out shows it)');
  const above = fitPrices(candles, 125)!;
  near(at(above, 125), 0.5, 'above them: in the middle'); near(above.p1 - above.p0, FIT_WIDEN_MAX * frame, 'above them: capped');
  assert.ok(above.p0 > lo, 'their foot is beyond the axis');
});

test('the openings measured on 2026-11-06 come out centred with every recent candle in view', () => {
  // The lowest low, highest high and price of the public page's first frame (BTC, ETH, SOL hourly): 23 %, 23 % and 27 % up the axis then.
  for (const [coin, lo, hi, price] of [['BTC', 75_158, 81_188, 75_885.25], ['ETH', 2_205.11, 2_449.95, 2_237.2], ['SOL', 88.24, 98.16, 90.06]] as const) {
    const candles: CandleRow[] = [[0, hi, hi, lo, lo, 1], [3_600_000, lo, price, lo, price, 1]];
    const f = fitPrices(candles, price)!;
    near(at(f, price), 0.5, `${coin} in the middle`);
    assert.ok(f.p0 < lo && f.p1 > hi, `${coin}: every candle in view`);
  }
});

test('a pan holds the price only when it moved it on purpose: 24 px or more up or down, and more up or down than across (YRN, 2026-11-06)', () => {
  assert.equal(PRICE_HOLD_PX, 24);
  assert.equal(holdsPrice(0, 24), true);
  assert.equal(holdsPrice(0, -24), true, 'up as well as down');
  assert.equal(holdsPrice(0, 23.9), false, 'less is a wobble');
  assert.equal(holdsPrice(420, 30), false, 'a drag along the time axis that drifted 30 px down: the drag that lost the live candle in a trend');
  assert.equal(holdsPrice(-300, -32), false, 'either way across');
  assert.equal(holdsPrice(30, 31), true, 'mostly up or down');
  assert.equal(holdsPrice(40, 40), false, 'a diagonal is not a move of the price');
  assert.equal(holdsPrice(0, 0), false);
});

test('a price clear of the edges is clear of the top and bottom tenths; one at an edge is in them or off the map; neither before there is a price or a view', () => {
  const v = { p0: 100, p1: 200 };
  assert.equal(PRICE_BAND, 0.1);
  assert.equal(priceClear(v, 150), true);
  assert.equal(priceClear(v, 110), true, 'the tenth\'s own line is clear');
  assert.equal(priceClear(v, 190), true);
  assert.equal(priceClear(v, 109.9), false, 'in the bottom tenth');
  assert.equal(priceClear(v, 190.1), false, 'in the top tenth');
  assert.equal(priceClear(v, 0), false, 'no price yet');
  assert.equal(priceClear({ p0: 100, p1: 100 }, 100), false, 'no view');
  for (const mark of [109.9, 190.1, 100, 200, 50, 250]) assert.equal(priceAtEdge(v, mark), true, `at ${mark}`);
  for (const mark of [110, 150, 190]) assert.equal(priceAtEdge(v, mark), false, `at ${mark}`);
  assert.equal(priceAtEdge(v, 0), false, 'no price yet: nothing at an edge, so a pan holds nothing');
  assert.equal(priceAtEdge(v, NaN), false, 'nor with a price that is not a number');
  assert.equal(priceAtEdge({ p0: 100, p1: 100 }, 100), false, 'no view');
});

test('following the market, a price no hand holds comes back to the middle within a tenth of the top or bottom, the span kept', () => {
  const at = (mark: number) => followPrice({ p0: 100, p1: 200, mark, held: false });
  assert.deepEqual(at(150), { p0: 100, p1: 200 }, 'in the middle: nothing moves');
  assert.deepEqual(at(110), { p0: 100, p1: 200 }, 'on the band: not yet');
  assert.deepEqual(at(109), { p0: 59, p1: 159 }, 'into the bottom tenth: centred');
  assert.deepEqual(at(191), { p0: 141, p1: 241 }, 'into the top tenth');
  assert.deepEqual(at(500), { p0: 450, p1: 550 }, 'a jump right off the map');
  assert.deepEqual(at(0), { p0: 100, p1: 200 }, 'no price yet: nothing moves');
  assert.deepEqual(followPrice({ p0: 100, p1: 100, mark: 150, held: false }), { p0: 100, p1: 100 }, 'no view yet');
  // A trend a frame at a time, up and then down: the live price never leaves the map.
  for (const step of [0.5, -0.5]) {
    let f = { p0: 1000, p1: 1100 }, jumps = 0;
    for (let i = 0, mark = 1050; i < 600; i++, mark += step) {
      const next = followPrice({ ...f, mark, held: false });
      if (next.p0 !== f.p0) jumps++;
      f = next;
      assert.ok(priceClear(f, mark), `the live price ${mark} is kept clear of the edges`);
    }
    assert.ok(jumps > 5, `a trend of ${step} a frame: centred ${jumps} times`);
  }
});

test('a price held by hand stays where it was put, wherever the market takes it', () => {
  for (const mark of [150, 105, 195, 100, 200, 90, 250, 0]) assert.deepEqual(followPrice({ p0: 100, p1: 200, mark, held: true }), { p0: 100, p1: 200 }, `the price at ${mark}`);
});

test('a pan up or down that leaves the price at the top or bottom of the map or off it holds it there; one that leaves it in the clear lets it go; a pan along the time axis changes nothing (YRN, 2026-11-06)', () => {
  const after = (dx: number, dy: number, edge: boolean, held: boolean, follow = true) => priceHeldAfter({ dx, dy, follow, edge, held });
  assert.equal(after(0, 60, true, false), true, 'down into the lowest tenth (or off the map): a look above the price, held (follow-live D)');
  assert.equal(after(5, -60, true, false), true, 'up to the top or off it: a look below the price');
  assert.equal(after(0, 60, false, false), false, 'down but left in the clear: the follow would not move it, so nothing to hold');
  assert.equal(after(0, 60, false, true), false, 'a held price brought back into the clear by hand: let go');
  assert.equal(after(420, 30, true, false), false, 'a drag along the time axis that drifted into the lowest tenth: not a look, the follow brings it back');
  assert.equal(after(420, 30, false, true), true, 'nor does it let go of a look');
  assert.equal(after(0, 0, false, true), true, 'a wheel turn or a key: the hold as it was');
  assert.equal(after(0, 0, true, false), false);
  // A map left where it was in time has no live price to look away from: a pan there takes no new hold and keeps the one there was.
  assert.equal(after(0, 60, true, false, false), false, 'parked: no new hold');
  assert.equal(after(0, 60, false, true, false), true, 'parked: the look taken while following stays');
});

test('a sequence: the drag that lost the live candle, then a trend a frame at a time, never takes it off the map; a look stays held through the same trend', () => {
  // The pan's end: a drag 420 px along the time axis with 30 px of drift down, which left the price in the lowest tenth.
  const view = { p0: 1000, p1: 1100 }, settle = (dx: number, dy: number, mark: number, held: boolean) => priceHeldAfter({ dx, dy, follow: true, edge: priceAtEdge(view, mark), held });
  for (const step of [0.5, -0.5]) {
    let f = { ...view }, held = settle(420, 30, 1008, false);
    assert.equal(held, false);
    for (let i = 0, mark = 1008; i < 600; i++, mark += step) { f = followPrice({ ...f, mark, held }); assert.ok(mark >= f.p0 && mark <= f.p1, `trend ${step}: the price ${mark} on the map`); }
  }
  // The same place reached by a pan straight down: a look, held however far the trend runs, and the axis never moves.
  const held = settle(0, 60, 1008, false);
  assert.equal(held, true);
  for (let i = 0, mark = 1008; i < 600; i++, mark -= 0.5) assert.deepEqual(followPrice({ ...view, mark, held }), view);
});
