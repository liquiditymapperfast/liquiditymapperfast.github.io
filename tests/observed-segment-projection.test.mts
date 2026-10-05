import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync, type SupportedValueType } from 'node:sqlite';
import { HistoryStore } from '../src/server/history.mts';
import { fields } from './server-test-helpers.mts';
import { historyDisplayTimeStep, projectObservedTimeMean, type PreparedObservedTimeMeanBookMask, type ProjectionSegment, type ProjectionInterval } from '../src/server/observed-segment-projection.mts';
import { logicalRetainedBytes } from '../src/core/retained-bytes.mts';
import { HEATMAP_CELL_LIMIT } from '../src/core/representation-limits.mts';
import type { HeatmapRetentionRow } from '../src/core/heatmap-retention.mts';

const start = 1_800_000_000_000;
function segments(count: number, offset = start, duration = 100): ProjectionSegment[] {
  return Array.from({ length: count }, (_, i) => ({ start: offset + i * duration, end: offset + (i + 1) * duration, amount: 1 + i % 2, notionalUsd: 100 + 100 * (i % 2) }));
}
function row(count: number, index = 0): HeatmapRetentionRow {
  const source = segments(count, start + index * 60_000, 60_000 / count);
  return { instrumentId: 'binance:BTCUSDT', bucketStart: start + index * 60_000, bucketEnd: start + (index + 1) * 60_000,
    priceLow: 100, priceHigh: 101, side: 'bid', meanAmount: 1.5, meanNotionalUsd: 150, peakAmount: 2, peakNotionalUsd: 200,
    observedMs: 60_000, cellObservedMs: 60_000, expectedMs: 60_000, gapMs: 0,
    observedIntervals: [{ start: start + index * 60_000, end: start + (index + 1) * 60_000 }], gapIntervals: [], observedSegments: source,
    coverage: 'complete', sourceTimestampMin: start + index * 60_000, sourceTimestampMax: start + (index + 1) * 60_000,
    receivedAt: start + (index + 1) * 60_000, sourceResolution: 'native', sourceGrouping: 1, gridEpoch: 'native:1' };
}
const meanMaskStep=300_000;
const meanValues={amountMs:40_000,notionalUsdMs:4_000_000,positiveObservedMs:20_000,sourceSegmentCount:1,timeStepMs:meanMaskStep};

test('ordinary frozen arrays still copy support and never implicitly enter the trusted mask path',()=>{
 const input=[Object.freeze({start,end:start+50_000})];Object.freeze(input);
 const first=projectObservedTimeMean({...meanValues,bookObservedIntervals:input}),second=projectObservedTimeMean({...meanValues,bookObservedIntervals:input});
 assert.notEqual(first.observedIntervals,input);assert.notEqual(first.observedIntervals,second.observedIntervals);assert.notEqual(first.observedIntervals[0],input[0]);
 assert.equal(Object.isFrozen(first.observedIntervals),false);assert.equal(Object.isFrozen(first.observedIntervals[0]),false);
});