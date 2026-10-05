import type { RuntimeMarket } from '../domain/runtime-state.mts';
import type { ExchangeRestRequest, ExchangeRestResponse } from './rest-transport.mts';
import type { ProcessMemoryReservation } from './process-memory.mts';
import {
  DEFAULT_BOUNDED_JSON_RESPONSE_CHUNKS, DEFAULT_BOUNDED_JSON_RESPONSE_CHUNK_OVERHEAD_BYTES,
  DEFAULT_BOUNDED_JSON_RESPONSE_DEPTH, DEFAULT_BOUNDED_JSON_RESPONSE_TOKENS,
  DEFAULT_BOUNDED_JSON_TOKEN_MEMORY_BYTES, readBoundedJsonResponse,
} from '../core/bounded-json-response.mts';
import { buildBinanceRequest, binanceInstrumentId } from '../adapters/binance.mts';
import { buildBybitRequest, bybitInstrumentId } from '../adapters/bybit.mts';
import { buildOkxRequest, okxInstrumentId } from '../adapters/okx.mts';
import { buildBitgetRequest, bitgetInstrumentId } from '../adapters/bitget.mts';
import { HYPERLIQUID_INFO_URL, hyperliquidCoin } from '../adapters/hyperliquid.mts';

export type PublicProductDiscoverySelection =
  | { venue: 'hyperliquid'; family: 'base-perpetual' }
  | { venue: 'binance'; family: 'spot' | 'usdm' | 'coinm' }
  | { venue: 'bybit'; family: 'spot' | 'linear' | 'inverse' }
  | { venue: 'okx'; family: 'spot' | 'swap' }
  | { venue: 'bitget'; family: 'spot' | 'usdt-futures' };
export type PublicProductDiscoveryFamily = PublicProductDiscoverySelection['family'];
export interface PublicProductPricePrecisionRule {
  maxSignificantFigures: 5; maxDecimals: number; integerPricesAllowed: true;
}
export interface PublicDiscoveredProduct extends RuntimeMarket {
  id: string; instrumentId: string; venue: PublicProductDiscoverySelection['venue']; exchange: string;
  discoveryFamily: PublicProductDiscoveryFamily; nativeSymbol: string; symbol: string;
  base: string; quote: string; baseNormalized: string; quoteNormalized: string;
  marketType: 'spot' | 'perpetual'; quantityUnit: 'base' | 'quote' | 'contract';
  tickSize: number | null; lotSize: number; qtyStep: number; status: string; isDelisted: false;
  inverse: boolean; contractType: string | null; contractValue: number | null;
  contractValueCurrency: string | null; settleCoin: string | null; metadataSource: string;
  pricePrecisionRule?: PublicProductPricePrecisionRule;
}
export interface PublicProductRetentionMeasurement {
  phase: 'read' | 'parse' | 'accumulate' | 'complete' | 'release'; ownerKey: string;
  logicalBytes: number; temporaryBytes: number;
  productBytes: number; rawBytes: number; candidateBytes: number; cursorBytes: number;
  page: number; rows: number; products: number;
}
/** A synchronous false/throw refuses admission before the next allocation or request. */
export type PublicProductRetentionCallback = (measurement: PublicProductRetentionMeasurement) => boolean | void;
export interface PublicProductDiscoveryLimits {
  maxBytesPerPage?: number; maxTotalBytes?: number; maxPages?: number; maxRows?: number;
  maxProducts?: number; maxCursorBytes?: number; bybitPageSize?: number; timeoutMs?: number;
}
export interface PublicProductDiscoveryRequestContext {
  selection: PublicProductDiscoverySelection; signal: AbortSignal; maxBytes: number; page: number;
}
/** Must return the raw readable public response; parsed payloads cannot prove wire-byte bounds. */
export type PublicProductDiscoveryRequest = (request: ExchangeRestRequest, context: PublicProductDiscoveryRequestContext)
  => ExchangeRestResponse | PromiseLike<ExchangeRestResponse>;
export type PublicProductDiscoveryOptions = PublicProductDiscoverySelection & {
  request: PublicProductDiscoveryRequest; limits?: PublicProductDiscoveryLimits; signal?: AbortSignal;
  onRetention?: PublicProductRetentionCallback;
  reserveTransientMemory?: (bytes: number, context: Record<string, unknown>) => ProcessMemoryReservation;
  now?: () => number;
};
export interface PublicProductDiscoveryResult {
  selection: PublicProductDiscoverySelection; venue: PublicProductDiscoverySelection['venue']; family: PublicProductDiscoveryFamily;
  products: PublicDiscoveredProduct[]; pages: number; rowsSeen: number; bytesRead: number;
  excludedInactive: number; excludedUnsupported: number; complete: true; nextCursor: null;
  source: 'public-metadata'; sourceUrl: string; documentationUrl: string; receivedAt: number;
  memoryAdmission: 'retention-callback' | 'transient-reservation' | 'unavailable';
  /** Caller releases only after state admission or after refusing the returned graph. */
  releaseRetention(): void;
}
export class PublicProductDiscoveryError extends Error {
  constructor(message: string, readonly code: string) { super(message); this.name = 'PublicProductDiscoveryError'; }
}
const MAX_BODY_BYTES = 16_777_216; // Existing Exchange REST catalog cap; never increased here.
const MAX_PAGES = 32;
const MAX_ROWS = 10_000;
const MAX_CURSOR_BYTES = 1_024;
const REQUEST_TIMEOUT_MS = 12_000;
const OWNER_SHELL_ALLOWANCE_BYTES = 2_048;
const KEY_SHELL_ALLOWANCE_BYTES = 128;
const encoder = new TextEncoder();
const DOCUMENTATION: Record<PublicProductDiscoverySelection['venue'], string> = {
  hyperliquid: 'https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/info-endpoint/perpetuals',
  binance: 'https://developers.binance.com/docs/binance-spot-api-docs/rest-api/general-endpoints',
  bybit: 'https://bybit-exchange.github.io/docs/v5/market/instrument',
  okx: 'https://app.okx.com/docs-v5/en/',
  bitget: 'https://www.bitget.com/docs/catalog/market-market-data/market-instruments',
};
export function validatePublicProductDiscoverySelection(venue: unknown, family: unknown): PublicProductDiscoverySelection {
  if (venue === 'hyperliquid' && family === 'base-perpetual') return { venue, family };
  if (venue === 'binance' && (family === 'spot' || family === 'usdm' || family === 'coinm')) return { venue, family };
  if (venue === 'bybit' && (family === 'spot' || family === 'linear' || family === 'inverse')) return { venue, family };
  if (venue === 'okx' && (family === 'spot' || family === 'swap')) return { venue, family };
  if (venue === 'bitget' && (family === 'spot' || family === 'usdt-futures')) return { venue, family };
  throw new PublicProductDiscoveryError('Unsupported public product discovery venue/family', 'UNSUPPORTED_FAMILY');
}
function fail(message: string, code = 'INVALID_METADATA'): never { throw new PublicProductDiscoveryError(message, code); }
function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(label + ' must be an object');
  return value as Record<string, unknown>;
}
function list(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) fail(label + ' must be an array');
  return value;
}
function text(value: unknown, label: string, pattern: RegExp = /^[A-Z0-9][A-Z0-9._-]*$/, maximum = 64): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > maximum || !pattern.test(value)) fail(label + ' missing or invalid');
  return value;
}
function positive(value: unknown, label: string): number {
  if ((typeof value !== 'number' && typeof value !== 'string')
    || (typeof value === 'string' && (value.length > 64 || !/^(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(value)))) fail(label + ' missing or invalid');
  const number = Number(value);
  if (!(Number.isFinite(number) && number > 0 && number <= Number.MAX_SAFE_INTEGER)) fail(label + ' must be positive and finite');
  return number;
}
function precision(value: unknown, label: string, maximum = 18): number {
  if ((typeof value !== 'number' && typeof value !== 'string') || !/^\d{1,2}$/.test(String(value))) fail(label + ' missing or invalid');
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 0 || number > maximum) fail(label + ' out of bounds');
  return number;
}
function boundedInteger(value: unknown, fallback: number, maximum: number, label: string): number {
  if (value === undefined) return fallback;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0 || value > maximum) fail(label + ' must be a positive bounded integer', 'INVALID_LIMIT');
  return value;
}
function safeSum(...values: number[]): number {
  const sum = values.reduce((total, value) => total + value, 0);
  if (!values.every(value => Number.isSafeInteger(value) && value >= 0) || !Number.isSafeInteger(sum)) fail('Retention measurement overflow', 'INVALID_RETENTION');
  return sum;
}
function byteLength(value: string): number { return encoder.encode(value).byteLength; }
function active(row: Record<string, unknown>, field: string, expected: string): boolean {
  if (row.isDelisted !== undefined && typeof row.isDelisted !== 'boolean') fail('Invalid delisted marker');
  if (row.isDelisted === true) return false;
  if (typeof row[field] !== 'string' || row[field] === '' || String(row[field]).length > 64) fail('Instrument status missing or invalid');
  return row[field] === expected;
}
function finish(selection: PublicProductDiscoverySelection, nativeSymbol: string, base: string, quote: string, metadata: {
  instrumentId: string; quantityUnit: PublicDiscoveredProduct['quantityUnit']; tickSize: number | null; qtyStep: number;
  status: string; inverse?: boolean; contractType?: string | null; contractValue?: number | null;
  contractValueCurrency?: string | null; settleCoin?: string | null; [key: string]: unknown;
}): PublicDiscoveredProduct {
  const { instrumentId, ...fields } = metadata;
  return { ...fields, id: instrumentId, instrumentId, venue: selection.venue, exchange: selection.venue,
    discoveryFamily: selection.family, nativeSymbol, symbol: nativeSymbol, base, quote, baseNormalized: base.toUpperCase(), quoteNormalized: quote,
    marketType: selection.family === 'spot' ? 'spot' : 'perpetual', quantityUnit: metadata.quantityUnit,
    tickSize: metadata.tickSize, lotSize: metadata.qtyStep, qtyStep: metadata.qtyStep, status: metadata.status, isDelisted: false,
    inverse: metadata.inverse ?? false, contractType: metadata.contractType ?? null, contractValue: metadata.contractValue ?? null,
    contractValueCurrency: metadata.contractValueCurrency ?? null, settleCoin: metadata.settleCoin ?? null,
    metadataSource: selection.venue + '-public-instruments' };
}
type RowResult = { excluded: 'inactive' | 'unsupported' } | { product: PublicDiscoveredProduct };
function parseRow(selection: PublicProductDiscoverySelection, value: unknown, receivedAt: number): RowResult {
  const row = object(value, 'Instrument row');
  if (selection.venue === 'hyperliquid') {
    const native = text(row.name, 'Hyperliquid coin', /^[A-Za-z0-9][A-Za-z0-9._:-]*$/);
    if (native.includes(':')) return { excluded: 'unsupported' };
    if (row.isDelisted !== undefined && typeof row.isDelisted !== 'boolean') fail('Hyperliquid isDelisted must be boolean');
    if (row.isDelisted === true) return { excluded: 'inactive' };
    const decimals = precision(row.szDecimals, 'Hyperliquid szDecimals', 6);
    const rule: PublicProductPricePrecisionRule = { maxSignificantFigures: 5, maxDecimals: 6 - decimals, integerPricesAllowed: true };
    return { product: finish(selection, native, native, 'USD', { instrumentId: 'hyperliquid:' + hyperliquidCoin(native) + '-PERP',
      quantityUnit: 'base', tickSize: null, qtyStep: Number('1e-' + decimals), status: 'active', szDecimals: decimals, pricePrecisionRule: rule }) };
  }
  if (selection.venue === 'binance') {
    if (typeof row.symbol === 'string' && row.symbol.length > 0 && row.symbol.length <= 64 && /[^\x00-\x7f]/.test(row.symbol)) return { excluded: 'unsupported' };
    if (selection.family !== 'spot' && row.contractType !== 'PERPETUAL') return { excluded: 'unsupported' };
    if (!active(row, row.status === undefined && selection.family === 'coinm' ? 'contractStatus' : 'status', 'TRADING')
      || (selection.family === 'spot' && row.isSpotTradingAllowed === false)) return { excluded: 'inactive' };
    const native = text(row.symbol, 'Binance symbol'), base = text(row.baseAsset, 'Binance baseAsset'), quote = text(row.quoteAsset, 'Binance quoteAsset');
    const filters = list(row.filters, 'Binance filters').map(value => object(value, 'Binance filter'));
    const prices = filters.filter(filter => filter.filterType === 'PRICE_FILTER');
    const lots = filters.filter(filter => filter.filterType === 'LOT_SIZE');
    if (prices.length !== 1 || lots.length !== 1) fail('Binance price/lot filter missing or duplicated');
    const tick = positive(prices[0].tickSize, 'Binance tickSize'), qty = positive(lots[0].stepSize, 'Binance stepSize');
    if (selection.family === 'coinm') {
      const pair = text(row.pair, 'Binance COIN-M pair'), settle = text(row.marginAsset, 'Binance COIN-M marginAsset');
      if (quote !== 'USD' || settle !== base || pair !== base + quote || native !== pair + '_PERP') fail('Binance COIN-M native identity/settlement mismatch');
      return { product: finish(selection, native, base, quote, { instrumentId: binanceInstrumentId(native, 'perpetual', 'coinm'),
        family: 'coinm', pair, exchangeContractType: 'PERPETUAL', quantityUnit: 'contract', inverse: true, contractType: 'inverse',
        contractValue: positive(row.contractSize, 'Binance COIN-M contractSize'), contractValueCurrency: quote, settleCoin: settle,
        tickSize: tick, qtyStep: qty, status: 'TRADING' }) };
    }
    if (native !== base + quote) fail('Binance native currency identity mismatch');
    const settle = selection.family === 'spot' ? null : text(row.marginAsset, 'Binance USD-M marginAsset');
    if (selection.family === 'usdm' && !['USDT', 'USDC'].includes(quote)) return { excluded: 'unsupported' };
    if (selection.family === 'usdm' && settle !== quote) fail('Binance USD-M settlement mismatch');
    return { product: finish(selection, native, base, quote, { instrumentId: binanceInstrumentId(native, selection.family === 'spot' ? 'spot' : 'perpetual', 'usdm'),
      ...(selection.family === 'usdm' ? { family: 'usdm', exchangeContractType: 'PERPETUAL', contractType: 'linear' } : {}),
      quantityUnit: 'base', settleCoin: settle, tickSize: tick, qtyStep: qty, status: 'TRADING' }) };
  }
  if (selection.venue === 'bybit') {
    const expectedContract = selection.family === 'linear' ? 'LinearPerpetual' : selection.family === 'inverse' ? 'InversePerpetual' : null;
    if (row.category != null && row.category !== selection.family) return { excluded: 'unsupported' };
    if (selection.family !== 'spot' && row.contractType !== expectedContract) return { excluded: 'unsupported' };
    if (selection.family === 'spot' && row.contractType != null && row.contractType !== '') return { excluded: 'unsupported' };
    if (!active(row, 'status', 'Trading')) return { excluded: 'inactive' };
    const native = text(row.symbol, 'Bybit symbol'), base = text(row.baseCoin, 'Bybit baseCoin'), quote = text(row.quoteCoin, 'Bybit quoteCoin');
    const settle = selection.family === 'spot' ? null : text(row.settleCoin, 'Bybit settleCoin');
    const nativeMatches = native === base + quote || selection.family === 'linear' && quote === 'USDC' && native === base + 'PERP';
    if (!nativeMatches || (selection.family === 'linear' && (settle !== quote || !['USDT', 'USDC'].includes(quote)))
      || (selection.family === 'inverse' && (quote !== 'USD' || settle !== base))
      || (selection.family === 'spot' && row.settleCoin != null && row.settleCoin !== '')) fail('Bybit native identity/category settlement mismatch');
    const price = object(row.priceFilter, 'Bybit priceFilter'), lot = object(row.lotSizeFilter, 'Bybit lotSizeFilter');
    return { product: finish(selection, native, base, quote, { instrumentId: bybitInstrumentId(native, selection.family), category: selection.family,
      quantityUnit: selection.family === 'inverse' ? 'quote' : 'base', inverse: selection.family === 'inverse', contractType: expectedContract,
      settleCoin: settle, tickSize: positive(price.tickSize, 'Bybit tickSize'),
      qtyStep: positive(selection.family === 'spot' ? lot.basePrecision : lot.qtyStep, 'Bybit quantity increment'), status: 'Trading' }) };
  }
  if (selection.venue === 'okx') {
    const expected = selection.family === 'spot' ? 'SPOT' : 'SWAP';
    if (row.instType !== expected || (selection.family === 'swap' && row.ctType !== 'linear' && row.ctType !== 'inverse')) return { excluded: 'unsupported' };
    if (!active(row, 'state', 'live')) return { excluded: 'inactive' };
    if (row.expTime != null && row.expTime !== '') {
      const expiry = positive(row.expTime, 'OKX expTime');
      if (!Number.isSafeInteger(expiry)) fail('OKX expTime must be safe milliseconds');
      if (expiry <= receivedAt) return { excluded: 'inactive' };
    }
    const native = text(row.instId, 'OKX instId'), parts = native.split('-');
    if (parts.length !== (selection.family === 'spot' ? 2 : 3) || (selection.family === 'swap' && parts[2] !== 'SWAP')) fail('OKX native instrument family mismatch');
    const base = text(parts[0], 'OKX base'), quote = text(parts[1], 'OKX quote');
    if ((row.baseCcy != null && row.baseCcy !== '' && row.baseCcy !== base) || (row.quoteCcy != null && row.quoteCcy !== '' && row.quoteCcy !== quote)) fail('OKX explicit native currency identity mismatch');
    if (selection.family === 'spot' && (row.baseCcy !== base || row.quoteCcy !== quote)) fail('OKX spot currency metadata missing');
    const tick = positive(row.tickSz, 'OKX tickSz'), qty = positive(row.lotSz, 'OKX lotSz');
    if (selection.family === 'spot') return { product: finish(selection, native, base, quote, { instrumentId: okxInstrumentId(native), instType: 'SPOT',
      quantityUnit: 'base', tickSize: tick, qtyStep: qty, status: 'live' }) };
    if (row.ctType !== 'linear' && row.ctType !== 'inverse') return { excluded: 'unsupported' };
    if ((row.uly != null && row.uly !== '' && row.uly !== base + '-' + quote)
      || (row.instFamily != null && row.instFamily !== '' && row.instFamily !== base + '-' + quote)) fail('OKX SWAP underlying identity mismatch');
    const inverse = row.ctType === 'inverse', faceCurrency = text(row.ctValCcy, 'OKX ctValCcy'), settle = text(row.settleCcy, 'OKX settleCcy');
    if (faceCurrency !== (inverse ? quote : base) || settle !== (inverse ? base : quote) || (inverse && quote !== 'USD')) fail('OKX SWAP contract face/settlement mismatch');
    return { product: finish(selection, native, base, quote, { instrumentId: okxInstrumentId(native), instType: 'SWAP', ctType: row.ctType,
      quantityUnit: 'contract', inverse, contractType: row.ctType, contractValue: positive(row.ctVal, 'OKX ctVal'), contractValueCurrency: faceCurrency,
      settleCoin: settle, settleCcy: settle, tickSize: tick, qtyStep: qty, status: 'live' }) };
  }
  const category = selection.family === 'spot' ? 'SPOT' : 'USDT-FUTURES';
  if (row.category !== category || (selection.family === 'usdt-futures' && row.type !== 'perpetual')) return { excluded: 'unsupported' };
  if (!active(row, 'status', 'online')) return { excluded: 'inactive' };
  // The shipped native feed identity accepts bounded ASCII symbol names.
  // Explicitly count other active exchange names as unsupported rather than
  // making unrelated valid products disappear from the complete catalog.
  if (typeof row.symbol === 'string' && row.symbol.length > 0 && row.symbol.length <= 64 && /[^\x00-\x7f]/.test(row.symbol)) return { excluded: 'unsupported' };
  const native = text(row.symbol, 'Bitget symbol');
  const nativeBase = text(row.baseCoin, 'Bitget baseCoin', /^[A-Za-z0-9][A-Za-z0-9._-]*$/);
  const base = nativeBase.toUpperCase(), quote = text(row.quoteCoin, 'Bitget quoteCoin');
  if (native !== base + quote || (selection.family === 'usdt-futures' && quote !== 'USDT')) fail('Bitget native currency/category identity mismatch');
  const priceDecimals = precision(row.pricePrecision, 'Bitget pricePrecision'), qtyDecimals = precision(row.quantityPrecision, 'Bitget quantityPrecision');
  const tick = selection.family === 'spot' ? Number('1e-' + priceDecimals) : positive(row.priceMultiplier, 'Bitget priceMultiplier');
  const qty = selection.family === 'spot' ? Number('1e-' + qtyDecimals) : positive(row.quantityMultiplier, 'Bitget quantityMultiplier');
  return { product: finish(selection, native, base, quote, { instrumentId: bitgetInstrumentId(native, selection.family), instType: selection.family, category,
    nativeBase, quantityUnit: 'base', contractType: selection.family === 'spot' ? null : 'linear',
    settleCoin: selection.family === 'spot' ? null : quote, tickSize: tick, qtyStep: qty, pricePrecision: priceDecimals,
    quantityPrecision: qtyDecimals, status: 'online' }) };
}
function requestFor(selection: PublicProductDiscoverySelection, cursor: string | null, bybitPageSize: number): ExchangeRestRequest {
  if (selection.venue === 'hyperliquid') return { url: HYPERLIQUID_INFO_URL, method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"type":"meta"}', responseClass: 'catalog' };
  if (selection.venue === 'binance') {
    const descriptor = buildBinanceRequest('exchangeInfo', { marketType: selection.family === 'spot' ? 'spot' : 'perpetual', family: selection.family === 'coinm' ? 'coinm' : 'usdm' });
    if (selection.family !== 'spot') return descriptor;
    const url = new URL(descriptor.url);
    // Permission combinations are irrelevant to public market identity. The
    // documented projection keeps the complete spot catalog under its cap.
    url.searchParams.set('permissions', 'SPOT');
    url.searchParams.set('showPermissionSets', 'false');
    return { ...descriptor, url: url.toString() };
  }
  if (selection.venue === 'bybit') {
    const descriptor = buildBybitRequest('instruments', { category: selection.family, ...(selection.family === 'spot' ? {} : { limit: bybitPageSize }) });
    const url = new URL(descriptor.url);
    if (selection.family !== 'spot') url.searchParams.set('status', 'Trading');
    if (cursor !== null) url.searchParams.set('cursor', cursor);
    return { ...descriptor, url: url.toString(), responseClass: 'catalog' };
  }
  if (selection.venue === 'okx') return { ...buildOkxRequest('instruments', { instType: selection.family === 'spot' ? 'SPOT' : 'SWAP' }), responseClass: 'catalog' };
  return { ...buildBitgetRequest('instruments', { category: selection.family }), responseClass: 'catalog' };
}
function pageRows(selection: PublicProductDiscoverySelection, payload: unknown): { rows: unknown[]; cursor: unknown } {
  const root = object(payload, 'Public instrument response');
  if (selection.venue === 'hyperliquid') return { rows: list(root.universe, 'Hyperliquid universe'), cursor: root.nextPageCursor ?? null };
  if (selection.venue === 'binance') {
    if (root.code !== undefined) fail('Binance provider error response', 'PROVIDER_ERROR');
    return { rows: list(root.symbols, 'Binance symbols'), cursor: root.nextPageCursor ?? null };
  }
  if (selection.venue === 'bybit') {
    if (root.retCode !== 0 && root.retCode !== '0') fail('Bybit provider error response', 'PROVIDER_ERROR');
    const result = object(root.result, 'Bybit result');
    if (result.category !== selection.family || (root.category != null && root.category !== selection.family)) fail('Bybit response category mismatch');
    return { rows: list(result.list, 'Bybit instrument list'), cursor: result.nextPageCursor ?? null };
  }
  if (selection.venue === 'okx') {
    if (root.code !== '0' && root.code !== 0) fail('OKX provider error response', 'PROVIDER_ERROR');
    return { rows: list(root.data, 'OKX instrument data'), cursor: root.nextPageCursor ?? null };
  }
  if (root.code !== '00000' && root.code !== '0' && root.code !== 0) fail('Bitget provider error response', 'PROVIDER_ERROR');
  return { rows: list(root.data, 'Bitget instrument data'), cursor: root.nextPageCursor ?? null };
}
async function cancelBody(response: ExchangeRestResponse): Promise<void> {
  try { await response.body?.cancel?.(); } catch { /* preserve the original failure */ }
}
function aborted(signal: AbortSignal): void {
  if (signal.aborted) throw signal.reason ?? new PublicProductDiscoveryError('Product discovery aborted', 'ABORTED');
}
async function abortable<T>(work: PromiseLike<T> | T, signal: AbortSignal, onLate?: (value: T) => void): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const cleanup = () => signal.removeEventListener('abort', abort);
    const abort = () => { if (settled) return; settled = true; cleanup(); reject(signal.reason ?? new PublicProductDiscoveryError('Product discovery aborted', 'ABORTED')); };
    signal.addEventListener('abort', abort, { once: true });
    Promise.resolve(work).then(value => { if (settled) { onLate?.(value); return; } settled = true; cleanup(); resolve(value); }, error => { if (settled) return; settled = true; cleanup(); reject(error); });
    if (signal.aborted) abort();
  });
}

/** Bounded public metadata only. This module has no default network loader or credentials. */
export async function discoverPublicProducts(options: PublicProductDiscoveryOptions): Promise<PublicProductDiscoveryResult> {
  const selection = validatePublicProductDiscoverySelection(options.venue, options.family);
  if (typeof options.request !== 'function') fail('Product discovery requires an injected raw response request', 'INVALID_TRANSPORT');
  if (options.onRetention != null && typeof options.onRetention !== 'function') fail('onRetention must be a function', 'INVALID_RETENTION');
  if (options.reserveTransientMemory != null && typeof options.reserveTransientMemory !== 'function') fail('reserveTransientMemory must be a function', 'INVALID_RETENTION');
  const input = options.limits ?? {};
  const maxBytesPerPage = boundedInteger(input.maxBytesPerPage, MAX_BODY_BYTES, MAX_BODY_BYTES, 'maxBytesPerPage');
  const maxTotalBytes = boundedInteger(input.maxTotalBytes, MAX_BODY_BYTES, MAX_BODY_BYTES, 'maxTotalBytes');
  const maxPages = boundedInteger(input.maxPages, MAX_PAGES, MAX_PAGES, 'maxPages');
  const maxRows = boundedInteger(input.maxRows, MAX_ROWS, MAX_ROWS, 'maxRows');
  const maxProducts = boundedInteger(input.maxProducts, MAX_ROWS, MAX_ROWS, 'maxProducts');
  const maxCursorBytes = boundedInteger(input.maxCursorBytes, MAX_CURSOR_BYTES, MAX_CURSOR_BYTES, 'maxCursorBytes');
  const bybitPageSize = boundedInteger(input.bybitPageSize, 1_000, 1_000, 'bybitPageSize');
  const timeoutMs = boundedInteger(input.timeoutMs, REQUEST_TIMEOUT_MS, REQUEST_TIMEOUT_MS, 'timeoutMs');
  const now = options.now ?? Date.now;
  if (typeof now !== 'function') fail('now must be a function', 'INVALID_CLOCK');
  const receivedAt = now();
  if (!Number.isSafeInteger(receivedAt) || receivedAt <= 0) fail('Discovery clock must return safe positive milliseconds', 'INVALID_CLOCK');
  const ownerKey = 'public-products:' + selection.venue + ':' + selection.family;
  const products: PublicDiscoveredProduct[] = [], seenIds = new Set<string>(), seenCursors = new Set<string>();
  let productBytes = 2, cursorBytes = 0, keyBytes = 0, pages = 0, rowsSeen = 0, bytesRead = 0, excludedInactive = 0, excludedUnsupported = 0;
  let rawBytes = 0, parseTemporaryBytes = 0, released = false, reservation: ProcessMemoryReservation | null = null;
  // The root callback already combines logical and physical admission. Its
  // presence takes precedence so supplying both cannot double-reserve staging.
  const reserve = options.onRetention ? undefined : options.reserveTransientMemory;
  function report(phase: PublicProductRetentionMeasurement['phase'], candidateBytes = 0, temporary = parseTemporaryBytes): void {
    const shells = phase === 'complete' || phase === 'release' ? 0 : safeSum(OWNER_SHELL_ALLOWANCE_BYTES, keyBytes, seenIds.size * KEY_SHELL_ALLOWANCE_BYTES, seenCursors.size * KEY_SHELL_ALLOWANCE_BYTES);
    const logicalBytes = phase === 'release' ? 0 : safeSum(productBytes, rawBytes, candidateBytes, cursorBytes, shells);
    const temporaryBytes = phase === 'release' ? 0 : safeSum(temporary);
    const measurement: PublicProductRetentionMeasurement = { phase, ownerKey, logicalBytes, temporaryBytes,
      productBytes: phase === 'release' ? 0 : productBytes, rawBytes: phase === 'release' ? 0 : rawBytes,
      candidateBytes: phase === 'release' ? 0 : candidateBytes, cursorBytes: phase === 'release' ? 0 : cursorBytes,
      page: pages, rows: rowsSeen, products: phase === 'release' ? 0 : products.length };
    const admitted = options.onRetention?.(Object.freeze(measurement));
    if (admitted === false && phase !== 'release') fail('Public product retention admission rejected', 'RETENTION_DENIED');
    if (admitted !== undefined && typeof admitted !== 'boolean') fail('Retention admission must be synchronous boolean or void', 'INVALID_RETENTION');
  }
  function reserveOrResize(bytes: number): void {
    if (!reserve) return;
    if (reservation === null) {
      const candidate = reserve(bytes, { kind: 'public-product-discovery', ownerKey, venue: selection.venue, family: selection.family });
      if (candidate?.admitted !== true || typeof candidate.resize !== 'function' || typeof candidate.release !== 'function') {
        candidate?.release?.(); fail('Public product physical reservation rejected or incomplete', 'PROCESS_MEMORY_LIMIT');
      }
      reservation = candidate;
    } else if (reservation.resize?.(bytes)?.admitted !== true) fail('Public product physical reservation resize rejected', 'PROCESS_MEMORY_LIMIT');
  }
  function releaseRetention(): void {
    if (released) return;
    released = true;
    seenIds.clear(); seenCursors.clear(); cursorBytes = 0; keyBytes = 0; rawBytes = 0; parseTemporaryBytes = 0;
    const owned = reservation; reservation = null;
    try { owned?.release?.(); } finally { report('release', 0, 0); }
  }
  let cursor: string | null = null;
  try {
    while (true) {
      if (pages >= maxPages) fail('Public product discovery exceeds page limit', 'PAGE_LIMIT');
      if (bytesRead >= maxTotalBytes) fail('Public product discovery exceeds total body-byte limit', 'BODY_LIMIT');
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(new PublicProductDiscoveryError('Public product request timed out', 'TIMEOUT')), timeoutMs);
      const signal = options.signal ? AbortSignal.any([options.signal, controller.signal]) : controller.signal;
      let response: ExchangeRestResponse | null = null;
      const pageLimit = Math.min(maxBytesPerPage, maxTotalBytes - bytesRead);
      try {
        aborted(signal);
        rawBytes = 0;
        // Wire/chunks plus decoded and joined UTF-16 copies, before body allocation.
        parseTemporaryBytes = safeSum(pageLimit * 6, (DEFAULT_BOUNDED_JSON_RESPONSE_CHUNKS + 1) * DEFAULT_BOUNDED_JSON_RESPONSE_CHUNK_OVERHEAD_BYTES);
        report('read');
        reserveOrResize(safeSum(productBytes * 2, cursorBytes, parseTemporaryBytes));
        const descriptor = requestFor(selection, cursor, bybitPageSize);
        response = await abortable(options.request(descriptor, { selection, signal, maxBytes: pageLimit, page: pages + 1 }), signal,
          late => { void cancelBody(late); });
        aborted(signal);
        if (response?.ok !== true || !Number.isSafeInteger(response.status) || response.status < 200 || response.status >= 300) {
          if (response) await cancelBody(response);
          fail('Public product HTTP response failed', 'HTTP_ERROR');
        }
        const body = response.body;
        const guarded = { headers: response.headers, body: { getReader() {
          aborted(signal);
          const reader = body?.getReader?.();
          if (!reader) return reader;
          const onAbort = () => { try { void Promise.resolve(reader.cancel()).catch(() => {}); } catch { /* preserve abort */ } };
          signal.addEventListener('abort', onAbort, { once: true });
          return {
            async read() { aborted(signal); const result = await abortable(reader.read(), signal); aborted(signal); return result; },
            cancel: () => reader.cancel(), releaseLock() { signal.removeEventListener('abort', onAbort); return reader.releaseLock(); },
          };
        } } };
        const payload = await readBoundedJsonResponse(guarded, { maxBytes: pageLimit, maxChunks: DEFAULT_BOUNDED_JSON_RESPONSE_CHUNKS,
          maxJsonTokens: DEFAULT_BOUNDED_JSON_RESPONSE_TOKENS, maxJsonDepth: DEFAULT_BOUNDED_JSON_RESPONSE_DEPTH, label: 'Public product catalog',
          onBeforeParse(measurement) {
            aborted(signal);
            rawBytes = measurement.bodyBytes;
            parseTemporaryBytes = safeSum(measurement.bodyBytes * 2, measurement.textLength * 4, measurement.textPartCount * DEFAULT_BOUNDED_JSON_RESPONSE_CHUNK_OVERHEAD_BYTES,
              measurement.jsonTokens * DEFAULT_BOUNDED_JSON_TOKEN_MEMORY_BYTES);
            report('parse');
            reserveOrResize(safeSum(productBytes * 2, cursorBytes, parseTemporaryBytes));
          } });
        aborted(signal);
        const page = pageRows(selection, payload);
        if (selection.venue === 'bybit' && selection.family !== 'spot' && page.rows.length > bybitPageSize) fail('Bybit page exceeds requested row limit', 'ROW_LIMIT');
        if (page.rows.length > maxRows - rowsSeen) fail('Public product discovery exceeds row limit', 'ROW_LIMIT');
        rowsSeen += page.rows.length;
        bytesRead = safeSum(bytesRead, rawBytes); pages += 1;
        const candidate: PublicDiscoveredProduct[] = [];
        let candidateBytes = 0;
        for (const row of page.rows) {
          const parsed = parseRow(selection, row, receivedAt);
          if ('excluded' in parsed) { if (parsed.excluded === 'inactive') excludedInactive += 1; else excludedUnsupported += 1; continue; }
          const product = parsed.product;
          if (seenIds.has(product.instrumentId)) fail('Public product identity is duplicated across catalog pages', 'DUPLICATE_PRODUCT');
          if (products.length + candidate.length >= maxProducts) fail('Public product discovery exceeds product limit', 'PRODUCT_LIMIT');
          seenIds.add(product.instrumentId); keyBytes = safeSum(keyBytes, byteLength(product.instrumentId));
          candidateBytes = safeSum(candidateBytes, byteLength(JSON.stringify(product)), products.length + candidate.length > 0 ? 1 : 0);
          candidate.push(product);
        }
        const next = page.cursor;
        if (next != null && typeof next !== 'string') fail('Catalog cursor must be an opaque string', 'INVALID_CURSOR');
        const nextCursor = next === '' || next == null ? null : next;
        if (nextCursor !== null) {
          if (selection.venue !== 'bybit' || selection.family === 'spot') fail('Pagination is unsupported for this catalog family', 'UNSUPPORTED_PAGINATION');
          if (byteLength(nextCursor) > maxCursorBytes || /[\x00-\x1f\x7f]/.test(nextCursor)) fail('Catalog cursor exceeds its bounded opaque token contract', 'INVALID_CURSOR');
          if (seenCursors.has(nextCursor)) fail('Catalog cursor was repeated', 'DUPLICATE_CURSOR');
          if (page.rows.length === 0) fail('Paginated catalog did not make row progress', 'INVALID_CURSOR');
          seenCursors.add(nextCursor); cursorBytes = safeSum(cursorBytes, byteLength(nextCursor));
        }
        report('accumulate', candidateBytes);
        for (const product of candidate) products.push(product);
        productBytes = safeSum(productBytes, candidateBytes);
        rawBytes = 0; parseTemporaryBytes = 0;
        if (nextCursor === null) break;
        cursor = nextCursor;
      } finally {
        clearTimeout(timer);
        if (signal.aborted && response) await cancelBody(response);
      }
    }
    seenIds.clear(); seenCursors.clear(); cursorBytes = 0; keyBytes = 0;
    report('complete', 0, 0);
    if (reservation) reserveOrResize(safeSum(productBytes * 2, products.length * KEY_SHELL_ALLOWANCE_BYTES));
    const descriptor = requestFor(selection, null, bybitPageSize);
    let documentationUrl = DOCUMENTATION[selection.venue];
    if (selection.venue === 'binance' && selection.family !== 'spot') documentationUrl = 'https://developers.binance.com/docs/derivatives/'
      + (selection.family === 'coinm' ? 'coin-margined-futures' : 'usds-margined-futures') + '/market-data/rest-api/Exchange-Information';
    return { selection, venue: selection.venue, family: selection.family, products, pages, rowsSeen, bytesRead, excludedInactive, excludedUnsupported,
      complete: true, nextCursor: null, source: 'public-metadata', sourceUrl: descriptor.url, documentationUrl, receivedAt,
      memoryAdmission: options.onRetention ? 'retention-callback' : reserve ? 'transient-reservation' : 'unavailable', releaseRetention };
  } catch (error) {
    products.length = 0;
    try { releaseRetention(); } catch { /* the original admission, wire or metadata failure stays authoritative */ }
    throw error;
  }
}
