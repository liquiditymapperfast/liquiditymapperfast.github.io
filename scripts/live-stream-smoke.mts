#!/usr/bin/env node
import { smokeRecord, smokeArray } from './smoke-boundaries.mts';
import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

const args = new Map<string, string | true>();
for (const argument of process.argv.slice(2)) {
  const match = /^--([^=]+)(?:=(.*))?$/.exec(argument);
  if (match) args.set(match[1], match[2] ?? true);
}

function safeBaseUrl(raw: unknown) {
  const url = new URL(String(raw ?? 'http://127.0.0.1:8787'));
  url.username = '';
  url.password = '';
  url.search = '';
  url.hash = '';
  return url.toString().replace(/\/$/, '');
}

const baseUrl = safeBaseUrl(args.get('url') ?? process.env.HLM_SMOKE_URL ?? 'http://127.0.0.1:8787');
const sampleCount = Math.max(2, Math.min(60, Number(args.get('samples') ?? process.env.HLM_SMOKE_SAMPLES ?? 7) || 7));
const intervalMs = Math.max(250, Math.min(60_000, Number(args.get('interval-ms') ?? process.env.HLM_SMOKE_INTERVAL_MS ?? 5_000) || 5_000));
const output = path.resolve(String(args.get('output') ?? process.env.HLM_SMOKE_OUTPUT ?? 'docs/acceptance/visual-parity/m3-feeds/live-stream-smoke-current.json'));
const BOOK_IDS = ['hyperliquid:BTC-PERP', 'binance:BTCUSDT'];
const REQUIRED_FEEDS = ['hl-l2Book-native', 'hl-l2Book', 'binance-depth'];

async function getJson(pathname: string): Promise<unknown> {
  const response = await fetch(`${baseUrl}${pathname}`, { signal: AbortSignal.timeout(15_000) });
  if (!response.ok) throw new Error(`${pathname}: HTTP ${response.status}`);
  return response.json();
}

function finiteNumber(value: unknown) {
  if (value == null || (typeof value === 'string' && value.trim() === '')) return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function sideBounds(rows: unknown) {
  const prices = (Array.isArray(rows) ? rows : []).map((row) => finiteNumber(Array.isArray(row) ? row[0] : smokeRecord(row).price)).filter((value) => value != null);
  return prices.length ? { min: Math.min(...prices), max: Math.max(...prices), count: prices.length } : { min: null, max: null, count: 0 };
}

function boundsMatch(actual: ReturnType<typeof sideBounds>, reported: unknown) {
  return Boolean(reported) && actual.count > 0 && finiteNumber(smokeRecord(reported).min) === actual.min && finiteNumber(smokeRecord(reported).max) === actual.max;
}

function summarizeBook(value: unknown) {
  const book = smokeRecord(value);
  const bids = Array.isArray(book?.bids) ? book.bids : [];
  const asks = Array.isArray(book?.asks) ? book.asks : [];
  const actualBounds = { bids: sideBounds(bids), asks: sideBounds(asks) };
  const observedBounds = smokeRecord(book.observedBounds);
  return {
    complete: book?.complete === true,
    sequence: finiteNumber(book?.sequence),
    sequenceFinite: finiteNumber(book?.sequence) != null,
    bids: bids.length,
    asks: asks.length,
    nonEmptySides: bids.length > 0 && asks.length > 0,
    coverage: book?.coverage ?? null,
    resolution: book?.resolution ?? null,
    sourceTimestamp: finiteNumber(book?.sourceTimestamp),
    receivedAt: finiteNumber(book?.receivedAt),
    actualBounds,
    observedBounds,
    boundsMatch: { bids: boundsMatch(actualBounds.bids, observedBounds.bids), asks: boundsMatch(actualBounds.asks, observedBounds.asks) },
    sourceLevelCount: book?.sourceLevelCount ?? null,
    retentionTruncated: book?.retentionTruncated ?? null,
    representation: book?.representation ? {
      stage: smokeRecord(book.representation).stage ?? null,
      limitPerSide: smokeRecord(book.representation).limitPerSide ?? null,
      retainedLevelCount: smokeRecord(book.representation).retainedLevelCount ?? null,
      inputLevelCount: smokeRecord(book.representation).inputLevelCount ?? null,
    } : null,
  };
}

function summarizeStatuses(statuses: unknown = {}) {
  return Object.fromEntries(Object.entries(smokeRecord(statuses)).map(([name, value]) => [name, {
    state: smokeRecord(value).state ?? null,
    gaps: smokeRecord(value).gaps ?? null,
    lastSuccess: finiteNumber(smokeRecord(value).lastSuccess),
    hasError: smokeRecord(value).lastError != null,
  }]));
}

function summarizeFeedStatuses(statuses: unknown = {}) {
  return Object.fromEntries(Object.entries(smokeRecord(statuses)).map(([name, value]) => [name, {
    state: smokeRecord(value).state ?? null,
    attempt: smokeRecord(value).attempt ?? null,
    lastSuccess: finiteNumber(smokeRecord(value).lastSuccess),
    hasError: smokeRecord(value).lastError != null,
  }]));
}

function summarize(sample: { state: unknown; diagnostics: unknown }) {
  const state = smokeRecord(sample.state);
  const diagnostics = smokeRecord(sample.diagnostics);
  return {
    observedAt: new Date().toISOString(),
    dataMode: state?.dataMode ?? null,
    asOf: finiteNumber(state?.asOf),
    markPrice: finiteNumber(state?.markPrice),
    oiCount: Array.isArray(state?.oi) ? smokeArray(state.oi).length : 0,
    books: Object.fromEntries(Object.entries(smokeRecord(state.books)).map(([id, book]) => [id, summarizeBook(book)])),
    candles: Object.fromEntries(Object.entries(smokeRecord(state.candles)).map(([id, rows]) => [id, Array.isArray(rows) ? rows.length : 0])),
    statuses: summarizeStatuses(state?.statuses),
    feedStatuses: summarizeFeedStatuses(state?.feedStatuses),
    diagnostics: {
      logicalRetainedBytes: finiteNumber(smokeRecord(diagnostics?.serverRamBuffer)?.logicalRetainedBytes),
      pressure: smokeRecord(smokeRecord(diagnostics.serverRamBuffer).pressure).pressure ?? null,
      withinHardLimit: smokeRecord(diagnostics?.serverRamBuffer)?.withinHardLimit ?? null,
      processRssBytes: finiteNumber(smokeRecord(smokeRecord(diagnostics.serverRamBuffer).processMemory).rssBytes),
    },
  };
}

interface SequenceEvidence { count: number; first: number | null; last: number | null; changes: number }
function sequenceEvidence(): Record<string, SequenceEvidence> {
  return Object.fromEntries(BOOK_IDS.map((id) => [id, { count: 0, first: null, last: null, changes: 0 }]));
}

function recordSequence(map: Record<string, SequenceEvidence>, id: string, value: unknown) {
  const sequence = finiteNumber(value);
  if (sequence == null || !map[id]) return;
  const item = map[id];
  if (item.first == null) item.first = sequence;
  if (item.last != null && item.last !== sequence) item.changes += 1;
  item.last = sequence;
  item.count += 1;
}

interface TransportEvidence { connected: boolean; httpStatus: number | null; connectionFailed: boolean; eventCounts: Record<string, number>; stateSequences: Record<string, SequenceEvidence>; markSequences: SequenceEvidence; lastEventAt: string | null }
function createTransportEvidence(): TransportEvidence {
  return { connected: false, httpStatus: null, connectionFailed: false, eventCounts: {}, stateSequences: sequenceEvidence(), markSequences: { count: 0, first: null, last: null, changes: 0 }, lastEventAt: null };
}

function parseSseEvent(block: string): { event: string; payload: unknown } {
  const event = (block.match(/^event:\s*(.*)$/m)?.[1] ?? 'message').trim();
  const data = block.match(/^data:\s*(.*)$/m)?.[1] ?? '';
  if (!data) return { event, payload: null };
  try { return { event, payload: JSON.parse(data) }; } catch { return { event, payload: null }; }
}

async function consumeSse(response: Response, evidence: TransportEvidence, signal: AbortSignal) {
  const reader = response.body?.getReader();
  if (!reader) return;
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    while (!signal.aborted) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const blocks = buffer.split(/\r?\n\r?\n/);
      buffer = blocks.pop() ?? '';
      for (const block of blocks) {
        const { event, payload } = parseSseEvent(block);
        evidence.eventCounts[event] = (evidence.eventCounts[event] ?? 0) + 1;
        evidence.lastEventAt = new Date().toISOString();
        if (event === 'state') for (const [id, book] of Object.entries(smokeRecord(smokeRecord(payload).books))) recordSequence(evidence.stateSequences, id, smokeRecord(book).sequence);
        if (event === 'mark') {
          const sequence = finiteNumber(smokeRecord(payload).sequence);
          if (sequence != null) {
            if (evidence.markSequences.first == null) evidence.markSequences.first = sequence;
            if (evidence.markSequences.last != null && evidence.markSequences.last !== sequence) evidence.markSequences.changes += 1;
            evidence.markSequences.last = sequence;
            evidence.markSequences.count += 1;
          }
        }
      }
    }
  } catch {
    if (!signal.aborted) evidence.connectionFailed = true;
  } finally {
    try { await reader.cancel(); } catch { /* connection is already closing */ }
  }
}

const transport = createTransportEvidence();
const streamController = new AbortController();
let streamTask: Promise<void> | null = null;
try {
  const response = await fetch(`${baseUrl}/api/stream`, { headers: { accept: 'text/event-stream' }, signal: streamController.signal });
  transport.httpStatus = response.status;
  if (!response.ok) throw new Error(`stream HTTP ${response.status}`);
  transport.connected = true;
  streamTask = consumeSse(response, transport, streamController.signal);
} catch {
  transport.connectionFailed = true;
}

const samples: ReturnType<typeof summarize>[] = [];
for (let index = 0; index < sampleCount; index += 1) {
  const [state, diagnostics] = await Promise.all([getJson('/api/state?compact=1'), getJson('/api/diagnostics')]);
  samples.push(summarize({ state, diagnostics }));
  if (index + 1 < sampleCount) await new Promise((resolve) => setTimeout(resolve, intervalMs));
}

streamController.abort();
if (streamTask) await streamTask.catch(() => {});

const liveMode = samples.every((sample) => sample.dataMode === 'live');
const statusesAreLive = samples.every((sample) => ['hyperliquid', 'binance'].every((venue) => sample.statuses?.[venue]?.state === 'live'));
const requiredFeedsAreLive = samples.every((sample) => REQUIRED_FEEDS.every((id) => sample.feedStatuses?.[id]?.state === 'live' && sample.feedStatuses?.[id]?.hasError === false));
const hasCompleteBooks = samples.every((sample) => BOOK_IDS.every((id) => sample.books?.[id]?.complete === true && sample.books?.[id]?.nonEmptySides === true && sample.books?.[id]?.sequenceFinite === true));
const boundsAreTruthful = samples.every((sample) => BOOK_IDS.every((id) => sample.books?.[id]?.boundsMatch?.bids === true && sample.books?.[id]?.boundsMatch?.asks === true));
const sequenceAdvanced = Object.fromEntries(BOOK_IDS.map((id) => [id, Number(samples.at(-1)?.books?.[id]?.sequence) > Number(samples[0]?.books?.[id]?.sequence)]));
const noVenueErrors = samples.every((sample) => ['hyperliquid', 'binance'].every((venue) => sample.statuses?.[venue]?.hasError === false));
const representationCaps = Object.fromEntries(BOOK_IDS.map((id) => [id, samples.map((sample) => ({ retained: { bids: sample.books?.[id]?.bids ?? 0, asks: sample.books?.[id]?.asks ?? 0 }, source: sample.books?.[id]?.sourceLevelCount ?? null, retentionTruncated: sample.books?.[id]?.retentionTruncated ?? null }))]));
const sseSequencesAdvanced = Object.fromEntries(BOOK_IDS.map((id) => [id, (transport.stateSequences[id]?.count ?? 0) >= 2 && (transport.stateSequences[id]?.changes ?? 0) > 0]));
const streamedTransport = transport.connected && transport.connectionFailed === false && (transport.eventCounts.state ?? 0) >= 2 && BOOK_IDS.every((id) => sseSequencesAdvanced[id]);
const pass = liveMode && statusesAreLive && requiredFeedsAreLive && hasCompleteBooks && boundsAreTruthful && Object.values(sequenceAdvanced).every(Boolean) && noVenueErrors && streamedTransport;
const report = {
  generatedAt: new Date().toISOString(),
  startedAt: samples[0]?.observedAt ?? null,
  endedAt: samples.at(-1)?.observedAt ?? null,
  readOnly: true,
  scope: 'local live public Hyperliquid and Binance streams; bounded metadata only; no raw payloads or credentials',
  baseUrl,
  sampleCount: samples.length,
  intervalMs,
  transport,
  samples,
  acceptance: {
    passed: pass,
    dataModeLive: liveMode,
    allSamplesHaveLiveStatus: statusesAreLive,
    requiredDepthFeedsLive: requiredFeedsAreLive,
    allSamplesHaveCompleteBooks: hasCompleteBooks,
    boundsMatchReturnedRows: boundsAreTruthful,
    sequencesAdvanced: sequenceAdvanced,
    streamedTransport,
    noVenueErrors,
    representationCaps,
  },
};

await fs.mkdir(path.dirname(output), { recursive: true });
await fs.writeFile(output, `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify({ output, acceptance: report.acceptance }, null, 2));
if (!pass) process.exitCode = 1;
