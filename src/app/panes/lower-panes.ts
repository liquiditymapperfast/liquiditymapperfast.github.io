import { PALETTES, mixHex, textOn } from '../theme.ts';
import { setTip } from '../tip.ts';
import { helpButton } from '../help.ts';
import { TIMEFRAMES, type Hub } from '../hub.ts';
import { DEFAULT_BAR_STATS, type Store, type AppState, type OiBar, type CandleRow } from '../store.ts';
import { chainedOi, oiChangeByTime, oiDeltas, oiPartsUntil, oiSumOf, oiUsdChangeByTime, type OiPart } from '../oi-change.ts';
import { anomalies, type HighlightOptions } from '../anomaly.ts';
import { venueLabel } from '../venues.ts';
import { activeIds, emptyScopeMessage, marketIds } from '../scope.ts';
import { ASKS, BIDS, DepthBars, fitsBars, neededBars, pixelFlags, sideFlags } from '../depth-bars.ts';
import type { View } from '../view.ts';
import { clock, price as fmtPrice, usd } from '../format.ts';
import { gutter, leftGutter, timeTicks, AXIS_W, type HeatPane } from './heat-pane.ts';
import { BAR_STATS, GROUP_SHORT, GROUP_TITLES, HEAD_H, PRESETS, coverageOf, csvCell, DAY_MS, dayStartOf, deviation, enabledStats, liquidationBuckets, pinnedLines, pinsAfterClick, rowScale, statCellLines, statDef, strength, tableBands, viewCellLines, type StatCell, type StatDef, type StatGroup, type StatInput, type LiquidationDay, type StatTone, type TableBand, type ViewCell } from './bar-stats.ts';
import { resolveZone } from '../traded/settings.ts';
import { resetKeys } from '../delta/candles.ts';
import { LIQUIDATIONS_PER_ANSWER, LIQUIDATION_RETENTION_MS } from '../../shared/liquidations.ts';
import { BROWSER_RETENTION_MS } from '../../shared/recorder.ts';
import { CARD_GAP, HoverCard } from '../hovercard.ts';
import type { InfoLine } from '../infobox.ts';
import { barAt, columnAt, depthCardLines, depthColumns, depthKey, ltCardLines, oiCardLines, oiTail, readAt, slotAt } from './pane-cards.ts';
import type { StatOptions } from '../stat-options.ts';
import { el } from '../dom.ts';
import { addTune } from '../pane-tune.ts';
import { isPhone } from '../device.ts';
import { niceTicks } from '../cvd/hero.ts';
import { button, checkRow, heading, note, numberRow, selectRow, sizeControl, sizeRow, sortableList, switchRow, togglePanel, type Panel } from '../ui.ts';
import { COMMON_SIZES, SIZE_FLOOR_USD, SIZE_MAX_USD, sizeText } from '../sizes.ts';
import { imbalanceAxis, type LtSeries } from '../lt.ts';
import { LT_HALF_LIVES } from '../../shared/lt-sample.ts';
import { GestureRecognizer, bindTouch, type GestureHandlers, type Pt } from '../touch.ts';
import { panelSwitchRow, panelSwitchOn, panelSwitchTip, setPanelSwitch } from '../sound/panel.ts';
import { t, tn } from '../i18n.ts';
import { currentCoin, scaledUsd, unscaledUsd } from '../coin.ts';
import { fetchOiHistory, webGet } from '../../shared/history.ts';
import { OiLongHistory, oiLongBars, oiLongPeriod, oiLongSeam, type OiLongHeld, type OiLongSeam } from './oi-long.ts';
import { DRAG_MIN_PX, selects } from '../range/selection.ts';
import type { RangeTool } from '../range/tool.ts';
import type { FlowBook } from '../flow-book.ts';
import { buildOiMarketsPanel, marketPicker } from '../market-picker.ts';
import { pageNow, replaying } from '../replay/clock.ts';

/**
 * Header readouts are rewritten on every pointer move by every pane. Assigning the text a node already has still re-parses it and
 * invalidates style and layout, so a node is written only when what it says changes.
 */
const written = new WeakMap<Element, string>();
export const setHtml = (node: Element | null, html: string): void => { if (!node || written.get(node) === html) return; written.set(node, html); node.innerHTML = html; };
export const setText = (node: Element | null, text: string): void => { if (!node || written.get(node) === text) return; written.set(node, text); node.textContent = text; };

/** A canvas pane whose x axis is the main chart's time axis. */
export abstract class TimePane {
  readonly root = document.createElement('section');
  protected head = document.createElement('div');
  protected canvas = document.createElement('canvas');
  protected ctx: CanvasRenderingContext2D;
  /**
   * The width from the plot's left edge to the canvas's right edge (what the panes draw in), its height and the pixel ratio. The plot starts
   * where the map's does, after the columns left of the map (`#left`), so time lines up with the map's; the panes draw in the plot's
   * coordinates and leave the strip under those columns empty.
   */
  protected w = 0; protected h = 0; protected dpr = 1;
  #canvasW = 0;
  get #left(): number { return leftGutter(this.store.state); }
  protected palette = PALETTES.light!;
  #frame = 0;
  /** What the map does with a gesture on the time axis these panes share with it (set by `useTimeGestures`). */
  #time: ReturnType<HeatPane['timeGestures']> | null = null;
  #pinned: Pt | null = null;
  #source: 'depth' | 'oi' | 'lt' | 'bars' | 'delta' | 'ls' | 'script';
  /** Where the pointer (or the pinned finger) is, in the page, for a popup that is a page element rather than canvas drawing. */
  protected pointer: { x: number; y: number } | null = null;
  /** The Range tool (set by the page), and a stretch of time being selected here: where the drag began, and where a finger last was. */
  #range: RangeTool | null = null;
  #selecting: { x: number } | null = null;
  #touchSelect: { start: Pt; at: Pt } | null = null;

  constructor(host: HTMLElement, protected store: Store, protected view: View, cls: string) {
    this.root.className = `pane ${cls}`; this.head.className = 'pane-head';
    this.root.append(this.head, this.canvas); host.append(this.root);
    this.ctx = this.canvas.getContext('2d')!;
    new ResizeObserver(() => this.#resize()).observe(this.canvas);
    const source = this.#source = cls as 'depth' | 'oi' | 'lt' | 'bars' | 'delta' | 'ls' | 'script';
    // A drag across a pane selects a stretch of time for the Range tool while it is armed, or with Ctrl (Cmd on a Mac) held.
    this.canvas.addEventListener('pointerdown', e => {
      this.rangeGesture = false;
      if (e.pointerType === 'touch' || !this.#range) return;
      const x = e.clientX - this.canvas.getBoundingClientRect().left - this.#left;
      if (!selects(this.#range.armed, e) || x < 0 || x > this.plotW) return;
      this.rangeGesture = true; this.#selecting = { x }; this.#range.begin({ t: this.#timeAt(x), p: null }); this.canvas.setPointerCapture(e.pointerId);
    });
    this.canvas.addEventListener('pointerup', e => {
      const sel = this.#selecting; if (!sel || !this.#range) return;
      const x = e.clientX - this.canvas.getBoundingClientRect().left - this.#left; this.#selecting = null;
      this.#range.end({ t: this.#timeAt(x), p: null }, Math.abs(x - sel.x) < DRAG_MIN_PX);
      if (this.canvas.hasPointerCapture(e.pointerId)) this.canvas.releasePointerCapture(e.pointerId);
    });
    this.canvas.addEventListener('pointermove', e => {
      if (e.pointerType === 'touch') return;
      const r = this.canvas.getBoundingClientRect(), x = e.clientX - r.left - this.#left, y = e.clientY - r.top;
      this.pointer = { x: e.clientX, y: e.clientY };
      if (this.#selecting) this.#range?.move({ t: this.#timeAt(x), p: null });
      this.canvas.style.cursor = this.#range?.armed && x <= this.plotW ? 'crosshair' : '';
      if (x < 0) { this.store.set({ hover: null }); return; }
      // Where the pane answers the pointer itself (Bar stats' View column), the time the panes share is left alone, and only it is drawn again.
      if (this.ownsPoint(x)) { if (this.store.state.hover) this.store.set({ hover: null }); this.invalidate(); return; }
      // Over the price axis the pointer reads the right edge of the plot, so a pane past its newest point keeps showing that (readAt).
      this.store.set({ hover: { t: this.view.tOf(Math.min(x, this.plotW), this.plotW), price: null, y, source } });
    });
    this.canvas.addEventListener('pointerleave', e => { if (e.pointerType !== 'touch') { this.pointer = null; this.store.set({ hover: null }); } });
    bindTouch(this.canvas, new GestureRecognizer(this.#touchHandlers()), () => this.#left);
  }

  /** Let the panes' finger gestures move the map's time axis (called once the map exists). */
  useTimeGestures(time: ReturnType<HeatPane['timeGestures']>): void { this.#time = time; }
  /** Let a drag across the pane select a stretch of time for the Range tool. */
  useRange(range: RangeTool): void { this.#range = range; }
  /** The time at `x`, held inside the plot. */
  #timeAt(x: number): number { return this.view.tOf(Math.max(0, Math.min(this.plotW, x)), this.plotW); }

  /**
   * A tap pins the readout at that time (tap it again to let it go), holding and dragging scrubs it, and dragging or pinching moves
   * the time axis the panes share with the map. Everything else about the finger is the map's business, so it is handed over.
   */
  #touchHandlers(): GestureHandlers {
    const pin = (p: Pt): void => {
      if (p.x < 0 || p.x > this.plotW) { this.#unpin(); return; }
      this.#pinned = p;
      const box = this.canvas.getBoundingClientRect(); this.pointer = { x: box.left + this.#left + p.x, y: box.top + p.y };
      this.store.set({ hover: { t: this.view.tOf(p.x, this.plotW), price: null, y: p.y, source: this.#source, touch: true } });
    };
    return {
      down: p => this.#time?.down?.(p),
      tap: p => { if (this.#pinned && Math.hypot(this.#pinned.x - p.x, this.#pinned.y - p.y) < 28) this.#unpin(); else pin(p); },
      doubleTap: p => { this.#unpin(); this.#time?.doubleTap?.(p); },
      hold: pin, holdMove: pin,
      panStart: p => {
        this.#unpin();
        if (this.#range?.armed && p.x <= this.plotW) { this.#touchSelect = { start: p, at: p }; this.#range.begin({ t: this.#timeAt(p.x), p: null }); return; }
        this.#time?.panStart?.(p);
      },
      pan: (d, p, v) => { if (this.#touchSelect) { this.#touchSelect.at = p; this.#range?.move({ t: this.#timeAt(p.x), p: null }); return; } this.#time?.pan?.(d, p, v); },
      panEnd: v => {
        const touch = this.#touchSelect;
        if (touch) { this.#touchSelect = null; if (v === null) this.#range?.cancel(); else this.#range?.end({ t: this.#timeAt(touch.at.x), p: null }, Math.abs(touch.at.x - touch.start.x) < DRAG_MIN_PX); return; }
        this.#time?.panEnd?.(v);
      },
      pinchStart: info => { this.#unpin(); this.#time?.pinchStart?.(info); },
      pinch: info => this.#time?.pinch?.(info),
      pinchEnd: () => this.#time?.pinchEnd?.(),
      cancel: () => { if (this.#touchSelect) { this.#touchSelect = null; this.#range?.cancel(); } this.#time?.cancel?.(); },
    };
  }
  #unpin(): void {
    this.#pinned = null;
    if (this.store.state.hover?.touch) this.store.set({ hover: null });
  }
  /** Whether the last press began a Range selection: the click it ends in is the selection's, not a click on the pane. */
  protected rangeGesture = false;
  /** Whether the pane answers the pointer at `x` (plot coordinates) itself, rather than as a time on the axis the panes share. */
  protected ownsPoint(_x: number): boolean { return false; }
  /** Header element, the grip target for drag-reordering. */
  get header(): HTMLElement { return this.head; }
  get plotW(): number { return Math.max(1, this.w - gutter(this.store.state)); }
  setPalette(name: string): void { this.palette = PALETTES[name] ?? PALETTES.light!; this.invalidate(); }
  invalidate(): void { if (!this.#frame) this.#frame = requestAnimationFrame(() => { this.#frame = 0; this.#prepare(); }); }
  #resize(): void {
    const r = this.canvas.getBoundingClientRect();
    this.#canvasW = Math.max(1, Math.floor(r.width)); this.h = Math.max(1, Math.floor(r.height)); this.dpr = window.devicePixelRatio || 1;
    this.canvas.width = Math.round(this.#canvasW * this.dpr); this.canvas.height = Math.round(this.h * this.dpr); this.invalidate();
  }
  #prepare(): void {
    const left = this.#left;
    this.w = Math.max(1, this.#canvasW - left);
    this.ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0); this.ctx.clearRect(0, 0, this.#canvasW, this.h);
    this.ctx.setTransform(this.dpr, 0, 0, this.dpr, this.dpr * left, 0);
    this.ctx.font = '11px ui-sans-serif, system-ui, sans-serif'; this.ctx.textBaseline = 'middle';
    if (this.view.t1 > this.view.t0 && this.w > 1) { this.cursorT = null; this.#grid(); this.draw(); this.#replayMask(); this.#rangeBand(); this.#crosshair(); } else { if (this.#pinned) this.#unpin(); this.undrawn(); }
  }
  #grid(): void {
    const { ctx, palette: p, view: v } = this, pw = this.plotW;
    ctx.strokeStyle = p.line; ctx.globalAlpha = 0.6; ctx.beginPath();
    for (const t of timeTicks(v.t0, v.t1, pw)) { const x = Math.round(v.xOf(t, pw)) + 0.5; ctx.moveTo(x, 0); ctx.lineTo(x, this.h); }
    ctx.stroke(); ctx.globalAlpha = 1;
    ctx.fillStyle = p.panel; ctx.fillRect(this.w - AXIS_W, 0, AXIS_W, this.h);
  }
  /** The Range tool's selection, as a lightly shaded band across the pane between dashed edges (a box on the map is its stretch of time here). */
  #rangeBand(): void {
    const sel = this.store.state.range; if (!sel) return;
    const { ctx, palette: p } = this, pw = this.plotW;
    const x0 = Math.max(0, this.view.xOf(sel.t0, pw)), x1 = Math.min(pw, this.view.xOf(sel.t1, pw));
    if (x1 <= x0) return;
    ctx.save(); ctx.fillStyle = p.text; ctx.globalAlpha = 0.07; ctx.fillRect(x0, 0, x1 - x0, this.h); ctx.globalAlpha = 1;
    ctx.strokeStyle = p.text; ctx.setLineDash([5, 4]); ctx.beginPath();
    for (const x of [x0, x1]) if (x > 0 && x < pw) { ctx.moveTo(Math.round(x) + 0.5, 0); ctx.lineTo(Math.round(x) + 0.5, this.h); }
    ctx.stroke(); ctx.restore();
  }
  #crosshair(): void {
    const hv = this.store.state.hover; if (!hv) return;
    const { ctx, palette: p } = this;
    const x = this.view.xOf(this.cursorT ?? hv.t, this.plotW);
    if (x < 0 || x > this.plotW) return;
    ctx.strokeStyle = p.muted; ctx.setLineDash([3, 3]); ctx.beginPath(); ctx.moveTo(Math.round(x) + 0.5, 0); ctx.lineTo(Math.round(x) + 0.5, this.h); ctx.stroke(); ctx.setLineDash([]);
  }
  /** Where the readout stands when it is not under the pointer (past the newest point it shows the newest): the cursor is drawn there. Set by `draw`. */
  protected cursorT: number | null = null;
  protected abstract draw(): void;
  /** Replay: what came after its moment is not shown, as on the map. */
  #replayMask(): void {
    if (!replaying()) return;
    const x = Math.max(0, Math.min(this.plotW, this.view.xOf(pageNow(), this.plotW)));
    if (x < this.plotW) { this.ctx.fillStyle = this.palette.bg; this.ctx.fillRect(x, 0, this.plotW - x, this.h); }
  }
  /** The pane was asked to draw but cannot (it is hidden, or has no size): let go of anything it put outside its canvas. A pin it holds is released first (and only its own, so a pin on another pane stays), or the card would come back at the same spot the next time the tab is shown. */
  protected undrawn(): void {}
}

/** Where the OI pane's bars come from when it is not the chart market alone: the venues added together, or the market standing in. */
export function oiSourceText(state: Pick<AppState, 'oiParts' | 'oiInstrument' | 'seriesInstrument'>, counted?: number): string | null {
  if (state.oiParts.length > 1) return counted !== undefined && counted < state.oiParts.length ? t('{n} of {m} venues', { n: counted, m: state.oiParts.length }) : t('{n} venues added together', { n: state.oiParts.length });
  return state.oiInstrument && state.oiInstrument !== state.seriesInstrument ? t('from {venue}', { venue: `${venueLabel(state.oiInstrument)} ${state.oiInstrument.split(':').slice(1).join(':')}` }) : null;
}

export class DepthPane extends TimePane {
  #range = 0.2;
  #series: { t0: number; t1: number; w: number; bid: Float32Array; ask: Float32Array } | null = null;
  #key = ''; #busy = false;
  /** When the last request was made, and how long the worker took to answer it (the live edge is asked again on a clock that allows for it). */
  #askedAt = 0; #tookMs = 0;
  /** The candles the highlight is judged on (`depth-bars.ts`), and what it says for each pixel column of the answer drawn (0, BIDS, ASKS), worked out when either changes, not on every frame the pointer moves. */
  #bars: DepthBars;
  #marks: { series: object; key: string; marks: Uint8Array } | null = null;
  /** The pane is too short for a popup drawn on it, so what the pointer is over is said in a page element. */
  #card = new HoverCard();
  #lines: InfoLine[] | null = null;
  /** The Sound box in the header (the depth sound's switch). */
  #bell = document.createElement('input');
  constructor(host: HTMLElement, store: Store, view: View, private hub: Hub) {
    super(host, store, view, 'depth');
    this.#bars = new DepthBars((ids, from, to, stepMs) => hub.source.columns(ids, from, to, stepMs));
    this.head.innerHTML = `<strong>${t('Depth')}</strong><span class="readout"></span>`;
    this.head.querySelector('strong')!.after(helpButton('depthPane'));
    const label = document.createElement('label'); label.className = 'ctl'; label.append(t('Range'));
    const select = document.createElement('select');
    for (const r of [0.01, 0.02, 0.05, 0.1, 0.2]) select.append(new Option(`${r * 100}%`, String(r)));
    select.value = String(this.#range); select.onchange = () => { this.#range = Number(select.value); this.#key = ''; this.invalidate(); };
    label.append(select); this.head.append(label);
    // An extreme balance can sound; its band, how rare and the hours it is judged against are in the Sounds panel.
    const bell = document.createElement('label'); bell.className = 'ctl'; this.#bell.type = 'checkbox';
    this.#bell.onchange = () => setPanelSwitch(this.store, 'depthPane', this.#bell.checked);
    bell.append(this.#bell, t('Sound')); setTip(bell, panelSwitchTip('depthPane')); this.head.append(bell);
    this.syncSound();
    // On a phone the range stays in the row and the sound waits behind the key (pane-tune.ts).
    addTune(this.head, [bell], t('Depth'));
  }
  refresh(): void { this.#key = ''; this.invalidate(); }
  /** Show the depth sound's switch as the settings have it (it is also in the Sounds panel). */
  syncSound(): void { this.#bell.checked = panelSwitchOn(this.store, 'depthPane'); }
  protected draw(): void {
    this.#lines = null;
    this.#paint();
    const at = this.pointer;
    if (this.#lines && at) this.#card.show(this.#lines, at.x, at.y); else this.#card.hide();
  }
  protected override undrawn(): void { this.#lines = null; this.#card.hide(); }
  #paint(): void {
    const { ctx, palette: p, view: v } = this, pw = this.plotW, ph = this.h;
    const state = this.store.state;
    const ids = activeIds(state);
    const emptyScope = emptyScopeMessage(state);
    if (emptyScope) { ctx.fillStyle = p.muted; ctx.textAlign = 'left'; ctx.fillText(emptyScope, 12, ph / 2); return; }
    const key = depthKey(ids, v.t0, v.t1, pw, this.#range, this.hub.columnsVersion);
    // What is live changes without the view moving: asked again every second and a half, or less often when an answer takes long.
    const refresh = v.t1 > Date.now() - 2 * MINUTE && performance.now() - this.#askedAt > Math.max(1_500, 3 * this.#tookMs);
    if ((key !== this.#key || refresh) && !this.#busy && ids.length) {
      this.#key = key; this.#busy = true;
      const asked = this.#askedAt = performance.now();
      const w = depthColumns(pw);
      const t0 = v.t0, t1 = v.t1;
      void this.hub.depth(ids, t0, t1, w, this.#range).then(r => { this.#tookMs = performance.now() - asked; this.#series = { t0, t1, w, bid: r.bid, ask: r.ask }; this.#busy = false; this.invalidate(); }, () => { this.#busy = false; });
    }
    const s = this.#series;
    const readout = this.head.querySelector('.readout');
    if (!s) { ctx.fillStyle = p.muted; ctx.fillText(t('Depth history is collecting…'), 12, ph / 2); return; }
    // Replay: only the columns up to its moment speak (the rest is covered).
    const cutW = replaying() ? Math.max(0, Math.min(s.w, Math.floor((pageNow() - s.t0) / (s.t1 - s.t0) * s.w))) : s.w;
    let max = 1, lastB = 0, lastA = 0, lastX = -1;
    for (let x = 0; x < cutW; x++) { max = Math.max(max, s.bid[x]!, s.ask[x]!); if (s.bid[x]! > 0 || s.ask[x]! > 0) { lastB = s.bid[x]!; lastA = s.ask[x]!; lastX = x; } }
    const lastTotal = lastB + lastA, lastImbalance = lastTotal > 0 ? (lastB - lastA) / lastTotal : 0;
    const dominant = Math.abs(lastImbalance) < 0.005 ? '' : ` <b class="${lastImbalance > 0 ? 'bid' : 'ask'}">${lastImbalance > 0 ? t('bids') : t('asks')} +${(Math.abs(lastImbalance) * 100).toFixed(1)}%</b>`;
    setHtml(readout, `A <b class="ask">${usd(lastA)}</b> B <b class="bid">${usd(lastB)}</b> Δ <b>${usd(lastB - lastA)}</b>${dominant}`);
    const hv = state.hover;
    if (hv && this.pointer) {
      const colT = (x: number): number => s.t0 + x / s.w * (s.t1 - s.t0), column = columnAt(s.t0, s.t1, s.w, hv.t), under = column < cutW ? column : -1;
      const at = readAt(under >= 0 && (s.bid[under]! > 0 || s.ask[under]! > 0) ? under : -1, hv.t, lastX, lastX >= 0 ? colT(lastX) : undefined);
      if (at >= 0 && at !== under) this.cursorT = colT(at + 0.5);
      if (at >= 0 && (s.bid[at]! > 0 || s.ask[at]! > 0)) {
        const here = s.bid[at]! + s.ask[at]!;
        let rank = 1, of = 0;
        for (let x = 0; x < cutW; x++) { const total = s.bid[x]! + s.ask[x]!; if (total > 0) { of++; if (total > here) rank++; } }
        this.#lines = depthCardLines({ time: s.t0 + at / s.w * (s.t1 - s.t0), bid: s.bid[at]!, ask: s.ask[at]!, range: this.#range, rank, of });
      }
    }
    const mid = ph / 2, half = ph / 2 - 6, cue = state.highlight.on;
    const xOf = (t: number) => v.xOf(t, pw);
    const marks = cue ? this.#highlight(s, state) : null;
    for (let x = 0; x < s.w; x++) {
      const t = s.t0 + x / s.w * (s.t1 - s.t0), t2 = s.t0 + (x + 1) / s.w * (s.t1 - s.t0);
      const x0 = xOf(t), x1 = xOf(t2);
      const b = s.bid[x]!, a = s.ask[x]!;
      // The side with more liquidity is drawn brighter and the other dimmer, in proportion to the imbalance (no flip, so it does not flicker).
      // Where Highlights flags the side that was unusually heavy, that side goes to full strength with an edge, and the other side stays as
      // it was: dimming it too made a highlight look like liquidity that went missing.
      const total = b + a, imbalance = total > 0 ? (b - a) / total : 0, lean = Math.min(1, Math.abs(imbalance) / 0.3) * 0.4, mark = marks?.[x] ?? 0;
      const bidAlpha = !cue ? 0.55 : mark === BIDS ? 0.95 : 0.5 + (imbalance > 0 ? 0.45 : -0.28) * lean;
      const askAlpha = !cue ? 0.55 : mark === ASKS ? 0.95 : 0.5 + (imbalance < 0 ? 0.45 : -0.28) * lean;
      // Asks above the line and bids below it, as they sit on the chart and in the order book.
      if (a > 0) {
        const height = a / max * half;
        ctx.fillStyle = p.ask; ctx.globalAlpha = askAlpha; ctx.fillRect(x0, mid - height, x1 - x0 + 0.6, height);
        if (mark === ASKS) { ctx.globalAlpha = 1; ctx.fillRect(x0, mid - height, x1 - x0 + 0.6, 1.5); }
      }
      if (b > 0) {
        const height = b / max * half;
        ctx.fillStyle = p.bid; ctx.globalAlpha = bidAlpha; ctx.fillRect(x0, mid, x1 - x0 + 0.6, height);
        if (mark === BIDS) { ctx.globalAlpha = 1; ctx.fillRect(x0, mid + height - 1.5, x1 - x0 + 0.6, 1.5); }
      }
    }
    ctx.globalAlpha = 1; ctx.strokeStyle = p.line; ctx.beginPath(); ctx.moveTo(0, mid + 0.5); ctx.lineTo(pw, mid + 0.5); ctx.stroke();
    ctx.fillStyle = p.muted; ctx.textAlign = 'left'; ctx.fillText(usd(max), this.w - AXIS_W + 6, 10); ctx.fillText(usd(max), this.w - AXIS_W + 6, ph - 10);
    ctx.fillText('0', this.w - AXIS_W + 6, mid);
  }

  /**
   * Which pixel columns of the answer `s` stand out, and on which side (0, BIDS, ASKS): the page's one rule (Highlights: how many
   * deviations over how many candles before), judged a candle at a time over the recording merged to each candle (`depth-bars.ts`), so
   * zooming and panning do not change it. A view of more candles than that can carry (a fine timeframe zoomed far out) is judged a pixel
   * column at a time, as before.
   */
  #highlight(s: { t0: number; t1: number; w: number; bid: Float32Array; ask: Float32Array }, state: AppState): Uint8Array {
    const tf = TIMEFRAMES[state.timeframe] ?? 3_600_000, h = state.highlight;
    // Up to the replay's moment, or live to the end of the forming candle (the real clock: what is recorded).
    const need = neededBars(s.t0, s.t1, tf, h.length, replaying() ? pageNow() : (Math.floor(Date.now() / tf) + 1) * tf);
    if (fitsBars(need, tf)) {
      this.#bars.ensure(marketIds(state), this.#range, tf, need, Date.now(), () => this.invalidate());
      const key = `bars|${this.#bars.version}|${need.from}|${need.to}|${tf}|${h.length}|${h.mult}`;
      if (this.#marks?.series !== s || this.#marks.key !== key) this.#marks = { series: s, key, marks: pixelFlags(this.#bars.flags(need, tf, h), need.from, tf, s.t0, s.t1, s.w) };
    } else {
      const columnsPerBar = s.w * tf / Math.max(1, s.t1 - s.t0), key = `pixels|${columnsPerBar}|${h.length}|${h.mult}`;
      if (this.#marks?.series !== s || this.#marks.key !== key) this.#marks = { series: s, key, marks: sideFlags(s.bid, s.ask, h, columnsPerBar) };
    }
    return this.#marks.marks;
  }
}

/**
 * Open interest is a level, so it is drawn as one: a step line that holds each sample until the next, a dimmer continuation to the
 * newest candle (no sample has arrived since), and below it the change between samples, with unusually large changes at full weight.
 */
export class OiPane extends TimePane {
  #cache: { oi: readonly OiBar[]; parts: readonly OiPart[]; key: string; delta: Float64Array; flag: Uint8Array; sigma: Float64Array } | null = null;
  #card = new HoverCard();
  #lines: InfoLine[] | null = null;
  readonly #venues = document.createElement('select');
  readonly #choose = document.createElement('button');
  #panel: Panel | null = null;
  constructor(host: HTMLElement, store: Store, view: View, flow: FlowBook) {
    super(host, store, view, 'oi');
    this.head.innerHTML = `<strong>${t('Open Interest')}</strong><span class="readout"></span>`;
    this.head.querySelector('strong')!.after(helpButton('oiPane'));
    // Whose open interest: the perpetuals of the venues switched on added together, or the chart market's own.
    const wrap = document.createElement('label'); wrap.className = 'ctl'; setTip(wrap, t('Whose open interest this pane, the bar statistics, NL/NS and the Long/Short pane count: the perpetuals of every venue switched on added together, the chart market alone, or the markets you choose.')); wrap.append(t('Venues'));
    this.#venues.append(new Option(t('All perpetuals'), 'all'), new Option(t('The chart market'), 'chart'), new Option(t('Chosen markets'), 'custom'));
    this.#venues.value = store.state.oiMarkets;
    this.#venues.onchange = () => { const v = this.#venues.value; store.set({ oiMarkets: v === 'chart' || v === 'custom' ? v : 'all' }); if (v === 'custom' && !this.#panel) { this.#choose.hidden = false; this.#choose.click(); } };
    // The markets picked, in a panel (the Delta pane opens the same one while it shows NL/NS).
    this.#choose.type = 'button'; this.#choose.textContent = t('Choose…'); setTip(this.#choose, t('Pick the perpetuals whose open interest is added together.'));
    this.#choose.hidden = store.state.oiMarkets !== 'custom';
    const build = (_tools: HTMLElement, body: HTMLElement): void => buildOiMarketsPanel(store, flow, body, () => this.#panel?.render(build));
    this.#choose.onclick = () => { this.#panel = togglePanel(this.#choose, { title: t('Open interest markets'), width: 380, align: 'right', onClose: () => { this.#panel = null; } }, build); };
    // One group, so the header's rule that puts its last control at the right edge moves the select and its button together.
    const group = document.createElement('span'); group.className = 'ctl ctl-group';
    wrap.append(this.#venues); group.append(wrap, this.#choose); this.head.append(group);
  }
  /** Each bar's change (oi-change.ts: venues added together count their own changes) and the ones that stand out. */
  #analysis(oi: readonly OiBar[], highlight: HighlightOptions, parts: readonly OiPart[], tfMs: number) {
    const key = `${highlight.mult}|${highlight.length}|${tfMs}`;
    if (this.#cache && this.#cache.oi === oi && this.#cache.parts === parts && this.#cache.key === key) return this.#cache;
    const change = parts.length > 1 ? oiChangeByTime(oi, parts, tfMs) : null;
    const delta = change ? Float64Array.from(oi, bar => change.get(bar[0]) ?? 0) : oiDeltas(oi), size = delta.map(Math.abs);
    const found = anomalies(size, highlight);
    this.#cache = { oi, parts, key, delta, flag: found.flag, sigma: found.sigma };
    return this.#cache;
  }
  protected draw(): void {
    this.#lines = null;
    this.#paint();
    const at = this.pointer;
    if (this.#lines && at) this.#card.show(this.#lines, at.x, at.y); else this.#card.hide();
  }
  protected override undrawn(): void { this.#lines = null; this.#card.hide(); }
  /** Replay: the bars that ended by its moment, kept until the next candle (the analysis is cached on the array); live, all of them. */
  #oiCut: { src: readonly OiBar[]; slot: number; out: OiBar[] } | null = null;
  #oiAt(bars: OiBar[], tf: number): OiBar[] {
    if (!replaying()) return bars;
    const slot = Math.floor(pageNow() / tf);
    if (this.#oiCut?.src === bars && this.#oiCut.slot === slot) return this.#oiCut.out;
    const out = bars.filter(b => b[0] + tf <= slot * tf);
    this.#oiCut = { src: bars, slot, out };
    return out;
  }
  /** Bybit's history further back than the readings held (oi-long.ts), read by the pane straight from Bybit: the server's store holds days of it. */
  readonly #long = new OiLongHistory((id, period, from, to) => {
    const listing = currentCoin().markets.bybit;
    if (!listing || `bybit:${listing.symbol}` !== id) return Promise.resolve([]);
    return fetchOiHistory(id, period, from, to, webGet, listing).then(rows => rows.map((r): OiBar => [Number(r.start), Number(r.open), Number(r.high), Number(r.low), Number(r.close)]));
  }, () => this.invalidate());
  #seam: { parts: readonly OiPart[]; oi: readonly OiBar[]; id: string; seam: OiLongSeam | null } | null = null;
  #scaled: { held: OiLongHeld; t: number; k: number; bars: OiBar[] } | null = null;
  /**
   * The long view, for venues added together that count Bybit's perpetual and a view that starts before the readings held: the seam, Bybit's
   * readings before it put at its scale, and their period (the chart's while none are held yet). Null otherwise, and in a replay, which shows
   * what was known at its moment. Not for a view inside the readings held: where only Bybit's go back (a coin with no Binance perpetual, or
   * Binance's history not read), the seam is near the newest bar, and the estimate took the place of the readings in every view (review,
   * 2026-10-30).
   */
  #extension(parts: readonly OiPart[], oi: readonly OiBar[], tf: number): { seam: OiLongSeam; period: number; bars: readonly OiBar[] } | null {
    const listing = currentCoin().markets.bybit;
    if (replaying() || parts.length < 2 || !listing || listing.inverse) return null;
    const id = `bybit:${listing.symbol}`;
    if (this.#seam?.parts !== parts || this.#seam.oi !== oi || this.#seam.id !== id) this.#seam = { parts, oi, id, seam: oiLongSeam(parts, id, oi) };
    const seam = this.#seam.seam, v = this.view;
    if (!seam || v.t0 >= oi[0]![0]) return null;
    const held = this.#long.rows(id, oiLongPeriod(tf, v.t1 - v.t0, this.plotW), v, seam.t);
    if (!held) return { seam, period: tf, bars: [] };
    if (this.#scaled?.held !== held || this.#scaled.t !== seam.t || this.#scaled.k !== seam.k) this.#scaled = { held, t: seam.t, k: seam.k, bars: oiLongBars(held.bars, held.period, seam) };
    return { seam, period: held.period, bars: this.#scaled.bars };
  }
  #paint(): void {
    const { ctx, palette: p, view: v } = this, pw = this.plotW, ph = this.h, state: AppState = this.store.state;
    // Replay: the bar under way at its moment would carry what came after; only bars that ended by then.
    if (this.#venues.value !== state.oiMarkets) this.#venues.value = state.oiMarkets;
    this.#choose.hidden = state.oiMarkets !== 'custom';
    // Venues added together: the sum is made of the bars that ended by the replay's moment (oiPartsUntil), as NL/NS makes its own.
    const tf = TIMEFRAMES[state.timeframe] ?? 3_600_000, parts = oiPartsUntil(state.oiParts, tf, replaying() ? Math.floor(pageNow() / tf) * tf : Infinity);
    // Venues added together: the level chained from the bars' changes (it ends at the total now), so a venue whose readings start or stop
    // makes no step the bars do not show.
    const oi = parts.length > 1 ? chainedOi(oiSumOf(parts, tf)) : this.#oiAt(state.oi, tf), highlight = state.highlight;
    const readout = this.head.querySelector('.readout');
    const say = (html: string): void => setHtml(readout, html);
    if (!oi.length) { ctx.fillStyle = p.muted; ctx.textAlign = 'left'; ctx.fillText(t('No open-interest history for this market yet.'), 12, ph / 2); say(''); return; }
    const analysis = this.#analysis(oi, highlight, parts, tf);
    // Further back than the readings held, Bybit's history goes on from the seam (oi-long.ts): the bars before it, Bybit's readings alone, give
    // way to it. It is drawn as the level only, dashed: an estimate, and its readings a day or four hours apart beside the candles' changes.
    // (While its readings are read, the bars before the seam stay drawn.)
    const ext = this.#extension(parts, oi, tf), early = ext?.bars ?? [], seamI = early.length ? ext!.seam.index : 0, ep = ext?.period ?? tf;
    const visible: number[] = [], shownEarly: number[] = [];
    for (let i = seamI; i < oi.length; i++) if (oi[i]![0] + tf >= v.t0 && oi[i]![0] <= v.t1) visible.push(i);
    for (let j = 0; j < early.length; j++) if (early[j]![0] + ep >= v.t0 && early[j]![0] <= v.t1) shownEarly.push(j);
    // A view starting between the last reading's period and the seam: the last reading's level is what the line holds there.
    if (!shownEarly.length && early.length && early[early.length - 1]![0] < v.t0 && v.t0 < oi[seamI]![0]) shownEarly.push(early.length - 1);
    if (!visible.length && !shownEarly.length) { ctx.fillStyle = p.muted; ctx.textAlign = 'left'; ctx.fillText(ext && this.#long.loading ? t('Reading Bybit\'s open-interest history…') : t('No open-interest samples in view.'), 12, ph / 2); say(''); return; }
    // Geometry: the level on top, the change below (when the pane is tall enough to hold both).
    const split = ph >= 84, lineBottom = split ? Math.round(ph * 0.6) : ph - 6, bandTop = lineBottom + 12, bandBottom = ph - 5, mid = (bandTop + bandBottom) / 2, half = (bandBottom - bandTop) / 2;
    let lo = Infinity, hi = -Infinity, maxDelta = 0;
    for (const i of visible) { const b = oi[i]!; lo = Math.min(lo, b[3], b[4]); hi = Math.max(hi, b[2], b[4]); maxDelta = Math.max(maxDelta, Math.abs(analysis.delta[i]!)); }
    for (const j of shownEarly) { const b = early[j]!; lo = Math.min(lo, b[3], b[4]); hi = Math.max(hi, b[2], b[4]); }
    const pad = Math.max((hi - lo) * 0.18, hi * 0.0004), min = lo - pad, max = hi + pad;
    const y = (value: number) => 6 + (1 - (value - min) / (max - min)) * (lineBottom - 6);
    const xc = (i: number) => v.xOf(oi[i]![0] + tf / 2, pw), xe = (j: number) => v.xOf(early[j]![0] + ep / 2, pw);
    const first = visible.length ? Math.max(seamI, visible[0]! - 1) : -1, last = visible.length ? visible[visible.length - 1]! : -1;
    const lastBar = oi[oi.length - 1]!, newestCandle = state.candles[state.candles.length - 1];
    const reachT = Math.min(v.t1, Math.max(lastBar[0] + tf, newestCandle ? newestCandle[0] + tf : 0));
    const xEnd = Math.min(pw, v.xOf(reachT, pw)), xSampled = Math.min(pw, xc(oi.length - 1));
    const line = (from: number, to: number): void => { // step line over bars first..to, ending at the newest sample's centre
      ctx.beginPath(); ctx.moveTo(xc(from), y(oi[from]![4]));
      for (let i = from + 1; i <= to; i++) { ctx.lineTo(xc(i), y(oi[i - 1]![4])); ctx.lineTo(xc(i), y(oi[i]![4])); }
    };
    // Change histogram.
    if (split) {
      const emphasise = highlight.on;
      ctx.globalAlpha = 0.5; ctx.strokeStyle = p.line; ctx.beginPath(); ctx.moveTo(0, Math.round(mid) + 0.5); ctx.lineTo(pw, Math.round(mid) + 0.5); ctx.stroke(); ctx.globalAlpha = 1;
      for (const i of visible) {
        if (i === 0) continue;
        const d = analysis.delta[i]!; if (d === 0) continue;
        const x0 = v.xOf(oi[i - 1]![0] + tf, pw), x1 = v.xOf(oi[i]![0] + tf, pw), h = Math.abs(d) / (maxDelta || 1) * half;
        ctx.globalAlpha = !emphasise ? 0.75 : analysis.flag[i] ? 1 : 0.38; ctx.fillStyle = d > 0 ? p.bid : p.ask;
        ctx.fillRect(x0 + 0.5, d > 0 ? mid - h : mid, Math.max(1, x1 - x0 - 1), Math.max(1, h));
        if (emphasise && analysis.flag[i]) { // a small cap outside the bar says "this one stands out"
          ctx.fillRect(x0 + 0.5, d > 0 ? mid - h - 2.5 : mid + h + 0.5, Math.max(1, x1 - x0 - 1), 2);
        }
      }
      ctx.globalAlpha = 1;
    }
    // Level: soft area, step line, dashed continuation, sample dots.
    ctx.save(); ctx.beginPath(); ctx.rect(0, 0, pw, ph); ctx.clip();
    ctx.lineWidth = 1.6; ctx.strokeStyle = p.accent; ctx.fillStyle = p.accent;
    if (shownEarly.length) {
      // Bybit's history: a step line through its readings, the last stepping to the line's level where the line starts (Bybit's reading
      // there times k is that level), faint and dashed as the stretches with fewer venues are. Readings under 6 px apart (a day apart over
      // a year) are joined straight: steps that narrow broke the dashes into specks.
      const j0 = Math.max(0, shownEarly[0]! - 1), j1 = Math.min(early.length - 1, shownEarly[shownEarly.length - 1]! + 1), joins = j1 === early.length - 1;
      const endX = joins ? xc(seamI) : xe(j1), stepped = pw * ep / Math.max(1, v.t1 - v.t0) >= 6;
      const trace = (): void => {
        ctx.beginPath(); ctx.moveTo(xe(j0), y(early[j0]![4]));
        for (let j = j0 + 1; j <= j1; j++) { if (stepped) ctx.lineTo(xe(j), y(early[j - 1]![4])); ctx.lineTo(xe(j), y(early[j]![4])); }
        if (joins) { if (stepped) ctx.lineTo(endX, y(early[j1]![4])); ctx.lineTo(endX, y(oi[seamI]![4])); }
      };
      trace(); ctx.lineTo(endX, lineBottom); ctx.lineTo(xe(j0), lineBottom); ctx.closePath();
      ctx.globalAlpha = 0.05; ctx.fill();
      trace(); ctx.globalAlpha = 0.45; ctx.setLineDash([3, 3]); ctx.stroke(); ctx.setLineDash([]); ctx.globalAlpha = 1;
    }
    // Venues added together: where fewer of them have a reading than elsewhere in view (a recording gap), the sum is drawn dashed and faint,
    // so a gap does not read as positions opened or closed.
    const venues = parts.length > 1 ? oiSumOf(parts, tf).venues : null, most = venues ? Math.max(...visible.map(i => venues[i] ?? 0)) : 0;
    if (visible.length) {
      // The line holds the last sample on screen. It ends at the newest sample's centre only when that sample is the one on screen; looking at
      // the past it carries its level to the edge of the view, and the newest value (which is somewhere to the right) is not joined to it.
      const tail = oiTail(oi.length, last, xSampled, pw), endY = y(oi[last]![4]);
      line(first, last); ctx.lineTo(tail.x, endY); ctx.lineTo(tail.x, lineBottom); ctx.lineTo(xc(first), lineBottom); ctx.closePath();
      ctx.globalAlpha = 0.09; ctx.fill(); ctx.globalAlpha = 1;
      if (venues && visible.some(i => (venues[i] ?? 0) < most)) {
        const full = (i: number): boolean => (venues[i] ?? 0) >= most;
        for (let i = first; i <= last; i++) {
          const x0 = i === first ? xc(i) : xc(i), y0 = y(oi[Math.max(first, i - 1)]![4]);
          ctx.setLineDash(full(i) ? [] : [3, 3]); ctx.globalAlpha = full(i) ? 1 : 0.45; ctx.beginPath();
          if (i === first) { ctx.moveTo(x0, y(oi[i]![4])); } else { ctx.moveTo(x0, y0); ctx.lineTo(x0, y(oi[i]![4])); }
          ctx.lineTo(i === last ? tail.x : xc(i + 1), y(oi[i]![4])); ctx.stroke();
        }
        ctx.setLineDash([]); ctx.globalAlpha = 1;
      } else { line(first, last); ctx.lineTo(tail.x, endY); ctx.stroke(); }
      if (tail.live && xEnd > xSampled + 2) { ctx.globalAlpha = 0.55; ctx.setLineDash([4, 4]); ctx.beginPath(); ctx.moveTo(xSampled, y(lastBar[4])); ctx.lineTo(xEnd, y(lastBar[4])); ctx.stroke(); ctx.setLineDash([]); ctx.globalAlpha = 1; }
      ctx.lineWidth = 1;
      const spacing = visible.length > 1 ? (xc(visible[visible.length - 1]!) - xc(visible[0]!)) / (visible.length - 1) : 99;
      if (spacing >= 9) { ctx.fillStyle = p.accent; for (const i of visible) { ctx.beginPath(); ctx.arc(xc(i), y(oi[i]![4]), 2.4, 0, Math.PI * 2); ctx.fill(); } }
    }
    ctx.restore();
    ctx.fillStyle = p.muted; ctx.textAlign = 'left';
    // A coin counted in billions (PEPE) would not fit the axis written out in full.
    const amount = (v: number): string => Math.abs(v) >= 1e6 ? usd(v) : fmtPrice(v, 1);
    ctx.fillText(amount(max), this.w - AXIS_W + 6, 10); ctx.fillText(amount(min), this.w - AXIS_W + 6, lineBottom - 4);
    if (split && visible.length) { ctx.fillText(`±${amount(maxDelta)}`, this.w - AXIS_W + 6, mid); }
    // Readout: the hovered sample, else the newest, with where the data comes from and how old it is.
    const hover = state.hover;
    // Over Bybit's history: its reading there, marked as the estimate it is.
    if (hover && early.length && hover.t < oi[seamI]![0]) {
      let j = 0;
      while (j + 1 < early.length && early[j + 1]![0] <= hover.t) j++;
      const there = early[j]!, change = j > 0 ? there[4] - early[j - 1]![4] : null, sign = change === null ? '' : change > 0 ? '+' : change < 0 ? '−' : '';
      const name = Object.entries(TIMEFRAMES).find(([, ms]) => ms === ep)?.[0] ?? '';
      const from = t('from Bybit\'s {period} history ×{k}, scaled to meet the line', { period: name, k: ext!.seam.k.toFixed(2) });
      if (this.pointer) this.#lines = oiCardLines({ time: there[0], level: there[4], change, before: null, rank: null, of: 0, sigma: null, source: from, staleMin: null, estimate: true });
      say(`${t('base')} <b>≈ ${fmtPrice(there[4], 1)}</b>${change === null ? '' : ` Δ <b class="${change > 0 ? 'bid' : change < 0 ? 'ask' : ''}">≈ ${sign}${fmtPrice(Math.abs(change), 1)}</b>`} <span class="muted">${from}</span>`);
      return;
    }
    let shown = oi.length - 1;
    if (hover) { shown = -1; for (let i = 0; i < oi.length; i++) if (oi[i]![0] <= hover.t) shown = i; else break; if (shown < 0) shown = 0; }
    const bar = oi[shown]!, d = shown > 0 ? analysis.delta[shown]! : 0, flagged = highlight.on && analysis.flag[shown] === 1;
    const age = pageNow() - lastBar[0], stale = age > Math.max(3 * tf, 3 * 60_000);
    const sign = d > 0 ? '+' : d < 0 ? '−' : '';
    const from = oiSourceText(state, venues?.[shown]), source = from ? ` <span class="muted">${from}</span>` : '';
    const sigma = flagged && Number.isFinite(analysis.sigma[shown]) ? ` <span class="muted">${analysis.sigma[shown]!.toFixed(1)}σ</span>` : '';
    const over = hover && this.pointer ? barAt(oi, tf, hover.t) : -1;
    if (over === oi.length - 1 && hover && hover.t >= oi[over]![0] + tf) this.cursorT = oi[over]![0] + tf / 2;
    if (over >= 0) {
      const there = oi[over]!, seen = visible.filter(i => i > 0), change = over > 0 ? analysis.delta[over]! : null, size = change === null ? 0 : Math.abs(change);
      this.#lines = oiCardLines({
        time: there[0], level: there[4], change, before: over > 1 ? analysis.delta[over - 1]! : null,
        rank: change === null || !seen.length ? null : 1 + seen.filter(i => Math.abs(analysis.delta[i]!) > size).length, of: seen.length,
        sigma: highlight.on && analysis.flag[over] === 1 && Number.isFinite(analysis.sigma[over]) ? analysis.sigma[over]! : null,
        source: oiSourceText(state, venues?.[over]),
        staleMin: over === oi.length - 1 && stale ? Math.round(age / 60_000) : null,
      });
    }
    say(`${t('base')} <b>${fmtPrice(bar[4], 1)}</b> Δ <b class="${d > 0 ? 'bid' : d < 0 ? 'ask' : ''}">${sign}${fmtPrice(Math.abs(d), 1)}</b>${sigma}${source}${stale ? ` <span class="ask">${t('last sample {n} min ago', { n: Math.round(age / 60_000) })}</span>` : ''}`);
  }
}

/** The Liquidity Tracker's size filters' menus (any size can be typed; the menus' "any" and "no cap" are 0). */
const MIN_SIZES = [10_000, 50_000, 100_000, 250_000, 500_000, 1_000_000];
const MAX_SIZES = [100_000, 250_000, 500_000, 1_000_000, 5_000_000];
/** The half-lives a phone has a chip for (the others are in the sheet's menu); 10 bp is the default (Karl, 2026-11-03). */
const LT_CHIPS: readonly number[] = [10, 25, 50, 100, 250];
const MINUTE = 60_000;

/** Liquidity Tracker row: distance-weighted bid and ask liquidity of the aggregated enabled venues over time (see lt.ts). */
export class LtPane extends TimePane {
  #series: (LtSeries & { stepMs: number }) | null = null;
  #key = ''; #busy = false; #lastAt = 0;
  #sync: (() => void)[] = [];
  #card = new HoverCard();
  #lines: InfoLine[] | null = null;
  constructor(host: HTMLElement, store: Store, view: View, private hub: Hub) {
    super(host, store, view, 'lt');
    this.hub.onLtLane = () => this.invalidate();
    this.head.innerHTML = `<strong>${t('Liquidity Tracker')}</strong><span class="readout"></span>`;
    this.head.querySelector('strong')!.after(helpButton('ltPane'));
    setTip(this.head.querySelector('strong')!, t("Weighted USD liquidity near the touch: each enabled venue measured from its own best bid and best ask, then added up. A level weighs 1 at the touch and halves every half-life. The size filter applies to a venue's aggregated size at one price bin, not to individual orders."));
    const lt = () => this.store.state.lt;
    const patch = (change: Partial<AppState['lt']>) => this.store.set({ lt: { ...lt(), ...change } });
    const select = (label: string, title: string, options: [string, string][], get: () => string, set: (value: string) => void): HTMLLabelElement => {
      const wrap = document.createElement('label'); wrap.className = 'ctl'; setTip(wrap, title); wrap.append(label);
      const control = document.createElement('select');
      for (const [value, text] of options) control.append(new Option(text, value));
      control.value = get(); control.onchange = () => set(control.value);
      wrap.append(control); this.head.append(wrap);
      this.#sync.push(() => { if (control.value !== get()) control.value = get(); });
      return wrap;
    };
    // Any size, typed or from the menu; 0 is no filter.
    const size = (label: string, title: string, sign: '≥' | '≤', none: string, presets: readonly number[], get: () => number, put: (usd: number) => void): HTMLLabelElement => {
      const wrap = document.createElement('label'); wrap.className = 'ctl'; setTip(wrap, title); wrap.append(label);
      const control = sizeControl(label, { sign, value: scaledUsd(get()), presets: presets.map(scaledUsd), min: 1, max: scaledUsd(SIZE_MAX_USD), none }, v => put(v === 0 ? 0 : unscaledUsd(v)));
      wrap.append(control.root); this.head.append(wrap);
      this.#sync.push(() => control.set(scaledUsd(get())));
      return wrap;
    };
    // Exactly the half-lives the recording keeps the tracker for (`shared/lt-sample.ts`).
    const half = select(t('Half-life'), t("Distance from the touch, in basis points of price, at which a level's weight halves"), LT_HALF_LIVES.map(v => [String(v), `${v} bp`]), () => String(lt().halfLifeBp), v => patch({ halfLifeBp: Number(v) }));
    const min = size(t('Min'), t('Ignore price bins smaller than this'), '≥', t('any'), MIN_SIZES, () => lt().minUsd, v => patch({ minUsd: v }));
    const max = size(t('Max'), t('Ignore price bins larger than this'), '≤', t('no cap'), MAX_SIZES, () => lt().maxUsd, v => patch({ maxUsd: v }));
    const avg = document.createElement('label'); avg.className = 'ctl'; setTip(avg, t('Divide by the summed weights of the non-empty levels, as if each had size 1'));
    const box = document.createElement('input'); box.type = 'checkbox'; box.checked = lt().average; box.onchange = () => patch({ average: box.checked });
    avg.append(box, t('Per level')); this.head.append(avg);
    // The balance tipping can sound (the threshold and the volume are in the Sounds panel).
    const bell = document.createElement('label'); bell.className = 'ctl'; const bellBox = document.createElement('input'); bellBox.type = 'checkbox';
    bellBox.onchange = () => setPanelSwitch(this.store, 'depth', bellBox.checked);
    bell.append(bellBox, t('Sound')); setTip(bell, t('Within 1% of the price, the bids outweigh the asks (or the other way round) by more than this share. It sounds once and again only after the book has come back. Three steps.')); this.head.append(bell);
    this.#sync.push(() => { bellBox.checked = panelSwitchOn(this.store, 'depth'); });
    this.#sync.push(() => { if (box.checked !== lt().average) box.checked = lt().average; });
    const viewChoice = select(t('View'), t('Bid and ask lines, or the imbalance (bid - ask) / (bid + ask)'), [['lines', t('Bid & ask')], ['imbalance', t('Imbalance')]], () => lt().view, v => patch({ view: v as AppState['lt']['view'] }));
    // On a phone the half-life is a row of chips, one tap to each (Karl, 2026-10-26: a menu is a long way to the one wanted), and the rest
    // of the controls wait behind the key at the row's end. The select stays, in the sheet, for the half-lives with no chip.
    const chips = el('div', { class: 'ctl lt-halves', role: 'group', ariaLabel: t('Half-life') }, el('span', { class: 'cap', textContent: `${t('Half-life')} · bp` }));
    const seg = el('div', { class: 'seg' });
    for (const bp of LT_HALF_LIVES) {
      const chip = el('button', { type: 'button', textContent: String(bp), onclick: () => patch({ halfLifeBp: bp }) });
      chip.dataset.bp = String(bp);
      // Chips for the half-lives that are used; another one shows only while it is the one chosen.
      if (!LT_CHIPS.includes(bp)) chip.classList.add('far');
      seg.append(chip);
    }
    chips.append(seg); this.head.append(chips);
    this.#sync.push(() => { for (const chip of seg.children) { const on = Number((chip as HTMLElement).dataset.bp) === lt().halfLifeBp; chip.classList.toggle('on', on); chip.setAttribute('aria-pressed', String(on)); } });
    addTune(this.head, [half, min, max, avg, bell, viewChoice], t('Liquidity Tracker'));
  }
  /** Recompute on the next draw and reflect persisted settings in the controls. */
  refresh(): void { this.#key = ''; for (const sync of this.#sync) sync(); this.invalidate(); }

  protected draw(): void {
    this.#lines = null;
    this.#paint();
    const at = this.pointer;
    if (this.#lines && at) this.#card.show(this.#lines, at.x, at.y); else this.#card.hide();
  }
  protected override undrawn(): void { this.#lines = null; this.#card.hide(); }
  #paint(): void {
    const { ctx, palette: p, view: v } = this, pw = this.plotW, ph = this.h, state = this.store.state, lt = state.lt;
    const ids = activeIds(state);
    const emptyScope = emptyScopeMessage(state);
    if (emptyScope) { ctx.fillStyle = p.muted; ctx.textAlign = 'left'; ctx.fillText(emptyScope, 12, ph / 2); return; }
    const t0 = Math.floor(v.t0 / MINUTE) * MINUTE, t1 = Math.ceil(v.t1 / MINUTE) * MINUTE;
    // Where the trackers come from: the lane (the tracker alone, asked for by this pane: lt-lane.ts) where the source has one and no size filter is
    // set; the recorded columns (the books the map is drawn from, which a size filter needs, and which the browser engine has at hand) otherwise.
    const lane = this.hub.ltLane, useLane = lane.serve(ids, v, pw, lt.halfLifeBp, lt.minUsd > 0 || lt.maxUsd > 0);
    const key = useLane ? `lane|${ids.join(',')}|${t0}|${t1}|${lane.version}|${lt.halfLifeBp}|${lt.average}`
      : `${ids.join(',')}|${t0}|${t1}|${this.hub.columnsVersion}|${lt.halfLifeBp}|${lt.minUsd}|${lt.maxUsd}|${lt.average}`;
    const liveTail = v.t1 > Date.now() - 2 * MINUTE;
    if (ids.length && !this.#busy && (key !== this.#key || (liveTail && performance.now() - this.#lastAt > 1_500))) {
      this.#key = key; this.#busy = true; this.#lastAt = performance.now();
      const params = { halfLifeBp: lt.halfLifeBp, minUsd: scaledUsd(lt.minUsd), maxUsd: scaledUsd(lt.maxUsd), average: lt.average };
      // While the lane holds nothing for the step or half-life just chosen, the series on screen stays (it carries its own step) rather than a blank.
      void this.hub.lt(ids, t0, t1, params, useLane).then(r => { if (!(useLane && !lane.holds && this.#series)) this.#series = { ...r, stepMs: r.stepMs ?? this.hub.columnStepMs }; this.#busy = false; this.invalidate(); }, () => { this.#busy = false; });
    }
    const s = this.#series, readout = this.head.querySelector('.readout')!;
    if (!s || !s.times.length) { ctx.fillStyle = p.muted; ctx.fillText(t('Liquidity tracker is collecting…'), 12, ph / 2); setText(readout, ''); return; }
    let n = s.times.length;
    if (replaying()) { const cut = pageNow(); while (n > 0 && s.times[n - 1]! > cut) n--; }
    if (!n) { setText(readout, ''); return; }
    const step = s.stepMs, xOf = (t: number) => v.xOf(t + step / 2, pw), gap = step * 2.5;
    let max = 0;
    for (let i = 0; i < n; i++) if (s.times[i]! + step >= v.t0 && s.times[i]! <= v.t1) max = Math.max(max, s.bid[i]!, s.ask[i]!);
    ctx.fillStyle = p.muted; ctx.textAlign = 'left';
    if (lt.view === 'lines') {
      const hi = Math.max(max, 1) * 1.08, y = (value: number) => ph - 6 - value / hi * (ph - 12);
      // On a phone the lines have round gridlines to read their height by and a tag at their ends with the newest figure, as the map's price has;
      // the desktop keeps its two numbers (Karl, 2026-10-26: the tracker is the pane that is looked at).
      const phone = isPhone(), ticks = phone ? niceTicks(0, hi, 3).values.filter(value => value > 0) : [];
      if (phone && ticks.length) {
        ctx.save(); ctx.strokeStyle = p.line; ctx.globalAlpha = 0.8; ctx.lineWidth = 1; ctx.setLineDash([1, 3]); ctx.beginPath();
        for (const value of ticks) { const gy = Math.round(y(value)) + 0.5; ctx.moveTo(0, gy); ctx.lineTo(pw, gy); }
        ctx.stroke(); ctx.restore();
      }
      if (state.highlight.on) { // the gap between the lines takes the colour of the side with more, stronger the larger the imbalance
        for (let i = 0; i < n; i++) {
          const t = s.times[i]!, b = s.bid[i]!, a = s.ask[i]!, total = b + a; if (t + step < v.t0 - step || t > v.t1 + step || total <= 0) continue;
          const x0 = xOf(t - step / 2), x1 = xOf(t + step / 2), imbalance = Math.abs(b - a) / total, top = y(Math.max(a, b)), bottom = y(Math.min(a, b));
          ctx.globalAlpha = 0.06 + 0.4 * Math.min(1, imbalance / 0.4); ctx.fillStyle = b >= a ? p.bid : p.ask;
          ctx.fillRect(x0, top, Math.max(1, x1 - x0 - 0.3), Math.max(1, bottom - top));
        }
        ctx.globalAlpha = 1;
      }
      for (const [data, color] of [[s.bid, p.bid], [s.ask, p.ask]] as const) {
        ctx.strokeStyle = color; ctx.lineWidth = 1.5; ctx.beginPath();
        let prev = -Infinity;
        for (let i = 0; i < n; i++) {
          const t = s.times[i]!; if (t + step < v.t0 - step || t > v.t1 + step) continue;
          const px = xOf(t), py = y(data[i]!);
          if (t - prev > gap) ctx.moveTo(px, py); else ctx.lineTo(px, py);
          prev = t;
        }
        ctx.stroke();
      }
      ctx.lineWidth = 1; ctx.fillStyle = p.muted;
      if (!phone) { ctx.fillText(usd(hi), this.w - AXIS_W + 6, 10); ctx.fillText('0', this.w - AXIS_W + 6, ph - 8); }
      else {
        // The newest figure of each line, in a tag at its end (the ask above the bid, never one over the other), and the round numbers between the tags.
        const last = n - 1, tags: { y: number; text: string; color: string }[] = [];
        if (last >= 0 && s.times[last]! + step >= v.t0 && s.times[last]! <= v.t1 + step) tags.push({ y: y(s.ask[last]!), text: usd(s.ask[last]!), color: p.ask }, { y: y(s.bid[last]!), text: usd(s.bid[last]!), color: p.bid });
        tags.sort((a, b) => a.y - b.y);
        for (let k = 1; k < tags.length; k++) if (tags[k]!.y - tags[k - 1]!.y < 15) tags[k]!.y = tags[k - 1]!.y + 15;
        // Two lines near zero push the lower tag below the plot: the pair is lifted back up from the floor.
        for (let k = tags.length - 1, floor = ph - 8; k >= 0; k--, floor = tags[k + 1]!.y - 15) if (tags[k]!.y > floor) tags[k]!.y = floor;
        ctx.textAlign = 'left';
        for (const value of [0, ...ticks]) { const gy = y(value); if (!tags.some(tag => Math.abs(tag.y - gy) < 9)) ctx.fillText(value === 0 ? '0' : usd(value), this.w - AXIS_W + 6, value === 0 ? ph - 8 : gy); }
        for (const tag of tags) {
          ctx.fillStyle = tag.color; ctx.fillRect(this.w - AXIS_W + 1, tag.y - 7, AXIS_W - 2, 14);
          ctx.fillStyle = textOn(tag.color, 1, p); ctx.font = `600 10px ui-monospace, SFMono-Regular, Menlo, monospace`; ctx.textAlign = 'center'; ctx.fillText(tag.text, this.w - AXIS_W / 2, tag.y + 0.5);
        }
        ctx.font = '11px ui-sans-serif, system-ui, sans-serif'; ctx.textAlign = 'left';
      }
    } else {
      const mid = ph / 2, half = ph / 2 - 6;
      // The axis follows the data in view, as the lines' does (a book is rarely more than a few percent out of balance, and on ±100 % that is a hair):
      // the largest imbalance on screen, up to the next of 2, 5, 10, 20, 50 and 100 %. The height of a bar is its share of that.
      let largest = 0;
      for (let i = 0; i < n; i++) {
        const t = s.times[i]!, total = s.bid[i]! + s.ask[i]!; if (t + step < v.t0 || t > v.t1 || total <= 0) continue;
        largest = Math.max(largest, Math.abs(s.bid[i]! - s.ask[i]!) / total);
      }
      const axis = imbalanceAxis(largest);
      for (let i = 0; i < n; i++) {
        const t = s.times[i]!, total = s.bid[i]! + s.ask[i]!; if (t + step < v.t0 || t > v.t1 || total <= 0) continue;
        const imb = (s.bid[i]! - s.ask[i]!) / total, x0 = xOf(t - step / 2), x1 = xOf(t + step / 2), height = Math.abs(imb) / axis * half;
        ctx.fillStyle = imb >= 0 ? p.bid : p.ask; ctx.globalAlpha = state.highlight.on ? 0.3 + 0.65 * Math.min(1, Math.abs(imb) / 0.5) : 0.7;
        ctx.fillRect(x0, imb >= 0 ? mid - height : mid, Math.max(1, x1 - x0 - 0.4), Math.max(1, height));
      }
      ctx.globalAlpha = 1; ctx.strokeStyle = p.line; ctx.beginPath(); ctx.moveTo(0, mid + 0.5); ctx.lineTo(pw, mid + 0.5); ctx.stroke();
      const edge = `${Math.round(axis * 100)}%`;
      ctx.fillStyle = p.muted; ctx.fillText(`+${edge}`, this.w - AXIS_W + 6, 10); ctx.fillText('0', this.w - AXIS_W + 6, mid); ctx.fillText(`-${edge}`, this.w - AXIS_W + 6, ph - 8);
    }
    // Readout follows the cursor, else the newest point.
    let at = n - 1;
    if (state.hover) { at = 0; for (let i = 0; i < n; i++) if (s.times[i]! <= state.hover.t) at = i; }
    const b = s.bid[at]!, a = s.ask[at]!, total = b + a;
    // ≈: part of the line was worked out from the minutes' average books (a size filter, or minutes recorded before the tracker was kept: see the help).
    setHtml(readout, `${s.estimated ? '≈ ' : ''}${t('Bid')} <b class="bid">${usd(b)}</b> ${t('Ask')} <b class="ask">${usd(a)}</b> Δ <b>${usd(b - a)}</b> ${t('imb')} <b>${total > 0 ? Math.round((b - a) / total * 100) : 0}%</b> · ${tn(ids.length, '{n} venue', '{n} venues')}`);
    const over = state.hover && this.pointer ? readAt(slotAt(s.times, step, state.hover.t), state.hover.t, n - 1, s.times[n - 1]) : -1;
    if (over >= 0 && state.hover && state.hover.t >= s.times[over]! + step) this.cursorT = s.times[over]! + step / 2;
    if (over >= 0) this.#lines = ltCardLines({ time: s.times[over]!, bid: s.bid[over]!, ask: s.ask[over]!, halfLifeBp: lt.halfLifeBp, venues: ids.length });
  }
}

/** Strip under the chart with the enabled per-candle statistics, aligned to the candle slots (footprint on); the Stats button chooses, orders and configures them. */
export class BarStatsPane extends TimePane {
  /** The strip is too short for a popup drawn on it, so the cell's popup is a page element. */
  #card = new HoverCard();
  /** The cards of the pinned candles, page elements of their own beside the hover card: one each, kept for the next pin. */
  #pinCards: HoverCard[] = [];
  #cell: StatCell | null = null;
  /** The popup of the View column's cell under the pointer, when it is there. */
  #viewLines: InfoLine[] | null = null;
  /**
   * The candles pinned by a click (their starts, oldest pin first), and the market, the markets counted and the timeframe they were pinned on: each
   * shown with every statistic until it is clicked again, Esc is pressed, or any of those changes. A click pins one candle alone; a Shift+click adds
   * a candle to the others (or takes it away), up to `MAX_PINS`, to read them side by side. (Not Ctrl: Ctrl+drag selects a Range, and a Ctrl+click
   * would clear one.)
   */
  #pins: number[] = [];
  #pinsOn = '';
  #pinContext(state: AppState): string { return `${state.marketId}|${state.timeframe}|${this.heat.footprintMarkets(state).join(',')}`; }
  /**
   * Liquidations of the markets counted, every size the record keeps, by UTC day: each day asked on its own, so an answer holds a whole day
   * (BTC: 900 to 3,500) rather than the largest 5,000 of a week; the day under way asked again every half minute; two at a time, the newest first.
   */
  #liqDays = new Map<number, LiquidationDay & { at: number }>();
  #liqIds = '';
  #liqLoading = new Set<number>();
  #liqVersion = 0;
  /** A day whose question failed is asked again after its own pause, the others meanwhile. */
  #liqRetry = new Map<number, number>();
  #liqBuckets: { key: string; value: StatInput['liquidations'] } | null = null;
  #button = document.createElement('button');
  #panel: Panel | null = null;
  /** The open interest's change in USD, worked out once per set of bars, parts and candles (the pane paints on every pointer move), and only in USD. */
  #usd: { oi: unknown; parts: unknown; candles: unknown; price: number; tfMs: number; map: Map<number, number> } | null = null;
  #oiUsd(state: AppState, parts: readonly OiPart[], tfMs: number, candles: ReadonlyMap<number, CandleRow>): Map<number, number> | undefined {
    if (state.barStatOptions.oiUnits !== 'usd') return undefined;
    const held = this.#usd;
    if (held && held.oi === state.oi && held.parts === parts && held.candles === state.candles && held.price === state.oiPrice && held.tfMs === tfMs) return held.map;
    const map = oiUsdChangeByTime(state.oi, parts, tfMs, t => candles.get(t)?.[4], state.oiPrice);
    this.#usd = { oi: state.oi, parts, candles: state.candles, price: state.oiPrice, tfMs, map };
    return map;
  }
  constructor(host: HTMLElement, store: Store, view: View, private heat: HeatPane, private hub: Hub) {
    super(host, store, view, 'bars');
    this.head.innerHTML = `<strong>${t('Bar stats')}</strong><span class="readout"></span>`;
    this.head.querySelector('strong')!.after(helpButton('stats'));
    this.#button.textContent = t('Stats'); setTip(this.#button, t('Choose, order and configure the statistics shown for each candle'));
    this.#button.onclick = () => { this.#panel = togglePanel(this.#button, { title: t('Bar stats'), width: 440, align: 'right', onClose: () => { this.#panel = null; } }, (tools, body) => this.#build(tools, body)); };
    this.head.append(this.#button);
    this.canvas.addEventListener('click', e => this.#click(e));
    document.addEventListener('keydown', e => { if (e.key === 'Escape' && this.#pins.length) { this.#pins = []; this.invalidate(); } });
  }
  /** Redraw after the configuration changed and keep an open panel in step. */
  refresh(): void { this.#panel?.render((tools, body) => this.#build(tools, body)); this.invalidate(); }

  #build(tools: HTMLElement, body: HTMLElement): void {
    const state = this.store.state, options = state.barStatOptions;
    const chosen = enabledStats(state.barStats).map(def => def.id);
    const setStats = (ids: string[]) => this.store.set({ barStats: ids });
    const setOptions = (change: Partial<StatOptions>) => this.store.set({ barStatOptions: { ...this.store.state.barStatOptions, ...change } });

    for (const [label, ids] of [[t('Default'), PRESETS.default], [t('Order flow'), PRESETS.flow], [t('All'), PRESETS.all], [t('None'), PRESETS.none]] as const) tools.append(button(label, () => setStats([...ids])));
    const exportButton = button(t('Export CSV'), () => this.#export()); setTip(exportButton, t('Save the candles in view as a CSV file: one line per candle, a column per statistic shown.')); tools.append(exportButton);
    tools.append(el('span', { class: 'muted', textContent: t('{shown} of {total} shown', { shown: chosen.length, total: BAR_STATS.length }) }));

    body.append(heading(t('Sound')), panelSwitchRow(this.store, 'bars'));
    // Whose orders the table counts: the footprint's setting, so the two never need two loads and agree when both show.
    const fp = state.footprint, setMarkets = (markets: typeof fp.markets) => this.store.set({ footprint: { ...this.store.state.footprint, markets } });
    body.append(heading(t('Markets')),
      selectRow(t('Count'), t('Whose market orders the footprint and the bar statistics count.'), [['all', t('Aggregated: every market switched on')], ['chart', t('The chart market')], ['custom', t('Chosen markets')]], fp.markets, v => setMarkets(v === 'chart' || v === 'custom' ? v : 'all')),
      ...(fp.markets === 'custom' ? [marketPicker(this.store, this.hub.flow, 'footprint')] : []),
      note(t('The footprint counts the same markets: changing them here changes them there.')));
    body.append(heading(t('Shown, in order')));
    if (!chosen.length) body.append(note(t('Nothing selected: tick statistics below to add them.')));
    else {
      body.append(note(t('The strip shows them top to bottom in this order. Drag a row by its dots to reorder it (or focus the dots and press the up and down arrow keys); × hides it.')));
      body.append(sortableList(chosen.map(id => { const def = statDef(id)!; return { id, label: def.label, title: def.title }; }), setStats, id => setStats(chosen.filter(x => x !== id))));
    }

    for (const group of Object.keys(GROUP_TITLES) as StatGroup[]) {
      body.append(heading(GROUP_TITLES[group]));
      for (const def of BAR_STATS.filter(d => d.group === group))
        body.append(checkRow(def.label, def.title, chosen.includes(def.id), on => setStats(on ? [...chosen, def.id] : chosen.filter(id => id !== def.id))));
    }

    body.append(heading(t('Options')));
    body.append(
      selectRow(t('Cells'), t("Filled: shaded by size among the candles in view (log scale between the 2nd and 99th percentile). Unusual: shaded by how far each stands above its own recent candles, the Highlights' baseline, from 0 to 3σ. Line: each row drawn as a line. Text only: coloured by sign."),
        [['filled', t('Filled')], ['unusual', t('Unusual (σ)')], ['line', t('Line')], ['text', t('Text only')]], options.cells, v => setOptions({ cells: v as StatOptions['cells'] })),
      switchRow(t('Group rows by kind'), t('Gather the rows under a header per kind, in the order chosen within each; click a header to fold its rows away.'), options.grouped, grouped => setOptions({ grouped })),
      selectRow(t('CVD from'), t("Where cvd, cvd retail and cvd whales start: the chart's left edge, or each day's start in the chart's time zone (the day the left edge falls in is loaded whole)."),
        [['view', t('The left edge')], ['day', t("Each day's start")]], options.cvdFrom, v => setOptions({ cvdFrom: v === 'day' ? 'day' : 'view' })),
      selectRow(t('OI change in'), t("Open-interest change in base coin (the series' own unit) or as USD (change times the bar's close)"), [['base', t('Base coin')], ['usd', 'USD']], options.oiUnits, v => setOptions({ oiUnits: v as StatOptions['oiUnits'] })),
      numberRow(t('Imbalance ratio'), t('A level counts as imbalanced when its volume is at least this many times the opposite volume one row away'), { min: 1, step: 0.5, value: options.imbRatio }, v => setOptions({ imbRatio: v })),
      numberRow(t('Imbalance min USD'), t('Ignore imbalanced levels smaller than this'), { min: 0, step: scaledUsd(1000), value: scaledUsd(options.imbMinUsd) }, v => setOptions({ imbMinUsd: unscaledUsd(v) })),
      numberRow(t('Stacked rows'), t('Adjacent imbalanced rows on one side that count as a stack'), { min: 2, step: 1, value: options.stackedN }, v => setOptions({ stackedN: Math.round(v) })),
    );
    // Any size from the floor: under it the recording keeps one sum. Whales never start under retail; moving one past the other moves both.
    const floor = scaledUsd(SIZE_FLOOR_USD), presets = COMMON_SIZES.map(scaledUsd), below = t('From {min}: smaller orders are kept only as one sum.', { min: `$${sizeText(floor)}` });
    const now = () => this.store.state.barStatOptions;
    body.append(
      sizeRow(t('Retail'), t('Market orders under this size are retail (delta retail, cvd retail).'), { sign: '<', value: scaledUsd(options.retailUsd), presets, min: floor, max: scaledUsd(SIZE_MAX_USD), hint: below },
        v => { const r = unscaledUsd(v); setOptions({ retailUsd: r, whaleUsd: Math.max(now().whaleUsd, r) }); }),
      sizeRow(t('Whales'), t('Market orders of this size and over are whales (delta whales, cvd whales).'), { sign: '≥', value: scaledUsd(options.whaleUsd), presets, min: floor, max: scaledUsd(SIZE_MAX_USD), hint: below },
        v => { const w = unscaledUsd(v); setOptions({ whaleUsd: w, retailUsd: Math.min(now().retailUsd, w) }); }),
    );
  }

  protected draw(): void {
    this.#cell = null; this.#viewLines = null;
    const pins = this.#strip();
    const at = this.pointer, lines = this.#cell ? statCellLines(this.#cell) : this.#viewLines;
    if (lines && at) this.#card.show(lines, at.x, at.y); else this.#card.hide();
    this.#showPins(pins);
  }

  /** The cards of the pinned candles, left to right, each clear of the one before it (the candles may be a slot apart, and a card is a few hundred pixels wide). */
  #showPins(pins: readonly { lines: InfoLine[]; x: number; y: number }[]): void {
    while (this.#pinCards.length < pins.length) this.#pinCards.push(new HoverCard());
    let free = -Infinity;
    pins.forEach((pin, i) => { const card = this.#pinCards[i]!; card.show(pin.lines, Math.max(pin.x, free), pin.y); free = card.right + 6 - CARD_GAP; });
    for (let i = pins.length; i < this.#pinCards.length; i++) this.#pinCards[i]!.hide();
  }

  protected override undrawn(): void { this.#cell = null; this.#viewLines = null; this.#card.hide(); for (const card of this.#pinCards) card.hide(); }

  /** What the table worked out last, kept while nothing it was worked out from changes (a pointer move only redraws), and what Export CSV writes. */
  #table: { key: unknown[]; times: number[]; defs: StatDef[]; values: (number | null)[][]; input: StatInput; view: { at: string; cells: (ViewCell | null)[] } | null } | null = null;
  /** Where the View column is (plot coordinates), while it is drawn: the pointer there reads it, not a candle. */
  #viewSpan: [number, number] | null = null;
  /** The bands as last drawn, top to bottom (what a click on a header folds). */
  #layout: { band: TableBand; y: number; h: number }[] = [];
  protected override ownsPoint(x: number): boolean { return !!this.#viewSpan && x >= this.#viewSpan[0] && x <= this.#viewSpan[1]; }

  /** A click on a kind's header folds or unfolds its rows; on a candle it pins it alone (on the pinned one, lets it go), and with Shift it adds it to the pinned ones. Not while the Range tool selects. */
  #click(e: MouseEvent): void {
    const state = this.store.state;
    if (this.rangeGesture || e.ctrlKey || e.metaKey || state.rangeTool) { this.rangeGesture = false; return; }
    const box = this.canvas.getBoundingClientRect(), x = e.clientX - box.left - leftGutter(state), y = e.clientY - box.top;
    const hit = this.#layout.find(b => y >= b.y && y < b.y + b.h);
    if (hit?.band.kind === 'head') {
      const group = hit.band.group, folded = state.barStatOptions.folded;
      this.store.set({ barStatOptions: { ...state.barStatOptions, folded: folded.includes(group) ? folded.filter(g => g !== group) : [...folded, group] } });
      return;
    }
    const table = this.#table, tfMs = TIMEFRAMES[state.timeframe] ?? 3_600_000;
    if (!table || x < 0 || x > this.plotW) return;
    const at = this.view.tOf(x, this.plotW), start = table.times.find(s => at >= s && at < s + tfMs);
    if (start === undefined) return;
    const on = this.#pinContext(state);
    if (this.#pinsOn !== on) this.#pins = [];
    this.#pinsOn = on;
    this.#pins = pinsAfterClick(this.#pins, start, e.shiftKey);
    this.invalidate();
  }

  /**
   * Ask for the UTC days of [from, to) not held, and again a day not answered to its end (the day under way, or one asked before its midnight)
   * once what is held of it is half a minute old.
   */
  #ensureLiquidations(ids: string, from: number, to: number): void {
    const source = this.hub.source; if (!source.liquidations) return;
    // Other markets counted: what is held is not theirs, and an answer still out for the old ones is dropped when it comes.
    if (ids !== this.#liqIds) { this.#liqIds = ids; this.#liqDays = new Map(); this.#liqRetry = new Map(); this.#liqVersion++; }
    const now = Date.now();
    for (let day = Math.floor((to - 1) / DAY_MS) * DAY_MS; day >= Math.floor(from / DAY_MS) * DAY_MS && this.#liqLoading.size < 2; day -= DAY_MS) {
      const held = this.#liqDays.get(day);
      if (this.#liqLoading.has(day) || now < (this.#liqRetry.get(day) ?? 0) || (held && (held.to >= day + DAY_MS || now - held.at < 30_000))) continue;
      this.#liqLoading.add(day);
      const asked = Date.now();
      source.liquidations(day, day + DAY_MS).then(rows => {
        if (ids !== this.#liqIds) return;
        this.#liqRetry.delete(day);
        this.#liqDays.set(day, { rows, cut: rows.length >= LIQUIDATIONS_PER_ANSWER, to: Math.min(day + DAY_MS, asked), at: Date.now() }); this.#liqVersion++;
      }, () => { if (ids === this.#liqIds) this.#liqRetry.set(day, Date.now() + 15_000); })
        // Drawn again whatever came back: the slot it held is free for the next day, an answer dropped for other markets included.
        .finally(() => { this.#liqLoading.delete(day); this.invalidate(); });
    }
    // Only the days around the window are kept.
    for (const day of [...this.#liqDays.keys()]) if (day + DAY_MS < from - DAY_MS || day > to + DAY_MS) this.#liqDays.delete(day);
  }

  /** The liquidations by candle over the table's candles, from the days answered (kept while neither they nor the candles change). */
  #liquidationsFor(ids: readonly string[], times: readonly number[], tfMs: number, coverFrom: number): StatInput['liquidations'] {
    if (ids.join(',') !== this.#liqIds) return undefined;
    // By the minute too: the candle under way counts once the minute it starts in has been asked about.
    const key = `${this.#liqVersion}|${this.#liqIds}|${times[0]}|${times.length}|${times[times.length - 1]}|${tfMs}|${coverFrom}|${Math.floor(Date.now() / 60_000)}`;
    if (this.#liqBuckets?.key === key) return this.#liqBuckets.value;
    const value = liquidationBuckets(this.#liqDays, ids, times, tfMs, coverFrom, Date.now());
    this.#liqBuckets = { key, value };
    return value;
  }

  #strip(): { lines: InfoLine[]; x: number; y: number }[] {
    const { ctx, palette: p, view: v } = this, pw = this.plotW, ph = this.h, state = this.store.state;
    const tfMs = TIMEFRAMES[state.timeframe] ?? 3_600_000, defs = enabledStats(state.barStats), options = state.barStatOptions;
    const readout = this.head.querySelector('.readout'), data = this.heat.footprintData, daily = options.cvdFrom === 'day';
    // Aggregated, the rows count every market the footprint adds together; open interest stays the OI pane's one market (as its row's tip says).
    const markets = this.heat.footprintMarkets(state), stats = daily
      ? tn(defs.length, "{n} stat · cvd from each day's start", "{n} stats · cvd from each day's start")
      : tn(defs.length, '{n} stat · cvd sums the bars loaded for the view', '{n} stats · cvd sums the bars loaded for the view');
    // The size of the rows the footprint rows of the table (poc, imbalances) are read on: the footprint's at this zoom, whether it shows or not.
    const rowSize = data.step > 0 ? ` · ${t('rows of {step}', { step: `$${fmtPrice(data.step, data.step)}` })}` : '';
    setText(readout, (markets.length > 1 ? `${t('{n} markets', { n: markets.length })} · ${stats}` : stats) + rowSize);
    this.#viewSpan = null; this.#layout = [];
    if (!defs.length) { ctx.fillStyle = p.muted; ctx.fillText(t('No statistics selected: use Stats to add some.'), 12, ph / 2); this.#table = null; return []; }
    // Replay: only the candles that ended by its moment (a candle under way would carry its future executions).
    // The candles of the view and one each side (what the footprint asks for), not every bar it still holds: the running sums (cvd) start at the
    // view, whatever was looked at before; from each day's start, at the start of the day the left edge falls in (loaded whole for it).
    const zone = resolveZone('page', state.timeZone), from = daily ? Math.min(v.t0, dayStartOf(v.t0, zone)) : v.t0;
    const now = pageNow(), until = replaying() ? now : Infinity, near = (start: number): boolean => start + tfMs <= until && start + 2 * tfMs > from && start < v.t1 + tfMs;
    // One slot per candle: the chart's candles, and a bar the footprint holds where a candle is missing. A candle without executions (before the
    // recording, a gap) is a slot without a bar: the rows read from the candles and open interest still show there.
    const starts = new Set<number>();
    for (const c of state.candles) if (near(c[0])) starts.add(c[0]);
    for (const b of data.bars.values()) if (near(b.t)) starts.add(b.t);
    const times = [...starts].sort((a, b) => a - b);
    if (!times.length) { ctx.fillStyle = p.muted; ctx.fillText(t('Bar stats appear once executions are recorded for the visible candles.'), 12, ph / 2); this.#table = null; return []; }
    const parts = oiPartsUntil(state.oiParts, tfMs, replaying() ? Math.floor(now / tfMs) * tfMs : Infinity);
    // The exchange's own candles (Binance's): the candle delta and the fills read them.
    const taker = defs.some(def => def.id === 'takerDelta' || def.id === 'fills' || def.id === 'avgFill') ? this.heat.takerRows(state, tfMs, times[0]!) : null;
    // Liquidations of the markets counted, a UTC day per answer, over the days of the table's candles (none after now). A candle before the
    // record reaches is not known: the source keeps a week (a page's own engine a day), and only since the recording started. The edge is
    // taken to the next whole minute (a candle half expired is not known either), which also keeps it from changing on every frame.
    const retention = this.hub.source.kind === 'browser' ? BROWSER_RETENTION_MS : LIQUIDATION_RETENTION_MS;
    const liqTo = Math.min(times[times.length - 1]! + tfMs, Date.now()), liqCover = Math.max(Math.ceil((Date.now() - retention) / 60_000) * 60_000, this.hub.recordedSince > 0 ? this.hub.recordedSince : 0);
    let liquidations: StatInput['liquidations'];
    if (this.hub.source.liquidations && defs.some(def => def.id === 'liq' || def.id === 'liqNet') && markets.length) {
      this.#ensureLiquidations(markets.join(','), Math.max(times[0]!, liqCover), liqTo);
      liquidations = this.#liquidationsFor(markets, times, tfMs, liqCover);
    }
    const restart = daily ? resetKeys(times, 'day', zone) : undefined;
    // Worked out again only when what it is worked out from changes: a pointer move redraws from what is held. The clock counts by the minute
    // (the coverage of the candle under way).
    const key = [data.version, data.step, state.candles, state.oi, parts, state.oiPrice, state.barStats, options, data.cuts, taker, liquidations, zone, times[0], times[times.length - 1], times.length, tfMs, Math.floor(now / 60_000)];
    let table = this.#table;
    if (!table || table.key.length !== key.length || table.key.some((k, i) => k !== key[i])) {
      const candles = new Map(state.candles.map(c => [c[0], c] as const));
      const input: StatInput = { bars: times.map(start => data.bars.get(start) ?? null), times, tfMs, now, ...(taker ? { taker } : {}), ...(liquidations ? { liquidations } : {}), ...(restart ? { restart } : {}),
        step: data.step, options, cuts: data.cuts, candles, oi: new Map(state.oi.map(b => [b[0], b] as const)), oiChange: oiChangeByTime(state.oi, parts, tfMs), oiUsd: this.#oiUsd(state, parts, tfMs, candles) };
      table = this.#table = { key, times, defs, values: defs.map(def => def.compute(input)), input, view: null };
    }
    const { input, values: rowsValues } = table, all = input.bars;
    // A row taken at the nearest box edge for some bar (the source had no sums for the size set), or from a cut answer, says so: ≈ before its name.
    const labelOf = new Map(defs.map(def => [def.id, def.approx?.(input) ? `≈${def.label}` : def.label]));
    // The bands: rows as chosen, or under a header per kind; the rows share what the headers leave.
    const bands = tableBands(defs, options), rowCount = bands.filter(b => b.kind === 'row').length, top = 3;
    const rowH = Math.max(15, (ph - 6 - (bands.length - rowCount) * HEAD_H) / Math.max(1, rowCount));
    let y0 = top;
    const layout = this.#layout = bands.map(band => { const h = band.kind === 'head' ? HEAD_H : rowH, at = { band, y: y0, h }; y0 += h; return at; });
    const gridBottom = y0, slot = pw * tfMs / (v.t1 - v.t0), cells = options.cells, filled = cells === 'filled' || cells === 'unusual';
    const visible = times.map((_, i) => i).filter(i => times[i]! + tfMs > v.t0 && times[i]! < v.t1);
    if (!visible.length) { ctx.fillStyle = p.muted; ctx.fillText(t('No executions recorded for the candles in view.'), 12, ph / 2); return []; }
    // A candle the recording holds only in part: the rows read from executions are drawn faint there (rec % says how much).
    const partial = all.map((bar, i) => { const share = bar ? coverageOf(bar, times[i]!, tfMs, now) : null; return share !== null && share < 0.95; });
    // Under the pointer: the candle (any pane's pointer says which, the time axis being shared) and, from this pane's own pointer, the band; or,
    // right of the plot, the band's View figure.
    const vx = pw + 3, vw = Math.min(this.w - pw - 6, 120);
    this.#viewSpan = vw >= 24 ? [vx, vx + vw] : null;
    const box = this.pointer ? this.canvas.getBoundingClientRect() : null, local = box ? this.pointer!.x - box.left - leftGutter(state) : -1, overView = this.ownsPoint(local);
    const bandAt = (y: number): number => layout.findIndex(b => y >= b.y && y < b.y + b.h);
    const hv = state.hover, viewBand = overView && box ? bandAt(this.pointer!.y - box.top) : -1;
    const under = hv && !overView ? times.findIndex(start => hv.t >= start && hv.t < start + tfMs) : -1;
    // Past the newest candle this pane's own pointer reads the newest (readAt); another pane's pointer there marks nothing here.
    const hoverIdx = overView ? -1 : hv && this.pointer ? readAt(under, hv.t, times.length - 1, times[times.length - 1]!) : under;
    if (hoverIdx >= 0 && hoverIdx !== under) this.cursorT = times[hoverIdx]! + tfMs / 2;
    const hoverBand = hv && hv.source === 'bars' ? bandAt(hv.y) : -1;
    let hoverCell: StatCell | null = null, viewHover: InfoLine[] | null = null;
    const toneColor = (tone: StatTone | null): string => tone === 'buy' ? p.candleUp : tone === 'sell' ? p.candleDown : p.muted;
    const toneOf = (def: StatDef, value: number): StatTone => def.scale === 'category' ? def.tone?.(value) ?? 'text' : def.scale === 'diverging' ? (value - (def.center ?? 0) >= 0 ? 'buy' : 'sell') : 'text';
    const shown = (def: StatDef, value: number | null | undefined): string => value === null || value === undefined ? '–' : def.format(value) || (def.id === 'cover' ? '100%' : '—');
    ctx.textBaseline = 'middle'; ctx.textAlign = 'center'; ctx.font = '11px ui-monospace, SFMono-Regular, Menlo, monospace';
    layout.forEach(({ band, y, h }, bandIndex) => {
      if (band.kind === 'head') {
        // A kind's header across the table: ▾ open, ▸ folded with how many rows it holds; a click folds or unfolds it.
        ctx.save(); ctx.fillStyle = mixHex(p.panel, p.ui, bandIndex === hoverBand || bandIndex === viewBand ? 0.24 : 0.14); ctx.fillRect(0, y, this.w, h - 1);
        ctx.textAlign = 'left'; ctx.font = '600 10px ui-sans-serif, system-ui, sans-serif'; ctx.fillStyle = p.muted;
        ctx.fillText(`${band.folded ? '▸' : '▾'} ${GROUP_SHORT[band.group]}${band.folded ? ` · ${band.count}` : ''}`, 6, y + (h - 1) / 2);
        ctx.restore();
        return;
      }
      const { def, index: rowIndex } = band, values = rowsValues[rowIndex]!, ranked = def.scale !== 'plain' && def.scale !== 'category', scale = ranked ? rowScale(def, visible.map(i => values[i])) : null;
      // Each row's own baseline (the Highlights' window and multiple): its unusual candles are outlined while Highlights is on, and Unusual shades by it.
      const found = ranked && (state.highlight.on || cells === 'unusual') ? anomalies(Float64Array.from(values, value => value === null || value === undefined ? NaN : deviation(def, value)), state.highlight) : null;
      const unusual = state.highlight.on ? found?.flag ?? null : null;
      const mine = hoverIdx >= 0 && bandIndex === hoverBand ? values[hoverIdx] : undefined;
      if (hoverIdx >= 0 && bandIndex === hoverBand && mine !== null && mine !== undefined) {
        const previous = hoverIdx > 0 && times[hoverIdx - 1] === times[hoverIdx]! - tfMs ? values[hoverIdx - 1] : null;
        const seenValues = visible.map(i => values[i]).filter((x): x is number => x !== null && x !== undefined), rank = (x: number) => def.scale === 'diverging' ? deviation(def, x) : x;
        const share = all[hoverIdx] ? coverageOf(all[hoverIdx]!, times[hoverIdx]!, tfMs, now) : null;
        const sigma = found?.sigma[hoverIdx];
        hoverCell = {
          label: labelOf.get(def.id)!, title: def.approx?.(input) ? `${def.title} ${def.approxNote?.() ?? t('≈ About: for some of these minutes only the size boxes are known (an older server, or minutes it has not filled in yet), so this line is drawn at the nearest box edge.')}` : def.title,
          value: shown(def, mine), tone: toneOf(def, mine), time: clock(times[hoverIdx]!, true),
          previous: previous === null || previous === undefined ? null : shown(def, previous), rank: ranked ? 1 + seenValues.filter(x => rank(x) > rank(mine)).length : null, of: seenValues.length,
          sigma: (unusual?.[hoverIdx] || cells === 'unusual') && sigma !== undefined && Number.isFinite(sigma) && sigma > 0 ? sigma : null,
          partial: def.source === 'executions' && share !== null && share < 0.95 ? Math.round(share * 100) : null,
        };
      }
      if (!filled) { ctx.globalAlpha = 0.5; ctx.strokeStyle = p.line; ctx.beginPath(); ctx.moveTo(0, Math.round(y + h - 1) + 0.5); ctx.lineTo(pw, Math.round(y + h - 1) + 0.5); ctx.stroke(); ctx.globalAlpha = 1; }
      if (cells === 'line' && def.scale !== 'category') { this.#line(def, values, visible, times, y, h, slot, partial, unusual); return; }
      for (const i of visible) {
        const x = v.xOf(times[i]!, pw), w = Math.max(1, slot - 1), value = values[i], fade = def.source === 'executions' && partial[i] ? 0.45 : 1;
        if (value === null || value === undefined) {
          if (filled) { ctx.globalAlpha = 0.5; ctx.fillStyle = p.line; ctx.fillRect(x, y, w, h - 1); ctx.globalAlpha = 1; }
          if (slot >= 48) { ctx.fillStyle = p.muted; ctx.fillText('–', x + w / 2, y + (h - 1) / 2); }
          continue;
        }
        if (def.scale === 'category') {
          // A mark per candle: tinted by the side it stands for, empty where there is nothing to mark.
          const mark = def.format(value), tone = mark ? def.tone?.(value) ?? null : null, fill = tone ? mixHex(p.panel, toneColor(tone), 0.32) : p.panel;
          ctx.globalAlpha = fade;
          if (filled || cells === 'line') { ctx.fillStyle = fill; ctx.fillRect(x, y, w, h - 1); }
          if (mark && ctx.measureText(mark).width <= w - 2) { ctx.fillStyle = (filled || cells === 'line') && tone ? textOn(fill, 1, p) : toneColor(tone); ctx.fillText(mark, x + w / 2, y + (h - 1) / 2); }
          ctx.globalAlpha = 1;
          continue;
        }
        // Unusual: how far above its own recent candles, from 0 to 3σ (none while the baseline warms up); else its size among the candles in view.
        const sigma = found?.sigma[i];
        // A value flagged against a flat baseline (no spread, so no σ) is as unusual as a value can be.
        const t = cells === 'unusual' ? (found?.flag[i] && !(sigma! > 0) ? 1 : sigma !== undefined && Number.isFinite(sigma) ? Math.min(1, Math.max(0, sigma) / 3) : 0) : strength(def, value, scale), tone = (value - (def.center ?? 0)) >= 0 ? p.candleUp : p.candleDown;
        // A filled cell takes its colours from the theme (the page's own colour toward its accent, or toward the side's colour) and its figures
        // from textOn: a fixed light ramp made a row of pale bars on every dark theme.
        const fill = def.scale === 'sequential' ? mixHex(p.panel, p.ui, 0.12 + 0.76 * t) : def.scale === 'diverging' ? mixHex(mixHex(p.panel, tone, 0.18), tone, t) : p.panel;
        if (filled) {
          ctx.globalAlpha = fade; ctx.fillStyle = fill;
          ctx.fillRect(x, y, w, h - 1);
          if (def.scale === 'plain') { ctx.strokeStyle = p.line; ctx.strokeRect(x + 0.5, y + 0.5, w - 1, h - 2); }
          ctx.globalAlpha = 1;
        }
        if (unusual?.[i]) { ctx.save(); ctx.lineWidth = 1.6; ctx.strokeStyle = p.text; ctx.globalAlpha = 0.95 * fade; ctx.strokeRect(x + 0.8, y + 0.8, Math.max(1, w - 1.6), h - 2.6); ctx.restore(); }
        if (slot >= 48) {
          ctx.fillStyle = filled ? (def.scale === 'plain' ? p.text : textOn(fill, 1, p)) : def.scale === 'diverging' ? tone : p.text;
          ctx.globalAlpha = (filled ? 1 : 0.6 + 0.4 * t) * fade;
          ctx.fillText(def.format(value), x + w / 2, y + (h - 1) / 2); ctx.globalAlpha = 1;
        }
      }
    });
    const hovered = hoverBand >= 0 ? layout[hoverBand] : undefined;
    // The cell under the pointer: its column and row tinted, the cell itself boxed, and a popup beside the pointer.
    if (hoverIdx >= 0) {
      const x = v.xOf(times[hoverIdx]!, pw), w = Math.max(1, slot - 1);
      ctx.save(); ctx.fillStyle = p.text; ctx.globalAlpha = p.dark ? 0.12 : 0.08; ctx.fillRect(x, top, w, gridBottom - top);
      if (hovered?.band.kind === 'row') {
        ctx.fillRect(0, hovered.y, pw, hovered.h - 1);
        ctx.globalAlpha = 1; ctx.strokeStyle = p.text; ctx.lineWidth = 1; ctx.strokeRect(Math.round(x) + 0.5, Math.round(hovered.y) + 0.5, Math.max(1, Math.round(w) - 1), Math.round(hovered.h) - 2);
      } else { ctx.globalAlpha = 0.5; ctx.strokeStyle = p.text; ctx.lineWidth = 1; ctx.strokeRect(Math.round(x) + 0.5, top + 0.5, Math.max(1, Math.round(w) - 1), gridBottom - top - 1); }
      ctx.restore();
      this.#cell = hoverCell;
    }
    // The pinned candles: each column boxed, and a card of every statistic beside it (gone with it out of view, back with it), left to right.
    if (this.#pinsOn !== this.#pinContext(state)) this.#pins = [];
    const pins: { lines: InfoLine[]; x: number; y: number }[] = [];
    for (const start of this.#pins) {
      const pinIdx = times.indexOf(start);
      if (pinIdx < 0 || !visible.includes(pinIdx)) continue;
      const x = v.xOf(times[pinIdx]!, pw), w = Math.max(1, slot - 1);
      ctx.save(); ctx.strokeStyle = p.text; ctx.lineWidth = 2; ctx.strokeRect(Math.round(x) + 1, top + 1, Math.max(1, Math.round(w) - 2), gridBottom - top - 2); ctx.restore();
      const page = this.canvas.getBoundingClientRect();
      pins.push({ lines: pinnedLines(clock(times[pinIdx]!, true), defs.map((def, r) => { const value = rowsValues[r]![pinIdx]; return { label: labelOf.get(def.id)!, value: shown(def, value), tone: value === null || value === undefined ? 'text' : toneOf(def, value) }; })),
        x: page.left + leftGutter(state) + x + w, y: page.top });
    }
    pins.sort((a, b) => a.x - b.x);
    // The View column, right of the plot under the price axis and the columns: each row over the candles in view (its tip says how).
    if (this.#viewSpan) {
      // Worked out again only for other candles in view or other figures (a pointer move redraws from what is held).
      const at = `${visible[0]}|${visible[visible.length - 1]}|${visible.length}`;
      if (table.view?.at !== at) table.view = { at, cells: defs.map((def, r) => def.view?.(input, visible, rowsValues[r]!) ?? null) };
      const viewCells = table.view.cells;
      ctx.save();
      ctx.globalAlpha = 0.6; ctx.strokeStyle = p.line; ctx.beginPath(); ctx.moveTo(Math.round(pw) + 0.5, top); ctx.lineTo(Math.round(pw) + 0.5, gridBottom); ctx.stroke(); ctx.globalAlpha = 1;
      layout.forEach(({ band, y, h }, bandIndex) => {
        if (band.kind !== 'row') return;
        const def = band.def, cell = viewCells[band.index] ?? null;
        const fill = cell && cell.tone !== 'text' ? mixHex(p.panel, toneColor(cell.tone), 0.22) : mixHex(p.panel, p.ui, 0.08);
        ctx.fillStyle = fill; ctx.fillRect(vx, y, vw, h - 1);
        if (cell) {
          let size = 11; ctx.font = `${size}px ui-monospace, SFMono-Regular, Menlo, monospace`;
          while (size > 8 && ctx.measureText(cell.value).width > vw - 4) { size--; ctx.font = `${size}px ui-monospace, SFMono-Regular, Menlo, monospace`; }
          if (ctx.measureText(cell.value).width <= vw - 2) { ctx.fillStyle = textOn(fill, 1, p); ctx.fillText(cell.value, vx + vw / 2, y + (h - 1) / 2); }
        }
        if (bandIndex === viewBand) {
          ctx.strokeStyle = p.text; ctx.lineWidth = 1; ctx.strokeRect(Math.round(vx) + 0.5, Math.round(y) + 0.5, Math.round(vw) - 1, Math.round(h) - 2);
          viewHover = viewCellLines(labelOf.get(def.id)!, cell, def.title, visible.length);
        }
      });
      ctx.restore();
    }
    if (viewHover) this.#viewLines = viewHover;
    ctx.textAlign = 'left'; ctx.font = '10px ui-sans-serif, system-ui, sans-serif';
    for (const { band, y, h } of layout) {
      if (band.kind !== 'row') continue;
      const label = labelOf.get(band.def.id)!, w = ctx.measureText(label).width + 10;
      ctx.globalAlpha = 0.88; ctx.fillStyle = p.panel; ctx.fillRect(2, y + 2, w, h - 5); ctx.globalAlpha = 1; ctx.fillStyle = p.muted; ctx.fillText(label, 6, y + (h - 1) / 2);
    }
    return pins;
  }

  /**
   * Line: a row drawn as a line through its candles (broken where one has no value), on its own scale: a share around 50 % or a signed figure
   * about its centre line, with each candle's side shaded from it, and the rest from their lowest to their highest in view. Unusual candles get
   * a ring while Highlights is on.
   */
  #line(def: StatDef, values: readonly (number | null)[], visible: readonly number[], times: readonly number[], y: number, h: number, slot: number, partial: readonly boolean[], unusual: Uint8Array | null): void {
    const { ctx, palette: p, view: v } = this, pw = this.plotW, center = def.center ?? 0, seenValues = visible.flatMap(i => { const x = values[i]; return x === null || x === undefined ? [] : [x]; });
    if (!seenValues.length) return;
    const diverging = def.scale === 'diverging', reach = diverging ? Math.max(...seenValues.map(x => Math.abs(x - center))) || 1 : 0;
    const lo = Math.min(...seenValues), hi = Math.max(...seenValues), span = hi - lo || 1, pad = 3;
    const yOf = (x: number): number => diverging ? y + h / 2 - (x - center) / reach * (h / 2 - pad) : y + h - pad - (x - lo) / span * (h - 2 * pad);
    ctx.save();
    if (diverging) {
      ctx.globalAlpha = 0.5; ctx.strokeStyle = p.line; ctx.beginPath(); ctx.moveTo(0, Math.round(y + h / 2) + 0.5); ctx.lineTo(pw, Math.round(y + h / 2) + 0.5); ctx.stroke();
      for (const i of visible) {
        const x = values[i]; if (x === null || x === undefined) continue;
        const left = v.xOf(times[i]!, pw), w = Math.max(1, slot * 0.6), top = Math.min(yOf(x), y + h / 2);
        ctx.globalAlpha = 0.35 * (def.source === 'executions' && partial[i] ? 0.5 : 1); ctx.fillStyle = x >= center ? p.candleUp : p.candleDown;
        ctx.fillRect(left + (slot - w) / 2, top, w, Math.abs(yOf(x) - (y + h / 2)));
      }
    }
    ctx.globalAlpha = 0.9; ctx.strokeStyle = diverging ? p.text : p.ui; ctx.lineWidth = 1.4; ctx.beginPath();
    let open = false;
    for (const i of visible) {
      const x = values[i];
      if (x === null || x === undefined) { open = false; continue; }
      const px = v.xOf(times[i]!, pw) + slot / 2, py = yOf(x);
      if (open) ctx.lineTo(px, py); else { ctx.moveTo(px, py); open = true; }
    }
    ctx.stroke();
    // A value with none beside it (zoomed to one candle, or between gaps) is a dot, not a line of no length.
    ctx.fillStyle = diverging ? p.text : p.ui;
    visible.forEach((i, k) => {
      const x = values[i], before = k > 0 ? values[visible[k - 1]!] : null, after = k < visible.length - 1 ? values[visible[k + 1]!] : null;
      if (x === null || x === undefined || (before !== null && before !== undefined) || (after !== null && after !== undefined)) return;
      ctx.beginPath(); ctx.arc(v.xOf(times[i]!, pw) + slot / 2, yOf(x), 2, 0, Math.PI * 2); ctx.fill();
    });
    if (unusual) for (const i of visible) {
      const x = values[i]; if (!unusual[i] || x === null || x === undefined) continue;
      ctx.globalAlpha = 1; ctx.strokeStyle = p.text; ctx.lineWidth = 1.4; ctx.beginPath(); ctx.arc(v.xOf(times[i]!, pw) + slot / 2, yOf(x), 3, 0, Math.PI * 2); ctx.stroke();
    }
    ctx.restore();
  }

  /** Export CSV: the table's candles in view, one line each, every statistic shown as its number or its mark (empty where it has none). */
  #export(): void {
    const table = this.#table, shown = enabledStats(this.store.state.barStats);
    // Only a table of the statistics now chosen (one held from before a change is not written).
    if (!table || table.defs.length !== shown.length || table.defs.some((def, i) => def !== shown[i])) return;
    const v = this.view, tfMs = TIMEFRAMES[this.store.state.timeframe] ?? 3_600_000;
    const at = table.times.map((_, i) => i).filter(i => table.times[i]! + tfMs > v.t0 && table.times[i]! < v.t1);
    if (!at.length) return;
    const lines = [['candle_start_utc', ...table.defs.map(def => def.csv?.head ?? def.id)].join(',')];
    for (const i of at) lines.push([new Date(table.times[i]!).toISOString(), ...table.values.map((row, r) => csvCell(table.defs[r]!, row[i]))].join(','));
    const name = `bar-stats-${this.store.state.marketId.replace(/[^A-Za-z0-9]+/g, '-')}-${this.store.state.timeframe}-${new Date(table.times[at[at.length - 1]!]!).toISOString().slice(0, 16).replace(/[-:]/g, '')}Z.csv`;
    // With a byte-order mark, so a spreadsheet reads the marks (▲, −) as UTF-8.
    const url = URL.createObjectURL(new Blob([`\ufeff${lines.join('\n')}\n`], { type: 'text/csv' })), link = el('a', { href: url, download: name });
    document.body.append(link); link.click(); link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
  }
}
