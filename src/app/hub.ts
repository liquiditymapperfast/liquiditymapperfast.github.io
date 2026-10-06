import { connectionStatus } from './net.ts';
import type { DataSource, FootprintResponse, TickMessage } from './source.ts';
import { PrintBook, fromWire, type Print } from './prints.ts';
import type { Store, CandleRow } from './store.ts';
import type { WorkerIn, WorkerOut, RasterStats } from './worker/raster.worker.ts';
import type { CellShare } from './cell-sources.ts';
import type { Bounds } from './view.ts';
import type { LtParams, LtSeries } from './lt.ts';
import { pickOi, weakOi, type OiCandidate } from './oi-source.ts';
import { t } from './i18n.ts';

export const TIMEFRAMES: Readonly<Record<string, number>> = { '1m': 60_000, '5m': 300_000, '15m': 900_000, '30m': 1_800_000, '1h': 3_600_000, '4h': 14_400_000, '1d': 86_400_000 };
const MINUTE = 60_000;

export interface RasterResult { id: number; w: number; h: number; data: Float32Array; stats: RasterStats; bounds: Bounds }

/** Owns data loading: bootstrap, live socket, candles, OI, recorded columns and the raster worker. */
export class Hub {
  readonly worker: Worker;
  #ready: Promise<void>;
  #rasterId = 0;
  #inflight = new Map<number, Bounds>();
  #columns: { key: string; from: number; to: number; stepMs: number } | null = null;
  #columnsLoading = false;
  #series = '';
  #oiKey = '';
  /** Large trades for the bubbles: history for the window on screen plus everything the live stream has delivered. */
  readonly prints = new PrintBook();
  /** Called with each batch of new large trades from the live stream (for sounds). */
  onPrints: (fresh: Print[]) => void = () => {};
  /** Called when the print book changed, so the chart can redraw its bubbles. */
  onPrintsChanged: () => void = () => {};
  #printsWindow: { t0: number; t1: number } | null = null;
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
      onOpen: () => { this.#printsWindow = null; this.store.set({ connected: true, status: t('live') }); },
      onClose: (failures, host) => this.store.set({ connected: false, status: connectionStatus(failures, host) }),
      onLevels: frame => {
        this.store.set({ levels: frame });
        this.#post({ type: 'live', books: frame.books, now: Date.now() });
      },
      onTick: tick => this.#tick(tick),
      onLayers: message => this.store.set({ layers: message.layers }),
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
    // A source that knows every live price (the browser) gives the market on screen its own; otherwise only the reference instrument moves the mark.
    const own = tick.prices?.[state.marketId];
    if (own !== undefined) patch.mark = { price: own, asOf: tick.asOf };
    else if (tick.instrumentId === state.marketId || !state.marketId || !(state.mark.price > 0)) patch.mark = { price: tick.price, asOf: tick.asOf };
    const live = tick.candles[state.seriesInstrument || state.marketId];
    if (live && state.candles.length) patch.candles = mergeLive(state.candles, live, TIMEFRAMES[state.timeframe] ?? 3_600_000);
    this.store.set(patch);
  }

  async loadSeries(force = false): Promise<void> {
    void this.source.bootstrap().then(boot => this.#noteRecorded(boot.recorded), () => {});
    const { marketId, timeframe } = this.store.state;
    const key = `${marketId}|${timeframe}`;
    if (!marketId || (!force && key === this.#series)) return;
    this.#series = key;
    const tf = TIMEFRAMES[timeframe] ?? 3_600_000, now = Date.now();
    let seriesInstrument = marketId;
    let candles = await this.source.candles(marketId, timeframe, now - 500 * tf, now + tf);
    if (!candles.length && this.#reference && this.#reference !== marketId) { seriesInstrument = this.#reference; candles = await this.source.candles(seriesInstrument, timeframe, now - 500 * tf, now + tf); }
    if (key !== this.#series) return;
    this.store.set({ candles: candles as CandleRow[], seriesInstrument });
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
    const tf = TIMEFRAMES[timeframe] ?? 3_600_000, now = Date.now(), from = now - 500 * tf, to = now + tf;
    const ids = [...new Set([own, this.#reference, ...this.#oiReferences].filter(Boolean))];
    const candidates: OiCandidate[] = [];
    for (const inst of ids) {
      const bars = await this.source.oi(inst, timeframe, from, to).catch(() => []);
      candidates.push({ inst, bars });
      if (!weakOi(bars, now, tf)) break;
    }
    if (this.#oiKey !== key) return;
    const chosen = pickOi(candidates, now, tf);
    if (chosen) this.store.set({ oi: chosen.bars, oiInstrument: chosen.inst });
  }

  /** Make sure the print book covers `view` (history is fetched once per window; the live stream keeps it current after that). */
  ensurePrints(view: Bounds): void {
    if (this.#printsLoading || !(view.t1 > view.t0)) return;
    const have = this.#printsWindow;
    if (have && have.t0 <= view.t0 && have.t1 >= Math.min(view.t1, Date.now())) return;
    const span = view.t1 - view.t0, from = Math.floor(view.t0 - span * 0.5), to = Math.ceil(Math.min(view.t1 + span * 0.1, Date.now() + MINUTE));
    this.#printsLoading = true;
    this.source.prints(from, to).then(rows => { this.prints.add(rows); this.#printsWindow = { t0: from, t1: to }; this.onPrintsChanged(); }, () => { /* the next frame retries */ }).finally(() => { this.#printsLoading = false; });
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

/** Fold a live 1m candle into the display-timeframe series. */
export function mergeLive(candles: CandleRow[], live: [number, number, number, number, number, number], tfMs: number): CandleRow[] {
  const [start, open, high, low, close, volume] = live;
  const bucket = Math.floor(start / tfMs) * tfMs;
  const last = candles[candles.length - 1];
  if (last && last[0] === bucket) {
    const next: CandleRow = [bucket, last[1], Math.max(last[2], high), Math.min(last[3], low), close, Math.max(last[5], volume), last[6]];
    return [...candles.slice(0, -1), next];
  }
  if (last && bucket < last[0]) return candles;
  return [...candles, [bucket, open, high, low, close, volume, 1]];
}
