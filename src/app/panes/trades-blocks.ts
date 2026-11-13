import { el } from '../dom.ts';
import { t } from '../i18n.ts';
import { clock, clockSeconds } from '../format.ts';
import { money } from './trades-inspector.ts';
import { drawVenueMark, marksEpoch } from '../venue-marks.ts';
import { replaying } from '../replay/clock.ts';
import { isPhone } from '../device.ts';
import { contrastRatio, type Palette, PALETTES } from '../theme.ts';
import { pixelRatio, sharpens } from '../pixel-ratio.ts';
import { scaledUsd } from '../coin.ts';
import { BlockReader, barLength, emptyBlock, fullScale, type Block } from '../trades/blocks.ts';
import { RowWalker, type Row, type RowKind } from '../trades/rows.ts';
import { RetainedRows } from './retained-rows.ts';

const MONO = 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace';
const SANS = 'ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif';
const PAD = 8;
/** A block's row, a folded run of empty blocks, a line where a source ends or a venue is late. */
const ROW = 48, ROW_PHONE = 56, QUIET = 24, NOTE = 24;
/**
 * A settled block that is still growing (a slow venue's orders landing after its second) is drawn again at most this often: the forming
 * block keeps every batch, and the one before it, which grows with nearly every batch for a second or so, at four frames a second.
 */
const LATE_REDRAW_MS = 250;
/** The list's width beside the inspector, and the narrowest inspector worth opening (Sol and Astra, round 2: 367 + 16 + inspector). */
export const LIST_W = 367, INSPECTOR_MIN = 240;
export const wideEnough = (w: number): boolean => w >= LIST_W + 16 + INSPECTOR_MIN;

/** What one frame drew, for the pointer and the checks. */
type Drawn = { kind: 'block'; s: number; y: number; h: number } | { kind: 'quiet'; s: number; e: number; y: number; h: number } | { kind: 'note'; y: number; h: number };
/**
 * A row of a frame, laid out before anything is drawn: its signature (everything its pixels depend on) and what draws it. Every height is a
 * multiple of 8 CSS px, so at the usual pixel ratios (1, 1.25, 1.5, 1.75, 2, 2.625, 3) a row's edges sit on whole device pixels and a frame
 * can keep its rows (`RetainedRows`).
 */
interface Item { sig: string; y: number; h: number; fixed: boolean; kind: 'block' | RowKind | 'end' | 'late'; b: Block | null; from: number; to: number; words: string }
/** The fonts a block's row uses (made once per device kind) and one digit's width in the time's font. */
interface RowFonts { phone: boolean; made: boolean; time: string; ref: string; amount: string; over: string; top: string; topWhale: string; dash: string; digit: number }

/** Where a block's columns sit at a list width (CSS px). */
export function blockColumns(lw: number, phone: boolean): { t: number; amt: number; bars: number; big: number } {
  const narrow = lw < 300, t = narrow ? 52 : phone ? 66 : 64, amt = narrow ? 74 : phone ? 90 : 86, big = lw >= 340 ? (phone ? 86 : 82) : 0;
  return { t, amt, big, bars: Math.max(60, lw - PAD * 2 - t - amt - (big ? big + 6 : 0)) };
}

/**
 * Trades grouped by time, on one canvas: a row per block of `unit` seconds, newest on top (`trades/blocks.ts` adds them up). Left the time
 * over the reference market's VWAP change in dollars; then bought over sold, each with a square-root bar split by venue in one fixed order
 * (full width at about the week's 99th percentile of a block's side, `fullScale`); then the largest buy and the largest sell. A run of empty
 * blocks (a quiet coin at a second) is one line. The list holds still under a mouse or scrolled back, a block pointed at sets the shared time
 * cursor, a click chooses it for the inspector and takes the map to its time; a finger drags it and a tap chooses a block.
 */
export class BlockList {
  readonly root = el('div', { class: 'trades-wrap trades-blocks' });
  #canvas = el('canvas', { class: 'trades-canvas', ariaLabel: t('Trades') });
  #ctx: CanvasRenderingContext2D;
  #palette: Palette = PALETTES.light!;
  #shown = false; #frame = 0;
  #w = 0; #h = 0; #dpr = 1;
  #pool: Block[] = [];
  #drawn: Drawn[] = [];
  /** null: the list follows the newest block; else the block starting at second `s` is drawn `offset` px above the top. */
  #anchor: { s: number; offset: number } | null = null;
  #pointer: { x: number; y: number } | null = null; #pointerIn = false; #scrolled = false;
  #touch: { id: number; y: number; moved: number; owed: number } | null = null;
  #lastTouch = false;
  /** The block a finger's tap chose, whose details open on the click that follows the lift. */
  #tapped: number | null = null;
  /** The block chosen for the inspector (its start second), or null (the inspector follows the newest settled block). */
  selected: number | null = null;
  readonly reader = new BlockReader();
  /** The rows over the blocks (a run of empty ones is one row), shared by the paint and the wheel. */
  readonly #walker = new RowWalker(this.reader);
  /** The rows kept on the canvas between frames, this frame's rows, and a count bumped by any change the look key cannot see. */
  readonly rows = new RetainedRows();
  #items: Item[] = []; #itemPool: Item[] = [];
  #epoch = 0; #inspectTimer = 0;
  /** Each block row's signature as drawn last frame (by its start), when it was last drawn anew, and the next frame's; a timer for a late redraw. */
  #shownSig = new Map<number, { sig: string; at: number; forming: boolean; chosen: boolean }>();
  #nextSig = new Map<number, { sig: string; at: number; forming: boolean; chosen: boolean }>();
  #catchUpTimer = 0;
  /** The time labels of the blocks drawn (a row drawn again keeps its label), under the unit and the epoch they were made for. */
  #labels = new Map<number, string>(); #labelsKey = '';
  /** The block length in seconds, the venue marks (one id per venue slot), the late venues' names, and the time now (exchange ms). */
  unit = 1;
  venueIds: string[] = [];
  late: string[] = [];
  now: () => number = () => Date.now();
  /** The words where the list ends, at second `at` (set by the shell: they depend on the size and the sources). */
  endNote: (at: number) => string = () => '';
  /** The whale size (the coin's dollars): a named order this large is drawn heavier. */
  whale = 400_000;
  /** A block was chosen or let go, or the newest settled block moved on (the shell redraws the inspector). */
  onInspect: () => void = () => {};
  /** The list was held or let go (the shell says so in its status). */
  onHold: () => void = () => {};
  /** Take the map to a stretch of time (set by the shell). */
  onGoTo: (t0: number, t1: number, p0: number, p1: number) => void = () => {};
  /** A finger tapped a block (a phone opens its details in a sheet). */
  onTap: (s: number) => void = () => {};
  /** The block under the pointer (or null) for the shared time cursor. */
  onHover: (block: Block | null) => void = () => {};
  /** A frame drew blocks over another stretch (seconds: the oldest drawn block's start, the newest's end): the shell reads what they need. */
  onDrawn: (s0: number, s1: number) => void = () => {};
  #lastNewest = NaN; #drawnKey = '';

  constructor() {
    this.root.append(this.#canvas);
    this.#ctx = this.#canvas.getContext('2d', { alpha: false })!;
    new ResizeObserver(() => this.#resize()).observe(this.root);
    sharpens({ resize: () => this.#resize(), paint: () => { if (this.#shown) this.#paint(); } });
    const c = this.#canvas;
    // A canvas given back by the browser (its graphics memory was taken back, as phones do) comes back empty: nothing kept on it holds.
    c.addEventListener('contextrestored', () => { this.rows.reset(); this.invalidate(); });
    // A page shown again draws the list whole (a browser may have let a hidden page's canvas go).
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') { this.rows.reset(); this.invalidate(); } });
    c.addEventListener('pointermove', e => {
      if (e.pointerType === 'touch') return;
      this.#lastTouch = false;
      this.#pointer = { x: e.offsetX, y: e.offsetY };
      this.#pointerIn = true; this.#hold();
      this.#hover(); this.invalidate();
    });
    c.addEventListener('pointerleave', e => { if (e.pointerType === 'touch') return; this.#pointerIn = false; this.#pointer = null; this.onHover(null); if (!this.#scrolled && this.selected === null) this.release(); this.invalidate(); });
    c.addEventListener('wheel', e => { if (e.ctrlKey) return; e.preventDefault(); this.#scroll(e.deltaY * (e.deltaMode === 1 ? 24 : e.deltaMode === 2 ? this.#h : 1)); this.#hover(); }, { passive: false });
    c.addEventListener('click', e => {
      // A finger's tap chose its block on lift; its details open now, on the click that follows, which would otherwise land on the sheet's
      // backdrop and close it at once.
      if (this.#lastTouch) { const s = this.#tapped; this.#tapped = null; if (s !== null) this.onTap(s); return; }
      const row = this.#rowAt(e.offsetY);
      if (!row || row.kind !== 'block') return;
      // A click chooses the block (the inspector shows it, the list holds) and, on a desktop, takes the map to its time; a second click lets it go.
      if (this.selected === row.s) { this.selected = null; this.onInspect(); this.invalidate(); return; }
      this.selected = row.s; this.#hold(); this.onInspect(); this.invalidate();
      // A block whose reference market did not trade sends no price: the map keeps its price window (`focusWindow`).
      if (!replaying() && !isPhone()) { const b = this.#read(row.s, this.#scratch()); const p = Number.isFinite(b.refPx) ? b.refPx : NaN; this.onGoTo(row.s * 1000, (row.s + this.unit) * 1000, p, p); }
    });
    c.addEventListener('pointerdown', e => {
      this.#lastTouch = e.pointerType === 'touch';
      if (e.pointerType !== 'touch') return;
      this.#touch = { id: e.pointerId, y: e.clientY, moved: 0, owed: 0 }; c.setPointerCapture(e.pointerId);
    });
    c.addEventListener('pointermove', e => {
      const tch = this.#touch;
      if (!tch || e.pointerId !== tch.id) return;
      const dy = tch.y - e.clientY; tch.y = e.clientY; tch.moved += Math.abs(dy); tch.owed += dy;
      if (tch.moved > 6) { this.#scroll(tch.owed); tch.owed = 0; }
    });
    const lift = (e: PointerEvent): void => {
      const tch = this.#touch;
      if (!tch || e.pointerId !== tch.id) return;
      this.#touch = null;
      if (tch.moved > 6) return;
      const row = this.#rowAt(e.offsetY);
      if (!row || row.kind !== 'block') return;
      this.selected = row.s; this.#tapped = row.s; this.#hold(); this.onInspect(); this.invalidate();
    };
    c.addEventListener('pointerup', lift); c.addEventListener('pointercancel', e => { if (this.#touch?.id === e.pointerId) this.#touch = null; });
  }

  get held(): boolean { return this.#anchor !== null; }
  get width(): number { return this.#w; }
  setShown(shown: boolean): void {
    if (shown === this.#shown) return;
    this.#shown = shown;
    if (!shown) { this.#pointerIn = false; this.#pointer = null; this.onHover(null); this.release(false); return; }
    // Shown again: drawn whole (hidden, the canvas was made 1 px and back, which empties it while the look stays the same).
    this.rows.reset();
    this.#resize();
  }
  setPalette(p: Palette): void { this.#palette = p; this.#epoch++; this.invalidate(); }
  invalidate(): void { if (!this.#frame && this.#shown) this.#frame = requestAnimationFrame(() => { this.#frame = 0; this.#paint(); }); }
  /** Draw every row again at the next frame (the time zone, the language or a replay changed what a row says). */
  redrawAll(): void { this.#epoch++; this.invalidate(); }
  /** The inspector follows the newest settled block after this frame (its page is rebuilt then, not inside the frame that saw the block settle). */
  #inspectSoon(): void { if (this.#inspectTimer) return; this.#inspectTimer = window.setTimeout(() => { this.#inspectTimer = 0; if (this.#shown) this.onInspect(); }, 0); }
  /** What the last frame drew, for the checks. */
  get snapshot(): { blocks: number; quiet: number; notes: number; held: boolean; top: number | null } {
    return { blocks: this.#drawn.filter(d => d.kind === 'block').length, quiet: this.#drawn.filter(d => d.kind === 'quiet').length, notes: this.#drawn.filter(d => d.kind === 'note').length, held: this.held, top: this.#anchor?.s ?? null };
  }

  #rowH(): number { return isPhone() ? ROW_PHONE : ROW; }
  /** The newest block's start (seconds). */
  newestStart(): number { const now = this.now(); return Math.floor(Math.floor(now / 1000) / this.unit) * this.unit; }
  #read(s: number, out: Block): Block { return this.reader.read(s, this.unit, out, this.now()); }
  /** A block to read one into outside a frame (the pointer, a click), with as many venue slots as the reader has now. */
  #scratch(): Block {
    let b = this.#pool[0];
    if (!b || b.vBuy.length !== this.reader.venues) this.#pool[0] = b = emptyBlock(this.reader.venues);
    return b;
  }
  /** The walker's rows read under what the blocks are read from now (a change drops the runs it remembers). */
  #rows(): RowWalker {
    const r = this.reader;
    this.#walker.sync(`${this.unit}|${r.version}|${r.dataKey()}`);
    return this.#walker;
  }
  /**
   * A row's height as it is drawn (its nominal height rounded to device pixels): the scroll walks what is drawn, so a row passing the top
   * moves nothing else (walked at nominal heights, every row passing it would jog the list up to a device pixel, more as they add up).
   */
  #rowHeight(row: Row): number { const d = this.#dpr || 1; return Math.round((row.kind === 'block' ? this.#rowH() : QUIET) * d) / d; }
  /** The block chosen, else the newest settled one, read into `out`. */
  inspected(out: Block): { block: Block; state: 'held' | 'newest' } {
    if (this.selected !== null) return { block: this.#read(this.selected, out), state: 'held' };
    let s = this.newestStart();
    for (let i = 0; i < 4; i++, s -= this.unit) { this.#read(s, out); if (!out.forming && !out.settling) break; }
    return { block: out, state: 'newest' };
  }

  #hold(): void { if (this.#anchor) return; this.#anchor = { s: this.newestStart(), offset: 0 }; this.reader.tally?.hold(); this.onHold(); }
  release(draw = true): void {
    if (!this.#anchor && this.selected === null) return;
    this.#anchor = null; this.#scrolled = false; this.selected = null; this.reader.tally?.release(); this.onHold(); this.onInspect();
    if (draw) this.invalidate();
  }
  /**
   * The wheel moves the list by `dy` px (down: older); back at the newest with no mouse on it, the list follows again. It moves row by row
   * as the list draws them (`trades/rows.ts`): a folded hour of quiet seconds is one short row, passed in one step, not 3,600 blocks.
   */
  #scroll(dy: number): void {
    if (!this.#anchor) { this.#hold(); if (!this.#anchor) return; }
    const B = this.unit, newest = this.newestStart(), oldest = this.reader.oldestSec(), now = this.now(), rows = this.#rows();
    let row = rows.rowFrom(this.#anchor.s, B, now, oldest), offset = this.#anchor.offset + dy;
    // Held beyond where the list now ends (the sources moved its end up): the list lets go and follows the newest again. A block that is
    // unknown only for a moment (a flow reload) keeps the place.
    if (!row) { if (this.#anchor.s + B <= oldest) this.release(); else this.invalidate(); return; }
    // Down (older): past every row the offset covers, while a row lies under it; up (newer): rows above come in.
    for (let next = rows.below(row, B, now, oldest); next && offset >= this.#rowHeight(row); next = rows.below(row, B, now, oldest)) { offset -= this.#rowHeight(row); row = next; }
    for (let up = offset < 0 ? rows.above(row, B, now, newest) : null; up; up = offset < 0 ? rows.above(row, B, now, newest) : null) { row = up; offset += this.#rowHeight(up); }
    // The last row stays at the top at most (the list's end note under it stays in view).
    if (!rows.below(row, B, now, oldest)) offset = Math.min(offset, 0);
    if (row.top >= newest && Math.round(offset) <= 0) {
      if (!this.#pointerIn && this.selected === null) { this.release(); return; }
      offset = 0;
    }
    this.#anchor = { s: row.top, offset: Math.max(0, offset) };
    this.#scrolled = row.top < newest || Math.round(offset) > 0;
    this.invalidate();
  }
  #rowAt(y: number): Drawn | null { for (const d of this.#drawn) if (y >= d.y && y < d.y + d.h) return d; return null; }
  #hover(): void {
    const row = this.#pointer && !replaying() ? this.#rowAt(this.#pointer.y) : null;
    if (!row || row.kind !== 'block') { this.onHover(null); return; }
    this.onHover(this.#read(row.s, this.#scratch()));
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
    this.invalidate();
  }

  // ---- drawing --------------------------------------------------------------------------------------------------------------------

  /** A row of this frame (from a pool: a frame allocates nothing once the pool has grown). */
  #item(kind: Item['kind'], sig: string, y: number, h: number, b: Block | null = null, from = 0, to = 0, words = '', fixed = false): void {
    const it = this.#itemPool[this.#items.length] ??= { sig: '', y: 0, h: 0, fixed: false, kind: 'block', b: null, from: 0, to: 0, words: '' };
    it.kind = kind; it.sig = sig; it.y = y; it.h = h; it.b = b; it.from = from; it.to = to; it.words = words; it.fixed = fixed;
    this.#items.push(it);
  }

  /**
   * A frame in two passes: the rows are laid out from the walker (each block read, each row's signature made), then `RetainedRows` says
   * which to draw: a row already on the canvas, unchanged and moved, is shifted with the canvas instead (a settled block does not change, so
   * a frame at a new batch draws the forming block and the one before it; a new second shifts the list a row). Rows are laid out in device
   * pixels, as the order list's: each row's top on a whole one and its height its nominal height rounded at the pixel ratio, drawn in its
   * own coordinates from that top, so a moved row comes out as it would be drawn there at any ratio and any scroll.
   */
  #paint(): void {
    const ctx = this.#ctx, w = this.#w, h = this.#h, p = this.#palette, dpr = this.#dpr;
    if (!this.#shown || w < 40 || h < 20) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const drawn: Drawn[] = []; this.#drawn = drawn;
    this.#items.length = 0;
    const phone = isPhone(), rowH = this.#rowH(), c = blockColumns(w, phone), B = this.unit;
    const full = scaledUsd(fullScale(B)), barW = c.bars - 10;
    const newest = this.newestStart(), oldest = this.reader.oldestSec();
    // The newest settled block moved on: the inspector follows it (once a block, not every frame), after this frame.
    const settled = newest - B;
    if (settled !== this.#lastNewest) { this.#lastNewest = settled; if (this.selected === null) this.#inspectSoon(); }
    // Device pixels from here (the rows' tops and heights; what `drawn` keeps for the pointer is in CSS pixels).
    const H = this.#canvas.height, rowD = Math.round(rowH * dpr), quietD = Math.round(QUIET * dpr), noteD = Math.round(NOTE * dpr), lateD = this.late.length ? noteD : 0;
    const top = this.#anchor ? this.#anchor.s : newest;
    // Held: the offset in whole device pixels.
    let y = lateD - (this.#anchor ? Math.round(this.#anchor.offset * dpr) : 0);
    let poolAt = 0;
    const take = (): Block => { while (this.#pool.length <= poolAt) this.#pool.push(emptyBlock(this.reader.venues)); const b = this.#pool[poolAt++]!; if (b.vBuy.length !== this.reader.venues) { b.vBuy = new Float64Array(this.reader.venues); b.vSell = new Float64Array(this.reader.venues); } return b; };
    if (!Number.isFinite(oldest) && !this.#anchor) {
      this.rows.reset();
      ctx.fillStyle = p.panel; ctx.fillRect(0, 0, this.#canvas.width / dpr, H / dpr);
      ctx.fillStyle = p.muted; ctx.font = `12px ${SANS}`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText(t('Waiting for live orders'), w / 2, Math.min(h / 2, 60));
      return;
    }
    // The rows from the top one down (`trades/rows.ts`): a block, or a run of empty blocks of one kind as one line saying why. The list ends
    // at the oldest second a source knows or at the first block nothing is known of (a market's stray older second, a feed's last trade
    // sent on connecting, does not make the stretch between known).
    const rows = this.#rows(), now = this.now(), nowMs = performance.now();
    let b = take(), row = rows.rowFrom(top, B, now, oldest, b), bottom = top, ended = !row;
    // Held beyond where the list now ends (the sources moved its end up): the list lets go and is drawn from the newest. A block that is
    // unknown only for a moment (a flow reload) keeps the place (the list ends there meanwhile).
    if (!row && this.#anchor && this.#anchor.s + B <= oldest) { this.release(false); this.#paint(); return; }
    // The late venues' banner first in what the pointer finds (it is drawn over the rows scrolled under it, so it is what is there).
    if (this.late.length) drawn.push({ kind: 'note', y: 0, h: noteD / dpr });
    let lo = Infinity, hi = -Infinity;
    while (row && y < H) {
      if (row.kind === 'block') { const chosen = this.selected === b.s; this.#item('block', this.#settleSig(row.top, blockSig(b, chosen), b.forming, chosen, nowMs), y, rowD, b); drawn.push({ kind: 'block', s: row.top, y: y / dpr, h: rowD / dpr }); y += rowD; b = take(); lo = Math.min(lo, row.top); hi = Math.max(hi, row.top); }
      else { this.#item(row.kind, `${row.kind}|${row.bottom}|${row.top + B}`, y, quietD, null, row.bottom, row.top + B); drawn.push({ kind: 'quiet', s: row.top, e: row.bottom, y: y / dpr, h: quietD / dpr }); y += quietD; }
      bottom = row.bottom;
      const next = rows.below(row, B, now, oldest, b);
      if (!next) { ended = true; break; }
      row = next;
    }
    // The stretch of the blocks drawn (not the folded runs: an hour of quiet asks the recording for nothing).
    if (Number.isFinite(lo)) { const key = `${lo}|${hi + B}`; if (key !== this.#drawnKey) { this.#drawnKey = key; this.onDrawn(lo, hi + B); } }
    // Where the list ends: at the oldest second a source knows, or where nothing is known below the last row (the size's history starts there).
    if (y < H && ended) {
      const words = this.endNote(Math.max(bottom, oldest));
      if (words) { this.#item('end', `e|${words}`, y, noteD, null, 0, 0, words); drawn.push({ kind: 'note', y: y / dpr, h: noteD / dpr }); y += noteD; }
    }
    // The late venues' banner over the top of the list, drawn last (a row scrolled under it stays under it).
    if (this.late.length) {
      const words = w < 300 ? t('{venues} delayed', { venues: this.late.join(', ') }) : t('{venues} delayed: the last minute may still grow', { venues: this.late.join(', ') });
      this.#item('late', `l|${words}`, 0, noteD, null, 0, 0, words, true);
    }
    [this.#shownSig, this.#nextSig] = [this.#nextSig, this.#shownSig]; this.#nextSig.clear();
    // What the rows' pixels depend on beyond their own signatures: any change draws the whole frame.
    const look = `${w}|${h}|${dpr}|${phone}|${B}|${this.venueIds.join(',')}|${this.whale}|${this.reader.version}|${this.reader.flowVersion()}|${this.#epoch}|${marksEpoch()}|${document.documentElement.lang}`;
    const items = this.#items, draw = this.rows.plan(ctx, look, items, 1, H, p.panel, Math.min(H, Math.max(y, lateD)));
    // Rows fill to the canvas's own width in device pixels (a width like 366 px at 1.25 is 457.5 of them: a fill to 366 would leave the
    // last column half covered, blended with whatever was under it, which a kept frame and a whole one differ in), and to their own
    // height in device pixels (`fh`); what is inside a row is placed from its nominal height.
    const fw = this.#canvas.width / dpr;
    for (let i = 0; i < items.length; i++) {
      if (!draw[i]) continue;
      const it = items[i]!, fh = it.h / dpr;
      ctx.setTransform(dpr, 0, 0, dpr, 0, it.y);
      if (it.kind === 'block') this.#paintBlock(ctx, it.b!, rowH, fh, fw, c, full, barW, p);
      else if (it.kind === 'end') this.#paintEnd(ctx, fh, fw, it.words, p);
      else if (it.kind === 'late') this.#paintLate(ctx, fh, fw, it.words, p);
      else this.#paintQuiet(ctx, fh, fw, it.from, it.to, p, it.kind);
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }
  /**
   * The signature a block row is drawn under this frame: its own, unless it is a settled block that changed within `LATE_REDRAW_MS` of
   * its last drawing (a late order), when the last one is kept a little longer and a redraw is due when the wait ends. A block that
   * stopped forming or was chosen or let go is drawn at once.
   */
  #settleSig(s: number, sig: string, forming: boolean, chosen: boolean, at: number): string {
    const prev = this.#shownSig.get(s);
    let use = sig, drawnAt = at;
    if (prev) {
      if (prev.sig === sig) drawnAt = prev.at;
      else if (!forming && !prev.forming && prev.chosen === chosen && at - prev.at < LATE_REDRAW_MS) {
        use = prev.sig; drawnAt = prev.at;
        if (!this.#catchUpTimer) this.#catchUpTimer = window.setTimeout(() => { this.#catchUpTimer = 0; this.invalidate(); }, LATE_REDRAW_MS - (at - prev.at) + 5);
      }
    }
    this.#nextSig.set(s, { sig: use, at: drawnAt, forming, chosen });
    return use;
  }
  #paintLate(ctx: CanvasRenderingContext2D, fh: number, w: number, words: string, p: Palette): void {
    ctx.fillStyle = mixLate(p); ctx.fillRect(0, 0, w, fh); ctx.fillStyle = p.line; ctx.fillRect(0, fh - 1, w, 1);
    ctx.font = `11px ${SANS}`; ctx.fillStyle = p.text; ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
    fitText(ctx, words, PAD, NOTE / 2, w - 2 * PAD);
  }

  /** A folded run of empty blocks: no orders, nobody recorded it, or orders may be missing there (a reconnect). In its own coordinates. */
  #paintQuiet(ctx: CanvasRenderingContext2D, fh: number, w: number, from: number, to: number, p: Palette, kind: RowKind): void {
    const y = 0;
    ctx.fillStyle = p.panel; ctx.fillRect(0, y, w, fh);
    ctx.fillStyle = p.line; ctx.fillRect(0, fh - 1, w, 1);
    ctx.font = `11px ${MONO}`; ctx.fillStyle = p.muted; ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
    // A run longer than half a day says its dates (a run of minutes reaches 60 hours).
    const dated = to - from > 12 * 3600, fmt = (sec: number): string => dated ? clock(sec * 1000, true) : this.unit >= 60 ? clock(sec * 1000) : clockSeconds(sec * 1000), at = { from: fmt(from), to: fmt(to) };
    fitText(ctx, kind === 'unrecorded' ? t('Not recorded {from}–{to}', at) : kind === 'missing' ? t('Orders may be missing {from}–{to}', at) : t('No orders {from}–{to}', at), PAD, y + QUIET / 2, w - 2 * PAD);
  }
  #paintEnd(ctx: CanvasRenderingContext2D, fh: number, w: number, words: string, p: Palette): void {
    const y = 0;
    ctx.fillStyle = p.panel; ctx.fillRect(0, y, w, fh);
    ctx.strokeStyle = p.line; ctx.lineWidth = 1; ctx.setLineDash([3, 3]); ctx.beginPath(); ctx.moveTo(PAD, y + 0.5); ctx.lineTo(w - PAD, y + 0.5); ctx.stroke(); ctx.setLineDash([]);
    ctx.font = `italic 11px ${SANS}`; ctx.fillStyle = p.muted; ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
    fitText(ctx, words, PAD, y + NOTE / 2 + 1, w - 2 * PAD);
  }

  /** The fonts a block's row is drawn with, made once (the same string objects every row: a canvas given the font it has skips it). */
  #fonts: RowFonts = { phone: false, made: false, time: '', ref: '', amount: '', over: '', top: '', topWhale: '', dash: '', digit: 0 };
  #rowFonts(ctx: CanvasRenderingContext2D, phone: boolean): RowFonts {
    const f = this.#fonts;
    if (!f.made || f.phone !== phone) {
      f.made = true; f.phone = phone;
      f.time = `${phone ? 12 : 11}px ${MONO}`; f.ref = `600 ${phone ? 12.5 : 11.5}px ${MONO}`; f.amount = `600 ${phone ? 14 : 13}px ${MONO}`;
      f.over = `700 12px ${MONO}`; f.top = `600 ${phone ? 13 : 12}px ${MONO}`; f.topWhale = `700 ${phone ? 13 : 12}px ${MONO}`; f.dash = `11px ${MONO}`;
      // A monospace time: its width is its length times one digit's (the forming block's dot sits after it).
      ctx.font = f.time; f.digit = ctx.measureText('0').width;
    }
    return f;
  }

  /** A block's row in its own coordinates (its top at 0): `h` its nominal height (what is inside is placed from it), `fh` its device height. */
  #paintBlock(ctx: CanvasRenderingContext2D, b: Block, h: number, fh: number, w: number, c: ReturnType<typeof blockColumns>, full: number, barW: number, p: Palette): void {
    const chosen = this.selected === b.s, phone = h === ROW_PHONE, f = this.#rowFonts(ctx, phone), y = 0;
    ctx.fillStyle = chosen ? mixHex(p.panel, p.ui ?? p.text, 0.12) : p.panel; ctx.fillRect(0, y, w, fh);
    ctx.fillStyle = p.line; ctx.fillRect(0, fh - 1, w, 1);
    if (chosen) { ctx.strokeStyle = p.ui ?? p.text; ctx.lineWidth = 1.5; ctx.strokeRect(1, 1, w - 2, fh - 2); }
    const l1 = Math.round(y + h * 0.31), l2 = Math.round(y + h * 0.71);
    ctx.textBaseline = 'middle'; ctx.textAlign = 'left';
    // The time (the forming block in full ink, with a dot), and under it the reference market's VWAP change.
    ctx.font = f.time; ctx.fillStyle = b.forming ? p.text : p.muted;
    const time = this.#timeLabel(b.s, c.t < 60);
    ctx.fillText(time, PAD, l1);
    if (b.forming) { ctx.fillStyle = p.ui ?? p.text; ctx.beginPath(); ctx.arc(PAD + time.length * f.digit + 5, l1, 2.5, 0, Math.PI * 2); ctx.fill(); }
    const d = Number.isFinite(b.refPx) && Number.isFinite(b.refPrev) ? b.refPx - b.refPrev : NaN, dp = this.unit >= 60 ? 0 : 1;
    ctx.font = f.ref;
    if (Number.isFinite(d)) { const r = Number(Math.abs(d).toFixed(dp)); ctx.fillStyle = r === 0 ? p.muted : d > 0 ? p.candleUp : p.candleDown; ctx.fillText(r === 0 ? (0).toFixed(dp) : `${d > 0 ? '+' : '−'}${r.toFixed(dp)}`, PAD, l2); }
    else { ctx.fillStyle = p.muted; ctx.fillText('–', PAD, l2); }
    const xAmt = PAD + c.t, xBars = xAmt + c.amt, xBig = xBars + c.bars + 6;
    // Both sides' amounts in one font, then their bars, then both largest orders.
    ctx.font = f.amount; ctx.textAlign = 'right';
    ctx.fillStyle = p.candleUp; ctx.fillText(`▲ ${money(b.buy)}`, xBars - 7, l1);
    ctx.fillStyle = p.candleDown; ctx.fillText(`▼ ${money(b.sell)}`, xBars - 7, l2);
    ctx.fillStyle = p.line; ctx.fillRect(xBars, l1 - 7, 1, 14); ctx.fillRect(xBars, l2 - 7, 1, 14);
    let over = false;
    for (let side = 0; side < 2; side++) {
      const buy = side === 0, v = buy ? b.buy : b.sell, line = buy ? l1 : l2, len = barLength(v, full, barW);
      if (len > 0) this.#pieces(ctx, xBars + 1, line - 6, 12, len, buy ? b.vBuy : b.vSell, v, buy ? p.candleUp : p.candleDown);
      if (v > full) over = true;
    }
    if (over) {
      ctx.font = f.over; ctx.textAlign = 'left';
      if (b.buy > full) { ctx.fillStyle = p.candleUp; ctx.fillText('›', xBars + barW + 3, l1); }
      if (b.sell > full) { ctx.fillStyle = p.candleDown; ctx.fillText('›', xBars + barW + 3, l2); }
    }
    if (c.big) {
      ctx.textAlign = 'left';
      for (let side = 0; side < 2; side++) {
        const o = side === 0 ? b.topBuy : b.topSell, line = side === 0 ? l1 : l2;
        if (o.has) {
          drawVenueMark(ctx, o.id, xBig + 7, line, phone ? 14 : 13, this.#dpr);
          ctx.font = o.usd >= this.whale ? f.topWhale : f.top; ctx.fillStyle = p.text;
          ctx.fillText(money(o.usd), xBig + 18, line);
        } else { ctx.font = f.dash; ctx.fillStyle = p.muted; ctx.fillText('–', xBig + 4, line); }
      }
    }
    // The dashed foot in its own width (a chosen row before it in the frame left 1.5).
    if (b.partial) { ctx.strokeStyle = p.muted; ctx.lineWidth = 1; ctx.setLineDash([2, 3]); ctx.beginPath(); ctx.moveTo(0, fh - 0.5); ctx.lineTo(w, fh - 0.5); ctx.stroke(); ctx.setLineDash([]); }
  }

  /** A side's bar: the venues' pieces in slot order, each in proportion to its share of the side, a venue's mark inside its piece where it fits. */
  #pieces(ctx: CanvasRenderingContext2D, x: number, y: number, hgt: number, len: number, parts: Float64Array, total: number, col: string): void {
    if (!(total > 0)) return;
    ctx.fillStyle = col; ctx.globalAlpha = 0.85;
    let at = 0, marked = false;
    for (let i = 0; i < parts.length; i++) {
      const v = parts[i]!;
      if (!(v > 0)) continue;
      const seg = len * v / total;
      if (seg >= 0.6) ctx.fillRect(x + at, y, Math.max(0.6, seg - (seg > 3 ? 1 : 0)), hgt);
      if (seg >= 17) marked = true;
      at += seg;
    }
    if (len >= 1 && at < 0.6) ctx.fillRect(x, y, 1, hgt);
    ctx.globalAlpha = 1;
    if (!marked) return;
    // The marks over the pieces, after them (the same walk again: no list made per bar).
    at = 0;
    for (let i = 0; i < parts.length; i++) {
      const v = parts[i]!;
      if (!(v > 0)) continue;
      const seg = len * v / total;
      if (seg >= 17) { const id = this.venueIds[i]; if (id) drawVenueMark(ctx, id, x + at + seg / 2 - 0.5, y + hgt / 2, Math.min(11, hgt - 2), this.#dpr); }
      at += seg;
    }
  }

  #timeLabel(s: number, short: boolean): string {
    const key = `${this.unit}|${short}|${this.#epoch}`;
    if (key !== this.#labelsKey || this.#labels.size > 512) { this.#labelsKey = key; this.#labels.clear(); }
    let label = this.#labels.get(s);
    if (label === undefined) {
      const text = this.unit >= 60 ? clock(s * 1000) : clockSeconds(s * 1000);
      label = short && this.unit < 60 ? text.slice(-5) : text;
      this.#labels.set(s, label);
    }
    return label;
  }
}

/** Everything a block's row shows, as a key: a settled block keeps it, so its row is shifted with the canvas instead of drawn again. */
function blockSig(b: Block, chosen: boolean): string {
  const tb = b.topBuy, ts = b.topSell;
  return `b|${b.s}|${b.B}|${b.forming ? 1 : 0}${chosen ? 1 : 0}${b.partial ? 1 : 0}|${b.buy}|${b.sell}|${b.refPx}|${b.refPrev}|${tb.has ? `${tb.usd}|${tb.id}` : '-'}|${ts.has ? `${ts.usd}|${ts.id}` : '-'}`;
}
/** Text cut with an ellipsis to fit `max` px (one measure per cut step: only short notes go through it). */
function fitText(ctx: CanvasRenderingContext2D, text: string, x: number, y: number, max: number): void {
  let s = text;
  while (s.length > 4 && ctx.measureText(s).width > max) s = `${s.slice(0, -2)}…`;
  ctx.fillText(s, x, y);
}
function mixHex(a: string, b: string, k: number): string {
  const pa = parseInt(a.slice(1), 16), pb = parseInt(b.slice(1), 16);
  const ch = (sh: number): number => Math.round(((pa >> sh) & 255) * (1 - k) + ((pb >> sh) & 255) * k);
  return `#${((ch(16) << 16) | (ch(8) << 8) | ch(0)).toString(16).padStart(6, '0')}`;
}
/** The late note's band: the panel with a touch of amber, readable in every theme. */
function mixLate(p: Palette): string { const band = mixHex(p.panel, '#f4b400', p.dark ? 0.14 : 0.18); return contrastRatio(p.text, band) >= 4.5 ? band : p.panel; }
