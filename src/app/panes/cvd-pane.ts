import { PALETTES, type Palette } from '../theme.ts';
import { el } from '../dom.ts';
import { helpButton } from '../help.ts';
import { clock, clockSeconds, price as fmtPrice, startOfDay } from '../format.ts';
import { paintInfoBox, type InfoLine } from '../infobox.ts';
import { emptyScopeMessage, kindOf, type Kind } from '../scope.ts';
import { isPhone, layoutMode, onLayoutMode } from '../device.ts';
import { GestureRecognizer, axisPinchScale, bindTouch, type GestureHandlers, type Pt } from '../touch.ts';
import { timeAxis } from '../time-axis.ts';
import { setHtml } from './lower-panes.ts';
import { flowIds, flowLoadIds, pinChoices, priceFlowId } from '../cvd/ids.ts';
import { explainMissing, noticeRows, type NoticeAction } from '../cvd/missing.ts';
import { buildFamilies } from '../cvd/families.ts';
import { flowWindow } from '../cvd/window.ts';
import { MAX_PINNED, rankingKey } from '../cvd/settings.ts';
import { venueLabel } from '../venues.ts';
import { selectRow, sizeRow, switchRow, numberRow, togglePanel, note, heading, type Panel } from '../ui.ts';
import { COMMON_SIZES, SIZE_FLOOR_USD, SIZE_MAX_USD, sizeText } from '../sizes.ts';
import { scaledUsd, unscaledUsd } from '../coin.ts';
import type { AppState, Store } from '../store.ts';
import type { Hub } from '../hub.ts';
import type { View } from '../view.ts';
import { Ranker } from '../cvd/rank.ts';
import { buildModel, type CvdModel, type LaneLine } from '../cvd/model.ts';
import { HEIGHT_MODES, locateRow, maxScroll, rowHeights, type RowLayout } from '../cvd/layout.ts';
import { CVD_SPANS, CVD_SPAN_MS, RANK_MS, RANK_WINDOWS, type CvdSettings, type CvdSpan, type RankWindow } from '../cvd/settings.ts';
import { aggregateHover, aggregateLabel, heroLabel, rowHover, rowLabel, signedUsd, windowName, type LabelLine } from '../cvd/text.ts';
import { PRICE_AXIS_W, columnAt, heroHeight, heroPoint, laneRange, niceTicks, pinchSpan, priceRange, sharedRange, spanOnPhone, type Range } from '../cvd/hero.ts';
import { laneColors, type LaneColors } from '../cvd/colors.ts';
import { PriceTrack, type PriceColumns } from '../cvd/price.ts';
import type { BurstEvent } from '../cvd/burst.ts';
import { burstSizeRows, panelSwitchRow } from '../sound/panel.ts';
import { CvdStrip } from './cvd-strip.ts';
import type { Print } from '../prints.ts';
import { t } from '../i18n.ts';
import { DRAG_MIN_PX, selects } from '../range/selection.ts';
import { drawVenueMark } from '../venue-marks.ts';
import type { RangeTool } from '../range/tool.ts';
import { pageNow, replaying } from '../replay/clock.ts';
import { flowEndChange, type FlowEnd } from '../cvd/flash.ts';
import { FitGrid } from '../ui/fit-grid.ts';

const SANS = 'ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif', MONO = 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace';
const PAD = 6, LINE_H = 12;
/** The label column: a third of the pane, within these limits. */
const GUTTER_MIN = 76, GUTTER_MAX = 120;
const MIN_ROW = 56, MIN_AGG = 92, PRICE_H = 44;
/** The shortest a venue row is on a phone: its label is three lines of 12 px. */
const PHONE_MIN_ROW = 60;
/** Flow is held a second at a time for at most this long (the ring holds a day and a half); a window reaching further back reads minutes there. */
const HISTORY_CAP_MS = 24 * 3_600_000;
/** Older flow (minutes) is asked from a boundary of this many ms before the window. */
const MINUTES_FROM_MS = 6 * 3_600_000;
const SPAN_LABELS: Record<CvdSpan, string> = { map: t('Map'), '5m': '5m', '15m': '15m', '1h': '1h', '4h': '4h', '24h': '24h' };

/** What the last frame drew, for the checks that look at the pane without reading its pixels. */
export interface CvdSnapshot { rows: string[]; scroll: number; maxScroll: number; heights: { agg: number; price: number; rows: number[] }; spanMs: number; columns: number; empty: string | null; gutter: number;
  /** Where the price strip's price comes from (an instrument's recorded seconds, or null for candle closes), how many of its columns are filled and how many different prices they hold, and when the flow began if the window reaches before it. */
  price: { id: string | null; filled: number; distinct: number }; since: number | null;
  /** The lines of the notice above the rows (why an exchange with flow is not shown), empty when every exchange is. */
  notice: string[];
  /** The x of the line drawn for the pointer of another pane (null when there is none), and the time the pointer of this one has shared. */
  sharedX: number | null; sharedTime: number | null }

const fit = (ctx: CanvasRenderingContext2D, text: string, width: number): string => {
  if (ctx.measureText(text).width <= width) return text;
  let end = text.length; while (end > 1 && ctx.measureText(`${text.slice(0, end)}…`).width > width) end--;
  return `${text.slice(0, end)}…`;
};

/**
 * The taker-flow column left of the map: the cumulative volume delta (buys at market minus sells at market) of every exchange, spot and
 * perpetual, with the exchanges ranked by volume and the labels on the left so nothing sits on the ends of the
 * lines. The numbers come from `cvd/model.ts` and the words from `cvd/text.ts`; this class is the canvas, the pointer and the controls.
 */
/** How long a line end's flash lasts (ms). */
const FLASH_LIFE_MS = 750;

export class CvdPane {
  readonly root = el('section', { class: 'pane cvd' });
  readonly controls = el('div', { class: 'pane-head' });
  #wrap = el('div', { class: 'cvd-wrap' });
  /** Says why an exchange that has flow is not among the rows (the filter, a switched-off chip, the row limit...), with a button to undo it. */
  #notice = el('div', { class: 'cvd-notice', role: 'status', hidden: true });
  #noticeKey = ''; #noticeRows: string[] = [];
  #canvas = document.createElement('canvas');
  #ctx: CanvasRenderingContext2D;
  /**
   * The flashes at the lines' ends (Karl, 2026-10-17): each line's end as it last stood (`cvd/flash.ts`), and the flashes its changes started,
   * drawn on a canvas of their own over the lines so a flash animates without the column being drawn again; whether the window drawn ends
   * at the live edge (only there do they flash), and the frame or, with reduced motion, the timer that draws them next.
   */
  #flashCanvas = el('canvas', { class: 'cvd-flash', ariaHidden: 'true' });
  #flashCtx: CanvasRenderingContext2D;
  #ends = new Map<string, FlowEnd>();
  #flashes: { x: number; y: number; k: number; color: string; at: number }[] = [];
  #atLive = false;
  #flashFrame = 0; #flashTimer = 0;
  /** A change large enough to be seen across the page (window CSS px, signed USD): the glass sends a wave from there (set by the page). */
  onLargeFlow: (x: number, y: number, usd: number) => void = () => {};
  #w = 0; #h = 0; #dpr = 1; #frame = 0;
  #palette: Palette = PALETTES.light!;
  #ranker = new Ranker();
  #price = new PriceTrack();
  #priceFor = ''; #priceAt = 0; #priceLoading = false;
  /** The window the phone's chart drew, as its legend names it: the span's own name, or how long the flow it fitted to is ("6M"). */
  #windowName = '1h';
  /** The newest price the phone's chart drew (its legend names it), NaN when it drew none; and the ranges its lines were drawn over, for the dots of a cursor. */
  #priceNow = NaN;
  #heroGeo: { inner: { y: number; h: number }; spot: Range | null; perp: Range | null; price: Range | null } | null = null;
  /** The price strip's columns and the instrument whose recorded seconds gave them (null: candle closes and marks), as the last model was built. */
  #priceCols: PriceColumns | null = null; #priceId: string | null = null;
  /** When the flow began, if the window starts before it (shown as a note on the aggregate row). */
  #since: number | null = null;
  /** The window starts before the flow because the source keeps no older flow (not because recording began then). */
  #sinceHeld = false;
  #model: CvdModel | null = null; #modelKey = '';
  #layout: RowLayout | null = null;
  #scroll = 0;
  #hover: { x: number; y: number } | null = null;
  /**
   * A finger on a phone (`bindTouch`): where it scrubs now (a drag across the lines, or a press held and moved), and the moment a tap or a hold
   * pinned (it stays until the next tap, and moves left with the lines as time passes). What it points at is read out under the header.
   */
  #scrub: { x: number; y: number } | null = null; #pin: { t: number; y: number } | null = null;
  #readout = el('span', { class: 'readout' });
  /** The header's layout (ui/fit-grid.ts). */
  #fit: FitGrid | null = null;
  /** A fling after a vertical drag (the frame running it), and the finger separation a pinch counts its steps from. */
  #fling = 0; #pinchBase = 0;
  /** The Range tool (set by the page): a sideways drag across the lines selects that stretch of time. */
  range: RangeTool | null = null;
  #gutter = GUTTER_MIN;
  /** The window the last frame drew, for `followMap`. */
  #drawn: { t0: number; t1: number } | null = null;
  #empty: string | null = null;
  /** Where the plot was drawn, and where the line for another pane's pointer was (null: none), so a pointer elsewhere redraws only when that line moves. */
  #plot = { x: 0, w: 0 }; #sharedX: number | null = null;
  #spanButtons = new Map<CvdSpan, HTMLButtonElement>();
  #spanSelect = el('select', { class: 'cvd-span-select', ariaLabel: t('Time span') });
  #gear = el('button', { type: 'button', class: 'icon-btn cvd-gear', ariaLabel: t('Settings'), tip: t('How the column ranks and draws the exchanges.') });
  /** Bursts the alert engine has seen, drawn as markers on their rows (set from outside; newest last). */
  events: readonly BurstEvent[] = [];
  #timer = 0;
  /** What the pane listens to besides its own elements: let go of at `dispose`. */
  #off: (() => unknown)[] = [];
  /** The rows of dots above the exchanges, and the settings panel while it is open (so the controls that depend on each other can be redrawn). */
  #strip: CvdStrip; #panel: Panel | null = null;
  /** What the ranking was last made from: a change to the strip's own settings leaves the rows where they are. */
  #rankingKey: string;

  constructor(host: HTMLElement, private store: Store, private hub: Hub, private view: View) {
    this.#strip = new CvdStrip(store, hub); this.#rankingKey = rankingKey(store.state.cvd);
    this.root.append(this.controls, this.#strip.root, this.#notice, this.#wrap);
    this.#wrap.append(this.#canvas, this.#flashCanvas);
    host.append(this.root);
    this.#ctx = this.#canvas.getContext('2d')!; this.#flashCtx = this.#flashCanvas.getContext('2d')!;
    new ResizeObserver(() => this.#resize()).observe(this.#wrap);
    this.#buildControls();
    this.#bindInput();
    // The price's marks are kept while the column is out of sight too (a phone shows it only on its own tab): minutes spent on another tab
    // would otherwise be a straight line between two candle closes when the price comes to be drawn.
    this.#off.push(this.store.subscribe((state, changed) => { if (changed.has('mark') && state.mark.price > 0 && !replaying()) this.#price.add(Date.now(), state.mark.price); }));
    // A tablet turned over changes arrangement, and the span the chips mark with it (a phone's map span reads as an hour).
    this.#off.push(onLayoutMode(() => { this.#syncControls(); this.invalidate(); }));
    // The window moves on by itself (and a venue can go quiet without sending anything), so the column redraws once a second while it is on screen.
    this.#timer = window.setInterval(() => { if (!this.root.hidden && !document.hidden) { this.invalidate(); this.#strip.refresh(); } }, 1000);
  }

  get header(): HTMLElement { return this.controls; }
  /** The span the column draws: the setting, except that a phone's Flow view fills the area with no map to follow, so the map's span reads as an hour there. */
  #span(): CvdSpan { const span = this.store.state.cvd.span; return isPhone() ? spanOnPhone(span) : span; }
  setPalette(name: string): void {
    this.#palette = PALETTES[name] ?? PALETTES.light!; this.#strip.setPalette(this.#palette);
    // The readout and the chips under the header speak in the lines' colours.
    const colors = laneColors(this.#palette); this.root.style.setProperty('--cvd-spot', colors.spot); this.root.style.setProperty('--cvd-perp', colors.perp);
    this.invalidate();
  }
  invalidate(): void { if (!this.#frame) this.#frame = requestAnimationFrame(() => { this.#frame = 0; this.#render(); }); }
  /**
   * The map's view changed (it does on every frame while it follows the market, and while the pointer moves over it): with the Map span the column
   * follows it, but only redraws when the window has moved by a pixel of its own plot, so a hover on the map costs the column nothing.
   */
  followMap(): void {
    if (this.#span() !== 'map' || this.root.hidden) return;
    const drawn = this.#drawn, pixel = (this.view.t1 - this.view.t0) / Math.max(1, this.#model?.columns ?? 200);
    if (drawn && Math.abs(this.view.t0 - drawn.t0) < pixel && Math.abs(this.view.t1 - drawn.t1) < pixel) return;
    this.invalidate();
  }
  /**
   * The pointer of another pane moved (the map, or one of the panes under it): the column draws a vertical line at the same moment, and
   * redraws only when that line would move to another pixel (or appear, or go).
   */
  syncHover(): void {
    const x = this.#sharedLineX();
    if (x === this.#sharedX) return;
    this.#sharedX = x; this.invalidate();
  }
  /** The x of the line for another pane's pointer in the plot as last drawn, or null when it points at no moment this column shows. */
  #sharedLineX(): number | null {
    const hv = this.store.state.hover, m = this.#model;
    if (!hv || hv.source === 'cvd' || !m || !(m.t1 > m.t0) || hv.t < m.t0 || hv.t > m.t1) return null;
    return Math.round(this.#plot.x + (hv.t - m.t0) / (m.t1 - m.t0) * this.#plot.w);
  }
  /** Tell the other panes which moment the pointer is on (their own lines follow it), once per column; and take it back when the pointer goes. */
  #shareTime(x: number | null): void {
    const m = this.#model, hover = this.store.state.hover;
    if (x === null || !m || x < this.#plot.x || x > this.#plot.x + this.#plot.w) { if (hover?.source === 'cvd') this.store.set({ hover: null }); return; }
    const col = Math.max(0, Math.min(m.columns - 1, Math.floor((x - this.#plot.x) / this.#plot.w * m.columns))), time = m.t0 + (col + 0.5) / m.columns * (m.t1 - m.t0);
    if (hover?.source === 'cvd' && hover.t === time) return;
    this.store.set({ hover: { t: time, price: null, y: 0, source: 'cvd' } });
  }

  /** The settings changed (or the person asked for a fresh ranking). */
  refresh(): void { this.#ranker.reset(); this.#syncControls(); this.#modelKey = ''; this.invalidate(); if (!this.root.hidden) this.#strip.refresh(); }
  /** The column's settings changed: the ranking starts afresh unless only the dot rows' own were touched, which do not move the exchanges. */
  settingsChanged(): void {
    const key = rankingKey(this.store.state.cvd);
    if (key !== this.#rankingKey) { this.#rankingKey = key; this.refresh(); return; }
    this.#syncControls(); this.invalidate(); if (!this.root.hidden) this.#strip.refresh();
  }
  /** Trades that printed just now, for the blink of the dot rows. */
  flash(prints: readonly Print[]): void { this.#strip.flash(prints); }
  dispose(): void { window.clearInterval(this.#timer); window.clearTimeout(this.#flashTimer); this.#stopFling(); for (const off of this.#off) off(); this.#off = []; this.#strip.dispose(); this.#fit?.disconnect(); }

  /** What the last frame drew. */
  get snapshot(): CvdSnapshot {
    const layout = this.#layout, model = this.#model;
    return { rows: model?.rows.map(r => r.key) ?? [], scroll: this.#scroll, maxScroll: layout ? maxScroll(layout, this.#h) : 0, heights: layout ? { agg: layout.agg, price: layout.price, rows: layout.rows } : { agg: 0, price: 0, rows: [] },
      spanMs: model ? model.t1 - model.t0 : 0, columns: model?.columns ?? 0, empty: this.#empty, gutter: this.#gutter, price: this.#priceStats(), since: this.#since, notice: this.#noticeRows, sharedX: this.#sharedX, sharedTime: this.store.state.hover?.source === 'cvd' ? this.store.state.hover.t : null };
  }
  get model(): CvdModel | null { return this.#model; }
  /** What the dot rows last drew. */
  get strip(): CvdStrip { return this.#strip; }
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
      button.dataset.span = span;
      this.#spanButtons.set(span, button); seg.append(button);
      this.#spanSelect.append(new Option(span === 'map' ? t('Map span') : SPAN_LABELS[span], span));
    }
    this.#spanSelect.onchange = () => this.#set({ span: this.#spanSelect.value as CvdSpan });
    this.#gear.innerHTML = '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" aria-hidden="true"><path d="M4 7h9M17 7h3M4 17h3M11 17h9"/><circle cx="15" cy="7" r="2"/><circle cx="9" cy="17" r="2"/></svg>';
    this.#gear.onclick = () => { this.#panel = togglePanel(this.#gear, { title: t('Flow column'), width: 380, align: 'left', onClose: () => { this.#panel = null; } }, (_tools, body) => this.#buildSettings(body)); };
    // The span buttons are the header's one cell (ui/fit-grid.ts): on the title's line when they fit there, a whole row under it when not.
    seg.dataset.fit = 'row';
    const cells = el('div', {}, seg);
    this.controls.append(el('strong', { textContent: t('Flow'), tip: t('Taker flow: cumulative volume delta (market buys minus market sells) per exchange, spot and perpetual. Biggest exchanges first; the top row adds them all.') }), cells, this.#spanSelect, this.#gear, helpButton('cvd'), this.#readout);
    this.#fit = new FitGrid(this.controls, cells, this.root);
    this.#syncControls();
  }
  #syncControls(): void {
    const span = this.#span();
    for (const [id, button] of this.#spanButtons) { const on = id === span; button.classList.toggle('on', on); button.setAttribute('aria-pressed', String(on)); }
    if (this.#spanSelect.value !== span) this.#spanSelect.value = span;
  }
  #set(patch: Partial<CvdSettings>): void {
    this.store.set({ cvd: { ...this.store.state.cvd, ...patch } });
    this.settingsChanged();
  }
  #buildSettings(body: HTMLElement): void {
    const c = this.store.state.cvd;
    body.append(
      // The phone's chart draws spot and perpetual on one axis of dollars, or each over its own range (see `CvdSettings.scale`).
      ...(isPhone() ? [selectRow(t('Flow lines'), t('Spot and perpetual on one axis of dollars, so their sizes read against each other, or each over its own range, so their shapes do.'),
        [['shared', t('One axis of dollars')], ['own', t('Each over its own range')]], c.scale, v => this.#set({ scale: v === 'own' ? 'own' : 'shared' }))] : []),
      selectRow(t('Rank and share over'), t('The window the exchanges are ranked over, and the figures beside each row (net flow, share of volume) are taken over.'), RANK_WINDOWS.map(w => [w, w] as [string, string]), c.rank, v => this.#set({ rank: v as RankWindow })),
      numberRow(t('Exchanges shown'), t('How many exchange rows to show, biggest first. 0 shows every exchange that has traded; the column scrolls.'), { min: 0, step: 1, max: 32, value: c.top }, v => this.#set({ top: v })),
      selectRow(t('Row heights'), t('Golden: each rank is a little over half as tall as the one above it. Volume: as tall as its share of the volume. Equal: all the same. The top row is always the tallest.'), HEIGHT_MODES.map(m => [m, m === 'golden' ? t('Golden ratio') : m === 'volume' ? t('By volume') : t('Equal')] as [string, string]), c.heights, v => this.#set({ heights: v as CvdSettings['heights'] })),
      switchRow(t('Re-rank automatically'), t('Re-order the rows by volume every few minutes. Off keeps the first layout until you change something here.'), c.auto, v => { this.#set({ auto: v }); }),
      numberRow(t('Re-rank every (minutes)'), t('How often the order may change; the numbers beside the rows are always current.'), { min: 1, step: 1, max: 60, value: c.refreshMin }, v => this.#set({ refreshMin: v })),
      this.#pinPicker(c.pinned),
      switchRow(t('Flag quiet exchanges'), t('Mark an exchange that has not traded in the last five completed minutes with !5m.'), c.quietFlag, v => this.#set({ quietFlag: v })),
      switchRow(t('Start each line at zero'), t('Draw every line from zero at the left edge, so rows can be compared. Off draws the running total since the history began.'), c.rebase, v => this.#set({ rebase: v })),
      note(t('Blue is spot and amber is perpetual, whichever way the money moved. Numbers carry the sign.')),
      ...(isPhone() ? [] : this.#stripSettings(c)),
      heading(t('Bursts')),
      switchRow(t('Mark bursts on the lines'), t("A small triangle on an exchange's line where it bought (up) or sold (down) far more at market in ten seconds than it usually does. Only bursts seen while this page is open are marked."), c.bursts, v => this.#set({ bursts: v })),
      ...burstSizeRows(this.store),
      panelSwitchRow(this.store, 'flow'),
    );
  }

  /** The rows of dots above the exchanges: whether they show, the sizes they split the trades at (the Bar stats' sizes are the starting values), and the blink. */
  #stripSettings(c: CvdSettings): HTMLElement[] {
    // Whales never start under retail, as in the Bar stats; the panel is drawn again so the other one shows what it was moved to.
    const again = (): void => this.#panel?.render((_tools, body) => this.#buildSettings(body));
    const floor = scaledUsd(SIZE_FLOOR_USD), presets = COMMON_SIZES.map(scaledUsd), below = t('From {min}: smaller orders are kept only as one sum.', { min: `$${sizeText(floor)}` });
    return [
      heading(t('Dot rows')),
      switchRow(t('Show the dot rows'), t('Buys against sells over the last minutes, and by market order size, above the exchanges.'), c.strip, v => this.#set({ strip: v })),
      sizeRow(t('Retail'), t('The dot rows put market orders under this size together.'), { sign: '<', value: scaledUsd(c.stripRetailUsd), presets, min: floor, max: scaledUsd(SIZE_MAX_USD), hint: below },
        v => { const r = unscaledUsd(v); this.#set({ stripRetailUsd: r, stripWhaleUsd: Math.max(c.stripWhaleUsd, r) }); again(); }),
      sizeRow(t('Whales'), t('The dot rows put market orders of this size and over on their last row.'), { sign: '≥', value: scaledUsd(c.stripWhaleUsd), presets, min: floor, max: scaledUsd(SIZE_MAX_USD), hint: below },
        v => { const w = unscaledUsd(v); this.#set({ stripWhaleUsd: w, stripRetailUsd: Math.min(c.stripRetailUsd, w) }); again(); }),
      switchRow(t('Smallest orders on their own row'), t('Puts the market orders under $25K on a row of their own instead of with the retail ones.'), c.stripSmall, v => this.#set({ stripSmall: v })),
      switchRow(t('Blink on orders'), t('The leading dot of a size row lights for a moment when a market order of that size prints. It stays still when the system asks for less motion.'), c.stripBlink, v => this.#set({ stripBlink: v })),
    ];
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
    // The mouse and the pen. A finger is the recogniser's (`#bindFingers`): it needs a pan that tells scrolling from scrubbing, which pointer events do not.
    let drag: { y: number; scroll: number } | null = null, selecting: { x: number } | null = null;
    c.addEventListener('pointerdown', e => {
      if (e.pointerType === 'touch' || (e.button !== 0 && e.pointerType === 'mouse')) return;
      const at = local(e), time = this.#timeAt(at.x);
      if (this.range && time !== null && at.x >= this.#plot.x && selects(this.range.armed, e)) {
        selecting = { x: at.x }; this.range.begin({ t: time, p: null }); c.setPointerCapture(e.pointerId); return;
      }
      const { y } = local(e); drag = { y, scroll: this.#scroll };
      c.setPointerCapture(e.pointerId);
    });
    c.addEventListener('pointermove', e => {
      if (e.pointerType === 'touch') return;
      const { x, y } = local(e);
      if (selecting) { const time = this.#timeAt(x); if (time !== null) this.range?.move({ t: time, p: null }); this.#shareTime(x); return; }
      if (drag && this.#layout && maxScroll(this.#layout, this.#h) > 0 && Math.abs(y - drag.y) > 4) this.#scrollTo(drag.scroll - (y - drag.y));
      else this.#hover = { x, y };
      c.style.cursor = drag && Math.abs(y - drag.y) > 4 ? 'grabbing' : 'crosshair';
      this.#shareTime(x);
      this.invalidate();
    });
    const release = (e: PointerEvent) => {
      if (e.pointerType === 'touch') return;
      const sel = selecting;
      if (sel) {
        selecting = null; const { x } = local(e), time = this.#timeAt(x);
        if (time === null || e.type === 'pointercancel') this.range?.cancel(); else this.range?.end({ t: time, p: null }, Math.abs(x - sel.x) < DRAG_MIN_PX);
        if (c.hasPointerCapture(e.pointerId)) c.releasePointerCapture(e.pointerId);
        return;
      }
      drag = null; if (c.hasPointerCapture(e.pointerId)) c.releasePointerCapture(e.pointerId); c.style.cursor = 'crosshair'; this.invalidate(); };
    c.addEventListener('pointerup', release); c.addEventListener('pointercancel', release);
    c.addEventListener('pointerleave', e => { if (e.pointerType === 'touch') return; this.#hover = null; this.#shareTime(null); this.invalidate(); });
    c.addEventListener('dblclick', () => { this.#scroll = 0; this.invalidate(); });
    c.style.cursor = 'crosshair';
    this.#bindFingers();
  }

  /**
   * A finger (Karl, 2026-10-26, the Flow view for a phone): a drag along the lines scrubs them, and the readout under the header says what
   * they hold there; a drag across them scrolls the exchanges, with the fling a lifted finger leaves; a tap pins the moment under it (tap it
   * again to let it go), a press held moves the pin; two fingers apart or together step the span shorter or longer; a double tap scrolls
   * back to the top. The Range tool, when armed, takes a drag along the lines as it does on the other panes.
   */
  #bindFingers(): void {
    let mode: 'scrub' | 'scroll' | 'select' | null = null, startY = 0, base = 0, last: Pt | null = null, from: Pt | null = null;
    const handlers: GestureHandlers = {
      down: () => this.#stopFling(),
      tap: p => this.#pinAt(p, true),
      doubleTap: () => { this.#unpin(); this.#stopFling(); this.#scroll = 0; this.invalidate(); },
      hold: p => this.#pinAt(p, false), holdMove: p => this.#pinAt(p, false),
      panStart: p => {
        mode = null; from = p; last = p;
        if (this.range?.armed && p.x >= this.#plot.x && this.#timeAt(p.x) !== null) { mode = 'select'; this.range.begin({ t: this.#timeAt(p.x)!, p: null }); }
      },
      pan: (d, p) => {
        last = p;
        if (mode === 'select') { const time = this.#timeAt(p.x); if (time !== null) this.range?.move({ t: time, p: null }); return; }
        // Along the lines or across them, judged once by the first move, and kept until the finger lifts.
        if (mode === null) { mode = Math.abs(d.x) > Math.abs(d.y) * 1.2 ? 'scrub' : 'scroll'; startY = p.y - d.y; base = this.#scroll; if (mode === 'scrub') this.#unpin(); }
        if (mode === 'scrub') { this.#scrub = { x: p.x, y: p.y }; this.invalidate(); }
        else this.#scrollTo(base - (p.y - startY));
      },
      panEnd: v => {
        const was = mode; mode = null;
        if (was === 'select') {
          const time = last ? this.#timeAt(last.x) : null;
          if (v === null || time === null) this.range?.cancel(); else this.range?.end({ t: time, p: null }, !last || !from || Math.abs(last.x - from.x) < DRAG_MIN_PX);
        } else if (was === 'scrub') { this.#scrub = null; this.invalidate(); }
        else if (was === 'scroll' && v) this.#startFling(-v.y);
      },
      pinchStart: info => { this.#scrub = null; this.#pinchBase = info.now.dx; },
      pinch: info => {
        // Time is the horizontal axis: only the span moves (the map's window has nothing to do here), a step for each time the fingers have gone a third apart or together.
        if (!isPhone()) return;
        const ratio = axisPinchScale(this.#pinchBase, info.now.dx), now = this.#span(), next = pinchSpan(now, ratio);
        if (next === now) return;
        this.#pinchBase = info.now.dx; this.#unpin(); this.#set({ span: next });
      },
      cancel: () => { if (mode === 'select') this.range?.cancel(); mode = null; this.#scrub = null; this.invalidate(); },
    };
    bindTouch(this.#canvas, new GestureRecognizer(handlers));
  }

  #scrollTo(value: number): void {
    const layout = this.#layout; if (!layout) return;
    const next = Math.max(0, Math.min(maxScroll(layout, this.#h), Math.round(value)));
    if (next !== this.#scroll) { this.#scroll = next; this.invalidate(); }
  }
  /** Keep scrolling after a finger lifted at `velocity` (px/ms, positive scrolls down), slowing as a rolling thing does; not with reduced motion, and a touch stops it. */
  #startFling(velocity: number): void {
    this.#stopFling();
    const layout = this.#layout, reduced = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (!layout || reduced || !(Math.abs(velocity) > 0.08) || maxScroll(layout, this.#h) <= 0) return;
    let v = velocity, at = this.#scroll, then = performance.now();
    const step = (now: number): void => {
      const dt = Math.min(48, now - then); then = now;
      at += v * dt; v *= Math.pow(0.95, dt / 16.7);
      const limit = this.#layout ? maxScroll(this.#layout, this.#h) : 0;
      this.#scrollTo(at);
      this.#fling = Math.abs(v) < 0.02 || at <= 0 || at >= limit || document.hidden ? 0 : requestAnimationFrame(step);
    };
    this.#fling = requestAnimationFrame(step);
  }
  #stopFling(): void { if (this.#fling) { cancelAnimationFrame(this.#fling); this.#fling = 0; } }

  /** The pin at the moment under a finger (null outside the lines): a tap near the pin lets it go, where `toggle` is set; a hold moves it. */
  #pinAt(p: Pt, toggle: boolean): void {
    const time = p.x >= this.#plot.x && p.x <= this.#plot.x + this.#plot.w ? this.#timeAt(p.x) : null, held = this.#pinX();
    if (time === null || (toggle && held !== null && Math.abs(held - p.x) < 24)) { this.#unpin(); return; }
    this.#pin = { t: time, y: p.y }; this.invalidate();
  }
  #unpin(): void { if (this.#pin) { this.#pin = null; this.invalidate(); } }
  /** Where the pinned moment is on the lines now (it moves left as time passes), or null with no pin or one the window has left behind. */
  #pinX(): number | null {
    const m = this.#model, pin = this.#pin;
    if (!pin || !m || !(m.t1 > m.t0)) return null;
    const x = this.#plot.x + (pin.t - m.t0) / (m.t1 - m.t0) * this.#plot.w;
    return x >= this.#plot.x && x <= this.#plot.x + this.#plot.w ? x : null;
  }
  /** Whatever points at the lines now: a finger scrubbing, a pin, or the mouse. */
  #pointer(): { x: number; y: number; touch: boolean } | null {
    if (this.#scrub) return { ...this.#scrub, touch: true };
    const x = this.#pinX();
    if (x !== null && this.#pin) return { x, y: this.#pin.y, touch: true };
    return this.#hover ? { ...this.#hover, touch: false } : null;
  }

  #resize(): void {
    const r = this.#wrap.getBoundingClientRect();
    this.#w = Math.max(1, Math.floor(r.width)); this.#h = Math.max(1, Math.floor(r.height)); this.#dpr = window.devicePixelRatio || 1;
    this.#canvas.width = Math.round(this.#w * this.#dpr); this.#canvas.height = Math.round(this.#h * this.#dpr);
    this.#canvas.style.width = `${this.#w}px`; this.#canvas.style.height = `${this.#h}px`;
    this.#flashCanvas.width = this.#canvas.width; this.#flashCanvas.height = this.#canvas.height;
    this.#flashCanvas.style.width = this.#canvas.style.width; this.#flashCanvas.style.height = this.#canvas.style.height;
    this.#flashes = [];
    this.#modelKey = '';
    this.invalidate();
  }

  // ---- data -----------------------------------------------------------------------------------------------------------------------

  /** Minute candles of the market on screen for the price strip, fetched now and then (the live marks carry it between). */
  #loadPrice(now: number, from: number): void {
    const id = this.store.state.seriesInstrument || this.store.state.marketId;
    // Not before the map has a window (at startup the window begins at zero).
    if (!id || this.#priceLoading || !(from > 0)) return;
    // Replay: candles up to the last minute over by its moment, asked again as it moves on; live, again after a minute.
    const replay = replaying(), want = `${id}|${Math.floor(from / 3_600_000)}${replay ? `|${Math.floor(now / 60_000)}` : ''}`;
    if (want === this.#priceFor && (replay || Date.now() - this.#priceAt < 60_000)) return;
    this.#priceLoading = true;
    this.hub.source.candles(id, '1m', from - 120_000, replay ? Math.floor(now / 60_000) * 60_000 - 1 : now + 60_000).then(rows => {
      if (this.store.state.seriesInstrument !== id && this.store.state.marketId !== id) return;
      this.#price.load(rows as unknown as number[][], Date.now()); this.#priceFor = want; this.#priceAt = Date.now(); this.#modelKey = ''; this.invalidate();
    }, () => { this.#priceAt = Date.now(); this.#priceFor = want; }).finally(() => { this.#priceLoading = false; });
  }

  // ---- drawing --------------------------------------------------------------------------------------------------------------------

  #render(): void {
    if (this.root.hidden || this.#w < 60 || this.#h < 60) return;
    const s = this.store.state, cfg = s.cvd, now = pageNow(), p = this.#palette, ctx = this.#ctx;
    this.#ranker.refreshMs = cfg.refreshMin * 60_000; this.#ranker.auto = cfg.auto;
    const span = this.#span(), phone = isPhone();
    const spanMs = span === 'map' ? Math.max(60_000, this.view.t1 - this.view.t0) : CVD_SPAN_MS[span];
    const ids = flowIds(s, this.hub.flow.ids);
    // The price comes from the recorded seconds of the market on screen when it has them (the same trades as the flow, a second at a time).
    const priceId = priceFlowId([s.seriesInstrument, s.marketId], id => this.hub.flow.has(id));
    const reach = Math.max(spanMs, RANK_MS[cfg.rank], 3_600_000);
    const loadIds = flowLoadIds(s, this.hub.flow.ids);
    const flowIdsToLoad = priceId && !loadIds.includes(priceId) ? [...loadIds, priceId] : loadIds;
    // Loading keeps the real clock (the seconds held end at the real now); the window shown ends at the page's now (a replay's moment).
    const secondsFrom = Math.max(Date.now() - HISTORY_CAP_MS, Math.min(now, span === 'map' ? this.view.t1 : now) - reach - 60_000);
    void this.hub.ensureFlow(flowIdsToLoad, secondsFrom);
    // A window reaching back before the seconds the page holds draws its older part from the minutes: asked from a six-hour boundary (so
    // zooming out does not ask again at every step) up to the hour after the latest of the seconds begins. That is where the seconds
    // were loaded from, not the clock: it stays put until the ring has held a day and a half, and then moves on by the hour.
    const wanted = span === 'map' ? this.view.t0 : now - CVD_SPAN_MS[span], older = wanted < secondsFrom - 60_000;
    let latest = -Infinity;
    if (older) for (const id of flowIdsToLoad) { const first = this.hub.flow.get(id)?.span?.first; if (first !== undefined && first * 1000 > latest) latest = first * 1000; }
    // Nothing traded in the last day (the seconds were asked for and none came): the minutes are asked for up to the hour that is coming.
    if (older && latest === -Infinity && !this.hub.flow.missing(flowIdsToLoad, secondsFrom).length) latest = now;
    if (older && latest > -Infinity) void this.hub.ensureFlowMinutes(flowIdsToLoad, Math.floor((wanted - 3_600_000) / MINUTES_FROM_MS) * MINUTES_FROM_MS, Math.ceil((latest + 120_000) / 3_600_000) * 3_600_000);
    let earliest = Infinity;
    for (const id of ids) { const first = this.hub.flow.track(id)?.first; if (first !== null && first !== undefined && first * 1000 < earliest) earliest = first * 1000; }
    // A phone's default span (the saved `map`: no chip was ever chosen) is up to an hour and no more than the flow holds, as the map's span is on a
    // desktop: a page that has just opened draws its first minutes across the whole chart, not a few seconds at the edge of an empty hour.
    const fit = phone && cfg.span === 'map';
    const win = fit ? flowWindow({ span: 'map', mapT0: now - CVD_SPAN_MS['1h'], mapT1: now, now, earliest }) : flowWindow({ span, mapT0: this.view.t0, mapT1: this.view.t1, now, earliest }), { t0, t1 } = win;
    this.#windowName = fit ? windowName(Math.round((t1 - t0) / 1000)) : span;
    this.#since = win.since; this.#sinceHeld = older && this.hub.flowMinutesState === 'unavailable';
    this.#loadPrice(now, t0);
    if (s.mark.price > 0 && !replaying()) this.#price.add(Date.now(), s.mark.price);

    this.#gutter = Math.max(GUTTER_MIN, Math.min(GUTTER_MAX, Math.round(this.#w * 0.34)));
    // On a phone the price has an axis at the right of the plot, and every row keeps the room so a moment sits above the same pixel in all of them.
    const plotW = Math.max(20, this.#w - this.#gutter - (phone ? PRICE_AXIS_W : PAD)), columns = Math.max(24, Math.min(900, Math.floor(plotW)));
    // The lines' ends flash only in a window that ends now (within a column): not in a replay, nor on a map moved back into the past.
    this.#atLive = !replaying() && t1 >= Date.now() - Math.max(2_000, (t1 - t0) / columns);
    const key = [this.hub.flow.version, columns, Math.floor(t0 / Math.max(1000, spanMs / columns)), Math.floor(now / 1000), span, cfg.rank, cfg.top, cfg.heights, cfg.auto, cfg.refreshMin, cfg.pinned.join(','), cfg.quietFlag, cfg.rebase, s.scope, s.disabledVenues.join(','), ids.length, this.#price.length, priceId ?? ''].join('|');
    if (key !== this.#modelKey || !this.#model) {
      this.#model = buildModel({ flow: this.hub.flow, ids, kindOf: id => kindOf(s.markets, id), t0, t1, columns, now, settings: cfg, ranker: this.#ranker });
      this.#priceId = priceId; this.#priceCols = this.#priceColumns(this.#model);
      this.#strip.setCounted(this.#model.counted); this.#strip.wake();
      this.#modelKey = key;
    }
    const model = this.#model;
    this.#drawn = { t0: this.view.t0, t1: this.view.t1 };
    this.#empty = emptyScopeMessage(s) ?? (!model.rows.length ? (ids.length ? t('Waiting for trades…') : t('No venues are enabled.')) : null);
    this.#updateNotice(model, s);
    // A phone has no strip for the price: the aggregate row is the chart, as tall as the pane makes it, with the price over the lines.
    const shares = model.rows.map(r => r.share);
    const layout = phone ? rowHeights(cfg.heights, this.#h, shares, { minRow: PHONE_MIN_ROW, price: 0, agg: heroHeight(this.#h, layoutMode() === 'phone-landscape') })
      : rowHeights(cfg.heights, this.#h, shares, { minRow: MIN_ROW, minAgg: MIN_AGG, price: PRICE_H });
    this.#layout = layout;
    this.#scroll = Math.max(0, Math.min(maxScroll(layout, this.#h), this.#scroll));
    // A pin whose moment has left the window (it moves left as time passes) is let go.
    if (this.#pin && this.#pinX() === null) this.#pin = null;

    ctx.setTransform(this.#dpr, 0, 0, this.#dpr, 0, 0);
    ctx.clearRect(0, 0, this.#w, this.#h);
    const colors = laneColors(p), plot = { x: this.#gutter, w: plotW };
    this.#plot = plot;
    const window = windowName(model.rankSec);
    // The venue rows scroll under the aggregate and the price strip, so they are drawn first and the strip over them.
    const top = layout.agg + layout.price;
    ctx.save(); ctx.beginPath(); ctx.rect(0, top, this.#w, this.#h - top); ctx.clip();
    let y = top - this.#scroll;
    model.rows.forEach((row, i) => {
      const h = layout.rows[i]!;
      if (y + h > top && y < this.#h) this.#paintRow(ctx, p, colors, plot, y, h, row.lanes, rowLabel(row, window, h, cfg.quietFlag), cfg.bursts, cfg.rebase);
      y += h;
    });
    ctx.restore();
    ctx.fillStyle = p.panel; ctx.fillRect(0, 0, this.#w, top);
    if (phone) this.#paintHero(ctx, p, colors, plot, layout.agg, model, cfg);
    else {
      this.#paintRow(ctx, p, colors, plot, 0, layout.agg, [model.spot, model.perp].filter((l): l is LaneLine => l !== null), aggregateLabel(model, layout.agg, this.#filterNote(s)), false, cfg.rebase);
      this.#paintPrice(ctx, p, plot, layout.agg, layout.price, model);
    }
    // On a phone the chart marks where the flow begins and the readout says since when; the note over the lines is for the desktop column.
    if (this.#since !== null && !phone) this.#paintSince(ctx, p, plot, this.#since);
    ctx.strokeStyle = p.muted; ctx.globalAlpha = 0.55; ctx.beginPath(); ctx.moveTo(0, top + 0.5); ctx.lineTo(this.#w, top + 0.5); ctx.stroke(); ctx.globalAlpha = 1;
    if (maxScroll(layout, this.#h) > 0) this.#paintScrollbar(ctx, p, layout);
    if (this.#empty) { ctx.fillStyle = p.muted; ctx.font = `12px ${SANS}`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillText(this.#empty, this.#w / 2, Math.min(this.#h - 20, top + 36)); }
    this.#paintRange(ctx, p, plot, model);
    this.#sharedX = this.#sharedLineX();
    if (this.#sharedX !== null) { ctx.save(); ctx.strokeStyle = p.muted; ctx.globalAlpha = 0.7; ctx.beginPath(); ctx.moveTo(this.#sharedX + 0.5, 0); ctx.lineTo(this.#sharedX + 0.5, this.#h); ctx.stroke(); ctx.restore(); }
    this.#paintHover(ctx, p, model, layout, plot, window);
    if (phone) this.#updateReadout(model);
  }

  /** The Range tool's selection, as a lightly shaded band across the rows between dashed edges, where the column shows its time. */
  #paintRange(ctx: CanvasRenderingContext2D, p: Palette, plot: { x: number; w: number }, model: CvdModel): void {
    const sel = this.store.state.range; if (!sel || !(model.t1 > model.t0)) return;
    const xOf = (time: number): number => plot.x + (time - model.t0) / (model.t1 - model.t0) * plot.w;
    const x0 = Math.max(plot.x, xOf(sel.t0)), x1 = Math.min(plot.x + plot.w, xOf(sel.t1));
    if (x1 <= x0) return;
    ctx.save(); ctx.fillStyle = p.text; ctx.globalAlpha = 0.07; ctx.fillRect(x0, 0, x1 - x0, this.#h); ctx.globalAlpha = 1;
    ctx.strokeStyle = p.text; ctx.setLineDash([5, 4]); ctx.beginPath();
    for (const x of [x0, x1]) if (x > plot.x && x < plot.x + plot.w) { ctx.moveTo(Math.round(x) + 0.5, 0); ctx.lineTo(Math.round(x) + 0.5, this.#h); }
    ctx.stroke(); ctx.restore();
  }
  /** The time at `x` on the column's lines (held inside them), or null before there is a model. */
  #timeAt(x: number): number | null {
    const m = this.#model; if (!m || !(m.t1 > m.t0) || !(this.#plot.w > 0)) return null;
    return m.t0 + Math.max(0, Math.min(1, (x - this.#plot.x) / this.#plot.w)) * (m.t1 - m.t0);
  }

  /** A row: its lanes as lines (each on its own scale), the quiet lanes faded, their bursts when `bursts`, and its label in the gutter on the left. */
  #paintRow(ctx: CanvasRenderingContext2D, p: Palette, colors: LaneColors, plot: { x: number; w: number }, y: number, h: number, lanes: readonly LaneLine[], label: readonly LabelLine[], bursts: boolean, rebase: boolean): void {
    const pad = 6, inner = { y: y + pad + 2, h: Math.max(8, h - 2 * pad - 4) }, columns = this.#model!.columns;
    ctx.save(); ctx.strokeStyle = p.line; ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(0, Math.round(y + h) - 0.5); ctx.lineTo(this.#w, Math.round(y + h) - 0.5); ctx.stroke(); ctx.restore();
    for (const lane of lanes) {
      const color = lane.quiet ? (lane.kind === 'spot' ? colors.spotQuiet : colors.perpQuiet) : (lane.kind === 'spot' ? colors.spot : colors.perp);
      this.#paintLane(ctx, lane, color, plot, inner, columns, rebase, p);
      if (bursts) this.#paintEvents(ctx, lane, color, plot, inner, columns, rebase);
    }
    this.#paintLabel(ctx, p, colors, y, h, label);
  }

  /** A row's label in the gutter at the left, centred on the row: its lines (a venue's mark or a lane's dot ahead of the text, or the price's short line), clipped to the gutter. */
  #paintLabel(ctx: CanvasRenderingContext2D, p: Palette, colors: LaneColors, y: number, h: number, label: readonly LabelLine[]): void {
    ctx.save(); ctx.beginPath(); ctx.rect(0, y, this.#gutter - 4, h); ctx.clip();
    ctx.textBaseline = 'middle'; ctx.textAlign = 'left';
    const total = label.length * LINE_H, first = y + (h - total) / 2 + LINE_H / 2, room = this.#gutter - 10;
    label.forEach((line, i) => {
      const ly = first + i * LINE_H;
      let x = PAD;
      if (line.mark) { drawVenueMark(ctx, line.mark, x + 6, ly, 12); x += 16; }
      if (line.dot) { ctx.fillStyle = line.dot === 'spot' ? colors.spot : colors.perp; ctx.beginPath(); ctx.arc(x + 3, ly, 3, 0, Math.PI * 2); ctx.fill(); x += 11; }
      // The price's legend is the short line it is drawn with over the chart.
      if (line.swatch) { ctx.strokeStyle = p.text; ctx.lineWidth = 1.6; ctx.beginPath(); ctx.moveTo(x - 1, ly); ctx.lineTo(x + 8, ly); ctx.stroke(); x += 11; }
      ctx.font = line.bold ? `600 11px ${SANS}` : `11px ${line.dot || line.swatch ? MONO : SANS}`;
      ctx.fillStyle = line.tone === 'muted' ? p.muted : p.text;
      ctx.fillText(fit(ctx, line.text, room - (x - PAD)), x, ly);
    });
    ctx.restore();
  }

  #scaleOf(lane: LaneLine, rebase: boolean): Range | null { return laneRange(lane, rebase); }

  /** `scale`: the range the line is drawn over, where it is not its own (the phone's chart puts spot and perpetual on one axis). */
  #paintLane(ctx: CanvasRenderingContext2D, lane: LaneLine, color: string, plot: { x: number; w: number }, inner: { y: number; h: number }, columns: number, rebase: boolean, p: Palette, scale: Range | null = this.#scaleOf(lane, rebase)): void {
    if (!scale) return;
    const X = (c: number): number => plot.x + (c + 0.5) / columns * plot.w, Y = (v: number): number => inner.y + inner.h - (v - scale.lo) / (scale.hi - scale.lo) * inner.h;
    ctx.save();
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
    if (lastC >= 0) this.#flashEnd(lane, X(lastC), Y(lane.last[lastC]!), this.#atLive && lastC === columns - 1 && this.#scroll === 0, p);
  }

  /**
   * The line's end flashes when its running delta moved since the last drawing: green when buying moved it, red when selling did, as wide
   * as the change was large. Read from the series itself, not the drawn line, and only from the seconds at its live edge (`flowEndChange`),
   * so a window that slides or rebases, or older history loaded under the line, flashes nothing. Only at the live edge; a change large
   * enough is sent on as a wave (`onLargeFlow`).
   */
  #flashEnd(lane: LaneLine, x: number, y: number, live: boolean, p: Palette): void {
    const key = `${lane.id}|${lane.kind}`, series = lane.series;
    if (!series || series.empty) { this.#ends.delete(key); return; }
    const { end, change } = flowEndChange(series, this.#ends.get(key), performance.now());
    if (end) this.#ends.set(key, end); else this.#ends.delete(key);
    if (!live) return;
    const min = scaledUsd(5_000);
    if (!(Math.abs(change) >= min)) return;
    const k = Math.min(1, Math.log10(Math.abs(change) / min) / 2), color = change > 0 ? p.bid : p.ask;
    this.#flashes.push({ x, y, k, color, at: performance.now() });
    if (this.#flashes.length > 48) this.#flashes.splice(0, this.#flashes.length - 48);
    if (Math.abs(change) >= scaledUsd(100_000)) { const r = this.#canvas.getBoundingClientRect(); this.onLargeFlow(r.left + x, r.top + y, change); }
    this.#animateFlashes();
  }

  /**
   * Draw the flashes: on every display frame while one runs, or with reduced motion, where a flash is its halo alone, at full and then gone
   * at half its life, once for each change of what shows (a timer clears each halo on time).
   */
  #animateFlashes(): void {
    const reduced = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (reduced) {
      if (this.#flashFrame) { cancelAnimationFrame(this.#flashFrame); this.#flashFrame = 0; }
      window.clearTimeout(this.#flashTimer); this.#flashTimer = 0;
      const now = performance.now(), half = FLASH_LIFE_MS / 2;
      this.#flashes = this.#flashes.filter(f => now - f.at < half);
      this.#paintFlashes(now, true);
      if (!this.#flashes.length) return;
      const next = Math.min(...this.#flashes.map(f => f.at + half)) - now;
      this.#flashTimer = window.setTimeout(() => { this.#flashTimer = 0; this.#animateFlashes(); }, Math.max(0, next) + 1);
      return;
    }
    if (this.#flashFrame) return;
    const draw = (): void => {
      this.#flashFrame = 0;
      const now = performance.now();
      this.#flashes = this.#flashes.filter(f => now - f.at < FLASH_LIFE_MS);
      this.#paintFlashes(now, false);
      if (this.#flashes.length && !document.hidden) this.#flashFrame = requestAnimationFrame(draw);
    };
    this.#flashFrame = requestAnimationFrame(draw);
  }
  #paintFlashes(now: number, reduced: boolean): void {
    const ctx = this.#flashCtx;
    ctx.setTransform(this.#dpr, 0, 0, this.#dpr, 0, 0); ctx.clearRect(0, 0, this.#w, this.#h);
    for (const f of this.#flashes) {
      const age = now - f.at, t = age / FLASH_LIFE_MS, fade = reduced ? (t < 0.5 ? 1 : 0) : (1 - t) ** 2;
      // A halo on the dot, and a ring running out from it as far as the change was large.
      ctx.globalAlpha = 0.55 * fade; ctx.fillStyle = f.color;
      ctx.beginPath(); ctx.arc(f.x, f.y, 2.6 + 2.2 * f.k, 0, Math.PI * 2); ctx.fill();
      if (!reduced) {
        ctx.globalAlpha = 0.7 * fade; ctx.strokeStyle = f.color; ctx.lineWidth = 1.2;
        ctx.beginPath(); ctx.arc(f.x, f.y, 3 + (5 + 9 * f.k) * Math.sqrt(t), 0, Math.PI * 2); ctx.stroke();
      }
    }
    ctx.globalAlpha = 1;
  }

  /** A small triangle on the line where a burst of buying or selling was seen while the page was open (up for buying, down for selling). */
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
    const st = this.store.state, track = replaying() ? this.hub.flow.track(st.seriesInstrument || st.marketId) : undefined;
    const sec = Math.floor(pageNow() / 1000) - 1, last = replaying() ? (track ? track.priceAt(track.settled(sec)) : NaN) : st.mark.price, ly = y + h / 2;
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

  /**
   * The phone's chart (Karl, 2026-10-26: "overlaying the price with the top aggregated CVDs, one y-axis for the CVD and one for the price"): the
   * aggregate row, as tall as the pane makes it, with the price drawn over the flow. While `scale` is shared the spot and perpetual lines stand
   * on one axis of dollars at the left (its numbers inside the plot, over a halo), so their sizes read against each other; `own` gives each its
   * range, as every row has, so their shapes do. The price has its own axis in the margin at the right, with a tag at the newest price, and a
   * time axis runs along the foot. The gutter's label is the legend: each line's colour beside its figure, the price's short line beside the price.
   */
  #paintHero(ctx: CanvasRenderingContext2D, p: Palette, colors: LaneColors, plot: { x: number; w: number }, h: number, model: CvdModel, cfg: CvdSettings): void {
    const columns = model.columns, rebase = cfg.rebase, TOP = 12, FOOT = 22, inner = { y: TOP, h: Math.max(24, h - TOP - FOOT) };
    const lanes = [model.spot, model.perp].filter((l): l is LaneLine => l !== null);
    const shared = cfg.scale === 'shared' && lanes.length ? sharedRange(lanes, rebase) : null;
    const cols = this.#priceCols, prices = cols ? priceRange(cols.min, cols.max) : null;
    // Where each line stands, kept for the dots a finger's cursor puts on them.
    this.#heroGeo = { inner, spot: model.spot ? shared ?? laneRange(model.spot, rebase) : null, perp: model.perp ? shared ?? laneRange(model.perp, rebase) : null, price: prices };
    const X = (c: number): number => plot.x + (c + 0.5) / columns * plot.w, right = plot.x + plot.w;
    const yOf = (r: Range, v: number): number => inner.y + inner.h - (v - r.lo) / (r.hi - r.lo) * inner.h;
    const halo = (text: string, x: number, y: number, align: CanvasTextAlign): void => { ctx.textAlign = align; ctx.lineWidth = 4; ctx.strokeStyle = p.panel; ctx.strokeText(text, x, y); ctx.fillText(text, x, y); };
    ctx.save(); ctx.beginPath(); ctx.rect(0, 0, this.#w, h); ctx.clip();
    ctx.textBaseline = 'middle'; ctx.lineJoin = 'round';

    // The time axis: a faint line at each tick through the plot, and its label along the foot.
    ctx.font = `10px ${SANS}`;
    const axis = timeAxis(model.t0, model.t1, plot.w, text => ctx.measureText(text).width, { minPx: 42, dateOnFirst: false });
    ctx.strokeStyle = p.line; ctx.globalAlpha = 0.55; ctx.lineWidth = 1; ctx.beginPath();
    for (const tick of axis.ticks) { const x = Math.round(plot.x + (tick - model.t0) / (model.t1 - model.t0) * plot.w) + 0.5; if (x > plot.x && x < right) { ctx.moveTo(x, inner.y); ctx.lineTo(x, inner.y + inner.h); } }
    ctx.stroke(); ctx.globalAlpha = 1;
    ctx.fillStyle = p.muted;
    for (const label of axis.labels) { ctx.textAlign = 'center'; ctx.fillText(label.text, plot.x + label.x, h - FOOT / 2 + 1); }
    // Where the flow begins, when it began after the window did: what is left of the line is nobody's data, not a quiet market.
    if (this.#since !== null) {
      const x = Math.round(plot.x + (this.#since - model.t0) / (model.t1 - model.t0) * plot.w) + 0.5;
      if (x > plot.x && x < right) { ctx.strokeStyle = p.muted; ctx.globalAlpha = 0.8; ctx.setLineDash([2, 3]); ctx.beginPath(); ctx.moveTo(x, inner.y); ctx.lineTo(x, inner.y + inner.h); ctx.stroke(); ctx.setLineDash([]); ctx.globalAlpha = 1; }
    }

    // The dollars: gridlines and their numbers (shared axis only: with a range each there is no one set of dollars to name), zero stronger.
    ctx.font = `10px ${MONO}`;
    const dollars = shared ? niceTicks(shared.lo, shared.hi, 4) : null;
    if (shared && dollars) {
      ctx.lineWidth = 1;
      for (const v of dollars.values) {
        const y = Math.round(yOf(shared, v)) + 0.5;
        ctx.strokeStyle = v === 0 ? p.muted : p.line; ctx.globalAlpha = v === 0 ? 0.7 : 0.6; ctx.setLineDash(v === 0 ? [5, 4] : [1, 3]);
        ctx.beginPath(); ctx.moveTo(plot.x, y); ctx.lineTo(right, y); ctx.stroke();
      }
      ctx.setLineDash([]); ctx.globalAlpha = 1;
    }

    // The flow: spot under perpetual, as in the rows.
    // `undefined`, not null, where each has its own range: a null range is a line with nothing to draw it over.
    for (const lane of lanes) this.#paintLane(ctx, lane, lane.kind === 'spot' ? colors.spot : colors.perp, plot, inner, columns, rebase, p, shared ?? undefined);

    // The price over the flow, and its axis: a number and a small tick at each round price, and a tag at the newest.
    if (cols && prices) {
      ctx.strokeStyle = p.text; ctx.globalAlpha = 0.9; ctx.lineWidth = 1.5; ctx.beginPath();
      let pen = false, lastC = -1;
      for (let c = 0; c < columns; c++) {
        const v = cols.last[c]!; if (Number.isNaN(v)) { pen = false; continue; }
        if (pen) ctx.lineTo(X(c), yOf(prices, v)); else { ctx.moveTo(X(c), yOf(prices, v)); pen = true; }
        lastC = c;
      }
      ctx.stroke(); ctx.globalAlpha = 1;
      const ticks = niceTicks(prices.lo, prices.hi, 4);
      ctx.fillStyle = p.muted; ctx.font = `10px ${MONO}`; ctx.textAlign = 'left'; ctx.lineWidth = 1; ctx.strokeStyle = p.muted;
      const newest = lastC >= 0 ? yOf(prices, cols.last[lastC]!) : -1;
      for (const v of ticks.values) {
        const y = yOf(prices, v);
        ctx.beginPath(); ctx.moveTo(right, Math.round(y) + 0.5); ctx.lineTo(right + 4, Math.round(y) + 0.5); ctx.stroke();
        if (newest < 0 || Math.abs(y - newest) > 10) ctx.fillText(fmtPrice(v, ticks.step), right + 7, y);
      }
      if (lastC >= 0) {
        const value = cols.last[lastC]!, text = fmtPrice(value), tagW = PRICE_AXIS_W - 2, tagH = 16, y = Math.max(inner.y, Math.min(inner.y + inner.h, newest));
        ctx.fillStyle = p.text; ctx.fillRect(right + 1, y - tagH / 2, tagW, tagH);
        ctx.fillStyle = p.panel; ctx.font = `600 10px ${MONO}`; ctx.textAlign = 'center'; ctx.fillText(fit(ctx, text, tagW - 4), right + 1 + tagW / 2, y + 0.5);
        // The dot at the line's end, as the flow lines have.
        ctx.fillStyle = p.text; ctx.beginPath(); ctx.arc(X(lastC), newest, 2.4, 0, Math.PI * 2); ctx.fill();
      }
      // The legend wants the newest price: the label is made here, where it is known.
      this.#priceNow = lastC >= 0 ? cols.last[lastC]! : NaN;
    } else this.#priceNow = NaN;
    // The dollars' numbers last, over the lines on a halo, so no line strikes one through.
    if (shared && dollars) {
      ctx.font = `10px ${MONO}`; ctx.fillStyle = p.muted;
      for (const v of dollars.values) { const y = yOf(shared, v); if (y > inner.y + 4 && y < inner.y + inner.h - 4) halo(v === 0 ? '0' : signedUsd(v), plot.x + 4, y - 7, 'left'); }
    }
    ctx.restore();

    this.#paintLabel(ctx, p, colors, 0, h, heroLabel(model, this.#windowName, rebase, this.#priceNow, this.#filterNote(this.store.state)));
  }

  /** What the lines say where a finger points (or at the newest moment when none does), in the line under the header: the time, the price, and each kind's running delta, in the colours of the lines. */
  #updateReadout(model: CvdModel): void {
    // Only a pointer over the lines points at a moment (one in the gutter would read the window's edge).
    const cur = this.#pointer(), time = cur && cur.x >= this.#plot.x && cur.x <= this.#plot.x + this.#plot.w ? this.#timeAt(cur.x) : null, col = time === null ? -1 : columnAt(model.t0, model.t1, model.columns, time);
    const at = col >= 0 ? col : model.columns - 1, point = heroPoint(model, this.#priceCols, at);
    // Seconds only where a column is a few of them wide (a window of a quarter of an hour or less): on four hours or a day the minute says all there is.
    const at0 = model.t0 + (col + 0.5) / model.columns * (model.t1 - model.t0), when = col < 0 ? '' : model.t1 - model.t0 <= 900_000 ? clockSeconds(at0) : clock(at0);
    const part = (kind: 'sp' | 'pp', letter: string, v: number | null): string => v === null ? '' : ` <span class="${kind}">${letter} <b>${signedUsd(v)}</b></span>`;
    const since = col < 0 && this.#since !== null ? ` <span class="since">${t('since {time}', { time: clock(this.#since, this.#since < startOfDay(pageNow())) })}</span>` : '';
    setHtml(this.#readout, `${when ? `<span class="when">${when}</span> ` : ''}${point.price !== null ? `<b>${fmtPrice(point.price)}</b>` : ''}${part('sp', t('S'), point.spot)}${part('pp', t('P'), point.perp)}${since}`);
  }

  /** The notice above the rows: written again only when what it says changes (a node is not touched otherwise). */
  #updateNotice(model: CvdModel, s: AppState): void {
    const flow = this.hub.flow, withFlow = flow.ids.filter(id => flow.get(id)?.empty === false), winStart = model.nowSec - model.rankSec + 1;
    const missing = explainMissing(s, withFlow, new Set(model.rows.map(r => r.key)), id => flow.get(id)?.gross(winStart, model.nowSec) ?? 0);
    const rows = noticeRows(missing, venueLabel, s.scope === 'spot' ? 'spot' : 'perp');
    const key = rows.map(r => `${r.text}\u0001${r.action?.label ?? ''}`).join('\u0002');
    if (key === this.#noticeKey) return;
    this.#noticeKey = key; this.#noticeRows = rows.map(r => r.text);
    this.#notice.hidden = rows.length === 0;
    this.#notice.replaceChildren(...rows.map(row => {
      const children: (Node | string)[] = [el('span', { class: 'cvd-notice-text', textContent: row.text, tip: row.full })];
      if (row.action) { const { label, run } = row.action; children.push(el('button', { type: 'button', class: 'chip cvd-notice-btn', textContent: label, onclick: () => this.#runNotice(run) })); }
      return el('div', { class: 'cvd-notice-row' }, ...children);
    }));
  }
  /** What a notice's button does: undo the thing that hides the exchanges, and make the list again now, not at the next re-rank. */
  #runNotice(action: NoticeAction): void {
    if (action.kind === 'both') this.store.set({ scope: 'all' });
    else this.store.set({ disabledVenues: this.store.state.disabledVenues.filter(v => !action.venues.includes(v)) });
    this.refresh();
  }

  /**
   * With the Spot or Perp filter on: which kind this is, and how many exchanges with flow it leaves out (null with the filter off). Fewer
   * exchanges trade spot than perpetuals here, so "only five rows" with Spot on is the filter at work, not a missing row.
   */
  #filterNote(s: AppState): { kind: Kind; hidden: number } | undefined {
    if (s.scope === 'all') return undefined;
    const withFlow = (id: string): boolean => this.hub.flow.get(id)?.empty === false, count = (state: AppState): number => buildFamilies(flowIds(state, this.hub.flow.ids).filter(withFlow), id => kindOf(s.markets, id)).length;
    return { kind: s.scope, hidden: Math.max(0, count({ ...s, scope: 'all' }) - count(s)) };
  }

  /** The price strip's columns: the market's recorded seconds where it has them, the candle closes and marks for what came before (or all of it, when it has none). */
  #priceColumns(model: CvdModel): PriceColumns {
    const columns = model.columns, track = this.#price.columns(model.t0, model.t1, columns), series = this.#priceId ? this.hub.flow.track(this.#priceId) : undefined;
    if (!series || series.first === null) return track;
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
    const series = this.#priceId ? this.hub.flow.track(this.#priceId) : undefined, v = series ? series.priceAt(Math.floor(time / 1000)) : NaN;
    return v === v ? v : this.#price.at(time);
  }

  /** "Flow recorded since 13:54", muted, at the left of the aggregate row: the window reaches back before the recording began. */
  #paintSince(ctx: CanvasRenderingContext2D, p: Palette, plot: { x: number; w: number }, since: number): void {
    const startOfToday = startOfDay(pageNow());
    ctx.save(); ctx.font = `10px ${SANS}`; ctx.fillStyle = p.muted; ctx.textAlign = 'left'; ctx.textBaseline = 'top';
    const time = clock(since, since < startOfToday);
    ctx.fillText(fit(ctx, this.#sinceHeld ? t('Flow since {time}: older flow is not available from this source', { time }) : t('Flow recorded since {time}', { time }), plot.w - 12), plot.x + 6, 5);
    ctx.restore();
  }

  #paintScrollbar(ctx: CanvasRenderingContext2D, p: Palette, layout: RowLayout): void {
    const top = layout.agg + layout.price, room = this.#h - top, limit = maxScroll(layout, this.#h);
    const thumb = Math.max(24, room * room / (room + limit)), at = top + (room - thumb) * (this.#scroll / limit);
    ctx.save(); ctx.globalAlpha = 0.45; ctx.fillStyle = p.muted; ctx.fillRect(this.#w - 4, at, 3, thumb); ctx.restore();
  }

  #paintHover(ctx: CanvasRenderingContext2D, p: Palette, model: CvdModel, layout: RowLayout, plot: { x: number; w: number }, window: string): void {
    const hover = this.#pointer(); if (!hover) return;
    const hit = locateRow(layout, this.#scroll, this.#h, hover.y), phone = isPhone();
    if (!hit) return;
    const col = Math.max(0, Math.min(model.columns - 1, Math.floor((hover.x - plot.x) / plot.w * model.columns))), inPlot = hover.x >= plot.x && hover.x <= plot.x + plot.w;
    const time = model.t0 + (col + 0.5) / model.columns * (model.t1 - model.t0);
    // Shade the row under the pointer (not the phone's chart, which the readout speaks for), and draw the time cursor down the plot.
    let rowTop = 0, rowH = layout.agg;
    if (hit.kind === 'price') { rowTop = layout.agg; rowH = layout.price; }
    else if (hit.kind === 'row') { rowTop = layout.agg + layout.price - this.#scroll + layout.rows.slice(0, hit.index).reduce((a, b) => a + b, 0); rowH = layout.rows[hit.index]!; }
    ctx.save();
    if (!(phone && hit.kind === 'agg')) { ctx.globalAlpha = 0.05; ctx.fillStyle = p.text; ctx.fillRect(0, Math.max(rowTop, hit.kind === 'row' ? layout.agg + layout.price : 0), this.#w, rowH); ctx.globalAlpha = 1; }
    if (inPlot) { ctx.strokeStyle = p.muted; ctx.globalAlpha = 0.7; const x = Math.round(plot.x + (col + 0.5) / model.columns * plot.w) + 0.5; ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, this.#h); ctx.stroke(); ctx.globalAlpha = 1; }
    if (phone && inPlot) this.#paintDots(ctx, p, model, col, plot);
    ctx.restore();
    // The phone's chart is read in the line under the header, so no box covers it; a venue's row has its box, above the finger so the finger does not hide it.
    if (phone && hit.kind === 'agg') return;
    let lines: InfoLine[];
    if (hit.kind === 'agg') lines = aggregateHover(model, col, time, window);
    else if (hit.kind === 'price') { const v = this.#priceAtTime(time); lines = [{ text: t('Price'), bold: true }, { text: clock(time, true), color: 'muted' }, { label: t('Price here'), text: Number.isFinite(v) ? fmtPrice(v) : '–', rule: true }]; }
    else lines = rowHover(model.rows[hit.index]!, col, time, window);
    paintInfoBox(ctx, lines, hover.x, hover.y, { x0: 0, y0: 0, x1: this.#w, y1: this.#h }, p, { placement: hover.touch ? 'up' : 'down' });
  }

  /** A dot on each of the chart's lines where the cursor is (the flow of each kind and the price), ringed in the panel's colour so it stands off the line. */
  #paintDots(ctx: CanvasRenderingContext2D, p: Palette, model: CvdModel, column: number, plot: { x: number; w: number }): void {
    const geo = this.#heroGeo; if (!geo) return;
    const colors = laneColors(p), point = heroPoint(model, this.#priceCols, column), x = plot.x + (column + 0.5) / model.columns * plot.w;
    const y = (r: Range, v: number): number => geo.inner.y + geo.inner.h - (v - r.lo) / (r.hi - r.lo) * geo.inner.h;
    const dots: [Range | null, number | null, string][] = [[geo.spot, point.spot, colors.spot], [geo.perp, point.perp, colors.perp], [geo.price, point.price, p.text]];
    for (const [range, value, color] of dots) {
      if (!range || value === null) continue;
      ctx.beginPath(); ctx.arc(x, y(range, value), 4.2, 0, Math.PI * 2); ctx.fillStyle = p.panel; ctx.fill();
      ctx.beginPath(); ctx.arc(x, y(range, value), 3, 0, Math.PI * 2); ctx.fillStyle = color; ctx.fill();
    }
  }
}

