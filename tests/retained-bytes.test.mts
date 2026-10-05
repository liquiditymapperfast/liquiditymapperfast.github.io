import test from 'node:test';
import assert from 'node:assert/strict';
import { logicalRetainedBytes, logicalRetainedComponents } from '../src/core/retained-bytes.mts';

test('logical retained bytes count UTF-8 strings and shared aliases once', () => {
  const shared = { label: '€' };
  assert.equal(logicalRetainedBytes({ a: shared, b: shared }), 1 + logicalRetainedBytes(shared) + 1);
  const components = logicalRetainedComponents({ first: shared, second: shared, distinct: { label: '€' } });
  assert.equal(components.first + components.second, logicalRetainedBytes(shared));
  assert.ok(components.distinct >= Buffer.byteLength('label€', 'utf8'));
});

test('logical retained bytes are cycle-safe and variants remain distinct', () => {
  const cycle: { name: string; self?: unknown } = { name: 'cycle' }; cycle.self = cycle;
  assert.equal(logicalRetainedBytes(cycle), Buffer.byteLength('name', 'utf8') + Buffer.byteLength('cycle', 'utf8') + Buffer.byteLength('self', 'utf8'));
  const variants = logicalRetainedComponents({ native: { bookKey: 'native', bids: [[1, 2]] }, coarse: { bookKey: 'coarse', bids: [[1, 2]] } });
  assert.ok(variants.native > 0 && variants.coarse > 0);
  assert.equal(variants.native + variants.coarse, logicalRetainedBytes({ bookKey: 'native', bids: [[1, 2]] }) + logicalRetainedBytes({ bookKey: 'coarse', bids: [[1, 2]] }));
});

test('logical retained bytes measure Map, Set, and binary payloads without double-counting aliases', () => {
  const shared = { payload: 'x'.repeat(64) };
  const map = new Map([['book', shared]]);
  const set = new Set([shared]);
  const components = logicalRetainedComponents({ map, set });
  assert.equal(components.map, logicalRetainedBytes(map));
  assert.equal(components.set, 0);
  assert.equal(logicalRetainedBytes(new Uint8Array(32)), 32);
  assert.equal(logicalRetainedBytes(new ArrayBuffer(17)), 17);
});
