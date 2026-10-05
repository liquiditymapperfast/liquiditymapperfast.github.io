import test from 'node:test';
import assert from 'node:assert/strict';
import { annotateBookCoverage, summarizeBookCoverage } from '../src/core/book-coverage.mts';

test('source coverage remains distinct from retained rows', () => {
  const book = annotateBookCoverage({
    complete: true,
    coverage: 'partial',
    coverageBounds: { bids: { min: 90, max: 100 }, asks: { min: 101, max: 111 } },
    sourceLevelCount: { bids: 1_000, asks: 1_000 },
    bids: [[100, 1], [99, 1]], asks: [[101, 1], [102, 1]],
  }, { bids: [[100, 1]], asks: [[101, 1]] });
  assert.deepEqual(book.sourceLevelCount, { bids: 1_000, asks: 1_000 });
  assert.deepEqual(book.retainedLevelCount, { bids: 1, asks: 1 });
  assert.deepEqual(book.observedBounds, { bids: { min: 100, max: 100 }, asks: { min: 101, max: 101 } });
  assert.deepEqual(book.coverageBounds, { bids: { min: 90, max: 100 }, asks: { min: 101, max: 111 } });
  assert.equal(book.retentionTruncated, true);
  assert.equal(book.complete, true);
  assert.equal(book.coverage, 'partial');
});

test('REST and compact/SSE representations retain the same source metadata', () => {
  const source = annotateBookCoverage({
    coverage: 'partial',
    sourceLevelCount: { bids: 1_000, asks: 1_000 },
    coverageBounds: { bids: { min: 90, max: 100 }, asks: { min: 101, max: 111 } },
    bids: Array.from({ length: 1_000 }, (_, index) => [100 - index / 10, 1]),
    asks: Array.from({ length: 1_000 }, (_, index) => [101 + index / 10, 1]),
  });
  const compact = annotateBookCoverage(source, { bids: source.bids.slice(0, 400), asks: source.asks.slice(0, 400) });
  assert.deepEqual(compact.sourceLevelCount, source.sourceLevelCount);
  assert.deepEqual(compact.coverageBounds, source.coverageBounds);
  assert.equal(source.retentionTruncated, false);
  assert.equal(compact.retentionTruncated, true);
  assert.notDeepEqual(compact.observedBounds, source.observedBounds);
});

test('missing levels produce unknown observed bounds instead of invented zeros', () => {
  const summary = summarizeBookCoverage({ coverage: 'partial', sourceLevelCount: { bids: 20, asks: 20 } }, { bids: [], asks: [] });
  assert.deepEqual(summary.observedBounds, { bids: null, asks: null });
  assert.equal(summary.retentionTruncated, true);
});
