import { recordValue, arrayValue, type AdapterOptions, type AdapterTransport, type WireRecord, type AdapterDepthBook, type DepthSessionIdentity, type DepthSessionMessageOptions, type DepthSessionResult } from './common.mts';
import { AdapterTransportError, epochMs, finiteNumber, requireSymbol, sideLevels } from './common.mts';

export interface BitmexChangeRow { id: string; symbol: unknown; pool?: string; timestamp?: unknown; side?: 'bid' | 'ask'; price?: number; amount?: number; }
export type BitmexDepthMessage = ReturnType<typeof normalizeBitmexDepth>;
export interface BitmexDepthSession extends DepthSessionIdentity { table: string; pool: string | null; book: AdapterDepthBook | null; rows: Map<string, BitmexChangeRow>; }
/** BitMEX public XBTUSD orderBookL2_25 descriptors and session reducer. */
export const BITMEX_REST_URL = 'https://www.bitmex.com/api/v1';
export const BITMEX_PUBLIC_WS_URL = 'wss://www.bitmex.com/realtime';
export const BITMEX_DEFAULT_SYMBOL = 'XBTUSD';
export const BITMEX_DEFAULT_TABLE = 'orderBookL2_25';
export const BITMEX_POOLS = Object.freeze(['Aggregated', 'Primary', 'Secondary']);

export function normalizeBitmexPool(value: unknown, { allowNull = true }: AdapterOptions = {}) {
  if (value == null || String(value).trim() === '') {
    if (allowNull) return null;
    throw new TypeError('BitMEX liquidity pool is required');
  }
  const normalized = String(value).trim().toLowerCase();
  const pool = BITMEX_POOLS.find(candidate => candidate.toLowerCase() === normalized);
  if (!pool) throw new TypeError(`Unsupported BitMEX liquidity pool: ${value}`);
  return pool;
}

function symbol(value: unknown) {
  const native = requireSymbol(value).toUpperCase();
  if (!/^[A-Z0-9._-]{3,32}$/.test(native)) throw new TypeError('Invalid BitMEX instrument symbol');
  return native;
}

function instrumentId(value: unknown) { return `bitmex:${symbol(value)}`; }

function marketFor(value: unknown, metadata: WireRecord = {}) {
  const nativeSymbol = symbol(value);
  const quote = String(metadata.quote ?? (nativeSymbol.endsWith('USDT') ? 'USDT' : nativeSymbol.endsWith('USD') ? 'USD' : 'USD')).toUpperCase();
  const base = String(metadata.base ?? (nativeSymbol.endsWith(quote) ? nativeSymbol.slice(0, -quote.length) : nativeSymbol)).toUpperCase();
  return {
    venue: 'bitmex', nativeSymbol, symbol: nativeSymbol, base: base || nativeSymbol, quote,
    marketType: metadata.marketType ?? 'perpetual', tickSize: metadata.tickSize ?? null,
    quantityUnit: 'contract',
  };
}

function assertBitmex(payload: unknown) {
  if (recordValue(payload)?.error || recordValue(payload)?.name === 'error') {
    const error = recordValue(payload).error ?? payload;
    throw new Error(`BitMEX provider error ${recordValue(error)?.message ?? recordValue(error)?.name ?? 'request failed'}`);
  }
  return payload;
}

function rowId(value: unknown, field: string) {
  if (value == null || String(value).trim() === '') throw new TypeError(`BitMEX ${field}.id missing`);
  return String(value);
}

function rowSide(value: unknown, field: string): 'bid' | 'ask' {
  const side = String(value ?? '').toLowerCase();
  if (side === 'buy' || side === 'bid') return 'bid';
  if (side === 'sell' || side === 'ask') return 'ask';
  throw new TypeError(`BitMEX ${field}.side missing or invalid`);
}

function changeRows(values: unknown, field: string, action: unknown, expectedSymbol: string, expectedPool: string | null = null) {
  if (!Array.isArray(values)) throw new TypeError(`BitMEX ${field} must be an array`);
  return values.map((row: unknown, index) => {
    if (!row || typeof row !== 'object') throw new TypeError(`BitMEX ${field}[${index}] malformed`);
    const id = rowId(recordValue(row).id, `${field}[${index}]`);
    const wireSymbol = recordValue(row).symbol == null ? expectedSymbol : symbol(recordValue(row).symbol);
    if (wireSymbol !== expectedSymbol) throw new TypeError(`BitMEX ${field}[${index}] symbol mismatch`);
    const rowPool = recordValue(row).pool == null ? expectedPool : normalizeBitmexPool(recordValue(row).pool, { allowNull: false });
    if (expectedPool && rowPool !== expectedPool) throw new TypeError(`BitMEX ${field}[${index}] pool mismatch`);
    const side = recordValue(row).side == null && (action === 'delete' || action === 'update') ? undefined : rowSide(recordValue(row).side, `${field}[${index}]`);
    const hasPrice = recordValue(row).price != null;
    const price = hasPrice ? finiteNumber(recordValue(row).price, `${field}[${index}].price`) : undefined;
    if (price != null && !(price > 0)) throw new TypeError(`BitMEX ${field}[${index}].price out of range`);
    const hasSize = recordValue(row).size != null;
    const amount = hasSize ? finiteNumber(recordValue(row).size, `${field}[${index}].size`) : undefined;
    if (amount != null && amount < 0) throw new TypeError(`BitMEX ${field}[${index}].size out of range`);
    if (action !== 'delete' && amount == null && action === 'insert') throw new TypeError(`BitMEX ${field}[${index}].size missing`);
    if (action !== 'delete' && side == null && action === 'insert') throw new TypeError(`BitMEX ${field}[${index}].side missing`);
    if ((action === 'partial' || action === 'insert') && price == null) throw new TypeError(`BitMEX ${field}[${index}].price missing`);
    return {
      id,
      symbol: expectedSymbol,
      ...(rowPool ? { pool: rowPool } : {}),
      ...(recordValue(row).timestamp != null ? { timestamp: recordValue(row).timestamp } : {}),
      ...(side ? { side } : {}),
      ...(price != null ? { price } : {}),
      ...(amount != null ? { amount } : {}),
    };
  });
}

function actionOf(payload: unknown) {
  const action = String(recordValue(payload)?.action ?? '').toLowerCase();
  if (!['partial', 'insert', 'update', 'delete'].includes(action)) throw new TypeError(`Unsupported BitMEX order book action: ${action || '(missing)'}`);
  return action;
}

function bitmexEpochMs(value: unknown, fallback: number) {
  if (typeof value === 'string' && !/^\s*[+-]?(?:\d+\.?\d*|\.\d+)\s*$/.test(value)) {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return epochMs(value, fallback);
}

function sourceTimestamp(payload: unknown, rows: unknown, receivedAt: number) {
  return bitmexEpochMs(recordValue(payload)?.timestamp ?? recordValue(arrayValue(rows).find((row: unknown) => recordValue(row)?.timestamp != null))?.timestamp, receivedAt);
}

export function buildBitmexRequest(kind: string, { symbol: value = BITMEX_DEFAULT_SYMBOL, depth = 25, pool = null, baseUrl = BITMEX_REST_URL }: AdapterOptions = {}) {
  const native = symbol(value);
  if (kind === 'instrument') return { url: `${baseUrl}/instrument?symbol=${encodeURIComponent(native)}`, method: 'GET', headers: { accept: 'application/json' } };
  if (kind === 'depth') {
    const numericDepth = finiteNumber(depth, 'depth');
    if (!Number.isInteger(numericDepth) || numericDepth < 0 || numericDepth > 1_000) throw new RangeError('BitMEX depth must be an integer from 0 through 1000');
    const selectedPool = normalizeBitmexPool(pool);
    const poolQuery = selectedPool ? `&pool=${encodeURIComponent(selectedPool)}` : '';
    return { url: `${baseUrl}/orderBook/L2?symbol=${encodeURIComponent(native)}&depth=${numericDepth}${poolQuery}`, method: 'GET', headers: { accept: 'application/json' } };
  }
  throw new RangeError(`Unsupported BitMEX request: ${kind}`);
}

export function buildBitmexSubscription(kind: string, { symbol: value = BITMEX_DEFAULT_SYMBOL, table = BITMEX_DEFAULT_TABLE }: AdapterOptions = {}) {
  if (kind !== 'depth') throw new RangeError(`Unsupported BitMEX subscription: ${kind}`);
  const native = symbol(value);
  const topicTable = String(table);
  if (!['orderBookL2_25', 'orderBookL2'].includes(topicTable)) throw new RangeError(`Unsupported BitMEX order book table: ${table}`);
  const topic = `${topicTable}:${native}`;
  return { url: BITMEX_PUBLIC_WS_URL, method: 'subscribe', op: 'subscribe', args: [topic], channel: topicTable, table: topicTable, symbol: native, topic, snapshot: true, depth: topicTable === 'orderBookL2_25' ? 25 : null };
}

export function normalizeBitmexInstrument(payload: unknown, { symbol: selected = BITMEX_DEFAULT_SYMBOL, marketType = 'perpetual', receivedAt = Date.now() }: AdapterOptions = {}) {
  const envelope = assertBitmex(payload);
  const rows = Array.isArray(envelope) ? envelope : recordValue(envelope)?.data ?? recordValue(envelope)?.result ?? [];
  if (!Array.isArray(rows)) throw new TypeError('BitMEX instrument metadata must be an array');
  const expected = symbol(selected);
  const assets = rows.filter((row: unknown) => recordValue(row)?.symbol == null || symbol(recordValue(row).symbol) === expected).map((row: unknown) => {
    const native = symbol(recordValue(row).symbol ?? expected);
    const market = marketFor(native, { base: recordValue(row).underlying, quote: recordValue(row).quoteCurrency, marketType, tickSize: recordValue(row).tickSize == null ? undefined : finiteNumber(recordValue(row).tickSize, 'tickSize') });
    const active = String(recordValue(row).state ?? 'Open').toLowerCase() === 'open';
    const pool = normalizeBitmexPool(recordValue(row).pool);
    return {
      instrumentId: instrumentId(native), ...market, venue: 'bitmex', isDelisted: !active,
      status: active ? 'online' : String(recordValue(row).state ?? 'unknown').toLowerCase(),
      tickSize: market.tickSize, lotSize: recordValue(row).lotSize == null ? undefined : finiteNumber(recordValue(row).lotSize, 'lotSize'),
      settleCoin: recordValue(row).settlCurrency ?? recordValue(row).quoteCurrency, inverse: recordValue(row).isInverse === true,
      ...(pool ? { pool } : {}),
      metadataSource: 'bitmex-v1-instrument',
    };
  });
  return { kind: 'metadata' as const, venue: 'bitmex', sourceTimestamp: bitmexEpochMs(recordValue(payload)?.timestamp ?? recordValue(rows.find((row: unknown) => recordValue(row)?.timestamp != null))?.timestamp, receivedAt), receivedAt, assets };
}

export function normalizeBitmexDepth(payload: unknown, { symbol: selected = BITMEX_DEFAULT_SYMBOL, table = BITMEX_DEFAULT_TABLE, pool = null, receivedAt = Date.now() }: AdapterOptions = {}) {
  const raw = assertBitmex(payload);
  const envelope = Array.isArray(raw) ? { table, action: 'partial', data: raw } : raw;
  if (!envelope || typeof envelope !== 'object') throw new TypeError('BitMEX order book envelope missing');
  const native = symbol(selected);
  if (String(recordValue(envelope).table ?? table) !== String(table)) throw new TypeError(`BitMEX order book table mismatch: ${recordValue(envelope).table ?? '(missing)'}`);
  const filterSymbol = recordValue(recordValue(envelope).filter)?.symbol;
  if (filterSymbol != null && symbol(filterSymbol) !== native) throw new TypeError('BitMEX order book filter symbol mismatch');
  const expectedPool = normalizeBitmexPool(pool);
  const filterPool = normalizeBitmexPool(recordValue(recordValue(envelope).filter)?.pool);
  const envelopePool = normalizeBitmexPool(recordValue(envelope).pool);
  if (filterPool && envelopePool && filterPool !== envelopePool) throw new TypeError('BitMEX order book pool mismatch');
  let observedPool = filterPool ?? envelopePool ?? expectedPool;
  if (!observedPool) {
    const rowPools = new Set(arrayValue((Array.isArray(recordValue(envelope).data) ? recordValue(envelope).data : []))
      .filter((row: unknown) => recordValue(row)?.pool != null)
      .map((row: unknown) => normalizeBitmexPool(recordValue(row).pool, { allowNull: false })));
    if (rowPools.size > 1) throw new TypeError('BitMEX order book row pools disagree');
    observedPool = rowPools.values().next().value ?? null;
  }
  if (expectedPool && observedPool !== expectedPool) throw new TypeError('BitMEX order book pool mismatch');
  if (!Array.isArray(raw) && expectedPool && !filterPool) throw new TypeError('BitMEX order book filter pool missing');
  const action = actionOf(envelope);
  const rows = changeRows(recordValue(envelope).data, 'data', action, native, observedPool);
  const market = marketFor(native);
  const common = { venue: 'bitmex', instrumentId: instrumentId(native), nativeSymbol: native, market, units: market.quantityUnit, sourceTimestamp: sourceTimestamp(envelope, rows, receivedAt), receivedAt, continuity: 'provider-ordered', table: String(table), action, ...(observedPool ? { pool: observedPool } : {}), changes: rows };
  if (action === 'partial') {
    const bids = rows.filter(row => row.side === 'bid' && row.amount != null && row.amount > 0 && row.price != null).map(row => [row.price, row.amount]);
    const asks = rows.filter(row => row.side === 'ask' && row.amount != null && row.amount > 0 && row.price != null).map(row => [row.price, row.amount]);
    return { kind: 'depthSnapshot' as const, ...common, complete: true, coverage: 'partial' as const, bids: sideLevels(bids, 'bids'), asks: sideLevels(asks, 'asks') };
  }
  const bids = rows.filter(row => row.side === 'bid' && row.amount != null && row.amount > 0 && row.price != null).map(row => [row.price, row.amount]);
  const asks = rows.filter(row => row.side === 'ask' && row.amount != null && row.amount > 0 && row.price != null).map(row => [row.price, row.amount]);
  return { kind: 'depthDelta' as const, ...common, bids: sideLevels(bids, 'bids'), asks: sideLevels(asks, 'asks') };
}

function sortedRows(rows: Map<string, BitmexChangeRow>) {
  return [...rows.values()].filter((row) => Number(row.amount) > 0 && Number(row.price) > 0).sort((a, b) => a.side === b.side ? (a.side === 'bid' ? Number(b.price) - Number(a.price) : Number(a.price) - Number(b.price)) : a.side === 'bid' ? -1 : 1);
}

function bookFrom(session: BitmexDepthSession, update: BitmexDepthMessage, rows: Map<string, BitmexChangeRow>): AdapterDepthBook {
  const sorted = sortedRows(rows);
  return {
    ...update, kind: 'depthSnapshot' as const, complete: true, coverage: 'partial' as const, continuity: 'provider-ordered', status: 'live', gap: false, invalidated: false, resyncRequired: false,
    bids: sideLevels(sorted.filter((row) => row.side === 'bid').map((row) => [row.price, row.amount]), 'bids'),
    asks: sideLevels(sorted.filter((row) => row.side === 'ask').map((row) => [row.price, row.amount]), 'asks'),
    table: session.table,
  };
}

function invalidated(session: BitmexDepthSession, reason: string): DepthSessionResult<BitmexDepthSession> {
  const book = session.book ? { ...session.book, complete: false, gap: true, invalidated: true, resyncRequired: true, status: 'resync-required', invalidReason: reason } : null;
  return { session: { ...session, book, status: 'resync-required', invalidated: true, invalidReason: reason }, accepted: false, ignored: false, reason: 'resync-required' };
}

export function createBitmexDepthSession({ topic, instrumentId: id, sessionToken, table = BITMEX_DEFAULT_TABLE, pool = null }: AdapterOptions = {}): BitmexDepthSession {
  if (!topic || !id || !sessionToken) throw new TypeError('BitMEX depth session topic, instrument, and token are required');
  return { venue: 'bitmex', topic: String(topic), instrumentId: String(id), sessionToken: String(sessionToken), table: String(table), pool: normalizeBitmexPool(pool), status: 'awaiting-snapshot', book: null, invalidated: false, rows: new Map<string, BitmexChangeRow>() };
}

export function applyBitmexDepthSessionMessage(session: BitmexDepthSession, { topic, sessionToken, update }: DepthSessionMessageOptions<BitmexDepthMessage> = {}): DepthSessionResult<BitmexDepthSession> {
  if (!session || !update) throw new TypeError('BitMEX depth session and update are required');
  if (topic !== session.topic) return { session, accepted: false, ignored: true, reason: 'wrong-topic' };
  if (sessionToken !== session.sessionToken) return { session, accepted: false, ignored: true, reason: 'cross-session' };
  if (update.instrumentId !== session.instrumentId) return { session, accepted: false, ignored: true, reason: 'wrong-instrument' };
  if (update.table !== session.table) return { session, accepted: false, ignored: true, reason: 'wrong-table' };
  if (session.pool && update.pool !== session.pool) return { session, accepted: false, ignored: true, reason: 'wrong-pool' };
  if (session.pool && !update.pool) return invalidated(session, 'missing BitMEX liquidity pool');
  const changes = update.changes ?? [];
  if (update.kind === 'depthSnapshot') {
    const rows = new Map<string, BitmexChangeRow>();
    for (const row of changes) {
      if (row.amount == null || row.price == null || !row.side || row.amount <= 0 || rows.has(row.id)) return invalidated(session, 'malformed BitMEX partial snapshot');
      rows.set(row.id, row);
    }
    const book = bookFrom(session, update, rows);
    return { session: { ...session, rows, book, status: 'live', invalidated: false }, accepted: true, ignored: false, reason: null };
  }
  if (update.kind !== 'depthDelta' || !['insert', 'update', 'delete'].includes(update.action)) return { session, accepted: false, ignored: true, reason: 'unsupported-update' };
  if (!session.book || session.status !== 'live' || session.invalidated) return { session, accepted: false, ignored: true, reason: 'fresh-snapshot-required' };
  const rows = new Map(session.rows);
  for (const change of changes) {
    const existing = rows.get(change.id);
    if (update.action === 'delete') {
      if (!existing) return invalidated(session, `unknown BitMEX delete id ${change.id}`);
      rows.delete(change.id);
      continue;
    }
    if (update.action === 'insert' && existing) return invalidated(session, `duplicate BitMEX insert id ${change.id}`);
    if (update.action === 'update' && !existing) return invalidated(session, `unknown BitMEX update id ${change.id}`);
    if (change.amount === 0) { rows.delete(change.id); continue; }
    const merged = { ...existing, ...change, id: change.id, symbol: existing?.symbol ?? change.symbol, ...(session.pool ? { pool: session.pool } : {}) };
    if (merged.price == null || merged.side == null || merged.amount == null || !(merged.price > 0) || !(merged.amount > 0)) return invalidated(session, `malformed BitMEX ${update.action} row ${change.id}`);
    rows.set(change.id, merged);
  }
  const book = bookFrom(session, update, rows);
  return { session: { ...session, rows, book, status: 'live', invalidated: false }, accepted: true, ignored: false, reason: null };
}

export function invalidateBitmexDepthSession(session: BitmexDepthSession, reason: string = 'disconnect'): BitmexDepthSession {
  if (!session) throw new TypeError('BitMEX depth session is required');
  const book = session.book ? { ...session.book, complete: false, gap: true, invalidated: true, resyncRequired: true, status: 'resync-required', invalidReason: String(reason) } : null;
  return { ...session, book, status: 'resync-required', invalidated: true, invalidReason: String(reason) };
}

export class BitmexConnector {
  networkEnabled: boolean;
  transport: AdapterTransport | null;
  constructor({ transport = null, networkEnabled = false }: AdapterOptions = {}) { this.transport = transport; this.networkEnabled = networkEnabled; }
  async request(kind: string, params: AdapterOptions = {}) { if (!this.networkEnabled || !this.transport?.request) throw new AdapterTransportError('BitMEX network disabled; inject transport and set networkEnabled=true'); return this.transport.request(buildBitmexRequest(kind, params)); }
  async subscribe(kind: string, params: AdapterOptions = {}) { if (!this.networkEnabled || !this.transport?.subscribe) throw new AdapterTransportError('BitMEX network disabled; inject transport and set networkEnabled=true'); return this.transport.subscribe(buildBitmexSubscription(kind, params)); }
}
