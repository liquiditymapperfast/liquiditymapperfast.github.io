import { PALETTES } from '../theme.ts';
import { setTip } from '../tip.ts';
import { helpButton } from '../help.ts';
import { TIMEFRAMES, type Hub } from '../hub.ts';
import { DEFAULT_BAR_STATS, type Store, type AppState, type OiBar } from '../store.ts';
import { oiDeltas } from '../oi-change.ts';
import { anomalies, type HighlightOptions } from '../anomaly.ts';
import { venueLabel } from '../venues.ts';
import { activeIds, emptyScopeMessage } from '../scope.ts';
import type { View } from '../view.ts';
import { clock, price as fmtPrice, usd } from '../format.ts';
import { gutter, timeTicks, AXIS_W, type HeatPane } from './heat-pane.ts';
import { BAR_STATS, GROUP_TITLES, PRESETS, sizeBucketLabels, enabledStats, rowScale, statCellLines, statDef, strength, type StatCell, type StatGroup } from './bar-stats.ts';
import { HoverCard } from '../hovercard.ts';
import type { InfoLine } from '../infobox.ts';
import { barAt, columnAt, depthCardLines, depthColumns, depthKey, imbalanceFlags, ltCardLines, oiCardLines, oiTail, readAt, slotAt } from './pane-cards.ts';
import type { StatOptions } from '../stat-options.ts';
import { el } from '../dom.ts';
import { button, checkRow, heading, note, numberRow, selectRow, sortableList, togglePanel, type Panel } from '../ui.ts';
import type { LtSeries } from '../lt.ts';
import { GestureRecognizer, bindTouch, type GestureHandlers, type Pt } from '../touch.ts';
import { panelSwitchRow, panelSwitchOn, setPanelSwitch } from '../sound/panel.ts';
import { t, tn } from '../i18n.ts';
import { scaledUsd, unscaledUsd } from '../coin.ts';
import { DRAG_MIN_PX, selects } from '../range/selection.ts';
import type { RangeTool } from '../range/tool.ts';
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
  protected w = 0; protected h = 0; protected dpr = 1;
  protected palette = PALETTES.light!;
  #frame = 0;
  /** What the map does with a gesture on the time axis these panes share with it (set by `useTimeGestures`). */
  #time: ReturnType<HeatPane['timeGestures']> | null = null;
  #pinned: Pt | null = null;
  #source: 'depth' | 'oi' | 'lt' | 'bars' | 'delta';
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
    const source = this.#source = cls as 'depth' | 'oi' | 'lt' | 'bars' | 'delta';
    // A drag across a pane selects a stretch of time for the Range tool while it is armed, or with Ctrl (Cmd on a Mac) held.
    this.canvas.addEventListener('pointerdown', e => {
      if (e.pointerType === 'touch' || !this.#range) return;
      const x = e.clientX - this.canvas.getBoundingClientRect().left;
      if (!selects(this.#range.armed, e) || x < 0 || x > this.plotW) return;
      this.#selecting = { x }; this.#range.begin({ t: this.#timeAt(x), p: null }); this.canvas.setPointerCapture(e.pointerId);
    });
    this.canvas.addEventListener('pointerup', e => {
      const sel = this.#selecting; if (!sel || !this.#range) return;
      const x = e.clientX - this.canvas.getBoundingClientRect().left; this.#selecting = null;
      this.#range.end({ t: this.#timeAt(x), p: null }, Math.abs(x - sel.x) < DRAG_MIN_PX);
      if (this.canvas.hasPointerCapture(e.pointerId)) this.canvas.releasePointerCapture(e.pointerId);
    });
    this.canvas.addEventListener('pointermove', e => {
      if (e.pointerType === 'touch') return;
      const r = this.canvas.getBoundingClientRect(), x = e.clientX - r.left, y = e.clientY - r.top;
      this.pointer = { x: e.clientX, y: e.clientY };
      if (this.#selecting) this.#range?.move({ t: this.#timeAt(x), p: null });
      this.canvas.style.cursor = this.#range?.armed && x <= this.plotW ? 'crosshair' : '';
      if (x < 0) { this.store.set({ hover: null }); return; }
      // Over the price axis the pointer reads the right edge of the plot, so a pane past its newest point keeps showing that (readAt).
      this.store.set({ hover: { t: this.view.tOf(Math.min(x, this.plotW), this.plotW), price: null, y, source } });
    });
    this.canvas.addEventListener('pointerleave', e => { if (e.pointerType !== 'touch') { this.pointer = null; this.store.set({ hover: null }); } });
    bindTouch(this.canvas, new GestureRecognizer(this.#touchHandlers()));
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
      const box = this.canvas.getBoundingClientRect(); this.pointer = { x: box.left + p.x, y: box.top + p.y };
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
  /** Header element, the grip target for drag-reordering. */
  get header(): HTMLElement { return this.head; }
  get plotW(): number { return Math.max(1, this.w - gutter(this.store.state)); }
  setPalette(name: string): void { this.palette = PALETTES[name] ?? PALETTES.light!; this.invalidate(); }
  invalidate(): void { if (!this.#frame) this.#frame = requestAnimationFrame(() => { this.#frame = 0; this.#prepare(); }); }
  #resize(): void {
    const r = this.canvas.getBoundingClientRect();
    this.w = Math.max(1, Math.floor(r.width)); this.h = Math.max(1, Math.floor(r.height)); this.dpr = window.devicePixelRatio || 1;
    this.canvas.width = Math.round(this.w * this.dpr); this.canvas.height = Math.round(this.h * this.dpr); this.invalidate();
  }
  #prepare(): void {
    this.ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0); this.ctx.clearRect(0, 0, this.w, this.h);
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

export class DepthPane extends TimePane {
  #range = 0.2;
  #series: { t0: number; t1: number; w: number; bid: Float32Array; ask: Float32Array } | null = null;
  #key = ''; #busy = false;
  /** When the last request was made, and how long the worker took to answer it (the live edge is asked again on a clock that allows for it). */
  #askedAt = 0; #tookMs = 0;
  /** The columns Highlights flags, worked out once for each depth answer and setting (the rule looks back over many columns), not on every frame the pointer moves. */
  #flags: { series: object; key: string; flags: Uint8Array } | null = null;
  /** The pane is too short for a popup drawn on it, so what the pointer is over is said in a page element. */
  #card = new HoverCard();
  #lines: InfoLine[] | null = null;
  constructor(host: HTMLElement, store: Store, view: View, private hub: Hub) {
    super(host, store, view, 'depth');
    this.head.innerHTML = `<strong>${t('Depth')}</strong><span class="readout"></span>`;
    this.head.querySelector('strong')!.after(helpButton('depthPane'));
    const label = document.createElement('label'); label.className = 'ctl'; label.append(t('Range'));
    const select = document.createElement('select');
    for (const r of [0.01, 0.02, 0.05, 0.1, 0.2]) select.append(new Option(`${r * 100}%`, String(r)));
    select.value = String(this.#range); select.onchange = () => { this.#range = Number(select.value); this.#key = ''; this.invalidate(); };
    label.append(select); this.head.append(label);
  }
  refresh(): void { this.#key = ''; this.invalidate(); }
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
      const mids = new Float64Array(w);
      const tf = TIMEFRAMES[state.timeframe] ?? 3_600_000;
      for (let x = 0; x < w; x++) {
        const t = v.t0 + (x + 0.5) / w * (v.t1 - v.t0);
        let close = state.mark.price;
        for (let i = state.candles.length - 1; i >= 0; i--) { const c = state.candles[i]!; if (c[0] <= t) { close = t < c[0] + tf ? c[4] : close; if (c[0] <= t) break; } }
        mids[x] = close;
      }
      const t0 = v.t0, t1 = v.t1;
      void this.hub.depth(ids, t0, t1, w, this.#range, mids).then(r => { this.#tookMs = performance.now() - asked; this.#series = { t0, t1, w, bid: r.bid, ask: r.ask }; this.#busy = false; this.invalidate(); }, () => { this.#busy = false; });
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
    // Which columns stand out is the page's one rule (Highlights: how many deviations, over how many bars before); the rest recedes.
    const columnsPerBar = s.w * (TIMEFRAMES[state.timeframe] ?? 3_600_000) / Math.max(1, s.t1 - s.t0);
    const flagKey = `${columnsPerBar}|${state.highlight.length}|${state.highlight.mult}`;
    if (cue && (this.#flags?.series !== s || this.#flags.key !== flagKey)) this.#flags = { series: s, key: flagKey, flags: imbalanceFlags(s.bid, s.ask, state.highlight, columnsPerBar) };
    const unusual = cue ? this.#flags!.flags : null;
    for (let x = 0; x < s.w; x++) {
      const t = s.t0 + x / s.w * (s.t1 - s.t0), t2 = s.t0 + (x + 1) / s.w * (s.t1 - s.t0);
      const x0 = xOf(t), x1 = xOf(t2);
      const b = s.bid[x]!, a = s.ask[x]!;
      // The side with more liquidity is drawn brighter and the other dimmer, in proportion to the imbalance (no flip, so it does not flicker);
      // a column the rule flags goes to full strength, and the others show the gap only up to part of it.
      const total = b + a, imbalance = total > 0 ? (b - a) / total : 0, flagged = unusual?.[x] === 1, strength = flagged ? 1 : Math.min(1, Math.abs(imbalance) / 0.3) * 0.4;
      const bidAlpha = !cue ? 0.55 : 0.5 + (imbalance > 0 ? 0.45 : -0.28) * strength, askAlpha = !cue ? 0.55 : 0.5 + (imbalance < 0 ? 0.45 : -0.28) * strength;
      // Asks above the line and bids below it, as they sit on the chart and in the order book.
      if (a > 0) {
        const height = a / max * half;
        ctx.fillStyle = p.ask; ctx.globalAlpha = askAlpha; ctx.fillRect(x0, mid - height, x1 - x0 + 0.6, height);
        if (flagged && imbalance < 0) { ctx.globalAlpha = 1; ctx.fillRect(x0, mid - height, x1 - x0 + 0.6, 1.5); }
      }
      if (b > 0) {
        const height = b / max * half;
        ctx.fillStyle = p.bid; ctx.globalAlpha = bidAlpha; ctx.fillRect(x0, mid, x1 - x0 + 0.6, height);
        if (flagged && imbalance > 0) { ctx.globalAlpha = 1; ctx.fillRect(x0, mid + height - 1.5, x1 - x0 + 0.6, 1.5); }
      }
    }
    ctx.globalAlpha = 1; ctx.strokeStyle = p.line; ctx.beginPath(); ctx.moveTo(0, mid + 0.5); ctx.lineTo(pw, mid + 0.5); ctx.stroke();
    ctx.fillStyle = p.muted; ctx.textAlign = 'left'; ctx.fillText(usd(max), this.w - AXIS_W + 6, 10); ctx.fillText(usd(max), this.w - AXIS_W + 6, ph - 10);
    ctx.fillText('0', this.w - AXIS_W + 6, mid);
  }
}

/**
 * Open interest is a level, so it is drawn as one: a step line that holds each sample until the next, a dimmer continuation to the
 * newest candle (no sample has arrived since), and below it the change between samples, with unusually large changes at full weight.
 */
export class OiPane extends TimePane {
  #cache: { oi: readonly OiBar[]; key: string; delta: Float64Array; flag: Uint8Array; sigma: Float64Array } | null = null;
  #card = new HoverCard();
  #lines: InfoLine[] | null = null;
  constructor(host: HTMLElement, store: Store, view: View) {
    super(host, store, view, 'oi');
    this.head.innerHTML = `<strong>${t('Open Interest')}</strong><span class="readout"></span>`;
    this.head.querySelector('strong')!.after(helpButton('oiPane'));
  }
  #analysis(oi: readonly OiBar[], highlight: HighlightOptions) {
    const key = `${highlight.mult}|${highlight.length}`;
    if (this.#cache && this.#cache.oi === oi && this.#cache.key === key) return this.#cache;
    const delta = oiDeltas(oi), size = delta.map(Math.abs);
    const found = anomalies(size, highlight);
    this.#cache = { oi, key, delta, flag: found.flag, sigma: found.sigma };
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
  #paint(): void {
    const { ctx, palette: p, view: v } = this, pw = this.plotW, ph = this.h, state: AppState = this.store.state;
    // Replay: the bar under way at its moment would carry what came after; only bars that ended by then.
    const tf = TIMEFRAMES[state.timeframe] ?? 3_600_000, oi = this.#oiAt(state.oi, tf), highlight = state.highlight;
    const readout = this.head.querySelector('.readout');
    const say = (html: string): void => setHtml(readout, html);
    if (!oi.length) { ctx.fillStyle = p.muted; ctx.textAlign = 'left'; ctx.fillText(t('No open-interest history for this market yet.'), 12, ph / 2); say(''); return; }
    const analysis = this.#analysis(oi, highlight);
    const visible: number[] = [];
    for (let i = 0; i < oi.length; i++) if (oi[i]![0] + tf >= v.t0 && oi[i]![0] <= v.t1) visible.push(i);
    if (!visible.length) { ctx.fillStyle = p.muted; ctx.textAlign = 'left'; ctx.fillText(t('No open-interest samples in view.'), 12, ph / 2); say(''); return; }
    // Geometry: the level on top, the change below (when the pane is tall enough to hold both).
    const split = ph >= 84, lineBottom = split ? Math.round(ph * 0.6) : ph - 6, bandTop = lineBottom + 12, bandBottom = ph - 5, mid = (bandTop + bandBottom) / 2, half = (bandBottom - bandTop) / 2;
    let lo = Infinity, hi = -Infinity, maxDelta = 0;
    for (const i of visible) { const b = oi[i]!; lo = Math.min(lo, b[3], b[4]); hi = Math.max(hi, b[2], b[4]); maxDelta = Math.max(maxDelta, Math.abs(analysis.delta[i]!)); }
    const pad = Math.max((hi - lo) * 0.18, hi * 0.0004), min = lo - pad, max = hi + pad;
    const y = (value: number) => 6 + (1 - (value - min) / (max - min)) * (lineBottom - 6);
    const xc = (i: number) => v.xOf(oi[i]![0] + tf / 2, pw);
    const first = Math.max(0, visible[0]! - 1), last = visible[visible.length - 1]!;
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
    // The line holds the last sample on screen. It ends at the newest sample's centre only when that sample is the one on screen; looking at
    // the past it carries its level to the edge of the view, and the newest value (which is somewhere to the right) is not joined to it.
    const tail = oiTail(oi.length, last, xSampled, pw), endY = y(oi[last]![4]);
    line(first, last); ctx.lineTo(tail.x, endY); ctx.lineTo(tail.x, lineBottom); ctx.lineTo(xc(first), lineBottom); ctx.closePath();
    ctx.globalAlpha = 0.09; ctx.fillStyle = p.accent; ctx.fill(); ctx.globalAlpha = 1;
    ctx.lineWidth = 1.6; ctx.strokeStyle = p.accent; line(first, last); ctx.lineTo(tail.x, endY); ctx.stroke();
    if (tail.live && xEnd > xSampled + 2) { ctx.globalAlpha = 0.55; ctx.setLineDash([4, 4]); ctx.beginPath(); ctx.moveTo(xSampled, y(lastBar[4])); ctx.lineTo(xEnd, y(lastBar[4])); ctx.stroke(); ctx.setLineDash([]); ctx.globalAlpha = 1; }
    ctx.lineWidth = 1;
    const spacing = visible.length > 1 ? (xc(visible[visible.length - 1]!) - xc(visible[0]!)) / (visible.length - 1) : 99;
    if (spacing >= 9) { ctx.fillStyle = p.accent; for (const i of visible) { ctx.beginPath(); ctx.arc(xc(i), y(oi[i]![4]), 2.4, 0, Math.PI * 2); ctx.fill(); } }
    ctx.restore();
    ctx.fillStyle = p.muted; ctx.textAlign = 'left';
    // A coin counted in billions (PEPE) would not fit the axis written out in full.
    const amount = (v: number): string => Math.abs(v) >= 1e6 ? usd(v) : fmtPrice(v, 1);
    ctx.fillText(amount(max), this.w - AXIS_W + 6, 10); ctx.fillText(amount(min), this.w - AXIS_W + 6, lineBottom - 4);
    if (split) { ctx.fillText(`±${amount(maxDelta)}`, this.w - AXIS_W + 6, mid); }
    // Readout: the hovered sample, else the newest, with where the data comes from and how old it is.
    const hover = state.hover;
    let shown = oi.length - 1;
    if (hover) { shown = -1; for (let i = 0; i < oi.length; i++) if (oi[i]![0] <= hover.t) shown = i; else break; if (shown < 0) shown = 0; }
    const bar = oi[shown]!, d = shown > 0 ? analysis.delta[shown]! : 0, flagged = highlight.on && analysis.flag[shown] === 1;
    const age = pageNow() - lastBar[0], stale = age > Math.max(3 * tf, 3 * 60_000);
    const sign = d > 0 ? '+' : d < 0 ? '−' : '';
    const source = state.oiInstrument && state.oiInstrument !== state.seriesInstrument ? ` <span class="muted">${t('from {venue}', { venue: `${venueLabel(state.oiInstrument)} ${state.oiInstrument.split(':').slice(1).join(':')}` })}</span>` : '';
    const sigma = flagged && Number.isFinite(analysis.sigma[shown]) ? ` <span class="muted">${analysis.sigma[shown]!.toFixed(1)}σ</span>` : '';
    const over = hover && this.pointer ? barAt(oi, tf, hover.t) : -1;
    if (over === oi.length - 1 && hover && hover.t >= oi[over]![0] + tf) this.cursorT = oi[over]![0] + tf / 2;
    if (over >= 0) {
      const there = oi[over]!, seen = visible.filter(i => i > 0), change = over > 0 ? analysis.delta[over]! : null, size = change === null ? 0 : Math.abs(change);
      this.#lines = oiCardLines({
        time: there[0], level: there[4], change, before: over > 1 ? analysis.delta[over - 1]! : null,
        rank: change === null || !seen.length ? null : 1 + seen.filter(i => Math.abs(analysis.delta[i]!) > size).length, of: seen.length,
        sigma: highlight.on && analysis.flag[over] === 1 && Number.isFinite(analysis.sigma[over]) ? analysis.sigma[over]! : null,
        source: state.oiInstrument && state.oiInstrument !== state.seriesInstrument ? t('from {venue}', { venue: `${venueLabel(state.oiInstrument)} ${state.oiInstrument.split(':').slice(1).join(':')}` }) : null,
        staleMin: over === oi.length - 1 && stale ? Math.round(age / 60_000) : null,
      });
    }
    say(`${t('base')} <b>${fmtPrice(bar[4], 1)}</b> Δ <b class="${d > 0 ? 'bid' : d < 0 ? 'ask' : ''}">${sign}${fmtPrice(Math.abs(d), 1)}</b>${sigma}${source}${stale ? ` <span class="ask">${t('last sample {n} min ago', { n: Math.round(age / 60_000) })}</span>` : ''}`);
  }
}

const HALF_LIVES = [2, 5, 10, 25, 50, 100, 250, 1000];
const MIN_SIZES = [0, 10_000, 50_000, 100_000, 250_000, 500_000, 1_000_000];
const MAX_SIZES = [0, 100_000, 250_000, 500_000, 1_000_000, 5_000_000];
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
    this.head.innerHTML = `<strong>${t('Liquidity Tracker')}</strong><span class="readout"></span>`;
    this.head.querySelector('strong')!.after(helpButton('ltPane'));
    setTip(this.head.querySelector('strong')!, t("Weighted USD liquidity near the touch of the aggregated book of the enabled venues. A level weighs 1 at the touch and halves every half-life. The size filter applies to a venue's aggregated size at one price bin, not to individual orders."));
    const lt = () => this.store.state.lt;
    const patch = (change: Partial<AppState['lt']>) => this.store.set({ lt: { ...lt(), ...change } });
    const select = (label: string, title: string, options: [string, string][], get: () => string, set: (value: string) => void) => {
      const wrap = document.createElement('label'); wrap.className = 'ctl'; setTip(wrap, title); wrap.append(label);
      const control = document.createElement('select');
      for (const [value, text] of options) control.append(new Option(text, value));
      control.value = get(); control.onchange = () => set(control.value);
      wrap.append(control); this.head.append(wrap);
      this.#sync.push(() => { if (control.value !== get()) control.value = get(); });
    };
    const size = (v: number, none: string, sign: string): [string, string] => [String(v), v === 0 ? none : `${sign} $${usd(scaledUsd(v))}`];
    select(t('Half-life'), t("Distance from the touch, in basis points of price, at which a level's weight halves"), HALF_LIVES.map(v => [String(v), `${v} bp`]), () => String(lt().halfLifeBp), v => patch({ halfLifeBp: Number(v) }));
    select(t('Min'), t('Ignore price bins smaller than this'), MIN_SIZES.map(v => size(v, t('any'), '≥')), () => String(lt().minUsd), v => patch({ minUsd: Number(v) }));
    select(t('Max'), t('Ignore price bins larger than this'), MAX_SIZES.map(v => size(v, t('no cap'), '≤')), () => String(lt().maxUsd), v => patch({ maxUsd: Number(v) }));
    const avg = document.createElement('label'); avg.className = 'ctl'; setTip(avg, t('Divide by the summed weights of the non-empty levels, as if each had size 1'));
    const box = document.createElement('input'); box.type = 'checkbox'; box.checked = lt().average; box.onchange = () => patch({ average: box.checked });
    avg.append(box, t('Per level')); this.head.append(avg);
    // The balance tipping can sound (the threshold and the volume are in the Sounds panel).
    const bell = document.createElement('label'); bell.className = 'ctl'; const bellBox = document.createElement('input'); bellBox.type = 'checkbox';
    bellBox.onchange = () => setPanelSwitch(this.store, 'depth', bellBox.checked);
    bell.append(bellBox, t('Sound')); setTip(bell, t('Within 1% of the price, the bids outweigh the asks (or the other way round) by more than this share. It sounds once and again only after the book has come back. Three steps.')); this.head.append(bell);
    this.#sync.push(() => { bellBox.checked = panelSwitchOn(this.store, 'depth'); });
    this.#sync.push(() => { if (box.checked !== lt().average) box.checked = lt().average; });
    select(t('View'), t('Bid and ask lines, or the imbalance (bid - ask) / (bid + ask)'), [['lines', t('Bid & ask')], ['imbalance', t('Imbalance')]], () => lt().view, v => patch({ view: v as AppState['lt']['view'] }));
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
    const key = `${ids.join(',')}|${t0}|${t1}|${this.hub.columnsVersion}|${lt.halfLifeBp}|${lt.minUsd}|${lt.maxUsd}|${lt.average}`;
    const liveTail = v.t1 > Date.now() - 2 * MINUTE;
    if (ids.length && !this.#busy && (key !== this.#key || (liveTail && performance.now() - this.#lastAt > 1_500))) {
      this.#key = key; this.#busy = true; this.#lastAt = performance.now();
      const params = { halfLifeBp: lt.halfLifeBp, minUsd: scaledUsd(lt.minUsd), maxUsd: scaledUsd(lt.maxUsd), average: lt.average };
      void this.hub.lt(ids, t0, t1, params).then(r => { this.#series = { ...r, stepMs: this.hub.columnStepMs }; this.#busy = false; this.invalidate(); }, () => { this.#busy = false; });
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
      ctx.fillText(usd(hi), this.w - AXIS_W + 6, 10); ctx.fillText('0', this.w - AXIS_W + 6, ph - 8);
    } else {
      const mid = ph / 2, half = ph / 2 - 6;
      for (let i = 0; i < n; i++) {
        const t = s.times[i]!, total = s.bid[i]! + s.ask[i]!; if (t + step < v.t0 || t > v.t1 || total <= 0) continue;
        const imb = (s.bid[i]! - s.ask[i]!) / total, x0 = xOf(t - step / 2), x1 = xOf(t + step / 2);
        ctx.fillStyle = imb >= 0 ? p.bid : p.ask; ctx.globalAlpha = state.highlight.on ? 0.3 + 0.65 * Math.min(1, Math.abs(imb) / 0.5) : 0.7;
        ctx.fillRect(x0, imb >= 0 ? mid - imb * half : mid, Math.max(1, x1 - x0 - 0.4), Math.max(1, Math.abs(imb) * half));
      }
      ctx.globalAlpha = 1; ctx.strokeStyle = p.line; ctx.beginPath(); ctx.moveTo(0, mid + 0.5); ctx.lineTo(pw, mid + 0.5); ctx.stroke();
      ctx.fillStyle = p.muted; ctx.fillText('+100%', this.w - AXIS_W + 6, 10); ctx.fillText('0', this.w - AXIS_W + 6, mid); ctx.fillText('-100%', this.w - AXIS_W + 6, ph - 8);
    }
    // Readout follows the cursor, else the newest point.
    let at = n - 1;
    if (state.hover) { at = 0; for (let i = 0; i < n; i++) if (s.times[i]! <= state.hover.t) at = i; }
    const b = s.bid[at]!, a = s.ask[at]!, total = b + a;
    setHtml(readout, `${t('Bid')} <b class="bid">${usd(b)}</b> ${t('Ask')} <b class="ask">${usd(a)}</b> Δ <b>${usd(b - a)}</b> ${t('imb')} <b>${total > 0 ? Math.round((b - a) / total * 100) : 0}%</b> · ${tn(ids.length, '{n} venue', '{n} venues')}`);
    const over = state.hover && this.pointer ? readAt(slotAt(s.times, step, state.hover.t), state.hover.t, n - 1, s.times[n - 1]) : -1;
    if (over >= 0 && state.hover && state.hover.t >= s.times[over]! + step) this.cursorT = s.times[over]! + step / 2;
    if (over >= 0) this.#lines = ltCardLines({ time: s.times[over]!, bid: s.bid[over]!, ask: s.ask[over]!, halfLifeBp: lt.halfLifeBp, venues: ids.length });
  }
}

const hexMix = (a: string, b: string, t: number): string => {
  const pa = parseInt(a.slice(1), 16), pb = parseInt(b.slice(1), 16), k = Math.max(0, Math.min(1, t));
  const channel = (shift: number) => Math.round(((pa >> shift) & 255) * (1 - k) + ((pb >> shift) & 255) * k);
  return '#' + [channel(16), channel(8), channel(0)].map(v => v.toString(16).padStart(2, '0')).join('');
};
/** Strip under the chart with the enabled per-candle statistics, aligned to the candle slots (footprint on); the Stats button chooses, orders and configures them. */
export class BarStatsPane extends TimePane {
  /** The strip is too short for a popup drawn on it, so the cell's popup is a page element. */
  #card = new HoverCard();
  #cell: StatCell | null = null;
  #button = document.createElement('button');
  #panel: Panel | null = null;
  constructor(host: HTMLElement, store: Store, view: View, private heat: HeatPane) {
    super(host, store, view, 'bars');
    this.head.innerHTML = `<strong>${t('Bar stats')}</strong><span class="readout"></span>`;
    this.head.querySelector('strong')!.after(helpButton('barStats'));
    this.#button.textContent = t('Stats'); setTip(this.#button, t('Choose, order and configure the statistics shown for each candle'));
    this.#button.onclick = () => { this.#panel = togglePanel(this.#button, { title: t('Bar stats'), width: 440, align: 'right', onClose: () => { this.#panel = null; } }, (tools, body) => this.#build(tools, body)); };
    this.head.append(this.#button);
  }
  /** Redraw after the configuration changed and keep an open panel in step. */
  refresh(): void { this.#panel?.render((tools, body) => this.#build(tools, body)); this.invalidate(); }

  #build(tools: HTMLElement, body: HTMLElement): void {
    const state = this.store.state, options = state.barStatOptions;
    const chosen = enabledStats(state.barStats).map(def => def.id);
    const setStats = (ids: string[]) => this.store.set({ barStats: ids });
    const setOptions = (change: Partial<StatOptions>) => this.store.set({ barStatOptions: { ...this.store.state.barStatOptions, ...change } });

    for (const [label, ids] of [[t('Default'), PRESETS.default], [t('All'), PRESETS.all], [t('None'), PRESETS.none]] as const) tools.append(button(label, () => setStats([...ids])));
    tools.append(el('span', { class: 'muted', textContent: t('{shown} of {total} shown', { shown: chosen.length, total: BAR_STATS.length }) }));

    body.append(heading(t('Sound')), panelSwitchRow(this.store, 'bars'));
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
      selectRow(t('Cells'), t('Filled cells are shaded by magnitude (log scale between the visible 2nd and 99th percentile); text only is coloured by sign'), [['filled', t('Filled')], ['text', t('Text only')]], options.cells, v => setOptions({ cells: v as StatOptions['cells'] })),
      selectRow(t('OI change in'), t("Open-interest change in base coin (the series' own unit) or as USD (change times the bar's close)"), [['base', t('Base coin')], ['usd', 'USD']], options.oiUnits, v => setOptions({ oiUnits: v as StatOptions['oiUnits'] })),
      numberRow(t('Imbalance ratio'), t('A level counts as imbalanced when its volume is at least this many times the opposite volume one row away'), { min: 1, step: 0.5, value: options.imbRatio }, v => setOptions({ imbRatio: v })),
      numberRow(t('Imbalance min USD'), t('Ignore imbalanced levels smaller than this'), { min: 0, step: scaledUsd(1000), value: scaledUsd(options.imbMinUsd) }, v => setOptions({ imbMinUsd: unscaledUsd(v) })),
      numberRow(t('Stacked rows'), t('Adjacent imbalanced rows on one side that count as a stack'), { min: 2, step: 1, value: options.stackedN }, v => setOptions({ stackedN: Math.round(v) })),
    );
    const buckets = sizeBucketLabels().map((label, i): [string, string] => [String(i), label]);
    body.append(
      selectRow(t('Retail up to'), t('Market orders in this size bucket and below are retail (delta retail, cvd retail)'), buckets, String(options.retailMax), v => { const r = Number(v); setOptions({ retailMax: r, whaleMin: Math.max(options.whaleMin, Math.min(7, r + 1)) }); }),
      selectRow(t('Whales from'), t('Market orders in this size bucket and above are whales (delta whales, cvd whales)'), buckets, String(options.whaleMin), v => { const w = Number(v); setOptions({ whaleMin: w, retailMax: Math.min(options.retailMax, Math.max(0, w - 1)) }); }),
    );
  }

  protected draw(): void {
    this.#cell = null;
    this.#strip();
    const at = this.pointer;
    if (this.#cell && at) this.#card.show(statCellLines(this.#cell), at.x, at.y); else this.#card.hide();
  }

  protected override undrawn(): void { this.#cell = null; this.#card.hide(); }

  #strip(): void {
    const { ctx, palette: p, view: v } = this, pw = this.plotW, ph = this.h, state = this.store.state;
    const tfMs = TIMEFRAMES[state.timeframe] ?? 3_600_000, defs = enabledStats(state.barStats), options = state.barStatOptions;
    const readout = this.head.querySelector('.readout');
    setText(readout, tn(defs.length, '{n} stat · cvd sums the bars loaded for the view', '{n} stats · cvd sums the bars loaded for the view'));
    if (!defs.length) { ctx.fillStyle = p.muted; ctx.fillText(t('No statistics selected: use Stats to add some.'), 12, ph / 2); return; }
    // Replay: only the candles that ended by its moment (a candle under way would carry its future executions).
    const data = this.heat.footprintData, until = replaying() ? pageNow() : Infinity, all = [...data.bars.values()].filter(b => b.t + tfMs <= until).sort((a, b) => a.t - b.t);
    if (!all.length) { ctx.fillStyle = p.muted; ctx.fillText(t('Bar stats appear once the footprint has executions for the visible candles.'), 12, ph / 2); return; }
    const input = { bars: all, step: data.step, options, candles: new Map(state.candles.map(c => [c[0], c] as const)), oi: new Map(state.oi.map(b => [b[0], b] as const)) };
    const slot = pw * tfMs / (v.t1 - v.t0), top = 3, rowH = Math.max(15, (ph - 6) / defs.length), filled = options.cells === 'filled';
    const visible = all.map((bar, i) => i).filter(i => all[i]!.t + tfMs >= v.t0 && all[i]!.t <= v.t1);
    if (!visible.length) { ctx.fillStyle = p.muted; ctx.fillText(t('No executions recorded for the candles in view.'), 12, ph / 2); return; }
    // Under the pointer: the candle (any pane's pointer says which, the time axis being shared) and, from this pane's own pointer, the row.
    const hv = state.hover, under = hv ? all.findIndex(bar => hv.t >= bar.t && hv.t < bar.t + tfMs) : -1;
    // Past the newest bar this pane's own pointer reads the newest (readAt); another pane's pointer there marks nothing here.
    const hoverIdx = hv && this.pointer ? readAt(under, hv.t, all.length - 1, all[all.length - 1]!.t) : under;
    if (hoverIdx >= 0 && hoverIdx !== under) this.cursorT = all[hoverIdx]!.t + tfMs / 2;
    const hoverRow = hv && hv.source === 'bars' ? Math.floor((hv.y - top) / rowH) : -1;
    let hoverCell: StatCell | null = null;
    ctx.textBaseline = 'middle'; ctx.textAlign = 'center'; ctx.font = '11px ui-monospace, SFMono-Regular, Menlo, monospace';
    defs.forEach((def, rowIndex) => {
      const values = def.compute(input), scale = rowScale(def, visible.map(i => values[i]));
      const found = state.highlight.on && def.scale !== 'plain' ? anomalies(Float64Array.from(values, value => value === null || value === undefined ? NaN : Math.abs(value)), state.highlight) : null, unusual = found?.flag ?? null;
      const mine = hoverIdx >= 0 && rowIndex === hoverRow ? values[hoverIdx] : undefined;
      if (hoverIdx >= 0 && rowIndex === hoverRow && mine !== null && mine !== undefined) {
        const before = all[hoverIdx - 1], previous = before && before.t === all[hoverIdx]!.t - tfMs ? values[hoverIdx - 1] : null;
        const seen = visible.map(i => values[i]).filter((x): x is number => x !== null && x !== undefined), rank = (x: number) => def.scale === 'diverging' ? Math.abs(x) : x;
        hoverCell = {
          label: def.label, title: def.title, value: def.format(mine), tone: def.scale === 'diverging' ? (mine - (def.center ?? 0) >= 0 ? 'buy' : 'sell') : 'text', time: clock(all[hoverIdx]!.t, true),
          previous: previous === null || previous === undefined ? null : def.format(previous), rank: 1 + seen.filter(x => rank(x) > rank(mine)).length, of: seen.length,
          sigma: unusual?.[hoverIdx] && found ? found.sigma[hoverIdx] ?? null : null,
        };
      }
      const y = top + rowIndex * rowH;
      if (!filled) { ctx.globalAlpha = 0.5; ctx.strokeStyle = p.line; ctx.beginPath(); ctx.moveTo(0, Math.round(y + rowH - 1) + 0.5); ctx.lineTo(pw, Math.round(y + rowH - 1) + 0.5); ctx.stroke(); ctx.globalAlpha = 1; }
      for (const i of visible) {
        const x = v.xOf(all[i]!.t, pw), w = Math.max(1, slot - 1), value = values[i];
        if (value === null || value === undefined) {
          if (filled) { ctx.globalAlpha = 0.5; ctx.fillStyle = p.line; ctx.fillRect(x, y, w, rowH - 1); ctx.globalAlpha = 1; }
          if (slot >= 48) { ctx.fillStyle = p.muted; ctx.fillText('–', x + w / 2, y + (rowH - 1) / 2); }
          continue;
        }
        const t = strength(def, value, scale), tone = (value - (def.center ?? 0)) >= 0 ? p.candleUp : p.candleDown;
        if (filled) {
          ctx.fillStyle = def.scale === 'sequential' ? hexMix('#e4e8ff', '#2b3fd6', t) : def.scale === 'diverging' ? hexMix(hexMix('#ffffff', tone, 0.18), tone, t) : p.panel;
          ctx.fillRect(x, y, w, rowH - 1);
          if (def.scale === 'plain') { ctx.strokeStyle = p.line; ctx.strokeRect(x + 0.5, y + 0.5, w - 1, rowH - 2); }
        }
        if (unusual?.[i]) { ctx.save(); ctx.lineWidth = 1.6; ctx.strokeStyle = p.dark ? '#ffffff' : '#14171c'; ctx.globalAlpha = 0.95; ctx.strokeRect(x + 0.8, y + 0.8, Math.max(1, w - 1.6), rowH - 2.6); ctx.restore(); }
        if (slot >= 48) {
          ctx.fillStyle = filled ? (def.scale === 'plain' ? p.text : t > 0.55 ? '#ffffff' : '#14171c') : def.scale === 'diverging' ? tone : p.text;
          ctx.globalAlpha = filled ? 1 : 0.6 + 0.4 * t;
          ctx.fillText(def.format(value), x + w / 2, y + (rowH - 1) / 2); ctx.globalAlpha = 1;
        }
      }
    });
    // The cell under the pointer: its column and row tinted, the cell itself boxed, and a popup beside the pointer.
    if (hoverIdx >= 0) {
      const x = v.xOf(all[hoverIdx]!.t, pw), w = Math.max(1, slot - 1), gridH = defs.length * rowH;
      ctx.save(); ctx.fillStyle = p.text; ctx.globalAlpha = p.dark ? 0.12 : 0.08; ctx.fillRect(x, top, w, gridH);
      if (hoverRow >= 0 && hoverRow < defs.length) {
        const y = top + hoverRow * rowH;
        ctx.fillRect(0, y, pw, rowH - 1);
        ctx.globalAlpha = 1; ctx.strokeStyle = p.text; ctx.lineWidth = 1; ctx.strokeRect(Math.round(x) + 0.5, Math.round(y) + 0.5, Math.max(1, Math.round(w) - 1), Math.round(rowH) - 2);
      } else { ctx.globalAlpha = 0.5; ctx.strokeStyle = p.text; ctx.lineWidth = 1; ctx.strokeRect(Math.round(x) + 0.5, top + 0.5, Math.max(1, Math.round(w) - 1), gridH - 1); }
      ctx.restore();
      this.#cell = hoverCell;
    }
    ctx.textAlign = 'left'; ctx.font = '10px ui-sans-serif, system-ui, sans-serif';
    defs.forEach((def, i) => { const y = top + i * rowH, w = ctx.measureText(def.label).width + 10; ctx.globalAlpha = 0.88; ctx.fillStyle = p.panel; ctx.fillRect(2, y + 2, w, rowH - 5); ctx.globalAlpha = 1; ctx.fillStyle = p.muted; ctx.fillText(def.label, 6, y + (rowH - 1) / 2); });
  }
}
