import test from 'node:test';
import assert from 'node:assert/strict';
import { measureLiquidityWireBytes, liquidityWireGrowthHint, liquidityWireSessionId, LIQUIDITY_WIRE_MEASUREMENT_LIMITS } from '../src/server/liquidity-wire-bound.mts';

function exact(payload: object): void {
  const text = JSON.stringify(payload), result = measureLiquidityWireBytes(payload);
  assert.equal(result.complete, true, result.reason ?? 'failed');
  assert.equal(result.utf8Bytes, Buffer.byteLength(text, 'utf8')); assert.equal(result.utf16Bytes, 2 * text.length);
  assert.equal(result.requiredBytes, Math.max(Buffer.byteLength(text, 'utf8'), 2 * text.length));
}
test('native DTO dual measurement is exact for ASCII, Unicode, escapes and shared occurrences', () => {
  for (const text of ['ascii', '€漢字', '😀', '\ud800', '\udfff', '\ud800\udfff', '\u0000\n\r\t"\\']) exact({ text });
  const shared = [{ amount: 1e30, zero: -0, negative: -1e-7, optional: undefined }];
  const payload = { shared, alias: shared, null: null, yes: true, no: false, array: [undefined, 2, null], missing: undefined };
  exact(payload); assert.equal(Object.isFrozen(shared), false);
});
test('inspection rejects getters, hooks, proxies, cycles, prototypes and sparse arrays without executing code', () => {
  let hits = 0;
  const getter = {}; Object.defineProperty(getter, 'payload', { enumerable: true, get() { hits++; return 'bad'; } });
  const hook = { toJSON() { hits++; return {}; } };
  const proxy = new Proxy({}, { getPrototypeOf() { hits++; return Object.prototype; }, ownKeys() { hits++; return []; } });
  const cycle: { self?: unknown } = {}; cycle.self = cycle;
  for (const payload of [getter, hook, proxy, cycle, { nested: new Date() }, { items: new Array(2) }, { value: 1n }, { value: Number.NaN }]) {
    const result = measureLiquidityWireBytes(payload); assert.equal(result.complete, false); assert.equal(result.requiredBytes, null);
  }
  assert.equal(hits, 0); assert.equal(liquidityWireSessionId(proxy), null); assert.equal(hits, 0);
  const session = {}; Object.defineProperty(session, 'sessionId', { get() { hits++; return 'bad'; } });
  assert.equal(liquidityWireSessionId(session), null); assert.equal(hits, 0);
});
test('fixed depth/operation/byte limits fail closed and smaller work limits never relax the authority', () => {
  const deep: { nested?: unknown } = {}; let current = deep;
  for (let index = 0; index <= LIQUIDITY_WIRE_MEASUREMENT_LIMITS.maxDepth; index++) { const next = {}; current.nested = next; current = next; }
  assert.equal(measureLiquidityWireBytes(deep).reason, 'depth-limit');
  assert.equal(measureLiquidityWireBytes({ rows: Array.from({ length: 100 }, (_, i) => i) }, { maxOperations: 10 }).reason, 'work-limit');
  assert.equal(measureLiquidityWireBytes({}, { maxOperations: LIQUIDITY_WIRE_MEASUREMENT_LIMITS.maxOperations + 1 }).reason, 'invalid-json');
  assert.equal(measureLiquidityWireBytes({ text: 'x'.repeat(LIQUIDITY_WIRE_MEASUREMENT_LIMITS.maxUtf8Bytes) }).reason, 'size-limit');
  for (const maximum of [4096, 5000, 1048576, 4194304]) {
    const hint = liquidityWireGrowthHint(maximum); assert.ok(Number.isSafeInteger(hint) && hint > maximum);
    assert.equal(Math.log2(hint), Math.trunc(Math.log2(hint)));
  }
});
