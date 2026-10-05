/** Lossless canonical-book references for an explicitly negotiated native wire.
 * Caller owns the complete DTO payload and grants bounded helper workspace before
 * reflection. This module neither serializes/clones book fields nor grants memory.
 */
export const NATIVE_BOOK_WIRE_ALIASES_VERSION = 'hlm-native-book-wire-aliases-v1';
/** Includes bounded active validation keys, owner memo and result map controls.
 * Book payloads, JSON parse/stringify and transport buffers need their own grants.
 */
// Worst admitted path: 8192 active key slots*64 plus bounded owner/target,
// entry-list, frame and descriptor controls <656KiB. No full-graph memo exists.
// Up to256 result properties and128 reference strings have a separate retained
// control floor; book payloads are already caller-owned, never copied here.
export const NATIVE_BOOK_WIRE_ALIASES_WORKING_BYTES = 1024 * 1024;
export const NATIVE_BOOK_WIRE_ALIASES_RESULT_CONTROL_BYTES = 256 * 1024;
export const NATIVE_BOOK_WIRE_ALIASES_LIMITS = Object.freeze({
  maxBooksPerMap: 128, maxKeyCharacters: 256, maxLevelsPerSide: 400,
  maxDepth: 32, maxVisits: 1_000_000, maxStringCharacters: 4 * 1024 * 1024,
  maxActiveKeys: 8_192,
});
export interface NativeBookWireAliasBook extends Record<string, unknown> {
  bids: [number, number][];
  asks: [number, number][];
}
export interface NativeBookWireAliasMaps<Book extends object = NativeBookWireAliasBook> {
  books: Record<string, Book>;
  booksByKey: Record<string, Book>;
}
export interface NativeBookWireAliasPacket<Book extends object = NativeBookWireAliasBook>
  extends NativeBookWireAliasMaps<Book> {
  nativeBookAliases: { version: typeof NATIVE_BOOK_WIRE_ALIASES_VERSION; references: Record<string, string> };
}
class Invalid extends Error {}
const own = Object.prototype.hasOwnProperty;
const unsafeKeys = new Set(['__proto__', 'constructor', 'prototype']);
const plain = (value: unknown): value is Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype: unknown = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
};
const keySafe = (key: string) => key.length > 0 && key.length <= NATIVE_BOOK_WIRE_ALIASES_LIMITS.maxKeyCharacters
  && !unsafeKeys.has(key);
function data(value: object, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  if (!descriptor || !descriptor.enumerable || !('value' in descriptor)) throw new Invalid('non-data-property');
  return descriptor.value;
}
/** Enumerable preflight stops wide native JSON objects before making a key list.
 * Foreign hidden/symbol properties are unsupported. Caller supplies bounded native
 * DTOs (or bounded JSON.parse output), never arbitrary proxy/host objects.
 */
function keys(value: object, maximum: number, array = false): string[] {
  let enumerable = 0;
  for (const key in value) if (own.call(value, key) && ++enumerable > maximum) throw new Invalid('key-capacity');
  const reflected = Reflect.ownKeys(value);
  if (reflected.length > maximum + Number(array)) throw new Invalid('key-capacity');
  let lengthIndex = -1;
  for (let index = 0; index < reflected.length; index++) {
    const key = reflected[index];
    if (typeof key !== 'string') throw new Invalid('symbol-property');
    if (array && key === 'length') { lengthIndex = index; continue; }
    data(value, key);
  }
  // Keep exactly one reflected list per active path node. A filtered copy would
  // double the simultaneous keys at the 8192-key boundary.
  if (lengthIndex >= 0) reflected.splice(lengthIndex, 1);
  return reflected as string[];
}
function entries(value: unknown): [string, object][] {
  if (!plain(value)) throw new Invalid('invalid-book-map');
  return keys(value, NATIVE_BOOK_WIRE_ALIASES_LIMITS.maxBooksPerMap).map(key => {
    if (!keySafe(key)) throw new Invalid('invalid-map-key');
    const book: unknown = data(value, key);
    if (!plain(book)) throw new Invalid('invalid-book');
    return [key, book];
  });
}
interface Validation {
  visits: number; characters: number; activeKeys: number; active: Set<object>;
}
function graph(value: unknown, state: Validation, depth = 0): void {
  if (++state.visits > NATIVE_BOOK_WIRE_ALIASES_LIMITS.maxVisits || depth > NATIVE_BOOK_WIRE_ALIASES_LIMITS.maxDepth)
    throw new Invalid('graph-capacity');
  if (value == null || value === undefined || typeof value === 'boolean') return;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Invalid('nonfinite-value');
    return;
  }
  if (typeof value === 'string') {
    state.characters += value.length;
    if (state.characters > NATIVE_BOOK_WIRE_ALIASES_LIMITS.maxStringCharacters) throw new Invalid('text-capacity');
    return;
  }
  if (typeof value !== 'object') throw new Invalid('unsupported-json-value');
  if (state.active.has(value)) throw new Invalid('cycle');
  const array = Array.isArray(value);
  if (array ? Object.getPrototypeOf(value) !== Array.prototype : !plain(value)) throw new Invalid('unsupported-prototype');
  const length: unknown = array ? Object.getOwnPropertyDescriptor(value, 'length')?.value : 0;
  if (array && (typeof length !== 'number' || !Number.isSafeInteger(length) || length < 0
      || length > NATIVE_BOOK_WIRE_ALIASES_LIMITS.maxActiveKeys - state.activeKeys)) throw new Invalid('array-capacity');
  const ownKeys = keys(value, NATIVE_BOOK_WIRE_ALIASES_LIMITS.maxActiveKeys - state.activeKeys, array);
  if (array && ownKeys.length !== length) throw new Invalid('sparse-array');
  state.active.add(value); state.activeKeys += ownKeys.length;
  try {
    for (const key of ownKeys) {
      if (array) {
        const index = Number(key);
        if (!Number.isSafeInteger(index) || index < 0 || index >= Number(length) || String(index) !== key)
          throw new Invalid('array-property');
      } else {
        state.characters += key.length;
        if (state.characters > NATIVE_BOOK_WIRE_ALIASES_LIMITS.maxStringCharacters) throw new Invalid('text-capacity');
      }
      const child: unknown = data(value, key);
      if (array && child === undefined) throw new Invalid('undefined-array-value');
      graph(child, state, depth + 1);
    }
  } finally { state.active.delete(value); state.activeKeys -= ownKeys.length; }
}
function book(value: object, state: Validation): void {
  for (const side of ['bids', 'asks']) {
    const rows: unknown = data(value, side);
    if (!Array.isArray(rows) || rows.length > NATIVE_BOOK_WIRE_ALIASES_LIMITS.maxLevelsPerSide)
      throw new Invalid('invalid-level-count');
    for (let index = 0; index < rows.length; index++) {
      const row: unknown = data(rows, String(index));
      if (!Array.isArray(row) || row.length !== 2) throw new Invalid('invalid-level');
      const price: unknown = data(row, '0'), amount: unknown = data(row, '1');
      if (typeof price !== 'number' || !Number.isFinite(price) || price <= 0
          || typeof amount !== 'number' || !Number.isFinite(amount) || amount < 0) throw new Invalid('invalid-level');
    }
  }
  graph(value, state, 2);
}
function validateBooks(groups: readonly (readonly [string, object][])[]): void {
  const validation: Validation = { visits: 0, characters: 0, activeKeys: 0, active: new Set() };
  for (const group of groups) for (const [key, value] of group) {
    validation.characters += key.length;
    if (validation.characters > NATIVE_BOOK_WIRE_ALIASES_LIMITS.maxStringCharacters) throw new Invalid('text-capacity');
    book(value, validation);
  }
}
function maps(source: unknown): { canonical: [string, object][]; variants: [string, object][] } {
  if (!plain(source)) throw new Invalid('invalid-maps');
  const canonical = entries(data(source, 'books')), variants = entries(data(source, 'booksByKey'));
  validateBooks([canonical, variants]);
  return { canonical, variants };
}
/** Encode only complete serialized DTOs whose true identities survived the
 * producer's per-publication serializer. Never infer identity from equal fields,
 * bookKey, instrumentId, Object.isFrozen or an external size certificate.
 * Null rejects the whole proposal; nothing is clipped or partially emitted.
 */
export function encodeNativeBookWireAliases<Book extends object>(source: NativeBookWireAliasMaps<Book>): NativeBookWireAliasPacket<Book> | null;
export function encodeNativeBookWireAliases(source: unknown): NativeBookWireAliasPacket | null;
export function encodeNativeBookWireAliases(source: unknown): NativeBookWireAliasPacket<object> | null {
  try {
    const { canonical, variants } = maps(source);
    const owners = new Map<object, string>();
    for (const [key, value] of variants) {
      if (owners.has(value)) throw new Invalid('ambiguous-keyed-owner');
      owners.set(value, key);
    }
    // All graph/key validation completes before alias/result maps are allocated.
    const books: Record<string, object> = {}, booksByKey: Record<string, object> = {}, references: Record<string, string> = {};
    for (const [key, value] of variants) booksByKey[key] = value;
    for (const [key, value] of canonical) {
      const target = owners.get(value);
      if (target === undefined) books[key] = value;
      else references[key] = target;
    }
    return { books, booksByKey, nativeBookAliases: { version: NATIVE_BOOK_WIRE_ALIASES_VERSION, references } };
  } catch { return null; }
}
/** Decode the exact isolated packet extracted from a negotiated bounded frame.
 * Validate every reference before allocating the reconstructed canonical map.
 * All complete field payloads/variants survive; only actual declared aliases share.
 * Caller still validates frame metadata/session/sequence and its native lease.
 */
export function decodeNativeBookWireAliases(source: unknown): NativeBookWireAliasMaps | null {
  try {
    if (!plain(source)) return null;
    const outer = keys(source, 3);
    if (outer.length !== 3 || !outer.every(key => ['books', 'booksByKey', 'nativeBookAliases'].includes(key))) return null;
    const control: unknown = data(source, 'nativeBookAliases');
    if (!plain(control)) return null;
    const controlKeys = keys(control, 2);
    if (controlKeys.length !== 2 || !controlKeys.every(key => ['version', 'references'].includes(key))
        || data(control, 'version') !== NATIVE_BOOK_WIRE_ALIASES_VERSION) return null;
    const references: unknown = data(control, 'references');
    if (!plain(references)) return null;
    const referenceKeys = keys(references, NATIVE_BOOK_WIRE_ALIASES_LIMITS.maxBooksPerMap);
    const { canonical, variants } = maps(source);
    if (canonical.length + referenceKeys.length > NATIVE_BOOK_WIRE_ALIASES_LIMITS.maxBooksPerMap) return null;
    const canonicalKeys = new Set(canonical.map(([key]) => key));
    const targets = new Map(variants);
    const resolved: [string, object][] = [];
    for (const key of referenceKeys) {
      if (!keySafe(key) || canonicalKeys.has(key)) return null;
      const target: unknown = data(references, key);
      if (typeof target !== 'string' || !keySafe(target)) return null;
      const value = targets.get(target);
      if (!value) return null;
      resolved.push([key, value]);
    }
    const books: Record<string, NativeBookWireAliasBook> = {}, booksByKey: Record<string, NativeBookWireAliasBook> = {};
    for (const [key, value] of variants) booksByKey[key] = value as NativeBookWireAliasBook;
    for (const [key, value] of [...canonical, ...resolved]) books[key] = value as NativeBookWireAliasBook;
    return { books, booksByKey };
  } catch { return null; }
}
