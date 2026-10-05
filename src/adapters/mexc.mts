import { recordValue, type AdapterOptions, type AdapterTransport, type WireRecord } from './common.mts';
import { AdapterTransportError, epochMs, finiteNumber, requireSymbol, sideLevels } from './common.mts';

/** MEXC contract-market public depth descriptors and pure normalizers. */
export const MEXC_CONTRACT_REST_URL = 'https://api.mexc.com';
export const MEXC_CONTRACT_WS_URL = 'wss://contract.mexc.com/edge';

function contract(value: unknown) {
  const native = requireSymbol(value).toUpperCase().replaceAll('-', '_');
  if (!/^[A-Z0-9]+_[A-Z0-9]+$/.test(native)) throw new TypeError('Invalid MEXC contract symbol');
  return native;
}

function instrumentId(value: unknown) { return `mexc:${contract(value)}`; }

function marketFor(value: unknown, metadata: WireRecord = {}) {
  const nativeSymbol = contract(value);
  const [basePart, quotePart = 'USDT'] = nativeSymbol.split('_');
  const contractValue = metadata.contractValue == null ? undefined : finiteNumber(metadata.contractValue, 'contractValue');
  return {
    venue: 'mexc', nativeSymbol, symbol: nativeSymbol,
    base: String(metadata.base ?? basePart).toUpperCase(), quote: String(metadata.quote ?? quotePart).toUpperCase(),
    marketType: 'perpetual', tickSize: metadata.tickSize ?? null, quantityUnit: 'contract',
    ...(contractValue != null && contractValue > 0 ? { contractValue } : {}),
  };
}

function assertMexc(payload: unknown) {
  if (recordValue(payload)?.success === false || (recordValue(payload)?.code != null && Number(recordValue(payload).code) !== 0)) {
    throw new Error(`MEXC provider error ${recordValue(payload).code ?? 'unknown'}: ${recordValue(payload).message ?? 'request failed'}`);
  }
  return payload;
}

function sequence(value: unknown, field: string) {
  if (typeof value === 'number' && !Number.isSafeInteger(value)) throw new TypeError(`MEXC ${field} is unsafe numeric; preserve the provider token as a string`);
  const text = String(value ?? '').trim();
  if (!/^\d+$/.test(text)) throw new TypeError(`MEXC ${field} missing or invalid`);
  const integer = BigInt(text);
  return integer <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(integer) : integer.toString();
}

function depthRows(values: unknown, field: string) {
  if (!Array.isArray(values)) throw new TypeError(`MEXC ${field} must be an array`);
  return values.map((row: unknown, index) => {
    const price = Array.isArray(row) ? row[0] : recordValue(row)?.price ?? recordValue(row)?.p;
    const amount = Array.isArray(row) ? row[1] : recordValue(row)?.amount ?? recordValue(row)?.v ?? recordValue(row)?.vol;
    if (price == null || amount == null) throw new TypeError(`MEXC ${field}[${index}] malformed`);
    return [finiteNumber(price, `${field}[${index}].price`), finiteNumber(amount, `${field}[${index}].amount`)];
  }).filter(([price, amount]) => price > 0 && amount >= 0);
}

export function buildMexcRequest(kind: string, { symbol = 'BTC_USDT', limit = 1_000, baseUrl = MEXC_CONTRACT_REST_URL }: AdapterOptions = {}) {
  const native = contract(symbol);
  if (kind === 'contracts') {
    return { url: `${baseUrl}/api/v1/contract/detail?symbol=${encodeURIComponent(native)}`, method: 'GET', headers: { accept: 'application/json' } };
  }
  if (kind === 'depth') return { url: `${baseUrl}/api/v1/contract/depth/${encodeURIComponent(native)}`, method: 'GET', headers: { accept: 'application/json' } };
  if (kind === 'depthSnapshot') {
    const bounded = Math.max(1, Math.min(1_000, Math.trunc(finiteNumber(limit, 'limit'))));
    return { url: `${baseUrl}/api/v1/contract/depth_commits/${encodeURIComponent(native)}/${bounded}`, method: 'GET', headers: { accept: 'application/json' } };
  }
  throw new RangeError(`Unsupported MEXC request: ${kind}`);
}

/** The full subscription is deliberately bounded to MEXC's documented 5/10/20
 * levels. It emits complete provider snapshots and avoids claiming that the
 * incremental channel is wired until its REST bridge is implemented. */
export function buildMexcSubscription(kind: string, { symbol = 'BTC_USDT', limit = 20 }: AdapterOptions = {}) {
  if (kind !== 'depth') throw new RangeError(`Unsupported MEXC subscription: ${kind}`);
  const native = contract(symbol);
  const depth = Math.trunc(finiteNumber(limit, 'limit'));
  if (![5, 10, 20].includes(depth)) throw new RangeError(`Unsupported MEXC full depth level: ${limit}`);
  return {
    url: MEXC_CONTRACT_WS_URL, method: 'sub.depth.full', param: { symbol: native, limit: depth },
    channel: 'push.depth.full', ackChannel: 'rs.sub.depth.full', topic: `push.depth.full:${native}`, symbol: native,
    depth, args: [native], snapshot: true,
  };
}

export function normalizeMexcContractInfo(payload: unknown, { symbol = null, receivedAt = Date.now() }: AdapterOptions = {}) {
  const result = recordValue(assertMexc(payload))?.data;
  const selected = symbol == null ? null : contract(symbol);
  const rows = Array.isArray(result) ? result : typeof recordValue(result).symbol === 'string' ? [result] : null;
  if (!rows) throw new TypeError('MEXC contract metadata must be an array or one contract object');
  if (selected && rows.some(row => typeof recordValue(row).symbol === 'string' && contract(recordValue(row).symbol) !== selected) && !Array.isArray(result)) throw new TypeError('MEXC selected contract metadata symbol mismatch');
  const assets = rows.filter((row: unknown) => Number(recordValue(row)?.state) === 0 && recordValue(row)?.symbol && (selected == null || String(recordValue(row).symbol).toUpperCase() === selected)).map((row: unknown) => {
    const native = contract(recordValue(row).symbol);
    const market = marketFor(native, {
      base: recordValue(row).baseCoin, quote: recordValue(row).quoteCoin,
      tickSize: recordValue(row).priceUnit == null ? undefined : finiteNumber(recordValue(row).priceUnit, 'priceUnit'),
      contractValue: recordValue(row).contractSize == null ? undefined : finiteNumber(recordValue(row).contractSize, 'contractSize'),
    });
    return {
      instrumentId: instrumentId(native), ...market, venue: 'mexc', isDelisted: false,
      status: 'online', tickSize: market.tickSize,
      lotSize: recordValue(row).volUnit == null ? undefined : finiteNumber(recordValue(row).volUnit, 'volUnit'),
      settleCoin: recordValue(row).settleCoin, metadataSource: 'mexc-contract-detail',
    };
  });
  return { kind: 'metadata' as const, venue: 'mexc', sourceTimestamp: epochMs(recordValue(payload)?.ts, receivedAt), receivedAt, assets };
}

export function normalizeMexcDepth(payload: unknown, { symbol = null, receivedAt = Date.now(), snapshot = true, depth = 20, contractValue = undefined }: AdapterOptions = {}) {
  const envelope = assertMexc(payload);
  const row = recordValue(envelope)?.data ?? recordValue(envelope)?.result ?? envelope;
  const native = contract(symbol ?? recordValue(envelope)?.symbol ?? recordValue(row)?.symbol);
  if (recordValue(envelope)?.channel != null && String(recordValue(envelope).channel) !== (snapshot ? 'push.depth.full' : 'push.depth')) throw new TypeError(`MEXC depth channel unsupported: ${recordValue(envelope).channel}`);
  if (recordValue(envelope)?.symbol != null && contract(recordValue(envelope).symbol) !== native) throw new TypeError('MEXC depth symbol mismatch');
  const version = sequence(recordValue(row)?.version, 'depth version');
  const market = marketFor(native, { contractValue });
  const asks = depthRows(recordValue(row)?.asks, 'asks'); const bids = depthRows(recordValue(row)?.bids, 'bids');
  const boundedDepth = Math.max(1, Math.min(1_000, Math.trunc(Number(depth) || 20)));
  const common = {
    venue: 'mexc', instrumentId: instrumentId(native), nativeSymbol: native, market, units: market.quantityUnit,
    ...(market.contractValue != null ? { contractValue: market.contractValue } : {}),
    sourceTimestamp: epochMs(recordValue(envelope)?.ts ?? recordValue(row)?.timestamp, receivedAt), receivedAt, sequence: version,
    continuity: snapshot ? 'provider-snapshot' : 'strict',
  };
  const output = {
    kind: snapshot ? 'depthSnapshot' : 'depthDelta', ...common,
    ...(snapshot ? { complete: true, coverage: 'partial' as const } : {}),
    bids: sideLevels(bids.slice(0, boundedDepth), 'bids'), asks: sideLevels(asks.slice(0, boundedDepth), 'asks'),
  };
  return output;
}

export class MexcConnector {
  networkEnabled: boolean;
  transport: AdapterTransport | null;
  constructor({ transport = null, networkEnabled = false }: AdapterOptions = {}) { this.transport = transport; this.networkEnabled = networkEnabled; }
  async request(kind: string, params: AdapterOptions = {}) { if (!this.networkEnabled || !this.transport?.request) throw new AdapterTransportError('MEXC network disabled; inject transport and set networkEnabled=true'); return this.transport.request(buildMexcRequest(kind, params)); }
  async subscribe(kind: string, params: AdapterOptions = {}) { if (!this.networkEnabled || !this.transport?.subscribe) throw new AdapterTransportError('MEXC network disabled; inject transport and set networkEnabled=true'); return this.transport.subscribe(buildMexcSubscription(kind, params)); }
}
