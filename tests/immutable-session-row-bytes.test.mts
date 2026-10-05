import test from 'node:test';
import assert from 'node:assert/strict';
import { ImmutableSessionRowBytesCache, IMMUTABLE_SESSION_ROW_BYTES_LIMITS } from '../src/server/immutable-session-row-bytes.mts';
import { logicalRetainedBytes, logicalRetainedComponents } from '../src/core/retained-bytes.mts';
const exact = (rows: object[]) => rows.reduce((sum, row) => sum + Buffer.byteLength(JSON.stringify(row), 'utf8'), 0);
function row(id = 'native:BTC') { const intervals = [{ start: 1000, end: 1100 }]; return { instrumentId: id, bucketStart: 1000, bucketEnd: 2000, sourceGrouping: 50,
  observedIntervals: intervals, gapIntervals: [], observedSegments: [{ start: 1000, end: 1100, amount: 2, notionalUsd: 200 }], alias: intervals,
  text: '€ 😀 \ud800\udfff\n\t"\\\u0000', negativeZero: -0, positive: 1e30, negative: -1e-7, nullable: null }; }

test('sealed Unicode/nested aliases and duplicate references have exact UTF8 sizes without retained strings', () => {
  const cache = new ImmutableSessionRowBytesCache(); const first = row(); const equal = structuredClone(first); const input = [first, first, equal]; const json = JSON.stringify(input);
  const sealed = cache.sealDetachedRows(input); assert.equal(sealed.complete, true, sealed.reason ?? 'failed'); assert.equal(sealed.bytes, exact(input));
  assert.equal(cache.count, 2); assert.ok(Object.isFrozen(first)); assert.ok(Object.isFrozen(first.observedIntervals)); assert.ok(Object.isFrozen(first.observedIntervals[0]));
  assert.equal(first.alias, first.observedIntervals); assert.equal(Object.isFrozen(input), false); assert.equal(JSON.stringify(input), json);
  const sum = cache.sum(input); assert.equal(sum.bytes, exact(input)); assert.equal(sum.cachedRows, 3); assert.equal(sum.freshRows, 0);
  assert.ok(sum.operations < 20); assert.ok([...cache.retainedRoot().values()].every(value => typeof value === 'number'));
});

test('mutable and externally frozen caller rows stay uncached/fresh and are never modified', () => {
  const cache = new ImmutableSessionRowBytesCache(); const external = row(); const frozenExternal = Object.freeze({ instrumentId: 'external', amount: 2 });
  assert.equal(cache.sum([external, frozenExternal]).bytes, exact([external, frozenExternal])); assert.equal(cache.count, 0); assert.equal(Object.isFrozen(external), false);
  const old = exact([external]); external.text += ' more €'; external.observedIntervals[0].end = 1200;
  const sum = cache.sum([external]); assert.equal(sum.freshRows, 1); assert.equal(sum.cachedRows, 0); assert.equal(sum.bytes, exact([external])); assert.ok(sum.bytes! > old);
  assert.equal(cache.count, 0); assert.equal(Object.isFrozen(external.observedIntervals), false);
});

test('current membership prunes same-length replacement; failed retries retain owners; successful sync drops only removed owners', () => {
  const cache = new ImmutableSessionRowBytesCache(); const first = row('first'), second = row('second'); assert.equal(cache.sealDetachedRows([first, second]).complete, true);
  const before = cache.sum([first, second]); const retry = cache.sum([first, second]); assert.equal(before.bytes, retry.bytes); assert.equal(cache.count, 2);
  const replacement = row('replacement'); const replaced = cache.sum([replacement, second]); assert.equal(replaced.bytes, exact([replacement, second]));
  assert.equal(cache.retainedRoot().has(first), false); assert.equal(cache.retainedRoot().has(second), true); assert.equal(cache.count, 1);
  assert.equal(cache.sync([replacement]).complete, true); assert.equal(cache.count, 0);
  // Proof is weak: reintroducing the same immutable identity is safe, without keeping it strongly while absent.
  assert.equal(cache.sum([first]).cachedRows, 1); assert.equal(cache.count, 1); cache.sync([]); assert.equal(cache.count, 0);
});

test('all validation precedes mutation and cycles/accessors/custom prototypes fail without executing accessors', () => {
  const cache = new ImmutableSessionRowBytesCache(); const first = row(); let hits = 0; const invalid = { instrumentId: 'invalid' };
  Object.defineProperty(invalid, 'observedIntervals', { enumerable: true, get() { hits++; return []; } });
  assert.equal(cache.sealDetachedRows([first, invalid]).reason, 'invalid-json'); assert.equal(hits, 0); assert.equal(Object.isFrozen(first), false); assert.equal(cache.count, 0);
  assert.equal(cache.sum([invalid]).reason, 'invalid-json'); assert.equal(hits, 0);
  const cycle: { self?: unknown } = {}; cycle.self = cycle; assert.equal(cache.sealDetachedRows([first, cycle]).reason, 'cycle'); assert.equal(Object.isFrozen(cycle), false);
  assert.equal(cache.sealDetachedRows([first, new Date()]).reason, 'invalid-json'); assert.equal(Object.isFrozen(first), false);
  const sparse = { levels: new Array(2) }; assert.equal(cache.sealDetachedRows([first, sparse]).reason, 'invalid-json');
  const nonJson = { instrumentId: 'invalid', amount: Number.NaN }; assert.equal(cache.sealDetachedRows([first, nonJson]).reason, 'invalid-json');
  assert.equal(cache.count, 0);
});

test('row/work/depth bounds fail before freezing, retain prior valid owners, and invalid membership never prunes them', () => {
  const cache = new ImmutableSessionRowBytesCache(); const first = row(); assert.equal(cache.sealDetachedRows([first]).complete, true);
  const huge = { text: 'x'.repeat(IMMUTABLE_SESSION_ROW_BYTES_LIMITS.maxOperations + 1) };
  assert.equal(cache.sealDetachedRows([huge]).reason, 'work-limit'); assert.equal(Object.isFrozen(huge), false); assert.equal(cache.count, 1);
  const many = Array.from({ length: IMMUTABLE_SESSION_ROW_BYTES_LIMITS.maxRows + 1 }, () => first);
  assert.equal(cache.sealDetachedRows(many).reason, 'row-limit'); assert.equal(cache.sum(many).reason, 'row-limit'); assert.equal(cache.sync(many).reason, 'row-limit'); assert.equal(cache.count, 1);
  const deep: { child?: unknown } = {}; let current = deep;
  for (let index = 0; index <= IMMUTABLE_SESSION_ROW_BYTES_LIMITS.maxDepth; index++) { const next = {}; current.child = next; current = next; }
  assert.equal(cache.sealDetachedRows([deep]).reason, 'depth-limit'); assert.equal(Object.isFrozen(deep), false); assert.equal(cache.count, 1);
  assert.equal(cache.sum([null]).complete, false); assert.equal(cache.count, 1);
});

test('actual size-cache graph is a retained root with alias-aware key ownership and charged numeric metadata', () => {
  const cache = new ImmutableSessionRowBytesCache(); const rows = [row('first'), row('second')]; cache.sealDetachedRows(rows); cache.sum(rows);
  const components = logicalRetainedComponents({ rows, sizeCache: cache.retainedRoot() });
  assert.equal(components.rows, logicalRetainedBytes(rows)); assert.equal(components.sizeCache, cache.count * 8);
  assert.equal(logicalRetainedBytes({ rows, sizeCache: cache.retainedRoot() }), Buffer.byteLength('rows') + Buffer.byteLength('sizeCache') + components.rows + components.sizeCache);
  cache.sync([]); assert.equal(logicalRetainedBytes(cache.retainedRoot()), 0);
});

test('opaque proxies reject without reflection traps or partial freezing', () => {
  const cache = new ImmutableSessionRowBytesCache(); const first = row(); let traps = 0;
  const proxy = new Proxy({}, { getPrototypeOf() { traps++; return Object.prototype; }, ownKeys() { traps++; return []; }, preventExtensions() { traps++; return false; } });
  assert.equal(cache.sealDetachedRows([first, proxy]).reason, 'invalid-json'); assert.equal(traps, 0); assert.equal(Object.isFrozen(first), false);
  const proxyMembership = new Proxy([first], { getPrototypeOf() { traps++; return Array.prototype; } });
  assert.equal(cache.sum(proxyMembership).reason, 'invalid-json'); assert.equal(traps, 0); assert.equal(cache.count, 0);
});

test('internal both-side headers and cells preserve omitted optional fields and undefined array nulls exactly', () => {
  const cache = new ImmutableSessionRowBytesCache(); const header = { instrumentId: 'native:BTC', bucketStart: 1000, bucketEnd: 2000,
    side: 'both', priceLow: null, priceHigh: null, sourceTimestampMin: undefined, sourceTimestampMax: undefined,
    receivedAt: null, observedIntervals: [], gapIntervals: [{ start: 1000, end: 2000 }], observedSegments: undefined, coverage: 'gap' };
  const cell = { ...row(), optionalFirst: undefined, optionalLast: undefined, nested: { before: undefined, value: 2, middle: undefined, last: 3, after: undefined }, array: [undefined, 2, undefined] };
  const original = JSON.stringify([header, cell]);
  const fresh = cache.sum([header, cell]); assert.equal(fresh.complete, true, fresh.reason ?? 'failed'); assert.equal(fresh.bytes, exact([header, cell])); assert.equal(cache.count, 0);
  const sealed = cache.sealDetachedRows([header, cell]); assert.equal(sealed.complete, true, sealed.reason ?? 'failed'); assert.equal(sealed.bytes, fresh.bytes);
  assert.equal(JSON.stringify([header, cell]), original); assert.ok(Object.hasOwn(header, 'sourceTimestampMin')); assert.equal(header.sourceTimestampMin, undefined);
  assert.equal(cache.sum([header, cell, header]).bytes, exact([header, cell, header])); assert.equal(cache.count, 2);
});

test('combined reconciliation matches separate fresh measurements for duplicate mutable and weakly reintroduced owners', () => {
  const separate = new ImmutableSessionRowBytesCache(), combined = new ImmutableSessionRowBytesCache();
  const shared = [{ start: 1, end: 2 }], first = row('first'), retired = row('retired'), reintroduced = row('reintroduced');
  const external = { instrumentId: 'mutable', intervals: shared, alias: shared, text: 'fresh €' };
  const frozenExternal = Object.freeze({ instrumentId: 'external-frozen', payload: shared });
  for (const cache of [separate, combined]) {
    assert.equal(cache.sealDetachedRows([first, retired, reintroduced]).complete, true);
    cache.sync([first, retired]);
    // A stale numeric value on an owned current key is repaired by sum reconciliation.
    (cache.retainedRoot() as Map<object, number>).set(first, Number.NaN);
  }
  const input = [first, external, first, external, frozenExternal, reintroduced];
  const verify = () => {
    const serialized = separate.sum(input), ownership = separate.logicalOwnership(input);
    const result = combined.measureFresh(input, { reconcile: true });
    assert.deepEqual(result.serialized, serialized); assert.deepEqual(result.ownership, ownership);
    assert.equal(result.ownershipOperations, input.length + combined.count);
    assert.equal(result.serialized.bytes, exact(input)); assert.equal(result.serialized.cachedRows, 3); assert.equal(result.serialized.freshRows, 3);
    assert.deepEqual(result.ownership?.mutableRows, [external, external, frozenExternal]);
    assert.deepEqual([...combined.retainedRoot()], [...separate.retainedRoot()]);
    assert.equal(combined.membershipRevision, separate.membershipRevision);
    assert.equal(combined.retainedRoot().has(retired), false); assert.equal(combined.retainedRoot().has(reintroduced), true);
    assert.equal(combined.retainedRoot().has(external), false); assert.equal(combined.retainedRoot().has(frozenExternal), false);
    assert.ok(result.ownership?.complete);
    const upper = logicalRetainedBytes({ rows: result.ownership.mutableRows, cache: result.ownership.mutableCacheOwners })
      + result.ownership.sessionLogicalBytesUpper + result.ownership.cacheLogicalBytesUpper;
    assert.ok(upper >= logicalRetainedBytes({ rows: input, cache: combined.retainedRoot() }));
    return result.serialized.bytes!;
  };
  const before = verify(); external.text += 'larger mutable data €'.repeat(80); shared.push({ start: 3, end: 4 });
  assert.ok(verify() > before); assert.equal(Object.isFrozen(external), false); assert.equal(Object.isFrozen(shared), false);
});

test('combined validation and serialization failures leave saved strong keys and numeric owners untouched', () => {
  const cache = new ImmutableSessionRowBytesCache(), first = row('retained'); cache.sealDetachedRows([first]);
  const unknown = { cacheOnly: 'strong key payload' }, index = cache.retainedRoot() as Map<object, number>;
  index.set(unknown, Number.NaN); const saved = [...index], revision = cache.membershipRevision;
  let getters = 0, traps = 0;
  const accessor = {}; Object.defineProperty(accessor, 'payload', { enumerable: true, get() { getters++; return 'invalid'; } });
  const malformed: object[] = [accessor]; Object.defineProperty(malformed, '1', { get() { getters++; return first; } });
  const proxy = new Proxy({}, { getPrototypeOf() { traps++; return Object.prototype; }, ownKeys() { traps++; return []; } });
  const cycle: { self?: unknown } = {}; cycle.self = cycle;
  const deep: { child?: unknown } = {}; let current = deep;
  for (let index = 0; index <= IMMUTABLE_SESSION_ROW_BYTES_LIMITS.maxDepth; index++) { const next = {}; current.child = next; current = next; }
  const cases: [unknown, string][] = [[malformed, 'invalid-json'], [[accessor], 'invalid-json'], [[proxy], 'invalid-json'], [[cycle], 'cycle'],
    [[new Date()], 'invalid-json'], [[{ levels: new Array(2) }], 'invalid-json'], [[{ amount: Number.NaN }], 'invalid-json'],
    [[{ text: 'x'.repeat(IMMUTABLE_SESSION_ROW_BYTES_LIMITS.maxOperations + 1) }], 'work-limit'], [[deep], 'depth-limit'],
    [Array.from({ length: IMMUTABLE_SESSION_ROW_BYTES_LIMITS.maxRows + 1 }, () => first), 'row-limit']];
  for (const [input, reason] of cases) {
    const result = cache.measureFresh(input, { reconcile: true });
    assert.equal(result.serialized.complete, false); assert.equal(result.serialized.reason, reason); assert.equal(result.serialized.bytes, null);
    assert.equal(result.ownership, null); assert.deepEqual([...index], saved); assert.equal(cache.membershipRevision, revision);
  }
  assert.equal(getters, 0); assert.equal(traps, 0); assert.equal(Object.isFrozen(accessor), false); assert.equal(Object.isFrozen(deep), false);
});

test('combined measurement validates membership once and keeps serialized and ownership work allowances independent', () => {
  const cache = new ImmutableSessionRowBytesCache();
  const input = [{ text: 'x'.repeat(IMMUTABLE_SESSION_ROW_BYTES_LIMITS.maxOperations - 8) }];
  const descriptor = Object.getOwnPropertyDescriptor; let slotInspections = 0;
  Object.getOwnPropertyDescriptor = (target: unknown, key: PropertyKey) => {
    if (target === input && key === '0') slotInspections++;
    return descriptor(target, key);
  };
  try {
    const result = cache.measureFresh(input, { reconcile: true });
    assert.equal(result.serialized.complete, true); assert.equal(result.ownership?.complete, true);
    assert.equal(result.serialized.operations, IMMUTABLE_SESSION_ROW_BYTES_LIMITS.maxOperations);
    assert.equal(result.ownershipOperations, 1);
    assert.ok(result.serialized.operations + result.ownershipOperations > IMMUTABLE_SESSION_ROW_BYTES_LIMITS.maxOperations);
    assert.equal(result.serialized.bytes, exact(input)); assert.equal(slotInspections, 1); assert.equal(cache.count, 0);
  } finally { Object.getOwnPropertyDescriptor = descriptor; }
});
