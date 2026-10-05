import { HEATMAP_CELL_LIMIT } from '../core/representation-limits.mts';
export interface ProjectionInterval { start: number; end: number; }
export interface ProjectionSegment extends ProjectionInterval { amount: number; notionalUsd: number; }
export function historyDisplayTimeStep(value: unknown): number | null {
  if (value == null) return null;
  if (typeof value !== 'number' && typeof value !== 'string') throw new RangeError('history timeStepMs must be numeric');
  const step = Number(value);
  if (!Number.isSafeInteger(step) || step < 1_000 || step > 86_400_000) throw new RangeError('history timeStepMs must be an integer from 1000 to 86400000');
  return step;
}
export interface ObservedTimeMeanAggregation {
 method:'observed-time-mean';timePrecision:'observed-time-mean-projection';denominator:'observed-book-time';timeStepMs:number;
 sourceSegmentCount:number;projectedSegmentCount:number;sourcePositiveObservedMs:number;sourceBookObservedMs:number;
 sourceAmountMs:number;projectedAmountMs:number;sourceNotionalUsdMs:number;projectedNotionalUsdMs:number;estimated:true;lifetimeInferred:false;
}
function strictProjectionIntervals(input:unknown,bucketStart:number,bucketEnd:number):ProjectionInterval[] {
 const value:unknown=typeof input==='string'?JSON.parse(input):input??[];
 if(!Array.isArray(value))throw new Error('book observation intervals are unavailable');
 const result:ProjectionInterval[]=[];
 for(const item of value){if(item===null||typeof item!=='object'||Array.isArray(item))throw new Error('book observation interval is invalid');
  const fields=item as Record<string,unknown>;const start=Number(fields.start);const end=Number(fields.end);const previous=result.at(-1);
  if(!Number.isSafeInteger(start)||!Number.isSafeInteger(end)||start<bucketStart||end>bucketEnd||end<=start||previous&&start<previous.end)throw new Error('book observation intervals are invalid or overlap');
  if(previous&&start===previous.end)previous.end=end;else result.push({start,end});
 }return result;
}
/** Native integration proof: endpoints plus declared outages must exactly match recorded BOOK milliseconds. */
export function verifiedBookObservationIntervals({bucketStart,bucketEnd,observedMs,sourceTimestampMin,sourceTimestampMax,gapIntervals,observedIntervals}: {
 bucketStart:number;bucketEnd:number;observedMs:number;sourceTimestampMin:unknown;sourceTimestampMax:unknown;gapIntervals:unknown;observedIntervals?:unknown;
}):ProjectionInterval[] {
 if(!Number.isSafeInteger(bucketStart)||!Number.isSafeInteger(bucketEnd)||bucketEnd<=bucketStart||!Number.isSafeInteger(observedMs)||observedMs<0||observedMs>bucketEnd-bucketStart)throw new Error('book observation duration is invalid');
 const gaps=strictProjectionIntervals(gapIntervals,bucketStart,bucketEnd);
 const stored=strictProjectionIntervals(observedIntervals,bucketStart,bucketEnd);
 if(observedMs===0){if(stored.length)throw new Error('book observation zero duration contradicts stored support');return [];}
 const first=Number(sourceTimestampMin);const last=Number(sourceTimestampMax);
 if(sourceTimestampMin==null||sourceTimestampMax==null||!Number.isSafeInteger(first)||!Number.isSafeInteger(last)||first<bucketStart||last>bucketEnd||last<=first)throw new Error('book observation native bounds are unavailable');
 const mask:ProjectionInterval[]=[];let cursor=first;
 for(const gap of gaps){if(gap.end<=cursor||gap.start>=last)continue;const left=Math.max(first,gap.start);const right=Math.min(last,gap.end);if(left>cursor)mask.push({start:cursor,end:left});cursor=Math.max(cursor,right);}
 if(cursor<last)mask.push({start:cursor,end:last});
 const duration=mask.reduce((sum,interval)=>sum+interval.end-interval.start,0);
 if(duration!==observedMs)throw new Error('book observation duration proof is unavailable');
 for(const interval of stored)if(!mask.some(run=>interval.start>=run.start&&interval.end<=run.end))throw new Error('stored positive support contradicts book observation mask');
 return mask;
}
const preparedBookMaskBrand = Symbol('prepared-observed-time-mean-book-mask');
const preparedBookMasks = new WeakSet<object>();
export interface PreparedObservedTimeMeanBookMask {
 readonly [preparedBookMaskBrand]: true;
 readonly observedIntervals: readonly Readonly<ProjectionInterval>[];
 readonly sourceBookObservedMs: number;
 readonly timeStepMs: number;
 readonly bucketStart: number;
 readonly bucketEnd: number;
}
export interface ObservedTimeMeanValues {
 amountMs:number;notionalUsdMs:number;positiveObservedMs:number;sourceSegmentCount:number;timeStepMs:number;
}
export interface ObservedTimeMeanProjection<Support extends readonly ProjectionInterval[] = ProjectionInterval[]> {
 observedIntervals:Support;observedSegments:ProjectionSegment[];temporalAggregation:ObservedTimeMeanAggregation;
}
export function projectObservedTimeMean(values:ObservedTimeMeanValues&{bookObservedIntervals:ProjectionInterval[];preparedBookMask?:never}):ObservedTimeMeanProjection;
export function projectObservedTimeMean(values:ObservedTimeMeanValues&{preparedBookMask:PreparedObservedTimeMeanBookMask;bookObservedIntervals?:never}):ObservedTimeMeanProjection<readonly Readonly<ProjectionInterval>[]>;
export function projectObservedTimeMean({amountMs,notionalUsdMs,positiveObservedMs,sourceSegmentCount,bookObservedIntervals,preparedBookMask,timeStepMs}:ObservedTimeMeanValues&{
 bookObservedIntervals?:ProjectionInterval[];preparedBookMask?:PreparedObservedTimeMeanBookMask;
}):ObservedTimeMeanProjection<readonly ProjectionInterval[]> {
 const step=historyDisplayTimeStep(timeStepMs);if(step==null)throw new Error('observed-time-mean requires a display time step');
 if(![amountMs,notionalUsdMs,positiveObservedMs,sourceSegmentCount].every(Number.isFinite)||amountMs<0||notionalUsdMs<0||!Number.isSafeInteger(positiveObservedMs)||positiveObservedMs<0||!Number.isSafeInteger(sourceSegmentCount)||sourceSegmentCount<0)throw new Error('observed-time-mean integral is invalid');
 let intervals:readonly ProjectionInterval[];let sourceBookObservedMs=0;
 if(preparedBookMask!==undefined){
  if(preparedBookMask===null||typeof preparedBookMask!=='object'||!preparedBookMasks.has(preparedBookMask))throw new Error('observed-time-mean prepared book mask is untrusted');
  if(bookObservedIntervals!==undefined)throw new Error('observed-time-mean book mask inputs are exclusive');
  if(preparedBookMask.timeStepMs!==step)throw new Error('observed-time-mean prepared book mask time step mismatch');
  intervals=preparedBookMask.observedIntervals;sourceBookObservedMs=preparedBookMask.sourceBookObservedMs;
 }else{
  const normalized:ProjectionInterval[]=[];
  for(const interval of bookObservedIntervals!){const previous=normalized.at(-1);if(!Number.isSafeInteger(interval.start)||!Number.isSafeInteger(interval.end)||interval.end<=interval.start||previous&&interval.start<previous.end)throw new Error('observed-time-mean book mask is invalid or overlaps');
   if(previous&&interval.start===previous.end)previous.end=interval.end;else normalized.push({...interval});sourceBookObservedMs+=interval.end-interval.start;
  }
  intervals=normalized;
 }
 if(!Number.isSafeInteger(sourceBookObservedMs)||sourceBookObservedMs<=0||positiveObservedMs>sourceBookObservedMs||positiveObservedMs===0&&(amountMs!==0||notionalUsdMs!==0||sourceSegmentCount!==0)||positiveObservedMs>0&&(amountMs<=0||sourceSegmentCount===0))throw new Error('observed-time-mean positive support contradicts book duration');
 const amount=amountMs/sourceBookObservedMs;const notionalUsd=notionalUsdMs/sourceBookObservedMs;
 const observedSegments=amount>0?intervals.map(interval=>({...interval,amount,notionalUsd})):[];
 const projectedAmountMs=observedSegments.reduce((sum,segment)=>sum+segment.amount*(segment.end-segment.start),0);
 const projectedNotionalUsdMs=observedSegments.reduce((sum,segment)=>sum+segment.notionalUsd*(segment.end-segment.start),0);
 if(![amount,notionalUsd,projectedAmountMs,projectedNotionalUsdMs].every(Number.isFinite))throw new Error('observed-time-mean weighted value overflow');
 return{observedIntervals:intervals,observedSegments,temporalAggregation:{method:'observed-time-mean',timePrecision:'observed-time-mean-projection',denominator:'observed-book-time',timeStepMs:step,sourceSegmentCount,projectedSegmentCount:observedSegments.length,sourcePositiveObservedMs:positiveObservedMs,sourceBookObservedMs,sourceAmountMs:amountMs,projectedAmountMs,sourceNotionalUsdMs:notionalUsdMs,projectedNotionalUsdMs,estimated:true,lifetimeInferred:false}};
}