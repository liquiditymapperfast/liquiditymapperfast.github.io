const nativeUtf8ByteLength = Buffer.byteLength;
/** Exact bounded short-ASCII length; Unicode and overridden byteLength stay native. */
function utf8Bytes(value: string): number {
  const measure = Buffer.byteLength;
  if (measure === nativeUtf8ByteLength && value.length <= 64) {
    for (let index = 0; index < value.length; index++) if (value.charCodeAt(index) > 127) return measure(value, 'utf8');
    return value.length;
  }
  return Reflect.apply(measure, Buffer, [value, 'utf8']) as number;
}
const arrayReduce = Array.prototype.reduce;
const arrayMap = Array.prototype.map;
const mapIterator = Map.prototype[Symbol.iterator];
const mapForEach = Map.prototype.forEach;
interface MapTraversal { seen: Set<unknown>; total: number }
function mapPartsItem(this: MapTraversal, item: unknown, key: unknown) { this.total += visitParts(key, this.seen) + visitParts(item, this.seen); }

function visitParts(node: unknown, seen: Set<unknown>): number {
  if (node == null) return 0;
  if (typeof node === 'string') return utf8Bytes(node);
  if (typeof node === 'number' || typeof node === 'boolean' || typeof node === 'bigint') return 8;
  if (typeof node !== 'object' && typeof node !== 'function' || seen.has(node)) return 0;
  seen.add(node); let total = 0;
  if (node instanceof Map) {
    const iterator = node[Symbol.iterator];
    if (iterator === mapIterator) {
      const context: MapTraversal = { seen, total: 0 }; mapForEach.call(node, mapPartsItem, context); return context.total;
    }
    const iterable: Iterable<readonly [unknown, unknown]> = { [Symbol.iterator]: () => Reflect.apply(iterator, node, []) as IterableIterator<readonly [unknown, unknown]> };
    for (const [key, item] of iterable) total += visitParts(key, seen) + visitParts(item, seen);
    return total;
  }
  if (node instanceof Set) { for (const item of node) total += visitParts(item, seen); return total; }
  if (ArrayBuffer.isView(node)) return Number(node.byteLength) || 0;
  if (node instanceof ArrayBuffer) return Number(node.byteLength) || 0;
  if (Array.isArray(node)) {
    const items: unknown[] = node;
    const reduce = items.reduce;
    if (reduce !== arrayReduce) return Reflect.apply(reduce, items, [(sum: number, item: unknown) => sum + visitParts(item, seen), 0]) as number;
    const length = items.length;
    for (let index = 0; index < length; index++) if (index in items) total += visitParts(items[index], seen);
    return total;
  }
  // Native eager enumeration preserves getter/value order; direct reflection was measured slower.
  const entries = Object.entries(node);
  for (let index = 0; index < entries.length; index++) {
    const entry = entries[index]; total += utf8Bytes(entry[0]) + visitParts(entry[1], seen);
  }
  return total;
}

/** Cycle-safe logical UTF-8 retained-byte estimate. Shared references count once. */
export function logicalRetainedBytes(value: unknown): number {
  const seen = new Set<unknown>();
  const visit = (node: unknown): number => {
    if (node == null) return 0;
    if (typeof node === 'string') return utf8Bytes(node);
    if (typeof node === 'number' || typeof node === 'boolean' || typeof node === 'bigint') return 8;
    if (typeof node !== 'object' && typeof node !== 'function') return 0;
    if (seen.has(node)) return 0;
    seen.add(node);
    let bytes = 0;
    if (node instanceof Map) {
      for (const [key, item] of node) bytes += visit(key) + visit(item);
      return bytes;
    }
    if (node instanceof Set) {
      for (const item of node) bytes += visit(item);
      return bytes;
    }
    if (ArrayBuffer.isView(node)) return Number(node.byteLength) || 0;
    if (node instanceof ArrayBuffer) return Number(node.byteLength) || 0;
    if (Array.isArray(node)) { for (const item of node) bytes += visit(item); return bytes; }
    for (const [key, item] of Object.entries(node)) bytes += utf8Bytes(key) + visit(item);
    return bytes;
  };
  return visit(value);
}

/** Measure top-level values with one shared identity set. */
export function logicalRetainedParts(values: unknown[] = []): number[] {
  const roots: unknown[] = Array.isArray(values) ? values : [values]; const seen = new Set<unknown>();
  const map = roots.map;
  if (map !== arrayMap) return Reflect.apply(map, roots, [(node: unknown) => visitParts(node, seen)]) as number[];
  const length = roots.length; const output = new Array<number>(length);
  for (let index = 0; index < length; index++) if (index in roots) output[index] = visitParts(roots[index], seen);
  return output;
}

export function logicalRetainedComponents(components: Record<string, unknown> = {}): Record<string, number> {
  const seen = new Set<unknown>(); const entries = Object.entries(components); const output: Record<string, number> = {};
  for (let index = 0; index < entries.length; index++) {
    const [key, value] = entries[index];
    const bytes = typeof value === 'function' ? logicalRetainedBytes(value) : visitParts(value, seen);
    Object.defineProperty(output, key, { value: bytes, enumerable: true, writable: true, configurable: true });
  }
  return output;
}
