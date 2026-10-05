import { recordValue, arrayValue, type AdapterOptions, type AdapterTransport, type WireRecord, type AdapterDepthBook, type DepthSessionIdentity, type DepthSessionMessageOptions, type DepthSessionResult } from './common.mts';
import { AdapterTransportError, finiteNumber, requireSymbol, sideLevels } from './common.mts';

export interface BitfinexRow { price: number; count: number; amount: number; priceText?: string; amountText?: string; side?: 'bid' | 'ask'; }
export type BitfinexDepthMessage = ReturnType<typeof normalizeBitfinexDepth> & { checksum?: number };
export interface BitfinexDepthSession extends DepthSessionIdentity { channelId: number | null; book: AdapterDepthBook | null; bids: Map<string, BitfinexRow>; asks: Map<string, BitfinexRow>; }
/** Bitfinex public v2 spot book descriptors, checksum helpers, and sessions. */
export const BITFINEX_REST_URL = 'https://api-pub.bitfinex.com';
export const BITFINEX_METADATA_URL = 'https://api.bitfinex.com';
export const BITFINEX_PUBLIC_WS_URL = 'wss://api-pub.bitfinex.com/ws/2';
export const BITFINEX_CHECKSUM_FLAG = 131072;

function pair(value: unknown) {
  const text = requireSymbol(value).replaceAll('/', '').replaceAll('-', '').replaceAll('_', '');
  const normalized = text.startsWith('T') ? text.slice(1) : text;
  if (!/^[A-Z0-9]{4,20}$/.test(normalized)) throw new TypeError('Invalid Bitfinex trading pair');
  return `t${normalized}`;
}

function pairKey(value: unknown) { return pair(value).slice(1); }
function instrumentId(value: unknown) { return `bitfinex:${pairKey(value)}`; }

function splitPair(value: unknown, metadata: WireRecord = {}) {
  const native = pairKey(value);
  const quote = String(metadata.quote ?? ['USDT', 'USD', 'UST', 'EUR', 'JPY', 'GBP', 'BTC', 'ETH'].find(candidate => native.endsWith(candidate)) ?? 'USD').toUpperCase();
  const base = String(metadata.base ?? (native.endsWith(quote) ? native.slice(0, -quote.length) : native)).toUpperCase();
  return { base: base || native, quote };
}

function marketFor(value: unknown, metadata: WireRecord = {}) {
  const nativeSymbol = pair(value); const { base, quote } = splitPair(nativeSymbol, metadata);
  return { venue: 'bitfinex', nativeSymbol, symbol: pairKey(nativeSymbol), base, quote, marketType: 'spot', tickSize: metadata.tickSize ?? null, quantityUnit: 'base' };
}

function assertBitfinex(payload: unknown) {
  if (recordValue(payload)?.event === 'error' || recordValue(payload)?.error) throw new Error(`Bitfinex provider error: ${recordValue(payload)?.msg ?? recordValue(payload)?.error ?? 'request failed'}`);
  return payload;
}

function rows(values: unknown, field: string): BitfinexRow[] {
  if (!Array.isArray(values)) throw new TypeError(`Bitfinex ${field} must be an array`);
  return values.map((row: unknown, index) => {
    if (!Array.isArray(row) || row.length < 3) throw new TypeError(`Bitfinex ${field}[${index}] malformed`);
    const price = finiteNumber(row[0], `${field}[${index}].price`);
    const count = finiteNumber(row[1], `${field}[${index}].count`);
    const amount = finiteNumber(row[2], `${field}[${index}].amount`);
    if (!(price > 0) || !Number.isInteger(count) || count < 0 || amount === 0) throw new TypeError(`Bitfinex ${field}[${index}] out of range`);
    return { price, count, amount, priceText: String(row[0]), amountText: String(row[2]) };
  });
}

function activeRows(values: BitfinexRow[]) {
  return arrayValue(values).filter((row) => row.count > 0).map((row) => ({ ...row, side: row.amount > 0 ? 'bid' as const : 'ask' as const }));
}

function outputRows(values: BitfinexRow[], side: string) {
  return arrayValue(values).filter((row) => row.side === side && row.count > 0).map((row) => [row.price, Math.abs(row.amount)]);
}

const CRC_TABLE = Object.freeze(Array.from({ length: 256 }, (_, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit += 1) value = (value & 1) ? (value >>> 1) ^ 0xEDB88320 : value >>> 1;
  return value >>> 0;
}));

export function bitfinexCrc32(value: unknown) {
  let crc = 0xFFFFFFFF;
  for (const byte of new TextEncoder().encode(String(value))) crc = (crc >>> 8) ^ CRC_TABLE[(crc ^ byte) & 0xFF];
  return (crc ^ 0xFFFFFFFF) | 0;
}

/** Calculate Bitfinex's signed CRC32 over the top 25 bids/asks. */
export function bitfinexBookChecksum({ bids = [], asks = [] }: AdapterOptions = {}) {
  const normalize = (row: unknown) => Array.isArray(row)
    ? { price: Number(row[0]), amount: Number(row[2] ?? row[1]), priceText: String(row[0]), amountText: String(row[2] ?? row[1]) }
    : recordValue(row);
  const bidRows = arrayValue(bids).map(normalize).sort((a: unknown, b: unknown) => Number(recordValue(b).price) - Number(recordValue(a).price)).slice(0, 25);
  const askRows = arrayValue(asks).map(normalize).sort((a: unknown, b: unknown) => Number(recordValue(a).price) - Number(recordValue(b).price)).slice(0, 25);
  const parts = [];
  for (let index = 0; index < 25; index += 1) {
    const bid = bidRows[index]; const ask = askRows[index];
    if (bid) parts.push(recordValue(bid).priceText ?? String(recordValue(bid).price), recordValue(bid).amountText ?? String(recordValue(bid).amount));
    if (ask) parts.push(recordValue(ask).priceText ?? String(recordValue(ask).price), recordValue(ask).amountText ?? String(recordValue(ask).amount));
  }
  return bitfinexCrc32(parts.join(':'));
}

export function buildBitfinexRequest(kind: string, { symbol = 'BTCUSD', precision = 'P0', len = 25, baseUrl = null }: AdapterOptions = {}) {
  const native = pair(symbol);
  if (kind === 'symbolsDetails') return { url: `${baseUrl ?? BITFINEX_METADATA_URL}/v1/symbols_details`, method: 'GET', headers: { accept: 'application/json' }, responseClass: 'catalog' };
  if (kind === 'book') {
    const prec = String(precision).toUpperCase();
    if (!['P0', 'P1', 'P2', 'P3', 'P4', 'R0'].includes(prec)) throw new RangeError(`Unsupported Bitfinex book precision: ${precision}`);
    const length = Math.trunc(finiteNumber(len, 'len'));
    if (![1, 25, 100, 250].includes(length)) throw new RangeError(`Unsupported Bitfinex book length: ${len}`);
    return { url: `${baseUrl ?? BITFINEX_REST_URL}/v2/book/${encodeURIComponent(native)}/${prec}?len=${length}`, method: 'GET', headers: { accept: 'application/json' } };
  }
  throw new RangeError(`Unsupported Bitfinex request: ${kind}`);
}

export function buildBitfinexSubscription(kind: string, { symbol = 'BTCUSD', precision = 'P0', frequency = 'F0', len = 25, subId = null }: AdapterOptions = {}) {
  if (kind !== 'depth') throw new RangeError(`Unsupported Bitfinex subscription: ${kind}`);
  const native = pair(symbol); const prec = String(precision).toUpperCase();
  if (!['P0', 'P1', 'P2', 'P3', 'P4'].includes(prec)) throw new RangeError(`Unsupported Bitfinex book precision: ${precision}`);
  const length = Math.trunc(finiteNumber(len, 'len'));
  if (![1, 25, 100, 250].includes(length)) throw new RangeError(`Unsupported Bitfinex book length: ${len}`);
  const id = subId == null ? `bitfinex-${pairKey(native)}` : String(subId);
  return {
    url: BITFINEX_PUBLIC_WS_URL, method: 'subscribe', channel: 'book', symbol: native,
    precision: prec, frequency: String(frequency), len: String(length), subId: id,
    topic: `book:${native}`, args: [native], snapshot: true,
    conf: { event: 'conf', flags: BITFINEX_CHECKSUM_FLAG },
  };
}

export function normalizeBitfinexSymbolsDetails(payload: unknown, { receivedAt = Date.now() }: AdapterOptions = {}) {
  const list = assertBitfinex(payload);
  if (!Array.isArray(list)) throw new TypeError('Bitfinex symbols details must be an array');
  const assets = list.map((row: unknown) => {
    if (!recordValue(row)?.pair) return null;
    let native;
    try { native = pair(recordValue(row).pair); } catch { return null; }
    const market = marketFor(native, { base: recordValue(row).base, quote: recordValue(row).quote });
    const minimum = recordValue(row).minimum_order_size == null ? undefined : finiteNumber(recordValue(row).minimum_order_size, 'minimum_order_size');
    return {
      instrumentId: instrumentId(native), ...market, venue: 'bitfinex',
      pricePrecision: recordValue(row).price_precision == null ? undefined : Math.trunc(finiteNumber(recordValue(row).price_precision, 'price_precision')),
      lotSize: minimum, minimumOrderSize: minimum, status: 'online', isDelisted: false,
      metadataSource: 'bitfinex-v1-symbols-details',
    };
  }).filter((item): item is NonNullable<typeof item> => Boolean(item));
  return { kind: 'metadata' as const, venue: 'bitfinex', sourceTimestamp: null, receivedAt, assets };
}

export function normalizeBitfinexDepth(payload: unknown, { symbol = 'BTCUSD', channelId = null, receivedAt = Date.now() }: AdapterOptions = {}) {
  if (!Array.isArray(payload) || payload.length < 2) throw new TypeError('Bitfinex book frame must be an array');
  const wireChannel = Number(payload[0]);
  if (!Number.isSafeInteger(wireChannel) || wireChannel < 0) throw new TypeError('Bitfinex channel id missing or invalid');
  if (channelId != null && Number(channelId) !== wireChannel) throw new TypeError('Bitfinex channel mismatch');
  const body = payload[1]; const native = pair(symbol); const common = { venue: 'bitfinex', instrumentId: instrumentId(native), nativeSymbol: native, market: marketFor(native), units: 'base', sourceTimestamp: null, receivedAt, channelId: wireChannel };
  if (body === 'hb') return { kind: 'heartbeat' as const, ...common };
  if (body === 'cs') {
    const checksum = Number(payload[2]);
    if (!Number.isSafeInteger(checksum)) throw new TypeError('Bitfinex checksum missing or invalid');
    return { kind: 'depthChecksum' as const, ...common, checksum };
  }
  if (Array.isArray(body) && body.length >= 3 && !Array.isArray(body[0])) {
    const level = rows([body], 'update')[0];
    level.side = level.amount > 0 ? 'bid' : 'ask';
    const isBid = level.side === 'bid';
    return { kind: 'depthDelta' as const, ...common, continuity: 'checksum-pending', checksumLevels: [level], bids: isBid ? sideLevels([[level.price, Math.abs(level.amount)]], 'bids') : [], asks: isBid ? [] : sideLevels([[level.price, Math.abs(level.amount)]], 'asks') };
  }
  if (!Array.isArray(body)) throw new TypeError('Bitfinex book payload missing');
  const levels = activeRows(rows(body, 'snapshot'));
  return { kind: 'depthSnapshot' as const, ...common, complete: true, coverage: 'partial' as const, continuity: 'checksum-pending', checksumLevels: levels, bids: sideLevels(outputRows(levels, 'bid'), 'bids'), asks: sideLevels(outputRows(levels, 'ask'), 'asks') };
}

function mapRows(values: BitfinexRow[] = []) {
  return new Map(arrayValue(values).filter((row) => row.count > 0).map((row) => [`${row.priceText ?? row.price}`, row]));
}

function applyRows(target: Map<string, BitfinexRow>, values: BitfinexRow[] = []) {
  for (const row of values) {
    const key = `${row.priceText ?? row.price}`;
    if (row.count === 0) target.delete(key); else target.set(key, row);
  }
}

function bookRows(bids: Map<string, BitfinexRow>, asks: Map<string, BitfinexRow>) {
  return { bids: [...bids.values()].sort((a, b) => b.price - a.price), asks: [...asks.values()].sort((a, b) => a.price - b.price) };
}

function invalidated(session: BitfinexDepthSession, reason: string): DepthSessionResult<BitfinexDepthSession> {
  const book = session.book ? { ...session.book, complete: false, gap: true, invalidated: true, resyncRequired: true, status: 'resync-required', invalidReason: reason } : null;
  return { session: { ...session, book, status: 'resync-required', invalidated: true, invalidReason: reason }, accepted: false, ignored: false, reason: 'resync-required' };
}

export function createBitfinexDepthSession({ topic, instrumentId: id, sessionToken, channelId = null }: AdapterOptions = {}): BitfinexDepthSession {
  if (!topic || !id || !sessionToken) throw new TypeError('Bitfinex depth session topic, instrument, and token are required');
  return { venue: 'bitfinex', topic: String(topic), instrumentId: String(id), sessionToken: String(sessionToken), channelId: channelId == null ? null : Number(channelId), status: 'awaiting-snapshot', book: null, invalidated: false, bids: new Map<string, BitfinexRow>(), asks: new Map<string, BitfinexRow>() };
}

export function applyBitfinexDepthSessionMessage(session: BitfinexDepthSession, { topic, sessionToken, channelId, update }: DepthSessionMessageOptions<BitfinexDepthMessage> = {}): DepthSessionResult<BitfinexDepthSession> {
  if (!session || !update) throw new TypeError('Bitfinex depth session and update are required');
  if (topic !== session.topic) return { session, accepted: false, ignored: true, reason: 'wrong-topic' };
  if (sessionToken !== session.sessionToken) return { session, accepted: false, ignored: true, reason: 'cross-session' };
  if (channelId != null && session.channelId != null && Number(channelId) !== Number(session.channelId)) return { session, accepted: false, ignored: true, reason: 'wrong-channel' };
  if (update.instrumentId !== session.instrumentId) return { session, accepted: false, ignored: true, reason: 'wrong-instrument' };
  const channel = session.channelId ?? (channelId == null ? null : Number(channelId));
  if (update.kind === 'depthSnapshot') {
    const levels = update.checksumLevels ?? [];
    const bids = mapRows(arrayValue(levels).filter((row) => row.side === 'bid')); const asks = mapRows(arrayValue(levels).filter((row) => row.side === 'ask'));
    const calculated = bitfinexBookChecksum({ bids: [...bids.values()], asks: [...asks.values()] });
    if (update.checksum != null && calculated !== Number(update.checksum)) return invalidated(session, `Bitfinex checksum mismatch: expected ${calculated}, received ${update.checksum}`);
    const next = bookRows(bids, asks);
    const book = { ...update, channelId: channel, bids: sideLevels(outputRows(next.bids, 'bid'), 'bids'), asks: sideLevels(outputRows(next.asks, 'ask'), 'asks'), checksumLevels: levels, checksum: update.checksum, checksumVerified: update.checksum != null, continuity: update.checksum != null ? 'checksum-verified' : 'checksum-pending', status: 'live', complete: true, gap: false, invalidated: false, resyncRequired: false };
    return { session: { ...session, channelId: channel, bids, asks, book, status: 'live', invalidated: false }, accepted: true, ignored: false, reason: null };
  }
  if (update.kind === 'depthChecksum') {
    if (!session.book || session.status !== 'live' || session.invalidated) return { session, accepted: false, ignored: true, reason: 'fresh-snapshot-required' };
    const calculated = bitfinexBookChecksum({ bids: [...session.bids.values()], asks: [...session.asks.values()] });
    if (calculated !== Number(update.checksum)) return invalidated(session, `Bitfinex checksum mismatch: expected ${calculated}, received ${update.checksum}`);
    const book = { ...session.book, checksum: Number(update.checksum), checksumVerified: true, continuity: 'checksum-verified', status: 'live' };
    return { session: { ...session, book, status: 'live', invalidated: false }, accepted: true, ignored: false, checksumOnly: true, reason: null };
  }
  if (update.kind !== 'depthDelta') return { session, accepted: false, ignored: true, reason: 'unsupported-update' };
  if (!session.book || session.status !== 'live' || session.invalidated) return { session, accepted: false, ignored: true, reason: 'fresh-snapshot-required' };
  const bids = new Map(session.bids); const asks = new Map(session.asks); const levels = update.checksumLevels ?? [];
  for (const row of levels) applyRows(row.side === 'bid' ? bids : asks, [row]);
  const next = bookRows(bids, asks);
  // The whole book goes downstream, so it is labelled a snapshot (a delta would be merged into the state and never drop a level that left the book).
  const book = { ...session.book, ...update, kind: 'depthSnapshot' as const, bids: sideLevels(outputRows(next.bids, 'bid'), 'bids'), asks: sideLevels(outputRows(next.asks, 'ask'), 'asks'), checksumLevels: levels, checksumVerified: false, continuity: 'checksum-pending', status: 'live', complete: true, gap: false, invalidated: false, resyncRequired: false };
  return { session: { ...session, bids, asks, book, status: 'live', invalidated: false }, accepted: true, ignored: false, reason: null };
}

export function invalidateBitfinexDepthSession(session: BitfinexDepthSession, reason: string = 'disconnect'): BitfinexDepthSession {
  if (!session) throw new TypeError('Bitfinex depth session is required');
  const book = session.book ? { ...session.book, complete: false, gap: true, invalidated: true, resyncRequired: true, status: 'resync-required', invalidReason: String(reason) } : null;
  return { ...session, book, status: 'resync-required', invalidated: true, invalidReason: String(reason) };
}

export class BitfinexConnector {
  networkEnabled: boolean;
  transport: AdapterTransport | null;
  constructor({ transport = null, networkEnabled = false }: AdapterOptions = {}) { this.transport = transport; this.networkEnabled = networkEnabled; }
  async request(kind: string, params: AdapterOptions = {}) { if (!this.networkEnabled || !this.transport?.request) throw new AdapterTransportError('Bitfinex network disabled; inject transport and set networkEnabled=true'); return this.transport.request(buildBitfinexRequest(kind, params)); }
  async subscribe(kind: string, params: AdapterOptions = {}) { if (!this.networkEnabled || !this.transport?.subscribe) throw new AdapterTransportError('Bitfinex network disabled; inject transport and set networkEnabled=true'); return this.transport.subscribe(buildBitfinexSubscription(kind, params)); }
}
