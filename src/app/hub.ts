import { connectionStatus } from './net.ts';
import type { BootstrapState, DataSource, FootprintResponse, TickMessage } from './source.ts';
import { PrintBook, fromWire, type Print } from './prints.ts';
import { LiquidationBook, fromWire as liquidationFromWire } from './liquidations.ts';
import { LIQUIDATIONS_PER_ANSWER } from '../shared/liquidations.ts';
import { FlowBook } from './flow-book.ts';
import type { AppState, Store, CandleRow, OiBar } from './store.ts';
import type { WorkerIn, WorkerOut, RasterStats } from './worker/raster.worker.ts';
import type { CellShare } from './cell-sources.ts';
import type { Bounds } from './view.ts';
import type { LtParams, LtSeries } from './lt.ts';
import { LtLane } from './lt-lane.ts';
import { pickOi, weakOi, type OiCandidate } from './oi-source.ts';
import { takeOiPushes, withOiPushes, type OiPush } from './oi-push.ts';
import { replaying } from './replay/clock.ts';
import { atOnePrice, inverseOi, oiSumOf, oiTail, type OiPart } from './oi-change.ts';
import { oiMarketIds } from './market-choice.ts';
import { nextBookGone } from './cvd/ids.ts';
import { t } from './i18n.ts';
import { MAX_PROFILE_SPAN_MS, MAX_VALUE_AREA_WINDOWS, type ProfileAnswer, type ValueAreaWindow } from '../shared/footprint.ts';
import { AbsorptionBook } from './absorption.ts';
import { ABSORPTION_RETENTION_MS, MAX_ABSORPTION_INSTRUMENTS } from '../shared/absorption.ts';
import { measureDef, type MetricFlags, type ProfileMetric } from './measures/registry.ts';
import { NO_FLAGS, type Thresholds } from './measures/measure.ts';
import { PRINTS_PER_ANSWER } from '../shared/prints.ts';
import { webGet } from '../shared/history.ts';
import { KeyLevelHistory } from './keylevels/history.ts';
import { LiqLevelsSource } from './liq-levels.ts';
import { TapeRing, tapeCapacity } from './tape/ring.ts';
import { isPhone } from './device.ts';
import type { SumRow } from '../shared/print-sums.ts';
import { ChartPriceHistory } from './price-history.ts';
import { ColumnHolds, columnReach, columnStepFor, settledBefore, type ColumnDrop } from './column-holds.ts';

export const TIMEFRAMES: Readonly<Record<string, number>> = { '1m': 60_000, '5m': 300_000, '15m': 900_000, '30m': 1_800_000, '1h': 3_600_000, '4h': 14_400_000, '1d': 86_400_000 };
const MINUTE = 60_000;
/** The most absorption groups one question asks of each instrument (the largest). */
const ABSORPTION_PER_INSTRUMENT = 4_000;

/**
 * One measure's column (`Hub.ensureMetricProfile`): its last answer (`held`: rows, what the record leaves out, the window's tag), whether the
 * source can answer, and the question in flight or last asked, kept per measure so several columns are asked side by side.
 */
interface MetricColumn {
  held: { step: number; answer: ProfileAnswer; flags: MetricFlags; tag: string } | null;
  state: 'ready' | 'unavailable';
  loading: boolean; asked: string; at: number; retryAt: number; ms: number; gen: number; settled: boolean;
  /** The question last asked, without its window (`base`), and its window. */
  window: AskedWindow | null;
}

/** A column's question without its window (instruments, rows, period), and the window it was asked for. */
interface AskedWindow { base: string; from: number; to: number }

/**
 * The part of a column's window a source can be asked about: all of it up to `MAX_PROFILE_SPAN_MS`, else its newest part, up to now for one
 * still under way (a month under way asked whole ends next month, and its newest eight days would lie in the future). The profile along the
 * top adds up the same window.
 */
export function askedSpan(from: number, to: number): { from: number; to: number } {
  if (!(to - from > MAX_PROFILE_SPAN_MS)) return { from, to };
  const end = Math.min(to, (Math.floor(Date.now() / MINUTE) + 1) * MINUTE);
  return { from: Math.max(from, end - MAX_PROFILE_SPAN_MS), to: end };
}

/**
 * Whether a column's question differs from the last one only by its window sliding forward with the live edge, both ends by no more than
 * `spacing`: such a question waits for the refresh spacing rather than going at once. Following the live edge the window moves every
 * minute, and a week of 27 markets asked again each time held the server for seconds every minute (measured 2026-10-19).
 */
function slidOnly(last: AskedWindow | null, base: string, from: number, to: number, spacing: number): boolean {
  return last !== null && last.base === base && from >= last.from && from - last.from <= spacing && to >= last.to && to - last.to <= spacing;
}
export { COLUMNS_SETTLE_MS, COLUMNS_FULL_EVERY_MS, COLUMN_STEPS_HELD, settledBefore } from './column-holds.ts';
/** `ids` with the sets that answer them, in `ids`' order; an instrument the source left out is answered by nothing (price grid 0). */
function answered(sets: readonly { id: string; step: number }[], ids: readonly string[]): { id: string; step: number }[] {
  const byId = new Map(sets.map(set => [set.id, set] as const));
  return ids.map(id => byId.get(id) ?? { id, step: 0 });
}

export interface RasterResult { id: number; w: number; h: number; data: Float32Array; stats: RasterStats; bounds: Bounds }

/** Owns data loading: bootstrap, live socket, candles, OI, recorded columns and the raster worker. */
/**
 * How long after a window ends its answer is still asked again: trades a venue sends late still reach the recording, and the footprint
 * rechecks the hour before for them as well (`RECHECK_SPAN_MS` in panes/footprint.ts). An answer from a source that had passed this is kept for good.
 */
export const VALUE_AREA_SETTLE_MS = 60 * MINUTE;
/** How far back the volume profile's candles reach: twenty weeks of lines and the week before the first. */
export const PROFILE_CANDLES_BACK_MS = 21 * 7 * 86_400_000;
/** A value area's key: the instruments, the row step and share it was read with, and its window. */
export const valueAreaKey = (ids: readonly string[], step: number, share: number, w: { from: number; to: number }): string => `${ids.join(',')}|${step}|${share}|${w.from}-${w.to}`;
/** The key a past window's traded volume by price is held by (`Hub.windowProfiles`): the instruments first, as `valueAreaKey`'s. */
export const windowProfileKey = (ids: readonly string[], step: number, w: { from: number; to: number }): string => `${ids.join(',')}|${step}|${w.from}-${w.to}`;

/** The perpetuals whose open interest is added together with every venue on (market-choice.ts). */
export { oiVenueIds } from './market-choice.ts';

/** At most this many pushed readings are held to be put on a load's answer (a load that takes longer may lose its oldest: the next push puts them right). */
const OI_DURING_MAX = 512;
/**
 * How long the open interest read whole serves the 20-second refresh, which reads only each market's last bars again (from the one before its
 * last held, at most `OI_TAIL_BARS` back: a market whose bars stopped a day ago asked for that whole day every time); then it is read whole.
 */
const OI_WHOLE_MS = 10 * 60_000, OI_TAIL_BARS = 6;
/** How many series (a market's timeframe) are kept for a switch to show at once: every timeframe of two markets. */
const SERIES_KEPT = 16;
/**
 * The other timeframes are read this long after a series is shown (the first time longer, while the page's own first reads are out), one
 * at a time with a pause between them, and again once what is kept of them is this old.
 */
const PREFETCH_FIRST_MS = 4_000, PREFETCH_AFTER_MS = 1_500, PREFETCH_GAP_MS = 400, PREFETCH_FRESH_MS = 3 * MINUTE;
/** A kept series is shown at once while its newest candle is at most this far behind now (or three of its candles, when longer). */
const KEPT_GAP_MS = 10 * MINUTE;


/** The other timeframes in the order they are read ahead: the nearest to the one on screen first, the shorter before the longer. */
export function prefetchOrder(timeframe: string): string[] {
  const all = Object.keys(TIMEFRAMES), at = all.indexOf(timeframe);
  if (at < 0) return all;
  return all.filter(tf => tf !== timeframe).sort((a, b) => Math.abs(all.indexOf(a) - at) - Math.abs(all.indexOf(b) - at) || all.indexOf(a) - all.indexOf(b));
}
/** One market's part with the pushed readings of that market in it; the same part when none changed it. */
function withPushed(part: OiPart, readings: readonly OiPush[], tfMs: number): OiPart {
  const bars = withOiPushes(part.bars, readings.filter(reading => reading.instrumentId === part.id), tfMs, part.usdAt);
  return bars ? { ...part, bars } : part;
}

/**
 * The market the page starts on: Binance's perpetual, the most liquid of the venues, where the page reads one (Karl, 2026-10-17: not
 * Hyperliquid's, which only came first in the venue list); else the reference price's market, else the first.
 */
export function defaultMarket(markets: readonly { instrumentId?: string; venue?: string; marketType?: string }[], reference: string): string {
  const binance = markets.find(m => m.venue === 'binance' && m.marketType === 'perpetual' && m.instrumentId);
  return binance?.instrumentId || reference || markets[0]?.instrumentId || '';
}

/** The Depth pane's answer: `k` nested bands per pixel column, `bid[x * k + j]` the bid USD within band j (each band holds the inner ones), and the same in coins. */
export interface DepthAnswer { k: number; bid: Float32Array; ask: Float32Array; bidCoin: Float32Array; askCoin: Float32Array }

export class Hub {
  readonly priceHistory: ChartPriceHistory;
  readonly worker: Worker;
  #ready: Promise<void>;
  #rasterId = 0;
  #inflight = new Map<number, Bounds>();
  /**
   * The recorded columns the worker holds, by step and instrument (see `ColumnHolds`): each instrument is asked for on its own account, so a
   * book that comes or goes, or a zoom back to a step held, does not ask the source for the whole window of every instrument again.
   */
  #columns = new ColumnHolds();
  /** The step the worker reads (`columnsUse`) and the one the last `loadColumns` wanted; the worker starts at one-minute columns. */
  #columnsDrawn = MINUTE;
  #columnsWanted = MINUTE;
  /** How far the page's clock is ahead of the source's (the bootstrap says the source's): windows settle by the source's clock. */
  #sourceSkew = 0;
  #columnsLoading = false;
  /** The newest windows may have changed since they were asked for (the clock says so every 30 s): the next load asks for them again. */
  #columnsStale = false;
  #series = '';
  /** What the candles on screen are of (the context asked for, and the instrument that answered), or null when they are of nothing that can be told. */
  #loaded: { key: string; instrument: string } | null = null;
  #oiKey = '';
  /** Counts the requests for the series and for open interest, so an answer can tell whether it is still the one wanted (the key names the context, not the request). */
  #seriesGen = 0; #oiGen = 0;
  /** The live candles of the latest tick, so an answer that arrives after them can be brought up to date with them. */
  #liveCandles: TickMessage['candles'] = {};
  /** The live minutes folded into the display candle, when it spans more than one. */
  readonly #liveTrack: { current: LiveTrack | null } = { current: null };
  /**
   * The series last read of each market and timeframe, the most recent last (at most `SERIES_KEPT`): a switch shows the one kept at once and
   * the read that follows brings it up to date (Karl, 2026-10-28: a timeframe switch should be instant). `#prefetch` fills it ahead.
   */
  readonly #seriesKept = new Map<string, { candles: CandleRow[]; instrument: string; at: number }>();
  /** A read ahead still out, by its series: a switch to that timeframe takes its answer rather than asking again behind it. */
  readonly #prefetchReads = new Map<string, Promise<{ candles: CandleRow[]; instrument: string }>>();
  #prefetchTimer: ReturnType<typeof setTimeout> | null = null;
  /** `#prefetchAgain`: a round was asked for while another was out (another market's, say): it starts when that one ends. */
  #prefetching = false; #prefetched = false; #prefetchAgain = false;
  /** The context whose candles are on screen (or none of them, after a switch), whether or not a read of it has answered yet. */
  #onScreen = '';
  /**
   * The series read that is out (`loadSeries`: its context and request), so the stream does not start that context from its live candle
   * meanwhile; only the request that set it clears it.
   */
  #reading: { key: string; generation: number } | null = null;
  /** The context whose last read came back with nothing while no reference market was known (`#learnReference` reads it again). */
  #emptyRead = '';
  /**
   * A context whose answer came back with nothing: the first load that shows candles of a read for it says so (`onSeriesRefilled`),
   * whichever it is. A live candle alone on an empty read does not: framed on one minute's range the price axis would be all but flat, and
   * the frame the first price gave stays until history comes.
   */
  #refill = '';
  /** The context shown from `#seriesKept` and grown by the stream since, until a read of it answers (`rebaseLive`). */
  #fromKept: string | null = null;
  /** The series read as the page starts, before the source has said anything (`start`): every load of its context takes it until one has its answer. */
  #warm: { key: string; read: Promise<{ candles: CandleRow[]; instrument: string }> } | null = null;
  /**
   * Every market order the live stream sent since the page opened, for the trade dust (memory only, never stored; empty while it is off).
   * Its ring is made when the dust is first switched on.
   */
  tape: TapeRing | null = null;
  /** Called when orders arrived for the dust. */
  onTape: () => void = () => {};
  /** A gap of a market was filled from its venue's trade history over [from, to) (the browser engine's recovery): never a flash or a sound. */
  onRecovered: (id: string, from: number, to: number) => void = () => {};
  /** The live connection's handle, so the dust can be asked for or stopped. */
  #live: { close(): void; tape(on: boolean): void } | null = null;
  #tapeOn = false;
  /** Ask the source for every order (the trade dust) or stop it; what is held stays until the page goes. */
  setTape(on: boolean): void {
    if (on && !this.tape) this.tape = new TapeRing(tapeCapacity(isPhone()));
    this.#tapeOn = on; this.#live?.tape(on);
  }
  /** Large trades for the bubbles: history for the window on screen plus everything the live stream has delivered. */
  readonly prints = new PrintBook();
  /** Called with each batch of new large trades from the live stream (for sounds). */
  onPrints: (fresh: Print[]) => void = () => {};
  /** Called when the print book changed, so the chart can redraw its bubbles. */
  onPrintsChanged: () => void = () => {};
  /** Liquidations held for the map (the venues that publish them), and a call when they change. */
  readonly liquidations = new LiquidationBook();
  /** The hourly candles the key levels are read from, straight from the exchange (keylevels/history.ts). */
  readonly keyHistory = new KeyLevelHistory(webGet);
  /** The Liquidation levels layer's file and the candles that take its levels away. */
  readonly liqLevels = new LiqLevelsSource(webGet);
  readonly #vwapHistories = new Map<number, KeyLevelHistory>();
  readonly #profileHistories = new Map<string, KeyLevelHistory>();
  /**
   * The whale VWAP's sums: the whole minutes answered (`rows`, before `to`) and since then the minutes added from the orders pushed live
   * (`tail`, from `to` on), so neither counts an order the other has. `since`: where the recording's count of large orders begins.
   */
  whale: { key: string; ids: ReadonlySet<string>; minUsd: number; since: number | null; rows: SumRow[]; to: number; tail: Map<number, SumRow>; at: number } | null = null;
  whaleState: 'ready' | 'unavailable' = 'ready';
  #whaleLoading = false;
  #whaleRetryAt = 0;
  /** The whale sums of `ids` from `from` for orders from `minUsd`: asked again every 45 seconds, a minute after a failure; never on a frame. */
  /** The whale sums were answered or failed (the VWAP panel says which). */
  onWhaleChanged: () => void = () => {};
  ensureWhale(ids: readonly string[], from: number, minUsd: number): void {
    const source = this.source;
    if (!source.printSums) { this.whaleState = 'unavailable'; return; }
    const now = Date.now(), key = `${[...ids].sort().join(',')}|${minUsd}|${Math.floor(from / MINUTE)}`, held = this.whale;
    if (this.#whaleLoading || now < this.#whaleRetryAt || !ids.length) return;
    if (held && held.key === key && now - held.at < 45_000) return;
    const to = Math.floor(now / MINUTE) * MINUTE;
    this.#whaleLoading = true;
    source.printSums([...ids], from, to, minUsd, MINUTE).then(answer => {
      const kept = this.whale?.key === key ? this.whale.tail : new Map<number, SumRow>();
      for (const minute of [...kept.keys()]) if (minute < to) kept.delete(minute);
      this.whale = { key, ids: new Set(ids), minUsd, since: answer.since, rows: answer.rows, to, tail: kept, at: Date.now() };
      this.whaleState = 'ready'; this.onPrintsChanged(); this.onWhaleChanged();
    }, () => { this.whaleState = 'unavailable'; this.#whaleRetryAt = Date.now() + 60_000; this.onPrintsChanged(); this.onWhaleChanged(); }).finally(() => { this.#whaleLoading = false; });
  }
  /** The whale sums held, answered minutes then live ones, oldest first. */
  whaleRows(): SumRow[] {
    const w = this.whale; if (!w) return [];
    return w.tail.size ? [...w.rows, ...[...w.tail.values()].sort((a, b) => a[0] - b[0])] : w.rows;
  }
  /** Add pushed orders to the whale tail: those of its instruments, from its size, in or after the first minute not answered. */
  #whaleTake(fresh: readonly Print[]): void {
    const w = this.whale; if (!w) return;
    for (const p of fresh) {
      if (p.t < w.to || p.usd < w.minUsd || !w.ids.has(p.id) || !(p.price > 0)) continue;
      const minute = Math.floor(p.t / MINUTE) * MINUTE;
      let row = w.tail.get(minute); if (!row) { row = [minute, 0, 0, 0, 0]; w.tail.set(minute, row); }
      if (p.side === 'buy') { row[1] += p.usd; row[2] += p.usd / p.price; } else { row[3] += p.usd; row[4] += p.usd / p.price; }
    }
  }
  /** The VWAP's candles of one bar size (a minute for a day's session, coarser for longer ones and old anchors), asked again every minute. */
  vwapHistory(barMs: number): KeyLevelHistory {
    let h = this.#vwapHistories.get(barMs);
    if (!h) {
      // At most a few sizes are in use at once; the one not asked for longest goes first.
      if (this.#vwapHistories.size >= 4) this.#vwapHistories.delete(this.#vwapHistories.keys().next().value!);
      h = new KeyLevelHistory(webGet, Date.now, 60_000);
    } else this.#vwapHistories.delete(barMs);
    this.#vwapHistories.set(barMs, h);
    return h;
  }
  /**
   * The volume profile's candles of one bar size (`traded/levels.ts` `candleBarMs`: five minutes, or one for sessions off the five), for
   * days, weeks and sessions worked out from candles: as far back as twenty weeks reach, the newest asked again every minute, with their taker
   * buys. `spot`: the spot market's that join them (`profileCompanion`).
   */
  profileHistory(barMs: number, market: 'main' | 'spot' = 'main'): KeyLevelHistory {
    const key = `${barMs}|${market}`;
    let h = this.#profileHistories.get(key);
    if (!h) { h = new KeyLevelHistory(webGet, Date.now, 60_000, PROFILE_CANDLES_BACK_MS); h.withBuy = true; this.#profileHistories.set(key, h); }
    return h;
  }
  /**
   * The chart market's candles of one timeframe with their taker buys (Binance's), for the volume strip's bars before the recording reaches:
   * the share of each candle bought at market.
   */
  candleTaker(tfMs: number): KeyLevelHistory {
    const key = `taker|${tfMs}`;
    let h = this.#profileHistories.get(key);
    if (!h) { h = new KeyLevelHistory(webGet, Date.now, 60_000, 3 * 365 * 86_400_000); h.withBuy = true; this.#profileHistories.set(key, h); }
    return h;
  }
  onLiquidationsChanged: () => void = () => {};
  /** A series whose answer came back empty has candles now (the reference market's, read once it was known, or a later reload): the page frames them. */
  onSeriesRefilled: () => void = () => {};
  /** 'unavailable': the source has no liquidations (a server from before them); asked again a minute later. */
  liquidationsState: 'ready' | 'unavailable' = 'ready';
  #liquidationsWindow: { t0: number; t1: number; min: number; cut: boolean; live: boolean } | null = null;
  #liquidationsLoading = false; #liquidationsRetryAt = 0;
  /** Taker flow per second for every instrument that has traded: the CVD column reads it, and sounds read what it just got. */
  readonly flow = new FlowBook();
  /** Called when the flow book changed (new seconds or history), about once a second. */
  onFlowChanged: () => void = () => {};
  #flowLoading = false;
  /** Whether the source answers older flow a minute at a time ('unavailable': the browser engine, which keeps a day, or a server from before). */
  flowMinutesState: 'ready' | 'unavailable' = 'ready';
  #flowMinutesLoading = false; #flowMinutesRetryAt = 0;
  /** The window the print book was last filled for, and the smallest order it was asked from. */
  /** The window of history the print book was last answered for, from which smallest size, and whether the answer was cut to its largest. */
  #printsWindow: { t0: number; t1: number; min: number; cut: boolean; live: boolean } | null = null;
  /** The live stream has closed at least once since it last opened, so the next open is a reconnection. */
  #dropped = false;
  /** Counts the times the live stream opened or closed: a history answer can tell whether it was asked for before the stream broke. */
  #connection = 0;
  #printsLoading = false;
  onRaster: (result: RasterResult) => void = () => {};
  #depthWaiters = new Map<number, (r: DepthAnswer) => void>();
  #ltWaiters = new Map<number, (r: LtSeries & { stepMs?: number }) => void>();
  /** The Liquidity Tracker's own way to its data, apart from the columns (lt-lane.ts): the pane reads it where the source has one and no size filter is set. */
  readonly ltLane: LtLane;
  /** Called when the lane holds something new (or failed), so the pane draws again. */
  onLtLane: () => void = () => {};
  #cellWaiters = new Map<number, (items: CellShare[]) => void>();
  /** Bumped whenever new recorded columns reach the worker, so derived series know to recompute. */
  columnsVersion = 0;
  /** Step of the recorded columns the worker currently holds. */
  columnStepMs = MINUTE;
  onColumns: () => void = () => {};
  busyMs = 0;
  /** Absorption candidates and window statistics: the window on screen and what the live stream added since. */
  readonly absorption = new AbsorptionBook();
  /**
   * For each instrument whose marks may be missing, the largest peak that may be: the smallest peak an answer cut at its limit kept (the
   * server keeps the largest), or the largest the book had to let go of the window on screen. Marks are missing only where that is at or above
   * the instrument's threshold; below it, what was left out was too small to be a mark.
   */
  get absorptionCut(): ReadonlyMap<string, number> { return this.absorption.cut; }
  /** 'unavailable': the source has no absorption (an older server); 'failed': a request failed, and is tried again a minute later. */
  absorptionState: 'ready' | 'unavailable' | 'failed' = 'ready';
  /** Called when absorption groups or minutes arrived (history or live). */
  onAbsorptionChanged: () => void = () => {};
  #absorptionLoading = false; #absorptionRetryAt = 0;
  /**
   * The last absorption answer asked on this connection: the instruments and threshold span (`key`) and the time from which their minutes
   * are held (the live stream keeps them current after that). Its window and the amount each instrument was asked from are the book's
   * `cover`, which a full book narrows when it lets claimed groups the view no longer needs go.
   */
  #absorptionCover: { key: string; minutesFrom: number } | null = null;
  /**
   * The traded-volume column's last answer, the row step it was asked on and the `tag` of the window it was asked for (the day, week or session
   * it adds up; empty for what is on the chart), so the column can tell it from another window's that began at the same time.
   */
  traded: { step: number; answer: ProfileAnswer; tag: string } | null = null;
  /**
   * Value areas of days, weeks and sessions by window (`valueAreaKey`), with when each was answered (`at`), the source's clock then (`asOf`:
   * what it reaches), and whether it can no longer change (`final`: answered a while after it ended), so it is not asked again (`ensureValueAreas`).
   */
  readonly valueAreas = new Map<string, ValueAreaWindow & { at: number; asOf: number; final: boolean }>();
  /** Traded volume by price of past days, weeks or sessions, by window (`windowProfileKey`), for their profiles on the chart (`ensureWindowProfiles`). */
  readonly windowProfiles = new Map<string, { answer: ProfileAnswer; at: number; final: boolean }>();
  #wpLoading = false; #wpRetryAt = 0;
  valueAreasState: 'ready' | 'unavailable' = 'ready';
  #vaLoading = false; #vaRetryAt = 0; #vaLastMs = 0;
  tradedState: 'ready' | 'unavailable' = 'ready';
  /** Called when the traded-volume column has a new answer (or the source said it has none). */
  onTraded: () => void = () => {};
  #tradedLoading = false; #tradedAsked = ''; #tradedAt = 0; #tradedRetryAt = 0;
  /** The traded-volume question last asked, without its window, and its window (`slidOnly`). */
  #tradedWindow: AskedWindow | null = null;
  /**
   * How long the last traded-volume answer took (ms). A server answers on its only thread: a week of rows took 7 to 9 s on a live recording of
   * 27 markets (2026-10-18), during which it answered nothing else, so a slow answer is asked for again that much less often.
   */
  #tradedMs = 0;
  /** Whether the last question was asked for a window already over (see `ensureTraded`'s `settled`). */
  #tradedSettled = false;
  /** Counts the traded-volume questions, so an answer can tell whether it is still the one wanted. */
  #tradedGen = 0;
  /** Each measure's column other than traded volume (`ensureMetricProfile`): its last answer and how it is being asked, apart from the others. */
  readonly #metricColumns = new Map<ProfileMetric, MetricColumn>();
  #metricColumn(metric: ProfileMetric): MetricColumn {
    let c = this.#metricColumns.get(metric);
    if (!c) { c = { held: null, state: 'ready', loading: false, asked: '', at: 0, retryAt: 0, ms: 0, gen: 0, settled: false, window: null }; this.#metricColumns.set(metric, c); }
    return c;
  }
  /** A measure's last answer (measures/registry.ts), what it leaves out and the window it was asked for; null until one came. */
  metricProfile(metric: ProfileMetric): MetricColumn['held'] { return this.#metricColumns.get(metric)?.held ?? null; }
  /** Whether the source can answer for this measure ('unavailable': an older server; asked again a minute later). */
  metricState(metric: ProfileMetric): 'ready' | 'unavailable' { return this.#metricColumns.get(metric)?.state ?? 'ready'; }
  /**
   * Any measure's last answer by price, traded volume's included: what every column and the lines read, whichever side of the map they are
   * on (a measure drawn on both sides reads this one answer).
   */
  profile(metric: ProfileMetric): MetricColumn['held'] {
    if (metric !== 'volume') return this.metricProfile(metric);
    return this.traded ? { ...this.traded, flags: NO_FLAGS } : null;
  }
  /** Whether the source can answer for a measure by price, traded volume's included. */
  profileState(metric: ProfileMetric): 'ready' | 'unavailable' { return metric === 'volume' ? this.tradedState : this.metricState(metric); }
  /**
   * Make sure a measure has an answer by price for these instruments, this window and these rows: traded volume's question (`ensureTraded`)
   * or another measure's (`ensureMetricProfile`), each asked once however many columns draw it. Nothing in the question names where it is
   * drawn, so a column moved from one side of the map to the other asks nothing new.
   */
  ensureProfile(metric: ProfileMetric, ids: readonly string[], from: number, to: number, step: number, live: boolean, period: { tag: string; settled: boolean } = { tag: '', settled: false }, thresholds: Thresholds = new Map()): void {
    if (metric === 'volume') this.ensureTraded(ids, from, to, step, live, period);
    else this.ensureMetricProfile(metric, ids, from, to, step, live, period, thresholds);
  }
  /** Oldest recorded depth minute across instruments (ms), or 0 when nothing is recorded. */
  recordedSince = 0;
  /**
   * Where the depth the map can draw begins: the long history's first window when the source has one (app/archive/), else the recordings'.
   * The flow and candle seams stay on `recordedSince` (the archive holds depth only).
   */
  depthSince(): number {
    const archive = this.source.archiveFirst?.() ?? null;
    return archive !== null && archive > 0 && (this.recordedSince <= 0 || archive < this.recordedSince) ? archive : this.recordedSince;
  }
  /** Instrument with candle history to fall back to when the selected market has none. */
  #reference = '';
  /** Instruments with an open-interest series to fall back to, best first. */
  #oiReferences: string[] = [];

  constructor(readonly store: Store, readonly source: DataSource) {
    this.priceHistory = new ChartPriceHistory((id, tf, from, to, signal) => {
      if (!source.priceHistory) return Promise.reject(new Error('Price history is unavailable'));
      return source.priceHistory(id, tf, from, to, signal);
    });
    this.worker = new Worker(new URL('./worker/raster.worker.ts', import.meta.url), { type: 'module' });
    this.ltLane = new LtLane(source.ltLane?.bind(source), (stepMs, half, instruments) => {
      // The arrays are the lane's own copies, handed over rather than copied again.
      const buffers: ArrayBuffer[] = [];
      for (const item of instruments) for (const array of [item.times, item.values]) if (array.buffer instanceof ArrayBuffer) buffers.push(array.buffer);
      this.#post({ type: 'ltLane', stepMs, instruments }, buffers);
      void half;
    }, () => Date.now() - this.#sourceSkew, () => this.onLtLane());
    this.#ready = new Promise(resolve => {
      this.worker.onmessage = (event: MessageEvent<WorkerOut>) => {
        const message = event.data;
        if (message.type === 'ready') resolve();
        else if (message.type === 'error') console.error('raster worker:', message.message);
        else if (message.type === 'lt') { this.#ltWaiters.get(message.id)?.({ times: message.times, bid: message.bid, ask: message.ask, estimated: message.estimated, stepMs: message.stepMs }); this.#ltWaiters.delete(message.id); }
        else if (message.type === 'cell') { this.#cellWaiters.get(message.id)?.(message.items); this.#cellWaiters.delete(message.id); }
        else if (message.type === 'depth') { this.#depthWaiters.get(message.id)?.({ k: message.k, bid: message.bid, ask: message.ask, bidCoin: message.bidCoin, askCoin: message.askCoin }); this.#depthWaiters.delete(message.id); }
        else {
          const bounds = this.#inflight.get(message.id);
          this.#inflight.delete(message.id);
          this.busyMs = message.busyMs;
          if (bounds) this.onRaster({ id: message.id, w: message.w, h: message.h, data: message.data, stats: message.stats, bounds });
        }
      };
    });
  }

  #post(message: WorkerIn, transfer: Transferable[] = []): void { this.worker.postMessage(message, transfer); }

  /**
   * `likely`: the market the page will most likely open on, known before the source has said anything (the coin's Binance perpetual, which
   * `defaultMarket` picks wherever it is read; the store keeps no market). Its series is asked for at once, beside the bootstrap, and the
   * loads of its context take it (`loadSeries`); and the bootstrap does not wait for a first live price to choose a market (up to 4 s in
   * a page) when that one is listed: the reference market and the mark come with the first tick and the next bootstrap (`#noteBoot`).
   */
  async start(likely = ''): Promise<void> {
    const expected = this.store.state.marketId || likely, timeframe = this.store.state.timeframe;
    if (expected) {
      const tf = TIMEFRAMES[timeframe] ?? 3_600_000, now = Date.now();
      const read = this.source.candles(expected, timeframe, now - 500 * tf, now + tf).then(candles => ({ candles, instrument: expected }));
      read.catch(() => undefined);
      this.#warm = { key: `${expected}|${timeframe}`, read };
    }
    const boot = await this.source.bootstrap(expected ? { prefer: expected } : undefined);
    if (Number.isFinite(boot.now) && boot.now > 0) this.#sourceSkew = Date.now() - boot.now;
    const marketId = this.store.state.marketId || defaultMarket(boot.markets, boot.markInstrumentId);
    this.#noteRecorded(boot.recorded);
    this.#reference = boot.markInstrumentId; this.#oiReferences = boot.oiReferences ?? [];
    this.store.set({ markets: boot.markets, marketId, mark: { price: boot.markPrice, asOf: boot.asOf }, layers: boot.layers ?? {} });
    await this.#ready;
    // A source that says when venues change (the browser) keeps the market list current without being asked.
    let pending: ReturnType<typeof setTimeout> | undefined;
    this.source.venues.watch?.(() => { clearTimeout(pending); pending = setTimeout(() => void this.refreshMarkets(), 300); });
    this.#live = this.source.connect({
      onOpen: () => {
        this.#connection++; this.#printsWindow = null; this.#liquidationsWindow = null; this.#absorptionCover = null;
        // What the stream said while it was down is in the recordings and not in the book: ask for the history again (the first open has nothing to repair).
        if (this.#dropped) { this.#dropped = false; this.flow.invalidate(); }
        this.store.set({ connected: true, status: t('live') });
      },
      onClose: (failures, host) => { this.#connection++; this.#dropped = true; this.store.set({ connected: false, status: connectionStatus(failures, host) }); },
      onLevels: frame => {
        const s = this.store.state, bookGone = nextBookGone(s.levels, frame, s.bookGone);
        this.store.set(bookGone === s.bookGone ? { levels: frame } : { levels: frame, bookGone });
        this.#post({ type: 'live', books: frame.books, now: Date.now() });
      },
      onTick: tick => this.#tick(tick),
      onLayers: message => this.store.set({ layers: message.layers }),
      onFlow: items => { this.flow.apply(items); this.onFlowChanged(); },
      onTape: batch => { if (!this.#tapeOn || !this.tape) return; this.tape.add(batch, this.#connection, performance.now(), Date.now()); this.onTape(); },
      onAbsorption: (groups, minutes) => { this.absorption.add(groups); this.absorption.addMinutes(minutes); this.onAbsorptionChanged(); },
      // The large orders of the stretch are in the recording now, not among the fresh ones: the window held is asked for again.
      onRecovered: (id, from, to) => { this.#printsWindow = null; this.#dropValueAreas(id, from, to); this.onRecovered(id, from, to); },
      // The browser's recordings came after its feeds: the flow held is the live seconds alone, the open interest lacks the readings kept
      // (read whole once, then only its newest bars), and the recording begins earlier than it said.
      onHistory: () => { this.flow.invalidate(); this.onFlowChanged(); this.#oiGen++; this.#oiHeld = null; void this.loadOi().catch(() => undefined); void this.refreshMarkets(); },
      onPrints: items => {
        const fresh = this.prints.add(items.flatMap(row => { const p = fromWire(row); return p ? [p] : []; }));
        if (fresh.length) { this.#whaleTake(fresh); this.onPrints(fresh); this.onPrintsChanged(); }
      },
      onLiquidations: items => {
        const fresh = this.liquidations.add(items.flatMap(row => { const l = liquidationFromWire(row); return l ? [l] : []; }));
        if (fresh.length) this.onLiquidationsChanged();
      },
      // Open interest is pushed the moment the source has a reading: the pane follows the exchanges, not the clock.
      onOiPush: items => this.#oiPush(items),
    });
    this.#live.tape(this.#tapeOn);
    // The long history's tiles come after the columns that could use them were answered: what is held is asked for whole again (the worker
    // keeps drawing it meanwhile), and the frame that asks comes now.
    this.source.setArchiveListener?.(change => {
      if (change) { void this.#archiveArrived(change.level * MINUTE, change.from, change.to).catch(error => console.warn('long history:', error)); return; }
      this.#columns.expireWhole(); this.#columnsStale = true; this.onColumns();
    });
    // A hidden page reads nothing ahead (`#prefetch`): shown again, it reads what went stale meanwhile.
    if (typeof document !== 'undefined') document.addEventListener('visibilitychange', () => { if (!document.hidden && this.#prefetched) this.#schedulePrefetch(); });
  }

  #noteRecorded(recorded: Record<string, { first: number }> | undefined): void {
    const firsts = Object.values(recorded ?? {}).map(r => r.first);
    this.recordedSince = firsts.length ? Math.min(...firsts) : 0;
  }

  /** Re-read the market list after venues were switched on or off, and leave a market that is gone for the reference one. */
  async refreshMarkets(): Promise<void> {
    const boot = await this.source.bootstrap().catch(() => null);
    if (!boot) return;
    this.#noteBoot(boot); this.#noteRecorded(boot.recorded);
    const key = (list: readonly { instrumentId?: string }[]): string => list.map(m => m.instrumentId).join(',');
    const { markets, marketId } = this.store.state;
    if (key(boot.markets) === key(markets)) return;
    const gone = marketId !== '' && !boot.markets.some(m => m.instrumentId === marketId);
    this.store.set({ markets: boot.markets, ...(gone ? { marketId: defaultMarket(boot.markets, boot.markInstrumentId) } : {}) });
  }

  #tick(tick: TickMessage): void {
    this.#learnReference(tick.instrumentId);
    const { state } = this.store;
    const patch: Parameters<Store['set']>[0] = {};
    this.#liveCandles = tick.candles;
    // A source that knows every live price (the browser) gives the market on screen its own; otherwise only the reference instrument moves the mark,
    // and a market that is not the reference is moved by its own live candle (its close is its latest price) while that is fresh.
    const own = tick.prices?.[state.marketId], selected = tick.candles[state.marketId];
    if (own !== undefined) patch.mark = { price: own, asOf: tick.asOf };
    else if (tick.instrumentId === state.marketId || !state.marketId || !(state.mark.price > 0)) patch.mark = { price: tick.price, asOf: tick.asOf };
    else if (selected && selected[4] > 0 && tick.asOf - selected[0] <= 2 * MINUTE) patch.mark = { price: selected[4], asOf: tick.asOf };
    const live = tick.candles[state.seriesInstrument || state.marketId];
    // A market with no history yet starts its series from the live candle: waiting for history that is not coming leaves the chart empty;
    // but while the read of a series just chosen is out, its live candle alone would stand for the candle under way (a minute of a day).
    if (live && !(this.#loaded === null && this.#reading?.key === `${state.marketId}|${state.timeframe}`)) patch.candles = mergeLive(state.candles, live, TIMEFRAMES[state.timeframe] ?? 3_600_000, this.#liveTrack);
    this.store.set(patch);
  }

  /** A quick start (`start`) may have had no reference market yet: the first bootstrap that names one sets it. */
  #noteBoot(boot: BootstrapState): void { this.#learnReference(boot.markInstrumentId); }

  /**
   * The reference market, the first time one is known (after a quick start the bootstrap had none): a series that came back empty for want
   * of it (its market's own history unreadable here, a blocked exchange) is read again at once, falling back to it, rather than at the next
   * minute's reload.
   */
  #learnReference(id: string): void {
    if (this.#reference || !id) return;
    this.#reference = id;
    if (this.#emptyRead && this.#emptyRead === this.#series) {
      this.#emptyRead = '';
      void this.loadSeries(true).catch(() => undefined);
    }
  }

  /** The last 500 candles of a market's timeframe, or the reference market's where it has none. */
  async #readSeries(marketId: string, timeframe: string): Promise<{ candles: CandleRow[]; instrument: string }> {
    const tf = TIMEFRAMES[timeframe] ?? 3_600_000, now = Date.now();
    const candles = await this.source.candles(marketId, timeframe, now - 500 * tf, now + tf);
    if (candles.length || !this.#reference || this.#reference === marketId) return { candles, instrument: marketId };
    return { candles: await this.source.candles(this.#reference, timeframe, now - 500 * tf, now + tf), instrument: this.#reference };
  }

  #keep(key: string, candles: CandleRow[], instrument: string): void {
    // A source that could not read a market answers with nothing: that is not kept to be shown, nor taken as read (it is asked again), and
    // what was kept of it before stays.
    if (!candles.length) return;
    this.#seriesKept.delete(key); this.#seriesKept.set(key, { candles, instrument, at: Date.now() });
    while (this.#seriesKept.size > SERIES_KEPT) this.#seriesKept.delete(this.#seriesKept.keys().next().value!);
  }

  /**
   * Put a series on screen, with the live candle on top where it opens one the series lacks (see `loadSeries`); `bridge` false: not where it
   * would stand past a hole (a series kept from before, framed now; the next tick sets it).
   */
  #show(key: string, candles: CandleRow[], seriesInstrument: string, timeframe: string, again: boolean, bridge = true): void {
    const tf = TIMEFRAMES[timeframe] ?? 3_600_000, live = this.#liveCandles[seriesInstrument], last = candles[candles.length - 1];
    const bucket = live ? Math.floor(live[0] / tf) * tf : 0, opens = live !== undefined && (!last || bucket > last[0]) && (bridge || !last || bucket - last[0] <= tf);
    this.#loaded = { key, instrument: seriesInstrument }; this.#onScreen = key;
    // Open interest belongs to the candles it was loaded for: another timeframe's or market's bars are not shown under these while theirs are on their way.
    this.store.set({ candles: opens ? mergeLive(candles, live, tf, this.#liveTrack) : candles, candlesTimeframe: timeframe, seriesInstrument, ...(again ? {} : { oi: [], oiInstrument: '', oiParts: [] }) });
    if (candles.length && this.#refill === key) { this.#refill = ''; this.onSeriesRefilled(); }
  }

  /**
   * Read the series on screen. Another market or timeframe whose series is kept (`#seriesKept`) shows it at once and says so through `shown`
   * (the map frames it then); the read brings it up to date as a reload of what is on screen does. An unforced call for the series already
   * asked for answers with that load, under way or done (its `shown` is not called: the load it joins has its own): the page's own first
   * load waits for the one the store's new market started, rather than reading the same candles again (a busy server spent seconds on it).
   */
  loadSeries(force = false, shown?: () => void): Promise<void> {
    const { marketId, timeframe } = this.store.state;
    if (!force && marketId && `${marketId}|${timeframe}` === this.#series) return this.#seriesLoad ?? Promise.resolve();
    const load = this.#loadSeries(force, shown);
    this.#seriesLoad = load;
    const done = (): void => { if (this.#seriesLoad === load) this.#seriesLoad = null; };
    load.then(done, done);
    return load;
  }
  /** The newest series load, while it is under way (`loadSeries`). */
  #seriesLoad: Promise<void> | null = null;

  async #loadSeries(force: boolean, shown?: () => void): Promise<void> {
    void this.source.bootstrap().then(boot => { this.#noteRecorded(boot.recorded); this.#noteBoot(boot); }, () => {});
    const { marketId, timeframe } = this.store.state;
    const key = `${marketId}|${timeframe}`;
    if (!marketId) return;
    const sameSeries = this.#series === key;
    this.#series = key;
    const generation = ++this.#seriesGen;
    // Open interest that is still on its way for the context just left must not land in this one. A reload of the same series (the one each
    // minute) keeps what was read whole of it, so the 20-second refresh goes on reading only the last bars (Sol review, 2026-10-30: it read
    // every market's whole window again each minute).
    if (!sameSeries) { this.#oiGen++; this.#oiKey = ''; this.#oiHeld = null; }
    const tf = TIMEFRAMES[timeframe] ?? 3_600_000;
    // What is kept is shown at once only while it ends near enough to now to frame (`fit` frames the latest run of candles without a hole
    // wider than three; a page hidden for a while keeps a series of long ago), and without the live candle set past such a hole.
    const held = this.#loaded?.key !== key ? this.#seriesKept.get(key) : undefined, end = held?.candles[held.candles.length - 1]?.[0];
    const kept = held && end !== undefined && Math.floor(Date.now() / tf) * tf - end <= Math.max(3 * tf, KEPT_GAP_MS) ? held : undefined;
    if (kept) { this.#liveTrack.current = null; this.#show(key, kept.candles, kept.instrument, timeframe, false, false); this.#fromKept = key; shown?.(); }
    else if (this.#onScreen && this.#onScreen !== key) {
      // Nothing kept of it: the last context's candles (or what the stream added to a screen cleared for one whose read never came) are not
      // drawn under this one's label and spacing while its read is out (the map draws the exchange's candles meanwhile, from its price history).
      this.#loaded = null; this.#liveTrack.current = null; this.#fromKept = null; this.#onScreen = key;
      this.store.set({ candles: [], candlesTimeframe: timeframe, seriesInstrument: marketId, oi: [], oiInstrument: '', oiParts: [] });
    }
    let seriesInstrument = marketId;
    let candles: CandleRow[];
    const reading = { key, generation };
    this.#reading = reading;
    try {
      // A read already out for this series is taken (the one the page started with, or one read ahead); where it failed, it is asked again.
      // The page's first read is taken by every load of its context until one of them has its answer (a timeframe switched while the page
      // starts can make two), as a second read behind the first would hold a server that answers one at a time.
      if (this.#warm && this.#warm.key !== key) this.#warm = null;
      const warm = this.#warm?.read ?? null, shared = warm ?? this.#prefetchReads.get(key);
      try { ({ candles, instrument: seriesInstrument } = await (shared ?? this.#readSeries(marketId, timeframe))); }
      catch (error) { if (this.#warm?.read === warm) this.#warm = null; if (!shared) throw error; ({ candles, instrument: seriesInstrument } = await this.#readSeries(marketId, timeframe)); }
      if (warm && this.#warm?.read === warm) this.#warm = null;
      // The page's first read was asked before the reference market was known, so it did not fall back to it.
      if (!candles.length && seriesInstrument === marketId && this.#reference && this.#reference !== marketId) ({ candles, instrument: seriesInstrument } = await this.#readSeries(this.#reference, timeframe));
    } catch (error) {
      if (this.#reading === reading) this.#reading = null;
      if (key === this.#series && generation === this.#seriesGen) {
        // A refresh of what is on screen that fails leaves it as it is; candles (and open interest) of another timeframe or market are not left standing under this label.
        // (A screen cleared this way is framed by the load that first fills it: the page's own framing waits on this read, which failed.)
        if (this.#loaded?.key !== key) { this.store.set({ candles: [], candlesTimeframe: timeframe, seriesInstrument: marketId, oi: [], oiInstrument: '', oiParts: [] }); this.#loaded = null; this.#onScreen = key; this.#refill = key; }
        this.#series = this.#loaded?.key ?? '';
      }
      throw error;
    }
    if (this.#reading === reading) this.#reading = null;
    // Only the newest request may answer: an older one for the same context (a forced reload, a quick change and back) would put the series as it was then over what a newer one has set.
    if (key !== this.#series || generation !== this.#seriesGen) return;
    // A reload of what is on screen keeps what the stream has added to the open candle since the snapshot was taken, and goes on counting its minutes.
    const again = this.#loaded?.key === key && this.#loaded.instrument === seriesInstrument;
    if (!again) this.#liveTrack.current = null;
    this.#keep(key, candles, seriesInstrument);
    if (again && this.#fromKept === key) candles = rebaseLive(candles, this.store.state.candles, this.#liveTrack);
    else candles = keepGrowth(candles, again ? this.store.state.candles : [], this.#liveTrack.current, tf, Date.now());
    this.#fromKept = null;
    // Nothing for this market while no reference market was known yet (a quick start, an exchange blocked here): read again once one is.
    this.#emptyRead = !candles.length && seriesInstrument === marketId && !this.#reference ? key : '';
    // Not for a reload of what is on screen and framed: its next good answer must not frame it again over a zoom made meanwhile.
    if (!candles.length && !again) this.#refill = key;
    // Within a candle the stream and the snapshot cannot be put in order (the last tick may be older or newer than the moment the snapshot was taken), and the next tick settles it:
    // the live candle goes on top only where nothing in the snapshot can be later than it, a candle the snapshot does not have yet.
    this.#show(key, candles, seriesInstrument, timeframe, again);
    this.#schedulePrefetch();
    // Open interest follows on its own: the page frames the candles the moment they are shown, not once the open interest's history (pages
    // of it from several venues) has come too.
    void this.loadOi().catch(() => undefined);
  }

  /** Read the other timeframes ahead, a moment after a series is shown (a timer of its own that never holds a test's process open). */
  #schedulePrefetch(): void {
    if (this.#prefetchTimer !== null) clearTimeout(this.#prefetchTimer);
    const timer = setTimeout(() => { this.#prefetchTimer = null; void this.#prefetch(); }, this.#prefetched ? PREFETCH_AFTER_MS : PREFETCH_FIRST_MS);
    (timer as { unref?: () => void }).unref?.();
    this.#prefetchTimer = timer; this.#prefetched = true;
  }

  /**
   * The market's other timeframes, read one at a time, the nearest first (`prefetchOrder`), each where what is kept of it is missing or
   * older than `PREFETCH_FRESH_MS`. One read at a time keeps the source's connections for what the screen asks; another market or a hidden
   * page ends the round (the next series shown, or the page shown again, starts another); a read that fails (or that its source gave up
   * on) is left for the next round.
   */
  async #prefetch(): Promise<void> {
    if (this.#prefetching) { this.#prefetchAgain = true; return; }
    this.#prefetching = true;
    const { marketId, timeframe } = this.store.state;
    try {
      for (const tf of prefetchOrder(timeframe)) {
        if (this.store.state.marketId !== marketId || (typeof document !== 'undefined' && document.hidden)) return;
        const key = `${marketId}|${tf}`, held = this.#seriesKept.get(key);
        if (key === this.#series || (held && Date.now() - held.at < PREFETCH_FRESH_MS)) continue;
        // The read itself is what is waited for (the sources end a read that has no answer: 15 s an exchange page, 30 s the server), so
        // never more than one is out, and a switch to this timeframe takes it rather than asking again.
        const read = this.#readSeries(marketId, tf);
        this.#prefetchReads.set(key, read);
        try { const { candles, instrument } = await read; this.#keep(key, candles, instrument); }
        catch { /* asked again in the next round; the farther timeframes are read meanwhile */ }
        finally { if (this.#prefetchReads.get(key) === read) this.#prefetchReads.delete(key); }
        await new Promise(resolve => { const gap = setTimeout(resolve, PREFETCH_GAP_MS); (gap as { unref?: () => void }).unref?.(); });
      }
    } finally {
      this.#prefetching = false;
      if (this.#prefetchAgain) { this.#prefetchAgain = false; this.#schedulePrefetch(); }
    }
  }

  /**
   * Load open interest for the series on screen. The market's own series is used while it is healthy; otherwise a reference perp
   * with history stands in and `oiInstrument` says so. Safe to call often: it is one request when the market has OI.
   */
  loadOi(): Promise<void> {
    const state = this.store.state, { marketId, seriesInstrument, timeframe } = state;
    const own = seriesInstrument || marketId; if (!own) return Promise.resolve();
    const added = oiMarketIds(state, this.flow), venues = added ?? [];
    const key = `${own}|${timeframe}|${state.oiMarkets}|${venues.join(',')}`;
    // A load for the same markets still under way is the answer: asking again on the 20 s clock while a slow history (Bybit's pages, in a
    // page) is still coming would make every answer stale before it came, and the pane would never get one.
    const held = this.#oiInflight;
    if (held && held.key === key && held.generation === this.#oiGen) return held.promise;
    const promise: Promise<void> = this.#loadOi(own, key, added, venues).finally(() => { if (this.#oiInflight?.promise === promise) { this.#oiInflight = null; this.#oiDuring = []; } });
    this.#oiInflight = { key, generation: this.#oiGen, promise };
    return promise;
  }
  #oiInflight: { key: string; generation: number; promise: Promise<void> } | null = null;
  /**
   * The source pushes each new open-interest reading the moment it lands, so the pane moves with the exchanges instead of waiting for the
   * 20 s clock (which stays as the reconciliation: history, venues switched, a reading the push missed). A reading goes in the bucket of its
   * own time, in the units of the bars it joins (`withOiPushes`: an inverse market's USD at the bars' one price), and only when it is newer
   * than the last one taken for its market. A load answers with what the source held when it was asked, so the readings pushed while it was
   * under way are put on its answer again (`#oiDuring`), or a push would be taken back until the next one. A replay is the past (pushes say
   * nothing it did not know then), and a hidden page draws nothing: the next load catches up.
   */
  #oiPush(items: unknown[]): void {
    if (replaying() || (typeof document !== 'undefined' && document.hidden)) return;
    const readings = takeOiPushes(items).filter(reading => reading.t > (this.#oiPushed.get(reading.instrumentId) ?? 0));
    if (!readings.length) return;
    for (const reading of readings) this.#oiPushed.set(reading.instrumentId, reading.t);
    if (this.#oiInflight) {
      const at = Date.now();
      for (const reading of readings) this.#oiDuring.push({ at, reading });
      if (this.#oiDuring.length > OI_DURING_MAX) this.#oiDuring.splice(0, this.#oiDuring.length - OI_DURING_MAX);
    }
    const { state } = this.store, tf = this.#oiTf;
    if (state.oiParts.length > 1) {
      const parts = state.oiParts.map(part => withPushed(part, readings, tf));
      if (parts.some((part, i) => part !== state.oiParts[i])) this.store.set({ oiParts: parts, oi: oiSumOf(parts, tf).bars });
    } else if (state.oiInstrument) {
      const bars = withOiPushes(state.oi, readings.filter(reading => reading.instrumentId === state.oiInstrument), tf, state.oiPrice);
      if (bars) this.store.set({ oi: bars });
    }
  }
  /** The newest reading taken per market, by its own time. */
  readonly #oiPushed = new Map<string, number>();
  /** The readings taken while a load was under way, with when (put on its answer again when it lands). */
  #oiDuring: { at: number; reading: OiPush }[] = [];
  /** The timeframe of the bars on screen: a push goes into those, whatever timeframe a load under way is asking for. */
  #oiTf = 3_600_000;
  /** What the open-interest markets were last checked against (`refreshOiMarkets`), so a check with nothing new costs a comparison. */
  #oiChecked: readonly unknown[] = [];

  /**
   * Load open interest again when the markets it adds up are no longer those it was asked for. They are worked out from the flow book and
   * the books on the map, which a fresh page learns only after its candles have come: the first question then named no market, and nothing
   * asked again until the 20-second clock, so open interest (its pane, its column, the profile along the top) came about 20 s after
   * everything else (measured 2026-10-20). Safe to call on every flow push and frame: it only compares until what the markets are worked out
   * from changes, and waits for the candles of the chart on screen, whose load asks for open interest itself.
   */
  refreshOiMarkets(): void {
    const state = this.store.state, own = state.seriesInstrument || state.marketId;
    if (!own || state.oiMarkets === 'chart' || this.#loaded?.key !== this.#series) return;
    const inputs = [own, state.timeframe, state.oiMarkets, state.customMarkets, state.markets, state.disabledVenues, state.scope, state.bookGone, this.flow.ids.length, this.flow.loads, state.levels?.books.map(b => b.venue).join(',') ?? null];
    if (inputs.length === this.#oiChecked.length && inputs.every((v, i) => v === this.#oiChecked[i])) return;
    this.#oiChecked = inputs;
    const key = `${own}|${state.timeframe}|${state.oiMarkets}|${(oiMarketIds(state, this.flow) ?? []).join(',')}`;
    if (key !== this.#oiKey && this.#oiInflight?.key !== key) void this.loadOi();
  }

  async #loadOi(own: string, key: string, added: string[] | null, venues: string[]): Promise<void> {
    const state = this.store.state, { timeframe } = state;
    const tf = TIMEFRAMES[timeframe] ?? 3_600_000, now = Date.now(), from = now - 500 * tf, to = now + tf;
    // The same markets read whole within OI_WHOLE_MS: only their last bars are read again (`#loadOiTail`); a venue that answered nothing, or
    // a reference market standing in, is looked at again at the next whole read. Decided before anything is awaited, so the generation a
    // load in flight is held under (`loadOi`) is its own.
    const held = this.#oiHeld, parts = held?.key === key && this.#oiKey === key && now - held.at < OI_WHOLE_MS ? this.#oiHeldParts(tf) : null;
    if (parts) return this.#loadOiTail(key, tf, now, from, parts);
    this.#oiKey = key;
    const generation = ++this.#oiGen;
    // The readings pushed since this load was asked for, put on its answer (it holds what the source had when asked). A server's push that
    // left before the question and reached the page after the answer (it waits behind levels frames on the socket) is not told apart: an
    // answer says nothing of when its newest reading was taken, and the server's clock is not the exchanges'. It shows a reading a few
    // seconds old until the next push.
    const late = (): OiPush[] => this.#oiDuring.filter(entry => entry.at >= now).map(entry => entry.reading);
    // Added together: every venue's bars, asked for at once; only the venues the filter and the chips let through count, or the markets
    // picked ('custom', whatever the chips say). With one answering its own bars are shown, with none nothing (never a market left out
    // standing in, never the chart market in place of an empty list).
    if (added) {
      const answered: OiPart[] = (await Promise.all(venues.map(async id => ({ id, ...await this.oiSeries(id, timeframe, from, to).catch(() => ({ bars: [] as OiBar[] })) })))).filter(part => part.bars.length);
      if (this.#oiKey !== key || generation !== this.#oiGen) return;
      const pushed = late(), parts = answered.map(part => withPushed(part, pushed, tf));
      this.#oiTf = tf;
      if (parts.length > 1) this.store.set({ oi: oiSumOf(parts, tf).bars, oiInstrument: '', oiParts: parts, oiPrice: 0 });
      else this.store.set({ oi: [...(parts[0]?.bars ?? [])], oiInstrument: parts[0]?.id ?? '', oiParts: [], oiPrice: parts[0]?.usdAt ?? 0 });
      this.#oiHeld = { key, at: now };
      return;
    }
    const ids = [...new Set([own, this.#reference, ...this.#oiReferences].filter(Boolean))];
    const candidates: OiCandidate[] = [], prices = new Map<string, number>();
    for (const inst of ids) {
      const { bars, usdAt } = await this.oiSeries(inst, timeframe, from, to).catch(() => ({ bars: [] as OiBar[], usdAt: undefined }));
      candidates.push({ inst, bars }); if (usdAt) prices.set(inst, usdAt);
      if (!weakOi(bars, now, tf)) break;
    }
    if (this.#oiKey !== key || generation !== this.#oiGen) return;
    const chosen = pickOi(candidates, now, tf);
    if (!chosen) return;
    const usdAt = prices.get(chosen.inst);
    this.#oiTf = tf;
    this.store.set({ oi: [...withPushed({ id: chosen.inst, bars: chosen.bars, ...(usdAt ? { usdAt } : {}) }, late(), tf).bars], oiInstrument: chosen.inst, oiParts: [], oiPrice: usdAt ?? 0 });
    this.#oiHeld = { key, at: now };
  }
  /** The markets last read whole and when (`#loadOi`): what the 20-second refresh reads only the last bars of. */
  #oiHeld: { key: string; at: number } | null = null;

  /**
   * The markets on screen as parts (one market's bars are `state.oi`), or null where one has no bars, they are of another timeframe, or an
   * inverse market's are not at one price yet (read before there were candles to put its USD in coins at: Sol review, 2026-10-30).
   */
  #oiHeldParts(tf: number): OiPart[] | null {
    const state = this.store.state;
    const held: OiPart[] = state.oiParts.length > 1 ? state.oiParts : state.oiInstrument && state.oi.length ? [{ id: state.oiInstrument, bars: state.oi, ...(state.oiPrice ? { usdAt: state.oiPrice } : {}) }] : [];
    return held.length && this.#oiTf === tf && held.every(part => part.bars.length && (part.usdAt || !inverseOi(part.id))) ? held : null;
  }

  /**
   * The 20-second refresh of the markets read whole last (`held`, `#oiHeldParts`): each one's bars from the one before its own last on
   * (`OI_TAIL_BARS` back at most), put on those held (`oiTail`), an inverse market's at the one price its bars are at, with the readings
   * pushed meanwhile.
   */
  async #loadOiTail(key: string, tf: number, now: number, keepFrom: number, held: readonly OiPart[]): Promise<void> {
    const timeframe = this.store.state.timeframe, generation = ++this.#oiGen;
    const floor = Math.max(keepFrom, (Math.floor(now / tf) - OI_TAIL_BARS) * tf), froms = held.map(part => Math.max(floor, part.bars[part.bars.length - 1]![0] - tf));
    const tails = await Promise.all(held.map((part, i) => this.oiSeries(part.id, timeframe, froms[i]!, now + tf, part.usdAt).then(series => series.bars, (): OiBar[] => [])));
    if (this.#oiKey !== key || generation !== this.#oiGen) return;
    const pushed = this.#oiDuring.filter(entry => entry.at >= now).map(entry => entry.reading);
    // On the bars on screen now: pushes may have moved them while the tails were read.
    const current = this.#oiHeldParts(tf);
    if (!current || current.length !== held.length || current.some((part, i) => part.id !== held[i]!.id)) return;
    const parts = current.map((part, i) => withPushed({ ...part, bars: oiTail(part.bars, tails[i]!, froms[i]!, keepFrom) }, pushed, tf));
    if (parts.length > 1) this.store.set({ oi: oiSumOf(parts, tf).bars, oiParts: parts });
    else this.store.set({ oi: [...parts[0]!.bars] });
  }

  /**
   * A market's open interest as the panes count it, in coins. An inverse market counts it in USD, and its coins (the USD at each reading's
   * mark) move with the price while no contract opens or closes: it is read in its own USD and put in coins at one price, the newest close of
   * the candles on screen, so only contracts move it. A source with no USD readings (an older server, readings from before) gives its coins
   * put back into USD at each candle's close (`atOnePrice`), which is off by what the price moved between a reading and its candle's close.
   * `at`: the one price (the Range tool's, the price at its selection's end, so its dollar figure is the USD change itself).
   */
  async oiBars(id: string, tf: string, from: number, to: number, at?: number): Promise<OiBar[]> { return (await this.oiSeries(id, tf, from, to, at)).bars; }
  /** The same with, for an inverse market, the one price its coins were put at (`usdAt`): its change in USD is its change in coins times it. */
  async oiSeries(id: string, tf: string, from: number, to: number, at?: number): Promise<{ bars: OiBar[]; usdAt?: number }> {
    if (!inverseOi(id)) return { bars: await this.source.oi(id, tf, from, to) };
    const candles = this.store.state.candles, price = at ?? candles[candles.length - 1]?.[4] ?? 0;
    const usd = price > 0 ? await this.source.oi(id, tf, from, to, true).catch((): OiBar[] => []) : [];
    if (usd.length) return { bars: usd.map(b => [b[0], b[1] / price, b[2] / price, b[3] / price, b[4] / price]), usdAt: price };
    // Without candles the coins are left at each reading's own price: no one price to name.
    const bars = [...atOnePrice(await this.source.oi(id, tf, from, to), candles, at)];
    return price > 0 && candles.length ? { bars, usdAt: price } : { bars };
  }

  /**
   * Make sure the print book covers `view` with the orders from `minUsd` (history is fetched once per window and smallest size; the live
   * stream keeps it current after that). An answer holds at most the largest few thousand of its window (a day of BTC is far more), which is
   * what a wide view draws; a view zoomed well into a window whose answer was cut is asked for again, for its smaller orders. A window that
   * reached the present when it was asked for stays covered while the stream that keeps it current does: asking again every minute at the
   * live edge only made the server sort the same hours of orders again.
   */
  ensurePrints(view: Bounds, minUsd = 25_000): void {
    if (this.#printsLoading || !(view.t1 > view.t0)) return;
    const have = this.#printsWindow;
    const narrower = have !== null && have.cut && view.t1 - view.t0 < (have.t1 - have.t0) / 4;
    if (have && have.min === minUsd && have.t0 <= view.t0 && (have.live || have.t1 >= Math.min(view.t1, Date.now())) && !narrower) return;
    const span = view.t1 - view.t0, from = Math.floor(view.t0 - span * 0.5), to = Math.ceil(Math.min(view.t1 + span * 0.1, Date.now() + MINUTE)), live = to >= Date.now();
    this.#printsLoading = true;
    const connection = this.#connection;
    // An answer may add its prints whenever it comes, but it covers the window only for the connection it was asked on: one asked before the stream broke says nothing about the time the stream was down.
    // The book keeps a live window open-ended, so the orders the stream adds after it are kept like the window's own.
    this.source.prints(from, to, minUsd).then(rows => { this.prints.add(rows, { from, to: live ? Infinity : to }); if (connection === this.#connection) this.#printsWindow = { t0: from, t1: to, min: minUsd, cut: rows.length >= PRINTS_PER_ANSWER, live }; this.onPrintsChanged(); }, () => { /* the next frame retries */ }).finally(() => { this.#printsLoading = false; });
  }

  /**
   * Make sure the liquidation book covers `view` from `minUsd`, as `ensurePrints` does for the trade bubbles: history once per window and
   * smallest size, the live stream after that. A source without liquidations (an older server) is asked again a minute later.
   */
  ensureLiquidations(view: Bounds, minUsd: number): void {
    const source = this.source;
    if (!source.liquidations) { this.liquidationsState = 'unavailable'; return; }
    if (this.#liquidationsLoading || !(view.t1 > view.t0)) return;
    if (this.liquidationsState === 'unavailable' && Date.now() < this.#liquidationsRetryAt) return;
    const have = this.#liquidationsWindow;
    const narrower = have !== null && have.cut && view.t1 - view.t0 < (have.t1 - have.t0) / 4;
    if (have && have.min === minUsd && have.t0 <= view.t0 && (have.live || have.t1 >= Math.min(view.t1, Date.now())) && !narrower) return;
    const span = view.t1 - view.t0, from = Math.floor(view.t0 - span * 0.5), to = Math.ceil(Math.min(view.t1 + span * 0.1, Date.now() + MINUTE)), live = to >= Date.now();
    this.#liquidationsLoading = true;
    const connection = this.#connection;
    source.liquidations(from, to, minUsd).then(rows => {
      this.liquidations.add(rows, { from, to: live ? Infinity : to }); this.liquidationsState = 'ready';
      if (connection === this.#connection) this.#liquidationsWindow = { t0: from, t1: to, min: minUsd, cut: rows.length >= LIQUIDATIONS_PER_ANSWER, live };
      this.onLiquidationsChanged();
    }, () => { this.liquidationsState = 'unavailable'; this.#liquidationsRetryAt = Date.now() + 15_000; this.onLiquidationsChanged(); }).finally(() => { this.#liquidationsLoading = false; });
  }

  /**
   * Make sure the absorption book holds the window on screen for these instruments, and the minutes of the last `sdMinutes` for the
   * automatic threshold. Each instrument is asked from a quarter under its threshold, so a threshold drifting down a little does not ask
   * again (one with no threshold yet is asked only for its minutes, and then again once they give it one). As with the bubbles, history is
   * asked once per window and the live stream keeps it current: again when the window leaves what the book still claims (a full book lets go
   * of claimed groups the view no longer reaches, and its cover then starts after them), a threshold falls under what it was asked from, or
   * the stream reconnected. A source that cannot answer (an older server) is asked again a minute later. With `statsOnly` (the marks are off
   * and only the absorption column judges groups) only the minutes are asked for (`#ensureAbsorptionMinutes`).
   */
  ensureAbsorption(allIds: readonly string[], allThresholds: readonly (number | null)[], view: Bounds, sdMinutes: number, statsOnly = false): void {
    // More instruments than one question may name is more markets than any page has; the first are asked about.
    const ids = allIds.slice(0, MAX_ABSORPTION_INSTRUMENTS), thresholds = allThresholds.slice(0, MAX_ABSORPTION_INSTRUMENTS);
    if (statsOnly) { if (ids.length) this.#ensureAbsorptionMinutes(ids, sdMinutes); return; }
    if (!ids.length || !(view.t1 > view.t0)) return;
    const now = Date.now(), MIN = 60_000;
    // Nothing older than the recorder keeps exists (and the server refuses a question of more than eight days): a map zoomed out further
    // asks from there.
    const kept = Math.floor((now - ABSORPTION_RETENTION_MS) / MIN) * MIN, t0 = Math.max(view.t0, kept);
    if (!(view.t1 > t0)) return;
    const span = view.t1 - view.t0, from = Math.max(kept, Math.floor((t0 - span * 0.25) / MIN) * MIN);
    // How far back the view needs groups, told as the map draws: claimed groups before it are what a full book lets go first.
    this.absorption.needFrom(from);
    if (this.#absorptionLoading) return;
    if (this.absorptionState !== 'ready' && now < this.#absorptionRetryAt) return;
    const key = `${ids.join(',')}|${sdMinutes}`, have = this.#absorptionCover?.key === key ? this.#absorptionCover : null, cover = this.absorption.cover;
    if (have && cover && cover.from <= t0 && cover.to >= Math.min(view.t1, now) && thresholds.every((v, i) => v === null || v >= (cover.mins.get(ids[i]!) ?? Infinity))) return;
    const to = Math.ceil(Math.min(view.t1 + span * 0.1, now + MIN) / MIN) * MIN;
    const mins = thresholds.map(v => v === null ? Number.MAX_SAFE_INTEGER : Math.floor(v * 0.75));
    // The minutes: all of the span the first time, then the last few (the stream has brought the rest).
    const need = Math.floor(now / MIN) * MIN - (sdMinutes + 1) * MIN;
    const since = have && have.minutesFrom <= need ? Math.max(need, now - 3 * MIN) : need;
    const connection = this.#connection;
    this.#absorptionLoading = true;
    this.source.absorption([...ids], mins, from, to, ABSORPTION_PER_INSTRUMENT, since).then(
      answer => {
        // The answer covers its window for the connection it was asked on (one that reached the live edge is kept current by the stream), and
        // the book takes what it claims with its groups.
        const current = connection === this.#connection;
        this.absorption.load(answer, current ? { from, to: to >= now ? Infinity : to, mins: new Map(ids.map((id, i) => [id, mins[i]!])) } : null);
        this.absorptionState = 'ready';
        if (current) this.#absorptionCover = { key, minutesFrom: Math.min(since, have?.minutesFrom ?? Infinity) };
        this.onAbsorptionChanged();
      },
      (error: unknown) => {
        this.absorptionState = (error as { status?: unknown } | null)?.status === 404 ? 'unavailable' : 'failed';
        this.#absorptionRetryAt = Date.now() + 60_000; this.onAbsorptionChanged();
      },
    ).finally(() => { this.#absorptionLoading = false; });
  }

  /**
   * The minutes of the last `sdMinutes` alone, for the automatic threshold the absorption column judges at while the marks are off: asked
   * once, as the marks ask them (the live stream then brings each minute as it settles), and again when the instruments or the span change or
   * the stream reconnected. The question names the last minute with every threshold out of reach, so it reads no group, and any server that
   * answers the marks answers it.
   */
  #ensureAbsorptionMinutes(ids: readonly string[], sdMinutes: number): void {
    const now = Date.now();
    if (this.#absorptionLoading) return;
    if (this.absorptionState !== 'ready' && now < this.#absorptionRetryAt) return;
    const key = `${ids.join(',')}|${sdMinutes}`, have = this.#absorptionCover?.key === key ? this.#absorptionCover : null;
    const since = Math.floor(now / MINUTE) * MINUTE - (sdMinutes + 1) * MINUTE;
    if (have && have.minutesFrom <= since) return;
    const connection = this.#connection;
    this.#absorptionLoading = true;
    this.source.absorption([...ids], ids.map(() => Number.MAX_SAFE_INTEGER), now - MINUTE, now, 1, since).then(
      answer => {
        // No cover: the answer claims no groups.
        this.absorption.load(answer);
        this.absorptionState = 'ready';
        if (connection === this.#connection) this.#absorptionCover = { key, minutesFrom: Math.min(since, have?.minutesFrom ?? Infinity) };
        this.onAbsorptionChanged();
      },
      (error: unknown) => {
        this.absorptionState = (error as { status?: unknown } | null)?.status === 404 ? 'unavailable' : 'failed';
        this.#absorptionRetryAt = Date.now() + 60_000; this.onAbsorptionChanged();
      },
    ).finally(() => { this.#absorptionLoading = false; });
  }

  /**
   * Make sure every window has its value area, on rows of `step` holding `share`. Safe to call every frame: one request at a time, at most a
   * day of minutes in it (a day costs the recorder about 90 ms; a longer window goes alone), a window the source answered for at least
   * `VALUE_AREA_SETTLE_MS` after it ended (by its own clock, `asOf`, or else when the question was sent) kept for good, and any other asked
   * again after a minute (five when an answer took longer than 300 ms). A source that cannot answer (an older server) is asked again a
   * minute later. A window a recovery filled trades into is asked again (`#dropValueAreas`).
   */
  ensureValueAreas(ids: readonly string[], windows: readonly { from: number; to: number }[], step: number, share: number): void {
    if (this.#vaLoading || !ids.length || !windows.length || !(step > 0)) return;
    const now = Date.now();
    if (this.valueAreasState === 'unavailable' && now < this.#vaRetryAt) return;
    const again = this.#vaLastMs > 300 ? 300_000 : 60_000;
    const due = windows.filter(w => { const held = this.valueAreas.get(valueAreaKey(ids, step, share, w)); return !held || (!held.final && now - held.at >= again); });
    if (!due.length) return;
    const batch: { from: number; to: number }[] = []; let span = 0;
    for (const w of [...due].sort((a, b) => b.to - a.to)) {
      const length = Math.min(w.to, now) - w.from;
      if (batch.length && (span + length > 86_400_000 || batch.length >= MAX_VALUE_AREA_WINDOWS)) break;
      batch.push(w); span += length;
    }
    this.#vaLoading = true;
    const started = performance.now();
    const asked = Date.now();
    this.source.valueAreas([...ids], batch, step, share).then(answer => {
      this.#vaLastMs = performance.now() - started; this.valueAreasState = 'ready';
      const at = Date.now(), clock = answer.asOf ?? asked;
      answer.windows.forEach((w, i) => this.valueAreas.set(valueAreaKey(ids, step, share, batch[i]!), { ...w, at, asOf: clock, final: clock >= w.to + VALUE_AREA_SETTLE_MS }));
      // A bound on what is held: the oldest answers go first.
      if (this.valueAreas.size > 600) for (const key of [...this.valueAreas.keys()].slice(0, this.valueAreas.size - 500)) this.valueAreas.delete(key);
      this.onTraded();
    }, () => { this.valueAreasState = 'unavailable'; this.#vaRetryAt = Date.now() + 60_000; this.onTraded(); }).finally(() => { this.#vaLoading = false; });
  }

  /** Forget the value areas of windows of `id` that [from, to) reaches into: trades were filled in there after they were answered. */
  #dropValueAreas(id: string, from: number, to: number): void {
    for (const [key, w] of this.valueAreas) if (w.from < to && w.to > from && key.slice(0, key.indexOf('|')).split(',').includes(id)) this.valueAreas.delete(key);
    for (const [key, w] of this.windowProfiles) if (w.answer.from < to && w.answer.to > from && key.slice(0, key.indexOf('|')).split(',').includes(id)) this.windowProfiles.delete(key);
  }

  /**
   * Make sure the traded volume by price of these past days, weeks or sessions is held (`windowProfiles`), for their profiles on the chart:
   * one window asked at a time, the newest first; one that ended an hour or more before its answer (`VALUE_AREA_SETTLE_MS`, as long as late
   * trades are rechecked) is kept for good, any other asked again after a minute. Each is asked whole (they began inside what the recording
   * keeps) on rows of `step`, the level rows, so zooming asks nothing again.
   */
  ensureWindowProfiles(ids: readonly string[], windows: readonly { from: number; to: number }[], step: number): void {
    if (this.#wpLoading || !ids.length || !windows.length || !(step > 0)) return;
    const now = Date.now();
    if (now < this.#wpRetryAt) return;
    const w = [...windows].sort((a, b) => b.to - a.to).find(x => { const held = this.windowProfiles.get(windowProfileKey(ids, step, x)); return !held || (!held.final && now - held.at >= 60_000); });
    if (!w) return;
    this.#wpLoading = true;
    const { from, to } = askedSpan(w.from, w.to), key = windowProfileKey(ids, step, w);
    this.source.profile([...ids], from, to, step).then(answer => {
      this.windowProfiles.set(key, { answer, at: Date.now(), final: Date.now() >= w.to + VALUE_AREA_SETTLE_MS });
      // A bound on what is held (20 windows of each session at most are drawn): the oldest answers go first.
      if (this.windowProfiles.size > 200) for (const k of [...this.windowProfiles.keys()].slice(0, this.windowProfiles.size - 150)) this.windowProfiles.delete(k);
      this.onTraded();
    }, () => { this.#wpRetryAt = Date.now() + 60_000; }).finally(() => { this.#wpLoading = false; });
  }

  /**
   * Make sure the traded-volume column has an answer for these instruments, this window (whole minutes) and this row step. Safe to call
   * every frame: one request at a time, a new one when the question changes, and every five seconds while the window is open (`live`: the
   * map follows the live edge, or the day, week or session it adds up is under way; the open minute keeps trading), no oftener than twenty
   * times the last answer took and at most five minutes apart. A window that was open when it was last asked and is over now (`settled`: a
   * session that has ended) is asked once more, so the answer that stays holds all of it. A source that cannot answer (an older server) is
   * asked again a minute later. `tag` names the window for the answer held (`traded`).
   */
  ensureTraded(ids: readonly string[], from: number, to: number, step: number, live: boolean, period: { tag: string; settled: boolean } = { tag: '', settled: false }): void {
    // A window longer than a source may be asked about (a chart zoomed out past eight days, a month) is asked for its newest part: refused
    // whole, it left the column on its last answer, asked again a minute later and refused again. The header says from when it holds.
    ({ from, to } = askedSpan(from, to));
    // No instruments left: nothing has traded on the map, and an answer still on its way for the last ones must not draw them back.
    if (!ids.length) { if (this.traded || this.#tradedAsked) { this.traded = null; this.#tradedAsked = ''; this.#tradedGen++; this.onTraded(); } return; }
    if (this.#tradedLoading || !(to > from) || !(step > 0)) return;
    const now = Date.now();
    if (this.tradedState === 'unavailable' && now < this.#tradedRetryAt) return;
    // The window's tag is part of the question: a day and the session that covers the same hours have the same bounds and another answer's name.
    const base = `${ids.join(',')}|${step}|${period.tag}`, key = `${base}|${from}|${to}`, spacing = Math.min(300_000, Math.max(5_000, 20 * this.#tradedMs));
    const slid = live && slidOnly(this.#tradedWindow, base, from, to, spacing);
    if ((key === this.#tradedAsked || slid) && !(live && now - this.#tradedAt >= spacing) && !(period.settled && !this.#tradedSettled)) return;
    this.#tradedLoading = true; this.#tradedAsked = key; this.#tradedAt = now; this.#tradedSettled = period.settled; this.#tradedWindow = { base, from, to };
    const generation = ++this.#tradedGen, started = performance.now();
    measureDef('volume').byPrice.ask(this.source, [...ids], from, to, step, new Map()).then(({ answer }) => answer).then(
      answer => { if (generation !== this.#tradedGen) return; this.#tradedMs = performance.now() - started; this.traded = { step, answer, tag: period.tag }; this.tradedState = 'ready'; this.onTraded(); },
      () => { if (generation !== this.#tradedGen) return; this.tradedState = 'unavailable'; this.#tradedRetryAt = Date.now() + 60_000; this.#tradedAsked = ''; this.onTraded(); },
    ).finally(() => { this.#tradedLoading = false; });
  }

  /**
   * Make sure the column has an answer for a measure other than traded volume over this window, as `ensureTraded` does for volume, asked as
   * its registration says (measures/defs/): on the instruments it counts among `ids` (the perpetuals with open interest, those with an
   * absorption threshold, `thresholds`), named in the question as it names them (absorption with its threshold). Asked again as
   * `ensureTraded` asks (`live`, `settled`, the same spacing), and `tag` names the window for the answer held.
   */
  ensureMetricProfile(metric: Exclude<ProfileMetric, 'volume'>, ids: readonly string[], from: number, to: number, step: number, live: boolean, period: { tag: string; settled: boolean } = { tag: '', settled: false }, thresholds: Thresholds = new Map()): void {
    const c = this.#metricColumn(metric), def = measureDef(metric).byPrice;
    ({ from, to } = askedSpan(from, to));   // as `ensureTraded`
    if (c.loading || !(to > from) || !(step > 0)) return;
    const now = Date.now();
    if (c.state === 'unavailable' && now < c.retryAt) return;
    const judged = def.instruments(ids, thresholds);
    const base = `${judged.map(id => def.keyOf(id, thresholds)).join(',')}|${step}|${period.tag}`, key = `${base}|${from}|${to}`;
    const spacing = Math.min(300_000, Math.max(5_000, 20 * c.ms)), slid = live && slidOnly(c.window, base, from, to, spacing);
    if ((key === c.asked || slid) && !(live && now - c.at >= spacing) && !(period.settled && !c.settled)) return;
    c.loading = true; c.asked = key; c.at = now; c.settled = period.settled; c.window = { base, from, to };
    const generation = ++c.gen, started = performance.now();
    const work: Promise<{ answer: ProfileAnswer; flags: MetricFlags }> = def.ask(this.source, judged, from, to, step, thresholds);
    work.then(
      ({ answer, flags }) => { if (generation !== c.gen) return; c.ms = performance.now() - started; c.held = { step, answer, flags, tag: period.tag }; c.state = 'ready'; this.onTraded(); },
      () => { if (generation !== c.gen) return; c.state = 'unavailable'; c.retryAt = Date.now() + 60_000; c.asked = ''; this.onTraded(); },
    ).finally(() => { c.loading = false; });
  }

  /**
   * Make sure the flow book holds history reaching back to `from` for these instruments (a server answers a bounded number per request, so
   * a long list is asked in parts). Safe to call every frame: it is a no-op once everything asked for is here, or while a request runs.
   */
  async ensureFlow(ids: readonly string[], from: number): Promise<void> {
    if (this.#flowLoading) return;
    const need = this.flow.missing(ids, from);
    if (!need.length) return;
    this.#flowLoading = true; this.flow.begin(need);
    try {
      const to = Date.now() + MINUTE;
      for (let i = 0; i < need.length; i += 40) {
        const part = need.slice(i, i + 40);
        try { this.flow.load(await this.source.flow(part, from, to), part, from); } catch { this.flow.fail(part); }
      }
      this.onFlowChanged();
    } finally { this.#flowLoading = false; }
  }

  /**
   * Make sure the flow book holds minutes over [from, to] for these instruments, for a window older than the seconds it holds. Safe to call
   * every frame: one request at a time, none while everything asked for is here, and a source that cannot answer is asked again a minute later.
   */
  async ensureFlowMinutes(ids: readonly string[], from: number, to: number): Promise<void> {
    const source = this.source;
    if (!source.flowMinutes) { this.flowMinutesState = 'unavailable'; return; }
    if (this.#flowMinutesLoading || Date.now() < this.#flowMinutesRetryAt) return;
    const need = this.flow.minutesMissing(ids, from, to);
    if (!need.length) return;
    this.#flowMinutesLoading = true;
    try {
      for (let i = 0; i < need.length; i += 40) { const part = need.slice(i, i + 40); this.flow.loadMinutes(await source.flowMinutes(part, from, to), part, from, to); }
      this.flowMinutesState = 'ready';
    } catch { this.flowMinutesState = 'unavailable'; this.#flowMinutesRetryAt = Date.now() + 60_000; }
    finally { this.#flowMinutesLoading = false; this.onFlowChanged(); }
  }

  /**
   * Make sure recorded columns cover `view` (with margin) at a resolution suited to `widthPx`, each instrument on its own account
   * (`ColumnHolds.plan`): one not held for the view is asked for whole and no other is, so a book that comes back after a flap asks for
   * itself and a step held before asks for nothing. While the columns held still cover the view, a refresh (`invalidateColumns`) asks
   * only for the windows that could have changed since they were asked for (from `settled`), and none at all when the view is wholly in
   * the past: a recorded minute does not change, and asking for the whole window again every 30 s cost a server seconds for a view over
   * days (Research_Findings.md).
   */
  async loadColumns(view: Bounds, widthPx: number): Promise<void> {
    const ids = this.store.state.levels?.books.map(book => book.id) ?? [];
    if (!ids.length) return;
    // About two pixels a column, in minutes that double from one level to the next: zooming moves between a few steps the server has merged
    // before; at least the long history's two minutes where the view reaches before the page's own day (`columnStepFor`).
    const stepMs = columnStepFor(view, widthPx, this.source.archiveFirst?.() ?? null, this.source.depthSince?.(ids) ?? this.recordedSince, this.sourceNow());
    const holds = this.#columns;
    // The view is one object the pane moves on: what an answer is judged against below is the view it was asked for.
    const seen: Bounds = { t0: view.t0, t1: view.t1, p0: view.p0, p1: view.p1 };
    this.#columnsWanted = stepMs;
    holds.touch(stepMs);
    this.#archiveView(stepMs);
    // A step held for every book is read at once, whatever else is under way.
    if (holds.covers(ids, seen, stepMs)) this.#readColumns(stepMs);
    if (this.#columnsLoading) return;
    const clock = Date.now();
    // What is asked from here on answers every refresh mark made so far; one made while it is under way is answered by the next.
    const stale = this.#columnsStale;
    this.#columnsStale = false;
    this.#forgetColumns(holds.sweep(clock, stepMs, this.#columnsDrawn, new Set(ids)));
    // The source's clock: a page whose clock runs ahead would otherwise count the source's open minutes as settled and never ask for them again.
    const now = clock - this.#sourceSkew, settled = settledBefore(now, stepMs);
    const asks = holds.plan(ids, seen, stepMs, now, clock, stale);
    if (!asks.length) return;
    const reach = columnReach(seen, stepMs);
    this.#columnsLoading = true;
    try {
      for (const ask of asks) {
        // A zoom to another step since the load began: that step's own load follows, and the rest of this one would only hold it up.
        if (stepMs !== this.#columnsWanted) break;
        const frame = await this.source.columns(ask.ids, ask.from, ask.to, stepMs);
        let whole = frame.instruments, wholeIds = ask.ids;
        if (ask.tail) {
          // A market whose price grid is not the one its columns held were recorded on (a server started again and chose another): their bins
          // mean other prices, so its whole window is asked for again.
          const other = new Set(holds.gridChanged(stepMs, frame.instruments));
          const tails = frame.instruments.filter(set => !other.has(set.id));
          whole = []; wholeIds = [...other];
          holds.recordTail(stepMs, answered(tails, ask.ids.filter(id => !other.has(id))), settled, clock);
          if (tails.length) this.#postColumns({ type: 'columnsTail', stepMs, from: ask.from, instruments: tails }, stepMs);
          // What the other steps hold for these markets was recorded on the old grid too.
          if (other.size) this.#forgetColumns(holds.forgetElsewhere(stepMs, wholeIds));
          if (other.size) whole = (await this.source.columns(wholeIds, reach.from, Math.min(Date.now() - this.#sourceSkew + MINUTE, reach.to), stepMs)).instruments;
        }
        // Every instrument asked for is held from here on, answered or not: one a source leaves out is not asked for again on every frame
        // (and has nothing in the worker: what it held for it is forgotten).
        if (wholeIds.length) {
          const got = new Set(whole.map(set => set.id)), had = holds.at(stepMs), left = wholeIds.filter(id => !got.has(id) && had.has(id));
          holds.recordWhole(stepMs, answered(whole, wholeIds), reach, settled, clock);
          if (left.length) this.#forgetColumns([{ stepMs, ids: left }]);
        }
        if (whole.length) this.#postColumns({ type: 'columns', stepMs, instruments: whole }, stepMs);
        this.#forgetColumns(holds.evict(stepMs, this.#columnsDrawn, this.#columnsWanted));
        // Once every book is held at the step the view wants, that is the step to read (a step wanted since is read by its own load).
        if (stepMs === this.#columnsWanted && holds.covers(ids, seen, stepMs)) this.#readColumns(stepMs);
      }
      // A load for a step nobody wants any more reads nothing and changes nothing the page would draw: say so, so that the frame that waits for this load to end comes.
      if (stepMs !== this.#columnsWanted) this.onColumns();
    } finally {
      this.#columnsLoading = false;
      // What is held now at the step the view wants, for the long history's files: answered, or cut short by a question that failed.
      this.#archiveView(this.#columnsWanted);
    }
  }

  /**
   * The long history brought [from, to) at `stepMs`: those windows are asked for again for the books held at that step, each inside the
   * window its columns were asked for (a range the view has left is not taken in), on the grid they are held on, and spliced into what the
   * worker holds (what it holds elsewhere is kept, so a view larger than the tiles' cache never empties and asks for itself again). A book
   * whose answer comes on another grid (its engine's changed) is asked for whole again instead. Holds change while an answer is awaited (a
   * pan asks for a new window): a book is asked and spliced only while its hold still contains the range (a new window's whole answer already
   * drew on the files that came).
   */
  async #archiveArrived(stepMs: number, from: number, to: number): Promise<void> {
    const source = this.source;
    if (!source.archiveRange) return;
    const groups = new Map<string, { from: number; to: number; ids: string[] }>();
    for (const [id, hold] of this.#columns.at(stepMs)) {
      const lo = Math.max(from, hold.from), hi = Math.min(to, hold.to);
      if (!(hi > lo)) continue;
      const key = `${lo}|${hi}`, group = groups.get(key);
      if (group) group.ids.push(id); else groups.set(key, { from: lo, to: hi, ids: [id] });
    }
    for (const group of groups.values()) {
      const holding = (id: string): boolean => { const hold = this.#columns.at(stepMs).get(id); return !!hold && hold.from <= group.from && hold.to >= group.to; };
      const ids = group.ids.filter(holding);
      if (!ids.length) continue;
      const grids: Record<string, number> = {};
      for (const id of ids) grids[id] = this.#columns.at(stepMs).get(id)?.grid ?? 0;
      const frame = await source.archiveRange(ids, group.from, group.to, stepMs, grids);
      const sets = frame.instruments.filter(set => holding(set.id));
      const other = new Set(this.#columns.gridChanged(stepMs, sets));
      if (other.size) {
        this.#forgetColumns(this.#columns.forgetElsewhere(stepMs, [...other]));
        this.#columns.expire(stepMs, [...other]); this.#columnsStale = true; this.onColumns();
      }
      const same = sets.filter(set => !other.has(set.id));
      if (!same.length) continue;
      const buffers = new Set<ArrayBuffer>();
      for (const set of same) for (const array of [set.bins, set.bid, set.ask]) if (array.buffer instanceof ArrayBuffer) buffers.add(array.buffer);
      this.#post({ type: 'columnsRange', stepMs, from: group.from, to: group.to, instruments: same }, [...buffers]);
      if (stepMs === this.#columnsDrawn) this.#columnsChanged();
    }
  }

  /** The steps the page holds recorded columns for, and the books at each (what it has told the worker to keep). */
  heldColumns(): { stepMs: number; ids: string[] }[] { return this.#columns.steps().map(stepMs => ({ stepMs, ids: [...this.#columns.at(stepMs).keys()] })); }

  /** Tells the long history the step the map reads and the windows held there (`DataSource.archiveView`). */
  #archiveView(stepMs: number): void {
    if (!this.source.archiveView) return;
    const windows = new Map<string, { from: number; to: number }>();
    for (const hold of this.#columns.at(stepMs).values()) windows.set(`${hold.from}|${hold.to}`, { from: hold.from, to: hold.to });
    this.source.archiveView(stepMs, [...windows.values()]);
  }

  /** Hand columns to the worker. The instruments are views onto a few fetch buffers that nothing on this thread reads again: hand the buffers over instead of copying tens of MB. */
  #postColumns(message: Extract<WorkerIn, { type: 'columns' | 'columnsTail' }>, stepMs: number): void {
    const buffers = new Set<ArrayBuffer>();
    for (const set of message.instruments) for (const array of [set.bins, set.bid, set.ask]) if (array.buffer instanceof ArrayBuffer) buffers.add(array.buffer);
    this.#post(message, [...buffers]);
    // What the worker reads has changed only if it is at this step; a step it is not reading waits for `#readColumns`.
    if (stepMs === this.#columnsDrawn) this.#columnsChanged();
  }

  /** The worker reads the columns held at this step from now on. */
  #readColumns(stepMs: number): void {
    if (stepMs === this.#columnsDrawn) return;
    this.#post({ type: 'columnsUse', stepMs });
    this.#columnsDrawn = stepMs;
    this.#columnsChanged();
  }

  /** Panes keyed on `columnsVersion` ask the worker again. */
  #columnsChanged(): void {
    this.columnStepMs = this.#columnsDrawn; this.columnsVersion++;
    this.onColumns();
  }

  #forgetColumns(drops: readonly ColumnDrop[]): void {
    for (const drop of drops) this.#post({ type: 'columnsDrop', stepMs: drop.stepMs, ids: drop.ids });
    // A hold let go is no longer the long history's to keep files for, whichever path let it go and whether or not a load follows.
    if (drops.length) this.#archiveView(this.#columnsWanted);
  }

  /** The source's clock (the page's, less the difference seen at boot): what the source counts as settled is by its own time. */
  sourceNow(): number { return Date.now() - this.#sourceSkew; }

  /** Executions per candle for a window (the footprint). */
  /** `cuts`: size lines (the coin's USD) whose orders each bar carries in `over`, where the source knows them. */
  footprint(inst: string, tf: string, from: number, to: number, rowStep: number, cuts: readonly number[] = [], budget?: number, venues = false): Promise<FootprintResponse> { return this.source.footprint(inst, tf, from, to, rowStep, cuts, budget, venues); }

  /** Depth within each of the nested bands `radii` (ascending fractions) of the books' own price, per pixel column over [t0, t1], in USD and in coins (`DepthAnswer`). */
  depth(enabled: string[], t0: number, t1: number, w: number, radii: readonly number[]): Promise<DepthAnswer> {
    const id = ++this.#rasterId + 1_000_000;
    return new Promise(resolve => { this.#depthWaiters.set(id, resolve); this.#post({ type: 'depth', id, enabled, t0, t1, w, radii: [...radii] }); });
  }

  /** What each enabled instrument holds in the map cell [t0, t1) x [p0, p1). */
  cell(enabled: string[], t0: number, t1: number, p0: number, p1: number): Promise<CellShare[]> {
    const id = ++this.#rasterId + 3_000_000;
    return new Promise(resolve => { this.#cellWaiters.set(id, resolve); this.#post({ type: 'cell', id, enabled, t0, t1, p0, p1 }); });
  }

  /** Liquidity Tracker series over [t0, t1] for the enabled instruments: from the recorded columns, or (`lane`) from the trackers the lane holds. `stepMs`: that of the windows. */
  lt(enabled: string[], t0: number, t1: number, params: LtParams, lane = false): Promise<LtSeries & { stepMs?: number }> {
    const id = ++this.#rasterId + 2_000_000;
    return new Promise(resolve => { this.#ltWaiters.set(id, resolve); this.#post({ type: 'lt', id, enabled, t0, t1, params, lane }); });
  }

  /** New minutes may have been recorded: the next `loadColumns` asks again for the windows that could have changed. */
  invalidateColumns(): void { this.#columnsStale = true; }

  /** Ask the worker for a grid covering `bounds`. Returns false when too many requests are already running. */
  raster(enabled: string[], bounds: Bounds, w: number, h: number, smooth: boolean): boolean {
    if (this.#inflight.size >= 1) return false;
    const id = ++this.#rasterId;
    this.#inflight.set(id, { ...bounds });
    this.#post({ type: 'raster', id, enabled, ...bounds, w, h, smooth });
    return true;
  }
}

/** The live minutes folded into one display candle that spans several: what the candle held before the first of them, and each minute's latest volume. */
export interface LiveTrack { bucket: number; base: number; minutes: Map<number, number> }

/**
 * The read's candles followed by those the stream opened after its newest, as shown (their open and range are the stream's, and so is
 * the live track on the newest), the read's newest widened by what was shown of it: its range and volume only grow, its close is the
 * read's. Null when the stream opened none after the read.
 */
function withNewer(loaded: CandleRow[], shown: readonly CandleRow[]): CandleRow[] | null {
  const last = loaded[loaded.length - 1]; if (!last) return null;
  const newer = shown.filter(c => c[0] > last[0]); if (!newer.length) return null;
  const at = shown.find(c => c[0] === last[0]);
  const head: CandleRow[] = at ? [...loaded.slice(0, -1), [last[0], last[1], Math.max(last[2], at[2]), Math.min(last[3], at[3]), last[4], Math.max(last[5], at[5]), last[6]]] : loaded;
  return [...head, ...newer];
}

/**
 * A kept series brought up to date by its read (`loadSeries`), against what was shown of it (the kept candles and what the stream added).
 * Candles the stream opened after the read's newest are kept as shown, with their track (their open and range are the stream's). A read
 * no further on than what was shown (taken before the stream's latest) leaves the open candle's volume and track as they were, its range
 * widened (a one-minute series has no track: its volume is the larger). A read further on holds the minutes the kept candles missed: it is
 * taken as a first read is (the track starts again, from the next tick's minute), its range widened by what was shown. (`keepGrowth` would
 * put those minutes on the minute under way, and the stream could not raise it again until it had passed them.) As for any first read,
 * what traded in the minute under way between the read and that tick is not told apart.
 */
export function rebaseLive(loaded: CandleRow[], shown: readonly CandleRow[], track: { current: LiveTrack | null }): CandleRow[] {
  const last = loaded[loaded.length - 1];
  if (!last) { track.current = null; return loaded; }
  const followed = withNewer(loaded, shown);
  if (followed) return followed;
  const was = shown[shown.length - 1];
  if (!was || was[0] !== last[0]) { track.current = null; return loaded; }
  const high = Math.max(last[2], was[2]), low = Math.min(last[3], was[3]);
  if (was[5] >= last[5]) return [...loaded.slice(0, -1), [last[0], last[1], high, low, last[4], was[5], last[6]]];
  track.current = null;
  return [...loaded.slice(0, -1), [last[0], last[1], high, low, last[4], last[5], last[6]]];
}

/**
 * The open candle of a series that is loaded again, with what the page already had of it. Its volume and its range only grow, so a
 * snapshot that is a few seconds behind the live stream cannot lower them; its close is the snapshot's (which of the two is later cannot
 * be told, and the next tick settles it). The live track goes on from the volume that comes back, not from the snapshot's.
 *
 * A snapshot that is ahead of the stream has, beyond what the track counted, mostly what the minute that is open did since its last tick.
 * That goes on that minute and not on the base: the next tick brings the minute's whole volume (not an increment) and the larger of the
 * two stands, so the stream catches up with the snapshot without adding to it. On the base it would be counted twice, at every reload.
 */
export function keepGrowth(loaded: CandleRow[], shown: readonly CandleRow[], track: LiveTrack | null, tfMs: number, now: number): CandleRow[] {
  const last = loaded[loaded.length - 1], was = shown[shown.length - 1];
  if (!last || !was) return loaded;
  if (was[0] > last[0]) return withNewer(loaded, shown) ?? loaded;
  if (was[0] !== last[0]) return loaded;
  const volume = Math.max(last[5], was[5]), high = Math.max(last[2], was[2]), low = Math.min(last[3], was[3]);
  if (track && track.bucket === last[0]) {
    let counted = 0; for (const minute of track.minutes.values()) counted += minute;
    counted += track.base;
    if (volume > counted) {
      const open = Math.min(Math.max(Math.floor(now / MINUTE) * MINUTE, track.bucket), track.bucket + Math.max(MINUTE, tfMs) - MINUTE);
      track.minutes.set(open, (track.minutes.get(open) ?? 0) + volume - counted);
    }
  }
  if (volume === last[5] && high === last[2] && low === last[3]) return loaded;
  return [...loaded.slice(0, -1), [last[0], last[1], high, low, last[4], volume, last[6]]];
}

/**
 * Fold a live 1m candle into the display-timeframe series. A display candle of several minutes gets the volume of all of them, not of the
 * biggest: with `track` (kept by the caller, and emptied when the series is for another market or timeframe) each live minute's latest volume
 * is remembered and added to what the candle held when the first of them was seen, less the part of that minute it already had.
 * A minute's volume does not go back down (a feed that reconnects in the middle of it starts counting again from what it sees).
 */
export function mergeLive(candles: CandleRow[], live: [number, number, number, number, number, number], tfMs: number, track?: { current: LiveTrack | null }): CandleRow[] {
  const [start, open, high, low, close, volume] = live;
  const bucket = Math.floor(start / tfMs) * tfMs;
  const last = candles[candles.length - 1];
  if (last && bucket < last[0]) return candles;
  const same = last !== undefined && last[0] === bucket;
  let total: number;
  if (tfMs <= MINUTE || !track) total = same ? Math.max(last![5], volume) : volume;
  else {
    let seen = track.current;
    if (!seen || seen.bucket !== bucket) { seen = { bucket, base: same ? Math.max(0, last![5] - volume) : 0, minutes: new Map() }; track.current = seen; }
    seen.minutes.set(start, Math.max(seen.minutes.get(start) ?? 0, volume));
    total = seen.base; for (const minute of seen.minutes.values()) total += minute;
  }
  if (same) return [...candles.slice(0, -1), [bucket, last![1], Math.max(last![2], high), Math.min(last![3], low), close, total, last![6]]];
  return [...candles, [bucket, open, high, low, close, total, 1]];
}
