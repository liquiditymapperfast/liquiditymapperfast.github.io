import { recordValue, arrayValue, type AdapterOptions, type AdapterTransport, type WireRecord, type AdapterDepthBook, type DepthSessionIdentity, type DepthSessionMessageOptions, type DepthSessionResult } from './common.mts';
import { AdapterTransportError, epochMs, finiteNumber, sideLevels } from './common.mts';

export interface KrakenRawLevel { price: string; qty: string; numericPrice: number; numericQty: number; }
export type KrakenDepthMessage = ReturnType<typeof normalizeKrakenDepth>;
export interface KrakenDepthSession extends DepthSessionIdentity { depth: number; book: AdapterDepthBook | null; bids: Map<string, KrakenRawLevel>; asks: Map<string, KrakenRawLevel>; }
/** Kraken spot WebSocket v2 book descriptors, checksum helpers, and sessions. */
export const KRAKEN_REST_URL = 'https://api.kraken.com/0/public';
export const KRAKEN_PUBLIC_WS_URL = 'wss://ws.kraken.com/v2';

function symbol(value: unknown) {
  const text = String(value ?? '').trim().toUpperCase().replaceAll('-', '/');
  if (!/^[A-Z0-9._:]+\/[A-Z0-9._:]+$/.test(text)) throw new TypeError('Invalid Kraken symbol');
  return text;
}
export function krakenWebSocketSymbol(value: unknown): string {
  return symbol(value).split('/').map(part => part === 'XBT' ? 'BTC' : part).join('/');
}
function instrumentId(value: unknown) { return `kraken:${symbol(value)}`; }
function marketFor(value: unknown, metadata: WireRecord = {}) {
  const nativeSymbol = symbol(value); const [base, quote = 'USD'] = nativeSymbol.split('/');
  return { venue: 'kraken', nativeSymbol, symbol: nativeSymbol, base: String(metadata.base ?? base).toUpperCase(), quote: String(metadata.quote ?? quote).toUpperCase(), marketType: 'spot', tickSize: metadata.tickSize ?? null, quantityUnit: 'base' };
}

function assertPublic(payload: unknown) {
  const errors = Array.isArray(recordValue(payload)?.error) ? recordValue(payload).error : [];
  if (arrayValue(errors).length) throw new Error(`Kraken provider error: ${arrayValue(errors).join('; ')}`);
  return payload;
}

function decimalText(value: unknown, field: string) {
  const text = String(value ?? '').trim();
  if (!/^\d+(?:\.\d+)?$/.test(text)) throw new TypeError(`Invalid Kraken ${field}`);
  return text;
}

function canonicalDecimal(value: unknown, field: string) {
  const text = decimalText(value, field); const [whole, fraction = ''] = text.split('.');
  const normalizedWhole = whole.replace(/^0+(?=\d)/, '') || '0';
  const normalizedFraction = fraction.replace(/0+$/, '');
  return normalizedFraction ? `${normalizedWhole}.${normalizedFraction}` : normalizedWhole;
}

function rawLevels(values: unknown, field: string) {
  if (!Array.isArray(values)) throw new TypeError(`Kraken ${field} must be an array`);
  return values.map((row: unknown, index) => {
    if (!row || typeof row !== 'object') throw new TypeError(`Kraken ${field}[${index}] malformed`);
    const price = decimalText(recordValue(row).price, `${field}[${index}].price`);
    const qty = decimalText(recordValue(row).qty, `${field}[${index}].qty`);
    const numericPrice = finiteNumber(price, `${field}[${index}].price`);
    const numericQty = finiteNumber(qty, `${field}[${index}].qty`);
    if (!(numericPrice > 0) || numericQty < 0) throw new TypeError(`Kraken ${field}[${index}] out of range`);
    return { price, qty, numericPrice, numericQty };
  });
}

function checksumPart(value: unknown) {
  const text = decimalText(value, 'checksum value');
  return text.replace('.', '').replace(/^0+/, '') || '0';
}

const CRC_TABLE = Object.freeze(Array.from({ length: 256 }, (_, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit += 1) value = (value & 1) ? (value >>> 1) ^ 0xEDB88320 : value >>> 1;
  return value >>> 0;
}));

export function krakenCrc32(value: unknown) {
  let crc = 0xFFFFFFFF;
  for (const byte of new TextEncoder().encode(String(value))) crc = (crc >>> 8) ^ CRC_TABLE[(crc ^ byte) & 0xFF];
  return (crc ^ 0xFFFFFFFF) >>> 0;
}

export function krakenBookChecksum({ bids = [], asks = [] }: AdapterOptions = {}) {
  const normalize = (row: unknown) => Array.isArray(row) ? { price: row[0], qty: row[1], numericPrice: Number(row[0]) } : row;
  const active = (rows: unknown) => [...arrayValue(rows)].map(normalize).filter((row: unknown) => Number(recordValue(row).numericQty ?? recordValue(row).qty ?? recordValue(row).amount) > 0);
  const askText = active(asks).sort((a: unknown, b: unknown) => Number(recordValue(a).numericPrice ?? recordValue(a).price) - Number(recordValue(b).numericPrice ?? recordValue(b).price)).slice(0, 10).map((row: unknown) => `${checksumPart(recordValue(row).price)}${checksumPart(recordValue(row).qty ?? recordValue(row).amount)}`).join('');
  const bidText = active(bids).sort((a: unknown, b: unknown) => Number(recordValue(b).numericPrice ?? recordValue(b).price) - Number(recordValue(a).numericPrice ?? recordValue(a).price)).slice(0, 10).map((row: unknown) => `${checksumPart(recordValue(row).price)}${checksumPart(recordValue(row).qty ?? recordValue(row).amount)}`).join('');
  return krakenCrc32(`${askText}${bidText}`);
}

function decimalPower(decimals: unknown, field: string) {
  const places = Math.trunc(finiteNumber(decimals, field));
  if (places < 0 || places > 18) throw new RangeError(`Invalid Kraken ${field}`);
  return Number((10 ** -places).toPrecision(15));
}

function assertChecksum(payloadChecksum: unknown, levels: AdapterOptions) {
  if (!Number.isSafeInteger(Number(payloadChecksum)) || Number(payloadChecksum) < 0) throw new TypeError('Kraken checksum missing or invalid');
  const expected = krakenBookChecksum(levels);
  if (expected !== Number(payloadChecksum)) throw new Error(`Kraken checksum mismatch: expected ${expected}, received ${payloadChecksum}`);
  return Number(payloadChecksum);
}

/** Numeric price/qty source tokens must survive JSON decoding for CRC32.
 * Node >=22.5 is the declared runtime; missing source-token support fails closed. */
export function parseKrakenBookJson(text: string): unknown {
  const parsed: unknown = JSON.parse(text, (key: string, value: unknown, context?: { source?: unknown }): unknown => {
    if ((key === 'price' || key === 'qty') && typeof value === 'number') {
      if (typeof context?.source !== 'string') throw new TypeError('Kraken numeric JSON source token unavailable; lossless decoding is required');
      return context.source;
    }
    return value;
  });
  return parsed;
}
function krakenSourceTimestamp(value: unknown): number | null {
  if (value == null) return null;
  if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/.test(value)) {
    const timestamp = Date.parse(value);
    if (Number.isFinite(timestamp)) return timestamp;
  } else if (typeof value === 'number' && Number.isFinite(value) && value >= 0) return epochMs(value, null);
  throw new TypeError('Kraken book timestamp missing or invalid');
}

export function buildKrakenRequest(kind: string, { symbol: pair = 'BTC/USD', count = 100, baseUrl = KRAKEN_REST_URL }: AdapterOptions = {}) {
  const native = symbol(pair);
  if (kind === 'assetPairs') return { url: `${baseUrl}/AssetPairs`, method: 'GET', headers: { accept: 'application/json' }, responseClass: 'catalog' };
  if (kind === 'depth') {
    const limit = Math.max(1, Math.min(500, Math.trunc(finiteNumber(count, 'count'))));
    return { url: `${baseUrl}/Depth?pair=${encodeURIComponent(native)}&count=${limit}`, method: 'GET', headers: { accept: 'application/json' } };
  }
  throw new RangeError(`Unsupported Kraken request: ${kind}`);
}

export function buildKrakenSubscription(kind: string, { symbol: pair = 'BTC/USD', depth = 100, snapshot = true }: AdapterOptions = {}) {
  if (kind !== 'depth') throw new RangeError(`Unsupported Kraken subscription: ${kind}`);
  const native = krakenWebSocketSymbol(pair); const boundedDepth = Math.trunc(finiteNumber(depth, 'depth'));
  if (![10, 25, 100, 500, 1_000].includes(boundedDepth)) throw new RangeError(`Unsupported Kraken book depth: ${depth}`);
  return { url: KRAKEN_PUBLIC_WS_URL, method: 'subscribe', channel: 'book', symbol: native, depth: boundedDepth, snapshot: Boolean(snapshot), args: [native], topic: `book:${native}` };
}

export function normalizeKrakenAssetPairs(payload: unknown, { receivedAt = Date.now(), websocketVersion = 1 }: AdapterOptions & { websocketVersion?: 1 | 2 } = {}) {
  const rows = Object.values(recordValue(assertPublic(payload))?.result ?? {});
  if (!Array.isArray(rows)) throw new TypeError('Kraken AssetPairs result must be an object');
  const assets = rows.map((row: unknown) => {
    const restNative = recordValue(row)?.wsname ?? recordValue(row)?.altname;
    if (!restNative) return null;
    // Kraken documents BTC instead of XBT on WebSocket v2. Preserve the
    // REST name separately; do not infer a market from a price ticker.
    const native = websocketVersion === 2 ? krakenWebSocketSymbol(restNative) : restNative;
    const [base, quote] = symbol(native).split('/');
    const market = marketFor(native, { base: websocketVersion === 2 ? base : recordValue(row).base, quote: websocketVersion === 2 ? quote : recordValue(row).quote, tickSize: recordValue(row).pair_decimals == null ? undefined : decimalPower(recordValue(row).pair_decimals, 'pair_decimals') });
    const status = String(recordValue(row)?.status ?? 'online').toLowerCase();
    return { instrumentId: instrumentId(native), ...market, venue: 'kraken', isDelisted: status !== 'online', status, tickSize: market.tickSize, lotSize: recordValue(row).lot_decimals == null ? undefined : decimalPower(recordValue(row).lot_decimals, 'lot_decimals'), metadataSource: 'kraken-asset-pairs', ...(websocketVersion === 2 ? { restNativeSymbol: String(restNative), websocketVersion } : {}) };
  }).filter((item): item is NonNullable<typeof item> => Boolean(item));
  return { kind: 'metadata' as const, venue: 'kraken', sourceTimestamp: null, receivedAt, assets };
}

export function normalizeKrakenDepth(payload: unknown, { symbol: pair, receivedAt = Date.now() }: AdapterOptions = {}) {
  const envelope = assertPublic(payload); const row = recordValue(Array.isArray(recordValue(envelope)?.data) ? arrayValue(recordValue(envelope).data)[0] : recordValue(envelope)?.data);
  if (!row) throw new TypeError('Kraken book data missing');
  const native = symbol(pair ?? row.symbol); if (row.symbol != null && symbol(row.symbol) !== native) throw new TypeError('Kraken book symbol mismatch');
  const type = String(recordValue(envelope)?.type ?? '').toLowerCase(); if (!['snapshot', 'update'].includes(type)) throw new TypeError(`Kraken book type unsupported: ${type}`);
  const bids = rawLevels(row.bids ?? [], 'bids'); const asks = rawLevels(row.asks ?? [], 'asks');
  const checksum = type === 'snapshot' ? assertChecksum(row.checksum, { bids, asks }) : Number(row.checksum);
  if (!Number.isSafeInteger(checksum) || checksum < 0) throw new TypeError('Kraken checksum missing or invalid');
  const market = marketFor(native);
  const common = { venue: 'kraken', instrumentId: instrumentId(native), nativeSymbol: native, market, units: 'base', sourceTimestamp: krakenSourceTimestamp(row.timestamp), receivedAt, checksum, checksumLevels: { bids, asks }, continuity: type === 'snapshot' ? 'checksum-verified' : 'checksum-pending' };
  if (type === 'snapshot') return { kind: 'depthSnapshot' as const, ...common, complete: true, coverage: 'partial' as const, bids: sideLevels(bids.map(level => [level.price, level.qty]), 'bids'), asks: sideLevels(asks.map(level => [level.price, level.qty]), 'asks') };
  return { kind: 'depthDelta' as const, ...common, bids: sideLevels(bids.map(level => [level.price, level.qty]), 'bids'), asks: sideLevels(asks.map(level => [level.price, level.qty]), 'asks') };
}

function levelMap(rows: KrakenRawLevel[] = []) {
  return new Map(arrayValue(rows).map((row) => [canonicalDecimal(row.price, 'price'), { price: row.price, qty: row.qty, numericPrice: row.numericPrice, numericQty: row.numericQty }]));
}

function applyRawRows(target: Map<string, KrakenRawLevel>, rows: KrakenRawLevel[] = []) {
  for (const row of rows) {
    const key = canonicalDecimal(row.price, 'price');
    if (row.numericQty === 0) target.delete(key); else target.set(key, row);
  }
}

function pruneMap(target: Map<string, KrakenRawLevel>, descending: boolean, depth: number) {
  const retained = [...target.values()]
    .sort((a, b) => descending ? b.numericPrice - a.numericPrice : a.numericPrice - b.numericPrice)
    .slice(0, depth);
  const keep = new Set(retained.map((row) => canonicalDecimal(row.price, 'price')));
  for (const key of target.keys()) if (!keep.has(key)) target.delete(key);
}

function sortedOutput(map: Map<string, KrakenRawLevel>, descending: boolean, depth: number) {
  return [...map.values()].sort((a, b) => descending ? b.numericPrice - a.numericPrice : a.numericPrice - b.numericPrice).slice(0, depth).map((row) => ({ price: row.numericPrice, amount: row.numericQty }));
}

function invalidated(session: KrakenDepthSession, reason: string): DepthSessionResult<KrakenDepthSession> {
  const book = session.book ? { ...session.book, complete: false, gap: true, invalidated: true, resyncRequired: true, status: 'resync-required', invalidReason: reason } : null;
  return { session: { ...session, book, status: 'resync-required', invalidated: true, invalidReason: reason }, accepted: false, ignored: false, reason: 'resync-required' };
}

export function createKrakenDepthSession({ topic, instrumentId: id, sessionToken, depth = 100 }: AdapterOptions = {}): KrakenDepthSession {
  if (!topic || !id || !sessionToken) throw new TypeError('Kraken depth session topic, instrument, and token are required');
  return { venue: 'kraken', topic: String(topic), instrumentId: String(id), sessionToken: String(sessionToken), depth: Math.max(10, Math.min(1_000, Math.trunc(Number(depth) || 100))), status: 'awaiting-snapshot', book: null, invalidated: false, bids: new Map<string, KrakenRawLevel>(), asks: new Map<string, KrakenRawLevel>() };
}

export function applyKrakenDepthSessionMessage(session: KrakenDepthSession, { topic, sessionToken, update }: DepthSessionMessageOptions<KrakenDepthMessage> = {}): DepthSessionResult<KrakenDepthSession> {
  if (!session || !update) throw new TypeError('Kraken depth session and update are required');
  if (topic !== session.topic) return { session, accepted: false, ignored: true, reason: 'wrong-topic' };
  if (sessionToken !== session.sessionToken) return { session, accepted: false, ignored: true, reason: 'cross-session' };
  if (update.instrumentId !== session.instrumentId) return { session, accepted: false, ignored: true, reason: 'wrong-instrument' };
  const levels = update.checksumLevels; if (!levels || !Array.isArray(levels.bids) || !Array.isArray(levels.asks)) throw new TypeError('Kraken checksum levels missing');
  const isSnapshot = update.kind === 'depthSnapshot'; const isUpdate = update.kind === 'depthDelta';
  if (!isSnapshot && !isUpdate) throw new TypeError('unsupported Kraken depth update');
  if (isUpdate && (!session.book || session.status !== 'live' || session.invalidated)) return { session, accepted: false, ignored: true, reason: 'fresh-snapshot-required' };
  const bids = isSnapshot ? levelMap(levels.bids) : new Map(session.bids); const asks = isSnapshot ? levelMap(levels.asks) : new Map(session.asks);
  if (isUpdate) { applyRawRows(bids, levels.bids); applyRawRows(asks, levels.asks); }
  pruneMap(bids, true, session.depth); pruneMap(asks, false, session.depth);
  const calculated = krakenBookChecksum({ bids: [...bids.values()], asks: [...asks.values()] });
  if (calculated !== update.checksum) return invalidated(session, `Kraken checksum mismatch: expected ${calculated}, received ${update.checksum}`);
  // The session's whole book goes downstream, so it is labelled a snapshot even when an update produced it: the runtime state replaces a
  // snapshot but merges a delta, and merging a full book never removes a level that has left it (the book grew and crossed within minutes).
  const nextBook = { ...update, kind: 'depthSnapshot' as const, coverage: 'partial' as const, checksum: calculated, checksumVerified: true, checksumLevels: undefined, sequence: undefined, complete: true, gap: false, invalidated: false, resyncRequired: false, continuity: 'checksum-verified', status: 'live', bids: sortedOutput(bids, true, session.depth), asks: sortedOutput(asks, false, session.depth) };
  return { session: { ...session, bids, asks, book: nextBook, status: 'live', invalidated: false }, accepted: true, ignored: false, reason: null };
}

export class KrakenConnector {
  networkEnabled: boolean;
  transport: AdapterTransport | null;
  constructor({ transport = null, networkEnabled = false }: AdapterOptions = {}) { this.transport = transport; this.networkEnabled = networkEnabled; }
  async request(kind: string, params: AdapterOptions = {}) { if (!this.networkEnabled || !this.transport?.request) throw new AdapterTransportError('Kraken network disabled; inject transport and set networkEnabled=true'); return this.transport.request(buildKrakenRequest(kind, params)); }
  async subscribe(kind: string, params: AdapterOptions = {}) { if (!this.networkEnabled || !this.transport?.subscribe) throw new AdapterTransportError('Kraken network disabled; inject transport and set networkEnabled=true'); return this.transport.subscribe(buildKrakenSubscription(kind, params)); }
}
