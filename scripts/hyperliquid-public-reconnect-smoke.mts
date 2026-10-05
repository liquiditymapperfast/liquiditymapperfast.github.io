#!/usr/bin/env node
import { smokeRecord, smokeArray, smokeRequired, smokeFrameText } from './smoke-boundaries.mts';
import type { LiveFeedTransportOptions } from '../src/server/live-feeds.mts';
interface HlSmokeConnection { feedId: string | undefined; ordinal: number; transport: Awaited<ReturnType<typeof createWsTransport>>; openedAt: number | null; closedAt: number | null; subscriptionResponses: number; wireBooks: number; parsedBooks: number }
interface HlObservation { at: number; [key: string]: unknown }
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { LiveFeedManager, createWsTransport } from '../src/server/live-feeds.mts';
import { createLocalServer } from '../src/server/http.mts';
import { HistoryStore } from '../src/server/history.mts';
import { QuotaLedger } from '../src/core/quota.mts';

const instrumentId = 'hyperliquid:BTC-PERP';
const coarseKey = `${instrumentId}|sig:2`;
const nativeKey = `${instrumentId}|native`;
const outputPath = path.resolve(process.cwd(), 'data/runtime/hyperliquid-public-reconnect.json');
const startedAt = Date.now();
const connections: HlSmokeConnection[] = [];
const statusTransitions: { feedId: string; state: string | undefined; at: number; attempt: number | null }[] = [];
const observations: { invalidation: HlObservation | null; initial: HlObservation | null; restored: HlObservation | null } = { invalidation: null, initial: null, restored: null };
const errors: string[] = [];
let inducedFault: { at: number; targetOrdinal: number } | null = null;
let manager: LiveFeedManager | undefined;
let app: ReturnType<typeof createLocalServer> | undefined;
const cleanup = { ownedSocketsClosed: false, serverClosed: false };

class InertSocket {
  async open() {}
  send() {}
  close() {}
  on() {}
}

async function waitFor(predicate: () => unknown, timeoutMs: number) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return Boolean(predicate());
}

async function startWithin(manager: LiveFeedManager, timeoutMs: number) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      manager.start({ coin: 'BTC', hlBookNsigFigs: 2 }).then(() => true),
      new Promise<boolean>((resolve) => { timer = setTimeout(() => resolve(false), timeoutMs); }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function bookSummary(value: unknown) {
  const book = smokeRecord(value);
  return value ? {
    resolutionKey: book.resolutionKey ?? null,
    complete: book.complete === true,
    gap: book.gap === true,
    sourceTimestamp: book.sourceTimestamp ?? null,
    bids: smokeArray(book.bids).length,
    asks: smokeArray(book.asks).length,
    coverage: book.coverage ?? null,
  } : null;
}

function connectionSummary(connection: HlSmokeConnection) {
  return {
    feedId: connection.feedId, ordinal: connection.ordinal,
    openedAt: connection.openedAt, closedAt: connection.closedAt,
    subscriptionResponses: connection.subscriptionResponses,
    wireBooks: connection.wireBooks, parsedBooks: connection.parsedBooks,
  };
}

const transportFactory = async (spec: LiveFeedTransportOptions) => {
  if (!['hl-l2Book-native', 'hl-l2Book'].includes(String(spec.id))) return new InertSocket();
  const transport = await createWsTransport({ venue: spec.venue, request: spec.request });
  const connection: HlSmokeConnection = {
    feedId: spec.id,
    ordinal: connections.filter((item) => item.feedId === spec.id).length + 1,
    transport, openedAt: null, closedAt: null,
    subscriptionResponses: 0, wireBooks: 0, parsedBooks: 0,
  };
  connections.push(connection);
  transport.on('open', () => { connection.openedAt = Date.now(); });
  transport.on('message', (raw) => {
    try {
      const frame = smokeRecord(JSON.parse(smokeFrameText(raw)) as unknown);
      if (frame?.channel === 'subscriptionResponse') connection.subscriptionResponses += 1;
      if (frame?.channel === 'l2Book' && smokeRecord(frame.data).coin === 'BTC') connection.wireBooks += 1;
    } catch { /* Keep only bounded metadata, never raw public frames. */ }
  });
  transport.on('close', () => { connection.closedAt = Date.now(); });
  return transport;
};

let stages = { started: false, initialBooks: false, faultObserved: false, nativeFallback: false, replacementBook: false };
try {
  const activeApp = createLocalServer({ liveMode: true, persistFixture: false, quota: new QuotaLedger(), history: new HistoryStore({ filePath: ':memory:' }) });
  app = activeApp;
  activeApp.state.bookSelection[instrumentId] = 'sig:2';
  manager = new LiveFeedManager({
    networkEnabled: true, transportFactory, oiPollMs: 0,
    onMessage: ({ venue, message }) => {
      activeApp.applyMessage(message, venue);
      if (message.kind !== 'depthSnapshot' || message.instrumentId !== instrumentId) return;
      const feedId = message.resolutionKey === 'native' ? 'hl-l2Book-native' : 'hl-l2Book';
      const current = connections.filter((item) => item.feedId === feedId).at(-1);
      if (current && message.invalidated !== true) current.parsedBooks += 1;
      if (message.bookKey === coarseKey && message.gap === true) {
        const nativeConnection = connections.filter((item) => item.feedId === 'hl-l2Book-native').at(-1);
        observations.invalidation = {
          at: Date.now(), coarse: bookSummary(activeApp.state.booksByKey[coarseKey]),
          selected: bookSummary(activeApp.state.books[instrumentId]),
          venueStatus: activeApp.state.statuses.hyperliquid?.state ?? null,
          nativeSocketOpen: nativeConnection?.transport.socket?.readyState === 1,
          nativeFeedState: statusTransitions.filter((item) => item.feedId === 'hl-l2Book-native').at(-1)?.state ?? null,
        };
      }
    },
    onStatus: (status) => {
      if (!['hl-l2Book-native', 'hl-l2Book'].includes(status.id)) return;
      if (statusTransitions.length < 50) statusTransitions.push({ feedId: status.id, state: status.state, at: Date.now(), attempt: status.attempt ?? null });
    },
  });
  stages.started = await startWithin(manager, 20_000);
  if (!stages.started) throw new Error('manager startup exceeded 20 seconds');

  stages.initialBooks = await waitFor(() => {
    const native = activeApp.state.booksByKey[nativeKey];
    const coarse = activeApp.state.booksByKey[coarseKey];
    const nativeWire = connections.find((item) => item.feedId === 'hl-l2Book-native');
    const coarseWire = connections.find((item) => item.feedId === 'hl-l2Book');
    return native?.complete === true && coarse?.complete === true && native.bids?.length > 0 && coarse.bids?.length > 0
      && nativeWire?.openedAt && coarseWire?.openedAt
      && nativeWire.subscriptionResponses > 0 && coarseWire.subscriptionResponses > 0
      && nativeWire.wireBooks > 0 && coarseWire.wireBooks > 0
      && activeApp.state.books[instrumentId]?.resolutionKey === 'sig:2';
  }, 20_000);
  if (!stages.initialBooks) throw new Error('native/coarse public books did not become healthy within 20 seconds');
  observations.initial = {
    at: Date.now(), native: bookSummary(activeApp.state.booksByKey[nativeKey]),
    coarse: bookSummary(activeApp.state.booksByKey[coarseKey]),
    selected: bookSummary(activeApp.state.books[instrumentId]),
  };

  const firstCoarse = connections.find((item) => item.feedId === 'hl-l2Book');
  if (!firstCoarse?.transport?.socket) throw new Error('owned coarse public socket was not available');
  if (connections.filter((item) => item.feedId === 'hl-l2Book').length !== 1
    || firstCoarse.closedAt != null || firstCoarse.transport.socket.readyState !== 1
    || statusTransitions.some((item) => item.feedId === 'hl-l2Book' && item.state === 'backoff')) {
    throw new Error('first coarse socket was no longer the sole healthy generation before fault injection');
  }
  const fault = { at: Date.now(), targetOrdinal: firstCoarse.ordinal };
  inducedFault = fault;
  firstCoarse.transport.socket.terminate();

  stages.faultObserved = await waitFor(() => Boolean(firstCoarse.closedAt != null && firstCoarse.closedAt >= fault.at
    && observations.invalidation?.at != null && observations.invalidation.at >= fault.at
    && statusTransitions.some((item) => item.feedId === 'hl-l2Book' && item.state === 'backoff' && item.at >= fault.at)), 10_000);
  stages.nativeFallback = smokeRecord(observations.invalidation?.coarse)?.complete === false
    && smokeRecord(observations.invalidation?.coarse)?.gap === true
    && smokeRecord(observations.invalidation?.coarse)?.sourceTimestamp == null
    && smokeRecord(observations.invalidation?.selected)?.resolutionKey === 'native'
    && smokeRecord(observations.invalidation?.selected)?.complete === true
    && observations.invalidation?.nativeSocketOpen === true
    && observations.invalidation?.nativeFeedState === 'live'
    && observations.invalidation?.venueStatus === 'unavailable';

  stages.replacementBook = await waitFor(() => {
    const replacement = connections.find((item) => item.feedId === 'hl-l2Book' && item.ordinal === firstCoarse.ordinal + 1);
    return Boolean(stages.faultObserved && replacement?.openedAt != null && firstCoarse.closedAt != null && replacement.openedAt > firstCoarse.closedAt
      && replacement.openedAt > fault.at && replacement.subscriptionResponses > 0
      && replacement.wireBooks > 0 && replacement.parsedBooks > 0
      && activeApp.state.booksByKey[coarseKey]?.complete === true
      && activeApp.state.books[instrumentId]?.resolutionKey === 'sig:2'
      && activeApp.state.statuses.hyperliquid?.state === 'live');
  }, 25_000);
  if (stages.replacementBook) observations.restored = {
    at: Date.now(), coarse: bookSummary(activeApp.state.booksByKey[coarseKey]),
    selected: bookSummary(activeApp.state.books[instrumentId]),
    venueStatus: activeApp.state.statuses.hyperliquid?.state ?? null,
  };
} catch (error) {
  errors.push(String(smokeRecord(error).message ?? error));
} finally {
  try { manager?.stop(); } catch (error) { errors.push(`manager cleanup: ${smokeRecord(error).message ?? error}`); }
  for (const connection of connections) {
    try { connection.transport.socket?.terminate(); } catch { /* owned socket cleanup */ }
  }
  cleanup.ownedSocketsClosed = await waitFor(() => connections.every((connection) => connection.closedAt != null), 3_000);
  try { await app?.close(); cleanup.serverClosed = true; } catch (error) { errors.push(`server cleanup: ${smokeRecord(error).message ?? error}`); }
}

const passed = Object.values(stages).every(Boolean) && Object.values(cleanup).every(Boolean) && errors.length === 0;
const report = {
  kind: 'hyperliquid-public-manager-reconnect',
  checkedAt: new Date().toISOString(), elapsedMs: Date.now() - startedAt,
  passed, readOnly: true, credentials: 'none', paidProviderRequests: 0,
  fault: 'client-induced terminate() of one owned public coarse WebSocket', inducedFault,
  stages, cleanup, observations, statusTransitions,
  connections: connections.map(connectionSummary), errors,
  limits: [
    'The disconnect was induced locally on an owned client socket, not by the exchange.',
    'This bounded probe does not prove spontaneous exchange-side disconnects, long-run stability, browser recovery, or production process RSS.',
    'Only native and sig:2 Hyperliquid books used public wire connections; other manager feeds were inert.',
  ],
};
await fs.mkdir(path.dirname(outputPath), { recursive: true });
await fs.writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify({ outputPath, passed, stages, cleanup, errors, connections: report.connections }, null, 2));
if (!passed) process.exitCode = 1;
