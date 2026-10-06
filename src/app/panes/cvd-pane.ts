import { PALETTES, type Palette } from '../theme.ts';
import { el } from '../dom.ts';
import { helpButton } from '../help.ts';
import { clock, price as fmtPrice } from '../format.ts';
import { paintInfoBox, type InfoLine } from '../infobox.ts';
import { emptyScopeMessage, kindOf } from '../scope.ts';
import { flowIds, pinChoices, priceFlowId } from '../cvd/ids.ts';
import { flowWindow } from '../cvd/window.ts';
import { MAX_PINNED } from '../cvd/settings.ts';
import { venueLabel } from '../venues.ts';
import { selectRow, switchRow, numberRow, togglePanel, note, heading } from '../ui.ts';
import type { Store } from '../store.ts';
import type { Hub } from '../hub.ts';
import type { View } from '../view.ts';
import { Ranker } from '../cvd/rank.ts';
import { buildModel, type CvdModel, type LaneLine } from '../cvd/model.ts';
import { HEIGHT_MODES, locateRow, maxScroll, rowHeights, type RowLayout } from '../cvd/layout.ts';
import { CVD_SPANS, CVD_SPAN_MS, RANK_MS, RANK_WINDOWS, type CvdSettings, type CvdSpan, type RankWindow } from '../cvd/settings.ts';
import { aggregateHover, aggregateLabel, rowHover, rowLabel, windowName, type LabelLine } from '../cvd/text.ts';
import { laneColors, type LaneColors } from '../cvd/colors.ts';
import { PriceTrack, type PriceColumns } from '../cvd/price.ts';
import type { BurstEvent } from '../cvd/burst.ts';
import { panelSwitchRow } from '../sound/panel.ts';
import { t } from '../i18n.ts';

const SANS = 'ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif', MONO = 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace';
const PAD = 6, LINE_H = 12;
/** The label column: a third of the pane, within these limits. */
const GUTTER_MIN = 76, GUTTER_MAX = 120;
const MIN_ROW = 56, MIN_AGG = 92, PRICE_H = 44;
/** Flow history reaches back no further than the recorder keeps it. */
const HISTORY_CAP_MS = 24 * 3_600_000;
const SPAN_LABELS: Record<CvdSpan, string> = { map: t('Map'), '5m': '5m', '15m': '15m', '1h': '1h', '4h': '4h', '24h': '24h' };

/** What the last frame drew, for the checks that look at the pane without reading its pixels. */
export interface CvdSnapshot { rows: string[]; scroll: number; maxScroll: number; heights: { agg: number; price: number; rows: number[] }; spanMs: number; columns: number; empty: string | null; gutter: number;
  /** Where the price strip's price comes from (an instrument's recorded seconds, or null for candle closes), how many of its columns are filled and how many different prices they hold, and when the flow began if the window reaches before it. */
  price: { id: string | null; filled: number; distinct: number }; since: number | null }

const fit = (ctx: CanvasRenderingContext2D, text: string, width: number): string => {
  if (ctx.measureText(text).width <= width) return text;
  let end = text.length; while (end > 1 && ctx.measureText(`${text.slice(0, end)}…`).width > width) end--;
  return `${text.slice(0, end)}…`;
};

/**
 * The taker-flow column left of the map: the cumulative volume delta (buys at market minus sells at market) of every exchange, spot and
 * perpetual, as aggr.trade draws it, with the exchanges ranked by volume and the labels on the left so nothing sits on the ends of the
 * lines. The numbers come from `cvd/model.ts` and the words from `cvd/text.ts`; this class is the canvas, the pointer and the controls.
 */
export class CvdPane {
  readonly root = el('section', { class: 'pane cvd' });
  readonly controls = el('div', { class: 'pane-head' });
  #wrap = el('div', { class: 'cvd-wrap' });
  #canvas = document.createElement('canvas');
  #ctx: CanvasRenderingContext2D;
  #w = 0; #h = 0; #dpr = 1; #frame = 0;
  #palette: Palette = PALETTES.light!;
  #ranker = new Ranker();
  #price = new PriceTrack();
  #priceFor = ''; #priceAt = 0; #priceLoading = false;
  /** The price strip's columns and the instrument whose recorded seconds gave them (null: candle closes and marks), as the last model was built. */
  #priceCols: PriceColumns | null = null; #priceId: string | null = null;
  /** When the flow began, if the window starts before it (shown as a note on the aggregate row). */
  #since: number | null = null;
  #model: CvdModel | null = null; #modelKey = '';
  #layout: RowLayout | null = null;
  #scroll = 0;
  #hover: { x: number; y: number } | null = null;
  #gutter = GUTTER_MIN;
  /** The window the last frame drew, for `followMap`. */
  #drawn: { t0: number; t1: number } | null = null;
  #empty: string | null = null;
  #spanButtons = new Map<CvdSpan, HTMLButtonElement>();
  #spanSelect = el('select', { class: 'cvd-span-select', ariaLabel: t('Time span') });
  #gear = el('button', { type: 'button', class: 'icon-btn cvd-gear', ariaLabel: t('Settings'), tip: t('How the column ranks and draws the exchanges.') });
  /** Bursts the alert engine has seen, drawn as markers on their rows (set from outside; newest last). */
  events: readonly BurstEvent[] = [];
  #timer = 0;

  constructor(host: HTMLElement, private store: Store, private hub: Hub, private view: View) {
    this.root.append(this.controls, this.#wrap);
    this.#wrap.append(this.#canvas);
    host.append(this.root);
    this.#ctx = this.#canvas.getContext('2d')!;
    new ResizeObserver(() => this.#resize()).observe(this.#wrap);
    this.#buildControls();
    this.#bindInput();
    // The window moves on by itself (and a venue can go quiet without sending anything), so the column redraws once a second while it is on screen.
    this.#timer = window.setInterval(() => { if (!this.root.hidden && !document.hidden) this.invalidate(); }, 1000);
  }

  get header(): HTMLElement { return this.controls; }
  setPalette(name: string): void { this.#palette = PALETTES[name] ?? PALETTES.light!; this.invalidate(); }
  invalidate(): void { if (!this.#frame) this.#frame = requestAnimationFrame(() => { this.#frame = 0; this.#render(); }); }
  /**
   * The map's view changed (it does on every frame while it follows the market, and while the pointer moves over it): with the Map span the column
   * follows it, but only redraws when the window has moved by a pixel of its own plot, so a hover on the map costs the column nothing.
   */
  followMap(): void {
    if (this.store.state.cvd.span !== 'map' || this.root.hidden) return;
    const drawn = this.#drawn, pixel = (this.view.t1 - this.view.t0) / Math.max(1, this.#model?.columns ?? 200);
    if (drawn && Math.abs(this.view.t0 - drawn.t0) < pixel && Math.abs(this.view.t1 - drawn.t1) < pixel) return;
    this.invalidate();
  }
  /** The settings changed (or the person asked for a fresh ranking). */
  refresh(): void { this.#ranker.reset(); this.#syncControls(); this.#modelKey = ''; this.invalidate(); }
  dispose(): void { window.clearInterval(this.#timer); }

  /** What the last frame drew. */
  get snapshot(): CvdSnapshot {
    const layout = this.#layout, model = this.#model;
    return { rows: model?.rows.map(r => r.key) ?? [], scroll: this.#scroll, maxScroll: layout ? maxScroll(layout, this.#h) : 0, heights: layout ? { agg: layout.agg, price: layout.price, rows: layout.rows } : { agg: 0, price: 0, rows: [] },
      spanMs: model ? model.t1 - model.t0 : 0, columns: model?.columns ?? 0, empty: this.#empty, gutter: this.#gutter, price: this.#priceStats(), since: this.#since };
  }
  get model(): CvdModel | null { return this.#model; }
  #priceStats(): { id: string | null; filled: number; distinct: number } {
    const last = this.#priceCols?.last, seen = new Set<number>();
    if (last) for (const v of last) if (v === v) seen.add(v);
    return { id: this.#priceId, filled: last ? last.reduce((n, v) => n + (v === v ? 1 : 0), 0) : 0, distinct: seen.size };
  }

  // ---- controls -------------------------------------------------------------------------------------------------------------------

  #buildControls(): void {
    const seg = el('div', { class: 'seg cvd-seg' });
    for (const span of CVD_SPANS) {
      const button = el('button', { type: 'button', textContent: SPAN_LABELS[span], tip: span === 'map' ? t("Follow the map's time span") : t('Show the last {span}', { span: SPAN_LABELS[span] }), onclick: () => this.#set({ span }) });
      this.#spanButtons.set(span, button); seg.append(button);
      this.#spanSelect.append(new Option(span === 'map' ? t('Map span') : SPAN_LABELS[span], span));
    }
    this.#spanSelect.onchange = () => this.#set({ span: this.#spanSelect.value as CvdSpan });
    this.#gear.innerHTML = '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" aria-hidden="true"><path d="M4 7h9M17 7h3M4 17h3M11 17h9"/><circle cx="15" cy="7" r="2"/><circle cx="9" cy="17" r="2"/></svg>';
    this.#gear.onclick = () => { togglePanel(this.#gear, { title: t('Flow column'), width: 380, align: 'left' }, (_tools, body) => this.#buildSettings(body)); };
    this.controls.append(el('strong', { textContent: t('Flow'), tip: t('Taker flow: cumulative volume delta (market buys minus market sells) per exchange, spot and perpetual. Biggest exchanges first; the top row adds them all.') }), seg, this.#spanSelect, this.#gear, helpButton('cvd'));
    this.#syncControls();
  }
  #syncControls(): void {
    const { span } = this.store.state.cvd;
    for (const [id, button] of this.#spanButtons) button.classList.toggle('on', id === span);
    if (this.#spanSelect.value !== span) this.#spanSelect.value = span;
  }
  #set(patch: Partial<CvdSettings>): void {
    this.store.set({ cvd: { ...this.store.state.cvd, ...patch } });
    this.refresh();
  }
  #buildSettings(body: HTMLElement): void {
    const c = this.store.state.cvd;
    body.append(
      selectRow(t('Rank and share over'), t('The window the exchanges are ranked over, and the figures beside each row (net flow, share of volume) are taken over.'), RANK_WINDOWS.map(w => [w, w] as [string, string]), c.rank, v => this.#set({ rank: v as RankWindow })),
      numberRow(t('Exchanges shown'), t('How many exchange rows to show, biggest first. 0 shows every exchange that has traded; the column scrolls.'), { min: 0, step: 1, max: 32, value: c.top }, v => this.#set({ top: v })),
      selectRow(t('Row heights'), t('Golden: each rank is a little over half as tall as the one above it. Volume: as tall as its share of the volume. Equal: all the same. The top row is always the tallest.'), HEIGHT_MODES.map(m => [m, m === 'golden' ? t('Golden ratio') : m === 'volume' ? t('By volume') : t('Equal')] as [string, string]), c.heights, v => this.#set({ heights: v as CvdSettings['heights'] })),
      switchRow(t('Re-rank automatically'), t('Re-order the rows by volume every few minutes. Off keeps the first layout until you change something here.'), c.auto, v => { this.#set({ auto: v }); }),
      numberRow(t('Re-rank every (minutes)'), t('How often the order may change; the numbers beside the rows are always current.'), { min: 1, step: 1, max: 60, value: c.refreshMin }, v => this.#set({ refreshMin: v })),
      this.#pinPicker(c.pinned),
      switchRow(t('Flag quiet exchanges'), t('Mark an exchange that has not traded in the last five completed minutes with !5m.'), c.quietFlag, v => this.#set({ quietFlag: v })),
      switchRow(t('Start each line at zero'), t('Draw every line from zero at the left edge, so rows can be compared. Off draws the running total since the history began.'), c.rebase, v => this.#set({ rebase: v })),
      note(t('Blue is spot and amber is perpetual, whichever way the money moved. Numbers carry the sign.')),
      heading(t('Sound')),
      panelSwitchRow(this.store, 'flow'),
    );
  }

  /** The exchanges that stay in the list whatever their rank: one toggle each, so a person pins whichever they follow. */
  #pinPicker(pinned: readonly string[]): HTMLElement {
    const chips = el('div', { class: 'chips pin-chips' });
    const choices = pinChoices(this.store.state, this.hub.flow.ids, pinned);
    for (const key of choices) {
      const on = pinned.includes(key);
      const chip = el('button', { type: 'button', class: `chip pin-chip${on ? ' on' : ''}`, textContent: venueLabel(key), onclick: () => {
        const now = this.store.state.cvd.pinned, next = now.includes(key) ? now.filter(k => k !== key) : [...now, key].slice(0, MAX_PINNED);
        chip.classList.toggle('on', next.includes(key)); chip.setAttribute('aria-pressed', String(next.includes(key)));
        this.#set({ pinned: next });
      } });
      chip.setAttribute('aria-pressed', String(on)); chips.append(chip);
    }
    if (!choices.length) chips.append(el('span', { class: 'desc', textContent: t('No exchanges yet.') }));
    return el('div', { class: 'field pin-field', tip: t('Exchanges that stay in the list even when they are not among the biggest. They take the last places.') },
      el('span', { class: 'label' }, el('span', { class: 'name', textContent: t('Keep listed') }), el('span', { class: 'desc', textContent: t('Exchanges that stay in the list even when they are not among the biggest. They take the last places.') })), chips);
  }

  // ---- pointer --------------------------------------------------------------------------------------------------------------------

  #bindInput(): void {
    const c = this.#canvas;
    const local = (e: MouseEvent) => { const r = c.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; };
    c.addEventListener('wheel', e => {
      const layout = this.#layout; if (!layout) return;
      const limit = maxScroll(layout, this.#h); if (limit <= 0) return;
      e.preventDefault();
      const lines = e.deltaMode === 1 ? 33 : e.deltaMode === 2 ? this.#h : 1;
      this.#scrollTo(this.#scroll + e.deltaY * lines);
    }, { passive: false });
    let drag: { y: number; scroll: number } | null = null;
    c.addEventListener('pointerdown', e => {
      if (e.button !== 0 && e.pointerType === 'mouse') return;
      const { y } = local(e); drag = { y, scroll: this.#scroll };
      c.setPointerCapture(e.pointerId);
    });
    c.addEventListener('pointermove', e => {
      const { x, y } = local(e);
      if (drag && this.#layout && maxScroll(this.#layout, this.#h) > 0 && (e.pointerType === 'touch' || Math.abs(y - drag.y) > 4)) this.#scrollTo(drag.scroll - (y - drag.y));
      else if (!drag || e.pointerType !== 'touch') this.#hover = { x, y };
      c.style.cursor = drag && Math.abs(y - drag.y) > 4 ? 'grabbing' : 'crosshair';
      this.invalidate();
    });
    const release = (e: PointerEvent) => { drag = null; if (c.hasPointerCapture(e.pointerId)) c.releasePointerCapture(e.pointerId); if (e.pointerType === 'touch') this.#hover = null; c.style.cursor = 'crosshair'; this.invalidate(); };
    c.addEventListener('pointerup', release); c.addEventListener('pointercancel', release);
    c.addEventListener('pointerleave', e => { if (e.pointerType === 'touch') return; this.#hover = null; this.invalidate(); });
    c.addEventListener('dblclick', () => { this.#scroll = 0; this.invalidate(); });
    c.style.cursor = 'crosshair'; c.style.touchAction = 'pan-x';
  }
  #scrollTo(value: number): void {
    const layout = this.#layout; if (!layout) return;
    const next = Math.max(0, Math.min(maxScroll(layout, this.#h), Math.round(value)));
    if (next !== this.#scroll) { this.#scroll = next; this.invalidate(); }
  }

  #resize(): void {
    const r = this.#wrap.getBoundingClientRect();
    this.#w = Math.max(1, Math.floor(r.width)); this.#h = Math.max(1, Math.floor(r.height)); this.#dpr = window.devicePixelRatio || 1;
    this.#canvas.width = Math.round(this.#w * this.#dpr); this.#canvas.height = Math.round(this.#h * this.#dpr);
    this.#canvas.style.width = `${this.#w}px`; this.#canvas.style.height = `${this.#h}px`;
    this.#modelKey = '';
    this.invalidate();
  }

  // ---- data -----------------------------------------------------------------------------------------------------------------------

  /** Minute candles of the market on screen for the price strip, fetched now and then (the live marks carry it between). */
  #loadPrice(now: number, from: number): void {
    const id = this.store.state.seriesInstrument || this.store.state.marketId;
    if (!id || this.#priceLoading) return;
    const want = `${id}|${Math.floor(from / 3_600_000)}`;
    if (want === this.#priceFor && now - this.#priceAt < 60_000) return;
    this.#priceLoading = true;
    this.hub.source.candles(id, '1m', from - 120_000, now + 60_000).then(rows => {
      if (this.store.state.seriesInstrument !== id && this.store.state.marketId !== id) return;
      this.#price.load(rows as unknown as number[][], Date.now()); this.#priceFor = want; this.#priceAt = Date.now(); this.#modelKey = ''; this.invalidate();
    }, () => { this.#priceAt = Date.now(); this.#priceFor = want; }).finally(() => { this.#priceLoading = false; });
  }

  // ---- drawing --------------------------------------------------------------------------------------------------------------------

  #render(): void {
    if (this.root.hidden || this.#w < 60 || this.#h < 60) return;
    const s = this.store.state, cfg = s.cvd, now = Date.now(), p = this.#palette, ctx = this.#ctx;
    this.#ranker.refreshMs = cfg.refreshMin * 60_000; this.#ranker.auto = cfg.auto;
    const spanMs = cfg.span === 'map' ? Math.max(60_000, this.view.t1 - this.view.t0) : CVD_SPAN_MS[cfg.span];
    const ids = flowIds(s, this.hub.flow.ids);
    // The price comes from the recorded seconds of the market on screen when it has them (the same trades as the flow, a second at a time).
    const priceId = priceFlowId([s.seriesInstrument, s.marketId], id => this.hub.flow.has(id));
    const reach = Math.max(spanMs, RANK_MS[cfg.rank], 3_600_000);
    void this.hub.ensureFlow(priceId && !ids.includes(priceId) ? [...ids, priceId] : ids, Math.max(now - HISTORY_CAP_MS, Math.min(now, cfg.span === 'map' ? this.view.t1 : now) - reach - 60_000));
    let earliest = Infinity;
    for (const id of ids) { const first = this.hub.flow.get(id)?.span?.first; if (first !== undefined && first * 1000 < earliest) earliest = first * 1000; }
    const win = flowWindow({ span: cfg.span, mapT0: this.view.t0, mapT1: this.view.t1, now, earliest }), { t0, t1 } = win;
    this.#since = win.since;
    this.#loadPrice(now, t0);
    if (s.mark.price > 0) this.#price.add(now, s.mark.price);

    this.#gutter = Math.max(GUTTER_MIN, Math.min(GUTTER_MAX, Math.round(this.#w * 0.34)));
    const plotW = Math.max(20, this.#w - this.#gutter - PAD), columns = Math.max(24, Math.min(900, Math.floor(plotW)));
    const key = [this.hub.flow.version, columns, Math.floor(t0 / Math.max(1000, spanMs / columns)), Math.floor(now / 1000), cfg.span, cfg.rank, cfg.top, cfg.heights, cfg.auto, cfg.refreshMin, cfg.pinned.join(','), cfg.quietFlag, cfg.rebase, s.scope, s.disabledVenues.join(','), ids.length, this.#price.length, priceId ?? ''].join('|');
    if (key !== this.#modelKey || !this.#model) {
      this.#model = buildModel({ flow: this.hub.flow, ids, kindOf: id => kindOf(s.markets, id), t0, t1, columns, now, settings: cfg, ranker: this.#ranker });
      this.#priceId = priceId; this.#priceCols = this.#priceColumns(this.#model);
      this.#modelKey = key;
    }
    const model = this.#model;
    this.#drawn = { t0: this.view.t0, t1: this.view.t1 };
    this.#empty = emptyScopeMessage(s) ?? (!model.rows.length ? (ids.length ? t('Waiting for trades…') : t('No venues are enabled.')) : null);
    const layout = rowHeights(cfg.heights, this.#h, model.rows.map(r => r.share), { minRow: MIN_ROW, minAgg: MIN_AGG, price: PRICE_H });
    this.#layout = layout;
    this.#scroll = Math.max(0, Math.min(maxScroll(layout, this.#h), this.#scroll));

    ctx.setTransform(this.#dpr, 0, 0, this.#dpr, 0, 0);
    ctx.clearRect(0, 0, this.#w, this.#h);
    const colors = laneColors(p), plot = { x: this.#gutter, w: plotW };
    const window = windowName(model.rankSec);
    // The venue rows scroll under the aggregate and the price strip, so they are drawn first and the strip over them.
    const top = layout.agg + layout.price;
    ctx.save(); ctx.beginPath(); ctx.rect(0, top, this.#w, this.#h - top); ctx.clip();
    let y = top - this.#scroll;
    model.rows.forEach((row, i) => {
      const h = layout.rows[i]!;
      if (y + h > top && y < this.#h) this.#paintRow(ctx, p, colors, plot, y, h, row.lanes, rowLabel(row, window, h, cfg.quietFlag), row.key, cfg.rebase);
      y += h;
    });
    ctx.restore();
    ctx.fillStyle = p.panel; ctx.fillRect(0, 0, this.#w, top);
    this.#paintRow(ctx, p, colors, plot, 0, layout.agg, [model.spot, model.perp].filter((l): l is LaneLine => l !== null), aggregateLabel(model, layout.agg), '', cfg.rebase);
    this.#paintPrice(ctx, p, plot, layout.agg, layout.price, model);
    if (this.#since !== null) this.#paintSince(ctx, p, plot, this.#since);
    ctx.strokeStyle = p.muted; ctx.globalAlpha = 0.55; ctx.beginPath(); ctx.moveTo(0, top + 0.5); ctx.lineTo(this.#w, top + 0.5); ctx.stroke(); ctx.globalAlpha = 1;
    if (maxScroll(layout, this.#h) > 0) this.#paintScrollbar(ctx, p, layout);
    if (this.#empty) { ctx.fillStyle = p.muted; ctx.font = `12px ${SANS}`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillText(this.#empty, this.#w / 2, Math.min(this.#h - 20, top + 36)); }
    this.#paintHover(ctx, p, model, layout, plot, window);
  }

  /** A row: its lanes as lines (each on its own scale), the quiet lanes faded, and its label in the gutter on the left. */
  #paintRow(ctx: CanvasRenderingContext2D, p: Palette, colors: LaneColors, plot: { x: number; w: number }, y: number, h: number, lanes: readonly LaneLine[], label: readonly LabelLine[], family: string, rebase: boolean): void {
    const pad = 6, inner = { y: y + pad + 2, h: Math.max(8, h - 2 * pad - 4) }, columns = this.#model!.columns;
    ctx.save(); ctx.strokeStyle = p.line; ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(0, Math.round(y + h) - 0.5); ctx.lineTo(this.#w, Math.round(y + h) - 0.5); ctx.stroke(); ctx.restore();
    for (const lane of lanes) {
      const color = lane.quiet ? (lane.kind === 'spot' ? colors.spotQuiet : colors.perpQuiet) : (lane.kind === 'spot' ? colors.spot : colors.perp);
      this.#paintLane(ctx, lane, color, plot, inner, columns, rebase, p);
      if (family) this.#paintEvents(ctx, lane, color, plot, inner, columns, rebase);
    }
    // The label.
    ctx.save(); ctx.beginPath(); ctx.rect(0, y, this.#gutter - 4, h); ctx.clip();
    ctx.textBaseline = 'middle'; ctx.textAlign = 'left';
    const total = label.length * LINE_H, first = y + (h - total) / 2 + LINE_H / 2, room = this.#gutter - 10;
    label.forEach((line, i) => {
      const ly = first + i * LINE_H;
      let x = PAD;
      if (line.dot) { ctx.fillStyle = line.dot === 'spot' ? colors.spot : colors.perp; ctx.beginPath(); ctx.arc(x + 3, ly, 3, 0, Math.PI * 2); ctx.fill(); x += 11; }
      ctx.font = line.bold ? `600 11px ${SANS}` : `11px ${line.dot ? MONO : SANS}`;
      ctx.fillStyle = line.tone === 'muted' ? p.muted : p.text;
      ctx.fillText(fit(ctx, line.text, room - (x - PAD)), x, ly);
    });
    ctx.restore();
  }

  #scaleOf(lane: LaneLine, rebase: boolean): { lo: number; hi: number } | null {
    let lo = lane.min, hi = lane.max;
    if (!(lo <= hi)) return null;
    if (rebase) { lo = Math.min(lo, 0); hi = Math.max(hi, 0); }
    if (hi - lo < 1) { lo -= 1; hi += 1; }
    const pad = (hi - lo) * 0.1;
    return { lo: lo - pad, hi: hi + pad };
  }

  #paintLane(ctx: CanvasRenderingContext2D, lane: LaneLine, color: string, plot: { x: number; w: number }, inner: { y: number; h: number }, columns: number, rebase: boolean, p: Palette): void {
    const scale = this.#scaleOf(lane, rebase); if (!scale) return;
    const X = (c: number): number => plot.x + (c + 0.5) / columns * plot.w, Y = (v: number): number => inner.y + inner.h - (v - scale.lo) / (scale.hi - scale.lo) * inner.h;
    ctx.save();
    if (rebase && scale.lo < 0 && scale.hi > 0) { ctx.strokeStyle = p.line; ctx.setLineDash([3, 3]); ctx.beginPath(); ctx.moveTo(plot.x, Math.round(Y(0)) + 0.5); ctx.lineTo(plot.x + plot.w, Math.round(Y(0)) + 0.5); ctx.stroke(); ctx.setLineDash([]); }
    // The envelope: where the running delta went inside a column, which a line through the last values would hide at coarse spans.
    if (lane.series) {
      ctx.globalAlpha = 0.2; ctx.fillStyle = color;
      let start = -1;
      const close = (end: number): void => {
        if (start < 0) return;
        ctx.beginPath();
        for (let c = start; c <= end; c++) ctx.lineTo(X(c), Y(lane.hi[c]!));
        for (let c = end; c >= start; c--) ctx.lineTo(X(c), Y(lane.lo[c]!));
        ctx.closePath(); ctx.fill(); start = -1;
      };
      for (let c = 0; c < columns; c++) { if (Number.isNaN(lane.last[c]!)) { close(c - 1); continue; } if (start < 0) start = c; }
      close(columns - 1);
      ctx.globalAlpha = 1;
    }
    ctx.strokeStyle = color; ctx.lineWidth = 1.6; ctx.lineJoin = 'round';
    ctx.beginPath();
    let pen = false, lastC = -1;
    for (let c = 0; c < columns; c++) {
      const v = lane.last[c]!;
      if (Number.isNaN(v)) { pen = false; continue; }
      if (pen) ctx.lineTo(X(c), Y(v)); else { ctx.moveTo(X(c), Y(v)); pen = true; }
      lastC = c;
    }
    ctx.stroke();
    // The line ends at the right edge with nothing laid over it: a dot says where "now" is.
    if (lastC >= 0) { ctx.fillStyle = color; ctx.beginPath(); ctx.arc(X(lastC), Y(lane.last[lastC]!), 2.4, 0, Math.PI * 2); ctx.fill(); }
    ctx.restore();
  }

  /** A small triangle on the line where a burst of buying or selling was seen (up for buying, down for selling), and the row's outline for a minute after. */
  #paintEvents(ctx: CanvasRenderingContext2D, lane: LaneLine, color: string, plot: { x: number; w: number }, inner: { y: number; h: number }, columns: number, rebase: boolean): void {
    const model = this.#model!, scale = this.#scaleOf(lane, rebase); if (!scale) return;
    for (const e of this.events) {
      if (e.id !== lane.id || e.t < model.t0 || e.t > model.t1) continue;
      const c = Math.min(columns - 1, Math.max(0, Math.floor((e.t - model.t0) / (model.t1 - model.t0) * columns))), v = lane.last[c]!;
      if (Number.isNaN(v)) continue;
      const x = plot.x + (c + 0.5) / columns * plot.w, y = inner.y + inner.h - (v - scale.lo) / (scale.hi - scale.lo) * inner.h, up = e.delta > 0;
      ctx.fillStyle = color; ctx.beginPath(); ctx.moveTo(x, y + (up ? -9 : 9)); ctx.lineTo(x - 4, y + (up ? -2 : 2)); ctx.lineTo(x + 4, y + (up ? -2 : 2)); ctx.closePath(); ctx.fill();
    }
  }

  #paintPrice(ctx: CanvasRenderingContext2D, p: Palette, plot: { x: number; w: number }, y: number, h: number, model: CvdModel): void {
    const columns = model.columns, cols = this.#priceCols ?? this.#price.columns(model.t0, model.t1, columns);
    ctx.save(); ctx.strokeStyle = p.line; ctx.beginPath(); ctx.moveTo(0, Math.round(y + h) - 0.5); ctx.lineTo(this.#w, Math.round(y + h) - 0.5); ctx.stroke();
    ctx.textBaseline = 'middle'; ctx.textAlign = 'left';
    const last = this.store.state.mark.price, ly = y + h / 2;
    ctx.font = `600 11px ${SANS}`; ctx.fillStyle = p.text; ctx.fillText(t('PRICE'), PAD, ly - LINE_H / 2);
    ctx.font = `11px ${MONO}`; ctx.fillStyle = p.muted; ctx.fillText(fit(ctx, last > 0 ? fmtPrice(last) : '–', this.#gutter - 10), PAD, ly + LINE_H / 2);
    if (cols.min <= cols.max) {
      const pad = (cols.max - cols.min) * 0.12 || cols.max * 0.0005, lo = cols.min - pad, hi = cols.max + pad, inner = { y: y + 7, h: h - 14 };
      ctx.strokeStyle = p.text; ctx.globalAlpha = 0.85; ctx.lineWidth = 1.3; ctx.beginPath();
      let pen = false;
      for (let c = 0; c < columns; c++) {
        const v = cols.last[c]!; if (Number.isNaN(v)) { pen = false; continue; }
        const x = plot.x + (c + 0.5) / columns * plot.w, yy = inner.y + inner.h - (v - lo) / (hi - lo) * inner.h;
        if (pen) ctx.lineTo(x, yy); else { ctx.moveTo(x, yy); pen = true; }
      }
      ctx.stroke(); ctx.globalAlpha = 1;
    }
    ctx.restore();
  }

  /** The price strip's columns: the market's recorded seconds where it has them, the candle closes and marks for what came before (or all of it, when it has none). */
  #priceColumns(model: CvdModel): PriceColumns {
    const columns = model.columns, track = this.#price.columns(model.t0, model.t1, columns), series = this.#priceId ? this.hub.flow.get(this.#priceId) : undefined;
    if (!series || series.empty) return track;
    const from = Math.floor(model.t0 / 1000), to = Math.max(from + 1, Math.ceil(model.t1 / 1000)), last = new Float64Array(columns);
    series.priceColumns(from, to, columns, last);
    let min = Infinity, max = -Infinity;
    for (let c = 0; c < columns; c++) {
      const v = last[c]! === last[c]! ? last[c]! : track.last[c]!; last[c] = v;
      if (v === v) { if (v < min) min = v; if (v > max) max = v; }
    }
    return { last, ...(min <= max ? { min, max } : { min: NaN, max: NaN }) };
  }
  /** The price at `time` (ms), from the same source as the strip. */
  #priceAtTime(time: number): number {
    const series = this.#priceId ? this.hub.flow.get(this.#priceId) : undefined, v = series && !series.empty ? series.priceAt(Math.floor(time / 1000)) : NaN;
    return v === v ? v : this.#price.at(time);
  }

  /** "Flow recorded since 13:54", muted, at the left of the aggregate row: the window reaches back before the recording began. */
  #paintSince(ctx: CanvasRenderingContext2D, p: Palette, plot: { x: number; w: number }, since: number): void {
    const startOfToday = new Date().setHours(0, 0, 0, 0);
    ctx.save(); ctx.font = `10px ${SANS}`; ctx.fillStyle = p.muted; ctx.textAlign = 'left'; ctx.textBaseline = 'top';
    ctx.fillText(fit(ctx, t('Flow recorded since {time}', { time: clock(since, since < startOfToday) }), plot.w - 12), plot.x + 6, 5);
    ctx.restore();
  }

  #paintScrollbar(ctx: CanvasRenderingContext2D, p: Palette, layout: RowLayout): void {
    const top = layout.agg + layout.price, room = this.#h - top, limit = maxScroll(layout, this.#h);
    const thumb = Math.max(24, room * room / (room + limit)), at = top + (room - thumb) * (this.#scroll / limit);
    ctx.save(); ctx.globalAlpha = 0.45; ctx.fillStyle = p.muted; ctx.fillRect(this.#w - 4, at, 3, thumb); ctx.restore();
  }

  #paintHover(ctx: CanvasRenderingContext2D, p: Palette, model: CvdModel, layout: RowLayout, plot: { x: number; w: number }, window: string): void {
    const hover = this.#hover; if (!hover) return;
    const hit = locateRow(layout, this.#scroll, this.#h, hover.y);
    if (!hit) return;
    const col = Math.max(0, Math.min(model.columns - 1, Math.floor((hover.x - plot.x) / plot.w * model.columns))), inPlot = hover.x >= plot.x && hover.x <= plot.x + plot.w;
    const time = model.t0 + (col + 0.5) / model.columns * (model.t1 - model.t0);
    // Shade the row under the pointer, and draw the time cursor down the plot.
    let rowTop = 0, rowH = layout.agg;
    if (hit.kind === 'price') { rowTop = layout.agg; rowH = layout.price; }
    else if (hit.kind === 'row') { rowTop = layout.agg + layout.price - this.#scroll + layout.rows.slice(0, hit.index).reduce((a, b) => a + b, 0); rowH = layout.rows[hit.index]!; }
    ctx.save(); ctx.globalAlpha = 0.05; ctx.fillStyle = p.text; ctx.fillRect(0, Math.max(rowTop, hit.kind === 'row' ? layout.agg + layout.price : 0), this.#w, rowH); ctx.globalAlpha = 1;
    if (inPlot) { ctx.strokeStyle = p.muted; ctx.globalAlpha = 0.7; const x = Math.round(plot.x + (col + 0.5) / model.columns * plot.w) + 0.5; ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, this.#h); ctx.stroke(); ctx.globalAlpha = 1; }
    ctx.restore();
    let lines: InfoLine[];
    if (hit.kind === 'agg') lines = aggregateHover(model, col, time, window);
    else if (hit.kind === 'price') { const v = this.#priceAtTime(time); lines = [{ text: t('Price'), bold: true }, { text: clock(time, true), color: 'muted' }, { label: t('Price here'), text: Number.isFinite(v) ? fmtPrice(v) : '–', rule: true }]; }
    else lines = rowHover(model.rows[hit.index]!, col, time, window);
    paintInfoBox(ctx, lines, hover.x, hover.y, { x0: 0, y0: 0, x1: this.#w, y1: this.#h }, p, { placement: 'down' });
  }
}

