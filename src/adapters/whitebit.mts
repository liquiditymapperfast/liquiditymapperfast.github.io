import { recordValue, type AdapterOptions, type AdapterTransport, type WireRecord } from './common.mts';
import { AdapterTransportError, epochMs, finiteNumber, sideLevels } from './common.mts';

/** WhiteBIT public spot market metadata and depth stream descriptors. */
export const WHITEBIT_REST_URL = 'https://whitebit.com/api/v4/public';
export const WHITEBIT_PUBLIC_WS_URL = 'wss://wss.whitebit.com/ws';
export const WHITEBIT_DEFAULT_SYMBOL = 'BTC_USDT';
export const WHITEBIT_DEFAULT_DEPTH = 100;
export const WHITEBIT_DEFAULT_INTERVAL = '0';

function symbol(value: unknown) {
  const native = String(value ?? '').trim().toUpperCase();
  if (!/^[A-Z0-9]+_[A-Z0-9]+$/.test(native)) throw new TypeError('Invalid WhiteBIT market symbol');
  return native;
}

function instrumentId(value: unknown) { return `whitebit:${symbol(value)}`; }

function decimalPower(value: unknown, field: string) {
  const places = Math.trunc(finiteNumber(value, field));
  if (places < -18 || places > 18) throw new RangeError(`WhiteBIT ${field} must be from -18 through 18`);
  return 10 ** -places;
}

function explicitStep(value: unknown, field: string) {
  if (value == null || String(value).trim() === '') return null;
  const step = finiteNumber(value, field);
  if (!(step > 0)) throw new RangeError(`WhiteBIT ${field} must be positive`);
  return step;
}

function marketFor(value: unknown, metadata: WireRecord = {}) {
  const native = symbol(value);
  const [base, quote = 'USDT'] = native.split('_');
  const type = String(metadata.type ?? metadata.marketType ?? 'spot').toLowerCase();
  const marketType = type === 'futures' || type === 'perpetual' ? 'perpetual' : type === 'spot' ? 'spot' : null;
  if (!marketType) throw new TypeError(`Unsupported WhiteBIT market type: ${type}`);
  return {
    venue: 'whitebit', nativeSymbol: native, symbol: native,
    base: String(metadata.base ?? base).toUpperCase(), quote: String(metadata.quote ?? quote).toUpperCase(),
    marketType, tickSize: metadata.tickSize ?? null, quantityUnit: 'base' as const,
  };
}

function assertWhitebit(payload: unknown) {
  if (recordValue(payload)?.error) {
    const error = recordValue(payload).error;
    throw new Error(`WhiteBIT provider error ${recordValue(error)?.code ?? 'unknown'}: ${recordValue(error)?.message ?? 'request failed'}`);
  }
  return payload;
}

function token(value: unknown, field: string, { required = false }: AdapterOptions = {}) {
  if (value == null || String(value).trim() === '') {
    if (required) throw new TypeError(`WhiteBIT ${field} missing or invalid`);
    return null;
  }
  if (typeof value === 'number' && !Number.isSafeInteger(value)) throw new TypeError(`WhiteBIT ${field} is unsafe numeric; preserve the provider token as a string`);
  const text = String(value).trim();
  if (!/^\d+$/.test(text)) throw new TypeError(`WhiteBIT ${field} missing or invalid`);
  const integer = BigInt(text);
  return integer <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(integer) : integer.toString();
}

function rows(values: unknown, field: string, { allowZero = false }: AdapterOptions = {}) {
  if (!Array.isArray(values)) throw new TypeError(`WhiteBIT ${field} must be an array`);
  return values.map((row: unknown, index) => {
    if (!Array.isArray(row) || row.length < 2) throw new TypeError(`WhiteBIT ${field}[${index}] malformed`);
    const price = finiteNumber(row[0], `${field}[${index}].price`);
    const amount = finiteNumber(row[1], `${field}[${index}].amount`);
    if (!(price > 0) || amount < 0 || (!allowZero && amount === 0)) throw new TypeError(`WhiteBIT ${field}[${index}] out of range`);
    return { price, amount };
  });
}

export function buildWhitebitRequest(kind: string, { symbol: pair = WHITEBIT_DEFAULT_SYMBOL, baseUrl = WHITEBIT_REST_URL, depth = WHITEBIT_DEFAULT_DEPTH }: AdapterOptions = {}) {
  if (kind === 'markets') return { url: `${baseUrl}/markets`, method: 'GET', headers: { accept: 'application/json' }, responseClass: 'catalog' };
  if (kind === 'depth') {
    const native = symbol(pair);
    const limit = Math.trunc(finiteNumber(depth, 'depth'));
    if (limit < 0 || limit > WHITEBIT_DEFAULT_DEPTH) throw new RangeError(`Unsupported WhiteBIT depth: ${depth}`);
    return { url: `${baseUrl}/orderbook/${encodeURIComponent(native)}?limit=${limit}&level=2`, method: 'GET', headers: { accept: 'application/json' } };
  }
  throw new RangeError(`Unsupported WhiteBIT request: ${kind}`);
}

export function buildWhitebitSubscription(kind: string, { symbol: pair = WHITEBIT_DEFAULT_SYMBOL, depth = WHITEBIT_DEFAULT_DEPTH, interval = WHITEBIT_DEFAULT_INTERVAL, id = 1 }: AdapterOptions = {}) {
  if (kind !== 'depth') throw new RangeError(`Unsupported WhiteBIT subscription: ${kind}`);
  const native = symbol(pair);
  const limit = Math.trunc(finiteNumber(depth, 'depth'));
  if (![1, 5, 10, 20, 30, 50, 100].includes(limit)) throw new RangeError(`Unsupported WhiteBIT subscription depth: ${depth}`);
  const step = String(interval);
  if (step !== WHITEBIT_DEFAULT_INTERVAL) throw new RangeError(`Unsupported WhiteBIT interval: ${interval}`);
  return {
    url: WHITEBIT_PUBLIC_WS_URL, id: Number.isSafeInteger(Number(id)) ? Number(id) : String(id),
    method: 'depth_subscribe', params: [native, limit, step, true],
    channel: 'depth_update', topic: `depth:${native}`, symbol: native, depth: limit, interval: step, snapshot: true,
  };
}

export function normalizeWhitebitMarkets(payload: unknown, { symbol: selectedSymbol = null, receivedAt = Date.now() }: AdapterOptions = {}) {
  const raw = assertWhitebit(payload);
  const list = Array.isArray(raw) ? raw : recordValue(raw)?.data;
  if (!Array.isArray(list)) throw new TypeError('WhiteBIT markets metadata must be an array');
  const selected = selectedSymbol == null ? null : symbol(selectedSymbol);
  const assets = list.map((row: unknown) => {
    const native = recordValue(row)?.name == null ? null : symbol(recordValue(row).name);
    if (!native || (selected != null && native !== selected)) return null;
    const type = String(recordValue(row)?.type ?? 'spot').toLowerCase();
    if (!['spot', 'futures'].includes(type)) return null;
    // Keep only explicit perpetual identities when normalizing futures rows;
    // dated/other futures stay outside this bounded packet's registry scope.
    if (type === 'futures' && !native.endsWith('_PERP')) return null;
    const tickSize = explicitStep(recordValue(row).tickSize, 'tickSize') ?? (recordValue(row).moneyPrec == null ? null : decimalPower(recordValue(row).moneyPrec, 'moneyPrec'));
    const lotSize = explicitStep(recordValue(row).stepSize, 'stepSize') ?? (recordValue(row).stockPrec == null ? undefined : decimalPower(recordValue(row).stockPrec, 'stockPrec'));
    const enabled = recordValue(row).tradesEnabled == null ? true : recordValue(row).tradesEnabled === true;
    const market = marketFor(native, { base: recordValue(row).stock, quote: recordValue(row).money, type, tickSize });
    return {
      instrumentId: instrumentId(native), ...market, venue: 'whitebit',
      tickSize, ...(lotSize == null ? {} : { lotSize }), isDelisted: !enabled,
      status: enabled ? 'online' : 'offline', metadataSource: 'whitebit-v4-markets',
    };
  }).filter((item): item is NonNullable<typeof item> => Boolean(item));
  return { kind: 'metadata' as const, venue: 'whitebit', sourceTimestamp: null, receivedAt, assets };
}

function unpackDepth(payload: unknown, { symbol: selectedSymbol = WHITEBIT_DEFAULT_SYMBOL, receivedAt = Date.now() }: AdapterOptions = {}) {
  const raw = assertWhitebit(payload);
  const native = symbol(selectedSymbol);
  if (recordValue(raw)?.method === 'depth_update') {
    const params = recordValue(raw).params;
    if (!Array.isArray(params) || params.length < 3 || String(params[2]).toUpperCase() !== native) throw new TypeError('WhiteBIT depth market mismatch');
    if (recordValue(raw).id !== null) throw new TypeError('WhiteBIT depth update id must be null');
    if (typeof params[0] !== 'boolean') throw new TypeError('WhiteBIT depth update snapshot flag must be boolean');
    const data = params[1];
    if (!data || typeof data !== 'object') throw new TypeError('WhiteBIT depth update missing data');
    const full = params[0] === true;
    if (full && data.past_update_id != null) throw new TypeError('WhiteBIT snapshot must not include past_update_id');
    if (!full && data.past_update_id == null) throw new TypeError('WhiteBIT delta missing past_update_id');
    const market = marketFor(native);
    return {
      raw, native, market, full,
      sourceTimestamp: epochMs(data.timestamp ?? data.event_time, receivedAt),
      sequence: token(data.update_id, 'update_id', { required: true }),
      previousSequence: full ? null : token(data.past_update_id, 'past_update_id', { required: true }),
      bids: rows(data.bids ?? [], 'bids', { allowZero: !full }),
      asks: rows(data.asks ?? [], 'asks', { allowZero: !full }),
    };
  }
  const data = recordValue(raw)?.result && typeof recordValue(raw).result === 'object' ? recordValue(raw).result : raw;
  const market = marketFor(native);
  return {
    raw, native, market, full: true, sourceTimestamp: epochMs(recordValue(data)?.timestamp, receivedAt),
    sequence: token(recordValue(data)?.update_id, 'update_id'), previousSequence: null,
    bids: rows(recordValue(data)?.bids ?? [], 'bids'), asks: rows(recordValue(data)?.asks ?? [], 'asks'),
  };
}

export function normalizeWhitebitDepth(payload: unknown, { symbol: selectedSymbol = WHITEBIT_DEFAULT_SYMBOL, receivedAt = Date.now() }: AdapterOptions = {}) {
  const value = unpackDepth(payload, { symbol: selectedSymbol, receivedAt });
  const common = {
    venue: 'whitebit', instrumentId: instrumentId(value.native), nativeSymbol: value.native, market: value.market,
    units: 'base' as const, sourceTimestamp: value.sourceTimestamp, receivedAt, complete: value.full,
    coverage: 'partial' as const, bids: sideLevels(value.bids.map(row => [row.price, row.amount]), 'bids'),
    asks: sideLevels(value.asks.map(row => [row.price, row.amount]), 'asks'),
  };
  if (value.full) return { kind: 'depthSnapshot' as const, ...common, ...(value.sequence == null ? {} : { sequence: value.sequence }), continuity: 'provider-snapshot' };
  // Delta tokens were already required by unpackDepth; keep that guarantee explicit at this normalized boundary.
  if (value.sequence == null || value.previousSequence == null) throw new TypeError('WhiteBIT delta missing required sequence tokens');
  return { kind: 'depthDelta' as const, ...common, sequence: value.sequence, previousSequence: value.previousSequence, continuity: 'strict' };
}

export class WhitebitConnector {
  networkEnabled: boolean;
  transport: AdapterTransport | null;
  constructor({ transport = null, networkEnabled = false }: AdapterOptions = {}) { this.transport = transport; this.networkEnabled = networkEnabled; }
  async request(kind: string, params: AdapterOptions = {}) { if (!this.networkEnabled || !this.transport?.request) throw new AdapterTransportError('WhiteBIT network disabled; inject transport and set networkEnabled=true'); return this.transport.request(buildWhitebitRequest(kind, params)); }
  async subscribe(kind: string, params: AdapterOptions = {}) { if (!this.networkEnabled || !this.transport?.subscribe) throw new AdapterTransportError('WhiteBIT network disabled; inject transport and set networkEnabled=true'); return this.transport.subscribe(buildWhitebitSubscription(kind, params)); }
}
