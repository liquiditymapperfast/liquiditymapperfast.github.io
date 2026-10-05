import { recordValue, arrayValue, type AdapterOptions, type AdapterTransport, type WireRecord } from './common.mts';
import { AdapterTransportError, epochMs, finiteNumber, requireSymbol, sideLevels } from './common.mts';

/** KuCoin classic spot Level-50 order-book descriptors and normalizers. */
export const KUCOIN_REST_URL = 'https://api.kucoin.com';
export const KUCOIN_PUBLIC_WS_URL = 'wss://ws-api-spot.kucoin.com';

function symbol(value: unknown) {
  const native = requireSymbol(value).replaceAll('_', '-');
  if (!/^[A-Z0-9.]+-[A-Z0-9.]+$/.test(native)) throw new TypeError('Invalid KuCoin spot symbol');
  return native;
}
function instrumentId(value: unknown) { return `kucoin:${symbol(value)}`; }
function marketFor(value: unknown, metadata: WireRecord = {}) {
  const nativeSymbol = symbol(value); const [base, quote = 'USDT'] = nativeSymbol.split('-');
  return { venue: 'kucoin', nativeSymbol, symbol: nativeSymbol, base: String(metadata.base ?? base).toUpperCase(), quote: String(metadata.quote ?? quote).toUpperCase(), marketType: 'spot', tickSize: metadata.tickSize ?? null, quantityUnit: 'base' as const };
}

function assertKucoin(payload: unknown) {
  const code = recordValue(payload)?.code == null ? null : String(recordValue(payload).code);
  if (code != null && code !== '200000') throw new Error(`KuCoin provider error ${code}: ${recordValue(payload)?.msg ?? recordValue(payload)?.message ?? 'request failed'}`);
  return payload;
}

export function buildKucoinRequest(kind: string, { symbol: pair = 'BTC-USDT', depth = 20, baseUrl = KUCOIN_REST_URL }: AdapterOptions = {}) {
  const native = symbol(pair);
  if (kind === 'publicToken') return { url: `${baseUrl}/api/v1/bullet-public`, method: 'POST', headers: { accept: 'application/json' } };
  if (kind === 'symbol') return { url: `${baseUrl}/api/v2/symbols/${encodeURIComponent(native)}`, method: 'GET', headers: { accept: 'application/json' } };
  if (kind === 'depth') {
    const size = Math.trunc(finiteNumber(depth, 'depth'));
    if (![20, 100].includes(size)) throw new RangeError(`Unsupported KuCoin REST depth: ${depth}`);
    return { url: `${baseUrl}/api/v1/market/orderbook/level2_${size}?symbol=${encodeURIComponent(native)}`, method: 'GET', headers: { accept: 'application/json' } };
  }
  throw new RangeError(`Unsupported KuCoin request: ${kind}`);
}

function durationMs(value: unknown, field: string, fallback: unknown) {
  if (value == null) return fallback;
  const numeric = finiteNumber(value, field);
  if (!(numeric > 0)) throw new RangeError(`KuCoin ${field} must be positive`);
  return numeric < 100 ? Math.round(numeric * 1_000) : Math.round(numeric);
}

/** Normalize the classic spot public-token handshake without exposing it in a feed message. */
export function normalizeKucoinPublicToken(payload: unknown, { receivedAt = Date.now() }: AdapterOptions = {}) {
  const data = recordValue(assertKucoin(payload))?.data;
  const token = recordValue(data).token;
  if (!data || typeof data !== 'object' || typeof token !== 'string' || !token.trim()) throw new TypeError('KuCoin public token missing');
  const server = Array.isArray(recordValue(data).instanceServers) ? arrayValue(recordValue(data).instanceServers).find((item: unknown) => { const endpoint = recordValue(item)?.endpoint; return typeof endpoint === 'string' && endpoint.trim(); }) : null;
  if (!server) throw new TypeError('KuCoin public websocket endpoint missing');
  const endpoint = String(recordValue(server).endpoint).trim();
  if (!/^wss?:\/\//i.test(endpoint)) throw new TypeError('KuCoin public websocket endpoint invalid');
  return {
    kind: 'transportMetadata' as const, venue: 'kucoin', sourceTimestamp: null, receivedAt,
    token: token.trim(), endpoint,
    pingIntervalMs: durationMs(recordValue(server).pingInterval, 'pingInterval', 18_000),
    heartbeatTimeoutMs: durationMs(recordValue(server).pingTimeout, 'pingTimeout', 10_000),
  };
}

export function buildKucoinWsUrl({ endpoint = KUCOIN_PUBLIC_WS_URL, token, connectId = 'liquiditymapperfast' }: AdapterOptions = {}) {
  if (typeof token !== 'string' || !token.trim()) throw new TypeError('KuCoin websocket token is required');
  const url = new URL(String(endpoint));
  url.searchParams.set('token', token.trim());
  if (connectId != null && String(connectId).trim()) url.searchParams.set('connectId', String(connectId).trim());
  return url.toString();
}

export function buildKucoinSubscription(kind: string, { symbol: pair = 'BTC-USDT', depth = 50, id = '1' }: AdapterOptions = {}) {
  if (kind !== 'depth') throw new RangeError(`Unsupported KuCoin subscription: ${kind}`);
  const native = symbol(pair); const boundedDepth = Math.trunc(finiteNumber(depth, 'depth'));
  if (boundedDepth !== 50) throw new RangeError(`Unsupported KuCoin Level-50 depth: ${depth}`);
  const topic = `/spotMarket/level2Depth50:${native}`;
  return { url: KUCOIN_PUBLIC_WS_URL, id: String(id), type: 'subscribe', topic, channel: 'level2Depth50', symbol: native, depth: boundedDepth, response: true, args: [topic] };
}

export function normalizeKucoinSymbol(payload: unknown, { symbol: pair, receivedAt = Date.now() }: AdapterOptions = {}) {
  const row = recordValue(assertKucoin(payload))?.data;
  if (!row || typeof row !== 'object') throw new TypeError('KuCoin symbol metadata missing');
  const native = symbol(pair ?? recordValue(row).symbol);
  if (recordValue(row).symbol != null && symbol(recordValue(row).symbol) !== native) throw new TypeError('KuCoin symbol metadata mismatch');
  const tickSize = finiteNumber(recordValue(row).priceIncrement, 'priceIncrement');
  const qtyStep = finiteNumber(recordValue(row).baseIncrement, 'baseIncrement');
  if (!(tickSize > 0) || !(qtyStep > 0)) throw new TypeError('KuCoin symbol increments must be positive');
  const market = marketFor(native, { base: recordValue(row).baseCurrency, quote: recordValue(row).quoteCurrency, tickSize });
  const enabled = recordValue(row).enableTrading !== false && String(recordValue(row).status ?? 'online').toLowerCase() !== 'halt';
  return { kind: 'metadata' as const, venue: 'kucoin', sourceTimestamp: epochMs(recordValue(row).tradingStartTime, receivedAt), receivedAt, assets: [{ instrumentId: instrumentId(native), ...market, venue: 'kucoin', isDelisted: !enabled, status: enabled ? 'online' : 'offline', tickSize, qtyStep, lotSize: qtyStep, quantityUnit: 'base' as const, metadataSource: 'kucoin-symbol' }] };
}

export function normalizeKucoinDepth(payload: unknown, { symbol: pair, receivedAt = Date.now() }: AdapterOptions = {}) {
  const envelope = assertKucoin(payload);
  if (String(recordValue(envelope)?.type ?? '').toLowerCase() !== 'message' || String(recordValue(envelope)?.subject ?? '').toLowerCase() !== 'level2') throw new TypeError('KuCoin Level-50 message type unsupported');
  const native = symbol(pair ?? String(recordValue(envelope)?.topic ?? '').split(':').at(-1));
  const topicSymbol = String(recordValue(envelope)?.topic ?? '').split(':').at(-1);
  if (topicSymbol && symbol(topicSymbol) !== native) throw new TypeError('KuCoin book topic symbol mismatch');
  const row = recordValue(envelope)?.data;
  if (!row || !Array.isArray(recordValue(row).bids) || !Array.isArray(recordValue(row).asks)) throw new TypeError('KuCoin Level-50 bids/asks missing');
  const market = marketFor(native);
  return { kind: 'depthSnapshot' as const, venue: 'kucoin', instrumentId: instrumentId(native), nativeSymbol: native, market, units: 'base' as const, sourceTimestamp: epochMs(recordValue(row).timestamp, receivedAt), receivedAt, complete: true, coverage: 'partial' as const, continuity: 'provider-snapshot', bids: sideLevels(recordValue(row).bids, 'bids'), asks: sideLevels(recordValue(row).asks, 'asks') };
}

export class KucoinConnector {
  networkEnabled: boolean;
  transport: AdapterTransport | null;
  constructor({ transport = null, networkEnabled = false }: AdapterOptions = {}) { this.transport = transport; this.networkEnabled = networkEnabled; }
  async request(kind: string, params: AdapterOptions = {}) { if (!this.networkEnabled || !this.transport?.request) throw new AdapterTransportError('KuCoin network disabled; inject transport and set networkEnabled=true'); return this.transport.request(buildKucoinRequest(kind, params)); }
  async subscribe(kind: string, params: AdapterOptions = {}) { if (!this.networkEnabled || !this.transport?.subscribe) throw new AdapterTransportError('KuCoin network disabled; inject transport and set networkEnabled=true'); return this.transport.subscribe(buildKucoinSubscription(kind, params)); }
}
