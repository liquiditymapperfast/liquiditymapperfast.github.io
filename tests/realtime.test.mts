import type { ProcessMemoryReservation } from '../src/server/process-memory.mts';
import type { StateStreamResponse, ServerQueue } from '../src/server/http-contracts.mts';
import { defined, fields, list, numeric, textValue, fieldMap, injectMapFixture, injectArrayFixture } from './server-test-helpers.mts';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { EventEmitter } from 'node:events';
import { LatestOnlyFrameQueue } from '../src/server/realtime.mts';
import { attachStateStream, createLocalServer } from '../src/server/http.mts';
import { QuotaLedger } from '../src/core/quota.mts';
import { HistoryStore } from '../src/server/history.mts';
import { } from '../src/core/liquidity-frame.mts';

interface TestFrame { event: string; payload: { [key: string]: unknown; sequence?: number; markSessionId?: string; sessionId?: string; crossings?: { levelId: string }[] } }

function controllableTransport({ blocked = true } = {}) {
  let isBlocked = blocked;
  let drainHandler: (() => void) | null = null;
  const writes: TestFrame[] = [];
  return {
    writes,
    write(frame: TestFrame) {
      writes.push(frame);
      return !isBlocked;
    },
    waitForDrain(resume: () => void) {
      drainHandler = resume;
      return () => { if (drainHandler === resume) drainHandler = null; };
    },
    block() { isBlocked = true; },
    drain() {
      isBlocked = false;
      const resume = drainHandler;
      drainHandler = null;
      resume?.();
    },
  };
}

function queueFor(transport: ReturnType<typeof controllableTransport>, writes: TestFrame[] = []) {
  return new LatestOnlyFrameQueue<TestFrame>({
    write: (frame) => {
      writes.push(frame);
      return transport.write(frame);
    },
    waitForDrain: (resume) => transport.waitForDrain(resume),
  });
}

async function waitFor(predicate: () => unknown, timeoutMs = 1_000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('timed out waiting for predicate');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

test('priority mark slot precedes a pending state and merges bounded crossings', () => {
  const transport = controllableTransport();
  const writes: TestFrame[] = [];
  const queue = new LatestOnlyFrameQueue<TestFrame>({
    write: (frame) => { writes.push(frame); return transport.write(frame); },
    waitForDrain: (resume) => transport.waitForDrain(resume),
  });
  queue.enqueue({ event: 'state', payload: { sequence: 1 } });
  queue.enqueuePriority({ event: 'mark', payload: { sequence: 1, crossings: [{ levelId: 'a' }] } });
  queue.enqueuePriority({ event: 'mark', payload: { sequence: 2, crossings: [{ levelId: 'b' }] } }, (previous, next) => ({ ...next, payload: { ...next.payload, crossings: [...defined(previous.payload.crossings), ...defined(next.payload.crossings)] } }));
  queue.enqueue({ event: 'state', payload: { sequence: 2 } });
  assert.equal(queue.diagnostics().pendingSlots, 2);
  assert.equal(queue.diagnostics().maxPendingSlots, 2);
  transport.drain();
  assert.deepEqual(writes.map((frame) => frame.event), ['state', 'mark', 'state']);
  assert.deepEqual(defined(writes[1].payload.crossings).map((crossing: unknown) => fields(crossing).levelId), ['a', 'b']);
});

test('queue can invalidate obsolete continuity frames before a priority mark', () => {
  const transport = controllableTransport();
  const writes: TestFrame[] = [];
  const queue = new LatestOnlyFrameQueue<TestFrame>({
    write: (frame) => { writes.push(frame); return transport.write(frame); },
    waitForDrain: (resume) => transport.waitForDrain(resume),
  });
  queue.enqueue({ event: 'state', payload: { markSessionId: 'old', markSequence: 9 } });
  queue.enqueue({ event: 'state', payload: { markSessionId: 'old', markSequence: 10 } });
  queue.enqueuePriority({ event: 'mark', payload: { sessionId: 'new', sequence: 1, markInstrumentId: 'hyperliquid:BTC-PERP', markPrice: 100, crossings: [] } });
  assert.equal(queue.invalidatePending((frame) => frame.event === 'state' && fields(frame.payload).markSessionId !== 'new'), 1);
  transport.drain();
  assert.deepEqual(writes.map((frame) => frame.event), ['state', 'mark']);
  assert.equal(defined(writes.at(-1)).payload.sessionId, 'new');
  assert.equal(queue.pending, null);
});

test('latest-only production frame queue retains one pending state through repeated drain cycles', () => {
  const slow = controllableTransport();
  const slowWrites: TestFrame[] = [];
  const queue = queueFor(slow, slowWrites);
  queue.enqueue({ event: 'state', payload: { sequence: 1 } });
  queue.enqueue({ event: 'state', payload: { sequence: 2 } });
  queue.enqueue({ event: 'state', payload: { sequence: 3 } });
  assert.deepEqual(slowWrites.map((frame) => frame.payload.sequence), [1]);
  assert.equal(defined(queue.pending).payload.sequence, 3);
  assert.equal(queue.diagnostics().maxPending, 1);
  assert.equal(queue.diagnostics().replacements, 1);

  slow.drain();
  assert.deepEqual(slowWrites.map((frame) => frame.payload.sequence), [1, 3]);

  slow.block();
  queue.enqueue({ event: 'state', payload: { sequence: 4 } });
  queue.enqueue({ event: 'state', payload: { sequence: 5 } });
  queue.enqueue({ event: 'state', payload: { sequence: 6 } });
  assert.deepEqual(slowWrites.map((frame) => frame.payload.sequence), [1, 3, 4]);
  slow.drain();
  assert.deepEqual(slowWrites.map((frame) => frame.payload.sequence), [1, 3, 4, 6]);

  slow.block();
  queue.enqueue({ event: 'state', payload: { sequence: 7 } });
  queue.enqueue({ event: 'state', payload: { sequence: 8 } });
  queue.enqueue({ event: 'state', payload: { sequence: 9 } });
  queue.close();
  slow.drain();
  assert.deepEqual(slowWrites.map((frame) => frame.payload.sequence), [1, 3, 4, 6, 7]);
  assert.equal(queue.pending, null);
  assert.equal(queue.closed, true);
  assert.equal(queue.diagnostics().waiting, false);
  assert.ok(queue.diagnostics().drainWaits >= 3);
  assert.ok(queue.diagnostics().sent >= 4);
  assert.ok(queue.diagnostics().replacements >= 3);
});

test('a fast client is independent from a blocked client queue', () => {
  const slow = controllableTransport();
  const fast = controllableTransport({ blocked: false });
  const slowQueue = queueFor(slow);
  const fastQueue = queueFor(fast);
  for (let sequence = 1; sequence <= 4; sequence += 1) {
    const frame = { event: 'state', payload: { sequence } };
    slowQueue.enqueue(frame);
    fastQueue.enqueue(frame);
  }
  assert.deepEqual(fast.writes.map((frame) => frame.payload.sequence), [1, 2, 3, 4]);
  assert.deepEqual(slow.writes.map((frame) => frame.payload.sequence), [1]);
  slow.drain();
  assert.deepEqual(slow.writes.map((frame) => frame.payload.sequence), [1, 4]);
});

test('backpressure never drops required depth mutations from RAM', () => {
  const app = createLocalServer({ quota: new QuotaLedger(), history: new HistoryStore({ filePath: ':memory:' }) });
  try {
    app.applyMessage({
      kind: 'depthSnapshot', instrumentId: 'hyperliquid:BTC-PERP', sequence: 1, sourceTimestamp: 1, receivedAt: 1,
      complete: true, bids: [{ price: 100, amount: 1 }], asks: [{ price: 101, amount: 1 }],
    }, 'hyperliquid');
    for (let sequence = 2; sequence <= 20; sequence += 1) {
      app.applyMessage({
        kind: 'depthDelta', instrumentId: 'hyperliquid:BTC-PERP', sequence, previousSequence: sequence - 1,
        sourceTimestamp: sequence, receivedAt: sequence, bids: [{ price: 100, amount: sequence }], asks: [],
      }, 'hyperliquid');
    }
    const book = app.state.books['hyperliquid:BTC-PERP'];
    assert.equal(book.sequence, 20);
    assert.deepEqual(book.bids, [[100, 20]]);
    assert.equal(app.metrics.appliedMessages, 20);
  } finally {
    app.close();
  }
});

test('SSE retained diagnostics track pending payload growth and clear after drain', () => {
  const transport = controllableTransport();
  const queue = queueFor(transport);
  assert.equal(queue.diagnostics().pendingLogicalBytes, 0);
  queue.enqueue({ event: 'state', payload: { sequence: 1 } });
  queue.enqueue({ event: 'state', payload: { blob: '€'.repeat(2_048) } });
  const large = queue.diagnostics().pendingLogicalBytes;
  assert.ok(large > 2_000);
  queue.enqueue({ event: 'state', payload: { blob: 'small' } });
  assert.ok(queue.diagnostics().pendingLogicalBytes < large);
  transport.drain();
  assert.equal(queue.diagnostics().pendingLogicalBytes, 0);
  queue.close();
});

test('SSE retained diagnostics include a backpressured frame until transport drain', () => {
  const transport = controllableTransport({ blocked: true });
  const queue = queueFor(transport);
  queue.enqueue({ event: 'state', payload: { blob: 'x'.repeat(2_048) } });
  const blockedBytes = queue.diagnostics().transportBufferedLogicalBytes;
  assert.ok(blockedBytes > 2_000);
  assert.equal(queue.diagnostics().pendingLogicalBytes, blockedBytes);
  queue.enqueue({ event: 'state', payload: { blob: 'latest' } });
  assert.ok(queue.diagnostics().pendingLogicalBytes > blockedBytes);
  transport.drain();
  assert.equal(queue.diagnostics().transportBufferedLogicalBytes, 0);
  assert.equal(queue.diagnostics().pendingLogicalBytes, 0);
  queue.close();
});
