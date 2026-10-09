import test from 'node:test';
import assert from 'node:assert/strict';
import { CONTRAST, clampContrast, colourWindow, nextBaseline } from '../src/app/heatmap/window.ts';

const baseline = { lo: 100_000, hi: 2_600_000 };
const L = Math.log(baseline.hi / baseline.lo);

test('the neutral position is the percentile baseline itself', () => {
  const w = colourWindow(baseline, CONTRAST.neutral);
  assert.ok(Math.abs(w.lo - baseline.lo) < 1e-6 && Math.abs(w.hi - baseline.hi) < 1e-6);
});

test('the range that was always there is unchanged: 100 slides down and 0 slides up by three quarters of the window\'s width', () => {
  const thin = colourWindow(baseline, 100), big = colourWindow(baseline, 0);
  assert.ok(Math.abs(Math.log(thin.lo / baseline.lo) + 0.75 * L) < 1e-9, 'right end');
  assert.ok(Math.abs(Math.log(big.lo / baseline.lo) - 0.75 * L) < 1e-9, 'left end of the old range');
  assert.ok(Math.abs(Math.log(big.hi / big.lo) - L) < 1e-9, 'sliding never changes the window\'s width');
});

test('going further left keeps sliding the window up, so the biggest walls come out paler than they could before', () => {
  let previous = colourWindow(baseline, CONTRAST.max);
  for (let c = CONTRAST.max - 10; c >= CONTRAST.min; c -= 10) {
    const w = colourWindow(baseline, c);
    assert.ok(w.lo > previous.lo && w.hi > previous.hi, `window rises at ${c}`);
    previous = w;
  }
  const far = colourWindow(baseline, CONTRAST.min), old = colourWindow(baseline, 0);
  assert.ok(Math.abs(Math.log(far.lo / baseline.lo) - 2.25 * L) < 1e-9, 'three times the old slide at the new end');
  // A wall of 20 M sat at s = ln(20M / lo) / L along the ramp: higher means a stronger colour.
  const where = (w: { lo: number; hi: number }, v: number): number => Math.log(v / w.lo) / Math.log(w.hi / w.lo);
  assert.ok(where(far, 20_000_000) < where(old, 20_000_000) - 0.5, 'a 20 M wall that was strongly coloured at the old minimum is well below it now');
});

test('a saved or typed value outside the slider is brought inside it, and rubbish is the neutral one', () => {
  assert.equal(clampContrast(-250), CONTRAST.min);
  assert.equal(clampContrast(250), CONTRAST.max);
  assert.equal(clampContrast(37.6), 38);
  assert.equal(clampContrast('0'), 0, 'a number kept as text');
  assert.equal(clampContrast(Number.NaN), CONTRAST.neutral);
  assert.equal(clampContrast(undefined), CONTRAST.neutral);
  assert.equal(clampContrast(null), 0, 'null is not a number the slider can hold, but Number(null) is 0, which is inside it');
  assert.deepEqual(colourWindow(baseline, 1e9), colourWindow(baseline, CONTRAST.max), 'the window never follows a value the slider cannot reach');
});

test('until there is a baseline the window is a placeholder', () => {
  assert.deepEqual(colourWindow(null, 10), { lo: 1, hi: 2 });
});

test('the baseline: new for a new view even with Auto off, following the cells while history loads, then held (off) or blended (on)', () => {
  const at = (p15: number, p96: number) => ({ p15, p96 });
  const o = (now: number, extra: Partial<{ auto: boolean; force: boolean; spanP: number }> = {}) => ({ auto: false, force: false, spanP: 1_000, now, ...extra });
  // The first raster after a load holds little more than the live column; the history arrives in the next ones.
  let b = nextBaseline(null, at(40_000, 170_000), o(0));
  assert.deepEqual([b?.lo, b?.hi], [40_000, 170_000]);
  b = nextBaseline(b, at(400_000, 5_000_000), o(3_000));
  assert.deepEqual([b?.lo, b?.hi], [400_000, 5_000_000], 'still settling: follows the cells');
  const settled = nextBaseline(b, at(400_000, 5_000_000), o(16_000));
  assert.equal(nextBaseline(settled, at(10_000, 90_000), o(40_000)), settled, 'Auto off: held while the data changes');
  // A view 2x off in price span, or recentred / another market (force), takes a new one with Auto off too.
  assert.equal(nextBaseline(settled, at(10_000, 90_000), o(40_000, { spanP: 4_000 }))?.hi, 90_000);
  assert.equal(nextBaseline(settled, at(10_000, 90_000), o(40_000, { force: true }))?.hi, 90_000);
  // Auto on blends halfway (in log) toward the cells every ten seconds once settled.
  const blended = nextBaseline(settled, at(400_000, 500_000), o(40_000, { auto: true }));
  assert.ok(Math.abs(blended!.hi - Math.sqrt(5_000_000 * 500_000)) < 1);
  assert.equal(nextBaseline(blended, at(400_000, 500_000), o(45_000, { auto: true })), blended, 'not again within ten seconds');
  assert.equal(nextBaseline(settled, at(0, 0), o(60_000, { force: true })), settled, 'an empty raster changes nothing');
  // Even at the far-left contrast the old frozen window could not reach the cells: 2.25 widths of a 4x window is about 22x, the cells were 30x.
  assert.ok(colourWindow({ lo: 42_500, hi: 170_000 }, CONTRAST.min).hi < 5_000_000);
});
