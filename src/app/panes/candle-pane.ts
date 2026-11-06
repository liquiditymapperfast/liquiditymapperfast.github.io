import type { Hub } from '../hub.ts';
import type { AppState, Store } from '../store.ts';
import type { Kernels } from '../kernels.ts';
import { volText } from './footprint.ts';
import { groupLevels, type Grouped } from './levels-data.ts';
import { setText } from './lower-panes.ts';
import { activeIds } from '../scope.ts';
import { PALETTES, mixHex, resolveThemeId, rgb, textOn, type Palette } from '../theme.ts';
import { t } from '../i18n.ts';
import { helpButton } from '../help.ts';
import { el } from '../dom.ts';
import { GestureRecognizer, bindTouch } from '../touch.ts';
import { replaying } from '../replay/clock.ts';
import { price as fmtPrice } from '../format.ts';
import { scaledUsd } from '../coin.ts';
import { drawVenueMark } from '../venue-marks.ts';
import { niceStep } from '../view.ts';
import { STRIDE, type TapeRing } from '../tape/ring.ts';
import { ROW_TEXELS, TrailGL, type FlashSprite } from '../candle/trail-gl.ts';
import { strengthGain } from '../glass/waves.ts';
import * as M from '../candle/model.ts';

const NUM_FONT = '10.5px ui-monospace, SFMono-Regular, Menlo, monospace', BOLD_NUM = `700 ${NUM_FONT}`;
const SMALL_FONT = '10px ui-sans-serif, system-ui, sans-serif';
/** How long an arrival keeps its tick on the rail (ms), after its flash has gone. */
const RAIL_MS = 2_500;
/** The fewest ms between two drawings of the book and candle (the price ticks many times a second). */
const PAINT_MS = 50;
/** The most exchange marks in the trail at once (its newest whale-sized orders). */
const MAX_TRAIL_MARKS = 10;

/**
 * The phone's Tape view (a tab of its own, see dock.ts; it was the Candle view until 2026-10-17): one continuous tape of the market since
 * the page opened, filling the screen's price axis, the live book on both sides, the price line, the arrival rail where large orders flash
 * as they come in, and behind all of it the trade trail of the last seconds (candle/trail-gl.ts) flowing from the rail to the left edge.
 * Every column and scale is worked out in candle/model.ts.
 *
 * The middle column is the tape: every market order the page has received since it opened (candle/model.ts `TapeTally`), bought against
 * sold at each price, for the markets the map's footprint counts. Nothing is fetched and nothing resets (Karl, 2026-10-17: the page opens
 * at once, and a bar that starts again every minute broke the flow); a page that was hidden got no orders meanwhile, and the header says
 * how long that was. The tape is kept whether the view shows or not; drawing, timers and asking happen only while it shows.
 *
 * Venues: the small orders stay anonymous dots; an order from the Bar stats' whale size up carries its exchange's mark beside it in the
 * trail, fading with it, and the largest flashes on the rail show the mark of the exchange that sent them for a moment. They are drawn on
 * a canvas of their own between the trail and the book, at the trail's pace, so the book and the tape are not redrawn for them.
 */
/** A palette's colours as the trail's renderer takes them (0-1 RGB). */
interface RendererTones { p: Palette; bid: [number, number, number]; ask: [number, number, number]; mid: [number, number, number]; bookBid: [number, number, number]; bookAsk: [number, number, number] }

export class CandlePane {
  readonly root = el('div', { class: 'pane candle' });
  readonly header: HTMLElement;
  #body = el('div', { class: 'candle-body' });
  #trailCanvas = el('canvas', { class: 'candle-trail' });
  #marks = el('canvas', { class: 'candle-marks' });
  #canvas = el('canvas', { class: 'candle-fg' });
  #ctx: CanvasRenderingContext2D; #marksCtx: CanvasRenderingContext2D;
  /** The stretches of the column frosted milky on the glass (CSS px): none for the tape, which shows what the page has received. */
  #frost: { y0: number; y1: number }[] = [];
  /** The book's rows per device row for the glass (trail-gl.ts `setRows`: the bars, their pulses, the bars before), reused; and whether the glass holds any. */
  #brickRows = new Float32Array(0); #rowsLive = false;
  /**
   * Liquidity added and pulled per row (candle/model.ts `PulseTracker`), fed once per levels frame (`#pulseAsOf`) on the row step it was
   * started for; the price's path over the last window, for the rows it passed; and the clock the glass's pulses are timed on.
   */
  #pulses = new M.PulseTracker(); #pulseStep = 0; #pulseAsOf = 0; #pulseBase = performance.now(); #pulseBooks = '';
  #markPath: { t: number; price: number }[] = [];
  /** The trail's renderer; whether it cannot run here (no WebGL2), or its context is lost until the browser gives it back. */
  #trail: TrailGL | null = null; #trailFailed = false; #trailLost = false; #trailRing: TapeRing | null = null;
  #readout = el('span', { class: 'readout' });
  #settings: M.CandleSettings;
  /** The tape since the page opened, how far into the ring it has read, and what it missed while the page was hidden (no orders came meanwhile). */
  #tape = new M.TapeTally(Date.now()); #tapeSeen = 0; #gaps = new M.TapeGaps(Date.now(), document.hidden);
  #palette: Palette = PALETTES.dark!;
  #w = 0; #h = 0; #dpr = 1;
  #shown = false; #frame = 0; #paintTimer = 0; #lastPaint = 0; #trailRaf = 0; #trailTimer = 0; #trailChain = 0; #trailDrawn = 0; #trailDirty = false; #marksDrawn = false;
  #zoom = 1; #zoom0 = 1; #pan = 0;
  #layout: M.CandleLayout | null = null; #scale: M.PriceScale | null = null; #step = 0;
  /** The book's venues in a held order (most liquidity in view first), kept for a minute so a venue's piece keeps its place. */
  #maskKey = '';
  #reduced = typeof matchMedia === 'function' ? matchMedia('(prefers-reduced-motion: reduce)') : null;

  constructor(parent: HTMLElement, private store: Store, private hub: Hub, private kernels: Kernels, private markets: (state: AppState) => string[]) {
    let saved: unknown = null;
    try { saved = JSON.parse(window.localStorage.getItem(M.CANDLE_SETTINGS_KEY) ?? 'null'); } catch { saved = null; }
    this.#settings = M.readCandleSettings(saved);
    // A look to try from the address (?rows=delta&pulse=deposit&glass=bricks): a phone has no console. It is kept like a choice in Settings.
    const asked = new URLSearchParams(location.search), tried: Record<string, string> = {};
    for (const k of ['rows', 'pulse', 'glass', 'style'] as const) { const v = asked.get(k); if (v) tried[k] = v; }
    if (Object.keys(tried).length) { this.#settings = M.readCandleSettings({ ...this.#settings, ...tried }); try { window.localStorage.setItem(M.CANDLE_SETTINGS_KEY, JSON.stringify(this.#settings)); } catch { /* storage unavailable */ } }
    // The header is the readout alone (Karl, 2026-10-17): the view's choices are in Settings (`settingsFields`), so the tape has the screen.
    this.header = el('div', { class: 'pane-head' },
      el('strong', { textContent: t('Tape') }),
      helpButton('candlePane'),
      this.#readout);
    this.#body.append(this.#trailCanvas, this.#marks, this.#canvas);
    this.root.append(this.header, this.#body);
    parent.append(this.root);
    this.#ctx = this.#canvas.getContext('2d')!; this.#marksCtx = this.#marks.getContext('2d')!;
    new ResizeObserver(() => this.#resize()).observe(this.#body);
    this.#bindGestures();
    document.addEventListener('visibilitychange', () => {
      // A phone suspends a page in the background and no orders come: the tape has a gap there, which the header owns up to (`TapeGaps`).
      if (document.hidden) { this.#gaps.hide(Date.now()); return; }
      this.#gaps.show(Date.now());
      if (!this.#shown) return;
      this.invalidate(); this.#scheduleTrail(0);
    });
    // The card can take a context back (a phone short of memory does): the glass then falls back to the page's canvas, as where WebGL2 is
    // missing, the book's fill included, until the context is given back; then the renderer is made again whole (`#ensureTrail`).
    this.#trailCanvas.addEventListener('webglcontextlost', e => {
      e.preventDefault();
      this.#trailLost = true; this.#trail = null; this.#trailRing = null; this.#rowsLive = false;
      this.invalidate();
    });
    this.#trailCanvas.addEventListener('webglcontextrestored', () => { this.#trailLost = false; this.invalidate(); this.#scheduleTrail(0); });
  }

  /** The view's choices as labelled controls, made afresh for each opening of Settings (the toolbar lays them out as its own rows). */
  settingsFields(): [string, HTMLSelectElement][] {
    const s = this.#settings;
    const select = (label: string, options: [string, string][], value: string, change: (v: string) => void): [string, HTMLSelectElement] => {
      const box = el('select', { ariaLabel: label, onchange: () => change(box.value) });
      for (const [v, text] of options) box.append(el('option', { value: v, textContent: text }));
      box.value = value;
      return [label, box];
    };
    return [
      select(t('Look'), [['phosphor', t('Phosphor')], ['etched', t('Etched')], ['beads', t('Beads')]], s.style, v => this.#set({ style: v as M.TrailStyle })),
      select(t('Trail'), M.TRAIL_WINDOWS.map(ms => [String(ms), ms < 60_000 ? t('{n} s', { n: ms / 1000 }) : t('{n} min', { n: ms / 60_000 })]), String(s.trailMs), v => this.#set({ trailMs: Number(v) })),
      select(t('Glass'), [['off', t('Off')], ['panes', t('Panes')], ['bricks', t('Bricks')]], s.glass, v => this.#set({ glass: v as M.GlassKind })),
      select(t('Rows'), [['glow', t('Glow')], ['lean', t('Lean')], ['delta', t('Delta')]], s.rows, v => this.#set({ rows: v as M.RowLook })),
      select(t('Pulses'), [['pressure', t('Pressure')], ['deposit', t('Deposit')], ['off', t('Off')]], s.pulse, v => this.#set({ pulse: v as M.PulseLook })),
    ];
  }

  #set(patch: Partial<M.CandleSettings>): void {
    const next = M.readCandleSettings({ ...this.#settings, ...patch });
    this.#settings = next;
    try { window.localStorage.setItem(M.CANDLE_SETTINGS_KEY, JSON.stringify(next)); } catch { /* storage unavailable */ }
    this.invalidate(); this.#scheduleTrail(0);
  }

  /** The pulses of the glass book as they stand, for a look from the console. */
  get pulses(): ReadonlyMap<string, M.Pulse> { return this.#pulses.pulses; }

  /** Settings from outside the header (a look tried from the console or a test page), checked as a saved value is. */
  applySettings(patch: Partial<M.CandleSettings>): void { this.#set(patch); }

  setPalette(name: string): void { this.#palette = PALETTES[resolveThemeId(name)] ?? PALETTES.dark!; this.invalidate(); this.#scheduleTrail(0); }

  /** Shown or not (the phone's tab is this view's): only a shown view draws (the tape is kept either way). */
  setShown(on: boolean): void {
    if (on === this.#shown) return;
    this.#shown = on;
    if (on) { this.#resize(); this.invalidate(); this.#scheduleTrail(0); }
    else {
      this.#cancelTrail(); window.clearTimeout(this.#paintTimer); this.#paintTimer = 0;
      if (this.#frame) { cancelAnimationFrame(this.#frame); this.#frame = 0; }
    }
  }
  get shown(): boolean { return this.#shown; }

  /** The market changed: the view starts from its whole span again. */
  marketChanged(): void { this.#zoom = 1; this.#pan = 0; this.invalidate(); }

  /**
   * Orders arrived: into the tape whether the view shows or not; when it shows on a page that shows, to the trail on its next frame, the
   * rail with the book and the waves. Orders that came while it did not are passed over for the waves, never sent at once on its return.
   */
  tapeArrived(): void {
    this.#feedTape();
    if (!this.#shown || document.hidden) { this.#waveSeen = this.hub.tape?.written ?? 0; return; }
    this.#waveArrivals(); this.#scheduleTrail(0); this.invalidate();
  }

  /** The ring's new orders into the tape, each once (a ring started again is read from its start). */
  #feedTape(): void {
    const ring = this.hub.tape; if (!ring) return;
    if (ring.written < this.#tapeSeen) this.#tapeSeen = 0;
    if (ring.written > this.#tapeSeen) this.#gaps.arrived(Date.now());
    const d = ring.data;
    for (let k = Math.max(this.#tapeSeen, ring.first); k < ring.written; k++) {
      const at = (k % ring.capacity) * STRIDE, id = ring.ids[d[at + 3]!], off = d[at + 1]!;
      if (id) this.#tape.add(id, ring.p0 + off, d[at + 2]!, M.ringSlack(off));
    }
    this.#tapeSeen = ring.written;
  }

  /**
   * Large orders just arrived start waves through the glass from the rail, at their price (Karl, 2026-10-17: the ripples of the page's
   * glass, here too): as large as the order, a buy's or a sell's; only for the view's markets, and not with reduced motion. `#waveSeen` is
   * the ring's write number read up to, moved on with every arrival whether the view shows or not (`tapeArrived`).
   */
  #waveSeen = 0;
  #waveArrivals(): void {
    const ring = this.hub.tape, trail = this.#trail, l = this.#layout, s = this.#scale;
    if (!ring) return;
    const from = Math.max(this.#waveSeen, ring.first, ring.written - 4000); this.#waveSeen = ring.written;
    if (!trail || !l || !s || !this.#glassOn() || this.#reduced?.matches || replaying()) return;
    const hidden = this.#hiddenOf(ring), d = ring.data, min = scaledUsd(25_000);
    for (let k = from; k < ring.written; k++) {
      const at = (k % ring.capacity) * STRIDE, usd = d[at + 2]!;
      if (!(Math.abs(usd) >= min) || hidden.has(d[at + 3]!)) continue;
      const y = M.yOf(s, ring.p0 + d[at + 1]!);
      if (y >= s.y0 && y <= s.y1) trail.wave(l.railX0 + 10.5, y, usd, min, usd > 0 ? 0 : 1);
    }
  }

  invalidate(): void {
    if (!this.#shown || this.#frame || this.#paintTimer) return;
    const wait = PAINT_MS - (performance.now() - this.#lastPaint);
    if (wait > 0) this.#paintTimer = window.setTimeout(() => { this.#paintTimer = 0; this.invalidate(); }, wait);
    else this.#frame = requestAnimationFrame(() => { this.#frame = 0; this.#paint(); });
  }

  #resize(): void {
    const rect = this.#body.getBoundingClientRect();
    this.#w = Math.floor(rect.width); this.#h = Math.floor(rect.height);
    // Text is crisp at two device pixels to a CSS pixel; the trail's glow gains nothing past one and a half.
    this.#dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.#canvas.width = Math.max(1, Math.round(this.#w * this.#dpr)); this.#canvas.height = Math.max(1, Math.round(this.#h * this.#dpr));
    this.#canvas.style.width = `${this.#w}px`; this.#canvas.style.height = `${this.#h}px`;
    this.#marks.width = this.#canvas.width; this.#marks.height = this.#canvas.height; this.#marks.style.width = this.#canvas.style.width; this.#marks.style.height = this.#canvas.style.height;
    this.#trail?.resize(this.#w, this.#h, Math.min(this.#dpr, 1.5));
    this.invalidate(); this.#scheduleTrail(0);
  }

  #bindGestures(): void {
    const panBy = (dy: number): void => {
      const s = this.#scale; if (!s) return;
      const span = s.p1 - s.p0;
      this.#pan = Math.max(-span * 0.45, Math.min(span * 0.45, this.#pan + dy * span / (s.y1 - s.y0)));
      this.invalidate(); this.#scheduleTrail(0);
    };
    const zoomTo = (z: number): void => { this.#zoom = Math.max(0.2, Math.min(8, z)); this.invalidate(); this.#scheduleTrail(0); };
    const reset = (): void => { this.#zoom = 1; this.#pan = 0; this.invalidate(); this.#scheduleTrail(0); };
    bindTouch(this.#canvas, new GestureRecognizer({
      pinchStart: () => { this.#zoom0 = this.#zoom; },
      // Fingers moving apart show fewer prices: the span shrinks as the vertical separation grows.
      pinch: info => { if (info.start.dy > 24 && info.now.dy > 24) zoomTo(this.#zoom0 * info.start.dy / info.now.dy); },
      pan: delta => panBy(delta.y),
      doubleTap: reset,
    }));
    // A mouse (a narrow desktop window gets the phone's arrangement): the wheel zooms, a drag moves, a double click resets.
    this.#canvas.addEventListener('wheel', e => { e.preventDefault(); zoomTo(this.#zoom * Math.exp(e.deltaY * 0.0015)); }, { passive: false });
    this.#canvas.addEventListener('pointerdown', e => {
      if (e.pointerType === 'touch' || e.button !== 0) return;
      let last = e.clientY;
      const move = (m: PointerEvent): void => { panBy(m.clientY - last); last = m.clientY; };
      const up = (): void => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); };
      window.addEventListener('pointermove', move); window.addEventListener('pointerup', up);
    });
    this.#canvas.addEventListener('dblclick', reset);
  }

  #paint(): void {
    this.#lastPaint = performance.now();
    const w = this.#w, h = this.#h, ctx = this.#ctx, p = this.#palette, state = this.store.state;
    if (!this.#shown || w < 120 || h < 120) return;
    ctx.setTransform(this.#dpr, 0, 0, this.#dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    const l = M.candleLayout(w, h); this.#layout = l;
    if (replaying()) { this.#scale = null; this.#message(ctx, l, t('The Tape view shows the live market only.')); return; }
    const mark = state.mark.price, range = this.#tape.range;
    if (!(mark > 0) && !range) { this.#scale = null; this.#message(ctx, l, t('Waiting for the market…')); return; }
    // Every price the tape traded at, and the price now, in view (pinch and drag move from there).
    const lo = Math.min(range?.lo ?? mark, mark > 0 ? mark : Infinity), hi = Math.max(range?.hi ?? mark, mark > 0 ? mark : -Infinity);
    const scale = M.priceSpan(lo, hi, mark > 0 ? mark : (lo + hi) / 2, l.plotY0, l.plotY1, this.#zoom, this.#pan); this.#scale = scale;
    const markets = this.markets(state); this.#marketsNow = markets;
    const fine = this.#tape.fine, step = fine > 0 ? M.rowStepFor(fine, scale) : niceStep(scale.p1 - scale.p0, (scale.y1 - scale.y0) / 18); this.#step = step;
    const rows = this.#tape.rows(step, markets);
    this.#paintRuler(ctx, l, p);
    ctx.save(); ctx.beginPath(); ctx.rect(0, l.plotY0, l.axisX0, l.plotY1 - l.plotY0); ctx.clip();
    this.#paintBook(ctx, l, scale, step, mark, state, p);
    this.#paintTape(ctx, l, scale, rows, step, p);
    this.#paintRail(ctx, l, scale, step, p);
    ctx.restore();
    this.#paintAxis(ctx, l, scale, mark, { o: this.#tape.first || mark, c: mark }, p);
    this.#writeReadout(markets.length);
    this.#scheduleTrail(0);
  }

  #message(ctx: CanvasRenderingContext2D, l: M.CandleLayout, text: string): void {
    ctx.fillStyle = this.#palette.muted; ctx.font = '13px ui-sans-serif, system-ui, sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText(text, l.w / 2, l.h / 2);
    this.#trail?.clear();
  }

  /** The header: since when the tape runs, how many markets it counts, and how long it missed while the page was hidden (its gaps), if it did. */
  #writeReadout(markets: number): void {
    if (!this.#shown) return;
    const since = new Date(this.#tape.since), clock = `${String(since.getHours()).padStart(2, '0')}:${String(since.getMinutes()).padStart(2, '0')}`;
    const parts = [t('since {time}', { time: clock }), t('{n} markets', { n: markets })], missed = this.#gaps.missedMs;
    if (missed > 0) parts.push(t('{n} min missed while hidden', { n: Math.max(1, Math.round(missed / 60_000)) }));
    setText(this.#readout, parts.join(' · '));
  }

  /** The age ruler under the trail: now at the rail, then every quarter of the window. */
  #paintRuler(ctx: CanvasRenderingContext2D, l: M.CandleLayout, p: Palette): void {
    const y = l.plotY1 + 4;
    ctx.strokeStyle = p.line; ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(l.trailX0, y + 0.5); ctx.lineTo(l.trailX1, y + 0.5); ctx.stroke();
    ctx.font = SMALL_FONT; ctx.fillStyle = p.muted; ctx.textBaseline = 'top';
    for (const tick of M.ageTicks(this.#settings.trailMs)) {
      const x = M.trailX(l, tick.ms, this.#settings.trailMs);
      ctx.fillRect(Math.round(x) - 0.5, y, 1, 4);
      ctx.textAlign = tick.ms === 0 ? 'right' : tick.ms >= this.#settings.trailMs ? 'left' : 'center';
      ctx.fillText(tick.seconds === 0 ? t('now') : t('{n} s', { n: tick.seconds }), Math.max(2, Math.min(l.trailX1, x)), y + 5);
    }
  }

  /**
   * Feed the pulse tracker a levels frame it has not seen (`asOf`): every row in view of either side with its resting USD, the rows a
   * matching trade of the view's markets reached in the last window (a buy reaches the asks it walked, a sell the bids) and the rows the
   * price passed in it. A new row step starts the tracker again. Returns the pulses as they stand.
   */
  #trackPulses(g: Grouped, step: number, mark: number, markBin: number, asOf: number): ReadonlyMap<string, M.Pulse> {
    if (this.#settings.glass === 'off' || this.#settings.pulse === 'off') return this.#pulses.pulses;
    const now = performance.now();
    // The shader's times count from this clock; moved up while no pulse is out, so a page open for days keeps them exact in a float.
    if (!this.#pulses.pulses.size && now - this.#pulseBase > 3_600_000) this.#pulseBase = now;
    this.#markPath.push({ t: now, price: mark });
    while (this.#markPath.length > 1 && this.#markPath[0]!.t < now - M.PULSE_WINDOW_MS) this.#markPath.shift();
    if (step !== this.#pulseStep) { this.#pulses.reset(); this.#pulseStep = step; }
    if (asOf === this.#pulseAsOf) return this.#pulses.pulses;
    this.#pulseAsOf = asOf;
    // Other books in the totals (a venue switched on or off, the Spot / Perp filter) change every row at once: that is not liquidity moving.
    const books = g.ids.join(',');
    if (books !== this.#pulseBooks) { this.#pulses.reset(); this.#pulseBooks = books; }
    const rows = new Map<string, { side: 'bid' | 'ask'; usd: number }>();
    for (let i = 0; i < g.nBins; i++) {
      const bin = g.bin0 + i;
      if (bin >= markBin) rows.set(`ask:${bin}`, { side: 'ask', usd: g.totalAsk[i]! });
      if (bin <= markBin) rows.set(`bid:${bin}`, { side: 'bid', usd: g.totalBid[i]! });
    }
    const traded = new Set<string>(), ring = this.hub.tape;
    if (ring && ring.written > 0) {
      const hidden = this.#hiddenOf(ring), src = this.hub.sourceNow(), d = ring.data;
      for (const [a, b] of ring.runs(src - M.PULSE_WINDOW_MS, src + 2_000)) for (let k = a; k < b; k++) {
        const at = (k % ring.capacity) * STRIDE;
        if (hidden.has(d[at + 3]!) || ring.t0 + d[at]! < src - M.PULSE_WINDOW_MS) continue;
        const side = d[at + 2]! > 0 ? 'ask' : 'bid', lo = Math.floor((ring.p0 + d[at + 4]!) / step), hi = Math.floor((ring.p0 + d[at + 5]!) / step);
        for (let bin = lo; bin <= hi && bin - lo < 64; bin++) traded.add(`${side}:${bin}`);
      }
    }
    const touched = new Set<string>();
    let pLo = Infinity, pHi = -Infinity; for (const m of this.#markPath) { pLo = Math.min(pLo, m.price); pHi = Math.max(pHi, m.price); }
    if (pHi >= pLo) for (let bin = Math.floor(pLo / step); bin <= Math.floor(pHi / step) && bin - Math.floor(pLo / step) < 256; bin++) { touched.add(`ask:${bin}`); touched.add(`bid:${bin}`); }
    this.#pulses.frame(now, rows, traded, touched, scaledUsd(10_000));
    return this.#pulses.pulses;
  }

  /**
   * No book to draw: the glass's rows emptied too, or its fill (the shader's, on glass) would stay behind with no outline over it.
   */
  #clearGlassRows(): void {
    const trail = this.#trail; if (!trail || !this.#rowsLive) return;
    const H = this.#trailCanvas.height, n = Math.max(1, H) * 4 * ROW_TEXELS;
    if (this.#brickRows.length !== n) this.#brickRows = new Float32Array(n); else this.#brickRows.fill(0);
    trail.setRows(this.#brickRows, H); this.#rowsLive = false;
  }

  /** The live book on the rows of the footprint: asks above the price growing right of the candle, bids below growing left. */
  #paintBook(ctx: CanvasRenderingContext2D, l: M.CandleLayout, s: M.PriceScale, step: number, mark: number, state: AppState, p: Palette): void {
    const frame = state.levels; if (!frame || !(mark > 0) || !(step > 0)) { this.#clearGlassRows(); return; }
    const g = groupLevels(this.kernels, frame, activeIds(state), step, s.p0, s.p1);
    if (!g.ids.length) { this.#clearGlassRows(); return; }
    // The book's rows are the levels kernel's, which puts a level at one price in its row by plain division (crates/hlm-kernels
    // `spread_levels`), so the price's row is found the same way: forgiven as the tape's rows are, an ask at the price itself could fall
    // below the row the asks start from. The tape and the rail take the footprint's rule (shared/footprint.ts `binOf`).
    const markBin = Math.floor(mark / step);
    let max = 0;
    const top: { side: 'bid' | 'ask'; i: number; usd: number }[] = [];
    for (let i = 0; i < g.nBins; i++) {
      const bin = g.bin0 + i, y = M.yOf(s, (bin + 0.5) * step); if (y < s.y0 || y > s.y1) continue;
      if (bin >= markBin) { max = Math.max(max, g.totalAsk[i]!); top.push({ side: 'ask', i, usd: g.totalAsk[i]! }); }
      if (bin <= markBin) { max = Math.max(max, g.totalBid[i]!); top.push({ side: 'bid', i, usd: g.totalBid[i]! }); }
    }
    if (!(max > 0)) { this.#clearGlassRows(); return; }
    // The book is the setting, the candle the subject: each side a silhouette, one faint fill under a crisp outer edge, so the trail behind
    // it stays readable and the shape of the book reads at a glance. Its exchanges are the Book tab's: shaded pieces here read as two
    // tones of one book (Karl, 2026-10-16).
    const sideW = l.bidX1 - l.bidX0, rowPx = step * (s.y1 - s.y0) / (s.p1 - s.p0), bricks = this.#settings.glass === 'bricks';
    const trail = this.#trail, tdpr = trail?.dpr ?? 1, H = this.#trailCanvas.height, glassRows = this.#settings.glass !== 'off' && trail !== null;
    if (glassRows) { if (this.#brickRows.length !== H * 4 * ROW_TEXELS) this.#brickRows = new Float32Array(H * 4 * ROW_TEXELS); else this.#brickRows.fill(0); }
    const pulses = this.#trackPulses(g, step, mark, markBin, frame.asOf);
    for (const side of ['ask', 'bid'] as const) {
      const color = side === 'ask' ? p.ask : p.bid, edge: { y0: number; y1: number; w: number }[] = [];
      for (let i = 0; i < g.nBins; i++) {
        const bin = g.bin0 + i; if (side === 'ask' ? bin < markBin : bin > markBin) continue;
        const y0 = M.yOf(s, (bin + 1) * step), y1 = y0 + rowPx; if (y1 < s.y0 || y0 > s.y1) continue;
        const total = side === 'ask' ? g.totalAsk[i]! : g.totalBid[i]!;
        edge.push({ y0, y1, w: total / max * sideW });
        const key = `${side}:${bin}`, pulse = pulses.get(key);
        if (glassRows && (total > 0 || pulse)) {
          // The row on the glass: its bar, its pulse (sign times strength, 2 more when traded; when it began), its bar before the change.
          // A brick leaves a device row's gap below it; a pane's rows meet.
          const r0 = Math.max(0, Math.round(y0 * tdpr)), r1 = Math.min(H, Math.round((y0 + rowPx) * tdpr) - (bricks ? 1 : 0)), bidSide = side === 'bid';
          for (let r = r0; r < r1; r++) {
            const at = r * 4 * ROW_TEXELS, b = this.#brickRows;
            b[at + (bidSide ? 0 : 1)] = total / max * sideW * tdpr; b[at + 2] = r + 0.5 - r0; b[at + 3] = r1 - (r + 0.5);
            if (pulse) {
              b[at + 4 + (bidSide ? 0 : 1)] = pulse.sign * (pulse.strength + (pulse.traded ? 2 : 0)); b[at + 6 + (bidSide ? 0 : 1)] = pulse.at - this.#pulseBase;
              b[at + 8 + (bidSide ? 0 : 1)] = Math.min(pulse.before / max, 1.2) * sideW * tdpr;
            }
          }
        }
        if (!(total > 0)) continue;
        const w = total / max * sideW;
        // On glass the fill is the glass's (trail-gl.ts), so a row's pulse can brighten or dim it; the outline below draws its shape.
        if (glassRows) continue;
        ctx.fillStyle = color; ctx.globalAlpha = p.dark ? 0.18 : 0.14;
        ctx.fillRect(side === 'ask' ? l.askX0 : l.bidX1 - w, y0, Math.max(0.5, w), rowPx);

      }
      if (!edge.length) continue;
      edge.sort((a, b) => a.y0 - b.y0);
      const xOf = (w: number): number => side === 'ask' ? l.askX0 + w : l.bidX1 - w, inner = xOf(0);
      ctx.globalAlpha = p.dark ? 0.9 : 0.8; ctx.strokeStyle = color; ctx.lineWidth = 1.25; ctx.lineJoin = 'miter';
      ctx.beginPath(); ctx.moveTo(inner, edge[0]!.y0);
      for (const e of edge) { ctx.lineTo(xOf(e.w), e.y0); ctx.lineTo(xOf(e.w), e.y1); }
      ctx.lineTo(inner, edge[edge.length - 1]!.y1); ctx.stroke();
    }
    ctx.globalAlpha = 1;
    if (glassRows) { trail.setRows(this.#brickRows, H); this.#rowsLive = true; }
    // The two largest levels each side say their size, at the bar's outer end.
    ctx.font = SMALL_FONT; ctx.textBaseline = 'middle'; ctx.fillStyle = p.text;
    for (const side of ['ask', 'bid'] as const) {
      for (const lvl of top.filter(x => x.side === side && x.usd > 0).sort((a, b) => b.usd - a.usd).slice(0, 2)) {
        const y = M.yOf(s, (g.bin0 + lvl.i + 0.5) * step), w = lvl.usd / max * sideW, label = volText(lvl.usd), tw = ctx.measureText(label).width;
        const x = side === 'ask' ? Math.min(l.askX0 + w + 4, l.askX1 - tw) : Math.max(l.bidX1 - w - 4 - tw, l.bidX0);
        ctx.globalAlpha = 0.72; ctx.fillStyle = p.bg; ctx.fillRect(x - 2, y - 6.5, tw + 4, 13);
        ctx.globalAlpha = 1; ctx.fillStyle = p.text; ctx.textAlign = 'left'; ctx.fillText(label, x, y);
      }
    }
  }

  /**
   * The tape: every price the page's orders traded at since it opened, sold left of the middle and bought right, for the markets the
   * map's footprint counts. Each row's winning side shows more strongly the more it won (the Rows look), and the busiest row is outlined.
   * Solid, the column is a panel the full height of the plot that hides the trail; as glass it is the glass's own (trail-gl.ts).
   */
  #paintTape(ctx: CanvasRenderingContext2D, l: M.CandleLayout, s: M.PriceScale, tape: readonly (readonly [number, number, number])[], step: number, p: Palette): void {
    const x0 = l.candleX0, x1 = l.candleX1, split = (x0 + x1) / 2, half = (x1 - x0) / 2 - 2;
    const judged = true, glass = this.#glassOn(), look = this.#settings.rows;
    const rows = step > 0 ? tape.flatMap(r => r[1] + r[2] > 0 ? [{ r, split: { buy: r[1], sell: r[2] } }] : []) : [];
    this.#frost = [];
    if (!glass) { ctx.fillStyle = p.panel; ctx.fillRect(x0, s.y0, x1 - x0, s.y1 - s.y0); }
    ctx.strokeStyle = p.line; ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(split + 0.5, s.y0); ctx.lineTo(split + 0.5, s.y1); ctx.stroke();
    if (!rows.length) return;
    const rowPx = step * (s.y1 - s.y0) / (s.p1 - s.p0), rh = Math.max(1, rowPx - (rowPx > 4 ? 1 : 0));
    let busiest = 0, maxNet = 0;
    for (const { r, split: c } of rows) { busiest = Math.max(busiest, r[1], r[2]); if (judged) maxNet = Math.max(maxNet, Math.abs(c.buy - c.sell)); }
    // The point of control: the row where the most traded.
    const poc = judged ? M.pocIndex(rows.map(({ r, split: c }) => [r[0], c.buy, c.sell] as const)) : -1;
    ctx.textBaseline = 'middle';
    rows.forEach(({ r: [low, buy, sell], split: c }, i) => {
      const y = M.yOf(s, low + step); if (y + rh < s.y0 || y > s.y1) return;
      // Which side won, and how strongly that shows (0 to 1, continuous).
      const e = judged ? M.rowEmphasis(c.buy, c.sell, maxNet) : null, win = e?.side ?? null, k = !e ? 0 : look === 'lean' ? e.lean : e.net;
      // The bar's length is what traded there, the busiest row's the full half.
      const sw = Math.sqrt(sell / busiest) * half, bw = Math.sqrt(buy / busiest) * half;
      const swIn = sell > 0 ? sw * c.sell / sell : 0, bwIn = buy > 0 ? bw * c.buy / buy : 0;
      if (look === 'glow' && e && win && k > 0.02) {
        ctx.globalAlpha = (p.dark ? 0.46 : 0.32) * k; ctx.fillStyle = win === 'buy' ? p.candleUp : p.candleDown; ctx.fillRect(x0 + 1, y, x1 - x0 - 2, rh);
      }
      const strong = 0.32 + 0.63 * k, weak = Math.max(0.1, 0.32 - 0.22 * k), plain = 0.5;
      if (look === 'delta' && e) {
        // Both sides faint at their sizes, and one solid bar from the middle toward the winner, as long as the difference.
        ctx.globalAlpha = p.dark ? 0.2 : 0.16; ctx.fillStyle = p.candleDown; ctx.fillRect(split - 1 - swIn, y, swIn, rh);
        ctx.fillStyle = p.candleUp; ctx.fillRect(split + 1, y, bwIn, rh);
        if (win && maxNet > 0) {
          const dw = Math.sqrt(Math.abs(c.buy - c.sell) / maxNet) * half;
          ctx.globalAlpha = 0.92; ctx.fillStyle = win === 'buy' ? p.candleUp : p.candleDown; ctx.fillRect(win === 'buy' ? split + 1 : split - 1 - dw, y, dw, rh);
        }
      } else {
        ctx.globalAlpha = !e ? plain : win === 'sell' ? strong : weak; ctx.fillStyle = p.candleDown; ctx.fillRect(split - 1 - swIn, y, swIn, rh);
        ctx.globalAlpha = !e ? plain : win === 'buy' ? strong : weak; ctx.fillStyle = p.candleUp; ctx.fillRect(split + 1, y, bwIn, rh);
      }
      ctx.globalAlpha = p.dark ? 0.2 : 0.16; ctx.fillStyle = p.muted;
      if (sw > swIn) ctx.fillRect(split - 1 - sw, y, sw - swIn, rh);
      if (bw > bwIn) ctx.fillRect(split + 1 + bwIn, y, bw - bwIn, rh);
      ctx.globalAlpha = 1;
      if (rh >= 11) {
        // The winner's number in full and bolder the more it won; the loser's fading with it. A small row's numbers are the ink faded.
        const small = buy + sell < busiest * 0.04, ink = p.text, fade = small ? 0.55 : 1;
        ctx.fillStyle = ink;
        ctx.font = win === 'sell' && k > 0.45 ? BOLD_NUM : NUM_FONT; ctx.globalAlpha = fade * (win === 'buy' ? 1 - 0.5 * k : 1);
        ctx.textAlign = 'right'; if (sell >= 1) ctx.fillText(volText(sell), split - 4, y + rh / 2);
        ctx.font = win === 'buy' && k > 0.45 ? BOLD_NUM : NUM_FONT; ctx.globalAlpha = fade * (win === 'sell' ? 1 - 0.5 * k : 1);
        ctx.textAlign = 'left'; if (buy >= 1) ctx.fillText(volText(buy), split + 4, y + rh / 2);
        ctx.globalAlpha = 1;
      }
      if (i === poc) { ctx.strokeStyle = p.poc; ctx.lineWidth = 1.5; ctx.strokeRect(x0 + 0.75, y + 0.25, x1 - x0 - 1.5, rh - 0.5); }
    });
  }

  /** The orders of the ring that arrived at or after `since` (the page's clock), inside the view's markets. */
  #arrivals(ring: TapeRing, since: number, hidden: ReadonlySet<number>): M.Arrival[] {
    const out: M.Arrival[] = [];
    for (const a of ring.arrivals) {
      if (a.at < since) continue;
      for (let k = Math.max(a.from, ring.first); k < a.to; k++) {
        const at = (k % ring.capacity) * STRIDE, d = ring.data;
        if (hidden.has(d[at + 3]!)) continue;
        const off = d[at + 1]!;
        out.push({ price: ring.p0 + off, usd: d[at + 2]!, at: a.at, inst: d[at + 3]!, slack: M.ringSlack(off) });
      }
    }
    return out;
  }

  /** The ring's markets outside the view's (the map's footprint markets; none chosen, as in the footprint, counts none). */
  #hidden(ring: TapeRing): Set<number> {
    const want = new Set(this.markets(this.store.state));
    return new Set(ring.ids.flatMap((id, i) => want.has(id) ? [] : [i]));
  }

  /** The rail's ticks: each row that received orders in the last RAIL_MS, its sold and bought share, fading. */
  #paintRail(ctx: CanvasRenderingContext2D, l: M.CandleLayout, s: M.PriceScale, step: number, p: Palette): void {
    ctx.fillStyle = p.line; ctx.fillRect(l.railX0, s.y0, 1, s.y1 - s.y0);
    const ring = this.hub.tape; if (!ring || !(step > 0)) return;
    const now = performance.now(), cells = M.railCells(this.#arrivals(ring, now - RAIL_MS, this.#hidden(ring)), step, now - RAIL_MS, now);
    const x0 = l.railX0 + 19, w = l.railX1 - l.railX0 - 21;
    for (const c of cells) {
      const y = M.yOf(s, (c.bin + 0.5) * step); if (y < s.y0 || y > s.y1) continue;
      const fade = 1 - (now - c.at) / RAIL_MS, sold = c.sell / (c.buy + c.sell);
      ctx.globalAlpha = 0.25 + 0.6 * fade;
      ctx.fillStyle = p.candleDown; ctx.fillRect(x0, y - 1.5, w * sold, 3);
      ctx.fillStyle = p.candleUp; ctx.fillRect(x0 + w * sold, y - 1.5, w * (1 - sold), 3);
    }
    ctx.globalAlpha = 1;
  }

  /** Prices down the right edge, the price line across everything, and its tag. */
  #paintAxis(ctx: CanvasRenderingContext2D, l: M.CandleLayout, s: M.PriceScale, mark: number, bar: { o: number; c: number }, p: Palette): void {
    const pStep = niceStep(s.p1 - s.p0, Math.max(3, (s.y1 - s.y0) / 56));
    ctx.font = SMALL_FONT; ctx.fillStyle = p.muted; ctx.textAlign = 'right'; ctx.textBaseline = 'middle';
    const markY = mark > 0 ? M.yOf(s, mark) : -100;
    for (let q = Math.ceil(s.p0 / pStep) * pStep; q <= s.p1; q += pStep) {
      const y = M.yOf(s, q); if (y < s.y0 + 6 || y > s.y1 - 6 || Math.abs(y - markY) < 12) continue;
      ctx.fillText(fmtPrice(q, pStep), l.axisX1 - 4, y);
    }
    if (!(mark > 0)) return;
    const col = bar.c >= bar.o ? p.candleUp : p.candleDown;
    ctx.strokeStyle = col; ctx.lineWidth = 1; ctx.setLineDash([2, 3]); ctx.globalAlpha = 0.85;
    ctx.beginPath(); ctx.moveTo(0, Math.round(markY) + 0.5); ctx.lineTo(l.axisX0, Math.round(markY) + 0.5); ctx.stroke();
    ctx.setLineDash([]); ctx.globalAlpha = 1;
    ctx.fillStyle = col; ctx.fillRect(l.axisX0 + 1, markY - 8, l.axisX1 - l.axisX0 - 1, 16);
    ctx.fillStyle = textOn(col, 1, p); ctx.font = `600 ${SMALL_FONT}`;
    ctx.fillText(fmtPrice(mark, this.#step > 0 ? Math.min(this.#step, pStep) : pStep), l.axisX1 - 4, markY);
  }

  /**
   * The exchanges' marks: beside each order of the trail from the whale size up (the newest MAX_TRAIL_MARKS), fading with the trail, and
   * left of the rail's largest flashes while they last and a moment after (FLASH_MARK_MS).
   */
  #drawMarks(ring: TapeRing, l: M.CandleLayout, s: M.PriceScale, now: number, page: number, hidden: ReadonlySet<number>, reduced: boolean): void {
    const ctx = this.#marksCtx, step = this.#step;
    ctx.setTransform(this.#dpr, 0, 0, this.#dpr, 0, 0);
    if (this.#marksDrawn) ctx.clearRect(0, 0, this.#w, this.#h);
    let drawn = false;
    const whale = scaledUsd(this.store.state.barStatOptions.whaleUsd), win = this.#settings.trailMs;
    const big: { x: number; y: number; id: string; a: number }[] = [];
    for (const o of this.#whalesOf(ring, whale, now, win)) {
      if (hidden.has(o.inst)) continue;
      const age = now - o.t; if (age > win || age < -1_500) continue;
      big.push({ x: M.trailX(l, age, win), y: M.yOf(s, o.price), id: ring.ids[o.inst] ?? '', a: Math.max(0.25, (1 - age / win) ** 1.2) });
    }
    for (const m of big.slice(-MAX_TRAIL_MARKS)) {
      if (m.y < s.y0 || m.y > s.y1 || !m.id) continue;
      ctx.globalAlpha = m.a; drawVenueMark(ctx, m.id, m.x - 9, m.y - 9, 10); drawn = true;
    }
    if (!reduced && step > 0) {
      // The marks of the largest flashes, from the large arrivals alone (a later small order must not keep one up or move it).
      const markUsd = scaledUsd(100_000);
      const cells = M.railCells(this.#arrivals(ring, page - M.FLASH_MARK_MS, hidden).filter(o => Math.abs(o.usd) >= markUsd), step, page - M.FLASH_MARK_MS, page)
        .sort((a, b) => b.largest - a.largest).slice(0, 3);
      for (const c of cells) {
        const y = M.yOf(s, (c.bin + 0.5) * step), id = ring.ids[c.largestInst]; if (!id || y < s.y0 || y > s.y1) continue;
        ctx.globalAlpha = Math.max(0, 1 - (page - c.at) / M.FLASH_MARK_MS); drawVenueMark(ctx, id, l.railX0 - 8, y, 11); drawn = true;
      }
    }
    ctx.globalAlpha = 1; this.#marksDrawn = drawn;
  }

  /**
   * The ring's orders from `whale` USD up, held as they arrive (each order is looked at once, not every frame), with their absolute time and
   * price; started again after a rebase or a clear of the ring, or another whale size, and those older than the window let go.
   */
  #whales: { t: number; price: number; inst: number }[] = []; #whaleScan = 0; #whaleEpoch = -1; #whaleUsd = 0; #whaleWin = 0;
  #whalesOf(ring: TapeRing, whale: number, now: number, win: number): readonly { t: number; price: number; inst: number }[] {
    // Read again from the window's start when the ring, the whale size or the window changed (a longer window reaches orders never read).
    if (ring.epoch !== this.#whaleEpoch || whale !== this.#whaleUsd || ring.written < this.#whaleScan || win !== this.#whaleWin) {
      this.#whales = []; this.#whaleEpoch = ring.epoch; this.#whaleUsd = whale; this.#whaleWin = win;
      this.#whaleScan = ring.runs(now - win, now + 2_000)[0]?.[0] ?? ring.written;
    }
    const d = ring.data;
    for (let k = Math.max(this.#whaleScan, ring.first); k < ring.written; k++) {
      const at = (k % ring.capacity) * STRIDE;
      if (Math.abs(d[at + 2]!) >= whale) this.#whales.push({ t: ring.t0 + d[at]!, price: ring.p0 + d[at + 1]!, inst: d[at + 3]! });
    }
    this.#whaleScan = ring.written;
    const cutoff = now - win - 2_000;
    if (this.#whales.length && this.#whales[0]!.t < cutoff) this.#whales = this.#whales.filter(o => o.t >= cutoff);
    return this.#whales;
  }

  /** The trail's renderer, made on first use and again for a new ring or a context given back (its programs, textures and waves with it). */
  #ensureTrail(ring: TapeRing): TrailGL | null {
    if (this.#trail && this.#trailRing === ring) return this.#trail;
    if (this.#trailFailed || this.#trailLost) return null;
    try { this.#trail = new TrailGL(this.#trailCanvas, ring); this.#trailRing = ring; this.#maskKey = ''; this.#maskSet = null; this.#trail.resize(this.#w, this.#h, Math.min(this.#dpr, 1.5)); }
    catch (error) {
      // Lost again while it was made: it is made once more when the context comes back.
      if (this.#trailCanvas.getContext('webgl2')?.isContextLost()) { this.#trailLost = true; this.#trail = null; return null; }
      // No glass then either: the candle is painted again with its panel and its veil on the page's canvas.
      this.#trailFailed = true; console.warn('the trade trail cannot be drawn here:', error); this.invalidate();
    }
    return this.#trail;
  }

  /** Whether the candle is glass: chosen, and drawable (the glass is the trail's renderer; without WebGL, or while its context is lost, it is solid whatever the setting). */
  #glassOn(): boolean { return this.#settings.glass !== 'off' && !this.#trailFailed && !this.#trailLost; }

  /**
   * The trail runs while the view shows: a frame per display frame (at most 60 a second; with reduced motion one a second), each moving it by
   * its clock alone, which costs a few uniforms (trail-gl.ts). Moving it only when it had gone a pixel, five times a second over a minute,
   * read as a page running at 5 frames a second on a phone (Karl, Pixel 10, 2026-10-16). This asks for the next frame to be drawn whatever
   * the pace (a change of scale, look or data) and starts the loop when it is not running. With reduced motion it waits out the second in
   * a timer, whatever asked, so nothing redraws more often than that. The loop stops when the view or the page is hidden or nothing moves
   * (no order in the window, no flash, no pulse), and a frame asked for before a stop is ignored (`#trailChain`).
   */
  #scheduleTrail(_delay = 0): void {
    if (!this.#shown) return;
    this.#trailDirty = true;
    if (this.#trailRaf || this.#trailTimer) return;
    const chain = this.#trailChain;
    const step = (time: number): void => {
      this.#trailRaf = 0;
      if (chain !== this.#trailChain || !this.#shown || document.hidden) return;
      const reduced = this.#reduced?.matches ?? false, gap = reduced ? 1_000 : 1_000 / 60 - 3;
      let more = true;
      if ((this.#trailDirty && !reduced) || time - this.#trailDrawn >= gap) { this.#trailDirty = false; this.#trailDrawn = time; more = this.#drawTrail(); }
      if (!more) return;
      if (reduced) {
        this.#trailTimer = window.setTimeout(() => { this.#trailTimer = 0; if (chain === this.#trailChain) this.#trailRaf = requestAnimationFrame(step); }, Math.max(0, gap - (performance.now() - this.#trailDrawn)));
      } else this.#trailRaf = requestAnimationFrame(step);
    };
    this.#trailRaf = requestAnimationFrame(step);
  }
  #cancelTrail(): void {
    if (this.#trailRaf) { cancelAnimationFrame(this.#trailRaf); this.#trailRaf = 0; }
    if (this.#trailTimer) { window.clearTimeout(this.#trailTimer); this.#trailTimer = 0; }
    this.#trailChain++;
  }

  /** One frame of the trail, the rail's flashes and the marks. False when there is nothing to draw (the loop then stops until asked again). */
  #drawTrail(): boolean {
    if (!this.#shown || document.hidden) return false;
    const ring = this.hub.tape, l = this.#layout, s = this.#scale, p = this.#palette;
    if (!ring || !l || !s || replaying()) { this.#trail?.clear(); return false; }
    const trail = this.#ensureTrail(ring); if (!trail) return false;
    const hidden = this.#hiddenOf(ring);
    if (hidden !== this.#maskSet) { const maskKey = [...hidden].join(','); if (maskKey !== this.#maskKey) { trail.setMask([...hidden]); this.#maskKey = maskKey; } this.#maskSet = hidden; }
    const tones = this.#tonesOf(p);
    const reduced = this.#reduced?.matches ?? false, page = performance.now(), step = this.#step;
    // The trail's right edge is the exchange's now: the source's clock, or the newest order when the page's clock runs behind it.
    const sourceNow = this.hub.sourceNow(), newest = ring.written > 0 ? ring.t0 + ring.data[((ring.written - 1) % ring.capacity) * STRIDE]! : 0;
    const now = Math.max(sourceNow, Math.min(newest, sourceNow + 2_000));
    const lo = scaledUsd(25_000), hiUsd = scaledUsd(2_000_000), railX = l.railX0 + 10.5;
    const lit = reduced || !(step > 0) ? [] : M.flashes(this.#arrivals(ring, page - M.FLASH_MS, hidden), step, lo, page);
    const flashes: FlashSprite[] = lit.map(c => ({ x: railX, y: M.yOf(s, (c.bin + 0.5) * step), r: M.flashRadius(c.largest, lo, hiUsd), share: c.buy / (c.buy + c.sell), k: c.k }));
    trail.draw({
      style: this.#settings.style, dark: p.dark, bid: tones.bid, ask: tones.ask, mid: tones.mid,
      now, windowMs: this.#settings.trailMs, x0: l.trailX0, x1: l.trailX1, y0: s.y0, y1: s.y1, p0: s.p0, p1: s.p1,
      floorUsd: scaledUsd(100), ceilUsd: scaledUsd(250_000), opacity: p.dark ? 0.8 : 0.85, flashes,
      // The three pieces of glass, welded across the gaps between them; the rail stays in the open.
      glass: this.#settings.glass === 'off' ? null : {
        y0: s.y0, y1: s.y1, frost: this.#frost, bricks: this.#settings.glass === 'bricks', pulse: reduced ? 'off' : this.#settings.pulse, nowMs: page - this.#pulseBase,
        // The book's fill as the page's canvas lays it with glass off; a breath on the bricks, whose glass is already the bar's colour.
        fill: this.#settings.glass === 'bricks' ? 0.05 : p.dark ? 0.18 : 0.14, bookBid: tones.bookBid, bookAsk: tones.bookAsk,
        // The waves as strong as the page's own (the Waves panel's Strength), though this glass is switched on by the Tape's Glass.
        waveGain: strengthGain(this.store.state.waveStrength),
        pieces: [{ x0: 2, x1: l.bidX1, candle: false }, { x0: l.candleX0, x1: l.candleX1, candle: true }, { x0: l.askX0, x1: l.askX1 + 2, candle: false }],
      },
    });
    this.#drawMarks(ring, l, s, now, page, hidden, reduced);
    // Something still moves: an order in the window (it ages across it), a flash, or a pulse or a wave on the book's glass (the waves are
    // stepped only with glass, so without it one still queued would keep the loop going for nothing).
    return ring.runs(now - this.#settings.trailMs, now + 2_000).length > 0 || flashes.length > 0 || (!reduced && (this.#pulseShowing(page) || (this.#glassOn() && trail.waving)));
  }

  /** Whether a pulse is still on the book's glass now: chosen, drawable, and one younger than its life (the tracker forgets them only on a frame). */
  #pulseShowing(page: number): boolean {
    if (!this.#glassOn() || this.#settings.pulse === 'off') return false;
    for (const p of this.#pulses.pulses.values()) if (page - p.at < M.PULSE_LIFE_MS) return true;
    return false;
  }

  /** The palette's colours as the renderer takes them (0-1 RGB), worked out once a palette. */
  #tones: RendererTones | null = null;
  #tonesOf(p: Palette): RendererTones {
    if (this.#tones?.p !== p) this.#tones = { p, bid: rgb(p.candleUp), ask: rgb(p.candleDown), mid: rgb(p.dark ? '#d8dce4' : '#3a3f48'), bookBid: rgb(p.bid), bookAsk: rgb(p.ask) };
    return this.#tones;
  }
  #maskSet: Set<number> | null = null;

  /** `#hidden` for a frame: worked out again only when the ring's markets or the view's change (the map's footprint markets come back as the same list while they hold). */
  #hiddenMemo: { markets: readonly string[]; ids: number; set: Set<number> } | null = null;
  /** The view's markets as the last drawing of the book and the candle found them: a frame of the trail reads these, not the map's rule again. */
  #marketsNow: readonly string[] | null = null;
  #hiddenOf(ring: TapeRing): Set<number> {
    const markets = this.#marketsNow ?? this.markets(this.store.state), m = this.#hiddenMemo;
    if (m && m.markets === markets && m.ids === ring.ids.length) return m.set;
    const set = this.#hidden(ring);
    this.#hiddenMemo = { markets, ids: ring.ids.length, set };
    return set;
  }
}
