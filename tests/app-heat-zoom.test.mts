import test from 'node:test';
import assert from 'node:assert/strict';
import { View } from '../src/app/view.ts';
import { holdPixel, limitFactor, regionAt, wheelAxis, PRICE_SPAN_SHARE, TIME_SPAN_MS } from '../src/app/panes/heat-zoom.ts';

test('the part of the map under the pointer: chart, price scale (with the profile column), time strip', () => {
  assert.equal(regionAt(100, 100, 800, 500), 'plot');
  assert.equal(regionAt(800, 100, 800, 500), 'plot', 'the edge belongs to the chart');
  assert.equal(regionAt(801, 100, 800, 500), 'scale');
  assert.equal(regionAt(1000, 499, 800, 500), 'scale');
  assert.equal(regionAt(100, 501, 800, 500), 'time');
  assert.equal(regionAt(1000, 501, 800, 500), 'time', 'the strip under the scale is still the time strip');
});

test('the wheel on the chart zooms time and on the price scale zooms price; Shift swaps them; the time strip is always time', () => {
  assert.equal(wheelAxis('plot', false), 'time');
  assert.equal(wheelAxis('scale', false), 'price');
  assert.equal(wheelAxis('plot', true), 'price');
  assert.equal(wheelAxis('scale', true), 'time');
  assert.equal(wheelAxis('time', false), 'time');
  assert.equal(wheelAxis('time', true), 'time');
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

test('a zoom stops at the limits and never goes the wrong way', () => {
  assert.equal(limitFactor(0.5, 60_000, TIME_SPAN_MS.min, TIME_SPAN_MS.max), 0.5);
  assert.equal(limitFactor(0.001, 60_000, TIME_SPAN_MS.min, TIME_SPAN_MS.max), 0.5, 'in to 30 s at most');
  assert.equal(limitFactor(1000, 86_400_000, TIME_SPAN_MS.min, TIME_SPAN_MS.max), 400, 'out to 400 days at most');
  assert.equal(limitFactor(1.2, 0, 1, 2), 1, 'no span: nothing to zoom');
  const mark = 60_000;
  assert.ok(limitFactor(0.0001, 1_000, mark * PRICE_SPAN_SHARE.min, mark * PRICE_SPAN_SHARE.max) * 1_000 >= mark * PRICE_SPAN_SHARE.min - 1e-9);
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
