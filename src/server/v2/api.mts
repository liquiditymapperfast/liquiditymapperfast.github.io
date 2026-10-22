import type { IncomingMessage, ServerResponse, Server } from 'node:http';
import path from 'node:path';
import fs from 'node:fs';
import { WebSocketServer, WebSocket } from 'ws';
import type { createLocalServer } from '../http.mts';
import { MAX_CROSSED_BP, crossedByBp, valueBook, withFar, type ValuedBook } from './levels.mts';
import { FAR_STALE_MS, FarPoller, farSource, freshFar, type FarBook } from '../../shared/far-book.ts';
import { OiSampler, oiHistoryWriter } from './oi-sampler.mts';
import { LS_METRICS, LongShortCache, type LsMetric } from '../../shared/long-short.ts';
import { webGet, type Fetcher } from '../../shared/history.ts';
import { PriceHistoryCache, PRICE_QUERY_BARS, priceListing } from '../../shared/price-history.ts';
import { BTC } from '../../shared/coins.ts';
import { TOUCH_HINT_MS } from '../../shared/levels.ts';
import { COLUMNS_PER_REQUEST } from '../../shared/columns.ts';
import { DepthRecorder, COLUMN_MS, HOT_MS, SAMPLE_MS, STALE_MS } from './recorder.mts';
import { SqliteColumnStore } from './store.mts';
import { encodeColumns, encodeLevels, encodeTape } from './wire.mts';
import { TAPE_BATCH_MAX, packTape } from '../../shared/tape.ts';
import type { MarketOrder } from '../../shared/orders.ts';
import { FootprintRecorder } from './footprint.mts';
import { inverseOiId, oiInstrument, oiProfileOf, type OiSeries } from '../../shared/oi-profile.ts';
import { MAX_CUT_USD, MAX_CUTS, MAX_PROFILE_INSTRUMENTS, MAX_PROFILE_SPAN_MS, MAX_RANGE_INSTRUMENTS, MAX_SIZES_MINUTES, MAX_SIZES_WINDOWS, MAX_VALUE_AREA_SPAN_MS, MAX_VALUE_AREA_WINDOWS, parseCuts, type TradeLike } from '../../shared/footprint.ts';
import { RecordedBefore } from '../../shared/restart.ts';
import { MAX_COVERAGE_INSTRUMENTS, MAX_COVERAGE_SPAN_MS, TradeCoverage, coverageWindow, depthAnswer, recordedMinutes, tradeAnswer, type CoverageMetric } from './coverage.mts';
import { venueForFeedId } from '../../core/venue-status.mts';
import { FLOW_SEC, FlowRecorder, encodeFlowFrame, encodeFlowMinutes } from './flow.mts';
import { FlowSources } from './flow-sources.mts';
import { PRINT_FLOOR_USD, PRINTS_PER_ANSWER, PrintStream, toWire, type Print } from './prints.mts';
import { LIQUIDATION_FLOOR_USD, LIQUIDATIONS_PER_ANSWER, LiquidationStream, toWire as liquidationWire } from './liquidations.mts';
import { OrderBuilder, orderRow, type TakenFill } from '../../shared/orders.ts';
import { AbsorptionRecorder, GROUP_FLOOR_USD, GROUPS_PER_MINUTE, ABSORPTION_WINDOW_MS, MAX_ABSORPTION_INSTRUMENTS } from './absorption.mts';
import { ExtraVenues, RECOMMENDED_EXTRA_VENUES } from './venues.mts';
import { CoinList } from './coin-list.mts';
import { guardRequest, guardUpgrade } from '../request-guard.mts';
import { sendVerdict, type FrameKind } from './backpressure.mts';
import { TIMEFRAMES, aggregateCandles, aggregateOi, quoteRows, timeframeMs, withLiveOi, type CandleRow, type OiRow } from './series.mts';

type App = ReturnType<typeof createLocalServer>;
/** `oiSampling`: read the open interest of the venues the feed manager does not (oi-sampler.mts); a live server only, never a test. */
export interface V2Options { dataDir: string; liveMs?: number; persist?: boolean; heartbeatMs?: number; oiSampling?: boolean; priceHistoryGet?: Fetcher }
export interface V2Handle {
  recorder: DepthRecorder; footprint: FootprintRecorder; prints: PrintStream; liquidations: LiquidationStream; flow: FlowRecorder; absorption: AbsorptionRecorder; extra: ExtraVenues; close(): void; handle(req: IncomingMessage, res: ServerResponse): boolean;
  /** Venues (the part of an instrument id before the colon) whose book is being left off the map, with the reason. */
  degradedVenues(): Map<string, string>;
}

const MAX_COLUMN_SPAN_MS = MAX_PROFILE_SPAN_MS;
/** The stretch of prints one turn of the event loop fills the footprint's lists from (see `fillLists` below). */
const FILL_STEP_MS = 10 * 60_000;
/** The most flow history one request may ask for: what the recorder keeps in memory, and a few thousand seconds per instrument cost 8 bytes each. */
const MAX_FLOW_SPAN_MS = 36 * 3_600_000, MAX_FLOW_INSTRUMENTS = 40;
/** The most a minute-totals request may span: everything the store keeps (a week), at 20 bytes a minute per instrument. */
const MAX_FLOW_MINUTES_SPAN_MS = 8 * 24 * 3_600_000;
/** The most instruments one sizes question may name: it is answered whole, never in parts (the minutes two parts saw could not be told apart), and the flow recorder keeps at most 48. */
const MAX_SIZES_INSTRUMENTS = 96;
/** The live socket says something at least this often, so a client can tell a quiet server from a dead connection. */
const HEARTBEAT_MS = 5_000;
/** How long after starting the stored absorption hours are packed (`AbsorptionRecorder.warm`). */
const ABSORPTION_WARM_AFTER_MS = 3_000;
/** Books with at least this many raw levels are re-valued no more often than the interval below. */
const DEEP_BOOK_LEVELS = 2_000, DEEP_BOOK_INTERVAL_MS = 1_000;
/** A far book reader that has done nothing for this long while its book is live is replaced (a working one ticks every FAR_EVERY_MS). */
const FAR_RESTART_MS = 3 * FAR_STALE_MS;

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
const BAD_CUTS = (floor: number): string => `cuts must be up to ${MAX_CUTS} sizes in USD, each from ${floor} to ${MAX_CUT_USD}`;
const BAD_SERIES = 'inst and a supported tf are required';

/** Attach the v2 data plane (depth recorder, live WebSocket, series endpoints) to a running local server. */
export function attachV2(app: App, { dataDir, liveMs = 250, persist = true, heartbeatMs = HEARTBEAT_MS, oiSampling = false, priceHistoryGet = webGet }: V2Options): V2Handle {
  let store: SqliteColumnStore | null = null;
  if (persist) { fs.mkdirSync(dataDir, { recursive: true }); store = new SqliteColumnStore(path.join(dataDir, 'depth-v2.sqlite')); }
  // A day of columns in memory; older ones are read back from the store when a question reaches them.
  const recorder = new DepthRecorder({ store, memoryMs: HOT_MS });
  const defaults = process.env.HLM_DEFAULT_VENUES;
  // The coin list for the page's coin picker, rebuilt here daily (the server itself records BTC only).
  const coins = persist ? new CoinList(path.join(dataDir, 'coins.json'), path.join(process.cwd(), 'dist', 'coins.json')) : null;
  coins?.start();
  const extra = new ExtraVenues(persist ? path.join(dataDir, 'v2-venues.json') : null, undefined, !persist || defaults === 'configured' ? false : defaults === 'all' ? true : RECOMMENDED_EXTRA_VENUES);
  const footprint = new FootprintRecorder(persist ? path.join(dataDir, 'depth-v2.sqlite') : null);
  const prints = new PrintStream(persist ? path.join(dataDir, 'depth-v2.sqlite') : null);
  /** Liquidations from the venues that publish them (shared/liquidations.ts). */
  const liquidations = new LiquidationStream(persist ? path.join(dataDir, 'depth-v2.sqlite') : null);
  /** Each instrument's last traded price and when it came: where a liquidation reported at its bankruptcy price is drawn. */
  const lastPrice = new Map<string, { price: number; at: number }>(); // `at` is the trade's own time, the clock a liquidation's time is on
  /**
   * Each instrument's newest trade that says where its touch is now (`splitTouch`): stamped within the window of its arrival (the recent
   * trades a venue sends again on a reconnect arrive now but happened before, and a stamp far ahead is a bad clock), aged by arrival on this
   * machine's clock (`at`), so an exchange clock a few seconds off does not stop the split from following the trades.
   */
  const touchHints = new Map<string, { price: number; t: number; at: number }>();
  const noteTouch = (id: string, price: number, t: number, at: number, now: number): void => {
    const held = touchHints.get(id);
    if (price > 0 && Math.abs(at - t) <= TOUCH_HINT_MS && now - at <= TOUCH_HINT_MS && (!held || t >= held.t)) touchHints.set(id, { price, t, at });
  };
  const flow = new FlowRecorder(persist ? path.join(dataDir, 'depth-v2.sqlite') : null);
  /** When each instrument's trades were recorded (shared/coverage.ts): covered while every source of its trades is live and this loop runs. */
  const coverage = new TradeCoverage(persist ? path.join(dataDir, 'depth-v2.sqlite') : null);
  /** The venue each instrument's trades come from on the feed manager (learnt from its trade rows), so its trade feed's state says whether it is covered. */
  const feedVenue = new Map<string, string>();
  /** The instruments covered on the last pass, so one whose source went away is closed. */
  let coveredIds = new Set<string>();
  const noteTaken = (trade: TradeLike): void => { coverage.trade(String(trade.instrumentId), String(trade.tradeId), Number(trade.sourceTimestamp ?? trade.receivedAt), Date.now()); };
  /** How far the recordings reach (read now, before any trade): what a venue sends again after a restart is not counted twice. */
  const recorded = new RecordedBefore(flow, footprint);
  const unrecorded = (trades: readonly TradeLike[]): TradeLike[] => trades.filter(trade => !recorded.holds(String(trade.instrumentId ?? ''), Number(trade.sourceTimestamp ?? trade.receivedAt)));
  /** Market orders rebuilt from their fills (see shared/orders.ts): the prints and the size statistics count these, not fills. */
  const orders = new OrderBuilder();
  /** Absorption candidates (see shared/absorption.ts): every fill the builder took, once each. */
  const absorption = new AbsorptionRecorder(persist ? path.join(dataDir, 'depth-v2.sqlite') : null);
  const detect = (taken: readonly TakenFill[]): void => { for (const f of taken) absorption.add(f.instrumentId, f.t, f.price, f.usd, f.side); };
  // The stored hours are packed for the absorption column once the start's own work is done, so the page's first question does not read them.
  const absorptionWarm = setTimeout(() => { void absorption.warm(); }, ABSORPTION_WARM_AFTER_MS);
  absorptionWarm.unref();
  /** Every order completed since the last dust batch, for the clients that asked for it (`tapeClients`), at most a batch's worth. */
  let tapeOut: MarketOrder[] = [], tapeSeq = 0;
  const tapeClients = new WeakSet<WebSocket>();
  const takeOrders = (all: boolean): void => {
    const done = orders.drain(all);
    if (done.length) prints.ingest(done.map(orderRow));
    if (done.length) { tapeOut.push(...done); if (tapeOut.length > 4 * TAPE_BATCH_MAX) tapeOut = tapeOut.slice(-2 * TAPE_BATCH_MAX); }
    // Every pass, none drained or not: the footprint counts first any orders it had to keep (a minute it could not read back).
    footprint.countOrders(done);
  };
  // The connector venues carry their own trades: the flow column, the footprint and the large-trade bubbles count them like the feed manager's.
  const takeTrade = (trade: import('../../shared/connector.ts').TradeEvent): void => {
    if (trade.t >= (lastPrice.get(trade.instrumentId)?.at ?? -Infinity)) lastPrice.set(trade.instrumentId, { price: trade.price, at: trade.t });
    const arrived = Date.now(); noteTouch(trade.instrumentId, trade.price, trade.t, arrived, arrived);
    if (recorded.holds(trade.instrumentId, trade.t)) return;
    const row = { instrumentId: trade.instrumentId, tradeId: trade.tradeId, side: trade.side, price: trade.price, notionalUsd: trade.notionalUsd, sourceTimestamp: trade.t };
    footprint.ingest([row], noteTaken); flow.ingest([row]); detect(orders.add([{ ...row, order: trade.order }]));
  };
  const takeLiquidation = (event: import('../../shared/liquidations.ts').LiquidationEvent): void => { liquidations.ingest([event], id => lastPrice.get(id) ?? null); };
  extra.onTrade(takeTrade);
  // Exchanges the feed manager has depth for but no trade feed: their trades come from the browser engine's connectors (see flow-sources.mts).
  const flowSources = new FlowSources(takeTrade, undefined, undefined, takeLiquidation);
  /**
   * Whether each instrument's trade source is live now: the feed manager's trade feeds (`<venue>-trades`, by the venue its rows name), the
   * trade connectors run for venues it has depth for (FlowSources), and the connector venues. One with none is not recorded.
   */
  const tradeSources = (now: number): Map<string, { live: boolean; lastData: number }> => {
    const out = new Map<string, { live: boolean; lastData: number }>();
    const feeds = Object.entries(app.state.feedStatuses ?? {}).filter(([id]) => id.endsWith('-trades'));
    for (const [id, venue] of feedVenue) {
      const mine = feeds.filter(([feed]) => venueForFeedId(feed) === venue); if (!mine.length) continue;
      const success = mine.map(([, s]) => Number((s as { lastSuccess?: unknown } | null)?.lastSuccess)).filter(Number.isFinite);
      out.set(id, { live: mine.every(([, s]) => (s as { state?: unknown } | null)?.state === 'live'), lastData: success.length ? Math.min(...success) : now });
    }
    for (const [id, source] of flowSources.trades()) out.set(id, { live: source.live, lastData: source.lastData || now });
    for (const v of extra.list()) if (v.enabled) out.set(v.instrumentId, { live: v.state === 'live', lastData: v.lastUpdate || now });
    return out;
  };
  const wss = new WebSocketServer({ noServer: true, perMessageDeflate: false });
  /**
   * Each venue's book as last valued, by the book object it was valued from (an update replaces the object, so an unchanged object is an
   * unchanged book) and, for a grouped book, the trade its shared top group was split at (`splitTouch`): a newer trade re-values it.
   */
  const valued = new Map<string, { source: unknown; touch: number | undefined; far: FarBook | null; book: ValuedBook | null; at: number }>();
  /**
   * The far books read from REST beyond what a feed's WebSocket sends (shared/far-book.ts: OKX's `books-full`, Aster's depth 1 000), one
   * reader for each such book the feed manager holds, started and stopped with it on the sources' 5 s round.
   */
  // Open interest of Bybit, OKX, Bitget and Deribit while their books are live (Binance's and Hyperliquid's come from the feed manager).
  // Only a market the registry calls a perpetual (a spot book of a venue that has perpetuals too has no open interest).
  const perpetual = (id: string): boolean => (app.state.markets ?? []).some(m => String((m as { instrumentId?: unknown; id?: unknown }).instrumentId ?? (m as { id?: unknown }).id) === id && (m as { marketType?: unknown }).marketType === 'perpetual');
  const oiSampler = oiSampling ? new OiSampler((message, venue) => { app.applyMessage(message, venue); }, oiHistoryWriter(app.history)) : null;
  // The sampler's per-venue outcomes (failures in a row, last error, the fast fallback mode) on the diagnostics route.
  if (oiSampler) app.setOiSamplerStatus(() => oiSampler.status());
  /**
   * Bybit's and OKX's WebSocket OI feeds, by their feed ids: while one is not live its venue is read by the sampler every five seconds
   * instead of once a minute (the WebSocket returns, the minute cadence does too).
   */
  const oiFeedIds = new Map<string, string>([['bybit', 'bybit-ticker'], ['okx', 'okx-oi']]);
  const oiFastVenues = (): string[] => {
    const statuses = app.state.feedStatuses ?? {};
    return [...oiFeedIds.entries()].filter(([venue, id]) => String((statuses as Record<string, { state?: unknown }>)[id]?.state) !== 'live').map(([venue]) => venue);
  };
  const farBooks = new Map<string, FarPoller>();
  const syncFar = (ids: readonly string[]): void => {
    const wanted = new Set<string>(), now = Date.now();
    for (const id of ids) {
      const source = farSource(id); if (!source) continue;
      wanted.add(id);
      // A reader that has stopped reading (no read begun or ended for several rounds; a read that fails still counts) is replaced,
      // whatever stopped it: the live server once went on for hours without OKX's and Aster's deep books, which a fresh server read at
      // once (2026-10-15). An exchange that is down keeps its reader, so this never loops.
      const held = farBooks.get(id);
      if (held && held.idleMs(now) > FAR_RESTART_MS) { console.warn(`${id}: the far book reader did nothing for ${Math.round(held.idleMs(now) / 1000)} s, starting a new one`); held.stop(); farBooks.delete(id); }
      if (!farBooks.has(id)) { const poller = new FarPoller(source, () => app.state.books?.[id] != null); farBooks.set(id, poller); poller.start(); }
    }
    for (const [id, poller] of farBooks) if (!wanted.has(id)) { poller.stop(); farBooks.delete(id); }
  };
  /** Instruments whose book is crossed (a feed fault), so they are valued as nothing rather than drawn as false walls. */
  const degraded = new Map<string, string>();
  let levelsDirty = true;
  let lastSample = 0, lastPrune = 0, lastFlush = 0, lastBeat = 0, lastFlowPush = 0, lastSources = 0;
  // Open-interest pushes: per instrument the newest reading already sent, so only readings that are new since the last pass go out.
  let oiSeenReady = false;
  const oiSeen = new Map<string, number>();
  const oiTime = (row: { observationTimestamp?: unknown; sourceTimestamp?: unknown; receivedAt?: unknown }): number => Number(row.observationTimestamp ?? row.sourceTimestamp ?? row.receivedAt);
  const newOi = (): { instrumentId: string; t: number; base: number; quote?: number }[] => {
    const rows = app.state.oi ?? [];
    if (!oiSeenReady) { for (const row of rows) { const id = String(row.instrumentId ?? ''); if (id) oiSeen.set(id, oiTime(row)); } oiSeenReady = true; return []; }
    const out: { instrumentId: string; t: number; base: number; quote?: number }[] = [];
    for (let i = rows.length - 1; i >= 0 && out.length < 128; i--) {
      const row = rows[i]!; const id = String(row.instrumentId ?? ''); if (!id) continue;
      const t = oiTime(row), base = Number(row.base);
      if (!(t > 0) || !Number.isFinite(base) || t <= (oiSeen.get(id) ?? 0)) continue;
      oiSeen.set(id, t);
      const quote = row.quote === undefined || row.quote === null ? undefined : Number(row.quote);
      out.push({ instrumentId: id, t, base, ...(quote !== undefined && Number.isFinite(quote) ? { quote } : {}) });
    }
    return out.reverse();
  };
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
      // Only a grouped book is split at the last trade (`splitTouch`), so only its valuation depends on the trades as well as the book.
      const grouped = Number(book.nSigFigs) > 0 || Number(book.sourceGrouping) > 0, last = grouped ? touchHints.get(id) : undefined;
      const touch = last && now - last.at <= TOUCH_HINT_MS ? last.price : undefined;
      // A new far book values the book again, and so does one ageing out (it is then left off).
      const far = freshFar(farBooks.get(id)?.latest ?? null, now);
      if (cached?.source === book && cached.touch === touch && cached.far === far) continue;
      // A deep book (Coinbase holds tens of thousands of levels) changes on nearly every tick and costs a pass over every level; the
      // recorder samples every 5 s and the map and ladder move slowly, so re-value it at most once a second.
      if (cached && book.bids.length + book.asks.length + (far ? far.bids.length + far.asks.length : 0) >= DEEP_BOOK_LEVELS && now - cached.at < DEEP_BOOK_INTERVAL_MS) continue;
      const value = valueBook(id, far ? withFar(book, far) : book, marketOf(id), now, recorder.steps.get(id), touch), cross = value ? crossedByBp(value) : 0;
      if (cross > MAX_CROSSED_BP) {
        if (!degraded.has(id)) console.warn(`${id}: book crossed by ${Math.round(cross)} bp, left off the map until it is consistent again`);
        degraded.set(id, `book crossed by ${Math.round(cross)} bp, left off the map`);
      } else if (value && degraded.delete(id)) console.warn(`${id}: book is consistent again`); // a gapped book (null) says nothing about whether it still crosses
      valued.set(id, { source: book, touch, far, book: cross > MAX_CROSSED_BP ? null : value, at: now });
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
  /** Send to every open client by the kind of frame (`sendVerdict`): one that has fallen too far behind is dropped, a slow one skips a snapshot. */
  const broadcast = (message: string | Buffer, options?: { binary: boolean }, kind: FrameKind = 'event'): void => {
    for (const client of wss.clients) {
      if (client.readyState !== WebSocket.OPEN) continue;
      const verdict = sendVerdict(kind, client.bufferedAmount);
      if (verdict === 'drop') client.terminate(); else if (verdict === 'send') client.send(message, options);
    }
  };
  const tick = (): void => {
    const now = Date.now();
    // The trades first: the books valued next are split at the newest of them.
    for (const trade of app.state.trades ?? []) {
      const price = Number(trade.price), at = Number(trade.sourceTimestamp ?? trade.receivedAt), id = String(trade.instrumentId ?? '');
      if (price > 0 && id && Number.isFinite(at) && at >= (lastPrice.get(id)?.at ?? -Infinity)) lastPrice.set(id, { price, at });
      // Only with its arrival time: the list is handed over whole on every pass, and stamping a trade with now would keep it fresh for ever.
      const received = Number(trade.receivedAt);
      if (price > 0 && id && Number.isFinite(at) && Number.isFinite(received)) noteTouch(id, price, at, received, now);
    }
    // A record past its time says nothing any more: dropped, so instruments that come and go leave nothing behind.
    for (const [id, hint] of touchHints) if (now - hint.at > TOUCH_HINT_MS) touchHints.delete(id);
    refreshBooks(now);
    if (extra.enabledCount > 0) levelsDirty = true;
    const books = liveBooks(now), members = membersOf(books);
    // A book can leave the map without any update: it passes the staleness cutoff. That is a change like any other (the last one leaving
    // is an empty frame), or a client would draw liquidity that is no longer there while the heartbeats go on.
    if (members !== lastMembers) { lastMembers = members; levelsDirty = true; }
    if (now - lastSample >= SAMPLE_MS) { lastSample = now; recorder.sample(books, now); }
    const trades = unrecorded(app.state.trades ?? []);
    for (const trade of trades) { const venue = (trade as { venue?: unknown }).venue; if (typeof venue === 'string' && venue) feedVenue.set(String(trade.instrumentId), venue); }
    const sources = tradeSources(now);
    for (const [id, source] of sources) coverage.pass(id, source.live, now, source.lastData);
    for (const id of coveredIds) if (!sources.has(id)) coverage.pass(id, false, now, now);
    coveredIds = new Set(sources.keys());
    footprint.ingest(trades, noteTaken);
    flow.ingest(trades);
    // The feed manager's recent trades are handed over whole every pass: the builder takes each fill once (Hyperliquid rows carry the order's hash).
    detect(orders.add(trades));
    takeOrders(false);
    absorption.step();
    if (now - lastSources >= 5_000) { lastSources = now; flowSources.sync(new Set([...Object.keys(app.state.books ?? {}), ...extra.enabledInstrumentIds])); syncFar(Object.keys(app.state.books ?? {})); oiSampler?.sync(Object.keys(app.state.books ?? {}).filter(perpetual)); oiSampler?.setFast(oiFastVenues()); }
    // Each store on its own: one that cannot write (a full disk) keeps its rows for the next round and does not stop the others or the rest of this pass.
    if (now - lastFlush >= 30_000) { lastFlush = now; for (const store of [footprint, prints, liquidations, flow, absorption, coverage]) { try { store.flush(); } catch (error) { fault('recordings could not be saved; will try again:', error); } } }
    if (now - lastPrune >= 3_600_000) { lastPrune = now; recorder.prune(now); }
    const fresh = prints.takeFresh(), found = absorption.takeFresh(), forced = liquidations.takeFresh();
    // Taken whether or not anyone listens, so the changed seconds do not pile up while nobody is connected.
    const flowItems = now - lastFlowPush >= FLOW_SEC ? flow.take() : [];
    if (flowItems.length || now - lastFlowPush >= FLOW_SEC) lastFlowPush = now;
    const tape = tapeOut; tapeOut = [];
    // Open interest: what the reducer took since the last pass is pushed to the pages the moment it lands, so the OI pane follows the
    // exchanges instead of a clock. The first pass only marks what is there (the fixture's or a restart's rows) as seen.
    const oiItems = newOi();
    if (wss.clients.size === 0) return;
    if (now - lastBeat >= heartbeatMs) { lastBeat = now; broadcast(JSON.stringify({ t: 'hb', now })); }
    if (oiItems.length) broadcast(JSON.stringify({ t: 'oi', items: oiItems }));
    if (fresh.length) broadcast(JSON.stringify({ t: 'prints', items: fresh.map(toWire) }));
    if (forced.length) broadcast(JSON.stringify({ t: 'liquidations', items: forced.map(liquidationWire) }));
    if (found.groups.length || found.minutes.length) broadcast(JSON.stringify({ t: 'absorption', groups: found.groups, minutes: found.minutes }));
    if (flowItems.length) broadcast(JSON.stringify({ t: 'flow', items: flowItems }));
    if (tape.length) {
      tapeSeq++;
      let encoded: Buffer | null = null;
      for (const client of wss.clients) {
        if (client.readyState !== WebSocket.OPEN || !tapeClients.has(client)) continue;
        // An event, never skipped for a backlog: a batch is about 1 KB beside the levels' 430 KB, and a skipped one is a hole in the dust.
        const verdict = sendVerdict('event', client.bufferedAmount);
        if (verdict === 'drop') { client.terminate(); continue; }
        encoded ??= encodeTape(packTape(tape, tapeSeq)); client.send(encoded, { binary: true });
      }
    }
    if (levelsDirty) {
      levelsDirty = false;
      broadcast(encodeLevels(books, now), { binary: true }, 'snapshot');
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
      // The one thing a page says on the socket: whether it draws the trade dust (an older page says nothing and is never sent it).
      client.on('message', data => {
        if (!(data instanceof Buffer) || data.length > 200) return;
        try { const m = JSON.parse(String(data)) as { t?: unknown; on?: unknown }; if (m.t === 'tape') { if (m.on === true) tapeClients.add(client); else tapeClients.delete(client); } } catch { /* not ours */ }
      });
      levelsDirty = true; lastTick = ''; lastLayers = '';
    });
  };
  (app.server as Server).on('upgrade', onUpgrade);

  const columns = (url: URL, res: ServerResponse) => {
    const ids = (url.searchParams.get('inst') ?? '').split(',').filter(Boolean).slice(0, COLUMNS_PER_REQUEST);
    const to = num(url.searchParams.get('to'), Date.now() + COLUMN_MS);
    const from = Math.max(num(url.searchParams.get('from'), to - 6 * 3_600_000), to - MAX_COLUMN_SPAN_MS);
    const stepMs = Math.max(COLUMN_MS, Math.round(num(url.searchParams.get('stepMs'), COLUMN_MS) / COLUMN_MS) * COLUMN_MS);
    // Times no clock reaches are refused: past 2^53 ms a step added to a time can leave it as it was.
    if (![from, to, stepMs].every(v => Math.abs(v) <= Number.MAX_SAFE_INTEGER)) return sendJson(res, { error: BAD_WINDOW }, 400);
    // An instrument at a time, the live loop running between them: days older than memory holds are read back from the store, which for a
    // zoomed-out week took seconds (an instrument's share of it is well under one).
    void (async () => {
      const results: { instrumentId: string; step: number; columns: ReturnType<typeof recorder.query> }[] = [];
      for (const id of ids) {
        if (closed || res.destroyed) return;
        results.push({ instrumentId: id, step: recorder.steps.get(id) ?? 0, columns: recorder.query(id, from, to, stepMs) });
        await new Promise<void>(resolve => setImmediate(resolve));
      }
      if (!res.destroyed) sendBinary(res, encodeColumns(results, from, to, stepMs));
    })().catch(error => { console.error('v2 /api/v2/columns failed:', error); if (!res.headersSent) sendJson(res, { error: 'internal error' }, 500); else res.end(); });
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
    // `usd=1`: an inverse market's own USD (the readings that kept one) in place of its coins.
    const usd = url.searchParams.get('usd') === '1';
    sendJson(res, { instrumentId: id, tf, ...(usd ? { usd } : {}), bars: oiBarsOf(id, tfMs, span.from, span.to, usd) });
  };
  /** One market's open interest in bars of `tfMs` over [from, to): the stored history and the live samples (`usd`: an inverse market's own USD). */
  const oiBarsOf = (id: string, tfMs: number, from: number, to: number, usd: boolean) => {
    const stored = app.history.listOi(id, { from, to, limit: 300_000 }) as OiRow[];
    // The live samples are held to the same window as the stored bars: one past `to` would put a bar outside what was asked for.
    const at = (s: { observationTimestamp?: unknown; sourceTimestamp?: unknown; receivedAt?: unknown }): number => Number(s.observationTimestamp ?? s.sourceTimestamp ?? s.receivedAt);
    const live = (app.state.oi ?? []).filter(s => s.instrumentId === id && at(s) >= from && at(s) < to) as OiRow[];
    return aggregateOi(usd ? withLiveOi(quoteRows(stored), quoteRows(live)) : withLiveOi(stored, live), tfMs);
  };
  /**
   * The change in open interest by price (shared/oi-profile.ts) of the perpetuals among `inst` over [from, to), at most eight days, on rows
   * of `step`: each market's one-minute bars from two minutes before, so the change into the first minute is known.
   */
  const oiProfileRoute = (url: URL, res: ServerResponse) => {
    const asked = [...new Set((url.searchParams.get('inst') ?? '').split(',').filter(Boolean))];
    if (!asked.length || asked.length > MAX_PROFILE_INSTRUMENTS) return sendJson(res, { error: `inst must name 1 to ${MAX_PROFILE_INSTRUMENTS} instruments` }, 400);
    const span = windowOf(url, Date.now() + 60_000, 3_600_000); if (!span) return sendJson(res, { error: BAD_WINDOW }, 400);
    if (span.to - span.from > MAX_COLUMN_SPAN_MS) return sendJson(res, { error: 'the window may be at most eight days' }, 400);
    const step = Number(url.searchParams.get('step'));
    if (!(step > 0) || !Number.isFinite(step)) return sendJson(res, { error: 'step must be a positive number' }, 400);
    const series = asked.filter(oiInstrument).map((id): OiSeries => {
      const coins = !inverseOiId(id);
      return { id, coins, price: lastPrice.get(id)?.price ?? 0, bars: oiBarsOf(id, 60_000, span.from - 120_000, span.to, !coins) };
    });
    sendJson(res, oiProfileOf(footprint, series, span.from, span.to, step));
  };
  // Long/short ratios as the venues publish them, read when asked for and kept in memory only (shared/long-short.ts): nothing of the
  // history store's budget, and nothing new asked while no page shows the pane (a read already under way finishes).
  const longShort = new LongShortCache(webGet, false);
  const priceHistory = new PriceHistoryCache(priceHistoryGet);
  const priceHistoryRoute = (url: URL, res: ServerResponse) => {
    const id = url.searchParams.get('inst') ?? '', tfMs = timeframeMs(url.searchParams.get('tf'));
    const target = priceListing(BTC, id);
    if (!target || target.id !== id || !tfMs) return sendJson(res, { error: BAD_SERIES }, 400);
    const span = windowOf(url, Date.now() + 1, 500 * tfMs);
    if (!span || span.to - span.from > PRICE_QUERY_BARS * tfMs) return sendJson(res, { error: BAD_WINDOW }, 400);
    priceHistory.series(target, tfMs, span.from, span.to).then(answer => sendJson(res, answer), () => sendJson(res, { error: 'price history could not be read' }, 502));
  };
  const longShortRoute = (url: URL, res: ServerResponse) => {
    const id = url.searchParams.get('inst') ?? '', tf = url.searchParams.get('tf') ?? '1h', tfMs = timeframeMs(tf), metric = url.searchParams.get('metric') ?? 'accounts';
    if (!id || !tfMs) return sendJson(res, { error: BAD_SERIES }, 400);
    if (!(LS_METRICS as readonly string[]).includes(metric)) return sendJson(res, { error: `metric must be one of ${LS_METRICS.join(', ')}` }, 400);
    const span = windowOf(url, Date.now() + tfMs, 400 * tfMs); if (!span) return sendJson(res, { error: BAD_WINDOW }, 400);
    longShort.series(id, metric as LsMetric, tfMs, span.from, span.to).then(series => sendJson(res, series), () => sendJson(res, { error: 'long/short ratios could not be read' }, 502));
  };
  const footprintRoute = (url: URL, res: ServerResponse) => {
    // One instrument, or several (comma separated) added together: the aggregated footprint.
    const id = url.searchParams.get('inst') ?? '', ids = [...new Set(id.split(',').filter(Boolean))]; const tf = url.searchParams.get('tf') ?? '1h'; const tfMs = timeframeMs(tf);
    if (!ids.length || !tfMs) return sendJson(res, { error: BAD_SERIES }, 400);
    if (ids.length > MAX_PROFILE_INSTRUMENTS) return sendJson(res, { error: `inst must name 1 to ${MAX_PROFILE_INSTRUMENTS} instruments` }, 400);
    const span = windowOf(url, Date.now() + tfMs, 200 * tfMs); if (!span) return sendJson(res, { error: BAD_WINDOW }, 400);
    const rows = num(url.searchParams.get('rows'), 0);
    if (!(rows >= 0)) return sendJson(res, { error: 'rows must not be negative' }, 400);
    const cuts = parseCuts(url.searchParams.get('cuts'), footprint.floorUsd);
    if (!cuts) return sendJson(res, { error: BAD_CUTS(footprint.floorUsd) }, 400);
    // A budget (instrument-minutes) asks for the newest part of the window only, as far back as it allows: the answer's `from` says where it starts.
    const rawBudget = url.searchParams.get('budget'), budget = rawBudget === null ? Infinity : Number(rawBudget);
    if (!(budget > 0)) return sendJson(res, { error: 'budget must be a positive number' }, 400);
    // `venues=1`: each row's markets too (the footprint's bars split by venue); only a page that draws them asks.
    // Bars of whole hours: the hours the answer reads are added together first, a few at a time (`prepare`), and the answer then merges one
    // entry an hour on the request path rather than every minute (a daily bar of fourteen markets read back from the store took seconds).
    // It may go to four budgets: it lets the event loop go every few milliseconds, and fewer answers is fewer round trips for the page.
    footprint.prepare(ids, span.from, span.to, tfMs, 4 * budget)
      .then(() => sendJson(res, { instrumentId: id, tf, ...footprint.queryMany(ids, span.from, span.to, tfMs, rows, cuts, budget, url.searchParams.get('venues') === '1') }))
      .catch(error => { console.error('v2 /api/v2/footprint failed:', error); if (!res.headersSent) sendJson(res, { error: 'internal error' }, 500); else res.end(); });
  };
  const liquidationsRoute = (url: URL, res: ServerResponse) => {
    // As the prints: a window longer than what is kept is cut to its last eight days, never refused.
    const to = num(url.searchParams.get('to'), Date.now() + 60_000), from = Math.max(num(url.searchParams.get('from'), to - 3_600_000), to - MAX_COLUMN_SPAN_MS);
    const min = Math.max(LIQUIDATION_FLOOR_USD, num(url.searchParams.get('min'), LIQUIDATION_FLOOR_USD));
    const rawLimit = url.searchParams.get('limit'), limit = rawLimit === null ? LIQUIDATIONS_PER_ANSWER : Number(rawLimit);
    if (!Number.isInteger(limit) || limit < 1 || limit > LIQUIDATIONS_PER_ANSWER) return sendJson(res, { error: `limit must be a whole number from 1 to ${LIQUIDATIONS_PER_ANSWER}` }, 400);
    sendJson(res, { floor: LIQUIDATION_FLOOR_USD, liquidations: liquidations.query(from, to, min, limit).map(liquidationWire) });
  };
  const printsRoute = (url: URL, res: ServerResponse) => {
    const to = num(url.searchParams.get('to'), Date.now() + 60_000), from = Math.max(num(url.searchParams.get('from'), to - 3_600_000), to - MAX_COLUMN_SPAN_MS);
    const min = Math.max(PRINT_FLOOR_USD, num(url.searchParams.get('min'), PRINT_FLOOR_USD));
    // A limit is a whole number of prints: SQLite reads a negative one as "no limit", and a fraction is nobody's intent.
    const rawLimit = url.searchParams.get('limit'), limit = rawLimit === null ? PRINTS_PER_ANSWER : Number(rawLimit);
    if (!Number.isInteger(limit) || limit < 1 || limit > PRINTS_PER_ANSWER) return sendJson(res, { error: 'limit must be a whole number from 1 to 5000' }, 400);
    sendJson(res, { floor: PRINT_FLOOR_USD, prints: prints.query(from, to, min, limit).map(toWire) });
  };
  /**
   * Whale VWAP sums: per step, the USD and coins bought and sold by the large market orders of some instruments from a size band up (kept in
   * memory beside the prints, see shared/print-sums.ts), and since when the recording counts them.
   */
  const printSumsRoute = (url: URL, res: ServerResponse) => {
    const ids = (url.searchParams.get('inst') ?? '').split(',').filter(Boolean);
    if (!ids.length || ids.length > MAX_SIZES_INSTRUMENTS) return sendJson(res, { error: `inst must name 1 to ${MAX_SIZES_INSTRUMENTS} instruments` }, 400);
    const to = num(url.searchParams.get('to'), Date.now() + 60_000), from = Math.max(num(url.searchParams.get('from'), to - 86_400_000), to - MAX_COLUMN_SPAN_MS);
    const step = num(url.searchParams.get('step'), 60_000);
    if (!(step >= 60_000) || (to - from) / step > 20_000) return sendJson(res, { error: 'step must be at least a minute, and at most 20,000 steps' }, 400);
    const answer = prints.printSums(ids, from, to, num(url.searchParams.get('min'), NaN), step);
    if (!answer) return sendJson(res, { error: `min must be one of ${prints.sums.bands.join(', ')}` }, 400);
    sendJson(res, answer);
  };
  /** The trades of some instruments added together by size over the last N minutes, for each of up to six N (the page's strip); minutes are counted on this server's clock. */
  const sizesRoute = (url: URL, res: ServerResponse) => {
    const ids = (url.searchParams.get('inst') ?? '').split(',').filter(Boolean);
    const windows = (url.searchParams.get('minutes') ?? '').split(',').filter(Boolean).map(Number);
    if (!ids.length || ids.length > MAX_SIZES_INSTRUMENTS) return sendJson(res, { error: `inst must name 1 to ${MAX_SIZES_INSTRUMENTS} instruments` }, 400);
    if (!windows.length || windows.length > MAX_SIZES_WINDOWS || windows.some(m => !Number.isInteger(m) || m < 1 || m > MAX_SIZES_MINUTES)) return sendJson(res, { error: `minutes must be 1 to ${MAX_SIZES_WINDOWS} whole numbers from 1 to ${MAX_SIZES_MINUTES}` }, 400);
    const cuts = parseCuts(url.searchParams.get('cuts'), footprint.floorUsd);
    if (!cuts) return sendJson(res, { error: BAD_CUTS(footprint.floorUsd) }, 400);
    sendJson(res, footprint.sizes(ids, windows, cuts));
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
  /**
   * The absorption column for some instruments over a window (shared/absorption.ts `AbsorptionProfile`): the marked USD of every group that
   * began in it, at each instrument's threshold (`min`, one per instrument or one for all), by price on rows of `step`, none left out, and the
   * instruments whose rows may be short. No minute after the window is read; whole stored hours are answered from their packed groups (read
   * once, see shared/absorption-hours.ts) and the part hours read as they are, with the event loop let go between.
   */
  const absorptionProfileRoute = (url: URL, res: ServerResponse) => {
    const ids = (url.searchParams.get('inst') ?? '').split(',').filter(Boolean);
    if (!ids.length || ids.length > MAX_ABSORPTION_INSTRUMENTS) return sendJson(res, { error: `inst must name 1 to ${MAX_ABSORPTION_INSTRUMENTS} instruments` }, 400);
    const span = windowOf(url, Date.now() + 60_000, 3_600_000); if (!span) return sendJson(res, { error: BAD_WINDOW }, 400);
    if (span.to - span.from > MAX_COLUMN_SPAN_MS) return sendJson(res, { error: 'the window may be at most eight days' }, 400);
    const mins = (url.searchParams.get('min') ?? '').split(',').filter(Boolean).map(Number);
    if (!mins.length || (mins.length > 1 && mins.length !== ids.length)) return sendJson(res, { error: 'min must be one amount, or one per instrument' }, 400);
    if (mins.some(m => !Number.isFinite(m) || m < 0)) return sendJson(res, { error: 'min must be USD amounts' }, 400);
    const step = Number(url.searchParams.get('step'));
    if (!(step > 0) || !Number.isFinite(step)) return sendJson(res, { error: 'step must be a positive number' }, 400);
    absorption.profile(ids, ids.map((_, i) => mins.length > 1 ? mins[i]! : mins[0]!), span.from, span.to, step).then(
      answer => sendJson(res, answer),
      error => { console.error('v2 /api/v2/absorption-profile failed:', error); if (!res.headersSent) sendJson(res, { error: 'internal error' }, 500); });
  };
  /** Traded volume by price for some instruments over a window (the page's traded-volume column). */
  const profileRoute = (url: URL, res: ServerResponse) => {
    const ids = (url.searchParams.get('inst') ?? '').split(',').filter(Boolean);
    if (!ids.length || ids.length > MAX_PROFILE_INSTRUMENTS) return sendJson(res, { error: `inst must name 1 to ${MAX_PROFILE_INSTRUMENTS} instruments` }, 400);
    const span = windowOf(url, Date.now() + 60_000, 3_600_000); if (!span) return sendJson(res, { error: BAD_WINDOW }, 400);
    if (span.to - span.from > MAX_COLUMN_SPAN_MS) return sendJson(res, { error: 'the window may be at most eight days' }, 400);
    const step = Number(url.searchParams.get('step'));
    if (!(step > 0) || !Number.isFinite(step)) return sendJson(res, { error: 'step must be a positive number' }, 400);
    // The ended hours are built first, a few at a time with the event loop let go between (`prepare`, as for the value areas), then read
    // added together a few hours of a market at a time: a week of every market read minute by minute held the thread for 15 s.
    footprint.prepare(ids, span.from, span.to, 3_600_000).then(() => footprint.profileYielding(ids, span.from, span.to, step)).then(
      answer => sendJson(res, answer),
      error => { console.error('v2 /api/v2/profile failed:', error); if (!res.headersSent) sendJson(res, { error: 'internal error' }, 500); else res.end(); });
  };
  /** When instruments were recorded, per minute (shared/coverage.ts): `metric` trades (the coverage record and the footprint's minutes) or depth (the columns' samples). */
  const coverageRoute = (url: URL, res: ServerResponse) => {
    const ids = [...new Set((url.searchParams.get('inst') ?? '').split(',').filter(Boolean))];
    if (!ids.length || ids.length > MAX_COVERAGE_INSTRUMENTS) return sendJson(res, { error: `inst must name 1 to ${MAX_COVERAGE_INSTRUMENTS} instruments` }, 400);
    const metric = url.searchParams.get('metric');
    if (metric !== 'trades' && metric !== 'depth') return sendJson(res, { error: 'metric must be trades or depth' }, 400);
    const span = windowOf(url, Date.now() + 60_000, 3_600_000); if (!span) return sendJson(res, { error: BAD_WINDOW }, 400);
    if (span.to - span.from > MAX_COVERAGE_SPAN_MS) return sendJson(res, { error: `the window may be at most ${MAX_COVERAGE_SPAN_MS / 3_600_000} hours` }, 400);
    const w = coverageWindow(span.from, span.to), m: CoverageMetric = metric;
    sendJson(res, { metric: m, from: w.from, to: w.to, asOf: Date.now(), instruments: ids.map(id => m === 'trades'
      ? tradeAnswer(id, coverage, w.from, w.to, t => footprint.holds(id, t))
      : depthAnswer(id, recorder.samples(id, w.from, w.to), w.from, w.to)) });
  };
  /** What happened in a selection of the map (a band of prices, `p0` and `p1`) or of a pane (every price): see `RangeAnswer`. */
  const rangeRoute = (url: URL, res: ServerResponse) => {
    const ids = (url.searchParams.get('inst') ?? '').split(',').filter(Boolean);
    if (!ids.length || ids.length > MAX_RANGE_INSTRUMENTS) return sendJson(res, { error: `inst must name 1 to ${MAX_RANGE_INSTRUMENTS} instruments` }, 400);
    const span = windowOf(url, Date.now() + 60_000, 3_600_000); if (!span) return sendJson(res, { error: BAD_WINDOW }, 400);
    if (span.to - span.from > MAX_COLUMN_SPAN_MS) return sendJson(res, { error: 'the window may be at most eight days' }, 400);
    const step = Number(url.searchParams.get('step'));
    if (!(step > 0) || !Number.isFinite(step)) return sendJson(res, { error: 'step must be a positive number' }, 400);
    const rawP0 = url.searchParams.get('p0'), rawP1 = url.searchParams.get('p1');
    if ((rawP0 === null) !== (rawP1 === null)) return sendJson(res, { error: 'p0 and p1 come together' }, 400);
    const p0 = Number(rawP0), p1 = Number(rawP1);
    if (rawP0 !== null && !(Number.isFinite(p0) && Number.isFinite(p1) && p1 > p0 && p0 >= 0)) return sendJson(res, { error: 'p0 and p1 must be prices with p0 below p1' }, 400);
    sendJson(res, footprint.range(ids, span.from, span.to, rawP0 === null ? null : { p0, p1 }, step));
  };
  /** The point of control and the value area of several windows (days, weeks, sessions): `w` is `from-to` pairs, `share` the value area's part (0..1). */
  const valueAreasRoute = (url: URL, res: ServerResponse) => {
    const ids = [...new Set((url.searchParams.get('inst') ?? '').split(',').filter(Boolean))];
    if (!ids.length || ids.length > MAX_RANGE_INSTRUMENTS) return sendJson(res, { error: `inst must name 1 to ${MAX_RANGE_INSTRUMENTS} instruments` }, 400);
    const windows = (url.searchParams.get('w') ?? '').split(',').filter(Boolean).map(pair => { const [a, b] = pair.split('-').map(Number); return { from: a!, to: b! }; });
    if (!windows.length || windows.length > MAX_VALUE_AREA_WINDOWS || windows.some(w => !Number.isSafeInteger(w.from) || !Number.isSafeInteger(w.to) || w.from < 0 || w.to <= w.from)) return sendJson(res, { error: `w must be 1 to ${MAX_VALUE_AREA_WINDOWS} windows written from-to in ms` }, 400);
    if (windows.reduce((sum, w) => sum + (w.to - w.from), 0) > MAX_VALUE_AREA_SPAN_MS) return sendJson(res, { error: 'the windows may add up to at most eight days' }, 400);
    const step = Number(url.searchParams.get('step')), share = Number(url.searchParams.get('share'));
    if (!(step > 0) || !Number.isFinite(step)) return sendJson(res, { error: 'step must be a positive number' }, 400);
    if (!(share > 0 && share <= 1)) return sendJson(res, { error: 'share must be above 0 and at most 1' }, 400);
    // The ended hours the windows hold are added together first, a few at a time with the event loop let go between (`prepare`): a week of
    // fourteen markets merged minute by minute on the request path would hold every other request. Each window's share of the recording
    // comes from the coverage record, so a quiet minute is not taken for one nobody recorded.
    const recorded = (id: string, from: number, to: number): number => recordedMinutes(coverage, id, from, to, t => footprint.holds(id, t));
    windows.reduce((ready, w) => ready.then(() => footprint.prepare(ids, w.from, w.to, 3_600_000)), Promise.resolve())
      .then(() => sendJson(res, footprint.valueAreas(ids, windows, step, share, recorded)))
      .catch(error => { console.error('v2 /api/v2/value-areas failed:', error); if (!res.headersSent) sendJson(res, { error: 'internal error' }, 500); else res.end(); });
  };
  const flowRoute = (url: URL, res: ServerResponse) => {
    const ids = (url.searchParams.get('inst') ?? '').split(',').filter(Boolean).slice(0, MAX_FLOW_INSTRUMENTS);
    const to = num(url.searchParams.get('to'), Date.now() + 60_000), from = Math.max(num(url.searchParams.get('from'), to - 3_600_000), to - MAX_FLOW_SPAN_MS);
    sendBinary(res, Buffer.from(encodeFlowFrame(flow.frame(ids, from, to))));
  };
  const flowMinutesRoute = (url: URL, res: ServerResponse) => {
    const ids = (url.searchParams.get('inst') ?? '').split(',').filter(Boolean).slice(0, MAX_FLOW_INSTRUMENTS);
    const to = num(url.searchParams.get('to'), Date.now() + 60_000), from = Math.max(num(url.searchParams.get('from'), to - 24 * 3_600_000), to - MAX_FLOW_MINUTES_SPAN_MS);
    sendBinary(res, Buffer.from(encodeFlowMinutes(flow.minutes(ids, from, to))));
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

  /**
   * The footprint's lists of large orders for the minutes recorded before they were kept (see `FootprintRecorder.fillLists`), filled from the
   * prints ten minutes per turn of the event loop, newest first, once the server is up: a week of them in one read held the loop for 12 s.
   * In memory only (those minutes age out within the week). Until a minute has its list, a size line through it falls back to the boxes.
   */
  let closed = false;
  if (persist) {
    const span = footprint.unknownLists();
    if (span) {
      const started = performance.now(); let to = span.to, filled = 0, mismatched = 0;
      const turn = (): void => {
        if (closed) return;
        const from = Math.max(span.from, to - FILL_STEP_MS), list: Print[] = [];
        prints.eachIn(from, to, p => list.push(p));
        const done = footprint.fillLists(from, to, list); filled += done.filled; mismatched += done.mismatched; to = from;
        if (to > span.from) setImmediate(turn);
        else console.log(`footprint: lists of large orders filled for ${filled} minutes in ${((performance.now() - started) / 1000).toFixed(1)} s${mismatched ? ` (${mismatched} left to the boxes: their orders did not add up)` : ''}`);
      };
      setImmediate(turn);
    }
  }

  return {
    recorder, footprint, prints, liquidations, flow, absorption, extra,
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
          case '/api/v2/price-history': priceHistoryRoute(url, res); return true;
          case '/api/v2/oi': oi(url, res); return true;
          case '/api/v2/long-short': longShortRoute(url, res); return true;
          case '/api/v2/footprint': footprintRoute(url, res); return true;
          case '/api/v2/prints': printsRoute(url, res); return true;
          case '/api/v2/print-sums': printSumsRoute(url, res); return true;
          case '/api/v2/liquidations': liquidationsRoute(url, res); return true;
          case '/api/v2/flow': flowRoute(url, res); return true;
          case '/api/v2/flow-minutes': flowMinutesRoute(url, res); return true;
          case '/api/v2/sizes': sizesRoute(url, res); return true;
          case '/api/v2/profile': profileRoute(url, res); return true;
          case '/api/v2/oi-profile': oiProfileRoute(url, res); return true;
          case '/api/v2/range': rangeRoute(url, res); return true;
          case '/api/v2/value-areas': valueAreasRoute(url, res); return true;
          case '/api/v2/absorption': absorptionRoute(url, res); return true;
          case '/api/v2/absorption-profile': absorptionProfileRoute(url, res); return true;
          case '/api/v2/coverage': coverageRoute(url, res); return true;
          case '/api/v2/venues': venuesRoute(res); return true;
          case '/coins.json': return coins?.send(res) ?? false;
          default: return false;
        }
      } catch (error) {
        console.error(`v2 ${url.pathname} failed:`, error);
        if (!res.headersSent) sendJson(res, { error: 'internal error' }, 500); else res.end();
        return true;
      }
    },
    close() {
      closed = true;
      clearInterval(loop); clearTimeout(absorptionWarm); syncFar([]); oiSampler?.close(); coins?.close(); (app.server as Server).off('upgrade', onUpgrade);
      for (const client of wss.clients) client.terminate();
      // Each part gets its turn even when one of them fails, so what can still be written is (the open minutes and the open orders are written here).
      for (const part of [() => takeOrders(true), () => recorder.flush(), () => store?.close(), () => footprint.close(), () => coverage.close(), () => prints.close(), () => liquidations.close(), () => flow.close(), () => absorption.close(), () => flowSources.close(), () => extra.close()]) {
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
