import { HeatGL, type HeatStyle } from '../heatmap/gl.ts';
import { buildLut } from '../heatmap/lut.ts';
import { colourWindow, nextBaseline, type Baseline } from '../heatmap/window.ts';
import { isCoarse, isPhone } from '../device.ts';
import { dimOutside, mirrorLines, mirrorStats, paintBand, paintMirrorBox, percentText, type MirrorLine, type MirrorStats } from '../mirror.ts';
import { PROFILE_CANDLES_BACK_MS, TIMEFRAMES, askedSpan, valueAreaKey, windowProfileKey, type Hub, type RasterResult } from '../hub.ts';
import { ensureDeltaFlow } from '../delta/flows.ts';
import { StripHighlightMemo, coarseCandles, joinRows, paintVolumeStrip, stripBars, stripHistoryFrom, stripLines, stripTimeframe, withEarlier, type StripBar } from '../measures/volume-strip.ts';
import { StripOrderCache, WHOLE_RANGE_STEP, stripOrdersOf } from '../measures/strip-orders.ts';
import { gridStepFor } from '../../shared/grid.ts';
import { MAX_PROFILE_INSTRUMENTS, type ProfileAnswer } from '../../shared/footprint.ts';
import type { ValueLevels } from '../../shared/profile.ts';
import { DRAWN_SHARE, answerLevels, candleAnswer, candleBarMs, candleLevels, gatedCarries, linesWindows, loadedColumnWanted, mergeCandleProfiles, periodWindows, recordedWindowLevels, recordedWindows, recordingStart, requestStep, touchedAt, windowKind, windowLabel, windowZone } from '../traded/levels.ts';
import { LABEL_FLOOR, ageAlpha, ageRanks, carriedLines, runPieces, type CarriedLine, type Carry } from '../traded/carry.ts';
import { LabelBoard } from '../labels.ts';
import type { ProfileWindow, SessionDef } from '../traded/sessions.ts';
import type { Kernels } from '../kernels.ts';
import { PALETTES, rgb, textOn, type Palette } from '../theme.ts';
import { View, niceStep, type Bounds } from '../view.ts';
import { clock, price as fmtPrice, startOfDay, usd, zoneName } from '../format.ts';
import { timeAxis } from '../time-axis.ts';
export { timeTicks } from '../time-axis.ts';
import type { Store, AppState, CandleRow } from '../store.ts';
import { cumulative, groupLevels, type Grouped } from './levels-data.ts';
import { activeIds, emptyScopeMessage, heatmapSourceOf, kindOf, type Kind } from '../scope.ts';
import { venueOfInstrument } from '../cvd/families.ts';
import { fitText } from '../text-fit.ts';
import { distanceText } from './ladder-info.ts';
import { binsPerRow, dollarPriceOf, liqProfile, seamStats, liqRows, paintLiqStripe, standingBelow, standingHeat, type LiqLevels, type LiqRow, type LiqStanding } from '../liq-levels.ts';
import { bubbleHidden, bubbleRadius, printPriceLines, topPrints, type Print } from '../prints.ts';
import { periodRowLines, tradedFigures, tradedLines, tradedNet, tradedNetLine, tradedRowAt, tradedRows, type TradedRows } from '../traded.ts';
import { MEASURES, measureDef, metricWords, type ProfileMetric } from '../measures/registry.ts';
import { lineMetric, onPriceAxis, placedOn } from '../traded/profiles.ts';
import { MAX_BANDS, arrangeProfiles, arrangeSides, columnHit, type Arranged, type ProfileRoom } from '../traded/arrange.ts';
import { flowIds, flowLoadIds, mapVenues } from '../cvd/ids.ts';
import { aggregateIds } from '../cvd/model.ts';
import { resolvePicks } from '../market-choice.ts';
import { iconsOf, markLines, markSize, type AbsorptionMark, type MarkIcon } from '../absorption.ts';
import { diamondRadius, liquidationHidden, liquidationLines, type Liquidation } from '../liquidations.ts';
import { venueLabel } from '../venues.ts';
import { describeSources } from '../cell-sources.ts';
import { anomalies, type Anomalies } from '../anomaly.ts';
import { paintWatermark } from '../watermark.ts';
import { FOOTPRINT_SETTLE_MS, FootprintData, FootprintLod, VENUE_LINES, candleBody, footprintLayout, paintFootprint, readBar, rowCellAt, rowCellLines, visibilityFactor, type Bar as FootprintBar, type LodFrame, type RowCell } from './footprint.ts';
import { layoutInfo, paintInfoBox, type InfoColor, type InfoLine } from '../infobox.ts';
import { TrapData, trapStatusText, trapText, type Trap } from '../traps.ts';
import { GestureRecognizer, axisPinchScale, bindTouch, type GestureHandlers, type PinchInfo, type Pt } from '../touch.ts';
import { PRICE_SPAN_SHARE, TIME_SPAN_MS, holdPixel, limitFactor, priceRef, regionAt, wheelZoom } from './heat-zoom.ts';
import { t, tn } from '../i18n.ts';
import { currentCoin, scaledUsd } from '../coin.ts';
import { liqLevelsUrl } from '../liq-url.ts';
import { linesToAsk } from '../sizes.ts';
import { MAX_COUNT, chartKinds, linesCount, linesSource, resolveZone, type LineKind, type TradedSettings } from '../traded/settings.ts';
import { dayStartOf } from './bar-stats.ts';
import { answerMedian, emphasisFloor, medianRow, splitStyles } from '../traded/emphasis.ts';
import { BROWSER_RETENTION_MS, RETENTION_MS } from '../../shared/recorder.ts';
import { MAX_BACK_MS, barMsFor, keyLines, neededFrom, type KeyLine } from '../keylevels/levels.ts';
import { anyLine } from '../keylevels/settings.ts';
import { historyTarget, profileCompanion, profileTarget, type HistoryTarget } from '../keylevels/history.ts';
import { TakerRows } from '../measures/taker-rows.ts';
import { paintKeyLevels, paintKeyTags, periodDate, placeKeyTags, underTag, type KeyTag } from '../keylevels/paint.ts';
import { sessionsOf, vwapBarMs, vwapSeries, whaleSeries } from '../vwap/vwap.ts';
import { anchorsOf } from '../vwap/settings.ts';
import { FootprintMarks } from '../footprint/marks.ts';
import { FootprintRuns, paintRuns } from '../footprint/runs.ts';
import { paintVwap, type VwapLine } from '../vwap/paint.ts';
import { DRAG_MIN_PX, selects } from '../range/selection.ts';
import { drawVenueMark } from '../venue-marks.ts';
import { draftLabel } from '../range/stats.ts';
import type { RangePoint, RangeTool } from '../range/tool.ts';
import { paintDivergence, type Divergence } from '../delta/divergence.ts';
import { TopBands, topMarks, type TopProfile } from '../measures/strip.ts';
import { BAND_GAP, flowRows, volumeBand, type TimeRows } from '../measures/model.ts';
import { CANDLE_LINE_PX, LINE_POINT_PX, countdown, lineSide, thinLine, type LinePoint } from '../price-line.ts';
import { candlesAt, formingCandle, pageNow, replaying, replayView } from '../replay/clock.ts';
import { TapeGL, type DustStyle } from '../tape/gl.ts';
import { TraceIndex, gapMarks, secondsPath, traceGapColumns } from '../tape/trace.ts';
import { curveColors } from './ladder-curves.ts';
import { priceInstrument, priceTarget, type PriceHistoryAnswer, type PriceTarget } from '../../shared/price-history.ts';
import type { DrawController } from '../draw/controller.ts';
import { paintDrawings, paintEditing } from '../draw/paint.ts';
import type { Projection } from '../draw/geometry.ts';
import { wallRows, type CandleUnder } from '../draw/magnet.ts';
import type { ChartType } from '../chart-type.ts';
import { candleCoverage, candlePriceRange, isCovered, priceBounds, priceOverviewNeeded, pricePointAt, pricePoints, priceWindow, uncoveredRuns, type Covered, type PricePoint, type PriceWindow } from '../price-history.ts';

/** The colour of a flag on a candle's wick: amber reads on every theme and is neither side's colour. */
const TRAP_COLOR = '#f5a524';
/** The amber a profile with no room is said in, as a column's header says a cut record. */
const HIDDEN_COLOR = '#e6a700';

/** Glows around whale bubbles, by colour, radius (whole px) and pixel ratio. */
const glows = new Map<string, { image: HTMLCanvasElement; half: number }>();
/**
 * The soft glow around a whale's bubble: the shadow a 1.8 px ring of radius `r` casts with a 10 px blur, drawn once for each colour and
 * size and copied after that. A blurred shadow on every whale bubble on every frame was most of what the map cost the graphics card
 * zoomed out, where nearly every bubble shown is a whale.
 */
function glowOf(color: string, r: number, dpr: number): { image: HTMLCanvasElement; half: number } {
  const radius = Math.max(1, Math.round(r)), key = `${color}|${radius}|${dpr}`;
  let glow = glows.get(key);
  if (glow) return glow;
  if (glows.size > 160) glows.clear();
  // The blur reaches about three times its sigma (half the blur, in device pixels) past the ring.
  const half = Math.ceil(radius + 2 + 16 / dpr), image = document.createElement('canvas'), g = image.getContext('2d')!;
  image.width = image.height = Math.ceil(half * 2 * dpr);
  // The ring is drawn off the canvas and its shadow, offset back into the middle, is all that lands (shadows ignore the transform).
  const away = 4 * half;
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.shadowColor = color; g.shadowBlur = 10; g.shadowOffsetX = away * dpr;
  g.lineWidth = 1.8; g.strokeStyle = '#000'; g.beginPath(); g.arc(half - away, half, radius, 0, Math.PI * 2); g.stroke();
  glow = { image, half }; glows.set(key, glow);
  return glow;
}
/**
 * How long, at least, the column's estimate from the candles stands while its window or its rows move (a drag, a zoom, the price scale):
 * working it out is a pass over every bar of the window spread over the rows each covers, 24 ms at $20 rows, 93 ms at $5, 228 ms at $2 and
 * 1.1 s at $0.50 (BTC, 21 weeks of 5-minute bars, perpetual and spot; measured in review, 2026-10-24). It stands four times as long as the
 * last one took, so a drag spends a fifth of its time on it at most.
 */
const LOADED_COLUMN_MS = 250;
/** How far behind a window that has ended the candles known may be for the column's estimate still to stand (the history asks for its newest bars every minute). */
const LOADED_LAG_MS = 10 * 60_000;
/** Replay: each VWAP line up to the last bar that ended by its moment (so its tag is the VWAP then); live, the lines as they are. */
function replayCut(lines: VwapLine[], at: number): VwapLine[] {
  if (!replaying()) return lines;
  // A history bar's point counts once the bar is over; the chart's own candles (from `liveFrom`) and the whale lines are cut to the moment already.
  return lines.map(l => l.bar === undefined ? l : { ...l, points: l.points.filter(q => q.t >= (l.liveFrom ?? Infinity) || q.t + l.bar! <= at) });
}

/** Width of the price axis, the profile column and the traded-volume column. A phone gives them less (and no traded column), so the map keeps most of the screen (see `setCompactGutters`). */
export let AXIS_W = 64;
/** The countdown box under the price tag. */
const COUNTDOWN_H = 15;
export let PROFILE_W = 128;
export let TRADED_W = 96;
/** What a column's pointer opens beside it: a row's box at its height, or the header's box for the whole window, opening downward. */
/** The letter a line's tag on the price axis carries when several kinds are drawn, as the key levels' D, W and M. */
const KIND_CODE: Record<LineKind | 'view', string> = { view: '', day: 'D', week: 'W', month: 'M', sessions: 'S' };
/** The previous period's levels carried across the one under way: a long dash (the value area's own is [6, 4], an untouched run's dots), faint lines and clearer names. */
const CARRY_DASH = [12, 5], CARRY_LINE_ALPHA = 0.6;
const CARRY_WORDS = { poc: t('POC'), vah: t('VAH'), val: t('VAL') } as const;
type ColumnBox = { lines: InfoLine[]; y: number; placement?: 'center' | 'down' };
/** A period profile drawn on the chart, for the pointer: where it begins, its rows and scale, and what its box says of it. */
type ProfileHit = { x0: number; room: number; row: number; max: number; rows: Map<number, [number, number]>; total: number; split: boolean; name: string; levels: ValueLevels; source: string | null };
/** The row of a period profile under the pointer. */
type ProfileRowHit = { hit: ProfileHit; k: number; buy: number; sell: number };
/** The width the price labels need for the coin on screen: BTC's fit the usual width, a coin priced in millionths needs about eleven characters. */
function axisNeed(): number {
  const price = currentCoin().price;
  return price > 0 && price < 1 ? Math.ceil((Math.ceil(-Math.log10(price * 0.0005)) + 2) * 6.5 + 12) : 0;
}
/**
 * How many volume profile columns fit beside the map, right and left of it together: as many as leave it half the pane (the price axis and
 * the profile counted), one at least.
 */
let COLUMNS_FIT = Infinity;
/** Whether the map is compact (a phone's), its columns narrowed (`setCompactGutters`). */
let COMPACT = false;
/**
 * The book profile of a compact map that also shows the liquidation column: a strip whose rows hold the book's depth as the strength of their
 * side's colour (Karl, 2026-11-01: on a phone the two columns left the map too little room, and the liquidation levels are the more useful).
 */
export const PROFILE_STRIP_W = 16;
export function setCompactGutters(compact: boolean, paneW = Infinity): void {
  COMPACT = compact;
  AXIS_W = Math.max(compact ? 58 : 64, axisNeed()); PROFILE_W = compact ? 84 : 128; TRADED_W = compact ? 0 : 96;
  COLUMNS_FIT = TRADED_W > 0 ? Math.max(1, Math.floor((paneW / 2 - AXIS_W - PROFILE_W) / TRADED_W)) : 0;
}
/** Whether the volume profile columns can be drawn: switched on, and the map is wide enough to have them (a phone has none). */
export const tradedShown = (state: AppState): boolean => state.show.traded && TRADED_W > 0;
const NO_SIDES: ReturnType<typeof arrangeSides> = { right: [], left: [], hidden: [] };
let sidesMemo: { set: object; fit: number; sides: ReturnType<typeof arrangeSides> } | null = null;
/**
 * The columns drawn right and left of the map, nearest the map first, as many as fit (`COLUMNS_FIT`, both sides together), and those
 * switched on with no room (traded/arrange.ts); none while the Volume profile is off. Worked out again only when the places or the room change.
 */
export function sideColumns(state: AppState): ReturnType<typeof arrangeSides> {
  if (!state.show.traded) return NO_SIDES;
  const set = state.traded.placements, fit = TRADED_W > 0 ? COLUMNS_FIT : 0;
  if (sidesMemo?.set !== set || sidesMemo.fit !== fit) sidesMemo = { set, fit, sides: arrangeSides(set, fit) };
  return sidesMemo.sides;
}
const TIME_H = 22;

/** A plot narrower than this (a phone, a split screen) gets the compact legend, whole-dollar prices and a shorter history note. */
const NARROW_PLOT = 420;
/** The legend's script lines: how many at most (the others are counted), and the room each of a line's buttons takes (px), on a phone too. */
const SCRIPT_LINES = 6, SCRIPT_TOOL_W = 20, SCRIPT_TOOL_W_TOUCH = 28;

/** A line of the map's legend for a script drawn on the map (given by the Scripts pane): its name, colour, values or state, and how many buttons it has. */
export interface ScriptLegendLine { id: string; name: string; color: string; text: string; tone: 'text' | 'muted' | 'error'; tools: number }
/** A map pane narrower than this gets the narrow price axis and profile column. */
const COMPACT_PANE = 520;

/** Whether the liquidation column stands between the map and the profile column: Liquidation levels and their column on, BTC, an address. */
export const liqColumnShown = (state: AppState): boolean => { const l = state.liqLevels as AppState['liqLevels'] | undefined; return !!l && l.on && l.column && currentCoin().coin === 'BTC' && !!liqLevelsUrl(); };
/**
 * The width the liquidation column takes (as wide as the profile column), or 0. A compact map has it as a strip like the book's (Karl,
 * 2026-11-03: the column took a phone's map 84 px; the Liq tab holds the whole ladder): the two strips beside each other.
 */
const liqColumnW = (state: AppState): number => !liqColumnShown(state) ? 0 : COMPACT ? PROFILE_STRIP_W : PROFILE_W;
/** The width the book profile takes: its column, the strip in a compact map beside the liquidation column (`PROFILE_STRIP_W`), or 0. */
export function profileColumnW(state: AppState): number { return !state.show.profile ? 0 : COMPACT && liqColumnShown(state) ? PROFILE_STRIP_W : PROFILE_W; }
export function gutter(state: AppState): number { return AXIS_W + liqColumnW(state) + profileColumnW(state) + sideColumns(state).right.length * TRADED_W; }
/** The width the columns left of the map take, between the flow column and the map: the map and the panes under it start after them. */
export function leftGutter(state: AppState): number { return sideColumns(state).left.length * TRADED_W; }
/**
 * The side of the book the map's hover names at a cell: the one holding more there, or none for a cell that holds nothing (right of the
 * live edge, a gap in the recording, beyond the prices recorded), which read "Bid $0" even above the price (Karl, 2026-11-01).
 */
export function bookSide(cell: { bid: number; ask: number } | null): 'bid' | 'ask' | null {
  if (!cell || !(cell.bid > 0 || cell.ask > 0)) return null;
  return cell.ask > cell.bid ? 'ask' : 'bid';
}
/** Which side of the map a column is on. */
type Side = 'right' | 'left';
/**
 * The measures asked by price this frame: each drawn column's measure once, whichever side it is on and however many sides, then the lines'
 * measure while the chart window's lines are drawn (asked with no room for its column too, since the lines are drawn from it), and traded
 * volume while periods are drawn (it says which venues the recording holds).
 */
export function priceQuestions(state: AppState): ProfileMetric[] {
  const s = state.traded, sides = sideColumns(state), asked = new Set([...sides.right, ...sides.left].map(p => p.metric));
  if (s.windowLines && (s.poc || s.va)) asked.add(lineMetric(s.placements));
  // The periods judge which venues the recording holds by the traded-volume answer (`#recordedIds`): asked for them, columns or none.
  if (chartKinds(s).length) asked.add('volume');
  return [...asked];
}

/** Rolling volume baseline for a candle array, keyed by the sensitivity it was computed with. */
interface VolumeAnalysis { candles: AppState['candles']; key: string; found: Anomalies }

/** The main chart: GL heatmap texture, candles, volume, axes, price profile and crosshair. */
/** What the volume strip drew last: its bars, the recorded rows, the markets they add up, and what its box needs. */
interface StripState { bars: StripBar[]; rows: TimeRows | null; ids: string[]; tf: number; top: number; market: string; tfName: string; reports: boolean; total: number }

export class HeatPane {
  readonly root = document.createElement('section');
  readonly gl: HeatGL;
  readonly overlay = document.createElement('canvas');
  readonly view = new View({ t0: 0, t1: 0, p0: 0, p1: 0 });
  stats = { p15: 0, p50: 0, p96: 0, max: 0 };
  /** Mirror-hover comparison for the pointer over the profile column, or null (read by tests, drawn on the profile). */
  mirror: MirrorStats | null = null;
  /** The pointer on one of the columns beside the map (the liquidation column or the profile column), for its Mirror comparison. */
  #profileHover: { y: number; column: 'liq' | 'book' | 'seam' } | null = null;
  /** Where this frame's "depth recorded from" note was printed, so the liquidation levels' note can keep clear of it. */
  #historyNote: { x0: number; x1: number; top: number } | null = null;
  /** Liquidation levels' rows in view and what they were grouped for (#liqRowsInView). */
  #liqRows: { key: string; rows: LiqRow[]; heat: (usd: number) => number } | null = null;
  /** The pointer over a volume profile column (its y, and which column: its side and its place there, nearest the map first), or null. */
  #tradedHover: { y: number; side: Side; i: number } | null = null;
  #profileBox: { lines: MirrorLine[]; y: number; placement: 'down' | 'up' } | null = null;
  /** The last values given to --gutter and --gutter-left on the pane, so a frame that changes nothing writes nothing. */
  #gutterCss = ''; #leftCss = '';
  onStats: () => void = () => {};
  onView: () => void = () => {};
  onFrame: () => void = () => {};
  /** The Delta pane's price/CVD divergences in view (set in main; none while that pane is not drawn). */
  divergences: () => readonly Divergence[] = () => [];
  /** A script's colour for the candle starting at `t` (`$price.color = ...`), or '' for the candle's own (set by the Scripts pane). */
  candleColor: (t: number) => string = () => '';
  /** The scripts placed on the map draw here, over the candles and the lines, in the map's price and time (set by the Scripts pane). */
  scriptLayer: ((ctx: CanvasRenderingContext2D, pw: number, ph: number) => void) | null = null;
  /**
   * The drawing tools (draw/controller.ts, set by the page): their drawings are painted over the scripts, what belongs to editing on a canvas
   * of their own above the map (left out of a screenshot), and the pointer goes to them first.
   */
  draw: DrawController | null = null;
  /** Each frame, where the drawing tools' controls go: the plot's left edge in the pane, its projection and the legend's foot (set by the page). */
  onDrawFrame: ((f: { left: number; pr: Projection; legendBottom: number }) => void) | null = null;
  /** A chart type pointed at in its menu, drawn without being kept (null: the one kept, `state.chartType`). */
  previewChartType: ChartType | null = null;
  readonly #drawEdit = document.createElement('canvas');
  #drawEditCtx: CanvasRenderingContext2D;
  /** The levels' tags on the price axis this frame, placed with the key levels'. */
  #drawTags: KeyTag[] = [];
  /** A mouse press on the plot (where, and whether it has moved far enough to be a pan): one that did not is a click, for the drawing tools. */
  #press: { x: number; y: number; moved: boolean } | null = null;
  /** A finger dragging a drawing's handle or the drawing itself. */
  #touchDraw = false;
  /** When the drawing tools last took a click: a double click on a drawing selects it and does not recentre the map. */
  #drawClickAt = 0;
  /** The popup lines of the person's scripts drawn on the map, at the candle starting at `t` (set by the Scripts pane). */
  scriptHover: (t: number, y: number, touch: boolean) => InfoLine[] = () => [];
  /** The popup of a script's mark under the pointer (`x`, `y` in the plot), its colour and its box; null where none is (set by the Scripts pane). */
  scriptMarkAt: (x: number, y: number, touch: boolean) => { lines: InfoLine[]; color: string; box: { x: number; y: number; w: number; h: number } } | null = () => null;
  /**
   * The legend's lines for the scripts drawn on the map, at the candle starting at `t` (null: the newest), with values for the first `valued`
   * of them only (set by the Scripts pane).
   */
  scriptLegend: (t: number | null, valued: number) => ScriptLegendLine[] = () => [];
  /** Where each script line's buttons go, in this pane's own pixels, once the legend is drawn (the Scripts pane places them). */
  onScriptLegend: (places: readonly { id: string; x: number; y: number }[]) => void = () => {};
  #glCanvas = document.createElement('canvas');
  #ctx: CanvasRenderingContext2D;
  /** The pane's whole width; the plot and everything right of it start after the columns left of the map (`#left`). */
  #paneW = 0; #h = 0; #dpr = 1;
  #dirty = true; #frame = 0;
  /** When the map was last drawn: the countdown redraws it once a second only when nothing else has (a quiet market). */
  #lastRender = 0;
  #overview = false;
  #overviewTarget: PriceTarget | null = null;
  #overviewContext: { key: string; candles: readonly CandleRow[]; window: PriceWindow | null } | null = null;
  #overviewPoints: { answer: PriceHistoryAnswer; cut: number; runs: PricePoint[][] } | null = null;
  /** The line as drawn: the runs without the parts the chart's candles cover, worked out again only when the answer or what the candles cover changes. */
  #overviewDrawn: { runs: PricePoint[][]; key: string; drawn: { t: number; price: number }[][]; covered: Covered[] } | null = null;
  /** The exchange's candles drawn where the chart's own do not reach (`historyCandles`), and the two together in time order. */
  #history: { answer: PriceHistoryAnswer; key: string; rows: CandleRow[] } | null = null;
  #allCandles: { history: readonly CandleRow[]; candles: readonly CandleRow[]; rows: readonly CandleRow[] } | null = null;
  /** A Go to needing price history may fit it on arrival, only while time and price stay where that action put them. */
  #priceFit: Bounds | null = null;
  #dataVersion = 0; #rasteredVersion = -1; #rasteredKey = ''; #lastRasterAt = 0;
  #liveMargin = 0;
  #palette = PALETTES.light!;
  /** The frame's corner radius (CSS `--radius`, read when the palette changes): the legend plate has the corners the page's boxes have. */
  #radius = 3;
  /** Colour window from the raster's percentiles (nextBaseline): new for a new view, then held, or blended toward the cells every 10 s in Auto. */
  #baseline: Baseline | null = null;
  #forceBaseline = true;
  /** The venues and size the colour window was taken for. */
  #baselineKey = '';
  #drag: { x: number; y: number; shift: boolean; panning: boolean } | null = null;
  /** The Range tool (set by the page), and a selection being dragged here: where it began, and where a finger last was. */
  range: RangeTool | null = null;
  #selecting: { x: number; y: number } | null = null;
  /** A drag on a volume profile column: where it began and on which (it selects whole rows of the column, over the column's window). */
  #columnSelect: { y: number; side: Side; i: number } | null = null;
  /** Each column's point of control and value area over its window, and the answer and rows they were read from. */
  readonly #levelsMemo = new Map<ProfileMetric, { answer: ProfileAnswer; step: number; share: number; levels: ValueLevels | null }>();
  /** The traded-volume column's estimate from the candles, built once for the rows it came from and not oftener than `LOADED_COLUMN_MS` (a drag moves its window every frame). */
  #loadedCol: { rows: Map<number, number>; step: number; from: number; to: number; at: number; cost: number; answer: ProfileAnswer; split: boolean; markets: string; sources: string } | null = null;
  #loadedTimer = 0;
  /** What the column's window was worked out from the candles as, by what it depends on: one slot that replaces itself, so a drag cannot fill `#candleLevels` with windows nobody asks for twice. */
  #columnSlot: { key: string; value: { levels: ValueLevels; rows: Map<number, number>; buys: Map<number, number> | null; spot: boolean } | null } | null = null;
  /** The days, weeks or sessions the lines are drawn for, and what they were worked out for. */
  #vaWindows: { key: string; windows: ProfileWindow[] } | null = null;
  /** How old each window is among its own series by the calendar up to now (`#ageRanks`), for the fading of the lines and profiles, and the carries (`#carries`): each by what it was worked out for. */
  #aged: { lines: LineKind[]; profiles: LineKind | null; sessions: SessionDef[]; zone: string; tz: string; minute: number; ranks: Map<string, number> } | null = null;
  #carried: { lines: LineKind[]; sessions: SessionDef[]; source: string; keeps: number; zone: string; tz: string; minute: number; real: number; carries: Carry[] } | null = null;
  /** Levels of days, weeks or sessions worked out from candles, by window, bar size, rows and share; a window under way with the candles' version. */
  readonly #candleLevels = new Map<string, { levels: ValueLevels; rows: Map<number, number>; buys: Map<number, number> | null; spot: boolean } | null>();
  /** When each past point of control was first traded at again (`#touchedAfter`), by window, price and the candles read. */
  readonly #touched = new Map<string, number | null>();
  /** Each on-chart profile's rows on the display grid, by what they were grouped from (an answer, or a candle estimate), kept while it is. */
  readonly #profileRows = new WeakMap<object, { row: number; rows: Map<number, [number, number]>; max: number; median: number; total: number }>();
  /** The period profiles drawn in the last frame, for the pointer: where each begins, its rows and scale, and what its box says of it. */
  #profileHits: ProfileHit[] = [];
  /** The volume strip's recorded rows (kept while what they come from is), and what it drew last frame, for the pointer. */
  #stripRows: { key: string; rows: TimeRows } | null = null;
  /** The chart's candles with the exchange's before them (`withEarlier`), kept while both are the same. */
  #stripCandles: { drawn: readonly CandleRow[]; own: ReadonlyMap<number, CandleRow>; rows: readonly CandleRow[] } | null = null;
  /** The strip's Highlights, worked out again only when its bars' figures or the options change. */
  readonly #stripHighlights = new StripHighlightMemo();
  readonly #takerRows = new TakerRows();
  /** The exchange's candles of the strip's longer timeframe (`stripTimeframe`): its own reader, so the Bar stats' at the chart's are not read again each frame. */
  readonly #coarseTaker = new TakerRows();
  /** The strip's candles of its longer timeframe (`coarseCandles`), kept while what they come from is the same. */
  #coarseCandles: { drawn: readonly CandleRow[]; exchange: ReadonlyMap<number, CandleRow> | null; tf: number; rows: readonly CandleRow[]; own: ReadonlyMap<number, CandleRow> } | null = null;
  #strip: StripState | null = null;
  /** The market orders of the strip's candles pointed at (the footprint's statistics of the strip's markets, read on hover). */
  #orders = new StripOrderCache();
  /** The volume profile's tags on the price axis, placed with the key levels' and the VWAP's. */
  #valueTags: KeyTag[] = [];
  /** The names put at the lines' right ends this frame (Volume profile, key levels, VWAP). */
  readonly #labels = new LabelBoard();
  /** The key levels' market and zone, how far back their candles are needed, and their lines, each kept until what it depends on changes. */
  #keyContext: { key: string; target: HistoryTarget | null; zone: string; barMs: number } | null = null;
  #keyFrom: { key: string; from: number } | null = null;
  #keyLines: { key: string; lines: KeyLine[] } | null = null;
  /** The VWAP's plan (sessions, anchors, bar sizes) and its lines, kept until what they depend on changes; its tags this frame. */
  #vwapPlanned: { key: string; plan: { sessions: ProfileWindow[]; sessionBar: number; anchors: { at: number; bar: number }[]; reach: Map<number, number> } } | null = null;
  #vwapDrawn: { key: string; lines: VwapLine[] } | null = null;
  #vwapTags: KeyTag[] = [];
  /** A click on the map while an anchor is being placed (set by the page): the time clicked. */
  onAnchor: ((t: number) => void) | null = null;
  /** A click on the header of the profile along the top (set by the page): its settings, in the Volume profile panel. */
  onTopProfile: () => void = () => {};
  /** What of the profiles has no room changed (a resize, a taller legend): the open panel says it again. */
  onArrangedChange: () => void = () => {};
  #hiddenKey = '';
  /** The tags the key levels want on the price axis this frame. */
  #keyTags: KeyTag[] = [];
  #touchSelect: { start: Pt; at: Pt } | null = null;
  /** Right-button drag: zoom about the press point, from the view as it was at press time. */
  #zoomDrag: { x: number; y: number; view: Bounds } | null = null;
  #wasLoaded = false;
  #footprint = new FootprintData();
  /** The footprint's imbalance marks, worked out once a load (or when the options change). */
  #footprintMarks = new FootprintMarks();
  /** The stacked-imbalance zones and naked points of control running on from closed candles. */
  #footprintRuns = new FootprintRuns();
  /** Rejected aggressive buying and selling on closed candles, decided once per candle on a row step that does not depend on the zoom. */
  #traps = new TrapData();
  /** The pulsing layer: a canvas of its own above the overlay, redrawn a few times a second only while a trap is in view. */
  readonly #pulse = document.createElement('canvas');
  #pulseRects: { x: number; y: number; w: number; h: number; active: boolean }[] = [];
  #pulseFrame = 0; #pulseDrawn = 0;
  #lod = new FootprintLod();
  #lodFrame: LodFrame = { barAlpha: 0, sellBuyAlpha: 0, needsFrame: false, heatmapOpacity: 1, narrowing: 0 };
  /** The bands along the top of the map (measures/): the columns' measures added up by time, under the legend. */
  readonly #bands = new TopBands();
  /** Where the profiles went this frame (traded/arrange.ts), and the small tags that say how many had no room, for the pointer. */
  #arranged: Arranged = { right: [], left: [], top: [], hidden: [] };
  #hiddenTags: { x: number; y: number; w: number; h: number }[] = [];
  #volume: VolumeAnalysis | null = null;
  /** Absorption icons drawn in the last frame (centre, size, the marks they stand for), for hover. */
  #absorptionIcons: { x: number; y: number; s: number; marks: AbsorptionMark[]; usd: number }[] = [];
  /** The squares last worked out, for the view they were worked out at (see #paintAbsorption). */
  #absorptionLayout: { key: string; t0: number; shown: MarkIcon[] } | null = null;
  /** The thresholds of the last frame, kept while nothing they depend on changed (the book, the settings, the minute, the venues). */
  #absorptionKey = ''; #absorptionThresholds: Map<string, number | null> = new Map();
  /** Bubbles drawn in the last frame, for hover. */
  #bubbles: { x: number; y: number; r: number; print: Print }[] = [];
  /** The liquidations drawn this frame (half-diagonal `r`), for the pointer. */
  #diamonds: { x: number; y: number; r: number; liq: Liquidation }[] = [];
  #grid: { data: Float32Array; w: number; h: number; bounds: Bounds } | null = null;
  /** The raster as the walls are read from it (the type of `#grid`). */
  get grid(): { data: Float32Array; w: number; h: number; bounds: Bounds } | null { return this.#grid; }
  /** Where the liquidity under the pointer comes from: asked of the worker once per map cell and kept while the pointer stays in it. */
  #sources: { key: string; text: string } | null = null;
  #sourcesAsked = '';
  /** Where a finger pinned the crosshair (the map's own coordinates), and the gesture in progress. */
  #pin: Pt | null = null;
  /** The corner of the legend plate as the last frame drew it, so the history note can keep clear of it. */
  #legendBox = { right: 340, bottom: 42 };
  #panKind: 'map' | 'price' | 'time' | null = null;
  #axisDrag: { view: Bounds; x: number; y: number } | null = null;
  #pinch: { view: Bounds; t: number; p: number } | null = null;
  /** A mouse drag on the price scale: the view when it began, where the pointer was, and the price it holds still. */
  #scaleDrag: { y: number; view: Bounds; hold: number } | null = null;
  #fling = 0;
  /**
   * The trade dust (tape/gl.ts): every market order since the page opened, on a canvas of its own between the heatmap and the overlay, so
   * candles, bubbles and lines stay above it; null until first shown, and for good where the card cannot draw it. Arrivals redraw this
   * canvas alone (`tapeArrived`), never the overlay; its accent animates only while one is fading.
   */
  #dustCanvas = document.createElement('canvas');
  #dust: TapeGL | null = null; #dustFailed = false; #dustFrame = 0; #dustDrawn = 0;
  /** The price lines through the dust, by pixel column (tape/trace.ts), and the dashed part before them, kept until what it is read from changes. */
  #trace = new TraceIndex();
  #secondsRuns: { key: string; runs: number[][] } | null = null;

  constructor(host: HTMLElement, private store: Store, private hub: Hub, private kernels: Kernels) {
    this.root.className = 'pane heat';
    this.#pulse.className = 'pulse';
    this.#dustCanvas.className = 'dust';
    this.#drawEdit.className = 'draw-edit'; this.#drawEdit.setAttribute('data-no-capture', '');
    this.root.append(this.#glCanvas, this.#dustCanvas, this.#pulse, this.#drawEdit, this.overlay);
    host.append(this.root);
    this.gl = new HeatGL(this.#glCanvas);
    this.#ctx = this.overlay.getContext('2d')!;
    this.#drawEditCtx = this.#drawEdit.getContext('2d')!;
    new ResizeObserver(() => this.#resize()).observe(this.root);
    this.hub.onRaster = result => this.#onRaster(result);
    this.hub.onColumns = () => { this.#dataVersion++; this.invalidate(); };
    this.#bindInput();
    window.setInterval(() => { this.hub.invalidateColumns(); this.invalidate(); }, 30_000);
    document.addEventListener('visibilitychange', () => { if (document.hidden) this.hub.priceHistory.stop(); else this.invalidate(); });
  }

  /** Where the plot starts in the pane: after the columns left of the map. The overlay draws in the plot's coordinates, those columns at negative x. */
  get #left(): number { return leftGutter(this.store.state); }
  /** The width from the plot's left edge to the pane's right edge: what everything drawn right of the plot (the columns, the axis) measures from. */
  get #w(): number { return Math.max(1, this.#paneW - this.#left); }
  get plotW(): number { return Math.max(1, this.#w - gutter(this.store.state)); }
  get plotH(): number { return Math.max(1, this.#h - TIME_H); }
  setPalette(name: string): void {
    this.#palette = PALETTES[name] ?? PALETTES.light!;
    this.#radius = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--radius')) || 0;
    this.gl.setLut(buildLut(this.#palette.dark)); this.invalidate();
  }

  /** Executions per candle for the bar-stats strip (loaded only while the footprint is on). */
  get footprintData(): FootprintData { return this.#footprint; }

  /** USD window currently mapped onto the colour ramp: the percentile baseline shifted by the contrast slider. */
  get window(): { lo: number; hi: number } { return colourWindow(this.#baseline, this.store.state.heat.contrast); }

  #updateBaseline(): void {
    if (!(this.stats.p96 > 0)) return;
    this.#baseline = nextBaseline(this.#baseline, this.stats, { auto: this.store.state.heat.auto, force: this.#forceBaseline, spanP: this.view.p1 - this.view.p0, now: performance.now() });
    this.#forceBaseline = false;
  }
  invalidate(): void { this.#dirty = true; if (!this.#frame && !this.#suspended) this.#frame = requestAnimationFrame(() => { this.#frame = 0; this.#render(); }); }
  /**
   * Covered by a view of its own (the phone's Candle tab): nothing is drawn, the dust included, until it shows again, when it draws at once.
   * A covered map drew at 1 x 1 px every frame, and its dust some 55 times a second (measured 2026-10-16).
   */
  #suspended = false;
  setSuspended(on: boolean): void {
    if (on === this.#suspended) return;
    this.#suspended = on;
    if (on) this.hub.priceHistory.stop();
    if (on && this.#pulseFrame) { cancelAnimationFrame(this.#pulseFrame); this.#pulseFrame = 0; }
    if (!on) this.invalidate();
  }
  dataChanged(): void { this.#dataVersion++; this.invalidate(); }

  #resize(): void {
    const rect = this.root.getBoundingClientRect();
    this.#paneW = Math.max(1, Math.floor(rect.width)); this.#h = Math.max(1, Math.floor(rect.height)); this.#dpr = window.devicePixelRatio || 1;
    // A narrow map (a phone, or half of a landscape one) gives the axis and the profile less room, so the plot keeps most of it.
    setCompactGutters(this.#paneW < COMPACT_PANE, this.#paneW);
    this.overlay.width = Math.round(this.#paneW * this.#dpr); this.overlay.height = Math.round(this.#h * this.#dpr);
    this.overlay.style.width = `${this.#paneW}px`; this.overlay.style.height = `${this.#h}px`;
    this.#pulse.width = this.overlay.width; this.#pulse.height = this.overlay.height;
    this.#pulse.style.width = this.overlay.style.width; this.#pulse.style.height = this.overlay.style.height;
    this.#drawEdit.width = this.overlay.width; this.#drawEdit.height = this.overlay.height;
    this.#drawEdit.style.width = this.overlay.style.width; this.#drawEdit.style.height = this.overlay.style.height;
    this.#positionGl();
    this.#rasteredKey = ''; this.onView(); this.invalidate();
  }
  #positionGl(): void {
    // The heatmap and the dust start where the plot does: after the columns left of the map.
    const left = `${this.#left}px`;
    if (this.#glCanvas.style.left !== left) { this.#glCanvas.style.left = left; this.#dustCanvas.style.left = left; }
    this.#glCanvas.style.width = `${this.plotW}px`; this.#glCanvas.style.height = `${this.plotH}px`;
    // The heatmap is blocks of colour, so a finger's screen (3 device pixels to a CSS pixel) gains nothing from filling every one of them; the browser scales a 2x canvas up.
    this.gl.resize(this.plotW, this.plotH, isCoarse() ? Math.min(this.#dpr, 2) : this.#dpr);
    this.#dust?.resize(this.plotW, this.plotH, this.#dustDpr());
  }

  #dustDpr(): number { return isCoarse() ? Math.min(this.#dpr, 2) : this.#dpr; }

  /** Whether the dust is drawn: the bubbles and their Live trades switch on, something held, and not in replay (it holds only what arrived live). */
  #dustOn(state: AppState): boolean { return state.show.bubbles && state.tradeBubbles.live && this.hub.tape !== null && !replaying(); }

  /**
   * Where an order at `price` that traded at `t` sits on the screen (window CSS px), for the glass's light (glass/ui-glass.ts); null when
   * the map does not show that time or price, is hidden, or replays.
   */
  liveSpot(price: number, t: number): { x: number; y: number } | null {
    if (this.#suspended || replaying() || this.root.hidden) return null;
    const pw = this.plotW, ph = this.plotH, x = this.view.xOf(t, pw), y = this.view.yOf(price, ph);
    if (!(x >= 0 && x <= pw + 2 && y >= 0 && y <= ph)) return null;
    const r = this.overlay.getBoundingClientRect();
    return r.width > 0 ? { x: r.left + this.#left + Math.min(x, pw), y: r.top + y } : null;
  }

  /** Orders arrived for the dust: it is redrawn on the next frame, alone (the overlay's price line follows with its own next frame). */
  tapeArrived(): void { if (!this.#dustFrame && !document.hidden && !this.#suspended) this.#dustFrame = requestAnimationFrame(() => { this.#dustFrame = 0; this.#drawDust(); }); }

  /** The dust's renderer, made the first time it is shown (null where the card cannot draw it, said once in the console). */
  #ensureDust(): TapeGL | null {
    if (this.#dust || this.#dustFailed || !this.hub.tape) return this.#dust;
    try { this.#dust = new TapeGL(this.#dustCanvas, this.hub.tape); this.#dust.resize(this.plotW, this.plotH, this.#dustDpr()); }
    catch (error) { this.#dustFailed = true; console.warn('live trades cannot be drawn here:', error); }
    return this.#dust;
  }

  /**
   * Draw the dust for the view as it is (the map's own frames move the view; this never does). While an arrival accent fades it asks for
   * another frame, at most about 30 a second, none with the page hidden or with reduced motion.
   */
  #drawDust(): void {
    const state = this.store.state;
    if (!this.#dustOn(state)) { this.#dust?.clear(); return; }
    const dust = this.#ensureDust(), tape = this.hub.tape; if (!dust || !tape) return;
    const p = this.#palette, off = state.disabledVenues;
    dust.setMask(off.length ? tape.ids.flatMap((id, i) => off.includes(id.slice(0, id.indexOf(':'))) ? [i] : []) : []);
    const style: DustStyle = { bid: rgb(p.bid), ask: rgb(p.ask), mid: rgb(p.dark ? '#d8dce4' : '#3a3f48'), rim: rgb(p.bg), floorUsd: scaledUsd(100), ceilUsd: scaledUsd(250_000), volLo: scaledUsd(100), volHi: scaledUsd(2_000_000), opacity: state.tradeBubbles.liveOpacity * (1 - 0.85 * this.#lodFrame.barAlpha) };
    const reduced = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches, now = performance.now();
    this.#dustDrawn = now;
    const fading = dust.draw(this.view, style, this.#dustDpr(), `${style.floorUsd}|${p.bid}|${p.ask}`, reduced ? Infinity : now);
    if (fading && !this.#dustFrame && !document.hidden) {
      const next = (time: number): void => { this.#dustFrame = 0; if (this.#suspended) return; if (time - this.#dustDrawn >= 30) this.#drawDust(); else if (!document.hidden) this.#dustFrame = requestAnimationFrame(next); };
      this.#dustFrame = requestAnimationFrame(next);
    }
  }

  /** Frame the most recent candles, centred on the mark. */
  fit(): void {
    if (replaying()) { this.placeAt(pageNow()); return; }
    this.#forceBaseline = true;
    const { candles, mark, timeframe } = this.store.state;
    const tf = TIMEFRAMES[timeframe] ?? 3_600_000;
    // Only the latest contiguous run: stored candle history can have multi-day holes.
    let from = candles.length;
    while (from > 0 && candles.length - from < 110 && (from === candles.length || candles[from]![0] - candles[from - 1]![0] <= tf * 3)) from--;
    const recent = candles.slice(Math.max(0, from));
    let lo = Infinity, hi = -Infinity;
    for (const c of recent) { lo = Math.min(lo, c[3]); hi = Math.max(hi, c[2]); }
    // Neither candles nor a price yet (a start that did not wait for one): nothing to frame, so the view stays unset and the first frame
    // that has either frames it (`#render`), rather than a price axis around 1 that the price recentres but never widens.
    if (!(hi > lo) && !(mark.price > 0)) return;
    if (!(hi > lo)) { const p = mark.price; lo = p * 0.99; hi = p * 1.01; }
    const pad = (hi - lo) * 0.18;
    const now = pageNow();
    let span = tf * Math.max(40, Math.min(110, recent.length || 80));
    // With little recorded depth, frame the recorded window so the heatmap is visible rather than a sliver.
    const since = this.hub.recordedSince;
    if (since > 0 && now - since < span * 0.7) span = Math.max(75 * 60_000, (now - since) * 1.35);
    this.#liveMargin = span * 0.08;
    this.view.set({ t0: now + this.#liveMargin - span, t1: now + this.#liveMargin, p0: lo - pad, p1: hi + pad });
    this.store.set({ followLive: true });
    this.#rasteredKey = ''; this.onView(); this.invalidate();
  }

  /** One step of time zoom from the keyboard (in: `dir` 1), as the wheel does with Shift over the chart: about the live edge while the map follows the market. The price stays as it is. */
  zoomStep(dir: 1 | -1): void {
    const pw = this.plotW, v = this.view, state = this.store.state;
    if (!(pw > 0) || !(v.t1 > v.t0)) return;
    const factor = limitFactor(Math.exp(-dir * 0.25), v.t1 - v.t0, TIME_SPAN_MS.min, TIME_SPAN_MS.max);
    v.zoomTime(factor, holdPixel({ axis: 'time', pointer: pw / 2, size: pw, alt: false, follow: state.followLive, mark: state.mark.price, markPixel: 0, nowPixel: v.xOf(pageNow(), pw) }), pw);
    this.#liveMargin = this.view.t1 - pageNow(); this.#rasteredKey = ''; this.onView(); this.invalidate();
  }

  #onRaster(result: RasterResult): void {
    this.stats = result.stats;
    this.#updateBaseline();
    this.#grid = { data: result.data, w: result.w, h: result.h, bounds: result.bounds };
    this.gl.upload(result.data, result.w, result.h, result.bounds);
    this.#wasLoaded = true;
    this.onStats(); this.invalidate();
  }

  #enabledIds(): string[] {
    const state = this.store.state;
    if (!state.levels) return [];
    const source = heatmapSourceOf(state);
    if (source !== 'aggregated') return [source];
    return activeIds(state);
  }

  #manageRaster(): void {
    const v = this.view;
    if (!(v.t1 > v.t0)) return;
    const ids = this.#enabledIds();
    const smooth = this.store.state.heat.smooth !== 'off';
    const key = `${ids.join(',')}|${this.plotW}x${this.plotH}|${smooth ? 's' : 'r'}`;
    const cov = this.gl.coverage;
    const outside = !cov || v.t0 < cov.t0 || v.t1 > cov.t1 || v.p0 < cov.p0 || v.p1 > cov.p1
      || (v.t1 - v.t0) / (cov.t1 - cov.t0) < 0.55 || (v.p1 - v.p0) / (cov.p1 - cov.p0) < 0.55;
    // What is live is drawn again every second and a half, or, where a raster takes long (days of many venues), no more often than leaves the
    // worker two thirds of its time for the panes' questions.
    const stale = this.#rasteredVersion !== this.#dataVersion || this.#rasteredKey !== key || performance.now() - this.#lastRasterAt > Math.max(1_500, 3 * this.hub.busyMs);
    // A new view of other venues or another size takes a new colour window; a pan or zoom only asks for a new raster (#rasteredKey).
    if (this.#baselineKey !== key) { this.#baselineKey = key; this.#forceBaseline = true; }
    void this.hub.loadColumns(v, this.plotW).catch(error => console.error('column load failed', error));
    if (!ids.length || (!outside && !stale)) return;
    const spanT = v.t1 - v.t0, spanP = v.p1 - v.p0;
    const bounds: Bounds = { t0: v.t0 - spanT * 0.2, t1: v.t1 + spanT * 0.2, p0: v.p0 - spanP * 0.2, p1: v.p1 + spanP * 0.2 };
    const cap = Math.min(2600, this.gl.maxSize);
    const w = Math.min(cap, Math.round(this.plotW * 1.4)), h = Math.min(cap, Math.round(this.plotH * 1.4));
    if (this.hub.raster(ids, bounds, w, h, smooth)) { this.#rasteredVersion = this.#dataVersion; this.#rasteredKey = key; this.#lastRasterAt = performance.now(); }
  }

  #style(): HeatStyle {
    const p = this.#palette, { heat } = this.store.state, w = this.window;
    const opacity = heat.style === 'size' ? this.#lodFrame.heatmapOpacity : (p.dark ? 0.95 : 1) * this.#lodFrame.heatmapOpacity;
    return { bid: rgb(p.bid), bidSoft: rgb(p.bidSoft), ask: rgb(p.ask), askSoft: rgb(p.askSoft), min: w.lo, max: w.hi, mode: heat.style, opacity };
  }

  /**
   * Centre the map on `t` at the span it has, leaving the live edge as a drag does, and fit the price to the candles there when there are
   * any (the price may have been far from today's). The depth and the panes under the map load what the new window needs on their own.
   */
  /** Draw again for the countdown when nothing else has for most of a second (a quiet market): the page shown, the candles on. */
  tick(): void {
    if (document.visibilityState === 'visible' && this.store.state.show.candles && !isPhone() && performance.now() - this.#lastRender > 900) this.invalidate();
  }

  /** Replay: its moment becomes the map's live edge (at the span the map has), followed as it moves on. */
  placeAt(t: number): void {
    const v = this.view, span = v.t1 - v.t0, margin = span * 0.08;
    let lo = Infinity, hi = -Infinity;
    const tf = TIMEFRAMES[this.store.state.timeframe] ?? 3_600_000;
    for (const c of this.store.state.candles) if (c[0] + 1 > t - span && c[0] + tf <= t) { lo = Math.min(lo, c[3]); hi = Math.max(hi, c[2]); }
    const pad = (hi - lo) * 0.18;
    v.set({ t0: t + margin - span, t1: t + margin, p0: hi > lo ? lo - pad : v.p0, p1: hi > lo ? hi + pad : v.p1 });
    this.#liveMargin = margin; this.store.set({ followLive: true }); this.#rasteredKey = ''; this.#atCandles = null; this.onView(); this.invalidate();
  }

  goTo(t: number): void {
    const v = this.view, span = v.t1 - v.t0, t0 = t - span / 2, t1 = t + span / 2;
    const state = this.store.state, tf = TIMEFRAMES[state.timeframe] ?? 3_600_000;
    // Fitted to the candles that are drawn, whichever series they are of (the line is cut on them, so they are what is on screen; a view they
    // do not cover is fitted to the line when it comes, `#priceFit`).
    const range = candlePriceRange(state.candles, tf, t0, t1), pad = range ? (range.hi - range.lo) * 0.18 : 0;
    v.set({ t0, t1, p0: range ? range.lo - pad : v.p0, p1: range ? range.hi + pad : v.p1 });
    // Planned on the candles that are drawn (`state.candles`), as the line is cut on them: where they cover the view there is no line to fit to.
    this.#priceFit = priceOverviewNeeded(state.candles, tf, v, this.plotW, Date.now()) ? v.clone() : null;
    this.store.set({ followLive: false }); this.#liveMargin = v.t1 - pageNow(); this.#rasteredKey = ''; this.onView(); this.invalidate();
  }

  /** While replaying, the candles as they were at its moment (the one under way rebuilt from the recorded price a second), kept per second. */
  #atCandles: { key: string; src: readonly CandleRow[]; rows: CandleRow[] } | null = null;
  #shownCandles(state: AppState): readonly CandleRow[] {
    // Again when flow arrives: paused before it loaded, the candle under way would otherwise stay without it.
    const tf = TIMEFRAMES[state.timeframe] ?? 3_600_000, at = pageNow(), key = `${tf}|${Math.floor(at / 1000)}|${this.hub.flow.version}`;
    if (this.#atCandles?.key === key && this.#atCandles.src === state.candles) return this.#atCandles.rows;
    const id = state.seriesInstrument || state.marketId, start = Math.floor(at / tf) * tf, DAY = 86_400_000;
    if (Date.now() - start < DAY - 3_600_000) void this.hub.ensureFlow([id], start - 60_000);
    else void this.hub.ensureFlowMinutes([id], Math.floor((start - 3_600_000) / 21_600_000) * 21_600_000, Math.ceil((start + tf + 3_600_000) / 3_600_000) * 3_600_000);
    const track = this.hub.flow.track(id);
    const rows = candlesAt(state.candles, tf, at, track ? formingCandle(track, start, at) : null);
    this.#atCandles = { key, src: state.candles, rows };
    return rows;
  }

  /** The state as the map draws it: while replaying, the candles as they were at its moment and the price then. */
  #displayState(): AppState {
    const state = this.store.state;
    if (!replaying()) return state;
    const candles = this.#shownCandles(state) as CandleRow[], last = candles[candles.length - 1];
    return { ...state, candles, mark: { price: last ? last[4] : 0, asOf: pageNow() } };
  }

  #render(): void {
    this.#lastRender = performance.now();
    this.#dirty = false;
    const state = this.#displayState();
    if (this.#paneW <= 1 || this.#h <= 1) return;
    if (!(this.view.t1 > this.view.t0) && (state.candles.length || state.mark.price)) this.fit();
    if (state.followLive && this.view.t1 > this.view.t0) {
      const shift = pageNow() + this.#liveMargin - this.view.t1;
      if (Math.abs(shift) > 0) { this.view.t0 += shift; this.view.t1 += shift; }
      const mark = state.mark.price, { p0, p1 } = this.view, span = p1 - p0;
      if (mark && (mark < p0 + span * 0.1 || mark > p1 - span * 0.1)) { const mid = mark - span / 2; this.view.p0 = mid; this.view.p1 = mid + span; this.#rasteredKey = ''; }
    }
    this.#positionGl();
    this.#ensureOverview(state);
    const gutterCss = `${gutter(state)}px`, leftCss = `${this.#left}px`;
    if (this.#gutterCss !== gutterCss) { this.#gutterCss = gutterCss; this.root.style.setProperty('--gutter', gutterCss); }
    if (this.#leftCss !== leftCss) { this.#leftCss = leftCss; this.root.style.setProperty('--gutter-left', leftCss); }
    this.#manageRaster();
    if (state.show.bubbles) this.hub.ensurePrints(this.view, scaledUsd(state.tradeBubbles.minUsd));
    if (state.liquidations.on) this.hub.ensureLiquidations(this.view, scaledUsd(state.liquidations.minUsd));
    if (state.keyLevels.on && anyLine(state.keyLevels)) this.#ensureKeyLevels(state);
    if (state.vwap.on) this.#ensureVwap(state);
    if (state.show.traded) {
      // What is on the chart draws its lines from the column's answer; a day, week or session draws them from the value areas, so on a map with no
      // room for the column (a phone) its whole-period profile would be read for nothing. Another measure than traded volume draws its lines
      // from its column's answer whatever the period, so that one is asked even with no room for the columns.
      // A measure drawn on both sides is one question (the hub keeps one answer a measure): moving a column to the other side asks nothing new.
      for (const metric of priceQuestions(state)) this.#ensureTraded(state, metric);
      this.#ensureValueAreas(state);
      this.#ensurePastProfiles(state);
    }
    // The absorption column judges groups at the thresholds the marks use, which need the recent minutes the marks load: with the marks off,
    // those minutes alone (and none for a fixed threshold). The column's groups are added up where they are kept (`Hub.ensureMetricProfile`).
    // A band along the top adds up the marks' own groups, so while one shows absorption they are loaded as for the marks (only a band that
    // fits: where they go is worked out here, before the data is asked for, and kept for the overlay).
    this.#arranged = this.#arrange(state);
    const hiddenKey = this.#arranged.hidden.map(p => p.id).join(',');
    if (hiddenKey !== this.#hiddenKey) { this.#hiddenKey = hiddenKey; queueMicrotask(() => this.onArrangedChange()); }
    const set = state.traded.placements, column = state.show.traded && MEASURES.some(m => m.judgedByMarks && onPriceAxis(set, m.id)), marked = state.absorption.on || topMarks(state, this.#arranged.top);
    if (marked || (column && state.absorption.mode === 'auto')) { const { ids, thresholds } = this.#absorptionContext(state); this.hub.ensureAbsorption(ids, ids.map(id => thresholds.get(id) ?? null), this.view, state.absorption.sdMinutes, !marked); }
    this.#stepFootprint(state);
    // Under a dominant footprint the heatmap is gone altogether, so there is nothing to draw.
    if (state.layer === 'liquidity' && this.#lodFrame.heatmapOpacity > 0.003) this.gl.draw(this.view, this.#style()); else this.gl.clear();
    this.#drawDust();
    this.#paintOverlay(state);
    this.onFrame();
  }

  #footprintIds: { key: unknown[]; ids: string[] } | null = null;
  /**
   * The markets the footprint counts, sorted: the chart market alone, or (Aggregated) those of the flow column's ALL VENUES lines, which the
   * Delta pane adds up too (`aggregateIds`: the venues switched on, inside the Spot / Perp filter, one spot and one perpetual market each), so
   * the bar statistics' delta and the Delta pane's agree; at most MAX_PROFILE_INSTRUMENTS. Worked out again only when what it depends on changes.
   */
  footprintMarkets(state: AppState): string[] {
    if (state.footprint.markets === 'chart') return [state.marketId];
    // Picked: the markets of the picks on this coin, whatever the chips and the filter say (an empty list counts none).
    if (state.footprint.markets === 'custom') {
      const key = [state.markets, state.customMarkets.footprint, this.hub.flow.ids.length, this.hub.flow.loads];
      if (!this.#footprintIds || this.#footprintIds.key.length !== key.length || this.#footprintIds.key.some((k, i) => k !== key[i])) this.#footprintIds = { key, ids: resolvePicks(state, this.hub.flow, state.customMarkets.footprint, false) };
      return this.#footprintIds.ids;
    }
    // What the set depends on: the markets, the chips and the filter, which books are on the map, and the flow held (a load can make a market
    // with older minutes count, `FlowBook.loads`), compared by value where they are not replaced when they change.
    const onMap = mapVenues(state), key = [state.markets, state.disabledVenues, state.scope, onMap ? [...onMap].sort().join(',') : null, this.hub.flow.ids.length, this.hub.flow.loads];
    if (!this.#footprintIds || this.#footprintIds.key.length !== key.length || this.#footprintIds.key.some((k, i) => k !== key[i])) this.#footprintIds = { key, ids: aggregateIds(this.hub.flow, flowIds(state, this.hub.flow.ids), id => kindOf(state.markets, id)).sort().slice(0, MAX_PROFILE_INSTRUMENTS) };
    // None (every venue off, or none inside the filter) counts none: the chart market is not put in their place.
    return this.#footprintIds.ids;
  }

  /**
   * Advance the footprint level of detail for this frame (also drives the heatmap dimming), and load the bars the footprint and the Bar stats
   * table read: one load for both, made while either shows. The rows are the size the footprint would draw at this zoom whether it shows or
   * not, so the table's rows (point of control, imbalances) are the footprint's own when both are on.
   */
  #stepFootprint(state: AppState): void {
    const v = this.view, pw = this.plotW, ph = this.plotH, now = performance.now(), drawn = state.show.footprint;
    if (!(drawn || state.show.stats) || !(v.t1 > v.t0)) { this.#lodFrame = this.#lod.step(now, { enabled: false, hasData: false, widthCss: 0, rowHeightCss: 0, factor: 0 }); return; }
    const tfMs = TIMEFRAMES[state.timeframe] ?? 3_600_000, fine = this.#footprint.fine;
    const fineRowPx = fine > 0 ? Math.abs(v.yOf(0, ph) - v.yOf(fine, ph)) : 0;
    const rowStep = fine > 0 ? fine * 2 ** this.#lod.level(fineRowPx) : 0;
    // The Bar stats' retail and whale sizes are asked as size lines (those between box edges), so their rows are exact at any size from the floor.
    const cuts = linesToAsk([state.barStatOptions.retailUsd, state.barStatOptions.whaleUsd], scaledUsd);
    const markets = this.footprintMarkets(state);
    if (!markets.length) this.#footprint.clear();
    // The table's running sums from each day's start need the bars from the start of the day the left edge falls in.
    const window = state.show.stats && state.barStatOptions.cvdFrom === 'day' ? { t0: Math.min(v.t0, dayStartOf(v.t0, resolveZone('page', state.timeZone))), t1: v.t1, p0: v.p0, p1: v.p1 } : v;
    if (markets.length) this.#footprint.ensure(markets.join(','), state.timeframe, window, rowStep, (inst, tf, from, to, rows, lines, budget, venues) => this.hub.footprint(inst, tf, from, to, rows, lines, budget, venues), () => this.invalidate(), cuts, this.hub.sourceNow());
    const rowH = rowStep > 0 ? Math.abs(v.yOf(0, ph) - v.yOf(rowStep, ph)) : 0;
    const factor = visibilityFactor(state.candles, tfMs, v, pw, ph, rowH || 1, rowStep || 1);
    // The table alone draws nothing on the map: the footprint's level of detail stays off, and with it the heatmap's dimming and the traps.
    this.#lodFrame = this.#lod.step(now, { enabled: drawn, hasData: this.#footprint.bars.size > 0, widthCss: pw * tfMs / (v.t1 - v.t0), rowHeightCss: rowH, factor });
    // A trap needs the candles and the footprint to be the same market's; a chart showing a reference series instead says nothing about this market's flow.
    // Only while the footprint shows: switched off with the table still on, its fade must not start another scan.
    if (drawn && this.#lodFrame.barAlpha > 0.05 && state.seriesInstrument === state.marketId && !replaying()) {
      this.#traps.ensure({ inst: state.marketId, tf: state.timeframe, tfMs, candles: state.candles, fine, view: v, load: (inst, tf, from, to, rows) => this.hub.footprint(inst, tf, from, to, rows), onLoad: () => this.invalidate() });
    } else this.#traps.clear();
    if (this.#lodFrame.needsFrame) this.invalidate();
  }

  /**
   * The exchange's own candles of the series the chart reads, by start, from `from` on, with their taker buys (index 7) and, where it reports
   * them, their trades and quote volumes (8 to 10): Binance's; null for a market that does not say who bought. Loaded on demand; the chart is
   * drawn again when they land. The volume strip's candle bars read them, and the Bar stats table's candle delta and fills (buys, volume and
   * price of one snapshot: the chart's candle under way moves on between the minutes it is read).
   */
  takerRows(state: AppState, tf: number, from: number): Map<number, CandleRow> | null {
    return this.#takerRows.get(this.hub, state, tf, from, () => this.invalidate());
  }

  /** The Delta pane's divergences on the price: the two swings joined above the highs (sellers', ask colour) or below the lows (buyers', bid colour). */
  #paintDivergences(ctx: CanvasRenderingContext2D, state: AppState, pw: number, ph: number): void {
    const list = this.divergences();
    if (!list.length) return;
    const v = this.view, p = this.#palette, tf = TIMEFRAMES[state.timeframe] ?? 3_600_000, label = t('CVD divergence');
    ctx.save(); ctx.beginPath(); ctx.rect(0, 0, pw, ph); ctx.clip();
    for (const d of list) paintDivergence(ctx, d, v.xOf(d.from + tf / 2, pw), v.yOf(d.priceFrom, ph), v.xOf(d.to + tf / 2, pw), v.yOf(d.priceTo, ph), d.kind === 'bear' ? p.ask : p.bid, label);
    ctx.restore();
  }

  #paintOverlay(state: AppState): void {
    const ctx = this.#ctx, w = this.#w, h = this.#h, pw = this.plotW, ph = this.plotH, v = this.view, p = this.#palette, left = this.#left;
    ctx.setTransform(this.#dpr, 0, 0, this.#dpr, 0, 0);
    ctx.clearRect(0, 0, this.#paneW, h);
    // Everything is drawn in the plot's coordinates: the plot starts at 0, the columns left of the map are at negative x.
    ctx.setTransform(this.#dpr, 0, 0, this.#dpr, this.#dpr * left, 0);
    ctx.font = '11px ui-sans-serif, system-ui, sans-serif';
    ctx.textBaseline = 'middle';
    // grid
    ctx.strokeStyle = p.line; ctx.lineWidth = 1; ctx.fillStyle = p.muted;
    const pStep = niceStep(v.p1 - v.p0, ph / 46);
    ctx.globalAlpha = 0.6; ctx.beginPath();
    for (let q = Math.ceil(v.p0 / pStep) * pStep; q <= v.p1; q += pStep) { const y = Math.round(v.yOf(q, ph)) + 0.5; ctx.moveTo(0, y); ctx.lineTo(pw, y); }
    const { ticks, labels: timeLabels } = timeAxis(v.t0, v.t1, pw, text => ctx.measureText(text).width);
    for (const t of ticks) { const x = Math.round(v.xOf(t, pw)) + 0.5; ctx.moveTo(x, 0); ctx.lineTo(x, ph); }
    ctx.stroke(); ctx.globalAlpha = 1;
    const market = state.markets.find(m => (m.instrumentId ?? m.id) === state.marketId);
    paintWatermark(ctx, p, pw, ph, [market?.base && market.quote ? `${market.base}/${market.quote}` : '', state.timeframe].filter(Boolean).join(' · '));
    this.mirror = null;
    this.#paintHistoryStart(ctx, pw, ph, p);
    this.#paintTapeStart(ctx, state, pw, ph, p);
    this.#paintLayers(ctx, state, pw, ph);
    if (state.liqLevels.on) this.#paintLiquidationLevels(ctx, state, pw, ph);
    this.#paintVolume(ctx, state, pw, ph, this.#lodFrame.narrowing);
    // Under the candles as the volume bars are, and under the legend and the corner buttons, whose bottoms it is placed by; over what the
    // columns add up, with the marks' absorption thresholds; what it asked for redraws the map when it comes.
    this.#bands.paint(ctx, state, this.hub, { view: v, pw, ph, palette: p, legendBottom: this.#legendBox.bottom, window: this.#tradedWindow(), absorption: () => this.#absorptionContext(state), loaded: () => this.invalidate() }, this.#arranged.top);
    this.#pulseRects = [];
    if (state.show.footprint) {
      const marks = this.#footprintMarks.get(this.#footprint, state.barStatOptions), fp = state.footprint;
      // Zones and naked points of control only while the footprint itself shows, faded with it: zoomed out, its data is still loaded.
      if ((fp.zones || fp.nakedPoc) && this.#lodFrame.barAlpha > 0.05 && state.seriesInstrument === state.marketId) {
        const tfMs = TIMEFRAMES[state.timeframe] ?? 3_600_000;
        paintRuns(ctx, this.#footprintRuns.get(this.#footprintMarks.key, marks, state.candles, tfMs, this.#footprint.step, pageNow(), { zones: fp.zones, pocs: fp.nakedPoc }, v.t1), v, pw, ph, p, this.#lodFrame.barAlpha);
      }
      paintFootprint(ctx, this.#footprint, this.#lodFrame, state.timeframe, v, pw, ph, p, this.#trapMarks(), { marks, settings: fp, ...(replaying() ? { until: pageNow() } : {}) });
    }
    this.#startPulse();
    this.#labels.clear(); // the frame's labels begin here: the profiles' captions first, then the lines'
    this.#paintPastProfiles(ctx, state, pw, ph); // under the candles: the shape of each past window behind its own bars
    if (state.show.candles) this.#paintOverview(ctx, state, pw, ph);
    if (state.show.candles) this.#paintCandles(ctx, state, pw, ph, this.#lodFrame.narrowing);
    if (state.show.candles) this.#paintDivergences(ctx, state, pw, ph); // joined swings need the candles they join
    this.#paintTrace(ctx, state, pw, ph); // over the candles (hollow while the dust shows), under the bubbles
    this.#paintBubbles(ctx, state, pw, ph); // above the candles, so a large trade is never hidden behind one
    this.#paintLiquidations(ctx, state, pw, ph); // above the bubbles: a forced order is one of the market orders, marked as forced
    this.#paintAbsorption(ctx, state, pw, ph);
    // The Volume profile's, the key levels' and the VWAP's names at the lines' right ends share one board, so none is printed over another.
    this.#valueTags = this.#paintValueLines(ctx, state, pw, ph);
    this.#keyTags = state.keyLevels.on ? paintKeyLevels(ctx, this.#keyLevelLines(state), v, pw, ph, p, state.keyLevels, pageNow(), this.#keyLevelContext(state).zone, this.#labels) : [];
    this.#vwapTags = state.vwap.on ? paintVwap(ctx, this.#vwapLines(state), v, pw, ph, p, state.vwap, this.#labels) : [];
    this.scriptLayer?.(ctx, pw, ph);
    this.#drawTags = this.draw ? paintDrawings(ctx, this.draw, this.drawProjection(), p) : [];
    // Replay: nothing after its moment is shown (the heatmap under this canvas included), and a line marks it.
    if (replaying()) {
      const x = Math.max(0, Math.min(pw, v.xOf(pageNow(), pw)));
      if (x < pw) { ctx.fillStyle = p.bg; ctx.fillRect(x, 0, pw - x, ph); }
      ctx.strokeStyle = p.text; ctx.globalAlpha = 0.6; ctx.setLineDash([3, 3]); ctx.beginPath(); ctx.moveTo(Math.round(x) + 0.5, 0); ctx.lineTo(Math.round(x) + 0.5, ph); ctx.stroke(); ctx.setLineDash([]); ctx.globalAlpha = 1;
    }
    // The price line, in the colour of the candle under way (rising or falling), as is its tag on the axis.
    const mark = state.mark.price, side = lineSide(state.candles, state.seriesInstrument, state.marketId);
    const markColor = side === 'up' ? p.candleUp : side === 'down' ? p.candleDown : p.ask;
    if (mark > 0) {
      const y = v.yOf(mark, ph);
      if (y >= 0 && y <= ph) { ctx.strokeStyle = markColor; ctx.setLineDash([4, 3]); ctx.beginPath(); ctx.moveTo(0, y + 0.5); ctx.lineTo(pw, y + 0.5); ctx.stroke(); ctx.setLineDash([]); }
    }
    // profile column, traded-volume column and price axis
    // The liquidation column, then the profile column: the book as it is now, not shown in replay, which has no book of its moment.
    if (liqColumnShown(state)) this.#paintLiqColumn(ctx, state, pw, ph);
    if (state.show.profile && !replaying()) this.#paintProfile(ctx, state, pw, ph);
    if (this.#profileHover?.column === 'seam' && !replaying()) this.#paintSeam(ctx, state, pw, ph);
    if (tradedShown(state)) this.#paintTraded(ctx, state, pw, ph);
    this.#paintHidden(ctx, pw, ph);
    const axisX = w - AXIS_W;
    ctx.fillStyle = p.panel; ctx.fillRect(axisX, 0, AXIS_W, h);
    ctx.strokeStyle = p.line; ctx.beginPath(); ctx.moveTo(axisX + 0.5, 0); ctx.lineTo(axisX + 0.5, h); ctx.stroke();
    ctx.fillStyle = p.muted; ctx.textAlign = 'left';
    // The countdown to the candle's close sits under the price tag (above it at the foot of the axis), inside the band kept clear of other tags.
    const markY = Math.min(ph - 8, Math.max(8, v.yOf(mark, ph))), tf = TIMEFRAMES[state.timeframe] ?? 3_600_000;
    const clockText = mark > 0 && state.show.candles && !isPhone() ? countdown(pageNow(), tf) : null, clockBelow = markY + 9 + COUNTDOWN_H <= ph;
    const band = { y0: markY - 9 - (clockText && !clockBelow ? COUNTDOWN_H : 0), y1: markY + 9 + (clockText && clockBelow ? COUNTDOWN_H : 0) };
    const keyTags = placeKeyTags([...this.#drawTags, ...this.#valueTags, ...this.#keyTags, ...this.#vwapTags], mark > 0 ? [band] : [], ph);
    for (let q = Math.ceil(v.p0 / pStep) * pStep; q <= v.p1; q += pStep) { const y = v.yOf(q, ph); if (y > 6 && y < ph - 6 && !underTag(keyTags, y) && !(mark > 0 && y > band.y0 && y < band.y1)) ctx.fillText(fmtPrice(q, pStep), axisX + 6, y); }
    paintKeyTags(ctx, keyTags, axisX, AXIS_W, p);
    if (mark > 0) {
      const y = Math.min(ph - 8, Math.max(8, v.yOf(mark, ph)));
      ctx.fillStyle = markColor; ctx.fillRect(axisX + 1, y - 9, AXIS_W - 1, 18);
      ctx.fillStyle = textOn(markColor, 1, p); ctx.fillText(fmtPrice(mark), axisX + 6, y);
      if (clockText) {
        const top = clockBelow ? y + 9 : y - 9 - COUNTDOWN_H;
        ctx.fillStyle = p.panel; ctx.fillRect(axisX + 1, top, AXIS_W - 1, COUNTDOWN_H);
        ctx.strokeStyle = markColor; ctx.lineWidth = 1; ctx.strokeRect(axisX + 1.5, top + 0.5, AXIS_W - 2, COUNTDOWN_H - 1);
        ctx.fillStyle = p.text; ctx.font = '10px ui-monospace, SFMono-Regular, Menlo, monospace'; ctx.fillText(clockText, axisX + 6, top + COUNTDOWN_H / 2 + 0.5);
        ctx.font = '11px ui-sans-serif, system-ui, sans-serif';
      }
    }
    // time axis (under the columns left of the map too)
    ctx.fillStyle = p.panel; ctx.fillRect(-left, ph, w + left, TIME_H);
    ctx.fillStyle = p.muted; ctx.textAlign = 'center'; ctx.font = '11px ui-sans-serif, system-ui, sans-serif';
    for (const label of timeLabels) ctx.fillText(label.text, label.x, ph + TIME_H / 2);
    // Which clock the labels are on, under the price axis where no tick label goes (a screenshot says it too).
    ctx.textAlign = 'right'; ctx.fillText(zoneName(), w - 6, ph + TIME_H / 2); ctx.textAlign = 'center';
    this.#paintLegend(ctx, state);
    if (this.#bands.misplaced(this.#legendBox.bottom)) this.invalidate(); // the legend changed height: place the bands under it again
    if (!this.#wasLoaded && state.levels) { ctx.fillStyle = p.muted; ctx.textAlign = 'left'; ctx.fillText(t('Collecting depth history…'), 12, 50); }
    const emptyScope = heatmapSourceOf(state) === 'aggregated' ? emptyScopeMessage(state) : null;
    if (emptyScope) { // the filter selected nothing: say so instead of drawing a blank map
      ctx.font = '600 13px ui-sans-serif, system-ui, sans-serif'; const width = ctx.measureText(emptyScope).width + 28;
      ctx.fillStyle = p.panel; ctx.globalAlpha = 0.92; ctx.fillRect(pw / 2 - width / 2, ph / 2 - 20, width, 40); ctx.globalAlpha = 1;
      ctx.strokeStyle = p.line; ctx.strokeRect(pw / 2 - width / 2 + 0.5, ph / 2 - 19.5, width - 1, 39);
      ctx.fillStyle = p.text; ctx.textAlign = 'center'; ctx.fillText(emptyScope, pw / 2, ph / 2); ctx.textAlign = 'left'; ctx.font = '11px ui-sans-serif, system-ui, sans-serif';
    }
    this.#paintRange(ctx, state, pw, ph);
    this.#paintCrosshair(ctx, state, pw, ph);
    this.#paintDrawEdit();
  }

  /** What belongs to editing the drawings, on its own canvas over the map, in the plot's coordinates as the overlay draws. */
  #paintDrawEdit(): void {
    const ctx = this.#drawEditCtx;
    ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.clearRect(0, 0, this.#drawEdit.width, this.#drawEdit.height);
    if (!this.draw) return;
    ctx.setTransform(this.#dpr, 0, 0, this.#dpr, this.#dpr * this.#left, 0);
    const pr = this.drawProjection();
    paintEditing(ctx, this.draw, pr, this.#palette);
    this.onDrawFrame?.({ left: this.#left, pr, legendBottom: this.#legendBox.bottom });
  }

  /** The map's time and price in the plot's pixels and back, for the drawing tools. */
  drawProjection(): Projection {
    const v = this.view, w = this.plotW, h = this.plotH;
    return { x: t => v.xOf(t, w), y: q => v.yOf(q, h), t: x => v.tOf(x, w), p: y => v.pOf(y, h), w, h };
  }

  /**
   * The candle under `x` as the map draws it, for the magnet: the one whose drawn body (narrowed beside the footprint's rows) is nearest,
   * within its slot; its time is where its body is drawn (the middle of its slot, or left of it beside the footprint's rows), so a point
   * caught on it lands on the body seen.
   */
  candleAt(x: number): CandleUnder | null {
    const state = this.store.state; if (!state.show.candles) return null;
    const candles = this.candlesDrawn(state), tf = TIMEFRAMES[state.timeframe] ?? 3_600_000, v = this.view, pw = this.plotW, ph = this.plotH;
    if (!candles.length || !(pw > 0)) return null;
    const bar = Math.max(1, pw * tf / (v.t1 - v.t0)), layout = footprintLayout(bar), narrowing = this.#lodFrame.narrowing;
    const at = v.tOf(x, pw);
    // The candles are in time order: the one whose slot holds the pointer, and its neighbours (a narrowed body sits left of its slot's middle).
    let lo = 0, hi = candles.length - 1;
    while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (candles[mid]![0] <= at) lo = mid; else hi = mid - 1; }
    let best: CandleUnder | null = null, bestD = Infinity;
    for (let i = Math.max(0, lo - 1); i <= Math.min(candles.length - 1, lo + 1); i++) {
      const c = candles[i]!, xClassic = v.xOf(c[0] + tf / 2, pw), cx = xClassic + (v.xOf(c[0], pw) + layout.candleCenter - xClassic) * narrowing, d = Math.abs(cx - x);
      if (d > bar / 2 + 1 || d >= bestD) continue;
      best = { t: narrowing > 0 ? v.tOf(cx, pw) : c[0] + tf / 2, x: cx, open: c[1], high: c[2], low: c[3], close: c[4], y: q => v.yOf(q, ph) }; bestD = d;
    }
    return best;
  }

  /** The walls of resting liquidity in the heat map's column under `x`, among the rows in view (draw/magnet.ts `wallRows`). */
  wallsAt(x: number): { p: number; usd: number }[] {
    const g = this.#grid; if (!g || replaying()) return [];
    const key = this.#wallsKey(x, g), held = this.#walls;
    if (held && held.key === key && held.grid === g) return held.walls;
    const walls = this.#wallsOf(x, g);
    this.#walls = { key, grid: g, walls };
    return walls;
  }
  #walls: { key: string; grid: object; walls: { p: number; usd: number }[] } | null = null;
  #wallsKey(x: number, g: NonNullable<HeatPane['grid']>): string {
    const v = this.view, b = g.bounds, gx = Math.floor((v.tOf(x, this.plotW) - b.t0) / (b.t1 - b.t0) * g.w);
    return `${gx}|${v.p0}|${v.p1}`;
  }
  #wallsOf(x: number, g: NonNullable<HeatPane['grid']>): { p: number; usd: number }[] {
    const v = this.view, b = g.bounds, t = v.tOf(x, this.plotW), gx = Math.floor((t - b.t0) / (b.t1 - b.t0) * g.w);
    if (gx < 0 || gx >= g.w) return [];
    const row = (p: number): number => Math.floor((p - b.p0) / (b.p1 - b.p0) * g.h);
    const y0 = Math.max(0, row(v.p0)), y1 = Math.min(g.h - 1, row(v.p1));
    if (y1 <= y0) return [];
    const values = new Float32Array(y1 - y0 + 1);
    for (let y = y0; y <= y1; y++) { const i = (y * g.w + gx) * 2; values[y - y0] = g.data[i]! + g.data[i + 1]!; }
    return wallRows(values, i => b.p0 + (y0 + i + 0.5) / g.h * (b.p1 - b.p0));
  }

  /** The book's row around `price` now, in the rows the book profile beside the map shows: its resting USD by side and its size; null in a replay. */
  restingAt(price: number): { bid: number; ask: number; step: number } | null {
    const frame = this.store.state.levels; if (!frame || replaying()) return null;
    const v = this.view, step = niceStep(v.p1 - v.p0, this.plotH / 3);
    const g = groupLevels(this.kernels, frame, this.#enabledIds(), step, price - step, price + step), i = Math.floor(price / step) - g.bin0;
    if (i < 0 || i >= g.nBins) return { bid: 0, ask: 0, step };
    return { bid: g.totalBid[i]!, ask: g.totalAsk[i]!, step };
  }

  /** Centre the map on a stretch of time and prices (a drawing found in its list), widening the view where it does not fit. */
  focusOn(box: { t0: number; t1: number; p0: number; p1: number }): void {
    const v = this.view, span = Math.max(v.t1 - v.t0, (box.t1 - box.t0) * 1.4), pSpan = Math.max(v.p1 - v.p0, (box.p1 - box.p0) * 1.4);
    const tm = (box.t0 + box.t1) / 2, pm = (box.p0 + box.p1) / 2;
    v.set({ t0: tm - span / 2, t1: tm + span / 2, p0: pm - pSpan / 2, p1: pm + pSpan / 2 });
    this.store.set({ followLive: false }); this.#liveMargin = v.t1 - pageNow(); this.#rasteredKey = ''; this.onView(); this.invalidate();
  }

  /**
   * The Range tool's selection: a dashed box, or for a stretch of time a band the height of the map, lightly shaded. While it is dragged a
   * tag beside it gives its size (minutes, and a box's height as a share of its price).
   */
  #paintRange(ctx: CanvasRenderingContext2D, state: AppState, pw: number, ph: number): void {
    const sel = state.range; if (!sel) return;
    const v = this.view, p = this.#palette, box = sel.p0 !== null && sel.p1 !== null;
    const x0 = Math.max(-2, v.xOf(sel.t0, pw)), x1 = Math.min(pw + 2, v.xOf(sel.t1, pw));
    if (x1 < 0 || x0 > pw) return;
    const y0 = box ? Math.max(-2, v.yOf(sel.p1!, ph)) : -2, y1 = box ? Math.min(ph + 2, v.yOf(sel.p0!, ph)) : ph + 2;
    if (y1 < 0 || y0 > ph) return;
    ctx.save(); ctx.beginPath(); ctx.rect(0, 0, pw, ph); ctx.clip();
    ctx.fillStyle = p.text; ctx.globalAlpha = 0.07; ctx.fillRect(x0, y0, x1 - x0, y1 - y0); ctx.globalAlpha = 1;
    // A light edge under the dashes, so the box reads over dark cells, bright walls and bubbles alike.
    const rect = [Math.round(x0) + 0.5, Math.round(y0) + 0.5, Math.max(1, Math.round(x1 - x0) - 1), Math.max(1, Math.round(y1 - y0) - 1)] as const;
    ctx.strokeStyle = p.panel; ctx.lineWidth = 3; ctx.globalAlpha = 0.85; ctx.strokeRect(...rect); ctx.globalAlpha = 1;
    ctx.strokeStyle = p.text; ctx.lineWidth = 1; ctx.setLineDash([5, 4]); ctx.strokeRect(...rect); ctx.setLineDash([]);
    if (sel.draft) {
      const label = draftLabel(sel);
      ctx.font = '600 11px ui-sans-serif, system-ui, sans-serif'; ctx.textBaseline = 'middle'; ctx.textAlign = 'left';
      const w = ctx.measureText(label).width + 12, tx = Math.min(pw - w - 2, Math.max(2, x0)), ty = y0 > 24 ? y0 - 22 : Math.min(ph - 22, y1 + 4);
      ctx.fillStyle = p.panel; ctx.globalAlpha = 0.94; ctx.fillRect(tx, ty, w, 18); ctx.globalAlpha = 1;
      ctx.strokeStyle = p.line; ctx.strokeRect(tx + 0.5, ty + 0.5, w - 1, 17);
      ctx.fillStyle = p.text; ctx.fillText(label, tx + 6, ty + 9);
      ctx.font = '11px ui-sans-serif, system-ui, sans-serif';
    }
    ctx.restore();
  }

  /** A point of the map for the Range tool, held inside the plot. */
  #rangePoint(x: number, y: number): RangePoint {
    const pw = this.plotW, ph = this.plotH;
    return { t: this.view.tOf(Math.max(0, Math.min(pw, x)), pw), p: this.view.pOf(Math.max(0, Math.min(ph, y)), ph) };
  }

  #paintLegend(ctx: CanvasRenderingContext2D, state: AppState): void {
    const tf = TIMEFRAMES[state.timeframe] ?? 3_600_000, p = this.#palette;
    const under = (c: CandleRow): boolean => state.hover!.t >= c[0] && state.hover!.t < c[0] + tf;
    const hovered = state.hover ? state.candles.find(under) ?? this.historyCandles(state).find(under) : undefined;
    const c = hovered ?? state.candles[state.candles.length - 1];
    const name = state.marketId.replace(':', ' · ');
    const borrowed = state.seriesInstrument && state.seriesInstrument !== state.marketId ? `  ·  ${t('candles from {instrument}', { instrument: state.seriesInstrument.replace(':', ' · ') })}` : '';
    const title = `${name}  ${state.timeframe}${borrowed}`;
    // On a phone the plate has to fit the plot beside a narrow profile: whole prices, and the volume on the title's line.
    const phone = this.plotW < NARROW_PLOT, px = (value: number): string => phone && value >= 1000 ? fmtPrice(value, 1) : fmtPrice(value);
    let detail = '', tail = '', up = true;
    if (c) {
      up = c[4] >= c[1];
      const at = state.candles.indexOf(c), found = this.#volumeAnalysis(state).found, z = found.sigma[at], unusual = state.highlight.on && found.flag[at] === 1;
      if (phone) { detail = `O ${px(c[1])}  H ${px(c[2])}  L ${px(c[3])}  C ${px(c[4])}`; tail = `${t('Vol')} ${usd(c[5])}`; }
      else {
        detail = `O ${fmtPrice(c[1])}  H ${fmtPrice(c[2])}  L ${fmtPrice(c[3])}  C ${fmtPrice(c[4])}  ${t('Vol')} ${usd(c[5])}${unusual && Number.isFinite(z) ? `  ${t('({z}σ above its baseline)', { z: z!.toFixed(1) })}` : ''}`;
        // With the footprint on, the candle under the pointer says what its check found, or why it has none: no event and no data are different things.
        const check = hovered && state.show.footprint && this.#lodFrame.barAlpha >= 0.3 ? trapStatusText(this.#traps.decisionOf(hovered[0])) : null;
        if (check) { ctx.font = '11px ui-sans-serif, system-ui, sans-serif'; const extended = `${detail}  ·  ${check}`; if (ctx.measureText(extended).width < this.plotW - 40) detail = extended; }
      }
    }
    // A translucent plate keeps the text readable over bright heat.
    // The map's corner tools (Go to, Select, Recenter) lie over the top right of the plot: the text ends before them (with an ellipsis) instead of running under them.
    const corner = this.root.querySelector<HTMLElement>('.map-tools'), room = Math.max(160, this.plotW - 20 - (corner ? corner.offsetWidth + 8 : 0));
    ctx.font = '11px ui-sans-serif, system-ui, sans-serif';
    const wide = (text: string): number => ctx.measureText(text).width, tailW = tail ? wide(tail) + 10 : 0;
    detail = fitText(wide, detail, room);
    const extra = [phone && borrowed ? borrowed.replace(/^\s*·\s*/, '') : '', this.#overviewLegend(state)].filter(Boolean).join('  ·  ');
    const note = fitText(wide, extra, room), noteW = note ? wide(note) : 0, detailW = detail ? wide(detail) : 0;
    // The scripts drawn on the map, a line each under the candle's: a swatch of its colour, its name, its buttons right after the name
    // (where they stay whatever the values beside them, so they do not move from under a pointer coming to them), then its values at this
    // candle or what it is doing. At most a few, the others counted. In a phone's arrangement the buttons are a finger's size (as their
    // style makes them) and the lines as tall; there, and on a narrow map, the names alone.
    const touch = isPhone(), namesOnly = phone || touch, lineH = touch ? 24 : 16;
    const scripts = this.scriptLegend(hovered ? hovered[0] : null, namesOnly ? 0 : SCRIPT_LINES), listed = scripts.slice(0, SCRIPT_LINES), unlisted = scripts.length - listed.length;
    const toolsW = listed.map(s => s.tools * (touch ? SCRIPT_TOOL_W_TOUCH : SCRIPT_TOOL_W));
    const scriptNames = listed.map((s, k) => fitText(wide, s.name, room - toolsW[k]! - 30));
    const scriptValues = listed.map((s, k) => namesOnly || !s.text ? '' : fitText(wide, s.text, Math.max(0, room - 30 - wide(scriptNames[k]!) - toolsW[k]! - 12)));
    const moreScripts = unlisted > 0 ? tn(unlisted, '+{n} more script', '+{n} more scripts') : '';
    const scriptsW = Math.max(0, ...listed.map((_, k) => 18 + wide(scriptNames[k]!) + 6 + toolsW[k]! + (scriptValues[k] ? 6 + wide(scriptValues[k]!) : 0)), moreScripts ? wide(moreScripts) : 0);
    const textH = (detail ? 36 : 22) + (note ? 14 : 0), scriptRows = listed.length + (moreScripts ? 1 : 0);
    ctx.font = '600 12px ui-sans-serif, system-ui, sans-serif';
    const shownTitle = fitText(wide, phone ? `${name}  ${state.timeframe}` : title, room - tailW), titleW = wide(shownTitle);
    const plateW = Math.max(titleW + tailW, detailW, noteW, scriptsW) + 14, plateH = textH + (scriptRows ? scriptRows * lineH + 2 : 0);
    this.#legendBox = { right: 6 + plateW, bottom: 6 + plateH };
    ctx.globalAlpha = 0.82; ctx.fillStyle = p.panel; ctx.beginPath(); ctx.roundRect(6, 6, plateW, plateH, Math.min(6, this.#radius * 2)); ctx.fill(); ctx.globalAlpha = 1;
    ctx.textAlign = 'left'; ctx.fillStyle = p.text; ctx.font = '600 12px ui-sans-serif, system-ui, sans-serif';
    ctx.fillText(shownTitle, 12, 16);
    ctx.font = '11px ui-sans-serif, system-ui, sans-serif';
    if (tail) { ctx.fillStyle = p.muted; ctx.fillText(tail, 12 + titleW + 10, 16); }
    if (detail) { ctx.fillStyle = up ? p.candleUp : p.candleDown; ctx.fillText(detail, 12, 32); }
    // The note stands under the prices, or under the title where there are none (it stood below the plate then, over what follows).
    if (note) { ctx.fillStyle = p.muted; ctx.fillText(note, 12, detail ? 46 : 32); }
    const places: { id: string; x: number; y: number }[] = [];
    let y = 6 + textH + lineH / 2;
    listed.forEach((s, k) => {
      ctx.fillStyle = s.color || p.vwap; ctx.fillRect(12, y - 4, 8, 8);
      // Where no values are shown (names alone) the name carries the script's state: muted while it waits, red when it stopped.
      ctx.fillStyle = !scriptValues[k] && s.tone === 'error' ? p.ask : !scriptValues[k] && s.tone === 'muted' ? p.muted : p.text; ctx.fillText(scriptNames[k]!, 24, y);
      const toolsX = 24 + wide(scriptNames[k]!) + 6;
      places.push({ id: s.id, x: toolsX, y: y - (touch ? 11 : 8) });
      if (scriptValues[k]) { ctx.fillStyle = s.tone === 'error' ? p.ask : p.muted; ctx.fillText(scriptValues[k]!, toolsX + toolsW[k]! + 6, y); }
      y += lineH;
    });
    if (moreScripts) { ctx.fillStyle = p.muted; ctx.fillText(moreScripts, 12, y); }
    // The buttons are page elements over this canvas, placed in the pane's own pixels (the plot starts after the columns left of it).
    const canvas = ctx.canvas as HTMLCanvasElement;
    this.onScriptLegend(places.map(q => ({ id: q.id, x: canvas.offsetLeft + this.#left + q.x, y: canvas.offsetTop + q.y })));
  }

  /** Plan only when the data or a whole minute of the view changes; pointer redraws never scan coverage or start a read. */
  #ensureOverview(state: AppState): void {
    if (!state.show.candles || this.#suspended || this.root.hidden || document.hidden) { this.#overview = false; this.hub.priceHistory.stop(); return; }
    const v = this.view, tf = TIMEFRAMES[state.timeframe] ?? 3_600_000, now = Date.now(), history = this.hub.priceHistory;
    const key = `${state.marketId}|${state.seriesInstrument}|${tf}|${Math.floor(v.t0 / 60_000)}|${Math.ceil(v.t1 / 60_000)}|${Math.floor(now / 60_000)}|${this.plotW}|${history.answer?.tfMs ?? 0}`;
    let context = this.#overviewContext;
    if (!context || context.key !== key || context.candles !== state.candles) {
      // The candles that are drawn, whichever market they are of: the line is cut on exactly these, so a line is planned only where it will show.
      const wanted = priceOverviewNeeded(state.candles, tf, v, this.plotW, now);
      this.#overviewTarget = wanted ? priceTarget(currentCoin(), state.marketId, kindOf(state.markets, state.marketId) ?? 'perp') : null;
      const window = wanted && this.#overviewTarget ? priceWindow(v, this.plotW, now, history.answer?.tfMs, tf) : null;
      context = this.#overviewContext = { key, candles: state.candles, window };
    }
    this.#overview = context.window !== null && this.#overviewTarget !== null;
    if (this.#overview && context.window && this.#overviewTarget) history.ensure(this.#overviewTarget, context.window, () => { this.#fitOverview(); this.invalidate(); });
    else history.stop();
    if (this.#overview) this.#fitOverview();
  }

  #overviewRuns(): PricePoint[][] {
    const answer = this.hub.priceHistory.answer; if (!this.#overview || !answer) return [];
    const at = pageNow(), cut = replaying() || answer.asOf > at ? Math.floor(at / 1000) : 0;
    if (!this.#overviewPoints || this.#overviewPoints.answer !== answer || this.#overviewPoints.cut !== cut) this.#overviewPoints = { answer, cut, runs: pricePoints(answer, at, replaying()) };
    return this.#overviewPoints.runs;
  }

  /**
   * The line without the parts where the chart draws candles (Karl, 2026-10-24: the line across the candles was noise; it is for where the
   * chart has none): cut at the candles' edge, taken up after a gap in them. The candles that count are the ones drawn, `state.candles`.
   */
  #overviewLine(state: AppState): { t: number; price: number }[][] {
    const runs = this.#overviewRuns(), candles = state.candles, tfMs = TIMEFRAMES[state.timeframe] ?? 3_600_000;
    // The candles' coverage changes when one starts or the series is replaced, never when the forming one moves: the key names those.
    const key = `${candles.length}|${candles[0]?.[0] ?? 0}|${candles[candles.length - 1]?.[0] ?? 0}|${tfMs}`;
    if (this.#overviewDrawn?.runs !== runs || this.#overviewDrawn.key !== key) { const covered = candleCoverage(candles, tfMs); this.#overviewDrawn = { runs, key, drawn: uncoveredRuns(runs, covered), covered }; }
    return this.#overviewDrawn.drawn;
  }

  /** Whether the price history is drawn as candles: it is of the chart's timeframe and of the market the chart's candles are of. */
  #historyAsCandles(state: AppState, answer: PriceHistoryAnswer): boolean {
    return answer.tfMs === (TIMEFRAMES[state.timeframe] ?? 3_600_000) && answer.instrumentId === priceInstrument(state.seriesInstrument || state.marketId);
  }

  /**
   * The exchange's candles of the chart's own timeframe and market where the chart's candles do not reach (before them, in a hole between
   * them, or all of them while the chart's are on their way), from the price history (Karl, 2026-10-28: history drawn as the recorded
   * candles are, not as a line). They are drawn as candles, said under the pointer, caught by the magnet and added to the Volume bars as
   * the candles' part. None while the history is coarser (a long view: the line stands in for it) or of another market (its line is dashed).
   */
  historyCandles(state: AppState): readonly CandleRow[] {
    const answer = this.hub.priceHistory.answer, tf = TIMEFRAMES[state.timeframe] ?? 3_600_000;
    if (!this.#overview || !answer || !answer.candles.length || !this.#historyAsCandles(state, answer)) return [];
    const candles = state.candles, at = pageNow(), replay = replaying(), cut = replay ? Math.floor(at / tf) : 0;
    const key = `${candles.length}|${candles[0]?.[0] ?? 0}|${candles[candles.length - 1]?.[0] ?? 0}|${cut}`;
    if (this.#history?.answer !== answer || this.#history.key !== key) {
      const starts = new Set(candles.map(c => c[0])), last = candles[candles.length - 1]?.[0] ?? Infinity;
      this.#history = { answer, key, rows: answer.candles.filter(c => c[0] < last && !starts.has(c[0]) && (!replay || c[0] + tf <= at)) as CandleRow[] };
    }
    return this.#history.rows;
  }

  /** The chart's candles with the exchange's before them and in their holes (`historyCandles`), in time order. */
  candlesDrawn(state: AppState): readonly CandleRow[] {
    const history = this.historyCandles(state), candles = state.candles;
    if (!history.length) return candles;
    if (this.#allCandles?.history !== history || this.#allCandles.candles !== candles) {
      const before = !candles.length || history[history.length - 1]![0] < candles[0]![0];
      this.#allCandles = { history, candles, rows: before ? [...history, ...candles] : [...history, ...candles].sort((a, b) => a[0] - b[0]) };
    }
    return this.#allCandles.rows;
  }

  #fitOverview(): void {
    const pending = this.#priceFit, v = this.view, answer = this.hub.priceHistory.answer;
    if (!pending || !answer || !this.#overviewTarget) return;
    if (v.t0 !== pending.t0 || v.t1 !== pending.t1 || v.p0 !== pending.p0 || v.p1 !== pending.p1) { this.#priceFit = null; return; }
    const bounds = priceBounds(answer, this.#overviewTarget.id, v, pageNow(), replaying());
    if (!bounds) return;
    const { lo, hi } = bounds;
    const pad = (hi - lo) * 0.18; v.p0 = lo - pad; v.p1 = hi + pad; this.#priceFit = null; this.#rasteredKey = '';
  }

  #overviewLegend(state: AppState): string {
    if (!this.#overview) return '';
    const h = this.hub.priceHistory, a = h.answer, target = this.#overviewTarget;
    let text = '';
    if (a?.candles.length && target) {
      const tf = Object.entries(TIMEFRAMES).find(([, ms]) => ms === a.tfMs)?.[0] ?? '';
      const market = `${venueLabel(a.instrumentId)} ${target.listing.symbol} ${target.kind === 'spot' ? t('Spot') : t('Perp')}`;
      text = t('Price · {market} · {timeframe}', { market, timeframe: tf });
      // The price only where the line is drawn: over a candle the candle says it, and the line's close would be one nothing on the chart shows.
      this.#overviewLine(state);
      const at = state.hover?.t ?? Math.min(pageNow(), this.view.t1);
      const point = this.#historyAsCandles(state, a) || isCovered(this.#overviewDrawn?.covered ?? [], at) ? null : pricePointAt(this.#overviewRuns(), at, a.tfMs);
      if (point) text += `  ${fmtPrice(point.price)}`;
    }
    const status = h.status === 'stale' ? t('Price history is stale; trying again in a minute.') : h.status === 'failed' ? t('Price history could not be loaded; trying again in a minute.') : h.status === 'empty' ? t('No price history for this time.') : !a?.candles.length ? t('Reading price history…') : '';
    return [text, status].filter(Boolean).join('  ·  ');
  }

  /** A true price series; separate paths preserve exchange gaps and never splice a reference market into the selected market's live trades. */
  #paintOverview(ctx: CanvasRenderingContext2D, state: AppState, pw: number, ph: number): void {
    const answer = this.hub.priceHistory.answer; if (!this.#overview || !answer || this.#historyAsCandles(state, answer)) return;
    const runs = this.#overviewLine(state), v = this.view, p = this.#palette;
    ctx.save(); ctx.beginPath(); ctx.rect(0, 0, pw, ph); ctx.clip(); ctx.lineJoin = 'round';
    ctx.globalAlpha = 0.9 * (1 - 0.85 * this.#lodFrame.barAlpha);
    if (priceInstrument(state.marketId) !== answer.instrumentId) ctx.setLineDash([5, 3]);
    ctx.beginPath();
    for (const run of runs) {
      let started = false;
      for (const point of run) {
        if (point.t < v.t0 - answer.tfMs || point.t > v.t1 + answer.tfMs) continue;
        const x = v.xOf(point.t, pw), y = v.yOf(point.price, ph);
        if (started) ctx.lineTo(x, y); else { ctx.moveTo(x, y); started = true; }
      }
    }
    ctx.lineWidth = 3.5; ctx.strokeStyle = p.dark ? 'rgba(0,0,0,0.65)' : 'rgba(255,255,255,0.85)'; ctx.stroke();
    ctx.lineWidth = 1.5; ctx.strokeStyle = p.dark ? '#ffffff' : '#111318'; ctx.stroke(); ctx.restore();
  }

  /**
   * Where the recorded depth begins, when that is inside the view: a page that reads the exchanges itself records only while it is
   * open, so the map to the left of this line is empty by nature and the line says so rather than leaving it to look broken.
   */
  /**
   * The price lines through the dust: the chart market's (its orders reduced to each pixel column's first, extremes and last price, over a
   * dark edge so it reads over any colour), and with Venue lines every other market shown, faint. Before the page held orders, the chart
   * market's line comes dashed from its prices a second where the flow column holds them. A line breaks where its market traded nothing
   * for ten seconds (or three columns).
   */
  #paintTrace(ctx: CanvasRenderingContext2D, state: AppState, pw: number, ph: number): void {
    const tape = this.hub.tape;
    if (!this.#dustOn(state) || !tape) return;
    const v = this.view, p = this.#palette, ms = (v.t1 - v.t0) / pw, c0 = Math.floor(v.t0 / ms), c1 = Math.ceil(v.t1 / ms), gap = traceGapColumns(ms);
    const fade = 1 - 0.85 * this.#lodFrame.barAlpha;
    if (fade <= 0.02) return;
    const stroke = (runs: number[][], color: string, width: number, alpha: number): void => {
      ctx.strokeStyle = color; ctx.lineWidth = width; ctx.globalAlpha = alpha * fade; ctx.beginPath();
      for (const run of runs) for (let i = 0; i < run.length; i += 2) { const x = v.xOf((run[i]! + 0.5) * ms, pw), y = v.yOf(run[i + 1]!, ph); if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y); }
      ctx.stroke();
    };
    ctx.save(); ctx.beginPath(); ctx.rect(0, 0, pw, ph); ctx.clip(); ctx.lineJoin = 'round';
    if (tape.written > 0) this.#trace.update(tape, v.t0, v.t1, ms);
    const chart = tape.ids.indexOf(state.marketId), off = state.disabledVenues;
    if (state.tradeBubbles.venueLines && tape.written > 0) {
      const colors = curveColors(p, 8);
      tape.ids.forEach((id, i) => { if (i !== chart && !off.includes(id.slice(0, id.indexOf(':')))) stroke(this.#trace.path(i, c0, c1, gap), colors[i % colors.length]!, 1, 0.55); });
    }
    // Before the orders held, the chart market's prices a second, dashed (they are averages over a second, not each order).
    const held = tape.written > 0 ? (tape.segments[0]?.from ?? v.t1) : v.t1, series = this.hub.flow.get(state.marketId);
    if (series && held > v.t0 && (Math.min(v.t1, held) - v.t0) / 1000 <= 200_000) {
      // Worked out again only when the market, the zoom, the seconds in view or the flow held change: never for a pointer move.
      const s0 = Math.floor(v.t0 / 1000), s1 = Math.floor(Math.min(v.t1, held) / 1000), key = `${state.marketId}|${ms}|${s0}|${s1}|${this.hub.flow.loads}`;
      if (this.#secondsRuns?.key !== key) this.#secondsRuns = { key, runs: secondsPath(sec => series.ownPrice(sec), s0, s1, ms, 10) };
      const runs = this.#secondsRuns.runs;
      ctx.setLineDash([4, 3]); stroke(runs, p.bg, 3, 0.5); stroke(runs, p.dark ? '#ffffff' : '#111318', 1.2, 0.75); ctx.setLineDash([]);
    }
    // Neutral, never a side's colour (a theme's text colour can be the buy green): white over a dark map, near-black over a light one.
    const ink = p.dark ? '#ffffff' : '#111318';
    if (chart >= 0) { const runs = this.#trace.path(chart, c0, c1, gap); stroke(runs, p.bg, 3.5, 0.6); stroke(runs, ink, 1.5, 0.95); }
    ctx.restore();
  }

  /** Where the live trades begin (the page opened, or the ring let the oldest go), and each gap after the price line breaks at: a dotted line and a short note. */
  #paintTapeStart(ctx: CanvasRenderingContext2D, state: AppState, pw: number, ph: number, p: Palette): void {
    const tape = this.hub.tape, v = this.view;
    if (!this.#dustOn(state) || !tape || !tape.segments.length) return;
    const from = Math.max(tape.segments[0]!.from, tape.heldFrom), marks = [{ t: from, label: t('live trades from {time}', { time: clock(from) }) }];
    for (const at of gapMarks(tape.segments, from, (v.t1 - v.t0) / pw)) marks.push({ t: at, label: t('gap in live trades') });
    ctx.save(); ctx.font = '10px ui-sans-serif, system-ui, sans-serif'; ctx.textBaseline = 'bottom'; ctx.textAlign = 'left';
    for (const m of marks) {
      if (!(m.t > v.t0 && m.t < v.t1)) continue;
      const x = Math.round(v.xOf(m.t, pw)) + 0.5;
      ctx.strokeStyle = p.muted; ctx.globalAlpha = 0.5; ctx.setLineDash([1, 3]); ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, ph); ctx.stroke(); ctx.setLineDash([]);
      ctx.fillStyle = p.muted; ctx.globalAlpha = 0.85; ctx.fillText(m.label, x + 5, ph - 6);
    }
    ctx.restore();
  }

  #paintHistoryStart(ctx: CanvasRenderingContext2D, pw: number, ph: number, p: Palette): void {
    const since = this.hub.recordedSince, v = this.view;
    this.#historyNote = null;
    if (!(since > v.t0 && since < v.t1)) return;
    const x = Math.round(v.xOf(since, pw)) + 0.5, text = t('depth recorded from {time}', { time: clock(since) });
    ctx.save();
    ctx.strokeStyle = p.muted; ctx.globalAlpha = 0.55; ctx.setLineDash([2, 4]);
    ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, ph); ctx.stroke(); ctx.setLineDash([]);
    ctx.font = '10px ui-sans-serif, system-ui, sans-serif'; ctx.fillStyle = p.muted; ctx.globalAlpha = 0.85; ctx.textBaseline = 'top';
    // Left of the line where it fits (measured, so in any language), else on the side with more room, ending in "…" if even that is too short.
    const wide = (words: string): number => ctx.measureText(words).width, room = Math.max(x - 12, pw - x - 12);
    const label = wide(text) <= room ? text : fitText(wide, text, room);
    // The legend plate takes the top-left corner of the map: a note that would run under it goes beneath it instead.
    const w = ctx.measureText(label).width, right = x >= w + 12, left = right ? x - 6 - w : x + 6, box = this.#legendBox;
    let top = left < box.right + 8 ? box.bottom + 6 : 6;
    // Select and Recenter sit in the top-right corner of the map on the full toolbar: the note does not run under them.
    const corner = this.root.querySelector<HTMLElement>('.map-tools');
    if (top < 40 && corner && (right ? x - 6 : x + 6 + w) > pw - corner.offsetWidth - 16) top = 40;
    if (right) { ctx.textAlign = 'right'; ctx.fillText(label, x - 6, top); } else { ctx.textAlign = 'left'; ctx.fillText(label, x + 6, top); }
    this.#historyNote = { x0: left, x1: left + w, top };
    ctx.restore();
  }

  /**
   * Liquidation levels (the Chart deck's Liq levels): the prices that would liquidate Hyperliquid's open BTC positions (the levels file,
   * from HyperTracker's snapshots), as a stripe right of the live edge so the heatmap's past keeps its own colours: what waits ahead of the
   * price, gone once price trades through it; a note under the legend says where they come from and how old they are.
   */
  #paintLiquidationLevels(ctx: CanvasRenderingContext2D, state: AppState, pw: number, ph: number): void {
    const src = this.hub.liqLevels, p = this.#palette, v = this.view;
    src.ensure(currentCoin(), () => this.invalidate());
    // They are on unless switched off, so where they cannot be (no address, another coin, a replay) the map says nothing: the button's panel
    // says why.
    if (src.state === 'off' || src.state === 'other-coin' || replaying()) return;
    const levels = src.levels;
    if (levels) src.observe(this.#dollarPrice(state));
    let note: string;
    if (!levels) note = src.state === 'unavailable' ? t('Liquidation levels could not be read.') : t('Liquidation levels are loading.');
    else if (src.state === 'stale') note = t('Liquidation levels are out of date: the newest are from {time}.', { time: clock(levels.asOf) });
    else note = t('Hyperliquid liquidation levels at {time} · Powered by HyperTracker', { time: clock(levels.asOf) });
    if (levels && src.state === 'ready') {
      const x0 = this.#liqStripeLeft(pw);
      if (x0 < pw - 8) {
        const { rows, heat } = this.#liqRowsDrawn(levels, ph);
        paintLiqStripe(ctx, v, x0, pw, ph, rows, heat, { long: p.candleDown, short: p.candleUp, text: p.text, muted: p.muted, bg: p.bg });
      }
      if (src.candlesLate()) note = `${note} · ${t('Hyperliquid\'s candles could not be read, so a level price has passed may still show.')}`;
    }
    ctx.save();
    ctx.font = '10px ui-sans-serif, system-ui, sans-serif'; ctx.textBaseline = 'top'; ctx.textAlign = 'left';
    const label = fitText(words => ctx.measureText(words).width, note, Math.max(40, pw - 24)), w = ctx.measureText(label).width;
    // Under the legend, a line lower where the "depth recorded from" note already stands there.
    const h = this.#historyNote, top = this.#legendBox.bottom + 6, below = h && Math.abs(h.top - top) < 12 && h.x0 < 8 + w + 6 && h.x1 > 2;
    ctx.fillStyle = p.muted; ctx.globalAlpha = 0.9; ctx.fillText(label, 8, below ? top + 13 : top);
    ctx.restore();
  }

  /** Where the liquidation stripe begins: the live edge (the plot's left edge when that is off to the left). */
  #liqStripeLeft(pw: number): number { return Math.max(0, Math.round(this.view.xOf(pageNow(), pw))); }

  /** The rows in view with their colour scale, as drawn; grouped again only when the levels, what price has taken or the rows on screen change. */
  #liqRowsDrawn(levels: LiqLevels, ph: number): { rows: LiqRow[]; heat: (usd: number) => number } {
    const v = this.view, per = binsPerRow(levels.step, v, ph), span = per * levels.step, g0 = Math.floor(v.p0 / span), g1 = Math.ceil(v.p1 / span);
    const key = `${this.hub.liqLevels.key()}|${per}|${g0}|${g1}`;
    if (this.#liqRows?.key !== key) {
      const rows = liqRows(levels, this.hub.liqLevels.taken(), per, g0 * span, g1 * span);
      this.#liqRows = { key, rows, heat: standingHeat(rows) };
    }
    return this.#liqRows;
  }

  /** The chart's price when it is in dollars (a dollar or a dollar stablecoin), else NaN: Liquidation levels compare it with Hyperliquid's. */
  #dollarPrice(state: AppState): number { return dollarPriceOf(state); }

  /** The price Liquidation levels measure from: the chart's when it is in dollars, else Hyperliquid's as last read. */
  #liqPrice(state: AppState): number {
    const own = this.#dollarPrice(state);
    return own > 0 ? own : this.hub.liqLevels.lastPrice();
  }

  /**
   * What a liquidation level under the pointer holds, for the hover box: only on the stripe, on a row strong enough to be drawn there. It
   * says what would be liquidated at that level (and how much of it still stands), how far it is from the price and how much would be
   * liquidated on the way there (the profile column's faint bar, as a number), how many positions make it up and how big the largest is, and
   * how much is isolated (a fixed price) or cross margin (a price that moves with the account).
   */
  #liquidationLines(state: AppState, x: number, y: number, pw: number, ph: number, touch: boolean): InfoLine[] {
    const src = this.hub.liqLevels, levels = src.levels, v = this.view;
    if (!levels || replaying() || src.state !== 'ready' || x < this.#liqStripeLeft(pw)) return [];
    const { rows, heat } = this.#liqRowsDrawn(levels, ph), slop = touch ? 6 : 2;
    const shown = (r: LiqRow, side: 'long' | 'short'): boolean => r[`${side}Left`] > 0 && heat(r[`${side}Left`]) > 0;
    let row: LiqRow | null = null, best = Infinity;
    for (const r of rows) {
      const top = v.yOf(r.p1, ph), bottom = v.yOf(r.p0, ph);
      if (y < top - slop || y > bottom + slop || !(shown(r, 'long') || shown(r, 'short'))) continue;
      const d = Math.abs(y - (top + bottom) / 2);
      if (d < best) { best = d; row = r; }
    }
    if (!row) return [];
    const price = this.#liqPrice(state), standing = src.standing(), lines: InfoLine[] = [];
    for (const side of ['long', 'short'] as const) {
      if (!shown(row, side)) continue;
      const total = row[side], left = row[`${side}Left`], iso = row[`${side}Iso`], top = row[`${side}Top`];
      lines.push({ text: side === 'long' ? t('Long liquidations') : t('Short liquidations'), color: side === 'long' ? 'sell' : 'buy', bold: true, rule: true });
      lines.push({ label: t('At this level'), text: left < total * 0.995 ? t('{left} of {total}', { left: `$${usd(left)}`, total: `$${usd(total)}` }) : `$${usd(total)}`, bold: true });
      // Measured from the edge price reaches first; on the way there, everything that still stands between the price and this level.
      const edge = side === 'long' ? row.p1 : row.p0;
      if (price > 0) lines.push({ label: t('Distance'), text: distanceText(edge, price) });
      if (price > 0 && standing) {
        const way = side === 'long' ? standingBelow(standing, 'long', price) - standingBelow(standing, 'long', row.p0) : standingBelow(standing, 'short', row.p1) - standingBelow(standing, 'short', price);
        lines.push({ label: t('If price gets here'), text: `$${usd(Math.max(0, way))}` });
      }
      lines.push({ label: t('Positions'), text: String(row[`${side}Wallets`]) });
      if (top > 0) lines.push({ label: t('Largest position'), text: `$${usd(top)} (${Math.round(top / total * 100)}%)` });
      lines.push({ label: t('Isolated / cross margin'), text: `$${usd(iso)} / $${usd(total - iso)}` });
    }
    return lines;
  }

  #paintLayers(ctx: CanvasRenderingContext2D, state: AppState, pw: number, ph: number): void {
    if (state.layer === 'liquidity') return;
    const levels = state.layers[state.layer] ?? [];
    if (!levels.length) return;
    const max = Math.max(...levels.map(l => l.notionalUsd), 1);
    const p = this.#palette;
    for (const level of levels) {
      const y = this.view.yOf(level.price, ph);
      if (y < 0 || y > ph) continue;
      // Provider levels are coloured by where they sit relative to price: ask colour above the mark, bid colour below.
      ctx.fillStyle = level.price >= state.mark.price ? p.ask : p.bid; ctx.globalAlpha = 0.18 + 0.7 * Math.sqrt(level.notionalUsd / max);
      ctx.fillRect(0, y - 1.5, pw, 3);
    }
    ctx.globalAlpha = 1;
  }

  /** Volume baseline and anomaly flags for the candles on screen, recomputed only when the candles or the sensitivity change. */
  #volumeAnalysis(state: AppState): VolumeAnalysis {
    const key = `${state.highlight.mult}|${state.highlight.length}`;
    if (this.#volume && this.#volume.candles === state.candles && this.#volume.key === key) return this.#volume;
    const values = new Float64Array(state.candles.length);
    for (let i = 0; i < values.length; i++) values[i] = state.candles[i]![5];
    this.#volume = { candles: state.candles, key, found: anomalies(values, state.highlight) };
    return this.#volume;
  }

  /**
   * Volume histogram along the bottom of the chart. Ordinary bars stay dim; bars above the rolling mean + k sigma are full strength,
   * the dashed line is that threshold, and a faint column behind an anomalous bar marks its time slot all the way up the chart.
   */
  #paintVolume(ctx: CanvasRenderingContext2D, state: AppState, pw: number, ph: number, narrowing: number): void {
    this.#strip = null;
    if (!state.show.volume || !this.candlesDrawn(state).length) return;
    const chartTf = TIMEFRAMES[state.timeframe] ?? 3_600_000, v = this.view, p = this.#palette;
    // Zoomed out until the chart's bars would be narrower than STRIP_MIN_PX, the strip's are of a longer timeframe: what the venues traded
    // in it where the recording reaches, the exchange's own candles of it before (Karl, 2026-10-30: thousands of hourly bars froze the page).
    // Beside the footprint's rows the bars are the chart's candles, so they narrow with it only then.
    const { ms: tf, name: tfName } = stripTimeframe(chartTf, v.t1 - v.t0, pw), coarse = tf !== chartTf;
    if (coarse) narrowing = 0;
    const slot = Math.max(1, pw * tf / (v.t1 - v.t0)), layout = footprintLayout(slot);
    const normal = candleBody(slot), body = Math.max(1, (normal + (Math.max(1, layout.body) - normal) * narrowing));
    // A profile by time where the recording reaches, the market's own candles before it (measures/volume-strip.ts, Karl, 2026-10-20): the
    // venues' flow on the candles' boundaries, from a run of the Highlights' length before the screen so their baseline starts on it.
    const now = pageNow(), ids = flowIds(state, this.hub.flow.ids), tracks = ids.flatMap(id => { const k = this.hub.flow.track(id); return k ? [k] : []; });
    const margin = Math.max(0, state.highlight.length) * tf, asked = askedSpan(Math.floor((v.t0 - margin) / tf) * tf, Math.min(v.t1, now));
    let rows: TimeRows | null = null;
    if (tracks.length && asked.to > asked.from) {
      ensureDeltaFlow(this.hub, flowLoadIds(state, this.hub.flow.ids), asked.from, Date.now());
      // The closed buckets worked out once (again only when the flow loads more or the markets change), the one under way each second.
      const from = Math.floor(asked.from / tf) * tf, open = Math.max(from, Math.min(asked.to, Math.floor(now / tf) * tf));
      const key = `${tf}|${from}|${open}|${ids.join(',')}|${this.hub.flow.loads}`;
      if (this.#stripRows?.key !== key) this.#stripRows = { key, rows: flowRows(tracks, from, open, tf, now) };
      rows = asked.to > open ? joinRows(this.#stripRows.rows, flowRows(tracks, open, asked.to, tf, now)) : this.#stripRows.rows;
    }
    // The seam is where the recording kept begins (`recordedSince`, as the status bar says it), not where the flow loaded so far reaches: a
    // stretch still loading is a gap that fills in, never a candle that flashes over recorded history.
    const since = this.hub.recordedSince > 0 ? this.hub.recordedSince : rows?.recordedSince ?? null;
    // Before the recording: the chart market's candles, split by their taker buys where the exchange says them (Binance's, read by the page).
    // The candles are the series the chart reads (`seriesInstrument`: another market's when the chart's own has none), named and split as it.
    const series = state.seriesInstrument || state.marketId, target = historyTarget(series, currentCoin()), venue = target?.id.slice(0, target.id.indexOf(':')) ?? '';
    const binance = !!target && target.own && (venue === 'binance' || venue === 'binancespot'), market = venueLabel(target?.own ? target.id : series);
    // Where the view begins before the chart's first candle, the exchange's own candles of the timeframe stand in back to its start
    // (`stripHistoryFrom`): those read before for a wider view are drawn too, wherever they fall in it.
    const drawn = this.candlesDrawn(state);
    let own: ReadonlyMap<number, CandleRow> | null = null, candles = drawn;
    if (coarse) {
      // The exchange's candles of the strip's timeframe from the view's start (with the Highlights' run before it), and the chart's added up
      // into it where those are not (yet) there, or for a market whose exchange does not say who bought.
      const earliest = Math.floor((v.t0 - margin) / tf) * tf;
      const exchange = binance && (since === null || earliest < since) ? this.#coarseTaker.get(this.hub, state, tf, earliest, () => this.invalidate()) : null;
      const held = this.#coarseCandles;
      if (held?.drawn !== drawn || held.exchange !== exchange || held.tf !== tf) this.#coarseCandles = { drawn, exchange, tf, ...coarseCandles(drawn, chartTf, tf, exchange) };
      candles = this.#coarseCandles!.rows; own = this.#coarseCandles!.own;
    } else {
      const firstDrawn = drawn[0]![0], reach = binance ? stripHistoryFrom(firstDrawn, v.t0 - margin, tf) : Infinity;
      const earliest = Math.min(reach, drawn.find(c => c[0] + tf >= v.t0 - margin)?.[0] ?? v.t0);
      let taker: Map<number, CandleRow> | null = null;
      if (binance && (since === null || earliest < since)) own = taker = this.takerRows(state, tf, earliest);
      if (taker && reach < firstDrawn) {
        if (this.#stripCandles?.drawn !== drawn || this.#stripCandles.own !== taker) this.#stripCandles = { drawn, own: taker, rows: withEarlier(drawn, taker, firstDrawn) };
        candles = this.#stripCandles.rows;
      }
    }
    const place = (start: number): { x: number; w: number } => { const xc = v.xOf(start + tf / 2, pw); return { x: xc + (v.xOf(start, pw) + layout.candleCenter - xc) * narrowing, w: body }; };
    const all = stripBars(candles, tf, rows, since, now, v.t0 - margin, v.t1, place, start => own?.get(start), replaying());
    const first = all.findIndex(b => b.t + tf >= v.t0), cut = first < 0 ? all.length : first, bars = all.slice(cut);
    const found = state.highlight.on ? this.#stripHighlights.of(all, state.highlight) : null, highlights = found ? { flag: found.flag.slice(cut), threshold: found.threshold.slice(cut) } : null;
    const height = volumeBand(ph), top = ph - height - 6;
    const total = bars.reduce((sum, b) => b.source === 'recorded' ? sum + b.buy + b.sell : sum, 0);
    const hv = state.hover, hy = hv && hv.source === 'heat' && hv.price !== null ? v.yOf(hv.price, ph) : NaN, hx = hv ? v.xOf(hv.t, pw) : NaN;
    const hovered = hy >= top && hy <= ph ? bars.findIndex(b => Math.abs(hx - b.x) <= Math.max(b.w, slot) / 2) : -1;
    // The candles' part named ≈ while any of its bars is an estimate (its volume at its typical price), plainly where all are as reported.
    const estimated = bars.some(b => b.source === 'candle' && !b.exact);
    paintVolumeStrip(ctx, bars, { pw, ph, height, palette: p, bars: state.traded.bars, emphasis: state.traded.emphasis, highlights,
      recorded: `${t('Volume')} · ${tfName}`, candles: estimated ? t('≈ {market} {tf} candles', { market, tf: tfName }) : t('{market} {tf} candles', { market, tf: tfName }), hovered });
    this.#strip = { bars, rows, ids, tf, top, market, tfName, reports: binance, total };
  }

  /**
   * The market orders of a recorded strip bar, from the footprint's statistics of the strip's own markets for that candle (one request, rows
   * of the whole range, the whale size as a line, each market's part), read once the pointer rests on it; undefined for a bar of no recording
   * or with too many markets for one question. In a replay only the minutes before the replay's time are asked. An answer without the bar
   * fails (asked again later): a bar the recording holds has its minutes, so its absence is not a candle without statistics.
   */
  #stripOrders(state: AppState, s: StripState, bar: StripBar, whale: number): ReturnType<StripOrderCache['want']> | undefined {
    const to = replaying() ? Math.min(bar.t + s.tf, Math.floor(pageNow() / 60_000) * 60_000) : bar.t + s.tf;
    // A bar of a longer timeframe than the chart's (zoomed out, `stripTimeframe`) is several of the footprint's candles: not asked.
    if (bar.source === 'candle' || bar.source === 'gap' || !s.ids.length || s.ids.length > MAX_PROFILE_INSTRUMENTS || !(to > bar.t) || s.tf !== (TIMEFRAMES[state.timeframe] ?? 3_600_000)) { this.#orders.rest(); return undefined; }
    // The whale size is part of the question: another size is other whale dollars, even where neither is asked as a line.
    const cuts = linesToAsk([state.barStatOptions.whaleUsd], scaledUsd), index = cuts.findIndex(c => Math.abs(c - whale) <= 1e-6 * whale), inst = s.ids.join(',');
    const key = `${inst}|${state.timeframe}|${bar.t}|${cuts.join(',')}|${whale}`, open = bar.t + s.tf + FOOTPRINT_SETTLE_MS > Date.now();
    return this.#orders.want(key, { to, open }, at => this.hub.footprint(inst, state.timeframe, bar.t, at, WHOLE_RANGE_STEP, cuts, undefined, s.ids.length > 1).then(body => {
      const raw = body.bars.find(b => b.t === bar.t);
      if (!raw) throw new Error('the candle is not in the answer');
      return stripOrdersOf(readBar(raw, cuts.length, body.venues), { size: whale, index }, s.tf);
    }), () => this.invalidate());
  }

  /** The volume strip's bar under the pointer, while it is over the strip (the strip owns its rectangle). */
  #stripAt(x: number, y: number, ph: number, pw: number): number {
    const s = this.#strip; if (!s || y < s.top || y > ph) return -1;
    const slot = Math.max(1, pw * s.tf / (this.view.t1 - this.view.t0));
    return s.bars.findIndex(b => Math.abs(x - b.x) <= Math.max(b.w, slot) / 2);
  }

  /**
   * Large executed trades as bubbles at their time and price, coloured by the side that took liquidity, their area in proportion to the
   * notional with the largest in view the biggest (see bubbleRadius). Only the
   * biggest few hundred in view are drawn, so zooming out keeps the picture about size; trades at or above the whale tier get a glow.
   * They fade under the footprint, whose rows say the same thing in more detail. A bubble large enough carries its exchange's mark, and
   * while the pointer is on one, the bubbles of the other venues step back and that venue's own are ringed: where else it traded.
   */
  #paintBubbles(ctx: CanvasRenderingContext2D, state: AppState, pw: number, ph: number): void {
    this.#bubbles = [];
    if (!state.show.bubbles) return;
    const v = this.view, p = this.#palette, fade = 1 - 0.85 * this.#lodFrame.barAlpha;
    if (fade <= 0.02) return;
    const limit = Math.max(40, Math.min(400, Math.round(pw / 9)));
    const s = state.tradeBubbles, off = state.disabledVenues;
    const hidden = (print: Print): boolean => bubbleHidden(print, s) || (off.length > 0 && off.includes(print.id.slice(0, print.id.indexOf(':'))));
    const visible = topPrints(this.hub.prints.items, v.t0, replaying() ? Math.min(v.t1, pageNow()) : v.t1, v.p0, v.p1, limit, hidden);
    if (!visible.length) return;
    const whale = scaledUsd(state.sounds.tiers[2]?.usd ?? 400_000);
    ctx.save();
    const ordered = [...visible].sort((a, b) => a.usd - b.usd), largest = ordered[ordered.length - 1]!.usd;
    for (const print of ordered) {
      const x = v.xOf(print.t, pw), y = v.yOf(print.price, ph), r = bubbleRadius(print.usd, largest) * s.scale;
      if (x < -r || x > pw + r) continue;
      this.#bubbles.push({ x, y, r, print });
    }
    const focus = this.#bubbleFocus(state, pw, ph), venueOf = (print: Print): string => print.id.slice(0, print.id.indexOf(':'));
    const dim = (print: Print): number => focus !== null && venueOf(print) !== focus ? 0.2 : 1;
    for (const { x, y, r, print } of this.#bubbles) {
      const color = print.side === 'buy' ? p.bid : p.ask, k = dim(print);
      ctx.globalAlpha = s.opacity * fade * k; ctx.fillStyle = color; ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fill();
      ctx.globalAlpha = 0.95 * fade * k;
      if (print.usd >= whale && k === 1) { const glow = glowOf(color, r, this.#dpr); ctx.drawImage(glow.image, x - glow.half, y - glow.half, glow.half * 2, glow.half * 2); }
      ctx.lineWidth = print.usd >= whale ? 1.8 : 1; ctx.strokeStyle = print.usd >= whale ? (p.dark ? '#ffffff' : '#14171c') : color;
      ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.stroke();
      // The hovered venue's bubbles, ringed in the text colour a little outside their own edge.
      if (focus !== null && k === 1) { ctx.globalAlpha = fade; ctx.lineWidth = 1.5; ctx.strokeStyle = p.text; ctx.beginPath(); ctx.arc(x, y, r + 2.5, 0, Math.PI * 2); ctx.stroke(); }
    }
    // The exchange's mark in each bubble that can hold it; with sizes written too, the mark goes above the middle and the size below it.
    const MARK_MIN_R = 7, BOTH_MIN_R = 16, markSize = (r: number): number => Math.min(18, Math.max(10, Math.round(r * 0.9)));
    if (s.marks) for (const b of this.#bubbles) {
      if (b.r < MARK_MIN_R) continue;
      const size = markSize(b.r);
      ctx.globalAlpha = fade * (dim(b.print) < 1 ? 0.35 : 1);
      drawVenueMark(ctx, b.print.id, b.x, s.labels && b.r >= BOTH_MIN_R ? b.y - size * 0.45 : b.y, size);
    }
    // The size written in each bubble that can hold it, the largest first; one that would run into another's is left to the hover box.
    if (s.labels) {
      const placed: { x0: number; x1: number; y0: number; y1: number }[] = [];
      ctx.globalAlpha = fade; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.lineWidth = 3;
      ctx.strokeStyle = p.dark ? 'rgba(0,0,0,0.65)' : 'rgba(255,255,255,0.85)'; ctx.fillStyle = p.text;
      for (let i = this.#bubbles.length - 1; i >= 0; i--) {
        const b = this.#bubbles[i]!, label = `$${usd(b.print.usd)}`, size = Math.min(12, Math.max(9, b.r * 0.5));
        // A bubble with a mark in its middle writes its size under the mark, if it is large enough for both, and otherwise not at all.
        const marked = s.marks && b.r >= MARK_MIN_R;
        if (marked && b.r < BOTH_MIN_R) continue;
        const ly = marked ? b.y + markSize(b.r) * 0.55 + size * 0.2 : b.y;
        ctx.font = `600 ${size}px ui-sans-serif, system-ui, sans-serif`;
        const w = ctx.measureText(label).width;
        if (w > 2 * b.r - 4) continue;
        const box = { x0: b.x - w / 2, x1: b.x + w / 2, y0: ly - size / 2, y1: ly + size / 2 };
        if (placed.some(q => q.x0 < box.x1 && box.x0 < q.x1 && q.y0 < box.y1 && box.y0 < q.y1)) continue;
        ctx.globalAlpha = fade * dim(b.print);
        placed.push(box); ctx.strokeText(label, b.x, ly); ctx.fillText(label, b.x, ly);
      }
    }
    ctx.restore();
  }

  #paintCandles(ctx: CanvasRenderingContext2D, state: AppState, pw: number, ph: number, narrowing = 0): void {
    const tf = TIMEFRAMES[state.timeframe] ?? 3_600_000, v = this.view, p = this.#palette;
    const bar = Math.max(1, pw * tf / (v.t1 - v.t0));
    // With the footprint on, the candle slides to the left of its slot and keeps a solid body, the row column takes the rest.
    const layout = footprintLayout(bar), normal = candleBody(bar);
    const body = normal + (Math.max(1, layout.body) - normal) * narrowing;
    const volume = this.#volumeAnalysis(state), hot = (i: number) => state.highlight.on && volume.found.flag[i] === 1;
    // A contrasting halo/outline keeps candles legible over both pink and green heat; it fades out over the dimmed footprint view.
    const edge = p.dark ? 'rgba(255,255,255,0.92)' : 'rgba(18,20,24,0.92)', halo = p.dark ? 'rgba(0,0,0,0.55)' : 'rgba(255,255,255,0.7)', outline = 1 - 0.85 * narrowing;
    // While the trade dust shows, a candle is its outline and a thin wick: a filled body (and its halo) would hide the orders inside it. Outline
    // candles are outlines always; OHLC bars and the line are drawn their own way (chart-type.ts).
    const type = this.previewChartType ?? state.chartType, hollow = type === 'outline' || this.#dustOn(state);
    // Narrower than CANDLE_LINE_PX a candle is a few overlapping marks per pixel (a 45-day view of hourly ones drew 1,100 of them, six to
    // eight drawing calls and a blurred ring each, on every pointer move: 14 frames a second, 2026-10-30): the candles are then the line
    // through their closes, as the price history beyond them is.
    const thin = bar < CANDLE_LINE_PX;
    if (type === 'line' || thin) { this.#paintCloseLine(ctx, state, pw, ph, tf, layout, narrowing, hot, thin); return; }
    const history = this.historyCandles(state), count = history.length + state.candles.length;
    for (let k = 0; k < count; k++) {
      // The exchange's candles before the chart's own, which are drawn over them; Highlights rings only the chart's own (its baseline is theirs).
      const ci = k - history.length, c = ci < 0 ? history[k]! : state.candles[ci]!;
      if (c[0] + tf < v.t0 || c[0] > v.t1) continue;
      // Every candle, the one still forming too, has the same body and stands in the middle of its slot, so the spacing is the same all along.
      const xClassic = v.xOf(c[0] + tf / 2, pw), x = xClassic + (v.xOf(c[0], pw) + layout.candleCenter - xClassic) * narrowing, up = c[4] >= c[1];
      const color = this.candleColor(c[0]) || (up ? p.candleUp : p.candleDown);
      const yh = v.yOf(c[2], ph), yl = v.yOf(c[3], ph), yo = v.yOf(c[1], ph), yc = v.yOf(c[4], ph), cx = Math.round(x) + 0.5;
      const top = Math.min(yo, yc), height = Math.max(1.5, Math.abs(yc - yo));
      // A wick is a rectangle filled, not a line stroked: the same pixels (butt ends), and a canvas strokes even a straight line as a path,
      // many times slower than a rectangle when hundreds of candles are drawn again on every pointer move (2026-10-30).
      const wick = (width: number, from: number, to: number): void => { if (to > from) ctx.fillRect(cx - width / 2, from, width, to - from); };
      if (type === 'bars') {
        // A line from the low to the high, the open a tick to the left and the close a tick to the right, over the same halo as a candle.
        const tick = bar < 4 ? 0 : Math.min(8, bar / 2 - 1), path = (): void => { ctx.beginPath(); ctx.moveTo(cx, yh); ctx.lineTo(cx, yl); if (tick > 0) { ctx.moveTo(cx - tick, Math.round(yo) + 0.5); ctx.lineTo(cx, Math.round(yo) + 0.5); ctx.moveTo(cx, Math.round(yc) + 0.5); ctx.lineTo(cx + tick, Math.round(yc) + 0.5); } };
        ctx.globalAlpha = outline; ctx.lineWidth = 3.6; ctx.strokeStyle = halo; path(); ctx.stroke();
        ctx.globalAlpha = 1; ctx.lineWidth = 1.6; ctx.strokeStyle = color; path(); ctx.stroke();
        ctx.lineWidth = 1;
      } else if (hollow) {
        const rect = [Math.round(x - body / 2) + 0.75, Math.round(top) + 0.75, Math.max(1, Math.round(body) - 1.5), Math.max(1, Math.round(height) - 1.5)] as const;
        // Outline candles chosen as the chart's type read over bright heat as the filled ones do, on the same halo; under the trade dust the
        // outline stays bare, so the orders inside the body show.
        if (type === 'outline') {
          ctx.globalAlpha = outline; ctx.strokeStyle = ctx.fillStyle = halo; ctx.lineWidth = 3.5;
          wick(3.5, yh, top); wick(3.5, top + height, yl); ctx.strokeRect(...rect);
        }
        const thinWick = type === 'outline' ? 1.4 : 1;
        ctx.globalAlpha = type === 'outline' ? 1 : 0.9; ctx.strokeStyle = ctx.fillStyle = color;
        wick(thinWick, yh, top); wick(thinWick, top + height, yl);
        ctx.lineWidth = 1.5; ctx.strokeRect(...rect);
      } else {
        ctx.globalAlpha = outline;
        ctx.fillStyle = halo; wick(3.5, yh, yl);
        ctx.fillStyle = edge; wick(1.6, yh, yl);
        if (narrowing > 0.01) { ctx.globalAlpha = Math.min(1, narrowing * 1.5); ctx.fillStyle = color; wick(1.4, yh, yl); }
        ctx.lineWidth = 1;
        ctx.globalAlpha = outline; ctx.fillStyle = halo; ctx.fillRect(x - body / 2 - 1.5, top - 1.5, body + 3, height + 3);
        ctx.globalAlpha = 1; ctx.fillStyle = color; ctx.fillRect(x - body / 2, top, body, height);
        if (body >= 3) { ctx.globalAlpha = outline; ctx.strokeStyle = edge; ctx.strokeRect(x - body / 2 + 0.5, top + 0.5, body - 1, Math.max(0.5, height - 1)); }
      }
      // Hollow, filled or a bar, a candle of unusual volume keeps its ring (Highlights), while it is wide enough to be told from its
      // neighbours: narrower, the ring (a blur each) covers the candles beside it, and the volume strip marks the candle as well. Its width
      // apart from the footprint's (`normal`): beside the footprint's rows a body is thin by design, its neighbours far apart.
      if (ci >= 0 && hot(ci) && normal >= 3) { // unusually large volume: a glowing ring in the candle's own colour
        ctx.save(); ctx.globalAlpha = 1; ctx.shadowColor = color; ctx.shadowBlur = 12; ctx.strokeStyle = color; ctx.lineWidth = 2.4;
        ctx.strokeRect(x - body / 2 - 2.5, top - 2.5, body + 5, height + 5); ctx.restore();
      }
    }
    ctx.globalAlpha = 1;
  }

  /**
   * The line through the closes: each candle's close at the middle of its body (narrowed beside the footprint's rows as the candles are),
   * broken where a candle is missing, in the text's colour over a halo; a candle of unusual volume is ringed where its close is.
   */
  #paintCloseLine(ctx: CanvasRenderingContext2D, state: AppState, pw: number, ph: number, tf: number, layout: { candleCenter: number }, narrowing: number, hot: (i: number) => boolean, thin = false): void {
    const v = this.view, p = this.#palette;
    let points: LinePoint[] = [];
    // Through the exchange's closes before the chart's own and in their holes (`candlesDrawn`); only the chart's own are ringed.
    const all = this.candlesDrawn(state), own = all === state.candles ? null : new Map(state.candles.map((c, i) => [c[0], i]));
    let last = -Infinity;
    for (let k = 0; k < all.length; k++) {
      const c = all[k]!;
      if (c[0] + tf < v.t0 - tf || c[0] > v.t1 + tf) continue;
      const xClassic = v.xOf(c[0] + tf / 2, pw), x = xClassic + (v.xOf(c[0], pw) + layout.candleCenter - xClassic) * narrowing;
      points.push({ x, y: v.yOf(c[4], ph), i: own ? own.get(c[0]) ?? -1 : k, t: c[0], brk: !points.length || c[0] - last > tf * 1.5 });
      last = c[0];
    }
    // Candles narrower than CANDLE_LINE_PX: a point every LINE_POINT_PX, and no rings (the volume strip's Highlights still mark the candles).
    if (thin) points = thinLine(points, LINE_POINT_PX);
    const path = (): void => {
      ctx.beginPath();
      for (const q of points) if (q.brk) ctx.moveTo(q.x, q.y); else ctx.lineTo(q.x, q.y);
    };
    ctx.save(); ctx.lineJoin = 'round'; ctx.lineCap = 'round';
    ctx.strokeStyle = p.dark ? 'rgba(0,0,0,0.55)' : 'rgba(255,255,255,0.75)'; ctx.lineWidth = 4; path(); ctx.stroke();
    ctx.strokeStyle = p.text; ctx.lineWidth = 1.8; path(); ctx.stroke();
    if (!thin) for (const q of points) if (q.i >= 0 && hot(q.i)) { const color = this.candleColor(q.t) || p.text; ctx.shadowColor = color; ctx.shadowBlur = 10; ctx.strokeStyle = color; ctx.lineWidth = 2.2; ctx.beginPath(); ctx.arc(q.x, q.y, 5, 0, Math.PI * 2); ctx.stroke(); ctx.shadowBlur = 0; }
    ctx.restore();
  }

  /**
   * Left edge of a column (in the plot's coordinates): right of the map after the profile when that is shown, the first nearest the map; left
   * of it at negative x, the first against the map's left edge and the others outward.
   */
  #columnX(side: Side, i: number): number {
    const state = this.store.state;
    return side === 'right' ? this.plotW + liqColumnW(state) + profileColumnW(state) + i * TRADED_W : -(i + 1) * TRADED_W;
  }
  /** The volume profile column under `x`: its side, its place there and its measure; null off the columns. */
  #columnAt(x: number): { side: Side; i: number; metric: ProfileMetric } | null {
    const state = this.store.state; if (!tradedShown(state)) return null;
    const sides = sideColumns(state), hit = columnHit(x, this.#columnX('right', 0), sides.right.length, sides.left.length, TRADED_W);
    return hit ? { ...hit, metric: sides[hit.side][hit.i]!.metric } : null;
  }

  /** The rows the traded column draws: the profile's step, so the two columns share their rows. */
  #tradedStep(): number { const v = this.view; return niceStep(v.p1 - v.p0, this.plotH / 3); }

  /** A day, week, month or session as its lines' labels name it ("Oct 17", "Week Oct 12", "Oct 2026", "Asia Oct 17"). */
  #windowName(state: AppState, w: ProfileWindow): string {
    const zone = windowZone(w, state.traded, state.timeZone);
    return windowLabel(w, at => periodDate(at, 'day', zone), t('Week'), at => periodDate(at, 'month', zone));
  }
  /**
   * The window the columns add up: always what is on the map, its whole minutes up to the one that is open (in a replay, up to the moment
   * shown), so the fixed column at the side is in step with the chart; days, weeks, months and sessions are drawn on the chart itself.
   */
  #tradedWindow(): { from: number; to: number } {
    const v = this.view, MIN = 60_000, replay = replayView();
    const q = replay ? MIN * Math.max(1, Math.round(replay.speed / 60)) : MIN;
    const open = replay ? Math.floor(pageNow() / q) * q : (Math.floor(pageNow() / MIN) + 1) * MIN;
    return { from: Math.floor(v.t0 / MIN) * MIN, to: Math.min(Math.ceil(v.t1 / MIN) * MIN, open) };
  }
  /** The map's grid step at the current price. */
  #gridStep(): number { const m = this.store.state.mark.price; return gridStepFor(m > 0 ? m : Math.max(1e-9, (this.view.p0 + this.view.p1) / 2)); }
  /** The rows the point of control and the value area are read from: the grid step times the setting, never the column's rows, which follow the zoom. */
  #levelStep(): number { return this.#gridStep() * this.store.state.traded.rows; }
  /**
   * Where a column's numbers begin when that is after the chart's left edge (null when they cover all of it): the later of the start its
   * source was asked from (eight days back at most, `askedSpan`) and the first minute every venue in it was recorded. Zoomed out to months,
   * the column is the last eight days, and says so (Karl, 2026-10-20: one profile across the whole chart, from nobody knew where).
   */
  #columnCovers(metric: ProfileMetric): number | null { return this.#loadedColumn(metric) ? null : this.#recordedSince(this.hub.profile(metric)?.answer ?? null); }
  /** Where an answer's numbers begin when that is after the chart's left edge (null when they cover all of it, or there is no answer). */
  #recordedSince(answer: ProfileAnswer | null): number | null {
    if (!answer) return null;
    let since = answer.from;
    for (const inst of answer.instruments) if (inst.earliest !== null && inst.earliest > since) since = inst.earliest;
    return since > this.#tradedWindow().from + 60_000 ? since : null;
  }
  /**
   * The traded-volume column's estimate from the exchange candles, in the same shape as the recording's answer, when the recording holds
   * under `DRAWN_SHARE` of the window on the map and the candles hold the window (`#windowFromCandles`, for the markets the column counts:
   * `#columnMarkets`); else null and the column is the recording's. One source for the whole column, never the two added (the recording
   * counts every venue, a candle one or two markets). Karl, 2026-10-24: zoomed out to months the column showed only the last days, with
   * nothing for the rest that the page had loaded. Not in a replay (its window is the replay's), and only traded volume: no exchange
   * publishes where absorption, liquidations or open interest happened. `split` false: the candles do not say who bought, so the column has
   * one volume and no sides. `markets` names what it was worked out from, for its box.
   */
  #loadedColumn(metric: ProfileMetric): { answer: ProfileAnswer; split: boolean; markets: string } | null {
    if (metric !== 'volume') return null;
    const state = this.store.state, win = this.#tradedWindow();
    if (!this.#loadedWanted(state, win)) return null;
    const step = requestStep(this.#tradedStep(), this.#levelStep(), this.#gridStep() / 40), now = Date.now(), c = this.#loadedCol;
    const mine = this.#columnMarkets(state), sources = `${mine.main?.id ?? ''}|${mine.spot?.id ?? ''}`;
    // A drag, a zoom or a change of the price scale moves the window or the rows every frame: what was worked out stands for a while, longer
    // the longer it took, and the pane is drawn again when it is due. Not once the markets it counts have changed (Spot, a chip): it is of others.
    if (c && c.sources === sources && (c.step !== step || c.from !== win.from || c.to !== win.to)) {
      const hold = Math.max(LOADED_COLUMN_MS, 4 * c.cost);
      if (now - c.at < hold) {
        if (!this.#loadedTimer) this.#loadedTimer = window.setTimeout(() => { this.#loadedTimer = 0; this.invalidate(); }, hold - (now - c.at) + 5);
        return c;
      }
    }
    const started = performance.now();
    const r = this.#windowFromCandles(state, { key: 'day|map', name: '', from: win.from, to: win.to }, step, state.traded.share / 100, pageNow(), true);
    if (!r) return null;
    if (!c || c.rows !== r.rows || c.step !== step || c.from !== win.from || c.to !== win.to) {
      const { answer, split } = candleAnswer(r.rows, r.buys, step, win.from, win.to);
      this.#loadedCol = { rows: r.rows, step, from: win.from, to: win.to, at: now, cost: performance.now() - started, answer, split, markets: r.markets, sources };
    }
    return this.#loadedCol;
  }
  /**
   * Whether the column's estimate from the candles is wanted for this window, whether or not the candles are in yet: the recording holds under
   * `DRAWN_SHARE` of it (`#volumeSince`), some venue is counted at all, the window is not older than the candles reach (`PROFILE_CANDLES_BACK_MS`:
   * none are asked for beyond it), and a market of the column's own is there to read (`#columnMarkets`).
   */
  #loadedWanted(state: AppState, win: { from: number; to: number } = this.#tradedWindow()): boolean {
    if (replaying() || !state.show.traded || win.from < Date.now() - PROFILE_CANDLES_BACK_MS) return false;
    const mine = this.#columnMarkets(state);
    if (!mine.main && !mine.spot) return false;
    const ids = flowIds(state, this.hub.flow.ids);
    if (!ids.length) return false;
    return loadedColumnWanted(this.#volumeSince(win, ids), win.from, win.to);
  }
  /**
   * Whether a press on the volume column must not start a Range selection: the estimate is drawn, or it is wanted and the candles it is read
   * from are still on their way. Never where they cannot come (a history shorter than the window, an exchange that does not answer): the
   * column then shows the recording, and a press on it selects.
   */
  #loadedBlocksRange(state: AppState): boolean {
    if (this.#loadedColumn('volume')) return true;
    const win = this.#tradedWindow();
    if (!this.#loadedWanted(state, win)) return false;
    const mine = this.#columnMarkets(state), spotOnly = !mine.main, primary = spotOnly ? mine.spot : mine.main;
    if (!primary) return false;
    const h = this.hub.profileHistory(this.#profileCandles(state, 'day').barMs, spotOnly ? 'spot' : 'main');
    return h.id !== primary.id || h.reach(win.from) === 'coming';
  }
  /**
   * Where the recording behind the traded-volume column begins inside the window (`recordingStart`: from what does not depend on the window
   * an answer was asked for, so a zoom out not yet answered does not flash the estimate on; before an answer is held, from where the hub knows
   * the recording began).
   */
  #volumeSince(win: { from: number; to: number }, ids: readonly string[]): number | null {
    const held = this.hub.profile('volume')?.answer;
    return recordingStart(win, askedSpan(win.from, win.to).from, held ? held.instruments : null, this.hub.recordedSince, ids);
  }
  /** Whether a market is a spot or a perpetual one: the market list says, else its venue's name does (Binance spot's candles are `binancespot`). */
  #marketKind(state: AppState, id: string): Kind { return kindOf(state.markets, id) ?? (/spot$|^coinbase$/.test(venueOfInstrument(id)) ? 'spot' : 'perp'); }
  /**
   * The candle markets the column's estimate is worked out from: the coin's usual one (`main`) and the spot market that joins it (`spot`),
   * each only where its venue's chip is on and it is inside the Spot / Perp / Both filter, as the recording's flow column counts. A market
   * the filter or a chip leaves out is no part of the estimate, and where none is left there is no estimate (never another market's).
   */
  #columnMarkets(state: AppState): { main: HistoryTarget | null; spot: HistoryTarget | null } {
    const { target, spot } = this.#profileCandles(state, 'day');
    const counts = (m: HistoryTarget | null): HistoryTarget | null => m && !state.disabledVenues.includes(venueOfInstrument(m.id)) && (state.scope === 'all' || this.#marketKind(state, m.id) === state.scope) ? m : null;
    return { main: counts(target), spot: counts(spot) };
  }
  /** What the market is called in a box that names where an estimate comes from ("Binance Perp"). */
  #marketLabel(state: AppState, m: HistoryTarget): string {
    // A spot venue's own name says so already ("Binance spot"); a perpetual's does not.
    const name = venueLabel(m.id);
    return this.#marketKind(state, m.id) === 'spot' ? (/spot/i.test(name) ? name : `${name} ${t('Spot')}`) : `${name} ${t('Perp')}`;
  }
  /** Whether anything on the chart is drawn from the traded-volume column's numbers: a volume column at a side, or the chart window's lines read from volume. */
  #loadedServes(state: AppState): boolean {
    const sides = sideColumns(state), s = state.traded;
    return [...sides.right, ...sides.left].some(c => c.metric === 'volume') || (s.windowLines && (s.poc || s.va) && lineMetric(s.placements) === 'volume');
  }
  /** Ask for the candles the column's estimate is read from, only while the recording holds too little of the window to be the column. */
  #ensureLoadedColumn(state: AppState): void {
    const win = this.#tradedWindow();
    if (!this.#loadedWanted(state, win)) return;
    const mine = this.#columnMarkets(state), { barMs } = this.#profileCandles(state, 'day'), at = Math.floor(win.from / barMs) * barMs;
    if (mine.main) this.hub.profileHistory(barMs, 'main').ensure(mine.main, at, barMs, () => this.invalidate());
    if (mine.spot) this.hub.profileHistory(barMs, 'spot').ensure(mine.spot, at, barMs, () => this.invalidate());
  }
  /** The point of control and the value area of what is on the chart, read from the column's answer over every price (kept until either changes). */
  #viewLevels(metric: ProfileMetric): ValueLevels | null {
    const answer = this.#columnAnswer(metric); if (!answer) return null;
    const step = this.#levelStep(), share = this.store.state.traded.share / 100, m = this.#levelsMemo.get(metric);
    if (m && m.answer === answer && m.step === step && m.share === share) return m.levels;
    const levels = answerLevels(answer, step, share);
    this.#levelsMemo.set(metric, { answer, step, share, levels });
    return levels;
  }
  /**
   * What a column draws: its measure's answer by price once one is held, the last one while a new one loads; the same answer on either side
   * of the map (`Hub.profile`).
   */
  #columnAnswer(metric: ProfileMetric): ProfileAnswer | null { return this.#loadedColumn(metric)?.answer ?? this.hub.profile(metric)?.answer ?? null; }

  /**
   * Ask for what a column adds up over the window on the map (whole minutes, up to the one that is open), on the instruments the flow
   * column counts, on rows that both the column's rows and the level rows divide (see `requestStep`): traded volume, or another measure.
   */
  #ensureTraded(state: AppState, metric: ProfileMetric): void {
    const v = this.view;
    if (!(v.t1 > v.t0) || !(v.p1 > v.p0)) return;
    const { from, to } = this.#tradedWindow();
    // What is on the chart keeps changing only while it follows the live edge.
    const live = state.followLive && !replaying(), ids = flowIds(state, this.hub.flow.ids), end = to;
    const step = requestStep(this.#tradedStep(), this.#levelStep(), this.#gridStep() / 40), asked = { tag: '', settled: false };
    this.hub.ensureProfile(metric, ids, from, end, step, live, asked, measureDef(metric).judgedByMarks ? this.#absorptionContext(state).thresholds : undefined);
    if (metric === 'volume' && this.#loadedServes(state)) this.#ensureLoadedColumn(state);
  }

  /**
   * Whose candles the key levels are read from, the zone their days start in and the candle size that starts a bar on every one of its
   * period boundaries (again when the market, the coin, a zone or the day changes: a zone can move by half an hour for daylight saving).
   */
  #keyLevelContext(state: AppState): { target: HistoryTarget | null; zone: string; barMs: number } {
    const coin = currentCoin(), now = pageNow(), key = `${state.marketId}|${coin.coin}|${state.traded.zone}|${state.timeZone}|${Math.floor(now / 86_400_000)}`;
    if (this.#keyContext?.key !== key) {
      const zone = resolveZone(state.traded.zone, state.timeZone);
      this.#keyContext = { key, target: historyTarget(state.marketId, coin), zone, barMs: barMsFor(zone, now - MAX_BACK_MS, now) };
    }
    return this.#keyContext;
  }
/**
   * What the VWAP lines need: the sessions touching the chart (and their bar size), each anchor of the coin (and its bar size, by its age),
   * and for each bar size how far back its candles must reach. Worked out again when the settings, the zone, the coin, the view's hour or
   * the clock's minute change.
   */
  #vwapPlan(state: AppState): { sessions: ProfileWindow[]; sessionBar: number; anchors: { at: number; bar: number }[]; reach: Map<number, number> } {
    const s = state.vwap, v = this.view, now = pageNow(), MIN = 60_000, HOUR = 3_600_000, { zone, barMs } = this.#keyLevelContext(state), coin = currentCoin().coin;
    const key = `${JSON.stringify(s)}|${zone}|${barMs}|${coin}|${Math.floor(v.t0 / HOUR)}|${Math.ceil(v.t1 / HOUR)}|${Math.floor(now / MIN)}`;
    if (this.#vwapPlanned?.key === key) return this.#vwapPlanned.plan;
    // The whale VWAP follows the same sessions, so they are worked out for either.
    const sessions = s.session || s.whale ? sessionsOf(s.period, zone, Math.max(v.t0, now - MAX_BACK_MS), v.t1, now, s.startMinute) : [];
    const sessionBar = vwapBarMs(sessions.length ? now - sessions[0]!.from : 0, barMs);
    const anchors = anchorsOf(s, coin, now).map(at => ({ at, bar: vwapBarMs(now - at, barMs) }));
    const reach = new Map<number, number>();
    const need = (bar: number, from: number): void => { reach.set(bar, Math.min(reach.get(bar) ?? Infinity, Math.floor(from / bar) * bar)); };
    if (sessions.length && s.session) need(sessionBar, sessions[0]!.from);
    for (const a of anchors) need(a.bar, a.at);
    const plan = { sessions, sessionBar, anchors, reach };
    this.#vwapPlanned = { key, plan };
    return plan;
  }
  /** Ask for the candles the VWAP lines need, one history per bar size, and the whale sums from the first session (within the week recorded). */
  #ensureVwap(state: AppState): void {
    const { target } = this.#keyLevelContext(state), plan = this.#vwapPlan(state);
    for (const [bar, from] of plan.reach) this.hub.vwapHistory(bar).ensure(target, from, bar, () => this.invalidate());
    // The seven days the recorder keeps, from a whole hour: a start moving with the clock would ask again every minute.
    const kept = Math.ceil((Date.now() - 7 * 86_400_000) / 3_600_000) * 3_600_000;
    if (state.vwap.whale && plan.sessions.length) this.hub.ensureWhale(flowIds(state, this.hub.flow.ids), Math.max(plan.sessions[0]!.from, kept), scaledUsd(state.vwap.whaleUsd));
  }
  /**
   * The bars of one VWAP history and, after the last of them, the chart's own candles when they are of the same market and no coarser (the
   * bar under way is then the chart's, not the history's partial one, so no volume is counted twice). Null until the history is the target's.
   */
  #vwapBars(state: AppState, bar: number, target: HistoryTarget): { rows: readonly CandleRow[]; liveFrom: number } | null {
    const h = this.hub.vwapHistory(bar);
    if (h.id !== target.id || h.barMs !== bar || !h.bars.length) return null;
    const held = h.bars, lastStart = held[held.length - 1]![0], tf = TIMEFRAMES[state.timeframe] ?? 3_600_000;
    if (!(target.own && state.seriesInstrument === state.marketId && tf <= bar)) return { rows: held, liveFrom: Infinity };
    const live = state.candles.filter(c => c[0] >= lastStart);
    if (!live.length) return { rows: held, liveFrom: Infinity };
    const from = live[0]![0];
    // A held bar reaching into the chart's candles would count that stretch twice.
    return { rows: [...held.filter(b => b[0] + bar <= from), ...live], liveFrom: from };
  }
  /** The VWAP lines for the view, worked out again only when the plan, a history or the chart's last candle changes. */
  #vwapLines(state: AppState): VwapLine[] {
    const s = state.vwap; if (!s.on) return [];
    const { target } = this.#keyLevelContext(state); if (!target) return [];
    const plan = this.#vwapPlan(state), tail = state.candles[state.candles.length - 1];
    const versions = [...plan.reach.keys()].map(bar => { const h = this.hub.vwapHistory(bar); return `${bar}:${h.id}:${h.version}`; }).join(',');
    // With the venues on screen: switched, the sums held are another set's until the new ones come.
    const whaleIds = flowIds(state, this.hub.flow.ids), w = this.hub.whale, whaleKey = w ? `${w.key}|${w.at}|${w.tail.size}|${[...w.tail.values()].at(-1)?.[1] ?? 0}|${[...w.tail.values()].at(-1)?.[3] ?? 0}|${whaleIds.join(',')}` : '';
    // Replay: again each minute shown, for the whale lines' minutes closed by then.
    const key = `${this.#vwapPlanned?.key}|${versions}|${state.candles.length}|${tail ? `${tail[0]}|${tail[2]}|${tail[3]}|${tail[5]}` : ''}|${whaleKey}${replaying() ? `|r${Math.floor(pageNow() / 60_000)}` : ''}`;
    if (this.#vwapDrawn?.key === key) return replayCut(this.#vwapDrawn.lines, pageNow());
    const lines: VwapLine[] = [], now = pageNow();
    const sessionBars = plan.sessions.length ? this.#vwapBars(state, plan.sessionBar, target) : null;
    const heldFrom = (bar: number): number => this.hub.vwapHistory(bar).heldFrom;
    if (sessionBars && s.session) for (const w of plan.sessions) {
      // A session whose start the history does not reach yet has no true average: it waits rather than show a wrong one.
      if (heldFrom(plan.sessionBar) > w.from) continue;
      const points = vwapSeries(sessionBars.rows, w.from, w.to);
      if (points.length) lines.push({ kind: 'session', n: 0, points, live: w.to > now, key: w.key, bar: plan.sessionBar, liveFrom: sessionBars.liveFrom });
    }
    // The whale lines of each session, from where the recording's count of large orders begins when that is later; only the sums of the size asked.
    const whale = this.hub.whale;
    if (s.whale && whale && whale.minUsd === scaledUsd(s.whaleUsd) && whale.ids.size === whaleIds.length && whaleIds.every(id => whale.ids.has(id))) {
      const rows = this.hub.whaleRows();
      for (const w of plan.sessions) {
        // Replay: only the minutes over by the moment shown (a minute's sums are known at its end).
        const upTo = replaying() ? Math.min(w.to, now - 60_000 + 1) : w.to;
        // The recording's start as the minute it falls in: the sums are kept a minute at a time, and that minute's orders were recorded.
        const since = whale.since !== null ? Math.floor(whale.since / 60_000) * 60_000 : w.from;
        const { buys, sells } = whaleSeries(rows, Math.max(w.from, since), upTo, Math.min(w.to, now)), live = w.to > now;
        if (buys.length) lines.push({ kind: 'whaleBuy', n: 0, points: buys, live, key: `whale-buy|${w.key}` });
        if (sells.length) lines.push({ kind: 'whaleSell', n: 0, points: sells, live, key: `whale-sell|${w.key}` });
      }
    }
    plan.anchors.forEach((a, i) => {
      // From the first whole bar after the anchor: a bar begun before it would carry volume from before the moment chosen.
      const bars = this.#vwapBars(state, a.bar, target), start = Math.ceil(a.at / a.bar) * a.bar;
      if (!bars || heldFrom(a.bar) > start) return;
      const points = vwapSeries(bars.rows, start, Infinity);
      if (points.length) lines.push({ kind: 'anchor', n: i + 1, points, live: true, key: `anchor|${a.at}`, bar: a.bar, liveFrom: bars.liveFrom });
    });
    this.#vwapDrawn = { key, lines };
    return replayCut(lines, now);
  }

  /** Ask for the hourly candles the key levels need for this view (how far back is worked out again only when the view's hour changes). */
  #ensureKeyLevels(state: AppState): void {
    const { target, zone, barMs } = this.#keyLevelContext(state), s = state.keyLevels, HOUR = 3_600_000, now = pageNow();
    const key = `${zone}|${s.day.prev}${s.day.mid}${s.day.open}${s.day.sofar}|${s.week.prev}${s.week.mid}${s.week.open}${s.week.sofar}|${s.month.prev}${s.month.mid}${s.month.open}${s.month.sofar}|${Math.floor(this.view.t0 / HOUR)}|${Math.floor(now / HOUR)}`;
    if (this.#keyFrom?.key !== key) this.#keyFrom = { key, from: neededFrom(s, zone, this.view.t0, now) };
    this.hub.keyHistory.ensure(target, this.#keyFrom.from, barMs, () => this.invalidate());
  }
  /**
   * The key levels for the view, from the exchange's candles and, after the last of them, the chart's own candles when they are of the same
   * market and no coarser than those (they move with every trade; the exchange's are asked again every five minutes). Worked out again when
   * the candles, the settings, the view's hour or the clock's minute change, never for a frame that only moves the pointer.
   */
  #keyLevelLines(state: AppState): KeyLine[] {
    const s = state.keyLevels, h = this.hub.keyHistory, v = this.view, now = pageNow(), MIN = 60_000, HOUR = 3_600_000;
    if (!s.on || !anyLine(s) || !h.bars.length) return [];
    const { target, zone, barMs } = this.#keyLevelContext(state);
    if (!target || target.id !== h.id || barMs !== h.barMs) return [];
    // Replay: only the bars closed by its moment (a bar under way carries its future high and low).
    const held = replaying() ? h.bars.filter(b => b[0] + h.barMs <= now) : h.bars;
    if (!held.length) return [];
    const lastStart = held[held.length - 1]![0], tf = TIMEFRAMES[state.timeframe] ?? HOUR;
    const live = target.own && state.seriesInstrument === state.marketId && tf <= barMs ? state.candles.filter(c => c[0] >= lastStart) : [];
    const tail = live[live.length - 1];
    const key = `${h.id}|${h.version}|${JSON.stringify(s)}|${zone}|${Math.floor(v.t0 / HOUR)}|${Math.ceil(v.t1 / HOUR)}|${Math.floor(now / MIN)}|${live.length}|${tail ? `${tail[0]}|${tail[2]}|${tail[3]}` : ''}`;
    if (this.#keyLines?.key !== key) {
      const bars = live.length ? [...held, ...live].sort((a, b) => a[0] - b[0]) : held;
      // The chart's own candles run on from the last bar to now, so they carry what is known up to now.
      this.#keyLines = { key, lines: keyLines(bars, s, { zone, t0: v.t0, t1: v.t1, now, untouched: s.untouched, heldFrom: h.heldFrom, heldTo: live.length ? now : replaying() ? Math.min(h.heldTo ?? now, now) : h.heldTo }) };
    }
    return this.#keyLines.lines;
  }

  /** How much of its trades the page's data source keeps (a server a week, a page reading the exchanges itself a day). */
  #recordingKeeps(): number { return this.hub.source.kind === 'browser' ? BROWSER_RETENTION_MS : RETENTION_MS; }
  /**
   * The days, weeks or sessions the lines are drawn for (worked out again when the settings, the view's minutes or the clock's minute
   * change): from the recording, only as many as it can still work out and only those that began inside what it keeps. They are the last
   * ones up to the chart's right edge, whether or not they reach its left one: zoomed in on the last hours, last month's untouched point of
   * control still runs on across the chart, and says whose it is. Each kind drawn on the chart (`chartKinds`: those whose lines are on, and
   * the profiles' kind) gives its own, in turn.
   */
  #linesWindows(state: AppState): ProfileWindow[] {
    const v = this.view, MIN = 60_000, s = state.traded, now = pageNow(), real = Date.now(), keeps = this.#recordingKeeps();
    const kinds = chartKinds(s);
    const key = `${kinds.join(',')}|${s.source}|${keeps}|${s.zone}|${s.count}|${JSON.stringify(s.sessions)}|${state.timeZone}|${Math.floor(v.t0 / MIN)}|${Math.ceil(v.t1 / MIN)}|${Math.floor(now / MIN)}|${Math.floor(real / MIN)}`;
    if (this.#vaWindows?.key !== key) {
      const out: ProfileWindow[] = [];
      for (const period of kinds) {
        const k = { ...s, period };
        // Far enough back to hold `count` of them (a weekday session skips a weekend): the last `count` are kept of what is found.
        const DAY_MS = 86_400_000, count = linesCount(k, keeps), span = period === 'month' ? 31 * DAY_MS : period === 'week' ? 7 * DAY_MS : DAY_MS;
        const back = Math.min(v.t0, Math.min(v.t1, now) - count * span - 3 * DAY_MS);
        const windows = linesWindows(k, state.timeZone, back, v.t1, now, count);
        out.push(...(linesSource(k) === 'recorded' ? recordedWindows(windows, real, keeps) : windows));
      }
      this.#vaWindows = { key, windows: out };
    }
    return this.#vaWindows.windows;
  }
  /**
   * How old each window is: the number of windows of its own series that have begun after it by now (0: the one under way, or the last of a
   * series between its windows), by the calendar and so the same whatever the chart shows (panning back does not make an old day new) and
   * whether or not its neighbours were drawn. For the fading of the lines and the profiles; worked out once a minute.
   */
  #ageRanks(state: AppState): Map<string, number> {
    const s = state.traded, now = pageNow(), minute = Math.floor(now / 60_000), c = this.#aged;
    if (c && c.lines === s.lines && c.profiles === s.profiles && c.sessions === s.sessions && c.zone === s.zone && c.tz === state.timeZone && c.minute === minute) return c.ranks;
    const windows: ProfileWindow[] = [];
    for (const period of chartKinds(s)) {
      const span = (period === 'month' ? 31 : period === 'week' ? 7 : 1) * 86_400_000;
      for (const w of periodWindows({ ...s, period }, state.timeZone, now - (MAX_COUNT + 2) * span - 3 * 86_400_000, now + 1)) if (w.from <= now) windows.push(w);
    }
    const ranks = ageRanks(windows);
    this.#aged = { lines: s.lines, profiles: s.profiles, sessions: s.sessions, zone: s.zone, tz: state.timeZone, minute, ranks };
    return ranks;
  }
  /**
   * The previous windows carried across the ones under way (`gatedCarries`, from the whole calendar, however many are drawn), for each kind whose
   * lines are on, where the source can still be worked out: from the recording only a kind it holds two windows of (a week never, a page that
   * keeps a day no previous day) and a source that began inside what it keeps; the window before it is never put in its place. How much of the
   * source was seen and whether its answer is whole are the lines' own rules (`#windowLevels`), judged where it is drawn. Worked out again each minute.
   */
  #carries(state: AppState): Carry[] {
    const s = state.traded, MIN = 60_000, now = pageNow(), real = Date.now(), keeps = this.#recordingKeeps(), c = this.#carried;
    if (!s.carry || (!s.poc && !s.va) || !s.lines.length) return [];
    const minute = Math.floor(now / MIN), realMinute = Math.floor(real / MIN);
    if (c && c.lines === s.lines && c.sessions === s.sessions && c.source === s.source && c.keeps === keeps && c.zone === s.zone && c.tz === state.timeZone && c.minute === minute && c.real === realMinute) return c.carries;
    const carries = gatedCarries(s, state.timeZone, now, real, keeps);
    this.#carried = { lines: s.lines, sessions: s.sessions, source: s.source, keeps, zone: s.zone, tz: state.timeZone, minute, real: realMinute, carries };
    return carries;
  }
  /** Where a window's lines come from: the recording or candles (a month's always candles). */
  #windowSource(state: AppState, w: ProfileWindow): TradedSettings['source'] { return linesSource({ period: windowKind(w), source: state.traded.source }); }
  /** The candles days, weeks and sessions are worked out from (`candles`): whose, and their size for that kind (the panel says the same). */
  #profileCandles(state: AppState, kind: LineKind): { target: HistoryTarget | null; spot: HistoryTarget | null; barMs: number } {
    const coin = currentCoin(), target = profileTarget(coin);
    return { target, spot: profileCompanion(coin, target), barMs: candleBarMs({ period: kind, sessions: state.traded.sessions }) };
  }
  /** Ask for what the lines of the days, weeks or sessions are worked out from: the recording's value areas, or the candles. */
  #ensureValueAreas(state: AppState): void {
    const s = state.traded;
    // A profile on the chart is drawn on its window's levels, so they are wanted for it even with no line drawn.
    if (!s.poc && !s.va && !s.profiles) return;
    const shown = this.#linesWindows(state), have = new Set(shown.map(w => w.key));
    // The previous windows carried across the ones under way are asked for whatever the count drawn (a single day drawn still carries
    // yesterday's), but only for their levels: nobody asks whether their point of control was traded through unless they are drawn.
    const carried = this.#carries(state).map(c => c.source).filter(w => !have.has(w.key)), windows = [...shown, ...carried];
    if (!windows.length) return;
    const extra = new Set(carried.map(w => w.key));
    const recorded = windows.filter(w => this.#windowSource(state, w) === 'recorded');
    if (recorded.length) this.hub.ensureValueAreas(this.#recordedIds(state), recorded, this.#levelStep(), s.share / 100);
    // The candles, of each size the kinds use: what the lines come from, or, from the recording, what tells whether a past point of control
    // was traded through since (`#touchedAfter`), from each window's end.
    const from = new Map<number, number[]>(), fromCandles = new Map<number, number[]>(), now = pageNow();
    for (const w of windows) {
      const fromRecording = this.#windowSource(state, w) === 'recorded';
      // From the recording only an ended window's point of control can have been traded through since (the one under way would ask for
      // candles from tomorrow, which come never, and hold the months' back).
      if (fromRecording && (extra.has(w.key) || !(s.naked && s.poc) || w.to > now)) continue;
      const { barMs } = this.#profileCandles(state, windowKind(w)), at = fromRecording ? w.to : w.from, list = from.get(barMs) ?? [];
      list.push(at); from.set(barMs, list);
      if (!fromRecording) { const own = fromCandles.get(barMs) ?? []; own.push(at); fromCandles.set(barMs, own); }
    }
    // Newest first: back to the newest window the candles do not reach yet, then on back with each load (Karl, 2026-10-20: four months of
    // five-minute bars are twenty-four requests, and the month under way, which needs six, waited for all of them).
    // The spot market's candles are asked the same way beside the perpetual's (`profileCompanion`), for the windows drawn from candles only:
    // they join those profiles; a recorded window's untouched point of control is read from the perpetual's alone.
    const coin = currentCoin(), target = profileTarget(coin), spot = profileCompanion(coin, target);
    for (const [barMs, all] of from) {
      for (const [market, which] of [[target, 'main'], [spot, 'spot']] as const) {
        const ats = which === 'spot' ? fromCandles.get(barMs) ?? [] : all;
        if (which === 'spot' && (!market || !ats.length)) continue;
        const h = this.hub.profileHistory(barMs, which), held = market && h.id === market.id && h.barMs === barMs ? h.heldFrom : Infinity;
        const missing = ats.filter(at => at < held), at = missing.length ? Math.max(...missing) : Math.min(...ats);
        h.ensure(market, Math.floor(at / barMs) * barMs, barMs, () => this.invalidate());
      }
    }
  }
  /**
   * When price first traded at a past window's point of control after the window ended: a time, null when it has not (as far as the
   * candles known reach), undefined when that cannot be told because the candles at hand begin after the window ended. The profile's own
   * candles reach back past every window the lines are drawn for; the chart's may not (zoomed in, they begin after a past window ended, and
   * a touch before them would be missed, drawing a point of control as untouched without evidence).
   */
  #touchedAfter(state: AppState, price: number, w: ProfileWindow, step: number): number | null | undefined {
    const { target, barMs } = this.#profileCandles(state, windowKind(w)), h = this.hub.profileHistory(barMs);
    const own = !!target && h.id === target.id && h.barMs === barMs && h.heldFrom <= w.to;
    const candles = own ? h.bars : state.candles;
    if (!own && !(candles.length && candles[0]![0] <= w.to)) return undefined;
    // A replay reads only the candles over by its moment (a forming one carries its future high and low), and the moment moves one candle at a time.
    const size = own ? barMs : TIMEFRAMES[state.timeframe] ?? 3_600_000, closed = replaying() ? { by: pageNow(), barMs: size } : undefined, last = candles[candles.length - 1]!;
    // Everything the answer depends on: the window's end (a session edited to end elsewhere keeps its start and its key), the candles read, and the candle under way's range.
    const key = `${own ? `${h.id}|${barMs}|${h.version}` : `chart|${candles.length}|${last[0]}|${last[2]}|${last[3]}|${last[4]}`}|${w.key}|${w.to}|${price}|${step}|${closed ? Math.floor(closed.by / size) : ''}`;
    if (!this.#touched.has(key)) {
      if (this.#touched.size > 200) this.#touched.clear();
      this.#touched.set(key, touchedAt(price, w.to, candles, step / 2, closed));
    }
    return this.#touched.get(key)!;
  }
  /**
   * The levels of one window from the candles (`candleLevels`) and how far they reach (`upTo`: the candles known, `heldTo`, so a history
   * that stopped being refreshed draws no further than it knows), or null when they cannot be drawn yet or at all: the history does not
   * reach its start, the window has ended but the candles known do not reach its end, or fewer than `DRAWN_SHARE` of its bars up to there
   * are there. A window whose bars are all final is worked out once; any other again when the candles change. `rows`: the estimate by row
   * of `step`, which the window's profile on the chart draws, and `buys` the part bought at market (null where the candles do not say).
   * The spot market's candles join once they reach the window as the perpetual's do (`spot`); until then the perpetual's draw alone.
   */
  #windowFromCandles(state: AppState, w: ProfileWindow, step: number, share: number, now: number, column = false): { levels: ValueLevels; upTo: number; rows: Map<number, number>; buys: Map<number, number> | null; spot: boolean; markets: string } | null {
    const { target, spot, barMs } = this.#profileCandles(state, windowKind(w));
    // The traded-volume column counts the markets the chips and the Spot / Perp filter leave on (`#columnMarkets`), and may be the spot market's
    // alone; the days, weeks and sessions on the chart are the coin's usual market with its spot market, whatever is on. `lag`: how far behind a
    // window that has ended the candles known may be (a column follows a pan off the live edge; a period's lines are drawn only once final).
    const mine = column ? this.#columnMarkets(state) : { main: target, spot }, spotOnly = column && !mine.main, primary = spotOnly ? mine.spot : mine.main, lag = column ? LOADED_LAG_MS : 0;
    if (!primary) return null;
    const h = this.hub.profileHistory(barMs, spotOnly ? 'spot' : 'main');
    if (h.id !== primary.id || h.barMs !== barMs || h.heldFrom > w.from) return null;
    // Replay: the candles up to its moment (a bar under way carries its future).
    let heldTo = Math.min(h.heldTo, now);
    // A window that has ended needs the candles to reach its end; the column's, under way or ended, needs them to reach (within `lag`) its end
    // or now: candles whose refreshes stopped would otherwise be 100 % of a window cut at where they stop, and drawn against the 90 % rule.
    if (column ? heldTo < Math.min(w.to, now) - lag : w.to <= now && heldTo < w.to) return null;
    // The spot market's join a window that has ended once they reach its end, and one under way only while they are as current as the
    // perpetual's (within a bar): a spot history that stopped would otherwise hold the profile back to where it stopped.
    const second = spotOnly ? null : mine.spot, s = second ? this.hub.profileHistory(barMs, 'spot') : null, sHeldTo = s ? Math.min(s.heldTo, now) : -Infinity;
    const joined = !!s && s.id === second!.id && s.barMs === barMs && s.heldFrom <= w.from && (w.to <= now ? sHeldTo >= w.to - lag : sHeldTo >= heldTo - barMs);
    if (joined) heldTo = Math.min(heldTo, sHeldTo);
    // Ended a bar before the candles known reach: its bars are final. Until then it is worked out again as they come; and an answer is kept
    // for good only when it is final, drawn and whole (the spot market's in it where they joined), never a rejected one that more could fix.
    const ended = w.to + barMs <= heldTo;
    const final = `${primary.id}|${joined ? second!.id : ''}|${barMs}|${step}|${share}|${w.from}|${w.to}`, live = `${final}|${h.version}|${joined ? s!.version : ''}|${Math.floor(heldTo / barMs)}`;
    type Worked = { levels: ValueLevels; rows: Map<number, number>; buys: Map<number, number> | null; spot: boolean };
    const work = (): Worked | null => {
      let r = candleLevels(h.bars, w.from, w.to, barMs, step, share, heldTo), merged = false;
      if (joined) { const other = candleLevels(s!.bars, w.from, w.to, barMs, step, share, heldTo); if (other.covered >= DRAWN_SHARE) { r = mergeCandleProfiles(r, other, step, share); merged = true; } }
      return r.covered >= DRAWN_SHARE && r.levels ? { levels: r.levels, rows: r.rows, buys: r.buys, spot: merged } : null;
    };
    let held: Worked | null | undefined;
    if (column) {
      // The column's window changes with every drag: kept in a slot of its own, not among the periods' windows (which it would push out). A
      // window that has ended and came out whole is kept by its final key, as the periods' are, so the candles' refresh each minute does not
      // work a static view out again; any other is worked out again when the candles change.
      const slot = this.#columnSlot;
      if (slot && (slot.key === live || (ended && slot.key === final))) held = slot.value;
      else {
        const value = work();
        this.#columnSlot = { key: ended && value && (!joined || value.spot) ? final : live, value };
        held = value;
      }
    } else {
      held = ended ? this.#candleLevels.get(final) : undefined;
      if (held === undefined) {
        if (!this.#candleLevels.has(live)) {
          // A bound on what is kept: the oldest go first (20 windows of each session at most are drawn).
          if (this.#candleLevels.size > 400) for (const k of [...this.#candleLevels.keys()].slice(0, 200)) this.#candleLevels.delete(k);
          const value = work();
          this.#candleLevels.set(live, value);
          if (ended && value && (!joined || value.spot)) this.#candleLevels.set(final, value);
        }
        held = this.#candleLevels.get(live);
      }
    }
    return held ? { levels: held.levels, rows: held.rows, buys: held.buys, spot: held.spot, upTo: Math.min(w.to, heldTo), markets: column ? [primary, ...(held.spot ? [second!] : [])].map(m => this.#marketLabel(state, m)).join(' + ') : '' } : null;
  }
  /**
   * A past day, week, month or session's levels as its lines draw them, and how far what they come from reaches; null when it is not drawn:
   * from candles (`#windowFromCandles`), or from the recording's value area once the answer is for the whole window (one from before it
   * ended waits for the next) and the recording holds `DRAWN_SHARE` of it. Its profile on the chart draws on the same condition.
   */
  #windowLevels(state: AppState, ids: readonly string[], w: ProfileWindow, step: number, share: number, now: number): { levels: ValueLevels; upTo: number } | null {
    if (this.#windowSource(state, w) === 'candles') { const r = this.#windowFromCandles(state, w, step, share, now); return r ? { levels: r.levels, upTo: r.upTo } : null; }
    return recordedWindowLevels(this.hub.valueAreas.get(valueAreaKey(ids, step, share, w)), w, now);
  }
  /**
   * The venues past days, weeks and sessions are worked out on from the recording: those the flow column counts that the recording holds at
   * all (the traded column's answer says which: one it has never recorded has no first minute). A server records some of the venues a page
   * can count; one it never records is no part of the recording, as it is no part of the column, and judging the windows on it called every
   * one of them unknown, so no past line was ever drawn (14 of 27 venues on the local server, 2026-10-19). A venue the recording holds but
   * missed in a window still makes that window's share unknown. Until the column has answered, every venue the flow column counts.
   */
  #recordedIds(state: AppState): string[] {
    const ids = flowIds(state, this.hub.flow.ids), held = this.hub.traded?.answer;
    if (!held) return ids;
    const recorded = new Set(held.instruments.filter(i => i.earliest !== null).map(i => i.id));
    return ids.filter(id => recorded.has(id) || !held.instruments.some(i => i.id === id));
  }
  /** The kind whose profiles are drawn on the chart, or null: a kind chosen, with the volume profile shown. */
  #profilesKind(state: AppState): LineKind | null { return state.show.traded ? state.traded.profiles : null; }
  /** Ask for the traded volume by price of the past windows whose lines are drawn from the recording (candles need nothing more). */
  #ensurePastProfiles(state: AppState): void {
    const kind = this.#profilesKind(state);
    if (!kind || linesSource({ period: kind, source: state.traded.source }) !== 'recorded') return;
    const ids = this.#recordedIds(state), step = this.#levelStep(), share = state.traded.share / 100, now = pageNow(), v = this.view;
    // Only the profiles' kind (another kind's would lie over them), and only those on the chart: the windows reach back further, for the
    // points of control that run on.
    const drawn = this.#linesWindows(state).filter(w => windowKind(w) === kind && w.to > v.t0 && w.from < v.t1 && this.#windowLevels(state, ids, w, step, share, now) !== null);
    this.hub.ensureWindowProfiles(ids, drawn, step);
  }
  /**
   * Each day, week, month or session of the profiles' kind (`profiles`) draws its traded-volume profile on the chart, over its own time: bars from
   * its start (or the chart's left edge, for one that began before it), the longest 60 % of its width on the chart, under the candles over a backing that mutes the map; from the recording in the bid and ask colours, from candles (an
   * estimate, marked ≈ on its lines) in the profile colour alone, since a candle says nothing of who traded. A window narrower than 24 px
   * draws none.
   */
  #paintPastProfiles(ctx: CanvasRenderingContext2D, state: AppState, pw: number, ph: number): void {
    this.#profileHits = [];
    const kind = this.#profilesKind(state); if (!kind) return;
    const v = this.view, p = this.#palette, now = pageNow(), step = this.#levelStep(), share = state.traded.share / 100, ids = this.#recordedIds(state);
    const row = Math.max(step, this.#tradedStep()), fromCandles = linesSource({ period: kind, source: state.traded.source }) === 'candles';
    const halo = p.dark ? 'rgba(0,0,0,0.6)' : 'rgba(255,255,255,0.7)', ages = this.#ageRanks(state);
    ctx.save(); ctx.beginPath(); ctx.rect(0, 0, pw, ph); ctx.clip();
    for (const w of this.#linesWindows(state)) {
      if (windowKind(w) !== kind || (replaying() && w.to > now)) continue;
      const drawn = this.#windowLevels(state, ids, w, step, share, now); if (!drawn) continue;
      // Over the part of the window on the chart: one that began left of it draws from its left edge, and one that runs on past its right edge
      // scales to it, so a month zoomed in on its last days still shows its profile (Karl, 2026-10-20) and its longest row stays on the chart.
      const x0 = Math.max(0, v.xOf(w.from, pw)), x1 = Math.min(pw, v.xOf(Math.min(w.to, now, drawn.upTo), pw));
      if (x1 - x0 < 24) continue;
      // The older among the windows shown, the fainter (the two newest in full): the newest read first and none disappears. The backing under the bars stays whole.
      const fade = ageAlpha(ages.get(w.key) ?? MAX_COUNT);
      // Each row of the display grid: [buy, sell], regrouped only when what it comes from or the rows change, never per frame. From candles
      // the split is their taker buys (Binance's), and where the candles do not say, all of a row is in the first, drawn grey.
      const candle = fromCandles ? this.#windowFromCandles(state, w, step, share, now) : null;
      const from = fromCandles ? candle?.rows : this.hub.windowProfiles.get(windowProfileKey(ids, step, w))?.answer;
      if (!from) continue;
      const split = !candle || candle.buys !== null;
      let grouped = this.#profileRows.get(from);
      if (!grouped || grouped.row !== row) {
        const rows = new Map<number, [number, number]>(), into = (price: number, a: number, b: number): void => { const k = Math.floor(price / row * (1 + 1e-12)), c = rows.get(k) ?? [0, 0]; c[0] += a; c[1] += b; rows.set(k, c); };
        if (from instanceof Map) for (const [k, usd] of from) { const bought = candle?.buys ? Math.min(usd, candle.buys.get(k) ?? 0) : usd; into((k + 0.5) * step, bought, candle?.buys ? usd - bought : 0); }
        else for (const inst of from.instruments) for (const [low, buy, sell] of inst.rows) into(low + inst.step / 2, buy, sell);
        let max = 0, total = 0; for (const [a, b] of rows.values()) { max = Math.max(max, a + b); total += a + b; }
        grouped = { row, rows, max, total, median: medianRow([...rows.values()].map(([a, b]) => a + b)) }; this.#profileRows.set(from, grouped);
      }
      const { rows, max, median, total } = grouped;
      if (!(max > 0)) continue;
      const room = (x1 - x0) * 0.6, floor = emphasisFloor(), on = state.traded.emphasis && state.traded.bars === 'split', edges: [number, number, number][] = [];
      for (const [k, [a, b]] of rows) {
        const y0 = v.yOf((k + 1) * row, ph), y1 = v.yOf(k * row, ph); if (y1 < 0 || y0 > ph) continue;
        const hgt = Math.max(1, y1 - y0 - 0.5), len = (a + b) / max * room;
        // A backing mutes the map under the bar, so the bar reads over the hottest heat as over none.
        ctx.globalAlpha = 1; ctx.fillStyle = halo; ctx.fillRect(x0, y0, len, hgt);
        if (candle) edges.push([y0, y0 + hgt, x0 + len]);
        // Candles that do not say who bought: the whole row in a neutral grey, never a side's colour.
        if (!split) { ctx.globalAlpha = 0.75 * fade; ctx.fillStyle = p.muted; ctx.fillRect(x0, y0, len, hgt); continue; }
        // The stronger side brighter and the weaker dimmer, on the scale the columns use (τ from the window's median row).
        const buyLen = len * a / (a + b), [first, second] = splitStyles(a, b, median, floor, p, on);
        if (a > 0) { ctx.globalAlpha = first.alpha * fade; ctx.fillStyle = first.color; ctx.fillRect(x0, y0, buyLen, hgt); }
        if (b > 0) { ctx.globalAlpha = second.alpha * fade; ctx.fillStyle = second.color; ctx.fillRect(x0 + buyLen, y0, len - buyLen, hgt); }
      }
      ctx.globalAlpha = 1;
      const name = this.#windowName(state, w), { target, barMs } = this.#profileCandles(state, kind), minutes = Math.round(barMs / 60_000);
      const market = target ? venueLabel(target.id) : '';
      if (candle && edges.length) {
        // From candles, an estimate: outlined in the profile colour along its edge and named with where it comes from (Karl, 2026-10-20).
        edges.sort((a, b) => a[0] - b[0]);
        ctx.strokeStyle = p.poc; ctx.lineWidth = 1; ctx.globalAlpha = 0.9 * fade; ctx.beginPath();
        let last: [number, number, number] | null = null;
        for (const e of edges) {
          if (!last || e[0] - last[1] > 1.5) { if (last) ctx.lineTo(x0, last[1]); ctx.moveTo(x0, e[0]); }
          ctx.lineTo(e[2], e[0]); ctx.lineTo(e[2], e[1]); last = e;
        }
        if (last) ctx.lineTo(x0, last[1]);
        ctx.stroke(); ctx.globalAlpha = 1;
        const top = edges[0]![0];
        ctx.font = '600 10px ui-sans-serif, system-ui, sans-serif'; ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
        // Above its top row, but never under the legend or the bands along the top, where a tall profile's top row often is; within its own
        // width on the chart, shortened to its name where the source does not fit, and left out where it would cover another label.
        const clear = Math.max(this.#legendBox.bottom, ...this.#arranged.top.map(b => b.top + b.height)) + 9, ly = Math.max(top - 9, clear), room = Math.min(x1, pw) - x0;
        const label = [t('≈ {name} · {market} {minutes}-min candles', { name, market, minutes }), `≈ ${name}`].find(text => ctx.measureText(text).width + 8 <= room);
        const lw = label ? ctx.measureText(label).width + 8 : 0;
        if (label && this.#labels.claim({ x0, x1: x0 + lw, y0: ly - 7, y1: ly + 7 })) {
          const named = Math.max(LABEL_FLOOR, fade);
          ctx.globalAlpha = 0.85 * named; ctx.fillStyle = p.panel; ctx.fillRect(x0, ly - 7, lw, 14);
          ctx.globalAlpha = named; ctx.fillStyle = p.poc; ctx.fillText(label, x0 + 4, ly);
        }
      }
      const source = !candle ? null : split
        ? t('{market} {minutes}-minute candles, each spread over its range and split by its taker buys: an estimate.', { market: candle.spot ? t('{venue} futures and spot', { venue: market }) : market, minutes })
        : t('{market} candles do not say who bought: the total only.', { market });
      this.#profileHits.push({ x0, room, row, max, rows, total, split, name: candle ? `≈ ${name}` : name, levels: drawn.levels, source });
    }
    ctx.restore();
  }

  /** The row of a period profile under the pointer (the profile drawn last first), with a little slack beside short bars. */
  #periodProfileAt(x: number, y: number, ph: number): ProfileRowHit | null {
    const price = this.view.pOf(y, ph);
    for (let i = this.#profileHits.length - 1; i >= 0; i--) {
      const hit = this.#profileHits[i]!, k = Math.floor(price / hit.row * (1 + 1e-12)), r = hit.rows.get(k);
      if (!r) continue;
      const len = (r[0] + r[1]) / hit.max * hit.room;
      if (x >= hit.x0 - 2 && x <= hit.x0 + Math.max(6, len) + 2) return { hit, k, buy: r[0], sell: r[1] };
    }
    return null;
  }

  /**
   * The point of control (a line) and the value area high and low (dashed) on the chart, in the profile colour over a halo that keeps them
   * apart from the map: across the whole chart for what is on it, or over each day, week or session. A past point of control nobody has
   * traded through since (a naked one) runs on, dotted, to where it was (or to the right edge). A day, week or session is drawn only when
   * its source saw at least `DRAWN_SHARE` of it (the recording, weighted by each venue's volume; the candles, their bars): a part of one
   * is not that period's profile. From candles the labels say ≈, an estimate. The previous window's levels are carried across the whole of the
   * one under way (`carries`, traded/carry.ts), long-dashed and fainter, named "Previous …", touched or not, in place of the source's own
   * untouched run there; the older windows shown fade by rank. Each line is labelled with whose it is and its price; the
   * lines that reach the right edge (the window under way, and an untouched point of control running on) are also tagged on the price
   * axis, as the VWAP is: the tags returned, for the axis to place with the others.
   */
  #paintValueLines(ctx: CanvasRenderingContext2D, state: AppState, pw: number, ph: number): KeyTag[] {
    const s = state.traded;
    if (!state.show.traded || (!s.poc && !s.va)) return [];
    const v = this.view, p = this.#palette, now = pageNow(), step = this.#levelStep();
    // `live`: the window under way (or what is on the chart), whose lines end at the right edge. `kind`: whose they are.
    // `rank`: how many windows of its series come after it among those shown, for the fading.
    const segments: { x0: number; x1: number; levels: ValueLevels; name: string; naked: number | null; live: boolean; key: string; kind: LineKind | 'view'; estimate?: boolean; rank: number }[] = [];
    const ids = this.#recordedIds(state), share = s.share / 100, ages = this.#ageRanks(state);
    // The lines are traded volume's when its column is chosen, else the first column's. Another measure than traded volume draws its own
    // levels, over the window the columns add up (what is on the chart, or the day, week or session under way): past days, weeks and
    // sessions are traded volume's.
    const lines = lineMetric(s.placements);
    // Across the chart, the columns' own levels (what is on the chart), when the periods grid's Chart window row is ticked, whatever periods
    // are drawn with them (Karl, 2026-10-20).
    if (s.windowLines) {
      // From where the column's numbers begin: a chart wider than what it could add up gets lines over the part it did, not across all of it.
      const levels = this.#viewLevels(lines), covers = this.#columnCovers(lines);
      // Read from the candles' estimate (the column's, `#loadedColumn`), they say so with a ≈ on their labels and tags, as the period lines from candles do.
      if (levels) segments.push({ x0: covers === null ? 0 : v.xOf(covers, pw), x1: pw, levels, name: '', naked: null, live: true, key: 'view', kind: 'view', estimate: !!this.#loadedColumn(lines), rank: 0 });
    }
    // The days, weeks, months or sessions drawn on the chart (always traded volume's).
    {
      const windows = this.#linesWindows(state);
      for (const w of windows) {
        // The levels and how far what they were worked out from reaches: a line is drawn no further than that. A window there only for its
        // profile (its kind's lines off) draws none.
        if (!s.lines.includes(windowKind(w))) continue;
        const source = this.#windowSource(state, w);
        if (source === 'recorded' && replaying() && w.to > now) continue;
        const drawn = this.#windowLevels(state, ids, w, step, share, now); if (!drawn) continue;
        const { levels, upTo } = drawn;
        const end = Math.min(w.to, now, upTo), x0 = v.xOf(w.from, pw), x1 = v.xOf(end, pw);
        let naked: number | null = null;
        // Untouched since it ended: it runs on to the right edge; touched: to where; not known yet (no candles that far back): not drawn.
        if (s.naked && w.to <= now) { const touched = this.#touchedAfter(state, levels.poc, w, step); naked = touched === undefined ? null : touched === null ? pw : v.xOf(touched, pw); }
        if (Math.max(x1, naked ?? x1) < 0 || x0 > pw) continue;
        const name = this.#windowName(state, w);
        segments.push({ x0, x1, levels, name: source === 'candles' ? `≈ ${name}` : name, naked, live: w.to > now, key: w.key, kind: windowKind(w), rank: ages.get(w.key) ?? MAX_COUNT });
      }
    }
    // The previous window's levels carried across the whole of the one under way, whatever the count shown and whether or not price has traded
    // through them: only where the lines' own rules draw the source (the recording whole and held for `DRAWN_SHARE` of it, or the candles reaching
    // it), never the window before it.
    const carries: { x0: number; x1: number; lines: CarriedLine[]; name: string; estimate: boolean; kind: LineKind; source: string; key: string }[] = [];
    const hidden = new Map<string, { from: number; to: number }>();
    for (const c of s.poc || s.va ? this.#carries(state) : []) {
      const drawn = this.#windowLevels(state, ids, c.source, step, share, now); if (!drawn) continue;
      // To the end of the window under way; in a replay only to its moment (what is right of it is masked, and a name there would be cut off).
      const over = { from: c.current.from, to: replaying() ? Math.min(c.current.to, now) : c.current.to };
      const x0 = v.xOf(over.from, pw), x1 = v.xOf(over.to, pw);
      if (x1 < 0 || x0 > pw) continue;
      carries.push({ x0, x1, lines: carriedLines(drawn.levels, over, s), name: t('Previous {name}', { name: this.#windowName(state, c.source) }), estimate: this.#windowSource(state, c.source) === 'candles', kind: windowKind(c.source), source: c.source.key, key: c.current.key });
    }
    if (!segments.length && !carries.length) return [];
    // A source's own untouched run is, over the period under way, the carry's line (the same level), which draws it dashed and fainter touched or
    // not: the run is left out over that period alone (`runPieces`), so no level is drawn twice and the gap before a session that began later and
    // what is left of the run past the period's end keep their dots. Older windows' runs stay as they are.
    if (s.poc) for (const c of carries) hidden.set(c.source, { from: c.x0, to: c.x1 });
    // With several kinds drawn, a tag on the axis says whose it is (D, W, M, S), as the key levels' do; the lines of a longer period are
    // heavier, so the month's stand out over the days'.
    const many = new Set([...segments, ...carries].map(x => x.kind)).size > 1, code = (kind: LineKind | 'view', what: string, estimate = false): string => { const text = many && kind !== 'view' ? `${KIND_CODE[kind]} ${what}` : what; return estimate ? `≈ ${text}` : text; };
    const weight = (kind: LineKind | 'view'): number => kind === 'month' ? 1.5 : kind === 'week' ? 1.25 : 1;
    const tags: KeyTag[] = [];
    const tag = (key: string, price: number, text: string, rank: number, older: boolean): void => { if (s.tags) tags.push({ key: `vp|${key}`, y: v.yOf(price, ph), rank, text, older, color: p.poc }); };
    const halo = p.dark ? 'rgba(0,0,0,0.55)' : 'rgba(255,255,255,0.75)';
    const line = (x0: number, x1: number, price: number, width: number, dash: number[]): void => {
      const y = Math.round(v.yOf(price, ph)) + 0.5; if (y < -2 || y > ph + 2 || x1 <= x0) return;
      ctx.setLineDash(dash);
      ctx.strokeStyle = halo; ctx.lineWidth = width + 2; ctx.beginPath(); ctx.moveTo(x0, y); ctx.lineTo(x1, y); ctx.stroke();
      ctx.strokeStyle = p.poc; ctx.lineWidth = width; ctx.beginPath(); ctx.moveTo(x0, y); ctx.lineTo(x1, y); ctx.stroke();
    };
    // Labels wait until every line is drawn, the points of control's first: one that would cover another already placed is left out.
    const labels: { text: string; x: number; y: number; rank: number; alpha: number }[] = [];
    const label = (text: string, x: number, price: number, rank: number): void => { const y = v.yOf(price, ph); if (y >= 6 && y <= ph - 6 && x >= 30) labels.push({ text, x, y, rank, alpha: ctx.globalAlpha }); };
    ctx.save(); ctx.beginPath(); ctx.rect(0, 0, pw, ph); ctx.clip();
    for (const seg of segments) {
      // The older among the windows shown, the fainter (the two newest in full); their names keep a floor, and rank after the newer windows'.
      const fade = ageAlpha(seg.rank), older = seg.rank >= 1 ? 2 : 0;
      ctx.globalAlpha = fade;
      const x0 = Math.max(-4, seg.x0), x1 = Math.min(pw + 4, seg.x1), { poc, vah, val } = seg.levels;
      const heavy = weight(seg.kind);
      if (s.va) { line(x0, x1, vah, heavy, [6, 4]); line(x0, x1, val, heavy, [6, 4]); }
      // What is left of its untouched run beside its carry (all of it where it has none); the run is named where its last piece ends.
      const hide = hidden.get(seg.key) ?? null, pieces = s.poc && seg.naked !== null && seg.naked > x1 ? runPieces(x1, seg.naked, hide) : [];
      const runsOn = pieces.length > 0, runsTo = runsOn ? Math.min(pw, pieces[pieces.length - 1]![1]) : x1;
      if (s.poc) { line(x0, x1, poc, 2 * heavy, []); for (const [a, b] of pieces) line(a, Math.min(pw + 4, b), poc, 2 * heavy, [2, 3]); }
      ctx.setLineDash([]);
      // The chart window's lines are named only beside a period's, which carry their own names.
      const base = seg.kind === 'view' && many ? t('Chart') : seg.name, own = seg.estimate ? `≈ ${base}`.trim() : base, name = own ? `${own} ` : '', pocText = `${name}${t('POC')} ${fmtPrice(poc, step)}`;
      ctx.globalAlpha = Math.max(LABEL_FLOOR, fade);
      if (s.labels && x1 - x0 > 70) {
        // The point of control is named where it ends: at the end of its run when it runs on.
        if (s.poc) label(pocText, runsTo, poc, (runsOn ? 2 : 0) + older);
        if (s.va) { label(`${name}${t('VAH')} ${fmtPrice(vah, step)}`, x1, vah, 1 + older); label(`${name}${t('VAL')} ${fmtPrice(val, step)}`, x1, val, 1 + older); }
      } else if (s.labels && runsOn && runsTo - Math.max(0, x1) > 70) label(pocText, runsTo, poc, 2 + older);   // only its run is on the chart
      // A longer period's tags go first where two would meet.
      const first = 1 - (heavy - 1);
      if (seg.live) { if (s.poc) tag(`${seg.key}|poc`, poc, code(seg.kind, t('POC'), seg.estimate), first, false); if (s.va) { tag(`${seg.key}|vah`, vah, code(seg.kind, t('VAH'), seg.estimate), first + 1.5, false); tag(`${seg.key}|val`, val, code(seg.kind, t('VAL'), seg.estimate), first + 1.5, false); } }
      else if (runsOn && seg.naked! >= pw && pieces[pieces.length - 1]![1] >= pw) tag(`${seg.key}|poc`, poc, code(seg.kind, t('POC')), 8 - (heavy - 1), true);   // untouched to now: outlined, as an older key level
    }
    // The carries: the previous window's lines across the one under way, long-dashed and faint, named "Previous …", after the current ones.
    for (const c of carries) {
      const x0 = Math.max(-4, c.x0), x1 = Math.min(pw + 4, c.x1), heavy = weight(c.kind), shown = Math.min(pw, c.x1) - Math.max(0, c.x0) > 70;
      for (const l of c.lines) {
        ctx.globalAlpha = CARRY_LINE_ALPHA;
        line(x0, x1, l.price, (l.what === 'poc' ? 2 : 1) * heavy, CARRY_DASH);
        ctx.setLineDash([]);
        // Named at its right end, after the current window's own names and before older windows'.
        ctx.globalAlpha = LABEL_FLOOR;
        if (s.labels && shown) label(`${c.estimate ? '≈ ' : ''}${c.name} ${CARRY_WORDS[l.what]} ${fmtPrice(l.price, step)}`, c.x1, l.price, l.what === 'poc' ? 0.5 : 1.5);
        // Outlined on the axis, as any level of a period that is over: after the current window's tags and before an older window's untouched run's.
        if (c.x1 >= pw - 1 || replaying()) tag(`${c.key}|prev-${l.what}`, l.price, code(c.kind, t('p{what}', { what: CARRY_WORDS[l.what] }), c.estimate), 5 - (heavy - 1) + (l.what === 'poc' ? 0 : 1), true);
      }
    }
    ctx.globalAlpha = 1;
    ctx.font = '600 10px ui-sans-serif, system-ui, sans-serif'; ctx.textAlign = 'right'; ctx.textBaseline = 'middle';
    for (const l of labels.sort((a, b) => a.rank - b.rank)) {
      const w = ctx.measureText(l.text).width + 8, right = Math.min(pw - 2, l.x - 2), box = { x0: right - w, x1: right, y0: l.y - 7, y1: l.y + 7 };
      if (!this.#labels.claim(box)) continue;
      ctx.globalAlpha = l.alpha * 0.85; ctx.fillStyle = p.panel; ctx.fillRect(box.x0, box.y0, w, 14);
      ctx.globalAlpha = l.alpha; ctx.fillStyle = p.poc; ctx.fillText(l.text, right - 4, l.y);
    }
    ctx.restore(); ctx.globalAlpha = 1; ctx.textBaseline = 'middle'; ctx.textAlign = 'left'; ctx.font = '11px ui-sans-serif, system-ui, sans-serif';
    return tags;
  }

  /** The column's rows a drag from `y0` to `y1` covers, as prices: whole rows of the column, so the selection is what the bars show. */
  #columnBand(y0: number, y1: number): { p0: number; p1: number } {
    const v = this.view, ph = this.plotH, step = this.#tradedStep();
    const a = v.pOf(Math.max(0, Math.min(ph, y0)), ph), b = v.pOf(Math.max(0, Math.min(ph, y1)), ph);
    return { p0: Math.floor(Math.min(a, b) / step) * step, p1: (Math.floor(Math.max(a, b) / step) + 1) * step };
  }

  /**
   * The traded-volume column: for each row of the profile's step, what was bought (bid colour) and sold (ask colour) at market over the window
   * on the map, as one bar split in two; the row with the most volume is outlined. The header gives the total and the largest row, or when
   * the recording began when the window reaches back further than that.
   */
  #paintTraded(ctx: CanvasRenderingContext2D, state: AppState, pw: number, ph: number): void {
    // One column a measure, side by side on each side; the box of the row under the pointer goes last, over the map beside them: left of
    // the right columns, right of the left ones.
    let box: (ColumnBox & { side: Side }) | null = null;
    const sides = sideColumns(state);
    for (const side of ['right', 'left'] as const) sides[side].forEach((p, i) => { const b = this.#paintColumn(ctx, state, pw, ph, p.metric, side, i, this.#columnX(side, i)); if (b) box = { ...b, side }; });
    if (box) {
      const b: ColumnBox & { side: Side } = box;
      paintInfoBox(ctx, b.lines, b.side === 'right' ? this.#columnX('right', 0) : 0, b.y, { x0: 0, y0: 0, x1: pw, y1: ph }, this.#palette, { placement: b.placement ?? 'center' }); ctx.textBaseline = 'middle';
    }
  }

  /**
   * One measure's column at `x0` (the `i`th of its side): its bars, value area, selection, hovered row and header; the hovered row's box, for
   * the caller to draw. A column left of the map is the mirror of one right of it: its bars grow from the edge against the map outward and its
   * price tags stand at its outer edge, so both sides face the chart; its header reads as the others do.
   */
  #paintColumn(ctx: CanvasRenderingContext2D, state: AppState, pw: number, ph: number, metric: ProfileMetric, side: Side, i: number, x0: number): ColumnBox | null {
    const p = this.#palette, v = this.view, W = TRADED_W, answer = this.#columnAnswer(metric), left = side === 'left';
    // Where a bar of `length` starting `from` px off the map-side edge lies: rightward from the left edge on the right, leftward on the left.
    const bar = (from: number, length: number): [number, number] => left ? [x0 + W - 1 - from - length, length] : [x0 + 1 + from, length];
    // The column's inside, off the edge line on the map's side.
    const inner = left ? x0 : x0 + 1;
    const rows: TradedRows | null = answer ? tradedRows(answer, this.#tradedStep(), v.p0, v.p1) : null;
    const s = state.traded, levels = this.#viewLevels(metric), loaded = this.#loadedColumn(metric), unsplit = !!loaded && !loaded.split;
    // The header: the total, the line under it, and the difference of the two sides (none for an estimate whose candles do not say who bought).
    const headH = 28 + (rows && rows.total > 0 && !unsplit ? 12 : 0);
    ctx.save(); ctx.beginPath(); ctx.rect(x0, 0, W, ph); ctx.clip();
    ctx.fillStyle = p.panel; ctx.fillRect(x0, 0, W, ph);
    // The value area, shaded behind the bars.
    if (s.valueArea && levels) {
      const ya = v.yOf(levels.vah, ph), yb = v.yOf(levels.val, ph);
      ctx.fillStyle = p.poc; ctx.globalAlpha = 0.12; ctx.fillRect(inner, ya, W - 1, yb - ya); ctx.globalAlpha = 1;
    }
    if (rows && rows.max > 0) {
      // One-sidedness is judged on one scale, τ from the median row of the whole answer, not of the prices on screen (traded/emphasis.ts).
      const width = W - 6, median = answer ? answerMedian(answer, rows.step) : 0, floor = emphasisFloor();
      for (let i = 0; i < rows.buy.length; i++) {
        const b = rows.buy[i]!, sl = rows.sell[i]!, total = b + sl; if (!(total > 0)) continue;
        const low = (rows.bin0 + i) * rows.step, y0 = v.yOf(low + rows.step, ph), y1 = v.yOf(low, ph);
        if (y1 < 0 || y0 > ph) continue;
        const hgt = Math.max(1, y1 - y0 - 0.5);
        ctx.globalAlpha = 0.85;
        const len = Math.max(1, total / rows.max * width), buyLen = len * b / total;
        // An estimate from the candles is outlined in the profile colour, as the Volume bars and the candle profiles are (one market's, not the venues').
        const outline = (): void => {
          const [x, w] = bar(0, len); ctx.globalAlpha = 0.85; ctx.strokeStyle = p.poc; ctx.fillStyle = p.poc; ctx.lineWidth = 1;
          if (hgt >= 2) ctx.strokeRect(x + 0.5, y0 + 0.5, Math.max(0, w - 1), Math.max(0, hgt - 1)); else ctx.fillRect(x, y0, w, 1);
        };
        if (loaded && !loaded.split) { const [x, w] = bar(0, len); ctx.globalAlpha = 0.75; ctx.fillStyle = p.muted; ctx.fillRect(x, y0, w, hgt); outline(); continue; }
        if (s.bars === 'delta') {
          // The whole row faintly, and the difference over it on the same scale in the colour of the side that was the bigger: a busy row whose
          // two sides were close still shows, as busy and balanced, never as a row where nothing traded (Karl, 2026-10-20).
          const net = b - sl;
          ctx.globalAlpha = 0.25; ctx.fillStyle = p.muted; ctx.fillRect(bar(0, len)[0], y0, len, hgt); ctx.globalAlpha = 0.85;
          if (Math.abs(net) > 0) { const n = Math.max(1, Math.abs(net) / rows.max * width); ctx.fillStyle = net > 0 ? p.bid : p.ask; ctx.fillRect(bar(0, n)[0], y0, n, hgt); }
          if (loaded) outline();
          continue;
        }
        // The first side (bid colour) against the map's edge, then the second, on both sides of the map.
        const [first, second] = splitStyles(b, sl, median, floor, p, s.emphasis);
        if (b > 0) { const [x, w] = bar(0, Math.max(0.5, buyLen)); ctx.globalAlpha = first.alpha; ctx.fillStyle = first.color; ctx.fillRect(x, y0, w, hgt); }
        if (sl > 0) { const [x, w] = bar(buyLen, Math.max(0.5, len - buyLen)); ctx.globalAlpha = second.alpha; ctx.fillStyle = second.color; ctx.fillRect(x, y0, w, hgt); }
        if (loaded) outline();
      }
      ctx.globalAlpha = 1;
    }
    // The point of control across the column, at its price, and the value area's edges: the same levels the lines on the chart draw.
    if (s.valueArea && levels) {
      const mark = (price: number, width: number, dash: number[]): void => { const y = Math.round(v.yOf(price, ph)) + 0.5; if (y < 0 || y > ph) return; ctx.setLineDash(dash); ctx.strokeStyle = p.poc; ctx.lineWidth = width; ctx.beginPath(); ctx.moveTo(inner, y); ctx.lineTo(inner + W - 1, y); ctx.stroke(); };
      mark(levels.vah, 1, [3, 2]); mark(levels.val, 1, [3, 2]); mark(levels.poc, 2, []); ctx.setLineDash([]); ctx.lineWidth = 1;
      // Their prices at the column's outer edge, the point of control's first: one that would cover another, or the header, is left out.
      ctx.font = '600 9px ui-sans-serif, system-ui, sans-serif'; ctx.textAlign = left ? 'left' : 'right'; ctx.textBaseline = 'middle';
      const placed: number[] = [];
      for (const [code, price] of [[t('POC'), levels.poc], [t('VAH'), levels.vah], [t('VAL'), levels.val]] as const) {
        const y = v.yOf(price, ph); if (y < headH + 7 || y > ph - 7 || placed.some(q => Math.abs(q - y) < 12)) continue;
        placed.push(y);
        const text = `${code} ${fmtPrice(price, this.#levelStep())}`, w = ctx.measureText(text).width + 6;
        ctx.globalAlpha = 0.85; ctx.fillStyle = p.panel; ctx.fillRect(left ? x0 + 1 : x0 + W - w - 1, y - 6, w, 12);
        ctx.globalAlpha = 1; ctx.fillStyle = p.poc; ctx.fillText(text, left ? x0 + 4 : x0 + W - 4, y);
      }
    }
    // A selection made on the column (its window, a band of its rows), shaded on it.
    const sel = state.range, win = this.#tradedWindow();
    if (sel && !loaded && sel.p0 !== null && sel.p1 !== null && Math.abs(sel.t0 - win.from) < 60_000 && Math.abs(sel.t1 - win.to) < 120_000) {
      const ya = v.yOf(sel.p1, ph), yb = v.yOf(sel.p0, ph);
      ctx.fillStyle = p.text; ctx.globalAlpha = 0.14; ctx.fillRect(inner, ya, W - 1, yb - ya); ctx.globalAlpha = 1;
      ctx.strokeStyle = p.text; ctx.setLineDash([5, 4]); ctx.strokeRect(inner + 0.5, Math.round(ya) + 0.5, W - 2, Math.max(1, Math.round(yb - ya) - 1)); ctx.setLineDash([]);
    }
    // The row under the pointer, framed; over the header, none: the header's box speaks for the whole window.
    const hover = this.#tradedHover?.side === side && this.#tradedHover.i === i ? this.#tradedHover : null, onHead = !!hover && hover.y < headH;
    const hoverRow = rows && hover && !onHead ? tradedRowAt(rows, v.pOf(hover.y, ph)) : -1;
    if (rows && hoverRow >= 0) {
      const low = (rows.bin0 + hoverRow) * rows.step, y0 = v.yOf(low + rows.step, ph), y1 = v.yOf(low, ph);
      ctx.strokeStyle = p.text; ctx.lineWidth = 1; ctx.globalAlpha = 0.9; ctx.strokeRect(x0 + 0.5, Math.round(y0) + 0.5, W - 1, Math.max(1, Math.round(y1 - y0))); ctx.globalAlpha = 1;
    }
    ctx.globalAlpha = 0.9; ctx.fillStyle = p.panel; ctx.fillRect(inner, 0, W - 1, headH); ctx.globalAlpha = 1;
    ctx.fillStyle = p.muted; ctx.font = `${pw < NARROW_PLOT ? 9.5 : 10}px ui-sans-serif, system-ui, sans-serif`; ctx.textAlign = 'left'; ctx.textBaseline = 'top';
    const held = this.hub.profile(metric), flags = held && answer ? held.flags : { cut: false, incomplete: false };
    const measured = measureDef(metric).header(rows, flags);
    let { head, sub } = measured;
    // An estimate from the candles says so, in the profile colour, where a recording's window says "since" in amber.
    if (loaded) { head = `≈ ${head}`; sub = t('≈ from candles'); }
    if (this.hub.profileState(metric) === 'unavailable' && !rows) sub = t('not on this server');
    ctx.fillText(head, x0 + 4, 4);
    let lineY = 16;
    // A window that reaches back before the recording, or a measure whose record is cut, says so in the dot rows' amber; so does a chart wider
    // than what the column could add up (a source answers eight days at most, `askedSpan`): the column then holds only its newest part.
    const covers = this.#columnCovers(metric);
    if (covers !== null && !loaded) sub = t('since {time}', { time: clock(covers, covers < startOfDay(Date.now())) });
    const warn = !loaded && (covers !== null || measured.warn);
    if (sub) { if (warn) ctx.fillStyle = '#e6a700'; else if (loaded) ctx.fillStyle = p.poc; ctx.fillText(sub, x0 + 4, lineY); }
    if (rows && rows.total > 0 && !unsplit) { const net = tradedNet(rows); ctx.fillStyle = net > 0 ? p.bid : net < 0 ? p.ask : p.muted; ctx.fillText(tradedNetLine(rows), x0 + 4, lineY + 12, W - 8); }
    ctx.restore(); ctx.textBaseline = 'middle';
    // The edge line on the map's side: a right column's left edge, a left column's right edge.
    const edge = left ? x0 + W - 0.5 : x0 + 0.5;
    ctx.strokeStyle = p.line; ctx.beginPath(); ctx.moveTo(edge, 0); ctx.lineTo(edge, ph); ctx.stroke();
    // The box stands beside the columns, over the map, like the profile's comparison.
    // It opens downward from under the chart's corner buttons, which would otherwise cover its first lines.
    // Where the estimate comes from, and, where its candles do not say who bought, that its column has one volume and no sides.
    const note = loaded ? [t('An estimate from the candles of {market}, the volume of each spread over its range: not the recording.', { market: loaded.markets }), ...(unsplit ? [t('{market} candles do not say who bought: the total only.', { market: loaded.markets })] : [])].join(' ') : null;
    if (rows && hover && onHead) return { lines: tradedFigures(rows, levels, state.mark.price, t('What is on the chart'), metricWords(metric), note, !unsplit), y: 34, placement: 'down' };
    return rows && hover && hoverRow >= 0 ? { lines: tradedLines(rows, hoverRow, levels, metricWords(metric), note, !unsplit), y: hover.y } : null;
  }

  /**
   * The room the profiles have now (traded/arrange.ts): the columns that fit beside the map (none on a phone), the bands that may stack (one
   * on a phone, as before) and where the bands go, under the legend and the corner buttons. Also read by the panel, for what has no room.
   */
  profileRoom(): ProfileRoom {
    const state = this.store.state, tools = this.root.querySelector<HTMLElement>('.map-tools');
    return { sides: tradedShown(state) ? COLUMNS_FIT : 0, maxBands: TRADED_W > 0 ? MAX_BANDS : 1,
      band: { legendBottom: this.#legendBox.bottom, toolsBottom: tools ? tools.offsetTop + tools.offsetHeight + 3 : 0, ph: this.plotH, volume: state.show.volume } };
  }

  /** Where the profiles go this frame; the corner buttons are measured only while a band is wanted. */
  #arrange(state: AppState): Arranged {
    if (!state.show.traded) return { right: [], left: [], top: [], hidden: [] };
    const set = state.traded.placements;
    if (placedOn(set, 'top').length) return arrangeProfiles(set, this.profileRoom());
    const sides = sideColumns(state);
    return { right: sides.right, left: sides.left, top: [], hidden: sides.hidden };
  }

  /**
   * What had no room, said where it would have been (Karl's rule: never dropped without a word): a small tag at the foot of the outermost
   * column for the columns, under the lowest band for the bands, each a button to the panel's places. A phone has no columns at all, which
   * its panel says, so only its bands are counted here.
   */
  #paintHidden(ctx: CanvasRenderingContext2D, pw: number, ph: number): void {
    this.#hiddenTags = [];
    const hidden = this.#arranged.hidden; if (!hidden.length) return;
    const p = this.#palette, sides = hidden.filter(x => x.placement !== 'top').length, bands = hidden.length - sides;
    const tag = (n: number, x: number, y: number, w: number): void => {
      const text = tn(n, '{n} hidden for space', '{n} hidden for space');
      ctx.font = '600 9px ui-sans-serif, system-ui, sans-serif'; ctx.textBaseline = 'middle'; ctx.textAlign = 'center';
      const width = Math.min(w, ctx.measureText(text).width + 12), x0 = Math.round(x + (w - width) / 2);
      ctx.globalAlpha = 0.92; ctx.fillStyle = p.panel; ctx.fillRect(x0, y, width, 15); ctx.globalAlpha = 1;
      ctx.strokeStyle = HIDDEN_COLOR; ctx.setLineDash([2, 2]); ctx.strokeRect(x0 + 0.5, y + 0.5, width - 1, 14); ctx.setLineDash([]);
      ctx.fillStyle = HIDDEN_COLOR; ctx.fillText(text, x0 + width / 2, y + 8, width - 6);
      this.#hiddenTags.push({ x: x0, y, w: width, h: 15 });
    };
    const shown = this.#arranged;
    if (sides && TRADED_W > 0) {
      const side: Side = shown.right.length ? 'right' : 'left', n = shown[side].length;
      if (n) tag(sides, this.#columnX(side, n - 1) + 3, ph - 20, TRADED_W - 6);
    }
    if (bands) {
      const last = shown.top[shown.top.length - 1], y = last ? last.top + last.height + 3 : this.#legendBox.bottom + BAND_GAP;
      tag(bands, pw - 156, y, 150);
    }
    ctx.textAlign = 'left'; ctx.font = '11px ui-sans-serif, system-ui, sans-serif';
  }
  /** Whether a point of the map is on a tag of what had no room. */
  #onHiddenTag(x: number, y: number): boolean { return this.#hiddenTags.some(r => x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h); }

  #paintProfile(ctx: CanvasRenderingContext2D, state: AppState, pw: number, ph: number): void {
    const frame = state.levels; if (!frame) return;
    const p = this.#palette, v = this.view;
    const ids = this.#enabledIds();
    const step = niceStep(v.p1 - v.p0, ph / 3);
    const g = groupLevels(this.kernels, frame, ids, step, v.p0, v.p1);
    const cum = cumulative(g, state.mark.price);
    let maxLevel = 0;
    for (let i = 0; i < g.nBins; i++) maxLevel = Math.max(maxLevel, g.totalBid[i]! + g.totalAsk[i]!);
    const W = profileColumnW(state), strip = W < PROFILE_W;
    const maxCum = Math.max(cum.maxBid, cum.maxAsk, 1), x0 = pw + liqColumnW(state), width = W - 6;
    ctx.save(); ctx.beginPath(); ctx.rect(x0, 0, W, ph); ctx.clip();
    ctx.fillStyle = p.panel; ctx.fillRect(x0, 0, W, ph);
    for (let i = 0; i < g.nBins; i++) {
      const lo = (g.bin0 + i) * step, y1 = v.yOf(lo, ph), y0 = v.yOf(lo + step, ph);
      if (y1 < 0 || y0 > ph) continue;
      const hgt = Math.max(1, y1 - y0 - 0.5);
      const b = g.totalBid[i]!, a = g.totalAsk[i]!;
      if (strip) {
        // The strip: each row's depth as the strength of its side's colour (by the square root, so a thin row still shows), the deepest the boldest.
        const depth = Math.max(a, b);
        if (depth > 0) { ctx.globalAlpha = 0.14 + 0.86 * Math.sqrt(depth / Math.max(maxLevel, 1)); ctx.fillStyle = a > b ? p.ask : p.bid; ctx.fillRect(x0 + 1, y0, W - 1, hgt); }
        continue;
      }
      if (cum.bid[i]! > 0) { ctx.globalAlpha = 0.16; ctx.fillStyle = p.bid; ctx.fillRect(x0, y0, cum.bid[i]! / maxCum * width, hgt); }
      if (cum.ask[i]! > 0) { ctx.globalAlpha = 0.16; ctx.fillStyle = p.ask; ctx.fillRect(x0, y0, cum.ask[i]! / maxCum * width, hgt); }
      if (b > 0) { ctx.globalAlpha = 0.85; ctx.fillStyle = p.bid; ctx.fillRect(x0, y0, Math.max(1, b / maxLevel * width), hgt); }
      if (a > 0) { ctx.globalAlpha = 0.85; ctx.fillStyle = p.ask; ctx.fillRect(x0, y0, Math.max(1, a / maxLevel * width), hgt); }
    }
    ctx.globalAlpha = 1;
    if (!strip) {
      ctx.globalAlpha = 0.9; ctx.fillStyle = p.panel; ctx.fillRect(x0 + 1, 0, W - 1, 28); ctx.globalAlpha = 1;
      ctx.fillStyle = p.muted; ctx.font = `${pw < NARROW_PLOT ? 9.5 : 10}px ui-sans-serif, system-ui, sans-serif`; ctx.textAlign = 'left'; ctx.textBaseline = 'top';
      ctx.fillText(t('LEVEL MAX {value}', { value: usd(maxLevel) }), x0 + 4, 4); ctx.fillText(t('CUM MAX {value}', { value: usd(maxCum) }), x0 + 4, 16);
    }
    this.#profileBox = null;
    this.#paintProfileMirror(ctx, state, g, cum, step, x0, ph, W);
    ctx.restore(); ctx.textBaseline = 'middle';
    const box = this.#profileBox as { lines: MirrorLine[]; y: number; placement: 'down' | 'up' } | null; // set by #paintProfileMirror above
    if (box) {
      // The comparison pops up beside the profile column, pointing at it, and only while the pointer is on the column.
      this.#profileBox = null;
      paintMirrorBox(ctx, box.lines, x0, box.y, { x0: 0, y0: 0, x1: pw, y1: ph }, p, c => c === 'above' ? p.ask : c === 'below' ? p.bid : c === 'muted' ? p.muted : p.text, box.placement);
      ctx.textBaseline = 'middle';
    }
    ctx.strokeStyle = p.line; ctx.beginPath(); ctx.moveTo(x0 + 0.5, 0); ctx.lineTo(x0 + 0.5, ph); ctx.stroke();
  }

  /** Mirror hover on the profile column: frame the band from the mark to the pointer and the equally wide band on the other side, and compare them. */
  #paintProfileMirror(ctx: CanvasRenderingContext2D, state: AppState, g: Grouped, cum: ReturnType<typeof cumulative>, step: number, x0: number, ph: number, W: number): void {
    const hv = this.#profileHover, p = this.#palette, v = this.view, mark = state.mark.price;
    if (!hv || hv.column !== 'book' || !state.show.mirror || !(mark > 0)) return;
    const markBin = Math.floor(mark / step) - g.bin0, hb = Math.floor(v.pOf(hv.y, ph) / step) - g.bin0, mb = 2 * markBin - hb;
    if (hb === markBin) return;
    const clamp = (i: number) => Math.max(0, Math.min(g.nBins - 1, i));
    const above = cum.ask[clamp(hb > markBin ? hb : mb)]!, below = cum.bid[clamp(hb > markBin ? mb : hb)]!;
    const stats = mirrorStats(mark, mark + (hb - markBin) * step, above, below, mb < 0 || mb >= g.nBins || hb < 0 || hb >= g.nBins);
    if (!stats) return;
    this.mirror = stats;
    const top = v.yOf((g.bin0 + Math.max(hb, mb) + 1) * step, ph), bottom = v.yOf((g.bin0 + Math.min(hb, mb)) * step, ph), pct = percentText(stats);
    // The strip has no room for the band's pills: its box says the same.
    const wide = W >= PROFILE_W;
    dimOutside(ctx, x0, W, 0, ph, top, bottom, p.panel, 0.6);
    paintBand(ctx, p, x0, W, { y: top, color: p.ask, label: wide ? `${usd(stats.aboveUsd)} · ${pct}` : '' }, { y: bottom, color: p.bid, label: wide ? `${usd(stats.belowUsd)} · ${pct}` : '' }, { y0: 0, y1: ph });
    this.#profileBox = { lines: mirrorLines(stats, { above: t('Asks'), below: t('Bids') }), y: hv.y, placement: stats.hoveredSide === 'above' ? 'down' : 'up' };
  }

  /**
   * The liquidation column (Liquidation levels' own, between the map and the profile column): in each row what still stands of them (longs
   * in the falling colour, shorts in the rising one) and, faint behind it, everything from the price out to that row, so a faint bar reads
   * "this much goes if price gets here". Until the levels are there, or in a replay, it says why it is empty.
   */
  #paintLiqColumn(ctx: CanvasRenderingContext2D, state: AppState, pw: number, ph: number): void {
    const p = this.#palette, v = this.view, src = this.hub.liqLevels, x0 = pw, W = liqColumnW(state), strip = W < PROFILE_W;
    const s = src.levels && src.state === 'ready' && !replaying() ? src.standing() : null;
    ctx.save(); ctx.beginPath(); ctx.rect(x0, 0, W, ph); ctx.clip();
    ctx.fillStyle = p.panel; ctx.fillRect(x0, 0, W, ph);
    ctx.font = `${pw < NARROW_PLOT ? 9.5 : 10}px ui-sans-serif, system-ui, sans-serif`; ctx.textAlign = 'left'; ctx.textBaseline = 'top';
    const wide = (words: string): number => ctx.measureText(words).width;
    // The strip has no room for words: until the levels are there it is empty (the Liq tab says why).
    if (!s && strip) { ctx.restore(); ctx.strokeStyle = p.line; ctx.beginPath(); ctx.moveTo(x0 + 0.5, 0); ctx.lineTo(x0 + 0.5, ph); ctx.stroke(); return; }
    if (!s) {
      const why = replaying() ? t('Liquidation levels show the live market only.') : src.state === 'unavailable' ? t('Liquidation levels could not be read.')
        : src.state === 'stale' && src.levels ? t('Liquidation levels are out of date: the newest are from {time}.', { time: clock(src.levels.asOf) }) : t('Liquidation levels are loading.');
      ctx.fillStyle = p.text; ctx.fillText(fitText(wide, t('LIQ LEVELS'), W - 8), x0 + 4, 4);
      // The reason, word-wrapped to the column's width.
      ctx.fillStyle = p.muted;
      let line = '', y = 18;
      for (const word of why.split(' ')) {
        const next = line ? `${line} ${word}` : word;
        if (line && wide(next) > W - 8) { ctx.fillText(line, x0 + 4, y); y += 12; line = word; } else line = next;
      }
      if (line) ctx.fillText(fitText(wide, line, W - 8), x0 + 4, y);
      ctx.restore();
      ctx.strokeStyle = p.line; ctx.beginPath(); ctx.moveTo(x0 + 0.5, 0); ctx.lineTo(x0 + 0.5, ph); ctx.stroke();
      return;
    }
    const step = niceStep(v.p1 - v.p0, ph / 3), price = this.#liqPrice(state);
    const prof = liqProfile(s, step, v.p0, v.p1, price);
    const maxLevel = Math.max(prof.maxLevel, 1), maxCum = Math.max(prof.maxCum, 1), width = W - 6;
    for (let r = 0; r < prof.long.length; r++) {
      const lo = (prof.row0 + r) * step, y1 = v.yOf(lo, ph), y0 = v.yOf(lo + step, ph);
      if (y1 < 0 || y0 > ph) continue;
      const hgt = Math.max(1, y1 - y0 - 0.5), long = prof.long[r]!, short = prof.short[r]!, cumLong = prof.cumLong[r]!, cumShort = prof.cumShort[r]!;
      if (strip) {
        // The strip, as the book's: each row's levels as the strength of their side's colour, the largest the boldest; longs below the price,
        // shorts above, in the candles' colours as in the column. By the logarithm, not the book's square root: the levels are a few spikes
        // (one of 24M made a 100K row 19 % strong, too faint to see), and this gives that row about 40 %.
        const level = Math.max(long, short);
        if (level > 0) { ctx.globalAlpha = 0.22 + 0.78 * Math.log1p(level / (maxLevel / 1000)) / Math.log1p(1000); ctx.fillStyle = long >= short ? p.candleDown : p.candleUp; ctx.fillRect(x0 + 1, y0, W - 1, hgt); }
        continue;
      }
      if (cumLong > 0) { ctx.globalAlpha = 0.16; ctx.fillStyle = p.candleDown; ctx.fillRect(x0, y0, cumLong / maxCum * width, hgt); }
      if (cumShort > 0) { ctx.globalAlpha = 0.16; ctx.fillStyle = p.candleUp; ctx.fillRect(x0, y0, cumShort / maxCum * width, hgt); }
      if (long > 0) { ctx.globalAlpha = 0.85; ctx.fillStyle = p.candleDown; ctx.fillRect(x0, y0, Math.max(1, long / maxLevel * width), hgt); }
      if (short > 0) { ctx.globalAlpha = 0.85; ctx.fillStyle = p.candleUp; ctx.fillRect(x0, y0, Math.max(1, short / maxLevel * width), hgt); }
    }
    ctx.globalAlpha = 1;
    if (!strip) {
      ctx.globalAlpha = 0.9; ctx.fillStyle = p.panel; ctx.fillRect(x0 + 1, 0, W - 1, 40); ctx.globalAlpha = 1;
      ctx.fillStyle = p.text; ctx.fillText(fitText(wide, t('LIQ LEVELS'), W - 8), x0 + 4, 4);
      ctx.fillStyle = p.muted; ctx.fillText(t('LEVEL MAX {value}', { value: usd(maxLevel) }), x0 + 4, 16); ctx.fillText(t('CUM MAX {value}', { value: usd(maxCum) }), x0 + 4, 28);
    }
    this.#profileBox = null;
    this.#paintLiqColumnMirror(ctx, state, s, price, x0, ph, W);
    ctx.restore(); ctx.textBaseline = 'middle';
    const box = this.#profileBox as { lines: MirrorLine[]; y: number; placement: 'down' | 'up' } | null; // set by #paintLiqColumnMirror above
    if (box) {
      this.#profileBox = null;
      paintMirrorBox(ctx, box.lines, x0, box.y, { x0: 0, y0: 0, x1: pw, y1: ph }, p, c => c === 'above' ? p.candleUp : c === 'below' ? p.candleDown : c === 'muted' ? p.muted : p.text, box.placement);
      ctx.textBaseline = 'middle';
    }
    ctx.strokeStyle = p.line; ctx.beginPath(); ctx.moveTo(x0 + 0.5, 0); ctx.lineTo(x0 + 0.5, ph); ctx.stroke();
  }

  /**
   * The seam between the liquidation column and the profile column, pointed at: the book against the liquidations from the price out to the
   * pointer and its mirror, as one band across both columns, and a box that weighs them. Each side: what rests in the book against what
   * would be liquidated (the bids against the longs below, the asks against the shorts above), in the band and over the columns on screen;
   * the rank correlation of level size with book size over the rows that hold liquidations; and at the largest levels, whether the book
   * stands as a wall or thins to a void. The liquidations are Hyperliquid's alone and some 40 minutes old; the book is every enabled
   * venue's, now: the box says so.
   */
  #paintSeam(ctx: CanvasRenderingContext2D, state: AppState, pw: number, ph: number): void {
    const hv = this.#profileHover, src = this.hub.liqLevels, frame = state.levels, s = src.levels && src.state === 'ready' ? src.standing() : null;
    if (!hv || hv.column !== 'seam' || !frame || !s || !liqColumnShown(state) || !state.show.profile) return;
    const p = this.#palette, v = this.view, step = niceStep(v.p1 - v.p0, ph / 3), price = this.#liqPrice(state);
    if (!(price > 0)) return;
    const g = groupLevels(this.kernels, frame, this.#enabledIds(), step, v.p0, v.p1), prof = liqProfile(s, step, v.p0, v.p1, price);
    // The two columns' rows at the same prices (both begin at floor(p0 / step), so the offset is 0 unless one of them ends sooner).
    const long = new Float64Array(g.nBins), short = new Float64Array(g.nBins);
    for (let i = 0; i < g.nBins; i++) { const j = g.bin0 + i - prof.row0; if (j >= 0 && j < prof.long.length) { long[i] = prof.long[j]!; short[i] = prof.short[j]!; } }
    const at = v.pOf(hv.y, ph), d = Math.abs(at - price);
    const st = seamStats({ row0: g.bin0, step, bid: g.totalBid, ask: g.totalAsk, long, short }, price, d);
    const x0 = pw, liqW = liqColumnW(state), W = liqW + profileColumnW(state), top = v.yOf(price + d, ph), bottom = v.yOf(price - d, ph);
    ctx.save();
    dimOutside(ctx, x0, W, 0, ph, top, bottom, p.panel, 0.55);
    // Two strips (a compact map) have no room for the band's pills: the box says the same.
    const pills = liqW >= PROFILE_W;
    paintBand(ctx, p, x0, W, { y: top, color: p.candleUp, label: pills ? `${usd(st.above.book)} · ${usd(st.above.liq)}` : '' }, { y: bottom, color: p.candleDown, label: pills ? `${usd(st.below.book)} · ${usd(st.below.liq)}` : '' }, { y0: 0, y1: ph });
    // The seam itself, lit while it is pointed at.
    ctx.strokeStyle = p.ui; ctx.lineWidth = 2; ctx.beginPath(); ctx.moveTo(x0 + liqW, 0); ctx.lineTo(x0 + liqW, ph); ctx.stroke();
    ctx.restore();
    // A neighbour row with almost nothing would make a ratio of millions: past 100 it says so and no more.
    const times = (r: number): string => !Number.isFinite(r) || r >= 100 ? '100×+' : `${r >= 10 ? r.toFixed(0) : r.toFixed(1)}×`;
    const cover = (book: number, liq: number, below: boolean): string => liq <= 0 ? t('No liquidation levels in this range')
      : book >= liq ? (below ? t('Bids cover the longs {ratio}', { ratio: times(book / liq) }) : t('Asks cover the shorts {ratio}', { ratio: times(book / liq) }))
      : (below ? t('Longs exceed the bids {ratio}', { ratio: times(liq / Math.max(book, 1)) }) : t('Shorts exceed the asks {ratio}', { ratio: times(liq / Math.max(book, 1)) }));
    const rhoText = (rho: number | null, n: number): string => rho === null ? t('too few levels') : t('{rho} over {n} levels', { rho: rho.toFixed(2), n: String(n) });
    const bp = d / price * 1e4;
    const lines: InfoLine[] = [
      { text: t('Book against liquidations'), bold: true },
      { text: t('±{distance} ({bp} bp) from {mid}', { distance: fmtPrice(d), bp: bp < 10 ? bp.toFixed(1) : String(Math.round(bp)), mid: fmtPrice(price) }), color: 'muted' },
    ];
    for (const below of [false, true]) {
      const side = below ? st.below : st.above;
      lines.push({ text: below ? t('Below the price') : t('Above the price'), bold: true, rule: true });
      lines.push({ label: below ? t('Bids') : t('Asks'), text: `$${usd(side.book)}`, color: below ? 'below' : 'above' });
      lines.push({ label: below ? t('Long liquidations') : t('Short liquidations'), text: `$${usd(side.liq)}`, color: below ? 'sell' : 'buy' });
      lines.push({ text: cover(side.book, side.liq, below), bold: true });
      if (side.liqAll > 0) lines.push({ label: t('On screen'), text: cover(side.bookAll, side.liqAll, below), color: 'muted', wrap: COMPACT });
    }
    // A phone's map is narrower than this box: there its long lines wrap under their labels, and the box may lie over the two columns.
    lines.push({ text: t('Rank correlation, level size with book size'), bold: true, rule: true });
    lines.push({ label: t('Above the price'), text: `${rhoText(st.above.rho, st.above.n)} · ${t('on screen {value}', { value: rhoText(st.above.rhoAll, st.above.nAll) })}`, wrap: COMPACT });
    lines.push({ label: t('Below the price'), text: `${rhoText(st.below.rho, st.below.n)} · ${t('on screen {value}', { value: rhoText(st.below.rhoAll, st.below.nAll) })}`, wrap: COMPACT });
    if (st.walls.length) {
      lines.push({ text: t('At the largest liquidation levels'), bold: true, rule: true });
      for (const w of st.walls) lines.push({ label: `${fmtPrice(w.price)} · $${usd(w.usd)}`, text: t('book {ratio} its neighbours', { ratio: times(w.ratio) }), color: w.side === 'long' ? 'sell' : 'buy', wrap: COMPACT });
    }
    lines.push({ text: t('Liquidations are Hyperliquid\'s alone, the book every enabled venue\'s; the positions are about 40 minutes old, the book is now.'), color: 'muted', wrap: true, rule: true });
    // On a phone the box also keeps below the legend, whose buttons lie over the canvas and would hide its first lines.
    paintMirrorBox(ctx, lines, x0, hv.y, { x0: 0, y0: COMPACT ? Math.min(this.#legendBox.bottom + 4, ph / 3) : 0, x1: COMPACT ? pw + W : pw, y1: ph }, p, c => c === 'above' ? p.ask : c === 'below' ? p.bid : c === 'buy' ? p.candleUp : c === 'sell' ? p.candleDown : c === 'muted' ? p.muted : p.text, hv.y < ph / 2 ? 'down' : 'up');
  }

  /** Mirror hover on the liquidation column: the longs that go if price falls to the pointer against the shorts that go if it rises as far. */
  #paintLiqColumnMirror(ctx: CanvasRenderingContext2D, state: AppState, s: LiqStanding, price: number, x0: number, ph: number, W: number): void {
    const hv = this.#profileHover, p = this.#palette, v = this.view;
    if (!hv || hv.column !== 'liq' || !state.show.mirror || !(price > 0)) return;
    const at = v.pOf(hv.y, ph), d = Math.abs(at - price);
    const below = Math.max(0, standingBelow(s, 'long', price) - standingBelow(s, 'long', price - d));
    const above = Math.max(0, standingBelow(s, 'short', price + d) - standingBelow(s, 'short', price));
    const stats = mirrorStats(price, at, above, below);
    if (!stats) return;
    const top = v.yOf(price + d, ph), bottom = v.yOf(price - d, ph), pct = percentText(stats);
    // The strip has no room for the band's pills: its box says the same.
    const wide = W >= PROFILE_W;
    dimOutside(ctx, x0, W, 0, ph, top, bottom, p.panel, 0.6);
    paintBand(ctx, p, x0, W, { y: top, color: p.candleUp, label: wide ? `${usd(stats.aboveUsd)} · ${pct}` : '' }, { y: bottom, color: p.candleDown, label: wide ? `${usd(stats.belowUsd)} · ${pct}` : '' }, { y0: 0, y1: ph });
    const empty = { none: t('No liquidation levels in this range'), onlyThis: t('Only this side has liquidation levels'), onlyOpposite: t('Only the opposite side has liquidation levels') };
    this.#profileBox = { lines: mirrorLines(stats, { above: t('Short liquidations'), below: t('Long liquidations') }, undefined, empty), y: hv.y, placement: stats.hoveredSide === 'above' ? 'down' : 'up' };
  }

  #paintCrosshair(ctx: CanvasRenderingContext2D, state: AppState, pw: number, ph: number): void {
    const hv = state.hover; if (!hv) { this.#orders.rest(); return; }
    const p = this.#palette, v = this.view;
    const x = v.xOf(hv.t, pw), inX = x >= 0 && x <= pw, ownY = hv.source === 'heat' && hv.price !== null;
    // Replay: right of its moment everything is covered, so nothing there answers the pointer.
    const here = inX && !(replaying() && hv.t > pageNow());
    const y = ownY ? v.yOf(hv.price!, ph) : -1;
    ctx.strokeStyle = p.muted; ctx.setLineDash([3, 3]); ctx.globalAlpha = 0.8; ctx.beginPath();
    if (inX) { ctx.moveTo(Math.round(x) + 0.5, 0); ctx.lineTo(Math.round(x) + 0.5, ph); }
    if (ownY && y >= 0 && y <= ph) { ctx.moveTo(0, Math.round(y) + 0.5); ctx.lineTo(pw, Math.round(y) + 0.5); }
    ctx.stroke(); ctx.setLineDash([]); ctx.globalAlpha = 1;
    const axisX = this.#w - AXIS_W;
    if (ownY && y >= 0 && y <= ph) { ctx.fillStyle = p.text; ctx.fillRect(axisX + 1, y - 9, AXIS_W - 1, 18); ctx.fillStyle = p.bg; ctx.textAlign = 'left'; ctx.fillText(fmtPrice(hv.price!), axisX + 6, y); }
    let trapHit: Trap | null = null, rowHit: ReturnType<HeatPane['footprintCellUnder']> = null, measured: ReturnType<TopProfile['readout']> = null, profiled: ProfileRowHit | null = null, stripped = -1;
    const touch = hv.touch === true;
    if (touch && ownY && inX && y >= 0 && y <= ph) { ctx.strokeStyle = p.text; ctx.lineWidth = 1.6; ctx.beginPath(); ctx.arc(x, y, 7, 0, Math.PI * 2); ctx.stroke(); ctx.lineWidth = 1; }
    stripped = ownY && here ? this.#stripAt(x, y, ph, pw) : -1;
    // A script's mark is a small target someone aimed at: it answers before what is drawn under it.
    const marked = ownY && here && stripped < 0 ? this.scriptMarkAt(x, y, touch) : null;
    const absorbed = ownY && here && stripped < 0 && !marked ? this.#absorptionAt(x, y) : null;
    const forced = ownY && here && stripped < 0 && !absorbed ? this.#diamondAt(x, y) : null;
    const hit = ownY && here && stripped < 0 && !absorbed && !forced ? this.#bubbleAt(x, y) : null;
    if (stripped < 0) this.#orders.rest();
    if (stripped >= 0) { // a bar of the volume strip: it owns its rectangle, over whatever is drawn there
      const s = this.#strip!, bar = s.bars[stripped]!, whale = scaledUsd(state.barStatOptions.whaleUsd);
      const lines = stripLines(bar, { rows: s.rows, tf: s.tf, now: pageNow(), market: s.market, tfName: s.tfName, reports: s.reports, total: s.total, orders: this.#stripOrders(state, s, bar, whale), whaleUsd: whale });
      paintInfoBox(ctx, lines, x, s.top - 8, { x0: 0, y0: 0, x1: pw, y1: ph }, p, { placement: 'up' });
    } else if (marked) { // a script's mark: its text in its colour, what the script says of it, and the script's name
      const edge = marked.color, pick = (c: InfoColor): string => c === 'above' ? edge : c === 'muted' ? p.muted : p.text;
      paintInfoBox(ctx, marked.lines, x, touch ? marked.box.y - 8 : marked.box.y + marked.box.h / 2, { x0: 0, y0: 0, x1: pw, y1: ph }, p, { edge, pick, gap: Math.max(10, marked.box.w / 2 + 8), placement: touch ? 'up' : 'center' });
    } else if (forced) { // a liquidation under the pointer: which positions were closed, where, and what the exchange reported
      const long = forced.liq.side === 'long';
      paintInfoBox(ctx, liquidationLines(forced.liq), x, touch ? forced.y - forced.r - 8 : forced.y, { x0: 0, y0: 0, x1: pw, y1: ph }, p, { edge: long ? p.candleDown : p.candleUp, gap: forced.r + 10, placement: touch ? 'up' : 'center' });
    } else if (absorbed) { // an absorption mark under the pointer: what was taken, where, and at which threshold
      const passiveBuyers = absorbed.marks[0]!.side === 'sell';
      paintInfoBox(ctx, markLines(absorbed.marks, state.absorption), x, touch ? absorbed.y - absorbed.s - 8 : absorbed.y, { x0: 0, y0: 0, x1: pw, y1: ph }, p, { edge: passiveBuyers ? p.bid : p.ask, gap: absorbed.s / 2 + 10, placement: touch ? 'up' : 'center' });
    } else if (hit) { // a large trade under the pointer: say what it was
      const { print } = hit, venue = venueLabel(print.id), symbol = print.id.split(':').slice(1).join(':'), buy = print.side === 'buy';
      const lines: InfoLine[] = [
        { text: `${buy ? t('BUY') : t('SELL')}  $${usd(print.usd)}`, bold: true, color: buy ? 'buy' : 'sell', mark: print.id },
        { label: t('Venue'), text: `${venue} ${symbol}` },
        ...printPriceLines(print),
        { label: t('Time'), text: `${clock(print.t, true)}:${String(new Date(print.t).getSeconds()).padStart(2, '0')}` },
      ];
      // Beside a mouse pointer the box stands clear of the bubble; above a finger, so the hand does not cover it.
      paintInfoBox(ctx, lines, x, touch ? y - hit.r - 8 : y, { x0: 0, y0: 0, x1: pw, y1: ph }, p, { edge: buy ? p.candleUp : p.candleDown, gap: hit.r + 10, placement: touch ? 'up' : 'center' });
    } else if (ownY && here && (profiled = this.#periodProfileAt(x, y, ph))) { // a row of a day's, week's, month's or session's profile, painted over the rest
      const { hit, k, buy, sell } = profiled, step = hit.row;
      const lines = periodRowLines({ name: hit.name, low: k * step, high: (k + 1) * step, step, buy, sell, total: hit.total, split: hit.split, levels: hit.levels, source: hit.source });
      paintInfoBox(ctx, lines, x, touch ? y - 24 : y, { x0: 0, y0: 0, x1: pw, y1: ph }, p, { placement: touch ? 'up' : 'center' });
    } else if (ownY && here && (trapHit = this.#trapUnder(x, hv.t, hv.price!, pw))) {
      this.#paintTrapPopup(ctx, trapHit, x, y, pw, ph, touch);
    } else if (ownY && here && (rowHit = this.#footprintUnder(x, hv.t, hv.price!, pw))) {
      this.#paintFootprintPopup(ctx, rowHit, x, y, pw, ph, touch);
    } else if (ownY && here && (measured = this.#bands.readout(x, y, hv.t))) { // a bucket of a band along the top: its box, under the band
      paintInfoBox(ctx, measured.lines, x, measured.y, { x0: 0, y0: 0, x1: pw, y1: ph }, p, { placement: 'down' });
    } else if (ownY && here) {
      // The price and the book there, then what the scripts on the map draw at that candle.
      const scripted = this.scriptHover(hv.t, y, touch);
      const liquidation = state.liqLevels.on ? this.#liquidationLines(state, x, y, pw, ph, touch) : [];
      if (state.layer === 'liquidity' || liquidation.length || scripted.length) {
        const lines: InfoLine[] = [{ label: t('Price'), text: fmtPrice(hv.price!) }];
        if (state.layer === 'liquidity') {
          const cell = this.valueAt(hv.t, hv.price!), side = bookSide(cell), source = side ? this.#sourceOf(hv.t, hv.price!, side) : '';
          if (cell && side) lines.push({ label: side === 'ask' ? t('Ask') : t('Bid'), text: `$${usd(Math.max(cell.bid, cell.ask))}`, color: side === 'ask' ? 'above' : 'below', bold: true });
          if (source) lines.push({ label: t('Source'), text: source });
        }
        lines.push(...liquidation);
        lines.push(...scripted);
        paintInfoBox(ctx, lines, x, touch ? y - 24 : y, { x0: 0, y0: 0, x1: pw, y1: ph }, p, { placement: touch ? 'up' : 'center' });
      }
    }
    if (inX) { ctx.fillStyle = p.text; ctx.fillRect(x - 40, ph + 2, 80, 18); ctx.fillStyle = p.bg; ctx.textAlign = 'center'; ctx.fillText(clock(hv.t, true), x, ph + 11); }
  }

  /** The rows of flagged candles that the footprint should mark: the wick's imbalanced cells on the flagged side. */
  #trapMarks(): { wants(barT: number, mid: number, side: 'buy' | 'sell'): boolean; add(x: number, y: number, w: number, h: number, barT: number): void } | undefined {
    if (!this.#traps.traps.length || this.#lodFrame.barAlpha < 0.3) return undefined;
    return {
      wants: (barT, mid, side) => this.#traps.on(barT).some(t => t.side === 'buyers' ? side === 'buy' && mid >= t.zoneLow && mid <= t.zoneHigh : side === 'sell' && mid >= t.zoneLow && mid <= t.zoneHigh),
      add: (x, y, w, h, barT) => { this.#pulseRects.push({ x, y, w, h, active: this.#traps.on(barT).some(t => t.state === 'active') }); },
    };
  }

  /** The trap whose wick is under the pointer in the footprint's rows, if any (and only while the footprint is clearly visible). */
  #trapUnder(x: number, t: number, price: number, pw: number): Trap | null {
    if (this.#lodFrame.barAlpha < 0.3 || !this.#traps.traps.length) return null;
    const tfMs = TIMEFRAMES[this.store.state.timeframe] ?? 3_600_000, start = Math.floor(t / tfMs) * tfMs;
    const slot = pw * tfMs / (this.view.t1 - this.view.t0), left = this.view.xOf(start, pw) + footprintLayout(slot).colLeft;
    if (x < left) return null;
    return this.#traps.on(start).find(trap => price >= trap.zoneLow && price <= trap.zoneHigh) ?? null;
  }

  /** The footprint row under the pointer (and its candle), while the footprint is clearly on screen; null elsewhere. Also read by tests. */
  footprintCellUnder(x: number, t: number, price: number, pw: number): { bar: FootprintBar; cell: RowCell; x: number; y: number; w: number; h: number } | null {
    const data = this.footprintData, step = data.step, v = this.view;
    if (!(step > 0) || this.#lodFrame.barAlpha < 0.3) return null;
    const tfMs = TIMEFRAMES[this.store.state.timeframe] ?? 3_600_000, start = Math.floor(t / tfMs) * tfMs, bar = data.bars.get(start);
    if (!bar || (replaying() && start + tfMs > pageNow())) return null;
    const slot = pw * tfMs / (v.t1 - v.t0), layout = footprintLayout(slot), left = v.xOf(start, pw) + layout.colLeft;
    if (x < left || x > left + layout.colWidth) return null;
    const cell = rowCellAt(bar, step, price);
    if (!cell) return null;
    const ph = this.plotH, rowPx = Math.abs(v.yOf(0, ph) - v.yOf(step, ph));
    return { bar, cell, x: left, y: v.yOf(cell.low + step, ph), w: layout.colWidth, h: Math.max(1, rowPx - 1) };
  }
  #footprintUnder(x: number, t: number, price: number, pw: number): ReturnType<HeatPane['footprintCellUnder']> { return this.footprintCellUnder(x, t, price, pw); }

  /** Box the row under the pointer and say what it holds. */
  #paintFootprintPopup(ctx: CanvasRenderingContext2D, hit: NonNullable<ReturnType<HeatPane['footprintCellUnder']>>, x: number, y: number, pw: number, ph: number, touch: boolean): void {
    const p = this.#palette;
    ctx.save(); ctx.strokeStyle = p.text; ctx.lineWidth = 1; ctx.globalAlpha = 0.9; ctx.strokeRect(Math.round(hit.x) + 0.5, Math.round(hit.y) + 0.5, Math.max(1, Math.round(hit.w) - 1), Math.max(1, Math.round(hit.h)));
    ctx.restore();
    const state = this.store.state, diagonal = state.footprint.diagonal ? this.#footprintMarks.get(this.#footprint, state.barStatOptions).get(hit.bar.t)?.flags.get(hit.cell.low) : undefined;
    // As many of the row's venues by name as the pane has room for (a short map, a phone with another pane open): the rest go together.
    const markets = this.footprintMarkets(state).length;
    let venueLines = VENUE_LINES, lines = rowCellLines(hit.cell, hit.bar, this.footprintData.step, state.timeframe, diagonal, markets, venueLines);
    while (venueLines >= 0 && layoutInfo(() => 0, lines).height > ph - 8) lines = rowCellLines(hit.cell, hit.bar, this.footprintData.step, state.timeframe, diagonal, markets, --venueLines);
    paintInfoBox(ctx, lines, x, y, { x0: 0, y0: 0, x1: pw, y1: ph }, p, { placement: touch ? 'up' : 'center' });
  }

  #paintTrapPopup(ctx: CanvasRenderingContext2D, trap: Trap, x: number, y: number, pw: number, ph: number, touch = false): void {
    const p = this.#palette;
    const texts = trapText(trap, { market: this.store.state.marketId, timeframe: this.store.state.timeframe });
    const lines: InfoLine[] = texts.map((text, i) => i === 0 ? { text, bold: true, color: 'above' } : { text, wrap: true });
    paintInfoBox(ctx, lines, x, touch ? y - 26 : y, { x0: 0, y0: 0, x1: pw, y1: ph }, p, { edge: TRAP_COLOR, placement: touch ? 'up' : 'center', pick: c => c === 'above' ? TRAP_COLOR : c === 'muted' ? p.muted : p.text });
  }

  /** Redraw the pulse layer now, and keep it going (about 20 frames a second, slowly breathing) while a trap that is still live is in view. */
  #startPulse(): void {
    const reduced = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
    this.#drawPulse(performance.now(), reduced);
    if (this.#pulseFrame || reduced || this.#suspended || !this.#pulseRects.some(r => r.active)) return;
    const tick = (time: number): void => {
      this.#pulseFrame = 0;
      if (document.hidden || this.#suspended || !this.#pulseRects.some(r => r.active)) return;
      if (time - this.#pulseDrawn >= 50) this.#drawPulse(time, false);
      this.#pulseFrame = requestAnimationFrame(tick);
    };
    this.#pulseFrame = requestAnimationFrame(tick);
  }
  #drawPulse(time: number, still: boolean): void {
    const ctx = this.#pulse.getContext('2d')!, pw = this.plotW, ph = this.plotH;
    this.#pulseDrawn = time;
    ctx.setTransform(this.#dpr, 0, 0, this.#dpr, 0, 0);
    ctx.clearRect(0, 0, this.#paneW, this.#h);
    if (!this.#pulseRects.length) return;
    // In the plot's coordinates, as the overlay draws.
    ctx.setTransform(this.#dpr, 0, 0, this.#dpr, this.#dpr * this.#left, 0);
    ctx.save(); ctx.beginPath(); ctx.rect(0, 0, pw, ph); ctx.clip();
    // A 2.4 s breath between a faint and a clear glow; a trap that is no longer live (old, or price came back) is a still, faint outline.
    const breath = still ? 0.5 : 0.5 + 0.5 * Math.sin(time / 2400 * Math.PI * 2);
    for (const r of this.#pulseRects) {
      const alpha = r.active ? 0.12 + 0.3 * breath : 0.1;
      ctx.fillStyle = `rgba(245, 165, 36, ${alpha})`; ctx.fillRect(r.x - 1, r.y - 1, r.w + 2, r.h + 2);
      ctx.strokeStyle = `rgba(245, 165, 36, ${r.active ? 0.35 + 0.5 * breath : 0.3})`; ctx.lineWidth = 1.2; ctx.strokeRect(r.x - 0.5, r.y - 0.5, r.w + 1, r.h + 1);
    }
    ctx.restore();
  }

  /**
   * The instruments absorption is judged on (every market the page knows and everything with flow, with its chip on; executions follow the
   * chips, not the Spot/Perp filter, as the bubbles do) and the threshold each is judged at now.
   */
  #absorptionContext(state: AppState): { ids: string[]; thresholds: Map<string, number | null> } {
    const ids = flowLoadIds(state, this.hub.flow.ids).filter(id => !state.disabledVenues.includes(id.slice(0, id.indexOf(':'))));
    const s = state.absorption, minute = Math.floor(Date.now() / 60_000);
    const key = `${this.hub.absorption.version}|${minute}|${s.mode}|${s.k}|${s.sdMinutes}|${s.fixedUsd}|${ids.join(',')}`;
    if (key !== this.#absorptionKey) { this.#absorptionKey = key; this.#absorptionThresholds = this.hub.absorption.thresholds(ids, s, Date.now()); }
    return { ids, thresholds: this.#absorptionThresholds };
  }

  /**
   * Absorption marks: a dot on the level where it happened and, offset from it with a dotted line (so it never covers the bubble of the same
   * orders), a square in the passive side's colour: below the level when passive buyers took market sells, above it when passive sellers
   * took market buys. Squares of one side that would overlap are drawn as one with their volume added, and when there are more than fit,
   * the largest are drawn. A square's area is in proportion to its volume, the largest in view the biggest (see markSize).
   */
  #paintAbsorption(ctx: CanvasRenderingContext2D, state: AppState, pw: number, ph: number): void {
    this.#absorptionIcons = [];
    const s = state.absorption; if (!s.on) return;
    const v = this.view, p = this.#palette, { ids, thresholds } = this.#absorptionContext(state);
    const OFFSET = 20, span = v.t1 - v.t0, pixelMs = span / pw;
    // The squares are worked out again only when the marks, the scale or the plot change, or the map has moved by a whole pixel: a frame that
    // only moves the pointer, or follows the live edge by part of a pixel, draws the same squares moved by what the map moved (`dx`).
    const key = `${this.#absorptionKey}|${Math.round(span)}|${v.p0}|${v.p1}|${pw}|${ph}|${Math.floor(v.t0 / pixelMs)}`;
    if (this.#absorptionLayout?.key !== key) {
      const marks = this.hub.absorption.marks(ids, thresholds, v.t0, v.t1, v.p0, v.p1);
      const icons = iconsOf(marks, m => v.xOf((m.t0 + m.t1) / 2, pw), m => v.yOf(m.price, ph), pw, ph);
      this.#absorptionLayout = { key, t0: v.t0, shown: icons.sort((a, b) => b.usd - a.usd).slice(0, Math.max(30, Math.min(200, Math.round(pw / 12)))) };
    }
    const { shown } = this.#absorptionLayout, dx = (this.#absorptionLayout.t0 - v.t0) / pixelMs;
    if (shown.length) {
      ctx.save(); ctx.beginPath(); ctx.rect(0, 0, pw, ph); ctx.clip();
      const edge = p.dark ? '#f2f2f2' : '#14171c', largest = shown[0]!.usd;
      ctx.font = '600 10px ui-sans-serif, system-ui, sans-serif'; ctx.textBaseline = 'middle'; ctx.textAlign = 'left';
      for (let i = shown.length - 1; i >= 0; i--) {   // the largest last, on top
        const icon = shown[i]!, x = icon.x + dx, passiveBuyers = icon.side === 'sell', color = passiveBuyers ? p.bid : p.ask;
        const size = markSize(icon.usd, largest), iy = icon.y + (passiveBuyers ? OFFSET : -OFFSET);
        ctx.globalAlpha = 0.9; ctx.strokeStyle = color; ctx.lineWidth = 1; ctx.setLineDash([2, 2]);
        ctx.beginPath(); ctx.moveTo(Math.round(x) + 0.5, icon.y); ctx.lineTo(Math.round(x) + 0.5, iy + (passiveBuyers ? -size / 2 : size / 2)); ctx.stroke(); ctx.setLineDash([]);
        ctx.globalAlpha = 1; ctx.fillStyle = color; ctx.fillRect(x - 2, icon.y - 2, 4, 4);
        ctx.fillRect(x - size / 2, iy - size / 2, size, size);
        ctx.strokeStyle = edge; ctx.strokeRect(Math.round(x - size / 2) + 0.5, Math.round(iy - size / 2) + 0.5, Math.round(size) - 1, Math.round(size) - 1);
        this.#absorptionIcons.push({ x, y: iy, s: size, marks: icon.marks, usd: icon.usd });
      }
      if (s.volume) {
        // The volumes after every square, the largest first: one that would cover a square or a label already written is left out (the
        // hover box has it), and one that would run off the chart goes on the square's left.
        const taken = this.#absorptionIcons.map(i => ({ x0: i.x - i.s / 2, y0: i.y - i.s / 2, x1: i.x + i.s / 2, y1: i.y + i.s / 2 }));
        ctx.lineWidth = 3; ctx.strokeStyle = p.dark ? 'rgba(0,0,0,0.6)' : 'rgba(255,255,255,0.8)'; ctx.fillStyle = p.text;
        for (const icon of [...this.#absorptionIcons].reverse()) {
          const label = `$${usd(icon.usd)}`, w = ctx.measureText(label).width;
          let x0 = icon.x + icon.s / 2 + 3; if (x0 + w > pw - 2) x0 = icon.x - icon.s / 2 - 3 - w;
          const box = { x0, y0: icon.y - 6, x1: x0 + w, y1: icon.y + 6 };
          if (taken.some(r => r.x0 < box.x1 && box.x0 < r.x1 && r.y0 < box.y1 && box.y0 < r.y1)) continue;
          taken.push(box); ctx.strokeText(label, x0, icon.y); ctx.fillText(label, x0, icon.y);
        }
      }
      ctx.restore();
    }
    // Say where the picture is not the whole truth: more marks than one answer carries.
    // Only where the cut reached marks: the server keeps the largest, so a cut below the threshold left out nothing that would be drawn.
    const capped = ids.filter(id => { const least = this.hub.absorptionCut.get(id), threshold = thresholds.get(id); return least !== undefined && threshold !== null && threshold !== undefined && least >= threshold; });
    const notes: string[] = [];
    if (capped.length) notes.push(t('Absorption: only the largest marks of {venues} are drawn in this window.', { venues: [...new Set(capped.map(venueLabel))].join(', ') }));
    if (this.hub.absorptionState === 'unavailable') notes.push(t('Absorption is not available from this server.'));
    else if (this.hub.absorptionState === 'failed') notes.push(t('Absorption history could not be loaded; trying again in a minute.'));
    if (notes.length) {
      ctx.save(); ctx.font = '10px ui-sans-serif, system-ui, sans-serif'; ctx.textAlign = 'left'; ctx.textBaseline = 'bottom';
      const bandH = Math.max(34, Math.min(ph * 0.17, 150));
      notes.forEach((text, i) => { const y = ph - bandH - 10 - (notes.length - 1 - i) * 14; ctx.lineWidth = 3; ctx.strokeStyle = p.dark ? 'rgba(0,0,0,0.6)' : 'rgba(255,255,255,0.85)'; ctx.strokeText(text, 8, y); ctx.fillStyle = '#e6a700'; ctx.fillText(text, 8, y); });
      ctx.restore();
    }
  }

  /** The threshold each venue is judged at now, in words for the settings panel ("Binance $774K · Bybit $472K"); empty before any is known. */
  absorptionThresholdText(): string {
    const { thresholds } = this.#absorptionContext(this.store.state), byVenue = new Map<string, number>();
    for (const [id, value] of thresholds) if (value !== null) { const venue = venueLabel(id); byVenue.set(venue, Math.max(byVenue.get(venue) ?? 0, value)); }
    return [...byVenue].sort((a, b) => b[1] - a[1]).map(([venue, value]) => `${venue} $${usd(value)}`).join(' · ');
  }

  /**
   * Liquidations as diamonds where the market was when they came: in the sell colour where longs were closed (the exchange sold them), the
   * buy colour where shorts were, as every mark on the page; the diamond and its hard edge say forced. The area is in proportion to the USD
   * closed, the largest in view the biggest, and only the largest few hundred in view are drawn. A venue switched off is left out, as for the
   * bubbles; one large enough carries its exchange's mark, and with labels on the larger ones have their size beside them.
   */
  #paintLiquidations(ctx: CanvasRenderingContext2D, state: AppState, pw: number, ph: number): void {
    this.#diamonds = [];
    const s = state.liquidations; if (!s.on) return;
    const v = this.view, p = this.#palette, off = state.disabledVenues;
    const hidden = (l: Liquidation): boolean => liquidationHidden(l, s) || (off.length > 0 && off.includes(l.id.slice(0, l.id.indexOf(':'))));
    const visible = topPrints(this.hub.liquidations.items, v.t0, replaying() ? Math.min(v.t1, pageNow()) : v.t1, v.p0, v.p1, Math.max(30, Math.min(300, Math.round(pw / 10))), hidden);
    if (!visible.length) return;
    const ordered = [...visible].sort((a, b) => a.usd - b.usd), largest = ordered[ordered.length - 1]!.usd, edge = p.dark ? '#ffffff' : '#14171c';
    ctx.save(); ctx.beginPath(); ctx.rect(0, 0, pw, ph); ctx.clip();
    for (const l of ordered) {
      const x = v.xOf(l.t, pw), y = v.yOf(l.price, ph), r = diamondRadius(l.usd, largest) * s.scale;
      if (x < -r || x > pw + r) continue;
      ctx.beginPath(); ctx.moveTo(x, y - r); ctx.lineTo(x + r, y); ctx.lineTo(x, y + r); ctx.lineTo(x - r, y); ctx.closePath();
      ctx.globalAlpha = 0.8; ctx.fillStyle = l.side === 'long' ? p.ask : p.bid; ctx.fill();
      ctx.globalAlpha = 1; ctx.lineWidth = r >= 8 ? 1.6 : 1.2; ctx.strokeStyle = edge; ctx.stroke();
      if (r >= 10) drawVenueMark(ctx, l.id, x, y, Math.min(14, Math.round(r * 0.85)));
      this.#diamonds.push({ x, y, r, liq: l });
    }
    if (s.labels) {
      // The size beside the larger diamonds, the largest first; one that would run into a diamond or a label already written is left to the box.
      const taken = this.#diamonds.map(d => ({ x0: d.x - d.r, y0: d.y - d.r, x1: d.x + d.r, y1: d.y + d.r }));
      ctx.font = '600 10px ui-sans-serif, system-ui, sans-serif'; ctx.textBaseline = 'middle'; ctx.textAlign = 'left';
      ctx.lineWidth = 3; ctx.strokeStyle = p.dark ? 'rgba(0,0,0,0.6)' : 'rgba(255,255,255,0.85)'; ctx.fillStyle = p.text;
      for (let i = this.#diamonds.length - 1; i >= 0; i--) {
        const d = this.#diamonds[i]!; if (d.r < 7) continue;
        const label = `$${usd(d.liq.usd)}`, w = ctx.measureText(label).width;
        let x0 = d.x + d.r + 3; if (x0 + w > pw - 2) x0 = d.x - d.r - 3 - w;
        const box = { x0, y0: d.y - 6, x1: x0 + w, y1: d.y + 6 };
        if (taken.some(r => r.x0 < box.x1 && box.x0 < r.x1 && r.y0 < box.y1 && box.y0 < r.y1)) continue;
        taken.push(box); ctx.strokeText(label, x0, d.y); ctx.fillText(label, x0, d.y);
      }
    }
    ctx.restore();
  }

  /** The drawn liquidation the pointer is on (inside its diamond, with a few pixels of slack), the nearest if several. */
  #diamondAt(x: number, y: number): { r: number; liq: Liquidation; y: number } | null {
    let best: { r: number; liq: Liquidation; y: number } | null = null, bestD = Infinity;
    for (const d of this.#diamonds) { const reach = Math.abs(d.x - x) + Math.abs(d.y - y); if (reach <= d.r + 3 && reach < bestD) { best = d; bestD = reach; } }
    return best;
  }

  /** The absorption icon under the pointer, if any. */
  #absorptionAt(x: number, y: number): { marks: AbsorptionMark[]; s: number; y: number } | null {
    for (let i = this.#absorptionIcons.length - 1; i >= 0; i--) { const icon = this.#absorptionIcons[i]!; if (Math.abs(icon.x - x) <= icon.s / 2 + 3 && Math.abs(icon.y - y) <= icon.s / 2 + 3) return icon; }
    return null;
  }

  /**
   * The venue whose bubble the pointer is on (an absorption mark under the pointer comes first, as the popup has it), or null. The bubbles
   * have their places for this frame already.
   */
  #bubbleFocus(state: AppState, pw: number, ph: number): string | null {
    const hv = state.hover; if (!hv || hv.source !== 'heat' || hv.price === null || (replaying() && hv.t > pageNow())) return null;
    const x = this.view.xOf(hv.t, pw), y = this.view.yOf(hv.price, ph);
    if (x < 0 || x > pw || y < 0 || y > ph || this.#absorptionAt(x, y) || this.#diamondAt(x, y)) return null;
    const hit = this.#bubbleAt(x, y);
    return hit ? hit.print.id.slice(0, hit.print.id.indexOf(':')) : null;
  }

  /** The drawn bubble nearest the pointer, if the pointer is on it (a few pixels of slack for the small ones). */
  #bubbleAt(x: number, y: number): { r: number; print: Print } | null {
    let best: { r: number; print: Print } | null = null, bestD = Infinity;
    for (const b of this.#bubbles) { const d = Math.hypot(b.x - x, b.y - y); if (d <= b.r + 3 && d < bestD) { best = b; bestD = d; } }
    return best;
  }

  /**
   * The venue behind the liquidity in the cell under (t, price) on `side`: "@binance-spot" when it is nearly all one venue (90 % or
   * more), otherwise the largest with its share and how many others share the cell. Empty until the worker has answered.
   */
  #sourceOf(t: number, price: number, side: 'bid' | 'ask'): string {
    const g = this.#grid; if (!g) return '';
    const b = g.bounds, dt = (b.t1 - b.t0) / g.w, dp = (b.p1 - b.p0) / g.h;
    const x = Math.floor((t - b.t0) / dt), y = Math.floor((price - b.p0) / dp);
    if (x < 0 || y < 0 || x >= g.w || y >= g.h) return '';
    const ids = this.#enabledIds(), key = `${b.t0}|${b.p0}|${g.w}|${g.h}|${x}|${y}|${side}|${ids.length}`;
    if (this.#sources?.key === key) return this.#sources.text;
    if (this.#sourcesAsked !== key) {
      this.#sourcesAsked = key;
      void this.hub.cell(ids, b.t0 + x * dt, b.t0 + (x + 1) * dt, b.p0 + y * dp, b.p0 + (y + 1) * dp).then(items => {
        this.#sources = { key, text: describeSources(items, side) }; this.invalidate();
      });
    }
    return '';
  }

  /** Bid/ask USD of the rasterised cell under (t, price), or null outside the texture. */
  valueAt(t: number, price: number): { bid: number; ask: number } | null {
    const g = this.#grid; if (!g) return null;
    const b = g.bounds, x = Math.floor((t - b.t0) / (b.t1 - b.t0) * g.w), y = Math.floor((price - b.p0) / (b.p1 - b.p0) * g.h);
    if (x < 0 || y < 0 || x >= g.w || y >= g.h) return null;
    const i = (y * g.w + x) * 2;
    return { bid: g.data[i]!, ask: g.data[i + 1]! };
  }

  // ---- touch ----------------------------------------------------------------------------------------------------------------------

  /**
   * One finger: a tap pins the crosshair and its readouts where it landed (tapping the pin again, or panning, lets it go); holding
   * and then dragging scrubs the crosshair along; a plain drag pans, and keeps going after the lift. A drag that starts on the price
   * axis zooms the price scale, and one on the time axis zooms time. Two fingers pinch: the horizontal separation scales time and the
   * vertical one scales price, about the midpoint, so what is under each finger stays under it. A double tap recentres.
   */
  #touchHandlers(): GestureHandlers {
    const reducedMotion = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
    return {
      down: () => this.#stopFling(),
      tap: p => {
        if (this.store.state.vwapAnchoring && p.x >= 0 && p.x <= this.plotW && p.y <= this.plotH) { this.onAnchor?.(this.view.tOf(p.x, this.plotW)); return; }
        if (this.#bands.onHeader(p.x, p.y) || this.#onHiddenTag(p.x, p.y)) { this.onTopProfile(); return; }
        if (p.x >= 0 && p.x <= this.plotW && p.y <= this.plotH && this.draw?.click(p, false, true)) { this.#drawClickAt = performance.now(); this.#unpin(); return; }
        if (this.#pinActive() && Math.hypot(this.#pin!.x - p.x, this.#pin!.y - p.y) < 28) this.#unpin(); else this.#pinAt(p);
      },
      doubleTap: () => { if (this.draw?.placing || performance.now() - this.#drawClickAt < 600) return; this.#unpin(); this.fit(); },
      // A short tick under the finger says the hold registered (where the browser allows it: it wants the page to have been used first).
      hold: p => { if (navigator.userActivation?.hasBeenActive) navigator.vibrate?.(8); this.#pinAt(p); },
      holdMove: p => this.#pinAt(p),
      panStart: p => {
        this.#unpin();
        if (!this.range?.armed && p.x >= 0 && p.x <= this.plotW && p.y <= this.plotH && this.draw?.down(p, true)) { this.#touchDraw = true; return; }
        if (this.range?.armed && p.x >= 0 && p.x <= this.plotW && p.y <= this.plotH) { this.#touchSelect = { start: p, at: p }; this.range.begin(this.#rangePoint(p.x, p.y)); return; }
        this.#panKind = p.y > this.plotH ? 'time' : p.x > this.#w - AXIS_W ? 'price' : 'map';
        this.#axisDrag = this.#panKind === 'map' ? null : { view: this.view.clone(), x: 0, y: 0 };
      },
      pan: (d, at) => { if (this.#touchDraw) { this.draw?.move(at, false, true); return; } if (this.#touchSelect) { this.#touchSelect.at = at; this.range?.move(this.#rangePoint(at.x, at.y)); return; } this.#touchPan(d); },
      panEnd: v => {
        // No velocity: the gesture was cancelled (a second finger, the browser took it), and the drawing goes back to where it was.
        if (this.#touchDraw) { this.#touchDraw = false; if (v === null) this.draw?.cancelPointer(); else this.draw?.up(); return; }
        const touch = this.#touchSelect;
        if (touch) { this.#touchSelect = null; if (v === null) this.range?.cancel(); else this.range?.end(this.#rangePoint(touch.at.x, touch.at.y), Math.hypot(touch.at.x - touch.start.x, touch.at.y - touch.start.y) < DRAG_MIN_PX); return; }
        const kind = this.#panKind; this.#panKind = null; this.#axisDrag = null;
        if (kind === 'map' && v && !reducedMotion && Math.hypot(v.x, v.y) > 0.08) this.#startFling(v);
      },
      pinchStart: info => this.#pinchBegin(info),
      pinch: info => this.#pinchTo(info),
      pinchEnd: () => { this.#pinch = null; },
      cancel: () => { if (this.#touchDraw) { this.#touchDraw = false; this.draw?.cancelPointer(); } this.#panKind = null; this.#axisDrag = null; this.#pinch = null; if (this.#touchSelect) { this.#touchSelect = null; this.range?.cancel(); } },
    };
  }

  /** The handlers the panes under the map use for the time axis they share: dragging pans it, pinching zooms it, a double tap recentres. */
  timeGestures(): Pick<GestureHandlers, 'down' | 'panStart' | 'pan' | 'panEnd' | 'pinchStart' | 'pinch' | 'pinchEnd' | 'doubleTap' | 'cancel'> {
    const base = this.#touchHandlers();
    // Only time is shared: a finger's height in a lower pane says nothing about price, so it is flattened out of the pinch.
    const flat = (i: PinchInfo): PinchInfo => ({ ...i, mid: { x: i.mid.x, y: 0 }, startMid: { x: i.startMid.x, y: 0 }, start: { ...i.start, dy: 0 } });
    return {
      down: base.down,
      panStart: () => { this.#unpin(); this.#panKind = 'map'; this.#axisDrag = null; },
      pan: d => this.#touchPan({ x: d.x, y: 0 }),
      panEnd: v => { this.#panKind = null; if (v && Math.abs(v.x) > 0.08) this.#startFling({ x: v.x, y: 0 }); },
      pinchStart: info => this.#pinchBegin(flat(info)),
      pinch: info => this.#pinchTo(flat(info)),
      pinchEnd: base.pinchEnd,
      doubleTap: () => { this.#unpin(); this.fit(); },
      cancel: base.cancel,
    };
  }

  /**
   * Which of the columns beside the map is at `x`: the seam between the liquidation column and the profile column (a few px either side of
   * it, while both show), the liquidation column (nearest the map), then the profile column; null for none.
   */
  #besideAt(x: number): 'liq' | 'book' | 'seam' | null {
    const state = this.store.state, pw = this.plotW, liq = liqColumnW(state), book = profileColumnW(state);
    // The seam takes a few px each side; beside a 16 px strip fewer, so most of the strip is still the book's.
    if (liq && book && Math.abs(x - (pw + liq)) <= (book < PROFILE_W ? 4 : 6)) return 'seam';
    if (liq && x > pw && x <= pw + liq) return 'liq';
    return book && x > pw + liq && x <= pw + liq + book ? 'book' : null;
  }

  /** Whether a finger's pin is what is on show now (a tap on a pane under the map replaces it with its own). */
  #pinActive(): boolean { const hv = this.store.state.hover; return this.#pin !== null && (this.#profileHover !== null || this.#tradedHover !== null || (hv?.touch === true && hv.source === 'heat')); }
  /** Drop the pinned crosshair (and the profile comparison), if any. */
  #unpin(): void {
    if (!this.#pin && !this.#profileHover && !this.#tradedHover) return;
    this.#pin = null; this.#profileHover = null; this.#tradedHover = null;
    if (this.store.state.hover?.touch) this.store.set({ hover: null });
    this.invalidate();
  }
  /** Pin the crosshair at `p`: on the map it is the usual crosshair with its readouts, on the profile column the Mirror comparison, anywhere else nothing. */
  #pinAt(p: Pt): void {
    const pw = this.plotW, ph = this.plotH, v = this.view;
    this.#pin = p;
    const column = this.#columnAt(p.x);
    this.#tradedHover = null;
    if (p.x >= 0 && p.x <= pw && p.y >= 0 && p.y <= ph) {
      this.#profileHover = null;
      this.store.set({ hover: { t: v.tOf(p.x, pw), price: v.pOf(p.y, ph), y: p.y, source: 'heat', touch: true } });
    } else if (this.#besideAt(p.x) && p.y >= 0 && p.y <= ph) {
      this.#profileHover = { y: p.y, column: this.#besideAt(p.x)! }; this.store.set({ hover: null });
    } else if (column && p.y >= 0 && p.y <= ph) {
      this.#profileHover = null; this.#tradedHover = { y: p.y, side: column.side, i: column.i }; this.store.set({ hover: null });
    } else { this.#pin = null; this.#profileHover = null; this.store.set({ hover: null }); }
    this.invalidate();
  }

  #touchPan(d: Pt): void {
    const pw = this.plotW, ph = this.plotH, kind = this.#panKind;
    if (kind === 'map') {
      this.view.pan(d.x, d.y, pw, ph);
      this.store.set({ followLive: false }); this.#liveMargin = this.view.t1 - pageNow(); this.#rasteredKey = ''; this.onView(); this.invalidate();
      return;
    }
    const z = this.#axisDrag; if (!z) return;
    z.x += d.x; z.y += d.y;
    const v0 = z.view;
    if (kind === 'price') {
      // Drag down to zoom out, up to zoom in, about the middle of the scale (the same sense as the right-button drag).
      const mid = (v0.p0 + v0.p1) / 2, span = Math.max((v0.p1 - v0.p0) * Math.exp(z.y * 0.006), this.#priceRef(this.store.state.mark.price) * PRICE_SPAN_SHARE.min);
      this.view.set({ ...v0, p0: mid - span / 2, p1: mid + span / 2 });
    } else {
      const mid = (v0.t0 + v0.t1) / 2, span = Math.max(30_000, (v0.t1 - v0.t0) * Math.exp(-z.x * 0.006));
      this.view.set({ ...v0, t0: mid - span / 2, t1: mid + span / 2 });
    }
    this.#liveMargin = this.view.t1 - pageNow(); this.#rasteredKey = ''; this.onView(); this.invalidate();
  }

  #pinchBegin(info: PinchInfo): void {
    this.#unpin(); this.#stopFling();
    const pw = this.plotW, ph = this.plotH, v = this.view;
    const mx = Math.max(0, Math.min(pw, info.mid.x)), my = Math.max(0, Math.min(ph, info.mid.y));
    this.#pinch = { view: v.clone(), t: v.tOf(mx, pw), p: v.pOf(my, ph) };
  }
  #pinchTo(info: PinchInfo): void {
    const z = this.#pinch; if (!z) return;
    const pw = this.plotW, ph = this.plotH, v0 = z.view;
    const sx = axisPinchScale(info.start.dx, info.now.dx), sy = axisPinchScale(info.start.dy, info.now.dy);
    const mark = this.store.state.mark.price || (v0.p0 + v0.p1) / 2;
    const clamp = (x: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, x));
    const tSpan = clamp((v0.t1 - v0.t0) / sx, 30_000, 400 * 86_400_000), pSpan = clamp((v0.p1 - v0.p0) / sy, mark * 1e-4, mark * 2);
    const mx = clamp(info.mid.x, 0, pw), my = clamp(info.mid.y, 0, ph);
    const t0 = z.t - mx / pw * tSpan, p1 = z.p + my / ph * pSpan;
    this.view.set({ t0, t1: t0 + tSpan, p0: p1 - pSpan, p1 });
    // Moving the two fingers together is a pan as well: after a real move the view no longer follows the live edge on its own.
    if (Math.hypot(info.mid.x - info.startMid.x, info.mid.y - info.startMid.y) > 12 && this.store.state.followLive) this.store.set({ followLive: false });
    this.#liveMargin = this.view.t1 - pageNow(); this.#rasteredKey = ''; this.onView(); this.invalidate();
  }

  /** Carry on panning after the finger lifts, slowing to a stop (about a quarter of a second per e-fold of speed). */
  #startFling(v: Pt): void {
    this.#stopFling();
    const limit = (x: number): number => Math.max(-4, Math.min(4, x));
    let vx = limit(v.x), vy = limit(v.y), last = performance.now();
    const step = (now: number): void => {
      const dt = Math.min(48, now - last); last = now;
      this.view.pan(vx * dt, vy * dt, this.plotW, this.plotH);
      this.store.set({ followLive: false }); this.#liveMargin = this.view.t1 - pageNow(); this.#rasteredKey = ''; this.onView(); this.invalidate();
      const decay = Math.exp(-dt / 260); vx *= decay; vy *= decay;
      this.#fling = Math.hypot(vx, vy) < 0.02 || document.hidden ? 0 : requestAnimationFrame(step);
    };
    this.#fling = requestAnimationFrame(step);
  }
  #stopFling(): void { if (this.#fling) { cancelAnimationFrame(this.#fling); this.#fling = 0; } }

  /** Whether (`x`, `y`) is on the price scale, the column at the right edge that carries the prices (the profile column beside it is not the scale). */
  #onScale(x: number, y: number): boolean { return y >= 0 && y <= this.plotH && x >= this.#w - AXIS_W; }

  /** The price the span limits are a share of: the current price, or the middle of the view before there is one. */
  #priceRef(mark: number): number { return priceRef(mark, this.view.p0, this.view.p1); }

  /** The price scale is being dragged: `y` pixels below where it began zooms out by exp(0.006 per pixel), holding the price where the drag took hold. */
  #dragScale(y: number): void {
    const z = this.#scaleDrag; if (!z) return;
    const v0 = z.view, ph = this.plotH, ref = this.#priceRef(this.store.state.mark.price);
    const factor = limitFactor(Math.exp((y - z.y) * 0.006), v0.p1 - v0.p0, ref * PRICE_SPAN_SHARE.min, ref * PRICE_SPAN_SHARE.max);
    const anchor = v0.p0 + (1 - z.hold / ph) * (v0.p1 - v0.p0), span = (v0.p1 - v0.p0) * factor, p1 = anchor + z.hold / ph * span;
    this.view.set({ ...v0, p0: p1 - span, p1 });
    this.#rasteredKey = ''; this.onView(); this.invalidate();
  }

  #bindInput(): void {
    const el = this.overlay;
    // In the plot's coordinates: the columns left of the map are at negative x.
    const local = (e: MouseEvent) => { const r = el.getBoundingClientRect(); return { x: e.clientX - r.left - this.#left, y: e.clientY - r.top }; };
    const touched = () => { this.store.set({ followLive: false }); this.#liveMargin = this.view.t1 - pageNow(); this.#rasteredKey = ''; this.onView(); this.invalidate(); };
    // The wheel on the chart zooms time and price together by the same factor (the picture keeps its shape), on the price scale price alone, on the
    // time strip time alone; Shift on the chart zooms time only (`wheelZoom`). Each axis holds still what is being watched: the live edge and the
    // current price while the map follows the market, so it swells and shrinks around them instead of sliding; the point under the pointer on a map
    // moved by hand, and with Alt.
    el.addEventListener('wheel', e => {
      e.preventDefault();
      const { x, y } = local(e), pw = this.plotW, ph = this.plotH, v = this.view, state = this.store.state, mark = state.mark.price;
      const zoom = wheelZoom({ region: regionAt(x, y, pw, ph), shift: e.shiftKey, alt: e.altKey, follow: state.followLive, deltaY: e.deltaY, deltaMode: e.deltaMode, x, y, plotW: pw, plotH: ph, view: v, mark, markY: v.yOf(mark, ph), nowX: v.xOf(pageNow(), pw) });
      if (zoom.price) v.zoomPrice(zoom.price.factor, zoom.price.hold, ph);
      if (zoom.time) v.zoomTime(zoom.time.factor, zoom.time.hold, pw);
      if (zoom.unfollow) this.store.set({ followLive: false });
      this.#liveMargin = this.view.t1 - pageNow(); this.#rasteredKey = ''; this.onView(); this.invalidate();
    }, { passive: false });
    el.addEventListener('contextmenu', e => e.preventDefault());
    el.addEventListener('pointerdown', e => {
      if (e.pointerType === 'touch') return;
      const { x, y } = local(e);
      // Placing a VWAP anchor: the click is the anchor, nothing else.
      // The plot is from 0 to plotW: the columns left of the map are at negative x and take their own presses.
      const onPlot = x >= 0 && x <= this.plotW && y <= this.plotH;
      if (this.store.state.vwapAnchoring && e.button === 0 && onPlot) { this.onAnchor?.(this.view.tOf(x, this.plotW)); return; }
      if (e.button === 0 && (this.#bands.onHeader(x, y) || this.#onHiddenTag(x, y))) { this.onTopProfile(); return; }
      if (this.range && selects(this.range.armed, e) && onPlot) {
        this.#selecting = { x, y }; this.range.begin(this.#rangePoint(x, y)); el.setPointerCapture(e.pointerId); return;
      }
      const column = this.#columnAt(x);
      // A selection on the column is a question to the recording: there is none to ask of an estimate from candles (the press pans the chart),
      // and none either while the estimate is wanted and its candles are on their way (it would shade the estimate that replaces the recording);
      // where they cannot come the column is the recording's and a press selects.
      if (this.range && e.button === 0 && column && y >= 0 && y <= this.plotH && !(column.metric === 'volume' && this.#loadedBlocksRange(this.store.state))) {
        this.#columnSelect = { y, side: column.side, i: column.i };
        const { from, to } = this.#tradedWindow(), band = this.#columnBand(y, y);
        this.range.begin({ t: from, p: band.p0 }); this.range.move({ t: to, p: band.p1 }, { t: from, p: band.p0 });
        el.setPointerCapture(e.pointerId); return;
      }
      if (e.button === 2) { this.#zoomDrag = { x, y, view: this.view.clone() }; el.setPointerCapture(e.pointerId); return; }
      if (e.button !== 0) return;
      // The drawing tools come next: a press on the selected drawing's handle or stroke drags it instead of the map.
      if (onPlot && this.draw?.down({ x, y }, false)) { this.#press = null; el.setPointerCapture(e.pointerId); return; }
      this.#press = onPlot ? { x, y, moved: false } : null;
      if (this.#onScale(x, y)) {
        // Dragging the price scale zooms it (up zooms in, down zooms out) about the current price, or the price under the pointer when that is off the map.
        const v = this.view, ph = this.plotH, mark = this.store.state.mark.price;
        this.#scaleDrag = { y, view: v.clone(), hold: holdPixel({ axis: 'price', pointer: y, size: ph, alt: false, follow: false, mark, markPixel: v.yOf(mark, ph), nowPixel: 0 }) };
        el.setPointerCapture(e.pointerId); el.style.cursor = 'ns-resize'; return;
      }
      this.#drag = { x, y, shift: e.shiftKey, panning: false }; el.setPointerCapture(e.pointerId);
    });
    el.addEventListener('pointermove', e => {
      if (e.pointerType === 'touch') return;
      const { x, y } = local(e);
      if (this.#scaleDrag) { this.#dragScale(y); return; }
      if (this.draw?.dragging) { this.draw.move({ x, y }, e.altKey, false); const axis = this.draw.dragAxis; el.style.cursor = axis === 'p' ? 'ns-resize' : axis === 't' ? 'ew-resize' : 'grabbing'; return; }
      const press = this.#press;
      if (press && !press.moved && Math.hypot(x - press.x, y - press.y) >= DRAG_MIN_PX) press.moved = true;
      if (this.#columnSelect && this.range) {
        const { from, to } = this.#tradedWindow(), band = this.#columnBand(this.#columnSelect.y, y);
        this.range.move({ t: to, p: band.p1 }, { t: from, p: band.p0 });
        this.#tradedHover = { y, side: this.#columnSelect.side, i: this.#columnSelect.i }; this.invalidate();
        return;
      }
      if (this.#selecting && this.range) {
        this.range.move(this.#rangePoint(x, y));
        if (x >= 0 && x <= this.plotW && y <= this.plotH) this.store.set({ hover: { t: this.view.tOf(x, this.plotW), price: this.view.pOf(y, this.plotH), y, source: 'heat' } });
        return;
      }
      const overColumn = this.#columnAt(x) !== null && y <= this.plotH;
      const onPlot = x >= 0 && x <= this.plotW && y <= this.plotH;
      // The drawing tools follow the pointer: the next point's preview with a tool armed, else what of the drawings is under it.
      if (onPlot && !this.#drag?.panning) this.draw?.move({ x, y }, e.altKey, false); else if (!onPlot) this.draw?.leave();
      const drawHover = onPlot && !this.draw?.placing ? this.draw?.hover ?? null : null;
      el.style.cursor = this.#onScale(x, y) ? 'ns-resize' : this.#bands.onHeader(x, y) || this.#onHiddenTag(x, y) ? 'pointer'
        : drawHover ? (!this.draw!.canDrag(drawHover.id) ? 'pointer' : drawHover.part === 'handle' ? (drawHover.axis === 'p' ? 'ns-resize' : drawHover.axis === 't' ? 'ew-resize' : 'grab') : drawHover.id === this.draw!.selected && drawHover.part === 'stroke' ? 'move' : 'pointer')
        : overColumn || ((this.range?.armed || this.store.state.vwapAnchoring || this.draw?.placing) && onPlot) ? 'crosshair' : '';
      if (this.#zoomDrag) {
        // Drag right zooms the time axis in, drag up zooms the price axis in (left/down zoom out).
        const z = this.#zoomDrag, k = 0.006, pw = this.plotW, ph = this.plotH;
        const fx = Math.exp(-(x - z.x) * k), fy = Math.exp((y - z.y) * k);
        const v0 = z.view, tAnchor = v0.t0 + Math.min(z.x, pw) / pw * (v0.t1 - v0.t0), pAnchor = v0.p0 + (1 - Math.min(z.y, ph) / ph) * (v0.p1 - v0.p0);
        const tSpan = Math.max(30_000, (v0.t1 - v0.t0) * fx), pSpan = Math.max((v0.p1 - v0.p0) * fy, this.#priceRef(this.store.state.mark.price) * PRICE_SPAN_SHARE.min);
        const t0 = tAnchor - Math.min(z.x, pw) / pw * tSpan, p1 = pAnchor + Math.min(z.y, ph) / ph * pSpan;
        this.view.set({ t0, t1: t0 + tSpan, p0: p1 - pSpan, p1 });
        this.#liveMargin = this.view.t1 - pageNow(); this.#rasteredKey = ''; this.onView(); this.invalidate();
        return;
      }
      if (this.#drag && (this.#drag.panning || !this.draw?.placing || press?.moved)) {
        const dx = x - this.#drag.x, dy = this.#drag.shift ? 0 : y - this.#drag.y;
        this.view.pan(dx, dy, this.plotW, this.plotH); this.#drag.x = x; this.#drag.y = y; this.#drag.panning = true; touched();
      }
      if (x >= 0 && x <= this.plotW && y <= this.plotH) this.store.set({ hover: { t: this.view.tOf(x, this.plotW), price: this.view.pOf(y, this.plotH), y, source: 'heat' } });
      else this.store.set({ hover: null });
      const beside = this.#besideAt(x), column = this.#columnAt(x);
      this.#profileHover = !this.#drag && beside && y >= 0 && y <= this.plotH ? { y, column: beside } : null;
      this.#tradedHover = !this.#drag && column && y >= 0 && y <= this.plotH ? { y, side: column.side, i: column.i } : null;
      this.invalidate();
    });
    el.addEventListener('pointerup', e => {
      if (e.pointerType === 'touch') return;
      if (this.draw?.dragging) { this.draw.up(); if (el.hasPointerCapture(e.pointerId)) el.releasePointerCapture(e.pointerId); el.style.cursor = ''; return; }
      const column = this.#columnSelect;
      if (column && this.range) {
        // A click without a drag selects the one row under it.
        const { y } = local(e), { from, to } = this.#tradedWindow(), band = this.#columnBand(column.y, y); this.#columnSelect = null;
        this.range.end({ t: to, p: band.p1 }, false, { t: from, p: band.p0 });
        if (el.hasPointerCapture(e.pointerId)) el.releasePointerCapture(e.pointerId);
        return;
      }
      const sel = this.#selecting;
      if (sel && this.range) {
        const { x, y } = local(e); this.#selecting = null;
        this.range.end(this.#rangePoint(x, y), Math.hypot(x - sel.x, y - sel.y) < DRAG_MIN_PX);
        if (el.hasPointerCapture(e.pointerId)) el.releasePointerCapture(e.pointerId);
        return;
      }
      // A press that did not move is a click: the drawing tools place a point, or select (or let go of) a drawing.
      const press = this.#press; this.#press = null;
      if (press && !press.moved && e.button === 0 && this.draw) { const at = local(e); if (this.draw.click(at, e.altKey, false)) this.#drawClickAt = performance.now(); }
      this.#drag = null; this.#zoomDrag = null; this.#scaleDrag = null; el.style.cursor = this.#onScale(local(e).x, local(e).y) ? 'ns-resize' : ''; if (el.hasPointerCapture(e.pointerId)) el.releasePointerCapture(e.pointerId); });
    el.addEventListener('pointercancel', e => { if (e.pointerType === 'touch') return; this.#press = null; this.draw?.cancelPointer(); });
    el.addEventListener('pointerleave', e => { if (e.pointerType === 'touch') return; if (!this.draw?.dragging) this.draw?.leave(); if (!this.#scaleDrag) el.style.cursor = ''; this.#profileHover = null; this.#tradedHover = null; if (!this.#drag && !this.#zoomDrag) { this.store.set({ hover: null }); this.invalidate(); } });
    // A double click recentres the map, except while a tool is armed or when it selected a drawing (its first click was the drawing tools').
    el.addEventListener('dblclick', () => { if (this.draw?.placing || performance.now() - this.#drawClickAt < 600) return; this.fit(); });
    bindTouch(el, new GestureRecognizer(this.#touchHandlers()), () => this.#left);
  }
}
