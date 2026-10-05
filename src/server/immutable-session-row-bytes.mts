import { types as nodeTypes } from 'node:util';
import { logicalRetainedBytes } from '../core/retained-bytes.mts';
/** Exact UTF-8 JSON sizes for explicitly detached, internal plain-data rows.
 * sealDetachedRows is an ownership operation: never call it on caller-owned rows.
 * sum/sync never freeze external rows. Unsupported input fails before mutation.
 * Native plain objects/arrays are required; proxies are rejected without invoking traps. */
export const IMMUTABLE_SESSION_ROW_BYTES_LIMITS = Object.freeze({ maxRows: 20_000, maxOperations: 2_000_000, maxDepth: 128 });
export type ImmutableSessionRowBytesReason = 'row-limit' | 'work-limit' | 'depth-limit' | 'invalid-json' | 'cycle' | 'inspection-failed' | 'size-overflow' | 'cache-limit';
export interface ImmutableSessionRowBytesResult {
  complete: boolean; reason: ImmutableSessionRowBytesReason | null; bytes: number | null;
  rows: number; cachedRows: number; freshRows: number; operations: number; cacheEntries: number;
}
export interface ImmutableSessionLogicalOwnership { complete: boolean; reason: ImmutableSessionRowBytesReason | null;
  sessionLogicalBytesUpper: number; cacheLogicalBytesUpper: number; mutableRows: object[]; mutableCacheOwners: object[]; }
export interface ImmutableSessionFreshMeasurement {
  serialized: ImmutableSessionRowBytesResult;
  ownership: ImmutableSessionLogicalOwnership | null;
  ownershipOperations: number;
}
class RowBytesError extends Error { constructor(readonly reason: ImmutableSessionRowBytesReason) { super(reason); } }
interface Inspection { operations: number; active: Set<object>; freeze: Set<object> | null; }
function work(context: Inspection, count = 1): void {
  context.operations += count;
  if (!Number.isSafeInteger(context.operations) || context.operations > IMMUTABLE_SESSION_ROW_BYTES_LIMITS.maxOperations) throw new RowBytesError('work-limit');
}
function add(left: number, right: number): number {
  const result = left + right; if (!Number.isSafeInteger(result) || result < 0) throw new RowBytesError('size-overflow'); return result;
}
/** JSON escaping and UTF-8 encoding, including paired/lone surrogates. */
function stringBytes(value: string, context: Inspection): number {
  work(context, value.length); let bytes = 2;
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    if (code === 34 || code === 92 || code === 8 || code === 9 || code === 10 || code === 12 || code === 13) bytes += 2;
    else if (code < 32) bytes += 6;
    else if (code >= 0xd800 && code <= 0xdbff && index + 1 < value.length && value.charCodeAt(index + 1) >= 0xdc00 && value.charCodeAt(index + 1) <= 0xdfff) { bytes += 4; index++; }
    else if (code >= 0xd800 && code <= 0xdfff) bytes += 6;
    else bytes += code < 0x80 ? 1 : code < 0x800 ? 2 : 3;
  }
  return bytes;
}
function jsonBytes(value: unknown, context: Inspection, depth: number): number {
  work(context); if (depth > IMMUTABLE_SESSION_ROW_BYTES_LIMITS.maxDepth) throw new RowBytesError('depth-limit');
  // Undefined array entries serialize as null; object properties are omitted below.
  if (value === null || value === undefined) return 4;
  if (typeof value === 'boolean') return value ? 4 : 5;
  if (typeof value === 'string') return stringBytes(value, context);
  if (typeof value === 'number') { if (!Number.isFinite(value)) throw new RowBytesError('invalid-json'); return String(Object.is(value, -0) ? 0 : value).length; }
  if (typeof value !== 'object' || nodeTypes.isProxy(value)) throw new RowBytesError('invalid-json');
  const array = Array.isArray(value); const prototype: unknown = Object.getPrototypeOf(value);
  if (array ? prototype !== Array.prototype : prototype !== Object.prototype && prototype !== null) throw new RowBytesError('invalid-json');
  if (context.active.has(value)) throw new RowBytesError('cycle');
  context.active.add(value); context.freeze?.add(value);
  try {
    const keys = Reflect.ownKeys(value); work(context, keys.length);
    let bytes = 2;
    if (array) {
      const lengthDescriptor = Object.getOwnPropertyDescriptor(value, 'length');
      const length: unknown = lengthDescriptor?.value;
      if (typeof length !== 'number' || !Number.isSafeInteger(length) || length < 0 || length > IMMUTABLE_SESSION_ROW_BYTES_LIMITS.maxOperations || keys.length !== length + 1) throw new RowBytesError('invalid-json');
      for (let index = 0; index < length; index++) {
        const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
        if (!descriptor || !('value' in descriptor) || !descriptor.enumerable) throw new RowBytesError('invalid-json');
        bytes = add(bytes, (index ? 1 : 0) + jsonBytes(descriptor.value as unknown, context, depth + 1));
      }
    } else {
      let emitted = 0;
      for (let index = 0; index < keys.length; index++) {
        const key = keys[index]; if (typeof key !== 'string') throw new RowBytesError('invalid-json');
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        if (!descriptor || !('value' in descriptor) || !descriptor.enumerable) throw new RowBytesError('invalid-json');
        if (descriptor.value === undefined) continue;
        bytes = add(bytes, (emitted++ ? 1 : 0) + stringBytes(key, context) + 1 + jsonBytes(descriptor.value as unknown, context, depth + 1));
      }
    }
    return bytes;
  } finally { context.active.delete(value); }
}
function members(rows: unknown, context: Inspection): object[] {
  if (nodeTypes.isProxy(rows) || !Array.isArray(rows) || Object.getPrototypeOf(rows) !== Array.prototype) throw new RowBytesError('invalid-json');
  const descriptor = Object.getOwnPropertyDescriptor(rows, 'length'); const length: unknown = descriptor?.value;
  if (typeof length !== 'number' || !Number.isSafeInteger(length) || length < 0 || length > IMMUTABLE_SESSION_ROW_BYTES_LIMITS.maxRows) throw new RowBytesError('row-limit');
  // JSON.stringify must not execute an inherited hook, even on otherwise plain data.
  if (Object.getOwnPropertyDescriptor(Object.prototype, 'toJSON') || Object.getOwnPropertyDescriptor(Array.prototype, 'toJSON')) throw new RowBytesError('invalid-json');
  work(context, length); const result: object[] = [];
  for (let index = 0; index < length; index++) {
    const item = Object.getOwnPropertyDescriptor(rows, String(index));
    if (!item || !('value' in item) || item.value === null || typeof item.value !== 'object' || Array.isArray(item.value)) throw new RowBytesError('invalid-json');
    result.push(item.value as object);
  }
  return result;
}
export class ImmutableSessionRowBytesCache {
  #sizes = new Map<object, number>();
  #proved = new WeakMap<object, number>();
  #logicalProof = new WeakMap<object, number>();
  #membershipRevision = 0;
  get membershipRevision(): number { return this.#membershipRevision; }
  get count(): number { return this.#sizes.size; }
  /** Actual strong cache graph; callers may measure it but must not mutate it. */
  retainedRoot(): ReadonlyMap<object, number> { return this.#sizes; }
  #result(context: Inspection, reason: ImmutableSessionRowBytesReason | null, bytes: number | null, rows = 0, cachedRows = 0, freshRows = 0): ImmutableSessionRowBytesResult {
    return { complete: reason === null, reason, bytes, rows, cachedRows, freshRows, operations: context.operations, cacheEntries: this.count };
  }
  /** Complete validation/measurement precedes all freezing. No row fields are added. */
  sealDetachedRows(rows: unknown): ImmutableSessionRowBytesResult {
    const context: Inspection = { operations: 0, active: new Set(), freeze: new Set() };
    try {
      const input = members(rows, context); const measured = new Map<object, number>(); let bytes = 0;
      for (const row of input) { const size = measured.get(row) ?? jsonBytes(row, context, 0); measured.set(row, size); bytes = add(bytes, size); }
      let newOwners = 0; for (const row of measured.keys()) if (!this.#sizes.has(row)) newOwners++;
      if (this.count + newOwners > IMMUTABLE_SESSION_ROW_BYTES_LIMITS.maxRows) throw new RowBytesError('cache-limit');
      const logical = new Map<object, number>();
      for (const row of measured.keys()) { const bytes = logicalRetainedBytes(row); if (!Number.isSafeInteger(bytes) || bytes < 0) throw new RowBytesError('size-overflow'); logical.set(row, bytes); }
      for (const node of context.freeze!) Object.freeze(node);
      for (const [row, size] of measured) { this.#proved.set(row, size); this.#logicalProof.set(row, logical.get(row)!); if (!this.#sizes.has(row)) this.#membershipRevision++; this.#sizes.set(row, size); }
      return this.#result(context, null, bytes, input.length, input.length, 0);
    } catch (error) { return this.#result(context, error instanceof RowBytesError ? error.reason : 'inspection-failed', null); }
  }
  /** Fresh slot/cache-owner scan; immutable descendants reuse authoritative
   * per-owner logical measurements. Summing owners is an upper bound under aliases.
   * Cache keys absent from membership still own their graphs and are charged.
   * Unknown owners remain in the mutable projection, never in a numeric guess. */
  logicalOwnership(rows: unknown): ImmutableSessionLogicalOwnership {
    const context: Inspection = { operations: 0, active: new Set(), freeze: null };
    try {
      const input = members(rows, context); const seen = new Set<object>();
      const mutableRows: object[] = [], mutableCacheOwners: object[] = [];
      let sessionLogicalBytesUpper = 0, cacheLogicalBytesUpper = 0, provedOwners = 0;
      const proof = (row: object): number | null => {
        const bytes = this.#logicalProof.get(row);
        if (bytes === undefined) return null;
        if (!Object.isFrozen(row) || !Number.isSafeInteger(bytes) || bytes < 0) throw new RowBytesError('invalid-json');
        return bytes;
      };
      for (const row of input) {
        const bytes = proof(row);
        if (bytes === null) mutableRows.push(row);
        else if (!seen.has(row)) { seen.add(row); provedOwners++; sessionLogicalBytesUpper = add(sessionLogicalBytesUpper, bytes); }
      }
      // Native iteration cannot be replaced by a custom iterator on the exposed Map.
      for (const [row, serialized] of Map.prototype.entries.call(this.#sizes) as IterableIterator<[object, number]>) {
        work(context); if (!Number.isSafeInteger(serialized) || serialized < 0) throw new RowBytesError('invalid-json');
        cacheLogicalBytesUpper = add(cacheLogicalBytesUpper, 8); // Actual serialized-size Map value.
        const bytes = proof(row);
        if (bytes === null) mutableCacheOwners.push(row);
        else if (!seen.has(row)) { seen.add(row); provedOwners++; cacheLogicalBytesUpper = add(cacheLogicalBytesUpper, bytes); }
      }
      // Two numeric weak proof values per live immutable identity. Their keys
      // retain no absent owner graph; all strong index payloads are covered above.
      cacheLogicalBytesUpper = add(cacheLogicalBytesUpper, provedOwners * 16);
      return { complete: true, reason: null, sessionLogicalBytesUpper, cacheLogicalBytesUpper, mutableRows, mutableCacheOwners };
    } catch (error) {
      return { complete: false, reason: error instanceof RowBytesError ? error.reason : 'inspection-failed',
        sessionLogicalBytesUpper: 0, cacheLogicalBytesUpper: 0, mutableRows: [], mutableCacheOwners: [] };
    }
  }
  /** One fresh membership validation for exact serialization and logical ownership.
   * Default read-only ownership includes absent strong cache keys. Reconciliation
   * follows sum's successful-serialization semantics; failed serialization never
   * mutates the index. Ownership has its own work allowance and failure outcome. */
  measureFresh(rows: unknown, { reconcile = false }: { reconcile?: boolean } = {}): ImmutableSessionFreshMeasurement {
    const context: Inspection = { operations: 0, active: new Set(), freeze: null };
    const ownershipContext: Inspection = { operations: 0, active: context.active, freeze: null };
    try {
      // Validate all slots before inspecting descendants, then share this local
      // array and identity set. Neither becomes a retained certification root.
      const input = members(rows, context); const current = new Set<object>();
      work(ownershipContext, input.length);
      const mutableRows: object[] = [], mutableCacheOwners: object[] = [];
      let bytes = 0, cachedRows = 0, freshRows = 0;
      let sessionLogicalBytesUpper = 0, cacheLogicalBytesUpper = 0, provedOwners = 0;
      let ownershipReason: ImmutableSessionRowBytesReason | null = null;
      const proof = (row: object): number | null => {
        const bytes = this.#logicalProof.get(row);
        if (bytes === undefined) return null;
        if (!Object.isFrozen(row) || !Number.isSafeInteger(bytes) || bytes < 0) throw new RowBytesError('invalid-json');
        return bytes;
      };
      for (const row of input) {
        const cached = this.#proved.get(row); const size = cached ?? jsonBytes(row, context, 0);
        bytes = add(bytes, size); if (cached === undefined) freshRows++; else cachedRows++;
        const firstOccurrence = !current.has(row); current.add(row);
        if (ownershipReason === null) {
          try {
            const logical = proof(row);
            if (logical === null) mutableRows.push(row);
            else if (firstOccurrence) { provedOwners++; sessionLogicalBytesUpper = add(sessionLogicalBytesUpper, logical); }
          } catch (error) { ownershipReason = error instanceof RowBytesError ? error.reason : 'inspection-failed'; }
        }
      }
      if (reconcile) {
        for (const row of this.#sizes.keys()) if (!current.has(row)) { this.#sizes.delete(row); this.#membershipRevision++; }
        // Weak proofs are authoritative; no temporary serialized proof Map is needed.
        for (const row of current) { const size = this.#proved.get(row); if (size === undefined) continue;
          if (!this.#sizes.has(row)) this.#membershipRevision++; this.#sizes.set(row, size); }
      }
      if (ownershipReason === null) {
        try {
          // Preserve the actual strong index and native iteration, including keys
          // absent from session membership when reconciliation was not requested.
          for (const [row, serialized] of Map.prototype.entries.call(this.#sizes) as IterableIterator<[object, number]>) {
            work(ownershipContext); if (!Number.isSafeInteger(serialized) || serialized < 0) throw new RowBytesError('invalid-json');
            cacheLogicalBytesUpper = add(cacheLogicalBytesUpper, 8);
            const logical = proof(row);
            if (logical === null) mutableCacheOwners.push(row);
            else if (!current.has(row)) { provedOwners++; cacheLogicalBytesUpper = add(cacheLogicalBytesUpper, logical); }
          }
          cacheLogicalBytesUpper = add(cacheLogicalBytesUpper, provedOwners * 16);
        } catch (error) { ownershipReason = error instanceof RowBytesError ? error.reason : 'inspection-failed'; }
      }
      const ownership: ImmutableSessionLogicalOwnership = ownershipReason === null
        ? { complete: true, reason: null, sessionLogicalBytesUpper, cacheLogicalBytesUpper, mutableRows, mutableCacheOwners }
        : { complete: false, reason: ownershipReason, sessionLogicalBytesUpper: 0, cacheLogicalBytesUpper: 0, mutableRows: [], mutableCacheOwners: [] };
      return { serialized: this.#result(context, null, bytes, input.length, cachedRows, freshRows), ownership, ownershipOperations: ownershipContext.operations };
    } catch (error) {
      return { serialized: this.#result(context, error instanceof RowBytesError ? error.reason : 'inspection-failed', null),
        ownership: null, ownershipOperations: ownershipContext.operations };
    }
  }
  /** Reconcile strong owners after successful flush/eviction. Failed retries keep membership. */
  sync(rows: unknown): ImmutableSessionRowBytesResult {
    const context: Inspection = { operations: 0, active: new Set(), freeze: null };
    try { const input = members(rows, context); const current = new Set(input);
      for (const row of this.#sizes.keys()) if (!current.has(row)) { this.#sizes.delete(row); this.#membershipRevision++; }
      return this.#result(context, null, null, input.length);
    } catch (error) { return this.#result(context, error instanceof RowBytesError ? error.reason : 'inspection-failed', null); }
  }
  /** Scan every current occurrence. Equal or duplicate references are serialized per occurrence. */
  sum(rows: unknown): ImmutableSessionRowBytesResult {
    const context: Inspection = { operations: 0, active: new Set(), freeze: null };
    try { const input = members(rows, context); const current = new Set(input); const proved = new Map<object, number>(); let bytes = 0, cachedRows = 0, freshRows = 0;
      for (const row of input) { const cached = this.#proved.get(row); const size = cached ?? jsonBytes(row, context, 0);
        bytes = add(bytes, size); if (cached === undefined) freshRows++; else { cachedRows++; proved.set(row, cached); } }
      for (const row of this.#sizes.keys()) if (!current.has(row)) { this.#sizes.delete(row); this.#membershipRevision++; }
      for (const [row, size] of proved) { if (!this.#sizes.has(row)) this.#membershipRevision++; this.#sizes.set(row, size); }
      return this.#result(context, null, bytes, input.length, cachedRows, freshRows);
    } catch (error) { return this.#result(context, error instanceof RowBytesError ? error.reason : 'inspection-failed', null); }
  }
}
