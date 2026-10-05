import { recordValue, type AdapterOptions, type AdapterTransport, type WireRecord, type AdapterDepthBook, type DepthSessionIdentity, type DepthSessionMessageOptions, type DepthSessionResult } from './common.mts';
import { AdapterTransportError, finiteNumber, requireSymbol } from './common.mts';

import type { PriceAmount } from '../domain/contracts.ts';
export type PhemexDepthMessage = ReturnType<typeof normalizePhemexDepth>;
export interface PhemexBookRow extends PriceAmount { side: string; }
export interface PhemexDepthSession extends DepthSessionIdentity { book: AdapterDepthBook | null; rows: Map<string, PhemexBookRow>; lastSequence: number | string | null; }
/** Phemex public spot order-book descriptors and provider-ordered normalizers. */
export const PHEMEX_REST_URL = 'https://api.phemex.com';
// The current public DataGW host is ws.phemex.com. The older phemex.com/ws
// spelling remains in historical documentation but is not used here.
export const PHEMEX_PUBLIC_WS_URL = 'wss://ws.phemex.com';
export const PHEMEX_DEFAULT_SYMBOL = 'sBTCUSDT';
export const PHEMEX_PRICE_SCALE = 8;
export const PHEMEX_RATIO_SCALE = 8;

const QUOTE_SUFFIXES = Object.freeze(['USDT', 'USDC', 'USD', 'BTC', 'ETH']);

function spotSymbol(value: unknown) {
  const native = requireSymbol(value);
  if (!/^S[A-Z0-9]{4,24}$/.test(native)) throw new TypeError('Invalid Phemex spot symbol');
  return `s${native.slice(1)}`;
}

function instrumentId(value: unknown) { return `phemex:${spotSymbol(value)}`; }

function splitSymbol(value: unknown, metadata: WireRecord = {}) {
  const native = spotSymbol(value);
  const withoutPrefix = native.slice(1);
  const quote = String(metadata.quote ?? QUOTE_SUFFIXES.find(item => withoutPrefix.endsWith(item)) ?? '').toUpperCase();
  const base = String(metadata.base ?? (quote ? withoutPrefix.slice(0, -quote.length) : withoutPrefix)).toUpperCase();
  if (!base || !quote) throw new TypeError('Phemex spot metadata must identify base and quote currencies');
  return { base, quote };
}

function marketFor(value: unknown, metadata: WireRecord = {}) {
  const nativeSymbol = spotSymbol(value);
  const { base, quote } = splitSymbol(nativeSymbol, metadata);
  return {
    venue: 'phemex', nativeSymbol, symbol: nativeSymbol, base, quote,
    marketType: 'spot', tickSize: metadata.tickSize ?? null,
    lotSize: metadata.lotSize ?? null, quantityUnit: 'base',
  };
}

function assertPhemex(payload: unknown) {
  if (recordValue(payload)?.error != null) {
    const error = recordValue(payload).error;
    throw new Error(`Phemex provider error: ${recordValue(error)?.message ?? recordValue(error)?.code ?? error}`);
  }
  if (recordValue(payload)?.code != null && Number(recordValue(payload).code) !== 0) throw new Error(`Phemex provider error ${recordValue(payload).code}: ${recordValue(payload).msg ?? 'request failed'}`);
  return payload;
}

function sequence(value: unknown, field: string) {
  if (typeof value === 'number' && !Number.isSafeInteger(value)) throw new TypeError(`Phemex ${field} is unsafe numeric; preserve the provider token as a string`);
  const text = String(value ?? '').trim();
  if (!/^\d+$/.test(text)) throw new TypeError(`Phemex ${field} missing or invalid`);
  const integer = BigInt(text);
  return integer <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(integer) : integer.toString();
}

function timestampNs(value: unknown, fallback: number) {
  if (typeof value === 'number') {
    return Number.isFinite(value) && value >= 0 ? Math.trunc(value / 1_000_000) : fallback;
  }
  const text = String(value ?? '').trim();
  if (!/^\d+(?:\.\d+)?$/.test(text)) return fallback;
  try {
    // Provider timestamps are nanoseconds and may exceed JavaScript's safe
    // integer range.  Truncate the token before converting to epoch
    // milliseconds so a string timestamp cannot round across a millisecond
    // boundary.
    return Number(BigInt(text.split('.', 1)[0]) / 1_000_000n);
  } catch {
    return fallback;
  }
}

function decimalField(value: unknown, field: string) {
  const text = String(value ?? '').trim().match(/^\d+(?:\.\d+)?/);
  if (!text) throw new TypeError(`Phemex ${field} is missing or invalid`);
  const number = Number(text[0]);
  if (!(number > 0) || !Number.isFinite(number)) throw new TypeError(`Phemex ${field} must be positive`);
  return number;
}

function precisionFallback(value: unknown, field: string) {
  const places = Math.trunc(finiteNumber(value, field));
  if (places < 0 || places > 18) throw new RangeError(`Phemex ${field} must be between 0 and 18`);
  return 10 ** -places;
}

function scaledInteger(value: unknown, scale: number | undefined, field: string) {
  const text = String(value ?? '').trim();
  if (!/^-?\d+$/.test(text)) throw new TypeError(`Phemex ${field} is missing or invalid`);
  const number = Number(text);
  if (!Number.isFinite(number)) throw new TypeError(`Phemex ${field} is not finite`);
  return number / (10 ** Number(scale));
}

function depthRows(values: unknown, field: string, { priceScale, ratioScale }: AdapterOptions) {
  if (!Array.isArray(values)) throw new TypeError(`Phemex ${field} must be an array`);
  return values.map((row: unknown, index) => {
    if (!Array.isArray(row) || row.length < 2) throw new TypeError(`Phemex ${field}[${index}] malformed`);
    return {
      price: scaledInteger(row[0], priceScale, `${field}[${index}].priceEp`),
      amount: scaledInteger(row[1], ratioScale, `${field}[${index}].qty`),
    };
  }).filter(row => row.price > 0 && row.amount >= 0);
}

function applyRows(rows: PriceAmount[] | null | undefined, existing: Iterable<readonly [number, number]> | null | undefined, descending: boolean) {
  const next = new Map<number, number>(existing ?? []);
  for (const row of rows ?? []) {
    const price = Number(row?.price); const amount = Number(row?.amount);
    if (!(price > 0) || !Number.isFinite(amount) || amount < 0) continue;
    if (amount === 0) next.delete(price); else next.set(price, amount);
  }
  return [...next].sort((a, b) => descending ? b[0] - a[0] : a[0] - b[0]).map(([price, amount]) => ({ price, amount }));
}

function compareSequence(left: unknown, right: unknown) {
  try {
    const a = BigInt(String(left)); const b = BigInt(String(right));
    return a < b ? -1 : a > b ? 1 : 0;
  } catch { return String(left) < String(right) ? -1 : String(left) > String(right) ? 1 : 0; }
}

export function buildPhemexRequest(kind: string, { symbol = PHEMEX_DEFAULT_SYMBOL, baseUrl = PHEMEX_REST_URL }: AdapterOptions = {}) {
  if (kind === 'products') return { url: `${baseUrl}/public/products`, method: 'GET', headers: { accept: 'application/json' }, responseClass: 'catalog' };
  if (kind === 'depth') return { url: `${baseUrl}/md/orderbook?symbol=${encodeURIComponent(spotSymbol(symbol))}`, method: 'GET', headers: { accept: 'application/json' } };
  throw new RangeError(`Unsupported Phemex request: ${kind}`);
}

export function buildPhemexSubscription(kind: string, { symbol = PHEMEX_DEFAULT_SYMBOL, id = 1, fullDepth = true }: AdapterOptions = {}) {
  if (kind !== 'depth') throw new RangeError(`Unsupported Phemex subscription: ${kind}`);
  const native = spotSymbol(symbol);
  if (fullDepth !== true) throw new RangeError('Phemex bounded packet requires full-depth orderbook subscription');
  const requestId = Number.isSafeInteger(Number(id)) ? Number(id) : String(id);
  return {
    url: PHEMEX_PUBLIC_WS_URL, id: requestId, method: 'orderbook.subscribe',
    params: [native, true], channel: 'orderbook', topic: `orderbook:${native}`,
    symbol: native, args: [native, true], fullDepth: true, snapshot: true,
  };
}

export function normalizePhemexProducts(payload: unknown, { symbol = null, receivedAt = Date.now() }: AdapterOptions = {}) {
  const rows = recordValue(recordValue(assertPhemex(payload))?.data)?.products;
  if (!Array.isArray(rows)) throw new TypeError('Phemex products metadata must be an array');
  const selected = symbol == null ? null : spotSymbol(symbol);
  const assets = rows.filter((row: unknown) => String(recordValue(row)?.type ?? '').toLowerCase() === 'spot' && recordValue(row)?.symbol != null && (selected == null || spotSymbol(recordValue(row).symbol) === selected)).map((row: unknown) => {
    const native = spotSymbol(recordValue(row).symbol);
    const priceScale = recordValue(row).priceScale == null ? PHEMEX_PRICE_SCALE : Math.trunc(finiteNumber(recordValue(row).priceScale, 'priceScale'));
    const ratioScale = recordValue(row).ratioScale == null ? PHEMEX_RATIO_SCALE : Math.trunc(finiteNumber(recordValue(row).ratioScale, 'ratioScale'));
    if (priceScale < 0 || priceScale > 18 || ratioScale < 0 || ratioScale > 18) throw new RangeError('Phemex scale must be between 0 and 18');
    const tickSize = recordValue(row).quoteTickSize == null ? precisionFallback(recordValue(row).pricePrecision ?? 8, 'pricePrecision') : decimalField(recordValue(row).quoteTickSize, 'quoteTickSize');
    const lotSize = recordValue(row).baseTickSize == null ? precisionFallback(recordValue(row).baseQtyPrecision ?? 8, 'baseQtyPrecision') : decimalField(recordValue(row).baseTickSize, 'baseTickSize');
    const { base, quote } = splitSymbol(native, { base: recordValue(row).baseCurrency, quote: recordValue(row).quoteCurrency });
    const listed = String(recordValue(row).status ?? '').toLowerCase() === 'listed';
    return {
      instrumentId: instrumentId(native), venue: 'phemex', nativeSymbol: native, symbol: native,
      base, quote, marketType: 'spot', tickSize, lotSize, quantityUnit: 'base',
      priceScale, ratioScale, isDelisted: !listed, status: listed ? 'online' : 'offline',
      metadataSource: 'phemex-public-products', receivedAt,
    };
  }).filter(asset => !asset.isDelisted);
  return { kind: 'metadata' as const, venue: 'phemex', sourceTimestamp: null, receivedAt, assets };
}

export function normalizePhemexDepth(payload: unknown, { symbol = PHEMEX_DEFAULT_SYMBOL, metadata = {}, receivedAt = Date.now() }: AdapterOptions = {}) {
  const envelope = assertPhemex(payload);
  const result = recordValue(envelope)?.result ?? envelope;
  const native = spotSymbol(symbol);
  if (recordValue(result)?.symbol == null || spotSymbol(recordValue(result).symbol) !== native) throw new TypeError('Phemex depth symbol mismatch');
  const type = String(recordValue(result)?.type ?? '').toLowerCase();
  if (type !== 'snapshot' && type !== 'incremental') throw new TypeError(`Phemex unsupported depth type: ${recordValue(result)?.type ?? '(missing)'}`);
  const book = recordValue(result)?.book;
  if (!book || !Array.isArray(recordValue(book).bids) || !Array.isArray(recordValue(book).asks)) throw new TypeError('Phemex depth book bids/asks missing');
  const priceScale = recordValue(metadata).priceScale == null ? PHEMEX_PRICE_SCALE : Math.trunc(finiteNumber(recordValue(metadata).priceScale, 'priceScale'));
  const ratioScale = recordValue(metadata).ratioScale == null ? PHEMEX_RATIO_SCALE : Math.trunc(finiteNumber(recordValue(metadata).ratioScale, 'ratioScale'));
  const sequenceValue = sequence(recordValue(result).sequence, 'depth sequence');
  const depth = Math.trunc(finiteNumber(recordValue(result).depth, 'depth'));
  // Phemex uses depth=0 to denote the full-depth stream requested by the
  // bounded packet.  Positive values are also valid for provider-limited
  // snapshots, but negative/non-integer values are malformed.
  if (depth < 0) throw new TypeError('Phemex depth must be non-negative');
  const market = marketFor(native, recordValue(metadata));
  const snapshot = type === 'snapshot';
  return {
    kind: snapshot ? 'depthSnapshot' as const : 'depthDelta' as const, venue: 'phemex', instrumentId: instrumentId(native),
    nativeSymbol: native, market, units: 'base', sourceTimestamp: timestampNs(recordValue(result).timestamp, receivedAt), receivedAt,
    sequence: sequenceValue, depth, ...(snapshot ? { complete: true, coverage: 'partial' as const, continuity: 'provider-snapshot' } : { continuity: 'provider-ordered' }),
    bids: depthRows(recordValue(book).bids, 'bids', { priceScale, ratioScale }), asks: depthRows(recordValue(book).asks, 'asks', { priceScale, ratioScale }),
  };
}

function invalidated(session: PhemexDepthSession, reason: string): DepthSessionResult<PhemexDepthSession> {
  const book = session.book ? { ...session.book, complete: false, gap: true, invalidated: true, resyncRequired: true, status: 'resync-required', invalidReason: reason } : null;
  return { session: { ...session, book, status: 'resync-required', invalidated: true, invalidReason: reason }, accepted: false, ignored: false, reason: 'resync-required' };
}

export function createPhemexDepthSession({ topic, instrumentId: id, sessionToken }: AdapterOptions = {}): PhemexDepthSession {
  if (!topic || !id || !sessionToken) throw new TypeError('Phemex depth session topic, instrument, and token are required');
  return { venue: 'phemex', topic: String(topic), instrumentId: String(id), sessionToken: String(sessionToken), status: 'awaiting-snapshot', book: null, rows: new Map<string, PhemexBookRow>(), lastSequence: null, invalidated: false };
}

export function applyPhemexDepthSessionMessage(session: PhemexDepthSession, { topic, sessionToken, update }: DepthSessionMessageOptions<PhemexDepthMessage> = {}): DepthSessionResult<PhemexDepthSession> {
  if (!session || !update) throw new TypeError('Phemex depth session and update are required');
  if (topic !== session.topic) return { session, accepted: false, ignored: true, reason: 'wrong-topic' };
  if (sessionToken !== session.sessionToken) return { session, accepted: false, ignored: true, reason: 'cross-session' };
  if (update.instrumentId !== session.instrumentId) return { session, accepted: false, ignored: true, reason: 'wrong-instrument' };
  const nextSequence = sequence(update.sequence, 'depth sequence');
  if (update.kind === 'depthSnapshot') {
    const rows = new Map<string, PhemexBookRow>();
    for (const row of update.bids ?? []) rows.set(`bid:${String(row.price)}`, { side: 'bid', price: row.price, amount: row.amount });
    for (const row of update.asks ?? []) rows.set(`ask:${String(row.price)}`, { side: 'ask', price: row.price, amount: row.amount });
    const book = { ...update, kind: 'depthSnapshot' as const, sequence: nextSequence, complete: true, gap: false, invalidated: false, resyncRequired: false, continuity: 'provider-snapshot', status: 'live', bids: applyRows(update.bids, [], true), asks: applyRows(update.asks, [], false) };
    return { session: { ...session, rows, lastSequence: nextSequence, book, status: 'live', invalidated: false }, accepted: true, ignored: false, reason: null };
  }
  if (update.kind !== 'depthDelta') return { session, accepted: false, ignored: true, reason: 'unsupported-update' };
  if (!session.book || session.status !== 'live' || session.invalidated) return { session, accepted: false, ignored: true, reason: 'fresh-snapshot-required' };
  const ordering = compareSequence(nextSequence, session.lastSequence);
  if (ordering === 0) return { session, accepted: false, ignored: true, reason: 'old-or-duplicate' };
  if (ordering < 0) return invalidated(session, 'Phemex depth sequence rewind');
  const rows = new Map(session.rows);
  const apply = (values: PriceAmount[], side: string) => { for (const row of values ?? []) { const key = `${side}:${String(row.price)}`; if (row.amount === 0) rows.delete(key); else rows.set(key, { side, price: row.price, amount: row.amount }); } };
  apply(update.bids, 'bid'); apply(update.asks, 'ask');
  const bids = [...rows.values()].filter(row => row.side === 'bid').map(row => [row.price, row.amount]);
  const asks = [...rows.values()].filter(row => row.side === 'ask').map(row => [row.price, row.amount]);
  const book = { ...session.book, ...update, kind: 'depthSnapshot' as const, sequence: nextSequence, complete: true, gap: false, invalidated: false, resyncRequired: false, continuity: 'provider-ordered', status: 'live', bids: applyRows(bids.map(row => ({ price: row[0], amount: row[1] })), [], true), asks: applyRows(asks.map(row => ({ price: row[0], amount: row[1] })), [], false) };
  return { session: { ...session, rows, lastSequence: nextSequence, book, status: 'live', invalidated: false }, accepted: true, ignored: false, reason: null };
}

export function invalidatePhemexDepthSession(session: PhemexDepthSession, reason: string = 'disconnect'): PhemexDepthSession {
  if (!session) throw new TypeError('Phemex depth session is required');
  const book = session.book ? { ...session.book, complete: false, gap: true, invalidated: true, resyncRequired: true, status: 'resync-required', invalidReason: String(reason) } : null;
  return { ...session, book, status: 'resync-required', invalidated: true, invalidReason: String(reason) };
}

export class PhemexConnector {
  networkEnabled: boolean;
  transport: AdapterTransport | null;
  constructor({ transport = null, networkEnabled = false }: AdapterOptions = {}) { this.transport = transport; this.networkEnabled = networkEnabled; }
  async request(kind: string, params: AdapterOptions = {}) { if (!this.networkEnabled || !this.transport?.request) throw new AdapterTransportError('Phemex network disabled; inject transport and set networkEnabled=true'); return this.transport.request(buildPhemexRequest(kind, params)); }
  async subscribe(kind: string, params: AdapterOptions = {}) { if (!this.networkEnabled || !this.transport?.subscribe) throw new AdapterTransportError('Phemex network disabled; inject transport and set networkEnabled=true'); return this.transport.subscribe(buildPhemexSubscription(kind, params)); }
}
