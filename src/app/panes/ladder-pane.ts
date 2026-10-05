import { venueLabel } from '../venues.ts';
import { activeIds, kindOf } from '../scope.ts';
import { el } from '../dom.ts';
import { setTip } from '../tip.ts';
import { helpButton } from '../help.ts';
import { button, checkRow, note, togglePanel, type Panel } from '../ui.ts';
import type { Kernels } from '../kernels.ts';
import { PALETTES } from '../theme.ts';
import { niceStep } from '../view.ts';
import { price as fmtPrice, usd } from '../format.ts';
import type { Store, AppState } from '../store.ts';
import { coverage, cumulative, dominanceWeight, groupLevels, imbalanceByDistance, liquidityWithin, type Grouped } from './levels-data.ts';
import { GROUPS, WheelNotches, offsetKeepingPrice, priceAtRow, stepBy } from './ladder-zoom.ts';
import { GestureRecognizer, axisPinchScale, bindTouch, type GestureHandlers, type Pt } from '../touch.ts';
import { dimOutside, mirrorLines, mirrorStats, paintBand, paintMirrorBox, percentText, type MirrorStats } from '../mirror.ts';

const ROW_H = 17;
const HEAD_H = 20;
const HEAD_TALL = 46;
/** Height of the balance bar under the header (bids against asks within the visible range). */
const BALANCE_H = 16;
const PRICE_W = 58, USD_W = 54, MIN_BAR_W = 90, CELL_MAX = 26, CELL_MIN = 5;
/** Dragging the price column zooms; this is the width of that column's hit area, and how far to drag per zoom step. */
const AXIS_W = PRICE_W + 6, AXIS_DRAG_PX = 26;
const BOOK_MIN_W = 250;
const VENUE_TINT = [1, 0.62, 0.38, 0.8, 0.5, 0.7, 0.3, 0.9];

export { venueLabel };

/** Order-book ladder around the mark. Aggregated sums venues with per-venue cells; Single shows one book per chosen venue side by side. */
export class LadderPane {
  readonly root = document.createElement('section');
  readonly controls = document.createElement('div');
  #scroller = document.createElement('div');
  #canvas = document.createElement('canvas');
  #ctx: CanvasRenderingContext2D;
  #w = 0; #h = 0; #dpr = 1; #frame = 0;
  #offsetRows = 0;
  #palette = PALETTES.light!;
  #booksButton = document.createElement('button');
  #panel: Panel | null = null;
  #idsKey = '';
  #hover: { x: number; y: number } | null = null;
  /** A mouse click is a notch; a touchpad's small deltas make one per 40 px, at most one per 90 ms (see WheelNotches). */
  #notches = new WheelNotches(100, 250, 30, 40, 90);
  /** Touch: where a finger pinned the mirror comparison, the pinch in progress, and the fling after a lift. */
  #pinned: Pt | null = null;
  #pinch: { step: number; price: number; row: number } | null = null;
  #fling = 0;
  /** What the last frame drew, which gestures are read against (step 0 until a frame has data). */
  #layout = { step: 0, rows: 0, head: 0, colW: 0, mark: 0 };
  /** A pointer drag in progress: the book moving with the pointer, or the price column zooming about the price it started on. */
  #drag: { kind: 'pan'; y: number; offset: number } | { kind: 'zoom'; y: number; step: number; price: number; row: number } | null = null;
  #autoOption: HTMLOptionElement | null = null;
  /** Mirror-hover comparison for the book under the pointer, or null (read by tests, drawn on the canvas). */
  mirror: MirrorStats | null = null;

  constructor(host: HTMLElement, private store: Store, private kernels: Kernels) {
    this.root.className = 'pane ladder';
    this.controls.className = 'pane-head';
    this.#scroller.className = 'ladder-scroll';
    this.#scroller.append(this.#canvas);
    this.root.append(this.controls, this.#scroller);
    host.append(this.root);
    this.#ctx = this.#canvas.getContext('2d')!;
    new ResizeObserver(() => this.#resize()).observe(this.#scroller);
    this.#bindInput();
    this.#buildControls();
  }

  /** Header (grip target) for layout code. */
  get header(): HTMLElement { return this.controls; }
  /** The price step per row drawn by the last frame (the automatic one included); 0 before the first frame with data. */
  get step(): number { return this.#layout.step; }
  /** The price at the middle of the row at canvas height `y` in the last frame, or null before one (read by tests). */
  priceAtY(y: number): number | null { return this.#layout.step > 0 ? this.#priceAt(this.#rowAt(y)) : null; }
  setPalette(name: string): void { this.#palette = PALETTES[name] ?? PALETTES.light!; this.invalidate(); }
  recenter(): void { this.#offsetRows = 0; this.invalidate(); }

  /**
   * The wheel zooms (the grouping steps finer or coarser about the price under the pointer, like the chart's price axis), dragging the
   * book moves it, dragging the price column zooms, and a double-click puts both back.
   */
  #bindInput(): void {
    const c = this.#canvas;
    const local = (e: MouseEvent) => { const r = c.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; };
    c.addEventListener('wheel', e => {
      if (e.shiftKey) return; // Shift+wheel scrolls Single mode's books sideways
      e.preventDefault();
      const lines = e.deltaMode === 1 ? 33 : e.deltaMode === 2 ? this.#h : 1, pinch = e.ctrlKey ? 8 : 1;
      const notches = this.#notches.add(e.deltaY * lines * pinch, e.timeStamp);
      if (notches) this.#zoomTo(stepBy(this.#layout.step, notches), this.#rowAt(local(e).y));
    }, { passive: false });
    c.addEventListener('pointerdown', e => {
      if (e.pointerType === 'touch' || e.button !== 0 || !(this.#layout.step > 0)) return;
      const { x, y } = local(e), row = this.#rowAt(y);
      this.#drag = this.#onAxis(x) ? { kind: 'zoom', y, step: this.#layout.step, price: this.#priceAt(row), row } : { kind: 'pan', y, offset: this.#offsetRows };
      c.setPointerCapture(e.pointerId); this.#hover = null; this.#cursor(x); this.invalidate();
    });
    c.addEventListener('pointermove', e => {
      if (e.pointerType === 'touch') return;
      const { x, y } = local(e), drag = this.#drag;
      if (drag?.kind === 'zoom') this.#zoomTo(stepBy(drag.step, Math.trunc((y - drag.y) / AXIS_DRAG_PX)), drag.row, drag.price); // up zooms in, down out
      else if (drag?.kind === 'pan') { this.#offsetRows = drag.offset + Math.round((y - drag.y) / ROW_H); this.invalidate(); }
      else this.#hover = { x, y };
      this.#cursor(x); this.invalidate();
    });
    const release = (e: PointerEvent) => { if (e.pointerType === 'touch') return; this.#drag = null; if (c.hasPointerCapture(e.pointerId)) c.releasePointerCapture(e.pointerId); this.#cursor(local(e).x); this.invalidate(); };
    c.addEventListener('pointerup', release); c.addEventListener('pointercancel', release);
    c.addEventListener('pointerleave', e => { if (e.pointerType === 'touch') return; this.#hover = null; this.invalidate(); });
    c.addEventListener('dblclick', () => this.#reset());
    bindTouch(c, new GestureRecognizer(this.#touchHandlers()));
  }

  /** Put the book back on the mark at the automatic grouping. */
  #reset(): void { this.#offsetRows = 0; this.store.set({ grouping: 'auto' }); this.invalidate(); }

  /**
   * A finger: tap pins the mirror comparison on a row (tap it again to let it go), holding and dragging scrubs it, dragging moves the
   * book (or zooms it, from the price column) and keeps going after the lift, pinching zooms the grouping about the fingers, and a
   * double tap puts the book back.
   */
  #touchHandlers(): GestureHandlers {
    const reducedMotion = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
    const pin = (p: Pt): void => { this.#pinned = p; this.#hover = { x: p.x, y: p.y }; this.invalidate(); };
    const unpin = (): void => { this.#pinned = null; this.#hover = null; this.invalidate(); };
    return {
      down: () => this.#stopFling(),
      tap: p => { if (this.#pinned && Math.hypot(this.#pinned.x - p.x, this.#pinned.y - p.y) < 28) unpin(); else pin(p); },
      doubleTap: () => { unpin(); this.#reset(); },
      hold: pin, holdMove: pin,
      panStart: p => {
        unpin();
        if (!(this.#layout.step > 0)) return;
        const row = this.#rowAt(p.y);
        this.#drag = this.#onAxis(p.x) ? { kind: 'zoom', y: p.y, step: this.#layout.step, price: this.#priceAt(row), row } : { kind: 'pan', y: p.y, offset: this.#offsetRows };
      },
      pan: (_d, p) => {
        const drag = this.#drag;
        if (drag?.kind === 'zoom') this.#zoomTo(stepBy(drag.step, Math.trunc((p.y - drag.y) / AXIS_DRAG_PX)), drag.row, drag.price);
        else if (drag?.kind === 'pan') { this.#offsetRows = drag.offset + Math.round((p.y - drag.y) / ROW_H); this.invalidate(); }
      },
      panEnd: v => {
        const was = this.#drag; this.#drag = null; this.invalidate();
        if (was?.kind === 'pan' && v && !reducedMotion && Math.abs(v.y) > 0.08) this.#startFling(v.y);
      },
      pinchStart: info => {
        unpin(); this.#stopFling(); this.#drag = null;
        if (!(this.#layout.step > 0)) return;
        const row = this.#rowAt(info.mid.y);
        this.#pinch = { step: this.#layout.step, price: this.#priceAt(row), row };
      },
      pinch: info => {
        const z = this.#pinch; if (!z) return;
        // Fingers spreading apart is zooming in, which is a finer step; about one step for each 1.6x the separation changes.
        const notches = -Math.round(Math.log2(axisPinchScale(info.start.dy, info.now.dy)) * 1.6);
        this.#zoomTo(stepBy(z.step, notches), z.row, z.price);
      },
      pinchEnd: () => { this.#pinch = null; },
      cancel: () => { this.#drag = null; this.#pinch = null; },
    };
  }
  #startFling(vy: number): void {
    this.#stopFling();
    let v = Math.max(-4, Math.min(4, vy)) / ROW_H, last = performance.now(), carry = 0;
    const step = (now: number): void => {
      const dt = Math.min(48, now - last); last = now;
      carry += v * dt; const rows = Math.trunc(carry); carry -= rows;
      if (rows) { this.#offsetRows += rows; this.invalidate(); }
      v *= Math.exp(-dt / 260);
      this.#fling = Math.abs(v) * ROW_H < 0.02 || document.hidden ? 0 : requestAnimationFrame(step);
    };
    this.#fling = requestAnimationFrame(step);
  }
  #stopFling(): void { if (this.#fling) { cancelAnimationFrame(this.#fling); this.#fling = 0; } }

  /** Whether canvas column `x` is on the price column of a book (the zoom handle). */
  #onAxis(x: number): boolean { const { colW } = this.#layout; return colW > 0 && x % colW < AXIS_W; }
  #cursor(x: number): void { this.#canvas.style.cursor = this.#drag ? (this.#drag.kind === 'pan' ? 'grabbing' : 'ns-resize') : this.#onAxis(x) ? 'ns-resize' : 'grab'; }
  /** The row under canvas height `y`, clamped to the rows drawn (the middle row for a point over the header). */
  #rowAt(y: number): number {
    const { rows, head } = this.#layout;
    return y < head ? Math.floor(rows / 2) : Math.max(0, Math.min(rows - 1, Math.floor((y - head) / ROW_H)));
  }
  #priceAt(row: number): number { const l = this.#layout; return priceAtRow({ mark: l.mark, step: l.step, offsetRows: this.#offsetRows, rows: l.rows, row }); }
  /** Group by `step`, keeping `price` (default: what the pointer is over) on `row`, so the zoom is about the pointer rather than the mark. */
  #zoomTo(step: number, row: number, price = this.#priceAt(row)): void {
    const l = this.#layout;
    if (!(l.step > 0) || step === l.step) return;
    this.#offsetRows = offsetKeepingPrice({ mark: l.mark, step, rows: l.rows, row, price });
    l.step = step; // later events in the same frame build on this one
    this.store.set({ grouping: step });
  }
  invalidate(): void { if (!this.#frame) this.#frame = requestAnimationFrame(() => { this.#frame = 0; this.#render(); }); }

  #selects: { select: HTMLSelectElement; get: () => string }[] = [];
  #select(label: string, options: [string, string][], get: () => string, set: (v: string) => void): HTMLLabelElement {
    const wrap = document.createElement('label'); wrap.className = 'ctl'; wrap.append(label);
    const select = document.createElement('select'); this.#selects.push({ select, get });
    for (const [value, text] of options) select.append(new Option(text, value));
    select.value = get(); select.onchange = () => set(select.value);
    wrap.append(select); return wrap;
  }
  #buildControls(): void {
    const s = () => this.store.state;
    const title = document.createElement('strong'); title.textContent = 'Order Book';
    this.#booksButton.className = 'books-btn'; this.#booksButton.textContent = 'Books'; setTip(this.#booksButton, 'Choose which venues get their own book (Single mode)');
    this.#booksButton.onclick = () => { this.#panel = togglePanel(this.#booksButton, { title: 'Order books', width: 340, align: 'right', onClose: () => { this.#panel = null; } }, (tools, body) => this.#buildBooks(tools, body)); };
    const recenter = document.createElement('button'); recenter.className = 'recenter-btn'; recenter.textContent = 'Recenter'; recenter.onclick = () => this.recenter();
    const group = this.#select('Group', [['auto', 'Auto'], ...GROUPS.map(g => [String(g), String(g)] as [string, string])], () => String(s().grouping), v => this.store.set({ grouping: v === 'auto' ? 'auto' : Number(v) }));
    setTip(group, 'Price step per row. Scroll over the book, or drag its price column up and down, to zoom; drag the book to move it; double-click to reset.');
    this.#autoOption = group.querySelector('option[value="auto"]');
    this.controls.append(title, helpButton('orderBook'),
      this.#select('Mode', [['aggregated', 'Aggregated'], ['single', 'Single'], ['compact', 'Compact']], () => s().ladderMode, v => this.store.set({ ladderMode: v as AppState['ladderMode'] })),
      group,
      this.#select('Show', [['both', 'Levels + cum'], ['levels', 'Levels'], ['cumulative', 'Cumulative']], () => s().ladderShow, v => this.store.set({ ladderShow: v as AppState['ladderShow'] })),
      this.#booksButton, recenter);
    this.syncVenues();
  }

  /** Reflect state changed elsewhere (persistence, other controls) in the header selects without disturbing an open popup. */
  syncControls(): void { for (const { select, get } of this.#selects) if (select.value !== get()) select.value = get(); this.syncVenues(); }

  /** The books shown in Single mode: the user's choice, or every enabled venue. */
  #singleIds(state: AppState): string[] {
    const available = activeIds(state);
    const chosen = state.ladderVenues.filter(id => available.includes(id));
    return chosen.length ? chosen : available;
  }
  /** Show the Books button only in Single mode; keep an open popover's checkboxes current. */
  syncVenues(): void {
    const single = this.store.state.ladderMode === 'single';
    this.#booksButton.hidden = !single;
    if (!single) this.#panel?.close();
    const key = (this.store.state.levels?.books ?? []).map(b => b.id).join(',');
    if (key !== this.#idsKey) { this.#idsKey = key; this.#panel?.render((tools, body) => this.#buildBooks(tools, body)); }
  }
  #buildBooks(tools: HTMLElement, body: HTMLElement): void {
    const state = this.store.state, ids = (state.levels?.books ?? []).map(book => book.id), shown = new Set(this.#singleIds(state));
    const choose = (wanted: string[]): void => this.store.set({ ladderVenues: wanted });
    tools.append(button('All', () => choose([]), 'Every enabled venue gets a book'),
      button('Spot', () => choose(ids.filter(id => kindOf(state.markets, id) === 'spot')), 'Only spot venues'),
      button('Perp', () => choose(ids.filter(id => kindOf(state.markets, id) === 'perp')), 'Only perpetual venues'),
      el('span', { class: 'muted', textContent: `${shown.size} of ${ids.length} shown` }));
    body.append(note('Single mode draws one book per venue side by side. Pick which venues get a column.'));
    for (const id of ids) {
      const kind = kindOf(state.markets, id);
      body.append(checkRow(venueLabel(id), `${id.split(':').slice(1).join(':')}${kind ? ` · ${kind === 'spot' ? 'spot' : 'perpetual'}` : ''}`, shown.has(id), on => {
        const next = new Set(this.#singleIds(this.store.state)); if (on) next.add(id); else next.delete(id);
        choose(ids.filter(x => next.has(x)));
      }));
    }
  }

  #resize(): void {
    const r = this.#scroller.getBoundingClientRect();
    this.#w = Math.max(1, Math.floor(r.width)); this.#h = Math.max(1, Math.floor(r.height)); this.#dpr = window.devicePixelRatio || 1;
    this.invalidate();
  }
  #setCanvas(width: number): void {
    if (this.#canvas.width !== Math.round(width * this.#dpr) || this.#canvas.height !== Math.round(this.#h * this.#dpr)) {
      this.#canvas.width = Math.round(width * this.#dpr); this.#canvas.height = Math.round(this.#h * this.#dpr);
    }
    this.#canvas.style.width = `${width}px`; this.#canvas.style.height = `${this.#h}px`;
    // Single mode puts several books side by side: a sideways swipe scrolls them (the browser's job), up and down stays ours.
    const touchAction = width > this.#w + 1 ? 'pan-x' : 'none';
    if (this.#canvas.style.touchAction !== touchAction) this.#canvas.style.touchAction = touchAction;
  }

  #render(): void {
    const state = this.store.state, p = this.#palette;
    this.mirror = null;
    const frame = state.levels, mark = state.mark.price;
    const books = state.ladderMode === 'single' ? this.#singleIds(state) : [];
    const columns = state.ladderMode === 'single' ? Math.max(1, books.length) : 1;
    const width = Math.max(this.#w, columns * BOOK_MIN_W);
    this.#setCanvas(width);
    const ctx = this.#ctx, h = this.#h;
    ctx.setTransform(this.#dpr, 0, 0, this.#dpr, 0, 0); ctx.clearRect(0, 0, width, h);
    ctx.font = '11px ui-monospace, SFMono-Regular, Menlo, monospace'; ctx.textBaseline = 'middle';
    if (!frame || !(mark > 0) || width < 80) { ctx.fillStyle = p.muted; ctx.fillText('Waiting for order book…', 12, 20); return; }
    const ids = state.ladderMode === 'single' ? books : activeIds(state);
    const cells = state.ladderMode === 'aggregated' && ids.length > 1;
    const cellW = cells ? Math.max(CELL_MIN, Math.min(CELL_MAX, Math.floor((width - PRICE_W - USD_W - 8 - MIN_BAR_W) / ids.length))) : 0;
    const balanceH = state.highlight.on ? BALANCE_H : 0;
    const head = (cells && cellW < 20 ? HEAD_TALL : HEAD_H) + balanceH;
    const rows = Math.max(6, Math.floor((h - head) / ROW_H));
    const step = state.grouping === 'auto' ? niceStep(mark * 0.012, rows / 2) : state.grouping;
    this.#layout = { step, rows, head, colW: width / columns, mark };
    if (this.#autoOption) { const text = state.grouping === 'auto' ? `Auto · ${step}` : 'Auto'; if (this.#autoOption.text !== text) this.#autoOption.text = text; }
    const centerBin = Math.floor(mark / step) + this.#offsetRows;
    const p0 = (centerBin - rows / 2) * step, p1 = (centerBin + rows / 2 + 1) * step;
    const g = groupLevels(this.kernels, frame, ids, step, p0, p1);
    const markBin = Math.floor(mark / step) - g.bin0;
    if (state.ladderMode === 'single') {
      const colW = width / columns;
      ids.forEach((id, k) => {
        const idx = g.ids.indexOf(id); if (idx < 0) return;
        const own: Grouped = { ...g, totalBid: g.bid[idx]!, totalAsk: g.ask[idx]! };
        this.#drawBook(ctx, state, own, { x: k * colW, w: colW, title: `${venueLabel(id)} ${id.split(':').slice(1).join(':')}`, cells: null, cellW: 0, head, balanceH, cover: coverage(frame.books.find(b => b.id === id), mark), centerBin, rows, markBin, mark, step });
        if (k > 0) { ctx.strokeStyle = p.line; ctx.beginPath(); ctx.moveTo(k * colW + 0.5, 0); ctx.lineTo(k * colW + 0.5, h); ctx.stroke(); }
      });
    } else {
      this.#drawBook(ctx, state, g, { x: 0, w: width, title: '', cells: cells ? ids : null, cellW, head, balanceH, cover: null, centerBin, rows, markBin, mark, step });
    }
  }

  /** Mirror hover: highlight the rows from the mark to the hovered row and the same number of rows on the other side, dim the rest, and compare the cumulative liquidity of the two bands. */
  #paintMirror(ctx: CanvasRenderingContext2D, state: AppState, g: Grouped, cum: ReturnType<typeof cumulative>,
    o: { x: number; w: number; title: string; centerBin: number; markBin: number; mark: number; step: number }, head: number, rows: number): void {
    const hv = this.#hover, p = this.#palette;
    if (!hv || this.#drag || !state.show.mirror || hv.x < o.x || hv.x >= o.x + o.w || hv.y < head || hv.y >= head + rows * ROW_H) return;
    const { centerBin, markBin, step } = o, top = Math.floor(rows / 2);
    const rowOf = (bin: number) => centerBin + top - g.bin0 - bin;
    const hb = centerBin + top - Math.floor((hv.y - head) / ROW_H) - g.bin0, mb = 2 * markBin - hb;
    if (hb === markBin) return;
    const clamp = (i: number) => Math.max(0, Math.min(g.nBins - 1, i));
    const askAt = (i: number) => cum.ask[clamp(i)]!, bidAt = (i: number) => cum.bid[clamp(i)]!;
    const clipped = mb < 0 || mb >= g.nBins || hb < 0 || hb >= g.nBins;
    const above = hb > markBin ? askAt(hb) : askAt(mb), below = hb > markBin ? bidAt(mb) : bidAt(hb);
    const stats = mirrorStats(o.mark, o.mark + (hb - markBin) * step, above, below, clipped);
    if (!stats) return;
    this.mirror = stats;
    const bandTop = head + rowOf(Math.max(hb, mb)) * ROW_H, bandBottom = head + (rowOf(Math.min(hb, mb)) + 1) * ROW_H, pct = percentText(stats);
    dimOutside(ctx, o.x, o.w, head, head + rows * ROW_H, bandTop, bandBottom, p.bg, 0.55);
    paintBand(ctx, p, o.x, o.w, { y: bandTop, color: p.ask, label: `${usd(stats.aboveUsd)} · ${pct}` }, { y: bandBottom, color: p.bid, label: `${usd(stats.belowUsd)} · ${pct}` }, { y0: head, y1: head + rows * ROW_H });
    paintMirrorBox(ctx, mirrorLines(stats, { above: 'Asks', below: 'Bids' }, o.title || undefined), hv.x, hv.y, { x0: o.x, y0: head, x1: o.x + o.w, y1: head + rows * ROW_H }, p,
      c => c === 'above' ? p.ask : c === 'below' ? p.bid : c === 'muted' ? p.muted : p.text, stats.hoveredSide === 'above' ? 'down' : 'up');
  }

  /**
   * Cumulative size: a light area stepping outward from the mark, with a crisp outline in the
   * side's colour along its edge, behind the level bars. It stops where a venue's feed stops reaching (those rows are shaded).
   */
  #paintCumulative(ctx: CanvasRenderingContext2D, g: Grouped, cum: ReturnType<typeof cumulative>,
    o: { head: number; rows: number; centerBin: number; markBin: number; step: number; cover: { lo: number; hi: number } | null }, barX: number, barW: number, maxCum: number, weight: (bin: number, bidSide: boolean) => number): void {
    const p = this.#palette, { head, rows, centerBin, markBin, step } = o, half = Math.floor(rows / 2);
    const markAsk = (g.totalAsk[markBin] ?? 0) > (g.totalBid[markBin] ?? 0);
    const outline = (up: boolean, startBin: number, color: string, values: Float32Array) => {
      const steps: Array<[number, number, number, number]> = []; // x, edge nearer the mark, edge farther from it, bin
      for (let bin = startBin; up ? bin < g.nBins : bin >= 0; bin += up ? 1 : -1) {
        const r = centerBin + half - g.bin0 - bin;
        if (r < 0 || r >= rows) break;
        const rowLo = (g.bin0 + bin) * step;
        if (o.cover && (rowLo + step <= o.cover.lo || rowLo >= o.cover.hi)) break;
        const y = head + r * ROW_H;
        steps.push([barX + values[bin]! / maxCum * barW, up ? y + ROW_H : y, up ? y : y + ROW_H, bin]);
      }
      if (!steps.length || !(values[startBin]! > 0)) return;
      ctx.save();
      ctx.beginPath(); ctx.moveTo(barX, steps[0]![1]);
      for (const [x, near, far] of steps) { ctx.lineTo(x, near); ctx.lineTo(x, far); }
      ctx.globalAlpha = 0.92; ctx.strokeStyle = color; ctx.lineWidth = 1.25; ctx.lineJoin = 'miter'; ctx.stroke();
      // The area behind the outline is filled row by row so its strength can follow which side dominates at that distance.
      ctx.fillStyle = color;
      for (const [x, near, far, bin] of steps) { ctx.globalAlpha = Math.min(0.4, 0.16 * weight(bin, !up)); ctx.fillRect(barX, Math.min(near, far), Math.max(0, x - barX), Math.abs(far - near)); }
      ctx.restore();
    };
    outline(true, markAsk ? markBin : markBin + 1, p.ask, cum.ask);
    outline(false, markAsk ? markBin - 1 : markBin, p.bid, cum.bid);
  }

  /**
   * A slim bar under the header: the cumulative bid and ask liquidity within the visible range, as shares of their sum, so which side
   * is more dominant (and by how much) reads at a glance. The strength of each row below follows the same comparison at its own distance.
   */
  #paintBalance(ctx: CanvasRenderingContext2D, g: Grouped, cum: ReturnType<typeof cumulative>, o: { head: number; balanceH: number; rows: number; markBin: number }, x0: number, w: number): void {
    const p = this.#palette, top = o.head - o.balanceH + 1, h = o.balanceH - 3;
    const { bid, ask } = liquidityWithin(g, cum, o.markBin, Math.floor(o.rows / 2));
    const total = bid + ask; if (!(total > 0)) return;
    const share = bid / total, split = x0 + 6 + (w - 12) * share, left = x0 + 6, right = x0 + w - 6, dominantBid = share >= 0.5;
    ctx.globalAlpha = dominantBid ? 0.85 : 0.35; ctx.fillStyle = p.bid; ctx.fillRect(left, top, split - left, h);
    ctx.globalAlpha = dominantBid ? 0.35 : 0.85; ctx.fillStyle = p.ask; ctx.fillRect(split, top, right - split, h);
    ctx.globalAlpha = 1; ctx.fillStyle = p.bg; ctx.fillRect(split - 0.5, top, 1, h);
    ctx.font = '600 10px ui-monospace, SFMono-Regular, Menlo, monospace'; ctx.fillStyle = p.dark ? '#ffffff' : '#14171c';
    ctx.textAlign = 'left'; if (split - left > 70) ctx.fillText(`bids ${Math.round(share * 100)}%`, left + 5, top + h / 2 + 0.5);
    ctx.textAlign = 'right'; if (right - split > 70) ctx.fillText(`${Math.round((1 - share) * 100)}% asks`, right - 5, top + h / 2 + 0.5);
    ctx.font = '11px ui-monospace, SFMono-Regular, Menlo, monospace';
  }

  #drawBook(ctx: CanvasRenderingContext2D, state: AppState, g: Grouped,
    o: { x: number; w: number; title: string; cells: string[] | null; cellW: number; head: number; balanceH: number; cover: { lo: number; hi: number } | null; centerBin: number; rows: number; markBin: number; mark: number; step: number }): void {
    const p = this.#palette, { x: x0, w, rows, markBin, step, centerBin } = o;
    const cum = cumulative(g, o.mark);
    const dominance = state.highlight.on ? imbalanceByDistance(g, cum, markBin) : null;
    const weight = (bin: number, bidSide: boolean): number => dominance ? dominanceWeight(dominance[bin]!, bidSide) : 1;
    // `head` is where the rows start; the labels sit above the balance bar, which takes the last `balanceH` of it.
    const priceW = PRICE_W, usdW = USD_W, cellIds = o.cells, cw = o.cellW, head = o.head - o.balanceH, venueW = cellIds ? cellIds.length * cw + 2 : 0;
    const barX = x0 + priceW + usdW + venueW + 8, barW = Math.max(20, x0 + w - barX - 6);
    ctx.fillStyle = p.muted; ctx.textAlign = 'left';
    if (o.title) { ctx.fillStyle = p.text; ctx.font = '600 11px ui-monospace, SFMono-Regular, Menlo, monospace'; ctx.fillText(o.title, x0 + 6, head / 2); ctx.font = '11px ui-monospace, SFMono-Regular, Menlo, monospace'; ctx.fillStyle = p.muted; }
    else {
      const line = head - HEAD_H / 2;
      ctx.fillText('PRICE', x0 + 6, line); ctx.textAlign = 'right'; ctx.fillText('LEVEL USD', x0 + priceW + usdW, line);
      if (cellIds) {
        ctx.textAlign = 'left';
        if (cw >= 20) cellIds.forEach((id, k) => ctx.fillText(venueLabel(id).slice(0, 3).toUpperCase(), x0 + priceW + usdW + 10 + k * cw, line));
        else {
          // Narrow cells: names run upward from each cell so any number of venues stays readable.
          ctx.font = '9px ui-monospace, SFMono-Regular, Menlo, monospace';
          cellIds.forEach((id, k) => { ctx.save(); ctx.translate(x0 + priceW + usdW + 8 + k * cw + cw / 2 + 3, head - 2); ctx.rotate(-Math.PI / 2); ctx.fillText(venueLabel(id).slice(0, 5), 0, 0); ctx.restore(); });
          ctx.font = '11px ui-monospace, SFMono-Regular, Menlo, monospace';
        }
      }
      ctx.textAlign = 'left'; ctx.fillText(state.ladderShow === 'levels' ? 'DEPTH' : 'DEPTH + CUM', barX, line);
    }
    let maxLevel = 1; const maxCum = Math.max(cum.maxBid, cum.maxAsk, 1);
    for (let i = 0; i < g.nBins; i++) maxLevel = Math.max(maxLevel, g.totalBid[i]!, g.totalAsk[i]!);
    if (state.ladderShow !== 'levels') this.#paintCumulative(ctx, g, cum, o, barX, barW, maxCum, weight);
    if (o.balanceH > 0) this.#paintBalance(ctx, g, cum, o, x0, w);
    for (let r = 0; r < rows; r++) {
      const bin = centerBin + Math.floor(rows / 2) - r - g.bin0;
      if (bin < 0 || bin >= g.nBins) continue;
      const y = o.head + r * ROW_H, mid = y + ROW_H / 2;
      const rowLo = (g.bin0 + bin) * step;
      if (o.cover && (rowLo + step <= o.cover.lo || rowLo >= o.cover.hi)) {
        // Beyond what this venue's feed reaches: shade the row instead of showing a misleading empty book.
        ctx.globalAlpha = 0.5; ctx.fillStyle = p.line; ctx.fillRect(x0, y, w, ROW_H); ctx.globalAlpha = 1;
        ctx.fillStyle = p.muted; ctx.textAlign = 'left'; ctx.fillText(fmtPrice(rowLo, step), x0 + 6, mid);
        continue;
      }
      const bid = g.totalBid[bin]!, ask = g.totalAsk[bin]!, isAsk = bin > markBin || (bin === markBin && ask > bid);
      const value = isAsk ? ask : bid, color = isAsk ? p.ask : p.bid, f = weight(bin, !isAsk);
      if (bin === markBin) { ctx.fillStyle = p.line; ctx.fillRect(x0, y, w, ROW_H); }
      ctx.fillStyle = p.muted; ctx.textAlign = 'left'; ctx.fillText(fmtPrice((g.bin0 + bin) * step, step), x0 + 6, mid);
      ctx.fillStyle = value > 0 ? p.text : p.muted; ctx.textAlign = 'right'; ctx.fillText(value > 0 ? usd(value) : '', x0 + priceW + usdW, mid);
      if (cellIds) cellIds.forEach((_, k) => {
        const vv = (isAsk ? g.ask[k] : g.bid[k])?.[bin] ?? 0;
        if (vv > 0) { ctx.globalAlpha = Math.min(1, (0.18 + 0.82 * Math.sqrt(vv / maxLevel)) * f); ctx.fillStyle = color; ctx.fillRect(x0 + priceW + usdW + 8 + k * cw, y + 3, Math.max(2, cw - 2), ROW_H - 6); ctx.globalAlpha = 1; }
      });
      if (state.ladderShow !== 'cumulative' && value > 0) {
        if (cellIds) {
          let x = barX;
          cellIds.forEach((_, k) => {
            const vv = (isAsk ? g.ask[k] : g.bid[k])?.[bin] ?? 0; if (vv <= 0) return;
            const seg = vv / maxLevel * barW; ctx.globalAlpha = Math.min(1, (0.35 + 0.5 * (VENUE_TINT[k % VENUE_TINT.length] ?? 1)) * f); ctx.fillStyle = color; ctx.fillRect(x, y + 2, Math.max(1, seg - 0.5), ROW_H - 4); x += seg;
          });
          ctx.globalAlpha = 1;
        } else { ctx.globalAlpha = Math.min(1, 0.75 * f); ctx.fillStyle = color; ctx.fillRect(barX, y + 2, Math.max(1, value / maxLevel * barW), ROW_H - 4); ctx.globalAlpha = 1; }
      }
      if (bin === markBin) { ctx.fillStyle = p.ask; ctx.fillRect(x0, y + ROW_H - 1, w, 1); }
    }
    this.#paintMirror(ctx, state, g, cum, o, o.head, rows);
    // The scale label shares the header row with the DEPTH label, so it only appears when the bar column is wide enough for both.
    if (o.title || barW >= 170) { ctx.fillStyle = p.muted; ctx.textAlign = 'right'; ctx.fillText(`MAX ${usd(maxLevel)}`, x0 + w - 6, head - HEAD_H / 2); }
  }
}
