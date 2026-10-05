import { smokeRecord, smokeArray, smokeRequired } from './smoke-boundaries.mts';
import type { LiveFeedSocket, LiveFeedRequest } from '../src/server/live-feeds.mts';
import type { PublicDepthUpdate, PublicDepthSession } from '../src/adapters/public-depth-session.mts';

export interface PublicSmokeTransportOptions { venue: string; request: LiveFeedRequest; index: number }
export type PublicSmokeTransportFactory = (options: PublicSmokeTransportOptions) => LiveFeedSocket | PromiseLike<LiveFeedSocket>;
interface PublicSmokeDefinition {
  venue: string; symbol: string; url: string; instrumentId: string; topic: string;
  build: () => LiveFeedRequest;
  normalize: (payload: unknown, receivedAt: number) => PublicDepthUpdate;
  matches: (payload: unknown) => boolean; isAck: (payload: unknown) => boolean;
  isSnapshot?: (payload: unknown) => boolean; isDelta?: (payload: unknown) => boolean;
  requiresDelta?: boolean; subscribe?: (request: LiveFeedRequest) => unknown;
}
export interface PublicSmokeConnection {
  index: number; subscribeAck: boolean; wireSnapshots: number; wireDeltas: number;
  normalizedSnapshots: number; normalizedDeltas: number; routedSnapshots: number; routedDeltas: number;
  closeObserved: boolean; closeTimedOut: boolean; coverage: unknown; units: unknown;
  bidLevels: number; askLevels: number; sourceTimestamp: number | null; sequenceType: string | null;
}
interface PublicSmokeObservation { connection: PublicSmokeConnection; socket: LiveFeedSocket; session: PublicDepthSession }
export interface PublicSmokeProviderReport {
  venue: string; symbol?: string; endpoint?: string; status: string; error?: string;
  observed?: unknown; limits?: string[];
}
export interface PublicDepthSmokeOptions { providers?: string[]; timeoutMs?: number; reconnectTimeoutMs?: number; transportFactory?: PublicSmokeTransportFactory; now?: () => string }
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createWsTransport } from '../src/server/live-feeds.mts';
import {
  BITGET_PUBLIC_WS_URL,
  buildBitgetSubscription,
  normalizeBitgetDepth,
} from '../src/adapters/bitget.mts';
import {
  OKX_PUBLIC_WS_URL,
  buildOkxSubscription,
  normalizeOkxDepth,
} from '../src/adapters/okx.mts';
import {
  GATEIO_USDT_WS_URL,
  buildGateSubscription,
  normalizeGateDepth,
} from '../src/adapters/gateio.mts';
import {
  DERIBIT_PUBLIC_WS_URL,
  buildDeribitSubscription,
  normalizeDeribitDepth,
} from '../src/adapters/deribit.mts';
import {
  applyPublicDepthSessionMessage,
  createPublicDepthSession,
} from '../src/adapters/public-depth-session.mts';

const DEFAULT_TIMEOUT_MS = 20_000;
const DEFAULT_RECONNECT_TIMEOUT_MS = 20_000;

const DEFINITIONS: Readonly<Record<string, PublicSmokeDefinition>> = Object.freeze({
  okx: Object.freeze({
    venue: 'okx',
    symbol: 'BTC-USDT-SWAP',
    url: OKX_PUBLIC_WS_URL,
    build: () => buildOkxSubscription('depth', { instId: 'BTC-USDT-SWAP' }),
    instrumentId: 'okx:BTC-USDT-SWAP',
    topic: 'books:BTC-USDT-SWAP',
    normalize: (payload: unknown, receivedAt: number) => normalizeOkxDepth(payload, { instId: 'BTC-USDT-SWAP', receivedAt }),
    matches: (payload: unknown) => {
      const rawArg = smokeRecord(payload).arg;
      const arg = smokeRecord(rawArg);
      return !rawArg || (String(arg.channel ?? '') === 'books' && String(arg.instId ?? '').toUpperCase() === 'BTC-USDT-SWAP');
    },
    isAck: (payload: unknown) => smokeRecord(payload).event === 'subscribe' && String(smokeRecord(smokeRecord(payload).arg).channel ?? '') === 'books',
  }),
  bitget: Object.freeze({
    venue: 'bitget',
    symbol: 'BTCUSDT',
    url: BITGET_PUBLIC_WS_URL,
    build: () => buildBitgetSubscription('depth', { symbol: 'BTCUSDT', instType: 'usdt-futures' }),
    instrumentId: 'bitget:BTCUSDT',
    topic: 'books:BTCUSDT',
    normalize: (payload: unknown, receivedAt: number) => normalizeBitgetDepth(payload, { symbol: 'BTCUSDT', instType: 'usdt-futures', receivedAt }),
    matches: (payload: unknown) => {
      const rawArg = smokeRecord(payload).arg;
      const arg = smokeRecord(rawArg);
      return !rawArg || (String(arg.topic ?? '') === 'books' && String(arg.symbol ?? '').toUpperCase() === 'BTCUSDT');
    },
    isAck: (payload: unknown) => smokeRecord(payload).event === 'subscribe' && String(smokeRecord(smokeRecord(payload).arg).topic ?? '') === 'books',
  }),
  gateio: Object.freeze({
    venue: 'gateio',
    symbol: 'BTC_USDT',
    url: GATEIO_USDT_WS_URL,
    build: () => buildGateSubscription('depth', { contract: 'BTC_USDT', limit: 100, interval: '0' }),
    instrumentId: 'gateio:BTC_USDT',
    topic: 'futures.order_book:BTC_USDT',
    normalize: (payload: unknown, receivedAt: number) => normalizeGateDepth(payload, { contract: 'BTC_USDT', receivedAt }),
    matches: (payload: unknown) => {
      const result = smokeRecord(smokeRecord(payload).result);
      return !smokeRecord(payload).channel || (String(smokeRecord(payload).channel) === 'futures.order_book' && (!result?.contract || String(result.contract).toUpperCase() === 'BTC_USDT'));
    },
    isAck: (payload: unknown) => smokeRecord(payload).event === 'subscribe' && String(smokeRecord(payload).channel ?? '') === 'futures.order_book',
    isSnapshot: (payload: unknown) => smokeRecord(payload).event === 'all',
    isDelta: (payload: unknown) => smokeRecord(payload).event === 'update',
    requiresDelta: false,
    subscribe: (request: LiveFeedRequest) => ({ time: Math.floor(Date.now() / 1000), channel: request.channel, event: 'subscribe', payload: request.args }),
  }),
  deribit: Object.freeze({
    venue: 'deribit',
    symbol: 'BTC-PERPETUAL',
    url: DERIBIT_PUBLIC_WS_URL,
    build: () => buildDeribitSubscription('depth', { instrumentName: 'BTC-PERPETUAL', group: 10, depth: 20, interval: '100ms' }),
    instrumentId: 'deribit:BTC-PERPETUAL',
    topic: 'book.BTC-PERPETUAL.10.20.100ms',
    normalize: (payload: unknown, receivedAt: number) => normalizeDeribitDepth(payload, { instrumentName: 'BTC-PERPETUAL', receivedAt }),
    matches: (payload: unknown) => {
      const channel = smokeRecord(smokeRecord(payload).params).channel;
      const instrument = smokeRecord(smokeRecord(smokeRecord(payload).params).data).instrument_name;
      return String(channel ?? '') === 'book.BTC-PERPETUAL.10.20.100ms' && instrument != null && String(instrument).toUpperCase() === 'BTC-PERPETUAL';
    },
    // Deribit documents a string-array subscription result. Keep the smoke
    // aligned with the manager's exact id/channel acknowledgement contract.
    isAck: (payload: unknown) => smokeRecord(payload).jsonrpc === '2.0' && smokeRecord(payload).id === 1 && Array.isArray(smokeRecord(payload).result) && smokeArray(smokeRecord(payload).result).includes('book.BTC-PERPETUAL.10.20.100ms') && smokeRecord(payload).params == null,
    isSnapshot: (payload: unknown) => Boolean(smokeRecord(smokeRecord(smokeRecord(payload).params).data).bids || smokeRecord(smokeRecord(smokeRecord(payload).params).data).asks),
    isDelta: () => false,
    requiresDelta: false,
    subscribe: (request: LiveFeedRequest) => ({ jsonrpc: '2.0', id: 1, method: 'public/subscribe', params: { channels: request.args } }),
  }),
});

function nowMs() { return Date.now(); }

function decodeFrame(raw: unknown): unknown {
  if (typeof raw === 'string') {
    const text = raw.trim();
    if (text === 'ping' || text === 'pong') return text;
    return JSON.parse(text);
  }
  if (raw instanceof Uint8Array || Buffer.isBuffer(raw)) return decodeFrame(Buffer.from(raw).toString('utf8'));
  return raw;
}

function errorText(error: unknown) {
  const text = error instanceof Error ? error.message : String(error);
  return text.replaceAll(/\s+/g, ' ').slice(0, 240);
}

function providerError(definition: PublicSmokeDefinition, payload: unknown) {
  if (smokeRecord(payload).event === 'error') return `${definition.venue} websocket error: ${smokeRecord(payload).msg ?? smokeRecord(payload).message ?? 'provider error'}`;
  if (smokeRecord(payload).error) return `${definition.venue} websocket error: ${smokeRecord(smokeRecord(payload).error).message ?? smokeRecord(payload).error}`;
  if (smokeRecord(payload).code != null && !['0', '00000'].includes(String(smokeRecord(payload).code))) return `${definition.venue} acknowledgement error ${String(smokeRecord(payload).code).slice(0, 80)}`;
  return null;
}

function sendPong(socket: LiveFeedSocket, frame: unknown) {
  if (frame === 'ping') socket.send?.('pong');
  if (smokeRecord(frame).op === 'ping') socket.send?.(JSON.stringify({ op: 'pong' }));
}

function connectRequest(definition: PublicSmokeDefinition): LiveFeedRequest {
  const request = definition.build();
  return { ...request, url: definition.url };
}

function emptyConnection(index: number): PublicSmokeConnection {
  return {
    index,
    subscribeAck: false,
    wireSnapshots: 0,
    wireDeltas: 0,
    normalizedSnapshots: 0,
    normalizedDeltas: 0,
    routedSnapshots: 0,
    routedDeltas: 0,
    closeObserved: false,
    closeTimedOut: false,
    coverage: null,
    units: null,
    bidLevels: 0,
    askLevels: 0,
    sourceTimestamp: null,
    sequenceType: null,
  };
}

function waitForClose(socket: LiveFeedSocket, connection: PublicSmokeConnection, timeoutMs: number) {
  return new Promise<{ observed: boolean; timedOut: boolean }>(resolve => {
    let done = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const finish = (observed: boolean) => {
      if (done) return;
      done = true;
      if (timer) clearTimeout(timer);
      connection.closeObserved = observed;
      connection.closeTimedOut = !observed;
      resolve({ observed, timedOut: !observed });
    };
    socket.on?.('close', () => finish(true));
    timer = setTimeout(() => finish(false), timeoutMs);
  });
}

function withDeadline<Value>(task: () => Value | PromiseLike<Value>, { deadline, label, onTimeout, onLateValue }: { deadline: number; label: string; onTimeout?: () => unknown; onLateValue?: (value: Value) => unknown }) {
  const remaining = Math.max(1, deadline - Date.now());
  return new Promise<Value>((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try { onTimeout?.(); } catch { /* best effort cleanup */ }
      reject(new Error(label));
    }, remaining);
    Promise.resolve().then(task).then(value => {
      if (settled) {
        try { onLateValue?.(value); } catch { /* best effort cleanup */ }
        return;
      }
      settled = true;
      clearTimeout(timer);
      resolve(value);
    }, error => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    });
  });
}

async function observeConnection(definition: PublicSmokeDefinition, {
  transportFactory,
  index,
  timeoutMs,
  requireDelta,
}: { transportFactory: PublicSmokeTransportFactory; index: number; timeoutMs: number; requireDelta: boolean }) {
  const request = connectRequest(definition);
  const sessionToken = `${definition.venue}:smoke:${index}:${nowMs()}`;
  const connection = emptyConnection(index);
  const deadline = Date.now() + Math.max(1, Number(timeoutMs) || 1);
  let socket: LiveFeedSocket | null = null;
  let session = createPublicDepthSession({ venue: definition.venue, topic: definition.topic, instrumentId: definition.instrumentId, sessionToken });
  let settled = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let resolveObservation: ((value: PublicSmokeObservation) => void) | undefined;
  let rejectObservation: ((error: unknown) => void) | undefined;
  const observation = new Promise<PublicSmokeObservation>((resolve, reject) => {
    resolveObservation = resolve;
    rejectObservation = reject;
  });
  // Message/error handlers can run while transport.open() or send() is still
  // pending. Mark the promise handled immediately so an early socket error
  // cannot become an unhandled rejection before the later await.
  observation.catch(() => {});
  const fail = (error: unknown) => {
    if (settled) return;
    settled = true;
    if (timer) clearTimeout(timer);
    smokeRequired(rejectObservation)(error instanceof Error ? error : new Error(String(error)));
  };
  const maybeDone = () => {
    if (settled || !connection.subscribeAck || connection.routedSnapshots < 1) return;
    if (requireDelta && connection.routedDeltas < 1) return;
    settled = true;
    if (timer) clearTimeout(timer);
    smokeRequired(resolveObservation)({ connection, socket: smokeRequired(socket), session });
  };
  try {
    socket = await withDeadline(() => transportFactory({ venue: definition.venue, request, index }), {
      deadline,
      label: `${definition.venue} smoke timed out creating transport`,
      onLateValue: value => value?.close?.(),
    });
    socket.on?.('message', raw => {
      try {
        const frame = decodeFrame(raw);
        sendPong(smokeRequired(socket), frame);
        if (frame === 'pong' || frame === 'ping') return;
        const providerFailure = providerError(definition, frame);
        if (providerFailure) throw new Error(providerFailure);
        if (definition.isAck(frame)) {
          connection.subscribeAck = true;
          maybeDone();
          return;
        }
        if (!definition.matches(frame)) return;
        const looksLikeSnapshot = definition.isSnapshot
          ? definition.isSnapshot(frame)
          : String(smokeRecord(frame).action ?? '').toLowerCase() === 'snapshot';
        const looksLikeDelta = definition.isDelta
          ? definition.isDelta(frame)
          : String(smokeRecord(frame).action ?? '').toLowerCase() === 'update';
        if (looksLikeSnapshot) connection.wireSnapshots += 1;
        if (looksLikeDelta) connection.wireDeltas += 1;
        if (!looksLikeSnapshot && !looksLikeDelta) return;
        const update = definition.normalize(frame, nowMs());
        if (update.kind === 'depthSnapshot') connection.normalizedSnapshots += 1;
        if (update.kind === 'depthDelta') connection.normalizedDeltas += 1;
        const routed = applyPublicDepthSessionMessage(session, { topic: definition.topic, sessionToken, update });
        session = routed.session;
        if (!routed.accepted) {
          if (routed.reason === 'resync-required') throw new Error(`session rejected live update: ${session.invalidReason ?? 'resync required'}`);
          return;
        }
        const book = smokeRequired(session.book);
        if (update.kind === 'depthSnapshot') connection.routedSnapshots += 1;
        if (update.kind === 'depthDelta') connection.routedDeltas += 1;
        connection.coverage = 'coverage' in book ? book.coverage ?? null : null;
        connection.units = 'units' in book ? book.units ?? null : null;
        connection.bidLevels = Array.isArray(smokeRequired(book).bids) ? smokeRequired(book).bids.length : 0;
        connection.askLevels = Array.isArray(smokeRequired(book).asks) ? smokeRequired(book).asks.length : 0;
        connection.sourceTimestamp = typeof book.sourceTimestamp === 'number' && Number.isFinite(book.sourceTimestamp) ? book.sourceTimestamp : null;
        connection.sequenceType = typeof smokeRequired(book).sequence;
        maybeDone();
      } catch (error) {
        fail(error);
      }
    });
    socket.on?.('error', error => fail(new Error(`${definition.venue} websocket error: ${errorText(error)}`)));
    await withDeadline(() => smokeRequired(socket).open?.(), {
      deadline,
      label: `${definition.venue} smoke timed out opening transport`,
      onTimeout: () => socket?.close?.(),
    });
    timer = setTimeout(() => {
      fail(new Error(`${definition.venue} smoke timed out before acknowledgement/snapshot/update`));
      try { socket?.close?.(); } catch { /* best effort */ }
    }, Math.max(1, deadline - Date.now()));
    const subscription = definition.subscribe ? definition.subscribe(request) : { op: 'subscribe', args: request.args };
    await withDeadline(() => smokeRequired(socket).send?.(JSON.stringify(subscription)), {
      deadline,
      label: `${definition.venue} smoke timed out sending subscription`,
      onTimeout: () => {
        fail(new Error(`${definition.venue} smoke timed out sending subscription`));
        try { socket?.close?.(); } catch { /* best effort */ }
      },
    });
    const result = await observation;
    const closeWait = waitForClose(result.socket, result.connection, Math.min(2_000, timeoutMs));
    result.socket.close?.();
    const closeResult = await closeWait;
    if (!closeResult.observed) {
      const closeError = new Error(`${definition.venue} socket close was not observed before bounded close timeout`);
      Object.assign(closeError, { connection: result.connection });
      throw closeError;
    }
    return result;
  } catch (error) {
    if (error && typeof error === 'object' && !smokeRecord(error).connection) smokeRecord(error).connection = connection;
    try { socket?.close?.(); } catch { /* best effort */ }
    throw error;
  }
}

async function observeProvider(definition: PublicSmokeDefinition, {
  transportFactory,
  timeoutMs,
  reconnectTimeoutMs,
}: { transportFactory: PublicSmokeTransportFactory; timeoutMs: number; reconnectTimeoutMs: number }): Promise<PublicSmokeProviderReport> {
  let first;
  try {
    first = await observeConnection(definition, { transportFactory, index: 0, timeoutMs, requireDelta: definition.requiresDelta ?? true });
  } catch (error) {
    smokeRecord(error).observed = { initial: smokeRecord(error).connection };
    throw error;
  }
  let second;
  try {
    second = await observeConnection(definition, { transportFactory, index: 1, timeoutMs: reconnectTimeoutMs, requireDelta: false });
  } catch (error) {
    smokeRecord(error).observed = { initial: first.connection, reconnect: smokeRecord(error).connection };
    throw error;
  }
  return {
    venue: definition.venue,
    symbol: definition.symbol,
    endpoint: definition.url,
    status: 'read-only-live-observation',
    observed: {
      subscribeAck: first.connection.subscribeAck && second.connection.subscribeAck,
      initial: first.connection,
      reconnect: second.connection,
      reconnectSnapshot: second.connection.routedSnapshots > 0,
    },
    limits: [
      'Public unauthenticated BTC perpetual depth only.',
      'Counts and metadata are recorded; raw provider frames and level amounts are intentionally discarded.',
      'The second connection is a bounded reconnect observation, not a long-run reliability or latency measurement.',
    ],
  };
}

export async function runPublicDepthLiveSmoke({
  providers = Object.keys(DEFINITIONS),
  timeoutMs = DEFAULT_TIMEOUT_MS,
  reconnectTimeoutMs = DEFAULT_RECONNECT_TIMEOUT_MS,
  transportFactory = ({ request, venue }) => createWsTransport({ request, venue }),
  now = () => new Date().toISOString(),
}: PublicDepthSmokeOptions = {}) {
  const startedAt = now();
  const results: PublicSmokeProviderReport[] = [];
  for (const name of providers) {
    const definition = DEFINITIONS[name];
    if (!definition) {
      results.push({ venue: name, status: 'failed-bounded-observation', error: `unknown provider ${name}` });
      continue;
    }
    try {
      results.push(await observeProvider(definition, { transportFactory, timeoutMs, reconnectTimeoutMs }));
    } catch (error) {
      results.push({
        venue: definition.venue,
        symbol: definition.symbol,
        endpoint: definition.url,
        status: 'failed-bounded-observation',
        error: errorText(error),
        ...(smokeRecord(error).observed ? { observed: smokeRecord(error).observed } : {}),
        limits: [
          'A failed observation does not claim the provider is unavailable globally; it records this machine/network attempt only.',
          'No raw provider frames or level amounts are written.',
        ],
      });
    }
  }
  return {
    schema: 'liquidity-mapper-fast.public-depth-live-smoke.v1',
    startedAt,
    finishedAt: now(),
    mode: 'public-read-only',
    providers: results,
    status: results.length > 0 && results.every(result => result.status === 'read-only-live-observation') ? 'read-only-live-observation' : 'failed-bounded-observation',
  };
}

async function main() {
  const artifact = await runPublicDepthLiveSmoke();
  const output = process.env.PUBLIC_DEPTH_SMOKE_OUTPUT ?? path.resolve(process.cwd(), 'docs/acceptance/visual-parity/m9-venues/okx-bitget-live-smoke-2026-09-13.json');
  await fs.mkdir(path.dirname(output), { recursive: true });
  await fs.writeFile(output, `${JSON.stringify(artifact, null, 2)}\n`, 'utf8');
  console.log(JSON.stringify({ output, status: artifact.status, providers: artifact.providers.map(({ venue, status, error }) => ({ venue, status, ...(error ? { error } : {}) })) }, null, 2));
  if (artifact.status !== 'read-only-live-observation') process.exitCode = 2;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
