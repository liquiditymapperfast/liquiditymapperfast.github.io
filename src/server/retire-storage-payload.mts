/**
 * Retire redundant storage serialization only from a fresh, plain JSON row.
 *
 * CALLER OWNERSHIP CONTRACT: the row must belong exclusively to the fresh
 * HTTP/SSE parse, before it is installed in any retained/admitted/shared graph.
 * This cannot be inferred from the object's shape. Use the pure display-row
 * projection for borrowed or retained rows instead. No nested graph is read,
 * cloned or mutated; all remaining properties and row identity stay intact.
 */
export function retireOwnedStoragePayload(row: unknown): boolean {
  if (row === null || typeof row !== 'object' || Array.isArray(row)) throw new TypeError('Plain caller-owned JSON row required');
  const prototype: unknown = Object.getPrototypeOf(row);
  if (prototype !== Object.prototype && prototype !== null) throw new TypeError('Plain caller-owned JSON row required');
  const descriptor = Object.getOwnPropertyDescriptor(row, 'payloadJson');
  if (!descriptor) return false;
  if (!('value' in descriptor) || descriptor.configurable !== true) throw new TypeError('Configurable payloadJson data property required');
  if (!Reflect.deleteProperty(row, 'payloadJson')) throw new TypeError('Owned payloadJson retirement failed');
  return true;
}
