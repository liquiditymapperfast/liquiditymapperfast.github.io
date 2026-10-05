import { recordValue, arrayValue, type AdapterOptions, type AdapterTransport, type WireRecord } from './common.mts';
import { AdapterTransportError, epochMs, finiteNumber, requireSymbol } from './common.mts';

/** Aster futures v3 public exchangeInfo and Binance-compatible aggTrade descriptors. */
export const ASTER_REST_URL = 'https://fapi.asterdex.com';
export const ASTER_PUBLIC_WS_URL = 'wss://fstream.asterdex.com/ws';
export const ASTER_DEFAULT_SYMBOL = 'BTCUSDT';
export const ASTER_AGG_TRADE_STREAM = 'aggTrade';
export const ASTER_DEPTH_LEVELS = 20;

function marketSymbol(value: unknown) {
  const native = requireSymbol(value);
  if (!/^[A-Z0-9]+$/.test(native)) throw new TypeError('Invalid Aster futures symbol');
  return native;
}

function instrumentId(value: unknown) { return `aster:${marketSymbol(value)}`; }

function assertAsterResponse(payload: unknown) {
  if (recordValue(payload)?.code != null && Number(recordValue(payload).code) !== 0) throw new Error(`Aster provider error: ${recordValue(payload)?.msg ?? recordValue(payload).code}`);
  if (recordValue(payload)?.error != null) throw new Error(`Aster provider error: ${recordValue(recordValue(payload).error)?.msg ?? recordValue(payload).error}`);
  return payload;
}

function filterValue(row: unknown, type: string, field: string) {
  const filter = Array.isArray(recordValue(row)?.filters) ? arrayValue(recordValue(row).filters).find((item: unknown) => String(recordValue(item)?.filterType ?? '').toUpperCase() === type) : null;
  return recordValue(filter)?.[field];
}

/** Build the bounded public exchangeInfo request. */
export function buildAsterRequest(kind: string = 'exchangeInfo', _params: AdapterOptions = {}) {
  if (kind !== 'exchangeInfo') throw new RangeError(`Unsupported Aster request: ${kind}`);
  return { url: `${ASTER_REST_URL}/fapi/v1/exchangeInfo`, method: 'GET', headers: { accept: 'application/json' }, responseClass: 'catalog' };
}

/** Build the exact Binance-compatible raw aggTrade subscription. */
export function buildAsterSubscription(kind: string = 'aggTrade', { symbol = ASTER_DEFAULT_SYMBOL, id = 1 }: AdapterOptions = {}) {
  if (kind !== 'aggTrade' && kind !== 'depth') throw new RangeError(`Unsupported Aster subscription: ${kind}`);
  const nativeSymbol = marketSymbol(symbol);
  const stream = kind === 'depth' ? `${nativeSymbol.toLowerCase()}@depth${ASTER_DEPTH_LEVELS}@100ms` : `${nativeSymbol.toLowerCase()}@${ASTER_AGG_TRADE_STREAM}`;
  const requestId = Number(id);
  if (!Number.isSafeInteger(requestId) || requestId < 0) throw new TypeError('Aster subscription id must be an unsigned integer');
  return {
    url: ASTER_PUBLIC_WS_URL, method: 'SUBSCRIBE', params: [stream], id: requestId,
    stream, topic: stream, symbol: nativeSymbol,
    ...(kind === 'depth' ? { depth: ASTER_DEPTH_LEVELS, snapshot: true } : {}),
  };
}

/** Normalize the selected active perpetual row from Aster exchangeInfo. */
export function normalizeAsterMarkets(payload: unknown, { symbol, receivedAt = Date.now() }: AdapterOptions = {}) {
  const source = assertAsterResponse(payload);
  const rows = recordValue(source)?.symbols;
  if (!Array.isArray(rows)) throw new TypeError('Aster exchangeInfo symbols missing');
  const expected = symbol == null ? null : marketSymbol(symbol);
  const selected = rows.filter((row: unknown) => {
    try {
      const nativeSymbol = marketSymbol(recordValue(row)?.symbol);
      return expected == null || nativeSymbol === expected;
    } catch {
      return false;
    }
  });
  const assets = selected.map((row: unknown, index) => {
    const nativeSymbol = marketSymbol(recordValue(row).symbol);
    const contractType = String(recordValue(row)?.contractType ?? '').toUpperCase();
    const marketType = contractType === 'PERPETUAL' ? 'perpetual' : 'delivery';
    const status = String(recordValue(row)?.status ?? '').toUpperCase();
    const tickSize = finiteNumber(filterValue(row, 'PRICE_FILTER', 'tickSize'), `symbols[${index}].tickSize`);
    const lotSize = finiteNumber(filterValue(row, 'LOT_SIZE', 'stepSize') ?? filterValue(row, 'MARKET_LOT_SIZE', 'stepSize'), `symbols[${index}].stepSize`);
    if (!(tickSize > 0) || !(lotSize > 0)) throw new TypeError(`Aster symbols[${index}] tick/step must be positive`);
    const base = String(recordValue(row)?.baseAsset ?? '').trim().toUpperCase();
    const quote = String(recordValue(row)?.quoteAsset ?? '').trim().toUpperCase();
    const margin = String(recordValue(row)?.marginAsset ?? '').trim().toUpperCase();
    if (!base || !quote || !margin) throw new TypeError(`Invalid Aster symbols[${index}] base/quote/margin metadata`);
    const active = marketType === 'perpetual' && status === 'TRADING';
    return {
      instrumentId: instrumentId(nativeSymbol), venue: 'aster', nativeSymbol, symbol: nativeSymbol,
      base, quote, marketType, contractType, settleCoin: margin,
      tickSize, lotSize, quantityUnit: 'base', status: active ? 'online' : (status || 'unknown').toLowerCase(),
      isDelisted: !active, metadataSource: 'aster-fapi-v1-exchangeInfo', receivedAt,
    };
  });
  return { kind: 'metadata' as const, venue: 'aster', sourceTimestamp: epochMs(recordValue(source)?.serverTime, null), receivedAt, assets };
}

/** Normalize one raw or combined Aster aggTrade event. */
export function normalizeAsterTrade(row: unknown, { symbol = ASTER_DEFAULT_SYMBOL, receivedAt = Date.now() }: AdapterOptions = {}) {
  const hasStream = row != null && Object.prototype.hasOwnProperty.call(row, 'stream');
  const hasData = row != null && Object.prototype.hasOwnProperty.call(row, 'data');
  if (hasStream !== hasData) throw new TypeError('Aster raw/combined frame mismatch');
  if (hasStream && (recordValue(row)?.data == null || typeof recordValue(row).data !== 'object' || Array.isArray(recordValue(row).data))) throw new TypeError('Aster combined frame data missing');
  const value = hasStream ? recordValue(row).data : row;
  if (String(recordValue(value)?.e ?? '') !== ASTER_AGG_TRADE_STREAM) throw new TypeError('Aster aggTrade event missing');
  const expectedSymbol = marketSymbol(symbol);
  const nativeSymbol = marketSymbol(recordValue(value)?.s);
  if (nativeSymbol !== expectedSymbol) throw new TypeError('Aster trade symbol mismatch');
  const rawId = recordValue(value)?.a;
  const id = typeof rawId === 'number' ? rawId : (typeof rawId === 'string' && /^[0-9]+$/.test(rawId.trim()) ? Number(rawId) : Number.NaN);
  if (!Number.isSafeInteger(id) || id < 0) throw new TypeError('Aster aggregate trade id missing or invalid');
  const rawTimestamp = recordValue(value)?.T;
  if (rawTimestamp == null || (typeof rawTimestamp === 'string' && rawTimestamp.trim() === '')) throw new TypeError('Aster aggregate trade timestamp missing');
  const sourceTimestamp = epochMs(rawTimestamp, Number.NaN);
  if (!(sourceTimestamp > 0)) throw new TypeError('Aster aggregate trade timestamp missing or invalid');
  const price = finiteNumber(recordValue(value)?.p, 'Aster aggregate trade price');
  const rawAmount = recordValue(value)?.q;
  if (rawAmount == null || (typeof rawAmount === 'string' && rawAmount.trim() === '')) throw new TypeError('Aster aggregate trade quantity missing');
  const amount = finiteNumber(rawAmount, 'Aster aggregate trade quantity');
  if (!(price > 0) || !(amount > 0)) throw new TypeError('Invalid Aster aggregate trade values');
  if (typeof recordValue(value)?.m !== 'boolean') throw new TypeError('Aster aggregate trade maker flag missing or invalid');
  return {
    kind: 'trade' as const, venue: 'aster', instrumentId: instrumentId(nativeSymbol), tradeId: `${nativeSymbol}:${id}`,
    side: recordValue(value)?.m === true ? 'sell' : 'buy', price, amount, notionalUsd: price * amount,
    sourceTimestamp, receivedAt,
  };
}

/** Normalize raw `/ws/<stream>` or combined `/stream` aggTrade frames. */
export function normalizeAsterTrades(payload: unknown, { symbol = ASTER_DEFAULT_SYMBOL, receivedAt = Date.now() }: AdapterOptions = {}) {
  const expected = buildAsterSubscription('aggTrade', { symbol });
  const hasStream = payload != null && Object.prototype.hasOwnProperty.call(payload, 'stream');
  const hasData = payload != null && Object.prototype.hasOwnProperty.call(payload, 'data');
  if (hasStream !== hasData) throw new TypeError('Aster raw/combined frame mismatch');
  if (hasStream && String(recordValue(payload).stream).toLowerCase() !== expected.stream.toLowerCase()) throw new TypeError('Aster stream mismatch');
  if (hasStream && (recordValue(payload)?.data == null || typeof recordValue(payload).data !== 'object' || Array.isArray(recordValue(payload).data))) throw new TypeError('Aster combined frame data missing');
  const value = hasStream ? recordValue(payload).data : payload;
  return String(recordValue(value)?.e ?? '') === ASTER_AGG_TRADE_STREAM ? [normalizeAsterTrade(payload, { symbol, receivedAt })] : [];
}


/** Only the verified USDT-settled linear perpetual family is supported by
 * this bounded depth path. Native identity and settlement are never inferred
 * from the requested ticker when contradictory metadata is available. */
export interface AsterLinearDepthMetadata extends WireRecord {
  instrumentId: string; venue: 'aster'; nativeSymbol: string; symbol: string; base: string; quote: 'USDT';
  marketType: 'perpetual'; contractType: 'PERPETUAL'; settleCoin: 'USDT'; quantityUnit: 'base';
  status: 'online'; isDelisted: false; tickSize: number; lotSize: number;
}
export function isAsterLinearDepthMetadata(metadata: unknown, nativeSymbol: unknown): metadata is AsterLinearDepthMetadata {
  if (typeof nativeSymbol !== 'string' || !/^[A-Z0-9]+USDT$/.test(nativeSymbol)
    || metadata == null || typeof metadata !== 'object' || Array.isArray(metadata)) return false;
  const row = recordValue(metadata), base = row.base;
  if (typeof base !== 'string' || !/^[A-Z0-9]+$/.test(base) || nativeSymbol !== base + 'USDT'
    || row.nativeSymbol !== nativeSymbol || row.symbol !== nativeSymbol || row.instrumentId !== `aster:${nativeSymbol}` || row.venue !== 'aster'
    || row.marketType !== 'perpetual' || row.contractType !== 'PERPETUAL' || row.quantityUnit !== 'base'
    || row.quote !== 'USDT' || row.settleCoin !== 'USDT' || row.status !== 'online' || row.isDelisted !== false
    || typeof row.tickSize !== 'number' || !Number.isFinite(row.tickSize) || row.tickSize <= 0
    || typeof row.lotSize !== 'number' || !Number.isFinite(row.lotSize) || row.lotSize <= 0) return false;
  // The normalized REST DTO uses settleCoin. If raw aliases or an inverse
  // marker are also supplied, they must corroborate the same supported basis.
  if (Object.prototype.hasOwnProperty.call(row, 'baseAsset') && row.baseAsset !== base
    || Object.prototype.hasOwnProperty.call(row, 'quoteAsset') && row.quoteAsset !== 'USDT'
    || Object.prototype.hasOwnProperty.call(row, 'marginAsset') && row.marginAsset !== 'USDT'
    || Object.prototype.hasOwnProperty.call(row, 'inverse') && row.inverse !== false) return false;
  return true;
}

function depthToken(value: unknown, field: string): number | string {
  if (typeof value === 'number' && (!Number.isSafeInteger(value) || value < 0)) throw new TypeError(`Aster depth ${field} unsafe or invalid`);
  if (typeof value !== 'number' && (typeof value !== 'string' || !/^[0-9]{1,32}$/.test(value))) throw new TypeError(`Aster depth ${field} missing or invalid`);
  const integer = BigInt(value);
  return integer <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(integer) : integer.toString();
}
function depthRows(value: unknown, field: string) {
  if (!Array.isArray(value) || value.length > ASTER_DEPTH_LEVELS) throw new TypeError(`Aster partial depth ${field} exceeds its native level domain or is missing`);
  return value.map((row: unknown, index) => {
    if (!Array.isArray(row) || row.length !== 2) throw new TypeError(`Aster depth ${field}[${index}] malformed`);
    for (const scalar of row) if ((typeof scalar !== 'number' && typeof scalar !== 'string') || typeof scalar === 'string' && !scalar.trim()) throw new TypeError(`Aster depth ${field}[${index}] numeric fields missing`);
    const price = finiteNumber(row[0], 'Aster depth price'), amount = finiteNumber(row[1], 'Aster depth amount');
    if (!(price > 0) || amount < 0) throw new TypeError(`Aster depth ${field}[${index}] out of range`);
    return { price, amount };
  });
}
/** Native top20 partial-book snapshot stream, never the incremental @depth
 * stream. Every accepted frame replaces the entire supplied top20 view. The
 * original payload is retained; no full-exchange coverage is inferred. */
export function normalizeAsterDepth(payload: unknown, { symbol = ASTER_DEFAULT_SYMBOL, receivedAt = Date.now(), metadata }: AdapterOptions = {}) {
  assertAsterResponse(payload);
  const expected = buildAsterSubscription('depth', { symbol });
  const hasStream = payload != null && Object.prototype.hasOwnProperty.call(payload, 'stream');
  const hasData = payload != null && Object.prototype.hasOwnProperty.call(payload, 'data');
  if (hasStream !== hasData || hasStream && recordValue(payload).stream !== expected.stream) throw new TypeError('Aster depth raw/combined stream mismatch');
  const data = recordValue(hasStream ? recordValue(payload).data : payload);
  if (data.e !== 'depthUpdate' || data.s !== expected.symbol) throw new TypeError('Aster depth event or symbol mismatch');
  const sequence = depthToken(data.u, 'u'), first = depthToken(data.U, 'U'), previous = depthToken(data.pu, 'pu');
  if (BigInt(sequence) < BigInt(first) || BigInt(previous) > BigInt(sequence)) throw new TypeError('Aster depth update range invalid');
  const sourceTimestamp = Number(data.T ?? data.E), eventTime = Number(data.E);
  if (![data.E, data.T ?? data.E].every(value => (typeof value === 'number' || typeof value === 'string') && String(value).trim())
    || !Number.isSafeInteger(sourceTimestamp) || sourceTimestamp <= 0 || !Number.isSafeInteger(eventTime) || eventTime <= 0) throw new TypeError('Aster depth provider timestamp missing or invalid');
  const nativeSymbol = expected.symbol;
  if (!isAsterLinearDepthMetadata(metadata, nativeSymbol)) throw new TypeError('Aster depth native USDT linear market metadata mismatch');
  const market = { ...metadata };
  return { kind: 'depthSnapshot' as const, venue: 'aster', instrumentId: instrumentId(nativeSymbol), nativeSymbol, market, units: 'base' as const,
    bids: depthRows(data.b, 'bids'), asks: depthRows(data.a, 'asks'), sequence, previousSequence: previous, firstUpdate: first,
    sourceTimestamp, receivedAt, complete: true, coverage: 'partial' as const, sourceDepth: ASTER_DEPTH_LEVELS,
    continuity: 'provider-snapshot', channel: expected.stream, payload };
}

/** Connector boundary. Network access is opt-in and transport-injected. */
export class AsterConnector {
  networkEnabled: boolean;
  transport: AdapterTransport | null;
  constructor({ transport = null, networkEnabled = false }: AdapterOptions = {}) { this.transport = transport; this.networkEnabled = networkEnabled; }
  async request(kind: string = 'exchangeInfo', params: AdapterOptions = {}) {
    if (!this.networkEnabled || !this.transport?.request) throw new AdapterTransportError('Aster network disabled; inject transport and set networkEnabled=true');
    return this.transport.request(buildAsterRequest(kind, params));
  }
  async subscribe(kind: string = 'aggTrade', params: AdapterOptions = {}) {
    if (!this.networkEnabled || !this.transport?.subscribe) throw new AdapterTransportError('Aster network disabled; inject transport and set networkEnabled=true');
    return this.transport.subscribe(buildAsterSubscription(kind, params));
  }
}
