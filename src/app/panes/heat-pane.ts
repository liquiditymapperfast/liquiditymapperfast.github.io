import { HeatGL, type HeatStyle } from '../heatmap/gl.ts';
import { buildLut } from '../heatmap/lut.ts';
import { colourWindow, nextBaseline, type Baseline } from '../heatmap/window.ts';
import { isCoarse, isPhone } from '../device.ts';
import { dimOutside, mirrorLines, mirrorStats, paintBand, paintMirrorBox, percentText, type MirrorLine, type MirrorStats } from '../mirror.ts';
import { TIMEFRAMES, valueAreaKey, type Hub, type RasterResult } from '../hub.ts';
import { gridStepFor } from '../../shared/grid.ts';
import type { ProfileAnswer } from '../../shared/footprint.ts';
import type { ValueLevels } from '../../shared/profile.ts';
import { answerLevels, linesWindows, requestStep, touchedAt } from '../traded/levels.ts';
import type { ProfileWindow } from '../traded/sessions.ts';
import type { Kernels } from '../kernels.ts';
import { PALETTES, rgb, textOn, type Palette } from '../theme.ts';
import { View, niceStep, type Bounds } from '../view.ts';
import { clock, dayOfMonth, price as fmtPrice, tickLabel, usd, zoneName, zoneOffsetMs } from '../format.ts';
import type { Store, AppState, CandleRow } from '../store.ts';
import { cumulative, groupLevels, type Grouped } from './levels-data.ts';
import { activeIds, emptyScopeMessage, heatmapSourceOf } from '../scope.ts';
import { bubbleHidden, bubbleRadius, printPriceLines, topPrints, type Print } from '../prints.ts';
import { tradedHeader, tradedLines, tradedRowAt, tradedRows, type TradedRows } from '../traded.ts';
import { flowIds, flowLoadIds } from '../cvd/ids.ts';
import { iconsOf, markLines, markSize, type AbsorptionMark, type MarkIcon } from '../absorption.ts';
import { diamondRadius, liquidationHidden, liquidationLines, type Liquidation } from '../liquidations.ts';
import { venueLabel } from '../venues.ts';
import { describeSources } from '../cell-sources.ts';
import { anomalies, type Anomalies } from '../anomaly.ts';
import { paintWatermark } from '../watermark.ts';
import { FootprintData, FootprintLod, candleBody, footprintLayout, paintFootprint, rowCellAt, rowCellLines, visibilityFactor, type Bar as FootprintBar, type LodFrame, type RowCell } from './footprint.ts';
import { paintInfoBox, type InfoLine } from '../infobox.ts';
import { TrapData, trapStatusText, trapText, type Trap } from '../traps.ts';
import { GestureRecognizer, axisPinchScale, bindTouch, type GestureHandlers, type PinchInfo, type Pt } from '../touch.ts';
import { PRICE_SPAN_SHARE, TIME_SPAN_MS, holdPixel, limitFactor, regionAt, wheelAxis } from './heat-zoom.ts';
import { t } from '../i18n.ts';
import { currentCoin, scaledUsd } from '../coin.ts';
import { resolveZone } from '../traded/settings.ts';
import { MAX_BACK_MS, barMsFor, keyLines, neededFrom, type KeyLine } from '../keylevels/levels.ts';
import { anyLine } from '../keylevels/settings.ts';
import { historyTarget, type HistoryTarget } from '../keylevels/history.ts';
import { paintKeyLevels, paintKeyTags, placeKeyTags, underTag, type KeyTag } from '../keylevels/paint.ts';
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
import { countdown, lineSide } from '../price-line.ts';
import { candlesAt, formingCandle, pageNow, replaying, replayView } from '../replay/clock.ts';

/** The colour of a flag on a candle's wick: amber reads on every theme and is neither side's colour. */
const TRAP_COLOR = '#f5a524';

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
/** A recording younger than this gets the faded placeholder to its left. */
const PLACEHOLDER_MAX_AGE_MS = 2 * 3_600_000;
/** Replay: each VWAP line up to the last bar that ended by its moment (so its tag is the VWAP then); live, the lines as they are. */
function replayCut(lines: VwapLine[], at: number): VwapLine[] {
  if (!replaying()) return lines;
  return lines.map(l => { const step = l.points.length > 1 ? l.points[1]!.t - l.points[0]!.t : 60_000; return { ...l, points: l.points.filter(q => q.t + step <= at) }; });
}

/** Width of the price axis, the profile column and the traded-volume column. A phone gives them less (and no traded column), so the map keeps most of the screen (see `setCompactGutters`). */
export let AXIS_W = 64;
/** The countdown box under the price tag. */
const COUNTDOWN_H = 15;
export let PROFILE_W = 128;
export let TRADED_W = 96;
/** The width the price labels need for the coin on screen: BTC's fit the usual width, a coin priced in millionths needs about eleven characters. */
function axisNeed(): number {
  const price = currentCoin().price;
  return price > 0 && price < 1 ? Math.ceil((Math.ceil(-Math.log10(price * 0.0005)) + 2) * 6.5 + 12) : 0;
}
export function setCompactGutters(compact: boolean): void { AXIS_W = Math.max(compact ? 58 : 64, axisNeed()); PROFILE_W = compact ? 84 : 128; TRADED_W = compact ? 0 : 96; }
/** Whether the traded-volume column is drawn: switched on, and the map is wide enough to have one. */
export const tradedShown = (state: AppState): boolean => state.show.traded && TRADED_W > 0;
const TIME_H = 22;

/** A plot narrower than this (a phone, a split screen) gets the compact legend, whole-dollar prices and a shorter history note. */
const NARROW_PLOT = 420;
/** A map pane narrower than this gets the narrow price axis and profile column. */
const COMPACT_PANE = 520;

const TIME_STEPS = [60e3, 300e3, 900e3, 1800e3, 3600e3, 7200e3, 14400e3, 43200e3, 86400e3, 172800e3, 604800e3];

export function timeTicks(t0: number, t1: number, widthPx: number, minPx = 96): number[] {
  const want = (t1 - t0) * minPx / Math.max(1, widthPx);
  const step = TIME_STEPS.find(s => s >= want) ?? TIME_STEPS[TIME_STEPS.length - 1]!;
  const offset = -zoneOffsetMs(t0);
  const out: number[] = [];
  for (let t = Math.ceil((t0 - offset) / step) * step + offset; t <= t1; t += step) out.push(t);
  return out;
}
export function gutter(state: AppState): number { return AXIS_W + (state.show.profile ? PROFILE_W : 0) + (tradedShown(state) ? TRADED_W : 0); }

/** Rolling volume baseline for a candle array, keyed by the sensitivity it was computed with. */
interface VolumeAnalysis { candles: AppState['candles']; key: string; found: Anomalies }

/** The main chart: GL heatmap texture, candles, volume, axes, price profile and crosshair. */
export class HeatPane {
  readonly root = document.createElement('section');
  readonly gl: HeatGL;
  readonly overlay = document.createElement('canvas');
  readonly view = new View({ t0: 0, t1: 0, p0: 0, p1: 0 });
  stats = { p15: 0, p50: 0, p96: 0, max: 0 };
  /** Mirror-hover comparison for the pointer over the profile column, or null (read by tests, drawn on the profile). */
  mirror: MirrorStats | null = null;
  #profileHover: { y: number } | null = null;
  /** The pointer over the traded-volume column (its y), or null. */
  #tradedHover: { y: number } | null = null;
  #profileBox: { lines: MirrorLine[]; y: number; placement: 'down' | 'up' } | null = null;
  /** The last value given to --gutter on the pane, so a frame that changes nothing writes nothing. */
  #gutterCss = '';
  onStats: () => void = () => {};
  onView: () => void = () => {};
  onFrame: () => void = () => {};
  /** The Delta pane's price/CVD divergences in view (set in main; none while that pane is not drawn). */
  divergences: () => readonly Divergence[] = () => [];
  #glCanvas = document.createElement('canvas');
  #ctx: CanvasRenderingContext2D;
  #w = 0; #h = 0; #dpr = 1;
  #dirty = true; #frame = 0;
  /** When the map was last drawn: the countdown redraws it once a second only when nothing else has (a quiet market). */
  #lastRender = 0;
  #dataVersion = 0; #rasteredVersion = -1; #rasteredKey = ''; #lastRasterAt = 0;
  #liveMargin = 0;
  #palette = PALETTES.light!;
  /** Colour window from the raster's percentiles (nextBaseline): new for a new view, then held, or blended toward the cells every 10 s in Auto. */
  #baseline: Baseline | null = null;
  #forceBaseline = true;
  #drag: { x: number; y: number; shift: boolean } | null = null;
  /** The Range tool (set by the page), and a selection being dragged here: where it began, and where a finger last was. */
  range: RangeTool | null = null;
  #selecting: { x: number; y: number } | null = null;
  /** A drag on the traded column: where it began (it selects whole rows of the column, over the column's window). */
  #columnSelect: { y: number } | null = null;
  /** The point of control and value area of what is on the chart, and the answer and rows they were read from. */
  #levelsMemo: { answer: ProfileAnswer; step: number; share: number; levels: ValueLevels | null } | null = null;
  /** The days, weeks or sessions the lines are drawn for, and what they were worked out for. */
  #vaWindows: { key: string; windows: ProfileWindow[] } | null = null;
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

  constructor(host: HTMLElement, private store: Store, private hub: Hub, private kernels: Kernels) {
    this.root.className = 'pane heat';
    this.#pulse.className = 'pulse';
    this.root.append(this.#glCanvas, this.#pulse, this.overlay);
    host.append(this.root);
    this.gl = new HeatGL(this.#glCanvas);
    this.#ctx = this.overlay.getContext('2d')!;
    new ResizeObserver(() => this.#resize()).observe(this.root);
    this.hub.onRaster = result => this.#onRaster(result);
    this.hub.onColumns = () => { this.#dataVersion++; this.invalidate(); };
    this.#bindInput();
    window.setInterval(() => { this.hub.invalidateColumns(); this.invalidate(); }, 30_000);
  }

  get plotW(): number { return Math.max(1, this.#w - gutter(this.store.state)); }
  get plotH(): number { return Math.max(1, this.#h - TIME_H); }
  setPalette(name: string): void { this.#palette = PALETTES[name] ?? PALETTES.light!; this.gl.setLut(buildLut(this.#palette.dark)); this.invalidate(); }

  /** Executions per candle for the bar-stats strip (loaded only while the footprint is on). */
  get footprintData(): FootprintData { return this.#footprint; }

  /** USD window currently mapped onto the colour ramp: the percentile baseline shifted by the contrast slider. */
  get window(): { lo: number; hi: number } { return colourWindow(this.#baseline, this.store.state.heat.contrast); }

  #updateBaseline(): void {
    if (!(this.stats.p96 > 0)) return;
    this.#baseline = nextBaseline(this.#baseline, this.stats, { auto: this.store.state.heat.auto, force: this.#forceBaseline, spanP: this.view.p1 - this.view.p0, now: performance.now() });
    this.#forceBaseline = false;
  }
  invalidate(): void { this.#dirty = true; if (!this.#frame) this.#frame = requestAnimationFrame(() => { this.#frame = 0; this.#render(); }); }
  dataChanged(): void { this.#dataVersion++; this.invalidate(); }

  #resize(): void {
    const rect = this.root.getBoundingClientRect();
    this.#w = Math.max(1, Math.floor(rect.width)); this.#h = Math.max(1, Math.floor(rect.height)); this.#dpr = window.devicePixelRatio || 1;
    // A narrow map (a phone, or half of a landscape one) gives the axis and the profile less room, so the plot keeps most of it.
    setCompactGutters(this.#w < COMPACT_PANE);
    this.overlay.width = Math.round(this.#w * this.#dpr); this.overlay.height = Math.round(this.#h * this.#dpr);
    this.overlay.style.width = `${this.#w}px`; this.overlay.style.height = `${this.#h}px`;
    this.#pulse.width = this.overlay.width; this.#pulse.height = this.overlay.height;
    this.#pulse.style.width = this.overlay.style.width; this.#pulse.style.height = this.overlay.style.height;
    this.#positionGl();
    this.#rasteredKey = ''; this.onView(); this.invalidate();
  }
  #positionGl(): void {
    this.#glCanvas.style.width = `${this.plotW}px`; this.#glCanvas.style.height = `${this.plotH}px`;
    // The heatmap is blocks of colour, so a finger's screen (3 device pixels to a CSS pixel) gains nothing from filling every one of them; the browser scales a 2x canvas up.
    this.gl.resize(this.plotW, this.plotH, isCoarse() ? Math.min(this.#dpr, 2) : this.#dpr);
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
    if (!(hi > lo)) { const p = mark.price || 1; lo = p * 0.99; hi = p * 1.01; }
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

  /** One step of time zoom from the keyboard (in: `dir` 1), as the wheel does over the chart: about the live edge while the map follows the market. */
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
    if (this.#rasteredKey !== key) this.#forceBaseline = true;
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
    const opacity = heat.style === 'bookmap' ? this.#lodFrame.heatmapOpacity : (p.dark ? 0.95 : 1) * this.#lodFrame.heatmapOpacity;
    return { bid: rgb(p.bid), bidSoft: rgb(p.bidSoft), ask: rgb(p.ask), askSoft: rgb(p.askSoft), min: w.lo, max: w.hi, mode: heat.style, opacity };
  }

  /**
   * Centre the map on `t` at the span it has, leaving the live edge as a drag does, and fit the price to the candles there when there are
   * any (the price may have been far from today's). The depth and the panes under the map load what the new window needs on their own.
   */
  /** Draw again for the countdown when nothing else has for most of a second (a quiet market): the page shown, the candles on. */
  tick(): void {
    if (document.visibilityState === 'visible' && this.store.state.show.candles && performance.now() - this.#lastRender > 900) this.invalidate();
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
    let lo = Infinity, hi = -Infinity;
    for (const c of this.store.state.candles) if (c[0] + 1 > t0 && c[0] < t1) { lo = Math.min(lo, c[3]); hi = Math.max(hi, c[2]); }
    const pad = (hi - lo) * 0.18;
    v.set({ t0, t1, p0: hi > lo ? lo - pad : v.p0, p1: hi > lo ? hi + pad : v.p1 });
    this.store.set({ followLive: false }); this.#liveMargin = v.t1 - pageNow(); this.#rasteredKey = ''; this.onView(); this.invalidate();
  }

  /** While replaying, the candles as they were at its moment (the one under way rebuilt from the recorded price a second), kept per second. */
  #atCandles: { key: string; src: readonly CandleRow[]; rows: CandleRow[] } | null = null;
  #shownCandles(state: AppState): readonly CandleRow[] {
    const tf = TIMEFRAMES[state.timeframe] ?? 3_600_000, at = pageNow(), key = `${tf}|${Math.floor(at / 1000)}`;
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
    if (this.#w <= 1 || this.#h <= 1) return;
    if (!(this.view.t1 > this.view.t0) && (state.candles.length || state.mark.price)) this.fit();
    if (state.followLive && this.view.t1 > this.view.t0) {
      const shift = pageNow() + this.#liveMargin - this.view.t1;
      if (Math.abs(shift) > 0) { this.view.t0 += shift; this.view.t1 += shift; }
      const mark = state.mark.price, { p0, p1 } = this.view, span = p1 - p0;
      if (mark && (mark < p0 + span * 0.1 || mark > p1 - span * 0.1)) { const mid = mark - span / 2; this.view.p0 = mid; this.view.p1 = mid + span; this.#rasteredKey = ''; }
    }
    this.#positionGl();
    const gutterCss = `${gutter(state)}px`;
    if (this.#gutterCss !== gutterCss) { this.#gutterCss = gutterCss; this.root.style.setProperty('--gutter', gutterCss); }
    this.#manageRaster();
    if (state.show.bubbles) this.hub.ensurePrints(this.view, scaledUsd(state.tradeBubbles.minUsd));
    if (state.liquidations.on) this.hub.ensureLiquidations(this.view, scaledUsd(state.liquidations.minUsd));
    if (state.keyLevels.on && anyLine(state.keyLevels)) this.#ensureKeyLevels(state);
    if (state.vwap.on) this.#ensureVwap(state);
    if (state.show.traded) { this.#ensureTraded(state); this.#ensureValueAreas(state); }
    if (state.absorption.on) { const { ids, thresholds } = this.#absorptionContext(state); this.hub.ensureAbsorption(ids, ids.map(id => thresholds.get(id) ?? null), this.view, state.absorption.sdMinutes); }
    this.#stepFootprint(state);
    // Under a dominant footprint the heatmap is gone altogether, so there is nothing to draw.
    if (state.layer === 'liquidity' && this.#lodFrame.heatmapOpacity > 0.003) this.gl.draw(this.view, this.#style(), this.#placeholder()); else this.gl.clear();
    this.#paintOverlay(state);
    this.onFrame();
  }

  /** Advance the footprint level of detail for this frame (also drives the heatmap dimming). */
  #stepFootprint(state: AppState): void {
    const v = this.view, pw = this.plotW, ph = this.plotH, now = performance.now();
    if (!state.show.footprint || !(v.t1 > v.t0)) { this.#lodFrame = this.#lod.step(now, { enabled: false, hasData: false, widthCss: 0, rowHeightCss: 0, factor: 0 }); return; }
    const tfMs = TIMEFRAMES[state.timeframe] ?? 3_600_000, fine = this.#footprint.fine;
    const fineRowPx = fine > 0 ? Math.abs(v.yOf(0, ph) - v.yOf(fine, ph)) : 0;
    const rowStep = fine > 0 ? fine * 2 ** this.#lod.level(fineRowPx) : 0;
    this.#footprint.ensure(state.marketId, state.timeframe, v, rowStep, (inst, tf, from, to, rows) => this.hub.footprint(inst, tf, from, to, rows), () => this.invalidate());
    const rowH = rowStep > 0 ? Math.abs(v.yOf(0, ph) - v.yOf(rowStep, ph)) : 0;
    const factor = visibilityFactor(state.candles, tfMs, v, pw, ph, rowH || 1, rowStep || 1);
    this.#lodFrame = this.#lod.step(now, { enabled: true, hasData: this.#footprint.bars.size > 0, widthCss: pw * tfMs / (v.t1 - v.t0), rowHeightCss: rowH, factor });
    // A trap needs the candles and the footprint to be the same market's; a chart showing a reference series instead says nothing about this market's flow.
    if (this.#lodFrame.barAlpha > 0.05 && state.seriesInstrument === state.marketId && !replaying()) {
      this.#traps.ensure({ inst: state.marketId, tf: state.timeframe, tfMs, candles: state.candles, fine, view: v, load: (inst, tf, from, to, rows) => this.hub.footprint(inst, tf, from, to, rows), onLoad: () => this.invalidate() });
    } else this.#traps.clear();
    if (this.#lodFrame.needsFrame) this.invalidate();
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
    const ctx = this.#ctx, w = this.#w, h = this.#h, pw = this.plotW, ph = this.plotH, v = this.view, p = this.#palette;
    ctx.setTransform(this.#dpr, 0, 0, this.#dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    ctx.font = '11px ui-sans-serif, system-ui, sans-serif';
    ctx.textBaseline = 'middle';
    // grid
    ctx.strokeStyle = p.line; ctx.lineWidth = 1; ctx.fillStyle = p.muted;
    const pStep = niceStep(v.p1 - v.p0, ph / 46);
    ctx.globalAlpha = 0.6; ctx.beginPath();
    for (let q = Math.ceil(v.p0 / pStep) * pStep; q <= v.p1; q += pStep) { const y = Math.round(v.yOf(q, ph)) + 0.5; ctx.moveTo(0, y); ctx.lineTo(pw, y); }
    const ticks = timeTicks(v.t0, v.t1, pw);
    for (const t of ticks) { const x = Math.round(v.xOf(t, pw)) + 0.5; ctx.moveTo(x, 0); ctx.lineTo(x, ph); }
    ctx.stroke(); ctx.globalAlpha = 1;
    const market = state.markets.find(m => (m.instrumentId ?? m.id) === state.marketId);
    paintWatermark(ctx, p, pw, ph, [market?.base && market.quote ? `${market.base}/${market.quote}` : '', state.timeframe].filter(Boolean).join(' · '));
    this.mirror = null;
    this.#paintHistoryStart(ctx, pw, ph, p);
    this.#paintLayers(ctx, state, pw, ph);
    this.#paintVolume(ctx, state, pw, ph, this.#lodFrame.narrowing);
    this.#pulseRects = [];
    if (state.show.footprint) {
      const marks = this.#footprintMarks.get(this.#footprint, state.barStatOptions), fp = state.footprint;
      // Zones and naked points of control only while the footprint itself shows, faded with it: zoomed out, its data is still loaded.
      if ((fp.zones || fp.nakedPoc) && this.#lodFrame.barAlpha > 0.05 && state.seriesInstrument === state.marketId) {
        const tfMs = TIMEFRAMES[state.timeframe] ?? 3_600_000;
        paintRuns(ctx, this.#footprintRuns.get(this.#footprintMarks.key, marks, state.candles, tfMs, this.#footprint.step, pageNow(), { zones: fp.zones, pocs: fp.nakedPoc }), v, pw, ph, p, this.#lodFrame.barAlpha);
      }
      paintFootprint(ctx, this.#footprint, this.#lodFrame, state.timeframe, v, pw, ph, p, this.#trapMarks(), { marks, settings: fp, ...(replaying() ? { until: pageNow() } : {}) });
    }
    this.#startPulse();
    if (state.show.candles) this.#paintCandles(ctx, state, pw, ph, this.#lodFrame.narrowing);
    if (state.show.candles) this.#paintDivergences(ctx, state, pw, ph); // joined swings need the candles they join
    this.#paintBubbles(ctx, state, pw, ph); // above the candles, so a large trade is never hidden behind one
    this.#paintLiquidations(ctx, state, pw, ph); // above the bubbles: a forced order is one of the market orders, marked as forced
    this.#paintAbsorption(ctx, state, pw, ph);
    this.#paintValueLines(ctx, state, pw, ph);
    this.#keyTags = state.keyLevels.on ? paintKeyLevels(ctx, this.#keyLevelLines(state), v, pw, ph, p, state.keyLevels, pageNow(), this.#keyLevelContext(state).zone) : [];
    this.#vwapTags = state.vwap.on ? paintVwap(ctx, this.#vwapLines(state), v, pw, ph, p, state.vwap) : [];
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
    // The profile column is the book as it is now: not shown in replay, which has no book of its moment.
    if (state.show.profile && !replaying()) this.#paintProfile(ctx, state, pw, ph);
    if (tradedShown(state)) this.#paintTraded(ctx, state, pw, ph);
    const axisX = w - AXIS_W;
    ctx.fillStyle = p.panel; ctx.fillRect(axisX, 0, AXIS_W, h);
    ctx.strokeStyle = p.line; ctx.beginPath(); ctx.moveTo(axisX + 0.5, 0); ctx.lineTo(axisX + 0.5, h); ctx.stroke();
    ctx.fillStyle = p.muted; ctx.textAlign = 'left';
    // The countdown to the candle's close sits under the price tag (above it at the foot of the axis), inside the band kept clear of other tags.
    const markY = Math.min(ph - 8, Math.max(8, v.yOf(mark, ph))), tf = TIMEFRAMES[state.timeframe] ?? 3_600_000;
    const clockText = mark > 0 && state.show.candles && !isPhone() ? countdown(pageNow(), tf) : null, clockBelow = markY + 9 + COUNTDOWN_H <= ph;
    const band = { y0: markY - 9 - (clockText && !clockBelow ? COUNTDOWN_H : 0), y1: markY + 9 + (clockText && clockBelow ? COUNTDOWN_H : 0) };
    const keyTags = placeKeyTags([...this.#keyTags, ...this.#vwapTags], mark > 0 ? [band] : [], ph);
    for (let q = Math.ceil(v.p0 / pStep) * pStep; q <= v.p1; q += pStep) { const y = v.yOf(q, ph); if (y > 6 && y < ph - 6 && !underTag(keyTags, y)) ctx.fillText(fmtPrice(q, pStep), axisX + 6, y); }
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
    // time axis
    ctx.fillStyle = p.panel; ctx.fillRect(0, ph, w, TIME_H);
    ctx.fillStyle = p.muted; ctx.textAlign = 'center';
    let lastDay = -1;
    for (const t of ticks) {
      const x = v.xOf(t, pw); if (x < 24 || x > pw - 24) continue;
      const day = dayOfMonth(t);
      ctx.fillText(tickLabel(t, day !== lastDay && (ticks.length < 3 || lastDay === -1)), x, ph + TIME_H / 2);
      lastDay = day;
    }
    // Which clock the labels are on, under the price axis where no tick label goes (a screenshot says it too).
    ctx.textAlign = 'right'; ctx.fillText(zoneName(), w - 6, ph + TIME_H / 2); ctx.textAlign = 'center';
    this.#paintLegend(ctx, state);
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
    const hovered = state.hover ? state.candles.find(c => state.hover!.t >= c[0] && state.hover!.t < c[0] + tf) : undefined;
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
    const shownTitle = phone ? `${name}  ${state.timeframe}` : title;
    ctx.font = '600 12px ui-sans-serif, system-ui, sans-serif'; const titleW = ctx.measureText(shownTitle).width;
    ctx.font = '11px ui-sans-serif, system-ui, sans-serif'; const detailW = detail ? ctx.measureText(detail).width : 0, tailW = tail ? ctx.measureText(tail).width + 10 : 0;
    const note = phone && borrowed ? borrowed.replace(/^s*·s*/, '') : '', noteW = note ? ctx.measureText(note).width : 0;
    const plateW = Math.max(titleW + tailW, detailW, noteW) + 14, plateH = (detail ? 36 : 22) + (note ? 14 : 0);
    this.#legendBox = { right: 6 + plateW, bottom: 6 + plateH };
    ctx.globalAlpha = 0.82; ctx.fillStyle = p.panel; ctx.beginPath(); ctx.roundRect(6, 6, plateW, plateH, 6); ctx.fill(); ctx.globalAlpha = 1;
    ctx.textAlign = 'left'; ctx.fillStyle = p.text; ctx.font = '600 12px ui-sans-serif, system-ui, sans-serif';
    ctx.fillText(shownTitle, 12, 16);
    ctx.font = '11px ui-sans-serif, system-ui, sans-serif';
    if (tail) { ctx.fillStyle = p.muted; ctx.fillText(tail, 12 + titleW + 10, 16); }
    if (detail) { ctx.fillStyle = up ? p.candleUp : p.candleDown; ctx.fillText(detail, 12, 32); }
    if (note) { ctx.fillStyle = p.muted; ctx.fillText(note, 12, 46); }
  }

  /**
   * A young recording leaves most of the map empty, and the stripe that has been recorded so far can be a few pixels wide, so where the
   * liquidity is does not show. While the recording is under two hours old and the live edge is on screen, the current book
   * is drawn in grey back to the left edge, darker for bigger walls (it is not history: the colour and the label say so). Looking at the past, or an
   * old recording, never gets it.
   */
  #placeholder(): { boundary: number; sample: number; rgb: [number, number, number] } | null {
    const since = this.hub.recordedSince, v = this.view, now = pageNow();
    if (!(since > v.t0) || since >= v.t1 || now - since > PLACEHOLDER_MAX_AGE_MS || v.t1 < now - 60_000) return null;
    // The column to copy is the current minute's: it holds every venue's book as it is now, where the first minute may hold only the venues that had connected by then.
    return { boundary: since, sample: Math.max(since + 15_000, Math.floor(now / 60_000) * 60_000 + 15_000), rgb: rgb(this.#palette.muted) };
  }

  /**
   * Where the recorded depth begins, when that is inside the view: a page that reads the exchanges itself records only while it is
   * open, so the map to the left of this line is empty by nature and the line says so rather than leaving it to look broken.
   */
  #paintHistoryStart(ctx: CanvasRenderingContext2D, pw: number, ph: number, p: Palette): void {
    const since = this.hub.recordedSince, v = this.view;
    if (!(since > v.t0 && since < v.t1)) return;
    const x = Math.round(v.xOf(since, pw)) + 0.5, young = this.#placeholder() !== null;
    const label = young && x > 330 ? t('Grey: the current book copied back, not recorded history. Depth is recorded while this page is open')
      : young && x >= 215 ? t('Grey: copied back · recorded from {time}', { time: clock(since) }) : t('depth recorded from {time}', { time: clock(since) });
    ctx.save();
    ctx.strokeStyle = p.muted; ctx.globalAlpha = 0.55; ctx.setLineDash([2, 4]);
    ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, ph); ctx.stroke(); ctx.setLineDash([]);
    ctx.font = '10px ui-sans-serif, system-ui, sans-serif'; ctx.fillStyle = p.muted; ctx.globalAlpha = 0.85; ctx.textBaseline = 'top';
    // The legend plate takes the top-left corner of the map: a note that would run under it goes beneath it instead.
    const w = ctx.measureText(label).width, right = x >= w + 12, left = right ? x - 6 - w : x + 6, box = this.#legendBox;
    let top = left < box.right + 8 ? box.bottom + 6 : 6;
    // Select and Recenter sit in the top-right corner of the map on the full toolbar: the note does not run under them.
    const corner = this.root.querySelector<HTMLElement>('.map-tools');
    if (top < 40 && corner && (right ? x - 6 : x + 6 + w) > pw - corner.offsetWidth - 16) top = 40;
    if (right) { ctx.textAlign = 'right'; ctx.fillText(label, x - 6, top); } else { ctx.textAlign = 'left'; ctx.fillText(label, x + 6, top); }
    ctx.restore();
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
    if (!state.show.volume || !state.candles.length) return;
    const tf = TIMEFRAMES[state.timeframe] ?? 3_600_000, v = this.view, p = this.#palette;
    const slot = Math.max(1, pw * tf / (v.t1 - v.t0)), layout = footprintLayout(slot);
    const normal = candleBody(slot), body = Math.max(1, (normal + (Math.max(1, layout.body) - normal) * narrowing));
    const { found } = this.#volumeAnalysis(state), emphasise = state.highlight.on;
    const bandH = Math.max(34, Math.min(ph * 0.17, 150)), floor = ph - 1;
    let max = 0;
    for (const c of state.candles) if (c[0] + tf >= v.t0 && c[0] <= v.t1) max = Math.max(max, c[5]);
    if (!(max > 0)) return;
    // A soft backdrop keeps the bars readable over bright heat.
    const [br, bg, bb] = rgb(p.bg).map(c => Math.round(c * 255)) as [number, number, number];
    const backdrop = ctx.createLinearGradient(0, ph - bandH - 6, 0, ph);
    backdrop.addColorStop(0, `rgba(${br},${bg},${bb},0)`); backdrop.addColorStop(1, `rgba(${br},${bg},${bb},${p.dark ? 0.55 : 0.5})`);
    ctx.fillStyle = backdrop; ctx.fillRect(0, ph - bandH - 6, pw, bandH + 6);
    for (let i = 0; i < state.candles.length; i++) {
      const c = state.candles[i]!; if (c[0] + tf < v.t0 || c[0] > v.t1) continue;
      const hot = emphasise && found.flag[i] === 1, color = c[4] >= c[1] ? p.candleUp : p.candleDown;
      const xClassic = v.xOf(c[0] + tf / 2, pw), x = xClassic + (v.xOf(c[0], pw) + layout.candleCenter - xClassic) * narrowing;
      if (hot) { ctx.globalAlpha = 0.07; ctx.fillStyle = color; ctx.fillRect(x - Math.max(slot, body) / 2, 0, Math.max(slot, body), ph - bandH - 6); }
      const h = Math.max(1, c[5] / max * bandH);
      ctx.globalAlpha = !emphasise ? 0.6 : hot ? 1 : 0.4; ctx.fillStyle = color; ctx.fillRect(x - body / 2, floor - h, body, h);
      if (hot) { ctx.globalAlpha = 0.9; ctx.fillStyle = p.dark ? '#ffffff' : '#14171c'; ctx.fillRect(x - body / 2, floor - h - 1.5, body, 1.5); }
    }
    if (emphasise) { // the threshold a bar has to clear to stand out
      ctx.globalAlpha = 0.7; ctx.strokeStyle = p.muted; ctx.lineWidth = 1; ctx.setLineDash([3, 3]); ctx.beginPath();
      let open = false;
      for (let i = 0; i < state.candles.length; i++) {
        const c = state.candles[i]!, t = found.threshold[i]!; if (c[0] + tf < v.t0 || c[0] > v.t1) continue;
        if (!Number.isFinite(t)) { open = false; continue; }
        const y = floor - Math.min(1, t / max) * bandH, x0 = v.xOf(c[0], pw), x1 = v.xOf(c[0] + tf, pw);
        if (!open) { ctx.moveTo(x0, y); open = true; } else ctx.lineTo(x0, y);
        ctx.lineTo(x1, y);
      }
      ctx.stroke(); ctx.setLineDash([]);
    }
    ctx.globalAlpha = 1;
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
    for (let ci = 0; ci < state.candles.length; ci++) {
      const c = state.candles[ci]!;
      if (c[0] + tf < v.t0 || c[0] > v.t1) continue;
      // Every candle, the one still forming too, has the same body and stands in the middle of its slot, so the spacing is the same all along.
      const xClassic = v.xOf(c[0] + tf / 2, pw), x = xClassic + (v.xOf(c[0], pw) + layout.candleCenter - xClassic) * narrowing, up = c[4] >= c[1];
      const color = up ? p.candleUp : p.candleDown;
      const yh = v.yOf(c[2], ph), yl = v.yOf(c[3], ph), yo = v.yOf(c[1], ph), yc = v.yOf(c[4], ph), cx = Math.round(x) + 0.5;
      const top = Math.min(yo, yc), height = Math.max(1.5, Math.abs(yc - yo));
      ctx.globalAlpha = outline;
      ctx.lineWidth = 3.5; ctx.strokeStyle = halo; ctx.beginPath(); ctx.moveTo(cx, yh); ctx.lineTo(cx, yl); ctx.stroke();
      ctx.lineWidth = 1.6; ctx.strokeStyle = edge; ctx.beginPath(); ctx.moveTo(cx, yh); ctx.lineTo(cx, yl); ctx.stroke();
      if (narrowing > 0.01) { ctx.globalAlpha = Math.min(1, narrowing * 1.5); ctx.lineWidth = 1.4; ctx.strokeStyle = color; ctx.beginPath(); ctx.moveTo(cx, yh); ctx.lineTo(cx, yl); ctx.stroke(); }
      ctx.lineWidth = 1;
      ctx.globalAlpha = outline; ctx.fillStyle = halo; ctx.fillRect(x - body / 2 - 1.5, top - 1.5, body + 3, height + 3);
      ctx.globalAlpha = 1; ctx.fillStyle = color; ctx.fillRect(x - body / 2, top, body, height);
      if (body >= 3) { ctx.globalAlpha = outline; ctx.strokeStyle = edge; ctx.strokeRect(x - body / 2 + 0.5, top + 0.5, body - 1, Math.max(0.5, height - 1)); }
      if (hot(ci)) { // unusually large volume: a glowing ring in the candle's own colour
        ctx.save(); ctx.globalAlpha = 1; ctx.shadowColor = color; ctx.shadowBlur = 12; ctx.strokeStyle = color; ctx.lineWidth = 2.4;
        ctx.strokeRect(x - body / 2 - 2.5, top - 2.5, body + 5, height + 5); ctx.restore();
      }
    }
    ctx.globalAlpha = 1;
  }

  /** Left edge of the traded-volume column (after the profile when that is shown), or null when the column is not drawn. */
  #tradedX(): number | null { const state = this.store.state; return tradedShown(state) ? this.plotW + (state.show.profile ? PROFILE_W : 0) : null; }

  /** The rows the traded column draws: the profile's step, so the two columns share their rows. */
  #tradedStep(): number { const v = this.view; return niceStep(v.p1 - v.p0, this.plotH / 3); }

  /** The window the traded column adds up: the whole minutes on the map, up to the one that is open. */
  #tradedWindow(): { from: number; to: number } {
    const v = this.view, MIN = 60_000, replay = replayView();
    if (replay) { const q = MIN * Math.max(1, Math.round(replay.speed / 60)); return { from: Math.floor(v.t0 / MIN) * MIN, to: Math.min(Math.ceil(v.t1 / MIN) * MIN, Math.floor(pageNow() / q) * q) }; }
    return { from: Math.floor(v.t0 / MIN) * MIN, to: Math.min(Math.ceil(v.t1 / MIN), Math.floor(pageNow() / MIN) + 1) * MIN };
  }
  /** The map's grid step at the current price. */
  #gridStep(): number { const m = this.store.state.mark.price; return gridStepFor(m > 0 ? m : Math.max(1e-9, (this.view.p0 + this.view.p1) / 2)); }
  /** The rows the point of control and the value area are read from: the grid step times the setting, never the column's rows, which follow the zoom. */
  #levelStep(): number { return this.#gridStep() * this.store.state.traded.rows; }
  /** The point of control and the value area of what is on the chart, read from the column's answer over every price (kept until either changes). */
  #viewLevels(): ValueLevels | null {
    const held = this.hub.traded; if (!held) return null;
    const step = this.#levelStep(), share = this.store.state.traded.share / 100, m = this.#levelsMemo;
    if (m && m.answer === held.answer && m.step === step && m.share === share) return m.levels;
    const levels = answerLevels(held.answer, step, share);
    this.#levelsMemo = { answer: held.answer, step, share, levels };
    return levels;
  }

  /**
   * Ask for the traded volume of the window on the map (whole minutes, up to the one that is open), on the instruments the flow column counts,
   * on rows that both the column's rows and the level rows divide (see `requestStep`).
   */
  #ensureTraded(state: AppState): void {
    const v = this.view;
    if (!(v.t1 > v.t0) || !(v.p1 > v.p0)) return;
    const { from, to } = this.#tradedWindow();
    this.hub.ensureTraded(flowIds(state, this.hub.flow.ids), from, to, requestStep(this.#tradedStep(), this.#levelStep(), this.#gridStep() / 40), state.followLive && !replaying());
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
    const sessions = s.session || s.whale ? sessionsOf(s.period, zone, Math.max(v.t0, now - MAX_BACK_MS), v.t1, now) : [];
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
    if (state.vwap.whale && plan.sessions.length) this.hub.ensureWhale(flowIds(state, this.hub.flow.ids), Math.max(plan.sessions[0]!.from, Date.now() - 7 * 86_400_000), scaledUsd(state.vwap.whaleUsd));
  }
  /**
   * The bars of one VWAP history and, after the last of them, the chart's own candles when they are of the same market and no coarser (the
   * bar under way is then the chart's, not the history's partial one, so no volume is counted twice). Null until the history is the target's.
   */
  #vwapBars(state: AppState, bar: number, target: HistoryTarget): readonly CandleRow[] | null {
    const h = this.hub.vwapHistory(bar);
    if (h.id !== target.id || h.barMs !== bar || !h.bars.length) return null;
    const held = h.bars, lastStart = held[held.length - 1]![0], tf = TIMEFRAMES[state.timeframe] ?? 3_600_000;
    if (!(target.own && state.seriesInstrument === state.marketId && tf <= bar)) return held;
    const live = state.candles.filter(c => c[0] >= lastStart);
    if (!live.length) return held;
    const from = live[0]![0];
    return [...held.filter(b => b[0] < from), ...live];
  }
  /** The VWAP lines for the view, worked out again only when the plan, a history or the chart's last candle changes. */
  #vwapLines(state: AppState): VwapLine[] {
    const s = state.vwap; if (!s.on) return [];
    const { target } = this.#keyLevelContext(state); if (!target) return [];
    const plan = this.#vwapPlan(state), tail = state.candles[state.candles.length - 1];
    const versions = [...plan.reach.keys()].map(bar => { const h = this.hub.vwapHistory(bar); return `${bar}:${h.id}:${h.version}`; }).join(',');
    const w = this.hub.whale, whaleKey = w ? `${w.key}|${w.at}|${w.tail.size}|${[...w.tail.values()].at(-1)?.[1] ?? 0}|${[...w.tail.values()].at(-1)?.[3] ?? 0}` : '';
    const key = `${this.#vwapPlanned?.key}|${versions}|${state.candles.length}|${tail ? `${tail[0]}|${tail[2]}|${tail[3]}|${tail[5]}` : ''}|${whaleKey}`;
    if (this.#vwapDrawn?.key === key) return replayCut(this.#vwapDrawn.lines, pageNow());
    const lines: VwapLine[] = [], now = pageNow();
    const sessionBars = plan.sessions.length ? this.#vwapBars(state, plan.sessionBar, target) : null;
    const heldFrom = (bar: number): number => this.hub.vwapHistory(bar).heldFrom;
    if (sessionBars && s.session) for (const w of plan.sessions) {
      // A session whose start the history does not reach yet has no true average: it waits rather than show a wrong one.
      if (heldFrom(plan.sessionBar) > w.from) continue;
      const points = vwapSeries(sessionBars, w.from, w.to);
      if (points.length) lines.push({ kind: 'session', n: 0, points, live: w.to > now, key: w.key });
    }
    // The whale lines of each session, from where the recording's count of large orders begins when that is later; only the sums of the size asked.
    const whale = this.hub.whale;
    if (s.whale && whale && whale.minUsd === scaledUsd(s.whaleUsd)) {
      const rows = this.hub.whaleRows();
      for (const w of plan.sessions) {
        const { buys, sells } = whaleSeries(rows, Math.max(w.from, whale.since ?? w.from), w.to), live = w.to > now;
        if (buys.length) lines.push({ kind: 'whaleBuy', n: 0, points: buys, live, key: `whale-buy|${w.key}` });
        if (sells.length) lines.push({ kind: 'whaleSell', n: 0, points: sells, live, key: `whale-sell|${w.key}` });
      }
    }
    plan.anchors.forEach((a, i) => {
      const bars = this.#vwapBars(state, a.bar, target), start = Math.floor(a.at / a.bar) * a.bar;
      if (!bars || heldFrom(a.bar) > start) return;
      const points = vwapSeries(bars, start, Infinity);
      if (points.length) lines.push({ kind: 'anchor', n: i + 1, points, live: true, key: `anchor|${a.at}` });
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

  /** The days, weeks or sessions the lines are drawn for (worked out again when the settings, the view's minutes or the clock's minute change). */
  #linesWindows(state: AppState): ProfileWindow[] {
    const v = this.view, MIN = 60_000, s = state.traded, now = pageNow();
    const key = `${s.period}|${s.zone}|${s.count}|${JSON.stringify(s.sessions)}|${state.timeZone}|${Math.floor(v.t0 / MIN)}|${Math.ceil(v.t1 / MIN)}|${Math.floor(now / MIN)}`;
    if (this.#vaWindows?.key !== key) this.#vaWindows = { key, windows: linesWindows(s, state.timeZone, v.t0, v.t1, now) };
    return this.#vaWindows.windows;
  }
  /** Ask for the value areas of the days, weeks or sessions the lines are drawn for. */
  #ensureValueAreas(state: AppState): void {
    const s = state.traded;
    if (s.period === 'view' || (!s.poc && !s.va)) return;
    const windows = this.#linesWindows(state);
    if (windows.length) this.hub.ensureValueAreas(flowIds(state, this.hub.flow.ids), windows, this.#levelStep(), s.share / 100);
  }

  /**
   * The point of control (a line) and the value area high and low (dashed) on the chart, in the profile colour over a halo that keeps them
   * apart from the map: across the whole chart for what is on it, or over each day, week or session. A past point of control nobody has
   * traded through since (a naked one) runs on, dotted, to where it was (or to the right edge). A window recorded for under nine in ten of its
   * minutes is drawn faint.
   */
  #paintValueLines(ctx: CanvasRenderingContext2D, state: AppState, pw: number, ph: number): void {
    const s = state.traded;
    if (!state.show.traded || (!s.poc && !s.va)) return;
    const v = this.view, p = this.#palette, now = pageNow(), step = this.#levelStep();
    const segments: { x0: number; x1: number; levels: ValueLevels; faint: boolean; name: string; naked: number | null }[] = [];
    if (s.period === 'view') {
      const levels = this.#viewLevels();
      if (levels) segments.push({ x0: 0, x1: pw, levels, faint: false, name: '', naked: null });
    } else {
      const ids = flowIds(state, this.hub.flow.ids), share = s.share / 100;
      for (const w of this.#linesWindows(state)) {
        const held = this.hub.valueAreas.get(valueAreaKey(ids, step, share, w));
        if (!held || held.poc === null || held.vah === null || held.val === null) continue;
        if (replaying() && w.to > now) continue;
        const end = Math.min(w.to, now), x0 = v.xOf(w.from, pw), x1 = v.xOf(end, pw);
        let naked: number | null = null;
        if (s.naked && w.to <= now) { const touched = touchedAt(held.poc, w.to, state.candles, step / 2); naked = touched === null ? pw : v.xOf(touched, pw); }
        if (Math.max(x1, naked ?? x1) < 0 || x0 > pw) continue;
        segments.push({ x0, x1, levels: { poc: held.poc, vah: held.vah, val: held.val }, faint: held.minutes < 0.9 * (end - w.from) / 60_000, name: w.name, naked });
      }
    }
    if (!segments.length) return;
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
      ctx.globalAlpha = seg.faint ? 0.4 : 1;
      const x0 = Math.max(-4, seg.x0), x1 = Math.min(pw + 4, seg.x1), { poc, vah, val } = seg.levels;
      if (s.va) { line(x0, x1, vah, 1, [6, 4]); line(x0, x1, val, 1, [6, 4]); }
      if (s.poc) { line(x0, x1, poc, 2, []); if (seg.naked !== null && seg.naked > x1) line(x1, Math.min(pw + 4, seg.naked), poc, 2, [2, 3]); }
      ctx.setLineDash([]);
      if (s.labels && x1 - x0 > 70) {
        const name = seg.name ? `${seg.name} ` : '';
        if (s.poc) label(`${name}${t('POC')} ${fmtPrice(poc, step)}`, x1, poc, 0);
        if (s.va) { label(`${name}${t('VAH')}`, x1, vah, 1); label(`${name}${t('VAL')}`, x1, val, 1); }
      }
    }
    ctx.font = '600 10px ui-sans-serif, system-ui, sans-serif'; ctx.textAlign = 'right'; ctx.textBaseline = 'middle';
    const placed: { x0: number; x1: number; y0: number; y1: number }[] = [];
    for (const l of labels.sort((a, b) => a.rank - b.rank)) {
      const w = ctx.measureText(l.text).width + 8, right = Math.min(pw - 2, l.x - 2), box = { x0: right - w, x1: right, y0: l.y - 7, y1: l.y + 7 };
      if (placed.some(b => b.x0 < box.x1 && box.x0 < b.x1 && b.y0 < box.y1 && box.y0 < b.y1)) continue;
      placed.push(box);
      ctx.globalAlpha = l.alpha * 0.85; ctx.fillStyle = p.panel; ctx.fillRect(box.x0, box.y0, w, 14);
      ctx.globalAlpha = l.alpha; ctx.fillStyle = p.poc; ctx.fillText(l.text, right - 4, l.y);
    }
    ctx.restore(); ctx.globalAlpha = 1; ctx.textBaseline = 'middle'; ctx.textAlign = 'left'; ctx.font = '11px ui-sans-serif, system-ui, sans-serif';
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
    const x0 = this.#tradedX(); if (x0 === null) return;
    const p = this.#palette, v = this.view, W = TRADED_W, held = this.hub.traded;
    const rows: TradedRows | null = held ? tradedRows(held.answer, this.#tradedStep(), v.p0, v.p1) : null;
    const s = state.traded, levels = this.#viewLevels();
    ctx.save(); ctx.beginPath(); ctx.rect(x0, 0, W, ph); ctx.clip();
    ctx.fillStyle = p.panel; ctx.fillRect(x0, 0, W, ph);
    // The value area, shaded behind the bars.
    if (s.valueArea && levels) {
      const ya = v.yOf(levels.vah, ph), yb = v.yOf(levels.val, ph);
      ctx.fillStyle = p.poc; ctx.globalAlpha = 0.12; ctx.fillRect(x0 + 1, ya, W - 1, yb - ya); ctx.globalAlpha = 1;
    }
    if (rows && rows.max > 0) {
      const width = W - 6;
      let maxNet = 0; if (s.bars === 'delta') for (let i = 0; i < rows.buy.length; i++) maxNet = Math.max(maxNet, Math.abs(rows.buy[i]! - rows.sell[i]!));
      for (let i = 0; i < rows.buy.length; i++) {
        const b = rows.buy[i]!, sl = rows.sell[i]!, total = b + sl; if (!(total > 0)) continue;
        const low = (rows.bin0 + i) * rows.step, y0 = v.yOf(low + rows.step, ph), y1 = v.yOf(low, ph);
        if (y1 < 0 || y0 > ph) continue;
        const hgt = Math.max(1, y1 - y0 - 0.5);
        ctx.globalAlpha = 0.85;
        if (s.bars === 'delta') {
          // The difference alone: as long as it is against the largest difference, in the colour of the side that was the bigger.
          const net = b - sl; if (!(Math.abs(net) > 0) || !(maxNet > 0)) continue;
          ctx.fillStyle = net > 0 ? p.bid : p.ask; ctx.fillRect(x0 + 1, y0, Math.max(1, Math.abs(net) / maxNet * width), hgt);
          continue;
        }
        const len = Math.max(1, total / rows.max * width), buyLen = len * b / total;
        if (b > 0) { ctx.fillStyle = p.bid; ctx.fillRect(x0 + 1, y0, Math.max(0.5, buyLen), hgt); }
        if (sl > 0) { ctx.fillStyle = p.ask; ctx.fillRect(x0 + 1 + buyLen, y0, Math.max(0.5, len - buyLen), hgt); }
      }
      ctx.globalAlpha = 1;
    }
    // The point of control across the column, at its price, and the value area's edges: the same levels the lines on the chart draw.
    if (s.valueArea && levels) {
      const mark = (price: number, width: number, dash: number[]): void => { const y = Math.round(v.yOf(price, ph)) + 0.5; if (y < 0 || y > ph) return; ctx.setLineDash(dash); ctx.strokeStyle = p.poc; ctx.lineWidth = width; ctx.beginPath(); ctx.moveTo(x0 + 1, y); ctx.lineTo(x0 + W, y); ctx.stroke(); };
      mark(levels.vah, 1, [3, 2]); mark(levels.val, 1, [3, 2]); mark(levels.poc, 2, []); ctx.setLineDash([]); ctx.lineWidth = 1;
    }
    // A selection made on the column (its window, a band of its rows), shaded on it.
    const sel = state.range, win = this.#tradedWindow();
    if (sel && sel.p0 !== null && sel.p1 !== null && Math.abs(sel.t0 - win.from) < 60_000 && Math.abs(sel.t1 - win.to) < 120_000) {
      const ya = v.yOf(sel.p1, ph), yb = v.yOf(sel.p0, ph);
      ctx.fillStyle = p.text; ctx.globalAlpha = 0.14; ctx.fillRect(x0 + 1, ya, W - 1, yb - ya); ctx.globalAlpha = 1;
      ctx.strokeStyle = p.text; ctx.setLineDash([5, 4]); ctx.strokeRect(x0 + 1.5, Math.round(ya) + 0.5, W - 2, Math.max(1, Math.round(yb - ya) - 1)); ctx.setLineDash([]);
    }
    // The row under the pointer, framed.
    const hover = this.#tradedHover, hoverRow = rows && hover ? tradedRowAt(rows, v.pOf(hover.y, ph)) : -1;
    if (rows && hoverRow >= 0) {
      const low = (rows.bin0 + hoverRow) * rows.step, y0 = v.yOf(low + rows.step, ph), y1 = v.yOf(low, ph);
      ctx.strokeStyle = p.text; ctx.lineWidth = 1; ctx.globalAlpha = 0.9; ctx.strokeRect(x0 + 0.5, Math.round(y0) + 0.5, W - 1, Math.max(1, Math.round(y1 - y0))); ctx.globalAlpha = 1;
    }
    ctx.globalAlpha = 0.9; ctx.fillStyle = p.panel; ctx.fillRect(x0 + 1, 0, W - 1, 28); ctx.globalAlpha = 1;
    ctx.fillStyle = p.muted; ctx.font = `${pw < NARROW_PLOT ? 9.5 : 10}px ui-sans-serif, system-ui, sans-serif`; ctx.textAlign = 'left'; ctx.textBaseline = 'top';
    const [head, sub] = this.hub.tradedState === 'unavailable' && !rows ? [t('TRADED'), t('not on this server')] : tradedHeader(rows);
    // A window that reaches back before the recording says so in the dot rows' amber.
    ctx.fillText(head, x0 + 4, 4); if (sub) { if (rows?.partial) ctx.fillStyle = '#e6a700'; ctx.fillText(sub, x0 + 4, 16); }
    ctx.restore(); ctx.textBaseline = 'middle';
    ctx.strokeStyle = p.line; ctx.beginPath(); ctx.moveTo(x0 + 0.5, 0); ctx.lineTo(x0 + 0.5, ph); ctx.stroke();
    if (rows && hover && hoverRow >= 0) {
      // The box stands to the left of the column, over the map, like the profile's comparison.
      paintInfoBox(ctx, tradedLines(rows, hoverRow, levels), x0, hover.y, { x0: 0, y0: 0, x1: pw, y1: ph }, p, { placement: 'center' });
      ctx.textBaseline = 'middle';
    }
  }

  #paintProfile(ctx: CanvasRenderingContext2D, state: AppState, pw: number, ph: number): void {
    const frame = state.levels; if (!frame) return;
    const p = this.#palette, v = this.view;
    const ids = this.#enabledIds();
    const step = niceStep(v.p1 - v.p0, ph / 3);
    const g = groupLevels(this.kernels, frame, ids, step, v.p0, v.p1);
    const cum = cumulative(g, state.mark.price);
    let maxLevel = 0;
    for (let i = 0; i < g.nBins; i++) maxLevel = Math.max(maxLevel, g.totalBid[i]! + g.totalAsk[i]!);
    const maxCum = Math.max(cum.maxBid, cum.maxAsk, 1), x0 = pw, width = PROFILE_W - 6;
    ctx.save(); ctx.beginPath(); ctx.rect(x0, 0, PROFILE_W, ph); ctx.clip();
    ctx.fillStyle = p.panel; ctx.fillRect(x0, 0, PROFILE_W, ph);
    for (let i = 0; i < g.nBins; i++) {
      const lo = (g.bin0 + i) * step, y1 = v.yOf(lo, ph), y0 = v.yOf(lo + step, ph);
      if (y1 < 0 || y0 > ph) continue;
      const hgt = Math.max(1, y1 - y0 - 0.5);
      if (cum.bid[i]! > 0) { ctx.globalAlpha = 0.16; ctx.fillStyle = p.bid; ctx.fillRect(x0, y0, cum.bid[i]! / maxCum * width, hgt); }
      if (cum.ask[i]! > 0) { ctx.globalAlpha = 0.16; ctx.fillStyle = p.ask; ctx.fillRect(x0, y0, cum.ask[i]! / maxCum * width, hgt); }
      const b = g.totalBid[i]!, a = g.totalAsk[i]!;
      if (b > 0) { ctx.globalAlpha = 0.85; ctx.fillStyle = p.bid; ctx.fillRect(x0, y0, Math.max(1, b / maxLevel * width), hgt); }
      if (a > 0) { ctx.globalAlpha = 0.85; ctx.fillStyle = p.ask; ctx.fillRect(x0, y0, Math.max(1, a / maxLevel * width), hgt); }
    }
    ctx.globalAlpha = 0.9; ctx.fillStyle = p.panel; ctx.fillRect(x0 + 1, 0, PROFILE_W - 1, 28); ctx.globalAlpha = 1;
    ctx.fillStyle = p.muted; ctx.font = `${pw < NARROW_PLOT ? 9.5 : 10}px ui-sans-serif, system-ui, sans-serif`; ctx.textAlign = 'left'; ctx.textBaseline = 'top';
    ctx.fillText(t('LEVEL MAX {value}', { value: usd(maxLevel) }), x0 + 4, 4); ctx.fillText(t('CUM MAX {value}', { value: usd(maxCum) }), x0 + 4, 16);
    this.#profileBox = null;
    this.#paintProfileMirror(ctx, state, g, cum, step, x0, ph);
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
  #paintProfileMirror(ctx: CanvasRenderingContext2D, state: AppState, g: Grouped, cum: ReturnType<typeof cumulative>, step: number, x0: number, ph: number): void {
    const hv = this.#profileHover, p = this.#palette, v = this.view, mark = state.mark.price;
    if (!hv || !state.show.mirror || !(mark > 0)) return;
    const markBin = Math.floor(mark / step) - g.bin0, hb = Math.floor(v.pOf(hv.y, ph) / step) - g.bin0, mb = 2 * markBin - hb;
    if (hb === markBin) return;
    const clamp = (i: number) => Math.max(0, Math.min(g.nBins - 1, i));
    const above = cum.ask[clamp(hb > markBin ? hb : mb)]!, below = cum.bid[clamp(hb > markBin ? mb : hb)]!;
    const stats = mirrorStats(mark, mark + (hb - markBin) * step, above, below, mb < 0 || mb >= g.nBins || hb < 0 || hb >= g.nBins);
    if (!stats) return;
    this.mirror = stats;
    const top = v.yOf((g.bin0 + Math.max(hb, mb) + 1) * step, ph), bottom = v.yOf((g.bin0 + Math.min(hb, mb)) * step, ph), pct = percentText(stats);
    dimOutside(ctx, x0, PROFILE_W, 0, ph, top, bottom, p.panel, 0.6);
    paintBand(ctx, p, x0, PROFILE_W, { y: top, color: p.ask, label: `${usd(stats.aboveUsd)} · ${pct}` }, { y: bottom, color: p.bid, label: `${usd(stats.belowUsd)} · ${pct}` }, { y0: 0, y1: ph });
    this.#profileBox = { lines: mirrorLines(stats, { above: t('Asks'), below: t('Bids') }), y: hv.y, placement: stats.hoveredSide === 'above' ? 'down' : 'up' };
  }

  #paintCrosshair(ctx: CanvasRenderingContext2D, state: AppState, pw: number, ph: number): void {
    const hv = state.hover; if (!hv) return;
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
    let trapHit: Trap | null = null, rowHit: ReturnType<HeatPane['footprintCellUnder']> = null;
    const touch = hv.touch === true;
    if (touch && ownY && inX && y >= 0 && y <= ph) { ctx.strokeStyle = p.text; ctx.lineWidth = 1.6; ctx.beginPath(); ctx.arc(x, y, 7, 0, Math.PI * 2); ctx.stroke(); ctx.lineWidth = 1; }
    const absorbed = ownY && here ? this.#absorptionAt(x, y) : null;
    const forced = ownY && here && !absorbed ? this.#diamondAt(x, y) : null;
    const hit = ownY && here && !absorbed && !forced ? this.#bubbleAt(x, y) : null;
    if (forced) { // a liquidation under the pointer: which positions were closed, where, and what the exchange reported
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
    } else if (ownY && here && (trapHit = this.#trapUnder(x, hv.t, hv.price!, pw))) {
      this.#paintTrapPopup(ctx, trapHit, x, y, pw, ph, touch);
    } else if (ownY && here && (rowHit = this.#footprintUnder(x, hv.t, hv.price!, pw))) {
      this.#paintFootprintPopup(ctx, rowHit, x, y, pw, ph, touch);
    } else if (ownY && here && state.layer === 'liquidity') {
      const cell = this.valueAt(hv.t, hv.price!);
      const side = cell && cell.ask > cell.bid ? 'ask' : 'bid', source = cell ? this.#sourceOf(hv.t, hv.price!, side) : '';
      const lines: InfoLine[] = [{ label: t('Price'), text: fmtPrice(hv.price!) }];
      if (cell) lines.push({ label: side === 'ask' ? t('Ask') : t('Bid'), text: `$${usd(Math.max(cell.bid, cell.ask))}`, color: side === 'ask' ? 'above' : 'below', bold: true });
      if (source) lines.push({ label: t('Source'), text: source });
      paintInfoBox(ctx, lines, x, touch ? y - 24 : y, { x0: 0, y0: 0, x1: pw, y1: ph }, p, { placement: touch ? 'up' : 'center' });
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
    paintInfoBox(ctx, rowCellLines(hit.cell, hit.bar, this.footprintData.step, state.timeframe, diagonal), x, y, { x0: 0, y0: 0, x1: pw, y1: ph }, p, { placement: touch ? 'up' : 'center' });
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
    if (this.#pulseFrame || reduced || !this.#pulseRects.some(r => r.active)) return;
    const tick = (time: number): void => {
      this.#pulseFrame = 0;
      if (document.hidden || !this.#pulseRects.some(r => r.active)) return;
      if (time - this.#pulseDrawn >= 50) this.#drawPulse(time, false);
      this.#pulseFrame = requestAnimationFrame(tick);
    };
    this.#pulseFrame = requestAnimationFrame(tick);
  }
  #drawPulse(time: number, still: boolean): void {
    const ctx = this.#pulse.getContext('2d')!, pw = this.plotW, ph = this.plotH;
    this.#pulseDrawn = time;
    ctx.setTransform(this.#dpr, 0, 0, this.#dpr, 0, 0);
    ctx.clearRect(0, 0, this.#w, this.#h);
    if (!this.#pulseRects.length) return;
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
        if (this.store.state.vwapAnchoring && p.x <= this.plotW && p.y <= this.plotH) { this.onAnchor?.(this.view.tOf(p.x, this.plotW)); return; }
        if (this.#pinActive() && Math.hypot(this.#pin!.x - p.x, this.#pin!.y - p.y) < 28) this.#unpin(); else this.#pinAt(p);
      },
      doubleTap: () => { this.#unpin(); this.fit(); },
      // A short tick under the finger says the hold registered (where the browser allows it: it wants the page to have been used first).
      hold: p => { if (navigator.userActivation?.hasBeenActive) navigator.vibrate?.(8); this.#pinAt(p); },
      holdMove: p => this.#pinAt(p),
      panStart: p => {
        this.#unpin();
        if (this.range?.armed && p.x <= this.plotW && p.y <= this.plotH) { this.#touchSelect = { start: p, at: p }; this.range.begin(this.#rangePoint(p.x, p.y)); return; }
        this.#panKind = p.y > this.plotH ? 'time' : p.x > this.#w - AXIS_W ? 'price' : 'map';
        this.#axisDrag = this.#panKind === 'map' ? null : { view: this.view.clone(), x: 0, y: 0 };
      },
      pan: (d, at) => { if (this.#touchSelect) { this.#touchSelect.at = at; this.range?.move(this.#rangePoint(at.x, at.y)); return; } this.#touchPan(d); },
      panEnd: v => {
        const touch = this.#touchSelect;
        if (touch) { this.#touchSelect = null; if (v === null) this.range?.cancel(); else this.range?.end(this.#rangePoint(touch.at.x, touch.at.y), Math.hypot(touch.at.x - touch.start.x, touch.at.y - touch.start.y) < DRAG_MIN_PX); return; }
        const kind = this.#panKind; this.#panKind = null; this.#axisDrag = null;
        if (kind === 'map' && v && !reducedMotion && Math.hypot(v.x, v.y) > 0.08) this.#startFling(v);
      },
      pinchStart: info => this.#pinchBegin(info),
      pinch: info => this.#pinchTo(info),
      pinchEnd: () => { this.#pinch = null; },
      cancel: () => { this.#panKind = null; this.#axisDrag = null; this.#pinch = null; if (this.#touchSelect) { this.#touchSelect = null; this.range?.cancel(); } },
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
    const tradedX = this.#tradedX();
    this.#tradedHover = null;
    if (p.x >= 0 && p.x <= pw && p.y >= 0 && p.y <= ph) {
      this.#profileHover = null;
      this.store.set({ hover: { t: v.tOf(p.x, pw), price: v.pOf(p.y, ph), y: p.y, source: 'heat', touch: true } });
    } else if (this.store.state.show.profile && p.x > pw && p.x <= pw + PROFILE_W && p.y >= 0 && p.y <= ph) {
      this.#profileHover = { y: p.y }; this.store.set({ hover: null });
    } else if (tradedX !== null && p.x > tradedX && p.x <= tradedX + TRADED_W && p.y >= 0 && p.y <= ph) {
      this.#profileHover = null; this.#tradedHover = { y: p.y }; this.store.set({ hover: null });
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
  #priceRef(mark: number): number { return mark > 0 ? mark : Math.max(1e-9, Math.abs(this.view.p0 + this.view.p1) / 2); }

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
    const local = (e: MouseEvent) => { const r = el.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; };
    const touched = () => { this.store.set({ followLive: false }); this.#liveMargin = this.view.t1 - pageNow(); this.#rasteredKey = ''; this.onView(); this.invalidate(); };
    // The wheel on the chart zooms time and on the price scale zooms price (Shift swaps them). Each holds still what is being watched: the
    // current price, or the live edge while the map follows the market, so the map swells and shrinks around it instead of sliding.
    el.addEventListener('wheel', e => {
      e.preventDefault();
      const { x, y } = local(e), pw = this.plotW, ph = this.plotH, v = this.view, state = this.store.state;
      const lines = e.deltaMode === 1 ? 33 : e.deltaMode === 2 ? ph : 1;
      const raw = Math.exp(Math.sign(e.deltaY) * Math.min(Math.abs(e.deltaY * lines), 240) * 0.0016);
      const axis = wheelAxis(regionAt(x, y, pw, ph), e.shiftKey), mark = state.mark.price;
      if (axis === 'price') {
        const ref = this.#priceRef(mark), factor = limitFactor(raw, v.p1 - v.p0, ref * PRICE_SPAN_SHARE.min, ref * PRICE_SPAN_SHARE.max);
        v.zoomPrice(factor, holdPixel({ axis, pointer: y, size: ph, alt: e.altKey, follow: state.followLive, mark, markPixel: v.yOf(mark, ph), nowPixel: 0 }), ph);
      } else {
        const factor = limitFactor(raw, v.t1 - v.t0, TIME_SPAN_MS.min, TIME_SPAN_MS.max);
        v.zoomTime(factor, holdPixel({ axis, pointer: x, size: pw, alt: e.altKey, follow: state.followLive, mark, markPixel: 0, nowPixel: v.xOf(pageNow(), pw) }), pw);
      }
      this.#liveMargin = this.view.t1 - pageNow(); this.#rasteredKey = ''; this.onView(); this.invalidate();
    }, { passive: false });
    el.addEventListener('contextmenu', e => e.preventDefault());
    el.addEventListener('pointerdown', e => {
      if (e.pointerType === 'touch') return;
      const { x, y } = local(e);
      // Placing a VWAP anchor: the click is the anchor, nothing else.
      if (this.store.state.vwapAnchoring && e.button === 0 && x <= this.plotW && y <= this.plotH) { this.onAnchor?.(this.view.tOf(x, this.plotW)); return; }
      if (this.range && selects(this.range.armed, e) && x <= this.plotW && y <= this.plotH) {
        this.#selecting = { x, y }; this.range.begin(this.#rangePoint(x, y)); el.setPointerCapture(e.pointerId); return;
      }
      const tx = this.#tradedX();
      if (this.range && e.button === 0 && tx !== null && x > tx && x <= tx + TRADED_W && y >= 0 && y <= this.plotH) {
        this.#columnSelect = { y };
        const { from, to } = this.#tradedWindow(), band = this.#columnBand(y, y);
        this.range.begin({ t: from, p: band.p0 }); this.range.move({ t: to, p: band.p1 }, { t: from, p: band.p0 });
        el.setPointerCapture(e.pointerId); return;
      }
      if (e.button === 2) { this.#zoomDrag = { x, y, view: this.view.clone() }; el.setPointerCapture(e.pointerId); return; }
      if (e.button !== 0) return;
      if (this.#onScale(x, y)) {
        // Dragging the price scale zooms it (up zooms in, down zooms out) about the current price, or the price under the pointer when that is off the map.
        const v = this.view, ph = this.plotH, mark = this.store.state.mark.price;
        this.#scaleDrag = { y, view: v.clone(), hold: holdPixel({ axis: 'price', pointer: y, size: ph, alt: false, follow: false, mark, markPixel: v.yOf(mark, ph), nowPixel: 0 }) };
        el.setPointerCapture(e.pointerId); el.style.cursor = 'ns-resize'; return;
      }
      this.#drag = { x, y, shift: e.shiftKey }; el.setPointerCapture(e.pointerId);
    });
    el.addEventListener('pointermove', e => {
      if (e.pointerType === 'touch') return;
      const { x, y } = local(e);
      if (this.#scaleDrag) { this.#dragScale(y); return; }
      if (this.#columnSelect && this.range) {
        const { from, to } = this.#tradedWindow(), band = this.#columnBand(this.#columnSelect.y, y);
        this.range.move({ t: to, p: band.p1 }, { t: from, p: band.p0 });
        this.#tradedHover = { y }; this.invalidate();
        return;
      }
      if (this.#selecting && this.range) {
        this.range.move(this.#rangePoint(x, y));
        if (x <= this.plotW && y <= this.plotH) this.store.set({ hover: { t: this.view.tOf(x, this.plotW), price: this.view.pOf(y, this.plotH), y, source: 'heat' } });
        return;
      }
      const overColumn = this.#tradedX() !== null && x > this.#tradedX()! && x <= this.#tradedX()! + TRADED_W && y <= this.plotH;
      el.style.cursor = this.#onScale(x, y) ? 'ns-resize' : overColumn || ((this.range?.armed || this.store.state.vwapAnchoring) && x <= this.plotW && y <= this.plotH) ? 'crosshair' : '';
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
      if (this.#drag) {
        const dx = x - this.#drag.x, dy = this.#drag.shift ? 0 : y - this.#drag.y;
        this.view.pan(dx, dy, this.plotW, this.plotH); this.#drag.x = x; this.#drag.y = y; touched();
      }
      if (x <= this.plotW && y <= this.plotH) this.store.set({ hover: { t: this.view.tOf(x, this.plotW), price: this.view.pOf(y, this.plotH), y, source: 'heat' } });
      else this.store.set({ hover: null });
      const onProfile = this.store.state.show.profile && x > this.plotW && x <= this.plotW + PROFILE_W, tradedX = this.#tradedX();
      this.#profileHover = !this.#drag && onProfile && y >= 0 && y <= this.plotH ? { y } : null;
      this.#tradedHover = !this.#drag && tradedX !== null && x > tradedX && x <= tradedX + TRADED_W && y >= 0 && y <= this.plotH ? { y } : null;
      this.invalidate();
    });
    el.addEventListener('pointerup', e => {
      if (e.pointerType === 'touch') return;
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
      this.#drag = null; this.#zoomDrag = null; this.#scaleDrag = null; el.style.cursor = this.#onScale(local(e).x, local(e).y) ? 'ns-resize' : ''; if (el.hasPointerCapture(e.pointerId)) el.releasePointerCapture(e.pointerId); });
    el.addEventListener('pointerleave', e => { if (e.pointerType === 'touch') return; if (!this.#scaleDrag) el.style.cursor = ''; this.#profileHover = null; this.#tradedHover = null; if (!this.#drag && !this.#zoomDrag) { this.store.set({ hover: null }); this.invalidate(); } });
    el.addEventListener('dblclick', () => this.fit());
    bindTouch(el, new GestureRecognizer(this.#touchHandlers()));
  }
}
