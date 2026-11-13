import { el } from '../dom.ts';
import { t } from '../i18n.ts';
import { clock, clockSeconds } from '../format.ts';
import { fmtUsd } from './trades-inspector.ts';
import { drawVenueMark } from '../venue-marks.ts';
import { replaying } from '../replay/clock.ts';
import { isPhone } from '../device.ts';
import { contrastRatio, type Palette, PALETTES } from '../theme.ts';
import { pixelRatio, sharpens } from '../pixel-ratio.ts';
import { scaledUsd } from '../coin.ts';
import { BlockReader, barLength, emptyBlock, fullScale, type Block } from '../trades/blocks.ts';

const MONO = 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace';
const SANS = 'ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif';
const PAD = 8;
/** A block's row, a folded run of empty blocks, a line where a source ends or a venue is late. */
const ROW = 48, ROW_PHONE = 56, QUIET = 24, NOTE = 22;
/** The list's width beside the inspector, and the narrowest inspector worth opening (Sol and Astra, round 2: 367 + 16 + inspector). */
export const LIST_W = 367, INSPECTOR_MIN = 240;
export const wideEnough = (w: number): boolean => w >= LIST_W + 16 + INSPECTOR_MIN;

/** What one frame drew, for the pointer and the checks. */
type Drawn = { kind: 'block'; s: number; y: number; h: number } | { kind: 'quiet'; s: number; e: number; y: number; h: number } | { kind: 'note'; y: number; h: number };

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
      if (!replaying() && !isPhone()) { const b = this.#read(row.s, this.#pool[0] ??= emptyBlock(this.reader.venues)); const p = Number.isFinite(b.refPx) ? b.refPx : NaN; this.onGoTo(row.s * 1000, (row.s + this.unit) * 1000, p, p); }
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
    this.#resize();
  }
  setPalette(p: Palette): void { this.#palette = p; this.invalidate(); }
  invalidate(): void { if (!this.#frame && this.#shown) this.#frame = requestAnimationFrame(() => { this.#frame = 0; this.#paint(); }); }
  /** What the last frame drew, for the checks. */
  get snapshot(): { blocks: number; quiet: number; notes: number; held: boolean; top: number | null } {
    return { blocks: this.#drawn.filter(d => d.kind === 'block').length, quiet: this.#drawn.filter(d => d.kind === 'quiet').length, notes: this.#drawn.filter(d => d.kind === 'note').length, held: this.held, top: this.#anchor?.s ?? null };
  }

  #rowH(): number { return isPhone() ? ROW_PHONE : ROW; }
  /** The newest block's start (seconds). */
  newestStart(): number { const now = this.now(); return Math.floor(Math.floor(now / 1000) / this.unit) * this.unit; }
  #read(s: number, out: Block): Block { return this.reader.read(s, this.unit, out, this.now()); }
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
  /** The wheel moves the list by `dy` px (down: older blocks); back at the newest with no mouse on it, the list follows again. */
  #scroll(dy: number): void {
    if (!this.#anchor) { this.#hold(); if (!this.#anchor) return; }
    const h = this.#rowH(), newest = this.newestStart(), oldest = this.reader.oldestSec();
    // The list ends at the oldest second a source knows or at the first block nothing is known of, whichever comes first (`#paint`).
    const known = (sec: number): boolean => sec >= oldest && !this.#read(sec, this.#pool[0] ??= emptyBlock(this.reader.venues)).unknown;
    let s = this.#anchor.s, offset = this.#anchor.offset + dy;
    while (offset >= h && known(s - this.unit)) { offset -= h; s -= this.unit; }
    while (offset < 0 && s + this.unit <= newest) { s += this.unit; offset += h; }
    if (!known(s - this.unit)) offset = Math.min(offset, 0);
    if (s >= newest && Math.round(offset) <= 0) {
      if (!this.#pointerIn && this.selected === null) { this.release(); return; }
      offset = 0;
    }
    this.#anchor = { s, offset: Math.max(0, offset) };
    this.#scrolled = s < newest || Math.round(offset) > 0;
    this.invalidate();
  }
  #rowAt(y: number): Drawn | null { for (const d of this.#drawn) if (y >= d.y && y < d.y + d.h) return d; return null; }
  #hover(): void {
    const row = this.#pointer && !replaying() ? this.#rowAt(this.#pointer.y) : null;
    if (!row || row.kind !== 'block') { this.onHover(null); return; }
    this.onHover(this.#read(row.s, this.#pool[0] ??= emptyBlock(this.reader.venues)));
  }

  #resize(): void {
    const r = this.root.getBoundingClientRect(), dpr = pixelRatio();
    const w = Math.max(0, Math.floor(r.width)), h = Math.max(0, Math.floor(r.height));
    if (w === this.#w && h === this.#h && dpr === this.#dpr) { this.invalidate(); return; }
    this.#w = w; this.#h = h; this.#dpr = dpr;
    this.#canvas.width = Math.max(1, Math.round(w * dpr)); this.#canvas.height = Math.max(1, Math.round(h * dpr));
    this.#canvas.style.width = `${w}px`; this.#canvas.style.height = `${h}px`;
    this.invalidate();
  }

  // ---- drawing --------------------------------------------------------------------------------------------------------------------

  #paint(): void {
    const ctx = this.#ctx, w = this.#w, h = this.#h, p = this.#palette, dpr = this.#dpr;
    if (!this.#shown || w < 40 || h < 20) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = p.panel; ctx.fillRect(0, 0, w, h);
    const drawn: Drawn[] = []; this.#drawn = drawn;
    const phone = isPhone(), rowH = this.#rowH(), c = blockColumns(w, phone), B = this.unit;
    const full = scaledUsd(fullScale(B)), barW = c.bars - 10;
    const newest = this.newestStart(), oldest = this.reader.oldestSec();
    // The newest settled block moved on: the inspector follows it (once a block, not every frame).
    const settled = newest - B;
    if (settled !== this.#lastNewest) { this.#lastNewest = settled; if (this.selected === null) this.onInspect(); }
    let y = 0;
    if (this.late.length) {
      ctx.fillStyle = mixLate(p); ctx.fillRect(0, 0, w, NOTE); ctx.fillStyle = p.line; ctx.fillRect(0, NOTE - 1, w, 1);
      ctx.font = `11px ${SANS}`; ctx.fillStyle = p.text; ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
      fitText(ctx, w < 300 ? t('{venues} delayed', { venues: this.late.join(', ') }) : t('{venues} delayed: the last minute may still grow', { venues: this.late.join(', ') }), PAD, NOTE / 2, w - 2 * PAD);
      drawn.push({ kind: 'note', y: 0, h: NOTE }); y = NOTE;
    }
    let s = this.#anchor ? this.#anchor.s : newest;
    const top = s;
    y -= this.#anchor ? Math.round(this.#anchor.offset) : 0;
    let poolAt = 0;
    const take = (): Block => { while (this.#pool.length <= poolAt) this.#pool.push(emptyBlock(this.reader.venues)); const b = this.#pool[poolAt++]!; if (b.vBuy.length !== this.reader.venues) { b.vBuy = new Float64Array(this.reader.venues); b.vSell = new Float64Array(this.reader.venues); } return b; };
    if (!Number.isFinite(oldest) && !this.#anchor) {
      ctx.fillStyle = p.muted; ctx.font = `12px ${SANS}`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText(t('Waiting for live orders'), w / 2, Math.min(h / 2, 60));
      return;
    }
    // Every block that ends after the oldest second a source knows (the oldest of them partly before it, said by its dashed foot), up to
    // the first block nothing is known of: a market's stray older second (a feed's last trade, sent on connecting) does not make the
    // stretch between known, and the list ends there.
    let end = NaN;
    while (y < h && s + B > oldest) {
      const b = this.#read(s, take());
      if (b.unknown) { end = s + B; break; }
      // A run of blocks nobody recorded (the stretch between the history's end and the page's own start, at every opening) is one line.
      if (b.unrecorded) {
        let e = s;
        while (e - B >= oldest) { const q = this.#read(e - B, take()); poolAt--; if (!q.unrecorded) break; e -= B; }
        this.#paintQuiet(ctx, y, w, e, s + B, p, true);
        drawn.push({ kind: 'quiet', s, e, y, h: QUIET }); y += QUIET; s = e - B; continue;
      }
      // An empty block, or a run of them, is one short line (a quiet coin at a second would otherwise be a column of zeros).
      if (b.buy === 0 && b.sell === 0 && !b.forming && !b.partial) {
        let e = s, count = 1;
        while (e - B >= oldest && count < 3600) { const q = this.#read(e - B, take()); poolAt--; if (q.unknown || q.buy !== 0 || q.sell !== 0 || q.partial) break; e -= B; count++; }
        this.#paintQuiet(ctx, y, w, e, s + B, p);
        drawn.push({ kind: 'quiet', s, e, y, h: QUIET }); y += QUIET; s = e - B; continue;
      }
      this.#paintBlock(ctx, b, y, rowH, w, c, full, barW, p);
      drawn.push({ kind: 'block', s, y, h: rowH }); y += rowH; s -= B;
    }
    if (s < top) { const key = `${s + B}|${top + B}`; if (key !== this.#drawnKey) { this.#drawnKey = key; this.onDrawn(s + B, top + B); } }
    // Where the list ends: the size's history starts there (or the sources do).
    if (y < h && (s + B <= oldest || Number.isFinite(end))) {
      const words = this.endNote(Number.isFinite(end) ? end : oldest);
      if (words) { this.#paintEnd(ctx, y, w, words, p); drawn.push({ kind: 'note', y, h: NOTE }); }
    }
  }

  #paintQuiet(ctx: CanvasRenderingContext2D, y: number, w: number, from: number, to: number, p: Palette, unrecorded = false): void {
    ctx.fillStyle = p.panel; ctx.fillRect(0, y, w, QUIET);
    ctx.fillStyle = p.line; ctx.fillRect(0, y + QUIET - 1, w, 1);
    ctx.font = `11px ${MONO}`; ctx.fillStyle = p.muted; ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
    const fmt = (sec: number): string => this.unit >= 60 ? clock(sec * 1000) : clockSeconds(sec * 1000);
    fitText(ctx, unrecorded ? t('Not recorded {from}–{to}', { from: fmt(from), to: fmt(to) }) : t('No orders {from}–{to}', { from: fmt(from), to: fmt(to) }), PAD, y + QUIET / 2, w - 2 * PAD);
  }
  #paintEnd(ctx: CanvasRenderingContext2D, y: number, w: number, words: string, p: Palette): void {
    ctx.strokeStyle = p.line; ctx.setLineDash([3, 3]); ctx.beginPath(); ctx.moveTo(PAD, y + 0.5); ctx.lineTo(w - PAD, y + 0.5); ctx.stroke(); ctx.setLineDash([]);
    ctx.font = `italic 11px ${SANS}`; ctx.fillStyle = p.muted; ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
    fitText(ctx, words, PAD, y + NOTE / 2 + 1, w - 2 * PAD);
  }

  #paintBlock(ctx: CanvasRenderingContext2D, b: Block, y: number, h: number, w: number, c: ReturnType<typeof blockColumns>, full: number, barW: number, p: Palette): void {
    const chosen = this.selected === b.s, phone = h === ROW_PHONE;
    ctx.fillStyle = chosen ? mixHex(p.panel, p.ui ?? p.text, 0.12) : p.panel; ctx.fillRect(0, y, w, h);
    ctx.fillStyle = p.line; ctx.fillRect(0, y + h - 1, w, 1);
    if (chosen) { ctx.strokeStyle = p.ui ?? p.text; ctx.lineWidth = 1.5; ctx.strokeRect(1, y + 1, w - 2, h - 2); }
    const l1 = Math.round(y + h * 0.31), l2 = Math.round(y + h * 0.71);
    ctx.textBaseline = 'middle'; ctx.textAlign = 'left';
    // The time (the forming block in full ink, with a dot), and under it the reference market's VWAP change.
    ctx.font = `${phone ? 12 : 11}px ${MONO}`; ctx.fillStyle = b.forming ? p.text : p.muted;
    const time = this.#timeLabel(b.s, c.t < 60);
    ctx.fillText(time, PAD, l1);
    if (b.forming) { ctx.fillStyle = p.ui ?? p.text; ctx.beginPath(); ctx.arc(PAD + ctx.measureText(time).width + 5, l1, 2.5, 0, Math.PI * 2); ctx.fill(); }
    const d = Number.isFinite(b.refPx) && Number.isFinite(b.refPrev) ? b.refPx - b.refPrev : NaN, dp = this.unit >= 60 ? 0 : 1;
    ctx.font = `600 ${phone ? 12.5 : 11.5}px ${MONO}`;
    if (Number.isFinite(d)) { const r = Number(Math.abs(d).toFixed(dp)); ctx.fillStyle = r === 0 ? p.muted : d > 0 ? p.candleUp : p.candleDown; ctx.fillText(r === 0 ? (0).toFixed(dp) : `${d > 0 ? '+' : '−'}${r.toFixed(dp)}`, PAD, l2); }
    else { ctx.fillStyle = p.muted; ctx.fillText('–', PAD, l2); }
    const xAmt = PAD + c.t, xBars = xAmt + c.amt, xBig = xBars + c.bars + 6;
    for (const [line, side] of [[l1, 0], [l2, 1]] as const) {
      const buy = side === 0, v = buy ? b.buy : b.sell, col = buy ? p.candleUp : p.candleDown;
      ctx.font = `600 ${phone ? 14 : 13}px ${MONO}`; ctx.fillStyle = col; ctx.textAlign = 'right';
      ctx.fillText(`${buy ? '▲' : '▼'} $${fmtUsd(v)}`, xBars - 7, line);
      ctx.fillStyle = p.line; ctx.fillRect(xBars, line - 7, 1, 14);
      const len = barLength(v, full, barW);
      if (len > 0) this.#pieces(ctx, xBars + 1, line - 6, 12, len, buy ? b.vBuy : b.vSell, v, col);
      if (v > full) { ctx.fillStyle = col; ctx.font = `700 12px ${MONO}`; ctx.textAlign = 'left'; ctx.fillText('›', xBars + barW + 3, line); }
      if (c.big) {
        const o = buy ? b.topBuy : b.topSell;
        if (o.has) {
          drawVenueMark(ctx, o.id, xBig + 7, line, phone ? 14 : 13);
          ctx.font = `${o.usd >= this.whale ? 700 : 600} ${phone ? 13 : 12}px ${MONO}`; ctx.fillStyle = p.text; ctx.textAlign = 'left';
          ctx.fillText(`$${fmtUsd(o.usd)}`, xBig + 18, line);
        } else { ctx.font = `11px ${MONO}`; ctx.fillStyle = p.muted; ctx.textAlign = 'left'; ctx.fillText('–', xBig + 4, line); }
      }
    }
    if (b.partial) { ctx.strokeStyle = p.muted; ctx.setLineDash([2, 3]); ctx.beginPath(); ctx.moveTo(0, y + h - 0.5); ctx.lineTo(w, y + h - 0.5); ctx.stroke(); ctx.setLineDash([]); }
  }

  /** A side's bar: the venues' pieces in slot order, each in proportion to its share of the side, a venue's mark inside its piece where it fits. */
  #pieces(ctx: CanvasRenderingContext2D, x: number, y: number, hgt: number, len: number, parts: Float64Array, total: number, col: string): void {
    ctx.fillStyle = col; ctx.globalAlpha = 0.85;
    let at = 0;
    const marks: [number, number][] = [];
    for (let i = 0; i < parts.length; i++) {
      const v = parts[i]!;
      if (!(v > 0) || !(total > 0)) continue;
      const seg = len * v / total;
      if (seg >= 0.6) ctx.fillRect(x + at, y, Math.max(0.6, seg - (seg > 3 ? 1 : 0)), hgt);
      if (seg >= 17) marks.push([i, x + at + seg / 2 - 0.5]);
      at += seg;
    }
    if (len >= 1 && at < 0.6) ctx.fillRect(x, y, 1, hgt);
    ctx.globalAlpha = 1;
    for (const [i, cx] of marks) { const id = this.venueIds[i]; if (id) drawVenueMark(ctx, id, cx, y + hgt / 2, Math.min(11, hgt - 2)); }
  }

  #timeLabel(s: number, short: boolean): string {
    const text = this.unit >= 60 ? clock(s * 1000) : clockSeconds(s * 1000);
    return short && this.unit < 60 ? text.slice(-5) : text;
  }
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
