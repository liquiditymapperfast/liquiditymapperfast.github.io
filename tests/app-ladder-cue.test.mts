import test from 'node:test';
import assert from 'node:assert/strict';
import { cumulative, dominanceWeight, imbalanceByDistance, liquidityWithin, type Grouped } from '../src/app/panes/levels-data.ts';

/** Unit-wide bins from price 0: the bids fill the lowest bins, one empty bin holds the mark, and the asks fill the bins above it. */
const grid = (bids: number[], asks: number[]): { g: Grouped; mark: number; markBin: number } => {
  const nBins = bids.length + 1 + asks.length, markBin = bids.length;
  const totalBid = Float32Array.from([...bids, 0, ...asks.map(() => 0)]), totalAsk = Float32Array.from([...bids.map(() => 0), 0, ...asks]);
  return { g: { ids: ['x'], step: 1, bin0: 0, nBins, bid: [totalBid], ask: [totalAsk], totalBid, totalAsk } as Grouped, mark: markBin + 0.5, markBin };
};

test('the balance at each distance compares what both sides hold within that distance, and rows the same distance apart agree', () => {
  // Bids are heavy near the mark (the last bid bin is the best bid), asks are even all the way out.
  const bids = [1, 1, 1, 1, 1, 1, 1, 10, 10, 10], asks = [1, 1, 1, 1, 1, 1, 1, 1, 1, 1];
  const { g, mark, markBin } = grid(bids, asks);
  const cum = cumulative(g, mark);
  const imbalance = imbalanceByDistance(g, cum, markBin, 1);
  assert.ok(imbalance[markBin - 1]! > 0.5, 'right next to the mark the bids dominate');
  for (let d = 1; d <= 9; d++) assert.ok(Math.abs(imbalance[markBin - d]! - imbalance[markBin + d]!) < 1e-6, `distance ${d} reads the same on both sides`);
  assert.ok(imbalance[markBin + 9]! < imbalance[markBin + 1]!, 'the advantage shrinks as the asks catch up with distance');
  const flat = grid([5, 5, 5, 5, 5, 5, 5, 5, 5, 5], [5, 5, 5, 5, 5, 5, 5, 5, 5, 5]);
  const flatImbalance = imbalanceByDistance(flat.g, cumulative(flat.g, flat.mark), flat.markBin, 1);
  assert.ok([...flatImbalance].every(v => Math.abs(v) < 1e-6), 'a balanced book has no dominant side');
});

test('very close to the mark the ratio is taken at a minimum distance, and a mark outside the grid gives no cue', () => {
  // The touch is all bids (100 against 1), but a large ask sits four rows out.
  const { g, mark, markBin } = grid([0, 0, 0, 0, 0, 0, 0, 0, 0, 100], [1, 0, 0, 500, 0, 0, 0, 0, 0, 0]);
  const cum = cumulative(g, mark);
  const raw = imbalanceByDistance(g, cum, markBin, 1), steady = imbalanceByDistance(g, cum, markBin, 4);
  assert.ok(raw[markBin - 1]! > 0.9 && raw[markBin + 1]! > 0.9, 'at one row the touch alone decides');
  assert.equal(steady[markBin - 1], steady[markBin - 4], 'rows nearer than the minimum take the value at the minimum');
  assert.ok(steady[markBin - 1]! < 0, 'and that value already sees the large ask');
  assert.ok([...imbalanceByDistance(g, cum, -1)].every(v => v === 0) && [...imbalanceByDistance(g, cum, 99)].every(v => v === 0));
});

test('the balance bar uses the cumulative liquidity within the visible range, clamped to what exists', () => {
  const { g, mark, markBin } = grid([1, 2, 3, 4], [10, 20, 30, 40]);
  const cum = cumulative(g, mark);
  assert.deepEqual(liquidityWithin(g, cum, markBin, 2), { bid: 7, ask: 30 }, 'two rows out: bids 4+3 under the mark, asks 10+20 above it');
  assert.deepEqual(liquidityWithin(g, cum, markBin, 99), { bid: 10, ask: 100 }, 'beyond the grid it is everything');
  assert.deepEqual(liquidityWithin(g, cum, -3, 2), { bid: 0, ask: 0 });
});

test('the dominant side gets stronger, the weaker side fades, and a balanced book is unchanged', () => {
  assert.equal(dominanceWeight(0, true), 1); assert.equal(dominanceWeight(0, false), 1);
  assert.ok(dominanceWeight(0.15, true) > 1 && dominanceWeight(0.15, false) < 1);
  assert.equal(dominanceWeight(0.3, true), 1.25); assert.equal(dominanceWeight(0.3, false), 0.5);
  assert.equal(dominanceWeight(0.9, true), 1.25, 'the effect saturates');
  assert.ok(dominanceWeight(-0.2, false) > 1 && dominanceWeight(-0.2, true) < 1, 'asks dominating flips it');
  assert.ok(dominanceWeight(0.1, true) < dominanceWeight(0.2, true), 'stronger imbalance, stronger cue');
});
