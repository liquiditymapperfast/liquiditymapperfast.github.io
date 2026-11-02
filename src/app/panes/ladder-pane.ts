import { venueLabel } from '../venues.ts';
import { activeIds, emptyScopeMessage, kindOf } from '../scope.ts';
import { el } from '../dom.ts';
import { setTip } from '../tip.ts';
import { helpButton } from '../help.ts';
import { addTune } from '../pane-tune.ts';
import { button, checkRow, note, selectRow, switchRow, togglePanel, type Panel } from '../ui.ts';
import type { Kernels } from '../kernels.ts';
import { PALETTES, textOn } from '../theme.ts';
import { niceStep } from '../view.ts';
import { price as fmtPrice, usd } from '../format.ts';
import { LADDER_CURVES, type Store, type AppState } from '../store.ts';
import type { Hub } from '../hub.ts';
import { RANK_MS } from '../cvd/settings.ts';
import { CurveRanking, curveColors, curveLines, cutAtBars, lineFraction, lineTicks, nearestCurve, rankCurveVenues, reachRows, reachText, venueCumulative, CURVE_HIT_PX, CURVE_MIN_ROWS, CURVE_OVER_BAR_SHARE, type CurveVenue, type LineStep } from './ladder-curves.ts';
import { beyondCover, coverage, cumulative, pastReach, dominanceWeight, groupLevels, groupSpan, imbalanceByDistance, liquidityInView, type Cover, type Grouped } from './levels-data.ts';
import { GROUPS, groupsFor, holdsMark, ladderWheel, offsetKeepingPrice, priceAtRow, stepBy } from './ladder-zoom.ts';
import { currentCoin } from '../coin.ts';
import { GestureRecognizer, axisPinchScale, bindTouch, type GestureHandlers, type Pt } from '../touch.ts';
import { dimOutside, mirrorLines, mirrorStats, paintBand, paintMirrorBox, percentText, type MirrorStats } from '../mirror.ts';
import { paintInfoBox, type InfoLine } from '../infobox.ts';
import { byPublication, gutterLines, latestRowChange, levelLines, smallerVenuesLines, venueCellLines, type ChangeFact, type HeatFact, type LevelFacts } from './ladder-info.ts';
import { CueLayer } from './ladder-cue-layer.ts';
import { meanwhile, tradedInRow, type Cell, type CueBoard } from './ladder-cues.ts';
import { heatTone, paintStrip } from './ladder-cue-paint.ts';
import type { CueLookSetting, HeatKind, Sense } from './ladder-cue-settings.ts';
import { barPieces, pieceAt, pieceLabel, rankVenues, type BarPiece } from './ladder-pieces.ts';
import { drawVenueMark } from '../venue-marks.ts';
import { PullHistory, pullBase, readPullWindow, type PullRows } from './pull-stack.ts';
import { lineSide } from '../price-line.ts';
import { t } from '../i18n.ts';
import { replaying } from '../replay/clock.ts';
import { FitGrid } from '../ui/fit-grid.ts';

const ROW_H = 17;
const HEAD_H = 20;
const HEAD_TALL = 46;
/** Height of the balance bar under the header (bids against asks within the visible range). */
const BALANCE_H = 16;
const PRICE_W = 58, USD_W = 54, MIN_BAR_W = 90, CELL_MAX = 26, CELL_MIN = 5;
/** The pull/stack column beside LEVEL USD, while it is on. */
const PS_W = 58;
/** The gutter before the bars that holds each row's signed mark (the cues' still face); drawn while the cues are not Off. */
const GUT_W = 12;
/** How long the pointer still finds a change at a row, so a cell that went quiet reads "a minute ago" and not nothing. */
const CHANGE_HOVER_MS = 120_000;
/** A window as the popup says it: "15 s", "1 min". */
const windowText = (s: number): string => s < 60 ? t('{n} s', { n: s }) : t('{n} min', { n: s / 60 });
const signedUsd = (v: number): string => `${v > 0 ? '+' : v < 0 ? '−' : ''}${usd(Math.abs(v))}`;
/** Dragging the price column zooms; this is the width of that column's hit area, and how far to drag per zoom step. */
const AXIS_W = PRICE_W + 6, AXIS_DRAG_PX = 26;
const BOOK_MIN_W = 250;
/** A pane narrower than this draws no book (it is hidden: it has no size), and lights nothing. */
const MIN_BOOK_W = 80;
/** A step as the Group list writes it: as it is, or in decimals once it is small enough that it would read "2e-9". */
const stepText = (step: number): string => step >= 1e-4 ? String(step) : fmtPrice(step, step);

const VENUE_TINT = [1, 0.62, 0.38, 0.8, 0.5, 0.7, 0.3, 0.9];
/** A Compact bar's piece narrower than this joins the smaller venues' piece at the end of the bar. */
const PIECE_MIN_PX = 3;
/** No bars at all: a line cut against it is all in the clear. */
const NO_BARS: readonly number[] = [];
/** How long the Compact bar keeps its venue order while the venues stay the same (it is made again when they change). */
const ORDER_HOLD_MS = 300_000;
/** The venue a book belongs to, as a popup names it: "Binance BTCUSDT". */
const bookName = (id: string): string => `${venueLabel(id)} ${id.split(':').slice(1).join(':')}`;


export { venueLabel };

/** A venue line of the Compact book this frame: its venue, running totals, reach and colour. */
interface Curve { venue: CurveVenue; index: number; cum: { bid: Float32Array; ask: Float32Array }; cover: Cover | null; color: string }
/**
 * Where the venue lines stand: `x` on a row (null where the line has no place there; a carried row has one whether or not its dashes are drawn), whether that row is past its book's reach (the total held),
 * whether the line has any of its own book in view on that row's side (`capped`: else the held total is all there is of it there), and what
 * full width is.
 */
interface CurveScale { x: (c: Curve, bin: number) => number | null; carried: (c: Curve, bin: number) => boolean; capped: (c: Curve, bin: number) => boolean; full: number }
/** The flow column's ranking window, as the popup says it. */
const rankText = (rank: AppState['cvd']['rank']): string => rank === '15m' ? t('{n} min', { n: 15 }) : t('{n} h', { n: rank === '1h' ? 1 : 24 });

/** What a zoom holds still: the mark on the middle row (`onMark`; the price is then the mark at each step, not the one at the start), or `price` on `row`. */
interface Anchor { onMark: boolean; row: number; price: number }
/** A pointer drag in progress: the book moving with the pointer, or the price column zooming about its anchor. */
type Drag = { kind: 'pan'; y: number; offset: number } | ({ kind: 'zoom'; y: number; step: number } & Anchor);

/** Order-book ladder around the mark. Aggregated sums venues with per-venue cells; Single shows one book per chosen venue side by side. */
export class LadderPane {
  readonly root = document.createElement('section');
  readonly controls = document.createElement('div');
  #scroller = document.createElement('div');
  /**
   * Two canvases laid over each other: the material (the bars, cells, running-total area and what lies under the bars) below, and the ink (every
   * word, mark, line and box, and the pointer) above. A cue lights the material and the words stay clear above it: a wash laid over the
   * words would have washed them too (Sol, 2026-10-22), and repainting only a cell's material under still ink costs a fraction of a repaint of
   * both. Stacked, they look exactly as one canvas drew them: the pointer and the touch handlers are the ink's.
   */
  #matCanvas = document.createElement('canvas');
  #canvas = document.createElement('canvas');
  #mat: CanvasRenderingContext2D;
  #ctx: CanvasRenderingContext2D;
  /** What lights when a venue's displayed depth changes, the heat under each cell, and the gutter's marks (panes/ladder-cue-layer.ts). */
  #cues: CueLayer;
  #cuesButton = document.createElement('button');
  #cuesPanel: Panel | null = null;
  #w = 0; #h = 0; #dpr = 1; #frame = 0;
  #offsetRows = 0;
  #palette = PALETTES.light!;
  #booksButton = document.createElement('button');
  #panel: Panel | null = null;
  #idsKey = '';
  /** The Compact bar's venue order, the venues it was made for and when (see `#venueOrder`). */
  #order: { key: string; order: string[]; at: number } | null = null;
  #hover: { x: number; y: number } | null = null;
  /** One notch per mouse click, one per 40 px of a touchpad, and a limit in time on both, so a spin or a swipe cannot throw the zoom to the end (see ladderWheel). */
  #notches = ladderWheel();
  /** Touch: where a finger pinned the mirror comparison, the pinch in progress, and the fling after a lift. */
  #pinned: Pt | null = null;
  #pinch: { step: number; price: number; row: number } | null = null;
  #fling = 0;
  /** What the last frame drew, which gestures are read against (step 0 until a frame has data). */
  #layout = { step: 0, rows: 0, head: 0, colW: 0, mark: 0 };
  /** The steps the book groups by: BTC's, or BTC's moved to the price of the coin on screen. A saved step not on the list is Auto. */
  readonly #groups: readonly number[] = currentCoin().coin === 'BTC' ? GROUPS : groupsFor(currentCoin().price);
  #drag: Drag | null = null;
  #autoOption: HTMLOptionElement | null = null;
  /** Mirror-hover comparison for the book under the pointer, or null (read by tests, drawn on the canvas). */
  mirror: MirrorStats | null = null;
  /** The book's snapshots for pull/stack (taken only while it is on and the book is drawn). */
  #pull = new PullHistory();
  /** Which venues the Compact book's lines are drawn for, held a minute at a time (see ladder-curves.ts). */
  #curveRank = new CurveRanking();
  /** The books the ranking put among the lines whose reach was too short to draw one (named in the key's popup). */
  #curvesLeftOut: CurveVenue[] = [];
  /** The Venue lines select, shown in Compact only. */
  #curvesControl: HTMLLabelElement | null = null;
  /** The venue line under the pointer in the last frame (its place in the ranking), read by tests. */
  hoveredCurve: number | null = null;
  /** The share of its strength a venue line keeps over a bar (`CURVE_OVER_BAR_SHARE`; 1 draws it as strong over the bars as in the clear, for a comparison). */
  curveOverBars = CURVE_OVER_BAR_SHARE;
  /** The line that was under the pointer in the frame before this one (`hoveredCurve` is cleared as a frame starts): its dashes are drawn, so they answer the pointer. */
  #heldCurve: number | null = null;
  /** The header's layout (ui/fit-grid.ts). */
  #fit: FitGrid | null = null;

  constructor(host: HTMLElement, private store: Store, private kernels: Kernels, private hub: Pick<Hub, 'flow' | 'ensureFlow' | 'tape'> | null = null) {
    this.root.className = 'pane ladder';
    this.controls.className = 'pane-head';
    this.#scroller.className = 'ladder-scroll';
    this.#canvas.className = 'ink';
    this.#scroller.append(this.#matCanvas, this.#canvas);
    this.root.append(this.controls, this.#scroller);
    host.append(this.root);
    this.#mat = this.#matCanvas.getContext('2d')!;
    this.#ctx = this.#canvas.getContext('2d')!;
    this.#cues = new CueLayer({ mat: this.#mat, canvas: this.#matCanvas, dpr: () => this.#dpr, palette: () => this.#palette, shown: () => this.#cueShown(),
      view: () => ({ x0: this.#scroller.scrollLeft, x1: this.#scroller.scrollLeft + this.#w }) });
    this.#cues.setLook(this.store.state.ladderCues.look); this.#cues.setSense(this.store.state.ladderCues.sense);
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
   * The wheel zooms (the grouping steps finer or coarser about the current price, or about the pointer with Alt or once the book is scrolled), dragging the
   * book moves it, dragging the price column zooms the same way, and a double-click puts both back.
   */
  #bindInput(): void {
    const c = this.#canvas;
    const local = (e: MouseEvent) => { const r = c.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; };
    c.addEventListener('wheel', e => {
      if (e.shiftKey) return; // Shift+wheel scrolls Single mode's books sideways
      e.preventDefault();
      const lines = e.deltaMode === 1 ? 33 : e.deltaMode === 2 ? this.#h : 1, pinch = e.ctrlKey ? 8 : 1;
      const notches = this.#notches.add(e.deltaY * lines * pinch, e.timeStamp);
      // Zooming holds the current price where it is, so the book swells and shrinks around it instead of sliding past; once the book has been
      // scrolled off the mark (or with Alt held) it zooms about the pointer instead.
      if (notches) { const a = this.#anchor(this.#rowAt(local(e).y), e.altKey); this.#zoomTo(stepBy(this.#layout.step, notches, this.#groups), a.row, a.price); }
    }, { passive: false });
    c.addEventListener('pointerdown', e => {
      if (e.pointerType === 'touch' || e.button !== 0 || !(this.#layout.step > 0)) return;
      const { x, y } = local(e), row = this.#rowAt(y);
      this.#drag = this.#onAxis(x) ? { kind: 'zoom', y, step: this.#layout.step, ...this.#anchor(row, e.altKey) } : { kind: 'pan', y, offset: this.#offsetRows };
      c.setPointerCapture(e.pointerId); this.#hover = null; this.#cursor(x); this.invalidate();
    });
    c.addEventListener('pointermove', e => {
      if (e.pointerType === 'touch') return;
      const { x, y } = local(e), drag = this.#drag;
      if (drag?.kind === 'zoom') this.#zoomDrag(drag, y); // up zooms in, down out
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
        this.#drag = this.#onAxis(p.x) ? { kind: 'zoom', y: p.y, step: this.#layout.step, ...this.#anchor(row, false) } : { kind: 'pan', y: p.y, offset: this.#offsetRows };
      },
      pan: (_d, p) => {
        const drag = this.#drag;
        if (drag?.kind === 'zoom') this.#zoomDrag(drag, p.y);
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
        this.#zoomTo(stepBy(z.step, notches, this.#groups), z.row, z.price);
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
  /** What a zoom started at `row` holds still (see `holdsMark`): the mark on the middle row, or the price under that row. */
  #anchor(row: number, alt: boolean): Anchor {
    const l = this.#layout;
    return holdsMark({ offsetRows: this.#offsetRows, alt, mark: l.mark }) ? { onMark: true, row: Math.floor(l.rows / 2), price: l.mark } : { onMark: false, row, price: this.#priceAt(row) };
  }
  /** The step a drag of the price column has reached at pointer height `y`: held about its anchor, which for the mark is the mark as it is now (it moves while the hand does). */
  #zoomDrag(drag: Extract<Drag, { kind: 'zoom' }>, y: number): void {
    const l = this.#layout;
    this.#zoomTo(stepBy(drag.step, Math.trunc((y - drag.y) / AXIS_DRAG_PX), this.#groups), drag.onMark ? Math.floor(l.rows / 2) : drag.row, drag.onMark ? l.mark : drag.price);
  }
  /** Group by `step`, keeping `price` (default: what the pointer is over) on `row`, so the zoom is about the pointer rather than the mark. */
  #zoomTo(step: number, row: number, price = this.#priceAt(row)): void {
    const l = this.#layout;
    if (!(l.step > 0) || step === l.step) return;
    this.#offsetRows = offsetKeepingPrice({ mark: l.mark, step, rows: l.rows, row, price });
    l.step = step; // later events in the same frame build on this one
    this.store.set({ grouping: step });
  }
  invalidate(): void { if (this.#suspended) { this.#owed = true; return; } if (!this.#frame) this.#frame = requestAnimationFrame(() => { this.#frame = 0; this.#render(); }); }
  /** Covered by a view of its own (the phone's Candle tab): nothing is drawn until it shows again (pull/stack still takes its snapshots as the frames arrive). */
  #suspended = false; #owed = false;
  /**
   * Covered (the phone's Tape tab) or not. A covered book lights nothing and what was lit is let go; it is drawn again when it shows, whether or not
   * data came meanwhile, so no cue is left painted on the canvas for the first look at it (it may have been covered with cells lit).
   */
  setSuspended(on: boolean): void { if (on === this.#suspended) return; this.#suspended = on; if (on) this.#cues.stop(); else { this.#owed = false; this.invalidate(); } }
  /** Whether the book is on screen and live, which is when it may light anything: the page is visible, the pane is shown and not covered, no replay runs. */
  /** Whether the book is on screen and live: the page is visible, the pane is not covered, hidden (switched off, or by the phone's tabs: it has no size then) or in replay. */
  #cueShown(): boolean { return !document.hidden && !this.#suspended && !this.root.hidden && this.#w >= MIN_BOOK_W && !replaying(); }
  /** The cue settings changed (or another coin's book begins): the layer takes the look, and the book is drawn with or without the gutter and the strips. */
  cuesChanged(): void { this.#cues.setLook(this.store.state.ladderCues.look); this.#cues.setSense(this.store.state.ladderCues.sense); this.invalidate(); }
  /**
   * The book was away: the socket closed or opened again, or the pane was switched off. What was seen before is not compared with what comes
   * after (a reconnect is a new book, not a burst of changes, and a pane switched on again is not shown what happened while it was off).
   */
  interrupted(): void { this.#cues.reset(); }
  /** Market orders arrived (the trade tape): the large ones ripple on the venues' cells they reached, without the book being drawn again. */
  tapeArrived(): void {
    const state = this.store.state, cues = state.ladderCues;
    // Not reading the tape (contacts off, the pane away): the next reading starts where the tape stands, not at the orders that came meanwhile.
    if (!cues.contact || cues.look === 'off' || !state.show.book || !(state.mark.price > 0) || !this.#cueShown()) { this.#cues.forgetTape(); return; }
    const ids = new Set(state.ladderMode === 'single' ? this.#singleIds(state) : activeIds(state));
    if (this.#cues.readContacts(this.hub?.tape ?? null, ids) > 0) this.#cues.lightNow();
  }
  /**
   * What the cues are doing now (read by tests and from the console): cues running, of which showing light (`bright`), marks held, changes waiting,
   * the area they cost at their peak (`used`) and the area showing now (`light`), and what the tracker has counted.
   */
  cueState(): { lit: number; bright: number; light: number; marks: number; waiting: number; used: number; maxArea: number; board: CueBoard['stats']; tracker: CueLayer['tracker']['stats'] } {
    const c = this.#cues, now = performance.now();
    return { lit: c.board.active.length, bright: c.board.brightCount(now), light: c.board.litArea(now), marks: c.board.marks.size, waiting: c.board.waiting, used: c.board.used, maxArea: c.board.maxArea, board: { ...c.board.stats, strengths: [...c.board.stats.strengths] }, tracker: { ...c.tracker.stats } };
  }
  /**
   * A new levels frame: the cues' tracker sees it (whatever pull/stack is doing: the two are separate), and pull/stack takes its snapshot here
   * when one is due, not when the book is drawn. A hidden or covered window draws nothing (the browser stops animation frames) while the
   * frames keep coming, and the first draw after more than `GAP_MS` started the window again, so a book looked at after a while away always
   * said "Loading…" (Karl, 2026-10-15).
   */
  levelsArrived(): void {
    const state = this.store.state, frame = state.levels, mark = state.mark.price, windowS = state.pullStack;
    if (replaying() || !(mark > 0)) this.#cues.reset();
    else this.#cues.feed(frame, state.ladderMode === 'single' ? this.#singleIds(state) : activeIds(state), state.ladderCues.heat !== 'off');
    if (!windowS) { this.#pull.clear(); return; }
    if (!frame || !(mark > 0) || replaying()) return;
    const base = pullBase(this.#groups[0] ?? 0.1);
    this.#pull.noteMark(mark);
    this.#pull.step(this.kernels, frame, mark, Date.now(), windowS, base, `${state.marketId}|${base}|${windowS}`);
  }
  /** The price moved: pull/stack notes it between snapshots (a row the price crossed and left between two frames is still marked touched). */
  markMoved(): void { const state = this.store.state; if (state.pullStack && !replaying()) this.#pull.noteMark(state.mark.price); }
  /** The saved grouping when it is one of this coin's steps (it may have been chosen on another coin), else Auto. */
  #grouping(saved: AppState['grouping']): AppState['grouping'] { return saved !== 'auto' && this.#groups.includes(saved) ? saved : 'auto'; }

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
    const title = document.createElement('strong'); title.textContent = t('Order Book');
    // Recentre, Cues and Books are keys at the end of the title's line (ui/fit-grid.ts): a drawn mark on the desktop, their word on a phone's sheet.
    this.#booksButton.className = 'books-btn head-key'; this.#booksButton.dataset.fit = 'key'; this.#booksButton.textContent = t('Books'); setTip(this.#booksButton, t('Choose which venues get their own book (Single mode)'));
    this.#booksButton.onclick = () => { this.#panel = togglePanel(this.#booksButton, { title: t('Order books'), width: 340, align: 'right', onClose: () => { this.#panel = null; } }, (tools, body) => this.#buildBooks(tools, body)); };
    const recenter = document.createElement('button'); recenter.className = 'recenter-btn head-key'; recenter.dataset.fit = 'key'; recenter.textContent = t('Recenter'); recenter.onclick = () => this.recenter();
    setTip(recenter, t('Recenter'));
    const group = this.#select(t('Group'), [['auto', t('Auto')], ...this.#groups.map(g => [String(g), stepText(g)] as [string, string])], () => String(this.#grouping(s().grouping)), v => this.store.set({ grouping: v === 'auto' ? 'auto' : Number(v) }));
    setTip(group, t('Price step per row. Scroll over the book, or drag its price column up and down, to zoom; drag the book to move it; double-click to reset.'));
    this.#autoOption = group.querySelector('option[value="auto"]');
    const pull = this.#select(t('Pull/stack'), [['0', t('off')], ...[15, 60, 300].map(s => [String(s), windowText(s)] as [string, string])], () => String(s().pullStack), v => this.store.set({ pullStack: readPullWindow(Number(v)) }));
    setTip(pull, t('How much resting liquidity each price gained (+, stacked) or lost (−, pulled) over this window. Grey: the price traded there in the window, where a fill takes liquidity away just as a pull does.'));
    const curves = this.#curvesControl = this.#select(t('Venue lines'), LADDER_CURVES.map(n => [String(n), n === 0 ? t('off') : t('top {n}', { n })] as [string, string]), () => String(s().ladderCurves), v => this.store.set({ ladderCurves: Number(v) as AppState['ladderCurves'] }));
    setTip(curves, t('Compact: a running-total line for each of the largest venues, ranked by traded volume over the flow column\'s ranking window. Hover a line to see it alone.'));
    this.#cuesButton.className = 'cues-btn head-key'; this.#cuesButton.dataset.fit = 'key'; this.#cuesButton.textContent = t('Cues');
    setTip(this.#cuesButton, t('What lights in the book when a venue\'s displayed depth changes, and the heat strip under each cell. Hover a cell, or the mark beside a row, to see what changed.'));
    this.#cuesButton.onclick = () => { this.#cuesPanel = togglePanel(this.#cuesButton, { title: t('Order book cues'), width: 340, align: 'right', onClose: () => { this.#cuesPanel = null; } }, (_tools, body) => this.#buildCues(body)); };
    const show = this.#select(t('Show'), [['both', t('Levels + cum')], ['levels', t('Levels')], ['cumulative', t('Cumulative')]], () => s().ladderShow, v => this.store.set({ ladderShow: v as AppState['ladderShow'] }));
    // The choices are one fit grid (ui/fit-grid.ts): on the title's line when they all fit there, otherwise the mode there (when it fits) and
    // the others as tiles of one width under it.
    const mode = this.#select(t('Mode'), [['aggregated', t('Aggregated')], ['single', t('Single')], ['compact', t('Compact')]], () => s().ladderMode, v => this.store.set({ ladderMode: v as AppState['ladderMode'] }));
    mode.dataset.fit = 'lead';
    const cells = el('div', {}, mode, group, curves, show, pull);
    this.controls.append(title, helpButton('orderBook'), cells, recenter, this.#cuesButton, this.#booksButton);
    this.#fit = new FitGrid(this.controls, cells, this.root);
    this.syncVenues();
    // On a phone the mode and the grouping stay in the row; the rest waits behind the key at its end (pane-tune.ts).
    addTune(this.controls, [curves, show, pull, this.#cuesButton, this.#booksButton], t('Order Book'));
  }

  /** The cue settings the book is drawn from, changed from the Cues panel. */
  #setCues(patch: Partial<AppState['ladderCues']>): void { this.store.set({ ladderCues: { ...this.store.state.ladderCues, ...patch } }); }
  #buildCues(body: HTMLElement): void {
    const cues = this.store.state.ladderCues;
    const flash: [CueLookSetting, string][] = [['off', t('off')], ['wash', t('Wash')], ['rim', t('Rim')], ['deposit', t('Deposit')], ['marks', t('Signs')]];
    const heat: [HeatKind, string][] = [['off', t('off')], ['added', t('Recent adds')], ['activity', t('Activity')]];
    body.append(
      selectRow(t('Flash'), t('What lights when a venue\'s displayed depth at a price changes.'), flash, cues.look, v => this.#setCues({ look: v as CueLookSetting })),
      note(t('Wash lights the venue\'s cell and runs a front through it: outward when depth was added, back inward when it was removed. Rim lights only the cell\'s outer edge. Deposit shows the layer an addition made. Signs lights nothing and leaves a small mark beside each row for a few seconds. Light is limited so that a busy book stays readable: a change that gets none still leaves its mark.')),
      selectRow(t('Sensitivity'), t('How large a change must be to light a cell.'), [['calm', t('Calm')], ['normal', t('Normal')], ['lively', t('Lively')]] as [Sense, string][], cues.sense, v => this.#setCues({ sense: v as Sense })),
      switchRow(t('Trade contact'), t('A quick ripple on a venue\'s cell when a large market order reaches it.'), cues.contact, on => this.#setCues({ contact: on })),
      note(t('A ripple says an order met the depth at that price. It does not say the depth changed: a change has its own light.')),
      selectRow(t('Heat'), t('A strip under each venue\'s part of a level.'), heat, cues.heat, v => this.#setCues({ heat: v as HeatKind })),
      note(t('Recent adds: the share of the cell that is estimated recent net increase, fading over 45 seconds. Activity: how much it changed lately, additions and removals, against its size. Neither is the age of an order: the exchanges do not send one.')),
    );
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
    if (this.#curvesControl) this.#curvesControl.hidden = this.store.state.ladderMode !== 'compact';
    if (!single) this.#panel?.close();
    const key = (this.store.state.levels?.books ?? []).map(b => b.id).join(',');
    if (key !== this.#idsKey) { this.#idsKey = key; this.#panel?.render((tools, body) => this.#buildBooks(tools, body)); }
  }
  #buildBooks(tools: HTMLElement, body: HTMLElement): void {
    const state = this.store.state, ids = (state.levels?.books ?? []).map(book => book.id), shown = new Set(this.#singleIds(state));
    const choose = (wanted: string[]): void => this.store.set({ ladderVenues: wanted });
    tools.append(button(t('All'), () => choose([]), t('Every enabled venue gets a book')),
      button(t('Spot'), () => choose(ids.filter(id => kindOf(state.markets, id) === 'spot')), t('Only spot venues')),
      button(t('Perp'), () => choose(ids.filter(id => kindOf(state.markets, id) === 'perp')), t('Only perpetual venues')),
      el('span', { class: 'muted', textContent: t('{shown} of {total} shown', { shown: shown.size, total: ids.length }) }));
    body.append(note(t('Single mode draws one book per venue side by side. Pick which venues get a column.')));
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
    for (const c of [this.#matCanvas, this.#canvas]) {
      if (c.width !== Math.round(width * this.#dpr) || c.height !== Math.round(this.#h * this.#dpr)) { c.width = Math.round(width * this.#dpr); c.height = Math.round(this.#h * this.#dpr); }
      c.style.width = `${width}px`; c.style.height = `${this.#h}px`;
    }
    // Single mode puts several books side by side: a sideways swipe scrolls them (the browser's job), up and down stays ours.
    const touchAction = width > this.#w + 1 ? 'pan-x' : 'none';
    if (this.#canvas.style.touchAction !== touchAction) this.#canvas.style.touchAction = touchAction;
  }

  #render(): void {
    const state = this.store.state, p = this.#palette;
    this.mirror = null; this.#heldCurve = this.hoveredCurve; this.hoveredCurve = null;
    const frame = state.levels, mark = state.mark.price;
    const books = state.ladderMode === 'single' ? this.#singleIds(state) : [];
    const columns = state.ladderMode === 'single' ? Math.max(1, books.length) : 1;
    const width = Math.max(this.#w, columns * BOOK_MIN_W);
    this.#setCanvas(width);
    const ctx = this.#ctx, mat = this.#mat, h = this.#h;
    for (const c of [mat, ctx]) { c.setTransform(this.#dpr, 0, 0, this.#dpr, 0, 0); c.clearRect(0, 0, width, h); }
    // The context keeps the last frame's alignment (the columns are right-aligned): a message starts at the left.
    ctx.font = '11px ui-monospace, SFMono-Regular, Menlo, monospace'; ctx.textBaseline = 'middle'; ctx.textAlign = 'left';
    if (!frame || !(mark > 0) || width < MIN_BOOK_W) { ctx.fillStyle = p.muted; ctx.fillText(t('Waiting for order book…'), 12, 20); this.#cues.stop(); return; }
    // Replay: the books are recorded a minute at a time (the map's columns), not as a ladder; this one is the live book, which would mislead.
    if (replaying()) { ctx.fillStyle = p.muted; ctx.fillText(t('Replay: the order book is live only.'), 12, 20); this.#cues.stop(); return; }
    // Pull/stack: its snapshots are taken as the frames arrive (`levelsArrived`); here only the price between them is noted.
    const pullS = state.pullStack;
    if (pullS) this.#pull.noteMark(mark);
    else this.#pull.clear();
    const ids = state.ladderMode === 'single' ? books : activeIds(state);
    // With every venue switched off (or the Spot / Perp filter leaving none) there is nothing to list: say so, not a column of bare prices.
    if (!ids.length) { ctx.fillStyle = p.muted; ctx.fillText(emptyScopeMessage(state) ?? (frame.books.length ? t('No venues are enabled.') : t('Waiting for order book…')), 12, 20); this.#cues.stop(); return; }
    const cells = state.ladderMode === 'aggregated' && ids.length > 1;
    const cellW = cells ? Math.max(CELL_MIN, Math.min(CELL_MAX, Math.floor((width - PRICE_W - USD_W - (pullS ? PS_W : 0) - 8 - (this.#cues.gutter ? GUT_W : 0) - MIN_BAR_W) / ids.length))) : 0;
    const balanceH = state.highlight.on ? BALANCE_H : 0;
    const head = (cells && cellW < 20 ? HEAD_TALL : HEAD_H) + balanceH;
    const rows = Math.max(6, Math.floor((h - head) / ROW_H));
    const grouping = this.#grouping(state.grouping), step = grouping === 'auto' ? niceStep(mark * 0.012, rows / 2) : grouping;
    this.#layout = { step, rows, head, colW: width / columns, mark };
    if (this.#autoOption) { const text = grouping === 'auto' ? `${t('Auto')} · ${stepText(step)}` : t('Auto'); if (this.#autoOption.text !== text) this.#autoOption.text = text; }
    const centerBin = Math.floor(mark / step) + this.#offsetRows;
    const p0 = (centerBin - rows / 2) * step, p1 = (centerBin + rows / 2 + 1) * step;
    // The running totals walk out from the mark, so a view scrolled away from it also groups the rows between: grouped from its own edge, a
    // total there started at nothing (a Codex review, 2026-10-16, saw one go 60 → 50 → 0 as the book was dragged). The bars, the MAX and
    // everything else read only the rows on screen.
    // The same distance on the other side of the mark too, so what compares the two sides at a distance (the highlight, Mirror) has both.
    // Scrolled further than one grouping holds, the view alone, and no running totals: they would start at its edge.
    const span = groupSpan(p0, p1, mark, step), withMark = span !== null;
    const g = groupLevels(this.kernels, frame, ids, step, span?.lo ?? p0, span?.hi ?? p1);
    const markBin = Math.floor(mark / step) - g.bin0;
    this.#cues.begin({ top: centerBin + Math.floor(rows / 2), rows, head, rowH: ROW_H, step, perVenue: state.ladderMode === 'single' });
    if (state.ladderMode === 'single') {
      const colW = width / columns;
      ids.forEach((id, k) => {
        const idx = g.ids.indexOf(id); if (idx < 0) return;
        const own = this.#own(g, idx);
        this.#drawBook(mat, ctx, state, own, { x: k * colW, w: colW, title: `${venueLabel(id)} ${id.split(':').slice(1).join(':')}`, markId: id, pullIds: [id], cells: null, order: null, cellW: 0, head, balanceH, cover: coverage(frame.books.find(b => b.id === id), mark), totals: withMark, centerBin, rows, markBin, mark, step });
        if (k > 0) { ctx.strokeStyle = p.line; ctx.beginPath(); ctx.moveTo(k * colW + 0.5, 0); ctx.lineTo(k * colW + 0.5, h); ctx.stroke(); }
      });
    } else {
      const hiBin = centerBin + Math.floor(rows / 2) - g.bin0;
      const order = state.ladderMode === 'compact' && ids.length > 1 ? this.#venueOrder(g, hiBin - rows + 1, hiBin) : null;
      this.#curvesLeftOut = [];
      const curves = withMark && state.ladderMode === 'compact' && state.ladderShow !== 'levels' && state.ladderCurves > 0 ? this.#curves(state, g, frame, markBin, hiBin - rows + 1, hiBin) : null;
      // The cell columns are the grouping's own venues, in its order (`g.ids`): the arrays the cells are read from are indexed by it.
      this.#drawBook(mat, ctx, state, g, { x: 0, w: width, title: '', pullIds: ids, cells: cells ? g.ids : null, order, curves, cellW, head, balanceH, cover: null, totals: withMark, centerBin, rows, markBin, mark, step });
    }
    // The cues go over what was just drawn (the resting material is copied for them, the lit cells are laid over it, and a frame loop runs only while any is lit).
    this.#cues.end();
  }

  /** One book's grouping for Single mode (its own rows as the totals), made once for a grouping so the running totals made from it are shared too. */
  #owns = new WeakMap<Grouped, Grouped[]>();
  #own(g: Grouped, index: number): Grouped {
    let list = this.#owns.get(g);
    if (!list) { list = []; this.#owns.set(g, list); }
    return list[index] ??= { ...g, totalBid: g.bid[index]!, totalAsk: g.ask[index]! };
  }

  /**
   * The Compact book's venue lines: the books ranked as the flow column ranks exchanges (traded volume over its ranking window, a book with
   * no trades held by its liquidity in view), held a minute at a time; each with its running total, its reach and its colour.
   */
  #curves(state: AppState, g: Grouped, frame: NonNullable<AppState['levels']>, markBin: number, loBin: number, hiBin: number): Curve[] {
    const now = Date.now(), windowMs = RANK_MS[state.cvd.rank], n = state.ladderCurves;
    const venues = this.#curveRank.apply(now, g.ids, n, () => {
      // The volumes the column would count (one request when the flow book lacks them; nothing while it holds them).
      void this.hub?.ensureFlow(g.ids, now - windowMs);
      const nowSec = Math.floor(now / 1000), from = nowSec - Math.round(windowMs / 1000) + 1;
      const volume = (id: string): number | null => { const s = this.hub?.flow.get(id); return s && !s.empty ? s.gross(from, nowSec) : null; };
      const liquidity = (id: string): number => {
        const i = g.ids.indexOf(id); let sum = 0;
        for (let b = Math.max(0, loBin); b <= Math.min(g.nBins - 1, hiBin); b++) sum += (g.bid[i]?.[b] ?? 0) + (g.ask[i]?.[b] ?? 0);
        return sum;
      };
      // Judged once a ranking, not each frame, so the set of lines does not flicker as a reach moves about the threshold.
      const drawable = (id: string): boolean => reachRows(coverage(frame.books.find(b => b.id === id), state.mark.price), state.mark.price, g.step) >= CURVE_MIN_ROWS;
      return rankCurveVenues(g.ids, volume, liquidity, n, drawable);
    }, `${state.cvd.rank}|${g.step}`); // another Group step judges the reach again
    this.#curvesLeftOut = venues.filter(v => v.shallow);
    const drawn = venues.filter(v => !v.shallow), colors = curveColors(this.#palette, drawn.length);
    return drawn.flatMap((venue, k) => {
      const index = g.ids.indexOf(venue.id); if (index < 0) return [];
      return [{ venue, index, cum: venueCumulative(g, index, markBin), cover: coverage(frame.books.find(b => b.id === venue.id), state.mark.price), color: colors[k]! }];
    });
  }

  /**
   * The order the Compact bar keeps its venues in: the most liquidity on the rows in view first. It is held while the same venues are on the
   * book (for `ORDER_HOLD_MS`), so a venue keeps its place on every row and from one frame to the next.
   */
  #venueOrder(g: Grouped, loBin: number, hiBin: number): string[] {
    const key = [...g.ids].sort().join(','), now = Date.now(), held = this.#order;
    if (held && held.key === key && now - held.at < ORDER_HOLD_MS) return held.order;
    const totals = new Map<string, number>();
    g.ids.forEach((id, i) => {
      let sum = 0;
      for (let b = Math.max(0, loBin); b <= Math.min(g.nBins - 1, hiBin); b++) sum += (g.bid[i]?.[b] ?? 0) + (g.ask[i]?.[b] ?? 0);
      totals.set(id, sum);
    });
    const order = rankVenues(g.ids, id => totals.get(id) ?? 0);
    this.#order = { key, order, at: now };
    return order;
  }

  /**
   * A Compact bar's pieces: each venue's part in the bar's order, the shade alternating with its place (so neighbours stay apart) and a hair
   * of background between them; the smaller venues' piece at the end lighter. A piece wide enough says whose it is, and its size when it fits.
   */
  #paintPieces(mat: CanvasRenderingContext2D, ctx: CanvasRenderingContext2D, pieces: readonly BarPiece[], y: number, color: string, f: number): void {
    const p = this.#palette;
    ctx.font = '600 10px ui-sans-serif, system-ui, sans-serif'; ctx.textAlign = 'left';
    const measure = (text: string): number => ctx.measureText(text).width;
    for (const piece of pieces) {
      const alpha = Math.min(1, (piece.rank < 0 ? 0.4 : piece.rank % 2 === 0 ? 0.92 : 0.62) * f), w = Math.max(1, piece.w - (piece.w >= 3 ? 1 : 0));
      mat.globalAlpha = alpha; mat.fillStyle = color; mat.fillRect(piece.x, y + 2, w, ROW_H - 4);
      mat.globalAlpha = 1;
      // A piece wide enough starts with its venue's mark, and says what fits after it.
      const marked = piece.id !== null && w >= 15, MARK = 11, after = marked ? MARK + 4 : 0;
      if (marked) drawVenueMark(ctx, piece.id!, piece.x + 2 + MARK / 2, y + ROW_H / 2, MARK);
      const label = piece.id ? pieceLabel(piece.id, usd(piece.usd), w - after, measure) : piece.merged.length > 1 && measure(`+${piece.merged.length}`) + 8 <= w ? `+${piece.merged.length}` : null;
      if (label) { ctx.fillStyle = textOn(color, alpha, p); ctx.fillText(label, piece.x + (marked ? 2 + after : 4), y + ROW_H / 2 + 0.5); }
    }
    ctx.font = '11px ui-monospace, SFMono-Regular, Menlo, monospace';
  }

  /**
   * What the pointer is directly on, if it is on something drawn: a venue's cell (or its piece of the bar) says that venue's part of the
   * level, and the USD column or a plain bar says the whole level. Null over the price column, empty space and the cumulative area.
   */
  #cellUnder(state: AppState, g: Grouped, cum: ReturnType<typeof cumulative>,
    o: { x: number; w: number; title: string; markId?: string; cells: string[] | null; order: string[] | null; head: number; cover: Cover | null; centerBin: number; rows: number; markBin: number; mark: number; step: number },
    k: { priceW: number; usdW: number; cw: number; barX: number; barW: number; maxLevel: number; pull: PullRows | null; gut: number }): { lines: InfoLine[]; x: number; y: number; w: number; h: number } | null {
    const hv = this.#hover; if (!hv || this.#drag) return null;
    const { x: x0, w, rows, markBin, step, centerBin, head } = o;
    if (hv.x < x0 || hv.x >= x0 + w || hv.y < head || hv.y >= head + rows * ROW_H) return null;
    const r = Math.floor((hv.y - head) / ROW_H), bin = centerBin + Math.floor(rows / 2) - r - g.bin0;
    if (bin < 0 || bin >= g.nBins) return null;
    const rowLo = (g.bin0 + bin) * step;
    if (o.cover && beyondCover(o.cover, rowLo, step)) return null;
    const bid = g.totalBid[bin]!, ask = g.totalAsk[bin]!, isAsk = bin > markBin || (bin === markBin && ask > bid), size = isAsk ? ask : bid;
    // The gutter answers for a row whose level may have emptied (the mark of a cell that went to nothing has no bar to point at), so it comes before the size is asked.
    const rowIds = o.markId ? [o.markId] : g.ids;
    if (k.gut > 0 && hv.x >= k.barX - k.gut && hv.x < k.barX) {
      // The mark in the box is what is pointed at, and it says the side it was made on (the row may show the other side by now); a box with none answers for the side the row shows.
      const mark = this.#cues.board.markAt(g.bin0 + bin, o.markId ?? ''), markAsk = mark ? mark.side === 'ask' : isAsk;
      const changes = this.#changesAt(rowIds, markAsk, rowLo, rowLo + step, g, bin);
      return changes.length ? { lines: gutterLines({ low: rowLo, step, mark: o.mark, ask: markAsk, changes, ...(o.title ? { title: o.title } : {}) }), x: k.barX - k.gut, y: head + r * ROW_H, w: k.gut, h: ROW_H } : null;
    }
    if (!(size > 0)) return null;
    const y = head + r * ROW_H, ids = o.cells, at = (i: number): number => (isAsk ? g.ask[i] : g.bid[i])?.[bin] ?? 0;
    const order = o.order, orderIdx = order ? order.map(id => g.ids.indexOf(id)) : null;
    const venues = ids ? ids.map((id, i) => ({ name: bookName(id), usd: at(i), id })) : order && orderIdx ? order.map((id, n) => ({ name: bookName(id), usd: at(orderIdx[n]!), id })) : [];
    const change = k.pull ? (isAsk ? k.pull.ask[bin]! : k.pull.bid[bin]!) : NaN;
    const facts: LevelFacts = { low: rowLo, step, mark: o.mark, ask: isAsk, size, cumulative: (isAsk ? cum.ask : cum.bid)[bin] ?? size, venues: venues.filter(v => v.usd > 0), ...(o.title ? { title: o.title } : {}),
      ...(change === change && k.pull ? { pull: { usd: change, touched: k.pull.touched[bin] === 1, window: windowText(state.pullStack) } } : {}), changes: this.#changesAt(rowIds, isAsk, rowLo, rowLo + step, g, bin) };
    // A venue's part of the level says its own changes and its heat.
    const heatKind = state.ladderCues.heat;
    const cellFacts = (id: string): LevelFacts => {
      const h = heatKind === 'off' ? null : this.#cues.tracker.heat(id, isAsk ? 'ask' : 'bid', rowLo, rowLo + step, Date.now());
      const heat: HeatFact | null = h && heatKind !== 'off' ? { kind: heatKind, ...h } : null;
      return { ...facts, changes: this.#changesAt([id], isAsk, rowLo, rowLo + step, g, bin), ...(heat ? { heat } : {}) };
    };
    const cellsX = x0 + k.priceW + k.usdW + 8;
    if (ids && hv.x >= cellsX && hv.x < cellsX + ids.length * k.cw) {
      const i = Math.floor((hv.x - cellsX) / k.cw);
      return at(i) > 0 ? { lines: venueCellLines(cellFacts(venues[i]!.id), venues[i]!), x: cellsX + i * k.cw, y: y + 3, w: Math.max(2, k.cw - 2), h: ROW_H - 6 } : null;
    }
    // Compact names every venue of the level (its bar has a piece for each); Aggregated the largest four beside its columns.
    if (hv.x >= x0 + k.priceW && hv.x < x0 + k.priceW + k.usdW) return { lines: levelLines(facts, order ? 12 : 4), x: x0 + k.priceW, y, w: k.usdW, h: ROW_H };
    if (state.ladderShow === 'cumulative' || hv.x < k.barX) return null;
    if (order && orderIdx) {
      const piece = pieceAt(barPieces(order, orderIdx.map(i => at(i)), k.maxLevel, k.barX, k.barW, PIECE_MIN_PX), hv.x);
      if (!piece) return null;
      const lines = piece.id ? venueCellLines(cellFacts(piece.id), { name: bookName(piece.id), usd: piece.usd, id: piece.id }) : smallerVenuesLines({ ...facts, changes: this.#changesAt(piece.merged.map(m => m.id), isAsk, rowLo, rowLo + step, g, bin) }, piece.merged.map(m => ({ name: bookName(m.id), usd: m.usd, id: m.id })));
      return { lines, x: piece.x, y: y + 2, w: Math.max(1, piece.w - 0.5), h: ROW_H - 4 };
    }
    if (ids) {
      let sx = k.barX;
      for (let i = 0; i < ids.length; i++) {
        const vv = at(i); if (vv <= 0) continue;
        const seg = vv / k.maxLevel * k.barW, len = Math.max(1, seg - 0.5);
        if (hv.x < sx + len) return { lines: venueCellLines(cellFacts(venues[i]!.id), venues[i]!), x: sx, y: y + 2, w: len, h: ROW_H - 4 };
        sx += seg;
      }
      return null;
    }
    const len = Math.max(1, size / k.maxLevel * k.barW);
    return hv.x < k.barX + len ? { lines: levelLines(facts), x: k.barX, y: y + 2, w: len, h: ROW_H - 4 } : null;
  }

  /**
   * The latest changes the cues saw at a price row, newest first: each of the books' `ids` own (the last two minutes), named as a popup names a book.
   * Each is the row's change as the light made it (`rowEvents` over the events of the newest publication that touched the row: shared over the row
   * and added up), so the figure the pointer reads is the one the cell was lit with, and a row of several bins that changed together says their sum.
   */
  #changesAt(ids: readonly string[], ask: boolean, lo: number, hi: number, g: Grouped, bin: number): ChangeFact[] {
    // The grouping's own step, never `hi - lo` (the difference of two products is not the step at a decimal one: 0.10000000000582077 for 0.1).
    const now = Date.now(), out: ChangeFact[] = [], step = g.step, scale = this.#cues.scale;
    // What a venue shows in the row now: a row is emptied only if it holds nothing (the change is the part of the row that it touched).
    const held = (id: string): number => { const i = g.ids.indexOf(id); return (ask ? g.ask[i] : g.bid[i])?.[bin] ?? 0; };
    for (const id of ids) {
      const events = this.#cues.tracker.recentEvents(id, ask ? 'ask' : 'bid', lo, hi);
      const r = events.length ? latestRowChange(byPublication(events), g.bin0 + bin, step, scale) : null;
      if (!r || now - r.wall > CHANGE_HOVER_MS) continue;
      const traded = this.#tradedMeanwhile(id, ask, lo, hi, r.prevWall, r.wall);
      out.push({ name: bookName(id), id, usd: r.usd, ageMs: Math.max(0, now - r.wall), removed: r.removed && held(id) === 0, pair: r.pair, ...(traded !== null ? { traded } : {}) });
    }
    return out.sort((a, b) => a.ageMs - b.ageMs);
  }

  /** What traded on `id` at a row around a change seen between the snapshots at `prevWall` and `wall` (null: the tape does not say). Held a second, so a pointer moving over the row does not read the tape again for every draw. */
  #traded = new Map<string, { at: number; usd: number | null }>();
  #tradedMeanwhile(id: string, ask: boolean, lo: number, hi: number, prevWall: number, wall: number): number | null {
    const ring = this.hub?.tape; if (!ring) return null;
    const key = `${id}|${ask ? 1 : 0}|${lo}|${hi}|${prevWall}|${wall}`, now = performance.now(), held = this.#traded.get(key);
    if (held && now - held.at < 1_000) return held.usd;
    if (this.#traded.size > 64) this.#traded.clear();
    const usd = tradedInRow(ring, { id, ask, lo, hi, ...meanwhile(prevWall, wall), now: Date.now() });
    this.#traded.set(key, { at: now, usd });
    return usd;
  }

  /** A venue line under the pointer: a dot where it crosses the pointer's row, and what it says there (on the key: the venue and its volume). */
  #paintCurveInfo(ctx: CanvasRenderingContext2D, state: AppState, g: Grouped, cum: ReturnType<typeof cumulative>, c: Curve, bin: number | null, scale: CurveScale,
    o: { x: number; w: number; head: number; centerBin: number; markBin: number; mark: number; step: number }, rows: number): void {
    const hv = this.#hover, p = this.#palette; if (!hv) return;
    const window = rankText(state.cvd.rank), name = bookName(c.venue.id), bounds = { x0: o.x, y0: o.head, x1: o.x + o.w, y1: o.head + rows * ROW_H };
    const touch = this.#pinned !== null;
    if (bin === null) {
      const lines: InfoLine[] = [{ text: name, bold: true, mark: c.venue.id },
        c.venue.volume !== null ? { label: t('Traded, last {window}', { window }), text: `$${usd(c.venue.volume)} · #${c.venue.rank}` } : { text: t('No trades held for this book: placed by its liquidity in view.'), color: 'muted', wrap: true }];
      if (c.cover) lines.push({ label: t('Its book reaches'), text: reachText(c.cover, o.mark) });
      lines.push({ text: t('Dashed: past the end of its published book, the total it reached. What rests beyond is not known.'), color: 'muted', wrap: true });
      const out = this.#curvesLeftOut;
      if (out.length) lines.push({ text: t('Left out, their books reach under {n} rows: {names}', { n: CURVE_MIN_ROWS, names: out.map(v => `${bookName(v.id)} (#${v.rank})`).join(', ') }), color: 'muted', wrap: true, rule: true });
      paintInfoBox(ctx, lines, hv.x, o.head + 4, bounds, p, { placement: 'up' });
      return;
    }
    const x = scale.x(c, bin); if (x === null) return;
    const markAsk = (g.totalAsk[o.markBin] ?? 0) > (g.totalBid[o.markBin] ?? 0), ask = bin >= (markAsk ? o.markBin : o.markBin + 1);
    const y = o.head + (o.centerBin + Math.floor(rows / 2) - g.bin0 - bin) * ROW_H + ROW_H / 2;
    ctx.save(); ctx.fillStyle = c.color; ctx.strokeStyle = p.bg; ctx.lineWidth = 1.5; ctx.beginPath(); ctx.arc(x, y, 3.5, 0, Math.PI * 2); ctx.fill(); ctx.stroke(); ctx.restore();
    const reach = scale.carried(c, bin) && c.cover ? (ask ? c.cover.hi : c.cover.lo) : null;
    const lines = curveLines({ id: c.venue.id, name, rank: c.venue.rank, low: (g.bin0 + bin) * o.step, step: o.step, ask, mark: o.mark,
      venueCum: ask ? c.cum.ask[bin]! : c.cum.bid[bin]!, totalCum: ask ? cum.ask[bin]! : cum.bid[bin]!, venueLevel: (ask ? g.ask[c.index] : g.bid[c.index])?.[bin] ?? 0, volume: c.venue.volume, window, full: scale.full, reach });
    paintInfoBox(ctx, lines, hv.x, touch ? hv.y - 18 : hv.y, bounds, p, { placement: touch ? 'up' : 'center' });
  }

  /** Box what is under the pointer and say what it is. */
  #paintCell(ctx: CanvasRenderingContext2D, cell: { lines: InfoLine[]; x: number; y: number; w: number; h: number }, o: { x: number; w: number; head: number }, rows: number): void {
    const hv = this.#hover, p = this.#palette; if (!hv) return;
    ctx.save(); ctx.strokeStyle = p.text; ctx.lineWidth = 1; ctx.globalAlpha = 0.95; ctx.strokeRect(Math.round(cell.x) + 0.5, Math.round(cell.y) + 0.5, Math.max(1, Math.round(cell.w) - 1), Math.max(1, Math.round(cell.h) - 1)); ctx.restore();
    // Beside a mouse pointer the box stands to one side; above a finger, so the hand does not cover it.
    const touch = this.#pinned !== null;
    paintInfoBox(ctx, cell.lines, hv.x, touch ? hv.y - 18 : hv.y, { x0: o.x, y0: o.head, x1: o.x + o.w, y1: o.head + rows * ROW_H }, p, { placement: touch ? 'up' : 'center' });
  }

  /** Mirror hover: highlight the rows from the mark to the hovered row and the same number of rows on the other side, dim the rest, and compare the cumulative liquidity of the two bands. */
  #paintMirror(ctx: CanvasRenderingContext2D, state: AppState, g: Grouped, cum: ReturnType<typeof cumulative>,
    o: { x: number; w: number; title: string; centerBin: number; markBin: number; mark: number; step: number }, head: number, rows: number, cellUnder = false): void {
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
    // Directly over a cell or a block the popup says what that is, and the comparison's own box would only cover it.
    if (!cellUnder) paintMirrorBox(ctx, mirrorLines(stats, { above: t('Asks'), below: t('Bids') }, o.title || undefined), hv.x, hv.y, { x0: o.x, y0: head, x1: o.x + o.w, y1: head + rows * ROW_H }, p,
      c => c === 'above' ? p.ask : c === 'below' ? p.bid : c === 'muted' ? p.muted : p.text, stats.hoveredSide === 'above' ? 'down' : 'up');
  }

  /**
   * Cumulative size: a light area stepping outward from the mark, with a crisp outline in the
   * side's colour along its edge, behind the level bars. It stops where a venue's feed stops reaching (those rows are shaded).
   */
  #paintCumulative(ctx: CanvasRenderingContext2D, g: Grouped, cum: ReturnType<typeof cumulative>,
    o: { head: number; rows: number; centerBin: number; markBin: number; step: number; cover: Cover | null }, barX: number, barW: number, maxCum: number, weight: (bin: number, bidSide: boolean) => number): void {
    const p = this.#palette, { head, rows, centerBin, markBin, step } = o, half = Math.floor(rows / 2);
    const markAsk = (g.totalAsk[markBin] ?? 0) > (g.totalBid[markBin] ?? 0);
    const outline = (up: boolean, startBin: number, color: string, values: Float32Array) => {
      const steps: Array<[number, number, number, number]> = []; // x, edge nearer the mark, edge farther from it, bin
      for (let bin = startBin; up ? bin < g.nBins : bin >= 0; bin += up ? 1 : -1) {
        const r = centerBin + half - g.bin0 - bin;
        if (r < 0 || r >= rows) break;
        const rowLo = (g.bin0 + bin) * step;
        if (o.cover && beyondCover(o.cover, rowLo, step)) break;
        const y = head + r * ROW_H;
        steps.push([barX + Math.min(1, values[bin]! / maxCum) * barW, up ? y + ROW_H : y, up ? y : y + ROW_H, bin]);
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
   * The venue lines' x on every row from the mark outward, as the total's outline steps (bids down, asks up), stopping where that venue's
   * book stops reaching (`x(curve, bin)` is null where the line is not drawn). They share a linear scale of their own, full width being the
   * largest of their running totals on the rows in view (`full`): on the total's scale each venue is a small part of it and they crowded into
   * its first fifth.
   */
  #curveX(g: Grouped, curves: readonly Curve[], o: { rows: number; centerBin: number; markBin: number; step: number }, barX: number, barW: number): CurveScale {
    const half = Math.floor(o.rows / 2), markAsk = (g.totalAsk[o.markBin] ?? 0) > (g.totalBid[o.markBin] ?? 0);
    const askFrom = markAsk ? o.markBin : o.markBin + 1, bidFrom = markAsk ? o.markBin - 1 : o.markBin, top = o.centerBin + half - g.bin0;
    const value = (c: Curve, bin: number): number | null => {
      const r = top - bin;
      if (bin < 0 || bin >= g.nBins || r < 0 || r >= o.rows || (bin < askFrom && bin > bidFrom)) return null;
      const ask = bin >= askFrom;
      // Past the reach on its own side the running total is held (no level of the book lies there, so it is the total at the reach): the
      // line goes on, dashed (`carried`). A row the book does not reach on the mark's side of it (a book starting away from the mark) has none.
      if (c.cover && beyondCover(c.cover, (g.bin0 + bin) * o.step, o.step) && !pastReach(c.cover, (g.bin0 + bin) * o.step, o.step, ask)) return null;
      return ask ? c.cum.ask[bin]! : c.cum.bid[bin]!;
    };
    const carried = (c: Curve, bin: number): boolean => c.cover !== null && pastReach(c.cover, (g.bin0 + bin) * o.step, o.step, bin >= askFrom);
    // On a row's side, the line's own book is in view when the first row it is drawn on there is not a carried one (`#paintCurves` starts it there).
    const capped = (c: Curve, bin: number): boolean => {
      const up = bin >= askFrom, bottom = top - o.rows + 1;
      for (let b = up ? Math.max(askFrom, bottom) : Math.min(bidFrom, top); up ? b <= top : b >= bottom; b += up ? 1 : -1) if (value(c, b) !== null) return !carried(c, b);
      return false;
    };
    // Full width is the largest measured total: a carried row holds the total at its reach, so it never raises it.
    let full = 0;
    for (const c of curves) for (let bin = top - o.rows + 1; bin <= top; bin++) { const v = value(c, bin); if (v !== null && v > full) full = v; }
    full = Math.max(full, 1);
    return { x: (c, bin) => { const v = value(c, bin); return v === null ? null : barX + lineFraction(v, full) * barW; }, carried, capped, full };
  }

  /**
   * The venue lines: each a crisp step outline in its colour; with one under the pointer, that one stronger and the rest faded. Where a line lies over
   * a bar (`ends`: where each row's bar ends) it is a faint trace on the material, under the labels, so the bars stay readable; in the clear it is whole,
   * on the ink, and the line under the pointer is whole everywhere. Where its book stops reaching, a short bar across marks the end; the line under
   * the pointer goes on dashed and fainter at the total it reached (so does one with no book of its own in view on that side, where nothing else of it
   * would show).
   */
  #paintCurves(mat: CanvasRenderingContext2D, ctx: CanvasRenderingContext2D, g: Grouped, curves: readonly Curve[], o: { head: number; rows: number; centerBin: number; markBin: number }, barX: number, scale: CurveScale, hovered: number | null, ends: ArrayLike<number>): void {
    const xAt = scale.x;
    const half = Math.floor(o.rows / 2), top = o.centerBin + half - g.bin0, bottom = top - o.rows + 1;
    const markAsk = (g.totalAsk[o.markBin] ?? 0) > (g.totalBid[o.markBin] ?? 0), askFrom = markAsk ? o.markBin : o.markBin + 1, bidFrom = markAsk ? o.markBin - 1 : o.markBin;
    const yOf = (bin: number): number => o.head + (top - bin) * ROW_H;
    const strokeRuns = (c: CanvasRenderingContext2D, runs: readonly number[][]): void => {
      if (!runs.length) return;
      c.beginPath();
      for (const run of runs) { c.moveTo(run[0]!, run[1]!); for (let i = 2; i < run.length; i += 2) c.lineTo(run[i]!, run[i + 1]!); }
      c.stroke();
    };
    ctx.save(); mat.save(); ctx.lineJoin = 'miter'; mat.lineJoin = 'miter';
    // The hovered line last, so it lies on top.
    const order = curves.map((_, k) => k).sort((a, b) => (a === hovered ? 1 : 0) - (b === hovered ? 1 : 0));
    for (const k of order) {
      const c = curves[k]!;
      const alpha = hovered === null || k === hovered ? 0.95 : 0.22, width = k === hovered ? 2.5 : 1.5;
      ctx.strokeStyle = c.color; ctx.lineWidth = width; ctx.globalAlpha = alpha;
      mat.strokeStyle = c.color; mat.lineWidth = width; mat.globalAlpha = alpha * this.curveOverBars;
      for (const up of [true, false]) {
        const steps: LineStep[] = []; let axis: number | null = null, end: { x: number; y: number; cap: boolean } | null = null;
        for (let bin = up ? Math.max(askFrom, bottom) : Math.min(bidFrom, top); up ? bin <= top : bin >= bottom; bin += up ? 1 : -1) {
          // Rows its book does not reach before the line starts are passed over (a shallow book can begin above or below the mark).
          const x = xAt(c, bin); if (x === null) { if (steps.length) break; continue; }
          const y = yOf(bin), near = up ? y + ROW_H : y, far = up ? y : y + ROW_H;
          // Scrolled past the reach, the view holds only the dashed part (no end mark: the end is off screen).
          if (scale.carried(c, bin)) { end = { x, y: near, cap: steps.length > 0 }; break; }
          // From the axis at the mark; from its own place when the mark is scrolled out of view.
          if (!steps.length && bin === (up ? askFrom : bidFrom)) axis = barX;
          steps.push({ r: top - bin, x, near, far });
        }
        if (steps.length) {
          // Over a bar a trace on the material (under the labels), in the clear the line on the ink; the line under the pointer meets no bar.
          const cut = cutAtBars(steps, axis, k === hovered ? NO_BARS : ends, up ? -1 : 1);
          strokeRuns(mat, cut.over); strokeRuns(ctx, cut.free);
        }
        // Past the reach: the end of the book across the line, always. The total it reached, held, dashed, to the edge of the view, only for the
        // line under the pointer (a dashed line from every shallow venue's cap, over the bars and in no place on the scale, read as unexplained
        // dashes, Karl 2026-10-19), or when the end is off screen and the dashes are all of the line there is.
        if (end) {
          if (end.cap) { ctx.beginPath(); ctx.moveTo(end.x - 4, end.y); ctx.lineTo(end.x + 4, end.y); ctx.lineWidth = width + 0.5; ctx.stroke(); ctx.lineWidth = width; }
          if (k === hovered || !end.cap) {
            ctx.save(); ctx.setLineDash([3, 3]); ctx.lineWidth = Math.max(1, width - 0.5); ctx.globalAlpha = alpha * 0.55;
            ctx.beginPath(); ctx.moveTo(end.x, end.y); ctx.lineTo(end.x, up ? o.head : o.head + o.rows * ROW_H); ctx.stroke();
            ctx.restore(); ctx.lineWidth = width;
          }
        }
      }
    }
    mat.restore(); ctx.restore();
  }

  /** The lines' key in the header row: a stroke of each colour and its venue's mark, as many as fit in `room`. Each entry's span across, for the pointer. */
  #paintCurveKey(ctx: CanvasRenderingContext2D, curves: readonly Curve[], x: number, y: number, room: number, hovered: number | null, dashed = false): { x0: number; x1: number }[] {
    const ENTRY = 30, spans: { x0: number; x1: number }[] = [];
    curves.forEach((c, k) => {
      const x0 = x + k * ENTRY; if (x0 + ENTRY - 4 > x + room) return;
      ctx.globalAlpha = hovered === null || hovered === k ? 1 : 0.35;
      ctx.fillStyle = c.color; ctx.fillRect(x0, y - 1, 11, 2.5);
      drawVenueMark(ctx, c.venue.id, x0 + 19, y, 11);
      spans.push({ x0, x1: x0 + ENTRY - 2 });
    });
    ctx.globalAlpha = 1;
    // While a line runs on past its book, what the dashes mean, after the entries where it fits (the key's popup says it in full).
    if (dashed && spans.length === curves.length) {
      const text = t('dashed: past its book'), x0 = x + spans.length * ENTRY + 4;
      ctx.save(); ctx.font = '9px ui-monospace, SFMono-Regular, Menlo, monospace';
      if (x0 + 16 + ctx.measureText(text).width <= x + room) {
        ctx.strokeStyle = this.#palette.muted; ctx.setLineDash([3, 3]); ctx.lineWidth = 1.5; ctx.beginPath(); ctx.moveTo(x0, y + 0.5); ctx.lineTo(x0 + 12, y + 0.5); ctx.stroke();
        ctx.fillStyle = this.#palette.muted; ctx.textAlign = 'left'; ctx.fillText(text, x0 + 16, y + 0.5);
      }
      ctx.restore();
    }
    return spans;
  }

  /**
   * The pull/stack column while its window fills (nothing to compare until a snapshot one window old exists: 15 s, a minute or five): the
   * column shaded, a bar along its left edge rising with the share of the window held, and "Loading… 42 s" running up the column, centred
   * on the price row (the column is too narrow for the words across).
   */
  #paintPullFilling(ctx: CanvasRenderingContext2D, share: number, waitS: number, x: number, top: number, rows: number, markRow: number): void {
    const p = this.#palette, h = rows * ROW_H; if (!(h > 0)) return;
    ctx.save();
    ctx.globalAlpha = 0.35; ctx.fillStyle = p.line; ctx.fillRect(x + 3, top, PS_W - 6, h);
    ctx.globalAlpha = 0.9; ctx.fillStyle = p.ui; ctx.fillRect(x + 4, top + h * (1 - share), 3, h * share);
    const row = markRow >= 0 && markRow < rows ? markRow : Math.floor(rows / 2), cy = Math.min(Math.max(top + (row + 0.5) * ROW_H, top + 60), top + h - 60);
    ctx.globalAlpha = 1; ctx.fillStyle = p.muted; ctx.font = '10px ui-monospace, SFMono-Regular, Menlo, monospace'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.translate(x + PS_W / 2 + 2, cy); ctx.rotate(-Math.PI / 2);
    ctx.fillText(`${t('Loading…')} ${t('{n} s', { n: waitS })}`, 0, 0);
    ctx.restore();
  }

  /**
   * A slim bar under the header: the cumulative bid and ask liquidity within the visible range, as shares of their sum, so which side
   * is more dominant (and by how much) reads at a glance. The strength of each row below follows the same comparison at its own distance.
   */
  #paintBalance(ctx: CanvasRenderingContext2D, g: Grouped, cum: ReturnType<typeof cumulative>, o: { head: number; balanceH: number; rows: number; centerBin: number; markBin: number }, x0: number, w: number): void {
    const p = this.#palette, top = o.head - o.balanceH + 1, h = o.balanceH - 3;
    // The rows that are on screen: the top row is the highest bin shown. Scrolled away from the mark they are not the rows around it.
    const hiBin = o.centerBin + Math.floor(o.rows / 2) - g.bin0, { bid, ask } = liquidityInView(g, o.markBin, hiBin - o.rows + 1, hiBin);
    const total = bid + ask; if (!(total > 0)) return;
    const share = bid / total, split = x0 + 6 + (w - 12) * share, left = x0 + 6, right = x0 + w - 6, dominantBid = share >= 0.5;
    ctx.globalAlpha = dominantBid ? 0.85 : 0.35; ctx.fillStyle = p.bid; ctx.fillRect(left, top, split - left, h);
    ctx.globalAlpha = dominantBid ? 0.35 : 0.85; ctx.fillStyle = p.ask; ctx.fillRect(split, top, right - split, h);
    ctx.globalAlpha = 1; ctx.fillStyle = p.bg; ctx.fillRect(split - 0.5, top, 1, h);
    ctx.font = '600 10px ui-monospace, SFMono-Regular, Menlo, monospace'; ctx.fillStyle = p.dark ? '#ffffff' : '#14171c';
    ctx.textAlign = 'left'; if (split - left > 70) ctx.fillText(t('bids {pct}%', { pct: Math.round(share * 100) }), left + 5, top + h / 2 + 0.5);
    ctx.textAlign = 'right'; if (right - split > 70) ctx.fillText(t('{pct}% asks', { pct: Math.round((1 - share) * 100) }), right - 5, top + h / 2 + 0.5);
    ctx.font = '11px ui-monospace, SFMono-Regular, Menlo, monospace';
  }

  #drawBook(mat: CanvasRenderingContext2D, ctx: CanvasRenderingContext2D, state: AppState, g: Grouped,
    o: { x: number; w: number; title: string; markId?: string; pullIds: string[]; cells: string[] | null; order: string[] | null; curves?: Curve[] | null; cellW: number; head: number; balanceH: number; cover: Cover | null; totals: boolean; centerBin: number; rows: number; markBin: number; mark: number; step: number }): void {
    const p = this.#palette, { x: x0, w, rows, markBin, step, centerBin } = o;
    const cum = cumulative(g, o.mark);
    const dominance = state.highlight.on ? imbalanceByDistance(g, cum, markBin) : null;
    const weight = (bin: number, bidSide: boolean): number => dominance ? dominanceWeight(dominance[bin]!, bidSide) : 1;
    // `head` is where the rows start; the labels sit above the balance bar, which takes the last `balanceH` of it.
    // The pull/stack column sits after LEVEL USD, so everything right of it moves along by its width.
    const pull = state.pullStack ? this.#pull.view(o.pullIds, step, g.bin0, g.nBins, state.pullStack) : null;
    const priceW = PRICE_W, usdW = USD_W + (pull ? PS_W : 0), cellIds = o.cells, cw = o.cellW, head = o.head - o.balanceH, venueW = cellIds ? cellIds.length * cw + 2 : 0;
    // The gutter for the rows' signed marks sits between the venue columns and the bars, while the cues are on.
    const gut = this.#cues.gutter ? GUT_W : 0, barX = x0 + priceW + usdW + venueW + 8 + gut, barW = Math.max(20, x0 + w - barX - 6);
    if (gut) this.#cues.addGutter(o.markId ?? null, barX - gut, gut);
    ctx.fillStyle = p.muted; ctx.textAlign = 'left';
    if (o.title) {
      const indent = o.markId ? 17 : 0;
      if (o.markId) drawVenueMark(ctx, o.markId, x0 + 6 + 6, head / 2, 12);
      ctx.fillStyle = p.text; ctx.font = '600 11px ui-monospace, SFMono-Regular, Menlo, monospace'; ctx.fillText(o.title, x0 + 6 + indent, head / 2); ctx.font = '11px ui-monospace, SFMono-Regular, Menlo, monospace'; ctx.fillStyle = p.muted;
      // A book scrolled further than one grouping holds draws no running totals: said beside the title where the column has room.
      if (!o.totals && state.ladderShow !== 'levels') {
        const note = t('Recenter for the running totals'), titleW = ctx.measureText(o.title).width + 6 + indent + 12;
        if (titleW + ctx.measureText(note).width <= w - 12) { ctx.textAlign = 'right'; ctx.fillText(note, x0 + w - 6, head / 2); ctx.textAlign = 'left'; }
      }
    }
    else {
      const line = head - HEAD_H / 2;
      ctx.fillText(t('PRICE'), x0 + 6, line); ctx.textAlign = 'right'; ctx.fillText(t('LEVEL USD'), x0 + priceW + USD_W, line);
      if (pull) {
        ctx.fillText(pull.kind === 'filling' ? `Δ ${t('{n} s', { n: pull.waitS })}…` : pull.kind === 'fine' ? 'Δ –' : `Δ ${windowText(state.pullStack)}`, x0 + priceW + usdW, line);
      }
      if (cellIds) {
        ctx.textAlign = 'left';
        // Each venue column is headed by its mark where it is wide enough to hold one; narrower ones (and those under 20 px, above the
        // mark) carry the name running upward, so any number of venues stays readable.
        const marked = cw >= 12, size = Math.min(14, cw - 2);
        if (marked) cellIds.forEach((id, k) => drawVenueMark(ctx, id, x0 + priceW + usdW + 8 + k * cw + (cw - 2) / 2, line, size));
        if (cw < 20) {
          ctx.font = '9px ui-monospace, SFMono-Regular, Menlo, monospace';
          cellIds.forEach((id, k) => { ctx.save(); ctx.translate(x0 + priceW + usdW + 8 + k * cw + cw / 2 + 3, head - 2 - (marked ? size + 4 : 0)); ctx.rotate(-Math.PI / 2); ctx.fillText(venueLabel(id).slice(0, marked ? 4 : 5), 0, 0); ctx.restore(); });
          ctx.font = '11px ui-monospace, SFMono-Regular, Menlo, monospace';
        }
      }
      ctx.textAlign = 'left';
      // Running totals or lines asked for and none drawn: say why rather than leave them out unexplained.
      const linesAsked = state.ladderMode === 'compact' && state.ladderShow !== 'levels' && state.ladderCurves > 0;
      const why = !o.totals && state.ladderShow !== 'levels' ? t('Recenter for the running totals') : linesAsked && !o.curves?.length && this.#curvesLeftOut.length ? t('No book reaches {n} rows at this step', { n: CURVE_MIN_ROWS }) : null;
      if (why) ctx.fillText(why, barX, line);
      else if (!o.curves?.length) ctx.fillText(state.ladderShow === 'levels' ? t('DEPTH') : t('DEPTH + CUM'), barX, line);
    }
    let maxLevel = 1;
    const orderIdx = o.order ? o.order.map(id => g.ids.indexOf(id)) : null;
    const shownHi = Math.min(g.nBins - 1, centerBin + Math.floor(rows / 2) - g.bin0), shownLo = Math.max(0, shownHi - rows + 1);
    // The running totals' full width is the largest on the rows on screen (each still counted from the mark).
    let maxCum = 1;
    for (let i = shownLo; i <= shownHi; i++) { maxLevel = Math.max(maxLevel, g.totalBid[i]!, g.totalAsk[i]!); maxCum = Math.max(maxCum, cum.bid[i]!, cum.ask[i]!); }
    // The largest change the price did not reach, so the numbers fade with their size.
    const pullRows = pull?.kind === 'rows' ? pull.rows : null;
    let maxPull = 1;
    if (pullRows) for (let i = shownLo; i <= shownHi; i++) if (!pullRows.touched[i]) for (const v of [pullRows.bid[i]!, pullRows.ask[i]!]) if (v === v) maxPull = Math.max(maxPull, Math.abs(v));
    // The venue lines' scale, and round values on it as faint gridlines behind the bars (it is not the bars' scale, so it needs its own).
    const curves = o.curves ?? [], scale = curves.length ? this.#curveX(g, curves, o, barX, barW) : null, xAt = scale?.x ?? null;
    // Where each row's bar ends (NaN: none), for the lines to fade over: a faint trace over a bar, whole in the clear.
    const ends = scale ? new Float32Array(rows).fill(Number.NaN) : null;
    // With the lines on they are the running totals and the whole book's area is left out: on their scale it filled the width a few rows
    // from the mark (the total is several times the largest venue: Karl, 2026-10-14), and on a scale of its own a venue's line stood beyond
    // the total it is part of (2026-10-13).
    if (state.ladderShow !== 'levels' && !scale && o.totals) this.#paintCumulative(mat, g, cum, o, barX, barW, maxCum, weight);
    const ticks = scale ? lineTicks(scale.full).map(v => ({ v, x: Math.round(barX + lineFraction(v, scale.full) * barW) + 0.5 })) : [];
    if (ticks.length) {
      // Solid, like the map's own grid: a dash here would be read as the lines' "past its book" dashes (the key says what those mean).
      // Under the bars, so on the material.
      mat.save(); mat.strokeStyle = p.line; mat.globalAlpha = 0.6; mat.lineWidth = 1;
      for (const tick of ticks) { mat.beginPath(); mat.moveTo(tick.x, o.head); mat.lineTo(tick.x, o.head + rows * ROW_H); mat.stroke(); }
      mat.restore();
    }
    if (o.balanceH > 0) this.#paintBalance(ctx, g, cum, o, x0, w);
    // Each venue's part of a row is placed for the cues (where it is, so a cue can light it) and gets its heat strip.
    const cues = this.#cues, heatKind = state.ladderCues.heat, tone = heatKind === 'off' ? '' : heatTone(p), wall = Date.now();
    const share = (h: { fresh: number; activity: number }): number => heatKind === 'added' ? h.fresh : h.activity;
    const place = (id: string, r: number, ask: boolean, cell: Cell, lo: number): void => {
      cues.cells.set(id, r, ask ? 1 : 0, cell.x, cell.y, cell.w, cell.h, cell.usd);
      if (heatKind === 'off') return;
      const h = cues.tracker.heat(id, ask ? 'ask' : 'bid', lo, lo + step, wall);
      if (h) paintStrip(mat, cell, share(h), tone);
    };
    for (let r = 0; r < rows; r++) {
      const bin = centerBin + Math.floor(rows / 2) - r - g.bin0;
      if (bin < 0 || bin >= g.nBins) continue;
      const y = o.head + r * ROW_H, mid = y + ROW_H / 2;
      const rowLo = (g.bin0 + bin) * step;
      if (o.cover && beyondCover(o.cover, rowLo, step)) {
        // Beyond what this venue's feed reaches: shade the row instead of showing a misleading empty book.
        mat.globalAlpha = 0.5; mat.fillStyle = p.line; mat.fillRect(x0, y, w, ROW_H); mat.globalAlpha = 1;
        ctx.fillStyle = p.muted; ctx.textAlign = 'left'; ctx.fillText(fmtPrice(rowLo, step), x0 + 6, mid);
        continue;
      }
      const bid = g.totalBid[bin]!, ask = g.totalAsk[bin]!, isAsk = bin > markBin || (bin === markBin && ask > bid);
      const value = isAsk ? ask : bid, color = isAsk ? p.ask : p.bid, f = weight(bin, !isAsk);
      if (ends && value > 0 && state.ladderShow !== 'cumulative') ends[r] = barX + Math.max(1, value / maxLevel * barW);
      if (bin === markBin) { mat.fillStyle = p.line; mat.fillRect(x0, y, w, ROW_H); }
      ctx.fillStyle = p.muted; ctx.textAlign = 'left'; ctx.fillText(fmtPrice((g.bin0 + bin) * step, step), x0 + 6, mid);
      ctx.fillStyle = value > 0 ? p.text : p.muted; ctx.textAlign = 'right'; ctx.fillText(value > 0 ? usd(value) : '', x0 + priceW + USD_W, mid);
      if (pullRows) {
        const change = isAsk ? pullRows.ask[bin]! : pullRows.bid[bin]!, touched = pullRows.touched[bin] === 1;
        if (change === change && Math.abs(change) >= 1) {
          ctx.fillStyle = touched ? p.muted : color; ctx.globalAlpha = touched ? 0.85 : Math.min(1, 0.45 + 0.55 * Math.sqrt(Math.abs(change) / maxPull));
          ctx.fillText(signedUsd(change), x0 + priceW + usdW, mid); ctx.globalAlpha = 1;
        }
      }
      if (cellIds) cellIds.forEach((id, k) => {
        const vv = (isAsk ? g.ask[k] : g.bid[k])?.[bin] ?? 0;
        if (vv > 0) {
          const cx = x0 + priceW + usdW + 8 + k * cw, cwid = Math.max(2, cw - 2);
          mat.globalAlpha = Math.min(1, (0.18 + 0.82 * Math.sqrt(vv / maxLevel)) * f); mat.fillStyle = color; mat.fillRect(cx, y + 3, cwid, ROW_H - 6); mat.globalAlpha = 1;
          place(id, r, isAsk, { x: cx, y: y + 3, w: cwid, h: ROW_H - 6, usd: vv }, rowLo);
        }
      });
      if (state.ladderShow !== 'cumulative' && value > 0) {
        if (orderIdx && o.order) {
          const pieces = barPieces(o.order, orderIdx.map(i => (isAsk ? g.ask[i] : g.bid[i])?.[bin] ?? 0), maxLevel, barX, barW, PIECE_MIN_PX);
          this.#paintPieces(mat, ctx, pieces, y, color, f);
          for (const piece of pieces) {
            const rect: Cell = { x: piece.x, y: y + 2, w: Math.max(1, piece.w - (piece.w >= 3 ? 1 : 0)), h: ROW_H - 4, usd: piece.usd };
            if (piece.id) { place(piece.id, r, isAsk, rect, rowLo); continue; }
            // The smaller venues' piece is one block of material that none of them owns: a change of one of them lights nothing there (it leaves its
            // mark and its hover), and the piece's strip is theirs added up (by size).
            let fresh = 0, total = 0;
            for (const m of piece.merged) {
              const h = heatKind === 'off' ? null : cues.tracker.heat(m.id, isAsk ? 'ask' : 'bid', rowLo, rowLo + step, wall);
              if (h) fresh += share(h) * m.usd;
              total += m.usd;
            }
            if (heatKind !== 'off' && total > 0) paintStrip(mat, rect, fresh / total, tone);
          }
        } else if (cellIds) {
          let x = barX;
          cellIds.forEach((_, k) => {
            const vv = (isAsk ? g.ask[k] : g.bid[k])?.[bin] ?? 0; if (vv <= 0) return;
            const seg = vv / maxLevel * barW; mat.globalAlpha = Math.min(1, (0.35 + 0.5 * (VENUE_TINT[k % VENUE_TINT.length] ?? 1)) * f); mat.fillStyle = color; mat.fillRect(x, y + 2, Math.max(1, seg - 0.5), ROW_H - 4); x += seg;
          });
          mat.globalAlpha = 1;
        } else {
          const len = Math.max(1, value / maxLevel * barW);
          mat.globalAlpha = Math.min(1, 0.75 * f); mat.fillStyle = color; mat.fillRect(barX, y + 2, len, ROW_H - 4); mat.globalAlpha = 1;
          place(o.markId ?? o.pullIds[0] ?? '', r, isAsk, { x: barX, y: y + 2, w: len, h: ROW_H - 4, usd: value }, rowLo);
        }
      }
      // The price row's line in the colour of the map's price line (the candle under way rising or falling).
      if (bin === markBin) { const side = lineSide(state.candles, state.seriesInstrument, state.marketId); ctx.fillStyle = side === 'up' ? p.candleUp : side === 'down' ? p.candleDown : p.ask; ctx.fillRect(x0, y + ROW_H - 1, w, 1); }
    }
    // The venue lines over the bars, and which one the pointer is on: near a line across its row, or on its entry in the key.
    const hv = this.#hover, keyLine = head - HEAD_H / 2, maxShown = o.title || barW >= 170;
    let curveHit: { k: number; bin: number | null } | null = null;
    // A line runs on past its book in view when its first or last row on its own side is carried; its dashes show for the line under the
    // pointer, and for a line with none of its own book in view on that side (`capped`), where they are all of it there is.
    const shownTop = centerBin + Math.floor(rows / 2) - g.bin0, shownEnds = [shownTop, shownTop - rows + 1];
    const runsPast = (c: Curve): boolean => scale !== null && shownEnds.some(bin => scale.carried(c, bin));
    const dashesAlone = scale !== null && curves.some(c => shownEnds.some(bin => scale.carried(c, bin) && !scale.capped(c, bin)));
    const keySpans = curves.length && !o.title ? this.#paintCurveKey(ctx, curves, barX, keyLine, barW - (maxShown ? 96 : 0), null, dashesAlone) : [];
    if (xAt && hv && !this.#drag) {
      if (hv.y >= head - HEAD_H && hv.y < head) { const k = keySpans.findIndex(s => hv.x >= s.x0 && hv.x < s.x1); if (k >= 0) curveHit = { k, bin: null }; }
      else if (hv.y >= o.head && hv.y < o.head + rows * ROW_H && hv.x >= barX - CURVE_HIT_PX && hv.x <= barX + barW + CURVE_HIT_PX) {
        const bin = centerBin + Math.floor(rows / 2) - Math.floor((hv.y - o.head) / ROW_H) - g.bin0;
        // A dash that is not drawn is not there to point at: a carried row answers only for the line already under the pointer, or one drawn dashed alone.
        const k = nearestCurve(curves.map((c, j) => scale!.carried(c, bin) && scale!.capped(c, bin) && j !== this.#heldCurve ? null : xAt(c, bin)), hv.x);
        if (k !== null) curveHit = { k, bin };
      }
    }
    this.hoveredCurve = curveHit?.k ?? null;
    if (xAt) {
      this.#paintCurves(mat, ctx, g, curves, o, barX, scale!, this.hoveredCurve, ends!);
      // The gridlines' values on the bottom row, each on a patch of the background so the bars under it do not hide it.
      ctx.save(); ctx.font = '9px ui-monospace, SFMono-Regular, Menlo, monospace'; ctx.textAlign = 'center';
      const ly = o.head + rows * ROW_H - ROW_H / 2;
      // A label that would overlap the one before it (a narrow column) is left out; its gridline stays.
      let right = -Infinity;
      for (const tick of ticks) { const text = `$${usd(tick.v)}`, tw = ctx.measureText(text).width + 6; if (tick.x - tw / 2 < right + 2) continue; right = tick.x + tw / 2; ctx.globalAlpha = 0.85; ctx.fillStyle = p.bg; ctx.fillRect(tick.x - tw / 2, ly - 6, tw, 12); ctx.globalAlpha = 1; ctx.fillStyle = p.muted; ctx.fillText(text, tick.x, ly + 0.5); }
      ctx.restore();
      // The key again over the faded lines' entries, so the one under the pointer stands out there too.
      if (this.hoveredCurve !== null && keySpans.length) { ctx.fillStyle = p.bg; ctx.fillRect(barX, keyLine - 7, keySpans[keySpans.length - 1]!.x1 - barX, 14); this.#paintCurveKey(ctx, curves, barX, keyLine, barW - (maxShown ? 96 : 0), this.hoveredCurve, dashesAlone || runsPast(curves[this.hoveredCurve]!)); }
    }
    if (pull?.kind === 'filling') this.#paintPullFilling(ctx, pull.share, pull.waitS, x0 + priceW + USD_W, o.head, rows, centerBin + Math.floor(rows / 2) - g.bin0 - markBin);
    const cell = curveHit ? null : this.#cellUnder(state, g, cum, o, { priceW, usdW, cw, barX, barW, maxLevel, pull: pullRows, gut });
    // On a venue line the Mirror comparison is left out: its dimming would wash out the lines being looked at.
    if (!curveHit) this.#paintMirror(ctx, state, g, cum, o, o.head, rows, cell !== null);
    if (cell) this.#paintCell(ctx, cell, o, rows);
    if (curveHit && hv && scale) this.#paintCurveInfo(ctx, state, g, cum, curves[curveHit.k]!, curveHit.bin, scale, o, rows);
    // The scale label shares the header row with the DEPTH label (or the lines' key), so it only appears when the bar column is wide enough for both.
    if (maxShown) { ctx.fillStyle = p.muted; ctx.textAlign = 'right'; ctx.fillText(t('MAX {value}', { value: usd(maxLevel) }), x0 + w - 6, keyLine); }
  }
}
