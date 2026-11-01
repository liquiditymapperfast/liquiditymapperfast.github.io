import test from 'node:test';
import assert from 'node:assert/strict';
import { bookSide } from '../src/app/panes/heat-pane.ts';

test('the map hover names the side of the book that holds more, and nothing for an empty cell', () => {
  assert.equal(bookSide({ bid: 2e6, ask: 5e5 }), 'bid');
  assert.equal(bookSide({ bid: 0, ask: 3e6 }), 'ask');
  assert.equal(bookSide({ bid: 1e6, ask: 1e6 }), 'bid');
  // Right of the live edge, in a gap or beyond the prices recorded the cell holds nothing: no line, where it read "Bid $0" even above
  // the price (Karl, 2026-11-01, on a liquidation level 2 % above it).
  assert.equal(bookSide({ bid: 0, ask: 0 }), null);
  assert.equal(bookSide({ bid: NaN, ask: 0 }), null);
  assert.equal(bookSide(null), null);
});
