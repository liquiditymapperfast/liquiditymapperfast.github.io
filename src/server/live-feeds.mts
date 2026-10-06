/// <reference path="./ws-runtime.d.ts" />
import { ORDERBOOK_VENUE_MAX_SELECTED } from '../core/orderbook-venue-controls.mts';
import { gunzipSync } from 'node:zlib';
import { LiveFeedOperationScope, retireLiveFeedSocket, waitForLiveFeedSocketOpen } from './live-feed-transport.mts';
import {
  AdapterTransportError,
  buildBinanceRequest,
  buildBinanceSubscription,
  buildBybitRequest,
  buildBybitSubscription,
  binanceInstrumentId,
  bybitInstrumentId,
  bitgetInstrumentId,
  isBinanceUsdtTradeSymbol,
  buildHyperliquidInfoRequest,
  buildHyperliquidSubscription,
  HYPERLIQUID_WS_URL,
  BINANCE_SPOT_WS_URL,
  BINANCE_FUTURES_WS_URL,
  BINANCE_FUTURES_MARKET_WS_URL,
  BYBIT_LINEAR_WS_URL,
  OKX_PUBLIC_WS_URL,
  BITGET_PUBLIC_WS_URL,
  GATEIO_USDT_WS_URL,
  DERIBIT_PUBLIC_WS_URL,
  COINBASE_PUBLIC_WS_URL,
  KRAKEN_PUBLIC_WS_URL,
  KUCOIN_PUBLIC_WS_URL,
  MEXC_CONTRACT_WS_URL,
  HTX_USDT_WS_URL,
  BITFINEX_PUBLIC_WS_URL,
  BITMEX_PUBLIC_WS_URL,
  CRYPTOCOM_PUBLIC_WS_URL,
  BITSTAMP_PUBLIC_WS_URL,
  WHITEBIT_PUBLIC_WS_URL,
  DYDX_PUBLIC_WS_URL,
  ASTER_PUBLIC_WS_URL,
  normalizeBinanceExchangeInfo,
  normalizeBinanceDepth,
  normalizeBinanceDepthDelta,
  normalizeBinanceAggTrade,
  normalizeBinanceKline,
  normalizeBinanceOpenInterest,
  normalizeBinanceOpenInterestHistory,
  normalizeBybitDepth,
  normalizeBybitDepthDelta,
  normalizeBybitInstrumentInfo,
  createBybitDepthSession,
  applyBybitDepthSessionMessage,
  invalidateBybitDepthSession,
  buildOkxSubscription,
  buildOkxRequest,
  normalizeOkxDepth,
  normalizeOkxInstrumentInfo,
  buildBitgetSubscription,
  buildBitgetRequest,
  normalizeBitgetDepth,
  normalizeBitgetInstrumentInfo,
  buildGateSubscription,
  buildGateRequest,
  normalizeGateDepth,
  normalizeGateContractInfo,
  buildDeribitSubscription,
  buildDeribitRequest,
  normalizeDeribitDepth,
  normalizeDeribitInstrumentInfo,
  buildCoinbaseRequest,
  buildCoinbaseSubscription,
  normalizeCoinbaseDepth,
  normalizeCoinbaseProduct,
  buildKrakenRequest,
  buildKrakenSubscription,
  normalizeKrakenDepth,
  parseKrakenBookJson,
  krakenWebSocketSymbol,
  normalizeKrakenAssetPairs,
  createKrakenDepthSession,
  applyKrakenDepthSessionMessage,
  buildKucoinRequest,
  buildKucoinSubscription,
  buildKucoinWsUrl,
  normalizeKucoinDepth,
  normalizeKucoinPublicToken,
  normalizeKucoinSymbol,
  buildMexcRequest,
  buildMexcSubscription,
  normalizeMexcDepth,
  normalizeMexcContractInfo,
  buildHtxRequest,
  buildHtxSubscription,
  normalizeHtxDepth,
  normalizeHtxContractInfo,
  buildBitfinexRequest,
  buildBitfinexSubscription,
  normalizeBitfinexDepth,
  normalizeBitfinexSymbolsDetails,
  createBitfinexDepthSession,
  applyBitfinexDepthSessionMessage,
  invalidateBitfinexDepthSession,
  buildBitmexRequest,
  buildBitmexSubscription,
  normalizeBitmexDepth,
  normalizeBitmexInstrument,
  normalizeBitmexPool,
  createBitmexDepthSession,
  applyBitmexDepthSessionMessage,
  invalidateBitmexDepthSession,
  buildCryptocomRequest,
  buildCryptocomSubscription,
  normalizeCryptocomDepth,
  normalizeCryptocomInstrument,
  createCryptocomDepthSession,
  applyCryptocomDepthSessionMessage,
  invalidateCryptocomDepthSession,
  buildBitstampRequest,
  buildBitstampSubscription,
  normalizeBitstampDepth,
  normalizeBitstampTradingPairs,
  buildWhitebitRequest,
  buildWhitebitSubscription,
  normalizeWhitebitDepth,
  normalizeWhitebitMarkets,
  PHEMEX_PUBLIC_WS_URL,
  buildPhemexRequest,
  buildPhemexSubscription,
  normalizePhemexDepth,
  normalizePhemexProducts,
  createPhemexDepthSession,
  applyPhemexDepthSessionMessage,
  invalidatePhemexDepthSession,
  buildDydxRequest,
  buildDydxSubscription,
  normalizeDydxMarkets,
  normalizeDydxTrades,
  normalizeDydxDepth,
  buildAsterRequest,
  buildAsterSubscription,
  normalizeAsterMarkets,
  normalizeAsterTrades,
  normalizeAsterDepth,
  isAsterLinearDepthMetadata,
  createPublicDepthSession,
  applyPublicDepthSessionMessage,
  invalidatePublicDepthSession,
  normalizeHyperliquidAssetContext,
  normalizeHyperliquidBook,
  normalizeHyperliquidCandle,
  normalizeHyperliquidMetadata,
  normalizeHyperliquidTrades,
  matchesHyperliquidSubscriptionResponse,
  matchesHyperliquidSubscriptionData,
  validateHyperliquidGrouping,
  hyperliquidBookResolutionKey,
  hyperliquidCoin,
  hyperliquidNativeCoin,
  intervalMilliseconds,
  venueControlFrame,
  venueHeartbeatFrame,
  VenueHeartbeatDeadline,
  VenueTransportBudget,
  reconnectDelay,
} from '../adapters/index.mts';
import { logicalRetainedBytes, logicalRetainedComponents } from '../core/retained-bytes.mts';
import { EXCHANGE_REST_MEMORY_ADMISSION_WAITER_LOGICAL_BYTES, MAX_EXCHANGE_REST_MEMORY_ADMISSION_WAITERS } from './rest-transport.mts';
import { assertNativeCandleInterval, assertSupportedCandleInterval, candleMatchesInterval, NATIVE_CANDLE_INTERVAL } from '../core/candle-source.mts';
import { bookKey } from '../core/book-key.mts';
import { createRestRequestCoordinator, DEFAULT_REST_POLICIES, restRequestKey } from '../core/rest-retry.mts';
import { DEFAULT_BOUNDED_JSON_RESPONSE_DEPTH, DEFAULT_BOUNDED_JSON_RESPONSE_TOKENS, DEFAULT_BOUNDED_JSON_TOKEN_MEMORY_BYTES, scanBoundedJsonComplexity } from '../core/bounded-json-response.mts';

import type { RuntimeMessage } from '../domain/runtime-state.mts';
import type { AdapterOptions, RequestDescriptor, SubscriptionDescriptor } from '../adapters/common.mts';
import type { VenuePolicyOverrides } from '../adapters/venue-transport.mts';
import type { RestRequest, RestAttemptContext, RestRetryPolicy } from '../core/rest-retry.mts';
import type { ExchangeRestRequest } from './rest-transport.mts';
import type { ProcessMemoryDecision, ProcessMemoryReservation } from './process-memory.mts';
import type { MarketNormalizationInput } from '../core/normalize.mts';
import type { MutationContext, MutationReservation, MutationResult } from './http-contracts.mts';
type KnownFields<T> = { [Key in keyof T as string extends Key ? never : number extends Key ? never : Key]: T[Key] };
export type LiveNormalizedMessage = Omit<KnownFields<RuntimeMessage>, 'assets' | 'market'> & { payload?: unknown; side?: string; tradeId?: unknown;
  amount?: number; crossSequence?: unknown; notionalUsd?: number; historySource?: string; assets?: LiveFeedSourceMarket[]; market?: LiveFeedSourceMarket; venue?: string; nativeSymbol?: string; table?: string; action?: string; changes?: unknown[]; channel?: string; depth?: number; firstUpdate?: unknown; continuity?: string; sequenceJump?: boolean; markPrice?: number; checksumVerified?: boolean; };
type FeedRecord = Record<string, unknown>;
function feedRecord(value: unknown): FeedRecord { return value !== null && typeof value === 'object' ? value as FeedRecord : {}; }
function feedArray(value: unknown): unknown[] { return Array.isArray(value) ? value : []; }
function feedError(value: unknown): FeedRecord { return feedRecord(value); }
/** Scheduling tokens are opaque: injected schedulers own the matching cancellation protocol. */
export type FeedTimer = unknown;
function cancelNativeTimer(timer: FeedTimer): void {
  // Node validates the handle itself; keep custom scheduling tokens opaque at this delegation boundary.
  Reflect.apply(clearTimeout, undefined, [timer]);
}
/** The manager creates each session with the constructor paired to its selected venue. */
function feedSession<T extends LiveDepthSession>(feed: LiveFeed, _factory: (options: AdapterOptions) => T, venue: string): T {
  if (!feed.session || (venue !== 'public' && feed.spec.venue !== venue)) throw new TypeError('Live feed depth session ownership mismatch');
  return feed.session as T;
}
export interface LiveFeedSocket {
  onMessage?: (raw: unknown) => void; onClose?: (reason: unknown) => void; onError?: (error: unknown) => void;
  send?: (payload: string) => unknown; close?: () => unknown; terminate?: () => unknown; open?: () => unknown | PromiseLike<unknown>;
  on?: (event: string, listener: (payload: unknown) => void) => unknown;
}
export interface LiveFeedRequest extends SubscriptionDescriptor { symbol?: string; channel?: string; topic?: string; stream?: string; productId?: string; }
export interface LiveFeedSpec {
  venue: string; channel: string; symbol?: string; coin?: string; marketType?: string; family?: string; category?: string; instType?: string; metadata?: LiveFeedSourceMarket; interval?: string; topic?: string;
  instrumentId?: string; bookKey?: string; resolutionKey?: string; resolution?: string; nSigFigs?: unknown; mantissa?: unknown;
  sourceGrouping?: unknown; sourceDepth?: unknown; sourceInterval?: unknown; request: LiveFeedRequest;
  publicDepth?: boolean; serverHeartbeat?: boolean; configurationGeneration?: number;
  decode: (raw: unknown) => LiveNormalizedMessage | LiveNormalizedMessage[] | null;
}
export interface LiveFeedTransportOptions { id?: string; venue?: string; channel?: string | null; marketType?: string; request: LiveFeedRequest; instrumentId?: string; resolutionKey?: string; bookKey?: string; handshakeTimeoutMs?: number; }
export interface LiveFeedRetainedMutation { candidate: FeedRecord; committed: boolean; commit: () => void; }
export interface LiveFeedEvent { id: string; venue: string; message: LiveNormalizedMessage; receivedAt: number; retainedMutation?: LiveFeedRetainedMutation; }
export interface LiveFeedTradeBatchEvent { venue: string; messages: readonly LiveNormalizedMessage[]; feedId: string; }
export interface LiveFeedStatus extends FeedRecord { state?: string; attempt?: number; nextRetryAt?: number | null; }
export interface LiveFeedStatusEvent extends LiveFeedStatus { id: string; }
export interface LiveFeedRestTransport { request: (request: ExchangeRestRequest, context?: RestAttemptContext) => unknown | PromiseLike<unknown>; retainedSnapshot?: () => unknown; }
export type LiveDepthSession = ReturnType<typeof createBybitDepthSession> | ReturnType<typeof createKrakenDepthSession> | ReturnType<typeof createBitfinexDepthSession> | ReturnType<typeof createBitmexDepthSession> | ReturnType<typeof createCryptocomDepthSession> | ReturnType<typeof createPhemexDepthSession> | ReturnType<typeof createPublicDepthSession>;
export interface LiveFeed {
  id: string; socket: LiveFeedSocket | null; spec: LiveFeedSpec; generation: number | undefined; configurationGeneration?: number;
  retry: FeedTimer | null; retired: boolean; sessionToken?: string | null; session?: LiveDepthSession | null;
  connectionAcquired?: boolean; transportReleased?: boolean; subscriptionKey?: string; subscriptionAcked?: boolean;
  preAckFrames?: unknown[] | null; preAckBytes?: number; channelId?: unknown; serverHeartbeat?: boolean;
  heartbeat?: VenueHeartbeatDeadline; heartbeatTimer?: FeedTimer | null; heartbeatStarted?: boolean; transportMessages?: number; kucoinWelcome?: boolean; pool?: string | null;
}
/** Logical ownership allowances for opaque native/runtime resources. These are
 * shell estimates; process RSS is authoritative for native TLS/socket/timer
 * buffers and function closures. Never enumerate those resource graphs. */
export const LIVE_FEED_TRANSPORT_SHELL_LOGICAL_BYTES = 2048;
export const LIVE_FEED_TIMER_SHELL_LOGICAL_BYTES = 256;
export const LIVE_FEED_CALLBACK_SHELL_LOGICAL_BYTES = 256;
export interface LiveFeedNativeOwnership {
  transports: number; transportAllowanceBytes: number; transportLogicalBytes: number;
  timers: number; timerAllowanceBytes: number; timerLogicalBytes: number;
  callbacks: number; callbackAllowanceBytes: number; callbackLogicalBytes: number;
  nativeGraphTraversed: false; accounting: 'fixed-logical-shell-allowance'; physicalMemory: 'process-RSS-authoritative';
}
export interface LiveFeedRestRetention { measurementAvailable: true; memoryAdmissionWaiters: number; memoryAdmissionWaiterLimit: number; memoryAdmissionWaiterAllowanceBytes: number; memoryAdmissionWaiterLogicalBytes: number; }
export interface LiveFeedDiagnostics extends FeedRecord {
  feedIds: string[]; specIds: string[]; bookSequences: Record<string, unknown>; depthBuffers: Record<string, number>; depthBridgePending: Record<string, boolean>; resyncing: string[];
  lastPrices: Record<string, number>; sessionVenues: { id: string; venue: string }[]; transportBudget: ReturnType<VenueTransportBudget['snapshot']>;
  transportFeeds: { id: string; venue: string; generation: number | undefined; subscriptionAcked: boolean; transportReleased: boolean; lastObservedAt: number | null; lastHeartbeatAt: number | null }[];
  exchangeRestTransportRetention: LiveFeedRestRetention | null; measurementComplete: boolean; measurementError: string | null;
  logicalComponents: Record<string, number>; logicalBytes: number | null; partialLogicalBytes: number | null; nativeOwnership: LiveFeedNativeOwnership;
}
export interface LiveFeedSourceMarket extends MarketNormalizationInput {
  coin?: unknown; instrumentId?: unknown; contractValue?: unknown; contractMultiplier?: unknown;
  contractType?: unknown; status?: unknown; isDelisted?: unknown; metadataSource?: unknown;
  qtyStep?: unknown; lotSize?: unknown; settleCoin?: unknown; minQty?: unknown; minNotional?: unknown; family?: unknown; category?: unknown; instType?: unknown; inverse?: unknown; pair?: unknown; exchangeContractType?: unknown;
}
export interface LiveFeedMetadata extends LiveNormalizedMessage { venue: string; assets: LiveFeedSourceMarket[]; }
export interface LiveFeedOptions {
  networkEnabled?: boolean; transportFactory?: ((options: LiveFeedTransportOptions) => LiveFeedSocket | PromiseLike<LiveFeedSocket>) | null;
  restTransport?: LiveFeedRestTransport | null; onMessage?: (event: LiveFeedEvent) => unknown; onTradeBatch?: (event: LiveFeedTradeBatchEvent) => boolean | void; onStatus?: (event: LiveFeedStatusEvent) => void;
  retainedAdmission?: (<T>(candidate: unknown, context: MutationContext, commit: () => T, reject?: ((reservation: MutationReservation) => void) | null) => MutationResult<T>) | null;
  reserveTransientMemory?: ((bytes: number, context: FeedRecord) => ProcessMemoryReservation) | null;
  now?: () => number; schedule?: (callback: () => unknown, delay: number) => FeedTimer; cancel?: (timer: FeedTimer) => void;
  heartbeatSchedule?: (callback: () => unknown, delay: number) => FeedTimer; heartbeatCancel?: (timer: FeedTimer) => void;
  reconnectBaseMs?: number; reconnectMaxMs?: number; oiPollMs?: number; oiHistoryPeriod?: string; oiHistoryLimit?: number; candleInterval?: string; candleHistoryLimit?: number;
  restRetryPolicies?: Record<string, Partial<RestRetryPolicy>>; restRandom?: () => number; transportPolicies?: VenuePolicyOverrides; transportBudget?: VenueTransportBudget | null; transportNow?: () => number; transportIdleMs?: number;
  /** How often the liveness check runs (0: off, the default; the server turns it on). */
  startWatchdogMs?: number;
  /** How long one start() may run before the watchdog abandons it and starts again. */
  startTimeoutMs?: number;
  log?: (message: string) => void;
}
export interface LiveFeedStartOptions extends AdapterOptions {
  hlNativeCoin?: string; binanceSymbol?: string; binanceMarketType?: string; binanceFamily?: 'usdm' | 'coinm'; bybitCategory?: 'linear' | 'spot' | 'inverse'; okxMarketType?: 'perpetual' | 'spot'; bitgetMarketType?: 'perpetual' | 'spot'; candleInterval?: string; hlBookNsigFigs?: unknown; hlBookMantissa?: unknown; hlBookResolutions?: unknown;
  bybitEnabled?: boolean; bybitSymbol?: string | null; okxEnabled?: boolean; okxSymbol?: string | null; bitgetEnabled?: boolean; bitgetSymbol?: string | null; gateioEnabled?: boolean; gateioSymbol?: string | null;
  deribitEnabled?: boolean; deribitSymbol?: string | null; coinbaseEnabled?: boolean; coinbaseSymbol?: string | null; krakenEnabled?: boolean; krakenSymbol?: string | null; kucoinEnabled?: boolean; kucoinSymbol?: string | null;
  mexcEnabled?: boolean; mexcSymbol?: string | null; htxEnabled?: boolean; htxSymbol?: string | null; bitfinexEnabled?: boolean; bitfinexSymbol?: string | null; bitmexEnabled?: boolean; bitmexSymbol?: string | null;
  cryptocomEnabled?: boolean; cryptocomSymbol?: string | null; bitstampEnabled?: boolean; bitstampSymbol?: string | null; whitebitEnabled?: boolean; whitebitSymbol?: string | null; phemexEnabled?: boolean; phemexSymbol?: string | null;
  dydxEnabled?: boolean; dydxSymbol?: string | null; asterEnabled?: boolean; asterSymbol?: string | null;
  /** Exact opt-in L2 venue set; reference mark/candle/trade channels remain. */
  selectedOrderbookVenues?: readonly string[];
  /** Same-base venue changes can retain existing reference history and normal OI polling. */
  referenceBackfill?: boolean;
}
const PUBLIC_ORDERBOOK_VENUES = new Set(['hyperliquid', 'binance', 'bybit', 'okx', 'bitget', 'gateio', 'deribit', 'coinbase', 'kraken', 'kucoin', 'mexc', 'htx', 'bitfinex', 'bitmex', 'cryptocom', 'bitstamp', 'whitebit', 'phemex', 'dydx', 'aster']);
/** Validate and capture before changing the current running configuration. */
function selectedOrderbooks(value: readonly string[] | undefined): ReadonlySet<string> | null {
  if (value === undefined) return null;
  if (!Array.isArray(value) || value.length > ORDERBOOK_VENUE_MAX_SELECTED) throw new RangeError(`selectedOrderbookVenues must contain at most ${ORDERBOOK_VENUE_MAX_SELECTED} unique supported venue IDs`);
  const selected = new Set<string>();
  for (const venue of value) {
    if (typeof venue !== 'string' || !PUBLIC_ORDERBOOK_VENUES.has(venue) || selected.has(venue)) throw new RangeError('selectedOrderbookVenues must contain unique supported venue IDs');
    selected.add(venue);
  }
  return selected;
}
function isPublicOrderbookSpec(spec: LiveFeedSpec): boolean {
  return spec.publicDepth === true || spec.channel === 'l2Book' || spec.channel === 'depth';
}
interface PublicFamilySelection {
  venue: string; instrumentId?: string; marketType?: string; family?: string; category?: string; instType?: string;
}
/** Consume normalized selected-product metadata, preserving its native quantity unit. */
function selectedPublicFamilyMetadata(metadata: unknown, spec: PublicFamilySelection): LiveFeedSourceMarket | null {
  const assets = feedArray(feedRecord(metadata).assets);
  const matches = assets.filter(asset => feedRecord(asset).instrumentId === spec.instrumentId && feedRecord(asset).venue === spec.venue);
  if (matches.length !== 1) return null;
  const row = feedRecord(matches[0]);
  const tickSize = row.tickSize, lotSize = row.qtyStep ?? row.lotSize;
  if (row.marketType !== spec.marketType || row.isDelisted !== false || typeof row.status !== 'string' || !row.status
    || typeof row.base !== 'string' || !row.base || typeof row.quote !== 'string' || !row.quote
    || typeof tickSize !== 'number' || !Number.isFinite(tickSize) || tickSize <= 0
    || typeof lotSize !== 'number' || !Number.isFinite(lotSize) || lotSize <= 0
    || !['base', 'quote', 'contract'].includes(String(row.quantityUnit))) return null;
  if (spec.family === 'coinm' && (row.family !== 'coinm' || row.quantityUnit !== 'contract'
    || row.inverse !== true || row.contractType !== 'inverse' || row.quote !== 'USD' || row.settleCoin !== row.base
    || typeof row.contractValue !== 'number' || !Number.isFinite(row.contractValue) || row.contractValue <= 0
    || typeof row.pair !== 'string' || !row.pair || !['PERPETUAL', 'CURRENT_QUARTER', 'NEXT_QUARTER'].includes(String(row.exchangeContractType)))) return null;
  if (spec.venue === 'bybit' && (row.category !== spec.category || row.quantityUnit !== (spec.category === 'inverse' ? 'quote' : 'base'))) return null;
  if ((spec.venue === 'okx' || spec.venue === 'bitget') && spec.marketType === 'spot'
    && (row.quantityUnit !== 'base' || String(row.instType ?? row.category).toLowerCase() !== String(spec.instType).toLowerCase())) return null;
  if (spec.venue === 'bitget' && (!['spot', 'usdt-futures'].includes(String(spec.instType))
    || row.quantityUnit !== 'base' || row.contractValue != null || row.inverse === true
    || String(row.instType ?? row.category).toLowerCase() !== String(spec.instType).toLowerCase())) return null;
  return row;
}
interface BinanceResyncToken { generation: number | null | undefined; }
function exchangeRestRequest(request: RestRequest): ExchangeRestRequest {
  if (typeof request.url !== 'string' || (request.method != null && typeof request.method !== 'string') || (request.body != null && typeof request.body !== 'string')) throw new TypeError('Invalid exchange REST request descriptor');
  const headers = request.headers;
  if (headers != null && (typeof headers !== 'object' || Array.isArray(headers) || Object.values(headers).some(value => typeof value !== 'string'))) throw new TypeError('Invalid exchange REST headers');
  return { url: request.url, ...(typeof request.method === 'string' ? { method: request.method } : {}), ...(typeof request.body === 'string' ? { body: request.body } : {}), ...(headers == null ? {} : { headers: headers as Record<string, string> }), ...(typeof request.responseClass === 'string' ? { responseClass: request.responseClass } : {}) };
}

export const MAX_LIVE_FEED_MESSAGE_BYTES = 1_048_576;
export const MAX_COINBASE_L2_MESSAGE_BYTES = 2 * MAX_LIVE_FEED_MESSAGE_BYTES;
/** Coinbase's public full level2_batch snapshot is larger than the ordinary
 * frame cap. Only this exact selected descriptor receives the explicit bound. */
export function liveFeedMessageLimitBytes({ venue, marketType, channel, request }: Pick<LiveFeedTransportOptions, 'venue' | 'marketType' | 'channel' | 'request'>): number {
  return venue === 'coinbase' && marketType === 'spot' && channel === 'level2_batch'
    && request.url === COINBASE_PUBLIC_WS_URL && request.method === 'subscribe' && request.channel === 'level2_batch'
    && typeof request.productId === 'string' && /^[A-Z0-9]+-[A-Z0-9]+$/.test(request.productId)
    && request.topic === 'level2_batch:' + request.productId
    ? MAX_COINBASE_L2_MESSAGE_BYTES : MAX_LIVE_FEED_MESSAGE_BYTES;
}

function liveFeedMessageByteLength(raw: unknown) {
  if (typeof raw === 'string') return Buffer.byteLength(raw, 'utf8');
  if (raw instanceof Uint8Array || Buffer.isBuffer(raw)) return raw.byteLength;
  return null;
}

function liveFeedMessageLimitError(kind: string, maxBytes = MAX_LIVE_FEED_MESSAGE_BYTES) {
  const error = Object.assign(new RangeError('live feed ' + kind + ' message exceeds ' + maxBytes + ' bytes'), { transportFatal: true });
  Object.assign(error, { transportFatal: true });
  return error;
}

function liveFeedMessageIsGzip(raw: unknown) {
  return (Buffer.isBuffer(raw) || raw instanceof Uint8Array) && raw.byteLength >= 2 && raw[0] === 0x1f && raw[1] === 0x8b;
}

function decodeLiveFeedUtf8(bytes: Uint8Array) {
  try {
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch (cause) {
    const error = Object.assign(new TypeError('live feed message contains invalid UTF-8', { cause }), { code: 'INVALID_UTF8', transportFatal: true });
    error.code = 'INVALID_UTF8';
    Object.assign(error, { transportFatal: true });
    throw error;
  }
}

function liveFeedProcessMemoryError(admission: Partial<ProcessMemoryDecision> | null | undefined, stage: string) {
  const reason = String(admission?.reason ?? 'reservation-unavailable');
  const error = Object.assign(new Error('live feed ' + stage + ' process-RSS admission rejected: ' + reason), { code: 'PROCESS_MEMORY_LIMIT', transportFatal: true, admission: {} as FeedRecord });
  error.code = 'PROCESS_MEMORY_LIMIT';
  Object.assign(error, { transportFatal: true });
  error.admission = {
    reason,
    requestedBytes: Number.isSafeInteger(admission?.requestedBytes) ? admission?.requestedBytes : null,
    projectedRssBytes: Number.isSafeInteger(admission?.projectedRssBytes) ? admission?.projectedRssBytes : null,
    hardLimitBytes: Number.isSafeInteger(admission?.hardLimitBytes) ? admission?.hardLimitBytes : null,
  };
  return error;
}

const DEPTH_INVALID_REASON_LIMIT = 240;
const LIVE_FEED_MANAGER_STATUS_ID_LIMIT = 96;
const LIVE_FEED_MANAGER_STATUS_ERROR_LIMIT = 512;
const LIVE_FEED_MANAGER_STATUS_MAX_ENTRIES = 64;
const LIVE_FEED_MANAGER_STATUS_ENTRY_MAX_BYTES = 64 * 1024;
const LIVE_FEED_MANAGER_STATUS_MAP_MAX_BYTES = 512 * 1024;
const LIVE_FEED_MANAGER_LAST_PRICE_MAX_ENTRIES = 64;
const LIVE_FEED_MANAGER_STATUS_FRESHNESS_INTERVAL_MS = 5_000;
const LIVE_FEED_MANAGER_STATUS_FRESHNESS_FIELDS = new Set([
  'lastSuccess', 'lastObservedAt', 'lastHeartbeatAt', 'lastTransportSendAt', 'transportMessages',
]);

export function configuredCandleInstrumentIds({ coin = 'BTC', binanceFamily = 'usdm', binanceSymbol = binanceFamily === 'coinm' ? 'BTCUSD_PERP' : 'BTCUSDT', binanceMarketType = 'perpetual' }: LiveFeedStartOptions = {}) {
  const normalizedCoin = hyperliquidCoin(coin);
  return [...new Set([
    `hyperliquid:${normalizedCoin}-PERP`,
    binanceInstrumentId(binanceSymbol, binanceMarketType, binanceFamily),
  ])];
}

function boundedDepthInvalidReason(reason: unknown) {
  return String(reason ?? 'depth resynchronization required').slice(0, DEPTH_INVALID_REASON_LIMIT);
}

function boundedManagerStatusValue(value: unknown, key: string, depth: number = 0): unknown {
  if (value === null || typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
  if (typeof value === 'string') {
    const limit = key === 'state' ? 32 : key === 'lastError' || key.endsWith('Error') ? LIVE_FEED_MANAGER_STATUS_ERROR_LIMIT : 256;
    return value.slice(0, limit);
  }
  if (depth >= 2) return undefined;
  if (Array.isArray(value)) return value.slice(0, 4).map((item) => boundedManagerStatusValue(item, key, depth + 1)).filter((item) => item !== undefined);
  if (!value || typeof value !== 'object') return undefined;
  const bounded: FeedRecord = {};
  let retained = 0;
  for (const childKey in value) {
    if (!Object.prototype.hasOwnProperty.call(value, childKey)) continue;
    if (retained >= 32) break;
    const normalizedKey = childKey.slice(0, 256);
    const child = boundedManagerStatusValue(feedRecord(value)[childKey], normalizedKey, depth + 1);
    if (child === undefined) continue;
    bounded[normalizedKey] = child;
    retained += 1;
  }
  return bounded;
}

function cloneManagerStatusValue<T>(value: T): T {
  if (Array.isArray(value)) return value.map(cloneManagerStatusValue) as T;
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, cloneManagerStatusValue(child)])) as T;
  }
  return value;
}

function boundedManagerStatusPatch(patch: unknown) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) return {};
  const bounded: FeedRecord = {};
  let retained = 0;
  for (const key in patch) {
    if (!Object.prototype.hasOwnProperty.call(patch, key)) continue;
    if (retained >= 32) break;
    const normalizedKey = key.slice(0, 96);
    const value = boundedManagerStatusValue(feedRecord(patch)[key], normalizedKey);
    if (value === undefined) continue;
    bounded[normalizedKey] = value;
    retained += 1;
  }
  return bounded;
}

function managerStatusValueEqual(left: unknown, right: unknown) {
  return Object.is(left, right) || JSON.stringify(left) === JSON.stringify(right);
}

function managerStatusChangedFields(previous: FeedRecord | null, next: FeedRecord) {
  const fields = new Set([...Object.keys(previous ?? {}), ...Object.keys(next ?? {})]);
  return [...fields].filter((key) => !managerStatusValueEqual(previous?.[key], next?.[key]));
}

function compactInvalidatedDepthSession<T extends LiveDepthSession>(session: T | null | undefined, reason: string): T | null | undefined {
  if (!session) return session;
  const compact: T = { ...session, invalidated: true, status: 'resync-required', invalidReason: reason };
  for (const [key, value] of Object.entries(session)) {
    if (value instanceof Map) feedRecord(compact)[key] = new Map();
  }
  if (session.book) {
    const book = { ...session.book };
    delete feedRecord(book).checksumLevels; delete feedRecord(book).levelMetadata;
    compact.book = {
      ...book,
      complete: false,
      gap: true,
      invalidated: true,
      resyncRequired: true,
      status: 'resync-required',
      invalidReason: reason,
      bids: [],
      asks: [],
    };
  }
  return compact;
}

const BYBIT_PRE_ACK_FRAME_LIMIT = 128;
const BYBIT_PRE_ACK_BYTE_LIMIT = 2 * 1024 * 1024;

function explicitProviderTime(value: unknown) {
  if (typeof value !== 'number' && !(typeof value === 'string' && /^\d+$/.test(value.trim()))) return null;
  const timestamp = Number(value);
  return Number.isSafeInteger(timestamp) && timestamp > 0 ? timestamp : null;
}

function hyperliquidBookResolutions({ hlBookResolutions, hlBookNsigFigs = 2, hlBookMantissa = null }: LiveFeedStartOptions = {}) {
  const requested = Array.isArray(hlBookResolutions) && hlBookResolutions.length
    ? hlBookResolutions
    : [{ nSigFigs: null, mantissa: null }, { nSigFigs: hlBookNsigFigs == null ? 2 : hlBookNsigFigs, mantissa: hlBookMantissa }];
  if (requested.length > 2) throw new RangeError('At most one native and one coarse Hyperliquid book are supported');
  const normalized = requested.map((value) => {
    const grouping = validateHyperliquidGrouping(value?.nSigFigs, value?.mantissa);
    const resolutionKey = hyperliquidBookResolutionKey(grouping);
    return { ...grouping, resolution: resolutionKey === 'native' ? 'native' : 'coarse', resolutionKey };
  });
  const unique = [...new Map(normalized.map((value) => [value.resolutionKey, value])).values()];
  if (!unique.some((value) => value.resolutionKey === 'native')) throw new RangeError('Hyperliquid book set must include the native representation');
  if (unique.length > 2) throw new RangeError('At most one coarse Hyperliquid book is supported');
  return unique.sort((a, b) => (a.resolutionKey === 'native' ? -1 : b.resolutionKey === 'native' ? 1 : 0));
}

/**
 * Local feed orchestration. This module owns no credentials and performs no I/O
 * unless networkEnabled=true and a transportFactory/restTransport are supplied.
 * Socket messages are normalized into the Stage 2 contracts before callbacks.
 */
/** The recovery and watchdog timers must not keep a process alive that has nothing else to do. */
function unrefTimer(timer: unknown) { if (timer !== null && typeof timer === 'object' && typeof (timer as { unref?: unknown }).unref === 'function') (timer as { unref: () => void }).unref(); }

export class LiveFeedManager {
  declare networkEnabled: boolean;
  declare transportFactory: LiveFeedOptions['transportFactory']; declare restTransport: LiveFeedRestTransport | null;
  declare onMessage: NonNullable<LiveFeedOptions['onMessage']>; declare onTradeBatch: LiveFeedOptions['onTradeBatch']; declare onStatus: NonNullable<LiveFeedOptions['onStatus']>;
  declare retainedAdmission: LiveFeedOptions['retainedAdmission']; declare reserveTransientMemory: LiveFeedOptions['reserveTransientMemory']; declare activeMessageMemoryReservation: ProcessMemoryReservation | null;
  declare now: () => number; declare schedule: NonNullable<LiveFeedOptions['schedule']>; declare cancel: NonNullable<LiveFeedOptions['cancel']>;
  declare heartbeatSchedule: NonNullable<LiveFeedOptions['heartbeatSchedule']>; declare heartbeatCancel: NonNullable<LiveFeedOptions['heartbeatCancel']>;
  declare reconnectBaseMs: number; declare reconnectMaxMs: number; declare oiPollMs: number; declare oiHistoryPeriod: string; declare oiHistoryLimit: number; declare candleInterval: string; declare candleHistoryLimit: number;
  declare transportPolicies: VenuePolicyOverrides; declare transportNow: () => number; declare transportBudget: VenueTransportBudget; declare transportIdleMs: number;
  declare startWatchdogMs: number; declare startTimeoutMs: number;
  #log: (message: string) => void;
  /** The configuration of the last start() that finished: what a recovery brings back. */
  #goodOptions: LiveFeedStartOptions | null = null;
  #pendingOptions: LiveFeedStartOptions | null = null;
  #startInFlight: { at: number } | null = null;
  #lastStart: { at: number; ms: number; ok: boolean; error?: string } | null = null;
  #recoveryTimer: FeedTimer | null = null; #recoveryAttempt = 0; #recoveries = 0; #lastRecovery: { at: number; reason: string } | null = null;
  #watchdogTimer: FeedTimer | null = null; #deadChecks = 0;
  #operationScope = new LiveFeedOperationScope();
  declare running: boolean; declare specs: Map<string, LiveFeedSpec>; declare feeds: Map<string, LiveFeed>; declare bookSequences: Map<string, unknown>; declare depthBuffers: Map<string, LiveNormalizedMessage[]>; declare depthBridgePending: Map<string, boolean>; declare resyncing: Map<string, BinanceResyncToken>;
  declare retainedDiagnosticsCache: LiveFeedDiagnostics | null; declare oiTimer: FeedTimer | null; declare sessionCounter: number; declare feedGenerations: Map<string, number>; declare heartbeatTimers: Map<string, FeedTimer>; declare configurationGeneration: number;
  declare whitebitMetadata: ReturnType<typeof normalizeWhitebitMarkets> | null; declare phemexMetadata: ReturnType<typeof normalizePhemexProducts> | null; declare dydxMetadata: ReturnType<typeof normalizeDydxMarkets> | null; declare asterMetadata: ReturnType<typeof normalizeAsterMarkets> | null;
  declare rest: ReturnType<typeof createRestRequestCoordinator<unknown>> | null;

  #lastPrices = new Map<string, number>();

  constructor({
    networkEnabled = false,
    transportFactory = null,
    restTransport = null,
    onMessage = () => {},
    onTradeBatch,
    onStatus = () => {},
    retainedAdmission = null,
    reserveTransientMemory = null,
    now = () => Date.now(),
    schedule = (fn, delay) => setTimeout(fn, delay),
    cancel = cancelNativeTimer,
    heartbeatSchedule = (fn, delay) => setTimeout(fn, delay),
    heartbeatCancel = cancelNativeTimer,
    reconnectBaseMs = 1_000,
    reconnectMaxMs = 30_000,
    oiPollMs = 60_000,
    oiHistoryPeriod = '5m',
    oiHistoryLimit = 500,
    candleInterval = NATIVE_CANDLE_INTERVAL,
    candleHistoryLimit = 1_500,
    restRetryPolicies = DEFAULT_REST_POLICIES,
    restRandom = Math.random,
    transportPolicies = {},
    transportBudget = null,
    transportNow = () => Date.now(),
    transportIdleMs = 15 * 60_000,
    startWatchdogMs = 0,
    startTimeoutMs = 180_000,
    log = () => {},
  }: LiveFeedOptions = {}) {
    this.networkEnabled = networkEnabled;
    this.transportFactory = transportFactory;
    this.restTransport = restTransport;
    this.onMessage = onMessage;
    this.onTradeBatch = typeof onTradeBatch === 'function' ? onTradeBatch : undefined;
    this.onStatus = onStatus;
    this.retainedAdmission = typeof retainedAdmission === 'function' ? retainedAdmission : null;
    this.reserveTransientMemory = typeof reserveTransientMemory === 'function' ? reserveTransientMemory : null;
    this.activeMessageMemoryReservation = null;
    this.now = now;
    this.schedule = schedule;
    this.cancel = cancel;
    this.heartbeatSchedule = heartbeatSchedule;
    this.heartbeatCancel = heartbeatCancel;
    this.reconnectBaseMs = reconnectBaseMs;
    this.reconnectMaxMs = reconnectMaxMs;
    this.oiPollMs = oiPollMs;
    this.oiHistoryPeriod = String(oiHistoryPeriod || '5m');
    this.oiHistoryLimit = Math.max(0, Math.min(5_000, Math.trunc(Number(oiHistoryLimit) || 0)));
    this.candleInterval = assertNativeCandleInterval(candleInterval);
    this.candleHistoryLimit = Math.max(1, Math.min(1_500, Math.trunc(Number(candleHistoryLimit) || 1_500)));
    this.transportPolicies = Object.keys(transportPolicies ?? {}).length ? transportPolicies : (transportBudget?.policies ?? {});
    this.transportNow = transportNow;
    this.transportBudget = transportBudget ?? new VenueTransportBudget({ policies: this.transportPolicies, now: transportNow });
    this.transportIdleMs = Math.max(0, Number(transportIdleMs) || 0);
    this.startWatchdogMs = Math.max(0, Number(startWatchdogMs) || 0);
    this.startTimeoutMs = Math.max(1, Number(startTimeoutMs) || 180_000);
    this.#log = log;
    this.running = false;
    this.specs = new Map();
    this.feeds = new Map();
    this.bookSequences = new Map();
    this.depthBuffers = new Map();
    // Overlap rewriting is legal only for the first delta after each REST snapshot.
    this.depthBridgePending = new Map();
    // Binance resyncs are keyed by instrument and carry feed identity so a
    // late request cannot clear or poison a replacement resync.
    this.resyncing = new Map();
    this.retainedDiagnosticsCache = null;
    this.oiTimer = null;
    this.sessionCounter = 0;
    this.feedGenerations = new Map();
    this.heartbeatTimers = new Map();
    this.configurationGeneration = 0;
    this.whitebitMetadata = null;
    this.phemexMetadata = null;
    this.dydxMetadata = null;
    this.asterMetadata = null;
    this.rest = restTransport?.request ? createRestRequestCoordinator({
      transport: (request, context) => restTransport!.request(exchangeRestRequest(request), context),
      policies: restRetryPolicies,
      random: restRandom,
      schedule: this.schedule,
      now: this.now,
    }) : null;
  }

  get lastPrices() {
    return new Map(this.#lastPrices);
  }

  /**
   * Apply a configuration. start() retires every old feed first and opens the new ones only after its metadata
   * requests, so an error thrown in between used to leave a running manager with no feed at all and nothing to
   * reopen one. A failure now schedules a recovery (the last configuration that finished starting, with a candle
   * backfill) and still rejects, so the caller hears about it.
   */
  async start(options: LiveFeedStartOptions = {}) {
    if (this.#recoveryTimer !== null) { this.cancel(this.#recoveryTimer); this.#recoveryTimer = null; }
    const before = this.configurationGeneration, began = this.now(), token = { at: began };
    this.#startInFlight = token;
    this.#pendingOptions = options;
    try {
      const status = await this.#startNow(options);
      // A newer start() while this one ran owns the outcome.
      if (this.configurationGeneration === before + 1) {
        this.#goodOptions = options; this.#recoveryAttempt = 0;
        this.#lastStart = { at: began, ms: this.now() - began, ok: true };
      }
      this.#armWatchdog();
      return status;
    } catch (error) {
      const message = String(feedError(error).message ?? error);
      // Only an error after the configuration changed (the old feeds are retired) needs a recovery, and a missing transport never mends itself.
      if (this.configurationGeneration === before + 1) {
        this.#lastStart = { at: began, ms: this.now() - began, ok: false, error: message.slice(0, 200) };
        this.#log(`feed start failed: ${message}`);
        if (this.networkEnabled && this.transportFactory) { this.#armRecovery(`start failed: ${message}`); this.#armWatchdog(); }
      }
      throw error;
    } finally {
      if (this.#startInFlight === token) this.#startInFlight = null;
    }
  }

  #armRecovery(reason: string) {
    if (!this.running || this.#recoveryTimer !== null) return;
    const attempt = ++this.#recoveryAttempt;
    const delay = reconnectDelay(attempt, { baseMs: this.reconnectBaseMs, maxMs: Math.max(this.reconnectMaxMs, Math.min(300_000, this.reconnectMaxMs * 10)) });
    const generation = this.configurationGeneration;
    this.#log(`feeds will restart in ${Math.round(delay / 1000)} s (${reason})`);
    this.#recoveryTimer = this.schedule(async () => {
      this.#recoveryTimer = null;
      if (!this.running || this.configurationGeneration !== generation) return;
      const options = this.#goodOptions ?? this.#pendingOptions ?? {};
      this.#recoveries += 1; this.#lastRecovery = { at: this.now(), reason };
      try { await this.start({ ...options, referenceBackfill: true }); this.#log('feeds restarted'); }
      catch { /* start() has armed the next attempt */ }
    }, delay);
    unrefTimer(this.#recoveryTimer);
  }

  /**
   * Called on a timer once a start has been requested. A start that has run too long is abandoned for a fresh one,
   * and a manager that has specs but no feed (the state a failed start leaves) is restarted after two checks.
   */
  checkLiveness() {
    if (!this.running || !this.networkEnabled) { this.#deadChecks = 0; return; }
    const inFlight = this.#startInFlight;
    if (inFlight) {
      if (this.now() - inFlight.at > this.startTimeoutMs) {
        this.#log(`feed start has run for more than ${Math.round(this.startTimeoutMs / 1000)} s; starting again`);
        this.#recoverNow('start timed out');
      }
      return;
    }
    if (this.#recoveryTimer !== null) return;
    this.#deadChecks = this.specs.size > 0 && this.feeds.size === 0 ? this.#deadChecks + 1 : 0;
    if (this.#deadChecks >= 2) { this.#deadChecks = 0; this.#armRecovery('no feed is open'); }
  }

  #recoverNow(reason: string) {
    const options = this.#goodOptions ?? this.#pendingOptions ?? {};
    this.#recoveries += 1; this.#lastRecovery = { at: this.now(), reason };
    this.start({ ...options, referenceBackfill: true }).catch(() => { /* start() has armed the next attempt */ });
  }

  #armWatchdog() {
    if (!(this.startWatchdogMs > 0) || this.#watchdogTimer !== null || !this.running) return;
    const tick = () => {
      this.#watchdogTimer = null;
      if (!this.running) return;
      try { this.checkLiveness(); } finally { this.#watchdogTimer = this.schedule(tick, this.startWatchdogMs); unrefTimer(this.#watchdogTimer); }
    };
    this.#watchdogTimer = this.schedule(tick, this.startWatchdogMs);
    unrefTimer(this.#watchdogTimer);
  }

  /** What the last starts did, for the diagnostics route. */
  startDiagnostics() {
    return {
      running: this.running, feeds: this.feeds.size, specs: this.specs.size,
      startingForMs: this.#startInFlight ? this.now() - this.#startInFlight.at : null,
      lastStart: this.#lastStart, recoveryPending: this.#recoveryTimer !== null, recoveries: this.#recoveries, lastRecovery: this.#lastRecovery,
    };
  }

  async #startNow({ coin = 'BTC', hlNativeCoin, binanceFamily = 'usdm', binanceSymbol = binanceFamily === 'coinm' ? 'BTCUSD_PERP' : 'BTCUSDT', binanceMarketType = 'perpetual', bybitCategory = 'linear', okxMarketType = 'perpetual', bitgetMarketType = 'perpetual', bybitEnabled = false, bybitSymbol = null, okxEnabled = false, okxSymbol = null, bitgetEnabled = false, bitgetSymbol = null, gateioEnabled = false, gateioSymbol = null, deribitEnabled = false, deribitSymbol = null, coinbaseEnabled = false, coinbaseSymbol = null, krakenEnabled = false, krakenSymbol = null, kucoinEnabled = false, kucoinSymbol = null, mexcEnabled = false, mexcSymbol = null, htxEnabled = false, htxSymbol = null, bitfinexEnabled = false, bitfinexSymbol = null, bitmexEnabled = false, bitmexSymbol = null, cryptocomEnabled = false, cryptocomSymbol = null, bitstampEnabled = false, bitstampSymbol = null, whitebitEnabled = false, whitebitSymbol = null, phemexEnabled = false, phemexSymbol = null, dydxEnabled = false, dydxSymbol = null, asterEnabled = false, asterSymbol = null, selectedOrderbookVenues, referenceBackfill = true, candleInterval = this.candleInterval, hlBookNsigFigs = 2, hlBookMantissa = null, hlBookResolutions = null }: LiveFeedStartOptions = {}) {
    if (typeof referenceBackfill !== 'boolean') throw new TypeError('referenceBackfill must be boolean');
    const selectedDepthVenues = selectedOrderbooks(selectedOrderbookVenues);
    this.candleInterval = assertNativeCandleInterval(candleInterval);
    if (!['usdm', 'coinm'].includes(binanceFamily) || !['perpetual', 'spot'].includes(binanceMarketType) || (binanceFamily === 'coinm' && binanceMarketType === 'spot')) throw new RangeError('Unsupported Binance public market family');
    if (!['linear', 'spot', 'inverse'].includes(bybitCategory)) throw new RangeError('Unsupported Bybit public market category');
    if (!['perpetual', 'spot'].includes(okxMarketType) || !['perpetual', 'spot'].includes(bitgetMarketType)) throw new RangeError('Unsupported public market family');
    const okxInstType = okxMarketType === 'spot' ? 'SPOT' : 'SWAP';
    const bitgetInstType = bitgetMarketType === 'spot' ? 'spot' : 'usdt-futures';
    const binanceTradesSupported = binanceFamily === 'coinm' || isBinanceUsdtTradeSymbol(binanceSymbol);
    const selectedNativeCoin = hyperliquidNativeCoin(coin, hlNativeCoin);
    let nativeCoinMetadataAccepted = hlNativeCoin == null;
    const bookResolutions = hyperliquidBookResolutions({ hlBookResolutions, hlBookNsigFigs, hlBookMantissa });
    this.configurationGeneration += 1;
    const configurationGeneration = this.configurationGeneration;
    this.#operationScope.cancel();
    this.#operationScope = new LiveFeedOperationScope();
    if (this.oiTimer !== null) { this.cancel(this.oiTimer); this.oiTimer = null; }
    this.running = true;
    this.whitebitMetadata = null;
    this.phemexMetadata = null;
    this.dydxMetadata = null;
    this.asterMetadata = null;
    this.#clearResyncing();
    // A repeated start is a selection change. Retire every old feed so its
    // queued candle/book frames cannot cross the new market boundary.
    for (const [id, feed] of this.feeds) {
      this.#retireFeed(id);
    }
    this.#clearRetiredState();
    let cryptocomMetadataChecked = false;
    let cryptocomAllowed = true;
    let cryptocomUnavailableReason = null;
    let dydxMetadataChecked = false;
    let dydxAllowed = true;
    let dydxUnavailableReason = null;
    let asterMetadataChecked = false;
    let asterAllowed = true;
    let asterDepthAllowed = true;
    let asterUnavailableReason = null;
    if (cryptocomEnabled && cryptocomSymbol && this.networkEnabled) {
      cryptocomMetadataChecked = true;
      if (!this.restTransport?.request) {
        cryptocomAllowed = false;
        cryptocomUnavailableReason = 'Crypto.com perpetual instrument validation requires REST metadata';
      } else {
        const metadata = await this.syncCryptocomMetadata({ symbol: cryptocomSymbol });
        if (configurationGeneration !== this.configurationGeneration) return this.status();
        const selected = metadata?.assets?.find(asset => String(asset.nativeSymbol).toUpperCase() === String(cryptocomSymbol).toUpperCase());
        if (!selected || String(selected.instrumentType ?? '').toUpperCase() !== 'PERPETUAL_SWAP' || selected.marketType !== 'perpetual') {
          cryptocomAllowed = false;
          cryptocomUnavailableReason = 'Crypto.com bounded packet requires instrument type PERPETUAL_SWAP';
        }
      }
    }
    if (dydxEnabled && dydxSymbol && this.networkEnabled) {
      dydxMetadataChecked = true;
      if (!this.restTransport?.request) {
        dydxAllowed = false;
        dydxUnavailableReason = 'dYdX perpetual instrument validation requires REST metadata';
      } else {
        const metadata = await this.syncDydxMetadata({ symbol: dydxSymbol });
        if (configurationGeneration !== this.configurationGeneration) return this.status();
        const selected = metadata?.assets?.find(asset => String(asset.nativeSymbol).toUpperCase() === String(dydxSymbol).replaceAll('_', '-').toUpperCase());
        if (!selected || selected.marketType !== 'perpetual' || selected.status !== 'online' || selected.isDelisted) {
          dydxAllowed = false;
          dydxUnavailableReason = 'dYdX selected symbol has no verified active public perpetual metadata';
        }
      }
    }
    if (asterEnabled && asterSymbol && this.networkEnabled) {
      asterMetadataChecked = true;
      if (!this.restTransport?.request) {
        asterAllowed = false;
        asterUnavailableReason = 'Aster perpetual instrument validation requires REST metadata';
      } else {
        const metadata = await this.syncAsterMetadata({ symbol: asterSymbol });
        if (configurationGeneration !== this.configurationGeneration) return this.status();
        const selected = metadata?.assets?.find(asset => String(asset.nativeSymbol).toUpperCase() === String(asterSymbol).toUpperCase());
        if (!selected || selected.marketType !== 'perpetual' || selected.status !== 'online' || selected.isDelisted) {
          asterAllowed = false;
          asterUnavailableReason = 'Aster selected symbol has no verified active public perpetual metadata';
        } else if (!isAsterLinearDepthMetadata(selected, String(asterSymbol).toUpperCase())) asterDepthAllowed = false;
      }
    }
    const specs: [string, LiveFeedSpec][] = [
      ...bookResolutions.map((grouping): [string, LiveFeedSpec] => {
        const id = grouping.resolutionKey === 'native' ? 'hl-l2Book-native' : 'hl-l2Book';
        const instrumentId = `hyperliquid:${hyperliquidCoin(coin)}-PERP`;
        return [id, { venue: 'hyperliquid', channel: 'l2Book', instrumentId, resolution: grouping.resolution, resolutionKey: grouping.resolutionKey, bookKey: bookKey(instrumentId, grouping.resolutionKey), nSigFigs: grouping.nSigFigs, mantissa: grouping.mantissa, request: buildHyperliquidSubscription('l2Book', { coin, nativeCoin: hlNativeCoin, nSigFigs: grouping.nSigFigs, mantissa: grouping.mantissa }), decode: (raw: unknown) => this.#decodeHyperliquidBook(raw, coin, grouping) }];
      }),
      ['hl-activeAssetCtx', { venue: 'hyperliquid', channel: 'activeAssetCtx', request: buildHyperliquidSubscription('activeAssetCtx', { coin, nativeCoin: hlNativeCoin }), decode: raw => this.#decodeHyperliquidContext(raw, coin) }],
      ['hl-candle', { venue: 'hyperliquid', channel: 'candle', instrumentId: `hyperliquid:${hyperliquidCoin(coin)}-PERP`, request: buildHyperliquidSubscription('candle', { coin, nativeCoin: hlNativeCoin, interval: this.candleInterval }), decode: raw => this.#decodeHyperliquidCandle(raw, coin, this.candleInterval) }],
      ['hl-trades', { venue: 'hyperliquid', channel: 'trades', request: buildHyperliquidSubscription('trades', { coin, nativeCoin: hlNativeCoin }), decode: raw => this.#decodeHyperliquidTrades(raw, coin) }],
      ['binance-depth', { venue: 'binance', channel: 'depth', symbol: binanceSymbol, family: binanceFamily, marketType: binanceMarketType, instrumentId: binanceInstrumentId(binanceSymbol, binanceMarketType, binanceFamily), bookKey: bookKey(binanceInstrumentId(binanceSymbol, binanceMarketType, binanceFamily), 'native'), resolutionKey: 'native', request: buildBinanceSubscription('depth', { symbol: binanceSymbol, marketType: binanceMarketType, family: binanceFamily }), serverHeartbeat: true, decode: raw => this.#decodeBinanceDepth(raw, { symbol: binanceSymbol, marketType: binanceMarketType, family: binanceFamily, metadata: this.specs.get('binance-depth')?.metadata }) }],
      ['binance-markPrice', { venue: 'binance', channel: 'markPrice', symbol: binanceSymbol, family: binanceFamily, marketType: binanceMarketType, instrumentId: binanceInstrumentId(binanceSymbol, binanceMarketType, binanceFamily), request: buildBinanceSubscription('markPrice', { symbol: binanceSymbol, marketType: binanceMarketType, family: binanceFamily }), serverHeartbeat: true, decode: raw => this.#decodeBinanceMark(raw, binanceSymbol, binanceMarketType, binanceFamily) }],
      ['binance-kline', { venue: 'binance', channel: 'kline', symbol: binanceSymbol, family: binanceFamily, marketType: binanceMarketType, instrumentId: binanceInstrumentId(binanceSymbol, binanceMarketType, binanceFamily), interval: this.candleInterval, request: buildBinanceSubscription('kline', { symbol: binanceSymbol, marketType: binanceMarketType, family: binanceFamily, interval: this.candleInterval }), serverHeartbeat: true, decode: raw => this.#decodeBinanceKline(raw, { symbol: binanceSymbol, marketType: binanceMarketType, family: binanceFamily, metadata: this.specs.get('binance-kline')?.metadata, interval: this.candleInterval }) }],
    ];
    if (binanceTradesSupported) specs.push(['binance-trades', { venue: 'binance', channel: 'aggTrade', symbol: binanceSymbol, family: binanceFamily, marketType: binanceMarketType, instrumentId: binanceInstrumentId(binanceSymbol, binanceMarketType, binanceFamily), request: buildBinanceSubscription('aggTrade', { symbol: binanceSymbol, marketType: binanceMarketType, family: binanceFamily }), serverHeartbeat: true, decode: raw => this.#decodeBinanceTrades(raw, { symbol: binanceSymbol, marketType: binanceMarketType, family: binanceFamily, metadata: this.specs.get('binance-trades')?.metadata }) }]);
    if (bybitEnabled && bybitSymbol) specs.push(['bybit-depth', { venue: 'bybit', channel: 'depth', symbol: bybitSymbol, category: bybitCategory, marketType: bybitCategory === 'spot' ? 'spot' : 'perpetual', topic: buildBybitSubscription('depth', { symbol: bybitSymbol, category: bybitCategory }).topic, instrumentId: bybitInstrumentId(bybitSymbol, bybitCategory), request: buildBybitSubscription('depth', { symbol: bybitSymbol, category: bybitCategory }), decode: raw => this.#decodeBybitDepth(raw, { symbol: bybitSymbol, category: bybitCategory, metadata: this.specs.get('bybit-depth')?.metadata }), publicDepth: true }]);
    if (okxEnabled && okxSymbol) {
      const request = buildOkxSubscription('depth', { instId: okxSymbol, instType: okxInstType, marketType: okxMarketType });
      specs.push(['okx-depth', { venue: 'okx', channel: 'depth', symbol: okxSymbol, instType: okxInstType, marketType: okxMarketType, topic: request.topic, instrumentId: 'okx:' + String(okxSymbol).toUpperCase(), request, decode: raw => this.#decodeOkxDepth(raw, { instId: okxSymbol, instType: okxInstType, marketType: okxMarketType, metadata: this.specs.get('okx-depth')?.metadata }), publicDepth: true }]);
    }
    if (bitgetEnabled && bitgetSymbol) {
      const request = buildBitgetSubscription('depth', { symbol: bitgetSymbol, instType: bitgetInstType, category: bitgetInstType, marketType: bitgetMarketType });
      specs.push(['bitget-depth', { venue: 'bitget', channel: 'depth', symbol: bitgetSymbol, instType: bitgetInstType, category: bitgetInstType, marketType: bitgetMarketType, topic: request.topic, instrumentId: bitgetInstrumentId(bitgetSymbol, bitgetInstType), request, decode: raw => this.#decodeBitgetDepth(raw, { symbol: bitgetSymbol, instType: bitgetInstType, category: bitgetInstType, marketType: bitgetMarketType, metadata: this.specs.get('bitget-depth')?.metadata }), publicDepth: true }]);
    }
    if (gateioEnabled && gateioSymbol) {
      const request = buildGateSubscription('depth', { contract: gateioSymbol, limit: 100, interval: '0' });
      specs.push(['gateio-depth', { venue: 'gateio', channel: 'futures.order_book', symbol: gateioSymbol, marketType: 'perpetual', topic: request.topic, instrumentId: `gateio:${String(gateioSymbol).replaceAll('-', '_').toUpperCase()}`, request, decode: raw => this.#decodeGateDepth(raw, gateioSymbol, this.specs.get('gateio-depth')?.request ?? request), publicDepth: true }]);
    }
    if (deribitEnabled && deribitSymbol) {
      const request = buildDeribitSubscription('depth', { instrumentName: deribitSymbol });
      const resolutionKey = Number(request.sourceGrouping) > 0 ? `group:${request.sourceGrouping}` : 'native';
      specs.push(['deribit-depth', { venue: 'deribit', channel: 'book', symbol: deribitSymbol, marketType: 'perpetual', topic: request.topic, instrumentId: `deribit:${String(deribitSymbol).toUpperCase()}`, resolution: Number(request.sourceGrouping) > 0 ? 'coarse' : 'native', resolutionKey, sourceGrouping: request.sourceGrouping, sourceDepth: request.sourceDepth, sourceInterval: request.sourceInterval, request, decode: raw => this.#decodeDeribitDepth(raw, deribitSymbol, request), publicDepth: true }]);
    }
    if (coinbaseEnabled && coinbaseSymbol) {
      const request = buildCoinbaseSubscription('depth', { productId: coinbaseSymbol, channel: 'level2_batch' });
      specs.push(['coinbase-depth', { venue: 'coinbase', channel: request.channel, symbol: request.productId, marketType: 'spot', topic: request.topic, instrumentId: `coinbase:${String(request.productId).toUpperCase()}`, request, decode: raw => this.#decodeCoinbaseDepth(raw, coinbaseSymbol), publicDepth: true }]);
    }
    if (krakenEnabled && krakenSymbol) {
      const request = buildKrakenSubscription('depth', { symbol: krakenSymbol, depth: 100, snapshot: true });
      specs.push(['kraken-depth', { venue: 'kraken', channel: request.channel, symbol: request.symbol, marketType: 'spot', topic: request.topic, instrumentId: `kraken:${String(request.symbol).toUpperCase()}`, request, decode: raw => this.#decodeKrakenDepth(raw, String(request.symbol)), publicDepth: true }]);
    }
    if (kucoinEnabled && kucoinSymbol) {
      const request = buildKucoinSubscription('depth', { symbol: kucoinSymbol, depth: 50, id: '1' });
      specs.push(['kucoin-depth', { venue: 'kucoin', channel: request.channel, symbol: request.symbol, marketType: 'spot', topic: request.topic, instrumentId: `kucoin:${String(request.symbol).toUpperCase()}`, request, decode: raw => this.#decodeKucoinDepth(raw, kucoinSymbol), publicDepth: true }]);
    }
    if (mexcEnabled && mexcSymbol) {
      const request = buildMexcSubscription('depth', { symbol: mexcSymbol, limit: 20 });
      specs.push(['mexc-depth', { venue: 'mexc', channel: request.channel, symbol: request.symbol, marketType: 'perpetual', topic: request.topic, instrumentId: `mexc:${String(request.symbol).toUpperCase()}`, request, decode: raw => this.#decodeMexcDepth(raw, mexcSymbol, this.specs.get('mexc-depth')?.request ?? request), publicDepth: true }]);
    }
    if (htxEnabled && htxSymbol) {
      const request = buildHtxSubscription('depth', { symbol: htxSymbol, type: 'step6', id: '1' });
      specs.push(['htx-depth', { venue: 'htx', channel: request.channel, symbol: request.symbol, marketType: 'perpetual', topic: request.topic, instrumentId: `htx:${String(request.symbol).toUpperCase()}`, request, decode: raw => this.#decodeHtxDepth(raw, htxSymbol, this.specs.get('htx-depth')?.request ?? request), publicDepth: true }]);
    }
    if (bitfinexEnabled && bitfinexSymbol) {
      const request = buildBitfinexSubscription('depth', { symbol: bitfinexSymbol, precision: 'P0', frequency: 'F0', len: 25 });
      specs.push(['bitfinex-depth', { venue: 'bitfinex', channel: request.channel, symbol: request.symbol, marketType: 'spot', topic: request.topic, instrumentId: `bitfinex:${String(request.symbol).replace(/^t/i, '').toUpperCase()}`, request, decode: raw => this.#decodeBitfinexDepth(raw, bitfinexSymbol), publicDepth: true }]);
    }
    if (bitmexEnabled && bitmexSymbol) {
      const request = buildBitmexSubscription('depth', { symbol: bitmexSymbol, table: 'orderBookL2_25' });
      specs.push(['bitmex-depth', { venue: 'bitmex', channel: request.channel, symbol: request.symbol, marketType: 'perpetual', topic: request.topic, instrumentId: `bitmex:${String(request.symbol).toUpperCase()}`, request, decode: raw => this.#decodeBitmexDepth(raw, bitmexSymbol, request), publicDepth: true }]);
    }
    if (cryptocomEnabled && cryptocomSymbol && cryptocomAllowed) {
      const request = buildCryptocomSubscription('depth', { instrumentName: cryptocomSymbol, depth: 10, updateFrequency: 100 });
      specs.push(['cryptocom-depth', { venue: 'cryptocom', channel: request.channel, symbol: request.symbol, marketType: 'perpetual', topic: request.topic, instrumentId: `cryptocom:${String(request.symbol).toUpperCase()}`, request, decode: raw => this.#decodeCryptocomDepth(raw, cryptocomSymbol, request), publicDepth: true }]);
    }
    if (bitstampEnabled && bitstampSymbol) {
      const request = buildBitstampSubscription('depth', { symbol: bitstampSymbol, depth: 100 });
      specs.push(['bitstamp-depth', { venue: 'bitstamp', channel: request.channel, symbol: request.symbol, marketType: 'spot', topic: request.topic, instrumentId: `bitstamp:${String(request.symbol).toUpperCase()}`, request, decode: raw => this.#decodeBitstampDepth(raw, bitstampSymbol), publicDepth: true }]);
    }
    if (whitebitEnabled && whitebitSymbol) {
      const request = buildWhitebitSubscription('depth', { symbol: whitebitSymbol, depth: 100, interval: '0' });
      specs.push(['whitebit-depth', { venue: 'whitebit', channel: request.channel, symbol: request.symbol, marketType: 'spot', topic: request.topic, instrumentId: `whitebit:${String(request.symbol).toUpperCase()}`, request, decode: raw => this.#decodeWhitebitDepth(raw, whitebitSymbol), publicDepth: true }]);
    }
    if (phemexEnabled && phemexSymbol) {
      const request = buildPhemexSubscription('depth', { symbol: phemexSymbol, fullDepth: true });
      // Preserve Phemex's canonical lowercase `s` spot prefix in the
      // instrument id.  The normalizer emits `phemex:sBTCUSDT`; uppercasing
      // the whole native symbol here would create a different session key and
      // silently discard otherwise valid snapshots.
      specs.push(['phemex-depth', { venue: 'phemex', channel: request.channel, symbol: request.symbol, marketType: 'spot', topic: request.topic, instrumentId: `phemex:${request.symbol}`, request, decode: raw => this.#decodePhemexDepth(raw, phemexSymbol, this.specs.get('phemex-depth')?.request ?? request), publicDepth: true }]);
    }
    if (dydxEnabled && dydxSymbol && dydxAllowed) {
      const request = buildDydxSubscription('trades', { symbol: dydxSymbol });
      specs.push(['dydx-trades', { venue: 'dydx', channel: request.channel, symbol: request.symbol, marketType: 'perpetual', topic: request.topic, instrumentId: `dydx:${request.symbol}`, request, serverHeartbeat: true, decode: raw => this.#decodeDydxTrades(raw, dydxSymbol) }]);
      const depthRequest = buildDydxSubscription('depth', { symbol: dydxSymbol });
      specs.push(['dydx-depth', { venue: 'dydx', channel: depthRequest.channel, symbol: depthRequest.symbol, marketType: 'perpetual', topic: depthRequest.topic, instrumentId: `dydx:${depthRequest.symbol}`, request: depthRequest, serverHeartbeat: true, publicDepth: true, decode: raw => this.#decodeDydxDepth(raw, dydxSymbol) }]);
    }
    if (asterEnabled && asterSymbol && asterAllowed) {
      const request = buildAsterSubscription('aggTrade', { symbol: asterSymbol, id: 1 });
      specs.push(['aster-trades', { venue: 'aster', channel: 'aggTrade', symbol: request.symbol, marketType: 'perpetual', topic: request.stream, instrumentId: `aster:${request.symbol}`, request, serverHeartbeat: true, decode: raw => this.#decodeAsterTrades(raw, asterSymbol) }]);
      if (asterDepthAllowed) {
        const depthRequest = buildAsterSubscription('depth', { symbol: asterSymbol, id: 2 });
        specs.push(['aster-depth', { venue: 'aster', channel: 'depth', symbol: depthRequest.symbol, marketType: 'perpetual', topic: depthRequest.stream, instrumentId: `aster:${depthRequest.symbol}`, sourceDepth: depthRequest.depth, request: depthRequest, serverHeartbeat: true, publicDepth: true, decode: raw => this.#decodeAsterDepth(raw, asterSymbol) }]);
      }
    }
    this.specs = new Map(specs.filter(([, spec]) => selectedDepthVenues === null || !isPublicOrderbookSpec(spec) || selectedDepthVenues.has(spec.venue)).map(([id, spec]) => [id, { ...spec, configurationGeneration }]));
    if (!binanceTradesSupported) this.#setStatus('binance-trades', { state: 'unavailable', active: false, attempt: 0, nextRetryAt: null, lastSuccess: null, sourceTimestamp: null, lastError: 'Binance aggregate trade USD equivalent requires a USDT-quoted symbol' });
    this.#publishActiveBookSets();
    for (const [id, spec] of this.specs) {
      if (spec.resolutionKey) this.#setStatus(id, { resolutionKey: spec.resolutionKey, bookKey: spec.bookKey, instrumentId: spec.instrumentId, active: true });
    }
    const activeBookSpecs = [...this.specs.values()].filter((spec) => spec.channel === 'l2Book');
    if (activeBookSpecs.length) this.#setStatus('hl-book-set', { state: 'live', instrumentId: activeBookSpecs[0].instrumentId, activeBookKeys: activeBookSpecs.map((spec) => spec.bookKey), resolutionKeys: activeBookSpecs.map((spec) => spec.resolutionKey), active: true });
    if (bybitEnabled && !bybitSymbol) this.#setStatus('bybit-depth', { state: 'unavailable', attempt: 0, nextRetryAt: null, lastError: 'bybitEnabled requires bybitSymbol' });
    if (okxEnabled && !okxSymbol) this.#setStatus('okx-depth', { state: 'unavailable', attempt: 0, nextRetryAt: null, lastError: 'okxEnabled requires okxSymbol' });
    if (bitgetEnabled && !bitgetSymbol) this.#setStatus('bitget-depth', { state: 'unavailable', attempt: 0, nextRetryAt: null, lastError: 'bitgetEnabled requires bitgetSymbol' });
    if (gateioEnabled && !gateioSymbol) this.#setStatus('gateio-depth', { state: 'unavailable', attempt: 0, nextRetryAt: null, lastError: 'gateioEnabled requires gateioSymbol' });
    if (deribitEnabled && !deribitSymbol) this.#setStatus('deribit-depth', { state: 'unavailable', attempt: 0, nextRetryAt: null, lastError: 'deribitEnabled requires deribitSymbol' });
    if (coinbaseEnabled && !coinbaseSymbol) this.#setStatus('coinbase-depth', { state: 'unavailable', attempt: 0, nextRetryAt: null, lastError: 'coinbaseEnabled requires coinbaseSymbol' });
    if (krakenEnabled && !krakenSymbol) this.#setStatus('kraken-depth', { state: 'unavailable', attempt: 0, nextRetryAt: null, lastError: 'krakenEnabled requires krakenSymbol' });
    if (kucoinEnabled && !kucoinSymbol) this.#setStatus('kucoin-depth', { state: 'unavailable', attempt: 0, nextRetryAt: null, lastError: 'kucoinEnabled requires kucoinSymbol' });
    if (mexcEnabled && !mexcSymbol) this.#setStatus('mexc-depth', { state: 'unavailable', attempt: 0, nextRetryAt: null, lastError: 'mexcEnabled requires mexcSymbol' });
    if (htxEnabled && !htxSymbol) this.#setStatus('htx-depth', { state: 'unavailable', attempt: 0, nextRetryAt: null, lastError: 'htxEnabled requires htxSymbol' });
    if (bitfinexEnabled && !bitfinexSymbol) this.#setStatus('bitfinex-depth', { state: 'unavailable', attempt: 0, nextRetryAt: null, lastError: 'bitfinexEnabled requires bitfinexSymbol' });
    if (bitmexEnabled && !bitmexSymbol) this.#setStatus('bitmex-depth', { state: 'unavailable', attempt: 0, nextRetryAt: null, lastError: 'bitmexEnabled requires bitmexSymbol' });
    if (cryptocomEnabled && !cryptocomSymbol) this.#setStatus('cryptocom-depth', { state: 'unavailable', attempt: 0, nextRetryAt: null, lastError: 'cryptocomEnabled requires cryptocomSymbol' });
    if (cryptocomEnabled && cryptocomSymbol && !cryptocomAllowed) this.#setStatus('cryptocom-depth', { state: 'unavailable', attempt: 0, nextRetryAt: null, lastError: cryptocomUnavailableReason ?? 'Crypto.com perpetual instrument validation failed' });
    if (bitstampEnabled && !bitstampSymbol) this.#setStatus('bitstamp-depth', { state: 'unavailable', attempt: 0, nextRetryAt: null, lastError: 'bitstampEnabled requires bitstampSymbol' });
    if (whitebitEnabled && !whitebitSymbol) this.#setStatus('whitebit-depth', { state: 'unavailable', attempt: 0, nextRetryAt: null, lastError: 'whitebitEnabled requires whitebitSymbol' });
    if (phemexEnabled && !phemexSymbol) this.#setStatus('phemex-depth', { state: 'unavailable', attempt: 0, nextRetryAt: null, lastError: 'phemexEnabled requires phemexSymbol' });
    if (dydxEnabled && !dydxSymbol) for (const id of ['dydx-trades', 'dydx-depth']) this.#setStatus(id, { state: 'unavailable', attempt: 0, nextRetryAt: null, lastError: 'dydxEnabled requires dydxSymbol' });
    if (dydxEnabled && dydxSymbol && !dydxAllowed) this.#setStatus('dydx-trades', { state: 'unavailable', attempt: 0, nextRetryAt: null, lastError: dydxUnavailableReason ?? 'dYdX perpetual instrument validation failed' });
    if (asterEnabled && !asterSymbol) for (const id of ['aster-trades', 'aster-depth']) this.#setStatus(id, { state: 'unavailable', attempt: 0, nextRetryAt: null, lastError: 'asterEnabled requires asterSymbol' });
    if (asterEnabled && asterSymbol && !asterAllowed) this.#setStatus('aster-trades', { state: 'unavailable', attempt: 0, nextRetryAt: null, lastError: asterUnavailableReason ?? 'Aster perpetual instrument validation failed' });
    if (this.restTransport?.request) {
      await Promise.all([
        this.syncHyperliquidMetadata({ coin }).then(metadata => {
          if (hlNativeCoin == null || configurationGeneration !== this.configurationGeneration) return;
          const matches = metadata?.assets?.filter(asset => asset.coin === selectedNativeCoin && asset.instrumentId === `hyperliquid:${hyperliquidCoin(coin)}-PERP` && asset.isDelisted === false) ?? [];
          nativeCoinMetadataAccepted = matches.length === 1 && Number.isInteger(matches[0].szDecimals) && Number(matches[0].szDecimals) >= 0 && Number(matches[0].szDecimals) <= 18;
        }),
        this.syncBinanceMetadata({ symbol: binanceSymbol, marketType: binanceMarketType, family: binanceFamily }),
        bybitEnabled && bybitSymbol ? this.syncBybitMetadata({ symbol: bybitSymbol, category: bybitCategory }) : Promise.resolve(null),
        okxEnabled && okxSymbol ? this.syncOkxMetadata({ symbol: okxSymbol, instType: okxInstType, marketType: okxMarketType }) : Promise.resolve(null),
        bitgetEnabled && bitgetSymbol ? this.syncBitgetMetadata({ symbol: bitgetSymbol, instType: bitgetInstType, category: bitgetInstType, marketType: bitgetMarketType }) : Promise.resolve(null),
        gateioEnabled && gateioSymbol ? this.syncGateIoMetadata({ symbol: gateioSymbol }) : Promise.resolve(null),
        deribitEnabled && deribitSymbol ? this.syncDeribitMetadata({ symbol: deribitSymbol }) : Promise.resolve(null),
        coinbaseEnabled && coinbaseSymbol ? this.syncCoinbaseMetadata({ symbol: coinbaseSymbol }) : Promise.resolve(null),
        krakenEnabled && krakenSymbol ? this.syncKrakenMetadata({ symbol: krakenSymbol }) : Promise.resolve(null),
        kucoinEnabled && kucoinSymbol ? this.syncKucoinMetadata({ symbol: kucoinSymbol }) : Promise.resolve(null),
        kucoinEnabled && kucoinSymbol ? this.syncKucoinPublicToken() : Promise.resolve(null),
        mexcEnabled && mexcSymbol ? this.syncMexcMetadata({ symbol: mexcSymbol }) : Promise.resolve(null),
        htxEnabled && htxSymbol ? this.syncHtxMetadata({ symbol: htxSymbol }) : Promise.resolve(null),
        bitfinexEnabled && bitfinexSymbol ? this.syncBitfinexMetadata({ symbol: bitfinexSymbol }) : Promise.resolve(null),
        bitmexEnabled && bitmexSymbol ? this.syncBitmexMetadata({ symbol: bitmexSymbol }) : Promise.resolve(null),
        cryptocomEnabled && cryptocomSymbol && !cryptocomMetadataChecked ? this.syncCryptocomMetadata({ symbol: cryptocomSymbol }) : Promise.resolve(null),
        bitstampEnabled && bitstampSymbol ? this.syncBitstampMetadata({ symbol: bitstampSymbol }) : Promise.resolve(null),
        whitebitEnabled && whitebitSymbol ? this.syncWhitebitMetadata({ symbol: whitebitSymbol }) : Promise.resolve(null),
        phemexEnabled && phemexSymbol ? this.syncPhemexMetadata({ symbol: phemexSymbol }) : Promise.resolve(null),
        dydxEnabled && dydxSymbol && !dydxMetadataChecked ? this.syncDydxMetadata({ symbol: dydxSymbol }) : Promise.resolve(null),
        asterEnabled && asterSymbol && !asterMetadataChecked ? this.syncAsterMetadata({ symbol: asterSymbol }) : Promise.resolve(null),
      ]);
    }
    // A newer selection can finish while an older metadata request is in flight.
    if (configurationGeneration !== this.configurationGeneration || !this.running) return this.status();
    if (!nativeCoinMetadataAccepted) {
      const reason = 'Hyperliquid native coin has no accepted active exact public metadata';
      for (const [id, spec] of this.specs) if (spec.venue === 'hyperliquid') {
        this.specs.delete(id);
        this.#setStatus(id, { state: 'unavailable', active: false, attempt: 0, nextRetryAt: null, lastSuccess: null, sourceTimestamp: null, lastError: reason });
      }
      this.#setStatus('hl-candle-history', { state: 'unavailable', attempt: 0, nextRetryAt: null, lastError: reason });
    }
    const requiredFamilies: { venue: string; required: boolean; label: string }[] = [
      { venue: 'binance', required: binanceFamily === 'coinm', label: 'Binance COIN-M inverse' },
      { venue: 'bybit', required: bybitEnabled && bybitCategory !== 'linear', label: 'Bybit ' + bybitCategory },
      { venue: 'okx', required: okxEnabled && okxMarketType === 'spot', label: 'OKX spot' },
      { venue: 'bitget', required: bitgetEnabled && bitgetMarketType === 'spot', label: 'Bitget spot' },
    ];
    for (const family of requiredFamilies) {
      if (!family.required) continue;
      const selectedSpecs = [...this.specs].filter(([, spec]) => spec.venue === family.venue);
      if (selectedSpecs.length && selectedSpecs.every(([, spec]) => spec.metadata)) continue;
      const reason = family.label + ' selected symbol has no accepted active verified public family metadata';
      for (const [id] of selectedSpecs) {
        this.specs.delete(id);
        this.#setStatus(id, { state: 'unavailable', active: false, attempt: 0, nextRetryAt: null, lastSuccess: null, sourceTimestamp: null, lastError: reason });
      }
      if (family.venue === 'binance') {
        this.#setStatus('binance-kline-history', { state: 'unavailable', attempt: 0, nextRetryAt: null, lastError: reason });
        this.#setStatus('binance-openInterest', { state: 'unavailable', attempt: 0, nextRetryAt: null, lastError: reason });
        this.#setStatus('binance-openInterest-history', { state: 'unavailable', attempt: 0, nextRetryAt: null, lastError: reason });
      }
    }
    this.#publishActiveBookSets();
    for (const [venue, enabled, marketType] of [
      ['bybit', bybitEnabled, bybitCategory === 'spot' ? 'spot' : 'perpetual'],
      ['okx', okxEnabled, okxMarketType], ['bitget', bitgetEnabled, bitgetMarketType],
    ] as const) {
      if (enabled) this.#setStatus(venue + '-openInterest', { state: 'unavailable', attempt: 0, nextRetryAt: null, lastError: marketType === 'spot' ? 'spot market has no open interest endpoint' : 'public open interest feed is not wired for this venue' });
    }
    if (whitebitEnabled && whitebitSymbol) {
      const selectedWhitebit = (this.whitebitMetadata as ReturnType<typeof normalizeWhitebitMarkets> | null)?.assets?.find((asset) => String(asset.nativeSymbol).toUpperCase() === String(whitebitSymbol).toUpperCase());
      if (!selectedWhitebit || selectedWhitebit.marketType !== 'spot') {
        this.specs.delete('whitebit-depth');
        this.#publishActiveBookSets();
        this.#setStatus('whitebit-depth', { state: 'unavailable', attempt: 0, nextRetryAt: null, lastError: !selectedWhitebit ? 'WhiteBIT selected symbol has no verified public spot metadata' : 'WhiteBIT bounded packet supports spot markets only' });
      }
    }
    if (phemexEnabled && phemexSymbol) {
      const selectedPhemex = (this.phemexMetadata as ReturnType<typeof normalizePhemexProducts> | null)?.assets?.find((asset) => String(asset.nativeSymbol).toUpperCase() === String(phemexSymbol).toUpperCase());
      if (!selectedPhemex || selectedPhemex.marketType !== 'spot') {
        this.specs.delete('phemex-depth');
        this.#publishActiveBookSets();
        this.#setStatus('phemex-depth', { state: 'unavailable', attempt: 0, nextRetryAt: null, lastError: 'Phemex selected symbol has no verified public spot metadata' });
      }
    }
    if (dydxEnabled && dydxSymbol) {
      const selectedDydx = (this.dydxMetadata as ReturnType<typeof normalizeDydxMarkets> | null)?.assets?.find((asset) => String(asset.nativeSymbol).toUpperCase() === String(dydxSymbol).replaceAll('_', '-').toUpperCase());
      if (!selectedDydx || selectedDydx.marketType !== 'perpetual' || selectedDydx.status !== 'online' || selectedDydx.isDelisted) {
        this.specs.delete('dydx-trades');
        this.specs.delete('dydx-depth');
        this.#setStatus('dydx-depth', { state: 'unavailable', attempt: 0, nextRetryAt: null, lastError: dydxUnavailableReason ?? 'dYdX selected symbol has no verified active public perpetual metadata' });
        this.#publishActiveBookSets();
        this.#setStatus('dydx-trades', { state: 'unavailable', attempt: 0, nextRetryAt: null, lastError: dydxUnavailableReason ?? 'dYdX selected symbol has no verified active public perpetual metadata' });
      }
    }
    if (asterEnabled && asterSymbol) {
      const selectedAster = (this.asterMetadata as ReturnType<typeof normalizeAsterMarkets> | null)?.assets?.find((asset) => String(asset.nativeSymbol).toUpperCase() === String(asterSymbol).toUpperCase());
      if (!selectedAster || selectedAster.marketType !== 'perpetual' || selectedAster.status !== 'online' || selectedAster.isDelisted) {
        this.specs.delete('aster-trades');
        this.specs.delete('aster-depth');
        this.#setStatus('aster-depth', { state: 'unavailable', attempt: 0, nextRetryAt: null, lastError: asterUnavailableReason ?? 'Aster selected symbol has no verified active public perpetual metadata' });
        this.#publishActiveBookSets();
        this.#setStatus('aster-trades', { state: 'unavailable', attempt: 0, nextRetryAt: null, lastError: asterUnavailableReason ?? 'Aster selected symbol has no verified active public perpetual metadata' });
      } else if (!isAsterLinearDepthMetadata(selectedAster, String(asterSymbol).toUpperCase())) {
        this.specs.delete('aster-depth');
        this.#publishActiveBookSets();
        this.#setStatus('aster-depth', { state: 'unavailable', active: false, attempt: 0, nextRetryAt: null, lastError: 'Aster depth requires verified USDT linear base/quote/settlement metadata' });
      }
    }
    if (!this.networkEnabled) {
      for (const id of this.specs.keys()) this.#setStatus(id, { state: 'disabled', attempt: 0, nextRetryAt: null });
      this.#setStatus('binance-openInterest', { state: 'disabled', attempt: 0, nextRetryAt: null });
      this.#setStatus('hl-candle-history', { state: 'disabled', attempt: 0, nextRetryAt: null });
      this.#setStatus('binance-kline-history', { state: 'disabled', attempt: 0, nextRetryAt: null });
      return this.status();
    }
    if (!this.transportFactory) throw new AdapterTransportError('Live feeds require an injected transportFactory when networking is enabled');
    const depthSpec = this.specs.get('binance-depth');
    const depthOpened = Boolean(this.restTransport?.request && depthSpec);
    if (depthOpened && depthSpec) {
      const depthOpen = await this.#open('binance-depth', depthSpec);
      if (configurationGeneration !== this.configurationGeneration) return this.status();
      if (depthOpen !== false) {
        const opened = this.feeds.get('binance-depth');
        const openedGeneration = opened?.generation;
        if (opened && this.#isCurrentBinanceDepthFeed(opened, openedGeneration)) {
          const snapshot = await this.syncBinanceDepth({ symbol: binanceSymbol, marketType: binanceMarketType, family: binanceFamily, metadata: depthSpec.metadata });
          if (!snapshot) this.#retryFailedBinanceSnapshot(opened, openedGeneration, depthSpec);
        }
      }
      if (configurationGeneration !== this.configurationGeneration) return this.status();
    }
    await Promise.all([...this.specs].filter(([id]) => !depthOpened || id !== 'binance-depth').map(([id, spec]) => this.#open(id, spec)));
    if (configurationGeneration !== this.configurationGeneration) return this.status();
    if (referenceBackfill && this.restTransport?.request) {
      await Promise.all([
        this.specs.has('hl-candle') ? this.syncCandleHistory({ venue: 'hyperliquid', coin, nativeCoin: hlNativeCoin, interval: this.candleInterval }) : Promise.resolve([]),
        this.specs.has('binance-kline') ? this.syncCandleHistory({ venue: 'binance', symbol: binanceSymbol, marketType: binanceMarketType, family: binanceFamily, metadata: this.specs.get('binance-kline')?.metadata, interval: this.candleInterval }) : Promise.resolve([]),
      ]);
      if (configurationGeneration !== this.configurationGeneration) return this.status();
    }
    if (this.restTransport?.request && this.specs.has('binance-markPrice') && this.oiPollMs > 0 && binanceMarketType !== 'spot') {
      if (referenceBackfill) {
        this.#setStatus('binance-openInterest', { state: 'live', attempt: 0, nextRetryAt: null });
        await this.pollOpenInterest({ symbol: binanceSymbol, marketType: binanceMarketType, family: binanceFamily, metadata: this.specs.get('binance-markPrice')?.metadata });
        if (configurationGeneration !== this.configurationGeneration) return this.status();
        // Load one bounded public-statistics window before the periodic current
        // OI poll. This is deliberately separate from Hyperliquid's pushed
        // activeAssetCtx observations and can be disabled with limit=0.
        if (this.oiHistoryLimit > 0) {
          await this.syncOpenInterestHistory({ symbol: binanceSymbol, marketType: binanceMarketType, family: binanceFamily, metadata: this.specs.get('binance-markPrice')?.metadata, period: this.oiHistoryPeriod, limit: this.oiHistoryLimit });
          if (configurationGeneration !== this.configurationGeneration) return this.status();
        }
      }
      this.#scheduleOiPoll({ symbol: binanceSymbol, marketType: binanceMarketType, family: binanceFamily, metadata: this.specs.get('binance-markPrice')?.metadata }, configurationGeneration);
    } else this.#setStatus('binance-openInterest', { state: 'unavailable', attempt: 0, nextRetryAt: null, lastError: binanceMarketType === 'spot' ? 'spot market has no open interest endpoint' : undefined });
    return this.status();
  }

  stop() {
    this.running = false;
    this.configurationGeneration += 1;
    this.#operationScope.cancel();
    if (this.#recoveryTimer !== null) { this.cancel(this.#recoveryTimer); this.#recoveryTimer = null; }
    if (this.#watchdogTimer !== null) { this.cancel(this.#watchdogTimer); this.#watchdogTimer = null; }
    this.#setStatus('active-book-set', { activeBookSets: {} });
    if (this.oiTimer !== null) { this.cancel(this.oiTimer); this.oiTimer = null; }
    for (const [id, feed] of this.feeds) {
      if (feed.retry !== null) this.cancel(feed.retry);
      this.feedGenerations.set(id, (this.feedGenerations.get(id) ?? feed.generation ?? 0) + 1);
      try { const frame = venueControlFrame(feed.spec?.venue, feed.spec?.request, 'unsubscribe', { now: this.now() }); if (frame) this.#sendControlFrameBestEffort(feed, frame); } catch { /* unsubscribe is best effort */ }
      feed.retired = true;
      this.#releaseTransport(feed);
      retireLiveFeedSocket(feed.socket);
      feed.socket = null;
      feed.session = null;
      this.#setStatus(id, { state: 'stopped', active: false, nextRetryAt: null });
    }
    this.bookSequences.clear();
    this.depthBuffers.clear();
    this.depthBridgePending.clear();
    this.#clearResyncing();
    this.#lastPrices.clear();
    this.heartbeatTimers.clear();
    this.feeds.clear();
    this.specs.clear();
    this.feedGenerations.clear();
    this.rest?.clear();
    return this.status();
  }

  refreshActiveBookSets() {
    this.#publishActiveBookSets();
  }

  status() {
    return Object.fromEntries([...this.#statuses.entries()].map(([id, value]) => [id, cloneManagerStatusValue(value)]));
  }
  retainedDiagnostics({ cached = false, allowStale = false }: {cached?: boolean; allowStale?: boolean} = {}) {
    if (cached && allowStale && this.retainedDiagnosticsCache) return this.retainedDiagnosticsCache;
    const hasRestRequestTransport = typeof this.restTransport?.request === 'function';
    let restTransportRetention: LiveFeedRestRetention | null = null;
    let restTransportMeasurementError = null;
    if (hasRestRequestTransport) {
      if (typeof this.restTransport?.retainedSnapshot !== 'function') {
        restTransportMeasurementError = 'exchange-rest-transport-retained-snapshot-unavailable';
      } else {
        try {
          const candidate = feedRecord(this.restTransport!.retainedSnapshot!());
          const waiterCount = candidate?.memoryAdmissionWaiters;
          const waiterLimit = candidate?.memoryAdmissionWaiterLimit;
          const waiterAllowance = candidate?.memoryAdmissionWaiterAllowanceBytes;
          const waiterBytes = candidate?.memoryAdmissionWaiterLogicalBytes;
          const expectedWaiterBytes = Number(waiterCount) * Number(waiterAllowance);
          if (candidate?.measurementAvailable !== true
            || typeof waiterCount !== 'number' || !Number.isSafeInteger(waiterCount) || waiterCount < 0
            || typeof waiterLimit !== 'number' || !Number.isSafeInteger(waiterLimit) || waiterLimit < 1 || waiterLimit < waiterCount || waiterLimit > MAX_EXCHANGE_REST_MEMORY_ADMISSION_WAITERS
            || waiterAllowance !== EXCHANGE_REST_MEMORY_ADMISSION_WAITER_LOGICAL_BYTES
            || !Number.isSafeInteger(expectedWaiterBytes)
            || typeof waiterBytes !== 'number' || !Number.isSafeInteger(waiterBytes) || waiterBytes !== expectedWaiterBytes) {
            restTransportMeasurementError = 'exchange-rest-transport-retained-snapshot-invalid';
          } else {
            restTransportRetention = Object.freeze({
              measurementAvailable: true,
              memoryAdmissionWaiters: waiterCount,
              memoryAdmissionWaiterLimit: waiterLimit,
              memoryAdmissionWaiterAllowanceBytes: waiterAllowance,
              memoryAdmissionWaiterLogicalBytes: waiterBytes,
            });
          }
        } catch {
          restTransportMeasurementError = 'exchange-rest-transport-retained-snapshot-failed';
        }
      }
    }
    const measurementComplete = !hasRestRequestTransport || restTransportRetention !== null;
    const restTransportWaiterBytes = restTransportRetention?.memoryAdmissionWaiterLogicalBytes ?? 0;
    const snapshot = { feedIds: [...this.feeds.keys()], specIds: [...this.specs.keys()], bookSequences: Object.fromEntries(this.bookSequences), depthBuffers: Object.fromEntries([...this.depthBuffers].map(([key, rows]) => [key, rows.length])), depthBridgePending: Object.fromEntries(this.depthBridgePending), resyncing: [...this.resyncing.keys()], lastPrices: Object.fromEntries(this.#lastPrices), sessionVenues: [...this.feeds].filter(([, feed]) => feed.session).map(([id, feed]) => ({ id, venue: feed.spec.venue })), transportBudget: this.transportBudget.snapshot(), transportFeeds: [...this.feeds].map(([id, feed]) => ({ id, venue: feed.spec?.venue, generation: feed.generation, subscriptionAcked: feed.subscriptionAcked === true, transportReleased: feed.transportReleased === true, lastObservedAt: feed.heartbeat?.lastObservedAt ?? null, lastHeartbeatAt: feed.heartbeat?.lastHeartbeatAt ?? null })) };
    // Feed shells contain live WebSocket/TLS objects and opaque scheduling
    // handles. Project application state without walking native internals;
    // retain every session/spec/request/pre-ACK payload and shared reference.
    const nativeTransports = new Set<LiveFeedSocket>(), nativeTimers = new Set<FeedTimer>(), callbacks = new Set<unknown>();
    const noteCallback = (value: unknown) => { if (typeof value === 'function') callbacks.add(value); };
    for (const callback of [this.transportFactory, this.onMessage, this.onTradeBatch, this.onStatus, this.retainedAdmission, this.reserveTransientMemory,
      this.now, this.schedule, this.cancel, this.heartbeatSchedule, this.heartbeatCancel, this.transportNow, ...this.#operationScope.pendingCallbacks]) noteCallback(callback);
    const projectedSpecs = new Map<LiveFeedSpec, Omit<LiveFeedSpec, 'decode'>>();
    const projectSpec = (spec: LiveFeedSpec) => {
      let projected = projectedSpecs.get(spec);
      if (!projected) { const { decode, ...payload } = spec; noteCallback(decode); projected = payload; projectedSpecs.set(spec, projected); }
      return projected;
    };
    const projectedFeedSpecs = new Map([...this.specs].map(([id, spec]) => [id, projectSpec(spec)]));
    const projectedFeeds = new Map([...this.feeds].map(([id, feed]) => {
      const { socket, retry, heartbeatTimer, heartbeat, spec, ...payload } = feed;
      if (socket !== null) nativeTransports.add(socket);
      for (const timer of [retry, heartbeatTimer]) if (timer !== null && timer !== undefined) nativeTimers.add(timer);
      let heartbeatPayload: Omit<VenueHeartbeatDeadline, 'now' | 'observe' | 'heartbeatSent' | 'nextAction'> | null = null;
      if (heartbeat) { const { now, ...state } = heartbeat; noteCallback(now); heartbeatPayload = state; }
      return [id, { ...payload, spec: projectSpec(spec), heartbeat: heartbeatPayload, transportPresent: socket !== null,
        retryScheduled: retry !== null && retry !== undefined, heartbeatScheduled: heartbeatTimer !== null && heartbeatTimer !== undefined }];
    }));
    for (const timer of this.heartbeatTimers.values()) if (timer !== null && timer !== undefined) nativeTimers.add(timer);
    for (const timer of this.#operationScope.pendingTimers) nativeTimers.add(timer);
    if (this.oiTimer !== null && this.oiTimer !== undefined) nativeTimers.add(this.oiTimer);
    const nativeOwnership: LiveFeedNativeOwnership = {
      transports: nativeTransports.size, transportAllowanceBytes: LIVE_FEED_TRANSPORT_SHELL_LOGICAL_BYTES,
      transportLogicalBytes: nativeTransports.size * LIVE_FEED_TRANSPORT_SHELL_LOGICAL_BYTES,
      timers: nativeTimers.size, timerAllowanceBytes: LIVE_FEED_TIMER_SHELL_LOGICAL_BYTES,
      timerLogicalBytes: nativeTimers.size * LIVE_FEED_TIMER_SHELL_LOGICAL_BYTES,
      callbacks: callbacks.size, callbackAllowanceBytes: LIVE_FEED_CALLBACK_SHELL_LOGICAL_BYTES,
      callbackLogicalBytes: callbacks.size * LIVE_FEED_CALLBACK_SHELL_LOGICAL_BYTES,
      nativeGraphTraversed: false, accounting: 'fixed-logical-shell-allowance', physicalMemory: 'process-RSS-authoritative',
    };
    const logicalComponents = logicalRetainedComponents({
      feeds: projectedFeeds,
      specs: projectedFeedSpecs,
      bookSequences: this.bookSequences,
      depthBuffers: this.depthBuffers,
      depthBridgePending: this.depthBridgePending,
      resyncing: this.resyncing,
      lastPrices: this.#lastPrices,
      feedGenerations: this.feedGenerations,
      managerStatuses: this.#statuses,
      transportBudgetState: this.transportBudget?.state ?? null,
      restCoordinator: this.rest?.retainedSnapshot?.() ?? null,
      exchangeRestTransport: restTransportRetention ?? (hasRestRequestTransport ? { measurementAvailable: false } : null),
      venueMetadata: {
        whitebit: this.whitebitMetadata,
        phemex: this.phemexMetadata,
        dydx: this.dydxMetadata,
        aster: this.asterMetadata,
      },
      managerTimers: {
        heartbeatFeedIds: [...this.heartbeatTimers.keys()],
        oiPollActive: this.oiTimer !== null,
      },
      managerLifecycle: {
        running: this.running,
        sessionCounter: this.sessionCounter,
        configurationGeneration: this.configurationGeneration,
        operationScope: { cancelled: this.#operationScope.cancelled, pendingOperations: this.#operationScope.pendingCallbacks.length },
      },
    });
    // The waiter shell allowance is an explicit logical budget contribution;
    // generic object traversal cannot see Promise callbacks or timer handles.
    logicalComponents.exchangeRestTransportWaiters = restTransportWaiterBytes;
    logicalComponents.nativeTransportShells = nativeOwnership.transportLogicalBytes;
    logicalComponents.nativeTimerShells = nativeOwnership.timerLogicalBytes;
    logicalComponents.callbackShells = nativeOwnership.callbackLogicalBytes;
    // The cache is replaced below. Size the snapshot we will retain, with
    // numeric placeholders so the measurement cannot refer to itself.
    logicalComponents.diagnosticsCache = 0;
    const partialLogicalBytes = Object.values(logicalComponents).reduce((sum, value) => sum + value, 0);
    const value = {
      ...snapshot,
      exchangeRestTransportRetention: restTransportRetention,
      nativeOwnership,
      measurementComplete,
      measurementError: restTransportMeasurementError,
      logicalComponents,
      logicalBytes: measurementComplete ? partialLogicalBytes : null,
      partialLogicalBytes: measurementComplete ? null : partialLogicalBytes,
    };
    logicalComponents.diagnosticsCache = logicalRetainedBytes(value);
    if (measurementComplete) value.logicalBytes = Number(value.logicalBytes) + logicalComponents.diagnosticsCache;
    else value.partialLogicalBytes = Number(value.partialLogicalBytes) + logicalComponents.diagnosticsCache;
    this.retainedDiagnosticsCache = value;
    return value;
  }
  retainedRamBudget({ cached = false, allowStale = false }: {cached?: boolean; allowStale?: boolean} = {}) {
    const diagnostics = this.retainedDiagnostics({ cached, allowStale });
    return {
      logicalBytes: diagnostics.measurementComplete === false ? null : Number(diagnostics.logicalBytes) || 0,
      partialLogicalBytes: diagnostics.partialLogicalBytes ?? null,
      measurementComplete: diagnostics.measurementComplete === true,
      measurementError: diagnostics.measurementError ?? null,
      depthBufferRows: Object.values(diagnostics.depthBuffers ?? {}).reduce((sum, value) => sum + Number(value || 0), 0),
      resyncing: diagnostics.resyncing.length,
      activeFeeds: diagnostics.feedIds.length,
    };
  }
  /** Drop only obsolete bridge backlog or trim it to a small replay window.
   * Active book sequences and resync markers stay intact; a later REST
   * snapshot can re-anchor a feed if a trimmed bridge no longer covers it.
   */
  reclaimRetainedRam({ targetBytes = 0 }: {targetBytes?: number} = {}) {
    const beforeDiagnostics = this.retainedDiagnostics();
    if (beforeDiagnostics.measurementComplete === false) return 0;
    const before = Number(beforeDiagnostics.logicalBytes) || 0;
    const target = Math.max(0, Number(targetBytes) || 0);
    if (target <= 0) return 0;
    const activeKeys = new Set();
    for (const spec of this.specs.values()) {
      if (!spec?.instrumentId || !['depth', 'l2Book', 'book'].includes(spec.channel)) continue;
      // Binance bridge buffers are keyed by instrumentId; HL/other source
      // variants normally use the explicit bookKey. Keep both identities so
      // the budget pass cannot misclassify a live bridge as orphaned.
      activeKeys.add(String(spec.instrumentId));
      activeKeys.add(String(spec.bookKey ?? `${spec.instrumentId}|${spec.resolutionKey ?? 'native'}`));
    }
    const protectedKeys = new Set([...this.depthBridgePending.keys(), ...this.resyncing.keys()].map(String));
    for (const key of [...this.depthBuffers.keys()]) {
      if (!activeKeys.has(String(key)) && !protectedKeys.has(String(key))) this.depthBuffers.delete(key);
    }
    let current = Number(this.retainedDiagnostics().logicalBytes) || 0;
    if (before - current < target) {
      for (const [key, rows] of this.depthBuffers) {
        if (!Array.isArray(rows) || rows.length <= 32) continue;
        // A pending bridge or REST resync owns its replay window. Dropping it
        // would turn a recoverable sequence into a false gap; let the next
        // snapshot re-anchor instead.
        if (this.depthBridgePending.get(key) === true || this.resyncing.has(key)) continue;
        this.depthBuffers.set(key, rows.slice(-32));
        current = Number(this.retainedDiagnostics().logicalBytes) || 0;
        if (before - current >= target) break;
      }
    }
    return Math.max(0, before - current);
  }

  async pollOpenInterest({ symbol = 'BTCUSDT', marketType = 'perpetual', family = 'usdm', metadata = this.specs.get('binance-markPrice')?.metadata }: AdapterOptions = {}) {
    if (!this.networkEnabled) { this.#setStatus('binance-openInterest', { state: 'disabled', attempt: 0, nextRetryAt: null }); return null; }
    if (marketType === 'spot') { this.#setStatus('binance-openInterest', { state: 'unavailable', attempt: 0, nextRetryAt: null, lastError: 'spot market has no open interest endpoint' }); return null; }
    if (!this.restTransport?.request) { this.#setStatus('binance-openInterest', { state: 'unavailable', attempt: 0, nextRetryAt: null }); return null; }
    const requestGeneration = this.configurationGeneration;
    try {
      const request = buildBinanceRequest('openInterest', { symbol, marketType, family, metadata });
      const payload = await this.#requestRest(request, 'binance');
      if (requestGeneration !== this.configurationGeneration) return null;
      const message = normalizeBinanceOpenInterest(payload, { symbol, marketType, family, metadata, receivedAt: this.now(), markPrice: this.#lastPrices.get(binanceInstrumentId(symbol, marketType, family)) });
      if (this.#emit('binance-openInterest', 'binance', message) === false) { this.#setStatus('binance-openInterest', { state: 'unavailable', lastError: 'retained-data admission rejected' }); return null; }
      this.#setStatus('binance-openInterest', { state: 'live', attempt: 0, nextRetryAt: null, lastSuccess: this.now(), sourceTimestamp: message.sourceTimestamp ?? null, sourceAgeMs: message.sourceTimestamp == null ? null : Math.max(0, this.now() - Number(message.sourceTimestamp)), lastError: null });
      return message;
    } catch (error) {
      if (requestGeneration !== this.configurationGeneration) return null;
      this.#setStatus('binance-openInterest', { state: 'backoff', attempt: 1, nextRetryAt: null, lastError: feedError(error).message ?? String(error) });
      return null;
    }
  }

  /** Fetch bounded Binance public OI-statistics pages. Binance caps each page
   * at 500 rows; an explicit larger limit walks backwards with endTime. */
  async syncOpenInterestHistory({ symbol = 'BTCUSDT', marketType = 'perpetual', family = 'usdm', metadata = this.specs.get('binance-markPrice')?.metadata, period = '5m', limit = 500, startTime, endTime }: AdapterOptions = {}) {
    const statusId = 'binance-openInterest-history', requestGeneration = this.configurationGeneration;
    if (!this.networkEnabled || !this.restTransport?.request) { this.#setStatus(statusId, { state: 'disabled', attempt: 0, nextRetryAt: null }); return []; }
    if (marketType === 'spot') { this.#setStatus(statusId, { state: 'unavailable', attempt: 0, nextRetryAt: null, lastError: 'spot market has no open interest endpoint' }); return []; }
    const cappedLimit = Math.max(1, Math.min(5_000, Math.trunc(Number(limit) || 500)));
    this.#setStatus(statusId, { state: 'loading', attempt: 0, nextRetryAt: null, source: 'binance-public-statistics', period, lastError: null });
    try {
      const receivedAt = this.now(); const collected = []; const seen = new Set(); let cursorEnd = endTime == null ? undefined : Number(endTime); const lowerBound = startTime == null ? null : Number(startTime);
      for (let page = 0; collected.length < cappedLimit && page < 20; page += 1) {
        const pageLimit = Math.min(500, cappedLimit - collected.length); const request = buildBinanceRequest('openInterestHistory', { symbol, marketType, family, metadata, period, limit: pageLimit, startTime, endTime: cursorEnd });
        const payload = await this.#requestRest(request, 'binance', `${restRequestKey(request, 'binance')}|oi-history|page=${page}`);
        if (requestGeneration !== this.configurationGeneration) return [];
        const rows = normalizeBinanceOpenInterestHistory(payload, { symbol, marketType, family, metadata, receivedAt });
        const fresh = rows.filter((row) => (!Number.isFinite(lowerBound) || row.sourceTimestamp >= Number(lowerBound)) && (!Number.isFinite(Number(endTime)) || row.sourceTimestamp <= Number(endTime)) && !seen.has(row.sourceTimestamp));
        if (!fresh.length) break;
        for (const row of fresh) { seen.add(row.sourceTimestamp); collected.push(row); }
        const oldest = rows[0]?.sourceTimestamp;
        if (rows.length < pageLimit || !(oldest > 0) || (Number.isFinite(lowerBound) && oldest <= Number(lowerBound))) break;
        const nextEnd = Number(oldest) - 1; if (cursorEnd != null && !(nextEnd < cursorEnd)) break; cursorEnd = nextEnd;
      }
      const bounded = collected.sort((a, b) => a.sourceTimestamp - b.sourceTimestamp).slice(-cappedLimit);
      for (const row of bounded) { if (requestGeneration !== this.configurationGeneration) return []; if (this.#emit(statusId, 'binance', row) === false) { this.#setStatus(statusId, { state: 'unavailable', lastError: 'retained-data admission rejected' }); return []; } }
      this.#setStatus(statusId, { state: bounded.length ? 'live' : 'unavailable', attempt: 0, nextRetryAt: null, lastSuccess: bounded.length ? receivedAt : undefined, sourceTimestamp: bounded.at(-1)?.sourceTimestamp ?? null, sourceAgeMs: bounded.length ? Math.max(0, receivedAt - Number(bounded.at(-1)?.sourceTimestamp)) : null, coverageStart: bounded[0]?.sourceTimestamp ?? null, coverageEnd: bounded.at(-1)?.sourceTimestamp ?? null, sampleCount: bounded.length, lastError: bounded.length ? null : 'open-interest history response was empty' });
      return bounded;
    } catch (error) {
      if (requestGeneration !== this.configurationGeneration) return [];
      this.#setStatus(statusId, { state: 'unavailable', attempt: 0, nextRetryAt: null, lastError: feedError(error).message ?? String(error) });
      return [];
    }
  }

  async syncHyperliquidMetadata({ coin = 'BTC' }: AdapterOptions = {}) {
    const requestGeneration = this.configurationGeneration;
    if (!this.networkEnabled || !this.restTransport?.request) {
      this.#setStatus('hl-metadata', { state: 'disabled', attempt: 0, nextRetryAt: null });
      return null;
    }
    this.#setStatus('hl-metadata', { state: 'connecting', attempt: 0, nextRetryAt: null, lastError: null });
    try {
      const request = buildHyperliquidInfoRequest('metaAndAssetCtxs');
      const payload = await this.#requestRest(request, 'hyperliquid');
      if (requestGeneration !== this.configurationGeneration) return null;
      const receivedAt = this.now();
      const metadata = normalizeHyperliquidMetadata(payload, { receivedAt });
      if (this.#emit('hl-metadata', 'hyperliquid', metadata) === false) return null;
      // metaAndAssetCtxs is a useful initial OI snapshot. The websocket
      // activeAssetCtx feed remains authoritative for subsequent updates.
      try {
        const oi = normalizeHyperliquidAssetContext(payload, { coin, receivedAt });
        this.#emit('hl-activeAssetCtx', 'hyperliquid', oi);
      } catch {
        // Metadata can still be useful when the selected asset context is absent.
      }
      this.#setStatus('hl-metadata', { state: 'snapshot', attempt: 0, nextRetryAt: null, lastSuccess: receivedAt, lastError: null });
      return metadata;
    } catch (error) {
      if (requestGeneration !== this.configurationGeneration) return null;
      this.#setStatus('hl-metadata', { state: 'unavailable', attempt: 0, nextRetryAt: null, lastError: feedError(error).message ?? String(error) });
      return null;
    }
  }

  async syncOkxMetadata({ symbol = 'BTC-USDT-SWAP', instType = 'SWAP', marketType = instType === 'SPOT' ? 'spot' : 'perpetual' }: AdapterOptions = {}) {
    const statusId = 'okx-metadata', requestGeneration = this.configurationGeneration;
    if (!this.networkEnabled || !this.restTransport?.request) { this.#setStatus(statusId, { state: 'disabled', attempt: 0, nextRetryAt: null }); return null; }
    this.#setStatus(statusId, { state: 'connecting', attempt: 0, nextRetryAt: null, lastError: null });
    try {
      const request = buildOkxRequest('instruments', { instType, instId: String(symbol ?? ''), marketType });
      const payload = await this.#requestRest(request, 'okx');
      if (requestGeneration !== this.configurationGeneration) return null;
      const receivedAt = this.now();
      const metadata = normalizeOkxInstrumentInfo(payload, { instId: String(symbol ?? ''), instType, marketType, receivedAt });
      if (!this.#publishSelectedPublicMetadata(statusId, metadata, requestGeneration)) return null;
      this.#setStatus(statusId, { state: metadata.assets.length ? 'snapshot' : 'unavailable', attempt: 0, nextRetryAt: null, lastSuccess: receivedAt, lastError: metadata.assets.length ? null : 'OKX instrument metadata was empty' });
      return metadata;
    } catch (error) {
      if (requestGeneration !== this.configurationGeneration) return null;
      this.#setStatus(statusId, { state: 'unavailable', attempt: 0, nextRetryAt: null, lastError: feedError(error).message ?? String(error) });
      return null;
    }
  }

  async syncBinanceMetadata({ symbol = 'BTCUSDT', marketType = 'perpetual', family = 'usdm' }: AdapterOptions = {}) {
    const statusId = 'binance-metadata', requestGeneration = this.configurationGeneration;
    if (!this.networkEnabled || !this.restTransport?.request) { this.#setStatus(statusId, { state: 'disabled', attempt: 0, nextRetryAt: null }); return null; }
    this.#setStatus(statusId, { state: 'connecting', attempt: 0, nextRetryAt: null, lastError: null });
    try {
      const request = buildBinanceRequest('exchangeInfo', { symbol, marketType, family });
      const payload = await this.#requestRest(request, 'binance');
      if (requestGeneration !== this.configurationGeneration) return null;
      const receivedAt = this.now();
      const metadata = normalizeBinanceExchangeInfo(payload, { symbol, marketType, family, receivedAt });
      if (!this.#publishSelectedPublicMetadata(statusId, metadata, requestGeneration)) return null;
      this.#setStatus(statusId, { state: metadata.assets.length ? 'snapshot' : 'unavailable', attempt: 0, nextRetryAt: null, lastSuccess: receivedAt, lastError: metadata.assets.length ? null : 'Binance exchange metadata was empty' });
      return metadata;
    } catch (error) {
      if (requestGeneration !== this.configurationGeneration) return null;
      this.#setStatus(statusId, { state: 'unavailable', attempt: 0, nextRetryAt: null, lastError: feedError(error).message ?? String(error) });
      return null;
    }
  }

  async syncBybitMetadata({ symbol = 'BTCUSDT', category = 'linear' }: AdapterOptions = {}) {
    const statusId = 'bybit-metadata', requestGeneration = this.configurationGeneration;
    if (!this.networkEnabled || !this.restTransport?.request) { this.#setStatus(statusId, { state: 'disabled', attempt: 0, nextRetryAt: null }); return null; }
    this.#setStatus(statusId, { state: 'connecting', attempt: 0, nextRetryAt: null, lastError: null });
    try {
      const request = buildBybitRequest('instruments', { category, symbol });
      const payload = await this.#requestRest(request, 'bybit');
      if (requestGeneration !== this.configurationGeneration) return null;
      const receivedAt = this.now();
      const metadata = normalizeBybitInstrumentInfo(payload, { symbol, category, receivedAt });
      if (!this.#publishSelectedPublicMetadata(statusId, metadata, requestGeneration)) return null;
      this.#setStatus(statusId, { state: metadata.assets.length ? 'snapshot' : 'unavailable', attempt: 0, nextRetryAt: null, lastSuccess: receivedAt, lastError: metadata.assets.length ? null : 'Bybit instrument metadata was empty' });
      return metadata;
    } catch (error) {
      if (requestGeneration !== this.configurationGeneration) return null;
      this.#setStatus(statusId, { state: 'unavailable', attempt: 0, nextRetryAt: null, lastError: feedError(error).message ?? String(error) });
      return null;
    }
  }

  async syncBitgetMetadata({ symbol = 'BTCUSDT', instType = 'usdt-futures', category = instType, marketType = instType === 'spot' ? 'spot' : 'perpetual' }: AdapterOptions = {}) {
    const statusId = 'bitget-metadata', requestGeneration = this.configurationGeneration;
    if (!this.networkEnabled || !this.restTransport?.request) { this.#setStatus(statusId, { state: 'disabled', attempt: 0, nextRetryAt: null }); return null; }
    this.#setStatus(statusId, { state: 'connecting', attempt: 0, nextRetryAt: null, lastError: null });
    try {
      const request = buildBitgetRequest('instruments', { category, instType, marketType, symbol });
      const payload = await this.#requestRest(request, 'bitget');
      if (requestGeneration !== this.configurationGeneration) return null;
      const receivedAt = this.now();
      const metadata = normalizeBitgetInstrumentInfo(payload, { symbol, category, instType, marketType, receivedAt });
      if (!this.#publishSelectedPublicMetadata(statusId, metadata, requestGeneration)) return null;
      this.#setStatus(statusId, { state: metadata.assets.length ? 'snapshot' : 'unavailable', attempt: 0, nextRetryAt: null, lastSuccess: receivedAt, lastError: metadata.assets.length ? null : 'Bitget instrument metadata was empty' });
      return metadata;
    } catch (error) {
      if (requestGeneration !== this.configurationGeneration) return null;
      this.#setStatus(statusId, { state: 'unavailable', attempt: 0, nextRetryAt: null, lastError: feedError(error).message ?? String(error) });
      return null;
    }
  }
  async syncGateIoMetadata({ symbol = 'BTC_USDT' }: AdapterOptions = {}) {
    const requestGeneration = this.configurationGeneration;
    const statusId = 'gateio-metadata';
    if (!this.networkEnabled || !this.restTransport?.request) { this.#setStatus(statusId, { state: 'disabled', attempt: 0, nextRetryAt: null }); return null; }
    this.#setStatus(statusId, { state: 'connecting', attempt: 0, nextRetryAt: null, lastError: null });
    try {
      const request = buildGateRequest('contracts', { contract: String(symbol ?? ''), settle: 'usdt' });
      const payload = await this.#requestRest(request, 'gateio');
      if (requestGeneration !== this.configurationGeneration) return null;
      const receivedAt = this.now();
      const metadata = normalizeGateContractInfo(payload, { receivedAt });
      const spec = this.specs.get('gateio-depth');
      const asset = metadata.assets.find(item => item.instrumentId === 'gateio:' + String(symbol).replaceAll('-', '_').toUpperCase());
      if (!this.#publishVenueMetadata(statusId, metadata, () => {
        if (spec?.venue === 'gateio' && asset?.contractValue != null && asset.contractValue > 0) spec.request = { ...spec.request, contractValue: asset.contractValue };
      })) return null;
      this.#setStatus(statusId, { state: metadata.assets.length ? 'snapshot' : 'unavailable', attempt: 0, nextRetryAt: null, lastSuccess: receivedAt, lastError: metadata.assets.length ? null : 'Gate.io contract metadata was empty' });
      return metadata;
    } catch (error) {
      if (requestGeneration !== this.configurationGeneration) return null;
      this.#setStatus(statusId, { state: 'unavailable', attempt: 0, nextRetryAt: null, lastError: feedError(error).message ?? String(error) });
      return null;
    }
  }

  async syncDeribitMetadata({ symbol = 'BTC-PERPETUAL' }: AdapterOptions = {}) {
    const requestGeneration = this.configurationGeneration;
    const statusId = 'deribit-metadata';
    if (!this.networkEnabled || !this.restTransport?.request) { this.#setStatus(statusId, { state: 'disabled', attempt: 0, nextRetryAt: null }); return null; }
    this.#setStatus(statusId, { state: 'connecting', attempt: 0, nextRetryAt: null, lastError: null });
    try {
      const request = buildDeribitRequest('instrument', { instrumentName: String(symbol ?? '') });
      const payload = await this.#requestRest(request, 'deribit');
      if (requestGeneration !== this.configurationGeneration) return null;
      const receivedAt = this.now();
      const metadata = normalizeDeribitInstrumentInfo(payload, { receivedAt });
      this.#emit(statusId, 'deribit', metadata);
      this.#setStatus(statusId, { state: metadata.assets.length ? 'snapshot' : 'unavailable', attempt: 0, nextRetryAt: null, lastSuccess: receivedAt, lastError: metadata.assets.length ? null : 'Deribit instrument metadata was empty' });
      return metadata;
    } catch (error) {
      if (requestGeneration !== this.configurationGeneration) return null;
      this.#setStatus(statusId, { state: 'unavailable', attempt: 0, nextRetryAt: null, lastError: feedError(error).message ?? String(error) });
      return null;
    }
  }

  async syncCoinbaseMetadata({ symbol = 'BTC-USD' }: AdapterOptions = {}) {
    const requestGeneration = this.configurationGeneration;
    const statusId = 'coinbase-metadata';
    if (!this.networkEnabled || !this.restTransport?.request) { this.#setStatus(statusId, { state: 'disabled', attempt: 0, nextRetryAt: null }); return null; }
    this.#setStatus(statusId, { state: 'connecting', attempt: 0, nextRetryAt: null, lastError: null });
    try {
      const request = buildCoinbaseRequest('product', { productId: String(symbol ?? '') });
      const payload = await this.#requestRest(request, 'coinbase');
      if (requestGeneration !== this.configurationGeneration) return null;
      const receivedAt = this.now();
      const metadata = normalizeCoinbaseProduct(payload, { receivedAt });
      this.#emit(statusId, 'coinbase', metadata);
      this.#setStatus(statusId, { state: metadata.assets.length ? 'snapshot' : 'unavailable', attempt: 0, nextRetryAt: null, lastSuccess: receivedAt, lastError: metadata.assets.length ? null : 'Coinbase product metadata was empty' });
      return metadata;
    } catch (error) {
      if (requestGeneration !== this.configurationGeneration) return null;
      this.#setStatus(statusId, { state: 'unavailable', attempt: 0, nextRetryAt: null, lastError: feedError(error).message ?? String(error) });
      return null;
    }
  }

  async syncKrakenMetadata({ symbol = 'BTC/USD' }: AdapterOptions = {}) {
    const requestGeneration = this.configurationGeneration;
    const statusId = 'kraken-metadata';
    if (!this.networkEnabled || !this.restTransport?.request) { this.#setStatus(statusId, { state: 'disabled', attempt: 0, nextRetryAt: null }); return null; }
    this.#setStatus(statusId, { state: 'connecting', attempt: 0, nextRetryAt: null, lastError: null });
    try {
      const payload = await this.#requestRest(buildKrakenRequest('assetPairs'), 'kraken');
      if (requestGeneration !== this.configurationGeneration) return null;
      const metadata = normalizeKrakenAssetPairs(payload, { receivedAt: this.now(), websocketVersion: 2 });
      const expected = krakenWebSocketSymbol(symbol);
      const selected = metadata.assets.filter(asset => asset.nativeSymbol === expected);
      this.#emit(statusId, 'kraken', { ...metadata, assets: selected });
      this.#setStatus(statusId, { state: selected.length ? 'snapshot' : 'unavailable', attempt: 0, nextRetryAt: null, lastSuccess: this.now(), lastError: selected.length ? null : `Kraken product metadata missing ${expected}` });
      return { ...metadata, assets: selected };
    } catch (error) {
      if (requestGeneration !== this.configurationGeneration) return null;
      this.#setStatus(statusId, { state: 'unavailable', attempt: 0, nextRetryAt: null, lastError: feedError(error).message ?? String(error) });
      return null;
    }
  }

  async syncKucoinMetadata({ symbol = 'BTC-USDT' }: AdapterOptions = {}) {
    const requestGeneration = this.configurationGeneration;
    const statusId = 'kucoin-metadata';
    if (!this.networkEnabled || !this.restTransport?.request) { this.#setStatus(statusId, { state: 'disabled', attempt: 0, nextRetryAt: null }); return null; }
    this.#setStatus(statusId, { state: 'connecting', attempt: 0, nextRetryAt: null, lastError: null });
    try {
      const payload = await this.#requestRest(buildKucoinRequest('symbol', { symbol }), 'kucoin');
      if (requestGeneration !== this.configurationGeneration) return null;
      const metadata = normalizeKucoinSymbol(payload, { symbol, receivedAt: this.now() });
      this.#emit(statusId, 'kucoin', metadata);
      this.#setStatus(statusId, { state: 'snapshot', attempt: 0, nextRetryAt: null, lastSuccess: this.now(), lastError: null });
      return metadata;
    } catch (error) {
      if (requestGeneration !== this.configurationGeneration) return null;
      this.#setStatus(statusId, { state: 'unavailable', attempt: 0, nextRetryAt: null, lastError: feedError(error).message ?? String(error) });
      return null;
    }
  }

  async syncKucoinPublicToken() {
    const requestGeneration = this.configurationGeneration;
    const statusId = 'kucoin-transport';
    if (!this.networkEnabled || !this.restTransport?.request) { this.#setStatus(statusId, { state: 'disabled', attempt: 0, nextRetryAt: null }); return null; }
    this.#setStatus(statusId, { state: 'connecting', attempt: 0, nextRetryAt: null, lastError: null });
    try {
      const handshake = normalizeKucoinPublicToken(await this.#requestRest(buildKucoinRequest('publicToken'), 'kucoin'), { receivedAt: this.now() });
      if (requestGeneration !== this.configurationGeneration) return null;
      const spec = this.specs.get('kucoin-depth');
      if (spec?.venue === 'kucoin') spec.request = { ...spec.request, url: buildKucoinWsUrl({ endpoint: handshake.endpoint, token: handshake.token, connectId: `hlm-${this.configurationGeneration}` }), pingIntervalMs: handshake.pingIntervalMs, heartbeatTimeoutMs: handshake.heartbeatTimeoutMs, transportReady: true };
      this.#setStatus(statusId, { state: 'snapshot', attempt: 0, nextRetryAt: null, lastSuccess: this.now(), lastError: null, endpoint: handshake.endpoint, pingIntervalMs: handshake.pingIntervalMs, heartbeatTimeoutMs: handshake.heartbeatTimeoutMs });
      return handshake;
    } catch (error) {
      if (requestGeneration !== this.configurationGeneration) return null;
      const spec = this.specs.get('kucoin-depth');
      if (spec?.venue === 'kucoin') spec.request = { ...spec.request, transportReady: false };
      this.#setStatus(statusId, { state: 'unavailable', attempt: 0, nextRetryAt: null, lastError: feedError(error).message ?? String(error) });
      return null;
    }
  }

  async syncMexcMetadata({ symbol = 'BTC_USDT' }: AdapterOptions = {}) {
    const requestGeneration = this.configurationGeneration;
    const statusId = 'mexc-metadata';
    if (!this.networkEnabled || !this.restTransport?.request) { this.#setStatus(statusId, { state: 'disabled', attempt: 0, nextRetryAt: null }); return null; }
    this.#setStatus(statusId, { state: 'connecting', attempt: 0, nextRetryAt: null, lastError: null });
    try {
      const payload = await this.#requestRest(buildMexcRequest('contracts', { symbol }), 'mexc');
      if (requestGeneration !== this.configurationGeneration) return null;
      const metadata = normalizeMexcContractInfo(payload, { symbol, receivedAt: this.now() });
      const spec = this.specs.get('mexc-depth');
      const asset = metadata.assets.find(item => item.instrumentId === `mexc:${String(symbol).toUpperCase()}`);
      if (!this.#publishVenueMetadata(statusId, metadata, () => {
        if (spec?.venue === 'mexc' && asset?.contractValue != null && asset.contractValue > 0) spec.request = { ...spec.request, contractValue: asset.contractValue };
      })) return null;
      this.#setStatus(statusId, { state: 'snapshot', attempt: 0, nextRetryAt: null, lastSuccess: this.now(), lastError: null });
      return metadata;
    } catch (error) {
      if (requestGeneration !== this.configurationGeneration) return null;
      this.#setStatus(statusId, { state: 'unavailable', attempt: 0, nextRetryAt: null, lastError: feedError(error).message ?? String(error) });
      return null;
    }
  }

  async syncHtxMetadata({ symbol = 'BTC-USDT' }: AdapterOptions = {}) {
    const requestGeneration = this.configurationGeneration;
    const statusId = 'htx-metadata';
    if (!this.networkEnabled || !this.restTransport?.request) { this.#setStatus(statusId, { state: 'disabled', attempt: 0, nextRetryAt: null }); return null; }
    this.#setStatus(statusId, { state: 'connecting', attempt: 0, nextRetryAt: null, lastError: null });
    try {
      const payload = await this.#requestRest(buildHtxRequest('contracts', { symbol }), 'htx');
      if (requestGeneration !== this.configurationGeneration) return null;
      const metadata = normalizeHtxContractInfo(payload, { receivedAt: this.now() });
      const spec = this.specs.get('htx-depth');
      const asset = metadata.assets.find(item => item.instrumentId === `htx:${String(symbol).toUpperCase().replaceAll('_', '-').replaceAll('/', '-')}`);
      if (spec?.venue === 'htx' && asset?.contractValue != null) spec.request = { ...spec.request, contractValue: asset.contractValue };
      this.#emit(statusId, 'htx', metadata);
      this.#setStatus(statusId, { state: 'snapshot', attempt: 0, nextRetryAt: null, lastSuccess: this.now(), lastError: null });
      return metadata;
    } catch (error) {
      if (requestGeneration !== this.configurationGeneration) return null;
      this.#setStatus(statusId, { state: 'unavailable', attempt: 0, nextRetryAt: null, lastError: feedError(error).message ?? String(error) });
      return null;
    }
  }

  async syncBitfinexMetadata({ symbol = 'BTCUSD' }: AdapterOptions = {}) {
    const requestGeneration = this.configurationGeneration;
    const statusId = 'bitfinex-metadata';
    if (!this.networkEnabled || !this.restTransport?.request) { this.#setStatus(statusId, { state: 'disabled', attempt: 0, nextRetryAt: null }); return null; }
    this.#setStatus(statusId, { state: 'connecting', attempt: 0, nextRetryAt: null, lastError: null });
    try {
      const payload = await this.#requestRest(buildBitfinexRequest('symbolsDetails'), 'bitfinex');
      if (requestGeneration !== this.configurationGeneration) return null;
      const metadata = normalizeBitfinexSymbolsDetails(payload, { receivedAt: this.now() });
      const normalized = String(symbol).toUpperCase().replace(/^T/, '').replaceAll('/', '').replaceAll('-', '').replaceAll('_', '');
      const selected = metadata.assets.filter(asset => String(asset.nativeSymbol).replace(/^t/i, '').toUpperCase() === normalized);
      this.#emit(statusId, 'bitfinex', { ...metadata, assets: selected });
      this.#setStatus(statusId, { state: selected.length ? 'snapshot' : 'unavailable', attempt: 0, nextRetryAt: null, lastSuccess: this.now(), lastError: selected.length ? null : 'Bitfinex metadata pair not found' });
      return { ...metadata, assets: selected };
    } catch (error) {
      if (requestGeneration !== this.configurationGeneration) return null;
      this.#setStatus(statusId, { state: 'unavailable', attempt: 0, nextRetryAt: null, lastError: feedError(error).message ?? String(error) });
      return null;
    }
  }

  async syncBitmexMetadata({ symbol = 'XBTUSD' }: AdapterOptions = {}) {
    const requestGeneration = this.configurationGeneration;
    const statusId = 'bitmex-metadata';
    if (!this.networkEnabled || !this.restTransport?.request) { this.#setStatus(statusId, { state: 'disabled', attempt: 0, nextRetryAt: null }); return null; }
    this.#setStatus(statusId, { state: 'connecting', attempt: 0, nextRetryAt: null, lastError: null });
    try {
      const payload = await this.#requestRest(buildBitmexRequest('instrument', { symbol }), 'bitmex');
      if (requestGeneration !== this.configurationGeneration) return null;
      const metadata = normalizeBitmexInstrument(payload, { symbol, receivedAt: this.now() });
      this.#emit(statusId, 'bitmex', metadata);
      this.#setStatus(statusId, { state: metadata.assets.length ? 'snapshot' : 'unavailable', attempt: 0, nextRetryAt: null, lastSuccess: this.now(), lastError: metadata.assets.length ? null : 'BitMEX instrument metadata was empty' });
      return metadata;
    } catch (error) {
      if (requestGeneration !== this.configurationGeneration) return null;
      this.#setStatus(statusId, { state: 'unavailable', attempt: 0, nextRetryAt: null, lastError: feedError(error).message ?? String(error) });
      return null;
    }
  }

  async syncCryptocomMetadata({ symbol = 'BTCUSD-PERP' }: AdapterOptions = {}) {
    const requestGeneration = this.configurationGeneration;
    const statusId = 'cryptocom-metadata';
    if (!this.networkEnabled || !this.restTransport?.request) { this.#setStatus(statusId, { state: 'disabled', attempt: 0, nextRetryAt: null }); return null; }
    this.#setStatus(statusId, { state: 'connecting', attempt: 0, nextRetryAt: null, lastError: null });
    try {
      const payload = await this.#requestRest(buildCryptocomRequest('instrument', { instrumentName: String(symbol ?? '') }), 'cryptocom');
      if (requestGeneration !== this.configurationGeneration) return null;
      const metadata = normalizeCryptocomInstrument(payload, { instrumentName: String(symbol ?? ''), receivedAt: this.now() });
      this.#emit(statusId, 'cryptocom', metadata);
      this.#setStatus(statusId, { state: metadata.assets.length ? 'snapshot' : 'unavailable', attempt: 0, nextRetryAt: null, lastSuccess: this.now(), lastError: metadata.assets.length ? null : 'Crypto.com instrument metadata was empty' });
      return metadata;
    } catch (error) {
      if (requestGeneration !== this.configurationGeneration) return null;
      this.#setStatus(statusId, { state: 'unavailable', attempt: 0, nextRetryAt: null, lastError: feedError(error).message ?? String(error) });
      return null;
    }
  }

  async syncBitstampMetadata({ symbol = 'btcusd' }: AdapterOptions = {}) {
    const requestGeneration = this.configurationGeneration;
    const statusId = 'bitstamp-metadata';
    if (!this.networkEnabled || !this.restTransport?.request) { this.#setStatus(statusId, { state: 'disabled', attempt: 0, nextRetryAt: null }); return null; }
    this.#setStatus(statusId, { state: 'connecting', attempt: 0, nextRetryAt: null, lastError: null });
    try {
      const payload = await this.#requestRest(buildBitstampRequest('markets'), 'bitstamp');
      if (requestGeneration !== this.configurationGeneration) return null;
      const metadata = normalizeBitstampTradingPairs(payload, { symbol, receivedAt: this.now() });
      this.#emit(statusId, 'bitstamp', metadata);
      this.#setStatus(statusId, { state: metadata.assets.length ? 'snapshot' : 'unavailable', attempt: 0, nextRetryAt: null, lastSuccess: this.now(), lastError: metadata.assets.length ? null : 'Bitstamp trading-pairs metadata was empty' });
      return metadata;
    } catch (error) {
      if (requestGeneration !== this.configurationGeneration) return null;
      this.#setStatus(statusId, { state: 'unavailable', attempt: 0, nextRetryAt: null, lastError: feedError(error).message ?? String(error) });
      return null;
    }
  }

  async syncWhitebitMetadata({ symbol = 'BTC_USDT' }: AdapterOptions = {}) {
    const requestGeneration = this.configurationGeneration;
    const statusId = 'whitebit-metadata';
    if (!this.networkEnabled || !this.restTransport?.request) { this.#setStatus(statusId, { state: 'disabled', attempt: 0, nextRetryAt: null }); return null; }
    this.#setStatus(statusId, { state: 'connecting', attempt: 0, nextRetryAt: null, lastError: null });
    try {
      const payload = await this.#requestRest(buildWhitebitRequest('markets'), 'whitebit');
      if (requestGeneration !== this.configurationGeneration) return null;
      const metadata = normalizeWhitebitMarkets(payload, { symbol, receivedAt: this.now() });
      if (!this.#publishVenueMetadata(statusId, metadata, () => { this.whitebitMetadata = metadata; })) return null;
      this.#setStatus(statusId, { state: metadata.assets.length ? 'snapshot' : 'unavailable', attempt: 0, nextRetryAt: null, lastSuccess: this.now(), lastError: metadata.assets.length ? null : 'WhiteBIT markets metadata was empty' });
      return metadata;
    } catch (error) {
      if (requestGeneration !== this.configurationGeneration) return null;
      this.whitebitMetadata = null;
      this.#setStatus(statusId, { state: 'unavailable', attempt: 0, nextRetryAt: null, lastError: feedError(error).message ?? String(error) });
      return null;
    }
  }

  async syncPhemexMetadata({ symbol = 'sBTCUSDT' }: AdapterOptions = {}) {
    const requestGeneration = this.configurationGeneration;
    const statusId = 'phemex-metadata';
    if (!this.networkEnabled || !this.restTransport?.request) { this.#setStatus(statusId, { state: 'disabled', attempt: 0, nextRetryAt: null }); return null; }
    this.#setStatus(statusId, { state: 'connecting', attempt: 0, nextRetryAt: null, lastError: null });
    try {
      const payload = await this.#requestRest(buildPhemexRequest('products', { symbol }), 'phemex');
      if (requestGeneration !== this.configurationGeneration) return null;
      const metadata = normalizePhemexProducts(payload, { symbol, receivedAt: this.now() });
      const committed = this.#publishVenueMetadata(statusId, metadata, () => {
        this.phemexMetadata = metadata;
        const spec = this.specs.get('phemex-depth');
        const asset = metadata.assets.find(item => String(item.nativeSymbol).toUpperCase() === String(symbol).toUpperCase());
        if (spec && asset) spec.request = { ...spec.request, metadata: asset };
      });
      if (!committed) return null;
      this.#setStatus(statusId, { state: metadata.assets.length ? 'snapshot' : 'unavailable', attempt: 0, nextRetryAt: null, lastSuccess: this.now(), lastError: metadata.assets.length ? null : 'Phemex products metadata was empty' });
      return metadata;
    } catch (error) {
      if (requestGeneration !== this.configurationGeneration) return null;
      this.phemexMetadata = null;
      this.#setStatus(statusId, { state: 'unavailable', attempt: 0, nextRetryAt: null, lastError: feedError(error).message ?? String(error) });
      return null;
    }
  }

  async syncDydxMetadata({ symbol = 'BTC-USD' }: AdapterOptions = {}) {
    const requestGeneration = this.configurationGeneration;
    const statusId = 'dydx-metadata';
    if (!this.networkEnabled || !this.restTransport?.request) { this.#setStatus(statusId, { state: 'disabled', attempt: 0, nextRetryAt: null }); return null; }
    this.#setStatus(statusId, { state: 'connecting', attempt: 0, nextRetryAt: null, lastError: null });
    try {
      const payload = await this.#requestRest(buildDydxRequest('perpetualMarkets'), 'dydx');
      if (requestGeneration !== this.configurationGeneration) return null;
      const metadata = normalizeDydxMarkets(payload, { symbol, receivedAt: this.now() });
      if (!this.#publishVenueMetadata(statusId, metadata, () => { this.dydxMetadata = metadata; })) return null;
      this.#setStatus(statusId, { state: metadata.assets.length ? 'snapshot' : 'unavailable', attempt: 0, nextRetryAt: null, lastSuccess: this.now(), lastError: metadata.assets.length ? null : 'dYdX perpetualMarkets metadata was empty' });
      return metadata;
    } catch (error) {
      if (requestGeneration !== this.configurationGeneration) return null;
      this.dydxMetadata = null;
      this.#setStatus(statusId, { state: 'unavailable', attempt: 0, nextRetryAt: null, lastError: feedError(error).message ?? String(error) });
      return null;
    }
  }

  async syncAsterMetadata({ symbol = 'BTCUSDT' }: AdapterOptions = {}) {
    const requestGeneration = this.configurationGeneration;
    const statusId = 'aster-metadata';
    if (!this.networkEnabled || !this.restTransport?.request) { this.#setStatus(statusId, { state: 'disabled', attempt: 0, nextRetryAt: null }); return null; }
    this.#setStatus(statusId, { state: 'connecting', attempt: 0, nextRetryAt: null, lastError: null });
    try {
      const payload = await this.#requestRest(buildAsterRequest('exchangeInfo'), 'aster');
      if (requestGeneration !== this.configurationGeneration) return null;
      const metadata = normalizeAsterMarkets(payload, { symbol, receivedAt: this.now() });
      if (!this.#publishVenueMetadata(statusId, metadata, () => { this.asterMetadata = metadata; })) return null;
      this.#setStatus(statusId, { state: metadata.assets.length ? 'snapshot' : 'unavailable', attempt: 0, nextRetryAt: null, lastSuccess: this.now(), lastError: metadata.assets.length ? null : 'Aster exchangeInfo metadata was empty' });
      return metadata;
    } catch (error) {
      if (requestGeneration !== this.configurationGeneration) return null;
      this.asterMetadata = null;
      this.#setStatus(statusId, { state: 'unavailable', attempt: 0, nextRetryAt: null, lastError: feedError(error).message ?? String(error) });
      return null;
    }
  }

  async syncBinanceDepth({ symbol = 'BTCUSDT', marketType = 'perpetual', family = 'usdm', metadata = this.specs.get('binance-depth')?.metadata, limit = 1000 }: AdapterOptions = {}) {
    if (!this.networkEnabled || !this.restTransport?.request) return null;
    // Bind the REST snapshot to the feed that requested it. A reconnect can
    // install a newer socket and sequence while an older HTTP response is
    // still in flight; that response must not publish stale state afterward.
    const requestFeed = this.feeds.get('binance-depth');
    const requestGeneration = requestFeed?.generation ?? null;
    const isCurrent = () => this.#isCurrentBinanceDepthFeed(requestFeed, requestGeneration);
    try {
      const request = buildBinanceRequest('depth', { symbol, marketType, family, metadata, limit });
      const payload = await this.#requestRest(request, 'binance', `${restRequestKey(request, 'binance')}|feed-generation=${requestGeneration ?? 'none'}`);
      if (!isCurrent()) return null;
      const message = normalizeBinanceDepth(payload, { symbol, marketType, family, metadata, receivedAt: this.now() });
      const emitted = this.#emit('binance-depth', 'binance', message);
      if (emitted === false) {
        const reason = 'server rejected Binance depth snapshot admission';
        this.#invalidateBinanceDepth('binance-depth', { symbol: String(symbol ?? ''), marketType, family }, reason);
        this.#setStatus('binance-depth', { state: 'unavailable', attempt: 0, nextRetryAt: null, lastError: reason });
        return null;
      }
      const bridged = this.#replayBinanceDepth({ symbol, marketType, family, metadata }, message);
      if (bridged === null || bridged === 'admission-denied') {
        const reason = bridged === 'admission-denied'
          ? 'server rejected Binance depth bridge admission'
          : 'depth bridge gap; fresh snapshot required';
        this.#invalidateBinanceDepth('binance-depth', { symbol: String(symbol ?? ''), marketType, family }, reason);
        this.#setStatus('binance-depth', { state: 'unavailable', attempt: 0, nextRetryAt: null, lastError: reason });
        return null;
      }
      this.#setStatus('binance-depth', { state: bridged ? 'live' : 'snapshot', attempt: 0, nextRetryAt: null, lastSuccess: this.now(), lastError: null });
      return message;
    } catch (error) {
      if (!isCurrent()) return null;
      this.#setStatus('binance-depth', { state: 'unavailable', attempt: 0, nextRetryAt: null, lastError: feedError(error).message ?? String(error) });
      return null;
    }
  }

  /** Fetch a bounded public OHLC window and emit normalized history rows. */
  async syncCandleHistory({ venue = 'hyperliquid', coin = 'BTC', nativeCoin, symbol = 'BTCUSDT', marketType = 'perpetual', family = 'usdm', metadata = this.specs.get('binance-kline')?.metadata, interval = this.candleInterval, limit = this.candleHistoryLimit, startTime, endTime = this.now() }: AdapterOptions & { nativeCoin?: string } = {}) {
    const requestGeneration = this.configurationGeneration;
    const isHyperliquid = venue === 'hyperliquid';
    const currentNativeCoin = feedRecord(this.specs.get('hl-candle')?.request.subscription).coin;
    const selectedNativeCoin = isHyperliquid ? hyperliquidNativeCoin(coin, nativeCoin ?? (typeof currentNativeCoin === 'string' && hyperliquidCoin(currentNativeCoin) === hyperliquidCoin(coin) ? currentNativeCoin : undefined)) : null;
    const statusId = isHyperliquid ? 'hl-candle-history' : 'binance-kline-history';
    if (!this.networkEnabled || !this.restTransport?.request) { this.#setStatus(statusId, { state: 'disabled', attempt: 0, nextRetryAt: null }); return []; }
    let requestedInterval;
    try { requestedInterval = assertSupportedCandleInterval(interval); } catch (error) { this.#setStatus(statusId, { state: 'unavailable', attempt: 0, nextRetryAt: null, lastError: feedError(error).message }); return []; }
    const intervalMs = intervalMilliseconds(requestedInterval);
    if (!(intervalMs !== null && intervalMs > 0)) { this.#setStatus(statusId, { state: 'unavailable', attempt: 0, nextRetryAt: null, lastError: 'candle interval has no valid duration' }); return []; }
    // Explicit interval requests retain the adapter's native-history behavior
    // for callers; live startup always requests NATIVE_CANDLE_INTERVAL.
    const cappedLimit = Math.max(1, Math.min(isHyperliquid ? 5_000 : 1_500, Math.trunc(Number(limit) || this.candleHistoryLimit)));
    const end = Number.isFinite(Number(endTime)) ? Math.trunc(Number(endTime)) : this.now();
    const start = Number.isFinite(Number(startTime)) ? Math.trunc(Number(startTime)) : end - cappedLimit * intervalMs;
    if (!(end > start)) { this.#setStatus(statusId, { state: 'unavailable', attempt: 0, nextRetryAt: null, lastError: 'candle history end must be after start' }); return []; }
    const request = isHyperliquid
      ? buildHyperliquidInfoRequest('candleSnapshot', { coin, nativeCoin: selectedNativeCoin ?? undefined, interval: requestedInterval, startTime: start, endTime: end })
      : buildBinanceRequest('klines', { symbol, marketType, family, metadata, interval: requestedInterval, startTime: start, endTime: end, limit: cappedLimit });
    this.#setStatus(statusId, { state: 'loading', attempt: 0, nextRetryAt: null, lastError: null });
    try {
      const candleVenue = isHyperliquid ? 'hyperliquid' : 'binance';
      const payload = await this.#requestRest(request, candleVenue, `${restRequestKey(request, candleVenue)}|configuration=${requestGeneration}`);
      // A later start/stop changes the selected market or source. The old
      // response may still be useful to the transport, but it must not emit
      // rows or overwrite the newer status.
      if (requestGeneration !== this.configurationGeneration) return [];
      const rows = extractCandleRows(payload);
      const receivedAt = this.now();
      const candles = [];
      for (const row of rows) {
        try {
          if (isHyperliquid && selectedNativeCoin !== hyperliquidCoin(coin) && (feedRecord(row).s ?? feedRecord(row).coin) !== selectedNativeCoin) continue;
          if (!candleMatchesInterval(Array.isArray(row) ? feedArray(row) : feedRecord(row), requestedInterval)) continue;
          const candle = isHyperliquid
            ? normalizeHyperliquidCandle(row, { coin, interval: requestedInterval, receivedAt })
            : normalizeBinanceKline(row, { symbol, marketType, family, metadata, interval: requestedInterval, receivedAt });
          if (candle.start < start || candle.start >= end) continue;
          // The response may arrive after a forming row's end timestamp. Use
          // the request cutoff as provenance; arrival time alone must not turn
          // an open REST row into a finalized candle.
          const message = { kind: 'candle', ...candle, source: 'history', quality: 'native', closed: candle.closed ?? candle.end <= end };
          if (requestGeneration !== this.configurationGeneration) return [];
          this.#emit(statusId, isHyperliquid ? 'hyperliquid' : 'binance', message);
          candles.push(message);
        } catch {
          // One malformed exchange row must not discard the usable history window.
        }
      }
      this.#setStatus(statusId, { state: candles.length ? 'live' : 'unavailable', attempt: 0, nextRetryAt: null, lastSuccess: candles.length ? receivedAt : undefined, lastError: candles.length ? null : 'candle history response was empty or malformed' });
      return candles;
    } catch (error) {
      if (requestGeneration !== this.configurationGeneration) return [];
      this.#setStatus(statusId, { state: 'unavailable', attempt: 0, nextRetryAt: null, lastError: feedError(error).message ?? String(error) });
      return [];
    }
  }

  #requestRest(request: RequestDescriptor, venue: string, key: string = restRequestKey(request, venue)) {
    if (!this.rest && !this.restTransport) throw new AdapterTransportError('Exchange REST transport unavailable');
    const pending = this.rest ? this.rest.request(request, { venue, key }) : this.restTransport!.request(exchangeRestRequest(request));
    if (!this.running) return pending;
    this.retainedDiagnosticsCache = null;
    return this.#operationScope.wait(pending).finally(() => { this.retainedDiagnosticsCache = null; });
  }

  #statuses = new Map<string, LiveFeedStatus>();
  #setStatus(id: string, patch: unknown) {
    const statusId = typeof id === 'string' ? id.trim() : '';
    if (!statusId || statusId.length > LIVE_FEED_MANAGER_STATUS_ID_LIMIT) return false;
    const storedPrevious = this.#statuses.get(statusId) ?? null;
    const previous: LiveFeedStatus = storedPrevious ?? { state: 'stopped', attempt: 0, nextRetryAt: null };
    let next: LiveFeedStatus = { ...previous, ...boundedManagerStatusPatch(patch) };
    // The exact counter already belongs to the measured feed. A timestamp-only
    // publication must include its latest value without retaining a pending row.
    const transportMessages = this.feeds.get(statusId)?.transportMessages;
    if (typeof transportMessages === 'number' && Number.isSafeInteger(transportMessages) && transportMessages >= 0)
      next.transportMessages = transportMessages;
    const changed = managerStatusChangedFields(previous, next);
    if (storedPrevious && changed.length && changed.every((key) => LIVE_FEED_MANAGER_STATUS_FRESHNESS_FIELDS.has(key))) {
      let freshnessDue = false;
      let telemetryTransition = false;
      for (const key of changed) {
        const currentValue = next[key];
        const previousValue = previous[key];
        if (key === 'transportMessages') {
          // Counts have no time unit. Initial/reset/invalid counters publish now.
          if (typeof currentValue !== 'number' || !Number.isSafeInteger(currentValue) || currentValue < 0
            || typeof previousValue !== 'number' || !Number.isSafeInteger(previousValue) || previousValue < 0
            || currentValue < previousValue) telemetryTransition = true;
        } else if (typeof currentValue === 'number' && typeof previousValue === 'number') {
          if (currentValue < previousValue) telemetryTransition = true;
          else if (currentValue - previousValue >= LIVE_FEED_MANAGER_STATUS_FRESHNESS_INTERVAL_MS) freshnessDue = true;
        } else telemetryTransition = true;
      }
      if (!telemetryTransition && !freshnessDue) return true;
    }
    if (managerStatusChangedFields(previous, next).length === 0) return true;

    const nextStatuses = new Map(this.#statuses);
    nextStatuses.set(statusId, next);
    const entryBytes = logicalRetainedBytes({ id: statusId, ...next });
    const mapBytes = logicalRetainedBytes(nextStatuses);
    let rejectionHandled = false;
    const reject = (_reservation?: unknown) => {
      if (rejectionHandled) return false;
      rejectionHandled = true;
      const beforeStatusBytes = logicalRetainedBytes(this.#statuses);
      const failureAttempt = typeof next.attempt === 'number' && Number.isSafeInteger(next.attempt) && next.attempt >= 0 ? next.attempt : null;
      const failClosedStatus = storedPrevious
        ? { state: 'unavailable', stale: true, ...(failureAttempt === null ? {} : { attempt: failureAttempt }) }
        : null;
      if (failClosedStatus) {
        const failClosedStatuses = new Map(this.#statuses);
        failClosedStatuses.set(statusId, failClosedStatus);
        if (logicalRetainedBytes(failClosedStatuses) <= beforeStatusBytes) this.#statuses = failClosedStatuses;
        else this.#statuses.delete(statusId);
      } else this.#statuses.delete(statusId);
      this.retainedDiagnosticsCache = null;
      this.onStatus({
        id: statusId,
        state: 'unavailable',
        active: false,
        attempt: failureAttempt ?? (typeof previous.attempt === 'number' && Number.isSafeInteger(previous.attempt) && previous.attempt >= 0 ? previous.attempt : 0),
        nextRetryAt: null,
        lastError: 'retained-data admission rejected',
      });
      return false;
    };
    const commit = () => {
      this.#statuses = nextStatuses;
      this.retainedDiagnosticsCache = null;
      this.onStatus({ id: statusId, ...cloneManagerStatusValue(next) });
      return true;
    };
    const overLocalLimit = (!storedPrevious && this.#statuses.size >= LIVE_FEED_MANAGER_STATUS_MAX_ENTRIES)
      || entryBytes > LIVE_FEED_MANAGER_STATUS_ENTRY_MAX_BYTES
      || mapBytes > LIVE_FEED_MANAGER_STATUS_MAP_MAX_BYTES;
    if (overLocalLimit) return reject({ reason: 'manager-status-limit' });
    if (!this.retainedAdmission) {
      commit();
      return true;
    }
    const spec = this.specs.get(statusId);
    const context = {
      kind: 'live-feed-status-map',
      venue: spec?.venue ?? statusId.split('-')[0] ?? 'unknown',
      feedId: statusId,
    };
    let result;
    try {
      result = this.retainedAdmission({ managerStatuses: nextStatuses }, context, commit, reject);
    } catch {
      reject({ reason: 'admission-error' });
      return false;
    }
    if (result?.admitted === true) return true;
    if (!rejectionHandled) reject(result?.reservation ?? result);
    return false;
  }
  #getStatus(id: string) { return this.#statuses.get(id) ?? { state: 'stopped', attempt: 0, nextRetryAt: null }; }

  #isCurrentBinanceDepthFeed(feed: LiveFeed | null | undefined, generation: number | null | undefined) {
    return !feed || (
      this.running
      && this.feeds.get('binance-depth') === feed
      && !feed.retired
      && feed.generation === generation
      && this.feedGenerations.get('binance-depth') === generation
    );
  }

  #retireFeed(id: string) {
    const feed = this.feeds.get(id);
    const spec = feed?.spec ?? this.specs.get(id);
    if (feed?.retry !== null && feed?.retry !== undefined) this.cancel(feed.retry);
    if (feed) {
      try { const frame = venueControlFrame(spec?.venue ?? 'unknown', spec?.request, 'unsubscribe', { now: this.now() }); if (frame) this.#sendControlFrameBestEffort(feed, frame); } catch { /* unsubscribe is best effort */ }
      feed.retired = true;
      this.#releaseTransport(feed);
      retireLiveFeedSocket(feed.socket);
      feed.socket = null; feed.session = null;
    }
    if (spec?.venue === 'binance' && spec.channel === 'depth' && spec.symbol) this.#deleteResyncing(binanceInstrumentId(spec.symbol, spec.marketType, spec.family));
    this.feedGenerations.set(id, (this.feedGenerations.get(id) ?? feed?.generation ?? 0) + 1);
    this.feeds.delete(id);
    const instrumentId = spec?.instrumentId;
    const activeBookKeys = instrumentId ? [...this.specs.entries()].filter(([otherId, other]) => otherId !== id && other.instrumentId === instrumentId && other.bookKey).map(([, other]) => other.bookKey) : undefined;
    this.#setStatus(id, { state: 'stopped', active: false, nextRetryAt: null, ...(instrumentId ? { instrumentId, activeBookKeys } : {}) });
  }

  async #open(id: string, spec: LiveFeedSpec) {
    if (!this.running) return;
    if (spec.venue === 'kucoin' && spec.request?.transportReady !== true) { this.#setStatus(id, { state: 'unavailable', attempt: 0, nextRetryAt: null, lastError: 'KuCoin public websocket token unavailable' }); return; }
    const generation = (this.feedGenerations.get(id) ?? 0) + 1;
    this.feedGenerations.set(id, generation);
    const previous = this.#getStatus(id);
    const connectingAdmitted = this.#setStatus(id, { state: 'connecting', attempt: previous.attempt ?? 0, nextRetryAt: null, lastError: null, active: true, generation });
    if (!this.running || this.feedGenerations.get(id) !== generation || this.specs.get(id) !== spec) return false;
    if (!connectingAdmitted) {
      // Denied status ownership cannot authorize connection quota or a transport.
      this.#scheduleReconnect(id, { unavailable: true });
      return false;
    }
    let socket: LiveFeedSocket | null = null;
    let feed: LiveFeed | null = null;
    let connectionAcquired = false;
    try {
      this.transportBudget.acquireConnection(spec.venue);
      connectionAcquired = true;
      if (!this.transportFactory) throw new AdapterTransportError('Live feed transport unavailable');
      const operationScope = this.#operationScope;
      socket = await operationScope.wait(this.transportFactory({ id, venue: spec.venue, channel: spec.channel, marketType: spec.marketType, request: spec.request, instrumentId: spec.instrumentId, resolutionKey: spec.resolutionKey, bookKey: spec.bookKey }), { onLateValue: retireLiveFeedSocket });
      if (!this.running || this.feedGenerations.get(id) !== generation || this.specs.get(id) !== spec) { if (connectionAcquired) this.transportBudget.releaseConnection(spec.venue); retireLiveFeedSocket(socket); return; }
      const sessionToken = spec.publicDepth ? `${id}:${++this.sessionCounter}` : undefined;
      const heartbeatPolicies = spec.venue === 'kucoin' ? {
        ...this.transportPolicies,
        kucoin: {
          ...(this.transportPolicies.kucoin ?? {}),
          ...(Number.isFinite(Number(spec.request?.pingIntervalMs)) ? { heartbeatIntervalMs: Number(spec.request.pingIntervalMs) } : {}),
          ...(Number.isFinite(Number(spec.request?.heartbeatTimeoutMs)) ? { heartbeatTimeoutMs: Number(spec.request.heartbeatTimeoutMs) } : {}),
        },
      } : this.transportPolicies;
      feed = { id, socket, spec, generation, configurationGeneration: spec.configurationGeneration, retry: null, retired: false, sessionToken, connectionAcquired, transportReleased: false, subscriptionKey: id, subscriptionAcked: spec.venue === 'binance', preAckFrames: spec.venue === 'bybit' ? [] : null, preAckBytes: 0, channelId: null, serverHeartbeat: spec.serverHeartbeat === true || spec.venue === 'binance' || spec.venue === 'bitfinex' || spec.venue === 'cryptocom' || spec.venue === 'bitstamp', heartbeat: new VenueHeartbeatDeadline({ venue: spec.venue, now: this.transportNow, policies: heartbeatPolicies }), heartbeatTimer: null, heartbeatStarted: false, session: spec.venue === 'bybit' ? createBybitDepthSession({ topic: spec.topic, instrumentId: spec.instrumentId, sessionToken }) : spec.venue === 'kraken' ? createKrakenDepthSession({ topic: spec.topic, instrumentId: spec.instrumentId, sessionToken, depth: spec.request.depth == null ? null : Number(spec.request.depth) }) : spec.venue === 'bitfinex' ? createBitfinexDepthSession({ topic: spec.topic, instrumentId: spec.instrumentId, sessionToken }) : spec.venue === 'bitmex' ? createBitmexDepthSession({ topic: spec.topic, instrumentId: spec.instrumentId, sessionToken, table: spec.request.table }) : spec.venue === 'cryptocom' ? createCryptocomDepthSession({ topic: spec.topic, instrumentId: spec.instrumentId, sessionToken, instrumentName: String(spec.request.instrumentName ?? spec.symbol ?? ''), depth: spec.request.depth == null ? null : Number(spec.request.depth) }) : spec.venue === 'phemex' ? createPhemexDepthSession({ topic: spec.topic, instrumentId: spec.instrumentId, sessionToken }) : spec.publicDepth ? createPublicDepthSession({ venue: spec.venue, topic: spec.topic, instrumentId: spec.instrumentId, sessionToken, depth: spec.venue === 'whitebit' ? (spec.request.depth == null ? null : Number(spec.request.depth)) : null, allowUnsequenced: spec.venue === 'kucoin' || spec.venue === 'bitstamp' }) : null };
      connectionAcquired = false;
      this.feeds.set(id, feed);
      this.#bind(socket, id);
      if (socket.open) await operationScope.wait(socket.open());
      if (!this.running || this.feedGenerations.get(id) !== generation || feed.retired || this.feeds.get(id) !== feed || this.specs.get(id) !== spec) { feed.retired = true; this.#releaseTransport(feed); retireLiveFeedSocket(socket); return; }
      if (spec.venue === 'bitfinex' && spec.request?.conf) await this.#sendTransport(feed, spec.request.conf);
      if (spec.venue !== 'kucoin') {
        const subscription = venueControlFrame(spec.venue, spec.request, 'subscribe', { now: this.now() });
        if (subscription) await this.#sendTransport(feed, spec.venue === 'dydx' && spec.publicDepth ? { ...subscription, batched: false } : subscription);
      }
      if (!this.running || this.feedGenerations.get(id) !== generation || feed.retired || this.feeds.get(id) !== feed || this.specs.get(id) !== spec) { feed.retired = true; this.#releaseTransport(feed); retireLiveFeedSocket(socket); return; }
      if (spec.venue === 'binance') this.#markTransportAck(feed, 'url-open');
      const awaitingSnapshot = (spec.venue === 'binance' && spec.channel === 'depth' && this.restTransport?.request) || spec.publicDepth;
      this.#setStatus(id, { state: awaitingSnapshot ? 'snapshot' : 'live', attempt: 0, nextRetryAt: null, lastSuccess: this.now(), lastError: null, subscriptionAcked: feed.subscriptionAcked, serverHeartbeat: feed.serverHeartbeat === true, transportMessages: feed.transportMessages ?? 0, lastObservedAt: feed.heartbeat?.lastObservedAt, lastHeartbeatAt: feed.heartbeat?.lastHeartbeatAt, heartbeatIntervalMs: feed.heartbeat?.policy.heartbeatIntervalMs, heartbeatTimeoutMs: feed.heartbeat?.policy.heartbeatTimeoutMs });
      this.#scheduleHeartbeat(feed);
    } catch (error) {
      if (feed) this.#releaseTransport(feed);
      else if (connectionAcquired) this.transportBudget.releaseConnection(spec.venue);
      if (!this.running || this.feedGenerations.get(id) !== generation || feed?.retired || this.specs.get(id) !== spec) { retireLiveFeedSocket(socket); return; }
      this.#fail(id, error);
    }
  }

  #bind(socket: LiveFeedSocket, id: string) {
    socket.onMessage = raw => this.#message(id, raw, socket);
    socket.onClose = reason => this.#closed(id, reason, socket);
    socket.onError = error => this.#fail(id, error, socket);
    if (typeof socket.on === 'function') {
      socket.on('message', raw => this.#message(id, raw, socket));
      socket.on('close', reason => this.#closed(id, reason, socket));
      socket.on('error', error => this.#fail(id, error, socket));
      // Binance, dYdX and Aster use the WebSocket protocol ping/pong heartbeat. The
      // `ws` client answers server pings automatically, but the manager still
      // needs the control event to refresh its liveness deadline.
      socket.on('ping', () => this.#protocolHeartbeat(id, socket, 'protocol-ping'));
      socket.on('pong', () => this.#protocolHeartbeat(id, socket, 'protocol-pong'));
    }
  }

  #protocolHeartbeat(id: string, socket: LiveFeedSocket | null, source: string) {
    const feed = this.feeds.get(id);
    if (!feed || feed.retired || !['binance', 'dydx', 'aster'].includes(feed.spec?.venue) || !this.#isCurrentTransportFeed(feed) || feed.socket !== socket) return;
    this.#markHeartbeatAck(feed, source);
  }

  #isCurrentTransportFeed(feed: LiveFeed | null | undefined) {
    return Boolean(feed && !feed.retired && this.running && this.feeds.get(feed.id) === feed && this.specs.get(feed.id) === feed.spec && this.feedGenerations.get(feed.id) === feed.generation);
  }

  async #sendTransport(feed: LiveFeed, frame: unknown) {
    if (!this.#isCurrentTransportFeed(feed)) return false;
    const plan = this.transportBudget.planMessage(feed.spec.venue);
    if (plan.delayMs > 0) await this.#operationScope.delay(plan.delayMs);
    if (!this.#isCurrentTransportFeed(feed)) return false;
    const encoded = typeof frame === 'string' ? frame : JSON.stringify(frame);
    feed.socket?.send?.(encoded);
    feed.transportMessages = (feed.transportMessages ?? 0) + 1;
    this.#setStatus(feed.id, { transportMessages: feed.transportMessages, lastTransportSendAt: this.now() });
    return true;
  }

  #sendControlFrameBestEffort(feed: LiveFeed, frame: unknown) {
    if (!feed?.socket || feed.transportReleased) return false;
    const plan = this.transportBudget.planMessage(feed.spec.venue);
    if (plan.delayMs > 0) {
      this.#setStatus(feed.id, { unsubscribeDeferred: true, unsubscribeDelayMs: plan.delayMs });
      return false;
    }
    try {
      feed.socket.send?.(typeof frame === 'string' ? frame : JSON.stringify(frame));
      feed.transportMessages = (feed.transportMessages ?? 0) + 1;
      this.#setStatus(feed.id, { transportMessages: feed.transportMessages, lastTransportSendAt: this.now(), unsubscribeSent: true });
      return true;
    } catch (error) {
      this.#setStatus(feed.id, { unsubscribeError: feedError(error).message ?? String(error) });
      return false;
    }
  }

  #markTransportObserved(feed: LiveFeed) {
    const at = this.transportNow();
    feed.heartbeat?.observe(at);
    if (feed.subscriptionKey) this.transportBudget.touch(feed.spec.venue, feed.subscriptionKey);
    this.#setStatus(feed.id, { lastObservedAt: at });
  }

  #touchTransport(feed: LiveFeed) {
    if (feed?.subscriptionKey) this.transportBudget.touch(feed.spec.venue, feed.subscriptionKey);
  }

  #markTransportAck(feed: LiveFeed, source: string = 'control') {
    this.#markTransportObserved(feed);
    feed.subscriptionAcked = true;
    this.#setStatus(feed.id, { subscriptionAcked: true, subscriptionAckSource: source, lastObservedAt: feed.heartbeat?.lastObservedAt ?? this.transportNow(), lastError: null });
  }

  #bufferBybitPreAck(id: string, feed: LiveFeed, envelope: unknown, socket: LiveFeedSocket | null) {
    // Account UTF-8 JSON serialization of envelopes, not raw socket frames or heap size.
    const bytes = Buffer.byteLength(JSON.stringify(envelope), 'utf8');
    const preAckFrames = feed.preAckFrames;
    if (!preAckFrames) return false;
    if (preAckFrames.length >= BYBIT_PRE_ACK_FRAME_LIMIT || Number(feed.preAckBytes ?? 0) + bytes > BYBIT_PRE_ACK_BYTE_LIMIT) {
      this.#fail(id, new Error('Bybit pre-ack frame buffer limit exceeded'), socket);
      return false;
    }
    const commit = () => {
      preAckFrames.push(envelope);
      feed.preAckBytes = Number(feed.preAckBytes ?? 0) + bytes;
      this.#setStatus(id, { state: 'snapshot', preAckBufferedFrames: preAckFrames.length, preAckBufferedBytes: feed.preAckBytes });
      return true;
    };
    if (!this.#admitRetainedFeedBuffer(id, socket, { kind: 'bybit-pre-ack', envelope, bytes }, commit)) return false;
    return true;
  }

  #admitRetainedFeedBuffer(id: string, socket: LiveFeedSocket | null, candidate: FeedRecord, commit: () => unknown) {
    const feed = this.feeds.get(id);
    return this.#admitRetainedFeedMutation(id, socket, candidate, {
      kind: 'feed-buffer',
      bufferKind: candidate?.kind ?? 'unknown',
      feedId: id,
      instrumentId: candidate?.instrumentId ?? null,
      venue: feed?.spec?.venue ?? String(id).split('-')[0],
    }, commit);
  }

  #admitRetainedFeedMutation(id: string, socket: LiveFeedSocket | null, candidate: FeedRecord, context: MutationContext, commit: () => unknown) {
    if (!this.retainedAdmission) {
      commit();
      return true;
    }
    let result;
    try {
      result = this.retainedAdmission(candidate, context, commit);
    } catch (error) {
      this.#fail(id, error, socket);
      return false;
    }
    if (result?.admitted === true) return true;
    const reason = result?.reservation?.reason ?? feedRecord(result).reason ?? 'required retained-state owner unavailable';
    this.#fail(id, new Error(`retained feed mutation admission rejected: ${reason}`), socket);
    return false;
  }

  #drainBybitPreAck(id: string, feed: LiveFeed, socket: LiveFeedSocket | null) {
    const buffered = feed.preAckFrames ?? [];
    feed.preAckFrames = [];
    feed.preAckBytes = 0;
    for (const envelope of buffered) {
      if (!this.#isCurrentTransportFeed(feed)) break;
      this.#message(id, envelope, socket);
    }
  }

  #markHeartbeatAck(feed: LiveFeed, source: string = 'heartbeat') {
    this.#markTransportObserved(feed);
    this.#setStatus(feed.id, { heartbeatAcked: true, heartbeatAckSource: source, lastObservedAt: feed.heartbeat?.lastObservedAt ?? this.transportNow(), lastError: null });
  }

  async #sendHeartbeat(feed: LiveFeed) {
    if (!this.#isCurrentTransportFeed(feed) || !feed.heartbeat) return false;
    const heartbeat = feed.heartbeat;
    const frame = venueHeartbeatFrame(feed.spec.venue, { now: this.transportNow() });
    if (frame == null) {
      // Binance has no application-level heartbeat frame: only validated data
      // or protocol ping/pong events refresh its liveness deadline. A
      // Bitfinex public book is different: the server sends [chanId, "hb"];
      // do not self-observe a silent socket or the deadline can never fire.
      const at = this.transportNow();
      heartbeat.heartbeatSent(at);
      if (!feed.serverHeartbeat) heartbeat.observe(at);
      this.#setStatus(feed.id, { heartbeatSkipped: true, serverHeartbeat: feed.serverHeartbeat === true, lastHeartbeatAt: at, ...(feed.serverHeartbeat ? {} : { lastObservedAt: at }) });
      return true;
    }
    const sent = await this.#sendTransport(feed, frame);
    if (!sent || !this.#isCurrentTransportFeed(feed)) return false;
    const at = this.transportNow();
    feed.heartbeat.heartbeatSent(at);
    this.#setStatus(feed.id, { lastHeartbeatAt: at, heartbeatSent: true });
    return true;
  }

  #scheduleHeartbeat(feed: LiveFeed) {
    if (!this.#isCurrentTransportFeed(feed) || !feed.heartbeat) return;
    if (feed.heartbeatTimer != null) this.heartbeatCancel(feed.heartbeatTimer);
    const heartbeat = feed.heartbeat;
    const policy = feed.heartbeat.policy;
    const now = this.transportNow();
    const action = heartbeat.nextAction(now);
    const delay = feed.heartbeatStarted ? Math.max(1, Number(action.delayMs) || 1) : Math.max(1, Number(policy.heartbeatIntervalMs) || 1);
    feed.heartbeatStarted = true;
    feed.heartbeatTimer = this.heartbeatSchedule(async () => {
      feed.heartbeatTimer = null;
      if (!this.#isCurrentTransportFeed(feed)) return;
      const current = heartbeat.nextAction(this.transportNow());
      if (current.action === 'reconnect') {
        this.#fail(feed.id, new Error(`transport ${current.reason}`), feed.socket);
        return;
      }
      if (this.transportIdleMs > 0 && feed.subscriptionKey && this.transportBudget.idleSubscriptions(feed.spec.venue, this.transportIdleMs).includes(String(feed.subscriptionKey))) {
        this.#setStatus(feed.id, { state: 'stopped', lastError: 'idle transport retired', nextRetryAt: null });
        this.#retireFeed(feed.id);
        return;
      }
      if (current.action === 'heartbeat') await this.#sendHeartbeat(feed);
      this.#scheduleHeartbeat(feed);
    }, delay);
    if (typeof feed.heartbeatTimer === 'object' && typeof feedRecord(feed.heartbeatTimer).unref === 'function') {
      Reflect.apply(feedRecord(feed.heartbeatTimer).unref as () => unknown, feed.heartbeatTimer, []);
    }
    this.heartbeatTimers.set(feed.id, feed.heartbeatTimer);
  }

  #releaseTransport(feed: LiveFeed | null | undefined) {
    if (!feed || feed.transportReleased) return;
    if (Array.isArray(feed.preAckFrames)) { feed.preAckFrames.length = 0; feed.preAckBytes = 0; }
    if (feed.heartbeatTimer !== null && feed.heartbeatTimer !== undefined) this.heartbeatCancel(feed.heartbeatTimer);
    this.heartbeatTimers.delete(feed.id);
    feed.heartbeatTimer = null;
    if (feed.subscriptionKey) this.transportBudget.removeSubscription(feed.spec.venue, feed.subscriptionKey);
    if (feed.connectionAcquired) this.transportBudget.releaseConnection(feed.spec.venue);
    feed.connectionAcquired = false;
    feed.transportReleased = true;
  }

  #message(id: string, raw: unknown, socket: LiveFeedSocket | null = null) {
    const feed = this.feeds.get(id); if (!feed || feed.retired || feed.configurationGeneration !== this.configurationGeneration || feed.generation !== this.feedGenerations.get(id) || this.specs.get(id) !== feed.spec || (socket && feed.socket !== socket)) return;
    let messageMemoryReservation: ProcessMemoryReservation | null = null;
    const previousMessageMemoryReservation = this.activeMessageMemoryReservation;
    try {
      const rawBytes = liveFeedMessageByteLength(raw);
      const messageLimit = liveFeedMessageLimitBytes(feed.spec);
      if (rawBytes != null && rawBytes > messageLimit) throw liveFeedMessageLimitError('received', messageLimit);
      if (rawBytes !== null && rawBytes > 0 && this.reserveTransientMemory) {
        const compressed = liveFeedMessageIsGzip(raw);
        const initialReservationBytes = compressed ? MAX_LIVE_FEED_MESSAGE_BYTES * 3 : rawBytes * 2;
        let admission;
        try {
          admission = this.reserveTransientMemory(initialReservationBytes, {
            kind: 'live-feed-json-message',
            feedId: id,
            venue: feed.spec.venue,
            channel: feed.spec.channel,
            rawMessageBytes: rawBytes,
            compressed,
          });
        } catch {
          throw liveFeedProcessMemoryError({ reason: 'reservation-error' }, 'before-decode');
        }
        messageMemoryReservation = admission;
        if (admission?.admitted !== true) throw liveFeedProcessMemoryError(admission, 'before-decode');
        if (typeof admission.resize !== 'function' || typeof admission.release !== 'function') {
          throw liveFeedProcessMemoryError({ reason: 'reservation-resize-unavailable' }, 'before-decode');
        }
      }
      this.activeMessageMemoryReservation = messageMemoryReservation;
      const publicDepthVenue = feed.spec.publicDepth === true;
      // Hyperliquid control frames arrive on the same socket as decoded feed
      // data and may be delivered as either text or a Buffer. Decode them
      // before the control-frame checks so a rejected subscription cannot be
      // mistaken for a data payload and leave its budget-owned socket live.
      let envelope: unknown = publicDepthVenue || feed.spec.venue === 'hyperliquid' || feed.spec.venue === 'dydx' || feed.spec.venue === 'aster' ? this.#json(raw, { preserveKrakenDecimals: feed.spec.venue === 'kraken' }) : raw;
      // Bitfinex public books use the server's channel-scoped [chanId, "hb"]
      // frame as their liveness signal. Do not let info, foreign-channel, or
      // malformed frames refresh that deadline before they are validated.
      if (feed.spec.venue !== 'hyperliquid' && feed.spec.venue !== 'binance' && feed.spec.venue !== 'bitfinex' && feed.spec.venue !== 'bitmex' && feed.spec.venue !== 'cryptocom' && feed.spec.venue !== 'bitstamp' && feed.spec.venue !== 'dydx' && feed.spec.venue !== 'aster') this.#markTransportObserved(feed);
      if (feed.spec.venue === 'cryptocom') {
        if (feedRecord(envelope)?.method === 'public/heartbeat') {
          if (feedRecord(envelope)?.code != null && Number(feedRecord(envelope).code) !== 0) throw new Error(`Crypto.com heartbeat rejected: ${feedRecord(envelope).code}`);
          if (feedRecord(envelope)?.id == null || !Number.isSafeInteger(Number(feedRecord(envelope).id))) throw new Error('Crypto.com heartbeat id missing or invalid');
          void this.#sendTransport(feed, { id: feedRecord(envelope).id, method: 'public/respond-heartbeat' }).then(sent => { if (sent) this.#markHeartbeatAck(feed, 'server-heartbeat'); }).catch(error => this.#fail(id, error, socket));
          return;
        }
        const expectedTopic = String(feed.spec.topic);
        if (feedRecord(envelope)?.method === 'subscribe') {
          if (feedRecord(envelope)?.code == null || Number(feedRecord(envelope).code) !== 0) throw new Error(`Crypto.com subscription rejected: ${feedRecord(envelope)?.code ?? 'missing code'}`);
          const result = feedRecord(envelope)?.result;
          if (result == null) {
            // Crypto.com deployments differ: some send a result-less control
            // acknowledgement, while others combine the initial book snapshot
            // with the subscription response. Accept the former only when its
            // request id and channel are exact.
            if (Number(feedRecord(envelope)?.id) !== Number(feed.spec.request?.id)
              || String(feedRecord(envelope)?.channel ?? '') !== expectedTopic) throw new Error('Crypto.com subscription acknowledgement mismatch');
            this.#markTransportAck(feed, 'subscription-response');
            return;
          }
          // Book data frames use the provider sentinel id -1. A request id on
          // a data frame is ambiguous and must not silently make the feed live.
          if (Number(feedRecord(envelope)?.id) !== -1) throw new Error('Crypto.com book data id mismatch');
          if (typeof result !== 'object') throw new Error('Crypto.com subscription result malformed');
          const subscriptionResult = feedRecord(result);
          if (String(subscriptionResult.subscription ?? '') !== expectedTopic
            || String(subscriptionResult.instrument_name ?? '').toUpperCase() !== String(feed.spec.symbol ?? '').toUpperCase()
            || Number(subscriptionResult.depth) !== Number(feed.spec.request?.depth)
            || !['book', 'book.update'].includes(String(subscriptionResult.channel ?? ''))) return;
          if (subscriptionResult.channel === 'book.update' && !feed.subscriptionAcked) return;
          if (subscriptionResult.channel === 'book' && !feed.subscriptionAcked) this.#markTransportAck(feed, 'subscription-response');
          else this.#touchTransport(feed);
        }
      }
      if (feed.spec.venue === 'bitstamp') {
        if (feedRecord(envelope)?.event === 'bts:heartbeat') {
          if (String(feedRecord(feedRecord(envelope)?.data)?.status ?? '').toLowerCase() === 'success') {
            this.#markHeartbeatAck(feed, 'server-heartbeat');
            return;
          }
          void this.#sendTransport(feed, { event: 'bts:heartbeat' }).then(sent => { if (sent) this.#markHeartbeatAck(feed, 'server-heartbeat'); }).catch(error => this.#fail(id, error, socket));
          return;
        }
        if (feedRecord(envelope)?.event === 'bts:request_reconnect') throw new Error('Bitstamp requested reconnect');
        if (feedRecord(envelope)?.event === 'bts:error') throw new Error(`Bitstamp subscription rejected: ${feedRecord(feedRecord(envelope)?.data)?.message ?? feedRecord(envelope)?.data ?? 'unknown error'}`);
        if (feedRecord(envelope)?.event === 'bts:subscription_succeeded') {
          if (String(feedRecord(envelope)?.channel ?? '') !== String(feed.spec.topic ?? '')) return;
          this.#markTransportAck(feed, 'subscription-response');
          return;
        }
        if (String(feedRecord(envelope)?.channel ?? '') !== String(feed.spec.topic ?? '') || String(feedRecord(envelope)?.event ?? '') !== 'data') return;
        if (!feed.subscriptionAcked) return;
      }
      if (feed.spec.venue === 'whitebit') {
        if (feedRecord(envelope)?.error) throw new Error(`WhiteBIT request rejected: ${feedRecord(feedRecord(envelope)?.error).message ?? feedRecord(feedRecord(envelope)?.error).code ?? 'unknown error'}`);
        if (feedRecord(envelope)?.id != null && Number(feedRecord(envelope).id) === Number(feed.spec.request?.id)) {
          if (feedRecord(feedRecord(envelope)?.result)?.status !== 'success') throw new Error('WhiteBIT subscription rejected: missing success status');
          this.#markTransportAck(feed, 'subscription-response');
          return;
        }
        if (feedRecord(envelope)?.id != null && Number(feedRecord(envelope).id) === 0 && feedRecord(envelope)?.result === 'pong') { this.#markHeartbeatAck(feed, 'pong'); return; }
        if (String(feedRecord(envelope)?.method ?? '') !== 'depth_update') return;
        if (feedRecord(envelope)?.id !== null) throw new Error('WhiteBIT depth update id must be null');
        const market = feedRecord(feedRecord(envelope)?.params)?.[2];
        if (market == null || String(market).toUpperCase() !== String(feed.spec.symbol ?? '').toUpperCase()) return;
        if (!feed.subscriptionAcked) return;
      }
      if (feed.spec.venue === 'phemex') {
        if (feedRecord(envelope)?.error) throw new Error(`Phemex request rejected: ${feedRecord(feedRecord(envelope)?.error).message ?? feedRecord(feedRecord(envelope)?.error).code ?? feedRecord(envelope)?.error ?? 'unknown error'}`);
        if (feedRecord(envelope)?.id != null && Number(feedRecord(envelope).id) === Number(feed.spec.request?.id)) {
          if (feedRecord(feedRecord(envelope)?.result)?.status !== 'success') throw new Error('Phemex subscription rejected: missing success status');
          this.#markTransportAck(feed, 'subscription-response');
          return;
        }
        if (feedRecord(envelope)?.id != null && Number(feedRecord(envelope).id) === 0 && feedRecord(envelope)?.result === 'pong') { this.#markHeartbeatAck(feed, 'pong'); return; }
        if (!['snapshot', 'incremental'].includes(String(feedRecord(envelope)?.type ?? '').toLowerCase())) return;
        if (String(feedRecord(envelope)?.symbol ?? '').toUpperCase() !== String(feed.spec.symbol ?? '').toUpperCase()) return;
        if (!feed.subscriptionAcked) return;
      }
      if (feed.spec.venue === 'dydx') {
        if (feedRecord(envelope)?.type === 'error') { const error = new Error(`dYdX subscription rejected: ${feedRecord(envelope)?.message ?? feedRecord(envelope)?.error ?? 'unknown error'}`); Object.assign(error, { transportFatal: true }); throw error; }
        if (feedRecord(envelope)?.type === 'connected') { this.#markTransportObserved(feed); return; }
        if (feedRecord(envelope)?.type === 'subscribed') {
          if (String(feedRecord(envelope)?.channel ?? '') !== String(feed.spec.channel ?? '') || String(feedRecord(envelope)?.id ?? '') !== String(feed.spec.symbol ?? '')) return;
          this.#markTransportAck(feed, 'subscription-response');
        } else if (feedRecord(envelope)?.type === 'channel_data') {
          if (String(feedRecord(envelope)?.channel ?? '') !== String(feed.spec.channel ?? '') || String(feedRecord(envelope)?.id ?? '') !== String(feed.spec.symbol ?? '')) return;
          if (!feed.subscriptionAcked) return;
          this.#markTransportObserved(feed);
        } else return;
      }
      if (feed.spec.venue === 'aster') {
        if (feedRecord(envelope)?.code != null || feedRecord(envelope)?.error != null) { const error = new Error(`Aster subscription rejected: ${feedRecord(envelope)?.msg ?? feedRecord(envelope)?.error ?? feedRecord(envelope)?.code ?? 'unknown error'}`); Object.assign(error, { transportFatal: true }); throw error; }
        if (feedRecord(envelope)?.result === null) {
          if (String(feedRecord(envelope)?.id ?? '') !== String(feed.spec.request?.id ?? '')) return;
          this.#markTransportAck(feed, 'subscription-response'); return;
        }
        const expectedStream = String(feed.spec.topic ?? '').toLowerCase();
        const hasStream = envelope != null && Object.prototype.hasOwnProperty.call(envelope, 'stream');
        const hasData = envelope != null && Object.prototype.hasOwnProperty.call(envelope, 'data');
        if (hasStream !== hasData) return;
        if (hasStream && String(feedRecord(envelope).stream).toLowerCase() !== expectedStream) return;
        if (hasStream && (feedRecord(envelope).data == null || typeof feedRecord(envelope).data !== 'object' || Array.isArray(feedRecord(envelope).data))) return;
        const data = hasStream ? feedRecord(envelope).data : envelope;
        if (String(feedRecord(data)?.e ?? '') !== (feed.spec.publicDepth ? 'depthUpdate' : 'aggTrade')) return;
        if (String(feedRecord(data)?.s ?? '').toUpperCase() !== String(feed.spec.symbol ?? '').toUpperCase()) return;
        if (!feed.subscriptionAcked) return;
        this.#markTransportObserved(feed);
      }
      if (feed.spec.venue === 'hyperliquid' && feedRecord(envelope)?.channel === 'pong') { this.#markHeartbeatAck(feed); return; }
      if (feed.spec.venue === 'hyperliquid' && feedRecord(envelope)?.channel === 'subscriptionResponse') {
        if (feedRecord(feedRecord(envelope)?.data)?.error) { const error = new Error(`Hyperliquid subscription rejected: ${feedRecord(feedRecord(envelope).data).error}`); Object.assign(error, { transportFatal: true }); throw error; }
        if (matchesHyperliquidSubscriptionResponse(envelope, feed.spec.request)) this.#markTransportAck(feed, 'subscription-response');
        return;
      }
      if (feed.spec.venue === 'hyperliquid' && (feedRecord(envelope)?.channel === 'error' || feedRecord(envelope)?.error)) { const error = new Error(`Hyperliquid subscription rejected: ${feedRecord(feedRecord(envelope)?.error).message ?? feedRecord(envelope)?.error ?? 'unknown error'}`); Object.assign(error, { transportFatal: true }); throw error; }
      if (feed.spec.venue === 'hyperliquid') {
        if (!matchesHyperliquidSubscriptionData(envelope, feed.spec.request)) return;
        this.#markTransportObserved(feed);
      }
      if (feed.spec.venue === 'bybit' && feedRecord(envelope)?.op === 'pong') { this.#markTransportAck(feed, 'heartbeat'); return; }
      if (feed.spec.venue === 'bybit' && (feedRecord(envelope)?.op === 'ping' || feedRecord(envelope)?.op === 'auth')) return;
      if (feed.spec.venue === 'bybit' && feedRecord(envelope)?.op === 'subscribe') {
        if (feedRecord(envelope).success === false || (feedRecord(envelope).retCode != null && Number(feedRecord(envelope).retCode) !== 0)) throw new Error(`Bybit subscription rejected: ${feedRecord(envelope).ret_msg ?? feedRecord(envelope).retMsg ?? feedRecord(envelope).retCode ?? 'unknown error'}`);
        if (feedRecord(envelope).success !== true) return;
        const expectedTopics = feedArray(feed.spec.request?.args);
        if (Array.isArray(feedRecord(envelope).args) && (feedArray(feedRecord(envelope).args).length !== expectedTopics.length || feedArray(feedRecord(envelope).args).some((topic, index) => String(topic) !== String(expectedTopics[index])))) return;
        const successTopics = feedRecord(feedRecord(envelope).data)?.successTopics;
        const failTopics = feedRecord(feedRecord(envelope).data)?.failTopics;
        if (Array.isArray(failTopics) && failTopics.length) throw new Error(`Bybit subscription rejected: ${failTopics.join(', ')}`);
        if (Array.isArray(successTopics) && expectedTopics.some(topic => !successTopics.some(value => String(value) === String(topic)))) return;
        this.#markTransportAck(feed, 'subscription-response');
        this.#drainBybitPreAck(id, feed, socket);
        return;
      }
      if (feed.spec.venue === 'bybit' && feedRecord(envelope)?.success === false) throw new Error(`Bybit subscription rejected: ${feedRecord(envelope).ret_msg ?? feedRecord(envelope).retMsg ?? 'unknown error'}`);
      if (feed.spec.venue === 'bybit' && feedRecord(envelope)?.topic !== feed.spec.topic) return;
      if (feed.spec.venue === 'bybit') {
        const wireSymbol = feedRecord(feedRecord(envelope)?.data)?.s;
        const expectedSymbol = String(feed.spec.symbol ?? '').replaceAll('-', '').toUpperCase();
        if (wireSymbol == null || String(wireSymbol).replaceAll('-', '').toUpperCase() !== expectedSymbol) return;
        // Some public sessions send their first snapshot before the subscribe
        // response. Keep only verified topic/symbol frames in a strict bounded
        // queue, then replay them through the same session reducer after ACK.
        if (!feed.subscriptionAcked) { this.#bufferBybitPreAck(id, feed, envelope, socket); return; }
      }
      if (feed.spec.venue === 'binance') {
        const payload = this.#json(envelope);
        envelope = payload;
        const data = feedRecord(payload)?.data ?? payload;
        const expectedStream = String(feed.spec.request?.stream ?? '').toLowerCase();
        const actualStream = feedRecord(payload)?.stream == null ? null : String(feedRecord(payload).stream).toLowerCase();
        const depthAlternate = feed.spec.channel === 'depth' && actualStream != null && (
          actualStream === expectedStream.replace('@100ms', '') || expectedStream === actualStream.replace('@100ms', '')
        );
        if (actualStream != null && actualStream !== expectedStream && !depthAlternate) return;
        const wireSymbol = feedRecord(data)?.s ?? feedRecord(data)?.symbol ?? feedRecord(feedRecord(data)?.k)?.s;
        const expectedSymbol = String(feed.spec.symbol ?? '').toUpperCase();
        if (wireSymbol == null || String(wireSymbol).toUpperCase() !== expectedSymbol) return;
        if (feed.spec.channel === 'depth' && feed.spec.marketType !== 'spot') {
          if (feedRecord(data)?.st != null && (typeof feedRecord(data).st !== 'number' || !Number.isSafeInteger(feedRecord(data).st) || feedRecord(data).st !== (feed.spec.family === 'coinm' ? 2 : 1))) return;
          const pairSymbol = feedRecord(data).ps;
          const expectedPair = feed.spec.family === 'coinm' ? feed.spec.metadata?.pair : expectedSymbol;
          if (pairSymbol != null && (typeof pairSymbol !== 'string' || pairSymbol.toUpperCase() !== expectedPair)) return;
        }
        const event = String(feedRecord(data)?.e ?? '');
        const allowedEvents = feed.spec.channel === 'depth' ? ['depthUpdate'] : feed.spec.channel === 'markPrice' ? (feed.spec.marketType === 'spot' ? ['trade'] : ['markPriceUpdate']) : feed.spec.channel === 'aggTrade' ? ['aggTrade'] : ['kline'];
        if (!allowedEvents.includes(event)) return;
        if (feed.spec.channel === 'kline' && String(feedRecord(feedRecord(data)?.k)?.i ?? '') !== String(feed.spec.interval ?? '')) return;
        this.#markTransportObserved(feed);
      }
      if ((feed.spec.venue === 'okx' || feed.spec.venue === 'bitget') && (envelope === 'pong' || feedRecord(envelope)?.event === 'pong')) { this.#markTransportAck(feed, 'heartbeat'); return; }
      if (feed.spec.venue === 'gateio' && (feedRecord(envelope)?.event === 'pong' || feedRecord(envelope)?.channel === 'futures.pong')) { this.#markTransportAck(feed, 'heartbeat'); return; }
      if (feed.spec.venue === 'deribit' && feedRecord(envelope)?.method === 'heartbeat') { this.#markTransportAck(feed, 'heartbeat'); return; }
      if (feed.spec.venue === 'deribit' && feedRecord(envelope)?.method === 'test_request') {
        // Deribit server heartbeats require a public/test JSON-RPC response;
        // observing the request alone must not make the connection healthy.
        void this.#sendHeartbeat(feed).catch(error => this.#fail(id, error, socket));
        return;
      }
      if (feed.spec.venue === 'deribit' && feedRecord(envelope)?.id === 0) {
        if (feedRecord(envelope)?.error) throw new Error(`Deribit heartbeat rejected: ${feedRecord(feedRecord(envelope).error).message ?? feedRecord(feedRecord(envelope).error).code ?? 'unknown error'}`);
        const providerVersion = feedRecord(feedRecord(envelope)?.result).version;
        if (feedRecord(envelope)?.jsonrpc !== '2.0' || typeof providerVersion !== 'string' || !providerVersion.trim()) return;
        this.#markTransportAck(feed, 'heartbeat'); return;
      }
      if (feed.spec.venue === 'deribit' && feedRecord(envelope)?.id === 1) {
        if (feedRecord(envelope)?.error) throw new Error(`Deribit subscription rejected: ${feedRecord(feedRecord(envelope).error).message ?? feedRecord(feedRecord(envelope).error).code ?? 'unknown error'}`);
        const expectedChannels = feedArray(feed.spec.request?.args ?? [feed.spec.topic]);
        if (feedRecord(envelope)?.jsonrpc !== '2.0' || !Array.isArray(feedRecord(envelope)?.result) || feedArray(feedRecord(envelope).result).length !== expectedChannels.length || feedArray(feedRecord(envelope).result).some((channel, index) => String(channel) !== String(expectedChannels[index]))) return;
        this.#markTransportAck(feed, 'subscription-response'); return;
      }
      if (feed.spec.venue === 'coinbase' && feedRecord(envelope)?.type === 'error') throw new Error(`Coinbase subscription rejected: ${feedRecord(envelope).message ?? feedRecord(envelope).reason ?? 'unknown error'}`);
      if (feed.spec.venue === 'coinbase' && feedRecord(envelope)?.type === 'subscriptions') {
        const expectedChannel = String(feed.spec.request?.channel ?? '');
        const expectedProduct = String(feed.spec.request?.productId ?? '').toUpperCase();
        const channels = feedArray(feedRecord(envelope).channels);
        // The current public batch ACK echoes the documented former name.
        const acceptedChannels = expectedChannel === 'level2_batch' ? ['level2_batch', 'level2_50'] : [expectedChannel];
        const matching = channels.some(channel => acceptedChannels.includes(String(feedRecord(channel)?.name ?? ''))
          && Array.isArray(feedRecord(channel).product_ids) && feedArray(feedRecord(channel).product_ids).some(product => typeof product === 'string' && product.toUpperCase() === expectedProduct));
        if (!matching) return;
        this.#markTransportAck(feed, 'subscription-response'); return;
      }
      if (feed.spec.venue === 'coinbase' && feedRecord(envelope)?.type === 'heartbeat') { if (String(feedRecord(envelope).product_id ?? '').toUpperCase() === String(feed.spec.symbol ?? '').toUpperCase()) this.#markTransportAck(feed, 'heartbeat'); return; }
      if (feed.spec.venue === 'coinbase') {
        if (String(feedRecord(envelope)?.product_id ?? '').toUpperCase() !== String(feed.spec.symbol ?? '').toUpperCase()) return;
        if (!['snapshot', 'l2update'].includes(String(feedRecord(envelope)?.type ?? '').toLowerCase())) return;
        if (!feed.subscriptionAcked) return;
      }
      if (feed.spec.venue === 'kraken' && feedRecord(envelope)?.method === 'subscribe') {
        if (feedRecord(envelope)?.success !== true || (feedRecord(feedRecord(envelope)?.result)?.success != null && feedRecord(feedRecord(envelope).result).success !== true)) throw new Error(`Kraken subscription rejected: ${feedRecord(envelope).error ?? feedRecord(feedRecord(envelope).result)?.error ?? 'missing success acknowledgement'}`);
        const result = feedRecord(envelope)?.result;
        const resultSymbols = Array.isArray(feedRecord(result)?.symbol) ? feedArray(feedRecord(result).symbol) : [feedRecord(result)?.symbol];
        if (feedRecord(result)?.channel !== feed.spec.request.channel || !resultSymbols.some(value => String(value).toUpperCase() === String(feed.spec.symbol).toUpperCase()) || Number(feedRecord(result)?.depth) !== Number(feed.spec.request.depth) || Boolean(feedRecord(result)?.snapshot) !== Boolean(feed.spec.request.snapshot)) return;
        this.#markTransportAck(feed, 'subscription-response'); return;
      }
      if (feed.spec.venue === 'kraken' && feedRecord(envelope)?.method === 'unsubscribe') return;
      if (feed.spec.venue === 'kraken' && feedRecord(envelope)?.success === false) throw new Error(`Kraken subscription rejected: ${feedRecord(envelope).error ?? 'unknown error'}`);
      if (feed.spec.venue === 'kraken') {
        if (feedRecord(envelope)?.channel !== feed.spec.channel || !['snapshot', 'update'].includes(String(feedRecord(envelope)?.type ?? '').toLowerCase())) return;
        const wireSymbol = feedRecord(feedRecord(feedRecord(envelope)?.data)?.[0])?.symbol;
        if (wireSymbol == null || String(wireSymbol).toUpperCase() !== String(feed.spec.symbol).toUpperCase()) return;
        if (!feed.subscriptionAcked) return;
      }
      if (feed.spec.venue === 'kucoin' && (feedRecord(envelope)?.type === 'welcome' || feedRecord(envelope)?.message === 'welcome')) {
        if (feed.kucoinWelcome) return;
        feed.kucoinWelcome = true;
        const subscription = venueControlFrame(feed.spec.venue, feed.spec.request, 'subscribe', { now: this.now() });
        if (subscription) void this.#sendTransport(feed, subscription).catch(error => this.#fail(id, error, socket));
        this.#setStatus(id, { kucoinWelcome: true, lastError: null });
        return;
      }
      if (feed.spec.venue === 'kucoin' && feedRecord(envelope)?.type === 'pong') { this.#markHeartbeatAck(feed); return; }
      if (feed.spec.venue === 'kucoin' && feedRecord(envelope)?.type === 'ack') {
        if (!feed.kucoinWelcome || String(feedRecord(envelope)?.id ?? '') !== String(feed.spec.request?.id ?? '')) return;
        this.#markTransportAck(feed, 'subscription-response'); return;
      }
      if (feed.spec.venue === 'kucoin' && feedRecord(envelope)?.type === 'error') throw new Error(`KuCoin subscription rejected: ${feedRecord(envelope)?.msg ?? feedRecord(envelope)?.message ?? feedRecord(envelope)?.code ?? 'unknown error'}`);
      if (feed.spec.venue === 'kucoin') {
        if (feedRecord(envelope)?.type !== 'message' || String(feedRecord(envelope)?.subject ?? '').toLowerCase() !== 'level2' || feedRecord(envelope)?.topic !== feed.spec.topic) return;
        if (!feed.subscriptionAcked) return;
      }
      if (feed.spec.venue === 'mexc' && (feedRecord(envelope)?.channel === 'pong' || feedRecord(envelope)?.method === 'pong')) { this.#markHeartbeatAck(feed); return; }
      if (feed.spec.venue === 'mexc' && feedRecord(envelope)?.channel === 'rs.error') throw new Error(`MEXC subscription rejected: ${feedRecord(envelope)?.data ?? feedRecord(envelope)?.message ?? 'unknown error'}`);
      if (feed.spec.venue === 'mexc' && feedRecord(envelope)?.channel === feed.spec.request?.ackChannel) {
        if (String(feedRecord(envelope)?.data ?? '').toLowerCase() !== 'success') throw new Error(`MEXC subscription rejected: ${feedRecord(envelope)?.data ?? 'missing success acknowledgement'}`);
        if (feedRecord(envelope)?.symbol != null && String(feedRecord(envelope).symbol).toUpperCase() !== String(feed.spec.symbol).toUpperCase()) return;
        this.#markTransportAck(feed, 'subscription-response'); return;
      }
      if (feed.spec.venue === 'mexc') {
        if (feedRecord(envelope)?.channel !== feed.spec.channel) return;
        if (feedRecord(envelope)?.symbol == null || String(feedRecord(envelope).symbol).toUpperCase() !== String(feed.spec.symbol).toUpperCase()) return;
        if (!feed.subscriptionAcked) return;
      }
      if (feed.spec.venue === 'htx' && feedRecord(envelope)?.ping != null) {
        void this.#sendTransport(feed, { pong: feedRecord(envelope).ping }).catch(error => this.#fail(id, error, socket));
        this.#markHeartbeatAck(feed, 'server-ping');
        return;
      }
      if (feed.spec.venue === 'htx' && feedRecord(envelope)?.pong != null) { this.#markHeartbeatAck(feed, 'pong'); return; }
      if (feed.spec.venue === 'htx' && String(feedRecord(envelope)?.status ?? '').toLowerCase() === 'error') throw new Error(`HTX subscription rejected: ${feedRecord(envelope)?.['err-msg'] ?? feedRecord(envelope)?.errMsg ?? feedRecord(envelope)?.['err-code'] ?? 'unknown error'}`);
      if (feed.spec.venue === 'htx' && feedRecord(envelope)?.subbed != null) {
        if (String(feedRecord(envelope)?.id ?? '') !== String(feed.spec.request?.id ?? '') || String(feedRecord(envelope).subbed) !== String(feed.spec.topic) || String(feedRecord(envelope)?.status ?? '').toLowerCase() !== 'ok') return;
        this.#markTransportAck(feed, 'subscription-response'); return;
      }
      if (feed.spec.venue === 'htx') {
        if (feedRecord(envelope)?.ch !== feed.spec.topic) return;
        if (!feed.subscriptionAcked) return;
      }
      if (feed.spec.venue === 'bitfinex' && feedRecord(envelope)?.event === 'error') throw new Error(`Bitfinex subscription rejected: ${feedRecord(envelope)?.msg ?? feedRecord(envelope)?.code ?? 'unknown error'}`);
      if (feed.spec.venue === 'bitfinex' && (feedRecord(envelope)?.event === 'info' || feedRecord(envelope)?.event === 'conf')) return;
      if (feed.spec.venue === 'bitfinex' && feedRecord(envelope)?.event === 'subscribed') {
        const request = feed.spec.request ?? {};
        if (String(feedRecord(envelope)?.channel ?? '') !== String(request.channel ?? '')
          || String(feedRecord(envelope)?.symbol ?? '').toUpperCase() !== String(request.symbol ?? '').toUpperCase()
          || String(feedRecord(envelope)?.prec ?? '').toUpperCase() !== String(request.precision ?? '').toUpperCase()
          || String(feedRecord(envelope)?.freq ?? '') !== String(request.frequency ?? '')
          || String(feedRecord(envelope)?.len ?? '') !== String(request.len ?? '')
          || String(feedRecord(envelope)?.subId ?? '') !== String(request.subId ?? '')
          || !Number.isSafeInteger(Number(feedRecord(envelope)?.chanId))) return;
        feed.channelId = Number(feedRecord(envelope).chanId);
        feed.spec.request.channelId = feed.channelId;
        this.#markTransportAck(feed, 'subscription-response');
        return;
      }
      if (feed.spec.venue === 'bitfinex' && feedRecord(envelope)?.event === 'unsubscribed') return;
      if (feed.spec.venue === 'bitfinex' && Array.isArray(envelope)) {
        const channelId = Number(envelope[0]);
        if (feed.channelId == null || channelId !== feed.channelId) return;
        if (envelope[1] === 'hb') { this.#markHeartbeatAck(feed, 'server-heartbeat'); return; }
        if (!feed.subscriptionAcked) return;
      }
      if (feed.spec.venue === 'bitmex' && envelope === 'pong') { this.#markHeartbeatAck(feed, 'pong'); return; }
      if (feed.spec.venue === 'bitmex' && feedRecord(envelope)?.info) return;
      if (feed.spec.venue === 'bitmex' && feedRecord(envelope)?.error) throw new Error(`BitMEX subscription rejected: ${feedRecord(feedRecord(envelope).error).message ?? feedRecord(feedRecord(envelope).error).name ?? 'unknown error'}`);
      if (feed.spec.venue === 'bitmex' && feedRecord(envelope)?.success === false) throw new Error(`BitMEX subscription rejected: ${feedRecord(envelope)?.subscribe ?? feedArray(feedRecord(feedRecord(envelope)?.request)?.args)?.join(',') ?? 'unknown error'}`);
      if (feed.spec.venue === 'bitmex' && feedRecord(envelope)?.success === true && feedRecord(envelope)?.subscribe != null) {
        const expected = feed.spec.request?.args ?? [];
        const actual = String(feedRecord(envelope).subscribe);
        if (feedArray(expected).length !== 1 || actual !== String(feedRecord(expected)[0])) return;
        const request = feedRecord(envelope).request;
        if (feedRecord(request)?.op !== 'subscribe' || !Array.isArray(feedRecord(request).args)
          || feedArray(feedRecord(request).args).length !== feedArray(expected).length
          || feedArray(feedRecord(request).args).some((value, index) => String(value) !== String(feedRecord(expected)[index]))) {
          throw new Error('BitMEX subscription acknowledgement request mismatch');
        }
        const pool = normalizeBitmexPool(feedRecord(envelope).pool, { allowNull: false });
        feed.pool = pool;
        if (feed.session) feed.session = { ...feed.session, pool };
        this.#markTransportAck(feed, 'subscription-response');
        this.#setStatus(feed.id, { pool: feed.pool });
        return;
      }
      if (feed.spec.venue === 'bitmex') {
        if (String(feedRecord(envelope)?.table ?? '') !== String(feed.spec.request?.table ?? '')) return;
        const filterSymbol = feedRecord(feedRecord(envelope).filter)?.symbol;
        if (filterSymbol == null || String(filterSymbol).toUpperCase() !== String(feed.spec.symbol).toUpperCase()) return;
        if (!feed.subscriptionAcked) return;
        const filterPool = normalizeBitmexPool(feedRecord(feedRecord(envelope).filter)?.pool, { allowNull: false });
        if (!feed.pool || filterPool !== feed.pool) throw new Error('BitMEX order book pool mismatch');
        for (const row of feedArray(feedRecord(envelope).data)) {
          if (feedRecord(row)?.pool != null && normalizeBitmexPool(feedRecord(row).pool, { allowNull: false }) !== feed.pool) throw new Error('BitMEX order book row pool mismatch');
        }
      }
      if ((feed.spec.venue === 'okx' || feed.spec.venue === 'bitget') && (feedRecord(envelope)?.event === 'error' || (feedRecord(envelope)?.code != null && !['0', '00000'].includes(String(feedRecord(envelope).code))))) throw new Error(`${feed.spec.venue} subscription rejected: ${feedRecord(envelope)?.msg ?? feedRecord(envelope)?.message ?? feedRecord(envelope)?.code ?? 'unknown error'}`);
      if (feed.spec.venue === 'okx' && feedRecord(envelope)?.event === 'subscribe') {
        if (!feedRecord(envelope)?.arg || feedRecord(feedRecord(envelope).arg).channel !== feed.spec.request.channel || String(feedRecord(feedRecord(envelope).arg).instId).toUpperCase() !== String(feed.spec.request.instId).toUpperCase()) return;
        this.#markTransportAck(feed, 'subscription-response'); return;
      }
      if (feed.spec.venue === 'bitget' && feedRecord(envelope)?.event === 'subscribe') {
        if (!feedRecord(envelope)?.arg || String(feedRecord(feedRecord(envelope).arg).instType).toLowerCase() !== String(feed.spec.request.instType).toLowerCase() || feedRecord(feedRecord(envelope).arg).topic !== feed.spec.request.channel || String(feedRecord(feedRecord(envelope).arg).symbol).toUpperCase() !== String(feed.spec.request.symbol).toUpperCase()) return;
        this.#markTransportAck(feed, 'subscription-response'); return;
      }
      if (feed.spec.venue === 'gateio' && feedRecord(envelope)?.event === 'subscribe') {
        // Gate's futures v4 acknowledgement is scoped to the requested
        // channel and reports an explicit result.status.  Do not let a
        // neighbouring subscription, a malformed acknowledgement, or a
        // provider error mark this feed live.
        if (feedRecord(envelope)?.channel !== feed.spec.request.channel) return;
        if (feedRecord(envelope)?.error) throw new Error(`Gate.io subscription rejected: ${feedRecord(feedRecord(envelope).error).message ?? feedRecord(envelope).error}`);
        const status = feedRecord(feedRecord(envelope)?.result)?.status;
        if (String(status ?? '').toLowerCase() !== 'success') throw new Error(`Gate.io subscription rejected: ${feedRecord(feedRecord(envelope)?.result)?.message ?? status ?? 'unknown error'}`);
        if (Array.isArray(feedRecord(envelope)?.payload)) {
          const expectedPayload = feed.spec.request.args ?? [];
          if (feedArray(feedRecord(envelope).payload).length !== feedArray(expectedPayload).length || feedArray(feedRecord(envelope).payload).some((value, index) => String(value).toUpperCase() !== String(feedRecord(expectedPayload)[index]).toUpperCase())) return;
        }
        this.#markTransportAck(feed, 'subscription-response'); return;
      }
      if (feed.spec.venue === 'okx' && feedRecord(envelope)?.arg && (feedRecord(feedRecord(envelope).arg).channel !== feed.spec.request.channel || feedRecord(feedRecord(envelope).arg).instId !== feed.spec.request.instId)) return;
      if (feed.spec.venue === 'bitget' && feedRecord(envelope)?.arg && (String(feedRecord(feedRecord(envelope).arg).instType).toLowerCase() !== String(feed.spec.request.instType).toLowerCase() || feedRecord(feedRecord(envelope).arg).topic !== feed.spec.request.channel || String(feedRecord(feedRecord(envelope).arg).symbol ?? feedRecord(feedRecord(envelope).arg).instId).toUpperCase() !== String(feed.spec.request.symbol).toUpperCase())) return;
      if (feed.spec.venue === 'gateio' && feedRecord(envelope)?.channel && feedRecord(envelope).channel !== feed.spec.request.channel) return;
      if (feed.spec.venue === 'gateio' && feedRecord(feedRecord(envelope)?.result)?.contract && String(feedRecord(feedRecord(envelope).result).contract).toUpperCase() !== String(feed.spec.request.contract).toUpperCase()) return;
      if (feed.spec.venue === 'deribit' && feedRecord(feedRecord(envelope)?.params)?.channel !== feed.spec.topic) return;
      if (feed.spec.venue === 'deribit') {
        const instrument = feedRecord(feedRecord(feedRecord(envelope)?.params)?.data)?.instrument_name;
        if (instrument == null || String(instrument).toUpperCase() !== String(feed.spec.symbol).toUpperCase()) return;
      }
      const decoded = feed.spec.decode(envelope);
      if (feed.spec.venue !== 'hyperliquid' && !feed.subscriptionAcked && decoded != null && (!Array.isArray(decoded) || decoded.length > 0)) this.#markTransportAck(feed, 'data');
      // A valid Bitfinex book/checksum frame keeps the subscription active
      // for idle-retirement purposes, but heartbeat liveness is refreshed only
      // by the channel-matched server heartbeat handled above.
      if (feed.spec.venue === 'bitfinex' || feed.spec.venue === 'bitmex' || feed.spec.venue === 'cryptocom' || feed.spec.venue === 'bitstamp') this.#touchTransport(feed);
      // A native trade frame is one synchronous admission unit. Use the exact
      // decoded array; no queue, copied rows, or retained batch state is added.
      if (this.onTradeBatch && Array.isArray(decoded) && decoded.length >= 2 && decoded.every(message => message?.kind === 'trade')) {
        let accepted: boolean | void;
        try { accepted = this.onTradeBatch({ venue: feed.spec.venue, messages: decoded, feedId: id }); }
        catch (error) { this.#fail(id, error, socket); return; }
        if (accepted === false) { this.#fail(id, new Error('retained trade batch admission rejected'), socket); return; }
        // The synchronous consumer may retire or replace its own session.
        if (feed.retired || this.feeds.get(id) !== feed || feed.configurationGeneration !== this.configurationGeneration
          || feed.generation !== this.feedGenerations.get(id) || this.specs.get(id) !== feed.spec || (socket && feed.socket !== socket)) return;
        this.#setStatus(id, { state: 'live', lastSuccess: this.now(), lastError: null });
        return;
      }
      const messages = Array.isArray(decoded) ? decoded : [decoded];
      for (const message of messages) {
        if (!message) continue;
        const retainedPriceMutation = message.kind === 'price'
          ? this.#stageRetainedLastPrice(id, feed, message)
          : null;
        if (retainedPriceMutation === false) {
          this.#setStatus(id, { state: 'unavailable', active: false, lastError: 'manager last-price capacity exceeded' });
          return;
        }
        let delivered = message;
        let retainedSessionMutation = null;
        if (publicDepthVenue && (feed.spec.venue === 'dydx' || feed.spec.venue === 'aster') && (message.kind === 'depthSnapshot' || message.kind === 'depthDelta')) {
          const previousBook = feed.session?.book;
          if (previousBook) {
            if (feed.spec.venue === 'dydx' && feedRecord(previousBook).providerConnectionId !== feedRecord(message).providerConnectionId) throw new TypeError('dYdX depth provider connection changed');
            // dYdX has a dedicated unbatched connection counter. Aster sends
            // independent partial snapshots: skipped IDs need no diff bridge,
            // but duplicates and rewinds still cannot replace a newer view.
            const ordering = BigInt(String(message.sequence)) - BigInt(String(previousBook.sequence));
            if (ordering === 0n) continue;
            if (ordering < 0n) throw new TypeError(`${feed.spec.venue} depth provider sequence rewind`);
          }
        }
        if ((message.kind === 'depthSnapshot' || message.kind === 'depthDelta') && feed.spec.venue === 'bybit') {
          const routed = applyBybitDepthSessionMessage(feedSession(feed, createBybitDepthSession, 'bybit'), { topic: feed.spec.topic, sessionToken: feed.sessionToken ?? undefined, update: message as NonNullable<Parameters<typeof applyBybitDepthSessionMessage>[1]>['update'] });
          if (!routed.accepted) {
            if (routed.session !== feed.session && !this.#admitRetainedDepthSession(id, feed, routed.session, message, socket)) return;
            if (routed.reason === 'resync-required') this.#setStatus(id, { state: 'snapshot', lastError: routed.reason });
            continue;
          }
          // The reducer is the authority for Bybit's intentionally unproven
          // continuity model. Preserve its sequence metadata on the emitted
          // delta so downstream state/evidence sees the same contract.
          if (message.kind === 'depthDelta' && routed.session.book) {
            delivered = { ...delivered, continuity: routed.session.book.continuity, sequenceJump: routed.session.book.sequenceJump === true };
          }
          retainedSessionMutation = this.#stageRetainedDepthSession(id, feed, routed.session, delivered);
          this.#setStatus(id, { state: 'live', lastSuccess: this.now(), lastError: null });
        }
        if ((message.kind === 'depthSnapshot' || message.kind === 'depthDelta') && feed.spec.venue === 'kraken') {
          const routed = applyKrakenDepthSessionMessage(feedSession(feed, createKrakenDepthSession, 'kraken'), { topic: feed.spec.topic, sessionToken: feed.sessionToken ?? undefined, update: message as NonNullable<Parameters<typeof applyKrakenDepthSessionMessage>[1]>['update'] });
          if (!routed.accepted) {
            if (routed.session !== feed.session && !this.#admitRetainedDepthSession(id, feed, routed.session, message, socket)) return;
            if (routed.reason === 'resync-required') { this.#recoverPublicDepth(id, feed, feed.session?.invalidReason ?? routed.reason); return; }
            continue;
          }
          if (!routed.session.book) throw new TypeError('Accepted depth session has no book');
          delivered = routed.session.book;
          retainedSessionMutation = this.#stageRetainedDepthSession(id, feed, routed.session, delivered);
          this.#setStatus(id, { state: 'live', lastSuccess: this.now(), lastError: null, checksumVerified: true });
        }
        if ((message.kind === 'depthSnapshot' || message.kind === 'depthDelta' || message.kind === 'depthChecksum') && feed.spec.venue === 'bitfinex') {
          const routed = applyBitfinexDepthSessionMessage(feedSession(feed, createBitfinexDepthSession, 'bitfinex'), { topic: feed.spec.topic, sessionToken: feed.sessionToken ?? undefined, channelId: feed.channelId, update: message as NonNullable<Parameters<typeof applyBitfinexDepthSessionMessage>[1]>['update'] });
          if (!routed.accepted) {
            if (routed.session !== feed.session && !this.#admitRetainedDepthSession(id, feed, routed.session, message, socket)) return;
            if (routed.reason === 'resync-required') { this.#recoverPublicDepth(id, feed, feed.session?.invalidReason ?? routed.reason); return; }
            continue;
          }
          if (routed.checksumOnly) {
            if (!this.#admitRetainedDepthSession(id, feed, routed.session, message, socket)) return;
            this.#setStatus(id, { state: 'live', lastSuccess: this.now(), lastError: null, checksumVerified: true });
            continue;
          }
          if (!routed.session.book) throw new TypeError('Accepted depth session has no book');
          delivered = routed.session.book;
          retainedSessionMutation = this.#stageRetainedDepthSession(id, feed, routed.session, delivered);
          this.#setStatus(id, { state: 'live', lastSuccess: this.now(), lastError: null, checksumVerified: delivered?.checksumVerified === true });
        }
        if ((message.kind === 'depthSnapshot' || message.kind === 'depthDelta') && feed.spec.venue === 'bitmex') {
          const routed = applyBitmexDepthSessionMessage(feedSession(feed, createBitmexDepthSession, 'bitmex'), { topic: feed.spec.topic, sessionToken: feed.sessionToken ?? undefined, update: message as NonNullable<Parameters<typeof applyBitmexDepthSessionMessage>[1]>['update'] });
          if (!routed.accepted) {
            if (routed.session !== feed.session && !this.#admitRetainedDepthSession(id, feed, routed.session, message, socket)) return;
            if (routed.reason === 'resync-required') { this.#recoverPublicDepth(id, feed, feed.session?.invalidReason ?? routed.reason); return; }
            continue;
          }
          if (!routed.session.book) throw new TypeError('Accepted depth session has no book');
          delivered = routed.session.book;
          retainedSessionMutation = this.#stageRetainedDepthSession(id, feed, routed.session, delivered);
          this.#setStatus(id, { state: 'live', lastSuccess: this.now(), lastError: null });
        }
        if ((message.kind === 'depthSnapshot' || message.kind === 'depthDelta') && feed.spec.venue === 'cryptocom') {
          const routed = applyCryptocomDepthSessionMessage(feedSession(feed, createCryptocomDepthSession, 'cryptocom'), { topic: feed.spec.topic, sessionToken: feed.sessionToken ?? undefined, update: message as NonNullable<Parameters<typeof applyCryptocomDepthSessionMessage>[1]>['update'] });
          if (!routed.accepted) {
            if (routed.session !== feed.session && !this.#admitRetainedDepthSession(id, feed, routed.session, message, socket)) return;
            if (routed.reason === 'resync-required') { this.#recoverPublicDepth(id, feed, feed.session?.invalidReason ?? routed.reason); return; }
            continue;
          }
          if (!routed.session.book) throw new TypeError('Accepted depth session has no book');
          delivered = routed.session.book;
          retainedSessionMutation = this.#stageRetainedDepthSession(id, feed, routed.session, delivered);
          this.#setStatus(id, { state: 'live', lastSuccess: this.now(), lastError: null });
        }
        if ((message.kind === 'depthSnapshot' || message.kind === 'depthDelta') && feed.spec.venue === 'phemex') {
          const routed = applyPhemexDepthSessionMessage(feedSession(feed, createPhemexDepthSession, 'phemex'), { topic: feed.spec.topic, sessionToken: feed.sessionToken ?? undefined, update: message as NonNullable<Parameters<typeof applyPhemexDepthSessionMessage>[1]>['update'] });
          if (!routed.accepted) {
            if (routed.session !== feed.session && !this.#admitRetainedDepthSession(id, feed, routed.session, message, socket)) return;
            if (routed.reason === 'resync-required') { this.#recoverPublicDepth(id, feed, feed.session?.invalidReason ?? routed.reason); return; }
            continue;
          }
          if (!routed.session.book) throw new TypeError('Accepted depth session has no book');
          delivered = routed.session.book;
          retainedSessionMutation = this.#stageRetainedDepthSession(id, feed, routed.session, delivered);
          this.#setStatus(id, { state: 'live', lastSuccess: this.now(), lastError: null });
        }
        if ((message.kind === 'depthSnapshot' || message.kind === 'depthDelta') && publicDepthVenue && feed.spec.venue !== 'bybit' && feed.spec.venue !== 'kraken' && feed.spec.venue !== 'bitfinex' && feed.spec.venue !== 'bitmex' && feed.spec.venue !== 'cryptocom' && feed.spec.venue !== 'bitstamp' && feed.spec.venue !== 'phemex') {
          const routed = applyPublicDepthSessionMessage(feedSession(feed, createPublicDepthSession, 'public'), { topic: feed.spec.topic, sessionToken: feed.sessionToken ?? undefined, update: message as NonNullable<Parameters<typeof applyPublicDepthSessionMessage>[1]>['update'] });
          if (!routed.accepted) {
            if (routed.session !== feed.session && !this.#admitRetainedDepthSession(id, feed, routed.session, message, socket)) return;
            if (routed.reason === 'resync-required') { this.#recoverPublicDepth(id, feed, feed.session?.invalidReason ?? routed.reason); return; }
            continue;
          }
          retainedSessionMutation = this.#stageRetainedDepthSession(id, feed, routed.session, delivered);
          this.#setStatus(id, { state: 'live', lastSuccess: this.now(), lastError: null });
        }
        if (message.kind === 'depthSnapshot' && feed.spec.venue === 'bitstamp') {
          const routed = applyPublicDepthSessionMessage(feedSession(feed, createPublicDepthSession, 'public'), { topic: feed.spec.topic, sessionToken: feed.sessionToken ?? undefined, update: message as NonNullable<Parameters<typeof applyPublicDepthSessionMessage>[1]>['update'] });
          if (!routed.accepted) {
            if (routed.session !== feed.session && !this.#admitRetainedDepthSession(id, feed, routed.session, message, socket)) return;
            if (routed.reason === 'resync-required') { this.#recoverPublicDepth(id, feed, feed.session?.invalidReason ?? routed.reason); return; }
            continue;
          }
          if (!routed.session.book) throw new TypeError('Accepted depth session has no book');
          delivered = routed.session.book;
          retainedSessionMutation = this.#stageRetainedDepthSession(id, feed, routed.session, delivered);
          this.#setStatus(id, { state: 'live', lastSuccess: this.now(), lastError: null });
        }
        if (message.kind === 'depthDelta' && feed.spec.venue === 'binance') {
          const key = message.instrumentId;
          if (typeof key !== 'string' || !key) throw new TypeError('Normalized Binance depth instrument missing');
          if (this.restTransport?.request && this.resyncing.has(binanceInstrumentId(feed.spec.symbol, feed.spec.marketType, feed.spec.family))) {
            this.#bufferBinanceDepth(id, key, message, socket);
            return;
          }
          const expected = this.bookSequences.get(key);
          if (this.restTransport?.request && expected == null) {
            if (!this.#bufferBinanceDepth(id, key, message, socket)) return;
            this.#setStatus(id, { state: 'snapshot', lastError: 'waiting for depth snapshot' });
            return;
          }
          if (expected != null && message.sequence != null && message.sequence <= expected) return;
          if (expected != null && message.sequence != null) {
            const first = Number(message.firstUpdate ?? (Number(message.previousSequence) + 1));
            const isSpotRange = feed.spec.marketType === 'spot';
            const allowInitialOverlap = this.depthBridgePending.get(key) === true;
            const overlapsSnapshot = allowInitialOverlap && Number.isFinite(first) && first <= Number(expected) + 1 && Number(message.sequence) >= Number(expected) + 1;
            const coversExpectedSpotUpdate = isSpotRange && Number.isFinite(first) && first <= Number(expected) + 1 && Number(message.sequence) >= Number(expected) + 1;
            if (message.previousSequence !== expected && !overlapsSnapshot && !coversExpectedSpotUpdate) {
              this.#invalidateBinanceDepth(id, feed.spec, `depth sequence gap: expected ${expected}, got ${message.previousSequence}`);
              this.#setStatus(id, { state: 'unavailable', lastError: `depth sequence gap: expected ${expected}, got ${message.previousSequence}` });
              void this.#resyncBinanceDepth(feed.spec);
              return;
            }
            // Only the first post-snapshot event may overlap the REST snapshot.
            if (message.previousSequence !== expected) delivered = { ...message, previousSequence: expected };
          }
        }
        const emitted = this.#emit(id, feed.spec.venue, delivered, retainedSessionMutation ?? retainedPriceMutation);
        if (emitted === false && (delivered.kind === 'depthSnapshot' || delivered.kind === 'depthDelta')) {
          this.#fail(id, new Error('retained depth admission rejected'), socket);
          return;
        }
        if (emitted === false && message.kind === 'price') return;
        if (message.kind === 'depthDelta' && feed.spec.venue === 'binance') {
          this.#setStatus(id, { state: 'live', lastSuccess: this.now(), lastError: null });
        }
        if (retainedSessionMutation && !retainedSessionMutation.committed) retainedSessionMutation.commit();
        if (retainedPriceMutation && !this.#admitRetainedLastPrice(id, feed, retainedPriceMutation)) return;
        if (message.kind === 'openInterest' && Number.isFinite(message.markPrice)) this.#emit(id, feed.spec.venue, { kind: 'price', instrumentId: message.instrumentId, sourceTimestamp: message.sourceTimestamp, receivedAt: message.receivedAt, price: message.markPrice });
        if (message?.kind !== 'depthDelta') this.#setStatus(id, { state: 'live', lastSuccess: this.now(), lastError: null });
      }
    }
    catch (error) {
      if (feed.spec.venue === 'bybit' && feed.session) { const reason = boundedDepthInvalidReason(feedError(error).message ?? 'malformed Bybit payload'); feed.retired = true; this.#releaseTransport(feed); retireLiveFeedSocket(feed.socket); this.#emitDepthSessionInvalidation(id, feed, invalidateBybitDepthSession(feedSession(feed, createBybitDepthSession, 'bybit'), reason), reason); this.#setStatus(id, { state: 'backoff', lastError: reason }); this.#scheduleReconnect(id); return; }
      if (feed.spec.venue === 'binance' && feed.spec.channel === 'depth' && feedError(error).transportFatal !== true) {
        const reason = `malformed Binance depth payload: ${feedError(error).message ?? String(error)}`;
        this.#invalidateBinanceDepth(id, feed.spec, reason);
        this.#setStatus(id, { state: 'unavailable', lastError: reason });
        if (this.restTransport?.request) void this.#resyncBinanceDepth(feed.spec);
        return;
      }
      if (feed.spec.venue === 'hyperliquid') { this.#fail(id, error, socket); return; }
      if (feed.spec.publicDepth && feed.session) { this.#recoverPublicDepth(id, feed, feedError(error).message ?? 'malformed public depth payload'); return; }
      if (feedError(error).transportFatal) { this.#fail(id, error, socket); return; }
      this.#setStatus(id, { state: 'live', lastError: feedError(error).message ?? String(error) });
    } finally {
      this.activeMessageMemoryReservation = previousMessageMemoryReservation;
      try { messageMemoryReservation?.release?.(); } catch { /* preserve the feed outcome */ }
    }
  }
  #emit(id: string, venue: string, message: LiveNormalizedMessage, retainedMutation: LiveFeedRetainedMutation | null = null) {
    const sequenceMutation = this.#stageRetainedBinanceDepthState(id, venue, message);
    let mutation = retainedMutation;
    if (sequenceMutation && retainedMutation) {
      const parts = [retainedMutation, sequenceMutation];
      mutation = {
        candidate: { kind: 'feed-retained-composite', mutations: parts.map(part => part.candidate) },
        get committed() { return parts.every(part => part.committed === true); },
        commit: () => { for (const part of parts) part.commit(); },
      };
    } else if (sequenceMutation) {
      mutation = sequenceMutation;
    }
    const result = this.onMessage({ id, venue, message, receivedAt: this.now(), ...(mutation ? { retainedMutation: mutation } : {}) });
    if (result === false) return false;
    // Production applyMessage commits this mutation inside retained admission.
    // Callbacks without that server reducer retain the historical accepted-event
    // behavior, while rejected server admissions leave the manager state alone.
    if (sequenceMutation && !sequenceMutation.committed) sequenceMutation.commit();
    return result;
  }
  #stageRetainedBinanceDepthState(id: string, venue: string, message: LiveNormalizedMessage) {
    if (venue !== 'binance' || (message?.kind !== 'depthSnapshot' && message?.kind !== 'depthDelta')) return null;
    if (message.invalidated === true || message.gap === true || message.resyncRequired === true) return null;
    const instrumentId = message.kind === 'depthSnapshot'
      ? (message.bookKey ?? message.instrumentId)
      : message.instrumentId;
    if (typeof instrumentId !== 'string' || !instrumentId.trim() || instrumentId.length > 256) return null;
    if (message.kind === 'depthSnapshot' && message.sequence == null) return null;
    const hasSequence = message.sequence != null;
    const bridgePending = message.kind === 'depthSnapshot';
    const sameSequence = !hasSequence || (this.bookSequences.has(instrumentId) && Object.is(this.bookSequences.get(instrumentId), message.sequence));
    const sameBridge = this.depthBridgePending.has(instrumentId) && this.depthBridgePending.get(instrumentId) === bridgePending;
    if (sameSequence && sameBridge) return null;
    const mutation = {
      candidate: {
        kind: 'feed-binance-depth-state',
        feedId: id,
        venue,
        instrumentId,
        ...(hasSequence ? { sequence: message.sequence } : {}),
        depthBridgePending: bridgePending,
      },
      committed: false,
      commit: () => {
        if (mutation.committed) return;
        if (hasSequence) this.bookSequences.set(instrumentId, message.sequence);
        this.depthBridgePending.set(instrumentId, bridgePending);
        this.retainedDiagnosticsCache = null;
        mutation.committed = true;
      },
    };
    return mutation;
  }
  #stageRetainedLastPrice(id: string, feed: LiveFeed, message: LiveNormalizedMessage) {
    const instrumentId = typeof message.instrumentId === 'string' ? message.instrumentId.trim() : '';
    const price = Number(message.price);
    const spec = this.specs.get(id);
    const configuredInstrumentId = spec?.instrumentId
      ?? (spec?.venue === 'binance' && spec.symbol ? binanceInstrumentId(spec.symbol, spec.marketType, spec.family) : null);
    if (!instrumentId || instrumentId.length > 256 || configuredInstrumentId !== instrumentId || !(Number.isFinite(price) && price > 0)) return null;
    if (Object.is(this.#lastPrices.get(instrumentId), price)) return null;
    if (!this.#lastPrices.has(instrumentId) && this.#lastPrices.size >= LIVE_FEED_MANAGER_LAST_PRICE_MAX_ENTRIES) return false;
    const mutation = {
      candidate: { kind: 'feed-last-price', feedId: id, venue: feed.spec.venue, instrumentId, price },
      committed: false,
      commit: () => {
        if (mutation.committed) return;
        this.#lastPrices.set(instrumentId, price);
        this.retainedDiagnosticsCache = null;
        mutation.committed = true;
      },
    };
    return mutation;
  }
  #admitRetainedLastPrice(id: string, feed: LiveFeed, mutation: LiveFeedRetainedMutation) {
    if (mutation.committed) return true;
    if (!this.retainedAdmission) {
      mutation.commit();
      return true;
    }
    const context = {
      kind: 'live-feed-last-price',
      venue: feed.spec.venue,
      feedId: id,
      instrumentId: mutation.candidate.instrumentId,
    };
    let admission;
    try { admission = this.retainedAdmission(mutation.candidate, context, mutation.commit); }
    catch { admission = null; }
    if (admission?.admitted === true) {
      if (!mutation.committed) mutation.commit();
      return true;
    }
    this.#setStatus(id, { state: 'unavailable', active: false, lastError: 'retained-data admission rejected' });
    return false;
  }
  #publishSelectedPublicMetadata(statusId: string, metadata: LiveFeedMetadata, generation: number) {
    return this.#publishVenueMetadata(statusId, metadata, () => {
      if (generation !== this.configurationGeneration) return;
      // The specs/feed shells are measured retained owners. Keep only the
      // verified configured row, sharing it across this family's feed specs.
      for (const spec of this.specs.values()) {
        if (spec.venue !== metadata.venue || spec.configurationGeneration !== generation) continue;
        const selected = selectedPublicFamilyMetadata(metadata, spec);
        if (selected) spec.metadata = selected;
        else delete spec.metadata;
      }
      this.retainedDiagnosticsCache = null;
    });
  }
  #publishVenueMetadata(statusId: string, metadata: LiveFeedMetadata, commit: () => unknown) {
    const candidate = {
      kind: 'feed-metadata',
      venue: metadata.venue,
      assetCount: Array.isArray(metadata.assets) ? metadata.assets.length : 0,
      metadata,
    };
    const mutation = {
      candidate,
      committed: false,
      commit: () => {
        if (mutation.committed) return;
        commit();
        mutation.committed = true;
      },
    };
    const existingMetadata = ({
      whitebit: this.whitebitMetadata,
      phemex: this.phemexMetadata,
      dydx: this.dydxMetadata,
      aster: this.asterMetadata,
    })[String(metadata.venue ?? '').toLowerCase()] ?? null;
    const emitted = this.#emit(statusId, metadata.venue, metadata, mutation);
    if (emitted === false) {
      this.#setStatus(statusId, {
        state: existingMetadata ? 'backoff' : 'unavailable',
        attempt: 0,
        nextRetryAt: null,
        stale: existingMetadata !== null,
        lastError: 'retained-data admission rejected',
      });
      return false;
    }
    if (!mutation.committed) mutation.commit();
    return true;
  }
  #stageRetainedDepthSession(id: string, feed: LiveFeed, session: LiveDepthSession | null | undefined, message: LiveNormalizedMessage) {
    if (!this.retainedAdmission) {
      feed.session = session;
      return null;
    }
    const mutation = {
      candidate: {
        kind: 'feed-session', venue: feed.spec.venue, feedId: id,
        instrumentId: feed.spec.instrumentId, previousSession: feed.session,
        session, message,
      },
      committed: false,
      commit: () => {
        if (mutation.committed) return;
        feed.session = session;
        mutation.committed = true;
      },
    };
    return mutation;
  }
  #emitDepthSessionInvalidation(id: string, feed: LiveFeed, session: LiveDepthSession | null | undefined, reason: unknown) {
    const invalidReason = boundedDepthInvalidReason(reason);
    const invalidatedSession = compactInvalidatedDepthSession(session, invalidReason);
    const book: LiveNormalizedMessage | null = invalidatedSession?.book ?? null;
    const spec = feed.spec;
    const message = {
      kind: 'depthSnapshot',
      instrumentId: book?.instrumentId ?? spec.instrumentId,
      ...(spec.bookKey ?? book?.bookKey ? { bookKey: spec.bookKey ?? book?.bookKey } : {}),
      ...(spec.resolutionKey ?? book?.resolutionKey ? { resolutionKey: spec.resolutionKey ?? book?.resolutionKey } : {}),
      ...(spec.resolution ?? book?.resolution ? { resolution: spec.resolution ?? book?.resolution } : {}),
      ...(spec.sourceGrouping ?? book?.sourceGrouping ? { sourceGrouping: spec.sourceGrouping ?? book?.sourceGrouping } : {}),
      ...(spec.sourceDepth ?? book?.sourceDepth ? { sourceDepth: spec.sourceDepth ?? book?.sourceDepth } : {}),
      ...(spec.sourceInterval ?? book?.sourceInterval ? { sourceInterval: spec.sourceInterval ?? book?.sourceInterval } : {}),
      sourceTimestamp: null,
      receivedAt: this.now(),
      ...(book?.sequence != null ? { sequence: book.sequence } : {}),
      complete: false,
      gap: true,
      invalidated: true,
      resyncRequired: true,
      invalidReason,
      coverage: 'gap',
      units: book?.units ?? 'base',
      ...(book?.contractValue != null ? { contractValue: book.contractValue } : {}),
      ...(book?.pool != null ? { pool: book.pool } : {}),
      bids: [],
      asks: [],
    };
    if (!book) {
      // There is no server book to invalidate. Drop the empty adapter session
      // instead of retaining a larger diagnostic object without admission.
      feed.session = null;
      this.retainedDiagnosticsCache = null;
      return true;
    }
    const mutation = this.#stageRetainedDepthSession(id, feed, invalidatedSession, message);
    const emitted = this.#emit(id, spec.venue, message, mutation);
    if (emitted === false) return false;
    if (mutation && !mutation.committed) mutation.commit();
    return true;
  }
  #admitRetainedDepthSession(id: string, feed: LiveFeed, session: LiveDepthSession | null | undefined, message: LiveNormalizedMessage, socket: LiveFeedSocket | null) {
    const mutation = this.#stageRetainedDepthSession(id, feed, session, message);
    if (!mutation) return true;
    return this.#admitRetainedFeedMutation(id, socket, mutation.candidate, {
      kind: 'feed-session', bufferKind: 'depth-session', feedId: id,
      instrumentId: feed.spec.instrumentId, venue: feed.spec.venue,
    }, mutation.commit);
  }
  #emitBinanceInvalidation(id: string, spec: Pick<LiveFeedSpec, 'symbol' | 'marketType' | 'family'>, reason: unknown) {
    const instrumentId = binanceInstrumentId(spec.symbol, spec.marketType, spec.family);
    this.#emit(id, 'binance', { kind: 'depthSnapshot', instrumentId, sourceTimestamp: null, receivedAt: this.now(), complete: false, gap: true, invalidated: true, resyncRequired: true, invalidReason: reason ?? 'socket unavailable', coverage: 'partial', bids: [], asks: [] });
  }
  #emitHyperliquidBookInvalidation(id: string, spec: LiveFeedSpec | undefined, reason: unknown) {
    if (spec?.venue !== 'hyperliquid' || spec.channel !== 'l2Book' || !spec.instrumentId) return;
    this.#emit(id, 'hyperliquid', {
      kind: 'depthSnapshot', instrumentId: spec.instrumentId,
      bookKey: spec.bookKey, resolutionKey: spec.resolutionKey, resolution: spec.resolution,
      nSigFigs: spec.nSigFigs, mantissa: spec.mantissa,
      sourceTimestamp: null, receivedAt: this.now(),
      complete: false, gap: true, invalidated: true, resyncRequired: true,
      invalidReason: String(reason ?? 'socket unavailable'), coverage: 'gap', bids: [], asks: [],
    });
  }
  #invalidateBinanceDepth(id: string, spec: Pick<LiveFeedSpec, 'symbol' | 'marketType' | 'family'>, reason: unknown) {
    const key = binanceInstrumentId(spec.symbol, spec.marketType, spec.family);
    this.bookSequences.delete(key);
    this.depthBuffers.delete(key);
    this.depthBridgePending.delete(key);
    this.#emitBinanceInvalidation(id, spec, reason);
  }
  #deleteResyncing(key: string, token: BinanceResyncToken | null = null) {
    if (token && this.resyncing.get(key) !== token) return false;
    const deleted = this.resyncing.delete(key);
    if (deleted) this.retainedDiagnosticsCache = null;
    return deleted;
  }
  #clearResyncing() {
    if (!this.resyncing.size) return false;
    this.resyncing.clear();
    this.retainedDiagnosticsCache = null;
    return true;
  }
  #clearRetiredState() {
    this.bookSequences.clear(); this.depthBuffers.clear(); this.depthBridgePending.clear(); this.#clearResyncing(); this.#lastPrices.clear();
  }
  #publishActiveBookSets() {
    const activeBookSets: Record<string, string[]> = {};
    for (const spec of this.specs.values()) {
      if (!spec.instrumentId || (!spec.publicDepth && !['depth', 'l2Book', 'book'].includes(spec.channel))) continue;
      const key = spec.bookKey ?? bookKey(spec.instrumentId, spec.resolutionKey ?? 'native');
      (activeBookSets[spec.instrumentId] ??= []).push(key);
    }
    this.#setStatus('active-book-set', { activeBookSets });
  }
  #bufferBinanceDepth(id: string, key: string, message: LiveNormalizedMessage, socket: LiveFeedSocket | null) {
    const buffered = this.depthBuffers.get(key) ?? [];
    if (message.sequence == null || buffered.some((item) => item.sequence === message.sequence)) return true;
    const next = [...buffered, message].sort((a, b) => Number(a.sequence ?? 0) - Number(b.sequence ?? 0)).slice(-500);
    return this.#admitRetainedFeedBuffer(id, socket, { kind: 'binance-depth-bridge', instrumentId: key, message }, () => {
      this.depthBuffers.set(key, next);
      return true;
    });
  }
  #replayBinanceDepth({ symbol, marketType }: AdapterOptions, snapshot: LiveNormalizedMessage & {instrumentId: string}) {
    const key = snapshot.instrumentId;
    const buffered = this.depthBuffers.get(key) ?? [];
    let expected = Number(snapshot.sequence);
    let bridged = false;
    let allowInitialOverlap = this.depthBridgePending.get(key) === true;
    for (const message of buffered) {
      const sequence = Number(message.sequence);
      if (!Number.isFinite(sequence) || sequence <= expected) continue;
      const first = Number(message.firstUpdate ?? (Number(message.previousSequence) + 1));
      const coversSpotRange = marketType === 'spot' && Number.isFinite(first) && first <= Number(expected) + 1 && sequence >= Number(expected) + 1;
      const covers = message.previousSequence === expected || coversSpotRange || (allowInitialOverlap && Number.isFinite(first) && first <= Number(expected) + 1 && sequence >= Number(expected) + 1);
      if (!covers) {
        this.#setStatus('binance-depth', { state: 'unavailable', lastError: `depth bridge gap: expected ${expected}, got ${message.previousSequence}` });
        this.depthBuffers.delete(key);
        this.depthBridgePending.delete(key);
        return null;
      }
      const delivered = message.previousSequence === expected ? message : { ...message, previousSequence: expected };
      const emitted = this.#emit('binance-depth', 'binance', delivered);
      if (emitted === false) return 'admission-denied' as const;
      expected = sequence;
      allowInitialOverlap = false;
      bridged = true;
    }
    this.depthBuffers.delete(key);
    return bridged;
  }
  async #resyncBinanceDepth(spec: LiveFeedSpec) {
    const key = binanceInstrumentId(spec.symbol, spec.marketType, spec.family);
    if (this.resyncing.has(key)) return;
    const feed = this.feeds.get('binance-depth');
    const generation = feed?.generation ?? null;
    const token = { generation };
    let committed = false;
    const commit = () => {
      if (committed) return;
      this.resyncing.set(key, token);
      this.retainedDiagnosticsCache = null;
      committed = true;
    };
    const admitted = this.#admitRetainedFeedMutation('binance-depth', feed?.socket ?? null, {
      kind: 'feed-binance-resync-flight', feedId: 'binance-depth', venue: 'binance',
      instrumentId: key, generation,
    }, {
      kind: 'feed-resync-flight', feedId: 'binance-depth', venue: 'binance',
      instrumentId: key, generation,
    }, commit);
    if (!admitted) return;
    if (!committed) {
      this.#fail('binance-depth', new Error('retained resync admission did not commit its mutation'), feed?.socket ?? null);
      return;
    }
    try {
      const snapshot = await this.syncBinanceDepth({ symbol: spec.symbol ?? '', marketType: spec.marketType, family: spec.family, metadata: spec.metadata });
      if (!this.#isCurrentBinanceDepthFeed(feed, generation) || this.resyncing.get(key) !== token) return;
      if (!snapshot && feed) this.#retryFailedBinanceSnapshot(feed, generation, spec);
    } finally {
      this.#deleteResyncing(key, token);
    }
  }
  #retryFailedBinanceSnapshot(feed: LiveFeed, generation: number | null | undefined, spec: LiveFeedSpec) {
    if (!feed.socket || !this.#isCurrentBinanceDepthFeed(feed, generation) || this.specs.get('binance-depth') !== spec) return;
    // Deltas cannot repair a failed REST bridge. Release this transport before
    // the existing single, generation-fenced timer opens its replacement.
    const reason = String(this.#getStatus('binance-depth').lastError ?? 'depth resync failed');
    this.#fail('binance-depth', new Error(reason), feed.socket);
    if (this.running && this.feeds.get('binance-depth') === feed && this.specs.get('binance-depth') === spec) {
      this.#setStatus('binance-depth', { state: 'unavailable', lastError: reason });
    }
  }
  #fail(id: string, error: unknown, socket: LiveFeedSocket | null = null) {
    const feed = this.feeds.get(id);
    if (socket && feed?.socket !== socket) return;
    if (feed && !feed.retired) this.#emitHyperliquidBookInvalidation(id, feed.spec, feedError(error).message ?? 'socket error');
    if (feed?.spec.venue === 'bybit' && feed.session) { const reason = boundedDepthInvalidReason(feedError(error).message ?? 'socket error'); feed.retired = true; retireLiveFeedSocket(feed.socket); this.#emitDepthSessionInvalidation(id, feed, invalidateBybitDepthSession(feedSession(feed, createBybitDepthSession, 'bybit'), reason), reason); }
    if (feed?.spec.publicDepth && feed.spec.venue !== 'bybit' && feed.session) this.#recoverPublicDepth(id, feed, feedError(error).message ?? 'socket error');
    if (feed?.spec.venue === 'binance' && feed?.spec.channel === 'depth') {
      const key = feed.spec.symbol ? binanceInstrumentId(feed.spec.symbol, feed.spec.marketType, feed.spec.family) : '';
      this.#emitBinanceInvalidation(id, feed.spec, feedError(error).message ?? 'socket error');
      this.bookSequences.delete(key);
      this.depthBuffers.delete(key);
      this.depthBridgePending.delete(key);
    }
    if (feed && !feed.retired) feed.retired = true;
    this.#releaseTransport(feed);
    retireLiveFeedSocket(feed?.socket);
    this.#setStatus(id, { state: 'backoff', lastError: feedError(error).message ?? String(error) });
    this.#scheduleReconnect(id);
  }
  #closed(id: string, reason: unknown, socket: LiveFeedSocket | null = null) {
    if (this.running) {
      const feed = this.feeds.get(id);
      if (socket && feed?.socket !== socket) return;
      if (feed?.retired) return;
      this.#emitHyperliquidBookInvalidation(id, feed?.spec, reason ?? 'socket closed');
      // A closed socket can still deliver a queued frame in some runtimes.
      // Retire it before scheduling the replacement so those late frames
      // cannot enter the next Binance snapshot/delta sequence.
      const publicDepthRecovery = feed?.spec.publicDepth && feed.spec.venue !== 'bybit' && feed.session;
      if (publicDepthRecovery) this.#recoverPublicDepth(id, feed, reason ?? 'socket closed');
      else if (feed) feed.retired = true;
      if (feed?.spec.venue === 'bybit' && feed.session) { const invalidReason = boundedDepthInvalidReason(reason ?? 'socket closed'); feed.retired = true; this.#emitDepthSessionInvalidation(id, feed, invalidateBybitDepthSession(feedSession(feed, createBybitDepthSession, 'bybit'), invalidReason), invalidReason); }
      if (feed?.spec.venue === 'binance' && feed?.spec.channel === 'depth') {
        const key = binanceInstrumentId(feed.spec.symbol, feed.spec.marketType, feed.spec.family);
        this.#emitBinanceInvalidation(id, feed.spec, reason ?? 'socket closed');
        this.bookSequences.delete(key);
        this.depthBuffers.delete(key);
        this.depthBridgePending.delete(key);
        this.#deleteResyncing(key);
      }
      this.#releaseTransport(feed);
      this.#setStatus(id, { state: 'backoff', lastError: reason ? String(reason) : 'socket closed' });
      this.#scheduleReconnect(id);
    }
  }
  #scheduleReconnect(id: string, { unavailable = false }: { unavailable?: boolean } = {}) {
    const feed = this.feeds.get(id); const spec = this.specs.get(id); if (!this.running || !spec) return;
    const status = this.#getStatus(id); if (feed && feed.retry !== null) return;
    // A denied open advances the fence while its old placeholder stays owned.
    const generation = this.feedGenerations.get(id) ?? feed?.generation;
    const attempt = (status.attempt ?? 0) + 1; const delay = reconnectDelay(attempt, { baseMs: this.reconnectBaseMs, maxMs: this.reconnectMaxMs }); const nextRetryAt = this.now() + delay;
    const retry = this.schedule(async () => {
      const current = this.feeds.get(id);
      if (!this.running || this.specs.get(id) !== spec || this.feedGenerations.get(id) !== generation || current?.retry !== retry) return;
      if (current) current.retry = null;
      if (spec.venue === 'kucoin' && this.restTransport?.request) await this.syncKucoinPublicToken();
      if (spec.channel === 'depth' && spec.venue === 'binance') {
        if (await this.#open(id, spec) === false) return;
        const opened = this.feeds.get(id);
        const openedGeneration = opened?.generation;
        if (!opened || !this.#isCurrentBinanceDepthFeed(opened, openedGeneration) || this.specs.get(id) !== spec) return;
        const snapshot = await this.syncBinanceDepth({ symbol: spec.symbol ?? '', marketType: spec.marketType, family: spec.family, metadata: spec.metadata });
        if (!this.#isCurrentBinanceDepthFeed(opened, openedGeneration) || this.specs.get(id) !== spec) return;
        if (!snapshot) {
          this.#retryFailedBinanceSnapshot(opened, openedGeneration, spec);
          return;
        }
        return snapshot;
      }
      return this.#open(id, spec);
    }, delay);
    if (feed) feed.retry = retry; else this.feeds.set(id, { id, socket: null, spec, generation, retry, retired: false });
    this.#setStatus(id, { state: unavailable ? 'unavailable' : 'backoff', attempt, nextRetryAt, ...(unavailable ? { active: false, lastError: 'retained-data admission rejected' } : {}) });
  }
  #recoverPublicDepth(id: string, feed: LiveFeed, reason: unknown) {
    if (!feed || feed.retired) return;
    feed.retired = true;
    this.#releaseTransport(feed);
    retireLiveFeedSocket(feed.socket);
    const invalidReason = boundedDepthInvalidReason(reason);
    const invalidatedSession = feed.spec.venue === 'bitfinex' ? invalidateBitfinexDepthSession(feedSession(feed, createBitfinexDepthSession, 'bitfinex'), invalidReason) : feed.spec.venue === 'bitmex' ? invalidateBitmexDepthSession(feedSession(feed, createBitmexDepthSession, 'bitmex'), invalidReason) : feed.spec.venue === 'cryptocom' ? invalidateCryptocomDepthSession(feedSession(feed, createCryptocomDepthSession, 'cryptocom'), invalidReason) : feed.spec.venue === 'phemex' ? invalidatePhemexDepthSession(feedSession(feed, createPhemexDepthSession, 'phemex'), invalidReason) : invalidatePublicDepthSession(feedSession(feed, createPublicDepthSession, 'public'), invalidReason);
    this.#emitDepthSessionInvalidation(id, feed, invalidatedSession, invalidReason);
    this.#setStatus(id, { state: 'backoff', lastError: invalidReason });
    this.#scheduleReconnect(id);
  }
  #scheduleOiPoll(params: AdapterOptions, generation = this.configurationGeneration) {
    if (!this.running || generation !== this.configurationGeneration || !(this.oiPollMs > 0)) return;
    this.oiTimer = this.schedule(async () => {
      if (!this.running || generation !== this.configurationGeneration) return;
      this.oiTimer = null;
      await this.pollOpenInterest(params);
      this.#scheduleOiPoll(params, generation);
    }, this.oiPollMs);
  }
  #decodeHyperliquidBook(raw: unknown, coin: string, grouping: Pick<LiveFeedSpec, 'nSigFigs' | 'mantissa' | 'resolutionKey' | 'bookKey'>) {
    return normalizeHyperliquidBook(this.#json(raw), {
      coin, nSigFigs: grouping.nSigFigs, mantissa: grouping.mantissa,
      resolutionKey: grouping.resolutionKey, bookKey: grouping.bookKey,
      feedId: grouping.resolutionKey === 'native' ? 'hl-l2Book-native' : 'hl-l2Book', receivedAt: this.now(),
    });
  }
  #decodeHyperliquidContext(raw: unknown, coin: string) { const payload = this.#json(raw); const data = feedRecord(payload)?.data ?? payload; return normalizeHyperliquidAssetContext({ data: { time: feedRecord(data)?.time, context: feedRecord(data)?.ctx ?? feedRecord(data)?.context ?? data } }, { coin, receivedAt: this.now() }); }
  #decodeHyperliquidCandle(raw: unknown, coin: string, interval: string) { const payload = this.#json(raw); const data = feedRecord(payload)?.data ?? payload; const row = feedRecord(data)?.candle ?? feedRecord(data)?.data ?? (Array.isArray(data) ? data.at(-1) : data); return row ? { kind: 'candle', ...normalizeHyperliquidCandle(row, { coin, interval, receivedAt: this.now() }), source: 'live', quality: 'native' } : null; }
  #decodeHyperliquidTrades(raw: unknown, coin: string) { return normalizeHyperliquidTrades(this.#json(raw), { coin, receivedAt: this.now() }); }
  #decodeBinanceDepth(raw: unknown, options: AdapterOptions) {
    const payload = this.#json(raw), data = feedRecord(payload).data ?? payload;
    return feedRecord(data).b || feedRecord(data).a
      ? normalizeBinanceDepthDelta(data, { ...options, receivedAt: this.now() })
      : normalizeBinanceDepth(data, { ...options, receivedAt: this.now() });
  }
  #decodeBinanceMark(raw: unknown, symbol: string, marketType: string, family = 'usdm') {
    const payload = this.#json(raw), data = feedRecord(payload).data ?? payload;
    const price = finitePrice(feedRecord(data).p);
    return { kind: 'price', venue: 'binance', instrumentId: binanceInstrumentId(symbol, marketType, family),
      sourceTimestamp: explicitProviderTime(feedRecord(data).E ?? (marketType === 'spot' ? feedRecord(data).T : null)),
      receivedAt: this.now(), price, marketType };
  }
  #decodeBinanceTrades(raw: unknown, options: AdapterOptions) { return normalizeBinanceAggTrade(this.#json(raw), { ...options, receivedAt: this.now() }); }
  #decodeBinanceKline(raw: unknown, options: AdapterOptions) {
    const payload = this.#json(raw), data = feedRecord(payload).data ?? payload;
    const row = feedRecord(data).kline ?? feedRecord(data).k ?? data;
    return row ? { kind: 'candle', ...normalizeBinanceKline(row, { ...options, receivedAt: this.now() }), source: 'live', quality: 'native' } : null;
  }
  #decodeBybitDepth(payload: unknown, options: AdapterOptions) {
    const wireSymbol = feedRecord(feedRecord(payload).data).s;
    const expected = String(options.symbol ?? '').replaceAll('-', '').toUpperCase();
    if (wireSymbol == null || String(wireSymbol).replaceAll('-', '').toUpperCase() !== expected) throw new TypeError('Bybit payload symbol mismatch');
    if (feedRecord(payload).type === 'snapshot') return normalizeBybitDepth(payload, { ...options, receivedAt: this.now() });
    if (feedRecord(payload).type === 'delta') return normalizeBybitDepthDelta(payload, { ...options, receivedAt: this.now() });
    throw new TypeError('Malformed Bybit depth payload type');
  }
  #decodeOkxDepth(raw: unknown, options: AdapterOptions) {
    const payload = this.#json(raw);
    const wire = feedRecord(feedRecord(payload).arg).instId ?? feedRecord(feedRecord(feedRecord(payload).data)[0]).instId;
    if (wire != null && String(wire).toUpperCase() !== String(options.instId ?? '').toUpperCase()) throw new TypeError('OKX payload instrument mismatch');
    return normalizeOkxDepth(payload, { ...options, receivedAt: this.now() });
  }
  #decodeBitgetDepth(raw: unknown, options: AdapterOptions) {
    const payload = this.#json(raw), arg = feedRecord(feedRecord(payload).arg);
    const wire = arg.symbol ?? arg.instId ?? feedRecord(feedRecord(feedRecord(payload).data)[0]).symbol;
    if (wire != null && String(wire).toUpperCase() !== String(options.symbol ?? '').toUpperCase()) throw new TypeError('Bitget payload symbol mismatch');
    return normalizeBitgetDepth(payload, { ...options, receivedAt: this.now() });
  }
  #decodeGateDepth(raw: unknown, symbol: string, request: LiveFeedRequest = {}) { const payload = this.#json(raw); const wire = feedRecord(feedRecord(payload)?.result)?.contract ?? feedRecord(payload)?.contract; if (wire != null && String(wire).toUpperCase() !== String(symbol).replaceAll('-', '_').toUpperCase()) throw new TypeError('Gate.io payload contract mismatch'); return normalizeGateDepth(payload, { contract: String(symbol ?? ''), receivedAt: this.now(), contractValue: request.contractValue == null ? undefined : Number(request.contractValue) }); }
  #decodeDeribitDepth(raw: unknown, symbol: string, request: LiveFeedRequest = {}) { const payload = this.#json(raw); const wire = feedRecord(feedRecord(feedRecord(payload)?.params)?.data)?.instrument_name ?? feedRecord(feedRecord(payload)?.result)?.instrument_name; if (wire != null && String(wire).toUpperCase() !== String(symbol).toUpperCase()) throw new TypeError('Deribit payload instrument mismatch'); return normalizeDeribitDepth(payload, { instrumentName: String(symbol ?? ''), sourceGrouping: request.sourceGrouping, sourceDepth: request.sourceDepth, sourceInterval: request.sourceInterval, receivedAt: this.now() }); }
  #decodeCoinbaseDepth(raw: unknown, symbol: string) { return normalizeCoinbaseDepth(this.#json(raw), { productId: String(symbol ?? ''), receivedAt: this.now() }); }
  #decodeKrakenDepth(raw: unknown, symbol: string) { return normalizeKrakenDepth(this.#json(raw), { symbol, receivedAt: this.now() }); }
  #decodeKucoinDepth(raw: unknown, symbol: string) { return normalizeKucoinDepth(this.#json(raw), { symbol, receivedAt: this.now() }); }
  #decodeMexcDepth(raw: unknown, symbol: string, request: LiveFeedRequest = {}) { return normalizeMexcDepth(this.#json(raw), { symbol, depth: request.depth == null ? undefined : Number(request.depth), snapshot: true, receivedAt: this.now(), contractValue: request.contractValue == null ? undefined : Number(request.contractValue) }); }
  #decodeHtxDepth(raw: unknown, symbol: string, request: LiveFeedRequest = {}) { return normalizeHtxDepth(this.#json(raw), { symbol, type: typeof request.type === 'string' ? request.type : undefined, receivedAt: this.now(), contractValue: request.contractValue == null ? undefined : Number(request.contractValue) }); }
  #decodeBitfinexDepth(raw: unknown, symbol: string) { return normalizeBitfinexDepth(this.#json(raw), { symbol, receivedAt: this.now() }); }
  #decodeBitmexDepth(raw: unknown, symbol: string, request: LiveFeedRequest = {}) { return normalizeBitmexDepth(this.#json(raw), { symbol, table: request.table, receivedAt: this.now() }); }
  #decodeCryptocomDepth(raw: unknown, symbol: string, request: LiveFeedRequest = {}) { return normalizeCryptocomDepth(this.#json(raw), { instrumentName: String(symbol ?? ''), depth: request.depth == null ? undefined : Number(request.depth), receivedAt: this.now() }); }
  #decodeBitstampDepth(raw: unknown, symbol: string) { return normalizeBitstampDepth(this.#json(raw), { symbol, receivedAt: this.now(), requireChannel: true }); }
  #decodeWhitebitDepth(raw: unknown, symbol: string) { return normalizeWhitebitDepth(this.#json(raw), { symbol, receivedAt: this.now() }); }
  #decodePhemexDepth(raw: unknown, symbol: string, request: LiveFeedRequest = {}) { return normalizePhemexDepth(this.#json(raw), { symbol, metadata: request.metadata ?? {}, receivedAt: this.now() }); }
  #decodeDydxTrades(raw: unknown, symbol: string) { return normalizeDydxTrades(this.#json(raw), { symbol, receivedAt: this.now() }); }
  #decodeAsterTrades(raw: unknown, symbol: string) { return normalizeAsterTrades(this.#json(raw), { symbol, receivedAt: this.now() }); }
  #decodeDydxDepth(raw: unknown, symbol: string) {
    const nativeSymbol = String(symbol).replaceAll('_', '-').toUpperCase();
    const metadata = (this.dydxMetadata as ReturnType<typeof normalizeDydxMarkets> | null)?.assets.find(asset => asset.nativeSymbol === nativeSymbol);
    if (!metadata) throw new TypeError('dYdX depth requires verified native market metadata');
    return normalizeDydxDepth(this.#json(raw), { symbol, receivedAt: this.now(), metadata });
  }
  #decodeAsterDepth(raw: unknown, symbol: string) {
    const metadata = (this.asterMetadata as ReturnType<typeof normalizeAsterMarkets> | null)?.assets.find(asset => asset.nativeSymbol === String(symbol).toUpperCase());
    if (!metadata) throw new TypeError('Aster depth requires verified native market metadata');
    return normalizeAsterDepth(this.#json(raw), { symbol, receivedAt: this.now(), metadata });
  }
  #json(raw: unknown, { preserveKrakenDecimals = false }: { preserveKrakenDecimals?: boolean } = {}): unknown {
    if (typeof raw === 'string' || raw instanceof Uint8Array || Buffer.isBuffer(raw)) {
      const textFrame = typeof raw === 'string';
      const bytes = typeof raw === 'string' ? null : Buffer.from(raw);
      let text = typeof raw === 'string' ? raw : '';
      let decodedBytes = typeof raw === 'string' ? Buffer.byteLength(raw, 'utf8') : Number(bytes?.byteLength ?? 0);
      const compressed = bytes !== null && bytes[0] === 0x1f && bytes[1] === 0x8b;
      if (compressed && bytes) {
        try {
          const expanded = gunzipSync(bytes, { maxOutputLength: MAX_LIVE_FEED_MESSAGE_BYTES });
          decodedBytes = expanded.byteLength;
          text = decodeLiveFeedUtf8(expanded);
        } catch (error) {
          if (feedError(error).code === 'ERR_BUFFER_TOO_LARGE') throw liveFeedMessageLimitError('expanded');
          throw error;
        }
      } else if (bytes) {
        text = decodeLiveFeedUtf8(bytes);
      }
      if (text.trim() === 'pong') return 'pong';
      let complexity;
      try {
        complexity = scanBoundedJsonComplexity(text, {
          maxTokens: DEFAULT_BOUNDED_JSON_RESPONSE_TOKENS,
          maxDepth: DEFAULT_BOUNDED_JSON_RESPONSE_DEPTH,
          label: 'Live feed',
        });
      } catch (error) {
        feedRecord(error).transportFatal = true;
        throw error;
      }
      const reservation = this.activeMessageMemoryReservation;
      if (reservation) {
        if (typeof reservation.resize !== 'function') throw liveFeedProcessMemoryError({ reason: 'reservation-resize-unavailable' }, 'before-parse');
        const parseReservationBytes = (decodedBytes * 2) + (compressed ? Number(bytes?.byteLength ?? 0) : 0) + complexity.tokens * DEFAULT_BOUNDED_JSON_TOKEN_MEMORY_BYTES;
        let resized;
        try { resized = reservation.resize(parseReservationBytes); }
        catch { throw liveFeedProcessMemoryError({ reason: 'reservation-resize-error', requestedBytes: parseReservationBytes }, 'before-parse'); }
        if (resized?.admitted !== true) throw liveFeedProcessMemoryError({ ...resized, requestedBytes: parseReservationBytes }, 'before-parse');
      }
      return preserveKrakenDecimals ? parseKrakenBookJson(text) : JSON.parse(text);
    }
    return raw;
  }
}
function extractCandleRows(payload: unknown): unknown[] {
  const data = feedRecord(payload)?.data ?? payload;
  if (Array.isArray(data)) return data;
  if (Array.isArray(feedRecord(data)?.candles)) return feedArray(feedRecord(data).candles);
  if (Array.isArray(feedRecord(data)?.klines)) return feedArray(feedRecord(data).klines);
  const row = feedRecord(data)?.candle ?? feedRecord(data)?.kline ?? feedRecord(data)?.k ?? data;
  return row && typeof row === 'object' && (feedRecord(row).t != null || feedRecord(row).start != null || feedRecord(row)[0] != null) ? [row] : [];
}
function finitePrice(value: unknown) { const n = Number(value); if (!(Number.isFinite(n) && n > 0)) throw new TypeError('Invalid Binance mark price'); return n; }

/** Optional production socket factory. Importing ws is lazy and therefore safe offline. */
export async function createWsTransport({ request, venue = 'binance', marketType = 'perpetual', channel = null, handshakeTimeoutMs = 12_000 }: LiveFeedTransportOptions) {
  const mod = await import('ws');
  const WebSocket = mod.WebSocket ?? mod.default;
  const binanceFallbackUrl = marketType === 'spot'
    ? BINANCE_SPOT_WS_URL
    : channel === 'depth' ? BINANCE_FUTURES_WS_URL : BINANCE_FUTURES_MARKET_WS_URL;
  const url = request.url ?? (venue === 'hyperliquid' ? HYPERLIQUID_WS_URL : venue === 'bybit' ? BYBIT_LINEAR_WS_URL : venue === 'okx' ? OKX_PUBLIC_WS_URL : venue === 'bitget' ? BITGET_PUBLIC_WS_URL : venue === 'gateio' ? GATEIO_USDT_WS_URL : venue === 'deribit' ? DERIBIT_PUBLIC_WS_URL : venue === 'coinbase' ? COINBASE_PUBLIC_WS_URL : venue === 'kraken' ? KRAKEN_PUBLIC_WS_URL : venue === 'kucoin' ? KUCOIN_PUBLIC_WS_URL : venue === 'mexc' ? MEXC_CONTRACT_WS_URL : venue === 'htx' ? HTX_USDT_WS_URL : venue === 'bitfinex' ? BITFINEX_PUBLIC_WS_URL : venue === 'bitmex' ? BITMEX_PUBLIC_WS_URL : venue === 'cryptocom' ? CRYPTOCOM_PUBLIC_WS_URL : venue === 'bitstamp' ? BITSTAMP_PUBLIC_WS_URL : venue === 'whitebit' ? WHITEBIT_PUBLIC_WS_URL : venue === 'phemex' ? PHEMEX_PUBLIC_WS_URL : venue === 'dydx' ? DYDX_PUBLIC_WS_URL : venue === 'aster' ? ASTER_PUBLIC_WS_URL : binanceFallbackUrl);
  if (!Number.isSafeInteger(handshakeTimeoutMs) || handshakeTimeoutMs < 1) throw new TypeError('WebSocket handshake timeout must be a positive integer');
  // Per-message deflate costs ~16 % of the server's CPU with two dozen venues; this is a local workbench, so bandwidth is the cheaper resource.
  const socketOptions = { maxPayload: liveFeedMessageLimitBytes({ request, venue, marketType, channel }), handshakeTimeout: handshakeTimeoutMs, perMessageDeflate: false };
  const socket = new WebSocket(url, socketOptions);
  let openingError: unknown;
  const opened = waitForLiveFeedSocketOpen(socket, handshakeTimeoutMs, cause => { openingError = cause; });
  return { socket, send: (payload: string) => socket.send(payload), close: () => socket.close(), terminate: () => socket.terminate(), open: () => opened, on(event: string, listener: (payload: unknown) => void) { socket.on(event, event === 'error' ? cause => listener(openingError ?? cause) : listener); } };
}
