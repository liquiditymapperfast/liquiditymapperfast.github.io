import type { ValuedBook } from './levels.ts';
import { BROWSER_RETENTION_MS, COLUMN_MS, DepthRecorder, MIN_BIN_USD, SAMPLE_MS, STALE_MS, type Column, type ColumnStore } from './recorder.ts';
import { FootprintRecorder, MAX_CUT_USD, MAX_CUTS, MAX_PROFILE_INSTRUMENTS, type FootprintStore, type ProfileAnswer, type RangeAnswer, type SizesAnswer, type ValueAreaAnswer } from './footprint.ts';
import { PRINT_FLOOR_USD, PRINTS_PER_ANSWER, PrintStream, type Print, type PrintStore } from './prints.ts';
import type { PrintSumsAnswer } from './print-sums.ts';
import { LIQUIDATION_FLOOR_USD, LIQUIDATIONS_PER_ANSWER, LiquidationStream, type Liquidation, type LiquidationEvent, type LiquidationStore } from './liquidations.ts';
import { OrderBuilder, orderRow, type MarketOrder } from './orders.ts';
import { packTape, type TapeBatch } from './tape.ts';
import { RecordedBefore } from './restart.ts';
import { AbsorptionRecorder, GROUP_FLOOR_USD, type AbsorptionAnswer, type AbsorptionProfileAnswer, type AbsorptionGroup, type AbsorptionMinute, type AbsorptionStore } from './absorption.ts';
import { FLOW_MEMORY_MS, FLOW_SEC, FlowRecorder, type FlowFrame, type FlowStore, type FlowUpdate } from './flow.ts';
import { TIMEFRAMES, quoteRows, type Candle, type OiBar, type OiRow } from './series.ts';
import { OI_PAGE_VENUES, OI_SAMPLE_VENUES, fetchCandles, fetchOiHistory, fetchOiReading, oiBars, venueOf, webGet, type Fetcher } from './history.ts';
import { inverseOiId, oiInstrument, oiProfileOf, type OiProfileAnswer, type OiSeries } from './oi-profile.ts';
import { oneSidedReading } from './oi-sides.ts';
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
/** The merged windows the newest recordings keep while the rest is read back (`preview`, a few seconds): a fifth of the recorder's. */
const PREVIEW_CACHE_BINS = 100_000;
const FLUSH_MS = 30_000, PRUNE_MS = 3_600_000, OI_SAMPLE_MS = 60_000, OI_KEEP_MS = 3 * 24 * 3_600_000, PROBE_AFTER_MS = 10_000, PROBE_AGAIN_MS = 5 * 60_000;
/** Binance has no open-interest WebSocket: its REST endpoint is polled this often (one weight per call; 12 a minute is 0.5 % of the IP budget). */
const OI_BINANCE_POLL_MS = 5_000;
/**
 * Bybit's and OKX's open interest arrives on the book socket, only when it changes. Their REST endpoint is asked, at the minute's cadence it
 * always had, only once the socket has brought no reading for a minute: a quiet market with a healthy socket costs no more requests than before.
 */
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
/**
 * A stored reading: `t` its minute (older builds stored each reading at its own time, with no `at`), `at` the reading's own time, `sides` 1
 * when its figures are on one side of every contract (every row a build from 2026-11-04 on writes; an older row is read with
 * `oneSidedReading`).
 */
export interface OiReading { venue: string; t: number; base: number; quote?: number; at?: number; sides?: 1 }
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
  /**
   * Grid steps for books the recordings hold nothing of (the recorded history's, app/browser/history-import.ts): such a book records on
   * the history's grid from its first minute, so the history it is shown with lies on its grid. A book the recordings hold keeps the step
   * of its oldest minute, as always.
   */
  gridSteps?: ReadonlyMap<string, number>;
  /** How a recovery reads a venue's trade history (shared/recovery.ts), and its budget; a test gives its own. */
  historyFetch?: HistoryFetch; recoveryBudget?: RecoveryBudget;
  /**
   * The recordings come later (`attach`): the engine starts at once without them, and keeps what it is given meanwhile to play it into the
   * recorders `attach` builds. A page opens its sockets this way while it reads its recordings and the recorded history.
   */
  deferred?: boolean;
}

/** The recordings an engine reads when it starts and writes to (the stores of `EngineOptions`), as `attach` takes them. */
export interface EngineStores {
  columns: ColumnStore | null; footprint: FootprintStore | null; prints: PrintStore | null; flow: FlowStore | null; absorption: AbsorptionStore | null;
  coverage: CoverageStore | null; liquidations: LiquidationStore | null; oi: OiStore | null;
}

/**
 * What an engine started without its recordings (`deferred`) was given until `attach`, in order: each trade and liquidation as it came (with
 * the price the liquidation was placed at), each pass's coverage of the trades and the books it sampled, and each time the market orders were
 * taken (the moment they were judged complete by, and whether all were: a flush), so the replay completes the same orders as the live run.
 */
type Note =
  | { k: 'trade'; at: number; trade: TradeEvent }
  | { k: 'liquidation'; at: number; event: LiquidationEvent; price: { price: number; at: number } | null }
  | { k: 'pass'; at: number; passes: [id: string, live: boolean, last: number][]; books: ValuedBook[] | null }
  | { k: 'drain'; at: number; all: boolean }
  | { k: 'end'; at: number; id: string };
/**
 * At most this many notes are kept. Past that nothing more is kept: `attach` plays in what was, and the trades' coverage stops where the
 * notes do, so what came after is a gap the page can recover rather than a stretch that says it was recorded.
 */
const NOTES_MAX = 100_000;
/**
 * Before `attach`, a trade stamped this long before the engine started is not taken live (a venue sending its recent trades again as it
 * connects, hours of them from dYdX): only the recordings can say whether it was counted already, and `attach` plays it in with them.
 */
const RESENT_MS = 10_000;
/** At most this many orders announced before the hand-over are remembered (`#announced`). */
const ANNOUNCED_MAX = 200_000;
const orderKey = (o: MarketOrder): string => `${o.instrumentId}|${o.tradeId}`;

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
export function packColumns(results: readonly { instrumentId: string; step: number; columns: readonly Column[] }[], close = false): ColumnSet[] {
  return results.map(({ instrumentId, step, columns }) => {
    const total = columns.reduce((sum, c) => sum + c.bins.length, 0);
    const bins = new Int32Array(total), bid = new Float32Array(total), ask = new Float32Array(total);
    let at = 0;
    for (const c of columns) { bins.set(c.bins, at); bid.set(c.bid, at); ask.set(c.ask, at); at += c.bins.length; }
    const lt = packLt(columns);
    return { id: instrumentId, step, times: columns.map(c => c.t), counts: columns.map(c => c.bins.length), samples: columns.map(c => c.n), bins, bid, ask, ...(lt ? { lt } : {}), ...(close ? { at: columns.map(c => c.at ?? c.t) } : {}) };
  });
}

export class Engine {
  // The recorders are built again when the recordings come after the start (`attach`).
  recorder!: DepthRecorder;
  footprints!: FootprintRecorder;
  printStream!: PrintStream;
  /** Taker buys and sells per instrument per second (the CVD column). */
  flows!: FlowRecorder;
  /** Market orders rebuilt from their fills: the prints and the size statistics count these. */
  orders: OrderBuilder;
  /** Absorption candidates and window statistics, from every fill once. */
  absorption!: AbsorptionRecorder;
  /** When each instrument's trades were recorded (shared/coverage.ts): a minute with nothing in it told apart from one nobody recorded. */
  tradeCoverage!: TradeCoverage;
  /** How far the recordings reached when this engine started (see shared/restart.ts). */
  #recorded!: RecordedBefore;
  /** Whether the recordings are still to come (`deferred`, until `attach`). */
  #waiting = false;
  /** The newest of the recordings, answering the map's columns until they come whole (`preview`); null when none came, and after `attach`. */
  #preview: DepthRecorder | null = null;
  /** What came since the start while they are (null when not); `#notesFull` once `NOTES_MAX` were kept. */
  #notes: Note[] | null = null; #notesFull = false;
  /**
   * An engine that started without its recordings: the orders it announced before they came (the trade dust, new prints), by their first
   * fill. The replay can leave one of them open (a fill the live run took and the recordings hold, a note past `NOTES_MAX`) and complete it
   * again later: it is recorded then, not announced a second time.
   */
  #announced: Set<string> | null = null;
  /** Orders stamped before this (an engine that started without its recordings: shortly before it started) are the past, never announced. */
  #newsFrom = -Infinity;
  /** Open-interest readings taken before the recordings were attached: they are written when they are. */
  #oiUnsaved: OiReading[] = [];
  /** When this engine was made (its clock). */
  readonly #startedAt: number;
  /** The time of the note being played again (`attach`): the recorders read it as theirs meanwhile. */
  #replayAt: number | null = null;
  readonly #clock = (): number => this.#replayAt ?? this.#now();
  readonly #scale: number;
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
  liquidationStream!: LiquidationStream;
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
  #oiStore: OiStore | null = null;
  readonly #retentionMs: number;
  readonly #oiAsked = new Map<string, number>();
  /** When (on this clock) each venue's socket last brought an open-interest reading: the WS venues skip REST while this is fresh. */
  readonly #oiTouched = new Map<string, number>();
  /** Each venue's newest reading by its own time: an older one (the socket and REST land in either order) changes nothing. */
  readonly #oiNewest = new Map<string, number>();
  /** The venues whose REST open-interest request is under way. */
  readonly #oiPolling = new Set<string>();
  readonly #oiCache = new Map<string, { at: number; rows: Promise<OiRow[]> }>();
  #lastSample = 0; #lastFlush = 0; #lastPrune = 0; #lastFlowPush = 0;
  #lastTick = ''; #lastStatus = '';
  #timer: ReturnType<typeof setInterval> | null = null;
  #hydration: ReturnType<typeof setTimeout> | null = null;

  constructor({ coin = BTC, tier = coin.tier, venues = browserVenues(coin), now = Date.now, get = webGet, ping = defaultPing, columns = null, footprint = null, prints = null, flow = null, absorption = null, coverage = null, liquidations = null, oi = null, retentionMs = BROWSER_RETENTION_MS, historyFetch = webHistoryFetch, recoveryBudget = RECOVERY_BUDGET, gridSteps, deferred = false }: EngineOptions = {}) {
    this.#retentionMs = retentionMs;
    this.#coin = coin; this.#venues = venues; this.#now = now; this.#get = get; this.#ping = ping; this.#historyFetch = historyFetch; this.#recoveryBudget = recoveryBudget;
    // A coin that trades less than BTC keeps smaller trades, groups and map cells (shared/coins.ts SCALES); BTC's are 1.
    this.#scale = SCALES[tier] ?? 1;
    this.#startedAt = now();
    this.orders = new OrderBuilder(now);
    this.#build({ columns, footprint, prints, flow, absorption, coverage, liquidations, oi }, gridSteps);
    if (oi) this.#loadOi(oi);
    if (deferred) { this.#waiting = true; this.#notes = []; this.#announced = new Set(); this.#newsFrom = this.#startedAt - RESENT_MS; }
  }

  /** The recorders, built from the recordings (at the start, or when they come later: `attach`). */
  #build({ columns, footprint, prints, flow, absorption, coverage, liquidations, oi }: EngineStores, gridSteps?: ReadonlyMap<string, number>): void {
    const now = this.#clock, retentionMs = this.#retentionMs, scale = this.#scale;
    // A page keeps far fewer merged windows than a server (about 6 MB at most): it holds a day, and it may be a phone.
    this.recorder = new DepthRecorder({ store: columns, now, retentionMs, minBinUsd: MIN_BIN_USD * scale, mergedCacheBins: 500_000, ...(gridSteps?.size ? { steps: new Map(gridSteps) } : {}) });
    this.footprints = new FootprintRecorder(footprint, now, retentionMs, scale);
    this.printStream = new PrintStream(prints, now, retentionMs, PRINT_FLOOR_USD * scale);
    // Minutes kept from before the footprint kept its lists of large orders get them from the prints kept beside them (a day at most, in
    // memory already: at once, where a server spreads it out).
    const unknown = this.footprints.unknownLists();
    if (unknown) { const list: Print[] = []; this.printStream.eachIn(unknown.from, unknown.to, p => list.push(p)); this.footprints.fillLists(unknown.from, unknown.to, list); }
    this.liquidationStream = new LiquidationStream(liquidations, now, retentionMs, LIQUIDATION_FLOOR_USD * scale);
    this.flows = new FlowRecorder(flow, now, Math.min(retentionMs, FLOW_MEMORY_MS), retentionMs);
    // It holds the whole day the page keeps, to answer the absorption column without reading the recordings (`start` reads it back).
    this.absorption = new AbsorptionRecorder(absorption, now, { retentionMs, floorUsd: GROUP_FLOOR_USD * scale, memoryMs: retentionMs });
    this.tradeCoverage = new TradeCoverage(coverage, now, retentionMs);
    this.#loadedThrough.clear();
    for (const id of this.footprints.instruments) this.#loadedThrough.set(id, this.footprints.lastMinute(id) + COLUMN_MS);
    this.#recorded = new RecordedBefore(this.flows, this.footprints);
    this.#oiStore = oi;
  }

  /**
   * The open-interest readings kept, into the live series: one row per venue and minute, at the minute's start, as `#applyLiveOi` keeps them:
   * of a minute's rows the newest reading by its own time (`at`; an older build's row has none and was stored at the reading's own time),
   * whichever build or tab wrote it. A minute already read live (the recordings came after the start: `#oiUnsaved`) keeps the newer of the
   * two, and a live reading that loses is not written over the newer one kept. A row an older build wrote with Hyperliquid's two-sided
   * figure is read as one side (`oneSidedReading`).
   */
  #loadOi(oi: OiStore): void {
    const minutes = new Map<string, { row: OiReading; at: number }>();
    for (const stored of oi.load(this.#now() - this.#retentionMs)) {
      const r = oneSidedReading(stored);
      const at = typeof r.at === 'number' && Number.isFinite(r.at) && r.at > 0 ? r.at : r.t;
      const key = `${r.venue}|${Math.floor(r.t / 60_000) * 60_000}`, held = minutes.get(key);
      if (!held || at > held.at) minutes.set(key, { row: r, at });
    }
    const live = new Map<string, OiRow>(), liveAt = new Map(this.#oiUnsaved.map(r => [`${r.venue}|${r.t}`, r.at ?? r.t]));
    for (const [venue, list] of this.#oiLive) for (const row of list) live.set(`${venue}|${Number(row.observationTimestamp)}`, row);
    for (const [key, { row: r, at }] of minutes) {
      const mine = live.get(key);
      if (mine) {
        if (!(at > (liveAt.get(key) ?? Infinity))) continue;
        mine.base = r.base; if (r.quote !== undefined) mine.quote = r.quote; else delete mine.quote;
        this.#oiUnsaved = this.#oiUnsaved.filter(u => `${u.venue}|${u.t}` !== key);
        this.#oiNewest.set(r.venue, Math.max(this.#oiNewest.get(r.venue) ?? 0, at));
        continue;
      }
      let list = this.#oiLive.get(r.venue); if (!list) { list = []; this.#oiLive.set(r.venue, list); }
      list.push({ observationTimestamp: Math.floor(r.t / 60_000) * 60_000, base: r.base, ...(r.quote !== undefined ? { quote: r.quote } : {}) });
      this.#oiNewest.set(r.venue, Math.max(this.#oiNewest.get(r.venue) ?? 0, at));
    }
    for (const list of this.#oiLive.values()) list.sort((a, b) => Number(a.observationTimestamp) - Number(b.observationTimestamp));
  }

  /** Whether what comes is kept for `attach` (the recordings are still to come, and `NOTES_MAX` is not reached). */
  get #keeping(): boolean { return this.#notes !== null && !this.#notesFull; }
  /** Keep `note` for `attach`; past `NOTES_MAX` nothing more is kept (see there). */
  #note(note: Note): void {
    if (!this.#keeping) return;
    if (this.#notes!.length < NOTES_MAX) this.#notes!.push(note);
    else { this.#notesFull = true; console.warn(`more than ${NOTES_MAX} events came before the recordings: what comes until they do is not recorded`); }
  }

  /** Whether the recordings are still to come (`deferred`, before `attach`). */
  get waiting(): boolean { return this.#waiting; }

  /**
   * The newest minutes of the recordings, for an engine still waiting for the rest (`deferred`): the map's columns are answered from them
   * until `attach` (`columns`, `heldSince`), so a returning page draws the hours it opens on while the day is read back (seconds of it). They
   * take the live samples meanwhile and are never written: `attach` builds the recorders from the whole recordings and plays in what came,
   * as it does without them. Only the store's `load` is read. Whether they hold any minute (none: the map waits for the recordings).
   */
  preview(columns: Pick<ColumnStore, 'load'>): boolean {
    if (!this.#waiting) return false;
    const store: ColumnStore = { load: since => columns.load(since), save: () => {}, prune: () => {} };
    const recorder = new DepthRecorder({ store, now: this.#clock, retentionMs: this.#retentionMs, minBinUsd: MIN_BIN_USD * this.#scale, mergedCacheBins: PREVIEW_CACHE_BINS });
    this.#preview = recorder.columns.size ? recorder : null;
    return this.#preview !== null;
  }
  /**
   * A sample of the live books into the newest recordings (`preview`). A book is valued on the step the live recorder keeps for it (its far
   * levels merged on it): one the newest recordings keep on another step is left out, as the hand-over leaves it out (`attach`), and one
   * they hold nothing of is kept on that step.
   */
  #previewSample(books: readonly ValuedBook[], now: number): void {
    const preview = this.#preview;
    if (!preview) return;
    preview.sample(books.filter(book => {
      const id = book.instrumentId, live = this.recorder.steps.get(id), step = preview.steps.get(id);
      if (step === undefined && live !== undefined) preview.steps.set(id, live);
      return step === undefined || step === live;
    }), now);
  }

  /**
   * The recordings, for an engine started without them (`deferred`): the recorders are built from them as a start with them builds them, and
   * what came since the start is played into those recorders in order, each at its own time, as if the recordings had been there all along:
   * a trade they hold already is not counted again (shared/restart.ts), and nothing recorded live is lost. What the replay finds is not
   * handed on as new (the page asks for the history again: it was answered from the live recording meanwhile). Null: no recordings come
   * (they could not be opened), and the recorders are built afresh all the same, so the trades held back (`RESENT_MS`) are taken.
   */
  attach(stores: EngineStores | null, gridSteps?: ReadonlyMap<string, number>): void {
    if (!this.#waiting) return;
    const notes = this.#notes ?? [], full = this.#notesFull, live = this.recorder.steps;
    this.#waiting = false; this.#notes = null; this.#notesFull = false; this.#preview = null;
    this.#build(stores ?? { columns: null, footprint: null, prints: null, flow: null, absorption: null, coverage: null, liquidations: null, oi: null }, gridSteps);
    if (stores?.oi) this.#loadOi(stores.oi);
    const orders = new OrderBuilder(this.#clock), passed = new Set<string>();
    try {
      for (const note of notes) {
        this.#replayAt = note.at;
        if (note.k === 'trade') this.#take(note.trade, orders, note.at);
        else if (note.k === 'liquidation') this.liquidationStream.ingest([note.event], () => note.price);
        else if (note.k === 'end') this.tradeCoverage.end(note.id, note.at);
        else if (note.k === 'drain') this.#record(orders.drain(note.all, note.at), false);
        else {
          for (const [id, isLive, last] of note.passes) this.tradeCoverage.pass(id, isLive, note.at, last);
          // A book sampled on another step than the recordings keep for it now (its first minutes were recorded on another) is left out, and
          // so is one whose minute the recordings hold a later minute after (the recorded history reached past it): only the newest held
          // minute takes more samples.
          const minute = Math.floor(note.at / COLUMN_MS) * COLUMN_MS;
          const books = note.books?.filter(book => {
            const step = this.recorder.steps.get(book.instrumentId), held = this.recorder.columns.get(book.instrumentId);
            return (step === undefined || step === live.get(book.instrumentId)) && !((held?.[held.length - 1]?.t ?? -Infinity) > minute);
          });
          if (books?.length) this.recorder.sample(books, note.at);
          this.absorption.step();
          for (const [id] of note.passes) passed.add(id);
        }
      }
      // The notes stopped short of now (`NOTES_MAX`): the trades are not covered past the last one.
      const last = notes[notes.length - 1];
      if (full && last) for (const id of passed) this.tradeCoverage.end(id, last.at);
    } finally { this.#replayAt = null; }
    this.orders = orders;
    // Already shown as they came, or (held back) not live: the page asks for the history again.
    this.printStream.takeFresh(); this.liquidationStream.takeFresh(); this.flows.take(); this.absorption.takeFresh();
    if (this.#oiStore && this.#oiUnsaved.length) this.#oiStore.save(this.#oiUnsaved, this.#now() - this.#retentionMs);
    this.#oiUnsaved = [];
    this.#lastStatus = ''; this.#lastTick = '';
    if (this.#timer) this.#hydrateLater();
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
        this.#note({ k: 'end', at: now, id });
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
      // A book that synchronises on its own (Bybit's full depth) says why it is not drawn yet; any other live book without a usable frame is crossed or one-sided.
      if (book.state === 'live') return { ...head, state: 'live' as const, detail: book.bookDetail() ?? (run.noBookSince && this.#now() - run.noBookSince >= NO_BOOK_MS ? 'no usable book right now (crossed or one-sided)' : '') };
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
    if (!this.#hydration) this.#hydrateLater();
  }
  /** The absorption recorder reads the rest of its day back a moment from now (again after `attach`, from the recordings it brought). */
  #hydrateLater(): void {
    if (this.#hydration) clearTimeout(this.#hydration);
    this.#hydration = setTimeout(() => { void this.absorption.hydrate(); }, HYDRATE_AFTER_MS); (this.#hydration as { unref?: () => void }).unref?.();
  }
  stop(): void {
    if (this.#timer) clearInterval(this.#timer); this.#timer = null;
    if (this.#hydration) clearTimeout(this.#hydration); this.#hydration = null;
    for (const run of this.#runs.values()) { for (const c of [run.book, ...run.feeds]) c.stop(); this.tradeCoverage.end(run.book.instrumentId, this.#now()); }
    this.#runs.clear(); this.flush();
  }

  /** One pass: value the books, record, and tell the page what changed. */
  step(now = this.#now()): void {
    const books = this.#value(now), note: Extract<Note, { k: 'pass' }> | null = this.#keeping ? { k: 'pass', at: now, passes: [], books: null } : null;
    // The trades of each instrument are covered while every feed carrying them is live (a failed one up to its last message).
    for (const run of this.#runs.values()) {
      const live = run.trades.every(c => c.state === 'live'), last = Math.min(...run.trades.map(c => c.lastUpdate || now));
      this.tradeCoverage.pass(run.book.instrumentId, live, now, last);
      note?.passes.push([run.book.instrumentId, live, last]);
    }
    // A pass with no book yet must not use up the sample interval, or the first real sample waits five seconds.
    if (books.length && now - this.#lastSample >= SAMPLE_MS) { this.#lastSample = now; this.recorder.sample(books, now); this.#previewSample(books, now); if (note) note.books = books; }
    if (note) this.#note(note);
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
    const at = this.#now();
    this.#note({ k: 'drain', at, all });
    this.#record(this.orders.drain(all, at), true);
  }
  /** Completed market orders into the prints and the size statistics; `live`: handed on as they come (the trade dust, new prints), not played again (`attach`). */
  #record(orders: MarketOrder[], live: boolean): void {
    if (!orders.length) return;
    // What is announced: not an order from before the start, nor (after the hand-over) one announced already (`#announced`).
    const announced = this.#announced, waiting = this.#waiting;
    const news = !live ? [] : orders.filter(o => o.t >= this.#newsFrom && !(announced && !waiting && announced.has(orderKey(o))));
    if (announced && waiting) for (const o of news) if (announced.size < ANNOUNCED_MAX) announced.add(orderKey(o));
    if (news.length && this.onTape) this.onTape(packTape(news, this.#tapeSeq++));
    const fresh = new Set(news);
    if (news.length) this.printStream.ingest(news.map(orderRow), true);
    if (news.length < orders.length) this.printStream.ingest(orders.filter(o => !fresh.has(o)).map(orderRow), false);
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
    const now = this.#now();
    if (this.#keeping) {
      this.#note({ k: 'trade', at: now, trade: { ...trade } });
      if (trade.t < this.#startedAt - RESENT_MS) return;
    }
    if (!this.#take(trade, this.orders, now)) return;
    this.#last.set(trade.instrumentId, { price: trade.price, at: now, t: trade.t });
    const start = Math.floor(trade.t / COLUMN_MS) * COLUMN_MS, candle = this.#candles.get(trade.instrumentId);
    if (!candle || start > candle[0]) this.#candles.set(trade.instrumentId, [start, trade.price, trade.price, trade.price, trade.price, trade.amount]);
    else if (start === candle[0]) { candle[2] = Math.max(candle[2], trade.price); candle[3] = Math.min(candle[3], trade.price); candle[4] = trade.price; candle[5] += trade.amount; }
  };

  /**
   * A trade into the recordings (`orders` builds its market order): false when they hold it already. A trade the recordings already hold (a
   * venue sending its recent trades again after a reload) is counted nowhere a second time.
   */
  #take(trade: TradeEvent, orders: OrderBuilder, now: number): boolean {
    if (this.#recorded.holds(trade.instrumentId, trade.t)) return false;
    const row = { instrumentId: trade.instrumentId, tradeId: trade.tradeId, side: trade.side, price: trade.price, notionalUsd: trade.notionalUsd, sourceTimestamp: trade.t };
    this.flows.ingest([row]);
    // A trade seen before (a feed that replays after a reconnect) is in the footprint already, and must not count twice in the candle either.
    if (this.footprints.ingest([row]) === 0) return false;
    this.tradeCoverage.trade(trade.instrumentId, trade.tradeId, trade.t, now);
    // The fill joins its market order; prints and size statistics are taken from orders once they are complete (`step`).
    for (const f of orders.add([{ ...row, order: trade.order }], now)) this.absorption.add(f.instrumentId, f.t, f.price, f.usd, f.side);
    return true;
  }

  /** A liquidation a venue reported: placed at the instrument's last traded price when the venue gives a bankruptcy price. */
  readonly #liquidation = (event: LiquidationEvent): void => {
    const last = this.#last.get(event.instrumentId), price = last ? { price: last.price, at: last.t } : null;
    this.#note({ k: 'liquidation', at: this.#now(), event: { ...event }, price });
    this.liquidationStream.ingest([event], id => id === event.instrumentId ? price : null);
  };

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

  /** Per instrument, where its newest run of recorded minutes begins (`DepthRecorder.contiguousSince`), +Infinity for one with none. */
  heldSince(ids: readonly string[], gapMs: number): Record<string, number> {
    const recorder = this.#preview ?? this.recorder;
    return Object.fromEntries(ids.map(id => [id, recorder.contiguousSince(id, gapMs)]));
  }

  /**
   * `close`: each window's book at its close, not its average (`DepthRecorder.query`). While the recordings are still to come, answered from
   * their newest minutes when the page has them (`preview`).
   */
  columns(ids: readonly string[], from: number, to: number, stepMs: number, close = false): ColumnsFrame {
    const step = Math.max(COLUMN_MS, Math.round(stepMs / COLUMN_MS) * COLUMN_MS), recorder = this.#preview ?? this.recorder;
    return { from, to, stepMs: step, instruments: packColumns(ids.map(id => ({ instrumentId: id, step: recorder.steps.get(id) ?? 0, columns: recorder.query(id, from, to, step, close) })), close) };
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

  /**
   * Candles from the venue's own history. An unreachable venue answers with nothing, and the page falls back to another one. Each page asks
   * for the bars the window needs, not the venue's most (Binance's 1,500 for the chart's 500 was three times the bytes and twice the weight).
   * A venue that says who bought (Binance) keeps it on each candle (`buy`): the Volume bars, the Bar stats and the scripts read it from the
   * chart's own candles instead of asking the venue for the same candles again (`measures/taker-rows.ts`).
   */
  async candles(instrumentId: string, tfMs: number, from: number, to: number): Promise<Candle[]> {
    const listing = this.#listing(instrumentId); if (!listing) return [];
    try { return await fetchCandles(instrumentId, tfMs, from, to, this.#get, listing, 12, { pageSize: 1500, buy: true }); } catch { return []; }
  }

  /**
   * Open interest bars: the venue's own history where it has one a page can read (`OI_PAGE_VENUES`: OKX's was asked on every refresh and
   * refused by the browser every time), and the readings taken while the page was open.
   */
  /** `usd`: an inverse market's own USD in place of its coins (the samples that have one; its history, in coins, is left out). */
  async oi(instrumentId: string, tfMs: number, from: number, to: number, usd = false): Promise<OiBar[]> {
    const venue = venueOf(instrumentId), key = `${instrumentId}|${tfMs}|${from}|${to}`, cached = this.#oiCache.get(key), now = this.#now();
    let stored: Promise<OiRow[]>;
    if (cached && now - cached.at < OI_CACHE_MS) stored = cached.rows;
    else { const listing = this.#listing(instrumentId); stored = listing && OI_PAGE_VENUES.includes(venue) ? fetchOiHistory(instrumentId, tfMs, from, to, this.#get, listing).catch(() => []) : Promise.resolve([]); this.#oiCache.set(key, { at: now, rows: stored }); if (this.#oiCache.size > 20) this.#oiCache.delete(this.#oiCache.keys().next().value!); }
    const live = (this.#oiLive.get(venue) ?? []).filter(sample => Number(sample.observationTimestamp) >= from);
    return usd ? oiBars(quoteRows(await stored), quoteRows(live), tfMs) : oiBars(await stored, live, tfMs);
  }

  /**
   * One live reading into the venue's series, one row a minute (the minute's last value, placed at the minute's start): the WebSocket
   * pushes several readings a minute and the REST fallbacks a few, and keeping every one would grow the three-day series with no new
   * minute bars. The newest row updates in place, so the newest value the panes read moves with every push, and is written again (the
   * store keeps one row per venue and minute, so the minute's last value is what a reload reads). A reading older than the venue's newest
   * changes nothing: the socket and the REST fallback can land in either order. Only a socket reading proves the WebSocket is alive
   * (`fromSocket`): the REST fallback must not keep itself quiet. `instrumentId` is the reading's market (`venue:symbol`), so the page can
   * put it in the right series; a reading taken is handed to `onOiLive` the moment it lands.
   */
  #applyLiveOi(venue: string, reading: { t: number; base: number; quote?: number }, fromSocket = false, instrumentId?: string): void {
    if (fromSocket) this.#oiTouched.set(venue, this.#now());
    if (reading.t <= (this.#oiNewest.get(venue) ?? 0)) return;
    this.#oiNewest.set(venue, reading.t);
    const list = this.#oiLive.get(venue) ?? []; this.#oiLive.set(venue, list);
    const minute = Math.floor(reading.t / 60_000) * 60_000, quote = reading.quote !== undefined ? { quote: reading.quote } : {};
    const last = list[list.length - 1];
    if (last && Number(last.observationTimestamp) === minute) { last.base = reading.base; if (reading.quote !== undefined) last.quote = reading.quote; }
    else {
      list.push({ observationTimestamp: minute, base: reading.base, ...quote });
      while (list.length && Number(list[0]!.observationTimestamp) < reading.t - OI_KEEP_MS) list.shift();
    }
    // Every reader gives one side of every contract (oi-sides.ts), and the row says so.
    const row: OiReading = { venue, t: minute, at: reading.t, base: reading.base, ...quote, sides: 1 };
    // Before the recordings come (`attach`) the reading waits to be written with them: one a venue and minute, the minute's newest.
    if (this.#waiting) { const i = this.#oiUnsaved.findIndex(r => r.venue === venue && r.t === minute); if (i < 0) this.#oiUnsaved.push(row); else this.#oiUnsaved[i] = row; }
    else this.#oiStore?.save([row], reading.t - this.#retentionMs);
    if (instrumentId) this.onOiLive(instrumentId, { t: reading.t, base: reading.base, ...quote });
  }

  #pollOi(now: number): void {
    for (const venue of OI_SAMPLE_VENUES) {
      const run = this.#runs.get(venue); if (!run) continue;
      // Bybit and OKX open interest arrives on the book socket: REST is asked only once that stream has brought none for a minute.
      if (OI_WS_VENUES.has(venue) && now - (this.#oiTouched.get(venue) ?? 0) < OI_SAMPLE_MS) continue;
      const interval = venue === 'binance' ? OI_BINANCE_POLL_MS : OI_SAMPLE_MS;
      if (now - (this.#oiAsked.get(venue) ?? 0) < interval) continue;
      // One request of a venue at a time: a slow answer (up to the fetcher's deadline) must not be overtaken by the next one's.
      if (this.#oiPolling.has(venue)) continue;
      this.#oiAsked.set(venue, now);
      const listing = this.#coin.markets[venue as MarketVenue]; if (!listing) continue;
      this.#oiPolling.add(venue);
      void fetchOiReading(venue, this.#get, listing).then(reading => {
        if (reading === null) return;
        // The venue's own clock where the answer carries one, so the reading lands in the minute the exchange stamped.
        this.#applyLiveOi(venue, { t: reading.sourceTimestamp ?? this.#now(), base: reading.base, ...(reading.quote !== undefined ? { quote: reading.quote } : {}) }, false, `${venue}:${listing.symbol}`);
      }, () => { /* the next tick asks again */ }).finally(() => { this.#oiPolling.delete(venue); });
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
