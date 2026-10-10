import { recordValue, type AdapterOptions, type AdapterTransport } from './common.mts';
import { AdapterTransportError, epochMs, finiteNumber, requireSymbol } from './common.mts';

/** Deribit public BTC perpetual order-book descriptors and normalizers. */
export const DERIBIT_REST_URL = 'https://www.deribit.com/api/v2';
export const DERIBIT_PUBLIC_WS_URL = 'wss://www.deribit.com/ws/api/v2';
export const DERIBIT_DEFAULT_GROUP = 10;
export const DERIBIT_DEFAULT_DEPTH = 20;
export const DERIBIT_DEFAULT_INTERVAL = '100ms';

function instrument(value: unknown) { return requireSymbol(value).toUpperCase(); }
function deribitInstrumentId(value: unknown) { return `deribit:${instrument(value)}`; }
interface DeribitMarketMetadata {
  base?: unknown; quote?: unknown; tickSize?: unknown; futureType?: unknown;
  quantityUnit?: 'base' | 'quote' | 'contract';
}
function marketFor(value: unknown, metadata: DeribitMarketMetadata = {}) {
  const nativeSymbol = instrument(value);
  // The name says the margin: BTC-PERPETUAL is inverse (amounts are USD notional), SOL_USDC-PERPETUAL is linear in USDC (amounts are
  // coins). Book frames carry no future type, so the name decides when metadata does not.
  const [pair = nativeSymbol] = nativeSymbol.split('-');
  const [pairBase = pair, pairQuote] = pair.split('_');
  const linear = metadata.futureType === 'linear' || metadata.futureType == null && pairQuote != null;
  const base = String(metadata.base ?? pairBase).toUpperCase();
  const quote = String(metadata.quote ?? pairQuote ?? 'USD').toUpperCase();
  const marketType = nativeSymbol.endsWith('-PERPETUAL') ? 'perpetual' : 'delivery';
  const quantityUnit = metadata.quantityUnit ?? (linear ? 'base' : 'quote');
  return { venue: 'deribit', nativeSymbol, symbol: nativeSymbol, base, quote, marketType, tickSize: metadata.tickSize ?? null, quantityUnit };
}
function assertDeribit(payload: unknown) {
  if (recordValue(payload)?.error) throw new Error(`Deribit provider error ${recordValue(recordValue(payload).error).code ?? 'unknown'}: ${recordValue(recordValue(payload).error).message ?? 'request failed'}`);
  return payload;
}
function resultOf(payload: unknown) { return recordValue(assertDeribit(payload))?.result ?? recordValue(recordValue(assertDeribit(payload))?.params)?.data ?? assertDeribit(payload); }
function jsonRpc(method: string, params: unknown, baseUrl: unknown) {
  return { url: `${baseUrl ?? DERIBIT_REST_URL}/public/${method}`, method: 'POST', headers: { accept: 'application/json', 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: `public/${method}`, params }) };
}
function sequence(value: unknown, field: string) {
  if (typeof value === 'number' && !Number.isSafeInteger(value)) throw new TypeError(`Deribit ${field} is unsafe numeric; preserve the provider token as a string`);
  const text = String(value ?? '').trim(); if (!/^\d+$/.test(text)) throw new TypeError(`Deribit ${field} missing or invalid`);
  const integer = BigInt(text); return integer <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(integer) : integer.toString();
}
function deribitRows(values: unknown, field: string) {
  if (!Array.isArray(values)) throw new TypeError(`Invalid Deribit ${field}: expected array`);
  return values.map((row: unknown, index) => {
    const price = Array.isArray(row) ? row[0] : recordValue(row)?.price;
    const amount = Array.isArray(row) ? row[1] : recordValue(row)?.amount;
    if (price == null || amount == null) throw new TypeError(`Invalid Deribit ${field}[${index}]`);
    const normalizedPrice = finiteNumber(price, `${field}[${index}].price`);
    const normalizedAmount = finiteNumber(amount, `${field}[${index}].amount`);
    if (!(normalizedPrice > 0) || !(normalizedAmount >= 0)) throw new TypeError(`Invalid Deribit ${field}[${index}]`);
    return { price: normalizedPrice, amount: normalizedAmount };
  });
}

export function buildDeribitRequest(kind: string, { instrumentName = 'BTC-PERPETUAL', depth = 100, baseUrl = DERIBIT_REST_URL }: AdapterOptions = {}) {
  const native = instrument(instrumentName);
  if (kind === 'depth') return jsonRpc('get_order_book', { instrument_name: native, depth: Math.max(1, Math.min(10_000, Math.trunc(finiteNumber(depth, 'depth')))) }, baseUrl);
  if (kind === 'instrument') return jsonRpc('get_instrument', { instrument_name: native }, baseUrl);
  if (kind === 'instruments') return jsonRpc('get_instruments', { currency: native.split('-')[0], kind: 'future' as const, expired: false }, baseUrl);
  throw new RangeError(`Unsupported Deribit request: ${kind}`);
}

/**
 * The price groups Deribit's grouped book channel takes for an instrument. The BTC and ETH inverse perpetuals take coarse groups;
 * the USDC-margined linear perpetuals (SOL_USDC-PERPETUAL and the other coins) take only `none`: any other group is answered with an
 * empty list of subscribed channels, not an error, so the feed would keep its REST snapshot and never go live (measured 2026-10-10).
 */
export function deribitBookGroups(instrumentName: string): readonly string[] {
  const native = instrument(instrumentName);
  if (native.startsWith('BTC-')) return ['none', '1', '2', '5', '10'];
  if (native.startsWith('ETH-')) return ['none', '5', '10', '25', '100', '250'];
  return ['none'];
}

/** Use Deribit's public grouped full-book channel for a bounded, no-credential feed (ungrouped where the instrument takes no group). */
export function buildDeribitSubscription(kind: string, { instrumentName = 'BTC-PERPETUAL', group, depth = DERIBIT_DEFAULT_DEPTH, interval = DERIBIT_DEFAULT_INTERVAL }: AdapterOptions = {}) {
  if (kind !== 'depth') throw new RangeError(`Unsupported Deribit subscription: ${kind}`);
  const native = instrument(instrumentName);
  const allowedGroups = deribitBookGroups(native);
  const fallback = allowedGroups.includes(String(DERIBIT_DEFAULT_GROUP)) ? String(DERIBIT_DEFAULT_GROUP) : 'none';
  const groupValue = group == null ? fallback : String(group); if (!allowedGroups.includes(groupValue)) throw new RangeError(`Unsupported Deribit ${native} group: ${group}`);
  const depthValue = String(Math.trunc(finiteNumber(depth, 'depth'))); if (!['1', '10', '20'].includes(depthValue)) throw new RangeError(`Unsupported Deribit depth: ${depth}`);
  if (!['100ms', 'agg2'].includes(String(interval))) throw new RangeError(`Unsupported Deribit interval: ${interval}`);
  const channel = `book.${native}.${groupValue}.${depthValue}.${String(interval)}`;
  return {
    url: DERIBIT_PUBLIC_WS_URL, method: 'subscribe', args: [channel], topic: channel, channel,
    instrumentName: native, group: groupValue, depth: depthValue, interval: String(interval),
    // The grouped channel has already coarsened prices at the provider. Keep
    // this explicit so the browser cannot render a finer, invented grid.
    sourceGrouping: groupValue === 'none' ? null : Number(groupValue), sourceDepth: Number(depthValue), sourceInterval: String(interval),
  };
}

export function normalizeDeribitInstrumentInfo(payload: unknown, { receivedAt = Date.now() }: AdapterOptions = {}) {
  const row = resultOf(payload); if (!row || typeof row !== 'object') throw new TypeError('Deribit instrument metadata missing');
  const native = instrument(recordValue(row).instrument_name);
  const market = marketFor(native, { base: recordValue(row).base_currency, quote: recordValue(row).counter_currency ?? 'USD', tickSize: finiteNumber(recordValue(row).tick_size, 'tick_size'), futureType: recordValue(row).future_type });
  return { kind: 'metadata' as const, venue: 'deribit', sourceTimestamp: epochMs(recordValue(row).timestamp ?? recordValue(row).creation_timestamp, receivedAt), receivedAt, assets: [{ instrumentId: deribitInstrumentId(native), ...market, venue: 'deribit', isDelisted: recordValue(row).is_active === false, tickSize: market.tickSize, lotSize: recordValue(row).min_trade_amount, settleCoin: recordValue(row).settlement_currency, metadataSource: 'deribit-v2-public-get-instrument' }] };
}

function channelGrouping(payload: unknown, native: unknown) {
  const channel = String(recordValue(recordValue(payload)?.params)?.channel ?? '');
  const match = channel.match(/^book\.([^\.]+)\.([^\.]+)\.([^\.]+)\.([^\.]+)$/i);
  if (!match || match[1].toUpperCase() !== native) return {};
  const group = match[2].toLowerCase() === 'none' ? null : Number(match[2]);
  const depth = Number(match[3]);
  return { sourceGrouping: group != null && Number.isFinite(group) && group > 0 ? group : null, sourceDepth: depth != null && depth != null && Number.isInteger(depth) && depth > 0 ? depth : null, sourceInterval: match[4] };
}

/** Normalize REST depth or grouped WebSocket snapshots. Grouped channel updates are full snapshots. */
export function normalizeDeribitDepth(payload: unknown, { instrumentName, sourceGrouping = undefined, sourceDepth = undefined, sourceInterval = undefined, receivedAt = Date.now() }: AdapterOptions = {}) {
  const envelope = assertDeribit(payload);
  const row = resultOf(envelope);
  const native = instrument(instrumentName ?? recordValue(row)?.instrument_name ?? recordValue(recordValue(recordValue(envelope)?.params)?.data)?.instrument_name);
  const asks = recordValue(row)?.asks; const bids = recordValue(row)?.bids;
  if (!Array.isArray(asks) || !Array.isArray(bids)) throw new TypeError('Deribit depth bids/asks missing');
  const market = marketFor(native);
  const sourceTimestamp = epochMs(recordValue(row)?.timestamp ?? recordValue(recordValue(recordValue(envelope)?.params)?.data)?.timestamp, receivedAt);
  const id = recordValue(row)?.change_id ?? recordValue(row)?.changeId;
  const channel = channelGrouping(envelope, native);
  const grouping = sourceGrouping === undefined ? channel.sourceGrouping : sourceGrouping == null ? null : finiteNumber(sourceGrouping, 'sourceGrouping');
  const depth = sourceDepth === undefined ? channel.sourceDepth : sourceDepth == null ? null : Math.trunc(finiteNumber(sourceDepth, 'sourceDepth'));
  const interval = sourceInterval === undefined ? channel.sourceInterval : sourceInterval == null ? null : String(sourceInterval);
  const grouped = grouping != null && Number.isFinite(grouping) && grouping > 0;
  return {
    kind: 'depthSnapshot' as const, venue: 'deribit', instrumentId: deribitInstrumentId(native), nativeSymbol: market.nativeSymbol, market, units: market.quantityUnit,
    sourceTimestamp, receivedAt, sequence: sequence(id, 'snapshot change_id'), complete: true, coverage: 'partial' as const,
    ...(grouped ? { resolution: 'coarse' as const, resolutionKey: `group:${grouping}`, sourceGrouping: grouping } : { resolution: 'native' as const, resolutionKey: 'native' }),
    ...(depth != null && Number.isInteger(depth) && depth > 0 ? { sourceDepth: depth } : {}), ...(interval ? { sourceInterval: interval } : {}),
    bids: deribitRows(bids, 'bids'), asks: deribitRows(asks, 'asks'),
  };
}

export class DeribitConnector {
  networkEnabled: boolean;
  transport: AdapterTransport | null;
  constructor({ transport = null, networkEnabled = false }: AdapterOptions = {}) { this.transport = transport; this.networkEnabled = networkEnabled; }
  async request(kind: string, params: AdapterOptions = {}) { if (!this.networkEnabled || !this.transport?.request) throw new AdapterTransportError('Deribit network disabled; inject transport and set networkEnabled=true'); return this.transport.request(buildDeribitRequest(kind, params)); }
  async subscribe(kind: string, params: AdapterOptions = {}) { if (!this.networkEnabled || !this.transport?.subscribe) throw new AdapterTransportError('Deribit network disabled; inject transport and set networkEnabled=true'); return this.transport.subscribe(buildDeribitSubscription(kind, params)); }
}
