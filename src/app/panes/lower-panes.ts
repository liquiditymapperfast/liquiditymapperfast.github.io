import { PALETTES } from '../theme.ts';
import { setTip } from '../tip.ts';
import { helpButton } from '../help.ts';
import { TIMEFRAMES, type Hub } from '../hub.ts';
import { DEFAULT_BAR_STATS, type Store, type AppState, type OiBar } from '../store.ts';
import { anomalies, type HighlightOptions } from '../anomaly.ts';
import { venueLabel } from '../venues.ts';
import { activeIds, emptyScopeMessage } from '../scope.ts';
import type { View } from '../view.ts';
import { price as fmtPrice, usd } from '../format.ts';
import { gutter, timeTicks, AXIS_W, type HeatPane } from './heat-pane.ts';
import { BAR_STATS, GROUP_TITLES, PRESETS, SIZE_BUCKET_LABELS, enabledStats, rowScale, statDef, strength, type StatGroup } from './bar-stats.ts';
import type { StatOptions } from '../stat-options.ts';
import { el } from '../dom.ts';
import { button, checkRow, heading, note, numberRow, selectRow, sortableList, togglePanel, type Panel } from '../ui.ts';
import type { LtSeries } from '../lt.ts';
import { GestureRecognizer, bindTouch, type GestureHandlers, type Pt } from '../touch.ts';
import { candleSpan } from '../candle-span.ts';

/** A canvas pane whose x axis is the main chart's time axis. */
abstract class TimePane {
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
  #source: 'depth' | 'oi' | 'lt' | 'bars';

  constructor(host: HTMLElement, protected store: Store, protected view: View, cls: string) {
    this.root.className = `pane ${cls}`; this.head.className = 'pane-head';
    this.root.append(this.head, this.canvas); host.append(this.root);
    this.ctx = this.canvas.getContext('2d')!;
    new ResizeObserver(() => this.#resize()).observe(this.canvas);
    const source = this.#source = cls as 'depth' | 'oi' | 'lt' | 'bars';
    this.canvas.addEventListener('pointermove', e => {
      if (e.pointerType === 'touch') return;
      const r = this.canvas.getBoundingClientRect(), x = e.clientX - r.left, y = e.clientY - r.top;
      if (x < 0 || x > this.plotW) { this.store.set({ hover: null }); return; }
      this.store.set({ hover: { t: this.view.tOf(x, this.plotW), price: null, y, source } });
    });
    this.canvas.addEventListener('pointerleave', e => { if (e.pointerType !== 'touch') this.store.set({ hover: null }); });
    bindTouch(this.canvas, new GestureRecognizer(this.#touchHandlers()));
  }

  /** Let the panes' finger gestures move the map's time axis (called once the map exists). */
  useTimeGestures(time: ReturnType<HeatPane['timeGestures']>): void { this.#time = time; }

  /**
   * A tap pins the readout at that time (tap it again to let it go), holding and dragging scrubs it, and dragging or pinching moves
   * the time axis the panes share with the map. Everything else about the finger is the map's business, so it is handed over.
   */
  #touchHandlers(): GestureHandlers {
    const pin = (p: Pt): void => {
      if (p.x < 0 || p.x > this.plotW) { this.#unpin(); return; }
      this.#pinned = p;
      this.store.set({ hover: { t: this.view.tOf(p.x, this.plotW), price: null, y: p.y, source: this.#source, touch: true } });
    };
    return {
      down: p => this.#time?.down?.(p),
      tap: p => { if (this.#pinned && Math.hypot(this.#pinned.x - p.x, this.#pinned.y - p.y) < 28) this.#unpin(); else pin(p); },
      doubleTap: p => { this.#unpin(); this.#time?.doubleTap?.(p); },
      hold: pin, holdMove: pin,
      panStart: p => { this.#unpin(); this.#time?.panStart?.(p); },
      pan: (d, p, v) => this.#time?.pan?.(d, p, v),
      panEnd: v => this.#time?.panEnd?.(v),
      pinchStart: info => { this.#unpin(); this.#time?.pinchStart?.(info); },
      pinch: info => this.#time?.pinch?.(info),
      pinchEnd: () => this.#time?.pinchEnd?.(),
      cancel: () => this.#time?.cancel?.(),
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
    if (this.view.t1 > this.view.t0 && this.w > 1) { this.#grid(); this.draw(); this.#crosshair(); }
  }
  #grid(): void {
    const { ctx, palette: p, view: v } = this, pw = this.plotW;
    ctx.strokeStyle = p.line; ctx.globalAlpha = 0.6; ctx.beginPath();
    for (const t of timeTicks(v.t0, v.t1, pw)) { const x = Math.round(v.xOf(t, pw)) + 0.5; ctx.moveTo(x, 0); ctx.lineTo(x, this.h); }
    ctx.stroke(); ctx.globalAlpha = 1;
    ctx.fillStyle = p.panel; ctx.fillRect(this.w - AXIS_W, 0, AXIS_W, this.h);
  }
  #crosshair(): void {
    const hv = this.store.state.hover; if (!hv) return;
    const { ctx, palette: p } = this;
    const x = this.view.xOf(hv.t, this.plotW);
    if (x < 0 || x > this.plotW) return;
    ctx.strokeStyle = p.muted; ctx.setLineDash([3, 3]); ctx.beginPath(); ctx.moveTo(Math.round(x) + 0.5, 0); ctx.lineTo(Math.round(x) + 0.5, this.h); ctx.stroke(); ctx.setLineDash([]);
  }
  protected abstract draw(): void;
}

export class DepthPane extends TimePane {
  #range = 0.2;
  #series: { t0: number; t1: number; w: number; bid: Float32Array; ask: Float32Array } | null = null;
  #key = ''; #busy = false;
  constructor(host: HTMLElement, store: Store, view: View, private hub: Hub) {
    super(host, store, view, 'depth');
    this.head.innerHTML = '<strong>Depth</strong><span class="readout"></span>';
    this.head.querySelector('strong')!.after(helpButton('depthPane'));
    const label = document.createElement('label'); label.className = 'ctl'; label.append('Range');
    const select = document.createElement('select');
    for (const r of [0.01, 0.02, 0.05, 0.1, 0.2]) select.append(new Option(`${r * 100}%`, String(r)));
    select.value = String(this.#range); select.onchange = () => { this.#range = Number(select.value); this.#key = ''; this.invalidate(); };
    label.append(select); this.head.append(label);
  }
  refresh(): void { this.#key = ''; this.invalidate(); }
  protected draw(): void {
    const { ctx, palette: p, view: v } = this, pw = this.plotW, ph = this.h;
    const state = this.store.state;
    const ids = activeIds(state);
    const emptyScope = emptyScopeMessage(state);
    if (emptyScope) { ctx.fillStyle = p.muted; ctx.textAlign = 'left'; ctx.fillText(emptyScope, 12, ph / 2); return; }
    const key = `${ids.join(',')}|${Math.round(v.t0)}|${Math.round(v.t1)}|${pw}|${this.#range}`;
    if (key !== this.#key && !this.#busy && ids.length) {
      this.#key = key; this.#busy = true;
      const w = Math.min(1200, Math.max(60, Math.floor(pw / 2)));
      const mids = new Float64Array(w);
      const tf = TIMEFRAMES[state.timeframe] ?? 3_600_000;
      for (let x = 0; x < w; x++) {
        const t = v.t0 + (x + 0.5) / w * (v.t1 - v.t0);
        let close = state.mark.price;
        for (let i = state.candles.length - 1; i >= 0; i--) { const c = state.candles[i]!; if (c[0] <= t) { close = t < c[0] + tf ? c[4] : close; if (c[0] <= t) break; } }
        mids[x] = close;
      }
      const t0 = v.t0, t1 = v.t1;
      void this.hub.depth(ids, t0, t1, w, this.#range, mids).then(r => { this.#series = { t0, t1, w, bid: r.bid, ask: r.ask }; this.#busy = false; this.invalidate(); }, () => { this.#busy = false; });
    }
    const s = this.#series;
    const readout = this.head.querySelector('.readout');
    if (!s) { ctx.fillStyle = p.muted; ctx.fillText('Depth history is collecting…', 12, ph / 2); return; }
    let max = 1, lastB = 0, lastA = 0;
    for (let x = 0; x < s.w; x++) { max = Math.max(max, s.bid[x]!, s.ask[x]!); if (s.bid[x]! > 0 || s.ask[x]! > 0) { lastB = s.bid[x]!; lastA = s.ask[x]!; } }
    const lastTotal = lastB + lastA, lastImbalance = lastTotal > 0 ? (lastB - lastA) / lastTotal : 0;
    const dominant = Math.abs(lastImbalance) < 0.005 ? '' : ` <b class="${lastImbalance > 0 ? 'bid' : 'ask'}">${lastImbalance > 0 ? 'bids' : 'asks'} +${(Math.abs(lastImbalance) * 100).toFixed(1)}%</b>`;
    if (readout) readout.innerHTML = `A <b class="ask">${usd(lastA)}</b> B <b class="bid">${usd(lastB)}</b> Δ <b>${usd(lastB - lastA)}</b>${dominant}`;
    const mid = ph / 2, half = ph / 2 - 6, cue = state.highlight.on;
    const xOf = (t: number) => v.xOf(t, pw);
    for (let x = 0; x < s.w; x++) {
      const t = s.t0 + x / s.w * (s.t1 - s.t0), t2 = s.t0 + (x + 1) / s.w * (s.t1 - s.t0);
      const x0 = xOf(t), x1 = xOf(t2);
      const b = s.bid[x]!, a = s.ask[x]!;
      // The side with more liquidity is drawn brighter and the other dimmer, in proportion to the imbalance (no flip, so it does not flicker).
      const total = b + a, imbalance = total > 0 ? (b - a) / total : 0, strength = Math.min(1, Math.abs(imbalance) / 0.3);
      const bidAlpha = !cue ? 0.55 : 0.5 + (imbalance > 0 ? 0.45 : -0.28) * strength, askAlpha = !cue ? 0.55 : 0.5 + (imbalance < 0 ? 0.45 : -0.28) * strength;
      // Asks above the line and bids below it, as they sit on the chart and in the order book.
      if (a > 0) {
        const height = a / max * half;
        ctx.fillStyle = p.ask; ctx.globalAlpha = askAlpha; ctx.fillRect(x0, mid - height, x1 - x0 + 0.6, height);
        if (cue && imbalance < 0 && strength > 0.5) { ctx.globalAlpha = 1; ctx.fillRect(x0, mid - height, x1 - x0 + 0.6, 1.5); }
      }
      if (b > 0) {
        const height = b / max * half;
        ctx.fillStyle = p.bid; ctx.globalAlpha = bidAlpha; ctx.fillRect(x0, mid, x1 - x0 + 0.6, height);
        if (cue && imbalance > 0 && strength > 0.5) { ctx.globalAlpha = 1; ctx.fillRect(x0, mid + height - 1.5, x1 - x0 + 0.6, 1.5); }
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
  constructor(host: HTMLElement, store: Store, view: View) {
    super(host, store, view, 'oi');
    this.head.innerHTML = '<strong>Open Interest</strong><span class="readout"></span>';
    this.head.querySelector('strong')!.after(helpButton('oiPane'));
  }
  #analysis(oi: readonly OiBar[], highlight: HighlightOptions) {
    const key = `${highlight.mult}|${highlight.length}`;
    if (this.#cache && this.#cache.oi === oi && this.#cache.key === key) return this.#cache;
    const delta = new Float64Array(oi.length), size = new Float64Array(oi.length);
    for (let i = 1; i < oi.length; i++) { delta[i] = oi[i]![4] - oi[i - 1]![4]; size[i] = Math.abs(delta[i]!); }
    const found = anomalies(size, highlight);
    this.#cache = { oi, key, delta, flag: found.flag, sigma: found.sigma };
    return this.#cache;
  }
  protected draw(): void {
    const { ctx, palette: p, view: v } = this, pw = this.plotW, ph = this.h, state: AppState = this.store.state;
    const tf = TIMEFRAMES[state.timeframe] ?? 3_600_000, oi = state.oi, highlight = state.highlight;
    const readout = this.head.querySelector('.readout');
    const say = (html: string) => { if (readout) readout.innerHTML = html; };
    if (!oi.length) { ctx.fillStyle = p.muted; ctx.textAlign = 'left'; ctx.fillText('No open-interest history for this market yet.', 12, ph / 2); say(''); return; }
    const analysis = this.#analysis(oi, highlight);
    const visible: number[] = [];
    for (let i = 0; i < oi.length; i++) if (oi[i]![0] + tf >= v.t0 && oi[i]![0] <= v.t1) visible.push(i);
    if (!visible.length) { ctx.fillStyle = p.muted; ctx.textAlign = 'left'; ctx.fillText('No open-interest samples in view.', 12, ph / 2); say(''); return; }
    // Geometry: the level on top, the change below (when the pane is tall enough to hold both).
    const split = ph >= 84, lineBottom = split ? Math.round(ph * 0.6) : ph - 6, bandTop = lineBottom + 12, bandBottom = ph - 5, mid = (bandTop + bandBottom) / 2, half = (bandBottom - bandTop) / 2;
    let lo = Infinity, hi = -Infinity, maxDelta = 0;
    for (const i of visible) { const b = oi[i]!; lo = Math.min(lo, b[3], b[4]); hi = Math.max(hi, b[2], b[4]); maxDelta = Math.max(maxDelta, Math.abs(analysis.delta[i]!)); }
    const pad = Math.max((hi - lo) * 0.18, hi * 0.0004), min = lo - pad, max = hi + pad;
    const y = (value: number) => 6 + (1 - (value - min) / (max - min)) * (lineBottom - 6);
    // The sample of the candle still forming sits where its candle on the map does: over the part of its slot that has happened.
    const now = Date.now(), spanOf = (i: number) => candleSpan(oi[i]![0], tf, now);
    const xc = (i: number) => { const sp = spanOf(i); return v.xOf(sp.from + (sp.to - sp.from) / 2, pw); };
    const first = Math.max(0, visible[0]! - 1), last = visible[visible.length - 1]!;
    const lastBar = oi[oi.length - 1]!, newestCandle = state.candles[state.candles.length - 1];
    const reachT = Math.min(v.t1, Math.max(spanOf(oi.length - 1).to, newestCandle ? candleSpan(newestCandle[0], tf, now).to : 0));
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
        const x0 = v.xOf(oi[i - 1]![0] + tf, pw), x1 = v.xOf(spanOf(i).to, pw), h = Math.abs(d) / (maxDelta || 1) * half;
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
    line(first, last); ctx.lineTo(xSampled, y(lastBar[4])); ctx.lineTo(xSampled, lineBottom); ctx.lineTo(xc(first), lineBottom); ctx.closePath();
    ctx.globalAlpha = 0.09; ctx.fillStyle = p.accent; ctx.fill(); ctx.globalAlpha = 1;
    ctx.lineWidth = 1.6; ctx.strokeStyle = p.accent; line(first, last); ctx.lineTo(xSampled, y(lastBar[4])); ctx.stroke();
    if (xEnd > xSampled + 2) { ctx.globalAlpha = 0.55; ctx.setLineDash([4, 4]); ctx.beginPath(); ctx.moveTo(xSampled, y(lastBar[4])); ctx.lineTo(xEnd, y(lastBar[4])); ctx.stroke(); ctx.setLineDash([]); ctx.globalAlpha = 1; }
    ctx.lineWidth = 1;
    const spacing = visible.length > 1 ? (xc(visible[visible.length - 1]!) - xc(visible[0]!)) / (visible.length - 1) : 99;
    if (spacing >= 9) { ctx.fillStyle = p.accent; for (const i of visible) { ctx.beginPath(); ctx.arc(xc(i), y(oi[i]![4]), 2.4, 0, Math.PI * 2); ctx.fill(); } }
    ctx.restore();
    ctx.fillStyle = p.muted; ctx.textAlign = 'left';
    ctx.fillText(fmtPrice(max, 1), this.w - AXIS_W + 6, 10); ctx.fillText(fmtPrice(min, 1), this.w - AXIS_W + 6, lineBottom - 4);
    if (split) { ctx.fillText(`±${fmtPrice(maxDelta, 1)}`, this.w - AXIS_W + 6, mid); }
    // Readout: the hovered sample, else the newest, with where the data comes from and how old it is.
    const hover = state.hover;
    let shown = oi.length - 1;
    if (hover) { shown = -1; for (let i = 0; i < oi.length; i++) if (oi[i]![0] <= hover.t) shown = i; else break; if (shown < 0) shown = 0; }
    const bar = oi[shown]!, d = shown > 0 ? analysis.delta[shown]! : 0, flagged = highlight.on && analysis.flag[shown] === 1;
    const age = Date.now() - lastBar[0], stale = age > Math.max(3 * tf, 3 * 60_000);
    const sign = d > 0 ? '+' : d < 0 ? '−' : '';
    const source = state.oiInstrument && state.oiInstrument !== state.seriesInstrument ? ` <span class="muted">from ${venueLabel(state.oiInstrument)} ${state.oiInstrument.split(':').slice(1).join(':')}</span>` : '';
    const sigma = flagged && Number.isFinite(analysis.sigma[shown]) ? ` <span class="muted">${analysis.sigma[shown]!.toFixed(1)}σ</span>` : '';
    say(`base <b>${fmtPrice(bar[4], 1)}</b> Δ <b class="${d > 0 ? 'bid' : d < 0 ? 'ask' : ''}">${sign}${fmtPrice(Math.abs(d), 1)}</b>${sigma}${source}${stale ? ` <span class="ask">last sample ${Math.round(age / 60_000)} min ago</span>` : ''}`);
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
  constructor(host: HTMLElement, store: Store, view: View, private hub: Hub) {
    super(host, store, view, 'lt');
    this.head.innerHTML = '<strong>Liquidity Tracker</strong><span class="readout"></span>';
    this.head.querySelector('strong')!.after(helpButton('ltPane'));
    setTip(this.head.querySelector('strong')!, "Weighted USD liquidity near the touch of the aggregated book of the enabled venues. A level weighs 1 at the touch and halves every half-life. The size filter applies to a venue's aggregated size at one price bin, not to individual orders.");
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
    const size = (v: number, none: string, sign: string): [string, string] => [String(v), v === 0 ? none : `${sign} $${v >= 1e6 ? v / 1e6 + 'M' : v / 1e3 + 'k'}`];
    select('Half-life', "Distance from the touch, in basis points of price, at which a level's weight halves", HALF_LIVES.map(v => [String(v), `${v} bp`]), () => String(lt().halfLifeBp), v => patch({ halfLifeBp: Number(v) }));
    select('Min', 'Ignore price bins smaller than this', MIN_SIZES.map(v => size(v, 'any', '≥')), () => String(lt().minUsd), v => patch({ minUsd: Number(v) }));
    select('Max', 'Ignore price bins larger than this', MAX_SIZES.map(v => size(v, 'no cap', '≤')), () => String(lt().maxUsd), v => patch({ maxUsd: Number(v) }));
    const avg = document.createElement('label'); avg.className = 'ctl'; setTip(avg, 'Divide by the summed weights of the non-empty levels, as if each had size 1');
    const box = document.createElement('input'); box.type = 'checkbox'; box.checked = lt().average; box.onchange = () => patch({ average: box.checked });
    avg.append(box, 'Per level'); this.head.append(avg);
    this.#sync.push(() => { if (box.checked !== lt().average) box.checked = lt().average; });
    select('View', 'Bid and ask lines, or the imbalance (bid - ask) / (bid + ask)', [['lines', 'Bid & ask'], ['imbalance', 'Imbalance']], () => lt().view, v => patch({ view: v as AppState['lt']['view'] }));
  }
  /** Recompute on the next draw and reflect persisted settings in the controls. */
  refresh(): void { this.#key = ''; for (const sync of this.#sync) sync(); this.invalidate(); }

  protected draw(): void {
    const { ctx, palette: p, view: v } = this, pw = this.plotW, ph = this.h, state = this.store.state, lt = state.lt;
    const ids = activeIds(state);
    const emptyScope = emptyScopeMessage(state);
    if (emptyScope) { ctx.fillStyle = p.muted; ctx.textAlign = 'left'; ctx.fillText(emptyScope, 12, ph / 2); return; }
    const t0 = Math.floor(v.t0 / MINUTE) * MINUTE, t1 = Math.ceil(v.t1 / MINUTE) * MINUTE;
    const key = `${ids.join(',')}|${t0}|${t1}|${this.hub.columnsVersion}|${lt.halfLifeBp}|${lt.minUsd}|${lt.maxUsd}|${lt.average}`;
    const liveTail = v.t1 > Date.now() - 2 * MINUTE;
    if (ids.length && !this.#busy && (key !== this.#key || (liveTail && performance.now() - this.#lastAt > 1_500))) {
      this.#key = key; this.#busy = true; this.#lastAt = performance.now();
      const params = { halfLifeBp: lt.halfLifeBp, minUsd: lt.minUsd, maxUsd: lt.maxUsd, average: lt.average };
      void this.hub.lt(ids, t0, t1, params).then(r => { this.#series = { ...r, stepMs: this.hub.columnStepMs }; this.#busy = false; this.invalidate(); }, () => { this.#busy = false; });
    }
    const s = this.#series, readout = this.head.querySelector('.readout')!;
    if (!s || !s.times.length) { ctx.fillStyle = p.muted; ctx.fillText('Liquidity tracker is collecting…', 12, ph / 2); readout.textContent = ''; return; }
    const n = s.times.length, step = s.stepMs, xOf = (t: number) => v.xOf(t + step / 2, pw), gap = step * 2.5;
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
    readout.innerHTML = `Bid <b class="bid">${usd(b)}</b> Ask <b class="ask">${usd(a)}</b> Δ <b>${usd(b - a)}</b> imb <b>${total > 0 ? Math.round((b - a) / total * 100) : 0}%</b> · ${ids.length} venues`;
  }
}

const hexMix = (a: string, b: string, t: number): string => {
  const pa = parseInt(a.slice(1), 16), pb = parseInt(b.slice(1), 16), k = Math.max(0, Math.min(1, t));
  const channel = (shift: number) => Math.round(((pa >> shift) & 255) * (1 - k) + ((pb >> shift) & 255) * k);
  return '#' + [channel(16), channel(8), channel(0)].map(v => v.toString(16).padStart(2, '0')).join('');
};
/** Strip under the chart with the enabled per-candle statistics, aligned to the candle slots (footprint on); the Stats button chooses, orders and configures them. */
export class BarStatsPane extends TimePane {
  #button = document.createElement('button');
  #panel: Panel | null = null;
  constructor(host: HTMLElement, store: Store, view: View, private heat: HeatPane) {
    super(host, store, view, 'bars');
    this.head.innerHTML = '<strong>Bar stats</strong><span class="readout"></span>';
    this.head.querySelector('strong')!.after(helpButton('barStats'));
    this.#button.textContent = 'Stats'; setTip(this.#button, 'Choose, order and configure the statistics shown for each candle');
    this.#button.onclick = () => { this.#panel = togglePanel(this.#button, { title: 'Bar stats', width: 440, align: 'right', onClose: () => { this.#panel = null; } }, (tools, body) => this.#build(tools, body)); };
    this.head.append(this.#button);
  }
  /** Redraw after the configuration changed and keep an open panel in step. */
  refresh(): void { this.#panel?.render((tools, body) => this.#build(tools, body)); this.invalidate(); }

  #build(tools: HTMLElement, body: HTMLElement): void {
    const state = this.store.state, options = state.barStatOptions;
    const chosen = enabledStats(state.barStats).map(def => def.id);
    const setStats = (ids: string[]) => this.store.set({ barStats: ids });
    const setOptions = (change: Partial<StatOptions>) => this.store.set({ barStatOptions: { ...this.store.state.barStatOptions, ...change } });

    for (const [label, ids] of [['Default', PRESETS.default], ['All', PRESETS.all], ['None', PRESETS.none]] as const) tools.append(button(label, () => setStats([...ids])));
    tools.append(el('span', { class: 'muted', textContent: `${chosen.length} of ${BAR_STATS.length} shown` }));

    body.append(heading('Shown, in order'));
    if (!chosen.length) body.append(note('Nothing selected: tick statistics below to add them.'));
    else {
      body.append(note('The strip shows them top to bottom in this order. Drag a row by its dots to reorder it (or focus the dots and press the up and down arrow keys); × hides it.'));
      body.append(sortableList(chosen.map(id => { const def = statDef(id)!; return { id, label: def.label, title: def.title }; }), setStats, id => setStats(chosen.filter(x => x !== id))));
    }

    for (const group of Object.keys(GROUP_TITLES) as StatGroup[]) {
      body.append(heading(GROUP_TITLES[group]));
      for (const def of BAR_STATS.filter(d => d.group === group))
        body.append(checkRow(def.label, def.title, chosen.includes(def.id), on => setStats(on ? [...chosen, def.id] : chosen.filter(id => id !== def.id))));
    }

    body.append(heading('Options'));
    body.append(
      selectRow('Cells', 'Filled cells are shaded by magnitude (log scale between the visible 2nd and 99th percentile); text only is coloured by sign', [['filled', 'Filled'], ['text', 'Text only']], options.cells, v => setOptions({ cells: v as StatOptions['cells'] })),
      selectRow('OI change in', "Open-interest change in base coin (the series' own unit) or as USD (change times the bar's close)", [['base', 'Base coin'], ['usd', 'USD']], options.oiUnits, v => setOptions({ oiUnits: v as StatOptions['oiUnits'] })),
      numberRow('Imbalance ratio', 'A level counts as imbalanced when its volume is at least this many times the opposite volume one row away', { min: 1, step: 0.5, value: options.imbRatio }, v => setOptions({ imbRatio: v })),
      numberRow('Imbalance min USD', 'Ignore imbalanced levels smaller than this', { min: 0, step: 1000, value: options.imbMinUsd }, v => setOptions({ imbMinUsd: v })),
      numberRow('Stacked rows', 'Adjacent imbalanced rows on one side that count as a stack', { min: 2, step: 1, value: options.stackedN }, v => setOptions({ stackedN: Math.round(v) })),
    );
    const buckets = SIZE_BUCKET_LABELS.map((label, i): [string, string] => [String(i), label]);
    body.append(
      selectRow('Retail up to', 'Trades in this size bucket and below are retail (delta retail, cvd retail)', buckets, String(options.retailMax), v => { const r = Number(v); setOptions({ retailMax: r, whaleMin: Math.max(options.whaleMin, Math.min(7, r + 1)) }); }),
      selectRow('Whales from', 'Trades in this size bucket and above are whales (delta whales, cvd whales)', buckets, String(options.whaleMin), v => { const w = Number(v); setOptions({ whaleMin: w, retailMax: Math.min(options.retailMax, Math.max(0, w - 1)) }); }),
    );
  }

  protected draw(): void {
    const { ctx, palette: p, view: v } = this, pw = this.plotW, ph = this.h, state = this.store.state;
    const tfMs = TIMEFRAMES[state.timeframe] ?? 3_600_000, defs = enabledStats(state.barStats), options = state.barStatOptions;
    const readout = this.head.querySelector('.readout');
    if (readout) readout.textContent = `${defs.length} stat${defs.length === 1 ? '' : 's'} · cvd sums the bars loaded for the view`;
    if (!defs.length) { ctx.fillStyle = p.muted; ctx.fillText('No statistics selected: use Stats to add some.', 12, ph / 2); return; }
    const data = this.heat.footprintData, all = [...data.bars.values()].sort((a, b) => a.t - b.t);
    if (!all.length) { ctx.fillStyle = p.muted; ctx.fillText('Bar stats appear once the footprint has executions for the visible candles.', 12, ph / 2); return; }
    const input = { bars: all, step: data.step, options, candles: new Map(state.candles.map(c => [c[0], c] as const)), oi: new Map(state.oi.map(b => [b[0], b] as const)) };
    const slot = pw * tfMs / (v.t1 - v.t0), top = 3, rowH = Math.max(15, (ph - 6) / defs.length), filled = options.cells === 'filled';
    const visible = all.map((bar, i) => i).filter(i => all[i]!.t + tfMs >= v.t0 && all[i]!.t <= v.t1);
    if (!visible.length) { ctx.fillStyle = p.muted; ctx.fillText('No executions recorded for the candles in view.', 12, ph / 2); return; }
    ctx.textBaseline = 'middle'; ctx.textAlign = 'center'; ctx.font = '11px ui-monospace, SFMono-Regular, Menlo, monospace';
    defs.forEach((def, rowIndex) => {
      const values = def.compute(input), scale = rowScale(def, visible.map(i => values[i]));
      const unusual = state.highlight.on && def.scale !== 'plain' ? anomalies(Float64Array.from(values, value => value === null || value === undefined ? NaN : Math.abs(value)), state.highlight).flag : null;
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
    ctx.textAlign = 'left'; ctx.font = '10px ui-sans-serif, system-ui, sans-serif';
    defs.forEach((def, i) => { const y = top + i * rowH, w = ctx.measureText(def.label).width + 10; ctx.globalAlpha = 0.88; ctx.fillStyle = p.panel; ctx.fillRect(2, y + 2, w, rowH - 5); ctx.globalAlpha = 1; ctx.fillStyle = p.muted; ctx.fillText(def.label, 6, y + (rowH - 1) / 2); });
  }
}
