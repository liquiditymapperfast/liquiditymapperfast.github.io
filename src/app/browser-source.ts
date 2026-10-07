import type { VenueStatus } from '../shared/engine.ts';
import type { FlowFrame } from '../shared/flow.ts';
import { TIMEFRAMES } from '../shared/series.ts';
import { toWire } from '../shared/prints.ts';
import { parseProfile, parseSizes, type ProfileAnswer, type SizesAnswer } from '../shared/footprint.ts';
import { parseAbsorptionAnswer, parseAbsorptionLive, type AbsorptionAnswer } from '../shared/absorption.ts';
import type { FeedsIn, FeedsOut, RpcCall, RpcResult } from './browser/protocol.ts';
import type { Print } from './prints.ts';
import type { BootstrapState, DataSource, FootprintResponse, LiveHandlers, SavingState, TickMessage, VenueCatalog, VenueControl, VenueEntry } from './source.ts';
import type { ColumnsFrame, LevelsFrame } from './wire.ts';
import type { CandleRow, OiBar } from './store.ts';
import { t } from './i18n.ts';
import { BTC, EARLIER_BROWSER_VENUES, type Coin } from '../shared/coins.ts';
import { recorderLockName, recordingsName } from './coin.ts';

/** Where a person's venue choice is kept between visits, and the venues there were when it was made (so ones added since can start). */
const SELECTION_KEY = 'lmf.venues', KNOWN_KEY = 'lmf.venues.known';
/** How long the first bootstrap waits for a venue with a price, so the page opens on a market that has data. */
const FIRST_PRICE_MS = 4_000;
/** The words shown beside a venue that refuses this visitor's location. */
export const BLOCKED_TEXT = t('unavailable from your location — a VPN may help');

function savedSelection(): string[] | null {
  try {
    const value = JSON.parse(localStorage.getItem(SELECTION_KEY) ?? 'null') as unknown;
    return Array.isArray(value) && value.every(id => typeof id === 'string') ? value : null;
  } catch { return null; }
}
function savedKnown(): string[] | null {
  try {
    const value = JSON.parse(localStorage.getItem(KNOWN_KEY) ?? 'null') as unknown;
    return Array.isArray(value) && value.every(id => typeof id === 'string') ? value : null;
  } catch { return null; }
}
/**
 * The venue choice to keep after Apply on a coin that some markets do not list. Those markets could not be ticked, so what the saved
 * choice said about them stands, both whether they were chosen and whether they had been seen: one choice serves every coin. With no
 * choice saved before, they stay unseen, so a coin that has them starts them as recommended ones.
 */
export function keptChoice(chosen: readonly string[], all: readonly string[], unlisted: ReadonlySet<string>, before: { selected: readonly string[] | null; known: readonly string[] | null }): { selected: string[]; known: string[] } {
  const seenBefore = before.known ?? (before.selected ? EARLIER_BROWSER_VENUES : []);
  return {
    selected: [...chosen.filter(id => !unlisted.has(id)), ...(before.selected ?? []).filter(id => unlisted.has(id))],
    known: [...all.filter(id => !unlisted.has(id)), ...seenBefore.filter(id => unlisted.has(id))],
  };
}
function saveSelection(selected: readonly string[], known: readonly string[]): void {
  try { localStorage.setItem(SELECTION_KEY, JSON.stringify(selected)); if (known.length) localStorage.setItem(KNOWN_KEY, JSON.stringify(known)); } catch { /* private mode: the choice lasts for this visit */ }
}

function statusText(venue: VenueStatus): string {
  switch (venue.state) {
    case 'live': return venue.detail ? t('live — {detail}', { detail: venue.detail }) : t('live');
    case 'connecting': return t('connecting…');
    case 'off': return t('off');
    case 'blocked': return BLOCKED_TEXT;
    case 'error': return venue.detail || t('connection failed');
  }
}
export const toEntry = (venue: VenueStatus): VenueEntry => ({ id: venue.id, name: venue.name, supported: venue.listed, recommended: venue.recommended, selected: venue.selected, status: venue.listed ? statusText(venue) : t('does not list this coin'), state: venue.state });

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
  #handlers: LiveHandlers | null = null;
  #next = 0;
  #statuses: VenueStatus[] = [];
  #statusKnown: Promise<void>;
  #levels: LevelsFrame | null = null;
  #tick: TickMessage | null = null;
  #waited = false;
  /** Set once the worker has said it is ready: an error before that means it never started, one after it only means something threw. */
  #started = false;
  /** Why the worker cannot be used (it never started): every request fails with this, at once. */
  #failure: Error | null = null;
  /** Whether this tab is the one saving recordings, and whether anything is saved at all. */
  recording = false; persisted = false;
  /** This tab's storage stopped working: nothing it records is kept from here on. */
  storageFailed = false;
  #readyAt = 0;

  constructor(worker: Worker, { persist = true, coin = BTC, tier = 0 }: { persist?: boolean; coin?: Coin; tier?: number } = {}) {
    this.#worker = worker;
    let ready!: () => void, known!: () => void, failReady!: (error: Error) => void, failKnown!: (error: Error) => void;
    this.#ready = new Promise<void>((resolve, reject) => { ready = resolve; failReady = reject; });
    this.#statusKnown = new Promise<void>((resolve, reject) => { known = resolve; failKnown = reject; });
    // Whoever waits on these is told; these two handlers only keep a rejection nobody was waiting for yet from being reported as unhandled.
    this.#ready.catch(() => {}); this.#statusKnown.catch(() => {});
    this.#fail = error => {
      if (this.#failure) return;
      this.#failure = error; failReady(error); failKnown(error); this.#rejectCalls(error);
    };
    worker.onmessage = (event: MessageEvent<FeedsOut>) => {
      const message = event.data;
      switch (message.type) {
        case 'ready': this.#started = true; this.persisted = message.persisted; this.#readyAt = Date.now(); ready(); break;
        case 'failed': this.#fail(new Error(message.error)); break;
        case 'levels': this.#levels = message.frame; this.#handlers?.onLevels(message.frame); break;
        case 'tick': {
          const { tick } = message;
          this.#tick = { t: 'tick', price: tick.price, instrumentId: tick.instrumentId, asOf: tick.asOf, candles: tick.candles, prices: tick.prices };
          this.#handlers?.onTick(this.#tick); break;
        }
        case 'prints': this.#handlers?.onPrints(message.items.map(toWire)); break;
        case 'flow': this.#handlers?.onFlow?.(message.items); break;
        case 'absorption': { const found = parseAbsorptionLive(message); this.#handlers?.onAbsorption?.(found.groups, found.minutes); break; }
        case 'status':
          this.#statuses = message.venues; known();
          for (const watcher of this.#watchers) watcher(message.venues.map(toEntry));
          break;
        case 'recording': this.recording = message.recording; if (message.failed) this.storageFailed = true; break;
        case 'rpc': {
          const call = this.#calls.get(message.id); this.#calls.delete(message.id);
          if (message.error !== undefined) call?.reject(new Error(message.error)); else call?.resolve(message.result);
          break;
        }
      }
    };
    worker.onerror = event => {
      this.#handlers?.onClose(1, t('the browser engine')); console.error('feeds worker:', event.message);
      const error = new Error(event.message || t('the browser engine'));
      // A worker that never started will answer nothing; one that did start has only had something throw, and may well go on: what was
      // outstanding is failed either way (it may never be answered), and only the first case closes the door.
      if (this.#started) this.#rejectCalls(error); else this.#fail(error);
    };
    this.#post({ type: 'init', selected: savedSelection(), known: savedKnown(), persist, coin, tier, database: recordingsName(coin.coin), lock: recorderLockName(coin.coin) });
    // Recordings still queued are written as the page goes away.
    addEventListener('pagehide', () => this.#post({ type: 'flush' }));
  }

  /**
   * What becomes of what this tab records, for the status bar. A moment after the worker is ready it may not have been given the recorder
   * role yet (the role is asked for as the engine starts), and that moment is not the same as another tab holding it.
   */
  saving(now: number): SavingState {
    if (!this.#started) return 'starting';
    if (!this.persisted) return 'memory';
    if (this.storageFailed) return 'failed';
    if (this.recording) return 'here';
    return now - this.#readyAt < 3_000 ? 'starting' : 'other';
  }

  #fail: (error: Error) => void = () => {};
  #rejectCalls(error: Error): void { const calls = [...this.#calls.values()]; this.#calls.clear(); for (const call of calls) call.reject(error); }
  #post(message: FeedsIn): void { this.#worker.postMessage(message); }
  #call<M extends RpcCall['method']>(call: Extract<RpcCall, { method: M }>): Promise<RpcResult[M]> {
    if (this.#failure) return Promise.reject(this.#failure);
    return this.#ready.then(() => new Promise<RpcResult[M]>((resolve, reject) => {
      if (this.#failure) { reject(this.#failure); return; }
      const id = ++this.#next;
      this.#calls.set(id, { resolve: resolve as (value: unknown) => void, reject });
      this.#post({ type: 'rpc', id, ...call });
    }));
  }

  async bootstrap(): Promise<BootstrapState> {
    await this.#ready;
    let boot = await this.#call({ method: 'bootstrap' });
    // Only the first call waits (later ones come from the series loader and must not stall). A venue is live before it has a price, and a
    // blocked or slow one never does, so the page waits for the first one that has a price and opens on that market.
    if (!this.#waited) {
      this.#waited = true;
      const deadline = Date.now() + FIRST_PRICE_MS;
      while (!boot.markInstrumentId && Date.now() < deadline) { await new Promise<void>(resolve => setTimeout(resolve, 250)); boot = await this.#call({ method: 'bootstrap' }); }
    }
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
  async prints(from: number, to: number, minUsd?: number): Promise<Print[]> { return this.#call({ method: 'prints', from, to, ...(minUsd !== undefined ? { minUsd } : {}) }); }
  async columns(ids: string[], from: number, to: number, stepMs: number): Promise<ColumnsFrame> { return this.#call({ method: 'columns', ids, from, to, stepMs }); }
  async flow(ids: string[], from: number, to: number): Promise<FlowFrame> { return this.#call({ method: 'flow', ids, from, to }); }
  async absorption(ids: string[], mins: number[], from: number, to: number, limit: number, since: number): Promise<AbsorptionAnswer> {
    const answer = parseAbsorptionAnswer(await this.#call({ method: 'absorption', ids, mins, from, to, limit, since }), ids);
    if (!answer) throw new Error('the browser engine answered the absorption question with something else');
    return answer;
  }
  async profile(ids: string[], from: number, to: number, rowStep: number): Promise<ProfileAnswer> {
    const answer = parseProfile(await this.#call({ method: 'profile', ids, from, to, rowStep }), ids);
    if (!answer) throw new Error('the browser engine answered the profile question with something else');
    return answer;
  }
  async sizes(ids: string[], windows: number[]): Promise<SizesAnswer> {
    const answer = parseSizes(await this.#call({ method: 'sizes', ids, windows }), windows);
    if (!answer) throw new Error('the browser engine answered the sizes question with something else');
    return answer;
  }
  async footprint(inst: string, tf: string, from: number, to: number, rowStep: number): Promise<FootprintResponse> {
    return this.#call({ method: 'footprint', inst, tfMs: TIMEFRAMES[tf] ?? 3_600_000, from, to, rowStep });
  }

  // ---- VenueControl ---------------------------------------------------------------------------------------------------------------

  async catalog(): Promise<VenueCatalog> {
    await this.#statusKnown;
    return { venues: this.#statuses.map(toEntry), limit: null, recommendedKnown: true };
  }
  async apply(selected: readonly string[]): Promise<void> {
    const unlisted = new Set(this.#statuses.filter(venue => !venue.listed).map(venue => venue.id));
    const kept = keptChoice(selected, this.#statuses.map(venue => venue.id), unlisted, { selected: savedSelection(), known: savedKnown() });
    saveSelection(kept.selected, kept.known);
    this.#post({ type: 'select', selected: [...selected] });
  }
  watch(listener: (venues: VenueEntry[]) => void): () => void {
    this.#watchers.add(listener);
    if (this.#statuses.length) listener(this.#statuses.map(toEntry));
    return () => { this.#watchers.delete(listener); };
  }
}
