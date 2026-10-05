import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { HistoryStore } from '../src/server/history.mts';
import type { HeatmapRetentionRow } from '../src/core/heatmap-retention.mts';
import { logicalRetainedBytes, logicalRetainedComponents } from '../src/core/retained-bytes.mts';
const id = 'session-size:BTC'; const start = 1_800_000_000_000;
function exact(rows: readonly HeatmapRetentionRow[]): number { return rows.reduce((total, row) => total + Buffer.byteLength(JSON.stringify(row), 'utf8'), 0); }
function nativeHeader(): HeatmapRetentionRow {
  return { instrumentId: id, bucketStart: start, bucketEnd: start + 60_000, side: 'both', priceLow: null, priceHigh: null,
    meanAmount: null, meanNotionalUsd: null, peakAmount: null, peakNotionalUsd: null, observedMs: 0, cellObservedMs: 0,
    expectedMs: 60_000, gapMs: 60_000, coverage: 'gap', observedIntervals: [], gapIntervals: [{ start, end: start + 60_000 }],
    observedSegments: undefined, sourceTimestampMin: undefined, sourceTimestampMax: undefined, receivedAt: null,
    sourceResolution: 'native', sourceGrouping: 1, gridEpoch: 'native:1', text: 'external €' };
}
function freshSize(history: HistoryStore): number { return history.retentionBudget().sessionHeatmap.serializedBytesEstimate; }

test('explicit external mutable headers retain caller identity and stay freshly measured after nested edits', () => {
  const history = new HistoryStore({ sessionOnlyHeatmap: true });
  try {
    const external = nativeHeader(); history.persistHeatmapRows([external]); assert.equal(history.sessionHeatmapRows[0], external);
    assert.equal(Object.isFrozen(external), false); assert.equal(Object.isFrozen(external.gapIntervals), false); assert.equal(history.sessionHeatmapRowBytes.count, 0);
    const before = history.retainedDiagnostics({ cached: true }); external.text = 'larger payload €'.repeat(80); external.gapIntervals.push({ start: start + 70_000, end: start + 80_000 });
    const after = history.retainedDiagnostics({ cached: true }); assert.notEqual(after, before); assert.ok(after.retention); assert.equal(after.retention.sessionHeatmap.serializedBytesEstimate, exact([external]));
    assert.ok(before.retention); assert.ok(after.retention.sessionHeatmap.serializedBytesEstimate > before.retention.sessionHeatmap.serializedBytesEstimate);
    assert.ok(Object.hasOwn(external, 'observedSegments')); assert.equal(external.observedSegments, undefined); assert.equal(history.sessionHeatmapRowBytes.count, 0);
  } finally { history.close(); }
});
