import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {HistoryStore,heatmapReadSql,heatmapReadViewSql} from '../src/server/history.mts';
import {projectObservedTimeMean,verifiedBookObservationIntervals} from '../src/server/observed-segment-projection.mts';
import {logicalRetainedBytes} from '../src/core/retained-bytes.mts';
import {scanBoundedJsonComplexity} from '../src/core/bounded-json-response.mts';
import type {HeatmapRetentionRow} from '../src/core/heatmap-retention.mts';
const id='binance:BTCUSDT';const start=1_800_000_000_000;
function row(index:number,amount=2):HeatmapRetentionRow {
 const left=start+index*60_000;
 return{instrumentId:id,bucketStart:left,bucketEnd:left+60_000,side:'bid',priceLow:100,priceHigh:150,meanAmount:amount,meanNotionalUsd:amount*100,peakAmount:amount,peakNotionalUsd:amount,
  observedMs:50_000,cellObservedMs:20_000,expectedMs:60_000,gapMs:10_000,coverage:'partial',sourceTimestampMin:left,sourceTimestampMax:left+60_000,receivedAt:left+60_001,
  sourceResolution:'native',sourceGrouping:50,gridEpoch:'native:50',observedIntervals:[{start:left+10_000,end:left+30_000}],gapIntervals:[{start:left+40_000,end:left+50_000}],observedSegments:[{start:left+10_000,end:left+30_000,amount,notionalUsd:amount*100}]};
}
const meanOptions={timeStepMs:300_000,projection:'observed-time-mean'};
test('book mask is proved from native integrated bounds minus outages, not first-cell positive support',()=>{
 const value=row(0);const mask=verifiedBookObservationIntervals({...value,bucketStart:start,bucketEnd:start+60_000,sourceTimestampMin:value.sourceTimestampMin,sourceTimestampMax:value.sourceTimestampMax,gapIntervals:value.gapIntervals});
 assert.deepEqual(mask,[{start,end:start+40_000},{start:start+50_000,end:start+60_000}]);
 for(const bad of [{...value,observedMs:60_000},{...value,sourceTimestampMin:null},{...value,gapIntervals:[{start:start+40_000,end:start+50_000},{start:start+45_000,end:start+55_000}]}])assert.throws(()=>verifiedBookObservationIntervals({...bad,bucketStart:start,bucketEnd:start+60_000,sourceTimestampMin:bad.sourceTimestampMin,sourceTimestampMax:bad.sourceTimestampMax,gapIntervals:bad.gapIntervals}),/book observation/);
});
test('explicit mean includes observed zero, preserves outage masks and native integral without inferring life',()=>{
 const projected=projectObservedTimeMean({amountMs:40_000,notionalUsdMs:4_000_000,positiveObservedMs:20_000,sourceSegmentCount:1,bookObservedIntervals:[{start,end:start+40_000},{start:start+50_000,end:start+60_000}],timeStepMs:300_000});
 assert.equal(projected.observedSegments.length,2);assert.equal(projected.observedSegments[0].amount,0.8);assert.equal(projected.observedSegments[0].notionalUsd,80);
 assert.equal(projected.temporalAggregation.sourcePositiveObservedMs,20_000);assert.equal(projected.temporalAggregation.sourceBookObservedMs,50_000);
 assert.equal(projected.temporalAggregation.sourceAmountMs,projected.temporalAggregation.projectedAmountMs);assert.equal(projected.temporalAggregation.sourceNotionalUsdMs,projected.temporalAggregation.projectedNotionalUsdMs);
 assert.equal(projected.temporalAggregation.method,'observed-time-mean');assert.equal(projected.temporalAggregation.denominator,'observed-book-time');assert.equal(projected.temporalAggregation.lifetimeInferred,false);
 for(const invalid of [{amountMs:Infinity},{positiveObservedMs:50_001},{sourceSegmentCount:0},{bookObservedIntervals:[{start,end:start+40_000},{start:start+39_000,end:start+60_000}]}])assert.throws(()=>projectObservedTimeMean({amountMs:40_000,notionalUsdMs:4_000_000,positiveObservedMs:20_000,sourceSegmentCount:1,bookObservedIntervals:[{start,end:start+50_000}],timeStepMs:300_000,...invalid}),/invalid|contradicts|overflow/);
});

function gapOnly(index:number):HeatmapRetentionRow {
 const value=row(index);return{...value,side:'both',priceLow:null,priceHigh:null,meanAmount:null,meanNotionalUsd:null,
  observedMs:0,cellObservedMs:0,gapMs:10_000,coverage:'gap',sourceTimestampMin:null,sourceTimestampMax:null,
  observedIntervals:[],observedSegments:[],gapIntervals:[{start:value.bucketEnd-10_000,end:value.bucketEnd}]};
}
function overwriteLegacyGap(history:HistoryStore,index:number):void {
 const value=gapOnly(index);
 history.insertHeatmapColumn.run(value.instrumentId,value.bucketStart,value.bucketEnd,value.observedMs,value.expectedMs,value.gapMs,value.coverage,value.sourceTimestampMin??null,value.sourceTimestampMax??null,value.receivedAt,value.sourceResolution,value.sourceGrouping,value.gridEpoch,JSON.stringify(value.observedIntervals),JSON.stringify(value.gapIntervals));
 history.db.prepare('DELETE FROM heatmap_observation_keys WHERE instrument_id=? AND bucket_start=?').run(value.instrumentId,value.bucketStart);
}