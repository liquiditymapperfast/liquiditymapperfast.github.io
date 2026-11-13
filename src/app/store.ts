import type { LevelsFrame } from './wire.ts';
import type { OiPart } from './oi-change.ts';
import type { TimeZone } from './format.ts';
import { HEAT_STYLES, type HeatStyleId } from './heatmap/lut.ts';
import { clampContrast } from './heatmap/window.ts';
import { LT_DEFAULTS, LT_REV4_HALF_LIFE_BP, type LtParams } from './lt.ts';
import { PALETTES, resolveThemeId } from './theme.ts';
import { readStatOptions, type StatOptions } from './stat-options.ts';
import { readHighlight, type HighlightOptions } from './anomaly.ts';
import { DEFAULT_SOUNDS, readSounds, type SoundSettings } from './sound/rules.ts';
import { readCvd, type CvdSettings } from './cvd/settings.ts';
import { readAbsorption, type AbsorptionSettings } from './absorption.ts';
import { readBubbles, type BubbleSettings } from './prints.ts';
import { readLiquidations, type LiquidationSettings } from './liquidations.ts';
import { readKeyLevels, type KeyLevelSettings } from './keylevels/settings.ts';
import { readVwap, type VwapSettings } from './vwap/settings.ts';
import { readTpo, type TpoSettings } from './tpo/settings.ts';
import { readDrawSettings, type DrawSettings } from './draw/settings.ts';
import { readChartType, type ChartType } from './chart-type.ts';
import { readCandleColors, type CandleColors } from './candle-colours.ts';
import { readFootprint, type FootprintSettings } from './footprint/settings.ts';
import { readDelta, type DeltaSettings } from './delta/settings.ts';
import { isCoarse, isPhone } from './device.ts';
import { isHandheldPhone, readPhoneHistory, type PhoneHistory } from './history-window.ts';
import { readScriptBars } from './script/bars.ts';
import { LS_METRICS, type LsMetric } from '../shared/long-short.ts';
import { readCustomMarkets, readPicks, type CustomMarkets } from './market-choice.ts';
import { readBookMarkets, type BookMarkets } from './book-markets.ts';
import { readPullWindow, type PullWindow } from './panes/pull-stack.ts';
import { readLadderCues, type LadderCues } from './panes/ladder-cue-settings.ts';
import { LIQ_DEFAULT, readDepthSettings, type DepthSettings, type DepthSource } from './depth-settings.ts';
import type { EngineState } from './sound/engine.ts';
import type { RangeSelection } from './range/selection.ts';
import { hasTop, readTraded, topFromStrip, type TradedSettings } from './traded/settings.ts';
import { withTopOn } from './traded/profiles.ts';
import { t } from './i18n.ts';
import { readLiqLevels, type LiqLevelSettings } from './liq-url.ts';
import { WAVE_STRENGTH_DEFAULT, readWaveStrength } from './glass/waves.ts';
import type { ReplayView } from './replay/clock.ts';
import { isFundingVenue, type FundingVenue } from './funding.ts';
import { readFlowView, readTns, type FlowView, type TnsSettings } from './tns/model.ts';
import { readTrades, type TradesSettings } from './trades/settings.ts';

export type Layer = 'liquidity' | 'liquidation' | 'stopLoss' | 'takeProfit';
/**
 * Layers that can be chosen today. The others need a data source that is not connected yet; while only one can be chosen, the Layer menu stays
 * out of the bar and Settings (toolbar.ts `LAYER_CHOICE`, 2026-11-12).
 * Liquidation levels are not a layer: they are drawn over the heatmap from the Chart deck (`liqLevels`).
 */
export const AVAILABLE_LAYERS: readonly Layer[] = ['liquidity'];
export type LadderMode = 'aggregated' | 'single' | 'compact';
export type LadderShow = 'levels' | 'cumulative' | 'both';
/** Which kind of market the liquidity views draw: spot books, perpetual books, or every enabled venue. */
export type Scope = 'all' | 'spot' | 'perp';
export interface Market { id?: string; instrumentId?: string; venue?: string; base?: string; quote?: string; marketType?: string; tickSize?: number; symbol?: string }
/**
 * [start, open, high, low, close, volume, sourceRows, takerBuys, trades, quoteVolume, quoteBought]: the taker buys only on the candles read with
 * them, where the venue reports them, and the trades and quote volumes (Binance's) only beside them (shared/series.ts `Candle`).
 */
export type CandleRow = [number, number, number, number, number, number, number?, number?, number?, number?, number?];
/** [start, open, high, low, close] */
export type OiBar = [number, number, number, number, number];
export interface LayerLevel { id: string; side: string; price: number; notionalUsd: number; active?: boolean; amount?: number }

/**
 * Which panes are on the first time. No pane under the map is (Karl, 2026-10-17: depth and open interest were, and no extra pane should be):
 * each is one switch away. The flow column and the book beside the map are on.
 */
export const DEFAULT_SHOW: AppState['show'] = { profile: true, traded: false, depth: false, oi: false, delta: false, ls: false, funding: false, candles: true, footprint: false, stats: false, lt: false, mirror: true, volume: true, bubbles: true, cvd: true, book: true, script: true };
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
  /** Venues whose book has left the map, with the frame time (`asOf`) they were last on it, for `BOOK_HOLD_MS` (`cvd/ids.ts`). */
  bookGone: Readonly<Record<string, number>>;
  timeframe: string;
  layer: Layer;
  layers: Record<string, LayerLevel[]>;
  candles: CandleRow[];
  /**
   * The timeframe the candles were loaded for: after a change of timeframe the candles shown are those kept of the new one, or none, until
   * its read lands, but a change during the page's first read leaves the ones before standing; a reader that pairs them with other data of
   * the new timeframe waits for them. Absent until a first load: the chart's.
   */
  candlesTimeframe?: string;
  oi: OiBar[];
  /** Instrument the OI bars belong to (the market's own, or a reference perp when the market has no OI history); empty while venues are added together. */
  oiInstrument: string;
  /**
   * Whose open interest the OI pane, the bar statistics and NL/NS count: every perpetual of the ALL VENUES lines added together (the default)
   * or the chart market's own (a reference perpetual standing in where it has none).
   */
  oiMarkets: 'all' | 'chart' | 'custom';
  /** The markets picked for the footprint and for the open interest when their choice is 'custom' (market-choice.ts: exchanges and kinds, never ids). */
  customMarkets: CustomMarkets;
  /** Whose order books the Depth pane, the Liquidity Tracker and their sounds add up (book-markets.ts): the venues switched on, the chart market's, or `bookPicks`. */
  bookMarkets: BookMarkets;
  /** The books picked for `bookMarkets` 'custom': exchanges and kinds (`binance/perp`), as `customMarkets` keeps its picks, apart from them so a pick here never reloads open interest. */
  bookPicks: string[];
  /** Each venue's bars while they are added together (`oi` is then their sum, oi-change.ts `sumOi`); empty for one market. */
  oiParts: OiPart[];
  /** One market's `oi` from an inverse market: the one price its coins are put at (its USD over it, `Hub.oiSeries`); 0 for a linear market. */
  oiPrice: number;
  /** Another choice of markets than the one shown is being read and nothing it counts is held yet: the OI pane says so (`Hub.loadOi`). */
  oiReading: boolean;
  /**
   * The minute readings of the markets counted (`oi`/`oiParts`), each its own bars a minute apart where it was read that often, over the last
   * `fineSpanMs` (a day; on a server a week of Hyperliquid's while the Funding pane shows it; an inverse market's at the one price its bars on screen are at): NL/NS works a candle out minute by minute where they cover it
   * (delta/nlns.ts). Empty on a one-minute chart (the candle is the minute) and while nothing that uses NL/NS is shown (`Hub.loadOiFine`).
   */
  oiFine: OiPart[];
  /** How the OI pane's change bars are coloured: by who opened and closed (NL/NS, worked out minute by minute where it can be), or rises and falls. */
  oiChange: 'who' | 'net';
  /** The venue whose funding and premium the Funding pane shows (funding.ts); '' until one is picked: Hyperliquid where it lists the coin. */
  fundingVenue: FundingVenue | '';
  /** Whether the Funding, Open Interest, Long/Short, Liquidity Tracker and Delta panes draw their tables (panes/pane-table.ts; the Depth pane's is in its own settings). */
  fundingTable: boolean;
  oiTable: boolean;
  lsTable: boolean;
  ltTable: boolean;
  deltaTable: boolean;
  show: { profile: boolean; /** The traded-volume column beside the profile (not on phones). */ traded: boolean; depth: boolean; oi: boolean; /** The Delta pane under the map (taker delta and CVD by candle). */ delta: boolean; /** The Long/Short pane (the venues' published long/short account ratios). */ ls: boolean; /** The Funding pane: a venue's premium and funding, and on Hyperliquid who opened. */ funding: boolean; candles: boolean; footprint: boolean; /** The Bar stats table under the map (its own switch since 2026-10-20; it was the footprint's before). */ stats: boolean; lt: boolean; mirror: boolean; volume: boolean; bubbles: boolean; /** The taker-flow (CVD) column left of the map, and the order book column right of it. */ cvd: boolean; book: boolean; /** The Scripts pane under the map: a row for each of the person's scripts (script/). */ script: boolean };
  /** The CVD column's settings. */
  cvd: CvdSettings;
  /** What the flow column shows: the taker flow lines, or Time & sales (a phone always shows the flow). */
  flowView: FlowView;
  /** Time & sales: the smallest order listed, the side, and whether a burst on one exchange is one row (tns/model.ts). */
  tns: TnsSettings;
  /** All trades: the smallest order listed (0: any size), the side, and whether a burst is one row (trades/settings.ts). */
  trades: TradesSettings;
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
  /** Hyperliquid's liquidation prices drawn over the map and in the profile column (liq-levels.ts). */
  liqLevels: LiqLevelSettings;
  /** The VWAP lines: the session's, its bands and the anchored ones (vwap/). */
  vwap: VwapSettings;
  /** The TPO (Market Profile) drawn on the map (tpo/). */
  tpo: TpoSettings;
  /** The next click on the map places a VWAP anchor (not saved; arming the Range tool ends it). */
  vwapAnchoring: boolean;
  /** The Volume profile panel's Place anchor is armed: the next click on the map sets the columns' anchor (not saved). */
  profileAnchoring: boolean;
  /** The VWAP anchor being moved by the next click on the map (its id; null: the click adds one). Not saved. */
  anchorMove: string | null;
  /** Where an anchor being placed would go before it is placed: a tap on a touch screen, or the arrow keys (a candle's start). Not saved. */
  anchorPreview: number | null;
  /** How the drawing tools behave: the magnet, walls, keeping a tool, showing and locking (draw/settings.ts; the drawings are kept apart, draw/storage.ts). */
  draw: DrawSettings;
  /** How the map draws its price (chart-type.ts). */
  chartType: ChartType;
  /** The candles' own colours, rising and falling, body, border and wick; the theme's where none is chosen (candle-colours.ts). */
  candleColors: CandleColors;
  /** The footprint's own settings (whether it shows is `show.footprint`; its imbalance options are `barStatOptions`). */
  footprint: FootprintSettings;
  /** The Delta pane's settings: bars or CVD candles, where the CVD restarts, divergences. */
  delta: DeltaSettings;
  /** The Binance series the Long/Short pane shows: every account, its top traders' accounts or their positions (the other venues publish one each). */
  lsMetric: LsMetric;
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
  /** How many venue lines the Compact book draws over its running total (0: none; panes/ladder-curves.ts). */
  ladderCurves: LadderCurves;
  /** Replay (replay/clock.ts): what its controls show, null when live. Not saved: a page always opens live. */
  replay: ReplayView | null;
  /** The order book's pull/stack window in seconds (0: off). */
  pullStack: PullWindow;
  /** What lights in the order book when a venue's displayed depth changes, and the heat strip under each venue's part of a level (panes/ladder-cue-settings.ts). */
  ladderCues: LadderCues;
  /** The Depth pane's bands and how they are drawn (depth-settings.ts). */
  depthBands: DepthSettings;
  /** What the Depth pane adds up, and the Liquidation levels view's own bands. */
  depthSource: DepthSource;
  liqBands: DepthSettings;
  ladderVenue: string;
  /** Instrument ids that get their own book in Single mode (empty = every enabled venue). */
  ladderVenues: string[];
  theme: string;
  /** Which revision of the first-visit defaults the saved settings were written under (`DEFAULTS_REV`). */
  defaultsRev: number;
  /** Whether the theme was picked from the menu: a saved one that was not is the page's default of the time, not a choice (`initialState`). */
  themePicked: boolean;
  /** The light theme and the dark one that the phone bar's light-or-dark key switches between: the last of each kind shown (`themeChange`). */
  themeSlots: { light: string; dark: string };
  /** What the chrome around the chart is made of, in any theme: solid, or glass that the market's large orders light (glass/ui-glass.ts). */
  material: 'solid' | 'glass';
  /**
   * How strongly the waves are drawn, 0 (barely there) to 100 (the Waves panel's Strength; glass/waves.ts `strengthGain`), on top of the
   * field's own limit on how full a busy market may make it. The page's glass and the Tape's both.
   */
  waveStrength: number;
  followLive: boolean;
  /** Keep the screen on while the page is open (a phone's screen sleeping stops the recording). */
  keepAwake: boolean;
  /** The browser tab's title starts with the price, and its icon is the candle under way (tab-title.ts); kept in this browser, never in a layout. */
  tabPrice: boolean; tabIcon: boolean;
  /** How much recorded history a phone reads when the page opens (app/history-window.ts); read once, at the start. */
  phoneHistory: PhoneHistory;
  /** How many of the chart's candles scripts read (`script/bars.ts`): the person's own, not a layout's. */
  scriptBars: number;
  /**
   * The top bar folded away, the chart taking its room, as a browser's full screen does (a tablet's screen is short); a tab at the top
   * brings it back. Kept in this browser, never in a layout: it is about the screen, not about what the chart shows.
   */
  barCollapsed: boolean;
  /** The clock the page's times are on: the computer's own, or UTC. */
  timeZone: TimeZone;
  /**
   * Shared cursor: `t` is authoritative; each pane converts it to its own x. `price` is only set by the heatmap. `touch` marks a hover
   * that a finger pinned (it stays until the next tap or drag, and its readouts sit above the finger).
   */
  hover: { t: number; price: number | null; y: number; source: 'heat' | 'depth' | 'oi' | 'lt' | 'bars' | 'cvd' | 'tns' | 'trades' | 'delta' | 'ls' | 'funding' | 'script'; touch?: boolean } | null;
  /**
   * The order book's row under a mouse pointer (Karl, 2026-11-04): its prices from `lo` for one `step` (the book's grouping), and its side of
   * the price. The map and the flow column's price strip draw its price, as the panes under the map follow the map's pointer. Not saved.
   */
  bookHover: { lo: number; step: number; side: 'ask' | 'bid' } | null;
  /** The Range tool's selection (a box on the map, or a stretch of time), being dragged or made; and whether the next drag selects (range/). Not saved. */
  range: RangeSelection | null;
  rangeTool: boolean;
  /** The Traded feature's settings: its column's bars and markers, and the point-of-control lines on the chart (`show.traded` switches it). */
  traded: TradedSettings;
}

type Listener = (state: AppState, changed: ReadonlySet<keyof AppState>) => void;

const PERSISTED: (keyof AppState)[] = ['keepAwake', 'tabPrice', 'tabIcon', 'phoneHistory', 'scriptBars', 'barCollapsed', 'material', 'waveStrength', 'timeZone', 'timeframe', 'layer', 'show', 'cvd', 'flowView', 'tns', 'trades', 'heatmapSource', 'disabledVenues', 'scope', 'highlight', 'absorption', 'tradeBubbles', 'liquidations', 'keyLevels', 'liqLevels', 'vwap', 'tpo', 'footprint', 'delta', 'sounds', 'heat', 'lt', 'barStats', 'barStatOptions', 'grouping', 'ladderMode', 'ladderShow', 'ladderCurves', 'pullStack', 'ladderCues', 'depthBands', 'depthSource', 'liqBands', 'ladderVenue', 'ladderVenues', 'theme', 'themePicked', 'themeSlots', 'defaultsRev', 'traded', 'oiMarkets', 'oiChange', 'fundingVenue', 'fundingTable', 'oiTable', 'lsTable', 'ltTable', 'deltaTable', 'lsMetric', 'customMarkets', 'bookMarkets', 'bookPicks', 'draw', 'chartType', 'candleColors'];
function readSaved(): Partial<AppState> {
  try { const raw = window.localStorage.getItem('hlm-app-v2'); return raw ? JSON.parse(raw) as Partial<AppState> : {}; } catch { return {}; }
}

/** How many venue lines the Compact book may draw. */
export const LADDER_CURVES = [0, 3, 5, 8] as const;
export type LadderCurves = (typeof LADDER_CURVES)[number];

/** The settings a saved layout holds: what the chart shows and how, never the coin, the venues, the theme, the time zone or the sounds. */
export const LAYOUT_KEYS = ['timeframe', 'layer', 'show', 'cvd', 'flowView', 'tns', 'trades', 'scope', 'highlight', 'absorption', 'tradeBubbles', 'liquidations', 'keyLevels', 'liqLevels', 'vwap', 'tpo', 'footprint', 'delta',
  'heat', 'lt', 'barStats', 'barStatOptions', 'grouping', 'ladderMode', 'ladderShow', 'ladderCurves', 'pullStack', 'ladderCues', 'depthBands', 'depthSource', 'liqBands', 'traded', 'oiMarkets', 'oiChange', 'fundingVenue', 'fundingTable', 'oiTable', 'lsTable', 'ltTable', 'deltaTable', 'lsMetric', 'customMarkets', 'bookMarkets', 'bookPicks', 'chartType', 'candleColors'] as const satisfies readonly (keyof AppState)[];
export type Settings = Pick<AppState, (typeof LAYOUT_KEYS)[number]>;

/** The timeframes (hub.ts TIMEFRAMES; a test keeps the two the same). */
export const TIMEFRAME_IDS: readonly string[] = ['1m', '5m', '15m', '30m', '1h', '4h', '1d'];
const HEAT_DEFAULTS: AppState['heat'] = { style: 'size', auto: true, contrast: 50, smooth: 'auto' };

/** A flat settings object from storage or a file: each field the defaults have, kept when it has the default's type (a number must be finite). */
export function sameShape<T extends object>(defaults: T, raw: unknown): T {
  const out = { ...defaults } as Record<string, unknown>;
  if (raw && typeof raw === 'object') {
    for (const [key, fallback] of Object.entries(defaults)) {
      const value = (raw as Record<string, unknown>)[key];
      if (typeof value === typeof fallback && (typeof value !== 'number' || Number.isFinite(value))) out[key] = value;
    }
  }
  return out as T;
}

/**
 * The settings of a saved page or a saved layout, field by field: anything missing or not valid gets its default. A layouts file can come
 * from anywhere, so nothing reaches the state without passing here.
 */
export function readSettings(saved: Partial<Record<keyof AppState, unknown>>): Settings {
  const heat = sameShape(HEAT_DEFAULTS, saved.heat), lt = saved.lt as { view?: unknown } | undefined;
  // A save or a layout from when the profile along the top was the measure strip (`measureStrip`): the strip becomes the profile along the
  // top (`readTraded`), and where it showed, the Volume profile it now belongs to is switched on, or the strip would be gone.
  const strip = hasTop(saved.traded) ? null : topFromStrip((saved as Record<string, unknown>).measureStrip);
  const traded = readTraded(saved.traded, strip), show = sameShape(defaultShow(), saved.show);
  // The Bar stats table showed with the footprint until it had its own switch: a save or a layout from before keeps it where the footprint was on.
  const oldShow = saved.show as Record<string, unknown> | undefined;
  if (oldShow && typeof oldShow === 'object' && typeof oldShow.stats !== 'boolean') show.stats = oldShow.footprint === true;
  return {
    timeframe: typeof saved.timeframe === 'string' && TIMEFRAME_IDS.includes(saved.timeframe) ? saved.timeframe : '1h',
    // A layer saved before it was withdrawn would otherwise open on an empty chart.
    layer: AVAILABLE_LAYERS.includes(saved.layer as Layer) ? saved.layer as Layer : 'liquidity',
    show: strip?.on ? { ...show, traded: true } : show,
    cvd: readCvd(saved.cvd), flowView: readFlowView(saved.flowView), tns: readTns(saved.tns), trades: readTrades(saved.trades), highlight: readHighlight(saved.highlight), absorption: readAbsorption(saved.absorption), tradeBubbles: readBubbles(saved.tradeBubbles),
    liquidations: readLiquidations(saved.liquidations), keyLevels: readKeyLevels(saved.keyLevels), liqLevels: readLiqLevels(saved.liqLevels), vwap: readVwap(saved.vwap), tpo: readTpo(saved.tpo), footprint: readFootprint(saved.footprint),
    delta: readDelta(saved.delta), lsMetric: (LS_METRICS as readonly unknown[]).includes(saved.lsMetric) ? saved.lsMetric as LsMetric : 'accounts', pullStack: readPullWindow(saved.pullStack),
    ladderCues: readLadderCues(saved.ladderCues),
    depthBands: readDepthSettings(saved.depthBands),
    depthSource: saved.depthSource === 'liq' ? 'liq' : 'book',
    liqBands: readDepthSettings(saved.liqBands, LIQ_DEFAULT),
    traded,
    scope: saved.scope === 'spot' || saved.scope === 'perp' ? saved.scope : 'all',
    heat: { ...heat, style: HEAT_STYLES.some(style => style.id === heat.style) ? heat.style : 'size', smooth: heat.smooth === 'off' ? 'off' : 'auto', contrast: clampContrast(heat.contrast) },
    lt: { ...sameShape(LT_DEFAULTS, saved.lt), view: lt?.view === 'imbalance' ? 'imbalance' : 'lines' },
    // Bounded against a broken save, not below the statistics there are (38 since 2026-10-20: a cap of 24 lost the All preset's last 14 on reload).
    barStats: Array.isArray(saved.barStats) ? saved.barStats.filter((id): id is string => typeof id === 'string').slice(0, 64) : [...DEFAULT_BAR_STATS],
    barStatOptions: readStatOptions(saved.barStatOptions),
    grouping: saved.grouping === 'auto' || (typeof saved.grouping === 'number' && Number.isFinite(saved.grouping) && saved.grouping > 0) ? saved.grouping : 'auto',
    // Compact is the default since 2026-10-12 (Aggregated before): a page that saved Aggregated keeps it, since a choice and the old default look the same.
    ladderMode: saved.ladderMode === 'single' || saved.ladderMode === 'aggregated' ? saved.ladderMode : 'compact',
    ladderCurves: LADDER_CURVES.includes(saved.ladderCurves as LadderCurves) ? saved.ladderCurves as LadderCurves : 5,
    ladderShow: saved.ladderShow === 'levels' || saved.ladderShow === 'cumulative' ? saved.ladderShow : 'both',
    oiMarkets: saved.oiMarkets === 'chart' || saved.oiMarkets === 'custom' ? saved.oiMarkets : 'all',
    // New on 2026-11-07: no save holds a choice, so the bars by who opened show for every save (it needs no revision of the defaults).
    oiChange: saved.oiChange === 'net' ? 'net' : 'who',
    fundingVenue: isFundingVenue(saved.fundingVenue) ? saved.fundingVenue : '',
    // New on 2026-11-08: no save holds a choice, so they show for every save, as the Depth pane's does (no revision of the defaults).
    fundingTable: saved.fundingTable !== false,
    oiTable: saved.oiTable !== false,
    lsTable: saved.lsTable !== false,
    // New on 2026-11-13, shown for every save in the same way.
    ltTable: saved.ltTable !== false,
    deltaTable: saved.deltaTable !== false,
    customMarkets: readCustomMarkets(saved.customMarkets),
    // New on 2026-11-13: no save holds a choice, so every save counts the venues switched on, as before.
    bookMarkets: readBookMarkets(saved.bookMarkets),
    bookPicks: readPicks(saved.bookPicks, false),
    chartType: readChartType(saved.chartType),
    candleColors: readCandleColors(saved.candleColors),
  };
}

/** The theme a page opens in, on a desktop, and on a phone set to light. */
export const DEFAULT_THEME = 'light';
/** The theme a phone set to dark opens in, and the dark one its light-or-dark key brings first (Karl, 2026-11-01). */
export const PHONE_DARK_THEME = 'terminal';
/**
 * The theme a page shows until one is picked: Light on a desktop; on a phone, the phone's own light or dark setting, dark being Terminal (Karl,
 * 2026-11-01: "make the terminal theme the default for mobile ... according to whether the user has his mobile device set on dark theme or
 * light theme"). Followed live while nothing is picked (main.ts).
 */
export function autoTheme(phone: boolean, dark: boolean): string { return phone && dark ? PHONE_DARK_THEME : DEFAULT_THEME; }
/** Whether the device asks pages to be dark. */
export const prefersDark = (): boolean => typeof matchMedia === 'function' && matchMedia('(prefers-color-scheme: dark)').matches;
/** The change that shows theme `id`, picked or not; it is remembered as the theme of its kind, for the light-or-dark key. */
export function themeChange(state: Pick<AppState, 'themeSlots'>, id: string, picked: boolean): Pick<AppState, 'theme' | 'themePicked' | 'themeSlots'> {
  return { theme: id, themePicked: picked, themeSlots: { ...state.themeSlots, [PALETTES[id]?.dark ? 'dark' : 'light']: id } };
}
/** The theme the light-or-dark key brings: the one of the other kind last shown. */
export function flippedTheme(state: Pick<AppState, 'theme' | 'themeSlots'>): string { return PALETTES[state.theme]?.dark ? state.themeSlots.light : state.themeSlots.dark; }
/** A remembered theme of the given kind, or null for a name that is not one (or not of that kind). */
function slotTheme(v: unknown, dark: boolean): string | null {
  if (typeof v !== 'string') return null;
  const id = resolveThemeId(v);
  return PALETTES[id]?.dark === dark ? id : null;
}
/**
 * The revision of the first-visit defaults. The page saves its whole settings on any change, so a default is written down whether chosen
 * or not; when a default changes, a save from before it (an older or no revision) would keep the old one for ever. Revision 1: Depth and
 * Open interest start off. A save of that kind holding both on, the old default, has them turned off once; one that holds only one of
 * them on was a choice and is left. Revision 2 (2026-10-20): what was new that day shows, as Karl asked ("the UI needs to show the new"):
 * the volume profile's days are drawn on the chart, their lines and their profiles, where a save holds no period and no profile (never
 * chosen: the choice came that day), and the measure strip along the top of the map is on (on a desktop: a phone has no room for it).
 * Revision 3 (2026-10-20): the measure strip became the volume profile turned onto the time axis, set in the Volume profile's panel and
 * switched with it (Karl: "why not do basically exactly a clone of the profile, but at the top of the chart"). A save's strip is read into
 * the profile along the top by `readSettings` (saved layouts too; traded/profiles.ts since): its switch as it was, Delta as traded volume, OI change as open interest, and the
 * Volume profile switched on where the strip showed, or the strip would be gone. A save from before revision 2, and a first visit, had the
 * strip on (on a desktop): they get the profile along the top, and with it the Volume profile.
 * Revision 4 (2026-10-26, Karl: the phone's tab bar and "the liquidity tracker is very useful ... set it to 100 basis points by default", then
 * "set desktop to the same 100 bp as well"): the Liquidity Tracker's half-life is 100 bp on every screen, and on a phone the Flow and LT tabs are
 * always there at first. A save from before it held a half-life of 10 bp, the old default that every save wrote down: it read as 100 once
 * (any other, and any chosen since, was kept; revision 5 has 10 again). A touch screen's save from before it also has the Flow and LT panes on once (the tab bar hides
 * a tab whose pane is off, and a Flow saved off was never found again); a desktop, and a desktop window that happens to be narrow, keeps its panes.
 * No revision for 2026-10-28 (Karl: the daily profile off by default, and the profile along the top): a first visit draws the days' lines
 * without their profiles and the Volume profile's column without the band along the top, and a save from before revision 2 has no
 * profiles either; a save since holds both as it saved them, as Scripts switched on by default left a saved off.
 * Revision 5 (2026-11-03, Karl: "set the liquidity tracker to 10bp as default, it is currently 100bp"): the half-life is 10 bp again on every
 * screen. A save of revision 4 holding 100 bp, its default that every save wrote down, reads as 10 once; a revision-4 save whose owner chose
 * 100 cannot be told apart and reads 10 too, once. Any other half-life is kept, and so is a 100 in an older save (10 was the default then,
 * so 100 was a choice) or in a save of revision 5.
 */
export const DEFAULTS_REV = 5;

export function initialState(phone: boolean = isPhone(), touch: boolean = isCoarse()): AppState {
  const saved = readSaved();
  const state: AppState = {
    connected: false, status: t('connecting'), markets: [], marketId: '', seriesInstrument: '', mark: { price: 0, asOf: 0 }, levels: null, bookGone: {},
    layers: {}, candles: [], oi: [], oiInstrument: '', oiParts: [], oiPrice: 0, oiReading: false, oiFine: [], sounds: { ...DEFAULT_SOUNDS }, soundState: 'locked', lastSound: 0, vwapAnchoring: false, anchorMove: null, anchorPreview: null, profileAnchoring: false, heatmapSource: 'aggregated', disabledVenues: [],
    ladderVenue: '', ladderVenues: [], replay: null, draw: readDrawSettings(undefined), theme: DEFAULT_THEME, themePicked: false, themeSlots: { light: DEFAULT_THEME, dark: PHONE_DARK_THEME }, defaultsRev: DEFAULTS_REV, material: 'solid', waveStrength: WAVE_STRENGTH_DEFAULT, followLive: true, keepAwake: false, tabPrice: true, tabIcon: true, phoneHistory: 'auto', scriptBars: readScriptBars(undefined, false), barCollapsed: false, timeZone: 'local', hover: null, bookHover: null, range: null, rangeTool: false,
    ...saved, ...readSettings(saved),
  };
  // A save's measure strip was read into the profile along the top (`readSettings`): it is no setting of its own any more.
  delete (state as unknown as Record<string, unknown>).measureStrip;
  // The volume profile (the traded column, now with its lines on the chart) is off unless chosen: a save from before it had settings of its
  // own holds the column's old default, not a choice. (A page's save only: a saved layout always carries its own.) A measure strip that
  // showed is the exception: `readSettings` switched the Volume profile on for it, the profile along the top being part of it now.
  if (saved.traded === undefined && topFromStrip((saved as Record<string, unknown>).measureStrip)?.on !== true) state.show.traded = false;
  state.sounds = readSounds(saved.sounds);
  state.draw = readDrawSettings(saved.draw);
  state.timeZone = saved.timeZone === 'utc' ? 'utc' : 'local';
  // Every save writes the theme down whether chosen or not (Terminal for a day on 2026-10-17): one that was not picked from the menu or the
  // light-or-dark key is the page's default of its time, and the theme follows `autoTheme` below; the saves since carry the pick.
  state.themePicked = saved.themePicked === true;
  const slots = saved.themeSlots as { light?: unknown; dark?: unknown } | undefined;
  state.themeSlots = { light: slotTheme(slots?.light, false) ?? DEFAULT_THEME, dark: slotTheme(slots?.dark, true) ?? PHONE_DARK_THEME };
  const rev = typeof saved.defaultsRev === 'number' ? saved.defaultsRev : 0;
  if (rev < 1 && state.show.depth && state.show.oi) state.show = { ...state.show, depth: false, oi: false };
  if (rev < 2) {
    // The days' lines, as a first visit has them; their profiles are off by default since 2026-10-28, so a save this old gets none.
    if (!state.traded.lines.length && state.traded.profiles === null) state.traded = { ...state.traded, lines: ['day'] };
    // The strip revision 2 turned on is the profile along the top now, which shows with the Volume profile. A first visit gets the Volume
    // profile with its column and no band (off by default since 2026-10-28); a save this old gets the band it was given then.
    if (!phone) {
      if (Object.keys(saved).length) state.traded = { ...state.traded, placements: withTopOn(state.traded.placements) };
      // Not on a touch screen's first visit, as not on a phone's (Karl, 2026-11-03: the volume profile is not on by default on any mobile).
      if (!touch || Object.keys(saved).length) state.show = { ...state.show, traded: true };
    }
  }
  // The panes: a touch screen only (a desktop browser window that was narrow once is not a phone, and its panes stay as it chose them).
  // LT was turned on here too while it had a tab; it has none since 2026-11-01 and, switched on, sits under the map (2026-11-03): it is
  // something to switch on (Karl), so neither a first visit nor an old save has it turned on, nor a tablet that has the phone's arrangement
  // since 2026-11-03 (Sol).
  if (rev < 4 && phone && touch) state.show = { ...state.show, cvd: true };
  // The half-life: every screen. Revision 4's default is not a choice (every save of it wrote it down); another value is.
  if (rev === 4 && state.lt.halfLifeBp === LT_REV4_HALF_LIFE_BP) state.lt = { ...state.lt, halfLifeBp: LT_DEFAULTS.halfLifeBp };
  state.defaultsRev = DEFAULTS_REV;
  const savedTheme = resolveThemeId(state.theme);
  // A theme saved without the flag is a default of its time when it is Light or Terminal; any other was picked before the flag existed (it came
  // on 2026-10-17), so it counts as picked, and the device's setting never replaces it.
  if (!state.themePicked && typeof saved.theme === 'string' && savedTheme !== DEFAULT_THEME && savedTheme !== PHONE_DARK_THEME) state.themePicked = true;
  state.theme = state.themePicked ? savedTheme : autoTheme(phone && touch, prefersDark());
  state.themeSlots = { ...state.themeSlots, [PALETTES[state.theme]?.dark ? 'dark' : 'light']: state.theme };
  state.material = saved.material === 'glass' ? 'glass' : 'solid';
  // New on 2026-11-06, so no save holds a strength that was not chosen: it needs no revision of the defaults.
  state.waveStrength = readWaveStrength(saved.waveStrength);
  state.barCollapsed = saved.barCollapsed === true;
  // New on 2026-11-07, both on: a save from before holds neither, so no revision of the defaults is needed.
  state.tabPrice = saved.tabPrice !== false; state.tabIcon = saved.tabIcon !== false;
  state.phoneHistory = readPhoneHistory(saved.phoneHistory);
  state.scriptBars = readScriptBars(saved.scriptBars, typeof window !== 'undefined' && isHandheldPhone());
  state.replay = null;
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
