import { el } from '../dom.ts';
import { t } from '../i18n.ts';
import { clockSeconds, price as fmtPrice, usd as fmtUsd } from '../format.ts';
import { drawVenueMark } from '../venue-marks.ts';
import { venueLabel } from '../venues.ts';
import { instrumentShown, mapVenues } from '../cvd/ids.ts';
import { setText } from './lower-panes.ts';
import { scaledUsd, unscaledUsd } from '../coin.ts';
import { SIZE_MAX_USD } from '../sizes.ts';
import { selectRow, sizeRow, switchRow, togglePanel, type Panel } from '../ui.ts';
import { replaying } from '../replay/clock.ts';
import { isPhone } from '../device.ts';
import { paintInfoBox, type InfoLine } from '../infobox.ts';
import { PALETTES, contrastRatio, type Palette } from '../theme.ts';
import { pixelRatio, sharpens } from '../pixel-ratio.ts';
import { BOUNDARY, type TapeRing } from '../tape/ring.ts';
import { TradeIndex, readRecord, type TradeRecord } from '../trades/index.ts';
import { DIVIDER_ROW, InkCache, TIERS, amountText, clockForm, tierOf, tintOf, tintStops } from '../trades/style.ts';
import { GROUP_MS, TRADES_MINIMUMS, type TradesSettings } from '../trades/settings.ts';
import type { Store } from '../store.ts';

const MONO = 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace';
const PAD = 8, GAP = 6, MARK = 14;
/** Rows found beyond the visible ones (so a wheel step or a held list has them ready). */
const OVERSCAN = 40;
/** A new row slides in only when the batch adds this little (Sol: a fast conveyor of repeated slides reads worse than a plain update). */
const SLIDE_ROWS = 2, SLIDE_PX = 48, SLIDE_MS = 120;
/** A list out of sight longer than this (in writes) is found again from the newest rather than caught up order by order. */
const CATCH_UP_MAX = 50_000;
/**
 * The tint's top end, at the Leviathan size: chosen by eye on real orders in a dark and a light theme (2026-11-12), between Sol's quiet 22 %
 * and a near-solid fill: a rare order reads as an event, a screen of ordinary ones stays calm.
 */
export const TINT_TOP_DARK = 0.42, TINT_TOP_LIGHT = 0.34;
const reducedMotion = (): boolean => typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;

/** A line the last frame drew: an order (or a burst of them when grouping is on), or a divider where orders may be missing. */
type Drawn =
  | { kind: 'row'; k: number; y: number; h: number; rec: TradeRecord; orders: number; usd: number }
  | { kind: 'divider'; y: number; h: number; reasons: number };

/**
 * All trades, the flow column's third view: every market order the page receives (the tape ring's), newest on top, on one canvas. Size is
 * carried by row height, type and a log-scaled tint of the side's colour (`trades/style.ts`); every row says its side with ▲/▼ as well as
 * its colour. The list holds still under a mouse or once scrolled back (a button counts what arrived meanwhile), a row pointed at sets the
 * shared time cursor and a click takes the map there. Forward only: the orders are the ring's, from when it started, never fetched.
 */
export class TradesView {
  readonly root = el('div', { class: 'trades', hidden: true });
  #bar = el('div', { class: 'tns-bar trades-bar' });
  #floor = el('select', { class: 'tns-floor', ariaLabel: t('Smallest order') });
  #since = el('span', { class: 'tns-since' });
  #wrap = el('div', { class: 'trades-wrap' });
  #canvas = el('canvas', { class: 'trades-canvas', ariaLabel: t('All trades') });
  #ctx: CanvasRenderingContext2D;
  #pill = el('button', { type: 'button', class: 'tns-pill', hidden: true });
  #index = new TradeIndex();
  #inks = new InkCache();
  #palette: Palette = PALETTES.light!;
  #shown = false; #frame = 0;
  #w = 0; #h = 0; #dpr = 1;
  /** null: the list follows the newest order; else the row of write `k` is drawn `offset` px above the top (held, or scrolled back). */
  #anchor: { k: number; offset: number } | null = null;
  #pointerIn = false; #pointer: { x: number; y: number } | null = null;
  /** A finger on the list: where it last was, whether it moved (a drag scrolls, a still tap pins a row), and the row a tap pinned. */
  #touch: { id: number; y: number; moved: number; owed: number } | null = null;
  #pinned: number | null = null;
  /** The wheel moved the list back from the newest order: it stays held when the pointer leaves. */
  #scrolled = false;
  #slide: { px: number; start: number } | null = null;
  #drawn: Drawn[] = [];
  #scanTimer = 0;
  /** What the index was found for: the list's settings and the venues the map shows (a venue's book joining the map lets its orders in). */
  #filterKey = '';
  #resizeObserver: ResizeObserver;
  #panel: Panel | null = null;
  /** The last press was a finger (its click is the tap's, not a mouse click that takes the map to the order). */
  #lastTouch = false;
  /** The tape ring (set by the page: it exists once a view has asked for the tape). */
  ring: () => TapeRing | null = () => null;
  /** Take the map to an order (set by the page). */
  onGoTo: (at: number, price: number) => void = () => {};

  constructor(private store: Store) {
    this.#bar.append(this.#floor, this.#since);
    this.#wrap.append(this.#canvas);
    this.root.append(this.#bar, this.#wrap, this.#pill);
    this.#ctx = this.#canvas.getContext('2d', { alpha: false })!;
    this.#floor.onchange = () => { const v = Number(this.#floor.value); if (Number.isFinite(v) && v >= 0) this.#set({ minUsd: v === 0 ? 0 : unscaledUsd(v) }); };
    this.#pill.onclick = () => { this.#pointerIn = false; this.#release(); };
    this.#resizeObserver = new ResizeObserver(() => this.#resize()); this.#resizeObserver.observe(this.#wrap);
    sharpens({ resize: () => this.#resize(), paint: () => { if (this.#shown) this.#paint(); } });
    const c = this.#canvas;
    c.addEventListener('pointermove', e => {
      if (e.pointerType === 'touch') return;
      // A mouse is in use again (a hybrid device): its box offers the click once more.
      this.#lastTouch = false;
      this.#pointer = { x: e.offsetX, y: e.offsetY };
      // Held as soon as there is something to hold (the pointer may have come in before the first rows).
      this.#pointerIn = true; if (!this.#anchor) this.#hold();
      this.#hoverChanged(); this.invalidate();
    });
    // A finger "leaves" as it lifts: the hold and the pinned row are the pill's to end, not the lift's.
    c.addEventListener('pointerleave', e => { if (e.pointerType === 'touch') return; this.#pointerIn = false; this.#pointer = null; this.#hoverChanged(); if (!this.#scrolled) this.#release(); this.invalidate(); });
    // Ctrl + wheel is the browser's zoom, not the list's.
    c.addEventListener('wheel', e => { if (e.ctrlKey) return; e.preventDefault(); this.#scroll(e.deltaY * (e.deltaMode === 1 ? 24 : e.deltaMode === 2 ? this.#h : 1)); this.#hoverChanged(); }, { passive: false });
    c.addEventListener('click', e => { if (this.#lastTouch) return; const row = this.#rowAt(e.offsetY); if (row && !replaying() && !isPhone()) this.onGoTo(row.rec.t, row.rec.price); });
    // A finger drags the list (holding it), and a tap without a drag pins a row's details (a second tap on it, or elsewhere, lets them go).
    c.addEventListener('pointerdown', e => {
      this.#lastTouch = e.pointerType === 'touch';
      if (e.pointerType !== 'touch') return;
      this.#touch = { id: e.pointerId, y: e.clientY, moved: 0, owed: 0 }; c.setPointerCapture(e.pointerId);
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
      if (this.#pinned !== null && !this.#anchor) this.#hold();
      this.invalidate();
    };
    c.addEventListener('pointerup', lift); c.addEventListener('pointercancel', e => { if (this.#touch?.id === e.pointerId) this.#touch = null; });
    this.#syncFloor();
  }

  dispose(): void { window.clearTimeout(this.#scanTimer); this.#resizeObserver.disconnect(); if (this.#frame) cancelAnimationFrame(this.#frame); }

  setShown(shown: boolean): void {
    if (shown === this.#shown) return;
    this.#shown = shown; this.root.hidden = !shown;
    if (!shown) { window.clearTimeout(this.#scanTimer); this.#pointerIn = false; this.#pointer = null; this.#hoverChanged(); this.#panel?.close(); this.#release(false); this.#drawn = []; return; }
    this.#sync();
    this.#resize();
  }
  setPalette(p: Palette): void { this.#palette = p; this.invalidate(); }
  /** The list's settings, the venues or the sizes changed: found again from the newest order, from the top. */
  refresh(): void { this.#syncFloor(); this.#release(false); this.#drawn = []; this.#index.reset(null); this.#filterKey = ''; if (this.#shown) this.#sync(); }
  /** Something the rows are drawn with changed (the whale size, the time zone, a replay): drawn again as they stand. */
  redraw(): void { this.#syncFloor(); this.invalidate(); }

  /** A batch reached the ring: the list takes it (a slide for a row or two at the top, else a plain update), and a held one counts it. */
  tapeArrived(): void {
    if (!this.#shown) return;
    const ring = this.ring();
    if (!ring) return;
    if (this.#index.ring !== ring || this.#index.behind > CATCH_UP_MAX || this.#filterKeyNow() !== this.#filterKey) { this.#sync(); return; }
    const before = this.#index.length, newest = this.#index.newest, added = this.#index.update();
    if (this.#index.length === 0 && before === 0) { this.invalidate(); return; }
    if (this.#anchor) { this.#pill.hidden = this.#index.newSinceHold === 0; setText(this.#pill, t('Paused · {n} new ↑', { n: String(this.#index.newSinceHold) })); this.invalidate(); return; }
    // No slide with grouping on: an order joining the top row would move the list for nothing.
    if (added > 0 && added <= SLIDE_ROWS && !reducedMotion() && !document.hidden && newest >= 0 && !this.store.state.trades.group) {
      let px = 0;
      for (let i = this.#index.length - added; i < this.#index.length; i++) px += this.#heightOf(readRecord(ring, this.#index.at(i)));
      this.#slide = px <= SLIDE_PX ? { px: px + (this.#slide ? this.#remainingSlide() : 0), start: performance.now() } : null;
    } else this.#slide = null;
    this.invalidate();
  }

  invalidate(): void { if (!this.#frame && this.#shown) this.#frame = requestAnimationFrame(() => { this.#frame = 0; this.#paint(); }); }

  /** What the last frame drew, for the checks that look at the list without reading its pixels. */
  get snapshot(): { rows: number; dividers: number; held: boolean; waiting: number; indexed: number; anchored: boolean } {
    return { rows: this.#drawn.filter(d => d.kind === 'row').length, dividers: this.#drawn.filter(d => d.kind === 'divider').length, held: this.#index.held, waiting: this.#index.newSinceHold, indexed: this.#index.length, anchored: !!this.#anchor };
  }

  /** The settings panel (the column's settings key opens it in this view). */
  openSettings(anchor: HTMLElement): void {
    this.#panel = togglePanel(anchor, { title: t('All trades'), width: 360, align: 'left', onClose: () => { this.#panel = null; } }, (_tools, body) => this.#build(body));
  }
  #build(body: HTMLElement): void {
    const s = this.store.state.trades;
    body.append(
      sizeRow(t('Smallest order'), t('Orders under this are not listed. Any size lists every market order this page receives; the list keeps the orders of the last hours in memory, so a lower choice brings them back.'),
        { sign: '≥', value: s.minUsd === 0 ? 0 : scaledUsd(s.minUsd), presets: TRADES_MINIMUMS.map(scaledUsd), min: scaledUsd(TRADES_MINIMUMS[0]!), max: scaledUsd(SIZE_MAX_USD), none: t('Any size') },
        v => this.#set({ minUsd: v === 0 ? 0 : unscaledUsd(v) })),
      selectRow(t('Side'), t('Both sides, or only the market buys or only the market sells.'), [['both', t('Both')], ['buy', t('Buys only')], ['sell', t('Sells only')]], s.side, v => this.#set({ side: v === 'buy' || v === 'sell' ? v : 'both' })),
      switchRow(t('Group bursts'), t('Orders of one market and side in the same tenth of a second are one row, their sizes added up and their price weighted by size; ×5 says how many orders.'), s.group, group => this.#set({ group })),
    );
  }
  #set(change: Partial<TradesSettings>): void { this.store.set({ trades: { ...this.store.state.trades, ...change } }); }

  #syncFloor(): void {
    const s = this.store.state.trades, chosen = s.minUsd === 0 ? 0 : scaledUsd(s.minUsd), sizes = [0, ...TRADES_MINIMUMS.map(scaledUsd)];
    if (!sizes.some(v => Math.abs(v - chosen) <= 1e-6 * Math.max(1, chosen))) sizes.push(chosen);
    sizes.sort((a, b) => a - b);
    const key = sizes.join(',');
    if (this.#floor.dataset.sizes !== key) {
      this.#floor.dataset.sizes = key;
      this.#floor.replaceChildren(...sizes.map(v => new Option(v === 0 ? t('Any size') : `≥ $${fmtUsd(v)}`, String(v))));
    }
    this.#floor.value = String(sizes.find(v => Math.abs(v - chosen) <= 1e-6 * Math.max(1, chosen)) ?? chosen);
  }

  /** The index on the current ring and filter, found back from the newest order enough to fill the list (more in steps, between frames). */
  #sync(): void {
    const ring = this.ring(), s = this.store.state.trades, key = this.#filterKeyNow();
    // Another ring or venues, nothing found yet, a newest write the ring wrapped past, or out of sight so long that finding back is cheaper than catching up.
    if (this.#index.ring !== ring || key !== this.#filterKey || this.#index.length === 0 || (ring && !this.#index.valid(this.#index.newest)) || this.#index.behind > CATCH_UP_MAX) {
      this.#filterKey = key;
      // Found again from the newest: a hold, a pinned row and a count of what came meanwhile belonged to the rows it had.
      this.#release(false); this.#drawn = [];
      this.#index.reset(ring, { minUsd: s.minUsd === 0 ? 0 : scaledUsd(s.minUsd), side: s.side, shown: instrumentShown(this.store.state) });
      this.#anchor = null; this.#slide = null;
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
  /** Find older matches until the list and its overscan are full, a step per task so a high floor never blocks a frame. */
  #fillBack(): void {
    window.clearTimeout(this.#scanTimer);
    // Enough found below the top row drawn: the visible rows at the smallest height, and some more.
    const want = Math.ceil(this.#h / TIERS[0]!.row) + OVERSCAN;
    const have = (): number => (this.#anchor ? this.#index.position(this.#anchor.k) : this.#index.length - 1) + 1;
    if (have() >= want || !this.#index.moreBehind) return;
    this.#index.scanBack(want - have());
    this.invalidate();
    if (have() < want && this.#index.moreBehind) this.#scanTimer = window.setTimeout(() => this.#fillBack(), 0);
  }

  #resize(): void {
    const r = this.#wrap.getBoundingClientRect(), dpr = pixelRatio();
    const w = Math.max(0, Math.floor(r.width)), h = Math.max(0, Math.floor(r.height));
    if (w === this.#w && h === this.#h && dpr === this.#dpr) { this.invalidate(); return; }
    this.#w = w; this.#h = h; this.#dpr = dpr;
    this.#canvas.width = Math.max(1, Math.round(w * dpr)); this.#canvas.height = Math.max(1, Math.round(h * dpr));
    this.#canvas.style.width = `${w}px`; this.#canvas.style.height = `${h}px`;
    if (this.#shown) this.#fillBack();
    this.invalidate();
  }

  #whale(): { whale: number; leviathan: number } {
    const tiers = this.store.state.sounds.tiers;
    return { whale: scaledUsd(tiers.find(x => x.id === 'whale')?.usd ?? 400_000), leviathan: scaledUsd(tiers.find(x => x.id === 'leviathan')?.usd ?? 1_500_000) };
  }
  #heightOf(rec: TradeRecord): number { return TIERS[tierOf(rec.usd, scaledUsd, this.#whale().whale)]!.row; }
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
  /** The newest position of the row holding `pos` (grouping gathers newer orders of the same slice above it). */
  #unitTop(pos: number): number {
    if (!this.store.state.trades.group) return pos;
    const ring = this.#index.ring!, rec = readRecord(ring, this.#index.at(pos));
    while (pos + 1 < this.#index.length && this.#together(rec, readRecord(ring, this.#index.at(pos + 1)))) pos++;
    return pos;
  }

  #remainingSlide(): number {
    const s = this.#slide;
    if (!s) return 0;
    const k = Math.min(1, (performance.now() - s.start) / SLIDE_MS), ease = 1 - (1 - k) ** 3;
    return s.px * (1 - ease);
  }

  #hold(): void {
    if (this.#anchor || !this.#index.length) return;
    // Held where it stands: the row at the top (as the last frame drew it) stays there while new orders are counted.
    const top = this.#drawn.find(d => d.kind === 'row');
    if (!top || top.kind !== 'row') return;
    this.#slide = null;
    this.#anchor = { k: top.k, offset: -top.y };
    this.#index.hold();
  }
  #release(draw = true): void {
    if (!this.#anchor && !this.#index.held) return;
    this.#anchor = null; this.#index.release(); this.#pill.hidden = true; this.#slide = null; this.#scrolled = false; this.#pinned = null;
    if (draw) this.invalidate();
  }
  /** The wheel moves the held top row by `dy` px (down: older orders); back at the newest with no mouse on it, the list follows again. */
  #scroll(dy: number): void {
    if (!this.#index.length) return;
    if (!this.#anchor) { this.#hold(); if (!this.#anchor) return; }
    // Row by row (a grouped row is one step); the offset keeps its fractions (a trackpad's small steps add up) and is rounded where it is drawn.
    let pos = this.#unitTop(this.#index.position(this.#anchor.k)), offset = this.#anchor.offset + dy;
    for (let u = this.#unit(pos); offset >= u.h && pos - u.count >= 0; u = this.#unit(pos)) { offset -= u.h; pos -= u.count; }
    while (offset < 0 && pos < this.#index.length - 1) { pos = this.#unitTop(pos + 1); offset += this.#unit(pos).h; }
    // The oldest row found, with nothing older to find: it stays at the top rather than scrolling off into nothing.
    if (!this.#index.moreBehind && pos - this.#unit(pos).count < 0) offset = Math.min(offset, 0);
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

  #paint(): void {
    const ctx = this.#ctx, w = this.#w, h = this.#h, p = this.#palette, dpr = this.#dpr;
    if (!this.#shown || w < 40 || h < 20) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = p.panel; ctx.fillRect(0, 0, w, h);
    const ring = this.#index.ring, replay = replaying();
    const heldFrom = ring && ring.written ? readRecord(ring, ring.first).t : null;
    setText(this.#since, heldFrom === null ? '' : replay ? t('Not the replay: live orders since {time}', { time: clockSeconds(heldFrom) }) : t('Since {time}', { time: clockSeconds(heldFrom) }));
    this.root.classList.toggle('replaying', replay);
    const drawn: Drawn[] = [];
    this.#drawn = drawn;
    if (!ring || !this.#index.length) {
      ctx.fillStyle = p.muted; ctx.font = `12px ${MONO}`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText(t('Waiting for live orders'), w / 2, Math.min(h / 2, 60));
      return;
    }
    // The anchor fell behind the ring's oldest order: the list says so and stands at the oldest it holds.
    let pos = this.#unitTop(this.#index.length - 1), y = 0, expired = false;
    if (this.#anchor) {
      if (!this.#index.valid(this.#anchor.k)) { expired = true; this.#anchor = { k: this.#index.at(0), offset: 0 }; }
      pos = this.#unitTop(this.#index.position(this.#anchor.k)); y = -Math.round(this.#anchor.offset);
    } else if (this.#slide) {
      const left = this.#remainingSlide();
      if (left <= 0.5) this.#slide = null; else y = -left;
    }
    const { whale, leviathan } = this.#whale(), s = this.store.state.trades;
    const top = p.dark ? TINT_TOP_DARK : TINT_TOP_LIGHT, stops = tintStops(scaledUsd, whale, leviathan, top), form = clockForm(w);
    ctx.textBaseline = 'middle';
    ctx.font = `11px ${MONO}`;
    const clockW = form === 'none' ? 0 : ctx.measureText(form === 'hms' ? '00:00:00' : '00:00').width;
    const xMark = PAD + (clockW ? clockW + GAP : 0) + MARK / 2, xSide = xMark + MARK / 2 + GAP, xPrice = xSide + 10 + GAP, xRight = w - PAD;
    let lastSecond = '', above = -1;
    while (pos >= 0 && y < h) {
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
        if (reasons) { this.#paintDivider(ctx, y, w, reasons, p); drawn.push({ kind: 'divider', y, h: DIVIDER_ROW, reasons }); y += DIVIDER_ROW; if (y >= h) break; }
      }
      const buy = rec.usd > 0, signed = buy ? usd : -usd, tier = TIERS[tierOf(signed, scaledUsd, whale)]!, rowH = tier.row;
      const shown = orders > 1 ? { ...rec, usd: signed, price: usd / qty, lo, hi } : rec;
      const ink = this.#inks.get(p, buy, tintOf(signed, stops), top);
      ctx.fillStyle = ink.bg; ctx.fillRect(0, y, w, rowH);
      const mid = y + rowH / 2;
      // The time once per second-run, and always on the first row drawn.
      const second = clockSeconds(rec.t);
      if (clockW && (second !== lastSecond || drawn.every(d => d.kind !== 'row'))) {
        ctx.font = `11px ${MONO}`; ctx.fillStyle = ink.muted; ctx.textAlign = 'left';
        ctx.fillText(form === 'hms' ? second : second.slice(3), PAD, mid);
      }
      lastSecond = second;
      drawVenueMark(ctx, rec.id, xMark, mid, MARK);
      // The side's glyph in its colour where that reads on the row; on a strong tint of its own colour, in the row's text colour.
      const sideInk = buy ? p.candleUp : p.candleDown;
      ctx.font = `10px ${MONO}`; ctx.fillStyle = contrastRatio(sideInk, ink.bg) >= 3 ? sideInk : ink.text; ctx.textAlign = 'left';
      ctx.fillText(buy ? '▲' : '▼', xSide, mid);
      ctx.font = `13px ${MONO}`; ctx.fillStyle = ink.text;
      ctx.fillText(fmtPrice(shown.price), xPrice, mid);
      ctx.textAlign = 'right';
      ctx.font = `${tier.weight} ${tier.amountPx}px ${MONO}`;
      const amount = amountText(usd);
      ctx.fillText(amount, xRight, mid);
      if (orders > 1) { const aw = ctx.measureText(amount).width; ctx.font = `11px ${MONO}`; ctx.fillStyle = ink.muted; ctx.fillText(`×${orders}`, xRight - aw - GAP, mid); }
      drawn.push({ kind: 'row', k, y, h: rowH, rec: shown, orders, usd: signed });
      above = lowest; y += rowH; pos = next;
    }
    // The row under the pointer (or the one a finger pinned), and its whole story in a box beside it.
    const pinned = this.#pinned !== null ? drawn.find((d): d is Extract<Drawn, { kind: 'row' }> => d.kind === 'row' && d.k === this.#pinned) ?? null : null;
    const hover = pinned ?? (this.#pointer ? this.#rowAt(this.#pointer.y) : null);
    if (hover) {
      ctx.strokeStyle = p.text; ctx.globalAlpha = 0.35; ctx.lineWidth = 1; ctx.strokeRect(0.5, hover.y + 0.5, w - 1, hover.h - 1); ctx.globalAlpha = 1;
      // Down from the pointer in the upper half, up from it in the lower, so the box stays inside the list (a pinned row: from its middle).
      const pt = pinned ? { x: w / 2, y: hover.y + hover.h / 2 } : this.#pointer!;
      paintInfoBox(ctx, this.#lines(hover), pt.x, pt.y, { x0: 0, y0: 0, x1: w, y1: h }, p, { placement: pt.y < h / 2 ? 'down' : 'up', edge: hover.usd > 0 ? p.candleUp : p.candleDown });
    }
    if (expired) {
      ctx.fillStyle = p.panel; ctx.fillRect(0, 0, w, DIVIDER_ROW); this.#paintNote(ctx, 0, w, t('Older orders have left memory'), p);
    }
    // A pointer resting on the list when its first rows were drawn holds them now; the shared time cursor follows the row it is on now.
    if (this.#pointerIn && !this.#anchor) this.#hold();
    if (this.#pointer) this.#hoverChanged();
    if (this.#slide || (pos < OVERSCAN && this.#index.moreBehind)) {
      if (this.#slide) this.invalidate();
      if (pos < OVERSCAN && this.#index.moreBehind) this.#fillBack();
    }
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
    // Only where a click does it: not on a phone (the map is another tab), not for a finger (a tap pins the row), not in a replay.
    if (!replaying() && !isPhone() && !this.#lastTouch) lines.push({ text: t('Click to show it on the map'), color: 'muted' });
    return lines;
  }

  #paintDivider(ctx: CanvasRenderingContext2D, y: number, w: number, reasons: number, p: Palette): void {
    // A start is never between two rows (it is before the first write): only a reconnect, a skip or a trim draws a line.
    const words = reasons & (BOUNDARY.reconnect | BOUNDARY.cleared) ? t('The stream reconnected here: orders may be missing.')
      : reasons & BOUNDARY.skipped ? t('The source skipped orders here: some may be missing.')
      : t('The source left out its smallest orders here.');
    ctx.fillStyle = p.panel; ctx.fillRect(0, y, w, DIVIDER_ROW);
    this.#paintNote(ctx, y, w, words, p);
  }
  #paintNote(ctx: CanvasRenderingContext2D, y: number, w: number, words: string, p: Palette): void {
    ctx.strokeStyle = p.line; ctx.setLineDash([3, 3]); ctx.beginPath(); ctx.moveTo(PAD, y + DIVIDER_ROW - 0.5); ctx.lineTo(w - PAD, y + DIVIDER_ROW - 0.5); ctx.stroke(); ctx.setLineDash([]);
    ctx.font = `italic 11px ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif`; ctx.fillStyle = p.muted; ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
    let text = words;
    while (text.length > 4 && ctx.measureText(text).width > w - 2 * PAD) text = `${text.slice(0, -2)}…`;
    ctx.fillText(text, PAD, y + DIVIDER_ROW / 2);
  }
}
