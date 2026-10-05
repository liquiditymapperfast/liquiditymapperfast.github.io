import type { LevelRecord, LayerSide } from '../domain/contracts.ts';
import { recordValue, arrayValue, type AdapterOptions, type WireRecord, type AdapterQuotaLedger } from './common.mts';
import { AdapterTransportError, requireSymbol, epochMs } from './common.mts';
import { DEFAULT_BOUNDED_JSON_RESPONSE_BYTES, DEFAULT_BOUNDED_JSON_RESPONSE_CHUNKS, DEFAULT_BOUNDED_JSON_RESPONSE_CHUNK_OVERHEAD_BYTES, DEFAULT_BOUNDED_JSON_TOKEN_MEMORY_BYTES, readBoundedJsonResponse, type BoundedJsonParseMeasurement } from '../core/bounded-json-response.mts';
import { logicalRetainedBytes } from '../core/retained-bytes.mts';

export const HYPERTRACKER_BASE_URL = 'https://ht-api.coinmarketman.com';
export const MAX_HYPERTRACKER_RESPONSE_BYTES = DEFAULT_BOUNDED_JSON_RESPONSE_BYTES;
export const MAX_HYPERTRACKER_RESPONSE_ROWS = 8_192;
export const MAX_HYPERTRACKER_ORDER_PAGES = 16;
export const MAX_HYPERTRACKER_CURSOR_BYTES = 1_024;
export const MAX_HYPERTRACKER_READ_STAGING_BYTES = MAX_HYPERTRACKER_RESPONSE_BYTES * 6 + DEFAULT_BOUNDED_JSON_RESPONSE_CHUNKS * DEFAULT_BOUNDED_JSON_RESPONSE_CHUNK_OVERHEAD_BYTES;
export type HyperTrackerRetentionPhase = 'parse' | 'accumulate' | 'complete' | 'release';
export interface HyperTrackerRetentionMeasurement {
  phase: HyperTrackerRetentionPhase;
  stage?: 'read' | 'parse';
  maxBytes?: number;
  maxChunks?: number;
  /** Cycle-safe logical bytes of the complete retained/candidate graph, not serialized wire bytes. */
  logicalBytes: number;
  /** Bounded response text, chunks and JSON token staging; zero outside parsing. */
  temporaryBytes: number;
  /** One-based request page; zero when validation fails before the first request. */
  page: number;
  rows: number;
  bodyBytes?: number;
  textLength?: number;
  textPartCount?: number;
  jsonTokens?: number;
  jsonDepth?: number;
}
/** Synchronous admission hook. Throw to reject growth; release must always remove its owner. */
export type HyperTrackerRetentionCallback = (measurement: Readonly<HyperTrackerRetentionMeasurement>) => void;
export interface HyperTrackerRequestOptions extends AdapterOptions { onRetention?: HyperTrackerRetentionCallback | null; }
export interface HyperTrackerOrderSnapshotOptions extends HyperTrackerRequestOptions {
  /** Explicit local spend ceiling for the complete operation; default permits one page. */
  maxCost?: number;
  maxRows?: number;
  maxBytes?: number;
  beforePage?: (() => void) | null;
}
function retentionCallback(value: HyperTrackerRetentionCallback | null | undefined): HyperTrackerRetentionCallback | null {
  if (value != null && typeof value !== 'function') throw new AdapterTransportError('HyperTracker onRetention must be a function');
  return value ?? null;
}
/** Bounded wire/chunk storage and decoded/joined UTF-16 copies, before any fetch. */
export function hyperTrackerReadStagingBytes(maxBytes = MAX_HYPERTRACKER_RESPONSE_BYTES): number {
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0 || maxBytes > MAX_HYPERTRACKER_RESPONSE_BYTES) throw new AdapterTransportError('HyperTracker read response-byte limit is outside its bounded limit');
  return maxBytes * 6 + DEFAULT_BOUNDED_JSON_RESPONSE_CHUNKS * DEFAULT_BOUNDED_JSON_RESPONSE_CHUNK_OVERHEAD_BYTES;
}
function readRetentionMeasurement(maxBytes: number, page: number, rows: number, logicalBytes: number): HyperTrackerRetentionMeasurement {
  return { phase: 'parse', stage: 'read', logicalBytes, temporaryBytes: hyperTrackerReadStagingBytes(maxBytes), page, rows, maxBytes, maxChunks: DEFAULT_BOUNDED_JSON_RESPONSE_CHUNKS };
}
function parseRetentionBytes(measurement: BoundedJsonParseMeasurement): number {
  // Account for wire/chunk storage, both decoded/joined UTF-16 text copies and
  // conservative per-token JSON materialization before JSON.parse runs.
  const bytes = measurement.bodyBytes * 2 + measurement.textLength * 4
    + measurement.textPartCount * DEFAULT_BOUNDED_JSON_RESPONSE_CHUNK_OVERHEAD_BYTES
    + measurement.jsonTokens * DEFAULT_BOUNDED_JSON_TOKEN_MEMORY_BYTES;
  if (!Number.isSafeInteger(bytes) || bytes < 0) throw new AdapterTransportError('HyperTracker parse retention measurement overflow');
  return bytes;
}
const COSTS: Readonly<Record<string, number>> = Object.freeze({ positionsHeatmap: 5, segments: 1, positionMetrics: 1, liquidation: 5, stopLoss: 5, takeProfit: 5, orders: 5 });

/** Build only documented/request-configured paths. Unknown layer paths stay disabled. */
export function buildHyperTrackerRequest(kind: string, { coin = 'BTC', segmentId, openedWithin = '24h', path }: AdapterOptions = {}) {
  const symbol = encodeURIComponent(requireSymbol(coin));
  let pathname;
  if (kind === 'positionsHeatmap') pathname = `/api/external/positions/heatmap?coin=${symbol}&openedWithin=${encodeURIComponent(openedWithin)}`;
  else if (kind === 'segments') pathname = '/api/external/segments';
  else if (kind === 'positionMetrics') { if (segmentId == null) throw new TypeError('segmentId is required'); pathname = `/api/external/position-metrics/coin/${symbol}/segment/${encodeURIComponent(String(segmentId))}`; }
  else if (['liquidation', 'stopLoss', 'takeProfit', 'orders'].includes(kind)) { if (!path) throw new AdapterTransportError(`No verified HyperTracker path configured for ${kind}`); pathname = String(path).startsWith('/') ? String(path) : `/${path}`; }
  else throw new RangeError(`Unsupported HyperTracker request: ${kind}`);
  return { kind, cost: COSTS[kind] ?? 1, pathname, method: 'GET', headers: { accept: 'application/json' } };
}
const ROW_KEYS = ['levels', 'heatmap', 'positions', 'orders', 'data', 'rows', 'items'];
const ORDER_TYPES = Object.freeze({
  stopLoss: new Set(['stop limit', 'stop market']),
  takeProfit: new Set(['take profit limit', 'take profit market']),
});
function rowsOf(payload: unknown): unknown[] { if (Array.isArray(payload)) return payload; for (const key of ROW_KEYS) if (Array.isArray(recordValue(payload)?.[key])) return arrayValue(recordValue(payload)[key]); if (Array.isArray(recordValue(recordValue(payload)?.data)?.levels)) return arrayValue(recordValue(recordValue(payload).data).levels); if (Array.isArray(recordValue(recordValue(payload)?.data)?.orders)) return arrayValue(recordValue(recordValue(payload).data).orders); return []; }
function hasRowsCollection(payload: unknown) { return Array.isArray(payload) || ROW_KEYS.some((key) => Array.isArray(recordValue(payload)?.[key])) || Array.isArray(recordValue(recordValue(payload)?.data)?.levels) || Array.isArray(recordValue(recordValue(payload)?.data)?.orders); }
function normalizeOrderType(value: unknown) { return String(value ?? '').trim().toLowerCase().replace(/[-_]+/g, ' ').replace(/\s+/g, ' '); }
function isOrderRow(row: unknown) { return row && typeof row === 'object' && (recordValue(row).oid != null || recordValue(row).orderId != null || recordValue(row).orderType != null || recordValue(row).triggerPx != null || recordValue(row).triggerPrice != null); }
function orderMatchesLayer(row: unknown, layer: unknown) { return layer === 'stopLoss' || layer === 'takeProfit' ? ORDER_TYPES[layer].has(normalizeOrderType(recordValue(row)?.orderType)) : undefined; }
function orderTriggerPrice(row: unknown) { return recordValue(row)?.triggerPx ?? recordValue(row)?.triggerPrice ?? recordValue(row)?.stopPrice ?? recordValue(row)?.takeProfitPrice; }
function orderDisplayPrice(row: unknown) {
  const type = normalizeOrderType(recordValue(row)?.orderType);
  if (ORDER_TYPES.stopLoss.has(type) || ORDER_TYPES.takeProfit.has(type)) return orderTriggerPrice(row);
  return recordValue(row)?.limitPx ?? recordValue(row)?.price ?? orderTriggerPrice(row);
}
function orderSize(row: unknown) { return recordValue(row)?.sz ?? recordValue(row)?.size ?? recordValue(row)?.quantity ?? recordValue(row)?.amount; }
function orderUnits(row: unknown, envelopeUnit: unknown) { return String(recordValue(row)?.sizeUnit ?? recordValue(row)?.quantityUnit ?? recordValue(row)?.unit ?? envelopeUnit ?? 'base').trim().toLowerCase(); }
function wireNumber(value: unknown): number {
  if (typeof value === 'number') return Number.isFinite(value) ? value : Number.NaN;
  if (typeof value !== 'string' || !/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(value.trim())) return Number.NaN;
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : Number.NaN;
}
function orderNotionalUsd(row: unknown, price: number, envelopeUnit: unknown, envelope: unknown = {}) {
  const direct = recordValue(row)?.notionalUsd ?? recordValue(row)?.notional ?? recordValue(row)?.usdValue;
  if (direct != null) return wireNumber(direct);
  const size = wireNumber(orderSize(row));
  if (!Number.isFinite(size) || size < 0) return Number.NaN;
  const units = orderUnits(row, envelopeUnit);
  if (['usd', 'usd notional', 'quote', 'notional', 'notional usd'].includes(units)) return size;
  if (['contract', 'contracts'].includes(units)) {
    const contractValue = wireNumber(recordValue(row)?.contractValue ?? recordValue(row)?.contractSize ?? recordValue(envelope)?.contractValue ?? recordValue(envelope)?.contractSize);
    return Number.isFinite(contractValue) && contractValue > 0 ? size * contractValue * price : Number.NaN;
  }
  if (!['base', 'coin', 'asset', ''].includes(units)) return Number.NaN;
  return size * price;
}
function timestampNumber(value: unknown) {
  if (typeof value === 'number') return Number.isFinite(value) && value > 0 ? value : null;
  if (typeof value !== 'string') return null;
  const text = value.trim();
  if (/^\d+(?:\.\d+)?$/.test(text)) {
    const numeric = Number(text);
    return Number.isFinite(numeric) && numeric > 0 ? numeric : null;
  }
  const iso = text.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(Z|[+-](\d{2}):(\d{2}))$/i);
  if (!iso) return null;
  const [, yearText, monthText, dayText, hourText, minuteText, secondText, , offsetHourText, offsetMinuteText] = iso;
  const year = Number(yearText); const month = Number(monthText); const day = Number(dayText);
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const daysInMonth = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (month < 1 || month > 12 || day < 1 || day > daysInMonth[month - 1]) return null;
  if (Number(hourText) > 23 || Number(minuteText) > 59 || Number(secondText) > 59) return null;
  if (offsetHourText != null && (Number(offsetHourText) > 23 || Number(offsetMinuteText) > 59)) return null;
  const parsed = Date.parse(text);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}
/** Order creation time is distinct from the time an open-order snapshot observed it. */
function orderSnapshotTimestamp(payload: unknown): number | null {
  const envelope = recordValue(payload), meta = recordValue(envelope.meta);
  const values = [envelope.snapshotTs, meta.snapshotTs];
  for (const row of rowsOf(payload)) values.push(recordValue(row).snapshotTs);
  const declared = values.filter((value) => value != null);
  if (!declared.length) return null;
  // If observation fields accompany snapshotTs they must name the same view.
  // A newer receipt/update time cannot silently override older captured rows.
  for (const value of [envelope.sourceTimestamp, envelope.asOf, envelope.updatedAt, envelope.timestamp, meta.sourceTimestamp, meta.updatedAt]) if (value != null) declared.push(value);
  const times = declared.map((value) => {
    const time = timestampNumber(value);
    if (time == null) throw new AdapterTransportError('HyperTracker snapshotTs timestamp is invalid');
    return epochMs(time);
  });
  if (times.some((time) => time !== times[0])) throw new AdapterTransportError('HyperTracker order response mixes snapshot timestamps');
  return times[0];
}
export function hyperTrackerSourceTimestamp(payload: unknown) {
  const observedSnapshot = orderSnapshotTimestamp(payload);
  if (observedSnapshot != null) return observedSnapshot;
  const candidates = [recordValue(payload)?.sourceTimestamp, recordValue(payload)?.asOf, recordValue(payload)?.updatedAt, recordValue(payload)?.timestamp, recordValue(recordValue(payload)?.meta)?.sourceTimestamp, recordValue(recordValue(payload)?.meta)?.updatedAt];
  const direct = candidates.map(timestampNumber).find((value) => value != null);
  if (direct != null) return direct;
  const rowTimes = arrayValue(rowsOf(payload)).flatMap((row: unknown) => [recordValue(row)?.sourceTimestamp, recordValue(row)?.asOf, recordValue(row)?.updatedAt, recordValue(row)?.timestamp]).map(timestampNumber).filter((value): value is number => value != null);
  return rowTimes.length ? Math.max(...rowTimes) : null;
}
function hyperTrackerRowTimestamp(row: unknown) {
  return [recordValue(row)?.snapshotTs, recordValue(row)?.sourceTimestamp, recordValue(row)?.asOf, recordValue(row)?.updatedAt, recordValue(row)?.timestamp].map(timestampNumber).find((value) => value != null) ?? null;
}
function paginationBoundary(payload: unknown): { cursorDeclared: boolean; nextCursor: string | null; hasMore: boolean; complete: boolean | null } {
  const envelope = recordValue(payload);
  const scopes = [envelope, recordValue(envelope.pagination), recordValue(envelope.meta)];
  const cursors = scopes.map((scope) => scope.nextCursor).filter((value) => value !== undefined);
  for (const cursor of cursors) {
    if (cursor !== null && (typeof cursor !== 'string' || !cursor.trim() || cursor !== cursor.trim() || /[\u0000-\u001f\u007f]/.test(cursor) || Buffer.byteLength(cursor, 'utf8') > MAX_HYPERTRACKER_CURSOR_BYTES)) {
      throw new AdapterTransportError('HyperTracker nextCursor is invalid or exceeds its bounded byte limit');
    }
  }
  const tokens = cursors.filter((value): value is string => typeof value === 'string');
  if (tokens.some((value) => value !== tokens[0]) || (tokens.length && cursors.some((value) => value === null))) throw new AdapterTransportError('HyperTracker response has contradictory pagination cursors');
  const hasMore = scopes.map((scope) => scope.hasMore).filter((value) => value !== undefined);
  const completeness = [...scopes, recordValue(envelope.coverage)].map((scope) => scope.complete).filter((value) => value !== undefined);
  if ([...hasMore, ...completeness].some((value) => typeof value !== 'boolean')) throw new AdapterTransportError('HyperTracker response has an invalid pagination declaration');
  return {
    cursorDeclared: cursors.length > 0, nextCursor: tokens[0] ?? null,
    hasMore: hasMore.includes(true), complete: completeness.includes(false) ? false : completeness.includes(true) || hasMore.includes(false) ? true : null,
  };
}
export function hyperTrackerCompleteness(payload: unknown, { kind = 'layer' }: AdapterOptions = {}) {
  const boundary = paginationBoundary(payload);
  // Any explicit indication of missing rows wins over a convenience success flag.
  if (boundary.nextCursor != null || boundary.hasMore || boundary.complete === false) return false;
  if (boundary.cursorDeclared || boundary.complete === true) return true;
  if (kind === 'heatmap') return false;
  throw new AdapterTransportError(`HyperTracker response for ${kind} did not declare pagination completeness`);
}
function explicitUnit(payload: unknown) { return recordValue(payload)?.units ?? recordValue(payload)?.unit ?? recordValue(payload)?.valueUnit ?? recordValue(recordValue(payload)?.meta)?.units ?? recordValue(recordValue(payload)?.meta)?.unit ?? recordValue(recordValue(payload)?.meta)?.valueUnit; }
function explicitTimestamp(value: unknown) { return timestampNumber(value); }
function validateFiniteTimestamp(value: unknown, label: string) { if (value == null) return; const numeric = explicitTimestamp(value); if (numeric == null || !Number.isFinite(numeric) || numeric <= 0) throw new AdapterTransportError(`HyperTracker ${label} timestamp is invalid`); }

/** Reject a malformed layer envelope before it can replace a good snapshot. */
export function validateHyperTrackerPayload(payload: unknown, { kind = 'layer' }: AdapterOptions = {}) {
  if (!hasRowsCollection(payload)) throw new AdapterTransportError(`HyperTracker ${kind} response has no level collection`);
  const unit = explicitUnit(payload);
  const hasOrderEnvelope = Array.isArray(recordValue(payload)?.orders) || Array.isArray(recordValue(recordValue(payload)?.data)?.orders);
  const allowsOrderSizeUnit = ['orders', 'stopLoss', 'takeProfit'].includes(kind) && (hasOrderEnvelope || arrayValue(rowsOf(payload)).some((row: unknown) => isOrderRow(row)));
  if (unit != null && !(/^(?:usd|usd\s+notional|notional\s*usd)$/i.test(String(unit).trim()) || (allowsOrderSizeUnit && /^(?:base|coin|asset|contract|contracts|quote|notional)$/i.test(String(unit).trim())))) throw new AdapterTransportError(`HyperTracker ${kind} response uses unsupported units: ${String(unit)}`);
  for (const [value, label] of [[recordValue(payload)?.sourceTimestamp, 'source'], [recordValue(payload)?.asOf, 'asOf'], [recordValue(payload)?.updatedAt, 'updatedAt'], [recordValue(payload)?.timestamp, 'snapshot'], [recordValue(recordValue(payload)?.meta)?.sourceTimestamp, 'meta.source'], [recordValue(recordValue(payload)?.meta)?.updatedAt, 'meta.updatedAt']] as const) validateFiniteTimestamp(value, label);
  const rows = rowsOf(payload);
  const envelopeCollections = ROW_KEYS.filter(key => Array.isArray(recordValue(payload)[key])).length
    + (Array.isArray(recordValue(recordValue(payload).data).levels) ? 1 : 0)
    + (Array.isArray(recordValue(recordValue(payload).data).orders) ? 1 : 0);
  if (envelopeCollections > 1) throw new AdapterTransportError('HyperTracker response has ambiguous row collections');
  if (rows.length > MAX_HYPERTRACKER_RESPONSE_ROWS) throw new AdapterTransportError(`HyperTracker ${kind} response exceeds ${MAX_HYPERTRACKER_RESPONSE_ROWS} rows`);
  if (arrayValue(rows).some((row: unknown) => !row || typeof row !== 'object' || Array.isArray(row))) throw new AdapterTransportError(`HyperTracker ${kind} response contains malformed level rows`);
  orderSnapshotTimestamp(payload);
  paginationBoundary(payload);
  const layerKind = kind;
  const envelopeUnit = explicitUnit(payload);
  for (const rawRow of rows) {
    const row = recordValue(rawRow);
    for (const [value, label] of [[row.sourceTimestamp, 'row.source'], [row.asOf, 'row.asOf'], [row.updatedAt, 'row.updatedAt'], [row.timestamp, 'row.timestamp'], [row.snapshotTs, 'row.snapshotTs']] as const) validateFiniteTimestamp(value, label);
    // An order snapshot can contain ordinary limit orders alongside SL/TP
    // rows. Those unrelated rows are ignored by the layer normalizer and must
    // not make an otherwise valid snapshot fail validation.
    if (isOrderRow(row) && ['stopLoss', 'takeProfit'].includes(layerKind) && !orderMatchesLayer(row, layerKind)) continue;
    const orderRow = isOrderRow(row) && ['orders', 'stopLoss', 'takeProfit'].includes(layerKind);
    const price = wireNumber(orderRow ? (layerKind === 'orders' ? orderDisplayPrice(row) : orderTriggerPrice(row)) : priceOf(row)); const value = wireNumber(orderRow ? orderNotionalUsd(row, price, envelopeUnit, payload) : valueOf(row)); const side = sideOf(row, layerKind);
    if (!(Number.isFinite(price) && price > 0) || !(Number.isFinite(value) && value >= 0) || !side) throw new AdapterTransportError(`HyperTracker ${kind} response contains an invalid level row`);
    for (const [candidate, label] of [[row.priceBinStart, 'priceBinStart'], [row.priceBinEnd, 'priceBinEnd'], [row.positionsCount, 'positionsCount'], [row.count, 'count']] as const) {
      if (candidate == null) continue;
      const numeric = wireNumber(candidate);
      if (!Number.isFinite(numeric) || numeric < 0 || (label.startsWith('priceBin') && numeric <= 0)) throw new AdapterTransportError(`HyperTracker ${kind} response has invalid ${label}`);
    }
    if (row.priceBinStart != null && row.priceBinEnd != null && Number(row.priceBinEnd) < Number(row.priceBinStart)) throw new AdapterTransportError(`HyperTracker ${kind} response has an inverted price bin`);
  }
  return { rows, empty: rows.length === 0, units: 'USD notional' };
}
function valueOf(row: unknown) { return recordValue(row).liquidationValue ?? recordValue(row).positionValue ?? recordValue(row).notionalUsd ?? recordValue(row).notional ?? recordValue(row).value ?? recordValue(row).usd; }
function priceOf(row: unknown) { return recordValue(row).price ?? recordValue(row).priceBinStart ?? recordValue(row).liquidationPrice ?? recordValue(row).stopPrice ?? recordValue(row).takeProfitPrice ?? recordValue(row).triggerPrice; }
function sideOf(row: unknown, layer: unknown): LayerSide | null {
  const raw = String(recordValue(row).side ?? recordValue(row).positionSide ?? recordValue(row).direction ?? '').trim().toLowerCase();
  if (layer === 'liquidation' || layer === 'positionsHeatmap') return raw === 'short' || raw === 'sell' ? 'short' : raw === 'long' || raw === 'buy' ? 'long' : null;
  return ['short', 'sell', 'a', 'ask'].includes(raw) ? 'sell' : ['long', 'buy', 'b', 'bid'].includes(raw) ? 'buy' : null;
}
function rowCoin(row: unknown, requestedCoin: unknown) { const value = recordValue(row).coin ?? recordValue(row).symbol ?? recordValue(row).asset ?? recordValue(row).base ?? recordValue(row).market ?? recordValue(row).instrument; if (value == null) return null; const text = requireSymbol(String(value).trim().toUpperCase().replaceAll('/', '_')); const coin = requireSymbol(requestedCoin); if (text === coin || text.startsWith(`${coin}-`) || text.startsWith(`${coin}_`) || text.includes(`:${coin}`) || text === `${coin}USDT` || text === `${coin}USD`) return coin; return text.split(/[-_:\/]/, 1)[0]; }
function providerIdentity(row: unknown, layer: unknown, coin: unknown, side: string, price: unknown, priceLow: unknown, priceHigh: unknown) {
  const providerId = recordValue(row).id ?? recordValue(row).oid ?? recordValue(row).positionId ?? recordValue(row).orderId ?? recordValue(row).uid ?? recordValue(row).uuid;
  if (providerId != null && String(providerId).trim()) return [layer, coin, side, String(providerId).trim()].join('-');
  return [layer, coin, side, price, Number.isFinite(priceLow) ? priceLow : 'single', Number.isFinite(priceHigh) ? priceHigh : 'single'].join('-');
}
/** Normalize provider rows without turning an unknown/missing row into zero. */
export function normalizeHyperTrackerSnapshot(payload: unknown, { layer = 'liquidation', sourceKind, instrumentId = 'hyperliquid:BTC-PERP', coin = 'BTC', sourceTimestamp, receivedAt = Date.now(), revision = 'unverified', referencePrice, complete = false, coverage = 'provider-sampled' }: AdapterOptions = {}) {
  const taggedSourceKind = recordValue(payload)?.sourceKind;
  if (taggedSourceKind != null && sourceKind != null && taggedSourceKind !== sourceKind) throw new AdapterTransportError(`HyperTracker payload source ${taggedSourceKind} does not match requested source ${sourceKind}`);
  const resolvedSourceKind = sourceKind ?? taggedSourceKind ?? layer;
  const sharedOrderSource = resolvedSourceKind === 'orders' && ['stopLoss', 'takeProfit'].includes(layer);
  if ((layer !== 'liquidation' && layer !== 'stopLoss' && layer !== 'takeProfit') || (resolvedSourceKind !== layer && !sharedOrderSource)) {
    throw new AdapterTransportError(`HyperTracker ${resolvedSourceKind} data cannot populate ${layer} levels`);
  }
  validateHyperTrackerPayload(payload, { kind: layer });
  const requestedCoin = requireSymbol(coin); const byId = new Map<string, LevelRecord & { amount: number; notionalUsd: number; priceLow?: number; priceHigh?: number }>(); const rawSourceTimestamp = sourceTimestamp ?? hyperTrackerSourceTimestamp(payload); const normalizedSourceTimestamp = rawSourceTimestamp != null && timestampNumber(rawSourceTimestamp) != null ? epochMs(timestampNumber(rawSourceTimestamp), receivedAt) : null;
  const envelopeUnit = explicitUnit(payload);
  const observedSnapshot = orderSnapshotTimestamp(payload);
  for (const rawRow of rowsOf(payload)) {
    const row = recordValue(rawRow);
    const orderRow = isOrderRow(row) && ['stopLoss', 'takeProfit'].includes(layer);
    if (orderRow && !orderMatchesLayer(row, layer)) continue;
    const sourceCoin = rowCoin(row, requestedCoin); if (sourceCoin && sourceCoin !== requestedCoin) continue;
    const price = Number(orderRow ? orderTriggerPrice(row) : priceOf(row)); const usd = Number(orderRow ? orderNotionalUsd(row, price, envelopeUnit, payload) : valueOf(row)); const side = sideOf(row, layer);
    if (!(price > 0) || !(usd >= 0) || !side) continue;
    const priceLow = row.priceBinStart == null ? undefined : Number(row.priceBinStart); const priceHigh = row.priceBinEnd == null ? undefined : Number(row.priceBinEnd);
    const identity = providerIdentity(row, layer, requestedCoin, side, price, priceLow, priceHigh);
    const amount = Number(orderRow ? orderSize(row) : (row.positionsCount ?? row.count ?? 0)); const prior = byId.get(identity);
    const rowSourceTimestamp = orderRow && observedSnapshot != null ? observedSnapshot : hyperTrackerRowTimestamp(row);
    const normalizedRowSourceTimestamp = rowSourceTimestamp == null ? normalizedSourceTimestamp : epochMs(rowSourceTimestamp, receivedAt);
    byId.set(identity, prior ? { ...prior, amount: prior.amount + (Number.isFinite(amount) ? amount : 0), notionalUsd: prior.notionalUsd + usd, count: (prior.count || 0) + (Number.isFinite(amount) ? amount : 0) } : { id: identity, layer, side, price, ...(Number.isFinite(priceLow) ? { priceLow } : {}), ...(Number.isFinite(priceHigh) ? { priceHigh } : {}), amount: Number.isFinite(amount) ? amount : 0, notionalUsd: usd, count: Number.isFinite(amount) && amount > 0 ? amount : undefined, active: true, ...(normalizedRowSourceTimestamp == null ? {} : { sourceTimestamp: normalizedRowSourceTimestamp }) });
  }
  const levels = [...byId.values()];
  return { kind: 'layerSnapshot' as const, layer, instrumentId, sourceTimestamp: normalizedSourceTimestamp, receivedAt, revision: String(revision), referencePrice: Number(referencePrice ?? 0), complete: Boolean(complete), coverage, units: 'USD notional', levels };
}

/** Backend-only transport. Nothing activates network access or discovers credentials. */
export class HyperTrackerClient {
  networkEnabled: boolean;
  fetchImpl: typeof globalThis.fetch | null;
  ledger: AdapterQuotaLedger | undefined;
  baseUrl: string;
  token: unknown;
  constructor({ token = process.env.HYPERTRACKER_API_KEY, baseUrl = process.env.HYPERTRACKER_BASE_URL || HYPERTRACKER_BASE_URL, ledger, fetchImpl = globalThis.fetch, networkEnabled = false }: AdapterOptions = {}) { this.token = token; this.baseUrl = String(baseUrl).replace(/\/$/, ''); this.ledger = ledger; this.fetchImpl = fetchImpl; this.networkEnabled = networkEnabled; }

  async #request(kind: string, params: AdapterOptions, maxBytes: number, onBeforeParse: ((measurement: BoundedJsonParseMeasurement) => void) | null = null, onBeforeRead: (() => void) | null = null): Promise<{ payload: WireRecord; bodyBytes: number }> {
    if (!this.networkEnabled || !this.token || typeof this.fetchImpl !== 'function' || !this.ledger) {
      throw new AdapterTransportError('HyperTracker is disabled; configure backend token, ledger, and networkEnabled=true');
    }
    const descriptor = buildHyperTrackerRequest(kind, params);
    // Reserve bounded response buffers before quota charging or transport.
    onBeforeRead?.();
    const ledgerMeta = { provider: 'hypertracker', ...(recordValue(params).automatic === true ? { automatic: true } : {}) };
    if (!this.ledger.spend(descriptor.cost, 'hypertracker:' + kind, Date.now(), ledgerMeta)) {
      const reason = this.ledger.lastSpendRejection;
      const message = reason === 'request-history-capacity' ? 'HyperTracker quota request history is full'
        : reason === 'retained-budget' ? 'HyperTracker request rejected by retained-memory admission'
        : reason === 'automatic-budget' ? 'HyperTracker automatic budget reserved for manual/retry work'
        : reason === 'clock-regression' ? 'HyperTracker quota clock moved backwards; usage retained'
        : 'HyperTracker daily token budget exhausted';
      throw new AdapterTransportError(message);
    }
    const response = await this.fetchImpl(this.baseUrl + descriptor.pathname, {
      method: descriptor.method,
      headers: { ...descriptor.headers, authorization: 'Bearer ' + this.token },
    });
    if (!response.ok) {
      try { await response.body?.cancel(); } catch { /* keep the original HTTP error */ }
      throw new AdapterTransportError('HyperTracker request failed with HTTP ' + response.status);
    }
    let payload: unknown, bodyBytes = 0, stagingRejected = false, stagingError: unknown;
    try {
      payload = await readBoundedJsonResponse(response, { maxBytes, label: 'HyperTracker', onBeforeParse: measurement => {
        bodyBytes = measurement.bodyBytes;
        try { onBeforeParse?.(measurement); }
        catch (error) { stagingRejected = true; stagingError = error; throw error; }
      } });
    } catch (error) {
      // Keep admission/generation classification instead of the reader's generic
      // BODY_READ_FAILED wrapper; it already canceled the reader on this path.
      if (stagingRejected) throw stagingError;
      throw new AdapterTransportError(error instanceof Error ? error.message : 'HyperTracker response body is invalid');
    }
    validateHyperTrackerPayload(payload, { kind });
    return { payload: Array.isArray(payload) ? { levels: payload, sourceKind: descriptor.kind } : { ...recordValue(payload), sourceKind: descriptor.kind }, bodyBytes };
  }

  /** Success transfers the complete raw graph to the hook owner; the caller releases it after consumption. */
  async request(kind: string, params: HyperTrackerRequestOptions = {}) {
    const onRetention = retentionCallback(params.onRetention);
    let transferred = false;
    try {
      const response = await this.#request(kind, params, MAX_HYPERTRACKER_RESPONSE_BYTES, measurement => {
        onRetention?.({ phase: 'parse', stage: 'parse', logicalBytes: 0, temporaryBytes: parseRetentionBytes(measurement), page: 1, rows: 0, ...measurement });
      }, () => { onRetention?.(readRetentionMeasurement(MAX_HYPERTRACKER_RESPONSE_BYTES, 1, 0, 0)); });
      onRetention?.({ phase: 'complete', logicalBytes: logicalRetainedBytes(response.payload), temporaryBytes: 0, page: 1, rows: rowsOf(response.payload).length });
      transferred = true;
      return response.payload;
    } finally {
      if (!transferred) onRetention?.({ phase: 'release', logicalBytes: 0, temporaryBytes: 0, page: 1, rows: 0 });
    }
  }

  /**
   * Explicit complete-order operation. All pages stay local until a coherent
   * terminal page validates; rejection never returns a partial replacement.
   * The per-operation ceiling and durable ledger both admit every page first.
   */
  async requestOrdersSnapshot({ coin = 'BTC', path, automatic = false, maxCost = COSTS.orders, maxPages = MAX_HYPERTRACKER_ORDER_PAGES, maxRows = MAX_HYPERTRACKER_RESPONSE_ROWS, maxBytes = MAX_HYPERTRACKER_RESPONSE_BYTES, beforePage = null, onRetention = null }: HyperTrackerOrderSnapshotOptions = {}): Promise<WireRecord> {
    onRetention = retentionCallback(onRetention);
    const rows: unknown[] = [], seenCursors = new Set<string>(), seenOrders = new Set<string>();
    let bodyBytes = 0, snapshotAt: number | null = null, first: WireRecord | null = null, cursor: string | null = null;
    let transferred = false, requestPage = 0;
    const retainedGraph = () => ({ rows, first, seenCursors, seenOrders });
    try {
      const boundedInteger = (value: number, maximum: number, label: string) => {
        if (!Number.isSafeInteger(value) || value <= 0 || value > maximum) throw new AdapterTransportError('HyperTracker ' + label + ' is outside its bounded limit');
        return value;
      };
      boundedInteger(maxPages, MAX_HYPERTRACKER_ORDER_PAGES, 'page limit');
      boundedInteger(maxRows, MAX_HYPERTRACKER_RESPONSE_ROWS, 'row limit');
      boundedInteger(maxBytes, MAX_HYPERTRACKER_RESPONSE_BYTES, 'response-byte limit');
      if (!Number.isSafeInteger(maxCost) || maxCost < COSTS.orders) throw new AdapterTransportError('HyperTracker complete-order budget cannot admit one page');
      if (beforePage != null && typeof beforePage !== 'function') throw new AdapterTransportError('HyperTracker beforePage must be a function');
      const symbol = requireSymbol(coin);
      const descriptor = buildHyperTrackerRequest('orders', { coin: symbol, path });
      const origin = new URL(this.baseUrl).origin;
      const requestUrl = new URL(descriptor.pathname, origin);
      if (requestUrl.origin !== origin || requestUrl.hash || requestUrl.searchParams.has('nextCursor')) throw new AdapterTransportError('HyperTracker complete-order path must start at the first page on its configured origin');
      requestUrl.searchParams.set('coin', symbol);
      for (let page = 0; page < maxPages; page += 1) {
        if ((page + 1) * COSTS.orders > maxCost) throw new AdapterTransportError('HyperTracker complete-order budget exhausted before pagination completed');
        if (bodyBytes >= maxBytes) throw new AdapterTransportError('HyperTracker complete-order response-byte limit reached before pagination completed');
        beforePage?.();
        requestPage = page + 1;
        if (cursor != null) requestUrl.searchParams.set('nextCursor', cursor);
        const response = await this.#request('orders', { coin: symbol, path: requestUrl.pathname + requestUrl.search, automatic }, maxBytes - bodyBytes, measurement => {
          // Reject a superseded operation before decoding another provider graph.
          beforePage?.();
          onRetention?.({ phase: 'parse', stage: 'parse', logicalBytes: logicalRetainedBytes(retainedGraph()), temporaryBytes: parseRetentionBytes(measurement), page: requestPage, rows: rows.length, ...measurement });
        }, () => { onRetention?.(readRetentionMeasurement(maxBytes - bodyBytes, requestPage, rows.length, logicalRetainedBytes(retainedGraph()))); });
        bodyBytes += response.bodyBytes;
        const envelope = response.payload;
        const pageRows = Array.isArray(envelope.orders) ? envelope.orders : recordValue(envelope.data).orders;
        if (pageRows !== rowsOf(envelope)) throw new AdapterTransportError('HyperTracker complete-order response has ambiguous row collections');
        if (!Array.isArray(pageRows)) throw new AdapterTransportError('HyperTracker complete-order response has no orders collection');
        if (rows.length + pageRows.length > maxRows) throw new AdapterTransportError('HyperTracker complete-order response exceeds its total row limit');
        const observedAt = orderSnapshotTimestamp(envelope);
        const sourceAt = observedAt ?? [envelope.sourceTimestamp, envelope.asOf, envelope.updatedAt, envelope.timestamp].map(timestampNumber).find(value => value != null) ?? null;
        const pinnedPath = requestUrl.pathname.match(/^\/api\/external\/orders\/5m-snapshots\/([^/]+)$/);
        const pinnedAt = pinnedPath && pinnedPath[1] !== 'latest' ? timestampNumber(decodeURIComponent(pinnedPath[1])) : null;
        // A terminal empty page has no row-level snapshotTs. Its documented
        // fixed-time request path still establishes which snapshot was queried.
        const pageSnapshotAt = sourceAt == null
          ? pageRows.length === 0 && pinnedAt != null ? epochMs(pinnedAt) : null
          : epochMs(sourceAt);
        if (pinnedAt != null && pageSnapshotAt !== epochMs(pinnedAt)) throw new AdapterTransportError('HyperTracker order snapshot does not match its pinned request timestamp');
        if (pageSnapshotAt != null && (!Number.isSafeInteger(pageSnapshotAt) || pageSnapshotAt <= 0 || pageSnapshotAt > 253_402_300_799_999)) throw new AdapterTransportError('HyperTracker order snapshot timestamp is outside its valid range');
        const envelopeSnapshot = [envelope.snapshotTs, recordValue(envelope.meta).snapshotTs, envelope.sourceTimestamp, envelope.asOf, envelope.updatedAt, envelope.timestamp].some(value => value != null);
        if (observedAt != null && !envelopeSnapshot && pageRows.some(row => recordValue(row).snapshotTs == null)) throw new AdapterTransportError('HyperTracker order rows omitted their snapshot timestamp');
        if (first && (String(explicitUnit(envelope) ?? 'base').trim().toLowerCase() !== String(explicitUnit(first) ?? 'base').trim().toLowerCase()
          || (envelope.contractValue ?? envelope.contractSize ?? null) !== (first.contractValue ?? first.contractSize ?? null))) {
          throw new AdapterTransportError('HyperTracker paginated orders changed their envelope units or contract value');
        }
        if (page > 0 && (snapshotAt == null || pageSnapshotAt !== snapshotAt)) throw new AdapterTransportError('HyperTracker paginated orders changed or omitted their snapshot timestamp');
        const incomingIdentities = new Set<string>();
        for (const row of pageRows) {
          const identityValue = recordValue(row).oid ?? recordValue(row).orderId ?? recordValue(row).id;
          if ((typeof identityValue !== 'string' && typeof identityValue !== 'number') || (typeof identityValue === 'number' && (!Number.isSafeInteger(identityValue) || identityValue < 0))) throw new AdapterTransportError('HyperTracker complete-order row has no safe provider identity');
          const identity = String(identityValue).trim();
          if (!identity || Buffer.byteLength(identity, 'utf8') > 256 || seenOrders.has(identity) || incomingIdentities.has(identity)) throw new AdapterTransportError('HyperTracker complete-order response contains an invalid or duplicate provider identity');
          const declaredCoin = recordValue(row).coin;
          if (typeof declaredCoin !== 'string' || declaredCoin.trim().toUpperCase() !== symbol) throw new AdapterTransportError('HyperTracker complete-order response does not match its coin filter');
          incomingIdentities.add(identity);
        }
        const boundary = paginationBoundary(envelope);
        const complete = hyperTrackerCompleteness(envelope, { kind: 'orders' });
        if (complete && pageSnapshotAt == null) throw new AdapterTransportError('HyperTracker complete orders did not declare a snapshot observation timestamp');
        if (!complete && (boundary.nextCursor == null || pageSnapshotAt == null)) throw new AdapterTransportError('HyperTracker incomplete orders have no usable cursor or snapshot timestamp');
        if (!complete && seenCursors.has(boundary.nextCursor!)) throw new AdapterTransportError('HyperTracker order pagination cursor repeated');
        if (!complete && requestUrl.pathname === '/api/external/orders/5m-snapshots/latest' && pageSnapshotAt! % 300_000 !== 0) throw new AdapterTransportError('HyperTracker order snapshot timestamp is not aligned to five minutes');
        // Stage the incoming envelope and future identity/cursor storage before
        // mutating the accumulator. Shared row/envelope references count once.
        onRetention?.({ phase: 'accumulate', logicalBytes: logicalRetainedBytes({ ...retainedGraph(), first: first ?? envelope, incoming: envelope, incomingIdentities, incomingCursor: complete ? null : boundary.nextCursor }), temporaryBytes: 0, page: requestPage, rows: rows.length + pageRows.length });
        if (page === 0) { first = envelope; snapshotAt = pageSnapshotAt; }
        for (const identity of incomingIdentities) seenOrders.add(identity);
        for (const row of pageRows) rows.push(row);
        if (complete) {
          if (!first) throw new AdapterTransportError('HyperTracker complete-order response is missing its first page');
          const result = { orders: rows, nextCursor: null, complete: true, sourceKind: 'orders', pages: page + 1, requestCost: (page + 1) * COSTS.orders, ...(snapshotAt == null ? {} : { sourceTimestamp: snapshotAt, snapshotTs: snapshotAt }), ...(explicitUnit(first) == null ? {} : { units: explicitUnit(first) }), ...(first.contractValue == null ? {} : { contractValue: first.contractValue }), ...(first.contractSize == null ? {} : { contractSize: first.contractSize }) };
          onRetention?.({ phase: 'complete', logicalBytes: logicalRetainedBytes(result), temporaryBytes: 0, page: requestPage, rows: rows.length });
          transferred = true;
          return result;
        }
        seenCursors.add(boundary.nextCursor!);
        cursor = boundary.nextCursor;
        // Drop the parsed-page staging allowance only after ownership commits.
        onRetention?.({ phase: 'accumulate', logicalBytes: logicalRetainedBytes(retainedGraph()), temporaryBytes: 0, page: requestPage, rows: rows.length });
        if (requestUrl.pathname === '/api/external/orders/5m-snapshots/latest') {
          requestUrl.pathname = '/api/external/orders/5m-snapshots/' + encodeURIComponent(new Date(snapshotAt!).toISOString());
        }
      }
      throw new AdapterTransportError('HyperTracker order pagination exceeded its bounded page limit');
    } finally {
      if (!transferred) onRetention?.({ phase: 'release', logicalBytes: 0, temporaryBytes: 0, page: requestPage, rows: 0 });
    }
  }
}
