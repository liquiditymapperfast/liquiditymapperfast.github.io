import { HeatGL, type HeatStyle } from '../heatmap/gl.ts';
import { buildLut } from '../heatmap/lut.ts';
import { dimOutside, mirrorLines, mirrorStats, paintBand, paintMirrorBox, percentText, type MirrorLine, type MirrorStats } from '../mirror.ts';
import { TIMEFRAMES, type Hub, type RasterResult } from '../hub.ts';
import type { Kernels } from '../kernels.ts';
import { PALETTES, rgb, type Palette } from '../theme.ts';
import { View, niceStep, type Bounds } from '../view.ts';
import { clock, price as fmtPrice, usd } from '../format.ts';
import type { Store, AppState } from '../store.ts';
import { cumulative, groupLevels, type Grouped } from './levels-data.ts';
import { activeIds, emptyScopeMessage } from '../scope.ts';
import { bubbleRadius, topPrints, type Print } from '../prints.ts';
import { venueLabel } from '../venues.ts';
import { describeSources } from '../cell-sources.ts';
import { anomalies, type Anomalies } from '../anomaly.ts';
import { paintWatermark } from '../watermark.ts';
import { FootprintData, FootprintLod, footprintLayout, paintFootprint, visibilityFactor, type LodFrame } from './footprint.ts';
import { TrapData, trapText, type Trap } from '../traps.ts';

/** The warning colour of a possible trap: amber reads on every theme and is neither side's colour. */
const TRAP_COLOR = '#f5a524';
export const AXIS_W = 64;
export const PROFILE_W = 128;
const TIME_H = 22;

const TIME_STEPS = [60e3, 300e3, 900e3, 1800e3, 3600e3, 7200e3, 14400e3, 43200e3, 86400e3, 172800e3, 604800e3];

export function timeTicks(t0: number, t1: number, widthPx: number, minPx = 96): number[] {
  const want = (t1 - t0) * minPx / Math.max(1, widthPx);
  const step = TIME_STEPS.find(s => s >= want) ?? TIME_STEPS[TIME_STEPS.length - 1]!;
  const offset = new Date(t0).getTimezoneOffset() * 60_000;
  const out: number[] = [];
  for (let t = Math.ceil((t0 - offset) / step) * step + offset; t <= t1; t += step) out.push(t);
  return out;
}
export function gutter(state: AppState): number { return AXIS_W + (state.show.profile ? PROFILE_W : 0); }

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
  #profileBox: { lines: MirrorLine[]; y: number; placement: 'down' | 'up' } | null = null;
  onStats: () => void = () => {};
  onView: () => void = () => {};
  onFrame: () => void = () => {};
  #glCanvas = document.createElement('canvas');
  #ctx: CanvasRenderingContext2D;
  #w = 0; #h = 0; #dpr = 1;
  #dirty = true; #frame = 0;
  #dataVersion = 0; #rasteredVersion = -1; #rasteredKey = ''; #lastRasterAt = 0;
  #liveMargin = 0;
  #palette = PALETTES.light!;
  /** Colour window from the raster's percentiles. Auto mode refreshes it on recenter, market change, a 2x zoom or every 10 s, so colours do not drift while panning. */
  #baseline: { lo: number; hi: number; at: number; spanP: number } | null = null;
  #forceBaseline = true;
  #drag: { x: number; y: number; shift: boolean } | null = null;
  /** Right-button drag: zoom about the press point, from the view as it was at press time. */
  #zoomDrag: { x: number; y: number; view: Bounds } | null = null;
  #wasLoaded = false;
  #footprint = new FootprintData();
  /** Possible trapped buyers and sellers on closed candles, found at a row step that does not depend on the zoom. */
  #traps = new TrapData();
  /** The pulsing layer: a canvas of its own above the overlay, redrawn a few times a second only while a trap is in view. */
  readonly #pulse = document.createElement('canvas');
  #pulseRects: { x: number; y: number; w: number; h: number; active: boolean }[] = [];
  #pulseFrame = 0; #pulseDrawn = 0;
  #lod = new FootprintLod();
  #lodFrame: LodFrame = { barAlpha: 0, sellBuyAlpha: 0, needsFrame: false, heatmapOpacity: 1, narrowing: 0 };
  #volume: VolumeAnalysis | null = null;
  /** Bubbles drawn in the last frame, for hover. */
  #bubbles: { x: number; y: number; r: number; print: Print }[] = [];
  #grid: { data: Float32Array; w: number; h: number; bounds: Bounds } | null = null;
  /** Where the liquidity under the pointer comes from: asked of the worker once per map cell and kept while the pointer stays in it. */
  #sources: { key: string; text: string } | null = null;
  #sourcesAsked = '';

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
  get window(): { lo: number; hi: number } {
    const b = this.#baseline, contrast = this.store.state.heat.contrast;
    if (!b) return { lo: 1, hi: 2 };
    const shift = -((contrast - 50) / 50) * Math.log(b.hi / b.lo) * 0.75;
    return { lo: b.lo * Math.exp(shift), hi: b.hi * Math.exp(shift) };
  }

  #updateBaseline(): void {
    const s = this.stats, auto = this.store.state.heat.auto;
    if (!(s.p96 > 0)) return;
    const spanP = this.view.p1 - this.view.p0, now = performance.now(), b = this.#baseline;
    if (b && !auto) return;
    const hi = s.p96, lo = Math.max(1, Math.min(s.p15, hi / 4));
    const zoomed = b !== null && spanP > 0 && Math.abs(Math.log(spanP / b.spanP)) > Math.LN2;
    if (!b || this.#forceBaseline || zoomed) { this.#baseline = { lo, hi, at: now, spanP }; this.#forceBaseline = false; return; }
    if (now - b.at > 10_000) {
      const blend = (from: number, to: number) => Math.exp(Math.log(from) * 0.5 + Math.log(to) * 0.5);
      this.#baseline = { lo: blend(b.lo, lo), hi: blend(b.hi, hi), at: now, spanP: b.spanP };
    }
  }
  invalidate(): void { this.#dirty = true; if (!this.#frame) this.#frame = requestAnimationFrame(() => { this.#frame = 0; this.#render(); }); }
  dataChanged(): void { this.#dataVersion++; this.invalidate(); }

  #resize(): void {
    const rect = this.root.getBoundingClientRect();
    this.#w = Math.max(1, Math.floor(rect.width)); this.#h = Math.max(1, Math.floor(rect.height)); this.#dpr = window.devicePixelRatio || 1;
    this.overlay.width = Math.round(this.#w * this.#dpr); this.overlay.height = Math.round(this.#h * this.#dpr);
    this.overlay.style.width = `${this.#w}px`; this.overlay.style.height = `${this.#h}px`;
    this.#pulse.width = this.overlay.width; this.#pulse.height = this.overlay.height;
    this.#pulse.style.width = this.overlay.style.width; this.#pulse.style.height = this.overlay.style.height;
    this.#positionGl();
    this.#rasteredKey = ''; this.onView(); this.invalidate();
  }
  #positionGl(): void {
    this.#glCanvas.style.width = `${this.plotW}px`; this.#glCanvas.style.height = `${this.plotH}px`;
    this.gl.resize(this.plotW, this.plotH, this.#dpr);
  }

  /** Frame the most recent candles, centred on the mark. */
  fit(): void {
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
    const now = Date.now();
    let span = tf * Math.max(40, Math.min(110, recent.length || 80));
    // With little recorded depth, frame the recorded window so the heatmap is visible rather than a sliver.
    const since = this.hub.recordedSince;
    if (since > 0 && now - since < span * 0.7) span = Math.max(75 * 60_000, (now - since) * 1.35);
    this.#liveMargin = span * 0.08;
    this.view.set({ t0: now + this.#liveMargin - span, t1: now + this.#liveMargin, p0: lo - pad, p1: hi + pad });
    this.store.set({ followLive: true });
    this.#rasteredKey = ''; this.onView(); this.invalidate();
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
    if (state.heatmapSource !== 'aggregated') return [state.heatmapSource];
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
    const stale = this.#rasteredVersion !== this.#dataVersion || this.#rasteredKey !== key || performance.now() - this.#lastRasterAt > 1_500;
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

  #render(): void {
    this.#dirty = false;
    const state = this.store.state;
    if (this.#w <= 1 || this.#h <= 1) return;
    if (!(this.view.t1 > this.view.t0) && (state.candles.length || state.mark.price)) this.fit();
    if (state.followLive && this.view.t1 > this.view.t0) {
      const shift = Date.now() + this.#liveMargin - this.view.t1;
      if (Math.abs(shift) > 0) { this.view.t0 += shift; this.view.t1 += shift; }
      const mark = state.mark.price, { p0, p1 } = this.view, span = p1 - p0;
      if (mark && (mark < p0 + span * 0.1 || mark > p1 - span * 0.1)) { const mid = mark - span / 2; this.view.p0 = mid; this.view.p1 = mid + span; this.#rasteredKey = ''; }
    }
    this.#positionGl();
    this.#manageRaster();
    if (state.show.bubbles) this.hub.ensurePrints(this.view);
    this.#stepFootprint(state);
    // Under a dominant footprint the heatmap is gone altogether, so there is nothing to draw.
    if (state.layer === 'liquidity' && this.#lodFrame.heatmapOpacity > 0.003) this.gl.draw(this.view, this.#style()); else this.gl.clear();
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
    if (this.#lodFrame.barAlpha > 0.05 && state.seriesInstrument === state.marketId) {
      this.#traps.ensure({ inst: state.marketId, tf: state.timeframe, tfMs, candles: state.candles, fine, view: v, load: (inst, tf, from, to, rows) => this.hub.footprint(inst, tf, from, to, rows), onLoad: () => this.invalidate() });
    } else this.#traps.clear();
    if (this.#lodFrame.needsFrame) this.invalidate();
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
    if (state.show.footprint) paintFootprint(ctx, this.#footprint, this.#lodFrame, state.timeframe, v, pw, ph, p, this.#trapMarks());
    this.#startPulse();
    if (state.show.candles) this.#paintCandles(ctx, state, pw, ph, this.#lodFrame.narrowing);
    this.#paintBubbles(ctx, state, pw, ph); // above the candles, so a large trade is never hidden behind one
    // mark line
    const mark = state.mark.price;
    if (mark > 0) {
      const y = v.yOf(mark, ph);
      if (y >= 0 && y <= ph) { ctx.strokeStyle = p.ask; ctx.setLineDash([4, 3]); ctx.beginPath(); ctx.moveTo(0, y + 0.5); ctx.lineTo(pw, y + 0.5); ctx.stroke(); ctx.setLineDash([]); }
    }
    // profile column + price axis
    if (state.show.profile) this.#paintProfile(ctx, state, pw, ph);
    const axisX = w - AXIS_W;
    ctx.fillStyle = p.panel; ctx.fillRect(axisX, 0, AXIS_W, h);
    ctx.strokeStyle = p.line; ctx.beginPath(); ctx.moveTo(axisX + 0.5, 0); ctx.lineTo(axisX + 0.5, h); ctx.stroke();
    ctx.fillStyle = p.muted; ctx.textAlign = 'left';
    for (let q = Math.ceil(v.p0 / pStep) * pStep; q <= v.p1; q += pStep) { const y = v.yOf(q, ph); if (y > 6 && y < ph - 6) ctx.fillText(fmtPrice(q, pStep), axisX + 6, y); }
    if (mark > 0) {
      const y = Math.min(ph - 8, Math.max(8, v.yOf(mark, ph)));
      ctx.fillStyle = p.ask; ctx.fillRect(axisX + 1, y - 9, AXIS_W - 1, 18);
      ctx.fillStyle = '#fff'; ctx.fillText(fmtPrice(mark), axisX + 6, y);
    }
    // time axis
    ctx.fillStyle = p.panel; ctx.fillRect(0, ph, w, TIME_H);
    ctx.fillStyle = p.muted; ctx.textAlign = 'center';
    let lastDay = -1;
    for (const t of ticks) {
      const x = v.xOf(t, pw); if (x < 24 || x > pw - 24) continue;
      const d = new Date(t), day = d.getDate();
      ctx.fillText(day !== lastDay && (t % 86_400_000 === 0 || ticks.length < 3 || lastDay === -1) ? clock(t, true) : clock(t), x, ph + TIME_H / 2);
      lastDay = day;
    }
    this.#paintLegend(ctx, state);
    if (!this.#wasLoaded && state.levels) { ctx.fillStyle = p.muted; ctx.textAlign = 'left'; ctx.fillText('Collecting depth history…', 12, 50); }
    const emptyScope = state.heatmapSource === 'aggregated' ? emptyScopeMessage(state) : null;
    if (emptyScope) { // the filter selected nothing: say so instead of drawing a blank map
      ctx.font = '600 13px ui-sans-serif, system-ui, sans-serif'; const width = ctx.measureText(emptyScope).width + 28;
      ctx.fillStyle = p.panel; ctx.globalAlpha = 0.92; ctx.fillRect(pw / 2 - width / 2, ph / 2 - 20, width, 40); ctx.globalAlpha = 1;
      ctx.strokeStyle = p.line; ctx.strokeRect(pw / 2 - width / 2 + 0.5, ph / 2 - 19.5, width - 1, 39);
      ctx.fillStyle = p.text; ctx.textAlign = 'center'; ctx.fillText(emptyScope, pw / 2, ph / 2); ctx.textAlign = 'left'; ctx.font = '11px ui-sans-serif, system-ui, sans-serif';
    }
    this.#paintCrosshair(ctx, state, pw, ph);
  }

  #paintLegend(ctx: CanvasRenderingContext2D, state: AppState): void {
    const tf = TIMEFRAMES[state.timeframe] ?? 3_600_000, p = this.#palette;
    const hovered = state.hover ? state.candles.find(c => state.hover!.t >= c[0] && state.hover!.t < c[0] + tf) : undefined;
    const c = hovered ?? state.candles[state.candles.length - 1];
    const name = state.marketId.replace(':', ' · ');
    const borrowed = state.seriesInstrument && state.seriesInstrument !== state.marketId ? `  ·  candles from ${state.seriesInstrument.replace(':', ' · ')}` : '';
    const title = `${name}  ${state.timeframe}${borrowed}`;
    let detail = '', up = true;
    if (c) {
      up = c[4] >= c[1];
      const at = state.candles.indexOf(c), found = this.#volumeAnalysis(state).found, z = found.sigma[at], unusual = state.highlight.on && found.flag[at] === 1;
      detail = `O ${fmtPrice(c[1])}  H ${fmtPrice(c[2])}  L ${fmtPrice(c[3])}  C ${fmtPrice(c[4])}  Vol ${usd(c[5])}${unusual && Number.isFinite(z) ? `  (${z!.toFixed(1)}σ above its baseline)` : ''}`;
    }
    // A translucent plate keeps the text readable over bright heat.
    ctx.font = '600 12px ui-sans-serif, system-ui, sans-serif'; const titleW = ctx.measureText(title).width;
    ctx.font = '11px ui-sans-serif, system-ui, sans-serif'; const detailW = detail ? ctx.measureText(detail).width : 0;
    ctx.globalAlpha = 0.82; ctx.fillStyle = p.panel; ctx.beginPath(); ctx.roundRect(6, 6, Math.max(titleW, detailW) + 14, detail ? 36 : 22, 6); ctx.fill(); ctx.globalAlpha = 1;
    ctx.textAlign = 'left'; ctx.fillStyle = p.text; ctx.font = '600 12px ui-sans-serif, system-ui, sans-serif';
    ctx.fillText(title, 12, 16);
    if (detail) { ctx.font = '11px ui-sans-serif, system-ui, sans-serif'; ctx.fillStyle = up ? p.candleUp : p.candleDown; ctx.fillText(detail, 12, 32); }
    ctx.font = '11px ui-sans-serif, system-ui, sans-serif';
  }

  /**
   * Where the recorded depth begins, when that is inside the view: a page that reads the exchanges itself records only while it is
   * open, so the map to the left of this line is empty by nature and the line says so rather than leaving it to look broken.
   */
  #paintHistoryStart(ctx: CanvasRenderingContext2D, pw: number, ph: number, p: Palette): void {
    const since = this.hub.recordedSince, v = this.view;
    if (!(since > v.t0 && since < v.t1)) return;
    const x = Math.round(v.xOf(since, pw)) + 0.5, label = `depth recorded from ${clock(since)}`;
    ctx.save();
    ctx.strokeStyle = p.muted; ctx.globalAlpha = 0.55; ctx.setLineDash([2, 4]);
    ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, ph); ctx.stroke(); ctx.setLineDash([]);
    ctx.font = '10px ui-sans-serif, system-ui, sans-serif'; ctx.fillStyle = p.muted; ctx.globalAlpha = 0.85; ctx.textBaseline = 'top';
    if (x >= ctx.measureText(label).width + 12) { ctx.textAlign = 'right'; ctx.fillText(label, x - 6, 6); } else { ctx.textAlign = 'left'; ctx.fillText(label, x + 6, 6); }
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
    const normal = Math.max(1, Math.min(slot * 0.72, 40)), body = Math.max(1, (normal + (Math.max(1, layout.body) - normal) * narrowing));
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
   * Large executed trades as bubbles at their time and price, sized by notional and coloured by the side that took liquidity. Only the
   * biggest few hundred in view are drawn, so zooming out keeps the picture about size; trades at or above the whale tier get a glow.
   * They fade under the footprint, whose rows say the same thing in more detail.
   */
  #paintBubbles(ctx: CanvasRenderingContext2D, state: AppState, pw: number, ph: number): void {
    this.#bubbles = [];
    if (!state.show.bubbles) return;
    const v = this.view, p = this.#palette, fade = 1 - 0.85 * this.#lodFrame.barAlpha;
    if (fade <= 0.02) return;
    const limit = Math.max(40, Math.min(400, Math.round(pw / 9)));
    const off = state.disabledVenues;
    const visible = topPrints(this.hub.prints.items, v.t0, v.t1, v.p0, v.p1, limit, off.length ? id => off.includes(id.slice(0, id.indexOf(':'))) : undefined);
    if (!visible.length) return;
    const whale = state.sounds.tiers[2]?.usd ?? 400_000;
    ctx.save();
    const ordered = [...visible].sort((a, b) => a.usd - b.usd);
    for (const print of ordered) {
      const x = v.xOf(print.t, pw), y = v.yOf(print.price, ph), r = bubbleRadius(print.usd), color = print.side === 'buy' ? p.bid : p.ask;
      if (x < -r || x > pw + r) continue;
      this.#bubbles.push({ x, y, r, print });
      ctx.globalAlpha = 0.5 * fade; ctx.fillStyle = color; ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fill();
      ctx.globalAlpha = 0.95 * fade; ctx.lineWidth = print.usd >= whale ? 1.8 : 1; ctx.strokeStyle = print.usd >= whale ? (p.dark ? '#ffffff' : '#14171c') : color;
      if (print.usd >= whale) { ctx.shadowColor = color; ctx.shadowBlur = 10; }
      ctx.stroke(); ctx.shadowBlur = 0;
    }
    ctx.restore();
  }

  #paintCandles(ctx: CanvasRenderingContext2D, state: AppState, pw: number, ph: number, narrowing = 0): void {
    const tf = TIMEFRAMES[state.timeframe] ?? 3_600_000, v = this.view, p = this.#palette;
    const bar = Math.max(1, pw * tf / (v.t1 - v.t0));
    // With the footprint on, the candle slides to the left of its slot and keeps a solid body, the row column takes the rest.
    const layout = footprintLayout(bar), normal = Math.max(1, Math.min(bar * 0.72, 40));
    const body = normal + (Math.max(1, layout.body) - normal) * narrowing;
    const volume = this.#volumeAnalysis(state), hot = (i: number) => state.highlight.on && volume.found.flag[i] === 1;
    // A contrasting halo/outline keeps candles legible over both pink and green heat; it fades out over the dimmed footprint view.
    const edge = p.dark ? 'rgba(255,255,255,0.92)' : 'rgba(18,20,24,0.92)', halo = p.dark ? 'rgba(0,0,0,0.55)' : 'rgba(255,255,255,0.7)', outline = 1 - 0.85 * narrowing;
    for (let ci = 0; ci < state.candles.length; ci++) {
      const c = state.candles[ci]!;
      if (c[0] + tf < v.t0 || c[0] > v.t1) continue;
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
    ctx.fillStyle = p.muted; ctx.font = '10px ui-sans-serif, system-ui, sans-serif'; ctx.textAlign = 'left'; ctx.textBaseline = 'top';
    ctx.fillText(`LEVEL MAX ${usd(maxLevel)}`, x0 + 4, 4); ctx.fillText(`CUM MAX ${usd(maxCum)}`, x0 + 4, 16);
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
    this.#profileBox = { lines: mirrorLines(stats, { above: 'Asks', below: 'Bids' }), y: hv.y, placement: stats.hoveredSide === 'above' ? 'down' : 'up' };
  }

  #paintCrosshair(ctx: CanvasRenderingContext2D, state: AppState, pw: number, ph: number): void {
    const hv = state.hover; if (!hv) return;
    const p = this.#palette, v = this.view;
    const x = v.xOf(hv.t, pw), inX = x >= 0 && x <= pw, ownY = hv.source === 'heat' && hv.price !== null;
    const y = ownY ? v.yOf(hv.price!, ph) : -1;
    ctx.strokeStyle = p.muted; ctx.setLineDash([3, 3]); ctx.globalAlpha = 0.8; ctx.beginPath();
    if (inX) { ctx.moveTo(Math.round(x) + 0.5, 0); ctx.lineTo(Math.round(x) + 0.5, ph); }
    if (ownY && y >= 0 && y <= ph) { ctx.moveTo(0, Math.round(y) + 0.5); ctx.lineTo(pw, Math.round(y) + 0.5); }
    ctx.stroke(); ctx.setLineDash([]); ctx.globalAlpha = 1;
    const axisX = this.#w - AXIS_W;
    if (ownY && y >= 0 && y <= ph) { ctx.fillStyle = p.text; ctx.fillRect(axisX + 1, y - 9, AXIS_W - 1, 18); ctx.fillStyle = p.bg; ctx.textAlign = 'left'; ctx.fillText(fmtPrice(hv.price!), axisX + 6, y); }
    let trapHit: Trap | null = null;
    const hit = ownY && inX ? this.#bubbleAt(x, y) : null;
    if (hit) { // a large trade under the pointer: say what it was
      const { print } = hit, venue = venueLabel(print.id), symbol = print.id.split(':').slice(1).join(':');
      const lines = [`${print.side === 'buy' ? 'BUY' : 'SELL'}  $${usd(print.usd)}`, `${venue} ${symbol}`, `${fmtPrice(print.price)}  ${clock(print.t, true)}:${String(new Date(print.t).getSeconds()).padStart(2, '0')}`];
      ctx.font = '600 11px ui-sans-serif, system-ui, sans-serif'; const tw = Math.max(...lines.map(l => ctx.measureText(l).width)) + 16, th = lines.length * 15 + 8;
      const bx = x + hit.r + 10 + tw > pw ? x - hit.r - 10 - tw : x + hit.r + 10, by = Math.min(ph - th - 4, Math.max(4, y - th / 2));
      ctx.fillStyle = p.panel; ctx.globalAlpha = 0.96; ctx.fillRect(bx, by, tw, th); ctx.globalAlpha = 1;
      ctx.strokeStyle = print.side === 'buy' ? p.bid : p.ask; ctx.lineWidth = 1.5; ctx.strokeRect(bx + 0.5, by + 0.5, tw - 1, th - 1); ctx.lineWidth = 1;
      ctx.textAlign = 'left'; lines.forEach((line, i) => { ctx.fillStyle = i === 0 ? (print.side === 'buy' ? p.bid : p.ask) : p.text; ctx.fillText(line, bx + 8, by + 12 + i * 15); });
      ctx.font = '11px ui-sans-serif, system-ui, sans-serif';
    } else if (ownY && inX && (trapHit = this.#trapUnder(x, hv.t, hv.price!, pw))) {
      this.#paintTrapPopup(ctx, trapHit, x, y, pw, ph);
    } else if (ownY && inX && state.layer === 'liquidity') {
      const cell = this.valueAt(hv.t, hv.price!);
      const source = cell ? this.#sourceOf(hv.t, hv.price!, cell.ask > cell.bid ? 'ask' : 'bid') : '';
      const text = cell ? `${fmtPrice(hv.price!)}  ${cell.ask > cell.bid ? 'ask' : 'bid'} $${usd(Math.max(cell.bid, cell.ask))}${source ? '  ' + source : ''}` : fmtPrice(hv.price!);
      const tw = ctx.measureText(text).width + 14, bx = x + 12 + tw > pw ? x - 12 - tw : x + 12, by = Math.min(ph - 22, Math.max(4, y - 24));
      ctx.fillStyle = p.text; ctx.globalAlpha = 0.92; ctx.fillRect(bx, by, tw, 20); ctx.globalAlpha = 1; ctx.fillStyle = p.bg; ctx.textAlign = 'left'; ctx.fillText(text, bx + 7, by + 10);
    }
    if (inX) { ctx.fillStyle = p.text; ctx.fillRect(x - 40, ph + 2, 80, 18); ctx.fillStyle = p.bg; ctx.textAlign = 'center'; ctx.fillText(clock(hv.t, true), x, ph + 11); }
  }

  /** The rows of flagged candles that the footprint should mark: the wick's imbalanced cells on the trapped side. */
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

  #paintTrapPopup(ctx: CanvasRenderingContext2D, trap: Trap, x: number, y: number, pw: number, ph: number): void {
    const p = this.#palette, maxWidth = 280, lines: string[] = [];
    ctx.font = '600 11px ui-sans-serif, system-ui, sans-serif';
    for (const text of trapText(trap)) {
      let line = '';
      for (const word of text.split(' ')) { const next = line ? `${line} ${word}` : word; if (line && ctx.measureText(next).width > maxWidth) { lines.push(line); line = word; } else line = next; }
      lines.push(line);
    }
    const tw = Math.max(...lines.map(l => ctx.measureText(l).width)) + 18, th = lines.length * 15 + 10;
    const bx = x + 14 + tw > pw ? x - 14 - tw : x + 14, by = Math.min(ph - th - 4, Math.max(4, y - th / 2));
    ctx.fillStyle = p.panel; ctx.globalAlpha = 0.97; ctx.fillRect(bx, by, tw, th); ctx.globalAlpha = 1;
    ctx.strokeStyle = TRAP_COLOR; ctx.lineWidth = 1.5; ctx.strokeRect(bx + 0.5, by + 0.5, tw - 1, th - 1); ctx.lineWidth = 1;
    ctx.textAlign = 'left'; lines.forEach((line, i) => { ctx.fillStyle = i === 0 ? TRAP_COLOR : p.text; ctx.fillText(line, bx + 9, by + 13 + i * 15); });
    ctx.font = '11px ui-sans-serif, system-ui, sans-serif';
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

  #bindInput(): void {
    const el = this.overlay;
    const local = (e: MouseEvent) => { const r = el.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; };
    const touched = () => { this.store.set({ followLive: false }); this.#liveMargin = this.view.t1 - Date.now(); this.#rasteredKey = ''; this.onView(); this.invalidate(); };
    el.addEventListener('wheel', e => {
      e.preventDefault();
      const { x, y } = local(e), factor = Math.exp(Math.sign(e.deltaY) * Math.min(Math.abs(e.deltaY), 240) * 0.0016);
      if (e.shiftKey) this.view.zoomTime(factor, Math.min(x, this.plotW), this.plotW); else this.view.zoomPrice(factor, Math.min(y, this.plotH), this.plotH);
      this.#liveMargin = this.view.t1 - Date.now(); this.onView(); this.invalidate();
    }, { passive: false });
    el.addEventListener('contextmenu', e => e.preventDefault());
    el.addEventListener('pointerdown', e => {
      const { x, y } = local(e);
      if (e.button === 2) { this.#zoomDrag = { x, y, view: this.view.clone() }; el.setPointerCapture(e.pointerId); return; }
      if (e.button !== 0) return;
      this.#drag = { x, y, shift: e.shiftKey }; el.setPointerCapture(e.pointerId);
    });
    el.addEventListener('pointermove', e => {
      const { x, y } = local(e);
      if (this.#zoomDrag) {
        // Drag right zooms the time axis in, drag up zooms the price axis in (left/down zoom out).
        const z = this.#zoomDrag, k = 0.006, pw = this.plotW, ph = this.plotH;
        const fx = Math.exp(-(x - z.x) * k), fy = Math.exp((y - z.y) * k);
        const v0 = z.view, tAnchor = v0.t0 + Math.min(z.x, pw) / pw * (v0.t1 - v0.t0), pAnchor = v0.p0 + (1 - Math.min(z.y, ph) / ph) * (v0.p1 - v0.p0);
        const tSpan = Math.max(30_000, (v0.t1 - v0.t0) * fx), pSpan = Math.max((v0.p1 - v0.p0) * fy, 1e-6);
        const t0 = tAnchor - Math.min(z.x, pw) / pw * tSpan, p1 = pAnchor + Math.min(z.y, ph) / ph * pSpan;
        this.view.set({ t0, t1: t0 + tSpan, p0: p1 - pSpan, p1 });
        this.#liveMargin = this.view.t1 - Date.now(); this.#rasteredKey = ''; this.onView(); this.invalidate();
        return;
      }
      if (this.#drag) {
        const dx = x - this.#drag.x, dy = this.#drag.shift ? 0 : y - this.#drag.y;
        this.view.pan(dx, dy, this.plotW, this.plotH); this.#drag.x = x; this.#drag.y = y; touched();
      }
      if (x <= this.plotW && y <= this.plotH) this.store.set({ hover: { t: this.view.tOf(x, this.plotW), price: this.view.pOf(y, this.plotH), y, source: 'heat' } });
      else this.store.set({ hover: null });
      this.#profileHover = !this.#drag && x > this.plotW && x <= this.plotW + PROFILE_W && y >= 0 && y <= this.plotH ? { y } : null;
      this.invalidate();
    });
    el.addEventListener('pointerup', e => { this.#drag = null; this.#zoomDrag = null; if (el.hasPointerCapture(e.pointerId)) el.releasePointerCapture(e.pointerId); });
    el.addEventListener('pointerleave', () => { this.#profileHover = null; if (!this.#drag && !this.#zoomDrag) { this.store.set({ hover: null }); this.invalidate(); } });
    el.addEventListener('dblclick', () => this.fit());
    window.addEventListener('keydown', e => { if ((e.key === 'r' || e.key === 'Home') && !(e.target instanceof HTMLInputElement) && !(e.target instanceof HTMLSelectElement)) this.fit(); });
  }
}
