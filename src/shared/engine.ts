import type { ValuedBook } from './levels.ts';
import { BROWSER_RETENTION_MS, COLUMN_MS, DepthRecorder, MIN_BIN_USD, SAMPLE_MS, STALE_MS, type Column, type ColumnStore } from './recorder.ts';
import { FootprintRecorder, MAX_CUT_USD, MAX_CUTS, MAX_PROFILE_INSTRUMENTS, type FootprintStore, type ProfileAnswer, type RangeAnswer, type SizesAnswer, type ValueAreaAnswer } from './footprint.ts';
import { PRINT_FLOOR_USD, PRINTS_PER_ANSWER, PrintStream, type Print, type PrintStore } from './prints.ts';
import type { PrintSumsAnswer } from './print-sums.ts';
import { LIQUIDATION_FLOOR_USD, LIQUIDATIONS_PER_ANSWER, LiquidationStream, type Liquidation, type LiquidationEvent, type LiquidationStore } from './liquidations.ts';
import { OrderBuilder, orderRow } from './orders.ts';
import { packTape, type TapeBatch } from './tape.ts';
import { RecordedBefore } from './restart.ts';
import { AbsorptionRecorder, GROUP_FLOOR_USD, type AbsorptionAnswer, type AbsorptionProfileAnswer, type AbsorptionGroup, type AbsorptionMinute, type AbsorptionStore } from './absorption.ts';
import { FLOW_MEMORY_MS, FLOW_SEC, FlowRecorder, type FlowFrame, type FlowStore, type FlowUpdate } from './flow.ts';
import { TIMEFRAMES, quoteRows, type Candle, type OiBar, type OiRow } from './series.ts';
import { OI_SAMPLE_VENUES, fetchCandles, fetchOiHistory, fetchOiReading, oiBars, venueOf, webGet, type Fetcher } from './history.ts';
import { inverseOiId, oiInstrument, oiProfileOf, type OiProfileAnswer, type OiSeries } from './oi-profile.ts';
import { browserVenues, type BrowserVenue } from './venues.ts';
import { BTC, SCALES, type Coin, type MarketVenue } from './coins.ts';
import type { BookConnector, OiEvent, TradeEvent } from './connector.ts';
import { packLt, type ColumnSet, type ColumnsFrame } from './columns.ts';
import { MAX_COVERAGE_INSTRUMENTS, MAX_COVERAGE_SPAN_MS, TradeCoverage, coverageWindow, coveredMs, depthAnswer, recordedMinutes, tradeAnswer, type CoverageAnswer, type CoverageMetric, type CoverageStore } from './coverage.ts';
import { RECOVERY_BUDGET, historySource, planRecovery, rebuildOrders, runRecovery, trimUnknown, webHistoryFetch, type HistoryFetch, type HistorySource, type HistoryTrade, type RecoveryBudget, type RecoveryResult } from './recovery.ts';

/**
 * The whole data plane without a server: it runs the exchange connectors for the selected venues, values their books, records minute
 * columns, executions and large trades, and answers the same questions the server's HTTP API answers (candles, open interest, columns,
 * footprint, prints). It owns no sockets of its own and no timers beyond `start()`, so a test drives it with `step(now)`.
 */

export { BROWSER_RETENTION_MS };
/** How long after starting the absorption recorder reads the rest of its day back (the page asks its first questions meanwhile). */
const HYDRATE_AFTER_MS = 5_000;
const FLUSH_MS = 30_000, PRUNE_MS = 3_600_000, OI_SAMPLE_MS = 60_000, OI_KEEP_MS = 3 * 24 * 3_600_000, PROBE_AFTER_MS = 10_000, PROBE_AGAIN_MS = 5 * 60_000;
/** Binance has no open-interest WebSocket: its REST endpoint is polled this often (one weight per call; 12 a minute is 0.5 % of the IP budget). */
const OI_BINANCE_POLL_MS = 5_000;
/** Bybit and OKX open interest arrives on the book socket; while that stream is quiet the REST endpoint is polled this often. */
const OI_WS_FALLBACK_MS = 5_000;
const OI_WS_VENUES: ReadonlySet<string> = new Set(['bybit', 'okx']);
/** A trade this recent is the venue's price; older than that the book's mid stands in. */
const TRADE_PRICE_MS = 15_000;
/** The page needs to see a venue's book no older than this. */
const FRAME_STALE_MS = STALE_MS * 4;
const OI_CACHE_MS = 60_000;
/** A venue that says it is live but has produced no usable book for this long is reported as such (a crossed or one-sided book is withheld by the connector). */
const NO_BOOK_MS = 10_000;

export type VenueState = 'off' | 'connecting' | 'live' | 'error' | 'blocked';
/** One venue as the picker and the status chips show it. */
export interface VenueStatus { id: string; name: string; kind: 'perp' | 'spot'; recommended: boolean; selected: boolean; state: VenueState; detail: string; listed: boolean }
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
export interface FootprintAnswer { step: number; fine: number; bars: ReturnType<FootprintRecorder['query']>['bars']; from: number; venues?: string[] }

/** One open-interest reading as it is kept: the venue's perpetual, when it was read, its coins and (an inverse market) its own USD. */
export interface OiReading { venue: string; t: number; base: number; quote?: number }
/** Where open-interest readings outlive the page (the browser's recordings): `load` is synchronous, saving may be queued. */
export interface OiStore { load(since: number): OiReading[]; save(rows: OiReading[], expireBefore: number): void; close(): void }

export interface EngineOptions {
  /** The coin, and the tier its size floors are kept at (the coin's own unless the page fixed another for its recordings). */
  coin?: Coin; tier?: number;
  /** The markets (the coin's eleven unless a test gives others). */
  venues?: readonly BrowserVenue[];
  now?: () => number;
  /** Parsed JSON from a public REST endpoint (candles, open interest). */
  get?: Fetcher;
  /** Whether a venue's reachability request was answered; the engine only uses it to explain a venue that never comes up. */
  ping?: (url: string, init?: { method: string; headers: Record<string, string>; body: string }) => Promise<boolean>;
  columns?: ColumnStore | null; footprint?: FootprintStore | null; prints?: PrintStore | null; flow?: FlowStore | null; absorption?: AbsorptionStore | null; coverage?: CoverageStore | null; liquidations?: LiquidationStore | null; oi?: OiStore | null;
  retentionMs?: number;
  /** How a recovery reads a venue's trade history (shared/recovery.ts), and its budget; a test gives its own. */
  historyFetch?: HistoryFetch; recoveryBudget?: RecoveryBudget;
}

/** What a page asks a recovery for: its markets, the most wanted first (the chart market), and the windows to fill, in order (the bar under way, then the one before). */
export interface RecoveryRequest { ids: string[]; windows: { from: number; to: number }[] }
/** What one recovery action did, per market: how many gaps it found, how much of them it filled from the venue's history, and whether all. */
export interface RecoveryReport {
  pages: number; rows: number; ms: number; stoppedBy: 'done' | 'pages' | 'rows' | 'time'; failed: string[];
  instruments: { id: string; recoverable: boolean; gaps: number; gapMs: number; recoveredMs: number }[];
}
/** A recovery waits this long at most for the markets' feeds to be live again (a phone back from the background reconnects first). */
const RECOVERY_WAIT_MS = 8_000;
/** A venue's limit (`HistorySource.bucket`) that failed a recovery is not asked under again for this long. */
const VENUE_REST_MS = 60_000;

interface Run {
  venue: BrowserVenue; book: BookConnector; feeds: BookConnector[]; startedAt: number;
  /** The connectors that carry the instrument's trades (its trade feeds, or the book's own socket): its trades are covered while all are live. */
  trades: BookConnector[];
  /** Since when a live venue has had no usable book; 0 while it has one. */
  noBookSince: number;
  probe: { ok: boolean | null; at: number; pending: boolean };
}

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
    const lt = packLt(columns);
    return { id: instrumentId, step, times: columns.map(c => c.t), counts: columns.map(c => c.bins.length), samples: columns.map(c => c.n), bins, bid, ask, ...(lt ? { lt } : {}) };
  });
}

export class Engine {
  readonly recorder: DepthRecorder;
  readonly footprints: FootprintRecorder;
  readonly printStream: PrintStream;
  /** Taker buys and sells per instrument per second (the CVD column). */
  readonly flows: FlowRecorder;
  /** Market orders rebuilt from their fills: the prints and the size statistics count these. */
  readonly orders: OrderBuilder;
  /** Absorption candidates and window statistics, from every fill once. */
  readonly absorption: AbsorptionRecorder;
  /** When each instrument's trades were recorded (shared/coverage.ts): a minute with nothing in it told apart from one nobody recorded. */
  readonly tradeCoverage: TradeCoverage;
  /** How far the recordings reached when this engine started (see shared/restart.ts). */
  readonly #recorded: RecordedBefore;
  /** Absorption groups found and minutes settled since the last pass. */
  onAbsorption: (found: { groups: AbsorptionGroup[]; minutes: AbsorptionMinute[] }) => void = () => {};
  /** Called with the books that changed since the last call (the full current set), about four times a second at most. */
  onLevels: (books: ValuedBook[], asOf: number) => void = () => {};
  onTick: (tick: EngineTick) => void = () => {};
  /** Large trades that are new. */
  onPrints: (fresh: Print[]) => void = () => {};
  /** Liquidations that are new. */
  onLiquidations: (fresh: Liquidation[]) => void = () => {};
  /** Liquidations reported by the venues that publish them, kept with the other recordings (in this browser, a day of them). */
  readonly liquidationStream: LiquidationStream;
  /** Every market order completed since the last pass, for the trade dust (never stored); null when nobody draws it. */
  onTape: ((batch: TapeBatch) => void) | null = null;
  /** A new open-interest reading, the moment it lands (the venue's socket or its REST poll): the page shows it at once instead of asking. */
  onOiLive: (instrumentId: string, reading: { t: number; base: number; quote?: number }) => void = () => {};
  #tapeSeq = 0;
  /** The seconds whose taker flow changed, with their totals so far; about once a second. */
  onFlow: (items: FlowUpdate[]) => void = () => {};
  /** The picker's rows, whenever any of them changed. */
  onStatus: (venues: VenueStatus[]) => void = () => {};
  /** A gap of `id` was filled from the venue's history over [from, to): what was asked about it may have changed. */
  onRecovered: (id: string, from: number, to: number) => void = () => {};
  readonly #historyFetch: HistoryFetch;
  readonly #recoveryBudget: RecoveryBudget;
  /** The end of the newest footprint minute each instrument had when the engine started (read from storage). */
  readonly #loadedThrough = new Map<string, number>();
  /** The recovery under way (one at a time), and a request that came while it ran (done next). */
  #recovering: Promise<RecoveryReport> | null = null; #recoverNext: RecoveryRequest | null = null;
  readonly #venueRest = new Map<string, number>();

  readonly #venues: readonly BrowserVenue[];
  readonly #coin: Coin;
  readonly #now: () => number;
  readonly #get: Fetcher;
  readonly #ping: NonNullable<EngineOptions['ping']>;
  readonly #runs = new Map<string, Run>();
  #books: ValuedBook[] = [];
  /** Each instrument's last trade: its price, when it arrived (`at`) and its own time (`t`, what a liquidation is placed by). */
  readonly #last = new Map<string, { price: number; at: number; t: number }>();
  readonly #candles = new Map<string, LiveCandle>();
  readonly #oiLive = new Map<string, OiRow[]>();
  /** Where the open-interest readings outlive the page (the browser's recordings), and how long they are kept there. */
  readonly #oiStore: OiStore | null;
  readonly #retentionMs: number;
  readonly #oiAsked = new Map<string, number>();
  /** When each venue last delivered an open-interest reading by any path (the book socket or REST): the WS venues skip REST while this is fresh. */
  readonly #oiTouched = new Map<string, number>();
  readonly #oiCache = new Map<string, { at: number; rows: Promise<OiRow[]> }>();
  #lastSample = 0; #lastFlush = 0; #lastPrune = 0; #lastFlowPush = 0;
  #lastTick = ''; #lastStatus = '';
  #timer: ReturnType<typeof setInterval> | null = null;
  #hydration: ReturnType<typeof setTimeout> | null = null;

  constructor({ coin = BTC, tier = coin.tier, venues = browserVenues(coin), now = Date.now, get = webGet, ping = defaultPing, columns = null, footprint = null, prints = null, flow = null, absorption = null, coverage = null, liquidations = null, oi = null, retentionMs = BROWSER_RETENTION_MS, historyFetch = webHistoryFetch, recoveryBudget = RECOVERY_BUDGET }: EngineOptions = {}) {
    this.#oiStore = oi; this.#retentionMs = retentionMs;
    if (oi) {
      for (const r of oi.load(now() - retentionMs)) {
        let list = this.#oiLive.get(r.venue); if (!list) { list = []; this.#oiLive.set(r.venue, list); }
        list.push({ observationTimestamp: r.t, base: r.base, ...(r.quote !== undefined ? { quote: r.quote } : {}) });
      }
      for (const list of this.#oiLive.values()) list.sort((a, b) => Number(a.observationTimestamp) - Number(b.observationTimestamp));
    }
    this.#coin = coin; this.#venues = venues; this.#now = now; this.#get = get; this.#ping = ping; this.#historyFetch = historyFetch; this.#recoveryBudget = recoveryBudget;
    // A coin that trades less than BTC keeps smaller trades, groups and map cells (shared/coins.ts SCALES); BTC's are 1.
    const scale = SCALES[tier] ?? 1;
    // A page keeps far fewer merged windows than a server (about 6 MB at most): it holds a day, and it may be a phone.
    this.recorder = new DepthRecorder({ store: columns, now, retentionMs, minBinUsd: MIN_BIN_USD * scale, mergedCacheBins: 500_000 });
    this.footprints = new FootprintRecorder(footprint, now, retentionMs, scale);
    this.printStream = new PrintStream(prints, now, retentionMs, PRINT_FLOOR_USD * scale);
    // Minutes kept from before the footprint kept its lists of large orders get them from the prints kept beside them (a day at most, in
    // memory already: at once, where a server spreads it out).
    const unknown = this.footprints.unknownLists();
    if (unknown) { const list: Print[] = []; this.printStream.eachIn(unknown.from, unknown.to, p => list.push(p)); this.footprints.fillLists(unknown.from, unknown.to, list); }
    this.liquidationStream = new LiquidationStream(liquidations, now, retentionMs, LIQUIDATION_FLOOR_USD * scale);
    this.flows = new FlowRecorder(flow, now, Math.min(retentionMs, FLOW_MEMORY_MS), retentionMs);
    this.orders = new OrderBuilder(now);
    // It holds the whole day the page keeps, to answer the absorption column without reading the recordings (`start` reads it back).
    this.absorption = new AbsorptionRecorder(absorption, now, { retentionMs, floorUsd: GROUP_FLOOR_USD * scale, memoryMs: retentionMs });
    this.tradeCoverage = new TradeCoverage(coverage, now, retentionMs);
    for (const id of this.footprints.instruments) this.#loadedThrough.set(id, this.footprints.lastMinute(id) + COLUMN_MS);
    this.#recorded = new RecordedBefore(this.flows, this.footprints);
  }

  // ---- Venues ---------------------------------------------------------------------------------------------------------------------

  /** Make exactly these venues run: start the ones that were off, stop the ones that are no longer wanted. Unknown ids, and markets that do not list the coin, are ignored. */
  select(ids: readonly string[]): void {
    const wanted = new Set(ids), now = this.#now();
    for (const venue of this.#venues) {
      const running = this.#runs.get(venue.id);
      if (wanted.has(venue.id) && !running && venue.listed) {
        const made = venue.make(), feeds = [...made.feeds, ...(made.liquidations ?? [])], book = made.book;
        for (const connector of [book, ...feeds]) { connector.onTrade = this.#trade; connector.onLiquidation = this.#liquidation; connector.onOi = this.#oiReading; connector.start(); }
        this.#runs.set(venue.id, { venue, book, feeds, trades: made.feeds.length ? made.feeds : [book], startedAt: now, noBookSince: 0, probe: { ok: null, at: 0, pending: false } });
      } else if (!wanted.has(venue.id) && running) {
        for (const connector of [running.book, ...running.feeds]) connector.stop();
        this.#runs.delete(venue.id);
        const id = running.book.instrumentId;
        this.tradeCoverage.end(id, now);
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
      const run = this.#runs.get(venue.id), head = { id: venue.id, name: venue.name, kind: venue.kind, recommended: venue.recommended, selected: !!run, listed: venue.listed };
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

  start(intervalMs = 250): void {
    if (!this.#timer) this.#timer = setInterval(() => this.step(), intervalMs);
    if (!this.#hydration) { this.#hydration = setTimeout(() => { void this.absorption.hydrate(); }, HYDRATE_AFTER_MS); (this.#hydration as { unref?: () => void }).unref?.(); }
  }
  stop(): void {
    if (this.#timer) clearInterval(this.#timer); this.#timer = null;
    if (this.#hydration) clearTimeout(this.#hydration); this.#hydration = null;
    for (const run of this.#runs.values()) { for (const c of [run.book, ...run.feeds]) c.stop(); this.tradeCoverage.end(run.book.instrumentId, this.#now()); }
    this.#runs.clear(); this.flush();
  }

  /** One pass: value the books, record, and tell the page what changed. */
  step(now = this.#now()): void {
    const books = this.#value(now);
    // The trades of each instrument are covered while every feed carrying them is live (a failed one up to its last message).
    for (const run of this.#runs.values()) this.tradeCoverage.pass(run.book.instrumentId, run.trades.every(c => c.state === 'live'), now, Math.min(...run.trades.map(c => c.lastUpdate || now)));
    // A pass with no book yet must not use up the sample interval, or the first real sample waits five seconds.
    if (books.length && now - this.#lastSample >= SAMPLE_MS) { this.#lastSample = now; this.recorder.sample(books, now); }
    if (now - this.#lastFlush >= FLUSH_MS) { this.#lastFlush = now; this.footprints.flush(); this.printStream.flush(); this.liquidationStream.flush(); this.flows.flush(); this.absorption.flush(); this.tradeCoverage.flush(); }
    if (now - this.#lastFlowPush >= FLOW_SEC) { this.#lastFlowPush = now; const items = this.flows.take(); if (items.length) this.onFlow(items); }
    if (now - this.#lastPrune >= PRUNE_MS) { this.#lastPrune = now; this.recorder.prune(now); }
    this.#pollOi(now);
    this.#probe(now);
    this.#takeOrders(false);
    this.absorption.step();
    const found = this.absorption.takeFresh();
    if (found.groups.length || found.minutes.length) this.onAbsorption(found);
    const fresh = this.printStream.takeFresh();
    if (fresh.length) this.onPrints(fresh);
    const forced = this.liquidationStream.takeFresh();
    if (forced.length) this.onLiquidations(forced);
    const previous = this.#books;
    this.#books = books;
    if (books.length !== previous.length || books.some((book, i) => book !== previous[i])) this.onLevels(books, now);
    const tick = this.#tick(now);
    if (tick) { const key = JSON.stringify([tick.price, tick.instrumentId, tick.prices, tick.candles]); if (key !== this.#lastTick) { this.#lastTick = key; this.onTick(tick); } }
    const status = this.venueStatus(), signature = JSON.stringify(status);
    if (signature !== this.#lastStatus) { this.#lastStatus = signature; this.onStatus(status); }
  }

  /** Write everything not yet saved, including the minute still open and the orders still open (the page is going away). */
  flush(): void { this.#takeOrders(true); this.recorder.flush(); this.footprints.flush(true); this.printStream.flush(); this.flows.flush(true); this.absorption.step(true); this.absorption.flush(); this.tradeCoverage.flush(true); }

  /** Hand the market orders that are complete (all of them with `all`) to the prints and the size statistics. */
  #takeOrders(all: boolean): void {
    const orders = this.orders.drain(all);
    if (!orders.length) return;
    if (this.onTape) this.onTape(packTape(orders, this.#tapeSeq++));
    this.printStream.ingest(orders.map(orderRow));
    this.footprints.countOrders(orders);
  }

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
    // A trade the recordings already hold (a venue sending its recent trades again after a reload) is counted nowhere a second time.
    if (this.#recorded.holds(trade.instrumentId, trade.t)) return;
    const row = { instrumentId: trade.instrumentId, tradeId: trade.tradeId, side: trade.side, price: trade.price, notionalUsd: trade.notionalUsd, sourceTimestamp: trade.t };
    this.flows.ingest([row]);
    // A trade seen before (a feed that replays after a reconnect) is in the footprint already, and must not count twice in the candle either.
    if (this.footprints.ingest([row]) === 0) return;
    this.tradeCoverage.trade(trade.instrumentId, trade.tradeId, trade.t, this.#now());
    // The fill joins its market order; prints and size statistics are taken from orders once they are complete (`step`).
    for (const f of this.orders.add([{ ...row, order: trade.order }])) this.absorption.add(f.instrumentId, f.t, f.price, f.usd, f.side);
    const now = this.#now();
    this.#last.set(trade.instrumentId, { price: trade.price, at: now, t: trade.t });
    const start = Math.floor(trade.t / COLUMN_MS) * COLUMN_MS, candle = this.#candles.get(trade.instrumentId);
    if (!candle || start > candle[0]) this.#candles.set(trade.instrumentId, [start, trade.price, trade.price, trade.price, trade.price, trade.amount]);
    else if (start === candle[0]) { candle[2] = Math.max(candle[2], trade.price); candle[3] = Math.min(candle[3], trade.price); candle[4] = trade.price; candle[5] += trade.amount; }
  };

  /** A liquidation a venue reported: placed at the instrument's last traded price when the venue gives a bankruptcy price. */
  readonly #liquidation = (event: LiquidationEvent): void => { this.liquidationStream.ingest([event], id => { const last = this.#last.get(id); return last ? { price: last.price, at: last.t } : null; }); };

  /** An open-interest reading a venue's socket pushed (Bybit's ticker, OKX's open-interest channel): taken straight into the live series. */
  readonly #oiReading = (event: OiEvent): void => { this.#applyLiveOi(venueOf(event.instrumentId), event, true, event.instrumentId); };

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

  /** One instrument's footprint, or several (comma separated) added together, as the server's route answers. */
  footprint(instrumentId: string, tfMs: number, from: number, to: number, rowStep: number, cuts: readonly number[] = [], budget?: number, byVenue = false): FootprintAnswer { return this.footprints.queryMany(instrumentId.split(',').filter(Boolean).slice(0, MAX_PROFILE_INSTRUMENTS), from, to, tfMs, rowStep, this.#cuts(cuts), budget !== undefined && budget > 0 ? budget : Infinity, byVenue); }
  /** Size lines a question may draw (see `parseCuts`): any that are not are left out rather than refused, as the page asked for them itself. */
  #cuts(cuts: readonly number[]): number[] { return cuts.filter(c => Number.isFinite(c) && c >= this.footprints.floorUsd * (1 - 1e-9) && c <= MAX_CUT_USD).slice(0, MAX_CUTS); }

  /** Absorption candidates for these instruments over [from, to) and the minutes since `since` (see AbsorptionRecorder.query). */
  absorptionHistory(ids: readonly string[], mins: readonly number[], from: number, to: number, limit: number, since: number): Promise<AbsorptionAnswer> { return this.absorption.query(ids, mins, from, to, limit, since); }
  /** The absorption column for these instruments over [from, to), each at its threshold, on rows of `step` (see AbsorptionRecorder.profile). */
  absorptionProfile(ids: readonly string[], thresholds: readonly (number | null)[], from: number, to: number, step: number): Promise<AbsorptionProfileAnswer> { return this.absorption.profile(ids, thresholds, from, to, step); }

  /** Traded volume by price for these instruments over [from, to) (the traded-volume column). */
  profile(ids: readonly string[], from: number, to: number, rowStep: number): ProfileAnswer { return this.footprints.profile(ids, from, to, rowStep); }
  /**
   * The change in open interest of the perpetuals among `ids` over [from, to), by the prices that traded while it came about
   * (shared/oi-profile.ts): from the readings taken while the page was open, and the five-minute history of the venues that keep one.
   */
  async oiProfile(ids: readonly string[], from: number, to: number, rowStep: number): Promise<OiProfileAnswer> {
    const perps = ids.filter(oiInstrument).slice(0, MAX_PROFILE_INSTRUMENTS);
    // From two minutes before: the change into the window's first minute needs the reading before it.
    const series = await Promise.all(perps.map(async (id): Promise<OiSeries> => {
      const coins = !inverseOiId(id);
      return { id, coins, price: this.#last.get(id)?.price ?? 0, bars: await this.oi(id, 60_000, from - 2 * 60_000, to, !coins).catch(() => []) };
    }));
    return oiProfileOf(this.footprints, series, from, to, rowStep);
  }
  range(ids: readonly string[], from: number, to: number, band: { p0: number; p1: number } | null, rowStep: number): RangeAnswer { return this.footprints.range(ids, from, to, band, rowStep); }
  /** The value area of each window, each instrument's share of it judged by the coverage record (the page is not always open). */
  valueAreas(ids: readonly string[], windows: readonly { from: number; to: number }[], rowStep: number, share: number): ValueAreaAnswer {
    return this.footprints.valueAreas(ids, windows, rowStep, share, (id, from, to) => recordedMinutes(this.tradeCoverage, id, from, to, t => this.footprints.holds(id, t)));
  }

  /** The trades of these instruments added together by size over each of the last `windows` minutes (the page's strip). */
  sizes(ids: readonly string[], windows: readonly number[], cuts: readonly number[] = []): SizesAnswer { return this.footprints.sizes(ids, windows, this.#cuts(cuts)); }

  /**
   * When `ids` were recorded over the whole minutes of [from, to) (shared/coverage.ts): trades from the coverage record and the footprint's
   * minutes, depth from the columns' samples. A question too long or too wide is cut to what may be asked.
   */
  coverage(ids: readonly string[], metric: CoverageMetric, from: number, to: number): CoverageAnswer {
    const w = coverageWindow(Math.max(from, to - MAX_COVERAGE_SPAN_MS), to);
    const instruments = [...new Set(ids)].slice(0, MAX_COVERAGE_INSTRUMENTS).map(id => metric === 'trades'
      ? tradeAnswer(id, this.tradeCoverage, w.from, w.to, t => this.footprints.holds(id, t))
      : depthAnswer(id, this.recorder.samples(id, w.from, w.to), w.from, w.to));
    return { metric, from: w.from, to: w.to, asOf: this.#now(), instruments };
  }

  // ---- Recovery -------------------------------------------------------------------------------------------------------------------

  /**
   * Fill the gaps of the windows asked for from the venues' trade history (shared/recovery.ts), within one action's budget. One action at a
   * time: a request while one runs is done after it (with what the windows then lack), and the caller of the running one is answered by it.
   */
  recover(request: RecoveryRequest): Promise<RecoveryReport> {
    if (this.#recovering) { this.#recoverNext = request; return this.#recovering; }
    const run = this.#recoverOnce(request).finally(() => {
      this.#recovering = null;
      const next = this.#recoverNext; this.#recoverNext = null;
      if (next) void this.recover(next).catch(() => {});
    });
    this.#recovering = run;
    return run;
  }

  /** The history source of a running market (none: not running, no history a page can read, or its venue resting after a failure). */
  #historyOf(id: string): HistorySource | null {
    const venue = venueOf(id), listing = this.#listing(id);
    if (!listing || ![...this.#runs.values()].some(r => r.book.instrumentId === id)) return null;
    const source = historySource(venue, listing);
    return source && (this.#venueRest.get(source.bucket) ?? 0) <= this.#now() ? source : null;
  }

  async #recoverOnce(request: RecoveryRequest): Promise<RecoveryReport> {
    const ids = [...new Set(request.ids)].slice(0, MAX_COVERAGE_INSTRUMENTS);
    // Back from the background the feeds reconnect first: the gap ends where the live recording starts again, its seam the first trade then.
    for (let waited = 0; waited < RECOVERY_WAIT_MS && ids.some(id => this.#historyOf(id) && !this.tradeCoverage.isOpen(id)); waited += 250) await new Promise<void>(resolve => setTimeout(resolve, 250));
    const now = this.#now(), windows = request.windows.map(w => ({ from: w.from, to: Math.min(w.to, now) })).filter(w => w.to > w.from);
    const instruments = ids.flatMap(id => { const source = this.#historyOf(id); return source ? [{ id, source }] : []; });
    // A minute held from storage with no record of being covered (an older build recorded it) is not recovered: its trades would count twice.
    const unknown = (id: string) => (t: number): boolean => t < (this.#loadedThrough.get(id) ?? 0) && this.footprints.holds(id, t) && coveredMs(this.tradeCoverage.covered(id, t, t + COLUMN_MS), t, t + COLUMN_MS) === 0;
    // A window that reaches now ends where the open stretch does (its last pass): the moment since is the loop's beat, not a gap.
    const gapsOf = (id: string, from: number, to: number) => { const open = this.tradeCoverage.openTo(id), end = open !== null && open > from ? Math.min(to, open) : to; return trimUnknown(this.tradeCoverage.gaps(id, from, end), unknown(id)); };
    const jobs = planRecovery(windows, instruments, gapsOf);
    const found = new Map<string, { gaps: number; gapMs: number; recoveredMs: number }>();
    for (const job of jobs) { const f = found.get(job.id) ?? { gaps: 0, gapMs: 0, recoveredMs: 0 }; f.gaps++; f.gapMs += job.to - job.from; found.set(job.id, f); }
    const run = await runRecovery(jobs, this.#historyFetch, { budget: this.#recoveryBudget, now: this.#now, onResult: result => {
      this.#applyRecovered(result);
      if (result.covered) found.get(result.job.id)!.recoveredMs += result.covered[1] - result.covered[0];
    } });
    for (const bucket of run.failed) this.#venueRest.set(bucket, this.#now() + VENUE_REST_MS);
    return { pages: run.pages, rows: run.rows, ms: run.ms, stoppedBy: run.stoppedBy, failed: run.failed,
      instruments: ids.map(id => ({ id, recoverable: instruments.some(i => i.id === id), ...(found.get(id) ?? { gaps: 0, gapMs: 0, recoveredMs: 0 }) })) };
  }

  /**
   * One gap's recovered trades into the recordings, in one step with the stretch they cover: the footprint takes those the live recording does
   * not hold already (by trade id: the seam's last guard), the flow the same, their market orders (rebuilt from them alone) go to the size
   * statistics and the large orders without being handed on as new. Never the live callback: not the price, the candle, the trade dust or
   * the order builder of the live trades.
   */
  #applyRecovered(result: RecoveryResult): void {
    const id = result.job.id, taken: HistoryTrade[] = [], byId = new Map(result.rows.map(r => [r.tradeId, r]));
    const rows = result.rows.map(r => ({ instrumentId: id, tradeId: r.tradeId, side: r.side, price: r.price, notionalUsd: r.notionalUsd, sourceTimestamp: r.t }));
    const accepted: typeof rows = [];
    this.footprints.ingest(rows, row => { const r = byId.get(String(row.tradeId)); if (r) { taken.push(r); accepted.push(row as (typeof rows)[number]); } });
    this.flows.ingest(accepted);
    const orders = rebuildOrders(id, taken);
    this.footprints.countOrders(orders);
    this.printStream.ingest(orders.map(orderRow), false);
    if (result.covered) {
      const first = result.rows[0], last = result.rows[result.rows.length - 1];
      this.tradeCoverage.recovered(id, result.covered[0], result.covered[1], first ? { id: first.tradeId, t: first.t } : undefined, last ? { id: last.tradeId, t: last.t } : undefined);
    }
    if (result.covered || taken.length) this.onRecovered(id, result.covered?.[0] ?? result.job.from, result.covered?.[1] ?? result.job.to);
  }

  /** Taker flow per second for each instrument over [from, to), from its first recorded minute in that range. */
  flow(ids: readonly string[], from: number, to: number): FlowFrame { return this.flows.frame(ids, from, to); }

  prints(from: number, to: number, minUsd = this.printStream.floorUsd, limit = PRINTS_PER_ANSWER): Print[] { return this.printStream.query(from, to, Math.max(this.printStream.floorUsd, minUsd), limit); }

  /** Whale VWAP sums of `ids` (see print-sums.ts): null for a size that is not one of the bands. */
  printSums(ids: readonly string[], from: number, to: number, minUsd: number, stepMs: number): PrintSumsAnswer | null { return this.printStream.printSums(ids, from, to, minUsd, stepMs); }
  liquidations(from: number, to: number, minUsd = this.liquidationStream.floorUsd, limit = LIQUIDATIONS_PER_ANSWER): Liquidation[] { return this.liquidationStream.query(from, to, Math.max(this.liquidationStream.floorUsd, minUsd), limit); }

  /** How the coin is listed on the market an instrument belongs to (none: not this coin's market, so nothing is asked of it). */
  #listing(instrumentId: string) { return this.#coin.markets[venueOf(instrumentId) as MarketVenue]; }

  /** Candles from the venue's own history. An unreachable venue answers with nothing, and the page falls back to another one. */
  async candles(instrumentId: string, tfMs: number, from: number, to: number): Promise<Candle[]> {
    const listing = this.#listing(instrumentId); if (!listing) return [];
    try { return await fetchCandles(instrumentId, tfMs, from, to, this.#get, listing); } catch { return []; }
  }

  /** Open interest bars: the venue's own history where it has one, and the readings taken while the page was open. */
  /** `usd`: an inverse market's own USD in place of its coins (the samples that have one; its history, in coins, is left out). */
  async oi(instrumentId: string, tfMs: number, from: number, to: number, usd = false): Promise<OiBar[]> {
    const venue = venueOf(instrumentId), key = `${instrumentId}|${tfMs}|${from}|${to}`, cached = this.#oiCache.get(key), now = this.#now();
    let stored: Promise<OiRow[]>;
    if (cached && now - cached.at < OI_CACHE_MS) stored = cached.rows;
    else { const listing = this.#listing(instrumentId); stored = listing ? fetchOiHistory(instrumentId, tfMs, from, to, this.#get, listing).catch(() => []) : Promise.resolve([]); this.#oiCache.set(key, { at: now, rows: stored }); if (this.#oiCache.size > 20) this.#oiCache.delete(this.#oiCache.keys().next().value!); }
    const live = (this.#oiLive.get(venue) ?? []).filter(sample => Number(sample.observationTimestamp) >= from);
    return usd ? oiBars(quoteRows(await stored), quoteRows(live), tfMs) : oiBars(await stored, live, tfMs);
  }

  /**
   * One live reading into the venue's series, one row a minute (the minute's last value, placed at the minute's start): the WebSocket
   * pushes several readings a minute and the REST fallbacks a few, and keeping every one would grow the three-day series with no new
   * minute bars. The newest row updates in place, so the newest value the panes read moves with every push. The recording keeps the same
   * one-row-a-minute rhythm (its store keys by venue and time). Only a socket reading proves the WebSocket is alive (`fromSocket`): the
   * REST fallback must not keep itself quiet. `instrumentId` is the reading's market (`venue:symbol`), so the page can put it in the
   * right series; the reading is handed to `onOiLive` the moment it lands.
   */
  #applyLiveOi(venue: string, reading: { t: number; base: number; quote?: number }, fromSocket = false, instrumentId?: string): void {
    const list = this.#oiLive.get(venue) ?? []; this.#oiLive.set(venue, list);
    const minute = Math.floor(reading.t / 60_000) * 60_000;
    // The WebSocket and the REST fallback can hand readings in either order; the minute's row is found wherever it sits.
    let index = -1;
    for (let i = list.length - 1; i >= 0; i--) if (Number(list[i]!.observationTimestamp) === minute) { index = i; break; }
    if (index >= 0) {
      const row = list[index]!;
      row.base = reading.base;
      if (reading.quote !== undefined) row.quote = reading.quote;
    } else {
      list.push({ observationTimestamp: minute, base: reading.base, ...(reading.quote !== undefined ? { quote: reading.quote } : {}) });
      while (list.length && Number(list[0]!.observationTimestamp) < reading.t - OI_KEEP_MS) list.shift();
      this.#oiStore?.save([{ venue, t: minute, base: reading.base, ...(reading.quote !== undefined ? { quote: reading.quote } : {}) }], reading.t - this.#retentionMs);
    }
    if (fromSocket) this.#oiTouched.set(venue, reading.t);
    if (instrumentId) this.onOiLive(instrumentId, reading);
  }

  #pollOi(now: number): void {
    for (const venue of OI_SAMPLE_VENUES) {
      const run = this.#runs.get(venue); if (!run) continue;
      // Bybit and OKX open interest arrives on the book socket: REST is asked only while that stream has gone quiet.
      if (OI_WS_VENUES.has(venue) && now - (this.#oiTouched.get(venue) ?? 0) < OI_SAMPLE_MS) continue;
      const interval = OI_WS_VENUES.has(venue) ? OI_WS_FALLBACK_MS : venue === 'binance' ? OI_BINANCE_POLL_MS : OI_SAMPLE_MS;
      if (now - (this.#oiAsked.get(venue) ?? 0) < interval) continue;
      this.#oiAsked.set(venue, now);
      const listing = this.#coin.markets[venue as MarketVenue]; if (!listing) continue;
      void fetchOiReading(venue, this.#get, listing).then(reading => {
        if (reading === null) return;
        // The venue's own clock where the answer carries one, so the reading lands in the minute the exchange stamped.
        this.#applyLiveOi(venue, { t: reading.sourceTimestamp ?? this.#now(), base: reading.base, ...(reading.quote !== undefined ? { quote: reading.quote } : {}) }, false, `${venue}:${listing.symbol}`);
      }, () => { /* the next tick asks again */ });
    }
  }

  // ---- Reachability ---------------------------------------------------------------------------------------------------------------

  /** Ask a venue that has not come up a plain REST question, once now and again every few minutes, to tell "unreachable" from "slow". */
  #probe(now: number): void {
    for (const run of this.#runs.values()) {
      const { book, probe } = run, ask = run.venue.probe;
      if (!ask || book.everLive || probe.pending) continue;
      if (book.failures < 2 && now - run.startedAt < PROBE_AFTER_MS) continue;
      if (probe.at && now - probe.at < PROBE_AGAIN_MS) continue;
      probe.pending = true; probe.at = now;
      void this.#ping(ask.url, ask.init).then(ok => { probe.ok = ok; }, () => { probe.ok = false; }).finally(() => { probe.pending = false; this.#lastStatus = ''; });
    }
  }
}
