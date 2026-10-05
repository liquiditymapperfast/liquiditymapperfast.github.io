import type { PriceAmount } from '../domain/contracts.ts';
/** Shared adapter helpers. These functions only parse values; they never perform I/O. */
export type WireRecord = Record<string, unknown>;
export interface RequestDescriptor { url: string; method?: string; headers?: Record<string, string>; body?: unknown; [key: string]: unknown; }
export interface SubscriptionDescriptor { url?: string; message?: unknown; [key: string]: unknown; }
export interface AdapterTransport {
  request?: (descriptor: RequestDescriptor) => unknown;
  subscribe?: (descriptor: SubscriptionDescriptor) => unknown;
}
export interface ConnectorOptions { transport?: AdapterTransport | null; networkEnabled?: boolean; }
/** Establish only the object container. Individual fields remain unknown until parsed. */
export function recordValue<T extends object>(value: T): keyof T extends never ? WireRecord : T;
export function recordValue(value: unknown): WireRecord;
export function recordValue(value: unknown): object {
  return value !== null && typeof value === 'object' ? value as WireRecord : {};
}
export function arrayValue<T>(value: T[]): T[];
export function arrayValue(value: unknown): unknown[];
export function arrayValue(value: unknown): unknown[] { if (!Array.isArray(value)) throw new TypeError("Expected adapter array"); return value; }
export class AdapterTransportError extends Error {
  constructor(message: string) { super(message); this.name = 'AdapterTransportError'; }
}
export function epochMs(value: unknown, fallback?: number): number;
export function epochMs(value: unknown, fallback: null): number | null;
export function epochMs(value: unknown, fallback: number | null): number | null;
export function epochMs(value: unknown, fallback: number | null = Date.now()): number | null {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return n < 1e12 ? Math.trunc(n * 1000) : Math.trunc(n);
}
export function intervalMilliseconds(interval: unknown): number | null {
  if (Number.isFinite(Number(interval)) && Number(interval) > 0) return Number(interval);
  const match = /^(\d+)([smhd])$/i.exec(String(interval ?? ''));
  if (!match) return null;
  const durations: Record<string, number> = { s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000 };
  return Number(match[1]) * durations[match[2].toLowerCase()];
}
export function finiteNumber(value: unknown, field: string): number {
  const n = Number(value);
  if (!Number.isFinite(n)) throw new TypeError(`Invalid ${field}: expected finite number`);
  return n;
}
/** Validate one normalized OHLC row at the adapter boundary. */
export function validateCandle<T>(candle: T, field = 'candle'): T {
  const value = recordValue(candle);
  const start = Number(value.start);
  const end = Number(value.end);
  const open = Number(value.open);
  const high = Number(value.high);
  const low = Number(value.low);
  const close = Number(value.close);
  const volume = Number(value.volume ?? 0);
  if (!Number.isFinite(start) || start < 0) throw new TypeError(`Invalid ${field}.start: expected finite timestamp`);
  if (!Number.isFinite(end) || !(end > start)) throw new TypeError(`Invalid ${field}.end: expected timestamp after start`);
  if (![open, high, low, close].every((item) => Number.isFinite(item) && item > 0)) throw new TypeError(`Invalid ${field} OHLC: expected positive finite values`);
  if (!(low <= open && low <= close && high >= open && high >= close && low <= high)) throw new TypeError(`Invalid ${field} OHLC ordering`);
  if (!Number.isFinite(volume) || volume < 0) throw new TypeError(`Invalid ${field}.volume: expected non-negative finite number`);
  return candle;
}
export function requireSymbol(value: unknown): string {
  const symbol = String(value ?? '').trim().toUpperCase();
  if (!/^[A-Z0-9._:-]+$/.test(symbol)) throw new TypeError('Invalid exchange symbol');
  return symbol;
}
export function sideLevels(values: unknown, field: string): { price: number; amount: number }[] {
  if (!Array.isArray(values)) throw new TypeError(`Invalid ${field}: expected array`);
  return values.map((row: unknown, index: number) => {
    const value = recordValue(row);
    const priceValue = Array.isArray(row) ? row[0] : value.px ?? value.price;
    const amountValue = Array.isArray(row) ? row[1] : value.sz ?? value.amount;
    if (priceValue == null || amountValue == null) throw new TypeError(`Invalid ${field}[${index}]`);
    return { price: finiteNumber(priceValue, `${field}[${index}].price`), amount: finiteNumber(amountValue, `${field}[${index}].amount`) };
  }).filter(row => row.price > 0 && row.amount >= 0);
}

/** Configuration remains distinct from untrusted exchange payload fields. */
export interface AdapterOptions {
  automatic?: boolean;
  allowNull?: boolean;
  allowUnsequenced?: boolean;
  allowZero?: boolean;
  amount?: unknown;
  asks?: unknown;
  assetsOf?: unknown;
  baseMs?: number;
  baseUrl?: string | null;
  bids?: unknown;
  bookKey?: string;
  category?: string;
  channel?: string | null;
  channelId?: unknown;
  coin?: string;
  complete?: boolean;
  connectId?: string;
  contract?: string;
  contractValue?: number | null;
  count?: number;
  coverage?: string;
  cursorOf?: unknown;
  depth?: number | null;
  endpoint?: unknown;
  endTime?: number;
  feedId?: string;
  fetchImpl?: typeof globalThis.fetch | null;
  fetchPage?: unknown;
  firstCursor?: unknown;
  frequency?: string;
  fullDepth?: boolean;
  group?: unknown;
  id?: unknown;
  instId?: string;
  instrumentId?: string;
  instrumentName?: string;
  instType?: string;
  interval?: string;
  intervalTime?: string;
  inverse?: boolean;
  jitter?: number;
  kind?: string;
  layer?: string;
  ledger?: AdapterQuotaLedger;
  len?: number;
  level?: number;
  limit?: number;
  mantissa?: unknown;
  family?: string;
  marketType?: string;
  markPrice?: number;
  maxMs?: number;
  maxPages?: number;
  metadata?: unknown;
  networkEnabled?: boolean;
  now?: () => number;
  nSigFigs?: unknown;
  openedWithin?: string;
  path?: unknown;
  period?: string;
  policies?: unknown;
  pool?: string | null;
  precision?: string;
  price?: unknown;
  priceScale?: number;
  productId?: string;
  quantityUnit?: string;
  random?: () => number;
  ratioScale?: number;
  receivedAt?: number;
  referencePrice?: unknown;
  requestId?: number | string;
  requireChannel?: boolean;
  required?: boolean;
  requireSequence?: boolean;
  resolutionKey?: string;
  revision?: string;
  segmentId?: unknown;
  sessionToken?: string;
  settle?: string;
  size?: number;
  snapshot?: boolean;
  sourceDepth?: unknown;
  sourceGrouping?: unknown;
  sourceInterval?: unknown;
  sourceKind?: unknown;
  sourceTimestamp?: unknown;
  startTime?: number;
  subId?: unknown;
  subscriptionType?: unknown;
  symbol?: string | null;
  table?: unknown;
  token?: unknown;
  topic?: string;
  transport?: AdapterTransport | null;
  type?: string;
  update?: unknown;
  updateFrequency?: unknown;
  venue?: unknown;
  withId?: boolean;
}

export interface BookSessionFlags { complete: boolean; gap?: boolean; invalidated?: boolean; resyncRequired?: boolean; ignored?: boolean; status?: string; invalidReason?: string; continuity?: string; sequenceBridge?: boolean; }
export interface DepthSessionIdentity { venue?: string; topic: string; instrumentId: string; sessionToken: string; status: string; invalidated: boolean; invalidReason?: string; }
export interface DepthSessionMessageOptions<T> { topic?: string; sessionToken?: string; update?: T; channelId?: unknown; }
export interface DepthSessionResult<T> { session: T; accepted: boolean; ignored: boolean; reason: string | null; checksumOnly?: boolean; }

export interface AdapterDepthBook extends BookSessionFlags { kind: 'depthSnapshot' | 'depthDelta'; instrumentId: string; sourceTimestamp: number | null; receivedAt: number; sequence?: number | string | null; previousSequence?: number | string | null; bids: PriceAmount[]; asks: PriceAmount[]; coverage?: 'complete' | 'partial' | 'unknown'; table?: string; channel?: string; crossSequence?: number | string; sequenceJump?: boolean; checksum?: number; checksumVerified?: boolean; channelId?: number | null; checksumLevels?: unknown; }

export interface AdapterQuotaLedger { spend(cost: number, label: string, now: number, meta: { provider: string; automatic?: boolean }): boolean; readonly lastSpendRejection?: string | null; }

export interface NormalizedAdapterCandle { instrumentId: string; interval: string; start: number; end: number; open: number; high: number; low: number; close: number; volume: number; sourceTimestamp: number | null; closed?: boolean; marketType?: string; }
