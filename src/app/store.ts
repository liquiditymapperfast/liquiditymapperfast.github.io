import type { LevelsFrame } from './wire.ts';
import type { TimeZone } from './format.ts';
import type { HeatStyleId } from './heatmap/lut.ts';
import { clampContrast } from './heatmap/window.ts';
import { LT_DEFAULTS, type LtParams } from './lt.ts';
import { resolveThemeId } from './theme.ts';
import { DEFAULT_STAT_OPTIONS, type StatOptions } from './stat-options.ts';
import { DEFAULT_HIGHLIGHT, readHighlight, type HighlightOptions } from './anomaly.ts';
import { DEFAULT_SOUNDS, readSounds, type SoundSettings } from './sound/rules.ts';
import { CVD_DEFAULTS, readCvd, type CvdSettings } from './cvd/settings.ts';
import { ABSORPTION_DEFAULTS, readAbsorption, type AbsorptionSettings } from './absorption.ts';
import { BUBBLE_DEFAULTS, readBubbles, type BubbleSettings } from './prints.ts';
import { LIQUIDATION_DEFAULTS, readLiquidations, type LiquidationSettings } from './liquidations.ts';
import { KEY_LEVEL_DEFAULTS, readKeyLevels, type KeyLevelSettings } from './keylevels/settings.ts';
import { VWAP_DEFAULTS, readVwap, type VwapSettings } from './vwap/settings.ts';
import { FOOTPRINT_DEFAULTS, readFootprint, type FootprintSettings } from './footprint/settings.ts';
import { DELTA_DEFAULTS, readDelta, type DeltaSettings } from './delta/settings.ts';
import type { EngineState } from './sound/engine.ts';
import type { RangeSelection } from './range/selection.ts';
import { TRADED_DEFAULTS, readTraded, type TradedSettings } from './traded/settings.ts';
import { t } from './i18n.ts';

export type Layer = 'liquidity' | 'liquidation' | 'stopLoss' | 'takeProfit';
/** Layers that can be chosen today. The others are announced in the dropdown as upcoming and need a data source that is not connected yet. */
export const AVAILABLE_LAYERS: readonly Layer[] = ['liquidity'];
export type LadderMode = 'aggregated' | 'single' | 'compact';
export type LadderShow = 'levels' | 'cumulative' | 'both';
/** Which kind of market the liquidity views draw: spot books, perpetual books, or every enabled venue. */
export type Scope = 'all' | 'spot' | 'perp';
export interface Market { id?: string; instrumentId?: string; venue?: string; base?: string; quote?: string; marketType?: string; tickSize?: number; symbol?: string }
/** [start, open, high, low, close, volume, sourceRows] */
export type CandleRow = [number, number, number, number, number, number, number?];
/** [start, open, high, low, close] */
export type OiBar = [number, number, number, number, number];
export interface LayerLevel { id: string; side: string; price: number; notionalUsd: number; active?: boolean; amount?: number }

/** Which panes are on the first time. */
export const DEFAULT_SHOW: AppState['show'] = { profile: true, traded: false, depth: true, oi: true, delta: false, candles: true, footprint: false, lt: false, mirror: true, volume: true, bubbles: true, cvd: true, book: true };
/**
 * The panes a first visit starts with. The flow column and the book each take a few hundred pixels beside the map, so on a window that is wide enough
 * for the map to stay readable with both (a phone has its tabs instead) they start on; a medium window (a tablet held sideways, a small laptop)
 * starts with the book only, and Flow is one click in the top bar.
 */
export function defaultShow(width: number = typeof window === 'undefined' ? 1920 : window.innerWidth): AppState['show'] {
  return { ...DEFAULT_SHOW, cvd: width <= 640 || width >= 1500 };
}

/** Statistics shown by default in the bar-stats strip (ids from panes/bar-stats.ts). */
export const DEFAULT_BAR_STATS: readonly string[] = ['vol', 'delta', 'cvd'];

export interface AppState {
  connected: boolean;
  status: string;
  markets: Market[];
  marketId: string;
  /** Instrument whose candles/OI are shown: the market itself, or the reference series when it has none. */
  seriesInstrument: string;
  mark: { price: number; asOf: number };
  levels: LevelsFrame | null;
  timeframe: string;
  layer: Layer;
  layers: Record<string, LayerLevel[]>;
  candles: CandleRow[];
  oi: OiBar[];
  /** Instrument the OI bars belong to (the market's own, or a reference perp when the market has no OI history). */
  oiInstrument: string;
  show: { profile: boolean; /** The traded-volume column beside the profile (not on phones). */ traded: boolean; depth: boolean; oi: boolean; /** The Delta pane under the map (taker delta and CVD by candle). */ delta: boolean; candles: boolean; footprint: boolean; lt: boolean; mirror: boolean; volume: boolean; bubbles: boolean; /** The taker-flow (CVD) column left of the map, and the order book column right of it. */ cvd: boolean; book: boolean };
  /** The CVD column's settings. */
  cvd: CvdSettings;
  /** What counts as standing out (anomalous volume, OI change, ...), shared by every pane. */
  highlight: HighlightOptions;
  /** Absorption marks on the map: whether they show, and the threshold they are judged at. */
  absorption: AbsorptionSettings;
  /** How the trade bubbles are drawn (whether they are is `show.bubbles`). */
  tradeBubbles: BubbleSettings;
  /** The liquidations drawn on the map (liquidations.ts). */
  liquidations: LiquidationSettings;
  /** The previous day's, week's and month's levels on the map (keylevels/). */
  keyLevels: KeyLevelSettings;
  /** The VWAP lines: the session's, its bands and the anchored ones (vwap/). */
  vwap: VwapSettings;
  /** The next click on the map places a VWAP anchor (not saved; arming the Range tool ends it). */
  vwapAnchoring: boolean;
  /** The footprint's own settings (whether it shows is `show.footprint`; its imbalance options are `barStatOptions`). */
  footprint: FootprintSettings;
  /** The Delta pane's settings: bars or CVD candles, where the CVD restarts, divergences. */
  delta: DeltaSettings;
  /** Sound notifications: master switch, volume, which trades count and the size tiers. */
  sounds: SoundSettings;
  /** Whether the browser lets sound play yet (it holds audio until a click or key press). */
  soundState: EngineState;
  /** Time of the last sound decision, so the toolbar can flash. */
  lastSound: number;
  /** Spot / perpetual / both filter on the enabled venues for the liquidity views. It never changes which venues are enabled. */
  scope: Scope;
  /** Enabled bar statistics in display order. */
  barStats: string[];
  /** Bar-stats options (imbalance thresholds, size buckets, units, cell style). */
  barStatOptions: StatOptions;
  /** Liquidity Tracker settings and which view of it the row draws. */
  lt: LtParams & { view: 'lines' | 'imbalance' };
  /** 'aggregated' draws every enabled venue; otherwise a single instrument id. */
  heatmapSource: string;
  disabledVenues: string[];
  /** Heatmap colouring: ramp style, one contrast slider (-100 to 100, 50 = percentile baseline; see heatmap/window.ts) and whether the baseline follows the data. */
  heat: { style: HeatStyleId; auto: boolean; contrast: number; smooth: 'auto' | 'off' };
  grouping: 'auto' | number;
  ladderMode: LadderMode;
  ladderShow: LadderShow;
  ladderVenue: string;
  /** Instrument ids that get their own book in Single mode (empty = every enabled venue). */
  ladderVenues: string[];
  theme: string;
  followLive: boolean;
  /** Keep the screen on while the page is open (a phone's screen sleeping stops the recording). */
  keepAwake: boolean;
  /** The clock the page's times are on: the computer's own, or UTC. */
  timeZone: TimeZone;
  /**
   * Shared cursor: `t` is authoritative; each pane converts it to its own x. `price` is only set by the heatmap. `touch` marks a hover
   * that a finger pinned (it stays until the next tap or drag, and its readouts sit above the finger).
   */
  hover: { t: number; price: number | null; y: number; source: 'heat' | 'depth' | 'oi' | 'lt' | 'bars' | 'cvd' | 'delta'; touch?: boolean } | null;
  /** The Range tool's selection (a box on the map, or a stretch of time), being dragged or made; and whether the next drag selects (range/). Not saved. */
  range: RangeSelection | null;
  rangeTool: boolean;
  /** The Traded feature's settings: its column's bars and markers, and the point-of-control lines on the chart (`show.traded` switches it). */
  traded: TradedSettings;
}

type Listener = (state: AppState, changed: ReadonlySet<keyof AppState>) => void;

const PERSISTED: (keyof AppState)[] = ['keepAwake', 'timeZone', 'timeframe', 'layer', 'show', 'cvd', 'heatmapSource', 'disabledVenues', 'scope', 'highlight', 'absorption', 'tradeBubbles', 'liquidations', 'keyLevels', 'vwap', 'footprint', 'delta', 'sounds', 'heat', 'lt', 'barStats', 'barStatOptions', 'grouping', 'ladderMode', 'ladderShow', 'ladderVenue', 'ladderVenues', 'theme', 'traded'];
function readSaved(): Partial<AppState> {
  try { const raw = window.localStorage.getItem('hlm-app-v2'); return raw ? JSON.parse(raw) as Partial<AppState> : {}; } catch { return {}; }
}

export function initialState(): AppState {
  const saved = readSaved();
  const state: AppState = {
    connected: false, status: t('connecting'), markets: [], marketId: '', seriesInstrument: '', mark: { price: 0, asOf: 0 }, levels: null,
    timeframe: '1h', layer: 'liquidity', layers: {}, candles: [], oi: [], oiInstrument: '',
    show: defaultShow(), cvd: { ...CVD_DEFAULTS }, highlight: { ...DEFAULT_HIGHLIGHT }, absorption: { ...ABSORPTION_DEFAULTS }, tradeBubbles: { ...BUBBLE_DEFAULTS }, liquidations: { ...LIQUIDATION_DEFAULTS }, keyLevels: readKeyLevels(KEY_LEVEL_DEFAULTS), vwap: readVwap(VWAP_DEFAULTS), vwapAnchoring: false, footprint: readFootprint(FOOTPRINT_DEFAULTS), delta: readDelta(DELTA_DEFAULTS), sounds: readSounds(DEFAULT_SOUNDS), soundState: 'locked', lastSound: 0, scope: 'all', lt: { ...LT_DEFAULTS, view: 'lines' }, barStats: [...DEFAULT_BAR_STATS], barStatOptions: { ...DEFAULT_STAT_OPTIONS }, heatmapSource: 'aggregated', disabledVenues: [],
    heat: { style: 'bookmap', auto: true, contrast: 50, smooth: 'auto' }, grouping: 'auto', ladderMode: 'aggregated', ladderShow: 'both', ladderVenue: '', ladderVenues: [],
    theme: 'light', followLive: true, keepAwake: false, timeZone: 'local', hover: null, range: null, rangeTool: false, traded: readTraded(undefined), ...saved,
  };
  // Saved objects may predate newer keys: keep the defaults for anything they lack.
  state.show = { ...defaultShow(), ...saved.show };
  // The volume profile (the traded column, now with its lines on the chart) is off unless chosen: a save from before it had settings of its
  // own holds the column's old default, not a choice.
  if (saved.traded === undefined) state.show.traded = false;
  state.cvd = readCvd(saved.cvd);
  state.sounds = readSounds(saved.sounds);
  state.highlight = readHighlight(saved.highlight);
  state.absorption = readAbsorption(saved.absorption);
  state.tradeBubbles = readBubbles(saved.tradeBubbles);
  state.liquidations = readLiquidations(saved.liquidations);
  state.keyLevels = readKeyLevels(saved.keyLevels);
  state.vwap = readVwap(saved.vwap);
  state.footprint = readFootprint(saved.footprint);
  state.delta = readDelta(saved.delta);
  state.traded = readTraded(saved.traded);
  state.scope = saved.scope === 'spot' || saved.scope === 'perp' ? saved.scope : 'all';
  state.timeZone = saved.timeZone === 'utc' ? 'utc' : 'local';
  state.heat = { style: 'bookmap', auto: true, contrast: 50, smooth: 'auto', ...saved.heat };
  state.heat.contrast = clampContrast(state.heat.contrast);
  state.lt = { ...LT_DEFAULTS, view: 'lines', ...saved.lt };
  state.theme = resolveThemeId(state.theme);
  // A layer saved before it was withdrawn would otherwise open on an empty chart.
  if (!AVAILABLE_LAYERS.includes(state.layer)) state.layer = 'liquidity';
  state.barStatOptions = { ...DEFAULT_STAT_OPTIONS, ...saved.barStatOptions };
  state.barStats = Array.isArray(saved.barStats) ? saved.barStats.filter((id): id is string => typeof id === 'string') : [...DEFAULT_BAR_STATS];
  return state;
}

/** Minimal observable store; listeners receive the set of keys changed in one microtask batch. */
export class Store {
  state: AppState;
  #listeners = new Set<Listener>();
  #pending = new Set<keyof AppState>();
  #scheduled = false;
  constructor(state: AppState) { this.state = state; }
  subscribe(listener: Listener): () => void { this.#listeners.add(listener); return () => this.#listeners.delete(listener); }
  set(patch: Partial<AppState>): void {
    for (const key of Object.keys(patch) as (keyof AppState)[]) { (this.state as unknown as Record<string, unknown>)[key] = patch[key]; this.#pending.add(key); }
    if (this.#scheduled) return;
    this.#scheduled = true;
    queueMicrotask(() => {
      this.#scheduled = false;
      const changed = this.#pending; this.#pending = new Set();
      for (const listener of this.#listeners) listener(this.state, changed);
      if ([...changed].some(key => PERSISTED.includes(key))) {
        try { window.localStorage.setItem('hlm-app-v2', JSON.stringify(Object.fromEntries(PERSISTED.map(key => [key, this.state[key]])))); } catch { /* storage unavailable */ }
      }
    });
  }
}
