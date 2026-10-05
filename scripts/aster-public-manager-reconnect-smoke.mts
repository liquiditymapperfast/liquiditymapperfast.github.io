#!/usr/bin/env node
import { smokeRecord, smokeArray, smokeRequired, smokeFrameText } from './smoke-boundaries.mts';
import type { LiveFeedTransportOptions, LiveNormalizedMessage } from '../src/server/live-feeds.mts';
interface AsterControlRequest { method: string; id: string; params: string[]; sentAt: number; acknowledgedAt: number | null }
interface AsterConnection {
  feedId: string | undefined; ordinal: number; endpoint: string; transport: Awaited<ReturnType<typeof createWsTransport>>;
  openedAt: number | null; closedAt: number | null; closeCode: number | null;
  controlRequests: AsterControlRequest[]; subscriptionAcknowledgements: number; unsubscriptionAcknowledgements: number;
  unmatchedAcknowledgements: number; wireAggregateTrades: number; parsedTrades: number; matchedTrades: number; wireTradeIds: Set<string>;
  lastWireTrade: { tradeId: string; sourceTimestamp: number | null; eventTimestamp: number | null; symbol: string } | null;
  lastParsedTrade: ReturnType<typeof normalizedTradeSummary> | null; matchedTrade: ReturnType<typeof normalizedTradeSummary> | null;
}
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { LiveFeedManager, createWsTransport } from '../src/server/live-feeds.mts';
import { ASTER_PUBLIC_WS_URL, buildAsterRequest } from '../src/adapters/aster.mts';

const symbol = 'BTCUSDT';
const metadataRequest = buildAsterRequest('exchangeInfo');
const outputPath = path.resolve(process.cwd(), 'docs/acceptance/visual-parity/m9-venues/m9-08-aster-manager-reconnect-evidence-2026-09-22.json');
const startedAt = Date.now();
const connections: AsterConnection[] = [];
const statusTransitions: { at: number; state: string | undefined; attempt: number; subscriptionAcked: boolean; subscriptionAckSource: unknown; lastError: unknown }[] = [];
const errors: string[] = [];
const restBoundary = { asterExchangeInfoCalls: 0, suppressedNonAsterCalls: 0, suppressedVenues: [] as string[] };
const metadata: { status: string | null | undefined; asset: Record<string, unknown> | null } = { status: null, asset: null };
const stages = {
  metadataValidated: false,
  initialAckAndParsedTrade: false,
  localCloseObserved: false,
  managerBackoffObserved: false,
  replacementOpened: false,
  replacementAckAndParsedTrade: false,
  healthyAfterReplacement: false,
};
const cleanup = { managerStopped: false, allSocketsClosedBeforeFallback: false, replacementClosedCleanly: false, fallbackTerminatedOrdinals: [] as number[], ownedSocketsClosed: false };
let manager: LiveFeedManager | undefined;
let inducedFault: { at: number; targetOrdinal: number; action: string } | null = null;

class InertSocket {
  async open() {}
  send() {}
  close() {}
  on() {}
}

function timestamp(value: unknown) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : null;
}

function normalizedTradeSummary(message: LiveNormalizedMessage, ordinal: number) {
  return {
    connectionOrdinal: ordinal,
    tradeId: message.tradeId,
    side: message.side,
    price: message.price,
    amount: message.amount,
    notionalUsd: message.notionalUsd,
    sourceTimestamp: timestamp(message.sourceTimestamp),
    receivedAt: timestamp(message.receivedAt),
    sourceReceiptDeltaMs: timestamp(message.sourceTimestamp) == null || timestamp(message.receivedAt) == null
      ? null : smokeRequired(timestamp(message.sourceTimestamp)) - smokeRequired(timestamp(message.receivedAt)),
  };
}

function connectionSummary(connection: AsterConnection) {
  return {
    feedId: connection.feedId,
    ordinal: connection.ordinal,
    endpoint: connection.endpoint,
    openedAt: connection.openedAt,
    closedAt: connection.closedAt,
    closeCode: connection.closeCode,
    outboundControlFrames: connection.controlRequests.map(({ method, id, params, sentAt, acknowledgedAt }) => ({ method, id, params, sentAt, acknowledgedAt })),
    subscriptionAcknowledgements: connection.subscriptionAcknowledgements,
    unsubscriptionAcknowledgements: connection.unsubscriptionAcknowledgements,
    unmatchedAcknowledgements: connection.unmatchedAcknowledgements,
    wireAggregateTrades: connection.wireAggregateTrades,
    parsedTrades: connection.parsedTrades,
    matchedTrades: connection.matchedTrades,
    lastWireTrade: connection.lastWireTrade,
    lastParsedTrade: connection.lastParsedTrade,
    matchedTrade: connection.matchedTrade,
  };
}

async function waitFor(predicate: () => unknown, timeoutMs: number) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  return Boolean(predicate());
}

function jsonFrame(raw: unknown): Record<string, unknown> | null {
  try { const parsed: unknown = JSON.parse(smokeFrameText(raw)); return parsed != null && typeof parsed === 'object' ? smokeRecord(parsed) : null; } catch { return null; }
}

const transportFactory = async (spec: LiveFeedTransportOptions) => {
  if (spec.id !== 'aster-trades') return new InertSocket();
  const transport = await createWsTransport({ venue: spec.venue, request: spec.request });
  const connection: AsterConnection = {
    feedId: spec.id,
    ordinal: connections.length + 1,
    endpoint: spec.request?.url ?? ASTER_PUBLIC_WS_URL,
    transport,
    openedAt: null,
    closedAt: null,
    closeCode: null,
    controlRequests: [],
    subscriptionAcknowledgements: 0,
    unsubscriptionAcknowledgements: 0,
    unmatchedAcknowledgements: 0,
    wireAggregateTrades: 0,
    parsedTrades: 0,
    matchedTrades: 0,
    wireTradeIds: new Set(),
    lastWireTrade: null,
    lastParsedTrade: null,
    matchedTrade: null,
  };
  connections.push(connection);
  const send = transport.send;
  transport.send = payload => {
    const frame = jsonFrame(payload);
    const method = String(frame?.method ?? '').toUpperCase();
    if (['SUBSCRIBE', 'UNSUBSCRIBE'].includes(method)
      && String(frame?.id ?? '') === String(spec.request?.id ?? '')) {
      connection.controlRequests.push({
        method,
        id: String(frame?.id),
        params: smokeArray(frame?.params).map(String),
        sentAt: Date.now(),
        acknowledgedAt: null,
      });
    }
    return send(payload);
  };
  transport.on('open', () => { connection.openedAt = Date.now(); });
  transport.on('message', raw => {
    const frame = jsonFrame(raw);
    if (!frame) return;
    if (frame.result === null && String(frame.id ?? '') === String(spec.request?.id ?? '')) {
      const pending = connection.controlRequests.find(item => item.acknowledgedAt == null && item.id === String(frame.id));
      if (!pending) connection.unmatchedAcknowledgements += 1;
      else {
        pending.acknowledgedAt = Date.now();
        if (pending.method === 'SUBSCRIBE') connection.subscriptionAcknowledgements += 1;
        else if (pending.method === 'UNSUBSCRIBE') connection.unsubscriptionAcknowledgements += 1;
      }
      return;
    }
    const data = smokeRecord(frame.data ?? frame);
    if (String(data?.e ?? '') !== 'aggTrade' || String(data?.s ?? '').toUpperCase() !== symbol) return;
    const aggregateId = data?.a;
    if (aggregateId == null) return;
    const tradeId = `${symbol}:${aggregateId}`;
    connection.wireAggregateTrades += 1;
    connection.wireTradeIds.add(tradeId);
    if (connection.wireTradeIds.size > 128) connection.wireTradeIds.delete(smokeRequired(connection.wireTradeIds.values().next().value));
    connection.lastWireTrade = {
      tradeId,
      sourceTimestamp: timestamp(data?.T),
      eventTimestamp: timestamp(data?.E),
      symbol: String(data.s).toUpperCase(),
    };
  });
  transport.on('close', (code) => {
    connection.closedAt = Date.now();
    connection.closeCode = Number.isFinite(Number(code)) ? Number(code) : null;
  });
  return transport;
};

try {
  manager = new LiveFeedManager({
    networkEnabled: true,
    transportFactory,
    reconnectBaseMs: 750,
    reconnectMaxMs: 750,
    oiPollMs: 0,
    oiHistoryLimit: 0,
    restTransport: {
      async request(request, context) {
        const requestUrl = String(request?.url ?? '');
        if (requestUrl === metadataRequest.url) {
          restBoundary.asterExchangeInfoCalls += 1;
          const response = await fetch(requestUrl, {
            method: request.method ?? 'GET',
            headers: request.headers ?? { accept: 'application/json' },
            signal: AbortSignal.timeout(12_000),
          });
          if (!response.ok) throw new Error(`Aster exchangeInfo HTTP ${response.status}`);
          return response.json();
        }
        restBoundary.suppressedNonAsterCalls += 1;
        const venue = String(context?.venue ?? 'unknown');
        if (!restBoundary.suppressedVenues.includes(venue)) restBoundary.suppressedVenues.push(venue);
        return {};
      },
    },
    onMessage: ({ id, message }) => {
      if (id === 'aster-metadata' && message?.kind === 'metadata') {
        const asset = message.assets?.find(row => String(row.nativeSymbol).toUpperCase() === symbol);
        metadata.status = asset ? 'snapshot' : 'unavailable';
        metadata.asset = asset ? {
          instrumentId: asset.instrumentId,
          nativeSymbol: asset.nativeSymbol,
          marketType: asset.marketType,
          contractType: asset.contractType,
          status: asset.status,
          isDelisted: asset.isDelisted,
          tickSize: asset.tickSize,
          lotSize: asset.lotSize,
          metadataSource: asset.metadataSource,
        } : null;
        return;
      }
      if (id !== 'aster-trades' || message?.kind !== 'trade') return;
      const connection = connections.at(-1);
      if (!connection) return;
      connection.parsedTrades += 1;
      connection.lastParsedTrade = normalizedTradeSummary(message, connection.ordinal);
      if (connection.wireTradeIds.has(String(message.tradeId))) {
        connection.matchedTrades += 1;
        connection.matchedTrade = connection.lastParsedTrade;
      }
    },
    onStatus: status => {
      if (status.id === 'aster-metadata') metadata.status = status.state;
      if (status.id !== 'aster-trades' || statusTransitions.length >= 80) return;
      statusTransitions.push({
        at: Date.now(),
        state: status.state,
        attempt: status.attempt ?? 0,
        subscriptionAcked: status.subscriptionAcked === true,
        subscriptionAckSource: status.subscriptionAckSource ?? null,
        lastError: status.lastError ?? null,
      });
    },
  });

  await manager.start({ asterEnabled: true, asterSymbol: symbol });
  const selectedAsset = metadata.asset;
  stages.metadataValidated = restBoundary.asterExchangeInfoCalls > 0
    && selectedAsset?.instrumentId === 'aster:BTCUSDT'
    && selectedAsset.marketType === 'perpetual'
    && selectedAsset.status === 'online'
    && selectedAsset.isDelisted === false;
  if (!stages.metadataValidated) throw new Error('Aster public exchangeInfo did not validate BTCUSDT as an active perpetual');

  stages.initialAckAndParsedTrade = await waitFor(() => {
    const initial = connections[0];
    return Boolean(initial?.openedAt && initial.subscriptionAcknowledgements > 0 && initial.parsedTrades > 0 && initial.matchedTrades > 0
      && smokeRequired(manager).status()['aster-trades']?.subscriptionAcked === true);
  }, 25_000);
  if (!stages.initialAckAndParsedTrade) throw new Error('initial Aster session did not produce an exact subscription acknowledgement and a manager-parsed public trade within 25 seconds');

  const initial = connections[0];
  const readyStatus = manager.status()['aster-trades'];
  if (!initial.transport.socket || initial.closedAt != null || initial.transport.socket.readyState !== 1 || readyStatus?.subscriptionAcked !== true) {
    throw new Error('initial Aster session was not the sole healthy socket before local fault injection');
  }
  const fault = { at: Date.now(), targetOrdinal: initial.ordinal, action: 'client-side terminate() on the owned public WebSocket' };
  inducedFault = fault;
  initial.transport.socket.terminate();

  stages.localCloseObserved = await waitFor(() => initial.closedAt != null && initial.closedAt >= fault.at, 8_000);
  stages.managerBackoffObserved = await waitFor(() => statusTransitions.some(item => item.state === 'backoff' && item.at >= fault.at), 8_000);
  if (!stages.localCloseObserved || !stages.managerBackoffObserved) throw new Error('the local socket termination did not produce both a close event and manager backoff');

  stages.replacementOpened = await waitFor(() => Boolean(connections[1]?.openedAt != null && initial.closedAt != null && smokeRequired(connections[1].openedAt) > initial.closedAt), 10_000);
  stages.replacementAckAndParsedTrade = await waitFor(() => {
    const replacement = connections[1];
    return Boolean(replacement?.openedAt != null && initial.closedAt != null && replacement.openedAt > initial.closedAt && replacement.subscriptionAcknowledgements > 0
      && replacement.parsedTrades > 0 && replacement.matchedTrades > 0
      && statusTransitions.some(item => item.state === 'live' && item.subscriptionAcked === true && item.at >= smokeRequired(replacement.openedAt)));
  }, 25_000);
  const restoredStatus = manager.status()['aster-trades'];
  stages.healthyAfterReplacement = stages.replacementAckAndParsedTrade
    && restoredStatus?.state === 'live' && restoredStatus?.subscriptionAcked === true;
  if (!stages.replacementOpened || !stages.replacementAckAndParsedTrade || !stages.healthyAfterReplacement) {
    throw new Error('replacement Aster session did not restore an exact acknowledgement and manager-parsed public trade');
  }
} catch (error) {
  errors.push(String(smokeRecord(error).message ?? error));
} finally {
  try {
    manager?.stop();
    cleanup.managerStopped = !manager || manager.status()['aster-trades']?.state === 'stopped';
  } catch (error) { errors.push(`manager cleanup: ${smokeRecord(error).message ?? error}`); }
  cleanup.allSocketsClosedBeforeFallback = await waitFor(() => connections.every(connection => connection.closedAt != null), 5_000);
  const replacement = connections.find(connection => connection.ordinal === 2);
  cleanup.replacementClosedCleanly = replacement?.closeCode === 1000;
  if (!cleanup.allSocketsClosedBeforeFallback) {
    for (const connection of connections) {
      if (connection.closedAt != null) continue;
      try {
        connection.transport.socket?.terminate();
        cleanup.fallbackTerminatedOrdinals.push(connection.ordinal);
      } catch { /* bounded fallback for an owned public socket */ }
    }
    cleanup.ownedSocketsClosed = await waitFor(() => connections.every(connection => connection.closedAt != null), 3_000);
  } else cleanup.ownedSocketsClosed = true;
}

const passed = Object.values(stages).every(Boolean) && Object.values(cleanup).every(Boolean) && errors.length === 0;
const report = {
  kind: 'aster-public-manager-reconnect',
  checkedAt: new Date().toISOString(),
  elapsedMs: Date.now() - startedAt,
  passed,
  readOnly: true,
  credentials: 'none',
  market: { venue: 'aster', marketType: 'perpetual', symbol, channel: 'aggTrade' },
  publicSources: { metadata: metadataRequest.url, websocket: ASTER_PUBLIC_WS_URL },
  networkBoundary: { ...restBoundary, realWebSocketConnections: connections.length },
  metadata,
  fault: inducedFault,
  stages,
  cleanup,
  statusTransitions,
  connections: connections.map(connectionSummary),
  errors,
  limits: [
    'The socket loss was induced locally with terminate(); this does not prove an exchange-initiated disconnect or network-path failure.',
    'The replacement session used the real public Aster WebSocket and required a fresh exact acknowledgement plus a fresh manager-parsed trade.',
    'Only Aster BTCUSDT perpetual aggTrade used a public wire connection; all other manager sockets were inert and non-Aster REST requests were suppressed.',
    'This bounded probe does not prove long-run stability, browser recovery, production process RSS, or unrelated venue recovery.',
  ],
};
await fs.mkdir(path.dirname(outputPath), { recursive: true });
await fs.writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify({ outputPath, passed, stages, cleanup, networkBoundary: report.networkBoundary, errors, connections: report.connections }, null, 2));
if (!passed) process.exitCode = 1;
