import { recordValue, arrayValue, type AdapterOptions, type AdapterTransport } from './common.mts';
import { AdapterTransportError, epochMs, finiteNumber, requireSymbol } from './common.mts';

/** dYdX v4 public perpetual-markets and indexer WebSocket descriptors. */
export const DYDX_REST_URL = 'https://indexer.dydx.trade';
export const DYDX_PUBLIC_WS_URL = 'wss://indexer.dydx.trade/v4/ws';
export const DYDX_DEFAULT_SYMBOL = 'BTC-USD';
export const DYDX_TRADES_CHANNEL = 'v4_trades';
export const DYDX_ORDERBOOK_CHANNEL = 'v4_orderbook';

function marketSymbol(value: unknown) {
  const native = requireSymbol(value).replaceAll('_', '-');
  if (!/^[A-Z0-9]+-USD$/.test(native)) throw new TypeError('Invalid dYdX perpetual market symbol');
  return native;
}

function instrumentId(value: unknown) { return `dydx:${marketSymbol(value)}`; }

function assertDydxResponse(payload: unknown) {
  if (recordValue(payload)?.error != null) throw new Error(`dYdX provider error: ${recordValue(recordValue(payload).error)?.message ?? recordValue(payload).error}`);
  if (Array.isArray(recordValue(payload)?.errors) && arrayValue(recordValue(payload).errors).length) throw new Error(`dYdX provider error: ${recordValue(arrayValue(recordValue(payload).errors)[0])?.message ?? arrayValue(recordValue(payload).errors)[0]}`);
  return payload;
}

function timestamp(value: unknown, fallback: number) {
  if (typeof value === 'string' && /[A-Za-zT:-]/.test(value)) {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : fallback;
  }
  return epochMs(value, fallback);
}

function tradeSide(value: unknown) {
  const side = String(value ?? '').trim().toUpperCase();
  if (side === 'BUY') return 'buy';
  if (side === 'SELL') return 'sell';
  return 'unknown';
}

/** Build a bounded public metadata request. The selected ticker is filtered after decoding. */
export function buildDydxRequest(kind: string = 'perpetualMarkets', _params: AdapterOptions = {}) {
  if (kind !== 'perpetualMarkets') throw new RangeError(`Unsupported dYdX request: ${kind}`);
  return { url: `${DYDX_REST_URL}/v4/perpetualMarkets`, method: 'GET', headers: { accept: 'application/json' }, responseClass: 'catalog' };
}

/** Build the exact v4_trades subscription. dYdX uses the market ticker as the id. */
export function buildDydxSubscription(kind: string = 'trades', { symbol = DYDX_DEFAULT_SYMBOL }: AdapterOptions = {}) {
  if (kind !== 'trades' && kind !== 'depth') throw new RangeError(`Unsupported dYdX subscription: ${kind}`);
  const nativeSymbol = marketSymbol(symbol);
  const channel = kind === 'depth' ? DYDX_ORDERBOOK_CHANNEL : DYDX_TRADES_CHANNEL;
  return {
    url: DYDX_PUBLIC_WS_URL,
    type: 'subscribe', channel, id: nativeSymbol,
    topic: `${channel}:${nativeSymbol}`, symbol: nativeSymbol,
    ...(kind === 'depth' ? { batched: false } : {}),
  };
}

/** Normalize the public perpetualMarkets map, retaining explicit dYdX size units. */
export function normalizeDydxMarkets(payload: unknown, { symbol, receivedAt = Date.now() }: AdapterOptions = {}) {
  const source = assertDydxResponse(payload);
  const markets = recordValue(source)?.markets ?? recordValue(recordValue(source)?.data)?.markets;
  if (!markets || typeof markets !== 'object' || Array.isArray(markets)) throw new TypeError('dYdX perpetualMarkets map missing');
  const expected = symbol == null ? null : marketSymbol(symbol);
  const entries = Object.entries(markets).filter(([key, row]) => {
    let ticker;
    try { ticker = marketSymbol(recordValue(row)?.ticker ?? key); } catch { return false; }
    return expected == null || ticker === expected;
  });
  const assets = entries.map(([key, row], index) => {
    const nativeSymbol = marketSymbol(recordValue(row)?.ticker ?? key);
    const base = nativeSymbol.slice(0, -4);
    const quote = 'USD';
    const tickSize = finiteNumber(recordValue(row)?.tickSize, `markets[${index}].tickSize`);
    const stepSize = finiteNumber(recordValue(row)?.stepSize, `markets[${index}].stepSize`);
    if (!(tickSize > 0) || !(stepSize > 0)) throw new TypeError(`dYdX markets[${index}] tick/step must be positive`);
    const status = String(recordValue(row)?.status ?? '').toUpperCase();
    const active = status === 'ACTIVE';
    const atomicResolution = recordValue(row)?.atomicResolution == null ? undefined : Number(recordValue(row).atomicResolution);
    const quantumConversionExponent = recordValue(row)?.quantumConversionExponent == null ? undefined : Number(recordValue(row).quantumConversionExponent);
    return {
      instrumentId: instrumentId(nativeSymbol), venue: 'dydx', nativeSymbol, symbol: nativeSymbol,
      base, quote, marketType: 'perpetual', tickSize, lotSize: stepSize, quantityUnit: 'base',
      atomicResolution: Number.isInteger(atomicResolution) ? atomicResolution : undefined,
      quantumConversionExponent: Number.isInteger(quantumConversionExponent) ? quantumConversionExponent : undefined,
      status: active ? 'online' : (status || 'unknown').toLowerCase(), isDelisted: !active,
      metadataSource: 'dydx-v4-perpetualMarkets', receivedAt,
    };
  });
  return { kind: 'metadata' as const, venue: 'dydx', sourceTimestamp: null, receivedAt, assets };
}

/** Normalize one dYdX v4 public trade. Liquidation rows are intentionally excluded by the batch helper. */
export function normalizeDydxTrade(row: unknown, { symbol = DYDX_DEFAULT_SYMBOL, receivedAt = Date.now() }: AdapterOptions = {}) {
  const value = recordValue(row)?.trade ?? row;
  const expectedSymbol = marketSymbol(symbol);
  const wireSymbol = recordValue(value)?.ticker ?? recordValue(value)?.symbol;
  const nativeSymbol = wireSymbol == null ? expectedSymbol : marketSymbol(wireSymbol);
  if (nativeSymbol !== expectedSymbol) throw new TypeError('dYdX trade symbol mismatch');
  const id = String(recordValue(value)?.id ?? '').trim();
  if (!id) throw new TypeError('dYdX trade id missing');
  const sourceTimestamp = timestamp(recordValue(value)?.createdAt ?? recordValue(value)?.timestamp, Number.NaN);
  if (!(sourceTimestamp >= 0)) throw new TypeError('dYdX trade timestamp missing');
  const price = finiteNumber(recordValue(value)?.price, 'dYdX trade price');
  const amount = finiteNumber(recordValue(value)?.size, 'dYdX trade size');
  if (!(price > 0) || !(amount >= 0)) throw new TypeError('Invalid dYdX trade values');
  return {
    kind: 'trade' as const, venue: 'dydx', instrumentId: instrumentId(nativeSymbol), tradeId: `${nativeSymbol}:${id}`,
    side: tradeSide(recordValue(value)?.side), price, amount, notionalUsd: price * amount,
    sourceTimestamp, receivedAt,
  };
}

/** Normalize subscribed/channel_data envelopes and leave liquidation rows out of ordinary trades. */
export function normalizeDydxTrades(payload: unknown, { symbol = DYDX_DEFAULT_SYMBOL, receivedAt = Date.now() }: AdapterOptions = {}) {
  const envelope = recordValue(payload)?.contents ? payload : recordValue(payload)?.data ?? payload;
  const rows = Array.isArray(recordValue(recordValue(envelope)?.contents)?.trades)
    ? recordValue(recordValue(envelope).contents).trades
    : Array.isArray(recordValue(envelope)?.trades) ? recordValue(envelope).trades : [];
  return arrayValue(rows).filter((row: unknown) => {
    // The legacy AGGR worker marks forced fills with `liquidation: true`.
    // Current dYdX indexer TradeContent identifies those rows by type instead.
    const type = String(recordValue(row)?.type ?? recordValue(recordValue(row)?.trade)?.type ?? '').trim().toUpperCase();
    return recordValue(row)?.liquidation !== true && !['LIQUIDATED', 'DELEVERAGED'].includes(type);
  }).map((row: unknown) => normalizeDydxTrade(row, { symbol, receivedAt }));
}


/** Provider connection counter, preserved exactly instead of rounding unsafe IDs. */
function depthSequence(value: unknown): number | string {
  if (typeof value === 'number' && (!Number.isSafeInteger(value) || value < 1)) throw new TypeError('dYdX depth message_id must be a positive safe integer');
  if (typeof value !== 'number' && (typeof value !== 'string' || !/^[0-9]{1,32}$/.test(value))) throw new TypeError('dYdX depth message_id missing or invalid');
  const integer = BigInt(value);
  if (integer < 1n) throw new TypeError('dYdX depth message_id must be positive');
  return integer <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(integer) : integer.toString();
}
function depthRows(value: unknown, field: string) {
  if (!Array.isArray(value)) throw new TypeError(`dYdX depth ${field} must be an array`);
  return value.map((row: unknown, index) => {
    // The v4 indexer sends {price, size} objects in the subscribed snapshot but [price, size] string pairs in
    // channel_data updates (verified against the live socket). No v3 offset or synthetic sequence is inferred.
    const pair = Array.isArray(row) && row.length === 2 ? row : null;
    if (!pair && (!row || typeof row !== 'object' || Array.isArray(row))) throw new TypeError(`dYdX depth ${field}[${index}] must be a price/size object or pair`);
    const priceValue = pair ? pair[0] : recordValue(row).price, sizeValue = pair ? pair[1] : recordValue(row).size;
    for (const scalar of [priceValue, sizeValue]) if ((typeof scalar !== 'number' && typeof scalar !== 'string') || typeof scalar === 'string' && !scalar.trim()) throw new TypeError(`dYdX depth ${field}[${index}] numeric fields missing`);
    const price = finiteNumber(priceValue, 'dYdX depth price'), amount = finiteNumber(sizeValue, 'dYdX depth size');
    if (!(price > 0) || amount < 0) throw new TypeError(`dYdX depth ${field}[${index}] out of range`);
    return { price, amount };
  });
}
/** Dedicated unbatched v4_orderbook socket. message_id is a connection counter,
 * not an exchange-wide book offset. Manager fences connection_id and requires
 * contiguous updates after the subscribed snapshot. Provider order clocks are
 * absent in this schema and remain null; receivedAt never becomes source time. */
export function normalizeDydxDepth(payload: unknown, { symbol = DYDX_DEFAULT_SYMBOL, receivedAt = Date.now(), metadata }: AdapterOptions = {}) {
  const value = recordValue(assertDydxResponse(payload)), nativeSymbol = marketSymbol(symbol);
  if (value.channel !== DYDX_ORDERBOOK_CHANNEL || value.id !== nativeSymbol) throw new TypeError('dYdX depth channel or symbol mismatch');
  const snapshot = value.type === 'subscribed';
  if (!snapshot && value.type !== 'channel_data') throw new TypeError('Unsupported dYdX depth envelope');
  if (typeof value.connection_id !== 'string' || !value.connection_id || value.connection_id.length > 256) throw new TypeError('dYdX depth connection_id missing or invalid');
  const sequence = depthSequence(value.message_id), contents = recordValue(value.contents);
  if (!Object.prototype.hasOwnProperty.call(contents, 'bids') && !Object.prototype.hasOwnProperty.call(contents, 'asks')) throw new TypeError('dYdX depth contents missing sides');
  const bids = depthRows(contents.bids === undefined && !snapshot ? [] : contents.bids, 'bids');
  const asks = depthRows(contents.asks === undefined && !snapshot ? [] : contents.asks, 'asks');
  const nativeMetadata = recordValue(metadata);
  if (metadata != null && (nativeMetadata.instrumentId !== instrumentId(nativeSymbol) || nativeMetadata.venue !== 'dydx'
    || nativeMetadata.marketType !== 'perpetual' || nativeMetadata.quantityUnit !== 'base' || nativeMetadata.quote !== 'USD'
    || nativeMetadata.status !== 'online' || nativeMetadata.isDelisted !== false)) throw new TypeError('dYdX depth native market metadata mismatch');
  const market = { ...nativeMetadata, venue: 'dydx', nativeSymbol, symbol: nativeSymbol, base: nativeSymbol.slice(0, -4), quote: 'USD',
    marketType: 'perpetual' as const, quantityUnit: 'base' as const };
  const previous = BigInt(sequence) - 1n;
  return { kind: snapshot ? 'depthSnapshot' as const : 'depthDelta' as const, venue: 'dydx', instrumentId: instrumentId(nativeSymbol), nativeSymbol,
    market, units: 'base' as const, channel: DYDX_ORDERBOOK_CHANNEL, sequence,
    ...(snapshot ? {} : { previousSequence: previous <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(previous) : previous.toString() }),
    bids, asks, complete: snapshot, coverage: 'unknown' as const, continuity: snapshot ? 'provider-snapshot' : 'strict',
    providerConnectionId: value.connection_id, sourceTimestamp: null, receivedAt, payload };
}

/** Connector boundary. Network access is opt-in and transport-injected. */
export class DydxConnector {
  networkEnabled: boolean;
  transport: AdapterTransport | null;
  constructor({ transport = null, networkEnabled = false }: AdapterOptions = {}) { this.transport = transport; this.networkEnabled = networkEnabled; }
  async request(kind: string = 'perpetualMarkets', params: AdapterOptions = {}) {
    if (!this.networkEnabled || !this.transport?.request) throw new AdapterTransportError('dYdX network disabled; inject transport and set networkEnabled=true');
    return this.transport.request(buildDydxRequest(kind, params));
  }
  async subscribe(kind: string = 'trades', params: AdapterOptions = {}) {
    if (!this.networkEnabled || !this.transport?.subscribe) throw new AdapterTransportError('dYdX network disabled; inject transport and set networkEnabled=true');
    return this.transport.subscribe(buildDydxSubscription(kind, params));
  }
}
