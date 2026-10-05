import test from 'node:test';
import assert from 'node:assert/strict';
import { mirrorLines, mirrorStats, percentText, ratioText } from '../src/app/mirror.ts';

test('the mirror price is the hovered price reflected about the mid', () => {
  const s = mirrorStats(100, 103, 50, 40)!;
  assert.equal(s.mirror, 97);
  assert.equal(s.distance, 3);
  assert.equal(s.hoveredSide, 'above');
  assert.ok(Math.abs(s.distanceBp - 300) < 1e-9);
  const below = mirrorStats(100, 96, 50, 40)!;
  assert.equal(below.mirror, 104);
  assert.equal(below.hoveredSide, 'below');
});

test('this side is the hovered side: above hovers read the above total, below hovers the below total', () => {
  const up = mirrorStats(100, 105, 90, 30)!;
  assert.deepEqual([up.hovered, up.opposite, up.dominant, up.ratio], [90, 30, 'this', 3]);
  const down = mirrorStats(100, 95, 90, 30)!;
  assert.deepEqual([down.hovered, down.opposite, down.dominant, down.ratio], [30, 90, 'opposite', 3]);
});

test('ratio is larger over smaller, balanced within 2 %, and empty sides are handled', () => {
  assert.equal(mirrorStats(100, 101, 113, 100)!.dominant, 'this');
  assert.ok(Math.abs(mirrorStats(100, 101, 100, 113)!.ratio - 1.13) < 1e-12);
  assert.equal(mirrorStats(100, 101, 100, 101)!.dominant, 'balanced');
  assert.equal(mirrorStats(100, 101, 0, 0)!.dominant, 'none');
  const one = mirrorStats(100, 101, 10, 0)!;
  assert.equal(one.ratio, Infinity);
  assert.equal(one.dominant, 'this');
});

test('no mirror at the mid itself or without a valid mid', () => {
  assert.equal(mirrorStats(100, 100, 1, 1), null);
  assert.equal(mirrorStats(0, 5, 1, 1), null);
  assert.equal(mirrorStats(100, Number.NaN, 1, 1), null);
});

test('the printed lines name the sides and the dominance in plain words', () => {
  const names = { above: 'Asks', below: 'Bids' };
  const opposite = mirrorLines(mirrorStats(85_000, 85_300, 100e6, 113e6)!, names, 'Binance');
  assert.equal(opposite[0]!.text, 'Binance');
  assert.match(opposite.map(l => l.text).join('\n'), /Asks \(this side\)\s+\$100M/);
  assert.match(opposite.map(l => l.text).join('\n'), /Bids \(opposite\)\s+\$113M/);
  assert.equal(opposite.at(-1)!.text, 'Opposite side has 1.13x more');
  assert.equal(opposite.at(-1)!.color, 'below', 'coloured by the side that dominates');
  const mine = mirrorLines(mirrorStats(85_000, 84_700, 100e6, 200e6)!, names);
  assert.equal(mine.at(-1)!.text, 'This side has 2.00x more');
  assert.equal(mine.at(-1)!.color, 'below');
  assert.equal(mirrorLines(mirrorStats(100, 101, 5, 5)!, names).at(-1)!.text, 'Balanced');
  assert.equal(mirrorLines(mirrorStats(100, 101, 5, 0)!, names).at(-1)!.text, 'Only this side has liquidity');
});

test('ratios print with two decimals below ten and one above', () => {
  assert.equal(ratioText(1.13), '1.13x');
  assert.equal(ratioText(2), '2.00x');
  assert.equal(ratioText(12.46), '12.5x');
  assert.equal(ratioText(Infinity), 'all of it');
});

test('the band labels print the distance from the mid as a percentage with sensible precision', () => {
  assert.equal(percentText(mirrorStats(85_000, 85_000 + 4_930, 1, 1)!), '5.8%');
  assert.equal(percentText(mirrorStats(85_000, 85_000 - 300, 1, 1)!), '0.35%');
  assert.equal(percentText(mirrorStats(100, 110, 1, 1)!), '10.0%');
});
