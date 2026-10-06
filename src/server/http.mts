
import { readOrderbookControlBody, ORDERBOOK_CONTROL_PARSE_BYTES, type OrderbookControlBody } from './orderbook-control-body.mts';
import { readOrderbookVenueCatalog, validateOrderbookVenueChoice, type OrderbookVenueCatalog } from '../core/orderbook-venue-controls.mts';
import type { AddressInfo } from 'node:net';
import type { TradeRecord, OpenInterestSample } from '../domain/contracts.ts';
import type { SortedBook } from '../core/normalize.mts';
import type { ProcessMemoryReservation } from './process-memory.mts';
import type { ProviderClient, ProviderResourceResult, MarkCrossingAccumulator, PublishMarkOptions } from './http-contracts.mts';
import { recordValue } from '../adapters/common.mts';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { RuntimeState, RuntimeBook, RuntimeCandle, RuntimeMessage, RuntimeStatus, RuntimeLevel } from '../domain/runtime-state.mts';
import type { PublishedRetainedBudget } from './retained-budget.mts';
import type { TransientResponseMemory, JsonResponseSink, StateStreamResponse, ServerStreamFrame, ServerQueue, ServerMetrics, LocalServerOptions, AttachStreamOptions, RouteServices, FeedOwner, CandleReclaimOptions, BookSerializationOptions, DepthMarketState, AdmissionEstimate, MutationContext, MutationReservation, MutationResult, ProviderRefreshResult } from './http-contracts.mts';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { types as nodeTypes } from 'node:util';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import { cloneFixtureState } from '../core/fixture-state.mts';
import { applyMarkPrice, crossingDirection, crossingTargetKey } from '../core/crossing.mts';
import { applyBookDelta, applySortedDelta, bookFromSnapshot, sortedBook, sortedBookFromSortedSnapshot } from '../core/normalize.mts';
import { QuotaLedger, providerRequestAllowed } from '../core/quota.mts';
import { DEFAULT_REFRESH_MS } from '../core/constants.mts';
import { requireSymbol } from '../adapters/common.mts';
import { hyperTrackerCompleteness, hyperTrackerSourceTimestamp, normalizeHyperTrackerSnapshot } from '../adapters/hypertracker.mts';
import type { HyperTrackerRetentionMeasurement } from '../adapters/hypertracker.mts';
import { validatePublicProductDiscoverySelection } from './product-discovery.mts';
import type { PublicCatalogReply, PublicMarketControls } from './http-contracts.mts';
import { publicMarketFeedOptions } from './public-market-selection.mts';
import { LatestOnlyFrameQueue, LocalEventBus } from './realtime.mts';
import { LIVE_STATE_TAIL_LIMITS, projectLiveStateTail } from './live-state-tail.mts';
import { nativeOiBootstrapWorkingBytes, projectNativeOiBootstrap } from './native-oi-bootstrap.mts';
import { advanceNativeTailRecovery, candleOutsideNativeTail, oiOutsideNativeTail, nativeTailRecoveryRevision, nativeTailBaselineMatches } from './native-tail-recovery.mts';
import { RETAINED_STATE_BASELINE_VERSION } from '../core/retained-state-baseline.mts';
import { ORDERBOOK_VENUE_REGISTRY_WIRE_BYTES } from '../core/orderbook-venue-registry.mts';
import { LIVE_LIQUIDITY_MAX_FRAME_BYTES } from '../core/liquidity-frame.mts';
import { encodeNativeBookWireAliases, NATIVE_BOOK_WIRE_ALIASES_VERSION, NATIVE_BOOK_WIRE_ALIASES_WORKING_BYTES, NATIVE_BOOK_WIRE_ALIASES_RESULT_CONTROL_BYTES } from '../core/native-book-wire-aliases.mts';
import { LIVE_LIQUIDITY_WIRE_BOUND_VERSION, parseLiquidityWireBound, liquidityWireTextBytes } from '../core/liquidity-wire-bound.mts';
import { LiquidityWireCapacityError, requireLiquidityWireCapacity, liquidityWireSessionId, LIQUIDITY_WIRE_MEASUREMENT_SCRATCH_BYTES } from './liquidity-wire-bound.mts';
import { HistoryStore } from './history.mts';
import { scanBoundedJsonComplexity } from '../core/bounded-json-response.mts';
import { retireOwnedStoragePayload } from './retire-storage-payload.mts';
import { FootprintTransport } from './footprint-transport.mts';
import { FOOTPRINT_RECLAIM_MAX_WORKING_BYTES } from '../core/footprint-model.mts';
import { venueRegistrySnapshot } from '../domain/venue-registry.mts';
import { applyFeedStatus, venueForFeedId } from '../core/venue-status.mts';
import { annotateBookCoverage } from '../core/book-coverage.mts';
import { bookKey, bookResolutionKey } from '../core/book-key.mts';
import { MARK_CROSSING_LIMIT, mergeMarkPayload } from '../core/mark-events.mts';
import { COMPACT_BOOK_LEVELS_PER_SIDE, DEFAULT_SERVER_BOOK_LEVELS_PER_SIDE, representationLimits, representationMetadata } from '../core/representation-limits.mts';
import { logicalRetainedBytes } from '../core/retained-bytes.mts';
import { planRetainedBudget } from '../core/retained-budget.mts';
import { normalizeServerRamLimits } from './retained-budget.mts';
import { ProcessMemoryMonitor } from './process-memory.mts';
import { guardRequest } from './request-guard.mts';

function errorMessage(error: unknown): string { return error instanceof Error ? error.message : String(error); }

function sameProviderCrossingTarget(prior: RuntimeLevel | undefined, next: RuntimeLevel, layer: string, instrumentId: string | undefined) {
  if (!prior || prior.layer !== layer || (next.layer != null && next.layer !== layer)
      || String(prior.instrumentId ?? instrumentId) !== String(instrumentId)
      || String(next.instrumentId ?? instrumentId) !== String(instrumentId)
      || prior.side !== next.side || Number(prior.price) !== Number(next.price)) return false;
  return ['priceTo', 'priceLow', 'priceHigh'].every((key) => {
    const left = prior[key]; const right = next[key];
    if (left == null && right == null) return true;
    return left != null && right != null && Number.isFinite(Number(left))
      && Number.isFinite(Number(right)) && Number(left) === Number(right);
  });
}


const sourceWebRoot = path.join(process.cwd(), 'src', 'app');
const defaultQuotaPath = path.join(process.cwd(), 'data', 'runtime', 'provider-quota.json');
const defaultHistoryPath = path.join(process.cwd(), 'data', 'runtime', 'history.sqlite');
const SERVER_CANDLE_SERIES_LIMIT = 64;
const SSE_CLIENT_RETAINED_OVERHEAD_BYTES = 4_096;
const HTTP_STATE_RESPONSE_BASE_RESERVATION_BYTES = 512 * 1024;
const HTTP_STATE_RESPONSE_MAX_JSON_BYTES = 16 * 1024 * 1024;
// Matches the existing bounded browser history reader; the default route is unchanged.
const HTTP_CANDLE_DISPLAY_MAX_JSON_BYTES = 512 * 1024;
// Optional history hints share the existing browser token/depth ceilings. The
// scanner retains scalars only; its result/header and bounded failure shells are
// charged throughout the admitted writer, with no parsed graph or text copy.
const HTTP_HISTORY_JSON_SCAN_CONTROL_BYTES = 16 * 1024;
const HTTP_STATE_RESPONSE_BOOK_ENTRY_COPY_BYTES = 4 * 1024;
const HTTP_STATE_RESPONSE_LEVEL_TEMPORARY_BYTES = 256;
const HTTP_STATE_RESPONSE_CANDLE_ROW_REFERENCE_BYTES = 16;
const HTTP_STATE_RESPONSE_BODY_COPIES = 2;
const HTTP_DIAGNOSTICS_BUILD_RESERVATION_BYTES = 16 * 1024 * 1024;
const LIVE_FEED_STATUS_ID_LIMIT = 96;
const LIVE_FEED_STATUS_ERROR_LIMIT = 512;
const LIVE_FEED_STATUS_FRESHNESS_INTERVAL_MS = 5_000;
const LIVE_FEED_FAILURE_STATES = new Set(['backoff', 'connecting', 'unavailable']);
function liveFeedStatusTime(value: unknown) {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value !== 'number' && (typeof value !== 'string' || value.length > 32)) return null;
  const numeric = Number(value);
  return Number.isSafeInteger(numeric) && numeric >= 0 ? numeric : null;
}
function liveFeedStatusCounter(value: unknown) {
  if (typeof value !== 'number' && (typeof value !== 'string' || value.length > 16)) return null;
  const numeric = Number(value);
  return Number.isSafeInteger(numeric) && numeric >= 0 ? numeric : null;
}
export const MAX_PROVIDER_REFRESH_FLIGHTS = 16;
const MAX_PROVIDER_COIN_LENGTH = 64;
const MAX_PROVIDER_FLIGHT_KEY_BYTES = 1_024;
const PROVIDER_FLIGHT_ENTRY_OVERHEAD_BYTES = 512;
export const MAX_DIAGNOSTICS_CACHE_BYTES = 256 * 1024;
const DIAGNOSTICS_CACHE_STAGING_ALLOWANCE_BYTES = MAX_DIAGNOSTICS_CACHE_BYTES * 2 + 32 * 1024;
const contentTypes: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.webmanifest': 'application/manifest+json; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.wasm': 'application/wasm' };

export function parseFixtureFeedCount(value: unknown, max = 64) {
  const numeric = Number(value ?? 0);
  if (!Number.isInteger(numeric) || numeric < 0 || numeric > max) throw new Error(`FIXTURE_FEED_COUNT must be an integer between 0 and ${max}`);
  return numeric;
}

export function parseFixtureBookLevels(value: unknown, max = 128) {
  const numeric = Number(value ?? 2);
  if (!Number.isInteger(numeric) || numeric < 2 || numeric > max) throw new Error(`FIXTURE_BOOK_LEVELS must be an integer between 2 and ${max}`);
  return numeric;
}

export function parseFixtureBookBurstCount(value: unknown, max = 32) {
  const numeric = Number(value ?? 1);
  if (!Number.isInteger(numeric) || numeric < 1 || numeric > max) throw new Error(`FIXTURE_BOOK_BURST_COUNT must be an integer between 1 and ${max}`);
  return numeric;
}

export function parseFixtureBookInstrumentIds(value: unknown, max = 64) {
  const raw = String(value ?? '').trim();
  if (!raw) return [];
  const ids = raw.split(',').map((item) => item.trim()).filter(Boolean);
  if (ids.length > max || ids.some((id) => id.length > 160)) throw new Error(`FIXTURE_BOOK_INSTRUMENT_IDS must contain at most ${max} bounded instrument ids`);
  return [...new Set(ids)];
}

function jsonText(res: JsonResponseSink, body: string, status = 200, historyJsonTokens?: number) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store',
    'content-length': String(Buffer.byteLength(body, 'utf8')),
    ...(historyJsonTokens === undefined ? {} : { 'x-hlm-history-json-tokens': String(historyJsonTokens) }) });
  res.end(body);
}
function json(res: JsonResponseSink, value: unknown, status = 200) { jsonText(res, JSON.stringify(value), status); }
// Native ASCII DTO keys/text need no escaping or UTF-8 expansion. This test
// retains no payload and the full graph is still inspected on every call.
const JSON_STRING_REQUIRES_SCAN = /["\\\u0000-\u001f\u007f-\uffff]/;
export function boundedJsonUtf8Bytes(value: unknown, maximumBytes: number) {
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 0) return null;
  let bytes = 0;
  const ancestors = new WeakSet();
  const add = (amount: number) => {
    bytes += amount;
    return bytes <= maximumBytes;
  };
  const addString = (text: string) => {
    if (!JSON_STRING_REQUIRES_SCAN.test(text)) return add(text.length + 2);
    if (!add(2)) return false;
    for (let index = 0; index < text.length; index += 1) {
      const code = text.charCodeAt(index);
      if (code === 0x22 || code === 0x5c || code === 0x08 || code === 0x09 || code === 0x0a || code === 0x0c || code === 0x0d) {
        if (!add(2)) return false;
      } else if (code < 0x20) {
        if (!add(6)) return false;
      } else if (code >= 0xd800 && code <= 0xdbff) {
        const next = text.charCodeAt(index + 1);
        if (next >= 0xdc00 && next <= 0xdfff) {
          if (!add(4)) return false;
          index += 1;
        } else if (!add(6)) return false;
      } else if (code >= 0xdc00 && code <= 0xdfff) {
        if (!add(6)) return false;
      } else if (!add(code <= 0x7f ? 1 : code <= 0x7ff ? 2 : 3)) return false;
    }
    return add(0);
  };
  const visit = (node: unknown, arrayItem = false): boolean => {
    if (node === null) return add(4);
    const type = typeof node;
    if (typeof node === 'string') return addString(node);
    if (type === 'number') {
      // JSON numbers use ECMAScript number formatting; non-finite values are
      // null and String(-0) is the required JSON zero. No temporary JSON call.
      return add(Number.isFinite(node) ? String(node).length : 4);
    }
    if (type === 'boolean') return add(node ? 4 : 5);
    if (type === 'undefined' || type === 'function' || type === 'symbol') return arrayItem ? add(4) : true;
    if (typeof node !== 'object' || node === null || typeof (node as { toJSON?: unknown }).toJSON === 'function' || ancestors.has(node)) return false;
    ancestors.add(node);
    try {
      if (Array.isArray(node)) {
        if (!add(2)) return false;
        for (let index = 0; index < node.length; index += 1) {
          if (index > 0 && !add(1)) return false;
          if (!visit(node[index], true)) return false;
        }
        return true;
      }
      if (!add(2)) return false;
      let first = true;
      for (const key in node) {
        if (!Object.prototype.hasOwnProperty.call(node, key)) continue;
        const child = (node as Record<string, unknown>)[key];
        const childType = typeof child;
        if (childType === 'undefined' || childType === 'function' || childType === 'symbol') continue;
        if ((!first && !add(1)) || !addString(key) || !add(1) || !visit(child)) return false;
        first = false;
      }
      return true;
    } finally {
      ancestors.delete(node);
    }
  };
  return visit(value) ? bytes : null;
}
function addResponseReservationBytes(total: number, amount: number) {
  const next = total + amount;
  return Number.isSafeInteger(next) ? next : Number.MAX_SAFE_INTEGER;
}
function stateSnapshotCloneReservationBytes(state: Partial<RuntimeState>, { compact = false }: { compact?: boolean } = {}) {
  let bytes = 256 * 1024;
  for (const source of [state?.books, state?.booksByKey]) {
    if (!source || typeof source !== 'object') continue;
    for (const key in source) {
      if (!Object.prototype.hasOwnProperty.call(source, key)) continue;
      const book = source[key];
      bytes = addResponseReservationBytes(bytes, HTTP_STATE_RESPONSE_BOOK_ENTRY_COPY_BYTES);
      for (const side of ['bids', 'asks']) {
        const rows = Array.isArray(book?.[side]) ? book[side] : [];
        const retainedRows = compact ? Math.min(rows.length, COMPACT_BOOK_LEVELS_PER_SIDE) : rows.length;
        bytes = addResponseReservationBytes(bytes, retainedRows * HTTP_STATE_RESPONSE_LEVEL_TEMPORARY_BYTES);
      }
    }
  }
  if (compact) {
    const candles = state?.candles ?? {};
    for (const instrumentId in candles) {
      if (!Object.prototype.hasOwnProperty.call(candles, instrumentId)) continue;
      const rows = Array.isArray(candles[instrumentId]) ? candles[instrumentId] : [];
      bytes = addResponseReservationBytes(bytes, HTTP_STATE_RESPONSE_BOOK_ENTRY_COPY_BYTES);
      bytes = addResponseReservationBytes(bytes, Math.min(rows.length, 500) * HTTP_STATE_RESPONSE_CANDLE_ROW_REFERENCE_BYTES);
    }
    bytes = addResponseReservationBytes(bytes, Math.min(state?.oi?.length ?? 0, 1_000) * HTTP_STATE_RESPONSE_CANDLE_ROW_REFERENCE_BYTES);
  }
  return bytes;
}
class RetainedStateBaselineError extends Error {
  readonly reason: string;
  constructor(reason: string) {
    super('Retained baseline state unavailable');
    this.reason = reason && reason.length <= 180 ? reason : 'retained-baseline-projection-failed';
  }
}
function readBody(req: IncomingMessage): Promise<Record<string, unknown> | null> {
  const isBodyRecord = (value: unknown): value is Record<string, unknown> =>
    value !== null && typeof value === 'object' && !Array.isArray(value);
  return new Promise((resolve) => {
    let body = '';
    req.setEncoding('utf8');
    req.on('data', (chunk) => { body += chunk; if (body.length > 100_000) req.destroy(); });
    req.on('end', () => {
      try {
        const parsed: unknown = body ? JSON.parse(body) : {};
        resolve(isBodyRecord(parsed) ? parsed : null);
      } catch { resolve(null); }
    });
    req.on('error', () => resolve(null));
  });
}
function normalizeProviderCoin(value: unknown) {
  const coin = requireSymbol(value);
  if (!coin || coin.length > MAX_PROVIDER_COIN_LENGTH) throw new TypeError(`Provider coin must contain 1-${MAX_PROVIDER_COIN_LENGTH} valid symbol characters`);
  return coin;
}
function resolutionKeyForBook(book: { resolutionKey?: unknown; representation?: { resolutionKey?: unknown }; resolution?: unknown; nSigFigs?: unknown; mantissa?: unknown }) {
  if (book?.resolutionKey) return String(book.resolutionKey);
  try { return bookResolutionKey({ resolution: book?.resolution ?? 'native', nSigFigs: book?.nSigFigs ?? null, mantissa: book?.mantissa ?? null }); } catch { return 'native'; }
}
type BookSerializationMemo = WeakMap<RuntimeBook, Map<string, RuntimeBook>>;
function serializeBooks(source: Record<string, RuntimeBook> = {}, { compact = false, serverLevelsPerSide = DEFAULT_SERVER_BOOK_LEVELS_PER_SIDE }: BookSerializationOptions = {}, memo?: BookSerializationMemo) {
  return Object.fromEntries(Object.entries(source ?? {}).map(([id, book]) => {
    const sourceLevelCount = book?.sourceLevelCount ?? { bids: book?.bids?.length ?? 0, asks: book?.asks?.length ?? 0 };
    const instrumentId = book?.instrumentId ?? (String(id).includes('|') ? String(id).slice(0, String(id).lastIndexOf('|')) : id);
    const resolutionKey = resolutionKeyForBook(book) === 'native' && String(id).includes('|') ? String(id).slice(String(id).lastIndexOf('|') + 1) : resolutionKeyForBook(book);
    const context = JSON.stringify([instrumentId, resolutionKey, book?.bookKey ?? bookKey(instrumentId, resolutionKey), compact, serverLevelsPerSide]);
    const existing = memo?.get(book)?.get(context);
    if (existing) return [id, existing];
    const retainedBids = compact ? (book?.bids ?? []).slice(0, COMPACT_BOOK_LEVELS_PER_SIDE) : (book?.bids ?? []);
    const retainedAsks = compact ? (book?.asks ?? []).slice(0, COMPACT_BOOK_LEVELS_PER_SIDE) : (book?.asks ?? []);
    const retainedMetadata = (side: 'bids' | 'asks', rows: [number, number][]) => {
      const sourceMetadata = (book?.levelMetadata as { bids?: Map<number, unknown> | Record<string, unknown>; asks?: Map<number, unknown> | Record<string, unknown> } | undefined)?.[side] ?? {};
      return Object.fromEntries(rows.map((row) => {
        const price = String(Array.isArray(row) ? row[0] : (row as { price?: unknown } | null)?.price);
        return [price, (sourceMetadata as Record<string, unknown>)[price]];
      }).filter(([, metadata]) => metadata && typeof metadata === 'object'));
    };
    const inputLevelCount = { bids: (book?.bids ?? []).length, asks: (book?.asks ?? []).length };
    const next = { ...book, instrumentId, sourceLevelCount, bookKey: book?.bookKey ?? bookKey(instrumentId, resolutionKey), resolutionKey, bids: retainedBids, asks: retainedAsks,
      levelMetadata: { bids: retainedMetadata('bids', retainedBids), asks: retainedMetadata('asks', retainedAsks) } };
    const annotated = annotateBookCoverage(next);
    const representation = representationMetadata({
      stage: compact ? 'compact-state-sse' : 'server-state',
      limitPerSide: compact ? COMPACT_BOOK_LEVELS_PER_SIDE : serverLevelsPerSide,
      inputLevelCount,
      retainedLevelCount: annotated.retainedLevelCount,
      resolutionKey,
      resolution: annotated.resolution,
      grouping: annotated.sourceGrouping ?? annotated.grouping,
      units: annotated.units ?? 'venue-native',
      coverage: annotated.coverage,
      coverageBounds: annotated.coverageBounds,
      observedBounds: annotated.observedBounds,
      sourceTimestamp: annotated.sourceTimestamp,
    });
    const serialized = { ...annotated, representation } as RuntimeBook;
    if (memo && book && typeof book === 'object') {
      let contexts = memo.get(book);
      if (!contexts) { contexts = new Map(); memo.set(book, contexts); }
      contexts.set(context, serialized);
    }
    return [id, serialized];
  }));
}
/** Exact producer identities share DTOs only when all key-derived defaults agree.
 * Default JSON remains complete; this memo never merges equal-valued books. */
export function serializeNativeBookMaps(state: Pick<RuntimeState, 'books'|'booksByKey'>, options: BookSerializationOptions = {}) {
  const memo: BookSerializationMemo = new WeakMap();
  return {books:serializeBooks(state.books, options, memo),booksByKey:serializeBooks(state.booksByKey, options, memo)};
}
function snapshot(state: RuntimeState, quota: QuotaLedger, { compact = false, nativeOiLatest = false, serverLevelsPerSide = DEFAULT_SERVER_BOOK_LEVELS_PER_SIDE }: BookSerializationOptions & { nativeOiLatest?: boolean } = {}) {
  const oiBootstrap = nativeOiLatest ? projectNativeOiBootstrap(state.oi, { inputRows: state.oi.length,
    reservedWorkingBytes: nativeOiBootstrapWorkingBytes(state.oi.length) }) : null;
  if (oiBootstrap && !oiBootstrap.complete) throw new Error('Native OI bootstrap unavailable: ' + oiBootstrap.reason);
  const {books, booksByKey} = serializeNativeBookMaps(state, { compact, serverLevelsPerSide });
  const candles = compact
    ? Object.fromEntries(Object.entries(state.candles ?? {}).map(([id, rows]) => [id, (rows ?? []).slice(-500)]))
    : state.candles;
  return {
    asOf: state.asOf, markPrice: state.markPrice, markInstrumentId: state.markInstrumentId,
    markObserved: state.markObserved === true, markSequence: state.markSequence ?? 0, markSessionId: state.markSessionId ?? null, markContinuity: state.markContinuity ?? null, dataMode: state.dataMode ?? 'fixture',
    liquiditySessionId: state.liquiditySessionId ?? null, liquiditySequence: state.liquiditySequence ?? 0,
    tailRecoveryRevision: state.tailRecoveryRevision ?? 0,
    markets: state.markets, books, booksByKey, bookSelection: state.bookSelection ?? {}, activeBookKeys: state.activeBookKeys ?? {}, layers: state.layers, layerMeta: state.layerMeta,
    venueRegistry: state.venueRegistry ?? venueRegistrySnapshot(),
    representationLimits: representationLimits({ serverLevelsPerSide }),
    oi: oiBootstrap?.rows ?? (compact ? (state.oi ?? []).slice(-1_000) : state.oi), candles, metadata: state.metadata,
    ...(oiBootstrap?.projection ? { oiProjection: oiBootstrap.projection } : {}),
    ...(compact ? {} : { trades: state.trades }),
    statuses: state.statuses, feedStatuses: state.feedStatuses, sourceTimestamps: state.sourceTimestamps,
    layerSourceTimestamps: state.layerSourceTimestamps,
    quota: quota.snapshot(),
  };
}
function admittedLiquidityWireMeasurement(payload: unknown, maximumBytes: number, processMemory: TransientResponseMemory | undefined) {
  if (typeof processMemory?.reserveTransient !== 'function') throw new Error('Liquidity wire inspection process-RSS admission unavailable');
  const scratch = processMemory.reserveTransient(LIQUIDITY_WIRE_MEASUREMENT_SCRATCH_BYTES, { kind: 'sse-liquidity-wire-preflight' });
  if (!scratch?.admitted) throw new Error('Liquidity wire inspection process-RSS admission rejected: ' + (scratch?.reason ?? 'physical-rss-unavailable'));
  try { return requireLiquidityWireCapacity(payload, maximumBytes); }
  finally { scratch.release?.(); }
}
function stateStreamStatus(state: RuntimeState, liquidityWireBytes?: number, nativeBookAliases = false, retainedBaseline = false) {
  return { connected: true, mode: process.env.ENABLE_LIVE_FEEDS === 'true' ? 'live-capable' : 'fixture',
    ...(retainedBaseline ? { retainedBaseline: RETAINED_STATE_BASELINE_VERSION } : {}),
    ...(liquidityWireBytes === undefined ? {} : { liquidityWire: { version: LIVE_LIQUIDITY_WIRE_BOUND_VERSION, maxBytes: liquidityWireBytes, ...(nativeBookAliases ? {bookAliases:NATIVE_BOOK_WIRE_ALIASES_VERSION} : {}) }, liquiditySessionId: state.liquiditySessionId ?? null }) };
}
function sse(res: StateStreamResponse, event: string, payload: unknown, processMemory: TransientResponseMemory | undefined, liquidityWireBytes?: number) {
  const boundedLiquidity = event === 'liquidity' && liquidityWireBytes !== undefined;
  const measured = boundedLiquidity ? admittedLiquidityWireMeasurement(payload, liquidityWireBytes, processMemory) : null;
  const bodyBytes = measured?.utf8Bytes ?? boundedJsonUtf8Bytes(payload, HTTP_STATE_RESPONSE_MAX_JSON_BYTES);
  if (bodyBytes === null) throw new Error('SSE frame exceeds the bounded JSON response limit');
  if (typeof processMemory?.reserveTransient !== 'function') throw new Error('SSE frame process-RSS admission unavailable');
  const reservationBytes = addResponseReservationBytes(
    HTTP_STATE_RESPONSE_BASE_RESERVATION_BYTES,
    bodyBytes * HTTP_STATE_RESPONSE_BODY_COPIES,
  );
  const reservation = processMemory.reserveTransient(reservationBytes, { kind: 'sse-frame', event: String(event ?? '') });
  if (!reservation?.admitted) throw new Error(`SSE frame process-RSS admission rejected: ${reservation?.reason ?? 'physical-rss-unavailable'}`);
  let released = false;
  const release = () => {
    if (released) return 0;
    released = true;
    res.off?.('close', release);
    res.off?.('error', release);
    return reservation.release?.() ?? 0;
  };
  res.once('close', release);
  res.once('error', release);
  try {
    // Admission/listener callbacks may have changed a queued DTO. Reinspect
    // immediately before stringify so neither hooks nor getters can execute.
    if (boundedLiquidity && admittedLiquidityWireMeasurement(payload, liquidityWireBytes, processMemory).utf8Bytes !== bodyBytes) throw new Error('SSE frame JSON size changed during admission');
    const serialized = JSON.stringify(payload);
    if (boundedLiquidity && liquidityWireTextBytes(serialized, liquidityWireBytes) === null) {
      throw new LiquidityWireCapacityError(Math.max(Buffer.byteLength(serialized, 'utf8'), 2 * serialized.length), liquidityWireSessionId(payload));
    }
    if (Buffer.byteLength(serialized, 'utf8') !== bodyBytes) throw new Error('SSE frame JSON size changed during admission');
    return res.write(`event: ${event}\ndata: ${serialized}\n\n`, release);
  } catch (error) {
    release();
    throw error;
  }
}
const mergeMarkFrames = (previous: ServerStreamFrame, next: ServerStreamFrame): ServerStreamFrame => ({ ...mergeMarkPayload(previous, next, MARK_CROSSING_LIMIT), event: next.event });
export interface UiStaticRoots { builtRoot?: string; sourceRoot?: string; }
type UiStaticResponse = JsonResponseSink & NodeJS.WritableStream;
/** Resolve local UI assets without treating authored TypeScript as a browser bundle. */
export function sendUiStaticResponse(res: UiStaticResponse, pathname: string, {
  builtRoot = path.join(process.cwd(), 'dist'),
  sourceRoot = sourceWebRoot,
}: UiStaticRoots = {}) {
  const builtUiAvailable = fs.existsSync(path.join(builtRoot, 'index.html'));
  if (!builtUiAvailable && (pathname === '/' || pathname === '/index.html')) {
    return json(res, {
      error: 'UI build required',
      code: 'UI_BUILD_REQUIRED',
      message: 'Run npm run build to generate the local UI, or use npm run ui for Vite development. API routes remain available.',
    }, 503);
  }
  const root = builtUiAvailable ? builtRoot : sourceRoot;
  let file = safeStaticPath(root, pathname);
  if ((!file || !fs.existsSync(file)) && root !== sourceRoot) file = safeStaticPath(sourceRoot, pathname);
  if (!file || !fs.existsSync(file) || fs.statSync(file).isDirectory()) return json(res, { error: 'not found' }, 404);
  res.writeHead(200, { 'content-type': contentTypes[path.extname(file).toLowerCase()] || 'application/octet-stream', 'cache-control': 'no-store' });
  fs.createReadStream(file).pipe(res);
}
function safeStaticPath(root: string, pathname: string) { const requested = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, ''); const resolved = path.resolve(root, requested); const relative = path.relative(root, resolved); return relative && !relative.startsWith('..') && !path.isAbsolute(relative) ? resolved : null; }
function providerKindFor(kind: string) {
  const value = String(kind || 'manual');
  return ({ liquidity: 'liquidity', liquidation: 'liquidation', stops: 'stopLoss', 'take-profits': 'takeProfit' })[value] ?? value;
}
function candleKey(candle: RuntimeCandle | null | undefined) { return `${String(candle?.interval ?? '')}|${Number(candle?.start)}`; }
function validCandle(value: unknown): value is RuntimeCandle {
  const candle = value as Partial<RuntimeCandle> | null | undefined;
  const start = Number(candle?.start); const end = Number(candle?.end);
  const open = Number(candle?.open); const high = Number(candle?.high); const low = Number(candle?.low); const close = Number(candle?.close); const volume = Number(candle?.volume ?? 0);
  return Number.isFinite(start) && Number.isFinite(end) && end > start && [open, high, low, close].every((value) => Number.isFinite(value) && value > 0) && low <= open && low <= close && high >= open && high >= close && low <= high && Number.isFinite(volume) && volume >= 0;
}
function candleCanReplace(previous: RuntimeCandle | null | undefined, incoming: RuntimeCandle) {
  if (!previous) return true;
  if (previous.closed === true && incoming.closed !== true) return false;
  const previousSource = knownSourceTimestamp(previous.sourceTimestamp);
  const incomingSource = knownSourceTimestamp(incoming.sourceTimestamp);
  if (previousSource != null && incomingSource == null) return false;
  if (previousSource != null && incomingSource != null && incomingSource < previousSource) return false;
  const previousReceived = Number(previous.receivedAt); const incomingReceived = Number(incoming.receivedAt);
  const receivedNotOlder = !Number.isFinite(previousReceived) || !Number.isFinite(incomingReceived) || incomingReceived >= previousReceived;
  const finalityUpgrade = incoming.closed === true && previous.closed !== true && (
    (previousSource != null && incomingSource != null && (incomingSource > previousSource || (incomingSource === previousSource && receivedNotOlder))) ||
    (previousSource == null && (incomingSource == null || receivedNotOlder))
  );
  const provenanceUpgrade = previous.closed === true && incoming.closed === true && previousSource == null && incomingSource != null && receivedNotOlder;
  if (previous.source === 'live' && incoming.source === 'history' && !finalityUpgrade && !provenanceUpgrade) return false;
  if (previous.source === incoming.source && Number.isFinite(Number(previous.receivedAt)) && Number.isFinite(Number(incoming.receivedAt)) && Number(previous.receivedAt) > Number(incoming.receivedAt)) return false;
  return true;
}
function mergeCandleRows(existing: RuntimeCandle[] = [], incoming: RuntimeCandle[] = [], limit = 2_000) {
  const byKey = new Map();
  for (const row of existing ?? []) if (validCandle(row)) byKey.set(candleKey(row), row);
  for (const row of incoming ?? []) {
    if (!validCandle(row)) continue;
    const key = candleKey(row); const prior = byKey.get(key);
    if (candleCanReplace(prior, row)) byKey.set(key, row);
  }
  const rows = [...byKey.values()].sort((a, b) => Number(a.start) - Number(b.start));
  return rows.length > limit ? rows.slice(-limit) : rows;
}
function capSortedBook<T extends RuntimeBook | SortedBook>(book: T, limit: number) {
  const bids = (book?.bids ?? []).slice(0, limit); const asks = (book?.asks ?? []).slice(0, limit);
  const retain = (side: 'bids' | 'asks', rows: [number, number][]): Record<string, unknown> => {
    const source = (book?.levelMetadata as { bids?: Record<string, unknown>; asks?: Record<string, unknown> } | undefined)?.[side];
    // Most venues carry no per-level metadata; walking every level of a 2,000-level book to find that out was a top server cost.
    if (!source) return {};
    let any = false; for (const _key in source) { any = true; break; }
    if (!any) return {};
    return Object.fromEntries(rows.map((row) => {
      const price = String(Array.isArray(row) ? row[0] : (row as { price?: unknown } | null)?.price); return [price, source[price]];
    }).filter(([, metadata]) => metadata && typeof metadata === 'object'));
  };
  return { ...book, bids, asks, levelMetadata: { bids: retain('bids', bids), asks: retain('asks', asks) } };
}
function depthCoverageBounds(book: Pick<RuntimeBook, 'bids' | 'asks'>) {
  const range = (rows: [number, number][]) => { const prices = (rows || []).map((row) => Number(Array.isArray(row) ? row[0] : (row as { price?: unknown } | null)?.price)).filter((value) => Number.isFinite(value) && value > 0); return prices.length ? { min: Math.min(...prices), max: Math.max(...prices) } : null; };
  return { bids: range(book?.bids), asks: range(book?.asks) };
}
function selectBookVariant(state: RuntimeState, instrumentId: string) {
  const activeKeys = state.activeBookKeys?.[instrumentId];
  const variants = Object.values(state.booksByKey ?? {}).filter((book) => String(book?.instrumentId ?? instrumentId) === String(instrumentId) && (!Array.isArray(activeKeys) || activeKeys.includes(book.bookKey!)));
  if (!variants.length) return null;
  const usable = variants.filter((book) => book.complete !== false && book.gap !== true);
  const pool = usable.length ? usable : variants;
  const explicit = state.bookSelection?.[instrumentId];
  if (explicit) {
    const chosen = pool.find((book) => book.bookKey === explicit || book.resolutionKey === explicit);
    if (chosen) return chosen;
  }
  // Coarse HL is the broad visual representation; keep it selected whenever
  // it is present and healthy. Fall back to a healthy native view during a
  // coarse-feed gap so a temporary grouped-feed outage does not blank the UI.
  return pool
    .slice()
    .sort((a, b) => (a.resolution === 'coarse' ? -1 : 1) - (b.resolution === 'coarse' ? -1 : 1) || Number(a.nSigFigs ?? 99) - Number(b.nSigFigs ?? 99))[0];
}

const SERVER_STATE_RETAINED_FIELDS = new Set([
  'markets', 'books', 'booksByKey', 'bookSelection', 'activeBookKeys', 'layers', 'layerMeta',
  'layerRevisions', 'layerSourceTimestamps', 'oi', 'candles', 'trades', 'metadata', 'statuses',
  'feedStatuses', 'sourceTimestamps', 'asOf', 'markPrice', 'markInstrumentId', 'markObserved',
  'markSequence', 'markSessionId', 'markContinuity', 'dataMode', 'liveMode',
]);

function activeHeatmapInstrumentIds(state: Partial<RuntimeState>, feeds: FeedOwner | null | undefined) {
  const active = new Set(Object.keys(state?.books ?? {}).map(String));
  for (const [instrumentId, keys] of Object.entries(state?.activeBookKeys ?? {})) {
    if (Array.isArray(keys) && keys.length > 0) active.add(String(instrumentId));
  }
  for (const [instrumentId, selected] of Object.entries(state?.bookSelection ?? {})) {
    if (selected) active.add(String(instrumentId));
  }
  const specs = feeds?.specs;
  const values = specs instanceof Map ? specs.values() : Array.isArray(specs) ? specs : Object.values(specs ?? {});
  for (const spec of values) {
    if (spec?.instrumentId && /book|depth|candle|kline/i.test(String(spec.channel ?? ''))) active.add(String(spec.instrumentId));
  }
  return active;
}

function candleSeriesMatchesDurableHistory(history: HistoryStore | null | undefined, instrumentId: string, rows: RuntimeCandle[]) {
  if (!Array.isArray(rows) || rows.length === 0) return true;
  if (typeof history?.listCandles !== 'function') return false;
  const numericFields = ['start', 'end', 'open', 'high', 'low', 'close', 'volume', 'sourceTimestamp', 'receivedAt'];
  const byInterval = new Map<string, RuntimeCandle[]>();
  for (const row of rows) {
    if (row?.closed !== true || !Number.isFinite(Number(row.start)) || !String(row.interval ?? '')) return false;
    const interval = String(row.interval);
    const group = byInterval.get(interval) ?? [];
    group.push(row);
    byInterval.set(interval, group);
  }
  for (const [interval, group] of byInterval) {
    const starts = group.map((row) => Number(row.start));
    const from = Math.min(...starts);
    const to = Math.max(...starts) + 1;
    let durableRows;
    try {
      durableRows = history.listCandles(instrumentId, {
        interval,
        from,
        to,
        limit: group.length,
        newestFirst: true,
      });
    } catch { return false; }
    if (!Array.isArray(durableRows)) return false;
    const durableByKey = new Map(durableRows.map((row) => [candleKey(row), row]));
    if (!group.every((row) => {
      const durable = durableByKey.get(candleKey(row));
      return durable?.closed === true
        && numericFields.every((field) => Number.isFinite(Number(row[field])) && Number(row[field]) === Number(durable[field]))
        && String(row.source ?? '') === String(durable.source ?? '')
        && String(row.quality ?? '') === String(durable.quality ?? '');
    })) return false;
  }
  return true;
}

function reclaimOldestDurableCandleSeries(state: RuntimeState, { history, protectedInstrumentIds = new Set() }: CandleReclaimOptions = {}) {
  const protectedIds = protectedInstrumentIds instanceof Set ? protectedInstrumentIds : new Set(protectedInstrumentIds ?? []);
  const candidates = [];
  for (const [instrumentId, rows] of Object.entries(state?.candles ?? {})) {
    if (protectedIds.has(String(instrumentId))) continue;
    const lastUpdatedAt = (rows ?? []).reduce((latest, row) => Math.max(latest, Number(row?.receivedAt) || Number(row?.end) || 0), 0);
    candidates.push({ instrumentId, rows, lastUpdatedAt });
  }
  candidates.sort((a, b) => a.lastUpdatedAt - b.lastUpdatedAt || a.instrumentId.localeCompare(b.instrumentId));
  for (const candidate of candidates) {
    if (!candleSeriesMatchesDurableHistory(history, candidate.instrumentId, candidate.rows)) continue;
    delete state.candles[candidate.instrumentId];
    advanceNativeTailRecovery(state);
    return true;
  }
  return false;
}

function ensureCandleSeriesSlot(state: RuntimeState, { history, feeds, instrumentId, startupCandleInstrumentIds = [] }: CandleReclaimOptions = {}) {
  const id = String(instrumentId ?? '');
  if (!id || Object.hasOwn(state?.candles ?? {}, id)) return true;
  const protectedInstrumentIds = activeHeatmapInstrumentIds(state, feeds);
  for (const startupId of startupCandleInstrumentIds ?? []) if (startupId) protectedInstrumentIds.add(String(startupId));
  if (state?.markInstrumentId) protectedInstrumentIds.add(String(state.markInstrumentId));
  protectedInstrumentIds.add(id);
  while (Object.keys(state?.candles ?? {}).length >= SERVER_CANDLE_SERIES_LIMIT) {
    if (!reclaimOldestDurableCandleSeries(state, { history, protectedInstrumentIds })) return false;
  }
  return true;
}
function normalizeActiveBookKeys(keys: unknown = []) {
  return [...new Set((Array.isArray(keys) ? keys : []).map((key) => String(key)).filter(Boolean))];
}
function reconcileActiveBookKeys(state: RuntimeState, instrumentId: string, keys: unknown = [], { normalized = false, updateSelection = true }: { normalized?: boolean; updateSelection?: boolean } = {}) {
  const id = String(instrumentId ?? '');
  if (!id) return null;
  const active = normalized ? keys as string[] : normalizeActiveBookKeys(keys);
  state.activeBookKeys ??= {};
  if (updateSelection) {
    if (active.length) state.activeBookKeys[id] = active;
    else delete state.activeBookKeys[id];
  }
  for (const [key, book] of Object.entries(state.booksByKey ?? {})) {
    if (String(book?.instrumentId ?? '') === id && !active.includes(key)) delete state.booksByKey[key];
  }
  const selected = selectBookVariant(state, id);
  if (selected) state.books[id] = selected;
  else delete state.books[id];
  return selected;
}
function normalizeBookVariant(instrumentId: string, message: RuntimeMessage, book: RuntimeBook, bookLevelLimit: number) {
  const resolutionKey = message.resolutionKey ?? resolutionKeyForBook(message);
  const variantKey = message.bookKey ?? bookKey(instrumentId, resolutionKey);
  const annotated = annotateBookCoverage({
    ...book, instrumentId, bookKey: variantKey, resolutionKey, feedId: message.feedId,
    resolution: message.resolution ?? (resolutionKey === 'native' ? 'native' : 'coarse'),
    nSigFigs: message.nSigFigs, mantissa: message.mantissa,
  }, { bids: (book.bids ?? []).slice(0, bookLevelLimit), asks: (book.asks ?? []).slice(0, bookLevelLimit) });
  const normalized = {
    ...annotated,
    representation: representationMetadata({
      stage: 'server-state',
      limitPerSide: bookLevelLimit,
      inputLevelCount: book.sourceLevelCount ?? annotated.sourceLevelCount,
      retainedLevelCount: annotated.retainedLevelCount,
      resolutionKey,
      resolution: annotated.resolution,
      grouping: annotated.sourceGrouping ?? annotated.grouping,
      units: annotated.units ?? 'venue-native',
      coverage: annotated.coverage,
      coverageBounds: annotated.coverageBounds,
      observedBounds: annotated.observedBounds,
      sourceTimestamp: annotated.sourceTimestamp,
    }),
  };
  return { variantKey, normalized };
}
function storeBookVariant(state: RuntimeState, instrumentId: string, message: RuntimeMessage, book: RuntimeBook, bookLevelLimit: number) {
  const { variantKey, normalized } = normalizeBookVariant(instrumentId, message, book, bookLevelLimit);
  state.booksByKey[variantKey] = normalized;
  const selected = selectBookVariant(state, instrumentId);
  if (selected) state.books[instrumentId] = selected;
  return { variantKey, normalized, selected };
}

/** Attach the production state sender to an SSE response.
 *
 * Kept separate from route() so the same sender can be exercised with a
 * controllable writable transport. The feed reducer remains synchronous and
 * complete; only state frames wait/coalesce at this client boundary.
 */
export function attachStateStream({ req, res, state, quota, clients, bus, metrics, processMemory, queueRegistry, onQueueRegistryChange = null, initialSnapshot = null, liveStateTail = false, tailRecoveryRevision = 0, runTailProjectionAdmitted, liquidityWireBytes, nativeBookAliases = false, retainedBaseline = false }: AttachStreamOptions) {
  if (liquidityWireBytes !== undefined && (!Number.isSafeInteger(liquidityWireBytes) || liquidityWireBytes < 4096 || liquidityWireBytes > LIVE_LIQUIDITY_MAX_FRAME_BYTES)) {
    json(res, { error: 'Invalid liquidity wire bound' }, 400);
    return { queue: null, close() {}, rejected: true };
  }
  if (nativeBookAliases && liquidityWireBytes === undefined) {
    json(res, {error:'Native book aliases require bounded liquidity wire'}, 400);
    return {queue:null,close(){},rejected:true};
  }
  if (retainedBaseline && (!liveStateTail || liquidityWireBytes === undefined || !nativeBookAliases)) {
    json(res, { error: 'Retained baseline requires live tail, bounded liquidity wire and native book aliases', reason: 'retained-baseline-prerequisites-required' }, 400);
    return { queue: null, close() {}, rejected: true };
  }
  let resolvedInitialSnapshot = initialSnapshot;
  let initialSnapshotReservation: ProcessMemoryReservation | null = null;
  let initialSnapshotReservationReleased = false;
  const releaseInitialSnapshotReservation = () => {
    if (initialSnapshotReservationReleased) return 0;
    initialSnapshotReservationReleased = true;
    res.off?.('close', releaseInitialSnapshotReservation);
    res.off?.('error', releaseInitialSnapshotReservation);
    return initialSnapshotReservation?.release?.() ?? 0;
  };
  if (resolvedInitialSnapshot == null) {
    if (typeof processMemory?.reserveTransient !== 'function') {
      json(res, { error: 'SSE snapshot memory admission unavailable', reason: 'physical-rss-unavailable' }, 503);
      return { queue: null, close() {}, rejected: true };
    }
    const cloneReservationBytes = addResponseReservationBytes(
      HTTP_STATE_RESPONSE_BASE_RESERVATION_BYTES,
      stateSnapshotCloneReservationBytes(state, { compact: true }),
    );
    initialSnapshotReservation = processMemory.reserveTransient(cloneReservationBytes, { kind: 'http-stream-initial-snapshot' });
    if (!initialSnapshotReservation?.admitted) {
      json(res, { error: 'SSE snapshot memory admission rejected', reason: initialSnapshotReservation?.reason ?? 'physical-rss-reservation-hard-limit' }, 503);
      return { queue: null, close() {}, rejected: true };
    }
    res.once('close', releaseInitialSnapshotReservation);
    res.once('error', releaseInitialSnapshotReservation);
    try {
      resolvedInitialSnapshot = snapshot(state, quota, { compact: true, serverLevelsPerSide: metrics?.bookLevelLimit });
    } catch (error) {
      releaseInitialSnapshotReservation();
      throw error;
    }
  }
  try {
    res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache, no-store', connection: 'keep-alive', 'x-accel-buffering': 'no' });
    clients.add(res);
    let closed = false;
    let unsubscribe = () => {};
    let queue: ServerQueue;
    // Count actual writes, not enqueues: backpressure can replace a queued
    // initial snapshot. Default connections still deliver a full first state.
    let fullBootstrapWritten = false;
    const close = () => {
      if (closed) return;
      closed = true;
      queue?.close();
      if (queueRegistry?.delete?.(queue) === true) onQueueRegistryChange?.();
      unsubscribe();
      clients.delete(res);
      if (!res.writableEnded) res.end();
    };
    const retireLiquidityCapacity = (error: LiquidityWireCapacityError) => {
      if (closed) return;
      // A single bounded control frame describes delivery failure, never a
      // partial native graph. Existing transport admission still governs it.
      try {
        sse(res, 'liquidity-unavailable', { reason: 'transport-capacity', maximumBytes: liquidityWireBytes,
          requiredBytes: error.requiredBytes, sessionId: error.sessionId ?? liquidityWireSessionId({ sessionId: state.liquiditySessionId }) ?? '', resyncRequired: true }, processMemory);
      } catch { if (metrics) metrics.streamWriteErrors = (metrics.streamWriteErrors ?? 0) + 1; }
      finally { close(); }
    };
    const retireRetainedBaseline = (error: RetainedStateBaselineError) => {
      try {
        sse(res, 'state-unavailable', { retainedBaseline: RETAINED_STATE_BASELINE_VERSION,
          reason: error.reason, resyncRequired: true }, processMemory);
      } catch {
        // A denied/erroring notice cannot justify a full-state retry or a write
        // after headers. Closing the stream remains the truthful retirement.
        if (metrics) metrics.streamWriteErrors = (metrics.streamWriteErrors ?? 0) + 1;
      } finally { close(); }
    };
    queue = new LatestOnlyFrameQueue<ServerStreamFrame>({
      write: ({ event, payload }) => {
        // The revision belongs to this admitted queued DTO, never later globals.
        if (event === 'state' && liveStateTail && !nativeTailBaselineMatches(payload.tailRecoveryRevision, tailRecoveryRevision))
          throw new RetainedStateBaselineError('history-recovery-required');
        let tailWritable: boolean | null = null;
        if (event === 'state' && liveStateTail && (fullBootstrapWritten || retainedBaseline)) {
          let reason = 'retained-baseline-projection-admission-unavailable';
          if (runTailProjectionAdmitted) {
            // Both grants precede counts/reflection/Map allocation. The queue
            // continues to own the full frame; the tail never becomes a queue root.
            reason = 'retained-baseline-projection-admission-rejected';
            try {
              const admitted = runTailProjectionAdmitted(LIVE_STATE_TAIL_LIMITS.maxWorkingBytes, () => {
                const physical = processMemory?.reserveTransient(LIVE_STATE_TAIL_LIMITS.maxWorkingBytes,
                  { kind: 'sse-live-state-tail-projection' });
                if (physical?.admitted !== true) { reason = physical?.reason ?? 'physical-rss-unavailable'; return false; }
                try {
                  const projected = projectLiveStateTail(payload, { reservedWorkingBytes: LIVE_STATE_TAIL_LIMITS.maxWorkingBytes });
                  if (!projected.complete || !projected.value) { reason = projected.reason ?? 'retained-baseline-projection-shape-unavailable'; return false; }
                  tailWritable = sse(res, event, projected.value, processMemory);
                  return true;
                } finally {
                  // JSON serialization is synchronous. No projected graph escapes;
                  // the separate body grant survives through callback/transport drain.
                  physical.release?.();
                }
              });
              if (admitted && tailWritable !== null) return tailWritable;
            } catch (error) {
              if (retainedBaseline) throw new RetainedStateBaselineError('retained-baseline-state-write-failed');
              throw error;
            }
          }
          if (retainedBaseline) throw new RetainedStateBaselineError(reason);
        }
        // Normal connections retain their unchanged guarded full-DTO fallback.
        const writable = sse(res, event, payload, processMemory, liquidityWireBytes);
        if (event === 'state') fullBootstrapWritten = true;
        return writable;
      },
      waitForDrain: (resume) => {
        const onDrain = () => resume();
        res.once('drain', onDrain);
        return () => res.off?.('drain', onDrain);
      },
      onWrite: (frame) => {
        if (frame.event === 'state' && metrics) metrics.streamStateSent += 1;
        if (frame.event === 'mark' && metrics) metrics.streamMarkSent += 1;
        if (frame.event === 'liquidity' && metrics) metrics.streamLiquiditySent += 1;
      },
      onReplace: (previous, next, kind) => {
        if (kind === 'priority' && previous?.event === 'mark' && next?.event === 'mark' && metrics) metrics.streamMarkReplacements += 1;
        if (kind === 'liquidity' && metrics) metrics.streamLiquidityReplacements += 1;
        if (kind !== 'priority' && previous?.event === 'state' && next?.event === 'state' && metrics) metrics.streamStateReplacements += 1;
      },
      onDrainWait: () => {
        if (metrics) metrics.streamDrainWaits += 1;
      },
      onError: (error) => {
        if (error instanceof RetainedStateBaselineError) { retireRetainedBaseline(error); return; }
        if (error instanceof LiquidityWireCapacityError && liquidityWireBytes !== undefined) { retireLiquidityCapacity(error); return; }
        if (metrics) metrics.streamWriteErrors = (metrics.streamWriteErrors ?? 0) + 1;
        close();
      },
    });
    if (typeof queueRegistry?.add === 'function') {
      queueRegistry.add(queue);
      onQueueRegistryChange?.();
    }
    let streamSessionId = String(state.markSessionId ?? '');
    const send = ({ event, payload }: ServerStreamFrame) => {
      if (closed || res.writableEnded) return;
      if (event === 'mark') {
        const nextSessionId = String(payload?.sessionId ?? '');
        if (nextSessionId && nextSessionId !== streamSessionId) {
          queue.invalidatePending((frame) => frame.event === 'state' && String(frame.payload?.markSessionId ?? '') !== nextSessionId);
          streamSessionId = nextSessionId;
        }
        queue.enqueuePriority({ event, payload }, mergeMarkFrames);
      }
      else if (event === 'liquidity') {
        let wirePayload = payload;
        let aliasPhysical: ProcessMemoryReservation | null = null;
        try {
          if (nativeBookAliases && typeof runTailProjectionAdmitted === 'function') {
            aliasPhysical = processMemory?.reserveTransient?.(NATIVE_BOOK_WIRE_ALIASES_WORKING_BYTES, {kind:'sse-native-book-aliases'}) ?? null;
            if (aliasPhysical?.admitted) {
              const projected = runTailProjectionAdmitted(NATIVE_BOOK_WIRE_ALIASES_WORKING_BYTES + NATIVE_BOOK_WIRE_ALIASES_RESULT_CONTROL_BYTES, () => {
                const encoded = encodeNativeBookWireAliases({books:payload.books,booksByKey:payload.booksByKey});
                if (!encoded) return false;
                wirePayload = {...payload,...encoded};
                if (liquidityWireBytes !== undefined) admittedLiquidityWireMeasurement(wirePayload, liquidityWireBytes, processMemory);
                queue.enqueueLiquidity({event,payload:wirePayload});
                return true;
              });
              if (projected) {
                if (metrics) metrics.maxPendingState = Math.max(metrics.maxPendingState, queue.maxPending);
                if (metrics) metrics.maxPendingSlots = Math.max(metrics.maxPendingSlots ?? 0, queue.maxPendingSlots);
                return;
              }
            }
          }
        } catch (error) {
          if (error instanceof LiquidityWireCapacityError) retireLiquidityCapacity(error);
          else { if (metrics) metrics.streamWriteErrors = (metrics.streamWriteErrors ?? 0) + 1; close(); }
          return;
        } finally { aliasPhysical?.release?.(); }
        // Unsupported/denied alias projection retains the full guarded DTO.
        if (liquidityWireBytes !== undefined) {
          try { admittedLiquidityWireMeasurement(payload, liquidityWireBytes, processMemory); }
          catch (error) {
            if (error instanceof LiquidityWireCapacityError) retireLiquidityCapacity(error);
            else { if (metrics) metrics.streamWriteErrors = (metrics.streamWriteErrors ?? 0) + 1; close(); }
            return;
          }
        }
        queue.enqueueLiquidity({ event, payload });
      }
      else queue.enqueue({ event, payload });
      if (metrics) metrics.maxPendingState = Math.max(metrics.maxPendingState, queue.maxPending);
      if (metrics) metrics.maxPendingSlots = Math.max(metrics.maxPendingSlots ?? 0, queue.maxPendingSlots);
    };
    send({ event: 'status', payload: stateStreamStatus(state, liquidityWireBytes, nativeBookAliases, retainedBaseline) });
    send({ event: 'state', payload: resolvedInitialSnapshot });
    if (!closed) unsubscribe = bus.subscribe(send);
    if (!closed) req.once('close', close);
    return { queue, close };
  } finally {
    releaseInitialSnapshotReservation();
  }
}

async function route(req: IncomingMessage, res: ServerResponse, state: RuntimeState, quota: QuotaLedger, clients: Set<ServerResponse>, bus: LocalEventBus<ServerStreamFrame>, history: HistoryStore, services: RouteServices = {}) {
  const url = new URL(req.url ?? '/', 'http://localhost');
  if (req.method === 'GET' && url.pathname === '/api/health') return json(res, { ok: true, service: 'liquidity-mapper-fast-local', mode: process.env.ENABLE_LIVE_FEEDS === 'true' ? 'live-capable' : 'fixture', now: Date.now() });
  if (req.method === 'GET' && url.pathname === '/api/markets') return json(res, state.markets);
  if (req.method === 'GET' && url.pathname === '/api/venues') return json(res, state.venueRegistry ?? venueRegistrySnapshot());
  if (req.method === 'GET' && url.pathname === '/api/orderbooks/venues') {
    const result = services.orderbookCatalog?.() ?? { ok: false, statusCode: 503, error: 'Live orderbook venue controls are unavailable' };
    return json(res, result, 'statusCode' in result ? result.statusCode ?? 503 : 200);
  }
  if (req.method === 'POST' && url.pathname === '/api/orderbooks/selection') {
    if (!services.selectOrderbooks) return json(res, { ok: false, error: 'Live orderbook venue controls are unavailable' }, 503);
    const parse = services.retainedProviders?.processMemory?.reserveTransient(ORDERBOOK_CONTROL_PARSE_BYTES, { kind: 'public-orderbook-control-body' });
    if (!parse?.admitted) { req.resume(); return json(res, { ok: false, error: 'Venue request rejected by memory admission' }, 503); }
    let body: OrderbookControlBody | null;
    try { body = await readOrderbookControlBody(req); } finally { parse.release?.(); }
    if (!body) return json(res, { ok: false, error: 'Expected only instrumentId and a short list of venue IDs in a small request' }, 400);
    const result = await services.selectOrderbooks(body.instrumentId, body.venues);
    return json(res, result, 'statusCode' in result ? result.statusCode ?? (result.ok ? 202 : 400) : 202);
  }
  if (req.method === 'POST' && url.pathname === '/api/public-products') {
    if (!services.discoverPublicProducts) return json(res, { error: 'Public product discovery is unavailable in this runtime' }, 503);
    const result = await services.discoverPublicProducts(url.searchParams.get('venue'), url.searchParams.get('family'));
    return json(res, result, result.statusCode ?? (result.ok ? 200 : 503));
  }
  if (req.method === 'POST' && url.pathname === '/api/provider-selection') {
    const body = await readBody(req);
    const result = services.selectProviderLayer?.(body?.kind) ?? { ok: false, statusCode: 503, error: 'Provider selection is unavailable' };
    return json(res, result, result.statusCode ?? (result.ok ? 200 : 400));
  }
  if (req.method === 'POST' && url.pathname === '/api/market-selection') {
    if (!services.selectPublicMarket) return json(res, { error: 'Public market selection is unavailable in this runtime' }, 503);
    const body = await readBody(req);
    if (!body || typeof body.instrumentId !== 'string') return json(res, { error: 'An exact catalog instrumentId is required' }, 400);
    const result = await services.selectPublicMarket(body.instrumentId);
    return json(res, result, result.statusCode ?? (result.ok ? 202 : 503));
  }
  if (req.method === 'GET' && url.pathname === '/api/diagnostics') {
    const delay = services.metrics?.eventLoop;
    return json(res, { ok: true, pid: process.pid, uptimeSec: Math.round(process.uptime()), rssBytes: process.memoryUsage().rss,
      eventLoopDelayMs: delay ? { p50: delay.percentile(50) / 1e6, p95: delay.percentile(95) / 1e6, p99: delay.percentile(99) / 1e6, max: delay.max / 1e6 } : null,
      appliedMessages: services.metrics?.appliedMessages ?? 0, feedManager: services.retainedProviders?.feeds?.startDiagnostics?.() ?? null, statuses: state.statuses, quota: quota.snapshot() });
  }
  if (req.method === 'GET' && url.pathname === '/api/status') return json(res, { venues: state.statuses, quota: quota.snapshot() });
  if (req.method === 'GET' && url.pathname === '/api/stream') {
    const wireBound = parseLiquidityWireBound(url.searchParams);
    if (!wireBound.ok) return json(res, { error: 'Invalid liquidity wire negotiation', reason: wireBound.reason }, 400);
    const liquidityWireBytes = wireBound.maxBytes ?? undefined;
    const nativeBookAliases = wireBound.nativeBookAliases === true;
    const liveStateTail = url.searchParams.getAll('liveTail').length === 1 && url.searchParams.get('liveTail') === '1';
    const tailRevisionValues = url.searchParams.getAll('tailRecoveryRevision');
    if (tailRevisionValues.length > 1 || tailRevisionValues.length === 1
        && (!liveStateTail || !/^(0|[1-9]\d*)$/.test(tailRevisionValues[0]!)
          || nativeTailRecoveryRevision(Number(tailRevisionValues[0])) === null))
      return json(res, { error: 'Invalid native tail recovery negotiation', reason: 'invalid-tail-recovery-revision' }, 400);
    const tailRecoveryRevision = tailRevisionValues.length === 0 ? 0 : Number(tailRevisionValues[0]);
    const baselineVersions = url.searchParams.getAll('retainedBaseline');
    if (baselineVersions.length > 1) return json(res, { error: 'Invalid retained baseline negotiation', reason: 'duplicate-retained-baseline-arguments' }, 400);
    const retainedBaseline = baselineVersions.length === 1;
    if (retainedBaseline && baselineVersions[0] !== RETAINED_STATE_BASELINE_VERSION)
      return json(res, { error: 'Invalid retained baseline negotiation', reason: 'unsupported-retained-baseline-version' }, 400);
    if (retainedBaseline && (!liveStateTail || liquidityWireBytes === undefined || !nativeBookAliases))
      return json(res, { error: 'Retained baseline requires live tail, bounded liquidity wire and native book aliases', reason: 'retained-baseline-prerequisites-required' }, 400);
    const processMemory = services.retainedProviders?.processMemory;
    if (typeof processMemory?.reserveTransient !== 'function') return json(res, { error: 'SSE snapshot memory admission unavailable', reason: 'physical-rss-unavailable' }, 503);
    const cloneReservationBytes = addResponseReservationBytes(
      HTTP_STATE_RESPONSE_BASE_RESERVATION_BYTES,
      stateSnapshotCloneReservationBytes(state, { compact: true }),
    );
    const snapshotReservation = processMemory.reserveTransient(cloneReservationBytes, { kind: 'http-stream-initial-snapshot' });
    if (!snapshotReservation?.admitted) return json(res, { error: 'SSE snapshot memory admission rejected', reason: snapshotReservation?.reason ?? 'physical-rss-reservation-hard-limit' }, 503);
    try {
      const initialSnapshot = snapshot(state, quota, { compact: true, serverLevelsPerSide: services.metrics?.bookLevelLimit });
      const attach = () => attachStateStream({ req, res, state, quota, clients, bus, metrics: services.metrics, processMemory, queueRegistry: services.retainedProviders?.queues, onQueueRegistryChange: services.invalidateRetainedBudgetSnapshot, initialSnapshot, liveStateTail, tailRecoveryRevision, runTailProjectionAdmitted: services.runTailProjectionAdmitted, liquidityWireBytes, nativeBookAliases, retainedBaseline });
      const admission = services.admitRetainedMutation?.({
        sseClientQueueAllowance: 'x'.repeat(SSE_CLIENT_RETAINED_OVERHEAD_BYTES),
        initialStatusFrame: stateStreamStatus(state, liquidityWireBytes, nativeBookAliases, retainedBaseline),
        initialStateFrame: initialSnapshot,
      }, { kind: 'sse-client', venue: 'local-server' }, attach, (reservation) => {
        if (services.metrics) {
          services.metrics.retainedAdmissionRejected += 1;
          services.metrics.retainedAdmissionLast = { venue: 'local-server', reason: reservation?.reason ?? 'rejected', bytes: Number(reservation?.bytes) || 0, context: reservation?.context ?? { kind: 'sse-client' }, at: Date.now() };
        }
      });
      if (admission && !admission.admitted) return json(res, { error: 'retained admission rejected for SSE client', reason: admission.reservation?.reason ?? 'rejected' }, 503);
      if (!admission) attach();
      return;
    } finally {
      snapshotReservation.release?.();
    }
  }
  if (req.method === 'POST' && url.pathname === '/api/refresh') {
    const body = await readBody(req);
    if (body === null) return json(res, { error: 'Refresh request body must be a JSON object' }, 400);
    const requestedKind = String(body.kind || 'manual'); const kind = services.provider && requestedKind === 'manual' ? 'heatmap' : providerKindFor(requestedKind);
    if (!providerRequestAllowed(kind)) return json(res, { error: `provider refresh kind is not allowed: ${requestedKind}` }, 400);
    if (services.provider) {
      try {
        const result = await services.refreshProvider!(kind, { coin: body.coin });
        if (result?.ok) return json(res, result, 202);
        return json(res, { error: result?.error || 'provider refresh unavailable', quota: quota.snapshot() }, result?.statusCode || 503);
      } catch (error) {
        state.statuses.hypertracker = { ...(state.statuses.hypertracker || {}), state: 'unavailable', lastError: errorMessage(error), lastRequest: Date.now() };
        services.publishState?.();
        return json(res, { error: errorMessage(error), quota: quota.snapshot() }, 503);
      }
    }
    // A disabled provider is an unavailable capability. Do not spend quota or
    // report a successful refresh against a fixture cache.
    state.statuses.hypertracker = { ...(state.statuses.hypertracker || {}), state: 'disabled', lastError: 'HyperTracker is disabled; configure a verified provider before refreshing', lastRequest: Date.now() };
    services.publishState?.();
    return json(res, { error: 'HyperTracker is disabled; configure a verified provider before refreshing', kind: requestedKind, quota: quota.snapshot() }, 503);
  }
  if (req.method === 'GET') return sendUiStaticResponse(res, url.pathname);
  return json(res, { error: 'method not allowed' }, 405);
}

function mergeRestoredState(base: RuntimeState, saved: Partial<RuntimeState> | null) {
  if (!saved || typeof saved !== 'object') return base;
  const restoredLayers = saved.layers ?? base.layers;
  for (const [layer, summary] of Object.entries(saved.layerSummary ?? {})) {
    const inactive = new Set(Array.isArray(summary?.inactiveIds) ? summary.inactiveIds : []);
    if (inactive.size && Array.isArray(restoredLayers?.[layer])) restoredLayers[layer] = restoredLayers[layer].map((level) => inactive.has(String(level?.id)) ? { ...level, active: false } : level);
  }
  return {
    ...base, ...saved,
    markets: saved.markets ?? base.markets,
    books: saved.books ?? base.books,
    booksByKey: saved.booksByKey ?? base.booksByKey,
    activeBookKeys: saved.activeBookKeys ?? base.activeBookKeys,
    bookSelection: saved.bookSelection ?? base.bookSelection,
    layers: restoredLayers,
    layerMeta: saved.layerMeta ?? base.layerMeta,
    layerRevisions: saved.layerRevisions ?? base.layerRevisions,
    layerSourceTimestamps: saved.layerSourceTimestamps ?? base.layerSourceTimestamps,
    oi: saved.oi ?? base.oi,
    candles: saved.candles ?? base.candles,
    metadata: saved.metadata ?? base.metadata,
    trades: saved.trades ?? base.trades,
    statuses: saved.statuses ?? base.statuses,
    feedStatuses: saved.feedStatuses ?? base.feedStatuses,
    sourceTimestamps: saved.sourceTimestamps ?? base.sourceTimestamps,
  };
}

function finiteAt(value: unknown, fallback = Date.now()) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function knownSourceTimestamp(value: unknown) {
  if (value == null) return null;
  if (typeof value !== 'number' && (typeof value !== 'string' || !/^\d+(?:\.\d+)?$/.test(value.trim()))) return null;
  const timestamp = Number(value);
  return Number.isFinite(timestamp) && timestamp > 0 ? timestamp : null;
}

function newerRevision(previous: unknown, next: unknown) {
  if (previous == null || previous === 'unverified') return true;
  const a = Number(previous); const b = Number(next);
  if (Number.isFinite(a) && Number.isFinite(b)) return b > a;
  // Opaque provider revisions are ordered by source timestamp when one side
  // is numeric; do not let a representation change hide a newer snapshot.
  if (Number.isFinite(a) !== Number.isFinite(b)) return true;
  const parseOpaque = (value: unknown) => { const match = String(value).match(/^(.*?)(\d+)$/); return match ? { prefix: match[1], number: Number(match[2]) } : null; };
  const left = parseOpaque(previous); const right = parseOpaque(next); if (left && right && left.prefix === right.prefix && left.number !== right.number) return right.number > left.number;
  return String(next) > String(previous);
}

function providerCompleteness(raw: unknown, kind: string) {
  return hyperTrackerCompleteness(raw, { kind });
}

function providerProvenance(value: unknown) {
  const raw = value as { revision?: unknown; snapshotId?: unknown; meta?: { revision?: unknown; snapshotId?: unknown } } | null | undefined;
  const sourceTimestamp = hyperTrackerSourceTimestamp(raw);
  const revisionCandidates = [raw?.revision, raw?.snapshotId, raw?.meta?.revision, raw?.meta?.snapshotId];
  const revision = revisionCandidates.find((value) => value != null && String(value).trim());
  return { sourceTimestamp, revision: revision == null ? undefined : String(revision), sourceTimestampKnown: sourceTimestamp != null, revisionKnown: revision != null, known: sourceTimestamp != null || revision != null };
}

function registerDepthMarket(state: DepthMarketState, message: RuntimeMessage, venue: string): boolean {
  const instrumentId = String(message?.instrumentId ?? '');
  if (!instrumentId) return false;
  const metadataAsset = (state.metadata?.[String(venue ?? instrumentId.split(':')[0]).toLowerCase()]?.assets ?? []).find((asset) => String(asset?.instrumentId ?? '') === instrumentId) ?? {};
  const provided = { ...(message.market && typeof message.market === 'object' ? message.market : {}), ...metadataAsset };
  const existing = (state.markets ?? []).find((market) => String(market.instrumentId ?? market.id) === instrumentId);
  if (existing) {
    const priorUnit = existing.quantityUnit, priorContractValue = existing.contractValue;
    const priorContractType = existing.contractType, priorInverse = existing.inverse, priorTickSize = existing.tickSize;
    // A fixture or earlier placeholder may already expose the instrument. A
    // live depth snapshot still carries authoritative unit/contract metadata;
    // merge those explicit fields so a contract feed is not rendered as base.
    const explicitUnit = provided.quantityUnit ?? message.units;
    if (explicitUnit === 'base' || explicitUnit === 'quote' || explicitUnit === 'contract') existing.quantityUnit = explicitUnit;
    const explicitContractValue = Number(provided.contractValue ?? message.contractValue);
    if (Number.isFinite(explicitContractValue) && explicitContractValue > 0) existing.contractValue = explicitContractValue;
    if (provided.contractType === 'inverse' || provided.contractType === 'linear') existing.contractType = provided.contractType;
    if (typeof provided.inverse === 'boolean') existing.inverse = provided.inverse;
    if (provided.tickSize != null || message.tickSize != null) {
      const explicitTickSize = Number(provided.tickSize ?? message.tickSize);
      if (Number.isFinite(explicitTickSize) && explicitTickSize > 0) existing.tickSize = explicitTickSize;
    }
    return existing.quantityUnit !== priorUnit || existing.contractValue !== priorContractValue
      || existing.contractType !== priorContractType || existing.inverse !== priorInverse || existing.tickSize !== priorTickSize;
  }
  const symbol = String(provided.nativeSymbol ?? message.nativeSymbol ?? instrumentId.split(':').slice(1).join(':'));
  const normalizedVenue = String(provided.venue ?? venue ?? instrumentId.split(':')[0]).toLowerCase();
  const inferredBase = symbol.replace(/[-_:]*(USDT|USDC|USD|BTC|ETH)$/i, '') || symbol;
  const base = String(provided.base ?? message.base ?? inferredBase).toUpperCase();
  const quote = String(provided.quote ?? message.quote ?? (symbol.toUpperCase().includes('USDC') ? 'USDC' : symbol.toUpperCase().includes('USDT') ? 'USDT' : 'USD')).toUpperCase();
  const rawTickSize = Number(provided.tickSize ?? message.tickSize);
  const tickSize = Number.isFinite(rawTickSize) && rawTickSize > 0 ? rawTickSize : null;
  const rawContractValue = Number(provided.contractValue ?? message.contractValue);
  state.markets.push({ id: instrumentId, instrumentId, venue: normalizedVenue, exchange: normalizedVenue, nativeSymbol: symbol, symbol, base, quote, baseNormalized: base, quoteNormalized: quote, marketType: typeof message.marketType === 'string' ? message.marketType : provided.marketType ?? 'perpetual', tickSize, ...(Number.isFinite(rawContractValue) && rawContractValue > 0 ? { contractValue: rawContractValue } : {}), quantityUnit: provided.quantityUnit ?? (typeof message.units === 'string' ? message.units : 'base'), ...(provided.contractType === 'inverse' || provided.contractType === 'linear' ? { contractType: provided.contractType } : {}), ...(typeof provided.inverse === 'boolean' ? { inverse: provided.inverse } : {}), isFree: true, aggregationId: 0 });
  return true;
}

/** Recording precision is independent of the display grid. A source's coarser
 * compatible bounds remain authoritative in HeatmapRetentionBuffer. */
function configuredHeatmapHistoryPriceStep(): number {
  const configured = Number(process.env.HEATMAP_HISTORY_PRICE_STEP);
  return Number.isFinite(configured) && configured > 0
    ? configured : process.env.ENABLE_LIVE_FEEDS === 'true' ? 10 : 50;
}

export function createLocalServer({
  state: initialState = cloneFixtureState(),
  quota = new QuotaLedger({ filePath: process.env.QUOTA_FILE || defaultQuotaPath }),
  history = new HistoryStore({
    filePath: process.env.HISTORY_DB || defaultHistoryPath,
    heatmapIntervalMs: Math.max(60_000, Number(process.env.HEATMAP_HISTORY_INTERVAL_MS ?? (process.env.ENABLE_LIVE_FEEDS === 'true' ? 60_000 : 1_500_000))),
    heatmapPriceStep: configuredHeatmapHistoryPriceStep(),
  }),
  provider = null,
  providerPaths = {},
  host = '127.0.0.1',
  fixtureTickMs = 0,
  restoreState = false,
  persistFixture = true,
  liveMode = false,
  refreshIntervalMs = Number(process.env.REFRESH_INTERVAL_MS ?? DEFAULT_REFRESH_MS),
  retainedProviders = {},
  retainedBudgetIntervalMs = Number(process.env.HLM_RETAINED_BUDGET_INTERVAL_MS ?? 1_000),
  fixtureTickAutostart = process.env.HLM_FIXTURE_TICK_AUTOSTART !== 'false',
  processMemoryRead = undefined,
  activeCandleInstrumentIds = [],
}: LocalServerOptions = {}) {
  let state = initialState as RuntimeState;
  state.tailRecoveryRevision ??= 0;
  const startupCandleIds = new Set((activeCandleInstrumentIds instanceof Set || Array.isArray(activeCandleInstrumentIds) ? [...activeCandleInstrumentIds] : [])
    .map((value) => String(value ?? '').trim()).filter(Boolean));
  const retainedQueues = new Set<ServerQueue>();
  const providerFlights = new Map<string, Promise<ProviderRefreshResult>>();
  const providerResourceFlights = new Map<string, Promise<ProviderResourceResult>>();
  const publicCatalogFlights = new Map<string, Promise<PublicCatalogReply>>();
  let publicMarketControls: PublicMarketControls | null = null;
  let publicMarketControlGeneration = 0;
  let publicMarketSelectionBusy = false;
  const providerRetainedPayloads = new Map<string, { logicalBytes: number; temporaryBytes: number; consumers: number; physical: ProcessMemoryReservation | null }>();
  const providerFlightCount = () => providerFlights.size + providerResourceFlights.size + publicCatalogFlights.size;
  const processMemory = new ProcessMemoryMonitor();
  retainedProviders = { ...retainedProviders, queues: retainedQueues, processMemory };
  // A replacement briefly retains the old value while the new value is being
  // normalized and persisted. Every mutation reserves the current retained
  // state graph as an envelope as well as its complete candidate payload. The
  // bounded structural allowance covers fresh status/map/representation
  // object shells whose keys are created by the reducer rather than supplied
  // by the provider. This is intentionally conservative: it makes a hard
  // admission decision fail closed instead of publishing an undercounted
  // copy-on-write result.
  const retainedAdmissionStructuralOverhead = Object.freeze({
    status: { state: 'live', lastSuccess: 0, lastError: null, gaps: 0, resyncRequired: false, retainedAdmission: {} },
    identity: { kind: '', venue: '', instrumentId: '', bookKey: '', layer: '', revision: '', sourceKey: '' },
    boundedShell: 'x'.repeat(4096),
  });
  /** The whole-graph byte walk that used to run per message (~90% of server CPU) is gone;
   * callers still pass their candidate for the few thunks that compute side-effect allowances. */
  const retainedAllocationBytes = (..._values: unknown[]): AdmissionEstimate => ({ bytes: 0, measurements: null });
  /** Retained-memory admission was removed: the per-message byte estimate cost ~90% of server CPU
   * and its RSS-pressure reclaim evicted live state. Mutations now simply run. */
  const runRetainedAdmission = <T,>(allocation: number | AdmissionEstimate | (() => AdmissionEstimate), context: MutationContext, mutation: (reservation: MutationReservation) => T, _onReject?: ((reservation: MutationReservation) => void) | null): MutationResult<T> => {
    // The allocation estimate is not evaluated: nothing uses it any more, and building it walked the layers on every price tick.
    void allocation;
    const reservation: MutationReservation = { admitted: true, enforced: false, bytes: 0, reason: null, context };
    return { admitted: true, value: mutation(reservation), reservation };
  };
  const runRetainedRemoval = <T,>(context: MutationContext, mutation: (reservation: MutationReservation) => T): MutationResult<T> => {
    const value = mutation({ admitted: true, enforced: false, bytes: 0, reason: 'shrink-only', context });
    return { admitted: true, value };
  };
  retainedBudgetIntervalMs = Math.max(250, Math.min(60_000, Math.trunc(Number(retainedBudgetIntervalMs) || 1_000)));
  let retainedBudgetTimer: ReturnType<typeof setTimeout> | null = null;
  let retainedBudgetClosed = false;
  const scheduleRetainedBudget = () => {
    if (retainedBudgetClosed || retainedBudgetTimer !== null) return;
    retainedBudgetTimer = setTimeout(() => {
      retainedBudgetTimer = null;
      if (retainedBudgetClosed) return;
      scheduleRetainedBudget();
    }, retainedBudgetIntervalMs);
    retainedBudgetTimer.unref?.();
  };
  const savedState = restoreState ? history.latestState() : null;
  const savedIsLive = savedState?.liveMode === true || savedState?.dataMode === 'live';
  const restored = savedState && savedIsLive === liveMode ? savedState : null;
  state = mergeRestoredState(state, restored);
  state.tailRecoveryRevision ??= 0;
  state.layerMeta ??= {};
  state.layerRevisions ??= {};
  state.layerSourceTimestamps ??= {};
  state.sourceTimestamps ??= {};
  state.candles ??= {};
  state.metadata ??= {};
  state.trades ??= [];
  state.feedStatuses ??= {};
  state.booksByKey ??= {};
  state.bookSelection ??= {};
  state.activeBookKeys ??= {};
  state.venueRegistry ??= venueRegistrySnapshot();
  let activeBookSetManaged = false;
  state.markInstrumentId ??= 'hyperliquid:BTC-PERP';
  // Mark events have a process-local continuity identity. A process restart or
  // upstream asset-context reconnect rotates the epoch so the browser must
  // re-anchor instead of comparing prices across an unobserved gap.
  let markSessionId = `${process.pid}:${Date.now()}`;
  let markEpoch = 0;
  state.markSessionId = markSessionId;
  state.markSequence = 0;
  state.liquiditySessionId = `${process.pid}:${Date.now()}:books`;
  state.liquiditySequence = 0;
  const bookLevelLimit = Math.max(100, Math.min(20_000, Math.trunc(Number(process.env.BOOK_LEVEL_LIMIT ?? 10_000))));
  for (const [instrumentId, book] of Object.entries(state.books ?? {})) {
    const capped = capSortedBook(book, bookLevelLimit);
    const resolutionKey = resolutionKeyForBook(capped);
    const normalized = { ...capped, instrumentId: capped.instrumentId ?? instrumentId, resolutionKey, bookKey: capped.bookKey ?? bookKey(instrumentId, resolutionKey) };
    state.books[instrumentId] = normalized;
    state.booksByKey[normalized.bookKey] ??= normalized;
  }
  for (const [key, book] of Object.entries(state.booksByKey ?? {})) {
    const instrumentId = book?.instrumentId ?? (String(key).includes('|') ? String(key).slice(0, String(key).lastIndexOf('|')) : key);
    const resolutionKey = book?.resolutionKey ?? (String(key).includes('|') ? String(key).slice(String(key).lastIndexOf('|') + 1) : resolutionKeyForBook(book));
    state.booksByKey[key] = { ...capSortedBook(book, bookLevelLimit), instrumentId, resolutionKey, bookKey: book?.bookKey ?? key };
  }
  state.liveMode = liveMode;
  state.dataMode = liveMode ? 'live' : (state.dataMode ?? 'fixture');
  state.markObserved = liveMode ? false : state.markObserved !== false;
  // A live restart may restore only the durable summary, but the base state
  // still contains fixture books/layers and the saved status snapshot may say
  // "live" until the new sockets have produced an observation. Fence every
  // high-frequency/provider-derived value on all live startups so the browser
  // cannot treat restored or fixture data as fresh public data.
  if (liveMode) {
    state.asOf = 0;
    state.markPrice = 0;
    state.markObserved = false;
    state.markContinuity = { state: 'reanchor', reason: 'process-restart', at: Date.now(), sessionId: markSessionId };
    state.oi = [];
    state.candles = {};
    state.metadata = {};
    state.trades = [];
    state.layers = { liquidation: [], stopLoss: [], takeProfit: [] };
    state.layerMeta = {};
    state.layerRevisions = {};
    state.layerSourceTimestamps = {};
    state.activeBookKeys = {};
    state.bookSelection = {};
    state.sourceTimestamps = {};
    state.feedStatuses = {};
    const fenceBook = (book: RuntimeBook) => {
      const next: RuntimeBook = {
        ...book,
        complete: false,
        gap: false,
        sequence: null,
        sourceTimestamp: null,
        bids: [],
        asks: [],
        levelMetadata: { bids: {}, asks: {} },
        coverage: 'unknown',
        coverageBounds: null,
        observedBounds: { bids: null, asks: null },
        sourceLevelCount: { bids: 0, asks: 0 },
        retainedLevelCount: { bids: 0, asks: 0 },
        retentionTruncated: false,
      };
      for (const key of ['representation', 'receivedAt', 'feedId', 'sourceGrouping', 'sourceDepth', 'sourceInterval', 'pool', 'sourceKey', 'sourceRevision']) delete next[key];
      return next;
    };
    for (const id of Object.keys(state.books ?? {})) state.books[id] = fenceBook(state.books[id]);
    for (const key of Object.keys(state.booksByKey ?? {})) state.booksByKey[key] = fenceBook(state.booksByKey[key]);
    state.statuses = {
      hyperliquid: { state: 'unavailable', gaps: 0 },
      binance: { state: 'unavailable', gaps: 0 },
    };
  }
  const bus = new LocalEventBus<ServerStreamFrame>();
  const clients = new Set<ServerResponse>();
  const providerRef = { current: provider, generation: 0 };
  const eventLoop = monitorEventLoopDelay({ resolution: 20 });
  eventLoop.enable();
  const metrics: ServerMetrics = {
    startedAt: Date.now(), fixtureTickMs: fixtureTickMs > 0 ? fixtureTickMs : null, fixtureTicksRunning: false,
    fixtureFeedCount: parseFixtureFeedCount(process.env.FIXTURE_FEED_COUNT),
    fixtureBookLevels: parseFixtureBookLevels(process.env.FIXTURE_BOOK_LEVELS),
    fixtureBookBurstCount: parseFixtureBookBurstCount(process.env.FIXTURE_BOOK_BURST_COUNT),
    fixtureBookInstrumentIds: parseFixtureBookInstrumentIds(process.env.FIXTURE_BOOK_INSTRUMENT_IDS),
    bookLevelLimit,
    fixtureFeedEvents: 0, fixtureBookSnapshots: 0, fixtureBookDeltas: 0, fixtureBookEventsByFeed: {}, fixtureBookDeltaEventsByFeed: {}, fixtureBookLevelCountsByFeed: {}, fixtureBookSequencesByFeed: {}, fixtureBookCompleteByFeed: {}, fixtureBookGapByFeed: {},
    fixtureTicks: 0, appliedMessages: 0, statePublishes: 0, stateRequests: 0, retainedAdmissionRejected: 0, retainedAdmissionLast: null, retainedRemovalMutations: 0, retainedRemovalLast: null, physicalAdmissionRejected: 0, physicalAdmissionLast: null, memorySamples: 0, processMemoryPeak: null, physicalMemory: null,
    lastTickAt: null, lastPublishAt: null, streamStateSent: 0,
    streamLiquiditySent: 0, streamLiquidityReplacements: 0, liquidityPublishes: 0, liquiditySnapshotRejected: 0, liquidityFrameMaxBytes: 0,
    streamStateReplacements: 0, streamMarkSent: 0, streamMarkReplacements: 0, streamDrainWaits: 0, streamWriteErrors: 0, streamStateSnapshotAdmissionRejected: 0, streamStateSnapshotAdmissionLast: null, maxPendingState: 0, maxPendingSlots: 0, markPublishes: 0, markSequence: 0, eventLoop,
  };
  let timer: ReturnType<typeof setInterval> | null = null;
  let providerTimer: ReturnType<typeof setTimeout> | null = null;
  let providerPollingKind: 'liquidation' | 'stopLoss' | 'takeProfit' = 'liquidation';
  let providerPollGeneration = 0;
  let providerPollActive = false;
  let providerPollInFlight = false;
  let tickNumber = 0;
  let lastPruneAt = 0;
  // Live depth/trade feeds can deliver hundreds of messages per second. Keep
  // state mutations immediate, but bound expensive full-state JSON/SSE work.
  const statePublishMinMs = Math.max(50, Number(process.env.STATE_PUBLISH_MIN_MS ?? 250));
  const statePersistMinMs = Math.max(1_000, Number(process.env.STATE_PERSIST_MIN_MS ?? 10_000));
  let publishTimer: ReturnType<typeof setTimeout> | null = null;
  let lastPublishAt = 0;
  let lastPersistAt = 0;
  const sampleProcessMemory = () => {
    const sample = processMemory.sample();
    metrics.physicalMemory = processMemory.snapshot();
    metrics.memorySamples += 1;
    if (!sample.measured) return sample;
    const current = {
      rssBytes: sample.rssBytes,
      heapUsedBytes: sample.heapUsedBytes,
      heapTotalBytes: sample.heapTotalBytes,
      externalBytes: sample.externalBytes,
      arrayBuffersBytes: sample.arrayBuffersBytes,
    };
    const prior = metrics.processMemoryPeak ?? {};
    metrics.processMemoryPeak = Object.fromEntries(Object.entries(current).map(([key, value]) => [key, Math.max(Number(prior[key]) || 0, Number(value))]));
    return sample;
  };
  sampleProcessMemory();

  if (liveMode) {
    const defaultInterval = String(process.env.CANDLE_INTERVAL ?? '1m');
    for (const market of state.markets ?? []) {
      const instrumentId = String(market.instrumentId || market.id);
      const cached = history.listCandles(instrumentId, { interval: defaultInterval, from: 0, limit: 2_000, newestFirst: true });
      if (!cached.length || !ensureCandleSeriesSlot(state, { history, feeds: retainedProviders.feeds, instrumentId, startupCandleInstrumentIds: startupCandleIds })) continue;
      state.candles[instrumentId] = mergeCandleRows(state.candles[instrumentId] ?? [], cached);
    }
  }

  if (persistFixture || restored) for (const sample of state.oi || []) history.recordOi(sample);
  history.recordState(state);
  // Persist the first post-start update immediately, then use the bounded
  // cadence below for the high-frequency stream.
  lastPersistAt = 0;

  const publishStateNow = () => {
    publishTimer = null;
    const now = Date.now();
    if (now - lastPersistAt >= statePersistMinMs) { history.recordState(state); lastPersistAt = now; }
    if (now - lastPruneAt >= 60_000) { history.prune(now); lastPruneAt = now; }
    lastPublishAt = now;
    metrics.statePublishes += 1;
    metrics.lastPublishAt = now;
  };
  /** Persistence/prune cadence only: the UI reads state through the v2 data plane, not a published snapshot. */
  const publishState = (_options: { bookOnly?: boolean } = {}) => {
    if (publishTimer !== null) return;
    const now = Date.now();
    if (!lastPublishAt || now - lastPublishAt >= statePublishMinMs) { publishStateNow(); return; }
    publishTimer = setTimeout(publishStateNow, statePublishMinMs - (now - lastPublishAt));
    publishTimer.unref?.();
  };
  const publishLiquidity = (_receivedAt = Date.now()) => { state.liquiditySequence += 1; };
  const publishActivityMetadata = (_venue: string, _receivedAt: number) => { publishState(); };
  const publishMark = (_options: PublishMarkOptions = {}) => {
    const sequence = metrics.markSequence + 1;
    metrics.markSequence = sequence;
    metrics.markPublishes += 1;
    state.markSequence = sequence;
    state.markSessionId = markSessionId;
  };

  const resetMarkContinuity = (reason = 'upstream-reconnect') => {
    markEpoch += 1;
    markSessionId = `${process.pid}:${Date.now()}:${markEpoch}`;
    metrics.markSequence = 0;
    state.markSequence = 0;
    state.markSessionId = markSessionId;
    state.markObserved = false;
    state.markContinuity = { state: 'reanchor', reason: String(reason), at: Date.now(), sessionId: markSessionId };
  };

  const recordCrossings = (kind: string, previousLevels: RuntimeLevel[], nextLevels: RuntimeLevel[], observedAt: number, crossingFrame: MarkCrossingAccumulator) => {
    for (const level of nextLevels) {
      const prior = previousLevels.find((item) => item.id === level.id);
      if (level.provisional && !prior?.provisional) {
        const direction = crossingDirection(level);
        history.recordCrossing({ levelId: level.id, observedAt, layer: kind, price: state.markPrice, direction, provisional: true });
        const crossing = { levelId: level.id, layer: kind, instrumentId: level.instrumentId || state.markInstrumentId, targetKey: crossingTargetKey(level, String(level.instrumentId || state.markInstrumentId || '')), price: state.markPrice, direction, observedAt, provisional: true };
        if (crossingFrame.rows.length === MARK_CROSSING_LIMIT) {
          crossingFrame.rows[crossingFrame.nextIndex] = crossing;
          crossingFrame.nextIndex = (crossingFrame.nextIndex + 1) % MARK_CROSSING_LIMIT;
          crossingFrame.overflow = true;
        } else {
          crossingFrame.rows.push(crossing);
        }
      }
    }
  };

  const rejectRetainedMutation = (venue: string, reservation: MutationReservation, { sourceKey = null, previousSourceTimestamp, statusPatch = {} }: { sourceKey?: string | null; previousSourceTimestamp?: number | null; statusPatch?: RuntimeStatus } = {}) => {
    metrics.retainedAdmissionRejected += 1;
    metrics.retainedAdmissionLast = { venue: String(venue ?? 'unknown'), reason: reservation?.reason ?? 'rejected', bytes: Number(reservation?.bytes) || 0, context: reservation?.context ?? null, at: Date.now() };
    const key = String(venue ?? 'unknown');
    state.statuses[key] = { ...(state.statuses[key] || {}), state: 'unavailable', lastError: `retained-data admission rejected: ${reservation?.reason ?? 'unknown'}`, retainedAdmission: { reason: reservation?.reason ?? 'unknown', bytes: Number(reservation?.bytes) || 0 }, ...statusPatch };
    if (sourceKey) {
      if (previousSourceTimestamp === undefined) delete state.sourceTimestamps[sourceKey];
      else state.sourceTimestamps[sourceKey] = previousSourceTimestamp;
    }
    publishState();
  };

  const applyLayerSnapshot = (message: RuntimeMessage, sourceContext: MutationContext = {}) => {
    const layer = String(message.layer);
    if (layer !== 'liquidation' && layer !== 'stopLoss' && layer !== 'takeProfit') return false;
    const instrumentId = message.instrumentId || state.markInstrumentId;
    const revisionKey = `${layer}|${instrumentId}`;
    const provenanceKnown = message.provenanceKnown !== false;
    const providerSourceTimestamp = knownSourceTimestamp(message.sourceTimestamp);
    const sourceTimestampKnown = (message.sourceTimestampKnown ?? provenanceKnown) && providerSourceTimestamp != null;
    const revisionKnown = message.revisionKnown ?? provenanceKnown;
    const previousRevision = state.layerRevisions[revisionKey];
    const revision = revisionKnown ? String(message.revision ?? (sourceTimestampKnown ? message.sourceTimestamp : Date.now())) : String(previousRevision ?? 'unverified');
    if (revisionKnown && !newerRevision(previousRevision, revision)) return false;
    const previous = state.layers[layer] || [];
    const providerAt = sourceTimestampKnown ? providerSourceTimestamp : 0;
    if (sourceTimestampKnown && state.layerSourceTimestamps[revisionKey] != null && providerAt < Number(state.layerSourceTimestamps[revisionKey])) return false;
    const incoming = (message.levels || []).filter((level) => Number(level.price) > 0).map((level): RuntimeLevel => {
      const prior = previous.find((item) => item.id === level.id);
      const sameTarget = sameProviderCrossingTarget(prior, level, layer, instrumentId);
      const capturedBeforeCrossing = sameTarget && prior?.provisional === true && (message.preserveProvisional === true || !sourceTimestampKnown || (Number.isFinite(Number(prior.takenAt)) && providerAt <= Number(prior.takenAt)));
      const levelSourceTimestamp = sourceTimestampKnown ? (knownSourceTimestamp(level.sourceTimestamp) ?? providerAt) : (knownSourceTimestamp(level.sourceTimestamp) ?? (sameTarget ? prior?.sourceTimestamp : undefined));
      return {
        ...level,
        layer,
        instrumentId,
        price: Number(level.price),
        active: capturedBeforeCrossing ? false : level.active !== false,
        provisional: capturedBeforeCrossing ? true : level.provisional,
        takenAt: capturedBeforeCrossing ? prior.takenAt : level.takenAt,
        ...(levelSourceTimestamp != null ? { sourceTimestamp: levelSourceTimestamp } : {}),
      };
    });
    const levels = message.complete === false
      ? [...new Map([...previous, ...incoming].map((level) => [level.id, level])).values()]
      : incoming;
    const layerMeta = {
      instrumentId, revision, sourceTimestamp: sourceTimestampKnown ? providerSourceTimestamp : null,
      receivedAt: finiteAt(message.receivedAt), complete: message.complete !== false,
      coverage: String(message.coverage ?? (message.complete === false ? 'provider-sampled' : 'provider')), provenanceKnown: sourceTimestampKnown || revisionKnown, sourceTimestampKnown, revisionKnown,
      units: typeof message.units === 'string' ? message.units : 'USD notional', empty: levels.length === 0,
      ...(message.mock === true ? { mock: true, source: 'hypertracker-mock', generatedAt: message.generatedAt } : {}),
    };
    const admission = runRetainedAdmission(
      // Include the complete provider payload: every field copied into a
      // retained level/metadata record must be covered before the mutation.
      () => retainedAllocationBytes(previous, message, { layer, instrumentId, revision, levels, meta: layerMeta }),
      { kind: 'layer', layer, instrumentId, revision },
      () => {
        state.layers[layer] = levels;
        state.layerRevisions[revisionKey] = revisionKnown ? revision : (previousRevision ?? revision);
        if (sourceTimestampKnown) state.layerSourceTimestamps[revisionKey] = providerAt;
        state.layerMeta[layer] = layerMeta;
        if (sourceTimestampKnown) state.sourceTimestamps.hypertracker = providerSourceTimestamp;
        history.recordLayer({ ...message, sourceTimestamp: sourceTimestampKnown ? providerSourceTimestamp : null, layer, instrumentId, revision, levels });
        state.asOf = finiteAt(message.receivedAt);
        return true;
      },
      (reservation) => rejectRetainedMutation('hypertracker', reservation, sourceContext),
    );
    return admission.admitted && admission.value === true;
  };

  /** Accept a decoded multi-trade packet atomically; per-minute footprint volume is recorded by the v2 data plane from state.trades. */
  const applyTradeBatch = (input: unknown, venue = 'unknown'): boolean => {
    if (!Array.isArray(input) || input.length < 2 || input.length > 5_000) return false;
    const rows = input as (RuntimeMessage & TradeRecord)[];
    for (const row of rows) {
      if (!row || typeof row !== 'object' || row.kind !== 'trade' || typeof row.instrumentId !== 'string' || !row.instrumentId || row.instrumentId.length > 256
        || !Number.isFinite(Number(row.receivedAt))) return false;
    }
    const sourceKey = `${venue}:trade`;
    metrics.appliedMessages += rows.length;
    state.trades = [...(state.trades ?? []), ...rows].slice(-5_000);
    for (const row of rows) { const t = knownSourceTimestamp(row.sourceTimestamp); if (t != null) state.sourceTimestamps[sourceKey] = t; }
    state.statuses[venue] = { ...(state.statuses[venue] || {}), state: 'live', lastSuccess: finiteAt(rows[rows.length - 1]!.receivedAt), lastError: null, gaps: state.statuses[venue]?.gaps || 0 };
    publishActivityMetadata(venue, Date.now());
    return true;
  };

  const applyMessage = (input: unknown, venue = 'unknown', { retainedMutation = null }: { retainedMutation?: { candidate: unknown; commit: () => unknown } | null } = {}) => {
    // A proxy is not a validated exchange record; reject it before even reading
    // its kind or spreading it into a candle candidate.
    if (nodeTypes.isProxy(input)) return false;
    const message = input as RuntimeMessage | null | undefined;
    if (!message?.kind) return retainedMutation ? false : undefined;
    if (retainedMutation && (!retainedMutation.candidate || typeof retainedMutation.commit !== 'function')) return false;
    const retainedMutationCandidate = retainedMutation?.candidate;
    const serverReceivedAt = Date.now();
    metrics.appliedMessages += 1;
    const receivedAt = finiteAt(message.receivedAt);
    const sourceKey = `${venue}:${message.kind}`;
    const previousSourceTimestamp = state.sourceTimestamps[sourceKey];
    const providerSourceTimestamp = knownSourceTimestamp(message.sourceTimestamp);
    const recordProviderSource = () => {
      if (providerSourceTimestamp != null) state.sourceTimestamps[sourceKey] = providerSourceTimestamp;
    };
    if (message.kind === 'depthSnapshot') {
      const invalidated = message.invalidated === true || message.gap === true || message.resyncRequired === true;
      if (invalidated) {
        if (previousSourceTimestamp == null) delete state.sourceTimestamps[sourceKey];
        else state.sourceTimestamps[sourceKey] = previousSourceTimestamp;
      }
      const incomingInstrumentId = String(message.instrumentId);
      const incomingResolutionKey = message.resolutionKey ?? resolutionKeyForBook(message);
      const incomingBookKey = message.bookKey ?? bookKey(incomingInstrumentId, incomingResolutionKey);
      const activeKeys = state.activeBookKeys?.[incomingInstrumentId];
      if (activeBookSetManaged && (!Array.isArray(activeKeys) || !activeKeys.includes(incomingBookKey))) {
        if (invalidated) retainedMutation?.commit?.();
        if (invalidated) publishState();
        return invalidated ? true : false;
      }
      const instrumentId = incomingInstrumentId;
      const retainedVariant = state.booksByKey[incomingBookKey]
        ?? (state.books[instrumentId]?.bookKey === incomingBookKey ? state.books[instrumentId] : null);
      const invalidationMessage = invalidated ? {
        kind: 'depthSnapshot', instrumentId, bookKey: incomingBookKey,
        resolutionKey: incomingResolutionKey,
        ...(message.sequence != null ? { sequence: message.sequence } : {}),
        sourceTimestamp: null, receivedAt, complete: false, gap: true,
        invalidated: true, resyncRequired: true,
        invalidReason: String(message.invalidReason ?? 'book resynchronization required').slice(0, 240),
        coverage: 'gap', units: String(message.units ?? 'base').slice(0, 40),
        ...(Number.isFinite(Number(message.contractValue)) && Number(message.contractValue) > 0 ? { contractValue: Number(message.contractValue) } : {}),
        ...(message.pool != null ? { pool: String(message.pool).slice(0, 80) } : {}),
        bids: [], asks: [],
      } : message;
      const sourceBook = invalidated
        ? { bids: [], asks: [], levelMetadata: [] }
        : sortedBookFromSortedSnapshot(message) ?? sortedBook(bookFromSnapshot(message), { includeMetadata: true });
      const book = invalidated ? sourceBook : capSortedBook(sourceBook, bookLevelLimit);
      const candidateBook = {
        complete: !invalidated && message.complete !== false, sequence: message.sequence,
        bids: invalidated ? [] : book.bids, asks: invalidated ? [] : book.asks,
        sourceTimestamp: invalidated ? null : providerSourceTimestamp,
        levelMetadata: book.levelMetadata,
        coverage: invalidated ? 'gap' : message.coverage ?? (message.complete === false || message.resolution === 'coarse' || message.nSigFigs != null || message.mantissa != null ? 'partial' : 'complete'),
        coverageBounds: invalidated ? null : message.coverageBounds ?? depthCoverageBounds(sourceBook),
        sourceLevelCount: invalidated ? { bids: 0, asks: 0 } : message.sourceLevelCount ?? { bids: (message.bids ?? []).length, asks: (message.asks ?? []).length },
        ...(invalidated ? { gap: true, invalidated: true, resyncRequired: true, invalidReason: String(invalidationMessage.invalidReason ?? 'book resynchronization required').slice(0, 240) } : {}),
        units: invalidationMessage.units ?? message.units ?? 'base',
        ...(invalidationMessage.pool != null ? { pool: invalidationMessage.pool } : {}),
        ...(Number.isFinite(Number(message.sourceGrouping)) && Number(message.sourceGrouping) > 0 ? { sourceGrouping: Number(message.sourceGrouping) } : {}),
        ...(Number.isInteger(Number(message.sourceDepth)) && Number(message.sourceDepth) > 0 ? { sourceDepth: Number(message.sourceDepth) } : {}),
        ...(message.sourceInterval ? { sourceInterval: String(message.sourceInterval) } : {}),
        ...(() => {
          const explicit = Number(message.contractValue);
          const registered = Number((state.markets ?? []).find(item => String(item?.instrumentId ?? item?.id) === instrumentId)?.contractValue);
          const contractValue = Number.isFinite(explicit) && explicit > 0 ? explicit : registered;
          return Number.isFinite(contractValue) && contractValue > 0 ? { contractValue } : {};
        })(),
      };
      const normalizedCandidate = normalizeBookVariant(instrumentId, invalidationMessage, candidateBook, bookLevelLimit).normalized;
      // An invalidation for a book that was never retained has nothing to
      // remove. Do not create a gap marker or venue status entry under a
      // removal-only budget bypass; still commit the compact manager session.
      if (invalidated && !retainedVariant) {
        retainedMutation?.commit?.();
        publishState();
        return true;
      }
      // Registering a new depth instrument also retains normalized market
      // metadata. Probe that pure candidate before admission so the market
      // copy is included in the reservation even when the instrument is new.
      const marketProbe = invalidated ? null : { markets: (state.markets ?? []).map((market) => ({ ...market })), metadata: state.metadata };
      const marketChanged = marketProbe ? registerDepthMarket(marketProbe, message, venue) : false;
      const context = { kind: invalidated ? 'depth-invalidation' : 'depthSnapshot', venue, instrumentId, bookKey: incomingBookKey, sequence: message.sequence };
      const mutate = () => {
        if (!invalidated) registerDepthMarket(state, message, venue);
        const stored = storeBookVariant(state, instrumentId, invalidationMessage, candidateBook, bookLevelLimit);
        if (!invalidated) recordProviderSource();
        state.statuses[venue] = invalidated
          ? { ...(state.statuses[venue] || {}), state: 'unavailable', lastError: candidateBook.invalidReason, gaps: (state.statuses[venue]?.gaps || 0) + 1, resyncRequired: true }
          : { ...(state.statuses[venue] || {}), state: message.complete === false ? 'snapshot' : 'live', lastSuccess: receivedAt, lastError: null, gaps: 0, resyncRequired: false };
        retainedMutation?.commit?.();
        return true;
      };
      const admission = invalidated
        ? runRetainedRemoval(context, mutate)
        : runRetainedAdmission(
          // The raw payload includes optional retained fields (for example
          // coverageBounds) that are not safe to reconstruct from the levels.
          () => retainedAllocationBytes(message, normalizedCandidate, marketProbe?.markets, { instrumentId, bookKey: incomingBookKey, sourceTimestamp: message.sourceTimestamp, receivedAt }, retainedMutationCandidate),
          context,
          mutate,
          (reservation) => rejectRetainedMutation(venue, reservation, { sourceKey, previousSourceTimestamp }),
        );
      if (!admission.admitted) return false;
      publishLiquidity(serverReceivedAt);
      publishState({ bookOnly: !invalidated && retainedVariant?.complete === true && retainedVariant.gap !== true
        && normalizedCandidate.complete === true && normalizedCandidate.gap !== true && !marketChanged });
      return true;
    } else if (message.kind === 'depthDelta') {
      const instrumentId = String(message.instrumentId);
      const variantKey = message.bookKey ?? bookKey(instrumentId, message.resolutionKey ?? 'native');
      const activeKeys = state.activeBookKeys?.[instrumentId];
      if (activeBookSetManaged && (!Array.isArray(activeKeys) || !activeKeys.includes(variantKey))) return false;
      const previous = state.booksByKey[variantKey] ?? state.books[instrumentId];
      if (!previous || previous.complete === false) {
        state.statuses[venue] = { ...(state.statuses[venue] || {}), state: 'unavailable', lastError: 'book snapshot required before applying deltas', gaps: (state.statuses[venue]?.gaps || 0) + 1 };
        publishState();
        return false;
      }
      const admission = runRetainedAdmission(
        () => retainedAllocationBytes(previous, message, { kind: 'depthDelta', instrumentId, bookKey: variantKey, sequence: message.sequence, previousSequence: message.previousSequence }, retainedMutationCandidate),
        { kind: 'depthDelta', venue, instrumentId, bookKey: variantKey, sequence: message.sequence, previousSequence: message.previousSequence },
        () => {
          // Books without level metadata (nearly all) are merged in place; the general path rebuilds Maps and re-sorts the whole book per message.
          const quick = applySortedDelta(previous, message, bookLevelLimit);
          const full = quick ? null : applyBookDelta(bookFromSnapshot({ complete: previous.complete, sequence: previous.sequence, bids: previous.bids.map(([price, amount]) => ({ price, amount })), asks: previous.asks.map(([price, amount]) => ({ price, amount })), levelMetadata: previous.levelMetadata }), message);
          const book = { status: quick ? (quick.gap ? 'gap' : 'live') : full!.status, sequence: quick ? (quick.gap ? previous.sequence : quick.sequence) : full!.sequence };
          const sorted = quick ? (quick.gap ? { bids: [], asks: [], levelMetadata: { bids: {}, asks: {} } } : quick) : capSortedBook(sortedBook(full!, { includeMetadata: true }), bookLevelLimit);
          if (book.status === 'gap') {
            const broken = { ...previous, complete: false, gap: true, bookKey: variantKey, resolutionKey: previous.resolutionKey ?? message.resolutionKey ?? 'native' };
            state.booksByKey[variantKey] = broken;
            const selected = selectBookVariant(state, instrumentId); if (selected) state.books[instrumentId] = selected;
            state.statuses[venue] = { ...(state.statuses[venue] || {}), state: 'unavailable', lastError: 'depth sequence gap; waiting for resync', gaps: (state.statuses[venue]?.gaps || 0) + 1, resyncRequired: true };
            retainedMutation?.commit?.();
            return true;
          }
          const updatedBase = annotateBookCoverage({ ...previous, complete: true, gap: false, sequence: book.sequence, bids: sorted.bids, asks: sorted.asks, levelMetadata: sorted.levelMetadata, sourceTimestamp: providerSourceTimestamp, ...(message.pool != null ? { pool: String(message.pool) } : {}), bookKey: variantKey, resolutionKey: previous.resolutionKey ?? message.resolutionKey ?? 'native' });
          const updated = {
            ...updatedBase,
            representation: representationMetadata({
              stage: 'server-state',
              limitPerSide: bookLevelLimit,
              inputLevelCount: previous.representation?.inputLevelCount ?? previous.sourceLevelCount,
              retainedLevelCount: updatedBase.retainedLevelCount,
              resolutionKey: updatedBase.resolutionKey,
              resolution: updatedBase.resolution,
              grouping: updatedBase.sourceGrouping ?? updatedBase.grouping,
              units: updatedBase.units ?? 'venue-native',
              coverage: updatedBase.coverage,
              coverageBounds: updatedBase.coverageBounds,
              observedBounds: updatedBase.observedBounds,
              sourceTimestamp: updatedBase.sourceTimestamp,
            }),
          };
          state.booksByKey[variantKey] = updated;
          const selected = selectBookVariant(state, instrumentId); if (selected) state.books[instrumentId] = selected;
          recordProviderSource();
          state.statuses[venue] = { ...(state.statuses[venue] || {}), state: 'live', lastSuccess: receivedAt, lastError: null, gaps: state.statuses[venue]?.gaps || 0, resyncRequired: false };
          retainedMutation?.commit?.();
          return true;
        },
        (reservation) => rejectRetainedMutation(venue, reservation, { sourceKey, previousSourceTimestamp, statusPatch: { gaps: (state.statuses[venue]?.gaps || 0) + 1, resyncRequired: true } }),
      );
      if (!admission.admitted) return false;
      publishLiquidity(serverReceivedAt);
      const publishedBook = state.booksByKey[variantKey] ?? state.books[instrumentId];
      publishState({ bookOnly: publishedBook?.complete === true && publishedBook.gap !== true });
      return true;
    } else if (message.kind === 'openInterest') {
      const rawSourceTimestamp = message.sourceTimestamp;
      const sourceTimestamp = rawSourceTimestamp == null ? null : Number(rawSourceTimestamp);
      const sourceKnown = sourceTimestamp != null && Number.isFinite(sourceTimestamp) && sourceTimestamp > 0;
      const sample = {
        ...(message as RuntimeMessage & OpenInterestSample),
        sourceTimestamp: sourceKnown ? sourceTimestamp : null,
        observationTimestamp: sourceKnown ? sourceTimestamp : receivedAt,
        timeBasis: sourceKnown ? 'exchange' : 'receipt',
        quality: message.quality ?? (sourceKnown ? 'native' : 'sampled'),
      };
      const previousOi = state.oi;
      const nextOi = [...previousOi, sample as RuntimeState['oi'][number]].slice(-20_000);
      history.recordOi(sample);
      state.oi = nextOi;
      if (oiOutsideNativeTail(previousOi, sample as RuntimeState['oi'][number]) || nextOi.length === 20_000 && previousOi.length >= 20_000) advanceNativeTailRecovery(state);
      recordProviderSource();
      state.statuses[venue] = { ...(state.statuses[venue] || {}), state: 'live', lastSuccess: receivedAt, lastError: null, gaps: state.statuses[venue]?.gaps || 0 };
    } else if (message.kind === 'candle') {
      const instrumentId = String(message.instrumentId || state.markInstrumentId);
      const current = Array.isArray(state.candles[instrumentId]) ? state.candles[instrumentId] : [];
      const incoming = { ...message, instrumentId, source: message.source ?? 'live', sourceTimestamp: providerSourceTimestamp, receivedAt };
      if (!validCandle(incoming)) return;
      // Series are start-ordered: the live bar is the last row, history appends or falls back to a keyed merge.
      const last = current[current.length - 1];
      const prior = last && candleKey(last) === candleKey(incoming) ? last : last && Number(incoming.start) > Number(last.start) ? undefined
        : current.find((item) => candleKey(item) === candleKey(incoming));
      if (!candleCanReplace(prior, incoming)) {
        state.statuses[venue] = { ...(state.statuses[venue] || {}), state: 'live', lastSuccess: receivedAt, lastError: null, gaps: state.statuses[venue]?.gaps || 0 };
        publishActivityMetadata(venue, serverReceivedAt);
        return;
      }
      if (!ensureCandleSeriesSlot(state, { history, feeds: retainedProviders.feeds, instrumentId })) {
        metrics.candleSeriesCapacityRejects = Math.min(Number.MAX_SAFE_INTEGER, (Number(metrics.candleSeriesCapacityRejects) || 0) + 1);
        return false;
      }
      const previousCandles = state.candles[instrumentId] || [];
      const nextCandles = last && Number(incoming.start) > Number(last.start)
        ? [...previousCandles, incoming].slice(-2_000)
        : last && candleKey(last) === candleKey(incoming) ? [...previousCandles.slice(0, -1), incoming]
        : mergeCandleRows(previousCandles, [incoming]);
      history.recordCandle(incoming, { receivedAt, source: incoming.source });
      state.candles[instrumentId] = nextCandles;
      if (candleOutsideNativeTail(nextCandles, incoming)
          || !prior && previousCandles.length >= 2_000 && nextCandles.length <= previousCandles.length) advanceNativeTailRecovery(state);
      recordProviderSource();
      state.statuses[venue] = { ...(state.statuses[venue] || {}), state: 'live', lastSuccess: receivedAt, lastError: null, gaps: state.statuses[venue]?.gaps || 0 };
    } else if (message.kind === 'metadata') {
      const metadataVenue = String(message.venue || venue);
      const admission = runRetainedAdmission(
        () => retainedAllocationBytes(message, retainedMutationCandidate),
        { kind: 'metadata', venue: metadataVenue, assetCount: Array.isArray(message.assets) ? message.assets.length : 0 },
        () => {
          state.metadata[metadataVenue] = message;
          // Provider metadata may arrive after a live depth snapshot. Merge the
          // contract multiplier into the market/book so the renderer can value
          // contract quantities without guessing.
          for (const asset of message.assets ?? []) {
            const instrumentId = String(asset?.instrumentId ?? ''); if (!instrumentId) continue;
            const marketIndex = (state.markets ?? []).findIndex((item) => String(item.instrumentId ?? item.id) === instrumentId);
            if (marketIndex >= 0) {
              const identityKeys = ['nativeSymbol', 'symbol', 'base', 'quote', 'baseNormalized', 'quoteNormalized', 'marketType'];
              const metadataKeys = ['tickSize', 'quantityUnit', 'contractValue', 'contractType', 'inverse', 'lotSize', 'settleCoin'];
              const patch = Object.fromEntries([...identityKeys, ...metadataKeys]
                .filter((key) => asset[key] !== undefined && (typeof asset[key] !== 'string' || asset[key].trim() !== ''))
                .map((key) => [key, asset[key]]));
              state.markets[marketIndex] = { ...state.markets[marketIndex], ...patch };
            }
            for (const collection of [state.books, state.booksByKey]) for (const [key, book] of Object.entries(collection ?? {})) if (String(book?.instrumentId ?? '') === instrumentId && asset.contractValue != null) collection[key] = { ...book, contractValue: Number(asset.contractValue) };
          }
          state.statuses[venue] = { ...(state.statuses[venue] || {}), state: 'snapshot', lastSuccess: receivedAt, lastError: null, gaps: state.statuses[venue]?.gaps || 0 };
          recordProviderSource();
          retainedMutation?.commit?.();
          return true;
        },
        (reservation) => rejectRetainedMutation(venue, reservation, { sourceKey, previousSourceTimestamp }),
      );
      if (!admission.admitted) return retainedMutation ? false : undefined;
    } else if (message.kind === 'trade') {
      state.trades = [...(state.trades ?? []), message as RuntimeMessage & TradeRecord].slice(-5_000);
      recordProviderSource();
      state.statuses[venue] = { ...(state.statuses[venue] || {}), state: 'live', lastSuccess: receivedAt, lastError: null, gaps: state.statuses[venue]?.gaps || 0 };
      publishActivityMetadata(venue, serverReceivedAt);
      return retainedMutation ? true : undefined;
    } else if (message.kind === 'layerSnapshot') {
      if (!applyLayerSnapshot(message, { sourceKey, previousSourceTimestamp })) return;
      if (message.sourceTimestampKnown ?? (message.provenanceKnown !== false)) recordProviderSource();
      publishState();
      return true;
    } else if (message.kind === 'price') {
      const markInstrumentId = state.markInstrumentId || 'hyperliquid:BTC-PERP';
      if (message.instrumentId && message.instrumentId !== markInstrumentId) return;
      const price = Number(message.price);
      if (!(price > 0 && Number.isFinite(price))) return;
      const previous = Number(state.markPrice);
      // Reordered observations cannot turn an old price into a new crossing.
      if (providerSourceTimestamp != null && previousSourceTimestamp != null && providerSourceTimestamp < previousSourceTimestamp) return;
      const reanchor = message.gap === true || message.resyncRequired === true || message.continuity === 'gap' || message.continuity === 'reanchor';
      const firstMark = reanchor || state.markObserved !== true || !(previous > 0 && Number.isFinite(previous));
      let layersChanged = false;
      const allocation = () => {
        const estimate = retainedAllocationBytes(message, {
          kind: 'price', instrumentId: message.instrumentId || markInstrumentId,
          markPrice: price, asOf: receivedAt,
        }, retainedMutationCandidate);
        if (!firstMark) {
          // logicalRetainedParts deliberately deduplicates shared references.
          // applyMarkPrice still creates replacement arrays and may shallow-copy
          // every crossed row, while crossing capture builds a separate bounded
          // event set for each slow SSE client. Reserve one non-aliased logical
          // copy for the new layer graph and one for the crossing accumulator /
          // frame per queued client (at least one local frame). The bounded
          // collector below enforces the 200-row frame limit.
          const layerCopyBytes = Object.values(state.layers || {}).reduce((sum, levels) => sum + logicalRetainedBytes(levels), 0);
          estimate.bytes += layerCopyBytes * (1 + Math.max(1, retainedQueues.size));
        }
        return estimate;
      };
      const admission = runRetainedAdmission(
        allocation,
        { kind: 'price', venue, instrumentId: message.instrumentId || markInstrumentId, sourceTimestamp: providerSourceTimestamp },
        () => {
          if (reanchor) resetMarkContinuity('price-source-gap');
          state.markInstrumentId = message.instrumentId || markInstrumentId;
          state.markPrice = price;
          state.asOf = receivedAt;
          recordProviderSource();
          if (providerSourceTimestamp != null) state.sourceTimestamps[venue] = providerSourceTimestamp;
          retainedMutation?.commit?.();
          if (firstMark) {
            state.markObserved = true;
            publishMark({ sourceTimestamp: message.sourceTimestamp, receivedAt, serverReceivedAt });
          } else {
            const crossingFrame: MarkCrossingAccumulator = { rows: [], nextIndex: 0, overflow: false };
            for (const [kind, levels] of Object.entries(state.layers || {})) {
              const nextLevels = applyMarkPrice(levels, previous, state.markPrice, receivedAt, state.markInstrumentId);
              // An already-provisional but active row can change without a new
              // crossing event. Compare owned row identities, not just the
              // bounded crossing list, before omitting a full replacement.
              layersChanged ||= nextLevels.some((level, index) => level !== levels[index]);
              recordCrossings(kind, levels, nextLevels, receivedAt, crossingFrame);
              state.layers[kind] = nextLevels;
            }
            const crossingRows = crossingFrame.overflow
              ? [...crossingFrame.rows.slice(crossingFrame.nextIndex), ...crossingFrame.rows.slice(0, crossingFrame.nextIndex)]
              : crossingFrame.rows;
            publishMark({ sourceTimestamp: message.sourceTimestamp, receivedAt, serverReceivedAt, crossings: crossingRows, crossingsOverflow: crossingFrame.overflow });
          }
          if (message.fixture === true) state.statuses[venue] = { ...(state.statuses[venue] || {}), state: 'fixture-live', lastSuccess: receivedAt, lastError: null, gaps: 0 };
          return true;
        },
        (reservation) => rejectRetainedMutation(venue, reservation, { sourceKey, previousSourceTimestamp }),
      );
      if (!admission.admitted) return retainedMutation ? false : undefined;
      if (firstMark) { publishState(); return; }
      if (layersChanged || message.fixture === true) publishState();
      else publishActivityMetadata(venue, serverReceivedAt);
      return retainedMutation ? true : undefined;
    }
    publishState();
    return retainedMutation ? true : undefined;
  };

  const beginProviderFlight = <T,>(flightMap: Map<string, Promise<T>>, flightKey: string, context: MutationContext, request: () => T | Promise<T>) => {
    const existing = flightMap.get(flightKey);
    if (existing) return { flight: existing };
    if (providerFlightCount() >= MAX_PROVIDER_REFRESH_FLIGHTS) {
      const reservation = { reason: 'provider-flight-capacity', bytes: 0, context };
      rejectRetainedMutation(String(context.venue ?? 'hypertracker'), reservation);
      return { error: { ok: false, statusCode: 503, error: 'provider refresh flight capacity is full', quota: quota.snapshot() } };
    }

    let resolveFlight!: (value: T | PromiseLike<T>) => void;
    let rejectFlight!: (error: unknown) => void;
    const flight = new Promise<T>((resolve, reject) => { resolveFlight = resolve; rejectFlight = reject; });
    const admission = admitRetainedMutation({ providerFlight: { key: flightKey, shell: 'x'.repeat(PROVIDER_FLIGHT_ENTRY_OVERHEAD_BYTES) } }, context, () => {
      flightMap.set(flightKey, flight);
      
      const releaseFlight = () => {
        if (flightMap.get(flightKey) !== flight) return;
        flightMap.delete(flightKey);
        
      };
      let requestResult;
      try { requestResult = request(); }
      catch (error) { requestResult = Promise.reject(error); }
      Promise.resolve(requestResult).then((value) => {
        releaseFlight();
        resolveFlight(value);
      }, (error) => {
        releaseFlight();
        rejectFlight(error);
      });
      return flight;
    });
    if (!admission.admitted) {
      const reason = admission.reservation?.reason ?? 'retained-admission';
      return { error: { ok: false, statusCode: 503, error: `provider refresh rejected: ${reason}`, quota: quota.snapshot() } };
    }
    return { flight };
  };

  const acquireProviderPayload = (key: string, context: MutationContext) => {
    const existing = providerRetainedPayloads.get(key);
    const entry = existing ?? { logicalBytes: 0, temporaryBytes: 0, consumers: 0, physical: null };
    const nextConsumers = entry.consumers + 1;
    if (nextConsumers > MAX_PROVIDER_REFRESH_FLIGHTS) throw new Error('provider retained consumer capacity is full');
    const admitted = admitRetainedMutation({ providerRetainedOwner: { key, consumers: nextConsumers, shell: 'x'.repeat(PROVIDER_FLIGHT_ENTRY_OVERHEAD_BYTES) } }, context, () => {
      entry.consumers = nextConsumers; providerRetainedPayloads.set(key, entry); 
    });
    if (!admitted.admitted) throw new Error('provider retained owner rejected by memory admission');
    let released = false;
    const report = (measurement: HyperTrackerRetentionMeasurement) => {
      if (released || providerRetainedPayloads.get(key) !== entry) throw new Error('provider retained owner has been released');
      if (!['parse', 'accumulate', 'complete', 'release'].includes(measurement.phase)
          || !Number.isSafeInteger(measurement.logicalBytes) || measurement.logicalBytes < 0
          || !Number.isSafeInteger(measurement.temporaryBytes) || measurement.temporaryBytes < 0) throw new Error('provider retention measurement is invalid');
      const logicalBytes = measurement.phase === 'release' ? 0 : measurement.logicalBytes;
      const temporaryBytes = measurement.phase === 'release' ? 0 : measurement.temporaryBytes;
      if (temporaryBytes === 0) { entry.physical?.release?.(); entry.physical = null; }
      else {
        const physical = entry.physical
          ? entry.physical.resize?.(temporaryBytes)
          : processMemory.reserveTransient(temporaryBytes, { ...context, kind: 'provider-response-parse' });
        if (!physical?.admitted) throw new Error('provider response rejected by physical memory admission: ' + String(physical?.reason ?? 'unavailable'));
        if (!entry.physical) entry.physical = physical;
      }
      const nextBytes = logicalBytes + temporaryBytes;
      const previousBytes = entry.logicalBytes + entry.temporaryBytes;
      if (!Number.isSafeInteger(nextBytes) || !Number.isSafeInteger(previousBytes)) throw new Error('provider retention total is invalid');
      const delta = Math.max(0, nextBytes - previousBytes);
      const commit = () => { entry.logicalBytes = logicalBytes; entry.temporaryBytes = temporaryBytes;  };
      if (delta === 0) { commit(); return; }
      const result = runRetainedAdmission(() => {
        const estimate = retainedAllocationBytes({ providerRetainedCandidateKey: key });
        return { ...estimate, bytes: estimate.bytes + delta };
      }, { ...context, kind: 'provider-response-retention', phase: measurement.phase }, commit);
      if (!result.admitted) throw new Error('provider response rejected by retained memory admission');
    };
    return {
      onRetention: report,
      retainRaw: (raw: unknown) => report({ phase: 'complete', logicalBytes: logicalRetainedBytes(raw), temporaryBytes: 0, page: 0, rows: 0 }),
      release: () => {
        if (released) return; released = true;
        if (providerRetainedPayloads.get(key) !== entry) return;
        entry.consumers -= 1;
        if (entry.consumers === 0) { entry.physical?.release?.(); entry.physical = null; providerRetainedPayloads.delete(key); }
        
      },
    };
  };
  const withProviderNormalization = <T,>(raw: unknown, context: MutationContext, operation: () => T): T => {
    const rawRecord = recordValue(raw);
    const rows = Array.isArray(raw) ? raw : ['orders', 'levels', 'heatmap', 'positions', 'rows', 'items'].map(key => rawRecord[key]).find(Array.isArray)
      ?? recordValue(rawRecord.data).orders ?? recordValue(rawRecord.data).levels;
    const rowCount = Array.isArray(rows) ? rows.length : 0;
    const logicalBytes = logicalRetainedBytes(raw);
    const derivedBytes = logicalBytes * 4 + rowCount * 512 + 64 * 1024;
    if (!Number.isSafeInteger(derivedBytes) || derivedBytes < 0) throw new Error('provider normalization allocation is invalid');
    const physical = processMemory.reserveTransient(derivedBytes, { ...context, kind: 'provider-normalization' });
    if (!physical.admitted) throw new Error('provider normalization rejected by physical memory admission: ' + String(physical.reason));
    try {
      const result = runRetainedAdmission(() => {
        const estimate = retainedAllocationBytes({ providerDerivedCandidate: context });
        return { ...estimate, bytes: estimate.bytes + derivedBytes };
      }, { ...context, kind: 'provider-normalization' }, operation);
      if (!result.admitted) throw new Error('provider normalization rejected by retained memory admission');
      return result.value as T;
    } finally { physical.release?.(); }
  };

  const discoverPublicProducts = async (venue: unknown, family: unknown): Promise<PublicCatalogReply> => {
    let selection;
    try { selection = validatePublicProductDiscoverySelection(venue, family); }
    catch (error) { return { ok: false, statusCode: 400, error: errorMessage(error) }; }
    const controls = publicMarketControls, generation = publicMarketControlGeneration;
    if (!controls || retainedBudgetClosed) return { ok: false, statusCode: 503, error: 'Public product discovery requires the live public-feed runtime' };
    const current = () => !retainedBudgetClosed && publicMarketControls === controls && publicMarketControlGeneration === generation;
    const key = `public-products:${selection.venue}:${selection.family}`;
    const context = { kind: 'public-product-discovery', venue: selection.venue, family: selection.family };
    const admitted = beginProviderFlight(publicCatalogFlights, key, context, async () => {
      let owner: ReturnType<typeof acquireProviderPayload> | null = null;
      let catalog: Awaited<ReturnType<PublicMarketControls['discover']>> | null = null;
      try {
        owner = acquireProviderPayload(key, context);
        catalog = await controls.discover(selection, measurement => {
          if (measurement.phase !== 'release' && !current()) throw new Error('Public catalog runtime changed during discovery');
          owner!.onRetention({ phase: measurement.phase === 'read' || measurement.phase === 'parse' ? 'parse' : measurement.phase,
            logicalBytes: measurement.logicalBytes, temporaryBytes: measurement.temporaryBytes, page: 0, rows: 0 });
        });
        if (!current()) return { ok: false, statusCode: 409, error: 'Public catalog runtime changed during discovery' };
        const products = catalog.products;
        if (!Array.isArray(products) || products.length > 8192) throw new Error('Public catalog exceeded its product limit');
        for (const product of products) publicMarketFeedOptions(product, {}, { context: 'discovery' });
        const bytes = logicalRetainedBytes(products) * 2 + (state.markets.length + products.length) * 256;
        const physical = processMemory.reserveTransient(bytes, { ...context, kind: 'public-products-state-merge' });
        if (!physical.admitted) throw new Error('Public catalog merge rejected by physical memory admission');
        let removedIds: string[] = [];
        try {
          const result = runRetainedAdmission(() => {
            const estimate = retainedAllocationBytes({ publicCatalogProducts: products });
            return { ...estimate, bytes: estimate.bytes + (state.markets.length + products.length) * 256 };
          }, context, () => {
            const newIds = new Set(products.map(product => String(product.instrumentId ?? product.id)));
            const activeIds = activeHeatmapInstrumentIds(state, retainedProviders.feeds);
            if (state.markInstrumentId) activeIds.add(String(state.markInstrumentId));
            const retained = state.markets.filter(product => {
              const id = String(product.instrumentId ?? product.id);
              const previousFamily = product.venue === selection.venue && product.discoveryFamily === selection.family;
              const removed = previousFamily && !newIds.has(id);
              if (removed) removedIds.push(id);
              if (removed) return false;
              // Keep the newly requested complete catalog and active native
              // identities. Idle previous catalogs are reloadable public data.
              return typeof product.discoveryFamily !== 'string' || activeIds.has(id) || newIds.has(id);
            });
            const markets = new Map(retained.map(product => [String(product.instrumentId ?? product.id), product]));
            for (const product of products) markets.set(String(product.instrumentId ?? product.id), product);
            if (markets.size > 8192) throw new Error('Combined public catalog exceeded its product limit');
            state.markets = [...markets.values()];
            return true;
          });
          if (!result.admitted) throw new Error('Public catalog merge rejected by retained memory admission');
        } finally { physical.release?.(); }
        if (removedIds.length) controls.retire?.(removedIds);
        publishState();
        return { ok: true, venue: selection.venue, family: selection.family, products: products.length,
          excludedInactive: catalog.excludedInactive, excludedUnsupported: catalog.excludedUnsupported, pages: catalog.pages, bytesRead: catalog.bytesRead, source: catalog.source };
      } catch (error) { return { ok: false, statusCode: current() ? 503 : 409, error: errorMessage(error) }; }
      finally { try { catalog?.releaseRetention(); } finally { owner?.release(); } }
    });
    return admitted.error ?? await admitted.flight;
  };
  const selectPublicMarket = async (instrumentId: unknown): Promise<PublicCatalogReply> => {
    if (typeof instrumentId !== 'string' || instrumentId.length > 128) return { ok: false, statusCode: 400, error: 'An exact bounded catalog instrumentId is required' };
    const controls = publicMarketControls, generation = publicMarketControlGeneration;
    if (!controls || retainedBudgetClosed) return { ok: false, statusCode: 503, error: 'Public market selection requires the live public-feed runtime' };
    if (publicMarketSelectionBusy) return { ok: false, statusCode: 409, error: 'A public market selection is already connecting' };
    const product = state.markets.find(candidate => (candidate.instrumentId ?? candidate.id) === instrumentId && typeof candidate.discoveryFamily === 'string');
    if (!product) return { ok: false, statusCode: 400, error: 'Selected instrument is not in a verified current public catalog' };
    try { publicMarketFeedOptions(product); }
    catch (error) { return { ok: false, statusCode: 400, error: errorMessage(error) }; }
    const admission = admitRetainedMutation({ publicMarketSelection: { instrumentId, family: product.discoveryFamily } },
      { kind: 'public-market-selection', venue: product.venue }, () => {
        publicMarketSelectionBusy = true;
        providerRef.generation += 1;
        state.markInstrumentId = `hyperliquid:${String(publicMarketFeedOptions(product).coin)}-PERP`;
        resetMarkContinuity('public-market-selection');
      });
    if (!admission.admitted) return { ok: false, statusCode: 503, error: 'Public market selection rejected by memory admission' };
    try {
      await controls.select(product);
      if (retainedBudgetClosed || publicMarketControls !== controls || publicMarketControlGeneration !== generation)
        return { ok: false, statusCode: 409, error: 'Public market runtime changed during selection' };
      return { ok: true, statusCode: 202, venue: product.venue, family: String(product.discoveryFamily), source: 'public-metadata' };
    } catch (error) { return { ok: false, statusCode: 503, error: errorMessage(error) }; }
    finally { publicMarketSelectionBusy = false; }
  };

  const orderbookCatalog = (): OrderbookVenueCatalog | PublicCatalogReply => {
    if (retainedBudgetClosed || !publicMarketControls?.orderbookCatalog) return { ok: false, statusCode: 503, error: 'Live orderbook venue controls are unavailable' };
    try { return readOrderbookVenueCatalog(publicMarketControls.orderbookCatalog()); }
    catch (error) { return { ok: false, statusCode: 503, error: errorMessage(error).slice(0, 180) }; }
  };
  const selectOrderbooks = async (instrumentId: unknown, venues: unknown): Promise<OrderbookVenueCatalog | PublicCatalogReply> => {
    const controls = publicMarketControls, generation = publicMarketControlGeneration;
    if (retainedBudgetClosed || !controls?.selectOrderbooks || !controls.orderbookCatalog) return { ok: false, statusCode: 503, error: 'Live orderbook venue controls are unavailable' };
    if (publicMarketSelectionBusy) return { ok: false, statusCode: 409, error: 'A venue or market selection is already connecting' };
    if (typeof instrumentId !== 'string' || instrumentId.length > 128) return { ok: false, statusCode: 400, error: 'A current instrumentId is required' };
    const product = state.markets.find(candidate => (candidate.instrumentId ?? candidate.id) === instrumentId);
    if (!product) return { ok: false, statusCode: 400, error: 'Selected instrument is not in the current market registry' };
    const markProduct = state.markets.find(candidate => (candidate.instrumentId ?? candidate.id) === state.markInstrumentId);
    const baseOf = (value: unknown) => typeof value === 'string' ? ['XBT', 'XXBT'].includes(value.toUpperCase()) ? 'BTC' : value.toUpperCase() : null;
    const currentBase = baseOf(markProduct?.base) ?? /^hyperliquid:([A-Z0-9]+)-PERP$/.exec(String(state.markInstrumentId))?.[1];
    if (!currentBase) return { ok: false, statusCode: 503, error: 'Waiting for current reference asset metadata' };
    if (baseOf(product.base) !== currentBase) return { ok: false, statusCode: 400, error: 'Use the market selector to change the reference asset' };
    let selected: string[];
    try { selected = validateOrderbookVenueChoice(readOrderbookVenueCatalog(controls.orderbookCatalog()), venues); }
    catch (error) { return { ok: false, statusCode: 400, error: errorMessage(error).slice(0, 180) }; }
    // The existing feed manager performs metadata/transport/native-book admission.
    // Charge the bounded control and complete selected metadata across its await.
    const payload = { publicOrderbookProduct: product, selected };
    const bytes = logicalRetainedBytes(payload) + 65_536;
    if (!Number.isSafeInteger(bytes) || bytes < 65_536) return { ok: false, statusCode: 503, error: 'Venue control memory measurement is incomplete' };
    const physical = processMemory.reserveTransient(bytes, { kind: 'public-orderbook-selection' });
    if (!physical.admitted) return { ok: false, statusCode: 503, error: 'Venue selection rejected by physical memory admission' };
    const admission = runRetainedAdmission(() => {
      const estimate = retainedAllocationBytes(payload); return { ...estimate, bytes: estimate.bytes + 65_536 };
    }, { kind: 'public-orderbook-selection' }, () => { publicMarketSelectionBusy = true; });
    if (!admission.admitted) { physical.release?.(); return { ok: false, statusCode: 503, error: 'Venue selection rejected by memory admission' }; }
    try {
      await controls.selectOrderbooks(product, selected);
      if (retainedBudgetClosed || publicMarketControls !== controls || publicMarketControlGeneration !== generation) return { ok: false, statusCode: 409, error: 'Live venue runtime changed during selection' };
      publishState(); return orderbookCatalog();
    } catch (error) { return { ok: false, statusCode: 503, error: errorMessage(error).slice(0, 180) }; }
    finally { publicMarketSelectionBusy = false; physical.release?.(); }
  };

  const selectedProviderCoin = () => /^hyperliquid:([A-Z0-9_-]+)-PERP$/.exec(String(state.markInstrumentId))?.[1] ?? process.env.HL_DEFAULT_COIN ?? 'BTC';
  const refreshProvider = (kind: string, { coin = selectedProviderCoin(), automatic = false }: { coin?: unknown; automatic?: boolean } = {}): ProviderRefreshResult | Promise<ProviderRefreshResult> => {
    const client = providerRef.current;
    const providerGeneration = providerRef.generation;
    const selectedInstrumentId = state.markInstrumentId;
    const selectedMarkSession = state.markSessionId;
    const currentProvider = () => providerRef.current === client && providerRef.generation === providerGeneration
      && state.markInstrumentId === selectedInstrumentId && state.markSessionId === selectedMarkSession;
    const supersededProvider = () => ({ ok: false, statusCode: 409, error: 'provider changed during refresh', quota: quota.snapshot() });
    if (!client) return { ok: false, statusCode: 503, error: 'HyperTracker is disabled' };
    const layer = ({ heatmap: 'liquidation', liquidation: 'liquidation', stopLoss: 'stopLoss', takeProfit: 'takeProfit' } as Record<string, 'liquidation' | 'stopLoss' | 'takeProfit'>)[kind];
    if (!layer) return { ok: false, statusCode: 400, error: `No visual layer mapping for provider request ${kind}` };
    let normalizedCoin;
    try { normalizedCoin = normalizeProviderCoin(coin); }
    catch (error) { return { ok: false, statusCode: 400, error: errorMessage(error) }; }
    // `heatmap` is retained only as an internal/server compatibility alias.
    // The adapter always receives the explicit verified destination kind.
    const orderPath = providerPaths.orders ?? (providerPaths.stopLoss && providerPaths.stopLoss === providerPaths.takeProfit ? providerPaths.stopLoss : null);
    const sharedOrderResource = ['stopLoss', 'takeProfit'].includes(layer) && orderPath;
    const requestKind = sharedOrderResource ? 'orders' : (kind === 'heatmap' ? layer : kind);
    const requestPath = sharedOrderResource ? orderPath : providerPaths[requestKind];
    const flightKey = `${providerGeneration}:${requestKind}:${normalizedCoin}:${String(requestPath ?? '')}`;
    if (Buffer.byteLength(flightKey, 'utf8') > MAX_PROVIDER_FLIGHT_KEY_BYTES) {
      return { ok: false, statusCode: 400, error: 'provider refresh key exceeds its bounded byte limit' };
    }
    const flightContext = { kind: 'providerRefreshFlight', venue: 'hypertracker', requestKind, coin: normalizedCoin, flightKey };
    const requestedInstrumentId = `hyperliquid:${normalizedCoin}-PERP`;
    const selectedRequest = requestedInstrumentId === selectedInstrumentId;
    const normalizeAndApply = (raw: unknown, receivedAt: number): ProviderRefreshResult => withProviderNormalization(raw, { ...flightContext, layer }, () => {
      const provenance = providerProvenance(raw);
      const sourceTimestamp = provenance.sourceTimestampKnown ? provenance.sourceTimestamp : null;
      const revision = provenance.revision ?? (provenance.sourceTimestampKnown ? String(provenance.sourceTimestamp) : undefined);
      const message = { ...normalizeHyperTrackerSnapshot(raw, {
        layer, coin: normalizedCoin, instrumentId: requestedInstrumentId,
        sourceTimestamp, receivedAt, revision: revision ?? 'unverified',
        referencePrice: state.markPrice, complete: providerCompleteness(raw, kind),
      }), provenanceKnown: provenance.known, sourceTimestampKnown: provenance.sourceTimestampKnown, revisionKnown: provenance.revisionKnown || provenance.sourceTimestampKnown, preserveProvisional: !provenance.sourceTimestampKnown, ...(client.mock === true ? { mock: true, source: 'hypertracker-mock', generatedAt: recordValue(raw).generatedAt, coverage: 'mock' } : {}) };
      if (!selectedRequest) return { ok: true, kind, instrumentId: requestedInstrumentId, applied: false, levels: message.levels.length, complete: message.complete, quota: quota.snapshot() };
      if (applyMessage(message, 'hypertracker') !== true) throw new Error('provider layer rejected by retained admission or provenance guard');
      state.statuses.hypertracker = { ...(state.statuses.hypertracker || {}), state: client.mock === true ? 'mock' : 'live', lastSuccess: message.receivedAt, lastError: null, source: client.mock === true ? 'hypertracker-mock' : 'hypertracker', mock: client.mock === true };
      publishState();
      return { ok: true, kind, levels: message.levels.length, complete: message.complete, quota: quota.snapshot() };
    });
    const failedProvider = (error: unknown, at: number): ProviderRefreshResult => {
      if (!currentProvider()) return supersededProvider();
      if (selectedRequest) {
        state.statuses.hypertracker = { ...(state.statuses.hypertracker || {}), state: 'unavailable', lastError: errorMessage(error), lastRequest: at };
        publishState();
      }
      return { ok: false, statusCode: 503, error: errorMessage(error), quota: quota.snapshot() };
    };
    if (sharedOrderResource) {
      const layerFlightKey = `${flightKey}:layer:${layer}`;
      if (Buffer.byteLength(layerFlightKey, 'utf8') > MAX_PROVIDER_FLIGHT_KEY_BYTES) return { ok: false, statusCode: 400, error: 'provider layer key exceeds its bounded byte limit' };
      const processingFlight = beginProviderFlight<ProviderRefreshResult>(providerFlights, layerFlightKey, { ...flightContext, layer, flightKey: layerFlightKey }, () => {
        let owner: ReturnType<typeof acquireProviderPayload> | null = null;
        try {
          owner = acquireProviderPayload(flightKey, flightContext);
          const payloadOwner = owner;
          const onRetention = (measurement: HyperTrackerRetentionMeasurement) => {
            if (measurement.phase !== 'release' && !currentProvider()) throw new Error('provider changed during refresh');
            payloadOwner.onRetention(measurement);
          };
          const admittedFlight = beginProviderFlight(providerResourceFlights, flightKey, flightContext, async () => {
            if (!currentProvider()) throw new Error('provider changed during refresh');
            const now = Date.now();
            if (selectedRequest) {
              state.statuses.hypertracker = { ...(state.statuses.hypertracker || {}), state: 'refreshing', lastRequest: now, lastError: null, mock: client.mock === true, source: client.mock === true ? 'hypertracker-mock' : 'hypertracker' };
              publishState();
            }
            try {
              const quotaState = quota.snapshot();
              const automaticUsed = quotaState.requests.filter(request => request.automatic === true).reduce((sum, request) => sum + Number(request.cost || 0), 0);
              const maxCost = automatic
                ? Math.max(0, Math.min(quotaState.remaining, Math.floor(quotaState.limit / 2) - automaticUsed))
                : quotaState.remaining;
              const raw = client.mock !== true && typeof client.requestOrdersSnapshot === 'function'
                ? await client.requestOrdersSnapshot({ coin: normalizedCoin, path: requestPath, automatic, maxCost, onRetention,
                    beforePage: () => { if (!currentProvider()) throw new Error('provider changed during refresh'); } })
                : await client.request('orders', { coin: normalizedCoin, path: requestPath, automatic, onRetention });
              if (!currentProvider()) throw new Error('provider changed during refresh');
              payloadOwner.retainRaw(raw);
              return { raw, receivedAt: Date.now() };
            } catch (error) { failedProvider(error, now); throw error; }
          });
          if (admittedFlight.error) { owner.release(); return admittedFlight.error; }
          return admittedFlight.flight.then(({ raw, receivedAt }) => {
            if (!currentProvider()) return supersededProvider();
            try { return normalizeAndApply(raw, receivedAt); }
            catch (error) { return failedProvider(error, receivedAt); }
          }, error => !currentProvider() ? supersededProvider() : ({ ok: false, statusCode: 503, error: errorMessage(error), quota: quota.snapshot() }))
            .finally(() => payloadOwner.release());
        } catch (error) { owner?.release(); return failedProvider(error, Date.now()); }
      });
      return processingFlight.error ?? processingFlight.flight;
    }
    const admittedFlight = beginProviderFlight(providerFlights, flightKey, flightContext, async () => {
      if (!currentProvider()) return supersededProvider();
      const now = Date.now();
      let owner: ReturnType<typeof acquireProviderPayload> | null = null;
      if (selectedRequest) {
        state.statuses.hypertracker = { ...(state.statuses.hypertracker || {}), state: 'refreshing', lastRequest: now, lastError: null, mock: client.mock === true, source: client.mock === true ? 'hypertracker-mock' : 'hypertracker' };
        publishState();
      }
      try {
        owner = acquireProviderPayload(flightKey, flightContext);
        const payloadOwner = owner;
        const raw = await client.request(requestKind, { coin: normalizedCoin, path: requestPath, automatic,
          onRetention: measurement => {
            if (measurement.phase !== 'release' && !currentProvider()) throw new Error('provider changed during refresh');
            payloadOwner.onRetention(measurement);
          } });
        if (!currentProvider()) return supersededProvider();
        payloadOwner.retainRaw(raw);
        return normalizeAndApply(raw, Date.now());
      } catch (error) { return failedProvider(error, now); }
      finally { owner?.release(); }
    });
    return admittedFlight.error ?? admittedFlight.flight;
  };

  const tick = () => {
    tickNumber += 1; const phase = tickNumber * .09;
    const next = 77_300 + Math.sin(phase) * 1_020 + Math.sin(phase * .37) * 80;
    const fixturePrice = Math.round(next * 10) / 10;
    const fixtureAt = Date.now();
    metrics.fixtureTicks += 1;
    metrics.lastTickAt = fixtureAt;
    // Opt-in stress workload only. It exercises the same normalized book
    // reducer and history path used by live feeds without changing defaults.
    for (let feed = 0; feed < metrics.fixtureFeedCount; feed += 1) {
      const instrumentId = metrics.fixtureBookInstrumentIds[feed] ?? `fixture-book:${feed}`;
      const fixtureBookKey = bookKey(instrumentId, 'native');
      const currentFixtureBook = () => state.booksByKey[fixtureBookKey]
        ?? (state.books[instrumentId]?.bookKey === fixtureBookKey ? state.books[instrumentId] : null);
      const recordFixtureBookEvent = (kind: string) => {
        if (kind === 'snapshot') metrics.fixtureBookSnapshots += 1;
        else metrics.fixtureBookDeltas += 1;
        const feedKey = String(feed);
        if (kind === 'delta') metrics.fixtureBookDeltaEventsByFeed[feedKey] = (metrics.fixtureBookDeltaEventsByFeed[feedKey] || 0) + 1;
        metrics.fixtureBookEventsByFeed[feedKey] = (metrics.fixtureBookEventsByFeed[feedKey] || 0) + 1;
        metrics.fixtureFeedEvents += 1;
        const observed = currentFixtureBook();
        metrics.fixtureBookLevelCountsByFeed[feedKey] = {
          bids: observed?.bids?.length ?? 0,
          asks: observed?.asks?.length ?? 0,
          total: (observed?.bids?.length ?? 0) + (observed?.asks?.length ?? 0),
        };
        metrics.fixtureBookSequencesByFeed[feedKey] = Number(observed?.sequence ?? 0);
        metrics.fixtureBookCompleteByFeed[feedKey] = observed?.complete === true;
        metrics.fixtureBookGapByFeed[feedKey] = observed?.gap === true;
      };
      let current = currentFixtureBook();
      if (!current || current.complete !== true || !Array.isArray(current.bids) || !Array.isArray(current.asks)
        || current.bids.length === 0 || current.asks.length === 0 || !Number.isSafeInteger(Number(current.sequence)) || Number(current.sequence) < 0) {
        const bids = Array.from({ length: metrics.fixtureBookLevels }, (_, index) => [
          Math.round((fixturePrice - 25 - feed * 2 - index * 5) * 100) / 100,
          1 + ((feed + index) % 7) / 10,
        ]);
        const asks = Array.from({ length: metrics.fixtureBookLevels }, (_, index) => [
          Math.round((fixturePrice + 25 + feed * 2 + index * 5) * 100) / 100,
          1 + ((feed + index + 1) % 7) / 10,
        ]);
        const admitted = applyMessage({
          kind: 'depthSnapshot', instrumentId, complete: true, sequence: 1,
          bids: bids.map(([price, amount]) => ({ price, amount })), asks: asks.map(([price, amount]) => ({ price, amount })),
          sourceTimestamp: fixtureAt, receivedAt: fixtureAt, resolution: 'native', units: 'base',
        }, `fixture-feed-${feed}`);
        if (admitted === true) recordFixtureBookEvent('snapshot');
        continue;
      }

      for (let burst = 0; burst < metrics.fixtureBookBurstCount; burst += 1) {
        current = currentFixtureBook();
        if (!current || current.complete !== true) break;
        const levelCount = Math.min(metrics.fixtureBookLevels, current.bids.length, current.asks.length);
        const previousSequence = Number(current.sequence);
        if (levelCount < 1 || !Number.isSafeInteger(previousSequence) || previousSequence < 0 || previousSequence >= Number.MAX_SAFE_INTEGER) break;
        const sequence = previousSequence + 1;
        const side = (tickNumber + feed + burst) % 2 === 0 ? 'bids' : 'asks';
        const index = (tickNumber + feed + burst) % levelCount;
        const [price, previousAmount] = current[side][index];
        const amount = Math.round((previousAmount + 0.1 + ((tickNumber + burst + feed) % 5) / 20) * 100) / 100;
        const admitted = applyMessage({
          kind: 'depthDelta', instrumentId, sequence, previousSequence,
          bids: side === 'bids' ? [{ price, amount }] : [], asks: side === 'asks' ? [{ price, amount }] : [],
          sourceTimestamp: fixtureAt, receivedAt: fixtureAt,
        }, `fixture-feed-${feed}`);
        if (admitted !== true) break;
        recordFixtureBookEvent('delta');
      }
    }
    applyMessage({ kind: 'price', instrumentId: state.markInstrumentId, price: fixturePrice, sourceTimestamp: fixtureAt, receivedAt: fixtureAt, fixture: true }, 'hyperliquid');
  };
  const startFixtureTicks = () => {
    if (timer === null && fixtureTickMs > 0) timer = setInterval(tick, fixtureTickMs);
    metrics.fixtureTicksRunning = timer !== null;
    return timer !== null;
  };
  const stopFixtureTicks = () => {
    if (timer !== null) clearInterval(timer);
    timer = null;
    metrics.fixtureTicksRunning = false;
    return true;
  };

  const selectProviderLayer = (kind: unknown): ProviderRefreshResult => {
    if (kind !== 'liquidation' && kind !== 'stopLoss' && kind !== 'takeProfit') return { ok: false, statusCode: 400, error: 'Unknown provider layer selection' };
    const result = admitRetainedMutation({ kind }, { kind: 'provider-layer-priority', venue: 'hypertracker' }, () => {
      providerPollingKind = kind;
      state.statuses.hypertracker = { ...(state.statuses.hypertracker || {}), priorityLayer: kind };
      publishState();
    });
    return result.admitted ? { ok: true, kind, quota: quota.snapshot() } : { ok: false, statusCode: 503, error: 'Provider selection rejected by memory admission' };
  };
  const startProviderPolling = (intervalMs = refreshIntervalMs, kind = 'liquidation', { initialDelayMs = 0 } = {}) => {
    if (!providerRef.current || !(intervalMs > 0) || providerTimer !== null || providerPollActive || providerPollInFlight) return false;
    const cadenceMs = Number(intervalMs);
    if (!Number.isSafeInteger(cadenceMs) || cadenceMs < 1 || cadenceMs > 2_147_483_647) return false;
    const selectedKind = ({ heatmap: 'liquidation', liquidation: 'liquidation', stopLoss: 'stopLoss', takeProfit: 'takeProfit' } as const)[kind as 'heatmap' | 'liquidation' | 'stopLoss' | 'takeProfit'];
    if (!selectedKind) return false;
    providerPollingKind = selectedKind;
    const mockPolling = providerRef.current.mock === true;
    const automaticCost = mockPolling ? 0 : (({ heatmap: 5, liquidation: 5, stopLoss: 5, takeProfit: 5 } as Record<string, number>)[kind] ?? 5);
    const automaticBudget = Math.floor(Number(quota.snapshot().limit) / 2);
    const generation = providerPollGeneration + 1;
    providerPollGeneration = generation;
    providerPollActive = true;
    const schedule = (delayMs: number) => {
      if (!providerPollActive || generation !== providerPollGeneration || !providerRef.current) return;
      const now = Date.now();
      const eligibility = mockPolling ? null : quota.eligibility(automaticCost, now, { automatic: true });
      if (eligibility && !eligibility.eligible && eligibility.nextEligibleAt === null) {
        providerPollActive = false;
        state.statuses.hypertracker = { ...(state.statuses.hypertracker || {}), state: 'quota-cap', lastError: eligibility.reason,
          nextRefreshAt: undefined, nextEligibleAt: null, eligibilityBasis: eligibility.basis };
        publishState(); return;
      }
      const requested = Math.max(0, Number(delayMs) || 0);
      const eligibleDelay = eligibility && !eligibility.eligible ? Math.max(0, (eligibility.nextEligibleAt ?? now) - now) : 0;
      const delay = Math.min(2_147_483_647, Math.max(requested, eligibleDelay));
      state.statuses.hypertracker = { ...(state.statuses.hypertracker || {}), nextRefreshAt: now + delay,
        ...(eligibility ? { nextEligibleAt: eligibility.nextEligibleAt, eligibilityBasis: eligibility.basis,
          ...(!eligibility.eligible ? { state: 'quota-cap', lastError: eligibility.reason } : {}) } : {}) };
      providerTimer = setTimeout(run, delay);
      publishState();
    };
    const run = async () => {
      providerTimer = null;
      if (!providerPollActive || generation !== providerPollGeneration || !providerRef.current) return;
      providerPollInFlight = true;
      try {
        const quotaState = quota.snapshot();
        const automaticUsed = quotaState.requests.filter((request) => request.automatic === true).reduce((sum, request) => sum + Number(request.cost || 0), 0);
        const eligibility = mockPolling ? null : quota.eligibility(automaticCost, Date.now(), { automatic: true });
        if (eligibility && !eligibility.eligible) {
          state.statuses.hypertracker = { ...(state.statuses.hypertracker || {}), state: 'quota-cap', lastError: eligibility.reason, automaticBudget, automaticUsed,
            nextEligibleAt: eligibility.nextEligibleAt, eligibilityBasis: eligibility.basis };
          publishState();
        } else {
          if (mockPolling) await Promise.all([providerPollingKind, ...['liquidation', 'stopLoss', 'takeProfit'].filter(layer => layer !== providerPollingKind)].map(layer => refreshProvider(layer, { automatic: true })));
          else await refreshProvider(providerPollingKind, { automatic: true });
        }
      } finally {
        providerPollInFlight = false;
        if (providerPollActive && generation === providerPollGeneration && providerRef.current) schedule(cadenceMs);
      }
    };
    state.statuses.hypertracker = { ...(state.statuses.hypertracker || {}), state: 'scheduled', automaticBudget, automaticCost, nextRefreshAt: Date.now() + Math.max(0, Number(initialDelayMs) || 0) };
    publishState();
    schedule(initialDelayMs);
    return true;
  };
  const stopProviderPolling = () => {
    if (providerTimer !== null) clearTimeout(providerTimer);
    providerTimer = null;
    providerPollActive = false;
    providerPollGeneration += 1;
    if (state.statuses.hypertracker) {
      state.statuses.hypertracker = { ...state.statuses.hypertracker, nextRefreshAt: undefined, nextEligibleAt: null };
      if (!retainedBudgetClosed) publishState();
    }
  };

  const admitRetainedMutation = <T,>(candidate: unknown, context: MutationContext = {}, mutation: () => T, onReject: ((reservation: MutationReservation) => void) | null = null): MutationResult<T> => {
    if (typeof mutation !== 'function') throw new TypeError('retained mutation requires a commit callback');
    const reject = typeof onReject === 'function'
      ? onReject
      : (reservation: MutationReservation) => rejectRetainedMutation(String(context?.venue ?? 'unknown'), reservation);
    return runRetainedAdmission(() => retainedAllocationBytes(candidate), context, mutation, reject);
  };

  const applyActiveBookSelection = (updates: [string, unknown][], affectedInstrumentIds: string[]) => {
    const ids = [...new Set(affectedInstrumentIds.map((value) => String(value ?? '').trim()).filter(Boolean))];
    activeBookSetManaged = true;
    const nextActiveBookKeys = { ...(state.activeBookKeys ?? {}) };
    for (const [instrumentId, keys] of updates) {
      const active = normalizeActiveBookKeys(keys);
      if (active.length) nextActiveBookKeys[instrumentId] = active;
      else delete nextActiveBookKeys[instrumentId];
    }

    const keysEqual = (left: unknown, right: unknown) => Array.isArray(left) && Array.isArray(right)
      ? left.length === right.length && left.every((key, index) => key === right[index])
      : left == null && right == null;
    const mapEqual = (left: Record<string, string[]>, right: Record<string, string[]>) => {
      const leftIds = Object.keys(left ?? {});
      const rightIds = Object.keys(right ?? {});
      return leftIds.length === rightIds.length && leftIds.every((id) => keysEqual(left[id], right[id]));
    };
    const currentActiveBookKeys = state.activeBookKeys ?? {};
    const addedKey = ids.some((id) => {
      const previous = Array.isArray(currentActiveBookKeys[id]) ? currentActiveBookKeys[id] : [];
      return (nextActiveBookKeys[id] ?? []).some((key) => !previous.includes(key));
    });
    const projectionState = { ...state, activeBookKeys: nextActiveBookKeys };
    const projectedBooks: Record<string, RuntimeBook> = {};
    let selectedBookChanged = false;
    for (const instrumentId of ids) {
      const active = nextActiveBookKeys[instrumentId] ?? [];
      const selected = active.length ? selectBookVariant(projectionState, instrumentId) : null;
      if (selected !== state.books?.[instrumentId]) {
        selectedBookChanged = true;
        if (selected) projectedBooks[instrumentId] = selected;
      }
    }
    const affected = new Set(ids);
    const removesVariant = Object.entries(state.booksByKey ?? {}).some(([key, book]) => {
      const instrumentId = String(book?.instrumentId ?? (String(key).includes('|') ? String(key).slice(0, String(key).lastIndexOf('|')) : key));
      return affected.has(instrumentId) && !(nextActiveBookKeys[instrumentId] ?? []).includes(key);
    });
    const changed = !mapEqual(currentActiveBookKeys, nextActiveBookKeys) || selectedBookChanged || removesVariant;
    if (!changed) return ids.length === 1 ? state.books?.[ids[0]] ?? null : state.activeBookKeys;

    const context = {
      kind: 'activeBookSelection',
      venue: 'server',
      instrumentId: ids.length === 1 ? ids[0] : '',
      instrumentCount: ids.length,
    };
    const commit = () => {
      state.activeBookKeys = nextActiveBookKeys;
      for (const instrumentId of ids) {
        reconcileActiveBookKeys(state, instrumentId, nextActiveBookKeys[instrumentId] ?? [], { normalized: true, updateSelection: false });
      }
      publishState();
      return ids.length === 1 ? state.books?.[ids[0]] ?? null : state.activeBookKeys;
    };
    return commit();
  };

  const setActiveBookKeys = (instrumentId: unknown, keys: unknown) => {
    const id = String(instrumentId ?? '').trim();
    if (!id) { activeBookSetManaged = true; return null; }
    const result = applyActiveBookSelection([[id, keys]], [id]);
    publishLiquidity();
    return result;
  };

  const setActiveBookSets = (activeBookSets: unknown = {}) => {
    const sets: Record<string, unknown> = activeBookSets && typeof activeBookSets === 'object' && !Array.isArray(activeBookSets) ? activeBookSets as Record<string, unknown> : {};
    const known = new Set([
      ...Object.keys(state.activeBookKeys ?? {}),
      ...Object.keys(state.books ?? {}),
      ...Object.entries(state.booksByKey ?? {}).map(([key, book]) => String(book?.instrumentId ?? (String(key).includes('|') ? String(key).slice(0, String(key).lastIndexOf('|')) : key))),
      ...Object.keys(sets),
    ]);
    const ids = [...known];
    const result = applyActiveBookSelection(ids.map((instrumentId) => [instrumentId, sets[instrumentId] ?? []]), ids);
    void result;
    publishLiquidity();
    return state.activeBookKeys;
  };

  const applyActiveBookSelectionStatus = (input: unknown) => {
    const status = recordValue(input);
    if (status?.id === 'active-book-set') {
      setActiveBookSets(status.activeBookSets ?? {});
      return true;
    }
    if (status?.id === 'hl-book-set') {
      setActiveBookKeys(status.instrumentId, status.activeBookKeys ?? []);
      return true;
    }
    return false;
  };
  const applyLiveFeedStatus = (input: unknown) => {
    const status = recordValue(input);
    const rawId = typeof status?.id === 'string' ? status.id : '';
    if (!rawId || rawId.length > LIVE_FEED_STATUS_ID_LIMIT) return false;
    const id = rawId.trim();
    const venue = venueForFeedId(id);
    const rawState = typeof status?.state === 'string' ? status.state : '';
    if (!id || !venue || !rawState || rawState.length > 32) return false;
    const stateName = rawState.trim();
    if (!stateName) return false;

    const previous = state.feedStatuses?.[id] ?? null;
    const previousVenueStatus = state.statuses?.[venue] ?? null;
    const lastSuccess = status.lastSuccess === undefined ? previous?.lastSuccess ?? null : liveFeedStatusTime(status.lastSuccess);
    const nextRetryAt = status.nextRetryAt === undefined ? previous?.nextRetryAt ?? null : liveFeedStatusTime(status.nextRetryAt);
    const attempt = status.attempt === undefined ? previous?.attempt ?? 0 : liveFeedStatusCounter(status.attempt) ?? 0;
    const lastError = status.lastError === undefined
      ? previous?.lastError ?? null
      : typeof status.lastError === 'string' ? status.lastError.slice(0, LIVE_FEED_STATUS_ERROR_LIMIT) : null;
    const nextFeedStatus = {
      state: stateName,
      lastError,
      ...(lastSuccess === null ? {} : { lastSuccess }),
      attempt,
      nextRetryAt,
      ...(typeof status.active === 'boolean' ? { active: status.active } : typeof previous?.active === 'boolean' ? { active: previous.active } : {}),
    };
    const priorSuccess = liveFeedStatusTime(previous?.lastSuccess);
    const freshnessDue = lastSuccess !== null && (priorSuccess === null || lastSuccess - priorSuccess >= LIVE_FEED_STATUS_FRESHNESS_INTERVAL_MS);
    const feedStatusUnchanged = previous
      && previous.state === nextFeedStatus.state
      && previous.lastError === nextFeedStatus.lastError
      && previous.attempt === nextFeedStatus.attempt
      && previous.nextRetryAt === nextFeedStatus.nextRetryAt
      && previous.active === nextFeedStatus.active;
    const venueStatusUnchanged = previousVenueStatus?.state === stateName
      && (previousVenueStatus.lastError ?? null) === lastError;
    if (feedStatusUnchanged && venueStatusUnchanged && !freshnessDue) return true;

    const nextFeedStatuses = { ...(state.feedStatuses ?? {}), [id]: nextFeedStatus };
    const nextStatuses = applyFeedStatus(state.statuses, id, {
      state: stateName,
      ...(lastSuccess === null ? {} : { lastSuccess }),
      lastError,
      gaps: Number.isSafeInteger(previousVenueStatus?.gaps) && Number(previousVenueStatus?.gaps) >= 0 ? previousVenueStatus.gaps : 0,
    });
    const resetMark = id === 'hl-activeAssetCtx'
      && LIVE_FEED_FAILURE_STATES.has(stateName)
      && !LIVE_FEED_FAILURE_STATES.has(previous?.state ?? '');
    const context = { kind: 'live-feed-status', venue, feedId: id };
    const commit = () => {
      state.feedStatuses = nextFeedStatuses;
      state.statuses = nextStatuses;
      if (resetMark) resetMarkContinuity(`active-asset-context-${stateName}`);
      publishState();
      return true;
    };
    const reject = (reservation: MutationReservation) => {
      metrics.retainedAdmissionRejected += 1;
      metrics.retainedAdmissionLast = {
        venue,
        kind: context.kind,
        feedId: id,
        reason: reservation?.reason ?? 'rejected',
        bytes: Number(reservation?.bytes) || 0,
        context: reservation?.context ?? context,
        at: Date.now(),
      };
      const nextRejectedFeedStatuses = { ...(state.feedStatuses ?? {}) };
      const hadFeedStatus = Object.prototype.hasOwnProperty.call(nextRejectedFeedStatuses, id);
      delete nextRejectedFeedStatuses[id];
      const nextRejectedStatuses = { ...(state.statuses ?? {}) };
      const hadVenueStatus = Object.prototype.hasOwnProperty.call(nextRejectedStatuses, venue);
      const currentVenueStatus = nextRejectedStatuses[venue];
      if (hadFeedStatus || hadVenueStatus) nextRejectedStatuses[venue] = { state: 'unavailable' };
      const beforeBytes = logicalRetainedBytes({ feedStatuses: state.feedStatuses ?? {}, statuses: state.statuses ?? {} });
      const afterBytes = logicalRetainedBytes({ feedStatuses: nextRejectedFeedStatuses, statuses: nextRejectedStatuses });
      const venueStatusChanges = hadVenueStatus && (
        currentVenueStatus?.state !== 'unavailable'
        || Object.keys(currentVenueStatus ?? {}).length !== 1
      );
      const canFailClosedWithRemoval = afterBytes <= beforeBytes && (hadFeedStatus || venueStatusChanges);
      const markResetAlreadyApplied = !previous
        && state.markObserved !== true
        && state.markContinuity?.reason === 'feed-status-admission-rejected';
      const resetRejectedMark = resetMark && !markResetAlreadyApplied;
      if (canFailClosedWithRemoval || resetRejectedMark) {
        runRetainedRemoval(context, () => {
          if (canFailClosedWithRemoval) {
            state.feedStatuses = nextRejectedFeedStatuses;
            state.statuses = nextRejectedStatuses;
          }
          if (resetRejectedMark) resetMarkContinuity('feed-status-admission-rejected');
          publishState();
          return false;
        });
      } else {
        
      }
      return false;
    };
    return admitRetainedMutation({ feedStatuses: nextFeedStatuses, statuses: nextStatuses }, context, commit, reject).admitted;
  };

  const server = http.createServer((req, res) => {
    if (!guardRequest(req, res)) return; // other websites cannot reach a localhost server through the browser (request-guard.mts)
    route(req, res, state, quota, clients, bus, history, {
      provider: providerRef.current, refreshProvider, selectProviderLayer, discoverPublicProducts, selectPublicMarket, orderbookCatalog, selectOrderbooks, publishState, metrics, retainedProviders, admitRetainedMutation, startFixtureTicks, stopFixtureTicks,
    }).catch((error) => json(res, { error: error.message }, 500));
  });
  return {
    server, state, quota, history, bus, host, metrics, retainedProviders, publishState, applyMessage, applyTradeBatch, refreshProvider, resetMarkContinuity,
    admitRetainedMutation,
    discoverPublicProducts, selectPublicMarket, orderbookCatalog, selectOrderbooks,
    setPublicMarketControls(controls: PublicMarketControls | null) { publicMarketControlGeneration += 1; publicMarketControls = controls; },
    setActiveBookKeys,
    setActiveBookSets,
    applyActiveBookSelectionStatus,
    applyLiveFeedStatus,
    setProvider(next: ProviderClient | null) {
      stopProviderPolling();
      providerRef.generation += 1;
      providerRef.current = next;
      state.statuses.hypertracker = { state: next?.mock === true ? 'mock' : next ? 'configured' : 'disabled', mock: next?.mock === true,
        source: next?.mock === true ? 'hypertracker-mock' : 'hypertracker', lastError: null };
      publishState();
    },
    selectProviderLayer, startProviderPolling, stopProviderPolling, startFixtureTicks, stopFixtureTicks,
    start(port = Number(process.env.PORT ?? 8787)) {
      return new Promise<AddressInfo>((resolve, reject) => {
        const onError = (error: Error) => { server.off('listening', onListening); reject(error); };
        const onListening = () => {
          server.off('error', onError);
          const address = server.address();
          if (!address || typeof address !== 'object' || !Number.isInteger(address.port) || address.port <= 0 || address.port > 65_535) { reject(new Error('TCP listener did not return a valid address')); return; }
          if (fixtureTickAutostart) startFixtureTicks();
          scheduleRetainedBudget();
          resolve(address);
        };
        server.once('error', onError); server.once('listening', onListening); server.listen(port, host);
      });
    },
    tick,
    close() {
      publicMarketControlGeneration += 1; publicMarketControls = null;
      retainedBudgetClosed = true;
      if (retainedBudgetTimer !== null) clearTimeout(retainedBudgetTimer);
      retainedBudgetTimer = null;
      if (timer) clearInterval(timer);
      stopProviderPolling();
      if (publishTimer !== null) clearTimeout(publishTimer);
      publishTimer = null;
      eventLoop.disable();
      for (const client of clients) client.end();
      clients.clear();
      history.close();
      return new Promise<void>((resolve) => { if (!server.listening) return resolve(); server.close(() => resolve()); });
    },
  };
}
