import { smokeRecord, smokeRequired } from '../scripts/smoke-boundaries.mts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import {
  boundWebSocketOpen,
  createSingleFrameGapInjector,
  evaluateBinanceUsdMGapRecovery,
  evaluateBinanceSpotGapRecovery,
  fetchPublicJson,
  normalizeBinanceSpotGapSmokeTimeout,
  parseBinanceUsdMDepthFrame,
  parseBinanceSpotDepthFrame,
} from '../scripts/binance-spot-live-gap-recovery-smoke.mts';

function frame(overrides = {}) {
  return Buffer.from(JSON.stringify({ e: 'depthUpdate', s: 'BTCUSDT', U: 10, u: 12, b: [['100', '2']], a: [], ...overrides }));
}

function usdMFrame(overrides = {}) {
  return Buffer.from(JSON.stringify({ e: 'depthUpdate', s: 'BTCUSDT', U: 10, pu: 9, u: 12, st: 1, ps: 'BTCUSDT', b: [['100', '2']], a: [], ...overrides }));
}

test('Binance Spot smoke extracts only safe BTCUSDT U/u sequence fields', () => {
  assert.deepEqual(parseBinanceSpotDepthFrame(frame()), { symbol: 'BTCUSDT', firstUpdate: 10, finalUpdate: 12 });
  assert.equal(parseBinanceSpotDepthFrame(frame({ s: 'ETHUSDT' })), null);
  assert.equal(parseBinanceSpotDepthFrame(frame({ e: 'aggTrade' })), null);
  assert.equal(parseBinanceSpotDepthFrame(frame({ U: Number.MAX_SAFE_INTEGER + 1 })), null);
  assert.equal(parseBinanceSpotDepthFrame(Buffer.from('not json')), null);
});

test('Binance USD-M smoke requires pu and filters known non-USD-M depth frames', () => {
  assert.deepEqual(parseBinanceUsdMDepthFrame(usdMFrame()), { symbol: 'BTCUSDT', firstUpdate: 10, finalUpdate: 12, previousSequence: 9 });
  assert.equal(parseBinanceUsdMDepthFrame(usdMFrame({ pu: undefined })), null);
  assert.equal(parseBinanceUsdMDepthFrame(usdMFrame({ pu: Number.MAX_SAFE_INTEGER + 1 })), null);
  assert.equal(parseBinanceUsdMDepthFrame(usdMFrame({ st: 2 })), null);
  assert.equal(parseBinanceUsdMDepthFrame(usdMFrame({ ps: 'BTCUSD' })), null);
  assert.equal(parseBinanceUsdMDepthFrame(usdMFrame({ s: 'ETHUSDT' })), null);
});

test('smoke timeout normalization remains finite and caps caller-provided values', () => {
  assert.equal(normalizeBinanceSpotGapSmokeTimeout(Number.POSITIVE_INFINITY), 30_000);
  assert.equal(normalizeBinanceSpotGapSmokeTimeout(Number.NaN), 30_000);
  assert.equal(normalizeBinanceSpotGapSmokeTimeout(120_001), 120_000);
  assert.equal(normalizeBinanceSpotGapSmokeTimeout(125.9), 125);
});

test('smoke cancels a pending WebSocket open at its deadline', async () => {
  class PendingSocket extends EventEmitter { readyState = 0; terminated = false; terminate() { this.terminated = true; this.readyState = 3; this.emit('close'); } }
  const socket = new PendingSocket();
  const transport = boundWebSocketOpen({ socket, close() {} }, Date.now() + 20);
  await assert.rejects(Promise.resolve(smokeRequired(transport.open)()), /Smoke operation deadline exceeded/);
  assert.equal(socket.terminated, true);
  assert.equal(socket.listenerCount('open'), 0);
  assert.equal(socket.listenerCount('error'), 0);
  assert.equal(socket.listenerCount('close'), 0);
});

test('public REST fetch abort is capped at the operation deadline', async () => {
  const originalFetch = globalThis.fetch;
  const keepAliveTimer = setTimeout(() => {}, 60);
  const received: { signal: AbortSignal | null } = { signal: null };
  globalThis.fetch = (_url, init) => new Promise<Response>((_, reject) => {
    const signal = smokeRequired(init?.signal);
    received.signal = signal;
    signal.addEventListener('abort', () => reject(signal.reason), { once: true });
  });
  try {
    await assert.rejects(
      fetchPublicJson({ url: 'https://api.binance.com/api/v3/depth' }, 8_000, Date.now() + 25),
      error => smokeRecord(error).name === 'TimeoutError',
    );
    assert.equal(received.signal?.aborted, true);
  } finally {
    clearTimeout(keepAliveTimer);
    globalThis.fetch = originalFetch;
  }
});

test('single-frame gap injector waits for arming and withholds at most one matching frame', () => {
  const injector = createSingleFrameGapInjector();
  assert.equal(injector.inspect(frame({ U: 10, u: 12 })).deliveries.length, 1);
  injector.arm();
  assert.equal(injector.inspect(frame({ U: 13, u: 15 })).heldCandidate, true);
  const dropped = injector.inspect(frame({ U: 16, u: 17 }));
  assert.equal(dropped.dropped, true);
  assert.equal(dropped.deliveries.length, 1);
  assert.deepEqual(injector.snapshot(), {
    armed: false,
    dropCount: 1,
    droppedFrame: { symbol: 'BTCUSDT', firstUpdate: 13, finalUpdate: 15, wireOrdinal: 2 },
    precedingForwardedFrame: { symbol: 'BTCUSDT', firstUpdate: 10, finalUpdate: 12, wireOrdinal: 1 },
    firstWireFrameAfterDrop: { symbol: 'BTCUSDT', firstUpdate: 16, finalUpdate: 17, wireOrdinal: 3 },
    pendingCandidate: false,
  });
});

test('USD-M gap injector drops only a frame whose successor pu proves the exact missing update', () => {
  const injector = createSingleFrameGapInjector({ marketType: 'perpetual' });
  assert.equal(injector.inspect(usdMFrame({ U: 10, pu: 9, u: 12 })).deliveries.length, 1);
  injector.arm();
  assert.equal(injector.inspect(usdMFrame({ U: 13, pu: 12, u: 15 })).heldCandidate, true);
  const dropped = injector.inspect(usdMFrame({ U: 16, pu: 15, u: 17 }));
  assert.equal(dropped.dropped, true);
  assert.deepEqual(injector.snapshot().droppedFrame, { symbol: 'BTCUSDT', firstUpdate: 13, finalUpdate: 15, previousSequence: 12, wireOrdinal: 2 });
  assert.deepEqual(injector.snapshot().firstWireFrameAfterDrop, { symbol: 'BTCUSDT', firstUpdate: 16, finalUpdate: 17, previousSequence: 15, wireOrdinal: 3 });
});

test('smoke verdict ties manager invalidation to the locally withheld source frame and recovery', () => {
  const evidence = {
    elapsedMs: 1_000,
    totalTimeoutMs: 30_000,
    managerStartCompleted: true,
    connection: { opened: true, closed: true },
    initialSnapshot: { sequence: 100, bidLevels: 5, askLevels: 5 },
    parsedDeltasBeforeDrop: 8,
    managerDeltaBeforeDrop: { sequence: 105, wireOrdinal: 10 },
    dropper: {
      dropCount: 1,
      pendingCandidate: false,
      precedingForwardedFrame: { firstUpdate: 100, finalUpdate: 105, wireOrdinal: 10 },
      droppedFrame: { firstUpdate: 106, finalUpdate: 110, wireOrdinal: 11 },
      firstWireFrameAfterDrop: { firstUpdate: 111, finalUpdate: 115, wireOrdinal: 12 },
    },
    postDropWireFrame: { firstUpdate: 111, finalUpdate: 115, wireOrdinal: 12 },
    sequenceGapObserved: true,
    managerGap: { expectedSequence: 105, receivedPreviousSequence: 110, triggerWireOrdinal: 12 },
    depthRestAttempts: 2,
    depthRestCallsAfterInitial: 1,
    recoverySnapshot: { sequence: 120 },
    recoveredDelta: { sequence: 121 },
    recoveryWaitCompleted: true,
    finalFeedState: 'live',
  };
  assert.equal(evaluateBinanceSpotGapRecovery(evidence).passed, true);
  assert.equal(evaluateBinanceSpotGapRecovery({ ...evidence, dropper: { ...evidence.dropper, dropCount: 2 } }).passed, false);
  assert.equal(evaluateBinanceSpotGapRecovery({ ...evidence, managerGap: { ...evidence.managerGap, receivedPreviousSequence: 105 } }).passed, false);
  assert.equal(evaluateBinanceSpotGapRecovery({ ...evidence, recoveredDelta: null }).passed, false);
  assert.equal(evaluateBinanceSpotGapRecovery({ ...evidence, depthRestAttempts: 4 }).passed, false);
});

test('USD-M recovery verdict ties pu discontinuity to the dropped live frame', () => {
  const evidence = {
    marketType: 'perpetual',
    elapsedMs: 1_000,
    totalTimeoutMs: 30_000,
    managerStartCompleted: true,
    connection: { opened: true, closed: true },
    initialSnapshot: { sequence: 100, bidLevels: 5, askLevels: 5 },
    parsedDeltasBeforeDrop: 8,
    managerDeltaBeforeDrop: { sequence: 105, wireOrdinal: 10 },
    dropper: {
      dropCount: 1,
      pendingCandidate: false,
      precedingForwardedFrame: { firstUpdate: 103, finalUpdate: 105, previousSequence: 100, wireOrdinal: 10 },
      droppedFrame: { firstUpdate: 106, finalUpdate: 110, previousSequence: 105, wireOrdinal: 11 },
      firstWireFrameAfterDrop: { firstUpdate: 111, finalUpdate: 115, previousSequence: 110, wireOrdinal: 12 },
    },
    postDropWireFrame: { firstUpdate: 111, finalUpdate: 115, previousSequence: 110, wireOrdinal: 12 },
    sequenceGapObserved: true,
    managerGap: { expectedSequence: 105, receivedPreviousSequence: 110, triggerWireOrdinal: 12 },
    depthRestAttempts: 2,
    depthRestCallsAfterInitial: 1,
    recoverySnapshot: { sequence: 120 },
    recoveredDelta: { sequence: 121 },
    recoveryWaitCompleted: true,
    finalFeedState: 'live',
  };
  assert.equal(evaluateBinanceUsdMGapRecovery(evidence).passed, true);
  assert.equal(evaluateBinanceUsdMGapRecovery({ ...evidence, postDropWireFrame: { ...evidence.postDropWireFrame, previousSequence: 105 } }).passed, false);
  assert.equal(evaluateBinanceUsdMGapRecovery({ ...evidence, managerGap: { ...evidence.managerGap, receivedPreviousSequence: 105 } }).passed, false);
});
