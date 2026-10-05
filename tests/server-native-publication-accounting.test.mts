import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { attachStateStream, boundedJsonUtf8Bytes, createLocalServer } from '../src/server/http.mts';
import { HistoryStore } from '../src/server/history.mts';
import { QuotaLedger } from '../src/core/quota.mts';
import type { StateStreamResponse } from '../src/server/http-contracts.mts';
import type { ProcessMemoryReservation } from '../src/server/process-memory.mts';

const maximum = 16 * 1024 * 1024;
function graph() {
  const book = { instrumentId: 'hyperliquid:BTC-PERP', bids: [[100, 3], [99, 4]], asks: [[101, 2]],
    levelMetadata: { bids: { '100': { count: 3, source: 'native' } }, asks: {} }, complete: true, sequence: 42 };
  return { books: { 'hyperliquid:BTC-PERP': book }, booksByKey: { 'hyperliquid:BTC-PERP|native': book },
    markets: [{ id: 'hyperliquid:BTC-PERP', venue: 'hyperliquid', metadata: { unit: 'base' } }],
    candles: { btc: Array.from({ length: 500 }, (_, index) => ({ start: 1800000000000 + index * 60000, open: 100, close: 101.5, quality: 'native' })) },
    oi: Array.from({ length: 1000 }, (_, index) => ({ instrumentId: 'hyperliquid:BTC-PERP', base: 100 + index, sourceTimestamp: 1800000000000 + index })) };
}
function check(value: unknown) {
  const text = JSON.stringify(value), bytes = Buffer.byteLength(text);
  assert.equal(boundedJsonUtf8Bytes(value, bytes), bytes);
  assert.equal(boundedJsonUtf8Bytes(value, bytes - 1), null);
}

test('native complete publication preflight preserves repeated books, metadata and exact JSON boundaries', () => {
  const value = graph(); check(value);
  assert.equal(value.books['hyperliquid:BTC-PERP'], value.booksByKey['hyperliquid:BTC-PERP|native']);
  const copied = JSON.parse(JSON.stringify(value)) as typeof value;
  assert.deepEqual(copied.books, value.books); assert.deepEqual(copied.booksByKey, value.booksByKey);
  assert.equal(boundedJsonUtf8Bytes(value, maximum), boundedJsonUtf8Bytes(copied, maximum));
});

test('number formatting and all escaping classes match native JSON without clipping', () => {
  check([0, -0, NaN, Infinity, -Infinity, 1e-7, 1e-6, 1e20, 1e21, Number.MAX_VALUE, Number.MIN_VALUE,
    Number.MAX_SAFE_INTEGER, -Number.EPSILON, true, false, null, undefined]);
  for (let code = 0; code < 256; code++) check({ [String.fromCharCode(code)]: String.fromCharCode(code) });
  for (const text of ['\u6f22\u5b57', '\ud83d\ude00', '\ud800', '\udfff', '\ud800x\udfff', '\u2028\u2029', '"\\\n\r\t\b\f', 'ascii-native']) check({ text });
  check([undefined, () => 0, Symbol('ignored')]);
  check({ omitted: undefined, ignored: () => 0, symbol: Symbol('ignored'), retained: 2 });
  assert.equal(boundedJsonUtf8Bytes({ bad: 1n }, maximum), null);
  const cycle: { self?: unknown } = {}; cycle.self = cycle;
  assert.equal(boundedJsonUtf8Bytes(cycle, maximum), null);
  let calls = 0; assert.equal(boundedJsonUtf8Bytes({ toJSON() { calls++; return {}; } }, maximum), null); assert.equal(calls, 0);
});

test('native ASCII publication avoids per-number stringify and per-character JavaScript scans', () => {
  const value = graph(), expected = Buffer.byteLength(JSON.stringify(value));
  const stringify = JSON.stringify, charCodeAt = String.prototype.charCodeAt;
  let jsonCalls = 0, characterReads = 0;
  JSON.stringify = (value: unknown) => { jsonCalls++; return stringify(value); };
  String.prototype.charCodeAt = function (index: number) { characterReads++; return charCodeAt.call(this, index); };
  try { assert.equal(boundedJsonUtf8Bytes(value, maximum), expected); }
  finally { JSON.stringify = stringify; String.prototype.charCodeAt = charCodeAt; }
  assert.equal(jsonCalls, 0); assert.equal(characterReads, 0);
});
function fields(value: unknown): Record<string, unknown> {
  assert.ok(value && typeof value === 'object' && !Array.isArray(value)); return value as Record<string, unknown>;
}

class Response extends EventEmitter implements StateStreamResponse {
  writableEnded = false; blocked = false; chunks: string[] = []; callbacks: (() => unknown)[] = [];
  writeHead(_status: number, _headers: Record<string, string>) {}
  write(chunk: string, callback?: () => unknown) { this.chunks.push(chunk); if (this.blocked && callback) this.callbacks.push(callback); else callback?.(); return !this.blocked; }
  end() { this.writableEnded = true; for (const callback of this.callbacks.splice(0)) callback(); }
  drain() { this.blocked = false; for (const callback of this.callbacks.splice(0)) callback(); this.emit('drain'); }
}
