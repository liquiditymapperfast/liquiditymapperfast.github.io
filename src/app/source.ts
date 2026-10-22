import type { Print } from './prints.ts';
import type { TapeBatch } from '../shared/tape.ts';
import type { LsMetric, LsSeries } from '../shared/long-short.ts';
import type { Liquidation } from '../shared/liquidations.ts';
import type { PrintSumsAnswer } from '../shared/print-sums.ts';
import type { FlowFrame, FlowMinutesFrame, FlowUpdate } from '../shared/flow.ts';
import type { ProfileAnswer, RangeAnswer, SizesAnswer, ValueAreaAnswer } from '../shared/footprint.ts';
import type { OiProfileAnswer } from '../shared/oi-profile.ts';
import type { AbsorptionAnswer, AbsorptionGroup, AbsorptionMinute, AbsorptionProfileAnswer } from '../shared/absorption.ts';
import type { CoverageAnswer, CoverageMetric } from '../shared/coverage.ts';
import type { RecoveryReport, RecoveryRequest } from '../shared/engine.ts';
import type { PriceHistoryAnswer } from '../shared/price-history.ts';
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
export interface LiquidationsMessage { t: 'liquidations'; items: unknown[] }
export interface OiPushMessage { t: 'oi'; items: unknown[] }
export interface LiveHandlers {
  /** `failures` counts the connections lost since the last one that worked; `host` is the place being tried. */
  onOpen(): void; onClose(failures: number, host: string): void;
  onLevels(frame: LevelsFrame): void; onTick(tick: TickMessage): void; onLayers(message: LayersMessage): void;
  /** New large trades, as wire rows (check each with `fromWire`). */
  onPrints(items: unknown[]): void;
  /** New liquidations, as wire rows (check each with shared/liquidations.ts `fromWire`). */
  onLiquidations?(items: unknown[]): void;
  /** Taker flow per second for the seconds that changed (about once a second): each replaces what the page had for that second. */
  onFlow?(items: FlowUpdate[]): void;
  /** Every market order completed since the last batch, for the trade dust (checked already; only while asked for with `tape(true)`). */
  onTape?(batch: TapeBatch): void;
  /** Absorption groups found and minutes settled (checked already). */
  onAbsorption?(groups: AbsorptionGroup[], minutes: AbsorptionMinute[]): void;
  /** New open-interest readings the moment the source has them (each checked by the caller before the bars are touched). */
  onOiPush?(items: unknown[]): void;
  /** A gap of `id` was filled from the venue's trade history over [from, to): recovered trades, never to flash or sound. */
  onRecovered?(id: string, from: number, to: number): void;
}

/** Executions per candle for a window, as the footprint draws them. */
/** `from`: where the answer starts when the source answered only the newest part of the window for a `budget` (absent from an older source: the whole window). */
export interface FootprintResponse { step: number; fine: number; bars: Bar[]; from?: number; /** With `venues`: the markets each bar's `venueRows` name by place. */ venues?: string[] }

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
  /** `tape`: whether the page draws the trade dust (a server sends its batches only to a page that asked; the browser engine always does). */
  connect(handlers: LiveHandlers): { close(): void; tape(on: boolean): void };
  candles(inst: string, tf: string, from: number, to: number): Promise<CandleRow[]>;
  /** Exchange history for the display-only price overview, with its own source and resolution; optional on older sources. */
  priceHistory?(inst: string, tf: string, from: number, to: number, signal?: AbortSignal): Promise<PriceHistoryAnswer>;
  /** `usd`: an inverse market's own USD in place of its coins (the readings that kept one; an older source ignores it and answers coins). */
  oi(inst: string, tf: string, from: number, to: number, usd?: boolean): Promise<OiBar[]>;
  /**
   * A venue's published long/short readings for one market (shared/long-short.ts): `metric` is the Binance series chosen. `signal` cancels the
   * request; a source whose requests are shared by every question (the browser engine's cache) may answer anyway.
   */
  longShort(inst: string, metric: LsMetric, tf: string, from: number, to: number, signal?: AbortSignal): Promise<LsSeries>;
  /** Large trades in [from, to), oldest first. */
  /** Large market orders in [from, to) from `minUsd` (the recording's floor when absent), the newest few thousand of them. */
  prints(from: number, to: number, minUsd?: number): Promise<Print[]>;
  /** Liquidations in a window, from the smallest kept or `minUsd` (a server from before them has none). */
  liquidations?(from: number, to: number, minUsd?: number): Promise<Liquidation[]>;
  /** Whale VWAP sums of `ids` in [from, to) from the size band at `minUsd` up, in steps of `stepMs` (a server from before them answers 404). */
  printSums?(ids: string[], from: number, to: number, minUsd: number, stepMs: number): Promise<PrintSumsAnswer>;
  columns(ids: string[], from: number, to: number, stepMs: number): Promise<ColumnsFrame>;
  /** Taker buys and sells per second for each instrument over [from, to), from its first recorded minute in that range. */
  flow(ids: string[], from: number, to: number): Promise<FlowFrame>;
  /** The same flow a minute at a time, for windows older than the seconds the page holds; a source that keeps no older flow (the browser keeps a day) has none. */
  flowMinutes?(ids: string[], from: number, to: number): Promise<FlowMinutesFrame>;
  /** `cuts`: size lines (USD, from the print floor) whose orders each bar carries in `over` where the source has them (an older server leaves them out). */
  footprint(inst: string, tf: string, from: number, to: number, rowStep: number, cuts?: readonly number[], budget?: number, venues?: boolean): Promise<FootprintResponse>;
  /**
   * The trades of `ids` added together by size over each of the last `windows` minutes (up to and including the open one), in one answer: the
   * minutes two answers saw cannot be added, so a long list is never asked in parts. Rejects when the source cannot say (an older server).
   */
  sizes(ids: string[], windows: number[], cuts?: readonly number[]): Promise<SizesAnswer>;
  /** Traded volume by price for `ids` over the minutes that start in [from, to). Rejects when the source cannot say (an older server). */
  profile(ids: string[], from: number, to: number, rowStep: number): Promise<ProfileAnswer>;
  /** The change in open interest of the perpetuals among `ids` by price (shared/oi-profile.ts). A source without it (an older server) leaves it out. */
  oiProfile?(ids: string[], from: number, to: number, rowStep: number): Promise<OiProfileAnswer>;
  /** What happened in a selection: the minutes that start in [from, to), at the prices of `band` or at every price (see `RangeAnswer`). Rejects when the source cannot say (an older server). */
  range(ids: string[], from: number, to: number, band: { p0: number; p1: number } | null, rowStep: number): Promise<RangeAnswer>;
  /** The point of control and the value area of each window (whole minutes), on rows of `rowStep`, holding `share` (0..1). Rejects when the source cannot say. */
  valueAreas(ids: string[], windows: { from: number; to: number }[], rowStep: number, share: number): Promise<ValueAreaAnswer>;
  /**
   * When `ids` were recorded over the whole minutes of [from, to) (shared/coverage.ts): per minute the seconds covered and whether anything
   * is held, so a minute recorded with nothing in it is told apart from one nobody recorded. A source that cannot say (an older server) leaves
   * it out, and nothing is then called fully covered.
   */
  coverage?(ids: string[], metric: CoverageMetric, from: number, to: number): Promise<CoverageAnswer>;
  /**
   * Fill the gaps of the windows from the venues' trade history (shared/recovery.ts), within one action's budget. Only a source that records
   * in the page has it (the browser engine): a server records on its own, whether a page is open or not.
   */
  recover?(request: RecoveryRequest): Promise<RecoveryReport>;
  /** Absorption candidates of each of `ids` starting in [from, to) with a largest credit of at least its `mins` entry (at most `limit` each, the largest first), floors, and the minutes since `since`. */
  absorption(ids: string[], mins: number[], from: number, to: number, limit: number, since: number): Promise<AbsorptionAnswer>;
  /**
   * The absorption column (shared/absorption.ts `AbsorptionProfile`): the marked USD of every group of `ids` that began in [from, to), each at
   * its `thresholds` entry, by price on rows of `rowStep`, none left out, and where the rows may be short. No minutes are read.
   */
  absorptionProfile(ids: string[], thresholds: number[], from: number, to: number, rowStep: number): Promise<AbsorptionProfileAnswer>;
  readonly venues: VenueControl;
  /** What becomes of the recordings, at `now`; a source whose recordings are kept elsewhere (the server) leaves it out. */
  saving?(now: number): SavingState;
}
