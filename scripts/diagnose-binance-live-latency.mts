import fs from 'node:fs/promises';
import path from 'node:path';
import WebSocket from 'ws';

function object(value: unknown): Record<string, unknown> { if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('Expected a public diagnostic object'); return value as Record<string, unknown>; }
function finite(value: unknown): number { if (typeof value !== 'number' || !Number.isFinite(value)) throw new TypeError('Expected a finite public diagnostic number'); return value; }
function timestamp(value: unknown): number { const result = finite(value); if (!Number.isSafeInteger(result) || result <= 0) throw new TypeError('Expected a positive millisecond timestamp'); return result; }
interface WireTiming { receivedAt: number; eventTime: number; transactionTime: number; eventAgeMs: number; transactionAgeMs: number; sequence: number; previousSequence: number; firstUpdate: number; bytes: number; }
const artifact = process.env.HLM_BINANCE_DIAGNOSTIC_TAG;
if (!artifact || !/^[a-z0-9-]{1,64}$/.test(artifact)) throw new Error('A distinct HLM_BINANCE_DIAGNOSTIC_TAG is required');
const reportPath = path.join(process.cwd(), 'data', 'runtime', 'binance-native-latency-' + artifact + '.json');
const startedAt = new Date().toISOString(), samples: WireTiming[] = [], errors: string[] = [];
const endpoint = 'wss://fstream.binance.com/public/ws/btcusdt@depth@100ms';
let closed = false, closing = false, ignoredInFlightFrames = 0, openedAt: number | null = null;
const socket = new WebSocket(endpoint, { maxPayload: 1024 * 1024 });
const completion = new Promise<void>(resolve => {
  socket.once('open', () => { openedAt = Date.now(); }); socket.once('close', () => { closed = true; resolve(); });
  socket.on('error', error => { errors.push(error instanceof Error ? error.message : String(error)); socket.terminate(); });
  socket.on('message', raw => {
    if (closing) { ignoredInFlightFrames += 1; return; }
    const receivedAt = Date.now(), bytes = Buffer.byteLength(String(raw));
    try { const data = object(JSON.parse(String(raw)) as unknown);
      if (data.e !== 'depthUpdate' || data.s !== 'BTCUSDT') throw new TypeError('Unexpected configured depth event');
      const eventTime = timestamp(data.E), transactionTime = timestamp(data.T), sequence = timestamp(data.u), previousSequence = timestamp(data.pu), firstUpdate = timestamp(data.U);
      samples.push({ receivedAt, eventTime, transactionTime, eventAgeMs: receivedAt - eventTime, transactionAgeMs: receivedAt - transactionTime, sequence, previousSequence, firstUpdate, bytes });
      if (samples.length >= 20) { closing = true; socket.close(); }
    } catch (error) { errors.push(error instanceof Error ? error.message : String(error)); socket.terminate(); }
  });
});
const timer = setTimeout(() => socket.terminate(), 8000);
await completion; clearTimeout(timer);
let preview: Record<string, unknown> | null = null;
try {
  const response = await fetch('http://127.0.0.1:8787/api/state?compact=1', { signal: AbortSignal.timeout(4000) });
  if (!response.ok) throw new Error('Preview HTTP ' + response.status);
  const text = await response.text(); if (Buffer.byteLength(text) > 4 * 1024 * 1024) throw new Error('Preview JSON exceeded diagnostic cap');
  const state = object(JSON.parse(text) as unknown), books = object(state.books), book = object(books['binance:BTCUSDT']), feed = object(object(state.feedStatuses)['binance-depth']);
  const sourceTimestamp = timestamp(book.sourceTimestamp), now = Date.now();
  preview = { observedAt: now, sequence: finite(book.sequence), sourceTimestamp, sourceAgeMs: now - sourceTimestamp, status: typeof feed.state === 'string' ? feed.state : null, lastSuccess: typeof feed.lastSuccess === 'number' ? feed.lastSuccess : null, bids: Array.isArray(book.bids) ? book.bids.length : null, asks: Array.isArray(book.asks) ? book.asks.length : null };
} catch (error) { preview = { unavailable: true, reason: error instanceof Error ? error.message : String(error) }; }
const report = { kind: 'bounded-independent-binance-native-depth-latency', startedAt, checkedAt: new Date().toISOString(), endpoint, openedAt, samples, errors,
  cleanup: { socketClosed: closed, ignoredInFlightFrames }, preview, readOnly: true, credentials: 'none', orders: 0, paidProviderRequests: 0,
  officialSource: 'https://developers.binance.com/en/docs/derivatives/usds-margined-futures/websocket-market-streams/Diff-Book-Depth-Streams',
  limits: ['one independent public socket, at most 20 events or 8 seconds; no application server/browser launch or source mutation', 'preview is separately observed; no clock-offset correction or natural outage conclusion', 'does not prove sustained performance or replace runtime latency acceptance'] };
await fs.writeFile(reportPath, JSON.stringify(report, null, 2), { flag: 'wx' });
console.log(JSON.stringify({ reportPath, samples: samples.length, first: samples[0] ?? null, last: samples.at(-1) ?? null, preview, cleanup: report.cleanup, errors }, null, 2));
if (!closed || errors.length || samples.length === 0) process.exitCode = 1;