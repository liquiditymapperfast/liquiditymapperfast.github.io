import { types } from 'node:util';
import { LIVE_LIQUIDITY_MAX_FRAME_BYTES, LIVE_LIQUIDITY_MAX_JSON_DEPTH } from '../core/liquidity-frame.mts';

/** Bounded native JSON inspection; no getters, hooks or proxy traps execute. */
export const LIQUIDITY_WIRE_MEASUREMENT_LIMITS = Object.freeze({
  maxUtf8Bytes: LIVE_LIQUIDITY_MAX_FRAME_BYTES,
  maxUtf16Bytes: 2 * LIVE_LIQUIDITY_MAX_FRAME_BYTES,
  maxOperations: 8 * 1024 * 1024,
  maxDepth: LIVE_LIQUIDITY_MAX_JSON_DEPTH,
});
// Covers bounded native enumeration/call scratch before any DTO reflection.
// There is no retained per-token worklist or object-key array in this walker.
export const LIQUIDITY_WIRE_MEASUREMENT_SCRATCH_BYTES = 4 * LIVE_LIQUIDITY_MAX_FRAME_BYTES + 65_536;
export type LiquidityWireMeasurementReason = 'invalid-json' | 'cycle' | 'depth-limit' | 'work-limit' | 'size-limit' | 'inspection-failed';
export interface LiquidityWireMeasurement {
  complete: boolean; reason: LiquidityWireMeasurementReason | null;
  utf8Bytes: number | null; utf16Bytes: number | null; requiredBytes: number | null; operations: number;
}
class MeasurementError extends Error {
  constructor(readonly reason: LiquidityWireMeasurementReason) { super(reason); }
}
/** A retry hint only: strictly grows the request, never certifies an unknown graph. */
export function liquidityWireGrowthHint(maximumBytes: number): number {
  return 2 ** Math.ceil(Math.log2(maximumBytes + 1));
}
export class LiquidityWireCapacityError extends Error {
  constructor(readonly requiredBytes: number, readonly sessionId: string | null = null) { super('Liquidity transport capacity unavailable'); }
}
export function liquidityWireSessionId(payload: unknown): string | null {
  if (!payload || typeof payload !== 'object' || types.isProxy(payload)) return null;
  try {
    const descriptor = Object.getOwnPropertyDescriptor(payload, 'sessionId');
    return descriptor && 'value' in descriptor && typeof descriptor.value === 'string'
      && descriptor.value.length > 0 && descriptor.value.length <= 128 ? descriptor.value : null;
  } catch { return null; }
}
/** Exact JSON UTF-8 and UTF-16 text bytes for supported DTOs, including duplicate
 * aliases per occurrence. Only the active ancestor path is retained. Work options
 * may tighten the fixed limit for callers/tests, never increase it. */
export function measureLiquidityWireBytes(payload: unknown, { maxOperations = LIQUIDITY_WIRE_MEASUREMENT_LIMITS.maxOperations }: { maxOperations?: number } = {}): LiquidityWireMeasurement {
  let operations = 0, utf8Bytes = 0, utf16Units = 0;
  const active = new Set<object>();
  const work = (amount = 1) => {
    operations += amount;
    if (!Number.isSafeInteger(operations) || operations > maxOperations) throw new MeasurementError('work-limit');
  };
  const add = (utf8: number, units = utf8) => {
    utf8Bytes += utf8; utf16Units += units;
    if (!Number.isSafeInteger(utf8Bytes) || !Number.isSafeInteger(utf16Units)
        || utf8Bytes > LIQUIDITY_WIRE_MEASUREMENT_LIMITS.maxUtf8Bytes
        || 2 * utf16Units > LIQUIDITY_WIRE_MEASUREMENT_LIMITS.maxUtf16Bytes) throw new MeasurementError('size-limit');
  };
  const string = (value: string) => {
    add(2);
    for (let index = 0; index < value.length; index++) {
      work(); const code = value.charCodeAt(index);
      if (code === 34 || code === 92 || code === 8 || code === 9 || code === 10 || code === 12 || code === 13) add(2);
      else if (code < 32) add(6);
      else if (code >= 0xd800 && code <= 0xdbff) {
        const next = value.charCodeAt(index + 1);
        if (next >= 0xdc00 && next <= 0xdfff) { add(4, 2); index++; }
        else add(6);
      } else if (code >= 0xdc00 && code <= 0xdfff) add(6);
      else add(code < 0x80 ? 1 : code < 0x800 ? 2 : 3, 1);
    }
  };
  const visit = (value: unknown, depth: number, arrayItem = false): void => {
    work(); if (depth > LIQUIDITY_WIRE_MEASUREMENT_LIMITS.maxDepth) throw new MeasurementError('depth-limit');
    if (value === null) { add(4); return; }
    if (typeof value === 'string') { string(value); return; }
    if (typeof value === 'boolean') { add(value ? 4 : 5); return; }
    if (typeof value === 'number') {
      if (!Number.isFinite(value)) throw new MeasurementError('invalid-json'); add(String(Object.is(value, -0) ? 0 : value).length); return;
    }
    if (value === undefined || typeof value === 'function' || typeof value === 'symbol') {
      if (arrayItem) { add(4); return; } throw new MeasurementError('invalid-json');
    }
    if (typeof value !== 'object' || types.isProxy(value)) throw new MeasurementError('invalid-json');
    const array = Array.isArray(value), prototype: unknown = Object.getPrototypeOf(value);
    if (array ? prototype !== Array.prototype : prototype !== Object.prototype && prototype !== null) throw new MeasurementError('invalid-json');
    const hook = Object.getOwnPropertyDescriptor(value, 'toJSON');
    if (hook && (!('value' in hook) || typeof hook.value === 'function')) throw new MeasurementError('invalid-json');
    if (active.has(value)) throw new MeasurementError('cycle'); active.add(value);
    try {
      add(2);
      if (array) {
        const descriptor = Object.getOwnPropertyDescriptor(value, 'length'), length: unknown = descriptor?.value;
        if (typeof length !== 'number' || !Number.isSafeInteger(length) || length < 0 || length > maxOperations) throw new MeasurementError('work-limit');
        for (let index = 0; index < length; index++) {
          work(); const item = Object.getOwnPropertyDescriptor(value, String(index));
          if (!item || !('value' in item)) throw new MeasurementError('invalid-json');
          if (index) add(1); visit(item.value as unknown, depth + 1, true);
        }
      } else {
        let emitted = 0;
        for (const key in value) {
          work(); const item = Object.getOwnPropertyDescriptor(value, key);
          if (!item) continue;
          if (!('value' in item)) throw new MeasurementError('invalid-json');
          const child: unknown = item.value;
          if (child === undefined || typeof child === 'function' || typeof child === 'symbol') continue;
          if (emitted++) add(1); string(key); add(1); visit(child, depth + 1);
        }
      }
    } finally { active.delete(value); }
  };
  try {
    if (!Number.isSafeInteger(maxOperations) || maxOperations < 1 || maxOperations > LIQUIDITY_WIRE_MEASUREMENT_LIMITS.maxOperations
        || !payload || typeof payload !== 'object' || Array.isArray(payload) || types.isProxy(payload)
        || Object.getOwnPropertyDescriptor(Object.prototype, 'toJSON') || Object.getOwnPropertyDescriptor(Array.prototype, 'toJSON')) throw new MeasurementError('invalid-json');
    visit(payload, 0);
    const utf16Bytes = 2 * utf16Units;
    return { complete: true, reason: null, utf8Bytes, utf16Bytes, requiredBytes: Math.max(utf8Bytes, utf16Bytes), operations };
  } catch (error) {
    return { complete: false, reason: error instanceof MeasurementError ? error.reason : 'inspection-failed',
      utf8Bytes: null, utf16Bytes: null, requiredBytes: null, operations };
  }
}

/** Fresh proof for one enqueue/write attempt; callers retain no certification. */
export function requireLiquidityWireCapacity(payload: unknown, maximumBytes: number): { utf8Bytes: number; utf16Bytes: number } {
  const measured = measureLiquidityWireBytes(payload);
  if (!measured.complete || measured.requiredBytes === null || measured.requiredBytes > maximumBytes
      || measured.utf8Bytes === null || measured.utf16Bytes === null) {
    throw new LiquidityWireCapacityError(measured.requiredBytes ?? liquidityWireGrowthHint(maximumBytes), liquidityWireSessionId(payload));
  }
  return { utf8Bytes: measured.utf8Bytes, utf16Bytes: measured.utf16Bytes };
}
