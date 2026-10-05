import type { VenueStatus } from '../shared/engine.ts';
import { TIMEFRAMES } from '../shared/series.ts';
import { toWire } from '../shared/prints.ts';
import type { FeedsIn, FeedsOut, RpcCall, RpcResult } from './browser/protocol.ts';
import type { Print } from './prints.ts';
import type { BootstrapState, DataSource, FootprintResponse, LiveHandlers, TickMessage, VenueCatalog, VenueControl, VenueEntry } from './source.ts';
import type { ColumnsFrame, LevelsFrame } from './wire.ts';
import type { CandleRow, OiBar } from './store.ts';

/** Where a person's venue choice is kept between visits. */
const SELECTION_KEY = 'lmf.venues';
/** How long the first bootstrap waits for some venue to come up, so the page opens on a market that has data. */
const FIRST_LIVE_MS = 4_000;
/** The words shown beside a venue that refuses this visitor's location. */
export const BLOCKED_TEXT = 'unavailable from your location — a VPN may help';

function savedSelection(): string[] | null {
  try {
    const value = JSON.parse(localStorage.getItem(SELECTION_KEY) ?? 'null') as unknown;
    return Array.isArray(value) && value.every(id => typeof id === 'string') ? value : null;
  } catch { return null; }
}
function saveSelection(selected: readonly string[]): void { try { localStorage.setItem(SELECTION_KEY, JSON.stringify(selected)); } catch { /* private mode: the choice lasts for this visit */ } }

function statusText(venue: VenueStatus): string {
  switch (venue.state) {
    case 'live': return venue.detail ? `live — ${venue.detail}` : 'live';
    case 'connecting': return 'connecting…';
    case 'off': return 'off';
    case 'blocked': return BLOCKED_TEXT;
    case 'error': return venue.detail || 'connection failed';
  }
}
export const toEntry = (venue: VenueStatus): VenueEntry => ({ id: venue.id, name: venue.name, supported: true, recommended: venue.recommended, selected: venue.selected, status: statusText(venue), state: venue.state });

/**
 * The exchanges straight from this browser: the engine runs in a worker (`browser/feeds.worker.ts`) and this class is the page's side of
 * it. It answers the same questions `ServerSource` answers, from the same kinds of data, so nothing above it knows which one it has.
 */
export class BrowserSource implements DataSource, VenueControl {
  readonly kind = 'browser' as const;
  readonly venues: VenueControl = this;
  readonly #worker: Worker;
  readonly #ready: Promise<void>;
  readonly #calls = new Map<number, { resolve(value: unknown): void; reject(error: Error): void }>();
  readonly #watchers = new Set<(venues: VenueEntry[]) => void>();
  readonly #firstLive: Promise<void>;
  #handlers: LiveHandlers | null = null;
  #next = 0;
  #statuses: VenueStatus[] = [];
  #statusKnown: Promise<void>;
  #levels: LevelsFrame | null = null;
  #tick: TickMessage | null = null;
  #waited = false;
  /** Whether this tab is the one saving recordings, and whether anything is saved at all. */
  recording = false; persisted = false;

  constructor(worker: Worker, { persist = true }: { persist?: boolean } = {}) {
    this.#worker = worker;
    let ready!: () => void, live!: () => void, known!: () => void;
    this.#ready = new Promise<void>(resolve => { ready = resolve; });
    this.#firstLive = new Promise<void>(resolve => { live = resolve; });
    this.#statusKnown = new Promise<void>(resolve => { known = resolve; });
    worker.onmessage = (event: MessageEvent<FeedsOut>) => {
      const message = event.data;
      switch (message.type) {
        case 'ready': this.persisted = message.persisted; ready(); break;
        case 'levels': this.#levels = message.frame; this.#handlers?.onLevels(message.frame); break;
        case 'tick': {
          const { tick } = message;
          this.#tick = { t: 'tick', price: tick.price, instrumentId: tick.instrumentId, asOf: tick.asOf, candles: tick.candles, prices: tick.prices };
          this.#handlers?.onTick(this.#tick); break;
        }
        case 'prints': this.#handlers?.onPrints(message.items.map(toWire)); break;
        case 'status':
          this.#statuses = message.venues; known();
          if (message.venues.some(v => v.state === 'live')) live();
          for (const watcher of this.#watchers) watcher(message.venues.map(toEntry));
          break;
        case 'recording': this.recording = message.recording; break;
        case 'rpc': {
          const call = this.#calls.get(message.id); this.#calls.delete(message.id);
          if (message.error !== undefined) call?.reject(new Error(message.error)); else call?.resolve(message.result);
          break;
        }
      }
    };
    worker.onerror = event => { this.#handlers?.onClose(1, 'the browser engine'); console.error('feeds worker:', event.message); };
    this.#post({ type: 'init', selected: savedSelection(), persist });
    // Recordings still queued are written as the page goes away.
    addEventListener('pagehide', () => this.#post({ type: 'flush' }));
  }

  #post(message: FeedsIn): void { this.#worker.postMessage(message); }
  #call<M extends RpcCall['method']>(call: Extract<RpcCall, { method: M }>): Promise<RpcResult[M]> {
    return this.#ready.then(() => new Promise<RpcResult[M]>((resolve, reject) => {
      const id = ++this.#next;
      this.#calls.set(id, { resolve: resolve as (value: unknown) => void, reject });
      this.#post({ type: 'rpc', id, ...call });
    }));
  }

  async bootstrap(): Promise<BootstrapState> {
    await this.#ready;
    // Only the first call waits: later ones come from the series loader and must not stall.
    if (!this.#waited) { this.#waited = true; await Promise.race([this.#firstLive, new Promise<void>(resolve => setTimeout(resolve, FIRST_LIVE_MS))]); }
    const boot = await this.#call({ method: 'bootstrap' });
    return { ...boot, dataMode: 'browser', layers: {} };
  }

  connect(handlers: LiveHandlers): { close(): void } {
    this.#handlers = handlers;
    void this.#ready.then(() => {
      if (this.#handlers !== handlers) return;
      handlers.onOpen();
      if (this.#levels) handlers.onLevels(this.#levels);
      if (this.#tick) handlers.onTick(this.#tick);
    });
    return { close: () => { if (this.#handlers === handlers) this.#handlers = null; } };
  }

  async candles(inst: string, tf: string, from: number, to: number): Promise<CandleRow[]> { return this.#call({ method: 'candles', inst, tfMs: TIMEFRAMES[tf] ?? 3_600_000, from, to }); }
  async oi(inst: string, tf: string, from: number, to: number): Promise<OiBar[]> { return this.#call({ method: 'oi', inst, tfMs: TIMEFRAMES[tf] ?? 3_600_000, from, to }); }
  async prints(from: number, to: number): Promise<Print[]> { return this.#call({ method: 'prints', from, to }); }
  async columns(ids: string[], from: number, to: number, stepMs: number): Promise<ColumnsFrame> { return this.#call({ method: 'columns', ids, from, to, stepMs }); }
  async footprint(inst: string, tf: string, from: number, to: number, rowStep: number): Promise<FootprintResponse> {
    return this.#call({ method: 'footprint', inst, tfMs: TIMEFRAMES[tf] ?? 3_600_000, from, to, rowStep });
  }

  // ---- VenueControl ---------------------------------------------------------------------------------------------------------------

  async catalog(): Promise<VenueCatalog> {
    await this.#statusKnown;
    return { venues: this.#statuses.map(toEntry), limit: null, recommendedKnown: true };
  }
  async apply(selected: readonly string[]): Promise<void> {
    saveSelection(selected);
    this.#post({ type: 'select', selected: [...selected] });
  }
  watch(listener: (venues: VenueEntry[]) => void): () => void {
    this.#watchers.add(listener);
    if (this.#statuses.length) listener(this.#statuses.map(toEntry));
    return () => { this.#watchers.delete(listener); };
  }
}
