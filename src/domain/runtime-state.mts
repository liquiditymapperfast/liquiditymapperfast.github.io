import type { CrossingLevel } from '../core/crossing.mts';
import type { RepresentationMetadata } from '../core/representation-limits.mts';
import type { LayerKind, PriceAmount, TradeRecord, VenueRegistryEntry } from './contracts.ts';

/** Reducer-owned data. Unknown metadata remains subject to the existing validators. */
export interface RuntimeMarket extends Record<string, unknown> {
  id?: string; instrumentId?: string; venue?: string; exchange?: string; nativeSymbol?: string;
  symbol?: string; base?: string; quote?: string; baseNormalized?: string; quoteNormalized?: string;
  marketType?: string; tickSize?: unknown; quantityUnit?: string; aggregationId?: unknown; contractValue?: unknown;
}
export interface RuntimeBook extends Record<string, unknown> {
  bids: [number, number][]; asks: [number, number][];
  complete?: boolean; gap?: boolean; invalidated?: boolean; resyncRequired?: boolean;
  instrumentId?: string; bookKey?: string; resolutionKey?: string; feedId?: string;
  sequence?: unknown; sourceTimestamp?: unknown; receivedAt?: unknown; invalidReason?: string;
  levelMetadata?: { bids?: Map<number, unknown> | Record<string, unknown>; asks?: Map<number, unknown> | Record<string, unknown> } | unknown[];
  representation?: RepresentationMetadata; units?: unknown; resolution?: unknown; coverage?: unknown;
  nSigFigs?: unknown; mantissa?: unknown; sourceGrouping?: unknown; grouping?: unknown; sourceDepth?: unknown; sourceInterval?: unknown;
  contractValue?: unknown; coverageBounds?: unknown; observedBounds?: unknown;
  sourceLevelCount?: { bids: number; asks: number }; retainedLevelCount?: { bids: number; asks: number }; retentionTruncated?: boolean;
}
export interface RuntimeCandle extends Record<string, unknown> {
  instrumentId: string; interval: string; start: number; end: number;
  open: number; high: number; low: number; close: number; volume?: number;
  sourceTimestamp?: unknown; receivedAt?: unknown; source?: string; quality?: string; closed?: boolean;
}
export interface RuntimeOiSample extends Record<string, unknown> {
  instrumentId?: string; sourceTimestamp?: unknown; receivedAt?: unknown;
  observationTimestamp?: unknown; timeBasis?: unknown; base?: number; quote?: number; quality?: string;
}
export interface RuntimeLevel extends CrossingLevel, Record<string, unknown> {
  instrumentId?: string; lower?: number; upper?: number; sourceResolution?: string;
}
export interface RuntimeLayerMeta extends Record<string, unknown> {
  instrumentId?: string; sourceTimestamp?: unknown; receivedAt?: unknown; revision?: unknown;
  complete?: boolean; empty?: boolean; mock?: boolean; source?: string; generatedAt?: unknown;
  coverage?: string; units?: string; provenanceKnown?: boolean; sourceTimestampKnown?: boolean; revisionKnown?: boolean;
}
export interface RuntimeStatus extends Record<string, unknown> {
  state?: string; lastSuccess?: number; lastError?: string | null; gaps?: number; mock?: boolean; source?: string;
  resyncRequired?: boolean; receivedAt?: number; sourceTimestamp?: unknown; nextRefreshAt?: number;
  bytes?: number; lastRequest?: number;
}
export interface RuntimeState extends Record<string, unknown> {
  asOf: number; markPrice: number; markets: RuntimeMarket[]; books: Record<string, RuntimeBook>;
  booksByKey: Record<string, RuntimeBook>; bookSelection: Record<string, unknown>; activeBookKeys: Record<string, string[]>;
  layers: Record<string, RuntimeLevel[]>; layerMeta: Record<string, RuntimeLayerMeta>;
  layerRevisions: Record<string, string>; layerSourceTimestamps: Record<string, number>;
  oi: RuntimeOiSample[]; candles: Record<string, RuntimeCandle[]>;
  metadata: Record<string, { assets?: RuntimeMarket[]; [key: string]: unknown }>; trades: TradeRecord[];
  statuses: Record<string, RuntimeStatus>; feedStatuses: Record<string, RuntimeStatus>; sourceTimestamps: Record<string, number | null>;
  venueRegistry?: VenueRegistryEntry[]; markInstrumentId: string; markObserved?: boolean;
  markSequence?: number; markSessionId?: string; markContinuity?: { state: string; reason: string; at: number; sessionId: string } | null;
  liquiditySequence: number; liquiditySessionId: string; dataMode?: string; liveMode?: boolean;
  tailRecoveryRevision?: number;
}
/** Normalized reducer envelope, distinct from raw exchange/HTTP JSON. */
export interface RuntimeMessage extends Record<string, unknown> {
  kind: string; instrumentId?: string; sourceTimestamp?: unknown; receivedAt?: unknown;
  sequence?: unknown; previousSequence?: unknown; price?: unknown; bids?: PriceAmount[]; asks?: PriceAmount[];
  invalidated?: boolean; gap?: boolean; resyncRequired?: boolean; invalidReason?: unknown; complete?: boolean;
  bookKey?: string; resolutionKey?: string; feedId?: string; resolution?: unknown; units?: unknown;
  nSigFigs?: unknown; mantissa?: unknown; sourceGrouping?: unknown; sourceDepth?: unknown; sourceInterval?: unknown;
  sourceLevelCount?: { bids: number; asks: number }; coverage?: unknown; coverageBounds?: unknown;
  market?: RuntimeMarket; marketType?: unknown; nativeSymbol?: unknown; base?: unknown; quote?: unknown; tickSize?: unknown; contractValue?: unknown; pool?: unknown;
  layer?: LayerKind; levels?: RuntimeLevel[]; revision?: unknown; referencePrice?: number;
  provenanceKnown?: boolean; sourceTimestampKnown?: boolean; revisionKnown?: boolean; preserveProvisional?: boolean;
  mock?: boolean; source?: string; generatedAt?: unknown; fixture?: boolean;
  assets?: RuntimeMarket[]; trades?: TradeRecord[]; baseValue?: number; quoteValue?: number; quality?: string;
  interval?: string; start?: number; end?: number; open?: number; high?: number; low?: number; close?: number; volume?: number; closed?: boolean;
}
