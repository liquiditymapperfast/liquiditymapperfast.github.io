import type { ValuedBook } from './levels.ts';
import { COLUMN_MS, DepthRecorder, SAMPLE_MS, STALE_MS, type Column, type ColumnStore } from './recorder.ts';
import { FootprintRecorder, type FootprintStore, type SizesAnswer } from './footprint.ts';
import { PRINT_FLOOR_USD, PrintStream, type Print, type PrintStore } from './prints.ts';
import { FLOW_MEMORY_MS, FLOW_SEC, FlowRecorder, type FlowFrame, type FlowStore, type FlowUpdate } from './flow.ts';
import { TIMEFRAMES, type Candle, type OiBar, type OiRow } from './series.ts';
import { OI_SAMPLE_VENUES, fetchCandles, fetchOiHistory, fetchOiSample, oiBars, venueOf, type Fetcher } from './history.ts';
import { BROWSER_VENUES, type BrowserVenue } from './venues.ts';
import type { BookConnector, TradeEvent } from './connector.ts';
import type { ColumnSet, ColumnsFrame } from './columns.ts';

/**
 * The whole data plane without a server: it runs the exchange connectors for the selected venues, values their books, records minute
 * columns, executions and large trades, and answers the same questions the server's HTTP API answers (candles, open interest, columns,
 * footprint, prints). It owns no sockets of its own and no timers beyond `start()`, so a test drives it with `step(now)`.
 */

/** A browser keeps a day of recordings: the page is not a server, and a week of columns would not fit comfortably in memory. */
export const BROWSER_RETENTION_MS = 24 * 3_600_000;
const FLUSH_MS = 30_000, PRUNE_MS = 3_600_000, OI_SAMPLE_MS = 60_000, OI_KEEP_MS = 3 * 24 * 3_600_000, PROBE_AFTER_MS = 10_000, PROBE_AGAIN_MS = 5 * 60_000;
/** A trade this recent is the venue's price; older than that the book's mid stands in. */
const TRADE_PRICE_MS = 15_000;
/** The page needs to see a venue's book no older than this. */
const FRAME_STALE_MS = STALE_MS * 4;
const OI_CACHE_MS = 60_000;
/** A venue that says it is live but has produced no usable book for this long is reported as such (a crossed or one-sided book is withheld by the connector). */
const NO_BOOK_MS = 10_000;

export type VenueState = 'off' | 'connecting' | 'live' | 'error' | 'blocked';
/** One venue as the picker and the status chips show it. */
export interface VenueStatus { id: string; name: string; kind: 'perp' | 'spot'; recommended: boolean; selected: boolean; state: VenueState; detail: string }
export interface EngineMarket {
  id: string; instrumentId: string; venue: string; exchange: string; symbol: string; nativeSymbol: string; base: string; quote: string; marketType: string; quantityUnit: string; isFree: boolean;
}
export interface EngineBootstrap {
  asOf: number; now: number; markPrice: number; markInstrumentId: string; markets: EngineMarket[];
  steps: Record<string, number>; recorded: Record<string, { first: number; last: number }>; columnMs: number; timeframes: string[];
  /** Instruments with an open-interest series, best first. */
  oiReferences: string[];
}
/** [start, open, high, low, close, volume] of the current one-minute candle. */
export type LiveCandle = [number, number, number, number, number, number];
export interface EngineTick {
  /** The reference price and the instrument it comes from (the first live venue in the preferred order). */
  price: number; instrumentId: string; asOf: number;
  /** The price of every live instrument, so a market that is not the reference still has a mark. */
  prices: Record<string, number>;
  candles: Record<string, LiveCandle>;
}
export interface FootprintAnswer { step: number; fine: number; bars: ReturnType<FootprintRecorder['query']>['bars'] }

export interface EngineOptions {
  venues?: readonly BrowserVenue[];
  now?: () => number;
  /** Parsed JSON from a public REST endpoint (candles, open interest). */
  get?: Fetcher;
  /** Whether a venue's reachability request was answered; the engine only uses it to explain a venue that never comes up. */
  ping?: (url: string, init?: { method: string; headers: Record<string, string>; body: string }) => Promise<boolean>;
  columns?: ColumnStore | null; footprint?: FootprintStore | null; prints?: PrintStore | null; flow?: FlowStore | null;
  retentionMs?: number;
}

interface Run {
  venue: BrowserVenue; book: BookConnector; feeds: BookConnector[]; startedAt: number;
  /** Since when a live venue has had no usable book; 0 while it has one. */
  noBookSince: number;
  probe: { ok: boolean | null; at: number; pending: boolean };
}

/** One request and its first reply over a WebSocket (see `Fetcher`). */
function socketRequest(url: string, body: string, timeoutMs: number): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url);
    let settled = false;
    const timer = setTimeout(() => settle(() => reject(new Error('the socket request timed out'))), timeoutMs);
    const settle = (finish: () => void): void => { if (settled) return; settled = true; clearTimeout(timer); try { socket.close(); } catch { /* already closed */ } finish(); };
    socket.onopen = () => socket.send(body);
    socket.onmessage = event => settle(() => { try { resolve(JSON.parse(String(event.data))); } catch (error) { reject(error); } });
    socket.onerror = () => settle(() => reject(new Error('the socket request failed')));
    socket.onclose = () => settle(() => reject(new Error('the socket closed before it answered')));
  });
}
const defaultGet: Fetcher = async (url, init) => {
  if (url.startsWith('wss://')) return socketRequest(url, init?.body ?? '', 15_000);
  const response = await fetch(url, { ...init, signal: AbortSignal.timeout(15_000) });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.json();
};
const defaultPing = async (url: string, init?: { method: string; headers: Record<string, string>; body: string }): Promise<boolean> => {
  try { return (await fetch(url, { ...init, signal: AbortSignal.timeout(6_000), cache: 'no-store' })).ok; } catch { return false; }
};

/** Columns as the page reads them: three flat arrays per instrument, concatenated across its columns. */
export function packColumns(results: readonly { instrumentId: string; step: number; columns: readonly Column[] }[]): ColumnSet[] {
  return results.map(({ instrumentId, step, columns }) => {
    const total = columns.reduce((sum, c) => sum + c.bins.length, 0);
    const bins = new Int32Array(total), bid = new Float32Array(total), ask = new Float32Array(total);
    let at = 0;
    for (const c of columns) { bins.set(c.bins, at); bid.set(c.bid, at); ask.set(c.ask, at); at += c.bins.length; }
    return { id: instrumentId, step, times: columns.map(c => c.t), counts: columns.map(c => c.bins.length), samples: columns.map(c => c.n), bins, bid, ask };
  });
}

export class Engine {
  readonly recorder: DepthRecorder;
  readonly footprints: FootprintRecorder;
  readonly printStream: PrintStream;
  /** Taker buys and sells per instrument per second (the CVD column). */
  readonly flows: FlowRecorder;
  /** Called with the books that changed since the last call (the full current set), about four times a second at most. */
  onLevels: (books: ValuedBook[], asOf: number) => void = () => {};
  onTick: (tick: EngineTick) => void = () => {};
  /** Large trades that are new. */
  onPrints: (fresh: Print[]) => void = () => {};
  /** The seconds whose taker flow changed, with their totals so far; about once a second. */
  onFlow: (items: FlowUpdate[]) => void = () => {};
  /** The picker's rows, whenever any of them changed. */
  onStatus: (venues: VenueStatus[]) => void = () => {};

  readonly #venues: readonly BrowserVenue[];
  readonly #now: () => number;
  readonly #get: Fetcher;
  readonly #ping: NonNullable<EngineOptions['ping']>;
  readonly #runs = new Map<string, Run>();
  #books: ValuedBook[] = [];
  readonly #last = new Map<string, { price: number; at: number }>();
  readonly #candles = new Map<string, LiveCandle>();
  readonly #oiLive = new Map<string, OiRow[]>();
  readonly #oiAsked = new Map<string, number>();
  readonly #oiCache = new Map<string, { at: number; rows: Promise<OiRow[]> }>();
  #lastSample = 0; #lastFlush = 0; #lastPrune = 0; #lastFlowPush = 0;
  #lastTick = ''; #lastStatus = '';
  #timer: ReturnType<typeof setInterval> | null = null;

  constructor({ venues = BROWSER_VENUES, now = Date.now, get = defaultGet, ping = defaultPing, columns = null, footprint = null, prints = null, flow = null, retentionMs = BROWSER_RETENTION_MS }: EngineOptions = {}) {
    this.#venues = venues; this.#now = now; this.#get = get; this.#ping = ping;
    this.recorder = new DepthRecorder({ store: columns, now, retentionMs });
    this.footprints = new FootprintRecorder(footprint, now, retentionMs);
    this.printStream = new PrintStream(prints, now, retentionMs);
    this.flows = new FlowRecorder(flow, now, Math.min(retentionMs, FLOW_MEMORY_MS), retentionMs);
  }

  // ---- Venues ---------------------------------------------------------------------------------------------------------------------

  /** Make exactly these venues run: start the ones that were off, stop the ones that are no longer wanted. Unknown ids are ignored. */
  select(ids: readonly string[]): void {
    const wanted = new Set(ids), now = this.#now();
    for (const venue of this.#venues) {
      const running = this.#runs.get(venue.id);
      if (wanted.has(venue.id) && !running) {
        const { book, feeds } = venue.make();
        for (const connector of [book, ...feeds]) { connector.onTrade = this.#trade; connector.start(); }
        this.#runs.set(venue.id, { venue, book, feeds, startedAt: now, noBookSince: 0, probe: { ok: null, at: 0, pending: false } });
      } else if (!wanted.has(venue.id) && running) {
        for (const connector of [running.book, ...running.feeds]) connector.stop();
        this.#runs.delete(venue.id);
        const id = running.book.instrumentId;
        this.#last.delete(id); this.#candles.delete(id);
      }
    }
    this.#lastStatus = ''; this.#lastTick = '';
  }
  get selected(): string[] { return this.#venues.filter(v => this.#runs.has(v.id)).map(v => v.id); }

  /** Every venue the engine knows, with what it is doing now. */
  venueStatus(): VenueStatus[] {
    const live = [...this.#runs.values()].filter(run => run.book.state === 'live').length;
    return this.#venues.map(venue => {
      const run = this.#runs.get(venue.id), head = { id: venue.id, name: venue.name, kind: venue.kind, recommended: venue.recommended, selected: !!run };
      if (!run) return { ...head, state: 'off' as const, detail: '' };
      const { book } = run;
      if (book.state === 'live') return { ...head, state: 'live' as const, detail: run.noBookSince && this.#now() - run.noBookSince >= NO_BOOK_MS ? 'no usable book right now (crossed or one-sided)' : '' };
      // A venue that has never delivered anything, keeps failing, and does not answer a plain REST request either, while the others work,
      // is almost certainly refusing this visitor's country (an exchange does not say so over a WebSocket).
      const others = live, expected = Math.min(2, this.#runs.size - 1);
      if (!book.everLive && book.failures >= 3 && run.probe.ok === false && others >= expected && others > 0) return { ...head, state: 'blocked' as const, detail: 'unavailable from your location' };
      if (book.failures > 0 || book.state === 'error') return { ...head, state: 'error' as const, detail: book.lastFailure ?? book.lastError ?? 'connection failed' };
      return { ...head, state: 'connecting' as const, detail: '' };
    });
  }

  // ---- The loop -------------------------------------------------------------------------------------------------------------------

  start(intervalMs = 250): void { if (!this.#timer) this.#timer = setInterval(() => this.step(), intervalMs); }
  stop(): void { if (this.#timer) clearInterval(this.#timer); this.#timer = null; for (const run of this.#runs.values()) for (const c of [run.book, ...run.feeds]) c.stop(); this.#runs.clear(); this.flush(); }

  /** One pass: value the books, record, and tell the page what changed. */
  step(now = this.#now()): void {
    const books = this.#value(now);
    // A pass with no book yet must not use up the sample interval, or the first real sample waits five seconds.
    if (books.length && now - this.#lastSample >= SAMPLE_MS) { this.#lastSample = now; this.recorder.sample(books, now); }
    if (now - this.#lastFlush >= FLUSH_MS) { this.#lastFlush = now; this.footprints.flush(); this.printStream.flush(); this.flows.flush(); }
    if (now - this.#lastFlowPush >= FLOW_SEC) { this.#lastFlowPush = now; const items = this.flows.take(); if (items.length) this.onFlow(items); }
    if (now - this.#lastPrune >= PRUNE_MS) { this.#lastPrune = now; this.recorder.prune(now); }
    this.#pollOi(now);
    this.#probe(now);
    const fresh = this.printStream.takeFresh();
    if (fresh.length) this.onPrints(fresh);
    const previous = this.#books;
    this.#books = books;
    if (books.length !== previous.length || books.some((book, i) => book !== previous[i])) this.onLevels(books, now);
    const tick = this.#tick(now);
    if (tick) { const key = JSON.stringify([tick.price, tick.instrumentId, tick.prices, tick.candles]); if (key !== this.#lastTick) { this.#lastTick = key; this.onTick(tick); } }
    const status = this.venueStatus(), signature = JSON.stringify(status);
    if (signature !== this.#lastStatus) { this.#lastStatus = signature; this.onStatus(status); }
  }

  /** Write everything not yet saved, including the minute still open (the page is going away). */
  flush(): void { this.recorder.flush(); this.footprints.flush(true); this.printStream.flush(); this.flows.flush(true); }

  #value(now: number): ValuedBook[] {
    const out: ValuedBook[] = [];
    for (const run of this.#runs.values()) {
      // The connector withholds a book that is crossed at the touch, one-sided or stale, so what comes back is safe to draw.
      const value = run.book.valued(now, this.recorder.steps.get(run.book.instrumentId));
      if (value && now - value.timestamp <= FRAME_STALE_MS) { out.push(value); run.noBookSince = 0; }
      else if (run.book.state === 'live' && !run.noBookSince) run.noBookSince = now;
      else if (run.book.state !== 'live') run.noBookSince = 0;
    }
    return out;
  }

  /** The books of the last pass, for a page that has just attached. */
  get levels(): ValuedBook[] { return this.#books; }

  // ---- Trades ---------------------------------------------------------------------------------------------------------------------

  readonly #trade = (trade: TradeEvent): void => {
    const row = { instrumentId: trade.instrumentId, tradeId: trade.tradeId, side: trade.side, price: trade.price, notionalUsd: trade.notionalUsd, sourceTimestamp: trade.t };
    this.printStream.ingest([row]);
    this.flows.ingest([row]);
    // A trade seen before (a feed that replays after a reconnect) is in the footprint already, and must not count twice in the candle either.
    if (this.footprints.ingest([row]) === 0) return;
    const now = this.#now();
    this.#last.set(trade.instrumentId, { price: trade.price, at: now });
    const start = Math.floor(trade.t / COLUMN_MS) * COLUMN_MS, candle = this.#candles.get(trade.instrumentId);
    if (!candle || start > candle[0]) this.#candles.set(trade.instrumentId, [start, trade.price, trade.price, trade.price, trade.price, trade.amount]);
    else if (start === candle[0]) { candle[2] = Math.max(candle[2], trade.price); candle[3] = Math.min(candle[3], trade.price); candle[4] = trade.price; candle[5] += trade.amount; }
  };

  // ---- Price ----------------------------------------------------------------------------------------------------------------------

  #priceOf(id: string, now: number): number | null {
    const last = this.#last.get(id);
    if (last && now - last.at < TRADE_PRICE_MS) return last.price;
    const book = this.#books.find(b => b.instrumentId === id);
    // A banded book (Hyperliquid, Deribit) has no exact touch, so only a recent trade says where its price is.
    return book && !book.coarse && book.bids.lo.length && book.asks.lo.length ? (book.bids.lo[0]! + book.asks.lo[0]!) / 2 : null;
  }
  #reference(now: number): { price: number; instrumentId: string } | null {
    for (const venue of this.#venues) {
      const run = this.#runs.get(venue.id); if (!run || run.book.state !== 'live') continue;
      const price = this.#priceOf(run.book.instrumentId, now);
      if (price !== null) return { price, instrumentId: run.book.instrumentId };
    }
    return null;
  }
  #tick(now: number): EngineTick | null {
    const reference = this.#reference(now); if (!reference) return null;
    const prices: Record<string, number> = {};
    for (const run of this.#runs.values()) { const price = this.#priceOf(run.book.instrumentId, now); if (price !== null) prices[run.book.instrumentId] = price; }
    const candles: Record<string, LiveCandle> = {};
    for (const [id, candle] of this.#candles) candles[id] = [...candle] as LiveCandle;
    return { ...reference, asOf: now, prices, candles };
  }

  // ---- What the page asks for -----------------------------------------------------------------------------------------------------

  bootstrap(): EngineBootstrap {
    const now = this.#now(), reference = this.#reference(now);
    const markets = [...this.#runs.values()].map(({ book: c }): EngineMarket => ({ id: c.instrumentId, instrumentId: c.instrumentId, venue: c.id, exchange: c.id, symbol: c.symbol, nativeSymbol: c.symbol, base: c.base, quote: c.quote, marketType: c.marketType, quantityUnit: 'base', isFree: true }));
    const oiReferences = markets.filter(m => OI_SAMPLE_VENUES.includes(m.venue)).sort((a, b) => OI_SAMPLE_VENUES.indexOf(a.venue) - OI_SAMPLE_VENUES.indexOf(b.venue)).map(m => m.instrumentId);
    // A live venue that has not been sampled yet is about to be: say that recording starts this minute rather than that nothing is recorded.
    const recorded = this.recorder.coverage(), minute = Math.floor(now / COLUMN_MS) * COLUMN_MS;
    for (const run of this.#runs.values()) if (run.book.state === 'live' && !recorded[run.book.instrumentId]) recorded[run.book.instrumentId] = { first: minute, last: minute };
    return { asOf: now, now, markPrice: reference?.price ?? 0, markInstrumentId: reference?.instrumentId ?? '', markets, steps: Object.fromEntries(this.recorder.steps), recorded, columnMs: COLUMN_MS, timeframes: Object.keys(TIMEFRAMES), oiReferences };
  }

  columns(ids: readonly string[], from: number, to: number, stepMs: number): ColumnsFrame {
    const step = Math.max(COLUMN_MS, Math.round(stepMs / COLUMN_MS) * COLUMN_MS);
    return { from, to, stepMs: step, instruments: packColumns(ids.map(id => ({ instrumentId: id, step: this.recorder.steps.get(id) ?? 0, columns: this.recorder.query(id, from, to, step) }))) };
  }

  footprint(instrumentId: string, tfMs: number, from: number, to: number, rowStep: number): FootprintAnswer { return this.footprints.query(instrumentId, from, to, tfMs, rowStep); }

  /** The trades of these instruments added together by size over each of the last `windows` minutes (the page's strip). */
  sizes(ids: readonly string[], windows: readonly number[]): SizesAnswer { return this.footprints.sizes(ids, windows); }

  /** Taker flow per second for each instrument over [from, to), from its first recorded minute in that range. */
  flow(ids: readonly string[], from: number, to: number): FlowFrame { return this.flows.frame(ids, from, to); }

  prints(from: number, to: number, minUsd = PRINT_FLOOR_USD, limit = 5_000): Print[] { return this.printStream.query(from, to, Math.max(PRINT_FLOOR_USD, minUsd), limit); }

  /** Candles from the venue's own history. An unreachable venue answers with nothing, and the page falls back to another one. */
  async candles(instrumentId: string, tfMs: number, from: number, to: number): Promise<Candle[]> {
    try { return await fetchCandles(instrumentId, tfMs, from, to, this.#get); } catch { return []; }
  }

  /** Open interest bars: the venue's own history where it has one, and the readings taken while the page was open. */
  async oi(instrumentId: string, tfMs: number, from: number, to: number): Promise<OiBar[]> {
    const venue = venueOf(instrumentId), key = `${instrumentId}|${tfMs}|${from}|${to}`, cached = this.#oiCache.get(key), now = this.#now();
    let stored: Promise<OiRow[]>;
    if (cached && now - cached.at < OI_CACHE_MS) stored = cached.rows;
    else { stored = fetchOiHistory(instrumentId, tfMs, from, to, this.#get).catch(() => []); this.#oiCache.set(key, { at: now, rows: stored }); if (this.#oiCache.size > 20) this.#oiCache.delete(this.#oiCache.keys().next().value!); }
    const live = (this.#oiLive.get(venue) ?? []).filter(sample => Number(sample.observationTimestamp) >= from);
    return oiBars(await stored, live, tfMs);
  }

  #pollOi(now: number): void {
    for (const venue of OI_SAMPLE_VENUES) {
      const run = this.#runs.get(venue); if (!run) continue;
      if (now - (this.#oiAsked.get(venue) ?? 0) < OI_SAMPLE_MS) continue;
      this.#oiAsked.set(venue, now);
      void fetchOiSample(venue, this.#get).then(base => {
        if (base === null) return;
        const list = this.#oiLive.get(venue) ?? []; this.#oiLive.set(venue, list);
        list.push({ observationTimestamp: this.#now(), base });
        while (list.length && Number(list[0]!.observationTimestamp) < this.#now() - OI_KEEP_MS) list.shift();
      }, () => { /* the next minute asks again */ });
    }
  }

  // ---- Reachability ---------------------------------------------------------------------------------------------------------------

  /** Ask a venue that has not come up a plain REST question, once now and again every few minutes, to tell "unreachable" from "slow". */
  #probe(now: number): void {
    for (const run of this.#runs.values()) {
      const { book, probe } = run;
      if (book.everLive || probe.pending) continue;
      if (book.failures < 2 && now - run.startedAt < PROBE_AFTER_MS) continue;
      if (probe.at && now - probe.at < PROBE_AGAIN_MS) continue;
      probe.pending = true; probe.at = now;
      void this.#ping(run.venue.probe.url, run.venue.probe.init).then(ok => { probe.ok = ok; }, () => { probe.ok = false; }).finally(() => { probe.pending = false; this.#lastStatus = ''; });
    }
  }
}
