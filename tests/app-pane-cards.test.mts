import test from 'node:test';
import assert from 'node:assert/strict';
import { barAt, columnAt, depthCardLines, ltCardLines, oiCardLines, oiTail, slotAt } from '../src/app/panes/pane-cards.ts';
import { layoutInfo } from '../src/app/infobox.ts';

const MIN = 60_000;
const by = (lines: ReturnType<typeof depthCardLines>, label: string) => lines.find(line => line.label === label);

test('the column under the pointer: each column owns its start and not its end, and outside the series there is none', () => {
  assert.equal(columnAt(1_000, 2_000, 10, 1_000), 0);
  assert.equal(columnAt(1_000, 2_000, 10, 1_099), 0);
  assert.equal(columnAt(1_000, 2_000, 10, 1_100), 1);
  assert.equal(columnAt(1_000, 2_000, 10, 1_999), 9);
  assert.equal(columnAt(1_000, 2_000, 10, 2_000), -1);
  assert.equal(columnAt(1_000, 2_000, 10, 999), -1);
  assert.equal(columnAt(2_000, 1_000, 10, 1_500), -1, 'an empty or reversed window has no columns');
});

test('a Liquidity Tracker point is found by its slot, and the gaps between points have none', () => {
  const times = [0, MIN, 2 * MIN, 10 * MIN];
  assert.equal(slotAt(times, MIN, 30_000), 0);
  assert.equal(slotAt(times, MIN, MIN), 1);
  assert.equal(slotAt(times, MIN, 3 * MIN - 1), 2);
  assert.equal(slotAt(times, MIN, 3 * MIN), -1, 'recording had stopped');
  assert.equal(slotAt(times, MIN, 10 * MIN + 59_000), 3);
  assert.equal(slotAt(times, MIN, -1), -1);
  assert.equal(slotAt([], MIN, 0), -1);
});

test('an open-interest bar is the last that has started; only the newest holds on past its own slot', () => {
  const bars = [[0], [MIN], [5 * MIN]];
  assert.equal(barAt(bars, MIN, 30_000), 0);
  assert.equal(barAt(bars, MIN, 90_000), 1);
  assert.equal(barAt(bars, MIN, 3 * MIN), -1, 'between samples, nothing was measured');
  assert.equal(barAt(bars, MIN, 5 * MIN + 10 * MIN), 2, 'the newest level stands until the next sample');
  assert.equal(barAt(bars, MIN, -5), -1);
});

test('the depth popup gives both sides, how they compare, the range, and where the moment ranks', () => {
  const lines = depthCardLines({ time: Date.UTC(2026, 9, 6, 12, 30), bid: 30_000_000, ask: 10_000_000, range: 0.2, rank: 3, of: 120 });
  assert.equal(lines[0]!.text, 'Depth'); assert.equal(lines[0]!.bold, true);
  assert.deepEqual([by(lines, 'Asks')!.color, by(lines, 'Bids')!.color], ['above', 'below']);
  assert.deepEqual([by(lines, 'Asks')!.text, by(lines, 'Bids')!.text], ['$10M', '$30M'], 'amounts are written the way the delta below them is');
  assert.equal(by(lines, 'Δ')!.text, '+$20M'); assert.equal(by(lines, 'Δ')!.color, 'below', 'bids lead');
  assert.deepEqual([by(lines, 'Imbalance')!.text, by(lines, 'Imbalance')!.color], ['bids +50.0%', 'below']);
  assert.equal(by(lines, 'Range')!.text, '±20%');
  assert.equal(by(lines, 'Rank in view')!.text, '3 of 120');
  const last = lines.at(-1)!;
  assert.deepEqual([last.color, last.wrap, last.rule], ['muted', true, true], 'the last line says what the numbers are');

  const ask = depthCardLines({ time: 0, bid: 1_000_000, ask: 3_000_000, range: 0.05, rank: null, of: 1 });
  assert.equal(by(ask, 'Δ')!.color, 'above'); assert.equal(by(ask, 'Imbalance')!.text, 'asks +50.0%'); assert.equal(by(ask, 'Range')!.text, '±5%');
  assert.equal(by(ask, 'Rank in view'), undefined, 'a rank among one is not said');
  const even = depthCardLines({ time: 0, bid: 5_000_000, ask: 5_000_000, range: 0.01, rank: 1, of: 2 });
  assert.equal(by(even, 'Imbalance')!.text, '0%'); assert.equal(by(even, 'Δ')!.color, 'text'); assert.equal(by(even, 'Range')!.text, '±1%');
});

test('the Liquidity Tracker popup says what it was worked out with', () => {
  const lines = ltCardLines({ time: 0, bid: 8_000_000, ask: 12_000_000, halfLifeBp: 25, venues: 7 });
  assert.equal(lines[0]!.text, 'Liquidity Tracker');
  assert.deepEqual([by(lines, 'Bid')!.color, by(lines, 'Ask')!.color], ['below', 'above']);
  assert.equal(by(lines, 'Δ')!.text, '−$4M'); assert.equal(by(lines, 'Δ')!.color, 'above');
  assert.equal(by(lines, 'Half-life')!.text, '25 bp'); assert.equal(by(lines, 'Venues')!.text, '7');
  assert.equal(lines.at(-1)!.rule, true);
  assert.equal(by(ltCardLines({ time: 0, bid: 0, ask: 0, halfLifeBp: 10, venues: 0 }), 'Imbalance'), undefined, 'no liquidity: no balance to speak of');
});

test('the open-interest popup has the level and the step, and only the lines that have something to say', () => {
  const full = oiCardLines({ time: 0, level: 12_345.6, change: 150, before: -20, rank: 2, of: 40, sigma: 3.456, source: 'from Binance BTCUSDT', staleMin: null });
  assert.equal(full[0]!.text, 'Open Interest');
  assert.equal(by(full, 'Open interest')!.text, '12,346', 'as the pane readout writes it: whole units'); assert.equal(by(full, 'Open interest')!.bold, true);
  assert.deepEqual([by(full, 'Δ')!.text, by(full, 'Δ')!.color], ['+150', 'below']);
  assert.equal(by(full, 'Candle before')!.text, '−20');
  assert.equal(by(full, 'Rank in view')!.text, '2 of 40');
  assert.equal(by(full, 'Unusual')!.text, '3.5σ above its baseline');
  assert.ok(full.some(line => line.text === 'from Binance BTCUSDT' && line.color === 'muted'));
  const first = oiCardLines({ time: 0, level: 100, change: null, before: null, rank: null, of: 0, sigma: null, source: null, staleMin: 7 });
  assert.equal(by(first, 'Δ'), undefined, 'the first bar has no bar before it to be compared with');
  assert.equal(by(first, 'Unusual'), undefined);
  assert.ok(first.some(line => line.text === 'last sample 7 min ago' && line.color === 'above'));
});

test('every popup fits the box: no line is left without text, and a long sentence is wrapped, not run off the side', () => {
  const measure = (text: string): number => text.length * 6;
  for (const lines of [
    depthCardLines({ time: 0, bid: 1, ask: 2, range: 0.2, rank: 1, of: 2 }),
    ltCardLines({ time: 0, bid: 1, ask: 2, halfLifeBp: 10, venues: 3 }),
    oiCardLines({ time: 0, level: 1, change: 1, before: 1, rank: 1, of: 2, sigma: 2, source: 'from X', staleMin: 1 }),
  ]) {
    assert.ok(lines.every(line => line.text.length > 0));
    const laid = layoutInfo(measure, lines);
    assert.ok(laid.width <= 250 + 16 + 8, `the box is ${laid.width} px wide`);
  }
});

test('looking at the past, the open-interest line carries the last visible level to the edge instead of joining the newest value', () => {
  assert.deepEqual(oiTail(10, 9, 700, 800), { x: 700, live: true }, 'the newest sample is on screen: the line ends at its centre');
  assert.deepEqual(oiTail(10, 4, 700, 800), { x: 800, live: false }, 'the newest is further right than the view: hold the level to the edge');
});
