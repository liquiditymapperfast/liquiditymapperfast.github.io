import { recordValue, arrayValue, type AdapterOptions, type AdapterTransport, type WireRecord } from './common.mts';
import { AdapterTransportError, epochMs, finiteNumber, requireSymbol, sideLevels } from './common.mts';

/** Coinbase Exchange public spot market-data descriptors and normalizers. */
export const COINBASE_REST_URL = 'https://api.exchange.coinbase.com';
export const COINBASE_PUBLIC_WS_URL = 'wss://ws-feed.exchange.coinbase.com';

function productId(value: unknown) { return requireSymbol(value).toUpperCase(); }
function instrumentId(value: unknown) { return `coinbase:${productId(value)}`; }
function productOf(payload: unknown) { return recordValue(payload)?.product ?? recordValue(payload)?.data ?? payload; }

export function buildCoinbaseRequest(kind: string, { productId: product, level = 2, baseUrl = COINBASE_REST_URL }: AdapterOptions = {}) {
  const id = productId(product);
  if (kind === 'product') return { url: `${baseUrl}/products/${encodeURIComponent(id)}`, method: 'GET', headers: { accept: 'application/json' } };
  if (kind === 'depth') return { url: `${baseUrl}/products/${encodeURIComponent(id)}/book?level=${Math.max(1, Math.min(3, Math.trunc(finiteNumber(level, 'level'))))}`, method: 'GET', headers: { accept: 'application/json' } };
  throw new RangeError(`Unsupported Coinbase request: ${kind}`);
}

export function buildCoinbaseSubscription(kind: string, { productId: product, channel = 'level2' }: AdapterOptions = {}) {
  if (kind !== 'depth') throw new RangeError(`Unsupported Coinbase subscription: ${kind}`);
  const id = productId(product); const name = String(channel);
  return { url: COINBASE_PUBLIC_WS_URL, method: 'subscribe', productId: id, channel: name, args: [id], topic: `${name}:${id}` };
}

function marketFor(product: unknown, metadata: WireRecord = {}) {
  const nativeSymbol = productId(product); const [base, quote] = nativeSymbol.split('-');
  return { venue: 'coinbase', nativeSymbol, symbol: nativeSymbol, base: String(metadata.base ?? base ?? nativeSymbol).toUpperCase(), quote: String(metadata.quote ?? quote ?? 'USD').toUpperCase(), marketType: 'spot', tickSize: metadata.tickSize ?? null, quantityUnit: 'base' };
}

export function normalizeCoinbaseProduct(payload: unknown, { receivedAt = Date.now() }: AdapterOptions = {}) {
  const row = productOf(payload); const native = productId(recordValue(row)?.id);
  const market = marketFor(native, { base: recordValue(row)?.base_currency, quote: recordValue(row)?.quote_currency, tickSize: recordValue(row)?.quote_increment == null ? undefined : finiteNumber(recordValue(row).quote_increment, 'quote_increment') });
  const baseIncrement = recordValue(row)?.base_increment == null ? undefined : finiteNumber(recordValue(row).base_increment, 'base_increment');
  const quoteIncrement = recordValue(row)?.quote_increment == null ? undefined : finiteNumber(recordValue(row).quote_increment, 'quote_increment');
  if (baseIncrement == null || quoteIncrement == null || !(baseIncrement > 0) || !(quoteIncrement > 0)) throw new TypeError('Coinbase product increments must be positive');
  const status = String(recordValue(row)?.status ?? '').toLowerCase();
  return { kind: 'metadata' as const, venue: 'coinbase', sourceTimestamp: epochMs(recordValue(row)?.updated_at ?? recordValue(row)?.created_at, receivedAt), receivedAt, assets: [{ instrumentId: instrumentId(native), ...market, tickSize: quoteIncrement, qtyStep: baseIncrement, lotSize: baseIncrement, quantityUnit: 'base', status: status || null, isDelisted: status !== 'online', metadataSource: 'coinbase-exchange-product' }] };
}

function timestampOf(payload: unknown, receivedAt: number) { return epochMs(recordValue(payload)?.time ?? recordValue(payload)?.timestamp, receivedAt); }

function sequenceToken(value: unknown) {
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value) || value < 0) throw new TypeError('Coinbase sequence is unsafe or invalid');
    return value;
  }
  const text = String(value ?? '').trim();
  if (!/^\d+$/.test(text)) throw new TypeError('Coinbase sequence is missing or invalid');
  const integer = BigInt(text);
  return integer <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(integer) : integer.toString();
}

/** Normalize Coinbase's REST level-2 book response. */
export function normalizeCoinbaseRestDepth(payload: unknown, { productId: product, receivedAt = Date.now() }: AdapterOptions = {}) {
  const native = productId(product); const id = instrumentId(native);
  if (!Array.isArray(recordValue(payload)?.bids) || !Array.isArray(recordValue(payload)?.asks)) throw new TypeError('Coinbase REST book bids/asks missing');
  return { kind: 'depthSnapshot' as const, venue: 'coinbase', instrumentId: id, nativeSymbol: native, market: marketFor(native), units: 'base', sourceTimestamp: timestampOf(payload, receivedAt), receivedAt, sequence: sequenceToken(recordValue(payload).sequence), complete: true, coverage: 'partial' as const, continuity: 'rest-snapshot', bids: sideLevels(recordValue(payload).bids, 'bids'), asks: sideLevels(recordValue(payload).asks, 'asks') };
}

export function normalizeCoinbaseDepth(payload: unknown, { productId: product, receivedAt = Date.now() }: AdapterOptions = {}) {
  const native = productId(product ?? recordValue(payload)?.product_id); const type = String(recordValue(payload)?.type ?? '').toLowerCase();
  if (!type && recordValue(payload)?.sequence != null) return normalizeCoinbaseRestDepth(payload, { productId: native, receivedAt });
  const id = instrumentId(native); const sourceTimestamp = timestampOf(payload, receivedAt);
  if (type === 'snapshot') {
    if (!Array.isArray(recordValue(payload)?.bids) || !Array.isArray(recordValue(payload)?.asks)) throw new TypeError('Coinbase snapshot bids/asks missing');
    return { kind: 'depthSnapshot' as const, venue: 'coinbase', instrumentId: id, nativeSymbol: native, market: marketFor(native), units: 'base', sourceTimestamp, receivedAt, complete: true, coverage: 'partial' as const, continuity: 'provider-guaranteed', bids: sideLevels(recordValue(payload).bids, 'bids'), asks: sideLevels(recordValue(payload).asks, 'asks') };
  }
  if (type !== 'l2update') throw new TypeError(`Coinbase depth type unsupported: ${type}`);
  if (!Array.isArray(recordValue(payload)?.changes)) throw new TypeError('Coinbase l2update changes missing');
  const bids = []; const asks = [];
  for (const row of arrayValue(recordValue(payload).changes)) {
    if (!Array.isArray(row) || row.length < 3) throw new TypeError('Coinbase l2update change malformed');
    const side = String(row[0]).toLowerCase(); const level = [row[1], row[2]];
    if (side === 'buy') bids.push(level); else if (side === 'sell') asks.push(level); else throw new TypeError('Coinbase l2update side invalid');
  }
  return { kind: 'depthDelta' as const, venue: 'coinbase', instrumentId: id, nativeSymbol: native, market: marketFor(native), units: 'base', sourceTimestamp, receivedAt, continuity: 'provider-guaranteed', bids: sideLevels(bids, 'bids'), asks: sideLevels(asks, 'asks') };
}

export class CoinbaseConnector {
  networkEnabled: boolean;
  transport: AdapterTransport | null;
  constructor({ transport = null, networkEnabled = false }: AdapterOptions = {}) { this.transport = transport; this.networkEnabled = networkEnabled; }
  async request(kind: string, params: AdapterOptions = {}) { if (!this.networkEnabled || !this.transport?.request) throw new AdapterTransportError('Coinbase network disabled; inject transport and set networkEnabled=true'); return this.transport.request(buildCoinbaseRequest(kind, params)); }
  async subscribe(kind: string, params: AdapterOptions = {}) { if (!this.networkEnabled || !this.transport?.subscribe) throw new AdapterTransportError('Coinbase network disabled; inject transport and set networkEnabled=true'); return this.transport.subscribe(buildCoinbaseSubscription(kind, params)); }
}
