import { el } from '../dom.ts';
import { t } from '../i18n.ts';
import { clockSeconds, price as fmtPrice, usd as fmtUsd } from '../format.ts';
import { drawVenueMark, marksEpoch } from '../venue-marks.ts';
import { venueLabel } from '../venues.ts';
import { instrumentShown, mapVenues } from '../cvd/ids.ts';
import { setText } from './lower-panes.ts';
import { scaledUsd } from '../coin.ts';
import { replaying } from '../replay/clock.ts';
import { isPhone } from '../device.ts';
import { paintInfoBox, type InfoLine } from '../infobox.ts';
import { PALETTES, type Palette } from '../theme.ts';
import { pixelRatio, sharpens } from '../pixel-ratio.ts';
import { BOUNDARY, type TapeRing } from '../tape/ring.ts';
import { TradeIndex, readRecord, type TradeRecord } from '../trades/index.ts';
import { RetainedRows } from './retained-rows.ts';
import { DIVIDER_ROW, InkCache, ORDER_TINT, ROW_GAP, ROW_MARK, ROW_PAD, TIERS, amountText, clockForm, orderBarFull, priceWidth, rowGeom, tierOf, type RowFontWidths, type RowGeom, type Tier } from '../trades/style.ts';
import { GROUP_MS } from '../trades/settings.ts';
import { Conveyor } from '../trades/conveyor.ts';
import type { TnsLine } from '../tns/model.ts';
import type { Store } from '../store.ts';

const MONO = 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace';
const PAD = ROW_PAD, GAP = ROW_GAP, MARK = ROW_MARK;
/** Rows found beyond the visible ones (so a wheel step or a held list has them ready). */
const OVERSCAN = 40;
/** A list out of sight longer than this (in writes) is found again from the newest rather than caught up order by order. */
const CATCH_UP_MAX = 50_000;
/**
 * The share of the side's colour the ink cache's steps run up to (TINT_STEPS of them, per kind of theme): the rows' one tint, ORDER_TINT, is
 * drawn at the nearest step. (Until 2026-11-14 the top of a size tint, at the Leviathan size.)
 */
export const TINT_TOP_DARK = 0.42, TINT_TOP_LIGHT = 0.34;
const reducedMotion = (): boolean => typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;

/** The widths the rows are laid out by (`rowGeom`), at the pixel ratio they were measured at. */
interface FontWidths extends RowFontWidths { dpr: number }
/** What an order row shows (one order, or the orders a row groups): its time, price, signed dollars, market and how many orders. */
interface RowOrder { t: number; price: number; usd: number; id: string; orders: number }
/** A row of a frame (device pixels), laid out before anything is drawn: its signature and what draws it. */
interface Item { sig: string; y: number; h: number; fixed: boolean; kind: 'row' | 'divider' | 'note'; rec: TradeRecord | null; shown: TradeRecord | null; tier: (typeof TIERS)[number]; orders: number; usd: number; timeY: number; outlined: boolean; reasons: number; words: string }
/** A line the last frame drew: an order (or a burst of them when grouping is on), or a divider where orders may be missing. */
type Drawn =
  | { kind: 'row'; k: number; y: number; h: number; rec: TradeRecord; orders: number; usd: number }
  | { kind: 'divider'; y: number; h: number; reasons: number };

/**
 * Trades' "Each order" unit (the flow column's second view; until 2026-11-13 the view All trades): every market order the page receives
 * (the tape ring's), newest on top, on one canvas. Size is carried by row height, the amount's type and a bar after the price, the square
 * root of its dollars (`trades/style.ts`); every row says its side with ▲/▼ and a faint tint of its colour. New rows come down from the top on
 * every frame (`trades/conveyor.ts`: the batches arrive four times a second, the list moves sixty). The list holds still under a mouse or
 * once scrolled back (a key counts what arrived meanwhile, the rows not yet down included), a row pointed at sets the shared time cursor and
 * a click takes the map there. Forward only: the orders are the ring's, from when it started, never fetched. `panes/trades-view.ts` is the
 * shell around it (the menus, the status).
 */
export class OrderList {
  readonly root = el('div', { class: 'trades-wrap trades-orders' });
  #canvas = el('canvas', { class: 'trades-canvas', ariaLabel: t('Trades') });
  #ctx: CanvasRenderingContext2D;
  #pill = el('button', { type: 'button', class: 'trades-resume', hidden: true });
  #index = new TradeIndex();
  #inks = new InkCache();
  #palette: Palette = PALETTES.light!;
  #shown = false; #frame = 0;
  #w = 0; #h = 0; #dpr = 1;
  /** null: the list follows the newest order; else the row of write `k` is drawn `offset` px above the top (held, or scrolled back). */
  #anchor: { k: number; offset: number } | null = null;
  #pointerIn = false; #pointer: { x: number; y: number } | null = null;
  /**
   * A finger on the list: where it last was, whether it moved (a drag scrolls, a still tap pins a row), whether it took the hold as it touched
   * (a cancelled touch gives it back), and the row a tap pinned.
   */
  #touch: { id: number; y: number; moved: number; owed: number; took: boolean } | null = null;
  #pinned: number | null = null;
  /** The wheel moved the list back from the newest order: it stays held when the pointer leaves. */
  #scrolled = false;
  /** What the batches added above the newest row drawn, played out a little on every frame while the list follows the newest. */
  #conveyor = new Conveyor();
  #drawn: Drawn[] = [];
  /** The rows kept on the canvas between frames, this frame's rows, and a count bumped by any change the look key cannot see. */
  readonly rows = new RetainedRows();
  #items: Item[] = []; #itemPool: Item[] = [];
  #epoch = 0;
  /** The bar's full dollars as the last frame drew it (the box beside a row says it). */
  #barFull = 0;
  /**
   * The font widths, measured once per pixel ratio (the list's fonts are the system's monospace: no font loads later to change them), and
   * the rows' parts with what they were worked out for: a frame measures and formats nothing for them until the width, the ratio, grouping,
   * the size floor or the price's width changes (on a 4x-slowed phone that work was 0.24 ms of a frame).
   */
  #fontWidths: FontWidths | null = null;
  #geomKey = ''; #geomLast: RowGeom | null = null;
  /** The widest price of the recording's rows (characters) and the rows it was counted for (the shell sets a new list when they change). */
  #historyCharsOf: TnsLine[] | null = null; #historyCharsN = 0;
  /** The one row description the painter is handed, filled for each row (no object made for every row drawn). */
  #order: RowOrder = { t: 0, price: 0, usd: 0, id: '', orders: 1 };
  /** Prices as written, by value (a moving list draws a row or two a frame, mostly at prices it wrote moments before). */
  #prices = new Map<number, string>();
  #scanTimer = 0;
  /** What the index was found for: the list's settings and the venues the map shows (a venue's book joining the map lets its orders in). */
  #filterKey = '';
  #resizeObserver: ResizeObserver;
  /** The last press was a finger (its click is the tap's, not a mouse click that takes the map to the order). */
  #lastTouch = false;
  /** The tape ring (set by the page: it exists once a view has asked for the tape). */
  ring: () => TapeRing | null = () => null;
  /** Take the map to an order (set by the shell). */
  onGoTo: (at: number, price: number) => void = () => {};
  /** Since when the list holds every order, as the status says it (set as each frame is drawn). */
  since = '';
  onSince: () => void = () => {};
  /** The recording's orders before the tape (from $25K: Time & sales' hour), newest first with its holes, and the line above them (set by the shell). */
  history: TnsLine[] = [];
  historyNote = '';

  constructor(private store: Store) {
    this.root.append(this.#canvas, this.#pill);
    this.#ctx = this.#canvas.getContext('2d', { alpha: false })!;
    this.#pill.onclick = () => { this.#pointerIn = false; this.#release(); };
    this.#resizeObserver = new ResizeObserver(() => this.#resize()); this.#resizeObserver.observe(this.root);
    sharpens({ resize: () => this.#resize(), paint: () => { if (this.#shown) this.#paint(); } });
    const c = this.#canvas;
    // A canvas given back by the browser (its graphics memory was taken back, as phones do) comes back empty: nothing kept on it holds.
    c.addEventListener('contextrestored', () => { this.rows.reset(); this.invalidate(); });
    document.addEventListener('visibilitychange', this.#onVisible);
    c.addEventListener('pointermove', e => {
      if (e.pointerType === 'touch') return;
      // A mouse is in use again (a hybrid device): its box offers the click once more.
      this.#lastTouch = false;
      this.#pointer = { x: e.offsetX, y: e.offsetY };
      // Held as soon as there is something to hold (the pointer may have come in before the first rows).
      this.#pointerIn = true; if (!this.#anchor) this.#hold();
      this.#hoverChanged(); this.invalidate();
    });
    // A finger "leaves" as it lifts: the hold and the pinned row end with the tap that lets the row go, or the pill, not with the lift.
    c.addEventListener('pointerleave', e => { if (e.pointerType === 'touch') return; this.#pointerIn = false; this.#pointer = null; this.#hoverChanged(); if (!this.#scrolled) this.#release(); this.invalidate(); });
    // Ctrl + wheel is the browser's zoom, not the list's.
    c.addEventListener('wheel', e => { if (e.ctrlKey) return; e.preventDefault(); this.#scroll(e.deltaY * (e.deltaMode === 1 ? 24 : e.deltaMode === 2 ? this.#h : 1)); this.#hoverChanged(); }, { passive: false });
    c.addEventListener('click', e => { if (this.#lastTouch) return; const row = this.#rowAt(e.offsetY); if (row && !replaying() && !isPhone()) this.onGoTo(row.rec.t, row.rec.price); });
    // A finger holds the list as it touches (rows come down on every frame: the row under it at the lift would be another), drags it, and a tap
    // without a drag pins the row it touched (a second tap on it, or elsewhere, lets it go).
    c.addEventListener('pointerdown', e => {
      this.#lastTouch = e.pointerType === 'touch';
      if (e.pointerType !== 'touch') return;
      let took = false;
      if (!this.#anchor) { this.#hold(); took = !!this.#anchor; }
      this.#touch = { id: e.pointerId, y: e.clientY, moved: 0, owed: 0, took }; c.setPointerCapture(e.pointerId);
    });
    c.addEventListener('pointermove', e => {
      const tch = this.#touch;
      if (!tch || e.pointerId !== tch.id) return;
      const dy = tch.y - e.clientY; tch.y = e.clientY; tch.moved += Math.abs(dy); tch.owed += dy;
      // A still finger is a tap; once it has moved past the slop, the list takes the whole way it moved (it keeps up with the finger).
      if (tch.moved > 6) { this.#pinned = null; this.#scroll(tch.owed); tch.owed = 0; }
    });
    const lift = (e: PointerEvent): void => {
      const tch = this.#touch;
      if (!tch || e.pointerId !== tch.id) return;
      this.#touch = null;
      if (tch.moved > 6) return;
      const row = this.#rowAt(e.offsetY);
      this.#pinned = row && row.k !== this.#pinned ? row.k : null;
      if (this.#pinned !== null) { if (!this.#anchor) this.#hold(); }
      // The row let go (a second tap on it, or elsewhere): the list follows the newest again, unless it is scrolled back.
      else if (!this.#scrolled) { this.#release(); return; }
      this.invalidate();
    };
    c.addEventListener('pointerup', lift);
    // A touch the browser took over (a scroll of the page, a gesture): the hold it took is given back, unless a row is pinned or the list scrolled.
    c.addEventListener('pointercancel', e => {
      const tch = this.#touch;
      if (tch?.id !== e.pointerId) return;
      this.#touch = null;
      if (tch.took && this.#pinned === null && !this.#scrolled) this.#release();
    });
  }

  dispose(): void { window.clearTimeout(this.#scanTimer); this.#resizeObserver.disconnect(); document.removeEventListener('visibilitychange', this.#onVisible); if (this.#frame) cancelAnimationFrame(this.#frame); }
  /** A page shown again draws the list whole (a browser may have let a hidden page's canvas go); a hidden one stops where it stands. */
  #onVisible = (): void => { if (document.visibilityState === 'visible') { this.rows.reset(); this.invalidate(); } else this.#conveyor.reset(); };

  setShown(shown: boolean): void {
    if (shown === this.#shown) return;
    this.#shown = shown;
    if (!shown) { window.clearTimeout(this.#scanTimer); this.#pointerIn = false; this.#pointer = null; this.#hoverChanged(); this.#release(false); this.#conveyor.reset(); this.#drawn = []; return; }
    // Shown again: drawn whole (hidden, the canvas was made 1 px and back, which empties it while the look stays the same).
    this.rows.reset();
    this.#sync();
    this.#resize();
  }
  setPalette(p: Palette): void { this.#palette = p; this.#epoch++; this.invalidate(); }
  /** The list's settings, the venues or the sizes changed: found again from the newest order, from the top. */
  refresh(): void { this.#release(false); this.#conveyor.reset(); this.#drawn = []; this.#index.reset(null); this.#filterKey = ''; if (this.#shown) this.#sync(); }
  /** Something the rows are drawn with changed (the whale size, the time zone, a replay): drawn again as they stand. */
  redraw(): void { this.#epoch++; this.invalidate(); }

  /**
   * A batch reached the ring: a list following the newest takes it above the top, to come down on the next frames as far as the batch added
   * (`#conveyor`; at once with reduced motion or on a hidden page), and a held one counts it.
   */
  tapeArrived(): void {
    if (!this.#shown) return;
    const ring = this.ring();
    if (!ring) return;
    if (this.#index.ring !== ring || this.#index.behind > CATCH_UP_MAX || this.#filterKeyNow() !== this.#filterKey) { this.#sync(); return; }
    // Where the newest row ends before the batch: its first orders can join that row (grouping), and what the batch adds above that edge,
    // the row grown taller included, is how far the list comes down.
    const before = this.#index.length, ref = before ? this.#index.at(before - 1) : -1, follows = !this.#anchor && ref >= 0 && this.#glides();
    const edge = follows ? this.#edgeOf(ref, true) : 0;
    const added = this.#index.update();
    if (this.#index.length === 0 && before === 0) { this.invalidate(); return; }
    if (this.#anchor) { this.#showHeld(); this.invalidate(); return; }
    // The walk stops at the list's height past the old edge: more is jumped anyway (a burst of thousands of orders walks no further).
    if (!follows || !this.#index.valid(ref)) this.#conveyor.reset();
    else if (added > 0) { const cap = this.#cap(); this.#conveyor.add(this.#edgeOf(ref, true, edge + cap) - edge, cap); }
    this.invalidate();
  }

  invalidate(): void { if (!this.#frame && this.#shown) this.#frame = requestAnimationFrame(now => { this.#frame = 0; this.#paint(now); }); }
  /** Whether new rows come down rather than appear: not with reduced motion asked for, nor on a hidden page (no frames to move them in). */
  #glides(): boolean { return !reducedMotion() && !document.hidden; }
  /** The most the list holds above its top to bring down (CSS px): its height; a burst taller than that is jumped. */
  #cap(): number { return Math.max(DIVIDER_ROW, this.#h); }
  /** The key at the foot of a held list: how many orders came since it was held (the rows that had not come down yet among them). */
  #showHeld(): void { this.#pill.hidden = this.#index.newSinceHold === 0; setText(this.#pill, t('Held · {n} new ↑', { n: String(this.#index.newSinceHold) })); }

  /** What the last frame drew, for the checks that look at the list without reading its pixels. */
  get snapshot(): { rows: number; dividers: number; held: boolean; waiting: number; indexed: number; anchored: boolean; debt: number; pinned: number | null } {
    return { rows: this.#drawn.filter(d => d.kind === 'row').length, dividers: this.#drawn.filter(d => d.kind === 'divider').length, held: this.#index.held, waiting: this.#index.newSinceHold, indexed: this.#index.length, anchored: !!this.#anchor, debt: this.#conveyor.debt, pinned: this.#pinned };
  }
  /** The write number of the row the last frame drew at `y` (CSS px down the list), or null: for the checks that aim at a row. */
  rowAt(y: number): number | null { return this.#rowAt(y)?.k ?? null; }
  /** How far the conveyor has moved the list in all (CSS px; of a batch taller than the list, its height): a trace for the checks that time its motion. */
  get motionY(): number { return this.#conveyor.travelled; }

  /** The index on the current ring and filter, found back from the newest order enough to fill the list (more in steps, between frames). */
  #sync(): void {
    const ring = this.ring(), s = this.store.state.trades, key = this.#filterKeyNow();
    // Another ring or venues, nothing found yet, a newest write the ring wrapped past, or out of sight so long that finding back is cheaper than catching up.
    if (this.#index.ring !== ring || key !== this.#filterKey || this.#index.length === 0 || (ring && !this.#index.valid(this.#index.newest)) || this.#index.behind > CATCH_UP_MAX) {
      this.#filterKey = key;
      // Found again from the newest: a hold, a pinned row and a count of what came meanwhile belonged to the rows it had.
      this.#release(false); this.#drawn = [];
      this.#index.reset(ring, { minUsd: s.minUsd === 0 ? 0 : scaledUsd(s.minUsd), side: s.side, shown: instrumentShown(this.store.state) });
      this.#anchor = null; this.#conveyor.reset();
    }
    this.#index.update();
    this.#fillBack();
    this.invalidate();
  }
  /** The venues the list lets in (the bubbles' rule: a venue's chip on, its book on the map or there moments ago), as a key to compare. */
  #filterKeyNow(): string {
    const s = this.store.state, venues = mapVenues(s);
    return `${venues ? [...venues].sort().join(',') : '*'}|${[...s.disabledVenues].sort().join(',')}`;
  }
  /**
   * Find older matches until the list and its overscan are full, a step per task so a high floor never blocks a frame. The count is of
   * orders, and grouping puts a burst of them in one row: a frame whose rows ran out above the list's foot asks for `more` beyond what is
   * found (until 2026-11-14 a burst of more orders than the count stopped the list at one row with nothing under it).
   */
  #fillBack(more = 0): void {
    window.clearTimeout(this.#scanTimer);
    // Enough found below the top row drawn: the visible rows at the smallest height, and some more.
    const have = (): number => (this.#anchor ? this.#index.position(this.#anchor.k) : this.#index.length - 1) + 1;
    const want = Math.max(Math.ceil(this.#h / TIERS[0]!.row) + OVERSCAN, more > 0 ? have() + more : 0);
    if (have() >= want || !this.#index.moreBehind) return;
    this.#index.scanBack(want - have());
    this.invalidate();
    if (have() < want && this.#index.moreBehind) this.#scanTimer = window.setTimeout(() => this.#fillBack(want - have()), 0);
  }

  #resize(): void {
    const r = this.root.getBoundingClientRect(), dpr = pixelRatio();
    const w = Math.max(0, Math.floor(r.width)), h = Math.max(0, Math.floor(r.height));
    if (w === this.#w && h === this.#h && dpr === this.#dpr) { this.invalidate(); return; }
    this.#w = w; this.#h = h; this.#dpr = dpr;
    this.#canvas.width = Math.max(1, Math.round(w * dpr)); this.#canvas.height = Math.max(1, Math.round(h * dpr));
    // A canvas given a size is emptied: nothing kept on it holds, even at a size the look knows (hidden to 1 px and back).
    this.rows.reset();
    this.#canvas.style.width = `${w}px`; this.#canvas.style.height = `${h}px`;
    if (this.#shown) this.#fillBack();
    this.invalidate();
  }

  #whale(): { whale: number; leviathan: number } {
    const tiers = this.store.state.sounds.tiers;
    return { whale: scaledUsd(tiers.find(x => x.id === 'whale')?.usd ?? 400_000), leviathan: scaledUsd(tiers.find(x => x.id === 'leviathan')?.usd ?? 1_500_000) };
  }
  /**
   * An order's row height as it is drawn (its tier's height rounded to device pixels): the scroll and the slide walk what is drawn, so a row
   * passing the top moves nothing else (walked at nominal heights, every row passing it would jog the list up to a device pixel).
   */
  #heightOf(rec: TradeRecord): number { const d = this.#dpr || 1; return Math.round(TIERS[tierOf(rec.usd, scaledUsd, this.#whale().whale)]!.row * d) / d; }
  /** Whether the orders at index positions `a` and `b` are one row (grouping on: one market, one side, one slice of GROUP_MS). */
  #together(a: TradeRecord, b: TradeRecord): boolean {
    return a.id === b.id && Math.sign(a.usd) === Math.sign(b.usd) && Math.floor(a.t / GROUP_MS) === Math.floor(b.t / GROUP_MS);
  }
  /** The row whose newest order is at `pos`: how many orders it holds (going older) and its height (from their summed size). */
  #unit(pos: number): { count: number; h: number } {
    const ring = this.#index.ring!, head = readRecord(ring, this.#index.at(pos));
    if (!this.store.state.trades.group) return { count: 1, h: this.#heightOf(head) };
    let count = 1, usd = Math.abs(head.usd);
    while (pos - count >= 0) { const o = readRecord(ring, this.#index.at(pos - count)); if (!this.#together(head, o)) break; usd += Math.abs(o.usd); count++; }
    return { count, h: this.#heightOf({ ...head, usd: head.usd > 0 ? usd : -usd }) };
  }
  /** The height of the line drawn under the row at `pos` (`count` orders) where orders may be missing before the next older row; 0 when none. */
  #lineUnder(pos: number, count: number): number {
    if (pos - count < 0 || !this.#index.boundariesBetween(this.#index.at(pos - count), this.#index.at(pos - count + 1))) return 0;
    const d = this.#dpr || 1;
    return Math.round(DIVIDER_ROW * d) / d;
  }
  /**
   * How far below the newest row's top the row holding write `k` begins (or, with `bottom`, ends): rows at their drawn heights and the lines
   * between them, walked from the newest, at most `limit`.
   */
  #edgeOf(k: number, bottom: boolean, limit = Infinity): number {
    const target = this.#index.position(k);
    let pos = this.#unitTop(this.#index.length - 1), y = 0;
    while (pos >= 0 && y < limit) {
      const u = this.#unit(pos);
      if (pos - u.count < target) return Math.min(limit, bottom ? y + u.h : y);
      y += u.h + this.#lineUnder(pos, u.count);
      pos -= u.count;
    }
    return Math.min(limit, y);
  }
  /** The newest position of the row holding `pos` (grouping gathers newer orders of the same slice above it). */
  #unitTop(pos: number): number {
    if (!this.store.state.trades.group) return pos;
    const ring = this.#index.ring!, rec = readRecord(ring, this.#index.at(pos));
    while (pos + 1 < this.#index.length && this.#together(rec, readRecord(ring, this.#index.at(pos + 1)))) pos++;
    return pos;
  }

  #hold(): void {
    if (this.#anchor || !this.#index.length) return;
    // Held where it stands: the row at the top (as the last frame drew it) stays there while new orders are counted, and so do the rows
    // above it that had not come down yet (the key counts them with what comes).
    const top = this.#drawn.find(d => d.kind === 'row');
    if (!top || top.kind !== 'row') return;
    this.#conveyor.reset();
    // A row under a line at the top (rows were coming down) is held at the top, the line dropped: a held list draws no line above the row it
    // starts from, and the strip would stay blank for the whole hold (a nudge of a line's height at most, rare: a line is at the top for a frame or two).
    this.#anchor = { k: top.k, offset: Math.max(0, -top.y) };
    this.#index.hold(top.k + 1);
    this.#showHeld();
  }
  /**
   * Let go: the list follows the newest again, coming down to it from where it stands (as far as the list is tall; further is jumped).
   * `draw` false: the list is being found again or hidden, and stands at the newest at once.
   */
  #release(draw = true): void {
    if (!this.#anchor && !this.#index.held) return;
    const a = this.#anchor, cap = this.#cap();
    const from = draw && a && this.#glides() && this.#index.valid(a.k) ? this.#edgeOf(a.k, false, cap) + a.offset : 0;
    this.#anchor = null; this.#index.release(); this.#pill.hidden = true; this.#scrolled = false; this.#pinned = null;
    if (from > 0) this.#conveyor.from(from, cap); else this.#conveyor.reset();
    if (draw) this.invalidate();
  }
  /** The wheel moves the held top row by `dy` px (down: older orders); back at the newest with no mouse on it, the list follows again. */
  #scroll(dy: number): void {
    if (!this.#index.length) return;
    if (!this.#anchor) { this.#hold(); if (!this.#anchor) return; }
    // Row by row (a grouped row is one step, with the line under it where orders may be missing, as the list draws it: the anchor's row draws
    // no line above it); the offset keeps its fractions (a trackpad's small steps add up) and is rounded where it is drawn.
    let pos = this.#unitTop(this.#index.position(this.#anchor.k)), offset = this.#anchor.offset + dy;
    for (let u = this.#unit(pos), step = u.h + this.#lineUnder(pos, u.count); offset >= step && pos - u.count >= 0; u = this.#unit(pos), step = u.h + this.#lineUnder(pos, u.count)) { offset -= step; pos -= u.count; }
    while (offset < 0 && pos < this.#index.length - 1) { pos = this.#unitTop(pos + 1); const u = this.#unit(pos); offset += u.h + this.#lineUnder(pos, u.count); }
    // The oldest row found, with nothing older to find: it stays at the top rather than scrolling off into nothing.
    // Nothing older on the tape: the list scrolls on through the recording's rows below it (from $25K), then stops.
    if (!this.#index.moreBehind && pos - this.#unit(pos).count < 0) offset = Math.min(offset, this.#historyHeight());
    // At the newest row by what is drawn (a residue under half a pixel is no scroll back).
    if (pos === this.#index.length - 1 && Math.round(offset) <= 0) {
      if (!this.#pointerIn) { this.#release(); return; }
      offset = 0;
    }
    this.#anchor = { k: this.#index.at(pos), offset: Math.max(0, offset) };
    this.#scrolled = pos < this.#index.length - 1 || Math.round(offset) > 0;
    if (pos < OVERSCAN) this.#fillBack();
    this.invalidate();
  }

  #rowAt(y: number): Extract<Drawn, { kind: 'row' }> | null {
    for (const d of this.#drawn) if (d.kind === 'row' && y >= d.y && y < d.y + d.h) return d;
    return null;
  }
  /** The order under the pointer sets the shared time cursor (none in a replay, which shows another moment). */
  #hoverChanged(): void {
    const row = this.#pointer && !replaying() ? this.#rowAt(this.#pointer.y) : null, hover = this.store.state.hover;
    if (!row) { if (hover?.source === 'trades') this.store.set({ hover: null }); return; }
    if (hover?.source === 'trades' && hover.t === row.rec.t) return;
    this.store.set({ hover: { t: row.rec.t, price: row.rec.price, y: 0, source: 'trades' } });
  }

  // ---- drawing --------------------------------------------------------------------------------------------------------------------

  /** A row of this frame, laid out before anything is drawn: device-pixel top and height, and what draws it. */
  #item(sig: string, y: number, h: number, kind: Item['kind'], fixed = false): Item {
    const it = this.#itemPool[this.#items.length] ??= { sig: '', y: 0, h: 0, fixed: false, kind: 'row', rec: null, orders: 1, usd: 0, shown: null, tier: TIERS[0]!, timeY: -1, outlined: false, reasons: 0, words: '' };
    it.sig = sig; it.y = y; it.h = h; it.kind = kind; it.fixed = fixed; it.rec = null; it.shown = null; it.timeY = -1; it.outlined = false; it.reasons = 0; it.words = '';
    this.#items.push(it);
    return it;
  }

  /**
   * A frame in two passes, as the block list's (`RetainedRows`): rows laid out first, each on a whole device pixel and a whole number of
   * them tall (its nominal height rounded at this pixel ratio), and drawn in its own coordinates from that top, so a row moved by the list
   * (a new order on top, a scroll) is shifted with the canvas and comes out as it would be drawn there; only new rows, the row the pointer
   * is on and the rows the box beside it covered are drawn. Where the recording's rows show below the tape's oldest order, the frame is
   * drawn whole, as before.
   */
  #paint(now = performance.now()): void {
    const ctx = this.#ctx, w = this.#w, h = this.#h, p = this.#palette, dpr = this.#dpr;
    if (!this.#shown || w < 40 || h < 20) return;
    const ring = this.#index.ring, replay = replaying();
    const heldFrom = ring && ring.written ? readRecord(ring, ring.first).t : null;
    const since = heldFrom === null ? '' : replay ? t('Not the replay: live orders since {time}', { time: clockSeconds(heldFrom) }) : t('Since {time}', { time: clockSeconds(heldFrom) });
    if (since !== this.since) { this.since = since; this.onSince(); }
    this.root.classList.toggle('replaying', replay);
    const drawn: Drawn[] = [];
    this.#drawn = drawn;
    if (!ring || !this.#index.length) {
      // No live order yet: the recording's (Time & sales' hour, from $25K) stand under a line saying so; else the list waits.
      this.rows.reset();
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0); ctx.fillStyle = p.panel; ctx.fillRect(0, 0, this.#canvas.width / dpr, this.#canvas.height / dpr);
      if (this.history.length) { this.#paintHistory(ctx, 0, w, h, p, drawn); return; }
      ctx.fillStyle = p.muted; ctx.font = `12px ${MONO}`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText(t('Waiting for live orders'), w / 2, Math.min(h / 2, 60));
      return;
    }
    // The anchor fell behind the ring's oldest order: the list says so and stands at the oldest it holds.
    let pos = this.#unitTop(this.#index.length - 1), y = 0, expired = false;
    if (this.#anchor) {
      if (!this.#index.valid(this.#anchor.k)) { expired = true; this.#anchor = { k: this.#index.at(0), offset: 0 }; }
      pos = this.#unitTop(this.#index.position(this.#anchor.k)); y = -this.#anchor.offset;
    } else if (this.#conveyor.moving) y = -this.#conveyor.step(now);
    const { whale } = this.#whale(), s = this.store.state.trades, form = clockForm(w);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const widths = this.#widths(ctx), clockW = form === 'none' ? 0 : form === 'hms' ? widths.hms : widths.ms;
    const H = this.#canvas.height;
    this.#items.length = 0;
    // Device pixels from here: each row's top on a whole one, its height its nominal height rounded at this ratio.
    // The price column is sized for the widest price among the rows laid out (`rowGeom`).
    let yd = Math.round(y * dpr), lastSecond = '', above = -1, first = true, priceChars = 0;
    const top = pos;
    while (pos >= 0 && yd < H) {
      const k = this.#index.at(pos);
      if (!this.#index.valid(k)) break;
      const rec = readRecord(ring, k);
      // Grouping: the older orders of the same market, side and slice of GROUP_MS join this row (fixed slices: rows stay put as the list scrolls).
      let orders = 1, usd = Math.abs(rec.usd), qty = usd / rec.price, lowest = k, next = pos - 1, lo = rec.lo, hi = rec.hi;
      if (s.group) {
        while (next >= 0) {
          const o = readRecord(ring, this.#index.at(next));
          if (!this.#together(rec, o)) break;
          orders++; usd += Math.abs(o.usd); qty += Math.abs(o.usd) / o.price; lowest = o.k; next--; lo = Math.min(lo, o.lo); hi = Math.max(hi, o.hi);
        }
      }
      // A boundary between this row and the one above: orders may be missing there.
      if (above >= 0) {
        const reasons = this.#index.boundariesBetween(k, above);
        if (reasons) {
          const dh = Math.round(DIVIDER_ROW * dpr);
          // A line wholly above the top (rows not down yet) is passed, not drawn.
          if (yd + dh > 0) { const d = this.#item(`d|${k}|${reasons}`, yd, dh, 'divider'); d.reasons = reasons; drawn.push({ kind: 'divider', y: yd / dpr, h: dh / dpr, reasons }); }
          yd += dh;
          if (yd >= H) break;
        }
      }
      const buy = rec.usd > 0, signed = buy ? usd : -usd, tier = TIERS[tierOf(signed, scaledUsd, whale)]!, hd = Math.round(tier.row * dpr);
      // A row wholly above the top (one the conveyor has not brought down yet) is passed, not drawn: the time goes on the first row in sight.
      if (yd + hd <= 0) { lastSecond = clockSeconds(rec.t); above = lowest; yd += hd; pos = next; continue; }
      const shown = orders > 1 ? { ...rec, usd: signed, price: usd / qty, lo, hi } : rec;
      priceChars = Math.max(priceChars, priceWidth(shown.price));
      // The time once per second-run and on the first row in sight; on a row coming in at the top it slides down inside the row to stay in
      // sight (the top of a moving list always says its time): its middle, CSS px down the row, or -1 for none.
      const second = clockSeconds(rec.t), showTime = clockW > 0 && (second !== lastSecond || first);
      const timeY = !showTime ? -1 : yd < 0 ? Math.min(tier.row - 6, Math.max(tier.row / 2, -yd / dpr + 7)) : tier.row / 2;
      const it = this.#item(`r|${k}|${orders}|${usd}|${timeY}`, yd, hd, 'row');
      it.rec = rec; it.shown = shown; it.tier = tier; it.orders = orders; it.usd = signed; it.timeY = timeY;
      drawn.push({ kind: 'row', k, y: yd / dpr, h: hd / dpr, rec: shown, orders, usd: signed });
      lastSecond = second; first = false;
      above = lowest; yd += hd; pos = next;
    }
    // Past the tape's oldest order: the recording's (from $25K), under a line that says where the live orders begin (drawn whole).
    const history = pos < 0 && !this.#index.moreBehind && yd < H && this.history.length > 0;
    // The row under the pointer (or the one a finger pinned): outlined as part of the row, its whole story in a box beside it after. With
    // the recording's rows on screen it is found once they are laid out too (one of them may be the row), and outlined over the frame.
    let hover = history ? null : this.#hovered();
    if (hover) for (const it of this.#items) if (it.kind === 'row' && it.rec?.k === hover.row.k) { it.outlined = true; it.sig += '|o'; break; }
    if (expired) { const words = t('Older orders have left memory'), it = this.#item(`x|${words}`, 0, Math.round(DIVIDER_ROW * dpr), 'note', true); it.words = words; }
    // The rows' parts, for the widest price among the rows laid out (and the recording's, when its rows show too).
    const g = this.#geom(ctx, w, history ? Math.max(priceChars, this.#historyChars()) : priceChars);
    // What the rows' pixels depend on beyond their own signatures (a cleared ring numbers its writes from 0 again): any change draws the
    // whole frame.
    const look = `${w}|${h}|${dpr}|${ring.generation}|${this.#epoch}|${marksEpoch()}|${whale}|${form}|${clockW}|${s.group}|${replay}|${document.documentElement.lang}|${g.xBar}|${g.barRoom}|${g.full}`;
    if (history) this.rows.reset();
    const items = this.#items, draw = this.rows.plan(ctx, look, items, 1, H, p.panel, Math.min(H, yd));
    const fw = this.#canvas.width / dpr;
    for (let i = 0; i < items.length; i++) {
      if (!draw[i]) continue;
      const it = items[i]!;
      ctx.setTransform(dpr, 0, 0, dpr, 0, it.y);
      const fh = it.h / dpr;
      if (it.kind === 'row') this.#drawOrder(ctx, g, this.#fill(it.rec!.t, it.shown!.price, it.usd, it.rec!.id, it.orders), 0, it.tier, fh, fw, it.timeY, it.outlined, p);
      else if (it.kind === 'divider') this.#paintDivider(ctx, 0, w, it.reasons, p, fh, fw);
      else { ctx.fillStyle = p.panel; ctx.fillRect(0, 0, fw, fh); this.#paintNote(ctx, 0, w, it.words, p, fh); }
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    if (history) {
      this.#paintHistory(ctx, yd / dpr, w, h, p, drawn, g);
      hover = this.#hovered();
      if (hover) { const r = hover.row; ctx.strokeStyle = p.text; ctx.globalAlpha = 0.35; ctx.lineWidth = 1; ctx.strokeRect(0.5, r.y + 0.5, w - 1, r.h - 1); ctx.globalAlpha = 1; }
      // Drawn over rows past what their signatures say: the next frame is drawn whole.
      this.rows.reset();
    }
    if (hover) {
      // Down from the pointer in the upper half, up from it in the lower, so the box stays inside the list (a pinned row: from its middle).
      const row = hover.row, pt = hover.pinned ? { x: w / 2, y: row.y + row.h / 2 } : this.#pointer!;
      const box = paintInfoBox(ctx, this.#lines(row), pt.x, pt.y, { x0: 0, y0: 0, x1: w, y1: h }, p, { placement: pt.y < h / 2 ? 'down' : 'up', edge: row.usd > 0 ? p.candleUp : p.candleDown });
      // The rows under the box are drawn again next frame (their pixels carry it), with a margin for its edge.
      if (box) this.rows.damage(Math.floor((box.y - 2) * dpr), Math.ceil((box.y + box.h + 2) * dpr));
    }
    // A pointer resting on the list when its first rows were drawn holds them now; the shared time cursor follows the row it is on now.
    if (this.#pointerIn && !this.#anchor) this.#hold();
    if (this.#pointer) this.#hoverChanged();
    // Moving: the next frame steps it on. Rows ran out above the foot (a burst grouped in one row): more are found, as many orders again as
    // the rows drawn took; near the oldest found, the usual overscan.
    if (this.#conveyor.moving) this.invalidate();
    if (this.#index.moreBehind) { if (pos < 0 && yd < H) this.#fillBack(Math.max(OVERSCAN, top + 1)); else if (pos < OVERSCAN) this.#fillBack(); }
  }

  /** The row a finger pinned, if it is drawn, else the one under the pointer (among the rows this frame has laid out so far). */
  #hovered(): { row: Extract<Drawn, { kind: 'row' }>; pinned: boolean } | null {
    const pinned = this.#pinned !== null ? this.#drawn.find((d): d is Extract<Drawn, { kind: 'row' }> => d.kind === 'row' && d.k === this.#pinned) ?? null : null;
    if (pinned) return { row: pinned, pinned: true };
    const row = this.#pointer ? this.#rowAt(this.#pointer.y) : null;
    return row ? { row, pinned: false } : null;
  }

  /**
   * The rows' parts at this width (`RowGeom`): the clock, the mark, the side, the price at their places as before; the bar from after a
   * column for the coin's price (the font is monospaced, so a column is digits) to before one for the widest amount ("$999.9K" at the
   * largest tier) and, where rows group orders, a count ("×99"); no bar where that leaves under 24 px. Its full dollars follow the smallest
   * order.
   */
  #geom(ctx: CanvasRenderingContext2D, w: number, priceChars: number): RowGeom {
    const s = this.store.state.trades, key = `${w}|${this.#dpr}|${s.group}|${s.minUsd}|${priceChars}`;
    if (key === this.#geomKey && this.#geomLast) return this.#geomLast;
    const g = rowGeom(w, this.#widths(ctx), s.group, priceChars, scaledUsd(orderBarFull(s.minUsd)));
    // The box beside a row names the bar's scale only where a bar is drawn.
    this.#barFull = g.barRoom ? g.full : 0; this.#geomKey = key;
    return this.#geomLast = g;
  }
  /** The widest price of the recording's rows, in characters (counted once for each list of them). */
  #historyChars(): number {
    if (this.#historyCharsOf !== this.history) {
      let n = 0;
      for (const l of this.history) if (l.k !== 'gap') n = Math.max(n, priceWidth(l.price));
      this.#historyCharsOf = this.history; this.#historyCharsN = n;
    }
    return this.#historyCharsN;
  }
  /** A price as the rows write it, kept for the next rows at that price (at most 1,024 kept: then it starts again). */
  #priceText(v: number): string {
    let s = this.#prices.get(v);
    if (s === undefined) { if (this.#prices.size >= 1024) this.#prices.clear(); s = fmtPrice(v); this.#prices.set(v, s); }
    return s;
  }
  /** The scratch row description filled with one row's parts (see `#order`). */
  #fill(t: number, price: number, usd: number, id: string, orders: number): RowOrder {
    const o = this.#order; o.t = t; o.price = price; o.usd = usd; o.id = id; o.orders = orders;
    return o;
  }
  /** The font widths at this pixel ratio (see `#fontWidths`). */
  #widths(ctx: CanvasRenderingContext2D): FontWidths {
    const dpr = this.#dpr;
    if (this.#fontWidths?.dpr === dpr) return this.#fontWidths;
    const big = TIERS[TIERS.length - 1]!;
    ctx.font = `11px ${MONO}`;
    const hms = ctx.measureText('00:00:00').width, ms = ctx.measureText('00:00').width, digit11 = ctx.measureText('0').width;
    ctx.font = `13px ${MONO}`; const digit13 = ctx.measureText('0').width;
    ctx.font = `${big.weight} ${big.amountPx}px ${MONO}`; const digitBig = ctx.measureText('0').width;
    ctx.font = `700 12px ${MONO}`; const more = ctx.measureText('›').width;
    return this.#fontWidths = { dpr, hms, ms, digit11, digit13, digitBig, more };
  }
  /**
   * One order row from `y0` (0 in a row's own coordinates; the recording's rows pass their place), its tier's height, filled `fh` tall (its
   * drawn height) and `fw` wide: the faint tint of its side, the time once per second-run, the mark, the side, the price, the bar (the
   * square root of its dollars over the full dollars, a mark past them) and the size. The tape's rows and the recording's are drawn alike.
   */
  #drawOrder(ctx: CanvasRenderingContext2D, g: RowGeom, o: RowOrder, y0: number, tier: Tier, fh: number, fw: number, timeY: number, outlined: boolean, p: Palette): void {
    const buy = o.usd > 0, usd = Math.abs(o.usd), top = p.dark ? TINT_TOP_DARK : TINT_TOP_LIGHT, ink = this.#inks.get(p, buy, ORDER_TINT, top), mid = y0 + tier.row / 2;
    ctx.fillStyle = ink.bg; ctx.fillRect(0, y0, fw, fh);
    // The bar straight after the row's fill, before any text is set up (it touches no text): one colour and one rectangle a row.
    if (g.barRoom) {
      const bh = tier.row >= 30 ? 12 : 10, len = Math.max(1, Math.round(g.barRoom * Math.min(1, Math.sqrt(usd / g.full))));
      ctx.fillStyle = ink.bar; ctx.fillRect(g.xBar, mid - bh / 2, len, bh);
    }
    ctx.textBaseline = 'middle'; ctx.textAlign = 'left';
    if (timeY >= 0 && g.clockW) {
      const second = clockSeconds(o.t);
      ctx.font = `11px ${MONO}`; ctx.fillStyle = ink.muted;
      ctx.fillText(g.form === 'hms' ? second : second.slice(3), PAD, y0 + timeY);
    }
    drawVenueMark(ctx, o.id, g.xMark, mid, MARK, this.#dpr);
    // The side's glyph in its colour where that reads on the row, else in the row's text colour; past the bar's full dollars, a mark in the
    // same ink after it.
    ctx.font = `10px ${MONO}`; ctx.fillStyle = ink.glyph;
    ctx.fillText(buy ? '▲' : '▼', g.xSide, mid);
    if (g.barRoom && usd > g.full) { ctx.font = `700 12px ${MONO}`; ctx.fillText('›', g.xMore, mid); }
    ctx.font = `13px ${MONO}`; ctx.fillStyle = ink.text;
    ctx.fillText(this.#priceText(o.price), g.xPrice, mid);
    ctx.textAlign = 'right';
    ctx.font = `${tier.weight} ${tier.amountPx}px ${MONO}`;
    const amount = amountText(usd);
    ctx.fillText(amount, g.xRight, mid);
    if (o.orders > 1) { const aw = ctx.measureText(amount).width; ctx.font = `11px ${MONO}`; ctx.fillStyle = ink.muted; ctx.fillText(`×${o.orders}`, g.xRight - aw - GAP, mid); }
    if (outlined) { ctx.strokeStyle = p.text; ctx.globalAlpha = 0.35; ctx.lineWidth = 1; ctx.strokeRect(0.5, y0 + 0.5, this.#w - 1, fh - 1); ctx.globalAlpha = 1; }
  }

  #lines(row: Extract<Drawn, { kind: 'row' }>): InfoLine[] {
    const r = row.rec, buy = row.usd > 0, ms = String(Math.round(((r.t % 1000) + 1000) % 1000)).padStart(3, '0');
    const lines: InfoLine[] = [
      { text: `${buy ? t('BUY') : t('SELL')}  ${amountText(Math.abs(row.usd))}`, bold: true, color: buy ? 'buy' : 'sell', mark: r.id },
      { label: t('Venue'), text: `${venueLabel(r.id)} ${r.id.slice(r.id.indexOf(':') + 1)}` },
      { label: t('Price'), text: fmtPrice(r.price) },
    ];
    if (r.hi > r.lo) lines.push({ label: t('Range'), text: `${fmtPrice(r.lo)} – ${fmtPrice(r.hi)}` });
    if (row.orders > 1) lines.push({ label: t('Orders'), text: String(row.orders) });
    lines.push({ label: t('Time'), text: `${clockSeconds(r.t)}.${ms}` });
    if (this.#barFull > 0) lines.push({ text: t('√ size, full ${usd}', { usd: fmtUsd(this.#barFull) }), color: 'muted' });
    // Only where a click does it: not on a phone (the map is another tab), not for a finger (a tap pins the row), not in a replay.
    if (!replaying() && !isPhone() && !this.#lastTouch) lines.push({ text: t('Click to show it on the map'), color: 'muted' });
    return lines;
  }

  /** The height the recording's rows take below the tape's oldest order (the line before them included): how far the list scrolls past it. */
  #historyHeight(): number {
    if (!this.history.length) return 0;
    const whale = this.#whale().whale;
    let h = DIVIDER_ROW;
    for (const l of this.history) h += l.k === 'gap' ? DIVIDER_ROW : TIERS[tierOf(l.side === 'buy' ? l.usd : -l.usd, scaledUsd, whale)]!.row;
    return h;
  }
  /**
   * The recording's rows (Time & sales' hour, newest first, its holes as lines), drawn in the list's own look from `y`: a line first, then
   * each order as the tape's are. A row's write number is negative (it is not the ring's), so it is pointed at and clicked like any other.
   */
  #paintHistory(ctx: CanvasRenderingContext2D, y: number, w: number, h: number, p: Palette, drawn: Drawn[], geom?: RowGeom): void {
    // Rows and lines wholly above the top are passed, not drawn: scrolled deep into the recording, hundreds of them lie above the list, and
    // drawing them all every frame (each batch while held) took a phone's frame and more.
    if (y + DIVIDER_ROW > 0) { this.#paintNote(ctx, y, w, this.historyNote, p); drawn.push({ kind: 'divider', y, h: DIVIDER_ROW, reasons: 0 }); }
    y += DIVIDER_ROW;
    const whale = this.#whale().whale, g = geom ?? this.#geom(ctx, w, this.#historyChars()), fw = this.#canvas.width / this.#dpr;
    // The time once per second-run (whole seconds compare as the written clock does: zones differ from UTC by whole minutes).
    let lastSec = NaN;
    for (let i = 0; i < this.history.length && y < h; i++) {
      const l = this.history[i]!;
      if (l.k === 'gap') {
        if (y + DIVIDER_ROW > 0) {
          const words = l.why === 'unrecorded' ? t('Nothing was recorded from {from} to {to}', { from: clockSeconds(l.at - l.ms), to: clockSeconds(l.at) }) : t('Orders may be missing here: the stream reconnected.');
          this.#paintNote(ctx, y, w, words, p); drawn.push({ kind: 'divider', y, h: DIVIDER_ROW, reasons: 0 });
        }
        y += DIVIDER_ROW; lastSec = NaN; continue;
      }
      const buy = l.side === 'buy', signed = buy ? l.usd : -l.usd, tier = TIERS[tierOf(signed, scaledUsd, whale)]!, rowH = tier.row, sec = Math.floor(l.t / 1000);
      if (y + rowH <= 0) { lastSec = sec; y += rowH; continue; }
      this.#drawOrder(ctx, g, this.#fill(l.t, l.price, signed, l.id, l.orders), y, tier, rowH, fw, sec !== lastSec ? rowH / 2 : -1, false, p);
      lastSec = sec;
      drawn.push({ kind: 'row', k: -1 - i, y, h: rowH, rec: { k: -1 - i, t: l.t, price: l.price, usd: signed, id: l.id, lo: l.lo, hi: l.hi }, orders: l.orders, usd: signed });
      y += rowH;
    }
  }

  #paintDivider(ctx: CanvasRenderingContext2D, y: number, w: number, reasons: number, p: Palette, fh = DIVIDER_ROW, fw = w): void {
    // A start is never between two rows (it is before the first write): only a reconnect, a skip or a trim draws a line.
    const words = reasons & (BOUNDARY.reconnect | BOUNDARY.cleared) ? t('The stream reconnected here: orders may be missing.')
      : reasons & BOUNDARY.skipped ? t('The source skipped orders here: some may be missing.')
      : t('The source left out its smallest orders here.');
    ctx.fillStyle = p.panel; ctx.fillRect(0, y, fw, fh);
    this.#paintNote(ctx, y, w, words, p, fh);
  }
  /** A line's words over a dashed rule along its foot, `rowH` its drawn height (the rule stays inside it whatever the pixel ratio rounds it to). */
  #paintNote(ctx: CanvasRenderingContext2D, y: number, w: number, words: string, p: Palette, rowH = DIVIDER_ROW): void {
    ctx.strokeStyle = p.line; ctx.setLineDash([3, 3]); ctx.beginPath(); ctx.moveTo(PAD, y + rowH - 0.5); ctx.lineTo(w - PAD, y + rowH - 0.5); ctx.stroke(); ctx.setLineDash([]);
    ctx.font = `italic 11px ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif`; ctx.fillStyle = p.muted; ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
    let text = words;
    while (text.length > 4 && ctx.measureText(text).width > w - 2 * PAD) text = `${text.slice(0, -2)}…`;
    ctx.fillText(text, PAD, y + DIVIDER_ROW / 2);
  }
}
