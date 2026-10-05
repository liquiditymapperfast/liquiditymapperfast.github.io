import { recordValue, arrayValue, type AdapterOptions, type AdapterTransport, type WireRecord } from './common.mts';
import { AdapterTransportError, epochMs, finiteNumber, requireSymbol, sideLevels } from './common.mts';

/** Bitget UTA public market-data descriptors and pure normalizers. */
export const BITGET_REST_URL = 'https://api.bitget.com';
export const BITGET_PUBLIC_WS_URL = 'wss://ws.bitget.com/v3/ws/public';

function symbol(value: unknown) { return requireSymbol(value).toUpperCase(); }
export function bitgetInstrumentId(value: unknown, instType: unknown = 'usdt-futures') { return `bitget:${symbol(value)}${categoryValue(instType) === 'SPOT' ? ':spot' : ''}`; }
function marketFor(value: unknown, instType: unknown = 'usdt-futures', metadata: { base?: unknown; quote?: unknown; tickSize?: unknown } = {}) {
  const nativeSymbol = symbol(value); const type = String(instType).toLowerCase(); const derivative = type.includes('futures');
  const quote = metadata.quote ? String(metadata.quote).toUpperCase() : type === 'coin-futures' ? 'USD' : type === 'usdc-futures' ? 'USDC' : /USDC$/.test(nativeSymbol) ? 'USDC' : /USD$/.test(nativeSymbol) ? 'USD' : 'USDT';
  const base = nativeSymbol.endsWith(quote) ? nativeSymbol.slice(0, -quote.length) : nativeSymbol.replace(/(USDT|USDC|USD)$/, '');
  return { venue: 'bitget', nativeSymbol, symbol: nativeSymbol, base: metadata.base ? String(metadata.base).toUpperCase() : (base || nativeSymbol), quote: metadata.quote ? String(metadata.quote).toUpperCase() : quote, marketType: derivative ? 'perpetual' : 'spot', tickSize: metadata.tickSize ?? null, quantityUnit: 'base' as const, inverse: false, contractType: null, contractValue: null };
}
function normalizeSequence(value: unknown, field: string) {
  if (typeof value === 'number' && !Number.isSafeInteger(value)) throw new TypeError(`Bitget ${field} is unsafe numeric; preserve the provider token as a string`);
  const text = String(value ?? '').trim(); if (!/^\d+$/.test(text)) throw new TypeError(`Bitget ${field} missing or invalid`);
  const integer = BigInt(text); return integer <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(integer) : integer.toString();
}

const BITGET_CATEGORIES = new Map([
  ['spot', 'SPOT'], ['margin', 'MARGIN'], ['usdt-futures', 'USDT-FUTURES'], ['usdt_futures', 'USDT-FUTURES'],
  ['coin-futures', 'COIN-FUTURES'], ['coin_futures', 'COIN-FUTURES'], ['usdc-futures', 'USDC-FUTURES'], ['usdc_futures', 'USDC-FUTURES'],
]);
function categoryValue(value: unknown) {
  const key = String(value ?? 'usdt-futures').trim().toLowerCase();
  const category = BITGET_CATEGORIES.get(key) ?? BITGET_CATEGORIES.get(key.replaceAll('_', '-'));
  if (category !== 'SPOT' && category !== 'USDT-FUTURES') throw new RangeError(`Unsupported shipped Bitget category: ${value}`);
  return category;
}

function bitgetFamily({ instType, category, marketType }: AdapterOptions = {}) {
  const inferred = marketType === 'spot' ? 'SPOT' : marketType === 'perpetual' ? 'USDT-FUTURES' : undefined;
  if (marketType != null && !inferred) throw new RangeError(`Unsupported Bitget market type: ${marketType}`);
  const type = categoryValue(category ?? instType ?? inferred);
  if (category != null && instType != null && categoryValue(category) !== categoryValue(instType)) throw new RangeError('Bitget category/instType mismatch');
  if ((marketType === 'spot' && type !== 'SPOT') || (marketType === 'perpetual' && !type.includes('FUTURES'))) throw new RangeError('Bitget category/marketType mismatch');
  return type;
}
function positiveMetadata(value: unknown, field: string) {
  if ((typeof value !== 'string' && typeof value !== 'number') || String(value).trim() === '') throw new TypeError(`Bitget ${field} missing`);
  const number = finiteNumber(value, field);
  if (!(number > 0)) throw new TypeError(`Bitget ${field} must be positive`);
  return number;
}
function precisionValue(value: unknown, field: string) {
  if ((typeof value !== 'string' && typeof value !== 'number') || !/^\d{1,2}$/.test(String(value).trim())) throw new TypeError(`Bitget ${field} missing or invalid`);
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 0 || number > 18) throw new TypeError(`Bitget ${field} outside supported decimal precision`);
  return number;
}
function verifiedSpotMetadata(value: unknown, native: string): WireRecord {
  const metadata = recordValue(value);
  if (metadata.venue !== 'bitget' || metadata.nativeSymbol !== native || metadata.instrumentId !== bitgetInstrumentId(native, 'spot')
    || metadata.marketType !== 'spot' || metadata.quantityUnit !== 'base' || metadata.isDelisted !== false || metadata.status !== 'online'
    || categoryValue(metadata.category ?? metadata.instType) !== 'SPOT') throw new TypeError('Bitget spot depth requires matching verified active instrument metadata');
  const base = requireSymbol(metadata.base); const quote = requireSymbol(metadata.quote);
  if (`${base}${quote}` !== native) throw new TypeError('Bitget spot metadata currency identity mismatch');
  return { base, quote, tickSize: positiveMetadata(metadata.tickSize, 'tickSize'), lotSize: positiveMetadata(metadata.lotSize ?? metadata.qtyStep, 'lotSize') };
}
function depthMarket(native: string, family: string, metadata: unknown, contractValue?: number | null) {
  const selected = family === 'SPOT' ? verifiedSpotMetadata(metadata, native) : recordValue(metadata);
  // UTA instruments documents USDT futures order quantities in base coin.
  // quantityMultiplier is an increment, never a contract face value.
  if (contractValue != null || selected.contractValue != null) throw new TypeError('Bitget base quantities cannot use a contract value');
  if (family === 'USDT-FUTURES' && (!native.endsWith('USDT')
    || (selected.nativeSymbol != null && selected.nativeSymbol !== native)
    || (selected.quantityUnit != null && selected.quantityUnit !== 'base')
    || (selected.quote != null && selected.quote !== 'USDT'))) throw new TypeError('Bitget USDT futures quantity metadata mismatch');
  return marketFor(native, family, { base: selected.base, quote: selected.quote, tickSize: selected.tickSize });
}

export function buildBitgetRequest(kind: string, { symbol: instrument, category, instType, marketType, limit = 200, baseUrl = BITGET_REST_URL }: AdapterOptions = {}) {
  const canonicalCategory = bitgetFamily({ category, instType, marketType });
  const query = new URLSearchParams({ category: canonicalCategory });
  if (kind === 'depth') {
    query.set('symbol', symbolValue(instrument));
    query.set('limit', String(Math.max(1, Math.min(1000, Math.trunc(finiteNumber(limit, 'limit'))))));
    return { url: `${baseUrl}/api/v3/market/orderbook?${query}`, method: 'GET', headers: { accept: 'application/json' } };
  }
  if (kind === 'instruments') {
    if (instrument != null) query.set('symbol', symbolValue(instrument));
    return { url: `${baseUrl}/api/v3/market/instruments?${query}`, method: 'GET', headers: { accept: 'application/json' } };
  }
  throw new RangeError(`Unsupported Bitget request: ${kind}`);
}
function symbolValue(value: unknown) { return symbol(value); }

export function normalizeBitgetInstrumentInfo(payload: unknown, { symbol: instrument, category, instType, marketType, receivedAt = Date.now() }: AdapterOptions = {}) {
  const canonicalCategory = bitgetFamily({ category, instType, marketType }); const spot = canonicalCategory === 'SPOT';
  const selectedSymbol = instrument == null ? null : symbol(instrument);
  if (recordValue(payload)?.code != null && !['0', '00000'].includes(String(recordValue(payload).code))) throw new Error(`Bitget provider error ${recordValue(payload).code}: ${recordValue(payload).msg ?? 'request failed'}`);
  const rawRows = Array.isArray(recordValue(payload)?.data) ? recordValue(payload).data : recordValue(payload)?.data ? [recordValue(payload).data] : [];
  const assets = arrayValue(rawRows).filter((raw: unknown) => {
    const row = recordValue(raw); const rowCategory = String(row.category ?? '').toUpperCase();
    return rowCategory === canonicalCategory && String(row.status ?? '').toLowerCase() === 'online'
      && (selectedSymbol === null || symbol(row.symbol) === selectedSymbol);
  }).map((raw: unknown) => {
    const row = recordValue(raw); const nativeSymbol = symbol(row.symbol);
    if (`${requireSymbol(row.baseCoin)}${requireSymbol(row.quoteCoin)}` !== nativeSymbol || (!spot && requireSymbol(row.quoteCoin) !== 'USDT')) throw new TypeError('Bitget spot metadata currency identity mismatch');
    const pricePrecision = row.pricePrecision == null ? undefined : precisionValue(row.pricePrecision, 'pricePrecision');
    const quantityPrecision = row.quantityPrecision == null ? undefined : precisionValue(row.quantityPrecision, 'quantityPrecision');
    // UTA documents multipliers only for futures. Spot decimal precision is
    // the tick/quantity increment; minOrderQty is not an order-size step.
    const tickSize = spot ? Number(`1e-${precisionValue(row.pricePrecision, 'pricePrecision')}`) : positiveMetadata(row.priceMultiplier, 'priceMultiplier');
    const lotSize = spot ? Number(`1e-${precisionValue(row.quantityPrecision, 'quantityPrecision')}`) : positiveMetadata(row.quantityMultiplier, 'quantityMultiplier');
    const market = marketFor(nativeSymbol, canonicalCategory, { base: row.baseCoin, quote: row.quoteCoin, tickSize });
    return { instrumentId: bitgetInstrumentId(nativeSymbol, canonicalCategory), ...market, venue: 'bitget', isDelisted: false,
      status: 'online', instType: canonicalCategory.toLowerCase(), category: canonicalCategory,
      tickSize: market.tickSize, lotSize, qtyStep: lotSize,
      quantityMultiplier: spot ? undefined : positiveMetadata(row.quantityMultiplier, 'quantityMultiplier'),
      pricePrecision, quantityPrecision, quotePrecision: row.quotePrecision == null || (!spot && typeof row.quotePrecision === 'string' && row.quotePrecision.trim() === '') ? undefined : precisionValue(row.quotePrecision, 'quotePrecision'),
      minOrderQty: row.minOrderQty == null || row.minOrderQty === '' ? undefined : positiveMetadata(row.minOrderQty, 'minOrderQty'),
      minOrderAmount: row.minOrderAmount == null || row.minOrderAmount === '' ? undefined : positiveMetadata(row.minOrderAmount, 'minOrderAmount'),
      metadataSource: 'bitget-v3-market-instruments' };
  });
  return { kind: 'metadata' as const, venue: 'bitget', sourceTimestamp: epochMs(recordValue(payload)?.requestTime, receivedAt), receivedAt, assets };
}

export function buildBitgetSubscription(kind: string, { symbol: instrument, instType, category, marketType, topic = 'books' }: AdapterOptions = {}) {
  if (kind !== 'depth') throw new RangeError(`Unsupported Bitget subscription: ${kind}`);
  const value = { instType: bitgetFamily({ instType, category, marketType }).toLowerCase(), topic: String(topic), symbol: symbolValue(instrument) };
  return { url: BITGET_PUBLIC_WS_URL, method: 'subscribe', args: [value], topic: `${value.topic}:${value.symbol}`, channel: value.topic, instType: value.instType, symbol: value.symbol };
}

function envelopeData(payload: unknown) {
  if (recordValue(payload)?.code != null && !['0', '00000'].includes(String(recordValue(payload).code))) throw new Error(`Bitget provider error ${recordValue(payload).code}: ${recordValue(payload).msg ?? 'request failed'}`);
  if (Array.isArray(recordValue(payload)?.data)) return recordValue(arrayValue(recordValue(payload).data)[0] ?? {});
  return recordValue(recordValue(payload)?.data ?? payload);
}

export function normalizeBitgetDepth(payload: unknown, { symbol: instrument, instType, category, marketType, metadata, contractValue, receivedAt = Date.now() }: AdapterOptions = {}) {
  const row = envelopeData(payload); const arg = recordValue(payload)?.arg ?? {}; const native = symbol(instrument ?? recordValue(arg).symbol ?? recordValue(arg).instId ?? row?.symbol);
  const asks = row?.asks ?? row?.a; const bids = row?.bids ?? row?.b;
  if (!Array.isArray(asks) || !Array.isArray(bids)) throw new TypeError('Bitget depth bids/asks missing');
  const family = bitgetFamily({ instType: instType ?? (category == null && marketType == null ? String(recordValue(arg).instType ?? 'usdt-futures') : undefined), category, marketType });
  const wireId = recordValue(arg).symbol ?? recordValue(arg).instId ?? row.symbol;
  if ((wireId != null && symbol(wireId) !== native) || (row.symbol != null && symbol(row.symbol) !== native)) throw new TypeError('Bitget depth instrument mismatch');
  if (recordValue(arg).instType != null && categoryValue(recordValue(arg).instType) !== family) throw new TypeError('Bitget depth family mismatch');
  const action = String(recordValue(payload)?.action ?? 'snapshot').toLowerCase(); const market = depthMarket(native, family, metadata, contractValue); const sourceTimestamp = epochMs(row?.ts ?? recordValue(payload)?.ts, receivedAt);
  if (action === 'snapshot') return { kind: 'depthSnapshot' as const, venue: 'bitget', instrumentId: bitgetInstrumentId(native, family), nativeSymbol: market.nativeSymbol, market, units: market.quantityUnit, ...(market.contractValue != null ? { contractValue: market.contractValue } : {}), sourceTimestamp, receivedAt, sequence: normalizeSequence(row?.seq ?? row?.seqNum, 'snapshot sequence'), complete: true, coverage: 'partial' as const, bids: sideLevels(bids, 'bids'), asks: sideLevels(asks, 'asks') };
  if (action !== 'update') throw new TypeError(`Bitget depth action unsupported: ${action}`);
  const previous = row?.pseq ?? row?.previousSeq ?? row?.prevSeq ?? row?.prevSeqNum;
  return { kind: 'depthDelta' as const, venue: 'bitget', instrumentId: bitgetInstrumentId(native, family), nativeSymbol: market.nativeSymbol, market, units: market.quantityUnit, ...(market.contractValue != null ? { contractValue: market.contractValue } : {}), sourceTimestamp, receivedAt, sequence: normalizeSequence(row?.seq ?? row?.seqNum, 'update sequence'), previousSequence: previous == null ? undefined : normalizeSequence(previous, 'previous sequence'), bids: sideLevels(bids, 'bids'), asks: sideLevels(asks, 'asks') };
}

/** REST orderbook snapshots have no sequence token; keep them separate from
 * the sequenced WS reducer so callers cannot silently claim continuity. */
export function normalizeBitgetRestDepth(payload: unknown, { symbol: instrument, category, instType, marketType, metadata, receivedAt = Date.now() }: AdapterOptions = {}) {
  const row = envelopeData(payload); const native = symbol(instrument ?? row?.symbol); const asks = row?.asks ?? row?.a; const bids = row?.bids ?? row?.b;
  if (!Array.isArray(asks) || !Array.isArray(bids)) throw new TypeError('Bitget REST depth bids/asks missing');
  if (row.symbol != null && symbol(row.symbol) !== native) throw new TypeError('Bitget REST depth instrument mismatch');
  const family = bitgetFamily({ category, instType, marketType }); const market = depthMarket(native, family, metadata); const sourceTimestamp = epochMs(row?.ts ?? recordValue(payload)?.requestTime, receivedAt);
  return { kind: 'depthSnapshot' as const, venue: 'bitget', instrumentId: bitgetInstrumentId(native, family), nativeSymbol: market.nativeSymbol, market, units: market.quantityUnit, sourceTimestamp, receivedAt, complete: true, coverage: 'partial' as const, continuity: 'rest-snapshot', bids: sideLevels(bids, 'bids'), asks: sideLevels(asks, 'asks') };
}

export class BitgetConnector {
  networkEnabled: boolean;
  transport: AdapterTransport | null;
  constructor({ transport = null, networkEnabled = false }: AdapterOptions = {}) { this.transport = transport; this.networkEnabled = networkEnabled; }
  async request(kind: string, params: AdapterOptions = {}) { if (!this.networkEnabled || !this.transport?.request) throw new AdapterTransportError('Bitget network disabled; inject transport and set networkEnabled=true'); return this.transport.request(buildBitgetRequest(kind, params)); }
  async subscribe(kind: string, params: AdapterOptions = {}) { if (!this.networkEnabled || !this.transport?.subscribe) throw new AdapterTransportError('Bitget network disabled; inject transport and set networkEnabled=true'); return this.transport.subscribe(buildBitgetSubscription(kind, params)); }
}
