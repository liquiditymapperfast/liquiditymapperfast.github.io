import { recordValue, arrayValue, type AdapterOptions, type AdapterTransport, type WireRecord } from './common.mts';
import { AdapterTransportError, epochMs, finiteNumber, requireSymbol, sideLevels } from './common.mts';

/** OKX public market-data descriptors and pure normalizers. */
export const OKX_REST_URL = 'https://www.okx.com';
export const OKX_PUBLIC_WS_URL = 'wss://ws.okx.com:8443/ws/v5/public';

function instId(value: unknown) { return requireSymbol(value).toUpperCase(); }
export function okxInstrumentId(value: unknown) { return `okx:${instId(value)}`; }
function assertOkx(payload: unknown) { if (recordValue(payload)?.code != null && String(recordValue(payload).code) !== '0') throw new Error(`OKX provider error ${recordValue(payload).code}: ${recordValue(payload).msg ?? 'request failed'}`); return payload; }
function dataOf(payload: unknown) { return recordValue(assertOkx(payload))?.data ?? []; }
function marketFor(value: unknown, metadata: { base?: unknown; quote?: unknown; tickSize?: unknown; contractValue?: number; quantityUnit?: 'base' | 'quote' | 'contract'; contractType?: 'linear' | 'inverse'; inverse?: boolean; contractValueCurrency?: string; settleCoin?: string } = {}) {
  const nativeSymbol = instId(value); const parts = nativeSymbol.split('-');
  const derivative = /-(SWAP|FUTURES?)$/.test(nativeSymbol);
  const marketType = derivative ? (nativeSymbol.endsWith('-SWAP') ? 'perpetual' : 'delivery') : 'spot';
  // OKX swap descriptors can leave baseCcy/quoteCcy empty. Empty metadata is
  // not an override: the instrument id still gives us the BTC/USDT identity.
  const explicitBase = String(metadata.base ?? '').trim();
  const explicitQuote = String(metadata.quote ?? '').trim();
  const base = (explicitBase || parts[0] || nativeSymbol).toUpperCase();
  const quote = (explicitQuote || parts[1] || 'USDT').toUpperCase();
  return { venue: 'okx', nativeSymbol, symbol: nativeSymbol, base, quote, marketType, tickSize: metadata.tickSize ?? null, quantityUnit: metadata.quantityUnit ?? (derivative ? 'contract' as const : 'base' as const), ...(metadata.contractValue != null ? { contractValue: metadata.contractValue } : {}), ...(metadata.contractType == null ? {} : { contractType: metadata.contractType, inverse: metadata.inverse === true, contractValueCurrency: metadata.contractValueCurrency, settleCoin: metadata.settleCoin }) };
}
function okxFamily({ instType, marketType }: AdapterOptions = {}, native?: unknown) {
  const inferred = marketType === 'spot' ? 'SPOT' : marketType === 'perpetual' ? 'SWAP' : undefined;
  if (marketType != null && !inferred) throw new RangeError(`Unsupported OKX market type: ${marketType}`);
  const type = String(instType ?? inferred ?? (native != null ? (String(native).toUpperCase().endsWith('-SWAP') ? 'SWAP' : 'SPOT') : 'SWAP')).toUpperCase();
  if (!['SPOT', 'SWAP'].includes(type) || (inferred && inferred !== type)) throw new RangeError(`Inconsistent or unsupported OKX family: ${type}`);
  return type;
}
function positiveMetadata(value: unknown, field: string) {
  if ((typeof value !== 'string' && typeof value !== 'number') || String(value).trim() === '') throw new TypeError(`OKX ${field} missing`);
  const number = finiteNumber(value, field);
  if (!(number > 0)) throw new TypeError(`OKX ${field} must be positive`);
  return number;
}
function verifiedSpotMetadata(value: unknown, native: string) {
  const metadata = recordValue(value);
  if (metadata.venue !== 'okx' || metadata.nativeSymbol !== native || metadata.instrumentId !== okxInstrumentId(native)
    || metadata.marketType !== 'spot' || metadata.instType !== 'SPOT' || metadata.quantityUnit !== 'base' || metadata.isDelisted !== false || metadata.status !== 'live') {
    throw new TypeError('OKX spot depth requires matching verified active instrument metadata');
  }
  const base = requireSymbol(metadata.base); const quote = requireSymbol(metadata.quote);
  if (`${base}-${quote}` !== native) throw new TypeError('OKX spot metadata currency identity mismatch');
  return { base, quote, tickSize: positiveMetadata(metadata.tickSize, 'tickSize'), lotSize: positiveMetadata(metadata.lotSize ?? metadata.qtyStep, 'lotSize') };
}

function swapContractBasis(native: string, value: unknown): { contractType: 'linear' | 'inverse'; inverse: boolean; contractValueCurrency: string; settleCoin: string; contractValue: number } {
  const metadata = recordValue(value); const parts = native.split('-');
  if (parts.length !== 3 || parts[2] !== 'SWAP') throw new TypeError('OKX SWAP native identity mismatch');
  const base = requireSymbol(parts[0]); const quote = requireSymbol(parts[1]);
  const faceCurrency = requireSymbol(metadata.contractValueCurrency ?? metadata.ctValCcy);
  const explicitType = metadata.contractType ?? metadata.ctType;
  // An omitted ctType can only be inferred from the explicit face currency,
  // following OKX public instruments' documented base/quote denomination.
  const type = explicitType == null || explicitType === ''
    ? faceCurrency === base && base !== quote ? 'linear' : faceCurrency === quote && base !== quote ? 'inverse' : null
    : explicitType;
  if (type !== 'linear' && type !== 'inverse') throw new TypeError('OKX SWAP contract basis missing or unsupported');
  const inverse = type === 'inverse'; const settle = requireSymbol(metadata.settleCoin ?? metadata.settleCcy);
  if (faceCurrency !== (inverse ? quote : base) || settle !== (inverse ? base : quote)
    || (inverse && quote !== 'USD') || (metadata.inverse != null && metadata.inverse !== inverse)
    || (metadata.base != null && metadata.base !== '' && metadata.base !== base)
    || (metadata.quote != null && metadata.quote !== '' && metadata.quote !== quote)
    || (metadata.baseCcy != null && metadata.baseCcy !== '' && metadata.baseCcy !== base)
    || (metadata.quoteCcy != null && metadata.quoteCcy !== '' && metadata.quoteCcy !== quote)) throw new TypeError('OKX SWAP contract face/settlement metadata mismatch');
  return { contractType: type, inverse, contractValueCurrency: faceCurrency, settleCoin: settle,
    contractValue: positiveMetadata(metadata.contractValue ?? metadata.ctVal, 'SWAP contract value') };
}

function normalizeSequence(value: unknown, field: string, { allowZero = true }: AdapterOptions = {}) {
  if (typeof value === 'number' && !Number.isSafeInteger(value)) throw new TypeError(`OKX ${field} is unsafe numeric; preserve the provider token as a string`);
  const text = String(value ?? '').trim(); if (!/^\d+$/.test(text)) throw new TypeError(`OKX ${field} missing or invalid`);
  const integer = BigInt(text); if ((!allowZero && integer <= 0n) || integer < 0n) throw new TypeError(`OKX ${field} missing or invalid`);
  return integer <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(integer) : integer.toString();
}

export function buildOkxRequest(kind: string, { instId: instrument, instType, marketType, size = 400, baseUrl = OKX_REST_URL }: AdapterOptions = {}) {
  const type = okxFamily({ instType, marketType }); const query = new URLSearchParams();
  if (kind === 'instruments') { query.set('instType', type); if (instrument != null) query.set('instId', instId(instrument)); }
  else if (kind === 'depth') { query.set('instId', instId(instrument)); query.set('sz', String(Math.max(1, Math.min(400, Math.trunc(finiteNumber(size, 'size')))))); }
  else throw new RangeError(`Unsupported OKX request: ${kind}`);
  return { url: `${baseUrl}${kind === 'instruments' ? '/api/v5/public/instruments' : '/api/v5/market/books'}?${query}`, method: 'GET', headers: { accept: 'application/json' } };
}

export function buildOkxSubscription(kind: string, { instId: instrument, instType, marketType, channel = 'books' }: AdapterOptions = {}) {
  if (kind !== 'depth') throw new RangeError(`Unsupported OKX subscription: ${kind}`);
  const id = instId(instrument); const type = okxFamily({ instType, marketType }, id);
  if ((type === 'SPOT') !== !id.endsWith('-SWAP')) throw new TypeError('OKX subscription instrument/family mismatch');
  const value = { channel: String(channel), instId: id };
  return { url: OKX_PUBLIC_WS_URL, method: 'subscribe', args: [value], topic: `${value.channel}:${id}`, channel: value.channel, instId: id };
}

function normalizePreviousSequence(value: unknown, field: string) {
  if (value == null) return { previousSequence: undefined, sequenceReset: false };
  if (String(value).trim() === '-1') return { previousSequence: undefined, sequenceReset: true };
  return { previousSequence: normalizeSequence(value, field), sequenceReset: false };
}

export function normalizeOkxDepth(payload: unknown, { instId: instrument, instType, marketType, metadata, contractValue, receivedAt = Date.now() }: AdapterOptions = {}) {
  const envelope = assertOkx(payload); const row = recordValue((Array.isArray(recordValue(envelope)?.data) ? arrayValue(recordValue(envelope).data)[0] : recordValue(envelope)?.data) ?? envelope);
  const native = instrument ?? row?.instId ?? recordValue(recordValue(envelope)?.arg)?.instId; if (!native) throw new TypeError('OKX depth instrument missing');
  const asks = row?.asks ?? row?.a; const bids = row?.bids ?? row?.b;
  if (!Array.isArray(asks) || !Array.isArray(bids)) throw new TypeError('OKX depth bids/asks missing');
  const action = String(recordValue(envelope)?.action ?? 'snapshot').toLowerCase();
  const sourceTimestamp = epochMs(row?.ts ?? recordValue(envelope)?.ts, receivedAt);
  const id = instId(native); const family = okxFamily({ instType, marketType }, id);
  const wireId = recordValue(recordValue(envelope)?.arg)?.instId ?? row.instId;
  if ((wireId != null && instId(wireId) !== id) || (row.instId != null && instId(row.instId) !== id)) throw new TypeError('OKX depth instrument mismatch');
  if ((family === 'SPOT') !== !id.endsWith('-SWAP')) throw new TypeError('OKX depth instrument/family mismatch');
  if (family === 'SPOT' && contractValue != null) throw new TypeError('OKX spot quantities cannot use a contract value');
  const selected: WireRecord = family === 'SPOT' ? verifiedSpotMetadata(metadata, id) : recordValue(metadata);
  const faceValue = contractValue ?? selected.contractValue;
  if (family === 'SWAP' && metadata != null && (selected.venue !== 'okx' || selected.instrumentId !== okxInstrumentId(id)
    || selected.nativeSymbol !== id || selected.instType !== 'SWAP' || selected.marketType !== 'perpetual'
    || selected.quantityUnit !== 'contract' || selected.status !== 'live' || selected.isDelisted !== false)) throw new TypeError('OKX SWAP depth requires matching active verified metadata');
  const basis = family === 'SWAP' && faceValue != null ? swapContractBasis(id, { ...selected, contractValue: faceValue }) : undefined;
  if (contractValue != null && selected.contractValue != null && contractValue !== selected.contractValue) throw new TypeError('OKX SWAP contract value override mismatch');
  const market = marketFor(id, { base: selected.base, quote: selected.quote, tickSize: selected.tickSize,
    ...basis, quantityUnit: family === 'SPOT' ? 'base' : 'contract' });
  if (action === 'snapshot') return { kind: 'depthSnapshot' as const, venue: 'okx', instrumentId: okxInstrumentId(native), nativeSymbol: market.nativeSymbol, market, units: market.quantityUnit, ...(market.contractValue != null ? { contractValue: market.contractValue } : {}), sourceTimestamp, receivedAt, sequence: normalizeSequence(row?.seqId ?? row?.seq, 'snapshot sequence'), complete: true, coverage: 'partial' as const, bids: sideLevels(bids, 'bids'), asks: sideLevels(asks, 'asks') };
  if (action !== 'update') throw new TypeError(`OKX depth action unsupported: ${action}`);
  const predecessor = normalizePreviousSequence(row?.prevSeqId ?? row?.prevSeq, 'previous sequence');
  return { kind: 'depthDelta' as const, venue: 'okx', instrumentId: okxInstrumentId(native), nativeSymbol: market.nativeSymbol, market, units: market.quantityUnit, ...(market.contractValue != null ? { contractValue: market.contractValue } : {}), sourceTimestamp, receivedAt, sequence: normalizeSequence(row?.seqId ?? row?.seq, 'update sequence'), ...predecessor, bids: sideLevels(bids, 'bids'), asks: sideLevels(asks, 'asks') };
}

export function normalizeOkxInstrumentInfo(payload: unknown, { instId: instrument, instType, marketType, receivedAt = Date.now() }: AdapterOptions = {}) {
  const family = okxFamily({ instType, marketType });
  const selectedId = instrument == null ? null : instId(instrument);
  const rows = dataOf(payload); if (!Array.isArray(rows)) throw new TypeError('OKX instruments must be an array');
  const assets = rows.filter((raw: unknown) => {
    const row = recordValue(raw);
    return String(row.instType ?? '').toUpperCase() === family && String(row.state ?? '').toLowerCase() === 'live'
      && (selectedId === null || instId(row.instId) === selectedId);
  }).map((raw: unknown) => {
    const row = recordValue(raw); const id = instId(row.instId); const spot = family === 'SPOT';
    if (spot && id !== `${requireSymbol(row.baseCcy)}-${requireSymbol(row.quoteCcy)}`) throw new TypeError('OKX spot metadata currency identity mismatch');
    if ((spot && id.endsWith('-SWAP')) || (!spot && !id.endsWith('-SWAP'))) throw new TypeError('OKX metadata instrument/family mismatch');
    const tickSize = positiveMetadata(row.tickSz, 'tickSz');
    const lotSize = positiveMetadata(row.lotSz, 'lotSz');
    const basis = spot ? undefined : swapContractBasis(id, row);
    const market = marketFor(id, { base: row.baseCcy, quote: row.quoteCcy, tickSize,
      ...basis, quantityUnit: spot ? 'base' : 'contract' });
    return { instrumentId: okxInstrumentId(id), ...market, venue: 'okx', isDelisted: false,
      status: 'live', instType: family, metadataSource: 'okx-v5-public-instruments',
      tickSize: market.tickSize, lotSize, qtyStep: lotSize, minOrderSize: row.minSz == null || row.minSz === '' ? undefined : positiveMetadata(row.minSz, 'minSz'), settleCoin: basis?.settleCoin ?? row.settleCcy };
  });
  return { kind: 'metadata' as const, venue: 'okx', sourceTimestamp: epochMs(recordValue(payload)?.ts, receivedAt), receivedAt, assets };
}

export class OkxConnector {
  networkEnabled: boolean;
  transport: AdapterTransport | null;
  constructor({ transport = null, networkEnabled = false }: AdapterOptions = {}) { this.transport = transport; this.networkEnabled = networkEnabled; }
  async request(kind: string, params: AdapterOptions = {}) { if (!this.networkEnabled || !this.transport?.request) throw new AdapterTransportError('OKX network disabled; inject transport and set networkEnabled=true'); return this.transport.request(buildOkxRequest(kind, params)); }
  async subscribe(kind: string, params: AdapterOptions = {}) { if (!this.networkEnabled || !this.transport?.subscribe) throw new AdapterTransportError('OKX network disabled; inject transport and set networkEnabled=true'); return this.transport.subscribe(buildOkxSubscription(kind, params)); }
}
