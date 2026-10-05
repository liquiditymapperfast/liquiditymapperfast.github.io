import type { PublishedRetainedBudget } from '../src/server/retained-budget.mts';
import type { HeatmapRetentionRow } from '../src/core/heatmap-retention.mts';
import { defined, fields, list, numeric, textValue, fieldMap, injectMapFixture, injectArrayFixture } from './server-test-helpers.mts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { RetainedBudgetCoordinator } from '../src/server/retained-budget.mts';
import { HistoryStore } from '../src/server/history.mts';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

test('history reclaim drops only session rows and protects pending durable/failure rows', () => {
  const h = new HistoryStore({ filePath: ':memory:', sessionOnlyHeatmap: true });
  injectArrayFixture(h.sessionHeatmapRows, { instrumentId: 'x', bucketStart: 1, gridEpoch: 1, side: 'bid', cells: ['x'.repeat(100)] }, { instrumentId: 'x', bucketStart: 1, gridEpoch: 1, side: 'ask', cells: ['x'.repeat(100)] });
  injectMapFixture(h.pendingDepth, 'venue:book', { instrumentId: 'venue:book', timestamp: 1, bids: [[1, 2]] });
  injectArrayFixture(h.pendingDepthFailures, { instrumentId: 'venue:book', timestamp: 1, error: 'write failed' });
  const before = h.retainedRamBudget(); const reclaimed = h.reclaimRetainedRam({ targetBytes: 1 }); const after = h.retainedRamBudget();
  assert.ok(reclaimed > 0); assert.equal(h.sessionHeatmapRows.length, 0); assert.equal(h.pendingDepth.size, 1); assert.equal(h.pendingDepthFailures.length, 1); assert.ok(after.protectedPendingDepthBytes > 0); assert.ok(before.sessionOnlyEvictableBytes > 0);
  h.close();
});

test('history reclaim uses logical reduction after each whole column', () => {
  const first = [
    { instrumentId: 'x', bucketStart: 1, gridEpoch: 1, side: 'bid', cells: ['x'.repeat(100)] },
    { instrumentId: 'x', bucketStart: 1, gridEpoch: 1, side: 'ask', cells: ['x'.repeat(100)] },
  ];
  const second = [
    { instrumentId: 'x', bucketStart: 2, gridEpoch: 1, side: 'bid', cells: ['y'.repeat(2_000)] },
    { instrumentId: 'x', bucketStart: 2, gridEpoch: 1, side: 'ask', cells: ['y'.repeat(2_000)] },
  ];
  const probe = new HistoryStore({ filePath: ':memory:', sessionOnlyHeatmap: true });
  injectArrayFixture(probe.sessionHeatmapRows, ...first);
  const firstSerialized = first.reduce((sum, row) => sum + Buffer.byteLength(JSON.stringify(row)), 0);
  const firstLogicalReduction = probe.reclaimRetainedRam({ targetBytes: Number.MAX_SAFE_INTEGER });
  probe.close();
  assert.ok(firstSerialized > firstLogicalReduction);
  const target = Math.ceil((firstSerialized + firstLogicalReduction) / 2);

  const h = new HistoryStore({ filePath: ':memory:', sessionOnlyHeatmap: true });
  injectArrayFixture(h.sessionHeatmapRows, ...first, ...second);
  const reclaimed = h.reclaimRetainedRam({ targetBytes: target });
  assert.ok(reclaimed >= target);
  assert.equal(h.sessionHeatmapDroppedColumns, 2);
  assert.equal(h.sessionHeatmapRows.length, 0);
  assert.ok(defined(h.retainedDiagnostics().logicalComponents).sessionHeatmapLosses > 0);
  h.close();
});

test('suspended durable fallback preserves whole bid/ask column', () => {
  const h = new HistoryStore({ filePath: ':memory:', sessionOnlyHeatmap: false });
  h.persistenceSuspended = true;
  injectArrayFixture(h.sessionHeatmapRows, { instrumentId: 'x', bucketStart: 1, gridEpoch: 1, side: 'bid' }, { instrumentId: 'x', bucketStart: 1, gridEpoch: 1, side: 'ask' });
  assert.equal(h.reclaimRetainedRam({ targetBytes: 1 }), 0); assert.equal(h.sessionHeatmapRows.length, 2); assert.ok(h.retainedRamBudget().protectedSuspendedBacklogBytes > 0); h.close();
});

test('durable history reclaims only unselected sources and persists explicit coverage gaps', () => {
  const h = new HistoryStore({ filePath: ':memory:', heatmapIntervalMs: 60_000, heatmapPriceStep: 1 });
  const addSource = (instrumentId: string, receivedAt: number) => {
    h.heatmap.ingest(instrumentId, { bids: [[100, 2]], asks: [] }, { sourceTimestamp: 60_000, receivedAt, coverage: 'complete' });
    h.heatmap.ingest(instrumentId, { bids: [[100, 2]], asks: [] }, { sourceTimestamp: 75_000, receivedAt: receivedAt + 15_000, coverage: 'complete' });
  };
  addSource('stale', 100);
  addSource('state-active', 200);
  addSource('feed-active', 300);
  try {
    const reclaimed = h.reclaimRetainedRam({ targetBytes: 1, protectedInstrumentIds: new Set(['state-active', 'feed-active']) });
    assert.ok(reclaimed > 0);
    assert.equal(h.heatmap.sources.has('stale'), false);
    assert.equal(defined(h.heatmap.sourceTombstones.get('stale')).epochBarrier, 120_000);
    assert.equal(defined(h.heatmap.sources.get('state-active')).levels.length, 1);
    assert.equal(defined(h.heatmap.sources.get('feed-active')).levels.length, 1);

    const first = h.db.prepare('SELECT coverage, gap_ms AS gapMs, observed_ms AS observedMs, gap_intervals AS gapIntervals FROM heatmap_columns WHERE instrument_id = ? AND bucket_start = ?').get('stale', 60_000);
    assert.equal(fields(first).coverage, 'partial');
    assert.equal(fields(first).gapMs, 45_000);
    assert.equal(fields(first).observedMs, 15_000);
    assert.deepEqual(JSON.parse(textValue(fields(first).gapIntervals)), [{ start: 75_000, end: 120_000 }]);

    h.heatmap.ingest('stale', { bids: [[101, 3]], asks: [] }, { sourceTimestamp: 150_000, receivedAt: 150_000, coverage: 'complete' });
    h.heatmap.ingest('stale', { bids: [[101, 3]], asks: [] }, { sourceTimestamp: 180_001, receivedAt: 180_001, coverage: 'complete' });
    assert.ok(h.persistHeatmapRows() > 0);
    const rejoined = h.db.prepare('SELECT coverage, gap_ms AS gapMs, observed_ms AS observedMs, gap_intervals AS gapIntervals FROM heatmap_columns WHERE instrument_id = ? AND bucket_start = ?').get('stale', 120_000);
    assert.equal(fields(rejoined).coverage, 'partial');
    assert.equal(fields(rejoined).gapMs, 30_000);
    assert.equal(fields(rejoined).observedMs, 30_000);
    assert.deepEqual(JSON.parse(textValue(fields(rejoined).gapIntervals)), [{ start: 120_000, end: 150_000 }]);
  } finally { h.close(); }
});

test('durable history reclaim requires an explicit active-source set', () => {
  const h = new HistoryStore({ filePath: ':memory:', heatmapIntervalMs: 60_000, heatmapPriceStep: 1 });
  h.heatmap.ingest('selected', { bids: [[100, 2]], asks: [] }, { sourceTimestamp: 60_000, receivedAt: 60_000, coverage: 'complete' });
  try {
    assert.equal(h.reclaimRetainedRam({ targetBytes: 1 }), 0);
    assert.equal(h.heatmap.sources.has('selected'), true);
    assert.equal(defined(h.heatmap.sources.get('selected')).levels.length, 1);
  } finally { h.close(); }
});

test('failed durable source reclaim leaves canonical closed rows pending in RAM', () => {
  const h = new HistoryStore({ filePath: ':memory:', heatmapIntervalMs: 60_000, heatmapPriceStep: 1, storageWriteGuard: () => { throw Object.assign(new Error('disk full'), { code: 'ENOSPC' }); } });
  h.heatmap.ingest('stale', { bids: [[100, 2]], asks: [] }, { sourceTimestamp: 60_000, receivedAt: 60_000, coverage: 'complete' });
  h.heatmap.ingest('stale', { bids: [[100, 2]], asks: [] }, { sourceTimestamp: 75_000, receivedAt: 75_000, coverage: 'complete' });
  try {
    assert.equal(h.reclaimRetainedRam({ targetBytes: 1, protectedInstrumentIds: [] }), 0);
    assert.equal(h.persistenceSuspended, true);
    assert.equal(h.heatmap.sources.has('stale'), false);
    assert.equal(defined(h.heatmap.sourceTombstones.get('stale')).epochBarrier, 120_000);
    assert.ok(h.heatmap.closedRows.some((row) => row.instrumentId === 'stale' && row.priceLow === 100 && row.coverage === 'partial'));
    assert.equal(fields(h.db.prepare('SELECT COUNT(*) AS count FROM heatmap_columns WHERE instrument_id = ?').get('stale')).count, 0);
  } finally { h.close(); }
});

test('history diagnostics classify config budget and write errors, then recover after guard clears', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hlm-budget-'));
  try {
    const h = new HistoryStore({ filePath: path.join(dir, 'history.sqlite'), maxMainBytes: 1 });
    try {
      h.enforceStorageBudget();
      assert.equal(h.storageBudget().suspensionReason, 'config-budget');
    } finally { h.close(); }
    let blocked = true;
    const w = new HistoryStore({ filePath: path.join(dir, 'write.sqlite'), storageWriteGuard: () => { if (blocked) throw Object.assign(new Error('disk full'), { code: 'ENOSPC' }); } });
    try {
      const row = { instrumentId: 'x', bucketStart: 1, bucketEnd: 2, side: 'bid', priceLow: 1, priceHigh: 2, meanAmount: 1, meanNotionalUsd: 1, peakAmount: 1, peakNotionalUsd: 1, observedMs: 1, cellObservedMs: 1, expectedMs: 1, gapMs: 0, coverage: 'complete', gridEpoch: '1', sourceTimestampMin: 1, sourceTimestampMax: 1, receivedAt: 1, sourceResolution: null, sourceGrouping: null, observedIntervals: [], gapIntervals: [], observedSegments: [] };
      persistUnspecifiedSourceFixture(w, row);
      assert.equal(w.storageBudget().suspensionReason, 'write-error');
      assert.ok(w.storageBudget().sessionHeatmapRows > 0);
      blocked = false;
      const recovered = w.enforceStorageBudget({ compact: true });
      assert.equal(recovered.persistenceSuspended, false);
      assert.equal(recovered.suspensionReason, null);
      assert.equal(recovered.sessionHeatmapRows, 0);
      assert.deepEqual({ ...fields(w.db.prepare('SELECT instrument_id AS instrumentId, bucket_start AS bucketStart, bucket_end AS bucketEnd, coverage, source_resolution AS sourceResolution, grid_epoch AS gridEpoch FROM heatmap_columns').get()) }, { instrumentId: 'x', bucketStart: 1, bucketEnd: 2, coverage: 'complete', sourceResolution: null, gridEpoch: '1' });
      assert.deepEqual({ ...fields(w.db.prepare('SELECT instrument_id AS instrumentId, bucket_start AS bucketStart, side, price_low AS priceLow, price_high AS priceHigh, mean_amount AS meanAmount, mean_notional_usd AS meanNotionalUsd, peak_amount AS peakAmount, peak_notional_usd AS peakNotionalUsd, source_resolution AS sourceResolution, grid_epoch AS gridEpoch FROM heatmap_cells').get()) }, { instrumentId: 'x', bucketStart: 1, side: 'bid', priceLow: 1, priceHigh: 2, meanAmount: 1, meanNotionalUsd: 1, peakAmount: 1, peakNotionalUsd: 1, sourceResolution: null, gridEpoch: '1' });
    } finally { w.close(); }
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('failed session-history retries do not duplicate already-retained rows', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hlm-budget-retry-'));
  const w = new HistoryStore({ filePath: path.join(dir, 'write.sqlite'), storageWriteGuard: () => { throw Object.assign(new Error('disk full'), { code: 'ENOSPC' }); } });
  const row = { instrumentId: 'x', bucketStart: 1, bucketEnd: 2, side: 'bid', priceLow: 1, priceHigh: 2, meanAmount: 1, meanNotionalUsd: 1, peakAmount: 1, peakNotionalUsd: 1, observedMs: 1, cellObservedMs: 1, expectedMs: 1, gapMs: 0, coverage: 'complete', gridEpoch: '1', sourceTimestampMin: 1, sourceTimestampMax: 1, receivedAt: 1, sourceResolution: null, sourceGrouping: null, observedIntervals: [], gapIntervals: [], observedSegments: [] };
  try {
    persistUnspecifiedSourceFixture(w, row);
    assert.equal(w.storageBudget().sessionHeatmapRows, 1);
    w.enforceStorageBudget({ compact: true });
    w.enforceStorageBudget({ compact: true });
    w.enforceStorageBudget({ compact: true });
    assert.equal(w.storageBudget().sessionHeatmapRows, 1);
    assert.equal(w.storageBudget().sessionHeatmapDroppedRows, 0);
  } finally {
    w.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function coordinated(coordinator: RetainedBudgetCoordinator, options: Parameters<RetainedBudgetCoordinator['coordinate']>[0] = {}): PublishedRetainedBudget {
  const snapshot = coordinator.coordinate(options);
  if ('recursionGuard' in snapshot) throw new Error('test expected a completed coordination');
  return snapshot;
}

/** Exercise persisted rows with explicitly unknown source resolution/grouping. */
function persistUnspecifiedSourceFixture(history: HistoryStore, row: unknown): ReturnType<HistoryStore['persistHeatmapRows']> {
  const rows: HeatmapRetentionRow[] = [];
  injectArrayFixture(rows, row);
  return history.persistHeatmapRows(rows);
}
