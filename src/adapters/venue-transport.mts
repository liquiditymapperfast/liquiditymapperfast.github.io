import { recordValue, arrayValue, type AdapterOptions, type WireRecord } from './common.mts';
import { finiteNumber } from './common.mts';

// Conservative public-data budgets. They are deliberately per venue: a busy
// Bitget selection must not consume another venue's connection/message budget.
export interface VenueTransportPolicy { maxConnections: number; subscribeIntervalMs: number; heartbeatIntervalMs: number; heartbeatTimeoutMs: number; }
export type VenuePolicyOverrides = Record<string, Partial<VenueTransportPolicy>>;
interface VenueBudgetState { connections: number; nextMessageAt: number; subscriptions: Map<string, number>; }
export const VENUE_TRANSPORT_POLICIES: Readonly<Record<string, Readonly<VenueTransportPolicy>>> = Object.freeze({
  hyperliquid: Object.freeze({ maxConnections: 10, subscribeIntervalMs: 100, heartbeatIntervalMs: 30_000, heartbeatTimeoutMs: 10_000 }),
  binance: Object.freeze({ maxConnections: 10, subscribeIntervalMs: 100, heartbeatIntervalMs: 180_000, heartbeatTimeoutMs: 600_000 }),
  bybit: Object.freeze({ maxConnections: 10, subscribeIntervalMs: 100, heartbeatIntervalMs: 20_000, heartbeatTimeoutMs: 10_000 }),
  okx: Object.freeze({ maxConnections: 10, subscribeIntervalMs: 100, heartbeatIntervalMs: 25_000, heartbeatTimeoutMs: 10_000 }),
  bitget: Object.freeze({ maxConnections: 50, subscribeIntervalMs: 150, heartbeatIntervalMs: 30_000, heartbeatTimeoutMs: 10_000 }),
  gateio: Object.freeze({ maxConnections: 10, subscribeIntervalMs: 100, heartbeatIntervalMs: 20_000, heartbeatTimeoutMs: 10_000 }),
  deribit: Object.freeze({ maxConnections: 10, subscribeIntervalMs: 100, heartbeatIntervalMs: 30_000, heartbeatTimeoutMs: 10_000 }),
  coinbase: Object.freeze({ maxConnections: 10, subscribeIntervalMs: 100, heartbeatIntervalMs: 30_000, heartbeatTimeoutMs: 10_000 }),
  kraken: Object.freeze({ maxConnections: 10, subscribeIntervalMs: 100, heartbeatIntervalMs: 180_000, heartbeatTimeoutMs: 600_000 }),
  kucoin: Object.freeze({ maxConnections: 10, subscribeIntervalMs: 100, heartbeatIntervalMs: 18_000, heartbeatTimeoutMs: 10_000 }),
  mexc: Object.freeze({ maxConnections: 10, subscribeIntervalMs: 100, heartbeatIntervalMs: 20_000, heartbeatTimeoutMs: 10_000 }),
  htx: Object.freeze({ maxConnections: 10, subscribeIntervalMs: 100, heartbeatIntervalMs: 20_000, heartbeatTimeoutMs: 10_000 }),
  bitfinex: Object.freeze({ maxConnections: 10, subscribeIntervalMs: 100, heartbeatIntervalMs: 15_000, heartbeatTimeoutMs: 10_000 }),
  bitmex: Object.freeze({ maxConnections: 10, subscribeIntervalMs: 100, heartbeatIntervalMs: 30_000, heartbeatTimeoutMs: 10_000 }),
  cryptocom: Object.freeze({ maxConnections: 10, subscribeIntervalMs: 1_000, heartbeatIntervalMs: 30_000, heartbeatTimeoutMs: 5_000 }),
  bitstamp: Object.freeze({ maxConnections: 10, subscribeIntervalMs: 100, heartbeatIntervalMs: 10_000, heartbeatTimeoutMs: 10_000 }),
  whitebit: Object.freeze({ maxConnections: 10, subscribeIntervalMs: 100, heartbeatIntervalMs: 50_000, heartbeatTimeoutMs: 10_000 }),
  phemex: Object.freeze({ maxConnections: 5, subscribeIntervalMs: 50, heartbeatIntervalMs: 5_000, heartbeatTimeoutMs: 15_000 }),
  dydx: Object.freeze({ maxConnections: 10, subscribeIntervalMs: 100, heartbeatIntervalMs: 30_000, heartbeatTimeoutMs: 10_000 }),
  aster: Object.freeze({ maxConnections: 10, subscribeIntervalMs: 100, heartbeatIntervalMs: 300_000, heartbeatTimeoutMs: 900_000 }),
});

export function venueTransportPolicy(venue: string, overrides: VenuePolicyOverrides = {}) {
  const key = String(venue ?? '').toLowerCase();
  const policy = VENUE_TRANSPORT_POLICIES[key];
  if (!policy) throw new RangeError(`Unsupported venue transport policy: ${key || '(empty)'}`);
  return { ...policy, ...(overrides[key] ?? {}) };
}

export function venueControlFrame(venue: string, request: unknown, operation: unknown = 'subscribe', { now = Date.now(), requestId = 1 }: { now?: number; requestId?: number | string } = {}) {
  const key = String(venue).toLowerCase();
  const op = operation === 'unsubscribe' ? 'unsubscribe' : 'subscribe';
  if (key === 'hyperliquid') return operation === 'unsubscribe' ? { method: 'unsubscribe', subscription: recordValue(request).subscription } : request;
  if (key === 'bybit' || key === 'okx' || key === 'bitget') return { op, args: recordValue(request).args };
  if (key === 'gateio') return { time: Math.floor(now / 1000), channel: recordValue(request).channel, event: op, payload: recordValue(request).args };
  if (key === 'deribit') return { jsonrpc: '2.0', id: requestId, method: `public/${op}`, params: { channels: recordValue(request).args } };
  if (key === 'coinbase') return { type: op, product_ids: recordValue(request).args, channels: [recordValue(request).channel] };
  if (key === 'kraken') return { method: op, params: { channel: recordValue(request).channel, symbol: [recordValue(request).symbol], depth: recordValue(request).depth, ...(op === 'subscribe' ? { snapshot: recordValue(request).snapshot } : {}) } };
  if (key === 'kucoin') return { id: recordValue(request).id, type: op, topic: recordValue(request).topic, response: true };
  if (key === 'mexc') return op === 'subscribe' ? { method: recordValue(request).method, param: recordValue(request).param } : { method: 'usub.depth.full', param: { symbol: recordValue(request).symbol } };
  if (key === 'htx') return op === 'subscribe' ? { sub: recordValue(request).sub, id: recordValue(request).id } : { unsub: recordValue(request).topic, id: recordValue(request).id };
  if (key === 'bitfinex') {
    if (op === 'unsubscribe') return { event: 'unsubscribe', chanId: recordValue(request).channelId };
    return { event: 'subscribe', channel: recordValue(request).channel, symbol: recordValue(request).symbol, prec: recordValue(request).precision, freq: recordValue(request).frequency, len: recordValue(request).len, subId: recordValue(request).subId };
  }
  if (key === 'bitmex') return { op, args: recordValue(request).args };
  if (key === 'cryptocom') return { id: recordValue(request).id ?? requestId, method: op, params: op === 'subscribe' ? recordValue(request).params : { channels: recordValue(recordValue(request).params)?.channels ?? [recordValue(request).topic] } };
  if (key === 'bitstamp') return op === 'unsubscribe'
    ? { event: 'bts:unsubscribe', data: { channel: recordValue(request).channel } }
    : { event: 'bts:subscribe', data: { channel: recordValue(request).channel } };
  if (key === 'whitebit') return op === 'unsubscribe'
    ? { id: recordValue(request).id ?? requestId, method: 'depth_unsubscribe', params: [] }
    : { id: recordValue(request).id ?? requestId, method: recordValue(request).method, params: recordValue(request).params };
  if (key === 'phemex') return op === 'unsubscribe'
    ? { id: recordValue(request).id ?? requestId, method: 'orderbook.unsubscribe', params: [] }
    : { id: recordValue(request).id ?? requestId, method: recordValue(request).method, params: recordValue(request).params };
  if (key === 'dydx') return { type: op, channel: recordValue(request).channel, id: recordValue(request).id };
  if (key === 'aster') return { method: operation === 'unsubscribe' ? 'UNSUBSCRIBE' : 'SUBSCRIBE', params: recordValue(request).params, id: recordValue(request).id };
  return null; // Binance combined-stream URLs subscribe as part of the URL.
}

export function venueHeartbeatFrame(venue: string, { now = Date.now(), requestId = 0 }: { now?: number; requestId?: number | string } = {}) {
  const key = String(venue).toLowerCase();
  if (key === 'hyperliquid') return { method: 'ping' };
  if (key === 'bybit') return { op: 'ping' };
  if (key === 'okx' || key === 'bitget') return 'ping';
  if (key === 'gateio') return { time: Math.floor(now / 1000), channel: 'futures.ping' };
  if (key === 'deribit') return { jsonrpc: '2.0', id: requestId, method: 'public/test', params: {} };
  if (key === 'kucoin') return { id: String(requestId), type: 'ping' };
  if (key === 'mexc') return { method: 'ping' };
  if (key === 'htx') return { ping: Math.trunc(now) };
  if (key === 'bitmex') return 'ping';
  if (key === 'cryptocom') return null;
  if (key === 'bitstamp') return { event: 'bts:heartbeat' };
  if (key === 'whitebit') return { id: requestId, method: 'ping', params: [] };
  if (key === 'phemex') return { id: requestId, method: 'server.ping', params: [] };
  // dYdX relies on the WebSocket protocol heartbeat; there is no documented
  // application-level ping frame to invent here.
  if (key === 'dydx') return null;
  // Aster sends WebSocket ping frames every five minutes; the client library
  // answers them at the protocol layer, so no JSON heartbeat is invented.
  if (key === 'aster') return null;
  return null;
}

export function reconnectDelay(attempt: unknown, { baseMs = 1_000, maxMs = 30_000, jitter = 0, random = Math.random }: AdapterOptions = {}) {
  const ordinal = Math.max(1, Math.trunc(finiteNumber(attempt, 'attempt')));
  const bounded = Math.min(maxMs, baseMs * 2 ** (ordinal - 1));
  const spread = Math.max(0, Math.min(1, Number(jitter) || 0));
  return Math.min(maxMs, Math.round(bounded * (1 - spread + 2 * spread * random())));
}

export class VenueTransportBudget {
  state: Map<string, VenueBudgetState>;
  now: () => number;
  policies: VenuePolicyOverrides;
  constructor({ policies = {}, now = () => Date.now() }: { policies?: VenuePolicyOverrides; now?: () => number } = {}) { this.policies = policies; this.now = now; this.state = new Map(); }
  #state(venue: string): VenueBudgetState { const key = String(venue).toLowerCase(); let state = this.state.get(key); if (!state) { state = { connections: 0, nextMessageAt: 0, subscriptions: new Map() }; this.state.set(key, state); } return state; }
  acquireConnection(venue: string) { const state = this.#state(venue); const policy = venueTransportPolicy(venue, this.policies); if (state.connections >= policy.maxConnections) throw new RangeError(`${venue} connection budget exhausted`); state.connections += 1; return state.connections; }
  releaseConnection(venue: string) { const state = this.#state(venue); state.connections = Math.max(0, state.connections - 1); }
  planMessage(venue: string) { const state = this.#state(venue); const policy = venueTransportPolicy(venue, this.policies); const at = Math.max(this.now(), state.nextMessageAt); state.nextMessageAt = at + policy.subscribeIntervalMs; return { at, delayMs: Math.max(0, at - this.now()) }; }
  touch(venue: string, key: string) { this.#state(venue).subscriptions.set(String(key), this.now()); }
  idleSubscriptions(venue: string, idleMs: unknown) { const cutoff = this.now() - Math.max(0, finiteNumber(idleMs, 'idleMs')); return [...this.#state(venue).subscriptions].filter(([, touched]) => touched <= cutoff).map(([key]) => key); }
  removeSubscription(venue: string, key: string) { return this.#state(venue).subscriptions.delete(String(key)); }
  snapshot() { return Object.fromEntries([...this.state].map(([venue, state]) => [venue, { connections: state.connections, nextMessageAt: state.nextMessageAt, subscriptions: [...state.subscriptions.keys()] }])); }
}

export class VenueHeartbeatDeadline {
  lastHeartbeatAt: number;
  lastObservedAt: number;
  policy: VenueTransportPolicy;
  now: () => number;
  venue: string;
  constructor({ venue, now = () => Date.now(), policies = {} }: { venue?: unknown; now?: () => number; policies?: VenuePolicyOverrides } = {}) {
    this.venue = String(venue ?? '').toLowerCase(); this.now = now;
    this.policy = venueTransportPolicy(this.venue, policies);
    this.lastObservedAt = this.now(); this.lastHeartbeatAt = 0;
  }
  observe(at: unknown = this.now()) { this.lastObservedAt = finiteNumber(at, 'observedAt'); }
  heartbeatSent(at: unknown = this.now()) { this.lastHeartbeatAt = finiteNumber(at, 'heartbeatAt'); }
  nextAction(at: unknown = this.now()) {
    const current = finiteNumber(at, 'now');
    if (current - this.lastObservedAt >= recordValue(this.policy).heartbeatIntervalMs + recordValue(this.policy).heartbeatTimeoutMs) return { action: 'reconnect', reason: 'heartbeat-timeout' };
    if (current - this.lastHeartbeatAt >= recordValue(this.policy).heartbeatIntervalMs) return { action: 'heartbeat', frame: venueHeartbeatFrame(this.venue, { now: current }) };
    return { action: 'wait', delayMs: Math.min(recordValue(this.policy).heartbeatIntervalMs - (current - this.lastHeartbeatAt), recordValue(this.policy).heartbeatIntervalMs + recordValue(this.policy).heartbeatTimeoutMs - (current - this.lastObservedAt)) };
  }
}

export function convertVenueQuantity({ amount, price, quantityUnit = 'base', contractValue, inverse = false }: AdapterOptions) {
  const value = finiteNumber(amount, 'amount'); const px = finiteNumber(price, 'price');
  if (!(value >= 0) || !(px > 0)) throw new RangeError('amount must be non-negative and price must be positive');
  if (quantityUnit === 'base') return { baseAmount: value, quoteAmount: value * px };
  if (quantityUnit === 'quote') return { baseAmount: value / px, quoteAmount: value };
  if (quantityUnit !== 'contract') throw new RangeError(`Unsupported quantity unit: ${quantityUnit}`);
  const face = finiteNumber(contractValue, 'contractValue'); if (!(face > 0)) throw new RangeError('contractValue must be positive');
  return inverse ? { baseAmount: value * face / px, quoteAmount: value * face } : { baseAmount: value * face, quoteAmount: value * face * px };
}

export async function discoverProductPages({ fetchPage, firstCursor = null, cursorOf = (page: unknown) => recordValue(page)?.nextPageCursor ?? recordValue(recordValue(page)?.result)?.nextPageCursor ?? null, assetsOf = (page: unknown) => arrayValue(recordValue(page)?.assets ?? []).map(recordValue), maxPages = 100 }: { fetchPage?: (cursor: unknown) => unknown | Promise<unknown>; firstCursor?: unknown; cursorOf?: (page: unknown) => unknown; assetsOf?: (page: unknown) => Iterable<WireRecord> | null | undefined; maxPages?: number } = {}) {
  if (typeof fetchPage !== 'function') throw new TypeError('fetchPage is required');
  const assets = new Map<unknown, WireRecord>(); const seen = new Set<string>(); let cursor = firstCursor; let pages = 0;
  do {
    const token = cursor == null ? '' : String(cursor); if (seen.has(token)) throw new Error('product pagination cursor repeated'); seen.add(token);
    const page = await fetchPage(cursor); pages += 1;
    for (const asset of assetsOf(page) ?? []) { if (!asset?.instrumentId) throw new TypeError('product instrumentId is required'); assets.set(asset.instrumentId, asset); }
    cursor = cursorOf(page);
    if (pages >= maxPages && cursor) throw new RangeError('product pagination exceeded maxPages');
  } while (cursor);
  return { assets: [...assets.values()], pages };
}
