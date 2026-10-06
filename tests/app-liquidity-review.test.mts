import test from 'node:test';
import assert from 'node:assert/strict';
import { beyondCover, coverage, liquidityInView } from '../src/app/panes/levels-data.ts';
import { imbalanceFlags } from '../src/app/panes/pane-cards.ts';
import { FootprintData } from '../src/app/panes/footprint.ts';
import { PrintBook, topPrints, type Print } from '../src/app/prints.ts';
import { heatmapSourceOf } from '../src/app/scope.ts';
import { dropAbsent } from '../src/app/worker/membership.ts';
import type { LiveBook } from '../src/app/wire.ts';
import type { FootprintResponse } from '../src/app/source.ts';

// What an independent review found wrong in the liquidity panes, the prints and the footprint, each as the smallest case that shows it.

const side = (levels: [number, number, number][]) => ({ lo: Float64Array.from(levels.map(l => l[0])), hi: Float64Array.from(levels.map(l => l[1])), usd: Float64Array.from(levels.map(l => l[2])) });
const book = (bids: [number, number, number][], asks: [number, number, number][]): LiveBook => ({ id: 'a:BTC', venue: 'a', timestamp: 0, coarse: false, bids: side(bids), asks: side(asks) });

test('the highest price a book reaches is inside its row when it is a single price, and outside the row that starts at the end of a band', () => {
  const point = coverage(book([[99, 99, 5]], [[101, 101, 5]]), 100)!;           // an ask at exactly 101
  assert.equal(point.hiPoint, true);
  assert.equal(beyondCover(point, 101, 0.5), false, 'the row that holds the 101 ask is covered (it was hidden)');
  assert.equal(beyondCover(point, 100.5, 0.5), false);
  assert.equal(beyondCover(point, 101.5, 0.5), true, 'the next row is beyond');
  const band = coverage(book([[99, 99, 5]], [[100.5, 101, 5]]), 100)!;          // an ask spread over [100.5, 101)
  assert.equal(band.hiPoint, false);
  assert.equal(beyondCover(band, 100.5, 0.5), false);
  assert.equal(beyondCover(band, 101, 0.5), true, 'a band does not reach its upper edge');
  assert.equal(beyondCover(point, 98, 0.5), true, 'below the lowest bid, by a whole row');
  assert.equal(beyondCover(point, 98.5, 0.5), true, 'a row that ends at the lowest price does not hold it (the end of a row is not in it)');
  assert.equal(beyondCover(point, 99, 0.5), false, 'the row that starts at it does');
});

test('the balance bar counts what is on screen, whether or not the ladder is scrolled away from the mark', () => {
  // bins 0..9; the mark's bin is 5. Bids sit at and below it, asks at and above.
  const totalBid = Float32Array.from([1, 2, 4, 8, 16, 32, 0, 0, 0, 0]), totalAsk = Float32Array.from([0, 0, 0, 0, 0, 64, 128, 256, 512, 1024]);
  const grid = { nBins: 10, totalBid, totalAsk };
  assert.deepEqual(liquidityInView(grid, 5, 3, 7), { bid: 8 + 16 + 32, ask: 64 + 128 + 256 });
  assert.deepEqual(liquidityInView(grid, 5, 6, 9), { bid: 0, ask: 128 + 256 + 512 + 1024 }, 'scrolled up past the mark: no bid is on screen, and the one at the mark is not counted');
  assert.deepEqual(liquidityInView(grid, 5, 0, 2), { bid: 7, ask: 0 }, 'scrolled down: only bids are on screen');
  assert.deepEqual(liquidityInView(grid, 5, -4, 100), { bid: 63, ask: 1984 }, 'a view wider than the grid is kept to it');
});

test('the heatmap shows the aggregate while its chosen venue has no book, and the choice stands', () => {
  const levels = { asOf: 0, books: [book([[99, 99, 1]], [[101, 101, 1]])] };
  assert.equal(heatmapSourceOf({ heatmapSource: 'a:BTC', levels }), 'a:BTC');
  assert.equal(heatmapSourceOf({ heatmapSource: 'gone:BTC', levels }), 'aggregated', 'the dropdown said so; the map drew the missing venue');
  assert.equal(heatmapSourceOf({ heatmapSource: 'gone:BTC', levels: null }), 'gone:BTC', 'before the first frame nothing is known');
  assert.equal(heatmapSourceOf({ heatmapSource: 'aggregated', levels }), 'aggregated');
});

test('a cache of live books forgets the ones a frame no longer lists', () => {
  const cache = new Map([['a', 1], ['b', 2], ['c', 3]]);
  dropAbsent(cache, ['a', 'c', 'x']);
  assert.deepEqual([...cache.keys()], ['a', 'c']);
});

// ---- the Depth pane's emphasis ------------------------------------------------------------------------------------------------------------

test('Depth stands out where the imbalance is unusual for the page rule, not where it crosses a fixed line', () => {
  const n = 100, bid = new Float32Array(n), ask = new Float32Array(n);
  for (let i = 0; i < n; i++) { bid[i] = 1_000_000 + (i % 2) * 100_000; ask[i] = 1_000_000 - (i % 2) * 100_000; }   // always a little bid-heavy, steadily
  bid[80] = 3_000_000; ask[80] = 500_000;                                                                           // one column far out of line
  const flags = imbalanceFlags(bid, ask, { length: 72, mult: 2 }, 1);
  assert.equal(flags[80], 1);
  assert.equal(flags.reduce((sum, f) => sum + f, 0), 1, 'and only that one');
  assert.equal(imbalanceFlags(bid, ask, { length: 72, mult: 20 }, 1)[80], 0, 'a stricter sensitivity does not flag it');
  assert.equal(imbalanceFlags(bid.slice(0, 10), ask.slice(0, 10), { length: 72, mult: 2 }, 1).every(f => f === 0), true, 'nothing is flagged until a dozen columns exist');
  const empty = new Float32Array(n);
  assert.equal(imbalanceFlags(empty, empty, { length: 72, mult: 2 }, 1).every(f => f === 0), true, 'no liquidity, nothing to flag');
});

// ---- prints -----------------------------------------------------------------------------------------------------------------------------------

const print = (t: number, usd: number): Print => ({ t, id: 'x:BTC', side: 'buy', price: 100, usd });

test('at a tie for the last place the bigger print is kept, and among equals the newest', () => {
  const items = [print(1, 1_000_000), print(2, 100_000), print(3, 100_000)];
  assert.deepEqual(topPrints(items, 0, 10, 0, 1_000, 2).map(p => p.usd), [1_000_000, 100_000], 'the million lost to two later 100,000s');
  assert.deepEqual(topPrints(items, 0, 10, 0, 1_000, 2).map(p => p.t), [1, 3]);
  const equal = [print(1, 50_000), print(2, 50_000), print(3, 50_000), print(4, 50_000)];
  assert.deepEqual(topPrints(equal, 0, 10, 0, 1_000, 2).map(p => p.t), [3, 4]);
  assert.deepEqual(topPrints(items, 0, 10, 0, 1_000, 3).map(p => p.t), [1, 2, 3], 'room for all of them');
});

test('a window of history that was fetched stays in the book when the book is full of newer prints', () => {
  const book = new PrintBook(5);
  book.add([100, 101, 102, 103, 104].map(t => print(t, 30_000)));
  const history = [10, 11, 12].map(t => print(t, 40_000));
  book.add(history, { from: 0, to: 50 });
  assert.deepEqual(book.items.map(p => p.t), [10, 11, 12, 103, 104], 'the history that was asked for is there; the oldest of the rest went (it was trimmed away as soon as it arrived)');
  book.add([print(105, 30_000), print(106, 30_000)]);
  assert.deepEqual(book.items.map(p => p.t), [10, 11, 12, 105, 106], 'and it stays while the live stream goes on');
  book.add([print(1_000, 30_000)], undefined);
  assert.equal(book.items.length, 5);
  const wide = new PrintBook(3); wide.add([1, 2, 3, 4, 5].map(t => print(t, 10_000)), { from: 0, to: 100 });
  assert.deepEqual(wide.items.map(p => p.t), [3, 4, 5], 'a window bigger than the book is trimmed from its oldest end');
});

// ---- the footprint ----------------------------------------------------------------------------------------------------------------------------

const turn = (): Promise<void> => new Promise(resolve => setImmediate(resolve));
const answer = (t: number): FootprintResponse => ({ step: 5, fine: 5, bars: [{ t, rows: [[100, 5, 5]], buyUsd: 5, sellUsd: 5 }] });

test('rows of another market do not stay on the footprint, whether its request is late or fails', async () => {
  const view = { t0: 0, t1: 3_600_000 * 5, p0: 0, p1: 1 };
  const waiting = new Map<string, { resolve(r: FootprintResponse): void; reject(error: Error): void }>();
  const load = (inst: string) => new Promise<FootprintResponse>((resolve, reject) => { waiting.set(inst, { resolve, reject }); });
  const log = console.error; console.error = () => {};
  try {
    const data = new FootprintData(); let loads = 0;
    data.ensure('A', '1h', view, 5, load, () => { loads++; });
    data.ensure('B', '1h', view, 5, load, () => { loads++; });                      // asked for B while A is still out: B is asked for at once
    assert.ok(waiting.has('B'), 'the selection changed, and nothing waits for the old request');
    waiting.get('A')!.resolve(answer(0)); await turn();
    assert.equal(data.bars.size, 0, 'a late answer for A is not B\'s rows');
    waiting.get('B')!.resolve(answer(3_600_000)); await turn();
    assert.deepEqual([...data.bars.keys()], [3_600_000]);

    data.ensure('C', '1h', view, 5, load, () => { loads++; });
    assert.equal(data.bars.size, 0, 'B\'s rows go as soon as another market is chosen');
    waiting.get('C')!.reject(new Error('the server said no')); await turn();
    assert.equal(data.bars.size, 0, 'and a failed request leaves C with none rather than with B\'s');
    assert.equal(loads, 1);
  } finally { console.error = log; }
});
