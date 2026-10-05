import { randomUUID } from 'node:crypto';
import { types } from 'node:util';
import type { RuntimeMarket } from '../domain/runtime-state.mts';
import { validateFootprintSource, type FootprintSource } from '../core/footprint-execution.mts';
import { FootprintModel, type FootprintGapReason, type PreparedFootprintPacket, type FootprintWindowOptions, planFootprintWindow, projectFootprintWindow } from '../core/footprint-model.mts';
export const FOOTPRINT_SUBSCRIBER_LIMIT = 16;
export const FOOTPRINT_SUBSCRIBER_OWNER_BYTES = 16 * 1_024;
/** Exact supported metadata only. This never activates a venue/feed. */
export function initialFootprintSources(markets: readonly RuntimeMarket[]): readonly FootprintSource[] {
  const sources: FootprintSource[] = [];
  for (const market of markets) {
    if (sources.length >= 16) break;
    const instrumentId = market.instrumentId ?? market.id;
    if (market.id !== undefined && market.instrumentId !== undefined && market.id !== market.instrumentId) continue;
    if (market.inverse === true || market.quantityUnit === 'contract' || (market.venue === 'binance' && market.family !== undefined && !['usdm', 'spot'].includes(String(market.family)))) continue;
    if (typeof instrumentId !== 'string' || sources.some(source=>source.instrumentId===instrumentId)) continue;
    try {
      if (market.venue === 'hyperliquid' && market.marketType === 'perpetual' && market.quote === 'USD' && market.quantityUnit === 'base') {
        if (!instrumentId.startsWith('hyperliquid:') || !instrumentId.endsWith('-PERP')) continue;
        const coin = instrumentId.slice('hyperliquid:'.length, -'-PERP'.length);
        // Initial fixture metadata uses BTC-PERP; live metadata uses exact coin.
        if (market.nativeSymbol !== coin && market.nativeSymbol !== coin+'-PERP') continue;
        if (typeof market.base !== 'string' || !market.base) continue;
        sources.push(validateFootprintSource({venue:'hyperliquid',instrumentId,nativeSymbol:coin,baseAsset:market.base,quoteAsset:'USD',marketType:'perpetual',channel:'hyperliquid-trades',usdBasis:'native-usd',quantityUnit:'base',contractValue:null,aggressorVerified:true}));
      } else if (market.venue === 'binance' && ['perpetual','spot'].includes(String(market.marketType)) && market.quote === 'USDT' && market.quantityUnit === 'base') {
        if (typeof market.nativeSymbol !== 'string' || typeof market.base !== 'string') continue;
        sources.push(validateFootprintSource({venue:'binance',instrumentId,nativeSymbol:market.nativeSymbol,baseAsset:market.base,quoteAsset:'USDT',marketType:market.marketType==='spot'?'spot':'perpetual',channel:'binance-aggTrade',usdBasis:'stablecoin-equivalent',quantityUnit:'base',contractValue:null,aggressorVerified:true}));
      }
    } catch { /* Unsupported/ambiguous metadata stays visibly unavailable. */ }
  }
  return Object.freeze(sources);
}

/** One server-owned execution authority; no raw trade archive or hidden graph. */
export class FootprintStore {
  readonly model: FootprintModel;
  #listeners = new Set<()=>void>();
  // Fixed source slots retain no rejected payload; writes to these scalars need no
  // candidate graph allocation during an admission failure.
  #gapSlots: {instrumentId:string;fromMs:number;toMs:number;reason:FootprintGapReason;excludedRecords:number}[] = [];
  constructor(markets: readonly RuntimeMarket[], sessionId: string = randomUUID()) {
    this.model = new FootprintModel({footprintSessionId:sessionId,sources:initialFootprintSources(markets)});
    this.#gapSlots=Object.keys(this.model.retainedSnapshot().sources).map(instrumentId=>({instrumentId,fromMs:0,toMs:0,reason:'rejected-packet',excludedRecords:0}));
  }
  source(instrumentId: string): FootprintSource | null { return this.model.retainedSnapshot().sources[instrumentId]?.source ?? null; }
  get revision(): number { return this.model.retainedSnapshot().revision; }
  get sessionId(): string { return this.model.retainedSnapshot().footprintSessionId; }
  commit(prepared: PreparedFootprintPacket): boolean {
    if(!this.model.commit(prepared).committed)return false;
    for(const slot of this.#gapSlots){
      const covered=prepared.candidate.sources[slot.instrumentId]?.gaps.some(gap=>gap.fromMs<=slot.fromMs&&gap.toMs>=slot.toMs&&gap.excludedRecords>=slot.excludedRecords);
      if(covered){slot.fromMs=0;slot.toMs=0;slot.excludedRecords=0;}
    }
    return true;
  }
  /** Only complete projections replace a browser graph; never additive deltas. */
  windowPlan(options: FootprintWindowOptions) { return planFootprintWindow(this.model.retainedSnapshot(),options); }
  project(options: FootprintWindowOptions, reservedWorkingBytes: number) { return projectFootprintWindow(this.model.retainedSnapshot(),options,{reservedWorkingBytes}); }
  subscribe(listener: ()=>void): (()=>void) | null {
    if(this.#listeners.size>=FOOTPRINT_SUBSCRIBER_LIMIT)return null;
    this.#listeners.add(listener);
    return()=>{this.#listeners.delete(listener);};
  }
  notify(): void { for(const listener of this.#listeners){try{listener();}catch{this.#listeners.delete(listener);}} }
  measure() { const state=this.model.retainedSnapshot();return {logicalBytes:state.retainedBytesUpper+65_536+this.#listeners.size*FOOTPRINT_SUBSCRIBER_OWNER_BYTES,revision:state.revision,cells:state.cellCount,ids:state.idCount,subscribers:this.#listeners.size,pendingCoverageGaps:this.#gapSlots.reduce((n,slot)=>n+Number(slot.toMs>slot.fromMs),0)}; }
}
