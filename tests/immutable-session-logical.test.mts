import test from 'node:test';
import assert from 'node:assert/strict';
import { ImmutableSessionRowBytesCache } from '../src/server/immutable-session-row-bytes.mts';
import { HistoryStore } from '../src/server/history.mts';
import { logicalRetainedBytes, logicalRetainedComponents } from '../src/core/retained-bytes.mts';
function row(text = 'row') { return { instrumentId: text, observedIntervals: [{ start: 1, end: 2 }], text: '€'.repeat(40) }; }
function comparison(cache: ImmutableSessionRowBytesCache, rows: object[]) {
  const proof = cache.logicalOwnership(rows); assert.equal(proof.complete, true, proof.reason ?? 'incomplete');
  const upper = logicalRetainedBytes({ rows: proof.mutableRows, cache: proof.mutableCacheOwners }) + proof.sessionLogicalBytesUpper + proof.cacheLogicalBytesUpper;
  const fresh = logicalRetainedBytes({ rows, cache: cache.retainedRoot() }); assert.ok(upper >= fresh, `${upper} < ${fresh}`); return proof;
}

test('immutable logical reuse dominates authoritative fresh alias/cycle-safe visitor and duplicate JSON occurrence totals stay exact', () => {
  const cache = new ImmutableSessionRowBytesCache(); const shared = [{ start: 1, end: 2 }]; const first = { ...row('first'), observedIntervals: shared }, second = { ...row('second'), observedIntervals: shared };
  assert.equal(cache.sealDetachedRows([first, second]).complete, true); const rows = [first, first, second]; const proof = comparison(cache, rows);
  assert.equal(proof.mutableRows.length, 0); assert.equal(proof.sessionLogicalBytesUpper, logicalRetainedBytes(first) + logicalRetainedBytes(second));
  assert.ok(proof.sessionLogicalBytesUpper >= logicalRetainedBytes(rows));
  assert.equal(cache.sum(rows).bytes, rows.reduce((sum, item) => sum + Buffer.byteLength(JSON.stringify(item)), 0));
  assert.equal(Reflect.set(first.observedIntervals[0], 'end', 99), false); comparison(cache, rows);
});

test('fresh slot scans project mutable external rows and never cache their evolving nested payloads', () => {
  const cache = new ImmutableSessionRowBytesCache(); const frozen = row('internal'); cache.sealDetachedRows([frozen]);
  const external = row('external'); const rows = [frozen]; const before = comparison(cache, rows); rows.push(external);
  const after = comparison(cache, rows); assert.equal(after.mutableRows[0], external); assert.equal(after.sessionLogicalBytesUpper, before.sessionLogicalBytesUpper);
  const prior = logicalRetainedBytes(after.mutableRows); external.text += 'new data'.repeat(100); assert.ok(logicalRetainedBytes(comparison(cache, rows).mutableRows) > prior);
  assert.equal(Object.isFrozen(external), false);
});

test('strong cached owners absent from session membership remain charged until sync removes ownership', () => {
  const cache = new ImmutableSessionRowBytesCache(); const first = row('live'), retired = row('cached-only'); cache.sealDetachedRows([first, retired]);
  const proof = comparison(cache, [first]); assert.ok(proof.cacheLogicalBytesUpper >= logicalRetainedBytes(retired) + cache.count * 8);
  const old = proof.cacheLogicalBytesUpper; cache.sync([first]); const released = comparison(cache, [first]); assert.ok(released.cacheLogicalBytesUpper < old);
  assert.equal(cache.retainedRoot().has(retired), false);
});

test('unproved/invalid cache entries remain fully mutable or force complete fresh fallback', () => {
  const cache = new ImmutableSessionRowBytesCache(); const first = row('sealed'); cache.sealDetachedRows([first]);
  const external = row('cache-only'); const actual = cache.retainedRoot() as Map<object, number>; actual.set(external, 10);
  const proof = comparison(cache, [first]); assert.equal(proof.mutableCacheOwners[0], external); external.text += 'grow'; comparison(cache, [first]);
  actual.set(first, Number.NaN); assert.equal(cache.logicalOwnership([first]).complete, false); assert.ok(cache.retainedRoot().has(external));
  let hits = 0; const malformed: object[] = []; Object.defineProperty(malformed, '0', { get() { hits++; return first; }, configurable: true });
  assert.equal(cache.logicalOwnership(malformed).complete, false); assert.equal(hits, 0);
});

test('read-only combined ownership charges saved absent strong keys, numeric metadata, and duplicate mutable graphs', () => {
  const cache = new ImmutableSessionRowBytesCache(), current = row('current'), absent = row('absent strong owner');
  cache.sealDetachedRows([current, absent]);
  const shared = [{ start: 3, end: 4 }], mutable = { text: 'mutable current €', shared, alias: shared };
  const cacheOnly = { text: 'mutable cache-only €', shared };
  const actual = cache.retainedRoot() as Map<object, number>; actual.set(cacheOnly, 10); actual.set(mutable, 20);
  const saved = [...actual], revision = cache.membershipRevision, rows = [current, current, mutable, mutable];
  const verify = () => {
    const expected = cache.logicalOwnership(rows), result = cache.measureFresh(rows);
    assert.equal(result.serialized.complete, true); assert.equal(result.serialized.bytes, rows.reduce((sum, item) => sum + Buffer.byteLength(JSON.stringify(item)), 0));
    assert.deepEqual(result.ownership, expected); assert.equal(result.ownershipOperations, rows.length + saved.length);
    assert.deepEqual([...actual], saved); assert.equal(cache.membershipRevision, revision); assert.ok(result.ownership?.complete);
    assert.equal(result.ownership.sessionLogicalBytesUpper, logicalRetainedBytes(current));
    assert.equal(result.ownership.cacheLogicalBytesUpper, logicalRetainedBytes(absent) + saved.length * 8 + 2 * 16);
    assert.deepEqual(result.ownership.mutableRows, [mutable, mutable]); assert.deepEqual(result.ownership.mutableCacheOwners, [cacheOnly, mutable]);
    const projected = logicalRetainedBytes({ rows: result.ownership.mutableRows, cache: result.ownership.mutableCacheOwners })
      + result.ownership.sessionLogicalBytesUpper + result.ownership.cacheLogicalBytesUpper;
    assert.ok(projected >= logicalRetainedBytes({ rows, cache: actual }));
    return logicalRetainedBytes(result.ownership.mutableCacheOwners);
  };
  const before = verify(); cacheOnly.text += 'fresh strong-key growth €'.repeat(50); shared.push({ start: 5, end: 6 });
  assert.ok(verify() > before); assert.equal(Object.isFrozen(mutable), false);
  // Exposing the Map does not give a replacement iterator authority over measurement.
  Object.defineProperty(actual, Symbol.iterator, { value: () => { throw new Error('custom iterator must not run'); }, configurable: true });
  try { assert.equal(cache.measureFresh(rows).ownership?.complete, true); } finally { delete (actual as { [Symbol.iterator]?: unknown })[Symbol.iterator]; }
  cache.sync([current, mutable]); const released = cache.measureFresh(rows);
  assert.equal(released.ownership?.complete, true); assert.ok(released.ownership!.cacheLogicalBytesUpper < logicalRetainedBytes(absent));
});

test('successful serialization with invalid retained numeric ownership preserves an independent full-graph fallback', () => {
  const cache = new ImmutableSessionRowBytesCache(), absent = row('absent'); cache.sealDetachedRows([absent]);
  const mutable = row('mutable duplicate'); const index = cache.retainedRoot() as Map<object, number>;
  index.set(mutable, Number.NaN); const rows = [mutable, mutable];
  const readonly = cache.measureFresh(rows);
  assert.equal(readonly.serialized.complete, true); assert.equal(readonly.serialized.bytes, rows.reduce((sum, item) => sum + Buffer.byteLength(JSON.stringify(item)), 0));
  assert.equal(readonly.ownership?.complete, false); assert.equal(readonly.ownership?.reason, 'invalid-json'); assert.equal(index.has(absent), true);
  const result = cache.measureFresh(rows, { reconcile: true });
  assert.equal(result.serialized.complete, true); assert.equal(result.serialized.freshRows, 2); assert.equal(result.ownership?.complete, false);
  assert.equal(result.ownership?.sessionLogicalBytesUpper, 0); assert.equal(result.ownership?.cacheLogicalBytesUpper, 0);
  assert.deepEqual(result.ownership?.mutableRows, []); assert.deepEqual(result.ownership?.mutableCacheOwners, []);
  assert.equal(index.has(absent), false); assert.equal(index.has(mutable), true); assert.ok(Number.isNaN(index.get(mutable)));
  assert.equal(logicalRetainedBytes({ rows, cache: index }), Buffer.byteLength('rowscache') + logicalRetainedBytes(mutable) + 8);
});
