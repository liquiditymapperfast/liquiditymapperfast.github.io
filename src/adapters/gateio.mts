import { recordValue, type AdapterOptions, type AdapterTransport, type WireRecord } from './common.mts';
import { AdapterTransportError, epochMs, finiteNumber, requireSymbol } from './common.mts';

/** Gate.io public USDT-futures order-book descriptors and pure normalizers. */
export const GATEIO_REST_URL = 'https://api.gateio.ws';
export const GATEIO_USDT_WS_URL = 'wss://fx-ws.gateio.ws/v4/ws/usdt';

function contract(value: unknown) {
  return requireSymbol(value).toUpperCase().replaceAll('-', '_');
}
function gateInstrumentId(value: unknown) { return `gateio:${contract(value)}`; }
function marketFor(value: unknown, metadata: WireRecord = {}) {
  const nativeSymbol = contract(value);
  const [basePart, quotePart = 'USDT'] = nativeSymbol.split('_');
  const base = String(metadata.base ?? basePart ?? nativeSymbol).toUpperCase();
  const quote = String(metadata.quote ?? quotePart).toUpperCase();
  const contractValue = metadata.contractValue == null ? undefined : finiteNumber(metadata.contractValue, 'contractValue');
  return {
    venue: 'gateio', nativeSymbol, symbol: nativeSymbol, base, quote,
    marketType: 'perpetual', tickSize: metadata.tickSize ?? null,
    quantityUnit: 'contract' as const, ...(contractValue != null && contractValue > 0 ? { contractValue } : {}),
  };
}
function assertGate(payload: unknown) {
  if (recordValue(payload)?.error || recordValue(payload)?.code != null && !['0', '200'].includes(String(recordValue(payload).code))) {
    throw new Error(`Gate.io provider error ${recordValue(payload).code ?? recordValue(payload).error ?? 'request failed'}: ${recordValue(payload).message ?? recordValue(payload).msg ?? ''}`.trim());
  }
  return payload;
}
function sequence(value: unknown, field: string) {
  if (typeof value === 'number' && !Number.isSafeInteger(value)) throw new TypeError(`Gate.io ${field} is unsafe numeric; preserve the provider token as a string`);
  const text = String(value ?? '').trim();
  if (!/^\d+$/.test(text)) throw new TypeError(`Gate.io ${field} missing or invalid`);
  const integer = BigInt(text);
  return integer <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(integer) : integer.toString();
}
function sideLevels(values: unknown, field: string) {
  if (!Array.isArray(values)) throw new TypeError(`Invalid Gate.io ${field}: expected array`);
  return values.map((row: unknown, index) => {
    const price = Array.isArray(row) ? row[0] : recordValue(row)?.p ?? recordValue(row)?.price;
    const amount = Array.isArray(row) ? row[1] : recordValue(row)?.s ?? recordValue(row)?.size ?? recordValue(row)?.amount;
    if (price == null || amount == null) throw new TypeError(`Invalid Gate.io ${field}[${index}]`);
    return { price: finiteNumber(price, `${field}[${index}].price`), amount: finiteNumber(amount, `${field}[${index}].amount`) };
  }).filter(row => row.price > 0 && row.amount >= 0);
}
function resultOf(payload: unknown) {
  const envelope = assertGate(payload);
  return recordValue(envelope)?.result ?? recordValue(envelope)?.data ?? envelope;
}

export function buildGateRequest(kind: string, { contract: instrument = 'BTC_USDT', settle = 'usdt', limit = 100, withId = true, baseUrl = GATEIO_REST_URL }: AdapterOptions = {}) {
  const settlement = String(settle).toLowerCase();
  const symbol = instrument == null && kind === 'contracts' ? null : contract(instrument);
  if (kind === 'contracts') {
    // The selected-contract endpoint returns one bounded object. The old
    // ?contract query is not a documented filter and returns the full catalog.
    const suffix = instrument == null ? '' : '/' + encodeURIComponent(String(symbol));
    return { url: `${baseUrl}/api/v4/futures/${settlement}/contracts${suffix}`, method: 'GET', headers: { accept: 'application/json' }, ...(instrument == null ? { responseClass: 'catalog' } : {}) };
  }
  if (kind === 'depth') {
    const capped = Math.max(1, Math.min(1000, Math.trunc(finiteNumber(limit, 'limit'))));
    const query = new URLSearchParams({ contract: String(symbol), limit: String(capped), with_id: String(Boolean(withId)) });
    return { url: `${baseUrl}/api/v4/futures/${settlement}/order_book?${query}`, method: 'GET', headers: { accept: 'application/json' } };
  }
  throw new RangeError(`Unsupported Gate.io request: ${kind}`);
}

/** Use the full-snapshot channel. It is deliberately bounded to 100 levels;
 * browser grouping still applies the shared Legacy coarse bucketizer. */
export function buildGateSubscription(kind: string, { contract: instrument = 'BTC_USDT', limit = 100, interval = '0' }: AdapterOptions = {}) {
  if (kind !== 'depth') throw new RangeError(`Unsupported Gate.io subscription: ${kind}`);
  const symbol = contract(instrument);
  const depth = Math.trunc(finiteNumber(limit, 'limit'));
  if (![1, 5, 10, 20, 50, 100].includes(depth)) throw new RangeError(`Unsupported Gate.io depth level: ${limit}`);
  if (String(interval) !== '0') throw new RangeError(`Unsupported Gate.io order-book interval: ${interval}`);
  const args = [symbol, String(depth), '0'];
  return { url: GATEIO_USDT_WS_URL, method: 'subscribe', args, topic: `futures.order_book:${symbol}`, channel: 'futures.order_book', contract: symbol };
}

export function normalizeGateContractInfo(payload: unknown, { receivedAt = Date.now() }: AdapterOptions = {}) {
  const result = resultOf(payload);
  const rows = Array.isArray(result) ? result : typeof recordValue(result).name === 'string' ? [result] : null;
  if (!rows) throw new TypeError('Gate.io contracts must be an array or one contract object');
  const assets = rows.filter((row: unknown) => {
    const status = String(recordValue(row)?.status ?? 'trading').toLowerCase();
    return status === 'trading' && recordValue(row)?.name;
  }).map((row: unknown) => {
    // Gate's all-contract response can contain non-ASCII equity names. They
    // are not valid exchange symbols for this app; ignore them while keeping
    // valid USDT perpetual rows in the same response.
    let nativeSymbol;
    try { nativeSymbol = contract(recordValue(row).name); } catch { return null; }
    const market = marketFor(nativeSymbol, {
      base: String(nativeSymbol).split('_')[0],
      quote: String(nativeSymbol).split('_')[1] ?? 'USDT',
      tickSize: recordValue(row).order_price_round == null ? undefined : finiteNumber(recordValue(row).order_price_round, 'order_price_round'),
      contractValue: recordValue(row).quanto_multiplier == null ? undefined : finiteNumber(recordValue(row).quanto_multiplier, 'quanto_multiplier'),
    });
    return {
      instrumentId: gateInstrumentId(nativeSymbol), ...market, venue: 'gateio',
      isDelisted: false, tickSize: market.tickSize,
      lotSize: recordValue(row).order_size_min == null ? undefined : finiteNumber(recordValue(row).order_size_min, 'order_size_min'),
      settleCoin: recordValue(row).settle,
      metadataSource: 'gateio-v4-futures-contracts',
    };
  }).filter((item): item is NonNullable<typeof item> => Boolean(item));
  return { kind: 'metadata' as const, venue: 'gateio', sourceTimestamp: epochMs(recordValue(payload)?.time ?? recordValue(payload)?.time_ms, receivedAt), receivedAt, assets };
}

/** Normalize Gate's `futures.order_book` full snapshots. `update` frames are
 * accepted as deltas for deterministic parser/session tests, but production
 * startup intentionally subscribes to `all` snapshots for simple recovery. */
export function normalizeGateDepth(payload: unknown, { contract: instrument, contractValue, receivedAt = Date.now() }: AdapterOptions = {}) {
  const envelope = assertGate(payload);
  const row = resultOf(envelope);
  const native = contract(instrument ?? recordValue(row)?.contract ?? recordValue(envelope)?.contract ?? recordValue(recordValue(envelope)?.result)?.contract);
  const asks = recordValue(row)?.asks ?? recordValue(row)?.a;
  const bids = recordValue(row)?.bids ?? recordValue(row)?.b;
  if (!Array.isArray(asks) || !Array.isArray(bids)) throw new TypeError('Gate.io depth bids/asks missing');
  const market = marketFor(native, { contractValue });
  const sourceTimestamp = epochMs(recordValue(row)?.t ?? recordValue(row)?.time_ms ?? recordValue(envelope)?.time_ms ?? recordValue(envelope)?.time, receivedAt);
  const id = recordValue(row)?.id ?? recordValue(row)?.update_id ?? recordValue(row)?.u;
  const event = String(recordValue(envelope)?.event ?? 'all').toLowerCase();
  if (event === 'all' || event === 'snapshot' || event === 'subscribe') {
    return {
      kind: 'depthSnapshot' as const, venue: 'gateio', instrumentId: gateInstrumentId(native), nativeSymbol: market.nativeSymbol,
      market, units: market.quantityUnit, ...(market.contractValue != null ? { contractValue: market.contractValue } : {}),
      sourceTimestamp, receivedAt, sequence: sequence(id, 'snapshot sequence'), complete: true, coverage: 'partial' as const,
      bids: sideLevels(bids, 'bids'), asks: sideLevels(asks, 'asks'),
    };
  }
  if (event !== 'update') throw new TypeError(`Gate.io depth action unsupported: ${event}`);
  const last = recordValue(row)?.u ?? recordValue(row)?.update_id ?? id;
  const first = recordValue(row)?.U ?? recordValue(row)?.first_update_id;
  const lastSequence = sequence(last, 'update sequence');
  let previousSequence;
  if (first != null) {
    const firstSequence = sequence(first, 'first update sequence');
    const firstBig = BigInt(String(firstSequence));
    previousSequence = sequence(firstBig > 0n ? firstBig - 1n : 0n, 'previous sequence');
  }
  return {
    kind: 'depthDelta' as const, venue: 'gateio', instrumentId: gateInstrumentId(native), nativeSymbol: market.nativeSymbol,
    market, units: market.quantityUnit, ...(market.contractValue != null ? { contractValue: market.contractValue } : {}),
    sourceTimestamp, receivedAt, sequence: lastSequence, previousSequence,
    bids: sideLevels(bids, 'bids'), asks: sideLevels(asks, 'asks'),
  };
}

export class GateIoConnector {
  networkEnabled: boolean;
  transport: AdapterTransport | null;
  constructor({ transport = null, networkEnabled = false }: AdapterOptions = {}) { this.transport = transport; this.networkEnabled = networkEnabled; }
  async request(kind: string, params: AdapterOptions = {}) { if (!this.networkEnabled || !this.transport?.request) throw new AdapterTransportError('Gate.io network disabled; inject transport and set networkEnabled=true'); return this.transport.request(buildGateRequest(kind, params)); }
  async subscribe(kind: string, params: AdapterOptions = {}) { if (!this.networkEnabled || !this.transport?.subscribe) throw new AdapterTransportError('Gate.io network disabled; inject transport and set networkEnabled=true'); return this.transport.subscribe(buildGateSubscription(kind, params)); }
}
