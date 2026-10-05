import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { LatestOnlyFrameQueue, type StreamFrame } from '../src/server/realtime.mts';
import { attachStateStream, createLocalServer } from '../src/server/http.mts';
import { HistoryStore } from '../src/server/history.mts';
import { QuotaLedger } from '../src/core/quota.mts';
import type { StateStreamResponse } from '../src/server/http-contracts.mts';
import type { ProcessMemoryReservation } from '../src/server/process-memory.mts';

function controlledQueue() {
  let blocked = true;
  let resume: (() => void) | null = null;
  let cancelled = 0;
  const writes: StreamFrame[] = [];
  const queue = new LatestOnlyFrameQueue({
    write: frame => { writes.push(frame); return !blocked; },
    waitForDrain: next => { resume = next; return () => { resume = null; cancelled++; }; },
  });
  return { queue, writes, cancelled: () => cancelled, drain: () => { blocked = false; const next = resume; resume = null; next?.(); } };
}
function assertScalarParity(queue: LatestOnlyFrameQueue) {
  const fresh = queue.diagnostics();
  assert.equal(queue.maxPending, fresh.maxPending);
  assert.equal(queue.maxPendingSlots, fresh.maxPendingSlots);
}

test('scalar peak counters preserve diagnostic parity through three slots, replacement, drain and close', () => {
  const { queue, writes, drain } = controlledQueue();
  assertScalarParity(queue);
  queue.enqueue({ event: 'state', payload: { sequence: 1 } });
  assertScalarParity(queue);
  queue.enqueue({ event: 'state', payload: { sequence: 2 } });
  queue.enqueuePriority({ event: 'mark', payload: { sequence: 1 } });
  queue.enqueueLiquidity({ event: 'liquidity', payload: { sequence: 1 } });
  assert.equal(queue.maxPending, 1);
  assert.equal(queue.maxPendingSlots, 3);
  assertScalarParity(queue);
  queue.enqueue({ event: 'state', payload: { sequence: 3 } });
  queue.enqueuePriority({ event: 'mark', payload: { sequence: 2 } });
  queue.enqueueLiquidity({ event: 'liquidity', payload: { sequence: 2 } });
  assert.equal(queue.diagnostics().replacements, 3);
  assertScalarParity(queue);
  drain();
  assert.deepEqual(writes.map(frame => [frame.event, frame.payload]), [
    ['state', { sequence: 1 }], ['mark', { sequence: 2 }], ['liquidity', { sequence: 2 }], ['state', { sequence: 3 }],
  ]);
  assert.equal(queue.diagnostics().pendingSlots, 0);
  assertScalarParity(queue);
  queue.close();
  assert.equal(queue.diagnostics().closed, true);
  assert.equal(queue.diagnostics().pendingLogicalBytes, 0);
  assert.equal(queue.maxPendingSlots, 3, 'peak history survives retirement');
  assertScalarParity(queue);
});

test('scalar metric reads never call byte diagnostics; pending aliases and Unicode mutations still measure fresh', () => {
  const { queue } = controlledQueue();
  const provenance = { name: 'native', unknownClock: null };
  const sourceBook = { levels: [{ price: 100, amount: 2, provenance }], provenance };
  queue.enqueue({ event: 'state', payload: { sequence: 1 } });
  queue.enqueueLiquidity({ event: 'liquidity', payload: { books: { native: sourceBook }, booksByKey: { 'native|full': sourceBook } } });
  const canonical = queue.diagnostics.bind(queue);
  let byteReads = 0;
  queue.diagnostics = () => { byteReads++; return canonical(); };
  for (let index = 0; index < 100; index++) {
    assert.equal(queue.maxPending, 1);
    assert.equal(queue.maxPendingSlots, 1);
  }
  assert.equal(byteReads, 0);
  const before = queue.diagnostics().pendingLogicalBytes;
  provenance.name = 'native 漢字 🧭 \\ "\n'.repeat(1024);
  const after = queue.diagnostics().pendingLogicalBytes;
  assert.ok(after > before + 1024, 'fresh retained accounting sees in-place growth through both actual aliases');
  assert.equal(byteReads, 2);
  assertScalarParity(queue);
  queue.close();
  assert.equal(queue.diagnostics().pendingLogicalBytes, 0);
});

test('scalar maxima avoid payload hooks while explicit byte diagnostics preserve canonical failures', () => {
  const { queue, cancelled } = controlledQueue();
  queue.enqueue({ event: 'state', payload: {} });
  let hooks = 0;
  const metadata = Object.defineProperty({}, 'source', { enumerable: true, get: () => { hooks++; throw new Error('unavailable source'); } });
  queue.enqueue({ event: 'state', payload: { metadata } });
  assert.equal(queue.maxPending, 1);
  assert.equal(queue.maxPendingSlots, 1);
  assert.equal(hooks, 0, 'scalar metrics do not inspect pending metadata');
  assert.throws(() => queue.diagnostics(), /unavailable source/);
  assert.equal(hooks, 1, 'the existing byte diagnostic still visits the actual pending root');
  queue.close();
  assert.equal(cancelled(), 1);
  assert.equal(queue.diagnostics().pendingLogicalBytes, 0);
  assert.equal(hooks, 1);
  assertScalarParity(queue);
});

class Response extends EventEmitter implements StateStreamResponse {
  writableEnded = false;
  blocked = true;
  chunks: string[] = [];
  callbacks: (() => unknown)[] = [];
  writeHead() {}
  write(chunk: string, callback?: () => unknown) {
    this.chunks.push(chunk);
    if (this.blocked && callback) this.callbacks.push(callback); else callback?.();
    return !this.blocked;
  }
  end() { this.writableEnded = true; this.flush(); }
  flush() { for (const callback of this.callbacks.splice(0)) callback(); }
  drain() { this.blocked = false; this.flush(); this.emit('drain'); }
}
