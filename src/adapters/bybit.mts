import { recordValue, arrayValue, type AdapterOptions, type AdapterTransport, type NormalizedAdapterCandle, type AdapterDepthBook } from './common.mts';
import { AdapterTransportError, epochMs, intervalMilliseconds, requireSymbol, validateCandle } from './common.mts';
import type { PriceAmount, OpenInterestSample } from '../domain/contracts.ts';

export type BybitCategory = 'linear' | 'spot' | 'inverse';
export interface BybitInstrumentMetadata {
  instrumentId: string; venue: 'bybit'; symbol: string; nativeSymbol: string;
  category: BybitCategory; base: string; quote: string; settleCoin: string | null;
  marketType: 'spot' | 'perpetual'; tickSize: number; qtyStep: number; lotSize: number;
  quantityUnit: 'base' | 'quote'; inverse: boolean; contractType: string | null;
  status: string; isDelisted: boolean;
}
export interface BybitDepthState extends AdapterDepthBook { category?: BybitCategory; units?: 'base' | 'quote'; inverse?: boolean; }
export type BybitDepthMessage = ReturnType<typeof normalizeBybitDepth> | ReturnType<typeof normalizeBybitDepthDelta>;
/** Public descriptors and parsers only; this module never performs I/O. */
export const BYBIT_REST_URL = 'https://api.bybit.com';
export const BYBIT_LINEAR_WS_URL = 'wss://stream.bybit.com/v5/public/linear';
export const BYBIT_SPOT_WS_URL = 'wss://stream.bybit.com/v5/public/spot';
export const BYBIT_INVERSE_WS_URL = 'wss://stream.bybit.com/v5/public/inverse';
export const MAX_BYBIT_INSTRUMENT_ROWS = 1_000;
export const MAX_BYBIT_DEPTH_ROWS = 1_000;
const BYBIT_WS_URLS = { linear: BYBIT_LINEAR_WS_URL, spot: BYBIT_SPOT_WS_URL, inverse: BYBIT_INVERSE_WS_URL } as const;

function bybitCategory(value: unknown): BybitCategory {
  if (value !== 'linear' && value !== 'spot' && value !== 'inverse') throw new RangeError('Unsupported Bybit category: ' + String(value));
  return value;
}
function bybitSymbol(symbol: unknown): string {
  if (typeof symbol !== 'string' || symbol.length > 64 || !/^[A-Za-z0-9_-]+$/.test(symbol.trim())) throw new TypeError('Invalid Bybit symbol');
  return requireSymbol(symbol).replaceAll('-', '');
}
function wireNumber(value: unknown, field: string): number {
  if ((typeof value !== 'number' && typeof value !== 'string')
    || (typeof value === 'string' && !/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(value.trim()))) throw new TypeError('Invalid Bybit ' + field);
  const number = Number(value);
  if (!Number.isFinite(number)) throw new TypeError('Invalid Bybit ' + field);
  return number;
}
function positiveNumber(value: unknown, field: string): number {
  const number = wireNumber(value, field);
  if (!(number > 0)) throw new TypeError('Invalid Bybit ' + field);
  return number;
}
function coinValue(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length > 64 || !/^[A-Za-z0-9._]+$/.test(value.trim())) throw new TypeError('Invalid Bybit ' + field + ' metadata');
  return value.trim().toUpperCase();
}
function sourceTime(value: unknown, receivedAt: number): number {
  if (!Number.isSafeInteger(receivedAt) || receivedAt <= 0) throw new TypeError('Invalid Bybit receivedAt');
  if (value == null) return receivedAt;
  const number = positiveNumber(value, 'timestamp');
  if (!Number.isSafeInteger(number)) throw new TypeError('Invalid Bybit timestamp');
  const timestamp = epochMs(number, receivedAt);
  if (!Number.isSafeInteger(timestamp) || timestamp > 253_402_300_799_999) throw new TypeError('Invalid Bybit timestamp range');
  return timestamp;
}
function assertSuccess(payload: unknown) {
  const code = recordValue(payload).retCode ?? recordValue(payload).ret_code;
  if (code != null) {
    const number = wireNumber(code, 'provider return code');
    if (!Number.isSafeInteger(number) || number < 0) throw new TypeError('Invalid Bybit provider return code');
    if (number !== 0) throw new Error('Bybit provider error ' + number + ': ' + String(recordValue(payload).retMsg ?? recordValue(payload).ret_msg ?? 'request failed'));
  }
}
function dataOf(payload: unknown) { assertSuccess(payload); return recordValue(payload).result ?? recordValue(payload).data ?? payload; }
function assertCategory(payload: unknown, data: unknown, expected: BybitCategory, required = false) {
  const declared = [recordValue(payload).category, recordValue(recordValue(payload).result).category, recordValue(recordValue(payload).data).category, recordValue(data).category].filter(value => value != null);
  if ((required && !declared.length) || declared.some(value => value !== expected)) throw new RangeError('Bybit response category mismatch: expected ' + expected);
}
function sequenceToken(value: unknown, field: string, { required = false }: AdapterOptions = {}) {
  if (value == null || value === '') { if (required) throw new TypeError('Bybit ' + field + ' missing or invalid'); return undefined; }
  if (typeof value !== 'number' && typeof value !== 'string') throw new TypeError('Bybit ' + field + ' missing or invalid');
  if (typeof value === 'number' && !Number.isSafeInteger(value)) throw new TypeError('Bybit ' + field + ' is unsafe numeric; preserve the provider token as a string');
  const text = String(value);
  if (!/^\d{1,64}$/.test(text)) throw new TypeError('Bybit ' + field + ' missing or invalid');
  const integer = BigInt(text);
  if (integer <= 0n) throw new TypeError('Bybit ' + field + ' missing or invalid');
  return integer <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(integer) : integer.toString();
}
function sequenceBigInt(value: unknown, field: string) {
  const token = sequenceToken(value, field, { required: true });
  return BigInt(String(token));
}
const BYBIT_INTERVALS = new Map([['1m','1'],['3m','3'],['5m','5'],['15m','15'],['30m','30'],['1h','60'],['2h','120'],['4h','240'],['6h','360'],['12h','720'],['1d','D'],['1','1'],['3','3'],['5','5'],['15','15'],['30','30'],['60','60'],['120','120'],['240','240'],['360','360'],['720','720'],['D','D']]);
const BYBIT_CANONICAL_INTERVALS = new Map([['1','1m'],['3','3m'],['5','5m'],['15','15m'],['30','30m'],['60','1h'],['120','2h'],['240','4h'],['360','6h'],['720','12h'],['D','1d']]);
function intervalCode(interval: unknown, { required = false }: AdapterOptions = {}) {
  if (interval == null || String(interval).trim() === '') { if (required) throw new RangeError('Bybit kline interval is required'); return undefined; }
  const value = String(interval).trim(); const code = BYBIT_INTERVALS.get(value);
  if (!code) throw new RangeError(`Unsupported Bybit interval: ${value}`);
  return code;
}
function canonicalInterval(interval: unknown) { const code = intervalCode(interval, { required: true }); return BYBIT_CANONICAL_INTERVALS.get(String(code))!; }
export function bybitInstrumentId(symbol: unknown, category: unknown = 'linear'): string {
  const family = bybitCategory(category), value = bybitSymbol(symbol);
  return 'bybit:' + value + (family === 'spot' ? ':spot' : '');
}

/** Normalize a bounded selected product; legacy unselected linear catalogs remain active perpetual-only. */
export function normalizeBybitInstrumentInfo(payload: unknown, { symbol, category = 'linear', receivedAt = Date.now() }: AdapterOptions = {}) {
  const family = bybitCategory(category), data = dataOf(payload);
  assertCategory(payload, data, family, family !== 'linear');
  const rows = recordValue(data).list;
  if (!Array.isArray(rows)) throw new TypeError('Bybit instruments list missing');
  if (rows.length > MAX_BYBIT_INSTRUMENT_ROWS) throw new TypeError('Bybit instruments list exceeds its bounded row limit');
  const expected = symbol == null ? null : bybitSymbol(symbol);
  const selected = expected == null ? rows : rows.filter(row => {
    const value = recordValue(row).symbol;
    return typeof value === 'string' && value.length <= 64 && value.trim().toUpperCase().replaceAll('-', '') === expected;
  });
  if (expected != null && selected.length > 1) throw new TypeError('Bybit selected instrument identity is duplicated');
  const seen = new Set<string>(), assets: BybitInstrumentMetadata[] = [];
  for (const entry of selected) {
    const row = recordValue(entry), contractType = row.contractType ?? null;
    // Keep the historical broad catalog slice bounded to active perpetual products.
    if (expected == null && family === 'linear' && (contractType !== 'LinearPerpetual' || row.status !== 'Trading')) continue;
    const expectedContract = family === 'linear' ? 'LinearPerpetual' : family === 'inverse' ? 'InversePerpetual' : null;
    if (contractType !== expectedContract && !(family === 'spot' && contractType === '')) throw new TypeError('Bybit selected instrument contract/category mismatch');
    if (row.category != null && row.category !== family) throw new TypeError('Bybit selected instrument category mismatch');
    const nativeSymbol = bybitSymbol(row.symbol), base = coinValue(row.baseCoin, 'baseCoin'), quote = coinValue(row.quoteCoin, 'quoteCoin');
    const settleCoin = family === 'spot' ? null : coinValue(row.settleCoin, 'settleCoin');
    const nativeMatches = nativeSymbol === base + quote || family === 'linear' && quote === 'USDC' && nativeSymbol === base + 'PERP';
    if (!nativeMatches || (family === 'linear' && (settleCoin !== quote || !['USDT', 'USDC'].includes(quote)))
      || (family === 'inverse' && (quote !== 'USD' || settleCoin !== base))
      || (family === 'spot' && row.settleCoin != null && row.settleCoin !== '')) throw new TypeError('Bybit selected instrument family/settlement metadata mismatch');
    const tickSize = positiveNumber(recordValue(row.priceFilter).tickSize, 'tickSize');
    const qtyStep = positiveNumber(family === 'spot' ? recordValue(row.lotSizeFilter).basePrecision : recordValue(row.lotSizeFilter).qtyStep, family === 'spot' ? 'basePrecision' : 'qtyStep');
    if (typeof row.status !== 'string' || !row.status.trim() || row.status.length > 64) throw new TypeError('Invalid Bybit instrument status');
    const status = row.status.trim(), instrumentId = bybitInstrumentId(nativeSymbol, family);
    if (seen.has(instrumentId)) throw new TypeError('Bybit instrument identity is duplicated');
    seen.add(instrumentId);
    assets.push({ instrumentId, venue: 'bybit', category: family, symbol: nativeSymbol, nativeSymbol, base, quote, settleCoin,
      marketType: family === 'spot' ? 'spot' : 'perpetual', tickSize, qtyStep, lotSize: qtyStep,
      quantityUnit: family === 'inverse' ? 'quote' : 'base', inverse: family === 'inverse', contractType: expectedContract,
      status, isDelisted: status !== 'Trading' });
  }
  return { kind: 'metadata' as const, venue: 'bybit' as const, category: family, sourceTimestamp: sourceTime(recordValue(payload).time ?? recordValue(payload).ts, receivedAt), receivedAt, assets };
}

function verifiedMetadata(symbol: string, category: BybitCategory, metadata: unknown): BybitInstrumentMetadata {
  const meta = recordValue(metadata);
  const base = coinValue(meta.base, 'base'), quote = coinValue(meta.quote, 'quote');
  const settleCoin = category === 'spot' ? null : coinValue(meta.settleCoin, 'settleCoin');
  const expectedContract = category === 'linear' ? 'LinearPerpetual' : category === 'inverse' ? 'InversePerpetual' : null;
  if (meta.venue !== 'bybit' || meta.instrumentId !== bybitInstrumentId(symbol, category) || meta.nativeSymbol !== symbol || meta.symbol !== symbol
    || meta.category !== category || meta.marketType !== (category === 'spot' ? 'spot' : 'perpetual')
    || meta.quantityUnit !== (category === 'inverse' ? 'quote' : 'base') || meta.inverse !== (category === 'inverse')
    || meta.contractType !== expectedContract || meta.status !== 'Trading' || meta.isDelisted !== false
    || !(symbol === base + quote || category === 'linear' && quote === 'USDC' && symbol === base + 'PERP') || (category === 'linear' && (settleCoin !== quote || !['USDT', 'USDC'].includes(quote)))
    || (category === 'inverse' && (quote !== 'USD' || settleCoin !== base))
    || (category === 'spot' && meta.settleCoin != null)) throw new TypeError('Bybit depth requires matching active verified family metadata');
  const tickSize = positiveNumber(meta.tickSize, 'metadata tickSize'), qtyStep = positiveNumber(meta.qtyStep ?? meta.lotSize, 'metadata qtyStep');
  return { instrumentId: bybitInstrumentId(symbol, category), venue: 'bybit', category, nativeSymbol: symbol, symbol, base, quote, settleCoin,
    marketType: category === 'spot' ? 'spot' : 'perpetual', tickSize, qtyStep, lotSize: qtyStep,
    quantityUnit: category === 'inverse' ? 'quote' : 'base', inverse: category === 'inverse', contractType: expectedContract, status: 'Trading', isDelisted: false };
}
function bybitMarket(symbol: string, category: BybitCategory, metadata: unknown) {
  if (metadata != null || category !== 'linear') {
    const meta = verifiedMetadata(symbol, category, metadata);
    return { ...meta, id: meta.instrumentId, exchange: 'bybit', baseNormalized: meta.base, quoteNormalized: meta.quote, isFree: true, aggregationId: 0 };
  }
  if (!symbol.endsWith('USDT') && !symbol.endsWith('USDC')) throw new TypeError('Bybit linear depth needs verified metadata for an unknown quantity basis');
  const base = symbol.slice(0, -4), quote = symbol.slice(-4);
  return { id: bybitInstrumentId(symbol), instrumentId: bybitInstrumentId(symbol), venue: 'bybit', exchange: 'bybit', category,
    nativeSymbol: symbol, symbol, base, quote, baseNormalized: base, quoteNormalized: quote,
    marketType: 'perpetual' as const, tickSize: null, quantityUnit: 'base' as const, inverse: false, isFree: true, aggregationId: 0 };
}

export function buildBybitRequest(kind: string, { symbol, category = 'linear', limit, interval, startTime, endTime, intervalTime = '5min', baseUrl, metadata }: AdapterOptions = {}) {
  const family = bybitCategory(category);
  if (['depth', 'klines', 'openInterest'].includes(kind) && !symbol) throw new TypeError('Bybit ' + kind + ' request requires symbol');
  const nativeSymbol = symbol == null ? null : bybitSymbol(symbol);
  if (metadata != null && nativeSymbol != null) verifiedMetadata(nativeSymbol, family, metadata);
  if (kind === 'openInterest' && family === 'spot') throw new RangeError('Bybit spot does not provide open interest');
  const query = new URLSearchParams({ category: family, ...(nativeSymbol == null ? {} : { symbol: nativeSymbol }) });
  let path: string;
  if (kind === 'instruments') path = '/v5/market/instruments-info';
  else if (kind === 'depth') path = '/v5/market/orderbook';
  else if (kind === 'klines') { path = '/v5/market/kline'; query.set('interval', String(intervalCode(interval, { required: true }))); }
  else if (kind === 'openInterest') {
    path = '/v5/market/open-interest';
    if (!['5min', '15min', '30min', '1h', '4h', '1d'].includes(intervalTime)) throw new RangeError('Unsupported Bybit open interest interval');
    query.set('intervalTime', intervalTime);
  } else throw new RangeError('Unsupported Bybit request: ' + kind);
  if (limit != null) {
    if (kind === 'instruments' && family === 'spot') throw new RangeError('Bybit spot instruments do not support a pagination limit');
    const maximum = kind === 'openInterest' ? 200 : 1_000;
    if (!Number.isSafeInteger(limit) || limit <= 0 || limit > maximum) throw new RangeError('Bybit request limit is outside its supported bound');
    query.set('limit', String(limit));
  }
  for (const [value, label] of [[startTime, kind === 'klines' ? 'start' : 'startTime'], [endTime, kind === 'klines' ? 'end' : 'endTime']] as const) {
    if (value == null) continue;
    if (!Number.isSafeInteger(value) || value < 0) throw new TypeError('Invalid Bybit ' + label);
    query.set(label, String(value));
  }
  if (startTime != null && endTime != null && startTime > endTime) throw new RangeError('Bybit request time range is inverted');
  return { url: (baseUrl ?? BYBIT_REST_URL) + path + '?' + query, method: 'GET', headers: { accept: 'application/json' } };
}
export function buildBybitSubscription(kind: string, { symbol, category = 'linear', interval = '1h', metadata }: AdapterOptions = {}) {
  const family = bybitCategory(category), value = bybitSymbol(symbol);
  if (metadata != null) verifiedMetadata(value, family, metadata);
  const topic = kind === 'depth' ? 'orderbook.1000.' + value : kind === 'kline' ? 'kline.' + intervalCode(interval, { required: true }) + '.' + value : kind === 'ticker' ? 'tickers.' + value : null;
  if (!topic) throw new RangeError('Unsupported Bybit subscription: ' + kind);
  return { url: BYBIT_WS_URLS[family], method: 'subscribe', args: [topic], topic };
}
function resolvedDepthSymbol(payload: unknown, data: unknown, symbol: unknown, category: BybitCategory): string {
  const declared = [recordValue(data).s, recordValue(data).symbol].filter(value => value != null).map(bybitSymbol);
  const resolved = symbol == null ? declared[0] : bybitSymbol(symbol);
  if (!resolved || declared.some(value => value !== resolved) || (category !== 'linear' && !declared.length)) throw new TypeError('Bybit depth instrument/symbol mismatch');
  const topic = recordValue(payload).topic;
  if (topic != null && (typeof topic !== 'string' || !/^orderbook\.(?:1|50|200|1000)\./.test(topic) || bybitSymbol(topic.split('.').slice(2).join('.')) !== resolved)) throw new TypeError('Bybit depth topic/instrument mismatch');
  return resolved;
}
function depthRows(value: unknown, field: string): PriceAmount[] {
  if (!Array.isArray(value) || value.length > MAX_BYBIT_DEPTH_ROWS) throw new TypeError('Bybit orderbook ' + field + ' missing or exceeds its bounded row limit');
  const seen = new Set<number>();
  return value.map((row, index) => {
    if (!Array.isArray(row) || row.length !== 2) throw new TypeError('Invalid Bybit ' + field + '[' + index + '] row');
    const price = positiveNumber(row[0], field + ' price'), amount = wireNumber(row[1], field + ' amount');
    if (amount < 0 || seen.has(price)) throw new TypeError('Invalid Bybit ' + field + ' amount or duplicate price');
    seen.add(price); return { price, amount };
  });
}
/** Partial-depth snapshots replace local state, including a service-reset u=1. */
export function normalizeBybitDepth(payload: unknown, { symbol, category = 'linear', metadata, receivedAt = Date.now() }: AdapterOptions = {}) {
  if (recordValue(payload).type != null && recordValue(payload).type !== 'snapshot') throw new TypeError('Bybit delta or unknown orderbook type is outside the snapshot adapter');
  const family = bybitCategory(category), data = dataOf(payload);
  assertCategory(payload, data, family);
  const resolved = resolvedDepthSymbol(payload, data, symbol, family), market = bybitMarket(resolved, family, metadata);
  const sequence = sequenceToken(recordValue(data).u, 'update id', { required: true }), crossSequence = sequenceToken(recordValue(data).seq, 'cross sequence');
  return { kind: 'depthSnapshot' as const, instrumentId: bybitInstrumentId(resolved, family), market, category: family,
    sourceTimestamp: sourceTime(recordValue(payload).ts ?? recordValue(data).ts ?? recordValue(payload).time, receivedAt), receivedAt, sequence, crossSequence,
    complete: true, coverage: 'partial' as const, bids: depthRows(recordValue(data).b, 'bids'), asks: depthRows(recordValue(data).a, 'asks'),
    marketType: market.marketType, units: market.quantityUnit, inverse: market.inverse };
}
/** Numeric u jumps remain unproven continuity; deltas never restore invalid state. */
export function normalizeBybitDepthDelta(payload: unknown, { symbol, category = 'linear', metadata, receivedAt = Date.now() }: AdapterOptions = {}) {
  if (recordValue(payload).type !== 'delta') throw new TypeError('Bybit depth delta requires type=delta');
  const family = bybitCategory(category), data = dataOf(payload);
  assertCategory(payload, data, family);
  const resolved = resolvedDepthSymbol(payload, data, symbol, family), market = bybitMarket(resolved, family, metadata);
  const sequence = sequenceToken(recordValue(data).u, 'update id', { required: true }), crossSequence = sequenceToken(recordValue(data).seq, 'cross sequence');
  return { kind: 'depthDelta' as const, instrumentId: bybitInstrumentId(resolved, family), category: family,
    sourceTimestamp: sourceTime(recordValue(payload).ts ?? recordValue(data).ts ?? recordValue(payload).time, receivedAt), receivedAt, sequence, crossSequence,
    bids: depthRows(recordValue(data).b, 'bids'), asks: depthRows(recordValue(data).a, 'asks'), marketType: market.marketType, units: market.quantityUnit, inverse: market.inverse };
}
function assertDepthBasis(book: unknown, update: { category: BybitCategory; units: 'base' | 'quote' }) {
  const state = recordValue(book);
  if (state.category != null && state.category !== update.category) throw new TypeError('Bybit depth state/category mismatch');
  if (state.units != null && state.units !== update.units) throw new TypeError('Bybit depth state/unit mismatch');
}
/** Mark a book invalid until a fresh snapshot arrives. */
export function invalidateBybitDepthState<T extends AdapterDepthBook>(book: T, reason: string = 'resync required'): BybitDepthState {
  return { ...book, complete: false, invalidated: true, gap: true, resyncRequired: true, status: 'resync-required', invalidReason: String(reason) };
}

/** Apply a Bybit snapshot or delta. Fresh snapshots replace invalid state; deltas cannot restore it. */
export function applyBybitDepthUpdate<T extends AdapterDepthBook>(book: T, update: BybitDepthMessage): BybitDepthState {
  if (!update || !book || book.instrumentId !== update.instrumentId) throw new TypeError('Bybit depth state/instrument mismatch');
  assertDepthBasis(book, update);
  if (update.kind === 'depthSnapshot') return { ...update, ignored: false, gap: false, resyncRequired: false, invalidated: false, status: 'live' };
  if (update.kind !== 'depthDelta') throw new TypeError('Unsupported Bybit depth update');
  return applyBybitDepthDelta(book, update);
}

/** Apply a newer Bybit delta without fabricating continuity. Duplicate/old ids are ignored; invalid books require a snapshot. */
export function applyBybitDepthDelta<T extends AdapterDepthBook>(book: T, delta: ReturnType<typeof normalizeBybitDepthDelta>): BybitDepthState {
  if (!book || !delta || book.instrumentId !== delta.instrumentId) throw new TypeError('Bybit depth state/instrument mismatch');
  assertDepthBasis(book, delta);
  const current = sequenceBigInt(book.sequence, 'depth state sequence');
  const nextSequence = sequenceBigInt(delta.sequence, 'delta sequence');
  if (current <= 0n) throw new TypeError('Bybit depth state sequence missing');
  if (book.resyncRequired || book.invalidated || book.complete !== true) return { ...book, ignored: nextSequence <= current, gap: true, resyncRequired: true, status: 'resync-required' };
  if (nextSequence <= current) return { ...book, ignored: true, gap: Boolean(book.gap), resyncRequired: Boolean(book.resyncRequired), status: book.status ?? 'live' };
  const update = (rows: PriceAmount[], existing: Iterable<readonly [number, number]> | null | undefined, descending: boolean) => {
    const next = new Map<number, number>(existing ?? []);
    for (const row of rows) row.amount > 0 ? next.set(row.price, row.amount) : next.delete(row.price);
    return [...next].sort((a, b) => (descending ? b[0] - a[0] : a[0] - b[0])).map(([price, amount]) => ({ price, amount }));
  };
  return { ...book, sequence: delta.sequence, crossSequence: delta.crossSequence ?? book.crossSequence, sourceTimestamp: delta.sourceTimestamp, receivedAt: delta.receivedAt, bids: update(delta.bids, arrayValue(book.bids)?.map((row): [number, number] => [row.price, row.amount]), true), asks: update(delta.asks, arrayValue(book.asks)?.map((row): [number, number] => [row.price, row.amount]), false), ignored: false, gap: false, resyncRequired: false, sequenceJump: nextSequence > current + 1n, continuity: 'unproven', status: 'live' };
}

export function normalizeBybitOpenInterest(payload: unknown, { symbol, category = 'linear', metadata, receivedAt = Date.now(), markPrice }: AdapterOptions = {}) {
  const family = bybitCategory(category);
  if (family === 'spot') throw new RangeError('Bybit spot does not provide open interest');
  const data = dataOf(payload), row = recordValue(Array.isArray(recordValue(data).list) ? arrayValue(recordValue(data).list)[0] : data);
  assertCategory(payload, data, family);
  assertCategory(payload, row, family);
  const nativeSymbol = bybitSymbol(symbol ?? row.symbol ?? recordValue(data).symbol);
  for (const declared of [recordValue(data).symbol, row.symbol].filter(value => value != null)) {
    if (bybitSymbol(declared) !== nativeSymbol) throw new TypeError('Bybit OI instrument mismatch');
  }
  bybitMarket(nativeSymbol, family, metadata);
  const nativeAmount = wireNumber(row.openInterest, 'openInterest');
  if (nativeAmount < 0) throw new TypeError('Invalid Bybit openInterest');
  const observedMark = row.markPrice ?? markPrice;
  const mark = observedMark == null ? null : positiveNumber(observedMark, 'markPrice');
  if (family === 'inverse' && mark == null) throw new TypeError('Bybit inverse OI requires an observed mark price to derive base units');
  const baseAmount = family === 'inverse' ? nativeAmount / mark! : nativeAmount;
  const quoteAmount = mark == null ? null : family === 'inverse' ? nativeAmount : nativeAmount * mark;
  if (!Number.isFinite(baseAmount) || (quoteAmount != null && !Number.isFinite(quoteAmount))) throw new TypeError('Bybit open interest unit conversion overflow');
  const sample: OpenInterestSample & { markPrice?: number; units: 'base' | 'quote'; inverse: boolean } = {
    kind: 'openInterest', instrumentId: bybitInstrumentId(nativeSymbol, family),
    sourceTimestamp: sourceTime(row.timestamp ?? recordValue(data).ts ?? recordValue(payload).time, receivedAt), receivedAt,
    base: baseAmount, quality: 'native', units: family === 'inverse' ? 'quote' : 'base', inverse: family === 'inverse',
  };
  if (mark != null) { sample.quote = quoteAmount!; sample.markPrice = mark; }
  return sample;
}
export function normalizeBybitKline(row: unknown, { symbol, category = 'linear', metadata, interval = '1h', receivedAt = Date.now() }: AdapterOptions = {}): NormalizedAdapterCandle & { volumeUnits: 'base' | 'quote' } {
  assertSuccess(row);
  const family = bybitCategory(category), normalizedInterval = canonicalInterval(interval);
  assertCategory(row, recordValue(row).kline ?? row, family);
  const value = Array.isArray(row) ? { start: row[0], open: row[1], high: row[2], low: row[3], close: row[4], volume: row[5] } : recordValue(row).kline ?? row;
  const nativeSymbol = bybitSymbol(symbol ?? recordValue(row).symbol ?? recordValue(value).symbol);
  for (const declared of [recordValue(row).symbol, recordValue(value).symbol].filter(value => value != null)) {
    if (bybitSymbol(declared) !== nativeSymbol) throw new TypeError('Bybit kline instrument mismatch');
  }
  bybitMarket(nativeSymbol, family, metadata);
  const start = sourceTime(positiveNumber(recordValue(value).start ?? recordValue(value).startTime ?? recordValue(value).t, 'kline start'), receivedAt), duration = intervalMilliseconds(normalizedInterval);
  const candle = { instrumentId: bybitInstrumentId(nativeSymbol, family), marketType: family === 'spot' ? 'spot' : 'perpetual',
    interval: normalizedInterval, start, end: duration ? start + duration : Number.NaN,
    open: positiveNumber(recordValue(value).open ?? recordValue(value).o, 'open'), high: positiveNumber(recordValue(value).high ?? recordValue(value).h, 'high'),
    low: positiveNumber(recordValue(value).low ?? recordValue(value).l, 'low'), close: positiveNumber(recordValue(value).close ?? recordValue(value).c, 'close'),
    volume: wireNumber(recordValue(value).volume ?? recordValue(value).v ?? 0, 'volume'), volumeUnits: family === 'inverse' ? 'quote' as const : 'base' as const, sourceTimestamp: start };
  validateCandle(candle); return candle;
}
/** Connector boundary. Disabled unless caller injects a transport and opts in. */
export class BybitConnector {
  networkEnabled: boolean;
  transport: AdapterTransport | null;
  constructor({ transport = null, networkEnabled = false }: AdapterOptions = {}) { this.transport = transport; this.networkEnabled = networkEnabled; }
  async request(kind: string, params: AdapterOptions = {}) { if (!this.networkEnabled || !this.transport?.request) throw new AdapterTransportError('Bybit network disabled; inject transport and set networkEnabled=true'); return this.transport.request(buildBybitRequest(kind, params)); }
  async subscribe(kind: string, params: AdapterOptions = {}) { if (!this.networkEnabled || !this.transport?.subscribe) throw new AdapterTransportError('Bybit network disabled; inject transport and set networkEnabled=true'); return this.transport.subscribe(buildBybitSubscription(kind, params)); }
}
