import { defined, fields, list, numeric, textValue, injectArrayFixture } from './server-test-helpers.mts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { HeatmapRetentionBuffer, } from '../src/core/heatmap-retention.mts';

test('retention oracle computes duration-weighted mean and peak', () => {
  const buffer = new HeatmapRetentionBuffer({ intervalMs: 60_000, priceStep: 1, maxGapMs: 120_000 });
  buffer.ingest('test:BTC', { bids: [[100, 10]], asks: [] }, { sourceTimestamp: 60_000, receivedAt: 60_000 });
  buffer.ingest('test:BTC', { bids: [[100, 30]], asks: [] }, { sourceTimestamp: 75_000, receivedAt: 75_000 });
  buffer.ingest('test:BTC', { bids: [[100, 30]], asks: [] }, { sourceTimestamp: 120_001, receivedAt: 120_001 });
  const row = buffer.drainClosed().find((item) => item.side === 'bid' && item.priceLow === 100);
  assert.ok(row);
  assert.equal(row.observedMs, 60_000);
  assert.equal(row.meanAmount, 25);
  assert.equal(row.peakAmount, 30);
  assert.equal(row.coverage, 'complete');
});

test('retention marks long gaps partial instead of zero-filling them', () => {
  const buffer = new HeatmapRetentionBuffer({ intervalMs: 60_000, priceStep: 1, maxGapMs: 60_000 });
  buffer.ingest('test:BTC', { bids: [[100, 10]], asks: [] }, { sourceTimestamp: 1, receivedAt: 1 });
  buffer.ingest('test:BTC', { bids: [[100, 10]], asks: [] }, { sourceTimestamp: 30_001, receivedAt: 30_001 });
  buffer.ingest('test:BTC', { bids: [[100, 20]], asks: [] }, { sourceTimestamp: 180_001, receivedAt: 180_001 });
  const rows = buffer.drainClosed();
  assert.ok(rows.some((row) => row.gapMs > 0 && (row.coverage === 'partial' || row.coverage === 'gap')));
  assert.ok(rows.filter((row) => row.side === 'bid').every((row) => row.meanAmount == null || row.meanAmount >= 10));
});

test('retention cell capacity is bounded', () => {
  const buffer = new HeatmapRetentionBuffer({ intervalMs: 60_000, priceStep: 1, maxCellsPerBucket: 2, maxClosedRows: 3 });
  buffer.ingest('a', { bids: [[1, 1], [2, 1], [3, 1]], asks: [] }, { sourceTimestamp: 1 });
  buffer.ingest('a', { bids: [[1, 1], [2, 1], [3, 1]], asks: [] }, { sourceTimestamp: 60_001 });
  buffer.ingest('b', { bids: [[1, 1], [2, 1]], asks: [] }, { sourceTimestamp: 1 });
  buffer.ingest('b', { bids: [[1, 1], [2, 1]], asks: [] }, { sourceTimestamp: 60_001 });
  const stats = buffer.stats();
  assert.ok(stats.activeCells <= 4);
  assert.ok(stats.closedRows <= 3);
});

test('retention refuses new sources at capacity instead of silently evicting history', () => {
  const buffer = new HeatmapRetentionBuffer({ intervalMs: 60_000, priceStep: 1, maxSources: 1 });
  assert.equal(buffer.ingest('kept', { bids: [[100, 1]], asks: [] }, { sourceTimestamp: 60_000 }).accepted, true);
  assert.deepEqual(buffer.ingest('new', { bids: [[200, 1]], asks: [] }, { sourceTimestamp: 60_000 }), { accepted: false, reason: 'source-capacity' });
  assert.equal(buffer.sources.has('kept'), true);
  assert.equal(buffer.sources.has('new'), false);
  assert.equal(buffer.stats().droppedRows, 0);
  assert.equal(buffer.stats().sourceCapacityRejects, 1);
  assert.ok(buffer.reclaimSourceForBudget('kept'));
  assert.equal(buffer.sources.has('kept'), false);
  assert.equal(buffer.sourceTombstones.has('kept'), true);
  assert.equal(buffer.ingest('new', { bids: [[200, 1]], asks: [] }, { sourceTimestamp: 60_000 }).accepted, true);
});

test('source budget reclaim checks closed-row capacity before changing a source', () => {
  const buffer = new HeatmapRetentionBuffer({ intervalMs: 60_000, priceStep: 1, maxClosedRows: 1 });
  buffer.ingest('kept', { bids: [[100, 1]], asks: [] }, { sourceTimestamp: 60_000 });
  buffer.ingest('kept', { bids: [[100, 1]], asks: [] }, { sourceTimestamp: 75_000 });
  injectArrayFixture(buffer.closedRows, { instrumentId: 'other', bucketStart: 0 });
  assert.equal(buffer.reclaimSourceForBudget('kept'), null);
  assert.equal(defined(buffer.sources.get('kept')).levels.length, 1);
  assert.equal(defined(buffer.sources.get('kept')).buckets.size, 1);
  assert.equal(buffer.closedRows.length, 1);
  assert.equal(buffer.stats().droppedRows, 0);
});

test('source budget reclaim fails closed when tombstone capacity is exhausted', () => {
  const buffer = new HeatmapRetentionBuffer({ intervalMs: 60_000, priceStep: 1, maxSources: 2, maxSourceTombstones: 1 });
  buffer.ingest('first', { bids: [[100, 1]], asks: [] }, { sourceTimestamp: 60_000 });
  buffer.ingest('second', { bids: [[200, 1]], asks: [] }, { sourceTimestamp: 60_000 });
  assert.ok(buffer.reclaimSourceForBudget('first'));
  assert.equal(buffer.reclaimSourceForBudget('second'), null);
  assert.equal(defined(buffer.sources.get('second')).levels.length, 1);
  assert.equal(buffer.sourceTombstones.size, 1);
  const stats = buffer.stats();
  const sourceTotal = Object.values(stats.sources).reduce((sum, source) => sum + source.retainedBytesEstimate, 0);
  assert.equal(stats.retainedBytesEstimate, sourceTotal + stats.closedRows * 96);
});

test('retention byte estimate reconciles active levels and bucket metadata per source', () => {
  const buffer = new HeatmapRetentionBuffer({ intervalMs: 60_000, priceStep: 1 });
  buffer.ingest('bytes:a', { bids: [[100, 1], [101, 1]], asks: [[102, 1]] }, { sourceTimestamp: 60_000 });
  buffer.ingest('bytes:b', { bids: [[200, 1]], asks: [[201, 1]] }, { sourceTimestamp: 60_000 });
  const stats = buffer.stats();
  const sourceTotal = Object.values(stats.sources).reduce((sum, source) => sum + source.retainedBytesEstimate, 0);
  assert.equal(stats.retainedBytesEstimate, sourceTotal + stats.closedRows * 96);
  assert.ok(stats.activeLevels > 0);
  assert.equal(stats.activeBuckets, stats.activeBucketMeta);
  assert.equal(stats.bytesEstimate, stats.retainedBytesEstimate);
});
test('retention keeps coarse source cells intact', () => {
  const buffer = new HeatmapRetentionBuffer({ intervalMs: 60_000, priceStep: 50 });
  buffer.ingest('coarse:BTC', { bids: [[101, 2]], asks: [] }, { sourceTimestamp: 60_000, grouping: 100, resolution: 'coarse' });
  buffer.ingest('coarse:BTC', { bids: [[101, 2]], asks: [] }, { sourceTimestamp: 120_001, grouping: 100, resolution: 'coarse' });
  const row = buffer.drainClosed().find((item) => item.side === 'bid');
  assert.ok(row);
  assert.equal(row.priceLow, 100);
  assert.equal(row.priceHigh, 200);
  assert.equal(row.sourceGrouping, 100);
  assert.equal(row.sourceResolution, 'coarse');
});
test('known empty books contribute zero duration to the time-weighted mean', () => {
  const buffer = new HeatmapRetentionBuffer({ intervalMs: 60_000, priceStep: 1 });
  buffer.ingest('test:BTC', { bids: [[100, 10]], asks: [] }, { sourceTimestamp: 60_000, coverage: 'complete' });
  buffer.ingest('test:BTC', { bids: [], asks: [] }, { sourceTimestamp: 75_000, coverage: 'complete' });
  buffer.ingest('test:BTC', { bids: [], asks: [] }, { sourceTimestamp: 120_001, coverage: 'complete' });
  const row = buffer.drainClosed().find((item) => item.side === 'bid' && item.priceLow === 100);
  assert.ok(row);
  assert.equal(row.observedMs, 60_000);
  assert.equal(row.cellObservedMs, 15_000);
  assert.equal(row.meanAmount, 10);
  assert.equal(row.peakAmount, 10);
  assert.deepEqual(row.observedIntervals, [{ start: 60_000, end: 75_000 }]);
});

test('retention separates source epochs when grouping changes mid-bucket', () => {
  const buffer = new HeatmapRetentionBuffer({ intervalMs: 60_000, priceStep: 50 });
  buffer.ingest('epoch:BTC', { bids: [[101, 2]], asks: [] }, { sourceTimestamp: 60_000, coverage: 'complete', resolution: 'native', grouping: 50 });
  buffer.ingest('epoch:BTC', { bids: [[101, 2]], asks: [] }, { sourceTimestamp: 75_000, coverage: 'complete', resolution: 'coarse', grouping: 75 });
  buffer.ingest('epoch:BTC', { bids: [[176, 2]], asks: [] }, { sourceTimestamp: 120_001, coverage: 'complete', resolution: 'coarse', grouping: 75 });
  buffer.ingest('epoch:BTC', { bids: [[176, 2]], asks: [] }, { sourceTimestamp: 180_001, coverage: 'complete', resolution: 'coarse', grouping: 75 });
  const rows = buffer.drainClosed().filter((row) => row.priceLow != null);
  assert.ok(rows.some((row) => row.sourceResolution === 'native' && row.sourceGrouping === 50));
  assert.ok(rows.some((row) => row.sourceResolution === 'coarse' && row.sourceGrouping === 75));
  const epochsByBucket = new Map(); for (const row of rows) { const key = String(row.bucketStart); const prior = epochsByBucket.get(key); if (prior) assert.equal(prior, row.gridEpoch); else epochsByBucket.set(key, row.gridEpoch); }
});

test('new cells begin at their first complete observation without backfilling birth time', () => {
  const buffer = new HeatmapRetentionBuffer({ intervalMs: 60_000, priceStep: 1 });
  buffer.ingest('birth:BTC', { bids: [], asks: [] }, { sourceTimestamp: 60_000, coverage: 'complete' });
  buffer.ingest('birth:BTC', { bids: [[100, 10]], asks: [] }, { sourceTimestamp: 75_000, coverage: 'complete' });
  buffer.ingest('birth:BTC', { bids: [[100, 10]], asks: [] }, { sourceTimestamp: 120_001, coverage: 'complete' });
  const row = buffer.drainClosed().find((item) => item.side === 'bid' && item.priceLow === 100);
  assert.ok(row);
  assert.equal(row.meanAmount, 10);
  assert.equal(row.cellObservedMs, 45_000);
  assert.deepEqual(row.observedIntervals, [{ start: 75_000, end: 120_000 }]);
});

test('current source levels are bounded and truncation is explicit', () => {
  const buffer = new HeatmapRetentionBuffer({ intervalMs: 60_000, priceStep: 1, maxSourceLevels: 2 });
  const result = buffer.ingest('bounded:BTC', { bids: [[100, 1], [101, 1], [102, 1]], asks: [] }, { sourceTimestamp: 60_000, coverage: 'complete' });
  assert.equal(fields(result).truncated, true);
  const stats = buffer.stats();
  assert.equal(stats.activeLevels, 2);
  assert.equal(stats.truncatedSources, 1);
});

test('coverage downgrades when a partial segment shares a bucket', () => {
  const buffer = new HeatmapRetentionBuffer({ intervalMs: 60_000, priceStep: 1 });
  buffer.ingest('coverage:BTC', { bids: [[100, 10]], asks: [] }, { sourceTimestamp: 60_000, coverage: 'complete' });
  buffer.ingest('coverage:BTC', { bids: [[100, 10]], asks: [] }, { sourceTimestamp: 75_000, coverage: 'partial' });
  buffer.ingest('coverage:BTC', { bids: [[100, 10]], asks: [] }, { sourceTimestamp: 120_001, coverage: 'partial' });
  const row = buffer.drainClosed().find((item) => item.side === 'bid' && item.priceLow === 100);
  assert.ok(row);
  assert.equal(row.coverage, 'partial');
});

test('flush does not advance stale source time or bypass an epoch barrier', () => {
  const buffer = new HeatmapRetentionBuffer({ intervalMs: 60_000, priceStep: 50 });
  buffer.ingest('flush:BTC', { bids: [[101, 2]], asks: [] }, { sourceTimestamp: 60_000, grouping: 50, resolution: 'native', coverage: 'complete' });
  buffer.ingest('flush:BTC', { bids: [[101, 2]], asks: [] }, { sourceTimestamp: 75_000, grouping: 75, resolution: 'coarse', coverage: 'complete' });
  const before = buffer.peekClosed().length;
  buffer.flush(90_000);
  buffer.flush(180_000);
  assert.equal(buffer.peekClosed().length, before);
  assert.ok(buffer.peekClosed().every((row) => row.sourceGrouping !== 75 || row.bucketStart >= 120_000));
});


test('late-born cells exclude earlier partial coverage from their denominator', () => {
  const buffer = new HeatmapRetentionBuffer({ intervalMs: 60_000, priceStep: 1 });
  buffer.ingest('mixed:BTC', { bids: [], asks: [] }, { sourceTimestamp: 60_000, coverage: 'partial' });
  buffer.ingest('mixed:BTC', { bids: [], asks: [] }, { sourceTimestamp: 75_000, coverage: 'complete' });
  buffer.ingest('mixed:BTC', { bids: [[100, 10]], asks: [] }, { sourceTimestamp: 90_000, coverage: 'complete' });
  buffer.ingest('mixed:BTC', { bids: [[100, 10]], asks: [] }, { sourceTimestamp: 120_001, coverage: 'complete' });
  const row = buffer.drainClosed().find((item) => item.side === 'bid' && item.priceLow === 100);
  assert.ok(row);
  assert.equal(row.cellObservedMs, 30_000);
  assert.equal(row.meanAmount, 10);
  assert.deepEqual(row.observedIntervals, [{ start: 90_000, end: 120_000 }]);
});
