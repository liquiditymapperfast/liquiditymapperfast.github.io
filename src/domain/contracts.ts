/** Stable Stage 2 data contracts. All timestamps are UTC epoch milliseconds. */
export type Venue = 'hyperliquid' | 'binance' | 'bybit' | 'okx' | 'bitget' | 'deribit' | 'coinbase' | 'kraken' | 'kucoin' | 'mexc' | 'htx' | 'bitfinex' | 'bitmex' | 'cryptocom' | 'bitstamp' | 'whitebit' | 'phemex' | 'dydx' | 'aster' | (string & {});
export type MarketType = 'spot' | 'perpetual' | 'delivery';
export type BookResolution = 'native' | 'coarse';
export type BookCoverage = 'complete' | 'partial' | 'unknown';
export type LayerKind = 'liquidity' | 'liquidation' | 'stopLoss' | 'takeProfit';
export type LayerSide = 'bid' | 'ask' | 'long' | 'short' | 'buy' | 'sell';
export type HeatmapMode = 'default' | 'hl_liq' | 'hl_sl' | 'hl_tp';
export type HeatmapAggregationMode = 'single' | 'aggregated';

/** Identity used to keep venue/native symbol/market type distinct from a display label. */
export interface InstrumentKey {
  venue: Venue; nativeSymbol: string; marketType: MarketType; base: string; quote: string;
  contractValue?: number;
}
export interface Instrument extends InstrumentKey {
  id: string;
  tickSize: number | null; quantityUnit: 'base' | 'quote' | 'contract';
}
export interface VisualMarket extends Instrument {
  exchange: Venue; symbol: string; baseNormalized: string; quoteNormalized: string;
  isFree: boolean; aggregationId: number; contractValue?: number;
}
export interface TimeRangeMs { from: number; to: number }
export interface PriceAmount { price: number; amount: number }
export type RuntimeBookRow = readonly [price: number, amount: number];
export interface DepthCoverageBounds { bids: { min: number; max: number } | null; asks: { min: number; max: number } | null }
export interface DepthSnapshot {
  kind: 'depthSnapshot'; instrumentId: string; sourceTimestamp: number | null; receivedAt: number;
  sequence?: number | string; bids: PriceAmount[]; asks: PriceAmount[]; complete: boolean;
  resolution?: BookResolution; resolutionKey?: string; bookKey?: string; feedId?: string;
  coverage?: BookCoverage; coverageBounds?: DepthCoverageBounds; grouping?: number; sourceGrouping?: number; sourceDepth?: number; sourceInterval?: string; sessionId?: string; tickSize?: number | null; nativeSymbol?: string; units?: 'base' | 'quote' | 'contract'; contractValue?: number;
  pool?: string;
}
export interface DepthDelta {
  kind: 'depthDelta'; instrumentId: string; sourceTimestamp: number | null; receivedAt: number;
  sequence?: number | string; previousSequence?: number | string; bids: PriceAmount[]; asks: PriceAmount[]; resolutionKey?: string; bookKey?: string; feedId?: string; contractValue?: number; pool?: string;
}
export type BookSyncState = 'snapshot' | 'synchronized' | 'stale' | 'resyncing' | 'unavailable';
/** Canonical renderer input. Synchronization and coverage are separate facts. */
export interface BookFrame {
  kind: 'bookFrame'; instrumentId: string; key: InstrumentKey; sessionId: string;
  exchangeTimestamp: number | null; receivedAt: number; sequence: number | string | null;
  resolution: BookResolution; bids: PriceAmount[]; asks: PriceAmount[];
  syncState: BookSyncState; coverage: BookCoverage; coverageBounds: DepthCoverageBounds | null;
  units: 'base' | 'quote' | 'contract'; grouping: number | null; sourceGrouping: number | null;
  bestBid: PriceAmount | null; bestAsk: PriceAmount | null;
}
export interface LevelRecord {
  id: string; layer: LayerKind; side: LayerSide; price: number; priceTo?: number;
  amount?: number; notionalUsd?: number; count?: number; active?: boolean;
  sourceTimestamp?: number | null; provisional?: boolean; takenAt?: number;
}
export interface LayerSnapshot {
  kind: 'layerSnapshot'; layer: LayerKind; instrumentId: string; sourceTimestamp: number | null;
  receivedAt: number; revision: string; referencePrice: number; complete: boolean;
  levels: LevelRecord[];
}
/** Identity fields established by mark-event runtime validation. */
export interface NormalizedMarkFrame extends Record<string, unknown> {
  markInstrumentId: string;
  sessionId: string;
  sequence: number;
  markPrice: number;
}
export interface LocalLevelEvent {
  kind: 'localLevelEvent'; levelId: string; layer: LayerKind; event: 'touched' | 'taken';
  markPrice: number; timestamp: number; provisional: true; sourceRevision: string;
}
export interface OpenInterestSample {
  kind: 'openInterest'; instrumentId: string; sourceTimestamp: number | null; receivedAt: number;
  observationTimestamp?: number; timeBasis?: 'exchange' | 'receipt'; base: number; quote?: number; quality: 'native' | 'sampled' | 'gap';
}
export interface OpenInterestCandle {
  start: number; end: number; open: number; high: number; low: number; close: number;
  samples: number; quality: 'native' | 'sampled' | 'gap';
}
export type OiObservation = OpenInterestSample;
export interface OiBar {
  kind: 'oiBar'; instrumentId: string; start: number; end: number;
  open: number; high: number; low: number; close: number; sampleCount: number;
  quality: 'native' | 'sampled' | 'gap'; timeBasis: 'exchange' | 'receipt' | 'mixed' | 'unknown';
}
export interface PriceLevelDistribution {
  lower: number; upper: number; bidAmount: number; askAmount: number;
  bidNotionalUsd: number; askNotionalUsd: number; observed: boolean;
  sourceResolution: BookResolution; coverage: BookCoverage; sourceCount: number;
}
export interface HeatmapColumn {
  kind: 'heatmapColumn'; instrumentId: string; start: number; end: number;
  grouping: number; gridVersion: string; levels: PriceLevelDistribution[];
  sourceResolution: BookResolution; coverage: BookCoverage; observedAt: number | null;
  gap: boolean;
}
export type TradeSide = 'buy' | 'sell' | 'unknown';
export interface TradeRecord {
  kind: 'trade'; venue: Venue; instrumentId: string; tradeId: string;
  side: TradeSide; price: number; amount: number; notionalUsd: number;
  sourceTimestamp: number | null; receivedAt: number; hash?: string; tid?: string;
}
export interface HyperliquidAssetMetadata {
  coin: string; instrumentId: string; szDecimals?: number; maxLeverage?: number;
  onlyIsolated: boolean; isDelisted: boolean;
  context?: { markPrice?: number; oraclePrice?: number; midPrice?: number; funding?: number; openInterest?: number };
}
export interface HyperliquidMetadataSnapshot {
  kind: 'metadata'; venue: 'hyperliquid'; sourceTimestamp: number | null;
  receivedAt: number; assets: HyperliquidAssetMetadata[];
}
export interface Viewport {
  timeFrom: number; timeTo: number; priceFrom: number; priceTo: number;
  plotLeft: number; plotTop: number; plotWidth: number; plotHeight: number;
  devicePixelRatio: number;
}
export interface ChartViewport extends Viewport {}
export interface DataStatus {
  state: 'live' | 'snapshot' | 'stale' | 'unavailable' | 'disabled' | 'backoff' | 'connecting' | 'stopped' | 'refreshing'; lastSuccess?: number;
  lastError?: string; gaps: number; quotaRemaining?: number;
}
export type FutureLevelCapabilityKey = 'liquidationLevels' | 'stopLossLevels' | 'takeProfitLevels';
export type VenueHistoryCoverage = 'public-backfill' | 'local-observed' | 'current-only' | 'none' | 'external';
export type VenueCapabilityKey = 'products' | 'trades' | 'l2' | 'candles' | 'candleHistory' | 'openInterest' | 'openInterestHistory' | 'executedLiquidations' | FutureLevelCapabilityKey | 'futureLevels';
export type CapabilityState = 'supported' | 'unsupported' | 'externallyBlocked';
export interface VenueCapability {
  state: CapabilityState;
  marketTypes?: readonly MarketType[];
  resolutions?: readonly BookResolution[];
  coverage?: VenueHistoryCoverage;
  limits?: string;
  reason?: string;
}
export interface VenueRegistryEntry {
  venue: Venue;
  label: string;
  status: CapabilityState;
  marketTypes: readonly MarketType[];
  capabilities: Readonly<Record<VenueCapabilityKey, VenueCapability>>;
  source?: string;
}
export interface BookNeed {
  kind: 'orderBook'; exchange: Venue; symbol: string; step: number; interval: number;
  marketType: MarketType; resolution?: BookResolution; coverage?: BookCoverage; sessionId?: string; history?: TimeRangeMs;
}
export interface CandleNeed {
  kind: 'candles'; exchange: Venue; symbol: string; interval: number;
  history?: TimeRangeMs; candleKind?: string; deriveHistogram?: boolean;
}
export interface TradeVolumeNeed {
  kind: 'leveledTradeVolume'; exchange: Venue; symbol: string; step: number; interval: number;
  marketType: MarketType; history?: TimeRangeMs;
}
export interface PriceNeed { kind: 'price'; exchange: Venue; symbol: string }
export type VisualNeed = BookNeed | CandleNeed | TradeVolumeNeed | PriceNeed;
export interface HeatmapConfig {
  interval: number; grouping: number; heatmapMode: HeatmapMode;
  heatmapAggregationMode: HeatmapAggregationMode; heatmapAggregationMarkets: VisualMarket[];
  showHeatmap: boolean; showOrderbookProfile: boolean; showVPVR: boolean; showTrades: boolean;
}
export interface ThemePalette {
  bg: string; text: string; bids: string; bidsSecondary: string; asks: string;
  asksSecondary: string; accent: string; accentSecondary: string;
}
export interface Theme extends ThemePalette { id: string; label: string; }
export interface DominanceSummary {
  lower: number; upper: number; lowerCumulative: number; upperCumulative: number;
  dominant: LayerSide | 'balanced' | 'unavailable'; difference: number; ratio: number | null;
  share: number | null; complete: boolean;
}
