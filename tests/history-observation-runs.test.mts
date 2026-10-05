import test from 'node:test';
import assert from 'node:assert/strict';
import {StatementSync} from 'node:sqlite';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {HistoryStore} from '../src/server/history.mts';
import {logicalRetainedBytes} from '../src/core/retained-bytes.mts';
import type {HeatmapRetentionRow} from '../src/core/heatmap-retention.mts';
import {fields,numeric} from './server-test-helpers.mts';
const id='hyperliquid:BTC-PERP';const start=1_800_000_000_000;
function run(left:number,right:number,amount=2,grid='coarse'):HeatmapRetentionRow {
 const gaps=[...(left>0?[{start,end:start+left}]:[]),...(right<60_000?[{start:start+right,end:start+60_000}]:[])];
 return{instrumentId:id,bucketStart:start,bucketEnd:start+60_000,side:'bid',priceLow:100,priceHigh:150,meanAmount:amount,meanNotionalUsd:amount*100,peakAmount:amount,peakNotionalUsd:amount*100,observedMs:right-left,cellObservedMs:right-left,expectedMs:60_000,gapMs:60_000-(right-left),coverage:'partial',sourceTimestampMin:start+left,sourceTimestampMax:start+right,receivedAt:start+right+1,sourceResolution:grid,sourceGrouping:50,gridEpoch:grid+':50',observedIntervals:[{start:start+left,end:start+right}],gapIntervals:gaps,observedSegments:[{start:start+left,end:start+right,amount,notionalUsd:amount*100}]};
}
function gap():HeatmapRetentionRow{return{...run(0,20_000),side:'both',priceLow:null,priceHigh:null,meanAmount:null,meanNotionalUsd:null,observedMs:0,cellObservedMs:0,gapMs:10_000,coverage:'gap',sourceTimestampMin:null,sourceTimestampMax:null,sourceResolution:'native',gridEpoch:'native:50',observedIntervals:[],observedSegments:[],gapIntervals:[{start:start+50_000,end:start+60_000}]};}
const mean={projection:'observed-time-mean',timeStepMs:300_000,limit:1};
function count(history:HistoryStore,table:string):number{return numeric(fields(history.db.prepare('SELECT COUNT(*) AS count FROM '+table).get()).count);}
test('conflicting observed overlap is retained and measured without blocking valid later native buckets',()=>{
 const history=new HistoryStore();try{history.persistHeatmapRows([run(0,20_000)]);assert.equal(history.persistHeatmapRows([run(10_000,30_000,7)]),0);assert.equal(history.persistenceSuspended,false);assert.equal(history.sessionHeatmapRows.length,1);assert.equal(history.heatmapWriteStats.lastError?.code,'native-observation-run-overlap');assert.ok(Number(history.retainedDiagnostics().logicalComponents?.sessionHeatmapRows)>0);assert.ok(Number(history.retainedDiagnostics().logicalComponents?.heatmapConflictedRuns)>0);const value=run(40_000,60_000,4);const later={...value,bucketStart:start+60_000,bucketEnd:start+120_000,sourceTimestampMin:start+100_000,sourceTimestampMax:start+120_000,observedIntervals:[{start:start+100_000,end:start+120_000}],gapIntervals:[{start:start+60_000,end:start+100_000}],observedSegments:[{start:start+100_000,end:start+120_000,amount:4,notionalUsd:400}]};assert.equal(history.persistHeatmapRows([later]),1);assert.equal(history.persistenceSuspended,false);assert.equal(count(history,'heatmap_columns'),2);}finally{history.close();}
});
test('paired pruning removes immutable sibling cells, native parents and replay keys together',()=>{
 const history=new HistoryStore({retentionDays:1,depthRetentionDays:1});try{history.persistHeatmapRows([run(0,20_000),run(40_000,60_000,4)]);history.prune(start+2*86_400_000);for(const table of ['heatmap_columns','heatmap_cells','heatmap_observation_columns','heatmap_observation_cells','heatmap_observation_keys'])assert.equal(count(history,table),0,table);}finally{history.close();}
});

test('native bucket alignment changes cannot duplicate an already observed BOOK interval',()=>{
 const history=new HistoryStore();try{history.persistHeatmapRows([run(0,20_000)]);const value=run(10_000,30_000,7);assert.equal(history.persistHeatmapRows([{...value,bucketStart:start+10_000,bucketEnd:start+70_000,expectedMs:60_000,gapMs:40_000,gapIntervals:[{start:start+30_000,end:start+70_000}]}]),0);assert.equal(count(history,'heatmap_columns'),1);assert.equal(count(history,'heatmap_observation_columns'),0);assert.equal(history.sessionHeatmapRows.length,1);assert.equal(history.persistenceSuspended,false);assert.equal(history.heatmapWriteStats.lastError?.code,'native-observation-run-overlap');}finally{history.close();}
});

test('OI-only startup and maintenance do not allocate sibling heatmap storage',()=>{
 const history=new HistoryStore();try{assert.equal(history.heatmapRunTablesReady,false);assert.equal(history.db.prepare("SELECT 1 FROM sqlite_master WHERE name='heatmap_observation_columns'").get(),undefined);history.prune(start);assert.equal(history.heatmapRunTablesReady,false);history.persistHeatmapRows([run(0,20_000)]);assert.equal(history.heatmapRunTablesReady,true);}finally{history.close();}
});
