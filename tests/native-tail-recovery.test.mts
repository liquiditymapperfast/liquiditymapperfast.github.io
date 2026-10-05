import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import type { RuntimeCandle, RuntimeOiSample } from '../src/domain/runtime-state.mts';
import type { StateStreamResponse } from '../src/server/http-contracts.mts';
import type { ProcessMemoryReservation } from '../src/server/process-memory.mts';
import { createLocalServer, attachStateStream } from '../src/server/http.mts';
import { HistoryStore } from '../src/server/history.mts';
import { QuotaLedger } from '../src/core/quota.mts';
import { advanceNativeTailRecovery, candleOutsideNativeTail, oiOutsideNativeTail,
  nativeTailRecoveryRevision, nativeTailBaselineMatches } from '../src/server/native-tail-recovery.mts';

const id = 'hyperliquid:BTC-PERP', at = 1_800_000_000_000, MiB = 1024 * 1024;
function candle(index: number): RuntimeCandle {
  return { instrumentId: id, interval: '1m', start: at + index * 60_000, end: at + (index + 1) * 60_000,
    open: 100, high: 110, low: 90, close: 101, source: 'live', sourceTimestamp: at + (index + 1) * 60_000,
    receivedAt: at + (index + 1) * 60_000, closed: true };
}
function oi(time: number): RuntimeOiSample { return { instrumentId: id, base: 10, observationTimestamp: time, sourceTimestamp: time, receivedAt: time + 1 }; }
class Response extends EventEmitter implements StateStreamResponse {
  writableEnded = false; blocked = false; throwWrites = false; chunks: string[] = []; callbacks: (() => unknown)[] = [];
  writeHead() {}
  write(chunk: string, callback?: () => unknown) {
    if (this.throwWrites) throw new Error('write failed'); this.chunks.push(chunk);
    if (this.blocked && callback) this.callbacks.push(callback); else callback?.(); return !this.blocked;
  }
  end() { this.writableEnded = true; for (const callback of this.callbacks.splice(0)) callback(); }
  drain() { this.blocked = false; for (const callback of this.callbacks.splice(0)) callback(); this.emit('drain'); }
  count(event: string) { return this.chunks.filter(chunk => chunk.startsWith(`event: ${event}\n`)).length; }
}
function payload(revision: number | undefined = 0) {
  return { markSessionId: 's', oi: [oi(at), oi(at + 1)], candles: { [id]: [candle(0), candle(1), candle(2), candle(3)] },
    ...(revision === undefined ? {} : { tailRecoveryRevision: revision }) };
}

test('scalar recovery baseline defaults only missing revision to zero and fails closed on exhaustion', () => {
  assert.equal(nativeTailRecoveryRevision(undefined), 0); assert.equal(nativeTailBaselineMatches(undefined, undefined), true);
  for (const value of [null, -1, 1.2, NaN, Infinity, '0']) assert.equal(nativeTailRecoveryRevision(value), null);
  const state: { tailRecoveryRevision?: number } = {}; advanceNativeTailRecovery(state); assert.equal(state.tailRecoveryRevision, 1);
  state.tailRecoveryRevision = Number.MAX_SAFE_INTEGER; advanceNativeTailRecovery(state); assert.equal(state.tailRecoveryRevision, -1);
  assert.equal(nativeTailBaselineMatches(state.tailRecoveryRevision, state.tailRecoveryRevision), false);
});

test('candle detection covers older insertion/correction beyond three and far outside compact500 by exact interval', () => {
  const rows = Array.from({ length: 1000 }, (_, index) => candle(index));
  assert.equal(candleOutsideNativeTail(rows, candle(0)), true); assert.equal(candleOutsideNativeTail(rows, candle(996)), true);
  assert.equal(candleOutsideNativeTail(rows, candle(997)), false); assert.equal(candleOutsideNativeTail(rows, candle(1000)), false);
  assert.equal(candleOutsideNativeTail(rows, { ...candle(0), interval: '5m' }), false);
});

test('OI detection uses actual point event clocks rather than late receipts or instrument mixing', () => {
  const old = { ...oi(at), receivedAt: at + 999_999 }, current = oi(at + 1);
  assert.equal(oiOutsideNativeTail([current], old), true); assert.equal(oiOutsideNativeTail([old], current), false);
  assert.equal(oiOutsideNativeTail([current], { ...current, receivedAt: at + 99 }), false);
  assert.equal(oiOutsideNativeTail([{ ...current, instrumentId: 'other' }], old), false);
});
