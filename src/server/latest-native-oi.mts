/** These bounds tighten the input domain; no browser cache or ingress cap changes. */
export const LATEST_NATIVE_OI_LIMITS = Object.freeze({
  maxInputRows: 20_000,
  maxExistingRows: 128,
  maxInstruments: 128,
  maxInstrumentIdLength: 256,
  maxWorkingBytes: 4 * 1024 * 1024,
});
export interface LatestNativeOiCounts { inputRows: number; existingRows: number; }
export interface LatestNativeOiProjectionOptions<T> {
  counts: LatestNativeOiCounts;
  reservedWorkingBytes: number;
  existing?: readonly T[];
}
export type LatestNativeOiProjection<T> =
  | { complete: true; reason: null; workingBytes: number; counts: LatestNativeOiCounts; rows: T[] }
  | { complete: false; reason: string; workingBytes: number; counts: null; rows: null };

/** Numeric only: reserve under both existing logical and physical ingress guards. */
export function latestNativeOiWorkingBytes({ inputRows, existingRows }: LatestNativeOiCounts): number {
  if (!Number.isSafeInteger(inputRows) || inputRows < 0 || inputRows > LATEST_NATIVE_OI_LIMITS.maxInputRows
      || !Number.isSafeInteger(existingRows) || existingRows < 0 || existingRows > LATEST_NATIVE_OI_LIMITS.maxExistingRows)
    throw new RangeError('latest-native-oi-count-limit');
  const count = inputRows + existingRows;
  // Borrowed payload graphs are excluded: their source owners MUST stay charged.
  // Includes bounded descriptors, the instrument index, entries and result slots.
  const bytes = 65_536 + count * 128 + Math.min(count, LATEST_NATIVE_OI_LIMITS.maxInstruments) * 2_048;
  if (!Number.isSafeInteger(bytes) || bytes > LATEST_NATIVE_OI_LIMITS.maxWorkingBytes)
    throw new RangeError('latest-native-oi-workspace-limit');
  return bytes;
}

const clockFields = ['observationTimestamp', 'sourceTimestamp', 'receivedAt'] as const;
const barFields = ['start', 'end', 'interval', 'open', 'high', 'low', 'close',
  'quoteOpen', 'quoteHigh', 'quoteLow', 'quoteClose', 'sampleCount', 'samples'] as const;
function plainRecord(row: unknown): asserts row is Record<string, unknown> {
  if (!row || typeof row !== 'object' || Array.isArray(row)) throw new TypeError('latest-native-oi-row-required');
  const prototype: unknown = Object.getPrototypeOf(row);
  if (prototype !== Object.prototype && prototype !== null) throw new TypeError('latest-native-oi-plain-row-required');
}
function scalar(row: Record<string, unknown>, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(row, key);
  if (!descriptor) return undefined;
  if (!('value' in descriptor)) throw new TypeError('latest-native-oi-effectful-field');
  return descriptor.value;
}
function identity(row: Record<string, unknown>): string {
  const id = scalar(row, 'instrumentId');
  if (typeof id !== 'string' || id.length === 0 || id.length > LATEST_NATIVE_OI_LIMITS.maxInstrumentIdLength)
    throw new TypeError('latest-native-oi-identity-required');
  return id;
}
function nativeObservation(row: Record<string, unknown>): void {
  // Durable OHLC, partial bars and aggregated rows require the full-history view.
  // Never reinterpret their closing base value as a native point observation.
  for (const key of barFields) if (scalar(row, key) != null)
    throw new TypeError('latest-native-oi-persisted-or-aggregate-row');
  const base = scalar(row, 'base');
  if (typeof base !== 'number' || !Number.isFinite(base)) throw new TypeError('latest-native-oi-base-required');
}
function validClock(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 && value <= 8.64e15;
}
function observationClock(row: Record<string, unknown>): number {
  let selected: number | null = null;
  for (const field of clockFields) {
    const value = scalar(row, field);
    if (value == null) continue;
    if (!validClock(value)) throw new TypeError('latest-native-oi-invalid-clock');
    if (selected === null) selected = value;
  }
  if (selected === null) throw new TypeError('latest-native-oi-clock-required');
  return selected;
}
function receiptClock(row: Record<string, unknown>): number {
  const value = scalar(row, 'receivedAt');
  if (value == null) return 0;
  if (!validClock(value)) throw new TypeError('latest-native-oi-invalid-clock');
  return value;
}
function rowArray<T>(rows: readonly T[], expected: number): void {
  if (!Array.isArray(rows) || Object.getPrototypeOf(rows) !== Array.prototype
      || Object.getOwnPropertyDescriptor(rows, 'length')?.value !== expected)
    throw new TypeError('latest-native-oi-count-mismatch');
}
function rowSlot<T>(rows: readonly T[], index: number): T {
  const descriptor = Object.getOwnPropertyDescriptor(rows, String(index));
  if (!descriptor || !('value' in descriptor)) throw new TypeError('latest-native-oi-missing-or-effectful-slot');
  return descriptor.value as T;
}

/**
 * Only synchronous reducer-owned JSON DTOs are supported. Ingest the complete
 * incoming batch into history BEFORE deriving this live-only fallback. This is
 * neither a history replacement nor evidence of complete historical coverage.
 *
 * Reserve numeric counts before any input reflection. Existing latest rows are
 * upserted first, then incoming observations; omitted instruments survive, while
 * exact observation/receipt ties use the latter complete row (corrections).
 * Returned rows and nested provenance retain their actual source identities.
 * Keep source graph ownership/admission charged; this function makes no payload
 * copies, history edits, clock repairs or persistent caches. On any failure use
 * the original full view under its existing guards, never a partial result.
 */
export function projectLatestNativeOi<T>(input: readonly T[],
  options: LatestNativeOiProjectionOptions<T>): LatestNativeOiProjection<T> {
  let workingBytes = 0;
  const failure = (reason: string): LatestNativeOiProjection<T> => ({ complete: false, reason, workingBytes, counts: null, rows: null });
  try {
    workingBytes = latestNativeOiWorkingBytes(options.counts);
  } catch { return failure('latest-native-oi-count-limit'); }
  if (!Number.isSafeInteger(options.reservedWorkingBytes) || options.reservedWorkingBytes < workingBytes)
    return failure('latest-native-oi-pregrant-required');
  try {
    const existing = options.existing;
    rowArray(input, options.counts.inputRows);
    if (existing) rowArray(existing, options.counts.existingRows);
    else if (options.counts.existingRows !== 0) return failure('latest-native-oi-count-mismatch');
    const latest = new Map<string, { row: T; time: number; received: number }>();
    const upsert = (rows: readonly T[], count: number) => {
      for (let index = 0; index < count; index += 1) {
        const row = rowSlot(rows, index);
        plainRecord(row); nativeObservation(row);
        const id = identity(row); const time = observationClock(row); const received = receiptClock(row);
        const prior = latest.get(id);
        if (!prior) {
          if (latest.size >= LATEST_NATIVE_OI_LIMITS.maxInstruments) throw new RangeError('latest-native-oi-instrument-limit');
          latest.set(id, { row, time, received });
        } else if (time > prior.time || time === prior.time && received >= prior.received) {
          prior.row = row; prior.time = time; prior.received = received;
        }
      }
    };
    if (existing) upsert(existing, options.counts.existingRows);
    upsert(input, options.counts.inputRows);
    const rows = new Array<T>(latest.size);
    let outputIndex = 0;
    for (const entry of latest.values()) rows[outputIndex++] = entry.row;
    return { complete: true, reason: null, workingBytes,
      counts: { inputRows: options.counts.inputRows, existingRows: options.counts.existingRows }, rows };
  } catch (error) { return failure(error instanceof Error ? error.message : 'latest-native-oi-inspection-failed'); }
}
