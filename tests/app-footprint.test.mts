import test from 'node:test';
import assert from 'node:assert/strict';
import { IMBALANCE_RATIO, footprintLayout, heatmapShare, imbalance, readBar, validStats, volText, type Bar } from '../src/app/panes/footprint.ts';

test('a row gets a bar only when one side dominates, on the dominant side', () => {
  assert.equal(imbalance(5.9e6, 13.4e6), 'sell', 'left number (sell) larger');
  assert.equal(imbalance(15.8e6, 4.0e6), 'buy');
  assert.equal(imbalance(10.5e6, 10.4e6), null, 'balanced rows are text only');
  assert.equal(imbalance(0, 9e6), 'sell');
  assert.equal(imbalance(2e6, 0), 'buy', 'one-sided rows count');
  assert.equal(imbalance(0, 0), null);
  assert.equal(imbalance(IMBALANCE_RATIO * 1000, 1000), 'buy');
  assert.equal(imbalance(IMBALANCE_RATIO * 1000 - 1, 1000), null, 'just under the ratio');
});

test('candle and row column share the slot without overlapping', () => {
  for (const slot of [60, 120, 204, 400, 900]) {
    const l = footprintLayout(slot);
    assert.ok(l.body > 0 && l.body <= 44, `body ${l.body}`);
    assert.ok(l.candleCenter - l.body / 2 >= 0, 'candle starts inside the slot');
    assert.ok(l.colLeft >= l.candleCenter + l.body / 2, 'column starts after the candle');
    assert.ok(l.colLeft + l.colWidth <= slot, 'column ends inside the slot');
    assert.ok(l.colWidth >= slot * 0.6, `column keeps most of the slot (${l.colWidth} of ${slot})`);
  }
  const wide = footprintLayout(204);
  assert.ok(Math.abs(wide.body / 204 - 0.2) < 0.01, 'about a fifth of the slot, as in the reference');
});

test('volume text matches the compact form printed in rows', () => {
  assert.equal(volText(13.4e6), '13.4M');
  assert.equal(volText(407_000), '407.0k');
  assert.equal(volText(0), '0.00');
  assert.equal(volText(-5), '0.00');
  assert.equal(volText(950), '950');
  assert.equal(volText(1.25e9), '1.3B');
});

test('trade stats from the wire are checked: eight finite non-negative buckets and integer counts, else dropped', () => {
  const good = { buyN: 3, sellN: 1, buy: [1, 0, 0, 0, 0, 0, 0, 5], sell: [0, 2, 0, 0, 0, 0, 0, 0] };
  assert.deepEqual(validStats(good), good);
  for (const bad of [null, 'x', {}, { ...good, buyN: 1.5 }, { ...good, sellN: -1 }, { ...good, buy: [1, 2] }, { ...good, sell: [0, 0, 0, 0, 0, 0, 0, NaN] }, { ...good, buy: [-1, 0, 0, 0, 0, 0, 0, 0] }, { ...good, sell: 'nope' }]) assert.equal(validStats(bad), undefined, JSON.stringify(bad));
  const bar: Bar = { t: 1, rows: [], buyUsd: 1, sellUsd: 2 };
  assert.deepEqual(readBar({ ...bar, stats: good }).stats, good);
  assert.equal('stats' in readBar({ ...bar, stats: { ...good, buy: [1] } }), false, 'invalid stats are removed, the bar stays');
  assert.deepEqual(readBar(bar), bar);
});

test('the heatmap fades out completely once the footprint is dominant, and not before it shows', () => {
  assert.equal(heatmapShare(0), 1, 'no footprint, whole heatmap');
  assert.ok(heatmapShare(0.3) < 1 && heatmapShare(0.3) > 0.4, 'it fades gradually while the footprint comes in');
  assert.equal(heatmapShare(0.75), 0, 'dominant footprint: no residue of the heatmap');
  assert.equal(heatmapShare(1), 0);
  let last = 1;
  for (let a = 0; a <= 1; a += 0.05) { const s = heatmapShare(a); assert.ok(s <= last + 1e-12, 'never brightens as the footprint grows'); last = s; }
});
