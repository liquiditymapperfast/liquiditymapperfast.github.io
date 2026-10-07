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
import { MAX_PROFILE_INSTRUMENTS, MAX_SIZES_MINUTES, MAX_SIZES_WINDOWS, type TradeLike } from '../../shared/footprint.ts';
import { RecordedBefore } from '../../shared/restart.ts';
import { FLOW_SEC, FlowRecorder, encodeFlowFrame } from './flow.mts';
import { FlowSources } from './flow-sources.mts';
import { PRINT_FLOOR_USD, PrintStream, toWire } from './prints.mts';
import { OrderBuilder, orderRow, type TakenFill } from '../../shared/orders.ts';
import { AbsorptionRecorder, GROUP_FLOOR_USD, GROUPS_PER_MINUTE, ABSORPTION_WINDOW_MS, MAX_ABSORPTION_INSTRUMENTS } from './absorption.mts';
import { ExtraVenues, RECOMMENDED_EXTRA_VENUES } from './venues.mts';
import { guardRequest, guardUpgrade } from '../request-guard.mts';
import { TIMEFRAMES, aggregateCandles, aggregateOi, timeframeMs, withLiveOi, type CandleRow, type OiRow } from './series.mts';

type App = ReturnType<typeof createLocalServer>;
export interface V2Options { dataDir: string; liveMs?: number; persist?: boolean; heartbeatMs?: number }
export interface V2Handle {
  recorder: DepthRecorder; footprint: FootprintRecorder; prints: PrintStream; flow: FlowRecorder; absorption: AbsorptionRecorder; extra: ExtraVenues; close(): void; handle(req: IncomingMessage, res: ServerResponse): boolean;
  /** Venues (the part of an instrument id before the colon) whose book is being left off the map, with the reason. */
  degradedVenues(): Map<string, string>;
}

const MAX_COLUMN_SPAN_MS = 8 * 24 * 3_600_000;
/** The most flow history one request may ask for: what the recorder keeps in memory, and a few thousand seconds per instrument cost 8 bytes each. */
const MAX_FLOW_SPAN_MS = 36 * 3_600_000, MAX_FLOW_INSTRUMENTS = 40;
/** The most instruments one sizes question may name: it is answered whole, never in parts (the minutes two parts saw could not be told apart), and the flow recorder keeps at most 48. */
const MAX_SIZES_INSTRUMENTS = 96;
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
/** A finite number from a query value: `fallback` when it is absent, null when it is there and is not one. */
const bound = (value: string | null, fallback: number): number | null => {
  if (value === null || value === '') return fallback;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
};
/** [from, to) from the query, widened to whole milliseconds, not before zero and increasing; null (the route answers 400) when it is none of those. */
function windowOf(url: URL, defaultTo: number, defaultSpan: number): { from: number; to: number } | null {
  const rawTo = bound(url.searchParams.get('to'), defaultTo); if (rawTo === null) return null;
  const rawFrom = bound(url.searchParams.get('from'), Math.max(0, rawTo - defaultSpan)); if (rawFrom === null) return null;
  const from = Math.floor(rawFrom), to = Math.ceil(rawTo);
  return Number.isSafeInteger(from) && Number.isSafeInteger(to) && from >= 0 && to > from ? { from, to } : null;
}
const BAD_WINDOW = 'from and to must be milliseconds, from before to and neither negative';
const BAD_SERIES = 'inst and a supported tf are required';

/** Attach the v2 data plane (depth recorder, live WebSocket, series endpoints) to a running local server. */
export function attachV2(app: App, { dataDir, liveMs = 250, persist = true, heartbeatMs = HEARTBEAT_MS }: V2Options): V2Handle {
  let store: SqliteColumnStore | null = null;
  if (persist) { fs.mkdirSync(dataDir, { recursive: true }); store = new SqliteColumnStore(path.join(dataDir, 'depth-v2.sqlite')); }
  const recorder = new DepthRecorder({ store });
  const defaults = process.env.HLM_DEFAULT_VENUES;
  const extra = new ExtraVenues(persist ? path.join(dataDir, 'v2-venues.json') : null, undefined, !persist || defaults === 'configured' ? false : defaults === 'all' ? true : RECOMMENDED_EXTRA_VENUES);
  const footprint = new FootprintRecorder(persist ? path.join(dataDir, 'depth-v2.sqlite') : null);
  const prints = new PrintStream(persist ? path.join(dataDir, 'depth-v2.sqlite') : null);
  const flow = new FlowRecorder(persist ? path.join(dataDir, 'depth-v2.sqlite') : null);
  /** How far the recordings reach (read now, before any trade): what a venue sends again after a restart is not counted twice. */
  const recorded = new RecordedBefore(flow, footprint);
  const unrecorded = (trades: readonly TradeLike[]): TradeLike[] => trades.filter(trade => !recorded.holds(String(trade.instrumentId ?? ''), Number(trade.sourceTimestamp ?? trade.receivedAt)));
  /** Market orders rebuilt from their fills (see shared/orders.ts): the prints and the size statistics count these, not fills. */
  const orders = new OrderBuilder();
  /** Absorption candidates (see shared/absorption.ts): every fill the builder took, once each. */
  const absorption = new AbsorptionRecorder(persist ? path.join(dataDir, 'depth-v2.sqlite') : null);
  const detect = (taken: readonly TakenFill[]): void => { for (const f of taken) absorption.add(f.instrumentId, f.t, f.price, f.usd, f.side); };
  const takeOrders = (all: boolean): void => {
    const done = orders.drain(all);
    if (!done.length) return;
    prints.ingest(done.map(orderRow)); footprint.countOrders(done);
  };
  // The connector venues carry their own trades: the flow column, the footprint and the large-trade bubbles count them like the feed manager's.
  const takeTrade = (trade: import('../../shared/connector.ts').TradeEvent): void => {
    if (recorded.holds(trade.instrumentId, trade.t)) return;
    const row = { instrumentId: trade.instrumentId, tradeId: trade.tradeId, side: trade.side, price: trade.price, notionalUsd: trade.notionalUsd, sourceTimestamp: trade.t };
    footprint.ingest([row]); flow.ingest([row]); detect(orders.add([{ ...row, order: trade.order }]));
  };
  extra.onTrade(takeTrade);
  // Exchanges the feed manager has depth for but no trade feed: their trades come from the browser engine's connectors (see flow-sources.mts).
  const flowSources = new FlowSources(takeTrade);
  const wss = new WebSocketServer({ noServer: true, perMessageDeflate: false });
  /** Each venue's book as last valued, by the book object it was valued from: an update replaces the object, so an unchanged object is an unchanged book. */
  const valued = new Map<string, { source: unknown; book: ValuedBook | null; at: number }>();
  /** Instruments whose book is crossed (a feed fault), so they are valued as nothing rather than drawn as false walls. */
  const degraded = new Map<string, string>();
  let levelsDirty = true;
  let lastSample = 0, lastPrune = 0, lastFlush = 0, lastBeat = 0, lastFlowPush = 0, lastSources = 0;
  let lastTick = '', lastLayers = '';
  /** Which books were on the map when the levels were last published, so one that ages out is published as gone. */
  let lastMembers = '';
  let lastFault = 0;
  /** Say that something failed, at most every ten seconds. */
  const fault = (what: string, error: unknown): void => { const now = Date.now(); if (now - lastFault >= 10_000) { lastFault = now; console.error(what, error); } };

  const marketOf = (id: string) => app.state.markets?.find(m => (m.instrumentId ?? m.id) === id) ?? null;
  const refreshBooks = (now: number) => {
    const live = new Set<string>();
    for (const [id, book] of Object.entries(app.state.books ?? {})) {
      live.add(id);
      // Every applied snapshot or delta builds a new book object (the state is never edited in place), so the object is the revision: a
      // key made of the stamp, the counts and the touch cannot see a change that leaves those alone (a venue with no stamp and a
      // settled book), and a quiet venue's fresh receipts never reached the valuation either.
      const cached = valued.get(id);
      if (cached?.source === book) continue;
      // A deep book (Coinbase holds tens of thousands of levels) changes on nearly every tick and costs a pass over every level; the
      // recorder samples every 5 s and the map and ladder move slowly, so re-value it at most once a second.
      if (cached && book.bids.length + book.asks.length >= DEEP_BOOK_LEVELS && now - cached.at < DEEP_BOOK_INTERVAL_MS) continue;
      const value = valueBook(id, book, marketOf(id), now, recorder.steps.get(id)), cross = value ? crossedByBp(value) : 0;
      if (cross > MAX_CROSSED_BP) {
        if (!degraded.has(id)) console.warn(`${id}: book crossed by ${Math.round(cross)} bp, left off the map until it is consistent again`);
        degraded.set(id, `book crossed by ${Math.round(cross)} bp, left off the map`);
      } else if (value && degraded.delete(id)) console.warn(`${id}: book is consistent again`); // a gapped book (null) says nothing about whether it still crosses
      valued.set(id, { source: book, book: cross > MAX_CROSSED_BP ? null : value, at: now });
      levelsDirty = true;
    }
    for (const id of [...valued.keys()]) if (!live.has(id)) { valued.delete(id); degraded.delete(id); levelsDirty = true; }
  };
  const liveBooks = (now: number): ValuedBook[] =>
    [...valued.values()].map(v => v.book).filter((b): b is ValuedBook => b !== null && now - b.timestamp <= STALE_MS * 4).concat(extra.books(now));
  const membersOf = (books: readonly ValuedBook[]): string => books.map(b => b.instrumentId).sort().join('|');

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
  const tick = (): void => {
    const now = Date.now();
    refreshBooks(now);
    if (extra.enabledCount > 0) levelsDirty = true;
    const books = liveBooks(now), members = membersOf(books);
    // A book can leave the map without any update: it passes the staleness cutoff. That is a change like any other (the last one leaving
    // is an empty frame), or a client would draw liquidity that is no longer there while the heartbeats go on.
    if (members !== lastMembers) { lastMembers = members; levelsDirty = true; }
    if (now - lastSample >= SAMPLE_MS) { lastSample = now; recorder.sample(books, now); }
    const trades = unrecorded(app.state.trades ?? []);
    footprint.ingest(trades);
    flow.ingest(trades);
    // The feed manager's recent trades are handed over whole every pass: the builder takes each fill once (Hyperliquid rows carry the order's hash).
    detect(orders.add(trades));
    takeOrders(false);
    absorption.step();
    if (now - lastSources >= 5_000) { lastSources = now; flowSources.sync(new Set([...Object.keys(app.state.books ?? {}), ...extra.enabledInstrumentIds])); }
    // Each store on its own: one that cannot write (a full disk) keeps its rows for the next round and does not stop the others or the rest of this pass.
    if (now - lastFlush >= 30_000) { lastFlush = now; for (const store of [footprint, prints, flow, absorption]) { try { store.flush(); } catch (error) { fault('recordings could not be saved; will try again:', error); } } }
    if (now - lastPrune >= 3_600_000) { lastPrune = now; recorder.prune(now); }
    const fresh = prints.takeFresh(), found = absorption.takeFresh();
    // Taken whether or not anyone listens, so the changed seconds do not pile up while nobody is connected.
    const flowItems = now - lastFlowPush >= FLOW_SEC ? flow.take() : [];
    if (flowItems.length || now - lastFlowPush >= FLOW_SEC) lastFlowPush = now;
    if (wss.clients.size === 0) return;
    if (now - lastBeat >= heartbeatMs) { lastBeat = now; broadcast(JSON.stringify({ t: 'hb', now })); }
    if (fresh.length) broadcast(JSON.stringify({ t: 'prints', items: fresh.map(toWire) }));
    if (found.groups.length || found.minutes.length) broadcast(JSON.stringify({ t: 'absorption', groups: found.groups, minutes: found.minutes }));
    if (flowItems.length) broadcast(JSON.stringify({ t: 'flow', items: flowItems }));
    if (levelsDirty) {
      levelsDirty = false;
      broadcast(encodeLevels(books, now), { binary: true }, LEVELS_SKIP_BYTES);
    }
    const tick = JSON.stringify({ t: 'tick', price: app.state.markPrice, instrumentId: app.state.markInstrumentId, asOf: app.state.asOf, candles: lastCandles() });
    if (tick !== lastTick) { lastTick = tick; broadcast(tick); }
    const layers = JSON.stringify({ t: 'layers', layers: app.state.layers, meta: app.state.layerMeta });
    if (layers !== lastLayers) { lastLayers = layers; broadcast(layers); }
  };
  // One failed pass must not end the process (an exception out of a timer is fatal): say so, at most every ten seconds, and go on.
  const loop = setInterval(() => {
    try { tick(); } catch (error) { fault('v2 loop pass failed; carrying on:', error); }
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
    const id = url.searchParams.get('inst') ?? ''; const tf = url.searchParams.get('tf') ?? '1h'; const tfMs = timeframeMs(tf);
    if (!id || !tfMs) return sendJson(res, { error: BAD_SERIES }, 400);
    const span = windowOf(url, Date.now() + tfMs, 400 * tfMs); if (!span) return sendJson(res, { error: BAD_WINDOW }, 400);
    const { from, to } = span;
    // The stored minutes and the live ones the server still holds overlap (a live candle is written as it goes): one row for each minute, the
    // one received last, or the volume of the overlap would be counted twice.
    const byStart = new Map<number, CandleRow & { receivedAt?: unknown }>();
    const take = (row: CandleRow & { receivedAt?: unknown }): void => {
      const held = byStart.get(row.start);
      if (!held || !(Number(held.receivedAt) > Number(row.receivedAt))) byStart.set(row.start, row);
    };
    let cursor = from;
    for (let page = 0; page < 12; page++) {
      const got = app.history.listCandles(id, { interval: '1m', from: cursor, to, limit: 5_000 }) as CandleRow[];
      for (const row of got) take(row);
      if (got.length < 5_000) break;
      cursor = got[got.length - 1]!.start + 1;
    }
    for (const row of app.state.candles?.[id] ?? []) if (row.start >= from && row.start < to) take(row as unknown as CandleRow);
    sendJson(res, { instrumentId: id, tf, candles: aggregateCandles(byStart.values(), tfMs) });
  };
  const oi = (url: URL, res: ServerResponse) => {
    const id = url.searchParams.get('inst') ?? ''; const tf = url.searchParams.get('tf') ?? '1h'; const tfMs = timeframeMs(tf);
    if (!id || !tfMs) return sendJson(res, { error: BAD_SERIES }, 400);
    const span = windowOf(url, Date.now() + tfMs, 400 * tfMs); if (!span) return sendJson(res, { error: BAD_WINDOW }, 400);
    const { from, to } = span;
    const stored = app.history.listOi(id, { from, to, limit: 300_000 }) as OiRow[];
    // The live samples are held to the same window as the stored bars: one past `to` would put a bar outside what was asked for.
    const at = (s: { observationTimestamp?: unknown; sourceTimestamp?: unknown; receivedAt?: unknown }): number => Number(s.observationTimestamp ?? s.sourceTimestamp ?? s.receivedAt);
    const live = (app.state.oi ?? []).filter(s => s.instrumentId === id && at(s) >= from && at(s) < to) as OiRow[];
    sendJson(res, { instrumentId: id, tf, bars: aggregateOi(withLiveOi(stored, live), tfMs) });
  };
  const footprintRoute = (url: URL, res: ServerResponse) => {
    const id = url.searchParams.get('inst') ?? ''; const tf = url.searchParams.get('tf') ?? '1h'; const tfMs = timeframeMs(tf);
    if (!id || !tfMs) return sendJson(res, { error: BAD_SERIES }, 400);
    const span = windowOf(url, Date.now() + tfMs, 200 * tfMs); if (!span) return sendJson(res, { error: BAD_WINDOW }, 400);
    const rows = num(url.searchParams.get('rows'), 0);
    if (!(rows >= 0)) return sendJson(res, { error: 'rows must not be negative' }, 400);
    sendJson(res, { instrumentId: id, tf, ...footprint.query(id, span.from, span.to, tfMs, rows) });
  };
  const printsRoute = (url: URL, res: ServerResponse) => {
    const to = num(url.searchParams.get('to'), Date.now() + 60_000), from = Math.max(num(url.searchParams.get('from'), to - 3_600_000), to - MAX_COLUMN_SPAN_MS);
    const min = Math.max(PRINT_FLOOR_USD, num(url.searchParams.get('min'), PRINT_FLOOR_USD));
    // A limit is a whole number of prints: SQLite reads a negative one as "no limit", and a fraction is nobody's intent.
    const rawLimit = url.searchParams.get('limit'), limit = rawLimit === null ? 5_000 : Number(rawLimit);
    if (!Number.isInteger(limit) || limit < 1 || limit > 5_000) return sendJson(res, { error: 'limit must be a whole number from 1 to 5000' }, 400);
    sendJson(res, { floor: PRINT_FLOOR_USD, prints: prints.query(from, to, min, limit).map(toWire) });
  };
  /** The trades of some instruments added together by size over the last N minutes, for each of up to six N (the page's strip); minutes are counted on this server's clock. */
  const sizesRoute = (url: URL, res: ServerResponse) => {
    const ids = (url.searchParams.get('inst') ?? '').split(',').filter(Boolean);
    const windows = (url.searchParams.get('minutes') ?? '').split(',').filter(Boolean).map(Number);
    if (!ids.length || ids.length > MAX_SIZES_INSTRUMENTS) return sendJson(res, { error: `inst must name 1 to ${MAX_SIZES_INSTRUMENTS} instruments` }, 400);
    if (!windows.length || windows.length > MAX_SIZES_WINDOWS || windows.some(m => !Number.isInteger(m) || m < 1 || m > MAX_SIZES_MINUTES)) return sendJson(res, { error: `minutes must be 1 to ${MAX_SIZES_WINDOWS} whole numbers from 1 to ${MAX_SIZES_MINUTES}` }, 400);
    sendJson(res, footprint.sizes(ids, windows));
  };
  /**
   * Absorption candidates for some instruments over a window: per instrument the largest first, at least its `min` credit, at most `limit`;
   * each instrument's highest floor over the window; the settled minutes since `since` for the automatic threshold; and which were cut at the limit.
   */
  const absorptionRoute = (url: URL, res: ServerResponse) => {
    const ids = (url.searchParams.get('inst') ?? '').split(',').filter(Boolean);
    if (!ids.length || ids.length > MAX_ABSORPTION_INSTRUMENTS) return sendJson(res, { error: `inst must name 1 to ${MAX_ABSORPTION_INSTRUMENTS} instruments` }, 400);
    const span = windowOf(url, Date.now() + 60_000, 3_600_000); if (!span) return sendJson(res, { error: BAD_WINDOW }, 400);
    if (span.to - span.from > MAX_COLUMN_SPAN_MS) return sendJson(res, { error: 'the window may be at most eight days' }, 400);
    // One smallest credit per instrument (its threshold), or one for all of them.
    const mins = (url.searchParams.get('min') ?? '').split(',').filter(Boolean).map(Number);
    if (mins.length > 1 && mins.length !== ids.length) return sendJson(res, { error: 'min must be one amount, or one per instrument' }, 400);
    if (mins.some(m => !Number.isFinite(m) || m < 0)) return sendJson(res, { error: 'min must be USD amounts' }, 400);
    const perId = ids.map((_, i) => Math.max(GROUP_FLOOR_USD, mins.length > 1 ? mins[i]! : mins[0] ?? GROUP_FLOOR_USD));
    const limit = bound(url.searchParams.get('limit'), 5_000), since = bound(url.searchParams.get('since'), Date.now() - 30 * 60_000);
    if (limit === null || !Number.isInteger(limit) || limit < 1 || limit > 20_000) return sendJson(res, { error: 'limit must be a whole number from 1 to 20000' }, 400);
    if (since === null || since < Date.now() - 25 * 3_600_000) return sendJson(res, { error: 'since may reach back at most 25 hours' }, 400);
    absorption.query(ids, perId, span.from, span.to, limit, since).then(
      answer => sendJson(res, { windowMs: ABSORPTION_WINDOW_MS, floorUsd: GROUP_FLOOR_USD, perMinute: GROUPS_PER_MINUTE, ...answer }),
      error => { console.error('v2 /api/v2/absorption failed:', error); if (!res.headersSent) sendJson(res, { error: 'internal error' }, 500); });
  };
  /** Traded volume by price for some instruments over a window (the page's traded-volume column). */
  const profileRoute = (url: URL, res: ServerResponse) => {
    const ids = (url.searchParams.get('inst') ?? '').split(',').filter(Boolean);
    if (!ids.length || ids.length > MAX_PROFILE_INSTRUMENTS) return sendJson(res, { error: `inst must name 1 to ${MAX_PROFILE_INSTRUMENTS} instruments` }, 400);
    const span = windowOf(url, Date.now() + 60_000, 3_600_000); if (!span) return sendJson(res, { error: BAD_WINDOW }, 400);
    if (span.to - span.from > MAX_COLUMN_SPAN_MS) return sendJson(res, { error: 'the window may be at most eight days' }, 400);
    const step = Number(url.searchParams.get('step'));
    if (!(step > 0) || !Number.isFinite(step)) return sendJson(res, { error: 'step must be a positive number' }, 400);
    sendJson(res, footprint.profile(ids, span.from, span.to, step));
  };
  const flowRoute = (url: URL, res: ServerResponse) => {
    const ids = (url.searchParams.get('inst') ?? '').split(',').filter(Boolean).slice(0, MAX_FLOW_INSTRUMENTS);
    const to = num(url.searchParams.get('to'), Date.now() + 60_000), from = Math.max(num(url.searchParams.get('from'), to - 3_600_000), to - MAX_FLOW_SPAN_MS);
    sendBinary(res, Buffer.from(encodeFlowFrame(flow.frame(ids, from, to))));
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
    recorder, footprint, prints, flow, absorption, extra,
    degradedVenues() { return new Map([...degraded].map(([id, reason]) => [id.split(':')[0]!, reason])); },
    handle(req, res) {
      const url = new URL(req.url ?? '/', 'http://localhost');
      // A route that fails answers 500 and the server goes on: an exception out of a request listener ends the process.
      try {
        if (req.method === 'POST' && url.pathname === '/api/v2/venues') { venuesSet(req, res); return true; }
        if (req.method !== 'GET') return false;
        switch (url.pathname) {
          case '/api/v2/state': bootstrap(res); return true;
          case '/api/v2/columns': columns(url, res); return true;
          case '/api/v2/candles': candles(url, res); return true;
          case '/api/v2/oi': oi(url, res); return true;
          case '/api/v2/footprint': footprintRoute(url, res); return true;
          case '/api/v2/prints': printsRoute(url, res); return true;
          case '/api/v2/flow': flowRoute(url, res); return true;
          case '/api/v2/sizes': sizesRoute(url, res); return true;
          case '/api/v2/profile': profileRoute(url, res); return true;
          case '/api/v2/absorption': absorptionRoute(url, res); return true;
          case '/api/v2/venues': venuesRoute(res); return true;
          default: return false;
        }
      } catch (error) {
        console.error(`v2 ${url.pathname} failed:`, error);
        if (!res.headersSent) sendJson(res, { error: 'internal error' }, 500); else res.end();
        return true;
      }
    },
    close() {
      clearInterval(loop); (app.server as Server).off('upgrade', onUpgrade);
      for (const client of wss.clients) client.terminate();
      // Each part gets its turn even when one of them fails, so what can still be written is (the open minutes and the open orders are written here).
      for (const part of [() => takeOrders(true), () => recorder.flush(), () => store?.close(), () => footprint.close(), () => prints.close(), () => flow.close(), () => absorption.close(), () => flowSources.close(), () => extra.close()]) {
        try { part(); } catch (error) { console.error('v2 shutdown:', error); }
      }
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
