import type { OrderbookVenueCatalog } from '../core/orderbook-venue-controls.mts';
import type { monitorEventLoopDelay } from 'node:perf_hooks';
import type { RuntimeState, RuntimeMarket } from '../domain/runtime-state.mts';
import type { QuotaLedger } from '../core/quota.mts';
import type { HistoryStore } from './history.mts';
import type { FootprintTransport } from './footprint-transport.mts';
import type { HyperTrackerClient, HyperTrackerRetentionCallback } from '../adapters/hypertracker.mts';
import type { LatestOnlyFrameQueue, LocalEventBus } from './realtime.mts';
import type { ProcessMemoryMonitor, ProcessMemoryUsage, ProcessMemoryDecision } from './process-memory.mts';
import type { RetainedBudgetCoordinator, RetainedAdmission } from './retained-budget.mts';
import type { PublicProductDiscoveryResult, PublicProductDiscoverySelection, PublicProductRetentionCallback } from './product-discovery.mts';

export type TransientResponseMemory = Pick<ProcessMemoryMonitor, 'reserveTransient'>;
export interface JsonResponseSink {
  writeHead(statusCode: number, headers: Record<string, string>): unknown;
  end(body: string): unknown;
  once(event: string, listener: () => unknown): unknown;
  off?(event: string, listener: () => unknown): unknown;
}
export interface StateStreamResponse extends JsonResponseSink {
  writableEnded: boolean;
  end(body?: string): unknown;
  write(body: string, callback?: () => unknown): boolean;
}
export interface StateStreamRequest { once(event: string, listener: () => unknown): unknown; }
export interface ServerStreamFrame { event: string; payload: Record<string, unknown>; }
export type ServerQueue = LatestOnlyFrameQueue<ServerStreamFrame>;
export type MutationContext = Record<string, unknown>;
export type MutationReservation = Pick<RetainedAdmission, 'bytes' | 'reason' | 'context'> & Partial<RetainedAdmission> & { physical?: boolean };
export interface AdmissionEstimate { bytes: number; measurements?: Record<string, unknown> | null; }
export interface MutationResult<T> { admitted: boolean; value?: T; reservation?: MutationReservation; physical?: boolean; removal?: Record<string, unknown>; after?: ReturnType<RetainedBudgetCoordinator['coordinate']>; }
export interface ProviderClient { mock?: boolean; request: (kind: string, options: { coin: string; path?: string | null; automatic?: boolean; onRetention?: HyperTrackerRetentionCallback }) => Promise<unknown>; requestOrdersSnapshot?: HyperTrackerClient['requestOrdersSnapshot']; }
export interface PublicCatalogReply { ok: boolean; statusCode?: number; error?: string; venue?: string; family?: string; products?: number; excludedInactive?: number; excludedUnsupported?: number; pages?: number; bytesRead?: number; source?: string; }
export interface PublicMarketControls {
  discover: (selection: PublicProductDiscoverySelection, onRetention: PublicProductRetentionCallback) => Promise<PublicProductDiscoveryResult>;
  select: (product: RuntimeMarket) => Promise<void>;
  retire?: (instrumentIds: readonly string[]) => void;
  orderbookCatalog?: () => OrderbookVenueCatalog;
  selectOrderbooks?: (product: RuntimeMarket, venues: readonly string[]) => Promise<void>;
}
export interface ProviderRefreshResult { ok: boolean; statusCode?: number; error?: string; kind?: string; instrumentId?: string; applied?: boolean; levels?: number; complete?: boolean; quota?: unknown; }
export interface RetainedOwnerMeasurement { logicalBytes: number | null; depthBuffers?: Record<string, unknown>; depthBridgePending?: Record<string, unknown>; resyncing?: number | readonly unknown[]; }
export interface FeedOwner {
  specs?: Map<string, { instrumentId?: string; channel?: string }> | Record<string, { instrumentId?: string; channel?: string }> | { instrumentId?: string; channel?: string }[];
  retainedRamBudget?: (options?: { cached?: boolean; allowStale?: boolean }) => RetainedOwnerMeasurement;
  retainedDiagnostics?: (options?: { cached?: boolean; allowStale?: boolean }) => RetainedOwnerMeasurement;
  reclaimRetainedRam?: (options: { targetBytes: number }) => unknown;
  refreshActiveBookSets?: () => unknown;
  /** What the last feed starts did (see LiveFeedManager.startDiagnostics). */
  startDiagnostics?: () => unknown;
}
export interface RetainedProviders {
  feeds?: FeedOwner | null; queues?: Set<ServerQueue>; processMemory?: ProcessMemoryMonitor; retainedBudget?: RetainedBudgetCoordinator;
  ramLimits?: { softLimitBytes?: unknown; hardLimitBytes?: unknown; physicalSoftLimitBytes?: unknown; physicalHardLimitBytes?: unknown };
  diagnosticsCache?: { body: string | null; generatedAt: number; lastRefreshAt: number; retainedBudgetRevision: number };
  measureStateComponents?: () => Record<string, number>;
  measureDiagnosticsCache?: () => RetainedOwnerMeasurement;
  measureProviderFlights?: () => RetainedOwnerMeasurement;
  measureQuotaLedger?: () => RetainedOwnerMeasurement;
  measureFootprint?: () => RetainedOwnerMeasurement;
  measureFootprintTransport?: () => RetainedOwnerMeasurement;
}
export interface ServerMetrics extends Record<string, unknown> {
  startedAt: number; fixtureTickMs: number | null; fixtureTicksRunning: boolean; fixtureFeedCount: number; fixtureBookLevels: number; fixtureBookBurstCount: number; fixtureBookInstrumentIds: string[]; bookLevelLimit: number;
  fixtureFeedEvents: number; fixtureBookSnapshots: number; fixtureBookDeltas: number; fixtureTicks: number; appliedMessages: number; statePublishes: number; stateRequests: number;
  fixtureBookEventsByFeed: Record<string, number>; fixtureBookDeltaEventsByFeed: Record<string, number>; fixtureBookSequencesByFeed: Record<string, number>;
  fixtureBookLevelCountsByFeed: Record<string, { bids: number; asks: number; total?: number }>; fixtureBookCompleteByFeed: Record<string, boolean>; fixtureBookGapByFeed: Record<string, boolean>;
  retainedAdmissionRejected: number; retainedAdmissionLast: { venue: string; reason: string; bytes: number; context: MutationContext; at: number; kind?: string; feedId?: string } | null;
  retainedRemovalMutations: number; retainedRemovalLast: Record<string, unknown> | null;
  physicalAdmissionRejected: number; physicalAdmissionLast: ProcessMemoryDecision | null;
  memorySamples: number; processMemoryPeak: Record<string, number> | null; physicalMemory: ReturnType<ProcessMemoryMonitor['snapshot']> | null;
  lastTickAt: number | null; lastPublishAt: number | null;
  streamStateSent: number; streamLiquiditySent: number; streamLiquidityReplacements: number; liquidityPublishes: number; liquiditySnapshotRejected: number; liquidityFrameMaxBytes: number;
  streamStateReplacements: number; streamMarkSent: number; streamMarkReplacements: number; streamDrainWaits: number; streamWriteErrors: number;
  streamStateSnapshotAdmissionRejected: number; streamStateSnapshotAdmissionLast: Record<string, unknown> | null; maxPendingState: number; maxPendingSlots: number; markPublishes: number; markSequence: number;
  eventLoop: ReturnType<typeof monitorEventLoopDelay>; candleSeriesCapacityRejects?: number;
}
export interface LocalServerOptions {
  state?: unknown; quota?: QuotaLedger; history?: HistoryStore; provider?: ProviderClient | null; providerPaths?: Record<string, string | null | undefined>;
  host?: string; fixtureTickMs?: number; restoreState?: boolean; persistFixture?: boolean; liveMode?: boolean; refreshIntervalMs?: number;
  retainedProviders?: RetainedProviders; retainedBudgetIntervalMs?: number; fixtureTickAutostart?: boolean;
  processMemoryRead?: () => ProcessMemoryUsage | null; activeCandleInstrumentIds?: readonly unknown[] | Set<unknown>;
}
export interface AttachStreamOptions {
  req: StateStreamRequest; res: StateStreamResponse; state: RuntimeState; quota: QuotaLedger; clients: Set<StateStreamResponse>; bus: LocalEventBus<ServerStreamFrame>;
  metrics?: ServerMetrics; processMemory?: TransientResponseMemory; queueRegistry?: Set<ServerQueue>;
  onQueueRegistryChange?: (() => void) | null; initialSnapshot?: Record<string, unknown> | null;
  /** Normal streams send a full bootstrap before native tails. */
  liveStateTail?: boolean;
  /** REST revision whose scoped histories the tail client has recovered. */
  tailRecoveryRevision?: number;
  /** Version-negotiated reconnect with already retained registry and histories. */
  retainedBaseline?: boolean;
  liquidityWireBytes?: number;
  nativeBookAliases?: boolean;
  runTailProjectionAdmitted?: (bytes: number, mutation: () => boolean) => boolean;
}
export interface RouteServices {
  footprintTransport?:FootprintTransport;
  runTailProjectionAdmitted?: (bytes: number, mutation: () => boolean) => boolean;
  metrics?: ServerMetrics; retainedProviders?: RetainedProviders; provider?: ProviderClient | null;
  refreshProvider?: (kind: string, options?: { coin?: unknown; automatic?: boolean }) => ProviderRefreshResult | Promise<ProviderRefreshResult>;
  selectProviderLayer?: (kind: unknown) => ProviderRefreshResult;
  publishState?: () => void; startFixtureTicks?: () => boolean; stopFixtureTicks?: () => boolean; invalidateRetainedBudgetSnapshot?: () => unknown;
  discoverPublicProducts?: (venue: unknown, family: unknown) => Promise<PublicCatalogReply>; selectPublicMarket?: (instrumentId: unknown) => Promise<PublicCatalogReply>;
  orderbookCatalog?: () => OrderbookVenueCatalog | PublicCatalogReply;
  selectOrderbooks?: (instrumentId: unknown, venues: unknown) => Promise<OrderbookVenueCatalog | PublicCatalogReply>;
  admitRetainedMutation?: <T>(candidate: unknown, context: MutationContext, mutation: () => T, onReject?: ((reservation: MutationReservation) => void) | null) => MutationResult<T>;
}
export interface CandleReclaimOptions { history?: HistoryStore | null; feeds?: FeedOwner | null; targetBytes?: number; protectedInstrumentIds?: Set<string>; instrumentId?: string; startupCandleInstrumentIds?: readonly string[] | Set<string>; }
export type BookSerializationOptions = { compact?: boolean; serverLevelsPerSide?: number };
export type DepthMarketState = Pick<RuntimeState, 'markets' | 'metadata'>;

export interface ProviderResourceResult { raw: unknown; receivedAt: number; }
export interface MarkCrossingRow { levelId: string; layer: string; instrumentId?: string; targetKey?: string | null; price: number; direction: 'up' | 'down' | null; observedAt: number; provisional: boolean; }
export interface MarkCrossingAccumulator { rows: MarkCrossingRow[]; nextIndex: number; overflow: boolean; }
export interface PublishMarkOptions { sourceTimestamp?: unknown; receivedAt?: number; serverReceivedAt?: number; crossings?: MarkCrossingRow[]; crossingsOverflow?: boolean; }
