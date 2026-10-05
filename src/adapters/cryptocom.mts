import { recordValue, type AdapterOptions, type AdapterTransport, type WireRecord, type AdapterDepthBook, type DepthSessionIdentity, type DepthSessionMessageOptions, type DepthSessionResult } from './common.mts';
import { AdapterTransportError, epochMs, finiteNumber, requireSymbol, sideLevels } from './common.mts';

import type { PriceAmount } from '../domain/contracts.ts';
export type CryptocomDepthMessage = ReturnType<typeof normalizeCryptocomDepth>;
export interface CryptocomBookRow extends PriceAmount { side: string; }
export interface CryptocomDepthSession extends DepthSessionIdentity { instrumentName: string; depth: number; lastSequence: number | string | null; book: AdapterDepthBook | null; rows: Map<string, CryptocomBookRow>; }
/** Crypto.com Exchange v1 public market book descriptors and session reducer. */
export const CRYPTOCOM_REST_URL = 'https://api.crypto.com/exchange/v1';
export const CRYPTOCOM_PUBLIC_WS_URL = 'wss://stream.crypto.com/exchange/v1/market';
export const CRYPTOCOM_DEFAULT_INSTRUMENT = 'BTCUSD-PERP';
export const CRYPTOCOM_DEFAULT_DEPTH = 10;
export const CRYPTOCOM_DEFAULT_UPDATE_FREQUENCY = 100;
export const CRYPTOCOM_BOOK_SUBSCRIPTION_TYPE = 'SNAPSHOT_AND_UPDATE';

function instrument(value: unknown) {
  const native = requireSymbol(value).toUpperCase();
  if (!/^[A-Z0-9._-]{3,32}$/.test(native)) throw new TypeError('Invalid Crypto.com instrument name');
  return native;
}

function instrumentId(value: unknown) { return `cryptocom:${instrument(value)}`; }

function depthValue(value: unknown) {
  const depth = Math.trunc(finiteNumber(value, 'depth'));
  if (![10, 50].includes(depth)) throw new RangeError(`Unsupported Crypto.com book depth: ${value}`);
  return depth;
}

function normalizeUpdateFrequency(value: unknown) {
  const frequency = Math.trunc(finiteNumber(value, 'book_update_frequency'));
  if (![10, 100].includes(frequency)) throw new RangeError(`Unsupported Crypto.com book update frequency: ${value}`);
  return frequency;
}

function assertCryptocom(payload: unknown) {
  if (recordValue(payload)?.error || (recordValue(payload)?.code != null && Number(recordValue(payload).code) !== 0)) {
    const error = recordValue(payload).error ?? payload;
    throw new Error(`Crypto.com provider error ${recordValue(error)?.code ?? recordValue(payload)?.code ?? 'unknown'}: ${recordValue(error)?.message ?? recordValue(payload)?.message ?? 'request failed'}`);
  }
  return payload;
}

function sequence(value: unknown, field: string, { required = true }: AdapterOptions = {}) {
  if (value == null || String(value).trim() === '') {
    if (!required) return null;
    throw new TypeError(`Crypto.com ${field} missing or invalid`);
  }
  if (typeof value === 'number' && !Number.isSafeInteger(value)) throw new TypeError(`Crypto.com ${field} is unsafe numeric; preserve the provider token as a string`);
  const text = String(value).trim();
  if (!/^\d+$/.test(text)) throw new TypeError(`Crypto.com ${field} missing or invalid`);
  const integer = BigInt(text);
  return integer <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(integer) : integer.toString();
}

function compareSequence(left: unknown, right: unknown) {
  try {
    const a = BigInt(String(left)); const b = BigInt(String(right));
    return a < b ? -1 : a > b ? 1 : 0;
  } catch {
    return String(left) < String(right) ? -1 : String(left) > String(right) ? 1 : 0;
  }
}

function inferredMarketType(native: unknown) {
  const parts = String(native).split(/[-_]/);
  const suffix = String(parts.at(-1) ?? '').toUpperCase();
  if (suffix === 'PERP') return 'perpetual';
  if (/^\d{6}$/.test(suffix)) return 'delivery';
  if (String(native).includes('_')) return 'spot';
  return null;
}

function marketTypeForInstrument(row: unknown, native: unknown, fallback: unknown = null) {
  const type = String(recordValue(row)?.inst_type ?? recordValue(row)?.product_type ?? '').toUpperCase();
  if (type === 'PERPETUAL_SWAP') return 'perpetual';
  if (type === 'CCY_PAIR') return 'spot';
  if (type === 'FUTURE' || type === 'FUTURES' || type === 'DELIVERY') return 'delivery';
  return inferredMarketType(native) ?? fallback;
}

function marketFor(value: unknown, metadata: WireRecord = {}) {
  const native = instrument(value);
  const contractName = native.endsWith('-PERP') ? native.slice(0, -5) : native;
  const inferredQuote = contractName.endsWith('USDT') ? 'USDT' : contractName.endsWith('USDC') ? 'USDC' : contractName.endsWith('USD') ? 'USD' : null;
  const inferredBase = (inferredQuote ? contractName.slice(0, -inferredQuote.length) : contractName.split(/[-_]/, 1)[0]).replace(/[-_]$/, '');
  return {
    venue: 'cryptocom', nativeSymbol: native, symbol: native,
    base: String(metadata.base ?? inferredBase).toUpperCase(),
    quote: String(metadata.quote ?? inferredQuote ?? (native.includes('USD') ? 'USD' : 'USDT')).toUpperCase(),
    marketType: metadata.marketType ?? inferredMarketType(native) ?? 'perpetual', tickSize: metadata.tickSize ?? null,
    quantityUnit: 'base',
  };
}

function rowValues(values: unknown, field: string, { allowZero = true }: AdapterOptions = {}) {
  if (!Array.isArray(values)) throw new TypeError(`Crypto.com ${field} must be an array`);
  return values.map((row: unknown, index) => {
    if (!Array.isArray(row) || row.length < 2) throw new TypeError(`Crypto.com ${field}[${index}] malformed`);
    const price = finiteNumber(row[0], `${field}[${index}].price`);
    const amount = finiteNumber(row[1], `${field}[${index}].amount`);
    const count = row[2] == null ? undefined : finiteNumber(row[2], `${field}[${index}].count`);
    if (!(price > 0) || amount < 0 || (!allowZero && !(amount > 0)) || (count != null && (!Number.isInteger(count) || count < 0))) throw new TypeError(`Crypto.com ${field}[${index}] out of range`);
    return { price, amount, ...(count == null ? {} : { count }) };
  });
}

function dataRow(payload: unknown) {
  const result = recordValue(payload)?.result ?? payload;
  const data = Array.isArray(recordValue(result)?.data) ? recordValue(result).data : recordValue(result)?.data == null ? result : recordValue(result).data;
  if (Array.isArray(data)) return recordValue(data[0] ?? {});
  if (!data || typeof data !== 'object') throw new TypeError('Crypto.com book data missing');
  return recordValue(data);
}

function commonBook(payload: unknown, { instrumentName = CRYPTOCOM_DEFAULT_INSTRUMENT, depth = CRYPTOCOM_DEFAULT_DEPTH, receivedAt = Date.now(), requireSequence = false }: AdapterOptions = {}) {
  const envelope = assertCryptocom(payload);
  const result = recordValue(envelope)?.result ?? envelope;
  const native = instrument(instrumentName);
  if (recordValue(result)?.instrument_name != null && instrument(recordValue(result).instrument_name) !== native) throw new TypeError('Crypto.com book instrument mismatch');
  if (recordValue(result)?.depth != null && Number(recordValue(result).depth) !== Number(depth)) throw new TypeError('Crypto.com book depth mismatch');
  const row = dataRow(envelope);
  const change = recordValue(row?.update && typeof row.update === 'object' ? row.update : row);
  const seq = sequence(row.u, 'book sequence', { required: requireSequence });
  const previous = sequence(row.pu, 'book previous sequence', { required: false });
  const market = marketFor(native);
  const timestamp = epochMs(row.tt ?? row.t ?? recordValue(recordValue(envelope)?.result)?.tt ?? recordValue(recordValue(envelope)?.result)?.t, receivedAt);
  const bids = rowValues(change.bids, 'bids', { allowZero: true });
  const asks = rowValues(change.asks, 'asks', { allowZero: true });
  return { envelope, row, native, market, seq, previous, timestamp, bids, asks, depth: Number(depth) };
}

export function buildCryptocomRequest(kind: string, { instrumentName = CRYPTOCOM_DEFAULT_INSTRUMENT, depth = CRYPTOCOM_DEFAULT_DEPTH, baseUrl = CRYPTOCOM_REST_URL }: AdapterOptions = {}) {
  if (kind === 'instrument') return { url: `${baseUrl}/public/get-instruments`, method: 'GET', headers: { accept: 'application/json' }, responseClass: 'catalog' };
  if (kind === 'depth') {
    const native = instrument(instrumentName); const boundedDepth = depthValue(depth);
    return { url: `${baseUrl}/public/get-book?instrument_name=${encodeURIComponent(native)}&depth=${boundedDepth}`, method: 'GET', headers: { accept: 'application/json' } };
  }
  throw new RangeError(`Unsupported Crypto.com request: ${kind}`);
}

export function buildCryptocomSubscription(kind: string, { instrumentName = CRYPTOCOM_DEFAULT_INSTRUMENT, depth = CRYPTOCOM_DEFAULT_DEPTH, subscriptionType = CRYPTOCOM_BOOK_SUBSCRIPTION_TYPE, updateFrequency = CRYPTOCOM_DEFAULT_UPDATE_FREQUENCY, id = 1 }: AdapterOptions = {}) {
  if (kind !== 'depth') throw new RangeError(`Unsupported Crypto.com subscription: ${kind}`);
  const native = instrument(instrumentName); const boundedDepth = depthValue(depth);
  if (String(subscriptionType).toUpperCase() !== CRYPTOCOM_BOOK_SUBSCRIPTION_TYPE) throw new RangeError(`Unsupported Crypto.com book subscription type: ${subscriptionType}`);
  const frequency = normalizeUpdateFrequency(updateFrequency);
  const topic = `book.${native}.${boundedDepth}`;
  return {
    url: CRYPTOCOM_PUBLIC_WS_URL, method: 'subscribe', op: 'subscribe', id: Number.isSafeInteger(Number(id)) ? Number(id) : String(id),
    params: { channels: [topic], book_subscription_type: CRYPTOCOM_BOOK_SUBSCRIPTION_TYPE, book_update_frequency: frequency },
    channel: 'book', topic, instrumentName: native, symbol: native, depth: boundedDepth, subscriptionType: CRYPTOCOM_BOOK_SUBSCRIPTION_TYPE, updateFrequency: frequency, snapshot: true,
  };
}

export function normalizeCryptocomInstrument(payload: unknown, { instrumentName = CRYPTOCOM_DEFAULT_INSTRUMENT, marketType = 'perpetual', receivedAt = Date.now() }: AdapterOptions = {}) {
  const envelope = assertCryptocom(payload);
  const rows = recordValue(recordValue(envelope)?.result)?.data ?? recordValue(envelope)?.data ?? (Array.isArray(envelope) ? envelope : []);
  if (!Array.isArray(rows)) throw new TypeError('Crypto.com instrument metadata must be an array');
  const selected = instrument(instrumentName);
  const assets = rows.filter((row: unknown) => typeof recordValue(row).symbol === 'string' && String(recordValue(row).symbol).trim().toUpperCase() === selected).map((row: unknown) => {
    const native = instrument(recordValue(row).symbol ?? selected);
    const tickSize = recordValue(row).price_tick_size == null ? null : finiteNumber(recordValue(row).price_tick_size, 'price_tick_size');
    const lotSize = recordValue(row).qty_tick_size == null ? undefined : finiteNumber(recordValue(row).qty_tick_size, 'qty_tick_size');
    if (tickSize != null && !(tickSize > 0)) throw new TypeError('Crypto.com price_tick_size must be positive');
    if (lotSize != null && !(lotSize > 0)) throw new TypeError('Crypto.com qty_tick_size must be positive');
    const tradable = recordValue(row).tradable == null ? true : recordValue(row).tradable === true || recordValue(row).tradable === 1 || String(recordValue(row).tradable).toLowerCase() === 'true';
    const quantityDecimals = recordValue(row).quantity_decimals == null ? undefined : Math.trunc(finiteNumber(recordValue(row).quantity_decimals, 'quantity_decimals'));
    if (quantityDecimals != null && quantityDecimals < 0) throw new TypeError('Crypto.com quantity_decimals must be non-negative');
    const active = tradable;
    const market = marketFor(native, { base: recordValue(row).base_ccy, quote: recordValue(row).quote_ccy, marketType: marketTypeForInstrument(row, native, marketType), tickSize });
    return {
      instrumentId: instrumentId(native), ...market, venue: 'cryptocom', isDelisted: !active,
      status: active ? 'online' : 'offline', tickSize: market.tickSize, ...(lotSize == null ? {} : { lotSize }),
      quantityDecimals,
      expiryTimestamp: recordValue(row).expiry_timestamp_ms == null ? undefined : epochMs(recordValue(row).expiry_timestamp_ms, null),
      underlyingSymbol: recordValue(row).underlying_symbol, instrumentType: recordValue(row).inst_type ?? recordValue(row).product_type, metadataSource: 'cryptocom-v1-get-instruments',
    };
  });
  return { kind: 'metadata' as const, venue: 'cryptocom', sourceTimestamp: null, receivedAt, assets };
}

export function normalizeCryptocomDepth(payload: unknown, { instrumentName = CRYPTOCOM_DEFAULT_INSTRUMENT, depth = CRYPTOCOM_DEFAULT_DEPTH, channel = null, receivedAt = Date.now() }: AdapterOptions = {}) {
  const selectedDepth = depthValue(depth); const native = instrument(instrumentName);
  const result = recordValue(assertCryptocom(payload))?.result ?? payload;
  if (channel != null && recordValue(result)?.channel != null && String(channel) !== String(recordValue(result).channel)) throw new TypeError('Crypto.com book channel mismatch');
  const wireChannel = channel ?? recordValue(result)?.channel ?? (String(recordValue(result)?.subscription ?? '').startsWith('book.') ? (String(recordValue(result).subscription).split('.')[0] === 'book' ? 'book' : null) : null);
  if (wireChannel != null && !['book', 'book.update'].includes(String(wireChannel))) throw new TypeError(`Crypto.com unsupported book channel: ${wireChannel}`);
  if (wireChannel != null && recordValue(payload)?.method !== 'subscribe') throw new TypeError('Crypto.com book method mismatch');
  const parsed = commonBook(payload, { instrumentName: native, depth: selectedDepth, receivedAt, requireSequence: wireChannel != null });
  if (recordValue(result)?.subscription != null && String(recordValue(result).subscription) !== `book.${native}.${selectedDepth}`) throw new TypeError('Crypto.com book subscription mismatch');
  const isUpdate = String(wireChannel ?? '').toLowerCase() === 'book.update';
  const active = (values: PriceAmount[]) => values.filter(row => row.amount > 0).map(row => [row.price, row.amount]);
  const common = { venue: 'cryptocom', instrumentId: instrumentId(native), nativeSymbol: native, market: parsed.market, units: 'base', sourceTimestamp: parsed.timestamp, receivedAt, sequence: parsed.seq, depth: selectedDepth, continuity: 'provider-ordered', channel: isUpdate ? 'book.update' : 'book' };
  if (isUpdate) return { kind: 'depthDelta' as const, ...common, previousSequence: parsed.previous, bids: sideLevels(parsed.bids.map(row => [row.price, row.amount]), 'bids'), asks: sideLevels(parsed.asks.map(row => [row.price, row.amount]), 'asks') };
  return { kind: 'depthSnapshot' as const, ...common, complete: true, coverage: 'partial' as const, bids: sideLevels(active(parsed.bids), 'bids'), asks: sideLevels(active(parsed.asks), 'asks') };
}

function invalidated(session: CryptocomDepthSession, reason: string): DepthSessionResult<CryptocomDepthSession> {
  const book = session.book ? { ...session.book, complete: false, gap: true, invalidated: true, resyncRequired: true, status: 'resync-required', invalidReason: reason } : null;
  return { session: { ...session, book, status: 'resync-required', invalidated: true, invalidReason: reason }, accepted: false, ignored: false, reason: 'resync-required' };
}

function bookFrom(session: CryptocomDepthSession, update: CryptocomDepthMessage, rows: Map<string, CryptocomBookRow>): AdapterDepthBook {
  const bids = [...rows.values()].filter((row) => row.side === 'bid' && row.amount > 0).sort((a, b) => b.price - a.price).map((row) => [row.price, row.amount]);
  const asks = [...rows.values()].filter((row) => row.side === 'ask' && row.amount > 0).sort((a, b) => a.price - b.price).map((row) => [row.price, row.amount]);
  return { ...update, kind: 'depthSnapshot' as const, complete: true, coverage: 'partial' as const, continuity: 'provider-ordered', status: 'live', gap: false, invalidated: false, resyncRequired: false, bids: sideLevels(bids, 'bids'), asks: sideLevels(asks, 'asks'), channel: 'book' };
}

export function createCryptocomDepthSession({ topic, instrumentId: id, sessionToken, instrumentName = CRYPTOCOM_DEFAULT_INSTRUMENT, depth = CRYPTOCOM_DEFAULT_DEPTH }: AdapterOptions = {}): CryptocomDepthSession {
  if (!topic || !id || !sessionToken) throw new TypeError('Crypto.com depth session topic, instrument, and token are required');
  return { venue: 'cryptocom', topic: String(topic), instrumentId: String(id), sessionToken: String(sessionToken), instrumentName: instrument(instrumentName), depth: depthValue(depth), status: 'awaiting-snapshot', book: null, invalidated: false, lastSequence: null, rows: new Map<string, CryptocomBookRow>() };
}

export function applyCryptocomDepthSessionMessage(session: CryptocomDepthSession, { topic, sessionToken, update }: DepthSessionMessageOptions<CryptocomDepthMessage> = {}): DepthSessionResult<CryptocomDepthSession> {
  if (!session || !update) throw new TypeError('Crypto.com depth session and update are required');
  if (topic !== session.topic) return { session, accepted: false, ignored: true, reason: 'wrong-topic' };
  if (sessionToken !== session.sessionToken) return { session, accepted: false, ignored: true, reason: 'cross-session' };
  if (update.instrumentId !== session.instrumentId) return { session, accepted: false, ignored: true, reason: 'wrong-instrument' };
  if (Number(update.depth) !== Number(session.depth)) return { session, accepted: false, ignored: true, reason: 'wrong-depth' };
  if (update.kind === 'depthSnapshot') {
    const seq = sequence(update.sequence, 'snapshot sequence'); const rows = new Map<string, CryptocomBookRow>();
    for (const row of update.bids ?? []) rows.set(`bid:${String(row.price)}`, { side: 'bid', price: row.price, amount: row.amount });
    for (const row of update.asks ?? []) rows.set(`ask:${String(row.price)}`, { side: 'ask', price: row.price, amount: row.amount });
    const book = bookFrom(session, { ...update, sequence: seq }, rows);
    return { session: { ...session, rows, lastSequence: seq, book, status: 'live', invalidated: false }, accepted: true, ignored: false, reason: null };
  }
  if (update.kind !== 'depthDelta') return { session, accepted: false, ignored: true, reason: 'unsupported-update' };
  if (!session.book || session.status !== 'live' || session.invalidated) return { session, accepted: false, ignored: true, reason: 'fresh-snapshot-required' };
  const seq = sequence(update.sequence, 'delta sequence'); const previous = sequence(update.previousSequence, 'previous sequence');
  if (compareSequence(previous, session.lastSequence) !== 0) return invalidated(session, `Crypto.com depth sequence gap: expected ${session.lastSequence}, got ${previous}`);
  if (compareSequence(seq, session.lastSequence) <= 0) return { session, accepted: false, ignored: true, reason: 'old-or-duplicate' };
  const rows = new Map(session.rows);
  const apply = (values: PriceAmount[], side: string) => { for (const row of values ?? []) { const key = `${side}:${String(row.price)}`; if (row.amount === 0) rows.delete(key); else rows.set(key, { side, price: row.price, amount: row.amount }); } };
  apply(update.bids, 'bid'); apply(update.asks, 'ask');
  const book = bookFrom(session, { ...session.book, ...update, sequence: seq, previousSequence: previous }, rows);
  return { session: { ...session, rows, lastSequence: seq, book, status: 'live', invalidated: false }, accepted: true, ignored: false, reason: null };
}

export function invalidateCryptocomDepthSession(session: CryptocomDepthSession, reason: string = 'disconnect'): CryptocomDepthSession {
  if (!session) throw new TypeError('Crypto.com depth session is required');
  const book = session.book ? { ...session.book, complete: false, gap: true, invalidated: true, resyncRequired: true, status: 'resync-required', invalidReason: String(reason) } : null;
  return { ...session, book, status: 'resync-required', invalidated: true, invalidReason: String(reason) };
}

export class CryptocomConnector {
  networkEnabled: boolean;
  transport: AdapterTransport | null;
  constructor({ transport = null, networkEnabled = false }: AdapterOptions = {}) { this.transport = transport; this.networkEnabled = networkEnabled; }
  async request(kind: string, params: AdapterOptions = {}) { if (!this.networkEnabled || !this.transport?.request) throw new AdapterTransportError('Crypto.com network disabled; inject transport and set networkEnabled=true'); return this.transport.request(buildCryptocomRequest(kind, params)); }
  async subscribe(kind: string, params: AdapterOptions = {}) { if (!this.networkEnabled || !this.transport?.subscribe) throw new AdapterTransportError('Crypto.com network disabled; inject transport and set networkEnabled=true'); return this.transport.subscribe(buildCryptocomSubscription(kind, params)); }
}
