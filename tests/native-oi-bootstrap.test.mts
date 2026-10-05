import test from 'node:test';
import assert from 'node:assert/strict';
import type { RuntimeOiSample } from '../src/domain/runtime-state.mts';
import { NATIVE_OI_BOOTSTRAP_PROJECTION,
  nativeOiBootstrapWorkingBytes, projectNativeOiBootstrap,
} from '../src/server/native-oi-bootstrap.mts';

function oi(id: string, time: number, receivedAt = time + 10): RuntimeOiSample {
  return { instrumentId: id, observationTimestamp: time, sourceTimestamp: time, receivedAt,
    base: time / 10, quote: time * 100, quality: 'native', provenance: { source: id } };
}
function project(input: readonly RuntimeOiSample[]) {
  return projectNativeOiBootstrap(input, { inputRows: input.length,
    reservedWorkingBytes: nativeOiBootstrapWorkingBytes(input.length) });
}

test('full live input remains unchanged while bootstrap borrows latest exact rows and provenance', () => {
  const rows = Array.from({ length: 757 }, (_, index) => oi(index % 2 ? 'b' : 'a', index + 1));
  const before = JSON.stringify(rows); const result = project(rows);
  assert.equal(result.complete, true, result.reason ?? undefined); assert.ok(result.rows);
  assert.deepEqual(result.rows, [rows[756], rows[755]]);
  assert.strictEqual(result.rows[0], rows[756]);
  assert.strictEqual(result.rows[0]!.provenance, rows[756]!.provenance);
  assert.equal(JSON.stringify(rows), before); assert.equal(rows.length, 757);
  assert.strictEqual(result.projection, NATIVE_OI_BOOTSTRAP_PROJECTION);
  assert.equal(result.projection!.historyComplete, false);
  assert.equal(result.projection!.omittedRowsAreRemovals, false);
  assert.equal(result.projection!.recovery, 'full-state-and-history-loader');
});

test('observation/source/receipt clocks and actual ties use existing native selection semantics', () => {
  const observed = { ...oi('a', 100), sourceTimestamp: 1000, receivedAt: 9000 };
  const source: RuntimeOiSample = { instrumentId: 'a', sourceTimestamp: 110, receivedAt: 150, base: 2 };
  const receipt: RuntimeOiSample = { instrumentId: 'b', sourceTimestamp: null, receivedAt: 120, base: 3 };
  const tie = { ...source, base: 4, receivedAt: 151 };
  const correction = { ...tie, base: 5, provenance: { corrected: true } };
  const result = project([observed, receipt, source, tie, correction]);
  assert.equal(result.complete, true); assert.deepEqual(result.rows, [correction, receipt]);
  assert.equal(Object.hasOwn(correction, 'observationTimestamp'), false);
  assert.equal(result.rows![1]!.sourceTimestamp, null);
});

test('persisted bars and aggregate points fail the whole projection without reinterpretation', () => {
  for (const field of ['start', 'end', 'interval', 'open', 'high', 'low', 'close',
    'quoteOpen', 'quoteHigh', 'quoteLow', 'quoteClose', 'sampleCount', 'samples']) {
    const bar = { ...oi('b', 200), [field]: field === 'interval' ? '1m' : 1 };
    const result = project([oi('a', 100), bar]);
    assert.equal(result.complete, false, field); assert.equal(result.rows, null);
    assert.match(result.reason!, /persisted-or-aggregate/);
  }
});

test('invalid identity, base, missing or invalid clocks deny the complete result', () => {
  const invalid: RuntimeOiSample[] = [
    { instrumentId: '', receivedAt: 1, base: 1 }, { instrumentId: 'a', base: 1 },
    { instrumentId: 'a', receivedAt: 0, base: 1 }, { instrumentId: 'a', receivedAt: Infinity, base: 1 },
    { instrumentId: 'a', receivedAt: 1, base: NaN }, { ...oi('a', 1), sourceTimestamp: -1 },
  ];
  for (const row of invalid) { const result = project([row]); assert.equal(result.complete, false); assert.equal(result.rows, null); }
});

test('insufficient numeric pregrant inspects no root proxy traps', () => {
  let traps = 0;
  const input = new Proxy([oi('a', 1)], { get() { traps++; throw new Error('trap'); },
    getPrototypeOf() { traps++; throw new Error('trap'); }, getOwnPropertyDescriptor() { traps++; throw new Error('trap'); } });
  const required = nativeOiBootstrapWorkingBytes(1);
  assert.equal(projectNativeOiBootstrap(input, { inputRows: 1, reservedWorkingBytes: required - 1 }).reason,
    'native-oi-bootstrap-pregrant-required');
  assert.equal(traps, 0);
  assert.equal(projectNativeOiBootstrap(input, { inputRows: 1, reservedWorkingBytes: required }).complete, false);
  assert.equal(traps, 0);
});

test('row proxies and accessors are rejected without executing traps or getters', () => {
  let reads = 0;
  const proxy = new Proxy(oi('a', 1), { get() { reads++; throw new Error('trap'); },
    ownKeys() { reads++; throw new Error('trap'); }, getPrototypeOf() { reads++; throw new Error('trap'); } });
  assert.equal(project([proxy]).complete, false);
  for (const field of ['base', 'receivedAt', 'sourcePayload']) {
    const row = oi('a', 1); Object.defineProperty(row, field, { enumerable: true, get() { reads++; throw new Error('getter'); } });
    assert.equal(project([row]).complete, false);
  }
  assert.equal(reads, 0);
});

test('missing/effectful array slots and stale counts fail before row selection', () => {
  let reads = 0; const rows = [oi('a', 1)];
  Object.defineProperty(rows, '0', { get() { reads++; throw new Error('getter'); } });
  assert.equal(project(rows).complete, false); assert.equal(reads, 0);
  const sparse = new Array<RuntimeOiSample>(1); assert.equal(project(sparse).complete, false);
  assert.equal(projectNativeOiBootstrap([oi('a', 1)], { inputRows: 0,
    reservedWorkingBytes: nativeOiBootstrapWorkingBytes(0) }).complete, false);
});

test('instrument and row-domain limits deny rather than dropping valid sources', () => {
  const input = Array.from({ length: 129 }, (_, index) => oi(`instrument-${index}`, index + 1));
  assert.equal(project(input).complete, false); assert.equal(input.length, 129);
  const row = oi('a', 1); for (let index = 0; index < 65; index++) row[`extra-${index}`] = index;
  assert.equal(project([row]).reason, 'native-oi-bootstrap-row-field-limit');
});

test('empty and frozen reducer arrays are valid partial current views', () => {
  const empty = project(Object.freeze([])); assert.equal(empty.complete, true); assert.deepEqual(empty.rows, []);
  const row = Object.freeze(oi('a', 1)); const rows = Object.freeze([row]); const result = project(rows);
  assert.equal(result.complete, true); assert.strictEqual(result.rows![0], row); assert.notStrictEqual(result.rows, rows);
});
