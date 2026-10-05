import { smokeRecord, smokeArray, smokeRequired, smokeFrameText } from './smoke-boundaries.mts';
import type { LiveFeedSocket, LiveFeedOptions, LiveFeedTransportOptions, LiveFeedSpec, LiveFeedStartOptions, LiveFeedStatusEvent, LiveFeedEvent, LiveNormalizedMessage } from '../src/server/live-feeds.mts';
export interface BybitSmokeTransport extends LiveFeedSocket { socket?: { terminate?: () => unknown }; terminate?: () => unknown }
export interface BybitSmokeManager { start: (options?: LiveFeedStartOptions) => unknown | PromiseLike<unknown>; stop: () => unknown; specs?: ReadonlyMap<string, LiveFeedSpec> }
interface BybitCoverage { latestSequence: unknown; latestCrossSequence: unknown; bids: number; asks: number; coverage: unknown; sourceTimestamp: unknown; firstReceivedAt: number | null; lastReceivedAt: number | null }
export interface BybitConnection { id: number; subscribeRequests: number; subscribeAcks: number; rejectedSubscribeAcks: number; wireSnapshots: number; wireDeltas: number; healthySnapshots: number; invalidationSnapshots: number; routedDeltas: number; wireTopicMatchesManager: number; wireSymbolMatches: number; wireSymbolMissing: number; wireBookSidesValid: number; wireUpdateIdsPresent: number; dataFramesBeforeSubscribeAck: number; closeObserved: number; postCloseWireMessages: number;
  topic: string | null; symbol: string | null; subscribeTopics: string[]; requestTopics: string[];
  wireSnapshotKeys: Set<string>; wireDeltaKeys: Set<string>; wireEventOrder: string[];
  closeCode: number | null; backoffObserved: boolean; backoffAttempt: number | null;
  snapshotSequence: string | null; snapshotCrossSequence: string | null; deltaSequence: string | null;
  deltaCrossSequence: string | null; deltaContinuity: string | null; deltaSequenceJump: boolean | null;
}
interface BybitState { subscribeRequests: number; subscribeAcks: number; rejectedSubscribeAcks: number; wireSnapshots: number; wireDeltas: number; parsedSnapshots: number; healthySnapshots: number; invalidationSnapshots: number; parsedDeltas: number; unmatchedNormalizedMessages: number; postCloseRoutedMessages: number; malformedWireMessages: number; wireTopicMatchesManager: number; wireSymbolMatches: number; wireSymbolMissing: number; wireBookSidesValid: number; wireUpdateIdsPresent: number; dataFramesBeforeSubscribeAck: number; managerInstrumentMismatches: number; closeObserved: number; closeRequested: number;
  topic: string; symbol: string; startedAt: number; managerStarted: boolean;
  statusTransitions: { state: string | undefined; attempt: number; observedAt: number }[];
  connections: BybitConnection[]; activeConnectionId: number | null; coverage: BybitCoverage;
  lastStatus: string | null | undefined; wake: (() => void) | null;
}
export interface BybitWaitOptions { timeoutMs?: unknown; pollMs?: number; now?: () => number; sleep?: (delay: number) => unknown | PromiseLike<unknown> }
export interface BybitSmokeOptions {
  symbol?: string; timeoutMs?: number; reconnectTimeoutMs?: number; closeAfterDelta?: boolean; requireDelta?: boolean; requireReconnect?: boolean;
  disconnectMode?: string; reconnectBaseMs?: number; reconnectMaxMs?: number; now?: () => number;
  managerFactory?: (options: LiveFeedOptions) => BybitSmokeManager;
  transportFactory?: ((options: LiveFeedTransportOptions) => BybitSmokeTransport | PromiseLike<BybitSmokeTransport>) | null;
}
import { LiveFeedManager, createWsTransport } from '../src/server/live-feeds.mts';
import { pathToFileURL } from 'node:url';

export const BYBIT_LIVE_SMOKE_SYMBOL = 'BTCUSDT';
export const BYBIT_LIVE_SMOKE_TIMEOUT_MS = 15_000;
export const BYBIT_LIVE_SMOKE_RECONNECT_TIMEOUT_MS = 10_000;
const WIRE_EVENT_PREFIX_LIMIT = 8;

/** Resolve when a predicate becomes true or return a bounded timeout result. */
export function waitForBybitSmoke(predicate: () => unknown, { timeoutMs, pollMs = 10, now = () => Date.now(), sleep = delay => new Promise(resolve => setTimeout(resolve, delay)) }: BybitWaitOptions = {}) {
  const timeout = Math.max(0, Number(timeoutMs));
  const startedAt = now();
  return (async () => {
    while (true) {
      if (predicate()) return { timedOut: false, elapsedMs: Math.max(0, now() - startedAt) };
      if (now() - startedAt >= timeout) return { timedOut: true, elapsedMs: Math.max(0, now() - startedAt) };
      await sleep(Math.min(Math.max(1, pollMs), Math.max(1, timeout - (now() - startedAt))));
    }
  })();
}

class InertSocket {
  async open() {}
  send() {}
  close() {}
}

function token(value: unknown) { return value == null ? '' : String(value); }
function sameTopics(value: unknown, topics: readonly unknown[]) { return Array.isArray(value) && value.length === topics.length && value.every((topic, index) => String(topic) === String(topics[index])); }
function wireKey(kind: unknown, timestamp: unknown, updateId: unknown, crossSequence: unknown) { return [kind, token(timestamp), token(updateId), token(crossSequence)].join('|'); }
function normalizedKey(value: LiveNormalizedMessage) { return wireKey(value.kind === 'depthSnapshot' ? 'snapshot' : 'delta', value.sourceTimestamp, value.sequence, value.crossSequence); }
function sequenceAdvances(snapshot: unknown, delta: unknown) {
  try { return snapshot != null && delta != null && BigInt(String(delta)) > BigInt(String(snapshot)); }
  catch { return false; }
}

function emptyCoverage(): BybitCoverage {
  return { latestSequence: null, latestCrossSequence: null, bids: 0, asks: 0, coverage: null, sourceTimestamp: null, firstReceivedAt: null, lastReceivedAt: null };
}

function makeCollector({ now, symbol }: { now: () => number; symbol: string }) {
  const topic = `orderbook.1000.${symbol}`;
  const state: BybitState = {
    topic, symbol, startedAt: now(), managerStarted: false,
    subscribeRequests: 0, subscribeAcks: 0, rejectedSubscribeAcks: 0,
    wireSnapshots: 0, wireDeltas: 0, parsedSnapshots: 0,
    healthySnapshots: 0, invalidationSnapshots: 0, parsedDeltas: 0,
    unmatchedNormalizedMessages: 0, postCloseRoutedMessages: 0, malformedWireMessages: 0,
    wireTopicMatchesManager: 0, wireSymbolMatches: 0, wireSymbolMissing: 0, wireBookSidesValid: 0, wireUpdateIdsPresent: 0,
    dataFramesBeforeSubscribeAck: 0,
    managerInstrumentMismatches: 0,
    closeObserved: 0, closeRequested: 0,
    statusTransitions: [], connections: [], activeConnectionId: null,
    coverage: emptyCoverage(), lastStatus: null, wake: null,
  };
  const notify = () => state.wake?.();
  const wait = (timeoutMs: number) => new Promise<boolean>(resolve => {
    if (state.wake) throw new Error('only one smoke wait may be active');
    const timer = setTimeout(() => { state.wake = null; resolve(false); }, Math.max(0, timeoutMs));
    state.wake = () => { clearTimeout(timer); state.wake = null; resolve(true); };
  });
  const openConnection = () => {
    const connection: BybitConnection = {
      id: state.connections.length + 1, subscribeRequests: 0, subscribeTopics: [], subscribeAcks: 0,
      topic: null, symbol: null, requestTopics: [],
      rejectedSubscribeAcks: 0, wireSnapshots: 0, wireDeltas: 0,
      wireSnapshotKeys: new Set(), wireDeltaKeys: new Set(),
      healthySnapshots: 0, invalidationSnapshots: 0, routedDeltas: 0,
      wireTopicMatchesManager: 0, wireSymbolMatches: 0, wireSymbolMissing: 0, wireBookSidesValid: 0, wireUpdateIdsPresent: 0,
      dataFramesBeforeSubscribeAck: 0, wireEventOrder: [],
      closeObserved: 0, closeCode: null, backoffObserved: false, backoffAttempt: null,
      snapshotSequence: null, snapshotCrossSequence: null, deltaSequence: null,
      deltaCrossSequence: null, deltaContinuity: null, deltaSequenceJump: null,
      postCloseWireMessages: 0,
    };
    state.connections.push(connection); state.activeConnectionId = connection.id; notify(); return connection;
  };
  const activeConnection = () => state.connections.find(connection => connection.id === state.activeConnectionId) ?? null;
  const outbound = (raw: unknown, connection: BybitConnection) => {
    try {
      const payload = smokeRecord(JSON.parse(smokeFrameText(raw)) as unknown);
      if (payload?.op === 'subscribe') {
        connection.subscribeRequests += 1;
        connection.subscribeTopics.push(...(Array.isArray(payload.args) ? payload.args.map(String) : []));
        state.subscribeRequests += 1;
      }
    } catch { /* Only public control frames are inspected; invalid/non-JSON frames are not retained. */ }
    notify();
  };
  const wireMessage = (raw: unknown, connection: BybitConnection) => {
    try {
      const text = smokeFrameText(raw);
      const payload = smokeRecord(JSON.parse(text) as unknown);
      const requestIsExact = connection.subscribeRequests === 1 && sameTopics(connection.subscribeTopics, [topic]);
      if (payload?.op === 'subscribe') {
        const successTopics = smokeRecord(payload.data).successTopics;
        const failTopics = smokeRecord(payload.data).failTopics;
        const ackIsExact = payload.success === true
          && (payload.retCode == null || Number(payload.retCode) === 0)
          && (payload.args == null || sameTopics(payload.args, [topic]))
          && (!Array.isArray(successTopics) || successTopics.some(value => String(value) === topic))
          && (!Array.isArray(failTopics) || failTopics.length === 0);
        if (ackIsExact && requestIsExact) {
          connection.subscribeAcks += 1; state.subscribeAcks += 1;
          if (connection.wireEventOrder.length < WIRE_EVENT_PREFIX_LIMIT) connection.wireEventOrder.push('subscribe-ack');
        }
        else { connection.rejectedSubscribeAcks += 1; state.rejectedSubscribeAcks += 1; }
      }
      if (payload.topic !== topic || (payload.type !== 'snapshot' && payload.type !== 'delta')) return;
      if (payload.topic === connection.topic) { connection.wireTopicMatchesManager += 1; state.wireTopicMatchesManager += 1; }
      const data = smokeRecord(payload.data);
      if (connection.wireEventOrder.length < WIRE_EVENT_PREFIX_LIMIT) connection.wireEventOrder.push(payload.type);
      if (connection.subscribeAcks === 0) { connection.dataFramesBeforeSubscribeAck += 1; state.dataFramesBeforeSubscribeAck += 1; }
      if (data?.s == null) { connection.wireSymbolMissing += 1; state.wireSymbolMissing += 1; }
      else if (String(data.s).replaceAll('-', '').toUpperCase() === symbol
        && String(data.s).replaceAll('-', '').toUpperCase() === String(connection.symbol ?? '').replaceAll('-', '').toUpperCase()) { connection.wireSymbolMatches += 1; state.wireSymbolMatches += 1; }
      if (Array.isArray(data?.b) && Array.isArray(data?.a)) { connection.wireBookSidesValid += 1; state.wireBookSidesValid += 1; }
      if (data?.u != null) { connection.wireUpdateIdsPresent += 1; state.wireUpdateIdsPresent += 1; }
      const key = wireKey(payload.type, payload.ts ?? data.ts ?? payload.time, data.u, data.seq);
      if (payload.type === 'snapshot') {
        connection.wireSnapshots += 1; connection.wireSnapshotKeys.add(key); state.wireSnapshots += 1;
      } else {
        connection.wireDeltas += 1; connection.wireDeltaKeys.add(key); state.wireDeltas += 1;
      }
      if (connection.closeObserved > 0) connection.postCloseWireMessages += 1;
    } catch { state.malformedWireMessages += 1; }
    notify();
  };
  const wireClose = (connection: BybitConnection, code: unknown) => {
    if (connection.closeObserved > 0) return;
    connection.closeObserved += 1;
    connection.closeCode = Number.isInteger(Number(code)) ? Number(code) : null;
    state.closeObserved += 1;
    notify();
  };
  const status = (value: LiveFeedStatusEvent) => {
    if (!value || value.id !== 'bybit-depth') return;
    const connection = activeConnection();
    if (value.state === 'backoff' && connection) { connection.backoffObserved = true; connection.backoffAttempt = Number(value.attempt) || 1; }
    state.lastStatus = value.state;
    const attempt = Number(value.attempt) || 0;
    const previous = state.statusTransitions.at(-1);
    if (!previous || previous.state !== value.state || previous.attempt !== attempt) state.statusTransitions.push({ state: value.state, attempt, observedAt: now() });
    notify();
  };
  const message = ({ venue, message: value, receivedAt }: LiveFeedEvent) => {
    if (venue !== 'bybit') return;
    if (!value || value.instrumentId !== `bybit:${symbol}`) { state.managerInstrumentMismatches += 1; return; }
    const timestamp = Number(receivedAt) || now();
    let connection = null;
    if (value.kind === 'depthSnapshot' && value.complete === false) {
      connection = [...state.connections].reverse().find(item => item.closeObserved > item.invalidationSnapshots) ?? activeConnection();
      if (connection) { connection.invalidationSnapshots += 1; state.invalidationSnapshots += 1; }
    } else {
      const kind = value.kind === 'depthSnapshot' ? 'snapshot' : value.kind === 'depthDelta' ? 'delta' : null;
      const key = normalizedKey(value);
      const matches = kind ? state.connections.filter(item => (kind === 'snapshot' ? item.wireSnapshotKeys : item.wireDeltaKeys).has(key)) : [];
      if (matches.length !== 1) { state.unmatchedNormalizedMessages += 1; notify(); return; }
      connection = matches[0];
      if (connection.closeObserved > 0) state.postCloseRoutedMessages += 1;
      if (value.kind === 'depthSnapshot') {
        state.parsedSnapshots += 1;
        if (value.complete === true) {
          connection.healthySnapshots += 1; state.healthySnapshots += 1;
          connection.snapshotSequence = token(value.sequence) || null;
          connection.snapshotCrossSequence = token(value.crossSequence) || null;
          connection.deltaSequence = null;
          connection.deltaCrossSequence = null;
          connection.deltaContinuity = null;
          connection.deltaSequenceJump = null;
          state.coverage = {
            ...state.coverage,
            latestSequence: value.sequence ?? null,
            latestCrossSequence: value.crossSequence ?? null,
            bids: Array.isArray(value.bids) ? value.bids.length : 0,
            asks: Array.isArray(value.asks) ? value.asks.length : 0,
            coverage: value.coverage ?? null,
            sourceTimestamp: Number.isFinite(value.sourceTimestamp) ? value.sourceTimestamp : null,
            firstReceivedAt: state.coverage.firstReceivedAt ?? timestamp,
            lastReceivedAt: timestamp,
          };
        }
      } else if (value.kind === 'depthDelta') {
        connection.routedDeltas += 1; state.parsedDeltas += 1;
        connection.deltaSequence = token(value.sequence) || null;
        connection.deltaCrossSequence = token(value.crossSequence) || null;
        connection.deltaContinuity = value.continuity ?? null;
        connection.deltaSequenceJump = value.sequenceJump === true;
        state.coverage = {
          ...state.coverage,
          latestSequence: value.sequence ?? state.coverage.latestSequence,
          latestCrossSequence: value.crossSequence ?? state.coverage.latestCrossSequence,
          sourceTimestamp: Number.isFinite(value.sourceTimestamp) ? value.sourceTimestamp : state.coverage.sourceTimestamp,
          lastReceivedAt: timestamp,
        };
      }
    }
    notify();
  };
  return { state, openConnection, activeConnection, outbound, wireMessage, wireClose, status, message, wait };
}

function addLimitation(limitations: string[], value: string) { if (value && !limitations.includes(value)) limitations.push(value); }
function requestDisconnect(transport: BybitSmokeTransport, mode: string) {
  if (mode === 'terminate') {
    if (typeof transport?.socket?.terminate === 'function') { transport.socket.terminate(); return; }
    if (typeof transport?.terminate === 'function') { transport.terminate(); return; }
    throw new TypeError('Bybit transport does not expose an underlying terminate operation');
  }
  if (mode === 'close') { transport?.close?.(); return; }
  throw new RangeError(`Unsupported Bybit disconnect mode: ${mode}`);
}
function summarizeConnection(connection: BybitConnection) {
  const sequenceAdvances = sequenceAdvancesFor(connection);
  return {
    id: connection.id,
    managerTopic: connection.topic,
    managerSymbol: connection.symbol,
    requestTopics: connection.requestTopics,
    subscribeRequests: connection.subscribeRequests,
    subscribeTopics: connection.subscribeTopics,
    exactSubscribeRequest: connection.subscribeRequests === 1 && sameTopics(connection.subscribeTopics, [connection.topic]),
    subscribeAcks: connection.subscribeAcks,
    rejectedSubscribeAcks: connection.rejectedSubscribeAcks,
    wireSnapshots: connection.wireSnapshots,
    wireDeltas: connection.wireDeltas,
    wireTopicMatchesManager: connection.wireTopicMatchesManager,
    wireEventOrder: connection.wireEventOrder,
    dataFramesBeforeSubscribeAck: connection.dataFramesBeforeSubscribeAck,
    wireSymbolMatches: connection.wireSymbolMatches,
    wireSymbolMissing: connection.wireSymbolMissing,
    wireBookSidesValid: connection.wireBookSidesValid,
    wireUpdateIdsPresent: connection.wireUpdateIdsPresent,
    healthySnapshots: connection.healthySnapshots,
    invalidationSnapshots: connection.invalidationSnapshots,
    routedDeltas: connection.routedDeltas,
    snapshotSequence: connection.snapshotSequence,
    snapshotCrossSequence: connection.snapshotCrossSequence,
    deltaSequence: connection.deltaSequence,
    deltaCrossSequence: connection.deltaCrossSequence,
    deltaSequenceAdvances: sequenceAdvances,
    deltaContinuity: connection.deltaContinuity,
    deltaSequenceJump: connection.deltaSequenceJump,
    closeObserved: connection.closeObserved,
    closeCode: connection.closeCode,
    backoffObserved: connection.backoffObserved,
    backoffAttempt: connection.backoffAttempt,
    postCloseWireMessages: connection.postCloseWireMessages,
  };
}
function sequenceAdvancesFor(connection: BybitConnection) { return sequenceAdvances(connection.snapshotSequence, connection.deltaSequence); }
/** Run a bounded, read-only Bybit observation through LiveFeedManager. */
export async function runBybitLiveManagerSmoke({
  symbol = BYBIT_LIVE_SMOKE_SYMBOL,
  timeoutMs = BYBIT_LIVE_SMOKE_TIMEOUT_MS,
  reconnectTimeoutMs = BYBIT_LIVE_SMOKE_RECONNECT_TIMEOUT_MS,
  closeAfterDelta = true,
  requireDelta = true,
  requireReconnect = true,
  disconnectMode = 'terminate',
  reconnectBaseMs = 1_000,
  reconnectMaxMs = 5_000,
  now = () => Date.now(),
  managerFactory = options => new LiveFeedManager(options),
  transportFactory: suppliedTransportFactory = null,
}: BybitSmokeOptions = {}) {
  const normalizedSymbol = String(symbol).replaceAll('-', '').toUpperCase();
  const collector = makeCollector({ now, symbol: normalizedSymbol });
  const sockets: BybitSmokeTransport[] = [];
  let currentBybitTransport: BybitSmokeTransport | null = null;
  let cancelled = false;
  let manager: BybitSmokeManager | null = null;
  const transportFactory = async (spec: LiveFeedTransportOptions) => {
    if (spec.venue !== 'bybit') return suppliedTransportFactory ? suppliedTransportFactory(spec) : new InertSocket();
    const transport = suppliedTransportFactory ? await suppliedTransportFactory(spec) : await createWsTransport({ venue: spec.venue, request: spec.request });
    if (cancelled) {
      try { transport.close?.(); } catch {}
      return new InertSocket();
    }
    const connection = collector.openConnection();
    const managerSpec = spec.id == null ? undefined : manager?.specs?.get(spec.id);
    connection.topic = managerSpec?.topic ?? collector.state.topic;
    connection.symbol = managerSpec?.symbol ?? collector.state.symbol;
    connection.requestTopics = Array.isArray(managerSpec?.request?.args)
      ? managerSpec.request.args.map(String)
      : Array.isArray(spec.request?.args) ? spec.request.args.map(String) : [];
    transport.on?.('message', raw => collector.wireMessage(raw, connection));
    transport.on?.('close', code => collector.wireClose(connection, code));
    if (typeof transport.send === 'function') {
      const send = transport.send.bind(transport);
      transport.send = raw => { collector.outbound(raw, connection); return send(raw); };
    }
    currentBybitTransport = transport;
    sockets.push(transport);
    return transport;
  };
  // The other default manager feeds get inert sockets, and no REST transport is
  // supplied. Only Bybit's public linear socket performs network I/O.
  manager = managerFactory({
    networkEnabled: true,
    transportFactory,
    reconnectBaseMs,
    reconnectMaxMs,
    oiPollMs: 0,
    now,
    onMessage: collector.message,
    onStatus: collector.status,
    transportPolicies: { hyperliquid: { subscribeIntervalMs: 0 }, binance: { subscribeIntervalMs: 0 }, bybit: { subscribeIntervalMs: 0 } },
  });
  const limitations: string[] = [];
  let startupTimedOut = false;
  let startupError: unknown = null;
  try {
    let timer;
    const startup = Promise.resolve().then(() => manager.start({ bybitEnabled: true, bybitSymbol: normalizedSymbol })).then(() => ({ ok: true }), error => ({ ok: false, error }));
    const startupOutcome = await Promise.race([startup, new Promise(resolve => { timer = setTimeout(() => resolve({ timedOut: true }), Math.max(0, timeoutMs)); })]);
    if (timer) clearTimeout(timer);
    if (smokeRecord(startupOutcome).timedOut) { startupTimedOut = true; addLimitation(limitations, 'timed out while awaiting LiveFeedManager.start()'); }
    else if (!smokeRecord(startupOutcome).ok) { startupError = smokeRecord(startupOutcome).error; addLimitation(limitations, 'LiveFeedManager.start() failed before bounded evidence collection'); }
    else {
      collector.state.managerStarted = true;
      const initialReady = await waitForBybitSmoke(() => {
        const initial = collector.state.connections[0];
        return Boolean(initial?.subscribeAcks === 1 && initial?.healthySnapshots > 0);
      }, { timeoutMs, now, sleep: async delay => { await collector.wait(delay); } });
      if (initialReady.timedOut) addLimitation(limitations, 'timed out before the initial exact Bybit subscribe acknowledgement and healthy snapshot');
      const initial = collector.state.connections[0];
      if (!initialReady.timedOut && requireDelta && initial?.routedDeltas === 0) {
        const deltaReady = await waitForBybitSmoke(() => (collector.state.connections[0]?.routedDeltas ?? 0) > 0, {
          timeoutMs: Math.min(3_000, timeoutMs), now, sleep: async delay => { await collector.wait(delay); },
        });
        if (deltaReady.timedOut) addLimitation(limitations, 'no initial parsed delta arrived during the bounded delta window');
      }
      const shouldDisconnect = closeAfterDelta || requireReconnect;
      if (shouldDisconnect && currentBybitTransport && initial?.healthySnapshots > 0) {
        collector.state.closeRequested += 1;
        requestDisconnect(currentBybitTransport, disconnectMode);
        const closeReady = await waitForBybitSmoke(() => Boolean(collector.state.connections[0]?.closeObserved > 0 && collector.state.connections[0]?.backoffObserved), {
          timeoutMs: Math.min(3_000, reconnectTimeoutMs), now, sleep: async delay => { await collector.wait(delay); },
        });
        if (closeReady.timedOut) addLimitation(limitations, 'requested local Bybit disconnect did not produce an observed close and manager backoff');
        if (!closeReady.timedOut && requireReconnect) {
          const replacementReady = await waitForBybitSmoke(() => {
            const replacement = collector.state.connections[1];
            return Boolean(replacement?.subscribeAcks === 1 && replacement.healthySnapshots > 0
              && (!requireDelta || replacement.routedDeltas > 0)
              && (!requireDelta || sequenceAdvancesFor(replacement)));
          }, { timeoutMs: reconnectTimeoutMs, now, sleep: async delay => { await collector.wait(delay); } });
          if (replacementReady.timedOut) addLimitation(limitations, 'bounded replacement did not produce one exact ACK, a fresh snapshot, and a sequence-advancing parsed delta');
        }
      } else if (shouldDisconnect) addLimitation(limitations, 'disconnect/reconnect stage could not start because no initial healthy snapshot was available');
    }
  } catch (error) {
    startupError = error;
    addLimitation(limitations, 'bounded manager smoke encountered a startup or transport error');
  } finally {
    cancelled = true;
    try { manager.stop(); } catch { addLimitation(limitations, 'manager cleanup raised an error after the bounded run'); }
    if (sockets.length) {
      const cleanup = await waitForBybitSmoke(() => collector.state.connections.every(connection => connection.closeObserved > 0), {
        timeoutMs: 1_500, now, sleep: delay => new Promise(resolve => setTimeout(resolve, delay)),
      });
      if (cleanup.timedOut) addLimitation(limitations, 'one or more manager-owned Bybit sockets did not report a close during bounded cleanup');
    }
  }
  const state = collector.state;
  const initial = state.connections[0];
  const replacement = state.connections[1];
  const allConnectionsClosed = state.connections.every(connection => connection.closeObserved > 0);
  const stages = {
    managerStarted: state.managerStarted,
    initialAck: Boolean(initial?.subscribeRequests === 1 && initial?.subscribeAcks === 1),
    initialHealthySnapshot: Boolean(initial?.healthySnapshots > 0),
    initialDelta: !requireDelta || Boolean(initial?.routedDeltas > 0 && sequenceAdvancesFor(initial)),
    close: !(closeAfterDelta || requireReconnect) || Boolean(state.closeRequested > 0 && initial?.closeObserved > 0
      && (disconnectMode !== 'terminate' || initial?.closeCode === 1006) && initial?.backoffObserved),
    reconnect: !requireReconnect || Boolean(replacement?.subscribeRequests === 1 && replacement?.subscribeAcks === 1
      && replacement.healthySnapshots > 0 && (!requireDelta || replacement.routedDeltas > 0 && sequenceAdvancesFor(replacement))),
    cleanup: allConnectionsClosed,
  };
  if (!stages.managerStarted && !startupTimedOut && !startupError) addLimitation(limitations, 'manager startup did not complete');
  if (!stages.initialAck) addLimitation(limitations, 'initial outbound topic and successful subscribe acknowledgement did not match exactly once');
  if (!stages.initialHealthySnapshot) addLimitation(limitations, 'initial healthy snapshot was not observed; invalidation snapshots do not count');
  if (!stages.initialDelta) addLimitation(limitations, 'initial parsed delta did not advance the observed Bybit update ID');
  if (!stages.close) addLimitation(limitations, 'requested local disconnect and manager backoff were not observed with the expected close code');
  if (!stages.reconnect) addLimitation(limitations, 'manager-owned replacement lacked an exact ACK, fresh snapshot, or sequence-advancing parsed delta');
  if (!stages.cleanup) addLimitation(limitations, 'manager-owned socket cleanup was incomplete');
  if (state.unmatchedNormalizedMessages > 0) addLimitation(limitations, 'one or more normalized messages could not be tied to an exact raw session frame');
  if (state.postCloseRoutedMessages > 0 || state.connections.some(connection => connection.postCloseWireMessages > 0)) addLimitation(limitations, 'a Bybit frame or normalized message was observed after its session close');
  const completed = Object.values(stages).every(Boolean) && state.unmatchedNormalizedMessages === 0
    && state.postCloseRoutedMessages === 0 && state.connections.every(connection => connection.postCloseWireMessages === 0);
  const connections = state.connections.map(summarizeConnection);
  return {
    kind: 'm9-bybit-live-feed-manager-smoke',
    status: completed ? 'read-only-live-observation' : 'failed-bounded-observation',
    checkedAt: new Date(now()).toISOString(),
    elapsedMs: Math.max(0, now() - state.startedAt),
    url: 'wss://stream.bybit.com/v5/public/linear',
    subscription: [state.topic],
    observed: {
      managerStarted: state.managerStarted,
      subscribeRequests: state.subscribeRequests,
      subscribeAcks: state.subscribeAcks,
      rejectedSubscribeAcks: state.rejectedSubscribeAcks,
      wireSnapshots: state.wireSnapshots,
      wireDeltas: state.wireDeltas,
      parsedSnapshots: state.parsedSnapshots,
      healthySnapshots: state.healthySnapshots,
      invalidationSnapshots: state.invalidationSnapshots,
      parsedDeltas: state.parsedDeltas,
      unmatchedNormalizedMessages: state.unmatchedNormalizedMessages,
      postCloseRoutedMessages: state.postCloseRoutedMessages,
      malformedWireMessages: state.malformedWireMessages,
      wireTopicMatchesManager: state.wireTopicMatchesManager,
      dataFramesBeforeSubscribeAck: state.dataFramesBeforeSubscribeAck,
      wireSymbolMatches: state.wireSymbolMatches,
      wireSymbolMissing: state.wireSymbolMissing,
      wireBookSidesValid: state.wireBookSidesValid,
      wireUpdateIdsPresent: state.wireUpdateIdsPresent,
      managerInstrumentMismatches: state.managerInstrumentMismatches,
      reconnectSockets: Math.max(0, sockets.length - 1),
      disconnectMode,
      closeRequested: state.closeRequested,
      closeObserved: state.closeObserved,
      latestSequence: state.coverage.latestSequence,
      latestCrossSequence: state.coverage.latestCrossSequence,
      bids: state.coverage.bids,
      asks: state.coverage.asks,
      coverage: state.coverage.coverage,
      sourceTimestamp: state.coverage.sourceTimestamp,
      firstReceivedAt: state.coverage.firstReceivedAt,
      lastReceivedAt: state.coverage.lastReceivedAt,
      finalManagerState: state.lastStatus,
      allConnectionsClosed,
      stages,
      connections,
    },
    verification: {
      manager: 'LiveFeedManager.start({ bybitEnabled: true, bybitSymbol })',
      result: completed ? 'manager completed all requested bounded evidence stages' : 'bounded observation failed one or more requested evidence stages',
      deltaObservation: state.parsedDeltas > 0 ? 'parsed deltas were matched to their raw session frame and routed through LiveFeedManager' : 'no parsed delta was observed within the bounded window',
      lifecycle: replacement ? 'local socket termination led to a manager-owned replacement with exact ACK, fresh snapshot, and advancing update ID' : 'bounded close/reconnect was incomplete',
      networkBoundary: 'only the Bybit public linear socket used a real transport; default non-Bybit transports were inert and no REST transport was supplied',
      credentials: 'none',
      writes: 'none',
    },
    limits: [
      ...limitations,
      'The observation uses finite public linear depth with partial coverage; raw WebSocket frames, level amounts, credentials, and environment values are not retained.',
      'The disconnect is locally induced with the client transport terminate operation; this does not prove an exchange-initiated disconnect or network-path recovery.',
      'Bybit documents snapshot replacement, zero-size deletion, u=1 restart snapshots, and seq as a cross-sequence comparator. The depth-50 packet does not claim full-depth delta consecutiveness, checksum verification, or gap detection.',
      'No quota, UI activation, registry promotion, deployment, or live order behavior is exercised.',
    ],
    statusTransitions: state.statusTransitions,
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const artifact = await runBybitLiveManagerSmoke();
  console.log(JSON.stringify(artifact, null, 2));
  if (artifact.status !== 'read-only-live-observation') process.exitCode = 2;
}
