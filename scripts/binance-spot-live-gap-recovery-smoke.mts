#!/usr/bin/env node
import { smokeRecord, smokeArray, smokeRequired, smokeFrameText } from './smoke-boundaries.mts';
import type { LiveFeedSocket, LiveFeedTransportOptions } from '../src/server/live-feeds.mts';
import type { ExchangeRestRequest } from '../src/server/rest-transport.mts';
export interface BinanceWireFrame { symbol: string; firstUpdate: number; finalUpdate: number; previousSequence?: number }
interface ObservedBinanceWireFrame extends BinanceWireFrame { wireOrdinal: number }
interface GapCandidate { raw: unknown; frame: ObservedBinanceWireFrame }
export interface SmokeSocketLifecycle { readyState: number; once: (event: string, listener: (...args: unknown[]) => void) => unknown; removeListener: (event: string, listener: (...args: unknown[]) => void) => unknown; terminate?: () => unknown }
interface BinanceDepthSummary { sequence: number | null; bidLevels: number; askLevels: number; receivedAt: string }
interface BinanceDeltaSummary { firstUpdate?: number | null; previousSequence?: number | null; sequence: number | null; wireOrdinal?: number | null; receivedAt?: string }
interface BinanceGapState {
  startedAt: string; symbol: string; marketType: 'spot' | 'perpetual';
  connection: { endpoint: unknown; opened: boolean; closed: boolean; closeCode: number | null; openAt: string | null; closeAt: string | null };
  rest: { exchangeInfoCalls: number; depthAttempts: { attempt: number; requestedAt: string }[]; depthCalls: ({ attempt: number } & BinanceDepthSummary)[]; suppressedPaths: string[] };
  initialSnapshot: BinanceDepthSummary | null; recoverySnapshot: BinanceDepthSummary | null;
  parsedDeltaCount: number; parsedDeltasBeforeDrop: number; managerDeltaBeforeDrop: BinanceDeltaSummary | null;
  postDropWireFrame: ObservedBinanceWireFrame | null; sequenceGapObserved: boolean;
  managerGap: { expectedSequence: number; receivedPreviousSequence: number; triggerWireOrdinal: number | null; observedAt: string } | null;
  recoveredDelta: BinanceDeltaSummary | null; recoveryWaitCompleted: boolean; managerStartCompleted: boolean;
  finalFeedState: string; invalidationSnapshots: number; statusTransitions: { state: string; sequenceGap: boolean; observedAt: string }[];
  feedErrorCategories: string[]; managerStopped: boolean;
}
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { LiveFeedManager, createWsTransport } from '../src/server/live-feeds.mts';

export const BINANCE_SPOT_GAP_SMOKE_SYMBOL = 'BTCUSDT';
export const BINANCE_USDM_GAP_SMOKE_SYMBOL = BINANCE_SPOT_GAP_SMOKE_SYMBOL;
export const BINANCE_SPOT_GAP_SMOKE_TIMEOUT_MS = 30_000;
export const BINANCE_SPOT_GAP_SMOKE_MAX_TIMEOUT_MS = 120_000;
export const BINANCE_SPOT_GAP_SMOKE_DROP_AFTER_DELTAS = 8;
export const BINANCE_SPOT_GAP_SMOKE_MAX_DEPTH_ATTEMPTS = 3;
const ROOT = path.resolve(process.cwd());
const DEFAULT_OUTPUTS = {
  spot: path.join(ROOT, 'docs', 'acceptance', 'visual-parity', 'm9-venues', 'm9-08-binance-spot-gap-recovery-evidence-2026-09-23.json'),
  perpetual: path.join(ROOT, 'docs', 'acceptance', 'visual-parity', 'm9-venues', 'm9-08-binance-usdm-gap-recovery-evidence-2026-09-23.json'),
};

class InertSocket {
  async open() {}
  send() {}
  close() {}
  on() {}
}

function rawText(raw: unknown) {
  if (typeof raw === 'string') return raw;
  if (raw instanceof Uint8Array || Buffer.isBuffer(raw)) return Buffer.from(raw).toString('utf8');
  return '';
}

function normalizeSmokeMarketType(value: unknown) {
  if (value === 'spot') return 'spot';
  if (['perpetual', 'usdm', 'usd-m'].includes(String(value).toLowerCase())) return 'perpetual';
  throw new RangeError(`Unsupported Binance depth smoke market type: ${value}`);
}

/** Extract only the source sequence fields needed by the smoke; never retain a raw frame. */
export function parseBinanceDepthFrame(raw: unknown, { symbol = BINANCE_SPOT_GAP_SMOKE_SYMBOL, marketType = 'spot' } = {}): BinanceWireFrame | null {
  try {
    const normalizedMarketType = normalizeSmokeMarketType(marketType);
    const payload = smokeRecord(JSON.parse(rawText(raw)) as unknown);
    const data = smokeRecord(payload.data ?? payload);
    if (data?.e !== 'depthUpdate' || String(data?.s ?? '').toUpperCase() !== String(symbol).toUpperCase()) return null;
    const firstUpdate = Number(data.U);
    const finalUpdate = Number(data.u);
    if (!Number.isSafeInteger(firstUpdate) || firstUpdate < 1 || !Number.isSafeInteger(finalUpdate) || finalUpdate < firstUpdate) return null;
    const frame: BinanceWireFrame = { symbol: String(data.s).toUpperCase(), firstUpdate, finalUpdate };
    if (normalizedMarketType === 'perpetual') {
      const previousSequence = Number(data.pu);
      if (!Number.isSafeInteger(previousSequence) || previousSequence < 0) return null;
      if (data.st != null && (typeof data.st !== 'number' || !Number.isSafeInteger(data.st) || data.st !== 1)) return null;
      if (data.ps != null && (typeof data.ps !== 'string' || data.ps.toUpperCase() !== String(symbol).toUpperCase())) return null;
      frame.previousSequence = previousSequence;
    }
    return frame;
  } catch {
    return null;
  }
}

export function parseBinanceSpotDepthFrame(raw: unknown, options = {}) {
  return parseBinanceDepthFrame(raw, { ...options, marketType: 'spot' });
}

export function parseBinanceUsdMDepthFrame(raw: unknown, options = {}) {
  return parseBinanceDepthFrame(raw, { ...options, marketType: 'perpetual' });
}

/** Drop no more than one matching live frame, and only after the caller arms the fault. */
export function createSingleFrameGapInjector({ symbol = BINANCE_SPOT_GAP_SMOKE_SYMBOL, marketType = 'spot' } = {}) {
  const normalizedMarketType = normalizeSmokeMarketType(marketType);
  let armed = false;
  let pendingCandidate: GapCandidate | null = null;
  let droppedFrame: ObservedBinanceWireFrame | null = null;
  let precedingForwardedFrame: ObservedBinanceWireFrame | null = null;
  let firstWireFrameAfterDrop: ObservedBinanceWireFrame | null = null;
  let lastForwardedFrame: ObservedBinanceWireFrame | null = null;
  let wireOrdinal = 0;
  return {
    arm() { if (!droppedFrame) armed = true; },
    inspect(raw: unknown) {
      const frame = parseBinanceDepthFrame(raw, { symbol, marketType: normalizedMarketType });
      if (!frame) return { deliveries: [{ raw, frame: null }], dropped: false };
      const observed = { ...frame, wireOrdinal: ++wireOrdinal };
      if (!armed || droppedFrame) {
        if (droppedFrame && !firstWireFrameAfterDrop) firstWireFrameAfterDrop = observed;
        lastForwardedFrame = observed;
        return { deliveries: [{ raw, frame: observed }], dropped: false };
      }
      if (!pendingCandidate) {
        pendingCandidate = { raw, frame: observed };
        return { deliveries: [], heldCandidate: true, dropped: false };
      }

      const candidate = pendingCandidate;
      pendingCandidate = null;
      const expected = Number(lastForwardedFrame?.finalUpdate);
      const candidateCoversNext = normalizedMarketType === 'spot'
        ? Number.isSafeInteger(expected) && candidate.frame.firstUpdate <= expected + 1 && candidate.frame.finalUpdate >= expected + 1
        : candidate.frame.previousSequence === expected;
      const nextWouldGapWithoutCandidate = normalizedMarketType === 'spot'
        ? Number.isSafeInteger(expected) && observed.firstUpdate > expected + 1
        : observed.previousSequence !== expected;
      const nextFollowsCandidate = normalizedMarketType === 'spot'
        ? observed.firstUpdate <= candidate.frame.finalUpdate + 1 && observed.finalUpdate >= candidate.frame.finalUpdate + 1
        : observed.previousSequence === candidate.frame.finalUpdate && observed.finalUpdate > candidate.frame.finalUpdate;
      if (candidateCoversNext && nextWouldGapWithoutCandidate && nextFollowsCandidate) {
        armed = false;
        droppedFrame = candidate.frame;
        precedingForwardedFrame = lastForwardedFrame;
        firstWireFrameAfterDrop = observed;
        lastForwardedFrame = observed;
        return { deliveries: [{ raw, frame: observed }], dropped: true };
      }

      // Keep candidate and lookahead in order when this pair would not create
      // a gap. The bounded one-frame hold lets the smoke choose a single real
      // event whose omission is actually exposed by the next U/u range.
      lastForwardedFrame = observed;
      return {
        deliveries: [
          { raw: candidate.raw, frame: candidate.frame },
          { raw, frame: observed },
        ],
        heldCandidateForwarded: true,
        dropped: false,
      };
    },
    snapshot() {
      return {
        armed,
        dropCount: droppedFrame ? 1 : 0,
        droppedFrame: droppedFrame ? { ...droppedFrame } : null,
        precedingForwardedFrame: precedingForwardedFrame ? { ...precedingForwardedFrame } : null,
        firstWireFrameAfterDrop: firstWireFrameAfterDrop ? { ...firstWireFrameAfterDrop } : null,
        pendingCandidate: pendingCandidate != null,
      };
    },
  };
}

export function evaluateBinanceDepthGapRecovery(rawEvidence: unknown, { marketType = smokeRecord(rawEvidence).marketType ?? 'spot' } = {}) {
  const evidence = smokeRecord(rawEvidence);
  const dropper = smokeRecord(evidence.dropper);
  const normalizedMarketType = normalizeSmokeMarketType(marketType);
  const dropped = smokeRecord(dropper.droppedFrame);
  const preceding = smokeRecord(dropper.precedingForwardedFrame);
  const rawPostDrop = evidence.postDropWireFrame ?? dropper.firstWireFrameAfterDrop;
  const postDrop = smokeRecord(rawPostDrop);
  const acceptedBeforeDrop = smokeRecord(evidence.managerDeltaBeforeDrop);
  const managerGap = smokeRecord(evidence.managerGap);
  const expected = Number(preceding?.finalUpdate);
  const sourceGapProvesDroppedFrame = normalizedMarketType === 'spot'
    ? Number.isSafeInteger(expected)
      && Number(dropped.firstUpdate) <= expected + 1
      && Number(dropped.finalUpdate) >= expected + 1
      && Number(postDrop.firstUpdate) > expected + 1
      && Number(postDrop.firstUpdate) <= Number(dropped?.finalUpdate) + 1
      && Number(postDrop.finalUpdate) >= Number(dropped?.finalUpdate) + 1
      && Number(acceptedBeforeDrop?.sequence) === expected
      && Number(acceptedBeforeDrop?.wireOrdinal) === Number(preceding?.wireOrdinal)
    : Number.isSafeInteger(expected)
      && Number(dropped?.previousSequence) === expected
      && Number(postDrop?.previousSequence) === Number(dropped?.finalUpdate)
      && Number(postDrop?.finalUpdate) > Number(dropped?.finalUpdate)
      && Number(acceptedBeforeDrop?.sequence) === expected
      && Number(acceptedBeforeDrop?.wireOrdinal) === Number(preceding?.wireOrdinal);
  const managerGapMatchesPostDrop = Number(managerGap?.expectedSequence) === expected
    && Number(managerGap?.receivedPreviousSequence) === (normalizedMarketType === 'spot' ? Number(postDrop?.firstUpdate) - 1 : Number(postDrop?.previousSequence))
    && Number(managerGap?.triggerWireOrdinal) === Number(postDrop?.wireOrdinal);
  const checks = {
    managerStartCompleted: evidence?.managerStartCompleted === true,
    completedWithinOverallDeadline: typeof evidence.elapsedMs === 'number' && Number.isFinite(evidence.elapsedMs)
      && typeof evidence.totalTimeoutMs === 'number' && Number.isFinite(evidence.totalTimeoutMs) && evidence.elapsedMs <= evidence.totalTimeoutMs,
    managerOpenedDepthSocket: smokeRecord(evidence.connection).opened === true,
    actualDepthSnapshot: Number(smokeRecord(evidence.initialSnapshot).sequence) > 0
      && Number(smokeRecord(evidence.initialSnapshot).bidLevels) > 0 && Number(smokeRecord(evidence.initialSnapshot).askLevels) > 0,
    actualParsedDepthDeltasBeforeDrop: Number(evidence?.parsedDeltasBeforeDrop) >= BINANCE_SPOT_GAP_SMOKE_DROP_AFTER_DELTAS,
    exactlyOneLocallyDroppedSourceFrame: dropper.droppedFrame != null
      && rawPostDrop != null && dropper.pendingCandidate === false && Number(dropper.dropCount) === 1,
    withheldFrameCausallyCreatesSourceGap: sourceGapProvesDroppedFrame,
    managerDetectedThatGapOnPostDropFrame: evidence?.sequenceGapObserved === true && managerGapMatchesPostDrop,
    boundedDepthRestAttempts: typeof evidence.depthRestAttempts === 'number' && Number.isInteger(evidence.depthRestAttempts) && evidence.depthRestAttempts <= BINANCE_SPOT_GAP_SMOKE_MAX_DEPTH_ATTEMPTS,
    managerFetchedFreshRestSnapshot: Number(evidence?.depthRestCallsAfterInitial) >= 1
      && Number(smokeRecord(evidence.recoverySnapshot).sequence) > Number(smokeRecord(evidence.initialSnapshot).sequence),
    managerAppliedPostSnapshotDelta: evidence?.recoveredDelta != null
      && Number(smokeRecord(evidence.recoveredDelta).sequence) > Number(smokeRecord(evidence.recoverySnapshot).sequence),
    managerReturnedToLive: evidence?.recoveryWaitCompleted === true && evidence?.finalFeedState === 'live',
    ownedSocketClosed: smokeRecord(evidence.connection).closed === true,
  };
  return { passed: Object.values(checks).every(Boolean), checks };
}

export function evaluateBinanceSpotGapRecovery(evidence: unknown) {
  return evaluateBinanceDepthGapRecovery(evidence, { marketType: 'spot' });
}

export function evaluateBinanceUsdMGapRecovery(evidence: unknown) {
  return evaluateBinanceDepthGapRecovery(evidence, { marketType: 'perpetual' });
}

function finiteSequence(value: unknown) {
  const number = Number(value);
  return Number.isSafeInteger(number) && number > 0 ? number : null;
}

function publicEndpointSummary(value: unknown) {
  try {
    const url = new URL(String(value ?? ''));
    if (!['ws:', 'wss:'].includes(url.protocol)) return null;
    return { protocol: url.protocol, host: url.host, path: url.pathname };
  } catch {
    return null;
  }
}

function safeErrorCategory(value: unknown) {
  const message = String(value ?? '');
  if (/timeout|deadline/i.test(message)) return 'timeout';
  if (/\b429\b|rate.?limit/i.test(message)) return 'rate_limited';
  if (/ENOTFOUND|ECONN|EAI_AGAIN|websocket|socket/i.test(message)) return 'transport';
  return 'request_failed';
}

function parseManagerDepthGap(value: unknown) {
  const match = /depth sequence gap:\s*expected\s+(\d+),\s*got\s+(\d+)/i.exec(String(value ?? ''));
  return match ? { expectedSequence: Number(match[1]), receivedPreviousSequence: Number(match[2]) } : null;
}

function withTimeout<Value>(promise: PromiseLike<Value>, timeoutMs: number, label: string): Promise<Value> {
  const duration = Math.max(0, Number(timeoutMs) || 0);
  if (duration === 0) return Promise.reject(new Error(label));
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(label)), duration); }),
  ]).finally(() => clearTimeout(timer));
}

export function normalizeBinanceSpotGapSmokeTimeout(value: unknown) {
  const requestedTimeoutMs = Number(value);
  return Number.isFinite(requestedTimeoutMs) && requestedTimeoutMs > 0
    ? Math.min(BINANCE_SPOT_GAP_SMOKE_MAX_TIMEOUT_MS, Math.max(1, Math.floor(requestedTimeoutMs)))
    : BINANCE_SPOT_GAP_SMOKE_TIMEOUT_MS;
}

export function boundWebSocketOpen<Transport extends LiveFeedSocket & { socket?: SmokeSocketLifecycle }>(transport: Transport, deadlineAt: number): Transport & LiveFeedSocket {
  const socket = transport?.socket;
  if (!socket?.once || !socket?.removeListener) return transport;
  transport.open = () => {
    if (socket.readyState === 1) return Promise.resolve();
    const remainingMs = Math.floor(deadlineAt - Date.now());
    if (remainingMs <= 0) return Promise.reject(new Error('Smoke operation deadline exceeded before WebSocket open'));
    return new Promise<void>((resolve, reject) => {
      let settled = false;
      const cleanup = () => {
        clearTimeout(timer);
        socket.removeListener('open', onOpen);
        socket.removeListener('error', onError);
        socket.removeListener('close', onClose);
      };
      const settle = (fn: (value: unknown) => void, value: unknown = undefined) => {
        if (settled) return;
        settled = true;
        cleanup();
        fn(value);
      };
      const onOpen = () => settle(() => resolve());
      const onError = () => settle(reject, new Error('Public WebSocket open failed'));
      const onClose = () => settle(reject, new Error('Public WebSocket closed before open'));
      const timer = setTimeout(() => {
        settle(reject, new Error('Smoke operation deadline exceeded during WebSocket open'));
        try {
          if (typeof socket.terminate === 'function') socket.terminate();
          else transport.close?.();
        } catch { /* best effort */ }
      }, remainingMs);
      socket.once('open', onOpen);
      socket.once('error', onError);
      socket.once('close', onClose);
      if (socket.readyState === 1) onOpen();
    });
  };
  return transport;
}

function waitFor(predicate: () => unknown, timeoutMs: number, pollMs = 25) {
  const deadline = Date.now() + Math.max(1, Number(timeoutMs) || 1);
  return new Promise<boolean>(resolve => {
    const check = () => {
      if (predicate()) { resolve(true); return; }
      const remainingMs = deadline - Date.now();
      if (remainingMs <= 0) { resolve(false); return; }
      setTimeout(check, Math.min(pollMs, remainingMs));
    };
    check();
  });
}

export function fetchPublicJson(request: ExchangeRestRequest, timeoutMs = 8_000, deadlineAt = Date.now() + timeoutMs): Promise<unknown> {
  const remainingMs = Math.floor(deadlineAt - Date.now());
  if (remainingMs <= 0) throw new Error('Smoke operation deadline exceeded before public REST request');
  const boundedTimeoutMs = Math.max(1, Math.min(Math.floor(timeoutMs), remainingMs));
  return fetch(request.url, {
    method: request.method ?? 'GET',
    headers: request.headers ?? { accept: 'application/json' },
    signal: AbortSignal.timeout(boundedTimeoutMs),
  }).then(async response => {
    if (!response.ok) throw new Error(`Binance public REST ${new URL(request.url).pathname} HTTP ${response.status}`);
    return response.json();
  });
}

/** Run against Binance public Spot or USD-M endpoints; one live depth frame is withheld locally. */
export async function runBinanceDepthGapRecoverySmoke({
  marketType = 'spot',
  timeoutMs = BINANCE_SPOT_GAP_SMOKE_TIMEOUT_MS,
  outputPath,
  now = () => new Date().toISOString(),
}: { marketType?: unknown; timeoutMs?: unknown; outputPath?: string; now?: () => string } = {}) {
  const normalizedMarketType = normalizeSmokeMarketType(marketType);
  const productLabel = normalizedMarketType === 'spot' ? 'Spot' : 'USD-M perpetual';
  const restHost = normalizedMarketType === 'spot' ? 'api.binance.com' : 'fapi.binance.com';
  const exchangeInfoPath = normalizedMarketType === 'spot' ? '/api/v3/exchangeInfo' : '/fapi/v1/exchangeInfo';
  const depthPath = normalizedMarketType === 'spot' ? '/api/v3/depth' : '/fapi/v1/depth';
  const klinesPath = normalizedMarketType === 'spot' ? '/api/v3/klines' : '/fapi/v1/klines';
  const resolvedOutput = path.resolve(outputPath ?? DEFAULT_OUTPUTS[normalizedMarketType]);
  if (resolvedOutput !== ROOT && !resolvedOutput.startsWith(`${ROOT}${path.sep}`)) throw new RangeError('Smoke output must stay inside LiquidityMapperFast');
  const startedClock = Date.now();
  const totalTimeoutMs = normalizeBinanceSpotGapSmokeTimeout(timeoutMs);
  const overallDeadlineAt = startedClock + totalTimeoutMs;
  const cleanupReserveMs = Math.min(2_000, Math.max(250, Math.floor(totalTimeoutMs * 0.1)));
  const operationDeadlineAt = overallDeadlineAt - cleanupReserveMs;
  const state: BinanceGapState = {
    startedAt: now(),
    symbol: normalizedMarketType === 'spot' ? BINANCE_SPOT_GAP_SMOKE_SYMBOL : BINANCE_USDM_GAP_SMOKE_SYMBOL,
    marketType: normalizedMarketType,
    connection: { endpoint: null, opened: false, closed: false, closeCode: null, openAt: null, closeAt: null },
    rest: { exchangeInfoCalls: 0, depthAttempts: [], depthCalls: [], suppressedPaths: [] },
    initialSnapshot: null,
    recoverySnapshot: null,
    parsedDeltaCount: 0,
    parsedDeltasBeforeDrop: 0,
    managerDeltaBeforeDrop: null,
    postDropWireFrame: null,
    sequenceGapObserved: false,
    managerGap: null,
    recoveredDelta: null,
    recoveryWaitCompleted: false,
    managerStartCompleted: false,
    finalFeedState: 'not-started',
    invalidationSnapshots: 0,
    statusTransitions: [],
    feedErrorCategories: [],
    managerStopped: false,
  };
  const dropper = createSingleFrameGapInjector({ symbol: state.symbol, marketType: normalizedMarketType });
  let currentlyDeliveringFrame: ObservedBinanceWireFrame | null = null;
  let manager: LiveFeedManager;
  const transportFactory = async (spec: LiveFeedTransportOptions) => {
    if (spec.id !== 'binance-depth') return new InertSocket();
    const transport = boundWebSocketOpen(
      await createWsTransport({ venue: spec.venue, marketType: spec.marketType, request: spec.request }),
      operationDeadlineAt,
    );
    state.connection.endpoint = publicEndpointSummary(spec.request?.url);
    const originalOn = smokeRequired(transport.on).bind(transport);
    transport.on = (event, listener) => {
      if (event !== 'message') return originalOn(event, listener);
      return originalOn(event, raw => {
        const injection = dropper.inspect(raw);
        const dropState = dropper.snapshot();
        if (dropState.firstWireFrameAfterDrop && !state.postDropWireFrame) state.postDropWireFrame = dropState.firstWireFrameAfterDrop;
        for (const delivery of injection.deliveries) {
          currentlyDeliveringFrame = delivery.frame;
          try { listener(delivery.raw); } finally { currentlyDeliveringFrame = null; }
        }
      });
    };
    originalOn('open', () => { state.connection.opened = true; state.connection.openAt = now(); });
    originalOn('close', code => { state.connection.closed = true; state.connection.closeCode = Number.isInteger(Number(code)) ? Number(code) : null; state.connection.closeAt = now(); });
    return transport;
  };
  manager = new LiveFeedManager({
    networkEnabled: true,
    transportFactory,
    oiPollMs: 0,
    oiHistoryLimit: 0,
    reconnectBaseMs: 1_000,
    reconnectMaxMs: 1_000,
    restTransport: {
      async request(request) {
        if (Date.now() >= operationDeadlineAt) throw new Error('Smoke operation deadline exceeded before REST request');
        const parsed = new URL(request.url);
        if (parsed.hostname !== restHost) throw new Error('Unexpected Binance REST host in public smoke');
        if (parsed.pathname === exchangeInfoPath) {
          if (state.rest.exchangeInfoCalls >= 1) throw new Error('Bounded smoke exchangeInfo-call limit exceeded');
          state.rest.exchangeInfoCalls += 1;
          return fetchPublicJson(request, 8_000, operationDeadlineAt);
        }
        if (parsed.pathname === depthPath) {
          if (parsed.searchParams.get('symbol') !== state.symbol) throw new Error('Binance REST depth symbol mismatch');
          if (state.rest.depthAttempts.length >= BINANCE_SPOT_GAP_SMOKE_MAX_DEPTH_ATTEMPTS) throw new Error('Bounded smoke REST depth-attempt limit exceeded');
          const attempt = state.rest.depthAttempts.length + 1;
          state.rest.depthAttempts.push({ attempt, requestedAt: now() });
          const payload = smokeRecord(await fetchPublicJson(request, 8_000, operationDeadlineAt));
          const sequence = finiteSequence(payload?.lastUpdateId);
          if (sequence == null || !Array.isArray(payload?.bids) || !Array.isArray(payload?.asks)) throw new Error('Binance REST depth snapshot malformed');
          state.rest.depthCalls.push({ attempt, sequence, bidLevels: payload.bids.length, askLevels: payload.asks.length, receivedAt: now() });
          return payload;
        }
        if (parsed.pathname === klinesPath) {
          state.rest.suppressedPaths.push(parsed.pathname);
          return [];
        }
        state.rest.suppressedPaths.push(parsed.pathname);
        return {};
      },
    },
    onStatus: status => {
      if (status?.id !== 'binance-depth') return;
      const lastError = String(status.lastError ?? '');
      const gap = parseManagerDepthGap(lastError);
      if (gap) {
        state.sequenceGapObserved = true;
        if (!state.managerGap) state.managerGap = {
          ...gap,
          triggerWireOrdinal: finiteSequence(currentlyDeliveringFrame?.wireOrdinal),
          observedAt: now(),
        };
      }
      const prior = state.statusTransitions.at(-1);
      if (!prior || prior.state !== status.state || prior.sequenceGap !== state.sequenceGapObserved) {
        state.statusTransitions.push({ state: String(status.state ?? 'unknown'), sequenceGap: state.sequenceGapObserved, observedAt: now() });
      }
      if (lastError && !gap && !/^waiting for depth snapshot$/i.test(lastError)) {
        const category = safeErrorCategory(lastError);
        if (!state.feedErrorCategories.includes(category)) state.feedErrorCategories.push(category);
      }
    },
    onMessage: event => {
      if (event?.id !== 'binance-depth') return;
      const message = event.message;
      if (message?.kind === 'depthSnapshot') {
        if (message.invalidated === true || message.complete === false) { state.invalidationSnapshots += 1; return; }
        const summary = {
          sequence: finiteSequence(message.sequence),
          bidLevels: Array.isArray(message.bids) ? message.bids.length : 0,
          askLevels: Array.isArray(message.asks) ? message.asks.length : 0,
          receivedAt: now(),
        };
        if (!state.initialSnapshot) state.initialSnapshot = summary;
        else if (state.sequenceGapObserved && Number(summary.sequence) > Number(state.initialSnapshot.sequence)) {
          state.recoverySnapshot = summary;
          state.recoveredDelta = null;
        }
      } else if (message?.kind === 'depthDelta') {
        state.parsedDeltaCount += 1;
        if (!dropper.snapshot().droppedFrame) {
          state.parsedDeltasBeforeDrop = state.parsedDeltaCount;
          state.managerDeltaBeforeDrop = {
            firstUpdate: finiteSequence(message.firstUpdate),
            previousSequence: finiteSequence(message.previousSequence),
            sequence: finiteSequence(message.sequence),
            wireOrdinal: finiteSequence(currentlyDeliveringFrame?.wireOrdinal),
          };
        }
        if (!dropper.snapshot().droppedFrame && state.parsedDeltaCount >= BINANCE_SPOT_GAP_SMOKE_DROP_AFTER_DELTAS) dropper.arm();
        if (state.sequenceGapObserved && state.recoverySnapshot && !state.recoveredDelta && Number(message.sequence) > Number(state.recoverySnapshot.sequence)) {
          state.recoveredDelta = {
            firstUpdate: finiteSequence(message.firstUpdate),
            previousSequence: finiteSequence(message.previousSequence),
            sequence: finiteSequence(message.sequence),
            receivedAt: now(),
          };
        }
      }
    },
  });

  let startErrorCategory = null;
  try {
    await withTimeout(
      manager.start({ binanceSymbol: state.symbol, binanceMarketType: normalizedMarketType, candleInterval: '1m' }),
      operationDeadlineAt - Date.now(),
      'Smoke deadline during manager startup',
    );
    state.managerStartCompleted = true;
    state.recoveryWaitCompleted = await waitFor(() => {
      const feedState = manager.status()['binance-depth']?.state;
      return state.sequenceGapObserved && state.recoverySnapshot && state.recoveredDelta && feedState === 'live';
    }, Math.max(0, operationDeadlineAt - Date.now()));
    state.finalFeedState = manager.status()['binance-depth']?.state ?? 'missing';
  } catch (error) {
    startErrorCategory = safeErrorCategory(smokeRecord(error).message ?? error);
  } finally {
    if (state.finalFeedState === 'not-started' && manager) state.finalFeedState = manager.status()['binance-depth']?.state ?? 'missing';
    manager.stop();
    state.managerStopped = true;
    await waitFor(() => state.connection.closed, Math.max(0, Math.min(2_000, overallDeadlineAt - Date.now())));
  }

  const depthCallsAfterInitial = Math.max(0, state.rest.depthCalls.length - (state.initialSnapshot ? 1 : 0));
  const elapsedMs = Date.now() - startedClock;
  const evidence = {
    connection: state.connection,
    marketType: normalizedMarketType,
    elapsedMs,
    totalTimeoutMs,
    managerStartCompleted: state.managerStartCompleted,
    initialSnapshot: state.initialSnapshot,
    recoverySnapshot: state.recoverySnapshot,
    parsedDeltasBeforeDrop: state.parsedDeltasBeforeDrop,
    managerDeltaBeforeDrop: state.managerDeltaBeforeDrop,
    dropper: dropper.snapshot(),
    postDropWireFrame: state.postDropWireFrame,
    sequenceGapObserved: state.sequenceGapObserved,
    managerGap: state.managerGap,
    recoveredDelta: state.recoveredDelta,
    depthRestAttempts: state.rest.depthAttempts.length,
    depthRestCallsAfterInitial: depthCallsAfterInitial,
    finalFeedState: state.finalFeedState,
    recoveryWaitCompleted: state.recoveryWaitCompleted,
  };
  const verdict = evaluateBinanceDepthGapRecovery(evidence, { marketType: normalizedMarketType });
  const artifact = {
    schemaVersion: 1,
    generatedAt: now(),
    verdict: verdict.passed ? 'PASS' : 'FAIL',
    scope: `public Binance ${productLabel} manager sequence-gap recovery with one locally withheld live depth frame`,
    marketType: normalizedMarketType,
    symbol: state.symbol,
    endpoint: {
      websocket: state.connection.endpoint,
      restHost,
      depthPath,
      exchangeInfoCalls: state.rest.exchangeInfoCalls,
      depthCalls: state.rest.depthCalls,
      suppressedLocalOnlyPaths: [...new Set(state.rest.suppressedPaths)].sort(),
    },
    evidence: {
      connection: state.connection,
      elapsedMs,
      totalTimeoutMs,
      cleanupReserveMs,
      managerStartCompleted: state.managerStartCompleted,
      initialSnapshot: state.initialSnapshot,
      parsedDeltasBeforeDrop: state.parsedDeltasBeforeDrop,
      managerDeltaBeforeDrop: state.managerDeltaBeforeDrop,
      droppedFrame: dropper.snapshot().droppedFrame,
      precedingForwardedFrame: dropper.snapshot().precedingForwardedFrame,
      firstWireFrameAfterDrop: state.postDropWireFrame,
      managerGap: state.managerGap,
      sequenceGapObserved: state.sequenceGapObserved,
      invalidationSnapshots: state.invalidationSnapshots,
      recoverySnapshot: state.recoverySnapshot,
      recoveredDelta: state.recoveredDelta,
      finalFeedState: evidence.finalFeedState,
      recoveryWaitCompleted: state.recoveryWaitCompleted,
      restDepthCallsAfterInitial: depthCallsAfterInitial,
      depthRestAttempts: state.rest.depthAttempts,
      statusTransitions: state.statusTransitions,
    },
    checks: verdict.checks,
    intervention: dropper.snapshot().droppedFrame
      ? `The smoke withheld exactly one real BTCUSDT ${productLabel} depth frame before the manager received it. No exchange state was modified.`
      : 'The bounded lookahead did not withhold a frame because it could not prove that one omission would create a source sequence gap. No exchange state was modified.',
    limits: [
      `This proves manager handling of a locally induced sequence gap in live Binance ${productLabel} frames; it does not claim an exchange-initiated disconnect or naturally occurring packet loss.`,
      'It does not measure browser performance, physical memory, or long-duration venue availability.',
      'The artifact stores summary metadata and no raw depth payload or price/quantity rows; it omits credentials and account data.',
    ],
    managerStopped: state.managerStopped,
    startErrorCategory,
    feedErrorCategories: state.feedErrorCategories,
  };
  await fs.mkdir(path.dirname(resolvedOutput), { recursive: true });
  await fs.writeFile(resolvedOutput, `${JSON.stringify(artifact, null, 2)}\n`, 'utf8');
  return { artifact, outputPath: resolvedOutput, exitCode: verdict.passed && state.managerStopped && !startErrorCategory ? 0 : 1 };
}

export function runBinanceSpotLiveGapRecoverySmoke(options = {}) {
  return runBinanceDepthGapRecoverySmoke({ ...options, marketType: 'spot' });
}

export function runBinanceUsdMLiveGapRecoverySmoke(options = {}) {
  return runBinanceDepthGapRecoverySmoke({ ...options, marketType: 'perpetual' });
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : '';
if (invokedPath === fileURLToPath(import.meta.url)) {
  const timeoutArg = process.argv.find(value => value.startsWith('--timeout-ms='));
  const marketTypeArg = process.argv.find(value => value.startsWith('--market-type='));
  const marketType = marketTypeArg ? marketTypeArg.slice('--market-type='.length) : 'spot';
  const timeoutMs = timeoutArg ? Number(timeoutArg.slice('--timeout-ms='.length)) : BINANCE_SPOT_GAP_SMOKE_TIMEOUT_MS;
  const result = await runBinanceDepthGapRecoverySmoke({ timeoutMs, marketType });
  process.stdout.write(`${JSON.stringify({ verdict: result.artifact.verdict, checks: result.artifact.checks, outputPath: result.outputPath, managerStopped: result.artifact.managerStopped, startErrorCategory: result.artifact.startErrorCategory }, null, 2)}\n`);
  process.exitCode = result.exitCode;
}
