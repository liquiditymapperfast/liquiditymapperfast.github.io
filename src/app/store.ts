import type { LevelsFrame } from './wire.ts';
import type { HeatStyleId } from './heatmap/lut.ts';
import { clampContrast } from './heatmap/window.ts';
import { LT_DEFAULTS, type LtParams } from './lt.ts';
import { resolveThemeId } from './theme.ts';
import { DEFAULT_STAT_OPTIONS, type StatOptions } from './stat-options.ts';
import { DEFAULT_HIGHLIGHT, readHighlight, type HighlightOptions } from './anomaly.ts';
import { DEFAULT_SOUNDS, readSounds, type SoundSettings } from './sound/rules.ts';
import type { EngineState } from './sound/engine.ts';
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
  show: { profile: boolean; depth: boolean; oi: boolean; candles: boolean; footprint: boolean; lt: boolean; mirror: boolean; volume: boolean; bubbles: boolean };
  /** What counts as standing out (anomalous volume, OI change, ...), shared by every pane. */
  highlight: HighlightOptions;
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
  /**
   * Shared cursor: `t` is authoritative; each pane converts it to its own x. `price` is only set by the heatmap. `touch` marks a hover
   * that a finger pinned (it stays until the next tap or drag, and its readouts sit above the finger).
   */
  hover: { t: number; price: number | null; y: number; source: 'heat' | 'depth' | 'oi' | 'lt' | 'bars'; touch?: boolean } | null;
}

type Listener = (state: AppState, changed: ReadonlySet<keyof AppState>) => void;

const PERSISTED: (keyof AppState)[] = ['keepAwake', 'timeframe', 'layer', 'show', 'heatmapSource', 'disabledVenues', 'scope', 'highlight', 'sounds', 'heat', 'lt', 'barStats', 'barStatOptions', 'grouping', 'ladderMode', 'ladderShow', 'ladderVenue', 'ladderVenues', 'theme'];
function readSaved(): Partial<AppState> {
  try { const raw = window.localStorage.getItem('hlm-app-v2'); return raw ? JSON.parse(raw) as Partial<AppState> : {}; } catch { return {}; }
}

export function initialState(): AppState {
  const saved = readSaved();
  const state: AppState = {
    connected: false, status: t('connecting'), markets: [], marketId: '', seriesInstrument: '', mark: { price: 0, asOf: 0 }, levels: null,
    timeframe: '1h', layer: 'liquidity', layers: {}, candles: [], oi: [], oiInstrument: '',
    show: { profile: true, depth: true, oi: true, candles: true, footprint: false, lt: false, mirror: true, volume: true, bubbles: true }, highlight: { ...DEFAULT_HIGHLIGHT }, sounds: readSounds(DEFAULT_SOUNDS), soundState: 'locked', lastSound: 0, scope: 'all', lt: { ...LT_DEFAULTS, view: 'lines' }, barStats: [...DEFAULT_BAR_STATS], barStatOptions: { ...DEFAULT_STAT_OPTIONS }, heatmapSource: 'aggregated', disabledVenues: [],
    heat: { style: 'bookmap', auto: true, contrast: 50, smooth: 'auto' }, grouping: 'auto', ladderMode: 'aggregated', ladderShow: 'both', ladderVenue: '', ladderVenues: [],
    theme: 'light', followLive: true, keepAwake: false, hover: null, ...saved,
  };
  // Saved objects may predate newer keys: keep the defaults for anything they lack.
  state.show = { profile: true, depth: true, oi: true, candles: true, footprint: false, lt: false, mirror: true, volume: true, bubbles: true, ...saved.show };
  state.sounds = readSounds(saved.sounds);
  state.highlight = readHighlight(saved.highlight);
  state.scope = saved.scope === 'spot' || saved.scope === 'perp' ? saved.scope : 'all';
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
