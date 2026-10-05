import test from 'node:test';
import assert from 'node:assert/strict';
import { MAX_CROSSED_BP, crossedByBp, valueBook, type SideLevels } from '../src/server/v2/levels.mts';

const T0 = Date.UTC(2026, 9, 5, 12);
const side = (...prices: number[]): SideLevels => ({ lo: Float64Array.from(prices), hi: Float64Array.from(prices), usd: Float64Array.from(prices.map(() => 1_000)) });
const book = (bids: number[], asks: number[], coarse = false) => ({ bids: side(...bids), asks: side(...asks), coarse });

test('a healthy book is not crossed, whatever order its levels arrive in', () => {
  assert.equal(crossedByBp(book([100, 99.9, 99.8], [100.1, 100.2, 100.3])), 0);
  assert.equal(crossedByBp(book([99.8, 100, 99.9], [100.3, 100.1, 100.2])), 0, 'the extremes decide, not the first element');
  assert.equal(crossedByBp(book([100], [100])), 0, 'a locked book (bid equal to ask) is not crossed');
});

test('bids above asks are reported in basis points from the extremes, as measured on a faulty Kraken feed', () => {
  // Bids reach 86 466, asks start at 85 859: about 70 bp, with the levels in no useful order.
  const cross = crossedByBp(book([85_700, 86_466.2, 86_464], [86_597.9, 85_859, 85_861.7]));
  assert.ok(Math.abs(cross - (86_466.2 - 85_859) / ((86_466.2 + 85_859) / 2) * 1e4) < 1e-9);
  assert.ok(cross > 60 && cross > MAX_CROSSED_BP);
  assert.ok(crossedByBp(book([100.02], [100])) < MAX_CROSSED_BP, 'a tick of crossing in a fast market stays under the limit');
});

test('empty sides and aggregated provider bands are not judged', () => {
  assert.equal(crossedByBp(book([], [100])), 0); assert.equal(crossedByBp(book([100], [])), 0);
  // Hyperliquid names the lower edge of a wide band, and the bid band at the touch can reach past the ask band's lower edge.
  assert.equal(crossedByBp(book([100.5], [100], true)), 0);
});

test('a crossed raw book is caught after valuation', () => {
  const crossed = valueBook('kraken:BTC/USD', { bids: [[86_466.2, 1], [86_464, 2]], asks: [[85_859, 1], [86_597.9, 2]], units: 'base', sourceTimestamp: T0 }, { venue: 'kraken', quote: 'USD', quantityUnit: 'base' }, T0)!;
  assert.ok(crossedByBp(crossed) > MAX_CROSSED_BP);
  const fine = valueBook('kraken:BTC/USD', { bids: [[86_406.8, 1]], asks: [[86_406.9, 2]], units: 'base', sourceTimestamp: T0 }, { venue: 'kraken', quote: 'USD', quantityUnit: 'base' }, T0)!;
  assert.equal(crossedByBp(fine), 0);
});
