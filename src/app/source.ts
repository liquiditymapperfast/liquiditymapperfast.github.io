import type { Print } from './prints.ts';
import type { FlowFrame, FlowUpdate } from '../shared/flow.ts';
import type { ProfileAnswer, SizesAnswer } from '../shared/footprint.ts';
import type { ColumnsFrame, LevelsFrame } from './wire.ts';
import type { Bar } from './panes/footprint.ts';
import type { CandleRow, LayerLevel, Market, OiBar } from './store.ts';

/** Everything the page needs once, before the first frame. */
export interface BootstrapState {
  asOf: number; now: number; dataMode: string; markPrice: number; markInstrumentId: string;
  markets: Market[]; layers: Record<string, LayerLevel[]>; steps: Record<string, number>; recorded: Record<string, { first: number; last: number }>; columnMs: number; timeframes: string[];
  /** Instruments with an open-interest series, best first: the page falls back to them when the market on screen has none. */
  oiReferences: string[];
}
export interface TickMessage {
  t: 'tick'; price: number; instrumentId: string; asOf: number; candles: Record<string, [number, number, number, number, number, number]>;
  /** The price of every live instrument, when the source knows them all (the browser does; a server sends only the reference). */
  prices?: Record<string, number>;
}
export interface LayersMessage { t: 'layers'; layers: Record<string, LayerLevel[]> }
export interface PrintsMessage { t: 'prints'; items: unknown[] }
export interface LiveHandlers {
  /** `failures` counts the connections lost since the last one that worked; `host` is the place being tried. */
  onOpen(): void; onClose(failures: number, host: string): void;
  onLevels(frame: LevelsFrame): void; onTick(tick: TickMessage): void; onLayers(message: LayersMessage): void;
  /** New large trades, as wire rows (check each with `fromWire`). */
  onPrints(items: unknown[]): void;
  /** Taker flow per second for the seconds that changed (about once a second): each replaces what the page had for that second. */
  onFlow?(items: FlowUpdate[]): void;
}

/** Executions per candle for a window, as the footprint draws them. */
export interface FootprintResponse { step: number; fine: number; bars: Bar[] }

/** One venue the person can switch on or off. */
export interface VenueEntry {
  id: string; name: string; supported: boolean;
  /** Part of the set a first run starts with. */
  recommended: boolean; selected: boolean;
  /** Short text next to the name: live, connecting, off, a failure reason. */
  status: string;
  /** What `status` says, for styling: a venue that refuses this location is told apart from one that is only failing. */
  state?: 'live' | 'connecting' | 'off' | 'error' | 'blocked' | 'upcoming';
}
export interface VenueCatalog {
  venues: VenueEntry[];
  /** How many venues the source can run at once, for the count text; null when there is no such limit. */
  limit: number | null;
  /** False when the source cannot say which venues are recommended (an older server), so the Recommended button has nothing to apply. */
  recommendedKnown: boolean;
}
export interface VenueControl {
  catalog(): Promise<VenueCatalog>;
  /** Make exactly `selected` the running venues. `product` is the market the selection is anchored on (the server needs one). */
  apply(selected: readonly string[], product: string): Promise<void>;
  /** Be told whenever any venue's state changes; returns how to stop. Sources that cannot push simply leave it out. */
  watch?(listener: (venues: VenueEntry[]) => void): () => void;
}

/**
 * What becomes of what the page records: the server keeps it, or this browser does (this tab holds the recorder role, or another tab does),
 * or nothing is kept (saving is off, the browser does not allow it, or it stopped working). `starting`: not known yet.
 */
export type SavingState = 'server' | 'here' | 'other' | 'memory' | 'failed' | 'starting';

/**
 * Where the data comes from. The page only talks to this: a local server (`ServerSource`) or the exchanges directly from the
 * browser (`BrowserSource`). Both produce the same frames, series and history, so nothing above this line knows which it is.
 */
export interface DataSource {
  readonly kind: 'server' | 'browser';
  bootstrap(): Promise<BootstrapState>;
  connect(handlers: LiveHandlers): { close(): void };
  candles(inst: string, tf: string, from: number, to: number): Promise<CandleRow[]>;
  oi(inst: string, tf: string, from: number, to: number): Promise<OiBar[]>;
  /** Large trades in [from, to), oldest first. */
  prints(from: number, to: number): Promise<Print[]>;
  columns(ids: string[], from: number, to: number, stepMs: number): Promise<ColumnsFrame>;
  /** Taker buys and sells per second for each instrument over [from, to), from its first recorded minute in that range. */
  flow(ids: string[], from: number, to: number): Promise<FlowFrame>;
  footprint(inst: string, tf: string, from: number, to: number, rowStep: number): Promise<FootprintResponse>;
  /**
   * The trades of `ids` added together by size over each of the last `windows` minutes (up to and including the open one), in one answer: the
   * minutes two answers saw cannot be added, so a long list is never asked in parts. Rejects when the source cannot say (an older server).
   */
  sizes(ids: string[], windows: number[]): Promise<SizesAnswer>;
  /** Traded volume by price for `ids` over the minutes that start in [from, to). Rejects when the source cannot say (an older server). */
  profile(ids: string[], from: number, to: number, rowStep: number): Promise<ProfileAnswer>;
  readonly venues: VenueControl;
  /** What becomes of the recordings, at `now`; a source whose recordings are kept elsewhere (the server) leaves it out. */
  saving?(now: number): SavingState;
}
