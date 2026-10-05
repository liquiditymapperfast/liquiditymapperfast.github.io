/** Server-side execution boundary; no network, candles, L2, or implicit side inference. */
import { types } from 'node:util';
import { canonicalFootprintDecimal } from './footprint-grouping.mts';

export const FOOTPRINT_EXECUTION_MAX_STRING = 192;
export const FOOTPRINT_MAX_EVENT_TIME_MS = 8_640_000_000_000_000 - 60_000;
export type FootprintAggressor = 'buy' | 'sell' | 'unknown';
export type FootprintUsdBasis = 'native-usd' | 'stablecoin-equivalent' | 'verified-contract';
export interface FootprintSource {
  readonly venue: 'hyperliquid' | 'binance';
  readonly instrumentId: string;
  readonly nativeSymbol: string;
  readonly baseAsset: string;
  readonly quoteAsset: 'USD' | 'USDT';
  readonly marketType: 'spot' | 'perpetual';
  readonly channel: 'hyperliquid-trades' | 'binance-aggTrade';
  readonly usdBasis: FootprintUsdBasis;
  readonly quantityUnit: 'base' | 'contract';
  readonly contractValue: number | null;
  /** Explicit independently verified gate; unknown is never treated as sell. */
  readonly aggressorVerified: boolean;
}
export interface FootprintExecution {
  readonly venue: FootprintSource['venue'];
  readonly instrumentId: string;
  readonly executionId: string;
  readonly nativeId: string;
  readonly idBasis: 'time-coin-tid' | 'native-aggregate-id';
  readonly eventTimeMs: number;
  readonly receivedAtMs: number;
  readonly timeBasis: 'exchange';
  readonly price: number;
  readonly priceKey: string;
  readonly quantityBase: number;
  readonly notionalUsd: number;
  readonly nativeQuantity: number;
  readonly quantityUnit: FootprintSource['quantityUnit'];
  readonly usdBasis: FootprintUsdBasis;
  readonly contractValue: number | null;
  readonly aggressor: FootprintAggressor;
  readonly sideBasis: 'taker-side' | 'buyer-maker-inverted' | 'unverified';
  readonly recordKind: 'execution' | 'aggregate-execution';
  readonly channel: FootprintSource['channel'];
}

/** Reject effectful reflection before it runs. This boundary is Node/server-only. */
export function footprintPlainRecord(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || types.isProxy(value) || Array.isArray(value)) throw new TypeError('plain-data-record-required');
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) throw new TypeError('plain-data-prototype-required');
  return value as Record<string, unknown>;
}
export function footprintOwn(value: Record<string, unknown>, name: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(value, name);
  if (descriptor && !('value' in descriptor)) throw new TypeError('accessor-field:' + name);
  return descriptor?.value;
}
export function footprintInertArray(value: unknown, maximum: number): readonly unknown[] {
  if (!Array.isArray(value) || types.isProxy(value) || Object.getPrototypeOf(value) !== Array.prototype) throw new TypeError('plain-array-required');
  const length = Object.getOwnPropertyDescriptor(value, 'length')?.value;
  if (!Number.isSafeInteger(length) || length < 0 || length > maximum) throw new RangeError('array-capacity');
  for (const name of Reflect.ownKeys(value)) {
    if (name === 'length') continue;
    if (typeof name !== 'string' || !/^(0|[1-9]\d*)$/.test(name) || Number(name) >= length) throw new TypeError('extra-array-owner');
  }
  for (let index = 0; index < length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor || !('value' in descriptor)) throw new TypeError('dense-inert-array-required');
  }
  return value;
}
export function footprintString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length < 1 || value.length > FOOTPRINT_EXECUTION_MAX_STRING || !/^[A-Za-z0-9._:-]+$/.test(value)) throw new TypeError('invalid-' + field);
  return value;
}
export function footprintTime(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0 || value > FOOTPRINT_MAX_EVENT_TIME_MS) throw new TypeError('invalid-' + field);
  return value;
}
function positive(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) throw new TypeError('invalid-' + field);
  return value;
}
function close(a: number, b: number): boolean { return Number.isFinite(a) && Number.isFinite(b) && Math.abs(a - b) <= Math.max(Number.MIN_VALUE, Math.abs(a), Math.abs(b)) * 1e-12; }
function nativeInteger(value: unknown, field: string): string {
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value) || value < 0) throw new TypeError('unsafe-' + field);
    return String(value);
  }
  if (typeof value !== 'string' || value.length > 64 || !/^(0|[1-9]\d*)$/.test(value)) throw new TypeError('invalid-' + field);
  return value; // Large exact decimal IDs stay strings, never round through Number.
}
function sourceFields(source: FootprintSource): void {
  const value = footprintPlainRecord(source);
  const fields = ['venue', 'instrumentId', 'nativeSymbol', 'baseAsset', 'quoteAsset', 'marketType', 'channel', 'usdBasis', 'quantityUnit', 'contractValue', 'aggressorVerified'];
  for (const name of Reflect.ownKeys(value)) if (typeof name !== 'string' || !fields.includes(name) || !('value' in (Object.getOwnPropertyDescriptor(value, name) ?? {}))) throw new TypeError('extra-source-owner');
  for (const name of fields) footprintOwn(value, name);
  footprintString(source.instrumentId, 'instrument-id'); footprintString(source.nativeSymbol, 'symbol'); footprintString(source.baseAsset, 'base');
  if (typeof source.aggressorVerified !== 'boolean' || !['spot', 'perpetual'].includes(source.marketType)) throw new TypeError('invalid-source');
  if (source.venue === 'hyperliquid') {
    if (source.instrumentId !== `hyperliquid:${source.nativeSymbol}-PERP` || source.baseAsset !== source.nativeSymbol || source.marketType !== 'perpetual' || source.channel !== 'hyperliquid-trades' || source.quoteAsset !== 'USD' || source.usdBasis !== 'native-usd' || source.quantityUnit !== 'base' || source.contractValue !== null) throw new TypeError('hyperliquid-source-mismatch');
  } else if (source.venue === 'binance') {
    if (!/^[A-Z0-9_]+$/.test(source.nativeSymbol) || source.channel !== 'binance-aggTrade' || source.instrumentId !== `binance:${source.nativeSymbol}${source.marketType === 'spot' ? ':spot' : ''}`) throw new TypeError('binance-source-mismatch');
    if (source.quantityUnit === 'contract') {
      if (source.marketType !== 'perpetual' || source.quoteAsset !== 'USD' || source.usdBasis !== 'verified-contract') throw new TypeError('inverse-source-mismatch');
      positive(source.contractValue, 'contract-value');
    } else if (source.quantityUnit !== 'base' || source.quoteAsset !== 'USDT' || !source.nativeSymbol.endsWith('USDT') || source.nativeSymbol.slice(0, -4) !== source.baseAsset || source.usdBasis !== 'stablecoin-equivalent' || source.contractValue !== null) throw new TypeError('usdt-source-mismatch');
  } else throw new TypeError('unsupported-execution-venue');
}
export function validateFootprintSource(source: FootprintSource): FootprintSource {
  sourceFields(source);
  return Object.freeze({ ...source });
}

/** Borrow-only validation; does not clone, retain or infer missing source fields. */
export function assertFootprintExecution(value: unknown, source?: FootprintSource): asserts value is FootprintExecution {
  const row = footprintPlainRecord(value);
  const get = (key: string) => footprintOwn(row, key);
  const fields = ['venue', 'instrumentId', 'executionId', 'nativeId', 'idBasis', 'eventTimeMs', 'receivedAtMs', 'timeBasis', 'price', 'priceKey', 'quantityBase', 'notionalUsd', 'nativeQuantity', 'quantityUnit', 'usdBasis', 'contractValue', 'aggressor', 'sideBasis', 'recordKind', 'channel'];
  for (const name of Reflect.ownKeys(row)) if (typeof name !== 'string' || !fields.includes(name) || !Object.getOwnPropertyDescriptor(row, name)?.enumerable || !('value' in (Object.getOwnPropertyDescriptor(row, name) ?? {}))) throw new TypeError('unsupported-execution-property');
  const instrumentId = footprintString(get('instrumentId'), 'instrument-id'), executionId = footprintString(get('executionId'), 'execution-id');
  const eventTimeMs = footprintTime(get('eventTimeMs'), 'event-time'); footprintTime(get('receivedAtMs'), 'receipt-time');
  const nativeId = nativeInteger(get('nativeId'), 'native-id');
  const decimal = canonicalFootprintDecimal(get('priceKey'));
  const price = positive(get('price'), 'price'), base = positive(get('quantityBase'), 'base'), usd = positive(get('notionalUsd'), 'usd'), native = positive(get('nativeQuantity'), 'native-quantity');
  if (decimal.key !== get('priceKey') || decimal.value !== price || !close(price * base, usd) || get('timeBasis') !== 'exchange' || (typeof get('aggressor') !== 'string' || !['buy', 'sell', 'unknown'].includes(get('aggressor') as string))) throw new TypeError('execution-value-provenance');
  if (get('aggressor') === 'unknown' ? get('sideBasis') !== 'unverified' : !['taker-side', 'buyer-maker-inverted'].includes(get('sideBasis') as string)) throw new TypeError('aggressor-basis-mismatch');
  if (get('venue') === 'hyperliquid') {
    if (get('channel') !== 'hyperliquid-trades' || get('idBasis') !== 'time-coin-tid' || get('recordKind') !== 'execution' || get('usdBasis') !== 'native-usd' || get('quantityUnit') !== 'base' || get('contractValue') !== null || !close(native, base) || (get('aggressor') !== 'unknown' && get('sideBasis') !== 'taker-side')) throw new TypeError('hyperliquid-execution-provenance');
    const coin = instrumentId.startsWith('hyperliquid:') && instrumentId.endsWith('-PERP') ? instrumentId.slice(12, -5) : '';
    if (!coin || executionId !== `${eventTimeMs}:${coin}:${nativeId}`) throw new TypeError('hyperliquid-native-id-required');
  } else if (get('venue') === 'binance') {
    if (!instrumentId.startsWith('binance:') || get('channel') !== 'binance-aggTrade' || get('idBasis') !== 'native-aggregate-id' || get('recordKind') !== 'aggregate-execution' || executionId !== nativeId || (get('aggressor') !== 'unknown' && get('sideBasis') !== 'buyer-maker-inverted')) throw new TypeError('binance-aggregate-provenance');
    if (get('quantityUnit') === 'contract') {
      const contract = positive(get('contractValue'), 'contract-value');
      if (get('usdBasis') !== 'verified-contract' || !close(native * contract, usd)) throw new TypeError('inverse-conversion-mismatch');
    } else if (get('quantityUnit') !== 'base' || get('usdBasis') !== 'stablecoin-equivalent' || get('contractValue') !== null || !close(native, base)) throw new TypeError('base-conversion-mismatch');
  } else throw new TypeError('unsupported-execution-venue');
  if (source) {
    sourceFields(source);
    if (get('venue') !== source.venue || instrumentId !== source.instrumentId || get('channel') !== source.channel || get('usdBasis') !== source.usdBasis || get('quantityUnit') !== source.quantityUnit || get('contractValue') !== source.contractValue || (!source.aggressorVerified && get('aggressor') !== 'unknown')) throw new TypeError('foreign-execution-source');
  }
}
export function footprintExecutionBytesUpper(value: FootprintExecution): number {
  // Includes scalar/provenance property keys, UTF-16 text and a detached row shell.
  let bytes = 1_024;
  for (const field of ['venue', 'instrumentId', 'executionId', 'nativeId', 'idBasis', 'timeBasis', 'priceKey', 'quantityUnit', 'usdBasis', 'aggressor', 'sideBasis', 'recordKind', 'channel'] as const) bytes += value[field].length * 2;
  return bytes;
}
