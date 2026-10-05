import { types } from 'node:util';
import type { RuntimeOiSample } from '../domain/runtime-state.mts';
import { latestNativeOiWorkingBytes, projectLatestNativeOi,
} from './latest-native-oi.mts';

/** Sequential row inspection, result metadata and wrapper controls only. */
export const NATIVE_OI_BOOTSTRAP_CONTROL_BYTES = 16 * 1024;
export const NATIVE_OI_BOOTSTRAP_PROJECTION = Object.freeze({
  format: 'hlm-native-oi-bootstrap-v1', scope: 'current-native-points',
  historyComplete: false, rowsPerInstrument: 1,
  selectionBasis: 'observationTimestamp/sourceTimestamp/receivedAt',
  omittedRowsAreRemovals: false, sourceValuesUnchanged: true,
  recovery: 'full-state-and-history-loader', olderCorrections: 'require-full-state-or-history-loader',
} as const);
export interface NativeOiBootstrapOptions { inputRows: number; reservedWorkingBytes: number; }
export type NativeOiBootstrapResult =
  | { complete: true; reason: null; workingBytes: number; rows: RuntimeOiSample[];
      projection: typeof NATIVE_OI_BOOTSTRAP_PROJECTION }
  | { complete: false; reason: string; workingBytes: number; rows: null; projection: null };

/** Numeric only: obtain both logical and physical grants before inspecting input. */
export function nativeOiBootstrapWorkingBytes(inputRows: number): number {
  return latestNativeOiWorkingBytes({ inputRows, existingRows: 0 }) + NATIVE_OI_BOOTSTRAP_CONTROL_BYTES;
}

/**
 * An opt-in current-point view of the reducer-owned live OI array. Full history
 * and its source owner remain unchanged and charged. Rows/provenance are borrowed
 * exactly; this makes no row copies, repairs, caches or historical-coverage claim.
 * Keep the source grant through serialization and retain the result/body grants
 * through transport drain. A failure authorizes no partial result or unguarded
 * whole-history fallback. The existing full API keeps its own contract.
 */
export function projectNativeOiBootstrap(input: readonly RuntimeOiSample[],
  options: NativeOiBootstrapOptions): NativeOiBootstrapResult {
  let workingBytes = 0;
  const failure = (reason: string): NativeOiBootstrapResult => ({
    complete: false, reason, workingBytes, rows: null, projection: null,
  });
  try { workingBytes = nativeOiBootstrapWorkingBytes(options.inputRows); }
  catch { return failure('native-oi-bootstrap-count-limit'); }
  if (!Number.isSafeInteger(options.reservedWorkingBytes) || options.reservedWorkingBytes < workingBytes)
    return failure('native-oi-bootstrap-pregrant-required');
  try {
    if (!Array.isArray(input) || types.isProxy(input) || Object.getPrototypeOf(input) !== Array.prototype
        || Object.getOwnPropertyDescriptor(input, 'length')?.value !== options.inputRows)
      return failure('native-oi-bootstrap-array-required');
    for (let index = 0; index < options.inputRows; index += 1) {
      const slot = Object.getOwnPropertyDescriptor(input, String(index));
      if (!slot || !('value' in slot)) return failure('native-oi-bootstrap-effectful-or-missing-slot');
      const row: unknown = slot.value;
      if (!row || typeof row !== 'object' || types.isProxy(row) || Array.isArray(row))
        return failure('native-oi-bootstrap-plain-row-required');
      const prototype: unknown = Object.getPrototypeOf(row);
      if (prototype !== Object.prototype && prototype !== null) return failure('native-oi-bootstrap-plain-row-required');
      const keys = Reflect.ownKeys(row);
      if (keys.length > 64) return failure('native-oi-bootstrap-row-field-limit');
      for (const key of keys) {
        if (typeof key !== 'string' || key.length > 256) return failure('native-oi-bootstrap-row-field-limit');
        const descriptor = Object.getOwnPropertyDescriptor(row, key);
        if (!descriptor || !('value' in descriptor)) return failure('native-oi-bootstrap-effectful-field');
      }
    }
    const latest = projectLatestNativeOi(input, {
      counts: { inputRows: options.inputRows, existingRows: 0 },
      reservedWorkingBytes: options.reservedWorkingBytes - NATIVE_OI_BOOTSTRAP_CONTROL_BYTES,
    });
    if (!latest.complete) return failure(latest.reason);
    return { complete: true, reason: null, workingBytes, rows: latest.rows,
      projection: NATIVE_OI_BOOTSTRAP_PROJECTION };
  } catch (error) { return failure(error instanceof Error ? error.message : 'native-oi-bootstrap-inspection-failed'); }
}
