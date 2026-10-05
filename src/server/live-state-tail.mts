import { types } from 'node:util';
import type { RuntimeCandle, RuntimeOiSample } from '../domain/runtime-state.mts';

export const LIVE_STATE_TAIL_FORMAT = 'hlm-live-state-tail-v1' as const;
export const LIVE_STATE_TAIL_LIMITS = Object.freeze({ candleRowsPerInterval: 3, maxOiRows: 20_000,
  maxCandleSeries: 128, maxOiInstruments: 128, maxCandleRows: 256_000, maxIntervalGroups: 640, maxWorkingBytes: 4 * 1024 * 1024 });
export interface LiveStateTailCounts { oiRows: number; candleSeries: number; candleRows: number; intervalGroupsUpper: number; }
export interface LiveStateTailMetadata {
  format: typeof LIVE_STATE_TAIL_FORMAT;
  basis: 'recent-native-observations'; merge: 'upsert-only'; historyComplete: false;
  candleRowsPerInstrumentInterval: 3; oiRowsPerInstrument: 1;
  oiSelectionBasis: 'observationTimestamp/sourceTimestamp/receivedAt';
  omittedRowsAreRemovals: false; sourceValuesUnchanged: true;
  recovery: 'full-bootstrap-and-history-loader'; olderCorrections: 'require-full-state';
}
export type LiveStateTailInput = Record<string, unknown>;
export type LiveStateTailValue<T extends LiveStateTailInput> = Omit<T, 'oi' | 'candles'> & {
  oi: RuntimeOiSample[]; candles: Record<string, RuntimeCandle[]>; stateProjection: LiveStateTailMetadata;
};
export interface LiveStateTailResult<T extends LiveStateTailInput> {
  complete: boolean; reason: string | null; workingBytes: number;
  counts: LiveStateTailCounts | null; value: LiveStateTailValue<T> | null;
}
/** Numeric only: call before projection under a logical AND physical grant. */
export function liveStateTailWorkingBytes(counts: LiveStateTailCounts): number {
  const limits = [LIVE_STATE_TAIL_LIMITS.maxOiRows, LIVE_STATE_TAIL_LIMITS.maxCandleSeries,
    LIVE_STATE_TAIL_LIMITS.maxCandleRows, LIVE_STATE_TAIL_LIMITS.maxIntervalGroups];
  const values = [counts.oiRows, counts.candleSeries, counts.candleRows, counts.intervalGroupsUpper];
  if (values.some((n, i) => !Number.isSafeInteger(n) || n < 0 || n > limits[i]!)) throw new RangeError('Invalid live-tail counts');
  if (counts.intervalGroupsUpper > counts.candleRows || counts.candleSeries > counts.candleRows && counts.candleRows !== 0)
    throw new RangeError('Inconsistent live-tail counts');
  const bytes = 65_536 + counts.oiRows * 96 + counts.candleRows * 4 + counts.candleSeries * 512
    + counts.intervalGroupsUpper * 768;
  if (!Number.isSafeInteger(bytes) || bytes > LIVE_STATE_TAIL_LIMITS.maxWorkingBytes) throw new RangeError('Live-tail allowance overflow');
  return bytes;
}
function record(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || types.isProxy(value) || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}
function own(value: Record<string, unknown>, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  if (!descriptor || !('value' in descriptor)) throw new TypeError(`Missing/effectful live-tail field ${key}`);
  return descriptor.value;
}
function array(value: unknown, maximum: number): asserts value is unknown[] {
  if (!Array.isArray(value) || types.isProxy(value) || Object.getPrototypeOf(value) !== Array.prototype
      || !Number.isSafeInteger(value.length) || value.length > maximum) throw new TypeError('Invalid live-tail array');
}
function slot(rows: unknown[], index: number): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(rows, String(index));
  if (!descriptor || !('value' in descriptor)) throw new TypeError('Missing/effectful live-tail slot');
  return descriptor.value;
}
function optionalScalar(row: Record<string, unknown>, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(row, key);
  if (!descriptor) return undefined;
  if (!('value' in descriptor)) throw new TypeError(`Effectful live-tail field ${key}`);
  return descriptor.value;
}
function timed(row: Record<string, unknown>): number {
  for (const key of ['observationTimestamp', 'sourceTimestamp', 'receivedAt']) {
    const value = optionalScalar(row, key);
    if (value == null) continue;
    if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) throw new TypeError('Invalid observation time');
    return value;
  }
  throw new TypeError('Untimed OI requires full state');
}
/**
 * Only reducer-owned synchronous snapshot DTOs are supported. Rows are borrowed
 * unchanged; original graph ownership and normal bounded JSON/body reservations
 * MUST remain live. No cache, row cloning, history mutation, or field deletion.
 * Pass maxWorkingBytes reserved before even planning the input. On failure use
 * the original full frame, under its existing guards; never send a partial tail.
 */
export function projectLiveStateTail<T extends LiveStateTailInput>(input: T,
  { reservedWorkingBytes }: { reservedWorkingBytes: number }): LiveStateTailResult<T> {
  const failure = (reason: string): LiveStateTailResult<T> => ({ complete: false, reason, workingBytes: 0, counts: null, value: null });
  if (!Number.isSafeInteger(reservedWorkingBytes) || reservedWorkingBytes < LIVE_STATE_TAIL_LIMITS.maxWorkingBytes)
    return failure('live-tail-pregrant-required');
  try {
    if (!record(input)) return failure('invalid-live-tail-input');
    if (Object.hasOwn(input, 'stateProjection')) return failure('already-projected-input');
    const topKeys = Object.keys(input);
    if (topKeys.length > 128 || topKeys.some((key) => key.length > 256)) return failure('snapshot-field-limit');
    for (const key of topKeys) own(input, key);
    const oiInput = own(input, 'oi'); const candleInput = own(input, 'candles');
    array(oiInput, LIVE_STATE_TAIL_LIMITS.maxOiRows);
    if (!record(candleInput)) return failure('invalid-candle-series');
    const series = Object.keys(candleInput);
    if (series.length > LIVE_STATE_TAIL_LIMITS.maxCandleSeries) return failure('candle-series-limit');
    const latest = new Map<string, { row: RuntimeOiSample; time: number; received: number }>();
    for (let index = 0; index < oiInput.length; index += 1) {
      const row = slot(oiInput, index);
      if (!record(row)) throw new TypeError('Invalid OI row');
      const id = own(row, 'instrumentId');
      if (typeof id !== 'string' || !id || id.length > 256) throw new TypeError('Invalid OI identity');
      const time = timed(row); const received = optionalScalar(row, 'receivedAt');
      const receiveTime = typeof received === 'number' && Number.isFinite(received) ? received : 0;
      const prior = latest.get(id);
      if (!prior && latest.size >= LIVE_STATE_TAIL_LIMITS.maxOiInstruments) throw new RangeError('OI instrument limit');
      if (!prior || time > prior.time || time === prior.time && receiveTime >= prior.received)
        latest.set(id, { row: row as RuntimeOiSample, time, received: receiveTime });
    }
    const candles: Record<string, RuntimeCandle[]> = Object.create(null) as Record<string, RuntimeCandle[]>;
    let candleRows = 0; let groups = 0;
    for (const instrumentId of series) {
      if (!instrumentId || instrumentId.length > 256) throw new TypeError('Invalid candle identity');
      const rows = own(candleInput, instrumentId); array(rows, LIVE_STATE_TAIL_LIMITS.maxCandleRows);
      candleRows += rows.length;
      if (candleRows > LIVE_STATE_TAIL_LIMITS.maxCandleRows) throw new RangeError('Candle row limit');
      const byInterval = new Map<string, RuntimeCandle[]>();
      for (let index = 0; index < rows.length; index += 1) {
        const row = slot(rows, index);
        if (!record(row) || own(row, 'instrumentId') !== instrumentId) throw new TypeError('Foreign candle identity');
        const interval = own(row, 'interval'); const start = own(row, 'start'); const end = own(row, 'end');
        if (typeof interval !== 'string' || !/^\d+[mhd]$/.test(interval) || interval.length > 16
          || typeof start !== 'number' || !Number.isFinite(start) || start < 0
          || typeof end !== 'number' || !Number.isFinite(end) || end <= start) throw new TypeError('Invalid candle row');
        for (const field of ['open', 'high', 'low', 'close']) {
          const value = own(row, field);
          if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) throw new TypeError('Invalid native OHLC');
        }
        let tail = byInterval.get(interval);
        if (!tail) {
          groups += 1; if (groups > LIVE_STATE_TAIL_LIMITS.maxIntervalGroups) throw new RangeError('Interval group limit');
          tail = []; byInterval.set(interval, tail);
        }
        const duplicate = tail.findIndex((old) => old.start === start);
        if (duplicate >= 0) throw new TypeError('Duplicate native candle requires full state');
        tail.push(row as unknown as RuntimeCandle);
        tail.sort((a, b) => a.start - b.start);
        if (tail.length > LIVE_STATE_TAIL_LIMITS.candleRowsPerInterval) tail.shift();
      }
      candles[instrumentId] = [...byInterval.values()].flat().sort((a, b) => a.start - b.start);
    }
    const counts = { oiRows: oiInput.length, candleSeries: series.length, candleRows, intervalGroupsUpper: groups };
    const workingBytes = liveStateTailWorkingBytes(counts);
    const stateProjection: LiveStateTailMetadata = { format: LIVE_STATE_TAIL_FORMAT, basis: 'recent-native-observations',
      merge: 'upsert-only', historyComplete: false, candleRowsPerInstrumentInterval: 3, oiRowsPerInstrument: 1,
      oiSelectionBasis: 'observationTimestamp/sourceTimestamp/receivedAt', omittedRowsAreRemovals: false,
      sourceValuesUnchanged: true, recovery: 'full-bootstrap-and-history-loader', olderCorrections: 'require-full-state' };
    return { complete: true, reason: null, workingBytes, counts,
      value: { ...input, oi: [...latest.values()].map(({ row }) => row), candles, stateProjection } };
  } catch (error) { return failure(error instanceof Error ? error.message : 'live-tail-projection-failed'); }
}
