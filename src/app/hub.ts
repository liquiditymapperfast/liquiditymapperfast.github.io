import { connectionStatus } from './net.ts';
import type { DataSource, FootprintResponse, TickMessage } from './source.ts';
import { PrintBook, fromWire, type Print } from './prints.ts';
import { FlowBook } from './flow-book.ts';
import type { Store, CandleRow } from './store.ts';
import type { WorkerIn, WorkerOut, RasterStats } from './worker/raster.worker.ts';
import type { CellShare } from './cell-sources.ts';
import type { Bounds } from './view.ts';
import type { LtParams, LtSeries } from './lt.ts';
import { pickOi, weakOi, type OiCandidate } from './oi-source.ts';
import { t } from './i18n.ts';
import { MAX_VALUE_AREA_WINDOWS, type ProfileAnswer, type ValueAreaWindow } from '../shared/footprint.ts';
import { AbsorptionBook } from './absorption.ts';
import { MAX_ABSORPTION_INSTRUMENTS } from '../shared/absorption.ts';
import { PRINTS_PER_ANSWER } from '../shared/prints.ts';

export const TIMEFRAMES: Readonly<Record<string, number>> = { '1m': 60_000, '5m': 300_000, '15m': 900_000, '30m': 1_800_000, '1h': 3_600_000, '4h': 14_400_000, '1d': 86_400_000 };
const MINUTE = 60_000;

export interface RasterResult { id: number; w: number; h: number; data: Float32Array; stats: RasterStats; bounds: Bounds }

/** Owns data loading: bootstrap, live socket, candles, OI, recorded columns and the raster worker. */
/** A value area's key: the instruments, the row step and share it was read with, and its window. */
export const valueAreaKey = (ids: readonly string[], step: number, share: number, w: { from: number; to: number }): string => `${ids.join(',')}|${step}|${share}|${w.from}-${w.to}`;

export class Hub {
  readonly worker: Worker;
  #ready: Promise<void>;
  #rasterId = 0;
  #inflight = new Map<number, Bounds>();
  #columns: { key: string; from: number; to: number; stepMs: number } | null = null;
  #columnsLoading = false;
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
  /** Large trades for the bubbles: history for the window on screen plus everything the live stream has delivered. */
  readonly prints = new PrintBook();
  /** Called with each batch of new large trades from the live stream (for sounds). */
  onPrints: (fresh: Print[]) => void = () => {};
  /** Called when the print book changed, so the chart can redraw its bubbles. */
  onPrintsChanged: () => void = () => {};
  /** Taker flow per second for every instrument that has traded: the CVD column reads it, and sounds read what it just got. */
  readonly flow = new FlowBook();
  /** Called when the flow book changed (new seconds or history), about once a second. */
  onFlowChanged: () => void = () => {};
  #flowLoading = false;
  /** The window the print book was last filled for, and the smallest order it was asked from. */
  /** The window of history the print book was last answered for, from which smallest size, and whether the answer was cut to its largest. */
  #printsWindow: { t0: number; t1: number; min: number; cut: boolean; live: boolean } | null = null;
  /** The live stream has closed at least once since it last opened, so the next open is a reconnection. */
  #dropped = false;
  /** Counts the times the live stream opened or closed: a history answer can tell whether it was asked for before the stream broke. */
  #connection = 0;
  #printsLoading = false;
  onRaster: (result: RasterResult) => void = () => {};
  #depthWaiters = new Map<number, (r: { bid: Float32Array; ask: Float32Array }) => void>();
  #ltWaiters = new Map<number, (r: LtSeries) => void>();
  #cellWaiters = new Map<number, (items: CellShare[]) => void>();
  /** Bumped whenever new recorded columns reach the worker, so derived series know to recompute. */
  columnsVersion = 0;
  /** Step of the recorded columns the worker currently holds. */
  columnStepMs = MINUTE;
  onColumns: () => void = () => {};
  busyMs = 0;
  /** Absorption candidates and window statistics: the window on screen and what the live stream added since. */
  readonly absorption = new AbsorptionBook();
  /** Instruments whose groups the last history answer cut at its limit (the smallest left out). */
  absorptionCapped: string[] = [];
  absorptionState: 'ready' | 'unavailable' = 'ready';
  /** Called when absorption groups or minutes arrived (history or live). */
  onAbsorptionChanged: () => void = () => {};
  #absorptionLoading = false; #absorptionRetryAt = 0;
  /**
   * What the last absorption answer covers, for the connection it was asked on: the instruments and threshold span (`key`), the window, the
   * amount each instrument was asked from, and the time from which its minutes are held (the live stream keeps both current after that).
   */
  #absorptionCover: { key: string; from: number; to: number; mins: number[]; minutesFrom: number } | null = null;
  /** The traded-volume column's last answer, the row step it was asked on, and whether the source can answer at all. */
  traded: { step: number; answer: ProfileAnswer } | null = null;
  /**
   * Value areas of days, weeks and sessions by window (`valueAreaKey`), with when each was answered: a window that had ended by then never
   * changes, so it is asked once; the one under way is asked again after a while (`ensureValueAreas`).
   */
  readonly valueAreas = new Map<string, ValueAreaWindow & { at: number }>();
  valueAreasState: 'ready' | 'unavailable' = 'ready';
  #vaLoading = false; #vaRetryAt = 0; #vaLastMs = 0;
  tradedState: 'ready' | 'unavailable' = 'ready';
  /** Called when the traded-volume column has a new answer (or the source said it has none). */
  onTraded: () => void = () => {};
  #tradedLoading = false; #tradedAsked = ''; #tradedAt = 0; #tradedRetryAt = 0;
  /** Counts the traded-volume questions, so an answer can tell whether it is still the one wanted. */
  #tradedGen = 0;
  /** Oldest recorded depth minute across instruments (ms), or 0 when nothing is recorded. */
  recordedSince = 0;
  /** Instrument with candle history to fall back to when the selected market has none. */
  #reference = '';
  /** Instruments with an open-interest series to fall back to, best first. */
  #oiReferences: string[] = [];

  constructor(readonly store: Store, readonly source: DataSource) {
    this.worker = new Worker(new URL('./worker/raster.worker.ts', import.meta.url), { type: 'module' });
    this.#ready = new Promise(resolve => {
      this.worker.onmessage = (event: MessageEvent<WorkerOut>) => {
        const message = event.data;
        if (message.type === 'ready') resolve();
        else if (message.type === 'error') console.error('raster worker:', message.message);
        else if (message.type === 'lt') { this.#ltWaiters.get(message.id)?.({ times: message.times, bid: message.bid, ask: message.ask }); this.#ltWaiters.delete(message.id); }
        else if (message.type === 'cell') { this.#cellWaiters.get(message.id)?.(message.items); this.#cellWaiters.delete(message.id); }
        else if (message.type === 'depth') { this.#depthWaiters.get(message.id)?.({ bid: message.bid, ask: message.ask }); this.#depthWaiters.delete(message.id); }
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

  async start(): Promise<void> {
    const boot = await this.source.bootstrap();
    const marketId = this.store.state.marketId || boot.markInstrumentId || boot.markets[0]?.instrumentId || '';
    this.#noteRecorded(boot.recorded);
    this.#reference = boot.markInstrumentId; this.#oiReferences = boot.oiReferences ?? [];
    this.store.set({ markets: boot.markets, marketId, mark: { price: boot.markPrice, asOf: boot.asOf }, layers: boot.layers ?? {} });
    await this.#ready;
    // A source that says when venues change (the browser) keeps the market list current without being asked.
    let pending: ReturnType<typeof setTimeout> | undefined;
    this.source.venues.watch?.(() => { clearTimeout(pending); pending = setTimeout(() => void this.refreshMarkets(), 300); });
    this.source.connect({
      onOpen: () => {
        this.#connection++; this.#printsWindow = null; this.#absorptionCover = null;
        // What the stream said while it was down is in the recordings and not in the book: ask for the history again (the first open has nothing to repair).
        if (this.#dropped) { this.#dropped = false; this.flow.invalidate(); }
        this.store.set({ connected: true, status: t('live') });
      },
      onClose: (failures, host) => { this.#connection++; this.#dropped = true; this.store.set({ connected: false, status: connectionStatus(failures, host) }); },
      onLevels: frame => {
        this.store.set({ levels: frame });
        this.#post({ type: 'live', books: frame.books, now: Date.now() });
      },
      onTick: tick => this.#tick(tick),
      onLayers: message => this.store.set({ layers: message.layers }),
      onFlow: items => { this.flow.apply(items); this.onFlowChanged(); },
      onAbsorption: (groups, minutes) => { this.absorption.add(groups); this.absorption.addMinutes(minutes); this.onAbsorptionChanged(); },
      onPrints: items => {
        const fresh = this.prints.add(items.flatMap(row => { const p = fromWire(row); return p ? [p] : []; }));
        if (fresh.length) { this.onPrints(fresh); this.onPrintsChanged(); }
      },
    });
  }

  #noteRecorded(recorded: Record<string, { first: number }> | undefined): void {
    const firsts = Object.values(recorded ?? {}).map(r => r.first);
    this.recordedSince = firsts.length ? Math.min(...firsts) : 0;
  }

  /** Re-read the market list after venues were switched on or off, and leave a market that is gone for the reference one. */
  async refreshMarkets(): Promise<void> {
    const boot = await this.source.bootstrap().catch(() => null);
    if (!boot) return;
    const key = (list: readonly { instrumentId?: string }[]): string => list.map(m => m.instrumentId).join(',');
    const { markets, marketId } = this.store.state;
    if (key(boot.markets) === key(markets)) return;
    const gone = marketId !== '' && !boot.markets.some(m => m.instrumentId === marketId);
    this.store.set({ markets: boot.markets, ...(gone ? { marketId: boot.markInstrumentId || boot.markets[0]?.instrumentId || '' } : {}) });
  }

  #tick(tick: TickMessage): void {
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
    // A market with no history yet starts its series from the live candle: waiting for history that is not coming leaves the chart empty.
    if (live) patch.candles = mergeLive(state.candles, live, TIMEFRAMES[state.timeframe] ?? 3_600_000, this.#liveTrack);
    this.store.set(patch);
  }

  async loadSeries(force = false): Promise<void> {
    void this.source.bootstrap().then(boot => this.#noteRecorded(boot.recorded), () => {});
    const { marketId, timeframe } = this.store.state;
    const key = `${marketId}|${timeframe}`;
    if (!marketId || (!force && key === this.#series)) return;
    this.#series = key;
    const generation = ++this.#seriesGen;
    // Open interest that is still on its way for the context just left must not land in this one.
    this.#oiGen++; this.#oiKey = '';
    const tf = TIMEFRAMES[timeframe] ?? 3_600_000, now = Date.now();
    let seriesInstrument = marketId;
    let candles: CandleRow[];
    try {
      candles = await this.source.candles(marketId, timeframe, now - 500 * tf, now + tf);
      if (!candles.length && this.#reference && this.#reference !== marketId) { seriesInstrument = this.#reference; candles = await this.source.candles(seriesInstrument, timeframe, now - 500 * tf, now + tf); }
    } catch (error) {
      if (key === this.#series && generation === this.#seriesGen) {
        // A refresh of what is on screen that fails leaves it as it is; candles (and open interest) of another timeframe or market are not left standing under this label.
        if (this.#loaded?.key !== key) { this.store.set({ candles: [], seriesInstrument: marketId, oi: [], oiInstrument: '' }); this.#loaded = null; }
        this.#series = this.#loaded?.key ?? '';
      }
      throw error;
    }
    // Only the newest request may answer: an older one for the same context (a forced reload, a quick change and back) would put the series as it was then over what a newer one has set.
    if (key !== this.#series || generation !== this.#seriesGen) return;
    // A reload of what is on screen keeps what the stream has added to the open candle since the snapshot was taken, and goes on counting its minutes.
    const again = this.#loaded?.key === key && this.#loaded.instrument === seriesInstrument;
    if (!again) this.#liveTrack.current = null;
    candles = keepGrowth(candles, again ? this.store.state.candles : [], this.#liveTrack.current, tf, Date.now());
    // Within a candle the stream and the snapshot cannot be put in order (the last tick may be older or newer than the moment the snapshot was taken), and the next tick settles it:
    // the live candle goes on top only where nothing in the snapshot can be later than it, a candle the snapshot does not have yet.
    const live = this.#liveCandles[seriesInstrument], last = candles[candles.length - 1];
    const opens = live !== undefined && (!last || Math.floor(live[0] / tf) * tf > last[0]);
    this.#loaded = { key, instrument: seriesInstrument };
    // Open interest belongs to the candles it was loaded for: another timeframe's or market's bars are not shown under these while theirs are on their way.
    this.store.set({ candles: opens ? mergeLive(candles, live, tf, this.#liveTrack) : candles, seriesInstrument, ...(again ? {} : { oi: [], oiInstrument: '' }) });
    await this.loadOi();
  }

  /**
   * Load open interest for the series on screen. The market's own series is used while it is healthy; otherwise a reference perp
   * with history stands in and `oiInstrument` says so. Safe to call often: it is one request when the market has OI.
   */
  async loadOi(): Promise<void> {
    const { marketId, seriesInstrument, timeframe } = this.store.state;
    const own = seriesInstrument || marketId; if (!own) return;
    const key = `${own}|${timeframe}`; this.#oiKey = key;
    const generation = ++this.#oiGen;
    const tf = TIMEFRAMES[timeframe] ?? 3_600_000, now = Date.now(), from = now - 500 * tf, to = now + tf;
    const ids = [...new Set([own, this.#reference, ...this.#oiReferences].filter(Boolean))];
    const candidates: OiCandidate[] = [];
    for (const inst of ids) {
      const bars = await this.source.oi(inst, timeframe, from, to).catch(() => []);
      candidates.push({ inst, bars });
      if (!weakOi(bars, now, tf)) break;
    }
    if (this.#oiKey !== key || generation !== this.#oiGen) return;
    const chosen = pickOi(candidates, now, tf);
    if (chosen) this.store.set({ oi: chosen.bars, oiInstrument: chosen.inst });
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
   * Make sure the absorption book holds the window on screen for these instruments, and the minutes of the last `sdMinutes` for the
   * automatic threshold. Each instrument is asked from a quarter under its threshold, so a threshold drifting down a little does not ask
   * again (one with no threshold yet is asked only for its minutes, and then again once they give it one). As with the bubbles, history is
   * asked once per window and the live stream keeps it current: again when the window leaves what was asked, a threshold falls under what
   * it was asked from, or the stream reconnected. A source that cannot answer (an older server) is asked again a minute later.
   */
  ensureAbsorption(allIds: readonly string[], allThresholds: readonly (number | null)[], view: Bounds, sdMinutes: number): void {
    // More instruments than one question may name is more markets than any page has; the first are asked about.
    const ids = allIds.slice(0, MAX_ABSORPTION_INSTRUMENTS), thresholds = allThresholds.slice(0, MAX_ABSORPTION_INSTRUMENTS);
    if (this.#absorptionLoading || !ids.length || !(view.t1 > view.t0)) return;
    const now = Date.now(), MIN = 60_000;
    if (this.absorptionState === 'unavailable' && now < this.#absorptionRetryAt) return;
    const key = `${ids.join(',')}|${sdMinutes}`, have = this.#absorptionCover?.key === key ? this.#absorptionCover : null;
    if (have && have.from <= view.t0 && have.to >= Math.min(view.t1, now) && thresholds.every((v, i) => v === null || v >= have.mins[i]!)) return;
    const span = view.t1 - view.t0;
    const from = Math.floor((view.t0 - span * 0.25) / MIN) * MIN, to = Math.ceil(Math.min(view.t1 + span * 0.1, now + MIN) / MIN) * MIN;
    const mins = thresholds.map(v => v === null ? Number.MAX_SAFE_INTEGER : Math.floor(v * 0.75));
    // The minutes: all of the span the first time, then the last few (the stream has brought the rest).
    const need = Math.floor(now / MIN) * MIN - (sdMinutes + 1) * MIN;
    const since = have && have.minutesFrom <= need ? Math.max(need, now - 3 * MIN) : need;
    const connection = this.#connection;
    this.#absorptionLoading = true;
    this.source.absorption([...ids], mins, from, to, 4_000, since).then(
      answer => {
        this.absorption.load(answer); this.absorptionCapped = answer.capped; this.absorptionState = 'ready';
        // The answer covers its window for the connection it was asked on; one that reached the live edge is kept current by the stream.
        if (connection === this.#connection) this.#absorptionCover = { key, from, to: to >= now ? Infinity : to, mins, minutesFrom: Math.min(since, have?.minutesFrom ?? Infinity) };
        this.onAbsorptionChanged();
      },
      () => { this.absorptionState = 'unavailable'; this.#absorptionRetryAt = Date.now() + 60_000; this.onAbsorptionChanged(); },
    ).finally(() => { this.#absorptionLoading = false; });
  }

  /**
   * Make sure every window has its value area, on rows of `step` holding `share`. Safe to call every frame: one request at a time, at most a
   * day of minutes in it (a day costs the recorder about 90 ms), finished windows asked once and the window under way again after a minute
   * (five when an answer took longer than 300 ms). A source that cannot answer (an older server) is asked again a minute later.
   */
  ensureValueAreas(ids: readonly string[], windows: readonly { from: number; to: number }[], step: number, share: number): void {
    if (this.#vaLoading || !ids.length || !windows.length || !(step > 0)) return;
    const now = Date.now();
    if (this.valueAreasState === 'unavailable' && now < this.#vaRetryAt) return;
    const again = this.#vaLastMs > 300 ? 300_000 : 60_000;
    const due = windows.filter(w => { const held = this.valueAreas.get(valueAreaKey(ids, step, share, w)); return !held || (w.to > held.at && now - held.at >= again); });
    if (!due.length) return;
    const batch: { from: number; to: number }[] = []; let span = 0;
    for (const w of [...due].sort((a, b) => b.to - a.to)) {
      const length = Math.min(w.to, now) - w.from;
      if (batch.length && (span + length > 86_400_000 || batch.length >= MAX_VALUE_AREA_WINDOWS)) break;
      batch.push(w); span += length;
    }
    this.#vaLoading = true;
    const started = performance.now();
    this.source.valueAreas([...ids], batch, step, share).then(answer => {
      this.#vaLastMs = performance.now() - started; this.valueAreasState = 'ready';
      const at = Date.now();
      answer.windows.forEach((w, i) => this.valueAreas.set(valueAreaKey(ids, step, share, batch[i]!), { ...w, at }));
      // A bound on what is held: the oldest answers go first.
      if (this.valueAreas.size > 600) for (const key of [...this.valueAreas.keys()].slice(0, this.valueAreas.size - 500)) this.valueAreas.delete(key);
      this.onTraded();
    }, () => { this.valueAreasState = 'unavailable'; this.#vaRetryAt = Date.now() + 60_000; this.onTraded(); }).finally(() => { this.#vaLoading = false; });
  }

  /**
   * Make sure the traded-volume column has an answer for these instruments, this window (whole minutes) and this row step. Safe to call
   * every frame: one request at a time, a new one when the question changes, and every five seconds while the map follows the live edge (the
   * open minute keeps trading). A source that cannot answer (an older server) is asked again a minute later.
   */
  ensureTraded(ids: readonly string[], from: number, to: number, step: number, live: boolean): void {
    // No instruments left: nothing has traded on the map, and an answer still on its way for the last ones must not draw them back.
    if (!ids.length) { if (this.traded || this.#tradedAsked) { this.traded = null; this.#tradedAsked = ''; this.#tradedGen++; this.onTraded(); } return; }
    if (this.#tradedLoading || !(to > from) || !(step > 0)) return;
    const now = Date.now();
    if (this.tradedState === 'unavailable' && now < this.#tradedRetryAt) return;
    const key = `${ids.join(',')}|${step}|${from}|${to}`;
    if (key === this.#tradedAsked && !(live && now - this.#tradedAt >= 5_000)) return;
    this.#tradedLoading = true; this.#tradedAsked = key; this.#tradedAt = now;
    const generation = ++this.#tradedGen;
    this.source.profile([...ids], from, to, step).then(
      answer => { if (generation !== this.#tradedGen) return; this.traded = { step, answer }; this.tradedState = 'ready'; this.onTraded(); },
      () => { if (generation !== this.#tradedGen) return; this.tradedState = 'unavailable'; this.#tradedRetryAt = Date.now() + 60_000; this.#tradedAsked = ''; this.onTraded(); },
    ).finally(() => { this.#tradedLoading = false; });
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

  /** Make sure recorded columns cover `view` (with margin) at a resolution suited to `widthPx`. */
  async loadColumns(view: Bounds, widthPx: number): Promise<void> {
    const ids = this.store.state.levels?.books.map(book => book.id) ?? [];
    if (!ids.length || this.#columnsLoading) return;
    const span = view.t1 - view.t0;
    const stepMs = Math.max(MINUTE, Math.round(span / Math.max(1, widthPx) * 2 / MINUTE) * MINUTE);
    const key = ids.join(',');
    const have = this.#columns;
    if (have && have.key === key && have.stepMs === stepMs && have.from <= view.t0 && have.to >= view.t1) return;
    this.#columnsLoading = true;
    try {
      const from = view.t0 - span * 0.5, to = Math.min(Date.now() + MINUTE, view.t1 + span * 0.5);
      const frame = await this.source.columns(ids, from, to, stepMs);
      this.#columns = { key, from, to: view.t1 + span * 0.5, stepMs };
      // The instruments are views onto a few fetch buffers that nothing on this thread reads again: hand the buffers over instead of copying tens of MB.
      const buffers = new Set<ArrayBuffer>();
      for (const set of frame.instruments) for (const array of [set.bins, set.bid, set.ask]) if (array.buffer instanceof ArrayBuffer) buffers.add(array.buffer);
      this.#post({ type: 'columns', stepMs: frame.stepMs, instruments: frame.instruments }, [...buffers]);
      this.columnStepMs = frame.stepMs; this.columnsVersion++;
      this.onColumns();
    } finally { this.#columnsLoading = false; }
  }

  /** Executions per candle for a window (the footprint). */
  footprint(inst: string, tf: string, from: number, to: number, rowStep: number): Promise<FootprintResponse> { return this.source.footprint(inst, tf, from, to, rowStep); }

  /** Depth (USD within +-range of mid) per pixel column over [t0, t1]. */
  depth(enabled: string[], t0: number, t1: number, w: number, range: number, mids: Float64Array): Promise<{ bid: Float32Array; ask: Float32Array }> {
    const id = ++this.#rasterId + 1_000_000;
    return new Promise(resolve => { this.#depthWaiters.set(id, resolve); this.#post({ type: 'depth', id, enabled, t0, t1, w, range, mids }); });
  }

  /** What each enabled instrument holds in the map cell [t0, t1) x [p0, p1). */
  cell(enabled: string[], t0: number, t1: number, p0: number, p1: number): Promise<CellShare[]> {
    const id = ++this.#rasterId + 3_000_000;
    return new Promise(resolve => { this.#cellWaiters.set(id, resolve); this.#post({ type: 'cell', id, enabled, t0, t1, p0, p1 }); });
  }

  /** Liquidity Tracker series over [t0, t1] for the enabled instruments. */
  lt(enabled: string[], t0: number, t1: number, params: LtParams): Promise<LtSeries> {
    const id = ++this.#rasterId + 2_000_000;
    return new Promise(resolve => { this.#ltWaiters.set(id, resolve); this.#post({ type: 'lt', id, enabled, t0, t1, params }); });
  }

  /** Force the next loadColumns to refetch (new minutes were recorded). */
  invalidateColumns(): void { this.#columns = null; }

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
  if (!last || !was || was[0] !== last[0]) return loaded;
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
