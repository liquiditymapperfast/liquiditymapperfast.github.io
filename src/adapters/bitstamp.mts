import { recordValue, type AdapterOptions, type AdapterTransport, type WireRecord } from './common.mts';
import { AdapterTransportError, epochMs, finiteNumber, sideLevels } from './common.mts';

/** Bitstamp public spot order-book descriptors and full-snapshot normalization. */
export const BITSTAMP_REST_URL = 'https://www.bitstamp.net/api/v2';
export const BITSTAMP_PUBLIC_WS_URL = 'wss://ws.bitstamp.net/';
export const BITSTAMP_DEFAULT_SYMBOL = 'btcusd';
export const BITSTAMP_DEFAULT_DEPTH = 100;

const QUOTE_SUFFIXES = Object.freeze(['USDT', 'USDC', 'EURCV', 'EURC', 'RLUSD', 'USD', 'EUR', 'GBP', 'BTC', 'ETH', 'JPY']);

function pair(value: unknown) {
  const text = String(value ?? '').trim();
  if (!/^[A-Za-z0-9/_-]+$/.test(text)) throw new TypeError('Invalid Bitstamp trading pair');
  const native = text.replaceAll('/', '').replaceAll('-', '').replaceAll('_', '').toLowerCase();
  if (!/^[a-z0-9]{4,24}$/.test(native)) throw new TypeError('Invalid Bitstamp trading pair');
  return native;
}

function pairKey(value: unknown) { return pair(value).toUpperCase(); }
function instrumentId(value: unknown) { return `bitstamp:${pairKey(value)}`; }

function decimalPower(value: unknown, field: string) {
  const decimals = Math.trunc(finiteNumber(value, field));
  if (decimals < 0 || decimals > 18) throw new RangeError(`${field} must be an integer from 0 through 18`);
  return 10 ** -decimals;
}

function splitPair(value: unknown, metadata: WireRecord = {}) {
  const native = pairKey(value);
  const quote = String(metadata.quote ?? QUOTE_SUFFIXES.find(candidate => native.endsWith(candidate)) ?? 'USD').toUpperCase();
  const base = String(metadata.base ?? (native.endsWith(quote) ? native.slice(0, -quote.length) : native)).toUpperCase();
  return { base: base || native, quote };
}

function marketFor(value: unknown, metadata: WireRecord = {}) {
  const nativeSymbol = pairKey(value);
  const { base, quote } = splitPair(nativeSymbol, metadata);
  return {
    venue: 'bitstamp', nativeSymbol, symbol: nativeSymbol, base, quote, marketType: 'spot',
    tickSize: metadata.tickSize ?? null, quantityUnit: 'base' as const,
  };
}

function assertBitstamp(payload: unknown) {
  if (recordValue(payload)?.event === 'bts:error' || recordValue(payload)?.error) throw new Error(`Bitstamp provider error: ${recordValue(payload)?.message ?? recordValue(payload)?.error ?? 'request failed'}`);
  return payload;
}

function rows(values: unknown, field: string) {
  if (!Array.isArray(values)) throw new TypeError(`Bitstamp ${field} must be an array`);
  return values.map((row: unknown, index) => {
    if (!Array.isArray(row) || row.length < 2) throw new TypeError(`Bitstamp ${field}[${index}] malformed`);
    const price = finiteNumber(row[0], `${field}[${index}].price`);
    const amount = finiteNumber(row[1], `${field}[${index}].amount`);
    if (!(price > 0) || !(amount >= 0)) throw new TypeError(`Bitstamp ${field}[${index}] out of range`);
    return { price, amount };
  });
}

function timestampOf(data: unknown, receivedAt: number) {
  const micro = Number(recordValue(data)?.microtimestamp);
  if (Number.isFinite(micro) && micro > 0) return Math.trunc(micro / 1_000);
  return epochMs(recordValue(data)?.timestamp, receivedAt);
}

export function buildBitstampRequest(kind: string, { symbol = BITSTAMP_DEFAULT_SYMBOL, baseUrl = BITSTAMP_REST_URL }: AdapterOptions = {}) {
  if (kind === 'markets' || kind === 'tradingPairs') return { url: `${baseUrl}/markets/`, method: 'GET', headers: { accept: 'application/json' }, responseClass: 'catalog' };
  if (kind === 'depth') {
    const native = pair(symbol);
    return { url: `${baseUrl}/order_book/${encodeURIComponent(native)}/`, method: 'GET', headers: { accept: 'application/json' } };
  }
  throw new RangeError(`Unsupported Bitstamp request: ${kind}`);
}

export function buildBitstampSubscription(kind: string, { symbol = BITSTAMP_DEFAULT_SYMBOL, depth = BITSTAMP_DEFAULT_DEPTH }: AdapterOptions = {}) {
  if (kind !== 'depth') throw new RangeError(`Unsupported Bitstamp subscription: ${kind}`);
  const boundedDepth = Math.trunc(finiteNumber(depth, 'depth'));
  if (boundedDepth !== BITSTAMP_DEFAULT_DEPTH) throw new RangeError(`Unsupported Bitstamp order book depth: ${depth}`);
  const native = pair(symbol);
  const channel = `order_book_${native}`;
  return {
    url: BITSTAMP_PUBLIC_WS_URL, method: 'subscribe', op: 'subscribe', event: 'bts:subscribe',
    data: { channel }, channel, topic: channel, symbol: pairKey(native), args: [channel], depth: boundedDepth,
    snapshot: true,
  };
}

export function normalizeBitstampMarkets(payload: unknown, { symbol = null, receivedAt = Date.now() }: AdapterOptions = {}) {
  const raw = assertBitstamp(payload);
  const list = Array.isArray(raw) ? raw : recordValue(raw)?.data;
  if (!Array.isArray(list)) throw new TypeError('Bitstamp markets metadata must be an array');
  const selected = symbol == null ? null : pair(symbol);
  const assets = list.filter((row: unknown) => {
    const marketSymbol = recordValue(row)?.market_symbol ?? recordValue(row)?.url_symbol;
    return marketSymbol != null && String(recordValue(row)?.market_type ?? '').toUpperCase() === 'SPOT' && (selected == null || pair(marketSymbol) === selected);
  }).map((row: unknown) => {
    const native = pair(recordValue(row).market_symbol ?? recordValue(row).url_symbol);
    const counterDecimals = recordValue(row).counter_decimals == null ? null : Math.trunc(finiteNumber(recordValue(row).counter_decimals, 'counter_decimals'));
    const baseDecimals = recordValue(row).base_decimals == null ? null : Math.trunc(finiteNumber(recordValue(row).base_decimals, 'base_decimals'));
    const market = marketFor(native, {
      base: recordValue(row).base_currency ?? recordValue(row).base,
      quote: recordValue(row).counter_currency ?? recordValue(row).quote,
      tickSize: recordValue(row).tick_size == null ? (counterDecimals == null ? undefined : decimalPower(counterDecimals, 'counter_decimals')) : finiteNumber(recordValue(row).tick_size, 'tick_size'),
    });
    const active = String(recordValue(row).trading ?? 'Enabled').toLowerCase() === 'enabled';
    return {
      instrumentId: instrumentId(native), ...market, venue: 'bitstamp',
      tickSize: market.tickSize, lotSize: baseDecimals == null ? undefined : decimalPower(baseDecimals, 'base_decimals'),
      priceDecimals: counterDecimals == null ? undefined : counterDecimals,
      quantityDecimals: baseDecimals == null ? undefined : baseDecimals,
      isDelisted: !active, status: active ? 'online' : String(recordValue(row).trading ?? 'unknown').toLowerCase(),
      metadataSource: 'bitstamp-v2-markets',
    };
  });
  return { kind: 'metadata' as const, venue: 'bitstamp', sourceTimestamp: null, receivedAt, assets };
}

// Kept as an adapter-facing compatibility name while the provider contract is
// the current `/markets/` endpoint.
export const normalizeBitstampTradingPairs = normalizeBitstampMarkets;

export function normalizeBitstampDepth(payload: unknown, { symbol = BITSTAMP_DEFAULT_SYMBOL, receivedAt = Date.now(), requireChannel = false }: AdapterOptions = {}) {
  const raw = assertBitstamp(payload);
  const native = pair(symbol);
  const expectedChannel = `order_book_${native}`;
  if (requireChannel && String(recordValue(raw)?.channel ?? '') !== expectedChannel) throw new TypeError('Bitstamp order book channel mismatch');
  if (recordValue(raw)?.event != null && String(recordValue(raw).event) !== 'data') throw new TypeError(`Unsupported Bitstamp order book event: ${recordValue(raw).event}`);
  const data = recordValue(raw)?.data && typeof recordValue(raw).data === 'object' ? recordValue(raw).data : raw;
  const bids = rows(recordValue(data)?.bids, 'bids').filter(row => row.amount > 0);
  const asks = rows(recordValue(data)?.asks, 'asks').filter(row => row.amount > 0);
  const market = marketFor(native);
  return {
    kind: 'depthSnapshot' as const, venue: 'bitstamp', instrumentId: instrumentId(native), nativeSymbol: market.nativeSymbol,
    market, units: 'base' as const, sourceTimestamp: timestampOf(data, receivedAt), receivedAt,
    complete: true, coverage: 'partial' as const, continuity: 'provider-snapshot', channel: expectedChannel,
    bids: sideLevels(bids.map(row => [row.price, row.amount]), 'bids'),
    asks: sideLevels(asks.map(row => [row.price, row.amount]), 'asks'),
  };
}

export class BitstampConnector {
  networkEnabled: boolean;
  transport: AdapterTransport | null;
  constructor({ transport = null, networkEnabled = false }: AdapterOptions = {}) { this.transport = transport; this.networkEnabled = networkEnabled; }
  async request(kind: string, params: AdapterOptions = {}) { if (!this.networkEnabled || !this.transport?.request) throw new AdapterTransportError('Bitstamp network disabled; inject transport and set networkEnabled=true'); return this.transport.request(buildBitstampRequest(kind, params)); }
  async subscribe(kind: string, params: AdapterOptions = {}) { if (!this.networkEnabled || !this.transport?.subscribe) throw new AdapterTransportError('Bitstamp network disabled; inject transport and set networkEnabled=true'); return this.transport.subscribe(buildBitstampSubscription(kind, params)); }
}
