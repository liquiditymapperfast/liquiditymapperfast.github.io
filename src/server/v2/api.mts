import type { IncomingMessage, ServerResponse, Server } from 'node:http';
import path from 'node:path';
import fs from 'node:fs';
import { WebSocketServer, WebSocket } from 'ws';
import type { createLocalServer } from '../http.mts';
import { MAX_CROSSED_BP, crossedByBp, valueBook, type ValuedBook } from './levels.mts';
import { COLUMNS_PER_REQUEST } from '../../shared/columns.ts';
import { DepthRecorder, COLUMN_MS, SAMPLE_MS, STALE_MS } from './recorder.mts';
import { SqliteColumnStore } from './store.mts';
import { encodeColumns, encodeLevels } from './wire.mts';
import { FootprintRecorder } from './footprint.mts';
import { PRINT_FLOOR_USD, PrintStream, toWire } from './prints.mts';
import { ExtraVenues, RECOMMENDED_EXTRA_VENUES } from './venues.mts';
import { guardRequest, guardUpgrade } from '../request-guard.mts';
import { TIMEFRAMES, aggregateCandles, aggregateOi, withLiveOi, type CandleRow, type OiRow } from './series.mts';

type App = ReturnType<typeof createLocalServer>;
export interface V2Options { dataDir: string; liveMs?: number; persist?: boolean; heartbeatMs?: number }
export interface V2Handle {
  recorder: DepthRecorder; footprint: FootprintRecorder; prints: PrintStream; extra: ExtraVenues; close(): void; handle(req: IncomingMessage, res: ServerResponse): boolean;
  /** Venues (the part of an instrument id before the colon) whose book is being left off the map, with the reason. */
  degradedVenues(): Map<string, string>;
}

const MAX_COLUMN_SPAN_MS = 8 * 24 * 3_600_000;
/** A client whose unsent backlog passes this is dropped rather than buffered without bound; levels frames are skipped past a lower mark. */
const MAX_CLIENT_BACKLOG_BYTES = 16_000_000, LEVELS_SKIP_BYTES = 4_000_000;
/** The live socket says something at least this often, so a client can tell a quiet server from a dead connection. */
const HEARTBEAT_MS = 5_000;
/** Books with at least this many raw levels are re-valued no more often than the interval below. */
const DEEP_BOOK_LEVELS = 2_000, DEEP_BOOK_INTERVAL_MS = 1_000;

function sendJson(res: ServerResponse, value: unknown, status = 200) {
  const body = JSON.stringify(value);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(body);
}
function sendBinary(res: ServerResponse, body: Buffer) {
  res.writeHead(200, { 'content-type': 'application/octet-stream', 'cache-control': 'no-store', 'content-length': body.length });
  res.end(body);
}
const num = (value: string | null, fallback: number) => { const n = Number(value); return value !== null && Number.isFinite(n) ? n : fallback; };

/** Attach the v2 data plane (depth recorder, live WebSocket, series endpoints) to a running local server. */
export function attachV2(app: App, { dataDir, liveMs = 250, persist = true, heartbeatMs = HEARTBEAT_MS }: V2Options): V2Handle {
  let store: SqliteColumnStore | null = null;
  if (persist) { fs.mkdirSync(dataDir, { recursive: true }); store = new SqliteColumnStore(path.join(dataDir, 'depth-v2.sqlite')); }
  const recorder = new DepthRecorder({ store });
  const defaults = process.env.HLM_DEFAULT_VENUES;
  const extra = new ExtraVenues(persist ? path.join(dataDir, 'v2-venues.json') : null, undefined, !persist || defaults === 'configured' ? false : defaults === 'all' ? true : RECOMMENDED_EXTRA_VENUES);
  const footprint = new FootprintRecorder(persist ? path.join(dataDir, 'depth-v2.sqlite') : null);
  const prints = new PrintStream(persist ? path.join(dataDir, 'depth-v2.sqlite') : null);
  const wss = new WebSocketServer({ noServer: true, perMessageDeflate: false });
  const valued = new Map<string, { key: string; book: ValuedBook | null; at: number }>();
  /** Instruments whose book is crossed (a feed fault), so they are valued as nothing rather than drawn as false walls. */
  const degraded = new Map<string, string>();
  let levelsDirty = true;
  let lastSample = 0, lastPrune = 0, lastFlush = 0, lastBeat = 0;
  let lastTick = '', lastLayers = '';

  const marketOf = (id: string) => app.state.markets?.find(m => (m.instrumentId ?? m.id) === id) ?? null;
  const refreshBooks = (now: number) => {
    const live = new Set<string>();
    for (const [id, book] of Object.entries(app.state.books ?? {})) {
      live.add(id);
      // Some venues send neither a provider timestamp nor a sequence (Bitfinex), and a settled book keeps the same level counts, so the touch is
      // part of the key as well: otherwise the book would be valued once and then drift out of date while looking unchanged.
      const bid = book.bids[0], ask = book.asks[0];
      const key = `${book.sourceTimestamp}|${book.sequence}|${book.bids.length}|${book.asks.length}|${book.complete}|${book.gap}|${bid?.[0]}|${bid?.[1]}|${ask?.[0]}|${ask?.[1]}`;
      const cached = valued.get(id);
      if (cached?.key === key) continue;
      // A deep book (Coinbase holds tens of thousands of levels) changes on nearly every tick and costs a pass over every level; the
      // recorder samples every 5 s and the map and ladder move slowly, so re-value it at most once a second.
      if (cached && book.bids.length + book.asks.length >= DEEP_BOOK_LEVELS && now - cached.at < DEEP_BOOK_INTERVAL_MS) continue;
      const value = valueBook(id, book, marketOf(id), now, recorder.steps.get(id)), cross = value ? crossedByBp(value) : 0;
      if (cross > MAX_CROSSED_BP) {
        if (!degraded.has(id)) console.warn(`${id}: book crossed by ${Math.round(cross)} bp, left off the map until it is consistent again`);
        degraded.set(id, `book crossed by ${Math.round(cross)} bp, left off the map`);
      } else if (value && degraded.delete(id)) console.warn(`${id}: book is consistent again`); // a gapped book (null) says nothing about whether it still crosses
      valued.set(id, { key, book: cross > MAX_CROSSED_BP ? null : value, at: now });
      levelsDirty = true;
    }
    for (const id of [...valued.keys()]) if (!live.has(id)) { valued.delete(id); degraded.delete(id); levelsDirty = true; }
  };
  const liveBooks = (now: number): ValuedBook[] =>
    [...valued.values()].map(v => v.book).filter((b): b is ValuedBook => b !== null && now - b.timestamp <= STALE_MS * 4).concat(extra.books(now));

  const lastCandles = () => {
    const out: Record<string, unknown> = {};
    for (const [id, rows] of Object.entries(app.state.candles ?? {})) { const row = rows[rows.length - 1]; if (row) out[id] = [row.start, row.open, row.high, row.low, row.close, row.volume ?? 0]; }
    return out;
  };
  /** Send to every open client; one that has fallen too far behind is dropped, and one that is merely slow skips the frame when `skipAbove` is set. */
  const broadcast = (message: string | Buffer, options?: { binary: boolean }, skipAbove = Infinity): void => {
    for (const client of wss.clients) {
      if (client.readyState !== WebSocket.OPEN) continue;
      if (client.bufferedAmount > MAX_CLIENT_BACKLOG_BYTES) { client.terminate(); continue; }
      if (client.bufferedAmount < skipAbove) client.send(message, options);
    }
  };
  const loop = setInterval(() => {
    const now = Date.now();
    refreshBooks(now);
    if (extra.enabledCount > 0) levelsDirty = true;
    if (now - lastSample >= SAMPLE_MS) { lastSample = now; recorder.sample(liveBooks(now), now); }
    footprint.ingest(app.state.trades ?? []);
    prints.ingest(app.state.trades ?? []);
    if (now - lastFlush >= 30_000) { lastFlush = now; footprint.flush(); prints.flush(); }
    if (now - lastPrune >= 3_600_000) { lastPrune = now; recorder.prune(now); }
    const fresh = prints.takeFresh();
    if (wss.clients.size === 0) return;
    if (now - lastBeat >= heartbeatMs) { lastBeat = now; broadcast(JSON.stringify({ t: 'hb', now })); }
    if (fresh.length) broadcast(JSON.stringify({ t: 'prints', items: fresh.map(toWire) }));
    if (levelsDirty) {
      levelsDirty = false;
      broadcast(encodeLevels(liveBooks(now), now), { binary: true }, LEVELS_SKIP_BYTES);
    }
    const tick = JSON.stringify({ t: 'tick', price: app.state.markPrice, instrumentId: app.state.markInstrumentId, asOf: app.state.asOf, candles: lastCandles() });
    if (tick !== lastTick) { lastTick = tick; broadcast(tick); }
    const layers = JSON.stringify({ t: 'layers', layers: app.state.layers, meta: app.state.layerMeta });
    if (layers !== lastLayers) { lastLayers = layers; broadcast(layers); }
  }, liveMs);
  loop.unref();

  const onUpgrade = (req: IncomingMessage, socket: import('node:stream').Duplex, head: Buffer) => {
    if (!guardUpgrade(req, socket)) return;
    if (new URL(req.url ?? '/', 'http://localhost').pathname !== '/api/v2/ws') return;
    wss.handleUpgrade(req, socket, head, client => {
      client.on('error', () => client.terminate());
      levelsDirty = true; lastTick = ''; lastLayers = '';
    });
  };
  (app.server as Server).on('upgrade', onUpgrade);

  const columns = (url: URL, res: ServerResponse) => {
    const ids = (url.searchParams.get('inst') ?? '').split(',').filter(Boolean).slice(0, COLUMNS_PER_REQUEST);
    const to = num(url.searchParams.get('to'), Date.now() + COLUMN_MS);
    const from = Math.max(num(url.searchParams.get('from'), to - 6 * 3_600_000), to - MAX_COLUMN_SPAN_MS);
    const stepMs = Math.max(COLUMN_MS, Math.round(num(url.searchParams.get('stepMs'), COLUMN_MS) / COLUMN_MS) * COLUMN_MS);
    const results = ids.map(id => ({ instrumentId: id, step: recorder.steps.get(id) ?? 0, columns: recorder.query(id, from, to, stepMs) }));
    sendBinary(res, encodeColumns(results, from, to, stepMs));
  };
  const candles = (url: URL, res: ServerResponse) => {
    const id = url.searchParams.get('inst') ?? ''; const tf = url.searchParams.get('tf') ?? '1h'; const tfMs = TIMEFRAMES[tf];
    if (!id || !tfMs) return sendJson(res, { error: 'inst and a supported tf are required' }, 400);
    const to = num(url.searchParams.get('to'), Date.now() + tfMs); const from = num(url.searchParams.get('from'), to - 400 * tfMs);
    const rows: CandleRow[] = [];
    let cursor = from;
    for (let page = 0; page < 12; page++) {
      const got = app.history.listCandles(id, { interval: '1m', from: cursor, to, limit: 5_000 }) as CandleRow[];
      rows.push(...got);
      if (got.length < 5_000) break;
      cursor = got[got.length - 1]!.start + 1;
    }
    for (const row of app.state.candles?.[id] ?? []) if (row.start >= from && row.start < to) rows.push(row as unknown as CandleRow);
    sendJson(res, { instrumentId: id, tf, candles: aggregateCandles(rows, tfMs) });
  };
  const oi = (url: URL, res: ServerResponse) => {
    const id = url.searchParams.get('inst') ?? ''; const tf = url.searchParams.get('tf') ?? '1h'; const tfMs = TIMEFRAMES[tf];
    if (!id || !tfMs) return sendJson(res, { error: 'inst and a supported tf are required' }, 400);
    const to = num(url.searchParams.get('to'), Date.now() + tfMs); const from = num(url.searchParams.get('from'), to - 400 * tfMs);
    const stored = app.history.listOi(id, { from, to, limit: 300_000 }) as OiRow[];
    const live = (app.state.oi ?? []).filter(s => s.instrumentId === id && Number(s.observationTimestamp ?? s.sourceTimestamp ?? s.receivedAt) >= from) as OiRow[];
    sendJson(res, { instrumentId: id, tf, bars: aggregateOi(withLiveOi(stored, live), tfMs) });
  };
  const footprintRoute = (url: URL, res: ServerResponse) => {
    const id = url.searchParams.get('inst') ?? ''; const tf = url.searchParams.get('tf') ?? '1h'; const tfMs = TIMEFRAMES[tf];
    if (!id || !tfMs) return sendJson(res, { error: 'inst and a supported tf are required' }, 400);
    const to = num(url.searchParams.get('to'), Date.now() + tfMs), from = num(url.searchParams.get('from'), to - 200 * tfMs);
    sendJson(res, { instrumentId: id, tf, ...footprint.query(id, from, to, tfMs, num(url.searchParams.get('rows'), 0)) });
  };
  const printsRoute = (url: URL, res: ServerResponse) => {
    const to = num(url.searchParams.get('to'), Date.now() + 60_000), from = Math.max(num(url.searchParams.get('from'), to - 3_600_000), to - MAX_COLUMN_SPAN_MS);
    const min = Math.max(PRINT_FLOOR_USD, num(url.searchParams.get('min'), PRINT_FLOOR_USD));
    sendJson(res, { floor: PRINT_FLOOR_USD, prints: prints.query(from, to, min, Math.min(5_000, num(url.searchParams.get('limit'), 5_000))).map(toWire) });
  };
  const venuesRoute = (res: ServerResponse) => sendJson(res, { venues: extra.list() });
  const venuesSet = (req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = []; let size = 0;
    req.on('data', (chunk: Buffer) => { size += chunk.length; if (size > 4096) { req.destroy(); return; } chunks.push(chunk); });
    req.on('end', () => {
      try {
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { enabled?: unknown };
        if (!Array.isArray(body.enabled) || body.enabled.some(id => typeof id !== 'string')) return sendJson(res, { error: 'enabled must be an array of venue ids' }, 400);
        extra.setEnabled(body.enabled as string[]); levelsDirty = true; sendJson(res, { venues: extra.list() });
      } catch { sendJson(res, { error: 'invalid JSON body' }, 400); }
    });
  };
  const bootstrap = (res: ServerResponse) => {
    const s = app.state;
    const statuses: Record<string, unknown> = {};
    for (const [venue, status] of Object.entries(s.statuses ?? {})) statuses[venue] = { state: (status as { state?: string }).state, lastError: (status as { lastError?: unknown }).lastError ?? null };
    sendJson(res, { asOf: s.asOf, now: Date.now(), dataMode: s.dataMode, markPrice: s.markPrice, markInstrumentId: s.markInstrumentId,
      markets: [...(s.markets ?? []), ...extra.markets()], layers: s.layers, layerMeta: s.layerMeta, statuses, steps: Object.fromEntries(recorder.steps), recorded: recorder.coverage(), columnMs: COLUMN_MS, timeframes: Object.keys(TIMEFRAMES) });
  };

  return {
    recorder, footprint, prints, extra,
    degradedVenues() { return new Map([...degraded].map(([id, reason]) => [id.split(':')[0]!, reason])); },
    handle(req, res) {
      const url = new URL(req.url ?? '/', 'http://localhost');
      if (req.method === 'POST' && url.pathname === '/api/v2/venues') { venuesSet(req, res); return true; }
      if (req.method !== 'GET') return false;
      switch (url.pathname) {
        case '/api/v2/state': bootstrap(res); return true;
        case '/api/v2/columns': columns(url, res); return true;
        case '/api/v2/candles': candles(url, res); return true;
        case '/api/v2/oi': oi(url, res); return true;
        case '/api/v2/footprint': footprintRoute(url, res); return true;
        case '/api/v2/prints': printsRoute(url, res); return true;
        case '/api/v2/venues': venuesRoute(res); return true;
        default: return false;
      }
    },
    close() {
      clearInterval(loop); (app.server as Server).off('upgrade', onUpgrade);
      for (const client of wss.clients) client.terminate();
      recorder.flush(); store?.close(); footprint.close(); prints.close(); extra.close();
    },
  };
}

/** Route v2 requests before the legacy dispatcher without modifying it. */
export function installV2(app: App, options: V2Options): V2Handle {
  const handle = attachV2(app, options);
  const server = app.server as Server;
  const original = server.listeners('request') as ((req: IncomingMessage, res: ServerResponse) => void)[];
  server.removeAllListeners('request');
  server.on('request', (req, res) => { if (!guardRequest(req, res)) return; if (!handle.handle(req, res)) for (const listener of original) listener(req, res); });
  return handle;
}
