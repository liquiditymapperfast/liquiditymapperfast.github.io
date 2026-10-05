import test from 'node:test';
import assert from 'node:assert/strict';
import { applyBookDelta, applySortedDelta, bookFromSnapshot, sortedBook, sortedBookFromSortedSnapshot } from '../src/core/normalize.mts';

function lcg(seed: number) { let s = seed >>> 0; return () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 2 ** 32; }; }
type Pair = [number, number];

/** Random rows as a venue adapter might emit them: tuples or objects, sometimes with metadata, duplicates, junk. */
function rows(rand: () => number, count: number, descending: boolean, dirty: boolean): unknown[] {
  const prices = new Set<number>(); while (prices.size < count) prices.add(1 + Math.floor(rand() * 80));
  const sorted = [...prices].sort((a, b) => descending ? b - a : a - b);
  const out: unknown[] = sorted.map(price => {
    const amount = rand() < 0.1 ? 0 : 1 + Math.floor(rand() * 9);
    const roll = rand();
    if (roll < 0.3) return [price, amount];
    if (roll < 0.4) return [String(price), String(amount)];
    if (dirty && roll < 0.47) return { price, amount, notionalUsd: price * amount };
    return { price, amount };
  });
  if (dirty) {
    if (rand() < 0.3 && out.length) out.splice(Math.floor(rand() * out.length), 0, out[0]);
    if (rand() < 0.2) out.push({ price: Number.NaN, amount: 1 });
    if (rand() < 0.2) out.reverse();
  }
  return out;
}

test('the sorted-snapshot fast path equals sortedBook(bookFromSnapshot()) whenever it answers, and answers for clean snapshots', () => {
  const rand = lcg(77);
  let fast = 0, total = 0;
  for (let round = 0; round < 3000; round++) {
    const dirty = rand() < 0.5;
    const snapshot: Record<string, unknown> = { complete: true, sequence: round, bids: rows(rand, Math.floor(rand() * 30), true, dirty), asks: rows(rand, Math.floor(rand() * 30), false, dirty) };
    if (dirty && rand() < 0.2) snapshot.levelMetadata = { bids: { 5: { coarse: true } }, asks: {} };
    const expected = sortedBook(bookFromSnapshot(snapshot), { includeMetadata: true });
    const quick = sortedBookFromSortedSnapshot(snapshot);
    total++;
    if (quick === null) { assert.ok(dirty, `round ${round}: a clean snapshot must take the fast path`); continue; }
    fast++;
    assert.deepEqual(quick, expected, `round ${round}: ${JSON.stringify(snapshot)}`);
  }
  assert.ok(fast > total * 0.5, `fast path used ${fast}/${total}`);
});

test('the sorted-delta fast path equals applyBookDelta + sortedBook + cap whenever it answers', () => {
  const rand = lcg(4242);
  let fast = 0, total = 0, gaps = 0;
  for (let round = 0; round < 4000; round++) {
    const limit = rand() < 0.3 ? 1 + Math.floor(rand() * 20) : 1000;
    const startSnapshot = { complete: true, sequence: 100, bids: rows(rand, Math.floor(rand() * 35), true, false), asks: rows(rand, Math.floor(rand() * 35), false, false) };
    const previous = sortedBook(bookFromSnapshot(startSnapshot), { includeMetadata: true }) as { bids: Pair[]; asks: Pair[]; levelMetadata: { bids: Record<string, unknown>; asks: Record<string, unknown> } } & { sequence?: unknown };
    previous.sequence = 100;
    if (rand() < 0.1) previous.levelMetadata = { bids: { [previous.bids[0]?.[0] ?? 1]: { coarse: true } }, asks: {} };
    const dirty = rand() < 0.3;
    const ups = (descending: boolean) => {
      const out: unknown[] = [];
      for (let k = Math.floor(rand() * (rand() < 0.05 ? 100 : 12)); k > 0; k--) {
        const price = 1 + Math.floor(rand() * 90), amount = rand() < 0.3 ? 0 : 1 + Math.floor(rand() * 9), roll = rand();
        out.push(roll < 0.35 ? [price, amount] : roll < 0.45 ? [String(price), String(amount)] : dirty && roll < 0.5 ? { price, amount, notionalUsd: 5 } : { price, amount });
      }
      return descending ? out : out;
    };
    const delta: Record<string, unknown> = { bids: ups(true), asks: ups(false), sequence: 101 };
    const roll = rand();
    if (roll < 0.5) delta.previousSequence = 100; else if (roll < 0.6) delta.previousSequence = 99; else if (roll < 0.65) delete delta.sequence;
    const quick = applySortedDelta(previous, delta, limit);
    total++;
    const book = applyBookDelta(bookFromSnapshot({ complete: true, sequence: previous.sequence, bids: previous.bids.map(([price, amount]) => ({ price, amount })), asks: previous.asks.map(([price, amount]) => ({ price, amount })), levelMetadata: previous.levelMetadata }), delta);
    if (quick === null) continue;
    fast++;
    if (book.status === 'gap') { gaps++; assert.deepEqual(quick, { gap: true }, `round ${round}`); continue; }
    const sorted = sortedBook(book, { includeMetadata: true });
    assert.ok(!quick.gap);
    assert.deepEqual(quick.bids, sorted.bids.slice(0, limit), `round ${round} bids ${JSON.stringify({ previous, delta, limit })}`);
    assert.deepEqual(quick.asks, sorted.asks.slice(0, limit), `round ${round} asks`);
    assert.equal(quick.sequence, book.sequence, `round ${round} sequence`);
    assert.deepEqual(quick.levelMetadata, { bids: {}, asks: {} });
  }
  assert.ok(fast > total * 0.5, `fast path used ${fast}/${total}`);
  assert.ok(gaps > 50, `sequence gaps were exercised (${gaps})`);
});

test('fast paths decline what they cannot prove: metadata, unsorted books, junk rows', () => {
  const book = { bids: [[3, 1], [2, 1]] as Pair[], asks: [[4, 1], [5, 1]] as Pair[], sequence: 1, levelMetadata: { bids: {}, asks: {} } };
  assert.ok(applySortedDelta(book, { bids: [[2.5, 1]], asks: [] }, 10));
  assert.equal(applySortedDelta({ ...book, levelMetadata: { bids: { 3: { coarse: true } }, asks: {} } }, { bids: [], asks: [] }, 10), null);
  assert.equal(applySortedDelta({ ...book, bids: [[2, 1], [3, 1]] }, { bids: [[9, 1]], asks: [] }, 10), null, 'retained side not best-first');
  assert.equal(applySortedDelta(book, { bids: [{ price: 2.5, amount: 1, notionalUsd: 3 }], asks: [] }, 10), null, 'row metadata');
  assert.equal(applySortedDelta(book, { bids: [[Number.NaN, 1]], asks: [] }, 10), null, 'invalid price');
  assert.equal(sortedBookFromSortedSnapshot({ bids: [[3, 1], [3, 2]], asks: [] }), null, 'duplicate price');
  assert.equal(sortedBookFromSortedSnapshot({ bids: [{ price: 3, amount: 1, extra: true }], asks: [] }), null, 'extra row fields');
  assert.deepEqual(sortedBookFromSortedSnapshot({ bids: [[3, 1]], asks: null }), { bids: [[3, 1]], asks: [], levelMetadata: { bids: {}, asks: {} } });
});

test('the sorted-delta fast path hands very large diffs to the general path', () => {
  const book = { bids: Array.from({ length: 50 }, (_, i) => [1000 - i, 1] as Pair), asks: [[1001, 1]] as Pair[], sequence: 1, levelMetadata: { bids: {}, asks: {} } };
  const big = Array.from({ length: 450 }, (_, i) => [2000 + i, 1]);
  assert.equal(applySortedDelta(book, { bids: big, asks: [], sequence: 2 }, 5000), null);
  assert.ok(applySortedDelta(book, { bids: big.slice(0, 300), asks: [], sequence: 2 }, 5000));
});
