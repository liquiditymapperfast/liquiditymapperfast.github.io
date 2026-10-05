import assert from 'node:assert/strict';

/** Fail explicitly when a test expects an initialized owner or completed operation. */
export function defined<T>(value: T, label = 'required test value'): NonNullable<T> {
  assert.notEqual(value, null, label);
  assert.notEqual(value, undefined, label);
  return value as NonNullable<T>;
}

/** Reflective fields retain unknown values until the assertion narrows them. */
export function fields(value: unknown): Record<string, unknown> {
  assert.ok(value !== null && (typeof value === 'object' || typeof value === 'function'), 'expected an object');
  return value as Record<string, unknown>;
}

export function list(value: unknown): unknown[] {
  assert.ok(Array.isArray(value), 'expected an array');
  return value;
}

export function numeric(value: unknown): number {
  assert.equal(typeof value, 'number', 'expected a numeric value');
  return value as number;
}

export function textValue(value: unknown): string {
  assert.equal(typeof value, 'string', 'expected a text value');
  return value as string;
}

export function fieldMap(value: unknown): Map<unknown, unknown> {
  assert.ok(value instanceof Map, 'expected a map');
  return value;
}

/** Deliberately seed an internal owner with an incomplete row to test accounting or rejection. */
export function injectMapFixture<Key, Value>(map: Map<Key, Value>, key: Key, row: unknown): void {
  Reflect.apply(map.set, map, [key, row]);
}

/** Deliberately inject a structural queue stub for ownership/accounting fault coverage. */
export function injectSetFixture<Value>(set: Set<Value>, fixture: unknown): void {
  Reflect.apply(set.add, set, [fixture]);
}

/** Deliberately retain an incomplete internal row for memory-accounting fault coverage. */
export function injectArrayFixture<Value>(array: Value[], ...rows: unknown[]): void {
  Reflect.apply(array.push, array, rows);
}
