import test from 'node:test';
import assert from 'node:assert/strict';
import { View } from '../src/app/view.ts';
import { holdPixel, limitFactor, priceRef, regionAt, wheelAxes, wheelFactor, wheelZoom, PRICE_SPAN_SHARE, TIME_SPAN_MS, type WheelInput } from '../src/app/panes/heat-zoom.ts';

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
  assert.equal(alt.unfollow, true, 'on a map that follows the market, Alt takes it off the live point, as a drag does');
  assert.equal(hand.unfollow, false);
  assert.equal(live.unfollow, false, 'the wheel on its own never stops the following');
  assert.equal(wheelZoom(turn({ alt: true, follow: false })).unfollow, false, 'nothing to stop');
  assert.equal(wheelZoom(turn({ alt: true, view: { t0: 0, t1: TIME_SPAN_MS.min, p0: 76_000, p1: 78_000 } })).unfollow, false, 'and nothing zoomed, nothing stopped');
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
  assert.equal(out.unfollow, false);
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
